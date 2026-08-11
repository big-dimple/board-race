import type { BoatInput } from '../contracts';
import './mobileControls.css';

type ControlMode = 'tilt' | 'touch';
type PointerAction = 'left' | 'right' | 'drift';

const ZERO: BoatInput = {
  throttle: 0,
  steer: 0,
  drift: false,
  flightTrigger: false,
  airBrake: false,
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Landscape mobile controls: tilt steering plus two large contextual action zones. */
export class MobileControls {
  readonly enabled: boolean;

  private readonly root: HTMLDivElement | null;
  private readonly start: HTMLButtonElement | null;
  private readonly modeButton: HTMLButtonElement | null;
  private readonly driftLabel: HTMLSpanElement | null;
  private readonly tiltMeter: HTMLDivElement | null;
  private readonly onFirstGesture: () => void;
  private readonly activePointers = new Map<number, PointerAction>();

  private mode: ControlMode = 'tilt';
  private racing = false;
  private activated = false;
  private permissionPending = false;
  private sensorSeenAt = 0;
  private sensorStartedAt = 0;
  private calibration: number | null = null;
  private rawTilt = 0;
  private filteredTilt = 0;
  private touchSteer = 0;
  private flightQueued = false;
  private anyPressQueued = false;

  get ready(): boolean {
    return !this.enabled || this.activated;
  }

  constructor(parent: HTMLElement, onFirstGesture: () => void, force = false) {
    this.enabled = force || navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
    this.onFirstGesture = onFirstGesture;
    if (!this.enabled) {
      this.root = null;
      this.start = null;
      this.modeButton = null;
      this.driftLabel = null;
      this.tiltMeter = null;
      return;
    }

    const root = document.createElement('div');
    root.className = 'mobile-controls';
    root.innerHTML = `
      <div class="mobile-orientation" role="status">
        <div class="mobile-rotate-icon" aria-hidden="true">↻</div>
        <strong>请横屏</strong>
      </div>
      <button class="mobile-start" type="button">开启重力转向</button>
      <button class="mobile-mode" type="button" aria-label="切换转向方式">重力</button>
      <div class="mobile-tilt-meter" aria-hidden="true"><i></i></div>
      <div class="mobile-steer-zones" aria-hidden="true">
        <button type="button" data-mobile-action="left" aria-label="左转">‹</button>
        <button type="button" data-mobile-action="right" aria-label="右转">›</button>
      </div>
      <div class="mobile-action-zones">
        <button type="button" data-mobile-action="drift"><span>漂</span></button>
        <button type="button" data-mobile-action="flight"><span>飞</span></button>
      </div>
    `;
    parent.appendChild(root);
    this.root = root;
    this.start = root.querySelector<HTMLButtonElement>('.mobile-start');
    this.modeButton = root.querySelector<HTMLButtonElement>('.mobile-mode');
    this.driftLabel = root.querySelector<HTMLSpanElement>('[data-mobile-action="drift"] span');
    this.tiltMeter = root.querySelector<HTMLDivElement>('.mobile-tilt-meter i');

    this.start?.addEventListener('click', () => void this.activateTilt());
    this.modeButton?.addEventListener('click', () => {
      this.onFirstGesture();
      if (this.mode === 'touch') void this.activateTilt();
      else this.useTouch();
    });

    root.querySelectorAll<HTMLButtonElement>('[data-mobile-action]').forEach((button) => {
      button.addEventListener('pointerdown', (event) => this.pointerDown(event, button));
      button.addEventListener('pointerup', (event) => this.pointerUp(event));
      button.addEventListener('pointercancel', (event) => this.pointerUp(event));
      button.addEventListener('lostpointercapture', (event) => this.pointerUp(event));
      button.addEventListener('contextmenu', (event) => event.preventDefault());
    });

    window.addEventListener('deviceorientation', (event) => this.orientation(event), { passive: true });
    window.addEventListener('orientationchange', () => this.recalibrate());
    screen.orientation?.addEventListener?.('change', () => this.recalibrate());
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    window.addEventListener('pointerdown', () => {
      this.anyPressQueued = true;
      this.onFirstGesture();
    }, { passive: true });

    const orientationType = (window as unknown as { DeviceOrientationEvent?: {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    } }).DeviceOrientationEvent;
    if (!orientationType?.requestPermission) {
      if ('DeviceOrientationEvent' in window) {
        this.activated = true;
        this.sensorStartedAt = performance.now();
        this.syncMode();
      } else {
        this.useTouch();
      }
    }
  }

  setRacing(racing: boolean): void {
    this.racing = racing;
    this.root?.classList.toggle('racing', racing);
    if (!racing) this.releaseAll();
  }

  read(dt: number, flightActive: boolean): BoatInput {
    if (!this.enabled || !this.racing) return ZERO;
    if (this.mode === 'tilt' && this.activated && this.sensorStartedAt > 0 &&
        performance.now() - this.sensorStartedAt > 1200 && this.sensorSeenAt === 0) {
      this.useTouch();
    }

    const leftHeld = this.hasAction('left');
    const rightHeld = this.hasAction('right');
    const touchTarget = leftHeld === rightHeld ? 0 : leftHeld ? -1 : 1;
    this.touchSteer = approach(this.touchSteer, touchTarget, 8 * dt);

    const response = 1 - Math.exp(-dt / 0.12);
    this.filteredTilt += (this.rawTilt - this.filteredTilt) * response;
    const tiltDegrees = Math.abs(this.filteredTilt);
    const tiltMagnitude = clamp((tiltDegrees - 3) / (22 - 3), 0, 1);
    const tiltSteer = Math.sign(this.filteredTilt) * tiltMagnitude;
    const steer = this.mode === 'tilt' ? tiltSteer : this.touchSteer;
    if (this.tiltMeter) this.tiltMeter.style.transform = `translateX(${steer * 34}px)`;

    const action = this.hasAction('drift');
    const flightTrigger = this.flightQueued;
    this.flightQueued = false;
    if (this.driftLabel) this.driftLabel.textContent = flightActive ? '刹' : '漂';
    return {
      throttle: 1,
      steer,
      drift: action && !flightActive,
      flightTrigger,
      airBrake: action && flightActive,
    };
  }

  consumeAnyPress(): boolean {
    const pressed = this.anyPressQueued;
    this.anyPressQueued = false;
    return pressed;
  }

  setActionState(charge: number, flightReady: boolean, flightActive: boolean, turnWarning = false): void {
    if (!this.root) return;
    this.root.style.setProperty('--mobile-charge', String(clamp(charge, 0, 1)));
    this.root.classList.toggle('flight-ready', flightReady);
    this.root.classList.toggle('in-flight', flightActive);
    this.root.classList.toggle('turn-warning', turnWarning);
    if (this.driftLabel) this.driftLabel.textContent = flightActive ? '刹' : '漂';
  }

  reset(): void {
    this.releaseAll();
    this.flightQueued = false;
    this.anyPressQueued = false;
    this.touchSteer = 0;
    this.filteredTilt = 0;
  }

  private async activateTilt(): Promise<void> {
    if (this.permissionPending) return;
    this.onFirstGesture();
    this.permissionPending = true;
    try {
      const orientationType = (window as unknown as { DeviceOrientationEvent?: {
        requestPermission?: () => Promise<'granted' | 'denied'>;
      } }).DeviceOrientationEvent;
      if (orientationType?.requestPermission) {
        const permission = await orientationType.requestPermission();
        if (permission !== 'granted') {
          this.useTouch();
          return;
        }
      } else if (!('DeviceOrientationEvent' in window)) {
        this.useTouch();
        return;
      }
      this.mode = 'tilt';
      this.activated = true;
      this.sensorSeenAt = 0;
      this.sensorStartedAt = performance.now();
      this.recalibrate();
      this.syncMode();
      try {
        const orientation = screen.orientation as ScreenOrientation & {
          lock?: (orientation: 'landscape') => Promise<void>;
        };
        await orientation?.lock?.('landscape');
      } catch {
        // CSS keeps portrait devices blocked when orientation lock is unavailable.
      }
    } catch {
      this.useTouch();
    } finally {
      this.permissionPending = false;
    }
  }

  private useTouch(): void {
    this.mode = 'touch';
    this.activated = true;
    this.syncMode();
  }

  private syncMode(): void {
    this.root?.classList.toggle('touch-steer', this.mode === 'touch');
    this.root?.classList.add('activated');
    if (this.modeButton) this.modeButton.textContent = this.mode === 'tilt' ? '重力' : '触控';
    if (this.start) this.start.hidden = true;
  }

  private orientation(event: DeviceOrientationEvent): void {
    if (!this.activated || this.mode !== 'tilt') return;
    const angle = ((screen.orientation?.angle ?? window.orientation ?? 0) + 360) % 360;
    const beta = event.beta;
    const gamma = event.gamma;
    let lateral: number | null = null;
    if (angle === 90 && beta !== null) lateral = beta;
    else if (angle === 270 && beta !== null) lateral = -beta;
    else if (angle === 180 && gamma !== null) lateral = -gamma;
    else if (gamma !== null) lateral = gamma;
    if (lateral === null || !Number.isFinite(lateral)) return;
    this.sensorSeenAt = performance.now();
    if (this.calibration === null) {
      this.calibration = lateral;
      this.rawTilt = 0;
      this.filteredTilt = 0;
      return;
    }
    this.rawTilt = clamp(lateral - this.calibration, -32, 32);
  }

  private recalibrate(): void {
    this.calibration = null;
    this.rawTilt = 0;
    this.filteredTilt = 0;
  }

  private pointerDown(event: PointerEvent, button: HTMLButtonElement): void {
    this.onFirstGesture();
    this.anyPressQueued = true;
    if (!this.racing) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    const action = button.dataset.mobileAction;
    if (action === 'flight') {
      this.flightQueued = true;
      button.classList.add('held');
      return;
    }
    if (action === 'left' || action === 'right' || action === 'drift') {
      this.activePointers.set(event.pointerId, action);
      button.classList.add('held');
    }
  }

  private pointerUp(event: PointerEvent): void {
    const action = this.activePointers.get(event.pointerId);
    this.activePointers.delete(event.pointerId);
    const target = event.currentTarget;
    if (target instanceof HTMLButtonElement) target.classList.remove('held');
    if (action === undefined && target instanceof HTMLButtonElement &&
        target.dataset.mobileAction === 'flight') target.classList.remove('held');
  }

  private hasAction(action: PointerAction): boolean {
    for (const value of this.activePointers.values()) if (value === action) return true;
    return false;
  }

  private releaseAll(): void {
    this.activePointers.clear();
    this.root?.querySelectorAll('.held').forEach((element) => element.classList.remove('held'));
    this.touchSteer = 0;
  }
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return current;
}
