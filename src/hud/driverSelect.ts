import type { DriverProfile } from '../game/racers';
import { DRIVER_PROFILES, driverProfile } from '../game/racers';
import './driverSelect.css';

export class DriverSelect {
  readonly root: HTMLDivElement;
  private readonly mobileBackdrop: HTMLImageElement;
  private readonly portrait: HTMLImageElement;
  private readonly portraitEcho: HTMLImageElement;
  private readonly contractCard: HTMLDivElement;
  private readonly contractPortrait: HTMLImageElement;
  private readonly name: HTMLDivElement;
  private readonly meta: HTMLDivElement;
  private readonly mood: HTMLDivElement;
  private readonly quote: HTMLQuoteElement;
  private readonly strength: HTMLDivElement;
  private readonly weakness: HTMLDivElement;
  private readonly specialty: HTMLDivElement;
  private readonly radar: HTMLCanvasElement;
  private readonly rosterIndex: HTMLDivElement;
  private readonly controllerStatus: HTMLDivElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly previousLabel: HTMLElement;
  private readonly nextLabel: HTMLElement;
  private readonly cards = new Map<string, HTMLButtonElement>();
  private readonly dots = new Map<string, HTMLButtonElement>();
  private selectedProfile: DriverProfile;
  private readonly parent: HTMLElement;
  private carouselPointerId: number | null = null;
  private carouselStartX = 0;
  private suppressCarouselClick = false;
  private controllerStatusText = '';
  private controllerStatusTitle = '';

