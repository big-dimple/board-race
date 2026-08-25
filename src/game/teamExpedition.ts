import * as THREE from 'three';
import type { BoatInput, CourseSample, IWake } from '../contracts';
import type { LocalDeviceId, SeatSide } from '../core/localMultiplayerInput';
import { Boat } from './boat';
import { Course } from './course';
import {
  TeamCourseVisuals,
  type TeamMarkerKind,
  type TeamTargetVisual,
  type TeamVisualState,
} from './teamCourseVisuals';

export type TeamExpeditionPhase = 'idle' | 'countdown' | 'tutorial' | 'racing' | 'station-transition' | 'finished';
export type TeamRole = 'trainee' | 'sender' | 'receiver' | 'anchor' | 'runner' | 'pilot' | 'operator' | 'dock';

export interface TeamExpeditionStart {
  resumeStation: number;
  playTutorial: boolean;
  swapRoles: boolean;
  leftDeviceId: LocalDeviceId;
  rightDeviceId: LocalDeviceId;
}

export interface TeamExpeditionEvent {
  type: 'countdown' | 'go' | 'tutorial' | 'send' | 'catch' | 'miss' | 'lock' | 'gate' | 'recover' | 'station' | 'finish';
  station: number;
  side?: SeatSide;
  value?: number;
  shared?: boolean;
}

export interface TeamSeatSnapshot {
  role: TeamRole;
  instruction: string;
  actionLabel: string;
  interactionProgress: number;
  inTarget: boolean;
  ready: boolean;
}

export interface TeamExpeditionSnapshot {
  phase: TeamExpeditionPhase;
  station: number;
  totalStations: number;
  stationName: string;
  beat: number;
  beatTotal: number;
  elapsed: number;
  objective: string;
  hintLevel: 0 | 1 | 2;
  left: TeamSeatSnapshot;
  right: TeamSeatSnapshot;
  fullRun: boolean;
  tutorialActive: boolean;
  gateOffset: number;
  gatePowered: boolean;
  activePursuers: readonly number[];
}

const TOTAL_STATIONS = 3;
const COUNTDOWN_S = 3.15;
const TRANSITION_S = 1.35;
const TARGET_RADIUS_M = 14;
const OFF_COURSE_M = 66;
const SAFE_COURSE_M = 20;
const FLIGHT_ROUTE_INDEX = 0;
const LANE = 5;
const STATION_NAMES = ['锚锤工坊', '双锁水闸', '水空协奏'] as const;
const TUTORIAL_LABELS = ['前进离港', '向左转向', '向右转向', '刹停入位', '倒车脱离', '能力校准'] as const;
const RESONANCE_US = [0.017, 0.025, 0.033, 0.041] as const;
const LOCK_ANCHOR_US = [0.208, 0.222] as const;
const LOCK_RUNNER_US = [0.218, 0.232] as const;
const LOCK_GATE_CLEARANCE_U = 0.001;
const LOCK_DOCK_U = 0.24;
const SKY_START_U = 0.012;
const SKY_CONTROL_U = 0.042;
const SKY_DOCK_U = 0.128;
const STATION_START_US = [0.007, 0.194, SKY_START_U] as const;
const _point = new THREE.Vector3();
const _pointB = new THREE.Vector3();
const _tangent = new THREE.Vector3();

/** Three compact asymmetric activities driven entirely by fixed-step boat input. */
export class TeamExpedition {
  readonly visuals: TeamCourseVisuals;
  phase: TeamExpeditionPhase = 'idle';
  private stationIndex = 0;
  private elapsed = 0;
  private phaseTimer = 0;
  private countdownBeat = 4;
  private fullRun = true;
  private playTutorial = true;
  private swapRoles = false;
  private beat = 0;
  private beatProgress = 0;
  private receiverCharge = 0;
  private objectiveClock = 0;
  private pulseTimer = -1;
  private readonly pulseDuration = 1.2;
  private pulseMissTimer = 0;
  private readonly pulseMissDuration = 0.85;
  private gateOffset = 0;
  private gatePowered = false;
  private flightCleared = false;
  private dockHold = 0;
  private pendingStation = 0;
  private readonly tutorialStep = [0, 0];
  private readonly tutorialHold = [0, 0];
  private readonly samples: CourseSample[] = [sampleState(), sampleState()];
  private readonly pilotRouteSample = sampleState();
  private readonly pilotAssistPoint = new THREE.Vector3();
  private readonly pilotAssistTangent = new THREE.Vector3();
  private readonly offCourseTime = [0, 0];
  private readonly actionHeld = [false, false];
  private readonly playerInputBuffer: [BoatInput, BoatInput] = [neutralInput(), neutralInput()];
  private readonly activeBoatBuffer: Boat[];
  private readonly flightBoatBuffer: Boat[];
  private seatDevices: Record<SeatSide, LocalDeviceId> = {
    left: 'keyboard-left',
    right: 'keyboard-right',
  };
  private lastPilotRouteState = 'idle';

  constructor(
    private readonly course: Course,
    private readonly boats: readonly Boat[],
    private readonly wakes: readonly IWake[],
    private readonly onEvent: (event: TeamExpeditionEvent) => void,
  ) {
    this.visuals = new TeamCourseVisuals(course);
    this.activeBoatBuffer = [boats[0], boats[1]];
    this.flightBoatBuffer = [boats[1]];
  }

