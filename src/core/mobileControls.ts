import type { BoatInput } from '../contracts';
import './mobileControls.css';

type ControlMode = 'tilt' | 'touch';
type ActivationState = 'idle' | 'requesting' | 'calibrating' | 'ready';
type PointerAction = 'left' | 'right' | 'drift' | 'flight';

const ZERO: BoatInput = {
  throttle: 0,
  steer: 0,
  drift: false,
  flightTrigger: false,
  airBrake: false,
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const CALIBRATION_MS = 300;
const SENSOR_TIMEOUT_MS = 1500;
const MIN_CALIBRATION_SAMPLES = 6;

/** Landscape mobile controls with a permission-gated, stable tilt calibration. */
export class MobileControls {
  readonly enabled: boolean;

  private readonly root: HTMLDivElement | null;
  private readonly start: HTMLButtonElement | null;
  private readonly modeButton: HTMLButtonElement | null;
  private readonly driftLabel: HTMLSpanElement | null;
  private readonly tiltMeter: HTMLDivElement | null;
  private readonly onFirstGesture: () => void;
  private readonly activePointers = new Map<number, PointerAction>();
  private readonly buttons = new Map<PointerAction, HTMLButtonElement>();

  private mode: ControlMode = 'tilt';
  private activation: ActivationState = 'idle';
  private racing = false;
  private permissionPending = false;
  private tiltAuthorized = false;
  private calibrationStartedAt = 0;
  private calibrationAngle = 0;
  private calibrationSamples: number[] = [];
  private calibrationTimer = 0;
  private calibration = 0;
  private rawTilt = 0;
  private filteredTilt = 0;
  private touchSteer = 0;
  private flightQueued = false;
  private anyPressQueued = false;

  get ready(): boolean {
    return !this.enabled || this.activation === 'ready';
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
    root.dataset.activation = 'idle';
    root.innerHTML = `
      <div class="mobile-orientation" role="status">
        <div class="mobile-rotate-icon" aria-hidden="true">↻</div>
        <strong>请横屏</strong>
      </div>
      <button class="mobile-start" type="button">开始游戏</button>
      <button class="mobile-mode" type="button" aria-label="切换转向方式">重力</button>
      <div class="mobile-tilt-meter" aria-hidden="true"><i></i></div>
      <div class="mobile-steer-zones" aria-label="触控转向">
        <button type="button" data-mobile-action="left" aria-label="左转"><span>‹</span></button>
        <button type="button" data-mobile-action="right" aria-label="右转"><span>›</span></button>
      </div>
      <div class="mobile-action-zones" aria-label="动作按钮">
        <button type="button" data-mobile-action="drift" aria-label="漂移"><span>漂</span></button>
        <button type="button" data-mobile-action="flight" aria-label="飞行"><span>飞</span></button>
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
      const action = button.dataset.mobileAction as PointerAction;
      this.buttons.set(action, button);
      button.addEventListener('pointerdown', (event) => this.pointerDown(event, action));
      button.addEventListener('pointerup', (event) => this.pointerUp(event));
      button.addEventListener('pointercancel', (event) => this.pointerUp(event));
      button.addEventListener('lostpointercapture', (event) => this.pointerUp(event));
      button.addEventListener('contextmenu', (event) => event.preventDefault());
    });

    window.addEventListener('deviceorientation', (event) => this.orientation(event), { passive: true });
    window.addEventListener('orientationchange', () => this.orientationChanged());
    screen.orientation?.addEventListener?.('change', () => this.orientationChanged());
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
      else if (this.mode === 'tilt' && this.tiltAuthorized) this.startCalibration();
    });
    window.addEventListener('pointerdown', () => {
      this.anyPressQueued = true;
      this.onFirstGesture();
    }, { passive: true });
  }

  setRacing(racing: boolean): void {
    this.racing = racing;
    this.root?.classList.toggle('racing', racing);
    if (!racing) this.releaseAll();
  }

  read(dt: number, flightActive: boolean): BoatInput {
    if (!this.enabled || !this.racing || this.activation !== 'ready') return ZERO;
    const leftHeld = this.hasAction('left');
    const rightHeld = this.hasAction('right');
    const touchTarget = leftHeld === rightHeld ? 0 : leftHeld ? -1 : 1;
    this.touchSteer = approach(this.touchSteer, touchTarget, 8 * dt);

    const response = 1 - Math.exp(-dt / 0.12);
    this.filteredTilt += (this.rawTilt - this.filteredTilt) * response;
    const tiltDegrees = Math.abs(this.filteredTilt);
    const tiltMagnitude = clamp((tiltDegrees - 3) / 19, 0, 1);
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
    const drift = this.buttons.get('drift');
    if (drift) drift.setAttribute('aria-label', flightActive ? '空刹' : '漂移');
  }

  reset(): void {
    this.releaseAll();
    this.flightQueued = false;
    this.anyPressQueued = false;
    this.touchSteer = 0;
    this.filteredTilt = 0;
  }

  status(): { mode: ControlMode; activation: ActivationState; sampleCount: number; angle: number } {
    return {
      mode: this.mode,
      activation: this.activation,
      sampleCount: this.calibrationSamples.length,
      angle: this.calibrationAngle,
    };
  }

  private async activateTilt(): Promise<void> {
    if (this.permissionPending) return;
    this.onFirstGesture();
    this.permissionPending = true;
    this.setActivation('requesting');
    const orientationType = (window as unknown as { DeviceOrientationEvent?: {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    } }).DeviceOrientationEvent;
    const permissionPromise = orientationType?.requestPermission?.();
    const fullscreenPromise = permissionPromise ? null : this.requestFullscreen();
    try {
      if (!('DeviceOrientationEvent' in window)) {
        this.useTouch();
        return;
      }
      if (permissionPromise && await permissionPromise !== 'granted') {
        this.useTouch();
        return;
      }
      this.tiltAuthorized = true;
      this.mode = 'tilt';
      if (fullscreenPromise) await fullscreenPromise.catch(() => undefined);
      else void this.requestFullscreen().catch(() => undefined);
      void this.lockLandscape();
      this.startCalibration();
    } catch {
      this.useTouch();
    } finally {
      this.permissionPending = false;
    }
  }

  private requestFullscreen(): Promise<void> {
    if (document.fullscreenElement || !document.documentElement.requestFullscreen) return Promise.resolve();
    return document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => undefined);
  }

  private async lockLandscape(): Promise<void> {
    try {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (orientation: 'landscape') => Promise<void>;
      };
      await orientation?.lock?.('landscape');
    } catch {
      // Portrait is still blocked by CSS when fullscreen/orientation lock is unavailable.
    }
  }

  private startCalibration(): void {
    if (!this.tiltAuthorized || this.mode !== 'tilt') return;
    window.clearTimeout(this.calibrationTimer);
    this.releaseAll();
    this.rawTilt = 0;
    this.filteredTilt = 0;
    this.calibrationSamples = [];
    this.calibrationStartedAt = performance.now();
    this.calibrationAngle = screenAngle();
    this.setActivation('calibrating');
    this.calibrationTimer = window.setTimeout(() => {
      if (this.activation === 'calibrating') this.useTouch();
    }, SENSOR_TIMEOUT_MS);
  }

  private finishCalibration(): void {
    const sorted = this.calibrationSamples.slice().sort((a, b) => a - b);
    this.calibration = sorted[Math.floor(sorted.length / 2)] ?? 0;
    this.rawTilt = 0;
    this.filteredTilt = 0;
    window.clearTimeout(this.calibrationTimer);
    this.setActivation('ready');
  }

  private useTouch(): void {
    window.clearTimeout(this.calibrationTimer);
    this.mode = 'touch';
    this.releaseAll();
    this.setActivation('ready');
  }

  private setActivation(state: ActivationState): void {
    this.activation = state;
    if (this.root) {
      this.root.dataset.activation = state;
      this.root.classList.toggle('touch-steer', this.mode === 'touch');
      this.root.classList.toggle('activated', state === 'ready');
    }
    if (this.modeButton) this.modeButton.textContent = this.mode === 'tilt' ? '重力' : '触控';
    if (this.start) {
      this.start.hidden = state === 'ready';
      this.start.disabled = state === 'requesting' || state === 'calibrating';
      this.start.textContent = state === 'requesting' ? '正在请求…' : state === 'calibrating' ? '正在校准…' : '开始游戏';
    }
  }

  private orientation(event: DeviceOrientationEvent): void {
    if (!this.tiltAuthorized || this.mode !== 'tilt') return;
    const angle = screenAngle();
    const lateral = lateralTilt(event, angle);
    if (lateral === null) return;
    if (this.activation === 'calibrating') {
      if (angle !== this.calibrationAngle) {
        this.calibrationAngle = angle;
        this.calibrationStartedAt = performance.now();
        this.calibrationSamples = [];
      }
      this.calibrationSamples.push(lateral);
      if (this.calibrationSamples.length > 12) this.calibrationSamples.shift();
      const stable = this.calibrationSamples.length >= MIN_CALIBRATION_SAMPLES &&
        Math.max(...this.calibrationSamples) - Math.min(...this.calibrationSamples) <= 3.5;
      if (stable && performance.now() - this.calibrationStartedAt >= CALIBRATION_MS) this.finishCalibration();
      return;
    }
    if (this.activation !== 'ready') return;
    if (angle !== this.calibrationAngle) {
      this.startCalibration();
      return;
    }
    this.rawTilt = clamp(lateral - this.calibration, -32, 32);
  }

  private orientationChanged(): void {
    this.releaseAll();
    if (this.mode === 'tilt' && this.tiltAuthorized) this.startCalibration();
  }

  private pointerDown(event: PointerEvent, action: PointerAction): void {
    this.onFirstGesture();
    this.anyPressQueued = true;
    if (!this.racing || this.activation !== 'ready') return;
    event.preventDefault();
    const button = event.currentTarget as HTMLButtonElement;
    this.activePointers.set(event.pointerId, action);
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Some WebViews reject capture even though the pointer event is valid.
      // Window blur/visibility and the element's pointerup/cancel still release it.
    }
    if (action === 'flight') this.flightQueued = true;
    this.syncHeldButtons();
  }

  private pointerUp(event: PointerEvent): void {
    this.activePointers.delete(event.pointerId);
    this.syncHeldButtons();
  }

  private syncHeldButtons(): void {
    for (const [action, button] of this.buttons) button.classList.toggle('held', this.hasAction(action));
  }

  private hasAction(action: PointerAction): boolean {
    for (const value of this.activePointers.values()) if (value === action) return true;
    return false;
  }

  private releaseAll(): void {
    this.activePointers.clear();
    this.syncHeldButtons();
    this.touchSteer = 0;
  }
}

function screenAngle(): number {
  const raw = Number(screen.orientation?.angle ?? window.orientation ?? 0);
  return ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
}

function lateralTilt(event: DeviceOrientationEvent, angle: number): number | null {
  const beta = event.beta;
  const gamma = event.gamma;
  if (angle === 90 && beta !== null && Number.isFinite(beta)) return beta;
  if (angle === 270 && beta !== null && Number.isFinite(beta)) return -beta;
  if (angle === 180 && gamma !== null && Number.isFinite(gamma)) return -gamma;
  if (gamma !== null && Number.isFinite(gamma)) return gamma;
  return null;
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return current;
}
