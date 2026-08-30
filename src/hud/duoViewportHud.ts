import type { IBoat, RacerState } from '../contracts';
import type { CourseGuidanceStatus } from '../contracts';
import type { DuoInteractionStatus } from '../game/duoInteraction';
import './duoViewportHud.css';

export interface DuoViewportSeat {
  name: string;
  color: number;
  racer: RacerState;
  boat: IBoat;
  device: string;
  interaction?: DuoInteractionStatus;
  guidance?: CourseGuidanceStatus;
}

const cssColor = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;

/** Small local readouts that belong to each half of the dual camera. */
export class DuoViewportHud {
  private readonly root: HTMLDivElement;
  private readonly sides: [HTMLDivElement, HTMLDivElement];
  private readonly labels: [HTMLDivElement, HTMLDivElement];
  private readonly places: [HTMLDivElement, HTMLDivElement];
  private readonly stats: [HTMLDivElement, HTMLDivElement];
  private readonly status: [HTMLDivElement, HTMLDivElement];
  private readonly tacticalFeeds: [HTMLDivElement, HTMLDivElement];
  private tacticalTimers: [number, number] = [0, 0];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'duo-viewport-hud';
    this.root.setAttribute('aria-hidden', 'true');
    const divider = document.createElement('div');
    divider.className = 'duo-viewport-divider';
    this.root.appendChild(divider);

    this.sides = [this.makeSide('left'), this.makeSide('right')];
    this.labels = [
      this.sides[0].querySelector('.duo-viewport-name') as HTMLDivElement,
      this.sides[1].querySelector('.duo-viewport-name') as HTMLDivElement,
    ];
    this.places = [
      this.sides[0].querySelector('.duo-viewport-place') as HTMLDivElement,
      this.sides[1].querySelector('.duo-viewport-place') as HTMLDivElement,
    ];
    this.stats = [
      this.sides[0].querySelector('.duo-viewport-stats') as HTMLDivElement,
      this.sides[1].querySelector('.duo-viewport-stats') as HTMLDivElement,
    ];
    this.status = [
      this.sides[0].querySelector('.duo-viewport-status') as HTMLDivElement,
      this.sides[1].querySelector('.duo-viewport-status') as HTMLDivElement,
    ];
    this.tacticalFeeds = [
      this.makeTacticalFeed('left'),
      this.makeTacticalFeed('right'),
    ];
    parent.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('on', visible);
    this.root.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  startTacticalMissileFeed(actorIndex: number, targetName: string): void {
    const feed = this.tacticalFeeds[actorIndex];
    if (!feed) return;
    window.clearTimeout(this.tacticalTimers[actorIndex]);
    feed.classList.remove('detonation-hit', 'detonation-miss');
    feed.classList.add('on', 'in-flight');
    const sub = feed.querySelector('.duo-tactical-sub') as HTMLDivElement;
    const body = feed.querySelector('.duo-tactical-body') as HTMLDivElement;
    if (sub) sub.textContent = `🚀 飞毛腿在途的聚变打击 // 锁定: ${targetName}`;
    if (body) {
      body.innerHTML = `
        <div class="duo-tactical-radar">
          <div class="duo-tactical-sweep"></div>
          <div class="duo-tactical-reticle"></div>
          <div class="duo-tactical-missile-icon">▲ SCUD-B</div>
        </div>
        <div class="duo-tactical-info">
          <div class="duo-tactical-line">▶ 状态: <span class="blink-red">末端制导点火中 [75% HIT]</span></div>
          <div class="duo-tactical-line">▶ 目标: ${targetName} 艇尾截击</div>
          <div class="duo-tactical-line">▶ 预计: 720° 空中爆破杂耍</div>
        </div>
      `;
    }
  }

