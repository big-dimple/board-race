import type { BoatInput } from '../contracts';

export type SeatSide = 'left' | 'right';
export type KeyboardDeviceId = 'keyboard-left' | 'keyboard-right';
export type LocalDeviceId = KeyboardDeviceId | `gamepad:${number}`;

export interface LocalDeviceInfo {
  id: LocalDeviceId;
  label: string;
  kind: 'keyboard' | 'gamepad';
  connected: boolean;
}

export interface LocalMenuEdges {
  left: boolean;
  right: boolean;
  confirm: boolean;
  cancel: boolean;
  pause: boolean;
}

interface PadSnapshot {
  buttons: boolean[];
  axes: number[];
}

export interface LocalBoatInputContext {
  flightActive: boolean;
  manualThrottle: boolean;
}

interface PadState {
  info: LocalDeviceInfo;
  pad: Gamepad;
  current: PadSnapshot;
  previous: PadSnapshot;
  seenAt: number;
}

const ZERO_EDGES: LocalMenuEdges = {
  left: false,
  right: false,
  confirm: false,
  cancel: false,
  pause: false,
};

const PAD_DEAD_ZONE = 0.18;
const PAD_NAV_THRESHOLD = 0.62;
const KEYBOARD_LEFT: LocalDeviceInfo = {
  id: 'keyboard-left',
  label: '键盘 · W A S D',
  kind: 'keyboard',
  connected: true,
};
const KEYBOARD_RIGHT: LocalDeviceInfo = {
  id: 'keyboard-right',
  label: '键盘 · 方向键',
  kind: 'keyboard',
  connected: true,
};

type GamepadProvider = () => readonly (Gamepad | null)[];

/**
 * Device-oriented local input. Keyboard zones and every physical gamepad stay
 * independent until a seat explicitly owns one of them.
 */
export class LocalMultiplayerInput {
  private readonly provider: GamepadProvider;
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly pads = new Map<number, PadState>();
  private readonly steerValues = new Map<LocalDeviceId, number>();
  private readonly boatOutputs = new Map<LocalDeviceId, BoatInput>();
  private pollSerial = 0;

  constructor(
    target: Window = window,
    provider: GamepadProvider = () => navigator.getGamepads?.() ?? [],
  ) {
    this.provider = provider;
    target.addEventListener('keydown', (event) => {
      const wasHeld = this.keys.has(event.code);
      this.keys.add(event.code);
      if (!event.repeat && !wasHeld) this.pressed.add(event.code);
      if (isOwnedKey(event.code)) event.preventDefault();
    });
    target.addEventListener('keyup', (event) => this.keys.delete(event.code));
    target.addEventListener('blur', () => this.reset());
    target.addEventListener('gamepaddisconnected', (event) => {
      const index = (event as GamepadEvent).gamepad.index;
      this.stopRumble(`gamepad:${index}`);
      this.pads.delete(index);
      this.steerValues.delete(`gamepad:${index}`);
      this.boatOutputs.delete(`gamepad:${index}`);
    });
  }

  poll(): void {
    let gamepads: readonly (Gamepad | null)[];
    try {
      gamepads = this.provider();
    } catch {
      gamepads = [];
    }
    const serial = ++this.pollSerial;
    for (const pad of gamepads) {
      if (!pad?.connected) continue;
      let state = this.pads.get(pad.index);
      if (!state || state.pad.id !== pad.id) {
        if (state) stopPadRumble(state.pad);
        state = {
          info: {
            id: `gamepad:${pad.index}`,
            label: compactPadLabel(pad.id, pad.index),
            kind: 'gamepad',
            connected: true,
          },
          pad,
          current: emptyPadSnapshot(pad),
          previous: emptyPadSnapshot(pad),
          seenAt: serial,
        };
        this.pads.set(pad.index, state);
      } else {
        copySnapshot(state.previous, state.current);
        state.pad = pad;
        state.seenAt = serial;
      }
      fillSnapshot(state.current, pad);
    }
    for (const [index, state] of this.pads) {
      if (state.seenAt === serial) continue;
      stopPadRumble(state.pad);
      this.pads.delete(index);
      this.steerValues.delete(`gamepad:${index}`);
      this.boatOutputs.delete(`gamepad:${index}`);
    }
  }

  devices(): readonly LocalDeviceInfo[] {
    return [KEYBOARD_LEFT, KEYBOARD_RIGHT, ...[...this.pads.values()].map((state) => state.info)];
  }

  connected(id: LocalDeviceId): boolean {
    if (id === 'keyboard-left' || id === 'keyboard-right') return true;
    return this.pads.has(gamepadIndex(id));
  }

