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
    parent.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('on', visible);
    this.root.setAttribute('aria-hidden', visible ? 'false' : 'true');
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
      const interactionKeys = seat.device.startsWith('手柄') ? 'B 支援 · Y 浪花' : index === 0 ? 'Q 支援 · E 浪花' : 'U 支援 · O 浪花';
      const cue = seat.guidance?.actionCue === 'launch'
        ? ' · 现在起飞'
        : seat.guidance?.actionCue === 'bank'
          ? ' · 先漂移蓄能'
          : seat.guidance?.actionCue === 'turn'
            ? ` · 向${seat.guidance.actionDirection === 'left' ? '左' : '右'}转`
            : '';
      this.status[index].textContent = seat.racer.eliminated
        ? `观战幸存者 · ${interactionKeys} · ${seat.interaction?.charges ?? 0} 次`
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
}
