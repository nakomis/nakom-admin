/**
 * Orbit camera and the 4x4 maths the viewer needs (ADMIN-11).
 *
 * Separate from the component so it can be tested without a canvas. Matrices
 * are column-major `Float32Array(16)`, which is what `gl.uniformMatrix4fv`
 * expects with `transpose = false` — passing a row-major matrix there is a
 * silent failure that renders a black screen, so the convention is stated
 * once here and never varied.
 */

export type Mat4 = Float32Array;

export interface Camera {
    /** Horizontal orbit angle, radians. */
    theta: number;
    /** Vertical orbit angle, radians. Clamped away from the poles. */
    phi: number;
    /** Distance from the target. */
    distance: number;
    target: [number, number, number];
}

/** Straight up is a singularity for the look-at basis; stop just short. */
const PHI_LIMIT = 0.01;

export function defaultCamera(): Camera {
    return { theta: 0.6, phi: 1.1, distance: 320, target: [0, 0, 0] };
}

export function orbit(cam: Camera, dTheta: number, dPhi: number): Camera {
    return {
        ...cam,
        theta: cam.theta + dTheta,
        phi: Math.min(Math.PI - PHI_LIMIT, Math.max(PHI_LIMIT, cam.phi + dPhi)),
    };
}

/**
 * Multiplicative zoom, clamped.
 *
 * Multiplicative rather than additive so a wheel notch moves the same
 * *proportion* of the way in regardless of current distance — additive zoom
 * crawls when far away and overshoots through the middle when close.
 */
export function zoom(cam: Camera, factor: number, min = 20, max = 3000): Camera {
    return { ...cam, distance: Math.min(max, Math.max(min, cam.distance * factor)) };
}

export function eyePosition(cam: Camera): [number, number, number] {
    const { theta, phi, distance, target } = cam;
    return [
        target[0] + distance * Math.sin(phi) * Math.cos(theta),
        target[1] + distance * Math.cos(phi),
        target[2] + distance * Math.sin(phi) * Math.sin(theta),
    ];
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
}

export function lookAt(
    eye: [number, number, number],
    centre: [number, number, number],
    up: [number, number, number] = [0, 1, 0],
): Mat4 {
    const z = normalise([eye[0] - centre[0], eye[1] - centre[1], eye[2] - centre[2]]);
    const x = normalise(cross(up, z));
    const y = cross(z, x);
    const m = new Float32Array(16);
    m[0] = x[0]; m[1] = y[0]; m[2] = z[0]; m[3] = 0;
    m[4] = x[1]; m[5] = y[1]; m[6] = z[1]; m[7] = 0;
    m[8] = x[2]; m[9] = y[2]; m[10] = z[2]; m[11] = 0;
    m[12] = -dot(x, eye); m[13] = -dot(y, eye); m[14] = -dot(z, eye); m[15] = 1;
    return m;
}

/** `out = a * b`, both column-major. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
    const m = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            m[c * 4 + r] =
                a[r] * b[c * 4] +
                a[4 + r] * b[c * 4 + 1] +
                a[8 + r] * b[c * 4 + 2] +
                a[12 + r] * b[c * 4 + 3];
        }
    }
    return m;
}

export function viewProjection(cam: Camera, aspect: number): Mat4 {
    // far is generous relative to the normalised radius of 100 so a zoomed-out
    // graph is never clipped; near is not tiny, because a near/far ratio that
    // large costs depth precision and makes overlapping spheres z-fight.
    return multiply(perspective(Math.PI / 4, aspect, 1, 6000), lookAt(eyePosition(cam), cam.target));
}

/**
 * Project a world point to pixel coordinates, or null if behind the camera.
 *
 * Used for hover picking and for placing DOM label overlays. The `w <= 0`
 * check is what stops points behind the viewer being drawn, mirrored, in
 * front of it — which is a genuinely confusing bug to look at.
 */
export function project(
    p: { x: number; y: number; z: number },
    mvp: Mat4,
    width: number,
    height: number,
): { sx: number; sy: number; depth: number } | null {
    const x = mvp[0] * p.x + mvp[4] * p.y + mvp[8] * p.z + mvp[12];
    const y = mvp[1] * p.x + mvp[5] * p.y + mvp[9] * p.z + mvp[13];
    const z = mvp[2] * p.x + mvp[6] * p.y + mvp[10] * p.z + mvp[14];
    const w = mvp[3] * p.x + mvp[7] * p.y + mvp[11] * p.z + mvp[15];
    if (w <= 0) return null;
    return {
        sx: ((x / w) * 0.5 + 0.5) * width,
        sy: (1 - ((y / w) * 0.5 + 0.5)) * height,
        depth: z / w,
    };
}

function normalise(v: [number, number, number]): [number, number, number] {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
