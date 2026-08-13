import type { ChallengeResult, FlightFailureSnapshot } from '../contracts';
import {
  freshCoachProgress,
  sanitizeCoachProgress,
  type DrivingCoachProgress,
} from './drivingCoach';

const STORAGE_KEY = 'board-race:challenge:v7';
const V6_KEY = 'board-race:challenge:v6';
const V5_KEY = 'board-race:challenge:v5';
const V4_KEY = 'board-race:challenge:v4';
const V3_KEY = 'board-race:challenge:v3';
const V2_KEY = 'board-race:challenge:v2';
const LEGACY_MEDAL_KEY = 'board-race:man-medals:v1';

export interface ChallengeRecords {
  version: 7;
  runs: number;
  ordinaryUnlocked: boolean;
  manMedalsTotal: number;
  excellentCount: number;
  bestQualificationTime: number | null;
  bestExcellentTime: number | null;
  bestFlights: number;
  bestRouteProgress: number;
  closestMissM: number | null;
  bestFlightsByDriver: Record<string, number>;
  farSeaDossierUnlocked: boolean;
  rivalWins: number;
  finaleCompletions: number;
  expansionSeenMask: number;
  finaleScreenshotCount: number;
  coach: DrivingCoachProgress;
}

const defaults = (): ChallengeRecords => {
  const legacyMedals = readLegacyMedals();
  return {
    version: 7,
    runs: 0,
    ordinaryUnlocked: false,
    manMedalsTotal: legacyMedals,
    excellentCount: 0,
    bestQualificationTime: null,
    bestExcellentTime: null,
    bestFlights: 0,
    bestRouteProgress: 0,
    closestMissM: null,
    bestFlightsByDriver: {},
    farSeaDossierUnlocked: false,
    rivalWins: 0,
    finaleCompletions: 0,
    expansionSeenMask: 0,
    finaleScreenshotCount: 0,
    coach: freshCoachProgress(legacyMedals > 0 ? 'expert' : 'dormant', legacyMedals === 0),
  };
};

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

  recordFlightPass(flights: number, driverId = 'axle'): { newBest: boolean; bestFlights: number; driverBest: number } {
    const newBest = flights > this.data.bestFlights;
    const driverBest = Math.max(this.data.bestFlightsByDriver[driverId] ?? 0, flights);
    const driverNewBest = driverBest > (this.data.bestFlightsByDriver[driverId] ?? 0);
    if (driverNewBest) this.data.bestFlightsByDriver[driverId] = driverBest;
    if (newBest) {
      this.data.bestFlights = flights;
      this.data.bestRouteProgress = 0;
    }
    if (flights >= 3) {
      this.data.farSeaDossierUnlocked = true;
      this.data.coach.status = 'expert';
      this.normalizeCoach();
    }
    if (newBest || driverNewBest || flights === 3) this.save();
    return { newBest, bestFlights: this.data.bestFlights, driverBest };
  }

  qualifyRun(raceTime: number): { ordinaryNew: boolean; manMedalsTotal: number } {
    const ordinaryNew = !this.data.ordinaryUnlocked;
    this.data.ordinaryUnlocked = true;
    this.data.manMedalsTotal++;
    this.data.coach.status = 'expert';
    this.normalizeCoach();
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

  recordRivalWin(): void {
    this.data.rivalWins++;
    this.save();
  }

  recordFinale(): void {
    this.data.finaleCompletions++;
    this.data.farSeaDossierUnlocked = true;
    this.save();
  }

  markExpansionSeen(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 6) return;
    const next = this.data.expansionSeenMask | (1 << index);
    if (next === this.data.expansionSeenMask) return;
    this.data.expansionSeenMask = next;
    this.save();
  }

  recordFinaleScreenshot(): void {
    this.data.finaleScreenshotCount++;
    this.save();
  }

  saveCoach(progress: DrivingCoachProgress): void {
    const sanitized = sanitizeCoachProgress(progress, this.data.bestFlights, this.data.ordinaryUnlocked, true);
    Object.assign(this.data.coach, sanitized);
    this.save();
  }

  exportJson(selectedDriverId: string): string {
    return JSON.stringify({ schema: 'board-race-save', exportedAt: new Date().toISOString(), selectedDriverId, records: this.data }, null, 2);
  }

  importJson(raw: string): { selectedDriverId: string | null } {
    const parsed = JSON.parse(raw) as { schema?: unknown; selectedDriverId?: unknown; records?: unknown };
    if (parsed.schema !== 'board-race-save' || !parsed.records || typeof parsed.records !== 'object') {
      throw new Error('存档格式不正确');
    }
    const incoming = sanitizeV7(parsed.records as Partial<ChallengeRecords>, this.data, false);
    // Import is an explicit return path, never a first visit. Preserve
    // mastery/preferences but do not arm the one-time automatic invitation.
    incoming.coach.automaticEligible = false;
    const coach = this.data.coach;
    Object.assign(this.data, incoming);
    Object.assign(coach, incoming.coach);
    this.data.coach = coach;
    this.save();
    return { selectedDriverId: typeof parsed.selectedDriverId === 'string' ? parsed.selectedDriverId : null };
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

  private normalizeCoach(): void {
    const sanitized = sanitizeCoachProgress(this.data.coach, this.data.bestFlights, this.data.ordinaryUnlocked, true);
    Object.assign(this.data.coach, sanitized);
  }
}

