/**
 * hud.ts — cel/anime arcade HUD: speedometer + arc gauge, lap/position,
 * boost bar, split toasts, wrong-way banner, countdown, minimap, results.
 *
 * All DOM is built once in the constructor. Per-frame updates only touch
 * textContent/classList when the value actually changed; the gauge and
 * minimap canvases redraw every frame. Colors come from PALETTE — *Css
 * strings are injected as CSS custom properties, hex ints feed canvas.
 */
import * as THREE from 'three';
import type { RaceView, IBoat, ICourse, RacerState } from '../contracts';
import { PALETTE, RACER_COLORS } from '../core/palette';
import './hud.css';

const MAP_SIZE = 190;
const MAP_SAMPLES = 400;
const MAP_PAD = 14;
const GAUGE_W = 200;
const GAUGE_H = 120;
const SPEED_MAX = 34; // m/s that pins the gauge (matches the camera's FOV map)
const BOOST_SEGS = 8;
const TOAST_LIFE = 1.4; // matches the hud-toast keyframe duration
const FINAL_LAP_FLASH = 3.0; // seconds the FINAL LAP banner stays up
const GO_LINGER = 0.8;

/** Palette hex int → canvas/CSS color string. */
const css = (hexInt: number): string => '#' + hexInt.toString(16).padStart(6, '0');

const ORDINALS = ['1ST', '2ND', '3RD', '4TH'];
const ordinal = (place: number): string => ORDINALS[place - 1] ?? `${place}TH`;

