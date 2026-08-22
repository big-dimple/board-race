import type { GamepadInput } from './gamepadInput';

const HAPTIC_STORAGE_KEY = 'board-race.haptics.v1';

export type HapticDevice = 'keyboard' | 'gamepad' | 'mobile';

export type HapticCue =
  | 'drift-active'
  | 'drift-ready'
  | 'charge'
  | 'boost'
  | 'air-brake'
  | 'launch'
  | 'extend'
  | 'gate'
  | 'landing'
  | 'collision-light'
  | 'collision-heavy'
  | 'warning'
  | 'storm-edge'
  | 'storm-critical'
  | 'defeat'
  | 'medal';

type HapticLane = 'control' | 'impact' | 'presentation';

interface HapticProfile {
  strong: number;
  weak: number;
  duration: number;
  mobileDuration: number;
  priority: number;
  cooldown: number;
  lane: HapticLane;
}

const PROFILES: Record<HapticCue, HapticProfile> = {
  'drift-active': { strong: 0.14, weak: 0.3, duration: 16, mobileDuration: 10, priority: 1, cooldown: 0.4, lane: 'control' },
  'drift-ready': { strong: 0.18, weak: 0.42, duration: 24, mobileDuration: 12, priority: 2, cooldown: 0.25, lane: 'control' },
  charge: { strong: 0.18, weak: 0.38, duration: 24, mobileDuration: 12, priority: 3, cooldown: 0.2, lane: 'control' },
  boost: { strong: 0.24, weak: 0.5, duration: 30, mobileDuration: 14, priority: 4, cooldown: 0.2, lane: 'control' },
  'air-brake': { strong: 0.18, weak: 0.42, duration: 20, mobileDuration: 10, priority: 3, cooldown: 0.22, lane: 'control' },
  launch: { strong: 0.34, weak: 0.5, duration: 34, mobileDuration: 16, priority: 5, cooldown: 0.2, lane: 'control' },
  extend: { strong: 0.24, weak: 0.46, duration: 28, mobileDuration: 14, priority: 4, cooldown: 0.2, lane: 'control' },
  gate: { strong: 0.18, weak: 0.36, duration: 22, mobileDuration: 10, priority: 4, cooldown: 0.18, lane: 'control' },
  // A water re-entry is the biggest routine hit the hull takes — full strong
  // motor burst, never discounted for a held drift/air-brake.
  landing: { strong: 1, weak: 0.45, duration: 80, mobileDuration: 30, priority: 6, cooldown: 0.25, lane: 'impact' },
  'collision-light': { strong: 0.26, weak: 0.18, duration: 28, mobileDuration: 12, priority: 5, cooldown: 0.2, lane: 'impact' },
  'collision-heavy': { strong: 0.55, weak: 0.25, duration: 52, mobileDuration: 20, priority: 7, cooldown: 0.28, lane: 'impact' },
  warning: { strong: 0.12, weak: 0.3, duration: 20, mobileDuration: 10, priority: 3, cooldown: 0.9, lane: 'presentation' },
  // Corridor storm band entries. The critical jolt is a full-motor slam so
  // the 失控 transition is felt in the hands, not just seen.
  'storm-edge': { strong: 0.35, weak: 0.55, duration: 40, mobileDuration: 18, priority: 5, cooldown: 0.4, lane: 'presentation' },
  'storm-critical': { strong: 0.95, weak: 0.6, duration: 80, mobileDuration: 40, priority: 7, cooldown: 0.5, lane: 'presentation' },
  defeat: { strong: 0.68, weak: 0.28, duration: 68, mobileDuration: 20, priority: 9, cooldown: 0.8, lane: 'presentation' },
  medal: { strong: 0.34, weak: 0.54, duration: 54, mobileDuration: 18, priority: 8, cooldown: 1, lane: 'presentation' },
};

interface PendingImpact {
  cue: 'landing' | 'collision-light' | 'collision-heavy';
  scale: number;
  readyAt: number;
}

/**
 * Coordinates short phone/controller pulses without continuous rumble.
 *
 * Control-lane cues (drift and air-brake) own a tiny protected window. Impact
 * feedback arriving during that window is coalesced and emitted afterwards at
 * a bounded strength, so a collision never erases the right-hand skill feel.
 */
export class Haptics {
  private enabledValue = loadEnabled();
  private priority = -1;
  private priorityUntil = 0;
  private controlUntil = 0;
  private impactCooldownUntil = 0;
  private pendingImpact: PendingImpact | null = null;
  private readonly lastCueAt = new Map<HapticCue, number>();
  private cueCount = 0;
  private lastCue: HapticCue | '' = '';
  private queuedImpacts = 0;
  private coalescedImpacts = 0;
  private droppedImpacts = 0;
  private lastLane: HapticLane | '' = '';

