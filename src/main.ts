/**
 * main.ts — integration shell. Wires every subsystem together, owns the
 * game flow (countdown → racing → defeat/loading), and exposes the deterministic
 * screenshot-harness API (?harness=1) used by harness/screenshot.mjs.
 *
 * Step/render split: EVERYTHING that moves updates in step() at fixed
 * SIM_DT (deterministic — the harness can advance the sim with no rendering);
 * render() only draws (prepass + composer).
 */
import * as THREE from 'three';

// Cel pipeline contract: authored palette colors hit the screen verbatim
// (no sRGB→linear→sRGB round trip). Must run before any Color is constructed.
THREE.ColorManagement.enabled = false;

import { Stage, resolveQualityMode } from './core/stage';
import { PrePass } from './core/prePass';
import { Loop, SIM_DT } from './core/loop';
import { Input } from './core/input';
import { LocalMultiplayerInput, type LocalDeviceId, type SeatSide } from './core/localMultiplayerInput';
import { GamepadInput } from './core/gamepadInput';
import { Haptics } from './core/haptics';
import { MobileControls } from './core/mobileControls';
import { ImmersiveModeController } from './core/immersiveMode';
import { TimeOfDayManager, type TimeOfDay } from './core/timeOfDay';
import { NIGHT_PALETTE } from './core/nightPalette';
import { Ocean } from './water/ocean';
import { LighthouseLandmark } from './water/lighthouse';
import { WakeRibbon } from './water/wake';
import { SpraySystem } from './water/spray';
import { FeatherSystem } from './water/feather';
import { waterHeight } from './water/waves';
import { Sky } from './cel/sky';
import { VISIBLE_SUN_DIR } from './cel/toonMaterial';
import { createPostPipeline } from './cel/postPipeline';
import { SplitScreenRenderer } from './core/splitScreenRenderer';
import { Boat } from './game/boat';
import { JetTrailSystem } from './game/jetTrail';
import { Rider } from './game/rider';
import { getFaceTextureCacheSize } from './game/riderMesh';
import { CHECKPOINT_US, Course, GRID_SLOTS, SURFACE_ROUTE_FAIL_DISTANCE_M } from './game/course';
import {
  buildRaceRoster,
  buildDuoRoster,
  driverProfile,
  loadSelectedDriver,
  saveSelectedDriver,
} from './game/racers';
import { RecordsStore } from './game/records';
import {
  DrivingCoach,
  type CoachInputDevice,
  type CoachControls,
  type CoachPresentation,
} from './game/drivingCoach';
import {
  PcControlPrimer,
  type PcControlPrimerPresentation,
} from './game/pcControlPrimer';
import { Race } from './game/race';
import { DuoInteractionController, type DuoInteractionEvent } from './game/duoInteraction';
import {
  HonorLedger,
  HonorTargetSystem,
  HONOR_DEFINITIONS,
  type HonorHit,
} from './game/honors';
import { AIController } from './game/ai';
import { RivalDirector } from './game/rivalDirector';
import { BoatCollisionSystem, type CollisionHit } from './game/collision';
import { TeamExpedition, type TeamExpeditionEvent, type TeamRole } from './game/teamExpedition';
import type { BalloonPop, BuoyHit } from './game/course';
import { CameraRig, type CameraImpactLevel } from './game/chaseCamera';
import { HUD } from './hud/hud';
import { DuoViewportHud, type DuoViewportSeat } from './hud/duoViewportHud';
import { GameAudio } from './audio/audio';
import { MixerControls } from './audio/mixerControls';
import { DriverSelect } from './hud/driverSelect';
import { OpeningShowcase } from './hud/openingShowcase';
import { RaceTower } from './hud/raceTower';
import { FinaleOverlay } from './hud/finaleOverlay';
import { ExpansionGallery } from './hud/expansionGallery';
import {
  CaptureService,
  type CaptureExportAction,
  type CaptureExportOutcome,
} from './core/capture';
import { CapturePreview } from './hud/capturePreview';
import { HonorHighlights } from './hud/honorHighlights';
import {
  TeamExperience,
  loadTeamSave,
  saveTeamProgress,
  type DuoSelection,
  type TeamSelection,
} from './hud/teamExperience';
import { trackGameEvent } from './game/eventLog';
import {
  LAYER_ENERGY,
  LAYER_GUIDE_LEFT,
  LAYER_GUIDE_RIGHT,
  LAYER_INK,
  MAX_FLIGHT_CHARGES,
  type BoatInput,
  type ChallengeResult,
  type ChallengeTier,
  type CourseSample,
  type FlightFailureSnapshot,
  type FlightRouteState,
  type PlayerSeat,
  type RaceResultEnvelope,
  type RaceView,
} from './contracts';
import { deriveAbilityHudState } from './core/abilityTelemetry';

const params = new URLSearchParams(location.search);
const HARNESS = import.meta.env.DEV && params.has('harness');
const DESKTOP_DRIVER_STAGE = window.matchMedia('(pointer: fine) and (min-width: 1366px) and (min-height: 768px)');
const harnessEndlessMode = HARNESS;
const timeOfDayManager = new TimeOfDayManager(params.get('tod'));
type AppMode = 'front-door' | 'independent' | 'duo' | 'team-play';
let appMode: AppMode = 'front-door';

// ------------------------------------------------------------ construction
const app = document.getElementById('app')!;
const stage = new Stage(app, resolveQualityMode(params.get('quality')));
const prePass = new PrePass(4, 4);

const sky = new Sky();
stage.scene.add(sky.object);

const ocean = new Ocean({
  depthTexture: prePass.depthTexture,
  cameraNear: stage.camera.near,
  cameraFar: stage.camera.far,
  quality: stage.quality.mode,
});
stage.scene.add(ocean.object);
sky.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
ocean.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
const lighthouse = new LighthouseLandmark();
stage.scene.add(lighthouse.object);

const spray = new SpraySystem(stage.quality.mode);
spray.object.name = 'spray-system';
stage.scene.add(spray.object);

const feathers = new FeatherSystem();
feathers.object.name = 'feather-system';
stage.scene.add(feathers.object);

const jetTrail = new JetTrailSystem();
stage.scene.add(jetTrail.object);

const course = new Course();
stage.scene.add(course.object);
const honorTargets = new HonorTargetSystem(course);
stage.scene.add(honorTargets.object);
course.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
honorTargets.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
const records = new RecordsStore();
const drivingCoach = new DrivingCoach(records.data.coach, (progress) => records.saveCoach(progress));
const pcControlPrimer = new PcControlPrimer();
let selectedDriverId = loadSelectedDriver();
let roster = buildRaceRoster(selectedDriverId);
let activeDuoSelection: DuoSelection | null = null;
const duoDevices: [LocalDeviceId, LocalDeviceId] = [
  'keyboard-left', 'keyboard-right',
];
const duoEliminated = [false, false];
const comebackAwarded = [false, false];
const previousHumanPlaces = [Infinity, Infinity];
const maxCorridorDangerThisFlight = [0, 0];
const airBrakedThisFlight = [false, false];
const maxDriftYawRateThisDrift = [0, 0];
const leadDominanceTimer = [0, 0];
const leadDominanceAwarded = [false, false];

// Boats + riders + wakes. Boat 0 is the player.
const boats: Boat[] = [];
const riders: Rider[] = [];
const wakes: WakeRibbon[] = [];
for (const racer of roster) {
  const detailedInk = racer.id === 0 || stage.quality.detailedAiInk;
  const wake = new WakeRibbon();
  wake.object.name = `wake-${racer.id}`;
  stage.scene.add(wake.object);
  wakes.push(wake);
  const boat = new Boat({ id: racer.id, color: racer.color, wake, spray, trail: jetTrail, detailedInk });
  boat.setDriver(racer.color, driverProfile(racer.profileId).handling);
  stage.scene.add(boat.object);
  boats.push(boat);
  const rider = new Rider({
    color: racer.color,
    detailedInk,
    look: driverProfile(racer.profileId).look,
    phase: racer.id * 2.399,
  });
  boat.riderMount.add(rider.object);
  riders.push(rider);
}

const rivalDirector = new RivalDirector();
rivalDirector.setRoster(roster);
let ais = buildAiControllers();
const collisions = new BoatCollisionSystem();
const duoInteractions = new DuoInteractionController();
stage.scene.add(duoInteractions.object);
const honors = new HonorLedger(boats.length);

const cameraRig = new CameraRig(stage.camera);
const teamLeftCamera = new THREE.PerspectiveCamera(stage.camera.fov, 1, stage.camera.near, stage.camera.far);
const teamRightCamera = new THREE.PerspectiveCamera(stage.camera.fov, 1, stage.camera.near, stage.camera.far);
// The 50/50 viewport is substantially narrower than independent play. Keep a
// dedicated composition profile so both the boat and the next station remain
// readable without changing the independent chase camera.
const TEAM_CAMERA_TUNING = {
  chaseBack: 16,
  chaseUp: 4.8,
  chaseMinDistance: 12,
  lookAhead: 8.5,
  fovBias: 4,
} as const;
const teamLeftCameraRig = new CameraRig(teamLeftCamera, TEAM_CAMERA_TUNING);
const teamRightCameraRig = new CameraRig(teamRightCamera, TEAM_CAMERA_TUNING);
const audio = new GameAudio();
window.addEventListener('keydown', () => {
  audio.resume();
  audio.startReadyMusic();
});
window.addEventListener('pointerdown', () => {
  audio.resume();
  audio.startReadyMusic();
}, { passive: true });

const hudLayer = document.createElement('div');
hudLayer.id = 'hud-layer';
hudLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;';
app.appendChild(hudLayer);
const duoViewportHud = new DuoViewportHud(hudLayer);
const capture = new CaptureService(stage.renderer.domElement);
let finaleCapture: Blob | null = null;
let finaleCaptureRecorded = false;
let captureOverlayVisible = false;
const immersive = new ImmersiveModeController(
  app,
  params.has('mobile') || navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches,
);
const mobileInput = new MobileControls(app, () => {
  audio.resume();
  audio.startReadyMusic();
}, params.has('mobile'), immersive);
const hud = new HUD(
  hudLayer,
  course,
  requestRetry,
  records.data.bestFlights,
  resumeInterruption,
  stage.camera,
  openMedalGallery,
  disableDrivingCoach,
  dismissPcControlPrimer,
  (mode: 'launch' | 'extend') => mode === 'extend'
    ? !drivingCoach.progress.mastery.extendedFlight
    : !drivingCoach.progress.mastery.launched,
);
const mixer = new MixerControls(app, audio);
const tower = new RaceTower(hudLayer);
// Split play gives each seat its own tower, its own standings highlight and
// its own radio slot. The second tower stays hidden in solo play.
const towerRight = new RaceTower(hudLayer, 'right');
const towers: RaceTower[] = [tower, towerRight];
const soloTowers: RaceTower[] = [tower];
tower.setSeat(0);
towerRight.setSeat(1);
towerRight.setVisible(false);

/** Re-place the towers when the run switches between solo and split play. */
function applyTowerSeats(): void {
  const duo = isDuoMode();
  tower.setSide(duo ? 'left' : 'solo');
  tower.setSeat(0);
  towerRight.setSide('right');
  towerRight.setSeat(1);
  for (const entry of towers) entry.setRoster(roster);
  if (!duo) towerRight.setVisible(false);
}

/** Only the seats that are actually playing own a tower. Preallocated: this
 *  runs inside the fixed step. */
function activeTowers(): RaceTower[] {
  return isDuoMode() ? towers : soloTowers;
}

for (const entry of towers) entry.setRoster(roster);
const driverSelect = new DriverSelect(
  hudLayer,
  selectedDriverId,
  (profile, index, direction) => {
    audio.resume();
    audio.startReadyMusic();
    audio.driverSelected(index, direction);
    applySelectedDriver(profile.id);
  },
  requestFreshStart,
  () => {
    audio.resume();
    audio.startReadyMusic();
  },
  toggleDrivingCoach,
);
const openingShowcase = new OpeningShowcase(hudLayer, stage.camera, stage.renderer.domElement, boats, roster);
const finale = new FinaleOverlay(
  hudLayer,
  continueAfterFinale,
  openExpansionGallery,
  openFinaleCapturePreview,
  skipFinaleExtras,
);
const capturePreview = new CapturePreview(
  hudLayer,
  capture,
  handleCaptureOutcome,
  setCaptureOverlayVisible,
  restoreMobileImmersiveFromCaptureGesture,
);
const honorHighlights = new HonorHighlights(
  hudLayer,
  () => {
    continueAfterHonorReview();
  },
  () => {
    dismissHonorReview();
  },
  () => {
    honorHighlights.hide();
    enterFrontDoor();
  },
);
const expansionGallery = new ExpansionGallery(
  hudLayer,
  (index) => records.markExpansionSeen(index),
  () => {
    // Returning from the dossier restores the frozen presentation, not gameplay.
    // Keep touch controls out of the result composition until a new run begins.
    mobileInput.setOverlayHidden(true);
    if (race.phase !== 'medal') {
      // The certificate's countdown must start over: it was parked while the
      // player was reading the gallery, not running out behind their back.
      finale.resetAutoAdvance();
      if (honorReviewPending) finale.focusContinue();
      else finale.focusPrimary();
    }
  },
);

const input = new Input();
const localInput = new LocalMultiplayerInput();
const gamepadInput = new GamepadInput();
let activeInputDevice: CoachInputDevice = mobileInput.enabled ? 'mobile' : 'keyboard';
const haptics = new Haptics(gamepadInput, () => activeInputDevice);
// Split play gives the right seat its own coordinator so its cues fire on the
// controller that player is holding, not on the primary seat's device.
const hapticsRight = new Haptics(
  gamepadInput,
  () => (duoDevices[1].startsWith('gamepad:') ? 'gamepad' : 'keyboard'),
  (strong, weak, durationMs) => localInput.rumble(duoDevices[1], strong, weak, durationMs),
);
const seatHaptics = [haptics, hapticsRight];
let lastKeyboardActivity = input.activitySerial;
let lastGamepadActivity = gamepadInput.activitySerial;
let lastMobileActivity = mobileInput.activitySerial;
let coachPresentation: CoachPresentation | null = null;
let pcPrimerPresentation: PcControlPrimerPresentation | null = null;
mixer.attachHaptics(() => haptics.enabled, (enabled) => haptics.setEnabled(enabled));
mixer.attachCameraImpact(
  () => cameraRig.getCollisionImpactLevel(),
  (level) => cameraRig.setCollisionImpactLevel(level),
);
const pipeline = createPostPipeline(
  stage.renderer, stage.scene, stage.camera, prePass, stage.quality,
  { guideLayer: LAYER_GUIDE_LEFT, energyLayer: LAYER_GUIDE_LEFT + 2 },
);
const teamLeftPrePass = new PrePass(4, 4);
const teamRightPrePass = new PrePass(4, 4);
const teamLeftPipeline = createPostPipeline(
  stage.renderer, stage.scene, teamLeftCamera, teamLeftPrePass, stage.quality,
  { guideLayer: LAYER_GUIDE_LEFT, energyLayer: LAYER_GUIDE_LEFT + 2 },
);
const teamRightPipeline = createPostPipeline(
  stage.renderer, stage.scene, teamRightCamera, teamRightPrePass, stage.quality,
  { guideLayer: LAYER_GUIDE_RIGHT, energyLayer: LAYER_GUIDE_RIGHT + 2 },
);
const splitScreen = new SplitScreenRenderer(stage.renderer);
stage.onResize((w, h, pr) => {
  pipeline.setSize(w, h, pr);
  prePass.setSize(w * pr, h * pr);
  const halfW = Math.max(1, Math.floor(w / 2));
  teamLeftCamera.aspect = halfW / h;
  teamRightCamera.aspect = halfW / h;
  teamLeftCamera.updateProjectionMatrix();
  teamRightCamera.updateProjectionMatrix();
  teamLeftPipeline.setSize(halfW, h, pr);
  teamRightPipeline.setSize(halfW, h, pr);
  teamLeftPrePass.setSize(halfW * pr, h * pr);
  teamRightPrePass.setSize(halfW * pr, h * pr);
  ocean.setResolution(w * pr, h * pr, stage.camera.fov);
});

let teamSave = loadTeamSave();
let activeTeamSelection: TeamSelection | null = null;
let teamPaused = false;
const teamExpedition = new TeamExpedition(course, boats, wakes, handleTeamEvent);
stage.scene.add(teamExpedition.visuals.object);
const teamExperience = new TeamExperience(hudLayer, {
  onSingle: enterIndependentCompetition,
  onDuoStart: startDuoRace,
  onReplayDuo: replayTeamWithSwappedRoles,
  onExitDuo: enterFrontDoor,
  onAudioIntent: () => {
    audio.resume();
    audio.startReadyMusic();
  },
});
teamExperience.setSavedStage(teamSave.stage, teamSave.completed, teamSave.tutorialCompleted);
teamExperience.setSavedDrivers(teamSave.leftDriverId, teamSave.rightDriverId);

// -------------------------------------------------------------- race events
let resultsShown = false;
let honorsSettled = false;
const DEFEAT_FREEZE_S = 0.35;
const FAILURE_REVIEW_AUTO_S = 5;
const FAILURE_REVIEW_MIN_READ_S = 1.15;
const MEDAL_CEREMONY_S = 6.5;
const MEDAL_MIN_READ_S = 4.5;
const FINALE_REVEAL_S = 4.8;
const FINALE_MIN_READ_S = 3.2;
const FINALE_CAMERA_HERO_S = 0.75;
const FINALE_CAPTURE_S = 0.78;
let retryLessonActive = false;
let retryLessonToHonorReview = false;
let retryLessonTimer = 0;
let retryLessonDuration = 0;
let retryLessonElapsed = 0;
let retryLessonMinRead = 0;
let retryLessonFrozenT = 0;
let defeatFreezeTimer = 0;
let pendingFailureNewBest = false;
let newBestThisRun = false;
let medalEarnedThisRun = false;
let ordinaryNewThisRun = false;
let excellentRecordedThisRun = false;
let previousChallengeTier: ChallengeTier = 'unqualified';
let currentRun = 0;
let lastResultEnvelope: RaceResultEnvelope | null = null;
let worldTime = 0;
let presentationTime = 0;
const OPENING_SHOWCASE_S = 3.6;
let freshStartPending = false;
let medalElapsed = 0;
let finaleElapsed = 0;
let finalePresentation = false;
// Keep the result beats separate: the honor wall is opened only after the
// Final Station cinematic has been dismissed.
let honorReviewPending = false;
let finaleCapturePending = false;
let interruptionActive = false;
let duoPauseActive = false;
let pageWasHidden = false;
let interruptionNeedsCountdown = false;
const retryReasonCounts = new Map<string, number>();
/**
 * Previous-frame snapshot for one human seat. Split play needs one per seat:
 * a single snapshot keyed to the primary seat is why the second player's gates,
 * landings and buffs used to be completely silent.
 */
interface SeatEdges {
  flightCharges: number;
  driftReleaseReady: boolean;
  flightGateProgress: number;
  flightRouteState: typeof boats[0]['state']['flightRouteState'];
  flightPhase: typeof boats[0]['state']['flightPhase'];
  boosting: boolean;
  airBraking: boolean;
  drifting: boolean;
  turnWarning: boolean;
}

const emptySeatEdges = (): SeatEdges => ({
  flightCharges: 0,
  driftReleaseReady: false,
  flightGateProgress: 0,
  flightRouteState: 'idle',
  flightPhase: 'surface',
  boosting: false,
  airBraking: false,
  drifting: false,
  turnWarning: false,
});

const seatEdges: SeatEdges[] = [emptySeatEdges(), emptySeatEdges()];
const SOLO_FEEDBACK_SEATS = [0];
const DUO_FEEDBACK_SEATS = [0, 1];
let prevCorridorStage = 0;
let harnessCheckpointEvents = 0;
let harnessCollisionFxBursts = 0;
const humanCollisionCounts = [0, 0];
// Per-racer coin pickup streak. A pickup within COIN_STREAK_WINDOW seconds
// of the previous pickup grows the streak; otherwise it resets to 1. The
// streak drives both the bonus point value on the honor ledger and the
// pitch ladder of the metallic chime, so a run that threads multiple
// pickups reads as a single escalating pickup arc.
const coinStreakCounts: number[] = [];
const coinStreakTimes: number[] = [];
const COIN_BASE_VALUE = 130;
const COIN_STREAK_BONUS = 45;
const COIN_STREAK_MAX = 6;
const COIN_STREAK_WINDOW = 4.5;
let harnessRoutePilotIndex = -1;
const harnessRoutePasses = new Array<number>(boats.length).fill(0);
const harnessRouteFails = new Array<number>(boats.length).fill(0);
const harnessPrevRouteStates: FlightRouteState[] = boats.map((boat) => boat.state.flightRouteState);
const routeLifecycleStates: FlightRouteState[] = boats.map((boat) => boat.state.flightRouteState);
const activeBoatScratch: Boat[] = [];
const honorHitScratch: HonorHit[] = [];
const honorFxPoint = new THREE.Vector3();
const resetGridPoint = new THREE.Vector3();
const resetGridTangent = new THREE.Vector3();

const race = new Race(course, boats, {
  countdownTick: (n) => {
    audio.countdownStage(n);
    audio.countdownBeep(false);
  },
  go: (resuming) => {
    audio.setScene('racing');
    const signaled = audio.startSignal() === 'played';
    if (!signaled) audio.countdownBeep(true);
    cameraRig.mode = 'chase';
    const goTowers = activeTowers();
    for (let seat = 0; seat < goTowers.length; seat++) goTowers[seat].announceGo(roster[seat].name);
    if (!resuming && !drivingCoach.progress.mastery.airBrakedInTurn) tower.announceTechniqueTip();
  },
  lapDone: () => {},
  checkpoint: () => {
    if (HARNESS) harnessCheckpointEvents++;
  },
  finish: (r) => {
    course.pulseFinalStation();
    if (r.isPlayer) {
      audio.finishSting();
      if (isDuoMode() && r.id < 2) localInput.rumble(duoDevices[r.id as 0 | 1], 0.34, 0.52, 58);
    }
  },
  courseWarning: (r, warning) => {
    if (r.isPlayer && warning !== 'none') {
      if (isDuoMode() && r.id < 2) localInput.rumble(duoDevices[r.id as 0 | 1], 0.18, 0.32, 28);
      else haptics.cue('warning');
    }
  },
  battle: (event) => {
    hud.showBattle(event);
    cameraRig.raceBattleKick(event.kind, event.opponents.length);
    audio.raceBattle(event.kind, event.opponents.length, event.toPlace);
    pipeline.pulse(event.kind, Math.min(1.35, 0.95 + event.opponents.length * 0.12));
    rivalDirector.notifyBattle();
    tower.announceBattle(event);
    if (event.kind === 'overtake') {
      const racerId = race.player().id;
      if (isHumanRacer(racerId)) {
        honors.award('overtake.artist', racerId, HONOR_DEFINITIONS['overtake.artist'].value, race.raceTime);
      }
    }
  },
  eliminated: (racer, failure) => {
    if (isDuoMode() && racer.id < 2) presentDuoElimination(racer.id, failure);
  },
}, roster);
race.setPlayerIds([0]);

function buildAiControllers(): AIController[] {
  return roster.map((racer) => new AIController(
    racer.personality,
    course,
    1000 + racer.id * 77,
    racer.pace,
    racer.lane,
    rivalDirector.isElite(racer.id),
  ));
}

function applySelectedDriver(id: string): void {
  if (race.phase !== 'ready') return;
  selectedDriverId = driverProfile(id).id;
  saveSelectedDriver(selectedDriverId);
  roster = buildRaceRoster(selectedDriverId);
  rivalDirector.setRoster(roster);
  for (const definition of roster) {
    const profile = driverProfile(definition.profileId);
    boats[definition.id].setDriver(definition.color, profile.handling);
    riders[definition.id].setColor(definition.color, profile.look);
    riders[definition.id].update(1 / 60, boats[definition.id].state, presentationTime);
  }
  ais = buildAiControllers();
  race.setDefinitions(roster);
  for (const entry of towers) entry.setRoster(roster);
  openingShowcase.setRoster(roster);
  // Selection already happens on a frozen READY grid. Updating the six
  // definitions in place keeps the portrait reveal and its audio
  // transient alive; a full reset here would unnecessarily rebuild the
  // presentation state on every tap.
}

function queueFreshStart(): void {
  if (race.phase !== 'ready' || freshStartPending) return;
  freshStartPending = true;
  // The authored opening is already the active run's immersive phase. This
  // keeps a rejected desktop fullscreen request recoverable while the
  // presentation is still holding input before the countdown.
  immersive.setPhase('active');
  openingShowcase.start(OPENING_SHOWCASE_S);
  ocean.setOpeningIntensity(1);
  sky.setOpeningIntensity(1);
  // The opening owns the whole visual stage; keep the READY sound utility
  // from intercepting the immersive recovery affordance in the corner.
  mixer.setVisible(false);
  driverSelect.setLaunchPending(true);
}

function requestFreshStart(): void {
  if (mobileInput.enabled) {
    mobileInput.requestGo();
    queueFreshStart();
  } else {
    immersive.requestGo();
    queueFreshStart();
  }
}

function toggleDrivingCoach(): void {
  if (drivingCoach.progress.status === 'active') drivingCoach.disable();
  else {
    pcControlPrimer.stop();
    pcPrimerPresentation = null;
    hud.showPcControlPrimer(null);
    drivingCoach.enable();
  }
  syncDrivingCoachUi();
}

function dismissPcControlPrimer(): void {
  pcControlPrimer.dismiss();
  drivingCoach.dismissPcPrimer();
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
}

function disableDrivingCoach(): void {
  drivingCoach.disable();
  syncDrivingCoachUi();
  if (retryLessonActive) resetRace();
}

function syncDrivingCoachUi(): void {
  driverSelect.setCoachStatus(drivingCoach.progress.status);
  if (drivingCoach.progress.status !== 'active') {
    coachPresentation = null;
    hud.showCoach(null);
  }
}

function enterIndependentCompetition(): void {
  teamExpedition.stop();
  course.setTeamPresentation(false);
  localInput.reset();
  collisions.setFriendlyPair(0, 1, false);
  activeTeamSelection = null;
  teamPaused = false;
  appMode = 'independent';
  honorTargets.object.visible = true;
  resetRace();
  applySelectedDriver(selectedDriverId);
  race.setPlayerIds([0]);
  for (let i = 0; i < boats.length; i++) boats[i].setPlayerOwned(i === 0);
  activeDuoSelection = null;
  teamExperience.hideAll();
  hud.setVisible(true);
  hud.setDuoControls(false);
  hud.setDuoSplit(false);
  applyTowerSeats();
  duoViewportHud.setVisible(false);
  for (const entry of activeTowers()) entry.setVisible(true);
  mixer.setVisible(!mobileInput.enabled);
  mobileInput.setOverlayHidden(false);
}

/** Start a competitive local double race on the same six-racer simulation. */
function startDuoRace(selection: DuoSelection): void {
  if (race.phase !== 'ready') return;
  // The archived expedition can leave its station visuals armed after a
  // back-navigation. A dual race owns the normal six-racer simulation, then
  // renders it through the two dedicated left/right cameras below.
  teamExpedition.stop();
  course.setTeamPresentation(false);
  activeTeamSelection = null;
  teamPaused = false;
  activeDuoSelection = selection;
  appMode = 'duo';
  honorTargets.object.visible = true;
  duoDevices[0] = selection.left.deviceId;
  duoDevices[1] = selection.right.deviceId;
  duoEliminated[0] = false;
  duoEliminated[1] = false;
  roster = buildDuoRoster(selection.left.profile.id, selection.right.profile.id);
  rivalDirector.setRoster(roster);
  for (const definition of roster) {
    const profile = driverProfile(definition.profileId);
    boats[definition.id].setDriver(definition.color, profile.handling);
    boats[definition.id].setPlayerOwned(definition.isPlayer);
    riders[definition.id].setColor(definition.color, profile.look);
    riders[definition.id].update(1 / 60, boats[definition.id].state, presentationTime);
  }
  // setDefinitions is legal in READY and resets the six racer states while
  // preserving the authored grid positions; the explicit player list then
  // promotes seat 2 when seat 1 is eliminated.
  race.setDefinitions(roster);
  race.setPlayerIds([0, 1]);
  for (const entry of towers) entry.setRoster(roster);
  openingShowcase.setRoster(roster);
  collisions.setFriendlyPair(0, 1, false);
  resetRace();
  teamLeftCameraRig.mode = 'chase';
  teamRightCameraRig.mode = 'chase';
  driverSelect.hide();
  teamExperience.hideAll();
  hud.setVisible(true);
  hud.setDuoControls(true, selection.left.deviceId, selection.right.deviceId);
  hud.setDuoSplit(true);
  hud.setDuoSeatCameras(teamLeftCamera, teamRightCamera);
  applyTowerSeats();
  for (const entry of activeTowers()) entry.setVisible(true);
  mixer.setVisible(false);
  mobileInput.setOverlayHidden(true);
  audio.startReadyMusic();
  // The selection screen has already supplied the confirming gesture. Start
  // the same authored opening/countdown used by single mode without another
  // hidden station or role tutorial.
  startFreshCountdown();
}

function enterFrontDoor(): void {
  teamExpedition.stop();
  course.setTeamPresentation(false);
  localInput.reset();
  collisions.setFriendlyPair(0, 1, false);
  activeTeamSelection = null;
  teamPaused = false;
  appMode = 'front-door';
  honorTargets.object.visible = false;
  resetRace();
  applySelectedDriver(selectedDriverId);
  race.setPlayerIds([0]);
  driverSelect.hide();
  hud.setVisible(false);
  hud.setDuoControls(false);
  for (const entry of activeTowers()) entry.setVisible(false);
  mixer.setVisible(false);
  mobileInput.setOverlayHidden(true);
  teamSave = loadTeamSave();
  teamExperience.setSavedStage(teamSave.stage, teamSave.completed, teamSave.tutorialCompleted);
  teamExperience.setSavedDrivers(teamSave.leftDriverId, teamSave.rightDriverId);
  teamExperience.showMode();
  audio.setScene('ready');
}

