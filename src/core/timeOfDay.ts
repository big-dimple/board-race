/**
 * timeOfDay.ts — core day/night cycle state and transition manager.
 *
 * Rules:
 *  - Round 0 (opening round) is seeded by the player's local wall clock:
 *    18:00–05:59 local starts at night, otherwise day (see localTimeSeed).
 *  - Later rounds keep alternating from that seed: (round + parity) % 2.
 *  - Supports URL override ?tod=day | ?tod=night (wins over the seed).
 *  - Harness/screenshot runs pass an explicit 'day' seed so captures stay
 *    deterministic regardless of the host clock.
 *  - Smooth transition blend in [0..1] with zero-allocation update loop.
 */

export type TimeOfDay = 'day' | 'night';

/** Opening-round seed from the local wall clock: night runs 18:00–05:59. */
export function localTimeSeed(date: Date = new Date()): TimeOfDay {
  const hour = date.getHours();
  return hour >= 18 || hour < 6 ? 'night' : 'day';
}

export class TimeOfDayManager {
  private _round = 0;
  private _override: TimeOfDay | null = null;
  private _parity = 0; // 0 = round 0 is day, 1 = round 0 is night
  private _blend = 0.0; // 0.0 = day, 1.0 = night
  private _targetBlend = 0.0;
  private _transitionSpeed = 2.5; // full transition in ~0.4s or instantaneous

  constructor(initialOverride?: TimeOfDay | string | null, seed?: TimeOfDay | null) {
    if (initialOverride === 'day' || initialOverride === 'night') {
      this._override = initialOverride;
    }
    this._parity = seed === 'night' ? 1 : 0;
    this._recomputeTarget(true);
  }

  get round(): number {
    return this._round;
  }

  get current(): TimeOfDay {
    if (this._override) return this._override;
    return (this._round + this._parity) % 2 === 1 ? 'night' : 'day';
  }

  /** Current interpolated blend factor: 0.0 = full day, 1.0 = full night */
  get blend(): number {
    return this._blend;
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
