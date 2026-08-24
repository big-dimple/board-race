import * as THREE from 'three';
import type { BoatInput, CourseSample, IWake } from '../contracts';
import type { LocalDeviceId, SeatSide } from '../core/localMultiplayerInput';
import { Boat } from './boat';
import { Course } from './course';
import { TeamCourseVisuals, type TeamVisualState } from './teamCourseVisuals';

export type TeamExpeditionPhase = 'idle' | 'countdown' | 'racing' | 'role-swap' | 'finished';
export type TeamRole = 'leader' | 'wing';

export interface TeamExpeditionStart {
  resumeStage: number;
  leftDeviceId: LocalDeviceId;
  rightDeviceId: LocalDeviceId;
}

export interface TeamExpeditionEvent {
  type: 'countdown' | 'go' | 'anchor' | 'link-ready' | 'relay' | 'gate' | 'recover' | 'stage' | 'finish';
  stage: number;
  side?: SeatSide;
  value?: number;
  shared?: boolean;
}

export interface TeamExpeditionSnapshot {
  phase: TeamExpeditionPhase;
  stage: number;
  totalStages: number;
  elapsed: number;
  leaderSide: SeatSide;
  wingSide: SeatSide;
  link: number;
  anchors: number;
  anchorTotal: number;
  relayOpen: boolean;
  wingCleared: boolean;
  objective: string;
  activePursuers: readonly number[];
  fullRun: boolean;
}

interface StageRuntime {
  startU: number;
  anchorUs: readonly [number, number, number];
  relayU: number;
  holdU: number;
  rendezvousU: number;
}

const TOTAL_STAGES = 7;
const COUNTDOWN_S = 3.15;
const ROLE_SWAP_S = 1.45;
const PERSONAL_RECOVERY_S = 0.68;
const SHARED_RECOVERY_WINDOW_S = 0.5;
const TEAM_OFF_COURSE_M = 66;
const TEAM_SAFE_COURSE_M = 20;
const ZERO_INPUT: BoatInput = { throttle: 0, steer: 0, drift: false, flightTrigger: false, airBrake: false };
const _point = new THREE.Vector3();
const _tangent = new THREE.Vector3();

/**
 * Seven-stage fixed-step cooperation director. It owns role truth and recovery,
 * while Boat and Course remain the only owners of movement and gate scoring.
 */
export class TeamExpedition {
  readonly visuals: TeamCourseVisuals;
  phase: TeamExpeditionPhase = 'idle';
  private stageIndex = 0;
  private elapsed = 0;
  private phaseTimer = 0;
  private countdownBeat = 4;
  private link = 0;
  private anchors = 0;
  private anchorCooldown = 0;
  private relayOpen = false;
  private wingCleared = false;
  private linkAnnounced = false;
  private fullRun = true;
  private stageRuntime: StageRuntime;
  private readonly samples: CourseSample[] = [sampleState(), sampleState()];
  private readonly wingRouteSample = sampleState();
  private readonly wingAssistPoint = new THREE.Vector3();
  private readonly wingAssistTangent = new THREE.Vector3();
  private readonly lastSafeU = [0, 0];
  private readonly offCourseTime = [0, 0];
  private readonly recoveryTime = [0, 0];
  private readonly recoveryStartedAt = [-100, -100];
  private readonly reachedRendezvous = [false, false];
  private recoveryClock = 0;
  private readonly pursuit = new Map<number, TeamPursuitController>();
  private activePursuers: number[] = [];
  private activeBoatBuffer: Boat[] = [];
  private readonly flightBoatBuffer: Boat[];
  private readonly playerInputBuffer: [BoatInput, BoatInput] = [neutralInput(), neutralInput()];
  private seatDevices: Record<SeatSide, LocalDeviceId> = {
    left: 'keyboard-left',
    right: 'keyboard-right',
  };
  private lastWingRouteState = 'idle';

