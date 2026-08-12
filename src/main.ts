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
import { Loop } from './core/loop';
import { Input } from './core/input';
import { MobileControls } from './core/mobileControls';
import { Ocean } from './water/ocean';
import { WakeRibbon } from './water/wake';
import { SpraySystem } from './water/spray';
import { Sky } from './cel/sky';
import { createPostPipeline } from './cel/postPipeline';
import { Boat } from './game/boat';
import { JetTrailSystem } from './game/jetTrail';
import { Rider } from './game/rider';
import { CHECKPOINT_US, Course, GRID_SLOTS } from './game/course';
import {
  buildRaceRoster,
  driverProfile,
  loadSelectedDriver,
  saveSelectedDriver,
} from './game/racers';
import { RecordsStore } from './game/records';
import { Race } from './game/race';
import { AIController } from './game/ai';
import { RivalDirector } from './game/rivalDirector';
import { BoatCollisionSystem } from './game/collision';
import { CameraRig } from './game/chaseCamera';
import { HUD } from './hud/hud';
import { GameAudio } from './audio/audio';
import { MixerControls } from './audio/mixerControls';
import { DriverSelect } from './hud/driverSelect';
import { RaceTower } from './hud/raceTower';
import type { BoatInput, ChallengeTier, FlightRouteState } from './contracts';

const params = new URLSearchParams(location.search);
const HARNESS = params.has('harness');

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
});
stage.scene.add(ocean.object);

const spray = new SpraySystem();
stage.scene.add(spray.object);

const jetTrail = new JetTrailSystem();
stage.scene.add(jetTrail.object);

const course = new Course();
stage.scene.add(course.object);
const records = new RecordsStore();
let selectedDriverId = loadSelectedDriver();
let roster = buildRaceRoster(selectedDriverId);

// Boats + riders + wakes. Boat 0 is the player.
const boats: Boat[] = [];
const riders: Rider[] = [];
const wakes: WakeRibbon[] = [];
for (const racer of roster) {
  const detailedInk = racer.id === 0 || stage.quality.detailedAiInk;
  const wake = new WakeRibbon();
  stage.scene.add(wake.object);
  wakes.push(wake);
  const boat = new Boat({ id: racer.id, color: racer.color, wake, spray, trail: jetTrail, detailedInk });
  stage.scene.add(boat.object);
  boats.push(boat);
  const rider = new Rider({ color: racer.color, detailedInk });
  boat.riderMount.add(rider.object);
  riders.push(rider);
}

const rivalDirector = new RivalDirector();
rivalDirector.setRoster(roster);
let ais = buildAiControllers();
const collisions = new BoatCollisionSystem();

const cameraRig = new CameraRig(stage.camera);
const audio = new GameAudio();
window.addEventListener('keydown', () => audio.resume());
window.addEventListener('pointerdown', () => audio.resume(), { passive: true });

const hudLayer = document.createElement('div');
hudLayer.id = 'hud-layer';
hudLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;';
app.appendChild(hudLayer);
const hud = new HUD(hudLayer, course, requestRetry, records.data.bestFlights, resumeInterruption);
const mixer = new MixerControls(app, audio);
const tower = new RaceTower(hudLayer);
tower.setRoster(roster);
const driverSelect = new DriverSelect(
  hudLayer,
  selectedDriverId,
  (profile) => applySelectedDriver(profile.id),
  requestFreshStart,
  exportSave,
  importSave,
);

