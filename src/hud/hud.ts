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
  CourseWarning,
  RouteTurnDirection,
} from '../contracts';
import { MAX_FLIGHT_CHARGES } from '../contracts';
import { PALETTE } from '../core/palette';
import { RACER_COLORS } from '../game/racers';
import machoMedalUrl from '../assets/achievements/macho-medal.webp';
import type { SinglePlayerMissileTelemetry } from '../game/singlePlayerMissiles';
import { MedalCeremonyCanvas } from './medalCeremony';
import { deriveAbilityHudState } from '../core/abilityTelemetry';
import type { CoachFocus, CoachInputDevice, CoachPresentation } from '../game/drivingCoach';
import type { CoachMastery } from '../game/drivingCoach';
import type { PcControlPrimerPresentation } from '../game/pcControlPrimer';
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
const GO_LINGER = 1.35;

interface ImpactNotice {
  kind: string;
  kicker: string;
  title: string;
  detail: string;
  color: number;
  duration: number;
  priority: number;
  lane?: 'left' | 'center' | 'right';
}

/** One independent impact card: its own DOM, its own timer and its own queue. */
interface ImpactSlot {
  el: HTMLDivElement;
  kicker: HTMLDivElement;
  title: HTMLDivElement;
  detail: HTMLDivElement;
  queue: ImpactNotice[];
  timer: number;
  priority: number;
  active: ImpactNotice | null;
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
  private readonly camera: THREE.PerspectiveCamera;

  setVisible(visible: boolean): void {
    this.root.classList.toggle('team-hidden', !visible);
  }

  setDuoSplit(visible: boolean): void {
    this.root.classList.toggle('duo-split', visible);
    this.duoSplit = visible;
    // The second near-boat instrument only exists for a split race; leaving it
    // in the DOM would park a dead widget over the solo frame.
    this.driverPower[1].hidden = !visible;
    if (!visible) {
      this.seatCameras[0] = null;
      this.seatCameras[1] = null;
    }
  }

  /**
   * Split play renders each seat through its own camera, so the near-boat
   * instrument has to project through the same view it is drawn on top of.
   */
  setDuoSeatCameras(left: THREE.Camera, right: THREE.Camera): void {
    this.seatCameras[0] = left;
    this.seatCameras[1] = right;
  }

  // speedometer
  private readonly speedNum: HTMLDivElement;
  private readonly gctx: CanvasRenderingContext2D;

  // lap / final lap / position
  private readonly lapVal: HTMLDivElement;
  private readonly finalLapEl: HTMLDivElement;
  private readonly posNum: HTMLDivElement;
  private readonly posChip: HTMLDivElement;
  private readonly posGap: HTMLDivElement;

  // boost / stored flight charges. Split play builds one instrument per seat:
  // the widget rides its own boat, so it needs its own camera and half-screen.
  private readonly powerPanel: HTMLDivElement;
  private readonly driverPower: HTMLDivElement[] = [];
  private readonly driverLeftRail: HTMLDivElement[] = [];
  private readonly driverRightRail: HTMLDivElement[] = [];
  private readonly driverLeftLabel: HTMLDivElement[] = [];
  private readonly driverRightLabel: HTMLDivElement[] = [];
  private readonly driverStocks: HTMLDivElement[] = [];
  private readonly driverAnchor = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly driverAnchorX = [0, 0];
  private readonly driverAnchorY = [0, 0];
  private readonly driverPowerSide: (-1 | 1)[] = [1, 1];
  private readonly seatCameras: (THREE.Camera | null)[] = [null, null];
  private readonly boostBar: HTMLDivElement;
  private readonly boostLabel: HTMLDivElement;
  private readonly boostSegEls: HTMLDivElement[] = [];
  private readonly flightTokens: HTMLDivElement[] = [];
  private readonly flightChargeCount: HTMLDivElement;
  private readonly flightPipEls: HTMLDivElement[] = [];
  private readonly flightPrompt: HTMLDivElement;
  private readonly flightPromptKey: HTMLDivElement;
  private readonly flightPromptEn: HTMLDivElement;
  private readonly flightPromptCn: HTMLDivElement;
  private readonly flightPromptRule: HTMLDivElement;
  private flightPromptMode: 'hidden' | 'launch' | 'extend' | 'spent' | 'no-charge' = 'hidden';
  private flightPromptDevice: 'keyboard' | 'gamepad' | 'mobile' = 'keyboard';
  private controlDevice: CoachInputDevice = 'keyboard';
  private controlLabels = { steer: 'A / D', drift: 'SHIFT', flight: 'SPACE' };
  private flightPromptHitTimer = 0;
  private flightPromptSpent = false;
  private readonly shownFlightPromptTokens = new Set<string>();
  private readonly pcPrimerEl: HTMLDivElement;
  private readonly pcPrimerStepItems: HTMLSpanElement[] = [];
  private readonly pcPrimerKey: HTMLDivElement;
  private readonly pcPrimerMeter: HTMLDivElement;
  private readonly pcPrimerKicker: HTMLDivElement;
  private readonly pcPrimerTitle: HTMLDivElement;
  private readonly pcPrimerDetail: HTMLDivElement;
  private readonly pcPrimerClose: HTMLButtonElement;
  private primerOwnsFlight = false;

  // full-screen, event-driven impact layer
  private readonly driftFx: HTMLDivElement;
  /**
   * Impact cards. Split play builds one slot per seat so a notice can never
   * preempt or evict the other seat's, and neither one lands on the seam
   * between the two views.
   */
  private readonly impactSlots: ImpactSlot[] = [];
  private duoSplit = false;

  // Overtakes are competition-critical and never share the generic queue.
  private readonly battleEl: HTMLDivElement;
  private readonly battleLabel: HTMLDivElement;
  private readonly battleFrom: HTMLSpanElement;
  private readonly battleTo: HTMLSpanElement;
  private readonly battleOpponent: HTMLDivElement;
  private readonly battleStreak: HTMLDivElement;
  private battleTimer = 0;
  private readonly turnWarning: HTMLDivElement;
  private readonly turnWarningMark: HTMLDivElement;
  private readonly turnWarningTitle: HTMLDivElement;
  private readonly turnWarningDetail: HTMLDivElement;
  private readonly turnWarningDriftKey: HTMLSpanElement;
  private readonly turnWarningSteerKey: HTMLSpanElement;
  private readonly turnWarningAction: HTMLSpanElement;
  private turnWarningTimer = 0;
  private readonly coachEl: HTMLDivElement;
  private readonly coachSpotlight: HTMLDivElement;
  private readonly coachConnector: HTMLDivElement;
  private readonly coachStage: HTMLDivElement;
  private readonly coachControl: HTMLDivElement;
  private readonly coachKicker: HTMLDivElement;
  private readonly coachTitle: HTMLDivElement;
  private readonly coachDetail: HTMLDivElement;
  private readonly coachClose: HTMLButtonElement;
  private activeCoach: CoachPresentation | null = null;

  // split toasts
  private readonly toastBox: HTMLDivElement;
  private readonly toasts: Array<{ el: HTMLDivElement; life: number }> = [];

  // wrong way / countdown
  private readonly wrongWayEl: HTMLDivElement;
  private readonly finalTargetEl: HTMLDivElement;
  private readonly finalTargetDistance: HTMLSpanElement;
  private readonly finalTargetWorld = new THREE.Vector3();
  private readonly finalTargetProjected = new THREE.Vector3();
  private readonly finalTargetCamera = new THREE.Vector3();
  private finalTargetText = '';
  private readonly countdownEl: HTMLDivElement;
  private readonly countdownLights: HTMLDivElement[] = [];
  private readonly countdownLabel: HTMLDivElement;
  private readonly brandEl: HTMLDivElement;
  private readonly readyEl: HTMLDivElement;
  private readonly readyTitle: HTMLDivElement;
  private readonly readyAction: HTMLDivElement;
  private readonly duoControlsEl: HTMLDivElement;
  private readonly duoControlsLeft: HTMLDivElement;
  private readonly duoControlsRight: HTMLDivElement;
  private readonly interruptionEl: HTMLDivElement;
  private readonly interruptionCopy: HTMLDivElement;
  private readonly interruptionButton: HTMLButtonElement;
  private readonly interruptionFoot: HTMLDivElement;

  // third-flight medal ceremony
  private readonly medalEl: HTMLDivElement;
  private readonly medalCanvas: MedalCeremonyCanvas;
  private readonly medalKicker: HTMLDivElement;
  private readonly medalTitle: HTMLDivElement;
  private readonly medalCount: HTMLDivElement;
  private readonly medalTier: HTMLDivElement;
  private readonly medalNext: HTMLDivElement;
  private readonly medalContinue: HTMLButtonElement;
  private readonly medalGallery: HTMLButtonElement;
  private currentMedalTier: 'ordinary' | 'excellent' = 'ordinary';

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
  private readonly resultsMachoMedal: HTMLImageElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly lessonEl: HTMLDivElement;
  private readonly lessonAttempt: HTMLDivElement;
  private readonly lessonEmotion: HTMLDivElement;
  private readonly lessonMedal: HTMLDivElement;
  private readonly lessonTitle: HTMLDivElement;
  private readonly lessonCopy: HTMLDivElement;
  private readonly lessonMetric: HTMLDivElement;
  private readonly lessonContinue: HTMLButtonElement;
  private readonly lessonDisable: HTMLButtonElement;
  private readonly lessonPips: HTMLDivElement[] = [];
  private bestFlights: number;

  // missile pip
  private readonly missilePipEl: HTMLDivElement;
  private readonly missilePipHeader: HTMLSpanElement;
  private readonly missilePipDist: HTMLSpanElement;
  private readonly missilePipSlot: HTMLDivElement;
  private readonly missilePipCue: HTMLDivElement;

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
  private lastFlightCharges = 0;
  private lastFlightActive = false;
  // Split play runs every flight edge once per seat: the right half must not
  // borrow the left half's spool, gate, and route news.
  private readonly seatFlightPhase: string[] = ['surface', 'surface'];
  private readonly seatFlightRouteState: string[] = ['idle', 'idle'];
  private readonly seatFlightGateProgress: number[] = [0, 0];
  private lastDriftTier = 0;
  private hudTime = 0;
  private flightAlertTimer = 0;
  private lastCourseWarning: CourseWarning = 'none';
  private lastCourseWarningText = '';
  private corridorStage = 0;
  private lastCountdown = -1;
  private cdVisible = false;
  private goTimer = 0;
  private finalLapTimer = 0;
  private readonly lastSplits: number[] = [];