function startTeamExpedition(selection: DuoSelection): void {
  activeTeamSelection = selection;
  appMode = 'team-play';
  honorTargets.object.visible = false;
  teamSave = {
    ...teamSave,
    version: 2,
    stage: selection.playTutorial ? 0 : selection.resumeStation === 0 ? 1 : Math.max(1, teamSave.stage),
    completed: teamSave.completed,
    leftDriverId: selection.left.profile.id,
    rightDriverId: selection.right.profile.id,
  };
  saveTeamProgress(teamSave);
  teamExperience.setSavedStage(teamSave.stage, teamSave.completed, teamSave.tutorialCompleted);
  resetRace();
  course.setTeamPresentation(true);
  const profiles = [selection.left.profile, selection.right.profile] as const;
  for (let id = 0; id < 2; id++) {
    const profile = profiles[id];
    boats[id].setDriver(profile.color, profile.handling);
    riders[id].setColor(profile.color, profile.look);
  }
  driverSelect.hide();
  openingShowcase.stop();
  hud.setVisible(false);
  for (const entry of activeTowers()) entry.setVisible(false);
  mixer.setVisible(false);
  mobileInput.setOverlayHidden(true);
  collisions.setFriendlyPair(0, 1, true);
  teamPaused = false;
  localInput.reset();
  teamLeftCameraRig.mode = 'chase';
  teamRightCameraRig.mode = 'chase';
  teamExpedition.start({
    resumeStation: selection.resumeStation,
    playTutorial: selection.playTutorial,
    swapRoles: selection.swapRoles,
    leftDeviceId: selection.left.deviceId,
    rightDeviceId: selection.right.deviceId,
  });
  teamExperience.showGameplay();
  const snapshot = teamExpedition.snapshot();
  teamExperience.showTransition(
    snapshot.tutorialActive ? 'CONTROL CALIBRATION' : 'TEAM CO-OP',
    snapshot.stationName,
    snapshot.tutorialActive ? teamCalibrationIntro(snapshot) : teamStationIntro(snapshot),
    3.2,
  );
  audio.startRaceScore(true);
  audio.setScene('countdown');
}

function replayTeamWithSwappedRoles(): void {
  if (!activeTeamSelection) return;
  startTeamExpedition({
    ...activeTeamSelection,
    resumeStation: 0,
    playTutorial: false,
    swapRoles: !activeTeamSelection.swapRoles,
  });
}

function handleTeamEvent(event: TeamExpeditionEvent): void {
  if (!activeTeamSelection) return;
  const device = event.side ? teamExpedition.deviceFor(event.side) : null;
  if (event.type === 'countdown') {
    audio.countdownStage(event.value ?? 1);
    audio.countdownBeep(false);
  } else if (event.type === 'go') {
    teamExperience.hideTransition();
    audio.setScene('racing');
    if (audio.startSignal() !== 'played') audio.countdownBeep(true);
  } else if (event.type === 'tutorial') {
    teamSave.tutorialCompleted = true;
    saveTeamProgress(teamSave);
    teamExperience.setSavedStage(teamSave.stage, teamSave.completed, teamSave.tutorialCompleted);
    teamExperience.showTransition('CALIBRATION COMPLETE', '驾驶已校准', teamStationIntro(teamExpedition.snapshot()), 2);
  } else if (event.type === 'send') {
    audio.flightReady(1);
    if (event.side) audio.teamSpatialCue(event.side, 'ready');
    if (device) localInput.rumble(device, 0.2, 0.58, 54);
  } else if (event.type === 'catch' || event.type === 'lock') {
    audio.routeClear(Math.min(3, event.value ?? 1));
    if (event.side) audio.teamSpatialCue(event.side, event.type === 'catch' ? 'anchor' : 'relay');
    teamLeftPipeline.pulse('ready', 0.42);
    teamRightPipeline.pulse('ready', 0.42);
    if (device) localInput.rumble(device, 0.32, 0.68, 64);
  } else if (event.type === 'miss') {
    audio.flightMiss();
    if (event.side) {
      audio.teamSpatialCue(event.side, 'impact');
      (event.side === 'left' ? teamLeftPipeline : teamRightPipeline).pulse('lost', 0.58);
    }
    if (device) localInput.rumble(device, 0.72, 0.3, 84);
  } else if (event.type === 'gate') {
    audio.flightGate(3);
    if (event.side) audio.teamSpatialCue(event.side, 'gate');
    teamLeftPipeline.pulse('gate', 0.72);
    teamRightPipeline.pulse('gate', 0.72);
    if (device) localInput.rumble(device, 0.48, 0.78, 76);
  } else if (event.type === 'recover') {
    audio.flightMiss();
    if (event.shared || event.side === 'left') teamLeftPipeline.pulse('lost', event.shared ? 0.72 : 0.42);
    if (event.shared || event.side === 'right') teamRightPipeline.pulse('lost', event.shared ? 0.72 : 0.42);
    if (event.side) audio.teamSpatialCue(event.side, 'impact');
    if (event.shared) {
      teamExperience.showTransition('QUICK RETRY', '回到起飞前', '飞行门和两艘艇已一起复位', 1.05);
    } else if (device) localInput.rumble(device, 0.65, 0.24, 72);
  } else if (event.type === 'station') {
    teamSave = {
      ...teamSave,
      stage: Math.max(teamSave.stage, event.value ?? event.station),
      leftDriverId: activeTeamSelection.left.profile.id,
      rightDriverId: activeTeamSelection.right.profile.id,
    };
    saveTeamProgress(teamSave);
    teamExperience.setSavedStage(teamSave.stage, teamSave.completed, teamSave.tutorialCompleted);
    if (event.station < 3) teamExperience.showTransition(
      `STATION ${event.station} CLEAR`,
      event.station === 1 ? '锚芯装配完成' : '水闸贯通',
      event.station === 1 ? '下一站轮流稳门与穿门' : '下一站一人飞行、一人控制真实飞行门',
      1.35,
    );
  } else if (event.type === 'finish') {
    const elapsed = event.value ?? teamExpedition.snapshot().elapsed;
    const elapsedMs = Math.round(elapsed * 1000);
    const fullRun = teamExpedition.snapshot().fullRun;
    if (fullRun && (teamSave.bestMs === null || elapsedMs < teamSave.bestMs)) teamSave.bestMs = elapsedMs;
    teamSave.stage = 3;
    teamSave.completed = true;
    teamSave.leftDriverId = activeTeamSelection.left.profile.id;
    teamSave.rightDriverId = activeTeamSelection.right.profile.id;
    saveTeamProgress(teamSave);
    teamExperience.setSavedStage(teamSave.stage, teamSave.completed, teamSave.tutorialCompleted);
    teamExperience.showTransition(
      'CO-OP COMPLETE',
      '三站协作完成',
      `${formatTeamTime(elapsed)}${fullRun && teamSave.bestMs === elapsedMs ? ' · NEW BEST' : ''}`,
      0,
      true,
      true,
    );
    audio.finishSting();
    audio.setScene('medal');
    teamLeftPipeline.pulse('finish', 1.2);
    teamRightPipeline.pulse('finish', 1.2);
  }
}

function teamCalibrationIntro(snapshot: ReturnType<TeamExpedition['snapshot']>): string {
  const singleStick = snapshot.left.actionLabel.includes('左摇杆') || snapshot.right.actionLabel.includes('左摇杆');
  const steering = singleStick ? '同一根左摇杆左右转向，斜向同时生效' : '左右转向与前进可同时按住';
  return `前进：${snapshot.left.actionLabel} / ${snapshot.right.actionLabel} · ${steering} · 光圈内松开输入会自动稳船`;
}

function teamStationIntro(snapshot: ReturnType<TeamExpedition['snapshot']>): string {
  if (snapshot.station === 1) {
    const leftTool = snapshot.left.role === 'sender' ? '冲击锤' : '锚钉机';
    const rightTool = snapshot.right.role === 'sender' ? '冲击锤' : '锚钉机';
    return `蓝席${leftTool}：${snapshot.left.actionLabel} · 黄席${rightTool}：${snapshot.right.actionLabel} · 锚先锁、锤后击`;
  }
  if (snapshot.station === 2) return '绞盘手进圈按住能力键 · 突进手等门升起后向前穿过实体闸门';
  return '门控手进圈按住能力键并左右移门 · 飞行员到入口按起飞键';
}

function formatTeamTime(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const rest = Math.max(0, seconds) - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

function updateActiveInputDevice(): void {
  const keyboardSerial = input.activitySerial;
  const gamepadSerial = gamepadInput.activitySerial;
  const mobileSerial = mobileInput.activitySerial;
  if (keyboardSerial !== lastKeyboardActivity) activeInputDevice = 'keyboard';
  else if (gamepadSerial !== lastGamepadActivity) activeInputDevice = 'gamepad';
  else if (mobileSerial !== lastMobileActivity) activeInputDevice = 'mobile';
  lastKeyboardActivity = keyboardSerial;
  lastGamepadActivity = gamepadSerial;
  lastMobileActivity = mobileSerial;
  const labels = activeCoachControls();
  hud.setControlDevice(activeInputDevice, labels);
}

function activeCoachControls(): CoachControls {
  if (activeInputDevice === 'gamepad') return gamepadInput.controlLabels();
  if (activeInputDevice === 'mobile') return mobileInput.controlLabels();
  return { steer: 'A / D', drift: 'SHIFT', flight: 'SPACE' };
}

function requestRetry(): void {
  if (race.phase === 'medal') {
    if (medalElapsed >= MEDAL_MIN_READ_S && !expansionGallery.visible()) startResumeCountdown();
    return;
  }
  if (retryLessonActive) {
    if (retryLessonElapsed >= retryLessonMinRead) completeRetryLesson();
    return;
  }
  if (race.phase === 'finished' || race.phase === 'defeated') {
    if (isDuoMode() && activeDuoSelection) {
      const selection = activeDuoSelection;
      resetRace();
      startDuoRace(selection);
    } else {
      resetRace();
    }
  }
}

function dismissHonorReview(): void {
  honorHighlights.hide();
  hud.setVisible(true);
  for (const entry of activeTowers()) entry.setVisible(true);
  requestRetry();
}

function resumeInterruption(): void {
  if (!interruptionActive || document.hidden) return;
  const wasDuoPause = duoPauseActive;
  duoPauseActive = false;
  interruptionActive = false;
  stopInterruptionPadPoll();
  input.reset();
  localInput.reset();
  gamepadInput.reset();
  haptics.stop();
  mobileInput.reset();
  hud.hideInterruption();
  if (interruptionNeedsCountdown && race.restartAfterInterruption()) {
    audio.startRaceScore(false);
    audio.setScene('countdown');
  } else {
    // Visibility interruptions already restore the prior audio scene in
    // `setVisibility`; only a manually-created dual pause needs an explicit
    // scene restore here.
    if (wasDuoPause) audio.setScene(race.phase === 'racing' ? 'racing' : 'ready');
    audio.resume();
  }
  interruptionNeedsCountdown = false;
  if (!HARNESS) loop.start();
}

function beginDuoPause(reason = ''): void {
  if (!isDuoMode() || interruptionActive ||
      !['racing', 'countdown', 'resume-countdown'].includes(race.phase)) return;
  duoPauseActive = true;
  interruptionActive = true;
  interruptionNeedsCountdown = true;
  // A pause is a lifecycle boundary: held movement and action edges must be
  // released before either seat can drive again after the resume countdown.
  input.reset();
  localInput.reset();
  gamepadInput.reset();
  mobileInput.reset();
  mobileInput.setControlPhase('inactive');
  haptics.stop();
  audio.setScene('hidden');
  hud.showInterruption(true, reason);
}

function exitDuoPause(): void {
  if (!duoPauseActive) return;
  duoPauseActive = false;
  interruptionActive = false;
  interruptionNeedsCountdown = false;
  stopInterruptionPadPoll();
  enterFrontDoor();
}

function startFreshCountdown(): void {
  if (!race.startCountdown()) return;
  freshStartPending = false;
  openingShowcase.stop();
  ocean.setOpeningIntensity(0);
  sky.setOpeningIntensity(0);
  driverSelect.setLaunchPending(false);
  immersive.setPhase('active');
  const coach = drivingCoach.progress;
  pcControlPrimer.arm(
    !isDuoMode() && !mobileInput.enabled && activeInputDevice === 'keyboard' && records.data.bestFlights < 1 &&
      !coach.knowledge.bankRule,
    primaryBoat().state,
  );
  pcPrimerPresentation = null;
  hud.beginFreshRunGuidance();
  hud.showPcControlPrimer(null, false, pcControlPrimer.active);
  currentRun = records.beginRun();
  rivalDirector.beginRun(currentRun);
  for (const entry of towers) entry.resetRun(currentRun);
  input.reset();
  gamepadInput.reset();
  mobileInput.reset();
  mobileInput.setGoPrompt(false);
  hud.hideReady();
  driverSelect.hide();
  mixer.setVisible(false);
  audio.startRaceScore(true);
  audio.setScene('countdown');
  drivingCoach.resetRun(primaryBoat().state);
  coachPresentation = null;
  hud.showCoach(null);
}

function startResumeCountdown(): void {
  if (!race.startResumeCountdown()) return;
  immersive.setPhase('active');
  input.clearTransient();
  gamepadInput.clearTransient();
  mobileInput.resumeFromPresentation();
  mobileInput.setOverlayHidden(false);
  hud.hideMedalCeremony();
  audio.startRaceScore(false);
  audio.setScene('countdown');
  coachPresentation = null;
  hud.showCoach(null);
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
}

/** Resume the same run after the accolade wall without resetting flight progress. */
function startNextRaceRound(): void {
  if (!race.startFinalContinueCountdown()) return;
  timeOfDayManager.nextRound();
  sky.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  ocean.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  course.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  honorTargets.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  // The result wall is a round boundary. Persisted records stay cumulative,
  // while the next round gets a fresh local ledger and target inventory.
  honors.reset(boats.length);
  honorTargets.reset();
  coinStreakCounts.length = 0;
  coinStreakTimes.length = 0;
  for (let index = 0; index < boats.length; index++) {
    coinStreakCounts.push(0);
    coinStreakTimes.push(-Infinity);
  }
  duoInteractions.reset();
  humanCollisionCounts[0] = 0;
  humanCollisionCounts[1] = 0;
  comebackAwarded[0] = false;
  comebackAwarded[1] = false;
  maxCorridorDangerThisFlight[0] = 0;
  maxCorridorDangerThisFlight[1] = 0;
  airBrakedThisFlight[0] = false;
  airBrakedThisFlight[1] = false;
  maxDriftYawRateThisDrift[0] = 0;
  maxDriftYawRateThisDrift[1] = 0;
  leadDominanceTimer[0] = 0;
  leadDominanceTimer[1] = 0;
  leadDominanceAwarded[0] = false;
  leadDominanceAwarded[1] = false;
  previousHumanPlaces[0] = race.racers[0]?.place ?? Infinity;
  previousHumanPlaces[1] = race.racers[1]?.place ?? Infinity;
  finalePresentation = false;
  finaleElapsed = 0;
  honorReviewPending = false;
  honorsSettled = false;
  resultsShown = false;
  course.resetFinalStation();
  finale.hide();
  input.clearTransient();
  gamepadInput.clearTransient();
  mobileInput.reset();
  mobileInput.setOverlayHidden(false);
  mobileInput.setControlPhase('preparing');
  hud.setVisible(true);
  for (const entry of activeTowers()) entry.setVisible(true);
  cameraRig.mode = 'chase';
  audio.startRaceScore(false);
  audio.setScene('countdown');
  trackGameEvent('continue_game', { run: currentRun, flights: primaryBoat().state.flightsCleared });
}

function continueAfterHonorReview(): void {
  if (!honorHighlights.visible() || race.phase !== 'finished' || !honorsSettled) return;
  honorHighlights.hide();
  startNextRaceRound();
}

/**
 * Dismiss the certificate into the next result beat. `auto` means the
 * countdown fired on its own, so the accolade wall is a pass-through stop
 * rather than a menu.
 */
function continueAfterFinale(auto = false): void {
  if (!finalePresentation || finaleElapsed < FINALE_MIN_READ_S || expansionGallery.visible()) return;
  // The Final Station is the first reading beat. Only after it is dismissed do
  // we construct/show the accolade wall; no result layer can peek through the
  // cinematic or consume time while the player is reading it.
  if (honorReviewPending || honorHighlights.visible()) {
    const shouldShowHonors = honorReviewPending && !honorHighlights.visible();
    honorReviewPending = false;
    finalePresentation = false;
    finaleElapsed = 0;
    finale.hide();
    input.clearTransient();
    gamepadInput.clearTransient();
    mobileInput.reset();
    mobileInput.setOverlayHidden(true);
    mobileInput.setControlPhase('inactive');
    hud.setVisible(false);
    for (const entry of activeTowers()) entry.setVisible(false);
    mixer.setVisible(false);
    if (shouldShowHonors) showHonorReview(auto);
    return;
  }
  startNextRaceRound();
}

/** Veteran shortcut: skip the dossier and the accolade wall, race the next round now. */
function skipFinaleExtras(): void {
  if (!finalePresentation || finaleElapsed < FINALE_MIN_READ_S || expansionGallery.visible()) return;
  honorReviewPending = false;
  finalePresentation = false;
  finaleElapsed = 0;
  finale.hide();
  input.clearTransient();
  gamepadInput.clearTransient();
  startNextRaceRound();
}

function openExpansionGallery(): void {
  if (!finalePresentation || finaleElapsed < FINALE_MIN_READ_S) return;
  mobileInput.setOverlayHidden(true);
  expansionGallery.show(0);
}

function openMedalGallery(): void {
  if (race.phase !== 'medal' || expansionGallery.visible()) return;
  mobileInput.setOverlayHidden(true);
  expansionGallery.show(0);
}

function setCaptureOverlayVisible(visible: boolean): void {
  captureOverlayVisible = visible;
  immersive.setPhase(visible ? 'presentation' : race.phase === 'ready' || race.phase === 'finished' ? 'ready' : 'active');
  mobileInput.setOverlayHidden(captureOverlayVisible || finalePresentation || expansionGallery.visible());
  // Leaving the preview hands the certificate its full countdown again so a
  // screenshot detour cannot silently burn the player's next-beat window.
  if (!visible && finalePresentation) finale.resetAutoAdvance();
}

function restoreMobileImmersiveFromCaptureGesture(): void {
  immersive.requestCaptureReturn();
}

function openFinaleCapturePreview(): void {
  if (!finaleCapture) return;
  capturePreview.show(finaleCapture, `board-race-final-${currentRun}.png`);
}

function handleCaptureOutcome(
  action: CaptureExportAction,
  outcome: CaptureExportOutcome,
): void {
  audio.resume();
  if (outcome === 'cancelled' || outcome === 'unsupported' || outcome === 'failed') return;
  trackGameEvent('screenshot_exported', { run: currentRun, action, outcome });
  if (outcome !== 'share-opened' && !finaleCaptureRecorded) {
    finaleCaptureRecorded = true;
    records.recordFinaleScreenshot();
  }
}

async function createFinaleCapture(): Promise<void> {
  const result = race.challengeResult;
  if (!result) return;
  try {
    finaleCapture = await capture.create({
      title: '七飞认证', kicker: 'FINAL STATION',
      lines: [`第 ${result.place} / ${result.totalRacers} 名`, `本局 ${result.flightsCleared} 飞`],
      overlayCanvas: finale.getCaptureCanvas(),
    });
    finale.setCaptureReady(true);
    trackGameEvent('screenshot_created', { run: currentRun });
  } catch {
    finale.setCaptureReady(false);
  }
}

function startMedalCeremony(tier: Exclude<ChallengeTier, 'unqualified'>, medals: number, best: number): void {
  if (!race.beginMedalCeremony()) return;
  medalElapsed = 0;
  retryLessonFrozenT = worldTime;
  input.clearTransient();
  gamepadInput.clearTransient();
  mobileInput.suspendForPresentation();
  hud.showQualification(tier, medals, best);
  hud.updateMedalCeremony(0, MEDAL_CEREMONY_S, false);
  audio.setScene('medal');
  audio.playMedalCeremony();
  haptics.cue('medal');
  coachPresentation = null;
  hud.showCoach(null);
  pcControlPrimer.stop();
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
}

function startRetryLesson(continueToHonors = false): void {
  const result = race.challengeResult;
  if (!result?.failure) return;
  const failure = result.failure;
  const reason = failure?.reason ?? result.reason;
  const key = `${failure?.routeSlot ?? 0}:${reason}`;
  const repeatCount = (retryReasonCounts.get(key) ?? 0) + 1;
  retryReasonCounts.set(key, repeatCount);
  const coachArmed = drivingCoach.onFailure(result.flightsCleared, failure.reason, result.manMedalEarned) ||
    drivingCoach.progress.status === 'active';
  retryLessonDuration = FAILURE_REVIEW_AUTO_S;
  retryLessonMinRead = continueToHonors ? FAILURE_REVIEW_MIN_READ_S : 0;
  retryLessonTimer = retryLessonDuration;
  retryLessonElapsed = 0;
  retryLessonActive = true;
  retryLessonToHonorReview = continueToHonors;
  retryLessonFrozenT = worldTime;
  input.reset();
  gamepadInput.reset();
  mobileInput.reset();
  audio.retryLesson();
  audio.setScene('lesson');
  mixer.setVisible(true);
  hud.showRetryLesson(
    result, currentRun, repeatCount, pendingFailureNewBest, activeInputDevice, coachArmed, drivingCoach.progress.mastery,
    continueToHonors,
  );
  syncDrivingCoachUi();
  coachPresentation = null;
  hud.showCoach(null);
  pcControlPrimer.stop();
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
}

function completeRetryLesson(): void {
  const showHonors = retryLessonToHonorReview;
  retryLessonActive = false;
  retryLessonToHonorReview = false;
  retryLessonTimer = 0;
  retryLessonElapsed = 0;
  hud.hideRetryLesson();
  if (showHonors) showHonorReview();
  else resetRace();
}

type HarnessCameraView = {
  target: THREE.Object3D;
  offset: readonly [number, number, number];
  lookAt: readonly [number, number, number];
  fov: number;
};

let harnessCameraOverride: HarnessCameraView | null = null;
const harnessCameraTargetPos = new THREE.Vector3();
const harnessCameraLookAtPos = new THREE.Vector3();

function applyHarnessCameraOverride(): void {
  if (!harnessCameraOverride) return;
  const view = harnessCameraOverride;
  view.target.updateWorldMatrix(true, false);
  harnessCameraTargetPos.set(view.offset[0], view.offset[1], view.offset[2]);
  view.target.localToWorld(harnessCameraTargetPos);
  harnessCameraLookAtPos.set(view.lookAt[0], view.lookAt[1], view.lookAt[2]);
  view.target.localToWorld(harnessCameraLookAtPos);

  stage.camera.position.copy(harnessCameraTargetPos);
  stage.camera.lookAt(harnessCameraLookAtPos);
  stage.camera.fov = view.fov;
  stage.camera.updateProjectionMatrix();
}

function updateFrozenPresentation(dt: number, phase = race.phase, finalPresentation = false): void {
  const focusBoat = primaryBoat();
  const frozen = focusBoat.state;
  audio.setEngine(0, 0, false);
  audio.setWaterRush(0);
  audio.setAirborne(false);
  audio.setFlight(0, false);
  audio.setDrift(0);
  if (finalPresentation) {
    if (finaleElapsed >= FINALE_CAMERA_HERO_S && cameraRig.mode !== 'results') cameraRig.mode = 'results';
    updateRaceCamera(dt, presentationTime, focusBoat);
    applyHarnessCameraOverride();
    ocean.update(presentationTime, stage.camera.position);
    sky.update(presentationTime, stage.camera.position);
    course.update(dt, presentationTime);
    // The race step returns early here, so without this the riders freeze in
    // their driving pose. Keep breathing and secondary motion running through
    // the finale presentation; the finish is sold by the camera and the HUD.
    for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, presentationTime);
  }
  pipeline.update(dt, finalPresentation ? presentationTime : retryLessonFrozenT, frozen, phase);
  hud.update(dt, race, focusBoat, boats);
  updateDuoViewportHud();
  audio.update(dt);
}

function resetRace(): void {
  harnessCameraOverride = null;
  freshStartPending = false;
  openingShowcase.stop();
  ocean.setOpeningIntensity(0);
  sky.setOpeningIntensity(0);
  timeOfDayManager.reset();
  sky.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  ocean.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  course.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  honorTargets.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  driverSelect.setLaunchPending(false);
  retryLessonActive = false;
  retryLessonToHonorReview = false;
  retryLessonTimer = 0;
  retryLessonDuration = 0;
  retryLessonElapsed = 0;
  retryLessonMinRead = 0;
  defeatFreezeTimer = 0;
  pendingFailureNewBest = false;
  newBestThisRun = false;
  medalEarnedThisRun = false;
  ordinaryNewThisRun = false;
  excellentRecordedThisRun = false;
  previousChallengeTier = 'unqualified';
  finalePresentation = false;
  finaleElapsed = 0;
  honorReviewPending = false;
  finaleCapture = null;
  finaleCaptureRecorded = false;
  finaleCapturePending = false;
  lastResultEnvelope = null;
  honorsSettled = false;
  duoPauseActive = false;
  hud.setDuoControls(false);
  hud.setDuoSplit(false);
  applyTowerSeats();
  duoViewportHud.setVisible(false);
  comebackAwarded[0] = false;
  comebackAwarded[1] = false;
  maxCorridorDangerThisFlight[0] = 0;
  maxCorridorDangerThisFlight[1] = 0;
  airBrakedThisFlight[0] = false;
  airBrakedThisFlight[1] = false;
  maxDriftYawRateThisDrift[0] = 0;
  maxDriftYawRateThisDrift[1] = 0;
  leadDominanceTimer[0] = 0;
  leadDominanceTimer[1] = 0;
  leadDominanceAwarded[0] = false;
  leadDominanceAwarded[1] = false;
  previousHumanPlaces[0] = Infinity;
  previousHumanPlaces[1] = Infinity;
  course.resetFlightChallenge();
  // A retry, mode switch, or return from the accolade wall must not leave the
  // previous run's Final Station glowing in the READY/front-door scene.
  course.resetFinalStation();
  honorTargets.reset();
  honors.reset(boats.length);
  coinStreakCounts.length = 0;
  coinStreakTimes.length = 0;
  for (let index = 0; index < boats.length; index++) {
    coinStreakCounts.push(0);
    coinStreakTimes.push(-Infinity);
  }
  honorHighlights.hide();
  duoInteractions.reset();
  duoEliminated[0] = false;
  duoEliminated[1] = false;
  collisions.reset();
  spray.clear();
  feathers.clear();
  input.reset();
  localInput.reset();
  gamepadInput.reset();
  mobileInput.reset();
  mobileInput.setOverlayHidden(false);
  resultsShown = false;
  hud.hideResults();
  hud.clearTransientNotices();
  hud.hideRetryLesson();
  hud.hideMedalCeremony();
  coachPresentation = null;
  hud.showCoach(null);
  pcControlPrimer.stop();
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
  finale.hide();
  capturePreview.hide(false);
  immersive.setPhase('ready');
  for (let i = 0; i < boats.length; i++) {
    const s = appMode === 'duo' ? duoGridSlot(i) : GRID_SLOTS[i];
    boats[i].object.visible = true;
    boats[i].setPlayerOwned(appMode === 'duo' ? i < 2 : i === 0);
    boats[i].teleport(s.x, s.z, s.heading);
    wakes[i].clear();
  }
  race.reset();
  if (appMode === 'duo') course.setGuidanceOwners([0, 1], 0);
  else course.setGuidanceBoat(race.player().id);
  previousHumanPlaces[0] = race.racers[0]?.place ?? Infinity;
  previousHumanPlaces[1] = race.racers[1]?.place ?? Infinity;
  currentRun = records.data.runs + 1;
  for (const entry of towers) entry.resetRun(currentRun);
  const resetFocus = primaryBoat();
  for (const seat of DUO_FEEDBACK_SEATS) {
    const seatState = boats[seat].state;
    const edge = seatEdges[seat];
    edge.flightCharges = seatState.flightCharges;
    edge.driftReleaseReady = seatState.driftReleaseReady;
    edge.flightGateProgress = seatState.flightGateProgress;
    edge.flightRouteState = seatState.flightRouteState;
    edge.flightPhase = seatState.flightPhase;
    edge.boosting = seatState.boosting;
    edge.airBraking = false;
    edge.drifting = seatState.drifting;
    edge.turnWarning = false;
  }
  drivingCoach.resetRun(resetFocus.state);
  harnessCheckpointEvents = 0;
  harnessCollisionFxBursts = 0;
  humanCollisionCounts[0] = 0;
  humanCollisionCounts[1] = 0;
  harnessRoutePilotIndex = -1;
  for (let i = 0; i < boats.length; i++) {
    harnessRoutePasses[i] = 0;
    harnessRouteFails[i] = 0;
    harnessPrevRouteStates[i] = boats[i].state.flightRouteState;
    routeLifecycleStates[i] = boats[i].state.flightRouteState;
    ais[i].reset();
  }
  cameraRig.mode = 'orbit';
  if (DESKTOP_DRIVER_STAGE.matches) cameraRig.snapOrbit(resetFocus, presentationTime);
  hud.hideReady();
  const showIndependentFrontDoor = appMode === 'independent' || appMode === 'duo' || mobileInput.enabled || HARNESS;
  if (showIndependentFrontDoor) {
    driverSelect.show();
    hud.setVisible(true);
    for (const entry of activeTowers()) entry.setVisible(true);
  } else {
    driverSelect.hide();
    hud.setVisible(false);
    for (const entry of activeTowers()) entry.setVisible(false);
  }
  syncDrivingCoachUi();
  mobileInput.setGoPrompt(false);
  mixer.setVisible(showIndependentFrontDoor && !mobileInput.enabled);
  mixer.sync();
  audio.setScene('ready');
}

/** Resolve the active roster's authored start distances without changing the
 * single-player GRID_SLOTS contract. */
function duoGridSlot(id: number): { x: number; z: number; heading: number } {
  const definition = roster[id];
  if (!definition) return GRID_SLOTS[id];
  const u = (((1 - definition.startDistance / course.length) % 1) + 1) % 1;
  course.pointAt(u, resetGridPoint);
  course.tangentAt(u, resetGridTangent);
  return {
    x: resetGridPoint.x + resetGridTangent.z * definition.startLateral,
    z: resetGridPoint.z - resetGridTangent.x * definition.startLateral,
    heading: Math.atan2(resetGridTangent.x, resetGridTangent.z),
  };
}

