import type { HonorSummary, RaceMode } from '../contracts';
import type { HonorHighlight } from '../game/honors';
import machoMedalUrl from '../assets/achievements/macho-medal.webp';
import { MedalCeremonyCanvas } from './medalCeremony';
import './honorHighlights.css';

const HONOR_AUTO_CONTINUE_S = 5;

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
  /** The next-round action is only available after a successful Final. */
  canContinue: boolean;
  /**
   * True when the countdown carried the player here without a click. That run
   * is still going, so the wall keeps only the next-round action; the exits
   * stay for every other entry (an explicit confirmation or a failed run).
   */
  autoEntered: boolean;
  /** Persisted total shown beside this result for future server parity. */
  historyHonorScore: number;
}

/**
 * Grand Macho Medal & Accolades Ceremony (猛男勋章 · 终局荣耀大典)
 */
export class HonorHighlights {
  private readonly root: HTMLElement;
  private readonly medalCanvas: MedalCeremonyCanvas;
  private readonly medalIcon: HTMLImageElement;
  private readonly kicker: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly result: HTMLDivElement;
  private readonly standings: HTMLDivElement;
  private readonly spotlight: HTMLDivElement;
  private readonly spotlightPortrait: HTMLImageElement;
  private readonly spotlightLabel: HTMLDivElement;
  private readonly spotlightTitle: HTMLDivElement;
  private readonly spotlightDetail: HTMLDivElement;
  private readonly spotlightBadge: HTMLSpanElement;
  private readonly spotlightRating: HTMLSpanElement;
  private readonly cards: HTMLDivElement;
  private readonly score: HTMLDivElement;
  private readonly hint: HTMLSpanElement;
  private readonly continue: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private readonly exit: HTMLButtonElement;
  private payload: HonorReviewPayload | null = null;
  private cardButtons: HTMLButtonElement[] = [];
  private timer = 0;
  private autoContinueRemaining = 0;
  private autoContinueTriggered = false;
  private autoContinueDisplayedSecond = -1;
  private autoOnly = false;
  private selected = 0;
  private phase: 'hidden' | 'spotlight' | 'cards' | 'settled' = 'hidden';

