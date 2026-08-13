import desertUrl from '../assets/expansions/desert.webp';
import cityUrl from '../assets/expansions/city.webp';
import snowUrl from '../assets/expansions/snow.webp';
import swampUrl from '../assets/expansions/swamp.webp';
import jungleUrl from '../assets/expansions/jungle.webp';
import alienUrl from '../assets/expansions/alien.webp';
import microbiomeUrl from '../assets/expansions/microbiome-gut.webp';
import { trackGameEvent } from '../game/eventLog';
import './expansionGallery.css';

interface ExpansionPage {
  name: string;
  tag: string;
  copy: string;
  image: string;
}

const PAGES: readonly ExpansionPage[] = [
  { name: '沙漠：圣甲虫', tag: '六足切沙 · 鞘翅滑翔', copy: '贴着盐谷侧滑蓄势，展开鞘翅跃过风蚀遗迹。', image: desertUrl },
  { name: '城市：磁轨轮滑手', tag: '磨轨蹬墙 · 空中换线', copy: '沿高架磁轨加速，在楼群立面连续切换路线。', image: cityUrl },
  { name: '雪地：北极狐', tag: '冰面甩尾 · 裂谷飞跃', copy: '用长尾调整重心，在极地冰原追逐下一道金门。', image: snowUrl },
  { name: '沼泽：树蛙', tag: '睡莲弹跳 · 舌索摆荡', copy: '借湿地叶面高速弹射，从盘根之间穿过黑水赛线。', image: swampUrl },
  { name: '丛林：长臂猿', tag: '藤蔓换手 · 冠层摆荡', copy: '用摆荡积累速度，在瀑布与巨树之间连续腾跃。', image: jungleUrl },
  { name: '外星：浮空鳐形生命', tag: '折翼转向 · 低重力滑翔', copy: '驾驭重力流穿过浮岛，在异星天空俯冲再爬升。', image: alienUrl },
  { name: '肠道：益生菌', tag: '黏液转向 · 鞭毛推进', copy: '沿蠕动营养流加速，在绒毛与菌群之间穿行。', image: microbiomeUrl },
];

export class ExpansionGallery {
  private readonly root: HTMLDivElement;
  private readonly image: HTMLImageElement;
  private readonly name: HTMLDivElement;
  private readonly tag: HTMLDivElement;
  private readonly copy: HTMLDivElement;
  private readonly count: HTMLDivElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly returnButton: HTMLButtonElement;
  private readonly dots: HTMLButtonElement[] = [];
  private index = 0;
  private open = false;
  private startX: number | null = null;
  private pointerId: number | null = null;

