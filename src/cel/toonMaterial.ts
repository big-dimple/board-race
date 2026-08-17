/**
 * toonMaterial.ts — THE cel surface shader.
 *
 * One baked sun direction (no three.js lights, no PBR, no env maps):
 *   diffuse   = NdotL quantized through an analytic 8-band step (hard bands)
 *   rim       = fresnel through a hard step threshold
 *   specular  = Blinn half-vector through two hard step thresholds
 *   fog       = two hard distance bands toward the horizon color
 * Everything is a step — if it reads smooth/photographic, it's a bug.
 *
 * Color pipeline: palette hex values are loaded verbatim (NoColorSpace) and
 * the shader writes straight to the composer target (NoToneMapping, no
 * OutputPass), so authored palette colors are exactly what you see.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';

/** The ONE light direction: world space, pointing TOWARD the sun. Shared by sky, water spec and every toon material. */
export const SUN_DIR: THREE.Vector3 = new THREE.Vector3(
  PALETTE.sunDir[0],
  PALETTE.sunDir[1],
  PALETTE.sunDir[2],
).normalize();

export interface ToonOptions {
  color: number;
  rimColor?: number; rimStrength?: number; rimPower?: number; rimThreshold?: number;
  specColor?: number; specThreshold?: number;
  emissive?: number; emissiveIntensity?: number;
  /** Multiply the uniform albedo by the geometry's RGB color attribute. */
  vertexColors?: boolean;
}

/** Palette hex → THREE.Color with NO color-space conversion (verbatim to screen, see header). */
function flat(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.NoColorSpace);
}

