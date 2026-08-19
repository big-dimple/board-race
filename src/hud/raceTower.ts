import type { RaceBattleEvent, RacerDefinition, RaceView } from '../contracts';
import { driverProfile, type DriverMood, type DriverProfile } from '../game/racers';
import { RadioDirector, type RadioNotice, type RadioSpeaker } from '../game/radioDirector';
import './raceTower.css';

const TEAM_SPEAKER: RadioSpeaker = { kind: 'team', name: 'TEAM', color: 0x55e7ff, icon: 'W' };

const COLLISION_LINES: Record<DriverMood, string> = {
  '沉稳': '这一下算你狠。稳住，下一段见。',
  '骄傲': '这条线我先拿了。',
  '愤怒': '这才叫抢线。别松油。',
  '专注': '接触确认。下个弯再算。',
  '兴奋': '这一下够重。再来一次？',
  '冷酷': '接触而已。线路没丢。',
};

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
  private accumulator = 0;
  private battleIndex = 0;
  private flightIndex = 0;
  private collisionIndex = 0;
  private collisionLinesShown = 0;
  private lastCollisionLineAt = -Infinity;
  private raceTime = 0;
  private renderedRevision = -1;

  constructor(parent: HTMLElement) {
    this.root = node('div', 'race-tower', parent);
    node('div', 'race-tower-head', this.root, 'W.H.L // LIVE');
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
      node('span', 'race-tower-gap', row, 'GRID');
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
    const player = race.racers.find((racer) => racer.isPlayer);
    for (let i = 0; i < order.length; i++) {
      const racer = order[i];
      const row = this.rows.get(racer.id);
      if (!row) continue;
      row.style.order = String(racer.place);
      row.classList.toggle('player', racer.isPlayer);
      row.classList.toggle('near-player', !!player && Math.abs(racer.place - player.place) <= 1);
      const place = row.querySelector<HTMLElement>('.race-tower-place');
      const gap = row.querySelector<HTMLElement>('.race-tower-gap');
      if (place) place.textContent = String(racer.place).padStart(2, '0');
      if (gap) {
        if (racer.finished) gap.textContent = 'FIN';
        else if (i === 0) gap.textContent = 'LEADER';
        else gap.textContent = `-${Math.max(0, order[i - 1].progress - racer.progress).toFixed(1)}m`;
      }
    }
  }

  announceGo(playerName: string): void {
    this.enqueue({
      key: 'go', speaker: TEAM_SPEAKER,
      message: `${playerName}，线路开放。先拿首飞。`,
      priority: 'tactical', duration: 2.2, ttl: 8,
    });
  }

  announceBattle(event: RaceBattleEvent): void {
    const name = event.opponents[0]?.name ?? '对手';
    const messages = event.kind === 'overtake'
      ? [`超过 ${name}。内线锁住。`, `${name} 在尾流里，出弯别给机会。`]
      : [`${name} 超到前面了。差距还在一击范围。`, `盯住 ${name}。下个弯收回来。`];
    const index = this.battleIndex++ % messages.length;
    this.enqueue({
      key: `battle-${event.kind}-${index}`, speaker: TEAM_SPEAKER,
      message: messages[index], priority: 'tactical', duration: 2.5, ttl: 4,
    });
  }

  announceFlight(flights: number, best: number): void {
    if (flights !== 3 && flights < 7) return;
    const messages = flights === 3
      ? [`三飞认证。远海档案开局，BEST ${best}。`, '勋章已入账。下一段，继续抢线。']
      : ['七飞认证。终点站，为你开门。'];
    const index = this.flightIndex++ % messages.length;
    this.enqueue({
      key: `flight-${flights}-${index}`, speaker: TEAM_SPEAKER,
      message: messages[index], priority: 'critical', duration: 2.4, ttl: 4,
    });
  }

  announceTechniqueTip(): void {
    const sol = driverProfile('sol');
    this.enqueue({
      key: 'gemini-opening-airbrake-tip',
      speaker: driverSpeaker(sol),
      meta: `${sol.callsign} // 插一句`,
      message: '弯急别硬拧，先空刹再转。',
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
      priority: 'critical', duration: 2.8, ttl: 3,
    });
  }

  radioStatus(): Record<string, number | string | boolean> {
    return this.radioDirector.status();
  }

  private enqueue(notice: RadioNotice): void {
    this.radioDirector.enqueue(notice);
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
      this.radioMark.textContent = speaker.icon ?? 'W';
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
