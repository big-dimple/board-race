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
import { NIGHT_PALETTE } from '../core/nightPalette';
import type { TimeOfDay } from '../core/timeOfDay';
import type { RenderQualityMode } from '../core/stage';
import { WAVES_GLSL, MAX_AMPLITUDE } from './waves';
import { setToonTimeOfDay } from '../cel/toonMaterial';
import { setLighthouseTimeOfDay } from './lighthouse';

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
uniform float uSparkleDensity;
uniform float uSparkleTwinkle;
uniform float uGlintPathAniso;
uniform float uGlintCoreR;
uniform float uGlintHaloR;
uniform float uGlintHaloAmp;
uniform float uGlintMaxMix;
uniform float uGlintHaloAmp2;
uniform float uGlintSpikeLen;
uniform float uGlintSpikeAmp;
uniform float uPixelScale;
uniform float uFoamBreakup;
uniform float uFoamCellSize;
uniform float uFresnelStrength;
uniform float uFresnelMax;
uniform float uSunSlopeLight;

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
uniform vec3 uColorSunWarm;
uniform vec3 uSunDir;
uniform float uNightBlend;

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

// Sun glitter: hash-cell sparkles in rotated octaves. Each cell hosts one
// jittered point with its own twinkle phase and rate, so the field reads as
// irregular living fragments instead of a periodic dot grid. Cores are
// sharp, halos are a faint fake bloom, and everything stretches along the
// sun azimuth so distant sparkle merges into a continuous glitter lane
// rather than discrete patches. Per-octave pixel-footprint fades retire
// each cell size before it can alias. Material-only: displacement and
// buoyancy untouched.
float sparkleBand(float d, float inA, float inB, float outA, float outB) {
  return smoothstep(inA, inB, d) * (1.0 - smoothstep(outA, outB, d));
}

float sparkleCellVisible(float cellSize, float d) {
  float mPerPix = max(d * uPixelScale, 1e-4);
  return smoothstep(1.2, 2.5, cellSize / mPerPix);
}