  constructor(
    private readonly course: Course,
    private readonly boats: readonly Boat[],
    private readonly wakes: readonly IWake[],
    private readonly onEvent: (event: TeamExpeditionEvent) => void,
  ) {
    this.visuals = new TeamCourseVisuals(course);
    this.flightBoatBuffer = [boats[1]];
    this.stageRuntime = this.makeStageRuntime(0);
    for (let id = 2; id < boats.length; id++) this.pursuit.set(id, new TeamPursuitController(course, id));
  }

  start(config: TeamExpeditionStart): void {
    this.stageIndex = clampInt(config.resumeStage, 0, TOTAL_STAGES - 1);
    this.fullRun = this.stageIndex === 0;
    this.elapsed = 0;
    this.recoveryClock = 0;
    this.seatDevices = { left: config.leftDeviceId, right: config.rightDeviceId };
    this.boats[0].setPlayerOwned(true);
    this.boats[1].setPlayerOwned(true);
    for (let id = 2; id < this.boats.length; id++) this.boats[id].setPlayerOwned(false);
    this.beginStage(true);
  }

  stop(): void {
    this.phase = 'idle';
    this.activePursuers.length = 0;
    this.activeBoatBuffer.length = 0;
    this.visuals.hide();
    this.course.setGuidanceBoat(0);
    this.course.resetFlightChallenge();
    for (let id = 1; id < this.boats.length; id++) this.boats[id].setPlayerOwned(false);
    for (const boat of this.boats) boat.object.visible = true;
  }

  step(dt: number, t: number, leftInput: BoatInput, rightInput: BoatInput): boolean {
    if (this.phase === 'idle' || this.phase === 'finished') {
      this.visuals.update(t);
      return false;
    }
    this.recoveryClock += dt;
    this.anchorCooldown = Math.max(0, this.anchorCooldown - dt);
    if (this.phase === 'countdown') {
      this.updateCountdown(dt, t);
      return false;
    }
    if (this.phase === 'role-swap') {
      this.phaseTimer = Math.max(0, this.phaseTimer - dt);
      for (let id = 0; id < 2; id++) this.boats[id].syncSurfacePresentation(t);
      this.visuals.update(t);
      if (this.phaseTimer <= 0) this.activateStage(true);
      return false;
    }

    this.elapsed += dt;
    const left = copyInput(this.playerInputBuffer[0], leftInput);
    const right = copyInput(this.playerInputBuffer[1], rightInput);
    const leaderSide = this.leaderSide();
    const wingSide = opposite(leaderSide);
    const leaderId = boatId(leaderSide);
    const wingId = boatId(wingSide);
    const leader = this.boats[leaderId];
    const wing = this.boats[wingId];
    const leaderInput = leaderSide === 'left' ? left : right;
    const wingInput = wingSide === 'left' ? left : right;

    leaderInput.flightTrigger = false;
    if (!this.relayOpen && this.samples[leaderId].u >= this.stageRuntime.relayU) {
      leaderInput.throttle = leader.state.speed > 1 ? -1 : 0;
      leaderInput.airBrake = false;
    }
    const wingWaitingForLaunch = !this.wingCleared &&
      wing.state.flightPhase === 'surface' &&
      wing.state.flightRouteState !== 'passed' &&
      this.samples[wingId].u >= this.stageRuntime.relayU;
    if (wingWaitingForLaunch) {
      wingInput.throttle = wing.state.speed > 1 ? -1 : 0;
      wingInput.drift = false;
      wingInput.airBrake = false;
    }
    if (leader.state.flightPhase === 'surface' && !this.wingCleared && this.samples[leaderId].u >= this.stageRuntime.holdU) {
      leaderInput.throttle = leader.state.speed > 1 ? -1 : 0;
      leaderInput.drift = false;
      leaderInput.airBrake = false;
    }
    if (wing.state.flightPhase === 'surface') wingInput.drift = false;
    if (!this.linkReady() || !this.relayOpen) wingInput.flightTrigger = false;
    this.applyWingRouteAssist(wing, wingInput);
    for (let id = 0; id < 2; id++) {
      if (this.recoveryTime[id] > 0) Object.assign(id === leaderId ? leaderInput : wingInput, ZERO_INPUT);
    }

    // Update the leader first so the wing samples the current fixed-step wake.
    leader.update(dt, leaderInput, t, 'drift', 1, 1, this.wakes);
    // Drift still pays its authored surface boost, but the leader never owns
    // the flight inventory created for the wing's half of the relay.
    leader.state.flightCharges = 0;
    wing.update(dt, wingInput, t, 'drift', 1, 1, this.wakes);
    this.updatePursuers(dt, t, wingId);
    this.flightBoatBuffer[0] = wing;
    this.course.updateFlightRoute(dt, this.flightBoatBuffer);
    this.sampleTeam();
    this.updateLink(dt, leaderId, wingId);
    this.updateRelay(leaderId);
    this.updateFailures(dt, wingId);
    this.updateStageCompletion();
    this.visuals.setState(this.visualState());
    this.visuals.update(t);
    return true;
  }

