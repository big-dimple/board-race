import * as THREE from 'three';
import type { Course } from './course';
import { waterHeight } from '../water/waves';
import { LAYER_ENERGY, markInk } from '../contracts';
import { createToonMaterial } from '../cel/toonMaterial';

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
  pulseMissProgress: number;
  pulseFromU: number;
  pulseFromLateral: number;
  pulseToU: number;
  pulseToLateral: number;
  sourcePower: number;
  receiverPower: number;
  lockU: number;
  lockPower: number;
  dockPower: number;
  skyRouteIndex: number;
  skyGateOffset: number;
  skyPowered: boolean;
}

const CYAN = 0x2de4e0;
const LIME = 0xc5f33b;
const CORAL = 0xff536e;
const PAPER = 0xf3f1df;
const STEEL = 0x4a6178;
const RIG_LATERAL_M = 3.9;
const RIG_FORWARD_M = 7.1;
const RIG_SCALE = 0.88;
const CRADLE_LOCAL_X_M = 5.7;
const UP = new THREE.Vector3(0, 1, 0);
const _worldTangent = new THREE.Vector3();

interface TargetMarker {
  group: THREE.Group;
  energy: THREE.Group;
  arrowMesh: THREE.Mesh;
  ring: THREE.MeshBasicMaterial;
  core: THREE.MeshBasicMaterial;
  arrow: THREE.MeshBasicMaterial;
  guideBeam: THREE.Mesh;
  guideBeamMaterial: THREE.MeshBasicMaterial;
  guideNodes: THREE.Mesh[];
  impactRing: THREE.Mesh;
  impactMaterial: THREE.MeshBasicMaterial;
  hammerGaugeNeedle: THREE.Group;
  anchorSpool: THREE.Group;
  consoleScreenMaterial: THREE.MeshBasicMaterial;
  dockBeaconMaterial: THREE.MeshBasicMaterial;
  rig: THREE.Group;
  platform: THREE.Group;
  connector: THREE.Group;
  hammer: THREE.Group;
  hammerPivot: THREE.Group;
  anchor: THREE.Group;
  anchorSpike: THREE.Group;
  anchorJawA: THREE.Group;
  anchorJawB: THREE.Group;
  receiverCradle: THREE.Group;
  winch: THREE.Group;
  winchDrum: THREE.Group;
  console: THREE.Group;
  consoleWheel: THREE.Group;
  launcher: THREE.Group;
  launchBed: THREE.Group;
  dock: THREE.Group;
  dockArmA: THREE.Group;
  dockArmB: THREE.Group;
  guidePhase: number;
}

type WorkRig = Omit<TargetMarker, 'group' | 'energy' | 'arrowMesh' | 'ring' | 'core' | 'arrow' |
  'guideBeam' | 'guideBeamMaterial' | 'guideNodes' | 'impactRing' | 'impactMaterial' | 'guidePhase'>;

/** Authored machinery driven by the same state that decides each co-op outcome. */
export class TeamCourseVisuals {
  readonly object = new THREE.Group();
  private readonly left = targetMarker(CYAN);
  private readonly right = targetMarker(LIME);
  private readonly relayRail: THREE.Mesh[] = [];
  private readonly relayFlowNodes: THREE.Mesh[] = [];
  private readonly relayFlowMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly railPoints = Array.from({ length: 7 }, () => new THREE.Vector3());
  private readonly pulse: THREE.Group;
  private readonly pulseHalo: THREE.Mesh;
  private readonly splash: THREE.Mesh;
  private readonly splashMaterial: THREE.MeshBasicMaterial;
  private readonly lock: THREE.Group;
  private readonly lockGate: THREE.Group;
  private readonly lockMaterial: THREE.MeshBasicMaterial;
  private readonly lockCable: THREE.Mesh;
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

