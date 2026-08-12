import type { DriverProfile } from '../game/racers';
import { DRIVER_PROFILES, driverProfile } from '../game/racers';
import './driverSelect.css';

export class DriverSelect {
  readonly root: HTMLDivElement;
  private readonly portrait: HTMLImageElement;
  private readonly name: HTMLDivElement;
  private readonly meta: HTMLDivElement;
  private readonly mood: HTMLDivElement;
  private readonly quote: HTMLQuoteElement;
  private readonly strength: HTMLDivElement;
  private readonly weakness: HTMLDivElement;
  private readonly specialty: HTMLDivElement;
  private readonly radar: HTMLCanvasElement;
  private readonly cards = new Map<string, HTMLButtonElement>();
  private selectedProfile: DriverProfile;
  private readonly parent: HTMLElement;

  constructor(
    parent: HTMLElement,
    initialId: string,
    private readonly onSelect: (profile: DriverProfile) => void,
    onStart: () => void,
    onExport: () => void,
    onImport: (raw: string) => void,
  ) {
    this.selectedProfile = driverProfile(initialId);
    this.parent = parent;
    this.root = element('div', 'driver-select', parent);
    this.root.setAttribute('aria-label', '选择成年竞速选手');

    const header = element('div', 'driver-select-header', this.root);
    element('div', 'driver-select-kicker', header, 'WORLD HYDRO LEAGUE // DRIVER CONTRACT');
    element('h1', 'driver-select-title', header, '选择你的选手');
    element('div', 'driver-select-objective', header, '三飞拿勋章 · 第一才算优秀 · 三飞之后远海继续');

    const featured = element('section', 'driver-featured', this.root);
    const portraitFrame = element('div', 'driver-portrait-frame', featured);
    this.portrait = document.createElement('img');
    this.portrait.className = 'driver-portrait';
    this.portrait.alt = '';
    portraitFrame.appendChild(this.portrait);
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
    element('div', 'driver-radar-title', radarWrap, '能力分析');
    this.radar = document.createElement('canvas');
    this.radar.className = 'driver-radar';
    this.radar.width = 320;
    this.radar.height = 260;
    radarWrap.appendChild(this.radar);

    const rail = element('div', 'driver-rail', this.root);
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
      button.addEventListener('click', () => this.select(profile.id));
      rail.appendChild(button);
      this.cards.set(profile.id, button);
    }

    const footer = element('div', 'driver-select-footer', this.root);
    const archive = element('div', 'driver-archive', footer);
    const exportButton = element('button', 'driver-archive-button', archive, '导出档案');
    exportButton.type = 'button';
    exportButton.title = '下载可迁移的单机存档';
    exportButton.addEventListener('click', onExport);
    const importButton = element('button', 'driver-archive-button', archive, '导入档案');
    importButton.type = 'button';
    importButton.title = '从 JSON 恢复单机存档';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'application/json,.json';
    file.hidden = true;
    file.addEventListener('change', async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      onImport(await selected.text());
      file.value = '';
    });
    importButton.addEventListener('click', () => file.click());
    archive.appendChild(file);
    element('div', 'driver-select-foot', footer, '本机永久档案 · ← → / A D 选择 · ENTER 倒计时');
    const go = element('button', 'driver-select-go', footer, 'GO · 签约出发');
    go.type = 'button';
    go.addEventListener('click', onStart);
    this.render();
  }

  get selectedId(): string {
    return this.selectedProfile.id;
  }

  show(): void {
    this.parent.classList.add('driver-select-active');
    this.root.classList.add('on');
  }

  hide(): void {
    this.parent.classList.remove('driver-select-active');
    this.root.classList.remove('on');
  }

  select(id: string, notify = true): void {
    const next = driverProfile(id);
    if (next.id === this.selectedProfile.id) return;
    this.selectedProfile = next;
    this.render();
    if (notify) this.onSelect(next);
  }

  move(delta: number): void {
    const index = DRIVER_PROFILES.findIndex((profile) => profile.id === this.selectedProfile.id);
    const next = (index + delta + DRIVER_PROFILES.length) % DRIVER_PROFILES.length;
    this.select(DRIVER_PROFILES[next].id);
  }

  private render(): void {
    const profile = this.selectedProfile;
    this.root.style.setProperty('--driver-color', hex(profile.color));
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
    for (const [id, card] of this.cards) card.classList.toggle('selected', id === profile.id);
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
    const labels = ['加速', '转向', '漂移', '空控', '节奏'];
    const values = [
      profile.handling.acceleration,
      profile.handling.steering,
      profile.handling.driftCharge,
      profile.handling.airControl,
      0.94 + Math.min(0.12, profile.rivalRank * 0.014),
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
      ctx.font = '800 18px system-ui';
      ctx.textAlign = Math.cos(a) > 0.25 ? 'left' : Math.cos(a) < -0.25 ? 'right' : 'center';
      ctx.textBaseline = Math.sin(a) > 0.5 ? 'top' : Math.sin(a) < -0.5 ? 'bottom' : 'middle';
      ctx.fillText(labels[i], cx + Math.cos(a) * (radius + 17), cy + Math.sin(a) * (radius + 17));
    }
    ctx.beginPath();
    values.forEach((value, i) => {
      const a = -Math.PI / 2 + i * Math.PI * 2 / labels.length;
      const n = 0.58 + (value - 0.94) / 0.12 * 0.42;
      const x = cx + Math.cos(a) * radius * Math.max(0.55, Math.min(1, n));
      const y = cy + Math.sin(a) * radius * Math.max(0.55, Math.min(1, n));
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
