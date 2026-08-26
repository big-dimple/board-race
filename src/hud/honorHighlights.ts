import type { HonorSummary, RaceMode } from '../contracts';
import type { HonorHighlight } from '../game/honors';
import './honorHighlights.css';

export interface HonorRacerCard {
  id: number;
  name: string;
  portraitUrl: string;
  color: number;
  place: number;
  score: number;
}

export interface HonorReviewPayload {
  mode: RaceMode;
  racers: readonly HonorRacerCard[];
  highlights: readonly HonorHighlight[];
  summary: HonorSummary;
  resultLabel: string;
}

/**
 * A short post-race accolade sequence inspired by hero-shooter end cards:
 * one spotlight, then several readable cards, then an explicit action row.
 * It never owns race state; callbacks decide when the next run starts.
 */
export class HonorHighlights {
  private readonly root: HTMLElement;
  private readonly kicker: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly result: HTMLDivElement;
  private readonly standings: HTMLDivElement;
  private readonly spotlight: HTMLDivElement;
  private readonly spotlightPortrait: HTMLImageElement;
  private readonly spotlightLabel: HTMLDivElement;
  private readonly spotlightTitle: HTMLDivElement;
  private readonly spotlightDetail: HTMLDivElement;
  private readonly cards: HTMLDivElement;
  private readonly score: HTMLDivElement;
  private readonly hint: HTMLSpanElement;
  private readonly retry: HTMLButtonElement;
  private readonly exit: HTMLButtonElement;
  private payload: HonorReviewPayload | null = null;
  private cardButtons: HTMLButtonElement[] = [];
  private timer = 0;
  private selected = 0;
  private phase: 'hidden' | 'spotlight' | 'cards' | 'settled' = 'hidden';

  constructor(
    parent: HTMLElement,
    private readonly onRetry: () => void,
    private readonly onExit: () => void,
  ) {
    this.root = document.createElement('section');
    this.root.className = 'honor-review';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', '赛后荣誉');
    this.root.innerHTML = `
      <div class="honor-review-sheen" aria-hidden="true"></div>
      <header class="honor-review-head">
        <div class="honor-review-kicker"></div>
        <h2 class="honor-review-title"></h2>
        <div class="honor-review-result"></div>
      </header>
      <div class="honor-review-standings" role="list" aria-label="本局名次"></div>
      <div class="honor-review-spotlight">
        <img class="honor-review-spotlight-portrait" alt="" draggable="false">
        <div class="honor-review-spotlight-copy">
          <div class="honor-review-spotlight-label"></div>
          <strong class="honor-review-spotlight-title"></strong>
          <span class="honor-review-spotlight-detail"></span>
        </div>
      </div>
      <div class="honor-review-cards" role="list"></div>
      <footer class="honor-review-foot">
        <span class="honor-review-score"></span>
        <span class="honor-review-hint"></span>
        <button class="honor-review-retry" type="button"><span aria-hidden="true">↻</span> 再来一局</button>
        <button class="honor-review-exit" type="button"><span aria-hidden="true">←</span> 玩法目录</button>
      </footer>`;
    parent.appendChild(this.root);
    this.kicker = this.root.querySelector('.honor-review-kicker')!;
    this.title = this.root.querySelector('.honor-review-title')!;
    this.result = this.root.querySelector('.honor-review-result')!;
    this.standings = this.root.querySelector('.honor-review-standings')!;
    this.spotlight = this.root.querySelector('.honor-review-spotlight')!;
    this.spotlightPortrait = this.root.querySelector('.honor-review-spotlight-portrait')!;
    this.spotlightLabel = this.root.querySelector('.honor-review-spotlight-label')!;
    this.spotlightTitle = this.root.querySelector('.honor-review-spotlight-title')!;
    this.spotlightDetail = this.root.querySelector('.honor-review-spotlight-detail')!;
    this.cards = this.root.querySelector('.honor-review-cards')!;
    this.score = this.root.querySelector('.honor-review-score')!;
    this.hint = this.root.querySelector('.honor-review-hint')!;
    this.retry = this.root.querySelector('.honor-review-retry')!;
    this.exit = this.root.querySelector('.honor-review-exit')!;
    this.retry.addEventListener('click', () => this.onRetry());
    this.exit.addEventListener('click', () => this.onExit());
    this.root.addEventListener('keydown', (event) => {
      if (!this.visible()) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.move(-1);
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        this.move(1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.activate();
      }
    });
    this.hide();
  }

