import type { DriverProfile } from '../game/racers';
import type { LocalDeviceId } from '../core/localMultiplayerInput';
import './duoKickstartGuide.css';

export interface DuoSeatGuideInfo {
  deviceId: LocalDeviceId;
  profile: DriverProfile;
}

const STORAGE_KEY = 'board_race_duo_kickstart_seen_v1';

export class DuoKickstartGuide {
  readonly root: HTMLDivElement;
  private readonly startButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly leftCard: HTMLElement;
  private readonly rightCard: HTMLElement;
  private readonly confirmHint: HTMLElement;
  private onConfirmCb: (() => void) | null = null;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'duo-kickstart-guide';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', '双打操作指南');

    this.root.innerHTML = `
      <div class="duo-kickstart-guide-inner">
        <button type="button" class="duo-kickstart-close" aria-label="关闭操作指南">✕</button>
        <div class="duo-kickstart-header">
          <span class="duo-kickstart-kicker">OPERATION MANUAL // 双打出击作战指南</span>
          <h2 class="duo-kickstart-title">HOW TO PLAY · 双打操作指南</h2>
          <p class="duo-kickstart-subtitle">全自动巡航 · 漂移蓄电 · 见雾起飞 · 淘汰发射飞毛腿打击</p>
        </div>

        <div class="duo-kickstart-grid">
          <!-- 1P Left Seat Card -->
          <div class="duo-kickstart-player duo-player-left">
            <div class="duo-player-header">
              <div class="duo-player-avatar-frame">
                <img class="duo-player-avatar" src="" alt="" draggable="false" />
              </div>
              <div class="duo-player-meta">
                <div class="duo-player-tag duo-tag-left">1P · 蓝席</div>
                <strong class="duo-player-name">--</strong>
                <span class="duo-player-device duo-device-left">--</span>
              </div>
            </div>

            <div class="duo-player-steps">
              <div class="duo-step-item">
                <div class="duo-step-badge">1</div>
                <div class="duo-step-body">
                  <div class="duo-step-top">
                    <strong class="duo-step-title">🏎️ 全速巡航</strong>
                    <div class="duo-step-key duo-key-steer-left">--</div>
                  </div>
                  <p class="duo-step-copy">无需按油门，快艇全速自动冲刺，左右控制走位切弯。</p>
                </div>
              </div>

              <div class="duo-step-item">
                <div class="duo-step-badge">2</div>
                <div class="duo-step-body">
                  <div class="duo-step-top">
                    <strong class="duo-step-title">⚡ 过弯漂移</strong>
                    <div class="duo-step-key duo-key-drift-left">--</div>
                  </div>
                  <p class="duo-step-copy">进弯长按内切咬弯心，漂过黄线松手存入【飞行电池 ◇】。</p>
                </div>
              </div>

              <div class="duo-step-item">
                <div class="duo-step-badge">3</div>
                <div class="duo-step-body">
                  <div class="duo-step-top">
                    <strong class="duo-step-title">🚀 见雾起飞</strong>
                    <div class="duo-step-key duo-key-flight-left">--</div>
                  </div>
                  <p class="duo-step-copy">见天际白雾桥提前按键起跳入轨，飞晚容易错失天轨坠海！</p>
                </div>
              </div>

              <div class="duo-step-item duo-step-highlight">
                <div class="duo-step-badge duo-badge-scud">4</div>
                <div class="duo-step-body">
                  <div class="duo-step-top">
                    <strong class="duo-step-title">💥 淘汰整蛊 · 巡航导弹</strong>
                    <div class="duo-step-key duo-key-scud-left">--</div>
                  </div>
                  <p class="duo-step-copy">不幸失误切入导弹第一视角！锁定对手发射超音速巡航导弹（炸飞 720° 腾空激浪）或支援队友电池。</p>
                </div>
              </div>
            </div>
          </div>

          <!-- 2P Right Seat Card -->
          <div class="duo-kickstart-player duo-player-right">
            <div class="duo-player-header">
              <div class="duo-player-avatar-frame">
                <img class="duo-player-avatar" src="" alt="" draggable="false" />
              </div>
              <div class="duo-player-meta">
                <div class="duo-player-tag duo-tag-right">2P · 黄席</div>
                <strong class="duo-player-name">--</strong>
                <span class="duo-player-device duo-device-right">--</span>
              </div>
            </div>

            <div class="duo-player-steps">
              <div class="duo-step-item">
                <div class="duo-step-badge">1</div>
                <div class="duo-step-body">
                  <div class="duo-step-top">
                    <strong class="duo-step-title">🏎️ 全速巡航</strong>
                    <div class="duo-step-key duo-key-steer-right">--</div>
                  </div>
                  <p class="duo-step-copy">无需按油门，快艇全速自动冲刺，左右控制走位切弯。</p>
                </div>
              </div>

              <div class="duo-step-item">
                <div class="duo-step-badge">2</div>
                <div class="duo-step-body">
                  <div class="duo-step-top">
                    <strong class="duo-step-title">⚡ 过弯漂移</strong>
                    <div class="duo-step-key duo-key-drift-right">--</div>
                  </div>
                  <p class="duo-step-copy">进弯长按内切咬弯心，漂过黄线松手存入【飞行电池 ◇】。</p>
                </div>
              </div>

              <div class="duo-step-item">
                <div class="duo-step-badge">3</div>
                <div class="duo-step-body">
                  <div class="duo-step-top">
                    <strong class="duo-step-title">🚀 见雾起飞</strong>
                    <div class="duo-step-key duo-key-flight-right">--</div>
                  </div>
                  <p class="duo-step-copy">见天际白雾桥提前按键起跳入轨，飞晚容易错失天轨坠海！</p>
                </div>
              </div>

              <div class="duo-step-item duo-step-highlight">
                <div class="duo-step-badge duo-badge-scud">4</div>
                <div class="duo-step-body">
                  <div class="duo-step-top">
                    <strong class="duo-step-title">💥 淘汰整蛊 · 巡航导弹</strong>
                    <div class="duo-step-key duo-key-scud-right">--</div>
                  </div>
                  <p class="duo-step-copy">不幸失误切入导弹第一视角！锁定对手发射超音速巡航导弹（炸飞 720° 腾空激浪）或支援队友电池。</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="duo-kickstart-footer">
          <button type="button" class="duo-kickstart-start">懂了 · 全员出击 (READY)</button>
          <div class="duo-kickstart-hint">1P [ SPACE / A ] 确认 · 2P [ ENTER / A ] 确认 · 或点击按钮</div>
        </div>
      </div>
    `;

