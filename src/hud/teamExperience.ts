import { DRIVER_PROFILES, type DriverProfile } from '../game/racers';
import {
  LocalMultiplayerInput,
  type LocalDeviceId,
  type LocalDeviceInfo,
  type SeatSide,
} from '../core/localMultiplayerInput';
import type { TeamRole } from '../game/teamExpedition';
import './teamExperience.css';

export type FrontDoorMode = 'independent' | 'team';

export interface TeamSelection {
  left: { deviceId: LocalDeviceId; profile: DriverProfile };
  right: { deviceId: LocalDeviceId; profile: DriverProfile };
  resumeStation: number;
  playTutorial: boolean;
  swapRoles: boolean;
}

export interface TeamHudSeat {
  profile: DriverProfile;
  role: TeamRole;
  speedKmh: number;
  status: string;
  actionLabel: string;
  ready: boolean;
  disconnected: boolean;
}

export interface TeamHudState {
  station: number;
  totalStations: number;
  stationName: string;
  beat: number;
  beatTotal: number;
  elapsed: number;
  objective: string;
  progress: number;
  hintLevel: 0 | 1 | 2;
  left: TeamHudSeat;
  right: TeamHudSeat;
}

export interface TeamExperienceCallbacks {
  onIndependent: () => void;
  onTeamStart: (selection: TeamSelection) => void;
  onReplayTeam: () => void;
  onExitTeam: () => void;
  onAudioIntent: () => void;
}

type FrontDoorPhase = 'mode' | 'save-choice' | 'join' | 'drivers' | 'hidden';

interface SeatClaim {
  deviceId: LocalDeviceId;
  label: string;
  profileIndex: number;
  ready: boolean;
}

const SIDES: readonly SeatSide[] = ['left', 'right'];
const SIDE_NAME: Record<SeatSide, string> = { left: '左侧席位', right: '右侧席位' };
const TEAM_STORAGE_KEY = 'board-race:team-expedition:v2';
const LEGACY_TEAM_STORAGE_KEY = 'board-race:team-expedition:v1';
const ROLE_LABEL: Record<TeamRole, string> = {
  trainee: '驾驶校准',
  sender: '投递手',
  receiver: '接收手',
  anchor: '门锁手',
  runner: '突进手',
  pilot: '飞行员',
  operator: '门控手',
  dock: '泊位手',
};

export class TeamExperience {
  readonly root: HTMLDivElement;
  private readonly modePanel: HTMLElement;
  private readonly savePanel: HTMLElement;
  private readonly joinPanel: HTMLElement;
  private readonly driverPanel: HTMLElement;
  private readonly teamHud: HTMLElement;
  private readonly transition: HTMLElement;
  private readonly transitionKicker: HTMLElement;
  private readonly transitionTitle: HTMLElement;
  private readonly transitionCopy: HTMLElement;
  private readonly transitionAction: HTMLButtonElement;
  private readonly transitionReplay: HTMLButtonElement;
  private readonly continueButton: HTMLButtonElement;
  private readonly newButton: HTMLButtonElement;
  private readonly tutorialButton: HTMLButtonElement;
  private readonly modeButtons = new Map<FrontDoorMode, HTMLButtonElement>();
  private readonly joinSeats = new Map<SeatSide, HTMLElement>();
  private readonly driverSeats = new Map<SeatSide, HTMLElement>();
  private readonly hudSeats = new Map<SeatSide, HTMLElement>();
  private readonly claims: Partial<Record<SeatSide, SeatClaim>> = {};
  private phase: FrontDoorPhase = 'hidden';
  private focusedMode: FrontDoorMode = 'independent';
  private resumeStation = 0;
  private playTutorial = true;
  private swapRoles = false;
  private savedStage = 0;
  private savedCompleted = false;
  private tutorialCompleted = false;
  private saveChoice: 'continue' | 'new' | 'tutorial' = 'continue';
  private preferredLeftIndex = 0;
  private preferredRightIndex = 1;
  private settleTimer = 0;
  private launchTimer = 0;
  private transitionTimer = 0;
  private transitionHold = false;

