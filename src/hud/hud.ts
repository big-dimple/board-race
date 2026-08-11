/**
 * hud.ts — cel/anime arcade HUD: speedometer + arc gauge, lap/position,
 * boost/flight power unit, split toasts, wrong-way banner, countdown, minimap,
 * and results.
 *
 * All DOM is built once in the constructor. Per-frame updates only touch
 * textContent/classList when the value actually changed; the gauge and
 * minimap canvases redraw every frame. Colors come from PALETTE — *Css
 * strings are injected as CSS custom properties, hex ints feed canvas.
 */
import * as THREE from 'three';
import type {
  RaceView,
  IBoat,
  ICourse,
  RacerState,
  RaceBattleEvent,
  ChallengeResult,
  FlightFailureSnapshot,
  FlightRouteFailReason,
} from '../contracts';
import { PALETTE } from '../core/palette';
import { RACER_COLORS } from '../game/racers';
import './hud.css';

const MAP_SIZE = 190;
const MAP_SAMPLES = 400;
const MAP_PAD = 14;
const GAUGE_W = 200;
const GAUGE_H = 120;
const CRUISE_SPEED = 34;
const SPEED_MAX = 50;
const BOOST_SEGS = 8;
const FLIGHT_PIPS = 5;
const TOAST_LIFE = 1.4; // matches the hud-toast keyframe duration
const FINAL_LAP_FLASH = 3.0; // seconds the FINAL LAP banner stays up
const GO_LINGER = 0.8;

interface ImpactNotice {
  kind: string;
  kicker: string;
  title: string;
  detail: string;
  color: number;
  duration: number;
  priority: number;
}

/** Palette hex int → canvas/CSS color string. */
const css = (hexInt: number): string => '#' + hexInt.toString(16).padStart(6, '0');

