import type { GamepadInput } from './gamepadInput';

const HAPTIC_STORAGE_KEY = 'board-race.haptics.v1';

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
  | 'defeat'
  | 'medal';

interface HapticProfile {
  strong: number;
  weak: number;
  duration: number;
  mobileDuration: number;
  priority: number;
  cooldown: number;
}

const PROFILES: Record<HapticCue, HapticProfile> = {
  'drift-active': { strong: 0.08, weak: 0.22, duration: 12, mobileDuration: 8, priority: 1, cooldown: 0.45 },
  'drift-ready': { strong: 0.12, weak: 0.32, duration: 18, mobileDuration: 10, priority: 2, cooldown: 0.25 },
  charge: { strong: 0.18, weak: 0.38, duration: 24, mobileDuration: 12, priority: 3, cooldown: 0.2 },
  boost: { strong: 0.24, weak: 0.5, duration: 30, mobileDuration: 14, priority: 4, cooldown: 0.2 },
  'air-brake': { strong: 0.18, weak: 0.42, duration: 20, mobileDuration: 10, priority: 3, cooldown: 0.22 },
  launch: { strong: 0.34, weak: 0.5, duration: 34, mobileDuration: 16, priority: 5, cooldown: 0.2 },
  extend: { strong: 0.24, weak: 0.46, duration: 28, mobileDuration: 14, priority: 4, cooldown: 0.2 },
  gate: { strong: 0.18, weak: 0.36, duration: 22, mobileDuration: 10, priority: 4, cooldown: 0.18 },
  landing: { strong: 0.3, weak: 0.18, duration: 30, mobileDuration: 14, priority: 5, cooldown: 0.22 },
  'collision-light': { strong: 0.26, weak: 0.18, duration: 28, mobileDuration: 12, priority: 5, cooldown: 0.2 },
  'collision-heavy': { strong: 0.55, weak: 0.25, duration: 52, mobileDuration: 20, priority: 7, cooldown: 0.28 },
  warning: { strong: 0.12, weak: 0.3, duration: 20, mobileDuration: 10, priority: 3, cooldown: 0.9 },
  defeat: { strong: 0.68, weak: 0.28, duration: 68, mobileDuration: 20, priority: 9, cooldown: 0.8 },
  medal: { strong: 0.34, weak: 0.54, duration: 54, mobileDuration: 18, priority: 8, cooldown: 1 },
};

/** Coordinates short phone and controller haptics without continuous rumble. */
export class Haptics {
  private enabledValue = loadEnabled();
  private priority = -1;
  private priorityUntil = 0;
  private readonly lastCueAt = new Map<HapticCue, number>();
  private cueCount = 0;
  private lastCue: HapticCue | '' = '';

  constructor(
    private readonly gamepad: GamepadInput,
    private readonly mobileEnabled: () => boolean,
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
    if (!enabled) this.stop();
  }

  cue(cue: HapticCue, scale = 1): boolean {
    if (!this.enabledValue || document.hidden) return false;
    const profile = PROFILES[cue];
    const now = performance.now() / 1000;
    const previous = this.lastCueAt.get(cue) ?? -Infinity;
    if (now - previous < profile.cooldown) return false;
    if (now < this.priorityUntil && profile.priority < this.priority) return false;
    this.lastCueAt.set(cue, now);
    this.priority = profile.priority;
    this.priorityUntil = now + profile.duration / 1000;
    const amount = Math.max(0, Math.min(1, scale));
    const gamepadPlayed = this.gamepad.rumble(profile.strong * amount, profile.weak * amount, profile.duration);
    let mobilePlayed = false;
    if (this.mobileEnabled() && typeof navigator.vibrate === 'function') {
      mobilePlayed = navigator.vibrate(Math.max(1, Math.round(profile.mobileDuration * amount)));
    }
    if (gamepadPlayed || mobilePlayed) {
      this.cueCount++;
      this.lastCue = cue;
      return true;
    }
    return false;
  }

  stop(): void {
    this.gamepad.stopRumble();
    if (typeof navigator.vibrate === 'function') navigator.vibrate(0);
    this.priority = -1;
    this.priorityUntil = 0;
  }

  status(): Record<string, number | string | boolean> {
    return {
      enabled: this.enabledValue,
      cueCount: this.cueCount,
      lastCue: this.lastCue,
    };
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
