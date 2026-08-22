/**
 * waves.ts - single source of truth for the ocean surface.
 *
 * The ocean mesh, route and wake shaders, CPU buoyancy, gates, camera, and
 * spawn placement all sample this directional second-order height field.
 * Keeping the surface as y = f(worldXZ, time) avoids the old mismatch where
 * the GPU moved Gerstner vertices sideways while CPU callers ignored that
 * horizontal displacement.
 */

interface DirectionalWave {
  /** XZ travel direction; normalized while compiling. */
  dir: [number, number];
  /** Fundamental vertical amplitude in meters. */
  amplitude: number;
  /** Second-harmonic weight. Higher values sharpen crests and broaden troughs. */
  crest: number;
  /** Meters crest-to-crest. */
  wavelength: number;
  /** Multiplier on the natural deep-water phase speed. */
  speedMul: number;
  /** Fixed phase offset so components do not align at t=0. */
  phase: number;
}

const G = 9.8;

/**
 * A strong-wind open-sea spectrum: one horizon swell, then each energetic
 * band is SPLIT into two components ~15-20° apart. The pair interference
 * gives short-crested seas — crest lines break into tens-of-meters segments
 * instead of running straight to the horizon (the "printed stripes" read).
 * Crest harmonics run 0.2-0.34 so peaks sharpen and troughs broaden like
 * real gravity waves. The 8.5 m band carries hull-scale texture.
 */
const WAVES: readonly DirectionalWave[] = [
  { dir: [0.94, 0.34], amplitude: 0.62, crest: 0.3, wavelength: 128, speedMul: 0.82, phase: 5.6168 },
  { dir: [0.78, -0.63], amplitude: 0.46, crest: 0.34, wavelength: 48, speedMul: 0.9, phase: 1.0336 },
  { dir: [0.55, -0.84], amplitude: 0.44, crest: 0.34, wavelength: 48, speedMul: 0.92, phase: 3.7336 },
  { dir: [0.96, 0.28], amplitude: 0.32, crest: 0.32, wavelength: 27, speedMul: 1, phase: 3.2336 },
  { dir: [0.85, 0.53], amplitude: 0.3, crest: 0.32, wavelength: 27, speedMul: 1.03, phase: 0.4336 },
  { dir: [0.56, 0.83], amplitude: 0.17, crest: 0.26, wavelength: 15, speedMul: 1.08, phase: 1.6336 },
  { dir: [0.83, 0.56], amplitude: 0.16, crest: 0.26, wavelength: 15, speedMul: 1.1, phase: 4.3336 },
  { dir: [-0.2, 0.98], amplitude: 0.14, crest: 0.2, wavelength: 8.5, speedMul: 1.16, phase: 4.4336 },
];

/** Conservative positive crest bound used only to normalize material response. */
export const MAX_AMPLITUDE = WAVES.reduce((sum, wave) =>
  sum + wave.amplitude * (1 + wave.crest), 0);

interface CompiledWave {
  dx: number;
  dz: number;
  k: number;
  omega: number;
  amp: number;
  crest: number;
  phase: number;
  detail: number;
}

const COMPILED: CompiledWave[] = WAVES.map((wave, index) => {
  const len = Math.hypot(wave.dir[0], wave.dir[1]) || 1;
  const k = (Math.PI * 2) / wave.wavelength;
  return {
    dx: wave.dir[0] / len,
    dz: wave.dir[1] / len,
    k,
    omega: Math.sqrt(G * k) * wave.speedMul,
    amp: wave.amplitude,
    crest: wave.crest,
    phase: wave.phase,
    // The 128 m swell remains on the sparse horizon lattice. Shorter bands
    // fade there and return automatically as the camera approaches.
    detail: index === 0 ? 0 : 1,
  };
});

/** Exact CPU mirror of the GPU height profile at world (x, z) and time t. */
export function waterHeight(x: number, z: number, t: number): number {
  let y = 0;
  for (let i = 0; i < COMPILED.length; i++) {
    const wave = COMPILED[i];
    const phase = wave.k * (wave.dx * x + wave.dz * z) + wave.omega * t + wave.phase;
    const c = Math.cos(phase);
    const c2 = c * c * 2 - 1;
    y += wave.amp * (c + wave.crest * c2);
  }
  return y;
}

