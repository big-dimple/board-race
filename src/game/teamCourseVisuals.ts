import * as THREE from 'three';
import type { Course } from './course';
import { waterHeight } from '../water/waves';
import { LAYER_ENERGY } from '../contracts';

export type TeamVisualMode = 'tutorial' | 'resonance' | 'locks' | 'sky';
export type TeamMarkerKind = 'drive' | 'source' | 'receiver' | 'anchor' | 'runner' | 'control' | 'dock';

export interface TeamTargetVisual {
  u: number;
  lateral: number;
  visible: boolean;
  active: boolean;
  complete: boolean;
  kind: TeamMarkerKind;
}

export interface TeamVisualState {
  mode: TeamVisualMode;
  left: TeamTargetVisual;
  right: TeamTargetVisual;
  pulseActive: boolean;
  pulseProgress: number;
  pulseFromU: number;
  pulseFromLateral: number;
  pulseToU: number;
  pulseToLateral: number;
  lockU: number;
  lockPower: number;
  skyRouteIndex: number;
  skyGateOffset: number;
  skyPowered: boolean;
}

const CYAN = 0x2de4e0;
const LIME = 0xc5f33b;
const CORAL = 0xff536e;
const INK = 0x080b18;
const UP = new THREE.Vector3(0, 1, 0);
const _worldTangent = new THREE.Vector3();

interface TargetMarker {
  group: THREE.Group;
  ring: THREE.MeshBasicMaterial;
  core: THREE.MeshBasicMaterial;
  arrow: THREE.MeshBasicMaterial;
}

/** Shared physical affordances for the three cooperation stations. */
export class TeamCourseVisuals {
  readonly object = new THREE.Group();
  private readonly left = targetMarker(CYAN);
  private readonly right = targetMarker(LIME);
  private readonly pulse: THREE.Mesh;
  private readonly pulseHalo: THREE.Mesh;
  private readonly lock: THREE.Group;
  private readonly lockMaterial: THREE.MeshBasicMaterial;
  private readonly tether: THREE.Mesh;
  private readonly tetherMaterial: THREE.MeshBasicMaterial;
  private readonly scratch = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private state: TeamVisualState | null = null;

  constructor(private readonly course: Course) {
    this.object.name = 'team-course-visuals';
    this.object.add(this.left.group, this.right.group);

    this.pulse = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.72, 1),
      energyMaterial(0xf8fff0, 0.96),
    );
    this.pulse.name = 'team-resonance-pulse';
    this.pulse.layers.enable(LAYER_ENERGY);
    this.pulseHalo = new THREE.Mesh(
      new THREE.RingGeometry(0.95, 1.25, 24),
      energyMaterial(CYAN, 0.66),
    );
    this.pulseHalo.layers.enable(LAYER_ENERGY);
    this.pulse.add(this.pulseHalo);
    this.object.add(this.pulse);

    const lock = lockFrame();
    this.lock = lock.group;
    this.lockMaterial = lock.material;
    this.object.add(this.lock);

    this.tetherMaterial = energyMaterial(LIME, 0.58);
    this.tether = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1, 7), this.tetherMaterial);
    this.tether.layers.enable(LAYER_ENERGY);
    this.object.add(this.tether);
    this.object.visible = false;
  }

  setState(state: TeamVisualState): void {
    this.state = state;
    this.object.visible = true;
  }

  hide(): void {
    this.state = null;
    this.object.visible = false;
  }

  update(t: number): void {
    const state = this.state;
    if (!state || !this.object.visible) return;
    this.updateTarget(this.left, state.left, t, 0);
    this.updateTarget(this.right, state.right, t, 1);
    this.updatePulse(state, t);
    this.updateLock(state, t);
    this.updateTether(state, t);
  }

  private updateTarget(marker: TargetMarker, target: TeamTargetVisual, t: number, phase: number): void {
    marker.group.visible = target.visible;
    if (!target.visible) return;
    placeOnSurface(this.course, marker.group, target.u, target.lateral, t, this.scratch, this.tangent, 0.34);
    const pulse = target.active ? 1 + Math.sin(t * 5.2 + phase) * 0.08 : 0.82;
    marker.group.scale.setScalar(target.complete ? 0.72 : pulse);
    marker.ring.opacity = target.complete ? 0.18 : target.active ? 0.92 : 0.42;
    marker.core.opacity = target.complete ? 0.12 : target.active ? 0.72 : 0.28;
    marker.arrow.opacity = target.complete ? 0 : target.active ? 0.96 : 0.38;
    marker.group.userData.kind = target.kind;
  }

  private updatePulse(state: TeamVisualState, t: number): void {
    this.pulse.visible = state.mode === 'resonance' && state.pulseActive;
    if (!this.pulse.visible) return;
    worldAt(this.course, state.pulseFromU, state.pulseFromLateral, t, this.scratch);
    worldAt(this.course, state.pulseToU, state.pulseToLateral, t, this.scratchB);
    const p = THREE.MathUtils.clamp(state.pulseProgress, 0, 1);
    this.pulse.position.lerpVectors(this.scratch, this.scratchB, p);
    this.pulse.position.y += 2.2 + Math.sin(p * Math.PI) * 4.2;
    this.pulse.rotation.y = t * 3.8;
    this.pulseHalo.rotation.z = -t * 2.4;
    this.pulse.scale.setScalar(0.82 + Math.sin(t * 10) * 0.12);
  }

  private updateLock(state: TeamVisualState, t: number): void {
    this.lock.visible = state.mode === 'locks';
    if (!this.lock.visible) return;
    placeOnSurface(this.course, this.lock, state.lockU, 0, t, this.scratch, this.tangent, 2.5);
    const power = THREE.MathUtils.clamp(state.lockPower, 0, 1);
    this.lock.position.y += power * 3.8;
    this.lockMaterial.color.setHex(power > 0.72 ? LIME : CORAL, THREE.NoColorSpace);
    this.lockMaterial.opacity = 0.52 + power * 0.4;
  }

  private updateTether(state: TeamVisualState, t: number): void {
    this.tether.visible = state.mode === 'sky' && state.skyPowered;
    if (!this.tether.visible) return;
    const control = state.left.kind === 'control' ? state.left : state.right;
    worldAt(this.course, control.u, control.lateral, t, this.scratch);
    const route = this.course.flightRoutes[state.skyRouteIndex];
    this.course.routePointAt(route.id, route.gateUs[0], this.scratchB);
    this.course.routeTangentAt(route.id, route.gateUs[0], this.tangent).setY(0).normalize();
    this.scratchB.x += this.tangent.z * state.skyGateOffset;
    this.scratchB.z -= this.tangent.x * state.skyGateOffset;
    this.scratchB.y += 1.2;
    this.scratch.y += 1.2;
    const length = this.scratch.distanceTo(this.scratchB);
    this.tether.position.lerpVectors(this.scratch, this.scratchB, 0.5);
    this.direction.subVectors(this.scratchB, this.scratch).normalize();
    this.quaternion.setFromUnitVectors(UP, this.direction);
    this.tether.quaternion.copy(this.quaternion);
    this.tether.scale.set(1, length, 1);
    this.tetherMaterial.opacity = 0.45 + Math.sin(t * 7) * 0.12;
  }
}

