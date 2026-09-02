/**
 * race.ts — race state: countdown, laps, checkpoints, splits,
 * places, challenge qualification, and wrong-way detection.
 *
 * Checkpoint gates live at course.ts's CHECKPOINT_US (shared const, so the
 * anti-cheat and the split events line up with the physical buoys).
 *
 * Anti-cheat model: per racer we track an unwrapped continuous u.
 *   - A checkpoint only counts on a RISING EDGE of continuous u through the
 *     gate's absolute u, IN ORDER, and only while the boat is within
 *     GATE_CREDIT_DIST of the spline (i.e. actually at the gate).
 *   - A lap only counts when every gate was passed this window.
 *   - A per-frame |du| above JUMP_U means a course cut / teleport: tracking
 *     resyncs to the physical position and every gate inside the jumped span
 *     is consumed WITHOUT credit — so the current lap can never complete.
 *   - progress = legitLaps * length + current-window segment: a voided lap
 *     never banks race distance, so cutting is never profitable.
 */
import * as THREE from 'three';
import type {
  ChallengeResult,
  RaceView,
  RacerState,
  IBoat,
  ICourse,
  RacePhase,
  CourseSample,
  RaceBattleEvent,
  RaceBattleOpponent,
  FlightFailureSnapshot,
  ChallengeTier,
  RacerDefinition,
  CourseRouteId,
  CourseWarning,
} from '../contracts';
import { CHECKPOINT_US, SURFACE_ROUTE_FAIL_DISTANCE_M } from './course';
import { RACER_DEFS } from './racers';

export interface RaceEvents {
  countdownTick(n: number): void; // 3,2,1
  go(resuming: boolean): void;
  lapDone(r: RacerState): void;
  checkpoint(r: RacerState, splitDelta: number): void; // split vs leader, seconds
  finish(r: RacerState): void;
  courseWarning(r: RacerState, warning: CourseWarning): void;
  battle(event: RaceBattleEvent): void;
  /** A dual run can retire one human without ending the shared race. */
  eliminated?(r: RacerState, failure: FlightFailureSnapshot): void;
}

export const COUNTDOWN_S = 4.2;
export const TICK_S = 1.4;
/** Per-frame |du| above this = cut/teleport. */
const JUMP_U = 0.02;
/** Must be this close to the spline (m) for a gate / the line to count. */
const GATE_CREDIT_DIST = 15;
const WRONG_WAY_SPEED = 3; // m/s
const WRONG_WAY_HEADING_DOT = -0.3;
const WRONG_WAY_HOLD = 0.7; // s sustained before the flag sets
/** Surface warnings begin here; abandoning the circuit beyond the hard edge ends the run. */
const OFF_COURSE_WARN_M = 24;
const OFF_COURSE_FAIL_HOLD_S = 15;
/** Fixed-step surface motion above this is an explicit staging cut, not a route-projection jump. */
const SURFACE_CONTINUITY_MAX_STEP_M = 4;
/** Arc-search slack for lateral motion and table interpolation around a physical step. */
const SURFACE_PROJECTION_SLACK_M = 2;
/** A wrong-way banner is corrective; ignoring it for this long is terminal. */
const WRONG_WAY_FAIL_HOLD_S = 15;
const BATTLE_ARM_M = 0.75;
const BATTLE_CROSS_M = 0.25;
const BATTLE_MIN_REL_SPEED = 0.5;
const BATTLE_COOLDOWN_S = 0.45;
const OVERTAKE_COMBO_S = 2.5;

const _sample: CourseSample = {
  u: 0,
  distance: 0,
  point: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  routeId: 'surface',
};
const _globalSurfaceCandidate: CourseSample = {
  u: 0,
  distance: 0,
  point: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  routeId: 'surface',
};
const _velocity = new THREE.Vector2();

export class Race implements RaceView {
  readonly racers: RacerState[] = [];
  readonly totalLaps = null;
  phase: RacePhase = 'ready';
  countdownValue = 3;
  raceTime = 0; // seconds since GO
  challengeResult: ChallengeResult | null = null;
  challengeTier: ChallengeTier = 'unqualified';
  qualificationTime: number | null = null;
  finalStationArmed = false;
  finaleCompleted = false;

  private readonly course: ICourse;
  private readonly boats: IBoat[];
  private readonly events: RaceEvents;
  private definitions: readonly RacerDefinition[];
  /** Player ownership is a race concern, independent from the six-racer grid. */
  private playerIds: number[] = [0];
  private primaryPlayerId = 0;

  private cdTimer = COUNTDOWN_S;
  private tickS = TICK_S;
  private pendingTick = 0;

