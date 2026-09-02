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
        <div class="kickstart-guide-header">
          <span class="kickstart-guide-kicker">PILOT FLIGHT CYCLE // 3-STEP PROGRESSIVE PATH</span>
          <h2 class="kickstart-guide-title">3 步飞驰循环指南</h2>
          <p class="kickstart-guide-subtitle">水面切弯 ➔ 漂移蓄电 ➔ 破空翱翔 · 步步相扣的完整飞驰法则</p>
        </div>
        <div class="kickstart-cycle-bar">
          <div class="kickstart-cycle-node step-1">
            <span class="cycle-pill">STEP 01</span>
            <span class="cycle-label">水面转向</span>
          </div>
          <div class="kickstart-cycle-link">➔</div>
          <div class="kickstart-cycle-node step-2">
            <span class="cycle-pill">STEP 02</span>
            <span class="cycle-label">漂移蓄电</span>
          </div>
          <div class="kickstart-cycle-link">➔</div>
          <div class="kickstart-cycle-node step-3">
            <span class="cycle-pill">STEP 03</span>
            <span class="cycle-label">提早起飞</span>
          </div>
        </div>
        <div class="kickstart-guide-grid">
          <div class="kickstart-guide-card step-card-1">
            <div class="kickstart-guide-badge">01</div>
            <div class="kickstart-guide-icon">🏎️</div>
            <strong class="kickstart-guide-card-title">全自动巡航 · 转向切弯</strong>
            <div class="kickstart-guide-key kickstart-key-steer">A / D · ← / →</div>
            <p class="kickstart-guide-card-copy">快艇自动全速前进无需油门，专心微调方向切准弯心走位。</p>
          </div>
          <div class="kickstart-guide-card step-card-2">
            <div class="kickstart-guide-badge">02</div>
            <div class="kickstart-guide-icon">⚡</div>
            <strong class="kickstart-guide-card-title">内切漂移 · 蓄满存电</strong>
            <div class="kickstart-guide-key kickstart-key-drift">按住 SHIFT 漂移</div>
            <p class="kickstart-guide-card-copy">进弯长按内切咬弯心，蓄满黄线松手即可存入【飞行电池 ◇】。</p>
          </div>
          <div class="kickstart-guide-card step-card-3">
            <div class="kickstart-guide-badge">03</div>
            <div class="kickstart-guide-icon">🚀</div>
            <strong class="kickstart-guide-card-title">见雾提早 · 破空入轨</strong>
            <div class="kickstart-guide-key kickstart-key-flight">按 SPACE 提前起飞</div>
            <p class="kickstart-guide-card-copy">消耗电池提前起跳对准天门！穿过天门自动俯冲降落完成循环。</p>
          </div>
        </div>
        <div class="kickstart-guide-chain-tip">
          <span class="chain-icon">💡</span> <b>核心法则</b>：【转向切弯】 ➔ 【漂移攒电】 ➔ 【起飞入轨】 · 三阶循环缺一不可
        </div>
        <div class="kickstart-guide-footer">
          <button type="button" class="kickstart-guide-start">懂了 · 签约出发</button>
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
