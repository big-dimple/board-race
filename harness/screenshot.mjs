/** Lightweight deterministic screenshots and desktop/mobile smoke checks. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SHOT_PORT || 5199);
const base = `http://localhost:${port}/?harness=1`;
const chromePath = process.env.CHROME_PATH ||
  (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);

function parseArgs(argv) {
  const options = {
    mobile: false,
    tilt: false,
    verifySmoke: false,
    out: process.env.SHOT_OUT || path.join(root, 'shots'),
    settleMs: Number(process.env.SHOT_SETTLE_MS || 160),
    scenarios: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--mobile') options.mobile = true;
    else if (arg === '--tilt') options.tilt = true;
    else if (arg === '--verify-smoke') options.verifySmoke = true;
    else if (arg === '--out') options.out = path.resolve(root, argv[++index] ?? '');
    else if (arg === '--settle') options.settleMs = Number(argv[++index]);
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else options.scenarios.push(arg);
  }
  if (!Number.isFinite(options.settleMs) || options.settleMs < 0 || options.settleMs > 5000) {
    throw new Error('--settle must be between 0 and 5000 milliseconds');
  }
  return options;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`dev server did not start at ${url}`);
}

async function activateMobile(page, tilt) {
  const go = page.locator('.driver-select-go');
  if (await go.isVisible()) await go.click();
  else if (await page.locator('.mobile-start').isVisible()) await page.locator('.mobile-start').click();
  await page.waitForFunction(() => window.__harness.mobileStatus().activation === 'ready');
  if (tilt && (await page.evaluate(() => window.__harness.mobileStatus().mode)) !== 'tilt') {
    await page.locator('.mobile-mode').click();
    for (let sample = 0; sample < 8; sample++) {
      await page.evaluate(() => {
        const event = new Event('deviceorientation');
        Object.defineProperties(event, { beta: { value: 0.6 }, gamma: { value: 0.4 } });
        window.dispatchEvent(event);
      });
      await page.waitForTimeout(45);
    }
    await page.waitForFunction(() => window.__harness.mobileStatus().activation === 'ready');
  }
}

async function openHarness(browser, mobile, tilt = false) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 },
    deviceScaleFactor: mobile ? 3 : 2,
    reducedMotion: 'no-preference',
    ...(mobile ? { hasTouch: true, isMobile: true } : {}),
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`));
  await page.goto(`${base}${mobile ? '&mobile=1' : ''}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
  if (mobile) await activateMobile(page, tilt);
  return { context, page };
}

async function freezeFlightExtensionImpact(page) {
  await page.evaluate(() => window.__harness.tapFlight());
  await page.evaluate(() => {
    const copy = document.querySelector(".hud-impact[data-kind='flight-extend'].on .hud-impact-copy");
    if (!(copy instanceof HTMLElement)) throw new Error('flight extension impact did not activate');
    const computed = getComputedStyle(copy);
    copy.dataset.harnessAnimationName = computed.animationName;
    copy.dataset.harnessAnimationDuration = computed.animationDuration;
    copy.style.setProperty('animation', 'none', 'important');
    copy.style.setProperty('opacity', '1', 'important');
  });
}

async function stage(page, name, settleMs = 0, completeFlightExtension = true) {
  await page.evaluate((scenario) => window.__harness.scenario(scenario), name);
  await page.evaluate(() => window.__harness.render());
  if (name === 'flight-extension-spool' && completeFlightExtension) await freezeFlightExtensionImpact(page);
  if (settleMs > 0) await page.waitForTimeout(settleMs);
}

async function renderEvidence(page) {
  return page.evaluate(() => {
    window.__harness.render();
    const source = document.querySelector('#app > canvas');
    if (!(source instanceof HTMLCanvasElement)) return null;
    const sample = document.createElement('canvas');
    sample.width = 64;
    sample.height = 36;
    const context = sample.getContext('2d', { willReadFrequently: true });
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
    return { width: source.clientWidth, height: source.clientHeight, lumaRange: max - min, opaque };
  });
}

async function elementRect(page, selector) {
  return page.evaluate((query) => {
    const value = document.querySelector(query)?.getBoundingClientRect();
    return value && { left: value.left, right: value.right, top: value.top, bottom: value.bottom,
      width: value.width, height: value.height };
  }, selector);
}

async function elementStyle(page, selector) {
  return page.evaluate((query) => {
    const value = document.querySelector(query);
    if (!value) return null;
    const computed = getComputedStyle(value);
    return { display: computed.display, opacity: computed.opacity, visibility: computed.visibility,
      textAlign: computed.textAlign, overflow: computed.overflow, whiteSpace: computed.whiteSpace };
  }, selector);
}

function intersects(a, b, gap = 0) {
  return Boolean(a && b && a.left < b.right + gap && a.right > b.left - gap &&
    a.top < b.bottom + gap && a.bottom > b.top - gap);
}

async function verifyMode(browser, mobile) {
  const label = mobile ? 'mobile-844x390' : 'desktop-1440x900';
  let opened = await openHarness(browser, mobile);
  let { context, page } = opened;

  const callsigns = (await page.locator('.driver-card small').allTextContents())
    .map((value) => value.split(' · ')[0]);
  assert.deepEqual(callsigns, ['唐老杰', '奥特曼', '美国豆包', '杨植麟', '蓬蓬头', '梁圣梁子'],
    `${label}: driver callsigns drifted`);

  const radioOnce = await page.evaluate(() => window.__harness.radioTechniqueCase());
  assert.equal(radioOnce.masteredFresh.activeKey, 'go', `${label}: mastered fresh run did not leave GO as the only active radio`);
  assert.equal(radioOnce.masteredFresh.tipPresented, false,
    `${label}: mastered fresh run presented the technique tip anyway`);
  const activeRadio = radioOnce.activeBeforeBlock;
  assert.equal(activeRadio.activeKey, 'gemini-opening-airbrake-tip', `${label}: technique tip was not active before blocking`);
  assert.equal(activeRadio.on, true, `${label}: Gemini broadcast did not display`);
  assert.equal(activeRadio.sameAnimation, true, `${label}: technique animation was missing before blocking`);
  for (const [kind, blocked] of [
    ['presentation block', radioOnce.presentationBlocked],
    ['flight focus', radioOnce.flightFocusBlocked],
  ]) {
    assert.equal(blocked.activeKey, activeRadio.activeKey, `${label}: ${kind} replaced the active radio notice`);
    assert.equal(blocked.timer, activeRadio.timer, `${label}: ${kind} consumed radio reading time`);
    assert.equal(blocked.revision, activeRadio.revision, `${label}: ${kind} rerendered the radio notice`);
    assert.equal(blocked.on, true, `${label}: ${kind} removed the radio .on state`);
    assert.equal(blocked.blocked, true, `${label}: ${kind} did not mark the radio blocked`);
    assert.equal(blocked.paused, true, `${label}: ${kind} did not mark the radio paused`);
    assert.equal(blocked.display, 'grid', `${label}: ${kind} cancelled the radio animation with display:none`);
    assert.equal(blocked.visibility, 'hidden', `${label}: ${kind} left the blocked radio visible`);
    assert.equal(blocked.animationPlayState, 'paused', `${label}: ${kind} did not pause the radio animation`);
    assert.equal(blocked.sameAnimation, true, `${label}: ${kind} replaced the radio animation`);
  }
  assert.equal(radioOnce.resumed.activeKey, activeRadio.activeKey, `${label}: resume changed the active radio notice`);
  assert.equal(radioOnce.resumed.revision, activeRadio.revision, `${label}: resume rerendered the radio notice`);
  assert.ok(radioOnce.resumed.timer < activeRadio.timer && activeRadio.timer - radioOnce.resumed.timer < 0.02,
    `${label}: resume did not continue the remaining radio timer`);
  assert.equal(radioOnce.resumed.on, true, `${label}: resumed radio lost its .on state`);
  assert.equal(radioOnce.resumed.blocked, false, `${label}: resumed radio stayed blocked`);
  assert.equal(radioOnce.resumed.paused, false, `${label}: resumed radio stayed paused`);
  assert.equal(radioOnce.resumed.animationPlayState, 'running', `${label}: resumed radio animation did not continue`);
  assert.equal(radioOnce.resumed.sameAnimation, true, `${label}: resume restarted the radio animation`);
  assert.equal(radioOnce.resumed.visibility, 'visible', `${label}: resumed radio stayed hidden`);
  assert.equal(radioOnce.sameRunQueued, 0, `${label}: technique tip requeued in the same run`);
  assert.equal(radioOnce.secondVisible, false, `${label}: Gemini broadcast repeated in one page session`);
  assert.equal(radioOnce.secondQueued, 0, `${label}: Gemini broadcast requeued for a new run in one page session`);
  assert.equal(radioOnce.secondActiveKey, '', `${label}: Gemini broadcast restarted in a new run`);

  if (!mobile) {
    const offCourse = await page.evaluate(() => window.__harness.offCourseRecoveryCase());
    assert.ok(offCourse.distanceM > offCourse.hardEdgeM,
      `${label}: off-course case did not cross the surface hard edge: ${JSON.stringify(offCourse)}`);
    assert.deepEqual(offCourse.at14_9, { elapsedS: 14.9, phase: 'racing', warning: 'off_course' },
      `${label}: surface recovery window ended before 14.9s`);
    assert.ok(offCourse.failureAfterS >= 15 && offCourse.failureAfterS <= 15 + 1 / 60 + 1e-9,
      `${label}: off-course failure left the 15s fixed-step boundary: ${JSON.stringify(offCourse)}`);
    assert.equal(offCourse.phase, 'defeated', `${label}: sustained off-course run did not end`);
    assert.equal(offCourse.reason, 'off_course', `${label}: sustained off-course reason drifted`);
    console.log(`desktop off-course: distance=${offCourse.distanceM.toFixed(2)}m ` +
      `at14.9=${offCourse.at14_9.phase}/${offCourse.at14_9.warning} ` +
      `failedAt=${offCourse.failureAfterS.toFixed(3)}s reason=${offCourse.reason}`);
  }

  await context.close();
  opened = await openHarness(browser, mobile);
  ({ context, page } = opened);

  // The broadcast animation is the full 5.65 s slide-in/hold/slide-out
  // lifecycle, so any fixed clock offset samples a random phase of it
  // (mid-slide, or already exited off-screen). Wait until the card is
  // actually presenting inside the viewport; the assertions below still
  // decide pass/fail — a card that never presents correctly times out here
  // and fails them as before.
  await stage(page, 'radio-technique', 700);
  await page.waitForFunction(() => {
    const el = document.querySelector('.race-radio.broadcast.on');
    if (!(el instanceof HTMLElement) || el.classList.contains('blocked')) return false;
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
  }, null, { timeout: 15000 }).catch(() => {});
  const viewport = page.viewportSize();
  const radio = await elementRect(page, '.race-radio.broadcast.on');
  const radioCopy = await elementRect(page, '.race-radio-copy');
  const radioBody = await elementRect(page, '.race-radio-body');
  assert.ok(radio && radio.left >= 0 && radio.right <= viewport.width && radio.top >= 0 && radio.bottom <= viewport.height,
    `${label}: radio is outside the viewport: ${JSON.stringify(radio)}`);
  assert.ok(radioCopy && radioBody && radioBody.left >= radioCopy.left && radioBody.right <= radioCopy.right + 1 &&
    radioBody.top >= radioCopy.top && radioBody.bottom <= radioCopy.bottom + 1,
  `${label}: radio copy overflows its column`);
  const radioFlow = await page.evaluate(() => {
    const copy = document.querySelector('.race-radio-copy');
    const body = document.querySelector('.race-radio-body');
    if (!(copy instanceof HTMLElement) || !(body instanceof HTMLElement)) return null;
    return {
      copyFits: copy.scrollWidth <= copy.clientWidth + 1 && copy.scrollHeight <= copy.clientHeight + 1,
      bodyFits: body.scrollWidth <= body.clientWidth + 1 && body.scrollHeight <= body.clientHeight + 1,
    };
  });
  assert.ok(radioFlow?.copyFits && radioFlow.bodyFits, `${label}: radio text overflows: ${JSON.stringify(radioFlow)}`);
  if (mobile) {
    const radioCenter = (radio.left + radio.right) / 2;
    const copyCenterDelta = Math.abs((radioCopy.left + radioCopy.right) / 2 - radioCenter);
    const bodyCenterDelta = Math.abs((radioBody.left + radioBody.right) / 2 - radioCenter);
    const copyStyle = await elementStyle(page, '.race-radio-copy');
    const bodyStyle = await elementStyle(page, '.race-radio-body');
    assert.ok(copyCenterDelta <= 1 && bodyCenterDelta <= 1,
      `${label}: radio copy is not centered on the whole card: ${JSON.stringify({ copyCenterDelta, bodyCenterDelta })}`);
    assert.equal(copyStyle.textAlign, 'center', `${label}: radio copy text is not centered`);
    assert.equal(bodyStyle.whiteSpace, 'normal', `${label}: radio body cannot wrap naturally`);
    assert.ok(radio.right <= viewport.width * 0.42, `${label}: radio left the mobile safe lane: ${JSON.stringify(radio)}`);
    for (const selector of ['.mobile-mode', '[data-mobile-action="left"]', '[data-mobile-action="right"]',
      '[data-mobile-action="flight"]', '[data-mobile-action="drift"]']) {
      assert.equal(intersects(radio, await elementRect(page, selector), 8), false,
        `${label}: radio overlaps ${selector}`);
    }
  }

  await stage(page, 'start');
  const state = await page.evaluate(() => window.__harness.playerState());
  const render = await renderEvidence(page);
  assert.equal(state.phase, 'racing', `${label}: start did not reach racing`);
  assert.ok(render && render.width === (mobile ? 844 : 1440) && render.height === (mobile ? 390 : 900),
    `${label}: renderer does not fill the viewport: ${JSON.stringify(render)}`);
  assert.ok(render.lumaRange > 12 && render.opaque > 1800,
    `${label}: renderer appears blank: ${JSON.stringify(render)}`);
  if (!mobile) await page.locator('.hud-pc-primer.on .hud-pc-primer-close:not([hidden])').click();
  if (!mobile) await page.evaluate(() => { window.__harness.advance(1 / 60); window.__harness.render(); });

  await stage(page, 'flight-ready');
  assert.equal(await page.locator('.hud-flight-token').count(), 3, `${label}: inventory rack is not capped at three`);
  assert.equal(await page.locator('.hud-driver-stock').count(), 3, `${label}: near-boat inventory rack is not capped at three`);
  const driverPower = await elementRect(page, '.hud-driver-power.on');
  assert.ok(driverPower && (driverPower.right < viewport.width * 0.48 || driverPower.left > viewport.width * 0.52),
    `${label}: near-boat stock still covers the central rider lane: ${JSON.stringify(driverPower)}`);
  if (mobile) {
    for (const selector of ['[data-mobile-action="flight"]', '[data-mobile-action="drift"]']) {
      assert.equal(intersects(driverPower, await elementRect(page, selector), 8), false,
        `${label}: near-boat stock overlaps ${selector}`);
    }
  }

  await stage(page, 'flight-stock-full');
  const fullInventory = await page.evaluate(() => window.__harness.playerState().flightCharges);
  assert.equal(fullInventory, 3, `${label}: runtime inventory cap is not three`);

  await stage(page, 'flight-extension-spool', 280, false);
  if (!mobile) await page.waitForFunction(() => {
    const prompt = document.querySelector('.hud-flight-prompt.extend.on');
    return prompt instanceof HTMLElement && Number(getComputedStyle(prompt).opacity) > 0.5;
  });
  if (mobile) {
    const contract = await page.evaluate(() => {
      const face = document.querySelector('[data-mobile-action="flight"] span');
      const rule = face?.querySelector('small');
      if (!(face instanceof HTMLElement) || !(rule instanceof HTMLElement)) return null;
      const a = face.getBoundingClientRect();
      const b = rule.getBoundingClientRect();
      return { rule: rule.textContent?.trim() ?? '', aria: face.parentElement?.getAttribute('aria-label') ?? '',
        fits: b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom &&
          rule.scrollWidth <= rule.clientWidth + 1 && rule.scrollHeight <= rule.clientHeight + 1 };
    });
    assert.ok(contract?.fits, `${label}: mobile extension rule left or overflowed its flight control`);
    assert.match(contract?.rule ?? '', /每飞.*1\s*次/, `${label}: mobile extension limit is missing`);
    assert.match(contract?.aria ?? '', /起飞.*一次.*续航.*一次/, `${label}: mobile action detail is missing`);
  } else {
    const contract = await page.evaluate(() => {
      const prompt = document.querySelector('.hud-flight-prompt.extend.on');
      const rule = prompt?.querySelector('.hud-flight-prompt-rule');
      if (!(prompt instanceof HTMLElement) || !(rule instanceof HTMLElement)) return null;
      const style = getComputedStyle(prompt);
      return { rule: rule.textContent?.trim() ?? '', opacity: Number(style.opacity),
        visible: style.visibility === 'visible' && Number(style.opacity) > 0.5,
        fits: prompt.scrollWidth <= prompt.clientWidth + 1 && prompt.scrollHeight <= prompt.clientHeight + 1 &&
          rule.scrollWidth <= rule.clientWidth + 1 && rule.scrollHeight <= rule.clientHeight + 1 };
    });
    assert.ok(contract?.visible && contract.fits,
      `${label}: desktop extension prompt is hidden or overflows: ${JSON.stringify(contract)}`);
    assert.match(contract?.rule ?? '', /最多.*2\s*格.*起飞\s*1.*续航\s*1/,
      `${label}: desktop flight-consumption rule is missing`);
  }

  await freezeFlightExtensionImpact(page);
  await page.waitForTimeout(160);
  const impact = await elementRect(page, ".hud-impact[data-kind='flight-extend'].on .hud-impact-copy");
  const impactStyle = await elementStyle(page, ".hud-impact[data-kind='flight-extend'].on .hud-impact-copy");
  const impactContract = await page.evaluate(() => {
    const copy = document.querySelector(".hud-impact[data-kind='flight-extend'].on .hud-impact-copy");
    return copy instanceof HTMLElement ? {
      animationName: copy.dataset.harnessAnimationName ?? '',
      animationDuration: copy.dataset.harnessAnimationDuration ?? '',
      title: copy.querySelector('.hud-impact-title')?.textContent?.trim() ?? '',
    } : null;
  });
  const impactFits = await page.evaluate(() => {
    const copy = document.querySelector(".hud-impact[data-kind='flight-extend'].on .hud-impact-copy");
    return copy instanceof HTMLElement && copy.scrollWidth <= copy.clientWidth + 1 &&
      copy.scrollHeight <= copy.clientHeight + 1;
  });
  assert.ok(impact && impact.left >= 0 && impact.right <= viewport.width && impact.top >= 0 &&
    impact.bottom <= viewport.height, `${label}: flight extension feedback is outside the viewport: ${JSON.stringify(impact)}`);
  const impactCenter = impact ? (impact.left + impact.right) / 2 : 0;
  assert.ok(impact && Math.abs(impactCenter - viewport.width / 2) <= viewport.width * 0.04,
    `${label}: flight extension feedback left the central sightline: ${JSON.stringify(impact)}`);
  const impactBand = mobile
    ? impact && impact.top >= viewport.height * 0.14 && impact.bottom <= viewport.height * 0.34
    : impact && impact.top >= viewport.height * 0.18 && impact.bottom <= viewport.height * 0.34;
  assert.ok(impactBand, `${label}: flight extension feedback left its above-boat band: ${JSON.stringify(impact)}`);
  assert.equal(impactFits, true, `${label}: flight extension copy overflows its layout box`);
  if (mobile) {
    for (const selector of ['.mobile-mode', '[data-mobile-action="left"]', '[data-mobile-action="right"]',
      '[data-mobile-action="flight"]', '[data-mobile-action="drift"]']) {
      assert.equal(intersects(impact, await elementRect(page, selector), 8), false,
        `${label}: flight extension feedback overlaps ${selector}`);
    }
  }
  assert.ok(impactStyle && impactStyle.visibility === 'visible' && Number(impactStyle.opacity) > 0.5,
    `${label}: flight extension feedback is not visibly captured: ${JSON.stringify(impactStyle)}`);
  assert.deepEqual(impactContract, {
    animationName: 'hud-flight-extend-copy', animationDuration: '0.72s', title: '续航 +2.4 秒',
  }, `${label}: flight extension presentation contract drifted`);
  assert.equal((await elementStyle(page, '.hud-impact-flash')).display, 'none', `${label}: extension flash must be disabled`);
  assert.equal((await elementStyle(page, '.hud-impact-lines')).display, 'none', `${label}: extension lines must be disabled`);

  // Pressing flight again after the one allowed extension must answer with
  // the once-per-flight rule in the same card, not read as a broken button.
  await page.evaluate(() => window.__harness.setFlightCharges(2));
  await page.evaluate(() => window.__harness.tapFlight());
  await page.evaluate(() => { window.__harness.advance(0.05); window.__harness.render(); });
  const spent = await page.evaluate(() => {
    const prompt = document.querySelector('.hud-flight-prompt.spent.on');
    const rule = prompt?.querySelector('.hud-flight-prompt-rule');
    if (!(prompt instanceof HTMLElement) || !(rule instanceof HTMLElement)) return null;
    const style = getComputedStyle(prompt);
    return { rule: rule.textContent?.trim() ?? '',
      visible: style.visibility === 'visible' && Number(style.opacity) > 0.5,
      fits: prompt.scrollWidth <= prompt.clientWidth + 1 && prompt.scrollHeight <= prompt.clientHeight + 1 &&
        rule.scrollWidth <= rule.clientWidth + 1 && rule.scrollHeight <= rule.clientHeight + 1 };
  });
  assert.ok(spent?.visible && spent.fits,
    `${label}: spent flight prompt is hidden or overflows: ${JSON.stringify(spent)}`);
  assert.match(spent?.rule ?? '', /每飞限续\s*1\s*次/, `${label}: spent flight prompt lost the once-per-flight rule`);

  await stage(page, 'gate-copy', 80);
  const gateCopy = await page.evaluate(() => ({
    heading: document.querySelector('.hud-results-place')?.textContent?.trim() ?? '',
    reason: document.querySelector('.hud-results-reason')?.textContent?.trim() ?? '',
  }));
  assert.equal(gateCopy.heading, '第 1 飞 · 撞柱', `${label}: gate heading is stale`);
  assert.equal(gateCopy.reason, '撞柱 · 超出门心 1.4m', `${label}: gate evidence is stale`);

  const stats = await page.evaluate(() => window.__harness.stats());
  console.log(`${label}: calls=${stats.calls} triangles=${stats.triangles} pixels=${stats.drawingPixels} frameMs=${stats.frameMs} lumaRange=${render.lumaRange.toFixed(1)}`);
  await context.close();
}

async function capture(browser, options) {
  const names = options.scenarios.length ? options.scenarios : ['ready', 'start'];
  mkdirSync(options.out, { recursive: true });
  const { context, page } = await openHarness(browser, options.mobile, options.tilt);
  try {
    for (const name of names) {
      await stage(page, name, options.settleMs);
      const suffix = options.mobile ? (options.tilt ? '-mobile-tilt' : '-mobile') : '';
      const output = path.join(options.out, `${name}${suffix}.png`);
      await page.screenshot({ path: output });
      const stats = await page.evaluate(() => window.__harness.stats());
      console.log(`${output}: calls=${stats.calls} triangles=${stats.triangles} pixels=${stats.drawingPixels}`);
    }
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = spawn(process.execPath,
    [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', (data) => process.stderr.write(`[vite] ${data}`));
  let browser;
  try {
    await waitForServer(base);
    browser = await chromium.launch({
      headless: true,
      ...(chromePath ? { executablePath: chromePath } : {}),
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
    });
    if (options.verifySmoke) {
      await verifyMode(browser, false);
      await verifyMode(browser, true);
      console.log('smoke contract: OK');
    } else {
      await capture(browser, options);
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