vec2 sparkleOctave(vec2 p, float cellSize, float rot, float density,
                   float twSpeed, float seed, vec2 sunAz, float aniso,
                   float coreScale, float spikeScale, float pixW) {
  float cs = cos(rot);
  float sn = sin(rot);
  vec2 q = mat2(cs, -sn, sn, cs) * p / cellSize;
  vec2 id = floor(q);
  vec2 f = fract(q);
  float r1 = hash12(id + seed);
  float r2 = hash12(id + seed + 17.31);
  float r3 = hash12(id + seed + 41.77);
  float cycle = fract(r3 + uTime * uSparkleTwinkle * twSpeed * (0.6 + 0.8 * r2));
  float on = smoothstep(0.0, 0.06, cycle) *
    (1.0 - smoothstep(density, density + 0.06, cycle));
  // Per-cell flash shape: some cells breathe softly, others snap shut — one
  // shared burst curve across the whole field reads as mechanical. Exponents
  // stay near 2 so the field's total energy does not creep up.
  on = pow(on, 1.6 + 1.6 * r2);
  vec2 pt = vec2(r1, r2) * 0.56 + 0.22;
  vec2 d = (f - pt) * cellSize;
  vec2 perp = vec2(-sunAz.y, sunAz.x);
  vec2 sd = vec2(dot(d, sunAz), dot(d, perp));
  float r = length(vec2(sd.x, sd.y * aniso));
  float coreR = uGlintCoreR * coreScale;
  // Analytic pixel-footprint AA. Never fwidth() of the cell distance field:
  // quads straddling a cell border see a huge derivative and would paint
  // dashed lattice outlines around every fleck.
  float aa = pixW;
  // Peaked falloff (brightest at center, no flat disc plateau) so the core
  // reads as a point of light, not a solid circle.
  float core = 1.0 - smoothstep(0.0, coreR + aa, r);
  core = pow(core, 1.4);
  // Rotating four-point starburst: each fleck's cross turns slowly on its own
  // clock (per-cell direction and rate from the hash) and blooms as the flash
  // peaks — a breathing star, never a static plus-sign stamped on the water.
  float spikeRot = (r1 > 0.67 ? 0.7854 : (r1 > 0.33 ? 0.3927 : 0.0)) +
    uTime * (0.3 + 0.7 * r3) * (r2 > 0.5 ? 1.0 : -1.0);
  float src = cos(spikeRot);
  float srs = sin(spikeRot);
  vec2 sa = abs(mat2(src, -srs, srs, src) * sd);
  float spikeLen = uGlintSpikeLen * spikeScale * (0.3 + 0.7 * on);
  float spikeW = coreR * 0.28;
  float spikeAA = pixW;
  float spikeH = (1.0 - smoothstep(0.0, spikeLen, sa.x)) *
    (1.0 - smoothstep(spikeW * 0.4, spikeW + spikeAA, sa.y));
  float spikeV = (1.0 - smoothstep(0.0, spikeLen, sa.y)) *
    (1.0 - smoothstep(spikeW * 0.4, spikeW + spikeAA, sa.x));
  float spikes = min(spikeH + spikeV, 1.0) * smoothstep(0.2, 0.85, on) * uGlintSpikeAmp;
  float halo = 1.0 - smoothstep(0.0, uGlintHaloR * coreScale + aa, r);
  return vec2(max(core, spikes), halo * uGlintHaloAmp) * on;
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
  // Wind ripple gathers into drifting patches; uniform parallel stripes read
  // as printed texture once the sky reflection is strong enough to show them.
  // The floor stays high: a near-zero patch turns glassy and mirrors the
  // bright sky as a big soft blob at grazing angles.
  float ripplePatch = 0.72 +
    0.28 * sin(dot(vOrigXZ, vec2(0.21, -0.34)) + uTime * 0.23) *
           sin(dot(vOrigXZ, vec2(-0.17, 0.29)) - uTime * 0.19);
  vec3 n = normalize(physicalNormal + vec3(rippleSlope.x, 0.0, rippleSlope.y) *
    uRippleStrength * rippleFade * detail * ripplePatch);

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 sunDir = normalize(uSunDir);
  vec2 sunAz = normalize(uSunDir.xz);
  vec2 viewAz = normalize(vOrigXZ - cameraPosition.xz);
  float sunFace = clamp(dot(physicalNormal, sunDir) * 0.5 + 0.5, 0.0, 1.0);
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);

  // Directional relief: wave form reads from the BRIGHTNESS CONTRAST between
  // faces tilted toward the sun and faces turned away — not from slope
  // magnitude, which lights both sides equally and flattens the sea.
  // sunSlope is the signed surface slope along the sun azimuth: positive on
  // sun-facing wave faces, negative on the lee side.
  float sunSlope = -dot(gradient, sunAz);
  float faceLight = clamp(
    0.10 + sunFace * 0.30 + sunSlope * uSunSlopeLight + physicalSlope * 0.16 + vH * 0.10,
    0.0, 1.0);
  vec3 col = mix(uColorDeep, uColorMid, faceLight);
  // Lee-side self-shadowing approximation plus trough ambient occlusion.
  float lee = smoothstep(0.03, 0.24, -sunSlope);
  col *= 1.0 - lee * 0.24;
  float trough = 1.0 - smoothstep(-0.42, -0.04, vH);
  col *= 1.0 - trough * 0.24;
  float crestShoulder = smoothstep(0.02, 0.38, vH) * smoothstep(0.08, 0.24, physicalSlope);
  col = mix(col, uColorCrest, crestShoulder * 0.32);

  // Sky reflection: at grazing angles real water is a sky mirror. The
  // facet-by-facet alternation between deep body color and pale sky is what
  // carries wave structure into the distance. Reflection tints stay close to
  // the true sky colors — blue, never a broad white sun patch.
  vec3 reflected = reflect(-viewDir, n);
  float skyY = clamp(reflected.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 reflectionHorizon = mix(uColorMid, uColorHorizon, 0.72);
  vec3 reflectionMid = mix(uColorMid, uColorSkyMid, 0.62);
  vec3 reflectionZenith = mix(uColorDeep, uColorSkyZenith, 0.5);
  vec3 skyReflection = mix(reflectionHorizon, reflectionMid, smoothstep(0.12, 0.62, skyY));
  skyReflection = mix(skyReflection, reflectionZenith, smoothstep(0.62, 1.0, skyY));
  // Sun lane: the reflected sky warms toward the low sun azimuth, anchoring a
  // broad stable reflection path that matches the sky dome's warm haze.
  // View-azimuth driven only — never modulated by wave normals — so it can
  // never crawl as a slow white patch over the swell.
  float sunLane = smoothstep(0.0, 0.8, dot(viewAz, sunAz));
  skyReflection = mix(skyReflection, uColorSunWarm, sunLane * 0.72);
  // The lane is a grazing-angle mirror path: it must also OPEN the
  // reflection, not just tint it, or the warm sky stays diluted under the
  // dark body color and never reads as a sun path.
  float reflectionAmount = clamp(
    0.03 + fresnel * uFresnelStrength + physicalSlope * 0.02 +
    sunLane * 0.3 * (0.3 + fresnel), 0.03, max(uFresnelMax, 0.8));
  col = mix(col, skyReflection, reflectionAmount);

  // Sun glitter stacks four sparkle octaves with different scales and
  // speeds under the Blinn envelope of the physical+ripple normal, so
  // flecks gather and disperse fast on sun-facing micro-slopes. A view
  // lane toward the sun boosts density into a glitter path; the wave
  // crest bias lets larger soft glints favor crests.
  vec3 halfDir = normalize(sunDir + viewDir);
  // Glitter lives in a lane toward the sun. Off-lane sparkle is nearly shut:
  // a full-frame scatter of flashes reads as flat "starfield texture" and
  // actively erases wave relief.
  float pathBoost = mix(0.08, 1.6, smoothstep(0.1, 0.85, dot(viewAz, sunAz)));
  // Starburst spikes: small rotating stars once past the immediate foreground;
  // at point-blank range they stay round pinpoints.
  float spikeFar = smoothstep(6.0, 26.0, dist);
  // Round pinpoints up close; elongation grows only with distance so the far
  // field merges into a glitter lane while near fragments stay point-like.
  float aniso = mix(1.05, uGlintPathAniso * 2.6, smoothstep(40.0, 280.0, dist));
  float crestBias = mix(0.7, 1.15, smoothstep(0.0, 0.35, vH));
  float pixW = max(dist * uPixelScale * 1.4, 0.015);
  vec2 sp =
    sparkleOctave(vOrigXZ, 7.5, 0.21, uSparkleDensity * 0.5, 0.5, 0.0, sunAz, aniso, 1.8, 1.6 * spikeFar, pixW) *
      sparkleBand(dist, 60.0, 140.0, 420.0, 900.0) +
    sparkleOctave(vOrigXZ, 2.3, 0.94, uSparkleDensity * 0.8, 1.0, 3.7, sunAz, aniso, 1.2, 1.1 * spikeFar, pixW) *
      (sparkleBand(dist, 12.0, 30.0, 140.0, 320.0) * sparkleCellVisible(2.3, dist));
#if OCEAN_FINE_DETAIL == 1
  // Near octaves: smaller cores, sparser cells, slower clocks. The countdown
  // holds the camera still at point-blank range, where big fast uniform dots
  // read as a starfield sticker instead of sun glitter.
  sp += sparkleOctave(vOrigXZ, 0.75, 1.62, uSparkleDensity * 0.55, 1.2, 9.1, sunAz, aniso, 0.62, 1.0 * spikeFar, pixW) *
    (sparkleBand(dist, 2.5, 8.0, 45.0, 110.0) * sparkleCellVisible(0.75, dist));
#endif
#if OCEAN_GLINT_MICRO == 1
  sp += sparkleOctave(vOrigXZ, 0.30, 2.35, uSparkleDensity * 0.6, 1.6, 15.3, sunAz, aniso, 0.55, 0.85 * spikeFar, pixW) *
    (sparkleBand(dist, 1.2, 4.0, 18.0, 48.0) * sparkleCellVisible(0.30, dist));
#endif
  // Wider Blinn lobe up close so near fragments can burst bright instead of
  // being gated out by micro-normal alignment; far field keeps the tight
  // lobe so sparkle still rides sun-facing slopes.
  float gloss = mix(uGlintGloss * 0.45, uGlintGloss, smoothstep(8.0, 60.0, dist));
  float glintEnvelope = pow(max(dot(n, halfDir), 0.0), gloss);
  float glintGate = glintEnvelope * pathBoost * crestBias * uGlintStrength;
  float spCore = min(sp.x * 1.5, 1.0) * glintGate;
  float spHalo = min(sp.y, 1.0) * glintGate;
  col = mix(col, uColorSparkle, clamp(spCore, 0.0, uGlintMaxMix));
  col += uColorSparkle * spHalo * uGlintHaloAmp2;

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
  // Mid-range fragmentation: hash cells break the low-frequency foam field
  // into smaller patches so distant whitecaps stop reading as flat scraps.
  float foamMidBand = smoothstep(30.0, 60.0, dist) * (1.0 - smoothstep(190.0, 390.0, dist));
  float foamCell = hash12(floor(vOrigXZ / uFoamCellSize));
  foamBreak *= mix(1.0, smoothstep(0.35, 0.75, foamCell), foamMidBand * uFoamBreakup);
  float detailLo = mix(0.48, 0.55, foamMidBand * uFoamBreakup);
  float detailHi = mix(0.69, 0.78, foamMidBand * uFoamBreakup);
  foamBreak *= smoothstep(detailLo - detailAa, detailHi + detailAa, foamDetail);
  float whitecap = crest * steep * rising * convex * foamBreak * uFoamStrength *
    (1.0 + uOpeningArt * 0.1);
  whitecap = smoothstep(0.012, 0.14, whitecap) * 0.78;
  whitecap *= 1.0 - smoothstep(190.0, 390.0, dist);
  vec3 foamColor = uColorFoam;
  // Bioluminescent cyan-blue tint on wave crests at night
  foamColor = mix(foamColor, vec3(0.35, 0.96, 0.88), uNightBlend * 0.5);
  col = mix(col, foamColor, clamp(whitecap, 0.0, 0.9));
  // Subtle self-luminous emission on night whitecaps
  col += vec3(0.10, 0.75, 0.70) * (whitecap * uNightBlend * 0.38);

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
      if (ch > uFoamRingBreak + edgeF * 0.15) {
        vec3 hullFoam = mix(uColorFoam, vec3(0.38, 1.0, 0.92), uNightBlend * 0.7);
        col = hullFoam;
        col += vec3(0.15, 0.88, 0.82) * (uNightBlend * 0.45);
      }
    } else if (gap > 0.0 && gap < uFoamRingWidth + uFoamRingOuter) {
      // sparse outer flecks, same chunk grid, offset phase
      float tqR = floor(uTime * uFoamRingFps);
      float ch = hash12(floor(vOrigXZ / uRingChunk + 7.7) + tqR * 0.41);
      if (ch > 0.84) {
        vec3 fleckCol = mix(col, uColorFoam, 0.85);
        fleckCol += vec3(0.12, 0.78, 0.74) * (uNightBlend * 0.35);
        col = fleckCol;
      }
    }
  }

  // Continuous material collapse prevents a second graphic horizon band.
  // The fog tint warms toward the sun azimuth so the sea horizon meets the
  // sky dome's warm haze without a value seam.
  float fog = smoothstep(uFogStart, uFogFar, dist);
  vec3 fogTint = mix(uColorHorizon, uColorSunWarm, sunLane * 0.55);
  col = mix(col, fogTint, fog);

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

  private readonly dayDeep = new THREE.Color(PALETTE.waterDeep);
  private readonly dayMid = new THREE.Color(PALETTE.waterMid).lerp(new THREE.Color(PALETTE.waterDeep), 0.4);
  private readonly dayCrest = new THREE.Color(PALETTE.waterCrest).lerp(new THREE.Color(PALETTE.waterMid), 0.65);
  private readonly dayFoam = new THREE.Color(PALETTE.foam);
  private readonly daySparkle = new THREE.Color(PALETTE.sparkle);
  private readonly dayHorizon = new THREE.Color(PALETTE.skyHorizon);
  private readonly daySkyMid = new THREE.Color(PALETTE.skyMid);
  private readonly daySkyZenith = new THREE.Color(PALETTE.skyZenith);
  private readonly daySunWarm = new THREE.Color(1.0, 0.88, 0.62);
  private readonly daySunDir = new THREE.Vector3(PALETTE.sunDir[0], PALETTE.sunDir[1], PALETTE.sunDir[2]).normalize();

  private readonly nightDeep = new THREE.Color(NIGHT_PALETTE.waterDeep);
  private readonly nightMid = new THREE.Color(NIGHT_PALETTE.waterMid);
  private readonly nightCrest = new THREE.Color(NIGHT_PALETTE.waterCrest);
  private readonly nightFoam = new THREE.Color(NIGHT_PALETTE.foam);
  private readonly nightSparkle = new THREE.Color(NIGHT_PALETTE.sparkle);
  private readonly nightHorizon = new THREE.Color(NIGHT_PALETTE.skyHorizon);
  private readonly nightSkyMid = new THREE.Color(NIGHT_PALETTE.skyMid);
  private readonly nightSkyZenith = new THREE.Color(NIGHT_PALETTE.skyZenith);
  private readonly nightSunWarm = new THREE.Color(NIGHT_PALETTE.sunWarm);
  private readonly nightSunDir = new THREE.Vector3(NIGHT_PALETTE.moonDir[0], NIGHT_PALETTE.moonDir[1], NIGHT_PALETTE.moonDir[2]).normalize();

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
      uSparkleDensity: { value: performance ? 0.07 : high ? 0.18 : 0.13 },
      uSparkleTwinkle: { value: 0.55 },
      uGlintPathAniso: { value: performance ? 1.6 : high ? 2.0 : 1.8 },
      uGlintCoreR: { value: performance ? 0.1 : high ? 0.08 : 0.09 },
      uGlintHaloR: { value: performance ? 0.24 : high ? 0.2 : 0.22 },
      uGlintHaloAmp: { value: performance ? 0.3 : high ? 0.5 : 0.4 },
      uGlintMaxMix: { value: performance ? 0.62 : high ? 0.95 : 0.8 },
      uGlintHaloAmp2: { value: performance ? 0.08 : high ? 0.2 : 0.14 },
      uGlintSpikeLen: { value: 0.3 },
      uGlintSpikeAmp: { value: 0.9 },
      uPixelScale: { value: 0.0013 },
      uFoamBreakup: { value: performance ? 0.0 : high ? 0.65 : 0.5 },
      uFoamCellSize: { value: 3.5 },
      uFresnelStrength: { value: 0.45 },
      uFresnelMax: { value: 0.5 },
      uSunSlopeLight: { value: 1.5 },

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
      // Warm cream sun-path tint — a touch warmer than the sky dome's horizon
      // wash so the water lane reads as the accent, never green over cyan.
      uColorSunWarm: { value: new THREE.Color(1.0, 0.88, 0.62) },
      uSunDir: { value: new THREE.Vector3(sun[0], sun[1], sun[2]).normalize() },
      uNightBlend: { value: 0.0 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: {
        OCEAN_FINE_DETAIL: performance ? 0 : 1,
        OCEAN_GLINT_MICRO: high ? 1 : 0,
      },
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

  setResolution(deviceW: number, deviceH: number, fovYDegrees?: number): void {
    (this.uniforms.uResolution.value as THREE.Vector2).set(deviceW, deviceH);
    if (fovYDegrees && deviceH > 0) {
      // meters per pixel at 1 m distance — drives per-octave cell retirement
      this.uniforms.uPixelScale.value =
        (2 * Math.tan((fovYDegrees * Math.PI) / 360)) / deviceH;
    }
  }

  setTimeOfDay(tod: TimeOfDay, blend?: number): void {
    const b = blend !== undefined ? blend : tod === 'night' ? 1.0 : 0.0;
    const clamped = Math.max(0, Math.min(1, b));

    (this.uniforms.uNightBlend.value as number) = clamped;
    (this.uniforms.uColorDeep.value as THREE.Color).lerpColors(this.dayDeep, this.nightDeep, clamped);
    (this.uniforms.uColorMid.value as THREE.Color).lerpColors(this.dayMid, this.nightMid, clamped);
    (this.uniforms.uColorCrest.value as THREE.Color).lerpColors(this.dayCrest, this.nightCrest, clamped);
    (this.uniforms.uColorFoam.value as THREE.Color).lerpColors(this.dayFoam, this.nightFoam, clamped);
    (this.uniforms.uColorSparkle.value as THREE.Color).lerpColors(this.daySparkle, this.nightSparkle, clamped);
    (this.uniforms.uColorHorizon.value as THREE.Color).lerpColors(this.dayHorizon, this.nightHorizon, clamped);
    (this.uniforms.uColorSkyMid.value as THREE.Color).lerpColors(this.daySkyMid, this.nightSkyMid, clamped);
    (this.uniforms.uColorSkyZenith.value as THREE.Color).lerpColors(this.daySkyZenith, this.nightSkyZenith, clamped);
    (this.uniforms.uColorSunWarm.value as THREE.Color).lerpColors(this.daySunWarm, this.nightSunWarm, clamped);
    (this.uniforms.uSunDir.value as THREE.Vector3).lerpVectors(this.daySunDir, this.nightSunDir, clamped).normalize();

    setToonTimeOfDay(tod, clamped);
    setLighthouseTimeOfDay(tod, clamped);
  }

  setOpeningIntensity(value: number): void {
    this.uniforms.uOpeningArt.value = Math.max(0, Math.min(1, value));
  }
}