  constructor(
    parent: HTMLElement,
    private readonly callbacks: TeamExperienceCallbacks,
  ) {
    this.root = element('div', 'team-experience', parent);
    this.root.setAttribute('aria-live', 'polite');

    this.modePanel = element('section', 'team-front team-mode', this.root);
    this.modePanel.setAttribute('aria-label', '选择玩法');
    const modeHead = element('header', 'team-mode-head', this.modePanel);
    element('div', 'team-kicker', modeHead, 'BOARD RACE // PLAY DIRECTORY');
    element('h1', 'team-mode-title', modeHead, '选择玩法');
    element('p', 'team-mode-copy', modeHead, '同一片海域，不同的胜利关系。');
    const modeGrid = element('div', 'team-mode-grid', this.modePanel);
    this.createModeButton(modeGrid, 'independent', '01', '独立竞技', '个人航线', '争夺名次，独自完成七次飞行挑战。');
    this.createModeButton(modeGrid, 'team', '02', '队伍协作', '本地同屏', '互补能力、交换职责，完成三站协作。');
    element('div', 'team-mode-foot', this.modePanel, '方向选择 · 确认进入');

    this.savePanel = element('section', 'team-front team-save', this.root);
    this.savePanel.setAttribute('aria-label', '队伍协作进度');
    const saveHead = element('header', 'team-save-head', this.savePanel);
    element('div', 'team-kicker', saveHead, 'TEAM CO-OP');
    element('h2', 'team-save-title', saveHead, '队伍协作');
    this.continueButton = button('team-save-action team-save-continue', this.savePanel, '继续协作', () => {
      this.resumeStation = this.savedCompleted ? 0 : Math.max(0, this.savedStage - 1);
      this.playTutorial = false;
      this.swapRoles = false;
      this.showJoin();
    });
    this.newButton = button('team-save-action', this.savePanel, '从第一站开始', () => {
      this.resumeStation = 0;
      this.playTutorial = !this.tutorialCompleted;
      this.swapRoles = false;
      this.showJoin();
    });
    this.tutorialButton = button('team-save-action team-save-tutorial', this.savePanel, '重玩驾驶校准', () => {
      this.resumeStation = 0;
      this.playTutorial = true;
      this.swapRoles = false;
      this.showJoin();
    });
    button('team-text-action', this.savePanel, '返回玩法目录', () => this.showMode());

    this.joinPanel = element('section', 'team-front team-join', this.root);
    this.joinPanel.setAttribute('aria-label', '按键入座');
    const joinHeader = element('header', 'team-join-head', this.joinPanel);
    element('div', 'team-kicker', joinHeader, 'DEVICE SEATING');
    element('h2', 'team-join-title', joinHeader, '按键入座');
    element('p', 'team-join-copy', joinHeader, '在你的设备上按左或右，决定你负责的画面。');
    const joinGrid = element('div', 'team-join-grid', this.joinPanel);
    for (const side of SIDES) {
      const seat = element('article', `team-join-seat team-seat-${side}`, joinGrid);
      seat.dataset.side = side;
      element('div', 'team-seat-side', seat, side === 'left' ? 'LEFT' : 'RIGHT');
      element('div', 'team-seat-arrow', seat, side === 'left' ? '←' : '→');
      element('strong', 'team-seat-title', seat, SIDE_NAME[side]);
      element('span', 'team-seat-device', seat, '等待设备');
      this.joinSeats.set(side, seat);
    }
    const keyLegend = element('div', 'team-key-legend', this.joinPanel);
    element('span', '', keyLegend, '键盘左区 W A S D');
    element('span', '', keyLegend, '键盘右区方向键');
    element('span', '', keyLegend, '手柄方向键 / 摇杆');
    button('team-text-action team-join-back', this.joinPanel, '返回玩法目录', () => this.showMode());

    this.driverPanel = element('section', 'team-front team-drivers', this.root);
    this.driverPanel.setAttribute('aria-label', '队伍选手签约');
    const driverHeader = element('header', 'team-driver-head', this.driverPanel);
    element('div', 'team-kicker', driverHeader, 'TEAM CONTRACT');
    element('h2', 'team-driver-title', driverHeader, '各选一名选手');
    element('p', 'team-driver-copy', driverHeader, '左右只切换自己的选手，确认后锁定。');
    const driverGrid = element('div', 'team-driver-grid', this.driverPanel);
    for (const side of SIDES) {
      const seat = element('article', `team-driver-seat team-seat-${side}`, driverGrid);
      seat.dataset.side = side;
      const portraitFrame = element('div', 'team-driver-portrait-frame', seat);
      const portrait = document.createElement('img');
      portrait.className = 'team-driver-portrait';
      portrait.alt = '';
      portrait.draggable = false;
      portraitFrame.appendChild(portrait);
      const shade = element('div', 'team-driver-shade', seat);
      element('span', 'team-driver-screen', shade, side === 'left' ? '左侧画面' : '右侧画面');
      element('strong', 'team-driver-name', shade);
      element('span', 'team-driver-callsign', shade);
      element('span', 'team-driver-specialty', shade);
      element('span', 'team-driver-device', shade);
      const ready = button('team-driver-ready', shade, '确认锁定', () => {
        const claim = this.claims[side];
        if (!claim) return;
        claim.ready = !claim.ready;
        this.renderDrivers();
      });
      ready.setAttribute('aria-label', `${SIDE_NAME[side]}确认选手`);
      const previous = button('team-driver-nav team-driver-prev', seat, '←', () => this.moveDriver(side, -1));
      previous.title = '上一名选手';
      previous.setAttribute('aria-label', `${SIDE_NAME[side]}上一名选手`);
      const next = button('team-driver-nav team-driver-next', seat, '→', () => this.moveDriver(side, 1));
      next.title = '下一名选手';
      next.setAttribute('aria-label', `${SIDE_NAME[side]}下一名选手`);
      this.driverSeats.set(side, seat);
    }

    this.teamHud = element('div', 'team-game-hud', this.root);
    this.teamHud.setAttribute('aria-hidden', 'true');
    for (const side of SIDES) {
      const seat = element('section', `team-hud-seat team-seat-${side}`, this.teamHud);
      seat.dataset.side = side;
      const identity = element('div', 'team-hud-identity', seat);
      const portrait = document.createElement('img');
      portrait.className = 'team-hud-portrait';
      portrait.alt = '';
      identity.appendChild(portrait);
      const copy = element('div', 'team-hud-copy', identity);
      element('strong', 'team-hud-name', copy);
      element('span', 'team-hud-role', copy);
      const objective = element('div', 'team-hud-objective', seat);
      element('span', 'team-hud-status', objective);
      const meter = element('div', 'team-link-meter', objective);
      element('i', '', meter);
      element('span', 'team-hud-action', objective);
      element('b', 'team-hud-speed', seat);
      element('div', 'team-device-lost', seat, '设备已断开');
      this.hudSeats.set(side, seat);
    }
    const mission = element('div', 'team-mission', this.teamHud);
    element('span', 'team-mission-stage', mission);
    element('strong', 'team-mission-objective', mission);
    element('time', 'team-mission-time', mission);

    this.transition = element('section', 'team-transition', this.root);
    this.transitionKicker = element('div', 'team-transition-kicker', this.transition);
    this.transitionTitle = element('strong', 'team-transition-title', this.transition);
    this.transitionCopy = element('span', 'team-transition-copy', this.transition);
    this.transitionAction = button('team-transition-action', this.transition, '返回玩法目录', () => {
      this.callbacks.onExitTeam();
    });
    this.transitionReplay = button('team-transition-action team-transition-replay', this.transition, '交换职责再玩', () => {
      this.callbacks.onReplayTeam();
    });
    this.transitionAction.hidden = true;
    this.transitionReplay.hidden = true;
    this.hideAll();
  }

