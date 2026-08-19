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
 *    1.4 m world grid so vertices never swim. The exact second-order height
 *    field from waves.ts drives both rendering and physical sampling.
 *  - Two LOD rings in ONE BufferGeometry / one draw call:
 *      dense center 320x320 quads @ 1.4 m (448 m across)
 *      coarse outer lattice @ 56 m, reaching 3976 m (~horizon)
 *    The outer lattice has a square hole exactly on the dense grid's edge;
 *    a fan "stitch strip" bridges the 1.4 m / 56 m tessellation mismatch
 *    with bit-identical shared world positions, so there is no crack and
 *    no z-fighting overlap (strictly cleaner than raw overlap).
 *  - Near geometry and shading use the complete physical spectrum. Shorter
 *    bands fade continuously outside the dense field so the 56 m horizon
 *    lattice cannot alias them; the 128 m swell remains in silhouette.
 *  - Analytic height, gradient, vertical velocity, and curvature drive the
 *    material. Small visual-only ripples affect close normal detail, never the
 *    broad wave form, buoyancy, or collision.
 *  - Whitecaps require a high, steep, rising, convex physical crest. A
 *    continuous directional field only breaks that eligible crest into runs.
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
import type { RenderQualityMode } from '../core/stage';
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
uniform float uOpeningArt;

varying vec2 vOrigXZ; // undisplaced world XZ — source of truth for all shading
varying float vViewZ; // view-space Z of the displaced fragment (negative forward)
varying vec3 vWorldPos;

${WAVES_GLSL}

