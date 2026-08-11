import type { ChallengeResult, FlightFailureSnapshot } from '../contracts';

const STORAGE_KEY = 'board-race:challenge:v3';
const V2_KEY = 'board-race:challenge:v2';
const LEGACY_MEDAL_KEY = 'board-race:man-medals:v1';

export interface ChallengeRecords {
  version: 3;
  runs: number;
  ordinaryUnlocked: boolean;
  manMedalsTotal: number;
  excellentCount: number;
  bestQualificationTime: number | null;
  bestExcellentTime: number | null;
  bestFlights: number;
  bestRouteProgress: number;
  closestMissM: number | null;
}

const defaults = (): ChallengeRecords => ({
  version: 3,
  runs: 0,
  ordinaryUnlocked: false,
  manMedalsTotal: readLegacyMedals(),
  excellentCount: 0,
  bestQualificationTime: null,
  bestExcellentTime: null,
  bestFlights: 0,
  bestRouteProgress: 0,
  closestMissM: null,
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

  recordFlightPass(flights: number): { newBest: boolean; bestFlights: number } {
    const newBest = flights > this.data.bestFlights;
    if (newBest) {
      this.data.bestFlights = flights;
      this.data.bestRouteProgress = 0;
      this.save();
    }
    return { newBest, bestFlights: this.data.bestFlights };
  }

  qualifyRun(raceTime: number): { ordinaryNew: boolean; manMedalsTotal: number } {
    const ordinaryNew = !this.data.ordinaryUnlocked;
    this.data.ordinaryUnlocked = true;
    this.data.manMedalsTotal++;
    if (this.data.bestQualificationTime === null || raceTime < this.data.bestQualificationTime) {
      this.data.bestQualificationTime = raceTime;
    }
    this.save();
    return { ordinaryNew, manMedalsTotal: this.data.manMedalsTotal };
  }

  recordExcellent(raceTime: number): { excellentTotal: number; newBestTime: boolean } {
    this.data.excellentCount++;
    const newBestTime = this.data.bestExcellentTime === null || raceTime < this.data.bestExcellentTime;
    if (newBestTime) this.data.bestExcellentTime = raceTime;
    this.save();
    return { excellentTotal: this.data.excellentCount, newBestTime };
  }

  recordFailure(result: ChallengeResult): boolean {
    const failure = result.failure;
    if (!failure) return false;
    const routeBest = failure.flightsCleared === this.data.bestFlights &&
      failure.routeU > this.data.bestRouteProgress + 0.001;
    if (routeBest) this.data.bestRouteProgress = failure.routeU;
    const miss = missDistance(failure);
    if (miss !== null && miss > 0 && (this.data.closestMissM === null || miss < this.data.closestMissM)) {
      this.data.closestMissM = miss;
    }
    this.save();
    return routeBest;
  }

  decorateResult(result: ChallengeResult, newBest: boolean, medalEarned: boolean): void {
    result.newBest = newBest;
    result.bestFlights = this.data.bestFlights;
    result.manMedalEarned = medalEarned;
    result.manMedalsTotal = this.data.manMedalsTotal;
    result.excellentTotal = this.data.excellentCount;
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
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ChallengeRecords>;
      if (parsed.version === 3) {
        return {
          version: 3,
          runs: finiteNonNegative(parsed.runs, 0),
          ordinaryUnlocked: parsed.ordinaryUnlocked === true,
          manMedalsTotal: finiteNonNegative(parsed.manMedalsTotal, fallback.manMedalsTotal),
          excellentCount: finiteNonNegative(parsed.excellentCount, 0),
          bestQualificationTime: finitePositiveOrNull(parsed.bestQualificationTime),
          bestExcellentTime: finitePositiveOrNull(parsed.bestExcellentTime),
          bestFlights: finiteNonNegative(parsed.bestFlights, 0),
          bestRouteProgress: finiteNonNegative(parsed.bestRouteProgress, 0),
          closestMissM: finitePositiveOrNull(parsed.closestMissM),
        };
      }
    }
    const v2Raw = localStorage.getItem(V2_KEY);
    if (!v2Raw) return fallback;
    const v2 = JSON.parse(v2Raw) as Record<string, unknown>;
    if (v2.version !== 2) return fallback;
    const excellentCount = finiteNonNegative(v2.excellentCount, 0);
    const ordinaryUnlocked = v2.ordinaryUnlocked === true;
    return {
      version: 3,
      runs: finiteNonNegative(v2.runs, 0),
      ordinaryUnlocked,
      manMedalsTotal: Math.max(
        fallback.manMedalsTotal,
        excellentCount,
        ordinaryUnlocked ? 1 : 0,
        finiteNonNegative(v2.legacyMedals, 0),
      ),
      excellentCount,
      bestQualificationTime: finitePositiveOrNull(v2.bestCompleteTime),
      bestExcellentTime: finitePositiveOrNull(v2.bestExcellentTime),
      bestFlights: finiteNonNegative(v2.bestFlightsCleared, 0),
      bestRouteProgress: finiteNonNegative(v2.bestRouteProgress, 0),
      closestMissM: finitePositiveOrNull(v2.closestMissM),
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
