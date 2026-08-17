/**
 * ocean.ts — infinite arcade ocean shared by rendering and boat physics.
 *
 * Art target: clean racing water whose material comes from surface direction,
 * view angle, sunlight, and sparse readable whitecaps. Broad swell carries
 * gameplay; local foam and wake carry interaction. The sea must never bury
 * racers, route guidance, or technique effects under full-frame color slabs.
 *
 * Technique:
 *  - One camera-following mesh, recentered in update() and SNAPPED to the
 *    1.4 m world grid so vertices never swim. Displacement is a pure
 *    function of world XZ (waves.ts Gerstner chunk) so it can never tile.
 *  - Two LOD rings in ONE BufferGeometry / one draw call:
 *      dense center 320x320 quads @ 1.4 m (448 m across)
 *      coarse outer lattice @ 56 m, reaching 3976 m (~horizon)
 *    The outer lattice has a square hole exactly on the dense grid's edge;
 *    a fan "stitch strip" bridges the 1.4 m / 56 m tessellation mismatch
 *    with bit-identical shared world positions, so there is no crack and
 *    no z-fighting overlap (strictly cleaner than raw overlap).
 *  - All fragment shading (normal response, foam, reflection, fog) is computed
 *    per-pixel from the analytic wave field on the UNDISPLACED world XZ.
 *    On the dense grid vH computed this way is mathematically identical to
 *    displacedY / MAX_AMPLITUDE (the Gerstner Y term IS waveHeight(origXZ)),
 *    and on the coarse ring it stays alias-free. Shading can never diverge
 *    at the LOD boundary.
 *  - View-facing slopes pick up the sky while sun-facing slopes carry a broad
 *    reflection. Two small visual-only ripples fade before the mid field and
 *    never feed buoyancy or collision.
 *  - Whitecaps require a high, steep, rising wave face. Low-frequency noise
 *    only breaks their coverage into natural runs; it does not recolor the sea.
 *  - Every local detail fades continuously into the horizon, avoiding both
 *    shimmer and the old hard distance bands.
 *  - Hull foam collar: depth-difference mask against the ink prepass depth
 *    texture (core/prePass.ts), BIASED ~3 cm so the collar only emits where
 *    the water fragment is strictly in front of the solid by a margin (no
 *    z-fight teeth at the hull's lower edge). The collar is broken into
 *    chunky time-quantized arcs hugging the contact — darkened contact
 *    water, then foam chunks, then sparse outer flecks. Never a solid
 *    ring/slab. NOTE: in this pipeline the prepass depth texture is sampled
 *    UNFLIPPED (gl_FragCoord.xy / uResolution). A V-flip here mirrors the
 *    foam mask across the screen middle and paints phantom foam sheets
 *    above every hull — verified with masking debug shots. Do not flip.
 */

import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { WAVES_GLSL, MAX_AMPLITUDE } from './waves';

// ------------------------------------------------------- geometry layout ----

const DENSE_CELLS = 320; // center grid quads per side
const DENSE_CELL = 1.4; // meters — also the world-grid snap step
const DENSE_HALF = (DENSE_CELLS * DENSE_CELL) / 2; // 224 m
const OUTER_CELL = 56.0; // 40 x dense cell; divides DENSE_HALF exactly (4 cells)
const OUTER_LINES = 71; // lattice half-extent in cells -> 71*56 = 3976 m (~4000 m)
const FAN_SEGS = (DENSE_HALF * 2) / OUTER_CELL; // 8 coarse segments per hole side
const FAN_SUB = OUTER_CELL / DENSE_CELL; // 40 dense intervals per coarse segment

/**
 * Builds the merged dense-center + coarse-ring + stitch-strip geometry.
 * Every vertex XZ derives from (k * cell) expressions so duplicated seam
 * positions are bit-identical in float32 on both sides of the seam.
 */
function buildOceanGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];

  // --- dense center: (DENSE_CELLS+1)^2 verts, coords k*1.4 for k in [-160..160]
  const dv = DENSE_CELLS + 1;
  for (let j = 0; j < dv; j++) {
    for (let i = 0; i < dv; i++) {
      positions.push((i - DENSE_CELLS / 2) * DENSE_CELL, 0, (j - DENSE_CELLS / 2) * DENSE_CELL);
    }
  }
  for (let j = 0; j < DENSE_CELLS; j++) {
    for (let i = 0; i < DENSE_CELLS; i++) {
      const a = j * dv + i;
      const b = a + 1;
      const c = a + dv;
      const d = c + 1;
      indices.push(a, c, b, c, d, b); // CCW from +Y
    }
  }

  // --- outer coarse lattice, skipping vertices strictly inside the hole
  const ov = OUTER_LINES * 2 + 1; // 143 lines per side
  const lattice = new Int32Array(ov * ov).fill(-1);
  const holeLines = DENSE_HALF / OUTER_CELL; // 4 — hole boundary sits on lattice lines
  for (let j = 0; j < ov; j++) {
    for (let i = 0; i < ov; i++) {
      const ki = i - OUTER_LINES;
      const kj = j - OUTER_LINES;
      // strict interior of the hole (|x| < 224 and |z| < 224): unused, skip
      if (Math.abs(ki) < holeLines && Math.abs(kj) < holeLines) continue;
      lattice[j * ov + i] = positions.length / 3;
      positions.push(ki * OUTER_CELL, 0, kj * OUTER_CELL);
    }
  }
  // Coarse quads. Removed: the hole interior plus the innermost ring of quads
  // that the stitch strip replaces (any quad inside |center| <= 252 m, except
  // the four corner quads which stay — the fans don't cover the corners).
  for (let j = 0; j < ov - 1; j++) {
    for (let i = 0; i < ov - 1; i++) {
      // quad center in half-cell units relative to lattice center
      const ci = Math.abs(i - OUTER_LINES + 0.5);
      const cj = Math.abs(j - OUTER_LINES + 0.5);
      if (Math.max(ci, cj) <= holeLines + 0.5 && Math.min(ci, cj) <= holeLines - 0.5) continue;
      const a = lattice[j * ov + i];
      const b = lattice[j * ov + i + 1];
      const c = lattice[(j + 1) * ov + i];
      const d = lattice[(j + 1) * ov + i + 1];
      indices.push(a, c, b, c, d, b); // CCW from +Y
    }
  }

  // --- stitch strip: dense-spacing vertices on the hole boundary, fanned to
  // the coarse lattice line one cell out (|coord| = 280). Winding verified
  // +Y for all four sides; V positions reuse k*DENSE_CELL so they match the
  // dense grid edge bit-for-bit.
  const latticeAt = (x: number, z: number): number => {
    const i = Math.round(x / OUTER_CELL) + OUTER_LINES;
    const j = Math.round(z / OUTER_CELL) + OUTER_LINES;
    return lattice[j * ov + i];
  };
  for (let side = 0; side < 4; side++) {
    const vBase = positions.length / 3;
    // boundary loop vertices, sweep direction chosen per side for +Y winding
    for (let m = 0; m <= DENSE_CELLS; m++) {
      const t = (m - DENSE_CELLS / 2) * DENSE_CELL; // -224 .. +224
      if (side === 0) positions.push(DENSE_HALF, 0, t); // east:  z increasing
      else if (side === 1) positions.push(-t, 0, DENSE_HALF); // north: x decreasing
      else if (side === 2) positions.push(-DENSE_HALF, 0, -t); // west:  z decreasing
      else positions.push(t, 0, -DENSE_HALF); // south: x increasing
    }
    // coarse W vertices one cell out, matched to the sweep
    const w: number[] = [];
    for (let s = 0; s <= FAN_SEGS; s++) {
      const t = (s * FAN_SUB - DENSE_CELLS / 2) * DENSE_CELL;
      if (side === 0) w.push(latticeAt(DENSE_HALF + OUTER_CELL, t));
      else if (side === 1) w.push(latticeAt(-t, DENSE_HALF + OUTER_CELL));
      else if (side === 2) w.push(latticeAt(-DENSE_HALF - OUTER_CELL, -t));
      else w.push(latticeAt(t, -DENSE_HALF - OUTER_CELL));
    }
    for (let s = 0; s < FAN_SEGS; s++) {
      for (let m = s * FAN_SUB; m < (s + 1) * FAN_SUB; m++) {
        indices.push(w[s], vBase + m, vBase + m + 1);
      }
      indices.push(w[s], vBase + (s + 1) * FAN_SUB, w[s + 1]); // closing tri
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices); // >65k verts -> three picks Uint32 automatically
  return geo;
}

// ------------------------------------------------------------------ GLSL ----