    for (let i = 0; i < this.railPoints.length - 1; i++) {
      const railMaterial = solidMaterial(0x7892a5, 0.72, 0.5, i < 3 ? CYAN : LIME);
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1, 8), railMaterial);
      rail.name = `team-core-rail-${i + 1}`;
      this.relayRail.push(rail);
      this.object.add(rail);
    }
    const flowGeometry = new THREE.IcosahedronGeometry(0.32, 1);
    for (let i = 0; i < 5; i++) {
      const flowMaterial = energyMaterial(i < 3 ? CYAN : LIME, 0.9);
      const node = new THREE.Mesh(flowGeometry, flowMaterial);
      node.name = `team-core-flow-${i + 1}`;
      node.userData.noInk = true;
      node.layers.enable(LAYER_ENERGY);
      this.relayFlowNodes.push(node);
      this.relayFlowMaterials.push(flowMaterial);
      this.object.add(node);
    }

    this.pulse = coreCapsule();
    this.pulse.name = 'team-anchor-core';
    this.pulseHalo = this.pulse.getObjectByName('team-core-halo') as THREE.Mesh;
    this.object.add(this.pulse);

    this.splashMaterial = energyMaterial(CYAN, 0.75);
    this.splash = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.3, 28), this.splashMaterial);
    this.splash.name = 'team-core-miss-splash';
    this.splash.rotation.x = -Math.PI / 2;
    this.splash.layers.enable(LAYER_ENERGY);
    this.object.add(this.splash);

    const lock = lockFrame();
    this.lock = lock.group;
    this.lockGate = lock.gate;
    this.lockMaterial = lock.material;
    this.object.add(this.lock);

    this.lockCable = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 1, 8),
      solidMaterial(0x151d2a, 0.25, 0.85),
    );
    this.lockCable.name = 'team-lock-winch-cable';
    this.object.add(this.lockCable);

    this.tetherMaterial = energyMaterial(LIME, 0.58);
    this.tether = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1, 7), this.tetherMaterial);
    this.tether.name = 'team-sky-control-tether';
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
    this.updateTarget(this.left, state.left, state, t, 0);
    this.updateTarget(this.right, state.right, state, t, 1);
    this.updateRelayRail(state, t);
    this.updatePulse(state, t);
    this.updateLock(state, t);
    this.updateTether(state, t);
  }

  private updateTarget(
    marker: TargetMarker,
    target: TeamTargetVisual,
    state: TeamVisualState,
    t: number,
    phase: number,
  ): void {
    marker.group.visible = target.visible;
    if (!target.visible) return;
    placeOnSurface(this.course, marker.group, target.u, target.lateral, t, this.scratch, this.tangent, 0.34);

    const pulse = target.active ? 1 + Math.sin(t * 5.2 + phase) * 0.06 : 0.9;
    const targetScale = target.kind === 'drive' ? 1.12 : target.kind === 'dock' ? 1.04 : 1;
    marker.energy.scale.setScalar((target.complete ? 0.84 : pulse) * targetScale);
    marker.arrowMesh.position.y = 5.6 + Math.sin(t * 3.6 + phase) * 0.4;
    marker.ring.opacity = target.complete ? 0.18 : target.active ? 0.92 : 0.42;
    marker.core.opacity = target.complete ? 0.1 : target.active ? 0.48 : 0.2;
    marker.arrow.opacity = target.complete ? 0 : target.active ? 0.96 : 0.38;

    const sideSign = phase === 0 ? -1 : 1;
    const mechanical = state.mode !== 'tutorial' && (target.kind !== 'runner' || state.mode === 'sky');
    marker.rig.visible = mechanical;
    marker.rig.position.set(sideSign * RIG_LATERAL_M, 0, RIG_FORWARD_M);
    marker.rig.scale.setScalar(RIG_SCALE);
    marker.connector.position.x = -sideSign * 2.7;
    marker.receiverCradle.position.x = -sideSign * CRADLE_LOCAL_X_M;
    marker.platform.visible = mechanical;
    marker.connector.visible = target.kind === 'source' || target.kind === 'receiver' ||
      target.kind === 'anchor' || target.kind === 'control';
    marker.hammer.visible = target.kind === 'source';
    marker.anchor.visible = target.kind === 'receiver';
    marker.receiverCradle.visible = target.kind === 'receiver';
    marker.winch.visible = target.kind === 'anchor';
    marker.console.visible = target.kind === 'control';
    marker.launcher.visible = target.kind === 'runner' && state.mode === 'sky';
    marker.dock.visible = target.kind === 'dock';

    // A moving link makes the next machine legible before the player reaches it.
    const guideActive = mechanical && target.active && !target.complete;
    const guideX = sideSign * RIG_LATERAL_M;
    const guideZ = RIG_FORWARD_M;
    const guideLength = Math.hypot(guideX, guideZ);
    marker.guideBeam.visible = guideActive;
    marker.guideBeam.position.set(guideX * 0.5, 1.35, guideZ * 0.5);
    marker.guideBeam.rotation.y = Math.atan2(guideX, guideZ);
    marker.guideBeam.scale.set(1, 1, guideLength);
    const power = target.kind === 'source' ? state.sourcePower
      : target.kind === 'receiver' ? state.receiverPower
      : target.kind === 'anchor' ? state.lockPower
      : target.kind === 'control' ? (state.skyPowered ? 1 : 0)
      : target.kind === 'dock' ? state.dockPower : state.sourcePower;
    const guideOpacity = THREE.MathUtils.clamp(0.24 + power * 0.28 + Math.sin(t * 8 + marker.guidePhase) * 0.07, 0.14, 0.68);
    marker.guideBeamMaterial.opacity = guideActive ? guideOpacity : 0;
    const towardTool = target.kind === 'source' || target.kind === 'anchor' || target.kind === 'control';
    for (let i = 0; i < marker.guideNodes.length; i++) {
      const node = marker.guideNodes[i];
      const material = node.material as THREE.MeshBasicMaterial;
      node.visible = guideActive;
      const flow = (t * 0.58 + marker.guidePhase * 0.17 + i * 0.29) % 1;
      const p = towardTool ? flow : 1 - flow;
      node.position.set(guideX * p, 1.35 + Math.sin(t * 9 + i) * 0.12, guideZ * p);
      node.scale.setScalar(0.72 + Math.sin(t * 10 + i * 1.7) * 0.16);
      material.opacity = guideActive ? guideOpacity * (0.7 - i * 0.08) : 0;
    }

    // The same charge values that unlock a station also drive a local shock ring.
    const anchorPower = THREE.MathUtils.clamp(state.receiverPower, 0, 1);
    let impact = 0;
    let missed = false;
    if (state.mode === 'resonance') {
      const pulse = THREE.MathUtils.clamp(state.pulseProgress, 0, 1);
      if (state.pulseMissProgress > 0 && target.kind === 'receiver') {
        impact = 1 - THREE.MathUtils.clamp(state.pulseMissProgress, 0, 1);
        missed = true;
      } else if (state.pulseActive && target.kind === 'source') {
        impact = 1 - smooth01(pulse / 0.24);
      } else if (state.pulseActive && target.kind === 'receiver') {
        impact = smooth01((pulse - 0.7) / 0.3);
      }
      impact = Math.max(impact, Math.min(0.32, power * 0.32));
    }
    marker.impactRing.visible = impact > 0.01;
    marker.impactRing.position.y = 0.16 + Math.sin(t * 10 + phase) * 0.035;
    marker.impactRing.scale.setScalar(1 + impact * 2.25);
    marker.impactMaterial.opacity = impact * (missed ? 0.68 : 0.54);
    marker.impactMaterial.color.setHex(missed ? CORAL : phase === 0 ? CYAN : LIME, THREE.NoColorSpace);

    marker.hammerGaugeNeedle.rotation.z = -0.72 + THREE.MathUtils.clamp(state.sourcePower, 0, 1) * 1.44;
    marker.anchorSpool.rotation.z = t * (0.25 + anchorPower * 2.2);
    marker.consoleScreenMaterial.opacity = state.skyPowered
      ? 0.72 + Math.sin(t * 9 + phase) * 0.18
      : target.kind === 'control' ? 0.26 : 0.08;
    marker.dockBeaconMaterial.opacity = target.kind === 'dock'
      ? THREE.MathUtils.clamp(0.48 + THREE.MathUtils.clamp(state.dockPower, 0, 1) * 0.45 + Math.sin(t * 8 + phase) * 0.16, 0, 1)
      : 0;

    const idleAngle = -sideSign * 0.1;
    const chargedAngle = -sideSign * 0.72;
    const strikeAngle = sideSign * 0.66;
    let hammerAngle = THREE.MathUtils.lerp(idleAngle, chargedAngle, smooth01(state.sourcePower));
    if (state.mode === 'resonance' && state.pulseActive && state.pulseMissProgress <= 0) {
      const p = THREE.MathUtils.clamp(state.pulseProgress, 0, 1);
      hammerAngle = p < 0.14
        ? THREE.MathUtils.lerp(chargedAngle, strikeAngle, smooth01(p / 0.14))
        : THREE.MathUtils.lerp(strikeAngle, idleAngle, smooth01((p - 0.14) / 0.52));
    }
    marker.hammerPivot.rotation.z = hammerAngle;

    marker.anchorSpike.position.y = 3.35 - anchorPower * 3.05;
    marker.anchorJawA.rotation.z = sideSign * (0.5 - anchorPower * 0.42);
    marker.anchorJawB.rotation.z = -sideSign * (0.5 - anchorPower * 0.42);
    marker.receiverCradle.rotation.z = sideSign * (0.32 - anchorPower * 0.32);

    const lockPower = THREE.MathUtils.clamp(state.lockPower, 0, 1);
    marker.winchDrum.rotation.x = t * (0.4 + lockPower * 2.8);
    marker.consoleWheel.rotation.z = state.skyGateOffset * 0.18 + (state.skyPowered ? Math.sin(t * 4) * 0.08 : 0);
    marker.launchBed.rotation.x = -0.22 - (state.skyPowered ? 0.08 : 0);
    const dockClosure = THREE.MathUtils.clamp(state.dockPower, 0, 1) * 0.55;
    marker.dockArmA.rotation.y = sideSign * dockClosure;
    marker.dockArmB.rotation.y = -sideSign * dockClosure;
    marker.group.userData.kind = target.kind;
  }

  private updateRelayRail(state: TeamVisualState, t: number): void {
    const visible = state.mode === 'resonance';
    for (const rail of this.relayRail) rail.visible = visible;
    const flowVisible = visible && state.pulseActive && state.pulseMissProgress <= 0;
    for (const node of this.relayFlowNodes) node.visible = flowVisible;
    if (!visible) return;
    const fromSide = Math.sign(state.pulseFromLateral) || -1;
    const toSide = Math.sign(state.pulseToLateral) || 1;
    worldAtRig(this.course, state.pulseFromU, state.pulseFromLateral, fromSide * RIG_LATERAL_M, t, this.scratch);
    worldAtRig(this.course, state.pulseToU, state.pulseToLateral,
      toSide * (RIG_LATERAL_M - CRADLE_LOCAL_X_M * RIG_SCALE), t, this.scratchB);
    const slack = (1 - THREE.MathUtils.clamp(state.receiverPower, 0, 1)) * 1.25;
    for (let i = 0; i < this.railPoints.length; i++) {
      const p = i / (this.railPoints.length - 1);
      const point = this.railPoints[i];
      point.lerpVectors(this.scratch, this.scratchB, p);
      point.y += 1.45 + Math.sin(p * Math.PI) * 2.35 - Math.max(0, p - 0.68) * slack * 2.2;
      if (i > 0) placeCylinderBetween(this.relayRail[i - 1], this.railPoints[i - 1], point, this.direction, this.quaternion);
    }
    if (!flowVisible) return;
    const pulse = THREE.MathUtils.clamp(state.pulseProgress, 0, 1);
    for (let i = 0; i < this.relayFlowNodes.length; i++) {
      const trail = i * 0.1;
      const p = THREE.MathUtils.clamp(pulse * 1.16 - trail, 0, 1);
      const point = this.relayFlowNodes[i].position;
      point.lerpVectors(this.scratch, this.scratchB, p);
      point.y += 1.45 + Math.sin(p * Math.PI) * 2.35;
      this.relayFlowNodes[i].scale.setScalar(0.68 + Math.sin(t * 12 + i) * 0.14);
      this.relayFlowMaterials[i].opacity = Math.max(0.08, 0.92 - trail * 2.2);
    }
  }

  private updatePulse(state: TeamVisualState, t: number): void {
    this.pulse.visible = state.mode === 'resonance' && state.pulseActive;
    this.splash.visible = false;
    if (!this.pulse.visible) return;
    const fromSide = Math.sign(state.pulseFromLateral) || -1;
    const toSide = Math.sign(state.pulseToLateral) || 1;
    worldAtRig(this.course, state.pulseFromU, state.pulseFromLateral, fromSide * RIG_LATERAL_M, t, this.scratch);
    worldAtRig(this.course, state.pulseToU, state.pulseToLateral,
      toSide * (RIG_LATERAL_M - CRADLE_LOCAL_X_M * RIG_SCALE), t, this.scratchB);
    const miss = THREE.MathUtils.clamp(state.pulseMissProgress, 0, 1);
    if (miss > 0) {
      this.pulse.position.copy(this.scratchB);
      this.pulse.position.x += Math.sin(miss * Math.PI) * 2.4;
      this.pulse.position.y += 1.45 - miss * 4.4;
      this.pulse.rotation.z = miss * 7;
      if (miss > 0.36) {
        const splashP = (miss - 0.36) / 0.64;
        this.splash.visible = true;
        this.splash.position.copy(this.scratchB);
        this.splash.position.y += 0.15;
        this.splash.scale.setScalar(1 + splashP * 5.2);
        this.splashMaterial.opacity = (1 - splashP) * 0.78;
      }
    } else {
      const p = THREE.MathUtils.clamp(state.pulseProgress, 0, 1);
      this.pulse.position.lerpVectors(this.scratch, this.scratchB, p);
      this.pulse.position.y += 1.45 + Math.sin(p * Math.PI) * 2.35;
      this.pulse.rotation.z = p * Math.PI * 5;
    }
    this.pulse.rotation.y = t * 3.8;
    this.pulseHalo.rotation.z = -t * 2.4;
    this.pulse.scale.setScalar(0.72 + Math.sin(t * 10) * 0.04);
  }

  private updateLock(state: TeamVisualState, t: number): void {
    const visible = state.mode === 'locks';
    this.lock.visible = visible;
    this.lockCable.visible = visible && (state.left.kind === 'anchor' || state.right.kind === 'anchor');
    if (!visible) return;
    placeOnSurface(this.course, this.lock, state.lockU, 0, t, this.scratch, this.tangent, 0.2);
    const power = THREE.MathUtils.clamp(state.lockPower, 0, 1);
    this.lockGate.position.y = power * 5.1;
    this.lockMaterial.color.setHex(power > 0.72 ? LIME : CORAL, THREE.NoColorSpace);
    this.lockMaterial.opacity = 0.55 + power * 0.4;
    if (!this.lockCable.visible) return;
    const anchor = state.left.kind === 'anchor' ? state.left : state.right;
    const anchorSide = Math.sign(anchor.lateral) || -1;
    worldAtRig(this.course, anchor.u, anchor.lateral, anchorSide * RIG_LATERAL_M, t, this.scratch);
    worldAt(this.course, state.lockU, 0, t, this.scratchB);
    this.scratch.y += 2.4;
    this.scratchB.y += 1.5 + power * 5.1;
    placeCylinderBetween(this.lockCable, this.scratch, this.scratchB, this.direction, this.quaternion);
  }

  private updateTether(state: TeamVisualState, t: number): void {
    this.tether.visible = state.mode === 'sky' && state.skyPowered;
    if (!this.tether.visible) return;
    const control = state.left.kind === 'control' ? state.left : state.right;
    const controlSide = Math.sign(control.lateral) || -1;
    worldAtRig(this.course, control.u, control.lateral, controlSide * RIG_LATERAL_M, t, this.scratch);
    const route = this.course.flightRoutes[state.skyRouteIndex];
    this.course.routePointAt(route.id, route.gateUs[0], this.scratchB);
    this.course.routeTangentAt(route.id, route.gateUs[0], this.tangent).setY(0).normalize();
    this.scratchB.x += this.tangent.z * state.skyGateOffset;
    this.scratchB.z -= this.tangent.x * state.skyGateOffset;
    this.scratchB.y += 1.2;
    this.scratch.y += 1.2;
    placeCylinderBetween(this.tether, this.scratch, this.scratchB, this.direction, this.quaternion);
    this.tetherMaterial.opacity = 0.45 + Math.sin(t * 7) * 0.12;
  }
}

