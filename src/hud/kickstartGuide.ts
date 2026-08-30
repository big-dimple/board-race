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
          <span class="kickstart-guide-kicker">THREE BEATS · ONE STANDARD</span>
          <h2 class="kickstart-guide-title">3 步极速上手指南</h2>
          <p class="kickstart-guide-subtitle">全自动巡航 · 漂移攒电 · 冲柱飞天</p>
        </div>
        <div class="kickstart-guide-grid">
          <div class="kickstart-guide-card">
            <div class="kickstart-guide-badge">1</div>
            <div class="kickstart-guide-icon">🏎️</div>
            <strong class="kickstart-guide-card-title">全自动前进</strong>
            <div class="kickstart-guide-key kickstart-key-steer">A / D · ← / →</div>
            <p class="kickstart-guide-card-copy">无需按油门，船只自动全速前进，专心左右转向切弯走位。</p>
          </div>
          <div class="kickstart-guide-card">
            <div class="kickstart-guide-badge">2</div>
            <div class="kickstart-guide-icon">⚡</div>
            <strong class="kickstart-guide-card-title">过弯长按漂移</strong>
            <div class="kickstart-guide-key kickstart-key-drift">按住 SHIFT 漂移</div>
            <p class="kickstart-guide-card-copy">按住漂移极速内切咬弯心，漂过黄线松手存入【飞行电池 ◇】。</p>
          </div>
          <div class="kickstart-guide-card">
            <div class="kickstart-guide-badge">3</div>
            <div class="kickstart-guide-icon">🚀</div>
            <strong class="kickstart-guide-card-title">见雾提早起飞</strong>
            <div class="kickstart-guide-key kickstart-key-flight">按 SPACE 提前起飞</div>
            <p class="kickstart-guide-card-copy">看到白雾桥立即提前按键起飞！提早入轨对准航道，飞晚容易错失天轨坠海！</p>
          </div>
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