function targetMarker(color: number): TargetMarker {
  const group = new THREE.Group();
  const ringMaterial = energyMaterial(color, 0.9);
  const coreMaterial = energyMaterial(color, 0.55);
  const arrowMaterial = energyMaterial(color, 0.95);
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 4.15, 32), ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  const core = new THREE.Mesh(new THREE.CircleGeometry(3.05, 32), coreMaterial);
  core.rotation.x = -Math.PI / 2;
  core.position.y = -0.03;
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.65, 1.9, 4), arrowMaterial);
  arrow.position.y = 2.1;
  arrow.rotation.x = Math.PI;
  group.add(core, ring, arrow);
  group.traverse((child) => child.layers.enable(LAYER_ENERGY));
  return { group, ring: ringMaterial, core: coreMaterial, arrow: arrowMaterial };
}

function lockFrame(): { group: THREE.Group; material: THREE.MeshBasicMaterial } {
  const group = new THREE.Group();
  const material = energyMaterial(CORAL, 0.88);
  const ink = new THREE.MeshBasicMaterial({ color: INK, toneMapped: false });
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 5.2, 0.7), material);
    post.position.x = side * 5.8;
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.24, 5.5, 0.86), ink);
    spine.position.set(side * 5.8, 0, 0.08);
    group.add(post, spine);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(12.2, 0.7, 0.7), material);
  beam.position.y = 2.3;
  group.add(beam);
  group.traverse((child) => child.layers.enable(LAYER_ENERGY));
  return { group, material };
}

function placeOnSurface(
  course: Course,
  object: THREE.Object3D,
  u: number,
  lateral: number,
  t: number,
  point: THREE.Vector3,
  tangent: THREE.Vector3,
  lift: number,
): void {
  course.pointAt(u, point);
  course.tangentAt(u, tangent).setY(0).normalize();
  point.x += tangent.z * lateral;
  point.z -= tangent.x * lateral;
  object.position.set(point.x, waterHeight(point.x, point.z, t) + lift, point.z);
  object.rotation.y = Math.atan2(tangent.x, tangent.z);
}

function worldAt(course: Course, u: number, lateral: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  course.pointAt(u, out);
  course.tangentAt(u, _worldTangent).setY(0).normalize();
  out.x += _worldTangent.z * lateral;
  out.z -= _worldTangent.x * lateral;
  out.y = waterHeight(out.x, out.z, t);
  return out;
}

function energyMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}