  showMode(): void {
    this.hideTransition();
    this.phase = 'mode';
    this.focusedMode = 'independent';
    this.claims.left = undefined;
    this.claims.right = undefined;
    this.settleTimer = 0;
    this.launchTimer = 0;
    this.hidePanels();
    this.modePanel.classList.add('on');
    this.root.classList.add('on');
    this.renderMode();
  }

  showGameplay(): void {
    this.phase = 'hidden';
    this.hidePanels();
    this.root.classList.add('on', 'playing');
    this.teamHud.classList.add('on');
    this.teamHud.setAttribute('aria-hidden', 'false');
  }

  hideAll(): void {
    this.phase = 'hidden';
    this.hidePanels();
    this.root.classList.remove('on', 'playing');
    this.teamHud.classList.remove('on');
    this.transition.classList.remove('on');
  }

  setSavedStage(stage: number, completed = false, tutorialCompleted = false): void {
    this.savedStage = Math.max(0, Math.min(3, Math.floor(stage)));
    this.savedCompleted = completed;
    this.tutorialCompleted = tutorialCompleted;
    this.continueButton.hidden = this.savedStage <= 0;
    this.continueButton.textContent = this.savedCompleted
      ? '再玩三站协作'
      : `继续协作 · 第 ${this.savedStage} 站`;
    this.tutorialButton.hidden = !this.tutorialCompleted;
  }