  start(config: TeamExpeditionStart): void {
    this.stationIndex = clampInt(config.resumeStation, 0, TOTAL_STATIONS - 1);
    this.fullRun = this.stationIndex === 0;
    this.playTutorial = config.playTutorial && this.stationIndex === 0;
    this.swapRoles = config.swapRoles;
    this.elapsed = 0;
    this.beat = 0;
    this.beatProgress = 0;
    this.receiverCharge = 0;
    this.objectiveClock = 0;
    this.pulseTimer = -1;
    this.pulseMissTimer = 0;
    this.seatDevices = { left: config.leftDeviceId, right: config.rightDeviceId };
    this.tutorialStep.fill(0);
    this.tutorialHold.fill(0);
    for (let id = 0; id < this.boats.length; id++) {
      this.boats[id].setPlayerOwned(id < 2);
      this.boats[id].object.visible = id < 2;
    }
    this.prepareStart(this.playTutorial ? 0.004 : STATION_START_US[this.stationIndex]);
    this.phase = 'countdown';
    this.phaseTimer = COUNTDOWN_S;
    this.countdownBeat = 4;
    this.visuals.setState(this.visualState());
  }

  stop(): void {
    this.phase = 'idle';
    this.course.resetFlightChallenge();
    this.course.setGuidanceBoat(0);
    this.visuals.hide();
    for (let id = 1; id < this.boats.length; id++) this.boats[id].setPlayerOwned(false);
    for (const boat of this.boats) boat.object.visible = true;
  }

  step(dt: number, t: number, leftInput: BoatInput, rightInput: BoatInput): boolean {
    if (this.phase === 'idle' || this.phase === 'finished') {
      this.visuals.update(t);
      return false;
    }
    if (this.phase === 'countdown') {
      this.updateCountdown(dt, t);
      return false;
    }
    if (this.phase === 'station-transition') {
      this.phaseTimer = Math.max(0, this.phaseTimer - dt);
      for (let id = 0; id < 2; id++) this.boats[id].syncSurfacePresentation(t);
      this.visuals.update(t);
      if (this.phaseTimer <= 0) this.activateStation(this.pendingStation, true);
      return false;
    }

    const inputs = this.playerInputBuffer;
    copyInput(inputs[0], leftInput);
    copyInput(inputs[1], rightInput);
    this.actionHeld[0] = leftInput.drift;
    this.actionHeld[1] = rightInput.drift;
    this.objectiveClock += dt;
    if (this.phase === 'racing') this.elapsed += dt;

    for (let id = 0; id < 2; id++) {
      inputs[id].drift = false;
      if (this.phase !== 'racing' || this.stationIndex !== 2 || id !== this.pilotId()) {
        inputs[id].flightTrigger = false;
      }
    }
    if (this.phase === 'racing' && this.stationIndex === 2) this.prepareSkyControl(dt, inputs);
    if (this.phase === 'racing' && this.stationIndex === 2) this.applyPilotAssist(inputs[this.pilotId()]);

    for (let id = 0; id < 2; id++) {
      this.boats[id].update(dt, inputs[id], t, 'drift', 1, 1, this.wakes);
      if (this.stationIndex !== 2 || id !== this.pilotId()) this.boats[id].state.flightCharges = 0;
    }
    this.applyTargetAssist(dt, inputs);
    if (this.phase === 'racing' && this.stationIndex === 2) {
      this.flightBoatBuffer[0] = this.boats[this.pilotId()];
      this.course.updateFlightRoute(dt, this.flightBoatBuffer);
    }
    this.sampleTeam();

    if (this.phase === 'tutorial') this.updateTutorial(dt);
    else if (this.stationIndex === 0) this.updateResonance(dt);
    else if (this.stationIndex === 1) this.updateLocks(dt);
    else this.updateSky(dt);
    this.updateRecoveries(dt);
    this.visuals.setState(this.visualState());
    this.visuals.update(t);
    return true;
  }

  snapshot(): TeamExpeditionSnapshot {
    return {
      phase: this.phase,
      station: this.stationIndex + 1,
      totalStations: TOTAL_STATIONS,
      stationName: this.phase === 'tutorial' || (this.phase === 'countdown' && this.playTutorial)
        ? '驾驶校准'
        : STATION_NAMES[this.stationIndex],
      beat: this.phase === 'tutorial' ? Math.min(6, Math.max(this.tutorialStep[0], this.tutorialStep[1]) + 1) : this.beat + 1,
      beatTotal: this.phase === 'tutorial' ? 6 : this.stationIndex === 0 ? 4 : 3,
      elapsed: this.elapsed,
      objective: this.objective(),
      hintLevel: this.objectiveClock >= 15 ? 2 : this.objectiveClock >= 8 ? 1 : 0,
      left: this.seatSnapshot('left'),
      right: this.seatSnapshot('right'),
      fullRun: this.fullRun,
      tutorialActive: this.phase === 'tutorial' || (this.phase === 'countdown' && this.playTutorial),
      gateOffset: this.gateOffset,
      gatePowered: this.gatePowered,
      activePursuers: [],
    };
  }

  roleFor(side: SeatSide): TeamRole { return this.seatSnapshot(side).role; }
  deviceFor(side: SeatSide): LocalDeviceId { return this.seatDevices[side]; }
  activeBoats(): readonly Boat[] { return this.activeBoatBuffer; }

