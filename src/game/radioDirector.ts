export type RadioPriority = 'flavor' | 'tactical' | 'critical';

export interface RadioSpeaker {
  kind: 'team' | 'driver';
  name: string;
  color: number;
  portraitUrl?: string;
  portraitPosition?: string;
  icon?: string;
}

export interface RadioNotice {
  key: string;
  /** Coalesce one logical action cue for the rest of the current run. */
  coalesceKey?: string;
  speaker: RadioSpeaker;
  message: string;
  emphasis?: string;
  meta?: string;
  presentation?: 'compact' | 'broadcast';
  priority: RadioPriority;
  duration: number;
  ttl: number;
  /** Suppress this notice for the rest of the page session after display. */
  sessionKey?: string;
}

interface QueuedNotice {
  notice: RadioNotice;
  waited: number;
  order: number;
}

const PRIORITY: Record<RadioPriority, number> = { flavor: 1, tactical: 2, critical: 3 };
const GLOBAL_START_GAP = 3.5;

/** Pure single-slot arbiter. RaceTower owns DOM; this class owns pacing. */
export class RadioDirector {
  private readonly queue: QueuedNotice[] = [];
  private readonly runSeen = new Set<string>();
  private readonly runCoalesced = new Set<string>();
  private readonly queuedKeys = new Set<string>();
  private readonly sessionSeen = new Set<string>();
  private activeValue: RadioNotice | null = null;
  private activeTimer = 0;
  private startGap = 0;
  private order = 0;
  private revisionValue = 0;

  resetRun(): void {
    this.queue.length = 0;
    this.runSeen.clear();
    this.runCoalesced.clear();
    this.queuedKeys.clear();
    this.activeValue = null;
    this.activeTimer = 0;
    this.startGap = 0;
    this.order = 0;
    this.revisionValue++;
  }

  enqueue(notice: RadioNotice): boolean {
    if (this.runSeen.has(notice.key) || this.queuedKeys.has(notice.key)) return false;
    if (notice.coalesceKey && this.runCoalesced.has(notice.coalesceKey)) return false;
    if (notice.sessionKey && this.sessionSeen.has(notice.sessionKey)) return false;

    if (notice.coalesceKey) this.runCoalesced.add(notice.coalesceKey);

    if (this.activeValue && PRIORITY[notice.priority] > PRIORITY[this.activeValue.priority]) {
      this.finishActive();
      this.show(notice);
      return true;
    }

    this.queue.push({ notice, waited: 0, order: this.order++ });
    this.queuedKeys.add(notice.key);
    return true;
  }

  update(dt: number, blocked: boolean): RadioNotice | null {
    this.startGap = Math.max(0, this.startGap - dt);
    for (const item of this.queue) item.waited += dt;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].waited <= this.queue[i].notice.ttl) continue;
      this.queuedKeys.delete(this.queue[i].notice.key);
      this.queue.splice(i, 1);
    }

    if (blocked) return this.activeValue;
    if (this.activeValue) {
      this.activeTimer = Math.max(0, this.activeTimer - dt);
      if (this.activeTimer <= 0) this.finishActive();
    }
    if (!this.activeValue && this.startGap <= 0 && this.queue.length > 0) {
      this.queue.sort((a, b) => PRIORITY[b.notice.priority] - PRIORITY[a.notice.priority] || a.order - b.order);
      const next = this.queue.shift()!;
      this.queuedKeys.delete(next.notice.key);
      this.show(next.notice);
    }
    return this.activeValue;
  }

  get active(): RadioNotice | null {
    return this.activeValue;
  }

  get revision(): number {
    return this.revisionValue;
  }

  status(): Record<string, number | string | boolean> {
    return {
      activeKey: this.activeValue?.key ?? '',
      priority: this.activeValue?.priority ?? '',
      timer: this.activeTimer,
      queued: this.queue.length,
      revision: this.revisionValue,
    };
  }

  private show(notice: RadioNotice): void {
    this.activeValue = notice;
    this.activeTimer = notice.duration;
    this.startGap = GLOBAL_START_GAP;
    this.runSeen.add(notice.key);
    if (notice.sessionKey) this.sessionSeen.add(notice.sessionKey);
    this.revisionValue++;
  }

  private finishActive(): void {
    if (!this.activeValue) return;
    this.activeValue = null;
    this.activeTimer = 0;
    this.revisionValue++;
  }
}