/** Seconds → m:ss.mmm */
const fmtTime = (s: number): string => {
  if (!(s > 0)) return '--:--.---';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, '0')}`;
};

const h = (tag: string, cls: string, parent: HTMLElement, text?: string): HTMLDivElement => {
  const d = document.createElement(tag);
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  parent.appendChild(d);
  return d as HTMLDivElement;
};

const ctx2d = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const c = canvas.getContext('2d');
  if (!c) throw new Error('HUD: 2d canvas context unavailable');
  return c;
};

export class HUD {
  private readonly root: HTMLDivElement;

  // speedometer
  private readonly speedNum: HTMLDivElement;
  private readonly gctx: CanvasRenderingContext2D;

  // lap / final lap / position
  private readonly lapVal: HTMLDivElement;
  private readonly finalLapEl: HTMLDivElement;
  private readonly posNum: HTMLDivElement;
  private readonly posChip: HTMLDivElement;

  // boost
  private readonly boostBar: HTMLDivElement;
  private readonly boostSegEls: HTMLDivElement[] = [];

  // split toasts
  private readonly toastBox: HTMLDivElement;
  private readonly toasts: Array<{ el: HTMLDivElement; life: number }> = [];

  // wrong way / countdown
  private readonly wrongWayEl: HTMLDivElement;
  private readonly countdownEl: HTMLDivElement;

  // minimap
  private readonly mctx: CanvasRenderingContext2D;
  private readonly mapBase: HTMLCanvasElement; // offscreen spline pre-render
  private mapCx = 0;
  private mapCz = 0;
  private mapScale = 1;

  // results
  private readonly resultsEl: HTMLDivElement;
  private readonly resultsPlace: HTMLDivElement;
  private readonly resultsRows: HTMLDivElement;

  // change-detection state (no per-frame DOM string churn)
  private lastSpeed = -1;
  private lastLap = -1;
  private lastTotalLaps = -1;
  private lastPlace = -1;
  private lastChip = -1;
  private lastSegs = -1;
  private lastFull = false;
  private lastWrongWay = false;
  private lastCountdown = -1;
  private cdVisible = false;
  private goTimer = 0;
  private finalLapTimer = 0;
  private readonly lastSplits: number[] = [];

  constructor(container: HTMLElement, course: ICourse) {
    this.root = h('div', 'hud', container);
    // palette → CSS custom properties (single source of truth)
    const rs = this.root.style;
    rs.setProperty('--ink', PALETTE.inkCss);
    rs.setProperty('--panel', PALETTE.uiPanelCss);
    rs.setProperty('--text', PALETTE.uiTextCss);
    rs.setProperty('--accent', PALETTE.uiAccentCss);
    rs.setProperty('--warn', PALETTE.uiWarnCss);
    rs.setProperty('--boost', css(PALETTE.boost));

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // ---- top-left: lap / final lap / position -------------------------------
    const topleft = h('div', 'hud-topleft', this.root);
    const lap = h('div', 'hud-panel hud-lap', topleft);
    this.lapVal = h('div', 'hud-lap-val hud-inked', lap, 'LAP 1/-');
    this.finalLapEl = h('div', 'hud-finallap hud-inked', topleft, 'FINAL LAP!');
    const pos = h('div', 'hud-panel hud-pos', topleft);
    this.posNum = h('div', 'hud-pos-num hud-inked', pos, '-');
    this.posChip = h('div', 'hud-pos-chip', pos);

    // ---- minimap -------------------------------------------------------------
    const mapWrap = h('div', 'hud-panel hud-map', this.root);
    const mapCanvas = document.createElement('canvas');
    mapCanvas.className = 'hud-map-canvas';
    mapCanvas.width = MAP_SIZE * dpr;
    mapCanvas.height = MAP_SIZE * dpr;
    mapWrap.appendChild(mapCanvas);
    this.mctx = ctx2d(mapCanvas);
    this.mctx.scale(dpr, dpr);
    this.mapBase = document.createElement('canvas');
    this.mapBase.width = MAP_SIZE * dpr;
    this.mapBase.height = MAP_SIZE * dpr;
    this.prerenderMap(course, dpr);

    // ---- speedometer -----------------------------------------------------------
    const speedo = h('div', 'hud-speedo', this.root);
    const gaugeWrap = h('div', 'hud-panel hud-gauge-wrap', speedo);
    const gauge = document.createElement('canvas');
    gauge.className = 'hud-gauge';
    gauge.width = GAUGE_W * dpr;
    gauge.height = GAUGE_H * dpr;
    gaugeWrap.appendChild(gauge);
    this.gctx = ctx2d(gauge);
    this.gctx.scale(dpr, dpr);
    const speedPanel = h('div', 'hud-panel hud-speed-panel', speedo);
    this.speedNum = h('div', 'hud-speed-num hud-inked', speedPanel, '0');
    h('div', 'hud-speed-unit', speedPanel, 'KM/H');

    // ---- boost meter --------------------------------------------------------------
    this.boostBar = h('div', 'hud-panel hud-boost', this.root);
    h('div', 'hud-boost-label', this.boostBar, 'BOOST');
    for (let i = 0; i < BOOST_SEGS; i++) {
      this.boostSegEls.push(h('div', 'hud-boost-seg', this.boostBar));
    }

    // ---- toasts / wrong way / countdown ----------------------------------------------
    this.toastBox = h('div', 'hud-toasts', this.root);
    this.wrongWayEl = h('div', 'hud-wrongway', this.root, 'WRONG WAY!');
    this.countdownEl = h('div', 'hud-countdown', this.root);

    // ---- results ------------------------------------------------------------------------
    this.resultsEl = h('div', 'hud-results', this.root);
    const panel = h('div', 'hud-panel hud-results-panel', this.resultsEl);
    h('div', 'hud-results-title hud-inked', panel, 'FINISH!');
    this.resultsPlace = h('div', 'hud-results-place hud-inked', panel, '');
    this.resultsRows = h('div', 'hud-results-rows', panel);
    h('div', 'hud-results-again', panel, 'PRESS ENTER TO RACE AGAIN');
  }

  update(dt: number, race: RaceView, player: IBoat, all: IBoat[]): void {
    const st = player.state;

    // player racer state (RaceView exposes no player() accessor)
    let me: RacerState | undefined;
    for (let i = 0; i < race.racers.length; i++) {
      const r = race.racers[i];
      if (r.isPlayer) {
        me = r;
        break;
      }
    }

    // ---- speed number + gauge -------------------------------------------------
    const kmh = Math.max(0, Math.round(st.speed * 3.6));
    if (kmh !== this.lastSpeed) {
      this.lastSpeed = kmh;
      this.speedNum.textContent = String(kmh);
    }
    const speedN = st.speed > 0 ? Math.min(1, st.speed / SPEED_MAX) : 0;
    this.drawGauge(speedN, st.boosting);

    // ---- lap / final lap / position / wrong way ---------------------------------
    if (me) {
      if (me.lap !== this.lastLap || race.totalLaps !== this.lastTotalLaps) {
        const wasFinal = this.lastLap === race.totalLaps;
        this.lastLap = me.lap;
        this.lastTotalLaps = race.totalLaps;
        this.lapVal.textContent = `LAP ${me.lap}/${race.totalLaps}`;
        if (me.lap === race.totalLaps && !wasFinal && race.phase === 'racing') {
          this.finalLapTimer = FINAL_LAP_FLASH;
          this.finalLapEl.classList.remove('on');
          void this.finalLapEl.offsetWidth; // restart the flash animation
          this.finalLapEl.classList.add('on');
        }
      }
      if (me.place !== this.lastPlace) {
        this.lastPlace = me.place;
        this.posNum.textContent = ordinal(me.place);
        this.posNum.classList.toggle('first', me.place === 1);
      }
      if (me.color !== this.lastChip) {
        this.lastChip = me.color;
        this.posChip.style.background = css(me.color);
      }
      if (me.wrongWay !== this.lastWrongWay) {
        this.lastWrongWay = me.wrongWay;
        this.wrongWayEl.classList.toggle('on', me.wrongWay);
      }
    }
    if (this.finalLapTimer > 0) {
      this.finalLapTimer -= dt;
      if (this.finalLapTimer <= 0) this.finalLapEl.classList.remove('on');
    }

    // ---- split toasts: track every racer, toast only the player ---------------
    for (let i = 0; i < race.racers.length; i++) {
      const r = race.racers[i];
      const prev = this.lastSplits[r.id] ?? 0;
      if (r.splitDelta !== prev) {
        this.lastSplits[r.id] = r.splitDelta;
        if (r.isPlayer && r.splitDelta !== 0) this.spawnToast(r.splitDelta);
      }
    }
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.life -= dt;
      if (t.life <= 0) {
        t.el.remove();
        this.toasts.splice(i, 1);
      }
    }

    // ---- boost meter --------------------------------------------------------------
    const segs = Math.min(BOOST_SEGS, Math.floor(st.boostCharge * BOOST_SEGS + 1e-4));
    if (segs !== this.lastSegs) {
      this.lastSegs = segs;
      for (let i = 0; i < BOOST_SEGS; i++) {
        this.boostSegEls[i].classList.toggle('on', i < segs);
      }
    }
    const full = segs === BOOST_SEGS;
    if (full !== this.lastFull) {
      this.lastFull = full;
      this.boostBar.classList.toggle('full', full);
    }

    // ---- countdown -------------------------------------------------------------------
    const cv = race.countdownValue;
    if (cv !== this.lastCountdown) {
      this.lastCountdown = cv;
      if (race.phase === 'countdown' || cv === 0) this.showCountdown(cv);
    }
    if (this.goTimer > 0) {
      this.goTimer -= dt;
      if (this.goTimer <= 0) this.hideCountdown();
    } else if (this.cdVisible && race.phase !== 'countdown') {
      this.hideCountdown();
    }

    // ---- minimap ------------------------------------------------------------------------
    this.drawMinimap(player, all);
  }

  showResults(race: RaceView): void {
    let me: RacerState | undefined;
    for (let i = 0; i < race.racers.length; i++) {
      const r = race.racers[i];
      if (r.isPlayer) {
        me = r;
        break;
      }
    }
    const place = me ? me.place : 0;
    this.resultsPlace.textContent = place > 0 ? `${ordinal(place)} PLACE!` : 'RACE OVER';
    this.resultsPlace.classList.toggle('win', place === 1);
    this.resultsPlace.classList.toggle('lose', place > 1);

    this.resultsRows.textContent = '';
    const head = h('div', 'hud-results-row head', this.resultsRows);
    h('span', 'r-place', head, '');
    h('span', 'r-name', head, 'RACER');
    h('span', 'r-best', head, 'BEST');
    h('span', 'r-total', head, 'TOTAL');
    const sorted = race.racers.slice().sort((a, b) => a.place - b.place);
    for (const r of sorted) {
      const row = h('div', r.isPlayer ? 'hud-results-row me' : 'hud-results-row', this.resultsRows);
      h('span', 'r-place', row, ordinal(r.place));
      const name = h('span', 'r-name', row, r.name);
      name.style.color = css(r.color);
      h('span', 'r-best', row, fmtTime(r.bestLapTime));
      // finishTime is always set by race end (real or pace-extrapolated —
      // race.ts extrapolateFinishes); the +9999 sentinel means "no pace",
      // only that earns a DNF.
      h('span', 'r-total', row, r.finishTime > 0 && r.finishTime < 9000 ? fmtTime(r.finishTime) : 'DNF');
    }
    this.resultsEl.classList.add('on');
  }

  hideResults(): void {
    this.resultsEl.classList.remove('on');
  }

  // ------------------------------------------------------------------ pieces ----

  private showCountdown(v: number): void {
    const el = this.countdownEl;
    el.classList.remove('pop', 'go');
    void el.offsetWidth; // restart the CSS pop animation
    el.textContent = v > 0 ? String(v) : 'GO!';
    el.classList.add('pop');
    if (v === 0) {
      el.classList.add('go');
      this.goTimer = GO_LINGER;
    }
    this.cdVisible = true;
  }

  private hideCountdown(): void {
    this.cdVisible = false;
    this.goTimer = 0;
    this.countdownEl.classList.remove('pop', 'go');
  }

  private spawnToast(delta: number): void {
    const el = document.createElement('div');
    const ahead = delta < 0;
    el.className = ahead ? 'hud-toast hud-inked good' : 'hud-toast hud-inked bad';
    el.textContent = `${ahead ? '−' : '+'}${Math.abs(delta).toFixed(2)}`;
    this.toastBox.appendChild(el);
    this.toasts.push({ el, life: TOAST_LIFE });
  }

  private drawGauge(speedN: number, boosting: boolean): void {
    const g = this.gctx;
    const cx = GAUGE_W / 2;
    const cy = GAUGE_H - 14;
    const r = 82;
    const a0 = Math.PI;
    const a1 = Math.PI * 2;
    g.clearRect(0, 0, GAUGE_W, GAUGE_H);
    g.lineCap = 'butt';

    // ink track
    g.strokeStyle = PALETTE.inkCss;
    g.lineWidth = 15;
    g.beginPath();
    g.arc(cx, cy, r, a0, a1);
    g.stroke();

    // boost-colored overflow zone (top 20% of the dial)
    const az = a0 + (a1 - a0) * 0.8;
    g.strokeStyle = css(PALETTE.boost);
    g.beginPath();
    g.arc(cx, cy, r, az, a1);
    g.stroke();

    // accent fill, boost-colored once it spills into the overflow zone
    if (speedN > 0.001) {
      const fa = a0 + (a1 - a0) * speedN;
      g.lineWidth = 9;
      g.strokeStyle = PALETTE.uiAccentCss;
      g.beginPath();
      g.arc(cx, cy, r, a0, Math.min(fa, az));
      g.stroke();
      if (fa > az) {
        g.strokeStyle = css(PALETTE.boost);
        g.beginPath();
        g.arc(cx, cy, r, az, fa);
        g.stroke();
      }
    }

    // tick marks
    g.strokeStyle = PALETTE.uiTextCss;
    g.lineWidth = 2;
    for (let i = 1; i < 8; i++) {
      const a = a0 + ((a1 - a0) * i) / 8;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      g.beginPath();
      g.moveTo(cx + ca * (r - 15), cy + sa * (r - 15));
      g.lineTo(cx + ca * (r - 7), cy + sa * (r - 7));
      g.stroke();
    }

    // needle + hub
    const na = a0 + (a1 - a0) * speedN;
    g.strokeStyle = PALETTE.uiTextCss;
    g.lineWidth = 3.5;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(na) * (r - 20), cy + Math.sin(na) * (r - 20));
    g.stroke();
    g.fillStyle = PALETTE.inkCss;
    g.beginPath();
    g.arc(cx, cy, 7, 0, Math.PI * 2);
    g.fill();

    // boost flare ring
    if (boosting) {
      g.strokeStyle = css(PALETTE.boost);
      g.lineWidth = 3;
      g.beginPath();
      g.arc(cx, cy, r + 8, a0, a1);
      g.stroke();
    }
  }

  /** Sample the spline once, compute bounds, bake ink+accent track to the offscreen canvas. */
  private prerenderMap(course: ICourse, dpr: number): void {
    const v = new THREE.Vector3();
    const tv = new THREE.Vector3();
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < MAP_SAMPLES; i++) {
      course.pointAt(i / MAP_SAMPLES, v);
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
    }
    this.mapCx = (minX + maxX) / 2;
    this.mapCz = (minZ + maxZ) / 2;
    this.mapScale = Math.min(
      (MAP_SIZE - MAP_PAD * 2) / Math.max(1e-6, maxX - minX),
      (MAP_SIZE - MAP_PAD * 2) / Math.max(1e-6, maxZ - minZ),
    );

    const b = ctx2d(this.mapBase);
    b.scale(dpr, dpr);
    b.lineJoin = 'round';
    b.lineCap = 'round';

    // thick ink outline, then the accent inner line
    for (let pass = 0; pass < 2; pass++) {
      b.strokeStyle = pass === 0 ? PALETTE.inkCss : PALETTE.uiAccentCss;
      b.lineWidth = pass === 0 ? 9 : 3.5;
      b.beginPath();
      for (let i = 0; i <= MAP_SAMPLES; i++) {
        course.pointAt((i % MAP_SAMPLES) / MAP_SAMPLES, v);
        const x = this.mapX(v.x);
        const y = this.mapY(v.z);
        if (i === 0) b.moveTo(x, y);
        else b.lineTo(x, y);
      }
      b.closePath();
      b.stroke();
    }

    // start/finish tick across the track
    course.pointAt(0, v);
    course.tangentAt(0, tv);
    const px = this.mapX(v.x);
    const py = this.mapY(v.z);
    const nx = -tv.z;
    const nz = tv.x;
    const nl = Math.hypot(nx, nz) || 1;
    const dx = (nx / nl) * 7;
    const dy = (nz / nl) * 7;
    b.strokeStyle = PALETTE.inkCss;
    b.lineWidth = 5;
    b.beginPath();
    b.moveTo(px - dx, py - dy);
    b.lineTo(px + dx, py + dy);
    b.stroke();
    b.strokeStyle = PALETTE.uiTextCss;
    b.lineWidth = 2.5;
    b.beginPath();
    b.moveTo(px - dx, py - dy);
    b.lineTo(px + dx, py + dy);
    b.stroke();
  }

  private mapX(x: number): number {
    return MAP_SIZE / 2 + (x - this.mapCx) * this.mapScale;
  }

  private mapY(z: number): number {
    return MAP_SIZE / 2 + (z - this.mapCz) * this.mapScale;
  }

  private drawMinimap(player: IBoat, all: IBoat[]): void {
    const m = this.mctx;
    m.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
    m.drawImage(this.mapBase, 0, 0, MAP_SIZE, MAP_SIZE);
    // AI dots first, player dot last (on top)
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < all.length; i++) {
        const boat = all[i];
        const isPlayer = boat === player;
        if ((pass === 1) !== isPlayer) continue;
        const x = this.mapX(boat.state.position.x);
        const y = this.mapY(boat.state.position.z);
        const r = isPlayer ? 6.5 : 4.5;
        m.beginPath();
        m.arc(x, y, r, 0, Math.PI * 2);
        m.fillStyle = css(RACER_COLORS[boat.id % RACER_COLORS.length]);
        m.fill();
        m.lineWidth = 2.5;
        m.strokeStyle = PALETTE.inkCss;
        m.stroke();
        if (isPlayer) {
          m.beginPath();
          m.arc(x, y, r + 3, 0, Math.PI * 2);
          m.lineWidth = 2;
          m.strokeStyle = PALETTE.uiTextCss;
          m.stroke();
        }
      }
    }
  }
}
