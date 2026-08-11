/**
 * sky.ts — anime sky dome: banded gradient, hard sun disc with a ring of
 * separated rectangular rays, and flat cel clouds on two parallax layers.
 *
 * Everything here is graphic, never photographic: hard color bands, hard
 * disc, hard rectangular rays, crisp cloud silhouettes. No bloom anywhere —
 * the rays are geometry-in-shader, not glow.
 *
 * The whole rig follows the camera (infinite-ocean illusion); clouds live
 * on fixed-radius rings around it at two depths, with the near layer
 * drifting faster than the far one for a parallax read. All per-frame
 * state is preallocated — update() allocates nothing.
 *
 * Color pipeline: palette hex values are used verbatim (NoColorSpace /
 * canvas bytes) and nothing in the pipeline tone-maps or converts, so
 * authored colors are exactly what hits the screen.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { SUN_DIR } from './toonMaterial';

const SKY_RADIUS = 4500;
const CLOUD_COUNT = 16; // 8 near + 8 far

/** Deterministic hash → 0..1 (stable cloud layout across runs/screenshots). */
function hash(i: number, k: number): number {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Palette hex int → CSS '#rrggbb' for canvas fills. */
function css(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
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
uniform vec3 uSunDir;    // normalized, TOWARD the sun
uniform vec3 uSunCore;
uniform vec3 uSunFlare;
uniform float uTime;     // seconds — drives the slow ray rotation

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
  // SUN — ONE hard disc + a ring of separated rectangular rays
  // (GGXrd-style graphic sun). Angular distance/azimuth around the
  // sun direction drive everything; every shape is a hard step.
  // ---------------------------------------------------------------
  float ang = acos(clamp(dot(dir, uSunDir), -1.0, 1.0)); // radians off-sun
  vec3 t0 = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
  vec3 t1 = cross(t0, uSunDir);
  float az = atan(dot(dir, t1), dot(dir, t0)); // azimuth around the sun

  // Hard core disc (~2.3 degrees).
  float disc = 1.0 - step(0.040, ang);
  // Thin hard ring hugging the disc.
  float ring0 = step(0.040, ang) * (1.0 - step(0.052, ang));
  // 12 rectangular rays, separated by gaps, ALTERNATING long/short radial
  // extents — identical dashes read as a loading spinner; staggered lengths
  // read as a graphic sunburst. Rotation advances in HARD steps (no sweep).
  float rot = floor(uTime * 1.5) * 0.004;
  float seg = 6.28318530718 / 12.0;
  float rayAz = 1.0 - step(seg * 0.24, abs(mod(az + rot, seg) - seg * 0.5));
  float longRay = step(0.5, mod(floor((az + rot) / seg), 2.0));
  float rayEnd = mix(0.125, 0.19, longRay);
  float rays = rayAz * step(0.075, ang) * (1.0 - step(rayEnd, ang));

  col = mix(col, uSunFlare, max(ring0, rays));
  col = mix(col, uSunCore, disc);

  gl_FragColor = vec4(col, 1.0);
}
`;

// -------------------------------------------------------------- clouds ----

/**
 * Puffy cloud silhouette on canvas: rim color first, body shifted down over
 * it (leaving a hard sun-side rim crescent on top), then a hard horizontal
 * shade band across the bottom clipped by the silhouette. Zero blur, zero
 * gradients — flat graphic shapes only.
 */
function makeCloudTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 160;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  // One puffy silhouette path (flat-bottomed cluster of hard circles).
  const puff = (dy: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(128, 122 + dy, 84, 30, 0, 0, Math.PI * 2); // flat base
    ctx.arc(84, 100 + dy, 30, 0, Math.PI * 2);
    ctx.arc(124, 82 + dy, 40, 0, Math.PI * 2);
    ctx.arc(168, 98 + dy, 32, 0, Math.PI * 2);
    ctx.arc(196, 114 + dy, 22, 0, Math.PI * 2);
    ctx.fill();
  };

  puff(0, css(PALETTE.cloudRim)); // full silhouette in the rim color
  puff(8, css(PALETTE.cloudBody)); // body shifted down => hard top rim crescent
  // Hard bottom shade band, clipped to the pixels drawn so far.
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = css(PALETTE.cloudShade);
  ctx.fillRect(0, 116, w, h - 116);
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // canvas bytes verbatim
  return tex;
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
      uSunDir: { value: SUN_DIR },
      uSunCore: { value: flat(PALETTE.sunCore) },
      uSunFlare: { value: flat(PALETTE.sunFlare) },
      uTime: { value: 0 },
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

    // --- clouds: 2 parallax layers of flat billboards on rings ---
    const cloudTex = makeCloudTexture();
    const nearMat = new THREE.SpriteMaterial({
      map: cloudTex,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const farMat = new THREE.SpriteMaterial({
      map: cloudTex,
      // Far layer tinted toward the horizon color: distance cue, still flat.
      color: flat(PALETTE.skyHorizon),
      transparent: true,
      depthWrite: false,
      fog: false,
    });

    for (let i = 0; i < CLOUD_COUNT; i++) {
      const far = i >= CLOUD_COUNT / 2;
      const sprite = new THREE.Sprite(far ? farMat : nearMat);
      sprite.frustumCulled = false; // always inside the camera-centered rig

      const j = far ? i - CLOUD_COUNT / 2 : i;
      // Evenly spaced ring + deterministic jitter; two depth bands.
      this.cAngle[i] = (j / (CLOUD_COUNT / 2)) * Math.PI * 2 + hash(i, 1) * 0.6;
      this.cRadius[i] = far ? 2600 + hash(i, 2) * 700 : 1300 + hash(i, 3) * 450;
      this.cAlt[i] = far ? 260 + hash(i, 4) * 260 : 110 + hash(i, 5) * 170;
      // Slow drift; the near layer sweeps faster => parallax between layers.
      const dir = hash(i, 6) > 0.15 ? 1 : -1; // mostly one way, a few rebels
      this.cOmega[i] = dir * (far ? 0.0018 : 0.0042) * (0.7 + hash(i, 7) * 0.6);

      const sx = far ? 620 + hash(i, 8) * 260 : 250 + hash(i, 9) * 130;
      sprite.scale.set(sx, sx * 0.62, 1);
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
}
