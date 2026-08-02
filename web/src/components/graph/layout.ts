/**
 * Force-directed 3D layout for the similarity graph (ADMIN-11).
 *
 * **Why the layout is computed here and not on the server.** The claude-chats
 * corpus is 40k+ messages, and its positions are fitted offline with
 * UMAP/PCA and baked into a static bundle — a browser cannot do that. The
 * cv-chat corpus is three orders of magnitude smaller, so it gets a plain
 * force simulation instead. That removes a scheduled job, two tables, and the
 * class of bug where stored coordinates are stale with respect to the data
 * they claim to draw. The honest signal that this trade has flipped is the
 * layout visibly taking seconds, not a number measured anywhere.
 *
 * Deliberately not d3-force-3d or three.js: this is ~80 lines of vector
 * arithmetic, and pulling in either would be bigger than the thing it
 * replaced. The 2D graph that did use d3 is gone (ADMIN-10), and d3, plotly
 * and umap-js came out of package.json with it — the whole point of moving
 * the projection server-side and the layout here is that the browser needs
 * none of them.
 *
 * The simulation is a plain function over plain arrays with an injected RNG,
 * so it is testable without a canvas — which is the whole reason it lives in
 * its own file rather than inside the component.
 */

export interface GraphNode {
    id: string;
    embedded: boolean;
}

export interface GraphEdge {
    source: string;
    target: string;
    similarity: number;
}

export interface Positioned {
    id: string;
    x: number;
    y: number;
    z: number;
}

export interface LayoutOptions {
    /** Simulation steps. 300 is comfortably converged at these sizes. */
    iterations?: number;
    /** Repulsion between every pair. Negative pushes apart. */
    charge?: number;
    /** How hard an edge pulls toward its ideal length. */
    linkStrength?: number;
    /** Pull toward the origin, which stops disconnected parts drifting away. */
    centreStrength?: number;
    /** Injected so tests are deterministic. Defaults to Math.random. */
    random?: () => number;
}

const DEFAULTS = {
    iterations: 300,
    charge: -30,
    linkStrength: 0.6,
    centreStrength: 0.02,
};

/**
 * Ideal length of an edge, from its similarity.
 *
 * Inverted: a *more* similar pair should sit *closer*. Getting this backwards
 * produces a picture that looks entirely plausible and means the opposite of
 * what it says, which is the worst failure mode available to a visualisation
 * — hence the test.
 *
 * The floor of 5 keeps a similarity of exactly 1.0 (a duplicate message, which
 * really does happen — visitors ask the same question) from collapsing two
 * nodes onto the same point, where neither is clickable.
 */
export function idealLength(similarity: number): number {
    return 5 + (1 - similarity) * 120;
}

/**
 * Deterministic initial position on a sphere, from the node's index.
 *
 * A sphere rather than a random cloud so the starting state has no clumps for
 * the simulation to have to undo. Seeded from the index rather than the RNG so
 * that re-running a layout on the same data gives the same picture — a graph
 * that rearranges itself every time the user changes a filter is much harder
 * to read, even when both arrangements are equally correct.
 */