  snapshot(): TeamExpeditionSnapshot {
    const leaderSide = this.leaderSide();
    return {
      phase: this.phase,
      stage: this.stageIndex + 1,
      totalStages: TOTAL_STAGES,
      elapsed: this.elapsed,
      leaderSide,
      wingSide: opposite(leaderSide),
      link: this.link,
      anchors: this.anchors,
      anchorTotal: this.stageRuntime.anchorUs.length,
      relayOpen: this.relayOpen,
      wingCleared: this.wingCleared,
      objective: this.objective(),
      activePursuers: this.activePursuers,
      fullRun: this.fullRun,
    };
  }

  roleFor(side: SeatSide): TeamRole {
    return side === this.leaderSide() ? 'leader' : 'wing';
  }

  deviceFor(side: SeatSide): LocalDeviceId {
    return this.seatDevices[side];
  }

  activeBoats(): readonly Boat[] {
    return this.activeBoatBuffer;
  }

  debugAdvanceStage(): void {
    if (this.phase !== 'racing') return;
    this.wingCleared = true;
    for (let id = 0; id < 2; id++) this.placeBoat(id, this.stageRuntime.rendezvousU + 0.002, id === 0 ? -2 : 2);
    this.sampleTeam();
    this.updateStageCompletion();
  }

  private beginStage(teleport: boolean): void {
    this.stageRuntime = this.makeStageRuntime(this.stageIndex);
    this.link = 0;
    this.anchors = 0;
    this.anchorCooldown = 0;
    this.relayOpen = false;
    this.wingCleared = false;
    this.linkAnnounced = false;
    this.lastWingRouteState = 'idle';
    this.offCourseTime.fill(0);
    this.recoveryTime.fill(0);
    this.reachedRendezvous.fill(false);
    this.recoveryStartedAt.fill(-100);
    this.course.resetFlightChallenge();
    const wingId = boatId(opposite(this.leaderSide()));
    this.course.setGuidanceBoat(wingId);
    this.course.setFlightGateLocked(this.stageIndex, true);
    for (let id = 0; id < 2; id++) {
      this.boats[id].object.visible = true;
      if (teleport) this.placeBoat(id, this.stageRuntime.startU, id === 0 ? -2.4 : 2.4);
      this.boats[id].restoreFlightCheckpoint(this.stageIndex, 0);
      this.wakes[id].clear();
      this.course.sample(this.boats[id].state.position, this.samples[id], 'surface');
      this.lastSafeU[id] = this.samples[id].u;
    }
    this.configurePursuers();
    this.phase = 'countdown';
    this.phaseTimer = COUNTDOWN_S;
    this.countdownBeat = 4;
    this.visuals.setState(this.visualState());
  }

