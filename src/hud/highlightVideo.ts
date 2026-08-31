import type { HighlightClip } from '../game/highlightRecorder';
import type { HighlightCameraState } from '../game/highlightDirector';
import './highlightVideo.css';

export class HighlightVideo {
  private readonly root: HTMLElement;
  private readonly recTimeEl: HTMLElement;
  private readonly camTagEl: HTMLElement;
  private readonly speedTagEl: HTMLElement;
  private readonly stuntBannerEl: HTMLElement;
  private readonly stuntRatingEl: HTMLElement;
  private readonly stuntTitleEl: HTMLElement;
  private readonly stuntDetailEl: HTMLElement;
  private readonly slowMoPillEl: HTMLElement;
  private readonly timeDisplayEl: HTMLElement;
  private readonly scrubberTrackEl: HTMLElement;
  private readonly scrubberFillEl: HTMLElement;
  private readonly scrubberHeadEl: HTMLElement;
  private readonly btnPlayEl: HTMLButtonElement;
  private readonly btnRestartEl: HTMLButtonElement;
  private readonly btnContinueEl: HTMLButtonElement;
  private readonly eqBars: HTMLElement[] = [];

  private isVisible = false;
  private clip: HighlightClip | null = null;
  private eqTimer = 0;

  constructor(
    parent: HTMLElement,
    private readonly onTogglePlay: () => boolean,
    private readonly onRestart: () => void,
    private readonly onSeek: (progress: number) => void,
    private readonly onContinue: () => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'highlight-video-overlay';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', '高光时刻精彩回放');
    this.root.innerHTML = `
      <div class="highlight-letterbox-top"></div>
      <div class="highlight-letterbox-bottom"></div>
      <div class="highlight-crt-scanlines"></div>
      <div class="highlight-speed-lines"></div>
      <div class="highlight-lens-flare"></div>

      <!-- Viewfinder Brackets -->
      <div class="highlight-bracket highlight-bracket-tl"></div>
      <div class="highlight-bracket highlight-bracket-tr"></div>
      <div class="highlight-bracket highlight-bracket-bl"></div>
      <div class="highlight-bracket highlight-bracket-br"></div>

      <!-- Top Broadcast Header -->
      <header class="highlight-header">
        <div class="highlight-rec-badge">
          <span class="highlight-rec-dot"></span>
          <span>REC</span>
          <span class="highlight-rec-specs">[ 4K 60FPS · HDR ]</span>
          <span class="highlight-rec-time">00:00.00</span>
        </div>
        <div class="highlight-broadcast-title">
          <span>✨ PLAY OF THE RUN // 高光时刻回放 ✨</span>
        </div>
        <div class="highlight-telemetry">
          <span class="highlight-cam-tag">[ CAM 01 // LOW-APEX TRACK ]</span>
          <span class="highlight-speed-tag">0 KM/H</span>
        </div>
      </header>

      <!-- Center Stunt Banner -->
      <div class="highlight-stunt-banner">
        <span class="highlight-stunt-rating">[ SSS · 巅峰高光 ]</span>
        <h2 class="highlight-stunt-title">🚀 破空飞跃 · 穿云过门</h2>
        <p class="highlight-stunt-detail">★ 毫秒精准 · 气动拉满 · 全场焦点</p>
      </div>

      <!-- Slow-Mo Tag -->
      <div class="highlight-slowmo-pill">
        <span>⏱️ 0.35X SLOW-MO</span>
      </div>

      <!-- Bottom Video Player Controls Bar -->
      <footer class="highlight-controls-bar">
        <button class="highlight-btn-play" type="button" aria-label="播放或暂停">❚❚</button>
        <button class="highlight-btn-restart" type="button" aria-label="重播高光视频">↺ 重播</button>
        <div class="highlight-eq-visualizer" aria-hidden="true">
          ${Array.from({ length: 12 }, () => '<span class="highlight-eq-bar"></span>').join('')}
        </div>

        <div class="highlight-scrubber-wrap">
          <span class="highlight-time-display">00:00 / 00:00</span>
          <div class="highlight-scrubber-track" role="slider" aria-label="回放进度">
            <div class="highlight-scrubber-fill"></div>
            <div class="highlight-scrubber-head"></div>
          </div>
        </div>

        <button class="highlight-btn-continue" type="button" aria-label="跳过回放查看成就墙">
          <span>查看成就墙 ➔</span>
        </button>
      </footer>
    `;

    parent.appendChild(this.root);

    this.recTimeEl = this.root.querySelector('.highlight-rec-time')!;
    this.camTagEl = this.root.querySelector('.highlight-cam-tag')!;
    this.speedTagEl = this.root.querySelector('.highlight-speed-tag')!;
    this.stuntBannerEl = this.root.querySelector('.highlight-stunt-banner')!;
    this.stuntRatingEl = this.root.querySelector('.highlight-stunt-rating')!;
    this.stuntTitleEl = this.root.querySelector('.highlight-stunt-title')!;
    this.stuntDetailEl = this.root.querySelector('.highlight-stunt-detail')!;
    this.slowMoPillEl = this.root.querySelector('.highlight-slowmo-pill')!;
    this.timeDisplayEl = this.root.querySelector('.highlight-time-display')!;
    this.scrubberTrackEl = this.root.querySelector('.highlight-scrubber-track')!;
    this.scrubberFillEl = this.root.querySelector('.highlight-scrubber-fill')!;
    this.scrubberHeadEl = this.root.querySelector('.highlight-scrubber-head')!;
    this.btnPlayEl = this.root.querySelector('.highlight-btn-play')!;
    this.btnRestartEl = this.root.querySelector('.highlight-btn-restart')!;
    this.btnContinueEl = this.root.querySelector('.highlight-btn-continue')!;

    this.eqBars = Array.from(this.root.querySelectorAll('.highlight-eq-bar'));

    // Events
    this.btnPlayEl.addEventListener('click', () => {
      const playing = this.onTogglePlay();
      this.btnPlayEl.textContent = playing ? '❚❚' : '▶';
    });
    this.btnRestartEl.addEventListener('click', () => {
      this.onRestart();
      this.btnPlayEl.textContent = '❚❚';
    });
    this.btnContinueEl.addEventListener('click', () => {
      this.onContinue();
    });

    this.scrubberTrackEl.addEventListener('click', (e) => {
      const rect = this.scrubberTrackEl.getBoundingClientRect();
      const progress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.onSeek(progress);
    });

    this.root.addEventListener('keydown', (e) => {
      if (!this.isVisible) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.onContinue();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        this.onRestart();
      }
    });