if (HARNESS || mobileInput.enabled) {
  appMode = 'independent';
  resetRace();
} else {
  enterFrontDoor();
}

// ------------------------------------------------------------------- step
const ZERO_INPUT: BoatInput = {
  throttle: 0,
  steer: 0,
  drift: false,
  flightTrigger: false,
  airBrake: false,
};
let harnessPlayerInput: BoatInput | null = null;
let harnessFlightTriggerPulse = false;
const harnessLastBoatInputs: BoatInput[] = boats.map(() => ({ ...ZERO_INPUT }));
const harnessBoatInputOverrides: Array<Partial<BoatInput> | null> = boats.map(() => null);

function isDuoMode(): boolean {
  return appMode === 'duo';
}

function isDuoSplitPhase(): boolean {
  return isDuoMode() && (
    race.phase === 'countdown' || race.phase === 'resume-countdown' ||
    race.phase === 'racing'
  );
}

function duoDevicesConnected(): boolean {
  return duoDevices.every((device) => localInput.connected(device));
}

function isHumanRacer(id: number): boolean {
  return isDuoMode() ? id < 2 : id === 0;
}

function primaryBoat(): Boat {
  return boats[race.player().id] ?? boats[0];
}

function updateDuoViewportHud(): void {
  if (!isDuoMode()) {
    duoViewportHud.setVisible(false);
    return;
  }
  const interactionStatuses = duoInteractions.snapshot().statuses;
  const makeSeat = (id: 0 | 1): DuoViewportSeat => ({
    name: roster[id]?.name ?? `席位 ${id + 1}`,
    color: roster[id]?.color ?? (id === 0 ? 0x55e7ff : 0xffd23f),
    racer: race.racers[id],
    boat: boats[id],
    device: duoDevices[id].startsWith('gamepad:')
      ? `手柄 ${Number.parseInt(duoDevices[id].slice('gamepad:'.length), 10) + 1}`
      : id === 0 ? '键盘 W/A/S/D' : '方向键',
    interaction: interactionStatuses[id],
    guidance: course.guidanceStatusFor(id),
  });
  duoViewportHud.update([makeSeat(0), makeSeat(1)], isDuoSplitPhase());
}

/** Keep the authoritative single-player camera for HUD anchoring, while the
 * two rendered views independently follow their seated human boats. */
function updateRaceCamera(dt: number, t: number, focus = primaryBoat()): void {
  if (isDuoMode()) {
    cameraRig.update(dt, focus, t);
    const leftEliminated = Boolean(race.racers[0]?.eliminated);
    const rightEliminated = Boolean(race.racers[1]?.eliminated);

    const leftMissile = leftEliminated ? duoInteractions.getActiveMissileInfo(0) : null;
    const rightMissile = rightEliminated ? duoInteractions.getActiveMissileInfo(1) : null;

    if (leftMissile && leftMissile.active) {
      teamLeftCameraRig.updateMissileChase(
        dt,
        leftMissile.position,
        leftMissile.direction,
        boats[1].state.position,
        t,
        leftMissile.isDwell,
      );
    } else {
      const leftFocus = leftEliminated ? boats[1] : boats[0];
      teamLeftCameraRig.update(dt, leftFocus, t);
    }

    if (rightMissile && rightMissile.active) {
      teamRightCameraRig.updateMissileChase(
        dt,
        rightMissile.position,
        rightMissile.direction,
        boats[0].state.position,
        t,
        rightMissile.isDwell,
      );
    } else {
      const rightFocus = rightEliminated ? boats[0] : boats[1];
      teamRightCameraRig.update(dt, rightFocus, t);
    }
    return;
  }
  cameraRig.update(dt, focus, t);
}

function activeRaceBoats(): Boat[] {
  activeBoatScratch.length = 0;
  if (!isDuoMode()) {
    for (const boat of boats) activeBoatScratch.push(boat);
    return activeBoatScratch;
  }
  for (const boat of boats) {
    if (!race.racers[boat.id].eliminated && boat.object.visible) activeBoatScratch.push(boat);
  }
  return activeBoatScratch;
}

function eliminateDuoSeat(id: number, failure: FlightFailureSnapshot): boolean {
  if (!isDuoMode() || id < 0 || id > 1) return false;
  return race.eliminatePlayer(id, failure);
}

function presentDuoElimination(id: number, failure: FlightFailureSnapshot): void {
  if (duoEliminated[id]) return;
  duoEliminated[id] = true;
  boats[id].object.visible = false;
  wakes[id].setVisualScale(0);
  const racer = roster[id];
  // The eliminated seat keeps its own screen, so its news belongs to its half.
  hud.showTransientNotice(
    `${racer?.name ?? `席位 ${id + 1}`} 暂离赛道 · 可用互动支援另一席`,
    '席位淘汰',
    id === 0 ? 'left' : 'right',
  );
  trackGameEvent('duo_elimination', { racer: id, reason: failure.reason, at: race.raceTime });
}

function handleDuoInteraction(event: DuoInteractionEvent): void {
  const target = roster[event.targetId];
  const actor = roster[event.actorId];
  if (!actor || !target) return;
  const targetPipeline = event.targetId === 0 ? teamLeftPipeline : teamRightPipeline;
  const targetSide: 'left' | 'right' = event.targetId === 0 ? 'left' : 'right';
  // The interaction lands on the other seat, so its warning has to show up in
  // that seat's half. Routing every one of these to the left half made the
  // survivor look untouched and the left screen look permanently harassed.
  const effectLane: 'left' | 'right' = event.targetId === 0 ? 'left' : 'right';
  const actorLane: 'left' | 'right' = event.actorId === 0 ? 'left' : 'right';
  if (!event.accepted) {
    const detail = event.reason === 'full-bank' ? '队友电池已满' : '当前不在安全援助窗口';
    hud.showTransientNotice(`${actor.name} 的互动暂缓 · ${detail}`, '互动提示', actorLane);
    return;
  }
  if (event.phase === 'support' || event.phase === 'prank-launch') {
    honors.award(
      event.action === 'support' ? 'duo.assist' : 'duo.intervention',
      event.actorId,
      event.action === 'support' ? HONOR_DEFINITIONS['duo.assist'].value : HONOR_DEFINITIONS['duo.intervention'].value,
      race.raceTime,
    );
  }
  if (event.phase === 'support') {
    audio.flightReady(boats[event.targetId].state.flightCharges);
    targetPipeline.pulse('ready', 0.72);
    audio.teamSpatialCue(targetSide, 'ready');
    localInput.rumble(duoDevices[event.actorId], 0.24, 0.72, 62);
    localInput.rumble(duoDevices[event.targetId], 0.36, 0.6, 54);
    hud.showTransientNotice(`${actor.name} 灵魂援手 · ${target.name} 获得飞行电池！`, '互动支援', effectLane);
    trackGameEvent('duo_interaction', { action: 'support', actor: actor.id, target: target.id });
  } else if (event.phase === 'prank-launch') {
    audio.teamSpatialCue(targetSide, 'relay');
    targetPipeline.pulse('lost', 0.45);
    localInput.rumble(duoDevices[event.actorId], 0.5, 0.65, 52);
    localInput.rumble(duoDevices[event.targetId], 0.35, 0.4, 40);
    duoViewportHud.startTacticalMissileFeed(event.actorId, target.name);
    hud.showTransientNotice(`🚨 战略核预警！${actor.name} 发射了【飞毛腿战术核导弹】· 90% 致命锁定逼近中！`, '队友背刺预警', effectLane);
    trackGameEvent('duo_interaction', { action: 'prank-launch', actor: actor.id, target: target.id });
  } else if (event.phase === 'prank-impact') {
    audio.splash(1.8);
    targetPipeline.pulse('lost', 0.95);
    audio.teamSpatialCue(targetSide, 'impact');
    localInput.rumble(duoDevices[event.targetId], 0.85, 0.7, 72);
    localInput.rumble(duoDevices[event.actorId], 0.45, 0.8, 55);
    duoViewportHud.finishTacticalMissileFeed(event.actorId, true);
    hud.showTransientNotice(`💥 飞毛腿在途的聚变打击命中！${target.name} 被炸飞上天 720° 旋转杂耍！`, '聚变打击得手', effectLane);
    trackGameEvent('duo_interaction', { action: 'prank-impact', actor: actor.id, target: target.id });
  } else if (event.phase === 'prank-miss') {
    audio.splash(0.8);
    audio.teamSpatialCue(targetSide, 'relay');
    duoViewportHud.finishTacticalMissileFeed(event.actorId, false);
    hud.showTransientNotice(`💨 飞毛腿描边！${target.name} 极限躲过核打击！(10% 脱靶概率)`, '极限躲避', effectLane);
    trackGameEvent('duo_interaction', { action: 'prank-miss', actor: actor.id, target: target.id });
  }
}

function presentHonorHits(hits: readonly HonorHit[]): void {
  for (const hit of hits) {
    // Coin streak: a pickup within the time window grows the ladder; the
    // bonus value is what the honor ledger sees and what the HUD/chime/camera
    // read. Streak resets on the next race round (see startNextRaceRound).
    const lastAt = coinStreakTimes[hit.racerId] ?? -Infinity;
    const last = coinStreakCounts[hit.racerId] ?? 0;
    if (last > 0 && race.raceTime - lastAt <= COIN_STREAK_WINDOW) {
      coinStreakCounts[hit.racerId] = Math.min(last + 1, COIN_STREAK_MAX);
    } else {
      coinStreakCounts[hit.racerId] = 1;
    }
    coinStreakTimes[hit.racerId] = race.raceTime;
    const streakStep = Math.max(0, coinStreakCounts[hit.racerId] - 1);
    hit.value = COIN_BASE_VALUE + streakStep * COIN_STREAK_BONUS;
    honors.addTargetHit(hit);
    honorFxPoint.set(hit.x, hit.y, hit.z);
    spray.burst(honorFxPoint, 7, 4.8);
    honorTargets.presentHitFx(hit);
    if (!isHumanRacer(hit.racerId)) continue;
    if (streakStep >= 2) {
      honors.award('coin.frenzy', hit.racerId, HONOR_DEFINITIONS['coin.frenzy'].value, race.raceTime);
    }
    const racer = roster[hit.racerId];
    const definition = HONOR_DEFINITIONS[`target.${hit.kind}`];
    const pan = isDuoMode() && hit.racerId < 2 ? (hit.racerId === 0 ? -0.45 : 0.45) : 0;
    audio.coinCollect(streakStep, pan);
    const targetPipeline = isDuoMode() && hit.racerId < 2
      ? hit.racerId === 0 ? teamLeftPipeline : teamRightPipeline
      : pipeline;
    targetPipeline.pulse('ready', 0.72 + streakStep * 0.04);
    const rumbleStrength = 0.56 + streakStep * 0.04;
    // A target belongs to the boat that touched it. In dual play route the
    // pulse to that seat's device instead of whichever controller was last
    // active globally; single play keeps the normal haptics lane.
    if (isDuoMode() && hit.racerId < 2) {
      localInput.rumble(duoDevices[hit.racerId as 0 | 1], rumbleStrength, 0.42, 48);
    } else {
      haptics.impact('collision-light', rumbleStrength, false);
    }
    // Camera pickup punch grows with the streak so a combo reads as one
    // accelerating hit rather than six equal ones.
    cameraRig.coinPickupKick(streakStep);
    hud.showHonorTargetNotice(
      racer?.name ?? '选手',
      definition?.title ?? '荣誉目标',
      hit.value,
      hit.precision,
      isDuoMode() && hit.racerId < 2 ? hit.racerId === 0 ? 'left' : 'right' : 'center',
      streakStep,
    );
    trackGameEvent('honor_award', {
      id: `target.${hit.kind}`,
      racer: hit.racerId,
      value: hit.value,
      precision: hit.precision,
      at: hit.at,
      streak: streakStep,
    });
  }
}

function showHonorReview(autoEntered = false): void {
  if (honorsSettled) return;
  hud.setVisible(false);
  for (const entry of activeTowers()) entry.setVisible(false);
  mixer.setVisible(false);
  const humanIds = isDuoMode() ? [0, 1] : [0];
  for (const id of humanIds) {
    if (honors.scoreFor(id) <= 0 && humanCollisionCounts[id] === 0) {
      honors.award('clean.run', id, HONOR_DEFINITIONS['clean.run'].value, race.raceTime);
    }
  }
  const names = roster.map((racer) => racer.name);
  const allIds = roster.map((racer) => racer.id);
  const summary = honors.summaryFor(humanIds);
  // AI still appears in the six-racer standings, but the accolade wall should
  // celebrate the people in this local room rather than letting a bot steal
  // the Play-of-the-Run spotlight.
  const highlights = honors.highlightCards(humanIds, names, 4);
  const displayIds = [...allIds]
    .sort((a, b) => race.racers[a].place - race.racers[b].place || a - b)
    .slice(0, 6);
  const racerCards = displayIds.map((id) => ({
    id,
    name: roster[id].name,
    portraitUrl: roster[id].portraitUrl,
    color: roster[id].color,
    place: race.racers[id].place,
    score: honors.scoreFor(id),
  }));
  const result = race.challengeResult;
  const failureReason = result?.failure?.reason;
  const failureLabel = failureReason === 'off_course' ? '离开赛道' :
    failureReason === 'wrong_way' ? '逆向航行' :
      failureReason === 'corridor' ? '飞行走廊失控' :
        failureReason === 'landing' ? '落水姿态失控' :
          failureReason === 'no_launch' ? '未能起飞' : '飞行失控';
  const resultLabel = race.phase === 'finished'
    ? `第 ${result?.place ?? race.player().place} 名冲线 · ${formatTeamTime(result?.raceTime ?? race.raceTime)}`
    : `比赛中止 · ${failureLabel}`;
  const mode = isDuoMode() ? 'duo' : 'single';
  const envelope: RaceResultEnvelope = {
    schema: 'board-race-race-result/v1',
    mode,
    raceTime: result?.raceTime ?? race.raceTime,
    racers: race.racers.map((racer) => ({
      racerId: racer.id,
      place: racer.place,
      progress: racer.progress,
      finished: racer.finished,
      eliminated: racer.eliminated,
    })),
    seats: humanIds.map((racerId, playerIndex) => ({
      playerIndex: playerIndex as 0 | 1,
      racerId,
      side: playerIndex === 0 ? 'left' : 'right',
      deviceId: isDuoMode() ? duoDevices[playerIndex] : 'keyboard-left',
      driverId: roster[racerId].profileId,
    })) as PlayerSeat[],
    honors: summary,
  };
  lastResultEnvelope = envelope;
  records.recordHonors(summary, mode, race.phase === 'finished' && (result?.place ?? 99) === 1);
  honorsSettled = true;
  honorHighlights.show({
    mode,
    racers: racerCards,
    highlights,
    summary,
    resultLabel,
    canContinue: race.phase === 'finished',
    autoEntered,
    historyHonorScore: records.data.honorScore,
  });
}

/** Start the first, self-contained beat of a successful Final crossing. */
function beginFinalePresentation(): void {
  const result = race.challengeResult;
  if (!result) return;
  cameraRig.finishKick();
  pipeline.pulse('finish', 1.35);
  result.ordinaryNew = ordinaryNewThisRun;
  records.decorateResult(result, newBestThisRun, medalEarnedThisRun);
  records.recordFinale();
  const finishers = race.players().filter((racer) => racer.finished).map((racer) => racer.id);
  const finalHonorRacers = finishers.length > 0 ? finishers : [race.player().id];
  for (const racerId of finalHonorRacers) {
    honors.award('finale.captain', racerId, HONOR_DEFINITIONS['finale.captain'].value, race.raceTime);
  }
  course.triggerFinaleCelebration();
  finale.show(result, '查看高光');
  finaleElapsed = 0;
  finalePresentation = true;
  finaleCapture = null;
  finaleCaptureRecorded = false;
  finaleCapturePending = true;
  honorReviewPending = true;
  retryLessonFrozenT = worldTime;
  input.reset();
  gamepadInput.reset();
  mobileInput.reset();
  mobileInput.setOverlayHidden(true);
  mobileInput.setControlPhase('inactive');
  hud.setVisible(false);
  for (const entry of activeTowers()) entry.setVisible(false);
  mixer.setVisible(false);
  audio.setScene('medal');
  haptics.cue('medal');
  trackGameEvent('final_station_crossed', {
    run: currentRun, flights: result.flightsCleared, elapsed: result.raceTime,
  });
  trackGameEvent('finale_shown', { run: currentRun, place: result.place });
}

function updateFrontDoor(dt: number, t: number): void {
  presentationTime += dt;
  cameraRig.update(dt, boats[0], presentationTime);
  applyHarnessCameraOverride();
  ocean.update(presentationTime, stage.camera.position);
  sky.update(presentationTime, stage.camera.position);
  for (const boat of boats) boat.syncSurfacePresentation(presentationTime);
  for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, presentationTime);
  openingShowcase.update(dt);
  course.update(0, presentationTime);
  honorTargets.update(dt, presentationTime, [], race.racers, honorHitScratch, false);
  teamExperience.update(dt, localInput);
  pipeline.update(dt, t, boats[0].state, 'ready');
  audio.setEngine(0, 0, false);
  audio.update(dt);
}

function updateTeamSession(dt: number, t: number): void {
  const leftDevice = teamExpedition.deviceFor('left');
  const rightDevice = teamExpedition.deviceFor('right');
  if (teamExpedition.snapshot().phase === 'finished') {
    let replay = false;
    let exit = false;
    for (const id of [leftDevice, rightDevice]) {
      replay ||= localInput.confirmEdge(id);
      exit ||= localInput.cancelEdge(id);
    }
    if (exit) {
      enterFrontDoor();
      localInput.endFrame();
      return;
    }
    if (replay) {
      replayTeamWithSwappedRoles();
      localInput.endFrame();
      return;
    }
    updateTeamPresentation(0, t);
    localInput.endFrame();
    return;
  }
  const devicesConnected = localInput.connected(leftDevice) && localInput.connected(rightDevice);
  if (!devicesConnected && !teamPaused) {
    teamPaused = true;
    teamExperience.showTransition('DEVICE LINK', '设备已断开', '两侧画面与计时已冻结 · 重新连接后按确认继续', 0, true);
  }
  if (teamPaused) {
    if (devicesConnected) {
      let resume = false;
      let exit = false;
      for (const id of [leftDevice, rightDevice]) {
        resume ||= localInput.confirmEdge(id);
        exit ||= localInput.cancelEdge(id);
      }
      if (exit) {
        enterFrontDoor();
        localInput.endFrame();
        return;
      }
      if (resume) {
        teamPaused = false;
        teamExperience.hideTransition();
      }
    }
    updateTeamPresentation(0, t);
    localInput.endFrame();
    return;
  }
  let pause = false;
  for (const id of [leftDevice, rightDevice]) pause ||= localInput.pauseEdge(id);
  if (pause) {
    teamPaused = true;
    teamExperience.showTransition('TEAM PAUSE', '协作暂停', '按任一设备确认继续 · 返回键退出', 0, true);
    updateTeamPresentation(0, t);
    localInput.endFrame();
    return;
  }

  const leftState = boats[0].state;
  const rightState = boats[1].state;
  const leftInput = localInput.readBoat(leftDevice, dt, {
    flightActive: leftState.flightPhase !== 'surface',
    manualThrottle: true,
  });
  const rightInput = localInput.readBoat(rightDevice, dt, {
    flightActive: rightState.flightPhase !== 'surface',
    manualThrottle: true,
  });
  const activeBoats = teamExpedition.activeBoats();
  collisions.capture(activeBoats);
  worldTime += dt;
  const advanced = teamExpedition.step(dt, worldTime, leftInput, rightInput);
  if (advanced) {
    const hits = collisions.resolve(activeBoats);
    if (collisions.debugState().maxCorrection > 0) course.syncFlightTrackingAfterCollisions(activeBoats);
    presentTeamCollisions(hits);
    presentBuoyHits(course.applyBuoyHits(activeBoats, buoyHitScratch));
    presentBalloonPops(course.consumeBalloonPops(balloonPopScratch));
    honorTargets.update(dt, worldTime, activeBoats, race.racers, honorHitScratch, false);
  }
  updateTeamPresentation(dt, worldTime);
  localInput.endFrame();
}

function updateTeamPresentation(dt: number, t: number): void {
  teamLeftCameraRig.update(dt, boats[0], t);
  teamRightCameraRig.update(dt, boats[1], t);
  teamExperience.updateTransition(dt);
  for (let i = 0; i < boats.length; i++) {
    if (!boats[i].object.visible) continue;
    riders[i].update(dt, boats[i].state, t);
    wakes[i].update(dt, t);
  }
  spray.update(dt, t);
  feathers.update(dt, t);
  jetTrail.update(dt);
  course.update(dt, t);
  const snapshot = teamExpedition.snapshot();
  if (activeTeamSelection) {
    teamExperience.updateHud({
      station: snapshot.station,
      totalStations: snapshot.totalStations,
      stationName: snapshot.stationName,
      beat: snapshot.beat,
      beatTotal: snapshot.beatTotal,
      elapsed: snapshot.elapsed,
      objective: snapshot.objective,
      hintLevel: snapshot.hintLevel,
      left: teamHudSeat(
        activeTeamSelection.left.profile,
        boats[0],
        snapshot.left,
        !localInput.connected(teamExpedition.deviceFor('left')),
      ),
      right: teamHudSeat(
        activeTeamSelection.right.profile,
        boats[1],
        snapshot.right,
        !localInput.connected(teamExpedition.deviceFor('right')),
      ),
    });
  }
  const left = boats[0].state;
  const right = boats[1].state;
  const averageSpeed = (Math.abs(left.speed) + Math.abs(right.speed)) * 0.5;
  const activeState = left.flightPhase !== 'surface' ? left : right;
  audio.setScene(snapshot.phase === 'countdown' ? 'countdown' : snapshot.phase === 'finished' ? 'medal' : 'racing');
  audio.setEngine(Math.max(left.rpm, right.rpm), Math.max(left.throttle, right.throttle), left.boosting || right.boosting);
  audio.setWaterRush(Math.min(1, averageSpeed / 34));
  audio.setAirborne(left.airborne || right.airborne);
  audio.setFlight(
    activeState.flightThrust,
    activeState.flightPhase !== 'surface',
    activeState.flightPressure,
    Math.max(0, activeState.flightClearance),
    activeState.flightPhase === 'surface' ? 0 : activeState.flightAirBrake,
    activeState.steer,
    activeState.flightRouteIndex >= 0 ? activeState.flightRouteIndex : Math.min(2, snapshot.station - 1),
  );
  audio.setDrift(left.drifting || right.drifting ? 0.62 : 0);
  audio.update(dt);
  teamLeftPipeline.update(dt, t, left, snapshot.phase === 'countdown' ? 'countdown' : 'racing');
  teamRightPipeline.update(dt, t, right, snapshot.phase === 'countdown' ? 'countdown' : 'racing');
}

function teamHudSeat(
  profile: ReturnType<typeof driverProfile>,
  boat: Boat,
  seat: ReturnType<TeamExpedition['snapshot']>['left'],
  disconnected: boolean,
): {
  profile: ReturnType<typeof driverProfile>;
  role: TeamRole;
  speedKmh: number;
  status: string;
  actionLabel: string;
  interactionProgress: number;
  ready: boolean;
  disconnected: boolean;
} {
  return {
    profile,
    role: seat.role,
    speedKmh: Math.abs(boat.state.speed) * 3.6,
    status: seat.instruction,
    actionLabel: seat.actionLabel,
    interactionProgress: seat.interactionProgress,
    ready: seat.ready,
    disconnected,
  };
}

function presentTeamCollisions(hits: readonly CollisionHit[]): void {
  for (const hit of hits) {
    if ((hit.a < 2 && hit.b < 2) || hit.strength < 0.8) continue;
    const playerId = hit.a < 2 ? hit.a : hit.b < 2 ? hit.b : -1;
    if (playerId < 0) continue;
    const device = teamExpedition.deviceFor(playerId === 0 ? 'left' : 'right');
    audio.collision(hit.strength * 0.5);
    audio.teamSpatialCue(playerId === 0 ? 'left' : 'right', 'impact');
    localInput.rumble(device, Math.min(0.8, 0.25 + hit.strength / 18), 0.42, 56);
    collisionFxPoint.set(hit.x, hit.y + 0.15, hit.z);
    spray.burst(collisionFxPoint, 3 + Math.min(5, Math.round(hit.strength * 0.16)), 2.4);
  }
}