  private activateStage(teleport: boolean): void {
    this.stageRuntime = this.makeStageRuntime(this.stageIndex);
    this.link = 0;
    this.anchors = 0;
    this.anchorCooldown = 0;
    this.relayOpen = false;
    this.wingCleared = false;
    this.linkAnnounced = false;
    this.lastWingRouteState = 'idle';
    this.offCourseTime.fill(0);
    this.recoveryTime.fill(0);
    this.reachedRendezvous.fill(false);
    this.course.resetFlightChallenge();
    const wingId = boatId(opposite(this.leaderSide()));
    this.course.setGuidanceBoat(wingId);
    this.course.setFlightGateLocked(this.stageIndex, true);
    for (let id = 0; id < 2; id++) {
      if (teleport) this.placeBoat(id, this.stageRuntime.startU, id === 0 ? -2.4 : 2.4);
      this.boats[id].restoreFlightCheckpoint(this.stageIndex, 0);
      this.course.sample(this.boats[id].state.position, this.samples[id], 'surface');
      this.lastSafeU[id] = this.samples[id].u;
      if (teleport) this.wakes[id].clear();
    }
    this.configurePursuers();
    this.phase = 'racing';
    this.onEvent({ type: 'go', stage: this.stageIndex + 1 });
  }

  private updateCountdown(dt: number, t: number): void {
    this.phaseTimer = Math.max(0, this.phaseTimer - dt);
    const beat = Math.ceil(this.phaseTimer);
    if (beat < this.countdownBeat && beat > 0) {
      this.countdownBeat = beat;
      this.onEvent({ type: 'countdown', stage: this.stageIndex + 1, value: beat });
    }
    this.boats[0].syncSurfacePresentation(t);
    this.boats[1].syncSurfacePresentation(t);
    for (const id of this.activePursuers) this.boats[id].syncSurfacePresentation(t);
    this.visuals.update(t);
    if (this.phaseTimer <= 0) this.activateStage(false);
  }

  private updateLink(dt: number, leaderId: number, wingId: number): void {
    const leader = this.boats[leaderId];
    const wing = this.boats[wingId];
    const leaderU = this.samples[leaderId].u;
    if (this.anchors < this.stageRuntime.anchorUs.length && this.anchorCooldown <= 0 && leader.state.drifting) {
      const targetU = this.stageRuntime.anchorUs[this.anchors];
      if (leaderU >= targetU - 0.004 && leaderU <= this.stageRuntime.relayU + 0.004) {
        this.anchors++;
        this.anchorCooldown = 0.32;
        this.link = Math.min(1, this.link + 0.13);
        this.onEvent({ type: 'anchor', stage: this.stageIndex + 1, side: sideForBoat(leaderId), value: this.anchors });
      }
    }

    const dx = wing.state.position.x - leader.state.position.x;
    const dz = wing.state.position.z - leader.state.position.z;
    const forwardX = Math.sin(leader.state.heading);
    const forwardZ = Math.cos(leader.state.heading);
    const along = dx * forwardX + dz * forwardZ;
    const lateral = Math.abs(dx * forwardZ - dz * forwardX);
    const wakeStrength = wing.debugWaterInteraction().strength;
    const following = along < 4 && along > -38 && lateral < 14;
    if (leader.state.drifting && following && wing.state.flightPhase === 'surface') {
      this.link = Math.min(1, this.link + dt * (0.3 + Math.min(0.7, wakeStrength * 1.1)));
    } else if (!this.linkReady()) {
      this.link = Math.max(0, this.link - dt * 0.035);
    }
    if (!this.linkAnnounced && this.linkReady()) {
      this.linkAnnounced = true;
      wing.grantFlightCharge();
      this.onEvent({ type: 'link-ready', stage: this.stageIndex + 1, side: sideForBoat(wingId) });
    }
  }

  private updateRelay(leaderId: number): void {
    if (this.relayOpen || !this.linkReady()) return;
    const leaderU = this.samples[leaderId].u;
    if (leaderU < this.stageRuntime.relayU) return;
    this.relayOpen = true;
    this.course.setFlightGateLocked(this.stageIndex, false);
    this.onEvent({ type: 'relay', stage: this.stageIndex + 1, side: sideForBoat(leaderId) });
  }