  constructor(
    parent: HTMLElement,
    private readonly onContinue: () => void,
    private readonly onRetry: () => void,
    private readonly onExit: () => void,
  ) {
    this.root = document.createElement('section');
    this.root.className = 'honor-review';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', '猛男勋章 · 终局荣耀大典');
    this.root.innerHTML = `
      <div class="honor-review-sheen" aria-hidden="true"></div>
      <header class="honor-review-head">
        <img class="honor-review-medal-icon" src="${machoMedalUrl}" alt="猛男勋章" draggable="false">
        <div class="honor-review-kicker">🏅 MACHO MEDAL AWARD // 猛男勋章 · 终局荣耀大典</div>
        <h2 class="honor-review-title">猛男勋章授予</h2>
        <div class="honor-review-result"></div>
      </header>
      <div class="honor-review-standings" role="list" aria-label="本局名次"></div>
      <div class="honor-review-spotlight">
        <div class="honor-review-spotlight-media">
          <img class="honor-review-spotlight-portrait" alt="" draggable="false">
          <span class="honor-review-spotlight-badge"></span>
        </div>
        <div class="honor-review-spotlight-copy">
          <div class="honor-review-spotlight-kicker-row">
            <div class="honor-review-spotlight-label"></div>
            <span class="honor-review-spotlight-rating"></span>
          </div>
          <strong class="honor-review-spotlight-title"></strong>
          <span class="honor-review-spotlight-detail"></span>
        </div>
      </div>
      <div class="honor-review-cards" role="list"></div>
      <footer class="honor-review-foot">
        <span class="honor-review-score"></span>
        <span class="honor-review-hint"></span>
        <button class="honor-review-continue" type="button"><span aria-hidden="true">🚀</span> 进入下一轮</button>
        <button class="honor-review-retry" type="button"><span aria-hidden="true">↻</span> 重新起航</button>
        <button class="honor-review-exit" type="button"><span aria-hidden="true">←</span> 玩法目录</button>
      </footer>`;
    parent.appendChild(this.root);
    this.medalCanvas = new MedalCeremonyCanvas(this.root);
    this.medalIcon = this.root.querySelector('.honor-review-medal-icon')!;
    this.kicker = this.root.querySelector('.honor-review-kicker')!;
    this.title = this.root.querySelector('.honor-review-title')!;
    this.result = this.root.querySelector('.honor-review-result')!;
    this.standings = this.root.querySelector('.honor-review-standings')!;
    this.spotlight = this.root.querySelector('.honor-review-spotlight')!;
    this.spotlightPortrait = this.root.querySelector('.honor-review-spotlight-portrait')!;
    this.spotlightBadge = this.root.querySelector('.honor-review-spotlight-badge')!;
    this.spotlightRating = this.root.querySelector('.honor-review-spotlight-rating')!;
    this.spotlightLabel = this.root.querySelector('.honor-review-spotlight-label')!;
    this.spotlightTitle = this.root.querySelector('.honor-review-spotlight-title')!;
    this.spotlightDetail = this.root.querySelector('.honor-review-spotlight-detail')!;
    this.cards = this.root.querySelector('.honor-review-cards')!;
    this.score = this.root.querySelector('.honor-review-score')!;
    this.hint = this.root.querySelector('.honor-review-hint')!;
    this.continue = this.root.querySelector('.honor-review-continue')!;
    this.retry = this.root.querySelector('.honor-review-retry')!;
    this.exit = this.root.querySelector('.honor-review-exit')!;
    this.continue.addEventListener('click', () => this.onContinue());
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
    this.autoContinueRemaining = 0;
    this.autoContinueTriggered = false;
    this.autoContinueDisplayedSecond = -1;
    this.autoOnly = false;
    this.selected = 0;
    this.phase = 'spotlight';
    this.root.dataset.mode = payload.mode;
    this.root.style.setProperty('--honor-progress', '0');
    this.root.classList.add('on', 'spotlight');
    const isWinner = payload.racers[0]?.place === 1;
    this.kicker.textContent = isWinner
      ? '🏅 MACHO MEDAL AWARD // 猛男勋章 · 终局荣耀大典'
      : '🏅 BRAVERY MEDAL // 勇者勋章 · 虽败犹荣大典';
    this.title.textContent = isWinner ? '猛男勋章授予' : '勇者勋章嘉奖';
    this.result.textContent = payload.resultLabel;
    this.score.textContent = `本局荣誉 ${Math.round(payload.summary.score)} · 历史荣誉 ${Math.round(payload.historyHonorScore)} · ${Object.values(payload.summary.counts).reduce((sum, value) => sum + value, 0)} 次高光记录`;
    this.hint.textContent = '荣誉大典展示中';
    this.renderStandings();
    this.renderSpotlight();
    this.renderCards();
    // A run that is still going has no business offering "start over" or
    // "leave": the countdown brought the player here, so only the next-round
    // action stays on screen until it fires.
    this.autoOnly = payload.autoEntered && payload.canContinue;
    this.continue.hidden = !payload.canContinue;
    this.continue.disabled = true;
    this.resetContinueLabel();
    this.retry.hidden = this.autoOnly;
    this.exit.hidden = this.autoOnly;
    this.retry.disabled = true;
    this.exit.disabled = true;
    this.root.setAttribute('aria-hidden', 'false');
  }

  update(dt: number): void {
    if (!this.visible()) return;
    this.timer += Math.max(0, dt);
    this.medalCanvas.render(this.timer, 12, 'excellent');
    if (this.phase === 'spotlight' && this.timer >= 2.65) this.revealCards();
    if (this.phase === 'cards' && this.timer >= 4.8) this.settle();
    if (this.phase === 'settled' && this.payload?.canContinue && !this.autoContinueTriggered) {
      this.autoContinueRemaining = Math.max(0, this.autoContinueRemaining - Math.max(0, dt));
      this.updateContinueLabel();
      if (this.autoContinueRemaining <= 0) {
        this.autoContinueTriggered = true;
        this.onContinue();
        return;
      }
    }
    const progress = Math.min(1, this.timer / 4.8);
    this.root.style.setProperty('--honor-progress', String(progress));
  }

  visible(): boolean {
    return this.phase !== 'hidden';
  }

  hide(): void {
    this.phase = 'hidden';
    this.payload = null;
    this.autoContinueRemaining = 0;
    this.autoContinueTriggered = false;
    this.autoContinueDisplayedSecond = -1;
    this.medalCanvas.clear();
    this.root.classList.remove('on', 'spotlight', 'cards', 'settled');
    this.root.setAttribute('aria-hidden', 'true');
    this.autoOnly = false;
    this.continue.hidden = false;
    this.continue.disabled = true;
    this.resetContinueLabel();
    this.retry.hidden = false;
    this.exit.hidden = false;
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
    else if (document.activeElement === this.retry) this.onRetry();
    else if (this.payload?.canContinue) this.onContinue();
    else this.onRetry();
  }