function targetMarker(color: number): TargetMarker {
  const group = new THREE.Group();
  const energy = new THREE.Group();
  energy.userData.noInk = true;
  const ringMaterial = energyMaterial(color, 0.9);
  const coreMaterial = energyMaterial(color, 0.48);
  const arrowMaterial = energyMaterial(color, 0.95);
  const ring = new THREE.Mesh(new THREE.RingGeometry(7, 9.6, 40), ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  const core = new THREE.Mesh(new THREE.CircleGeometry(6.8, 40), coreMaterial);
  core.rotation.x = -Math.PI / 2;
  core.position.y = -0.03;
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.15, 3.5, 4), arrowMaterial);
  arrow.position.y = 5.6;
  arrow.rotation.x = Math.PI;
  energy.add(core, ring, arrow);
  energy.traverse((child) => child.layers.enable(LAYER_ENERGY));

  const guideBeamMaterial = energyMaterial(color, 0);
  const guideBeam = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 1), guideBeamMaterial);
  guideBeam.name = 'team-tool-guide-beam';
  guideBeam.userData.noInk = true;
  guideBeam.layers.enable(LAYER_ENERGY);
  const guideNodes = Array.from({ length: 3 }, (_, index) => {
    const node = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 1), energyMaterial(color, 0));
    node.name = `team-tool-guide-node-${index + 1}`;
    node.userData.noInk = true;
    node.layers.enable(LAYER_ENERGY);
    return node;
  });
  const impactMaterial = energyMaterial(color, 0);
  const impactRing = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.42, 32), impactMaterial);
  impactRing.name = 'team-tool-impact-ring';
  impactRing.rotation.x = -Math.PI / 2;
  impactRing.userData.noInk = true;
  impactRing.layers.enable(LAYER_ENERGY);

  const work = workRig(color);
  group.add(energy, guideBeam, impactRing, ...guideNodes, work.rig);
  return { group, energy, arrowMesh: arrow, ring: ringMaterial, core: coreMaterial, arrow: arrowMaterial,
    guideBeam, guideBeamMaterial, guideNodes, impactRing, impactMaterial,
    guidePhase: color === CYAN ? 0 : 1, ...work };
}

