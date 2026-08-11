/**
 * main.ts — integration shell. Wires every subsystem together, owns the
 * game flow (countdown → racing → results), and exposes the deterministic
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

import { Stage } from './core/stage';
import { PrePass } from './core/prePass';
import { Loop } from './core/loop';
import { Input } from './core/input';
import { RACER_COLORS } from './core/palette';
import { Ocean } from './water/ocean';
import { WakeRibbon } from './water/wake';
import { SpraySystem } from './water/spray';
import { Sky } from './cel/sky';
import { createPostPipeline } from './cel/postPipeline';
import { Boat } from './game/boat';
import { Rider } from './game/rider';
import { Course, GRID_SLOTS } from './game/course';
import { Race } from './game/race';
import { AIController } from './game/ai';
import { CameraRig } from './game/chaseCamera';
import { HUD } from './hud/hud';
import { GameAudio } from './audio/audio';
import type { BoatInput, Personality } from './contracts';

const params = new URLSearchParams(location.search);
const HARNESS = params.has('harness');

// ------------------------------------------------------------ construction
const app = document.getElementById('app')!;
const stage = new Stage(app);
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

const course = new Course();
stage.scene.add(course.object);

// Boats + riders + wakes. Boat 0 is the player.
const PERSONALITIES: Personality[] = ['clean', 'aggressive', 'clean', 'erratic'];
const boats: Boat[] = [];
const riders: Rider[] = [];
const wakes: WakeRibbon[] = [];
for (let i = 0; i < 4; i++) {
  const wake = new WakeRibbon();
  stage.scene.add(wake.object);
  wakes.push(wake);
  const boat = new Boat({ id: i, color: RACER_COLORS[i], wake, spray });
  stage.scene.add(boat.object);
  boats.push(boat);
  const rider = new Rider({ color: RACER_COLORS[i] });
  boat.riderMount.add(rider.object);
  riders.push(rider);
}

const ais = boats.map((_, i) => new AIController(PERSONALITIES[i], course, 1000 + i * 77));

const cameraRig = new CameraRig(stage.camera);
const audio = new GameAudio();
window.addEventListener('keydown', () => audio.resume());

const hudLayer = document.createElement('div');
hudLayer.id = 'hud-layer';
hudLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;';
app.appendChild(hudLayer);
const hud = new HUD(hudLayer, course);

const input = new Input();
const pipeline = createPostPipeline(stage.renderer, stage.scene, stage.camera, prePass);
stage.onResize((w, h, pr) => {
  pipeline.setSize(w, h, pr);
  prePass.setSize(w * pr, h * pr);
  ocean.setResolution(w * pr, h * pr);
});

// -------------------------------------------------------------- race events
let resultsShown = false;

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
    if (r.isPlayer) audio.finishSting();
  },
  wrongWay: () => {},
});

function resetRace(): void {
  race.reset();
  resultsShown = false;
  hud.hideResults();
  for (let i = 0; i < 4; i++) {
    const s = GRID_SLOTS[i];
    boats[i].teleport(s.x, s.z, s.heading);
    wakes[i].clear();
  }
  cameraRig.mode = 'orbit';
}

resetRace();

// ------------------------------------------------------------------- step
const ZERO_INPUT: BoatInput = { throttle: 0, steer: 0, drift: false };

function step(dt: number, t: number): void {
  const racing = race.phase === 'racing';

  // Inputs: player keyboard (or AI autopilot in harness), AI for the rest.
  const playerInput = racing ? input.read(dt) : ZERO_INPUT;
  for (let i = 0; i < 4; i++) {
    let inp: BoatInput;
    if (i === 0 && !HARNESS) {
      inp = playerInput;
    } else if (!racing) {
      inp = ZERO_INPUT;
    } else {
      inp = ais[i].update(dt, boats[i], boats, race.racers[i].progress, race.racers[0].progress);
    }
    boats[i].update(dt, inp, t);
  }

  race.update(dt);

  // Landing feedback: camera shake + thud on slams, splash on soft landings.
  for (let i = 0; i < 4; i++) {
    const imp = boats[i].state.landImpulse;
    if (imp > 7) {
      if (i === 0) {
        cameraRig.shake(Math.min(1, imp / 16));
        audio.thud(Math.min(1, imp / 14));
      }
      audio.splash(Math.min(1, imp / 12));
    }
  }

  for (let i = 0; i < 4; i++) riders[i].update(dt, boats[i].state, t, race.racers[i].finished);

  cameraRig.update(dt, boats[0], t);
  ocean.update(t, stage.camera.position);
  sky.update(t, stage.camera.position);
  course.update(dt, t);
  for (let i = 0; i < 4; i++) wakes[i].update(dt, t);
  spray.update(dt, t);

  hud.update(dt, race, boats[0], boats);

  const ps = boats[0].state;
  audio.setEngine(ps.rpm, ps.throttle, ps.boosting);
  audio.setWaterRush(Math.min(1, Math.abs(ps.speed) / 34));
  audio.setAirborne(ps.airborne);

  // Results transition.
  if (race.phase === 'finished' && !resultsShown) {
    resultsShown = true;
    cameraRig.mode = 'results';
    hud.showResults(race);
  }
  if (race.phase === 'finished' && input.consumePress('Enter')) resetRace();
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
// (all four boats AI-driven) and renders single frames on demand.
interface Harness {
  ready: boolean;
  scenario(name: string): void;
  advance(seconds: number): void;
  render(): void;
  freeCam(px: number, py: number, pz: number, lx: number, ly: number, lz: number): void;
  chaseCam(): void;
  playerPose(): { x: number; y: number; z: number; heading: number };
  stats(): Record<string, number | string>;
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

/** Place all four boats around course position u, staggered like a racing pack. */
function placePack(uPlayer: number): void {
  const offsets = [0, -0.012, -0.006, -0.018];
  const laterals = [0, 4, -4, 2];
  for (let i = 0; i < 4; i++) {
    const u = (((uPlayer + offsets[i]) % 1) + 1) % 1;
    course.pointAt(u, tmpP);
    course.tangentAt(u, tmpT);
    const heading = Math.atan2(tmpT.x, tmpT.z);
    boats[i].teleport(tmpP.x + tmpT.z * laterals[i], tmpP.z - tmpT.x * laterals[i], heading);
    wakes[i].clear();
  }
}

function scenario(name: string): void {
  freeCamPose = null;
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
    case 'finish':
    case 'results':
      advanceUntil(() => race.phase === 'finished', 500);
      loop.advance(name === 'results' ? 3.5 : 1.2);
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
    stats: () => ({
      ...stage.stats(),
      simTime: loop.simTime,
      phase: race.phase,
      playerSpeed: boats[0].state.speed,
      playerProgress: race.racers[0].progress,
      racers: race.racers
        .map((r) => `${r.name}:L${r.lap} p${Math.round(r.progress)}${r.finished ? ' FIN' : ''}${r.wrongWay ? ' WW' : ''}`)
        .join(' | '),
    }),
  };
  (window as unknown as { __harness: Harness }).__harness = harness;
  (window as unknown as { __scene: THREE.Scene }).__scene = stage.scene; // harness debugging
  (window as unknown as { __camera: THREE.Camera }).__camera = stage.camera;
  (window as unknown as { __THREE: typeof THREE }).__THREE = THREE;
} else {
  loop.start();
}