  show(payload: HonorReviewPayload): void {
    this.payload = payload;
    this.timer = 0;
    this.selected = 0;
    this.phase = 'spotlight';
    this.root.dataset.mode = payload.mode;
    this.root.style.setProperty('--honor-progress', '0');
    this.root.classList.add('on', 'spotlight');
    this.kicker.textContent = payload.mode === 'duo' ? 'DUO RACE · POST-MATCH ACCOLADES' : 'RACE · POST-MATCH ACCOLADES';
    this.title.textContent = '高光时刻';
    this.result.textContent = payload.resultLabel;
    this.score.textContent = `本局荣誉 ${Math.round(payload.summary.score)} · ${Object.values(payload.summary.counts).reduce((sum, value) => sum + value, 0)} 次记录`;
    this.hint.textContent = '高光播放中';
    this.renderStandings();
    this.renderSpotlight();
    this.renderCards();
    this.retry.disabled = true;
    this.exit.disabled = true;
    this.root.setAttribute('aria-hidden', 'false');
  }

  update(dt: number): void {
    if (!this.visible()) return;
    this.timer += Math.max(0, dt);
    if (this.phase === 'spotlight' && this.timer >= 2.65) this.revealCards();
    if (this.phase === 'cards' && this.timer >= 4.8) this.settle();
    const progress = Math.min(1, this.timer / 4.8);
    this.root.style.setProperty('--honor-progress', String(progress));
  }

  visible(): boolean {
    return this.phase !== 'hidden';
  }

  hide(): void {
    this.phase = 'hidden';
    this.payload = null;
    this.root.classList.remove('on', 'spotlight', 'cards', 'settled');
    this.root.setAttribute('aria-hidden', 'true');
    this.retry.disabled = true;
    this.exit.disabled = true;
  }

  move(direction: -1 | 1): void {
    if (!this.visible() || this.cardButtons.length === 0) return;
    if (this.phase === 'spotlight') this.revealCards();
    this.selected = (this.selected + direction + this.cardButtons.length) % this.cardButtons.length;
    this.focusSelected();
  }

  activate(): void {
    if (this.phase === 'spotlight') {
      this.revealCards();
      return;
    }
    if (this.phase === 'cards') {
      this.settle();
      return;
    }
    if (this.phase !== 'settled') return;
    if (document.activeElement === this.exit) this.onExit();
    else this.onRetry();
  }

  focusPrimary(): void {
    if (this.phase === 'settled') this.retry.focus({ preventScroll: true });
  }

  private renderSpotlight(): void {
    const payload = this.payload;
    const highlight = payload?.highlights[0];
    if (!payload || !highlight) {
      this.spotlightPortrait.removeAttribute('src');
      this.spotlightLabel.textContent = 'RUN SAVED';
      this.spotlightTitle.textContent = '稳健航海';
      this.spotlightDetail.textContent = '这局没有遗漏，下一局继续追分。';
      return;
    }
    const racer = payload.racers.find((item) => item.id === highlight.racerId) ?? payload.racers[0];
    if (racer) {
      this.spotlightPortrait.src = racer.portraitUrl;
      this.spotlightPortrait.style.setProperty('--racer-color', colorCss(racer.color));
    }
    this.spotlightLabel.textContent = 'PLAY OF THE RUN';
    this.spotlightTitle.textContent = highlight.title;
    this.spotlightDetail.textContent = `${highlight.detail} · ${highlight.count} 次 · ${highlight.score} 分`;
  }