  // per-racer tracking, indexed by boat.id
  private inited: boolean[] = [];
  private prevU: number[] = [];
  private prevRoute: CourseRouteId[] = [];
  private contU: number[] = []; // unwrapped continuous u
  private prevContU: number[] = [];
  private nextCp: number[] = []; // next unconsumed checkpoint index this lap window
  private passedCp: number[] = []; // checkpoints actually CREDITED this window
  private lapWindow: number[] = []; // integral lap window (times the line was crossed)
  private legitLaps: number[] = []; // laps that passed the checkpoint sanity
  private lapStart: number[] = [];
  private wrongT: number[] = [];
  private offCourseT: number[] = [];
  private cpLeaderTimes = new Map<number, number>(); // earliest crossing time per (window, gate)
  private order: RacerState[] = []; // preallocated place-sort scratch
  private battleRelation: number[] = [];
  private battlePrevDiff: number[] = [];
  private battleCooldown: number[] = [];
  private resynced: boolean[] = [];
  private previousWorld: THREE.Vector3[] = [];
  private finalContender: boolean[] = [];
  private battleDisplayPlace = RACER_DEFS[0].startPlace;
  private overtakeStreak = 0;
  private lastOvertakeAt = -Infinity;
  private totalOvertakes = 0;

  constructor(course: ICourse, boats: IBoat[], events: RaceEvents, definitions: readonly RacerDefinition[] = RACER_DEFS) {
    this.course = course;
    this.boats = boats;
    this.events = events;
    this.definitions = definitions;
    for (const boat of boats) {
      const def = this.definitions[boat.id];
      this.racers[boat.id] = {
        id: boat.id,
        name: def?.name ?? `P${boat.id + 1}`,
        isPlayer: def?.isPlayer ?? boat === boats[0],
        color: def?.color ?? 0xffffff,
        lap: 1,
        progress: 0,
        place: def?.startPlace ?? boat.id + 1,
        lastLapTime: -1,
        bestLapTime: -1,
        splitDelta: 0,
        finished: false,
        eliminated: false,
        finishTime: -1,
        courseWarning: 'none',
      };
    }
    this.reset();
  }

  /** Current primary human racer; dual play promotes the surviving seat. */
  player(): RacerState {
    return this.racers[this.primaryPlayerId] ?? this.racers[this.boats[0].id];
  }

  players(): readonly RacerState[] {
    return this.playerIds.map((id) => this.racers[id]).filter(Boolean);
  }

  setPlayerIds(ids: readonly number[]): void {
    if (this.phase !== 'ready') return;
    const unique = [...new Set(ids)].filter((id) => id >= 0 && id < this.boats.length);
    this.playerIds = unique.length > 0 ? unique : [0];
    this.primaryPlayerId = this.playerIds[0];
    for (const racer of this.racers) racer.isPlayer = this.playerIds.includes(racer.id);
  }

  /** Make a surviving human the presentation owner for guidance and Final. */
  promotePlayer(id: number): boolean {
    if (!this.playerIds.includes(id)) return false;
    const racer = this.racers[id];
    if (!racer || racer.eliminated) return false;
    this.primaryPlayerId = id;
    return true;
  }

  /** Mark one human seat out without ending the shared race. */
  eliminatePlayer(id: number, failure: FlightFailureSnapshot): boolean {
    if (this.phase !== 'racing' || !this.playerIds.includes(id)) return false;
    const racer = this.racers[id];
    if (!racer || racer.eliminated) return false;
    racer.eliminated = true;
    racer.finished = false;
    racer.finishTime = -1;
    racer.courseWarning = 'none';
    if (this.primaryPlayerId === id) {
      const next = this.playerIds.find((playerId) => !this.racers[playerId].eliminated);
      if (next !== undefined) {
        this.primaryPlayerId = next;
      }
    }
    const alive = this.playerIds.some((playerId) => !this.racers[playerId].eliminated);
    // Make the result wall reflect the retirement on the same fixed step; the
    // next normal update still performs its regular stable sort.
    this.sortPlaces();
    this.events.eliminated?.(racer, failure);
    // Final Station normally retires route-failure defeat, but a dual run
    // with no surviving human still needs a terminal result instead of
    // waiting forever for a portal crossing.
    if (!alive) this.defeatFlight(failure, true);
    return true;
  }

  /** Read-only continuity evidence for deterministic harness contracts. */
  debugProjection(id: number): Record<string, number | string | boolean> {
    return {
      ready: this.inited[id] ?? false,
      u: this.prevU[id] ?? 0,
      continuousU: this.contU[id] ?? 0,
      route: this.prevRoute[id] ?? 'surface',
      resynced: this.resynced[id] ?? false,
    };
  }

  /** Seconds remaining before a wrong-way failure triggers for racer id. */
  getWrongWayRemaining(id: number): number {
    return Math.max(0, WRONG_WAY_FAIL_HOLD_S - (this.wrongT[id] ?? 0));
  }

  /** Seconds remaining before an off-course failure triggers for racer id. */
  getOffCourseRemaining(id: number): number {
    return Math.max(0, OFF_COURSE_FAIL_HOLD_S - (this.offCourseT[id] ?? 0));
  }

  /** Seconds remaining for current course warning (0 if none). */
  getCourseWarningRemaining(id: number): number {
    const r = this.racers.find((item) => item.id === id);
    if (!r || r.courseWarning === 'none') return 0;
    if (r.courseWarning === 'wrong_way') return this.getWrongWayRemaining(id);
    if (r.courseWarning === 'off_course') return this.getOffCourseRemaining(id);
    return 0;
  }

