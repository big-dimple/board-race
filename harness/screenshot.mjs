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
    driver: '',
    verifySmoke: false,
    out: process.env.SHOT_OUT || path.join(root, 'shots'),
    settleMs: Number(process.env.SHOT_SETTLE_MS || 160),
    scenarios: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--mobile') options.mobile = true;
    else if (arg === '--tilt') options.tilt = true;
    else if (arg === '--driver') options.driver = argv[++index] ?? '';
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

async function openHarness(browser, mobile, tilt = false, driver = '') {
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
  if (driver) await page.evaluate((id) => window.__harness.selectDriver(id), driver);
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
  assert.deepEqual(callsigns, ['盛唐俊杰', '山姆傲慢', '美国豆包', 'KK', '打你嗷', '梁圣梁子'],
    `${label}: driver callsigns drifted`);
  assert.equal(await page.locator('.driver-select-title').textContent(), '别懵逼，选最强',
    `${label}: driver-select joke title drifted`);
  assert.equal(await page.locator('.driver-radar-title').textContent(), '选手能力对比',
    `${label}: driver radar title is ambiguous`);
  assert.equal(await page.locator('.driver-radar-note').textContent(), '影响本局手感 · 不是操作控件',
    `${label}: driver radar did not explain its role`);
  assert.equal(await page.locator('.opening-driver-echo.female').count(), 2,
    `${label}: opening showcase lost its two female competitors`);
  assert.deepEqual(await page.locator('.opening-driver-echo.female .opening-driver-echo-badge').allTextContents(),
    ['女将', '女将'], `${label}: female opening labels are not explicit`);

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

  const finaleSequence = await page.evaluate(() => window.__harness.finaleHonorSequenceCase());
  assert.equal(finaleSequence.afterFinaleShow.finaleVisible, true,
    `${label}: Final Station cinematic did not open`);
  assert.equal(finaleSequence.afterFinaleShow.honorsVisible, false,
    `${label}: honor wall mounted underneath the Final Station cinematic`);
  assert.equal(finaleSequence.afterFinaleShow.honorsDomVisible, false,
    `${label}: honor wall DOM remained visible during the cinematic`);
  assert.equal(finaleSequence.afterFinaleShow.pending, true,
    `${label}: successful result did not queue its honor review`);
  assert.equal(finaleSequence.afterFinaleShow.continueLabel, '查看高光',
    `${label}: Final Station action does not explain the next result beat`);
  assert.equal(finaleSequence.afterFinaleShow.mobileControlsHidden, true,
    `${label}: mobile controls leaked into the Final Station presentation`);
  assert.equal(finaleSequence.afterFinaleShow.hudHidden, true,
    `${label}: race HUD leaked into the Final Station presentation`);
  assert.equal(finaleSequence.afterFinaleShow.towerHidden, true,
    `${label}: race tower leaked into the Final Station presentation`);
  assert.equal(finaleSequence.afterContinue.finaleVisible, false,
    `${label}: Final Station remained visible after opening honors`);
  assert.equal(finaleSequence.afterContinue.honorsVisible, true,
    `${label}: honor wall did not open after Final Station confirmation`);
  assert.equal(finaleSequence.afterContinue.honorsDomVisible, true,
    `${label}: honor wall DOM did not become visible after confirmation`);
  assert.equal(finaleSequence.afterContinue.pending, false,
    `${label}: honor review stayed pending after opening`);
  assert.equal(finaleSequence.afterContinue.mobileControlsHidden, true,
    `${label}: mobile controls leaked into the honor review`);
  assert.equal(finaleSequence.afterContinue.hudHidden, true,
    `${label}: race HUD leaked into the honor review`);
  assert.equal(finaleSequence.afterContinue.towerHidden, true,
    `${label}: race tower leaked into the honor review`);
  assert.equal(finaleSequence.afterContinue.honorBackground, 'rgb(4, 7, 24)',
    `${label}: honor review backdrop allowed the race scene to show through`);
  assert.equal(finaleSequence.afterContinue.continueVisible, true,
    `${label}: successful honor wall did not expose the next-round action`);
  assert.equal(finaleSequence.afterContinue.continueDisabled, true,
    `${label}: next-round action became active before the high-light sequence settled`);
  assert.equal(finaleSequence.afterContinue.finalHonorCard, true,
    `${label}: final crossing honor was missing from the high-light cards`);
  assert.ok(finaleSequence.afterContinue.historyHonorScore >= 250,
    `${label}: final crossing honor was not added to historical honor score`);
  assert.equal(finaleSequence.settledBeforeContinue.continueDisabled, false,
    `${label}: next-round action stayed disabled after the high-light sequence settled`);
  assert.match(finaleSequence.settledBeforeContinue.activeAction, /honor-review-continue/,
    `${label}: settled honor wall did not focus the guided next-round action`);
  assert.equal(finaleSequence.settledBeforeContinue.layoutFits, true,
    `${label}: high-light review content overflowed its desktop/mobile frame: ${JSON.stringify(finaleSequence.settledBeforeContinue)}`);
  assert.equal(finaleSequence.afterHonorContinue.honorVisible, false,
    `${label}: honor wall remained visible after continuing to the next round`);
  assert.equal(finaleSequence.afterHonorContinue.finaleVisible, false,
    `${label}: finale overlay remained visible after continuing to the next round`);
  assert.equal(finaleSequence.afterHonorContinue.racePhase, 'resume-countdown',
    `${label}: next-round action did not enter the resume countdown`);
  assert.equal(finaleSequence.afterHonorContinue.flightsCleared, 7,
    `${label}: next-round action reset the completed flight progress`);
  console.log(`${label} finale sequence: cinematic-only -> honor-wall-only -> next-round countdown`);

  if (mobile) {
    const modeButton = page.locator('.mobile-mode');
    await modeButton.click();
    for (let sample = 0; sample < 8; sample++) {
      await page.evaluate(() => {
        const event = new Event('deviceorientation');
        Object.defineProperties(event, { beta: { value: 0.6 }, gamma: { value: 0.4 } });
        window.dispatchEvent(event);
      });
      await page.waitForTimeout(45);
    }
    await page.waitForFunction(() => window.__harness.mobileStatus().mode === 'tilt' &&
      window.__harness.mobileStatus().activation === 'ready');
    assert.equal(await modeButton.textContent(), '转向 · 体感',
      `${label}: tilt mode still uses the opaque gravity label`);
    assert.equal(await page.locator('.mobile-tilt-meter-title').textContent(), '体感转向',
      `${label}: tilt meter has no semantic title`);
    assert.equal(await page.locator('.mobile-tilt-meter').getAttribute('aria-label'),
      '体感转向：向左或向右倾斜手机，标记回中时船直行',
      `${label}: tilt meter lost its interaction description`);
    assert.deepEqual(await page.locator('.mobile-tilt-meter-left, .mobile-tilt-meter-center, .mobile-tilt-meter-right').allTextContents(),
      ['左', '回中', '右'], `${label}: tilt meter direction labels drifted`);
    await modeButton.click();
    await page.waitForFunction(() => window.__harness.mobileStatus().mode === 'touch');
  }

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

    const finalEligibility = await page.evaluate(() => window.__harness.finalEligibilityCase());
    assert.deepEqual(finalEligibility.unqualifiedFinishedIds, [],
      `${label}: an under-qualified rival crossed Final and changed the ranking: ${JSON.stringify(finalEligibility)}`);
    assert.deepEqual(finalEligibility.qualifiedFinishedIds, [0, 1],
      `${label}: a qualified rival lost its legitimate Final crossing: ${JSON.stringify(finalEligibility)}`);
    assert.deepEqual(finalEligibility.finishOrder, [1, 0],
      `${label}: Final crossing order did not use the qualified photo finish: ${JSON.stringify(finalEligibility)}`);
    assert.equal(finalEligibility.phase, 'finished', `${label}: qualified player did not finish Final`);
    assert.equal(finalEligibility.playerPlace, 2,
      `${label}: player place no longer reflects the qualified rival's earlier crossing: ${JSON.stringify(finalEligibility)}`);
    assert.equal(finalEligibility.resultPlace, 2,
      `${label}: result DTO place drifted from the Final crossing order: ${JSON.stringify(finalEligibility)}`);
    console.log(`desktop final eligibility: qualified=${finalEligibility.qualifiedFinishedIds.join(',')} ` +
      `underqualified=${finalEligibility.unqualifiedFinishedIds.length} order=${finalEligibility.finishOrder.join(',')}`);

    const singleHonors = await page.evaluate(() => window.__harness.singleHonorCase());
    assert.equal(singleHonors.mode, 'single', `${label}: single result envelope was not marked single`);
    assert.equal(singleHonors.seatCount, 1, `${label}: single result envelope gained a phantom seat`);
    assert.equal(singleHonors.wallVisible, true, `${label}: single-player honor wall did not open`);
    assert.equal(singleHonors.standingCount, 6, `${label}: single honor wall lost the six-racer standings`);
    assert.equal(singleHonors.resultPlace, 6,
      `${label}: failure result used a stale pre-failure place: ${JSON.stringify(singleHonors)}`);
    assert.ok(singleHonors.cardCount >= 2,
      `${label}: single-player honors did not retain the earned cards: ${JSON.stringify(singleHonors)}`);
    assert.equal(singleHonors.spotlight, '鸭鸭爆点',
      `${label}: single-player Play of the Run did not select the highest earned card`);
    assert.equal(singleHonors.score, 210, `${label}: single honor score did not settle through the result DTO`);
    assert.deepEqual(singleHonors.counts, { 'target.duck': 1, 'flight.ace': 1 },
      `${label}: single honor counts drifted: ${JSON.stringify(singleHonors)}`);
    assert.equal(singleHonors.awardCount, 2, `${label}: single honor awards were duplicated or dropped`);
    assert.equal(singleHonors.failureLesson.visible, true,
      `${label}: failed result skipped the focused failure review`);
    assert.match(singleHonors.failureLesson.reason, /撞柱/,
      `${label}: failure review lost its concrete failure reason`);
    assert.match(singleHonors.failureLesson.copy, /空刹|轻调|中点/,
      `${label}: failure review lost its actionable recommendation`);
    assert.equal(singleHonors.failureLesson.action, '看高光',
      `${label}: failure review action did not explain the next result beat`);
    assert.equal(singleHonors.continueVisible, false,
      `${label}: failed run incorrectly exposed the next-round action`);
    console.log(`desktop single honors: score=${singleHonors.score} cards=${singleHonors.cardCount}`);
  }

  await stage(page, 'lighthouse-inspection');
  const lighthouse = await page.evaluate(() => window.__harness.lighthouseState());
  assert.deepEqual({
    x: lighthouse.x,
    z: lighthouse.z,
    height: lighthouse.height,
    daylightBeam: lighthouse.daylightBeam,
    solidMeshes: lighthouse.solidMeshes,
    effectMeshes: lighthouse.effectMeshes,
  }, { x: 110, z: 190, height: 34, daylightBeam: false, solidMeshes: 5, effectMeshes: 1 },
  `${label}: lighthouse landmark contract drifted`);

  const flaps = await page.evaluate(() => window.__harness.flapCase());
  assert.ok(flaps.drift.commonPitch > flaps.neutral.commonPitch + 0.07,
    `${label}: drift did not visibly flare the active aero: ${JSON.stringify(flaps)}`);
  assert.ok(Math.abs(flaps.drift.differential) > 0.09,
    `${label}: drift steering did not split the two flaps: ${JSON.stringify(flaps.drift)}`);
  assert.ok(flaps.driftRelease.commonPitch < flaps.drift.commonPitch - 0.025,
    `${label}: drift release did not begin a damped return: ${JSON.stringify(flaps)}`);
  assert.ok(flaps.flightLeft.airBrake > 0.8 && flaps.flightLeft.commonPitch > 0.18,
    `${label}: real flight air-brake did not deploy the flaps: ${JSON.stringify(flaps.flightLeft)}`);
  assert.ok(Math.abs(flaps.flightLeft.differential) > 0.12 &&
    Math.abs(flaps.flightRight.differential) > 0.12 &&
    Math.sign(flaps.flightLeft.differential) === -Math.sign(flaps.flightRight.differential),
  `${label}: flight steering reversal did not reverse flap differential: ${JSON.stringify(flaps)}`);
  assert.ok(Math.abs(flaps.flightRelease.leftVelocity) + Math.abs(flaps.flightRelease.rightVelocity) > 0.15,
    `${label}: flight-brake release lost its damped motion: ${JSON.stringify(flaps.flightRelease)}`);
  assert.ok(flaps.flightSettled.airBrake < 0.02 &&
    Math.abs(flaps.flightSettled.leftPitch - flaps.flightSettled.leftTarget) < 0.035 &&
    Math.abs(flaps.flightSettled.rightPitch - flaps.flightSettled.rightTarget) < 0.035,
  `${label}: released flaps did not settle onto live trim: ${JSON.stringify(flaps.flightSettled)}`);

  await context.close();
  opened = await openHarness(browser, mobile);
  ({ context, page } = opened);

  for (const [driver, style, minimumBones] of [['tide', 'bob', 4], ['sol', 'ponytail', 6]]) {
    await page.evaluate((id) => window.__harness.selectDriver(id), driver);
    const hair = await page.evaluate(() => window.__harness.riderHairState());
    assert.equal(hair.style, style, `${label}: ${driver} hair style was overridden by the initial rider mesh`);
    assert.ok(hair.visible && hair.boneNames.length >= minimumBones,
      `${label}: ${driver} hair accessory lost its independent rig: ${JSON.stringify(hair)}`);
  }

  // Each smoke mode starts from a fresh context, so restore the baseline
  // profile after proving the two long-hair replacement paths.
  await page.evaluate(() => window.__harness.selectDriver('axle'));

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
  const pose = await page.evaluate(() => window.__harness.riderPoseState());
  for (const [side, arm] of Object.entries(pose)) {
    assert.ok(arm.handGrip <= 0.025 && arm.elbowAngle >= 0 && arm.elbowAngle <= 0.65 &&
      arm.elbowForward >= 0.14 && arm.elbowForward <= 0.36 && arm.elbowOut >= 0 && arm.elbowOut <= 0.13,
    `${label}: ${side} rider arm lost its grip/pole solve: ${JSON.stringify(pose)}`);
  }
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

  const honorTarget = await page.evaluate(() => window.__harness.honorTargetCase());
  assert.equal(honorTarget.centerHits, 2,
    `${label}: steering-wheel target did not detect a center-line pass: ${JSON.stringify(honorTarget)}`);
  assert.equal(honorTarget.boostCharges, 3,
    `${label}: precise steering-wheel pass did not preserve the full inventory on the fallback branch: ${JSON.stringify(honorTarget)}`);
  assert.equal(honorTarget.boostActive, true,
    `${label}: full steering-wheel inventory did not convert the pickup into a real BOOST: ${JSON.stringify(honorTarget)}`);
  assert.equal(honorTarget.boostHonorDelta, 280,
    `${label}: BOOST fallback did not settle the second target's base + precision honors: ${JSON.stringify(honorTarget)}`);
  assert.equal(honorTarget.edgeHits, 1,
    `${label}: a grazing steering-wheel line was not classified as edge-only: ${JSON.stringify(honorTarget)}`);
  assert.equal(honorTarget.flightCharges, 0,
    `${label}: a grazing steering-wheel line incorrectly recovered a flight cell: ${JSON.stringify(honorTarget)}`);
  console.log(`${label} steering-wheel target: center=${honorTarget.centerHits} ` +
    `boostCell=${honorTarget.boostCharges} edge=${honorTarget.edgeHits} score=${honorTarget.honorScore}`);

  await stage(page, 'flight-extension-spool', 280, false);
  const courseBuoys = await page.evaluate(() => window.__harness.buoyState());
  assert.equal(courseBuoys.length, 16,
    `${label}: only the eight authored checkpoint pairs may remain physical`);
  assert.ok(courseBuoys.every((state) => state.kind === 'checkpoint'),
    `${label}: flight navigation created a physical buoy`);
  assert.ok(courseBuoys.every((state) => state.visible),
    `${label}: a physical surface-route buoy disappeared with virtual flight guidance`);
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
    const title = copy?.querySelector('.hud-impact-title');
    return copy instanceof HTMLElement ? {
      animationName: copy.dataset.harnessAnimationName ?? '',
      animationDuration: copy.dataset.harnessAnimationDuration ?? '',
      title: title?.textContent?.trim() ?? '',
      titleSize: title instanceof HTMLElement ? getComputedStyle(title).fontSize : '',
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
  assert.deepEqual(impactContract, mobile ? {
    animationName: 'hud-flight-extend-copy', animationDuration: '0.72s', title: '续航 +2.4 秒', titleSize: '34px',
  } : {
    animationName: 'hud-impact-copy', animationDuration: '0.72s', title: '续航 +2.4 秒', titleSize: '44px',
  }, `${label}: flight extension presentation contract drifted`);
  assert.equal((await elementStyle(page, '.hud-impact-flash')).display, 'none', `${label}: extension flash must be disabled`);
  assert.equal((await elementStyle(page, '.hud-impact-lines')).display, 'none', `${label}: extension lines must be disabled`);

  // Pressing flight again after the one allowed extension must answer with
  // the once-per-flight rule in the same card, not read as a broken button.
  await page.evaluate(() => window.__harness.setFlightCharges(2));
  await page.evaluate(() => window.__harness.tapFlight());
  await page.evaluate(() => { window.__harness.advance(0.05); window.__harness.render(); });
  // The card's opacity eases in on the wall clock, not the sim clock — wait
  // for the transition instead of sampling a random phase of it.
  await page.waitForFunction(() => {
    const prompt = document.querySelector('.hud-flight-prompt.spent.on');
    return prompt instanceof HTMLElement && Number(getComputedStyle(prompt).opacity) > 0.5;
  }, null, { timeout: 5000 });
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
  const { context, page } = await openHarness(browser, options.mobile, options.tilt, options.driver);
  try {
    for (const name of names) {
      await stage(page, name, options.settleMs);
      let render = null;
      let stats = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        render = await renderEvidence(page);
        stats = await page.evaluate(() => window.__harness.stats());
        if (render && render.lumaRange > 8 && Number(stats.calls) > 0) break;
        await page.waitForTimeout(180);
      }
      assert.ok(render && render.lumaRange > 8 && Number(stats?.calls) > 0,
        `${name}: renderer remained blank after retries: ${JSON.stringify({ render, stats })}`);
      const suffix = options.mobile ? (options.tilt ? '-mobile-tilt' : '-mobile') : '';
      const output = path.join(options.out, `${name}${suffix}.png`);
      await page.screenshot({ path: output });
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
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CHOKIDAR_USEPOLLING: '1' } });
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
