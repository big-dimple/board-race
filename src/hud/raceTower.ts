import type { RaceBattleEvent, RacerDefinition, RaceView } from '../contracts';
import { driverProfile, type DriverMood, type DriverProfile } from '../game/racers';
import { RadioDirector, type RadioNotice, type RadioSpeaker } from '../game/radioDirector';
import './raceTower.css';

const TEAM_SPEAKER: RadioSpeaker = { kind: 'team', name: '车队', color: 0x55e7ff, icon: '电' };

/** `solo` spans the whole screen; `left`/`right` keep the tower inside one half. */
export type TowerSide = 'solo' | 'left' | 'right';

const COLLISION_LINES: Record<DriverMood, string> = {
  '沉稳': '这一下接触不轻。你先稳住，这账下一段再算。',
  '骄傲': '看见没，这条线归我。刚才那下碰撞，长点记性。',
  '愤怒': '碰撞是吧？好，别松油，马上原样还你！',
  '专注': '接触确认，船头没飘。下个弯再跟他算。',
  '兴奋': '哈哈，这一撞够劲！再来一次试试？',
  '冷酷': '碰撞而已。我的线路一寸没丢。',
};

const GO_LINES = (name: string): string[] => [
  `${name}，绿灯亮了！航线清空，先把首飞拿下。`,
  `走！${name}，整条线都是你的，首飞在等你。`,
  `${name}，出发！漂过黄线再松手，首飞稳稳入账。`,
  `车队电台：${name} 已放行。别恋战水面，先飞一次再说。`,
];

const OVERTAKE_LINES = (name: string): string[] => [
  `超过 ${name} 了！内线锁死，别给他尾流机会。`,
  `${name} 已经过去了，干净利落！出弯继续保持。`,
  `内线得手——${name} 现在只能看你的尾流。`,
];

const LOST_LINES = (name: string): string[] => [
  `${name} 超到前面了……别急，差距还在一击范围。`,
  `位置被 ${name} 拿走了。稳住节奏，下个弯收回来。`,
  `让 ${name} 先得意一阵，下个弯我们把位置拿回来。`,
];

const FLIGHT_THREE_LINES = (best: number): string[] => [
  `三飞认证！勋章到手，BEST ${best}。`,
  `三飞完成，漂亮！远海档案开局，下一局冲优秀。`,
  `认证通过！${best} 飞记录入账，继续抢线别松劲。`,
];

const FLIGHT_SEVEN_LINES: string[] = [
  '七飞认证！终点站已经为你开门！',
  '七飞全满贯！回港冲线，加冕时刻到了！',
  '难以置信的一局——七飞达成，终点站见！',
];

const TECHNIQUE_TIP_LINES: string[] = [
  '弯急别硬拧，先空刹把速度咬下来，再打方向。',
  '记住：进急弯先空刹减速，船头听话了再转。',
  '急弯前的秘诀就一句——先空刹，后转向。',
];

export class RaceTower {
  readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly radio: HTMLDivElement;
  private readonly radioPortrait: HTMLImageElement;
  private readonly radioMark: HTMLSpanElement;
  private readonly radioMeta: HTMLDivElement;
  private readonly radioBody: HTMLDivElement;
  private readonly radioDirector = new RadioDirector();
  private definitions: readonly RacerDefinition[] = [];
  private readonly rows = new Map<number, HTMLDivElement>();
  private readonly rowCache = new Map<number, { order: number; isPlayer: boolean; nearPlayer: boolean; isLeader: boolean; placeText: string; gapText: string }>();
  private accumulator = 0;
  private battleIndex = 0;
  private flightIndex = 0;
  private collisionIndex = 0;
  private collisionLinesShown = 0;
  private lastCollisionLineAt = -Infinity;
  // Cross-run counters: the GO/tip key dedups within a run, so these pick a
  // fresh line each new run instead of replaying the first one forever.
  private goIndex = 0;
  private tipIndex = 0;
  private raceTime = 0;
  private renderedRevision = -1;
  /** Which human this tower stands for; null falls back to the first player. */
  private seatId: number | null = null;

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  /** Re-place the tower when the run switches between solo and split play. */
  setSide(side: TowerSide): void {
    this.root.dataset.side = side;
  }

