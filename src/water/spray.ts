/**
 * spray.ts — chunky anime spray droplets. ONE instanced draw call.
 *
 * Instanced billboards (custom shader, camera-facing quads from the view
 * matrix), hard-edged canvas droplet sprite (white pixel cluster, 1 px
 * darker-aqua rim, NearestFilter, alpha-cutout — no soft blending).
 *
 * CPU physics at this count is trivial and keeps the shader dumb:
 * up-biased cone velocity, gravity 14 m/s^2, linear drag, life 0.7-1.1 s,
 * size shrinks in 3 hard classes as the particle ages. Particles are killed
 * when they fall below the live wave surface (waterHeight from waves.ts);
 * fast impacts optionally pop one tiny secondary poof. Ring-cursor
 * recycling — zero allocation after construction.
 */

import * as THREE from 'three';
import type { ISpray } from '../contracts';
import { PALETTE } from '../core/palette';
import { waterHeight } from './waves';

const GRAVITY = 14.0; // m/s^2
const DRAG = 1.15; // linear damping factor per second
const POOF_SPEED = -2.5; // downward impact speed that triggers a poof

/** Deterministic tiny PRNG for texture generation (stable screenshots). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hard-edged droplet: chunky white cluster with a 1 px darker aqua edge. */
function makeDropletTexture(): THREE.CanvasTexture {
  const S = 32;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const rng = mulberry32(1337);
  const body = new THREE.Color(PALETTE.foam);
  const edge = new THREE.Color(PALETTE.waterCrest).multiplyScalar(0.45); // darker aqua
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - 15.5;
      const dy = (y - 15.5) * 1.25; // slightly tall droplet
      // chebyshev distance + per-pixel jitter => blocky irregular blob
      const d = Math.max(Math.abs(dx), Math.abs(dy)) + rng() * 3.2;
      if (d >= 6.5) continue; // transparent outside
      const c = d > 5.2 ? edge : body;
      const i = (y * S + x) * 4;
      img.data[i] = Math.round(c.r * 255);
      img.data[i + 1] = Math.round(c.g * 255);
      img.data[i + 2] = Math.round(c.b * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const VERT = /* glsl */ `
attribute vec3 aPos;   // world position of the particle
attribute float aSize; // world size of the quad (0 = dead, GPU culls it)
attribute float aShade; // 0 bright / 1 mid / 2 poof — hard tint steps

varying vec2 vUv;
varying float vShade;

void main() {
  vUv = uv;
  vShade = aShade;
  // billboard: camera right/up are the view matrix rows
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = aPos + (right * position.x + up * position.y) * aSize;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uTex;

varying vec2 vUv;
varying float vShade;

void main() {
  vec4 tex = texture2D(uTex, vUv);
  if (tex.a < 0.5) discard; // hard cutout — graphic, never soft
  vec3 col = tex.rgb;
  if (vShade > 1.5) col *= 0.72;
  else if (vShade > 0.5) col *= 0.86;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export class SpraySystem implements ISpray {
  readonly object: THREE.Object3D;

  private readonly capacity: number;

  // particle state (structure-of-arrays, preallocated)
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly shade: Float32Array;
  private cursor = 0;

  // instanced attribute backing arrays
  private readonly aPos: Float32Array;
  private readonly aSize: Float32Array;
  private readonly aShade: Float32Array;
  private readonly attrPos: THREE.InstancedBufferAttribute;
  private readonly attrSize: THREE.InstancedBufferAttribute;
  private readonly attrShade: THREE.InstancedBufferAttribute;

  constructor(capacity: number = 1536) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.shade = new Float32Array(capacity);
    this.aPos = new Float32Array(capacity * 3);
    this.aSize = new Float32Array(capacity);
    this.aShade = new Float32Array(capacity);

    // base quad, instanced
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const dyn = THREE.DynamicDrawUsage;
    this.attrPos = new THREE.InstancedBufferAttribute(this.aPos, 3).setUsage(dyn);
    this.attrSize = new THREE.InstancedBufferAttribute(this.aSize, 1).setUsage(dyn);
    this.attrShade = new THREE.InstancedBufferAttribute(this.aShade, 1).setUsage(dyn);
    geometry.setAttribute('aPos', this.attrPos);
    geometry.setAttribute('aSize', this.attrSize);
    geometry.setAttribute('aShade', this.attrShade);
    geometry.instanceCount = capacity;

    const material = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: makeDropletTexture() } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.FrontSide,
      transparent: false, // alpha-cutout: stays in the opaque pass, writes depth
      depthWrite: true,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    this.object = mesh;
  }

  burst(pos: THREE.Vector3, count: number, speed: number): void {
    const n = Math.min(count, this.capacity);
    for (let i = 0; i < n; i++) {
      // up-biased cone: random azimuth, limited horizontal spread, strong up
      const az = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.6;
      const dx = Math.cos(az) * r;
      const dy = 0.7 + Math.random() * 0.5;
      const dz = Math.sin(az) * r;
      const il = 1 / Math.hypot(dx, dy, dz);
      const s = speed * (0.5 + Math.random() * 0.6) * il;
      this.spawn(
        pos.x + (Math.random() - 0.5) * 0.3,
        pos.y + 0.05,
        pos.z + (Math.random() - 0.5) * 0.3,
        dx * s,
        dy * s,
        dz * s,
        0.7 + Math.random() * 0.4,
        // small hard droplets: tight size range, hard cap — no huge quads
        Math.min(0.3, (0.06 + 0.014 * speed) * (0.7 + Math.random() * 0.4)),
        Math.random() < 0.25 ? 1 : 0,
      );
    }
  }

  update(dt: number, t: number): void {
    const drag = Math.max(0, 1 - DRAG * dt);
    const cap = this.capacity;
    for (let i = 0; i < cap; i++) {
      if (this.life[i] <= 0) {
        this.aSize[i] = 0;
        continue;
      }
      const i3 = i * 3;
      // integrate
      this.vel[i3 + 1] -= GRAVITY * dt;
      this.vel[i3] *= drag;
      this.vel[i3 + 1] *= drag;
      this.vel[i3 + 2] *= drag;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.life[i] -= dt;

      // kill at the live water surface, with an optional tiny poof
      const surf = waterHeight(this.pos[i3], this.pos[i3 + 2], t);
      if (this.pos[i3 + 1] < surf) {
        if (this.vel[i3 + 1] < POOF_SPEED && this.shade[i] < 2) {
          this.spawn(
            this.pos[i3],
            surf + 0.05,
            this.pos[i3 + 2],
            (Math.random() - 0.5) * 0.8,
            0.9 + Math.random() * 0.4,
            (Math.random() - 0.5) * 0.8,
            0.32,
            this.size0[i] * 0.65,
            2,
          );
        }
        this.life[i] = 0;
        this.aSize[i] = 0;
        continue;
      }
      if (this.life[i] <= 0) {
        this.aSize[i] = 0;
        continue;
      }

      // stepped size classes as the particle ages — hard shrink, no lerp
      const ageF = 1 - this.life[i] / this.maxLife[i];
      const cls = ageF < 0.35 ? 1.0 : ageF < 0.7 ? 0.6 : 0.35;
      this.aPos[i3] = this.pos[i3];
      this.aPos[i3 + 1] = this.pos[i3 + 1];
      this.aPos[i3 + 2] = this.pos[i3 + 2];
      this.aSize[i] = this.size0[i] * cls;
      this.aShade[i] = this.shade[i];
    }
    this.attrPos.needsUpdate = true;
    this.attrSize.needsUpdate = true;
    this.attrShade.needsUpdate = true;
  }

  /** Write one particle into the next ring slot. No allocation, ever. */
  private spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, shade: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.shade[i] = shade;
  }
}
