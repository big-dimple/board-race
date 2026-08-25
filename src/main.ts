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
import { LocalMultiplayerInput, type SeatSide } from './core/localMultiplayerInput';
import { GamepadInput } from './core/gamepadInput';
import { Haptics } from './core/haptics';
import { MobileControls } from './core/mobileControls';
import { ImmersiveModeController } from './core/immersiveMode';
import { Ocean } from './water/ocean';
import { SeaDecor } from './water/seaDecor';
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
import { AIController } from './game/ai';
import { RivalDirector } from './game/rivalDirector';
import { BoatCollisionSystem, type CollisionHit } from './game/collision';
import { TeamExpedition, type TeamExpeditionEvent } from './game/teamExpedition';
import type { BalloonPop, BuoyHit } from './game/course';
import { CameraRig, type CameraImpactLevel } from './game/chaseCamera';
import { HUD } from './hud/hud';
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
import {
  TeamExperience,
  loadTeamSave,
  saveTeamProgress,
  type TeamSelection,
} from './hud/teamExperience';
import { trackGameEvent } from './game/eventLog';
import {
  LAYER_ENERGY,
  LAYER_INK,
  MAX_FLIGHT_CHARGES,
  type BoatInput,
  type ChallengeResult,
  type ChallengeTier,
  type CourseSample,
  type FlightFailureSnapshot,
  type FlightRouteState,
  type RaceView,
} from './contracts';
import { deriveAbilityHudState } from './core/abilityTelemetry';

const params = new URLSearchParams(location.search);
const HARNESS = import.meta.env.DEV && params.has('harness');
const DESKTOP_DRIVER_STAGE = window.matchMedia('(pointer: fine) and (min-width: 1366px) and (min-height: 768px)');
const harnessEndlessMode = HARNESS;
type AppMode = 'front-door' | 'independent' | 'team-play';
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
const seaDecor = new SeaDecor(stage.quality.mode);
stage.scene.add(seaDecor.object);
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
const records = new RecordsStore();
const drivingCoach = new DrivingCoach(records.data.coach, (progress) => records.saveCoach(progress));
const pcControlPrimer = new PcControlPrimer();
let selectedDriverId = loadSelectedDriver();
let roster = buildRaceRoster(selectedDriverId);

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

const cameraRig = new CameraRig(stage.camera);
const teamLeftCamera = new THREE.PerspectiveCamera(stage.camera.fov, 1, stage.camera.near, stage.camera.far);
const teamRightCamera = new THREE.PerspectiveCamera(stage.camera.fov, 1, stage.camera.near, stage.camera.far);
const teamLeftCameraRig = new CameraRig(teamLeftCamera);
const teamRightCameraRig = new CameraRig(teamRightCamera);
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
tower.setRoster(roster);
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
const finale = new FinaleOverlay(hudLayer, continueAfterFinale, openExpansionGallery, openFinaleCapturePreview);
const capturePreview = new CapturePreview(
  hudLayer,
  capture,
  handleCaptureOutcome,
  setCaptureOverlayVisible,
  restoreMobileImmersiveFromCaptureGesture,
);
const expansionGallery = new ExpansionGallery(
  hudLayer,
  (index) => records.markExpansionSeen(index),
  () => {
    // Returning from the dossier restores the frozen presentation, not gameplay.
    // Keep touch controls out of the result composition until a new run begins.
    mobileInput.setOverlayHidden(true);
    if (race.phase !== 'medal') finale.focusPrimary();
  },
);

const input = new Input();
const localInput = new LocalMultiplayerInput();
const gamepadInput = new GamepadInput();
let activeInputDevice: CoachInputDevice = mobileInput.enabled ? 'mobile' : 'keyboard';
const haptics = new Haptics(gamepadInput, () => activeInputDevice);
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
const pipeline = createPostPipeline(stage.renderer, stage.scene, stage.camera, prePass, stage.quality);
const teamLeftPrePass = new PrePass(4, 4);
const teamRightPrePass = new PrePass(4, 4);
const teamLeftPipeline = createPostPipeline(
  stage.renderer, stage.scene, teamLeftCamera, teamLeftPrePass, stage.quality,
);
const teamRightPipeline = createPostPipeline(
  stage.renderer, stage.scene, teamRightCamera, teamRightPrePass, stage.quality,
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
  onIndependent: enterIndependentCompetition,
  onTeamStart: startTeamExpedition,
  onExitTeam: enterFrontDoor,
  onAudioIntent: () => {
    audio.resume();
    audio.startReadyMusic();
  },
});
teamExperience.setSavedStage(teamSave.stage, teamSave.completed);
teamExperience.setSavedDrivers(teamSave.leftDriverId, teamSave.rightDriverId);

