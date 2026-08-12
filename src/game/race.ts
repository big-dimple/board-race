/**
 * race.ts — endless race state: countdown, laps, checkpoints, splits,
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
} from '../contracts';
import { CHECKPOINT_US } from './course';
import { RACER_DEFS } from './racers';

export interface RaceEvents {
  countdownTick(n: number): void; // 3,2,1
  go(resuming: boolean): void;
  lapDone(r: RacerState): void;
  checkpoint(r: RacerState, splitDelta: number): void; // split vs leader, seconds
  finish(r: RacerState): void;
  wrongWay(r: RacerState, on: boolean): void;
  battle(event: RaceBattleEvent): void;
}

const COUNTDOWN_S = 4.2;
const TICK_S = 1.4;
/** Per-frame |du| above this = cut/teleport. */
const JUMP_U = 0.02;
/** Must be this close to the spline (m) for a gate / the line to count. */
const GATE_CREDIT_DIST = 15;
const WRONG_WAY_DOT = -0.3;
const WRONG_WAY_SPEED = 3; // m/s
const WRONG_WAY_HOLD = 0.7; // s sustained before the flag sets
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

export class Race implements RaceView {
  readonly racers: RacerState[] = [];
  readonly totalLaps = null;
  phase: RacePhase = 'ready';
  countdownValue = 3;
  raceTime = 0; // seconds since GO
  challengeResult: ChallengeResult | null = null;
  challengeTier: ChallengeTier = 'unqualified';
  qualificationTime: number | null = null;

  private readonly course: ICourse;
  private readonly boats: IBoat[];
  private readonly events: RaceEvents;

  private cdTimer = COUNTDOWN_S;
  private tickS = TICK_S;
  private pendingTick = 0;

  // per-racer tracking, indexed by boat.id
  private inited: boolean[] = [];
  private prevU: number[] = [];
  private contU: number[] = []; // unwrapped continuous u
  private prevContU: number[] = [];
  private nextCp: number[] = []; // next unconsumed checkpoint index this lap window
  private passedCp: number[] = []; // checkpoints actually CREDITED this window
  private lapWindow: number[] = []; // integral lap window (times the line was crossed)
  private legitLaps: number[] = []; // laps that passed the checkpoint sanity
  private lapStart: number[] = [];
  private wrongT: number[] = [];
  private cpLeaderTimes = new Map<number, number>(); // earliest crossing time per (window, gate)
  private order: RacerState[] = []; // preallocated place-sort scratch
  private battleRelation: number[] = [];
  private battlePrevDiff: number[] = [];
  private battleCooldown: number[] = [];
  private resynced: boolean[] = [];
  private battleDisplayPlace = RACER_DEFS[0].startPlace;
  private overtakeStreak = 0;
  private lastOvertakeAt = -Infinity;
  private totalOvertakes = 0;