  getWrongWayHoldTime(id: number): number {
    return this.wrongT[id] ?? 0;
  }

  setDefinitions(definitions: readonly RacerDefinition[]): void {
    if (definitions.length !== this.boats.length || this.phase !== 'ready') return;
    this.definitions = definitions;
    for (const racer of this.racers) {
      const def = definitions[racer.id];
      racer.name = def.name;
      racer.color = def.color;
      racer.isPlayer = def.isPlayer;
    }
    this.reset();
  }

  /** Reset the grid and wait for an explicit player confirmation. */
  reset(): void {
    this.phase = 'ready';
    this.cdTimer = COUNTDOWN_S;
    this.tickS = TICK_S;
    this.countdownValue = 3;
    this.pendingTick = 0;
    this.raceTime = 0;
    this.challengeResult = null;
    this.challengeTier = 'unqualified';
    this.qualificationTime = null;
    this.finalStationArmed = false;
    this.finaleCompleted = false;
    this.finalContender = new Array(this.boats.length).fill(false);
    for (const r of this.racers) {
      r.lap = 1;
      r.progress = 0;
      r.place = this.definitions[r.id]?.startPlace ?? r.id + 1;
      r.lastLapTime = -1;
      r.bestLapTime = -1;
      r.splitDelta = 0;
      r.finished = false;
      r.eliminated = false;
      r.finishTime = -1;
      r.courseWarning = 'none';
    }
    const n = this.boats.length;
    this.inited = new Array(n).fill(false);
    this.prevU = new Array(n).fill(0);
    this.prevRoute = new Array(n).fill('surface');
    this.contU = new Array(n).fill(0);
    this.prevContU = new Array(n).fill(0);
    this.nextCp = new Array(n).fill(0);
    this.passedCp = new Array(n).fill(0);
    this.lapWindow = new Array(n).fill(0);
    this.legitLaps = new Array(n).fill(0);
    this.lapStart = new Array(n).fill(0);
    this.wrongT = new Array(n).fill(0);
    this.offCourseT = new Array(n).fill(0);
    this.cpLeaderTimes.clear();
    this.order = this.racers.slice();
    this.battleRelation = new Array(n).fill(0);
    this.battlePrevDiff = new Array(n).fill(0);
    this.battleCooldown = new Array(n).fill(0);
    this.resynced = new Array(n).fill(false);
    this.previousWorld = this.boats.map((boat) => boat.state.position.clone());
    this.battleDisplayPlace = this.definitions[0].startPlace;
    this.overtakeStreak = 0;
    this.lastOvertakeAt = -Infinity;
    this.totalOvertakes = 0;
    this.primaryPlayerId = this.playerIds.find((id) => !this.racers[id]?.eliminated) ?? this.playerIds[0] ?? 0;
  }

  /** Begin a fresh run. Returns false when the phase cannot accept GO. */
  startCountdown(): boolean {
    if (this.phase !== 'ready') return false;
    this.armCountdown('countdown');
    return true;
  }

  /** Freeze a qualified run while its medal ceremony is on screen. */
  beginMedalCeremony(): boolean {
    if (this.phase !== 'racing') return false;
    this.phase = 'medal';
    this.countdownValue = 3;
    this.pendingTick = 0;
    return true;
  }

  /** Resume the same run through a full 3/2/1 countdown. */
  startResumeCountdown(): boolean {
    if (this.phase !== 'medal') return false;
    this.armCountdown('resume-countdown');
    return true;
  }

  /** Arm the authored finish after a complete seven-flight set. */
  armFinale(): boolean {
    if (this.phase !== 'racing' || this.finalStationArmed) return false;
    // In dual play either seat may reach the seventh route first. Promote that
    // seat so the shared Final portal follows the actual surviving contender.
    let candidate: RacerState | null = null;
    for (const id of this.playerIds) {
      const racer = this.racers[id];
      if (!racer || racer.finished || racer.eliminated || !this.hasFinalQualification(id)) continue;
      if (!candidate || racer.progress > candidate.progress) candidate = racer;
    }
    if (!candidate) return false;
    this.primaryPlayerId = candidate.id;
    const primary = candidate;
    this.finalStationArmed = true;
    const player = primary;
    this.wrongT[player.id] = 0;
    this.offCourseT[player.id] = 0;
    this.setCourseWarning(player, 'none');
    return true;
  }

  /** Continue the same run after the finale presentation. */
  startFinalContinueCountdown(): boolean {
    if (this.phase !== 'finished' || !this.finaleCompleted) return false;
    this.finalStationArmed = false;
    this.finaleCompleted = false;
    this.challengeResult = null;
    for (const racer of this.racers) {
      racer.finished = false;
      racer.finishTime = -1;
      if (this.finalContender[racer.id] || this.hasFinalQualification(racer.id)) {
        this.finalContender[racer.id] = true;
        this.legitLaps[racer.id] = Math.max(this.legitLaps[racer.id], this.lapWindow[racer.id]);
        racer.progress = this.windowedProgress(racer.id);
      }
    }
    this.armCountdown('resume-countdown');
    return true;
  }

