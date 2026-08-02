import { describe, it, expect } from 'vitest';
import {
    defaultCamera, orbit, zoom, eyePosition, perspective, lookAt, multiply,
    viewProjection, project,
} from './camera';
import { rebaseStrength } from './shaders';

describe('orbit', () => {
    /**
     * Looking straight up makes the look-at basis degenerate (`up` becomes
     * parallel to the view direction), and the whole scene flips or vanishes.
     * The clamp is the only thing preventing it, so it is tested at both ends.
     */
    it('never reaches the poles', () => {
        let cam = defaultCamera();
        for (let i = 0; i < 100; i++) cam = orbit(cam, 0, -1);
        expect(cam.phi).toBeGreaterThan(0);
        for (let i = 0; i < 200; i++) cam = orbit(cam, 0, 1);
        expect(cam.phi).toBeLessThan(Math.PI);
    });

    it('lets horizontal orbit run freely', () => {
        const cam = orbit(defaultCamera(), 100, 0);
        expect(cam.theta).toBeCloseTo(defaultCamera().theta + 100);
    });

    it('does not mutate its input', () => {
        const cam = defaultCamera();
        orbit(cam, 1, 1);
        expect(cam).toEqual(defaultCamera());
    });
});

describe('zoom', () => {
    /**
     * Multiplicative, so one wheel notch covers the same proportion at any
     * distance. Additive zoom crawls when far out and jumps through the middle
     * when close — the reason this is a function rather than `cam.distance -= 10`.
     */
    it('moves proportionally, not by a fixed amount', () => {
        const near = zoom({ ...defaultCamera(), distance: 100 }, 0.9);
        const far = zoom({ ...defaultCamera(), distance: 1000 }, 0.9);
        expect(near.distance).toBeCloseTo(90);
        expect(far.distance).toBeCloseTo(900);
    });

    it('clamps at both ends so the camera cannot pass through or fly off', () => {
        expect(zoom(defaultCamera(), 0.0001).distance).toBe(20);
        expect(zoom(defaultCamera(), 10_000).distance).toBe(3000);
    });
});

describe('eyePosition', () => {
    it('sits at the requested distance from the target', () => {
        const cam = { theta: 1.2, phi: 0.9, distance: 250, target: [10, 20, 30] as [number, number, number] };
        const e = eyePosition(cam);
        expect(Math.hypot(e[0] - 10, e[1] - 20, e[2] - 30)).toBeCloseTo(250);
    });
});

describe('matrices', () => {
    /**
     * Column-major is what gl.uniformMatrix4fv expects with transpose=false.
     * Getting it wrong renders a black screen with no error, so the layout is
     * pinned here rather than trusted.
     */
    it('builds a column-major perspective matrix', () => {
        const m = perspective(Math.PI / 2, 1, 1, 100);
        expect(m[11]).toBe(-1);
        expect(m[15]).toBe(0);
        expect(m[0]).toBeCloseTo(1);
    });

    it('multiplies in the conventional order', () => {
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const m = perspective(1, 1.5, 1, 100);
        expect(Array.from(multiply(m, identity))).toEqual(Array.from(m));
        expect(Array.from(multiply(identity, m))).toEqual(Array.from(m));
    });

    it('places a look-at camera so the target lands at the centre', () => {
        const mvp = multiply(
            perspective(Math.PI / 4, 1, 1, 1000),
            lookAt([0, 0, 100], [0, 0, 0]),
        );
        const p = project({ x: 0, y: 0, z: 0 }, mvp, 800, 600);
        expect(p).not.toBeNull();
        expect(p!.sx).toBeCloseTo(400);
        expect(p!.sy).toBeCloseTo(300);
    });
});

describe('project', () => {
    const mvp = viewProjection({ theta: 0, phi: Math.PI / 2, distance: 200, target: [0, 0, 0] }, 1);

    /**
     * Without the w <= 0 rejection, a point behind the camera projects to a
     * mirrored position in front of it — a label for an object you cannot see,
     * on the wrong side of the screen.
     */
    it('rejects points behind the camera', () => {
        // Camera is at +x looking back at the origin, so far +x is behind it.
        expect(project({ x: 100_000, y: 0, z: 0 }, mvp, 800, 600)).toBeNull();
    });

    it('projects the target to the centre of the viewport', () => {
        const p = project({ x: 0, y: 0, z: 0 }, mvp, 800, 600)!;
        expect(p.sx).toBeCloseTo(400);
        expect(p.sy).toBeCloseTo(300);
    });

    /** Screen y runs downward; world y runs up. Flipping this puts every
     *  label on the wrong side of its node. */
    it('flips the y axis for screen space', () => {
        const above = project({ x: 0, y: 50, z: 0 }, mvp, 800, 600)!;
        expect(above.sy).toBeLessThan(300);
    });
});

describe('rebaseStrength', () => {
    /**
     * Raw similarities only ever occupy floor..1. Feeding them straight to the
     * shader renders every edge between 0.60 and 0.85 opacity — technically
     * correct, visually a single flat weight.
     */
    it('spreads the visible range across the full ramp', () => {
        expect(rebaseStrength(0.55, 0.55)).toBeCloseTo(0);
        expect(rebaseStrength(1.0, 0.55)).toBeCloseTo(1);
        expect(rebaseStrength(0.775, 0.55)).toBeCloseTo(0.5);
    });

    /** The API clamps a requested floor up to 1.0, so this is reachable. */
    it('does not divide by zero at a floor of 1', () => {
        expect(rebaseStrength(1.0, 1.0)).toBe(1);
    });

    it('clamps rather than going out of range', () => {
        expect(rebaseStrength(0.1, 0.55)).toBe(0);
        expect(rebaseStrength(1.5, 0.55)).toBe(1);
    });

    it('treats a non-finite similarity as the weakest rather than as NaN', () => {
        expect(rebaseStrength(NaN, 0.55)).toBe(0);
    });
});
