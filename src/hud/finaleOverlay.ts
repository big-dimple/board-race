import type { ChallengeResult } from '../contracts';
import { FinaleCelebrationCanvas, type FinaleVisualState } from './finaleCelebration';
import './finaleOverlay.css';

/** Seconds the certificate waits before it walks itself into the accolade wall. */
const FINALE_AUTO_ADVANCE_S = 5;

export class FinaleOverlay {
  private readonly root: HTMLDivElement;
  private readonly place: HTMLDivElement;
  private readonly time: HTMLDivElement;
  private readonly actions: HTMLDivElement;
  private readonly continueButton: HTMLButtonElement;
  private readonly galleryButton: HTMLButtonElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly actionButtons: HTMLButtonElement[];
  private readonly celebration: FinaleCelebrationCanvas;
  private actionsReady = false;
  private autoRemaining = 0;
  private autoFired = false;
  private autoDisplayedSecond = -1;
  private continueLabel = '继续游戏';

  constructor(
    parent: HTMLElement,
    private readonly onContinue: (auto: boolean) => void,
    onGallery: () => void,
    _onSave: () => void,
    private readonly onSkip: () => void,
  ) {
    const root = document.createElement('div');
    root.className = 'finale-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML = `
      <div class="finale-flare" aria-hidden="true"></div>
      <div class="finale-visual" aria-hidden="true"></div>
      <button class="finale-skip" type="button" data-action="skip" title="跳过资料片与高光，直接进入下一轮"
        aria-label="直接下一轮，跳过资料片与高光">直接下一轮 ➔</button>
      <div class="finale-copy">
        <div class="finale-kicker">FINAL STATION · SEVEN FLIGHTS</div>
        <div class="finale-title">七飞认证</div>
        <div class="finale-place"></div>
        <div class="finale-time"></div>
        <div class="finale-easter" aria-label="资料片彩蛋">
          <i>沙漠</i><i>城市</i><i>雪地</i><i>沼泽</i><i>丛林</i><i>外星</i><i>菌群</i>
        </div>
        <div class="finale-actions">
          <button class="finale-primary" type="button" data-action="gallery">
            <small>UNLOCKED · 07 DOSSIERS</small>
            <strong>神秘资料片</strong>
            <span>进入彩蛋画廊</span>
          </button>
          <div class="finale-utilities" aria-label="其他操作">
            <button type="button" data-action="continue">继续游戏</button>
          </div>
        </div>
      </div>`;
    parent.appendChild(root);
    this.root = root;
    this.place = root.querySelector('.finale-place')!;
    this.time = root.querySelector('.finale-time')!;
    this.actions = root.querySelector('.finale-actions')!;
    this.continueButton = root.querySelector('[data-action="continue"]')!;
    this.galleryButton = root.querySelector('[data-action="gallery"]')!;
    this.skipButton = root.querySelector('[data-action="skip"]')!;
    this.actionButtons = [this.galleryButton, this.continueButton, this.skipButton];
    this.celebration = new FinaleCelebrationCanvas(root.querySelector('.finale-visual')!);
    this.continueButton.addEventListener('click', () => this.onContinue(false));
    this.skipButton.addEventListener('click', () => this.onSkip());
    this.galleryButton.addEventListener('click', onGallery);
    root.addEventListener('keydown', (event) => {
      if (!this.actionsReady) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        this.moveFocus(-1);
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        this.moveFocus(1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        // Keep the global race input from also consuming the native button click.
        event.stopPropagation();
      }
    });
  }

  show(result: ChallengeResult, continueLabel = '继续游戏'): void {
    this.place.textContent = result.place === 1 ? '第一名冲线' : `第 ${result.place} / ${result.totalRacers} 名冲线`;
    this.time.textContent = `本局 ${result.flightsCleared} 飞 · ${formatTime(result.raceTime)}`;
    this.actions.classList.remove('on');
    this.actionsReady = false;
    this.autoRemaining = 0;
    this.autoFired = false;
    this.autoDisplayedSecond = -1;
    this.continueLabel = continueLabel;
    this.renderContinueLabel();
    this.root.style.setProperty('--finale-progress', '0');
    this.root.classList.remove('impact', 'crown', 'hero', 'settled');
    this.celebration.reset();
    this.root.classList.add('on');
  }

  update(elapsed: number, _duration: number, canContinue: boolean, dt = 0): void {
    this.root.style.setProperty('--finale-progress', String(Math.max(0, Math.min(1, elapsed / 2.4))));
    const state = this.celebration.render(elapsed, canContinue);
    this.root.classList.toggle('impact', state.phase === 'impact');
    this.root.classList.toggle('crown', state.phase === 'crown');
    this.root.classList.toggle('hero', state.phase === 'hero');
    this.root.classList.toggle('settled', state.phase === 'settled');
    this.root.classList.toggle('reveal', elapsed >= 1.15);
    this.actions.classList.toggle('on', canContinue);
    if (canContinue && !this.actionsReady) {
      this.actionsReady = true;
      this.resetAutoAdvance();
      this.focusPrimary();
    }
    this.tickAutoAdvance(canContinue, dt);
  }

  /**
   * Hand the certificate its full waiting window again. Returning from the
   * dossier or the capture preview must not drop the player into a countdown
   * that quietly ran dry while they were reading something else.
   */
  resetAutoAdvance(): void {
    if (!this.actionsReady) return;
    this.autoRemaining = FINALE_AUTO_ADVANCE_S;
    this.autoFired = false;
    this.autoDisplayedSecond = -1;
    this.renderContinueLabel();
  }

  private tickAutoAdvance(canContinue: boolean, dt: number): void {
    if (!canContinue || this.autoFired || this.autoRemaining <= 0) return;
    this.autoRemaining = Math.max(0, this.autoRemaining - Math.max(0, dt));
    this.renderContinueLabel();
    if (this.autoRemaining > 0) return;
    this.autoFired = true;
    this.onContinue(true);
  }

  private renderContinueLabel(): void {
    const seconds = this.actionsReady && !this.autoFired && this.autoRemaining > 0
      ? Math.max(1, Math.ceil(this.autoRemaining))
      : 0;
    if (seconds === this.autoDisplayedSecond) return;
    this.autoDisplayedSecond = seconds;
    this.continueButton.textContent = seconds > 0 ? `${this.continueLabel} · ${seconds} 秒` : this.continueLabel;
    this.continueButton.setAttribute(
      'aria-label',
      seconds > 0 ? `${this.continueLabel}，${seconds} 秒后自动继续` : this.continueLabel,
    );
  }

  visualState(): FinaleVisualState { return this.celebration.visualState(); }

  getCaptureCanvas(): HTMLCanvasElement { return this.celebration.canvas; }

  setCaptureReady(_ready: boolean): void {
    // Screenshot button has been retired for cleaner UX
  }

  hide(): void {
    this.root.classList.remove('on', 'impact', 'crown', 'hero', 'settled', 'reveal');
    this.actions.classList.remove('on');
    this.actionsReady = false;
    this.autoRemaining = 0;
    this.autoFired = false;
    this.autoDisplayedSecond = -1;
    this.continueLabel = '继续游戏';
    this.renderContinueLabel();
    this.celebration.reset();
  }

  focusPrimary(): void {
    if (this.actionsReady) this.galleryButton.focus({ preventScroll: true });
  }

  /** Focus the next-step action after returning from an optional gallery. */
  focusContinue(): void {
    if (this.actionsReady && !this.continueButton.disabled) this.continueButton.focus({ preventScroll: true });
  }

  moveFocus(direction: -1 | 1): void {
    if (!this.actionsReady) return;
    const available = this.actionButtons.filter((button) => !button.disabled);
    if (available.length === 0) return;
    const index = available.indexOf(document.activeElement as HTMLButtonElement);
    available[(index + direction + available.length) % available.length].focus({ preventScroll: true });
  }

  activateFocused(): void {
    if (!this.actionsReady) return;
    const focused = this.actionButtons.find((button) => button === document.activeElement && !button.disabled);
    (focused ?? this.galleryButton).click();
  }

  focusedAction(): string {
    return this.actionButtons.find((button) => button === document.activeElement)?.dataset.action ?? 'none';
  }
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(3).padStart(6, '0')}`;
}