  private updateFailures(dt: number, wingId: number): void {
    for (let id = 0; id < 2; id++) {
      const sample = this.samples[id];
      const boat = this.boats[id];
      if (sample.distance <= TEAM_SAFE_COURSE_M && boat.state.flightPhase === 'surface' &&
          boat.state.flightRouteState !== 'failed') {
        this.lastSafeU[id] = sample.u;
        this.offCourseTime[id] = Math.max(0, this.offCourseTime[id] - dt * 2);
      } else if (sample.distance > TEAM_OFF_COURSE_M) {
        this.offCourseTime[id] += dt;
      }
      const routeFailed = id === wingId && boat.state.flightRouteState === 'failed';
      if (this.recoveryTime[id] <= 0 && (routeFailed || this.offCourseTime[id] >= 0.65)) {
        this.recoveryTime[id] = PERSONAL_RECOVERY_S;
        this.recoveryStartedAt[id] = this.recoveryClock;
      }
    }

    const shared = this.recoveryTime[0] > 0 && this.recoveryTime[1] > 0 &&
      Math.abs(this.recoveryStartedAt[0] - this.recoveryStartedAt[1]) <= SHARED_RECOVERY_WINDOW_S;
    if (shared) {
      this.recoverShared();
      return;
    }
    for (let id = 0; id < 2; id++) {
      if (this.recoveryTime[id] <= 0) continue;
      if (this.boats[id].state.flightPhase !== 'surface') continue;
      this.recoveryTime[id] = Math.max(0, this.recoveryTime[id] - dt);
      if (this.recoveryTime[id] <= 0) this.recoverOne(id, id === wingId);
    }

    const wingState = this.boats[wingId].state.flightRouteState;
    if (wingState === 'passed' && this.lastWingRouteState !== 'passed') {
      this.wingCleared = true;
      this.onEvent({ type: 'gate', stage: this.stageIndex + 1, side: sideForBoat(wingId) });
    }
    this.lastWingRouteState = wingState;
  }

  private recoverOne(id: number, wing: boolean): void {
    const u = Math.max(this.stageRuntime.startU, this.lastSafeU[id] - 0.004);
    this.placeBoat(id, u, id === 0 ? -2.2 : 2.2);
    this.boats[id].restoreFlightCheckpoint(this.stageIndex, wing && this.linkReady() ? 1 : 0);
    this.course.resetFlightTrackingForBoat(this.boats[id]);
    this.wakes[id].clear();
    this.offCourseTime[id] = 0;
    this.recoveryStartedAt[id] = -100;
    this.course.setFlightGateLocked(this.stageIndex, !this.relayOpen);
    this.onEvent({ type: 'recover', stage: this.stageIndex + 1, side: sideForBoat(id), shared: false });
  }

  private recoverShared(): void {
    for (let id = 0; id < 2; id++) {
      this.placeBoat(id, this.stageRuntime.startU, id === 0 ? -2.4 : 2.4);
      this.boats[id].restoreFlightCheckpoint(this.stageIndex, 0);
      this.wakes[id].clear();
      this.recoveryTime[id] = 0;
      this.recoveryStartedAt[id] = -100;
      this.offCourseTime[id] = 0;
      this.lastSafeU[id] = this.stageRuntime.startU;
    }
    this.link = 0;
    this.anchors = 0;
    this.relayOpen = false;
    this.wingCleared = false;
    this.linkAnnounced = false;
    this.reachedRendezvous.fill(false);
    this.course.resetFlightChallenge();
    this.course.setGuidanceBoat(boatId(opposite(this.leaderSide())));
    this.course.setFlightGateLocked(this.stageIndex, true);
    this.onEvent({ type: 'recover', stage: this.stageIndex + 1, shared: true });
  }

  private updateStageCompletion(): void {
    if (!this.wingCleared || this.phase !== 'racing') return;
    for (let id = 0; id < 2; id++) {
      this.reachedRendezvous[id] ||= this.samples[id].u >= this.stageRuntime.rendezvousU;
    }
    const bothPast = this.reachedRendezvous[0] && this.reachedRendezvous[1];
    const bothSurface = this.boats[0].state.flightPhase === 'surface' && this.boats[1].state.flightPhase === 'surface';
    if (!bothPast || !bothSurface) return;
    const completed = this.stageIndex + 1;
    this.onEvent({ type: 'stage', stage: completed, value: Math.min(TOTAL_STAGES, completed + 1) });
    if (completed >= TOTAL_STAGES) {
      this.phase = 'finished';
      this.onEvent({ type: 'finish', stage: completed, value: this.elapsed });
      return;
    }
    this.stageIndex++;
    this.phase = 'role-swap';
    this.phaseTimer = ROLE_SWAP_S;
    this.course.setFlightGateLocked(completed - 1, false);
  }