export function initialPosition(index: number, count: number, radius = 100): Positioned {
    // Fibonacci sphere: even coverage without clustering at the poles, which
    // is what a naive lat/long grid gives.
    const golden = Math.PI * (3 - Math.sqrt(5));
    const y = count === 1 ? 0 : 1 - (index / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * index;
    return {
        id: '',
        x: Math.cos(theta) * r * radius,
        y: y * radius,
        z: Math.sin(theta) * r * radius,
    };
}

/**
 * Run the simulation and return final positions.
 *
 * Synchronous and bounded: at a few thousand nodes this is tens of
 * milliseconds, and an animated layout would mean the user watching it settle
 * rather than reading it.
 */
export function layout(
    nodes: GraphNode[],
    edges: GraphEdge[],
    options: LayoutOptions = {},
): Positioned[] {
    const opts = { ...DEFAULTS, ...options };
    const n = nodes.length;
    if (n === 0) return [];

    const pos = nodes.map((node, i) => ({ ...initialPosition(i, n), id: node.id }));
    const index = new Map(nodes.map((node, i) => [node.id, i]));

    // Edges referencing a node we were not given cannot be laid out. The API
    // already restricts edges to the returned nodes, so this should never
    // fire — but a layout that silently indexes `undefined` produces NaN
    // coordinates and an empty screen, which is a miserable thing to debug.
    const links = edges
        .map((e) => ({ a: index.get(e.source), b: index.get(e.target), sim: e.similarity }))
        .filter((l): l is { a: number; b: number; sim: number } => l.a !== undefined && l.b !== undefined);

    const vx = new Float64Array(n);
    const vy = new Float64Array(n);
    const vz = new Float64Array(n);

    for (let step = 0; step < opts.iterations; step++) {
        // Cooling: large moves early to escape the initial arrangement, small
        // ones later so the result settles instead of jittering forever.
        const alpha = 1 - step / opts.iterations;

        // Repulsion, every pair. O(n²) — at 2,000 nodes (the API's default
        // page) that is 2M distance calculations per step, which is why
        // MAX_NODES is capped at 5,000 rather than left open.
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let dx = pos[i].x - pos[j].x;
                let dy = pos[i].y - pos[j].y;
                let dz = pos[i].z - pos[j].z;
                let d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < 1e-6) {
                    // Exactly coincident: nudge deterministically rather than
                    // dividing by zero. Uses the indices so it stays
                    // reproducible.
                    dx = (i % 3) - 1 || 0.5;
                    dy = (j % 3) - 1 || 0.5;
                    dz = 0.5;
                    d2 = dx * dx + dy * dy + dz * dz;
                }
                const d = Math.sqrt(d2);
                const f = (opts.charge * alpha) / d2;
                const ux = dx / d, uy = dy / d, uz = dz / d;
                vx[i] -= ux * f; vy[i] -= uy * f; vz[i] -= uz * f;
                vx[j] += ux * f; vy[j] += uy * f; vz[j] += uz * f;
            }
        }

        // Attraction along edges, toward the ideal length for the similarity.
        for (const l of links) {
            const dx = pos[l.b].x - pos[l.a].x;
            const dy = pos[l.b].y - pos[l.a].y;
            const dz = pos[l.b].z - pos[l.a].z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
            const target = idealLength(l.sim);
            const f = ((d - target) / d) * opts.linkStrength * alpha;
            vx[l.a] += dx * f; vy[l.a] += dy * f; vz[l.a] += dz * f;
            vx[l.b] -= dx * f; vy[l.b] -= dy * f; vz[l.b] -= dz * f;
        }

        // Centring, and integrate. Without the pull to the origin, components
        // with no edge between them drift apart indefinitely — repulsion is
        // the only force acting on them.
        for (let i = 0; i < n; i++) {
            vx[i] -= pos[i].x * opts.centreStrength * alpha;
            vy[i] -= pos[i].y * opts.centreStrength * alpha;
            vz[i] -= pos[i].z * opts.centreStrength * alpha;

            // Velocity decay. Without it the system oscillates rather than
            // settling — the forces are conservative and nothing removes energy.
            vx[i] *= 0.6; vy[i] *= 0.6; vz[i] *= 0.6;

            pos[i].x += vx[i];
            pos[i].y += vy[i];
            pos[i].z += vz[i];
        }
    }

    return pos;
}

/** Euclidean distance, for tests and for the viewer's picking code. */
export function distance(a: Positioned, b: Positioned): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Scale positions into a fixed radius, so the camera never has to be adjusted
 * for the size of the graph.
 *
 * Normalising after the fact rather than constraining during the simulation:
 * the forces have absolute scales (idealLength is in the same units as
 * charge), and rescaling as they run would change what those constants mean.
 */
export function normalise(positions: Positioned[], radius = 100): Positioned[] {
    if (positions.length === 0) return positions;
    const max = positions.reduce(
        (m, p) => Math.max(m, Math.hypot(p.x, p.y, p.z)),
        0,
    );
    if (max === 0) return positions;
    const k = radius / max;
    return positions.map((p) => ({ id: p.id, x: p.x * k, y: p.y * k, z: p.z * k }));
}