function workRig(color: number): WorkRig {
  const rig = new THREE.Group();
  rig.name = 'team-work-rig';
  const accent = solidMaterial(color, 0.4, 0.52, color);
  const steel = solidMaterial(STEEL, 0.3, 0.78);
  const dark = solidMaterial(0x182638, 0.2, 0.88);
  const paper = solidMaterial(PAPER, 0.12, 0.58);

  const platform = new THREE.Group();
  platform.name = 'team-floating-work-platform';
  addBox(platform, 6.2, 0.55, 5.2, steel, 0, 0.12, 0);
  addBox(platform, 5.5, 0.18, 4.45, dark, 0, 0.46, 0);
  addBox(platform, 6.35, 0.22, 0.3, accent, 0, 0.5, -2.4);
  addBox(platform, 6.35, 0.22, 0.3, accent, 0, 0.5, 2.4);
  for (const x of [-2.35, 2.35]) {
    const pontoon = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 5, 10), dark);
    pontoon.rotation.x = Math.PI / 2;
    pontoon.position.set(x, -0.32, 0);
    platform.add(pontoon);
  }
  rig.add(platform);

  const connector = new THREE.Group();
  connector.name = 'team-tool-linkage';
  addBox(connector, 6.6, 0.2, 0.3, steel, 0, 1.25, 0);
  for (const z of [-0.42, 0.42]) addBox(connector, 6.6, 0.12, 0.12, accent, 0, 1.5, z);
  rig.add(connector);

  const hammer = new THREE.Group();
  hammer.name = 'team-impact-hammer';
  addBox(hammer, 2.7, 0.55, 2.4, dark, 0, 0.75, 0);
  for (const x of [-1, 1]) addBox(hammer, 0.38, 2.4, 0.5, steel, x, 1.75, 0);
  const hammerPivot = new THREE.Group();
  hammerPivot.position.y = 0.85;
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 3.6, 9), steel);
  handle.position.y = 1.8;
  const head = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.35, 1.55), paper);
  head.position.y = 3.75;
  const face = new THREE.Mesh(new THREE.BoxGeometry(3.05, 0.42, 1.78), accent);
  face.position.y = 3.75;
  hammerPivot.add(handle, head, face);
  const piston = new THREE.Group();
  const pistonRod = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 2.15, 10), paper);
  pistonRod.position.set(0, 2.05, -0.72);
  const pistonSleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.44, 10), accent);
  pistonSleeve.position.set(0, 1.15, -0.72);
  piston.add(pistonRod, pistonSleeve);
  hammer.add(piston);
  const hammerGauge = new THREE.Group();
  hammerGauge.position.set(0, 2.12, -1.24);
  const gaugeFace = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.1, 8, 18), accent);
  const hammerGaugeNeedle = new THREE.Group();
  const needle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 0.08), paper);
  needle.position.y = 0.2;
  hammerGaugeNeedle.add(needle);
  hammerGauge.add(gaugeFace, hammerGaugeNeedle);
  hammer.add(hammerGauge);
  hammer.add(hammerPivot);
  rig.add(hammer);

  const anchor = new THREE.Group();
  anchor.name = 'team-anchor-press';
  addBox(anchor, 3.8, 0.6, 2.8, dark, 0, 0.72, 0);
  for (const x of [-1.45, 1.45]) addBox(anchor, 0.38, 4.8, 0.48, steel, x, 3.05, 0);
  addBox(anchor, 3.35, 0.5, 0.62, accent, 0, 5.15, 0);
  const anchorSpike = new THREE.Group();
  const spikeShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.5, 3.4, 9), paper);
  const spikeTip = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.25, 9), accent);
  spikeTip.position.y = -2.25;
  anchorSpike.add(spikeShaft, spikeTip);
  anchorSpike.position.y = 3.35;
  anchor.add(anchorSpike);
  const anchorJawA = clampJaw(accent, -0.78);
  const anchorJawB = clampJaw(accent, 0.78);
  anchor.add(anchorJawA, anchorJawB);
  const anchorSpool = new THREE.Group();
  anchorSpool.position.set(0, 2.3, -1.02);
  const spoolBody = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.58, 0.54, 12), steel);
  spoolBody.rotation.x = Math.PI / 2;
  const spoolLipA = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.12, 8, 16), accent);
  const spoolLipB = spoolLipA.clone();
  spoolLipA.position.z = -0.28;
  spoolLipB.position.z = 0.28;
  anchorSpool.add(spoolBody, spoolLipA, spoolLipB);
  anchor.add(anchorSpool);
  rig.add(anchor);

  const receiverCradle = new THREE.Group();
  receiverCradle.name = 'team-core-cradle';
  const cradleRing = new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.32, 8, 20), accent);
  cradleRing.position.y = 2.2;
  receiverCradle.add(cradleRing);
  addBox(receiverCradle, 4.6, 0.28, 0.45, steel, 0, 0.75, 0);
  rig.add(receiverCradle);

  const winch = new THREE.Group();
  winch.name = 'team-lock-winch';
  addBox(winch, 4.4, 0.55, 3.6, dark, 0, 0.76, 0);
  for (const x of [-1.55, 1.55]) addBox(winch, 0.42, 2.8, 0.65, steel, x, 2.2, 0);
  const winchDrum = new THREE.Group();
  winchDrum.position.y = 2.5;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 2.7, 12), steel);
  drum.rotation.z = Math.PI / 2;
  winchDrum.add(drum);
  for (const x of [-1.55, 1.55]) {
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.18, 7, 18), accent);
    wheel.rotation.y = Math.PI / 2;
    wheel.position.x = x;
    winchDrum.add(wheel);
  }
  const ratchet = new THREE.Group();
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    const tooth = addBox(ratchet, 0.18, 0.38, 0.22, accent,
      0, Math.sin(angle) * 1.34, Math.cos(angle) * 1.34);
    tooth.rotation.x = -angle;
  }
  winchDrum.add(ratchet);
  winch.add(winchDrum);
  rig.add(winch);

  const console = new THREE.Group();
  console.name = 'team-flight-console';
  addBox(console, 3.8, 0.58, 3.2, dark, 0, 0.76, 0);
  addBox(console, 2.8, 2.4, 1.6, steel, 0, 2.15, 0);
  const screenMaterial = energyMaterial(color, 0.88);
  const screen = new THREE.Mesh(new THREE.BoxGeometry(2.15, 1.05, 0.12), screenMaterial);
  screen.userData.noInk = true;
  screen.position.set(0, 2.45, -0.86);
  screen.layers.enable(LAYER_ENERGY);
  console.add(screen);
  for (const [width, height, x, y] of [
    [2.48, 0.12, 0, 3.08], [2.48, 0.12, 0, 1.82],
    [0.12, 1.36, -1.18, 2.45], [0.12, 1.36, 1.18, 2.45],
  ] as const) addBox(console, width, height, 0.08, paper, x, y, -0.92);
  const signalBars = new THREE.Group();
  for (let i = 0; i < 4; i++) addBox(signalBars, 0.14, 0.14 + i * 0.16, 0.06, accent, -0.72 + i * 0.48, 2.02 + i * 0.08, -0.99);
  console.add(signalBars);
  const consoleWheel = new THREE.Group();
  consoleWheel.position.set(0, 3.6, -0.42);
  const wheelRing = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.18, 8, 20), accent);
  consoleWheel.add(wheelRing);
  for (let i = 0; i < 4; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.85, 0.16), paper);
    spoke.rotation.z = i * Math.PI / 4;
    consoleWheel.add(spoke);
  }
  console.add(consoleWheel);
  rig.add(console);

  const launcher = new THREE.Group();
  launcher.name = 'team-flight-launcher';
  const launchBed = new THREE.Group();
  launchBed.position.set(0, 1.05, 0.25);
  for (const x of [-1.35, 1.35]) addBox(launchBed, 0.42, 0.32, 6.4, accent, x, 0, 0);
  for (const z of [-2.4, 0, 2.4]) addBox(launchBed, 3.2, 0.22, 0.32, steel, 0, 0, z);
  launcher.add(launchBed);
  addBox(launcher, 4.2, 0.62, 3.6, dark, 0, 0.66, 1.15);
  rig.add(launcher);

  const dock = new THREE.Group();
  dock.name = 'team-mooring-clamps';
  addBox(dock, 4.5, 0.58, 3.5, dark, 0, 0.76, 0);
  const dockArmA = dockArm(accent, -1.35);
  const dockArmB = dockArm(accent, 1.35);
  dock.add(dockArmA, dockArmB);
  const dockBeaconMaterial = energyMaterial(color, 0);
  const dockBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.27, 10, 8), dockBeaconMaterial);
  dockBeacon.position.set(0, 2.4, -1.55);
  dockBeacon.userData.noInk = true;
  dockBeacon.layers.enable(LAYER_ENERGY);
  dock.add(dockBeacon);
  rig.add(dock);

  return { rig, platform, connector, hammer, hammerPivot, anchor, anchorSpike, anchorJawA, anchorJawB,
    receiverCradle, winch, winchDrum, console, consoleWheel, launcher, launchBed, dock, dockArmA, dockArmB,
    hammerGaugeNeedle, anchorSpool, consoleScreenMaterial: screenMaterial, dockBeaconMaterial };
}