  /** In split play each tower highlights and follows its own seat. */
  setSeat(seatId: number | null): void {
    this.seatId = seatId;
  }

  constructor(parent: HTMLElement, side: TowerSide = 'solo') {
    this.root = node('div', 'race-tower', parent);
    this.root.dataset.side = side;
    node('div', 'race-tower-head', this.root, '排名实况');
    this.list = node('div', 'race-tower-list', this.root);
    this.radio = node('div', 'race-radio', this.root);
    const avatar = node('div', 'race-radio-avatar', this.radio);
    this.radioPortrait = document.createElement('img');
    this.radioPortrait.alt = '';
    avatar.appendChild(this.radioPortrait);
    this.radioMark = node('span', 'race-radio-mark', avatar, 'W');
    const copy = node('div', 'race-radio-copy', this.radio);
    this.radioMeta = node('div', 'race-radio-meta', copy);
    this.radioBody = node('div', 'race-radio-body', copy);
    this.radio.setAttribute('role', 'status');
    this.radio.setAttribute('aria-live', 'polite');
    this.radio.setAttribute('aria-atomic', 'true');
  }

  setRoster(definitions: readonly RacerDefinition[]): void {
    this.definitions = definitions;
    this.rows.clear();
    this.rowCache.clear();
    this.list.replaceChildren();
    for (const def of definitions) {
      const row = node('div', 'race-tower-row', this.list);
      row.dataset.id = String(def.id);
      const place = node('span', 'race-tower-place', row);
      place.textContent = String(def.startPlace).padStart(2, '0');
      const img = document.createElement('img');
      img.src = def.portraitUrl;
      img.alt = '';
      img.style.objectPosition = driverProfile(def.profileId).portraitPosition;
      row.appendChild(img);
      node('span', 'race-tower-name', row, def.name);
      node('span', 'race-tower-gap', row, '排位');
      row.style.setProperty('--racer-color', `#${def.color.toString(16).padStart(6, '0')}`);
      this.rows.set(def.id, row);
    }
  }

  resetRun(seed: number): void {
    void seed;
    this.battleIndex = 0;
    this.flightIndex = 0;
    this.collisionIndex = 0;
    this.collisionLinesShown = 0;
    this.lastCollisionLineAt = -Infinity;
    this.raceTime = 0;
    this.radioDirector.resetRun();
    this.renderedRevision = -1;
    this.radio.classList.remove('on', 'blocked', 'paused');
    this.root.classList.remove('broadcasting');
  }

