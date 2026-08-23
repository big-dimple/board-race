/**
 * Feather particle system for rubber ducky explosive balloon impacts.
 *
 * Lightweight, preallocated InstancedMesh pool with fluttering aerodynamics:
 * high drag, low terminal velocity, sinusoidal drift, and smooth shrink-out.
 */

import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { waterHeight } from './waves';

const FEATHER_CAPACITY = 160;
const FEATHER_GRAVITY = 3.2;
const FEATHER_AIR_DRAG = 2.4;
const FEATHER_MAX_LIFETIME = 2.6;

/** Curved delicate duck down / feather geometry with a central quill ridge. */
function makeFeatherGeometry(): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  // Delicate curved leaf/feather shape (approx 0.32m long, 0.16m wide)
  const positions = new Float32Array([
    // Quill base
    0, 0, 0,
    // Left lobe
    -0.12, 0.02, 0.2,
    // Right lobe
    0.12, 0.02, 0.2,
    // Quill mid
    0, 0.03, 0.28,
    // Left tip
    -0.075, 0.015, 0.42,
    // Right tip
    0.075, 0.015, 0.42,
    // Tip
    0, 0, 0.52,
  ]);

  const indices = [
    // Base to mid lobes
    0, 1, 3,
    0, 3, 2,
    // Mid to tip lobes
    3, 1, 4,
    3, 5, 2,
    // Tip
    3, 4, 6,
    3, 6, 5,
  ];

  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

interface FeatherParticle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  vRotX: number;
  vRotY: number;
  vRotZ: number;
  flutterPhase: number;
  flutterFreq: number;
  scale: number;
  baseScale: number;
  age: number;
  lifetime: number;
}

export class FeatherSystem {
  readonly object: THREE.Group;
  private readonly mesh: THREE.InstancedMesh;
  private readonly particles: FeatherParticle[] = [];
  private readonly dummy = new THREE.Object3D();
  private activeCount = 0;

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'feather-system';

    const geometry = makeFeatherGeometry();
    const material = new THREE.MeshBasicMaterial({
      color: PALETTE.foam,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: false,
    });

    this.mesh = new THREE.InstancedMesh(geometry, material, FEATHER_CAPACITY);
    this.mesh.name = 'feathers-instanced';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 3;

    this.object.add(this.mesh);

    const yellow = new THREE.Color().setHex(PALETTE.hullKai, THREE.NoColorSpace);
    const white = new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace);
    for (let i = 0; i < FEATHER_CAPACITY; i++) this.mesh.setColorAt(i, i % 4 === 0 ? white : yellow);
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.setUsage(THREE.StaticDrawUsage);
      this.mesh.instanceColor.needsUpdate = true;
    }

    for (let i = 0; i < FEATHER_CAPACITY; i++) {
      this.particles.push({
        active: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        rotX: 0,
        rotY: 0,
        rotZ: 0,
        vRotX: 0,
        vRotY: 0,
        vRotZ: 0,
        flutterPhase: 0,
        flutterFreq: 0,
        scale: 0,
        baseScale: 1,
        age: 0,
        lifetime: FEATHER_MAX_LIFETIME,
      });
    }
  }

  /**
   * Emit a burst of fluttering yellow feathers at the specified 3D position.
   */
  burst(
    point: THREE.Vector3,
    count = 22,
    baseSpeed = 7.5,
    carryX = 0,
    carryZ = 0,
  ): void {
    let emitted = 0;
    for (let i = 0; i < FEATHER_CAPACITY && emitted < count; i++) {
      const p = this.particles[i];
      if (p.active) continue;

      p.active = true;
      p.x = point.x + (Math.random() - 0.5) * 0.3;
      p.y = point.y + (Math.random() - 0.5) * 0.3;
      p.z = point.z + (Math.random() - 0.5) * 0.3;

      // Radial burst with an upward bias, slightly diffused
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * (Math.PI * 0.6); // bias upward
      const speed = baseSpeed * (0.5 + Math.random() * 0.7);

      p.vx = Math.sin(phi) * Math.cos(theta) * speed + carryX * 0.82;
      p.vy = Math.cos(phi) * speed + 1.5 + Math.random() * 1.6;
      p.vz = Math.sin(phi) * Math.sin(theta) * speed + carryZ * 0.82;

      p.rotX = Math.random() * Math.PI * 2;
      p.rotY = Math.random() * Math.PI * 2;
      p.rotZ = Math.random() * Math.PI * 2;

      p.vRotX = (Math.random() - 0.5) * 10;
      p.vRotY = (Math.random() - 0.5) * 14;
      p.vRotZ = (Math.random() - 0.5) * 10;

      p.flutterPhase = Math.random() * Math.PI * 2;
      p.flutterFreq = 5.5 + Math.random() * 3.5;
      p.baseScale = 1.0 + Math.random() * 0.55;
      p.scale = p.baseScale;
      p.age = 0;
      p.lifetime = 2.0 + Math.random() * 0.9;

      emitted++;
    }
  }

  update(dt: number, time: number): void {
    let activeIdx = 0;

    for (let i = 0; i < FEATHER_CAPACITY; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      p.age += dt;
      if (p.age >= p.lifetime) {
        p.active = false;
        continue;
      }

      // Air resistance and low gravity
      p.vx *= Math.max(0, 1 - FEATHER_AIR_DRAG * dt);
      p.vz *= Math.max(0, 1 - FEATHER_AIR_DRAG * dt);
      p.vy -= FEATHER_GRAVITY * dt;
      // Cap downward terminal sink speed
      if (p.vy < -1.6) p.vy = -1.6;

      // Sinusoidal leaf-drift (flutter)
      p.flutterPhase += dt * p.flutterFreq;
      const driftX = Math.sin(p.flutterPhase) * 1.1;
      const driftZ = Math.cos(p.flutterPhase * 0.8) * 1.1;

      p.x += (p.vx + driftX) * dt;
      p.y += p.vy * dt;
      p.z += (p.vz + driftZ) * dt;

      p.rotX += p.vRotX * dt;
      p.rotY += p.vRotY * dt;
      p.rotZ += (p.vRotZ + Math.sin(p.flutterPhase) * 5.0) * dt;

      // Fade/shrink out near end of life or near water surface
      const waterY = waterHeight(p.x, p.z, time);
      const lifeFrac = p.age / p.lifetime;
      let scale = p.baseScale;
      if (lifeFrac > 0.6) {
        scale *= 1 - (lifeFrac - 0.6) / 0.4;
      }
      if (p.y <= waterY + 0.08) {
        p.y = waterY + 0.08;
        p.vy = 0;
        scale *= Math.max(0, 1 - dt * 4.5);
        if (scale <= 0.04) {
          p.active = false;
          continue;
        }
      }

      p.scale = scale;

      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.rotation.set(p.rotX, p.rotY, p.rotZ);
      this.dummy.scale.setScalar(p.scale);
      this.dummy.updateMatrix();

      this.mesh.setMatrixAt(activeIdx, this.dummy.matrix);
      activeIdx++;
    }

    this.activeCount = activeIdx;
    this.mesh.count = activeIdx;
    if (activeIdx > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  clear(): void {
    for (let i = 0; i < FEATHER_CAPACITY; i++) {
      this.particles[i].active = false;
    }
    this.mesh.count = 0;
    this.activeCount = 0;
  }

  debugState(): { activeFeathers: number; capacity: number } {
    return {
      activeFeathers: this.activeCount,
      capacity: FEATHER_CAPACITY,
    };
  }
}
