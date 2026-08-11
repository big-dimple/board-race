/**
 * race.ts — race state machine: countdown, laps, checkpoints, splits,
 * places, wrong-way detection, finish + extrapolation.
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
import type { RaceView, RacerState, IBoat, ICourse, RacePhase, CourseSample } from '../contracts';
import { RACER_COLORS, RACER_NAMES } from '../core/palette';
import { CHECKPOINT_US } from './course';

export interface RaceEvents {
  countdownTick(n: number): void; // 3,2,1
  go(): void;
  lapDone(r: RacerState): void;
  checkpoint(r: RacerState, splitDelta: number): void; // split vs leader, seconds
  finish(r: RacerState): void;
  wrongWay(r: RacerState, on: boolean): void;
}

const COUNTDOWN_S = 3.6;
const TICK_S = 1.2;
/** Per-frame |du| above this = cut/teleport. */
const JUMP_U = 0.02;
/** Must be this close to the spline (m) for a gate / the line to count. */
const GATE_CREDIT_DIST = 15;
const WRONG_WAY_DOT = -0.3;
const WRONG_WAY_SPEED = 3; // m/s
const WRONG_WAY_HOLD = 0.7; // s sustained before the flag sets

const _sample: CourseSample = {
  u: 0,
  distance: 0,
  point: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
};

export class Race implements RaceView {
  readonly racers: RacerState[] = [];
  readonly totalLaps = 3;
  phase: RacePhase = 'countdown';
  countdownValue = 3;
  raceTime = 0; // seconds since GO

  private readonly course: ICourse;
  private readonly boats: IBoat[];
  private readonly events: RaceEvents;

  private cdTimer = COUNTDOWN_S;
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
  private cpLeaderTimes: number[] = []; // earliest crossing time per (window, gate)
  private order: RacerState[] = []; // preallocated place-sort scratch

  constructor(course: ICourse, boats: IBoat[], events: RaceEvents) {
    this.course = course;
    this.boats = boats;
    this.events = events;
    for (const boat of boats) {
      this.racers[boat.id] = {
        id: boat.id,
        name: RACER_NAMES[boat.id] ?? `P${boat.id + 1}`,
        isPlayer: boat === boats[0], // boats[0] is always the player
        color: RACER_COLORS[boat.id] ?? 0xffffff,
        lap: 1,
        progress: 0,
        place: boat.id + 1,
        lastLapTime: -1,
        bestLapTime: -1,
        splitDelta: 0,
        finished: false,
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

  /** Back to countdown, all progress cleared. */
  reset(): void {
    this.phase = 'countdown';
    this.cdTimer = COUNTDOWN_S;
    this.countdownValue = 3;
    this.pendingTick = 3; // fired on the first update, not from reset() itself
    this.raceTime = 0;
    for (const r of this.racers) {
      r.lap = 1;
      r.progress = 0;
      r.place = r.id + 1;
      r.lastLapTime = -1;
      r.bestLapTime = -1;
      r.splitDelta = 0;
      r.finished = false;
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
    this.cpLeaderTimes = new Array(CHECKPOINT_US.length * (this.totalLaps + 1)).fill(Infinity);
    this.order = this.racers.slice();
  }

  update(dt: number): void {
    if (this.phase === 'countdown') {
      if (this.pendingTick > 0) {
        this.events.countdownTick(this.pendingTick);
        this.pendingTick = 0;
      }
      this.cdTimer -= dt;
      const v = Math.ceil(this.cdTimer / TICK_S);
      if (v >= 1 && v < this.countdownValue) {
        this.countdownValue = v;
        this.events.countdownTick(v);
      }
      if (this.cdTimer <= 0) {
        this.phase = 'racing';
        this.countdownValue = 0;
        this.raceTime = 0;
        for (let i = 0; i < this.boats.length; i++) this.lapStart[i] = 0;
        this.events.go();
      }
      this.track(dt, true); // keep position tracking warm; no gate/lap processing
      return;
    }
    this.raceTime += dt;
    this.track(dt, false);
    this.sortPlaces();
  }

  private track(dt: number, resyncOnly: boolean): void {
    const nCp = CHECKPOINT_US.length;
    for (const boat of this.boats) {
      const id = boat.id;
      const r = this.racers[id];
      this.course.sample(boat.state.position, _sample);
      const u = _sample.u;
      if (!this.inited[id]) {
        // grid sits just behind the line (u ~ 0.996): unwrap to slightly negative
        this.contU[id] = u > 0.5 ? u - 1 : u;
        this.prevU[id] = u;
        this.prevContU[id] = this.contU[id];
        this.inited[id] = true;
        continue;
      }
      let du = u - this.prevU[id];
      if (du < -0.5) du += 1;
      else if (du > 0.5) du -= 1;
      this.prevU[id] = u;

      if (Math.abs(du) > JUMP_U) {
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
      if (!r.finished) {
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
          if (key >= this.cpLeaderTimes.length) continue;
          const best = this.cpLeaderTimes[key];
          r.splitDelta = this.raceTime <= best ? 0 : this.raceTime - best;
          if (this.raceTime < best) this.cpLeaderTimes[key] = this.raceTime;
          this.events.checkpoint(r, r.splitDelta);
        }

        // start/finish line, with checkpoint sanity
        if (cu >= this.lapWindow[id] + 1 && _sample.distance <= GATE_CREDIT_DIST) {
          this.completeWindow(r, id);
        }
        r.lap = Math.min(this.legitLaps[id] + 1, this.totalLaps);

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
    const seg = Math.min(Math.max(this.contU[id] - this.lapWindow[id], 0), 1);
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
      if (this.legitLaps[id] >= this.totalLaps) {
        r.finished = true;
        r.finishTime = this.raceTime;
        this.events.finish(r);
        if (r.isPlayer) {
          this.phase = 'finished';
          this.extrapolateFinishes();
        }
      }
    }
    // missed gates: the lap simply does not count
    this.lapWindow[id]++;
    this.nextCp[id] = 0;
    this.passedCp[id] = 0;
  }

  /**
   * Player finished first: keep AI progress/places updating, but give every
   * unfinished racer an estimated finishTime from current pace so the results
   * table can complete. Overwritten by the real time if they actually finish.
   */
  private extrapolateFinishes(): void {
    for (const r of this.racers) {
      if (r.finished) continue;
      const avgSpeed = r.progress / Math.max(this.raceTime, 1);
      const remaining = this.totalLaps * this.course.length - r.progress;
      r.finishTime = avgSpeed > 2 ? this.raceTime + remaining / avgSpeed : this.raceTime + 9999;
    }
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

  /** a ranks ahead of b? Finished by time, unfinished by progress, ties to lower id. */
  private better(a: RacerState, b: RacerState): boolean {
    if (a.finished && b.finished) {
      return a.finishTime !== b.finishTime ? a.finishTime < b.finishTime : a.id < b.id;
    }
    if (a.finished !== b.finished) return a.finished;
    if (a.progress !== b.progress) return a.progress > b.progress;
    return a.id < b.id;
  }
}
