import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const port = 5234;
const base = `http://127.0.0.1:${port}`;
const out = 'shots/helmet-review/validation';
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
  // Six closed helmets, one rigid style per driver, all distinct.
  const expectedStyles = {
    axle: 'round',
    tide: 'tailwing',
    sol: 'brim',
    reef: 'angular',
    kai: 'aerotail',
    jinx: 'twinfin',
  };
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

    const styles = new Set();
    const shellIds = new Set();
    for (const id of Object.keys(expectedStyles)) {
      await page.evaluate(id => window.__harness.selectDriver(id), id);
      const helmet = await page.evaluate(() => window.__harness.riderHelmetState());
      assert.equal(helmet.style, expectedStyles[id], `${label}: ${id} helmet style mismatch`);
      assert.ok(helmet.driverId === id && helmet.visible && helmet.rigid &&
        helmet.shellVertices > 0 && helmet.visorVertices > 0,
        `${label}: ${id} rigid helmet contract broken: ${JSON.stringify(helmet)}`);
      styles.add(helmet.style);
      shellIds.add(helmet.shellId);
      // Swiftshader pays one-time shader compiles for the shared helmet
      // materials on first close-up render; warm every driver before the
      // timed screenshots so the captures stay fast and deterministic.
      await page.evaluate(() => {
        window.__harness.scenario('rider-inspection-three-quarter');
        window.__harness.render();
      });
    }
    assert.equal(styles.size, 6, `${label}: helmet silhouettes must be six distinct styles`);
    assert.equal(shellIds.size, 6, `${label}: helmet shells collapsed into one geometry`);

    await page.evaluate(() => { window.__harness.scenario('opening-showcase'); window.__harness.render(); });
    // The scenario advances 1.25s into the hero beat before returning.
    assert.equal(await page.locator('.opening-driver-echo.visible').count(), 1);
    assert.equal(await page.locator('.opening-driver-echo.visible.is-player').count(), 1);
    await page.screenshot({ path: `${out}/${label}-opening.png`, timeout: 20000 });
    await page.waitForTimeout(600);
    for (let i = 0; i < 90; i++) {
      await page.evaluate(() => { window.__harness.advance(1 / 60); window.__harness.render(); });
    }
    // This view pays the last one-time swiftshader compile for the opening
    // beat; the stall is 13-25s of GPU backlog, not a hang, so give the
    // capture room instead of racing its variable drain time.
    await page.screenshot({ path: `${out}/${label}-three-quarter.png`, timeout: 60000 });
    for (const scene of ['race-straight', 'tail-drift-left']) {
      await page.evaluate(scene => { window.__harness.scenario(scene); window.__harness.render(); }, scene);
      for (let i = 0; i < 60; i++) await page.evaluate(() => { window.__harness.advance(1 / 60); window.__harness.render(); });
      await page.screenshot({ path: `${out}/${label}-${scene}.png`, timeout: 20000 });
    }
    for (const id of Object.keys(expectedStyles)) {
      await page.evaluate(id => window.__harness.selectDriver(id), id);
      for (const scene of ['rider-inspection-three-quarter', 'rider-inspection-side', 'opening-showcase']) {
        await page.evaluate(scene => { window.__harness.scenario(scene); window.__harness.render(); }, scene);
        await page.waitForTimeout(180);
        await page.evaluate(() => window.__harness.render());
        const helmet = await page.evaluate(() => window.__harness.riderHelmetState());
        assert.ok(helmet.visible && helmet.rigid, `${id}: helmet lost mid-scene: ${JSON.stringify(helmet)}`);
        await page.screenshot({ path: `${out}/${label}-${id}-${scene}.png`, timeout: 20000 });
      }
    }
    assert.deepEqual(errors, [], `${label}: browser errors`);
    await context.close();
  }
  console.log('rider diagnostic: OK');
} finally {
  await browser?.close();
  server.kill();
}
