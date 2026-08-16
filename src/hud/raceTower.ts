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
  '兴奋': '卧槽，这一下够结实。再来？',
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
  private runSeed = 0;
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
    this.runSeed = Math.max(0, Math.floor(seed));
    this.battleIndex = 0;
    this.flightIndex = 0;
    this.collisionIndex = 0;
    this.radioDirector.resetRun();
    this.renderedRevision = -1;
    this.radio.classList.remove('on');
  }

  update(dt: number, race: RaceView, flightFocus = false, presentationBlocked = false): void {
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
    this.radio.classList.toggle('on', Boolean(notice) && !blocked);
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
        if (i === 0) gap.textContent = 'LEADER';
        else gap.textContent = `-${Math.max(0, order[i - 1].progress - racer.progress).toFixed(1)}m`;
      }
    }
  }

  announceGo(playerName: string): void {
    this.enqueue({
      key: 'go', speaker: TEAM_SPEAKER,
      message: `${playerName}，线路开放。先拿第一飞。`,
      priority: 'tactical', duration: 2.2, ttl: 3,
    });
  }

  announceBattle(event: RaceBattleEvent): void {
    const name = event.opponents[0]?.name ?? '对手';
    const messages = event.kind === 'overtake'
      ? [`已超过 ${name}，守住内线。`, `${name} 在尾流里，别给回切。`]
      : [`${name} 已超过你，差距还在攻击窗。`, `盯住 ${name}，下一段出弯拿回来。`];
    const index = this.battleIndex++ % messages.length;
    this.enqueue({
      key: `battle-${event.kind}-${index}`, speaker: TEAM_SPEAKER,
      message: messages[index], priority: 'tactical', duration: 2.5, ttl: 4,
    });
  }

  announceFlight(flights: number, best: number): void {
    const messages = flights === 3
      ? [`三飞认证。远海档案开启，BEST ${best}。`, '勋章到手。下一段线路已经开放。']
      : [`第 ${flights} 飞通过，艇况正常。`, `航门确认。本局 ${flights} 飞，继续。`];
    const index = this.flightIndex++ % messages.length;
    this.enqueue({
      key: `flight-${flights}-${index}`, speaker: TEAM_SPEAKER,
      message: messages[index], priority: flights === 3 ? 'critical' : 'tactical', duration: 2.4, ttl: 4,
    });
  }

  announceTechniqueTip(): void {
    const sol = driverProfile('sol');
    this.enqueue({
      key: 'sol-airbrake-tip',
      sessionKey: 'sol-airbrake-tip',
      speaker: driverSpeaker(sol),
      message: '最近摸到门道了：边飞边刹 + 转向，线路才咬得住。',
      emphasis: '边飞边刹 + 转向',
      priority: 'tactical',
      duration: 4,
      ttl: 15,
    });
  }

  announceCollision(opponent: RacerDefinition | undefined, strength: number, side: number): void {
    if (strength < 4) return;
    const collisionNumber = this.collisionIndex++;
    const sideLabel = side > 0.22 ? '左舷' : side < -0.22 ? '右舷' : '艇尾';
    const profile = opponent ? driverProfile(opponent.profileId) : null;
    const personalityRoll = hashRadio(this.runSeed, collisionNumber, opponent?.id ?? 0) % 100;
    if (strength > 10 && profile && personalityRoll < 35) {
      this.enqueue({
        key: `collision-driver-${collisionNumber}`,
        sessionKey: profile.mood === '兴奋' ? 'radio-profanity' : undefined,
        speaker: driverSpeaker(profile),
        message: COLLISION_LINES[profile.mood],
        priority: 'critical', duration: 2.8, ttl: 3,
      });
      return;
    }
    this.enqueue({
      key: `collision-team-${collisionNumber}`, speaker: TEAM_SPEAKER,
      message: `${sideLabel}接触 · 艇况正常。`,
      priority: 'critical', duration: 2.2, ttl: 3,
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
    const color = `#${speaker.color.toString(16).padStart(6, '0')}`;
    this.radio.style.setProperty('--radio-color', color);
    this.radioMeta.textContent = `${speaker.icon ? `${speaker.icon} ` : ''}${speaker.name}`;
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
    name: profile.name,
    color: profile.color,
    portraitUrl: profile.portraitUrl,
    portraitPosition: profile.portraitPosition,
    icon: profile.moodIcon,
  };
}

function hashRadio(seed: number, event: number, id: number): number {
  let value = (seed * 0x45d9f3b + event * 0x27d4eb2d + id * 0x165667b1) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  return (value ^ (value >>> 15)) >>> 0;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  parent.appendChild(el);
  return el;
}