// -------------------------------------------------------------- race events
let resultsShown = false;
const DEFEAT_FREEZE_S = 0.35;
const FAILURE_REVIEW_AUTO_S = 5;
const MEDAL_CEREMONY_S = 6.5;
const MEDAL_MIN_READ_S = 4.5;
const FINALE_REVEAL_S = 4.8;
const FINALE_MIN_READ_S = 3.2;
const FINALE_CAMERA_HERO_S = 0.75;
const FINALE_CAPTURE_S = 0.78;
let retryLessonActive = false;
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
let worldTime = 0;
let presentationTime = 0;
const OPENING_SHOWCASE_S = 3.6;
let freshStartPending = false;
let medalElapsed = 0;
let finaleElapsed = 0;
let finalePresentation = false;
let finaleCapturePending = false;
let interruptionActive = false;
let pageWasHidden = false;
let interruptionNeedsCountdown = false;
const retryReasonCounts = new Map<string, number>();
let prevFlightCharges = 0;
let prevDriftReleaseReady = false;
let prevFlightGateProgress = 0;
let prevFlightRouteState = boats[0].state.flightRouteState;
let prevFlightPhase = boats[0].state.flightPhase;
let prevBoosting = false;
let prevAirBraking = false;
let prevDrifting = false;
let prevTurnWarning = false;
let prevCorridorStage = 0;
let harnessCheckpointEvents = 0;
let harnessCollisionFxBursts = 0;
let harnessRoutePilotIndex = -1;
const harnessRoutePasses = new Array<number>(boats.length).fill(0);
const harnessRouteFails = new Array<number>(boats.length).fill(0);
const harnessPrevRouteStates: FlightRouteState[] = boats.map((boat) => boat.state.flightRouteState);
const routeLifecycleStates: FlightRouteState[] = boats.map((boat) => boat.state.flightRouteState);

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
    tower.announceGo(roster[0].name);
    if (!resuming && !drivingCoach.progress.mastery.airBrakedInTurn) tower.announceTechniqueTip();
  },
  lapDone: () => {},
  checkpoint: () => {
    if (HARNESS) harnessCheckpointEvents++;
  },
  finish: (r) => {
    course.pulseFinalStation();
    if (r.isPlayer) audio.finishSting();
  },
  courseWarning: (r, warning) => {
    if (r.isPlayer && warning !== 'none') {
      haptics.cue('warning');
    }
  },
  battle: (event) => {
    hud.showBattle(event);
    cameraRig.raceBattleKick(event.kind, event.opponents.length);
    audio.raceBattle(event.kind, event.opponents.length, event.toPlace);
    pipeline.pulse(event.kind, Math.min(1.35, 0.95 + event.opponents.length * 0.12));
    rivalDirector.notifyBattle();
    tower.announceBattle(event);
  },
}, roster);

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
    riders[definition.id].update(1 / 60, boats[definition.id].state, presentationTime, false);
  }
  ais = buildAiControllers();
  race.setDefinitions(roster);
  tower.setRoster(roster);
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
  seaDecor.setOpening(true);
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
  localInput.reset();
  collisions.setFriendlyPair(0, 1, false);
  activeTeamSelection = null;
  teamPaused = false;
  appMode = 'independent';
  resetRace();
  applySelectedDriver(selectedDriverId);
  teamExperience.hideAll();
  hud.setVisible(true);
  tower.setVisible(true);
  mixer.setVisible(!mobileInput.enabled);
  mobileInput.setOverlayHidden(false);
}

function enterFrontDoor(): void {
  teamExpedition.stop();
  localInput.reset();
  collisions.setFriendlyPair(0, 1, false);
  activeTeamSelection = null;
  teamPaused = false;
  appMode = 'front-door';
  resetRace();
  applySelectedDriver(selectedDriverId);
  driverSelect.hide();
  hud.setVisible(false);
  tower.setVisible(false);
  mixer.setVisible(false);
  mobileInput.setOverlayHidden(true);
  teamSave = loadTeamSave();
  teamExperience.setSavedStage(teamSave.stage, teamSave.completed);
  teamExperience.setSavedDrivers(teamSave.leftDriverId, teamSave.rightDriverId);
  teamExperience.showMode();
  audio.setScene('ready');
}

function startTeamExpedition(selection: TeamSelection): void {
  activeTeamSelection = selection;
  appMode = 'team-play';
  teamSave = {
    ...teamSave,
    stage: selection.resumeStage === 0 ? 1 : Math.max(1, teamSave.stage),
    completed: selection.resumeStage === 0 ? false : teamSave.completed,
    leftDriverId: selection.left.profile.id,
    rightDriverId: selection.right.profile.id,
  };
  saveTeamProgress(teamSave);
  teamExperience.setSavedStage(teamSave.stage, teamSave.completed);
  resetRace();
  const profiles = [selection.left.profile, selection.right.profile] as const;
  for (let id = 0; id < 2; id++) {
    const profile = profiles[id];
    boats[id].setDriver(profile.color, profile.handling);
    riders[id].setColor(profile.color, profile.look);
  }
  driverSelect.hide();
  openingShowcase.stop();
  hud.setVisible(false);
  tower.setVisible(false);
  mixer.setVisible(false);
  mobileInput.setOverlayHidden(true);
  collisions.setFriendlyPair(0, 1, true);
  teamPaused = false;
  localInput.reset();
  teamLeftCameraRig.mode = 'chase';
  teamRightCameraRig.mode = 'chase';
  teamExpedition.start({
    resumeStage: selection.resumeStage,
    leftDeviceId: selection.left.deviceId,
    rightDeviceId: selection.right.deviceId,
  });
  teamExperience.showGameplay();
  const snapshot = teamExpedition.snapshot();
  teamExperience.showTransition(
    'TEAM EXPEDITION',
    `协作站 ${snapshot.stage}`,
    `${snapshot.leaderSide === 'left' ? '左侧' : '右侧'}领航 · 另一侧翼手`,
    3.2,
  );
  audio.startRaceScore(true);
  audio.setScene('countdown');
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
  } else if (event.type === 'anchor') {
    audio.driftReleaseReady();
    if (event.side) audio.teamSpatialCue(event.side, 'anchor');
    if (device) localInput.rumble(device, 0.18, 0.45, 48);
  } else if (event.type === 'link-ready') {
    audio.flightReady(1);
    if (event.side) audio.teamSpatialCue(event.side, 'ready');
    teamLeftPipeline.pulse('ready', 0.72);
    teamRightPipeline.pulse('ready', 0.72);
    if (device) localInput.rumble(device, 0.35, 0.82, 70);
  } else if (event.type === 'relay') {
    audio.routeClear(Math.min(3, ((event.stage - 1) % 3) + 1));
    if (event.side) audio.teamSpatialCue(event.side, 'relay');
    teamLeftPipeline.pulse('gate', 0.45);
    teamRightPipeline.pulse('gate', 0.45);
  } else if (event.type === 'gate') {
    audio.flightGate(Math.min(3, ((event.stage - 1) % 3) + 1));
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
      teamExperience.showTransition('TEAM RESET', '共同检查点', '两名队员同时失误，回到本协作站起点', 1.15);
    } else if (device) localInput.rumble(device, 0.65, 0.24, 72);
  } else if (event.type === 'stage') {
    teamSave = {
      ...teamSave,
      stage: Math.max(teamSave.stage, event.value ?? event.stage),
      completed: false,
      leftDriverId: activeTeamSelection.left.profile.id,
      rightDriverId: activeTeamSelection.right.profile.id,
    };
    saveTeamProgress(teamSave);
    teamExperience.setSavedStage(teamSave.stage, teamSave.completed);
    teamExperience.showTransition(
      `STAGE ${event.stage} CLEAR`,
      '职责交换',
      '左右画面保持不变 · 领航员与翼手互换',
      1.45,
    );
  } else if (event.type === 'finish') {
    const elapsed = event.value ?? teamExpedition.snapshot().elapsed;
    const elapsedMs = Math.round(elapsed * 1000);
    const fullRun = teamExpedition.snapshot().fullRun;
    if (fullRun && (teamSave.bestMs === null || elapsedMs < teamSave.bestMs)) teamSave.bestMs = elapsedMs;
    teamSave.stage = 7;
    teamSave.completed = true;
    teamSave.leftDriverId = activeTeamSelection.left.profile.id;
    teamSave.rightDriverId = activeTeamSelection.right.profile.id;
    saveTeamProgress(teamSave);
    teamExperience.setSavedStage(teamSave.stage, teamSave.completed);
    teamExperience.showTransition(
      'EXPEDITION COMPLETE',
      '远征完成',
      `${formatTeamTime(elapsed)}${fullRun && teamSave.bestMs === elapsedMs ? ' · NEW BEST' : ''}`,
      0,
      true,
    );
    audio.finishSting();
    audio.setScene('medal');
    teamLeftPipeline.pulse('finish', 1.2);
    teamRightPipeline.pulse('finish', 1.2);
  }
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
    if (retryLessonElapsed >= retryLessonMinRead) resetRace();
    return;
  }
  if (race.phase === 'finished') resetRace();
}

