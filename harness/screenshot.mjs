/**
 * screenshot.mjs — deterministic screenshot harness.
 *
 * Boots the game headless via Playwright (dev server on :5199), drives it to
 * specific race moments through window.__harness (?harness=1 mode: no rAF —
 * the harness advances the fixed-step sim explicitly, so frames are
 * deterministic), and captures retina (2x) PNGs into shots/.
 *
 * Usage:
 *   node harness/screenshot.mjs                 # all scenarios
 *   node harness/screenshot.mjs hairpin water   # subset
 *   node harness/screenshot.mjs --stats         # also print perf stats
 *   node harness/screenshot.mjs --responsive ready # desktop + compact selection layouts
 *   node harness/screenshot.mjs --mobile start       # default tilt controls
 *   node harness/screenshot.mjs --mobile --touch-fallback start
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SHOT_PORT || 5199);
const BASE = `http://localhost:${PORT}/?harness=1`;
const OUT = path.join(root, 'shots');
const systemChrome = '/usr/bin/google-chrome';
const chromePath = process.env.CHROME_PATH || (existsSync(systemChrome) ? systemChrome : undefined);

// name → harness scenario call (+ optional freeCam before render)
const SCENARIOS = {
  ready: { scenario: 'ready' },
  countdown: { scenario: 'countdown' },
  start: { scenario: 'start' },
  sweeper: { scenario: 'sweeper' },
  chicane: { scenario: 'chicane' },
  hairpin: { scenario: 'hairpin' },
  airtime: { scenario: 'airtime' },
  'drift-charge': { scenario: 'drift-charge' },
  'opponent-drift': { scenario: 'opponent-drift', freeCamDynamic: { back: 6.5, up: 1.8, lookUp: 0.55, target: 'opponent' } },
  'boost-burst': { scenario: 'boost-burst', freeCamDynamic: { back: 8.5, up: 2.3, lookUp: 0.55 } },
  'flight-ready': { scenario: 'flight-ready' },
  interrupted: { scenario: 'interrupted' },
  'flight-rule': { scenario: 'flight-rule' },
  'flight-spool': { scenario: 'flight-spool', freeCamDynamic: { back: 7, up: 1.45, lookUp: 0.3 } },
  'flight-cruise': { scenario: 'flight-cruise' },
  'flight-extension-ready': { scenario: 'flight-extension-ready' },
  'flight-extension-spool': { scenario: 'flight-extension-spool' },
  'flight-extension-descent': { scenario: 'flight-extension-descent' },
  'flight-airbrake': { scenario: 'flight-airbrake' },
  'flight-combo': { scenario: 'flight-combo', freeCamDynamic: { back: 7, up: 1.55, lookUp: 0.4 } },
  'flight-descent': { scenario: 'flight-descent' },
  'flight-miss': { scenario: 'flight-miss', settleMs: 760 },
  'flight-no-launch': { scenario: 'flight-no-launch', settleMs: 760 },
  'retry-lesson': { scenario: 'retry-lesson', settleMs: 380 },
  'flight-route': { scenario: 'flight-route' },
  'flight-spent-charge': { scenario: 'flight-spent-charge' },
  'endless-qualified': { scenario: 'endless-qualified', timeout: 180000, settleMs: 180 },
  'medal-ceremony': { scenario: 'medal-ceremony', timeout: 180000, settleMs: 180 },
  'endless-four': { scenario: 'endless-four', timeout: 180000, settleMs: 180 },
  'endless-medal-fail': { scenario: 'endless-medal-fail', timeout: 180000, settleMs: 180 },
  overtake: { scenario: 'overtake', settleMs: 140, freeCamDynamic: { back: 10, up: 3.2, lookUp: 0.8 } },
  'overtake-chain': { scenario: 'overtake-chain', settleMs: 140, freeCamDynamic: { back: 10, up: 3.2, lookUp: 0.8 } },
  'position-lost': { scenario: 'position-lost', freeCamDynamic: { back: 10, up: 3.2, lookUp: 0.8 } },
  // Free-camera close-ups, driven off the mid-race pack.
  rider: {
    scenario: 'sweeper',
    // placed dynamically: just astern of the player, low, rider-height
    freeCamDynamic: { back: 5.5, up: 1.9, lookUp: 1.2 },
  },
  water: {
    scenario: 'airtime',
    freeCamDynamic: { back: 26, up: 3.2, lookUp: 0 },
  },
};

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server did not come up at ${url}`);
}

async function verifyFlightContract(page) {
  // A fresh page waits forever. Only a new Enter edge may start the run.
  await assertDriverSelectComposition(page, 'desktop-1440x900');
  let state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready');
  const readyPose = { x: state.playerX, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime };
  await page.evaluate(() => window.__harness.advance(1));
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyR');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready', 'Space and R must not start a fresh run');
  assert.equal(state.playerX, readyPose.x);
  assert.equal(state.playerZ, readyPose.z);
  assert.equal(state.raceTime, readyPose.raceTime);
  assert.equal(state.worldTime, readyPose.worldTime);
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'countdown', 'Enter must start the full countdown');
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'countdown');

  await page.evaluate(() => window.__harness.scenario('countdown'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.place, 4, 'player must start fourth');
  assert.equal(state.totalRacers, 6, 'the challenge must field six racers');

  await page.evaluate(() => window.__harness.scenario('start'));
  await page.evaluate(() => {
    window.__harness.setPlayerInput({ throttle: 1, flightTrigger: true });
    window.__harness.advance(1 / 60);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, false, 'flight without a qualifying drift must not create a charge');
  assert.equal(state.flightPhase, 'surface', 'flight without a charge must stay on the surface');
  assert.equal(state.flightDenied, true, 'a rejected flight press must emit feedback');

  // Backgrounding is a hard pause. Returning requires an explicit GO and a
  // fresh full countdown before this exact run resumes.
  const interruptedRace = {
    x: state.playerX, y: state.playerY, z: state.playerZ,
    raceTime: state.raceTime, worldTime: state.worldTime,
  };
  await page.evaluate(() => window.__harness.setVisibility(true));
  await page.evaluate(() => window.__harness.advance(1));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.interruptionActive, true);
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    interruptedRace,
    'backgrounding must freeze the full race state',
  );
  const hiddenAudio = await page.evaluate(() => window.__harness.audioState());
  assert.equal(hiddenAudio.scene, 'hidden');
  assert.equal(hiddenAudio.outputGain, 0, 'background audio output must stop immediately');
  await page.evaluate(() => window.__harness.setVisibility(false));
  assert.equal(await page.locator('.hud-interruption').evaluate((el) => el.classList.contains('on')), true);
  await page.evaluate(() => window.__harness.advance(0.5));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    interruptedRace,
    'returning to the foreground must remain frozen before GO',
  );
  await page.evaluate(() => window.__harness.resumeInterruption());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'resume-countdown');
  assert.equal(state.interruptionActive, false);
  await page.evaluate(() => window.__harness.advance(2));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    interruptedRace,
    'background resume countdown must keep the race frozen',
  );
  await page.evaluate(() => window.__harness.advance(2.25));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'racing');

  // First occurrence is a strong pause: 8s plus 0.75s for a real PB.
  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(await page.locator('.hud-results').evaluate((el) => el.classList.contains('on')), false,
    'failure must bypass the old result modal');
  await page.evaluate(() => window.__harness.advance(0.6));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.retryLessonActive, true, 'failure must enter loading automatically');
  assert.ok(Math.abs(state.retryLessonDuration - 8.75) < 0.05, `first/new-PB loading duration ${state.retryLessonDuration}`);
  assert.ok(Math.abs(state.retryLessonMinRead - 4) < 0.03);
  await page.evaluate(() => window.__harness.retry());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.retryLessonActive, true, 'loading cannot skip before its reading gate');
  await page.evaluate(() => window.__harness.advance(4.05));
  await page.evaluate(() => window.__harness.retry());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready', 'loading exits to READY, never directly to countdown');
  await page.evaluate(() => window.__harness.advance(0.5));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready', 'READY requires a fresh confirmation edge');

  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  await page.evaluate(() => window.__harness.advance(0.6));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.ok(Math.abs(state.retryLessonDuration - 6.5) < 0.05, `second loading duration ${state.retryLessonDuration}`);
  assert.ok(Math.abs(state.retryLessonMinRead - 3) < 0.03);
  await page.evaluate(() => window.__harness.advance(3.05));
  await page.evaluate(() => window.__harness.retry());

  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  await page.evaluate(() => window.__harness.advance(0.6));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.ok(Math.abs(state.retryLessonDuration - 5) < 0.05, `third loading duration ${state.retryLessonDuration}`);
  assert.ok(Math.abs(state.retryLessonMinRead - 2.5) < 0.03);

  // Surface abandonment uses the same terminal pipeline as a flight miss. A
  // brief collision excursion gets a recovery window, but sustained departure
  // or deliberate reverse driving cannot continue forever in open water.
  await page.evaluate(() => window.__harness.scenario('surface-off-course-grace'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing', 'a sub-0.8s course-edge excursion must remain recoverable');
  assert.equal(state.wrongWay, false, 'returning to the circuit must clear the course warning');

  await page.evaluate(() => window.__harness.scenario('surface-off-course'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated', 'sustained surface course abandonment must be terminal');
  assert.equal(state.challengeReason, 'off_course');
  await page.evaluate(() => window.__harness.advance(0.6));
  assert.match(await page.locator('.hud-lesson-title').textContent() ?? '', /偏航太远/);

  await page.evaluate(() => window.__harness.scenario('surface-wrong-way'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated', 'sustained reverse driving must be terminal');
  assert.equal(state.challengeReason, 'wrong_way');

  await page.evaluate(() => window.__harness.scenario('flight-ready'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, true, 'a qualifying Shift release must earn a flight charge');
  assert.equal(state.flightPhase, 'surface');
  assert.match(await page.locator('.hud-flight-prompt').textContent() ?? '', /SPACE.*起飞/,
    'earned-flight prompt must use the new Space mapping');
  const promptGeometry = await page.locator('.hud-flight-prompt').evaluate((prompt) => {
    const key = prompt.querySelector('.hud-keycap').getBoundingClientRect();
    const copy = prompt.querySelector('.hud-flight-prompt-copy').getBoundingClientRect();
    return { keyWidth: key.width, keyScrollWidth: prompt.querySelector('.hud-keycap').scrollWidth, keyRight: key.right, copyLeft: copy.left };
  });
  assert.ok(promptGeometry.keyWidth >= 64, `SPACE key cap collapsed to ${promptGeometry.keyWidth}px`);
  assert.ok(promptGeometry.keyScrollWidth <= promptGeometry.keyWidth + 1, 'SPACE text must not overflow its key cap');
  assert.ok(promptGeometry.keyRight <= promptGeometry.copyLeft, 'SPACE key cap must not overlap the flight copy');
  const promptOverlaps = await page.evaluate(() => {
    const prompt = document.querySelector('.hud-flight-prompt.on')?.getBoundingClientRect();
    if (!prompt) return ['missing flight prompt'];
    const selectors = ['.race-tower.on', '.hud-topleft', '.audio-mixer.visible'];
    return selectors.flatMap((selector) => {
      const node = document.querySelector(selector);
      if (!node) return [];
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return [];
      const rect = node.getBoundingClientRect();
      const width = Math.min(prompt.right, rect.right) - Math.max(prompt.left, rect.left);
      const height = Math.min(prompt.bottom, rect.bottom) - Math.max(prompt.top, rect.top);
      return width > 1 && height > 1 ? [`${selector}:${width.toFixed(1)}x${height.toFixed(1)}`] : [];
    });
  });
  assert.deepEqual(promptOverlaps, [], `flight prompt overlap: ${promptOverlaps.join(', ')}`);

  await page.evaluate(() => window.__harness.scenario('drift-charge'));
  const driftAudio = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(driftAudio.driftTier) >= 1, `a real drift must cross a readable charge tier: ${JSON.stringify(driftAudio)}`);

  // Drift qualification is short and explicit: a tap remains invalid, while a
  // deliberate ~0.35s hold reaches the shared release-ready state.
  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.setPlayerInput({ throttle: 1, drift: true });
    window.__harness.advance(0.29);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.driftReleaseReady, false, 'a short drift tap must not earn flight');
  await page.evaluate(() => window.__harness.advance(0.08));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.driftReleaseReady, true, 'the release threshold must be readable by about 0.35s');
  assert.equal(await page.locator('.hud-boost').evaluate((el) => el.classList.contains('release-ready')), true);
  await page.evaluate(() => {
    window.__harness.setPlayerInput({ throttle: 1 });
    window.__harness.advance(1 / 30);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1, 'releasing after the threshold must earn exactly one charge');

  // Each distinct release earns one launch, capped at two. Full storage may
  // still pay a normal boost, and one launch must consume only one cell.
  await page.evaluate(() => window.__harness.earnFlight(false));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 2, 'a second qualifying drift must fill the second launch cell');
  await page.evaluate(() => window.__harness.earnFlight(false));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 2, 'flight storage must hard-cap at two');
  assert.equal(state.boosting, true, 'a full magazine must not suppress the drift boost payout');
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1, 'one launch must consume exactly one stored charge');
  assert.notEqual(state.flightPhase, 'surface');

  await page.evaluate(() => window.__harness.scenario('opponent-drift'));
  const opponentFx = await page.evaluate(() => window.__harness.opponentFx());
  assert.ok(opponentFx.drifting >= 1, `at least one opponent must visibly use a real drift input: ${JSON.stringify(opponentFx)}`);
  assert.ok(opponentFx.emissions >= 2, `opponent drift must emit a readable two-sided world effect: ${JSON.stringify(opponentFx)}`);
  assert.ok(opponentFx.minScale >= 0.3 && opponentFx.maxScale <= 1,
    `opponent drift FX must remain inside its distance LOD: ${JSON.stringify(opponentFx)}`);

  await page.evaluate(() => window.__harness.scenario('flight-combo'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, false, 'launch must consume the charge');
  assert.equal(state.boosting, true, 'drift boost must survive a same-frame flight launch');
  assert.notEqual(state.flightPhase, 'surface', 'same-frame drift release + flight must launch');

  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.earnFlight(false);
    window.__harness.earnFlight(false);
    window.__harness.setPlayerInput({ throttle: 1, drift: true });
    window.__harness.advance(0.62);
    window.__harness.setPlayerInput({ throttle: 1, flightTrigger: true });
    window.__harness.advance(1 / 60);
    window.__harness.setPlayerInput(null);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1,
    'full storage + same-frame qualifying release/launch must remain at one after spending');

  await page.evaluate(() => window.__harness.scenario('flight-cruise'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'cruise');
  assert.ok(state.flightClearance > 4 && state.flightClearance < 6.5, `cruise clearance ${state.flightClearance}`);
  assert.ok(state.flightRemaining > 0 && state.flightRemaining < 1);
  assert.ok(state.speed >= 40 && state.speed <= 43, `first flight cruise speed ${state.speed}`);
  assert.ok(state.flightPressure > 0.25, `flight pressure ${state.flightPressure}`);
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'flight');
  assert.ok(state.flightFxRings >= 8, `controlled flight must open the vortex rings: ${state.flightFxRings}`);
  assert.ok(state.flightFxPlumeLength < 2.8, `flight core must remain a short plume, not a beam: ${state.flightFxPlumeLength}`);
  const flightStats = await page.evaluate(() => window.__harness.stats());
  assert.ok(flightStats.cameraFov >= 77 && flightStats.cameraFov <= 86, `flight FOV ${flightStats.cameraFov}`);
  const guidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(guidance.visibleRouteCount, 1, 'only the current player flight guide may be visible');
  assert.equal(guidance.activeRouteIndex, 0);
  assert.equal(guidance.surfaceMaskRouteIndex, 0, 'the green surface ribbon must be masked through the active detour');
  assert.ok(guidance.targetGateDistance > 0, `the unique target gate must expose a real distance: ${JSON.stringify(guidance)}`);
  assert.ok(guidance.targetAnchorScale >= 1 && guidance.targetAnchorScale <= 1.75,
    `the visual locator must stay bounded: ${JSON.stringify(guidance)}`);

  // The spare stored cell becomes a deliberate airborne extension. It must
  // reject launch double-taps, become explicit at cruise, consume exactly one
  // cell, increase remaining airtime, and refuse any second extension.
  await page.evaluate(() => window.__harness.scenario('flight-extension-spool'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1, 'a second press during spool/ascending must not consume the spare cell');
  assert.equal(state.flightExtensionUsed, false);
  assert.equal(state.flightDenied, true, 'an early double-tap needs explicit rejection feedback');

  await page.evaluate(() => window.__harness.scenario('flight-extension-ready'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'cruise');
  assert.equal(state.flightCharges, 1);
  assert.equal(state.flightExtensionReady, true);
  assert.equal(state.flightExtensionUsed, false);
  assert.match(await page.locator('.hud-flight-prompt').textContent() ?? '', /SPACE.*续航.*\+2\.4/,
    'desktop HUD must make the airborne use of the spare cell explicit');
  const remainingBeforeExtension = state.flightRemaining;
  const routeProgressBeforeExtension = state.flightGateProgress;
  const audioExtensionsBefore = Number((await page.evaluate(() => window.__harness.audioState())).flightExtendEvents);
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightExtended, true, 'the accepted Space edge must expose a one-frame extension pulse');
  assert.equal(state.flightCharges, 0, 'airborne extension consumes exactly one stored cell');
  assert.equal(state.flightExtensionUsed, true);
  assert.equal(state.flightExtensionReady, false);
  assert.equal(state.flightPhase, 'cruise');
  assert.ok(state.flightRemaining > remainingBeforeExtension,
    `extension must add real envelope time: ${remainingBeforeExtension} -> ${state.flightRemaining}`);
  assert.equal(state.flightGateProgress, routeProgressBeforeExtension, 'extension must never reset portal progress');
  assert.equal(Number((await page.evaluate(() => window.__harness.audioState())).flightExtendEvents), audioExtensionsBefore + 1,
    'accepted extension needs exactly one dedicated sound event');
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightDenied, true, 'a current flight can be extended at most once');
  assert.equal(state.flightExtensionUsed, true);

  await page.evaluate(() => window.__harness.scenario('flight-extension-descent'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'descending');
  assert.equal(state.flightExtensionReady, true, 'a spare cell must remain usable during descent');
  const descentClearance = state.flightClearance;
  const descentRemaining = state.flightRemaining;
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'cruise', 'late extension must return to the cruise envelope without teleporting');
  assert.equal(state.flightCharges, 0);
  assert.equal(state.flightExtensionUsed, true);
  assert.ok(state.flightRemaining > descentRemaining, 'late extension must add real remaining time');
  assert.ok(Math.abs(state.flightClearance - descentClearance) < 0.5,
    `late extension may arrest descent but must never snap altitude: ${descentClearance} -> ${state.flightClearance}`);

  const budget = await page.evaluate(() => window.__harness.flightBudgetCase());
  assert.ok(Math.abs(budget.envelope.descendAt - 5.7) < 0.001, `flight descent envelope ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.total - 6.45) < 0.001, `flight total envelope ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.extension - 2.4) < 0.001, `flight extension ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.extendedDescendAt - 8.1) < 0.001,
    `extended descent envelope ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.extendedTotal - 8.85) < 0.001,
    `extended total envelope ${JSON.stringify(budget.envelope)}`);
  assert.equal(budget.routes.length, 7);
  for (const route of budget.routes) {
    assert.ok(route.earliestToGate >= 140 && route.earliestToGate <= 152,
      `route ${route.index + 1} launch budget must stay comparable: ${JSON.stringify(route)}`);
    assert.ok(route.latestToGate > 75 && route.latestToGate < route.earliestToGate,
      `route ${route.index + 1} latest launch must retain a real approach: ${JSON.stringify(route)}`);
    assert.ok(route.secondsAt29 <= 5.2,
      `route ${route.index + 1} must pass before descent at sustained air-brake speed: ${JSON.stringify(route)}`);
    assert.ok(route.gateToExit >= 30,
      `route ${route.index + 1} must leave enough authored landing distance: ${JSON.stringify(route)}`);
  }
  for (let route = 0; route < 7; route++) {
    await page.evaluate((index) => window.__harness.passFlight(index, 1, true), route);
    state = await page.evaluate(() => window.__harness.playerState());
    assert.equal(state.flightRouteState, 'passed', `route ${route + 1} must pass under continuous air brake`);
    if (state.phase === 'medal') {
      await page.evaluate(() => window.__harness.advance(8.9));
    }
  }
  await page.evaluate(() => window.__harness.passExtendedFlight(2, true));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'passed',
    `third flight must support early launch + airborne extension + continuous air brake: ${JSON.stringify(state)}`);
  assert.equal(state.flightExtensionUsed, true);
  assert.equal(state.flightCharges, 0);

  await page.evaluate(() => window.__harness.passFlight(0, 2, true));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'passed');
  assert.equal(state.flightCharges, 1, 'a clean gate keeps the unspent spare cell');
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightDenied, true, 'a passed gate must reject extension instead of prolonging its landing');
  assert.equal(state.flightCharges, 1, 'a rejected post-gate press must not consume the spare cell');
  assert.equal(state.flightExtensionUsed, false);

  await page.evaluate(() => window.__harness.scenario('flight-descent'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'descending');
  await page.evaluate(() => window.__harness.advance(0.9));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'surface', `flight must settle back onto the water: ${JSON.stringify(state)}`);
  assert.equal(state.flightReady, false, 'a spent charge must not silently re-arm');

  await page.evaluate(() => window.__harness.scenario('flight-route'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'passed', `authored route must be completable: ${JSON.stringify(state)}`);
  assert.equal(state.flightGateProgress, 1, 'each flight has one scoring portal');
  assert.equal(state.flightsCleared, 1, 'the first route advances only one of three flights');
  assert.equal(state.phase, 'racing', 'the first flight must not finish the challenge');
  assert.equal(state.routePasses, 1);

  await page.evaluate(() => window.__harness.scenario('flight-spent-charge'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightsCleared, 1);
  assert.equal(state.flightPhase, 'surface');
  assert.equal(state.flightReady, false, 'a completed flight cannot preserve an already spent charge');
  assert.equal(state.flightDenied, true, 'another launch requires a stored drift charge');

  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.earnFlight(false);
    window.__harness.earnFlight(false);
    window.__harness.passFlight(0, 2);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1, 'an unused second charge must survive a clean route and landing envelope');

  await page.evaluate(() => window.__harness.scenario('flight-miss'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'failed', 'abandoning a mandatory pylon gate must fail the attempt');
  assert.equal(state.phase, 'defeated', 'a missed pylon is an immediate terminal result');
  assert.ok(['corridor', 'gate', 'gate_left', 'gate_right'].includes(state.flightRouteFailReason),
    `expected a gate miss, got ${state.flightRouteFailReason}`);
  assert.equal(state.flightFailureNumber, 1, 'failure evidence must identify the flight segment');
  assert.equal(state.flightFailureTargetGate, 1, `failure must identify the scoring portal: ${JSON.stringify(state)}`);
  assert.equal(state.routeFails, 1, 'a failed attempt must resolve exactly once');

  await page.evaluate(() => window.__harness.scenario('flight-airbrake'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.ok(state.flightFxDeflection > 0.12, `air-brake must visibly deform the airflow: ${state.flightFxDeflection}`);
  assert.ok(state.flightAirBrake > 0.7, `air brake envelope must attack immediately: ${state.flightAirBrake}`);

  await page.evaluate(() => window.__harness.scenario('overtake'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.battleOvertakes, 1);
  assert.equal(state.lastBattleKind, 'overtake');
  await assertBattleFeedbackVisible(page, 'overtake-desktop');
  await assertBattleLeavesDrivingRoiClear(page, 'overtake-desktop');
  const vp = { label: 'overtake-landscape', width: 844, height: 390 };
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__harness.render());
  await assertBattleFeedbackVisible(page, vp.label);
  await assertBattleLeavesDrivingRoiClear(page, vp.label);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(120);

  await page.evaluate(() => window.__harness.scenario('overtake-chain'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.battleOvertakes, 2);
  assert.equal(state.lastBattleStreak, 2);

  await page.evaluate(() => window.__harness.scenario('position-lost'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.battlePositionLosses, 1);
  assert.equal(state.lastBattleKind, 'lost');

  const medalsBefore = state.manMedalsTotal;
  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.passFlight(0);
    window.__harness.passFlight(1);
    window.__harness.passFlight(2, 2);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal', 'the third flight must enter the medal ceremony');
  assert.equal(state.flightsCleared, 3);
  assert.notEqual(state.challengeTier, 'unqualified');
  assert.equal(state.flightCharges, 1, 'the spare launch charge must survive the medal freeze');
  assert.equal(state.manMedalsTotal, medalsBefore + 1, 'the third flight grants exactly one medal in the run');
  assert.equal(await page.locator('.hud-medal-ceremony').evaluate((el) => el.classList.contains('on')), true);
  assert.equal(await page.locator('.hud-medal-title').textContent(), '猛男');
  assert.match(await page.locator('.hud-medal-count').textContent() ?? '', /男人勋章 \+1/,
    'the ceremonial title may evolve, but the earned reward must stay explicit');
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'medal',
    'the qualification frame must not overwrite the medal music mix');
  const medalBeforeBackground = state.medalElapsed;
  await page.evaluate(() => window.__harness.setVisibility(true));
  await page.evaluate(() => window.__harness.advance(1));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.medalElapsed, medalBeforeBackground, 'backgrounding must not consume medal ceremony time');
  await page.evaluate(() => window.__harness.setVisibility(false));
  assert.equal(await page.locator('.hud-interruption').evaluate((el) => el.classList.contains('on')), true,
    'the pause GO must remain visible over the medal layer');
  await page.evaluate(() => window.__harness.resumeInterruption());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal', 'resuming a medal screen continues the remaining ceremony first');
  const frozen = {
    x: state.playerX, y: state.playerY, z: state.playerZ,
    raceTime: state.raceTime, worldTime: state.worldTime, medals: state.manMedalsTotal,
  };
  await page.evaluate(() => window.__harness.advance(4.2));
  assert.equal(await page.locator('.hud-medal-next').evaluate((el) => el.classList.contains('on')), true,
    'the final 1.8s must reveal the far-sea follow-up goal');
  await page.evaluate(() => window.__harness.retry());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal', 'ceremony cannot skip before the full 4.5s');
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    { x: frozen.x, y: frozen.y, z: frozen.z, raceTime: frozen.raceTime, worldTime: frozen.worldTime },
    'ceremony must freeze boat, race clock, and world clock',
  );
  await page.evaluate(() => window.__harness.advance(0.35));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'resume-countdown', 'the full ceremony must continue through a resume countdown');
  await page.evaluate(() => window.__harness.advance(2));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'resume-countdown');
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    { x: frozen.x, y: frozen.y, z: frozen.z, raceTime: frozen.raceTime, worldTime: frozen.worldTime },
    'resume countdown must remain frozen',
  );
  await page.evaluate(() => window.__harness.advance(2.25));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing');
  assert.equal(state.manMedalsTotal, frozen.medals, 'resume must not award the medal twice');
  assert.equal(state.flightCharges, 1, 'the spare charge must survive medal and full resume countdown');

  // A physical Shift hold must survive the third-flight ceremony and full
  // resume countdown. Space is edge-triggered and must never survive with it.
  await page.evaluate(() => window.__harness.scenario('endless-two'));
  await page.keyboard.down('Shift');
  await page.keyboard.down('Space');
  await page.evaluate(() => {
    window.__harness.passFlight(2);
    window.__harness.usePlayerInput(true);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal');
  const heldChargeBeforeLanding = state.flightCharges;
  await page.evaluate(() => window.__harness.advance(4.6));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'resume-countdown');
  await page.evaluate(() => window.__harness.advance(4.3));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing');
  assert.notEqual(state.flightPhase, 'spool', 'held Space must not auto-launch after the ceremony');
  await page.evaluate(() => window.__harness.advance(1.15));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'surface');
  assert.equal(state.drifting, true, 'held Shift must become surface drift immediately after landing');
  assert.equal(state.driftReleaseReady, true, 'the preserved hold must reach a readable release threshold');
  assert.equal(state.flightCharges, heldChargeBeforeLanding,
    'holding drift must preserve the spare cell without silently issuing another before release');
  await page.keyboard.up('Space');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).flightPhase, 'surface');
  await page.keyboard.up('Shift');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, Math.min(2, heldChargeBeforeLanding + 1),
    'releasing the preserved Shift hold must add exactly one cell, capped at two');
  await page.evaluate(() => window.__harness.usePlayerInput(false));

  await page.evaluate(() => window.__harness.scenario('endless-four'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing', 'the fourth flight must remain playable');
  assert.equal(state.flightsCleared, 4);
  assert.ok(state.bestFlights >= 4, 'endless flight PB must persist');

  await page.evaluate(() => window.__harness.scenario('ready'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 0, 'a fresh run/reset must clear both stored launch cells');

  await page.evaluate(() => window.__harness.scenario('endless-medal-fail'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(state.retryLessonActive, true);
  assert.equal(state.manMedalEarned, true, 'post-qualification failure must settle the earned medal');
  assert.ok(state.manMedalsTotal >= medalsBefore + 3);
  assert.ok(state.retryLessonDuration >= 8, 'post-medal failure must settle the reward for at least 8s');
  assert.match(await page.locator('.hud-lesson-medal').textContent() ?? '', /男人勋章 \+1/);
  assert.match(await page.locator('.hud-lesson-copy').textContent() ?? '', /空刹/,
    'flight-course failures must teach the contextual air brake on first occurrence');
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'lesson');

  console.log('gameplay contract: OK');
}

async function verifyGamepadContract(page) {
  await page.evaluate(() => {
    window.__gamepadFixture.clear();
    window.__gamepadFixture.connect();
    window.__harness.scenario('ready');
    window.__harness.advance(1 / 30);
  });
  assert.equal((await page.evaluate(() => window.__harness.gamepadStatus())).connected, true);

  const initialDriver = await page.locator('.driver-card.selected').getAttribute('data-driver');
  await page.evaluate(() => {
    window.__gamepadFixture.axis(0, 0.12);
    window.__harness.advance(1 / 30);
  });
  assert.equal((await page.evaluate(() => window.__harness.gamepadStatus())).steer, 0,
    'left-stick noise inside the dead zone must be zero');
  assert.equal(await page.locator('.driver-card.selected').getAttribute('data-driver'), initialDriver,
    'dead-zone noise must not rotate the driver roster');

  await page.evaluate(() => {
    window.__gamepadFixture.axis(0, 0.92);
    window.__harness.advance(1 / 30);
  });
  const nextDriver = await page.locator('.driver-card.selected').getAttribute('data-driver');
  assert.notEqual(nextDriver, initialDriver, 'right stick edge must select exactly one next driver');
  await page.evaluate(() => window.__harness.advance(0.5));
  assert.equal(await page.locator('.driver-card.selected').getAttribute('data-driver'), nextDriver,
    'holding a stick must not scroll through the whole roster');
  await page.evaluate(() => {
    window.__gamepadFixture.axis(0, 0);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.button(0, true);
    window.__harness.advance(1 / 30);
  });
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'countdown',
    'A / Cross must confirm the selected driver and start the countdown');
  await page.evaluate(() => window.__harness.advance(4.4));
  let heldCountdownState = await page.evaluate(() => window.__harness.playerState());
  assert.equal(heldCountdownState.phase, 'racing');
  assert.equal(heldCountdownState.flightPhase, 'surface',
    'holding A through the countdown must never buffer a flight edge');

  await page.evaluate(() => {
    window.__gamepadFixture.clear();
    window.__harness.scenario('start');
    window.__harness.usePlayerInput(true);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.axis(0, 0.9);
    window.__gamepadFixture.button(2, true);
    window.__harness.advance(0.5);
  });
  let state = await page.evaluate(() => window.__harness.playerState());
  assert.ok(state.steer > 0.7, `left stick must reach the boat input: ${JSON.stringify(state)}`);
  assert.equal(state.drifting, true, 'X / Square must hold the contextual drift action');
  assert.equal(state.driftReleaseReady, true, 'a held gamepad drift must reach the real release threshold');

  await page.evaluate(() => {
    window.__gamepadFixture.disconnect();
    window.__harness.advance(1 / 30);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal((await page.evaluate(() => window.__harness.gamepadStatus())).connected, false);
  assert.equal(state.drifting, false, 'disconnect must release drift in the next simulation frame');
  assert.ok(Math.abs(state.steer) < 0.01, `disconnect must release steering: ${state.steer}`);
  assert.equal(state.flightCharges, 1, 'disconnecting a qualified held drift may release exactly one earned charge');

  await page.evaluate(() => {
    window.__gamepadFixture.clear();
    window.__gamepadFixture.connect();
    window.__harness.advance(1 / 30);
  });
  assert.match(await page.locator('.hud-flight-prompt').textContent() ?? '', /A.*起飞/s,
    'a connected controller must be taught A / Cross before spending its charge');
  await page.evaluate(() => {
    window.__gamepadFixture.button(0, true);
    window.__harness.advance(1 / 30);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.notEqual(state.flightPhase, 'surface', 'A / Cross must spend one stored charge and start flight');
  await page.evaluate(() => {
    window.__gamepadFixture.clear();
    window.__gamepadFixture.disconnect();
    window.__harness.usePlayerInput(false);
  });

  await page.evaluate(() => {
    window.__gamepadFixture.connect();
    window.__harness.advance(1 / 30);
    window.__harness.setVisibility(true);
    window.__harness.setVisibility(false);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.button(0, true);
    window.__harness.advance(1 / 30);
  });
  // The first post-reset frame establishes a safe released baseline; the next
  // A edge resumes exactly as keyboard Enter does.
  if ((await page.evaluate(() => window.__harness.playerState())).interruptionActive) {
    await page.evaluate(() => {
      window.__gamepadFixture.button(0, false);
      window.__harness.advance(1 / 30);
      window.__gamepadFixture.button(0, true);
      window.__harness.advance(1 / 30);
    });
  }
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'resume-countdown',
    'A / Cross must resume a background-paused run through the safety countdown');
  await page.evaluate(() => {
    window.__gamepadFixture.clear();
    window.__gamepadFixture.disconnect();
  });
  console.log('gamepad input contract: OK');
}

async function verifyMobileControls(page) {
  const start = page.locator('.mobile-start');
  const contractGo = page.locator('.driver-select-go');
  assert.equal(await contractGo.isVisible(), true, 'mobile must start behind the explicit driver-contract GO');
  assert.equal(await start.isVisible(), false, 'the legacy activation button must not compete with driver selection');
  await assertDriverSelectComposition(page, 'mobile-844x390');
  const selectedBefore = await page.locator('.driver-card.selected').getAttribute('data-driver');
  const featuredBefore = await page.locator('.driver-featured').boundingBox();
  const alternate = page.locator('.driver-switch-next');
  await alternate.click();
  await page.waitForTimeout(95);
  assert.equal(await page.locator('.driver-select').evaluate((el) => el.classList.contains('switching')), true,
    'a driver change must enter the finite selection-lock state');
  assert.notEqual(await page.locator('.driver-card.selected').getAttribute('data-driver'), selectedBefore);
  const backdropAnimation = await page.locator('.driver-mobile-backdrop').evaluate((el) => {
    const style = getComputedStyle(el);
    return { name:style.animationName, duration:parseFloat(style.animationDuration) };
  });
  assert.equal(backdropAnimation.name, 'driver-mobile-backdrop-lock',
    `the standing portrait must run the authored lock-in animation: ${JSON.stringify(backdropAnimation)}`);
  assert.ok(backdropAnimation.duration >= 0.4 && backdropAnimation.duration <= 0.6,
    `the standing portrait lock-in must stay finite and readable: ${JSON.stringify(backdropAnimation)}`);
  const selectAudio = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(selectAudio.driverSelectEvents) >= 1, `driver selection must emit its own event: ${JSON.stringify(selectAudio)}`);
  assert.equal(selectAudio.scoreArmed, false, 'selection SFX must never start the background score');
  assert.equal(selectAudio.musicPlaying, false, 'selection SFX must keep READY musically silent');
  assert.deepEqual(await page.locator('.driver-featured').boundingBox(), featuredBefore,
    'the selection lock may not reflow the featured contract grid');
  const beforeSwipe = await page.locator('.driver-card.selected').getAttribute('data-driver');
  assert.equal(await page.locator('.driver-carousel').isVisible(), false,
    'mobile must not cover the standing portrait with a second card rail');
  await page.locator('.driver-switch-next').click();
  assert.notEqual(await page.locator('.driver-card.selected').getAttribute('data-driver'), beforeSwipe,
    'the explicit next control must advance exactly one hidden roster destination');
  const visitedDrivers = new Set();
  const visitedRosterSlots = new Set();
  for (let i = 0; i < 6; i++) {
    const selection = await page.evaluate(() => ({
      id:document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
      cardSrc:document.querySelector('.driver-card.selected img')?.currentSrc ?? '',
      backdropSrc:document.querySelector('.driver-mobile-backdrop')?.currentSrc ?? '',
      roster:document.querySelector('.driver-roster-index')?.textContent ?? '',
    }));
    assert.equal(selection.backdropSrc, selection.cardSrc,
      `standing portrait must follow every roster change: ${JSON.stringify(selection)}`);
    assert.match(selection.roster, /^选手 \d{2} \/ 06$/);
    visitedDrivers.add(selection.id);
    visitedRosterSlots.add(selection.roster);
    await page.locator('.driver-switch-next').click();
    await page.waitForTimeout(75);
  }
  assert.equal(visitedDrivers.size, 6, `the explicit next control must visit all six drivers: ${[...visitedDrivers].join(', ')}`);
  assert.equal(visitedRosterSlots.size, 6, `the roster counter must expose all six positions: ${[...visitedRosterSlots].join(', ')}`);
  for (let i = 0; i < 12; i++) await page.locator('.driver-switch-next').click();
  await page.waitForTimeout(650);
  const selectSettled = await page.evaluate(() => window.__harness.audioState());
  assert.equal(Number(selectSettled.activeOneShots), 0, 'rapid driver changes must release every transient audio node');
  assert.equal(await page.locator('.driver-select').evaluate((el) => el.classList.contains('switching')), false,
    'the finite selection lock must release its compositing hint after the last switch');
  for (const height of [390, 330, 300]) {
    await page.setViewportSize({ width: 844, height });
    await page.waitForTimeout(50);
    await assertDriverSelectComposition(page, `mobile-844x${height}`);
    const contract = await page.evaluate(() => {
      const selectors = [
        '.driver-select-header', '.driver-featured', '.driver-select-footer',
      ];
      const rects = selectors.map((selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? { selector, top:rect.top, right:rect.right, bottom:rect.bottom, left:rect.left } : null;
      }).filter(Boolean);
      const go = document.querySelector('.driver-select-go')?.getBoundingClientRect();
      const overlaps = [];
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          if (Math.min(a.right,b.right) - Math.max(a.left,b.left) > 1 &&
              Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top) > 1) overlaps.push(`${a.selector} x ${b.selector}`);
        }
      }
      return {
        rects, overlaps,
        go:go && { top:go.top, right:go.right, bottom:go.bottom, left:go.left },
        goCenterX:go ? (go.left + go.right) / 2 : null,
        cardCount:document.querySelectorAll('.driver-card').length,
        visibleCards:[...document.querySelectorAll('.driver-card')]
          .filter((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().width > 0)
          .map((node) => {
            const r = node.getBoundingClientRect();
            return { id:node.dataset.driver, top:r.top, right:r.right, bottom:r.bottom, left:r.left };
          }),
        dotCount:document.querySelectorAll('.driver-dot').length,
        selectedDotCount:document.querySelectorAll('.driver-dot.selected').length,
        archiveCount:document.querySelectorAll('.driver-archive,.driver-archive-button').length,
        switchControls:[...document.querySelectorAll('.driver-switch-control')].map((node) => {
          const r = node.getBoundingClientRect();
          return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height };
        }),
        scrollHeight:document.scrollingElement?.scrollHeight ?? 0,
        width:innerWidth, height:innerHeight,
      };
    });
    assert.deepEqual(contract.overlaps, [], `driver selector rows overlap at 844x${height}: ${contract.overlaps.join(', ')}`);
    assert.ok(contract.go && contract.go.top >= 0 && contract.go.bottom <= contract.height,
      `GO must remain inside the first visual viewport at 844x${height}: ${JSON.stringify(contract.go)}`);
    assert.ok(Math.abs(contract.goCenterX - contract.width / 2) <= 1.5,
      `GO must own the horizontal center at 844x${height}: ${JSON.stringify(contract.go)}`);
    assert.equal(contract.cardCount, 6, 'all six drivers must remain reachable in the carousel');
    assert.equal(contract.visibleCards.length, 0, 'mobile must keep all six destinations behind the two explicit rotation controls');
    assert.equal(contract.dotCount, 6, 'the carousel must expose all six destinations without six cards');
    assert.equal(contract.selectedDotCount, 1, 'exactly one carousel destination must be selected');
    assert.equal(contract.switchControls.length, 2, 'the main driver stage needs two explicit rotation controls');
    for (const control of contract.switchControls) {
      assert.ok(control.left >= 0 && control.right <= contract.width && control.top >= 0 && control.bottom <= contract.height,
        `driver rotation control clips at 844x${height}: ${JSON.stringify(control)}`);
      assert.ok(control.width >= 44 && control.height >= 44,
        `driver rotation control needs a reliable touch target at 844x${height}: ${JSON.stringify(control)}`);
    }
    assert.equal(contract.archiveCount, 0, 'archive import/export must not compete with selection');
    assert.ok(contract.scrollHeight <= contract.height + 1,
      `driver selector must not depend on address-bar collapse at 844x${height}: scrollHeight=${contract.scrollHeight}`);
  }
  const portraitContract = await page.locator('.driver-card img').evaluateAll((images) => images.map((image) => ({
    width:image.naturalWidth, height:image.naturalHeight, src:image.currentSrc,
  })));
  assert.equal(portraitContract.length, 6);
  assert.equal(new Set(portraitContract.map((portrait) => portrait.src)).size, 6, 'every driver needs a distinct portrait');
  for (const portrait of portraitContract) {
    assert.deepEqual({ width: portrait.width, height: portrait.height }, { width: 640, height: 960 },
      `portrait must use the mobile-safe 2:3 master: ${portrait.src}`);
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(120);
  let renderStats = await page.evaluate(() => window.__harness.stats());
  assert.equal(Number(renderStats.mobileClarity), 1, 'touch devices must use the mobile clarity governor');
  assert.ok(Math.abs(Number(renderStats.pixelRatio) - 2.5) < 0.02,
    `844x390 DPR3 must start at the 2.5x clarity cap: ${JSON.stringify(renderStats)}`);
  assert.ok(Number(renderStats.drawingPixels) >= 2_030_000 && Number(renderStats.drawingPixels) <= 2_120_000,
    `mobile Auto must spend, but never exceed, its 2.1M budget: ${JSON.stringify(renderStats)}`);
  const clearRatio = Number(renderStats.pixelRatio);
  await page.evaluate(() => window.__harness.perfFrames(28, 110));
  renderStats = await page.evaluate(() => window.__harness.stats());
  assert.ok(Number(renderStats.pixelRatio) < clearRatio && Number(renderStats.pixelRatio) >= 1,
    `sustained pressure must lower mobile clarity safely: ${clearRatio} -> ${renderStats.pixelRatio}`);
  const reducedRatio = Number(renderStats.pixelRatio);
  await page.evaluate(() => window.__harness.perfFrames(16.7, 380));
  renderStats = await page.evaluate(() => window.__harness.stats());
  assert.ok(Number(renderStats.pixelRatio) > reducedRatio && Number(renderStats.pixelRatio) <= 2.5,
    `stable frames must restore mobile clarity: ${reducedRatio} -> ${renderStats.pixelRatio}`);
  let status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.activation, 'idle');
  assert.ok(Number(status.fullscreenRequests) >= 1,
    `the first touch on the driver selector must request fullscreen: ${JSON.stringify(status)}`);
  await contractGo.click();
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.ok(Number(status.fullscreenRequests) >= 1,
    `the first GO gesture must immediately request fullscreen: ${JSON.stringify(status)}`);

  // Headless Chrome may expose no orientation source. In that case the same
  // timeout used on real unsupported devices must land in touch mode.
  await page.waitForFunction(() => {
    const s = window.__harness.mobileStatus();
    return s.activation === 'calibrating' || s.activation === 'ready';
  });
  status = await page.evaluate(() => window.__harness.mobileStatus());
  if (status.activation === 'calibrating') {
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        const event = new Event('deviceorientation');
        Object.defineProperties(event, {
          beta: { value: 0.6 },
          gamma: { value: 0.4 },
        });
        window.dispatchEvent(event);
      });
      await page.waitForTimeout(55);
    }
  }
  await page.waitForFunction(() => window.__harness.mobileStatus().activation === 'ready', null, { timeout: 2500 });

  const mode = page.locator('.mobile-mode');
  status = await page.evaluate(() => window.__harness.mobileStatus());
  const tiltActions = await readMobileControlGeometry(page);
  assert.equal(status.mode, 'tilt', 'the sensor fixture must enter tilt mode before layout comparison');
  const topControlsOverlap = await page.evaluate(() => {
    const modeRect = document.querySelector('.mobile-mode')?.getBoundingClientRect();
    const soundRect = document.querySelector('.audio-mixer-toggle')?.getBoundingClientRect();
    if (!modeRect || !soundRect) return false;
    return Math.min(modeRect.right, soundRect.right) > Math.max(modeRect.left, soundRect.left) &&
      Math.min(modeRect.bottom, soundRect.bottom) > Math.max(modeRect.top, soundRect.top);
  });
  assert.equal(topControlsOverlap, false, 'SOUND may not cover the tilt/touch mode switch');
  if (status.mode !== 'touch') await mode.click();
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).mode, 'touch');
  const touchActions = await readMobileControlGeometry(page);
  for (const action of ['drift', 'flight']) {
    const before = tiltActions.controls[action];
    const after = touchActions.controls[action];
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      assert.ok(Math.abs(before[edge] - after[edge]) < 0.5,
        `${action} must not move when steering mode changes (${edge}: ${before[edge]} -> ${after[edge]})`);
    }
    assert.ok(after.faceCenterX > touchActions.width * 0.58,
      `${action} must remain in the right-thumb skill zone: ${JSON.stringify(after)}`);
  }
  assert.ok(touchActions.controls.drift.faceCenterX > touchActions.controls.flight.faceCenterX &&
    touchActions.controls.drift.faceCenterY > touchActions.controls.flight.faceCenterY,
  'drift must be the lower-right primary skill and flight its upper-left secondary skill');
  for (const action of ['left', 'right']) {
    assert.ok(touchActions.controls[action].faceCenterX < touchActions.width * 0.44,
      `${action} must remain in the left-thumb steering zone: ${JSON.stringify(touchActions.controls[action])}`);
  }

  // The post-medal countdown exposes direction/drift for preloading, but keeps
  // flight disabled. Active pointers must survive preparing -> racing.
  await page.evaluate(() => {
    window.__harness.scenario('endless-two');
    window.__harness.passFlight(2);
    window.__harness.usePlayerInput(true);
    window.__harness.advance(4.6);
  });
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.controlPhase, 'preparing');
  const preparingCharge = (await page.evaluate(() => window.__harness.playerState())).flightCharges;
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointerdown', { pointerId: 21, pointerType: 'touch', isPrimary: true });
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerdown', { pointerId: 22, pointerType: 'touch' });
  await page.locator('[data-mobile-action="flight"]').dispatchEvent('pointerdown', { pointerId: 23, pointerType: 'touch' });
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'left'], 'preparing may capture steering/drift but never flight');
  await page.evaluate(() => window.__harness.advance(2));
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).controlPhase, 'preparing');
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'left'], 'held preparation pointers must survive the frozen countdown');
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointerup', { pointerId: 21, pointerType: 'touch' });
  await page.evaluate(() => window.__harness.advance(2.3));
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.controlPhase, 'racing');
  await page.evaluate(() => window.__harness.advance(1.15));
  const resumedState = await page.evaluate(() => window.__harness.playerState());
  assert.equal(resumedState.flightPhase, 'surface');
  assert.equal(resumedState.drifting, true);
  assert.equal(resumedState.driftReleaseReady, true);
  assert.equal(resumedState.flightCharges, preparingCharge,
    'a rejected preparing flight tap must not alter the legitimately preserved spare cell');
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerup', { pointerId: 22, pointerType: 'touch' });
  await page.evaluate(() => window.__harness.advance(1 / 30));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).flightCharges, Math.min(2, preparingCharge + 1),
    'releasing the held drift after GO must add exactly one cell');
  await page.evaluate(() => window.__harness.usePlayerInput(false));

  await page.evaluate(() => window.__harness.scenario('start'));
  const geometry = await readMobileControlGeometry(page);
  for (const [name, r] of Object.entries(geometry.controls)) {
    assert.ok(r.width >= 140 && r.height >= 100, `${name} touch target is too small: ${r.width}x${r.height}`);
    assert.ok(r.top >= geometry.height - 170 && r.bottom <= geometry.height, `${name} must stay at the bottom edge`);
    assert.ok(r.faceWidth >= 70 && r.faceWidth <= 100 && r.faceHeight >= 70 && r.faceHeight <= 100,
      `${name} needs a compact thumb disc inside its large hit target: ${JSON.stringify(r)}`);
    assert.equal(r.buttonBackground, 'rgba(0, 0, 0, 0)', `${name} must not paint the rectangular hit target`);
  }
  assert.ok(geometry.controls.right.right < geometry.controls.drift.left,
    'steering and action groups must remain separate');

  // Touch-capable browsers must still accept a real keyboard. The old input
  // branch discarded ArrowLeft/ArrowRight whenever mobile controls existed.
  await page.evaluate(() => window.__harness.usePlayerInput(true));
  await page.keyboard.down('ArrowRight');
  await page.evaluate(() => window.__harness.advance(0.25));
  const keyboardState = await page.evaluate(() => window.__harness.playerState());
  await page.keyboard.up('ArrowRight');
  assert.ok(keyboardState.steer > 0.7,
    `ArrowRight must steer even in a touch-capable Chrome session: ${JSON.stringify(keyboardState)}`);
  await page.evaluate(() => window.__harness.usePlayerInput(false));

  for (const [selector, pointerId] of [
    ['[data-mobile-action="left"]', 31],
    ['[data-mobile-action="drift"]', 32],
    ['[data-mobile-action="flight"]', 33],
  ]) {
    await page.locator(selector).dispatchEvent('pointerdown', { pointerId, pointerType: 'touch', isPrimary: pointerId === 31 });
  }
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'flight', 'left'], 'multi-touch actions must be tracked independently');
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointercancel', { pointerId: 31, pointerType: 'touch' });
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointercancel', { pointerId: 32, pointerType: 'touch' });
  await page.locator('[data-mobile-action="flight"]').dispatchEvent('pointercancel', { pointerId: 33, pointerType: 'touch' });
  assert.equal(await page.locator('.held').count(), 0, 'cancelled touches must never leave sticky controls');

  // Browsers may discard a hidden 2D backing store. Re-entering READY after a
  // real death must redraw the selected driver's radar, not show an empty box.
  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  await page.evaluate(() => window.__harness.advance(0.6));
  await page.locator('.driver-radar').evaluate((canvas) => {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  });
  await page.evaluate(() => window.__harness.advance(4.1));
  await page.evaluate(() => window.__harness.retry());
  await page.waitForTimeout(50);
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'ready');
  const radarPixels = await page.locator('.driver-radar').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) visible++;
    return visible;
  });
  assert.ok(radarPixels > 1200, `radar must redraw after death and READY restore: ${radarPixels} pixels`);

  await page.evaluate(() => window.__harness.scenario('start'));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.mobile-orientation').isVisible(), true, 'portrait must show the landscape blocker');
  assert.match(await page.locator('.mobile-orientation').textContent() ?? '', /仅支持横屏/);
  assert.equal(await page.locator('.driver-select-go').isVisible(), false, 'portrait blocker must own the whole interaction surface');
  assert.equal(await page.locator('[data-mobile-action="flight"]').isVisible(), false, 'portrait must expose no driving controls');
  const portraitFrozen = await page.evaluate(() => window.__harness.playerState());
  await page.evaluate(() => window.__harness.advance(1));
  const portraitAfter = await page.evaluate(() => window.__harness.playerState());
  assert.deepEqual(
    { raceTime: portraitAfter.raceTime, worldTime: portraitAfter.worldTime, x: portraitAfter.playerX, z: portraitAfter.playerZ },
    { raceTime: portraitFrozen.raceTime, worldTime: portraitFrozen.worldTime, x: portraitFrozen.playerX, z: portraitFrozen.playerZ },
    'portrait blocker must freeze gameplay instead of failing behind the overlay',
  );
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.mobile-orientation').isVisible(), false, 'rotating back must dismiss the blocker');
  assert.equal(await page.locator('[data-mobile-action="flight"]').isVisible(), true, 'landscape controls must recover after rotation');
  console.log('mobile controls contract: OK');
}

async function assertDriverSelectComposition(page, label) {
  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      return r && { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height,
        centerX:(r.left + r.right) / 2, centerY:(r.top + r.bottom) / 2 };
    };
    return {
      width:innerWidth,
      height:innerHeight,
      featured:rect('.driver-featured'),
      portrait:rect('.driver-portrait-frame'),
      identity:rect('.driver-identity'),
      radar:rect('.driver-radar-wrap'),
      backdrop:rect('.driver-mobile-backdrop'),
      go:rect('.driver-select-go'),
      mobileBackdropStyle:(() => {
        const backdrop = document.querySelector('.driver-mobile-backdrop');
        const portrait = document.querySelector('.driver-portrait-frame > .driver-portrait:not(.driver-portrait-echo)');
        if (!backdrop || !portrait) return null;
        const style = getComputedStyle(backdrop);
        return {
          display:style.display,
          opacity:Number(style.opacity),
          objectFit:style.objectFit,
          backdropSrc:backdrop.currentSrc,
          portraitSrc:portrait.currentSrc,
          portraitDisplay:getComputedStyle(portrait).display,
          naturalWidth:backdrop.naturalWidth,
          naturalHeight:backdrop.naturalHeight,
          coarse:matchMedia('(pointer:coarse)').matches,
        };
      })(),
      rosterIndex:document.querySelector('.driver-roster-index')?.textContent ?? '',
      switchControls:[...document.querySelectorAll('.driver-switch-control')].map((node) => rect(`.${node.classList.contains('driver-switch-previous') ? 'driver-switch-previous' : 'driver-switch-next'}`)),
      cardCount:document.querySelectorAll('.driver-card').length,
      visibleCardCount:[...document.querySelectorAll('.driver-card')]
        .filter((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().width > 0).length,
      dotCount:document.querySelectorAll('.driver-dot').length,
      selectedDotCount:document.querySelectorAll('.driver-dot.selected').length,
      archiveCount:document.querySelectorAll('.driver-archive,.driver-archive-button').length,
    };
  });
  const { featured, portrait, identity, radar, go } = geometry;
  assert.ok(featured && portrait && identity && radar && go, `${label} driver composition is incomplete`);
  assert.ok(Math.abs(featured.centerX - geometry.width / 2) <= 1.5,
    `${label} featured stage is not centered: ${JSON.stringify(geometry)}`);
  const decisionGap = radar.left - portrait.right;
  assert.ok(decisionGap >= 2 && decisionGap <= 14,
    `${label} portrait and ability analysis must sit tightly together: gap=${decisionGap}`);
  assert.ok(Math.abs(go.centerX - geometry.width / 2) <= 1.5,
    `${label} contract GO must sit on the center axis: ${JSON.stringify(go)}`);
  assert.match(geometry.rosterIndex, /^选手 \d{2} \/ 06$/, `${label} must expose the current place in the six-driver roster`);
  assert.equal(geometry.switchControls.length, 2, `${label} needs previous and next driver controls`);
  if (geometry.mobileBackdropStyle?.coarse) {
    assert.ok(geometry.backdrop, `${label} needs a standing mobile portrait`);
    assert.equal(geometry.mobileBackdropStyle.display, 'block', `${label} standing portrait must be visible`);
    assert.equal(geometry.mobileBackdropStyle.objectFit, 'contain', `${label} standing portrait must never be cropped`);
    assert.ok(geometry.mobileBackdropStyle.opacity >= 0.35 && geometry.mobileBackdropStyle.opacity <= 0.52,
      `${label} standing portrait must remain a legible background layer: ${JSON.stringify(geometry.mobileBackdropStyle)}`);
    assert.equal(geometry.mobileBackdropStyle.backdropSrc, geometry.mobileBackdropStyle.portraitSrc,
      `${label} background and selected driver must stay in sync`);
    assert.deepEqual(
      { width:geometry.mobileBackdropStyle.naturalWidth, height:geometry.mobileBackdropStyle.naturalHeight },
      { width:640, height:960 },
      `${label} standing portrait must use the 2:3 master`,
    );
    assert.ok(Math.abs(geometry.backdrop.width / geometry.backdrop.height - 2 / 3) < 0.02,
      `${label} standing portrait element lost its vertical aspect: ${JSON.stringify(geometry.backdrop)}`);
    assert.equal(geometry.mobileBackdropStyle.portraitDisplay, 'none', `${label} must not retain the cropped foreground duplicate`);
    assert.ok(radar.left - portrait.right >= 4 && radar.left - portrait.right <= 18,
      `${label} mobile decision column must sit beside, not over, the driver: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(identity.left - radar.left) <= 2 && Math.abs(identity.right - radar.right) <= 2,
      `${label} identity and radar must form one right-side decision column: ${JSON.stringify(geometry)}`);
    assert.ok(radar.bottom <= identity.top + 1,
      `${label} radar and identity must not overlap: ${JSON.stringify(geometry)}`);
  } else {
    assert.ok(Math.abs(identity.centerX - geometry.width / 2) <= 1.5,
      `${label} desktop identity must anchor the screen center: ${JSON.stringify(identity)}`);
    assert.ok(Math.abs(portrait.width - radar.width) <= 2,
      `${label} desktop portrait and radar need equal visual weight: ${portrait.width} vs ${radar.width}`);
    assert.ok(Math.abs(portrait.centerY - radar.centerY) <= 2,
      `${label} desktop portrait and radar left their shared axis: ${portrait.centerY} vs ${radar.centerY}`);
    assert.ok(Math.abs((portrait.centerX + radar.centerX) / 2 - geometry.width / 2) <= 1.5,
      `${label} desktop portrait/radar pair is not centered: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.mobileBackdropStyle?.display, 'none', `${label} desktop must retain the framed portrait composition`);
    assert.notEqual(geometry.mobileBackdropStyle?.portraitDisplay, 'none', `${label} desktop framed portrait disappeared`);
  }
  assert.equal(geometry.cardCount, 6, `${label} must keep all six carousel destinations`);
  assert.equal(geometry.visibleCardCount, geometry.mobileBackdropStyle?.coarse ? 0 : 3,
    `${label} must use the viewport-appropriate roster presentation`);
  assert.equal(geometry.dotCount, 6, `${label} must expose six compact destination marks`);
  assert.equal(geometry.selectedDotCount, 1, `${label} must select one destination mark`);
  assert.equal(geometry.archiveCount, 0, `${label} must not render archive tools`);
  for (const [name, surface] of Object.entries({ featured, portrait, identity, radar })) {
    assert.ok(surface.left >= -1 && surface.right <= geometry.width + 1 && surface.top >= -1 && surface.bottom <= geometry.height + 1,
      `${label} ${name} clips outside the viewport: ${JSON.stringify(surface)}`);
  }
}

async function readMobileControlGeometry(page) {
  return page.evaluate(() => {
    const result = {};
    for (const action of ['left', 'right', 'drift', 'flight']) {
      const el = document.querySelector(`[data-mobile-action="${action}"]`);
      const r = el.getBoundingClientRect();
      const face = el.querySelector('span').getBoundingClientRect();
      const faceStyle = getComputedStyle(el.querySelector('span'));
      result[action] = {
        left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height,
        faceWidth:face.width, faceHeight:face.height, faceRadius:faceStyle.borderRadius,
        faceCenterX:(face.left + face.right) / 2, faceCenterY:(face.top + face.bottom) / 2,
        buttonBackground:getComputedStyle(el).backgroundColor,
      };
    }
    return { controls:result, width:innerWidth, height:innerHeight };
  });
}

async function assertMobileControlLayout(page, label, mode) {
  const geometry = await readMobileControlGeometry(page);
  const { drift, flight, left, right } = geometry.controls;
  for (const [name, control] of Object.entries({ drift, flight })) {
    assert.ok(control.width >= 140 && control.height >= 100,
      `${label} ${name} touch target is too small: ${control.width}x${control.height}`);
    assert.ok(control.faceCenterX > geometry.width * 0.58,
      `${label} ${name} left the right-thumb skill zone: ${JSON.stringify(control)}`);
    assert.ok(control.faceCenterY > geometry.height * 0.42 && control.bottom <= geometry.height,
      `${label} ${name} is outside the lower thumb-reach band: ${JSON.stringify(control)}`);
  }
  assert.ok(drift.faceCenterX > flight.faceCenterX && drift.faceCenterY > flight.faceCenterY,
    `${label} skill arc must keep drift lower-right and flight upper-left`);
  const faceGap = Math.hypot(drift.faceCenterX - flight.faceCenterX, drift.faceCenterY - flight.faceCenterY);
  assert.ok(faceGap > (drift.faceWidth + flight.faceWidth) * 0.52,
    `${label} skill faces visually collide: gap=${faceGap}`);
  if (mode === 'touch') {
    for (const [name, control] of Object.entries({ left, right })) {
      assert.ok(control.width >= 140 && control.height >= 100,
        `${label} ${name} touch target is too small: ${control.width}x${control.height}`);
      assert.ok(control.faceCenterX < geometry.width * 0.44,
        `${label} ${name} left the left-thumb steering zone: ${JSON.stringify(control)}`);
    }
    assert.ok(right.right < flight.left, `${label} steering and skill hit regions overlap`);
  }
  const hudCollisions = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('.mobile-action-zones span, .mobile-steer-zones span')]
      .filter((element) => {
        const style = getComputedStyle(element.closest('button'));
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      })
      .map((element) => ({ name:element.closest('button')?.dataset.mobileAction ?? 'control', rect:element.getBoundingClientRect() }));
    const surfaces = ['.race-tower-list', '.race-radio.on'].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
      return { name:selector, rect:element.getBoundingClientRect() };
    }).filter(Boolean);
    const hits = [];
    for (const control of controls) {
      for (const surface of surfaces) {
        const width = Math.min(control.rect.right, surface.rect.right) - Math.max(control.rect.left, surface.rect.left);
        const height = Math.min(control.rect.bottom, surface.rect.bottom) - Math.max(control.rect.top, surface.rect.top);
        if (width > 1 && height > 1) hits.push(`${control.name} x ${surface.name} (${width.toFixed(1)}x${height.toFixed(1)})`);
      }
    }
    return hits;
  });
  assert.deepEqual(hudCollisions, [], `${label} controls cover race context: ${hudCollisions.join(', ')}`);
  return geometry;
}

async function activateMobileForScreenshots(page, touchFallback) {
  const contractGo = page.locator('.driver-select-go');
  const legacyStart = page.locator('.mobile-start');
  if (await contractGo.isVisible()) await contractGo.click();
  else if (await legacyStart.isVisible()) await legacyStart.click();
  await page.waitForFunction(() => {
    const s = window.__harness.mobileStatus();
    return s.activation === 'calibrating' || s.activation === 'ready';
  });
  let status = await page.evaluate(() => window.__harness.mobileStatus());
  if (!touchFallback && status.activation === 'calibrating') {
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        const event = new Event('deviceorientation');
        Object.defineProperties(event, {
          beta: { value: 0.6 },
          gamma: { value: 0.4 },
        });
        window.dispatchEvent(event);
      });
      await page.waitForTimeout(55);
    }
  }
  await page.waitForFunction(() => window.__harness.mobileStatus().activation === 'ready', null, { timeout: 3500 });
  status = await page.evaluate(() => window.__harness.mobileStatus());
  const mode = page.locator('.mobile-mode');
  if (touchFallback && status.mode !== 'touch') await mode.click();
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).mode,
    touchFallback ? 'touch' : 'tilt', `mobile screenshot must use the requested ${touchFallback ? 'touch' : 'tilt'} mode`);
}

async function verifyPerformanceContract(page) {
  const assertBudget = async (label) => {
    const stats = await page.evaluate(() => window.__harness.stats());
    assert.equal(stats.quality, 'auto');
    assert.ok(stats.drawingPixels <= 2_120_000,
      `${label} drawing buffer exceeds Auto budget: ${stats.drawingPixels}`);
    assert.ok(stats.pixelRatio >= 0.5 && stats.pixelRatio <= 1.25,
      `${label} pixel ratio out of bounds: ${stats.pixelRatio}`);
    return stats;
  };

  await page.evaluate(() => window.__harness.scenario('start'));
  await page.evaluate(() => window.__harness.render());
  let stats = await assertBudget('1440x900');
  assert.ok(stats.calls <= 600, `Auto start draw calls ${stats.calls} exceed 600`);
  assert.equal(stats.desktopClarity, 1, 'desktop Auto must expose the headroom clarity governor');
  const baseRatio = stats.pixelRatio;
  await page.evaluate(() => window.__harness.perfFrames(16.7, 260));
  stats = await page.evaluate(() => window.__harness.stats());
  assert.ok(stats.pixelRatio > baseRatio, `sustained headroom must sharpen desktop Auto (${baseRatio} -> ${stats.pixelRatio})`);
  assert.ok(stats.drawingPixels <= stats.clarityPixelBudget + 25_000,
    `clarity governor exceeded its hard drawing budget: ${stats.drawingPixels}`);
  const sharpRatio = stats.pixelRatio;
  await page.evaluate(() => window.__harness.perfFrames(28, 90));
  stats = await page.evaluate(() => window.__harness.stats());
  assert.ok(stats.pixelRatio < sharpRatio, `frame pressure must quickly lower clarity (${sharpRatio} -> ${stats.pixelRatio})`);

  const beforeBurst = stats.resizeCount;
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) window.dispatchEvent(new Event('resize'));
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  stats = await page.evaluate(() => window.__harness.stats());
  assert.equal(stats.resizeCount, beforeBurst + 1, 'one resize burst must rebuild render targets exactly once');

  for (const viewport of [
    { label: '1920x1080', width: 1920, height: 1080 },
    { label: '4k', width: 3840, height: 2160 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertBudget(viewport.label);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const sample = await page.evaluate(() => window.__harness.perfSample(45));
  assert.ok(sample.calls <= 600, `sampled Auto start draw calls ${sample.calls} exceed 600`);
  console.log(`performance contract: OK (${sample.drawingPixels} px, calls ${sample.calls}, ` +
    `software p50/p95/p99 ${Number(sample.p50).toFixed(1)}/${Number(sample.p95).toFixed(1)}/${Number(sample.p99).toFixed(1)}ms)`);
}

async function assertHudDoesNotOverlap(page, label) {
  const overlaps = await page.evaluate(() => {
    const selectors = ['.hud-topleft', '.hud-map', '.hud-power', '.hud-speedo', '.hud-flight-prompt'];
    const items = selectors.map((selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      if (style.display === 'none' || Number(style.opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      return { selector, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }).filter(Boolean);
    const hits = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1) hits.push(`${a.selector} x ${b.selector} (${w.toFixed(1)}x${h.toFixed(1)})`);
      }
    }
    return hits;
  });
  assert.deepEqual(overlaps, [], `${label} HUD overlap: ${overlaps.join(', ')}`);
}

async function assertBattleLeavesDrivingRoiClear(page, label) {
  const hits = await page.evaluate(() => {
    const battle = document.querySelector('.hud-battle');
    if (!battle?.classList.contains('on')) return [];
    const w = innerWidth;
    const h = innerHeight;
    const portrait = w <= 600 && h > 520;
    const roi = portrait
      ? { left: w * 0.16, right: w * 0.84, top: h * 0.30, bottom: h * 0.88 }
      : { left: w * 0.28, right: w * 0.72, top: h * 0.24, bottom: h * 0.84 };
    const selectors = [
      '.hud-battle-sky',
      '.hud-battle-copy',
      '.hud-battle-sky-flash',
      '.hud-battle-shard',
    ];
    const collisions = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        const iw = Math.min(r.right, roi.right) - Math.max(r.left, roi.left);
        const ih = Math.min(r.bottom, roi.bottom) - Math.max(r.top, roi.top);
        if (iw > 1 && ih > 1) collisions.push(`${selector} (${iw.toFixed(1)}x${ih.toFixed(1)})`);
      }
    }
    return collisions;
  });
  assert.deepEqual(hits, [], `${label} battle obscures driving ROI: ${hits.join(', ')}`);
}

async function assertBattleFeedbackVisible(page, label) {
  const feedback = await page.evaluate(() => {
    const battle = document.querySelector('.hud-battle');
    const sky = document.querySelector('.hud-battle-sky');
    const copy = document.querySelector('.hud-battle-copy');
    if (!battle || !sky || !copy) return { active: false, visible: false, detail: 'missing DOM' };
    const rootStyle = getComputedStyle(battle);
    const copyStyle = getComputedStyle(copy);
    const compact = innerHeight <= 520;
    const starStyle = getComputedStyle(sky, '::before');
    const visible = compact
      ? starStyle.content !== 'none' && Number(starStyle.opacity) > 0.2
      : copyStyle.display !== 'none' && Number(copyStyle.opacity) > 0.5 && copy.getBoundingClientRect().width > 80;
    return {
      active: battle.classList.contains('on'),
      visible,
      detail: compact ? `star=${starStyle.content}/${starStyle.opacity}` : `copy=${copyStyle.display}/${copyStyle.opacity}`,
      transparentRoot: rootStyle.backgroundColor === 'rgba(0, 0, 0, 0)',
      text: copy.textContent ?? '',
    };
  });
  assert.equal(feedback.active, true, `${label} battle channel is not active`);
  assert.equal(feedback.visible, true, `${label} has no visible overtake feedback (${feedback.detail})`);
  assert.equal(feedback.transparentRoot, true, `${label} battle root must not add a full-screen plate`);
  assert.match(feedback.text, /OVERTAKE|LEAD TAKEN/, `${label} must name the competitive event`);
}

async function assertCompactActionPromptLeavesDrivingRoiClear(page, label) {
  const hit = await page.evaluate(() => {
    if (innerHeight > 520) return null;
    const prompt = document.querySelector('.hud-flight-prompt.on');
    if (!prompt) return null;
    const r = prompt.getBoundingClientRect();
    const roi = {
      left: innerWidth * 0.28,
      right: innerWidth * 0.72,
      top: innerHeight * 0.24,
      bottom: innerHeight * 0.84,
    };
    const w = Math.min(r.right, roi.right) - Math.max(r.left, roi.left);
    const h = Math.min(r.bottom, roi.bottom) - Math.max(r.top, roi.top);
    return w > 1 && h > 1 ? `${w.toFixed(1)}x${h.toFixed(1)}` : null;
  });
  assert.equal(hit, null, `${label} F prompt obscures the compact driving ROI (${hit})`);
}

async function main() {
  const args = process.argv.slice(2);
  const wantStats = args.includes('--stats');
  const responsive = args.includes('--responsive');
  const verifyFlight = args.includes('--verify-flight');
  const verifyMobile = args.includes('--verify-mobile');
  const verifyPerformance = args.includes('--verify-performance');
  const mobile = args.includes('--mobile');
  const touchFallback = args.includes('--touch-fallback');
  const names = args.filter((a) => !a.startsWith('--'));
  const selected = names.length ? names : (verifyFlight || verifyMobile || verifyPerformance) ? [] : Object.keys(SCENARIOS);

  mkdirSync(OUT, { recursive: true });

  const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));

  let browser;
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    browser = await chromium.launch({
      headless: true,
      ...(chromePath ? { executablePath: chromePath } : {}),
      // CI containers commonly expose no /dev/dri. ANGLE's software backend
      // still exercises the real WebGL pipeline and keeps screenshots usable.
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--disable-gpu-sandbox',
      ],
    });
    const page = await browser.newPage({
      viewport: mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 },
      deviceScaleFactor: mobile ? 3 : 2,
      reducedMotion: 'no-preference',
      ...(mobile ? { hasTouch: true, isMobile: true } : {}),
    });
    await page.addInitScript(() => {
      const buttons = Array.from({ length: 18 }, () => ({ pressed:false, touched:false, value:0 }));
      const gamepad = {
        id:'Board Race Test Controller', index:0, connected:true, timestamp:0,
        mapping:'standard', axes:[0,0,0,0], buttons,
      };
      const fixture = {
        connected:false,
        connect() { this.connected = true; gamepad.timestamp++; },
        disconnect() { this.connected = false; gamepad.timestamp++; },
        axis(index, value) { gamepad.axes[index] = value; gamepad.timestamp++; },
        button(index, pressed) {
          buttons[index].pressed = pressed;
          buttons[index].touched = pressed;
          buttons[index].value = pressed ? 1 : 0;
          gamepad.timestamp++;
        },
        clear() {
          gamepad.axes.fill(0);
          for (const button of buttons) Object.assign(button, { pressed:false, touched:false, value:0 });
          gamepad.timestamp++;
        },
      };
      Object.defineProperty(window, '__gamepadFixture', { value:fixture });
      Object.defineProperty(navigator, 'getGamepads', {
        configurable:true,
        value:() => fixture.connected ? [gamepad] : [],
      });
    });
    page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') console.error(`[console.${msg.type()}] ${msg.text()}`);
    });

    await page.goto(`${BASE}${mobile ? '&mobile=1' : ''}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });

    if (verifyFlight) {
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
      await verifyFlightContract(page);
      await verifyGamepadContract(page);
    }
    if (verifyMobile) await verifyMobileControls(page);
    if (verifyPerformance) await verifyPerformanceContract(page);
    if (mobile && selected.length) {
      await activateMobileForScreenshots(page, touchFallback);
      const mode = page.locator('.mobile-mode');
      if (touchFallback) {
        assert.equal(await page.locator('.mobile-controls').evaluate((el) => el.classList.contains('touch-steer')), true,
          'touch fallback must expose the two steering zones');
        assert.equal(await mode.textContent(), '转向 · 触控', 'touch fallback must identify the active steering mode');
      }
    }

    const mobileSuffix = mobile ? (touchFallback ? '-mobile-touch' : '-mobile') : '';

    for (const name of selected) {
      const def = SCENARIOS[name];
      if (!def) {
        console.error(`unknown scenario "${name}" — known: ${Object.keys(SCENARIOS).join(', ')}`);
        continue;
      }
      console.log(`scenario: ${name} ...`);
      await page.evaluate((n) => window.__harness.scenario(n), def.scenario);
      if (def.timeout) await page.waitForTimeout(0); // scenario itself blocks in evaluate
      if (def.settleMs) await page.waitForTimeout(def.settleMs);

      if (def.freeCamDynamic) {
        await page.evaluate((cfg) => {
          const h = window.__harness;
          // Ask the game for the player pose via stats-free path: use chaseCam-relative math in page.
          const p = cfg.target === 'opponent'
            ? window.__harness.driftingOpponentPose()
            : window.__harness.playerPose();
          const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
          h.freeCam(
            p.x - fx * cfg.back, p.y + cfg.up, p.z - fz * cfg.back,
            p.x + fx * 2, p.y + cfg.lookUp, p.z + fz * 2,
          );
        }, def.freeCamDynamic);
      }

      await page.evaluate(() => window.__harness.render());
      await assertBattleLeavesDrivingRoiClear(page, name);
      await assertCompactActionPromptLeavesDrivingRoiClear(page, name);
      await page.screenshot({ path: path.join(OUT, `${name}${mobileSuffix}.png`) });
      if (wantStats) console.log(JSON.stringify(await page.evaluate(() => window.__harness.stats())));
      console.log(`  -> shots/${name}${mobileSuffix}.png`);

      if (responsive) {
        const viewports = mobile ? [
          { suffix: touchFallback ? 'touch-844x390' : 'tilt-844x390', width:844, height:390 },
          { suffix: touchFallback ? 'touch-844x330' : 'tilt-844x330', width:844, height:330 },
          { suffix: touchFallback ? 'touch-844x300' : 'tilt-844x300', width:844, height:300 },
          { suffix: touchFallback ? 'touch-932x430' : 'tilt-932x430', width:932, height:430 },
        ] : name === 'ready' ? [
          { suffix:'844x390', width:844, height:390 },
          { suffix:'844x330', width:844, height:330 },
          { suffix:'844x300', width:844, height:300 },
          { suffix:'932x430', width:932, height:430 },
        ] : [
          { suffix:'landscape', width:844, height:390 },
        ];
        for (const vp of viewports) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.waitForTimeout(120); // allow ResizeObserver + renderer targets to settle
          await page.evaluate(() => window.__harness.render());
          await page.waitForTimeout(20);
          if (name === 'ready') await assertDriverSelectComposition(page, `${name}-${vp.suffix}`);
          if (mobile) await assertMobileControlLayout(page, `${name}-${vp.suffix}`, touchFallback ? 'touch' : 'tilt');
          await assertHudDoesNotOverlap(page, `${name}-${vp.suffix}`);
          await assertBattleLeavesDrivingRoiClear(page, `${name}-${vp.suffix}`);
          await assertCompactActionPromptLeavesDrivingRoiClear(page, `${name}-${vp.suffix}`);
          await page.screenshot({ path: path.join(OUT, `${name}-${vp.suffix}.png`) });
          console.log(`  -> shots/${name}-${vp.suffix}.png`);
        }
        await page.setViewportSize(mobile ? { width:844, height:390 } : { width:1440, height:900 });
        await page.waitForTimeout(120);
      }
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