  /** Restart safely after the page returns from the background. */
  restartAfterInterruption(): boolean {
    if (this.phase === 'racing') {
      this.armCountdown('resume-countdown');
      return true;
    }
    if (this.phase === 'countdown' || this.phase === 'resume-countdown') {
      this.armCountdown(this.phase);
      return true;
    }
    return false;
  }

  /** End the player's run immediately. Idempotent so swept checks cannot double-fire. */
  defeatFlight(failure: FlightFailureSnapshot, force = false): void {
    if (this.phase !== 'racing') return;
    this.finalStationArmed = false;
    this.phase = 'defeated';
    // A flight or surface failure can be raised from inside `track()` before
    // the normal end-of-step sort. Build the result and honor wall from the
    // same-frame order instead of exposing the previous frame's place values.
    this.sortPlaces();
    const player = this.player();
    const leader = this.order[0] ?? player;
    const gapM = Math.max(0, leader.progress - player.progress);
    const leaderSpeed = Math.max(1, Math.abs(this.boats[leader.id]?.state.speed ?? 0));
    this.challengeResult = {
      outcome: this.challengeTier === 'unqualified' ? 'defeated' : this.challengeTier,
      reason: failure.reason,
      gate: failure.targetGate ?? 0,
      place: player.place,
      totalRacers: this.racers.length,
      raceTime: this.raceTime,
      flightsCleared: failure.flightsCleared,
      leaderGapSeconds: player.place === 1 ? 0 : gapM / leaderSpeed,
      leaderGapMeters: player.place === 1 ? 0 : gapM,
      overtakes: this.totalOvertakes,
      excellentTotal: 0,
      ordinaryNew: false,
      manMedalEarned: true,
      manMedalsTotal: 0,
      bestFlights: 0,
      newBest: false,
      failure,
    };
  }

  /** End a surface-course abandonment through the same result/records pipeline as a flight miss. */
  defeatSurface(reason: 'off_course' | 'wrong_way', distanceM: number): void {
    const playerId = this.player().id;
    const failure = this.surfaceFailure(playerId, reason, distanceM);
    if (this.playerIds.length > 1) {
      this.eliminatePlayer(playerId, failure);
      return;
    }
    this.defeatFlight(failure);
  }

  private surfaceFailure(id: number, reason: 'off_course' | 'wrong_way', distanceM: number): FlightFailureSnapshot {
    const boat = this.boats[id];
    const routeSlot = Math.max(0, boat.state.flightRouteCursor % Math.max(1, this.course.flightRoutes.length));
    return {
      reason,
      flightNumber: boat.state.flightsCleared + 1,
      routeSlot,
      flightsCleared: boat.state.flightsCleared,
      gatesPassed: 0,
      gateCount: this.course.flightRoutes[routeSlot]?.gateUs.length ?? 1,
      targetGate: null,
      routeU: _sample.u,
      lateralOffsetM: null,
      // Surface warnings use corridorDistanceM; lateralLimitM is reserved for
      // portal centreline evidence and must not masquerade as a gate limit.
      lateralLimitM: null,
      corridorDistanceM: reason === 'off_course' ? distanceM : null,
      clearanceM: boat.state.flightClearance,
    };
  }

  /** The third flight grants the medal but deliberately leaves the run active. */
  qualifyChallenge(): ChallengeTier {
    if (this.phase !== 'racing' || this.challengeTier !== 'unqualified') return this.challengeTier;
    this.qualificationTime = this.raceTime;
    this.challengeTier = this.player().place === 1 ? 'excellent' : 'ordinary';
    return this.challengeTier;
  }

  update(dt: number): void {
    if (this.phase === 'countdown' || this.phase === 'resume-countdown') {
      const resuming = this.phase === 'resume-countdown';
      if (this.pendingTick > 0) {
        this.events.countdownTick(this.pendingTick);
        this.pendingTick = 0;
      }
      this.cdTimer -= dt;
      const v = Math.ceil(this.cdTimer / this.tickS);
      if (v >= 1 && v < this.countdownValue) {
        this.countdownValue = v;
        this.events.countdownTick(v);
      }
      if (this.cdTimer <= 0) {
        this.phase = 'racing';
        this.countdownValue = 0;
        if (!resuming) {
          this.raceTime = 0;
          for (let i = 0; i < this.boats.length; i++) this.lapStart[i] = 0;
        }
        this.events.go(resuming);
      }
      this.track(dt, true); // keep position tracking warm; no gate/lap processing
      this.sortPlaces();
      this.syncBattleRelations();
      return;
    }
    if (this.phase !== 'racing') return;
    this.raceTime += dt;
    this.track(dt, false);
    if (this.phase !== 'racing') return;
    this.sortPlaces();
    if (this.finalStationArmed && this.player().finished) {
      this.completePlayerFinale(this.player());
      return;
    }
    if (this.challengeTier === 'ordinary' && this.player().place === 1) this.challengeTier = 'excellent';
    this.trackBattles(dt);
  }