function resumeInterruption(): void {
  if (!interruptionActive || document.hidden) return;
  interruptionActive = false;
  stopInterruptionPadPoll();
  input.reset();
  gamepadInput.reset();
  haptics.stop();
  mobileInput.reset();
  hud.hideInterruption();
  if (interruptionNeedsCountdown && race.restartAfterInterruption()) {
    audio.startRaceScore(false);
    audio.setScene('countdown');
  } else {
    audio.resume();
  }
  interruptionNeedsCountdown = false;
  if (!HARNESS) loop.start();
}

function startFreshCountdown(): void {
  if (!race.startCountdown()) return;
  freshStartPending = false;
  openingShowcase.stop();
  seaDecor.setOpening(false);
  ocean.setOpeningIntensity(0);
  sky.setOpeningIntensity(0);
  driverSelect.setLaunchPending(false);
  immersive.setPhase('active');
  const coach = drivingCoach.progress;
  pcControlPrimer.arm(
    !mobileInput.enabled && activeInputDevice === 'keyboard' && records.data.bestFlights < 1 &&
      !coach.knowledge.bankRule,
    boats[0].state,
  );
  pcPrimerPresentation = null;
  hud.beginFreshRunGuidance();
  hud.showPcControlPrimer(null, false, pcControlPrimer.active);
  currentRun = records.beginRun();
  rivalDirector.beginRun(currentRun);
  tower.resetRun(currentRun);
  input.reset();
  gamepadInput.reset();
  mobileInput.reset();
  mobileInput.setGoPrompt(false);
  hud.hideReady();
  driverSelect.hide();
  mixer.setVisible(false);
  audio.startRaceScore(true);
  audio.setScene('countdown');
  drivingCoach.resetRun(boats[0].state);
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

function continueAfterFinale(): void {
  if (!finalePresentation || finaleElapsed < FINALE_MIN_READ_S || expansionGallery.visible()) return;
  if (!race.startFinalContinueCountdown()) return;
  finalePresentation = false;
  finaleElapsed = 0;
  resultsShown = false;
  course.resetFinalStation();
  finale.hide();
  input.clearTransient();
  gamepadInput.clearTransient();
  mobileInput.reset();
  mobileInput.setOverlayHidden(false);
  mobileInput.setControlPhase('preparing');
  cameraRig.mode = 'chase';
  audio.startRaceScore(false);
  audio.setScene('countdown');
  trackGameEvent('continue_game', { run: currentRun, flights: boats[0].state.flightsCleared });
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

function startRetryLesson(): void {
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
  retryLessonMinRead = 0;
  retryLessonTimer = retryLessonDuration;
  retryLessonElapsed = 0;
  retryLessonActive = true;
  retryLessonFrozenT = worldTime;
  input.reset();
  gamepadInput.reset();
  mobileInput.reset();
  audio.retryLesson();
  audio.setScene('lesson');
  mixer.setVisible(true);
  hud.showRetryLesson(
    result, currentRun, repeatCount, pendingFailureNewBest, activeInputDevice, coachArmed, drivingCoach.progress.mastery,
  );
  syncDrivingCoachUi();
  coachPresentation = null;
  hud.showCoach(null);
  pcControlPrimer.stop();
  pcPrimerPresentation = null;
  hud.showPcControlPrimer(null);
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
  const frozen = boats[0].state;
  audio.setEngine(0, 0, false);
  audio.setWaterRush(0);
  audio.setAirborne(false);
  audio.setFlight(0, false);
  audio.setDrift(0);
  if (finalPresentation) {
    if (finaleElapsed >= FINALE_CAMERA_HERO_S && cameraRig.mode !== 'results') cameraRig.mode = 'results';
    cameraRig.update(dt, boats[0], presentationTime);
    applyHarnessCameraOverride();
    ocean.update(presentationTime, stage.camera.position);
    sky.update(presentationTime, stage.camera.position);
    seaDecor.update(presentationTime, stage.camera.position);
    course.update(dt, presentationTime);
    // The race step returns early here, so without this the riders freeze in
    // their driving pose: rivals who crossed earlier were seen celebrating,
    // but the player's own rider never pumped a fist. Keep the celebration
    // alive through the finale presentation.
    for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, presentationTime, race.racers[i].finished);
  }
  pipeline.update(dt, finalPresentation ? presentationTime : retryLessonFrozenT, frozen, phase);
  hud.update(dt, race, boats[0], boats);
  audio.update(dt);
}

function resetRace(): void {
  harnessCameraOverride = null;
  freshStartPending = false;
  openingShowcase.stop();
  seaDecor.setOpening(false);
  ocean.setOpeningIntensity(0);
  sky.setOpeningIntensity(0);
  driverSelect.setLaunchPending(false);
  retryLessonActive = false;
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
  finaleCapture = null;
  finaleCaptureRecorded = false;
  finaleCapturePending = false;
  course.resetFlightChallenge();
  collisions.reset();
  spray.clear();
  feathers.clear();
  input.reset();
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
    const s = GRID_SLOTS[i];
    boats[i].object.visible = true;
    boats[i].teleport(s.x, s.z, s.heading);
    wakes[i].clear();
  }
  race.reset();
  currentRun = records.data.runs + 1;
  tower.resetRun(currentRun);
  prevFlightCharges = boats[0].state.flightCharges;
  prevDriftReleaseReady = boats[0].state.driftReleaseReady;
  prevFlightGateProgress = boats[0].state.flightGateProgress;
  prevFlightRouteState = boats[0].state.flightRouteState;
  prevFlightPhase = boats[0].state.flightPhase;
  prevBoosting = boats[0].state.boosting;
  prevAirBraking = false;
  prevDrifting = boats[0].state.drifting;
  prevTurnWarning = false;
  drivingCoach.resetRun(boats[0].state);
  harnessCheckpointEvents = 0;
  harnessCollisionFxBursts = 0;
  harnessRoutePilotIndex = -1;
  for (let i = 0; i < boats.length; i++) {
    harnessRoutePasses[i] = 0;
    harnessRouteFails[i] = 0;
    harnessPrevRouteStates[i] = boats[i].state.flightRouteState;
    routeLifecycleStates[i] = boats[i].state.flightRouteState;
    ais[i].reset();
  }
  cameraRig.mode = 'orbit';
  if (DESKTOP_DRIVER_STAGE.matches) cameraRig.snapOrbit(boats[0], presentationTime);
  hud.hideReady();
  const showIndependentFrontDoor = appMode === 'independent' || mobileInput.enabled || HARNESS;
  if (showIndependentFrontDoor) {
    driverSelect.show();
    hud.setVisible(true);
    tower.setVisible(true);
  } else {
    driverSelect.hide();
    hud.setVisible(false);
    tower.setVisible(false);
  }
  syncDrivingCoachUi();
  mobileInput.setGoPrompt(false);
  mixer.setVisible(showIndependentFrontDoor && !mobileInput.enabled);
  mixer.sync();
  audio.setScene('ready');
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

function updateFrontDoor(dt: number, t: number): void {
  presentationTime += dt;
  cameraRig.update(dt, boats[0], presentationTime);
  applyHarnessCameraOverride();
  ocean.update(presentationTime, stage.camera.position);
  sky.update(presentationTime, stage.camera.position);
  seaDecor.update(presentationTime, stage.camera.position);
  for (const boat of boats) boat.syncSurfacePresentation(presentationTime);
  for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, presentationTime, false);
  openingShowcase.update(dt);
  course.update(0, presentationTime);
  teamExperience.update(dt, localInput);
  pipeline.update(dt, t, boats[0].state, 'ready');
  audio.setEngine(0, 0, false);
  audio.update(dt);
}