  update(dt: number, race: RaceView, flightFocus = false, presentationBlocked = false): void {
    this.raceTime = race.raceTime;
    this.root.classList.toggle('on', race.phase === 'racing' || race.phase === 'countdown' || race.phase === 'resume-countdown');
    // The grid introduction is useful during 3/2/1 and the opening seconds.
    // Once racing settles, retain only the player's immediate battle group.
    this.root.classList.toggle('compact', race.phase === 'racing' && race.raceTime > 3);
    this.root.classList.toggle('flight-focus', flightFocus);
    const blocked = flightFocus || presentationBlocked || race.phase !== 'racing';
    const notice = this.radioDirector.update(dt, blocked);
    if (this.renderedRevision !== this.radioDirector.revision) {
      this.renderedRevision = this.radioDirector.revision;
      this.renderNotice(notice);
    }
    const hasNotice = Boolean(notice);
    this.radio.classList.toggle('on', hasNotice);
    this.radio.classList.toggle('blocked', hasNotice && blocked);
    this.radio.classList.toggle('paused', hasNotice && blocked);
    this.root.classList.toggle('broadcasting', notice?.presentation === 'broadcast' && !blocked);
    this.accumulator += dt;
    if (this.accumulator < 0.1) return;
    this.accumulator = 0;
    const order = [...race.racers].sort((a, b) => a.place - b.place);
    const player = this.seatId === null
      ? race.racers.find((racer) => racer.isPlayer)
      : race.racers.find((racer) => racer.id === this.seatId);
    for (let i = 0; i < order.length; i++) {
      const racer = order[i];
      const row = this.rows.get(racer.id);
      if (!row) continue;
      // Change-gate every write: this block runs 10x/s for the whole race and
      // unconditional style/text writes dirty the layout ten times a second.
      const cache = this.rowCache.get(racer.id);
      const isPlayer = racer.isPlayer;
      const nearPlayer = !!player && Math.abs(racer.place - player.place) <= 1;
      const isLeader = i === 0 && !racer.finished;
      const placeText = String(racer.place).padStart(2, '0');
      const gapText = racer.finished ? '完赛' : i === 0 ? '领跑' : `-${Math.max(0, order[i - 1].progress - racer.progress).toFixed(1)}m`;
      if (!cache) {
        this.rowCache.set(racer.id, { order: racer.place, isPlayer, nearPlayer, isLeader, placeText, gapText });
        row.style.order = String(racer.place);
        row.classList.toggle('player', isPlayer);
        row.classList.toggle('near-player', nearPlayer);
        row.classList.toggle('leader', isLeader);
        const place = row.querySelector<HTMLElement>('.race-tower-place');
        if (place) place.textContent = placeText;
        const gap = row.querySelector<HTMLElement>('.race-tower-gap');
        if (gap) gap.textContent = gapText;
        continue;
      }
      if (cache.order !== racer.place) {
        cache.order = racer.place;
        row.style.order = String(racer.place);
      }
      if (cache.isPlayer !== isPlayer) {
        cache.isPlayer = isPlayer;
        row.classList.toggle('player', isPlayer);
      }
      if (cache.nearPlayer !== nearPlayer) {
        cache.nearPlayer = nearPlayer;
        row.classList.toggle('near-player', nearPlayer);
      }
      if (cache.isLeader !== isLeader) {
        cache.isLeader = isLeader;
        row.classList.toggle('leader', isLeader);
      }
      if (cache.placeText !== placeText) {
        cache.placeText = placeText;
        const place = row.querySelector<HTMLElement>('.race-tower-place');
        if (place) place.textContent = placeText;
      }
      if (cache.gapText !== gapText) {
        cache.gapText = gapText;
        const gap = row.querySelector<HTMLElement>('.race-tower-gap');
        if (gap) gap.textContent = gapText;
      }
    }
  }

  announceGo(playerName: string): void {
    const messages = GO_LINES(playerName);
    const index = this.goIndex++ % messages.length;
    this.enqueue({
      key: 'go', speaker: TEAM_SPEAKER,
      message: messages[index],
      priority: 'tactical', duration: 3.0, ttl: 8,
    });
  }

  announceBattle(event: RaceBattleEvent): void {
    const name = event.opponents[0]?.name ?? '对手';
    const messages = event.kind === 'overtake' ? OVERTAKE_LINES(name) : LOST_LINES(name);
    const index = this.battleIndex++ % messages.length;
    this.enqueue({
      key: `battle-${event.kind}-${index}`, speaker: TEAM_SPEAKER,
      message: messages[index], priority: 'tactical', duration: 2.5, ttl: 4,
    });
  }

  announceFlight(flights: number, best: number): void {
    if (flights !== 3 && flights < 7) return;
    const messages = flights === 3 ? FLIGHT_THREE_LINES(best) : FLIGHT_SEVEN_LINES;
    const index = this.flightIndex++ % messages.length;
    this.enqueue({
      key: `flight-${flights}-${index}`, speaker: TEAM_SPEAKER,
      message: messages[index], priority: 'critical', duration: 3.4, ttl: 4,
    });
  }

