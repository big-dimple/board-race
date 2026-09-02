import './kickstartGuide.css';

export type KickstartDevice = 'keyboard' | 'gamepad' | 'mobile';

const STORAGE_KEY = 'board_race_kickstart_seen_v1';

export class KickstartGuide {
  readonly root: HTMLDivElement;
  private readonly startButton: HTMLButtonElement;
  private readonly steerKey: HTMLDivElement;
  private readonly driftKey: HTMLDivElement;
  private readonly flightKey: HTMLDivElement;
  private onConfirmCb: (() => void) | null = null;
  private currentDevice: KickstartDevice = 'keyboard';

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'kickstart-guide';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', '3步极速上手指南');

    this.root.innerHTML = `
      <div class="kickstart-guide-inner">
        <div class="kickstart-guide-top">
          <span class="kickstart-guide-kicker">3-STEP PILOT FLIGHT CYCLE // 三步极速飞驰法</span>
          <h2 class="kickstart-guide-title">极速飞驰 · 3 步核心法</h2>
        </div>

        <div class="kickstart-guide-cards">
          <!-- Step 1 Card -->
          <div class="kickstart-card kickstart-card-1">
            <div class="kickstart-card-glow"></div>
            <div class="kickstart-step-pill">
              <span class="kickstart-step-num">STEP 01</span>
              <span class="kickstart-step-tag">水面巡航</span>
            </div>
            <div class="kickstart-card-icon">🌊</div>
            <h3 class="kickstart-card-title">全自动巡航 · 转向切弯</h3>
            <div class="kickstart-key-badge kickstart-key-steer">A / D · ← / →</div>
            <p class="kickstart-card-copy">快艇自动全速前进无需油门，专心微调方向切准弯心走位。</p>
          </div>

          <!-- Arrow Link 1 -->
          <div class="kickstart-flow-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>
          </div>

          <!-- Step 2 Card -->
          <div class="kickstart-card kickstart-card-2">
            <div class="kickstart-card-glow"></div>
            <div class="kickstart-step-pill">
              <span class="kickstart-step-num">STEP 02</span>
              <span class="kickstart-step-tag">内切存电</span>
            </div>
            <div class="kickstart-card-icon">⚡</div>
            <h3 class="kickstart-card-title">入弯漂移 · 蓄满存电</h3>
            <div class="kickstart-key-badge kickstart-key-drift">按住 SHIFT 漂移</div>
            <p class="kickstart-card-copy">进弯长按内切咬弯心，蓄满黄线松手存入【飞行电池 ◇】。</p>
          </div>

          <!-- Arrow Link 2 -->
          <div class="kickstart-flow-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>
          </div>

          <!-- Step 3 Card -->
          <div class="kickstart-card kickstart-card-3">
            <div class="kickstart-card-glow"></div>
            <div class="kickstart-step-pill">
              <span class="kickstart-step-num">STEP 03</span>
              <span class="kickstart-step-tag">破空入轨</span>
            </div>
            <div class="kickstart-card-icon">🚀</div>
            <h3 class="kickstart-card-title">见雾提早 · 破空起飞</h3>
            <div class="kickstart-key-badge kickstart-key-flight">按 SPACE 提前起飞</div>
            <p class="kickstart-card-copy">消耗电池提前起跳对准天门！穿过天门自动俯冲降落完成循环。</p>
          </div>
        </div>

        <div class="kickstart-guide-footer">
          <button type="button" class="kickstart-guide-start">
            <span class="start-text">懂了 · 签约出发</span>
            <span class="start-sub">ENTER RACE</span>
          </button>
        </div>
      </div>
    `;

    this.startButton = this.root.querySelector('.kickstart-guide-start') as HTMLButtonElement;
    this.steerKey = this.root.querySelector('.kickstart-key-steer') as HTMLDivElement;
    this.driftKey = this.root.querySelector('.kickstart-key-drift') as HTMLDivElement;
    this.flightKey = this.root.querySelector('.kickstart-key-flight') as HTMLDivElement;

    this.startButton.addEventListener('click', () => this.confirm());
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.confirm();
    });

    window.addEventListener('keydown', (e) => {
      if (!this.isOpen()) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.confirm();
      }
    }, true);

    parent.appendChild(this.root);
  }

  isOpen(): boolean {
    return this.root.classList.contains('on');
  }

  hasSeen(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  markSeen(): void {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
  }

  updateDevice(device: KickstartDevice): void {
    this.currentDevice = device;
    if (device === 'gamepad') {
      this.steerKey.textContent = '左摇杆 转向';
      this.driftKey.textContent = '按住 X 漂移';
      this.flightKey.textContent = '按 A 提前起飞';
    } else if (device === 'mobile') {
      this.steerKey.textContent = '左手 左右转向';
      this.driftKey.textContent = '右手 按住【漂】';
      this.flightKey.textContent = '右手 点按【飞】提前起飞';
    } else {
      this.steerKey.textContent = 'A / D · ← / →';
      this.driftKey.textContent = '按住 SHIFT 漂移';
      this.flightKey.textContent = '按 SPACE 提前起飞';
    }
  }

  show(onConfirm?: () => void): void {
    this.onConfirmCb = onConfirm ?? null;
    this.root.classList.add('on');
    this.startButton.focus();
  }

  hide(): void {
    this.root.classList.remove('on');
  }

  private confirm(): void {
    this.markSeen();
    this.hide();
    const cb = this.onConfirmCb;
    this.onConfirmCb = null;
    if (cb) cb();
  }
}