  constructor(
    container: HTMLElement,
    course: ICourse,
    onRetry: () => void,
    bestFlights = 0,
    onResume: () => void = () => {},
    camera?: THREE.PerspectiveCamera,
    onMedalGallery: () => void = () => {},
    onCoachDisable: () => void = () => {},
    onPcPrimerDismiss: () => void = () => {},
    // Veterans stay silent: once a skill is mastered its prompt never returns.
    private readonly shouldShowFlightPrompt: (mode: 'launch' | 'extend') => boolean = () => true,
  ) {
    this.course = course;
    this.camera = camera ?? new THREE.PerspectiveCamera();
    this.bestFlights = bestFlights;
    this.root = h('div', 'hud', container);
    const compactViewport = innerWidth <= 900 || innerHeight <= 520;
    const halfViewport = Math.round(innerWidth / 2);
    this.driverAnchorX[0] = compactViewport ? innerWidth - 205 : innerWidth * 0.62;
    this.driverAnchorX[1] = compactViewport ? innerWidth - 205 : halfViewport + innerWidth * 0.31;
    this.driverAnchorY[0] = compactViewport ? 130 : innerHeight * 0.56;
    this.driverAnchorY[1] = compactViewport ? 130 : innerHeight * 0.56;
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
    rs.setProperty('--sun', css(PALETTE.sunFlare));

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

    // ---- single power unit: stored launch cells above the original boost bar ----
    this.powerPanel = h('div', 'hud-panel hud-power', this.root);
    const flightRow = h('div', 'hud-flight', this.powerPanel);
    h('div', 'hud-flight-label', flightRow, 'FLIGHT');
    const flightRack = h('div', 'hud-flight-rack', flightRow);
    for (let i = 0; i < MAX_FLIGHT_CHARGES; i++) this.flightTokens.push(h('div', 'hud-flight-token', flightRack));
    this.flightChargeCount = h('div', 'hud-flight-count', flightRow, 'x0');
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

    // Near-boat driver instrument. It is deliberately transparent and compact:
    // the track remains the primary visual, while the two rails carry timing.
    // Both seats get one; solo play only ever reveals the first.
    for (let seat = 0; seat < 2; seat++) {
      const root = h('div', 'hud-driver-power', this.root);
      root.dataset.seat = String(seat);
      root.setAttribute('aria-hidden', 'true');
      this.driverPower.push(root);
      this.driverLeftRail.push(h('div', 'hud-driver-rail hud-driver-rail-left', root));
      this.driverRightRail.push(h('div', 'hud-driver-rail hud-driver-rail-right', root));
      this.driverLeftLabel.push(h('div', 'hud-driver-label hud-driver-label-left', root, ''));
      this.driverRightLabel.push(h('div', 'hud-driver-label hud-driver-label-right', root, ''));
      const stocks = h('div', 'hud-driver-stocks', root);
      for (let i = 0; i < MAX_FLIGHT_CHARGES; i++) h('i', 'hud-driver-stock', stocks);
      this.driverStocks.push(stocks);
    }

    // ---- toasts / wrong way / countdown ----------------------------------------------
    this.toastBox = h('div', 'hud-toasts', this.root);
    this.driftFx = h('div', 'hud-drift-fx', this.root);
    for (const slot of ['a', 'b'] as const) {
      const el = h('div', 'hud-impact', this.root);
      el.dataset.slot = slot;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      h('div', 'hud-impact-flash', el);
      h('div', 'hud-impact-lines left', el);
      h('div', 'hud-impact-lines right', el);
      const impactCopy = h('div', 'hud-impact-copy', el);
      this.impactSlots.push({
        el,
        kicker: h('div', 'hud-impact-kicker', impactCopy),
        title: h('div', 'hud-impact-title', impactCopy),
        detail: h('div', 'hud-impact-detail', impactCopy),
        queue: [],
        timer: 0,
        priority: -1,
        active: null,
      });
    }

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
    this.flightPromptKey = h('div', 'hud-keycap', this.flightPrompt, 'SPACE');
    const promptCopy = h('div', 'hud-flight-prompt-copy', this.flightPrompt);
    this.flightPromptEn = h('div', 'hud-flight-prompt-en', promptCopy, 'FLIGHT READY');
    this.flightPromptCn = h('div', 'hud-flight-prompt-cn', promptCopy, '按 SPACE 起飞');
    this.flightPromptRule = h('div', 'hud-flight-prompt-rule', promptCopy, '下一飞已就绪');
    this.pcPrimerEl = h('div', 'hud-pc-primer', this.root);
    this.pcPrimerEl.setAttribute('role', 'note');
    const primerSteps = h('div', 'hud-pc-primer-steps', this.pcPrimerEl);
    const s1 = h('span', 'hud-pc-step-item s1', primerSteps, '01 漂移蓄电');
    h('i', 'hud-pc-step-arrow', primerSteps, '➔');
    const s2 = h('span', 'hud-pc-step-item s2', primerSteps, '02 空格起飞');
    h('i', 'hud-pc-step-arrow', primerSteps, '➔');
    const s3 = h('span', 'hud-pc-step-item s3', primerSteps, '03 顺势降落');
    this.pcPrimerStepItems.push(s1, s2, s3);
    const primerMain = h('div', 'hud-pc-primer-main', this.pcPrimerEl);
    const primerControl = h('div', 'hud-pc-primer-control', primerMain);
    this.pcPrimerKey = h('div', 'hud-pc-primer-key', primerControl, 'SHIFT');
    this.pcPrimerKey.setAttribute('aria-hidden', 'true');
    this.pcPrimerMeter = h('div', 'hud-pc-primer-meter', primerControl);
    h('i', '', this.pcPrimerMeter);
    h('b', '', this.pcPrimerMeter);
    const primerCopy = h('div', 'hud-pc-primer-copy', primerMain);
    this.pcPrimerKicker = h('div', 'hud-pc-primer-kicker', primerCopy, 'PC 漂移');
    this.pcPrimerTitle = h('div', 'hud-pc-primer-title', primerCopy, '按住 SHIFT 漂移');
    this.pcPrimerDetail = h('div', 'hud-pc-primer-detail', primerCopy, '漂过黄线再松开 · 存入飞行库存 ◇');
    this.pcPrimerClose = document.createElement('button');
    this.pcPrimerClose.className = 'hud-pc-primer-close';
    this.pcPrimerClose.type = 'button';
    this.pcPrimerClose.textContent = '×';
    this.pcPrimerClose.title = '跳过操作提示';
    this.pcPrimerClose.setAttribute('aria-label', '跳过操作提示');
    this.pcPrimerClose.addEventListener('click', onPcPrimerDismiss);
    this.pcPrimerEl.appendChild(this.pcPrimerClose);
    this.turnWarning = h('div', 'hud-turn-warning', this.root);
    this.turnWarningMark = h('div', 'hud-turn-warning-mark hud-inked', this.turnWarning, '!');
    const turnCopy = h('div', 'hud-turn-warning-copy', this.turnWarning);
    this.turnWarningTitle = h('div', 'hud-turn-warning-title hud-inked', turnCopy, '急弯逼近');
    this.turnWarningDetail = h('div', 'hud-turn-warning-detail', turnCopy);
    this.turnWarningDriftKey = h('span', 'hud-turn-key', this.turnWarningDetail, 'SHIFT') as unknown as HTMLSpanElement;
    h('span', 'hud-turn-plus', this.turnWarningDetail, '+');
    this.turnWarningSteerKey = h('span', 'hud-turn-key', this.turnWarningDetail, 'A / D') as unknown as HTMLSpanElement;
    this.turnWarningAction = h('span', 'hud-turn-action', this.turnWarningDetail, '空刹转向') as unknown as HTMLSpanElement;
    this.wrongWayEl = h('div', 'hud-wrongway', this.root, '方向反了 · 掉头');
    this.finalTargetEl = h('div', 'hud-final-target', this.root);
    this.finalTargetEl.setAttribute('aria-hidden', 'true');
    h('i', 'hud-final-target-arrow', this.finalTargetEl);
    const finalTargetCopy = h('span', 'hud-final-target-copy', this.finalTargetEl);
    h('strong', '', finalTargetCopy, 'FINAL');
    this.finalTargetDistance = h('span', '', finalTargetCopy) as unknown as HTMLSpanElement;
    this.brandEl = h('div', 'hud-brand', this.root);
    h('div', 'hud-brand-lead hud-inked', this.brandEl, '是男人就飞三次');
    const brandAction = h('div', 'hud-brand-action hud-inked', this.brandEl);
    h('span', 'hud-brand-drift', brandAction, '三飞全过');
    h('span', 'hud-brand-flight', brandAction, '第一才算优秀');
    this.countdownEl = h('div', 'hud-countdown', this.root);
    const countdownRail = h('div', 'hud-countdown-rail', this.countdownEl);
    for (let i = 0; i < 3; i++) this.countdownLights.push(h('i', 'hud-countdown-light', countdownRail));
    this.countdownLabel = h('div', 'hud-countdown-label hud-inked', this.countdownEl, '3');

    // ---- explicit READY gate ----------------------------------------------------------
    this.readyEl = h('div', 'hud-ready', this.root);
    h('div', 'hud-ready-kicker', this.readyEl, 'THREE FLIGHTS · ONE STANDARD');
    this.readyTitle = h('div', 'hud-ready-title hud-inked', this.readyEl, '是男人就飞三次');
    this.readyAction = h('div', 'hud-ready-action', this.readyEl, 'ENTER 开始');

    // Dual races share one camera, so both owners need a stable, low-noise
    // legend that remains visible without competing with the route callouts.
    this.duoControlsEl = h('div', 'hud-duo-controls', this.root);
    this.duoControlsEl.setAttribute('aria-label', '双打操作提示');
    this.duoControlsLeft = h('div', 'hud-duo-seat hud-duo-seat-left', this.duoControlsEl);
    this.duoControlsRight = h('div', 'hud-duo-seat hud-duo-seat-right', this.duoControlsEl);
    this.setDuoControls(false);

    // ---- app-switch interruption gate ------------------------------------------------
    this.interruptionEl = h('div', 'hud-interruption', this.root);
    this.interruptionEl.setAttribute('role', 'dialog');
    this.interruptionEl.setAttribute('aria-modal', 'true');
    h('div', 'hud-interruption-kicker', this.interruptionEl, 'RUN FROZEN · AUDIO SILENT');
    h('div', 'hud-interruption-title hud-inked', this.interruptionEl, '游戏已暂停');
    this.interruptionCopy = h('div', 'hud-interruption-copy', this.interruptionEl, '比赛与声音已冻结');
    this.interruptionButton = document.createElement('button');
    this.interruptionButton.className = 'hud-interruption-go';
    this.interruptionButton.type = 'button';
    this.interruptionButton.textContent = 'GO · 继续比赛';
    this.interruptionButton.addEventListener('click', onResume);
    this.interruptionEl.appendChild(this.interruptionButton);
    this.interruptionFoot = h('div', 'hud-interruption-foot', this.interruptionEl);

    // ---- medal ceremony ---------------------------------------------------------------
    this.medalEl = h('div', 'hud-medal-ceremony', this.root);
    this.medalEl.setAttribute('role', 'dialog');
    this.medalEl.setAttribute('aria-modal', 'true');
    this.medalCanvas = new MedalCeremonyCanvas(this.medalEl, true);
    const medalCopy = h('div', 'hud-medal-copy', this.medalEl);
    this.medalKicker = h('div', 'hud-medal-kicker', medalCopy, '三飞达成 · 实力兑现');
    this.medalTitle = h('div', 'hud-medal-title', medalCopy, '猛男');
    this.medalCount = h('div', 'hud-medal-count', medalCopy);
    this.medalTier = h('div', 'hud-medal-tier', medalCopy);
    this.medalNext = h('div', 'hud-medal-next', medalCopy);
    const medalButtons = h('div', 'hud-medal-buttons', medalCopy);
    this.medalContinue = document.createElement('button');
    this.medalContinue.className = 'hud-medal-continue';
    this.medalContinue.type = 'button';
    this.medalContinue.textContent = '继续游戏';
    this.medalContinue.hidden = true;
    this.medalContinue.addEventListener('click', onRetry);
    medalButtons.appendChild(this.medalContinue);
    this.medalGallery = document.createElement('button');
    this.medalGallery.className = 'hud-medal-continue hud-medal-gallery';
    this.medalGallery.type = 'button';
    this.medalGallery.textContent = '神秘资料片';
    this.medalGallery.hidden = true;
    this.medalGallery.addEventListener('click', onMedalGallery);
    medalButtons.appendChild(this.medalGallery);
    h('div', 'hud-medal-foot', medalCopy, '继续后 3 · 2 · 1 · GO');

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
    this.resultsMachoMedal = h('img', 'hud-results-macho-medal', this.resultsPanel) as HTMLImageElement;
    this.resultsMachoMedal.src = machoMedalUrl;
    this.resultsMachoMedal.alt = '猛男勋章';
    this.resultsMachoMedal.style.display = 'none';
    this.retryButton = document.createElement('button');
    this.retryButton.className = 'hud-retry';
    this.retryButton.type = 'button';
    this.retryButton.innerHTML = '<span class="hud-retry-key">↻</span><span>再飞一次</span>';
    this.retryButton.addEventListener('click', onRetry);
    this.resultsPanel.appendChild(this.retryButton);
    h('div', 'hud-results-again', this.resultsPanel, 'ENTER / R  ·  立即重试');

    // ---- focused failure review -------------------------------------------------------
    this.lessonEl = h('div', 'hud-retry-lesson', this.root);
    h('div', 'hud-lesson-grid', this.lessonEl);
    const lessonInner = h('div', 'hud-lesson-inner', this.lessonEl);
    this.lessonAttempt = h('div', 'hud-lesson-attempt', lessonInner, 'LOADING NEXT RUN');
    this.lessonEmotion = h('div', 'hud-lesson-emotion hud-inked', lessonInner);
    this.lessonMedal = h('div', 'hud-lesson-medal hud-inked', lessonInner);
    this.lessonTitle = h('div', 'hud-lesson-title hud-inked', lessonInner);
    this.lessonCopy = h('div', 'hud-lesson-copy', lessonInner);
    this.lessonMetric = h('div', 'hud-lesson-metric', lessonInner);
    const lessonProgress = h('div', 'hud-lesson-progress', lessonInner);
    for (let i = 0; i < 6; i++) this.lessonPips.push(h('i', 'hud-lesson-pip', lessonProgress));
    this.lessonContinue = document.createElement('button');
    this.lessonContinue.className = 'hud-lesson-continue';
    this.lessonContinue.type = 'button';
    this.lessonContinue.textContent = '再冲一次';
    this.lessonContinue.addEventListener('click', onRetry);
    lessonInner.appendChild(this.lessonContinue);
    this.lessonDisable = document.createElement('button');
    this.lessonDisable.className = 'hud-lesson-disable';
    this.lessonDisable.type = 'button';
    this.lessonDisable.textContent = '不用引导';
    this.lessonDisable.addEventListener('click', onCoachDisable);
    lessonInner.appendChild(this.lessonDisable);

    // ---- progressive spotlight driving guide -----------------------------------------
    this.coachSpotlight = h('div', 'hud-coach-spotlight', this.root);
    this.coachConnector = h('div', 'hud-coach-connector', this.root);
    this.coachEl = h('div', 'hud-coach', this.root);
    this.coachEl.setAttribute('role', 'complementary');
    this.coachEl.setAttribute('aria-label', '驾驶标注');
    this.coachEl.setAttribute('aria-live', 'polite');
    const coachHead = h('div', 'hud-coach-head', this.coachEl);
    this.coachStage = h('div', 'hud-coach-stage', coachHead);
    this.coachControl = h('div', 'hud-coach-control', coachHead);
    const coachCopy = h('div', 'hud-coach-copy', this.coachEl);
    this.coachKicker = h('div', 'hud-coach-kicker', coachCopy);
    this.coachTitle = h('div', 'hud-coach-title', coachCopy);
    this.coachDetail = h('div', 'hud-coach-detail', coachCopy);
    this.coachClose = document.createElement('button');
    this.coachClose.className = 'hud-coach-close';
    this.coachClose.type = 'button';
    this.coachClose.textContent = '跳过引导';
    this.coachClose.title = '跳过全部驾驶引导';
    this.coachClose.setAttribute('aria-label', '跳过全部驾驶引导');
    this.coachClose.addEventListener('click', onCoachDisable);
    this.coachEl.appendChild(this.coachClose);

    // ---- missile pip tactical rear-view ----------------------------------------------
    this.missilePipEl = h('div', 'hud-missile-pip', this.root);
    const pipHeaderRow = h('div', 'hud-missile-pip-header', this.missilePipEl);
    this.missilePipHeader = h('span', 'hud-missile-pip-tag', pipHeaderRow, '【战术后视】锁定飞弹追踪中');
    this.missilePipDist = h('span', 'hud-missile-pip-dist', pipHeaderRow, '距离: --');
    this.missilePipSlot = h('div', 'hud-missile-pip-slot', this.missilePipEl);
    h('div', 'hud-missile-pip-corner-tl', this.missilePipSlot);
    h('div', 'hud-missile-pip-corner-tr', this.missilePipSlot);
    h('div', 'hud-missile-pip-corner-bl', this.missilePipSlot);
    h('div', 'hud-missile-pip-corner-br', this.missilePipSlot);
    this.missilePipCue = h('div', 'hud-missile-pip-cue', this.missilePipEl, '⚡ 立即入弯漂移 · 浪花诱爆！');
  }