  announceTechniqueTip(): boolean {
    const sol = driverProfile('sol');
    const message = TECHNIQUE_TIP_LINES[this.tipIndex++ % TECHNIQUE_TIP_LINES.length];
    return this.enqueue({
      key: 'gemini-opening-airbrake-tip',
      speaker: driverSpeaker(sol),
      meta: `${sol.callsign} // 插一句`,
      message,
      emphasis: '先空刹',
      presentation: 'broadcast',
      priority: 'tactical',
      duration: 5.65,
      sessionKey: 'gemini-airbrake-technique',
      // Opening guidance can wait behind the GO/team slot and the first
      // action cue without disappearing before a returning player sees it.
      ttl: 60,
    });
  }

  announceCollision(opponent: RacerDefinition | undefined, strength: number, side: number): void {
    if (strength <= 10 || !opponent || this.collisionLinesShown >= 2 || this.raceTime - this.lastCollisionLineAt < 8) return;
    const collisionNumber = this.collisionIndex++;
    void side;
    const profile = driverProfile(opponent.profileId);
    this.collisionLinesShown++;
    this.lastCollisionLineAt = this.raceTime;
    this.enqueue({
      key: `collision-driver-${collisionNumber}`,
      sessionKey: profile.mood === '兴奋' ? 'radio-profanity' : undefined,
      speaker: driverSpeaker(profile),
      message: COLLISION_LINES[profile.mood],
      priority: 'critical', duration: 3.4, ttl: 3,
    });
  }

  radioStatus(): Record<string, number | string | boolean> {
    return this.radioDirector.status();
  }

  /** Whether a notice key was shown, is active, or sits in the queue. */
  radioHas(key: string): boolean {
    return this.radioDirector.hasKey(key);
  }

  private enqueue(notice: RadioNotice): boolean {
    return this.radioDirector.enqueue(notice);
  }

  private renderNotice(notice: RadioNotice | null): void {
    if (!notice) {
      this.radio.removeAttribute('aria-label');
      return;
    }
    const speaker = notice.speaker;
    this.radio.classList.toggle('broadcast', notice.presentation === 'broadcast');
    const color = `#${speaker.color.toString(16).padStart(6, '0')}`;
    this.radio.style.setProperty('--radio-color', color);
    this.radioMeta.textContent = notice.meta ?? `${speaker.icon ? `${speaker.icon} ` : ''}${speaker.name}`;
    this.radioBody.replaceChildren();
    if (notice.emphasis && notice.message.includes(notice.emphasis)) {
      const [before, after] = notice.message.split(notice.emphasis);
      if (before) this.radioBody.appendChild(document.createTextNode(before));
      const emphasis = document.createElement('strong');
      emphasis.textContent = notice.emphasis;
      this.radioBody.appendChild(emphasis);
      if (after) this.radioBody.appendChild(document.createTextNode(after));
    } else {
      this.radioBody.textContent = notice.message;
    }
    const driver = speaker.kind === 'driver' && speaker.portraitUrl;
    this.radioPortrait.hidden = !driver;
    this.radioMark.hidden = Boolean(driver);
    if (driver) {
      this.radioPortrait.src = speaker.portraitUrl!;
      this.radioPortrait.style.objectPosition = speaker.portraitPosition ?? '50% 20%';
    } else {
      this.radioMark.textContent = speaker.icon ?? '电';
    }
    this.radio.setAttribute('aria-label', `${speaker.name}：${notice.message}`);
  }
}

function driverSpeaker(profile: DriverProfile): RadioSpeaker {
  return {
    kind: 'driver',
    name: profile.callsign,
    color: profile.color,
    portraitUrl: profile.portraitUrl,
    portraitPosition: profile.portraitPosition,
    icon: profile.moodIcon,
  };
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  parent.appendChild(el);
  return el;
}