  private renderStandings(): void {
    this.standings.textContent = '';
    const payload = this.payload;
    if (!payload) return;
    const humanLimit = payload.mode === 'duo' ? 2 : 1;
    for (const racer of payload.racers.slice(0, 6)) {
      const row = document.createElement('div');
      row.className = 'honor-review-standing';
      row.dataset.human = racer.id < humanLimit ? 'true' : 'false';
      row.setAttribute('role', 'listitem');
      const place = document.createElement('b');
      place.className = 'honor-review-standing-place';
      place.textContent = String(racer.place).padStart(2, '0');
      const name = document.createElement('span');
      name.className = 'honor-review-standing-name';
      name.textContent = racer.name;
      const points = document.createElement('i');
      points.className = 'honor-review-standing-score';
      points.textContent = `${Math.round(racer.score)} PTS`;
      row.append(place, name, points);
      this.standings.appendChild(row);
    }
  }

  private renderCards(): void {
    this.cards.textContent = '';
    this.cardButtons = [];
    const payload = this.payload;
    if (!payload) return;
    const cards = payload.highlights.length > 0 ? payload.highlights : [{
      id: 'clean.run', title: '稳健航海', detail: '本局完成有效航线', racerId: payload.racers[0]?.id ?? 0, count: 1, score: payload.summary.score,
    }];
    for (const [index, highlight] of cards.slice(0, 4).entries()) {
      const racer = payload.racers.find((item) => item.id === highlight.racerId) ?? payload.racers[0];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'honor-review-card';
      card.dataset.index = String(index);
      card.setAttribute('role', 'listitem');
      card.setAttribute('aria-label', `${highlight.title}，${highlight.detail}`);
      card.style.setProperty('--card-color', colorCss(racer?.color ?? 0x55e7ff));
      card.innerHTML = `
        <span class="honor-review-card-mark">${index === 0 ? '★' : '◆'}</span>
        <img class="honor-review-card-portrait" alt="" draggable="false">
        <span class="honor-review-card-copy">
          <strong></strong>
          <small></small>
          <i></i>
        </span>`;
      const portrait = card.querySelector('img')!;
      if (racer) portrait.src = racer.portraitUrl;
      card.querySelector('strong')!.textContent = highlight.title;
      card.querySelector('small')!.textContent = highlight.detail;
      card.querySelector('i')!.textContent = `×${highlight.count} · ${highlight.score} PTS`;
      card.addEventListener('click', () => {
        this.selected = index;
        this.focusSelected();
      });
      this.cards.appendChild(card);
      this.cardButtons.push(card);
    }
    this.focusSelected();
  }

  private focusSelected(): void {
    for (const [index, card] of this.cardButtons.entries()) card.classList.toggle('selected', index === this.selected);
    if (this.phase === 'settled') this.cardButtons[this.selected]?.focus({ preventScroll: true });
  }

  private revealCards(): void {
    if (this.phase !== 'spotlight') return;
    this.timer = Math.max(this.timer, 2.65);
    this.phase = 'cards';
    this.root.classList.remove('spotlight');
    this.root.classList.add('cards');
    this.hint.textContent = '← → 浏览荣誉卡 · ENTER 确认';
  }

  private settle(): void {
    if (this.phase !== 'cards') return;
    this.timer = Math.max(this.timer, 4.8);
    this.phase = 'settled';
    this.root.classList.add('settled');
    this.hint.textContent = '← → 选择卡片 · ENTER 确认';
    this.retry.disabled = false;
    this.exit.disabled = false;
    this.focusSelected();
  }
}

function colorCss(value: number): string {
  return `#${Math.max(0, value).toString(16).padStart(6, '0').slice(-6)}`;
}
