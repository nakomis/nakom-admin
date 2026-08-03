/**
 * WebGL 3D similarity graph (ADMIN-11).
 *
 * The reusable half of the viewer prototyped in scratch/viewer/viewer.html.
 * It takes nodes and edges and nothing else — no fetching, no auth, no idea
 * which corpus it is drawing. That is what lets the same component serve the
 * cv-chat tab on admin.nakomis.com and the claude-chats tab on
 * home.nakomis.com, whose data arrives by completely different routes.
 *
 * Positions are supplied by the caller when it has them (the claude corpus has
 * them baked in from the offline UMAP fit) and computed here otherwise (the
 * cv corpus is small enough to force-direct in the browser). See layout.ts.
 *
 * **Draw order is load-bearing.** Lines are drawn *after* points, not before.
 * Drawn first they are painted over by the sphere imposters and vanish
 * entirely — which cost an hour in the prototype, looked exactly like the
 * edges not being sent at all, and is the reason this comment exists.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { POINT_VERT, POINT_FRAG, LINE_VERT, LINE_FRAG, rebaseStrength } from './shaders';
import { layout, normalise, type Positioned } from './layout';
import {
    defaultCamera, orbit, zoom, viewProjection, project, type Camera,
} from './camera';

export interface Graph3DNode {
    id: string;
    embedded: boolean;
    label?: string;
    /** 0..1 hue selector. Undefined nodes share the default colour. */
    colourKey?: number;
}

export interface Graph3DEdge {
    source: string;
    target: string;
    similarity: number;
}

export interface SimilarityGraph3DProps {
    nodes: Graph3DNode[];
    edges: Graph3DEdge[];
    /** Pre-computed positions, keyed by node id. Omit to lay out here. */
    positions?: Map<string, { x: number; y: number; z: number }>;
    /** The similarity floor the edges were filtered at, for opacity rebasing. */
    edgeFloor?: number;
    height?: number | string;
    onSelect?: (id: string | null) => void;
    selectedId?: string | null;
}

/** Points-only fallback colour: the estate's mid blue. */
const DEFAULT_COLOUR: [number, number, number] = [0.42, 0.62, 0.92];
/** Records with no embedding get a muted grey — they can never have edges. */
const UNEMBEDDED_COLOUR: [number, number, number] = [0.45, 0.45, 0.50];
const SELECTED_COLOUR: [number, number, number] = [1.0, 0.72, 0.28];

