import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const port = 5234;
const base = `http://127.0.0.1:${port}`;
const out = 'shots/tide-stage1/validation';
mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'], {
  stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CHOKIDAR_USEPOLLING: '1' },
});
server.stderr.on('data', (value) => process.stderr.write(value));
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop';
    const viewport = mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 };
    const context = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`${base}/?harness=1${mobile ? '&mobile=1' : ''}`);
    await page.waitForFunction(() => window.__harness?.ready);
    const physics = await page.evaluate(async () => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const { TideHead } = await import('/src/game/tideHead.ts');
      function run(fps, wind, rotation = 0) {
        const head = new THREE.Bone();
        const chest = new THREE.Bone();
        chest.add(head);
        head.rotation.z = rotation;
        const hair = new TideHead(head, chest);
        const velocity = new THREE.Vector3(0, 0, wind);
        for (let i = 0; i < fps * 3; i++) hair.update(1 / fps, velocity, i / fps);
        const state = hair.debug();
        const before = JSON.stringify(state.rotations);
        hair.update(0, velocity, 100);
        const frozen = before === JSON.stringify(hair.debug().rotations);
        hair.collectLanding(10);
        hair.update(1 / fps, velocity, 3);
        const consumed = hair.debug().pendingLanding === 0;
        hair.reset();
        head.position.x += 100;
        hair.update(1 / fps, velocity, 4);
        const finite = hair.debug().rotations.flat().every(Number.isFinite);
        hair.dispose();
        return { ...state, frozen, consumed, finite };
      }
      return { rest: run(60, 0), wind: run(60, 30), slow: run(30, 30), tilted: run(60, 0, .5) };
    });
    const distance = (a, b) => Math.sqrt(a.rotations.flat().reduce((sum, x, i) => sum + (x - b.rotations.flat()[i]) ** 2, 0));
    assert.ok(distance(physics.rest, physics.wind) > .02, 'airspeed must visibly change hair pose');
    assert.ok(distance(physics.rest, physics.tilted) > .01, 'world gravity must react to head tilt');
    assert.ok(distance(physics.wind, physics.slow) < .08, '30fps and 60fps hair must remain consistent');
    for (const value of Object.values(physics)) assert.ok(value.frozen && value.consumed && value.finite);
    console.log(label, 'spring response', { wind: distance(physics.rest, physics.wind), fpsDelta: distance(physics.wind, physics.slow) });
    for (const id of ['tide', 'sol', 'tide', 'axle', 'tide']) {
      await page.evaluate(id => window.__harness.selectDriver(id), id);
      const asset = await page.evaluate(() => window.__harness.riderAssetState());
      assert.equal(asset.source, id === 'tide' ? 'tide.glb' : 'procedural');
    }
    if (mobile) await page.locator('.driver-select-go').click();
    await page.evaluate(() => { window.__harness.scenario('opening-showcase'); window.__harness.render(); });
    assert.equal(await page.locator('.opening-driver-echo.visible').count(), 0);
    await page.screenshot({ path: `${out}/${label}-opening.png`, timeout: 8000, animations: 'disabled' });
    await page.waitForTimeout(600);
    for (let i = 0; i < 90; i++) {
      await page.evaluate(() => { window.__harness.advance(1 / 60); window.__harness.render(); });
    }
    await page.screenshot({ path: `${out}/${label}-three-quarter.png`, timeout: 8000, animations: 'disabled' });
    for (const scene of ['race-straight', 'tail-drift-left']) {
      await page.evaluate(scene => { window.__harness.scenario(scene); window.__harness.render(); }, scene);
      for (let i = 0; i < 60; i++) await page.evaluate(() => { window.__harness.advance(1 / 60); window.__harness.render(); });
      await page.screenshot({ path: `${out}/${label}-${scene}.png`, timeout: 8000, animations: 'disabled' });
    }
    assert.deepEqual(errors, [], `${label}: browser errors`);
    await context.close();
  }
  console.log('rider diagnostic: OK');
} finally {
  await browser?.close();
  server.kill();
}
