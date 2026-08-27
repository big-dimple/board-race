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

interface PadBindingProfile {
  /** Kept per physical pad so one seat can never inherit the other's mapping. */
  steerAxis: number | null;
  throttleAxis: number | null;
  steerScale: -1 | 1;
  throttleScale: -1 | 1;
  steerLeftButton: number | null;
  steerRightButton: number | null;
  driftButton: number;
  flightButton: number;
  supportButton: number;
  prankButton: number;
  source: 'standard' | 'custom' | 'fallback';
}

export interface LocalDeviceStatus {
  id: LocalDeviceId;
  connected: boolean;
  kind: 'keyboard' | 'gamepad';
  mappingSource: 'keyboard' | PadBindingProfile['source'];
  steerAxis: number;
  throttleAxis: number;
  stickX: number;
  stickY: number;
}

export interface LocalBoatInputContext {
  flightActive: boolean;
  manualThrottle: boolean;
  /** Keep the arcade auto-forward baseline while allowing stick-down braking. */
  autoForward?: boolean;
}

export interface LocalInteractionEdges {
  support: boolean;
  prank: boolean;
}

interface PadState {
  info: LocalDeviceInfo;
  pad: Gamepad;
  current: PadSnapshot;
  previous: PadSnapshot;
  binding: PadBindingProfile;
  /** Browser Gamepad objects can change shape after connection. */
  bindingSignature: string;
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
/**
 * A hand resting on a stick rarely returns with a mathematically perfect
 * zero on the Y axis.  Below this intent threshold we keep the arcade
 * auto-forward baseline; a deliberate brake still has the full range above
 * it.  This is applied after the radial dead-zone, so diagonal steering keeps
 * its two-dimensional authority.
 */
const PAD_THROTTLE_NEUTRAL_ZONE = 0.12;
const PAD_NAV_THRESHOLD = 0.62;
const PAD_DIAGONAL_COMPONENT = 0.32;
const GAMEPAD_STORAGE_KEY = 'board-race.gamepad.v1';
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
      let bindingChanged = false;
      if (!state || state.pad.id !== pad.id) {
        if (state) stopPadRumble(state.pad);
        const current = emptyPadSnapshot(pad);
        fillSnapshot(current, pad);
        state = {
          info: {
            id: `gamepad:${pad.index}`,
            label: compactPadLabel(pad.id, pad.index),
            kind: 'gamepad',
            connected: true,
          },
          pad,
          current,
          // A controller can be connected while a face button is held.  That
          // is a hold, not a newly-created flight/support edge; require a
          // release and press after the device is observed by this adapter.
          // Axes keep a neutral baseline so the same first left/right gesture
          // can still seat a controller when the browser exposes it late.
          previous: initialPreviousSnapshot(current),
          binding: resolvePadBinding(pad),
          bindingSignature: deviceSignature(pad),
          seenAt: serial,
        };
        this.pads.set(pad.index, state);
      } else {
        copySnapshot(state.previous, state.current);
        state.pad = pad;
        // A browser can update mapping, axes, or button counts after
        // connection. Re-resolve only that pad; never let the other seat
        // inherit a stale profile. Keep the currently held buttons as holds,
        // rather than manufacturing a flight/action edge during remapping.
        const nextBindingSignature = deviceSignature(pad);
        if (state.bindingSignature !== nextBindingSignature) {
          state.binding = resolvePadBinding(pad);
          state.bindingSignature = nextBindingSignature;
          bindingChanged = true;
        }
        state.seenAt = serial;
      }
      fillSnapshot(state.current, pad);
      // A remapped pad may already report a pressed button. Sync the edge
      // baseline so a browser metadata update cannot fire flight/support on
      // its own; the next physical press still produces a normal edge.
      if (bindingChanged) copySnapshot(state.previous, state.current);
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