  constructor(
    private readonly gamepad: GamepadInput,
    private readonly activeDevice: () => HapticDevice,
  ) {}

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
    saveEnabled(enabled);
    this.lastCueAt.clear();
    this.priority = -1;
    this.priorityUntil = 0;
    this.controlUntil = 0;
    this.impactCooldownUntil = 0;
    this.pendingImpact = null;
    if (!enabled) this.stop();
  }

  cue(cue: HapticCue, scale = 1): boolean {
    const profile = PROFILES[cue];
    if (profile.lane === 'impact') return this.impact(cue as PendingImpact['cue'], scale, false);
    return this.dispatch(cue, scale, profile.lane);
  }

  /** Queue an impact behind a held drift/air-brake control pulse. */
  impact(cue: 'landing' | 'collision-light' | 'collision-heavy', scale = 1, controlHeld = false): boolean {
    if (!this.enabledValue || document.hidden) return false;
    const now = performance.now() / 1000;
    if (controlHeld || now < this.controlUntil) {
      const previous = this.pendingImpact;
      const nextScale = Math.max(previous?.scale ?? 0, Math.max(0, Math.min(1, scale)) * 0.72);
      const nextCue = previous && PROFILES[previous.cue].priority >= PROFILES[cue].priority ? previous.cue : cue;
      this.pendingImpact = { cue: nextCue, scale: nextScale, readyAt: now + 0.09 };
      if (previous) this.coalescedImpacts++;
      else this.queuedImpacts++;
      return false;
    }
    if (now < this.impactCooldownUntil) {
      this.coalescedImpacts++;
      this.droppedImpacts++;
      return false;
    }
    return this.dispatch(cue, scale, 'impact');
  }

  /** Fixed-step flush for queued impacts; keeps tests deterministic. */
  update(): void {
    if (!this.pendingImpact || !this.enabledValue || document.hidden) return;
    const now = performance.now() / 1000;
    if (now < this.controlUntil || now < this.pendingImpact.readyAt) return;
    const pending = this.pendingImpact;
    this.pendingImpact = null;
    if (now < this.impactCooldownUntil) {
      this.droppedImpacts++;
      return;
    }
    this.dispatch(pending.cue, pending.scale, 'impact');
  }

  private stormLastAt = -Infinity;

  /**
   * Sustained corridor-storm rumble, re-issued on a fixed cadence while the
   * player is off-corridor. The weak motor carries a rising buzz from first
   * contact; the strong motor joins only in the losing-control band.
   */
  setStorm(level: number): void {
    if (!this.enabledValue || document.hidden) return;
    const n = Math.max(0, Math.min(1, level));
    if (n <= 0.01) return;
    const now = performance.now() / 1000;
    if (now - this.stormLastAt < 0.08) return;
    this.stormLastAt = now;
    const critical = Math.max(0, Math.min(1, (n - 0.45) / 0.55));
    const device = this.activeDevice();
    if (device === 'gamepad') {
      this.gamepad.rumble(0.1 + critical * 0.45, 0.26 + 0.3 * n + 0.2 * critical, 80);
    } else if (device === 'mobile' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(Math.round(6 + n * 16));
      } catch {
        // Vibration is optional; some WebViews reject after blur.
      }
    }
  }

  stop(): void {
    this.gamepad.stopRumble();
    if (typeof navigator.vibrate === 'function') {
      try { navigator.vibrate(0); } catch { /* some WebViews reject after blur */ }
    }
    this.pendingImpact = null;
    this.priority = -1;
    this.priorityUntil = 0;
    this.controlUntil = 0;
    this.impactCooldownUntil = 0;
  }

  status(): Record<string, number | string | boolean> {
    const now = performance.now() / 1000;
    return {
      enabled: this.enabledValue,
      cueCount: this.cueCount,
      lastCue: this.lastCue,
      lastLane: this.lastLane,
      activeDevice: this.activeDevice(),
      queuedImpacts: this.queuedImpacts,
      coalescedImpacts: this.coalescedImpacts,
      droppedImpacts: this.droppedImpacts,
      controlProtected: now < this.controlUntil,
      pendingImpact: Boolean(this.pendingImpact),
    };
  }

  private dispatch(cue: HapticCue, scale: number, lane: HapticLane): boolean {
    if (!this.enabledValue || document.hidden) return false;
    const profile = PROFILES[cue];
    const now = performance.now() / 1000;
    const previous = this.lastCueAt.get(cue) ?? -Infinity;
    if (now - previous < profile.cooldown) return false;
    if (now < this.priorityUntil && profile.priority < this.priority) return false;
    const amount = Math.max(0, Math.min(1, scale));
    const device = this.activeDevice();
    let played = false;
    if (device === 'gamepad') {
      played = this.gamepad.rumble(profile.strong * amount, profile.weak * amount, profile.duration);
    } else if (device === 'mobile' && typeof navigator.vibrate === 'function') {
      try {
        played = navigator.vibrate(Math.max(1, Math.round(profile.mobileDuration * amount)));
      } catch {
        played = false;
      }
    }
    this.lastCueAt.set(cue, now);
    this.priority = profile.priority;
    this.priorityUntil = now + profile.duration / 1000;
    this.lastLane = lane;
    if (lane === 'control') this.controlUntil = Math.max(this.controlUntil, now + profile.duration / 1000 + 0.035);
    if (lane === 'impact') this.impactCooldownUntil = now + 0.09;
    if (played) {
      this.cueCount++;
      this.lastCue = cue;
    }
    return played;
  }
}

function loadEnabled(): boolean {
  try {
    const raw = localStorage.getItem(HAPTIC_STORAGE_KEY);
    return raw === null ? true : raw !== 'false';
  } catch {
    return true;
  }
}

function saveEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(HAPTIC_STORAGE_KEY, String(enabled));
  } catch {
    // Haptics remain available for this page if persistence is blocked.
  }
}