/** Analytic normal of the exact height field, written without allocations. */
export function waterNormalInto(out: { x: number; y: number; z: number }, x: number, z: number, t: number): void {
  let dhx = 0;
  let dhz = 0;
  for (let i = 0; i < COMPILED.length; i++) {
    const wave = COMPILED[i];
    const phase = wave.k * (wave.dx * x + wave.dz * z) + wave.omega * t + wave.phase;
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const derivative = -(s + wave.crest * 4 * s * c);
    const slope = wave.amp * wave.k * derivative;
    dhx += slope * wave.dx;
    dhz += slope * wave.dz;
  }
  const inv = 1 / Math.hypot(dhx, 1, dhz);
  out.x = -dhx * inv;
  out.y = inv;
  out.z = -dhz * inv;
}

/**
 * GLSL generated from the CPU table. The compatibility normal name remains
 * because wake materials already consume gerstnerNormal(), although the surface is
 * now an exact second-order height field rather than a horizontally displaced
 * Gerstner approximation.
 */
export const WAVES_GLSL: string = (() => {
  const count = COMPILED.length;
  const f = (value: number) => value.toFixed(7);
  let body = '';
  body += `const int NUM_WAVES = ${count};\n`;
  body += `// dir.xy, k, omega | amp, crest harmonic, phase, horizon-detail flag\n`;
  body += `const vec4 WAVE_A[NUM_WAVES] = vec4[NUM_WAVES](\n`;
  body += COMPILED.map((wave) =>
    `  vec4(${f(wave.dx)}, ${f(wave.dz)}, ${f(wave.k)}, ${f(wave.omega)})`).join(',\n');
  body += `\n);\n`;
  body += `const vec4 WAVE_B[NUM_WAVES] = vec4[NUM_WAVES](\n`;
  body += COMPILED.map((wave) =>
    `  vec4(${f(wave.amp)}, ${f(wave.crest)}, ${f(wave.phase)}, ${f(wave.detail)})`).join(',\n');
  body += `\n);\n`;
  body += `
void waveSurfaceState(
  vec2 p,
  float t,
  float detail,
  out float height,
  out vec2 gradient,
  out float verticalVelocity,
  out float curvature
) {
  height = 0.0;
  gradient = vec2(0.0);
  verticalVelocity = 0.0;
  curvature = 0.0;
  for (int i = 0; i < NUM_WAVES; i++) {
    vec4 a = WAVE_A[i];
    vec4 b = WAVE_B[i];
    float phase = a.z * dot(a.xy, p) + a.w * t + b.z;
    float s = sin(phase);
    float c = cos(phase);
    float s2 = 2.0 * s * c;
    float c2 = c * c - s * s;
    float weight = mix(1.0, detail, b.w);
    float profile = c + b.y * c2;
    float derivative = -(s + 2.0 * b.y * s2);
    float secondDerivative = -(c + 4.0 * b.y * c2);
    height += b.x * profile * weight;
    gradient += a.xy * (b.x * a.z * derivative * weight);
    verticalVelocity += b.x * a.w * derivative * weight;
    curvature += b.x * a.z * a.z * secondDerivative * weight;
  }
}

float waveHeightLod(vec2 p, float t, float detail) {
  float height = 0.0;
  for (int i = 0; i < NUM_WAVES; i++) {
    vec4 a = WAVE_A[i];
    vec4 b = WAVE_B[i];
    float c = cos(a.z * dot(a.xy, p) + a.w * t + b.z);
    float c2 = 2.0 * c * c - 1.0;
    height += b.x * (c + b.y * c2) * mix(1.0, detail, b.w);
  }
  return height;
}

float waveHeight(vec2 p, float t) {
  return waveHeightLod(p, t, 1.0);
}

vec3 waveDisplaceLod(vec3 p, float t, float detail) {
  p.y += waveHeightLod(p.xz, t, detail);
  return p;
}

vec3 gerstnerNormal(vec2 p, float t) {
  vec2 gradient = vec2(0.0);
  for (int i = 0; i < NUM_WAVES; i++) {
    vec4 a = WAVE_A[i];
    vec4 b = WAVE_B[i];
    float phase = a.z * dot(a.xy, p) + a.w * t + b.z;
    float s = sin(phase);
    float c = cos(phase);
    float derivative = -(s + 4.0 * b.y * s * c);
    gradient += a.xy * (b.x * a.z * derivative);
  }
  return normalize(vec3(-gradient.x, 1.0, -gradient.y));
}
`;
  return body;
})();