  debugPlaceAtTarget(side: SeatSide): void {
    const target = this.targetFor(side);
    const id = boatId(side);
    this.placeBoat(id, target.u, target.lateral);
    const pilotCharge = this.stationIndex === 2 && id === this.pilotId() && !this.flightCleared ? 1 : 0;
    this.boats[id].restoreFlightCheckpoint(this.stationIndex === 2 ? FLIGHT_ROUTE_INDEX : this.stationIndex, pilotCharge);
    this.course.resetFlightTrackingForBoat(this.boats[id]);
    this.wakes[id].clear();
    this.sampleTeam();
  }

  private prepareStart(u: number): void {
    this.course.resetFlightChallenge();
    this.course.setGuidanceBoat(0);
    for (let id = 0; id < 2; id++) {
      this.placeBoat(id, u, sideLateral(sideForBoat(id)));
      this.boats[id].restoreFlightCheckpoint(this.stationIndex, 0);
      this.course.resetFlightTrackingForBoat(this.boats[id]);
      this.wakes[id].clear();
    }
    this.sampleTeam();
  }

  private updateCountdown(dt: number, t: number): void {
    this.phaseTimer = Math.max(0, this.phaseTimer - dt);
    const beat = Math.ceil(this.phaseTimer);
    if (beat < this.countdownBeat && beat > 0) {
      this.countdownBeat = beat;
      this.onEvent({ type: 'countdown', station: this.stationIndex + 1, value: beat });
    }
    this.boats[0].syncSurfacePresentation(t);
    this.boats[1].syncSurfacePresentation(t);
    this.visuals.update(t);
    if (this.phaseTimer > 0) return;
    if (this.playTutorial) {
      this.phase = 'tutorial';
      this.objectiveClock = 0;
      this.onEvent({ type: 'go', station: 0 });
    } else this.activateStation(this.stationIndex, false);
  }

  private activateStation(index: number, teleport: boolean): void {
    this.stationIndex = index;
    this.beat = 0;
    this.beatProgress = 0;
    this.receiverCharge = 0;
    this.objectiveClock = 0;
    this.pulseTimer = -1;
    this.pulseMissTimer = 0;
    this.gateOffset = (this.swapRoles ? -1 : 1) * 4.5;
    this.gatePowered = false;
    this.flightCleared = false;
    this.dockHold = 0;
    this.lastPilotRouteState = 'idle';
    this.offCourseTime.fill(0);
    this.course.resetFlightChallenge();
    if (teleport) this.prepareStart(STATION_START_US[index]);
    if (index === 2) {
      const pilot = this.pilotId();
      this.course.setGuidanceBoat(pilot);
      this.boats[pilot].restoreFlightCheckpoint(FLIGHT_ROUTE_INDEX, 1);
      this.course.resetFlightTrackingForBoat(this.boats[pilot]);
      this.course.setTeamFlightGateControl(FLIGHT_ROUTE_INDEX, true, this.gateOffset);
    } else {
      this.course.setGuidanceBoat(0);
      for (let id = 0; id < 2; id++) this.boats[id].restoreFlightCheckpoint(index, 0);
    }
    this.sampleTeam();
    this.phase = 'racing';
    this.onEvent({ type: 'go', station: index + 1 });
  }

  private updateTutorial(dt: number): void {
    for (let id = 0; id < 2; id++) {
      const step = this.tutorialStep[id];
      if (step >= TUTORIAL_LABELS.length) continue;
      const input = this.playerInputBuffer[id];
      const speed = this.boats[id].state.speed;
      const successful = step === 0 ? input.throttle > 0.55 && speed > 3
        : step === 1 ? input.steer < -0.55 && Math.abs(speed) > 2
        : step === 2 ? input.steer > 0.55 && Math.abs(speed) > 2
        : step === 3 ? input.throttle < -0.55 && Math.abs(speed) < 2.5
        : step === 4 ? speed < -0.55
        : this.actionHeld[id];
      this.tutorialHold[id] = successful ? this.tutorialHold[id] + dt : Math.max(0, this.tutorialHold[id] - dt * 2);
      const required = step === 3 ? 0.18 : step === 5 ? 0.35 : 0.28;
      if (this.tutorialHold[id] < required) continue;
      this.tutorialStep[id]++;
      this.tutorialHold[id] = 0;
      this.objectiveClock = 0;
    }
    if (this.tutorialStep[0] >= 6 && this.tutorialStep[1] >= 6) this.completeTutorial();
  }

  private completeTutorial(): void {
    if (this.phase !== 'tutorial') return;
    this.playTutorial = false;
    this.onEvent({ type: 'tutorial', station: 0 });
    this.pendingStation = 0;
    this.phase = 'station-transition';
    this.phaseTimer = 2;
  }