function loadRecords(): ChallengeRecords {
  const fallback = defaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ChallengeRecords>;
      if (parsed.version === 7) return sanitizeV7(parsed, fallback, true);
    }
    const v6Raw = localStorage.getItem(V6_KEY);
    if (v6Raw) {
      const v6 = JSON.parse(v6Raw) as Record<string, unknown>;
      if (v6.version === 6) return sanitizeV7(v6 as Partial<ChallengeRecords>, fallback, false);
    }
    const v5Raw = localStorage.getItem(V5_KEY);
    if (v5Raw) {
      const v5 = JSON.parse(v5Raw) as Record<string, unknown>;
      if (v5.version === 5) return sanitizeV7(v5 as Partial<ChallengeRecords>, fallback, false);
    }
    const v4Raw = localStorage.getItem(V4_KEY);
    if (v4Raw) {
      const v4 = JSON.parse(v4Raw) as Record<string, unknown>;
      if (v4.version === 4) return sanitizeV7(v4 as Partial<ChallengeRecords>, fallback, false);
    }
    const v3Raw = localStorage.getItem(V3_KEY);
    if (v3Raw) {
      const v3 = JSON.parse(v3Raw) as Record<string, unknown>;
      if (v3.version === 3) return sanitizeV7(v3 as Partial<ChallengeRecords>, fallback, false);
    }
    const v2Raw = localStorage.getItem(V2_KEY);
    if (!v2Raw) return fallback;
    const v2 = JSON.parse(v2Raw) as Record<string, unknown>;
    if (v2.version !== 2) return fallback;
    const excellentCount = finiteNonNegative(v2.excellentCount, 0);
    const ordinaryUnlocked = v2.ordinaryUnlocked === true;
    return {
      version: 7,
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
      bestFlightsByDriver: {},
      farSeaDossierUnlocked: finiteNonNegative(v2.bestFlightsCleared, 0) >= 3,
      rivalWins: 0,
      finaleCompletions: 0,
      expansionSeenMask: 0,
      finaleScreenshotCount: 0,
      coach: sanitizeCoachProgress(undefined, finiteNonNegative(v2.bestFlightsCleared, 0), ordinaryUnlocked),
    };
  } catch {
    return fallback;
  }
}

function sanitizeV7(parsed: Partial<ChallengeRecords>, fallback: ChallengeRecords, currentSchema: boolean): ChallengeRecords {
  const byDriver: Record<string, number> = {};
  if (parsed.bestFlightsByDriver && typeof parsed.bestFlightsByDriver === 'object') {
    for (const [key, value] of Object.entries(parsed.bestFlightsByDriver)) {
      if (/^[a-z0-9-]{1,32}$/.test(key)) byDriver[key] = finiteNonNegative(value, 0);
    }
  }
  const bestFlights = finiteNonNegative(parsed.bestFlights, 0);
  const ordinaryUnlocked = parsed.ordinaryUnlocked === true;
  const coachSource = parsed.coach as Partial<DrivingCoachProgress> | undefined;
  const validStatuses = new Set(['dormant', 'active', 'disabled', 'complete', 'expert']);
  const mastery = coachSource?.mastery as Partial<DrivingCoachProgress['mastery']> | undefined;
  const knowledge = coachSource?.knowledge as Partial<DrivingCoachProgress['knowledge']> | undefined;
  const validCurrentCoach = currentSchema && coachSource && typeof coachSource === 'object' &&
    validStatuses.has(String(coachSource.status)) && typeof coachSource.automaticEligible === 'boolean' &&
    mastery !== null && typeof mastery === 'object' &&
    knowledge !== null && typeof knowledge === 'object' &&
    ['steered', 'bankedCharge', 'launched', 'passedRoute', 'airBrakedInTurn', 'extendedFlight']
      .every((key) => typeof mastery[key as keyof typeof mastery] === 'boolean') &&
    ['bankRule', 'inventory', 'flightGauge', 'extension']
      .every((key) => typeof knowledge[key as keyof typeof knowledge] === 'boolean');
  // A complete v7 coach object preserves explicit false mastery bits. Missing
  // or malformed v7 coach data is returning/corrupt, never a fresh install.
  const coach = sanitizeCoachProgress(parsed.coach, bestFlights, ordinaryUnlocked, Boolean(validCurrentCoach));
  if (currentSchema && !validCurrentCoach) coach.automaticEligible = false;
  if (!currentSchema) {
    coach.automaticEligible = false;
    // v6's active state came from the retired automatic coach. A returning
    // player must not be surprised by a replacement tour after migration.
    if (coach.status === 'active') coach.status = bestFlights >= 3 || ordinaryUnlocked ? 'expert' : 'dormant';
  }
  return {
    version: 7,
    runs: finiteNonNegative(parsed.runs, 0),
    ordinaryUnlocked,
    manMedalsTotal: finiteNonNegative(parsed.manMedalsTotal, fallback.manMedalsTotal),
    excellentCount: finiteNonNegative(parsed.excellentCount, 0),
    bestQualificationTime: finitePositiveOrNull(parsed.bestQualificationTime),
    bestExcellentTime: finitePositiveOrNull(parsed.bestExcellentTime),
    bestFlights,
    bestRouteProgress: finiteNonNegative(parsed.bestRouteProgress, 0),
    closestMissM: finitePositiveOrNull(parsed.closestMissM),
    bestFlightsByDriver: byDriver,
    farSeaDossierUnlocked: parsed.farSeaDossierUnlocked === true || bestFlights >= 3,
    rivalWins: finiteNonNegative(parsed.rivalWins, 0),
    finaleCompletions: finiteNonNegative(parsed.finaleCompletions, 0),
    expansionSeenMask: Math.min(0x7f, Math.floor(finiteNonNegative(parsed.expansionSeenMask, 0))),
    finaleScreenshotCount: finiteNonNegative(parsed.finaleScreenshotCount, 0),
    coach,
  };
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
