/**
 * ocean.ts — infinite cel-shaded open ocean. The star of the show.
 *
 * Art target: an outlined arcade ocean with broad, softened color bands,
 * restrained graphic foam, and sparse quantized glitter. The surface stays
 * stylized without letting its cel treatment overpower racers and technique.
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
 *  - All fragment shading (height bands, foam, glitter, fog) is computed
 *    per-pixel from the analytic wave field on the UNDISPLACED world XZ.
 *    On the dense grid vH computed this way is mathematically identical to
 *    displacedY / MAX_AMPLITUDE (the Gerstner Y term IS waveHeight(origXZ)),
 *    and on the coarse ring it stays alias-free. Shading can never diverge
 *    at the LOD boundary.
 *  - Band thresholds are domain-warped by THREE value-noise octaves
 *    (~64 m / 11 m / 5 m) so silhouettes read as chopped swell at BOTH the
 *    macro and the local scale, never as smooth bezier tongues. A narrow
 *    blend around each threshold removes the old posterized slabs.
 *  - Deep-band richness: one slightly lighter deep tone laid in as long
 *    hard-edged DIAGONAL streak bands (dash-segmented, slow drift) plus
 *    sparse BIG glints — the largest area of frame is never a dead void.
 *  - Crest foam caps: 2–3 chunky scallop ARCS per crest contour (whole arcs
 *    flip on/off in time steps), hugging the DOWN-WAVE edge of the crest
 *    band (dh/dt > 0), sized in meters by distance-to-band-edge
 *    (vHw / |grad|), with 1–2 interior negative-space cuts per arc. No
 *    parallelogram slabs, no high-frequency fingerprint breakup.
 *  - Sun-glitter lane: plus/diamond glints in 3 discrete cell sizes,
 *    clustered into a hard band around the sun azimuth (sparse outside),
 *    blinking in hard time steps.
 *  - Distance collapse: warp / tone patches / caps / streaks / glitter all
 *    fade CONTRAST to zero in hard steps (120 m / 250 m, warp 350 m) so the
 *    fog bands own the horizon — no far-field speckle shimmer.
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

${WAVES_GLSL}

void main() {
  // grid-local vertex -> world XZ via the snapped mesh position
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 disp = gerstnerDisplace(wp.xyz, uTime);
  vOrigXZ = wp.xz;
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

// cel height bands
uniform float uMaxAmp;
uniform float uBandDeep;       // vH below -> deep
uniform float uBandCrest;      // vH above -> crest (between -> mid)
uniform float uBandBlend;      // half-width of the softened band transition
uniform float uPatchScale;     // meters per ink-tone patch
uniform float uPatchStrength;  // 0..1 hard two-tone variation inside a band

// band domain warp — chops band silhouettes into swell shapes (hard edges stay)
uniform float uWarpAmp;      // vH units of threshold warp
uniform float uWarpScaleA;   // meters, mid octave (~swell chop)
uniform float uWarpScaleB;   // meters, high octave
uniform float uWarpScaleC;   // meters, MACRO octave (4-8x A) — big silhouettes chop too
uniform float uWarpFade;     // warp fully gone beyond this distance

// deep-band richness — long hard-edged diagonal streak bands, low contrast
uniform float uDeepStreakScale;    // wavelength across the streaks (m)
uniform float uDeepStreakDuty;     // lit fraction of each wavelength
uniform float uDeepStreakStrength; // brightness lift of the lit streak (subtle)
uniform float uDeepStreakDrift;    // slow slide speed (m/s)

// crest foam caps — 2-3 chunky scallop arcs on the DOWN-WAVE edge of crests
uniform float uCrestCapW;    // cap strip width in METERS along the surface
uniform float uCapScallop;   // scallop lobe frequency along the crest contour (1/m)
uniform float uCapArcLen;    // meters per arc segment along the contour
uniform float uCapArcCut;    // whole-arc keep threshold (arcs flip on/off)
uniform float uCapFps;       // arc flip rate (steps/sec)
uniform float uCapRiseGate;  // dh/dt gate: only the rising (down-wave) face foams

// sun-glitter lane — plus/diamond glints, 3 discrete sizes, hard blinks
uniform float uGlintFps;     // blink rate (steps/sec)
uniform float uGlintLaneCos; // core lane: cos of the half-angle around the sun azimuth
uniform float uGlintLaneSoft;// penumbra lane cos (reduced density)
uniform float uGlintDensIn;  // cell density inside the lane
uniform float uGlintDensOut; // sparse density outside the lane
uniform float uGlintSizeA;   // small diamond cell (m), crest-gated
uniform float uGlintSizeB;   // medium plus cell (m)
uniform float uGlintSizeC;   // BIG diamond cell (m) — sparse, also livens the deep band
uniform float uGlintCrest;   // vHw gate, small class only
uniform float uGlintFadeA;   // contrast steps: full inside / half / gone outside
uniform float uGlintFadeB;

// detail collapse — past these distances the surface flattens to pure bands
uniform float uDetailFadeA;  // caps/patches/streaks full inside
uniform float uDetailFadeB;  // caps/patches/streaks gone outside

// distance fog — hard bands toward the horizon color
uniform float uFogStart;
uniform float uFogMid;
uniform float uFogFar;
uniform float uFogMidMix;
uniform float uFogFarMix;

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

${WAVES_GLSL}

// stable 2D -> 1D hash, used for every breakup/glitter cell
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// smooth value noise — used ONLY to wobble thresholds; visible edges stay hard
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

  // detail collapse: far water must flatten into the flat fog bands, so every
  // high-frequency feature (warp octaves A/B, tone patches, caps, streaks,
  // glitter) fades contrast to zero in hard steps instead of shimmering.
  float warpKeep = dist < 150.0 ? 1.0 : (dist < uWarpFade ? 0.5 : 0.0);
  float detail = dist < uDetailFadeA ? 1.0 : (dist < uDetailFadeB ? 0.5 : 0.0);

  // --- 1. broad color bands, domain-warped with narrow soft transitions ---
  // Three noise octaves wobble the band thresholds: the 64 m macro octave
  // chops the big silhouettes, the 11 m / 5 m octaves chop the local edges.
  float warp = (vnoise(vOrigXZ / uWarpScaleA) - 0.5) * uWarpAmp * warpKeep
             + (vnoise(vOrigXZ / uWarpScaleB + 19.7) - 0.5) * uWarpAmp * 0.55 * (warpKeep > 0.5 ? 1.0 : 0.0)
             + (vnoise(vOrigXZ / uWarpScaleC + 7.3) - 0.5) * uWarpAmp * 1.25 * (warpKeep > 0.0 ? 1.0 : 0.0);
  float vHw = vH + warp;

  float deepToMid = smoothstep(uBandDeep - uBandBlend, uBandDeep + uBandBlend, vHw);
  float midToCrest = smoothstep(uBandCrest - uBandBlend, uBandCrest + uBandBlend, vHw);
  vec3 col = mix(uColorDeep, uColorMid, deepToMid);
  col = mix(col, uColorCrest, midToCrest);
  // per-band ink richness: two hard tone patches, never a gradient
  float tonePatch = hash12(floor(vOrigXZ / uPatchScale));
  float patchStrength = uPatchStrength * detail;
  col *= 1.0 - patchStrength + 2.0 * patchStrength * step(0.5, tonePatch);

  // --- 2. deep-band interior: diagonal streak bands, hard-edged, subtle ---
  // One slightly lighter deep tone in long dash-segmented diagonal bands so
  // the largest area of frame always has graphic content. Straight edges are
  // intentional — the warped band silhouette chops them organically.
  if (vHw <= uBandDeep && detail > 0.0) {
    vec2 dg = vec2(vOrigXZ.x + vOrigXZ.y, vOrigXZ.x - vOrigXZ.y) * 0.7071;
    float bandPos = (dg.x + uTime * uDeepStreakDrift) / uDeepStreakScale;
    float bandRow = floor(bandPos);
    float lit = step(fract(bandPos), uDeepStreakDuty);
    // long dash gaps along each streak, offset per row so gaps never align
    float dashPos = dg.y / (uDeepStreakScale * 1.9) + bandRow * 0.37;
    lit *= step(fract(dashPos), 0.62);
    col *= 1.0 + uDeepStreakStrength * lit * detail;
  }

  // --- 3. crest foam caps: 2-3 chunky scallop ARCS per crest contour ------
  // Distance-to-band-edge in METERS (vHw delta / gradient magnitude) so the
  // cap hugs the crest band's silhouette and stays thin over flat crest tops;
  // dh/dt > 0 selects the leading face. Whole arcs flip on/off in time steps
  // and each arc can lose 1-2 interior bites (negative space, not slabs).
  if (detail > 0.0) {
    float dhdt = waveDerivT(vOrigXZ, uTime);
    float gradMag = length(n.xz) / (max(n.y, 0.05) * uMaxAmp); // |grad vH|, 1/m
    float dEdge = (vHw - uBandCrest) / max(gradMag, 0.012);    // meters from the edge
    if (dhdt > uCapRiseGate && dEdge > -0.4) {
      vec2 edgeDir = vec2(-n.z, n.x) / (length(n.xz) + 1e-5); // along the crest contour
      float arcC = dot(vOrigXZ, edgeDir);                     // meters along the contour
      float arcId = floor(arcC / uCapArcLen);
      float tqC = floor(uTime * uCapFps);
      float arcOn = hash12(vec2(arcId * 1.13, 5.0) + tqC * 0.31);
      // lobes grow chunkier in the half-detail zone so distant scallops can
      // never merge into a fingerprint of thin parallel squiggles
      float sc = abs(fract(arcC * uCapScallop * (detail > 0.5 ? 1.0 : 0.55)) - 0.5) * 2.0;
      float capW = uCrestCapW * (0.55 + 0.45 * sc);           // scalloped cap width, m
      if (arcOn > uCapArcCut && dEdge < capW) {
        // interior cut: on ~half the arcs a bite is taken from the landward
        // edge, its depth quantized per arc — foam bodies get holes
        float cutH = hash12(vec2(arcId * 2.71, 9.0) + tqC * 0.17);
        float biteEdge = capW * (0.3 + 0.25 * fract(cutH * 7.31));
        if (cutH <= 0.5 || dEdge < biteEdge) col = mix(col, uColorFoam, detail);
      }
    }
  }

  // --- 4. sun-glitter lane: plus/diamond glints in 3 discrete sizes -------
  // Clustered into a hard band around the sun azimuth (sparse outside),
  // blinking on/off in hard time steps. Contrast dies in two hard distance
  // steps so far glitter can never turn into horizon speckle.
  if (dist < uGlintFadeB) {
    vec2 toFrag = vOrigXZ - cameraPosition.xz;
    float laneD = dot(toFrag / max(length(toFrag), 1e-3), normalize(uSunDir.xz));
    float lane = laneD > uGlintLaneCos ? 1.0 : (laneD > uGlintLaneSoft ? 0.15 : 0.0);
    float dens = mix(uGlintDensOut, uGlintDensIn, lane);
    float tq = floor(uTime * uGlintFps);
    bool glint = false;
    // small diamonds — upper wave faces only
    if (vHw > uGlintCrest) {
      vec2 cell = vOrigXZ / uGlintSizeA;
      vec2 f = abs(fract(cell) - 0.5);
      if (f.x + f.y < 0.38 && hash12(floor(cell) + tq * 0.618) > 1.0 - dens * 0.5) glint = true;
    }
    // medium diamonds — slim, anywhere in the lane (pluses read as X crosses
    // at grazing angles; diamonds stay "glitter" from every view)
    {
      vec2 cell = vOrigXZ / uGlintSizeB + 17.3;
      vec2 f = abs(fract(cell) - 0.5);
      if (f.x + f.y < 0.3 && hash12(floor(cell) + tq * 0.392) > 1.0 - dens * 0.22) glint = true;
    }
    // BIG diamonds — sparse, deep band only: the deep band's glint content.
    // Kept small enough to never read as a crashed white "airplane" up close.
    if (vHw <= uBandDeep) {
      vec2 cell = vOrigXZ / uGlintSizeC + 41.1;
      vec2 f = abs(fract(cell) - 0.5);
      if (f.x + f.y < 0.16 && hash12(floor(cell) + tq * 0.233) > 1.0 - dens * 0.09) glint = true;
    }
    if (glint) col = mix(col, uColorSparkle, dist < uGlintFadeA ? 1.0 : 0.5);
  }

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

  // --- 6. hard distance fog bands: horizon melts into the sky -------------
  if (dist > uFogFar) col = uColorHorizon;
  else if (dist > uFogMid) col = mix(col, uColorHorizon, uFogFarMix);
  else if (dist > uFogStart) col = mix(col, uColorHorizon, uFogMidMix);

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
      uBandDeep: { value: -0.45 },
      uBandCrest: { value: 0.45 },
      uBandBlend: { value: 0.13 },
      uPatchScale: { value: 18.0 },
      uPatchStrength: { value: 0.01 },

      uWarpAmp: { value: 0.045 },
      uWarpScaleA: { value: 11.0 },
      uWarpScaleB: { value: 5.0 },
      uWarpScaleC: { value: 64.0 },
      uWarpFade: { value: 350.0 },

      uDeepStreakScale: { value: 28.0 },
      uDeepStreakDuty: { value: 0.35 },
      uDeepStreakStrength: { value: 0.02 },
      uDeepStreakDrift: { value: 1.2 },

      uCrestCapW: { value: 0.65 },
      uCapScallop: { value: 0.3 },
      uCapArcLen: { value: 6.0 },
      uCapArcCut: { value: 0.78 },
      uCapFps: { value: 4.0 },
      uCapRiseGate: { value: 0.05 },

      uGlintFps: { value: 6.0 },
      uGlintLaneCos: { value: 0.9 },
      uGlintLaneSoft: { value: 0.72 },
      uGlintDensIn: { value: 0.04 },
      uGlintDensOut: { value: 0.0008 },
      uGlintSizeA: { value: 0.5 },
      uGlintSizeB: { value: 1.0 },
      uGlintSizeC: { value: 3.6 },
      uGlintCrest: { value: 0.05 },
      uGlintFadeA: { value: 70.0 },
      uGlintFadeB: { value: 160.0 },

      uFoamRingWidth: { value: 1.6 },
      uFoamRingOuter: { value: 0.9 },
      uFoamRingBreak: { value: 0.4 },
      uRingChunk: { value: 0.9 },
      uRingBias: { value: 0.03 },
      uFoamRingFps: { value: 5.0 },
      uRingContact: { value: 0.35 },
      uRingContactShade: { value: 0.72 },
      uRingMaxDist: { value: 150.0 },

      uDetailFadeA: { value: 90.0 },
      uDetailFadeB: { value: 170.0 },

      uFogStart: { value: 150.0 },
      uFogMid: { value: 650.0 },
      uFogFar: { value: 2800.0 },
      uFogMidMix: { value: 0.45 },
      uFogFarMix: { value: 0.8 },

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
