import type { RacerDefinition, RacerState } from '../contracts';

const MAX_CHASE = 1.12;
const FORMATION_PACE = 1.06;
const MAX_RELEASE = 0.72;
const CHANGE_RATE = 0.12;

export interface RivalDirectorDebug {
  rivals: readonly number[];
  pace: readonly number[];
  technique: readonly number[];
  opening: readonly number[];
  openingPressureId: number;
  runSeed: number;
  runTime: number;
  grace: number;
  lock: number;
  formationFlights: number;
  chain: readonly number[];
}

/** Coordinates only the two strongest opponents; all other AI stays on authored pace. */
export class RivalDirector {
  private biases = new Float32Array(0);
  private techniquePressure = new Float32Array(0);
  private openingPressure = new Float32Array(0);
  private definitions: readonly RacerDefinition[] = [];
  private rivalIds: number[] = [];
  private openingPressureId = -1;
  private runSeed = 0;
  private runTime = 0;
  private grace = 0;
  private lock = 0;
  private formationFlights = 0;

  setRoster(definitions: readonly RacerDefinition[]): void {
    this.definitions = definitions;
    this.biases = new Float32Array(definitions.length);
    this.biases.fill(1);
    this.techniquePressure = new Float32Array(definitions.length);
    this.openingPressure = new Float32Array(definitions.length);
    this.rivalIds = definitions.filter((definition) => !definition.isPlayer)
      .sort((a, b) => b.pace - a.pace)
      .slice(0, 2)
      .map((definition) => definition.id);
    this.openingPressureId = -1;
    this.runTime = 0;
    this.grace = 0;
    this.lock = 0;
    this.formationFlights = 0;
  }

  beginRun(seed: number): void {
    this.runSeed = Math.max(0, Math.floor(seed));
    this.runTime = 0;
    this.grace = 0;
    this.lock = 0;
    this.formationFlights = 0;
    this.biases.fill(1);
    this.techniquePressure.fill(0);
    this.openingPressure.fill(0);
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

  update(dt: number, racers: readonly RacerState[], playerFlightsCleared = 0): void {
    this.formationFlights = playerFlightsCleared;
    this.runTime += dt;
    this.grace = Math.max(0, this.grace - dt);
    this.lock = Math.max(0, this.lock - dt);
    const player = racers.find((racer) => racer.isPlayer);
    if (!player) return;
    for (let id = 0; id < this.biases.length; id++) {
      const racer = racers[id];
      const openingTarget = id === this.openingPressureId && this.grace <= 0
        ? openingEnvelope(this.runTime)
        : 0;
      this.openingPressure[id] = approach(this.openingPressure[id], openingTarget, 2.4 * dt);
      if (!racer || racer.isPlayer || !this.rivalIds.includes(id)) {
        this.biases[id] = approach(this.biases[id], 1, CHANGE_RATE * 2 * dt);
        this.techniquePressure[id] = approach(this.techniquePressure[id], 0, 2.5 * dt);
        continue;
      }
      const role = this.rivalIds.indexOf(id);
      if (playerFlightsCleared >= 4) {
        // The fourth pass is the exact end of formation assistance. Fixed driver
        // skill remains, but no later input depends on the player's gap.
        this.biases[id] = 1;
        this.techniquePressure[id] = 0;
        continue;
      }

      const protectedRoles = 2;
      if (role >= protectedRoles) {
        this.biases[id] = approach(this.biases[id], 1, CHANGE_RATE * 2 * dt);
        this.techniquePressure[id] = approach(this.techniquePressure[id], 0, 2.5 * dt);
        continue;
      }

      const ahead = racer.progress - player.progress;
      const minAhead = role === 0 ? 18 : 10;
      const maxAhead = role === 0 ? 32 : 24;
      let target = ahead < minAhead ? MAX_CHASE : ahead > maxAhead ? MAX_RELEASE : FORMATION_PACE;
      if (this.grace > 0) target = Math.min(1, target);
      else if (this.lock > 0) target = this.biases[id];
      this.biases[id] = approach(this.biases[id], target, CHANGE_RATE * dt);
      const techniqueTarget = role === 0 ? 1 : 0.92;
      this.techniquePressure[id] = approach(this.techniquePressure[id], techniqueTarget, 2.4 * dt);
    }
  }

  paceFor(id: number): number {
    return this.biases[id] || 1;
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
    this.lock = 2;
  }

  notifyPlayerImpact(): void {
    this.grace = 2.5;
  }

  releaseFormation(): void {
    this.formationFlights = 4;
    this.biases.fill(1);
    this.techniquePressure.fill(0);
  }

  debugState(): RivalDirectorDebug {
    return {
      rivals: this.rivalIds,
      pace: Array.from(this.biases),
      technique: Array.from(this.techniquePressure),
      opening: Array.from(this.openingPressure),
      openingPressureId: this.openingPressureId,
      runSeed: this.runSeed,
      runTime: this.runTime,
      grace: this.grace,
      lock: this.lock,
      formationFlights: this.formationFlights,
      chain: this.definitions.map((definition) => this.chainFor(definition.id)),
    };
  }
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return current;
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
