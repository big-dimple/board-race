/**
 * sky.ts — graphic sky dome with atmospheric cloud volumes and a restrained
 * visible sun. The water and hulls keep the shared baked light direction;
 * this file only owns the sky-facing presentation.
 *
 * The whole rig follows the camera (infinite-ocean illusion); clouds live
 * on fixed-radius rings around it at two depths, with the near layer
 * drifting faster than the far one for a parallax read. All per-frame
 * state is preallocated — update() allocates nothing.
 *
 * Color pipeline: palette hex values are used verbatim (NoColorSpace /
 * canvas bytes). Cloud softness is authored into the alpha texture once at
 * construction time, so the frame loop remains allocation-free.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { SUN_DIR } from './toonMaterial';

const SKY_RADIUS = 4500;
const CLOUD_COUNT = 16; // 8 near + 8 far
const FAR_CLOUD_START = CLOUD_COUNT / 2;

// The shared light stays where the boats expect it. The sky's visible sun is
// a little lower and farther forward so it can occasionally enter a chase
// frame without changing hull, rider, or water lighting.
const SKY_SUN_DIR = SUN_DIR.clone().add(new THREE.Vector3(0, -0.13, 0.18)).normalize();

/** Deterministic hash → 0..1 (stable cloud layout across runs/screenshots). */
function hash(i: number, k: number): number {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Palette hex → THREE.Color, verbatim (no color-space conversion). */
function flat(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.NoColorSpace);
}

// ----------------------------------------------------------- sky dome ----

const skyVertexShader = /* glsl */ `
varying vec3 vDir; // direction from the camera (sphere is camera-centered)

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const skyFragmentShader = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uSunVisualDir; // visible sun direction; lighting remains shared in toon/water
uniform vec3 uSunCore;
uniform vec3 uSunFlare;
uniform float uTime;     // seconds — drives the slow ray rotation
uniform float uOpeningArt;

varying vec3 vDir;

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  // ---------------------------------------------------------------
  // 3-BAND GRADIENT zenith -> mid -> horizon. Narrow blend zones:
  // reads as graphic bands, not a photographic gradient.
  // ---------------------------------------------------------------
  vec3 col = uHorizon;
  col = mix(col, uMid, smoothstep(0.03, 0.10, h));
  col = mix(col, uZenith, smoothstep(0.28, 0.40, h));

  // ---------------------------------------------------------------
  // SUN — a compact bright core, two soft atmospheric halos, and a pair of
  // broad directional veils. The shapes fade continuously into the sky so
  // the sun reads as light in the atmosphere instead of a HUD icon.
  // ---------------------------------------------------------------
  float ang = acos(clamp(dot(dir, uSunVisualDir), -1.0, 1.0)); // radians off-sun
  vec3 t0 = normalize(cross(uSunVisualDir, vec3(0.0, 1.0, 0.0)));
  vec3 t1 = cross(t0, uSunVisualDir);
  float az = atan(dot(dir, t1), dot(dir, t0)); // azimuth around the sun

  float disc = 1.0 - smoothstep(0.022, 0.038, ang);
  float innerHalo = 1.0 - smoothstep(0.038, 0.105, ang);
  float outerHalo = 1.0 - smoothstep(0.105, 0.235, ang);
  float rot = uTime * 0.018;
  float lobeA = pow(max(cos((az + rot) * 2.0), 0.0), 3.5);
  float lobeB = pow(max(cos((az - rot * 0.6) * 3.0 + 0.35), 0.0), 5.0);
  float veilBand = smoothstep(0.052, 0.085, ang) * (1.0 - smoothstep(0.085, 0.28, ang));
  float veils = (lobeA * 0.65 + lobeB * 0.35) * veilBand;
  float atmosphericGlow = innerHalo * 0.14 + outerHalo * 0.038 + veils * 0.24;
  atmosphericGlow *= 1.0 + uOpeningArt * 0.2;
  float warm = clamp(atmosphericGlow, 0.0, 0.38);
  vec3 sunMist = mix(uSunFlare, uSunCore, 0.48);
  col = mix(col, sunMist, warm);
  col = mix(col, uSunCore, disc);

  gl_FragColor = vec4(col, 1.0);
}
`;