  constructor(parent: HTMLElement, private readonly onSeen: (index: number) => void, private readonly onReturn: () => void) {
    const root = document.createElement('div');
    root.className = 'expansion-gallery';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '资料片档案');
    root.innerHTML = `
      <div class="expansion-gallery-stage">
        <img class="expansion-gallery-image" alt="" draggable="false">
        <div class="expansion-gallery-shade"></div>
        <div class="expansion-gallery-copy" aria-live="polite" aria-atomic="true">
          <div class="expansion-gallery-kicker">资料片档案 · 概念预告</div>
          <div class="expansion-gallery-tag"></div>
          <div class="expansion-gallery-name"></div>
          <div class="expansion-gallery-desc"></div>
          <div class="expansion-gallery-count"></div>
        </div>
        <div class="expansion-gallery-dots" role="tablist" aria-label="待开发游戏"></div>
        <button class="expansion-gallery-arrow prev" type="button" aria-label="上一页">‹</button>
        <button class="expansion-gallery-arrow next" type="button" aria-label="下一页">›</button>
        <button class="expansion-gallery-return" type="button">返回结算</button>
      </div>`;
    parent.appendChild(root);
    this.root = root;
    this.image = root.querySelector('.expansion-gallery-image')!;
    this.name = root.querySelector('.expansion-gallery-name')!;
    this.tag = root.querySelector('.expansion-gallery-tag')!;
    this.copy = root.querySelector('.expansion-gallery-desc')!;
    this.count = root.querySelector('.expansion-gallery-count')!;
    this.previousButton = root.querySelector('.prev')!;
    this.nextButton = root.querySelector('.next')!;
    this.returnButton = root.querySelector('.expansion-gallery-return')!;
    const dots = root.querySelector('.expansion-gallery-dots')!;
    for (let i = 0; i < PAGES.length; i++) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.textContent = PAGES[i].name;
      dot.setAttribute('role', 'tab');
      dot.setAttribute('aria-label', `查看${PAGES[i].name}`);
      dot.addEventListener('click', () => this.setIndex(i));
      dots.appendChild(dot);
      this.dots.push(dot);
    }
    this.previousButton.addEventListener('click', () => this.move(-1));
    this.nextButton.addEventListener('click', () => this.move(1));
    this.returnButton.addEventListener('click', () => this.hide());
    root.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target as Element).closest('button')) return;
      this.startX = event.clientX;
      this.pointerId = event.pointerId;
      root.setPointerCapture(event.pointerId);
    });
    root.addEventListener('pointerup', (event) => {
      if (this.startX === null || event.pointerId !== this.pointerId) return;
      const delta = event.clientX - this.startX;
      this.clearSwipe();
      if (Math.abs(delta) >= 34) this.move(delta > 0 ? -1 : 1);
    });
    root.addEventListener('pointercancel', () => this.clearSwipe());
    window.addEventListener('keydown', (event) => {
      if (!this.open) return;
      if (event.code === 'ArrowLeft' || event.code === 'KeyA') this.move(-1);
      else if (event.code === 'ArrowRight' || event.code === 'KeyD') this.move(1);
      else if (event.code === 'Escape') this.hide();
    });
    PAGES.slice(0, 2).forEach((page) => { const preload = new Image(); preload.src = page.image; });
  }

  show(index = 0): void {
    this.open = true;
    this.root.classList.add('on');
    this.setIndex(index);
    trackGameEvent('expansion_view_open', { page: index });
    this.returnButton.focus({ preventScroll: true });
  }

  hide(): void {
    if (!this.open) return;
    this.clearSwipe();
    this.open = false;
    this.root.classList.remove('on');
    trackGameEvent('expansion_return_game', { page: this.index });
    this.onReturn();
  }

  visible(): boolean { return this.open; }

  private move(direction: number): void {
    this.setIndex(this.index + direction);
  }

  private setIndex(index: number): void {
    this.index = Math.max(0, Math.min(PAGES.length - 1, index));
    const page = PAGES[this.index];
    this.image.src = page.image;
    this.image.alt = `${page.name}资料片概念图`;
    this.name.textContent = page.name;
    this.tag.textContent = page.tag;
    this.copy.textContent = page.copy;
    this.count.textContent = `${String(this.index + 1).padStart(2, '0')} / 07`;
    this.previousButton.disabled = this.index === 0;
    this.nextButton.disabled = this.index === PAGES.length - 1;
    this.dots.forEach((dot, i) => {
      const current = i === this.index;
      dot.classList.toggle('on', current);
      dot.setAttribute('aria-selected', String(current));
      if (current) dot.setAttribute('aria-current', 'page');
      else dot.removeAttribute('aria-current');
    });
    this.onSeen(this.index);
    trackGameEvent('expansion_page_view', { page: this.index, expansion: page.tag });
    for (const neighbor of [this.index - 1, this.index + 1]) {
      if (!PAGES[neighbor]) continue;
      const preload = new Image();
      preload.src = PAGES[neighbor].image;
    }
  }

  private clearSwipe(): void {
    if (this.pointerId !== null && this.root.hasPointerCapture(this.pointerId)) {
      this.root.releasePointerCapture(this.pointerId);
    }
    this.startX = null;
    this.pointerId = null;
  }
}