  private sampleTeam(): void {
    for (let id = 0; id < 2; id++) this.course.sample(this.boats[id].state.position, this.samples[id], 'surface');
  }

  private configurePursuers(): void {
    const count = this.stageIndex === 2 ? 1 : this.stageIndex === 5 ? 2 : this.stageIndex === 6 ? 3 : 0;
    this.activePursuers = [];
    this.activeBoatBuffer = [this.boats[0], this.boats[1]];
    for (let id = 2; id < this.boats.length; id++) {
      const active = id < 2 + count;
      this.boats[id].object.visible = active;
      if (!active) continue;
      this.activePursuers.push(id);
      this.activeBoatBuffer.push(this.boats[id]);
      this.boats[id].restoreFlightCheckpoint(this.stageIndex, 0);
      const offset = 0.008 + (id - 2) * 0.005;
      this.placeBoat(id, wrapU(this.stageRuntime.startU - offset), (id % 2 ? 4.8 : -4.8));
      this.wakes[id].clear();
      this.pursuit.get(id)?.reset();
    }
  }

  private updatePursuers(dt: number, t: number, targetId: number): void {
    for (const id of this.activePursuers) {
      const boat = this.boats[id];
      boat.setOpponentEffectDistance(boat.state.position.distanceTo(this.boats[targetId].state.position));
      const input = this.pursuit.get(id)!.update(dt, boat, this.boats[targetId]);
      boat.update(dt, input, t, 'drift', 1.03, 1, this.wakes);
    }
  }

  private applyWingRouteAssist(wing: Boat, input: BoatInput): void {
    if (wing.state.flightPhase === 'surface') return;
    const route = this.course.flightRoutes[this.stageIndex];
    this.course.sample(wing.state.position, this.wingRouteSample, route.id);
    const targetU = Math.min(route.exitU, this.wingRouteSample.u + 24 / this.course.length);
    this.course.routePointAt(route.id, targetU, this.wingAssistPoint);
    this.course.routeTangentAt(route.id, targetU, this.wingAssistTangent);
    const pointError = wrapAngle(
      Math.atan2(
        this.wingAssistPoint.x - wing.state.position.x,
        this.wingAssistPoint.z - wing.state.position.z,
      ) - wing.state.heading,
    );
    const tangentError = wrapAngle(
      Math.atan2(this.wingAssistTangent.x, this.wingAssistTangent.z) - wing.state.heading,
    );
    const correction = clamp(-(pointError * 0.58 + tangentError * 0.42) * 2.5, -1, 1);
    const authority = Math.abs(input.steer) < 0.12 ? 0.42 : 0.18;
    input.steer = clamp(input.steer + correction * authority, -1, 1);
  }

  private makeStageRuntime(index: number): StageRuntime {
    const route = this.course.flightRoutes[index];
    const launchSpan = Math.max(0.012, route.launchFromU - route.qualifyFromU);
    const first = route.qualifyFromU + launchSpan * 0.22;
    const second = route.qualifyFromU + launchSpan * 0.5;
    const third = route.qualifyFromU + launchSpan * 0.78;
    const relayU = Math.min(
      route.launchFromU - 0.001,
      Math.max(third + 0.001, route.launchFromU - 0.003),
    );
    return {
      startU: Math.max(index === 0 ? 0.006 : 0, route.qualifyFromU - 0.012),
      anchorUs: [first, second, third],
      relayU,
      holdU: route.gateUs[0] - 0.005,
      rendezvousU: Math.min(0.992, route.exitU + 0.01),
    };
  }

  private placeBoat(id: number, u: number, lateral: number): void {
    this.course.pointAt(u, _point);
    this.course.tangentAt(u, _tangent);
    const heading = Math.atan2(_tangent.x, _tangent.z);
    this.boats[id].teleport(
      _point.x + _tangent.z * lateral,
      _point.z - _tangent.x * lateral,
      heading,
    );
  }