  finishTacticalMissileFeed(actorIndex: number, isHit: boolean): void {
    const feed = this.tacticalFeeds[actorIndex];
    if (!feed) return;
    feed.classList.remove('in-flight');
    feed.classList.add(isHit ? 'detonation-hit' : 'detonation-miss');
    const body = feed.querySelector('.duo-tactical-body') as HTMLDivElement;
    if (body) {
      if (isHit) {
        body.innerHTML = `
          <div class="duo-tactical-blast">💥 DIRECT HIT 💥</div>
          <div class="duo-tactical-info">
            <div class="duo-tactical-line" style="color: #ffd020; font-weight: 900;">▶ 聚变打击命中！目标 720° 翻滚轰飞！</div>
            <div class="duo-tactical-line">▶ 喜剧效果达成 · 惯性空爆完成</div>
          </div>
        `;
      } else {
        body.innerHTML = `
          <div class="duo-tactical-blast" style="color: #00f0ff;">💨 TARGET EVADED 💨</div>
          <div class="duo-tactical-info">
            <div class="duo-tactical-line" style="color: #00f0ff;">▶ 飞毛腿描边！75%命中率脱靶！</div>
            <div class="duo-tactical-line">▶ 目标侥幸逃生 · 下发继续装填</div>
          </div>
        `;
      }
    }
    this.tacticalTimers[actorIndex] = window.setTimeout(() => {
      feed.classList.remove('on', 'detonation-hit', 'detonation-miss');
    }, 2400);
  }

  update(seats: readonly [DuoViewportSeat, DuoViewportSeat], visible: boolean): void {
    this.setVisible(visible);
    if (!visible) return;
    for (let index = 0; index < 2; index++) {
      const seat = seats[index];
      const side = this.sides[index];
      side.style.setProperty('--duo-seat-color', cssColor(seat.color));
      this.labels[index].textContent = `${index === 0 ? '左屏' : '右屏'} · ${seat.name}`;
      this.places[index].textContent = seat.racer.eliminated
        ? 'OUT'
        : `${seat.racer.place} / ${seat.racer.place > 0 ? 6 : '-'}`;
      const state = seat.boat.state;
      this.stats[index].textContent = `${Math.max(0, Math.round(Math.abs(state.speed) * 3.6))} KM/H  ·  ${state.flightsCleared} 飞  ·  电池 ${state.flightCharges}`;
      const flightReady = !seat.racer.eliminated && state.flightPhase === 'surface' && state.flightCharges > 0;
      const interactionKeys = seat.device.startsWith('手柄') ? 'B 支援 · Y 飞毛腿导弹' : index === 0 ? 'Q 支援 · E 飞毛腿' : 'U 支援 · O 飞毛腿';
      const cue = seat.guidance?.actionCue === 'launch'
        ? ' · 现在起飞'
        : seat.guidance?.actionCue === 'bank'
          ? ' · 先漂移蓄能'
          : seat.guidance?.actionCue === 'turn'
            ? ` · 向${seat.guidance.actionDirection === 'left' ? '左' : '右'}转`
            : '';
      this.status[index].textContent = seat.racer.eliminated
        ? `🚀 聚变打击席 · ${interactionKeys} (余 ${seat.interaction?.charges ?? 0} 发)`
        : `${seat.device} · ${state.flightPhase === 'surface' ? '水面' : '飞行中'}${flightReady ? ' · 起飞就绪' : ''}${cue}`;
      side.classList.toggle('eliminated', seat.racer.eliminated);
    }
  }

  private makeSide(side: 'left' | 'right'): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `duo-viewport-side duo-viewport-side-${side}`;
    el.innerHTML = [
      '<div class="duo-viewport-name"></div>',
      '<div class="duo-viewport-place"></div>',
      '<div class="duo-viewport-stats"></div>',
      '<div class="duo-viewport-status"></div>',
    ].join('');
    this.root.appendChild(el);
    return el;
  }

  private makeTacticalFeed(side: 'left' | 'right'): HTMLDivElement {
    const feed = document.createElement('div');
    feed.className = `duo-tactical-feed duo-tactical-feed-${side}`;
    feed.innerHTML = `
      <div class="duo-tactical-header">
        <span class="duo-tactical-dot">🔴</span> LIVE SATELLITE FEED // SCUD-B LAUNCH
      </div>
      <div class="duo-tactical-sub">🚀 飞毛腿在途的聚变打击</div>
      <div class="duo-tactical-body"></div>
      <div class="duo-tactical-scanline"></div>
    `;
    this.root.appendChild(feed);
    return feed;
  }
}