function step(dt: number, _t: number): void {
  timeOfDayManager.update(dt);
  localInput.poll();
  // The finale cinematic is the first beat of the result sequence. The honor
  // wall is not mounted yet, so its spotlight timer starts at zero only after
  // the player explicitly confirms this beat.
  if (!finalePresentation) honorHighlights.update(dt);
  if (appMode === 'front-door') {
    immersive.update(dt);
    updateFrontDoor(dt, worldTime);
    localInput.endFrame();
    return;
  }
  if (appMode === 'team-play') {
    immersive.update(dt);
    updateTeamSession(dt, worldTime);
    return;
  }
  gamepadInput.poll(race.phase === 'ready' && !interruptionActive);
  updateActiveInputDevice();
  haptics.update();
  immersive.update(dt);
  const duoPausePhase = isDuoMode() &&
    (race.phase === 'racing' || race.phase === 'countdown' || race.phase === 'resume-countdown');
  // A local dual race must never keep simulating one seat with a missing
  // controller.  Without this boundary a transient Gamepad API disconnect
  // silently feeds zero input to that boat, which can carry it out of the
  // authored corridor and make the other split view appear to lose its route.
  // Freeze immediately; the existing interruption flow waits for both devices
  // and resumes through the normal countdown after an explicit confirmation.
  if (duoPausePhase && !interruptionActive && !duoDevicesConnected()) {
    beginDuoPause('一只手柄已断开');
    localInput.endFrame();
    return;
  }
  // Consume the keyboard edge here, before the generic coach-dismiss path,
  // so Escape has an unambiguous pause meaning during a dual run.
  const duoPauseEscape = duoPausePhase ? input.consumePress('Escape') : false;
  if (duoPausePhase && !interruptionActive) {
    let pausePressed = duoPauseEscape;
    for (const id of duoDevices) pausePressed ||= localInput.pauseEdge(id);
    if (pausePressed) {
      beginDuoPause();
      localInput.endFrame();
      return;
    }
  }
  if (interruptionActive) {
    if (duoPauseActive) {
      // Only the two seated devices may resume a dual race. The generic
      // single-player adapter can select an unseated third controller and is
      // intentionally excluded from this ownership boundary.
      let resume = false;
      let exit = duoPauseEscape;
      for (const id of duoDevices) {
        resume ||= localInput.confirmEdge(id);
        exit ||= localInput.cancelEdge(id);
      }
      if (exit) exitDuoPause();
      else if (resume) resumeInterruption();
    } else if (gamepadInput.consumeConfirm()) {
      resumeInterruption();
    }
    localInput.endFrame();
    return;
  }
  if (mobileInput.enabled && !mobileInput.isLandscape) {
    input.reset();
    gamepadInput.reset();
    mobileInput.reset();
    mobileInput.setControlPhase('inactive');
    localInput.endFrame();
    return;
  }
  const frozenDesktopReady = race.phase === 'ready' && DESKTOP_DRIVER_STAGE.matches && !openingShowcase.active;
  if (!frozenDesktopReady) presentationTime += dt;
  // Consume retry edges in every phase. Otherwise a key pressed during the
  // race remains queued and can erase the defeat screen on the failure frame.
  const enterPressed = input.consumePress('Enter');
  const retryPressed = input.consumePress('KeyR');
  const spaceConfirmPressed = race.phase === 'racing' ? false : input.consumePress('Space');
  const gamepadConfirm = gamepadInput.consumeConfirm();
  const coachDismissed = duoPauseEscape || input.consumePress('Escape') || gamepadInput.consumeDismiss();

  if (honorHighlights.visible() && !finalePresentation) {
    if (coachDismissed) {
      dismissHonorReview();
      localInput.endFrame();
      return;
    }
    const selectLeft = input.consumePress('ArrowLeft') || input.consumePress('ArrowUp') || gamepadInput.consumeSelectLeft();
    const selectRight = input.consumePress('ArrowRight') || input.consumePress('ArrowDown') || gamepadInput.consumeSelectRight();
    if (selectLeft) honorHighlights.move(-1);
    if (selectRight) honorHighlights.move(1);
    if (enterPressed || spaceConfirmPressed || retryPressed || gamepadConfirm) honorHighlights.activate();
    updateFrozenPresentation(dt, race.phase);
    localInput.endFrame();
    return;
  }

  if (capturePreview.visible()) {
    if (coachDismissed) capturePreview.hide();
    input.clearTransient();
    gamepadInput.clearTransient();
    mobileInput.consumeAnyPress();
    localInput.endFrame();
    return;
  }

  if (coachDismissed && pcControlPrimer.active && pcPrimerPresentation) dismissPcControlPrimer();
  else if (coachDismissed && drivingCoach.progress.status === 'active') disableDrivingCoach();

  if (expansionGallery.visible()) {
    mobileInput.consumeAnyPress();
    const selectLeft = gamepadInput.consumeSelectLeft();
    const selectRight = gamepadInput.consumeSelectRight() || gamepadInput.consumeFlight() || gamepadInput.consumeConfirm();
    const dismiss = gamepadInput.consumeDrift() || gamepadInput.consumeDismiss();
    if (selectLeft) expansionGallery.move(-1);
    if (selectRight) expansionGallery.move(1);
    if (dismiss) expansionGallery.hide();
    updateFrozenPresentation(dt, race.phase === 'medal' ? 'medal' : 'finished', true);
    localInput.endFrame();
    return;
  }

  if (race.phase === 'medal') {
    mobileInput.consumeAnyPress();
    // Browsing the dossier pauses the ceremony clock; it resumes on return.
    const galleryOpen = expansionGallery.visible();
    if (!galleryOpen) medalElapsed += dt;
    const canContinue = medalElapsed >= MEDAL_MIN_READ_S;
    hud.updateMedalCeremony(medalElapsed, MEDAL_CEREMONY_S, canContinue);
    updateFrozenPresentation(dt, 'medal');
    if (!galleryOpen && (medalElapsed >= MEDAL_CEREMONY_S || ((enterPressed || spaceConfirmPressed || gamepadConfirm) && canContinue))) startResumeCountdown();
    localInput.endFrame();
    return;
  }

  if (retryLessonActive) {
    const lessonPressed = enterPressed || spaceConfirmPressed || retryPressed || gamepadConfirm;
    mobileInput.consumeAnyPress();
    retryLessonTimer = Math.max(0, retryLessonTimer - dt);
    retryLessonElapsed += dt;
    const canContinue = retryLessonElapsed >= retryLessonMinRead;
    hud.updateRetryLesson(retryLessonDuration > 0 ? retryLessonElapsed / retryLessonDuration : 1, canContinue);
    updateFrozenPresentation(dt);
    if (retryLessonTimer <= 0 || (lessonPressed && canContinue)) completeRetryLesson();
    localInput.endFrame();
    return;
  }

  if (defeatFreezeTimer > 0) {
    mobileInput.consumeAnyPress();
    defeatFreezeTimer = Math.max(0, defeatFreezeTimer - dt);
    updateFrozenPresentation(dt);
    if (defeatFreezeTimer <= 0) startRetryLesson(true);
    localInput.endFrame();
    return;
  }

  if (finalePresentation) {
    mobileInput.consumeAnyPress();
    finaleElapsed += dt;
    const canContinue = finaleElapsed >= FINALE_MIN_READ_S;
    finale.update(finaleElapsed, FINALE_REVEAL_S, canContinue, dt);
    updateFrozenPresentation(dt, 'finished', true);
    if (!expansionGallery.visible() && canContinue) {
      const focusLeft = input.consumePress('ArrowLeft') || input.consumePress('ArrowUp') || gamepadInput.consumeSelectLeft();
      const focusRight = input.consumePress('ArrowRight') || input.consumePress('ArrowDown') || gamepadInput.consumeSelectRight();
      if (focusLeft) finale.moveFocus(-1);
      if (focusRight) finale.moveFocus(1);
      if (enterPressed || spaceConfirmPressed || gamepadConfirm) finale.activateFocused();
    }
    localInput.endFrame();
    return;
  }

  if ((enterPressed || spaceConfirmPressed || retryPressed || gamepadConfirm) && race.phase === 'finished') requestRetry();

  if (race.phase === 'ready') {
    const mobileGo = mobileInput.consumeGoRequest();
    const selectLeft = input.consumePress('ArrowLeft') || input.consumePress('KeyA');
    const selectRight = input.consumePress('ArrowRight') || input.consumePress('KeyD');
    if (!freshStartPending && (selectLeft || gamepadInput.consumeSelectLeft())) driverSelect.move(-1);
    if (!freshStartPending && (selectRight || gamepadInput.consumeSelectRight())) driverSelect.move(1);
    mobileInput.consumeAnyPress();
    mobileInput.setControlPhase('inactive');
    driverSelect.updateControllerStatus(gamepadInput.status());
    driverSelect.setCoachStatus(drivingCoach.progress.status);
    if (!frozenDesktopReady) updateRaceCamera(dt, presentationTime, primaryBoat());
    applyHarnessCameraOverride();
    const readySceneTime = openingShowcase.active ? presentationTime : worldTime;
    ocean.update(readySceneTime, stage.camera.position);
    sky.update(readySceneTime, stage.camera.position);
    for (const boat of boats) boat.syncSurfacePresentation(readySceneTime);
    for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, readySceneTime);
    openingShowcase.update(dt);
    course.update(0, readySceneTime);
    honorTargets.update(dt, readySceneTime, [], race.racers, honorHitScratch, false);
    for (const entry of activeTowers()) entry.update(dt, race);
    hud.update(dt, race, boats[0], boats);
    pipeline.update(dt, worldTime, boats[0].state, 'ready');
    audio.update(dt);
    if (enterPressed || spaceConfirmPressed || mobileGo || gamepadConfirm) queueFreshStart();
    if (freshStartPending && openingShowcase.finished && immersive.goStartReady()) startFreshCountdown();
    localInput.endFrame();
    return;
  }

  if (race.phase === 'countdown' || race.phase === 'resume-countdown') {
    const resuming = race.phase === 'resume-countdown';
    gamepadInput.consumeFlight();
    mobileInput.consumeAnyPress();
    mobileInput.setControlPhase(resuming ? 'preparing' : 'inactive');
    race.update(dt);
    if (!resuming) {
      worldTime += dt;
      updateRaceCamera(dt, presentationTime, primaryBoat());
      applyHarnessCameraOverride();
      ocean.update(worldTime, stage.camera.position);
      sky.update(worldTime, stage.camera.position);
      for (const boat of boats) boat.syncSurfacePresentation(worldTime);
      for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, worldTime);
      course.update(0, worldTime);
    }
    honorTargets.update(dt, worldTime, [], race.racers, honorHitScratch, false);
    for (const entry of activeTowers()) entry.update(dt, race);
    hud.update(dt, race, boats[0], boats);
    if (!resuming) {
      pcPrimerPresentation = pcControlPrimer.update(dt, {
        state: boats[0].state,
        racing: false,
        launchCueActive: false,
        keyboardActive: activeInputDevice === 'keyboard',
        presentationBlocked: false,
      });
      hud.showPcControlPrimer(pcPrimerPresentation, pcPrimerPresentation !== null, pcControlPrimer.active);
    }
    pipeline.update(dt, worldTime, boats[0].state, race.phase);
    audio.update(dt);
    localInput.endFrame();
    return;
  }

  const waitingForMobile = mobileInput.enabled && !mobileInput.ready && !gamepadInput.connected && !HARNESS;
  const racing = race.phase === 'racing' && !waitingForMobile;
  mobileInput.setControlPhase(racing && (!HARNESS || params.has('mobile')) ? 'racing' : 'inactive');

  // Inputs: player keyboard (or AI autopilot in harness), AI for the rest.
  const duoMode = isDuoMode();
  const focusBoatBeforeInput = primaryBoat();
  const flightActive = focusBoatBeforeInput.state.flightPhase !== 'surface';
  let playerInput = ZERO_INPUT;
  const duoPlayerInputs: Array<BoatInput | null> = [null, null];
  if (racing) {
    if (duoMode) {
      for (let id = 0; id < 2; id++) {
        if (race.racers[id].eliminated) continue;
        const state = boats[id].state;
        duoPlayerInputs[id] = localInput.readBoat(duoDevices[id], dt, {
          flightActive: state.flightPhase !== 'surface',
          manualThrottle: false,
          autoForward: true,
        });
      }
      playerInput = duoPlayerInputs[0] ?? ZERO_INPUT;
    } else {
      const keyboardInput = input.read(dt, flightActive);
      const padInput = gamepadInput.read(flightActive);
      if (mobileInput.enabled) {
        const touchInput = mobileInput.read(dt, flightActive);
        playerInput = {
          throttle: 1,
          steer: input.steeringHeld() ? keyboardInput.steer : gamepadInput.steeringHeld() ? padInput.steer : touchInput.steer,
          drift: keyboardInput.drift || padInput.drift || touchInput.drift,
          flightTrigger: keyboardInput.flightTrigger || padInput.flightTrigger || touchInput.flightTrigger,
          airBrake: keyboardInput.airBrake || padInput.airBrake || touchInput.airBrake,
        };
      } else {
        playerInput = {
          throttle: 1,
          steer: input.steeringHeld() ? keyboardInput.steer : gamepadInput.steeringHeld() ? padInput.steer : keyboardInput.steer,
          drift: keyboardInput.drift || padInput.drift,
          flightTrigger: keyboardInput.flightTrigger || padInput.flightTrigger,
          airBrake: keyboardInput.airBrake || padInput.airBrake,
        };
      }
    }
  }
  if (!retryLessonActive) mobileInput.consumeAnyPress();
  if (!racing) input.consumePress('Space'); // never buffer a flight press through the countdown
  worldTime += dt;
  rivalDirector.update(dt, race.racers, focusBoatBeforeInput.state.flightsCleared, race.player().id);
  const activeBoats = activeRaceBoats();
  if (racing) collisions.capture(activeBoats);
  for (let i = 0; i < boats.length && racing; i++) {
    if (duoMode && race.racers[i].eliminated) continue;
    if (i > 0) boats[i].setOpponentEffectDistance(boats[i].state.position.distanceTo(focusBoatBeforeInput.state.position));
    const rivalControl = rivalDirector.controlFor(i);
    let inp: BoatInput;
    if (!racing) {
      inp = ZERO_INPUT;
    } else if (duoMode && i < 2) {
      inp = duoPlayerInputs[i] ?? ZERO_INPUT;
    } else if (i === 0 && !HARNESS) {
      inp = playerInput;
    } else if (i === 0 && harnessUsePlayerInput) {
      inp = playerInput;
    } else if (i === 0 && harnessPlayerInput) {
      inp = harnessPlayerInput;
    } else {
      inp = ais[i].update(
        dt,
        boats[i],
        boats,
        race.racers[i].progress,
        race.player().progress,
        rivalControl,
        rivalDirector.techniqueFor(i),
        rivalDirector.openingFor(i),
        rivalDirector.chainFor(i),
      );
    }
    if (i === 0 && HARNESS && harnessRoutePilotIndex === 2 && !harnessUsePlayerInput &&
        !harnessPlayerInput && boats[0].state.flightPhase !== 'surface') {
      inp = { ...inp, steer: harnessThirdFlightSteer() };
    }
    if (i === 0 && harnessForceAirBrake && boats[0].state.flightPhase !== 'surface') {
      inp = { ...inp, drift: false, airBrake: true };
    }
    if (i === 0 && harnessSuppressAirborneFlightTrigger && boats[0].state.flightPhase !== 'surface') {
      inp = { ...inp, flightTrigger: false };
    }
    if (i === 0 && harnessFlightTriggerPulse) inp = { ...inp, flightTrigger: true };
    const harnessOverride = HARNESS ? harnessBoatInputOverrides[i] : null;
    if (harnessOverride) inp = { ...inp, ...harnessOverride };
    const finalReturnBrake = i === race.player().id && course.finalStationArmed();
    if (finalReturnBrake) {
      const returnBrake = inp.drift || inp.airBrake;
      inp = { ...inp, drift: false, airBrake: returnBrake, flightTrigger: false };
    }
    if (HARNESS) Object.assign(harnessLastBoatInputs[i], inp);
    boats[i].update(
      dt,
      inp,
      worldTime,
      finalReturnBrake ? 'return-brake' : 'drift',
      rivalControl.surfaceTargetScale,
      rivalControl.flightTargetScale,
      wakes,
    );
    if (i === 0) harnessFlightTriggerPulse = false;
  }

  if (racing) {
    // Each screen keeps its fixed seat layer while global coach/audio feedback
    // follows the surviving human promoted by Race.
    if (isDuoMode()) course.setGuidanceOwners([0, 1], race.player().id);
    else course.setGuidanceBoat(race.player().id);
    course.updateFlightRoute(dt, boats);
  }

  const playerPassedFlights: number[] = [];
  if (racing) {
    for (let i = 0; i < boats.length; i++) {
      if (duoMode && race.racers[i].eliminated) continue;
      const state = boats[i].state;
      const routeState = state.flightRouteState;
      if (duoMode && i < 2 && routeState === 'failed' && state.flightPhase === 'surface') {
        if (state.flightFailure) eliminateDuoSeat(i, state.flightFailure);
        routeLifecycleStates[i] = state.flightRouteState;
        continue;
      }
      if ((i > 0 || (HARNESS && harnessKeepFlightMissRunning)) &&
          routeState === 'failed' && state.flightPhase === 'surface') {
        boats[i].recoverFailedFlightRoute();
        routeLifecycleStates[i] = boats[i].state.flightRouteState;
        harnessPrevRouteStates[i] = boats[i].state.flightRouteState;
        continue;
      }
      if (HARNESS && routeState !== harnessPrevRouteStates[i]) {
        if (routeState === 'passed') harnessRoutePasses[i]++;
        else if (routeState === 'failed') harnessRouteFails[i]++;
        harnessPrevRouteStates[i] = routeState;
      }
      if (isHumanRacer(i)) {
        if (state.airborne) {
          maxCorridorDangerThisFlight[i] = Math.max(maxCorridorDangerThisFlight[i], course.playerCorridorDanger);
          if (state.flightAirBrake > 0.28) airBrakedThisFlight[i] = true;
        }
        if (state.drifting) {
          maxDriftYawRateThisDrift[i] = Math.max(maxDriftYawRateThisDrift[i], Math.abs(state.steer));
        }
      }
      if (routeState === routeLifecycleStates[i]) continue;
      routeLifecycleStates[i] = routeState;
      if (routeState === 'failed') {
        if (i === 0 && !duoMode && !(HARNESS && harnessKeepFlightMissRunning)) {
          if (state.flightFailure) race.defeatFlight(state.flightFailure);
        }
      } else if (routeState === 'passed') {
        if (isHumanRacer(i)) {
          playerPassedFlights.push(i);
          honors.award('flight.ace', i, HONOR_DEFINITIONS['flight.ace'].value, race.raceTime);
          if (maxCorridorDangerThisFlight[i] >= 0.38) {
            honors.award('flight.clutch', i, HONOR_DEFINITIONS['flight.clutch'].value, race.raceTime);
          }
          if (state.speed >= 49.0) {
            honors.award('flight.speed', i, HONOR_DEFINITIONS['flight.speed'].value, race.raceTime);
          }
          if (airBrakedThisFlight[i]) {
            honors.award('airbrake.master', i, HONOR_DEFINITIONS['airbrake.master'].value, race.raceTime);
          }
          maxCorridorDangerThisFlight[i] = 0;
          airBrakedThisFlight[i] = false;
        }
      }
    }
  }
  if (!waitingForMobile && race.phase === 'racing') race.update(dt);
  if (racing && race.phase === 'racing' && race.raceTime > 3) {
    for (let id = 0; id < 2; id++) {
      if (!isHumanRacer(id)) continue;
      const racer = race.racers[id];
      if (!racer || racer.eliminated) continue;
      if (!comebackAwarded[id] && previousHumanPlaces[id] > 3 && racer.place <= 3) {
        comebackAwarded[id] = true;
        honors.award('comeback.sailor', id, HONOR_DEFINITIONS['comeback.sailor'].value, race.raceTime);
      }
      if (racer.place === 1) {
        const second = race.racers.find((r) => r.id !== id && r.place === 2);
        if (second && racer.progress - second.progress >= 35) {
          leadDominanceTimer[id] += dt;
          if (leadDominanceTimer[id] >= 8.0 && !leadDominanceAwarded[id]) {
            leadDominanceAwarded[id] = true;
            honors.award('lead.dominance', id, HONOR_DEFINITIONS['lead.dominance'].value, race.raceTime);
          }
        } else {
          leadDominanceTimer[id] = Math.max(0, leadDominanceTimer[id] - dt * 2);
        }
      }
      previousHumanPlaces[id] = racer.place;
    }
  }
  if (racing && race.phase === 'racing') {
    const hits = collisions.resolve(activeBoats);
    const collisionDebug = collisions.debugState();
    // Preserve route-projection continuity on untouched frames. Re-basing
    // every frame lets a continuous cross-course shortcut become the new
    // legal segment; only an actual contact correction needs absorption.
    if (collisionDebug.maxCorrection > 0) {
      course.syncFlightTrackingAfterCollisions(activeBoats);
      race.syncCollisionCorrections();
    }
    presentPlayerCollisions(hits);
    presentBuoyHits(course.applyBuoyHits(activeBoats, buoyHitScratch));
    presentBalloonPops(course.consumeBalloonPops(balloonPopScratch));
    honorTargets.update(dt, worldTime, activeBoats, race.racers, honorHitScratch, true);
    presentHonorHits(honorHitScratch);
  }
  let enteredMedal = false;
  for (const passedId of playerPassedFlights) {
    if (race.phase !== 'racing') break;
    const flights = boats[passedId].state.flightsCleared;
    if (flights >= 4) rivalDirector.releaseFormation();
    const pass = records.recordFlightPass(flights, roster[passedId]?.profileId ?? selectedDriverId);
    newBestThisRun ||= pass.newBest;
    // Both seats fly, so a pass, a qualification, and a Final arm belong to the
    // seat that earned them, not to whichever half the camera happens to own.
    const passLane: 'left' | 'center' | 'right' = !duoMode ? 'center' : passedId === 0 ? 'left' : 'right';
    hud.showFlightPass(flights, pass.bestFlights, pass.newBest, passLane);
    tower.announceFlight(flights, pass.bestFlights);
    if (flights === 3 && race.challengeTier === 'unqualified') {
      drivingCoach.markExpert();
      syncDrivingCoachUi();
      const tier = race.qualifyChallenge();
      const qualification = records.qualifyRun(race.raceTime);
      medalEarnedThisRun = true;
      ordinaryNewThisRun = qualification.ordinaryNew;
      if (tier !== 'unqualified') {
        if (duoMode) {
          // A shared six-boat race must not freeze the other human just because
          // one seat reached the three-flight qualification milestone first.
          hud.showTransientNotice(
            `${roster[passedId]?.name ?? '选手'} 已获三飞资格 · 双打继续竞速`,
            '资格已记录',
            passLane,
          );
        } else {
          startMedalCeremony(tier, qualification.manMedalsTotal, pass.bestFlights);
          enteredMedal = true;
        }
      }
    } else if (!harnessEndlessMode && flights > 0 && flights % course.flightRoutes.length === 0 && race.armFinale()) {
      course.armFinalStation();
      hud.showFinalReady(passLane);
      tower.announceFlight(flights, pass.bestFlights);
      pipeline.pulse('finish', 0.55);
      trackGameEvent('final_station_armed', { run: currentRun, flights, elapsed: race.raceTime });
    }
  }
  if (duoMode && race.phase === 'racing') {
    duoInteractions.update(dt, race.racers, boats, duoDevices, localInput, handleDuoInteraction);
  }
  if (race.challengeTier === 'excellent' && !excellentRecordedThisRun) {
    const excellent = records.recordExcellent(race.raceTime);
    excellentRecordedThisRun = true;
    if (previousChallengeTier === 'ordinary') hud.showExcellentLocked(excellent.excellentTotal);
  }
  previousChallengeTier = race.challengeTier;

  const focusBoat = primaryBoat();
  const playerState = focusBoat.state;
  // Every event edge is evaluated once per human seat. A single pass keyed to
  // the primary seat is why the second player's gates, buffs and air-brake
  // snaps were completely silent while the first player heard all of them.
  const feedbackSeats = isDuoMode() ? DUO_FEEDBACK_SEATS : SOLO_FEEDBACK_SEATS;
  for (const seat of feedbackSeats) {
    const racer = race.racers[seat];
    if (!racer || racer.eliminated) continue;
    const state = boats[seat].state;
    const edge = seatEdges[seat];
    const seatCamera = isDuoMode() ? (seat === 0 ? teamLeftCameraRig : teamRightCameraRig) : cameraRig;
    const seatPipeline = isDuoMode() ? (seat === 0 ? teamLeftPipeline : teamRightPipeline) : pipeline;
    const feedbackHaptics = seatHaptics[seat];
    if (state.drifting && !edge.drifting && state.speed > 12) feedbackHaptics.cue('drift-active');
    if (state.driftReleaseReady && !edge.driftReleaseReady) {
      audio.driftReleaseReady();
      feedbackHaptics.cue('drift-ready');
    }
    if (state.flightCharges > edge.flightCharges) {
      if (state.speed >= 36) {
        honors.award('perfect.charge', seat, HONOR_DEFINITIONS['perfect.charge'].value, race.raceTime);
      }
      audio.flightReady(state.flightCharges);
      seatCamera.flightReadyKick();
      seatPipeline.pulse('ready');
      const stockIntensity = 0.82 + 0.18 * Math.max(0, state.flightCharges - 1) /
        Math.max(1, MAX_FLIGHT_CHARGES - 1);
      feedbackHaptics.cue('charge', stockIntensity);
    }
    if (state.flightExtended) {
      audio.flightExtend();
      seatCamera.flightExtendKick();
      seatPipeline.pulse('ready', 0.68);
      feedbackHaptics.cue('extend');
    }
    if (state.boosting && !edge.boosting) {
      if (maxDriftYawRateThisDrift[seat] >= 0.7 && state.speed >= 36) {
        honors.award('drift.apex', seat, HONOR_DEFINITIONS['drift.apex'].value, race.raceTime);
      }
      maxDriftYawRateThisDrift[seat] = 0;
      seatPipeline.pulse('boost', 0.92);
      feedbackHaptics.cue('boost');
    }
    if (state.flightPhase === 'spool' && edge.flightPhase !== 'spool') {
      seatPipeline.pulse('launch', 1.05);
      feedbackHaptics.cue('launch');
    }
    const airBraking = state.flightPhase !== 'surface' && state.flightAirBrake > 0.28;
    if (airBraking && !edge.airBraking) {
      audio.airBrakeSnap();
      feedbackHaptics.cue('air-brake');
    }
    if (state.flightGateProgress > edge.flightGateProgress) {
      const flightNumber = Math.max(1, state.flightsCleared);
      const feedbackStep = Math.min(3, ((flightNumber - 1) % 3) + 1);
      audio.flightGate(feedbackStep);
      seatCamera.flightGateKick(feedbackStep);
      seatPipeline.pulse('gate', flightNumber === 3 ? 0.72 : 0.4);
      feedbackHaptics.cue('gate');
    }
    if (state.flightRouteState !== edge.flightRouteState) {
      if (state.flightRouteState === 'passed') {
        audio.routeClear(Math.min(3, ((state.flightsCleared - 1) % 3) + 1));
      }
      else if (state.flightRouteState === 'failed') seatCamera.routeMissKick();
    }
    edge.flightCharges = state.flightCharges;
    edge.driftReleaseReady = state.driftReleaseReady;
    edge.flightGateProgress = state.flightGateProgress;
    edge.flightRouteState = state.flightRouteState;
    edge.flightPhase = state.flightPhase;
    edge.boosting = state.boosting;
    edge.airBraking = airBraking;
    edge.drifting = state.drifting;
    const seatTurnWarning = course.flightTurnWarning(seat);
    if (seatTurnWarning && !edge.turnWarning) feedbackHaptics.cue('warning');
    edge.turnWarning = seatTurnWarning;
  }
  const turnWarning = course.flightTurnWarning(focusBoat.id);

  const controls = activeCoachControls();
  coachPresentation = drivingCoach.update(dt, {
    state: playerState,
    input: HARNESS && harnessPlayerInput ? harnessPlayerInput : playerInput,
    launchCueActive: course.guidanceStatus().actionCue === 'launch',
    turnWarning,
    presentationBlocked: hud.coachPresentationBlocked() || turnWarning,
  }, controls);
  if (turnWarning && coachPresentation?.id !== 'air-brake') coachPresentation = null;
  pcPrimerPresentation = pcControlPrimer.update(dt, {
    state: playerState,
    racing: race.phase === 'racing',
    launchCueActive: course.guidanceStatus().actionCue === 'launch',
    keyboardActive: activeInputDevice === 'keyboard',
    presentationBlocked: hud.coachPresentationBlocked() || turnWarning || coachPresentation !== null,
  });
  const coachPrimerPresentation = coachPresentation && activeInputDevice === 'keyboard' &&
      (coachPresentation.focus === 'drift-control' || coachPresentation.focus === 'drift-meter')
    ? {
        step: coachPresentation.id === 'release' ? 'release' as const :
          coachPresentation.id === 'bank' ? 'charging' as const : 'drift' as const,
        key: controls.drift,
        kicker: coachPresentation.kicker,
        title: coachPresentation.title,
        detail: coachPresentation.detail,
        tone: coachPresentation.tone === 'warning' ? 'warning' as const : 'drift' as const,
        progress: playerState.driftBankProgress,
        ready: playerState.driftReleaseReady,
      }
    : null;
  hud.showPcControlPrimer(
    coachPrimerPresentation ?? pcPrimerPresentation,
    pcPrimerPresentation !== null,
    pcControlPrimer.active || coachPresentation?.focus === 'flight-control',
  );

  // Landing feedback: the controller thuds on every real water re-entry
  // (floored so soft flight recoveries still read); camera shake + audio
  // stay reserved for slams.
  for (let i = 0; i < boats.length; i++) {
    const imp = boats[i].state.landImpulse;
    if (i === focusBoat.id && imp > 3) {
      haptics.impact('landing', Math.max(0.5, Math.min(1, imp / 14)), false);
    }
    if (imp > 7) {
      if (i === focusBoat.id) {
        cameraRig.shake(Math.min(1, imp / 16));
        audio.thud(Math.min(1, imp / 14));
        // Opponent splashes remain visual-only until a spatial environment
        // sample is explicitly approved; otherwise pile-ups sound like an
        // unexplained noise wall at the player's position.
        audio.splash(Math.min(1, imp / 12));
      }
    }
  }

  // Alongside rivals trade glances. Pure presentation: the rider turns its
  // head; an 8s per-rider cooldown keeps it a spice.
  if (race.phase === 'racing') {
    for (let i = 0; i < boats.length; i++) {
      const bi = boats[i].state;
      if (bi.flightPhase !== 'surface' || bi.speed < 14 || race.racers[i].finished) continue;
      const fwdX = Math.sin(bi.heading);
      const fwdZ = Math.cos(bi.heading);
      for (let k = 0; k < boats.length; k++) {
        if (k === i) continue;
        const bk = boats[k].state;
        if (bk.flightPhase !== 'surface' || race.racers[k].finished) continue;
        const relX = bk.position.x - bi.position.x;
        const relZ = bk.position.z - bi.position.z;
        const along = relX * fwdX + relZ * fwdZ;
        const side = relX * fwdZ - relZ * fwdX; // + = to port (rider's left)
        if (Math.abs(along) < 4.5 && Math.abs(side) > 1.6 && Math.abs(side) < 7.5) {
          riders[i].taunt(side, worldTime);
          break;
        }
      }
    }
  }
  for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, worldTime);

  updateRaceCamera(dt, worldTime, focusBoat);
  applyHarnessCameraOverride();
  ocean.update(worldTime, stage.camera.position);
  sky.update(worldTime, stage.camera.position);
  course.update(dt, worldTime);
  for (let i = 0; i < boats.length; i++) wakes[i].update(dt, worldTime);
  spray.update(dt, worldTime);
  feathers.update(dt, worldTime);
  jetTrail.update(dt);

  const ps = focusBoat.state;
  // Each tower follows its own seat: one seat entering flight must not blank
  // the other seat's standings or block its team radio.
  const seatTowers = activeTowers();
  for (let seat = 0; seat < seatTowers.length; seat++) {
    seatTowers[seat].update(
      dt,
      race,
      boats[seat].state.flightPhase !== 'surface',
      turnWarning || coachPresentation !== null || pcPrimerPresentation !== null || hud.flightPromptVisible() ||
        hud.coachPresentationBlocked(),
    );
  }
  hud.update(dt, race, focusBoat, boats);
  updateDuoViewportHud();
  const routeGuidance = course.guidanceStatus();
  mobileInput.setActionState(
    deriveAbilityHudState(ps, course.finalStationArmed()),
    course.flightTurnWarning(focusBoat.id),
    routeGuidance.actionCue,
    routeGuidance.actionDirection,
  );
  // Position the education slot only after the objective block, race tower,
  // near-boat meter, and contextual thumb controls have their final geometry
  // for this frame. Measuring earlier leaves the card one layout frame stale.
  hud.showCoach(coachPresentation);

  audio.setScene(enteredMedal ? 'medal' : ps.flightPhase === 'surface' ? 'racing' : 'flight');
  audio.setEngine(ps.rpm, ps.throttle, ps.boosting);
  audio.setWaterRush(Math.min(1, Math.abs(ps.speed) / 34));
  audio.setAirborne(ps.airborne);
  audio.setFlight(
    ps.flightThrust,
    ps.flightPhase !== 'surface',
    ps.flightPressure,
    Math.max(0, ps.flightClearance),
    ps.flightPhase === 'surface' ? 0 : ps.flightAirBrake,
    ps.steer,
    ps.flightRouteIndex >= 0 ? ps.flightRouteIndex : ps.flightsCleared,
  );
  audio.setDrift(ps.drifting ? Math.min(1, ps.boostCharge * 0.75 + Math.abs(ps.lateralG) / 18) : 0);
  if (ps.flightRouteMiss) audio.flightMiss();
  // Corridor storm: one continuous danger level drives camera rumble, the
  // wind-shear cue, the HUD banner and haptics. Band entries are real events
  // — camera jolt + full-motor slam — so the shift into 失控 is felt, not
  // just numerically closer to the fail.
  const corridorDanger = race.phase === 'racing' ? course.corridorDangerFor(focusBoat.id) : 0;
  const corridorStage = corridorDanger >= 0.45 ? 2 : corridorDanger > 0.01 ? 1 : 0;
  cameraRig.setDistress(corridorDanger);
  audio.setCorridorDanger(corridorDanger);
  hud.setCorridorDanger(corridorDanger);
  haptics.setStorm(corridorDanger);
  if (corridorStage > prevCorridorStage) {
    if (corridorStage === 2) {
      cameraRig.stormKick();
      haptics.cue('storm-critical');
    } else {
      haptics.cue('storm-edge');
    }
  }
  prevCorridorStage = corridorStage;
  pipeline.update(dt, worldTime, ps, race.phase);
  if (isDuoMode()) {
    teamLeftPipeline.update(dt, worldTime, boats[0].state, race.phase);
    teamRightPipeline.update(dt, worldTime, boats[1].state, race.phase);
  }

  // Failures freeze for one impact beat and then enter the adaptive loading
  // loop directly. The legacy finished branch remains available to scripted modes.
  if ((race.phase === 'finished' || race.phase === 'defeated') && !resultsShown) {
    resultsShown = true;
    cameraRig.mode = race.phase === 'defeated' ? 'defeat' : 'chase';
    if (race.phase === 'defeated') {
      cameraRig.defeatKick();
      audio.setScene('defeat');
      audio.defeat();
      pipeline.pulse('defeat', 1.35);
      if (race.challengeResult) {
        const progressBest = records.recordFailure(race.challengeResult);
        pendingFailureNewBest = newBestThisRun || progressBest;
        race.challengeResult.ordinaryNew = ordinaryNewThisRun;
        records.decorateResult(race.challengeResult, pendingFailureNewBest, medalEarnedThisRun);
      }
      defeatFreezeTimer = DEFEAT_FREEZE_S;
      retryLessonFrozenT = worldTime;
      input.reset();
      gamepadInput.reset();
      mobileInput.reset();
      mobileInput.setControlPhase('inactive');
      haptics.cue('defeat');
      coachPresentation = null;
      hud.showCoach(null);
      pcControlPrimer.stop();
      pcPrimerPresentation = null;
      hud.showPcControlPrimer(null);
    } else {
      beginFinalePresentation();
    }
  }
  audio.update(dt);
  localInput.endFrame();
}