  private leaderSide(): SeatSide {
    return this.stageIndex % 2 === 0 ? 'left' : 'right';
  }

  private linkReady(): boolean {
    return this.anchors >= this.stageRuntime.anchorUs.length && this.link >= 0.999;
  }

  private objective(): string {
    if (this.phase === 'idle') return '等待远征';
    if (this.phase === 'countdown') return '准备接力';
    if (this.phase === 'role-swap') return '职责交换';
    if (this.phase === 'finished') return '远征完成';
    if (!this.linkReady()) return '领航漂移 · 翼手跟流';
    if (!this.relayOpen) return '领航激活水面中继';
    if (!this.wingCleared) return '翼手穿越飞行门';
    return '两人前往会合环';
  }

  private visualState(): TeamVisualState {
    return {
      stageIndex: this.stageIndex,
      anchorUs: this.stageRuntime.anchorUs,
      relayU: this.stageRuntime.relayU,
      rendezvousU: this.stageRuntime.rendezvousU,
      anchorsCleared: this.anchors,
      relayOpen: this.relayOpen,
      wingCleared: this.wingCleared,
    };
  }
}

class TeamPursuitController {
  private steer = 0;
  private readonly sample = sampleState();
  private readonly target = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly input = neutralInput();

  constructor(private readonly course: Course, private readonly id: number) {}

  reset(): void {
    this.steer = 0;
  }

  update(dt: number, boat: Boat, targetBoat: Boat): BoatInput {
    this.course.sample(boat.state.position, this.sample, 'surface');
    const look = 24 + Math.min(18, Math.abs(boat.state.speed) * 0.45);
    this.course.pointAt(this.sample.u + look / this.course.length, this.target);
    this.course.tangentAt(this.sample.u + look / this.course.length, this.tangent);
    const lane = (this.id % 2 ? 1 : -1) * (2.6 + (this.id - 2) * 0.5);
    this.target.x += this.tangent.z * lane;
    this.target.z -= this.tangent.x * lane;
    const dx = this.target.x - boat.state.position.x;
    const dz = this.target.z - boat.state.position.z;
    const pointError = wrapAngle(Math.atan2(dx, dz) - boat.state.heading);
    const targetError = wrapAngle(Math.atan2(this.tangent.x, this.tangent.z) - boat.state.heading);
    const desired = clamp(-(pointError * 0.76 + targetError * 0.24) * 2.35, -1, 1);
    this.steer += (desired - this.steer) * Math.min(1, dt * 7.5);
    const gap = boat.state.position.distanceTo(targetBoat.state.position);
    this.input.throttle = gap > 38 ? 1 : gap < 10 ? 0.35 : 0.78;
    this.input.steer = this.steer;
    this.input.drift = false;
    this.input.flightTrigger = false;
    this.input.airBrake = false;
    return this.input;
  }
}

function sampleState(): CourseSample {
  return {
    u: 0,
    distance: 0,
    point: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    routeId: 'surface',
  };
}

function neutralInput(): BoatInput {
  return { throttle: 0, steer: 0, drift: false, flightTrigger: false, airBrake: false };
}

function copyInput(target: BoatInput, source: BoatInput): BoatInput {
  target.throttle = source.throttle;
  target.steer = source.steer;
  target.drift = source.drift;
  target.flightTrigger = source.flightTrigger;
  target.airBrake = source.airBrake;
  return target;
}

function boatId(side: SeatSide): number {
  return side === 'left' ? 0 : 1;
}

function sideForBoat(id: number): SeatSide {
  return id === 0 ? 'left' : 'right';
}

function opposite(side: SeatSide): SeatSide {
  return side === 'left' ? 'right' : 'left';
}

function wrapU(value: number): number {
  return (value % 1 + 1) % 1;
}

function wrapAngle(value: number): number {
  let angle = value % (Math.PI * 2);
  if (angle > Math.PI) angle -= Math.PI * 2;
  else if (angle <= -Math.PI) angle += Math.PI * 2;
  return angle;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