  private updateResonance(dt: number): void {
    if (this.beat >= 4) return;
    if (this.pulseMissTimer > 0) {
      this.pulseMissTimer = Math.max(0, this.pulseMissTimer - dt);
      return;
    }
    const sender = this.resonanceSender(this.beat);
    const receiver = opposite(sender);
    const senderId = boatId(sender);
    const receiverId = boatId(receiver);
    const sourceU = RESONANCE_US[this.beat];
    const targetU = sourceU + 0.0045;
    const senderIn = this.inTarget(senderId, sourceU, sideLateral(sender));
    const receiverIn = this.inTarget(receiverId, targetU, sideLateral(receiver));
    if (this.receiverCharge < 1) {
      this.receiverCharge = receiverIn && this.actionHeld[receiverId]
        ? Math.min(1, this.receiverCharge + dt / 0.42)
        : Math.max(0, this.receiverCharge - dt * 1.8);
    }

    if (this.pulseTimer < 0) {
      this.beatProgress = senderIn && this.actionHeld[senderId]
        ? Math.min(1, this.beatProgress + dt / 0.42)
        : Math.max(0, this.beatProgress - dt * 1.8);
      if (this.beatProgress >= 1) {
        this.pulseTimer = 0;
        this.beatProgress = 0;
        this.objectiveClock = 0;
        this.onEvent({ type: 'send', station: 1, side: sender });
      }
      return;
    }

    this.pulseTimer += dt;
    if (this.pulseTimer >= this.pulseDuration && this.receiverCharge >= 1) {
      this.onEvent({ type: 'catch', station: 1, side: receiver, value: this.beat + 1 });
      this.beat++;
      this.pulseTimer = -1;
      this.beatProgress = 0;
      this.receiverCharge = 0;
      this.objectiveClock = 0;
      if (this.beat >= 4) this.completeStation();
    } else if (this.pulseTimer >= this.pulseDuration) {
      this.pulseTimer = -1;
      this.pulseMissTimer = this.pulseMissDuration;
      this.beatProgress = 0;
      this.receiverCharge = 0;
      this.objectiveClock = 8;
      this.onEvent({ type: 'miss', station: 1, side: receiver });
    }
  }

  private applyTargetAssist(dt: number, inputs: [BoatInput, BoatInput]): void {
    if (this.phase !== 'tutorial' && this.phase !== 'racing') return;
    for (let id = 0; id < 2; id++) {
      const side = sideForBoat(id);
      const target = this.targetFor(side);
      if (!target.active || !this.inTarget(id, target.u, target.lateral)) continue;
      const neutralCalibration = this.phase === 'tutorial' &&
        Math.abs(inputs[id].throttle) <= 0.12 && Math.abs(inputs[id].steer) <= 0.12;
      const activeMooring = this.phase === 'racing' &&
        Math.abs(inputs[id].throttle) <= 0.12 && (
          this.actionHeld[id] ||
          (target.kind === 'receiver' && this.receiverCharge >= 0.6) ||
          (target.kind === 'anchor' && this.beatProgress > 0.08)
        );
      if (!neutralCalibration && !activeMooring) continue;
      targetWorld(this.course, target.u, target.lateral, _point);
      const position = this.boats[id].state.position;
      this.boats[id].applyMooringAssist(
        neutralCalibration ? position.x : _point.x,
        neutralCalibration ? position.z : _point.z,
        dt,
        neutralCalibration ? 0.9 : 1.25,
      );
    }
  }

  private updateLocks(dt: number): void {
    if (this.beat < 2) {
      const anchor = this.lockAnchor(this.beat);
      const runner = opposite(anchor);
      const anchorId = boatId(anchor);
      const runnerId = boatId(runner);
      const anchorIn = this.inTarget(anchorId, LOCK_ANCHOR_US[this.beat], sideLateral(anchor));
      const powered = anchorIn && this.actionHeld[anchorId];
      this.beatProgress = powered
        ? Math.min(1, this.beatProgress + dt / 0.6)
        : Math.max(0, this.beatProgress - dt / 0.75);
      const gateCleared = this.samples[runnerId].u > LOCK_RUNNER_US[this.beat] + LOCK_GATE_CLEARANCE_U;
      if (this.beatProgress >= 0.74 && gateCleared) {
        this.onEvent({ type: 'lock', station: 2, side: runner, value: this.beat + 1 });
        this.beat++;
        this.beatProgress = 0;
        this.objectiveClock = 0;
      } else if (gateCleared) {
        this.placeBoat(runnerId, LOCK_RUNNER_US[this.beat] - 0.009, sideLateral(runner));
        this.course.resetFlightTrackingForBoat(this.boats[runnerId]);
        this.wakes[runnerId].clear();
        this.objectiveClock = 8;
      }
      return;
    }

    const bothDocked = this.inTarget(0, LOCK_DOCK_U, sideLateral('left')) &&
      this.inTarget(1, LOCK_DOCK_U, sideLateral('right'));
    this.dockHold = bothDocked && this.actionHeld[0] && this.actionHeld[1]
      ? Math.min(0.65, this.dockHold + dt)
      : Math.max(0, this.dockHold - dt * 2);
    this.beatProgress = this.dockHold / 0.6;
    if (this.dockHold >= 0.6) {
      this.beat = 3;
      this.completeStation();
    }
  }

  private prepareSkyControl(dt: number, inputs: [BoatInput, BoatInput]): void {
    const operator = this.operatorSide();
    const operatorId = boatId(operator);
    const pilotId = this.pilotId();
    const inControl = this.inTarget(operatorId, SKY_CONTROL_U, sideLateral(operator));
    this.gatePowered = !this.flightCleared && inControl && this.actionHeld[operatorId];
    if (this.gatePowered) this.gateOffset = clamp(this.gateOffset + inputs[operatorId].steer * dt * 7, -6, 6);
    if (!this.gatePowered && this.boats[pilotId].state.flightPhase === 'surface' && inputs[pilotId].flightTrigger) {
      inputs[pilotId].flightTrigger = false;
      this.objectiveClock = Math.max(this.objectiveClock, 15);
    }
    this.course.setTeamFlightGateControl(FLIGHT_ROUTE_INDEX, !this.gatePowered, this.gateOffset);
  }