    this.startButton = this.root.querySelector('.duo-kickstart-start') as HTMLButtonElement;
    this.closeButton = this.root.querySelector('.duo-kickstart-close') as HTMLButtonElement;
    this.leftCard = this.root.querySelector('.duo-player-left') as HTMLElement;
    this.rightCard = this.root.querySelector('.duo-player-right') as HTMLElement;
    this.confirmHint = this.root.querySelector('.duo-kickstart-hint') as HTMLElement;

    this.startButton.addEventListener('click', () => this.confirm());
    this.closeButton.addEventListener('click', () => this.confirm());
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.confirm();
    });

    window.addEventListener('keydown', (e) => {
      if (!this.isOpen()) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape' || e.key === 'i' || e.key === 'I') {
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

  show(left: DuoSeatGuideInfo, right: DuoSeatGuideInfo, onConfirm?: () => void): void {
    this.onConfirmCb = onConfirm ?? null;
    this.updateSeat(this.leftCard, 'left', left);
    this.updateSeat(this.rightCard, 'right', right);

    const leftGuide = getDeviceGuide('left', left.deviceId);
    const rightGuide = getDeviceGuide('right', right.deviceId);
    this.confirmHint.textContent = `1P [ ${leftGuide.confirmHint} ] · 2P [ ${rightGuide.confirmHint} ] · 或点击出击`;

    this.root.classList.add('on');
    this.startButton.focus();
  }

  hide(): void {
    this.root.classList.remove('on');
  }

  confirm(): void {
    this.markSeen();
    this.hide();
    const cb = this.onConfirmCb;
    this.onConfirmCb = null;
    if (cb) cb();
  }

  private updateSeat(card: HTMLElement, side: 'left' | 'right', info: DuoSeatGuideInfo): void {
    const guide = getDeviceGuide(side, info.deviceId);
    card.style.setProperty('--driver-accent', hex(info.profile.color));

    const avatar = card.querySelector<HTMLImageElement>('.duo-player-avatar')!;
    avatar.src = info.profile.portraitUrl;
    avatar.style.objectPosition = info.profile.portraitPosition;
    avatar.alt = info.profile.name;

    card.querySelector<HTMLElement>('.duo-player-name')!.textContent = `${info.profile.name} · ${info.profile.callsign}`;
    card.querySelector<HTMLElement>(`.duo-device-${side}`)!.textContent = guide.label;

    card.querySelector<HTMLElement>(`.duo-key-steer-${side}`)!.textContent = guide.steer;
    card.querySelector<HTMLElement>(`.duo-key-drift-${side}`)!.textContent = guide.drift;
    card.querySelector<HTMLElement>(`.duo-key-flight-${side}`)!.textContent = guide.flight;
    card.querySelector<HTMLElement>(`.duo-key-scud-${side}`)!.innerHTML = `<span class="duo-key-scud-btn">${guide.scud}</span> · <span class="duo-key-support-btn">${guide.support}</span>`;
  }
}

function getDeviceGuide(side: 'left' | 'right', deviceId: LocalDeviceId) {
  const isGamepad = deviceId.startsWith('gamepad:');
  const padIndex = isGamepad ? Number(deviceId.slice('gamepad:'.length)) + 1 : 1;

  if (isGamepad) {
    return {
      label: `🎮 手柄 ${padIndex} (已连接)`,
      steer: '左摇杆 转向',
      drift: '按住 X (或 LB/RB) 漂移',
      flight: '按 A 提前起飞',
      scud: '按 Y 🚀 飞毛腿',
      support: '按 B 🔋 补电',
      confirmHint: '按 A 确认',
    };
  }

  if (side === 'left') {
    return {
      label: '⌨️ 键盘左区 (WASD)',
      steer: 'A / D 转向',
      drift: '按住 左 SHIFT 漂移',
      flight: '按 SPACE 提前起飞',
      scud: '按 E 🚀 飞毛腿',
      support: '按 Q 🔋 补电',
      confirmHint: '按 SPACE 确认',
    };
  }

  return {
    label: '⌨️ 键盘右区 (方向键 / J L)',
    steer: '← / → (或 J / L) 转向',
    drift: '按住 右 SHIFT (或小键盘 0 / K) 漂移',
    flight: '按 小键盘 ENTER (或 I) 提前起飞',
    scud: '按 O 🚀 飞毛腿',
    support: '按 U 🔋 补电',
    confirmHint: '按 ENTER 确认',
  };
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