  setSavedDrivers(leftId: string, rightId: string): void {
    this.preferredLeftIndex = Math.max(0, DRIVER_PROFILES.findIndex((profile) => profile.id === leftId));
    this.preferredRightIndex = Math.max(0, DRIVER_PROFILES.findIndex((profile) => profile.id === rightId));
    if (this.preferredRightIndex === this.preferredLeftIndex) {
      this.preferredRightIndex = (this.preferredLeftIndex + 1) % DRIVER_PROFILES.length;
    }
  }

  update(dt: number, input: LocalMultiplayerInput): void {
    if (this.phase === 'hidden') return;
    if (this.phase === 'mode') this.updateMode(input);
    else if (this.phase === 'save-choice') this.updateSaveChoice(input);
    else if (this.phase === 'join') this.updateJoin(dt, input);
    else if (this.phase === 'drivers') this.updateDrivers(dt, input);
    input.endFrame();
  }

  updateHud(state: TeamHudState): void {
    this.teamHud.querySelector<HTMLElement>('.team-mission-stage')!.textContent =
      `${state.stationName} · ${state.station} / ${state.totalStations}`;
    this.teamHud.querySelector<HTMLElement>('.team-mission-objective')!.textContent = state.objective;
    this.teamHud.querySelector<HTMLTimeElement>('.team-mission-time')!.textContent = formatTime(state.elapsed);
    for (const side of SIDES) {
      const data = state[side];
      const seat = this.hudSeats.get(side)!;
      const portrait = seat.querySelector<HTMLImageElement>('.team-hud-portrait')!;
      portrait.src = data.profile.portraitUrl;
      portrait.style.objectPosition = data.profile.portraitPosition;
      seat.style.setProperty('--seat-color', hex(data.profile.color));
      seat.dataset.role = data.role;
      seat.dataset.hint = String(state.hintLevel);
      seat.classList.toggle('ready', data.ready);
      seat.classList.toggle('lost', data.disconnected);
      seat.querySelector<HTMLElement>('.team-hud-name')!.textContent = data.profile.name;
      seat.querySelector<HTMLElement>('.team-hud-role')!.textContent = ROLE_LABEL[data.role];
      seat.querySelector<HTMLElement>('.team-hud-status')!.textContent = data.status;
      seat.querySelector<HTMLElement>('.team-hud-action')!.textContent = `${data.actionLabel} · ${state.beat} / ${state.beatTotal}`;
      seat.querySelector<HTMLElement>('.team-hud-speed')!.textContent = `${Math.round(data.speedKmh)} km/h`;
      seat.querySelector<HTMLElement>('.team-link-meter i')!.style.transform = `scaleX(${clamp01(state.progress)})`;
    }
  }

  showTransition(kicker: string, title: string, copy: string, seconds: number, hold = false, replay = false): void {
    this.transitionKicker.textContent = kicker;
    this.transitionTitle.textContent = title;
    this.transitionCopy.textContent = copy;
    this.transitionTimer = Math.max(0, seconds);
    this.transitionHold = hold;
    this.transitionAction.hidden = !hold || title === '设备已断开';
    this.transitionReplay.hidden = !replay;
    this.transition.classList.add('on');
  }

  updateTransition(dt: number): void {
    if (!this.transition.classList.contains('on') || this.transitionHold) return;
    this.transitionTimer = Math.max(0, this.transitionTimer - dt);
    if (this.transitionTimer <= 0) this.transition.classList.remove('on');
  }

