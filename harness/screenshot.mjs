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
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SHOT_PORT || 5199);
const BASE = `http://localhost:${PORT}/?harness=1`;
const OUT = path.join(root, 'shots');

// name → harness scenario call (+ optional freeCam before render)
const SCENARIOS = {
  countdown: { scenario: 'countdown' },
  start: { scenario: 'start' },
  sweeper: { scenario: 'sweeper' },
  chicane: { scenario: 'chicane' },
  hairpin: { scenario: 'hairpin' },
  airtime: { scenario: 'airtime' },
  finish: { scenario: 'finish', timeout: 180000, settleMs: 800 },
  // settleMs: let the wall-clock CSS panel-in animation finish before capture
  results: { scenario: 'results', timeout: 180000, settleMs: 800 },
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

async function main() {
  const args = process.argv.slice(2);
  const wantStats = args.includes('--stats');
  const names = args.filter((a) => !a.startsWith('--'));
  const selected = names.length ? names : Object.keys(SCENARIOS);

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
      args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') console.error(`[console.${msg.type()}] ${msg.text()}`);
    });

    await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });

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
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      if (wantStats) console.log(JSON.stringify(await page.evaluate(() => window.__harness.stats())));
      console.log(`  -> shots/${name}.png`);
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
