import type { BoatInput } from '../contracts';

type GamepadProvider = () => readonly (Gamepad | null)[];
const EMPTY_GAMEPADS: readonly (Gamepad | null)[] = [];

const ZERO: BoatInput = {
  throttle: 1,
  steer: 0,
  drift: false,
  flightTrigger: false,
  airBrake: false,
};

const DEAD_ZONE = 0.18;
const NAV_THRESHOLD = 0.62;

/** Standard-mapped controller adapter. It never owns vehicle physics. */
export class GamepadInput {
  private readonly provider: GamepadProvider;
  private pad: Gamepad | null = null;
  private previousButtons: boolean[] = [];
  private previousNavLeft = false;
  private previousNavRight = false;
  private baselinePending = true;
  private suppressActionsUntilRelease = false;
  private steer = 0;
  private steerActive = false;
  private driftHeld = false;
  private flightPressed = false;
  private confirmPressed = false;
  private selectLeftPressed = false;
  private selectRightPressed = false;

  constructor(provider: GamepadProvider = () => navigator.getGamepads?.() ?? EMPTY_GAMEPADS) {
    this.provider = provider;
    window.addEventListener('gamepaddisconnected', () => this.clearDisconnected());
    window.addEventListener('blur', () => this.reset());
  }

  get connected(): boolean {
    return this.pad !== null;
  }

  poll(): void {
    let pads: readonly (Gamepad | null)[];
    try {
      pads = this.provider();
    } catch {
      this.clearDisconnected();
      return;
    }
    const current = this.pickPad(pads);
    if (!current) {
      this.clearDisconnected();
      return;
    }

    const changedPad = !this.pad || current.index !== this.pad.index || current.id !== this.pad.id;
    this.pad = current;
    const pressed = (index: number): boolean => {
      const button = current.buttons[index];
      return Boolean(button && (button.pressed || button.value > 0.55));
    };
    const dpadLeft = pressed(14);
    const dpadRight = pressed(15);
    const analog = deadZone(current.axes[0] ?? 0);
    this.steer = dpadLeft === dpadRight ? analog : dpadLeft ? -1 : 1;
    this.steerActive = dpadLeft || dpadRight || Math.abs(analog) > 0;
    const navLeft = dpadLeft || analog <= -NAV_THRESHOLD;
    const navRight = dpadRight || analog >= NAV_THRESHOLD;
    const drift = pressed(2) || pressed(4) || pressed(5);
    const flight = pressed(0);
    const confirm = flight || pressed(9);

    if (changedPad || this.baselinePending) {
      this.captureButtons(current);
      this.previousNavLeft = navLeft;
      this.previousNavRight = navRight;
      this.baselinePending = false;
      this.clearEdges();
    } else {
      this.flightPressed = flight && !this.previousButtons[0];
      this.confirmPressed = confirm && !(this.previousButtons[0] || this.previousButtons[9]);
      this.selectLeftPressed = navLeft && !this.previousNavLeft;
      this.selectRightPressed = navRight && !this.previousNavRight;
      this.captureButtons(current);
      this.previousNavLeft = navLeft;
      this.previousNavRight = navRight;
    }

    if (this.suppressActionsUntilRelease && !drift && !flight) this.suppressActionsUntilRelease = false;
    this.driftHeld = !this.suppressActionsUntilRelease && drift;
    if (this.suppressActionsUntilRelease) {
      this.flightPressed = false;
      this.confirmPressed = false;
    }
  }

  read(flightActive: boolean): BoatInput {
    const flightTrigger = this.flightPressed;
    this.flightPressed = false;
    return {
      throttle: 1,
      steer: this.steer,
      drift: this.driftHeld && !flightActive,
      flightTrigger,
      airBrake: this.driftHeld && flightActive,
    };
  }

  steeringHeld(): boolean {
    return this.steerActive;
  }

  consumeConfirm(): boolean {
    const value = this.confirmPressed;
    this.confirmPressed = false;
    return value;
  }

  consumeSelectLeft(): boolean {
    const value = this.selectLeftPressed;
    this.selectLeftPressed = false;
    return value;
  }

  consumeSelectRight(): boolean {
    const value = this.selectRightPressed;
    this.selectRightPressed = false;
    return value;
  }

  consumeFlight(): boolean {
    const value = this.flightPressed;
    this.flightPressed = false;
    return value;
  }

  reset(): void {
    this.clearEdges();
    this.steer = 0;
    this.steerActive = false;
    this.driftHeld = false;
    this.baselinePending = true;
    this.suppressActionsUntilRelease = true;
  }

  clearTransient(): void {
    this.clearEdges();
  }

  pulse(strength: number, durationMs: number): void {
    const actuator = (this.pad as Gamepad & { vibrationActuator?: {
      playEffect?: (type: string, options: Record<string, number>) => Promise<unknown>;
    } } | null)?.vibrationActuator;
    if (!actuator?.playEffect || document.hidden) return;
    void actuator.playEffect('dual-rumble', {
      duration: Math.max(20, Math.min(160, durationMs)),
      strongMagnitude: Math.max(0, Math.min(1, strength)),
      weakMagnitude: Math.max(0, Math.min(1, strength * 0.65)),
    }).catch(() => undefined);
  }

  status(): Record<string, number | string | boolean> {
    return {
      connected: this.connected,
      id: this.pad?.id ?? '',
      index: this.pad?.index ?? -1,
      mapping: this.pad?.mapping ?? '',
      steer: this.steer,
      drift: this.driftHeld,
    };
  }

  private pickPad(pads: readonly (Gamepad | null)[]): Gamepad | null {
    if (this.pad) {
      const existing = pads[this.pad.index];
      if (existing?.connected) return existing;
    }
    for (const candidate of pads) if (candidate?.connected) return candidate;
    return null;
  }

  private captureButtons(pad: Gamepad): void {
    this.previousButtons.length = pad.buttons.length;
    for (let i = 0; i < pad.buttons.length; i++) {
      const button = pad.buttons[i];
      this.previousButtons[i] = button.pressed || button.value > 0.55;
    }
  }

  private clearDisconnected(): void {
    this.pad = null;
    this.previousButtons = [];
    this.previousNavLeft = false;
    this.previousNavRight = false;
    this.baselinePending = true;
    this.suppressActionsUntilRelease = false;
    this.steer = 0;
    this.steerActive = false;
    this.driftHeld = false;
    this.clearEdges();
  }

  private clearEdges(): void {
    this.flightPressed = false;
    this.confirmPressed = false;
    this.selectLeftPressed = false;
    this.selectRightPressed = false;
  }
}

function deadZone(raw: number): number {
  const value = Math.max(-1, Math.min(1, raw));
  const magnitude = Math.abs(value);
  if (magnitude <= DEAD_ZONE) return 0;
  return Math.sign(value) * (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE);
}