const renderDrawingSize = new THREE.Vector2();

function render(frameMs: number): void {
  stage.renderer.info.reset(); // autoReset is off: gather whole-frame stats
  sky.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  ocean.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  course.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  honorTargets.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
  const splitFrame = appMode === 'team-play' || isDuoSplitPhase();
  if (splitFrame) {
    renderTeamSplit();
  } else {
    applyHarnessCameraOverride();
    stage.renderer.getDrawingBufferSize(renderDrawingSize);
    ocean.uniforms.uDepthTex.value = prePass.depthTexture;
    ocean.setResolution(renderDrawingSize.x, renderDrawingSize.y, stage.camera.fov);
    pipeline.render();
    processCaptureQueue();
  }
  // Split play renders the frame twice inside one rAF budget. Without the view
  // count the governor reads that as a slow machine and shaves resolution until
  // both halves look soft.
  stage.updatePerf(frameMs, splitFrame ? 2 : 1);
}

function renderTeamSplit(): void {
  const drawing = stage.renderer.getDrawingBufferSize(renderDrawingSize);
  const halfWidth = Math.max(1, Math.floor(drawing.x / 2));

  // A dead seat becomes a spectator window for the surviving racer. Keep the
  // camera and its private route layer pointed at the same boat; otherwise a
  // swapped camera would show an empty ocean while the survivor's mist route
  // remained on the other layer.
  const leftGuideOwner = isDuoMode() && race.racers[0]?.eliminated ? 1 : 0;
  const rightGuideOwner = isDuoMode() && race.racers[1]?.eliminated ? 0 : 1;
  setDuoGuidanceCameraLayers(teamLeftCamera, leftGuideOwner);
  setDuoGuidanceCameraLayers(teamRightCamera, rightGuideOwner);

  ocean.uniforms.uDepthTex.value = teamLeftPrePass.depthTexture;
  course.activateGuidanceView(leftGuideOwner, worldTime);
  ocean.setResolution(halfWidth, drawing.y, teamLeftCamera.fov);
  ocean.update(worldTime, teamLeftCamera.position);
  sky.update(worldTime, teamLeftCamera.position);
  const left = teamLeftPipeline.renderToTexture();

  ocean.uniforms.uDepthTex.value = teamRightPrePass.depthTexture;
  course.activateGuidanceView(rightGuideOwner, worldTime);
  ocean.setResolution(halfWidth, drawing.y, teamRightCamera.fov);
  ocean.update(worldTime, teamRightCamera.position);
  sky.update(worldTime, teamRightCamera.position);
  const right = teamRightPipeline.renderToTexture();

  splitScreen.render(left, right);
  course.activateGuidanceView(leftGuideOwner, worldTime);
  ocean.uniforms.uDepthTex.value = prePass.depthTexture;
}

function setDuoGuidanceCameraLayers(camera: THREE.Camera, ownerId: number): void {
  const right = ownerId === 1;
  const activeGuide = right ? LAYER_GUIDE_RIGHT : LAYER_GUIDE_LEFT;
  const inactiveGuide = right ? LAYER_GUIDE_LEFT : LAYER_GUIDE_RIGHT;
  const activeEnergy = activeGuide + 2;
  const inactiveEnergy = inactiveGuide + 2;
  camera.layers.enable(activeGuide);
  camera.layers.disable(inactiveGuide);
  camera.layers.enable(activeEnergy);
  camera.layers.disable(inactiveEnergy);
}

function processCaptureQueue(): void {
  if (finaleCapturePending && finaleElapsed >= FINALE_CAPTURE_S) {
    finaleCapturePending = false;
    void createFinaleCapture();
  }
}

const loop = new Loop(step, render);
let interruptionPadRaf = 0;

function stopInterruptionPadPoll(): void {
  cancelAnimationFrame(interruptionPadRaf);
  interruptionPadRaf = 0;
}

function startInterruptionPadPoll(): void {
  if (HARNESS || interruptionPadRaf || document.hidden || !interruptionActive) return;
  const poll = () => {
    interruptionPadRaf = 0;
    if (document.hidden || !interruptionActive) return;
    localInput.poll();
    gamepadInput.poll();
    let resume = duoPauseActive ? false : gamepadInput.consumeConfirm();
    let exit = false;
    if (duoPauseActive) {
      for (const id of duoDevices) {
        resume ||= localInput.confirmEdge(id);
        exit ||= localInput.cancelEdge(id);
      }
    }
    if (exit) {
      exitDuoPause();
      localInput.endFrame();
      return;
    }
    if (resume) {
      resumeInterruption();
      localInput.endFrame();
      return;
    }
    localInput.endFrame();
    interruptionPadRaf = requestAnimationFrame(poll);
  };
  interruptionPadRaf = requestAnimationFrame(poll);
}

function handleVisibility(hidden: boolean): void {
  audio.setVisibility(hidden);
  if (appMode === 'team-play') {
    localInput.reset();
    if (hidden) {
      if (teamExpedition.snapshot().phase !== 'finished') {
        teamPaused = true;
        teamExperience.showTransition('TEAM PAUSE', '协作暂停', '画面与计时已冻结 · 返回后按确认继续', 0, true);
      }
      if (!HARNESS) loop.stop();
    } else if (!HARNESS) {
      loop.start();
      requestAnimationFrame(() => render(16.7));
    }
    return;
  }
  haptics.stop();
  input.reset();
  gamepadInput.reset();
  mobileInput.reset();
  mobileInput.setControlPhase('inactive');
  if (hidden) {
    stopInterruptionPadPoll();
    pageWasHidden = true;
    interruptionNeedsCountdown = race.phase === 'racing' || race.phase === 'countdown' || race.phase === 'resume-countdown';
    interruptionActive = race.phase !== 'ready' && !capturePreview.visible();
    if (!HARNESS) loop.stop();
    return;
  }
  if (!pageWasHidden) return;
  pageWasHidden = false;
  if (capturePreview.visible()) {
    interruptionActive = false;
    audio.resume();
    if (!HARNESS) loop.start();
    return;
  }
  if (race.phase === 'ready') {
    if (!HARNESS) loop.start();
    return;
  }
  interruptionActive = true;
  hud.showInterruption(interruptionNeedsCountdown);
  startInterruptionPadPoll();
  if (!HARNESS) requestAnimationFrame(() => render(16.7));
}

document.addEventListener('visibilitychange', () => handleVisibility(document.hidden));
window.addEventListener('keydown', (event) => {
  if (interruptionActive && duoPauseActive && ['Escape', 'KeyQ', 'KeyU'].includes(event.code) && !event.repeat) {
    event.preventDefault();
    exitDuoPause();
    return;
  }
  if (interruptionActive && duoPauseActive &&
      ['Enter', 'Space', 'NumpadEnter', 'KeyI'].includes(event.code) && !event.repeat) {
    event.preventDefault();
    resumeInterruption();
    return;
  }
  if (interruptionActive && (event.code === 'Enter' || event.code === 'Space') && !event.repeat) {
    event.preventDefault();
    resumeInterruption();
    return;
  }
  // Keep the request inside the trusted READY keydown. The fixed-step loop
  // still consumes the edge and starts the countdown on its normal schedule.
  if (appMode === 'independent' && race.phase === 'ready' && !freshStartPending &&
      (event.code === 'Enter' || event.code === 'Space') && !event.repeat) {
    immersive.requestGo();
  }
});

// ---------------------------------------------------------------- harness
// Deterministic drive-by-wire API for harness/screenshot.mjs. In harness
// mode the rAF pump never runs: the harness advances the sim explicitly
// (all boats AI-driven) and renders single frames on demand.
interface Harness {
  ready: boolean;
  scenario(name: string): void;
  advance(seconds: number): void;
  render(): void;
  tapFlight(): void;
  setFlightCharges(charges: number): void;
  playerState(): Record<string, number | string | boolean>;
  stats(): Record<string, number | string>;
  mobileStatus(): Record<string, number | string | boolean>;
  audioState(): Record<string, number | string | boolean>;
  audioEventLog(): ReadonlyArray<{ source: string; time: number; strength: number }>;
  setVisibility(hidden: boolean): void;
  resumeInterruption(): void;
  collisionCase(name: string): Record<string, number | string | boolean>;
  collisionFeedbackCase(): Record<string, unknown>;
  cameraImpactCase(): Record<string, unknown>;
  radioTechniqueCase(): Record<string, unknown>;
  offCourseRecoveryCase(): Record<string, unknown>;
  finalEligibilityCase(): Record<string, unknown>;
  postSetRankCase(): Record<string, unknown>;
  finaleHonorSequenceCase(leaveVisible?: boolean, testAutoContinue?: boolean): Record<string, unknown>;
  finaleAutoFlowCase(): Record<string, unknown>;
  finalContinueRankCase(): Record<string, unknown>;
  singleHonorCase(): Record<string, unknown>;
  buoyState(): ReturnType<Course['buoyDebugStates']>;
  buoyCase(): Record<string, number | boolean>;
  honorTargetCase(): Record<string, number | string | boolean>;
  riderPoseState(): ReturnType<Rider['poseDebug']>;
  riderHairState(): ReturnType<Rider['hairDebug']>;
  flapCase(): Record<string, unknown>;
  lighthouseState(): ReturnType<LighthouseLandmark['debugState']>;
  faceState(): { active: number; withFaceMesh: number; cacheSize: number };
  sprayState(): {
    spray: ReturnType<SpraySystem['debugState']>;
    boat: ReturnType<Boat['landingDebug']>;
  };
  selectDriver(id: string): void;
  teamFrontDoor(): void;
  teamState(): Record<string, unknown>;
  teamPlaceAtTarget(side: SeatSide): void;
  duoState(): Record<string, unknown>;
  duoGuidanceCase(): Record<string, unknown>;
  duoFeedbackCase(): Record<string, unknown>;
  duoImpactCase(): Record<string, unknown>;
  duoNoticeCase(): Record<string, unknown>;
  duoDriverPowerCase(): Record<string, unknown>;
  qualityGovernorCase(): Record<string, unknown>;
  duoEliminate(id: 0 | 1): void;
  timeOfDayState(): { timeOfDay: TimeOfDay; blend: number; round: number };
  setTimeOfDay(tod: TimeOfDay): void;
}

let harnessUsePlayerInput = false;
let harnessForceAirBrake = false;
let harnessSuppressAirborneFlightTrigger = false;
let harnessKeepFlightMissRunning = false;

function advanceUntil(cond: () => boolean, maxSeconds: number, step = 0.25): void {
  let elapsed = 0;
  while (!cond() && elapsed < maxSeconds) {
    loop.advance(step);
    elapsed += step;
  }
}

const tmpP = new THREE.Vector3();
const tmpT = new THREE.Vector3();
const harnessPilotPoint = new THREE.Vector3();
const harnessPilotTangent = new THREE.Vector3();

const harnessPilotSample: CourseSample = {
  u: 0,
  point: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  distance: 0,
  routeId: 'surface',
};

function harnessThirdFlightSteer(): number {
  const state = boats[0].state;
  const route = course.flightRoutes[2];
  course.sample(state.position, harnessPilotSample, route.id);
  const targetU = Math.min(route.exitU, harnessPilotSample.u + 28 / course.length);
  course.routePointAt(route.id, targetU, harnessPilotPoint);
  course.routeTangentAt(route.id, targetU, harnessPilotTangent);
  const pointError = Math.atan2(
    Math.sin(Math.atan2(harnessPilotPoint.x - state.position.x, harnessPilotPoint.z - state.position.z) - state.heading),
    Math.cos(Math.atan2(harnessPilotPoint.x - state.position.x, harnessPilotPoint.z - state.position.z) - state.heading),
  );
  const tangentError = Math.atan2(
    Math.sin(Math.atan2(harnessPilotTangent.x, harnessPilotTangent.z) - state.heading),
    Math.cos(Math.atan2(harnessPilotTangent.x, harnessPilotTangent.z) - state.heading),
  );
  const error = pointError * 0.58 + tangentError * 0.42;
  return Math.max(-1, Math.min(1, -error * 2.8));
}

/** Place all boats around course position u, staggered like a racing pack. */
function placePack(uPlayer: number): void {
  const offsets = [0, -0.012, -0.006, -0.018, -0.024, -0.03];
  const laterals = [0, 4, -4, 2, -5.5, 5.5];
  for (let i = 0; i < boats.length; i++) {
    const u = (((uPlayer + offsets[i]) % 1) + 1) % 1;
    course.pointAt(u, tmpP);
    course.tangentAt(u, tmpT);
    const heading = Math.atan2(tmpT.x, tmpT.z);
    boats[i].teleport(tmpP.x + tmpT.z * laterals[i], tmpP.z - tmpT.x * laterals[i], heading);
    wakes[i].clear();
  }
}

/** Put real opponents in the player's forward view before a surface hairpin. */
function setHarnessInput(input: Partial<BoatInput> | null): void {
  harnessPlayerInput = input ? {
    throttle: input.throttle ?? 0,
    steer: input.steer ?? 0,
    drift: input.drift ?? false,
    flightTrigger: input.flightTrigger ?? false,
    airBrake: input.airBrake ?? false,
  } : null;
}

function tapHarnessFlight(throttle = 1): void {
  setHarnessInput({ throttle, flightTrigger: true });
  loop.advance(1 / 60);
  setHarnessInput({ throttle, flightTrigger: false });
}

/** Earn through the real drift-release path; combo can launch on the release step. */
function earnHarnessFlight(combo = false): void {
  setHarnessInput({ throttle: 1 });
  let elapsed = 0;
  while (boats[0].state.speed < 18 && elapsed < 5) {
    loop.advance(1 / 60);
    elapsed += 1 / 60;
  }
  setHarnessInput({ throttle: 1, drift: true });
  elapsed = 0;
  while (!boats[0].state.driftReleaseReady && elapsed < 1.5) {
    loop.advance(1 / 60);
    elapsed += 1 / 60;
  }
  if (!boats[0].state.driftReleaseReady) {
    throw new Error('Harness drift never reached the real bank threshold');
  }
  setHarnessInput({ throttle: 1, flightTrigger: combo });
  loop.advance(1 / 60);
  setHarnessInput(null);
}

function launchEarnedHarnessFlight(): void {
  if (boats[0].state.flightCharges < 1) {
    throw new Error('Harness flight launch had no earned charge');
  }
  tapHarnessFlight();
  advanceUntil(() => boats[0].state.flightPhase !== 'surface', 2, 1 / 60);
  if (boats[0].state.flightPhase === 'surface') {
    throw new Error('Harness flight edge never started controlled flight');
  }
}

function assertHarnessRiderPose(scenarioName: string): void {
  const pose = riders[0].poseDebug();
  for (const [side, arm] of Object.entries(pose)) {
    const values = [arm.handGrip, arm.elbowAngle, arm.elbowForward, arm.elbowOut];
    if (!values.every(Number.isFinite) || arm.handGrip > 0.025 ||
        arm.elbowAngle < 0 || arm.elbowAngle > 0.65 ||
        arm.elbowForward < 0.14 || arm.elbowForward > 0.36 ||
        arm.elbowOut < 0 || arm.elbowOut > 0.13) {
      throw new Error(`${scenarioName} ${side} arm failed its IK evidence gate: ${JSON.stringify(arm)}`);
    }
  }
}

function beginHarnessLandingDrop(steer: number): void {
  advanceUntil(() => race.phase === 'racing', 8);
  earnHarnessFlight(false);
  harnessKeepFlightMissRunning = true;
  launchEarnedHarnessFlight();
  const eventBeforeContact = boats[0].landingDebug().event;
  setHarnessInput({ throttle: 1, steer });
  advanceUntil(() => boats[0].state.flightPhase === 'descending', 12, 1 / 60);
  if (boats[0].state.flightPhase !== 'descending') {
    throw new Error('landing drop scenario never reached controlled descent');
  }
  advanceUntil(() => {
    const debug = boats[0].landingDebug();
    return boats[0].state.landImpulse > 0 && debug.event > eventBeforeContact;
  }, 8, 1 / 60);
  const landing = boats[0].landingDebug();
  if (boats[0].state.landImpulse <= 0 || landing.event !== eventBeforeContact + 1) {
    throw new Error(`landing drop expected one controlled contact, got event ${landing.event}`);
  }
  if (steer < 0 && landing.lateralG <= 0) {
    throw new Error(`left landing lost positive lateralG: ${landing.lateralG}`);
  }
  if (steer > 0 && landing.lateralG >= 0) {
    throw new Error(`right landing lost negative lateralG: ${landing.lateralG}`);
  }
  loop.advance(2 / 60);
  const sprayEvidence = spray.debugState();
  if (sprayEvidence.playerLandingEvents !== landing.event ||
      Math.abs(sprayEvidence.lastPlayerLandingBias - landing.lateralBias) > 1e-4) {
    throw new Error('landing drop boat and spray evidence came from different contacts');
  }
  const countImbalance = Math.abs(
    sprayEvidence.lastPlayerPortCount - sprayEvidence.lastPlayerStarboardCount,
  ) / Math.max(1, sprayEvidence.lastPlayerPortCount, sprayEvidence.lastPlayerStarboardCount);
  if (countImbalance > 0.15) {
    throw new Error(`landing drop side counts exceeded tolerance: ${countImbalance}`);
  }
  const maxMeanSpeed = Math.max(
    1e-6,
    sprayEvidence.lastPlayerPortMeanLateralSpeed,
    sprayEvidence.lastPlayerStarboardMeanLateralSpeed,
  );
  const speedImbalance = Math.abs(
    sprayEvidence.lastPlayerPortMeanLateralSpeed - sprayEvidence.lastPlayerStarboardMeanLateralSpeed,
  ) / maxMeanSpeed;
  if (steer === 0 && (Math.abs(landing.lateralG) > 0.5 || speedImbalance > 0.1)) {
    throw new Error(`straight landing lost symmetry: lateralG=${landing.lateralG}, speed=${speedImbalance}`);
  }
  if (steer < 0 && (landing.lateralBias <= 0 ||
      sprayEvidence.lastPlayerPortMultiplier <= sprayEvidence.lastPlayerStarboardMultiplier)) {
    throw new Error(`left landing spray bias reversed: ${landing.lateralBias}`);
  }
  if (steer > 0 && (landing.lateralBias >= 0 ||
      sprayEvidence.lastPlayerPortMultiplier >= sprayEvidence.lastPlayerStarboardMultiplier)) {
    throw new Error(`right landing spray bias reversed: ${landing.lateralBias}`);
  }
  setHarnessInput(null);
  harnessCameraOverride = {
    target: boats[0].object,
    offset: [0, 2.2, -4.8],
    lookAt: [0, 0.8, -1.0],
    fov: 50,
  };
}

function beginHarnessRouteFlight(routeCursor = 0, initialCharges = 1): void {
  const routeIndex = routeCursor % course.flightRoutes.length;
  const route = course.flightRoutes[routeIndex];
  harnessRoutePilotIndex = routeIndex;
  course.resetFlightChallenge();
  placePack(route.entryU - 0.035);
  for (const boat of boats) {
    boat.state.flightsCleared = routeCursor;
    boat.state.flightRouteCursor = routeCursor;
    boat.state.flightRouteIndex = -1;
    boat.state.flightRouteState = 'idle';
  }
  // Staging starts behind the launch window. Flight-charge earning itself is
  // covered separately; route scenarios focus on flight handling and gates.
  boats[0].state.flightCharges = Math.max(1, Math.min(MAX_FLIGHT_CHARGES, Math.round(initialCharges)));
  setHarnessInput(null);
  advanceUntil(() => boats[0].state.flightPhase !== 'surface', 15);
}

function placeHarnessBoat(id: number, u: number, lateral = 0): void {
  const wrappedU = ((u % 1) + 1) % 1;
  course.pointAt(wrappedU, tmpP);
  course.tangentAt(wrappedU, tmpT);
  const heading = Math.atan2(tmpT.x, tmpT.z);
  boats[id].teleport(tmpP.x + tmpT.z * lateral, tmpP.z - tmpT.x * lateral, heading);
  wakes[id].clear();
}

/** Move staged boats in small, non-teleport progress increments for battle UX. */
const collisionFxPoint = new THREE.Vector3();
const buoyHitScratch: BuoyHit[] = [];
const balloonPopScratch: BalloonPop[] = [];
const balloonPopPoint = new THREE.Vector3();

/**
 * Buoy contacts: 20% speed cut and an immediate water hit, followed by the
 * duck balloon's separate forward-moving feather burst.
 */
function presentBuoyHits(hits: readonly BuoyHit[]): void {
  for (const hit of hits) {
    collisionFxPoint.set(hit.x, hit.y, hit.z);
    spray.burst(collisionFxPoint, 8, 4.2);
    if (isHumanRacer(hit.boatId)) {
      audio.collision(3.0);
      if (isDuoMode()) {
        localInput.rumble(duoDevices[hit.boatId as 0 | 1], 0.42, 0.68, 58);
      } else {
        haptics.impact('collision-heavy', 0.5, false);
      }
    }
  }
}

function presentBalloonPops(pops: readonly BalloonPop[]): void {
  for (const pop of pops) {
    balloonPopPoint.set(pop.x, pop.y, pop.z);
    feathers.burst(balloonPopPoint, 48, 9.5, pop.carryX, pop.carryZ);
    if (isHumanRacer(pop.boatId)) {
      audio.balloonPop();
      if (isDuoMode()) {
        localInput.rumble(duoDevices[pop.boatId as 0 | 1], 0.22, 0.58, 48);
      } else {
        haptics.impact('collision-light', 0.3, false);
      }
    }
  }
}

function presentPlayerCollisions(hits: readonly CollisionHit[]): void {
  const humanIds = isDuoMode() ? [0, 1] as const : [0] as const;
  for (const humanId of humanIds) {
    if (race.racers[humanId]?.eliminated) continue;
    let hit: CollisionHit | null = null;
    for (const candidate of hits) {
      if (candidate.strength < 0.8 || (candidate.a !== humanId && candidate.b !== humanId)) continue;
      if (!hit || candidate.strength > hit.strength) hit = candidate;
    }
    if (!hit) continue;
    const opponentId = hit.a === humanId ? hit.b : hit.a;
    const strength = hit.strength;
    const forceX = hit.a === humanId ? hit.nx : -hit.nx;
    const forceZ = hit.a === humanId ? hit.nz : -hit.nz;
    const humanBoat = boats[humanId];
    humanCollisionCounts[humanId]++;
    const playerHeading = humanBoat.state.heading;
    const contactX = hit.x - humanBoat.state.position.x;
    const contactZ = hit.z - humanBoat.state.position.z;
    const contactDistance = Math.hypot(contactX, contactZ);
    // Prefer the actual hull contact point. The collision normal is a fallback
    // force pushing the player away, so its sign must be inverted. + is port.
    const rawSide = contactDistance > 0.15
      ? (contactX * Math.cos(playerHeading) - contactZ * Math.sin(playerHeading)) / contactDistance
      : -(forceX * Math.cos(playerHeading) - forceZ * Math.sin(playerHeading));
    const side = Math.max(-1, Math.min(1, rawSide));
    audio.collision(isDuoMode() ? strength * 0.72 : strength);
    // Only the camera owner can receive the full framing kick; the other seat
    // still gets local haptics and a shared pulse without fighting the camera.
    if (humanId === race.player().id) cameraRig.collisionKick(strength, side);
    pipeline.pulse('collision', Math.min(1.1, 0.3 + strength / 20));
    if (humanBoat.state.flightPhase === 'surface' && boats[opponentId]?.state.flightPhase === 'surface') {
      collisionFxPoint.set(hit.x, hit.y + 0.15, hit.z);
      spray.burst(collisionFxPoint, 4 + Math.min(8, Math.round(strength * 0.3)), 2.5 + Math.min(4, strength * 0.15));
      if (HARNESS && humanId === 0) harnessCollisionFxBursts++;
    }
    if (isDuoMode()) {
      localInput.rumble(duoDevices[humanId as 0 | 1], Math.min(1, 0.38 + strength / 20), 0.52, 58);
    } else {
      haptics.impact(
        strength > 10 ? 'collision-heavy' : 'collision-light',
        Math.min(1, 0.45 + strength / 16),
        humanBoat.state.drifting || humanBoat.state.flightAirBrake > 0.28,
      );
    }
    if (humanId === race.player().id) rivalDirector.notifyPlayerImpact();
    if (roster[opponentId]) tower.announceCollision(roster[opponentId], strength, side);
  }
}

