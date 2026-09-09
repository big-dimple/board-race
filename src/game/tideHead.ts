import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import {
  VRMSpringBoneCollider, VRMSpringBoneColliderShapeSphere,
  VRMSpringBoneJoint, VRMSpringBoneManager,
} from '@pixiv/three-vrm-springbone';
import { createToonMaterial } from '../cel/toonMaterial';
import tideUrl from '../assets/models/tide.glb?url';

let template: THREE.Group | null = null;
let loading: Promise<void> | null = null;

/** One shared asset, decoded before roster construction; failures keep the old rider playable. */
export function loadTideHead(): Promise<void> {
  return loading ??= (async () => {
    const loader = new GLTFLoader();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(tideUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`Tide GLB: HTTP ${response.status}`);
      const gltf = await loader.parseAsync(await response.arrayBuffer(), '');
      gltf.scene.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const old = node.material as THREE.MeshStandardMaterial;
        const face = node.name === 'tide-head';
        // This project's cel pipeline writes authored RGB directly, without an output conversion.
        if (old.map) old.map.colorSpace = THREE.NoColorSpace;
        node.material = createToonMaterial({
          color: 0xffffff, map: face ? old.map ?? undefined : undefined,
          vertexColors: !face, rimStrength: face ? .08 : .18,
          rimThreshold: .88, specThreshold: .99,
        });
        node.material.name = face ? 'TideSkinToon' : 'TideHairToon';
        node.userData.noInk = false;
        node.frustumCulled = false;
        old.dispose();
      });
      template = gltf.scene;
    } catch (error) {
      console.warn('Tide head unavailable; using the original rider.', error);
    } finally {
      window.clearTimeout(timeout);
    }
  })();
}

export function hasTideHead(driverId: string): boolean {
  return driverId === 'tide' && template !== null;
}

const STEP = 1 / 120;
const GROUPS = ['fringe', 'left', 'right', 'back'] as const;

/** Presentation-only spring bones. The scene stays attached to the real rider head. */
export class TideHead {
  readonly object = clone(template!) as THREE.Group;
  readonly manager = new VRMSpringBoneManager();
  readonly bones: THREE.Object3D[] = [];
  private readonly colliders: VRMSpringBoneCollider[] = [];
  private readonly joints: VRMSpringBoneJoint[] = [];
  private readonly previousPosition = new THREE.Vector3();
  private readonly previousRotation = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly inverse = new THREE.Matrix4();
  private readonly intermediate = new THREE.Matrix4();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly interpPosition = new THREE.Vector3();
  private readonly interpRotation = new THREE.Quaternion();
  private readonly force = new THREE.Vector3();
  private readonly flow = new THREE.Vector3();
  private remainder = 0;
  private initialized = false;
  private landing = 0;

  constructor(private readonly head: THREE.Bone, chest: THREE.Bone) {
    this.object.name = 'tide-authored-head';
    head.add(this.object);
    const collider = (parent: THREE.Object3D, p: THREE.Vector3, radius: number) => {
      const value = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeSphere({ offset: p, radius }));
      parent.add(value);
      this.colliders.push(value);
      return value;
    };
    collider(this.object, new THREE.Vector3(0, .132, -.004), .096);
    collider(this.object, new THREE.Vector3(0, .05, .0), .061);
    collider(chest, new THREE.Vector3(.15, .07, .01), .073);
    collider(chest, new THREE.Vector3(-.15, .07, .01), .073);
    const colliderGroups = [{ colliders: this.colliders }];
    this.object.updateWorldMatrix(true, true);
    for (const group of GROUPS) {
      for (const suffix of ['a', 'b'] as const) {
        const bone = this.object.getObjectByName(`${group}-${suffix}`)!;
        const child = this.object.getObjectByName(`${group}-${suffix === 'a' ? 'b' : 'tip'}`)!;
        if (!bone || !child) throw new Error(`Tide hair is missing ${group}-${suffix}`);
        const joint = new VRMSpringBoneJoint(bone, child, {
          stiffness: group === 'fringe' ? 3.0 : suffix === 'a' ? 1.8 : .9,
          dragForce: .28, gravityPower: .22, hitRadius: .008,
        }, colliderGroups);
        this.manager.addJoint(joint);
        this.joints.push(joint);
        this.bones.push(bone);
      }
    }
    this.manager.setInitState();
  }

  collectLanding(impulse: number): void {
    this.landing = Math.min(20, this.landing + Math.max(0, impulse));
  }

  reset(): void {
    this.initialized = false;
    this.remainder = 0;
    this.landing = 0;
  }

  update(dt: number, velocity: THREE.Vector3, time: number): void {
    if (dt <= 0) return;
    this.object.updateWorldMatrix(true, true);
    this.object.getWorldPosition(this.position);
    this.object.getWorldQuaternion(this.rotation);
    if (!this.initialized || this.position.distanceToSquared(this.previousPosition) > 16 || dt > .25) {
      this.manager.reset();
      this.previousPosition.copy(this.position);
      this.previousRotation.copy(this.rotation);
      this.initialized = true;
      this.remainder = 0;
      this.landing = 0;
    }
    this.remainder += Math.min(dt, STEP * 8);
    const steps = Math.min(8, Math.floor((this.remainder + 1e-9) / STEP));
    if (steps === 0) return;
    this.remainder -= steps * STEP;
    this.inverse.copy(this.head.matrixWorld).invert();
    // Real relative flow provides the sustained force; moving roots provide inertial lag.
    this.flow.copy(velocity).multiplyScalar(-.012).clampLength(0, .6);
    this.flow.x += .025 * Math.sin(time * 1.3) + .035;
    this.flow.z += .018 * Math.sin(time * .7);
    for (let i = 0; i < steps; i++) {
      const t = (i + 1) / steps;
      this.interpPosition.lerpVectors(this.previousPosition, this.position, t);
      this.interpRotation.slerpQuaternions(this.previousRotation, this.rotation, t);
      this.intermediate.compose(this.interpPosition, this.interpRotation, this.scale);
      this.object.matrix.multiplyMatrices(this.inverse, this.intermediate);
      this.object.matrixAutoUpdate = false;
      this.object.updateWorldMatrix(false, true);
      this.force.copy(this.flow);
      this.force.y -= .22;
      if (i === 0) this.force.y += this.landing * .012;
      const magnitude = this.force.length();
      this.force.normalize();
      for (const joint of this.joints) {
        joint.settings.gravityDir.copy(this.force);
        joint.settings.gravityPower = magnitude;
      }
      this.manager.update(STEP);
    }
    this.landing = 0;
    this.object.matrix.identity();
    this.object.updateWorldMatrix(false, true);
    this.previousPosition.copy(this.position);
    this.previousRotation.copy(this.rotation);
  }

  debug() {
    return {
      source: 'tide.glb', dynamicJoints: this.joints.length,
      rotations: this.bones.map((bone) => bone.quaternion.toArray()),
      pendingLanding: this.landing,
    };
  }

  dispose(): void {
    for (const collider of this.colliders) collider.removeFromParent();
    this.object.traverse((node) => {
      if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose();
    });
    this.object.removeFromParent();
  }
}