  constructor(
    parent: HTMLElement,
    initialId: string,
    private readonly onSelect: (profile: DriverProfile, index: number, direction: -1 | 1) => void,
    onStart: () => void,
    private readonly onFirstInteraction?: () => void,
  ) {
    this.selectedProfile = driverProfile(initialId);
    this.parent = parent;
    this.root = element('div', 'driver-select', parent);
    this.root.setAttribute('aria-label', '选择成年竞速选手');
    this.root.addEventListener('pointerdown', () => this.onFirstInteraction?.(), { capture: true, passive: true });

    this.mobileBackdrop = document.createElement('img');
    this.mobileBackdrop.className = 'driver-mobile-backdrop';
    this.mobileBackdrop.alt = '';
    this.mobileBackdrop.draggable = false;
    this.mobileBackdrop.setAttribute('aria-hidden', 'true');
    this.mobileBackdrop.decoding = 'async';
    this.root.appendChild(this.mobileBackdrop);

    const header = element('div', 'driver-select-header', this.root);
    element('div', 'driver-select-kicker', header, 'WORLD HYDRO LEAGUE // DRIVER CONTRACT');
    element('h1', 'driver-select-title', header, '选择你的选手');
    element('div', 'driver-select-objective', header, '三飞拿勋章 · 第一才算优秀 · 七飞冲向终点站');

    const featured = element('section', 'driver-featured', this.root);
    featured.id = 'driver-featured';
    this.previousButton = element('button', 'driver-switch-control driver-switch-previous', featured);
    this.previousButton.type = 'button';
    this.previousButton.title = '上一位选手';
    this.previousButton.setAttribute('aria-controls', featured.id);
    element('span', 'driver-switch-icon', this.previousButton, '‹');
    this.previousLabel = element('small', 'driver-switch-label', this.previousButton);
    this.previousButton.addEventListener('click', () => this.move(-1));
    this.nextButton = element('button', 'driver-switch-control driver-switch-next', featured);
    this.nextButton.type = 'button';
    this.nextButton.title = '下一位选手';
    this.nextButton.setAttribute('aria-controls', featured.id);
    element('span', 'driver-switch-icon', this.nextButton, '›');
    this.nextLabel = element('small', 'driver-switch-label', this.nextButton);
    this.nextButton.addEventListener('click', () => this.move(1));
    this.rosterIndex = element('div', 'driver-roster-index', featured);
    this.rosterIndex.setAttribute('aria-live', 'polite');
    this.rosterIndex.setAttribute('aria-atomic', 'true');
    const portraitFrame = element('div', 'driver-portrait-frame', featured);
    this.portrait = document.createElement('img');
    this.portrait.className = 'driver-portrait';
    this.portrait.alt = '';
    portraitFrame.appendChild(this.portrait);
    this.portraitEcho = document.createElement('img');
    this.portraitEcho.className = 'driver-portrait driver-portrait-echo';
    this.portraitEcho.alt = '';
    portraitFrame.appendChild(this.portraitEcho);
    this.contractCard = element('div', 'driver-contract-card', portraitFrame);
    this.contractPortrait = document.createElement('img');
    this.contractPortrait.alt = '';
    this.contractCard.appendChild(this.contractPortrait);
    element('i', 'driver-contract-seal', this.contractCard);
    this.mood = element('div', 'driver-mood', portraitFrame);

    const identity = element('div', 'driver-identity', featured);
    this.specialty = element('div', 'driver-specialty', identity);
    this.name = element('div', 'driver-name', identity);
    this.meta = element('div', 'driver-meta', identity);
    this.quote = document.createElement('blockquote');
    this.quote.className = 'driver-quote';
    identity.appendChild(this.quote);
    this.strength = element('div', 'driver-pro driver-trait', identity);
    this.weakness = element('div', 'driver-con driver-trait', identity);

    const radarWrap = element('div', 'driver-radar-wrap', featured);
    element('div', 'driver-radar-title', radarWrap, '能力分析 · 单项最高 ±6%');
    this.radar = document.createElement('canvas');
    this.radar.className = 'driver-radar';
    this.radar.width = 320;
    this.radar.height = 260;
    radarWrap.appendChild(this.radar);

    const carousel = element('div', 'driver-carousel', this.root);
    const rail = element('div', 'driver-rail', carousel);
    for (const profile of DRIVER_PROFILES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'driver-card';
      button.dataset.driver = profile.id;
      button.setAttribute('aria-label', `${profile.name}，${profile.specialty}`);
      const img = document.createElement('img');
      img.src = profile.portraitUrl;
      img.alt = '';
      img.draggable = false;
      img.style.objectPosition = profile.portraitPosition;
      button.appendChild(img);
      const copy = element('span', 'driver-card-copy', button);
      element('strong', '', copy, profile.name);
      element('small', '', copy, `${profile.callsign} · ${profile.mood}`);
      button.addEventListener('click', () => {
        if (!this.suppressCarouselClick) this.select(profile.id);
      });
      rail.appendChild(button);
      this.cards.set(profile.id, button);
    }
    const dots = element('div', 'driver-dots', carousel);
    for (const profile of DRIVER_PROFILES) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'driver-dot';
      dot.dataset.driver = profile.id;
      dot.setAttribute('aria-label', `选择 ${profile.name}`);
      dot.addEventListener('click', () => this.select(profile.id));
      dots.appendChild(dot);
      this.dots.set(profile.id, dot);
    }
    carousel.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.pointerType === 'mouse' || this.carouselPointerId !== null) return;
      this.carouselPointerId = event.pointerId;
      this.carouselStartX = event.clientX;
      try { carousel.setPointerCapture?.(event.pointerId); } catch { /* synthetic/test pointers need no capture */ }
    });
    const finishSwipe = (event: PointerEvent) => {
      if (event.pointerId !== this.carouselPointerId) return;
      const delta = event.clientX - this.carouselStartX;
      this.carouselPointerId = null;
      if (Math.abs(delta) < 34) return;
      this.suppressCarouselClick = true;
      this.move(delta < 0 ? 1 : -1);
      window.setTimeout(() => { this.suppressCarouselClick = false; }, 0);
    };
    carousel.addEventListener('pointerup', finishSwipe);
    carousel.addEventListener('pointercancel', () => { this.carouselPointerId = null; });

    const footer = element('div', 'driver-select-footer', this.root);
    const go = element('button', 'driver-select-go', footer, 'GO · 签约出发');
    go.type = 'button';
    go.addEventListener('click', onStart);
    this.controllerStatus = element('div', 'driver-controller-status', footer);
    this.controllerStatus.setAttribute('role', 'status');
    this.controllerStatus.setAttribute('aria-live', 'polite');
    this.name.addEventListener('animationend', (event) => {
      if (event.animationName === 'driver-copy-lock') this.root.classList.remove('switching');
    });
    this.render();
  }

  updateControllerStatus(status: Record<string, number | string | boolean>): void {
    const connected = status.connected === true;
    this.controllerStatus.classList.toggle('on', connected);
    this.controllerStatus.classList.toggle('calibrating', Boolean(status.calibrationStep));
    if (!connected) {
      if (this.controllerStatusText) {
        this.controllerStatus.textContent = '';
        this.controllerStatusText = '';
        this.controllerStatusTitle = '';
      }
      return;
    }
    const count = Number(status.connectedCount) || 1;
    const fullLabel = String(status.id || '游戏手柄').replace(/\s*\([^)]*\)\s*$/, '');
    const label = fullLabel.slice(0, 18);
    const mode = status.mappingSource === 'custom' ? '已校准' : status.mappingSource === 'standard' ? '标准' : '待校准';
    const rumble = status.rumble ? ' · 震动' : '';
    const prompt = String(status.calibrationPrompt || '');
    const text = prompt || `PAD ${Number(status.index) + 1}/${count} · ${label} · ${mode}${rumble}`;
    const title = prompt || `手柄 ${Number(status.index) + 1}/${count} · ${fullLabel} · ${mode}${rumble}`;
    if (text !== this.controllerStatusText) {
      this.controllerStatus.textContent = text;
      this.controllerStatusText = text;
    }
    if (title !== this.controllerStatusTitle) {
      this.controllerStatus.title = title;
      this.controllerStatusTitle = title;
    }
  }

  get selectedId(): string {
    return this.selectedProfile.id;
  }

  show(): void {
    this.parent.classList.add('driver-select-active');
    this.root.classList.add('on');
    this.drawRadar(this.selectedProfile);
    requestAnimationFrame(() => {
      if (this.root.classList.contains('on')) this.drawRadar(this.selectedProfile);
    });
  }

  hide(): void {
    this.parent.classList.remove('driver-select-active');
    this.root.classList.remove('on');
  }

  select(id: string, notify = true, direction?: -1 | 1): void {
    const next = driverProfile(id);
    if (next.id === this.selectedProfile.id) return;
    const previousIndex = DRIVER_PROFILES.findIndex((profile) => profile.id === this.selectedProfile.id);
    const nextIndex = DRIVER_PROFILES.findIndex((profile) => profile.id === next.id);
    const forward = (nextIndex - previousIndex + DRIVER_PROFILES.length) % DRIVER_PROFILES.length;
    const switchDirection = direction ?? (forward > 0 && forward <= DRIVER_PROFILES.length / 2 ? 1 : -1);
    this.portraitEcho.src = this.selectedProfile.portraitUrl;
    this.portraitEcho.style.objectPosition = this.selectedProfile.portraitPosition;
    this.contractPortrait.src = next.portraitUrl;
    this.contractPortrait.style.objectPosition = next.portraitPosition;
    this.selectedProfile = next;
    this.render();
    if (notify) {
      this.root.dataset.switchDirection = String(switchDirection);
      this.root.classList.remove('switching');
      void this.root.offsetWidth;
      this.root.classList.add('switching');
      this.onSelect(next, nextIndex, switchDirection);
    }
  }

  move(delta: number): void {
    const index = DRIVER_PROFILES.findIndex((profile) => profile.id === this.selectedProfile.id);
    const next = (index + delta + DRIVER_PROFILES.length) % DRIVER_PROFILES.length;
    this.select(DRIVER_PROFILES[next].id, true, delta < 0 ? -1 : 1);
  }

  private render(): void {
    const profile = this.selectedProfile;
    this.root.dataset.selectedDriver = profile.id;
    this.root.style.setProperty('--driver-color', hex(profile.color));
    this.mobileBackdrop.src = profile.portraitUrl;
    this.portrait.src = profile.portraitUrl;
    this.portrait.style.objectPosition = profile.portraitPosition;
    this.portrait.alt = `${profile.name}，${profile.age} 岁成年选手`;
    this.name.textContent = profile.name;
    this.meta.textContent = `${profile.callsign} // ${profile.age} 岁 // ${profile.pronouns}`;
    this.mood.textContent = `${profile.moodIcon} ${profile.mood}`;
    this.specialty.textContent = profile.specialty;
    this.quote.textContent = `“${profile.quote}”`;
    this.strength.textContent = `优势  ${profile.strength}`;
    this.weakness.textContent = `短板  ${profile.weakness}`;
    this.radar.setAttribute('aria-label', `${profile.name} 实际性能；${handlingSummary(profile)}`);
    const index = DRIVER_PROFILES.findIndex((item) => item.id === profile.id);
    this.rosterIndex.textContent = `选手 ${String(index + 1).padStart(2, '0')} / ${String(DRIVER_PROFILES.length).padStart(2, '0')}`;
    const previousId = DRIVER_PROFILES[(index - 1 + DRIVER_PROFILES.length) % DRIVER_PROFILES.length].id;
    const nextId = DRIVER_PROFILES[(index + 1) % DRIVER_PROFILES.length].id;
    const previousProfile = driverProfile(previousId);
    const nextProfile = driverProfile(nextId);
    this.previousLabel.textContent = previousProfile.name;
    this.nextLabel.textContent = nextProfile.name;
    this.previousButton.setAttribute('aria-label', `上一位选手，${previousProfile.name}`);
    this.nextButton.setAttribute('aria-label', `下一位选手，${nextProfile.name}`);
    for (const [id, card] of this.cards) {
      card.classList.toggle('selected', id === profile.id);
      card.classList.toggle('carousel-prev', id === previousId);
      card.classList.toggle('carousel-next', id === nextId);
      card.classList.toggle('carousel-visible', id === profile.id || id === previousId || id === nextId);
    }
    for (const [id, dot] of this.dots) dot.classList.toggle('selected', id === profile.id);
    this.drawRadar(profile);
  }

  private drawRadar(profile: DriverProfile): void {
    const ctx = this.radar.getContext('2d');
    if (!ctx) return;
    const w = this.radar.width;
    const h = this.radar.height;
    const cx = w * 0.5;
    const cy = h * 0.5 + 7;
    const radius = Math.min(w, h) * 0.35;
    const labels = ['加速', '转向', '漂移', '空控'];
    const values = [
      profile.handling.acceleration,
      profile.handling.steering,
      profile.handling.driftCharge,
      profile.handling.airControl,
    ];
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = 'round';
    for (let ring = 1; ring <= 4; ring++) {
      polygon(ctx, cx, cy, radius * ring / 4, labels.length);
      ctx.strokeStyle = ring === 4 ? 'rgba(244,254,255,.55)' : 'rgba(244,254,255,.16)';
      ctx.lineWidth = ring === 4 ? 3 : 1;
      ctx.stroke();
    }
    for (let i = 0; i < labels.length; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 2 / labels.length;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      ctx.strokeStyle = 'rgba(244,254,255,.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#f4feff';
      ctx.font = '800 16px system-ui';
      const horizontal = Math.cos(a);
      const vertical = Math.sin(a);
      ctx.textAlign = horizontal > 0.25 ? 'right' : horizontal < -0.25 ? 'left' : 'center';
      ctx.textBaseline = vertical > 0.5 ? 'bottom' : vertical < -0.5 ? 'top' : 'middle';
      const labelX = horizontal > 0.25 ? w - 8 : horizontal < -0.25 ? 8 : cx;
      const labelY = vertical > 0.5 ? h - 6 : vertical < -0.5 ? 6 : cy;
      ctx.fillText(
        `${labels[i]} ${formatHandling(values[i])}`,
        labelX,
        labelY,
      );
    }
    ctx.beginPath();
    values.forEach((value, i) => {
      const a = -Math.PI / 2 + i * Math.PI * 2 / labels.length;
      const n = 0.58 + (value - 0.94) / 0.12 * 0.42;
      const x = cx + Math.cos(a) * radius * Math.max(0.58, Math.min(1, n));
      const y = cy + Math.sin(a) * radius * Math.max(0.58, Math.min(1, n));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = `${hex(profile.color)}77`;
    ctx.strokeStyle = hex(profile.color);
    ctx.lineWidth = 5;
    ctx.fill();
    ctx.stroke();
  }
}

function formatHandling(value: number): string {
  const percent = Math.round((value - 1) * 100);
  return percent > 0 ? `+${percent}%` : `${percent}%`;
}

function handlingSummary(profile: DriverProfile): string {
  const h = profile.handling;
  return `加速 ${formatHandling(h.acceleration)}，转向 ${formatHandling(h.steering)}，` +
    `漂移 ${formatHandling(h.driftCharge)}，空控 ${formatHandling(h.airControl)}；单项最高正负 6%`;
}

function polygon(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, sides: number): void {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + i * Math.PI * 2 / sides;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
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

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