function runCollisionCase(name: string): Record<string, number | string | boolean> {
  resetRace();
  collisions.reset();
  const a = boats[0];
  const b = boats[1];
  const park = (): void => {
    for (let i = 0; i < boats.length; i++) {
      boats[i].setCollisionTestMotion(100 + i * 12, 100, 0, 0, 0);
      boats[i].state.boosting = false;
    }
  };
  const allFinite = (): boolean => boats.every((boat) => {
    const velocity = boat.collisionVelocity(new THREE.Vector2());
    return [boat.state.position.x, boat.state.position.y, boat.state.position.z, velocity.x, velocity.y]
      .every(Number.isFinite);
  });
  park();

  if (name === 'route4-inside' || name === 'route4-outside') {
    const def = course.flightRoutes[3];
    const gate = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    course.routePointAt(def.id, def.gateUs[0], gate);
    course.routeTangentAt(def.id, def.gateUs[0], tangent).normalize();
    const right = new THREE.Vector3(tangent.z, 0, -tangent.x);
    const offset = name === 'route4-inside' ? 7.95 : 8.05;
    const before = gate.clone().addScaledVector(tangent, -0.65).addScaledVector(right, offset);
    const after = gate.clone().addScaledVector(tangent, 0.65).addScaledVector(right, offset);
    const heading = Math.atan2(tangent.x, tangent.z);
    a.setCollisionTestMotion(before.x, before.z, heading, 0, 0, before.y);
    a.state.flightsCleared = 3;
    a.state.flightRouteCursor = 3;
    a.state.flightPhase = 'cruise';
    a.state.flightClearance = 4.5;
    a.beginFlightRouteAttempt(3, 3, def.targetSpeed);
    course.updateFlightRoute(0, boats);
    a.setCollisionTestMotion(after.x, after.z, heading, 0, 0, after.y);
    a.state.flightClearance = 4.5;
    course.updateFlightRoute(1 / 60, boats);
    return {
      name,
      configuredLimit: def.passHalfWidth,
      visualHalfWidth: def.gateHalfWidth,
      corridorHalfWidth: def.corridorHalfWidth,
      requestedOffset: offset,
      measuredOffset: Math.abs(a.state.flightFailure?.lateralOffsetM ?? offset),
      routeState: a.state.flightRouteState,
      gates: a.state.flightGateProgress,
      flights: a.state.flightsCleared,
      reason: a.state.flightRouteFailReason,
      finite: allFinite(),
    };
  }

  if (name === 'pair-matrix') {
    let pairCount = 0;
    let hitPairs = 0;
    let maxSpeed = 0;
    let minOpponentThrow = Infinity;
    let maxCorrection = 0;
    let finite = true;
    for (let ai = 0; ai < boats.length - 1; ai++) {
      for (let bi = ai + 1; bi < boats.length; bi++) {
        pairCount++;
        park();
        collisions.reset();
        const attacker = boats[ai];
        const defender = boats[bi];
        attacker.setCollisionTestMotion(-4, 0, Math.PI / 2, 42, 0);
        defender.setCollisionTestMotion(0, 0.2, 0, 0, 29);
        attacker.state.boosting = true;
        collisions.capture(boats);
        attacker.setCollisionTestMotion(1.1, 0, Math.PI / 2, 42, 0);
        defender.setCollisionTestMotion(0, 3, 0, 0, 29);
        const pairHits = collisions.resolve(boats);
        if (pairHits.some((hit) => hit.a === ai && hit.b === bi)) hitPairs++;
        const defenderVelocity = defender.collisionVelocity(new THREE.Vector2());
        minOpponentThrow = Math.min(minOpponentThrow, Math.abs(defenderVelocity.x));
        for (const boat of [attacker, defender]) {
          maxSpeed = Math.max(maxSpeed, boat.collisionVelocity(new THREE.Vector2()).length());
        }
        maxCorrection = Math.max(maxCorrection, collisions.debugState().maxCorrection);
        finite &&= allFinite();
      }
    }
    return { name, pairCount, hitPairs, maxSpeed, minOpponentThrow, maxCorrection, finite };
  }

  if (name === 'three-boat-pileup') {
    const c = boats[2];
    a.setCollisionTestMotion(-4, 0, Math.PI / 2, 42, 0);
    b.setCollisionTestMotion(0, 0, 0, 0, 24);
    c.setCollisionTestMotion(4, 0, -Math.PI / 2, -42, 0);
    collisions.capture(boats);
    a.setCollisionTestMotion(-1.1, 0, Math.PI / 2, 42, 0);
    b.setCollisionTestMotion(0, 0.4, 0, 0, 24);
    c.setCollisionTestMotion(1.1, 0, -Math.PI / 2, -42, 0);
    const hits = collisions.resolve(boats);
    const speeds = [a, b, c].map((boat) => boat.collisionVelocity(new THREE.Vector2()).length());
    return {
      name,
      hits: hits.length,
      distinctPairs: new Set(hits.map((hit) => `${hit.a}:${hit.b}`)).size,
      maxSpeed: Math.max(...speeds),
      maxCorrection: collisions.debugState().maxCorrection,
      finite: allFinite(),
    };
  }

  if (name === 'contact-cooldown') {
    let firstWindowEvents = 0;
    let totalEvents = 0;
    for (let frame = 0; frame < 34; frame++) {
      park();
      a.setCollisionTestMotion(0, -4, 0, 0, 42);
      b.setCollisionTestMotion(0, -0.4, 0, 0, 24);
      collisions.capture(boats);
      a.setCollisionTestMotion(0, -0.2, 0, 0, 42);
      b.setCollisionTestMotion(0, 2, 0, 0, 24);
      const events = collisions.resolve(boats).length;
      totalEvents += events;
      if (frame < 12) firstWindowEvents += events;
    }
    return {
      name,
      firstWindowEvents,
      totalEvents,
      finite: allFinite(),
      maxCorrection: collisions.debugState().maxCorrection,
    };
  }

  if (name === 'flight-gate-isolation') {
    const def = course.flightRoutes[3];
    const gateU = def.gateUs[0];
    const gate = new THREE.Vector3();
    const before = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    course.routePointAt(def.id, gateU, gate);
    course.routePointAt(def.id, gateU - 0.000004, before);
    course.routeTangentAt(def.id, gateU, tangent).normalize();
    const heading = Math.atan2(tangent.x, tangent.z);
    a.setCollisionTestMotion(before.x, before.z, heading, 0, 0, before.y);
    a.state.flightsCleared = 3;
    a.state.flightRouteCursor = 3;
    a.state.flightPhase = 'cruise';
    a.state.flightClearance = 4.5;
    a.beginFlightRouteAttempt(3, 3, def.targetSpeed);
    b.setCollisionTestMotion(before.x - tangent.x * 0.1, before.z - tangent.z * 0.1, heading, 0, 0, before.y);
    course.updateFlightRoute(0, boats);
    const signedBefore = (a.state.position.x - gate.x) * tangent.x + (a.state.position.z - gate.z) * tangent.z;
    const gateBefore = a.state.flightGateProgress;
    collisions.capture(boats);
    collisions.resolve(boats);
    const signedAfter = (a.state.position.x - gate.x) * tangent.x + (a.state.position.z - gate.z) * tangent.z;
    course.syncFlightTrackingAfterCollisions(boats);
    course.updateFlightRoute(1 / 60, boats);
    return {
      name,
      signedBefore,
      signedAfter,
      gateBefore,
      gateAfter: a.state.flightGateProgress,
      routeState: a.state.flightRouteState,
      finite: allFinite(),
    };
  }

  if (name === 'checkpoint-isolation') {
    startFreshCountdown();
    loop.advance(4.3);
    const targetU = CHECKPOINT_US[0];
    for (let u = 0; u < targetU - 0.000002; u += 0.005) {
      placeHarnessBoat(0, Math.min(u, targetU - 0.000002));
      race.update(1 / 60);
    }
    placeHarnessBoat(0, targetU - 0.000002);
    race.update(1 / 60);
    park();
    course.pointAt(targetU, tmpP);
    course.tangentAt(targetU, tmpT).normalize();
    const before = new THREE.Vector3().copy(tmpP).addScaledVector(tmpT, -0.005);
    const heading = Math.atan2(tmpT.x, tmpT.z);
    a.setCollisionTestMotion(before.x, before.z, heading, 0, 0, before.y);
    b.setCollisionTestMotion(before.x - tmpT.x * 0.1, before.z - tmpT.z * 0.1, heading, 0, 0, before.y);
    race.update(1 / 60);
    const checkpointBefore = harnessCheckpointEvents;
    const progressBefore = race.racers[0].progress;
    const signedBefore = (a.state.position.x - tmpP.x) * tmpT.x + (a.state.position.z - tmpP.z) * tmpT.z;
    collisions.capture(boats);
    collisions.resolve(boats);
    const signedAfter = (a.state.position.x - tmpP.x) * tmpT.x + (a.state.position.z - tmpP.z) * tmpT.z;
    course.syncFlightTrackingAfterCollisions(boats);
    race.syncCollisionCorrections();
    race.update(1 / 60);
    return {
      name,
      signedBefore,
      signedAfter,
      checkpointDelta: harnessCheckpointEvents - checkpointBefore,
      progressDelta: race.racers[0].progress - progressBefore,
      finite: allFinite(),
    };
  }

  if (name === 'side-boost') {
    a.setCollisionTestMotion(-4, 0, Math.PI / 2, 42, 0);
    b.setCollisionTestMotion(0, 0.2, 0, 0, 29);
    a.state.boosting = true;
    collisions.capture(boats);
    a.setCollisionTestMotion(1.1, 0, Math.PI / 2, 42, 0);
    b.setCollisionTestMotion(0, 3.0, 0, 0, 29);
  } else if (name === 'head-on-ccd') {
    a.setCollisionTestMotion(0, -4, 0, 0, 42);
    b.setCollisionTestMotion(0, 4, Math.PI, 0, -38);
    collisions.capture(boats);
    a.setCollisionTestMotion(0, 2, 0, 0, 42);
    b.setCollisionTestMotion(0, -2, Math.PI, 0, -38);
  } else if (name === 'rear-end') {
    a.setCollisionTestMotion(0, -4, 0, 0, 42);
    b.setCollisionTestMotion(0, -0.4, 0, 0, 24);
    collisions.capture(boats);
    a.setCollisionTestMotion(0, -0.2, 0, 0, 42);
    b.setCollisionTestMotion(0, 2.0, 0, 0, 24);
  } else if (name === 'height-separated') {
    a.setCollisionTestMotion(0, -2, 0, 0, 35, 0);
    b.setCollisionTestMotion(0, 2, Math.PI, 0, -35, 3);
    collisions.capture(boats);
    a.setCollisionTestMotion(0, 0, 0, 0, 35, 0);
    b.setCollisionTestMotion(0, 0, Math.PI, 0, -35, 3);
  } else if (name === 'resting-overlap') {
    a.setCollisionTestMotion(0, 0, 0, 0, 0);
    b.setCollisionTestMotion(0.2, 0, 0, 0, 0);
    collisions.capture(boats);
  } else {
    throw new Error(`unknown collision case: ${name}`);
  }

  const hits = collisions.resolve(boats);
  const av = a.collisionVelocity(new THREE.Vector2());
  const bv = b.collisionVelocity(new THREE.Vector2());
  const debug = collisions.debugState();
  const finite = [a.state.position.x, a.state.position.z, b.state.position.x, b.state.position.z, av.x, av.y, bv.x, bv.y]
    .every(Number.isFinite);
  return {
    name,
    hits: hits.length,
    strength: hits[0]?.strength ?? 0,
    toi: hits[0]?.toi ?? -1,
    playerVX: av.x,
    playerVZ: av.y,
    opponentVX: bv.x,
    opponentVZ: bv.y,
    playerSpeed: av.length(),
    opponentSpeed: bv.length(),
    centerDistance: Math.hypot(a.state.position.x - b.state.position.x, a.state.position.z - b.state.position.z),
    maxCorrection: debug.maxCorrection,
    finite,
  };
}

function runCollisionFeedbackCase(): Record<string, unknown> {
  resetRace();
  startFreshCountdown();
  advanceUntil(() => race.phase === 'racing', 8);
  for (let i = 2; i < boats.length; i++) boats[i].setCollisionTestMotion(100 + i * 12, 100, 0, 0, 0);
  const player = boats[0];
  const opponent = boats[1];
  player.setCollisionTestMotion(-4, 0, Math.PI / 2, 42, 0);
  opponent.setCollisionTestMotion(0, 0.2, 0, 0, 29);
  player.state.boosting = true;
  collisions.reset();
  collisions.capture(boats);
  player.setCollisionTestMotion(1.1, 0, Math.PI / 2, 42, 0);
  opponent.setCollisionTestMotion(0, 3, 0, 0, 29);
  const hits = [...collisions.resolve(boats)];
  course.syncFlightTrackingAfterCollisions(boats);
  race.syncCollisionCorrections();
  const beforeAudioEvents = audio.audioEventLog().length;
  // Feed a same-frame duplicate to the presentation layer. The physical hit
  // list remains untouched, while the player feedback contract must coalesce
  // it to one maximum-strength event.
  presentPlayerCollisions(hits.length > 0 ? [...hits, { ...hits[0], strength: hits[0].strength * 0.72 }] : hits);
  const radio = document.querySelector<HTMLElement>('.race-radio');
  const afterAudioEvents = audio.audioEventLog();
  tower.update(1 / 60, race, false, false);
  const heavyRadioVisible = radio?.classList.contains('on') ?? false;
  const heavyRadioText = radio?.textContent?.trim() ?? '';
  const heavyRadioPriority = tower.radioStatus().priority;
  tower.resetRun(9901);
  tower.update(1 / 60, race, false, false);
  tower.announceCollision(roster[1], 5, 0.8);
  tower.update(1 / 60, race, false, false);
  return {
    hits: hits.length,
    strength: hits[0]?.strength ?? 0,
    musicDuck: Number(audio.debugState().musicDuck),
    collisionAudioEvents: afterAudioEvents.slice(beforeAudioEvents).filter((event) => event.source === 'collision').length,
    hapticLane: haptics.status().lastLane,
    hapticQueuedImpacts: haptics.status().queuedImpacts,
    cameraImpactLevel: cameraRig.collisionImpactStatus().level,
    cameraImpactSide: cameraRig.collisionImpactStatus().side,
    cameraImpactRoll: cameraRig.collisionImpactStatus().roll,
    collisionFxBursts: harnessCollisionFxBursts,
    radioVisible: heavyRadioVisible,
    radioText: heavyRadioText,
    radioPriority: heavyRadioPriority,
    lightRadioVisible: radio?.classList.contains('on') ?? false,
    lightRadioQueued: tower.radioStatus().queued,
    finite: boats.every((boat) => [boat.state.position.x, boat.state.position.y, boat.state.position.z, boat.state.speed]
      .every(Number.isFinite)),
  };
}

function runCameraImpactCase(): Record<string, unknown> {
  const previous = cameraRig.getCollisionImpactLevel();
  const sample = (level: CameraImpactLevel): Record<string, number | string | boolean> => {
    cameraRig.setCollisionImpactLevel(level);
    cameraRig.snapOrbit(boats[0], presentationTime);
    cameraRig.collisionKick(16, 0.8);
    return cameraRig.collisionImpactStatus();
  };
  const standard = sample('standard');
  const weak = sample('weak');
  const off = sample('off');
  cameraRig.setCollisionImpactLevel(previous);
  cameraRig.snapOrbit(boats[0], presentationTime);
  return { standard, weak, off };
}

function runOffCourseRecoveryCase(): Record<string, unknown> {
  resetRace();
  startFreshCountdown();
  advanceUntil(() => race.phase === 'racing', 8);

  const u = 0.2;
  placeHarnessBoat(0, u, SURFACE_ROUTE_FAIL_DISTANCE_M + 4);
  for (let id = 1; id < boats.length; id++) placeHarnessBoat(id, u - id * 0.02, 0);
  race.syncCollisionCorrections();

  course.sampleSurfaceNear(boats[0].state.position, u, 0.002, harnessPilotSample);
  const distanceM = harnessPilotSample.distance;
  const beforeSteps = Math.round(14.9 / SIM_DT);
  let failureStep = -1;
  let at14_9: Record<string, number | string> = {};
  for (let step = 1; step <= Math.ceil(15.2 / SIM_DT); step++) {
    race.update(SIM_DT);
    if (step === beforeSteps) {
      at14_9 = {
        elapsedS: step * SIM_DT,
        phase: race.phase,
        warning: race.player().courseWarning,
      };
    }
    if (failureStep < 0 && race.phase === 'defeated') failureStep = step;
  }
  return {
    distanceM,
    hardEdgeM: SURFACE_ROUTE_FAIL_DISTANCE_M,
    at14_9,
    failureAfterS: failureStep < 0 ? -1 : failureStep * SIM_DT,
    phase: race.phase,
    reason: race.challengeResult?.reason ?? 'none',
  };
}

/**
 * Keep the physical Final portal honest when a rival reaches it before the
 * authored seven-flight qualification. The qualified rival still finishes in
 * crossing-time order; only the lapped / under-qualified boats are ignored.
 */
function runFinalEligibilityCase(): Record<string, unknown> {
  resetRace();
  startFreshCountdown();
  advanceUntil(() => race.phase === 'racing', 8);
  const dt = 1 / 60;
  const routeCount = Math.max(1, course.flightRoutes.length);
  const center = course.pointAt(0, new THREE.Vector3());
  const forward = course.tangentAt(0, new THREE.Vector3()).normalize();
  const right = new THREE.Vector3(forward.z, 0, -forward.x).normalize();
  const laterals = [0, -4.5, -2.25, 0, 2.25, 4.5];
  const setPlane = (id: number, plane: number): void => {
    const point = center.clone().addScaledVector(forward, plane).addScaledVector(right, laterals[id]);
    boats[id].setCollisionTestMotion(
      point.x,
      point.z,
      Math.atan2(forward.x, forward.z),
      forward.x * 24,
      forward.z * 24,
    );
  };

  try {
    for (let id = 0; id < boats.length; id++) {
      const state = boats[id].state;
      state.flightPhase = 'surface';
      state.airborne = false;
      state.flightRouteState = 'idle';
      state.flightRouteIndex = -1;
      state.flightRouteCursor = id < 2 ? routeCount : 0;
      state.flightsCleared = id < 2 ? routeCount : 0;
      state.flightGateProgress = 0;
      state.flightRouteFailReason = 'none';
      state.flightFailure = null;
      setPlane(id, -0.8);
    }
    // Rebase both route trackers after staging; this is the same contact
    // correction path used by gameplay and keeps the portal sweep sub-frame.
    course.syncFlightTrackingAfterCollisions(boats);
    race.syncCollisionCorrections();
    // Both player seats are qualified, but the left seat owns this single-run
    // harness. Give it the larger pre-arm progress so armFinale selects it.
    race.racers[0].progress = course.length;
    race.racers[1].progress = course.length - 1;
    for (let id = 2; id < race.racers.length; id++) race.racers[id].progress = 0;
    if (!race.armFinale()) throw new Error('unable to arm Final eligibility case');
    course.armFinalStation();

    // A fully qualified rival remains a legitimate photo-finish contender.
    setPlane(1, 0.8);
    race.update(dt);
    // One under-qualified boat laps deep into the current circuit before the
    // qualified player reaches Final. This reproduces the real regression:
    // raw lap progress must not outrank a qualified racer waiting for Final.
    placeHarnessBoat(2, 0.9);
    race.update(dt);

    // The remaining boats cross the same visible line after the qualified
    // rival, but have not completed a single authored flight route.
    for (const id of [3, 4, 5]) {
      setPlane(id, 0.8);
      race.update(dt);
    }
    const unqualifiedFinishedIds = race.racers
      .slice(2)
      .filter((racer) => racer.finished)
      .map((racer) => racer.id);

    setPlane(0, 0.8);
    race.update(dt);
    const order = [...race.racers].sort((a, b) => a.place - b.place || a.id - b.id);
    return {
      phase: race.phase,
      qualifiedFinishedIds: race.racers.slice(0, 2).filter((racer) => racer.finished).map((racer) => racer.id),
      unqualifiedFinishedIds,
      finishOrder: order.filter((racer) => racer.finished).map((racer) => racer.id),
      playerPlace: race.racers[0].place,
      resultPlace: race.challengeResult?.place ?? -1,
    };
  } finally {
    // Leave the browser harness in a clean READY state for the next scenario.
    resetRace();
  }
}

/**
 * A racer that already completed a whole authored flight set must keep its
 * rank while it takes one more route. Clearing the eighth flight used to
 * revoke the qualification flag place sorting relies on, and the armed
 * player's tracked distance was still pinned to the arming moment, so the
 * leader became sixth one frame later without ever losing the physical lead.
 */
function runPostSetRankCase(): Record<string, unknown> {
  const dt = 1 / 60;
  const routeCount = Math.max(1, course.flightRoutes.length);
  try {
    resetRace();
    race.setPlayerIds([0]);
    startFreshCountdown();
    advanceUntil(() => race.phase === 'racing', 8);
    // Teleporting clears flight tracking, so stage the authored progress after
    // every placement: the player owns a whole set, the pack owns none.
    const stage = (id: number, u: number, lateral: number, cleared: number): void => {
      placeHarnessBoat(id, u, lateral);
      const st = boats[id].state;
      st.flightPhase = 'surface';
      st.airborne = false;
      st.flightRouteState = 'idle';
      st.flightRouteIndex = -1;
      st.flightGateProgress = 0;
      st.flightRouteFailReason = 'none';
      st.flightFailure = null;
      st.flightRouteCursor = cleared;
      st.flightsCleared = cleared;
    };
    // The player leads the pack; stay clear of the half-lap antipode so the
    // staging teleports resolve as forward placements, not wrap-arounds.
    stage(0, 0.25, 0, routeCount);
    for (let id = 1; id < boats.length; id++) stage(id, 0.2 - id * 0.02, id % 2 === 0 ? 2.4 : -2.4, 0);
    course.syncFlightTrackingAfterCollisions(boats);
    race.update(dt);
    if (!race.armFinale()) throw new Error('unable to arm Final for the post-set rank case');
    course.armFinalStation();
    const progressAtArming = Math.round(race.racers[0].progress);
    // The player keeps racing toward the next corridor instead of crossing.
    stage(0, 0.35, 0, routeCount);
    race.update(dt);
    const progressAfterDriving = Math.round(race.racers[0].progress);
    // The pack physically laps past the player's banked distance. Move in
    // sub-half-lap hops so each placement resyncs forward instead of being
    // read as a wrap backwards across the line.
    for (const u of [0.45, 0.85]) {
      for (let id = 1; id < boats.length; id++) stage(id, u - id * 0.01, id % 2 === 0 ? 2.4 : -2.4, 0);
      course.syncFlightTrackingAfterCollisions(boats);
      race.update(dt);
    }
    const placeWhileQualified = race.racers[0].place;
    // Clear one more authored route: the eighth gate of the run.
    const player = boats[0];
    player.state.flightRouteState = 'active';
    player.state.flightRouteIndex = 0;
    player.completeFlightRoute(0, routeCount);
    race.update(dt);
    return {
      progressAtArming,
      progressAfterDriving,
      placeWhileQualified,
      placeAfterExtraRoute: race.racers[0].place,
      flightsCleared: player.state.flightsCleared,
      bestRivalProgress: Math.round(Math.max(...race.racers.slice(1).map((racer) => racer.progress))),
    };
  } finally {
    resetRace();
  }
}

/**
 * Park the harness on a finished solo Final so the result beats can be driven
 * frame by frame: seven flights banked, the certificate on screen, and the
 * accolade wall still waiting behind it.
 */
function armHarnessFinale(): void {
  appMode = 'independent';
  resetRace();
  race.setPlayerIds([0]);
  startFreshCountdown();
  advanceUntil(() => race.phase === 'racing', 8);
  for (let id = 0; id < race.racers.length; id++) {
    race.racers[id].place = id + 1;
    race.racers[id].progress = id === 0 ? course.length : Math.max(0, course.length - id);
    race.racers[id].finished = false;
    race.racers[id].eliminated = false;
  }
  race.challengeResult = {
    outcome: 'excellent',
    reason: 'none',
    gate: 0,
    place: 1,
    totalRacers: race.racers.length,
    raceTime: 42.25,
    flightsCleared: Math.max(7, course.flightRoutes.length),
    leaderGapSeconds: 0,
    leaderGapMeters: 0,
    overtakes: 3,
    excellentTotal: 1,
    ordinaryNew: false,
    manMedalEarned: true,
    manMedalsTotal: 1,
    bestFlights: Math.max(7, course.flightRoutes.length),
    newBest: false,
    failure: null,
  };
  // Mirror the live seven-flight state so this harness proves that the
  // continuation countdown does not reset progression when the wall closes.
  primaryBoat().state.flightsCleared = 7;
  race.phase = 'finished';
  race.finaleCompleted = true;
  resultsShown = true;
  beginFinalePresentation();
}

/** Verify the successful-result beats never overlap in the live presentation. */
function runFinaleHonorSequenceCase(leaveVisible = false, testAutoContinue = false): Record<string, unknown> {
  const previousMode = appMode;
  try {
    armHarnessFinale();
    const mobileControlsHidden = !mobileInput.enabled || mobileInput.status().overlayHidden;
    const afterFinaleShow = {
      finaleVisible: document.querySelector('.finale-overlay')?.classList.contains('on') ?? false,
      honorsVisible: honorHighlights.visible(),
      honorsDomVisible: document.querySelector('.honor-review')?.classList.contains('on') ?? false,
      pending: honorReviewPending,
      continueLabel: document.querySelector<HTMLElement>('[data-action="continue"]')?.textContent?.trim() ?? '',
      mobileControlsHidden,
      hudHidden: getComputedStyle(document.querySelector<HTMLElement>('.hud')!).visibility === 'hidden',
      towerHidden: getComputedStyle(document.querySelector<HTMLElement>('.race-tower')!).display === 'none',
    };
    loop.advance(FINALE_MIN_READ_S + 0.05);
    const finaleContinue = (() => {
      const button = document.querySelector<HTMLButtonElement>('[data-action="continue"]');
      const rect = button?.getBoundingClientRect();
      return {
        visible: !!button && getComputedStyle(button).visibility !== 'hidden' &&
          getComputedStyle(button).display !== 'none',
        enabled: button ? !button.disabled : false,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        inViewport: !!rect && rect.left >= -1 && rect.right <= innerWidth + 1 &&
          rect.top >= -1 && rect.bottom <= innerHeight + 1,
      };
    })();
    continueAfterFinale();
    const afterContinue = {
      finaleVisible: document.querySelector('.finale-overlay')?.classList.contains('on') ?? false,
      honorsVisible: honorHighlights.visible(),
      honorsDomVisible: document.querySelector('.honor-review')?.classList.contains('on') ?? false,
      pending: honorReviewPending,
      mobileControlsHidden: !mobileInput.enabled || mobileInput.status().overlayHidden,
      hudHidden: getComputedStyle(document.querySelector<HTMLElement>('.hud')!).visibility === 'hidden',
      towerHidden: getComputedStyle(document.querySelector<HTMLElement>('.race-tower')!).display === 'none',
      honorBackground: getComputedStyle(document.querySelector<HTMLElement>('.honor-review')!).backgroundColor,
      continueVisible: !(document.querySelector<HTMLElement>('.honor-review-continue')?.hidden ?? true),
      continueDisabled: document.querySelector<HTMLButtonElement>('.honor-review-continue')?.disabled ?? true,
      retryVisible: !(document.querySelector<HTMLElement>('.honor-review-retry')?.hidden ?? true),
      historyHonorScore: records.data.honorScore,
      finalHonorCard: Array.from(document.querySelectorAll<HTMLElement>('.honor-review-card strong'))
        .some((node) => node.textContent?.trim() === HONOR_DEFINITIONS['finale.captain'].title),
    };
    // Settle the cards without consuming the five-second auto-continue window.
    loop.advance(4.85);
    const settledBeforeContinue = {
      continueDisabled: document.querySelector<HTMLButtonElement>('.honor-review-continue')?.disabled ?? true,
      continueLabel: document.querySelector<HTMLElement>('.honor-review-continue')?.textContent?.trim() ?? '',
      continueAriaLabel: document.querySelector<HTMLElement>('.honor-review-continue')?.getAttribute('aria-label') ?? '',
      activeAction: document.activeElement instanceof HTMLElement ? document.activeElement.className : '',
      spotlightDisplay: getComputedStyle(document.querySelector<HTMLElement>('.honor-review-spotlight')!).display,
      cardWidth: document.querySelector<HTMLElement>('.honor-review-card')?.getBoundingClientRect().width ?? 0,
      cardTitleFontSize: Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>('.honor-review-card-copy strong')!).fontSize),
      layoutFits: Array.from(document.querySelectorAll<HTMLElement>(
        '.honor-review-title, .honor-review-result, .honor-review-standings, .honor-review-spotlight, .honor-review-cards, .honor-review-foot',
      )).every((node) => {
        const rect = node.getBoundingClientRect();
        return node.scrollWidth <= node.clientWidth + 1 && rect.left >= -1 && rect.right <= innerWidth + 1 &&
          rect.top >= -1 && rect.bottom <= innerHeight + 1;
      }),
    };
    let afterHonorContinue: Record<string, unknown>;
    if (testAutoContinue) {
      loop.advance(5.1);
      afterHonorContinue = {
        honorVisible: honorHighlights.visible(),
        racePhase: race.phase,
        flightsCleared: primaryBoat().state.flightsCleared,
        finaleVisible: document.querySelector('.finale-overlay')?.classList.contains('on') ?? false,
      };
    } else {
      if (!leaveVisible) document.querySelector<HTMLButtonElement>('.honor-review-continue')?.click();
      afterHonorContinue = {
        honorVisible: honorHighlights.visible(),
        racePhase: race.phase,
        flightsCleared: primaryBoat().state.flightsCleared,
        finaleVisible: document.querySelector('.finale-overlay')?.classList.contains('on') ?? false,
      };
    }
    return { afterFinaleShow, finaleContinue, afterContinue, settledBeforeContinue, afterHonorContinue };
  } finally {
    if (!leaveVisible) {
      honorHighlights.hide();
      appMode = previousMode;
      resetRace();
      race.setPlayerIds(previousMode === 'duo' ? [0, 1] : [0]);
      harnessPlayerInput = null;
    }
  }
}

/**
 * The unattended result flow. A player who touches nothing must be carried from
 * the certificate into the accolade wall and then back into the same run, so
 * that wall keeps only the next-round countdown. The veteran shortcut has to
 * skip both beats, and an explicit confirmation has to keep every exit.
 */
function runFinaleAutoFlowCase(): Record<string, unknown> {
  const previousMode = appMode;
  const wallButtons = () => ({
    continueVisible: !(document.querySelector<HTMLElement>('.honor-review-continue')?.hidden ?? true),
    retryHidden: document.querySelector<HTMLElement>('.honor-review-retry')?.hidden ?? false,
    exitHidden: document.querySelector<HTMLElement>('.honor-review-exit')?.hidden ?? false,
  });
  try {
    // 1. Nobody touches anything: the certificate walks itself into the wall.
    armHarnessFinale();
    loop.advance(FINALE_MIN_READ_S + 0.15);
    const countdownLabel = document.querySelector<HTMLElement>('[data-action="continue"]')?.textContent?.trim() ?? '';
    const skipVisible = !!document.querySelector<HTMLElement>('[data-action="skip"]');
    // The quiet utility row has to stay readable and tappable on both frames,
    // even now that it carries the veteran shortcut next to the next beat.
    // Sizes come from the layout box: the copy block is mid-transition in the
    // harness, and its scale would understate every button.
    const utilityLayout = (() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('.finale-utilities button, .finale-skip'));
      const rects = nodes.map((node) => node.getBoundingClientRect());
      const overlap = rects.some((a, i) => rects.some((b, j) => j > i &&
        a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
      return {
        count: nodes.length,
        overlap,
        minHeight: Math.min(...nodes.map((node) => node.offsetHeight)),
        minWidth: Math.min(...nodes.map((node) => node.offsetWidth)),
        inViewport: rects.every((rect) => rect.left >= -1 && rect.right <= innerWidth + 1 &&
          rect.top >= -1 && rect.bottom <= innerHeight + 1),
      };
    })();
    loop.advance(5.1);
    const autoEntered = {
      finaleVisible: document.querySelector('.finale-overlay')?.classList.contains('on') ?? false,
      honorsVisible: honorHighlights.visible(),
      ...wallButtons(),
    };
    loop.advance(4.9); // spotlight + cards
    loop.advance(5.2); // the wall's own five-second countdown
    const autoContinued = {
      honorsVisible: honorHighlights.visible(),
      racePhase: race.phase,
      flightsCleared: primaryBoat().state.flightsCleared,
    };

    // 2. The veteran shortcut skips the dossier and the accolade wall entirely.
    honorHighlights.hide();
    armHarnessFinale();
    loop.advance(FINALE_MIN_READ_S + 0.15);
    document.querySelector<HTMLButtonElement>('[data-action="skip"]')?.click();
    const skipped = {
      finaleVisible: document.querySelector('.finale-overlay')?.classList.contains('on') ?? false,
      honorsVisible: honorHighlights.visible(),
      racePhase: race.phase,
      flightsCleared: primaryBoat().state.flightsCleared,
    };

    // 3. An explicit confirmation is a menu stop, so the exits stay.
    armHarnessFinale();
    loop.advance(FINALE_MIN_READ_S + 0.15);
    document.querySelector<HTMLButtonElement>('[data-action="continue"]')?.click();
    loop.advance(4.9);
    const confirmed = {
      honorsVisible: honorHighlights.visible(),
      ...wallButtons(),
    };
    return { countdownLabel, skipVisible, utilityLayout, autoEntered, autoContinued, skipped, confirmed };
  } finally {
    honorHighlights.hide();
    appMode = previousMode;
    resetRace();
    race.setPlayerIds(previousMode === 'duo' ? [0, 1] : [0]);
    harnessPlayerInput = null;
  }
}

/**
 * End-to-end Final rank regression: a lone qualified player takes the portal,
 * sits through the certificate and the accolade wall, continues the run, and
 * must still hold the place it earned at the crossing.
 */
function runFinalContinueRankCase(): Record<string, unknown> {
  const previousMode = appMode;
  try {
    appMode = 'independent';
    resetRace();
    race.setPlayerIds([0]);
    startFreshCountdown();
    advanceUntil(() => race.phase === 'racing', 8);
    const routeCount = course.flightRoutes.length;
    const point = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    // Glide in small steps so the tracker accumulates real distance and real
    // checkpoint credit instead of treating every placement as a teleport.
    // Steps stay under the portal's 4 m sweep limit so crossings register, and
    // the whole field moves together so the gaps stay real.
    const glideField = (fromU: number, toU: number): void => {
      for (let u = fromU; u < toU - 1e-9; u = Math.min(toU, u + 0.001)) {
        for (let id = 0; id < boats.length; id++) {
          const wrapped = ((u - id * 0.02) % 1 + 1) % 1;
          course.pointAt(wrapped, point);
          course.tangentAt(wrapped, tangent);
          boats[id].setCollisionTestMotion(
            point.x, point.z, Math.atan2(tangent.x, tangent.z), tangent.x * 20, tangent.z * 20,
          );
        }
        race.update(1 / 60);
      }
    };
    // The grid sits at u≈0.996, so these targets are continuous U, not wrapped.
    glideField(0.996, 1.3);
    const beforeArming = race.racers.map((racer) => Math.round(racer.progress));
    // Only the player owns a complete set, so no rival can take the portal.
    // The seventh flight lands early in the lap, so Final arms long before the
    // boat reaches the portal on the start/finish line.
    boats[0].state.flightPhase = 'surface';
    boats[0].state.airborne = false;
    boats[0].state.flightRouteState = 'idle';
    boats[0].state.flightRouteIndex = -1;
    boats[0].restoreFlightCheckpoint(routeCount, 0);
    if (!race.armFinale()) throw new Error('unable to arm Final for the continue rank case');
    course.armFinalStation();
    glideField(1.3, 2.002);
    const atFinish = {
      finished: race.racers[0].finished,
      place: race.racers[0].place,
      resultPlace: race.challengeResult?.place ?? -1,
      phase: race.phase,
      progress: Math.round(race.racers[0].progress),
    };
    beginFinalePresentation();
    loop.advance(FINALE_MIN_READ_S + 0.05);
    continueAfterFinale();
    loop.advance(4.85);
    document.querySelector<HTMLButtonElement>('.honor-review-continue')?.click();
    advanceUntil(() => race.phase === 'racing', 8);
    // Drive on: the lap window that was crossed while the portal was armed has
    // to close with its gates credited, or the player drops a lap of progress.
    glideField(2.002, 2.2);
    return {
      beforeArming,
      atFinish,
      afterContinue: {
        place: race.racers[0].place,
        finished: race.racers[0].finished,
        flightsCleared: boats[0].state.flightsCleared,
        phase: race.phase,
        progress: Math.round(race.racers[0].progress),
        bestRivalProgress: Math.round(Math.max(...race.racers.slice(1).map((racer) => racer.progress))),
      },
    };
  } finally {
    honorHighlights.hide();
    appMode = previousMode;
    resetRace();
    race.setPlayerIds([0]);
  }
}