function clampJaw(material: THREE.Material, x: number): THREE.Group {
  const jaw = new THREE.Group();
  jaw.position.set(x, 1.15, 0);
  addBox(jaw, 0.36, 2.4, 0.55, material, 0, 0.9, 0);
  return jaw;
}

function dockArm(material: THREE.Material, x: number): THREE.Group {
  const arm = new THREE.Group();
  arm.position.set(x, 1.1, -0.4);
  addBox(arm, 0.42, 0.42, 4.2, material, 0, 0.55, -1.55);
  addBox(arm, 0.85, 1.25, 0.48, material, 0, 0.95, -3.45);
  return arm;
}

function coreCapsule(): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(1.18, 1), solidMaterial(PAPER, 0.65, 0.34, 0x244b55));
  body.scale.set(1.35, 0.92, 0.92);
  markInk(body);
  group.add(body);
  for (let i = 0; i < 3; i++) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.12, 7, 20), energyMaterial(i === 1 ? LIME : CYAN, 0.88));
    band.userData.noInk = true;
    band.rotation.y = Math.PI / 2;
    band.position.x = (i - 1) * 0.72;
    band.layers.enable(LAYER_ENERGY);
    group.add(band);
  }
  const halo = new THREE.Mesh(new THREE.RingGeometry(1.42, 1.72, 24), energyMaterial(CYAN, 0.5));
  halo.name = 'team-core-halo';
  halo.userData.noInk = true;
  halo.layers.enable(LAYER_ENERGY);
  group.add(halo);
  return group;
}