  private armCountdown(phase: 'countdown' | 'resume-countdown'): void {
    this.phase = phase;
    this.cdTimer = COUNTDOWN_S;
    this.tickS = TICK_S;
    this.countdownValue = 3;
    this.pendingTick = 3;
  }

  /** Absorb contact-only position correction without awarding progress or a pass. */
  syncCollisionCorrections(): void {
    for (const boat of this.boats) {
      const id = boat.id;
      if (!this.inited[id]) continue;
      const route = this.course.routeForBoat(id);
      const worldStep = this.previousWorld[id].distanceTo(boat.state.position);
      if (route === 'surface' && this.prevRoute[id] === 'surface' && worldStep <= SURFACE_CONTINUITY_MAX_STEP_M) {
        const maxDeltaU = Math.min(JUMP_U, (worldStep + SURFACE_PROJECTION_SLACK_M) / this.course.length);
        this.course.sampleSurfaceNear(boat.state.position, this.prevU[id], maxDeltaU, _sample);
      } else {
        this.course.sample(boat.state.position, _sample, route);
      }
      this.prevU[id] = _sample.u;
      this.previousWorld[id].copy(boat.state.position);
    }
  }

  private track(dt: number, resyncOnly: boolean): void {
    const nCp = CHECKPOINT_US.length;
    for (let i = 0; i < this.resynced.length; i++) this.resynced[i] = false;
    for (const boat of this.boats) {
      const id = boat.id;
      const r = this.racers[id];
      const route = this.course.routeForBoat(id);
      const previousPosition = this.previousWorld[id];
      const worldStep = previousPosition.distanceTo(boat.state.position);
      const continuousSurfaceStep = this.inited[id] && route === 'surface' &&
        this.prevRoute[id] === 'surface' && worldStep <= SURFACE_CONTINUITY_MAX_STEP_M;
      if (continuousSurfaceStep) {
        const maxDeltaU = Math.min(JUMP_U, (worldStep + SURFACE_PROJECTION_SLACK_M) / this.course.length);
        this.course.sampleSurfaceNear(boat.state.position, this.prevU[id], maxDeltaU, _sample);
      } else {
        this.course.sample(boat.state.position, _sample, route);
      }
      const u = _sample.u;
      let continuousSurfaceFoldConflict = false;
      if (!resyncOnly && continuousSurfaceStep && id === this.primaryPlayerId &&
          _sample.distance >= OFF_COURSE_WARN_M) {
        this.course.sample(boat.state.position, _globalSurfaceCandidate, 'surface');
        let candidateDelta = _globalSurfaceCandidate.u - u;
        if (candidateDelta < -0.5) candidateDelta += 1;
        else if (candidateDelta > 0.5) candidateDelta -= 1;
        continuousSurfaceFoldConflict = Math.abs(candidateDelta) > JUMP_U &&
          _globalSurfaceCandidate.distance + SURFACE_PROJECTION_SLACK_M < _sample.distance;
      }
      // The visible portal is a physical crossing test, but it is not itself
      // the qualification contract. A boat can lap the pack and pass the same
      // world-space line before it has cleared the authored flight set. Such a
      // crossing must stay a normal race movement; otherwise an unfinished
      // rival is promoted ahead of a player who is correctly approaching Final.
      const finalCrossing = !resyncOnly && this.finalStationArmed && this.hasFinalQualification(id) &&
        !r.finished && !r.eliminated
        ? this.course.crossFinalStation(previousPosition, boat.state.position)
        : -1;
      previousPosition.copy(boat.state.position);
      // Completing a whole authored set is an earned standing, not a momentary
      // arithmetic state. Latch it: the portal test below is only true at a set
      // boundary, so without this the leader's rank collapsed the moment it
      // started the next set's first route.
      if (!resyncOnly && this.hasFinalQualification(id)) this.finalContender[id] = true;
      if (!this.inited[id]) {
        // grid sits just behind the line (u ~ 0.996): unwrap to slightly negative
        this.contU[id] = u > 0.5 ? u - 1 : u;
        this.prevU[id] = u;
        this.prevRoute[id] = _sample.routeId;
        this.prevContU[id] = this.contU[id];
        this.inited[id] = true;
        r.progress = this.windowedProgress(id);
        continue;
      }
      if (this.finalStationArmed && finalCrossing >= 0 && boat.state.flightPhase === 'surface' &&
          boat.state.flightRouteState === 'idle') {
        this.finishAtFinal(r, finalCrossing, dt);
      }
      if (this.prevRoute[id] !== _sample.routeId) {
        // Flight and surface share canonical u, but their nearest projections
        // are not identical at the merge. Rebase one frame without changing
        // banked progress; the next physical frame resumes continuous motion.
        this.prevRoute[id] = _sample.routeId;
        this.prevU[id] = u;
        this.prevContU[id] = this.contU[id];
        this.wrongT[id] = 0;
        this.offCourseT[id] = 0;
        this.setCourseWarning(r, 'none');
        r.progress = this.windowedProgress(id);
        continue;
      }
      let du = u - this.prevU[id];
      if (du < -0.5) du += 1;
      else if (du > 0.5) du -= 1;

      const validatesSurface = boat.state.flightPhase === 'surface' && _sample.routeId === 'surface';
      this.prevU[id] = u;

      if (Math.abs(du) > JUMP_U) {
        this.resynced[id] = true;
        // cut / teleport: resync tracking to the physical position and deny
        // every gate inside the jumped span (consumed without credit).
        let newCu = this.lapWindow[id] + u;
        const cu = this.contU[id];
        if (newCu < cu - 0.5) newCu += 1; // forward across the line
        else if (newCu > cu + 0.5) newCu -= 1; // backward across the line
        const hi = Math.max(cu, newCu);
        while (this.nextCp[id] < nCp && this.lapWindow[id] + CHECKPOINT_US[this.nextCp[id]] <= hi) {
          this.nextCp[id]++;
        }
        this.contU[id] = newCu;
        this.prevContU[id] = newCu;
        if (!resyncOnly && !r.finished) {
          if (newCu >= this.lapWindow[id] + 1) this.completeWindow(r, id);
          r.progress = this.windowedProgress(id);
        }
        continue;
      }

      this.contU[id] += du;
      const cu = this.contU[id];
      if (resyncOnly) {
        this.wrongT[id] = 0;
        this.offCourseT[id] = 0;
        this.setCourseWarning(r, 'none');
        this.prevContU[id] = cu;
        continue;
      }
      if (!r.finished && !r.eliminated) {
        r.progress = this.windowedProgress(id);

        const isLegitFlight = boat.state.flightRouteState === 'active' && du >= 0;

        if (isLegitFlight) {
          // Legit flight along active authored route: clear warning clocks.
          this.wrongT[id] = 0;
          this.offCourseT[id] = 0;
          this.setCourseWarning(r, 'none');
        } else {
          const offCourse = _sample.distance >= OFF_COURSE_WARN_M;
          const outside = _sample.distance >= SURFACE_ROUTE_FAIL_DISTANCE_M;
          // Keep local u ownership, but start the normal correction clock when
          // a sustained cross-water cut has entered a clearly closer fold. The
          // global candidate is validation evidence only and never grants rank.
          this.offCourseT[id] = outside || continuousSurfaceFoldConflict
            ? this.offCourseT[id] + dt
            : Math.max(0, this.offCourseT[id] - dt * 2.5);
          if (id === this.primaryPlayerId && offCourse) this.setCourseWarning(r, 'off_course');
          else if (r.courseWarning === 'off_course') this.setCourseWarning(r, 'none');

          boat.collisionVelocity(_velocity);
          const along = _velocity.x * _sample.tangent.x + _velocity.y * _sample.tangent.z;
          const headingDot = Math.sin(boat.state.heading) * _sample.tangent.x +
            Math.cos(boat.state.heading) * _sample.tangent.z;
          const facingWrongWay = _velocity.length() > WRONG_WAY_SPEED &&
            headingDot < WRONG_WAY_HEADING_DOT;
          const movingWrongWay = along < -WRONG_WAY_SPEED && du < 0;
          const reversing = !offCourse && (facingWrongWay || movingWrongWay);
          if (reversing) {
            this.wrongT[id] += dt;
            if (this.wrongT[id] >= WRONG_WAY_HOLD) this.setCourseWarning(r, 'wrong_way');
          } else {
            this.wrongT[id] = Math.max(0, this.wrongT[id] - dt * 2.5);
            if (this.wrongT[id] < WRONG_WAY_HOLD && r.courseWarning === 'wrong_way') {
              this.setCourseWarning(r, offCourse && id === this.primaryPlayerId ? 'off_course' : 'none');
            }
          }
          if (this.playerIds.includes(id) && this.offCourseT[id] >= OFF_COURSE_FAIL_HOLD_S) {
            const failure = this.surfaceFailure(id, 'off_course', _sample.distance);
            if (this.playerIds.length > 1) {
              this.eliminatePlayer(id, failure);
              if (this.phase !== 'racing') return;
              continue;
            }
            this.defeatFlight(failure);
            return;
          }
          if (this.playerIds.includes(id) && this.wrongT[id] >= WRONG_WAY_FAIL_HOLD_S) {
            const failure = this.surfaceFailure(id, 'wrong_way', _sample.distance);
            if (this.playerIds.length > 1) {
              this.eliminatePlayer(id, failure);
              if (this.phase !== 'racing') return;
              continue;
            }
            this.defeatFlight(failure);
            return;
          }
        }

        // checkpoint gates: rising edge, in order, near the spline
        let guard = 0;
        while (this.nextCp[id] < nCp && guard++ < nCp + 1) {
          const target = this.lapWindow[id] + CHECKPOINT_US[this.nextCp[id]];
          if (!(this.prevContU[id] < target && cu >= target)) break;
          this.nextCp[id]++;
          const airborneOrRecovery = !validatesSurface || boat.state.flightPhase !== 'surface' ||
            boat.state.flightRouteState !== 'idle';
          if (_sample.distance > GATE_CREDIT_DIST && !airborneOrRecovery) continue; // missed the gate: no credit
          this.passedCp[id]++;
          const key = this.lapWindow[id] * nCp + (this.nextCp[id] - 1);
          const best = this.cpLeaderTimes.get(key) ?? Infinity;
          r.splitDelta = this.raceTime <= best ? 0 : this.raceTime - best;
          if (this.raceTime < best) this.cpLeaderTimes.set(key, this.raceTime);
          this.events.checkpoint(r, r.splitDelta);
        }

        // start/finish line, with checkpoint sanity
        if (cu >= this.lapWindow[id] + 1 && _sample.distance <= GATE_CREDIT_DIST) {
          this.completeWindow(r, id);
        }
        r.lap = this.legitLaps[id] + 1;

      }
      this.prevContU[id] = cu;
    }
  }

