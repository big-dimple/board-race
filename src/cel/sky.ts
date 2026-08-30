/**
 * sky.ts — graphic sky dome with atmospheric cloud volumes, daytime sun,
 * sharp cyber crescent moon, and twinkling 4-pointed cross starfield.
 *
 * Supports seamless day/night transition via setTimeOfDay(tod, blend).
 * All per-frame state is preallocated — update() allocates nothing.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { NIGHT_PALETTE } from '../core/nightPalette';
import type { TimeOfDay } from '../core/timeOfDay';
import { VISIBLE_SUN_DIR } from './toonMaterial';

const SKY_RADIUS = 4500;
const CLOUD_COUNT = 16; // 8 near + 8 far
const FAR_CLOUD_START = CLOUD_COUNT / 2;
const VISIBLE_MOON_DIR = new THREE.Vector3(
  NIGHT_PALETTE.moonDir[0],
  NIGHT_PALETTE.moonDir[1],
  NIGHT_PALETTE.moonDir[2],
).normalize();

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
uniform vec3 uSunVisualDir; // visible sun direction
uniform vec3 uSunCore;

uniform float uNightBlend;
uniform vec3 uNightZenith;
uniform vec3 uNightMid;
uniform vec3 uNightHorizon;
uniform vec3 uMoonVisualDir;
uniform vec3 uMoonCore;
uniform vec3 uMoonHalo;
uniform vec3 uMoonCorona;

uniform float uOpeningArt;
uniform float uTime;

varying vec3 vDir;

// ------------------------------------------------------------------ Stars ----
float starHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 starHash2(vec2 p) {
  float x = starHash(p);
  float y = starHash(p + 31.17);
  return vec2(x, y);
}

void addStarLayer(vec3 dir, float cellScale, float speed, float starProb, float crossProb,
                  float time, inout vec3 accumCol) {
  if (dir.y < 0.015) return;

  float elevation = asin(clamp(dir.y, 0.0, 1.0));
  float azimuth = atan(dir.z, dir.x);
  float latScale = max(cos(elevation), 0.18);
  vec2 uv = vec2(azimuth * latScale, elevation) * cellScale;
  vec2 id = floor(uv);
  vec2 f = fract(uv);

  float rnd = starHash(id);
  if (rnd > starProb) {
    vec2 pos = starHash2(id + 11.43) * 0.7 + 0.15;
    vec2 d = f - pos;
    float dist = length(d);

    float twinkleSeed = starHash(id + 73.19);
    float phase = time * speed * (0.75 + 0.75 * twinkleSeed) + twinkleSeed * 6.2831;
    float twinkle = 0.5 + 0.5 * sin(phase);
    float brightness = pow(twinkle, 1.7 + twinkleSeed * 1.4);

    float coreRadius = 0.065 + 0.035 * twinkleSeed;
    float core = 1.0 - smoothstep(0.0, coreRadius, dist);
    core = pow(core, 2.0);

    float spikes = 0.0;
    if (rnd > crossProb) {
      float spikeLen = (0.26 + 0.22 * twinkleSeed) * (0.65 + 0.55 * brightness);
      float spikeW = coreRadius * 0.32;
      float spikeH = (1.0 - smoothstep(0.0, spikeLen, abs(d.x))) * (1.0 - smoothstep(0.0, spikeW, abs(d.y)));
      float spikeV = (1.0 - smoothstep(0.0, spikeLen, abs(d.y))) * (1.0 - smoothstep(0.0, spikeW, abs(d.x)));
      spikes = max(spikeH, spikeV) * (0.75 + 0.45 * brightness);
    }

    vec3 starTint = vec3(0.92, 0.96, 1.0);
    if (twinkleSeed > 0.65) {
      starTint = vec3(0.65, 0.90, 1.0); // cyber cyan
    } else if (twinkleSeed < 0.25) {
      starTint = vec3(1.0, 0.92, 0.78); // warm diamond
    }

    float horizonFade = smoothstep(0.02, 0.20, dir.y);
    float starIntensity = (core * 0.92 + spikes * 0.88) * brightness * horizonFade;
    accumCol += starTint * starIntensity;
  }
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  // ---------------------------------------------------------------
  // DAY SKY GRADIENT
  // ---------------------------------------------------------------
  vec3 colDay = uHorizon;
  colDay = mix(colDay, uMid, smoothstep(0.03, 0.10, h));
  colDay = mix(colDay, uZenith, smoothstep(0.28, 0.40, h));

  float sunAzimuth = dot(normalize(dir.xz + vec2(1e-5, 0.0)), normalize(uSunVisualDir.xz));
  float horizonBand = 1.0 - smoothstep(0.02, 0.24, h);
  float warmWash = smoothstep(-0.1, 0.9, sunAzimuth) * horizonBand;
  colDay = mix(colDay, vec3(1.0, 0.93, 0.78), warmWash * 0.38);

  // ---------------------------------------------------------------
  // NIGHT SKY GRADIENT
  // ---------------------------------------------------------------
  vec3 colNight = uNightHorizon;
  colNight = mix(colNight, uNightMid, smoothstep(0.02, 0.14, h));
  colNight = mix(colNight, uNightZenith, smoothstep(0.24, 0.45, h));

  // Blended base sky color
  vec3 col = mix(colDay, colNight, uNightBlend);

  // ---------------------------------------------------------------
  // DAY SUN
  // ---------------------------------------------------------------
  if (uNightBlend < 0.999) {
    float ang = acos(clamp(dot(dir, uSunVisualDir), -1.0, 1.0));
    vec3 t0 = normalize(cross(uSunVisualDir, vec3(0.0, 1.0, 0.0)));
    vec3 t1 = cross(t0, uSunVisualDir);
    float az = atan(dot(dir, t1), dot(dir, t0));

    float core = 1.0 - smoothstep(0.0, 0.024, ang);
    float disc = 1.0 - smoothstep(0.024, 0.052, ang);
    float innerHalo = 1.0 - smoothstep(0.052, 0.14, ang);
    float outerHalo = 1.0 - smoothstep(0.14, 0.34, ang);
    float veilBand = smoothstep(0.07, 0.15, ang) * (1.0 - smoothstep(0.19, 0.4, ang));
    float veilA = pow(max(cos(az - 0.24), 0.0), 24.0);
    float veilB = pow(max(cos(az + 0.31), 0.0), 21.0);
    float veils = veilBand * (veilA * 0.7 + veilB * 0.5);

    float downSun = max(-dot(dir, t1), 0.0);
    float rayReach = smoothstep(0.012, 0.050, downSun) *
      (1.0 - smoothstep(0.20, 0.52, downSun));
    float rayWidth = 0.009 + downSun * 0.17;
    float rayA = 1.0 - smoothstep(rayWidth * 0.38, rayWidth, abs(dot(dir, t0) + downSun * 0.13));
    float rayB = 1.0 - smoothstep(rayWidth * 0.32, rayWidth * 0.82, abs(dot(dir, t0) - downSun * 0.18));
    float rayC = 1.0 - smoothstep(rayWidth * 0.26, rayWidth * 0.65, abs(dot(dir, t0) - downSun * 0.42));
    float rayTexture = 0.76 + 0.24 * sin(downSun * 82.0 + dot(dir, t0) * 57.0);

    float rayAMod = 0.55 + 0.45 * sin(uTime * 0.21);
    float rayBMod = 0.55 + 0.45 * sin(uTime * 0.147 + 2.4);
    float rayCMod = 0.55 + 0.45 * sin(uTime * 0.27 + 4.1);
    float veilBreathe = 0.7 + 0.3 * sin(uTime * 0.09 + 1.2);
    float tyndall = rayReach *
      (rayA * 0.82 * rayAMod + rayB * 0.50 * rayBMod + rayC * 0.26 * rayCMod) * rayTexture;

    float atmosphericGlow = innerHalo * 0.22 + outerHalo * 0.05;
    atmosphericGlow *= 1.0 + uOpeningArt * 0.10;
    vec3 sunMist = mix(uSunCore, vec3(1.0, 0.97, 0.86), 0.55);
    vec3 airLight = mix(uSunCore, vec3(1.0, 0.97, 0.86), 0.58);
    float corona = pow(innerHalo * (1.0 - disc), 1.7);

    vec3 sunLight = vec3(0.0);
    sunLight = mix(sunLight, sunMist, clamp(atmosphericGlow, 0.0, 0.26));
    sunLight += airLight * (corona * 0.09 + veils * 0.075);
    sunLight += airLight * tyndall * (0.10 + uOpeningArt * 0.018) * veilBreathe;
    sunLight = mix(sunLight, uSunCore, disc);
    sunLight = mix(sunLight, vec3(1.0, 0.99, 0.89), core * 0.82);

    col += sunLight * (1.0 - uNightBlend);
  }

  // ---------------------------------------------------------------
  // NIGHT CELESTIALS (CRESCENT MOON & 4-POINTED CROSS STARS)
  // ---------------------------------------------------------------
  if (uNightBlend > 0.001) {
    // 1. Crescent Moon calculation
    float angMoon = acos(clamp(dot(dir, uMoonVisualDir), -1.0, 1.0));
    vec3 m0 = normalize(cross(uMoonVisualDir, vec3(0.0, 1.0, 0.0)));
    vec3 m1 = cross(m0, uMoonVisualDir);
    vec2 mCoord = vec2(dot(dir, m0), dot(dir, m1));

    float rMoon = 0.056;
    float distOuter = length(mCoord);
    vec2 shadowCenter = vec2(-0.019, 0.013);
    float distShadow = length(mCoord - shadowCenter);
    float rShadow = 0.052;

    float outerMask = 1.0 - smoothstep(rMoon - 0.0016, rMoon + 0.0016, distOuter);
    float shadowMask = smoothstep(rShadow - 0.002, rShadow + 0.002, distShadow);
    float crescentBody = outerMask * shadowMask;
    float darkSide = outerMask * (1.0 - shadowMask) * 0.05;

    float moonHalo = exp(-angMoon * 9.0) * 0.52;
    float moonCorona = exp(-angMoon * 2.8) * 0.24;

    float mSpikeH = (1.0 - smoothstep(0.0, 0.24, abs(mCoord.x))) * (1.0 - smoothstep(0.0, 0.004, abs(mCoord.y)));
    float mSpikeV = (1.0 - smoothstep(0.0, 0.24, abs(mCoord.y))) * (1.0 - smoothstep(0.0, 0.004, abs(mCoord.x)));
    float moonSpikes = max(mSpikeH, mSpikeV) * 0.38 * (0.85 + 0.15 * sin(uTime * 0.45));

    vec3 moonCol = uMoonCore * crescentBody +
                   vec3(0.35, 0.55, 0.8) * darkSide +
                   uMoonHalo * moonHalo +
                   uMoonCorona * moonCorona +
                   uMoonCore * moonSpikes;

    // 2. Starfield with multi-octave twinkling 4-pointed cross stars
    vec3 starAccum = vec3(0.0);
    addStarLayer(dir, 44.0, 2.2, 0.68, 0.92, uTime, starAccum);
    addStarLayer(dir, 20.0, 1.4, 0.80, 0.84, uTime, starAccum);
    addStarLayer(dir, 10.0, 0.9, 0.88, 0.88, uTime, starAccum);

    // Stars occluded behind moon disk
    starAccum *= (1.0 - outerMask);

    col += (moonCol + starAccum) * uNightBlend;
  }

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

function makeCloudTexture(): THREE.CanvasTexture {
  return makeCloudTextureFromDensity(256, 160, [
    [0.12, 0.64, 0.19, 0.27, 0.62], [0.29, 0.47, 0.2, 0.34, 0.88],
    [0.48, 0.38, 0.22, 0.39, 0.96], [0.68, 0.46, 0.21, 0.36, 0.84],
    [0.86, 0.63, 0.19, 0.27, 0.6], [0.42, 0.76, 0.5, 0.18, 0.35],
  ], 0.84, false);
}

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
  private readonly nearMat: THREE.SpriteMaterial;
  private readonly farMat: THREE.SpriteMaterial;

  private readonly dayCloudNear = flat(0xffffff);
  private readonly nightCloudNear = flat(NIGHT_PALETTE.cloudNear);
  private readonly dayCloudFar = flat(0xffffff);
  private readonly nightCloudFar = flat(NIGHT_PALETTE.cloudFar);

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
      uSunVisualDir: { value: VISIBLE_SUN_DIR },
      uSunCore: { value: flat(PALETTE.sunCore) },

      uNightBlend: { value: 0 },
      uNightZenith: { value: flat(NIGHT_PALETTE.skyZenith) },
      uNightMid: { value: flat(NIGHT_PALETTE.skyMid) },
      uNightHorizon: { value: flat(NIGHT_PALETTE.skyHorizon) },
      uMoonVisualDir: { value: VISIBLE_MOON_DIR },
      uMoonCore: { value: flat(NIGHT_PALETTE.moonCore) },
      uMoonHalo: { value: flat(NIGHT_PALETTE.moonHalo) },
      uMoonCorona: { value: flat(NIGHT_PALETTE.moonCorona) },

      uOpeningArt: { value: 0 },
      uTime: { value: 0 },
    };
    const skyMat = new THREE.ShaderMaterial({
      name: 'CelSky',
      uniforms: this.skyUniforms,
      vertexShader: skyVertexShader,
      fragmentShader: skyFragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 32, 16), skyMat);
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    group.add(dome);

    // --- clouds: two atmospheric billboard layers on rings ---
    const cloudTex = makeCloudTexture();
    const remoteCloudTex = makeRemoteCloudTexture();
    this.nearMat = new THREE.SpriteMaterial({
      map: cloudTex,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.farMat = new THREE.SpriteMaterial({
      map: remoteCloudTex,
      color: flat(0xffffff),
      opacity: 0.62,
      transparent: true,
      depthWrite: false,
      fog: false,
    });

    for (let i = 0; i < CLOUD_COUNT; i++) {
      const far = i >= FAR_CLOUD_START;
      const sprite = new THREE.Sprite(far ? this.farMat : this.nearMat);
      sprite.frustumCulled = false;

      const j = far ? i - CLOUD_COUNT / 2 : i;
      this.cAngle[i] = (j / (CLOUD_COUNT / 2)) * Math.PI * 2 + hash(i, 1) * 0.6;
      this.cRadius[i] = far ? 2950 + hash(i, 2) * 820 : 1300 + hash(i, 3) * 450;
      this.cAlt[i] = far ? 320 + hash(i, 4) * 230 : 110 + hash(i, 5) * 170;
      const dir = hash(i, 6) > 0.15 ? 1 : -1;
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

  setTimeOfDay(tod: TimeOfDay, blend?: number): void {
    const b = blend !== undefined ? blend : tod === 'night' ? 1.0 : 0.0;
    const clamped = Math.max(0, Math.min(1, b));
    this.skyUniforms.uNightBlend.value = clamped;

    this.nearMat.color.lerpColors(this.dayCloudNear, this.nightCloudNear, clamped);
    this.farMat.color.lerpColors(this.dayCloudFar, this.nightCloudFar, clamped);
    this.farMat.opacity = THREE.MathUtils.lerp(0.62, 0.76, clamped);
  }

  setOpeningIntensity(value: number): void {
    this.skyUniforms.uOpeningArt.value = Math.max(0, Math.min(1, value));
  }
}