/** Exercise the same accolade wall used by a real single-player result. */
function runSingleHonorCase(): Record<string, unknown> {
  const previousMode = appMode;
  try {
    appMode = 'independent';
    resetRace();
    race.setPlayerIds([0]);
    for (let id = 0; id < boats.length; id++) boats[id].setPlayerOwned(id === 0);
    startFreshCountdown();
    advanceUntil(() => race.phase === 'racing', 8);
    // Deliberately make the player the last racer by progress while leaving
    // the cached places untouched. A real mid-step failure must report this
    // current order on the result wall.
    for (let id = 0; id < race.racers.length; id++) race.racers[id].progress = id === 0 ? 10 : 100 + id;
    honors.award('target.coin', 0, HONOR_DEFINITIONS['target.coin'].value, race.raceTime);
    honors.award('flight.ace', 0, HONOR_DEFINITIONS['flight.ace'].value, race.raceTime + 0.1);
    race.defeatFlight({
      reason: 'gate_left',
      flightNumber: 1,
      routeSlot: 0,
      flightsCleared: 0,
      gatesPassed: 0,
      gateCount: 1,
      targetGate: 1,
      routeU: 0.5,
      lateralOffsetM: -6.4,
      lateralLimitM: 5,
      corridorDistanceM: null,
      clearanceM: 4.2,
    });
    startRetryLesson(true);
    loop.advance(0.35);
    const failureLesson = {
      visible: document.querySelector<HTMLElement>('.hud-retry-lesson')?.classList.contains('on') ?? false,
      reason: document.querySelector<HTMLElement>('.hud-lesson-title')?.textContent?.trim() ?? '',
      copy: document.querySelector<HTMLElement>('.hud-lesson-copy')?.textContent?.trim() ?? '',
      action: document.querySelector<HTMLButtonElement>('.hud-lesson-continue')?.textContent?.trim() ?? '',
    };
    loop.advance(1.0);
    document.querySelector<HTMLButtonElement>('.hud-lesson-continue')?.click();
    const summary = lastResultEnvelope?.honors;
    return {
      mode: lastResultEnvelope?.mode ?? '',
      seatCount: lastResultEnvelope?.seats.length ?? 0,
      wallVisible: honorHighlights.visible(),
      standingCount: document.querySelectorAll('.honor-review-standing').length,
      cardCount: document.querySelectorAll('.honor-review-card').length,
      spotlight: document.querySelector('.honor-review-spotlight-title')?.textContent?.trim() ?? '',
      score: summary?.score ?? 0,
      counts: summary?.counts ?? {},
      awardCount: summary?.awards.length ?? 0,
      resultPlace: lastResultEnvelope?.racers.find((racer) => racer.racerId === 0)?.place ?? -1,
      failureLesson,
      continueVisible: !(document.querySelector<HTMLElement>('.honor-review-continue')?.hidden ?? true),
    };
  } finally {
    honorHighlights.hide();
    appMode = previousMode;
    resetRace();
    race.setPlayerIds(previousMode === 'duo' ? [0, 1] : [0]);
  }
}

function stageRadioTechniqueBroadcast(): void {
  resetRace();
  startFreshCountdown();
  advanceUntil(() => race.phase === 'racing', 8);
  tower.update(0.5, race, false, true);
  pcControlPrimer.stop();
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null, false);
  // Keep the notices produced by the real Race.go callback.  This case is
  // deliberately paced beyond the global radio gap so it proves that the
  // opening Gemini/SOL broadcast survives behind the GO line.
  tower.update(0.5, race, false, false);
  loop.advance(4.2);
  // The first launch action cue owns the screen by design and pauses the
  // radio; the tip is authored to outlive exactly that ("behind the GO/team
  // slot and the first action cue"). A fixed 4.2 s sample can land inside a
  // legitimate blocked window whenever the sea state brings an early event,
  // so run until the broadcast actually presents. A broadcast that never
  // presents (dropped, or the run ended) still fails the caller's assertions.
  advanceUntil(() => {
    const el = document.querySelector('.race-radio');
    const presenting = !!el && el.classList.contains('broadcast') &&
      el.classList.contains('on') && !el.classList.contains('blocked');
    return presenting || race.phase !== 'racing';
  }, 15);
}

function runRadioTechniqueCase(): Record<string, unknown> {
  const originalMastery = drivingCoach.progress.mastery.airBrakedInTurn;
  try {
    drivingCoach.progress.mastery.airBrakedInTurn = true;
    resetRace();
    startFreshCountdown();
    advanceUntil(() => race.phase === 'racing', 8);
    pcControlPrimer.stop();
    pcPrimerPresentation = null;
    hud.showPcControlPrimer(null, false);
    tower.update(1 / 60, race, false, false);
    const masteredStatus = tower.radioStatus();
    const masteredFresh = {
      activeKey: masteredStatus.activeKey,
      // Key-scoped, not queue-length: a lively start can legitimately queue
      // battle chatter behind GO; the contract is that the TIP stays away
      // for a player who already mastered it.
      tipPresented: tower.radioHas('gemini-opening-airbrake-tip'),
    };

    drivingCoach.progress.mastery.airBrakedInTurn = false;
    stageRadioTechniqueBroadcast();
    const radio = document.querySelector<HTMLElement>('.race-radio');
    const animation = radio?.getAnimations()[0] ?? null;
    const presentationState = () => {
      const status = tower.radioStatus();
      const style = radio ? getComputedStyle(radio) : null;
      const currentAnimation = radio?.getAnimations()[0] ?? null;
      return {
        activeKey: status.activeKey,
        timer: Number(status.timer),
        revision: Number(status.revision),
        on: radio?.classList.contains('on') ?? false,
        blocked: radio?.classList.contains('blocked') ?? false,
        paused: radio?.classList.contains('paused') ?? false,
        display: style?.display ?? '',
        visibility: style?.visibility ?? '',
        animationPlayState: style?.animationPlayState ?? '',
        sameAnimation: Boolean(animation) && currentAnimation === animation,
      };
    };

    const activeBeforeBlock = presentationState();
    tower.update(1, race, false, true);
    const presentationBlocked = presentationState();
    tower.update(1, race, true, false);
    const flightFocusBlocked = presentationState();
    tower.update(1 / 60, race, false, false);
    const resumed = presentationState();
    // Dedup is keyed, not queue-length: other racing notices may legitimately
    // be queued behind the active tip, but the tip itself must not re-enter.
    const sameRunQueued = tower.announceTechniqueTip() ? 1 : 0;
    tower.resetRun(7104);
    const secondRunQueued = tower.announceTechniqueTip() ? 1 : 0;
    tower.update(1 / 60, race, false, false);
    return {
      masteredFresh,
      activeBeforeBlock,
      presentationBlocked,
      flightFocusBlocked,
      resumed,
      sameRunQueued,
      secondVisible: radio?.classList.contains('on') ?? false,
      secondQueued: secondRunQueued,
      secondActiveKey: tower.radioStatus().activeKey,
    };
  } finally {
    drivingCoach.progress.mastery.airBrakedInTurn = originalMastery;
  }
}

function stageHarnessGateFailure(): void {
  const failure: FlightFailureSnapshot = {
    reason: 'gate_left',
    flightNumber: 1,
    routeSlot: 0,
    flightsCleared: 0,
    gatesPassed: 0,
    gateCount: 1,
    targetGate: 1,
    routeU: 0.5,
    lateralOffsetM: -6.4,
    lateralLimitM: 5,
    corridorDistanceM: null,
    clearanceM: 4.2,
  };
  const result: ChallengeResult = {
    outcome: 'defeated',
    reason: failure.reason,
    gate: 1,
    place: 1,
    totalRacers: 6,
    raceTime: 12.4,
    flightsCleared: 0,
    leaderGapSeconds: null,
    leaderGapMeters: null,
    overtakes: 0,
    excellentTotal: 0,
    ordinaryNew: false,
    manMedalEarned: false,
    manMedalsTotal: 0,
    bestFlights: 0,
    newBest: false,
    failure,
  };
  hud.showChallengeResult({ challengeResult: result } as RaceView);
  tower.root.classList.remove('on');
  mobileInput.setOverlayHidden(true);
  mobileInput.setControlPhase('inactive');
}

const riderInspectionAnchor = new THREE.Object3D();
riderInspectionAnchor.name = 'rider-inspection-anchor';
boats[0].riderMount.add(riderInspectionAnchor);
const harnessTailCameraPoint = new THREE.Vector3();
const harnessReactorPoint = new THREE.Vector3();

const CLEAN_EVIDENCE_SCENARIOS = new Set([
  'race-straight',
  'race-steer-left',
  'race-flight',
  'race-landing-recovery',
  'tail-inspection-sun',
  'tail-inspection-shade',
  'tail-inspection-side',
  'tail-drift-left',
  'tail-drift-right',
  'tail-airbrake-left',
  'tail-airbrake-right',
  'lighthouse-inspection',
  'landing-straight-drop',
  'landing-left-drop',
  'landing-right-drop',
  'rider-inspection',
  'rider-inspection-front',
  'rider-inspection-three-quarter',
  'rider-inspection-side',
  'rider-inspection-back',
  'rider-inspection-chase',
]);

function setHarnessEvidenceUiHidden(hidden: boolean): void {
  hudLayer.style.display = hidden ? 'none' : '';
  mobileInput.setOverlayHidden(hidden);
  if (hidden) mixer.setVisible(false);
}

function getRiderFaceTarget(): THREE.Object3D {
  const head = boats[0].riderMount.getObjectByName('head');
  if (head) {
    const headPos = new THREE.Vector3(0, 0, 0);
    head.localToWorld(headPos);
    boats[0].riderMount.worldToLocal(headPos);
    riderInspectionAnchor.position.copy(headPos);
    riderInspectionAnchor.updateMatrixWorld(true);
  }
  return riderInspectionAnchor;
}

function prepareHarnessRiderInspection(): THREE.Object3D {
  if (riders.some((rider) => !rider.faceDebug().hasFaceMesh) || getFaceTextureCacheSize() !== riders.length) {
    throw new Error('rider inspection requires one cached Face Patch per active rider');
  }
  const hair = riders[0].hairDebug();
  const look = driverProfile(selectedDriverId).look;
  const styleBones = look.hairStyle === 'ponytail'
    ? ['braid-tie', 'braid-1', 'braid-2', 'braid-3', 'braid-4']
    : look.hairStyle === 'bob' ? ['bob-back', 'bob-left', 'bob-right'] : ['hair-root'];
  if (hair.style !== look.hairStyle || !hair.visible ||
      styleBones.some((name) => !hair.boneNames.includes(name))) {
    throw new Error(`rider inspection lost the ${selectedDriverId} hair rig: ${JSON.stringify(hair)}`);
  }
  placeHarnessBoat(0, 0.22, 0);
  boats[0].syncSurfacePresentation(worldTime);
  riders[0].update(1 / 60, boats[0].state, worldTime);
  return getRiderFaceTarget();
}

function settleHarnessTailInspection(): void {
  setHarnessInput({ throttle: 0 });
  for (let step = 0; step < 900; step++) {
    boats[0].object.updateWorldMatrix(true, false);
    harnessTailCameraPoint.set(0, 1.6, -6);
    boats[0].object.localToWorld(harnessTailCameraPoint);
    harnessReactorPoint.set(0, 1.15, -2.6);
    boats[0].object.localToWorld(harnessReactorPoint);
    const cameraClearance = harnessTailCameraPoint.y -
      waterHeight(harnessTailCameraPoint.x, harnessTailCameraPoint.z, worldTime);
    const reactorClearance = harnessReactorPoint.y -
      waterHeight(harnessReactorPoint.x, harnessReactorPoint.z, worldTime);
    if (cameraClearance >= 0.45 && reactorClearance >= 0.25) {
      setHarnessInput(null);
      return;
    }
    loop.advance(1 / 60);
  }
  throw new Error('tail inspection never reached a clear real-water phase');
}

function setHarnessTailCamera(): void {
  harnessCameraOverride = {
    target: boats[0].object,
    offset: [0, 1.72, -6.15],
    lookAt: [0, 0.98, -2.36],
    fov: 46,
  };
}

function prepareHarnessTailDrift(steer: number): void {
  advanceUntil(() => race.phase === 'racing', 8);
  placeHarnessBoat(0, 0.22, 0);
  setHarnessInput({ throttle: 1 });
  advanceUntil(() => boats[0].state.speed >= 20, 6, 1 / 60);
  setHarnessInput({ throttle: 1, steer, drift: true });
  loop.advance(0.55);
  if (!boats[0].state.drifting) throw new Error('tail drift evidence did not use the real drift state');
  setHarnessTailCamera();
}

function prepareHarnessTailAirBrake(steer: number): void {
  advanceUntil(() => race.phase === 'racing', 8);
  harnessKeepFlightMissRunning = true;
  beginHarnessRouteFlight(0, 1);
  setHarnessInput({ throttle: 1 });
  advanceUntil(() => boats[0].state.flightPhase === 'cruise', 4, 1 / 60);
  if (boats[0].state.flightPhase === 'surface') {
    throw new Error('tail air-brake evidence never entered controlled flight');
  }
  setHarnessInput({ throttle: 1, steer, airBrake: true });
  loop.advance(0.48);
  if (boats[0].state.flightAirBrake < 0.8) {
    throw new Error('tail air-brake evidence did not use the real flight brake state');
  }
  setHarnessTailCamera();
}

function runFlapCase(): Record<string, unknown> {
  scenario('tail-inspection-sun');
  const neutral = boats[0].flapDebug();

  scenario('tail-drift-left');
  const drift = boats[0].flapDebug();
  setHarnessInput({ throttle: 1 });
  loop.advance(0.12);
  const driftRelease = boats[0].flapDebug();

  scenario('tail-airbrake-left');
  const flightLeft = boats[0].flapDebug();
  setHarnessInput({ throttle: 1, steer: 0.85, airBrake: true });
  loop.advance(0.42);
  const flightRight = boats[0].flapDebug();
  setHarnessInput({ throttle: 1, steer: 0, airBrake: false });
  loop.advance(0.14);
  const flightRelease = boats[0].flapDebug();
  loop.advance(0.9);
  const flightSettled = boats[0].flapDebug();

  return { neutral, drift, driftRelease, flightLeft, flightRight, flightRelease, flightSettled };
}

function scenario(name: string): void {
  harnessCameraOverride = null;
  course.object.visible = true;
  spray.object.visible = true;
  jetTrail.object.visible = true;
  for (const boat of boats) boat.object.visible = true;
  for (const wake of wakes) wake.object.visible = true;
  harnessUsePlayerInput = false;
  harnessSuppressAirborneFlightTrigger = false;
  harnessKeepFlightMissRunning = false;
  for (let id = 0; id < harnessBoatInputOverrides.length; id++) harnessBoatInputOverrides[id] = null;
  setHarnessInput(null);
  setHarnessEvidenceUiHidden(false);
  resetRace();
  if (name.startsWith('night-')) {
    timeOfDayManager.setOverride('night', true);
    sky.setTimeOfDay('night', 1);
    ocean.setTimeOfDay('night', 1);
    course.setTimeOfDay('night', 1);
    honorTargets.setTimeOfDay('night', 1);
  }
  const riderInspection = name === 'rider-inspection' || name.startsWith('rider-inspection-');
  const openingInspection = name === 'opening-showcase';
  if (name !== 'ready' && name !== 'night-ready' && !riderInspection && !openingInspection) startFreshCountdown();

  switch (name) {
    case "night-ready":
      loop.advance(1.5);
      break;
    case "night-start":
      advanceUntil(() => race.phase === "racing", 8);
      loop.advance(2.2);
      break;
    case "night-flight":
      advanceUntil(() => race.phase === "racing", 8);
      earnHarnessFlight(false);
      harnessKeepFlightMissRunning = true;
      launchEarnedHarnessFlight();
      loop.advance(0.35);
      setHarnessInput(null);
      harnessCameraOverride = {
        target: boats[0].object,
        offset: [0.95, 2.1, -3.3],
        lookAt: [0, 1.25, -0.6],
        fov: 50,
      };
      break;
    case "night-honor-coin":
      advanceUntil(() => race.phase === "racing", 8);
      {
        const target = honorTargets.debugTargets()[0];
        if (target) {
          boats[0].teleport(
            target.x - target.forwardX * 14,
            target.z - target.forwardZ * 14,
            Math.atan2(target.forwardX, target.forwardZ),
          );
          setHarnessInput({ throttle: 0 });
          harnessCameraOverride = {
            target: boats[0].object,
            offset: [0, 3.2, -10.4],
            lookAt: [0, 2.1, 5.5],
            fov: 54,
          };
          loop.advance(1.45);
        }
      }
      break;
    case "race-straight":
      advanceUntil(() => race.phase === "racing", 8);
      setHarnessInput({ throttle: 1, steer: 0 });
      loop.advance(0.8);
      loop.advance(0.25);
      setHarnessInput(null);
      harnessCameraOverride = {
        target: boats[0].object,
        offset: [0.95, 2.1, -3.3],
        lookAt: [0, 1.25, -0.6],
        fov: 50,
      };
      break;
    case "race-steer-left":
      advanceUntil(() => race.phase === "racing", 8);
      setHarnessInput({ throttle: 1, steer: -0.55 });
      loop.advance(0.8);
      loop.advance(0.25);
      setHarnessInput(null);
      harnessCameraOverride = {
        target: boats[0].object,
        offset: [0.95, 2.1, -3.3],
        lookAt: [0, 1.25, -0.6],
        fov: 50,
      };
      break;
    case "race-flight":
      advanceUntil(() => race.phase === "racing", 8);
      earnHarnessFlight(false);
      harnessKeepFlightMissRunning = true;
      launchEarnedHarnessFlight();
      loop.advance(0.35);
      setHarnessInput(null);
      harnessCameraOverride = {
        target: boats[0].object,
        offset: [0.95, 2.1, -3.3],
        lookAt: [0, 1.25, -0.6],
        fov: 50,
      };
      break;
    case "race-landing-recovery":
      advanceUntil(() => race.phase === "racing", 8);
      earnHarnessFlight(false);
      harnessKeepFlightMissRunning = true;
      launchEarnedHarnessFlight();
      const eventBeforeContact = boats[0].landingDebug().event;
      advanceUntil(() => boats[0].state.flightPhase === 'descending', 12, 1 / 60);
      advanceUntil(() => boats[0].state.landImpulse > 0 &&
        boats[0].landingDebug().event > eventBeforeContact, 8, 1 / 60);
      if (boats[0].state.landImpulse <= 0 ||
          boats[0].landingDebug().event !== eventBeforeContact + 1) {
        throw new Error("race-landing-recovery never touched water");
      }
      loop.advance(0.20);
      setHarnessInput(null);
      harnessCameraOverride = {
        target: boats[0].object,
        offset: [0.95, 2.1, -3.3],
        lookAt: [0, 1.25, -0.6],
        fov: 50,
      };
      break;
    case "landing-straight-drop":
      beginHarnessLandingDrop(0);
      break;
    case "landing-left-drop":
      beginHarnessLandingDrop(-0.65);
      break;
    case "landing-right-drop":
      beginHarnessLandingDrop(0.65);
      break;
    case "tail-inspection-sun": {
      advanceUntil(() => race.phase === 'racing', 8);
      const sunHeading = Math.atan2(VISIBLE_SUN_DIR.x, VISIBLE_SUN_DIR.z);
      placeHarnessBoat(0, 0.22, 0);
      boats[0].teleport(boats[0].state.position.x, boats[0].state.position.z, sunHeading);
      settleHarnessTailInspection();
      harnessCameraOverride = {
        target: boats[0].object,
        offset: [0, 1.6, -6],
        lookAt: [0, 0.9, -2.3],
        fov: 48,
      };
      break;
    }
    case "tail-inspection-shade": {
      advanceUntil(() => race.phase === 'racing', 8);
      const shadeHeading = Math.atan2(VISIBLE_SUN_DIR.x, VISIBLE_SUN_DIR.z) + Math.PI;
      placeHarnessBoat(0, 0.22, 0);
      boats[0].teleport(boats[0].state.position.x, boats[0].state.position.z, shadeHeading);
      settleHarnessTailInspection();
      harnessCameraOverride = {
        target: boats[0].object,
        offset: [0, 1.6, -6],
        lookAt: [0, 0.9, -2.3],
        fov: 48,
      };
      // Assert reactor layer/userData properties
      const reactor = boats[0].object.getObjectByName('boat-reactor-batch');
      if (!reactor) throw new Error('boat-reactor-batch not found');
      if (!reactor.layers.isEnabled(0)) throw new Error('reactor layer 0 disabled');
      if (reactor.layers.isEnabled(LAYER_INK)) throw new Error('reactor LAYER_INK enabled');
      if (!reactor.layers.isEnabled(LAYER_ENERGY)) throw new Error('reactor LAYER_ENERGY disabled');
      if (reactor.userData.noInk !== true) throw new Error('reactor userData.noInk !== true');
      if (reactor.userData.noOutline !== true) throw new Error('reactor userData.noOutline !== true');
      break;
    }
    case "tail-inspection-side": {
      advanceUntil(() => race.phase === 'racing', 8);
      placeHarnessBoat(0, 0.22, 0);
      loop.advance(0.05);
      harnessCameraOverride = {
        target: boats[0].object,
        offset: [3.8, 1.2, -2.8],
        lookAt: [0, 0.9, -2.3],
        fov: 45,
      };
      break;
    }
    case "tail-drift-left":
      prepareHarnessTailDrift(-0.85);
      break;
    case "tail-drift-right":
      prepareHarnessTailDrift(0.85);
      break;
    case "tail-airbrake-left":
      prepareHarnessTailAirBrake(-0.85);
      break;
    case "tail-airbrake-right":
      prepareHarnessTailAirBrake(0.85);
      break;
    case "lighthouse-inspection":
      advanceUntil(() => race.phase === 'racing', 8);
      loop.advance(0.7);
      course.object.visible = false;
      spray.object.visible = false;
      jetTrail.object.visible = false;
      for (const boat of boats) boat.object.visible = false;
      for (const wake of wakes) wake.object.visible = false;
      harnessCameraOverride = {
        target: lighthouse.object,
        offset: [-54, 11, -38],
        lookAt: [0, 15.2, 0],
        fov: 36,
      };
      break;
    case "lighthouse-chase":
      advanceUntil(() => race.phase === 'racing', 8);
      placeHarnessBoat(0, 0.02, 0);
      setHarnessInput({ throttle: 1 });
      loop.advance(1.2);
      harnessCameraOverride = {
        target: boats[0].object,
        offset: [0.8, 3.0, -8.5],
        lookAt: [10, 3.0, 45],
        fov: 55,
      };
      break;
    case "rider-inspection":
    case "rider-inspection-front": {
      const face = prepareHarnessRiderInspection();
      harnessCameraOverride = {
        target: face,
        offset: [0, 0.10, 2.2],
        lookAt: [0, 0.10, 0],
        fov: 28,
      };
      break;
    }
    case "rider-inspection-three-quarter": {
      const face = prepareHarnessRiderInspection();
      harnessCameraOverride = {
        target: face,
        offset: [1.55, 0.14, 1.55],
        lookAt: [0, 0.10, 0],
        fov: 28,
      };
      break;
    }
    case "rider-inspection-side": {
      const face = prepareHarnessRiderInspection();
      harnessCameraOverride = {
        target: face,
        offset: [2.2, 0.12, 0],
        lookAt: [0, 0.10, 0],
        fov: 28,
      };
      break;
    }
    case "rider-inspection-back": {
      const face = prepareHarnessRiderInspection();
      harnessCameraOverride = {
        target: face,
        offset: [0, 0.16, -2.2],
        lookAt: [0, 0.10, 0],
        fov: 28,
      };
      break;
    }
    case "rider-inspection-chase": {
      prepareHarnessRiderInspection();
      harnessCameraOverride = {
        target: boats[0].object,
        offset: [0, 3.0, -8.0],
        lookAt: [0, 0.8, 0],
        fov: 45,
      };
      break;
    }
    case "opening-showcase":
      openingShowcase.start(OPENING_SHOWCASE_S);
      ocean.setOpeningIntensity(1);
      sky.setOpeningIntensity(1);
      driverSelect.setLaunchPending(true);
      loop.advance(1.25);
      break;
    case "ready":
      loop.advance(1.5);
      break;
    case "countdown":
      loop.advance(1.7);
      break;
    case "start":
      advanceUntil(() => race.phase === "racing", 8);
      loop.advance(2.2);
      break;
    case "medal-ceremony":
      advanceUntil(() => race.phase === "racing", 8);
      startMedalCeremony("ordinary", 3, 3);
      loop.advance(2);
      break;
    case "finale-certificate":
      // Capture-only scenario: leave the seven-flight certificate on screen
      // with its countdown running so both frames can review the quiet
      // utility row and the veteran shortcut.
      armHarnessFinale();
      loop.advance(FINALE_MIN_READ_S + 0.4);
      break;
    case "finale-honors":
      // Capture-only scenario: leave the honor wall settled on screen so
      // desktop and 844x390 visual review can inspect the second result beat.
      runFinaleHonorSequenceCase(true);
      loop.advance(0.1);
      break;
    case "radio-technique":
      stageRadioTechniqueBroadcast();
      break;
    case "drift-charge":
      advanceUntil(() => race.phase === "racing", 8);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => boats[0].state.speed >= 18, 5);
      setHarnessInput({ throttle: 1, drift: true });
      loop.advance(0.9);
      break;
    case "flight-ready":
      advanceUntil(() => race.phase === "racing", 8);
      placePack(0);
      earnHarnessFlight(false);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => course.guidanceStatus().actionCue === "launch", 5);
      loop.advance(0.05);
      break;
    case "flight-stock-full":
      advanceUntil(() => race.phase === "racing", 8);
      course.resetFlightChallenge();
      placePack(0.15);
      boats[0].state.flightCharges = MAX_FLIGHT_CHARGES;
      setHarnessInput({ throttle: 0 });
      loop.advance(0.05);
      break;
    case "flight-extension-spool":
      advanceUntil(() => race.phase === "racing", 8);
      beginHarnessRouteFlight(2, 2);
      advanceUntil(() => boats[0].state.flightExtensionReady, 3);
      if (!boats[0].state.flightExtensionReady) {
        throw new Error("flight-extension-spool never exposed the real extension window");
      }
      break;
    case "gate-copy":
      advanceUntil(() => race.phase === "racing", 8);
      stageHarnessGateFailure();
      break;
    case "corridor-storm":
    case "corridor-storm-deep": {
      // Steer out of the mist corridor and hold until the storm reaches the
      // target danger band: edge shred (~0.3) vs losing control (~0.72).
      advanceUntil(() => race.phase === "racing", 8);
      beginHarnessRouteFlight(0, 1);
      const target = name === "corridor-storm" ? 0.3 : 0.55;
      setHarnessInput({ steer: -0.9 });
      advanceUntil(() => course.playerCorridorDanger >= target, 5);
      setHarnessInput(null);
      loop.advance(0.05);
      break;
    }
    case "ocean-near":
      advanceUntil(() => race.phase === "racing", 8);
      setHarnessInput({ throttle: 0 });
      loop.advance(2.0);
      break;
    case "buoy-inspection": {
      advanceUntil(() => race.phase === "racing", 8);
      loop.advance(1.5);
      course.pointAt(CHECKPOINT_US[0], tmpP);
      course.tangentAt(CHECKPOINT_US[0], tmpT).normalize();
      const buoyX = tmpP.x + tmpT.z * 7;
      const buoyZ = tmpP.z - tmpT.x * 7;
      const sx = buoyX - tmpT.x * 8.5 - tmpT.z * 1.5;
      const sz = buoyZ - tmpT.z * 8.5 + tmpT.x * 1.5;
      boats[0].teleport(sx, sz, Math.atan2(buoyX - sx, buoyZ - sz));
      setHarnessInput({ throttle: 0 });
      loop.advance(0.6);
      break;
    }
    case "honor-target":
      // Face the first live coin after the real countdown so the retained
      // visual-review scenario frames an authored honor prop.
      advanceUntil(() => race.phase === "racing", 8);
      {
        const target = honorTargets.debugTargets()[0];
        if (target) {
          boats[0].teleport(
            target.x - target.forwardX * 14,
            target.z - target.forwardZ * 14,
            Math.atan2(target.forwardX, target.forwardZ),
          );
          setHarnessInput({ throttle: 0 });
          harnessCameraOverride = {
            target: boats[0].object,
            offset: [0, 3.2, -10.4],
            lookAt: [0, 2.1, 5.5],
            fov: 54,
          };
          loop.advance(1.45);
        }
      }
      break;
    case "honor-coin-hit": {
      // A capture-only hit beat keeps the authored pickup readable: the camera
      // watches the marker while the real boat crosses its collision radius,
      // so the burst and the owner notice can be reviewed together.
      advanceUntil(() => race.phase === "racing", 8);
      for (let id = 1; id < race.racers.length; id++) race.racers[id].eliminated = true;
      const target = honorTargets.debugTargets().find((candidate) => candidate.kind === 'coin');
      if (!target) throw new Error('honor coin hit scenario has no coin target');
      boats[0].teleport(
        target.x - target.forwardX * 16,
        target.z - target.forwardZ * 16,
        Math.atan2(target.forwardX, target.forwardZ),
      );
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => honorTargets.debugState().coinBursts > 0, 5, 1 / 60);
      setHarnessInput(null);
      const targetObject = honorTargets.object.getObjectByName(`honor-target-${target.index + 1}`);
      if (targetObject) {
        harnessCameraOverride = {
          target: targetObject,
          offset: [0, 3.8, -11.8],
          lookAt: [0, 1.15, 0],
          fov: 52,
        };
      }
      loop.advance(0.22);
      break;
    }
    case "buoy-tumble-spin": {
      advanceUntil(() => race.phase === "racing", 8);
      loop.advance(1.5);
      course.pointAt(CHECKPOINT_US[0], tmpP);
      course.tangentAt(CHECKPOINT_US[0], tmpT).normalize();
      const buoyX = tmpP.x + tmpT.z * 7;
      const buoyZ = tmpP.z - tmpT.x * 7;
      const sx = buoyX - tmpT.x * 32;
      const sz = buoyZ - tmpT.z * 32;
      boats[0].teleport(sx, sz, Math.atan2(buoyX - sx, buoyZ - sz));
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => {
        const p = boats[0].state.position;
        return Math.hypot(buoyX - p.x, buoyZ - p.z) < 2.8;
      }, 5);
      loop.advance(0.24);
      break;
    }
    case "buoy-feather-pop": {
      advanceUntil(() => race.phase === "racing", 8);
      loop.advance(1.5);
      course.pointAt(CHECKPOINT_US[0], tmpP);
      course.tangentAt(CHECKPOINT_US[0], tmpT).normalize();
      const buoyX = tmpP.x + tmpT.z * 7;
      const buoyZ = tmpP.z - tmpT.x * 7;
      const sx = buoyX - tmpT.x * 32;
      const sz = buoyZ - tmpT.z * 32;
      boats[0].teleport(sx, sz, Math.atan2(buoyX - sx, buoyZ - sz));
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => {
        const p = boats[0].state.position;
        return Math.hypot(buoyX - p.x, buoyZ - p.z) < 2.8;
      }, 5);
      loop.advance(0.76);
      break;
    }
    case "buoy-hit": {
      advanceUntil(() => race.phase === "racing", 8);
      course.pointAt(CHECKPOINT_US[0], tmpP);
      course.tangentAt(CHECKPOINT_US[0], tmpT).normalize();
      const buoyX = tmpP.x + tmpT.z * 7;
      const buoyZ = tmpP.z - tmpT.x * 7;
      const sx = tmpP.x - tmpT.x * 26;
      const sz = tmpP.z - tmpT.z * 26;
      boats[0].teleport(sx, sz, Math.atan2(buoyX - sx, buoyZ - sz));
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => {
        const p = boats[0].state.position;
        return Math.hypot(buoyX - p.x, buoyZ - p.z) < 3;
      }, 5);
      loop.advance(0.5);
      break;
    }
    case "ocean-near-t2":
      advanceUntil(() => race.phase === "racing", 8);
      setHarnessInput({ throttle: 0 });
      loop.advance(2.37);
      break;
    case "ocean-sunpath": {
      // Turn until the chase camera faces the visible sun, then run straight
      // at it — validates the disc, sunward reflection lane, and subtle veil.
      advanceUntil(() => race.phase === "racing", 8);
      const sunHeading = Math.atan2(VISIBLE_SUN_DIR.x, VISIBLE_SUN_DIR.z);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => boats[0].state.speed >= 14, 6);
      for (let i = 0; i < 900; i++) {
        const err = sunHeading - boats[0].state.heading;
        const wrapped = Math.atan2(Math.sin(err), Math.cos(err));
        if (Math.abs(wrapped) < 0.05) break;
        setHarnessInput({ throttle: 1, steer: wrapped > 0 ? -0.6 : 0.6 });
        loop.advance(1 / 30);
      }
      setHarnessInput({ throttle: 1, steer: 0 });
      loop.advance(1.2);
      break;
    }
    default:
      throw new Error(`unknown scenario: `);
  }
  if (name === 'race-straight' || name === 'race-steer-left' ||
      name === 'race-flight' || name === 'race-landing-recovery') {
    assertHarnessRiderPose(name);
  }
  if (CLEAN_EVIDENCE_SCENARIOS.has(name)) setHarnessEvidenceUiHidden(true);
}