  menuEdges(id: LocalDeviceId): LocalMenuEdges {
    if (id === 'keyboard-left') {
      return {
        left: this.consumeAny(['KeyA']),
        right: this.consumeAny(['KeyD']),
        confirm: this.consumeAny(['Space']),
        cancel: this.consumeAny(['KeyQ']),
        pause: this.consumeAny(['Escape']),
      };
    }
    if (id === 'keyboard-right') {
      return {
        left: this.consumeAny(['ArrowLeft', 'KeyJ']),
        right: this.consumeAny(['ArrowRight', 'KeyL']),
        confirm: this.consumeAny(['NumpadEnter', 'KeyI']),
        cancel: this.consumeAny(['NumpadDecimal', 'KeyU']),
        pause: this.consumeAny(['Escape']),
      };
    }
    const state = this.pads.get(gamepadIndex(id));
    if (!state) return ZERO_EDGES;
    return {
      left: padDirectionEdge(state, -1),
      right: padDirectionEdge(state, 1),
      confirm: padButtonEdge(state, 0),
      cancel: padButtonEdge(state, 1),
      pause: padButtonEdge(state, 9),
    };
  }

  pauseEdge(id: LocalDeviceId): boolean {
    if (id === 'keyboard-left' || id === 'keyboard-right') return this.consumeAny(['Escape']);
    const state = this.pads.get(gamepadIndex(id));
    return state ? padButtonEdge(state, 9) : false;
  }

  confirmEdge(id: LocalDeviceId): boolean {
    if (id === 'keyboard-left') return this.consumeAny(['Space']);
    if (id === 'keyboard-right') return this.consumeAny(['NumpadEnter', 'KeyI']);
    const state = this.pads.get(gamepadIndex(id));
    return state ? padButtonEdge(state, 0) : false;
  }

  cancelEdge(id: LocalDeviceId): boolean {
    if (id === 'keyboard-left') return this.consumeAny(['KeyQ']);
    if (id === 'keyboard-right') return this.consumeAny(['NumpadDecimal', 'KeyU']);
    const state = this.pads.get(gamepadIndex(id));
    return state ? padButtonEdge(state, 1) : false;
  }

  readBoat(id: LocalDeviceId, dt: number, context: LocalBoatInputContext): BoatInput {
    let output = this.boatOutputs.get(id);
    if (!output) {
      output = neutralBoatInput();
      this.boatOutputs.set(id, output);
    }
    let left = false;
    let right = false;
    let drift = false;
    let flightTrigger = false;
    let rawSteer = 0;
    let throttle = context.manualThrottle ? 0 : 1;

    if (id === 'keyboard-left') {
      left = this.keys.has('KeyA');
      right = this.keys.has('KeyD');
      drift = this.keys.has('ShiftLeft');
      flightTrigger = this.consumeAny(['Space']);
      if (context.manualThrottle) {
        throttle = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
      }
    } else if (id === 'keyboard-right') {
      left = this.keys.has('ArrowLeft') || this.keys.has('KeyJ');
      right = this.keys.has('ArrowRight') || this.keys.has('KeyL');
      drift = this.keys.has('Numpad0') || this.keys.has('KeyK') || this.keys.has('ShiftRight');
      flightTrigger = this.consumeAny(['NumpadEnter', 'KeyI']);
      if (context.manualThrottle) {
        throttle = (this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('ArrowDown') ? 1 : 0);
      }
    } else {
      const state = this.pads.get(gamepadIndex(id));
      if (!state) {
        output.throttle = 0;
        output.steer = 0;
        output.drift = false;
        output.flightTrigger = false;
        output.airBrake = false;
        return output;
      }
      const axis = deadZone(state.current.axes[0] ?? 0);
      const digital = (state.current.buttons[15] ? 1 : 0) - (state.current.buttons[14] ? 1 : 0);
      rawSteer = Math.abs(axis) >= Math.abs(digital) ? axis : digital;
      drift = Boolean(state.current.buttons[2]);
      flightTrigger = padButtonEdge(state, 0);
      if (context.manualThrottle) {
        const stickThrottle = -deadZone(state.current.axes[1] ?? 0);
        const dpadThrottle = (state.current.buttons[12] ? 1 : 0) - (state.current.buttons[13] ? 1 : 0);
        // Co-op movement is one left-stick vector: X steers, Y drives/reverses.
        // The D-pad remains a digital fallback for pads without a usable stick.
        throttle = strongestSigned(stickThrottle, dpadThrottle);
      }
    }

    const target = rawSteer || (left ? -1 : right ? 1 : 0);
    const previous = this.steerValues.get(id) ?? 0;
    const steer = approach(previous, target, 7 * dt);
    this.steerValues.set(id, steer);
    output.throttle = throttle;
    output.steer = steer;
    output.drift = drift && !context.flightActive;
    output.flightTrigger = flightTrigger;
    output.airBrake = drift && context.flightActive;
    return output;
  }

  reset(): void {
    this.keys.clear();
    this.pressed.clear();
    this.steerValues.clear();
    for (const output of this.boatOutputs.values()) Object.assign(output, neutralBoatInput());
    for (const state of this.pads.values()) {
      copySnapshot(state.previous, state.current);
      stopPadRumble(state.pad);
    }
  }

  endFrame(): void {
    this.pressed.clear();
  }