  private setCourseWarning(racer: RacerState, warning: CourseWarning): void {
    if (racer.courseWarning === warning) return;
    racer.courseWarning = warning;
    this.events.courseWarning(racer, warning);
  }

  /** Race distance: banked legit laps + current-window segment. Void laps bank nothing. */
  private windowedProgress(id: number): number {
    const raw = this.contU[id] - this.lapWindow[id];
    const lo = this.legitLaps[id] === 0 && this.lapWindow[id] === 0 ? -0.1 : 0;
    const seg = Math.min(Math.max(raw, lo), 1);
    return (this.legitLaps[id] + seg) * this.course.length;
  }

  /**
   * The boat crossed the start/finish line. The lap counts only if every
   * checkpoint was CREDITED this window; either way the window moves on.
   */
  private completeWindow(r: RacerState, id: number): void {
    if (this.passedCp[id] >= CHECKPOINT_US.length || this.finalContender[id] || this.hasFinalQualification(id)) {
      this.legitLaps[id]++;
      r.lastLapTime = this.raceTime - this.lapStart[id];
      if (r.bestLapTime < 0 || r.lastLapTime < r.bestLapTime) r.bestLapTime = r.lastLapTime;
      this.lapStart[id] = this.raceTime;
      this.events.lapDone(r);
    }
    // missed gates: the lap simply does not count
    this.lapWindow[id]++;
    this.nextCp[id] = 0;
    this.passedCp[id] = 0;
    const oldestWindow = Math.max(0, Math.min(...this.lapWindow) - 1);
    const minKey = oldestWindow * CHECKPOINT_US.length;
    for (const key of this.cpLeaderTimes.keys()) if (key < minKey) this.cpLeaderTimes.delete(key);
  }