function lockFrame(): { group: THREE.Group; gate: THREE.Group; material: THREE.MeshBasicMaterial } {
  const group = new THREE.Group();
  group.name = 'team-water-lock';
  const steel = solidMaterial(STEEL, 0.38, 0.78);
  const dark = solidMaterial(0x182638, 0.2, 0.9);
  const material = energyMaterial(CORAL, 0.88);
  for (const side of [-1, 1]) {
    addBox(group, 1.25, 8.4, 1.5, steel, side * 10.5, 4.2, 0);
    addBox(group, 1.55, 0.55, 2.1, dark, side * 10.5, 0.35, 0);
  }
  addBox(group, 22.1, 0.65, 1.45, steel, 0, 8.15, 0);
  const gate = new THREE.Group();
  gate.name = 'team-water-lock-gate';
  addBox(gate, 20, 1.05, 1.15, dark, 0, 1.05, 0);
  for (const x of [-9, -6, -3, 0, 3, 6, 9]) addBox(gate, 0.4, 4.4, 0.72, steel, x, 2.65, 0);
  const energyBar = new THREE.Mesh(new THREE.BoxGeometry(20.3, 0.42, 0.88), material);
  energyBar.userData.noInk = true;
  energyBar.position.y = 4.72;
  energyBar.layers.enable(LAYER_ENERGY);
  gate.add(energyBar);
  group.add(gate);
  return { group, gate, material };
}

