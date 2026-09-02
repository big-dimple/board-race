import type { RacerDefinition, RacerState, RivalPaceDirective } from '../contracts';

const MAX_CHASE = 1.16;
const FORMATION_PACE = 1.06;
const BASE_PACE = 1;
const CHASE_RATE = 0.9;
const RELEASE_RATE = 0.18;
const CLOSING_FILTER_RATE = 7;
const CLOSING_LOOKAHEAD_S = 0.85;
const DEFICIT_BAND_M = 10;
const MAX_TRACKED_GAP_STEP_M = 3;

interface MutableRivalPaceDirective {
  surfaceTargetScale: number;
  flightTargetScale: number;
  formationActive: boolean;
  surfaceThrottleAssist: boolean;
  closingPressure: number;
}

const NEUTRAL_DIRECTIVE: RivalPaceDirective = Object.freeze({
  surfaceTargetScale: 1,
  flightTargetScale: 1,
  formationActive: false,
  surfaceThrottleAssist: false,
  closingPressure: 0,
});

export interface RivalDirectorDebug {
  rivals: readonly number[];
  pace: readonly number[];
  flightPace: readonly number[];
  technique: readonly number[];
  opening: readonly number[];
  openingPressureId: number;
  runSeed: number;
  runTime: number;
  grace: number;
  lock: number;
  formationFlights: number;
  chain: readonly number[];
  closingSpeed: readonly number[];
  closingPressure: readonly number[];
  formationActive: readonly boolean[];
  surfaceThrottleAssist: readonly boolean[];
}

/** Coordinates only the two strongest opponents; all other AI stays on authored pace. */
export class RivalDirector {
  private biases = new Float32Array(0);
  private closingSpeeds = new Float32Array(0);
  private previousGaps = new Float32Array(0);
  private gapSeen = new Uint8Array(0);
  private techniquePressure = new Float32Array(0);
  private openingPressure = new Float32Array(0);
  private directives: MutableRivalPaceDirective[] = [];
  private definitions: readonly RacerDefinition[] = [];
  private rivalIds: number[] = [];
  private openingPressureId = -1;
  private runSeed = 0;
  private runTime = 0;
  private grace = 0;
  private lock = 0;
  private formationFlights = 0;
  private formationReleased = false;

  setRoster(definitions: readonly RacerDefinition[]): void {
    this.definitions = definitions;
    this.biases = new Float32Array(definitions.length);
    this.biases.fill(1);
    this.closingSpeeds = new Float32Array(definitions.length);
    this.previousGaps = new Float32Array(definitions.length);
    this.gapSeen = new Uint8Array(definitions.length);
    this.techniquePressure = new Float32Array(definitions.length);
    this.openingPressure = new Float32Array(definitions.length);
    this.directives = definitions.map(() => ({
      surfaceTargetScale: 1,
      flightTargetScale: 1,
      formationActive: false,
      surfaceThrottleAssist: false,
      closingPressure: 0,
    }));
    this.rivalIds = definitions.filter((definition) => !definition.isPlayer)
      .sort((a, b) => b.pace - a.pace)
      .slice(0, 2)
      .map((definition) => definition.id);
    this.openingPressureId = -1;
    this.runTime = 0;
    this.grace = 0;
    this.lock = 0;
    this.formationFlights = 0;
    this.formationReleased = false;
  }

  beginRun(seed: number): void {
    this.runSeed = Math.max(0, Math.floor(seed));
    this.runTime = 0;
    this.grace = 0;
    this.lock = 0;
    this.formationFlights = 0;
    this.formationReleased = false;
    this.biases.fill(1);
    this.closingSpeeds.fill(0);
    this.previousGaps.fill(0);
    this.gapSeen.fill(0);
    this.techniquePressure.fill(0);
    this.openingPressure.fill(0);
    for (const directive of this.directives) setDirective(directive, 1, 1, false, 0);
    const hash = hashSeed(this.runSeed);
    this.openingPressureId = -1;
    if (hash % 5 >= 2) return;
    const player = this.definitions.find((definition) => definition.isPlayer);
    if (!player) return;
    const candidates = this.definitions
      .filter((definition) => !definition.isPlayer && definition.personality !== 'clean')
      .sort((a, b) => {
        const aGap = Math.abs(a.startDistance - player.startDistance) + Math.abs(a.startLateral - player.startLateral) * 0.2;
        const bGap = Math.abs(b.startDistance - player.startDistance) + Math.abs(b.startLateral - player.startLateral) * 0.2;
        return aGap - bGap || a.id - b.id;
      });
    if (candidates.length > 0) this.openingPressureId = candidates[(hash >>> 8) % Math.min(2, candidates.length)].id;
  }