function updateTeamSession(dt: number, t: number): void {
  const leftDevice = teamExpedition.deviceFor('left');
  const rightDevice = teamExpedition.deviceFor('right');
  if (teamExpedition.snapshot().phase === 'finished') {
    let exit = false;
    for (const id of [leftDevice, rightDevice]) {
      exit ||= localInput.confirmEdge(id) || localInput.cancelEdge(id);
    }
    if (exit) {
      enterFrontDoor();
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
    teamExperience.showTransition('TEAM PAUSE', '远征暂停', '按任一设备确认继续 · 返回键退出', 0, true);
    updateTeamPresentation(0, t);
    localInput.endFrame();
    return;
  }

  const leftState = boats[0].state;
  const rightState = boats[1].state;
  const leftInput = localInput.readBoat(leftDevice, dt, leftState.flightPhase !== 'surface');
  const rightInput = localInput.readBoat(rightDevice, dt, rightState.flightPhase !== 'surface');
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
    riders[i].update(dt, boats[i].state, t, false);
    wakes[i].update(dt, t);
  }
  spray.update(dt, t);
  feathers.update(dt, t);
  jetTrail.update(dt);
  course.update(dt, t);
  const snapshot = teamExpedition.snapshot();
  if (activeTeamSelection) {
    teamExperience.updateHud({
      stage: snapshot.stage,
      totalStages: snapshot.totalStages,
      elapsed: snapshot.elapsed,
      objective: snapshot.objective,
      left: teamHudSeat(
        activeTeamSelection.left.profile,
        boats[0],
        teamExpedition.roleFor('left'),
        snapshot,
        !localInput.connected(teamExpedition.deviceFor('left')),
      ),
      right: teamHudSeat(
        activeTeamSelection.right.profile,
        boats[1],
        teamExpedition.roleFor('right'),
        snapshot,
        !localInput.connected(teamExpedition.deviceFor('right')),
      ),
    });
  }
  const left = boats[0].state;
  const right = boats[1].state;
  const averageSpeed = (Math.abs(left.speed) + Math.abs(right.speed)) * 0.5;
  const activeState = snapshot.wingSide === 'left' ? left : right;
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
    activeState.flightRouteIndex >= 0 ? activeState.flightRouteIndex : snapshot.stage - 1,
  );
  audio.setDrift(left.drifting || right.drifting ? 0.62 : 0);
  audio.update(dt);
  teamLeftPipeline.update(dt, t, left, snapshot.phase === 'countdown' ? 'countdown' : 'racing');
  teamRightPipeline.update(dt, t, right, snapshot.phase === 'countdown' ? 'countdown' : 'racing');
}

