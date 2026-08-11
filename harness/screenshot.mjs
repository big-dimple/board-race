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
 *   node harness/screenshot.mjs --responsive flight-cruise # desktop + two compact layouts
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
  countdown: { scenario: 'countdown' },
  start: { scenario: 'start' },
  sweeper: { scenario: 'sweeper' },
  chicane: { scenario: 'chicane' },
  hairpin: { scenario: 'hairpin' },
  airtime: { scenario: 'airtime' },
  'drift-charge': { scenario: 'drift-charge' },
  'boost-burst': { scenario: 'boost-burst', freeCamDynamic: { back: 8.5, up: 2.3, lookUp: 0.55 } },
  'flight-ready': { scenario: 'flight-ready' },
  'flight-rule': { scenario: 'flight-rule' },
  'flight-spool': { scenario: 'flight-spool', freeCamDynamic: { back: 7, up: 1.45, lookUp: 0.3 } },
  'flight-cruise': { scenario: 'flight-cruise' },
  'flight-airbrake': { scenario: 'flight-airbrake' },
  'flight-combo': { scenario: 'flight-combo', freeCamDynamic: { back: 7, up: 1.55, lookUp: 0.4 } },
  'flight-descent': { scenario: 'flight-descent' },
  'flight-miss': { scenario: 'flight-miss', settleMs: 760 },
  'flight-no-launch': { scenario: 'flight-no-launch', settleMs: 760 },
  'retry-lesson': { scenario: 'retry-lesson', settleMs: 380 },
  'flight-route': { scenario: 'flight-route' },
  'flight-fresh-token': { scenario: 'flight-fresh-token' },
  'endless-qualified': { scenario: 'endless-qualified', timeout: 180000, settleMs: 180 },
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
  await page.evaluate(() => window.__harness.scenario('countdown'));
  let state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.place, 4, 'player must start fourth');
  assert.equal(state.totalRacers, 6, 'the challenge must field six racers');

  await page.evaluate(() => window.__harness.scenario('start'));
  await page.evaluate(() => {
    window.__harness.setPlayerInput({ throttle: 1, flightTrigger: true });
    window.__harness.advance(1 / 60);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, false, 'flight without a qualifying drift must not create a token');
  assert.equal(state.flightPhase, 'surface', 'flight without a token must stay on the surface');
  assert.equal(state.flightDenied, true, 'a rejected flight press must emit feedback');

  // First occurrence is deliberately readable: 4.5s plus 0.5s for a new PB.
  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(await page.locator('.hud-results').evaluate((el) => el.classList.contains('on')), false,
    'failure must bypass the old result modal');
  await page.evaluate(() => window.__harness.advance(0.6));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.retryLessonActive, true, 'failure must enter loading automatically');
  assert.ok(Math.abs(state.retryLessonDuration - 5) < 0.05, `first/new-PB loading duration ${state.retryLessonDuration}`);
  assert.ok(Math.abs(state.retryLessonMinRead - 2) < 0.03);
  await page.evaluate(() => window.__harness.retry());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.retryLessonActive, true, 'loading cannot skip before its reading gate');
  await page.evaluate(() => window.__harness.advance(2.05));
  await page.evaluate(() => window.__harness.retry());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'countdown', 'loading can skip after the reading gate');

  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  await page.evaluate(() => window.__harness.advance(0.6));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.ok(Math.abs(state.retryLessonDuration - 3.2) < 0.05, `second loading duration ${state.retryLessonDuration}`);
  assert.ok(Math.abs(state.retryLessonMinRead - 1.4) < 0.03);
  await page.evaluate(() => window.__harness.advance(1.45));
  await page.evaluate(() => window.__harness.retry());

  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  await page.evaluate(() => window.__harness.advance(0.6));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.ok(Math.abs(state.retryLessonDuration - 2.2) < 0.05, `third loading duration ${state.retryLessonDuration}`);
  assert.ok(Math.abs(state.retryLessonMinRead - 1) < 0.03);

  await page.evaluate(() => window.__harness.scenario('flight-ready'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, true, 'qualifying Space release must earn a flight token');
  assert.equal(state.flightPhase, 'surface');
  assert.match(await page.locator('.hud-flight-prompt').textContent() ?? '', /SPACE.*起飞/,
    'earned-flight prompt must use the new Space mapping');

  await page.evaluate(() => window.__harness.scenario('flight-combo'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, false, 'launch must consume the token');
  assert.equal(state.boosting, true, 'drift boost must survive a same-frame flight launch');
  assert.notEqual(state.flightPhase, 'surface', 'same-frame drift release + flight must launch');

  await page.evaluate(() => window.__harness.scenario('flight-cruise'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'cruise');
  assert.ok(state.flightClearance > 4 && state.flightClearance < 5.5, `cruise clearance ${state.flightClearance}`);
  assert.ok(state.flightRemaining > 0 && state.flightRemaining < 1);
  assert.ok(state.speed >= 40 && state.speed <= 43, `first flight cruise speed ${state.speed}`);
  assert.ok(state.flightPressure > 0.25, `flight pressure ${state.flightPressure}`);
  const flightStats = await page.evaluate(() => window.__harness.stats());
  assert.ok(flightStats.cameraFov >= 77 && flightStats.cameraFov <= 86, `flight FOV ${flightStats.cameraFov}`);
  const guidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(guidance.visibleRouteCount, 1, 'only the current player flight guide may be visible');
  assert.equal(guidance.activeRouteIndex, 0);
  assert.equal(guidance.surfaceMaskRouteIndex, 0, 'the green surface ribbon must be masked through the active detour');

  await page.evaluate(() => window.__harness.scenario('flight-descent'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'descending');
  await page.evaluate(() => window.__harness.advance(0.9));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'surface', `flight must settle back onto the water: ${JSON.stringify(state)}`);
  assert.equal(state.flightReady, false, 'spent flight must not silently re-arm');

  await page.evaluate(() => window.__harness.scenario('flight-route'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'passed', `authored route must be completable: ${JSON.stringify(state)}`);
  assert.equal(state.flightGateProgress, 1, 'each flight has one scoring portal');
  assert.equal(state.flightsCleared, 1, 'the first route advances only one of three flights');
  assert.equal(state.phase, 'racing', 'the first flight must not finish the challenge');
  assert.equal(state.routePasses, 1);

  await page.evaluate(() => window.__harness.scenario('flight-fresh-token'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightsCleared, 1);
  assert.equal(state.flightPhase, 'surface');
  assert.equal(state.flightReady, false, 'a completed flight cannot preserve a token');
  assert.equal(state.flightDenied, true, 'the second flight requires a new drift token');

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
  assert.ok(state.flightAirBrake > 0.7, `air brake envelope must attack immediately: ${state.flightAirBrake}`);

  await page.evaluate(() => window.__harness.scenario('overtake'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.battleOvertakes, 1);
  assert.equal(state.lastBattleKind, 'overtake');
  await assertBattleFeedbackVisible(page, 'overtake-desktop');
  await assertBattleLeavesDrivingRoiClear(page, 'overtake-desktop');
  for (const vp of [
    { label: 'overtake-portrait', width: 390, height: 844 },
    { label: 'overtake-landscape', width: 844, height: 390 },
  ]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(120);
    await page.evaluate(() => window.__harness.render());
    await assertBattleFeedbackVisible(page, vp.label);
    await assertBattleLeavesDrivingRoiClear(page, vp.label);
  }
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
  await page.evaluate(() => window.__harness.scenario('endless-qualified'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing', 'the third flight is a qualification threshold, not the finish');
  assert.equal(state.flightsCleared, 3);
  assert.notEqual(state.challengeTier, 'unqualified');
  assert.equal(state.manMedalsTotal, medalsBefore + 1, 'the third flight grants exactly one medal in the run');

  await page.evaluate(() => window.__harness.scenario('endless-four'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing', 'the fourth flight must remain playable');
  assert.equal(state.flightsCleared, 4);
  assert.ok(state.bestFlights >= 4, 'endless flight PB must persist');

  await page.evaluate(() => window.__harness.scenario('endless-medal-fail'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(state.retryLessonActive, true);
  assert.equal(state.manMedalEarned, true, 'post-qualification failure must settle the earned medal');
  assert.ok(state.manMedalsTotal >= medalsBefore + 3);
  assert.match(await page.locator('.hud-lesson-attempt').textContent() ?? '', /勋章 \+1/);
  assert.match(await page.locator('.hud-lesson-copy').textContent() ?? '', /空刹/,
    'flight-course failures must teach the contextual air brake on first occurrence');

  console.log('gameplay contract: OK');
}

async function verifyMobileControls(page) {
  const start = page.locator('.mobile-start');
  assert.equal(await start.isVisible(), true, 'mobile must start behind one explicit gesture');
  let status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.activation, 'idle');
  await start.click();

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
  if (status.mode !== 'touch') await mode.click();
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).mode, 'touch');

  await page.evaluate(() => window.__harness.scenario('start'));
  const geometry = await page.evaluate(() => {
    const result = {};
    for (const action of ['left', 'right', 'drift', 'flight']) {
      const el = document.querySelector(`[data-mobile-action="${action}"]`);
      const r = el.getBoundingClientRect();
      result[action] = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    }
    return { controls: result, width: innerWidth, height: innerHeight };
  });
  for (const [name, r] of Object.entries(geometry.controls)) {
    assert.ok(r.width >= 140 && r.height >= 100, `${name} touch target is too small: ${r.width}x${r.height}`);
    assert.ok(r.top >= geometry.height - 170 && r.bottom <= geometry.height, `${name} must stay at the bottom edge`);
  }
  assert.ok(geometry.controls.right.right < geometry.controls.drift.left,
    'steering and action groups must remain separate');

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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.mobile-orientation').isVisible(), true, 'portrait must show the landscape blocker');
  console.log('mobile controls contract: OK');
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
      deviceScaleFactor: mobile ? 1 : 2,
      ...(mobile ? { hasTouch: true, isMobile: true } : {}),
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
    }
    if (verifyMobile) await verifyMobileControls(page);
    if (verifyPerformance) await verifyPerformanceContract(page);
    if (mobile && touchFallback) {
      const mode = page.locator('.mobile-mode');
      if (await mode.isVisible()) await mode.click();
      assert.equal(await page.locator('.mobile-controls').evaluate((el) => el.classList.contains('touch-steer')), true,
        'touch fallback must expose the two steering zones');
      assert.equal(await mode.textContent(), '触控', 'touch fallback must identify the active steering mode');
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
          const p = window.__harness.playerPose();
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
        for (const vp of [
          { suffix: 'portrait', width: 390, height: 844 },
          { suffix: 'landscape', width: 844, height: 390 },
        ]) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.waitForTimeout(120); // allow ResizeObserver + renderer targets to settle
          await page.evaluate(() => window.__harness.render());
          await page.waitForTimeout(20);
          await assertHudDoesNotOverlap(page, `${name}-${vp.suffix}`);
          await assertBattleLeavesDrivingRoiClear(page, `${name}-${vp.suffix}`);
          await assertCompactActionPromptLeavesDrivingRoiClear(page, `${name}-${vp.suffix}`);
          await page.screenshot({ path: path.join(OUT, `${name}-${vp.suffix}.png`) });
          console.log(`  -> shots/${name}-${vp.suffix}.png`);
        }
        await page.setViewportSize({ width: 1440, height: 900 });
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