  hideTransition(): void {
    this.transitionHold = false;
    this.transitionTimer = 0;
    this.transition.classList.remove('on');
    this.transitionReplay.hidden = true;
  }

  private createModeButton(
    parent: HTMLElement,
    mode: FrontDoorMode,
    index: string,
    title: string,
    meta: string,
    copy: string,
  ): void {
    const item = button(`team-mode-item team-mode-${mode}`, parent, '', () => this.activateMode(mode));
    item.dataset.mode = mode;
    element('span', 'team-mode-index', item, index);
    const body = element('span', 'team-mode-body', item);
    element('strong', '', body, title);
    element('small', '', body, meta);
    element('span', '', body, copy);
    element('b', 'team-mode-enter', item, '→');
    this.modeButtons.set(mode, item);
  }

  private updateMode(input: LocalMultiplayerInput): void {
    for (const device of input.devices()) {
      const edges = input.menuEdges(device.id);
      if (edges.left || edges.right) {
        this.callbacks.onAudioIntent();
        this.focusedMode = edges.right ? 'team' : 'independent';
        this.renderMode();
      }
      if (edges.confirm) {
        this.callbacks.onAudioIntent();
        this.activateMode(this.focusedMode);
        return;
      }
    }
  }

  private updateSaveChoice(input: LocalMultiplayerInput): void {
    for (const device of input.devices()) {
      const edges = input.menuEdges(device.id);
      if (edges.cancel) {
        this.showMode();
        return;
      }
      if (edges.left || edges.right) {
        const choices: Array<'continue' | 'new' | 'tutorial'> = [
          ...(this.savedStage > 0 ? ['continue' as const] : []),
          'new',
          ...(this.tutorialCompleted ? ['tutorial' as const] : []),
        ];
        const current = Math.max(0, choices.indexOf(this.saveChoice));
        this.saveChoice = choices[(current + (edges.right ? 1 : choices.length - 1)) % choices.length];
        this.renderSaveChoice();
      }
      if (edges.confirm) {
        this.resumeStation = this.saveChoice === 'continue' && this.savedStage > 0 && !this.savedCompleted
          ? this.savedStage - 1
          : 0;
        this.playTutorial = this.saveChoice === 'tutorial' || (this.saveChoice === 'new' && !this.tutorialCompleted);
        this.swapRoles = false;
        this.showJoin();
        return;
      }
    }
  }

  private activateMode(mode: FrontDoorMode): void {
    this.callbacks.onAudioIntent();
    if (mode === 'independent') {
      this.hideAll();
      this.callbacks.onIndependent();
      return;
    }
    this.phase = this.savedStage > 0 || this.tutorialCompleted ? 'save-choice' : 'join';
    if (this.phase === 'save-choice') {
      this.saveChoice = this.savedStage > 0 ? 'continue' : 'new';
      this.hidePanels();
      this.savePanel.classList.add('on');
      this.renderSaveChoice();
    } else this.showJoin();
  }

  private showJoin(): void {
    this.phase = 'join';
    this.settleTimer = 0;
    this.launchTimer = 0;
    this.claims.left = undefined;
    this.claims.right = undefined;
    this.hidePanels();
    this.joinPanel.classList.add('on');
    this.renderJoin();
  }

  private updateJoin(dt: number, input: LocalMultiplayerInput): void {
    let changed = false;
    for (const side of SIDES) {
      const claim = this.claims[side];
      if (claim && !input.connected(claim.deviceId)) {
        this.claims[side] = undefined;
        changed = true;
      }
    }
    for (const device of input.devices()) {
      const edges = input.menuEdges(device.id);
      const current = this.sideForDevice(device.id);
      if (edges.cancel && current) {
        this.claims[current] = undefined;
        changed = true;
        continue;
      }
      const desired: SeatSide | null = edges.left ? 'left' : edges.right ? 'right' : null;
      if (!desired) continue;
      this.callbacks.onAudioIntent();
      if (current === desired) continue;
      if (this.claims[desired]) {
        this.flashBusy(desired);
        continue;
      }
      if (current) this.claims[current] = undefined;
      this.claims[desired] = this.claimFrom(device, desired);
      changed = true;
    }
    if (changed) this.renderJoin();
    if (this.claims.left && this.claims.right) {
      this.settleTimer += dt;
      if (this.settleTimer >= 0.45) this.showDrivers();
    } else this.settleTimer = 0;
  }