const input = new Input();
const mobileInput = new MobileControls(app, () => audio.resume(), params.has('mobile'));
const haptic = (pattern: number | number[]): void => {
  if (mobileInput.enabled && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
};
const pipeline = createPostPipeline(stage.renderer, stage.scene, stage.camera, prePass, stage.quality);
stage.onResize((w, h, pr) => {
  pipeline.setSize(w, h, pr);
  prePass.setSize(w * pr, h * pr);
  ocean.setResolution(w * pr, h * pr);
});

// -------------------------------------------------------------- race events
let resultsShown = false;
const DEFEAT_FREEZE_S = 0.35;
const MEDAL_CEREMONY_S = 4.5;
const MEDAL_MIN_READ_S = MEDAL_CEREMONY_S;
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
let medalElapsed = 0;
let interruptionActive = false;
let pageWasHidden = false;
let interruptionNeedsCountdown = false;
const retryReasonCounts = new Map<string, number>();
let prevFlightReady = false;
let prevFlightGateProgress = 0;
let prevFlightRouteState = boats[0].state.flightRouteState;
let prevFlightPhase = boats[0].state.flightPhase;
let prevBoosting = false;
let prevAirBraking = false;
let harnessBattleEvents = 0;
let harnessOvertakes = 0;
let harnessPositionLosses = 0;
let harnessLastBattleKind = 'none';
let harnessLastBattleCount = 0;
let harnessLastBattleStreak = 0;
let harnessCheckpointEvents = 0;
const harnessRoutePasses = new Array<number>(boats.length).fill(0);
const harnessRouteFails = new Array<number>(boats.length).fill(0);
const harnessPrevRouteStates: FlightRouteState[] = boats.map((boat) => boat.state.flightRouteState);
const routeLifecycleStates: FlightRouteState[] = boats.map((boat) => boat.state.flightRouteState);

const race = new Race(course, boats, {
  countdownTick: (n) => {
    audio.countdownStage(n);
    audio.countdownBeep(false);
  },
  go: (_resuming) => {
    audio.setScene('racing');
    audio.countdownBeep(true);
    audio.horn();
    cameraRig.mode = 'chase';
    tower.announceGo(roster[0].name);
  },
  lapDone: () => {},
  checkpoint: () => {
    if (HARNESS) harnessCheckpointEvents++;
  },
  finish: (r) => {
    if (r.isPlayer && race.challengeResult?.outcome === 'excellent') audio.finishSting();
  },
  wrongWay: () => {},
  battle: (event) => {
    if (HARNESS) {
      harnessBattleEvents++;
      harnessLastBattleKind = event.kind;
      harnessLastBattleCount = event.opponents.length;
      harnessLastBattleStreak = event.streak;
      if (event.kind === 'overtake') harnessOvertakes += event.opponents.length;
      else harnessPositionLosses += event.opponents.length;
    }
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
    riders[definition.id].setColor(definition.color);
  }
  ais = buildAiControllers();
  race.setDefinitions(roster);
  tower.setRoster(roster);
  resetRace();
}

function requestFreshStart(): void {
  if (mobileInput.enabled) mobileInput.requestGo();
  else startFreshCountdown();
}

function exportSave(): void {
  const blob = new Blob([records.exportJson(selectedDriverId)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `board-race-save-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

function importSave(raw: string): void {
  try {
    const imported = records.importJson(raw);
    if (imported.selectedDriverId) saveSelectedDriver(imported.selectedDriverId);
    location.reload();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '存档导入失败');
  }
}

function requestRetry(): void {
  if (race.phase === 'medal') {
    if (medalElapsed >= MEDAL_MIN_READ_S) startResumeCountdown();
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
  input.reset();
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
  currentRun = records.beginRun();
  input.reset();
  mobileInput.reset();
  mobileInput.setGoPrompt(false);
  hud.hideReady();
  driverSelect.hide();
  mixer.setVisible(false);
  audio.startRaceScore(true);
  audio.setScene('countdown');
}

function startResumeCountdown(): void {
  if (!race.startResumeCountdown()) return;
  input.reset();
  mobileInput.reset();
  hud.hideMedalCeremony();
  audio.startRaceScore(false);
  audio.setScene('countdown');
}

function startMedalCeremony(tier: Exclude<ChallengeTier, 'unqualified'>, medals: number, best: number): void {
  if (!race.beginMedalCeremony()) return;
  medalElapsed = 0;
  retryLessonFrozenT = worldTime;
  input.reset();
  mobileInput.reset();
  mobileInput.setRacing(false);
  hud.showQualification(tier, medals, best);
  hud.updateMedalCeremony(0, MEDAL_CEREMONY_S, false);
  audio.setScene('medal');
  audio.playMedalCeremony();
}

function startRetryLesson(): void {
  const result = race.challengeResult;
  if (!result?.failure) return;
  const failure = result.failure;
  const reason = failure?.reason ?? result.reason;
  const key = `${failure?.routeSlot ?? 0}:${reason}`;
  const repeatCount = (retryReasonCounts.get(key) ?? 0) + 1;
  retryReasonCounts.set(key, repeatCount);
  const baseDuration = repeatCount === 1 ? 8 : repeatCount === 2 ? 6.5 : 5;
  retryLessonDuration = Math.min(9, baseDuration + (pendingFailureNewBest ? 0.75 : 0));
  if (result.manMedalEarned) retryLessonDuration = Math.max(8, retryLessonDuration);
  retryLessonMinRead = repeatCount === 1 ? 4 : repeatCount === 2 ? 3 : 2.5;
  retryLessonTimer = retryLessonDuration;
  retryLessonElapsed = 0;
  retryLessonActive = true;
  retryLessonFrozenT = worldTime;
  input.reset();
  mobileInput.reset();
  audio.retryLesson();
  audio.setScene('lesson');
  mixer.setVisible(true);
  hud.showRetryLesson(result, currentRun, repeatCount, pendingFailureNewBest, mobileInput.enabled);
}

function updateFrozenPresentation(dt: number, phase = race.phase): void {
  const frozen = boats[0].state;
  audio.setEngine(0, 0, false);
  audio.setWaterRush(0);
  audio.setAirborne(false);
  audio.setFlight(0, false);
  audio.setDrift(0);
  pipeline.update(dt, retryLessonFrozenT, frozen, phase);
  hud.update(dt, race, boats[0], boats);
  audio.update(dt);
}

function resetRace(): void {
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
  course.resetFlightChallenge();
  collisions.reset();
  input.reset();
  mobileInput.reset();
  resultsShown = false;
  hud.hideResults();
  hud.hideRetryLesson();
  hud.hideMedalCeremony();
  for (let i = 0; i < boats.length; i++) {
    const s = GRID_SLOTS[i];
    boats[i].teleport(s.x, s.z, s.heading);
    wakes[i].clear();
  }
  race.reset();
  currentRun = records.data.runs + 1;
  prevFlightReady = boats[0].state.flightReady;
  prevFlightGateProgress = boats[0].state.flightGateProgress;
  prevFlightRouteState = boats[0].state.flightRouteState;
  prevFlightPhase = boats[0].state.flightPhase;
  prevBoosting = boats[0].state.boosting;
  prevAirBraking = false;
  harnessBattleEvents = 0;
  harnessOvertakes = 0;
  harnessPositionLosses = 0;
  harnessLastBattleKind = 'none';
  harnessLastBattleCount = 0;
  harnessLastBattleStreak = 0;
  harnessCheckpointEvents = 0;
  for (let i = 0; i < boats.length; i++) {
    harnessRoutePasses[i] = 0;
    harnessRouteFails[i] = 0;
    harnessPrevRouteStates[i] = boats[i].state.flightRouteState;
    routeLifecycleStates[i] = boats[i].state.flightRouteState;
    ais[i].reset();
  }
  cameraRig.mode = 'orbit';
  hud.hideReady();
  driverSelect.show();
  mobileInput.setGoPrompt(false);
  mixer.setVisible(true);
  mixer.sync();
  audio.setScene('ready');
}

resetRace();

// ------------------------------------------------------------------- step
const ZERO_INPUT: BoatInput = {
  throttle: 0,
  steer: 0,
  drift: false,
  flightTrigger: false,
  airBrake: false,
};
let harnessPlayerInput: BoatInput | null = null;

function step(dt: number, _t: number): void {
  if (interruptionActive) return;
  if (mobileInput.enabled && !mobileInput.isLandscape) {
    input.reset();
    mobileInput.reset();
    mobileInput.setRacing(false);
    return;
  }
  presentationTime += dt;
  // Consume retry edges in every phase. Otherwise a key pressed during the
  // race remains queued and can erase the defeat screen on the failure frame.
  const enterPressed = input.consumePress('Enter');
  const retryPressed = input.consumePress('KeyR');

  if (race.phase === 'medal') {
    input.consumePress('Space');
    mobileInput.consumeAnyPress();
    medalElapsed += dt;
    const canContinue = medalElapsed >= MEDAL_MIN_READ_S;
    hud.updateMedalCeremony(medalElapsed, MEDAL_CEREMONY_S, canContinue);
    updateFrozenPresentation(dt, 'medal');
    if (medalElapsed >= MEDAL_CEREMONY_S || (enterPressed && canContinue)) startResumeCountdown();
    return;
  }

  if (retryLessonActive) {
    const lessonPressed = enterPressed || retryPressed;
    input.consumePress('Space');
    mobileInput.consumeAnyPress();
    retryLessonTimer = Math.max(0, retryLessonTimer - dt);
    retryLessonElapsed += dt;
    const canContinue = retryLessonElapsed >= retryLessonMinRead;
    hud.updateRetryLesson(retryLessonDuration > 0 ? retryLessonElapsed / retryLessonDuration : 1, canContinue);
    updateFrozenPresentation(dt);
    if (retryLessonTimer <= 0 || (lessonPressed && canContinue)) resetRace();
    return;
  }

  if (defeatFreezeTimer > 0) {
    input.consumePress('Space');
    mobileInput.consumeAnyPress();
    defeatFreezeTimer = Math.max(0, defeatFreezeTimer - dt);
    updateFrozenPresentation(dt);
    if (defeatFreezeTimer <= 0) startRetryLesson();
    return;
  }

  if ((enterPressed || retryPressed) && race.phase === 'finished') requestRetry();

  if (race.phase === 'ready') {
    input.consumePress('Space');
    const mobileGo = mobileInput.consumeGoRequest();
    const selectLeft = input.consumePress('ArrowLeft') || input.consumePress('KeyA');
    const selectRight = input.consumePress('ArrowRight') || input.consumePress('KeyD');
    if (selectLeft) driverSelect.move(-1);
    if (selectRight) driverSelect.move(1);
    mobileInput.consumeAnyPress();
    mobileInput.setRacing(false);
    cameraRig.update(dt, boats[0], presentationTime);
    ocean.update(worldTime, stage.camera.position);
    sky.update(worldTime, stage.camera.position);
    course.update(0, worldTime);
    hud.update(dt, race, boats[0], boats);
    tower.update(dt, race);
    pipeline.update(dt, worldTime, boats[0].state, 'ready');
    audio.update(dt);
    if (enterPressed || mobileGo) startFreshCountdown();
    return;
  }

  if (race.phase === 'countdown' || race.phase === 'resume-countdown') {
    const resuming = race.phase === 'resume-countdown';
    input.consumePress('Space');
    mobileInput.consumeAnyPress();
    mobileInput.setRacing(false);
    race.update(dt);
    if (!resuming) {
      worldTime += dt;
      cameraRig.update(dt, boats[0], presentationTime);
      ocean.update(worldTime, stage.camera.position);
      sky.update(worldTime, stage.camera.position);
      course.update(0, worldTime);
    }
    hud.update(dt, race, boats[0], boats);
    tower.update(dt, race);
    pipeline.update(dt, worldTime, boats[0].state, race.phase);
    audio.update(dt);
    return;
  }

  const waitingForMobile = mobileInput.enabled && !mobileInput.ready && !HARNESS;
  const racing = race.phase === 'racing' && !waitingForMobile;
  mobileInput.setRacing(racing && (!HARNESS || params.has('mobile')));

  // Inputs: player keyboard (or AI autopilot in harness), AI for the rest.
  const flightActive = boats[0].state.flightPhase !== 'surface';
  const playerInput = racing
    ? (mobileInput.enabled ? mobileInput.read(dt, flightActive) : input.read(dt, flightActive))
    : ZERO_INPUT;
  if (!retryLessonActive) mobileInput.consumeAnyPress();
  if (!racing) input.consumePress('Space'); // never buffer a flight press through the countdown
  worldTime += dt;
  rivalDirector.update(dt, race.racers);
  if (racing) collisions.capture(boats);
  for (let i = 0; i < boats.length && racing; i++) {
    if (i > 0) boats[i].setOpponentEffectDistance(boats[i].state.position.distanceTo(boats[0].state.position));
    let inp: BoatInput;
    if (!racing) {
      inp = ZERO_INPUT;
    } else if (i === 0 && !HARNESS) {
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
        rivalDirector.paceFor(i),
      );
    }
    boats[i].update(dt, inp, worldTime);
  }

  if (racing) course.updateFlightRoute(dt, boats);

  let playerPassedFlight = false;
  if (racing) {
    for (let i = 0; i < boats.length; i++) {
      const state = boats[i].state;
      const routeState = state.flightRouteState;
      if (i > 0 && routeState === 'failed' && state.flightPhase === 'surface') {
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
        if (i === 0) {
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
    course.syncFlightTrackingAfterCollisions(boats);
    race.syncCollisionCorrections();
    presentPlayerCollisions(hits);
  }
  let enteredMedal = false;
  if (playerPassedFlight && race.phase === 'racing') {
    const flights = boats[0].state.flightsCleared;
    const pass = records.recordFlightPass(flights, selectedDriverId);
    newBestThisRun ||= pass.newBest;
    hud.showEndlessPass(flights, pass.bestFlights, pass.newBest);
    tower.announceFlight(flights, pass.bestFlights);
    if (flights === 3 && race.challengeTier === 'unqualified') {
      const tier = race.qualifyChallenge();
      const qualification = records.qualifyRun(race.raceTime);
      medalEarnedThisRun = true;
      ordinaryNewThisRun = qualification.ordinaryNew;
      if (tier !== 'unqualified') {
        startMedalCeremony(tier, qualification.manMedalsTotal, pass.bestFlights);
        enteredMedal = true;
      }
    }
  }
  if (race.challengeTier === 'excellent' && !excellentRecordedThisRun) {
    const excellent = records.recordExcellent(race.raceTime);
    excellentRecordedThisRun = true;
    if (previousChallengeTier === 'ordinary') hud.showExcellentLocked(excellent.excellentTotal);
  }
  previousChallengeTier = race.challengeTier;

  const playerState = boats[0].state;
  if (playerState.flightReady && !prevFlightReady) {
    audio.flightReady();
    cameraRig.flightReadyKick();
    pipeline.pulse('ready');
  }
  if (playerState.boosting && !prevBoosting) pipeline.pulse('boost', 0.92);
  if (playerState.flightPhase === 'spool' && prevFlightPhase !== 'spool') {
    pipeline.pulse('launch', 1.05);
    haptic(22);
  }
  const airBraking = playerState.flightAirBrake > 0.28;
  if (airBraking && !prevAirBraking) {
    audio.airBrakeSnap();
    haptic(8);
  }
  if (playerState.flightGateProgress > prevFlightGateProgress) {
    const flightNumber = Math.max(1, playerState.flightsCleared);
    const feedbackStep = Math.min(3, ((flightNumber - 1) % 3) + 1);
    audio.flightGate(feedbackStep);
    cameraRig.flightGateKick(feedbackStep);
    pipeline.pulse('gate', flightNumber === 3 ? 0.72 : 0.4);
    haptic(10);
  }
  if (playerState.flightRouteState !== prevFlightRouteState) {
    if (playerState.flightRouteState === 'passed') {
      audio.routeClear(Math.min(3, ((playerState.flightsCleared - 1) % 3) + 1));
    }
    else if (playerState.flightRouteState === 'failed') cameraRig.routeMissKick();
  }
  prevFlightReady = playerState.flightReady;
  prevFlightGateProgress = playerState.flightGateProgress;
  prevFlightRouteState = playerState.flightRouteState;
  prevFlightPhase = playerState.flightPhase;
  prevBoosting = playerState.boosting;
  prevAirBraking = airBraking;

  // Landing feedback: camera shake + thud on slams, splash on soft landings.
  for (let i = 0; i < boats.length; i++) {
    const imp = boats[i].state.landImpulse;
    if (imp > 7) {
      if (i === 0) {
        cameraRig.shake(Math.min(1, imp / 16));
        audio.thud(Math.min(1, imp / 14));
      }
      audio.splash(Math.min(1, imp / 12));
    }
  }

  for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, worldTime, race.racers[i].finished);

  cameraRig.update(dt, boats[0], worldTime);
  ocean.update(worldTime, stage.camera.position);
  sky.update(worldTime, stage.camera.position);
  course.update(dt, worldTime);
  for (let i = 0; i < boats.length; i++) wakes[i].update(dt, worldTime);
  spray.update(dt, worldTime);
  jetTrail.update(dt);

  hud.update(dt, race, boats[0], boats);
  tower.update(dt, race);

  const ps = boats[0].state;
  audio.setScene(enteredMedal ? 'medal' : ps.flightPhase === 'surface' ? 'racing' : 'flight');
  mobileInput.setActionState(
    ps.boosting ? ps.boostRemaining : ps.boostCharge,
    ps.flightReady,
    ps.flightPhase !== 'surface',
    course.flightTurnWarning(boats[0].id),
  );
  audio.setEngine(ps.rpm, ps.throttle, ps.boosting);
  audio.setWaterRush(Math.min(1, Math.abs(ps.speed) / 34));
  audio.setAirborne(ps.airborne);
  audio.setFlight(
    ps.flightThrust,
    ps.flightPhase !== 'surface',
    ps.flightPressure,
    Math.max(0, ps.flightClearance),
    ps.flightAirBrake,
    ps.steer,
    ps.flightRouteIndex >= 0 ? ps.flightRouteIndex : ps.flightsCleared,
  );
  audio.setDrift(ps.drifting ? Math.min(1, ps.boostCharge * 0.75 + Math.abs(ps.lateralG) / 18) : 0);
  if (ps.flightRouteMiss) audio.flightMiss();
  pipeline.update(dt, worldTime, ps, race.phase);

  // Failures freeze for one impact beat and then enter the adaptive loading
  // loop directly. The legacy finished branch remains available to scripted modes.
  if ((race.phase === 'finished' || race.phase === 'defeated') && !resultsShown) {
    resultsShown = true;
    cameraRig.mode = race.phase === 'defeated' ? 'defeat' : 'results';
    if (race.phase === 'defeated') {
      cameraRig.defeatKick();
      audio.setScene('defeat');
      audio.defeat();
      pipeline.pulse('defeat', 1.35);
      haptic([28, 35, 55]);
      if (race.challengeResult) {
        const progressBest = records.recordFailure(race.challengeResult);
        pendingFailureNewBest = newBestThisRun || progressBest;
        race.challengeResult.ordinaryNew = ordinaryNewThisRun;
        records.decorateResult(race.challengeResult, pendingFailureNewBest, medalEarnedThisRun);
      }
      defeatFreezeTimer = DEFEAT_FREEZE_S;
      retryLessonFrozenT = worldTime;
      input.reset();
      mobileInput.reset();
      mobileInput.setRacing(false);
    } else {
      const excellent = race.challengeResult?.outcome === 'excellent';
      if (excellent) {
        cameraRig.finishKick();
        pipeline.pulse('finish', 1.25);
      } else {
        cameraRig.routeMissKick();
        pipeline.pulse('lost', 0.55);
      }
      hud.showChallengeResult(race);
    }
  }
  audio.update(dt);
}

function render(frameMs: number): void {
  stage.renderer.info.reset(); // autoReset is off: gather whole-frame stats
  pipeline.render();
  stage.updatePerf(frameMs);
}

const loop = new Loop(step, render);

function handleVisibility(hidden: boolean): void {
  audio.setVisibility(hidden);
  input.reset();
  mobileInput.reset();
  mobileInput.setRacing(false);
  if (hidden) {
    pageWasHidden = true;
    interruptionNeedsCountdown = race.phase === 'racing' || race.phase === 'countdown' || race.phase === 'resume-countdown';
    interruptionActive = race.phase !== 'ready';
    if (!HARNESS) loop.stop();
    return;
  }
  if (!pageWasHidden) return;
  pageWasHidden = false;
  if (race.phase === 'ready') {
    if (!HARNESS) loop.start();
    return;
  }
  interruptionActive = true;
  hud.showInterruption(interruptionNeedsCountdown);
  if (!HARNESS) requestAnimationFrame(() => render(16.7));
}

document.addEventListener('visibilitychange', () => handleVisibility(document.hidden));
window.addEventListener('keydown', (event) => {
  if (interruptionActive && event.code === 'Enter' && !event.repeat) resumeInterruption();
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
  freeCam(px: number, py: number, pz: number, lx: number, ly: number, lz: number): void;
  chaseCam(): void;
  playerPose(): { x: number; y: number; z: number; heading: number };
  driftingOpponentPose(): { x: number; y: number; z: number; heading: number };
  setPlayerInput(input: Partial<BoatInput> | null): void;
  retry(): void;
  playerState(): Record<string, number | string | boolean>;
  stats(): Record<string, number | string>;
  guidance(): Record<string, number>;
  mobileStatus(): Record<string, number | string | boolean>;
  audioState(): Record<string, number | string | boolean>;
  opponentFx(): Record<string, number | string>;
  setVisibility(hidden: boolean): void;
  resumeInterruption(): void;
  perfSample(frames: number): Promise<Record<string, number | string>>;
  collisionCase(name: string): Record<string, number | string | boolean>;
  recordsState(): Record<string, unknown>;
  recordsExport(): string;
  recordsImport(raw: string): { selectedDriverId: string | null };
  recordsCase(name: string): Record<string, unknown>;
  rivalCase(): Record<string, unknown>;
  enduranceCase(flights: number): Record<string, unknown>;
  collisionFeedbackCase(): Record<string, unknown>;
}

let freeCamPose: { p: [number, number, number]; l: [number, number, number] } | null = null;

function advanceUntil(cond: () => boolean, maxSeconds: number): void {
  let elapsed = 0;
  while (!cond() && elapsed < maxSeconds) {
    loop.advance(0.25);
    elapsed += 0.25;
  }
}

const tmpP = new THREE.Vector3();
const tmpT = new THREE.Vector3();

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
function placeOpponentDriftPack(uPlayer: number): void {
  const offsets = [0, 0.004, 0.008, 0.012, -0.01, -0.016];
  const laterals = [0, -2.2, 2.2, -4.2, 4.2, 0];
  for (let i = 0; i < boats.length; i++) {
    const u = (((uPlayer + offsets[i]) % 1) + 1) % 1;
    course.pointAt(u, tmpP);
    course.tangentAt(u, tmpT);
    const heading = Math.atan2(tmpT.x, tmpT.z);
    boats[i].teleport(tmpP.x + tmpT.z * laterals[i], tmpP.z - tmpT.x * laterals[i], heading);
    wakes[i].clear();
  }
}

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

/** Earn through the real Space path; used to guard the core drift→flight contract. */
function earnHarnessFlight(combo = false): void {
  setHarnessInput({ throttle: 1 });
  advanceUntil(() => boats[0].state.speed >= 18, 5);
  setHarnessInput({ throttle: 1, drift: true });
  loop.advance(0.62);
  setHarnessInput({ throttle: 1, flightTrigger: combo });
  loop.advance(1 / 60);
  setHarnessInput(null);
}

function beginHarnessRouteFlight(routeCursor = 0): void {
  const routeIndex = routeCursor % course.flightRoutes.length;
  const route = course.flightRoutes[routeIndex];
  course.resetFlightChallenge();
  placePack(route.entryU - 0.035);
  for (const boat of boats) {
    boat.state.flightsCleared = routeCursor;
    boat.state.flightRouteCursor = routeCursor;
    boat.state.flightRouteIndex = -1;
    boat.state.flightRouteState = 'idle';
  }
  // Staging starts behind the launch window. Drift-token earning itself is
  // covered separately; route scenarios focus on flight handling and gates.
  boats[0].state.flightReady = true;
  setHarnessInput(null);
  advanceUntil(() => boats[0].state.flightPhase !== 'surface', 15);
}

function passHarnessFlight(routeCursor: number): void {
  beginHarnessRouteFlight(routeCursor);
  advanceUntil(() => boats[0].state.flightRouteState === 'passed' || race.phase === 'defeated', 14);
  if (boats[0].state.flightRouteState !== 'passed') {
    throw new Error(`harness could not pass flight ${routeCursor + 1}: ${boats[0].state.flightRouteFailReason}`);
  }
  loop.advance(0.05);
}

function qualifyHarnessRun(): void {
  passHarnessFlight(0);
  passHarnessFlight(1);
  passHarnessFlight(2);
}

function resumeHarnessQualifiedRun(): void {
  if (race.phase !== 'medal') return;
  loop.advance(MEDAL_CEREMONY_S + 0.05);
  advanceUntil(() => race.phase === 'racing', 5);
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
function battleFrame(playerU: number, opponentUs: readonly number[]): void {
  placeHarnessBoat(0, playerU);
  for (let i = 0; i < opponentUs.length; i++) placeHarnessBoat(i + 1, opponentUs[i]);
  loop.advance(1 / 60);
}

function stageOvertake(chain: boolean): void {
  const base = 0.16;
  const opponents = chain
    ? [base, base + 0.0015, base + 0.022, base - 0.015, base - 0.022]
    : [base, base + 0.02, base + 0.03, base - 0.015, base - 0.022];
  battleFrame(base - 0.003, opponents); // tracking resync; no event
  const end = chain ? base + 0.0032 : base + 0.0012;
  for (let i = 1; i <= 10; i++) {
    battleFrame(base - 0.003 + (end - (base - 0.003)) * (i / 10), opponents);
  }
  battleFrame(end, opponents);
}

function stagePositionLoss(): void {
  const base = 0.16;
  const opponentU = base + 0.006;
  const before = [base, base + 0.02, base + 0.03, base - 0.015, base - 0.022];
  battleFrame(base + 0.003, before);
  let after = before;
  for (let i = 1; i <= 10; i++) {
    after = [base + (opponentU - base) * (i / 10), base + 0.02, base + 0.03, base - 0.015, base - 0.022];
    battleFrame(base + 0.003, after);
  }
  battleFrame(base + 0.003, after);
}

function presentPlayerCollisions(hits: readonly { a: number; b: number; strength: number }[]): void {
  for (const hit of hits) {
    if ((hit.a !== 0 && hit.b !== 0) || hit.strength < 0.8) continue;
    const opponentId = hit.a === 0 ? hit.b : hit.a;
    audio.collision(hit.strength);
    cameraRig.collisionKick(hit.strength);
    pipeline.pulse('collision', Math.min(1.1, 0.3 + hit.strength / 20));
    haptic(hit.strength > 10 ? [12, 20, 18] : 10);
    rivalDirector.notifyPlayerImpact();
    tower.announceCollision(race.racers[opponentId]?.name ?? '对手');
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
  presentPlayerCollisions(hits);
  const radio = document.querySelector<HTMLElement>('.race-radio');
  return {
    hits: hits.length,
    strength: hits[0]?.strength ?? 0,
    musicDuck: Number(audio.debugState().musicDuck),
    radioVisible: radio?.classList.contains('on') ?? false,
    radioText: radio?.textContent?.trim() ?? '',
    finite: boats.every((boat) => [boat.state.position.x, boat.state.position.y, boat.state.position.z, boat.state.speed]
      .every(Number.isFinite)),
  };
}

function recordsSnapshot(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(records.data)) as Record<string, unknown>;
}

function runRecordsCase(name: string): Record<string, unknown> {
  if (name !== 'progress') throw new Error(`unknown records case: ${name}`);
  records.beginRun();
  records.recordFlightPass(4, 'tide');
  records.qualifyRun(31.25);
  records.recordExcellent(29.5);
  records.recordRivalWin();
  return recordsSnapshot();
}

function runRivalCase(): Record<string, unknown> {
  const makeRacers = () => race.racers.map((racer) => ({ ...racer }));
  const advanceDirector = (director: RivalDirector, racers: ReturnType<typeof makeRacers>, seconds: number): void => {
    for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) director.update(1 / 60, racers);
  };

  const boundsDirector = new RivalDirector();
  boundsDirector.setRoster(roster);
  const racers = makeRacers();
  const player = racers.find((racer) => racer.isPlayer)!;
  const rivalIds = [...boundsDirector.debugState().rivals];
  const nonRival = racers.find((racer) => !racer.isPlayer && !rivalIds.includes(racer.id))!;
  player.progress = 100;
  for (const id of rivalIds) racers[id].progress = 70;
  advanceDirector(boundsDirector, racers, 4);
  const chase = rivalIds.map((id) => boundsDirector.paceFor(id));
  for (const id of rivalIds) racers[id].progress = 130;
  advanceDirector(boundsDirector, racers, 6);
  const release = rivalIds.map((id) => boundsDirector.paceFor(id));

  const lockDirector = new RivalDirector();
  lockDirector.setRoster(roster);
  const lockRacers = makeRacers();
  const lockPlayer = lockRacers.find((racer) => racer.isPlayer)!;
  lockPlayer.progress = 100;
  for (const id of rivalIds) lockRacers[id].progress = 70;
  advanceDirector(lockDirector, lockRacers, 4);
  const beforeLock = rivalIds.map((id) => lockDirector.paceFor(id));
  lockDirector.notifyBattle();
  for (const id of rivalIds) lockRacers[id].progress = 130;
  advanceDirector(lockDirector, lockRacers, 1.5);
  const duringLock = rivalIds.map((id) => lockDirector.paceFor(id));

  const graceDirector = new RivalDirector();
  graceDirector.setRoster(roster);
  const graceRacers = makeRacers();
  const gracePlayer = graceRacers.find((racer) => racer.isPlayer)!;
  gracePlayer.progress = 100;
  for (const id of rivalIds) graceRacers[id].progress = 70;
  graceDirector.notifyPlayerImpact();
  advanceDirector(graceDirector, graceRacers, 2);
  const duringGrace = rivalIds.map((id) => graceDirector.paceFor(id));
  advanceDirector(graceDirector, graceRacers, 1.25);
  const afterGrace = rivalIds.map((id) => graceDirector.paceFor(id));

  return {
    rivalIds,
    chase,
    release,
    beforeLock,
    duringLock,
    duringGrace,
    afterGrace,
    nonRivalId: nonRival.id,
    nonRivalPace: boundsDirector.paceFor(nonRival.id),
  };
}

function runEnduranceCase(requestedFlights: number): Record<string, unknown> {
  const targetFlights = Math.max(7, Math.min(21, Math.floor(requestedFlights)));
  resetRace();
  startFreshCountdown();
  advanceUntil(() => race.phase === 'racing', 8);
  let medalCount = 0;
  for (let cursor = 0; cursor < targetFlights; cursor++) {
    passHarnessFlight(cursor);
    if (race.phase === 'medal') {
      medalCount++;
      resumeHarnessQualifiedRun();
    }
    if (race.phase !== 'racing') break;
  }
  const velocities = boats.map((boat) => boat.collisionVelocity(new THREE.Vector2()).length());
  const final = {
    phase: race.phase,
    flights: boats[0].state.flightsCleared,
    routeCursor: boats[0].state.flightRouteCursor,
    routeSlot: boats[0].state.flightRouteCursor % course.flightRoutes.length,
    passes: harnessRoutePasses[0],
    medalCount,
    challengeTier: race.challengeTier,
    visibleRoutes: course.guidanceStatus().visibleRouteCount,
    maxSpeed: Math.max(...velocities),
    finite: boats.every((boat, i) => [
      boat.state.position.x,
      boat.state.position.y,
      boat.state.position.z,
      boat.state.speed,
      velocities[i],
    ].every(Number.isFinite)),
  };
  resetRace();
  return {
    ...final,
    resetPhase: race.phase,
    resetFlights: boats[0].state.flightsCleared,
    resetRouteCursor: boats[0].state.flightRouteCursor,
    resetVisibleRoutes: course.guidanceStatus().visibleRouteCount,
  };
}

function scenario(name: string): void {
  freeCamPose = null;
  setHarnessInput(null);
  resetRace();
  if (name !== 'ready') startFreshCountdown();
  switch (name) {
    case 'ready':
      loop.advance(1.5);
      break;
    case 'countdown':
      loop.advance(1.7); // mid "2"
      break;
    case 'start':
      advanceUntil(() => race.phase === 'racing', 8);
      loop.advance(2.2);
      break;
    case 'sweeper':
    case 'chicane':
    case 'hairpin':
    case 'airtime': {
      advanceUntil(() => race.phase === 'racing', 8);
      const u = { sweeper: 0.152, chicane: 0.238, hairpin: 0.63, airtime: 0.762 }[name];
      placePack(u);
      if (name === 'airtime') {
        // Run until the player is actually airborne (or 7s of trying).
        advanceUntil(() => boats[0].state.airborne, 7);
      } else {
        loop.advance(2.6);
      }
      break;
    }
    case 'flight-ready':
      advanceUntil(() => race.phase === 'racing', 8);
      earnHarnessFlight(false);
      loop.advance(0.12);
      break;
    case 'interrupted':
      advanceUntil(() => race.phase === 'racing', 8);
      loop.advance(1.2);
      handleVisibility(true);
      handleVisibility(false);
      break;
    case 'flight-rule':
      advanceUntil(() => race.phase === 'racing', 8);
      placePack(course.flightEntryU + 0.001);
      boats[0].state.flightReady = true;
      setHarnessInput({ throttle: 0 });
      loop.advance(0.8);
      break;
    case 'boost-burst':
      advanceUntil(() => race.phase === 'racing', 8);
      earnHarnessFlight(false);
      // Isolate Space's payout so the visual regression is not covered by the
      // larger F-ready prompt. This mutates harness state only.
      boats[0].state.flightReady = false;
      loop.advance(0.07);
      break;
    case 'drift-charge':
      advanceUntil(() => race.phase === 'racing', 8);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => boats[0].state.speed >= 18, 5);
      setHarnessInput({ throttle: 1, drift: true });
      loop.advance(0.9);
      break;
    case 'opponent-drift':
      advanceUntil(() => race.phase === 'racing', 8);
      setHarnessInput({ throttle: 1 });
      placeOpponentDriftPack(0.585);
      advanceUntil(() => boats.slice(1).some((boat) => boat.state.drifting && boat.debugDriftEffects().emissions > 0), 8);
      loop.advance(0.09);
      break;
    case 'flight-spool':
      advanceUntil(() => race.phase === 'racing', 8);
      earnHarnessFlight(false);
      tapHarnessFlight();
      loop.advance(0.055);
      setHarnessInput(null);
      break;
    case 'flight-cruise':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight();
      loop.advance(1.1);
      break;
    case 'flight-airbrake':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight(1);
      advanceUntil(() => course.flightTurnWarning(boats[0].id), 4);
      setHarnessInput({ throttle: 1, steer: -1, airBrake: true });
      loop.advance(0.24);
      break;
    case 'flight-combo':
      advanceUntil(() => race.phase === 'racing', 8);
      earnHarnessFlight(true);
      loop.advance(0.28);
      break;
    case 'flight-descent':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight();
      advanceUntil(() => boats[0].state.flightRouteState === 'passed', 12);
      loop.advance(0.18);
      break;
    case 'flight-miss':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight();
      setHarnessInput({ throttle: 1, steer: 1 });
      advanceUntil(() => race.phase === 'defeated', 8);
      setHarnessInput(null);
      break;
    case 'flight-no-launch':
      advanceUntil(() => race.phase === 'racing', 8);
      placePack(course.flightEntryU - 0.025);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => race.phase === 'defeated', 8);
      setHarnessInput(null);
      break;
    case 'retry-lesson':
      advanceUntil(() => race.phase === 'racing', 8);
      placePack(course.flightEntryU - 0.025);
      setHarnessInput({ throttle: 1 });
      advanceUntil(() => race.phase === 'defeated', 8);
      setHarnessInput(null);
      advanceUntil(() => retryLessonActive, 1);
      loop.advance(0.78);
      break;
    case 'flight-route':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight();
      advanceUntil(() => boats[0].state.flightRouteState === 'passed' || boats[0].state.flightRouteState === 'failed', 12);
      loop.advance(0.08);
      break;
    case 'flight-fresh-token':
      advanceUntil(() => race.phase === 'racing', 8);
      beginHarnessRouteFlight();
      advanceUntil(() => boats[0].state.flightRouteState === 'passed', 12);
      advanceUntil(() => boats[0].state.flightPhase === 'surface' && boats[0].state.flightRouteState === 'idle', 2);
      tapHarnessFlight();
      break;
    case 'endless-qualified':
      advanceUntil(() => race.phase === 'racing', 8);
      qualifyHarnessRun();
      break;
    case 'medal-ceremony':
      advanceUntil(() => race.phase === 'racing', 8);
      qualifyHarnessRun();
      loop.advance(0.9);
      break;
    case 'endless-four':
      advanceUntil(() => race.phase === 'racing', 8);
      qualifyHarnessRun();
      resumeHarnessQualifiedRun();
      passHarnessFlight(3);
      break;
    case 'endless-medal-fail': {
      advanceUntil(() => race.phase === 'racing', 8);
      qualifyHarnessRun();
      resumeHarnessQualifiedRun();
      beginHarnessRouteFlight(3);
      setHarnessInput({ throttle: 1, steer: 1 });
      advanceUntil(() => race.phase === 'defeated', 10);
      setHarnessInput(null);
      advanceUntil(() => retryLessonActive, 1);
      break;
    }
    case 'overtake':
      advanceUntil(() => race.phase === 'racing', 8);
      loop.advance(1.25);
      stageOvertake(false);
      break;
    case 'overtake-chain':
      advanceUntil(() => race.phase === 'racing', 8);
      loop.advance(1.25);
      stageOvertake(true);
      break;
    case 'position-lost':
      advanceUntil(() => race.phase === 'racing', 8);
      loop.advance(1.25);
      stagePositionLoss();
      break;
    default:
      throw new Error(`unknown scenario: ${name}`);
  }
}

if (HARNESS) {
  const harness: Harness = {
    ready: true,
    scenario,
    advance: (seconds) => loop.advance(seconds),
    render: () => {
      if (freeCamPose) {
        stage.camera.position.set(...freeCamPose.p);
        stage.camera.lookAt(...freeCamPose.l);
      }
      stage.renderer.info.reset();
      pipeline.render();
    },
    freeCam: (px, py, pz, lx, ly, lz) => {
      freeCamPose = { p: [px, py, pz], l: [lx, ly, lz] };
    },
    chaseCam: () => {
      freeCamPose = null;
    },
    playerPose: () => ({
      x: boats[0].state.position.x,
      y: boats[0].state.position.y,
      z: boats[0].state.position.z,
      heading: boats[0].state.heading,
    }),
    driftingOpponentPose: () => {
      const player = boats[0].state.position;
      const target = boats.slice(1)
        .filter((boat) => boat.state.drifting)
        .sort((a, b) => a.state.position.distanceToSquared(player) - b.state.position.distanceToSquared(player))[0] ?? boats[1];
      return {
        x: target.state.position.x,
        y: target.state.position.y,
        z: target.state.position.z,
        heading: target.state.heading,
      };
    },
    setPlayerInput: setHarnessInput,
    retry: requestRetry,
    playerState: () => {
      const s = boats[0].state;
      const failure = race.challengeResult?.failure;
      return {
        speed: s.speed,
        boostCharge: s.boostCharge,
        boosting: s.boosting,
        boostRemaining: s.boostRemaining,
        flightReady: s.flightReady,
        flightPhase: s.flightPhase,
        flightRemaining: s.flightRemaining,
        flightClearance: s.flightClearance,
        flightThrust: s.flightThrust,
        flightAirBrake: s.flightAirBrake,
        flightDenied: s.flightDenied,
        flightRouteMiss: s.flightRouteMiss,
        flightRouteState: s.flightRouteState,
        flightRouteFailReason: s.flightRouteFailReason,
        flightGateProgress: s.flightGateProgress,
        flightsCleared: s.flightsCleared,
        flightRouteIndex: s.flightRouteIndex,
        flightPressure: s.flightPressure,
        flightPenaltyRemaining: s.flightPenaltyRemaining,
        place: race.racers[0].place,
        totalRacers: race.racers.length,
        battleEvents: harnessBattleEvents,
        battleOvertakes: harnessOvertakes,
        battlePositionLosses: harnessPositionLosses,
        lastBattleKind: harnessLastBattleKind,
        lastBattleCount: harnessLastBattleCount,
        lastBattleStreak: harnessLastBattleStreak,
        routePasses: harnessRoutePasses[0],
        routeFails: harnessRouteFails[0],
        phase: race.phase,
        challengeTier: race.challengeTier,
        challengeOutcome: race.challengeResult?.outcome ?? 'none',
        challengeGate: race.challengeResult?.gate ?? 0,
        challengeReason: race.challengeResult?.reason ?? 'none',
        flightFailureTargetGate: failure?.targetGate ?? 0,
        flightFailureNumber: failure?.flightNumber ?? 0,
        flightFailureGatesPassed: failure?.gatesPassed ?? 0,
        flightFailureClearance: failure?.clearanceM ?? -1,
        flightRouteCursor: s.flightRouteCursor,
        manMedalEarned: race.challengeResult?.manMedalEarned ?? medalEarnedThisRun,
        manMedalsTotal: race.challengeResult?.manMedalsTotal ?? records.data.manMedalsTotal,
        bestFlights: records.data.bestFlights,
        retryLessonActive,
        retryLessonTimer,
        retryLessonDuration,
        retryLessonElapsed,
        retryLessonMinRead,
        retryLessonProgress: retryLessonActive && retryLessonDuration > 0
          ? retryLessonElapsed / retryLessonDuration
          : 0,
        medalElapsed,
        medalActive: race.phase === 'medal',
        interruptionActive,
        raceTime: race.raceTime,
        worldTime,
        playerX: s.position.x,
        playerY: s.position.y,
        playerZ: s.position.z,
        flightFxRings: boats[0].debugFlightEffects().rings,
        flightFxPlumeLength: boats[0].debugFlightEffects().plumeLength,
        flightFxDeflection: boats[0].debugFlightEffects().deflection,
      };
    },
    stats: () => ({
      ...stage.stats(),
      simTime: loop.simTime,
      worldTime,
      phase: race.phase,
      playerSpeed: boats[0].state.speed,
      playerProgress: race.racers[0].progress,
      flightPhase: boats[0].state.flightPhase,
      flightReady: String(boats[0].state.flightReady),
      flightClearance: boats[0].state.flightClearance,
      flightRemaining: boats[0].state.flightRemaining,
      boostRemaining: boats[0].state.boostRemaining,
      playerPlace: race.racers[0].place,
      totalRacers: race.racers.length,
      playerFlights: boats[0].state.flightsCleared,
      flightPressure: boats[0].state.flightPressure,
      cameraFov: stage.camera.fov,
      routeState: boats[0].state.flightRouteState,
      routeFailReason: boats[0].state.flightRouteFailReason,
      routeGate: boats[0].state.flightGateProgress,
      routePasses: harnessRoutePasses.join(','),
      routeFails: harnessRouteFails.join(','),
      routeDebug: boats.map((boat) => course.flightDebugStatus(boat.id)).join(' | '),
      battleEvents: harnessBattleEvents,
      overtakes: harnessOvertakes,
      positionLosses: harnessPositionLosses,
      retryLessonActive: String(retryLessonActive),
      retryLessonTimer,
      racers: race.racers
        .map((r) => `${r.name}:L${r.lap} p${Math.round(r.progress)}${r.finished ? ' FIN' : ''}${r.wrongWay ? ' WW' : ''}`)
        .join(' | '),
    }),
    guidance: () => course.guidanceStatus(),
    mobileStatus: () => mobileInput.status(),
    audioState: () => audio.debugState(),
    opponentFx: () => {
      const opponents = boats.slice(1);
      const fx = opponents.map((boat) => boat.debugDriftEffects());
      return {
        drifting: opponents.filter((boat) => boat.state.drifting).length,
        emissions: fx.reduce((sum, item) => sum + item.emissions, 0),
        maxEmissions: Math.max(...fx.map((item) => item.emissions)),
        minScale: Math.min(...fx.map((item) => item.scale)),
        maxScale: Math.max(...fx.map((item) => item.scale)),
      };
    },
    setVisibility: handleVisibility,
    resumeInterruption,
    collisionCase: runCollisionCase,
    collisionFeedbackCase: runCollisionFeedbackCase,
    recordsState: recordsSnapshot,
    recordsExport: () => records.exportJson(selectedDriverId),
    recordsImport: (raw) => records.importJson(raw),
    recordsCase: runRecordsCase,
    rivalCase: runRivalCase,
    enduranceCase: runEnduranceCase,
    perfSample: (frames) => new Promise((resolve) => {
      const times: number[] = [];
      let previous = performance.now();
      const tick = (now: number): void => {
        const frameMs = Math.max(0.01, now - previous);
        previous = now;
        stage.renderer.info.reset();
        pipeline.render();
        stage.updatePerf(frameMs);
        times.push(frameMs);
        if (times.length < Math.max(1, frames)) {
          requestAnimationFrame(tick);
          return;
        }
        times.sort((a, b) => a - b);
        const percentile = (p: number): number => times[Math.min(times.length - 1, Math.floor(times.length * p))];
        resolve({ ...stage.stats(), p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) });
      };
      requestAnimationFrame(tick);
    }),
  };
  (window as unknown as { __harness: Harness }).__harness = harness;
  (window as unknown as { __scene: THREE.Scene }).__scene = stage.scene; // harness debugging
  (window as unknown as { __camera: THREE.Camera }).__camera = stage.camera;
  (window as unknown as { __THREE: typeof THREE }).__THREE = THREE;
} else {
  loop.start();
}
