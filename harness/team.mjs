import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.TEAM_PORT || 5212);
const chrome = existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const server = spawn(process.execPath, [
  path.join(root, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1', '--port', String(port), '--strictPort',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let serverError = '';
server.stderr.on('data', (chunk) => { serverError += String(chunk); });

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`team Vite server exited (${server.exitCode}): ${serverError}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`team Vite server was not ready on ${port}: ${serverError}`);
}

async function sampleCanvas(page) {
  return page.evaluate(() => {
    window.__harness.render();
    const source = document.querySelector('#app > canvas');
    if (!(source instanceof HTMLCanvasElement)) throw new Error('renderer canvas missing');
    const sample = document.createElement('canvas');
    sample.width = 96;
    sample.height = 54;
    const ctx = sample.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, sample.width, sample.height);
    const data = ctx.getImageData(0, 0, sample.width, sample.height).data;
    const side = (from, to) => {
      let min = 255;
      let max = 0;
      let opaque = 0;
      for (let y = 0; y < sample.height; y++) {
        for (let x = from; x < to; x++) {
          const i = (y * sample.width + x) * 4;
          const luma = (data[i] * 3 + data[i + 1] * 6 + data[i + 2]) / 10;
          min = Math.min(min, luma);
          max = Math.max(max, luma);
          if (data[i + 3] > 240) opaque++;
        }
      }
      return { range: max - min, opaque };
    };
    return { left: side(0, 47), right: side(49, 96), width: source.clientWidth, height: source.clientHeight };
  });
}

try {
  await waitForServer();
  const browser = await chromium.launch({
    headless: true,
    ...(chrome ? { executablePath: chrome } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const makePad = (index) => ({
      id: `Board Race Test Pad ${index + 1}`, index, connected: true, mapping: 'standard', timestamp: 0,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      vibrationActuator: null,
    });
    const pads = [makePad(0), makePad(1)];
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => pads });
    window.__setTeamPadButton = (index, button, pressed, value = pressed ? 1 : 0) => {
      pads[index].buttons[button].pressed = pressed;
      pads[index].buttons[button].value = value;
      pads[index].timestamp++;
    };
    window.__setTeamPadAxis = (index, axis, value) => {
      pads[index].axes[axis] = value;
      pads[index].timestamp++;
    };
    window.__setTeamPadConnected = (index, connected) => {
      pads[index].connected = connected;
      pads[index].timestamp++;
    };
  });

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/?harness=1&quality=performance`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 120000 });
  await page.evaluate(() => {
    localStorage.removeItem('board-race:team-expedition:v1');
    localStorage.removeItem('board-race:team-expedition:v2');
    window.__harness.teamFrontDoor();
  });

  const modeText = (await page.locator('.team-mode').innerText()).replace(/\s+/g, ' ');
  assert.match(modeText, /独立竞技/);
  assert.match(modeText, /队伍协作/);
  assert.doesNotMatch(modeText, /单人|双人/);
  mkdirSync(path.join(root, 'shots'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'shots/team-front-desktop.png') });

  await page.locator('.team-mode-team').click();
  await page.keyboard.press('KeyA');
  await page.evaluate(() => window.__harness.advance(1 / 60));
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => window.__harness.advance(0.5));
  await page.waitForFunction(() => document.querySelector('.team-drivers')?.classList.contains('on'));
  assert.equal(await page.locator('.team-join-seat.claimed').count(), 2);
  assert.equal(new Set(await page.locator('.team-driver-name').allTextContents()).size, 2);
  await page.waitForFunction(() => [...document.querySelectorAll('.team-driver-portrait, .team-driver-roster-card img')]
    .every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0));
  const portraitBox = await page.locator('.team-driver-portrait').first().boundingBox();
  assert.ok(portraitBox && portraitBox.width >= 260 && portraitBox.height >= 390
    && portraitBox.width <= 340 && portraitBox.height <= 520,
    `team portraits must use the large selection stage: ${JSON.stringify(portraitBox)}`);
  const portraitSizes = await page.locator('.team-driver-portrait').evaluateAll((images) => images.map((image) => {
    const box = image.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  assert.equal(portraitSizes.length, 2);
  assert.ok(portraitSizes.every(({ width, height }) => width >= 260 && height >= 390),
    `both team portraits must be large: ${JSON.stringify(portraitSizes)}`);
  const switchBox = await page.locator('.team-driver-nav').first().boundingBox();
  assert.ok(switchBox && switchBox.width >= 50 && switchBox.height >= 80,
    `team switch controls must match the independent selector: ${JSON.stringify(switchBox)}`);
  const readyBox = await page.locator('.team-driver-ready').first().boundingBox();
  assert.ok(readyBox && readyBox.width >= 160 && readyBox.height >= 40,
    `team lock controls must remain legible: ${JSON.stringify(readyBox)}`);
  assert.equal(await page.locator('.team-driver-roster-card').count(), 12);
  await page.screenshot({ path: path.join(root, 'shots/team-drivers-desktop.png') });

  await page.keyboard.press('Space');
  await page.evaluate(() => window.__harness.advance(1 / 60));
  await page.keyboard.press('NumpadEnter');
  await page.evaluate(() => window.__harness.advance(0.6));
  await page.waitForFunction(() => window.__harness.teamState().appMode === 'team-play');
  await page.evaluate(() => window.__harness.advance(3.4));
  let state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.phase, 'tutorial');
  assert.equal(state.tutorialActive, true);
  assert.deepEqual(state.visibleBoats, [0, 1]);

  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.__harness.advance(0.6));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.ok(state.leftSpeed > 1, `left manual throttle did not move: ${state.leftSpeed}`);
  assert.ok(Math.abs(state.rightSpeed) < 0.3, `left throttle leaked into right seat: ${state.rightSpeed}`);
  await page.keyboard.down('ArrowUp');
  await page.evaluate(() => window.__harness.advance(0.6));
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ArrowUp');
  for (const [leftKey, rightKey, seconds] of [
    ['KeyA', 'ArrowLeft', 0.7], ['KeyD', 'ArrowRight', 0.7],
  ]) {
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ArrowUp');
    await page.keyboard.down(leftKey);
    await page.keyboard.down(rightKey);
    await page.evaluate((duration) => window.__harness.advance(duration), seconds);
    await page.keyboard.up(leftKey);
    await page.keyboard.up(rightKey);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ArrowUp');
  }
  await page.keyboard.down('KeyS');
  await page.keyboard.down('ArrowDown');
  await page.evaluate(() => window.__harness.advance(2.1));
  await page.keyboard.up('KeyS');
  await page.keyboard.up('ArrowDown');
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('Numpad0');
  await page.evaluate(() => window.__harness.advance(0.45));
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('Numpad0');
  await page.evaluate(() => window.__harness.advance(2.1));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.phase, 'racing', `calibration did not reach station 1: ${JSON.stringify(state)}`);
  assert.equal(state.station, 1);
  const anchorHammerHud = (await page.locator('.team-game-hud').innerText()).replace(/\s+/g, ' ');
  assert.match(anchorHammerHud, /左 SHIFT/, 'left station must name its exact ability key');
  assert.match(anchorHammerHud, /右 SHIFT \/ K/, 'right station must name its exact ability key');

  await page.evaluate(() => {
    window.__harness.teamPlaceAtTarget('left');
    window.__harness.teamPlaceAtTarget('right');
  });
  await page.keyboard.down('ShiftLeft');
  await page.evaluate(() => window.__harness.advance(0.5));
  await page.keyboard.up('ShiftLeft');
  await page.evaluate(() => window.__harness.advance(1.6));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.match(state.objective, /核心落水/, 'miss must explain the physical failure before resetting');
  await page.evaluate(() => window.__harness.render());
  await page.screenshot({ path: path.join(root, 'shots/team-anchor-core-miss-desktop.png') });
  await page.evaluate(() => window.__harness.advance(0.9));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.beat, 1, 'missed pulse must retry the same relay beat');
  assert.ok(state.hintLevel >= 1, 'missed pulse should surface a contextual hint');

  let relayScreenshotTaken = false;
  const completeRelay = async () => {
    await page.evaluate(() => {
      window.__harness.teamPlaceAtTarget('left');
      window.__harness.teamPlaceAtTarget('right');
    });
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('ShiftRight');
    await page.evaluate(() => window.__harness.advance(0.5));
    let relayState = await page.evaluate(() => window.__harness.teamState());
    assert.equal(relayState.left.ready, true, 'left Shift should visibly charge its station role');
    assert.equal(relayState.right.ready, true, 'right Shift should visibly charge its station role');
    if (!relayScreenshotTaken) {
      await page.evaluate(() => window.__harness.render());
      await page.screenshot({ path: path.join(root, 'shots/team-anchor-hammer-ready-desktop.png') });
      relayScreenshotTaken = true;
    }
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('ShiftRight');
    await page.evaluate(() => window.__harness.advance(1.25));
  };
  for (let relay = 0; relay < 4; relay++) await completeRelay();
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.phase, 'station-transition');
  await page.evaluate(() => window.__harness.advance(1.4));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.station, 2);

  await page.evaluate(() => {
    window.__harness.teamPlaceAtTarget('left');
    window.__harness.teamPlaceAtTarget('right');
  });
  const earlyRunnerKey = state.left.role === 'runner' ? 'KeyW' : 'ArrowUp';
  await page.keyboard.down(earlyRunnerKey);
  await page.evaluate(() => window.__harness.advance(2.2));
  await page.keyboard.up(earlyRunnerKey);
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.beat, 1, `unpowered lock crossing must return the runner without scoring: ${JSON.stringify(state)}`);

  let lockScreenshotTaken = false;
  const completeLock = async () => {
    const current = await page.evaluate(() => window.__harness.teamState());
    await page.evaluate(() => {
      window.__harness.teamPlaceAtTarget('left');
      window.__harness.teamPlaceAtTarget('right');
    });
    const anchorKey = current.left.role === 'anchor' ? 'ShiftLeft' : 'Numpad0';
    const runnerKey = current.left.role === 'runner' ? 'KeyW' : 'ArrowUp';
    await page.keyboard.down(anchorKey);
    await page.evaluate(() => window.__harness.advance(0.38));
    if (!lockScreenshotTaken) {
      await page.evaluate(() => window.__harness.render());
      await page.screenshot({ path: path.join(root, 'shots/team-lock-winch-desktop.png') });
      lockScreenshotTaken = true;
    }
    await page.keyboard.down(runnerKey);
    await page.evaluate(() => window.__harness.advance(2.2));
    await page.keyboard.up(runnerKey);
    await page.keyboard.up(anchorKey);
  };
  await completeLock();
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.beat, 2, `first runner did not physically cross the raised lock: ${JSON.stringify(state)}`);
  await completeLock();
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.beat, 3, `second runner did not physically cross the raised lock: ${JSON.stringify(state)}`);
  await page.evaluate(() => {
    window.__harness.teamPlaceAtTarget('left');
    window.__harness.teamPlaceAtTarget('right');
  });
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('Numpad0');
  await page.evaluate(() => window.__harness.advance(0.68));
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('Numpad0');
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.phase, 'station-transition');
  await page.evaluate(() => window.__harness.advance(1.4));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.station, 3);
  assert.equal(state.rightRole, 'pilot');
  assert.equal(state.leftRole, 'operator');

  await page.evaluate(() => window.__harness.teamPlaceAtTarget('right'));
  await page.keyboard.down('NumpadEnter');
  await page.evaluate(() => window.__harness.advance(1 / 60));
  await page.keyboard.up('NumpadEnter');
  await page.evaluate(() => window.__harness.advance(4.5));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.station, 3);
  assert.equal(state.phase, 'racing');
  assert.equal(state.rightPhase, 'surface');
  assert.equal(state.rightCharges, 1, `locked-gate failure must restore the pilot charge: ${JSON.stringify(state)}`);

  await page.evaluate(() => {
    window.__harness.teamPlaceAtTarget('left');
    window.__harness.teamPlaceAtTarget('right');
  });
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyA');
  await page.evaluate(() => window.__harness.advance(0.65));
  await page.keyboard.up('KeyA');
  await page.evaluate(() => window.__harness.render());
  await page.screenshot({ path: path.join(root, 'shots/team-sky-console-desktop.png') });
  await page.keyboard.down('NumpadEnter');
  await page.evaluate(() => window.__harness.advance(1 / 60));
  await page.keyboard.up('NumpadEnter');
  state = await page.evaluate(() => window.__harness.teamState());
  assert.notEqual(state.rightPhase, 'surface', `powered launch edge was rejected: ${JSON.stringify(state)}`);
  await page.evaluate(() => window.__harness.advance(5.2));
  await page.keyboard.up('ShiftLeft');
  state = await page.evaluate(() => window.__harness.teamState());
  assert.notEqual(state.rightRouteState, 'failed', `powered team flight failed: ${JSON.stringify(state.guidance)}`);

  const canvas = await sampleCanvas(page);
  assert.ok(canvas.left.range > 40 && canvas.right.range > 40, `split views must be nonblank: ${JSON.stringify(canvas)}`);
  assert.ok(canvas.left.opaque > 2000 && canvas.right.opaque > 2000, `split views must be opaque: ${JSON.stringify(canvas)}`);
  await page.screenshot({ path: path.join(root, 'shots/team-split-desktop.png') });

  await page.evaluate(() => {
    window.__harness.teamPlaceAtTarget('left');
    window.__harness.teamPlaceAtTarget('right');
  });
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('Numpad0');
  await page.evaluate(() => window.__harness.advance(0.68));
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('Numpad0');
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.phase, 'finished', `dual docking did not finish: ${JSON.stringify(state)}`);
  const finalSave = await page.evaluate(() => JSON.parse(localStorage.getItem('board-race:team-expedition:v2')));
  assert.equal(finalSave.version, 2);
  assert.equal(finalSave.stage, 3);
  assert.equal(finalSave.completed, true);
  assert.equal(finalSave.tutorialCompleted, true);
  assert.ok(finalSave.bestMs > 0);
  assert.equal(await page.locator('.team-transition-replay:visible').count(), 1);

  await page.locator('.team-transition-replay').click();
  await page.evaluate(() => window.__harness.advance(3.4));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.station, 1);
  assert.equal(state.leftRole, 'receiver');
  assert.equal(state.rightRole, 'sender');

  await page.evaluate(() => window.__harness.teamFrontDoor());
  await page.locator('.team-mode-team').click();
  await page.locator('.team-save-action').filter({ hasText: '重玩驾驶校准' }).click();
  const padButton = async (pad, button) => {
    await page.evaluate(([index, target]) => window.__setTeamPadButton(index, target, true), [pad, button]);
    await page.evaluate(() => window.__harness.advance(1 / 60));
    await page.evaluate(([index, target]) => window.__setTeamPadButton(index, target, false), [pad, button]);
    await page.evaluate(() => window.__harness.advance(1 / 60));
  };
  await padButton(0, 14);
  await padButton(1, 15);
  await page.evaluate(() => window.__harness.advance(0.5));
  await page.waitForFunction(() => document.querySelector('.team-drivers')?.classList.contains('on'));
  assert.match((await page.locator('.team-driver-device').allTextContents()).join(' '), /手柄 1.*手柄 2/);
  await padButton(0, 0);
  await padButton(1, 0);
  await page.evaluate(() => window.__harness.advance(0.6));
  await page.evaluate(() => window.__harness.advance(3.4));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.phase, 'tutorial', `gamepad flow must enter calibration: ${JSON.stringify(state)}`);
  const gamepadHud = (await page.locator('.team-game-hud').innerText()).replace(/\s+/g, ' ');
  assert.match(gamepadHud, /左摇杆 ↑/, 'gamepad calibration must name the single-stick forward control');
  assert.doesNotMatch(gamepadHud, /RT|LT/, 'co-op HUD must not teach trigger movement');
  assert.equal(await page.locator('.team-hud-seat[data-input="forward"] .team-hud-input-glyph').count(), 2,
    'both gamepad seats must show a forward stick glyph during calibration');
  await page.evaluate(() => window.__harness.render());
  await page.screenshot({ path: path.join(root, 'shots/team-gamepad-calibration-desktop.png') });

  await page.evaluate(() => window.__setTeamPadAxis(0, 1, -0.78));
  await page.evaluate(() => window.__harness.advance(0.8));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.ok(state.leftSpeed > 1, `gamepad stick-up did not drive the left seat: ${state.leftSpeed}`);
  assert.ok(state.leftThrottle > 0.5, `gamepad stick-up did not produce forward throttle: ${state.leftThrottle}`);
  assert.ok(Math.abs(state.rightSpeed) < 0.3, `gamepad stick-up leaked into the right seat: ${state.rightSpeed}`);
  assert.equal(state.left.inTarget, true, `enlarged calibration target did not catch the left boat: ${JSON.stringify(state)}`);
  const speedBeforeAssist = Math.abs(state.leftSpeed);
  await page.evaluate(() => window.__setTeamPadAxis(0, 1, 0));
  await page.evaluate(() => window.__harness.advance(0.45));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.ok(Math.abs(state.leftSpeed) < Math.max(0.8, speedBeforeAssist * 0.25),
    `calibration target did not settle the released boat: ${JSON.stringify(state)}`);
  assert.match(state.left.instruction, /前进并左转/, 'turn calibration must explain the combined forward-turn input');
  assert.match(state.left.actionLabel, /左摇杆 ↖/, 'gamepad turn calibration must show a diagonal stick direction');
  assert.equal(await page.locator('.team-hud-seat.team-seat-left[data-input="diag-left"] .team-hud-input-glyph').count(), 1,
    'gamepad diagonal tutorial must move the HUD stick glyph up-left');
  await page.evaluate(() => window.__setTeamPadButton(1, 12, true));
  await page.evaluate(() => window.__harness.advance(1.2));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.ok(state.rightThrottle > 0.5, `gamepad D-pad up did not drive the right seat: ${JSON.stringify(state)}`);
  await page.evaluate(() => {
    window.__setTeamPadButton(1, 12, false);
    window.__setTeamPadAxis(0, 1, -0.72);
    window.__setTeamPadAxis(1, 1, -0.72);
    window.__setTeamPadAxis(0, 0, -1);
    window.__setTeamPadAxis(1, 0, -1);
  });
  await page.evaluate(() => window.__harness.advance(0.2));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.ok(state.leftThrottle > 0.5 && state.rightThrottle > 0.5 &&
    state.leftSteer < -0.5 && state.rightSteer < -0.5,
  `one stick diagonal input must drive and steer together: ${JSON.stringify(state)}`);
  await page.evaluate(() => window.__harness.advance(1.2));
  await page.evaluate(() => {
    window.__setTeamPadAxis(0, 0, 1);
    window.__setTeamPadAxis(1, 0, 1);
  });
  await page.evaluate(() => window.__harness.advance(1.2));
  await page.evaluate(() => {
    window.__setTeamPadAxis(0, 0, 0);
    window.__setTeamPadAxis(1, 0, 0);
    window.__setTeamPadAxis(0, 1, 0);
    window.__setTeamPadAxis(1, 1, 0);
    window.__setTeamPadButton(0, 7, true);
    window.__setTeamPadButton(1, 6, true);
  });
  await page.evaluate(() => window.__harness.advance(0.8));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.ok(Math.abs(state.leftThrottle) < 0.08 && Math.abs(state.rightThrottle) < 0.08,
    `RT/LT must not drive co-op movement: ${JSON.stringify(state)}`);
  await page.evaluate(() => {
    window.__setTeamPadButton(0, 7, false);
    window.__setTeamPadButton(1, 6, false);
    window.__setTeamPadAxis(0, 1, 0.82);
    window.__setTeamPadAxis(1, 1, 0.82);
  });
  await page.evaluate(() => window.__harness.advance(2.1));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.ok(state.leftThrottle < -0.5 && state.rightThrottle < -0.5,
    `gamepad stick-down did not brake or reverse both seats: ${JSON.stringify(state)}`);
  await page.evaluate(() => {
    window.__setTeamPadAxis(0, 1, 0);
    window.__setTeamPadAxis(1, 1, 0);
    window.__setTeamPadButton(0, 2, true);
    window.__setTeamPadButton(1, 2, true);
  });
  await page.evaluate(() => window.__harness.advance(0.45));
  await page.evaluate(() => {
    window.__setTeamPadButton(0, 2, false);
    window.__setTeamPadButton(1, 2, false);
  });
  await page.evaluate(() => window.__harness.advance(2.1));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.phase, 'racing', `gamepad calibration did not complete: ${JSON.stringify(state)}`);
  assert.deepEqual(pageErrors, [], `team flow emitted browser errors: ${pageErrors.join('\n')}`);

  console.log('team cooperation contract: OK');
  console.log(JSON.stringify({ canvas, state, finalSave }, null, 2));
  await context.close();
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
