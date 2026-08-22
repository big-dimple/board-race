/**
 * edgePass.ts — Sobel screen-space ink lines over the rendered scene.
 *
 * Consumes the PrePass (view-space normals in RGB, object mask in alpha,
 * scene depth) and stamps hard interior lines onto the beauty pass:
 *
 *   - 3x3 Sobel over the packed normal field  -> interior crease lines
 *     (normal-angle discontinuities: panel seams, deck/hull joints...).
 *   - Roberts cross over linearized depth     -> mild depth creases.
 *   - Strong depth discontinuities are REJECTED, and any pixel touching
 *     the prepass background (alpha = 0) is masked out: silhouettes belong
 *     to the inverted-hull outlines, the two line systems must not double up.
 *
 * Lines are a hard step multiplied by palette ink — no soft gray edges.
 *
 * Color pipeline: everything is verbatim sRGB end to end (NoToneMapping,
 * no OutputPass), so the ink multiply uses the authored palette values.
 */
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { PrePass } from '../core/prePass';
import { PALETTE } from '../core/palette';

const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
#include <packing>

uniform sampler2D tDiffuse;       // beauty pass (composer read buffer)
uniform sampler2D tNormal;        // prepass: packed view-space normals, alpha = object mask
uniform sampler2D tDepth;         // prepass: depth of ink solids
uniform vec2 uResolution;         // DEVICE pixels
uniform float uCameraNear;
uniform float uCameraFar;
uniform vec3 uInk;                // palette.ink
uniform float uInkGain;           // brightness compensation for the ink multiply
uniform float uNormalThreshold;   // Sobel magnitude -> crease line
uniform float uDepthThreshold;    // meters of view-z gradient -> depth line
uniform float uSilhouetteDepth;   // reject gradients beyond this (object vs background)
uniform float uStrength;          // overall line opacity (still a hard step)
uniform float uLineFadeNear;      // interior lines are a near-field device:
uniform float uLineFadeFar;       // fade to zero across this view-depth band

varying vec2 vUv;

float linearDepth(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  return -perspectiveDepthToViewZ(d, uCameraNear, uCameraFar);
}