function runBuoyCase(): Record<string, number | boolean> {
  scenario('buoy-hit');
  const impact = course.buoyDebugStates().find((state) => state.knocked);
  if (!impact) throw new Error('buoy diagnostic never produced a physical hit');
  const index = impact.index;
  advanceUntil(() => course.buoyDebugStates().some((state) => state.index === index && state.landed), 4);
  const landed = course.buoyDebugStates().find((state) => state.index === index);
  if (!landed?.landed) throw new Error('knocked buoy never returned to the water');
  advanceUntil(() => !course.buoyDebugStates().some((state) => state.index === index && state.knocked), 10);
  const restored = course.buoyDebugStates().find((state) => state.index === index);
  return {
    maxHeight: landed.maxHeight,
    distance: landed.distance,
    visibleDuringFlight: landed.visible,
    landed: landed.landed,
    respawned: restored?.knocked === false,
    visibleAfterRespawn: restored?.visible === true,
  };
}

function runHonorTargetCase(): Record<string, number | string | boolean> {
  scenario('honor-target');
  // Isolate the target probe from AI traffic. The diagnostic is measuring the
  // player's center/edge precision, so a bot grazing the same prop must not
  // consume the target slot or make the aggregate precision count vary.
  for (let id = 1; id < race.racers.length; id++) race.racers[id].eliminated = true;
  comebackAwarded[0] = true;
  previousHumanPlaces[0] = 1;
  const target = honorTargets.debugTargets()[0];
  if (!target) throw new Error('honor target diagnostic has no target');
  // A target is a surface honor prop, never a hidden flight-energy station.
  // Reset the boat's authored checkpoint before each probe so a pre-existing
  // drift payout cannot make the diagnostic look like target behavior.
  boats[0].restoreFlightCheckpoint(0, 0);
  const chargesBeforeFirst = boats[0].state.flightCharges;
  const startX = target.x - target.forwardX * 16;
  const startZ = target.z - target.forwardZ * 16;
  boats[0].teleport(startX, startZ, Math.atan2(target.forwardX, target.forwardZ));
  setHarnessInput({ throttle: 1 });
  advanceUntil(() => honorTargets.debugState().hits > 0, 5, 1 / 60);
  setHarnessInput(null);
  const scoreAfterFirst = honors.scoreFor(0);
  const chargesAfterFirst = boats[0].state.flightCharges;
  const second = honorTargets.debugTargets()[1];
  if (!second) throw new Error('honor target diagnostic has no second target');
  boats[0].teleport(
    second.x - second.forwardX * 16,
    second.z - second.forwardZ * 16,
    Math.atan2(second.forwardX, second.forwardZ),
  );
  boats[0].restoreFlightCheckpoint(0, MAX_FLIGHT_CHARGES);
  const chargesBeforeSecond = boats[0].state.flightCharges;
  setHarnessInput({ throttle: 1 });
  advanceUntil(() => honorTargets.debugState().hits >= 2, 5, 1 / 60);
  setHarnessInput(null);
  const chargesAfterSecond = boats[0].state.flightCharges;
  const boostingAfterSecond = boats[0].state.boosting;
  const scoreAfterSecond = honors.scoreFor(0);
  const third = honorTargets.debugTargets()[2];
  if (!third) throw new Error('honor target diagnostic has no edge target');
  const rightX = third.forwardZ;
  const rightZ = -third.forwardX;
  boats[0].teleport(
    third.x - third.forwardX * 16 + rightX * 3.45,
    third.z - third.forwardZ * 16 + rightZ * 3.45,
    Math.atan2(third.forwardX, third.forwardZ),
  );
  boats[0].restoreFlightCheckpoint(0, 0);
  setHarnessInput({ throttle: 1 });
  advanceUntil(() => honorTargets.debugState().hits >= 3, 5, 1 / 60);
  loop.advance(1 / 60);
  setHarnessInput(null);
  const afterEdge = honorTargets.debugState();
  const targetStates = honorTargets.debugTargets();
  return {
    kind: target.kind,
    targetY: target.y,
    maxTargetY: Math.max(...targetStates.map((state) => state.y)),
    minTargetLateral: Math.min(...targetStates.map((state) => Math.abs(state.lateral))),
    targetKinds: targetStates.map((state) => state.kind).join(','),
    minCoinStartDistanceU: Math.min(...targetStates
      .filter((state) => state.kind === 'coin')
      .map((state) => Math.min(state.u, 1 - state.u))),
    hits: afterEdge.hits,
    centerHits: afterEdge.centerHits,
    edgeHits: afterEdge.edgeHits,
    chargesBeforeFirst,
    chargesAfterFirst,
    chargesBeforeSecond,
    chargesAfterSecond,
    flightCharges: boats[0].state.flightCharges,
    boostingAfterSecond,
    honorScore: honors.scoreFor(0),
    firstHonorDelta: scoreAfterFirst,
    secondHonorDelta: scoreAfterSecond - scoreAfterFirst,
    surfaceLayoutValid: afterEdge.surfaceLayoutValid,
  };
}

function harnessDuoEliminate(id: 0 | 1): void {
  if (!isDuoMode() || race.phase !== 'racing') throw new Error('duo elimination requires an active dual race');
  const boat = boats[id];
  eliminateDuoSeat(id, {
    reason: 'corridor',
    flightNumber: boat.state.flightsCleared + 1,
    routeSlot: boat.state.flightRouteCursor % Math.max(1, course.flightRoutes.length),
    flightsCleared: boat.state.flightsCleared,
    gatesPassed: boat.state.flightGateProgress,
    gateCount: Math.max(1, course.flightRoutes[boat.state.flightRouteCursor % course.flightRoutes.length]?.gateUs.length ?? 1),
    targetGate: null,
    routeU: 0,
    lateralOffsetM: null,
    lateralLimitM: null,
    corridorDistanceM: null,
    clearanceM: boat.state.flightClearance,
  });
}

/**
 * Harness-only P0 regression: put the two human boats on different authored
 * launches and verify that each split view owns a live, independent corridor.
 * The route detector and Boat remain the production path; only the two input
 * edges are injected here so this cannot mask a missing flight transition.
 */
function runDuoGuidanceCase(): Record<string, unknown> {
  if (!isDuoMode() || race.phase !== 'racing') {
    throw new Error('duo guidance diagnostic requires an active dual race');
  }
  const routes = [course.flightRoutes[0], course.flightRoutes[1]] as const;
  if (!routes[0] || !routes[1]) throw new Error('duo guidance diagnostic needs two authored routes');
  course.resetFlightChallenge();
  course.setGuidanceOwners([0, 1], 0);
  // Divergent route slots are the failure case: a shared material/visible flag
  // can look correct while both players overlap, then erase the right corridor
  // as soon as their progress separates.
  for (let id = 0; id < 2; id++) {
    const route = routes[id as 0 | 1]!;
    placeHarnessBoat(id, route.entryU + 0.001, id === 0 ? -1.4 : 1.4);
    boats[id].restoreFlightCheckpoint(id, 1);
  }
  harnessBoatInputOverrides[0] = { throttle: 1, steer: 0, flightTrigger: true };
  harnessBoatInputOverrides[1] = { throttle: 1, steer: 0, flightTrigger: true };
  loop.advance(1 / 60);
  const afterTrigger = boats.slice(0, 2).map((boat) => ({
    phase: boat.state.flightPhase,
    routeState: boat.state.flightRouteState,
    routeIndex: boat.state.flightRouteIndex,
    u: course.sample(boat.state.position, harnessPilotSample, 'surface').u,
  }));
  harnessBoatInputOverrides[0] = { throttle: 1, steer: 0, flightTrigger: false };
  harnessBoatInputOverrides[1] = { throttle: 1, steer: 0, flightTrigger: false };
  // Let spool/ascend settle while keeping both boats on the authored center.
  // Sample every fixed step after rendering both split views.  A final
  // visible-route assertion alone misses the intermittent right-seat failure
  // where a shared visibility/material write erases the corridor for a frame.
  const visibilityTimeline: Array<{
    phases: string[];
    routeStates: string[];
    activeRoutes: number[];
    visibleRoutes: number[];
  }> = [];
  const timelineSteps = Math.round(0.62 * 60);
  for (let stepIndex = 0; stepIndex < timelineSteps; stepIndex++) {
    loop.advance(1 / 60);
    render(16.7);
    const sample = [course.guidanceStatusFor(0), course.guidanceStatusFor(1)];
    visibilityTimeline.push({
      phases: boats.slice(0, 2).map((boat) => boat.state.flightPhase),
      routeStates: boats.slice(0, 2).map((boat) => boat.state.flightRouteState),
      activeRoutes: sample.map((entry) => entry.activeRouteIndex),
      visibleRoutes: sample.map((entry) => entry.visibleRouteCount),
    });
  }
  // Cross-seat Final regression: one player can arm the shared Final portal
  // while the other is still airborne on the last authored route. The latter
  // must keep its private corridor until its own recovery completes.
  for (let id = 0; id < 2; id++) boats[id].state.flightsCleared = course.flightRoutes.length;
  course.armFinalStation();
  loop.advance(1 / 60);
  render(16.7);
  const finalArmedRight = course.guidanceStatusFor(1);
  const finalArmedRightFlight = {
    phase: boats[1].state.flightPhase,
    routeState: boats[1].state.flightRouteState,
    activeRoute: finalArmedRight.activeRouteIndex,
    visibleRoutes: finalArmedRight.visibleRouteCount,
  };
  if (finalArmedRightFlight.phase !== 'surface' && finalArmedRightFlight.routeState !== 'failed' &&
      (finalArmedRightFlight.activeRoute < 0 || finalArmedRightFlight.visibleRoutes < 1)) {
    throw new Error(`right airborne route hidden after Final armed: ${JSON.stringify(finalArmedRightFlight)}`);
  }
  // The guidance seat owns the other half of the same contract. Final is one
  // shared flag, so an armed portal must not retire the left seat's corridor
  // while that boat is still flying its own route.
  const finalArmedLeft = course.guidanceStatusFor(0);
  const finalArmedLeftFlight = {
    phase: boats[0].state.flightPhase,
    routeState: boats[0].state.flightRouteState,
    activeRoute: finalArmedLeft.activeRouteIndex,
    visibleRoutes: finalArmedLeft.visibleRouteCount,
  };
  if (finalArmedLeftFlight.phase !== 'surface' && finalArmedLeftFlight.routeState !== 'failed' &&
      (finalArmedLeftFlight.activeRoute < 0 || finalArmedLeftFlight.visibleRoutes < 1)) {
    throw new Error(`left airborne route hidden after Final armed: ${JSON.stringify(finalArmedLeftFlight)}`);
  }
  const flightPhases = boats.slice(0, 2).map((boat) => boat.state.flightPhase);
  const flightRouteStates = boats.slice(0, 2).map((boat) => boat.state.flightRouteState);
  const flightStatus = [course.guidanceStatusFor(0), course.guidanceStatusFor(1)];
  // A non-primary human may finish the seventh recovery after the other seat
  // has already armed Final. Once back on the surface, the qualified boat must
  // stay idle near the launch span instead of being re-entered into an eighth
  // route and falsely eliminated for having no charge.
  const rightQualified = boats[1];
  const finalRouteCount = course.flightRoutes.length;
  const finalRoute = course.flightRoutes[0];
  placeHarnessBoat(1, finalRoute.gateUs[0] + 0.001, 0);
  rightQualified.state.flightPhase = 'surface';
  rightQualified.state.airborne = false;
  rightQualified.state.flightRouteState = 'idle';
  rightQualified.state.flightRouteIndex = -1;
  rightQualified.state.flightRouteCursor = finalRouteCount;
  rightQualified.state.flightsCleared = finalRouteCount;
  rightQualified.state.flightCharges = 0;
  course.resetFlightTrackingForBoat(rightQualified);
  harnessBoatInputOverrides[1] = { throttle: 1, steer: 0, flightTrigger: false };
  loop.advance(0.15);
  const qualifiedIdleGuard = {
    phase: rightQualified.state.flightPhase,
    routeState: rightQualified.state.flightRouteState,
    routeIndex: rightQualified.state.flightRouteIndex,
    failure: rightQualified.state.flightFailure?.reason ?? 'none',
  };
  if (qualifiedIdleGuard.phase !== 'surface' || qualifiedIdleGuard.routeState !== 'idle' ||
      qualifiedIdleGuard.routeIndex !== -1 || qualifiedIdleGuard.failure !== 'none') {
    throw new Error(`qualified duo seat re-entered a route after Final armed: ${JSON.stringify(qualifiedIdleGuard)}`);
  }
  // The same seat must still be able to fly on purpose. Qualifying retires the
  // forced attempts, not the authored routes: give it a charge and let it take
  // off again.
  rightQualified.state.flightCharges = 1;
  harnessBoatInputOverrides[1] = { throttle: 1, steer: 0, flightTrigger: true };
  loop.advance(1 / 60);
  harnessBoatInputOverrides[1] = { throttle: 1, steer: 0, flightTrigger: false };
  loop.advance(3 / 60);
  const qualifiedRelaunch = {
    phase: rightQualified.state.flightPhase,
    routeState: rightQualified.state.flightRouteState,
    routeIndex: rightQualified.state.flightRouteIndex,
    failure: rightQualified.state.flightFailure?.reason ?? 'none',
    visibleRoutes: course.guidanceStatusFor(1).visibleRouteCount,
  };
  harnessBoatInputOverrides[0] = null;
  harnessBoatInputOverrides[1] = null;
  render(16.7);
  return {
    afterTrigger,
    phases: flightPhases,
    routeStates: flightRouteStates,
    statuses: flightStatus,
    layers: flightStatus.map((entry) => entry.guideLayer),
    visibleRoutes: flightStatus.map((entry) => entry.visibleRouteCount),
    visibilityTimeline,
    finalArmedRightFlight,
    finalArmedLeftFlight,
    qualifiedIdleGuard,
    qualifiedRelaunch,
  };
}

/**
 * Split-play feedback regression: the second seat's own events must reach the
 * audio path. One feedback pass keyed to the primary seat used to leave the
 * right seat completely silent while the left seat heard everything.
 */
function runDuoFeedbackCase(): Record<string, unknown> {
  if (!isDuoMode() || race.phase !== 'racing') {
    throw new Error('duo feedback diagnostic requires an active dual race');
  }
  const sample = (): number => Number(audio.debugState().activeOneShots);
  const before = sample();
  const cuesBefore = seatHaptics.map((entry) => Number(entry.status().cueRequests));
  // Nudge only the right seat past a gate. The left seat keeps its state, so a
  // change in the one-shot count can only come from seat 1's own edge.
  boats[1].state.flightGateProgress += 1;
  loop.advance(1 / 60);
  const cuesAfter = seatHaptics.map((entry) => Number(entry.status().cueRequests));
  return {
    before,
    after: sample(),
    rightGateProgress: boats[1].state.flightGateProgress,
    leftGateProgress: boats[0].state.flightGateProgress,
    // The cue must reach the right seat's own coordinator and nobody else's.
    rightCueDelta: cuesAfter[1] - cuesBefore[1],
    leftCueDelta: cuesAfter[0] - cuesBefore[0],
  };
}

/**
 * Split-play impact-card regression: each seat must own a card inside its own
 * half. One shared card used to sit on the seam and a high-priority notice
 * from either seat silently evicted the other's.
 */
function runDuoImpactCase(): Record<string, unknown> {
  if (!isDuoMode() || race.phase !== 'racing') {
    throw new Error('duo impact diagnostic requires an active dual race');
  }
  for (const lane of ['left', 'right'] as const) {
    hud.showHonorTargetNotice(roster[lane === 'left' ? 0 : 1].name, '席位提示', 10, 'edge', lane, 0);
  }
  const cards = [...document.querySelectorAll<HTMLElement>('.hud-impact.on')].map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      slot: el.dataset.slot ?? '',
      lane: el.dataset.lane ?? '',
      left: Math.round(rect.left),
      right: Math.round(rect.right),
    };
  });
  return { cards, half: Math.round(window.innerWidth / 2) };
}

/**
 * Split play has to hand each seat its own news. The right seat's own gate
 * edge must raise a card in the right half, and a dual-seat interaction must
 * warn the seat it actually lands on instead of always the left one.
 */
function runDuoNoticeCase(): Record<string, unknown> {
  if (!isDuoMode() || race.phase !== 'racing') {
    throw new Error('duo notice diagnostic requires an active dual race');
  }
  const cards = () => [...document.querySelectorAll<HTMLElement>('.hud-impact.on')].map((el) => ({
    slot: el.dataset.slot ?? '',
    lane: el.dataset.lane ?? '',
  }));
  hud.clearTransientNotices();
  // Only the right seat crosses a gate: the card belongs to its half.
  const rightSeat = boats[1];
  rightSeat.state.flightRouteState = 'active';
  rightSeat.state.flightGateProgress = 0;
  hud.update(1 / 60, race, primaryBoat(), boats);
  rightSeat.state.flightGateProgress = 1;
  hud.update(1 / 60, race, primaryBoat(), boats);
  const afterRightGate = cards();
  // An interaction aimed at the right seat must warn the right seat's half,
  // through the real presentation path rather than a hand-built lane.
  hud.clearTransientNotices();
  handleDuoInteraction({
    actorId: 0, targetId: 1, action: 'prank', phase: 'prank-launch', accepted: true, chargesLeft: 2,
  });
  const afterRightInteraction = cards();
  hud.clearTransientNotices();
  return { afterRightGate, afterRightInteraction };
}

/**
 * Split play gives each seat its own near-boat instrument: two widgets, each
 * projecting through its own seat camera and staying inside its own half.
 */
function runDuoDriverPowerCase(): Record<string, unknown> {
  if (!isDuoMode() || race.phase !== 'racing') {
    throw new Error('duo driver power diagnostic requires an active dual race');
  }
  // Different banks so the two widgets cannot be mistaken for one shared one.
  boats[0].state.flightCharges = 1;
  boats[1].state.flightCharges = 3;
  for (let i = 0; i < 90; i++) hud.update(1 / 60, race, primaryBoat(), boats);
  const half = Math.round(window.innerWidth / 2);
  const widgets = [...document.querySelectorAll<HTMLElement>('.hud-driver-power')].map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      seat: el.dataset.seat ?? '',
      hidden: el.hidden,
      visibility: getComputedStyle(el).visibility,
      on: el.classList.contains('on'),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      lit: el.querySelectorAll('.hud-driver-stock.on').length,
    };
  });
  return { half, widgets };
}

/**
 * Split play pays one rAF budget for two views. Feed the governor a sustained
 * slow frame and it must stop well above the single-view floor, or both halves
 * drift soft in exactly the scenes the player needs to read.
 */
function runQualityGovernorCase(): Record<string, unknown> {
  const start = Number(stage.stats().pixelRatio);
  stage.debugPerfFrames(24, 240, 1);
  const soloFloor = Number(stage.stats().pixelRatio);
  stage.pixelRatio = start;
  stage.debugPerfFrames(24, 240, 2);
  const splitFloor = Number(stage.stats().pixelRatio);
  stage.pixelRatio = start;
  return {
    start: Math.round(start * 1000) / 1000,
    soloFloor: Math.round(soloFloor * 1000) / 1000,
    splitFloor: Math.round(splitFloor * 1000) / 1000,
    minPixelRatio: Number(stage.stats().minPixelRatio),
  };
}

if (HARNESS) {
  const harness: Harness = {
    ready: true,
    scenario,
    advance: (seconds) => loop.advance(seconds),
    render: () => render(16.7),
    tapFlight: tapHarnessFlight,
    setFlightCharges: (charges) => {
      boats[0].state.flightCharges = Math.max(0, Math.min(MAX_FLIGHT_CHARGES, Math.round(charges)));
    },
    playerState: () => ({
      flightCharges: boats[0].state.flightCharges,
      phase: race.phase,
    }),
    stats: () => stage.stats(),
    mobileStatus: () => mobileInput.status(),
    audioState: () => audio.debugState(),
    audioEventLog: () => audio.audioEventLog(),
    setVisibility: handleVisibility,
    resumeInterruption,
    collisionCase: runCollisionCase,
    collisionFeedbackCase: runCollisionFeedbackCase,
    cameraImpactCase: runCameraImpactCase,
    radioTechniqueCase: runRadioTechniqueCase,
    offCourseRecoveryCase: runOffCourseRecoveryCase,
    finalEligibilityCase: runFinalEligibilityCase,
    postSetRankCase: runPostSetRankCase,
    finaleHonorSequenceCase: runFinaleHonorSequenceCase,
    finaleAutoFlowCase: runFinaleAutoFlowCase,
    finalContinueRankCase: runFinalContinueRankCase,
    singleHonorCase: runSingleHonorCase,
    buoyState: () => course.buoyDebugStates(),
    buoyCase: runBuoyCase,
    honorTargetCase: runHonorTargetCase,
    riderPoseState: () => riders[0].poseDebug(),
    riderHairState: () => riders[0].hairDebug(),
    flapCase: runFlapCase,
    lighthouseState: () => lighthouse.debugState(),
    faceState: () => {
      let active = 0;
      let withFaceMesh = 0;
      for (const rider of riders) {
        active++;
        if (rider.faceDebug().hasFaceMesh) withFaceMesh++;
      }
      return {
        active,
        withFaceMesh,
        cacheSize: getFaceTextureCacheSize(),
      };
    },
    sprayState: () => ({
      spray: spray.debugState(),
      boat: boats[0].landingDebug(),
    }),
    selectDriver: (id) => applySelectedDriver(id),
    teamFrontDoor: enterFrontDoor,
    teamState: () => {
      const snapshot = teamExpedition.snapshot();
      course.sample(boats[0].state.position, harnessPilotSample, 'surface');
      const leftU = harnessPilotSample.u;
      const leftDistance = harnessPilotSample.distance;
      course.sample(boats[1].state.position, harnessPilotSample, 'surface');
      const rightU = harnessPilotSample.u;
      const rightDistance = harnessPilotSample.distance;
      return {
        appMode,
        teamPaused,
        ...snapshot,
        leftRole: teamExpedition.roleFor('left'),
        rightRole: teamExpedition.roleFor('right'),
        leftPhase: boats[0].state.flightPhase,
        rightPhase: boats[1].state.flightPhase,
        leftSteer: boats[0].state.steer,
        rightSteer: boats[1].state.steer,
        leftSpeed: boats[0].state.speed,
        rightSpeed: boats[1].state.speed,
        leftThrottle: boats[0].state.throttle,
        rightThrottle: boats[1].state.throttle,
        leftCharges: boats[0].state.flightCharges,
        rightCharges: boats[1].state.flightCharges,
        leftRouteState: boats[0].state.flightRouteState,
        rightRouteState: boats[1].state.flightRouteState,
        progress: { leftU, rightU, leftDistance, rightDistance },
        visibleBoats: boats.filter((boat) => boat.object.visible).map((boat) => boat.id),
        guidance: course.guidanceStatus(),
      };
    },
    teamPlaceAtTarget: (side) => {
      if (teamExpedition.snapshot().phase !== 'tutorial' && teamExpedition.snapshot().phase !== 'racing') return;
      teamExpedition.debugPlaceAtTarget(side);
    },
    duoState: () => ({
      appMode,
      phase: race.phase,
      raceTime: race.raceTime,
      interruptionActive,
      duoPauseActive,
      primaryPlayerId: race.player().id,
      playerIds: race.players().map((racer) => racer.id),
      racers: race.racers.map((racer) => ({
        id: racer.id,
        name: racer.name,
        place: racer.place,
        progress: racer.progress,
        isPlayer: racer.isPlayer,
        eliminated: racer.eliminated,
        finished: racer.finished,
        throttle: boats[racer.id].state.throttle,
        steer: boats[racer.id].state.steer,
        speed: boats[racer.id].state.speed,
        flightPhase: boats[racer.id].state.flightPhase,
        flightCharges: boats[racer.id].state.flightCharges,
      })),
      devices: [...duoDevices],
      eliminated: [...duoEliminated],
      honors: honors.debugState(),
      honorTargets: honorTargets.debugState(),
      interactions: duoInteractions.snapshot(),
      guidanceBySeat: [course.guidanceStatusFor(0), course.guidanceStatusFor(1)],
      guidance: course.guidanceStatus(),
      deviceStatus: duoDevices.map((device) => localInput.deviceStatus(device)),
      controls: document.querySelector<HTMLElement>('.hud-duo-controls')?.textContent?.trim() ?? '',
      controlsVisible: document.querySelector<HTMLElement>('.hud-duo-controls')?.classList.contains('on') ?? false,
      splitScreen: isDuoSplitPhase(),
      leftCamera: {
        x: teamLeftCamera.position.x,
        y: teamLeftCamera.position.y,
        z: teamLeftCamera.position.z,
      },
      rightCamera: {
        x: teamRightCamera.position.x,
        y: teamRightCamera.position.y,
        z: teamRightCamera.position.z,
      },
      result: lastResultEnvelope,
    }),
    duoGuidanceCase: runDuoGuidanceCase,
    duoFeedbackCase: runDuoFeedbackCase,
    duoImpactCase: runDuoImpactCase,
    duoNoticeCase: runDuoNoticeCase,
    duoDriverPowerCase: runDuoDriverPowerCase,
    qualityGovernorCase: runQualityGovernorCase,
    duoEliminate: harnessDuoEliminate,
    timeOfDayState: () => ({
      timeOfDay: timeOfDayManager.current,
      blend: timeOfDayManager.blend,
      round: timeOfDayManager.round,
    }),
    setTimeOfDay: (tod: TimeOfDay) => {
      timeOfDayManager.setOverride(tod, true);
      sky.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
      ocean.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
      course.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
      honorTargets.setTimeOfDay(timeOfDayManager.current, timeOfDayManager.blend);
    },
  };
  (window as unknown as { __harness: Harness }).__harness = harness;
} else {
  loop.start();
}