const VERT = /* glsl */ `
uniform float uTime;

varying vec2 vOrigXZ; // undisplaced world XZ — source of truth for all shading
varying float vViewZ; // view-space Z of the displaced fragment (negative forward)
varying vec3 vWorldPos;

${WAVES_GLSL}

void main() {
  // grid-local vertex -> world XZ via the snapped mesh position
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 disp = gerstnerDisplace(wp.xyz, uTime);
  vOrigXZ = wp.xz;
  vWorldPos = disp;
  vec4 mv = viewMatrix * vec4(disp, 1.0);
  vViewZ = mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
#include <packing>

uniform float uTime;

// hull foam collar (prepass depth)
uniform sampler2D uDepthTex;
uniform vec2 uResolution;      // device pixels — gl_FragCoord space
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uRingBias;       // collar only emits this many meters in FRONT of the solid
uniform float uFoamRingWidth;  // depth-gap meters covered by contact band + chunk collar
uniform float uFoamRingOuter;  // sparse outer fleck band beyond the collar
uniform float uFoamRingBreak;  // chunk keep threshold (higher -> fewer chunks)
uniform float uRingChunk;      // collar chunk cell size (m) — a few chunks per hull
uniform float uFoamRingFps;    // chunk flicker rate (steps/sec)
uniform float uRingContact;    // gap meters of darkened contact water inside the collar
uniform float uRingContactShade; // brightness multiplier of the contact band
uniform float uRingMaxDist;    // collar only drawn inside this distance

// clean racing-water material
uniform float uMaxAmp;
uniform float uRippleStrength;
uniform float uRippleFadeStart;
uniform float uRippleFadeEnd;
uniform float uCrestHeight;
uniform float uCrestSlope;
uniform float uCrestRise;
uniform float uFoamStrength;
uniform float uSunGloss;
uniform float uSunStrength;
uniform float uGlintStrength;
uniform float uFresnelStrength;

// continuous distance fade into the horizon
uniform float uFogStart;
uniform float uFogFar;

// palette
uniform vec3 uColorDeep;
uniform vec3 uColorMid;
uniform vec3 uColorCrest;
uniform vec3 uColorFoam;
uniform vec3 uColorSparkle;
uniform vec3 uColorHorizon;
uniform vec3 uSunDir;

varying vec2 vOrigXZ;
varying float vViewZ;
varying vec3 vWorldPos;

${WAVES_GLSL}

// stable 2D -> 1D hash, used for every breakup/glitter cell
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Smooth value noise only breaks whitecap coverage into broad natural runs.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// d(waveHeight)/dt — >0 on the leading (down-wave) face of a traveling crest
float waveDerivT(vec2 p, float t) {
  float d = 0.0;
  for (int i = 0; i < NUM_WAVES; i++) {
    vec4 a = WAVE_A[i];
    vec4 b = WAVE_B[i];
    d += b.x * a.w * cos(a.z * dot(a.xy, p) + a.w * t + b.z);
  }
  return d;
}

void main() {
  // Analytic surface state at this pixel — tessellation-independent, so the
  // LOD seam can never show in the shading.
  float h = waveHeight(vOrigXZ, uTime);
  float vH = h / uMaxAmp;              // normalized crest height, ~[-1, 1]
  vec3 n = gerstnerNormal(vOrigXZ, uTime);
  float dist = -vViewZ;

  // Visual-only ripples modify the material normal near the camera. The
  // displacement and every CPU query continue to use the unchanged wave sum.
  float rippleFade = 1.0 - smoothstep(uRippleFadeStart, uRippleFadeEnd, dist);
  vec2 rippleSlope =
    vec2(0.82, 0.31) * cos(dot(vOrigXZ, vec2(0.82, 0.31)) * 1.65 + uTime * 1.7) +
    vec2(-0.27, 0.96) * cos(dot(vOrigXZ, vec2(-0.27, 0.96)) * 2.35 - uTime * 1.25) +
    vec2(0.56, -0.83) * cos(dot(vOrigXZ, vec2(0.56, -0.83)) * 3.75 + uTime * 2.15) * 0.42 +
    vec2(-0.94, -0.18) * cos(dot(vOrigXZ, vec2(-0.94, -0.18)) * 5.1 - uTime * 2.7) * 0.24;
  n = normalize(n + vec3(rippleSlope.x, 0.0, rippleSlope.y) * uRippleStrength * rippleFade);

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 sunDir = normalize(uSunDir);
  float ndl = clamp(dot(n, sunDir) * 0.5 + 0.5, 0.0, 1.0);
  float slope = clamp(1.0 - n.y, 0.0, 1.0);
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 2.2);

  // Directional material response replaces the old height-colored slabs.
  float faceLight = clamp(0.22 + ndl * 0.58 + slope * 0.34, 0.0, 1.0);
  vec3 col = mix(uColorDeep, uColorMid, faceLight);
  col = mix(col, uColorCrest, smoothstep(0.035, 0.22, slope) * 0.34);
  col = mix(col, uColorHorizon, fresnel * uFresnelStrength);

  // A broad sun response gives the surface scale without a field of blinking
  // symbols. Near ripples naturally split it into short moving highlights.
  vec3 halfDir = normalize(sunDir + viewDir);
  float sunSpec = pow(max(dot(n, halfDir), 0.0), uSunGloss) * uSunStrength;
  sunSpec *= 0.42 + 0.58 * rippleFade;
  col = mix(col, uColorSparkle, clamp(sunSpec, 0.0, 0.72));

  // Fine directional facets turn the broad response into short, moving glints.
  // Every term is continuous and derivative-filtered: no hash cells, symbols,
  // or temporal pixel noise. The immediate action lane and horizon stay quiet.
  vec2 fineSlope =
    vec2(0.97, 0.24) * cos(dot(vOrigXZ, vec2(0.97, 0.24)) * 7.3 + uTime * 3.2) +
    vec2(-0.48, 0.88) * cos(dot(vOrigXZ, vec2(-0.48, 0.88)) * 9.1 - uTime * 3.8) * 0.7;
  vec3 glintNormal = normalize(n + vec3(fineSlope.x, 0.0, fineSlope.y) * 0.024 * rippleFade);
  float glintSpec = pow(max(dot(glintNormal, halfDir), 0.0), uSunGloss * 1.65);
  float glintField = 0.5 + 0.31 * sin(dot(vOrigXZ, vec2(0.91, 0.27)) * 1.9 + uTime * 1.8) +
    0.19 * sin(dot(vOrigXZ, vec2(-0.34, 0.94)) * 3.1 - uTime * 2.25);
  float glintAa = max(fwidth(glintField) * 1.4, 0.012);
  float glintRuns = smoothstep(0.73 - glintAa, 0.73 + glintAa, glintField);
  float glintDistance = smoothstep(10.0, 34.0, dist) * (1.0 - smoothstep(230.0, 430.0, dist));
  float glint = glintSpec * glintRuns * glintDistance * uGlintStrength;
  col = mix(col, uColorSparkle, clamp(glint, 0.0, 0.46));

  // Whitecaps are gameplay information: only high, steep, rising faces earn
  // them. Broad noise breaks coverage without recoloring the rest of the sea.
  float dhdt = waveDerivT(vOrigXZ, uTime);
  float crest = smoothstep(uCrestHeight, uCrestHeight + 0.18, vH);
  float steep = smoothstep(uCrestSlope, uCrestSlope + 0.065, slope);
  float rising = smoothstep(uCrestRise, uCrestRise + 0.115, dhdt);
  float foamNoise = vnoise(vOrigXZ / 4.8 + vec2(uTime * 0.045, -uTime * 0.025));
  float foamBreak = smoothstep(0.38, 0.68, foamNoise);
  float whitecap = crest * steep * rising * foamBreak * uFoamStrength;
  whitecap = smoothstep(0.035, 0.46, whitecap) * 0.78;
  whitecap *= 1.0 - smoothstep(170.0, 340.0, dist);
  col = mix(col, uColorFoam, clamp(whitecap, 0.0, 0.9));

  // --- 5. hull/buoy foam collar: biased depth difference vs the prepass ---
  // For a visible ocean fragment, any ink solid at this pixel is BEHIND the
  // water surface (else the solid would own the pixel). gap > 0 is how far
  // the submerged solid sits below the surface. uRingBias pushes the solid
  // side a few centimeters deeper so pixels grazing the hull's lower edge
  // can never straddle the collar window — no z-fight teeth along the hull.
  // The collar is broken into chunky time-quantized arcs (a few per hull):
  // darkened contact water, foam chunks denser near the contact, sparse
  // outer flecks. Never a solid slab, never concentric rings.
  // NOTE: three.js render-target rows line up with gl_FragCoord — sample
  // UNFLIPPED. (A V-flip here mirrors the foam mask across the screen middle
  // and paints phantom foam sheets above every hull.)
  if (dist < uRingMaxDist) {
    vec2 suv = gl_FragCoord.xy / uResolution;
    float solidDepth = texture2D(uDepthTex, suv).x;
    float solidViewZ = perspectiveDepthToViewZ(solidDepth, uCameraNear, uCameraFar) - uRingBias;
    float gap = vViewZ - solidViewZ; // slant meters from surface to (biased) solid
    if (gap > 0.0 && gap < uRingContact) {
      col *= uRingContactShade; // darkened contact water seats the hull
    } else if (gap > 0.0 && gap < uFoamRingWidth) {
      // chunky arcs hugging the contact, denser toward the hull
      float tqR = floor(uTime * uFoamRingFps);
      float ch = hash12(floor(vOrigXZ / uRingChunk) + tqR * 0.317);
      float edgeF = (gap - uRingContact) / max(uFoamRingWidth - uRingContact, 1e-3);
      if (ch > uFoamRingBreak + edgeF * 0.15) col = uColorFoam;
    } else if (gap > 0.0 && gap < uFoamRingWidth + uFoamRingOuter) {
      // sparse outer flecks, same chunk grid, offset phase
      float tqR = floor(uTime * uFoamRingFps);
      float ch = hash12(floor(vOrigXZ / uRingChunk + 7.7) + tqR * 0.41);
      if (ch > 0.84) col = mix(col, uColorFoam, 0.85);
    }
  }

  // Continuous material collapse prevents a second graphic horizon band.
  float fog = smoothstep(uFogStart, uFogFar, dist);
  col = mix(col, uColorHorizon, fog);

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

// ------------------------------------------------------------------ class ----

export class Ocean {
  readonly object: THREE.Object3D;
  /** Every tunable, exposed for the screenshot tuning pass. */
  readonly uniforms: Record<string, THREE.IUniform>;

  private readonly mesh: THREE.Mesh;

  constructor(opts: { depthTexture: THREE.Texture; cameraNear: number; cameraFar: number }) {
    const sun = PALETTE.sunDir;
    const deepColor = new THREE.Color(PALETTE.waterDeep);
    const originalMidColor = new THREE.Color(PALETTE.waterMid);
    const midColor = originalMidColor.clone().lerp(deepColor, 0.25);
    const crestColor = new THREE.Color(PALETTE.waterCrest).lerp(originalMidColor, 0.42);
    this.uniforms = {
      uTime: { value: 0 },
      uDepthTex: { value: opts.depthTexture },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCameraNear: { value: opts.cameraNear },
      uCameraFar: { value: opts.cameraFar },

      uMaxAmp: { value: MAX_AMPLITUDE },
      uRippleStrength: { value: 0.056 },
      uRippleFadeStart: { value: 58.0 },
      uRippleFadeEnd: { value: 155.0 },
      uCrestHeight: { value: 0.24 },
      uCrestSlope: { value: 0.01 },
      uCrestRise: { value: 0.015 },
      uFoamStrength: { value: 0.9 },
      uSunGloss: { value: 34.0 },
      uSunStrength: { value: 0.4 },
      uGlintStrength: { value: 0.5 },
      uFresnelStrength: { value: 0.34 },

      uFoamRingWidth: { value: 1.6 },
      uFoamRingOuter: { value: 0.9 },
      uFoamRingBreak: { value: 0.4 },
      uRingChunk: { value: 0.9 },
      uRingBias: { value: 0.03 },
      uFoamRingFps: { value: 5.0 },
      uRingContact: { value: 0.35 },
      uRingContactShade: { value: 0.72 },
      uRingMaxDist: { value: 150.0 },

      uFogStart: { value: 210.0 },
      uFogFar: { value: 2800.0 },

      uColorDeep: { value: deepColor },
      uColorMid: { value: midColor },
      uColorCrest: { value: crestColor },
      uColorFoam: { value: new THREE.Color(PALETTE.foam) },
      uColorSparkle: { value: new THREE.Color(PALETTE.sparkle) },
      uColorHorizon: { value: new THREE.Color(PALETTE.skyHorizon) },
      uSunDir: { value: new THREE.Vector3(sun[0], sun[1], sun[2]).normalize() },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide, // stitch strip winding is verified, but stay bulletproof
      transparent: false,
      depthWrite: true,
    });

    this.mesh = new THREE.Mesh(buildOceanGeometry(), material);
    this.mesh.name = 'ocean';
    this.mesh.frustumCulled = false;
    this.object = this.mesh;
  }

  update(t: number, camPos: THREE.Vector3): void {
    this.uniforms.uTime.value = t;
    // Snap to the dense-cell world grid: vertices land on fixed world
    // positions forever, so the mesh follows the camera without swimming.
    const sx = Math.round(camPos.x / DENSE_CELL) * DENSE_CELL;
    const sz = Math.round(camPos.z / DENSE_CELL) * DENSE_CELL;
    this.mesh.position.set(sx, 0, sz);
  }

  setResolution(deviceW: number, deviceH: number): void {
    (this.uniforms.uResolution.value as THREE.Vector2).set(deviceW, deviceH);
  }
}
