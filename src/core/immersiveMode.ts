import './immersiveMode.css';

export type FullscreenOutcome =
  | 'idle'
  | 'unsupported'
  | 'standalone'
  | 'pending'
  | 'entered'
  | 'exited'
  | 'rejected';
export type FullscreenRequestSource = 'none' | 'go' | 'control' | 'capture-return' | 'restore';
type ImmersivePhase = 'ready' | 'active' | 'presentation';
const CHROME_GO_BUFFER_S = 2.8;

/**
 * Owns browser fullscreen separately from touch input. A fullscreen request
 * must be made in the same trusted event as GO or a real gameplay gesture;
 * simulation and sensor permission are deliberately kept out of this path.
 */
export class ImmersiveModeController {
  private readonly root: HTMLDivElement;
  private readonly restoreButton: HTMLButtonElement;
  private readonly dismissButton: HTMLButtonElement;
  private readonly mobile: boolean;
  private phase: ImmersivePhase = 'ready';
  private requestPending = false;
  private wasActive = false;
  private goAttempted = false;
  private dismissedForPhase = false;
  private fullscreenRequestsValue = 0;
  private fullscreenGoGesturesValue = 0;
  private fullscreenRequestSourceValue: FullscreenRequestSource = 'none';
  private fullscreenOutcomeValue: FullscreenOutcome = 'idle';
  private fullscreenFailuresValue = 0;
  private goBufferRemaining = 0;
  private goAccepted = false;
  private readonly chromiumFamily: boolean;

  constructor(parent: HTMLElement, mobile: boolean) {
    this.mobile = mobile;
    this.chromiumFamily = /Chrome|Chromium|CriOS/.test(navigator.userAgent) &&
      !/Edg|OPR|SamsungBrowser/.test(navigator.userAgent);
    this.root = document.createElement('div');
    this.root.className = 'immersive-recovery';
    this.root.innerHTML = `
      <button class="immersive-recovery-action" type="button" aria-label="恢复全屏">
        <span aria-hidden="true">⛶</span><b>恢复全屏</b>
      </button>
      <button class="immersive-recovery-dismiss" type="button" aria-label="本局关闭全屏提示">×</button>
    `;
    parent.appendChild(this.root);
    this.restoreButton = this.root.querySelector<HTMLButtonElement>('.immersive-recovery-action')!;
    this.dismissButton = this.root.querySelector<HTMLButtonElement>('.immersive-recovery-dismiss')!;
    this.restoreButton.addEventListener('click', () => this.request('restore'));
    this.dismissButton.addEventListener('click', () => {
      this.dismissedForPhase = true;
      this.syncUi();
    });
    document.addEventListener('fullscreenchange', () => this.fullscreenChanged());
    this.syncUi();
  }

  setPhase(phase: ImmersivePhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    if (phase === 'ready') {
      this.dismissedForPhase = false;
      this.goBufferRemaining = 0;
      this.goAccepted = false;
    }
    this.syncUi();
  }

  /** Called directly by the mouse/touch GO click or a READY keyboard event. */
  requestGo(): void {
    this.goAttempted = true;
    this.fullscreenGoGesturesValue++;
    this.dismissedForPhase = false;
    this.goAccepted = false;
    this.goBufferRemaining = 0;
    this.request('go');
  }

  /** Advance the browser-owned fullscreen notice buffer on the fixed step. */
  update(dt: number): void {
    this.goBufferRemaining = Math.max(0, this.goBufferRemaining - Math.max(0, dt));
  }

  /** True when a queued GO may safely enter the authored countdown. */
  goStartReady(): boolean {
    return !this.requestPending && (this.goAccepted || this.fullscreenOutcomeValue !== 'pending') &&
      this.goBufferRemaining <= 0;
  }

  /** Retry only after the run has had a GO attempt or fullscreen exit. */
  requestControlFromGesture(): void {
    if (this.phase === 'presentation') return;
    if (!this.goAttempted && this.fullscreenOutcomeValue !== 'rejected' && this.fullscreenOutcomeValue !== 'exited') return;
    if (this.fullscreenOutcomeValue !== 'rejected' && this.fullscreenOutcomeValue !== 'exited') return;
    this.request('control');
  }

  /** Return from the capture/share viewer on the same trusted click. */
  requestCaptureReturn(): void {
    // A dossier/capture harness can be opened without a preceding GO. Only
    // retry in that case when the share flow really reported an exit/rejection;
    // an untouched READY page must never create a fullscreen prompt.
    if (!this.goAttempted && this.fullscreenOutcomeValue !== 'exited' && this.fullscreenOutcomeValue !== 'rejected') return;
    this.request('capture-return');
  }