  private showDrivers(): void {
    const left = this.claims.left;
    const right = this.claims.right;
    if (!left || !right) return;
    left.profileIndex = this.preferredLeftIndex;
    left.ready = false;
    right.profileIndex = this.preferredRightIndex;
    right.ready = false;
    this.phase = 'drivers';
    this.hidePanels();
    this.driverPanel.classList.add('on');
    this.renderDrivers();
  }

  private updateDrivers(dt: number, input: LocalMultiplayerInput): void {
    for (const side of SIDES) {
      const claim = this.claims[side];
      if (!claim) {
        this.showJoin();
        return;
      }
      if (!input.connected(claim.deviceId)) {
        this.claims[side] = undefined;
        this.phase = 'join';
        this.hidePanels();
        this.joinPanel.classList.add('on');
        this.renderJoin();
        return;
      }
      const edges = input.menuEdges(claim.deviceId);
      if (edges.cancel) {
        if (claim.ready) claim.ready = false;
        else {
          this.phase = 'join';
          this.hidePanels();
          this.joinPanel.classList.add('on');
          this.renderJoin();
          return;
        }
      }
      if (!claim.ready && (edges.left || edges.right)) this.moveDriver(side, edges.left ? -1 : 1);
      if (edges.confirm) claim.ready = !claim.ready;
    }
    this.renderDrivers();
    if (this.claims.left?.ready && this.claims.right?.ready) {
      this.launchTimer += dt;
      if (this.launchTimer >= 0.55) this.startTeam();
    } else this.launchTimer = 0;
  }

  private moveDriver(side: SeatSide, direction: -1 | 1): void {
    const claim = this.claims[side];
    if (!claim || claim.ready) return;
    const other = this.claims[side === 'left' ? 'right' : 'left'];
    for (let step = 0; step < DRIVER_PROFILES.length; step++) {
      claim.profileIndex = wrap(claim.profileIndex + direction, DRIVER_PROFILES.length);
      if (!other || claim.profileIndex !== other.profileIndex) break;
    }
    this.callbacks.onAudioIntent();
    this.renderDrivers();
  }

  private startTeam(): void {
    const left = this.claims.left;
    const right = this.claims.right;
    if (!left || !right) return;
    this.phase = 'hidden';
    this.hidePanels();
    this.callbacks.onTeamStart({
      left: { deviceId: left.deviceId, profile: DRIVER_PROFILES[left.profileIndex] },
      right: { deviceId: right.deviceId, profile: DRIVER_PROFILES[right.profileIndex] },
      resumeStation: this.resumeStation,
      playTutorial: this.playTutorial,
      swapRoles: this.swapRoles,
    });
  }

  private renderMode(): void {
    for (const [mode, button] of this.modeButtons) {
      const active = mode === this.focusedMode;
      button.classList.toggle('selected', active);
      button.setAttribute('aria-current', active ? 'true' : 'false');
    }
  }

  private renderSaveChoice(): void {
    this.continueButton.classList.toggle('selected', this.saveChoice === 'continue');
    this.newButton.classList.toggle('selected', this.saveChoice === 'new');
    this.tutorialButton.classList.toggle('selected', this.saveChoice === 'tutorial');
  }

  private renderJoin(): void {
    for (const side of SIDES) {
      const seat = this.joinSeats.get(side)!;
      const claim = this.claims[side];
      seat.classList.toggle('claimed', Boolean(claim));
      seat.querySelector<HTMLElement>('.team-seat-device')!.textContent = claim?.label ?? '等待设备';
      seat.querySelector<HTMLElement>('.team-seat-title')!.textContent = claim ? '已入座' : SIDE_NAME[side];
    }
  }