  /**
   * Has this racer earned the right to take the Final portal? Clearing every
   * authored route once is an achievement that stays earned: a qualified racer
   * may keep flying and still cross the portal on a later lap. Requiring an
   * exact set boundary instead locked the portal shut again the moment the
   * racer cleared one more route. Place sorting uses the latched
   * `finalContender` flag so a momentary set state never demotes a contender.
   */
  private hasFinalQualification(id: number): boolean {
    const routeCount = Math.max(1, this.course.flightRoutes.length);
    const cleared = this.boats[id].state.flightsCleared;
    return Number.isInteger(cleared) && cleared >= routeCount;
  }

  private finishAtFinal(racer: RacerState, crossingFraction: number, dt: number): void {
    if (racer.finished) return;
    racer.finished = true;
    racer.finishTime = this.raceTime - dt + Math.min(1, Math.max(0, crossingFraction)) * dt;
    racer.courseWarning = 'none';
    this.events.finish(racer);
  }

  /** Build the player's result only after every crossing in this fixed step has been sorted. */
  private completePlayerFinale(r: RacerState): void {
    const boat = this.boats[r.id];
    if (!this.finalStationArmed || this.finaleCompleted || !r.finished) return;
    const leader = this.order[0] ?? r;
    const leaderSpeed = Math.max(1, Math.abs(this.boats[leader.id]?.state.speed ?? 0));
    const gapSeconds = leader.finished
      ? Math.max(0, r.finishTime - leader.finishTime)
      : Math.max(0, leader.progress - r.progress) / leaderSpeed;
    const gapM = gapSeconds * leaderSpeed;
    const outcome: ChallengeResult['outcome'] = this.challengeTier === 'excellent' || r.place === 1
      ? 'excellent' : 'ordinary';
    this.finaleCompleted = true;
    this.finalStationArmed = false;
    this.challengeTier = outcome;
    this.challengeResult = {
      outcome,
      reason: 'none',
      gate: 0,
      place: r.place,
      totalRacers: this.racers.length,
      raceTime: r.finishTime,
      flightsCleared: boat.state.flightsCleared,
      leaderGapSeconds: r.place === 1 ? 0 : gapSeconds,
      leaderGapMeters: r.place === 1 ? 0 : gapM,
      overtakes: this.totalOvertakes,
      excellentTotal: 0,
      ordinaryNew: false,
      manMedalEarned: true,
      manMedalsTotal: 0,
      bestFlights: boat.state.flightsCleared,
      newBest: false,
      failure: null,
    };
    this.phase = 'finished';
  }