  private applyPilotAssist(input: BoatInput): void {
    const pilot = this.boats[this.pilotId()];
    if (pilot.state.flightPhase === 'surface') return;
    const route = this.course.flightRoutes[FLIGHT_ROUTE_INDEX];
    this.course.sample(pilot.state.position, this.pilotRouteSample, route.id);
    const targetU = Math.min(route.exitU, this.pilotRouteSample.u + 24 / this.course.length);
    this.course.routePointAt(route.id, targetU, this.pilotAssistPoint);
    this.course.routeTangentAt(route.id, targetU, this.pilotAssistTangent);
    const pointError = wrapAngle(
      Math.atan2(
        this.pilotAssistPoint.x - pilot.state.position.x,
        this.pilotAssistPoint.z - pilot.state.position.z,
      ) - pilot.state.heading,
    );
    const tangentError = wrapAngle(
      Math.atan2(this.pilotAssistTangent.x, this.pilotAssistTangent.z) - pilot.state.heading,
    );
    const correction = clamp(-(pointError * 0.58 + tangentError * 0.42) * 2.5, -1, 1);
    const authority = Math.abs(input.steer) < 0.12 ? 0.42 : 0.18;
    input.steer = clamp(input.steer + correction * authority, -1, 1);
  }

  private updateSky(dt: number): void {
    const pilotId = this.pilotId();
    const pilot = this.boats[pilotId];
    const routeState = pilot.state.flightRouteState;
    if (routeState === 'passed' && this.lastPilotRouteState !== 'passed') {
      this.flightCleared = true;
      this.gatePowered = false;
      this.course.setTeamFlightGateControl(FLIGHT_ROUTE_INDEX, false, this.gateOffset);
      this.onEvent({ type: 'gate', station: 3, side: sideForBoat(pilotId) });
      this.objectiveClock = 0;
    }
    if (routeState === 'failed' && this.lastPilotRouteState !== 'failed') {
      this.recoverSkyAttempt();
      return;
    }
    this.lastPilotRouteState = routeState;
    if (!this.flightCleared) {
      this.beat = 0;
      this.beatProgress = this.gatePowered ? 1 - Math.abs(this.gateOffset) / 6 : 0;
      return;
    }
    if (pilot.state.flightPhase !== 'surface') {
      this.beat = 1;
      this.beatProgress = 0.5;
      return;
    }
    this.beat = 2;
    const leftDocked = this.inTarget(0, SKY_DOCK_U, sideLateral('left')) && Math.abs(this.boats[0].state.speed) <= 2.5;
    const rightDocked = this.inTarget(1, SKY_DOCK_U, sideLateral('right')) && Math.abs(this.boats[1].state.speed) <= 2.5;
    this.dockHold = leftDocked && rightDocked && this.actionHeld[0] && this.actionHeld[1]
      ? Math.min(0.65, this.dockHold + dt)
      : Math.max(0, this.dockHold - dt * 2);
    this.beatProgress = this.dockHold / 0.6;
    if (this.dockHold >= 0.6) this.completeStation();
  }

  private completeStation(): void {
    if (this.phase !== 'racing') return;
    const completed = this.stationIndex + 1;
    this.onEvent({ type: 'station', station: completed, value: Math.min(TOTAL_STATIONS, completed + 1) });
    if (completed >= TOTAL_STATIONS) {
      this.phase = 'finished';
      this.onEvent({ type: 'finish', station: completed, value: this.elapsed });
      return;
    }
    this.pendingStation = this.stationIndex + 1;
    this.stationIndex = this.pendingStation;
    this.phase = 'station-transition';
    this.phaseTimer = TRANSITION_S;
  }

  private recoverSkyAttempt(): void {
    const pilot = this.pilotId();
    this.prepareStart(SKY_START_U);
    this.course.setGuidanceBoat(pilot);
    this.boats[pilot].restoreFlightCheckpoint(FLIGHT_ROUTE_INDEX, 1);
    this.course.resetFlightTrackingForBoat(this.boats[pilot]);
    this.gateOffset = (this.swapRoles ? -1 : 1) * 4.5;
    this.gatePowered = false;
    this.flightCleared = false;
    this.lastPilotRouteState = 'idle';
    this.objectiveClock = 0;
    this.course.setTeamFlightGateControl(FLIGHT_ROUTE_INDEX, true, this.gateOffset);
    this.onEvent({ type: 'recover', station: 3, side: sideForBoat(pilot), shared: true });
  }

  private updateRecoveries(dt: number): void {
    if (this.phase !== 'tutorial' && this.phase !== 'racing') return;
    for (let id = 0; id < 2; id++) {
      const safe = this.samples[id].distance <= SAFE_COURSE_M || this.boats[id].state.flightPhase !== 'surface';
      this.offCourseTime[id] = safe
        ? Math.max(0, this.offCourseTime[id] - dt * 2)
        : this.samples[id].distance > OFF_COURSE_M ? this.offCourseTime[id] + dt : this.offCourseTime[id];
      if (this.offCourseTime[id] < 0.65) continue;
      if (this.stationIndex === 2 && (id === this.pilotId() || this.boats[id].state.flightPhase !== 'surface')) {
        this.recoverSkyAttempt();
        return;
      }
      const target = this.targetFor(sideForBoat(id));
      this.placeBoat(id, Math.max(0, target.u - 0.004), target.lateral);
      this.boats[id].restoreFlightCheckpoint(this.stationIndex, 0);
      this.course.resetFlightTrackingForBoat(this.boats[id]);
      this.wakes[id].clear();
      this.offCourseTime[id] = 0;
      this.onEvent({ type: 'recover', station: this.stationIndex + 1, side: sideForBoat(id), shared: false });
    }
  }

