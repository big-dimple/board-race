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
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let serverError = '';
server.stderr.on('data', (chunk) => { serverError += String(chunk); });

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`team Vite server exited (${server.exitCode}): ${serverError}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return;
    } catch {}
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
      id: `Board Race Test Pad ${index + 1}`,
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
    window.__setTeamPadButton = (index, button, pressed) => {
      pads[index].buttons[button].pressed = pressed;
      pads[index].buttons[button].value = pressed ? 1 : 0;
      pads[index].timestamp++;
    };
    window.__setTeamPadConnected = (index, connected) => {
      pads[index].connected = connected;
      pads[index].timestamp++;
    };
  });
  const bootPage = await context.newPage();
  await bootPage.goto(`http://127.0.0.1:${port}/?quality=performance`, { waitUntil: 'load', timeout: 60000 });
  await bootPage.locator('.team-mode.on').waitFor({ timeout: 120000 });
  assert.equal(await bootPage.locator('.team-mode-team').count(), 1,
    'desktop production boot must open the play directory');
  assert.equal(await bootPage.locator('.driver-select:visible').count(), 0,
    'desktop production boot must not bypass the play directory');
  await bootPage.close();

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/?harness=1&quality=performance`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 120000 });
  await page.evaluate(() => {
    localStorage.removeItem('board-race:team-expedition:v1');
    window.__harness.teamFrontDoor();
  });

  const modeText = (await page.locator('.team-mode').innerText()).replace(/\s+/g, ' ');
  assert.match(modeText, /独立竞技/);
  assert.match(modeText, /队伍协作/);
  assert.doesNotMatch(modeText, /单人|双人/, 'mode names must describe play contracts, not player counts');
  assert.equal(await page.locator('.team-mode-item').count(), 2, 'mode directory should expose two current entries');
  mkdirSync(path.join(root, 'shots'), { recursive: true });
  await page.evaluate(() => window.__harness.render());
  await page.screenshot({ path: path.join(root, 'shots/team-front-desktop.png') });

  await page.locator('.team-mode-team').click();
  assert.equal(await page.locator('.team-join.on').count(), 1, 'team mode must enter device seating');
  await page.keyboard.press('KeyA');
  await page.evaluate(() => window.__harness.advance(1 / 60));
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => window.__harness.advance(1 / 60));
  await page.screenshot({ path: path.join(root, 'shots/team-seating-desktop.png') });
  await page.evaluate(() => window.__harness.advance(0.5));
  await page.waitForFunction(() => document.querySelector('.team-drivers')?.classList.contains('on'));
  const claimed = await page.locator('.team-join-seat.claimed').count();
  assert.equal(claimed, 2, 'left and right keyboard zones must claim independent seats');
  const names = await page.locator('.team-driver-name').allTextContents();
  assert.equal(new Set(names).size, 2, 'the same driver may not occupy both seats');
  await page.screenshot({ path: path.join(root, 'shots/team-drivers-desktop.png') });

  await page.keyboard.press('Space');
  await page.evaluate(() => window.__harness.advance(1 / 60));
  await page.keyboard.press('KeyI');
  await page.evaluate(() => window.__harness.advance(1 / 60));
  await page.evaluate(() => window.__harness.advance(0.6));
  await page.waitForFunction(() => window.__harness.teamState().appMode === 'team-play');
  await page.evaluate(() => window.__harness.advance(3.4));
  let state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.phase, 'racing');
  assert.equal(state.leftRole, 'leader');
  assert.equal(state.rightRole, 'wing');
  assert.deepEqual(state.visibleBoats, [0, 1], 'stage 1 must keep pursuers out');

  await page.keyboard.down('KeyA');
  await page.evaluate(() => window.__harness.advance(0.25));
  state = await page.evaluate(() => window.__harness.teamState());
  await page.keyboard.up('KeyA');
  assert.ok(Math.abs(state.leftSteer) > 0.25, `left keyboard zone did not steer left seat: ${state.leftSteer}`);
  assert.ok(Math.abs(state.rightSteer) < 0.05, `left keyboard zone leaked into right seat: ${state.rightSteer}`);

  await page.keyboard.down('ShiftLeft');
  await page.evaluate(() => window.__harness.advance(7));
  await page.keyboard.up('ShiftLeft');
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.anchors, 3, 'real leader drift must activate all three wake anchors');
  assert.equal(state.link, 1, 'real wake following must fill the team link');
  assert.equal(state.relayOpen, true, 'the surface relay must open before the wing launches');
  assert.equal(state.rightCharges, 1, 'stage 1 wing must receive the linked flight charge');
  assert.equal(state.leftCharges, 0, 'leader must never receive the wing charge');
  await page.keyboard.press('KeyI');
  await page.evaluate(() => window.__harness.advance(0.3));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.notEqual(state.rightPhase, 'surface', 'right-zone flight edge must launch the right wing');
  assert.equal(state.leftPhase, 'surface', 'right-zone flight edge must not launch the left leader');

  const canvas = await sampleCanvas(page);
  assert.equal(canvas.width, 1440);
  assert.equal(canvas.height, 900);
  assert.ok(canvas.left.range > 40 && canvas.right.range > 40, `both split views must be nonblank: ${JSON.stringify(canvas)}`);
  assert.ok(canvas.left.opaque > 2000 && canvas.right.opaque > 2000, `both split views must be opaque: ${JSON.stringify(canvas)}`);
  await page.screenshot({ path: path.join(root, 'shots/team-split-desktop.png') });

  for (let attempt = 0; attempt < 32; attempt++) {
    state = await page.evaluate(() => window.__harness.teamState());
    if (state.phase === 'role-swap') break;
    await page.evaluate(() => window.__harness.advance(0.5));
  }
  state = await page.evaluate(() => window.__harness.teamState());
  assert.notEqual(state.rightRouteState, 'failed', `real stage 1 flight failed: ${JSON.stringify(state.guidance)}`);
  assert.equal(state.phase, 'role-swap', `real stage 1 did not reach the role swap: ${JSON.stringify(state)}`);
  await page.evaluate(() => window.__harness.advance(1.55));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.stage, 2);
  assert.equal(state.leftRole, 'wing');
  assert.equal(state.rightRole, 'leader');
  assert.deepEqual(state.visibleBoats, [0, 1], 'stage 2 must keep pursuers out');
  const save = await page.evaluate(() => JSON.parse(localStorage.getItem('board-race:team-expedition:v1')));
  assert.equal(save.stage, 2, 'clearing stage 1 must persist the next station');

  const partnerU = state.progress.rightU;
  await page.evaluate(() => window.__harness.teamDisplace('left'));
  await page.evaluate(() => window.__harness.advance(1.8));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.ok(state.progress.leftDistance < 20, `recovered seat remained off course: ${state.progress.leftDistance}`);
  assert.ok(state.progress.rightU > partnerU, 'personal recovery must not reset the partner to the station start');

  await page.evaluate(() => window.__harness.teamAdvanceStage());
  await page.evaluate(() => window.__harness.advance(1.55));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.stage, 3);
  assert.equal(state.activePursuers.length, 1, 'stage 3 must introduce exactly one non-ranked pursuer');
  assert.deepEqual(state.visibleBoats, [0, 1, 2]);

  const pursuersByStage = new Map([[4, 0], [5, 0], [6, 2], [7, 3]]);
  for (const [stage, pursuers] of pursuersByStage) {
    await page.evaluate(() => window.__harness.teamAdvanceStage());
    state = await page.evaluate(() => window.__harness.teamState());
    assert.equal(state.phase, 'role-swap', `stage ${stage - 1} must freeze both views for the role swap`);
    await page.evaluate(() => window.__harness.advance(1.55));
    state = await page.evaluate(() => window.__harness.teamState());
    assert.equal(state.stage, stage);
    assert.equal(state.leftRole, stage % 2 === 1 ? 'leader' : 'wing');
    assert.equal(state.rightRole, stage % 2 === 1 ? 'wing' : 'leader');
    assert.equal(state.activePursuers.length, pursuers, `stage ${stage} pursuer contract drifted`);
  }

  await page.evaluate(() => window.__harness.teamAdvanceStage());
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.phase, 'finished', 'stage 7 reunion must complete the expedition');
  const finalSave = await page.evaluate(() => JSON.parse(localStorage.getItem('board-race:team-expedition:v1')));
  assert.equal(finalSave.stage, 7);
  assert.equal(finalSave.completed, true);
  assert.ok(finalSave.bestMs > 0, `a complete seven-stage run must save a fastest time: ${JSON.stringify(finalSave)}`);
  assert.equal(await page.locator('.team-transition-action:visible').count(), 1,
    'the completed expedition must offer a return to the play directory');
  await page.keyboard.press('Space');
  await page.evaluate(() => window.__harness.advance(1 / 60));
  assert.equal(await page.locator('.team-mode.on').count(), 1,
    'either seated device must be able to leave the completed expedition');
  await page.locator('.team-mode-team').click();
  assert.equal(await page.locator('.team-save.on').count(), 1, 'completed progress must open the expedition choice');
  assert.match(await page.locator('.team-save-continue').textContent(), /重看最终会合/);
  await page.locator('.team-save-continue').click();

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
  assert.match((await page.locator('.team-driver-device').allTextContents()).join(' '), /手柄 1.*手柄 2/,
    'two standard gamepads must retain independent seat ownership');
  await padButton(0, 0);
  await padButton(1, 0);
  await page.evaluate(() => window.__harness.advance(0.6));
  await page.waitForFunction(() => window.__harness.teamState().appMode === 'team-play');
  await page.evaluate(() => window.__harness.advance(3.4));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.stage, 7, 'continue must restore the completed expedition at its final station');
  assert.equal(state.fullRun, false, 'a continued expedition must not qualify as a fresh full run');

  const pauseElapsed = state.elapsed;
  await page.evaluate(() => window.__setTeamPadButton(0, 9, true));
  await page.evaluate(() => window.__harness.advance(0.2));
  await page.evaluate(() => window.__setTeamPadButton(0, 9, false));
  await page.evaluate(() => window.__harness.advance(0.25));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.teamPaused, true, 'Start on either seated gamepad must pause both views');
  assert.equal(state.elapsed, pauseElapsed, 'team time must freeze while paused');
  assert.equal(await page.locator('.team-transition-action:visible').count(), 1,
    'the pause layer must expose a return-to-directory action');
  await padButton(1, 0);
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.teamPaused, false, 'either seated gamepad may confirm resume');

  await page.evaluate(() => window.__setTeamPadConnected(1, false));
  await page.evaluate(() => window.__harness.advance(0.25));
  state = await page.evaluate(() => window.__harness.teamState());
  const disconnectedElapsed = state.elapsed;
  assert.equal(state.teamPaused, true, 'a seated device disconnect must freeze the shared session');
  await page.evaluate(() => window.__setTeamPadConnected(1, true));
  await page.evaluate(() => window.__harness.advance(0.2));
  await page.evaluate(() => window.__setTeamPadButton(0, 0, true));
  await page.evaluate(() => window.__harness.advance(1 / 60));
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.teamPaused, false, 'reconnection plus confirmation must resume the shared session');
  assert.equal(state.elapsed, disconnectedElapsed, 'disconnect recovery must not advance expedition time');
  await page.evaluate(() => window.__setTeamPadButton(0, 0, false));
  await padButton(0, 9);
  await padButton(1, 1);
  state = await page.evaluate(() => window.__harness.teamState());
  assert.equal(state.appMode, 'front-door', 'a seated return button must exit a paused expedition');
  assert.equal(await page.locator('.team-mode.on').count(), 1, 'pause exit must restore the play directory');
  assert.deepEqual(pageErrors, [], `team flow emitted browser errors: ${pageErrors.join('\n')}`);

  console.log('team contract: OK');
  console.log(JSON.stringify({ canvas, state, save, finalSave }, null, 2));
  await context.close();
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