function teamHudSeat(
  profile: ReturnType<typeof driverProfile>,
  boat: Boat,
  role: 'leader' | 'wing',
  snapshot: ReturnType<TeamExpedition['snapshot']>,
  disconnected: boolean,
): {
  profile: ReturnType<typeof driverProfile>;
  role: 'leader' | 'wing';
  speedKmh: number;
  link: number;
  relays: number;
  relayTotal: number;
  status: string;
  disconnected: boolean;
} {
  return {
    profile,
    role,
    speedKmh: Math.abs(boat.state.speed) * 3.6,
    link: snapshot.link,
    relays: snapshot.anchors,
    relayTotal: snapshot.anchorTotal,
    status: role === 'leader'
      ? snapshot.relayOpen ? '中继已开启 · 掩护翼手' : snapshot.objective
      : snapshot.wingCleared ? '飞行门通过 · 前往会合' : snapshot.objective,
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
  localInput.poll();
  if (appMode === 'front-door') {
    immersive.update(dt);
    updateFrontDoor(dt, worldTime);
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
  if (interruptionActive) {
    if (gamepadInput.consumeConfirm()) resumeInterruption();
    return;
  }
  if (mobileInput.enabled && !mobileInput.isLandscape) {
    input.reset();
    gamepadInput.reset();
    mobileInput.reset();
    mobileInput.setControlPhase('inactive');
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
  const coachDismissed = input.consumePress('Escape') || gamepadInput.consumeDismiss();

  if (capturePreview.visible()) {
    if (coachDismissed) capturePreview.hide();
    input.clearTransient();
    gamepadInput.clearTransient();
    mobileInput.consumeAnyPress();
    return;
  }

  if (coachDismissed && pcControlPrimer.active && pcPrimerPresentation) dismissPcControlPrimer();
  else if (coachDismissed && drivingCoach.progress.status === 'active') disableDrivingCoach();

  if (expansionGallery.visible()) {
    mobileInput.consumeAnyPress();
    const selectLeft = gamepadInput.consumeSelectLeft();
    const selectRight = gamepadInput.consumeSelectRight();
    const dismiss = gamepadInput.consumeDismiss();
    if (selectLeft) expansionGallery.move(-1);
    if (selectRight) expansionGallery.move(1);
    if (dismiss) expansionGallery.hide();
    updateFrozenPresentation(dt, race.phase === 'medal' ? 'medal' : 'finished', true);
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
    return;
  }

  if (retryLessonActive) {
    const lessonPressed = enterPressed || spaceConfirmPressed || retryPressed || gamepadConfirm;
    mobileInput.consumeAnyPress();
    retryLessonTimer = Math.max(0, retryLessonTimer - dt);
    retryLessonElapsed += dt;
    const canContinue = true;
    hud.updateRetryLesson(retryLessonDuration > 0 ? retryLessonElapsed / retryLessonDuration : 1, canContinue);
    updateFrozenPresentation(dt);
    if (retryLessonTimer <= 0 || (lessonPressed && canContinue)) resetRace();
    return;
  }

  if (defeatFreezeTimer > 0) {
    mobileInput.consumeAnyPress();
    defeatFreezeTimer = Math.max(0, defeatFreezeTimer - dt);
    updateFrozenPresentation(dt);
    if (defeatFreezeTimer <= 0) startRetryLesson();
    return;
  }

  if (finalePresentation) {
    mobileInput.consumeAnyPress();
    finaleElapsed += dt;
    const canContinue = finaleElapsed >= FINALE_MIN_READ_S;
    finale.update(finaleElapsed, FINALE_REVEAL_S, canContinue);
    updateFrozenPresentation(dt, 'finished', true);
    if (!expansionGallery.visible() && canContinue) {
      const focusLeft = input.consumePress('ArrowLeft') || input.consumePress('ArrowUp') || gamepadInput.consumeSelectLeft();
      const focusRight = input.consumePress('ArrowRight') || input.consumePress('ArrowDown') || gamepadInput.consumeSelectRight();
      if (focusLeft) finale.moveFocus(-1);
      if (focusRight) finale.moveFocus(1);
      if (enterPressed || spaceConfirmPressed || gamepadConfirm) finale.activateFocused();
    }
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
    if (!frozenDesktopReady) cameraRig.update(dt, boats[0], presentationTime);
    applyHarnessCameraOverride();
    const readySceneTime = openingShowcase.active ? presentationTime : worldTime;
    ocean.update(readySceneTime, stage.camera.position);
    sky.update(readySceneTime, stage.camera.position);
    seaDecor.update(readySceneTime, stage.camera.position);
    for (const boat of boats) boat.syncSurfacePresentation(readySceneTime);
    for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, readySceneTime, false);
    openingShowcase.update(dt);
    course.update(0, readySceneTime);
    tower.update(dt, race);
    hud.update(dt, race, boats[0], boats);
    pipeline.update(dt, worldTime, boats[0].state, 'ready');
    audio.update(dt);
    if (enterPressed || spaceConfirmPressed || mobileGo || gamepadConfirm) queueFreshStart();
    if (freshStartPending && openingShowcase.finished && immersive.goStartReady()) startFreshCountdown();
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
      cameraRig.update(dt, boats[0], presentationTime);
      applyHarnessCameraOverride();
      ocean.update(worldTime, stage.camera.position);
      sky.update(worldTime, stage.camera.position);
      seaDecor.update(worldTime, stage.camera.position);
      for (const boat of boats) boat.syncSurfacePresentation(worldTime);
      for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, worldTime, false);
      course.update(0, worldTime);
    }
    tower.update(dt, race);
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
    return;
  }

  const waitingForMobile = mobileInput.enabled && !mobileInput.ready && !gamepadInput.connected && !HARNESS;
  const racing = race.phase === 'racing' && !waitingForMobile;
  mobileInput.setControlPhase(racing && (!HARNESS || params.has('mobile')) ? 'racing' : 'inactive');

  // Inputs: player keyboard (or AI autopilot in harness), AI for the rest.
  const flightActive = boats[0].state.flightPhase !== 'surface';
  let playerInput = ZERO_INPUT;
  if (racing) {
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
  if (!retryLessonActive) mobileInput.consumeAnyPress();
  if (!racing) input.consumePress('Space'); // never buffer a flight press through the countdown
  worldTime += dt;
  rivalDirector.update(dt, race.racers, boats[0].state.flightsCleared);
  if (racing) collisions.capture(boats);
  for (let i = 0; i < boats.length && racing; i++) {
    if (i > 0) boats[i].setOpponentEffectDistance(boats[i].state.position.distanceTo(boats[0].state.position));
    const rivalControl = rivalDirector.controlFor(i);
    let inp: BoatInput;
    if (!racing) {
      inp = ZERO_INPUT;
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
        race.racers[0].progress,
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
    const finalReturnBrake = i === 0 && course.finalStationArmed();
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

  if (racing) course.updateFlightRoute(dt, boats);

  let playerPassedFlight = false;
  if (racing) {
    for (let i = 0; i < boats.length; i++) {
      const state = boats[i].state;
      const routeState = state.flightRouteState;
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
      if (routeState === routeLifecycleStates[i]) continue;
      routeLifecycleStates[i] = routeState;
      if (routeState === 'failed') {
        if (i === 0 && !(HARNESS && harnessKeepFlightMissRunning)) {
          if (state.flightFailure) race.defeatFlight(state.flightFailure);
        }
      } else if (routeState === 'passed') {
        if (i === 0) playerPassedFlight = true;
      }
    }
  }
  if (!waitingForMobile && race.phase === 'racing') race.update(dt);
  if (racing && race.phase === 'racing') {
    const hits = collisions.resolve(boats);
    const collisionDebug = collisions.debugState();
    // Preserve route-projection continuity on untouched frames. Re-basing
    // every frame lets a continuous cross-course shortcut become the new
    // legal segment; only an actual contact correction needs absorption.
    if (collisionDebug.maxCorrection > 0) {
      course.syncFlightTrackingAfterCollisions(boats);
      race.syncCollisionCorrections();
    }
    presentPlayerCollisions(hits);
    presentBuoyHits(course.applyBuoyHits(boats, buoyHitScratch));
    presentBalloonPops(course.consumeBalloonPops(balloonPopScratch));
  }
  let enteredMedal = false;
  if (playerPassedFlight && race.phase === 'racing') {
    const flights = boats[0].state.flightsCleared;
    if (flights >= 4) rivalDirector.releaseFormation();
    const pass = records.recordFlightPass(flights, selectedDriverId);
    newBestThisRun ||= pass.newBest;
    hud.showFlightPass(flights, pass.bestFlights, pass.newBest);
    tower.announceFlight(flights, pass.bestFlights);
    if (flights === 3 && race.challengeTier === 'unqualified') {
      drivingCoach.markExpert();
      syncDrivingCoachUi();
      const tier = race.qualifyChallenge();
      const qualification = records.qualifyRun(race.raceTime);
      medalEarnedThisRun = true;
      ordinaryNewThisRun = qualification.ordinaryNew;
      if (tier !== 'unqualified') {
        startMedalCeremony(tier, qualification.manMedalsTotal, pass.bestFlights);
        enteredMedal = true;
      }
    } else if (!harnessEndlessMode && flights > 0 && flights % course.flightRoutes.length === 0 && race.armFinale()) {
      course.armFinalStation();
      hud.showFinalReady();
      tower.announceFlight(flights, pass.bestFlights);
      pipeline.pulse('finish', 0.55);
      trackGameEvent('final_station_armed', { run: currentRun, flights, elapsed: race.raceTime });
    }
  }
  if (race.challengeTier === 'excellent' && !excellentRecordedThisRun) {
    const excellent = records.recordExcellent(race.raceTime);
    excellentRecordedThisRun = true;
    if (previousChallengeTier === 'ordinary') hud.showExcellentLocked(excellent.excellentTotal);
  }
  previousChallengeTier = race.challengeTier;

  const playerState = boats[0].state;
  if (playerState.drifting && !prevDrifting && playerState.speed > 12) haptics.cue('drift-active');
  if (playerState.driftReleaseReady && !prevDriftReleaseReady) {
    audio.driftReleaseReady();
    haptics.cue('drift-ready');
  }
  if (playerState.flightCharges > prevFlightCharges) {
    audio.flightReady(playerState.flightCharges);
    cameraRig.flightReadyKick();
    pipeline.pulse('ready');
    const stockIntensity = 0.82 + 0.18 * Math.max(0, playerState.flightCharges - 1) /
      Math.max(1, MAX_FLIGHT_CHARGES - 1);
    haptics.cue('charge', stockIntensity);
  }
  if (playerState.flightExtended) {
    audio.flightExtend();
    cameraRig.flightExtendKick();
    pipeline.pulse('ready', 0.68);
    haptics.cue('extend');
  }
  if (playerState.boosting && !prevBoosting) {
    pipeline.pulse('boost', 0.92);
    haptics.cue('boost');
  }
  if (playerState.flightPhase === 'spool' && prevFlightPhase !== 'spool') {
    pipeline.pulse('launch', 1.05);
    haptics.cue('launch');
  }
  const airBraking = playerState.flightPhase !== 'surface' && playerState.flightAirBrake > 0.28;
  if (airBraking && !prevAirBraking) {
    audio.airBrakeSnap();
    haptics.cue('air-brake');
  }
  if (playerState.flightGateProgress > prevFlightGateProgress) {
    const flightNumber = Math.max(1, playerState.flightsCleared);
    const feedbackStep = Math.min(3, ((flightNumber - 1) % 3) + 1);
    audio.flightGate(feedbackStep);
    cameraRig.flightGateKick(feedbackStep);
    pipeline.pulse('gate', flightNumber === 3 ? 0.72 : 0.4);
    haptics.cue('gate');
  }
  if (playerState.flightRouteState !== prevFlightRouteState) {
    if (playerState.flightRouteState === 'passed') {
      audio.routeClear(Math.min(3, ((playerState.flightsCleared - 1) % 3) + 1));
    }
    else if (playerState.flightRouteState === 'failed') cameraRig.routeMissKick();
  }
  prevFlightCharges = playerState.flightCharges;
  prevDriftReleaseReady = playerState.driftReleaseReady;
  prevFlightGateProgress = playerState.flightGateProgress;
  prevFlightRouteState = playerState.flightRouteState;
  prevFlightPhase = playerState.flightPhase;
  prevBoosting = playerState.boosting;
  prevAirBraking = airBraking;
  prevDrifting = playerState.drifting;
  const turnWarning = course.flightTurnWarning(boats[0].id);
  if (turnWarning && !prevTurnWarning) haptics.cue('warning');
  prevTurnWarning = turnWarning;

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
    if (i === 0 && imp > 3) {
      haptics.impact('landing', Math.max(0.5, Math.min(1, imp / 14)), false);
    }
    if (imp > 7) {
      if (i === 0) {
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
  for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, worldTime, race.racers[i].finished);

  cameraRig.update(dt, boats[0], worldTime);
  applyHarnessCameraOverride();
  ocean.update(worldTime, stage.camera.position);
  sky.update(worldTime, stage.camera.position);
  seaDecor.update(worldTime, stage.camera.position);
  course.update(dt, worldTime);
  for (let i = 0; i < boats.length; i++) wakes[i].update(dt, worldTime);
  spray.update(dt, worldTime);
  feathers.update(dt, worldTime);
  jetTrail.update(dt);

  const ps = boats[0].state;
  tower.update(
    dt,
    race,
    ps.flightPhase !== 'surface',
    turnWarning || coachPresentation !== null || pcPrimerPresentation !== null || hud.flightPromptVisible() ||
      hud.coachPresentationBlocked(),
  );
  hud.update(dt, race, boats[0], boats);
  const routeGuidance = course.guidanceStatus();
  mobileInput.setActionState(
    deriveAbilityHudState(ps, course.finalStationArmed()),
    course.flightTurnWarning(boats[0].id),
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
  const corridorDanger = race.phase === 'racing' ? course.playerCorridorDanger : 0;
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
      cameraRig.finishKick();
      pipeline.pulse('finish', 1.35);
      if (race.challengeResult) {
        race.challengeResult.ordinaryNew = ordinaryNewThisRun;
        records.decorateResult(race.challengeResult, newBestThisRun, medalEarnedThisRun);
        records.recordFinale();
        course.triggerFinaleCelebration();
        finale.show(race.challengeResult);
        finaleElapsed = 0;
        finalePresentation = true;
        finaleCapture = null;
        finaleCaptureRecorded = false;
        finaleCapturePending = true;
        retryLessonFrozenT = worldTime;
        input.reset();
        gamepadInput.reset();
        mobileInput.reset();
        mobileInput.setOverlayHidden(true);
        mobileInput.setControlPhase('inactive');
        audio.setScene('medal');
        haptics.cue('medal');
        trackGameEvent('final_station_crossed', {
          run: currentRun, flights: race.challengeResult.flightsCleared, elapsed: race.challengeResult.raceTime,
        });
        trackGameEvent('finale_shown', { run: currentRun, place: race.challengeResult.place });
      }
    }
  }
  audio.update(dt);
}

const renderDrawingSize = new THREE.Vector2();

function render(frameMs: number): void {
  stage.renderer.info.reset(); // autoReset is off: gather whole-frame stats
  if (appMode === 'team-play') {
    renderTeamSplit();
  } else {
    applyHarnessCameraOverride();
    stage.renderer.getDrawingBufferSize(renderDrawingSize);
    ocean.uniforms.uDepthTex.value = prePass.depthTexture;
    ocean.setResolution(renderDrawingSize.x, renderDrawingSize.y, stage.camera.fov);
    pipeline.render();
    processCaptureQueue();
  }
  stage.updatePerf(frameMs);
}

function renderTeamSplit(): void {
  const drawing = stage.renderer.getDrawingBufferSize(renderDrawingSize);
  const halfWidth = Math.max(1, Math.floor(drawing.x / 2));

  ocean.uniforms.uDepthTex.value = teamLeftPrePass.depthTexture;
  ocean.setResolution(halfWidth, drawing.y, teamLeftCamera.fov);
  ocean.update(worldTime, teamLeftCamera.position);
  sky.update(worldTime, teamLeftCamera.position);
  seaDecor.update(worldTime, teamLeftCamera.position);
  const left = teamLeftPipeline.renderToTexture();

  ocean.uniforms.uDepthTex.value = teamRightPrePass.depthTexture;
  ocean.setResolution(halfWidth, drawing.y, teamRightCamera.fov);
  ocean.update(worldTime, teamRightCamera.position);
  sky.update(worldTime, teamRightCamera.position);
  seaDecor.update(worldTime, teamRightCamera.position);
  const right = teamRightPipeline.renderToTexture();

  splitScreen.render(left, right);
  ocean.uniforms.uDepthTex.value = prePass.depthTexture;
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
    gamepadInput.poll();
    if (gamepadInput.consumeConfirm()) {
      resumeInterruption();
      return;
    }
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
        teamExperience.showTransition('TEAM PAUSE', '远征暂停', '画面与计时已冻结 · 返回后按确认继续', 0, true);
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
  buoyState(): ReturnType<Course['buoyDebugStates']>;
  buoyCase(): Record<string, number | boolean>;
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
  teamAdvanceStage(): void;
  teamDisplace(side: SeatSide): void;
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
    if (hit.boatId === 0) {
      audio.collision(3.0);
      haptics.impact('collision-heavy', 0.5, false);
    }
  }
}

function presentBalloonPops(pops: readonly BalloonPop[]): void {
  for (const pop of pops) {
    balloonPopPoint.set(pop.x, pop.y, pop.z);
    feathers.burst(balloonPopPoint, 48, 9.5, pop.carryX, pop.carryZ);
    if (pop.boatId === 0) {
      audio.balloonPop();
      haptics.impact('collision-light', 0.3, false);
    }
  }
}

function presentPlayerCollisions(hits: readonly CollisionHit[]): void {
  const playerHits = hits.filter((hit) => (hit.a === 0 || hit.b === 0) && hit.strength >= 0.8);
  if (playerHits.length === 0) return;
  const hit = playerHits.reduce((best, candidate) => candidate.strength > best.strength ? candidate : best);
  const opponentId = hit.a === 0 ? hit.b : hit.a;
  const strength = hit.strength;
  const forceX = hit.a === 0 ? hit.nx : -hit.nx;
  const forceZ = hit.a === 0 ? hit.nz : -hit.nz;
  const playerHeading = boats[0].state.heading;
  const contactX = hit.x - boats[0].state.position.x;
  const contactZ = hit.z - boats[0].state.position.z;
  const contactDistance = Math.hypot(contactX, contactZ);
  // Prefer the actual hull contact point. The collision normal is a fallback
  // force pushing the player away, so its sign must be inverted. + is port.
  const rawSide = contactDistance > 0.15
    ? (contactX * Math.cos(playerHeading) - contactZ * Math.sin(playerHeading)) / contactDistance
    : -(forceX * Math.cos(playerHeading) - forceZ * Math.sin(playerHeading));
  const side = Math.max(-1, Math.min(1, rawSide));
  audio.collision(strength);
  cameraRig.collisionKick(strength, side);
  pipeline.pulse('collision', Math.min(1.1, 0.3 + strength / 20));
  if (boats[0].state.flightPhase === 'surface' && boats[opponentId]?.state.flightPhase === 'surface') {
    collisionFxPoint.set(hit.x, hit.y + 0.15, hit.z);
    spray.burst(collisionFxPoint, 4 + Math.min(8, Math.round(strength * 0.3)), 2.5 + Math.min(4, strength * 0.15));
    if (HARNESS) harnessCollisionFxBursts++;
  }
  haptics.impact(
    strength > 10 ? 'collision-heavy' : 'collision-light',
    Math.min(1, 0.45 + strength / 16),
    boats[0].state.drifting || boats[0].state.flightAirBrake > 0.28,
  );
  rivalDirector.notifyPlayerImpact();
  tower.announceCollision(roster[opponentId], strength, side);
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
  riders[0].update(1 / 60, boats[0].state, worldTime, false);
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
  const riderInspection = name === 'rider-inspection' || name.startsWith('rider-inspection-');
  const openingInspection = name === 'opening-showcase';
  if (name !== 'ready' && !riderInspection && !openingInspection) startFreshCountdown();

  switch (name) {
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
      seaDecor.setOpening(true);
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
    buoyState: () => course.buoyDebugStates(),
    buoyCase: runBuoyCase,
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
        leftCharges: boats[0].state.flightCharges,
        rightCharges: boats[1].state.flightCharges,
        leftRouteState: boats[0].state.flightRouteState,
        rightRouteState: boats[1].state.flightRouteState,
        progress: { leftU, rightU, leftDistance, rightDistance },
        visibleBoats: boats.filter((boat) => boat.object.visible).map((boat) => boat.id),
        guidance: course.guidanceStatus(),
      };
    },
    teamAdvanceStage: () => teamExpedition.debugAdvanceStage(),
    teamDisplace: (side) => {
      if (teamExpedition.snapshot().phase !== 'racing') return;
      const boat = boats[side === 'left' ? 0 : 1];
      const state = boat.state;
      boat.teleport(state.position.x + 180, state.position.z + 180, state.heading);
    },
  };
  (window as unknown as { __harness: Harness }).__harness = harness;
} else {
  loop.start();
}