  update(
    dt: number,
    racers: readonly RacerState[],
    playerFlightsCleared = 0,
    focusPlayerId?: number,
  ): void {
    this.formationFlights = playerFlightsCleared;
    this.runTime += dt;
    this.grace = Math.max(0, this.grace - dt);
    this.lock = Math.max(0, this.lock - dt);
    // Dual play keeps both seats marked as player-owned for battle filtering,
    // but only the surviving seat should drive the authored chase pressure.
    // Fall back to the first live human when a caller has no explicit focus.
    const focused = focusPlayerId === undefined ? undefined : racers[focusPlayerId];
    const player = focused && focused.isPlayer && !focused.eliminated
      ? focused
      : racers.find((racer) => racer.isPlayer && !racer.eliminated);
    if (!player) return;
    for (let id = 0; id < this.biases.length; id++) {
      const racer = racers[id];
      const openingTarget = id === this.openingPressureId && this.grace <= 0
        ? openingEnvelope(this.runTime)
        : 0;
      this.openingPressure[id] = approach(this.openingPressure[id], openingTarget, 2.4 * dt);
      if (!racer || racer.isPlayer || !this.rivalIds.includes(id)) {
        this.biases[id] = approachAsymmetric(this.biases[id], 1, dt);
        this.closingSpeeds[id] = approach(this.closingSpeeds[id], 0, CLOSING_FILTER_RATE * dt);
        this.gapSeen[id] = 0;
        this.techniquePressure[id] = approach(this.techniquePressure[id], 0, 2.5 * dt);
        setDirective(this.directives[id], this.biases[id], 1, false, 0);
        continue;
      }
      const role = this.rivalIds.indexOf(id);
      if (this.formationReleased) {
        this.biases[id] = 1;
        this.closingSpeeds[id] = 0;
        this.gapSeen[id] = 0;
        this.techniquePressure[id] = 0;
        setDirective(this.directives[id], 1, 1, false, 0);
        continue;
      }

      const protectedRoles = 2;
      if (role >= protectedRoles) {
        this.biases[id] = approachAsymmetric(this.biases[id], 1, dt);
        this.closingSpeeds[id] = approach(this.closingSpeeds[id], 0, CLOSING_FILTER_RATE * dt);
        this.gapSeen[id] = 0;
        this.techniquePressure[id] = approach(this.techniquePressure[id], 0, 2.5 * dt);
        setDirective(this.directives[id], this.biases[id], 1, false, 0);
        continue;
      }

      const ahead = racer.progress - player.progress;
      // In late race (flightsCleared >= 3), keep a thrilling dogfight gap (12~24m)
      const isLateRace = playerFlightsCleared >= 3;
      const minAhead = isLateRace ? (role === 0 ? 12 : 8) : (role === 0 ? 18 : 10);
      const maxAhead = isLateRace ? (role === 0 ? 24 : 18) : (role === 0 ? 32 : 24);
      const gapStep = this.previousGaps[id] - ahead;
      // Route-owner rebases, harness staging and resume frames are not physical
      // relative velocity. Reject their discontinuities instead of turning one
      // projection jump into several seconds of artificial chase pressure.
      const closingSampleValid = this.gapSeen[id] && dt > 0 && dt <= 0.25 &&
        Math.abs(gapStep) <= Math.max(MAX_TRACKED_GAP_STEP_M, 45 * dt);
      const rawClosingSpeed = closingSampleValid ? clamp(gapStep / dt, -45, 45) : 0;
      this.previousGaps[id] = ahead;
      this.gapSeen[id] = 1;
      const closingBlend = 1 - Math.exp(-CLOSING_FILTER_RATE * dt);
      this.closingSpeeds[id] += (rawClosingSpeed - this.closingSpeeds[id]) * closingBlend;
      const predictedAhead = ahead - Math.max(0, this.closingSpeeds[id]) * CLOSING_LOOKAHEAD_S;
      const bandPressure = clamp((maxAhead - predictedAhead) / Math.max(1, maxAhead - minAhead), 0, 1);
      const deficitPressure = clamp((minAhead - predictedAhead) / DEFICIT_BAND_M, 0, 1);
      const closingPressure = Math.max(deficitPressure, clamp(this.closingSpeeds[id] / 18, 0, 1));
      let target = BASE_PACE + (FORMATION_PACE - BASE_PACE) * bandPressure;
      target += (MAX_CHASE - target) * deficitPressure;
      // Contact gives the player breathing room without ever commanding an AI
      // slowdown. A battle hold is a floor, never a lock on a stale low scale.
      if (this.grace > 0) target = Math.min(FORMATION_PACE, target);
      else if (this.lock > 0) target = Math.max(target, FORMATION_PACE);
      this.biases[id] = approachAsymmetric(this.biases[id], target, dt);
      const techniqueTarget = role === 0 ? 1 : 0.92;
      this.techniquePressure[id] = approach(this.techniquePressure[id], techniqueTarget, 2.4 * dt);
      const flightTargetScale = 1 + (this.biases[id] - 1) * (0.02 / (MAX_CHASE - 1));
      const surfaceThrottleAssist = role === 1 || predictedAhead < maxAhead - 4 || closingPressure > 0.08 || isLateRace;
      setDirective(
        this.directives[id],
        this.biases[id],
        flightTargetScale,
        true,
        closingPressure,
        surfaceThrottleAssist,
      );
    }
  }

