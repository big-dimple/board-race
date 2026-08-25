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
  const portraitBox = await page.locator('.team-driver-portrait').first().boundingBox();
  assert.ok(portraitBox && portraitBox.width <= 210 && portraitBox.height <= 315,
    `team portraits must remain compact: ${JSON.stringify(portraitBox)}`);
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
    ['KeyA', 'ArrowLeft', 0.45], ['KeyD', 'ArrowRight', 0.55],
  ]) {
    await page.keyboard.down(leftKey);
    await page.keyboard.down(rightKey);
    await page.evaluate((duration) => window.__harness.advance(duration), seconds);
    await page.keyboard.up(leftKey);
    await page.keyboard.up(rightKey);
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
  await page.evaluate(() => window.__harness.advance(1.15));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.phase, 'racing', `calibration did not reach station 1: ${JSON.stringify(state)}`);
  assert.equal(state.station, 1);

  await page.evaluate(() => {
    window.__harness.teamPlaceAtTarget('left');
    window.__harness.teamPlaceAtTarget('right');
  });
  await page.keyboard.down('ShiftLeft');
  await page.evaluate(() => window.__harness.advance(0.5));
  await page.keyboard.up('ShiftLeft');
  await page.evaluate(() => window.__harness.advance(2.5));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.beat, 1, 'missed pulse must retry the same relay beat');
  assert.ok(state.hintLevel >= 1, 'missed pulse should surface a contextual hint');

  const completeRelay = async () => {
    const current = await page.evaluate(() => window.__harness.teamState());
    await page.evaluate(() => {
      window.__harness.teamPlaceAtTarget('left');
      window.__harness.teamPlaceAtTarget('right');
    });
    const senderKey = current.left.role === 'sender' ? 'ShiftLeft' : 'Numpad0';
    const receiverKey = current.left.role === 'receiver' ? 'ShiftLeft' : 'Numpad0';
    await page.keyboard.down(senderKey);
    await page.evaluate(() => window.__harness.advance(0.5));
    await page.keyboard.up(senderKey);
    await page.evaluate(() => window.__harness.advance(1.2));
    await page.keyboard.down(receiverKey);
    await page.evaluate(() => window.__harness.advance(0.35));
    await page.keyboard.up(receiverKey);
  };
  for (let relay = 0; relay < 4; relay++) await completeRelay();
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.phase, 'station-transition');
  await page.evaluate(() => window.__harness.advance(1.4));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.station, 2);

  const completeLock = async () => {
    const current = await page.evaluate(() => window.__harness.teamState());
    await page.evaluate(() => {
      window.__harness.teamPlaceAtTarget('left');
      window.__harness.teamPlaceAtTarget('right');
    });
    const anchorKey = current.left.role === 'anchor' ? 'ShiftLeft' : 'Numpad0';
    await page.keyboard.down(anchorKey);
    await page.evaluate(() => window.__harness.advance(0.55));
    await page.keyboard.up(anchorKey);
  };
  await completeLock();
  await completeLock();
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
  await page.locator('.team-save-action').filter({ hasText: '从第一站开始' }).click();
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
  await page.evaluate(() => window.__setTeamPadButton(0, 7, true, 0.72));
  await page.evaluate(() => window.__harness.advance(0.65));
  await page.evaluate(() => window.__setTeamPadButton(0, 7, false, 0));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.ok(state.leftSpeed > 1, `gamepad RT did not drive the left seat: ${state.leftSpeed}`);
  assert.ok(Math.abs(state.rightSpeed) < 0.3, `gamepad RT leaked into the right seat: ${state.rightSpeed}`);
  assert.deepEqual(pageErrors, [], `team flow emitted browser errors: ${pageErrors.join('\n')}`);

  console.log('team cooperation contract: OK');
  console.log(JSON.stringify({ canvas, state, finalSave }, null, 2));
  await context.close();
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
