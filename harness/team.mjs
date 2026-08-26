/** Deterministic acceptance for the current main-branch single/duo directory. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.TEAM_PORT || 5212);
const chromePath = process.env.CHROME_PATH ||
  (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const server = spawn(process.execPath, [
  path.join(root, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1', '--port', String(port), '--strictPort',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let serverError = '';
server.stderr.on('data', (chunk) => { serverError += String(chunk); });

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite exited (${server.exitCode}): ${serverError}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite was not ready on ${port}: ${serverError}`);
}

async function advance(page, seconds) {
  await page.evaluate((value) => window.__harness.advance(value), seconds);
}

async function sampleCanvas(page) {
  return page.evaluate(() => {
    window.__harness.render();
    const source = document.querySelector('#app > canvas');
    if (!(source instanceof HTMLCanvasElement)) throw new Error('renderer canvas missing');
    const sample = document.createElement('canvas');
    sample.width = 96;
    sample.height = 54;
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('canvas sample context missing');
    context.drawImage(source, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let min = 255;
    let max = 0;
    let opaque = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const luma = (pixels[index] * 3 + pixels[index + 1] * 6 + pixels[index + 2]) / 10;
      min = Math.min(min, luma);
      max = Math.max(max, luma);
      if (pixels[index + 3] > 240) opaque++;
    }
    return { width: source.clientWidth, height: source.clientHeight, range: max - min, opaque };
  });
}

async function openHarness(browser, init = null) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/?harness=1&quality=performance`, {
    waitUntil: 'load', timeout: 60000,
  });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
  return { context, page, errors };
}

async function enterDuoWithKeyboard(page) {
  await page.evaluate(() => window.__harness.teamFrontDoor());
  const modeText = (await page.locator('.team-mode').innerText()).replace(/\s+/g, ' ');
  assert.match(modeText, /单人/);
  assert.match(modeText, /双打/);
  assert.doesNotMatch(modeText, /独立竞技|队伍协作|双人/);
  await page.locator('.team-mode-duo').click();
  await page.keyboard.press('KeyA');
  await advance(page, 1 / 60);
  await page.keyboard.press('ArrowRight');
  await advance(page, 0.55);
  await page.waitForFunction(() => document.querySelector('.team-drivers')?.classList.contains('on'));
  assert.equal(await page.locator('.team-join-seat.claimed').count(), 2);
  const portraits = await page.locator('.team-driver-portrait').evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  assert.equal(portraits.length, 2);
  assert.ok(portraits.every((box) => box.width >= 240 && box.height >= 330),
    `dual portraits became tiny: ${JSON.stringify(portraits)}`);

  // The two confirmations are deliberately owned by their seated devices.
  await page.keyboard.press('Space');
  await advance(page, 1 / 60);
  await page.keyboard.press('i');
  await advance(page, 0.7);
  await page.waitForFunction(() => window.__harness.duoState().appMode === 'duo', null, { timeout: 30000 });
  await advance(page, 5.2);
  await page.waitForFunction(() => window.__harness.duoState().phase === 'racing', null, { timeout: 30000 });
}

async function verifyKeyboardDuo(page) {
  const stateAtStart = await page.evaluate(() => window.__harness.duoState());
  assert.deepEqual(stateAtStart.playerIds, [0, 1]);
  assert.equal(stateAtStart.racers.length, 6);
  assert.equal(stateAtStart.controlsVisible, true);
  assert.match(stateAtStart.controls, /W \/ S/);
  assert.match(stateAtStart.controls, /↑ \/ ↓/);
  assert.match(stateAtStart.controls, /起飞/);
  assert.doesNotMatch(stateAtStart.controls, /RT|LT/);

  // Either seat can pause the shared simulation. The right keyboard's
  // confirm edge must resume it through the authored countdown, rather than
  // letting race time jump while the overlay is visible.
  await page.keyboard.press('Escape');
  await advance(page, 1 / 60);
  assert.equal(await page.locator('.hud-interruption.on').count(), 1);
  const pausedAt = await page.evaluate(() => window.__harness.duoState().raceTime);
  await advance(page, 0.55);
  const stillPausedAt = await page.evaluate(() => window.__harness.duoState().raceTime);
  assert.equal(stillPausedAt, pausedAt, 'dual pause advanced race time');
  await page.keyboard.press('NumpadEnter');
  await advance(page, 1 / 60);
  assert.equal(await page.evaluate(() => window.__harness.duoState().phase), 'resume-countdown');
  await advance(page, 4.35);
  assert.equal(await page.evaluate(() => window.__harness.duoState().phase), 'racing');

  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyA');
  await advance(page, 0.45);
  await page.keyboard.up('KeyA');
  await page.keyboard.up('KeyW');
  const leftDriven = await page.evaluate(() => window.__harness.duoState());
  assert.ok(leftDriven.racers[0].steer < -0.08,
    `left A did not steer the left boat: ${JSON.stringify(leftDriven)}`);
  assert.ok(leftDriven.racers[0].throttle > 0.5,
    `left W did not accelerate the left boat: ${JSON.stringify(leftDriven)}`);
  assert.ok(Math.abs(leftDriven.racers[1].steer) < 0.08,
    `left steering leaked into the right boat: ${JSON.stringify(leftDriven)}`);

  // Down on the right seat is a brake/reverse vector, independent of the left seat.
  await page.keyboard.down('ArrowDown');
  await advance(page, 0.35);
  await page.keyboard.up('ArrowDown');
  const rightBraked = await page.evaluate(() => window.__harness.duoState());
  assert.ok(rightBraked.racers[1].throttle < 0,
    `right ArrowDown did not brake/reverse: ${JSON.stringify(rightBraked)}`);
  assert.ok(rightBraked.racers[0].throttle > 0,
    `right braking leaked into the left boat: ${JSON.stringify(rightBraked)}`);

  // Elimination promotes the survivor and leaves the eliminated device useful.
  await page.evaluate(() => window.__harness.duoEliminate(0));
  await advance(page, 0.1);
  let eliminated = await page.evaluate(() => window.__harness.duoState());
  assert.equal(eliminated.phase, 'racing');
  assert.equal(eliminated.primaryPlayerId, 1);
  assert.deepEqual(eliminated.eliminated, [true, false]);
  assert.equal(eliminated.controlsVisible, true);
  const survivorPlace = eliminated.racers[1].place;
  assert.equal(await page.locator('.hud-pos-num').textContent(), `${survivorPlace} / 6`);

  await page.keyboard.press('KeyQ');
  await advance(page, 1 / 60);
  const supported = await page.evaluate(() => window.__harness.duoState());
  assert.equal(supported.interactions.support, 1);
  await advance(page, 4.25);
  await page.keyboard.press('KeyE');
  await advance(page, 1 / 60);
  const pranked = await page.evaluate(() => window.__harness.duoState());
  assert.equal(pranked.interactions.prank, 1);
  assert.ok(pranked.honors.awardCount >= 2, `interaction honors missing: ${JSON.stringify(pranked)}`);
  const canvas = await sampleCanvas(page);
  assert.ok(canvas.range > 35 && canvas.opaque > 1200, `duo render is blank: ${JSON.stringify(canvas)}`);
  // Both seats out opens the actual post-match wall: spotlight, standings and
  // at least one selectable accolade must be present before a retry is allowed.
  await page.evaluate(() => window.__harness.duoEliminate(1));
  await advance(page, 0.2);
  assert.equal((await page.locator('.honor-review.on').count()), 1);
  assert.equal(await page.locator('.honor-review-standing').count(), 6);
  assert.ok(await page.locator('.honor-review-card').count() >= 1);
  return { state: pranked, canvas };
}

function installPads() {
  const makePad = (index) => ({
    id: `Board Race Acceptance Pad ${index + 1}`,
    index,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: null,
  });
  const pads = [makePad(0), makePad(1)];
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => pads });
  window.__setPadButton = (index, button, pressed, value = pressed ? 1 : 0) => {
    pads[index].buttons[button].pressed = pressed;
    pads[index].buttons[button].value = value;
    pads[index].timestamp++;
  };
  window.__setPadAxis = (index, axis, value) => {
    pads[index].axes[axis] = value;
    pads[index].timestamp++;
  };
}

async function padButton(page, index, button) {
  await page.evaluate(([pad, code]) => window.__setPadButton(pad, code, true), [index, button]);
  await advance(page, 1 / 60);
  await page.evaluate(([pad, code]) => window.__setPadButton(pad, code, false), [index, button]);
  await advance(page, 1 / 60);
}

async function verifyGamepadSeating(page) {
  await page.evaluate(() => window.__harness.teamFrontDoor());
  await page.locator('.team-mode-duo').click();
  // Deliberately use steep diagonals: left-up and right-down still declare
  // their horizontal seat, matching the physical controller contract.
  await page.evaluate(() => {
    window.__setPadAxis(0, 0, -0.5);
    window.__setPadAxis(0, 1, -0.86);
    window.__setPadAxis(1, 0, 0.5);
    window.__setPadAxis(1, 1, 0.86);
  });
  await advance(page, 1 / 60);
  await page.evaluate(() => {
    window.__setPadAxis(0, 0, 0);
    window.__setPadAxis(0, 1, 0);
    window.__setPadAxis(1, 0, 0);
    window.__setPadAxis(1, 1, 0);
  });
  await advance(page, 1 / 60);
  await advance(page, 0.55);
  await page.waitForFunction(() => document.querySelector('.team-drivers')?.classList.contains('on'));
  const devices = (await page.locator('.team-driver-device').allTextContents()).join(' ');
  assert.match(devices, /手柄 1/);
  assert.match(devices, /手柄 2/);
  await padButton(page, 0, 0);
  await padButton(page, 1, 0);
  await advance(page, 0.75);
  await page.waitForFunction(() => window.__harness.duoState().appMode === 'duo', null, { timeout: 30000 });
  await advance(page, 5.2);
  await page.waitForFunction(() => window.__harness.duoState().phase === 'racing', null, { timeout: 30000 });
  await page.evaluate(() => {
    window.__setPadAxis(0, 0, -0.72);
    window.__setPadAxis(0, 1, -0.72);
    window.__setPadAxis(1, 0, 0.72);
    window.__setPadAxis(1, 1, 0.72);
  });
  await advance(page, 0.3);
  const state = await page.evaluate(() => window.__harness.duoState());
  assert.equal(state.devices[0], 'gamepad:0');
  assert.equal(state.devices[1], 'gamepad:1');
  assert.equal(state.phase, 'racing');
  return state;
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
  });
  const keyboard = await openHarness(browser);
  await enterDuoWithKeyboard(keyboard.page);
  const keyboardResult = await verifyKeyboardDuo(keyboard.page);
  assert.deepEqual(keyboard.errors, [], `keyboard duo emitted browser errors: ${keyboard.errors.join('\n')}`);
  await keyboard.context.close();

  const gamepad = await openHarness(browser, installPads);
  const gamepadResult = await verifyGamepadSeating(gamepad.page);
  assert.deepEqual(gamepad.errors, [], `gamepad duo emitted browser errors: ${gamepad.errors.join('\n')}`);
  await gamepad.context.close();
  console.log('single/duo directory contract: OK');
  console.log(JSON.stringify({ keyboard: keyboardResult, gamepad: gamepadResult }, null, 2));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
