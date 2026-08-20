import * as THREE from 'three';
import type { RenderQualityMode } from '../core/stage';
import { PALETTE } from '../core/palette';
import { waterHeight } from './waves';

const UP = new THREE.Vector3(0, 1, 0);

function makeBirdGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.9, 0.08, 0, -0.12, -0.05, 0, 0, 0.08, 0,
    0, 0.08, 0, 0.12, -0.05, 0, 0.9, 0.08, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  geometry.computeBoundingSphere();
  return geometry;
}

function setHidden(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = Math.max(0, Math.min(mesh.instanceMatrix.count, count));
}

/**
 * Low-frequency, visual-only sea life. The ring follows the camera so the
 * ocean never needs a second world-sized environment mesh. All repetition is
 * instanced and the near action corridor is intentionally left empty.
 */
export class SeaDecor {
  readonly object: THREE.Group;

  private readonly sails: THREE.InstancedMesh;
  private readonly birds: THREE.InstancedMesh;
  private readonly quality: RenderQualityMode;
  private opening = false;
  private readonly marker = new THREE.Object3D();
  private readonly sailCapacity: number;
  private readonly birdCapacity: number;

  constructor(quality: RenderQualityMode = 'auto') {
    this.quality = quality;
    this.object = new THREE.Group();
    this.object.name = 'sea-decor';

    this.sailCapacity = quality === 'performance' ? 10 : 18;
    this.birdCapacity = quality === 'performance' ? 3 : 8;

    const sailGeometry = new THREE.ConeGeometry(0.58, 1.45, 4, 1, true);
    sailGeometry.rotateX(Math.PI / 2);
    const sailMaterial = new THREE.MeshBasicMaterial({
      color: PALETTE.cloudBody,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.sails = new THREE.InstancedMesh(sailGeometry, sailMaterial, this.sailCapacity);
    this.sails.name = 'sea-decor-sails';
    this.sails.frustumCulled = false;
    this.sails.renderOrder = 2;

    const birdMaterial = new THREE.MeshBasicMaterial({
      color: PALETTE.ink,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.birds = new THREE.InstancedMesh(makeBirdGeometry(), birdMaterial, this.birdCapacity);
    this.birds.name = 'sea-decor-birds';
    this.birds.frustumCulled = false;
    this.birds.renderOrder = 3;

    this.object.add(this.sails, this.birds);
    this.setOpening(false);
  }

  setOpening(active: boolean): void {
    this.opening = active;
    setHidden(this.sails, active ? this.sailCapacity : Math.round(this.sailCapacity * 0.58));
    setHidden(this.birds, active ? this.birdCapacity : Math.round(this.birdCapacity * 0.35));
  }

  update(t: number, camPos: THREE.Vector3): void {
    this.object.position.set(camPos.x, 0, camPos.z);
    const sailCount = this.sails.count;
    for (let i = 0; i < sailCount; i++) {
      const angle = i * 2.399963 + 0.22 + Math.sin(t * 0.018 + i) * 0.018;
      const radius = 96 + (i % 6) * 28 + (i % 3) * 5;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const worldX = camPos.x + x;
      const worldZ = camPos.z + z;
      const wave = waterHeight(worldX, worldZ, t);
      this.marker.position.set(x, wave + 0.72 + (i % 3) * 0.08, z);
      this.marker.rotation.set(0, -angle + Math.sin(t * 0.45 + i) * 0.06, 0);
      const scale = 0.72 + (i % 4) * 0.12;
      this.marker.scale.set(scale, scale, scale);
      this.marker.updateMatrix();
      this.sails.setMatrixAt(i, this.marker.matrix);
    }
    this.sails.instanceMatrix.needsUpdate = true;

    const birdCount = this.birds.count;
    for (let i = 0; i < birdCount; i++) {
      const angle = i * 2.87 + 0.5;
      const radius = 118 + (i % 4) * 37;
      const x = Math.cos(angle + t * (0.006 + i * 0.0003)) * radius;
      const z = Math.sin(angle + t * (0.006 + i * 0.0003)) * radius;
      this.marker.position.set(x, 10.5 + (i % 3) * 4.2 + Math.sin(t * 1.2 + i) * 0.6, z);
      this.marker.rotation.set(0, Math.sin(t * 0.7 + i) * 0.08, Math.sin(t * 1.3 + i) * 0.06);
      this.marker.scale.setScalar(0.56 + (i % 2) * 0.18);
      this.marker.updateMatrix();
      this.birds.setMatrixAt(i, this.marker.matrix);
    }
    this.birds.instanceMatrix.needsUpdate = true;
  }
}
