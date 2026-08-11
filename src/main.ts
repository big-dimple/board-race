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
import { Course, GRID_SLOTS } from './game/course';
import { RACER_DEFS } from './game/racers';
import { RecordsStore } from './game/records';
import { Race } from './game/race';
import { AIController } from './game/ai';
import { CameraRig } from './game/chaseCamera';
import { HUD } from './hud/hud';
import { GameAudio } from './audio/audio';
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

// Boats + riders + wakes. Boat 0 is the player.
const boats: Boat[] = [];
const riders: Rider[] = [];
const wakes: WakeRibbon[] = [];
for (const racer of RACER_DEFS) {
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

const ais = RACER_DEFS.map((racer) => new AIController(
  racer.personality,
  course,
  1000 + racer.id * 77,
  racer.pace,
  racer.lane,
));

const cameraRig = new CameraRig(stage.camera);
const audio = new GameAudio();
window.addEventListener('keydown', () => audio.resume());
window.addEventListener('pointerdown', () => audio.resume(), { passive: true });

const hudLayer = document.createElement('div');
hudLayer.id = 'hud-layer';
hudLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;';
app.appendChild(hudLayer);
const hud = new HUD(hudLayer, course, requestRetry, records.data.bestFlights);

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
let currentSimT = 0;
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
const harnessRoutePasses = new Array<number>(boats.length).fill(0);
const harnessRouteFails = new Array<number>(boats.length).fill(0);
const harnessPrevRouteStates: FlightRouteState[] = boats.map((boat) => boat.state.flightRouteState);
const routeLifecycleStates: FlightRouteState[] = boats.map((boat) => boat.state.flightRouteState);

const race = new Race(course, boats, {
  countdownTick: () => audio.countdownBeep(false),
  go: () => {
    audio.countdownBeep(true);
    audio.horn();
    cameraRig.mode = 'chase';
  },
  lapDone: () => {},
  checkpoint: () => {},
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
  },
});

function requestRetry(): void {
  if (retryLessonActive) {
    if (retryLessonElapsed >= retryLessonMinRead) resetRace(true);
    return;
  }
  if (race.phase === 'finished') resetRace(true);
}

function startRetryLesson(): void {
  const result = race.challengeResult;
  if (!result?.failure) return;
  const failure = result.failure;
  const reason = failure?.reason ?? result.reason;
  const key = `${failure?.routeSlot ?? 0}:${reason}`;
  const repeatCount = (retryReasonCounts.get(key) ?? 0) + 1;
  retryReasonCounts.set(key, repeatCount);
  const baseDuration = repeatCount === 1 ? 4.5 : repeatCount === 2 ? 3.2 : 2.2;
  retryLessonDuration = Math.min(5, baseDuration + (pendingFailureNewBest ? 0.5 : 0));
  retryLessonMinRead = repeatCount === 1 ? 2 : repeatCount === 2 ? 1.4 : 1;
  retryLessonTimer = retryLessonDuration;
  retryLessonElapsed = 0;
  retryLessonActive = true;
  retryLessonFrozenT = currentSimT;
  input.reset();
  mobileInput.reset();
  audio.retryLesson();
  hud.showRetryLesson(result, currentRun, repeatCount, pendingFailureNewBest, mobileInput.enabled);
}

function updateFrozenPresentation(dt: number): void {
  const frozen = boats[0].state;
  audio.setEngine(0, 0, false);
  audio.setWaterRush(0);
  audio.setAirborne(false);
  audio.setFlight(0, false);
  audio.setDrift(0);
  pipeline.update(dt, retryLessonFrozenT, frozen, 'defeated');
  audio.update(dt);
}