  getMissilePipSlotRect(): DOMRect | null {
    if (!this.missilePipEl.classList.contains('on')) return null;
    return this.missilePipSlot.getBoundingClientRect();
  }

  updateMissilePip(telemetry: SinglePlayerMissileTelemetry): void {
    if (!telemetry.active || !telemetry.targetedPlayer || telemetry.state === 'idle') {
      this.missilePipEl.classList.remove('on', 'evade-alert', 'deflected', 'hit');
      return;
    }
    this.missilePipEl.classList.add('on');
    this.missilePipDist.textContent = `距离: ${telemetry.distance.toFixed(1)}米`;

    if (telemetry.state === 'deflected') {
      this.missilePipEl.classList.remove('evade-alert', 'hit');
      this.missilePipEl.classList.add('deflected');
      this.missilePipCue.textContent = '👑 成功闪避诱爆 · 技术超群！';
    } else if (telemetry.state === 'hit') {
      this.missilePipEl.classList.remove('evade-alert', 'deflected');
      this.missilePipEl.classList.add('hit');
      this.missilePipCue.textContent = '⚠️ 受到水浪冲击 · 保持操舵！';
    } else if (telemetry.isEvadeWindow) {
      this.missilePipEl.classList.add('evade-alert');
      this.missilePipEl.classList.remove('deflected', 'hit');
      this.missilePipCue.textContent = '⚡ 立即入弯漂移 · 浪花诱爆！';
    } else {
      this.missilePipEl.classList.remove('evade-alert', 'deflected', 'hit');
      this.missilePipCue.textContent = '🎯 飞弹逼近中 · 准备进弯漂移';
    }
  }

  /** Spool, extension, gate, and route-clear edges for one seat's own card slot. */
  private updateSeatFlightNotices(
    race: RaceView,
    boat: IBoat | undefined,
    lane: ImpactNotice['lane'],
    seat: number,
  ): void {
    if (!boat) return;
    const st = boat.state;
    if (race.phase === 'racing' && st.flightPhase !== this.seatFlightPhase[seat] && st.flightPhase === 'spool') {
      const flightNumber = st.flightsCleared + 1;
      const kicker = flightNumber <= 3
        ? `起飞点 · ${flightNumber}/3 飞`
        : `天轨起飞 · 第 ${flightNumber} 飞`;
      const title = flightNumber === 1
        ? '⚡ 首飞破空 · 极限冲刺'
        : flightNumber === 2
          ? '⚡ 二飞腾空 · 弯道侧切'
          : flightNumber === 3
            ? '⚡ 定级之飞 · 冲刺猛男'
            : '⚡ 拔起腾空 · 极限冲刺';
      this.enqueueImpact({
        kind: 'flight-launch',
        kicker,
        title,
        detail: '对准飞行走廊 · 稳住操舵',
        color: PALETTE.flight,
        duration: 0.7,
        priority: 75,
        lane,
      });
    }
    if (race.phase === 'racing' && st.flightExtended) {
      this.enqueueImpact({
        kind: 'flight-extend',
        kicker: '空中充能',
        title: '续航 +2.4 秒',
        detail: '稳住空刹 · 完美对准出弯',
        color: PALETTE.flight,
        duration: 0.72,
        priority: 78,
        lane,
      });
    }
    this.seatFlightPhase[seat] = st.flightPhase;

    if (race.phase === 'racing' && st.flightGateProgress > this.seatFlightGateProgress[seat] &&
        st.flightRouteState !== 'passed') {
      const flightNumber = Math.max(1, st.flightsCleared + (st.flightRouteIndex >= 0 ? 1 : 0));
      const kicker = flightNumber <= 3 ? `门标判定 · ${flightNumber}/3 飞` : `门标判定 · 第 ${flightNumber} 飞`;
      const title = flightNumber === 1
        ? '🎯 首门精准穿过'
        : flightNumber === 2
          ? '🎯 二门精准穿过'
          : flightNumber === 3
            ? '🎯 三门定级过关！'
            : flightNumber === 4
              ? '🎯 进阶四门通过'
              : flightNumber === 5
                ? '🎯 最难发卡回旋已过！'
                : flightNumber === 6
                  ? '🎯 险峻六门通过'
                  : '🎯 终极天门通过！';
      this.enqueueImpact({
        kind: 'gate',
        kicker,
        title,
        detail: flightNumber === 5 ? '大弧度天轨回旋 · 完美入弯！' : '航线保持良好',
        color: PALETTE.flight,
        duration: flightNumber === 5 ? 1.8 : 0.7,
        priority: flightNumber === 5 ? 75 : 50,
        lane,
      });
    }
    this.seatFlightGateProgress[seat] = st.flightGateProgress;
    if (race.phase === 'racing' && st.flightRouteState !== this.seatFlightRouteState[seat]) {
      if (st.flightRouteState === 'passed') {
        const flightNumber = st.flightsCleared;
        if (flightNumber === 1) {
          this.enqueueImpact({
            kind: 'route-clear',
            kicker: '阶段通关 · 1/3 飞',
            title: '✨ 首飞顺利达成',
            detail: '稳住重心准备下一门',
            color: PALETTE.flight,
            duration: 1.1,
            priority: 60,
            lane,
          });
        } else if (flightNumber === 2) {
          this.enqueueImpact({
            kind: 'route-clear',
            kicker: '阶段通关 · 2/3 飞',
            title: '✨ 连破双关 · 状态拉满',
            detail: '准备迎接第 3 飞定级大关',
            color: PALETTE.flight,
            duration: 1.1,
            priority: 60,
            lane,
          });
        } else if (flightNumber === 3) {
          this.enqueueImpact({
            kind: 'route-clear',
            kicker: '三飞达成 · 猛男合格',
            title: '🏆 男人勋章已入账！',
            detail: '无限挑战开启 · 冲刺进阶航线',
            color: PALETTE.sunFlare,
            duration: 1.4,
            priority: 70,
            lane,
          });
        } else if (flightNumber === 4) {
          this.enqueueImpact({
            kind: 'route-clear',
            kicker: '进阶航段 · 4 飞达成',
            title: '🌊 右切大弯心 ➔ 迎战第 5 飞',
            detail: '水面高速切弯 · 对准前天天轨',
            color: PALETTE.flight,
            duration: 1.5,
            priority: 65,
            lane,
          });
        } else if (flightNumber === 5) {
          this.enqueueImpact({
            kind: 'route-clear',
            kicker: '极限航段 · 5 飞达成',
            title: '🔥 大回旋发卡弯完美征服！',
            detail: '天轨回旋绝技 · 保持节奏迎战第 6 飞',
            color: PALETTE.flight,
            duration: 2.0,
            priority: 75,
            lane,
          });
        } else if (flightNumber === 6) {
          this.enqueueImpact({
            kind: 'route-clear',
            kicker: '远海巅峰 · 6 飞达成',
            title: '⚡ 决胜前夕 ➔ 迎战终点天门',
            detail: '全速冲刺 · 最后一飞冲向终点站',
            color: PALETTE.flight,
            duration: 1.6,
            priority: 70,
            lane,
          });
        } else if (flightNumber >= 7) {
          this.enqueueImpact({
            kind: 'route-clear',
            kicker: '七飞登顶 · 猛男至尊',
            title: '👑 七飞全满贯达成！',
            detail: '回港冲线 · 迎接终点站加冕',
            color: PALETTE.sunFlare,
            duration: 2.2,
            priority: 85,
            lane,
          });
        }
      }
    }
    this.seatFlightRouteState[seat] = st.flightRouteState;
  }

