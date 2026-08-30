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
import { NIGHT_PALETTE } from '../core/nightPalette';
import type { TimeOfDay } from '../core/timeOfDay';

/** The ONE light direction: world space, pointing TOWARD the sun/moon. Shared by sky, water spec and every toon material. */
export const SUN_DIR: THREE.Vector3 = new THREE.Vector3(
  PALETTE.sunDir[0],
  PALETTE.sunDir[1],
  PALETTE.sunDir[2],
).normalize();

/**
 * The visible sun sits low over the horizon (NFS-style "race into the sun"
 * key light) so the chase view reads a real sun disc, warm haze and a
 * sunward reflection lane on the water. Sky presentation and sun-facing
 * camera scenarios use this source; scene materials continue to use SUN_DIR.
 */
export const VISIBLE_SUN_DIR: THREE.Vector3 = new THREE.Vector3(
  SUN_DIR.x,
  SUN_DIR.y * 0.3,
  SUN_DIR.z,
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

const daySunDir = new THREE.Vector3(PALETTE.sunDir[0], PALETTE.sunDir[1], PALETTE.sunDir[2]).normalize();
const nightMoonDir = new THREE.Vector3(NIGHT_PALETTE.moonDir[0], NIGHT_PALETTE.moonDir[1], NIGHT_PALETTE.moonDir[2]).normalize();

const sharedSunDir = SUN_DIR;
const sharedSkyMid = flat(PALETTE.skyMid);
const sharedShadowFloor = flat(0x1e1b3a);
const sharedUpTintColor = flat(PALETTE.skyHorizon);
const sharedFogColor = flat(PALETTE.skyHorizon);
const sharedNightBlend = { value: 0.0 };

const daySkyMid = flat(PALETTE.skyMid);
const nightSkyMid = flat(NIGHT_PALETTE.skyMid);
const dayShadowFloor = flat(0x1e1b3a);
const nightShadowFloor = flat(0x14223d); // rich dark navy floor, preserves character hair & boat details
const dayUpTintColor = flat(PALETTE.skyHorizon);
const nightUpTintColor = flat(0x2a4e78);
const dayFogColor = flat(PALETTE.skyHorizon);
const nightFogColor = flat(NIGHT_PALETTE.skyHorizon);

export function setToonTimeOfDay(tod: TimeOfDay, blend?: number): void {
  const b = blend !== undefined ? blend : tod === 'night' ? 1.0 : 0.0;
  const clamped = Math.max(0, Math.min(1, b));
  sharedNightBlend.value = clamped;
  sharedSunDir.lerpVectors(daySunDir, nightMoonDir, clamped).normalize();
  sharedSkyMid.lerpColors(daySkyMid, nightSkyMid, clamped);
  sharedShadowFloor.lerpColors(dayShadowFloor, nightShadowFloor, clamped);
  sharedUpTintColor.lerpColors(dayUpTintColor, nightUpTintColor, clamped);
  sharedFogColor.lerpColors(dayFogColor, nightFogColor, clamped);
}

export function updateToonTimeOfDay(tod: TimeOfDay, blend?: number): void {
  setToonTimeOfDay(tod, blend);
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
uniform float uNightBlend;      // 0.0 = day, 1.0 = night

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
  float shadowTintEffective = mix(uShadowTint, 0.55, uNightBlend);
  vec3 shadowAlbedo = albedo * mix(vec3(1.0), uSkyMid, shadowTintEffective);

  // Night ambient base lift: ensures character skin, hair & boat silhouettes
  // maintain vivid contrast and color identity without turning muddy.
  shadowAlbedo += albedo * vec3(0.06, 0.10, 0.16) * uNightBlend;

  vec3 color = mix(shadowAlbedo, albedo, band);

  // ------------------------------------------------------------------
  // MATCAP-ISH UP TINT — one hard step on upward-facing normals, faking
  // the sky bounce a matcap would give. Flat and graphic, strength subtle.
  // ------------------------------------------------------------------
  float up = step(mix(0.72, 0.65, uNightBlend), N.y) * (uUpTint + 0.04 * uNightBlend);
  color = mix(color, uUpTintColor, up);

  // ------------------------------------------------------------------
  // SHADOW FLOOR — hard per-channel clamp at a dark indigo/navy minimum.
  // Nothing toon-shaded may render as a dead black void: even the darkest
  // band on the darkest albedo (ink) keeps a readable hue.
  // ------------------------------------------------------------------
  color = max(color, uShadowFloor);

  // ------------------------------------------------------------------
  // BANDED SPECULAR — Blinn half-vector through two hard thresholds:
  // a broad band plus a tighter hot core. Crisp cartoon highlight SHAPES
  // with zero smooth falloff.
  // ------------------------------------------------------------------
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), uSpecPower);
  float specBand = step(uSpecThreshold, spec) * 0.45
                 + step(uSpecThreshold2, spec) * 0.55;
  vec3 specColorEffective = mix(uSpecColor, vec3(0.82, 0.94, 1.0), uNightBlend * 0.5);
  color += specColorEffective * specBand;

  // ------------------------------------------------------------------
  // FRESNEL RIM — pow(1 - NdotV, rimPower) through a hard step.
  // In night mode: enhanced cold-cyan moonlight rim lighting.
  // ------------------------------------------------------------------
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), mix(uRimPower, 2.2, uNightBlend));
  float rimThresh = mix(uRimThreshold, 0.50, uNightBlend);
  float rim = step(rimThresh, fresnel) * (uRimStrength + 0.35 * uNightBlend);
  vec3 nightRimHue = vec3(0.42, 0.92, 1.0); // cold cyan rim
  vec3 effectiveRimColor = mix(uRimColor, nightRimHue, uNightBlend * 0.85);
  color += effectiveRimColor * rim;

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
      uSunDir: { value: sharedSunDir },
      uSkyMid: { value: sharedSkyMid },
      uShadowTint: { value: 0.42 },
      // Deep indigo, verbatim to screen: the darkest any toon surface renders.
      uShadowFloor: { value: sharedShadowFloor },
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
      uUpTintColor: { value: sharedUpTintColor },
      uUpTint: { value: 0.096 },
      uFogColor: { value: sharedFogColor },
      uFogBand1: { value: 260.0 },
      uFogBand2: { value: 760.0 },
      uFogStrength: { value: 1.0 },
      uNightBlend: sharedNightBlend,
    },
    vertexShader,
    fragmentShader,
  });
}
