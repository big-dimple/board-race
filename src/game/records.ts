import type { ChallengeResult, FlightFailureSnapshot } from '../contracts';

const STORAGE_KEY = 'board-race:challenge:v2';
const LEGACY_MEDAL_KEY = 'board-race:man-medals:v1';

export interface ChallengeRecords {
  version: 2;
  runs: number;
  ordinaryUnlocked: boolean;
  excellentCount: number;
  bestExcellentTime: number | null;
  bestCompleteTime: number | null;
  bestFlightsCleared: number;
  bestRouteProgress: number;
  closestMissM: number | null;
  legacyMedals: number;
}

const defaults = (): ChallengeRecords => ({
  version: 2,
  runs: 0,
  ordinaryUnlocked: false,
  excellentCount: 0,
  bestExcellentTime: null,
  bestCompleteTime: null,
  bestFlightsCleared: 0,
  bestRouteProgress: 0,
  closestMissM: null,
  legacyMedals: readLegacyMedals(),
});

export class RecordsStore {
  readonly data: ChallengeRecords;

  constructor() {
    this.data = loadRecords();
  }

  beginRun(): number {
    this.data.runs++;
    this.save();
    return this.data.runs;
  }

  recordFailure(result: ChallengeResult): boolean {
    const failure = result.failure;
    if (!failure) return false;
    const newBest = this.isProgressBest(failure);
    if (newBest) {
      this.data.bestFlightsCleared = failure.flightsCleared;
      this.data.bestRouteProgress = failure.routeU;
    }
    const miss = missDistance(failure);
    if (miss !== null && miss > 0 && (this.data.closestMissM === null || miss < this.data.closestMissM)) {
      this.data.closestMissM = miss;
    }
    this.save();
    return newBest;
  }

  recordCompletion(result: ChallengeResult): { ordinaryNew: boolean; excellentTotal: number } {
    let ordinaryNew = false;
    this.data.bestFlightsCleared = 3;
    this.data.bestRouteProgress = Math.max(this.data.bestRouteProgress, 1);
    if (this.data.bestCompleteTime === null || result.raceTime < this.data.bestCompleteTime) {
      this.data.bestCompleteTime = result.raceTime;
    }
    if (result.outcome === 'excellent') {
      this.data.excellentCount++;
      if (this.data.bestExcellentTime === null || result.raceTime < this.data.bestExcellentTime) {
        this.data.bestExcellentTime = result.raceTime;
      }
    } else if (result.outcome === 'ordinary' && !this.data.ordinaryUnlocked) {
      this.data.ordinaryUnlocked = true;
      ordinaryNew = true;
    }
    this.save();
    return { ordinaryNew, excellentTotal: this.data.excellentCount };
  }

  private isProgressBest(failure: FlightFailureSnapshot): boolean {
    return failure.flightsCleared > this.data.bestFlightsCleared ||
      // Ignore sub-frame crossing jitter; a PB must move the run forward by a
      // visible amount (roughly 2.5m on the current course).
      (failure.flightsCleared === this.data.bestFlightsCleared && failure.routeU > this.data.bestRouteProgress + 0.001);
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // Storage is optional; gameplay and the current session still continue.
    }
  }
}

function loadRecords(): ChallengeRecords {
  const fallback = defaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ChallengeRecords>;
    if (parsed.version !== 2) return fallback;
    return {
      version: 2,
      runs: finiteNonNegative(parsed.runs, 0),
      ordinaryUnlocked: parsed.ordinaryUnlocked === true,
      excellentCount: finiteNonNegative(parsed.excellentCount, 0),
      bestExcellentTime: finitePositiveOrNull(parsed.bestExcellentTime),
      bestCompleteTime: finitePositiveOrNull(parsed.bestCompleteTime),
      bestFlightsCleared: Math.min(3, finiteNonNegative(parsed.bestFlightsCleared, 0)),
      bestRouteProgress: finiteNonNegative(parsed.bestRouteProgress, 0),
      closestMissM: finitePositiveOrNull(parsed.closestMissM),
      legacyMedals: finiteNonNegative(parsed.legacyMedals, fallback.legacyMedals),
    };
  } catch {
    return fallback;
  }
}

function readLegacyMedals(): number {
  try {
    return finiteNonNegative(Number.parseInt(localStorage.getItem(LEGACY_MEDAL_KEY) ?? '0', 10), 0);
  } catch {
    return 0;
  }
}

function missDistance(failure: FlightFailureSnapshot): number | null {
  if (failure.lateralOffsetM !== null && failure.lateralLimitM !== null) {
    return Math.max(0, Math.abs(failure.lateralOffsetM) - failure.lateralLimitM);
  }
  if (failure.reason === 'late') return Math.max(0, 2.8 - failure.clearanceM);
  return null;
}

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finitePositiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
