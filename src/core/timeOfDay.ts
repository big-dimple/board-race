/**
 * timeOfDay.ts — core day/night cycle state and transition manager.
 *
 * Rules:
 *  - Round 0: Day ('day', blend = 0)
 *  - Round 1: Night ('night', blend = 1)
 *  - Alternating: round % 2 === 1 ? 'night' : 'day'
 *  - Supports URL override ?tod=day | ?tod=night
 *  - Smooth transition blend in [0..1] with zero-allocation update loop.
 */

export type TimeOfDay = 'day' | 'night';

export interface TimeOfDayState {
  timeOfDay: TimeOfDay;
  blend: number; // 0 = day, 1 = night
  round: number;
}

export class TimeOfDayManager {
  private _round = 0;
  private _override: TimeOfDay | null = null;
  private _blend = 0.0; // 0.0 = day, 1.0 = night
  private _targetBlend = 0.0;
  private _transitionSpeed = 2.5; // full transition in ~0.4s or instantaneous

  constructor(initialOverride?: TimeOfDay | string | null) {
    if (initialOverride === 'day' || initialOverride === 'night') {
      this._override = initialOverride;
    }
    this._recomputeTarget(true);
  }

  get round(): number {
    return this._round;
  }

  get current(): TimeOfDay {
    if (this._override) return this._override;
    return this._round % 2 === 1 ? 'night' : 'day';
  }

  get isNight(): boolean {
    return this.current === 'night';
  }

  /** Current interpolated blend factor: 0.0 = full day, 1.0 = full night */
  get blend(): number {
    return this._blend;
  }

  get override(): TimeOfDay | null {
    return this._override;
  }

  setOverride(tod: TimeOfDay | null, instant = false): void {
    this._override = tod;
    this._recomputeTarget(instant);
  }

  setRound(round: number, instant = false): void {
    this._round = Math.max(0, Math.floor(round));
    this._recomputeTarget(instant);
  }

  nextRound(instant = false): void {
    this.setRound(this._round + 1, instant);
  }

  reset(instant = true): void {
    this._round = 0;
    this._recomputeTarget(instant);
  }

  update(dt: number): void {
    if (Math.abs(this._blend - this._targetBlend) < 1e-4) {
      this._blend = this._targetBlend;
      return;
    }
    const step = dt * this._transitionSpeed;
    if (this._blend < this._targetBlend) {
      this._blend = Math.min(this._targetBlend, this._blend + step);
    } else {
      this._blend = Math.max(this._targetBlend, this._blend - step);
    }
  }

  private _recomputeTarget(instant: boolean): void {
    const target = this.current === 'night' ? 1.0 : 0.0;
    this._targetBlend = target;
    if (instant) {
      this._blend = target;
    }
  }
}