  /**
   * Flight-corridor storm warning. Shares the wrong-way banner element; the
   * surface warnings it normally carries are forced to 'none' while airborne,
   * so the two never compete for the slot.
   */
  setCorridorDanger(level: number): void {
    const stage = level >= 0.45 ? 2 : level > 0.01 ? 1 : 0;
    if (stage === this.corridorStage) return;
    this.corridorStage = stage;
    this.root.classList.toggle('corridor-critical', stage === 2);
    if (stage === 0) {
      if (this.lastCourseWarning === 'none') {
        this.wrongWayEl.classList.remove('on');
      } else {
        if (this.lastCourseWarningText) this.wrongWayEl.textContent = this.lastCourseWarningText;
        this.wrongWayEl.classList.add('on');
      }
      return;
    }
    this.wrongWayEl.textContent = stage === 1
      ? '航道边缘 · 回到白雾内'
      : '失控下坠 · 立刻回正！';
    this.wrongWayEl.classList.add('on');
  }

  update(dt: number, race: RaceView, player: IBoat, _all: IBoat[]): void {
    const st = player.state;
    this.hudTime += dt;
    this.updateDriverPower(dt, race, player, _all);
    this.updateFinalTarget(race.phase === 'racing');
    if (this.activeCoach) this.positionCoach(this.activeCoach.focus);

    // The caller supplies the camera/controls focus. In a dual race this can
    // change when the first seat is eliminated; selecting the first `isPlayer`
    // would leave the surviving driver's place, color, and warning stale.
    const me = race.racers.find((racer) => racer.isPlayer && racer.id === player.id) ??
      race.racers.find((racer) => racer.isPlayer && !racer.eliminated) ??
      race.racers.find((racer) => racer.isPlayer);

    // ---- speed number + gauge -------------------------------------------------
    const kmh = Math.max(0, Math.round(st.speed * 3.6));
    if (kmh !== this.lastSpeed) {
      this.lastSpeed = kmh;
      this.speedNum.textContent = String(kmh);
    }
    // ---- lap / final lap / position / wrong way ---------------------------------
    if (me) {
      if (st.flightsCleared !== this.lastLap) {
        this.lastLap = st.flightsCleared;
        this.lapVal.textContent = st.flightsCleared < 3
          ? `FLIGHTS ${st.flightsCleared} / 3`
          : `本局 ${st.flightsCleared} 飞 · BEST ${this.bestFlights}`;
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
      const excellent = race.challengeTier === 'excellent';
      this.finalLapEl.textContent = excellent
        ? '优秀已锁定'
        : race.challengeTier === 'ordinary'
          ? (me.place === 1 ? '优秀资格夺回' : '夺回第一升优秀')
          : (me.place === 1 ? '优秀资格' : '优秀资格丢失');
      this.finalLapEl.classList.toggle('qualified', excellent || me.place === 1);
      this.finalLapEl.classList.toggle('lost', !excellent && me.place !== 1);
      if (this.corridorStage === 0) {
        let warningText = '';
        if (me.courseWarning === 'wrong_way') {
          const remainingS = (race as any).getWrongWayRemaining?.(me.id) ?? (race as any).getCourseWarningRemaining?.(me.id) ?? 15;
          const sec = Math.max(1, Math.ceil(remainingS));
          warningText = `⚠️ 逆向行驶 · 请掉头 (${sec}s)`;
        } else if (me.courseWarning === 'off_course') {
          const remainingS = (race as any).getOffCourseRemaining?.(me.id) ?? (race as any).getCourseWarningRemaining?.(me.id) ?? 15;
          const sec = Math.max(1, Math.ceil(remainingS));
          warningText = `⚠️ 偏离航线 · 回到绿色引导 (${sec}s)`;
        }
        if (me.courseWarning !== this.lastCourseWarning || warningText !== this.lastCourseWarningText) {
          this.lastCourseWarning = me.courseWarning;
          this.lastCourseWarningText = warningText;
          if (warningText) this.wrongWayEl.textContent = warningText;
          this.wrongWayEl.classList.toggle('on', me.courseWarning !== 'none');
        }
      }
    }
    if (this.finalLapTimer > 0) this.finalLapTimer = Math.max(0, this.finalLapTimer - dt);

    // ---- split toasts: track every racer, toast only the player ---------------
    for (let i = 0; i < race.racers.length; i++) {
      const r = race.racers[i];
      const prev = this.lastSplits[r.id] ?? 0;
      if (r.splitDelta !== prev) {
        this.lastSplits[r.id] = r.splitDelta;
        if (r.isPlayer && r.id === me?.id && r.splitDelta !== 0) this.spawnToast(r.splitDelta);
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
    this.boostBar.classList.toggle('release-ready', st.driftReleaseReady);
    if (st.drifting !== this.lastDrifting) {
      this.lastDrifting = st.drifting;
    }
    this.boostLabel.textContent = st.driftReleaseReady
      ? 'RELEASE'
      : st.drifting ? 'DRIFT' : st.boosting ? 'BOOST' : 'BANK';
    this.driftFx.classList.toggle('on', st.drifting && st.speed > 12);
    this.driftFx.classList.toggle('ready', st.driftReleaseReady);
    this.driftFx.classList.toggle('full', st.drifting && st.boostCharge >= 0.999);

    const driftTier = st.drifting ? Math.min(4, Math.floor(st.boostCharge * 4 + 1e-4)) : 0;
    this.lastDriftTier = driftTier;

    // Stored launch charges and the active flight envelope are separate reads.
    const flightActive = st.flightPhase !== 'surface';
    const flightPips = flightActive
      ? Math.min(FLIGHT_PIPS, Math.max(0, Math.ceil(st.flightRemaining * FLIGHT_PIPS - 1e-4)))
      : 0;
    if (flightPips !== this.lastFlightPips) {
      this.lastFlightPips = flightPips;
      for (let i = 0; i < FLIGHT_PIPS; i++) this.flightPipEls[i].classList.toggle('on', i < flightPips);
    }
    const routeGuidance = this.course.guidanceStatus();
    if (st.flightCharges !== this.lastFlightCharges) {
      this.lastFlightCharges = st.flightCharges;
      this.flightChargeCount.textContent = `x${st.flightCharges}`;
      for (let i = 0; i < this.flightTokens.length; i++) {
        this.flightTokens[i].classList.toggle('ready', i < st.flightCharges);
        this.flightTokens[i].classList.toggle('active', flightActive && i < st.flightCharges);
      }
    }
    const launchPromptUseful = this.shouldShowFlightPrompt('launch');
    const extendPromptUseful = this.shouldShowFlightPrompt('extend');
    const inLaunchZone = launchPromptUseful && routeGuidance.actionCue === 'launch' && !flightActive && race.phase === 'racing';
    const noChargeLaunch = inLaunchZone && st.flightCharges <= 0;
    const armedLaunch = inLaunchZone && st.flightCharges > 0;
    const launchPromptToken = armedLaunch && routeGuidance.actionRouteIndex >= 0
      ? `launch:${st.flightRouteCursor}:${routeGuidance.actionRouteIndex}`
      : noChargeLaunch
      ? `nocharge:${st.flightRouteCursor}:${routeGuidance.actionRouteIndex}`
      : '';
    const extensionPromptToken = extendPromptUseful && st.flightExtensionReady
      ? `extend:${st.flightRouteCursor}:${st.flightsCleared}`
      : '';
    // A denied mid-air press after the one allowed extension is the exact
    // "button feels broken" moment — answer it with the rule, in the same card.
    const spentPromptToken = st.flightDenied && flightActive && st.flightExtensionUsed && st.flightCharges > 0
      ? `spent:${st.flightRouteCursor}`
      : '';
    const newPromptToken = extensionPromptToken || launchPromptToken || spentPromptToken;
    if (race.phase === 'racing' && newPromptToken && !this.shownFlightPromptTokens.has(newPromptToken)) {
      this.shownFlightPromptTokens.add(newPromptToken);
      this.flightPromptSpent = newPromptToken === spentPromptToken && spentPromptToken !== '';
      this.flightPromptHitTimer = this.flightPromptSpent ? 1.6 : 2.15;
      this.flightPrompt.classList.remove('acquired');
      void this.flightPrompt.offsetWidth;
      this.flightPrompt.classList.add('acquired');
    }
    const availablePrompt: 'hidden' | 'launch' | 'extend' | 'spent' | 'no-charge' = this.flightPromptSpent
      ? 'spent'
      : extendPromptUseful && st.flightExtensionReady
      ? 'extend'
      : armedLaunch
      ? 'launch'
      : noChargeLaunch
      ? 'no-charge'
      : 'hidden';
    const promptMode: 'hidden' | 'launch' | 'extend' | 'spent' | 'no-charge' = inLaunchZone
      ? availablePrompt
      : this.flightPromptHitTimer > 0 ? availablePrompt : 'hidden';
    const promptDevice = this.controlDevice;
    if (promptMode !== this.flightPromptMode || promptDevice !== this.flightPromptDevice) {
      this.flightPromptMode = promptMode;
      this.flightPromptDevice = promptDevice;
      this.flightPrompt.classList.toggle('on', promptMode !== 'hidden');
      this.flightPrompt.classList.toggle('extend', promptMode === 'extend');
      this.flightPrompt.classList.toggle('spent', promptMode === 'spent');
      this.flightPrompt.classList.toggle('no-charge', promptMode === 'no-charge');
      const key = promptDevice === 'mobile' ? (promptMode === 'launch' ? '飞' : promptMode === 'no-charge' ? '!' : '续') : this.controlLabels.flight;
      if (promptMode === 'spent') {
        this.flightPromptKey.textContent = key;
        this.flightPromptEn.textContent = 'AIR CHARGE SPENT';
        this.flightPromptCn.textContent = '本飞续航已用完';
        this.flightPromptRule.textContent = '每飞限续 1 次 · 剩余格留给下一飞';
      } else if (promptMode === 'extend') {
        this.flightPromptKey.textContent = key;
        this.flightPromptEn.textContent = 'AIR CHARGE READY';
        this.flightPromptCn.textContent = promptDevice === 'mobile' ? '点「续」延长飞行' : `按 ${key} 续航`;
        this.flightPromptRule.textContent = promptDevice === 'mobile'
          ? '本飞仅此 1 次续航'
          : '本飞仅此 1 次续航 · 最多用 2 格（起飞 1 + 续航 1）';
      } else if (promptMode === 'no-charge') {
        this.flightPromptKey.textContent = '!';
        this.flightPromptEn.textContent = 'NEED DRIFT BATTERY';
        this.flightPromptCn.textContent = '⚠️ 飞行电池不足';
        this.flightPromptRule.textContent = '过弯按住漂移 · 越过黄线松手存入电池 ◇';
      } else {
        this.flightPromptKey.textContent = key;
        this.flightPromptEn.textContent = 'FLIGHT READY';
        this.flightPromptCn.textContent = promptDevice === 'mobile' ? '点「飞」提前起飞！' : `按 ${key} 提前起飞！`;
        this.flightPromptRule.textContent = '看到白雾桥提前点火 · 提早入轨避免错失航道';
      }
    }
    if (this.flightPromptHitTimer > 0) {
      this.flightPromptHitTimer -= dt;
      if (this.flightPromptHitTimer <= 0) {
        this.flightPrompt.classList.remove('acquired');
        this.flightPromptSpent = false;
      }
    }
    if (flightActive !== this.lastFlightActive) {
      this.lastFlightActive = flightActive;
      for (let i = 0; i < this.flightTokens.length; i++) {
        this.flightTokens[i].classList.toggle('active', flightActive && i < st.flightCharges);
      }
      this.powerPanel.classList.toggle('flying', flightActive);
    }
    // Every seat owns its own flight notices, so split play runs the whole
    // edge set once per seat instead of only for the camera focus.
    if (this.duoSplit) {
      this.updateSeatFlightNotices(race, _all[0], 'left', 0);
      this.updateSeatFlightNotices(race, _all[1], 'right', 1);
    } else {
      this.updateSeatFlightNotices(race, player, 'center', 0);
    }
    if (st.flightDenied || st.flightRouteMiss) this.flightAlertTimer = 0.32;
    if (this.flightAlertTimer > 0) {
      this.flightAlertTimer -= dt;
      this.powerPanel.classList.add('flight-alert');
    } else {
      this.powerPanel.classList.remove('flight-alert');
    }

    const authoredTurn = routeGuidance.actionCue === 'turn' ? routeGuidance.actionDirection : 'none';
    this.syncTurnWarningCopy(authoredTurn);
    if (race.phase === 'racing' && st.flightRouteState === 'active' && this.course.flightTurnWarning(player.id)) {
      this.turnWarningTimer = 1.45;
    } else if (st.flightRouteState !== 'active' || st.flightPhase === 'surface') {
      this.turnWarningTimer = 0;
    } else {
      this.turnWarningTimer = Math.max(0, this.turnWarningTimer - dt);
    }
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
    const countdownActive = race.phase === 'countdown' || race.phase === 'resume-countdown';
    if (cv !== this.lastCountdown || (countdownActive && !this.cdVisible)) {
      this.lastCountdown = cv;
      if (countdownActive || cv === 0) this.showCountdown(cv);
    }
    if (this.goTimer > 0) {
      this.goTimer -= dt;
      if (this.goTimer <= 0) this.hideCountdown();
    } else if (this.cdVisible && race.phase !== 'countdown' && race.phase !== 'resume-countdown') {
      this.hideCountdown();
    }

    this.updateImpact(dt, race.phase === 'racing');

  }

  private updateDriverPower(dt: number, race: RaceView, player: IBoat, all: readonly IBoat[]): void {
    // Every seat reads its own boat through its own camera, so split play runs
    // the instrument once per seat inside that seat's half of the frame.
    const seats = this.duoSplit ? [all[0], all[1]] : [player];
    for (let seat = 0; seat < seats.length; seat++) {
      const boat = seats[seat];
      if (boat) this.updateSeatDriverPower(dt, race, boat, seat, this.duoSplit);
    }
  }

  private updateSeatDriverPower(dt: number, race: RaceView, player: IBoat, seat: number, split: boolean): void {
    const state = deriveAbilityHudState(player.state);
    const active = race.phase === 'racing' && state.showNearRail;
    const el = this.driverPower[seat];
    el.classList.toggle('on', active);
    el.dataset.left = state.leftMode;
    el.dataset.flight = state.flightMode;
    el.dataset.urgency = state.urgency;
    el.style.setProperty('--driver-drift', String(state.boostCharge));
    el.style.setProperty('--driver-bank', String(state.driftBankProgress));
    el.style.setProperty('--driver-boost', String(state.boostRemaining));
    el.style.setProperty('--driver-flight', String(state.flightRemaining));
    el.style.setProperty('--driver-airbrake', String(state.flightAirBrake));
    this.driverLeftRail[seat].classList.toggle('on', active && state.leftMode !== 'idle');
    // Stored cells are shown as diamonds; the continuous rail only appears
    // once an airborne envelope is actually consuming time.
    this.driverRightRail[seat].classList.toggle('on', active &&
      (state.flightMode === 'active' || state.flightMode === 'extend'));
    this.driverLeftLabel[seat].textContent = state.leftMode === 'airbrake' ? 'AIR' : state.driftReleaseReady && state.flightCharges < MAX_FLIGHT_CHARGES ? 'BANK' : state.drifting && state.flightCharges >= MAX_FLIGHT_CHARGES ? 'MAX' : '';
    this.driverRightLabel[seat].textContent = state.flightMode === 'extend' ? '续' : state.urgency === 'critical' ? '!' : '';
    el.classList.toggle('release-ready', state.driftReleaseReady && state.flightCharges < MAX_FLIGHT_CHARGES);
    el.classList.toggle('full', state.drifting && state.boostCharge >= 0.995);
    el.classList.toggle('extend', state.flightMode === 'extend');
    el.classList.toggle('final', false);
    const stocks = this.driverStocks[seat].children;
    for (let i = 0; i < stocks.length; i++) {
      (stocks[i] as HTMLElement).classList.toggle('on', i < state.flightCharges);
    }

    if (!active) return;
    // Split play renders two half-width views side by side, so the projection
    // has to land inside this seat's own half instead of the whole window.
    const halfWidth = Math.round(innerWidth / 2);
    const viewLeft = split ? seat * halfWidth : 0;
    const viewWidth = split ? halfWidth : innerWidth;
    const camera = this.seatCameras[seat] ?? this.camera;
    player.riderMount.getWorldPosition(this.driverAnchor[seat]);
    this.driverAnchor[seat].project(camera);
    const riderX = viewLeft + (this.driverAnchor[seat].x * 0.5 + 0.5) * viewWidth;
    const riderY = (-this.driverAnchor[seat].y * 0.5 + 0.5) * innerHeight;
    const compact = viewWidth <= 900 || innerHeight <= 520;
    const mobile = this.controlDevice === 'mobile' && !split;
    if (!compact) {
      const sideDeadZone = 48;
      if (riderX < viewLeft + viewWidth * 0.5 - sideDeadZone) this.driverPowerSide[seat] = 1;
      else if (riderX > viewLeft + viewWidth * 0.5 + sideDeadZone) this.driverPowerSide[seat] = -1;
    }
    const localX = riderX - viewLeft;
    const localTargetX = mobile
      ? Math.max(116, Math.min(viewWidth - 250, localX + 132))
      : compact
        ? Math.max(116, viewWidth - 205)
        : Math.max(90, Math.min(viewWidth - 90, localX + this.driverPowerSide[seat] * 150));
    const targetX = viewLeft + localTargetX;
    const targetY = compact
      ? Math.max(104, Math.min(148, innerHeight * 0.34))
      : Math.max(innerHeight * 0.38, Math.min(innerHeight * 0.64, riderY + 18));
    const blend = 1 - Math.exp(-10 * Math.max(0, dt));
    this.driverAnchorX[seat] += (targetX - this.driverAnchorX[seat]) * blend;
    this.driverAnchorY[seat] += (targetY - this.driverAnchorY[seat]) * blend;
    el.style.setProperty('--driver-power-x', `${this.driverAnchorX[seat]}px`);
    el.style.setProperty('--driver-power-y', `${this.driverAnchorY[seat]}px`);
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

  setBestFlights(best: number, current: number): void {
    this.bestFlights = Math.max(this.bestFlights, best);
    if (current >= 3) this.lapVal.textContent = `本局 ${current} 飞 · BEST ${this.bestFlights}`;
  }

  showQualification(tier: 'ordinary' | 'excellent', medals: number, best: number): void {
    this.bestFlights = Math.max(this.bestFlights, best);
    this.currentMedalTier = tier;
    this.medalEl.dataset.tier = tier;
    const isFinale = best >= 7;
    if (isFinale) {
      this.medalKicker.textContent = tier === 'excellent' ? '七飞大满贯 · 终局至尊达成' : '七飞通关 · 实力登顶';
      this.medalTitle.textContent = '猛男至尊';
      this.medalCount.textContent = `至尊勋章 +1 · 累计 ${medals}`;
      this.medalTier.textContent = tier === 'excellent'
        ? '第一名冲线 · 历史最高荣誉'
        : '完赛通关 · 顶级车手认证';
      this.medalNext.textContent = '远海全档案已解锁 · 随时进入资料片彩蛋';
    } else {
      this.medalKicker.textContent = tier === 'excellent' ? '三飞达成 · 优秀已锁定' : '三飞达成 · 实力兑现';
      this.medalTitle.textContent = '猛男';
      this.medalCount.textContent = `男人勋章 +1 · 累计 ${medals}`;
      this.medalTier.textContent = tier === 'excellent'
        ? '第一名 · 优秀已经锁定'
        : '勋章已入账 · 下一局冲上第一';
      this.medalNext.textContent = best > 3
        ? `远海档案 BEST ${best} 飞 · 下一目标 ${best + 1} 飞`
        : '三飞只是入场 · 远海档案现在开局';
    }
    this.medalNext.classList.remove('on');
    this.medalContinue.hidden = true;
    // The dossier entry is available for the whole ceremony; the auto
    // countdown only pauses while the gallery is actually open.
    this.medalGallery.hidden = false;
    this.medalEl.classList.add('on');
    this.root.classList.add('medal-on');
    this.medalContinue.blur();
  }

  updateMedalCeremony(elapsed: number, duration: number, canContinue: boolean): void {
    if (!this.medalEl.classList.contains('on')) return;
    this.medalCanvas.render(elapsed, duration, this.currentMedalTier);
    this.medalEl.style.setProperty('--ceremony-progress', String(Math.max(0, Math.min(1, elapsed / duration))));
    this.medalContinue.hidden = !canContinue;
    this.medalNext.classList.toggle('on', elapsed >= Math.max(2.7, duration - 1.8));
  }

  hideMedalCeremony(): void {
    this.medalEl.classList.remove('on');
    this.root.classList.remove('medal-on');
    this.medalContinue.hidden = true;
    this.medalGallery.hidden = true;
    this.medalNext.classList.remove('on');
    this.medalCanvas.clear();
  }

  showFinalReady(lane: 'left' | 'center' | 'right' = 'center'): void {
    const brake = this.controlDevice === 'mobile' ? '按住「刹」回港刹车' : `按住 ${this.controlLabels.drift} 回港刹车`;
    this.enqueueImpact({
      kind: 'final-ready', kicker: '七飞大满贯达成', title: '七飞完成 · 航线解除', detail: `${brake} · 穿过金色终点`,
      color: PALETTE.sunFlare, duration: 2.1, priority: 96, lane,
    });
  }

  showReady(mobile: boolean, nextRun: boolean): void {
    this.readyTitle.textContent = nextRun ? '再飞一次' : '是男人就飞三次';
    this.readyAction.textContent = mobile ? (nextRun ? '点击 GO 开始下一局' : '点击 GO 开始') : '按 ENTER 开始';
    this.readyAction.hidden = mobile;
    this.readyEl.classList.add('on');
    this.root.classList.add('ready-on');
  }

  /**
   * Keep both owners' controls in one predictable place during a dual run.
   * The legend is intentionally compact and descriptive; it can be left on
   * while racing so a returning/eliminated player still knows their actions.
   */
  setDuoControls(visible: boolean, leftDevice = 'keyboard-left', rightDevice = 'keyboard-right'): void {
    this.duoControlsEl.classList.toggle('on', visible);
    this.duoControlsEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (!visible) return;
    this.renderDuoControlSeat(this.duoControlsLeft, '左席', leftDevice, false);
    this.renderDuoControlSeat(this.duoControlsRight, '右席', rightDevice, true);
  }

  hideReady(): void {
    this.readyEl.classList.remove('on');
    this.root.classList.remove('ready-on');
  }

  private renderDuoControlSeat(el: HTMLDivElement, label: string, device: string, right: boolean): void {
    const gamepad = device.startsWith('gamepad:');
    el.textContent = '';
    const heading = document.createElement('strong');
    const deviceLabel = gamepad
      ? `手柄 ${Number.parseInt(device.slice('gamepad:'.length), 10) + 1}`
      : right ? '键盘右区' : '键盘左区';
    heading.textContent = `${label} · ${deviceLabel}`;
    const detail = document.createElement('span');
    detail.textContent = gamepad
      ? '左摇杆 转向　X 漂移 · A 起飞　B 支援 · Y 浪花'
      : right
        ? '← / → 转向　SHIFT / NUM0 漂移 · I / NUM↵ 起飞　U 支援 · O 浪花'
        : 'A / D 转向　SHIFT 漂移 · SPACE 起飞　Q 支援 · E 浪花';
    el.append(heading, detail);
  }

  showInterruption(resumeCountdown: boolean, reason = ''): void {
    this.interruptionCopy.textContent = resumeCountdown
      ? reason ? `${reason} · 比赛与声音已冻结 · 原地恢复` : '比赛与声音已冻结 · 原地恢复'
      : reason ? `${reason} · 当前画面与计时已冻结` : '当前画面与计时已冻结';
    this.interruptionFoot.textContent = resumeCountdown ? '继续后 3 · 2 · 1 · GO' : '继续后保留当前奖励 / 攻略进度';
    this.interruptionButton.textContent = resumeCountdown ? 'GO · 继续比赛' : 'GO · 继续';
    this.interruptionEl.classList.add('on');
    this.root.classList.add('interrupted');
  }

  hideInterruption(): void {
    this.interruptionEl.classList.remove('on');
    this.root.classList.remove('interrupted');
  }

  showExcellentLocked(total: number): void {
    this.enqueueImpact({
      kind: 'excellent',
      kicker: '领跑榜首',
      title: '👑 优秀车手锁定',
      detail: `优秀战绩累计 × ${total}`,
      color: PALETTE.uiAccent,
      duration: 1.2,
      priority: 90,
    });
  }

  /** Short race-direction notice. In split play it belongs to one seat's card slot. */
  showTransientNotice(detail: string, title = '赛事通报', lane: 'left' | 'center' | 'right' = 'center', kicker = '赛场速递'): void {
    this.enqueueImpact({
      kind: 'duo-interaction',
      kicker,
      title,
      detail,
      color: PALETTE.uiAccent,
      duration: 1.45,
      priority: 66,
      lane,
    });
  }

  showHonorTargetNotice(
    racer: string,
    title: string,
    value: number,
    precision: 'center' | 'edge',
    lane: 'left' | 'center' | 'right' = 'center',
    streak = 0,
  ): void {
    const safeStreak = Math.max(0, Math.min(streak, 6));
    const detail = safeStreak > 0
      ? `${racer} · ${precision === 'center' ? '正中命中' : '擦边命中'} · 连击 ×${safeStreak + 1} · 荣誉已记录`
      : `${racer} · ${precision === 'center' ? '正中命中' : '擦边命中'} · 荣誉已记录`;
    this.enqueueImpact({
      kind: 'honor-coin',
      kicker: safeStreak > 0 ? `金币连击 ×${safeStreak + 1}` : '金币收集',
      title: `${title} +${value}`,
      detail,
      color: PALETTE.sunFlare,
      duration: 0.92,
      priority: 70,
      lane,
    });
  }

  showFlightPass(flights: number, best: number, newBest: boolean, lane: 'left' | 'center' | 'right' = 'center'): void {
    this.setBestFlights(best, flights);
    if (flights <= 3) return;
    this.enqueueImpact({
      kind: 'flight-pass',
      kicker: newBest ? '🏆 刷新历史最佳' : '航段达成',
      title: `✨ 第 ${flights} 飞完美通过`,
      detail: `远海记录 BEST ${best} 飞`,
      color: PALETTE.flight,
      duration: 0.75,
      priority: 58,
      lane,
    });
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
      ? `${this.failureCopy(result)}${this.failureEvidence(result)}`
      : excellent
        ? '三飞无误 · 第一名'
        : `三飞完成 · 慢第一 ${(result.leaderGapSeconds ?? 0).toFixed(2)} 秒`;
    this.resultsMedal.textContent = defeated
      ? '三次飞行缺一不可'
      : excellent
        ? `优秀完成 × ${result.excellentTotal}`
        : result.ordinaryNew ? '普通达成 · 下一局冲优秀' : '第一，才算优秀';
    this.resultsRows.textContent = '';
    if (result.failure) this.resultsEl.dataset.failureReason = result.failure.reason;
    this.resultStat('TIME', fmtTime(result.raceTime));
    this.resultStat('OVERTAKES', String(result.overtakes));
    this.resultStat('FLIGHTS', `${result.flightsCleared} / 3`);
    if (result.flightsCleared >= 3 || result.manMedalEarned) {
      this.resultsMachoMedal.style.display = 'block';
      this.resultsPanel.classList.add('has-macho-medal');
    } else {
      this.resultsMachoMedal.style.display = 'none';
      this.resultsPanel.classList.remove('has-macho-medal');
    }
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
    this.resultsEl.removeAttribute('data-failure-reason');
    this.resultsMachoMedal.style.display = 'none';
    this.resultsPanel.classList.remove('has-macho-medal');
    this.clearBattle();
    this.turnWarning.classList.remove('on', 'braking');
  }

  showRetryLesson(
    result: ChallengeResult,
    attempt: number,
    repeatCount: number,
    newBest = false,
    device: CoachInputDevice = 'keyboard',
    coachArmed = false,
    mastery?: CoachMastery,
    continueToHonors = false,
  ): void {
    const failure = result.failure;
    const lesson = this.lessonFor(failure, device, mastery);
    this.hideResults();
    const flight = failure?.flightNumber ?? result.flightsCleared + 1;
    const encouragement = this.encouragementFor(result);
    const runSegment = failure && this.isSurfaceFailure(failure.reason) ? '水面段' : `第 ${flight} 飞`;
    this.lessonAttempt.textContent = `RUN REVIEW // RUN ${String(attempt).padStart(2, '0')} · ${runSegment}`;
    this.lessonEmotion.textContent = encouragement.title;
    this.lessonMedal.textContent = result.manMedalEarned
      ? `本局男人勋章 +1 · 累计 ${result.manMedalsTotal}`
      : encouragement.progress;
    this.lessonMedal.classList.toggle('earned', result.manMedalEarned);
    this.lessonTitle.textContent = lesson.title;
    this.lessonCopy.textContent = coachArmed
      ? `${lesson.copy}。下一局可用聚光标注边开边学，随时能跳过。`
      : lesson.copy;
    const evidence = this.failureEvidence(result).replace(/^\s*·\s*/, '');
    this.lessonMetric.textContent = `${evidence || `本局 ${result.flightsCleared} 飞`} · BEST ${result.bestFlights}${newBest ? ' · NEW BEST' : ''}`;
    if (failure) this.lessonEl.dataset.failureReason = failure.reason;
    this.lessonContinue.hidden = false;
    this.lessonDisable.hidden = !coachArmed;
    this.lessonContinue.textContent = continueToHonors ? '查看成就墙' : coachArmed ? '带标注再冲' : '再冲一次';
    this.updateRetryLesson(0, !continueToHonors);
    this.root.classList.add('lesson-on');
    this.lessonEl.classList.add('on');
  }

  updateRetryLesson(progress: number, canContinue = false): void {
    const filled = Math.min(this.lessonPips.length, Math.floor(Math.max(0, Math.min(1, progress)) * this.lessonPips.length + 1e-4));
    for (let i = 0; i < this.lessonPips.length; i++) this.lessonPips[i].classList.toggle('on', i < filled);
    this.lessonContinue.hidden = !canContinue;
  }

  hideRetryLesson(): void {
    this.root.classList.remove('lesson-on');
    this.lessonEl.classList.remove('on');
    this.lessonEl.removeAttribute('data-failure-reason');
    this.lessonContinue.hidden = true;
    this.lessonDisable.hidden = true;
    for (const pip of this.lessonPips) pip.classList.remove('on');
  }

  showCoach(presentation: CoachPresentation | null): void {
    if (presentation && (this.battleTimer > 0 || this.impactBusy())) presentation = null;
    if (!presentation) {
      this.activeCoach = null;
      this.coachEl.classList.remove('on');
      this.coachSpotlight.classList.remove('on');
      this.coachConnector.classList.remove('on');
      this.root.classList.remove('coach-on');
      delete this.root.dataset.coachStep;
      delete this.coachEl.dataset.tone;
      delete this.root.dataset.coachFocus;
      return;
    }
    this.activeCoach = presentation;
    this.coachEl.dataset.tone = presentation.tone;
    this.coachEl.dataset.step = presentation.id;
    this.coachEl.setAttribute('role', 'dialog');
    this.coachEl.setAttribute('aria-label', `驾驶提示：${presentation.title}`);
    this.root.dataset.coachStep = presentation.id;
    this.root.dataset.coachFocus = presentation.focus;
    this.coachStage.textContent = presentation.stage;
    this.coachControl.textContent = presentation.control;
    const externalDriftControl = this.controlDevice === 'keyboard' && presentation.focus === 'drift-control' &&
      this.pcPrimerEl.classList.contains('on');
    this.coachControl.hidden = presentation.control.length === 0 || externalDriftControl;
    this.coachKicker.textContent = presentation.kicker;
    this.coachTitle.textContent = presentation.title;
    this.coachDetail.textContent = presentation.detail;
    this.coachEl.classList.add('on');
    this.positionCoach(presentation.focus);
    this.coachSpotlight.classList.add('on');
    this.root.classList.add('coach-on');
  }

  coachPresentationBlocked(): boolean {
    return this.battleTimer > 0 || this.impactBusy();
  }

  flightPromptVisible(): boolean {
    return this.flightPromptMode !== 'hidden';
  }

  beginFreshRunGuidance(): void {
    this.flightPromptHitTimer = 0;
    this.flightPromptSpent = false;
    this.shownFlightPromptTokens.clear();
    this.flightPromptMode = 'hidden';
    this.flightPrompt.classList.remove('on', 'extend', 'spent', 'acquired');
  }

  showPcControlPrimer(
    presentation: PcControlPrimerPresentation | null,
    dismissible = false,
    ownsFlight = false,
  ): void {
    this.primerOwnsFlight = ownsFlight;
    if (!presentation) {
      this.root.classList.remove('primer-meter');
      this.pcPrimerEl.classList.remove('on');
      this.pcPrimerEl.removeAttribute('data-step');
      this.pcPrimerEl.removeAttribute('data-tone');
      return;
    }
    this.pcPrimerEl.dataset.step = presentation.step;
    this.pcPrimerEl.dataset.tone = presentation.tone;
    this.pcPrimerKey.textContent = presentation.key;
    this.pcPrimerKicker.textContent = presentation.kicker;
    this.pcPrimerTitle.textContent = presentation.title;
    this.pcPrimerDetail.textContent = presentation.detail;
    this.pcPrimerEl.style.setProperty('--primer-progress', String(Math.max(0, Math.min(1, presentation.progress))));
    this.pcPrimerMeter.classList.toggle('ready', presentation.ready);
    this.pcPrimerEl.setAttribute('aria-label', `键盘操作：${presentation.title}。${presentation.detail}`);
    this.pcPrimerClose.hidden = !dismissible;
    this.root.classList.toggle('primer-meter', presentation.step === 'charging' || presentation.step === 'release');

    const stepIdx = (presentation.step === 'drift' || presentation.step === 'charging' || presentation.step === 'release')
      ? 0
      : (presentation.step === 'banked' || presentation.step === 'waiting-launch' || presentation.step === 'launch' || presentation.step === 'success')
      ? 1
      : 2;
    for (let i = 0; i < this.pcPrimerStepItems.length; i++) {
      this.pcPrimerStepItems[i].classList.toggle('active', i === stepIdx);
      this.pcPrimerStepItems[i].classList.toggle('completed', i < stepIdx);
    }

    this.pcPrimerEl.classList.add('on');
  }

  private positionCoach(focus: CoachFocus): void {
    const target = this.coachTarget(focus);
    if (!target) {
      this.coachSpotlight.classList.remove('on');
      this.coachConnector.classList.remove('on');
      return;
    }
    const bounds = this.root.getBoundingClientRect();
    let rect = target.getBoundingClientRect();
    const pad = focus === 'drift-meter' || focus === 'flight-meter' ? 8 : 10;
    const left = Math.max(6, rect.left - bounds.left - pad);
    const top = Math.max(6, rect.top - bounds.top - pad);
    const width = Math.min(bounds.width - left - 6, rect.width + pad * 2);
    const height = Math.min(bounds.height - top - 6, rect.height + pad * 2);
    this.coachSpotlight.style.left = `${left}px`;
    this.coachSpotlight.style.top = `${top}px`;
    this.coachSpotlight.style.width = `${Math.max(24, width)}px`;
    this.coachSpotlight.style.height = `${Math.max(24, height)}px`;

    const compact = innerWidth <= 900 || innerHeight <= 520;
    let cardWidth = compact ? Math.min(320, Math.max(236, bounds.width - 172)) : Math.min(390, bounds.width - 32);
    const cardHeight = compact ? 124 : 142;
    const safe = compact ? 12 : 20;
    const targetCx = left + width * 0.5;
    const targetCy = top + height * 0.5;
    let cardLeft = compact ? safe : bounds.width - cardWidth - safe;
    let cardTop = compact ? safe : targetCy - cardHeight * 0.5;
    if (compact) {
      const occupiedLeft = [
        this.root.querySelector('.hud-topleft'),
        document.querySelector('.race-tower.on'),
      ].reduce((right, element) => {
        if (!element) return right;
        const occupied = element.getBoundingClientRect();
        return Math.max(right, occupied.right - bounds.left);
      }, Math.min(176, bounds.width * 0.24));
      const candidate = occupiedLeft + safe;
      const thumbZoneLeft = [
        document.querySelector('[data-mobile-action="flight"]'),
        document.querySelector('[data-mobile-action="drift"]'),
      ].reduce((leftEdge, element) => {
        if (!element) return leftEdge;
        const occupied = element.getBoundingClientRect();
        return Math.min(leftEdge, occupied.left - bounds.left);
      }, bounds.width);
      const availableWidth = thumbZoneLeft - safe - candidate;
      if (availableWidth >= 236) cardWidth = Math.min(cardWidth, availableWidth);
      if (candidate + cardWidth <= bounds.width - safe) cardLeft = candidate;
      // The compact top-center lane stays clear of both the near-boat meter
      // and fixed thumb zones; the connector carries the eye to the target.
      cardTop = safe;
    }
    cardLeft = Math.max(safe, Math.min(cardLeft, bounds.width - cardWidth - safe));
    cardTop = Math.max(safe, Math.min(cardTop, bounds.height - cardHeight - safe));
    this.coachEl.style.left = `${cardLeft}px`;
    this.coachEl.style.top = `${cardTop}px`;
    this.coachEl.style.width = `${cardWidth}px`;

    // Keyboard/gamepad controls have no permanent world-space button. Their
    // actual glyph lives in the annotation itself, so locate it only after
    // the card has been placed; mobile always spotlights the live thumb zone.
    if (target === this.coachControl) {
      rect = this.coachControl.getBoundingClientRect();
      const controlLeft = Math.max(6, rect.left - bounds.left - pad);
      const controlTop = Math.max(6, rect.top - bounds.top - pad);
      const controlWidth = Math.min(bounds.width - controlLeft - 6, rect.width + pad * 2);
      const controlHeight = Math.min(bounds.height - controlTop - 6, rect.height + pad * 2);
      this.coachSpotlight.style.left = `${controlLeft}px`;
      this.coachSpotlight.style.top = `${controlTop}px`;
      this.coachSpotlight.style.width = `${Math.max(24, controlWidth)}px`;
      this.coachSpotlight.style.height = `${Math.max(24, controlHeight)}px`;
      this.coachConnector.classList.remove('on');
      return;
    }

    const cardCx = cardLeft + cardWidth * 0.5;
    const cardCy = cardTop + cardHeight * 0.5;
    const dx = targetCx - cardCx;
    const dy = targetCy - cardCy;
    const length = Math.hypot(dx, dy);
    if (length < 28) {
      this.coachConnector.classList.remove('on');
      return;
    }
    this.coachConnector.style.left = `${cardCx}px`;
    this.coachConnector.style.top = `${cardCy}px`;
    this.coachConnector.style.width = `${length}px`;
    this.coachConnector.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    this.coachConnector.classList.add('on');
  }

  private coachTarget(focus: CoachFocus): Element | null {
    if (focus === 'drift-control') {
      if (this.controlDevice === 'mobile') return document.querySelector('[data-mobile-action="drift"] span');
      if (this.controlDevice === 'keyboard' && this.pcPrimerEl.classList.contains('on')) return this.pcPrimerKey;
      return this.coachControl;
    }
    if (focus === 'drift-meter') return this.driverLeftRail[0];
    if (focus === 'flight-stock') return this.driverStocks[0];
    if (focus === 'flight-control') {
      return this.controlDevice === 'mobile'
        ? document.querySelector('[data-mobile-action="flight"] span')
        : this.flightPromptKey;
    }
    if (focus === 'flight-meter') return this.driverRightRail[0];
    if (this.controlDevice === 'mobile') {
      return document.querySelector('.mobile-tilt-meter') ?? document.querySelector('.mobile-steer-zones');
    }
    return this.coachControl;
  }

  setControlDevice(device: CoachInputDevice, labels?: { steer: string; drift: string; flight: string }): void {
    const controls = labels ?? (device === 'mobile'
      ? { steer: '轻调方向', drift: '「漂」', flight: '「飞」' }
      : device === 'gamepad'
        ? { steer: '左摇杆', drift: 'X / LB / RB', flight: 'A' }
        : { steer: 'A / D', drift: 'SHIFT', flight: 'SPACE' });
    if (device === 'mobile' && this.controlDevice !== 'mobile') this.driverAnchorX[0] = innerWidth * 0.56;
    this.controlDevice = device;
    this.controlLabels = controls;
    this.syncTurnWarningCopy('none');
  }

  private syncTurnWarningCopy(direction: RouteTurnDirection | 'none'): void {
    const authoredTurn = direction !== 'none';
    const right = direction === 'right';
    const mark = authoredTurn ? right ? '›››' : '‹‹‹' : '!';
    const title = authoredTurn ? right ? '急右航道' : '急左航道' : '急弯逼近';
    const steer = authoredTurn
      ? this.controlDevice === 'keyboard' ? right ? '→' : '←'
        : this.controlDevice === 'gamepad' ? right ? '摇杆 →' : '摇杆 ←' : right ? '右转' : '左转'
      : this.controlLabels.steer;
    const action = authoredTurn ? right ? '空刹右转' : '空刹左转' : '空刹转向';
    if (this.turnWarningMark.textContent !== mark) this.turnWarningMark.textContent = mark;
    if (this.turnWarningTitle.textContent !== title) this.turnWarningTitle.textContent = title;
    if (this.turnWarningDriftKey.textContent !== this.controlLabels.drift) {
      this.turnWarningDriftKey.textContent = this.controlLabels.drift;
    }
    if (this.turnWarningSteerKey.textContent !== steer) this.turnWarningSteerKey.textContent = steer;
    if (this.turnWarningAction.textContent !== action) this.turnWarningAction.textContent = action;
    this.turnWarning.classList.toggle('route-turn-right', right);
    this.turnWarning.classList.toggle('route-turn-left', direction === 'left');
  }

  clearBattle(): void {
    this.battleTimer = 0;
    this.battleEl.classList.remove('on', 'safety-compact');
  }

  clearTransientNotices(): void {
    this.clearBattle();
    for (const slot of this.impactSlots) {
      slot.queue.length = 0;
      slot.timer = 0;
      slot.priority = -1;
      slot.active = null;
      slot.el.classList.remove('on');
    }
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
    this.battleTimer = kind === 'overtake' ? 1.4 : 1.1;
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
    if (reason === 'off_course') return '偏离绿色主线 · 挑战结束';
    if (reason === 'wrong_way') return '水面方向反了 · 挑战结束';
    if (reason === 'corridor') return `第 ${flight} 飞 · 偏离航线`;
    if (reason === 'landing') return `第 ${flight} 飞 · 提前落水`;
    if (reason === 'exit') return `第 ${flight} 飞 · 飞行区出口漏门`;
    if (reason === 'teleport') return `第 ${flight} 飞 · 路线重置`;
    if (reason === 'late') return `第 ${flight} 飞 · 高度/时机不足`;
    if (reason === 'gate_left' || reason === 'gate_right' || reason === 'gate') {
      const f = result.failure;
      if (f?.lateralOffsetM !== null && f?.lateralOffsetM !== undefined && f?.lateralLimitM !== null && f?.lateralLimitM !== undefined) {
        const miss = Math.max(0, Math.abs(f.lateralOffsetM) - f.lateralLimitM);
        if (miss > 2.5) return `第 ${flight} 飞 · 错失光门`;
      }
      return `第 ${flight} 飞 · 撞柱`;
    }
    return `第 ${flight} 飞 · 漏门`;
  }

  private failureCopy(result: ChallengeResult): string {
    const reason = result.failure?.reason ?? result.reason;
    const why: Record<FlightRouteFailReason, string> = {
      none: '挑战未完成',
      off_course: '冲出主航线后没有及时回正',
      wrong_way: '逆向行驶超过纠正窗口',
      no_launch: '没有起飞，水面通过不计完成',
      corridor: '飞离了悬空白雾航线',
      gate: '撞柱',
      gate_left: '撞柱',
      gate_right: '撞柱',
      late: '起飞太晚，穿杆时尚未达到认证高度',
      landing: '通过飞行门前已经落水',
      exit: '离开飞行区时仍未通过门',
      teleport: '航线状态已重置',
      missile_blast: '遭遇战术巡航导弹空中直击',
    };
    return why[reason];
  }

  private isSurfaceFailure(reason: FlightRouteFailReason): boolean {
    return reason === 'off_course' || reason === 'wrong_way';
  }

  private failureEvidence(result: ChallengeResult): string {
    const f = result.failure;
    if (!f) return '';
    switch (f.reason) {
      case 'off_course':
        return f.corridorDistanceM !== null ? ` · 离绿色主线 ${f.corridorDistanceM.toFixed(1)}m` : '';
      case 'wrong_way':
        return ' · 水面逆行超过纠正窗口';
      case 'corridor':
        return f.corridorDistanceM !== null ? ` · 悬空通道偏离 ${f.corridorDistanceM.toFixed(1)}m` : '';
      case 'landing':
        return ` · 已过 ${f.gatesPassed}/${f.gateCount} 门 · 当前高度 ${f.clearanceM.toFixed(1)}m`;
      case 'late':
        return f.clearanceM < 2.8 ? ` · 穿门高度 ${f.clearanceM.toFixed(1)}m / 需要 2.8m` : ' · 穿门时机已晚';
      case 'gate_left':
      case 'gate_right':
        if (f.lateralOffsetM !== null && f.lateralLimitM !== null) {
          const miss = Math.max(0, Math.abs(f.lateralOffsetM) - f.lateralLimitM);
          return miss > 2.5 ? ` · 偏离光门 ${miss.toFixed(1)}m` : ` · 超出门心 ${miss.toFixed(1)}m`;
        }
        return '';
      case 'no_launch':
        return ` · 目标门前未进入飞行 · 已过 ${f.gatesPassed}/${f.gateCount} 门`;
      case 'exit':
        return ' · 离开飞行区时未完成门序';
      case 'missile_blast':
        return ` · 遭遇战术巡航导弹直击 · 炸飞 ${f.clearanceM.toFixed(1)}m · 720° 腾空翻转`;
      default:
        return '';
    }
  }

  private lessonFor(
    failure: FlightFailureSnapshot | null,
    device: CoachInputDevice,
    mastery?: CoachMastery,
  ): { title: string; copy: string; metric: string } {
    const mobile = device === 'mobile';
    const gamepad = device === 'gamepad';
    const drift = this.controlLabels.drift;
    const flight = this.controlLabels.flight;
    const steer = mobile ? '轻调方向' : gamepad ? `${this.controlLabels.steer}轻调` : '用 A / D 轻调';
    if (!failure) return {
      title: '还差一飞',
      copy: `下一次：按住 ${drift} 到黄线，松开入库，再按 ${flight} 起飞`,
      metric: '',
    };
    switch (failure.reason) {
      case 'missile_blast':
        return {
          title: '💥 遭遇导弹超音速轰杀 · 翻滚 720°',
          copy: mobile
            ? '下一次：听到 🚨 锁定预警立即按住「漂 / 空刹」（享 50% 规避豁免）；空中被锁定时听天由命！'
            : gamepad
            ? `下一次：听到 🚨 锁定预警立即按住 ${drift} 极限漂移（享 50% 规避豁免）；空中被锁定时听天由命！`
            : `下一次：听到 🚨 锁定预警立即按住 ${drift} 极限漂移（享 50% 规避豁免）；空中被锁定时听天由命！`,
          metric: '',
        };
      case 'off_course':
        return {
          title: `偏离绿色主线 · ${failure.corridorDistanceM?.toFixed(0) ?? '?'}m`,
          copy: `下一次：警告出现就松开方向，${steer}回主航线`,
          metric: '',
        };
      case 'wrong_way':
        return {
          title: '方向反了',
          copy: mobile ? '下一次：看到逆行警告立刻掉头回主航线' : '下一次：看到“方向反了”立刻掉头回主航线',
          metric: '',
        };
      case 'no_launch':
        return {
          title: '没有起飞',
          copy: mastery?.bankedCharge
            ? `你已经会入库；下一次白雾航道展开时按 ${flight} 起飞`
            : `下一次：按住 ${drift} 到黄线，松开入库后按 ${flight}`,
          metric: '',
        };
      case 'late': {
        const short = Math.max(0, 2.8 - failure.clearanceM);
        return {
          title: failure.clearanceM < 2.8 ? `高度不足 · 差 ${short.toFixed(1)}m` : '起飞时机太晚',
          copy: failure.clearanceM < 2.8 ? `下一次：更早按 ${flight}，先升到门高` : `下一次：更早按 ${flight}`,
          metric: '',
        };
      }
      case 'gate_left':
      case 'gate_right': {
        const left = failure.reason === 'gate_left';
        const miss = failure.lateralOffsetM !== null && failure.lateralLimitM !== null
          ? Math.max(0, Math.abs(failure.lateralOffsetM) - failure.lateralLimitM) : 0;
        const direction = left ? (mobile ? '向右' : 'D') : (mobile ? '向左' : 'A');
        const isWide = miss > 2.5;
        return {
          title: isWide ? `错失光门 · 偏离 ${miss.toFixed(1)}m` : `撞柱 · 差 ${miss.toFixed(1)}m`,
          copy: isWide
            ? (mobile ? `按住「漂 / 空刹」减速，再${direction}对准光门` : gamepad ? `按住 ${drift} 空刹减速，左摇杆向${left ? '右' : '左'}对准光门` : `按住 SHIFT 空刹减速，再用 ${direction} 对准光门`)
            : (mastery?.airBrakedInTurn
              ? `${steer}回到两杆中点`
              : mobile
              ? `按住「漂 / 空刹」，再${direction}轻调回正`
              : gamepad ? `按住 ${drift} 空刹，再用左摇杆向${left ? '右' : '左'}轻调` : `按住 SHIFT 空刹，再用 ${direction} 轻调回正`),
          metric: '',
        };
      }
      case 'corridor':
        return {
          title: `偏航先空刹 · 偏离 ${failure.corridorDistanceM?.toFixed(1) ?? '?'}m`,
          copy: `按住 ${drift} 空刹减速，再${steer}回白雾航线`,
          metric: '',
        };
      case 'landing':
        return { title: '提前落水', copy: `下一次：靠近入口再按 ${flight}；续航每飞限 1 次`, metric: '' };
      case 'exit':
        return {
          title: '偏航先空刹 · 飞行未完成',
          copy: `按住 ${drift} 空刹，${steer}回白雾航线`,
          metric: '',
        };
      case 'gate':
        return {
          title: '撞柱',
          copy: `按住 ${drift} 空刹，对准两根发光杆中点`,
          metric: '',
        };
      case 'teleport':
        return { title: '路线重置', copy: '下一次：从入口完整进入', metric: '' };
      default:
        return {
          title: '还差一飞',
          copy: `下一次：先按 ${drift} 到黄线并松开，再按 ${flight}`,
          metric: '',
        };
    }
  }

  private encouragementFor(result: ChallengeResult): { title: string; progress: string } {
    const flights = result.flightsCleared;
    if (flights >= 3 && result.outcome === 'excellent') {
      return { title: '优秀已锁定！', progress: `第 ${flights + 1} 飞只是一次失误，优势还在` };
    }
    if (flights >= 3) {
      const gap = result.leaderGapSeconds;
      return {
        title: gap !== null && gap > 0 && gap <= 1.5 ? '只差一口气' : '勋章已入账',
        progress: gap !== null && gap > 0 ? `离优秀男人还差 ${gap.toFixed(2)} 秒` : '下一局夺回第一，升级优秀',
      };
    }
    if (flights === 2) {
      return {
        title: '最后一飞，定级',
        progress: result.place === 1 ? '第一在手，最后一飞定级' : '先把勋章拿稳，再抢第一',
      };
    }
    if (flights === 1) return { title: '首飞拿下', progress: '首飞已入账，再过两飞拿勋章' };
    return { title: '失误不改结局', progress: '下一局，先拿首飞' };
  }

  // ------------------------------------------------------------------ pieces ----

  private showCountdown(v: number): void {
    const el = this.countdownEl;
    el.classList.remove('pop', 'go');
    void el.offsetWidth; // restart the CSS pop animation
    this.countdownLabel.textContent = v > 0 ? String(v) : 'GO!';
    // The rail is a remaining-count indicator: three lamps at 3, then one
    // goes dark on every tick. GO is the release, so every lamp is off.
    const lit = v > 0 ? v : 0;
    for (let i = 0; i < this.countdownLights.length; i++) {
      this.countdownLights[i].classList.toggle('on', i < lit);
      this.countdownLights[i].classList.remove('go');
    }
    el.classList.add('pop');
    if (v === 0) {
      el.classList.add('go');
      this.goTimer = GO_LINGER;
      this.brandEl.classList.remove('on');
      void this.brandEl.offsetWidth;
      this.brandEl.classList.add('on');
    } else {
      this.brandEl.classList.remove('on');
    }
    this.cdVisible = true;
    this.root.classList.add('countdown-on');
  }

  private hideCountdown(): void {
    this.cdVisible = false;
    this.goTimer = 0;
    this.countdownEl.classList.remove('pop', 'go');
    this.brandEl.classList.remove('on');
    this.root.classList.remove('countdown-on');
  }

  private spawnToast(delta: number): void {
    const el = document.createElement('div');
    const ahead = delta < 0;
    el.className = ahead ? 'hud-toast hud-inked good' : 'hud-toast hud-inked bad';
    el.textContent = `${ahead ? '−' : '+'}${Math.abs(delta).toFixed(2)}`;
    this.toastBox.appendChild(el);
    this.toasts.push({ el, life: TOAST_LIFE });
  }

  private impactBusy(): boolean {
    return this.impactSlots.some((slot) => slot.timer > 0);
  }

  /** In split play each seat owns a slot; solo play uses the first one only. */
  private slotForLane(lane: ImpactNotice['lane']): ImpactSlot {
    if (!this.duoSplit) return this.impactSlots[0];
    return lane === 'right' ? this.impactSlots[1] : this.impactSlots[0];
  }

  private enqueueImpact(notice: ImpactNotice): void {
    const slot = this.slotForLane(notice.lane);
    // Deduplication check: if identical notice is already active, just refresh duration
    if (slot.active && (slot.active.title === notice.title && slot.active.detail === notice.detail)) {
      slot.timer = Math.max(slot.timer, notice.duration);
      return;
    }
    // Remove duplicates from queue
    const existingIndex = slot.queue.findIndex((q) => q.title === notice.title && q.detail === notice.detail);
    if (existingIndex !== -1) {
      slot.queue.splice(existingIndex, 1);
    }

    if (slot.timer <= 0 || notice.priority >= slot.priority) {
      if (slot.timer > 0 && slot.priority >= 50 && slot.active) {
        slot.queue.unshift({ ...slot.active, duration: Math.min(slot.timer, 0.35) });
      }
      this.activateImpact(slot, notice);
      return;
    }
    slot.queue.push(notice);
    slot.queue.sort((a, b) => b.priority - a.priority);
    if (slot.queue.length > 2) slot.queue.length = 2;
  }

  private activateImpact(slot: ImpactSlot, notice: ImpactNotice): void {
    slot.timer = notice.duration;
    slot.priority = notice.priority;
    slot.active = notice;
    slot.el.dataset.kind = notice.kind;
    slot.el.dataset.lane = notice.lane ?? 'center';
    slot.el.style.setProperty('--impact', css(notice.color));
    slot.el.style.setProperty('--impact-duration', `${notice.duration}s`);
    slot.kicker.textContent = notice.kicker;
    slot.title.textContent = notice.title;
    slot.detail.textContent = notice.detail;
    slot.el.classList.remove('on');
    void slot.el.offsetWidth;
    slot.el.classList.add('on');
  }

  private updateImpact(dt: number, racing: boolean): void {
    for (const slot of this.impactSlots) {
      if (!racing) {
        slot.queue.length = 0;
        slot.timer = 0;
        slot.priority = -1;
        slot.active = null;
        slot.el.classList.remove('on');
        continue;
      }
      if (slot.timer <= 0) continue;
      slot.timer -= dt;
      if (slot.timer > 0) continue;
      slot.el.classList.remove('on');
      const next = slot.queue.shift();
      if (next) this.activateImpact(slot, next);
      else {
        slot.priority = -1;
        slot.active = null;
      }
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

  private updateFinalTarget(racing: boolean): void {
    const guidance = this.course.guidanceStatus();
    if (!racing || !guidance.finalActive) {
      this.finalTargetEl.classList.remove('on');
      return;
    }
    this.course.pointAt(0, this.finalTargetWorld);
    this.finalTargetWorld.y = 6.2;
    this.camera.updateMatrixWorld();
    this.finalTargetCamera.copy(this.finalTargetWorld).applyMatrix4(this.camera.matrixWorldInverse);
    this.finalTargetProjected.copy(this.finalTargetWorld).project(this.camera);
    const inFront = this.finalTargetCamera.z < -0.1;
    const onScreen = inFront && Math.abs(this.finalTargetProjected.x) <= 0.78 &&
      Math.abs(this.finalTargetProjected.y) <= 0.68;
    if (onScreen) {
      this.finalTargetEl.classList.remove('on');
      return;
    }

    let dx = this.finalTargetProjected.x;
    let dy = -this.finalTargetProjected.y;
    if (!inFront) {
      dx = -dx;
      dy = -dy;
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 0.001) {
      dx = 1;
      dy = 0;
    }
    const width = this.root.clientWidth || window.innerWidth;
    const height = this.root.clientHeight || window.innerHeight;
    const halfWidth = Math.max(24, width * 0.5 - Math.min(92, width * 0.12));
    const halfHeight = Math.max(24, height * 0.5 - Math.min(72, height * 0.15));
    const scale = Math.min(
      halfWidth / Math.max(0.001, Math.abs(dx)),
      halfHeight / Math.max(0.001, Math.abs(dy)),
    );
    this.finalTargetEl.style.left = `${width * 0.5 + dx * scale}px`;
    this.finalTargetEl.style.top = `${height * 0.5 + dy * scale}px`;
    this.finalTargetEl.style.setProperty('--final-target-angle', `${Math.atan2(dy, dx)}rad`);
    const distance = `${Math.max(0, Math.round(guidance.finalDistance))}m`;
    if (distance !== this.finalTargetText) {
      this.finalTargetText = distance;
      this.finalTargetDistance.textContent = distance;
    }
    this.finalTargetEl.classList.add('on');
  }

  private mapY(z: number): number {
    return MAP_SIZE / 2 + (z - this.mapCz) * this.mapScale;
  }

  private drawMinimap(player: IBoat, all: IBoat[]): void {
    const m = this.mctx;
    const guidance = this.course.guidanceStatus();
    m.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
    m.drawImage(this.mapBase, 0, 0, MAP_SIZE, MAP_SIZE);
    if (guidance.finalActive) {
      const v = this.mapTemp;
      this.course.pointAt(0, v);
      const x = this.mapX(v.x);
      const y = this.mapY(v.z);
      const pulse = 7 + Math.sin(this.hudTime * 7) * 1.5;
      m.save();
      m.translate(x, y);
      m.rotate(Math.PI / 4);
      m.fillStyle = css(PALETTE.sunFlare);
      m.strokeStyle = PALETTE.inkCss;
      m.lineWidth = 3;
      m.fillRect(-pulse * 0.5, -pulse * 0.5, pulse, pulse);
      m.strokeRect(-pulse * 0.5, -pulse * 0.5, pulse, pulse);
      m.restore();
    } else if (player.state.flightCharges > 0) {
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
