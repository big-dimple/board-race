import * as THREE from 'three';

/**
 * Near-miss detonations for dodged missiles. The pool is pre-allocated: a
 * blast is three expanding cel-shade spheres plus a flat water ring, all
 * MeshBasicMaterial like the missile body, so a deflected missile reads as a
 * real explosion beside the boat instead of silently vanishing.
 */

const BLAST_DURATION = 0.9;
const POOL_SIZE = 4;

const coreMat = new THREE.MeshBasicMaterial({
  color: 0xfff6c8, transparent: true, opacity: 0.95,
  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
});
const flameMat = new THREE.MeshBasicMaterial({
  color: 0xff6a00, transparent: true, opacity: 0.9,
  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
});
const smokeMat = new THREE.MeshBasicMaterial({
  color: 0x2a2e33, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false,
});
const ringMat = new THREE.MeshBasicMaterial({
  color: 0xffa040, transparent: true, opacity: 0.85,
  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
});

const coreGeo = new THREE.IcosahedronGeometry(1, 1);
const flameGeo = new THREE.IcosahedronGeometry(1, 0);
const smokeGeo = new THREE.IcosahedronGeometry(1, 0);
const ringGeo = new THREE.RingGeometry(0.82, 1.0, 40);
ringGeo.rotateX(-Math.PI / 2);

class Blast {
  readonly group: THREE.Group;
  private readonly core: THREE.Mesh;
  private readonly flame: THREE.Mesh;
  private readonly smoke: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  /** Module-internal: the pool steals the oldest active slot on overflow. */
  age = Number.POSITIVE_INFINITY;

  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.userData.noInk = true;
    this.group.userData.noOutline = true;
    this.core = new THREE.Mesh(coreGeo, coreMat.clone());
    this.flame = new THREE.Mesh(flameGeo, flameMat.clone());
    this.smoke = new THREE.Mesh(smokeGeo, smokeMat.clone());
    this.ring = new THREE.Mesh(ringGeo, ringMat.clone());
    this.group.add(this.core, this.flame, this.smoke, this.ring);
  }

  spawn(x: number, y: number, z: number): void {
    this.age = 0;
    this.group.position.set(x, y, z);
    this.group.visible = true;
  }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.age += dt;
    const k = this.age / BLAST_DURATION;
    if (k >= 1) {
      this.group.visible = false;
      return;
    }
    // Fireball flashes out fast, smoke lingers, ring races across the water.
    const flash = Math.max(0, 1 - k / 0.5);
    this.core.scale.setScalar(1.6 + k * 6.0);
    (this.core.material as THREE.MeshBasicMaterial).opacity = 0.95 * flash;
    this.flame.scale.setScalar(2.4 + k * 7.5);
    (this.flame.material as THREE.MeshBasicMaterial).opacity = 0.9 * Math.max(0, 1 - k / 0.72);
    this.smoke.scale.set(3.0 + k * 9.0, 2.2 + k * 6.5, 3.0 + k * 9.0);
    (this.smoke.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k);
    const ringRadius = 2.0 + k * 15.0;
    this.ring.scale.set(ringRadius, 1, ringRadius);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * Math.max(0, 1 - k / 0.7);
  }
}

export class MissileBlastPool {
  readonly object: THREE.Group;
  private readonly blasts: Blast[] = [];

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'missile-blast-pool';
    for (let i = 0; i < POOL_SIZE; i++) {
      const blast = new Blast();
      this.blasts.push(blast);
      this.object.add(blast.group);
    }
  }

  /** Upload every blast material before the first race, not on the first explosion. */
  warmup(renderer: THREE.WebGLRenderer): void {
    const scene = new THREE.Scene();
    const preview = this.object.clone(true);
    preview.traverse((child) => { child.visible = true; child.frustumCulled = false; });
    scene.add(preview);
    const target = new THREE.WebGLRenderTarget(32, 32);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 6, 16);
    camera.lookAt(0, 0, 0);
    const previous = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(previous);
      target.dispose();
    }
  }

  /** Oldest-free slot wins; overlapping launches are bounded by the pool size. */
  spawn(x: number, y: number, z: number): void {
    let target = this.blasts[0];
    for (const blast of this.blasts) {
      if (!blast.group.visible) {
        target = blast;
        break;
      }
      if (blast.age > target.age) target = blast;
    }
    target.spawn(x, y, z);
  }

  update(dt: number): void {
    for (const blast of this.blasts) blast.update(dt);
  }

  /** Harness-only lifecycle probe; production only spawns on real near-misses. */
  debugState(): { active: number } {
    let active = 0;
    for (const blast of this.blasts) if (blast.group.visible) active++;
    return { active };
  }
}
