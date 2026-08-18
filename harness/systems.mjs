import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SYSTEMS_PORT || 5221);
const chrome = existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const base = `http://127.0.0.1:${port}/?harness=1&quality=performance`;
const server = spawn(process.execPath, [
  path.join(root, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort',
], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('systems harness server did not start');
}

async function load(page) {
  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
}

async function replaceStorage(page, entries) {
  await page.evaluate((next) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(next)) localStorage.setItem(key, JSON.stringify(value));
  }, entries);
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
}

async function verifyPcPrimerPersistence(browser) {
  const context = await browser.newContext({ viewport: { width:1366, height:650 } });
  const page = await context.newPage();
  await load(page);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('board-race:challenge:v8', JSON.stringify({
      version:8, runs:1, ordinaryUnlocked:false, manMedalsTotal:0, excellentCount:0,
      bestQualificationTime:null, bestExcellentTime:null, bestFlights:0,
      bestRouteProgress:0, closestMissM:null, bestFlightsByDriver:{},
      farSeaDossierUnlocked:false, rivalWins:0, finaleCompletions:0,
      expansionSeenMask:0, finaleScreenshotCount:0,
      coach:{
        status:'dormant', automaticEligible:true,
        mastery:{ steered:false, bankedCharge:false, launched:false, passedRoute:false, airBrakedInTurn:false, extendedFlight:false },
        knowledge:{ bankRule:false, inventory:false, flightGauge:false, extension:false },
      },
    }));
  });
  await page.reload({ waitUntil:'load', timeout:60000 });
  await page.waitForFunction(() => window.__harness?.ready);
  await page.evaluate(() => {
    window.__harness.scenario('countdown');
    window.__harness.advance(1 / 60);
  });
  const first = await page.evaluate(() => ({
    state:window.__harness.pcPrimerState(),
    visible:document.querySelector('.hud-pc-primer')?.classList.contains('on'),
    title:document.querySelector('.hud-pc-primer-title')?.textContent,
  }));
  assert.equal(first.state.presentationStep, 'drift',
    `an incomplete run must not suppress the next Shift lesson: ${JSON.stringify(first)}`);
  assert.equal(first.visible, true, 'the primer must fit a real 1366px laptop content viewport');
  assert.match(first.title ?? '', /SHIFT.*不放/);
  await page.evaluate(() => {
    window.__harness.scenario('flight-stock-away');
    window.__harness.scenario('countdown');
    window.__harness.advance(1 / 60);
  });
  const afterBankOnly = await page.evaluate(() => ({
    state:window.__harness.pcPrimerState(),
    coach:window.__harness.coachState(),
    visible:document.querySelector('.hud-pc-primer')?.classList.contains('on'),
  }));
  assert.equal(afterBankOnly.coach.mastery.bankedCharge, true,
    `a real yellow-line release must still record action mastery: ${JSON.stringify(afterBankOnly)}`);
  assert.equal(afterBankOnly.coach.knowledge.bankRule, false,
    'banking without passing flight one must not silently acknowledge the whole primer');
  assert.equal(afterBankOnly.state.presentationStep, 'drift');
  assert.equal(afterBankOnly.visible, true,
    'the primer must return on the next fresh run until flight one is actually passed');
  await page.locator('.hud-pc-primer-close').click();
  await page.evaluate(() => window.__harness.advance(1 / 60));
  let coach = await page.evaluate(() => window.__harness.coachState());
  assert.equal(coach.mastery.bankedCharge, true,
    'dismissing after a real bank must preserve the accepted mastery edge');
  assert.equal(coach.knowledge.bankRule, true);
  assert.equal(coach.automaticEligible, true);
  await page.reload({ waitUntil:'load', timeout:60000 });
  await page.waitForFunction(() => window.__harness?.ready);
  await page.evaluate(() => {
    window.__harness.scenario('countdown');
    window.__harness.advance(1 / 60);
  });
  coach = await page.evaluate(() => window.__harness.coachState());
  assert.equal(await page.locator('.hud-pc-primer.on').count(), 0,
    'an explicitly dismissed legend must stay dismissed after reload');
  assert.equal(coach.mastery.bankedCharge, true);
  assert.equal(coach.automaticEligible, true);
  await context.close();

  const passContext = await browser.newContext({ viewport: { width:1366, height:768 } });
  const passPage = await passContext.newPage();
  await load(passPage);
  await passPage.evaluate(() => localStorage.clear());
  await passPage.reload({ waitUntil:'load', timeout:60000 });
  await passPage.waitForFunction(() => window.__harness?.ready);
  await passPage.evaluate(() => {
    window.__harness.scenario('flight-ready');
    window.__harness.advance(1.9);
  });
  const atFirstLaunch = await passPage.evaluate(() => ({
    primer:window.__harness.pcPrimerState(),
    title:document.querySelector('.hud-pc-primer-title')?.textContent ?? '',
    ordinaryPrompt:document.querySelectorAll('.hud-flight-prompt.on').length,
  }));
  assert.equal(atFirstLaunch.primer.presentationStep, 'launch',
    `the live launch cue must advance the primer before takeoff: ${JSON.stringify(atFirstLaunch)}`);
  assert.match(atFirstLaunch.title, /SPACE.*起飞/);
  assert.equal(atFirstLaunch.ordinaryPrompt, 0,
    'the first-flight primer must remain the sole owner of the launch instruction');
  await passPage.evaluate(() => {
    window.__harness.passFlight(0);
    window.__harness.scenario('countdown');
    window.__harness.advance(1 / 60);
  });
  const afterFirstPass = await passPage.evaluate(() => ({
    bestFlights:window.__harness.playerState().bestFlights,
    primer:window.__harness.pcPrimerState(),
  }));
  assert.ok(afterFirstPass.bestFlights >= 1,
    `the pass fixture must record a real first flight: ${JSON.stringify(afterFirstPass)}`);
  assert.equal(afterFirstPass.primer.active, false,
    'passing flight one must retire the fresh-run PC primer');
  assert.equal(await passPage.locator('.hud-pc-primer.on').count(), 0);
  await passContext.close();
}