  private renderDrivers(): void {
    for (const side of SIDES) {
      const claim = this.claims[side];
      if (!claim) continue;
      const profile = DRIVER_PROFILES[claim.profileIndex];
      const seat = this.driverSeats.get(side)!;
      const portrait = seat.querySelector<HTMLImageElement>('.team-driver-portrait')!;
      portrait.src = profile.portraitUrl;
      portrait.style.objectPosition = profile.portraitPosition;
      seat.style.setProperty('--seat-color', hex(profile.color));
      seat.classList.toggle('ready', claim.ready);
      seat.querySelector<HTMLElement>('.team-driver-name')!.textContent = profile.name;
      seat.querySelector<HTMLElement>('.team-driver-callsign')!.textContent = `${profile.callsign} · ${profile.mood}`;
      seat.querySelector<HTMLElement>('.team-driver-specialty')!.textContent = `${profile.specialty} · ${profile.strength}`;
      seat.querySelector<HTMLElement>('.team-driver-device')!.textContent = claim.label;
      seat.querySelector<HTMLElement>('.team-driver-ready')!.textContent = claim.ready ? '已锁定' : '确认锁定';
    }
  }

  private sideForDevice(id: LocalDeviceId): SeatSide | null {
    if (this.claims.left?.deviceId === id) return 'left';
    if (this.claims.right?.deviceId === id) return 'right';
    return null;
  }

  private claimFrom(device: LocalDeviceInfo, side: SeatSide): SeatClaim {
    return {
      deviceId: device.id,
      label: device.label,
      profileIndex: side === 'left' ? 0 : 1,
      ready: false,
    };
  }

  private flashBusy(side: SeatSide): void {
    const seat = this.joinSeats.get(side);
    if (!seat) return;
    seat.classList.remove('busy');
    requestAnimationFrame(() => seat.classList.add('busy'));
    window.setTimeout(() => seat.classList.remove('busy'), 320);
  }

  private hidePanels(): void {
    this.modePanel.classList.remove('on');
    this.savePanel.classList.remove('on');
    this.joinPanel.classList.remove('on');
    this.driverPanel.classList.remove('on');
  }
}

export interface TeamSaveData {
  version: 2;
  stage: number;
  completed: boolean;
  tutorialCompleted: boolean;
  bestMs: number | null;
  leftDriverId: string;
  rightDriverId: string;
}

export function loadTeamSave(): TeamSaveData {
  const fallback: TeamSaveData = {
    version: 2,
    stage: 0,
    completed: false,
    tutorialCompleted: false,
    bestMs: null,
    leftDriverId: 'axle',
    rightDriverId: 'tide',
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(TEAM_STORAGE_KEY) ?? 'null') as Partial<TeamSaveData> | null;
    if (!parsed) {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_TEAM_STORAGE_KEY) ?? 'null') as Partial<TeamSaveData> | null;
      if (!legacy) return fallback;
      return {
        ...fallback,
        leftDriverId: DRIVER_PROFILES.some((profile) => profile.id === legacy.leftDriverId) ? legacy.leftDriverId! : 'axle',
        rightDriverId: DRIVER_PROFILES.some((profile) => profile.id === legacy.rightDriverId) ? legacy.rightDriverId! : 'tide',
      };
    }
    return {
      version: 2,
      stage: Math.max(0, Math.min(3, Math.floor(Number(parsed.stage) || 0))),
      completed: parsed.completed === true,
      tutorialCompleted: parsed.tutorialCompleted === true,
      bestMs: Number.isFinite(parsed.bestMs) && Number(parsed.bestMs) > 0 ? Number(parsed.bestMs) : null,
      leftDriverId: DRIVER_PROFILES.some((profile) => profile.id === parsed.leftDriverId) ? parsed.leftDriverId! : 'axle',
      rightDriverId: DRIVER_PROFILES.some((profile) => profile.id === parsed.rightDriverId) ? parsed.rightDriverId! : 'tide',
    };
  } catch {
    return fallback;
  }
}

export function saveTeamProgress(data: TeamSaveData): void {
  try {
    localStorage.setItem(TEAM_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // A blocked storage write never interrupts active play.
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function button(className: string, parent: HTMLElement, text: string, onClick: () => void): HTMLButtonElement {
  const node = element('button', className, parent, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function wrap(value: number, length: number): number {
  return (value % length + length) % length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