/** Cheap HSV-ish ramp so cluster keys get distinguishable colours. */
function colourFor(node: Graph3DNode, selected: boolean): [number, number, number] {
    if (selected) return SELECTED_COLOUR;
    if (!node.embedded) return UNEMBEDDED_COLOUR;
    if (node.colourKey === undefined) return DEFAULT_COLOUR;
    const h = (node.colourKey % 1) * 6;
    const i = Math.floor(h);
    const f = h - i;
    const q = 1 - f;
    switch (i % 6) {
        case 0: return [1, f, 0];
        case 1: return [q, 1, 0];
        case 2: return [0, 1, f];
        case 3: return [0, q, 1];
        case 4: return [f, 0, 1];
        default: return [1, 0, q];
    }
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        // Thrown rather than logged: a shader that failed to compile renders a
        // blank canvas with no other symptom, and a silent blank screen is the
        // hardest thing here to diagnose from a bug report.
        throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s)}`);
    }
    return s;
}

function link(gl: WebGLRenderingContext, vert: string, frag: string): WebGLProgram {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
    }
    return p;
}

export default function SimilarityGraph3D({
    nodes, edges, positions, edgeFloor = 0.55, height = 600, onSelect, selectedId = null,
}: SimilarityGraph3DProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [camera, setCamera] = useState<Camera>(defaultCamera);
    const [hover, setHover] = useState<{ id: string; sx: number; sy: number } | null>(null);
    const [error, setError] = useState<string | null>(null);

    /**
     * Laid out once per data change, not per frame. The simulation is tens of
     * milliseconds at these sizes — fine on a data change, catastrophic at
     * 60 Hz.
     */
    const laidOut: Positioned[] = useMemo(() => {
        if (positions) {
            return nodes.map((n) => {
                const p = positions.get(n.id);
                return { id: n.id, x: p?.x ?? 0, y: p?.y ?? 0, z: p?.z ?? 0 };
            });
        }
        return normalise(layout(nodes, edges));
    }, [nodes, edges, positions]);

    const positionById = useMemo(
        () => new Map(laidOut.map((p) => [p.id, p])),
        [laidOut],
    );

    // --- GL state, rebuilt when the data changes -----------------------------
    const glRef = useRef<{
        gl: WebGLRenderingContext;
        pointProgram: WebGLProgram;
        lineProgram: WebGLProgram;
        posBuf: WebGLBuffer;
        colBuf: WebGLBuffer;
        visBuf: WebGLBuffer;
        linePosBuf: WebGLBuffer;
        lineStrBuf: WebGLBuffer;
        lineCount: number;
    } | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
        if (!gl) {
            setError('This browser has no WebGL context, so the 3D graph cannot render.');
            return;
        }
        try {
            const pointProgram = link(gl, POINT_VERT, POINT_FRAG);
            const lineProgram = link(gl, LINE_VERT, LINE_FRAG);
            glRef.current = {
                gl, pointProgram, lineProgram,
                posBuf: gl.createBuffer()!,
                colBuf: gl.createBuffer()!,
                visBuf: gl.createBuffer()!,
                linePosBuf: gl.createBuffer()!,
                lineStrBuf: gl.createBuffer()!,
                lineCount: 0,
            };
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        return () => {
            glRef.current = null;
        };
    }, []);

    // Upload geometry whenever the data or the selection changes.
    useEffect(() => {
        const s = glRef.current;
        if (!s) return;
        const { gl } = s;

        const pos = new Float32Array(laidOut.length * 3);
        const col = new Float32Array(laidOut.length * 3);
        const vis = new Float32Array(laidOut.length);
        laidOut.forEach((p, i) => {
            pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
            const c = colourFor(nodes[i], nodes[i].id === selectedId);
            col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
            vis[i] = 1;
        });
        gl.bindBuffer(gl.ARRAY_BUFFER, s.posBuf); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, s.colBuf); gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, s.visBuf); gl.bufferData(gl.ARRAY_BUFFER, vis, gl.STATIC_DRAW);

        // Two vertices per edge; an edge naming an absent node is skipped
        // rather than drawn from the origin.
        const drawable = edges.filter((e) => positionById.has(e.source) && positionById.has(e.target));
        const lp = new Float32Array(drawable.length * 6);
        const ls = new Float32Array(drawable.length * 2);
        drawable.forEach((e, i) => {
            const a = positionById.get(e.source)!;
            const b = positionById.get(e.target)!;
            lp.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
            const strength = rebaseStrength(e.similarity, edgeFloor);
            ls[i * 2] = strength; ls[i * 2 + 1] = strength;
        });
        gl.bindBuffer(gl.ARRAY_BUFFER, s.linePosBuf); gl.bufferData(gl.ARRAY_BUFFER, lp, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, s.lineStrBuf); gl.bufferData(gl.ARRAY_BUFFER, ls, gl.STATIC_DRAW);
        s.lineCount = drawable.length * 2;
    }, [laidOut, nodes, edges, positionById, edgeFloor, selectedId]);

    // Render loop.
    useEffect(() => {
        const canvas = canvasRef.current;
        const s = glRef.current;
        if (!canvas || !s) return;
        const { gl } = s;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = canvas.clientWidth * dpr;
        const h = canvas.clientHeight * dpr;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w; canvas.height = h;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0.055, 0.067, 0.094, 1);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const mvp = viewProjection(camera, canvas.width / canvas.height);

        // --- points ---
        gl.useProgram(s.pointProgram);
        const bind = (program: WebGLProgram, name: string, buf: WebGLBuffer, size: number) => {
            const loc = gl.getAttribLocation(program, name);
            if (loc < 0) return;
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
        };
        bind(s.pointProgram, 'aPos', s.posBuf, 3);
        bind(s.pointProgram, 'aColor', s.colBuf, 3);
        bind(s.pointProgram, 'aVisible', s.visBuf, 1);
        gl.uniformMatrix4fv(gl.getUniformLocation(s.pointProgram, 'uMVP'), false, mvp);
        gl.uniform1f(gl.getUniformLocation(s.pointProgram, 'uSize'), 420 * dpr);
        gl.drawArrays(gl.POINTS, 0, laidOut.length);

        // --- lines, AFTER the points ---
        //
        // Drawn first, the sphere imposters paint straight over them and the
        // edges disappear completely. Depth writing is disabled for the same
        // reason a moment later: a line that writes depth occludes the very
        // spheres it connects.
        if (s.lineCount > 0) {
            gl.useProgram(s.lineProgram);
            gl.depthMask(false);
            bind(s.lineProgram, 'aPos', s.linePosBuf, 3);
            bind(s.lineProgram, 'aStrength', s.lineStrBuf, 1);
            gl.uniformMatrix4fv(gl.getUniformLocation(s.lineProgram, 'uMVP'), false, mvp);
            gl.drawArrays(gl.LINES, 0, s.lineCount);
            gl.depthMask(true);
        }
    }, [camera, laidOut, nodes, edges, error]);

    // --- interaction ---------------------------------------------------------
    const drag = useRef<{ x: number; y: number } | null>(null);

    const pick = (clientX: number, clientY: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const mvp = viewProjection(camera, rect.width / rect.height);

        let best: { id: string; sx: number; sy: number; d: number } | null = null;
        for (const p of laidOut) {
            const s = project(p, mvp, rect.width, rect.height);
            if (!s) continue;
            const d = Math.hypot(s.sx - px, s.sy - py);
            // 14px: a little larger than the drawn sphere, so a node is
            // clickable at the size it looks rather than pixel-exactly.
            if (d < 14 && (!best || d < best.d)) best = { id: p.id, sx: s.sx, sy: s.sy, d };
        }
        return best;
    };

    return (
        <Box sx={{ position: 'relative', width: '100%', height }}>
            {error ? (
                <Box sx={{ p: 2 }}>
                    <Typography color="error">{error}</Typography>
                </Box>
            ) : (
                <canvas
                    ref={canvasRef}
                    style={{ width: '100%', height: '100%', display: 'block', borderRadius: 4, cursor: 'grab' }}
                    onPointerDown={(e) => {
                        drag.current = { x: e.clientX, y: e.clientY };
                        (e.target as HTMLElement).setPointerCapture(e.pointerId);
                    }}
                    onPointerUp={(e) => {
                        const start = drag.current;
                        drag.current = null;
                        // A click is a press that did not move. Without this a
                        // drag that ends over a node also selects it, which
                        // makes orbiting feel like it is fighting you.
                        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) {
                            onSelect?.(pick(e.clientX, e.clientY)?.id ?? null);
                        }
                    }}
                    onPointerMove={(e) => {
                        if (drag.current) {
                            const dx = e.clientX - drag.current.x;
                            const dy = e.clientY - drag.current.y;
                            drag.current = { x: e.clientX, y: e.clientY };
                            setCamera((c) => orbit(c, dx * 0.008, -dy * 0.008));
                            setHover(null);
                        } else {
                            setHover(pick(e.clientX, e.clientY));
                        }
                    }}
                    onWheel={(e) => {
                        setCamera((c) => zoom(c, e.deltaY > 0 ? 1.1 : 0.9));
                    }}
                />
            )}

            {hover && (
                <Box
                    sx={{
                        position: 'absolute',
                        left: hover.sx + 12,
                        top: hover.sy + 12,
                        px: 1, py: 0.5,
                        bgcolor: 'rgba(12,15,24,0.92)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: 1,
                        pointerEvents: 'none',
                        maxWidth: 320,
                    }}
                >
                    <Typography variant="caption" sx={{ color: '#dfe6f5' }}>
                        {nodes.find((n) => n.id === hover.id)?.label ?? hover.id}
                    </Typography>
                </Box>
            )}
        </Box>
    );
}