void main() {
  vec2 texel = 1.0 / uResolution;
  vec3 col = texture2D(tDiffuse, vUv).rgb;

  // 3x3 neighborhood taps.
  vec2 uvL  = vUv - vec2(texel.x, 0.0);
  vec2 uvR  = vUv + vec2(texel.x, 0.0);
  vec2 uvT  = vUv + vec2(0.0, texel.y);
  vec2 uvB  = vUv - vec2(0.0, texel.y);
  vec2 uvTL = vUv + vec2(-texel.x,  texel.y);
  vec2 uvTR = vUv + texel;
  vec2 uvBL = vUv - texel;
  vec2 uvBR = vUv + vec2(texel.x, -texel.y);

  vec4 nC  = texture2D(tNormal, vUv);
  vec4 nL  = texture2D(tNormal, uvL);
  vec4 nR  = texture2D(tNormal, uvR);
  vec4 nT  = texture2D(tNormal, uvT);
  vec4 nB  = texture2D(tNormal, uvB);
  vec4 nTL = texture2D(tNormal, uvTL);
  vec4 nTR = texture2D(tNormal, uvTR);
  vec4 nBL = texture2D(tNormal, uvBL);
  vec4 nBR = texture2D(tNormal, uvBR);

  // ------------------------------------------------------------------
  // NORMALS: 3x3 Sobel over the packed normal field. Creases show up as
  // normal-angle discontinuities. (Gradient of packed 0..1 normals is
  // half the unpacked gradient — the threshold absorbs that constant.)
  // ------------------------------------------------------------------
  vec3 gx = (nTR.rgb + 2.0 * nR.rgb + nBR.rgb) - (nTL.rgb + 2.0 * nL.rgb + nBL.rgb);
  vec3 gy = (nBL.rgb + 2.0 * nB.rgb + nBR.rgb) - (nTL.rgb + 2.0 * nT.rgb + nTR.rgb);
  float normalGrad = length(gx) + length(gy);
  float normalEdge = step(uNormalThreshold, normalGrad);

  // ------------------------------------------------------------------
  // DEPTH: Roberts cross on linearized view-z (diagonals only — thin,
  // no halo). Keep MILD discontinuities, REJECT huge ones: a giant delta
  // means object-vs-background, and the inverted hull owns that line.
  // ------------------------------------------------------------------
  float dTL = linearDepth(uvTL);
  float dTR = linearDepth(uvTR);
  float dBL = linearDepth(uvBL);
  float dBR = linearDepth(uvBR);
  float depthGrad = abs(dTL - dBR) + abs(dTR - dBL);
  float depthEdge = step(uDepthThreshold, depthGrad)
                  * (1.0 - step(uSilhouetteDepth, depthGrad));

  // ------------------------------------------------------------------
  // SILHOUETTE MASK: the prepass clears alpha to 0 (background) and
  // writes 1 for ink solids. If any neighbor is background we are within
  // a pixel of a silhouette — suppress, the outline hull draws there.
  // ------------------------------------------------------------------
  float mask = step(0.5, min(min(min(nL.a, nR.a), min(nT.a, nB.a)), nC.a));

  // Near-field fade: past ~boat-pack distance a sub-pixel crease is not a
  // line, it is noise — the Sobel fires on every pixel of a small rider or
  // far buoy and the ink multiply crushes the whole shape into a dark blob.
  // Interior inking is a close-range graphic device; silhouettes far away
  // stay with the inverted hull, which already scales to constant width.
  float dC = linearDepth(vUv);
  float nearFade = 1.0 - smoothstep(uLineFadeNear, uLineFadeFar, dC);

  float edge = max(normalEdge, depthEdge) * mask * nearFade * uStrength;

  // ------------------------------------------------------------------
  // APPLY: multiply ink over the scene color. Hard step — no soft gray.
  // uInkGain (~2x) keeps the line a readable deep indigo instead of
  // crushing to pure black on dark surfaces.
  // ------------------------------------------------------------------
  vec3 inked = col * uInk * uInkGain;
  col = mix(col, inked, clamp(edge, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;

/** ShaderPass subclass that keeps uResolution in DEVICE pixels. */
class EdgePass extends ShaderPass {
  constructor(material: THREE.ShaderMaterial) {
    super(material);
  }

  override setSize(width: number, height: number): void {
    // EffectComposer reports device pixels here (its pixel ratio is 1 —
    // the stage scales the drawing buffer itself).
    this.uniforms.uResolution.value.set(width, height);
  }
}

/**
 * Build the Sobel edge pass. `tNormal`/`tDepth` stay bound to the PrePass
 * textures; `tDiffuse` is fed by the composer every frame.
 */
export function createEdgePass(prePass: PrePass, camera: THREE.Camera): ShaderPass {
  const persp = camera as Partial<THREE.PerspectiveCamera>;
  const material = new THREE.ShaderMaterial({
    name: 'CelEdge',
    uniforms: {
      tDiffuse: { value: null },
      tNormal: { value: prePass.normalTexture },
      tDepth: { value: prePass.depthTexture },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCameraNear: { value: persp.near ?? 0.1 },
      uCameraFar: { value: persp.far ?? 6000 },
      uInk: { value: new THREE.Color().setHex(PALETTE.ink, THREE.NoColorSpace) },
      uInkGain: { value: 1.7 },
      uNormalThreshold: { value: 1.35 },
      uDepthThreshold: { value: 2.0 },
      uSilhouetteDepth: { value: 80.0 },
      uStrength: { value: 1.0 },
      uLineFadeNear: { value: 9.0 },
      uLineFadeFar: { value: 26.0 },
    },
    vertexShader,
    fragmentShader,
  });
  return new EdgePass(material);
}
