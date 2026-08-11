/**
 * input.ts — keyboard state → BoatInput for the player.
 *
 * W/↑ throttle, S/↓ brake-reverse, A/D ←/→ steer, Space drift, Enter confirm.
 * Steering returns to center smoothly; throttle is binary-ish with a fast ramp
 * so keyboard play still feels weighty.
 */
import type { BoatInput } from '../contracts';

export class Input {
  readonly keys = new Set<string>();
  /** Edge-triggered: true for one consume() call after keydown. */
  private pressed = new Set<string>();
  private throttleVal = 0;
  private steerVal = 0;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => this.keys.clear());
  }

  /** Was this key pressed since the last consume? Consumes the flag. */
  consumePress(code: string): boolean {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }

  read(dt: number): BoatInput {
    const up = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const down = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight');

    const throttleTarget = up ? 1 : down ? -0.6 : 0;
    const steerTarget = left ? -1 : right ? 1 : 0;
    // Ramp toward targets: throttle slower (weight), steering fast but not instant.
    this.throttleVal = approach(this.throttleVal, throttleTarget, (up || down ? 2.2 : 3.5) * dt);
    this.steerVal = approach(this.steerVal, steerTarget, 7 * dt);

    return {
      throttle: this.throttleVal,
      steer: this.steerVal,
      drift: this.keys.has('Space'),
    };
  }
}

function approach(cur: number, target: number, maxDelta: number): number {
  if (cur < target) return Math.min(cur + maxDelta, target);
  if (cur > target) return Math.max(cur - maxDelta, target);
  return cur;
}