async function verifyImmersiveStartContract(page) {
  await page.evaluate(() => {
    window.__immersiveProbe = { calls:0, active:false };
    Object.defineProperty(document, 'fullscreenElement', {
      configurable:true,
      get:() => window.__immersiveProbe.active ? document.documentElement : null,
    });
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable:true,
      value:() => {
        window.__immersiveProbe.calls++;
        if (window.__immersiveProbe.calls === 1) {
          return Promise.reject(new DOMException('fixture rejection', 'NotAllowedError'));
        }
        window.__immersiveProbe.active = true;
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      },
    });
  });
  await page.evaluate(() => window.__harness.scenario('ready'));
  await page.locator('.driver-switch-next').click();
  const beforeGo = await page.evaluate(() => ({
    calls:window.__immersiveProbe.calls,
    status:window.__harness.immersiveStatus(),
  }));
  assert.equal(beforeGo.calls, 0, 'driver selection must not consume the first fullscreen gesture');
  assert.equal(beforeGo.status.fullscreenGoGestures, 0);
  assert.equal(beforeGo.status.recoveryVisible, false);

  await page.locator('.driver-select-go').click();
  await page.waitForFunction(() => {
    const status = window.__harness.immersiveStatus();
    return status.fullscreenOutcome === 'rejected' && status.fullscreenFailures === 1;
  });
  const afterGo = await page.evaluate(() => ({
    calls:window.__immersiveProbe.calls,
    status:window.__harness.immersiveStatus(),
  }));
  assert.equal(afterGo.calls, 1, 'GO must make exactly one trusted fullscreen request');
  assert.equal(afterGo.status.fullscreenRequestSource, 'go');
  assert.equal(afterGo.status.fullscreenGoGestures, 1);
  assert.equal(afterGo.status.recoveryVisible, true,
    'desktop must offer recovery after a rejected GO request');

  await page.locator('.immersive-recovery-action').click();
  await page.waitForFunction(() => window.__harness.immersiveStatus().fullscreenOutcome === 'entered');
  const restored = await page.evaluate(() => ({
    calls:window.__immersiveProbe.calls,
    status:window.__harness.immersiveStatus(),
  }));
  assert.equal(restored.calls, 2, 'the recovery button must retry fullscreen from a real click');
  assert.equal(restored.status.fullscreenRequestSource, 'restore');
  assert.equal(restored.status.recoveryVisible, false);

  await page.evaluate(() => {
    window.__immersiveProbe.active = false;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await page.waitForFunction(() => window.__harness.immersiveStatus().fullscreenOutcome === 'exited');
  assert.equal(await page.locator('.immersive-recovery').isVisible(), true,
    'an unexpected desktop fullscreen exit must remain recoverable during play');
  await page.locator('.immersive-recovery-dismiss').click();
  assert.equal(await page.locator('.immersive-recovery').isVisible(), false,
    'the player must be able to dismiss the desktop recovery affordance');
  await page.evaluate(() => window.__harness.scenario('ready'));
}

async function verifyCaptureContract(browser, desktopPage) {
  await desktopPage.evaluate(() => {
    window.__captureProbe = { names:[], writes:[], closes:0, copies:0 };
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable:true,
      value:async (options) => {
        window.__captureProbe.names.push(options.suggestedName);
        return { createWritable:async () => ({
          write:async (blob) => window.__captureProbe.writes.push({ type:blob.type, size:blob.size }),
          close:async () => { window.__captureProbe.closes++; },
        }) };
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable:true,
      value:{ write:async (items) => { window.__captureProbe.copies += items.length; } },
    });
    if (typeof window.ClipboardItem === 'undefined') {
      window.ClipboardItem = class { constructor(data) { this.data = data; } };
    }
    window.__harness.scenario('countdown');
  });
  const beforePreview = await desktopPage.evaluate(() => window.__harness.playerState());
  const png = await desktopPage.evaluate(() => window.__harness.openCapturePreview('finale'));
  assert.equal(png.type, 'image/png');
  assert.ok(png.size > 10000, `capture must contain a real rendered frame: ${JSON.stringify(png)}`);
  assert.deepEqual(png.signature, [137,80,78,71,13,10,26,10]);
  await desktopPage.waitForFunction(() => {
    const image = document.querySelector('.capture-preview img');
    return image?.complete && image.naturalWidth > 0;
  });
  const desktopUi = await desktopPage.evaluate(() => ({
    visible:document.querySelector('.capture-preview')?.classList.contains('on'),
    primary:document.querySelector('.capture-preview-primary')?.textContent,
    secondary:document.querySelector('.capture-preview-secondary')?.textContent,
    returnButton:document.querySelector('.capture-preview-return')?.textContent,
    title:document.querySelector('#capture-preview-title')?.textContent,
  }));
  assert.deepEqual(desktopUi, {
    visible:true, primary:'保存 PNG', secondary:'复制图片', returnButton:'回到游戏', title:'Final 截图',
  });
  await desktopPage.evaluate(() => window.__harness.advance(1));
  const frozenPreview = await desktopPage.evaluate(() => window.__harness.playerState());
  assert.equal(frozenPreview.phase, beforePreview.phase, 'capture preview must freeze the countdown lifecycle');
  assert.equal(frozenPreview.worldTime, beforePreview.worldTime);
  await desktopPage.locator('.capture-preview-primary').click();
  await desktopPage.waitForFunction(() => document.querySelector('.capture-preview-status')?.textContent?.includes('PNG 已保存'));
  let probe = await desktopPage.evaluate(() => window.__captureProbe);
  assert.equal(probe.names[0], 'board-race-finale-contract.png');
  assert.equal(probe.writes.length, 1);
  assert.equal(probe.writes[0].type, 'image/png');
  assert.ok(probe.writes[0].size > 10000);
  assert.equal(probe.closes, 1);
  await desktopPage.locator('.capture-preview-secondary').click();
  await desktopPage.waitForFunction(() => document.querySelector('.capture-preview-status')?.textContent?.includes('剪贴板'));
  probe = await desktopPage.evaluate(() => window.__captureProbe);
  assert.equal(probe.copies, 1, 'desktop copy must use the image clipboard API');
  await desktopPage.locator('.capture-preview-close').click();

  await desktopPage.evaluate(async () => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable:true,
      value:async () => { throw new DOMException('cancelled', 'AbortError'); },
    });
    await window.__harness.openCapturePreview('medal');
  });
  await desktopPage.locator('.capture-preview-primary').click();
  await desktopPage.waitForFunction(() => document.querySelector('.capture-preview-status')?.textContent?.includes('已取消'));
  assert.equal(await desktopPage.locator('.capture-preview.on').count(), 1,
    'cancelling the picker must keep the generated preview available');
  await desktopPage.locator('.capture-preview-return').click();
  assert.equal(await desktopPage.locator('.capture-preview.on').count(), 0,
    'return to game must close the capture viewer without exporting');
  await desktopPage.evaluate(async () => window.__harness.openCapturePreview('medal'));
  await desktopPage.keyboard.press('Escape');
  await desktopPage.evaluate(() => window.__harness.advance(1 / 60));
  assert.equal(await desktopPage.locator('.capture-preview.on').count(), 0);

  const androidContext = await browser.newContext({
    viewport:{ width:844, height:390 }, hasTouch:true, isMobile:true,
    userAgent:'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
  });
  const androidPage = await androidContext.newPage();
  await load(androidPage);
  await androidPage.evaluate(() => {
    let fullscreenActive = true;
    let rejectNextFullscreen = false;
    window.__captureProbe = {
      shares:0,
      fullscreenCalls:0,
      rejectNextFullscreen:() => { rejectNextFullscreen = true; },
    };
    Object.defineProperty(document, 'fullscreenElement', {
      configurable:true,
      get:() => fullscreenActive ? document.documentElement : null,
    });
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable:true,
      value:() => {
        window.__captureProbe.fullscreenCalls++;
        if (rejectNextFullscreen) {
          rejectNextFullscreen = false;
          return Promise.reject(new DOMException('fixture rejection', 'NotAllowedError'));
        }
        fullscreenActive = true;
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      },
    });
    Object.defineProperty(navigator, 'canShare', { configurable:true, value:() => true });
    Object.defineProperty(navigator, 'share', {
      configurable:true, value:async () => {
        window.__captureProbe.shares++;
        fullscreenActive = false;
        document.dispatchEvent(new Event('fullscreenchange'));
      },
    });
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await androidPage.evaluate(() => window.__harness.openCapturePreview('finale'));
  assert.equal(await androidPage.locator('.capture-preview-primary').textContent(), '下载 PNG');
  assert.equal(await androidPage.locator('.capture-preview-secondary').textContent(), '分享');
  assert.equal(await androidPage.locator('.capture-preview-return').textContent(), '回到游戏');
  assert.match(await androidPage.locator('.capture-preview-hint').textContent() ?? '', /“下载”目录/);
  assert.equal((await androidPage.evaluate(() => window.__harness.mobileStatus())).overlayHidden, true,
    'a mobile capture preview must remove the drift/air-brake controls from its touch surface');
  const downloadPromise = androidPage.waitForEvent('download');
  await androidPage.locator('.capture-preview-primary').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'board-race-finale-contract.png');
  await androidPage.locator('.capture-preview-secondary').click();
  await androidPage.waitForFunction(() => document.querySelector('.capture-preview-status')?.textContent?.includes('系统面板'));
  assert.equal(await androidPage.evaluate(() => window.__captureProbe.shares), 1);
  assert.equal((await androidPage.evaluate(() => window.__harness.mobileStatus())).fullscreenOutcome, 'exited',
    'native share exiting fullscreen must reopen immersive eligibility');
  const fullscreenCallsBeforeClose = await androidPage.evaluate(() => window.__captureProbe.fullscreenCalls);
  await androidPage.evaluate(() => window.__captureProbe.rejectNextFullscreen());
  await androidPage.locator('.capture-preview-return').click();
  await androidPage.waitForFunction((before) => {
    const status = window.__harness.mobileStatus();
    return window.__captureProbe.fullscreenCalls === before + 1 && status.fullscreenOutcome === 'rejected';
  }, fullscreenCallsBeforeClose);
  assert.equal((await androidPage.evaluate(() => window.__harness.mobileStatus())).overlayHidden, false,
    'closing a medal/capture viewer must restore the gameplay control layer');
  await androidPage.locator('[data-mobile-action="drift"]').dispatchEvent('pointerdown', {
    pointerId:991, pointerType:'touch', isPrimary:true,
  });
  await androidPage.waitForFunction((before) => {
    const status = window.__harness.mobileStatus();
    return window.__captureProbe.fullscreenCalls === before + 2 && status.fullscreenOutcome === 'entered';
  }, fullscreenCallsBeforeClose);
  await androidPage.locator('[data-mobile-action="drift"]').dispatchEvent('pointerup', {
    pointerId:991, pointerType:'touch', isPrimary:true,
  });
  await androidContext.close();

  const iosContext = await browser.newContext({
    viewport:{ width:844, height:390 }, hasTouch:true, isMobile:true,
    userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
  });
  const iosPage = await iosContext.newPage();
  await load(iosPage);
  await iosPage.evaluate(() => {
    window.__captureProbe = { shares:0 };
    Object.defineProperty(navigator, 'canShare', { configurable:true, value:() => true });
    Object.defineProperty(navigator, 'share', {
      configurable:true, value:async () => { window.__captureProbe.shares++; },
    });
  });
  await iosPage.evaluate(() => window.__harness.openCapturePreview('medal'));
  assert.equal(await iosPage.locator('.capture-preview-primary').textContent(), '存储 / 分享');
  assert.equal(await iosPage.locator('.capture-preview-secondary').textContent(), '下载到“文件”');
  assert.equal(await iosPage.locator('.capture-preview-return').textContent(), '回到游戏');
  assert.match(await iosPage.locator('.capture-preview-hint').textContent() ?? '', /“存储图像”/);
  await iosPage.locator('.capture-preview-primary').click();
  await iosPage.waitForFunction(() => document.querySelector('.capture-preview-status')?.textContent?.includes('系统面板'));
  assert.equal(await iosPage.evaluate(() => window.__captureProbe.shares), 1);
  await iosContext.close();
}