function resetRace(quick = false): void {
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
  input.reset();
  mobileInput.reset();
  resultsShown = false;
  hud.hideResults();
  hud.hideRetryLesson();
  for (let i = 0; i < boats.length; i++) {
    const s = GRID_SLOTS[i];
    boats[i].teleport(s.x, s.z, s.heading);
    wakes[i].clear();
  }
  race.reset(quick);
  currentRun = records.beginRun();
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
  for (let i = 0; i < boats.length; i++) {
    harnessRoutePasses[i] = 0;
    harnessRouteFails[i] = 0;
    harnessPrevRouteStates[i] = boats[i].state.flightRouteState;
    routeLifecycleStates[i] = boats[i].state.flightRouteState;
    ais[i].reset();
  }
  cameraRig.mode = 'orbit';
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

function step(dt: number, t: number): void {
  currentSimT = t;
  // Consume retry edges in every phase. Otherwise a key pressed during the
  // race remains queued and can erase the defeat screen on the failure frame.
  const enterPressed = input.consumePress('Enter');
  const retryPressed = input.consumePress('KeyR');

  if (retryLessonActive) {
    const lessonPressed = enterPressed || retryPressed || input.consumePress('Space') || mobileInput.consumeAnyPress();
    retryLessonTimer = Math.max(0, retryLessonTimer - dt);
    retryLessonElapsed += dt;
    hud.updateRetryLesson(retryLessonDuration > 0 ? retryLessonElapsed / retryLessonDuration : 1);
    updateFrozenPresentation(dt);
    if (retryLessonTimer <= 0 || (lessonPressed && retryLessonElapsed >= retryLessonMinRead)) resetRace(true);
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

  const waitingForMobile = mobileInput.enabled && !mobileInput.ready && !HARNESS;
  const racing = race.phase === 'racing' && !waitingForMobile;
  const runActive = !waitingForMobile && (race.phase === 'countdown' || racing);
  mobileInput.setRacing(racing && (!HARNESS || params.has('mobile')));

  // Inputs: player keyboard (or AI autopilot in harness), AI for the rest.
  const flightActive = boats[0].state.flightPhase !== 'surface';
  const playerInput = racing
    ? (mobileInput.enabled ? mobileInput.read(dt, flightActive) : input.read(dt, flightActive))
    : ZERO_INPUT;
  if (!retryLessonActive) mobileInput.consumeAnyPress();
  if (!racing) input.consumePress('Space'); // never buffer a flight press through the countdown
  for (let i = 0; i < boats.length && runActive; i++) {
    let inp: BoatInput;
    if (!racing) {
      inp = ZERO_INPUT;
    } else if (i === 0 && !HARNESS) {
      inp = playerInput;
    } else if (i === 0 && harnessPlayerInput) {
      inp = harnessPlayerInput;
    } else {
      inp = ais[i].update(dt, boats[i], boats, race.racers[i].progress, race.racers[0].progress);
    }
    boats[i].update(dt, inp, t);
  }

  if (runActive) course.updateFlightRoute(dt, boats);

  let playerPassedFlight = false;
  if (runActive) {
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
  if (!waitingForMobile && (race.phase === 'countdown' || race.phase === 'racing')) race.update(dt);
  if (playerPassedFlight && race.phase === 'racing') {
    const flights = boats[0].state.flightsCleared;
    const pass = records.recordFlightPass(flights);
    newBestThisRun ||= pass.newBest;
    hud.showEndlessPass(flights, pass.bestFlights, pass.newBest);
    if (flights === 3 && race.challengeTier === 'unqualified') {
      const tier = race.qualifyChallenge();
      const qualification = records.qualifyRun(race.raceTime);
      medalEarnedThisRun = true;
      ordinaryNewThisRun = qualification.ordinaryNew;
      if (tier !== 'unqualified') hud.showQualification(tier, qualification.manMedalsTotal, pass.bestFlights);
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

  for (let i = 0; i < boats.length; i++) riders[i].update(dt, boats[i].state, t, race.racers[i].finished);

  cameraRig.update(dt, boats[0], t);
  ocean.update(t, stage.camera.position);
  sky.update(t, stage.camera.position);
  course.update(dt, t);
  for (let i = 0; i < boats.length; i++) wakes[i].update(dt, t);
  spray.update(dt, t);
  jetTrail.update(dt);

  hud.update(dt, race, boats[0], boats);

  const ps = boats[0].state;
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
  pipeline.update(dt, t, ps, race.phase);

  // Failures freeze for one impact beat and then enter the adaptive loading
  // loop directly. The legacy finished branch remains available to scripted modes.
  if ((race.phase === 'finished' || race.phase === 'defeated') && !resultsShown) {
    resultsShown = true;
    cameraRig.mode = race.phase === 'defeated' ? 'defeat' : 'results';
    if (race.phase === 'defeated') {
      cameraRig.defeatKick();
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
      retryLessonFrozenT = t;
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
  setPlayerInput(input: Partial<BoatInput> | null): void;
  retry(): void;
  playerState(): Record<string, number | string | boolean>;
  stats(): Record<string, number | string>;
  guidance(): Record<string, number>;
  mobileStatus(): Record<string, number | string>;
  perfSample(frames: number): Promise<Record<string, number | string>>;
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
  loop.advance(2.4);
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

function scenario(name: string): void {
  freeCamPose = null;
  setHarnessInput(null);
  resetRace();
  switch (name) {
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
      loop.advance(2.4);
      setHarnessInput({ throttle: 1, drift: true });
      loop.advance(0.9);
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
      loop.advance(0.95);
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
    case 'endless-four':
      advanceUntil(() => race.phase === 'racing', 8);
      qualifyHarnessRun();
      passHarnessFlight(3);
      break;
    case 'endless-medal-fail': {
      advanceUntil(() => race.phase === 'racing', 8);
      qualifyHarnessRun();
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
      };
    },
    stats: () => ({
      ...stage.stats(),
      simTime: loop.simTime,
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