  paceFor(id: number): number {
    return this.biases[id] || 1;
  }

  /** Stable, zero-allocation signal sampled by AI planning and Boat drive. */
  controlFor(id: number): RivalPaceDirective {
    return this.directives[id] ?? NEUTRAL_DIRECTIVE;
  }

  flightPaceFor(id: number): number {
    return this.directives[id]?.flightTargetScale ?? 1;
  }

  techniqueFor(id: number): number {
    return this.techniquePressure[id] || 0;
  }

  openingFor(id: number): number {
    return this.openingPressure[id] || 0;
  }

  /** Authored driver style, independent of the player's gap and valid after flight four. */
  chainFor(id: number): number {
    const role = this.rivalIds.indexOf(id);
    return role === 0 ? 1 : role === 1 ? 0.9 : 0;
  }

  isElite(id: number): boolean {
    return this.rivalIds.includes(id);
  }

  notifyBattle(): void {
    this.lock = 0.8;
  }

  notifyPlayerImpact(): void {
    this.grace = 1.25;
  }

  releaseFormation(): void {
    this.formationFlights = 4;
    this.formationReleased = true;
    this.biases.fill(1);
    this.closingSpeeds.fill(0);
    this.gapSeen.fill(0);
    this.techniquePressure.fill(0);
    for (const directive of this.directives) setDirective(directive, 1, 1, false, 0);
  }

  debugState(): RivalDirectorDebug {
    return {
      rivals: this.rivalIds,
      pace: Array.from(this.biases),
      flightPace: this.directives.map((directive) => directive.flightTargetScale),
      technique: Array.from(this.techniquePressure),
      opening: Array.from(this.openingPressure),
      openingPressureId: this.openingPressureId,
      runSeed: this.runSeed,
      runTime: this.runTime,
      grace: this.grace,
      lock: this.lock,
      formationFlights: this.formationFlights,
      chain: this.definitions.map((definition) => this.chainFor(definition.id)),
      closingSpeed: Array.from(this.closingSpeeds),
      closingPressure: this.directives.map((directive) => directive.closingPressure),
      formationActive: this.directives.map((directive) => directive.formationActive),
      surfaceThrottleAssist: this.directives.map((directive) => directive.surfaceThrottleAssist),
    };
  }
}

function approachAsymmetric(current: number, target: number, dt: number): number {
  return approach(current, target, (target > current ? CHASE_RATE : RELEASE_RATE) * dt);
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return current;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function setDirective(
  directive: MutableRivalPaceDirective | undefined,
  surfaceTargetScale: number,
  flightTargetScale: number,
  formationActive: boolean,
  closingPressure: number,
  surfaceThrottleAssist = false,
): void {
  if (!directive) return;
  directive.surfaceTargetScale = surfaceTargetScale;
  directive.flightTargetScale = clamp(flightTargetScale, 1, 1.02);
  directive.formationActive = formationActive;
  directive.surfaceThrottleAssist = surfaceThrottleAssist;
  directive.closingPressure = closingPressure;
}

function openingEnvelope(time: number): number {
  if (time < 0.35 || time >= 7) return 0;
  return Math.min(1, (time - 0.35) / 0.8, (7 - time) / 1.1);
}

function hashSeed(seed: number): number {
  let value = (seed + 0x9e3779b9) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
}