const vertexShader = /* glsl */ `
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

#ifdef USE_VERTEX_COLOR
varying vec3 vVertexColor;
#endif

#include <skinning_pars_vertex>

void main() {
  vec3 transformed = vec3(position);
  vec3 objectNormal = vec3(normal);
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <skinning_vertex>

  // World-space normal for the sun dot / up-tint / rim / spec.
  // mat3(modelMatrix) assumes uniform scale, which holds for every mesh in
  // this project (boats, riders, buoys are built with uniform scales).
  vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
  vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
  vWorldPos = worldPos.xyz;
  #ifdef USE_VERTEX_COLOR
  vVertexColor = color;
  #endif
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;            // flat albedo
uniform vec3 uSunDir;           // world-space direction TOWARD the sun (normalized)
uniform vec3 uSkyMid;           // shadow-side hue source
uniform float uShadowTint;      // 0..1 how far shadows hue-shift toward uSkyMid
uniform vec3 uShadowFloor;      // absolute darkest a toon surface may render
uniform vec3 uRimColor;         // fresnel rim color (default: palette.sparkle)
uniform float uRimStrength;
uniform float uRimPower;
uniform float uRimThreshold;    // hard step on the fresnel term
uniform vec3 uSpecColor;        // banded specular color (default: white)
uniform float uSpecPower;       // Blinn shininess
uniform float uSpecThreshold;   // hard step for the broad band
uniform float uSpecThreshold2;  // hard step for the tighter hot core
uniform vec3 uEmissive;
uniform float uEmissiveIntensity;
uniform vec3 uUpTintColor;      // matcap-ish sky tint for up-facing normals
uniform float uUpTint;          // strength of that tint (0 disables)
uniform vec3 uFogColor;         // palette.skyHorizon
uniform float uFogBand1;        // distance (m) of the first fog step
uniform float uFogBand2;        // distance (m) of the second fog step
uniform float uFogStrength;     // overall fog multiplier

varying vec3 vWorldNormal;
varying vec3 vWorldPos;
#ifdef USE_VERTEX_COLOR
varying vec3 vVertexColor;
#endif

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos); // world-space view dir
  vec3 L = uSunDir;                               // already normalized

  // ------------------------------------------------------------------
  // DIFFUSE — NdotL wrapped to 0..1 and quantized through the same eight
  // authored levels as the former 1D ramp. Analytic steps remove a texture
  // fetch from every toon fragment while preserving the hard band boundaries.
  // ------------------------------------------------------------------
  float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  float band = 0.46
    + step(0.125, ndl) * 0.08
    + step(0.250, ndl) * 0.08
    + step(0.375, ndl) * 0.08
    + step(0.500, ndl) * 0.08
    + step(0.625, ndl) * 0.08
    + step(0.750, ndl) * 0.07
    + step(0.875, ndl) * 0.07;

  // Shadow side hue-shifts toward the sky color so it stays colorful
  // (never gray, never black). "band" only ever takes the authored discrete
  // levels, so this mix is still a set of perfectly hard steps.
  vec3 albedo = uColor;
  #ifdef USE_VERTEX_COLOR
  albedo *= vVertexColor;
  #endif
  vec3 shadowAlbedo = albedo * mix(vec3(1.0), uSkyMid, uShadowTint);
  vec3 color = mix(shadowAlbedo, albedo, band);

  // ------------------------------------------------------------------
  // MATCAP-ISH UP TINT — one hard step on upward-facing normals, faking
  // the sky bounce a matcap would give. Flat and graphic, strength subtle.
  // ------------------------------------------------------------------
  float up = step(0.72, N.y) * uUpTint;
  color = mix(color, uUpTintColor, up);

  // ------------------------------------------------------------------
  // SHADOW FLOOR — hard per-channel clamp at a dark indigo minimum.
  // Nothing toon-shaded may render as a dead black void: even the darkest
  // darkest band on the darkest albedo (ink) keeps a readable hue. Clamping
  // the already-quantized color preserves the hard band edges; only albedos
  // darker than the floor are touched. Ink OUTLINES (separate shader) are
  // intentionally exempt and may go darker.
  // ------------------------------------------------------------------
  color = max(color, uShadowFloor);

  // ------------------------------------------------------------------
  // BANDED SPECULAR — Blinn half-vector through two hard thresholds:
  // a broad band plus a tighter hot core. Crisp cartoon highlight SHAPES
  // with zero smooth falloff. This replaces any environment reflection.
  // ------------------------------------------------------------------
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), uSpecPower);
  float specBand = step(uSpecThreshold, spec) * 0.45
                 + step(uSpecThreshold2, spec) * 0.55;
  color += uSpecColor * specBand;

  // ------------------------------------------------------------------
  // FRESNEL RIM — pow(1 - NdotV, rimPower) through a hard step.
  // Silhouettes pop against the water.
  // ------------------------------------------------------------------
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), uRimPower);
  float rim = step(uRimThreshold, fresnel) * uRimStrength;
  color += uRimColor * rim;

  // ------------------------------------------------------------------
  // EMISSIVE — flat add (boost glows, gate lights, etc).
  // ------------------------------------------------------------------
  color += uEmissive * uEmissiveIntensity;

  // ------------------------------------------------------------------
  // FOG — two hard distance bands toward the horizon color.
  // Banded, not smooth: aerial perspective as a graphic device.
  // ------------------------------------------------------------------
  float dist = distance(vWorldPos, cameraPosition);
  float fog = (step(uFogBand1, dist) * 0.35 + step(uFogBand2, dist) * 0.45) * uFogStrength;
  color = mix(color, uFogColor, min(fog, 1.0));

  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * Build a cel-shaded material. The sun is a baked uniform (SUN_DIR) — no
 * three.js lights involved. All thresholds/strengths live in
 * `material.uniforms` for screenshot-driven tuning.
 */
export function createToonMaterial(opts: ToonOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'CelToon',
    defines: opts.vertexColors ? { USE_VERTEX_COLOR: 1 } : {},
    vertexColors: opts.vertexColors ?? false,
    uniforms: {
      uColor: { value: flat(opts.color) },
      uSunDir: { value: SUN_DIR },
      uSkyMid: { value: flat(PALETTE.skyMid) },
      uShadowTint: { value: 0.42 },
      // Deep indigo, verbatim to screen: the darkest any toon surface renders.
      uShadowFloor: { value: flat(0x1e1b3a) },
      uRimColor: { value: flat(opts.rimColor ?? PALETTE.sparkle) },
      uRimStrength: { value: (opts.rimStrength ?? 0.9) * 0.82 },
      uRimPower: { value: opts.rimPower ?? 2.6 },
      uRimThreshold: { value: opts.rimThreshold ?? 0.58 },
      uSpecColor: { value: flat(opts.specColor ?? 0xffffff) },
      uSpecPower: { value: 72.0 },
      uSpecThreshold: { value: Math.max(opts.specThreshold ?? 0.95, 0.95) },
      uSpecThreshold2: { value: 0.995 },
      uEmissive: { value: flat(opts.emissive ?? 0x000000) },
      uEmissiveIntensity: { value: opts.emissiveIntensity ?? 1.0 },
      uUpTintColor: { value: flat(PALETTE.skyHorizon) },
      uUpTint: { value: 0.096 },
      uFogColor: { value: flat(PALETTE.skyHorizon) },
      uFogBand1: { value: 260.0 },
      uFogBand2: { value: 760.0 },
      uFogStrength: { value: 1.0 },
    },
    vertexShader,
    fragmentShader,
  });
}