void main() {
  // grid-local vertex -> world XZ via the snapped mesh position
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float detail = 1.0 - smoothstep(200.0, 360.0, length(wp.xz - cameraPosition.xz));
  vec3 disp = waveDisplaceLod(wp.xyz, uTime, detail);
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
uniform float uOpeningArt;

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
uniform float uWhitecapHeight;
uniform float uWhitecapSlope;
uniform float uWhitecapRise;
uniform float uWhitecapCurvature;
uniform float uFoamStrength;
uniform float uGlintGloss;
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
uniform vec3 uColorSkyMid;
uniform vec3 uColorSkyZenith;
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

void main() {
  float dist = -vViewZ;
  float worldDistance = length(vOrigXZ - cameraPosition.xz);
  float detail = 1.0 - smoothstep(200.0, 360.0, worldDistance);
  float h;
  vec2 gradient;
  float verticalVelocity;
  float curvature;
  waveSurfaceState(vOrigXZ, uTime, detail, h, gradient, verticalVelocity, curvature);
  vec3 physicalNormal = normalize(vec3(-gradient.x, 1.0, -gradient.y));
  float physicalSlope = length(gradient);
  float vH = h / uMaxAmp;

  // Close wind texture is subordinate to the physical silhouette and fades
  // before it can turn into distant shimmer.
  float rippleFade = 1.0 - smoothstep(uRippleFadeStart, uRippleFadeEnd, dist);
  vec2 windDir = normalize(vec2(0.94, 0.34));
  vec2 crossWind = vec2(-windDir.y, windDir.x);
  vec2 rippleSlope =
    windDir * cos(dot(vOrigXZ, windDir) * 2.15 + uTime * 2.5) * 0.62 +
    crossWind * cos(dot(vOrigXZ, crossWind) * 3.45 - uTime * 3.2) * 0.38;
  vec3 n = normalize(physicalNormal + vec3(rippleSlope.x, 0.0, rippleSlope.y) *
    uRippleStrength * rippleFade * detail);

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 sunDir = normalize(uSunDir);
  float sunFace = clamp(dot(physicalNormal, sunDir) * 0.5 + 0.5, 0.0, 1.0);
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);

  // Deep water body color, then a view-dependent reflection of the existing
  // procedural sky. The reflected direction creates broad facets without a
  // painted white patch or a second water layer.
  float faceLight = clamp(0.08 + sunFace * 0.46 + physicalSlope * 0.72 + vH * 0.12, 0.0, 1.0);
  vec3 col = mix(uColorDeep, uColorMid, faceLight);
  float trough = 1.0 - smoothstep(-0.42, -0.04, vH);
  col *= 1.0 - trough * 0.22;
  float crestShoulder = smoothstep(0.02, 0.38, vH) * smoothstep(0.08, 0.24, physicalSlope);
  col = mix(col, uColorCrest, crestShoulder * 0.32);

  vec3 reflected = reflect(-viewDir, n);
  float skyY = clamp(reflected.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 reflectionHorizon = mix(uColorMid, uColorHorizon, 0.18);
  vec3 reflectionMid = mix(uColorMid, uColorSkyMid, 0.34);
  vec3 reflectionZenith = mix(uColorDeep, uColorSkyZenith, 0.38);
  vec3 skyReflection = mix(reflectionHorizon, reflectionMid, smoothstep(0.12, 0.62, skyY));
  skyReflection = mix(skyReflection, reflectionZenith, smoothstep(0.62, 1.0, skyY));
  float reflectionAmount = clamp(0.025 + fresnel * uFresnelStrength + physicalSlope * 0.018, 0.025, 0.22);
  col = mix(col, skyReflection, reflectionAmount);

  // Sun glitter comes from fast, short micro-facets, not a broad white lobe
  // travelling at the period of the dominant swell. These visual-only slopes
  // leave displacement and buoyancy untouched, while derivative filtering
  // keeps the tiny highlights stable as they recede from the camera.
  vec3 halfDir = normalize(sunDir + viewDir);
  vec2 diagonalWind = normalize(windDir + crossWind * 0.73);
  vec2 opposingWind = normalize(windDir - crossWind * 0.61);
  float glintWarpA =
    sin(dot(vOrigXZ, diagonalWind) * 0.71 - uTime * 2.1) * 0.82 +
    sin(dot(vOrigXZ, opposingWind) * 1.13 + uTime * 2.8) * 0.31;
  float glintWarpB =
    sin(dot(vOrigXZ, opposingWind) * 0.89 + uTime * 1.8) * 0.76 +
    sin(dot(vOrigXZ, diagonalWind) * 1.47 - uTime * 2.4) * 0.27;
  float glintWaveA = 0.5 + 0.5 * sin(
    dot(vOrigXZ, windDir) * 3.4 + uTime * 11.0 + glintWarpA);
  float glintWaveB = 0.5 + 0.5 * sin(
    dot(vOrigXZ, crossWind) * 6.8 - uTime * 15.2 + glintWarpB);
  float glintAaA = max(fwidth(glintWaveA) * 1.35, 0.014);
  float glintAaB = max(fwidth(glintWaveB) * 1.35, 0.014);
  float glintFlecks =
    smoothstep(0.78 - glintAaA, 0.94 + glintAaA, glintWaveA) *
    smoothstep(0.74 - glintAaB, 0.92 + glintAaB, glintWaveB);
#if OCEAN_FINE_DETAIL == 1
  float glintWaveC = 0.5 + 0.5 * sin(
    dot(vOrigXZ, diagonalWind) * 10.2 + uTime * 18.4 + glintWarpA * 1.4 - glintWarpB * 0.8);
  float glintAaC = max(fwidth(glintWaveC) * 1.35, 0.014);
  float glintDetail = smoothstep(0.7 - glintAaC, 0.9 + glintAaC, glintWaveC);
  glintFlecks *= mix(0.18, 1.0, glintDetail);
#endif
  float glintDistance = smoothstep(10.0, 28.0, dist) * (1.0 - smoothstep(340.0, 660.0, dist));
  float glintEnvelope = pow(max(dot(n, halfDir), 0.0), uGlintGloss);
  float glint = glintEnvelope * glintFlecks * glintDistance * uGlintStrength *
    (1.0 + uOpeningArt * 0.12);
  col = mix(col, uColorSparkle, clamp(glint, 0.0, 0.58));

  float crest = smoothstep(uWhitecapHeight, uWhitecapHeight + 0.68, h);
  float steep = smoothstep(uWhitecapSlope, uWhitecapSlope + 0.1, physicalSlope);
  float rising = smoothstep(uWhitecapRise, uWhitecapRise + 0.64, verticalVelocity);
  float convex = smoothstep(uWhitecapCurvature, uWhitecapCurvature + 0.05, -curvature);
  float foamField = 0.5 +
    0.28 * sin(dot(vOrigXZ, windDir) * 0.24 + uTime * 0.36) +
    0.2 * sin(dot(vOrigXZ, crossWind) * 0.43 - uTime * 0.29);
  float foamAa = max(fwidth(foamField) * 1.3, 0.012);
  float foamBreak = smoothstep(0.5 - foamAa, 0.72 + foamAa, foamField);
  float foamDetail = 0.5 +
    0.27 * sin(dot(vOrigXZ, crossWind) * 0.92 + uTime * 0.63) +
    0.22 * sin(dot(vOrigXZ, windDir) * 1.26 - uTime * 0.48);
  float detailAa = max(fwidth(foamDetail) * 1.25, 0.016);
  foamBreak *= smoothstep(0.48 - detailAa, 0.69 + detailAa, foamDetail);
  float whitecap = crest * steep * rising * convex * foamBreak * uFoamStrength *
    (1.0 + uOpeningArt * 0.1);
  whitecap = smoothstep(0.012, 0.14, whitecap) * 0.78;
  whitecap *= 1.0 - smoothstep(190.0, 390.0, dist);
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

  constructor(opts: {
    depthTexture: THREE.Texture;
    cameraNear: number;
    cameraFar: number;
    quality?: RenderQualityMode;
  }) {
    const quality = opts.quality ?? 'auto';
    const performance = quality === 'performance';
    const high = quality === 'high';
    const sun = PALETTE.sunDir;
    const deepColor = new THREE.Color(PALETTE.waterDeep);
    const originalMidColor = new THREE.Color(PALETTE.waterMid);
    const midColor = originalMidColor.clone().lerp(deepColor, 0.4);
    const crestColor = new THREE.Color(PALETTE.waterCrest).lerp(originalMidColor, 0.65);
    this.uniforms = {
      uTime: { value: 0 },
      uOpeningArt: { value: 0 },
      uDepthTex: { value: opts.depthTexture },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCameraNear: { value: opts.cameraNear },
      uCameraFar: { value: opts.cameraFar },

      uMaxAmp: { value: MAX_AMPLITUDE },
      uRippleStrength: { value: performance ? 0.045 : high ? 0.078 : 0.065 },
      uRippleFadeStart: { value: 72.0 },
      uRippleFadeEnd: { value: performance ? 145.0 : high ? 240.0 : 205.0 },
      uWhitecapHeight: { value: 0.2 },
      uWhitecapSlope: { value: 0.11 },
      uWhitecapRise: { value: -0.18 },
      uWhitecapCurvature: { value: -0.002 },
      uFoamStrength: { value: performance ? 0.82 : high ? 1.04 : 0.96 },
      uGlintGloss: { value: performance ? 18.0 : high ? 24.0 : 21.0 },
      uGlintStrength: { value: performance ? 1.35 : high ? 2.0 : 1.7 },
      uFresnelStrength: { value: 0.22 },

      uFoamRingWidth: { value: 1.6 },
      uFoamRingOuter: { value: 0.9 },
      uFoamRingBreak: { value: 0.4 },
      uRingChunk: { value: 0.9 },
      uRingBias: { value: 0.03 },
      uFoamRingFps: { value: 5.0 },
      uRingContact: { value: 0.35 },
      uRingContactShade: { value: 0.72 },
      uRingMaxDist: { value: 150.0 },

      uFogStart: { value: 300.0 },
      uFogFar: { value: 2800.0 },

      uColorDeep: { value: deepColor },
      uColorMid: { value: midColor },
      uColorCrest: { value: crestColor },
      uColorFoam: { value: new THREE.Color(PALETTE.foam) },
      uColorSparkle: { value: new THREE.Color(PALETTE.sparkle) },
      uColorHorizon: { value: new THREE.Color(PALETTE.skyHorizon) },
      uColorSkyMid: { value: new THREE.Color(PALETTE.skyMid) },
      uColorSkyZenith: { value: new THREE.Color(PALETTE.skyZenith) },
      uSunDir: { value: new THREE.Vector3(sun[0], sun[1], sun[2]).normalize() },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: { OCEAN_FINE_DETAIL: performance ? 0 : 1 },
      side: THREE.FrontSide,
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

  setOpeningIntensity(value: number): void {
    this.uniforms.uOpeningArt.value = Math.max(0, Math.min(1, value));
  }
}