  constructor(course: ICourse, boats: IBoat[], events: RaceEvents) {
    this.course = course;
    this.boats = boats;
    this.events = events;
    for (const boat of boats) {
      const def = RACER_DEFS[boat.id];
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
        wrongWay: false,
      };
    }
    this.reset();
  }

  /** boats[0] is always the player. */
  player(): RacerState {
    return this.racers[this.boats[0].id];
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
    for (const r of this.racers) {
      r.lap = 1;
      r.progress = 0;
      r.place = RACER_DEFS[r.id]?.startPlace ?? r.id + 1;
      r.lastLapTime = -1;
      r.bestLapTime = -1;
      r.splitDelta = 0;
      r.finished = false;
      r.eliminated = false;
      r.finishTime = -1;
      r.wrongWay = false;
    }
    const n = this.boats.length;
    this.inited = new Array(n).fill(false);
    this.prevU = new Array(n).fill(0);
    this.contU = new Array(n).fill(0);
    this.prevContU = new Array(n).fill(0);
    this.nextCp = new Array(n).fill(0);
    this.passedCp = new Array(n).fill(0);
    this.lapWindow = new Array(n).fill(0);
    this.legitLaps = new Array(n).fill(0);
    this.lapStart = new Array(n).fill(0);
    this.wrongT = new Array(n).fill(0);
    this.cpLeaderTimes.clear();
    this.order = this.racers.slice();
    this.battleRelation = new Array(n).fill(0);
    this.battlePrevDiff = new Array(n).fill(0);
    this.battleCooldown = new Array(n).fill(0);
    this.resynced = new Array(n).fill(false);
    this.battleDisplayPlace = RACER_DEFS[0].startPlace;
    this.overtakeStreak = 0;
    this.lastOvertakeAt = -Infinity;
    this.totalOvertakes = 0;
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
  defeatFlight(failure: FlightFailureSnapshot): void {
    if (this.phase !== 'racing') return;
    this.phase = 'defeated';
    const player = this.player();
    const leader = this.order[0] ?? player;
    const gapM = Math.max(0, leader.progress - player.progress);
    const leaderSpeed = Math.max(1, Math.abs(this.boats[leader.id]?.state.speed ?? 0));
    this.challengeResult = {
      outcome: this.challengeTier === 'unqualified' ? 'defeated' : this.challengeTier,
      reason: failure.reason,
      gate: failure.targetGate ?? Math.min(3, failure.gatesPassed + 1),
      place: player.place,
      totalRacers: this.racers.length,
      raceTime: this.raceTime,
      flightsCleared: failure.flightsCleared,
      leaderGapSeconds: player.place === 1 ? 0 : gapM / leaderSpeed,
      leaderGapMeters: player.place === 1 ? 0 : gapM,
      overtakes: this.totalOvertakes,
      excellentTotal: 0,
      ordinaryNew: false,
      manMedalEarned: this.challengeTier !== 'unqualified',
      manMedalsTotal: 0,
      bestFlights: 0,
      newBest: false,
      failure,
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
    this.sortPlaces();
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

  private track(dt: number, resyncOnly: boolean): void {
    const nCp = CHECKPOINT_US.length;
    for (let i = 0; i < this.resynced.length; i++) this.resynced[i] = false;
    for (const boat of this.boats) {
      const id = boat.id;
      const r = this.racers[id];
      this.course.sample(boat.state.position, _sample, this.course.routeForBoat(id));
      const u = _sample.u;
      if (!this.inited[id]) {
        // grid sits just behind the line (u ~ 0.996): unwrap to slightly negative
        this.contU[id] = u > 0.5 ? u - 1 : u;
        this.prevU[id] = u;
        this.prevContU[id] = this.contU[id];
        this.inited[id] = true;
        r.progress = this.windowedProgress(id);
        continue;
      }
      let du = u - this.prevU[id];
      if (du < -0.5) du += 1;
      else if (du > 0.5) du -= 1;
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
        this.prevContU[id] = cu;
        continue;
      }
      if (!r.finished && !r.eliminated) {
        r.progress = this.windowedProgress(id);

        // checkpoint gates: rising edge, in order, near the spline
        let guard = 0;
        while (this.nextCp[id] < nCp && guard++ < nCp + 1) {
          const target = this.lapWindow[id] + CHECKPOINT_US[this.nextCp[id]];
          if (!(this.prevContU[id] < target && cu >= target)) break;
          this.nextCp[id]++;
          if (_sample.distance > GATE_CREDIT_DIST) continue; // missed the gate: no credit
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

        // wrong-way: fast and facing against the spline for a sustained spell.
        // boat forward = (sin h, cos h); dot with the spline tangent.
        const h = boat.state.heading;
        const dot = Math.sin(h) * _sample.tangent.x + Math.cos(h) * _sample.tangent.z;
        if (boat.state.speed > WRONG_WAY_SPEED && dot < WRONG_WAY_DOT) {
          this.wrongT[id] += dt;
          if (!r.wrongWay && this.wrongT[id] >= WRONG_WAY_HOLD) {
            r.wrongWay = true;
            this.events.wrongWay(r, true);
          }
        } else {
          this.wrongT[id] = 0;
          if (r.wrongWay) {
            r.wrongWay = false;
            this.events.wrongWay(r, false);
          }
        }
      }
      this.prevContU[id] = cu;
    }
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
    if (this.passedCp[id] >= CHECKPOINT_US.length) {
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