  private sampleTeam(): void {
    for (let id = 0; id < 2; id++) this.course.sample(this.boats[id].state.position, this.samples[id], 'surface');
  }

  private inTarget(id: number, u: number, lateral: number): boolean {
    targetWorld(this.course, u, lateral, _point);
    const pos = this.boats[id].state.position;
    return Math.hypot(pos.x - _point.x, pos.z - _point.z) <= TARGET_RADIUS_M;
  }

  private targetFor(side: SeatSide): { u: number; lateral: number; kind: TeamMarkerKind; active: boolean; complete: boolean } {
    const id = boatId(side);
    if (this.phase === 'tutorial' || (this.phase === 'countdown' && this.playTutorial)) {
      return { u: 0.008, lateral: sideLateral(side), kind: 'drive', active: true, complete: this.tutorialStep[id] >= 6 };
    }
    if (this.stationIndex === 0) {
      const sender = this.resonanceSender(Math.min(3, this.beat));
      const sourceU = RESONANCE_US[Math.min(3, this.beat)];
      const sending = this.pulseTimer < 0 && this.pulseMissTimer <= 0;
      return side === sender
        ? { u: sourceU, lateral: sideLateral(side), kind: 'source', active: sending, complete: !sending }
        : { u: sourceU + 0.0045, lateral: sideLateral(side), kind: 'receiver', active: true, complete: this.receiverCharge >= 1 };
    }
    if (this.stationIndex === 1) {
      if (this.beat < 2) {
        const anchor = this.lockAnchor(this.beat);
        return side === anchor
          ? { u: LOCK_ANCHOR_US[this.beat], lateral: sideLateral(side), kind: 'anchor', active: true, complete: false }
          : { u: LOCK_RUNNER_US[this.beat] - 0.006, lateral: sideLateral(side), kind: 'runner', active: this.beatProgress >= 0.74, complete: false };
      }
      return { u: LOCK_DOCK_U, lateral: sideLateral(side), kind: 'dock', active: true, complete: false };
    }
    if (!this.flightCleared) {
      if (side === this.operatorSide()) return { u: SKY_CONTROL_U, lateral: sideLateral(side), kind: 'control', active: true, complete: false };
      const route = this.course.flightRoutes[FLIGHT_ROUTE_INDEX];
      return { u: route.launchFromU - 0.002, lateral: sideLateral(side), kind: 'runner', active: this.gatePowered, complete: false };
    }
    return { u: SKY_DOCK_U, lateral: sideLateral(side), kind: 'dock', active: true, complete: false };
  }

