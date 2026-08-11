import * as THREE from 'three';
import { LAYER_ENERGY } from '../contracts';
import type { IJetTrail } from '../contracts';

const COUNT = 160;

/** One preallocated world-space shard pool shared by every racer. */
export class JetTrailSystem implements IJetTrail {
  readonly object: THREE.InstancedMesh;

  private readonly px = new Float32Array(COUNT);
  private readonly py = new Float32Array(COUNT);
  private readonly pz = new Float32Array(COUNT);
  private readonly vx = new Float32Array(COUNT);
  private readonly vy = new Float32Array(COUNT);
  private readonly vz = new Float32Array(COUNT);
  private readonly size = new Float32Array(COUNT);
  private readonly life = new Float32Array(COUNT);
  private readonly maxLife = new Float32Array(COUNT);
  private readonly spin = new Float32Array(COUNT);
  private cursor = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly color = new THREE.Color();

  constructor() {
    const geometry = new THREE.OctahedronGeometry(1, 0);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.object = new THREE.InstancedMesh(geometry, material, COUNT);
    this.object.name = 'jet-trail';
    this.object.frustumCulled = false;
    this.object.renderOrder = 7;
    this.object.layers.enable(LAYER_ENERGY);
    this.object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < COUNT; i++) this.object.setMatrixAt(i, this.hidden);
    this.object.instanceMatrix.needsUpdate = true;
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    color: number,
    size: number,
    life: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % COUNT;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.spin[i] = ((i * 1.6180339) % 1) * Math.PI * 2;
    this.object.setColorAt(i, this.color.setHex(color, THREE.NoColorSpace));
    if (this.object.instanceColor) this.object.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < COUNT; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] = Math.max(0, this.life[i] - dt);
      if (this.life[i] <= 0) {
        this.object.setMatrixAt(i, this.hidden);
        dirty = true;
        continue;
      }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.vy[i] += 0.35 * dt;
      const n = this.life[i] / this.maxLife[i];
      const s = this.size[i] * n;
      this.position.set(this.px[i], this.py[i], this.pz[i]);
      this.scale.set(s, s * 0.42, s);
      this.euler.set(this.spin[i] + (1 - n) * 2.4, this.spin[i] * 0.7, this.spin[i] * 1.3);
      this.quaternion.setFromEuler(this.euler);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.object.setMatrixAt(i, this.matrix);
      dirty = true;
    }
    if (dirty) this.object.instanceMatrix.needsUpdate = true;
  }
}