  focusPrimary(): void {
    if (this.phase === 'settled') {
      if (this.payload?.canContinue) this.continue.focus({ preventScroll: true });
      else this.retry.focus({ preventScroll: true });
    }
  }

  private renderSpotlight(): void {
    const payload = this.payload;
    const highlight = payload?.highlights[0];
    if (!payload || !highlight) {
      this.spotlightPortrait.removeAttribute('src');
      this.spotlight.dataset.rarity = 'classic';
      this.spotlightBadge.textContent = '★ 稳健航行';
      this.spotlightRating.textContent = '[ S · 凌云飞将 ]';
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
    const rarity = highlight.rarity ?? 'classic';
    this.spotlight.dataset.rarity = rarity;
    this.spotlightBadge.textContent = highlight.badge ?? '★ 经典成就';
    const ratingLabel = highlight.score >= 400 || rarity === 'legendary'
      ? '[ SSS · 极速传说 ]'
      : highlight.score >= 250 || rarity === 'epic'
        ? '[ SS · 破浪狂鲨 ]'
        : highlight.score >= 120 || rarity === 'gold'
          ? '[ S · 凌云飞将 ]'
          : '[ A · 竞速精英 ]';
    this.spotlightRating.textContent = ratingLabel;
    this.spotlightLabel.textContent = 'PLAY OF THE RUN · 本局最佳成就';
    this.spotlightTitle.textContent = highlight.title;
    this.spotlightDetail.textContent = `${highlight.detail} · 达成 ${highlight.count} 次 · 荣耀斩获 ${highlight.score} PTS`;
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
      id: 'clean.run', title: '稳健航海', detail: '本局完成有效航线', racerId: payload.racers[0]?.id ?? 0, count: 1, score: payload.summary.score, rarity: 'classic' as const, badge: '★ 稳健航行', icon: '★',
    }];
    for (const [index, highlight] of cards.slice(0, 4).entries()) {
      const racer = payload.racers.find((item) => item.id === highlight.racerId) ?? payload.racers[0];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'honor-review-card';
      card.dataset.index = String(index);
      card.dataset.rarity = highlight.rarity ?? 'classic';
      card.setAttribute('role', 'listitem');
      card.setAttribute('aria-label', `${highlight.title}，${highlight.detail}`);
      card.style.setProperty('--card-color', colorCss(racer?.color ?? 0x55e7ff));
      card.innerHTML = `
        <div class="honor-review-card-media">
          <img class="honor-review-card-portrait" alt="" draggable="false">
          <span class="honor-review-card-mark">${highlight.icon ?? (index === 0 ? '★' : '◆')}</span>
        </div>
        <div class="honor-review-card-copy">
          <div class="honor-review-card-header">
            <span class="honor-review-card-badge">${highlight.badge ?? '荣誉'}</span>
            <i>×${highlight.count} · +${highlight.score} PTS</i>
          </div>
          <strong>${highlight.title}</strong>
          <small>${highlight.detail}</small>
        </div>`;
      const portrait = card.querySelector('img')!;
      if (racer) portrait.src = racer.portraitUrl;
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
    this.autoContinueRemaining = this.payload?.canContinue ? HONOR_AUTO_CONTINUE_S : 0;
    this.hint.textContent = this.autoOnly
      ? '5 秒后自动回到赛道 · ← → 浏览荣誉卡'
      : this.payload?.canContinue
        ? '5 秒后自动回到赛道 · ← → 选择卡片 · ENTER 立即继续'
        : '← → 选择卡片 · ENTER 再来一局';
    this.continue.disabled = !this.payload?.canContinue;
    this.retry.disabled = this.autoOnly;
    this.exit.disabled = this.autoOnly;
    this.updateContinueLabel();
    this.focusPrimary();
  }

  private resetContinueLabel(): void {
    this.autoContinueDisplayedSecond = -1;
    this.continue.innerHTML = '<span aria-hidden="true">▶</span> 游戏尚未结束';
    this.continue.removeAttribute('aria-label');
  }

  private updateContinueLabel(): void {
    if (!this.payload?.canContinue || this.phase !== 'settled') return;
    const seconds = Math.max(1, Math.ceil(this.autoContinueRemaining));
    if (seconds === this.autoContinueDisplayedSecond) return;
    this.autoContinueDisplayedSecond = seconds;
    this.continue.innerHTML = `<span aria-hidden="true">▶</span> 游戏尚未结束 · ${seconds} 秒`;
    this.continue.setAttribute('aria-label', `游戏尚未结束，${seconds}秒后自动回到赛道`);
  }
}

function colorCss(value: number): string {
  return `#${Math.max(0, value).toString(16).padStart(6, '0').slice(-6)}`;
}