  private seatSnapshot(side: SeatSide): TeamSeatSnapshot {
    const id = boatId(side);
    const target = this.targetFor(side);
    const inTarget = this.inTarget(id, target.u, target.lateral);
    if (this.phase === 'tutorial' || (this.phase === 'countdown' && this.playTutorial)) {
      const step = Math.min(5, this.tutorialStep[id]);
      return {
        role: 'trainee',
        instruction: this.tutorialStep[id] >= 6 ? '校准完成 · 等待伙伴' : this.tutorialInstruction(side, step),
        actionLabel: step === 1 || step === 2
          ? this.turnControlLabel(side, step === 1 ? 'left' : 'right')
          : this.controlLabel(side, step === 5 ? 'action' : step === 3 || step === 4 ? 'reverse' : 'forward'),
        interactionProgress: this.tutorialStep[id] >= 6 ? 1 : clamp(this.tutorialHold[id] / (step === 3 ? 0.18 : step === 5 ? 0.35 : 0.28), 0, 1),
        inTarget,
        ready: this.tutorialStep[id] >= 6,
      };
    }
    if (this.stationIndex === 0) {
      const sender = this.resonanceSender(Math.min(3, this.beat));
      const role: TeamRole = side === sender ? 'sender' : 'receiver';
      const waiting = this.pulseTimer < 0 && this.pulseMissTimer <= 0;
      const marker = side === 'left' ? '蓝席工位' : '黄席工位';
      return {
        role,
        instruction: role === 'sender'
          ? this.pulseMissTimer > 0 ? '核心落水 · 等机构复位'
            : waiting
              ? inTarget ? `按住 ${this.controlLabel(side, 'action')} 抬锤蓄力` : `靠近${marker}的冲击锤`
              : '冲击完成 · 看核心飞向伙伴'
          : this.receiverCharge >= 1
            ? waiting ? '锚钉已压牢 · 等伙伴锤击' : '锚钉已压牢 · 准备接住核心'
            : this.pulseMissTimer > 0 ? '锚钉未锁牢 · 核心已落水'
              : inTarget ? `按住 ${this.controlLabel(side, 'action')} 压下锚钉` : `靠近${marker}的锚钉机`,
        actionLabel: this.controlLabel(side, 'action'),
        interactionProgress: role === 'sender' ? waiting ? this.beatProgress : 1 : this.receiverCharge,
        inTarget,
        ready: role === 'sender' ? !waiting : this.receiverCharge >= 1,
      };
    }
    if (this.stationIndex === 1) {
      if (this.beat >= 2) return {
        role: 'dock', instruction: inTarget ? '停稳并与伙伴同时按住能力键' : '驶入你的终端泊位',
        actionLabel: this.controlLabel(side, 'action'), interactionProgress: this.dockHold / 0.6, inTarget, ready: inTarget,
      };
      const anchor = this.lockAnchor(this.beat);
      const role: TeamRole = side === anchor ? 'anchor' : 'runner';
      return {
        role,
        instruction: role === 'anchor'
          ? inTarget ? '按住能力键并稳住船位' : '驶入供能区'
          : this.beatProgress >= 0.74 ? '水闸已升起 · 向前穿过实体闸门' : '停在闸前 · 等伙伴把水闸升起',
        actionLabel: role === 'anchor' ? this.controlLabel(side, 'action') : this.controlLabel(side, 'forward'),
        interactionProgress: this.beatProgress,
        inTarget,
        ready: role === 'anchor' ? inTarget && this.actionHeld[id] : this.beatProgress >= 0.74,
      };
    }
    if (!this.flightCleared) {
      const role: TeamRole = side === this.operatorSide() ? 'operator' : 'pilot';
      return {
        role,
        instruction: role === 'operator'
          ? inTarget ? '按住能力键供能 · 左右移动飞行门' : '驶入门控轨道'
          : this.gatePowered ? '飞行门已通电 · 到入口按起飞键' : '驶向起飞入口 · 等伙伴供能',
        actionLabel: role === 'operator' ? this.controlLabel(side, 'action') : this.controlLabel(side, 'flight'),
        interactionProgress: this.gatePowered ? 1 : 0,
        inTarget,
        ready: this.gatePowered,
      };
    }
    return {
      role: 'dock',
      instruction: inTarget
        ? Math.abs(this.boats[id].state.speed) <= 2.5 ? '按住能力键完成双泊位' : '继续刹车 · 速度降到 9 km/h'
        : '飞行完成 · 前往终点泊位',
      actionLabel: this.controlLabel(side, 'action'),
      interactionProgress: this.dockHold / 0.6,
      inTarget,
      ready: inTarget && Math.abs(this.boats[id].state.speed) <= 2.5,
    };
  }

  private objective(): string {
    if (this.phase === 'idle') return '等待协作';
    if (this.phase === 'countdown') return this.playTutorial ? '准备驾驶校准' : `准备 ${STATION_NAMES[this.stationIndex]}`;
    if (this.phase === 'station-transition') return `前往 ${STATION_NAMES[this.pendingStation]}`;
    if (this.phase === 'finished') return '三站协作完成';
    if (this.phase === 'tutorial') {
      const slowest = Math.min(this.tutorialStep[0], this.tutorialStep[1]);
      return slowest >= 6 ? '校准完成' : TUTORIAL_LABELS[slowest];
    }
    if (this.stationIndex === 0) {
      if (this.pulseMissTimer > 0) return '锚钉未锁牢 · 核心落水后原位重试';
      if (this.pulseTimer >= 0) return this.receiverCharge >= 1
        ? '核心飞行中 · 锚钉会把它导入轨道'
        : '核心飞行中 · 立刻压下锚钉';
      if (this.receiverCharge >= 1) return '锚钉已锁 · 冲击锤手按住能力键';
      if (this.beatProgress > 0.08) return '冲击锤正在抬起 · 锚钉手也要按住能力键';
      return `${this.beat === 2 ? '工具交换 · ' : ''}锚钉稳住轨道 · 冲击锤发射核心`;
    }
    if (this.stationIndex === 1) return this.beat < 2 ? '一人稳住水闸 · 一人穿门' : '双人同时接通终端';
    if (!this.flightCleared) return this.gatePowered ? '门控手对准 · 飞行员穿门' : '门控手先接通飞行门';
    return this.boats[this.pilotId()].state.flightPhase === 'surface' ? '双人泊位会合' : '飞行员安全落水';
  }

  private visualState(): TeamVisualState {
    const sender = this.resonanceSender(Math.min(3, this.beat));
    const sourceU = RESONANCE_US[Math.min(3, this.beat)];
    return {
      mode: this.phase === 'tutorial' || (this.phase === 'countdown' && this.playTutorial) ? 'tutorial'
        : this.stationIndex === 0 ? 'resonance' : this.stationIndex === 1 ? 'locks' : 'sky',
      left: this.visualTarget('left'),
      right: this.visualTarget('right'),
      pulseActive: this.stationIndex === 0 && (this.pulseTimer >= 0 || this.pulseMissTimer > 0),
      pulseProgress: this.pulseMissTimer > 0 ? 1 : this.pulseTimer < 0 ? 0 : this.pulseTimer / this.pulseDuration,
      pulseMissProgress: this.pulseMissTimer <= 0 ? 0 : 1 - this.pulseMissTimer / this.pulseMissDuration,
      sourcePower: this.beatProgress,
      receiverPower: this.receiverCharge,
      pulseFromU: sourceU,
      pulseFromLateral: sideLateral(sender),
      pulseToU: sourceU + 0.0045,
      pulseToLateral: sideLateral(opposite(sender)),
      lockU: this.stationIndex === 1 && this.beat < 2 ? LOCK_RUNNER_US[this.beat] : LOCK_DOCK_U,
      lockPower: this.stationIndex === 1 ? this.beatProgress : 0,
      dockPower: this.stationIndex >= 1 && this.beat >= 2 ? this.beatProgress : 0,
      skyRouteIndex: FLIGHT_ROUTE_INDEX,
      skyGateOffset: this.gateOffset,
      skyPowered: this.gatePowered,
    };
  }