  private sortPlaces(): void {
    const ord = this.order;
    for (let i = 1; i < ord.length; i++) {
      const r = ord[i];
      let j = i - 1;
      while (j >= 0 && this.better(r, ord[j])) {
        ord[j + 1] = ord[j];
        j--;
      }
      ord[j + 1] = r;
    }
    for (let i = 0; i < ord.length; i++) ord[i].place = i + 1;
  }

  private syncBattleRelations(): void {
    const player = this.player();
    for (const opponent of this.racers) {
      if (opponent.isPlayer) continue;
      const diff = player.progress - opponent.progress;
      this.battleRelation[opponent.id] = diff <= -BATTLE_ARM_M ? -1 : diff >= BATTLE_ARM_M ? 1 : 0;
      this.battlePrevDiff[opponent.id] = diff;
      this.battleCooldown[opponent.id] = 0;
    }
    this.battleDisplayPlace = player.place;
  }

  private trackBattles(dt: number): void {
    const player = this.player();
    if (player.finished) return;
    const passed: RaceBattleOpponent[] = [];
    const lost: RaceBattleOpponent[] = [];
    const playerResynced = this.resynced[player.id];
    for (const opponent of this.racers) {
      if (opponent.isPlayer || opponent.finished || opponent.eliminated) continue;
      const id = opponent.id;
      const diff = player.progress - opponent.progress;
      const prevDiff = this.battlePrevDiff[id];
      const relativeSpeed = (diff - prevDiff) / Math.max(dt, 1e-4);
      this.battlePrevDiff[id] = diff;
      this.battleCooldown[id] = Math.max(0, this.battleCooldown[id] - dt);
      if (this.resynced[player.id] || this.resynced[id]) {
        this.battleRelation[id] = diff <= -BATTLE_ARM_M ? -1 : diff >= BATTLE_ARM_M ? 1 : 0;
        continue;
      }
      if (this.battleRelation[id] === 0) {
        if (diff <= -BATTLE_ARM_M) this.battleRelation[id] = -1;
        else if (diff >= BATTLE_ARM_M) this.battleRelation[id] = 1;
      } else if (this.battleCooldown[id] <= 0 && this.battleRelation[id] < 0 &&
          prevDiff < BATTLE_CROSS_M && diff >= BATTLE_CROSS_M && relativeSpeed >= BATTLE_MIN_REL_SPEED) {
        this.battleRelation[id] = 1;
        this.battleCooldown[id] = BATTLE_COOLDOWN_S;
        passed.push({ id, name: opponent.name, color: opponent.color });
      } else if (this.battleCooldown[id] <= 0 && this.battleRelation[id] > 0 &&
          prevDiff > -BATTLE_CROSS_M && diff <= -BATTLE_CROSS_M && relativeSpeed <= -BATTLE_MIN_REL_SPEED) {
        this.battleRelation[id] = -1;
        this.battleCooldown[id] = BATTLE_COOLDOWN_S;
        lost.push({ id, name: opponent.name, color: opponent.color });
      }
    }
    // A teleport/cut is a tracking resync, not an overtake. Keep the displayed
    // place aligned with the new physical order so the next real pass reports
    // an honest from/to pair.
    if (playerResynced) this.battleDisplayPlace = player.place;
    if (passed.length > 0) {
      this.overtakeStreak = this.raceTime - this.lastOvertakeAt <= OVERTAKE_COMBO_S
        ? this.overtakeStreak + passed.length
        : passed.length;
      this.lastOvertakeAt = this.raceTime;
      this.totalOvertakes += passed.length;
      const fromPlace = this.battleDisplayPlace;
      this.battleDisplayPlace = player.place;
      this.events.battle({
        kind: 'overtake',
        opponents: passed,
        fromPlace,
        toPlace: player.place,
        streak: this.overtakeStreak,
        rankChanged: fromPlace !== player.place,
        rankDelta: fromPlace - player.place,
        raceTime: this.raceTime,
      });
    }
    if (lost.length > 0) {
      const fromPlace = this.battleDisplayPlace;
      this.battleDisplayPlace = player.place;
      this.overtakeStreak = 0;
      this.lastOvertakeAt = -Infinity;
      this.events.battle({
        kind: 'lost',
        opponents: lost,
        fromPlace,
        toPlace: player.place,
        streak: 0,
        rankChanged: fromPlace !== player.place,
        rankDelta: fromPlace - player.place,
        raceTime: this.raceTime,
      });
    }
  }

  /** a ranks ahead of b? Finished by time, unfinished by progress, ties to lower id. */
  private better(a: RacerState, b: RacerState): boolean {
    if (a.eliminated !== b.eliminated) return !a.eliminated;
    if (a.finished && b.finished) {
      return a.finishTime !== b.finishTime ? a.finishTime < b.finishTime : a.id < b.id;
    }
    if (a.finished !== b.finished) return a.finished;
    if (a.progress !== b.progress) return a.progress > b.progress;
    return a.id < b.id;
  }

}
