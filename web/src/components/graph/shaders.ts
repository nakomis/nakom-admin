/**
 * GLSL for the 3D similarity graph (ADMIN-11).
 *
 * Ported from scratch/viewer/viewer.html, which was built against the
 * claude-chats corpus. Kept verbatim where it was right, with the comments
 * that explain *why* each term is there — those were paid for in a lot of
 * squinting at 40,000 dots and are the most valuable thing in the file.
 *
 * WebGL1 (`attribute`/`varying`, `gl_FragColor`) rather than WebGL2: the
 * shaders use nothing WebGL2 offers, and WebGL1 has broader support with no
 * fallback path to maintain.
 */

export const POINT_VERT = `
attribute vec3 aPos;
attribute vec3 aColor;
attribute float aVisible;
uniform mat4 uMVP;
uniform float uSize;
varying vec3 vColor;
varying float vVisible;
varying float vSize;
varying vec3 vSeed;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  // Perspective-correct sizing, clamped so distant points stay visible and
  // near ones do not become blobs.
  gl_PointSize = clamp(uSize / max(gl_Position.w, 0.001), 2.0, 46.0);
  vColor = aColor;
  vVisible = aVisible;
  vSize = gl_PointSize;
  // World position doubles as a per-sphere random seed, so neighbouring
  // spheres get different surface patterns rather than a repeated stamp.
  vSeed = aPos;
}`;

export const POINT_FRAG = `
precision mediump float;
varying vec3 vColor;
varying float vVisible;
varying float vSize;
varying vec3 vSeed;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Smooth value noise. Cheap enough to afford twice per fragment, which is
// what the bump gradient below needs.
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Sphere imposter: the geometry is still a flat point, but the normal is
// reconstructed as though the disc were a sphere and then lit. A real sphere
// mesh would mean thousands of instanced draws; this costs one extra sqrt per
// fragment and reads as a lit ball rather than a sticker.
void main() {
  if (vVisible < 0.5) discard;

  vec2 d = gl_PointCoord * 2.0 - 1.0;   // -1..1 across the point
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;                // outside the sphere's silhouette

  // z on the unit sphere; y flipped because gl_PointCoord runs top-down.
  vec3 N = vec3(d.x, -d.y, sqrt(1.0 - r2));

  // Surface texture, faded in by apparent size. Below ~7px a sphere is too
  // small to show relief and the noise would read as dithering, so it is
  // suppressed entirely; it emerges as you zoom in.
  float detail = smoothstep(6.0, 20.0, vSize);
  if (detail > 0.001) {
    // Offset the noise field per sphere so neighbours differ.
    vec2 uv = d * 4.5 + vec2(hash(vSeed.xy), hash(vSeed.yz)) * 32.0;
    float e = 0.35;
    // Central difference across the noise field gives a bump gradient; nudging
    // the normal by it is what catches the light, rather than just tinting.
    vec2 grad = vec2(noise(uv + vec2(e, 0.0)) - noise(uv - vec2(e, 0.0)),
                     noise(uv + vec2(0.0, e)) - noise(uv - vec2(0.0, e)));
    N = normalize(N + vec3(grad, 0.0) * detail * 0.9);
  }

  vec3 L = normalize(vec3(-0.35, 0.55, 0.75));

  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(reflect(-L, N), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
  // Rim term: a touch of brightness at the silhouette separates overlapping
  // spheres from each other, which matters a lot in the dense clusters.
  float rim  = pow(1.0 - N.z, 2.5) * 0.30;

  vec3 col = vColor * (0.28 + 0.72 * diff) + vec3(spec * 0.45 + rim);

  // Antialias the silhouette only in the last few percent of the radius, so
  // the sphere stays solid and depth-testable rather than half-transparent.
  float alpha = 1.0 - smoothstep(0.92, 1.0, r2);
  gl_FragColor = vec4(col, alpha);
}`;

export const LINE_VERT = `
attribute vec3 aPos;
attribute float aStrength;
uniform mat4 uMVP;
varying float vStrength;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  vStrength = aStrength;
}`;

export const LINE_FRAG = `
precision mediump float;
varying float vStrength;
void main() {
  // Opacity carries similarity: a strong pair reads as a solid line, a
  // marginal one as a hint. Drawing them all at equal weight would assert
  // that every link above the floor is equivalent.
  //
  // Unlike the scratch viewer, strength arrives here raw rather than rebased
  // out of the edge floor by the packer — the API returns real cosine
  // similarities. It is rebased on the CPU (see rebaseStrength) so this stays
  // a straight read; doing it here would need the floor as a uniform for no
  // benefit.
  gl_FragColor = vec4(0.62, 0.74, 0.92, 0.30 + vStrength * 0.55);
}`;

/**
 * Map a cosine similarity onto 0..1 across the visible range.
 *
 * Edges below the floor are never returned, so raw similarities occupy only
 * `floor..1` — for a floor of 0.55 that is the top 45% of the scale, and
 * feeding it straight to the shader would render every edge at between 0.60
 * and 0.85 opacity. Rebasing spreads the actual range across the full ramp,
 * which is what makes a strong link look different from a marginal one.
 */
export function rebaseStrength(similarity: number, floor: number): number {
    if (!Number.isFinite(similarity)) return 0;
    // A floor of 1.0 would divide by zero. It is reachable — the API clamps a
    // requested floor up to 1.0 — and it means every surviving edge is an
    // exact duplicate, so they are all equally strong.
    const span = 1 - floor;
    if (span <= 1e-6) return 1;
    return Math.min(1, Math.max(0, (similarity - floor) / span));
}