try {
  await waitForServer();
  const browser = await chromium.launch({
    headless: true,
    ...(chrome ? { executablePath: chrome } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
  });

  await verifyPcPrimerPersistence(browser);

  const recordsContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const recordsPage = await recordsContext.newPage();
  await load(recordsPage);
  const installSurface = await recordsPage.evaluate(async () => {
    const manifestLink = document.querySelector('link[rel="manifest"]');
    if (!(manifestLink instanceof HTMLLinkElement)) throw new Error('manifest link missing');
    const manifestResponse = await fetch(manifestLink.href);
    if (!manifestResponse.ok) throw new Error(`manifest fetch failed: ${manifestResponse.status}`);
    const manifest = await manifestResponse.json();
    const imageSize = (src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
      image.onerror = () => reject(new Error(`icon decode failed: ${src}`));
      image.src = src;
    });
    const icons = await Promise.all(manifest.icons.map(async (icon) => ({
      ...icon,
      naturalSize:await imageSize(new URL(icon.src, manifestLink.href).href),
    })));
    const appleIcon = document.querySelector('link[rel="apple-touch-icon"]');
    const appleSize = appleIcon instanceof HTMLLinkElement ? await imageSize(appleIcon.href) : null;
    const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;
    const installPromotion = new Event('beforeinstallprompt', { cancelable:true });
    window.dispatchEvent(installPromotion);
    return { manifest, icons, appleSize, appleCapable:meta('apple-mobile-web-app-capable'),
      appleTitle:meta('apple-mobile-web-app-title'), appleStatus:meta('apple-mobile-web-app-status-bar-style'),
      installPromotionPrevented:installPromotion.defaultPrevented };
  });
  assert.equal(installSurface.manifest.id, './');
  assert.equal(installSurface.manifest.start_url, './');
  assert.equal(installSurface.manifest.scope, './');
  assert.equal(installSurface.manifest.display, 'standalone');
  assert.equal(installSurface.manifest.orientation, 'landscape');
  assert.equal(installSurface.manifest.short_name, '是男人就飞三次');
  assert.deepEqual(installSurface.icons.map((icon) => [icon.sizes, icon.naturalSize]), [
    ['192x192', [192, 192]],
    ['512x512', [512, 512]],
  ], 'manifest icons must resolve under the relative GitHub Pages base');
  assert.deepEqual(installSurface.appleSize, [180, 180]);
  assert.equal(installSurface.appleCapable, 'yes');
  assert.equal(installSurface.appleTitle, '是男人就飞三次');
  assert.equal(installSurface.appleStatus, 'black-translucent');
  assert.equal(installSurface.installPromotionPrevented, true,
    'Chrome install promotion must never interrupt the first game interaction');
  const freshRecords = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(freshRecords.version, 8);
  assert.equal(freshRecords.coach.status, 'dormant');
  assert.equal(freshRecords.coach.automaticEligible, true,
    'a brand-new v8 save must receive the one-time first-failure invitation');

  await verifyImmersiveStartContract(recordsPage);

  const portraits = await recordsPage.locator('.driver-card').evaluateAll((cards) => cards.map((card) => {
    const image = card.querySelector('img');
    return {
      id:card.dataset.driver,
      name:card.querySelector('strong')?.textContent,
      src:image?.currentSrc,
      width:image?.naturalWidth,
      height:image?.naturalHeight,
    };
  }));
  assert.equal(new Set(portraits.map((portrait) => portrait.id)).size, 6, 'character select must expose six adult drivers');
  assert.equal(new Set(portraits.map((portrait) => portrait.src)).size, 6, 'every local driver portrait must decode distinctly');
  assert.ok(portraits.every((portrait) => portrait.width === 640 && portrait.height === 960),
    `all portraits must use the mobile-safe 2:3 master: ${JSON.stringify(portraits)}`);
  assert.deepEqual(portraits.map((portrait) => portrait.name),
    ['GLM', 'ChatGPT', 'Gemini', 'Kimi', 'Claude', 'DeepSeek'],
    'driver names must remain the six published model identities');
  const callsigns = await recordsPage.locator('.driver-card small').allTextContents();
  assert.deepEqual(callsigns.map((text) => text.split(' · ')[0]),
    ['格莱美', '欧朋智科', '杰米奈', '月之亮面', '反人类', '浅度求和'],
    'driver cards must keep the approved Chinese joke callsigns beside the stable model names');
  assert.equal(await recordsPage.locator('.driver-card').count(), 6, 'six drivers must remain reachable');
  assert.equal(await recordsPage.locator('.driver-card:visible').count(), 6,
    'the desktop stage must expose all six stable roster destinations');
  assert.equal(await recordsPage.locator('.driver-dot').count(), 6,
    'six compact destinations must remain available to narrower carousel layouts');
  assert.equal(await recordsPage.locator('.driver-dot.selected').count(), 1);
  assert.match(await recordsPage.locator('.driver-radar-title').textContent() ?? '', /±6%/,
    'the radar must state its real physics ceiling');
  assert.match(await recordsPage.locator('.driver-radar-title').textContent() ?? '', /实机性能修正.*基准 0%/,
    'the radar must say that the values are live physics modifiers, not decoration');
  assert.match(await recordsPage.locator('.driver-radar').getAttribute('aria-label') ?? '', /加速 .+%，转向 .+%，漂移 .+%，空控 .+%/,
    'the radar must expose the four live handling modifiers');
  assert.equal(await recordsPage.locator('.driver-archive-button').count(), 0,
    'archive utilities must stay out of the selection viewport');

  const driverHandling = {
    axle: [1, 1, 1, 1.04],
    tide: [0.99, 1.01, 0.96, 1.06],
    sol: [1.05, 0.97, 1.02, 0.99],
    reef: [1.04, 1.03, 1.04, 0.98],
    kai: [1.01, 1.04, 0.99, 1.04],
    jinx: [0.98, 1.02, 1.06, 0.97],
  };
  for (const [id, expected] of Object.entries(driverHandling)) {
    await recordsPage.locator(`.driver-card[data-driver="${id}"]`).click();
    const handling = await recordsPage.evaluate(() => {
      const state = window.__harness.playerState();
      return [state.driverAcceleration, state.driverSteering, state.driverDriftCharge, state.driverAirControl];
    });
    assert.deepEqual(handling, expected, `${id} radar values must reach live Boat physics unchanged`);
    const radar = await recordsPage.locator('.driver-radar').getAttribute('aria-label') ?? '';
    for (const value of expected) {
      const percent = Math.round((value - 1) * 100);
      assert.match(radar, new RegExp(`${percent > 0 ? '\\+' : ''}${percent}%`),
        `${id} radar must print every live handling modifier: ${radar}`);
    }
  }

  await verifyCaptureContract(browser, recordsPage);

  await replaceStorage(recordsPage, {
    'board-race:challenge:v3': {
      version: 3, runs: 7, ordinaryUnlocked: true, manMedalsTotal: 4, excellentCount: 2,
      bestQualificationTime: 31.2, bestExcellentTime: 29.8, bestFlights: 5,
      bestRouteProgress: 0.45, closestMissM: 0.12,
    },
  });
  let state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.version, 8);
  assert.equal(state.runs, 7);
  assert.equal(state.manMedalsTotal, 4);
  assert.equal(state.bestFlights, 5);
  assert.equal(state.farSeaDossierUnlocked, true);
  assert.deepEqual(state.bestFlightsByDriver, {});
  assert.equal(state.finaleCompletions, 0);
  assert.equal(state.coach.status, 'expert');
  assert.equal(state.coach.automaticEligible, false);

  await replaceStorage(recordsPage, {
    'board-race:challenge:v2': {
      version: 2, runs: 5, ordinaryUnlocked: true, legacyMedals: 3, excellentCount: 2,
      bestCompleteTime: 33, bestExcellentTime: 30, bestFlightsCleared: 3,
      bestRouteProgress: 0.33, closestMissM: 0.2,
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.version, 8);
  assert.equal(state.runs, 5);
  assert.equal(state.manMedalsTotal, 3);
  assert.equal(state.bestQualificationTime, 33);
  assert.equal(state.bestFlights, 3);
  assert.equal(state.farSeaDossierUnlocked, true);
  assert.equal(state.expansionSeenMask, 0);
  assert.equal(state.coach.status, 'expert');
  assert.equal(state.coach.automaticEligible, false);

  await replaceStorage(recordsPage, {
    'board-race:challenge:v4': {
      version: 4, runs: -8, ordinaryUnlocked: 'yes', manMedalsTotal: 'bad', excellentCount: -2,
      bestQualificationTime: -1, bestExcellentTime: null, bestFlights: -4,
      bestRouteProgress: -3, closestMissM: -0.2,
      bestFlightsByDriver: { tide: 4, '../bad': 99, sol: -2 }, farSeaDossierUnlocked: false, rivalWins: -9,
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.runs, 0);
  assert.equal(state.ordinaryUnlocked, false);
  assert.equal(state.excellentCount, 0);
  assert.equal(state.bestFlights, 0);
  assert.deepEqual(state.bestFlightsByDriver, { tide: 4, sol: 0 });
  assert.equal(state.bestQualificationTime, null);
  assert.equal(state.coach.status, 'dormant');
  assert.equal(state.coach.automaticEligible, false, 'legacy saves are returning players, regardless of runs');

  await replaceStorage(recordsPage, {
    'board-race:challenge:v5': {
      version: 5, runs: 11, ordinaryUnlocked: false, manMedalsTotal: 0, excellentCount: 0,
      bestQualificationTime: null, bestExcellentTime: null, bestFlights: 1,
      bestRouteProgress: 0.2, closestMissM: null, bestFlightsByDriver: { axle: 1 },
      farSeaDossierUnlocked: false, rivalWins: 0, finaleCompletions: 0,
      expansionSeenMask: 0, finaleScreenshotCount: 0,
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.version, 8);
  assert.equal(state.coach.status, 'dormant', 'legacy non-experts wait for their next real failure');
  assert.equal(state.coach.automaticEligible, false,
    'legacy non-experts may opt in from READY but are never interrupted automatically');
  assert.equal(state.coach.mastery.bankedCharge, true, 'one passed flight proves bank, launch, and route actions');
  assert.equal(state.coach.mastery.launched, true);
  assert.equal(state.coach.mastery.passedRoute, true);
  assert.equal(state.coach.knowledge.bankRule, false,
    'a passed route proves the action, not that the player knows extra drift does not extend base flight');

  await replaceStorage(recordsPage, {
    'board-race:challenge:v7': {
      version: 7, runs: 3, ordinaryUnlocked: false, manMedalsTotal: 0, excellentCount: 0,
      bestQualificationTime: null, bestExcellentTime: null, bestFlights: 0,
      bestRouteProgress: 0, closestMissM: null, bestFlightsByDriver: {},
      farSeaDossierUnlocked: false, rivalWins: 0, finaleCompletions: 0,
      expansionSeenMask: 0, finaleScreenshotCount: 0,
      coach: {
        status: 'dormant', automaticEligible: false,
        mastery: { steered: false, bankedCharge: false, launched: false, passedRoute: false, airBrakedInTurn: false, extendedFlight: false },
        knowledge: { bankRule: false, inventory: false, flightGauge: false, extension: false },
      },
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.coach.status, 'dormant');
  assert.equal(state.coach.automaticEligible, true,
    'the shipped v7 dormant novice must receive the one-time rollout repair');

  await replaceStorage(recordsPage, {
    'board-race:challenge:v7': {
      version: 7, runs: 3, ordinaryUnlocked: false, bestFlights: 0,
      coach: {
        status: 'disabled', automaticEligible: false,
        mastery: { steered: false, bankedCharge: false, launched: false, passedRoute: false, airBrakedInTurn: false, extendedFlight: false },
        knowledge: { bankRule: false, inventory: false, flightGauge: false, extension: false },
      },
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.coach.status, 'disabled');
  assert.equal(state.coach.automaticEligible, false,
    'the rollout repair must preserve an explicit skip');

  await replaceStorage(recordsPage, {
    'board-race:challenge:v7': {
      version: 7, runs: 1, ordinaryUnlocked: false, bestFlights: 0,
      coach: {
        status: 'dormant', automaticEligible: true,
        mastery: { steered: 'yes' }, knowledge: { bankRule: true },
      },
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.coach.automaticEligible, false,
    'malformed v7 mastery cannot forge first-failure eligibility');

  await replaceStorage(recordsPage, {
    'board-race:challenge:v6': {
      version: 6, runs: 2, ordinaryUnlocked: false, manMedalsTotal: 0, excellentCount: 0,
      bestQualificationTime: null, bestExcellentTime: null, bestFlights: 0,
      bestRouteProgress: 0, closestMissM: null, bestFlightsByDriver: {},
      farSeaDossierUnlocked: false, rivalWins: 0, finaleCompletions: 0,
      expansionSeenMask: 0, finaleScreenshotCount: 0,
      coach: { status: 'hacked', mastery: { steered: 'yes', bankedCharge: true }, knowledge: { bankRule: 1 } },
    },
  });
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.coach.status, 'dormant');
  assert.equal(state.coach.automaticEligible, false, 'malformed v6 state cannot forge repair eligibility');
  assert.equal(state.coach.mastery.steered, false);
  assert.equal(state.coach.mastery.bankedCharge, true);
  assert.equal(state.coach.knowledge.bankRule, false);
  await recordsPage.evaluate(() => {
    window.__harness.setCoachEnabled(true);
    window.__harness.setCoachEnabled(false);
  });
  assert.equal((await recordsPage.evaluate(() => window.__harness.coachState())).status, 'disabled');
  await recordsPage.reload({ waitUntil: 'load', timeout: 60000 });
  await recordsPage.waitForFunction(() => window.__harness?.ready);
  assert.equal((await recordsPage.evaluate(() => window.__harness.coachState())).status, 'disabled',
    'closing contextual tips must survive reload');

  await replaceStorage(recordsPage, {});
  state = await recordsPage.evaluate(() => window.__harness.recordsCase('progress'));
  assert.equal(state.runs, 1);
  assert.equal(state.bestFlights, 4);
  assert.deepEqual(state.bestFlightsByDriver, { tide: 4 });
  assert.equal(state.manMedalsTotal, 1);
  assert.equal(state.excellentCount, 1);
  assert.equal(state.rivalWins, 1);
  assert.equal(state.farSeaDossierUnlocked, true);
  assert.equal(state.coach.status, 'expert');
  await recordsPage.reload({ waitUntil: 'load', timeout: 60000 });
  await recordsPage.waitForFunction(() => window.__harness?.ready);
  assert.deepEqual(await recordsPage.evaluate(() => window.__harness.recordsState()), state, 'v4 records must survive reload');

  await recordsPage.evaluate(() => localStorage.setItem('board-race:driver:v1', 'tide'));
  await recordsPage.reload({ waitUntil: 'load', timeout: 60000 });
  await recordsPage.waitForFunction(() => window.__harness?.ready);
  const exported = JSON.parse(await recordsPage.evaluate(() => window.__harness.recordsExport()));
  assert.equal(exported.schema, 'board-race-save');
  assert.equal(exported.selectedDriverId, 'tide');
  assert.equal(exported.records.bestFlights, 4);

  const importedDriver = await recordsPage.evaluate(() => window.__harness.recordsImport(JSON.stringify({
    schema: 'board-race-save', selectedDriverId: 'sol', records: {
      version: 4, runs: 9, ordinaryUnlocked: true, manMedalsTotal: 6, excellentCount: 3,
      bestQualificationTime: 28.4, bestExcellentTime: 27.1, bestFlights: 8,
      bestRouteProgress: 0.7, closestMissM: 0.03, bestFlightsByDriver: { sol: 8 },
      farSeaDossierUnlocked: true, rivalWins: 2,
    },
  })));
  assert.equal(importedDriver.selectedDriverId, 'sol');
  state = await recordsPage.evaluate(() => window.__harness.recordsState());
  assert.equal(state.runs, 9);
  assert.equal(state.bestFlights, 8);
  assert.equal(state.manMedalsTotal, 6);
  assert.deepEqual(state.bestFlightsByDriver, { sol: 8 });
  assert.equal((await recordsPage.evaluate(() => window.__harness.coachState())).status, 'expert',
    'an imported expert save must update the live coach, not only the serialized record');
  await recordsPage.evaluate(() => window.__harness.setCoachEnabled(true));
  assert.equal((await recordsPage.evaluate(() => window.__harness.coachState())).status, 'active',
    'an expert may explicitly reopen contextual practice from READY');
  const invalidImport = await recordsPage.evaluate(() => {
    try {
      window.__harness.recordsImport('{"schema":"wrong","records":{}}');
      return 'accepted';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  assert.match(invalidImport, /格式不正确/);

  const rival = await recordsPage.evaluate(() => window.__harness.rivalCase());
  assert.equal(rival.rivalIds.length, 2, 'exactly two elite rivals may receive director pacing');
  assert.ok(rival.chase.every((value) => value >= 1.159 && value <= 1.161), `bounded early formation chase: ${rival.chase}`);
  assert.ok(rival.chaseControls.every((control) => control.formationActive && control.surfaceTargetScale >= 1.159 &&
    control.surfaceTargetScale <= 1.161 && control.flightTargetScale >= 1 && control.flightTargetScale <= 1.0201),
  `one stable directive must own bounded surface/flight assistance: ${JSON.stringify(rival.chaseControls)}`);
  assert.ok(rival.release.every((value) => Math.abs(value - 1) < 1e-6),
    `a comfortable lead may return only to baseline, never command a slowdown: ${rival.release}`);
  assert.ok(rival.releaseControls.every((control) => control.formationActive &&
    Math.abs(control.surfaceTargetScale - 1) < 1e-6 && Math.abs(control.flightTargetScale - 1) < 1e-6),
    `formation ownership and its physical target must remain explicit: ${JSON.stringify(rival.releaseControls)}`);
  assert.ok(rival.duringLock.every((value) => value >= 1.059 && value <= 1.161),
    `battle hysteresis is a short formation floor, not a stale low-speed lock: ${rival.duringLock}`);
  assert.ok(rival.duringLockControls.every((control) => control.formationActive),
    `battle hold may not detach the physical directive: ${JSON.stringify(rival.duringLockControls)}`);
  assert.ok(rival.duringGrace.every((value) => value >= 1.059 && value <= 1.061),
    `impact grace may cap chase pressure without slowing the rival to baseline: ${rival.duringGrace}`);
  assert.ok(rival.afterGrace.every((value) => value > 1.06 && value <= 1.1601),
    `pace must recover promptly after the shorter impact grace: ${rival.afterGrace}`);
  assert.equal(rival.nonRivalPace, 1, 'non-elite racers must keep authored pace');
  assert.ok(rival.releasedControls.every((control) => !control.formationActive &&
    !control.surfaceThrottleAssist && control.surfaceTargetScale === 1 &&
    control.flightTargetScale === 1 && control.closingPressure === 0),
  `fourth-pass release must atomically neutralize every player-gap directive: ${JSON.stringify(rival.releasedControls)}`);
  assert.deepEqual(rival.playerControl, {
    surfaceTargetScale:1, flightTargetScale:1, formationActive:false,
    surfaceThrottleAssist:false, closingPressure:0,
  },
    'the player must never consume rival formation drive assistance');
  assert.ok(rival.techniqueChase[0] > 0.9,
    `the primary rival must arm a real technique attempt after the player opens a flight gap: ${rival.techniqueChase}`);
  assert.ok(rival.techniqueChase[1] >= 0.91 && rival.techniqueChase[1] <= 0.93,
    `the second protected rival must visibly chain real drift releases before flight two: ${rival.techniqueChase}`);
  assert.ok(rival.openingRuns.some((run) => run.id >= 0 && run.pressure > 0.8),
    `some seeded starts must create one opening contact opportunity: ${JSON.stringify(rival.openingRuns)}`);
  assert.ok(rival.openingRuns.some((run) => run.id < 0),
    `opening pressure must remain occasional rather than guaranteed: ${JSON.stringify(rival.openingRuns)}`);
  assert.equal(rival.pursuit.sawPursuit, true,
    `the selected opponent must physically hold drift: ${JSON.stringify(rival.pursuit)}`);
  assert.equal(rival.pursuit.sawReady, true,
    `the selected opponent must reach the real release threshold: ${JSON.stringify(rival.pursuit)}`);
  assert.equal(rival.pursuit.boostCycles, 1,
    `the selected opponent must release exactly one accepted BOOST cycle: ${JSON.stringify(rival.pursuit)}`);
  assert.equal(rival.pursuit.sawBoost, true,
    `the catch attempt must come from the real boat BOOST state: ${JSON.stringify(rival.pursuit)}`);
  const skilledBoundaries = [];
  for (const driverId of ['sol', 'jinx']) {
    // Each physical benchmark owns a fresh world. Reusing a rendered scene
    // would carry visual/wave clocks into the next driver and make collisions
    // depend on test order even though persistence is restored correctly.
    const boundaryContext = await browser.newContext({ viewport: { width:1366, height:768 } });
    const boundaryPage = await boundaryContext.newPage();
    await load(boundaryPage);
    const boundaryProbe = await boundaryPage.evaluate((id) => {
      const selectedBefore = JSON.parse(window.__harness.recordsExport()).selectedDriverId;
      const recordsBefore = window.__harness.recordsState();
      const formation = window.__harness.skilledFormationCase(id);
      const selectedAfter = JSON.parse(window.__harness.recordsExport()).selectedDriverId;
      const recordsAfter = window.__harness.recordsState();
      return { selectedBefore, selectedAfter, recordsBefore, recordsAfter, formation };
    }, driverId);
    assert.equal(boundaryProbe.selectedAfter, boundaryProbe.selectedBefore,
      'driver-boundary probes must restore the selected roster and persistence state');
    assert.deepEqual(boundaryProbe.recordsAfter, boundaryProbe.recordsBefore,
      'real flight passes inside a benchmark may not pollute records, coach state, or the next run seed');
    skilledBoundaries.push(boundaryProbe.formation);
    await boundaryContext.close();
  }
  for (const formation of skilledBoundaries) {
    const label = `${formation.driverId}/${JSON.stringify(formation.handling)}`;
    assert.equal(formation.phase, 'racing', `${label}: the continuous benchmark must reach flight four`);
    assert.equal(formation.explicitPlayerInput, true, `${label}: boat 0 may not fall through to the default AI`);
    assert.ok(formation.playerActions.driftStarts >= 12,
      `${label}: the skilled reference must continuously chain real drift holds: ${JSON.stringify(formation.playerActions)}`);
    assert.equal(formation.playerActions.driftStarts, formation.playerActions.driftReleases,
      `${label}: every scripted hold must reach its real release edge`);
    assert.equal(formation.playerActions.driftReleases, formation.playerActions.bankedReleases,
      `${label}: every release must cross the actual BANK threshold`);
    assert.equal(formation.playerActions.boostEdges, formation.playerActions.bankedReleases,
      `${label}: every player BANK release must become a real Boat BOOST rising edge`);
    assert.equal(formation.playerActions.flightEdges, 4, `${label}: Space remains a one-frame edge`);
    assert.ok(formation.playerActions.airBrakeTurnFrames > 0, `${label}: authored turns need steer plus air-brake`);
    assert.ok(formation.maxStep < 1.7, `${label}: no boat may teleport after GO: ${formation.maxStep}`);
    assert.ok(formation.projectionContinuity.every((entry) => entry.maxSurfaceDeltaU <= 0.001 &&
      entry.maxSurfaceProgressStep <= 1 && entry.resyncFrames === 0 &&
      (entry.id === 0 || entry.aiMaxSurfaceDeltaU <= 0.001)),
    `${label}: physical surface motion must keep Race and AI on one continuous course fold: ` +
      JSON.stringify(formation.projectionContinuity));
    assert.equal(formation.passes.length, 4, `${label}: ${JSON.stringify(formation.passes)}`);
    assert.ok(formation.boatBoostEdges.every((edges) => edges >= 12),
      `${label}: both protected rivals must produce repeated physical Boat BOOST edges: ${JSON.stringify(formation.boatBoostEdges)}`);
    assert.deepEqual(formation.boatBoostEdges, formation.boostCycles,
      `${label}: AI accepted releases must correspond one-for-one with real Boat BOOST starts`);
    for (const flight of [2, 3, 4]) {
      const pass = formation.passes.find((entry) => entry.flight === flight);
      assert.ok(pass?.ahead >= 2, `${label}: two protected opponents must be ahead at flight ${flight}: ${JSON.stringify(pass)}`);
      assert.ok(pass?.rivalGaps.every((gap) => gap > 0),
        `${label}: both protected progress owners must remain ahead at flight ${flight}: ${JSON.stringify(pass)}`);
      assert.ok(pass?.worldRelations.every((relation) => relation.distance <= 55 &&
        (relation.distance <= 8 || (relation.aheadMeters > 0 && relation.aheadDot >= 0.75))),
      `${label}: flight ${flight} rivals must stay readable either close alongside or in the forward chase view: ${JSON.stringify(pass)}`);
      assert.ok(pass?.controls.every((control) => flight === 4
        ? !control.formationActive && !control.surfaceThrottleAssist &&
          control.surfaceTargetScale === 1 && control.flightTargetScale === 1
        : control.formationActive && control.surfaceTargetScale >= 1 &&
          control.flightTargetScale >= 1 && control.flightTargetScale <= 1.0201),
      `${label}: flight ${flight} directive timing: ${JSON.stringify(pass)}`);
    }
    const pass4 = formation.passes.find((entry) => entry.flight === 4);
    assert.equal(pass4?.releaseSameFrame, true, `${label}: fourth pass must release assistance on the scoring frame`);
    assert.ok(formation.fourthReleaseFrame > 0, `${label}: fourth release frame must be observable`);
    assert.ok(formation.chainAfterFourth.every(Boolean),
      `${label}: both specialists must retain their authored chain-drift personality after release`);
    assert.ok(formation.rivals.every((entry) => (entry.routeStateFrames.failed ?? 0) === 0),
      `${label}: protected rivals may not lose the formation through an authored route failure: ${JSON.stringify(formation.rivals)}`);
    for (const segment of formation.segments) {
      assert.ok(segment.rivals.every((entry) => entry.pace.min >= 1),
        `${label}: formation may never command below-baseline drive in flight ${segment.flight}: ${JSON.stringify(segment)}`);
      assert.ok(segment.rivals.every((entry) => Object.values(entry.phaseFrames).reduce((sum, frames) => sum + frames, 0) > 0 &&
        Object.values(entry.routeStateFrames).reduce((sum, frames) => sum + frames, 0) > 0),
      `${label}: flight ${segment.flight} must retain phase/route timing evidence: ${JSON.stringify(segment)}`);
      if (segment.flight > 1) {
        const airBrakeDutyMax = segment.flight === 3 ? 0.85 : 0.72;
        assert.ok(segment.rivals.every((entry) => entry.flightSpeed.max > 0 &&
          entry.airBrakeDuty >= 0 && entry.airBrakeDuty <= airBrakeDutyMax),
        `${label}: flight ${segment.flight} must retain bounded air-brake/speed evidence: ${JSON.stringify(segment)}`);
      }
    }
    assert.ok(formation.timeline.length >= 20 && formation.timeline.some((sample) => sample.rivalAirBrake.some(Boolean)),
      `${label}: one-second timing samples must expose gap closing, pace and air-brake state`);
    assert.ok(formation.timeline.every((sample) => sample.gaps.every(Number.isFinite) &&
      sample.closingMps.every(Number.isFinite) && sample.pace.every(Number.isFinite) &&
      sample.closingPressure.every(Number.isFinite)), `${label}: timing telemetry must remain finite`);
    assert.ok(formation.postReleaseGapProbe.every((probe) => probe.pace.every((value) => value === 1) &&
      probe.technique.every((value) => value === 0) &&
      probe.controls.every((control) => !control.formationActive && !control.surfaceThrottleAssist &&
        control.closingPressure === 0)),
    `${label}: no post-fourth output may depend on the player gap: ${JSON.stringify(formation.postReleaseGapProbe)}`);
    assert.equal(formation.postRelease.length, 2,
      `${label}: both chain specialists need a continuous post-fourth sample`);
    for (const rival of formation.postRelease) {
      assert.ok(rival.frames >= 295 && (rival.phaseFrames.surface ?? 0) >= 60,
        `${label}: post-fourth evidence must include a sustained real water run: ${JSON.stringify(rival)}`);
      assert.equal(rival.pace.min, 1,
        `${label}: formation release must leave authored pace at baseline: ${JSON.stringify(rival)}`);
      assert.ok(rival.appliedSurfaceThrottle.frames >= 60,
        `${label}: actual surface-drive evidence must exclude the airborne landing transition: ${JSON.stringify(rival)}`);
      assert.equal(rival.appliedSurfaceThrottle.min, 0,
        `${label}: traffic may lift throttle, but a chain specialist may never command reverse braking: ${JSON.stringify(rival)}`);
      assert.equal(rival.appliedSurfaceThrottle.negativeDuty, 0,
        `${label}: post-fourth chain drift may not contain a hidden brake frame: ${JSON.stringify(rival)}`);
      assert.equal(rival.directive.formationDuty, 0,
        `${label}: no formation ownership may survive the fourth pass: ${JSON.stringify(rival)}`);
      assert.equal(rival.directive.surfaceThrottleAssistDuty, 0,
        `${label}: chain auto-throttle is AI personality, not player-gap assistance: ${JSON.stringify(rival)}`);
      assert.equal(rival.directive.closingPressureMean, 0,
        `${label}: post-fourth controls must remain independent of player distance: ${JSON.stringify(rival)}`);
    }
    assert.ok(formation.postRelease.reduce((sum, rival) => sum + rival.driftFrames, 0) > 0 &&
      formation.postRelease.reduce((sum, rival) => sum + rival.boostEdges, 0) > 0,
    `${label}: post-release sampling must still observe real chain input and a BOOST payout: ${JSON.stringify(formation.postRelease)}`);
    const battle = formation.postReleaseBattle;
    if (battle.enabled) {
      assert.equal(battle.phase, 'complete',
        `${label}: the post-fourth physical pass/repass must complete: ${JSON.stringify(battle)}`);
      assert.ok(battle.initialGap > 0 && battle.playerPass?.progressGap <= -0.75 &&
        battle.playerPass.worldDistance <= 10 && battle.playerPass.aheadMeters <= 1 &&
        battle.playerPass.playerPhase === 'surface' && battle.playerPass.rivalPhase === 'surface',
      `${label}: the player pass must be a nearby same-water crossing, not rank-only data: ${JSON.stringify(battle)}`);
      assert.ok(battle.rivalRepass?.progressGap >= 0.75 && battle.rivalRepass.worldDistance <= 12 &&
        battle.rivalRepass.aheadMeters >= 0.5 && Math.abs(battle.rivalRepass.heightDelta) <= 1.5 &&
        battle.rivalRepass.playerPhase === 'surface' && battle.rivalRepass.rivalPhase === 'surface',
      `${label}: the rival must physically return through the player's chase space: ${JSON.stringify(battle)}`);
      const visibility = battle.rivalRepass.visibility;
      assert.ok(visibility?.inView && visibility.effectivelyVisible && visibility.cameraLayer &&
        visibility.changedPixels >= 1000 && visibility.meanDelta >= 20,
      `${label}: the repassing boat must contribute real pixels, not only place/progress values: ${JSON.stringify(visibility)}`);
    } else {
      assert.equal(battle.phase, 'complete');
      assert.equal(battle.playerPass, null);
      assert.equal(battle.rivalRepass, null);
    }
  }

  const radio = await recordsPage.evaluate(() => window.__harness.radioTechniqueCase());
  assert.equal(radio.blockedVisible, false,
    'radio must yield while an actionable HUD presentation owns attention');
  assert.equal(radio.openingPendingBefore, 2,
    'a fresh GO must retain the team line and one Gemini opening line');
  assert.equal(radio.blockedPending, 2,
    'yielding must preserve both opening lines instead of dropping the technique line');
  assert.equal(radio.openingActive, true,
    'the real opening flow must eventually promote Gemini after the GO slot');
  assert.equal(radio.first.visible, true);
  assert.match(radio.first.speaker, /Gemini/);
  assert.equal(radio.first.text, '空刹压住速度，转向咬住弯心');
  assert.equal(radio.first.emphasis, '空刹压住速度');
  assert.equal(radio.first.presentation, 'broadcast');
  assert.ok(radio.first.fontSize >= 32,
    `the authored technique must be readable without staring at the race tower: ${JSON.stringify(radio.first)}`);
  assert.match(radio.first.animationName, /race-radio-broadcast/);
  assert.ok(radio.first.animationDuration >= 5.64,
    `the slide-in, hold, and slide-out must have a real reading budget: ${JSON.stringify(radio.first)}`);
  assert.ok(radio.first.width >= 640, `the desktop broadcast must own a readable center lane: ${JSON.stringify(radio.first)}`);
  assert.match(radio.first.ariaLabel, /Gemini.*空刹压住速度/);
  assert.equal(radio.timerAfterPause, radio.timerBeforePause,
    'hard gameplay presentations must pause the broadcast reading clock');
  assert.equal(radio.sameRunQueued, 0, 'the technique broadcast may appear only once in one run');
  assert.equal(radio.secondVisible, true, 'an unmastered technique may be taught again in a later run');
  assert.equal(radio.secondQueued, 0);

  const hullInteraction = await recordsPage.evaluate(() => window.__harness.hullInteractionCase());
  assert.equal(hullInteraction.enteredWake, true,
    `a fresh rival wake must produce a bounded hull response: ${JSON.stringify(hullInteraction)}`);
  assert.ok(hullInteraction.peakStrength <= 1 && hullInteraction.peakLift <= 0.42 &&
    hullInteraction.peakRoll <= 0.5,
  `wake coupling must stay inside the arcade envelope: ${JSON.stringify(hullInteraction)}`);
  assert.equal(hullInteraction.settled, true,
    `wake interaction must decay after the fresh crest passes: ${JSON.stringify(hullInteraction)}`);

  await recordsPage.evaluate(() => window.__harness.scenario('ready'));
  const cameraButton = recordsPage.locator('.audio-mixer-camera-impact');
  assert.equal(await cameraButton.textContent(), '镜头冲击 · 标准');
  await recordsPage.locator('.audio-mixer-toggle').click();
  await cameraButton.waitFor({ state:'visible' });
  await cameraButton.click();
  assert.equal(await cameraButton.textContent(), '镜头冲击 · 弱');
  await cameraButton.click();
  assert.equal(await cameraButton.textContent(), '镜头冲击 · 关');
  assert.equal(await cameraButton.getAttribute('aria-label'), '镜头冲击，当前关');
  await recordsContext.close();

  const enduranceContext = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const endurancePage = await enduranceContext.newPage();
  await load(endurancePage);
  const endurance = await endurancePage.evaluate(() => window.__harness.enduranceCase(14));
  assert.equal(endurance.phase, 'racing');
  assert.equal(endurance.flights, 14, 'two complete seven-route cycles must remain playable');
  assert.equal(endurance.routeCursor, 14);
  assert.equal(endurance.routeSlot, 0);
  assert.equal(endurance.passes, 14);
  assert.equal(endurance.medalCount, 1, 'the qualification ceremony may run only once per attempt');
  assert.equal(endurance.finite, true);
  assert.ok(endurance.maxSpeed <= 50, `endurance velocity must remain bounded: ${endurance.maxSpeed}`);
  assert.ok(endurance.visibleRoutes <= 1, `at most one route guide may survive: ${endurance.visibleRoutes}`);
  assert.equal(endurance.resetPhase, 'ready');
  assert.equal(endurance.resetFlights, 0);
  assert.equal(endurance.resetRouteCursor, 0);
  assert.equal(endurance.resetVisibleRoutes, 0);
  await enduranceContext.close();

  console.log('records, roster, rivals, and endurance contracts: OK');
  console.log(JSON.stringify({ rival, endurance }, null, 2));
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