function addBox(parent: THREE.Object3D, width: number, height: number, depth: number, material: THREE.Material,
  x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function placeCylinderBetween(cylinder: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3,
  direction: THREE.Vector3, quaternion: THREE.Quaternion): void {
  const length = from.distanceTo(to);
  cylinder.position.lerpVectors(from, to, 0.5);
  direction.subVectors(to, from).normalize();
  quaternion.setFromUnitVectors(UP, direction);
  cylinder.quaternion.copy(quaternion);
  cylinder.scale.set(1, length, 1);
}

function placeOnSurface(course: Course, object: THREE.Object3D, u: number, lateral: number, t: number,
  point: THREE.Vector3, tangent: THREE.Vector3, lift: number): void {
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

function worldAtRig(course: Course, u: number, lateral: number, rigLateral: number, t: number,
  out: THREE.Vector3): THREE.Vector3 {
  worldAt(course, u, lateral, t, out);
  out.addScaledVector(_worldTangent, RIG_FORWARD_M);
  out.x += _worldTangent.z * rigLateral;
  out.z -= _worldTangent.x * rigLateral;
  return out;
}

function energyMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false,
    side: THREE.DoubleSide });
}

function solidMaterial(color: number, _metalness: number, _roughness: number, emissive = 0x000000): THREE.ShaderMaterial {
  return createToonMaterial({
    color,
    emissive,
    emissiveIntensity: emissive === 0 ? 0 : 0.3,
    rimStrength: 0.58,
    specThreshold: 0.97,
  });
}

function smooth01(value: number): number {
  const x = THREE.MathUtils.clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}