  deviceStatus(id: LocalDeviceId): LocalDeviceStatus {
    if (id === 'keyboard-left' || id === 'keyboard-right') {
      return {
        id,
        connected: true,
        kind: 'keyboard',
        mappingSource: 'keyboard',
        steerAxis: -1,
        throttleAxis: -1,
        stickX: 0,
        stickY: 0,
      };
    }
    const state = this.pads.get(gamepadIndex(id));
    const stick = state ? readStick(state) : { x: 0, y: 0 };
    return {
      id,
      connected: Boolean(state),
      kind: 'gamepad',
      mappingSource: state?.binding.source ?? 'fallback',
      steerAxis: state?.binding.steerAxis ?? -1,
      throttleAxis: state?.binding.throttleAxis ?? -1,
      stickX: stick.x,
      stickY: stick.y,
    };
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
      confirm: padButtonEdge(state, state.binding.flightButton),
      cancel: padButtonEdge(state, state.binding.supportButton),
      pause: padButtonEdge(state, 9),
    };
  }

  /** Actions available to a player whose boat has been eliminated. */
  interactionEdges(id: LocalDeviceId): LocalInteractionEdges {
    if (id === 'keyboard-left') {
      return {
        support: this.consumeAny(['KeyQ']),
        prank: this.consumeAny(['KeyE']),
      };
    }
    if (id === 'keyboard-right') {
      return {
        support: this.consumeAny(['KeyU']),
        prank: this.consumeAny(['KeyO']),
      };
    }
    const state = this.pads.get(gamepadIndex(id));
    if (!state) return { support: false, prank: false };
    // Standard mapping: B = support, Y = playful interference. A calibrated
    // non-standard pad keeps its own action buttons instead of borrowing the
    // last pad's edges.
    return {
      support: padButtonEdge(state, state.binding.supportButton),
      prank: padButtonEdge(state, state.binding.prankButton),
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
    return state
      ? padButtonEdge(state, state.binding.flightButton) || padButtonEdge(state, 9)
      : false;
  }

  cancelEdge(id: LocalDeviceId): boolean {
    if (id === 'keyboard-left') return this.consumeAny(['KeyQ']);
    if (id === 'keyboard-right') return this.consumeAny(['NumpadDecimal', 'KeyU']);
    const state = this.pads.get(gamepadIndex(id));
    return state ? padButtonEdge(state, state.binding.supportButton) : false;
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
    let throttle = context.manualThrottle ? (context.autoForward ? 1 : 0) : 1;

    if (id === 'keyboard-left') {
      left = this.keys.has('KeyA');
      right = this.keys.has('KeyD');
      drift = this.keys.has('ShiftLeft');
      flightTrigger = this.consumeAny(['Space']);
      if (context.manualThrottle) {
        const keyboardThrottle = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
        throttle = context.autoForward && keyboardThrottle === 0 ? 1 : keyboardThrottle;
      }
    } else if (id === 'keyboard-right') {
      left = this.keys.has('ArrowLeft') || this.keys.has('KeyJ');
      right = this.keys.has('ArrowRight') || this.keys.has('KeyL');
      drift = this.keys.has('Numpad0') || this.keys.has('KeyK') || this.keys.has('ShiftRight');
      flightTrigger = this.consumeAny(['NumpadEnter', 'KeyI']);
      if (context.manualThrottle) {
        const keyboardThrottle = (this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('ArrowDown') ? 1 : 0);
        throttle = context.autoForward && keyboardThrottle === 0 ? 1 : keyboardThrottle;
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
      const stick = readStick(state);
      const digital = (buttonPressed(state.current, state.binding.steerRightButton) ? 1 : 0) -
        (buttonPressed(state.current, state.binding.steerLeftButton) ? 1 : 0);
      rawSteer = Math.abs(stick.x) >= Math.abs(digital) ? stick.x : digital;
      drift = Boolean(state.current.buttons[state.binding.driftButton]) ||
        ((state.binding.source === 'standard' || state.binding.source === 'fallback') &&
          (Boolean(state.current.buttons[4]) || Boolean(state.current.buttons[5])));
      flightTrigger = padButtonEdge(state, state.binding.flightButton);
      if (context.manualThrottle) {
        const stickThrottle = stick.y;
        const dpadThrottle = (state.current.buttons[12] ? 1 : 0) - (state.current.buttons[13] ? 1 : 0);
        // Co-op movement is one left-stick vector: X steers, Y drives/reverses.
        // The D-pad remains a digital fallback for pads without a usable stick.
        const vectorThrottle = Math.abs(stickThrottle) >= Math.abs(dpadThrottle) ? stickThrottle : dpadThrottle;
        // Neutral is the arcade auto-forward baseline. Any deliberate
        // downward vector takes precedence and brakes/reverses continuously.
        throttle = context.autoForward && Math.abs(vectorThrottle) < PAD_THROTTLE_NEUTRAL_ZONE ? 1 : vectorThrottle;
      }
    }

    const target = rawSteer || (left ? -1 : right ? 1 : 0);
    const previous = this.steerValues.get(id) ?? 0;
    // Analog input is already filtered by the radial dead-zone. Applying the
    // keyboard-oriented seven-unit ramp here made the right seat feel late
    // and caused a diagonal to undershoot. Keep a tiny bounded slew only for
    // digital keys; gamepads follow the stick immediately.
    const isGamepad = id.startsWith('gamepad:');
    const steer = isGamepad ? target : approach(previous, target, 7 * dt);
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
    const value = Number(button?.value);
    target.buttons[i] = Boolean(button?.pressed) || (Number.isFinite(value) && value > 0.6);
  }
  for (let i = 0; i < pad.axes.length; i++) target.axes[i] = clampSigned(Number(pad.axes[i]));
}

function copySnapshot(target: PadSnapshot, source: PadSnapshot): void {
  target.buttons.length = source.buttons.length;
  target.axes.length = source.axes.length;
  for (let i = 0; i < source.buttons.length; i++) target.buttons[i] = source.buttons[i];
  for (let i = 0; i < source.axes.length; i++) target.axes[i] = source.axes[i];
}

function initialPreviousSnapshot(source: PadSnapshot): PadSnapshot {
  return { buttons: source.buttons.slice(), axes: new Array(source.axes.length).fill(0) };
}

function padButtonEdge(state: PadState, index: number | null): boolean {
  return buttonPressed(state.current, index) && !buttonPressed(state.previous, index);
}

function padDirectionEdge(state: PadState, direction: -1 | 1): boolean {
  // A diagonal is still a horizontal menu choice. Classify the full vector so
  // up-left/down-left cannot be lost when the vertical axis moves first.
  const current = padHorizontalDirection(state.current, state.binding);
  const previous = padHorizontalDirection(state.previous, state.binding);
  return current === direction && previous !== direction;
}

function padHorizontalDirection(snapshot: PadSnapshot, binding: PadBindingProfile): -1 | 0 | 1 {
  const axis = (binding.steerAxis === null ? 0 : snapshot.axes[binding.steerAxis] ?? 0) * binding.steerScale;
  const vertical = (binding.throttleAxis === null ? 0 : snapshot.axes[binding.throttleAxis] ?? 0) * binding.throttleScale;
  // A steep diagonal can expose only ~0.5 on X. Once the whole stick vector
  // is intentionally deflected, keep its horizontal sign for seat selection;
  // a small accidental nudge still stays neutral.
  if (Math.hypot(axis, vertical) >= PAD_NAV_THRESHOLD && Math.abs(axis) >= PAD_DIAGONAL_COMPONENT) {
    return axis < 0 ? -1 : 1;
  }
  const left = buttonPressed(snapshot, binding.steerLeftButton);
  const right = buttonPressed(snapshot, binding.steerRightButton);
  if (left && !right) return -1;
  if (right && !left) return 1;
  return 0;
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

function resolvePadBinding(pad: Gamepad): PadBindingProfile {
  if (pad.mapping !== 'standard') {
    const stored = loadStoredBindings(deviceSignature(pad));
    if (stored) {
      // Older single-player calibration records may contain only the action
      // buttons. Missing axis fields must keep the normal two-axis fallback;
      // an explicit null still means a deliberate d-pad-only calibration.
      const steerAxis = stored.steerAxis === undefined
        ? defaultSteerAxis(pad.axes.length)
        : validAxis(stored.steerAxis, pad.axes.length);
      const throttleAxis = stored.throttleAxis === undefined
        ? (steerAxis === null ? defaultThrottleAxis(pad.axes.length) : pairedThrottleAxis(steerAxis, pad.axes.length))
        : stored.throttleAxis === null
          ? null
          : validAxis(stored.throttleAxis, pad.axes.length) ??
            (steerAxis === null ? defaultThrottleAxis(pad.axes.length) : pairedThrottleAxis(steerAxis, pad.axes.length));
      return {
        steerAxis,
        throttleAxis,
        steerScale: stored.steerScale === -1 ? -1 : 1,
        throttleScale: stored.throttleScale === 1 ? 1 : -1,
        steerLeftButton: validButton(stored.steerLeftButton, pad.buttons.length) ?? 14,
        steerRightButton: validButton(stored.steerRightButton, pad.buttons.length) ?? 15,
        driftButton: validButton(stored.driftButton, pad.buttons.length) ?? 2,
        flightButton: validButton(stored.flightButton, pad.buttons.length) ?? 0,
        supportButton: validButton(stored.supportButton, pad.buttons.length) ?? 1,
        prankButton: validButton(stored.prankButton, pad.buttons.length) ?? 3,
        source: 'custom',
      };
    }
  }
  // Unknown mappings get an isolated conservative fallback and are surfaced
  // in diagnostics rather than silently borrowing another seat's state.
  return {
    steerAxis: 0,
    throttleAxis: 1,
    steerScale: 1,
    throttleScale: -1,
    steerLeftButton: 14,
    steerRightButton: 15,
    driftButton: 2,
    flightButton: 0,
    supportButton: 1,
    prankButton: 3,
    source: pad.mapping === 'standard' ? 'standard' : 'fallback',
  };
}

interface StoredPadBindings {
  steerAxis?: number | null;
  throttleAxis?: number | null;
  steerScale?: -1 | 1;
  throttleScale?: -1 | 1;
  steerLeftButton?: number | null;
  steerRightButton?: number | null;
  driftButton?: number;
  flightButton?: number;
  supportButton?: number;
  prankButton?: number;
}

function deviceSignature(pad: Gamepad): string {
  return `${pad.id}|${pad.mapping}|a${pad.axes.length}|b${pad.buttons.length}`;
}

function loadStoredBindings(signature: string): StoredPadBindings | null {
  try {
    const raw = localStorage.getItem(GAMEPAD_STORAGE_KEY);
    if (!raw) return null;
    const stored = (JSON.parse(raw) as Record<string, StoredPadBindings>)[signature];
    if (!stored || typeof stored !== 'object') return null;
    // Older single-player calibrations only stored the drift/flight pair.
    // Missing fields intentionally fall back to this pad's standard layout.
    if (stored.driftButton !== undefined && !Number.isFinite(stored.driftButton)) return null;
    if (stored.flightButton !== undefined && !Number.isFinite(stored.flightButton)) return null;
    return stored;
  } catch {
    return null;
  }
}

function pairedThrottleAxis(steerAxis: number, axisCount: number): number | null {
  const candidate = steerAxis % 2 === 0 ? steerAxis + 1 : steerAxis - 1;
  return candidate >= 0 && candidate < axisCount ? candidate : defaultThrottleAxis(axisCount);
}

function readStick(state: PadState): { x: number; y: number } {
  const binding = state.binding;
  const rawX = clampSigned((binding.steerAxis === null ? 0 : state.current.axes[binding.steerAxis] ?? 0) * binding.steerScale);
  const rawY = clampSigned((binding.throttleAxis === null ? 0 : state.current.axes[binding.throttleAxis] ?? 0) * binding.throttleScale);
  // Apply one radial dead-zone to the complete vector. Per-axis dead-zones
  // distort diagonals and were the main source of inaccurate right-seat turns.
  const magnitude = Math.hypot(rawX, rawY);
  if (magnitude <= PAD_DEAD_ZONE) return { x: 0, y: 0 };
  const normalized = Math.min(1, (magnitude - PAD_DEAD_ZONE) / (1 - PAD_DEAD_ZONE));
  const scale = normalized / Math.max(magnitude, 1e-6);
  return { x: clampSigned(rawX * scale), y: clampSigned(rawY * scale) };
}

function buttonPressed(snapshot: PadSnapshot, index: number | null): boolean {
  return index !== null && index >= 0 && Boolean(snapshot.buttons[index]);
}

function validAxis(value: number | null | undefined, count: number): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < count ? value : null;
}

function validButton(value: number | null | undefined, count: number): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < count ? value : null;
}

function defaultThrottleAxis(axisCount: number): number | null {
  return axisCount > 1 ? 1 : null;
}

function defaultSteerAxis(axisCount: number): number | null {
  return axisCount > 0 ? 0 : null;
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
    'KeyJ', 'KeyL', 'KeyK', 'KeyI', 'KeyU', 'KeyE', 'KeyO', 'Escape',
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