  rumble(id: LocalDeviceId, strong: number, weak: number, durationMs: number): boolean {
    if (!id.startsWith('gamepad:') || document.hidden) return false;
    const state = this.pads.get(gamepadIndex(id));
    const actuator = state ? padActuator(state.pad) : null;
    if (!actuator) return false;
    const duration = Math.max(8, Math.min(80, durationMs));
    const options = {
      duration,
      startDelay: 0,
      strongMagnitude: clamp01(strong),
      weakMagnitude: clamp01(weak),
    };
    if (actuator.playEffect) {
      void actuator.playEffect('dual-rumble', options).catch(() => undefined);
      return true;
    }
    if (actuator.pulse) {
      void actuator.pulse(Math.max(options.strongMagnitude, options.weakMagnitude), duration)
        .catch(() => undefined);
      return true;
    }
    return false;
  }

  private stopRumble(id: LocalDeviceId): void {
    if (!id.startsWith('gamepad:')) return;
    const state = this.pads.get(gamepadIndex(id));
    if (state) stopPadRumble(state.pad);
  }

  private consumeAny(codes: readonly string[]): boolean {
    let found = false;
    for (const code of codes) {
      if (!this.pressed.delete(code)) continue;
      found = true;
    }
    return found;
  }
}

interface HapticActuatorLike {
  playEffect?: (type: string, options: Record<string, number>) => Promise<unknown>;
  pulse?: (value: number, duration: number) => Promise<unknown>;
  reset?: () => Promise<unknown>;
}

function emptyPadSnapshot(pad: Gamepad): PadSnapshot {
  return {
    buttons: new Array(pad.buttons.length).fill(false),
    axes: new Array(pad.axes.length).fill(0),
  };
}

function fillSnapshot(target: PadSnapshot, pad: Gamepad): void {
  target.buttons.length = pad.buttons.length;
  target.axes.length = pad.axes.length;
  for (let i = 0; i < pad.buttons.length; i++) {
    const button = pad.buttons[i];
    target.buttons[i] = button.pressed || button.value > 0.6;
  }
  for (let i = 0; i < pad.axes.length; i++) target.axes[i] = pad.axes[i];
}

function copySnapshot(target: PadSnapshot, source: PadSnapshot): void {
  target.buttons.length = source.buttons.length;
  target.axes.length = source.axes.length;
  for (let i = 0; i < source.buttons.length; i++) target.buttons[i] = source.buttons[i];
  for (let i = 0; i < source.axes.length; i++) target.axes[i] = source.axes[i];
}

function padButtonEdge(state: PadState, index: number): boolean {
  return Boolean(state.current.buttons[index] && !state.previous.buttons[index]);
}

function padDirectionEdge(state: PadState, direction: -1 | 1): boolean {
  const currentAxis = state.current.axes[0] ?? 0;
  const previousAxis = state.previous.axes[0] ?? 0;
  const button = direction < 0 ? 14 : 15;
  const axisEdge = direction < 0
    ? currentAxis <= -PAD_NAV_THRESHOLD && previousAxis > -PAD_NAV_THRESHOLD
    : currentAxis >= PAD_NAV_THRESHOLD && previousAxis < PAD_NAV_THRESHOLD;
  return axisEdge || padButtonEdge(state, button);
}

function deadZone(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= PAD_DEAD_ZONE) return 0;
  return Math.sign(value) * Math.min(1, (magnitude - PAD_DEAD_ZONE) / (1 - PAD_DEAD_ZONE));
}

function neutralBoatInput(): BoatInput {
  return { throttle: 0, steer: 0, drift: false, flightTrigger: false, airBrake: false };
}

function gamepadIndex(id: LocalDeviceId): number {
  return Number.parseInt(id.slice('gamepad:'.length), 10);
}

function compactPadLabel(id: string, index: number): string {
  const compact = id.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return `手柄 ${index + 1} · ${compact.slice(0, 32) || 'Gamepad'}`;
}

function isOwnedKey(code: string): boolean {
  return [
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'Space', 'KeyQ',
    'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ShiftRight', 'Numpad0', 'NumpadEnter', 'NumpadDecimal',
    'KeyJ', 'KeyL', 'KeyK', 'KeyI', 'KeyU', 'Escape',
  ].includes(code);
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return current;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function strongestSigned(a: number, b: number): number {
  let strongest = a;
  if (Math.abs(b) > Math.abs(strongest)) strongest = b;
  return Math.max(-1, Math.min(1, strongest));
}

function padActuator(pad: Gamepad): HapticActuatorLike | null {
  const extended = pad as Gamepad & {
    vibrationActuator?: HapticActuatorLike;
    hapticActuators?: readonly HapticActuatorLike[];
  };
  return extended.vibrationActuator ?? extended.hapticActuators?.[0] ?? null;
}

function stopPadRumble(pad: Gamepad): void {
  const actuator = padActuator(pad);
  if (!actuator) return;
  if (actuator.reset) void actuator.reset().catch(() => undefined);
  else if (actuator.playEffect) {
    void actuator.playEffect('dual-rumble', {
      duration: 1,
      startDelay: 0,
      strongMagnitude: 0,
      weakMagnitude: 0,
    }).catch(() => undefined);
  } else if (actuator.pulse) void actuator.pulse(0, 1).catch(() => undefined);
}