// -------------------------------------------------------------- clouds ----

type CloudLobe = readonly [number, number, number, number, number];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function noise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const fadeX = fx * fx * (3 - 2 * fx);
  const fadeY = fy * fy * (3 - 2 * fy);
  const corner = (cx: number, cy: number): number => {
    const s = Math.sin(cx * 127.1 + cy * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  return lerp(
    lerp(corner(ix, iy), corner(ix + 1, iy), fadeX),
    lerp(corner(ix, iy + 1), corner(ix + 1, iy + 1), fadeX),
    fadeY,
  );
}

function cloudFbm(x: number, y: number): number {
  return noise2(x, y) * 0.58 + noise2(x * 2.03 + 7.1, y * 2.03 - 3.4) * 0.28 +
    noise2(x * 4.07 - 2.2, y * 4.07 + 5.7) * 0.14;
}

function makeCloudTextureFromDensity(
  width: number,
  height: number,
  lobes: readonly CloudLobe[],
  alphaScale: number,
  far: boolean,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const pixels = image.data;
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      let shape = 0;
      for (const [cx, cy, rx, ry, weight] of lobes) {
        const dx = (u - cx) / rx;
        const dy = (v - cy) / ry;
        shape += Math.exp(-(dx * dx + dy * dy) * 2.25) * weight;
      }
      const base = Math.exp(-Math.pow((v - (far ? 0.69 : 0.70)) / (far ? 0.17 : 0.2), 2));
      shape = Math.min(1, shape * (far ? 0.7 : 0.82) + base * (far ? 0.14 : 0.18));
      const detail = cloudFbm(u * (far ? 7.0 : 9.0), v * (far ? 4.0 : 5.4));
      const density = Math.max(0, Math.min(1, (shape + (detail - 0.5) * (far ? 0.18 : 0.28) - 0.22) * 1.55));
      const edge = Math.min(1, shape * 1.8);
      const alpha = Math.round(density * edge * alphaScale * 255);
      const underside = Math.max(0, Math.min(1, (v - (far ? 0.55 : 0.5)) * 2.4));
      const light = Math.max(0, Math.min(1, 0.98 - underside * (far ? 0.23 : 0.34) + (detail - 0.5) * 0.14));
      const i = (y * width + x) * 4;
      pixels[i] = Math.round((far ? 222 : 250) * light);
      pixels[i + 1] = Math.round((far ? 239 : 253) * light);
      pixels[i + 2] = Math.round((far ? 247 : 255) * (light - underside * 0.06));
      pixels[i + 3] = alpha;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * Near cloud: translucent, irregular lobes with an internal cool underside.
 * No outline or flat base is drawn; the alpha falloff is what supplies the
 * volume when the sprite catches the bright sky behind it.
 */
function makeCloudTexture(): THREE.CanvasTexture {
  return makeCloudTextureFromDensity(256, 160, [
    [0.12, 0.64, 0.19, 0.27, 0.62], [0.29, 0.47, 0.2, 0.34, 0.88],
    [0.48, 0.38, 0.22, 0.39, 0.96], [0.68, 0.46, 0.21, 0.36, 0.84],
    [0.86, 0.63, 0.19, 0.27, 0.6], [0.42, 0.76, 0.5, 0.18, 0.35],
  ], 0.84, false);
}

/** A wide, low-contrast remote cloud bank with a soft density gradient. */
function makeRemoteCloudTexture(): THREE.CanvasTexture {
  return makeCloudTextureFromDensity(512, 220, [
    [0.1, 0.64, 0.22, 0.22, 0.28], [0.3, 0.53, 0.27, 0.28, 0.42],
    [0.52, 0.45, 0.3, 0.31, 0.54], [0.74, 0.55, 0.26, 0.26, 0.44],
    [0.94, 0.66, 0.2, 0.22, 0.25], [0.57, 0.78, 0.58, 0.16, 0.22],
  ], 0.5, true);
}

// ------------------------------------------------------------------ Sky ----

export class Sky {
  readonly object: THREE.Object3D;

  private readonly skyUniforms: { [uniform: string]: THREE.IUniform };
  private readonly sprites: THREE.Sprite[] = [];
  // Per-cloud ring parameters (index 0..7 near layer, 8..15 far layer).
  private readonly cRadius = new Float32Array(CLOUD_COUNT);
  private readonly cAngle = new Float32Array(CLOUD_COUNT);
  private readonly cOmega = new Float32Array(CLOUD_COUNT);
  private readonly cAlt = new Float32Array(CLOUD_COUNT);

  constructor() {
    const group = new THREE.Group();
    group.name = 'sky';
    this.object = group;

    // --- dome ---
    this.skyUniforms = {
      uZenith: { value: flat(PALETTE.skyZenith) },
      uMid: { value: flat(PALETTE.skyMid) },
      uHorizon: { value: flat(PALETTE.skyHorizon) },
      uSunVisualDir: { value: SKY_SUN_DIR },
      uSunCore: { value: flat(PALETTE.sunCore) },
      uSunFlare: { value: flat(PALETTE.sunFlare) },
      uTime: { value: 0 },
      uOpeningArt: { value: 0 },
    };
    const skyMat = new THREE.ShaderMaterial({
      name: 'CelSky',
      uniforms: this.skyUniforms,
      vertexShader: skyVertexShader,
      fragmentShader: skyFragmentShader,
      side: THREE.BackSide, // inverted sphere
      depthWrite: false,    // paints behind everything, never occludes
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 32, 16), skyMat);
    dome.frustumCulled = false;
    dome.renderOrder = -1000; // first thing in the opaque pass
    group.add(dome);

    // --- clouds: two atmospheric billboard layers on rings ---
    const cloudTex = makeCloudTexture();
    const remoteCloudTex = makeRemoteCloudTexture();
    const nearMat = new THREE.SpriteMaterial({
      map: cloudTex,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const farMat = new THREE.SpriteMaterial({
      map: remoteCloudTex,
      color: flat(0xffffff),
      opacity: 0.62,
      transparent: true,
      depthWrite: false,
      fog: false,
    });

    for (let i = 0; i < CLOUD_COUNT; i++) {
      const far = i >= FAR_CLOUD_START;
      const sprite = new THREE.Sprite(far ? farMat : nearMat);
      sprite.frustumCulled = false; // always inside the camera-centered rig

      const j = far ? i - CLOUD_COUNT / 2 : i;
      // Evenly spaced ring + deterministic jitter; two depth bands.
      this.cAngle[i] = (j / (CLOUD_COUNT / 2)) * Math.PI * 2 + hash(i, 1) * 0.6;
      this.cRadius[i] = far ? 2950 + hash(i, 2) * 820 : 1300 + hash(i, 3) * 450;
      this.cAlt[i] = far ? 320 + hash(i, 4) * 230 : 110 + hash(i, 5) * 170;
      // Slow drift; the near layer sweeps faster => parallax between layers.
      const dir = hash(i, 6) > 0.15 ? 1 : -1; // mostly one way, a few rebels
      this.cOmega[i] = dir * (far ? 0.0018 : 0.0042) * (0.7 + hash(i, 7) * 0.6);

      const sx = far ? 780 + hash(i, 8) * 360 : 300 + hash(i, 9) * 170;
      sprite.scale.set(sx, sx * (far ? 0.34 : 0.58), 1);
      sprite.rotation.z = (hash(i, 10) - 0.5) * (far ? 0.12 : 0.06);
      this.sprites.push(sprite);
      group.add(sprite);
    }

    this.update(0, new THREE.Vector3());
  }

  /** Follow the camera and advance cloud drift. Allocates nothing. */
  update(t: number, camPos: THREE.Vector3): void {
    this.object.position.copy(camPos);
    this.skyUniforms.uTime.value = t;
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const a = this.cAngle[i] + t * this.cOmega[i];
      const r = this.cRadius[i];
      this.sprites[i].position.set(Math.cos(a) * r, this.cAlt[i], Math.sin(a) * r);
    }
  }

  setOpeningIntensity(value: number): void {
    this.skyUniforms.uOpeningArt.value = Math.max(0, Math.min(1, value));
  }
}