const ORDINALS = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH'];
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
  private readonly course: ICourse;

  // speedometer
  private readonly speedNum: HTMLDivElement;
  private readonly gctx: CanvasRenderingContext2D;

  // lap / final lap / position
  private readonly lapVal: HTMLDivElement;
  private readonly finalLapEl: HTMLDivElement;
  private readonly posNum: HTMLDivElement;
  private readonly posChip: HTMLDivElement;
  private readonly posGap: HTMLDivElement;

  // boost / earned flight token
  private readonly powerPanel: HTMLDivElement;
  private readonly boostBar: HTMLDivElement;
  private readonly boostLabel: HTMLDivElement;
  private readonly boostSegEls: HTMLDivElement[] = [];
  private readonly flightToken: HTMLDivElement;
  private readonly flightPipEls: HTMLDivElement[] = [];
  private readonly flightPrompt: HTMLDivElement;
  private flightPromptHitTimer = 0;

  // full-screen, event-driven impact layer
  private readonly driftFx: HTMLDivElement;
  private readonly impactEl: HTMLDivElement;
  private readonly impactKicker: HTMLDivElement;
  private readonly impactTitle: HTMLDivElement;
  private readonly impactDetail: HTMLDivElement;
  private readonly impactQueue: ImpactNotice[] = [];
  private impactTimer = 0;
  private impactPriority = -1;
  private activeImpact: ImpactNotice | null = null;

  // Overtakes are competition-critical and never share the generic queue.
  private readonly battleEl: HTMLDivElement;
  private readonly battleLabel: HTMLDivElement;
  private readonly battleFrom: HTMLSpanElement;
  private readonly battleTo: HTMLSpanElement;
  private readonly battleOpponent: HTMLDivElement;
  private readonly battleStreak: HTMLDivElement;
  private battleTimer = 0;
  private readonly turnWarning: HTMLDivElement;
  private turnWarningTimer = 0;

  // split toasts
  private readonly toastBox: HTMLDivElement;
  private readonly toasts: Array<{ el: HTMLDivElement; life: number }> = [];

  // wrong way / countdown
  private readonly wrongWayEl: HTMLDivElement;
  private readonly countdownEl: HTMLDivElement;
  private readonly brandEl: HTMLDivElement;

  // minimap
  private readonly mctx: CanvasRenderingContext2D;
  private readonly mapBase: HTMLCanvasElement; // offscreen spline pre-render
  private mapCx = 0;
  private mapCz = 0;
  private mapScale = 1;
  private readonly mapTemp = new THREE.Vector3();

  // results
  private readonly resultsEl: HTMLDivElement;
  private readonly resultsPanel: HTMLDivElement;
  private readonly resultsTitle: HTMLDivElement;
  private readonly resultsPlace: HTMLDivElement;
  private readonly resultsRows: HTMLDivElement;
  private readonly resultsReason: HTMLDivElement;
  private readonly resultsMedal: HTMLDivElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly lessonEl: HTMLDivElement;
  private readonly lessonAttempt: HTMLDivElement;
  private readonly lessonTitle: HTMLDivElement;
  private readonly lessonCopy: HTMLDivElement;
  private readonly lessonMetric: HTMLDivElement;
  private readonly lessonPips: HTMLDivElement[] = [];

  // change-detection state (no per-frame DOM string churn)
  private lastSpeed = -1;
  private lastLap = -1;
  private lastTotalLaps = -1;
  private lastPlace = -1;
  private lastChip = -1;
  private lastGapText = '';
  private lastSegs = -1;
  private lastFull = false;
  private lastDrifting = false;
  private lastFlightPips = -1;
  private lastFlightReady = false;
  private lastFlightActive = false;
  private lastFlightPhase = 'surface';
  private lastFlightRouteState = 'idle';
  private lastFlightGateProgress = 0;
  private lastDriftTier = 0;
  private hudTime = 0;
  private flightAlertTimer = 0;
  private lastWrongWay = false;
  private lastCountdown = -1;
  private cdVisible = false;
  private goTimer = 0;
  private finalLapTimer = 0;
  private readonly lastSplits: number[] = [];

  constructor(container: HTMLElement, course: ICourse, onRetry: () => void) {
    this.course = course;
    this.root = h('div', 'hud', container);
    // palette → CSS custom properties (single source of truth)
    const rs = this.root.style;
    rs.setProperty('--ink', PALETTE.inkCss);
    rs.setProperty('--panel', PALETTE.uiPanelCss);
    rs.setProperty('--text', PALETTE.uiTextCss);
    rs.setProperty('--accent', PALETTE.uiAccentCss);
    rs.setProperty('--warn', PALETTE.uiWarnCss);
    rs.setProperty('--boost', css(PALETTE.boost));
    rs.setProperty('--flight', css(PALETTE.flight));
    rs.setProperty('--flight-deep', css(PALETTE.flightDeep));

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // ---- top-left: lap / final lap / position -------------------------------
    const topleft = h('div', 'hud-topleft', this.root);
    const lap = h('div', 'hud-panel hud-lap', topleft);
    this.lapVal = h('div', 'hud-lap-val hud-inked', lap, 'FLIGHTS 0 / 3');
    this.finalLapEl = h('div', 'hud-finallap hud-inked', topleft, '优秀资格丢失');
    const pos = h('div', 'hud-panel hud-pos', topleft);
    this.posNum = h('div', 'hud-pos-num hud-inked', pos, '- / 6');
    this.posChip = h('div', 'hud-pos-chip', pos);
    this.posGap = h('div', 'hud-pos-gap', pos, '距第一 --m');

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

    // ---- single power unit: earned flight token above the original boost bar ----
    this.powerPanel = h('div', 'hud-panel hud-power', this.root);
    const flightRow = h('div', 'hud-flight', this.powerPanel);
    h('div', 'hud-flight-label', flightRow, 'FLIGHT');
    this.flightToken = h('div', 'hud-flight-token', flightRow);
    const flightPips = h('div', 'hud-flight-pips', flightRow);
    for (let i = 0; i < FLIGHT_PIPS; i++) {
      this.flightPipEls.push(h('div', 'hud-flight-pip', flightPips));
    }

    this.boostBar = h('div', 'hud-boost', this.powerPanel);
    this.boostLabel = h('div', 'hud-boost-label', this.boostBar, 'BOOST');
    for (let i = 0; i < BOOST_SEGS; i++) {
      const seg = h('div', 'hud-boost-seg', this.boostBar);
      if (i >= BOOST_SEGS - 2) seg.classList.add('hot');
      this.boostSegEls.push(seg);
    }

    // ---- toasts / wrong way / countdown ----------------------------------------------
    this.toastBox = h('div', 'hud-toasts', this.root);
    this.driftFx = h('div', 'hud-drift-fx', this.root);
    this.impactEl = h('div', 'hud-impact', this.root);
    this.impactEl.setAttribute('role', 'status');
    this.impactEl.setAttribute('aria-live', 'polite');
    h('div', 'hud-impact-flash', this.impactEl);
    h('div', 'hud-impact-lines left', this.impactEl);
    h('div', 'hud-impact-lines right', this.impactEl);
    const impactCopy = h('div', 'hud-impact-copy', this.impactEl);
    this.impactKicker = h('div', 'hud-impact-kicker hud-inked', impactCopy);
    this.impactTitle = h('div', 'hud-impact-title hud-inked', impactCopy);
    this.impactDetail = h('div', 'hud-impact-detail', impactCopy);

    this.battleEl = h('div', 'hud-battle', this.root);
    this.battleEl.setAttribute('role', 'status');
    this.battleEl.setAttribute('aria-live', 'polite');
    const battleSky = h('div', 'hud-battle-sky', this.battleEl);
    h('div', 'hud-battle-sky-flash', battleSky);
    const firework = h('div', 'hud-battle-firework', battleSky);
    for (let i = 0; i < 24; i++) {
      const side = i < 12 ? -1 : 1;
      const shard = h('i', `hud-battle-shard shard-${i % 3} side-${side < 0 ? 'left' : 'right'}`, firework);
      const j = i % 12;
      const a = (-2.75 + j * 0.23) * side;
      const dist = 42 + (j % 4) * 14;
      const dx = Math.cos(a) * dist;
      const dy = -18 - Math.abs(Math.sin(a)) * dist;
      shard.style.setProperty('--origin', side < 0 ? '30%' : '70%');
      shard.style.setProperty('--sx', `${dx * 0.38}px`);
      shard.style.setProperty('--sy', `${dy * 0.38}px`);
      shard.style.setProperty('--dx', `${dx}px`);
      shard.style.setProperty('--dy', `${dy}px`);
      shard.style.setProperty('--rot', `${side * (80 + j * 29)}deg`);
      shard.style.setProperty('--delay', `${(j % 4) * 18}ms`);
      shard.setAttribute('aria-hidden', 'true');
    }
    const battleCopy = h('div', 'hud-battle-copy', battleSky);
    this.battleLabel = h('div', 'hud-battle-label hud-inked', battleCopy);
    const battlePlaces = h('div', 'hud-battle-places hud-inked', battleCopy);
    this.battleFrom = h('span', 'hud-battle-from', battlePlaces) as unknown as HTMLSpanElement;
    h('span', 'hud-battle-arrow', battlePlaces, '▸');
    this.battleTo = h('span', 'hud-battle-to', battlePlaces) as unknown as HTMLSpanElement;
    this.battleOpponent = h('div', 'hud-battle-opponent hud-inked', battleCopy);
    this.battleStreak = h('div', 'hud-battle-streak hud-inked', battleCopy);

    this.flightPrompt = h('div', 'hud-flight-prompt', this.root);
    h('div', 'hud-keycap hud-inked', this.flightPrompt, 'SPACE');
    const promptCopy = h('div', 'hud-flight-prompt-copy', this.flightPrompt);
    h('div', 'hud-flight-prompt-en', promptCopy, 'FLIGHT READY');
    h('div', 'hud-flight-prompt-cn', promptCopy, '按 SPACE 起飞');
    h('div', 'hud-flight-prompt-rule', promptCopy, '下一飞已就绪');
    this.turnWarning = h('div', 'hud-turn-warning', this.root);
    h('div', 'hud-turn-warning-mark hud-inked', this.turnWarning, '!');
    const turnCopy = h('div', 'hud-turn-warning-copy', this.turnWarning);
    h('div', 'hud-turn-warning-title hud-inked', turnCopy, '急弯逼近');
    h('div', 'hud-turn-warning-detail', turnCopy, '按住 SHIFT 空刹 · A / D 转向');
    this.wrongWayEl = h('div', 'hud-wrongway', this.root, 'WRONG WAY!');
    this.brandEl = h('div', 'hud-brand', this.root);
    h('div', 'hud-brand-lead hud-inked', this.brandEl, '是男人就飞三次');
    const brandAction = h('div', 'hud-brand-action hud-inked', this.brandEl);
    h('span', 'hud-brand-drift', brandAction, '三飞全过');
    h('span', 'hud-brand-flight', brandAction, '第一才算优秀');
    this.countdownEl = h('div', 'hud-countdown', this.root);

    // ---- results ------------------------------------------------------------------------
    this.resultsEl = h('div', 'hud-results', this.root);
    h('div', 'hud-results-energy', this.resultsEl);
    this.resultsPanel = h('div', 'hud-panel hud-results-panel', this.resultsEl);
    h('div', 'hud-results-eyebrow', this.resultsPanel, 'ONE RUN · THREE FLIGHTS');
    this.resultsTitle = h('div', 'hud-results-title hud-inked', this.resultsPanel, '挑战结束');
    this.resultsPlace = h('div', 'hud-results-place hud-inked', this.resultsPanel, '');
    this.resultsReason = h('div', 'hud-results-reason', this.resultsPanel, '');
    this.resultsMedal = h('div', 'hud-results-medal hud-inked', this.resultsPanel, '');
    this.resultsRows = h('div', 'hud-results-rows', this.resultsPanel);
    this.retryButton = document.createElement('button');
    this.retryButton.className = 'hud-retry';
    this.retryButton.type = 'button';
    this.retryButton.innerHTML = '<span class="hud-retry-key">↻</span><span>再飞一次</span>';
    this.retryButton.addEventListener('click', onRetry);
    this.resultsPanel.appendChild(this.retryButton);
    h('div', 'hud-results-again', this.resultsPanel, 'ENTER / R  ·  立即重试');

    // ---- forced retry lesson ----------------------------------------------------------
    this.lessonEl = h('div', 'hud-retry-lesson', this.root);
    this.lessonEl.addEventListener('pointerdown', onRetry);
    h('div', 'hud-lesson-grid', this.lessonEl);
    const lessonInner = h('div', 'hud-lesson-inner', this.lessonEl);
    this.lessonAttempt = h('div', 'hud-lesson-attempt', lessonInner, 'LOADING NEXT RUN');
    this.lessonTitle = h('div', 'hud-lesson-title hud-inked', lessonInner);
    this.lessonCopy = h('div', 'hud-lesson-copy', lessonInner);
    this.lessonMetric = h('div', 'hud-lesson-metric', lessonInner);
    const lessonProgress = h('div', 'hud-lesson-progress', lessonInner);
    for (let i = 0; i < 6; i++) this.lessonPips.push(h('i', 'hud-lesson-pip', lessonProgress));
  }

  update(dt: number, race: RaceView, player: IBoat, all: IBoat[]): void {
    const st = player.state;
    this.hudTime += dt;

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
      if (st.flightsCleared !== this.lastLap) {
        this.lastLap = st.flightsCleared;
        this.lapVal.textContent = `FLIGHTS ${st.flightsCleared} / 3`;
      }
      if (me.place !== this.lastPlace) {
        this.lastPlace = me.place;
        this.posNum.textContent = `${me.place} / ${race.racers.length}`;
        this.posNum.classList.toggle('first', me.place === 1);
      }
      if (me.color !== this.lastChip) {
        this.lastChip = me.color;
        this.posChip.style.background = css(me.color);
      }
      const leader = race.racers.find((racer) => racer.place === 1) ?? me;
      const gapM = Math.max(0, leader.progress - me.progress);
      const gapText = me.place === 1 ? '领先中' : `距第一 ${gapM < 10 ? gapM.toFixed(1) : Math.round(gapM)}m`;
      if (gapText !== this.lastGapText) {
        this.lastGapText = gapText;
        this.posGap.textContent = gapText;
      }
      this.finalLapEl.textContent = me.place === 1 ? '优秀资格' : '优秀资格丢失';
      this.finalLapEl.classList.toggle('qualified', me.place === 1);
      this.finalLapEl.classList.toggle('lost', me.place !== 1);
      if (me.wrongWay !== this.lastWrongWay) {
        this.lastWrongWay = me.wrongWay;
        this.wrongWayEl.classList.toggle('on', me.wrongWay);
      }
    }
    if (this.finalLapTimer > 0) this.finalLapTimer = Math.max(0, this.finalLapTimer - dt);

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
    const boostDisplay = st.boosting ? st.boostRemaining : st.boostCharge;
    const segs = Math.min(BOOST_SEGS, Math.ceil(boostDisplay * BOOST_SEGS - 1e-4));
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
    this.boostBar.classList.toggle('active', st.boosting);
    this.boostBar.classList.toggle('drifting', st.drifting);
    if (st.drifting !== this.lastDrifting) {
      this.lastDrifting = st.drifting;
      this.boostLabel.textContent = st.drifting ? 'DRIFT' : 'BOOST';
    }
    this.driftFx.classList.toggle('on', st.drifting && st.speed > 12);
    this.driftFx.classList.toggle('full', st.drifting && st.boostCharge >= 0.999);

    const driftTier = st.drifting ? Math.min(4, Math.floor(st.boostCharge * 4 + 1e-4)) : 0;
    this.lastDriftTier = driftTier;

    // A qualifying Shift release earns one non-stacking token. During flight,
    // the same five pips become a duration readout and count down to landing.
    const flightActive = st.flightPhase !== 'surface';
    const flightPips = flightActive
      ? Math.min(FLIGHT_PIPS, Math.max(0, Math.ceil(st.flightRemaining * FLIGHT_PIPS - 1e-4)))
      : st.flightReady ? FLIGHT_PIPS : 0;
    if (flightPips !== this.lastFlightPips) {
      this.lastFlightPips = flightPips;
      for (let i = 0; i < FLIGHT_PIPS; i++) this.flightPipEls[i].classList.toggle('on', i < flightPips);
    }
    if (st.flightReady !== this.lastFlightReady) {
      if (race.phase === 'racing' && st.flightReady) {
        this.flightPromptHitTimer = 1.2;
        this.flightPrompt.classList.remove('acquired');
        void this.flightPrompt.offsetWidth;
        this.flightPrompt.classList.add('acquired');
      }
      this.lastFlightReady = st.flightReady;
      this.flightToken.classList.toggle('ready', st.flightReady);
      this.flightPrompt.classList.toggle('on', st.flightReady);
    }
    if (this.flightPromptHitTimer > 0) {
      this.flightPromptHitTimer -= dt;
      if (this.flightPromptHitTimer <= 0) this.flightPrompt.classList.remove('acquired');
    }
    if (flightActive !== this.lastFlightActive) {
      this.lastFlightActive = flightActive;
      this.flightToken.classList.toggle('active', flightActive);
      this.powerPanel.classList.toggle('flying', flightActive);
    }
    if (race.phase === 'racing' && st.flightPhase !== this.lastFlightPhase && st.flightPhase === 'spool') {
      const flightNumber = Math.min(3, st.flightsCleared + 1);
      this.enqueueImpact({
        kind: 'flight-launch', kicker: `FLIGHT ${flightNumber} / 3`, title: `第 ${flightNumber} 飞`, detail: '',
        color: PALETTE.flight, duration: 0.38, priority: 75,
      });
    }
    this.lastFlightPhase = st.flightPhase;

    if (race.phase === 'racing' && st.flightGateProgress > this.lastFlightGateProgress) {
      const flightNumber = Math.max(1, st.flightsCleared);
      this.enqueueImpact({
        kind: 'gate', kicker: `FLIGHT ${flightNumber} / 3`, title: '通过', detail: '',
        color: PALETTE.flight, duration: 0.28, priority: 50,
      });
    }
    this.lastFlightGateProgress = st.flightGateProgress;
    if (race.phase === 'racing' && st.flightRouteState !== this.lastFlightRouteState) {
      if (st.flightRouteState === 'passed') {
        const flightNumber = st.flightsCleared;
        const title = flightNumber === 1 ? '第一飞，谁都会。'
          : flightNumber === 2 ? '两次不算。'
            : '三飞完成';
        this.enqueueImpact({
          kind: 'route-clear', kicker: `${flightNumber} / 3`, title, detail: flightNumber === 2 ? '最后一飞，别停在普通。' : '',
          color: PALETTE.flight, duration: 0.52, priority: 60,
        });
      }
    }
    this.lastFlightRouteState = st.flightRouteState;
    if (st.flightDenied || st.flightRouteMiss) this.flightAlertTimer = 0.32;
    if (this.flightAlertTimer > 0) {
      this.flightAlertTimer -= dt;
      this.powerPanel.classList.add('flight-alert');
    } else {
      this.powerPanel.classList.remove('flight-alert');
    }

    if (race.phase === 'racing' && this.course.flightTurnWarning(player.id)) this.turnWarningTimer = 1.45;
    else this.turnWarningTimer = Math.max(0, this.turnWarningTimer - dt);
    const turn = race.phase === 'racing' && this.turnWarningTimer > 0;
    this.turnWarning.classList.toggle('on', turn);
    this.turnWarning.classList.toggle('braking', turn && st.flightAirBrake > 0.35);
    this.battleEl.classList.toggle('safety-compact', turn);

    if (this.battleTimer > 0) {
      this.battleTimer -= dt;
      if (this.battleTimer <= 0) {
        this.battleEl.classList.remove('on');
      }
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

    this.updateImpact(dt, race.phase === 'racing');

    // ---- minimap ------------------------------------------------------------------------
    this.drawMinimap(player, all);
  }

  showBattle(event: RaceBattleEvent): void {
    const names = event.opponents.map((o) => o.name).join(' + ');
    const color = event.kind === 'overtake'
      ? event.opponents[0]?.color ?? PALETTE.uiAccent
      : PALETTE.uiWarn;
    if (event.kind === 'overtake') {
      const label = event.toPlace === 1 ? 'LEAD TAKEN' : 'OVERTAKE';
      const opponent = event.rankChanged ? `超越 ${names}` : `PASS ${names}`;
      this.activateBattle('overtake', label, ordinal(event.fromPlace), ordinal(event.toPlace), opponent,
        event.streak >= 2 ? `连超 x${event.streak}` : '', color);
      this.posNum.classList.remove('battle-hit');
      void this.posNum.offsetWidth;
      this.posNum.classList.add('battle-hit');
    } else {
      this.activateBattle('lost', 'POSITION LOST', ordinal(event.fromPlace), ordinal(event.toPlace), `被 ${names} 反超`, '', color);
      this.posNum.classList.remove('battle-lost');
      void this.posNum.offsetWidth;
      this.posNum.classList.add('battle-lost');
    }
  }

  showChallengeResult(race: RaceView): void {
    const result = race.challengeResult;
    if (!result) return;
    this.clearBattle();
    const defeated = result.outcome === 'defeated';
    const excellent = result.outcome === 'excellent';
    const ordinary = result.outcome === 'ordinary';
    this.resultsEl.dataset.outcome = result.outcome;
    this.resultsPanel.classList.toggle('defeated', defeated);
    this.resultsPanel.classList.toggle('excellent', excellent);
    this.resultsTitle.textContent = defeated ? '挑战败北' : excellent ? '优秀男人' : '普通男人';
    this.resultsPlace.textContent = defeated
      ? this.failureHeading(result)
      : `第 ${result.place} / ${result.totalRacers} 名`;
    this.resultsPlace.classList.toggle('win', excellent);
    this.resultsPlace.classList.toggle('lose', defeated || ordinary);
    this.resultsReason.textContent = defeated
      ? this.failureCopy(result)
      : excellent
        ? '三飞无误 · 第一名'
        : `三飞完成 · 慢第一 ${(result.leaderGapSeconds ?? 0).toFixed(2)} 秒`;
    this.resultsMedal.textContent = defeated
      ? '三次飞行缺一不可'
      : excellent
        ? `优秀完成 × ${result.excellentTotal}`
        : result.ordinaryNew ? '普通男人里程碑已解锁' : '第一才算优秀';
    this.resultsRows.textContent = '';
    this.resultStat('TIME', fmtTime(result.raceTime));
    this.resultStat('OVERTAKES', String(result.overtakes));
    this.resultStat('FLIGHTS', `${result.flightsCleared} / 3`);
    this.root.classList.add('results-on');
    this.resultsEl.classList.add('on');
    window.setTimeout(() => {
      if (this.resultsEl.classList.contains('on')) this.retryButton.focus({ preventScroll: true });
    }, 620);
  }

  hideResults(): void {
    this.root.classList.remove('results-on');
    this.resultsEl.classList.remove('on');
    this.resultsEl.removeAttribute('data-outcome');
    this.clearBattle();
    this.turnWarning.classList.remove('on', 'braking');
  }

  showRetryLesson(result: ChallengeResult, attempt: number, repeatCount: number, newBest = false): void {
    const failure = result.failure;
    const lesson = this.lessonFor(failure, repeatCount);
    this.hideResults();
    const flight = failure?.flightNumber ?? Math.min(3, result.flightsCleared + 1);
    this.lessonAttempt.textContent = `LOADING NEXT RUN // RUN ${String(attempt).padStart(2, '0')} · 第 ${flight} 飞${newBest ? ' · NEW BEST' : ''}`;
    this.lessonTitle.textContent = lesson.title;
    this.lessonCopy.textContent = lesson.copy;
    this.lessonMetric.textContent = lesson.metric;
    this.updateRetryLesson(0);
    this.root.classList.add('lesson-on');
    this.lessonEl.classList.add('on');
  }

  updateRetryLesson(progress: number): void {
    const filled = Math.min(this.lessonPips.length, Math.floor(Math.max(0, Math.min(1, progress)) * this.lessonPips.length + 1e-4));
    for (let i = 0; i < this.lessonPips.length; i++) this.lessonPips[i].classList.toggle('on', i < filled);
  }

  hideRetryLesson(): void {
    this.root.classList.remove('lesson-on');
    this.lessonEl.classList.remove('on');
    for (const pip of this.lessonPips) pip.classList.remove('on');
  }

  clearBattle(): void {
    this.battleTimer = 0;
    this.battleEl.classList.remove('on', 'safety-compact');
  }

  private activateBattle(
    kind: 'overtake' | 'lost',
    label: string,
    from: string,
    to: string,
    opponent: string,
    streak: string,
    color: number,
  ): void {
    this.battleTimer = kind === 'overtake' ? 1.0 : 0.65;
    this.battleEl.dataset.kind = kind;
    this.battleEl.style.setProperty('--battle', css(color));
    this.battleLabel.textContent = label;
    this.battleFrom.textContent = from;
    this.battleTo.textContent = to;
    this.battleOpponent.textContent = opponent;
    this.battleStreak.textContent = streak;
    this.battleEl.setAttribute('aria-label', `${label}，${opponent}，名次从 ${from} 到 ${to}${streak ? `，${streak}` : ''}`);
    this.battleEl.classList.remove('on');
    void this.battleEl.offsetWidth;
    this.battleEl.classList.add('on');
  }

  private resultStat(label: string, value: string): void {
    const item = h('div', 'hud-result-stat', this.resultsRows);
    h('span', 'hud-result-stat-label', item, label);
    h('span', 'hud-result-stat-value', item, value);
  }

  private failureHeading(result: ChallengeResult): string {
    const reason = result.failure?.reason ?? result.reason;
    const flight = result.failure?.flightNumber ?? Math.min(3, result.flightsCleared + 1);
    if (reason === 'no_launch') return `第 ${flight} 飞 · 未起飞`;
    if (reason === 'corridor') return `第 ${flight} 飞 · 偏离航线`;
    if (reason === 'landing') return `第 ${flight} 飞 · 提前落水`;
    if (reason === 'exit') return `第 ${flight} 飞 · 未完成`;
    if (reason === 'teleport') return `第 ${flight} 飞 · 路线重置`;
    return `第 ${flight} 飞 · 漏门`;
  }

  private failureCopy(result: ChallengeResult): string {
    const reason = result.failure?.reason ?? result.reason;
    const why: Record<FlightRouteFailReason, string> = {
      none: '挑战未完成',
      no_launch: '没有起飞，水面通过不计完成',
      corridor: '飞离了悬空青色能量航线',
      gate: '船体没有从两根发光杆之间穿过',
      gate_left: '从杆门左侧掠过',
      gate_right: '从杆门右侧掠过',
      late: '起飞太晚，穿杆时尚未达到认证高度',
      landing: '通过飞行门前已经落水',
      exit: '离开飞行区时仍未通过门',
      teleport: '航线状态已重置',
    };
    const f = result.failure;
    if ((reason === 'gate_left' || reason === 'gate_right') && f && f.lateralOffsetM !== null && f.lateralLimitM !== null) {
      const miss = Math.max(0, Math.abs(f.lateralOffsetM) - f.lateralLimitM);
      return `第 ${f.flightNumber} 飞 · ${why[reason]} ${miss.toFixed(1)}m`;
    }
    return why[reason];
  }

  private lessonFor(failure: FlightFailureSnapshot | null, repeatCount: number): { title: string; copy: string; metric: string } {
    if (!failure) return { title: '还差一飞', copy: '下一次：先漂移拿资格，再按 SPACE 起飞', metric: '' };
    switch (failure.reason) {
      case 'no_launch':
        return { title: '没有起飞', copy: '下一次：按住 SHIFT 漂移，松开后按 SPACE', metric: '' };
      case 'late': {
        const short = Math.max(0, 2.8 - failure.clearanceM);
        return { title: `高度差 ${short.toFixed(1)}m`, copy: '下一次：更早按 SPACE', metric: '' };
      }
      case 'gate_left':
      case 'gate_right': {
        const left = failure.reason === 'gate_left';
        const miss = failure.lateralOffsetM !== null && failure.lateralLimitM !== null
          ? Math.max(0, Math.abs(failure.lateralOffsetM) - failure.lateralLimitM) : 0;
        const correction = left ? '向右少推一点' : '向左少推一点';
        const advanced = '下一次：弯前按住 SHIFT 空刹，再轻推回正';
        return { title: `差 ${miss.toFixed(1)}m`, copy: repeatCount >= 2 ? advanced : `下一次：${correction}`, metric: '' };
      }
      case 'corridor':
        return {
          title: `偏离 ${failure.corridorDistanceM?.toFixed(1) ?? '?'}m`,
          copy: repeatCount >= 2 ? '下一次：弯前按住 SHIFT 空刹' : '下一次：盯住青色空中航线',
          metric: '',
        };
      case 'landing':
        return { title: '提前落水', copy: '下一次：靠近入口再按 SPACE', metric: '' };
      case 'exit':
        return { title: '飞行未完成', copy: '下一次：保持在青色航线内', metric: '' };
      case 'gate':
        return { title: '只差这一门', copy: '下一次：对准两根发光杆的中点', metric: '' };
      case 'teleport':
        return { title: '路线重置', copy: '下一次：从入口完整进入', metric: '' };
      default:
        return { title: '还差一飞', copy: '下一次：先漂移，再按 SPACE', metric: '' };
    }
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
    this.brandEl.classList.add('on');
  }

  private hideCountdown(): void {
    this.cdVisible = false;
    this.goTimer = 0;
    this.countdownEl.classList.remove('pop', 'go');
    this.brandEl.classList.remove('on');
  }

  private spawnToast(delta: number): void {
    const el = document.createElement('div');
    const ahead = delta < 0;
    el.className = ahead ? 'hud-toast hud-inked good' : 'hud-toast hud-inked bad';
    el.textContent = `${ahead ? '−' : '+'}${Math.abs(delta).toFixed(2)}`;
    this.toastBox.appendChild(el);
    this.toasts.push({ el, life: TOAST_LIFE });
  }

  private enqueueImpact(notice: ImpactNotice): void {
    if (this.impactTimer <= 0 || notice.priority >= this.impactPriority) {
      if (this.impactTimer > 0 && this.impactPriority >= 50 && this.activeImpact) {
        this.impactQueue.unshift({ ...this.activeImpact, duration: Math.min(this.impactTimer, 0.35) });
      }
      this.activateImpact(notice);
      return;
    }
    this.impactQueue.push(notice);
    this.impactQueue.sort((a, b) => b.priority - a.priority);
    if (this.impactQueue.length > 6) this.impactQueue.length = 6;
  }

  private activateImpact(notice: ImpactNotice): void {
    this.impactTimer = notice.duration;
    this.impactPriority = notice.priority;
    this.activeImpact = notice;
    this.impactEl.dataset.kind = notice.kind;
    this.impactEl.style.setProperty('--impact', css(notice.color));
    this.impactKicker.textContent = notice.kicker;
    this.impactTitle.textContent = notice.title;
    this.impactDetail.textContent = notice.detail;
    this.impactEl.classList.remove('on');
    void this.impactEl.offsetWidth;
    this.impactEl.classList.add('on');
  }

  private updateImpact(dt: number, racing: boolean): void {
    if (!racing) {
      this.impactQueue.length = 0;
      this.impactTimer = 0;
      this.impactPriority = -1;
      this.activeImpact = null;
      this.impactEl.classList.remove('on');
      return;
    }
    if (this.impactTimer <= 0) return;
    this.impactTimer -= dt;
    if (this.impactTimer > 0) return;
    this.impactEl.classList.remove('on');
    const next = this.impactQueue.shift();
    if (next) this.activateImpact(next);
    else {
      this.impactPriority = -1;
      this.activeImpact = null;
    }
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
    const az = a0 + (a1 - a0) * (CRUISE_SPEED / SPEED_MAX);
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

    // Three ink-separated high routes share canonical progress with the water
    // route, so every branch remains readable without becoming an extra lap.
    for (const route of course.flightRoutes) {
      for (let pass = 0; pass < 2; pass++) {
        b.strokeStyle = pass === 0 ? PALETTE.inkCss : css(PALETTE.flight);
        b.lineWidth = pass === 0 ? 6 : 2.5;
        b.beginPath();
        for (let i = 0; i <= 64; i++) {
          const u = route.entryU + (route.exitU - route.entryU) * (i / 64);
          course.routePointAt(route.id, u, v);
          const x = this.mapX(v.x);
          const y = this.mapY(v.z);
          if (i === 0) b.moveTo(x, y);
          else b.lineTo(x, y);
        }
        b.stroke();
      }
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
    if (player.state.flightReady) {
      const v = this.mapTemp;
      const route = this.course.flightRoutes[Math.min(
        this.course.flightRoutes.length - 1,
        player.state.flightsCleared,
      )];
      m.strokeStyle = this.hudTime % 0.5 < 0.25 ? PALETTE.uiTextCss : css(PALETTE.flight);
      m.lineWidth = 4;
      m.beginPath();
      for (let i = 0; i <= 32; i++) {
        const u = route.entryU + (route.exitU - route.entryU) * (i / 32);
        this.course.routePointAt(route.id, u, v);
        const x = this.mapX(v.x);
        const y = this.mapY(v.z);
        if (i === 0) m.moveTo(x, y);
        else m.lineTo(x, y);
      }
      m.stroke();
    }
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
        const isFlying = boat.state.flightPhase !== 'surface';
        m.fillStyle = isFlying ? css(PALETTE.flight) : css(RACER_COLORS[boat.id % RACER_COLORS.length]);
        m.fill();
        m.lineWidth = 2.5;
        m.strokeStyle = PALETTE.inkCss;
        m.stroke();
        if (isPlayer) {
          m.beginPath();
          m.arc(x, y, r + 3, 0, Math.PI * 2);
          m.lineWidth = 2;
          m.strokeStyle = isFlying ? css(PALETTE.flight) : PALETTE.uiTextCss;
          m.stroke();
        }
      }
    }
  }
}