    this.hide();
  }

  show(clip: HighlightClip): void {
    this.clip = clip;
    this.isVisible = true;
    this.root.classList.add('on');
    this.root.setAttribute('aria-hidden', 'false');
    this.btnPlayEl.textContent = '❚❚';

    this.stuntRatingEl.textContent = clip.stuntRating;
    this.stuntTitleEl.textContent = clip.stuntTitle;
    this.stuntDetailEl.textContent = `★ ${clip.stuntDetail} · 斩获 ${clip.stuntScore} 荣耀点`;

    // Re-trigger entrance animation
    this.stuntBannerEl.style.animation = 'none';
    // Trigger reflow
    void this.stuntBannerEl.offsetWidth;
    this.stuntBannerEl.style.animation = '';

    this.updateProgress(0, clip.duration, clip.startTime, 0);
  }

  update(state: HighlightCameraState, dt: number): void {
    if (!this.isVisible || !this.clip) return;

    this.camTagEl.textContent = state.camLabel;
    this.speedTagEl.textContent = `${state.speedKmh} KM/H`;

    const totalDur = this.clip.duration;
    const elapsed = state.clipProgress * totalDur;
    this.updateProgress(elapsed, totalDur, state.currentReplayTime, state.clipProgress);

    // Update slow-mo class
    this.root.classList.toggle('slow-mo', state.slowMoActive);

    // Update bouncing audio EQ bars
    this.eqTimer += dt;
    if (this.eqTimer >= 0.06) {
      this.eqTimer = 0;
      for (let i = 0; i < this.eqBars.length; i++) {
        const h = state.slowMoActive
          ? 4 + Math.sin(Date.now() * 0.008 + i * 0.8) * 8 + Math.random() * 6
          : 6 + Math.sin(Date.now() * 0.015 + i * 0.6) * 12 + Math.random() * 8;
        this.eqBars[i].style.height = `${Math.max(3, Math.min(22, h))}px`;
      }
    }
  }

  hide(): void {
    this.isVisible = false;
    this.clip = null;
    this.root.classList.remove('on', 'slow-mo');
    this.root.setAttribute('aria-hidden', 'true');
  }

  visible(): boolean {
    return this.isVisible;
  }

  private updateProgress(elapsed: number, duration: number, replayTime: number, progress: number): void {
    const elapsedSec = Math.floor(elapsed);
    const elapsedMs = Math.floor((elapsed % 1) * 100);
    const durSec = Math.floor(duration);
    const durMs = Math.floor((duration % 1) * 100);

    this.timeDisplayEl.textContent = `00:${String(elapsedSec).padStart(2, '0')}.${String(elapsedMs).padStart(2, '0')} / 00:${String(durSec).padStart(2, '0')}.${String(durMs).padStart(2, '0')}`;

    const replaySec = Math.floor(replayTime);
    const replayMs = Math.floor((replayTime % 1) * 100);
    this.recTimeEl.textContent = `00:${String(replaySec).padStart(2, '0')}.${String(replayMs).padStart(2, '0')}`;

    const pct = `${(progress * 100).toFixed(1)}%`;
    this.scrubberFillEl.style.width = pct;
    this.scrubberHeadEl.style.left = pct;
  }
}
