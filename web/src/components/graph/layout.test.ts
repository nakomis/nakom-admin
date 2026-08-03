import { describe, it, expect } from 'vitest';
import { layout, idealLength, initialPosition, distance, normalise } from './layout';

const node = (id: string) => ({ id, embedded: true });

describe('idealLength', () => {
    /**
     * The single assertion that matters most in this file. Inverting this
     * produces a picture where dissimilar things sit close together — entirely
     * plausible-looking, and the exact opposite of what the axis label claims.
     */
    it('puts more similar pairs closer together', () => {
        expect(idealLength(0.9)).toBeLessThan(idealLength(0.6));
        expect(idealLength(1.0)).toBeLessThan(idealLength(0.55));
    });

    /** Duplicate messages really occur — visitors ask the same question. */
    it('never collapses an identical pair onto one point', () => {
        expect(idealLength(1.0)).toBeGreaterThan(0);
    });
});

describe('initialPosition', () => {
    it('spreads points over a sphere rather than clumping', () => {
        const pts = Array.from({ length: 200 }, (_, i) => initialPosition(i, 200));
        const radii = pts.map((p) => Math.hypot(p.x, p.y, p.z));
        for (const r of radii) expect(r).toBeGreaterThan(90);
        // Both hemispheres get used — a lat/long grid that clusters at the
        // poles would still pass a radius check.
        expect(pts.filter((p) => p.y > 0).length).toBeGreaterThan(80);
        expect(pts.filter((p) => p.y < 0).length).toBeGreaterThan(80);
    });

    it('handles a single node without dividing by zero', () => {
        const p = initialPosition(0, 1);
        expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    });
});

describe('layout', () => {
    it('returns a position for every node, in order', () => {
        const nodes = [node('a'), node('b'), node('c')];
        const out = layout(nodes, [], { iterations: 20 });
        expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    });

    it('handles an empty graph', () => {
        expect(layout([], [], {})).toEqual([]);
    });

    /**
     * NaN coordinates render as an empty screen with no error, so this is
     * checked explicitly rather than left to the eye.
     */
    it('never produces NaN, even with coincident starting points', () => {
        const nodes = Array.from({ length: 30 }, (_, i) => node(`n${i}`));
        const edges = nodes.slice(1).map((n) => ({ source: 'n0', target: n.id, similarity: 1.0 }));
        const out = layout(nodes, edges, { iterations: 100 });
        for (const p of out) {
            expect(Number.isFinite(p.x)).toBe(true);
            expect(Number.isFinite(p.y)).toBe(true);
            expect(Number.isFinite(p.z)).toBe(true);
        }
    });

    /**
     * The property the whole picture rests on: a strongly-linked pair must end
     * up nearer each other than an unlinked pair.
     */
    it('pulls linked nodes closer than unlinked ones', () => {
        const nodes = [node('a'), node('b'), node('c'), node('d')];
        const edges = [{ source: 'a', target: 'b', similarity: 0.95 }];
        const out = layout(nodes, edges, { iterations: 400 });
        const at = (id: string) => out.find((p) => p.id === id)!;
        expect(distance(at('a'), at('b'))).toBeLessThan(distance(at('c'), at('d')));
    });

    /** Higher similarity should mean a visibly tighter pair. */
    it('respects the strength of a link, not just its presence', () => {
        const nodes = [node('a'), node('b'), node('c'), node('d')];
        const out = layout(nodes, [
            { source: 'a', target: 'b', similarity: 0.99 },
            { source: 'c', target: 'd', similarity: 0.60 },
        ], { iterations: 400 });
        const at = (id: string) => out.find((p) => p.id === id)!;
        expect(distance(at('a'), at('b'))).toBeLessThan(distance(at('c'), at('d')));
    });

    /**
     * Deterministic: the same input must give the same picture. A graph that
     * rearranges itself whenever a filter changes is far harder to read, even
     * though both arrangements are equally valid.
     */
    it('is deterministic', () => {
        const nodes = [node('a'), node('b'), node('c')];
        const edges = [{ source: 'a', target: 'b', similarity: 0.8 }];
        const a = layout(nodes, edges, { iterations: 50 });
        const b = layout(nodes, edges, { iterations: 50 });
        expect(a).toEqual(b);
    });

    /**
     * An edge naming a node we were not given would index undefined and
     * poison every coordinate with NaN. The API should never send one, which
     * is exactly why this needs a test rather than trust.
     */
    it('ignores an edge referencing an unknown node', () => {
        const out = layout([node('a'), node('b')], [
            { source: 'a', target: 'ghost', similarity: 0.9 },
        ], { iterations: 50 });
        for (const p of out) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    });

    /**
     * With no edges, repulsion is the only force between two components —
     * without a centring pull they accelerate apart forever and the camera
     * shows an empty middle.
     */
    it('keeps a disconnected graph bounded', () => {
        const nodes = Array.from({ length: 20 }, (_, i) => node(`n${i}`));
        const out = layout(nodes, [], { iterations: 300 });
        for (const p of out) expect(Math.hypot(p.x, p.y, p.z)).toBeLessThan(10_000);
    });
});

describe('normalise', () => {
    it('scales the furthest node onto the requested radius', () => {
        const out = normalise([
            { id: 'a', x: 0, y: 0, z: 0 },
            { id: 'b', x: 300, y: 0, z: 0 },
        ], 100);
        expect(Math.hypot(out[1].x, out[1].y, out[1].z)).toBeCloseTo(100);
    });

    it('preserves relative distances', () => {
        const out = normalise([
            { id: 'a', x: 0, y: 0, z: 0 },
            { id: 'b', x: 100, y: 0, z: 0 },
            { id: 'c', x: 200, y: 0, z: 0 },
        ], 50);
        expect(distance(out[0], out[1])).toBeCloseTo(distance(out[1], out[2]));
    });

    /** One node at the origin would otherwise divide by zero. */
    it('leaves a degenerate graph alone rather than dividing by zero', () => {
        const out = normalise([{ id: 'a', x: 0, y: 0, z: 0 }]);
        expect(out[0]).toEqual({ id: 'a', x: 0, y: 0, z: 0 });
    });

    it('handles an empty list', () => {
        expect(normalise([])).toEqual([]);
    });
});