  private visualTarget(side: SeatSide): TeamTargetVisual {
    const target = this.targetFor(side);
    const tutorialDone = this.phase === 'tutorial' && this.tutorialStep[boatId(side)] >= 6;
    const operatorOnly = this.stationIndex === 2 && !this.flightCleared;
    return {
      ...target,
      visible: !tutorialDone && (!operatorOnly || side === this.operatorSide() || this.gatePowered),
    };
  }

  private tutorialInstruction(side: SeatSide, step: number): string {
    const label = step === 1 || step === 2
      ? this.turnControlLabel(side, step === 1 ? 'left' : 'right')
      : this.controlLabel(side, step === 5 ? 'action' : step === 3 || step === 4 ? 'reverse' : 'forward');
    return step === 0 ? `按住 ${label} 前进离港`
      : step === 1 ? `按住 ${label} 前进并左转`
      : step === 2 ? `按住 ${label} 前进并右转`
      : step === 3 ? `按住 ${label} 刹停`
      : step === 4 ? `继续按住 ${label} 倒车`
      : `按住 ${label} 校准能力`;
  }

  private turnControlLabel(side: SeatSide, direction: 'left' | 'right'): string {
    const device = this.seatDevices[side];
    if (device.startsWith('gamepad:')) return direction === 'left'
      ? '左摇杆 ↖ / 十字键 ↑+←'
      : '左摇杆 ↗ / 十字键 ↑+→';
    if (side === 'left') return direction === 'left' ? 'W + A' : 'W + D';
    return direction === 'left' ? '↑ + ←' : '↑ + →';
  }

  private controlLabel(side: SeatSide, control: 'forward' | 'reverse' | 'steer' | 'action' | 'flight'): string {
    const device = this.seatDevices[side];
    if (device.startsWith('gamepad:')) {
      return control === 'forward' ? '左摇杆 ↑ / RT'
        : control === 'reverse' ? '左摇杆 ↓ / LT'
        : control === 'steer' ? '左摇杆 / 十字键'
        : control === 'action' ? 'X' : 'A';
    }
    if (side === 'left') return control === 'forward' ? 'W' : control === 'reverse' ? 'S' : control === 'steer' ? 'A / D' : control === 'action' ? '左 SHIFT' : 'SPACE';
    return control === 'forward' ? '↑' : control === 'reverse' ? '↓' : control === 'steer' ? '← / →' : control === 'action' ? '右 SHIFT / K' : 'NUM ENTER / I';
  }

  private resonanceSender(beat: number): SeatSide {
    const first: SeatSide = this.swapRoles ? 'right' : 'left';
    return beat < 2 ? first : opposite(first);
  }

  private lockAnchor(beat: number): SeatSide {
    const first: SeatSide = this.swapRoles ? 'left' : 'right';
    return beat === 0 ? first : opposite(first);
  }

  private pilotId(): number { return boatId(this.swapRoles ? 'left' : 'right'); }
  private operatorSide(): SeatSide { return opposite(sideForBoat(this.pilotId())); }

  private placeBoat(id: number, u: number, lateral: number): void {
    this.course.pointAt(u, _pointB);
    this.course.tangentAt(u, _tangent).setY(0).normalize();
    this.boats[id].teleport(
      _pointB.x + _tangent.z * lateral,
      _pointB.z - _tangent.x * lateral,
      Math.atan2(_tangent.x, _tangent.z),
    );
  }
}

function targetWorld(course: Course, u: number, lateral: number, out: THREE.Vector3): THREE.Vector3 {
  course.pointAt(u, out);
  course.tangentAt(u, _tangent).setY(0).normalize();
  out.x += _tangent.z * lateral;
  out.z -= _tangent.x * lateral;
  return out;
}

function sampleState(): CourseSample {
  return { u: 0, distance: 0, point: new THREE.Vector3(), tangent: new THREE.Vector3(), routeId: 'surface' };
}

function neutralInput(): BoatInput { return { throttle: 0, steer: 0, drift: false, flightTrigger: false, airBrake: false }; }

function copyInput(target: BoatInput, source: BoatInput): BoatInput {
  target.throttle = source.throttle;
  target.steer = source.steer;
  target.drift = source.drift;
  target.flightTrigger = source.flightTrigger;
  target.airBrake = source.airBrake;
  return target;
}

function boatId(side: SeatSide): number { return side === 'left' ? 0 : 1; }
function sideForBoat(id: number): SeatSide { return id === 0 ? 'left' : 'right'; }
function sideLateral(side: SeatSide): number { return side === 'left' ? -LANE : LANE; }
function opposite(side: SeatSide): SeatSide { return side === 'left' ? 'right' : 'left'; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function clampInt(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.floor(value))); }
function wrapAngle(value: number): number {
  let angle = value % (Math.PI * 2);
  if (angle > Math.PI) angle -= Math.PI * 2;
  else if (angle <= -Math.PI) angle += Math.PI * 2;
  return angle;
}