  status(): {
    fullscreenRequests: number;
    fullscreenRequestSource: FullscreenRequestSource;
    fullscreenGoGestures: number;
    fullscreenOutcome: FullscreenOutcome;
    fullscreenFailures: number;
    fullscreenGoBufferRemaining: number;
    fullscreenGoStartReady: boolean;
    recoveryVisible: boolean;
  } {
    return {
      fullscreenRequests: this.fullscreenRequestsValue,
      fullscreenRequestSource: this.fullscreenRequestSourceValue,
      fullscreenGoGestures: this.fullscreenGoGesturesValue,
      fullscreenOutcome: this.fullscreenOutcomeValue,
      fullscreenFailures: this.fullscreenFailuresValue,
      fullscreenGoBufferRemaining: this.goBufferRemaining,
      fullscreenGoStartReady: this.goStartReady(),
      recoveryVisible: !this.root.hidden,
    };
  }

  private request(source: Exclude<FullscreenRequestSource, 'none'>): void {
    if (this.requestPending) return;
    if (this.isStandaloneDisplay()) {
      this.fullscreenOutcomeValue = 'standalone';
      this.wasActive = true;
      this.goAccepted = true;
      this.syncUi();
      return;
    }
    if (document.fullscreenElement) {
      this.fullscreenOutcomeValue = 'entered';
      this.wasActive = true;
      this.goAccepted = true;
      this.syncUi();
      return;
    }
    const requestFullscreen = document.documentElement.requestFullscreen;
    if (!requestFullscreen) {
      this.fullscreenOutcomeValue = 'unsupported';
      this.syncUi();
      return;
    }
    this.fullscreenRequestsValue++;
    this.fullscreenRequestSourceValue = source;
    this.fullscreenOutcomeValue = 'pending';
    this.requestPending = true;
    let request: Promise<void>;
    try {
      request = requestFullscreen.call(document.documentElement, { navigationUI: 'hide' });
    } catch {
      this.rejectRequest();
      return;
    }
    request.then(() => {
      this.wasActive = true;
      this.fullscreenOutcomeValue = 'entered';
      this.goAccepted = true;
      this.goBufferRemaining = source === 'go' && this.chromiumFamily ? CHROME_GO_BUFFER_S : 0;
      this.dismissedForPhase = false;
      this.syncUi();
    }).catch(() => {
      this.rejectRequest();
    }).finally(() => {
      this.requestPending = false;
      this.syncUi();
    });
    this.lockLandscape();
  }

  private rejectRequest(): void {
    this.fullscreenOutcomeValue = 'rejected';
    this.fullscreenFailuresValue++;
    this.requestPending = false;
    this.goAccepted = true;
    this.goBufferRemaining = 0;
    this.syncUi();
  }

  private fullscreenChanged(): void {
    if (this.isStandaloneDisplay()) {
      this.wasActive = true;
      this.fullscreenOutcomeValue = 'standalone';
      this.goAccepted = true;
      this.goBufferRemaining = 0;
      this.syncUi();
      return;
    }
    if (document.fullscreenElement) {
      this.wasActive = true;
      this.fullscreenOutcomeValue = 'entered';
      this.goAccepted = true;
      this.goBufferRemaining = this.chromiumFamily ? CHROME_GO_BUFFER_S : 0;
      this.dismissedForPhase = false;
      this.syncUi();
      return;
    }
    if (!this.wasActive) return;
    this.wasActive = false;
    this.requestPending = false;
    this.fullscreenOutcomeValue = 'exited';
    this.goAccepted = true;
    this.goBufferRemaining = 0;
    this.syncUi();
  }

  private isStandaloneDisplay(): boolean {
    const iosNavigator = navigator as Navigator & { standalone?: boolean };
    return matchMedia('(display-mode: standalone)').matches || iosNavigator.standalone === true;
  }

  private async lockLandscape(): Promise<void> {
    try {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (orientation: 'landscape') => Promise<void>;
      };
      await orientation?.lock?.('landscape');
    } catch {
      // CSS keeps portrait blocked when fullscreen/orientation lock is unavailable.
    }
  }

  private syncUi(): void {
    const recoverable = !this.mobile && this.goAttempted && this.phase === 'active' &&
      !this.dismissedForPhase && (this.fullscreenOutcomeValue === 'rejected' || this.fullscreenOutcomeValue === 'exited');
    this.root.hidden = !recoverable;
    this.root.dataset.outcome = this.fullscreenOutcomeValue;
  }
}
