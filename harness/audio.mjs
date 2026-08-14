import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.AUDIO_PORT || 5216);
const chrome = existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const server = spawn(process.execPath, [
  path.join(root, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort',
], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverError = '';
server.stderr.on('data', (chunk) => { serverError += String(chunk); });

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(`audio Vite server exited (${server.exitCode}): ${serverError}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`audio Vite server was not ready on ${port}: ${serverError}`);
}

async function advanceWithWallClock(page, seconds, step = 0.1) {
  let elapsed = 0;
  while (elapsed < seconds) {
    const dt = Math.min(step, seconds - elapsed);
    await page.evaluate((amount) => window.__harness.advance(amount), dt);
    await page.waitForTimeout(dt * 1000);
    elapsed += dt;
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({
    headless: true,
    ...(chrome ? { executablePath: chrome } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/?harness=1&quality=performance`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
  await page.locator('.audio-mixer-toggle').click();
  await page.waitForFunction(() => window.__harness.audioState().contextState === 'running');
  await page.waitForFunction(() => window.__harness.audioState().countdownVoiceReady === true ||
    window.__harness.audioState().countdownVoiceFailed === true, null, { timeout: 5000 });
  await page.waitForTimeout(180);
  let state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(state.scene, 'ready');
  assert.equal(state.scoreArmed, false, 'READY gestures must not arm the race score');
  assert.equal(state.readyMusicActive, true, 'the first READY gesture must arm the selection score');
  assert.equal(state.musicPlaying, true, 'character select must carry the score after the gesture');
  assert.ok(Number(state.musicBusGain) > 0.01, `READY music bus must open after the gesture: ${state.musicBusGain}`);
  assert.ok(Number(state.ambience) <= 0.12, `phone-safe ambience default must stay restrained: ${state.ambience}`);
  assert.ok(Number(state.sfx) <= 0.7, `phone-safe SFX default must leave limiter headroom: ${state.sfx}`);
  assert.ok(Number(state.safetyHighpassHz) >= 48, `sub-bass protection must stay enabled: ${state.safetyHighpassHz}`);
  assert.ok(Number(state.limiterThresholdDb) <= -12 && Number(state.limiterRatio) >= 12,
    `the phone output limiter must stay protective: ${state.limiterThresholdDb}dB/${state.limiterRatio}:1`);
  assert.equal(state.countdownVoiceFailed, false, 'both local GO announcers must decode');
  assert.equal(state.countdownVoiceReady, true);
  assert.ok(['ogg', 'mp3'].includes(String(state.countdownVoiceFormat)),
    `GO announcers need a browser-selected local compatibility format: ${state.countdownVoiceFormat}`);

  // The mixer controls the same persistent READY score; it must not turn the
  // selection screen back into a one-shot audition.
  const musicSlider = page.getByLabel('摇滚');
  await musicSlider.fill('72');
  await musicSlider.dispatchEvent('input');
  await page.waitForFunction(() => window.__harness.audioState().musicPlaying === true, null, { timeout: 5000 });
  const t0 = Number((await page.evaluate(() => window.__harness.audioState())).musicTime);
  await page.waitForFunction((start) => Number(window.__harness.audioState().musicTime) > start + 0.15, t0, { timeout: 5000 });
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.musicTime) > t0 + 0.15, `formal score must advance: ${t0} -> ${state.musicTime}`);
  assert.equal(state.musicFailed, false);
  assert.equal(state.readyMusicActive, true);
  await page.waitForTimeout(1250);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(state.musicPlaying, true, 'READY score must stay present while choosing a driver');
  assert.ok(Number(state.musicBusGain) > 0.01, 'READY score must keep its bus open');

  const sliders = {
    master: ['总音量', 'outputGain'],
    music: ['摇滚', 'musicBusGain'],
    sfx: ['音效', 'eventBusGain'],
    ambience: ['水 / 空气', 'ambienceBusGain'],
  };
  for (const [key, [label, gainKey]] of Object.entries(sliders)) {
    const slider = page.getByLabel(label);
    const before = await page.evaluate(() => window.__harness.audioState());
    await slider.fill('0');
    await slider.dispatchEvent('input');
    await page.waitForTimeout(key === 'ambience' && Number(await slider.inputValue()) > 0 ? 120 : 350);
    state = await page.evaluate(() => window.__harness.audioState());
    assert.ok(Number(state[gainKey]) < 0.008, `${key} 0% must silence ${gainKey}: ${state[gainKey]}`);
    const output = await slider.evaluate((el) => el.parentElement.querySelector('output').textContent);
    assert.equal(output, '0%', `${key} must expose a visible percentage`);
    await slider.fill('100');
    await slider.dispatchEvent('input');
    await page.waitForTimeout(key === 'ambience' ? 120 : 350);
    state = await page.evaluate(() => window.__harness.audioState());
    assert.ok(Number(state[gainKey]) > 0.08, `${key} 100% must restore ${gainKey}: ${state[gainKey]}`);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('board-race.audio.v1')));
    assert.equal(saved[key], 1, `${key} must persist independently`);
    if (key !== 'music') assert.equal(state.scoreArmed, false, `${key} preview must not arm the race score`);
    void before;
  }

  // GO owns the score. The countdown starts filtered and quiet, then opens one
  // layer per number before the racing mix continues its longer flow ramp.
  await page.evaluate(() => window.__harness.scenario('countdown'));
  await page.waitForTimeout(180);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(state.scene, 'countdown');
  assert.equal(state.scoreArmed, true);
  assert.equal(state.musicPlaying, true);
  assert.equal(state.countdownStage, 2);
  const firstAnnouncer = state.countdownVoice;
  const voiceEventsBeforeGo = Number(state.countdownVoiceEvents);
  assert.equal(voiceEventsBeforeGo, 0, '3/2/1 must remain visual lights and ticks, without speech');
  assert.ok(Number(state.musicTime) >= t0, 'GO must continue the same media timeline from READY');
  assert.equal(state.musicLoop, true, 'the media element must loop only after the complete song');
  assert.ok(Number(state.musicDuration) > 120, `the complete selected song must be loaded: ${state.musicDuration}`);
  assert.ok(Number(state.musicFilterHz) < 3000, `countdown must keep the score filtered: ${state.musicFilterHz}`);
  assert.ok(Number(state.musicBusGain) > 0.01 && Number(state.musicBusGain) < 0.5,
    `countdown score must be audible but restrained: ${state.musicBusGain}`);
  await page.evaluate(() => window.__harness.advance(2.7));
  await page.waitForTimeout(220);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(state.scene, 'racing');
  assert.equal(Number(state.countdownVoiceEvents), voiceEventsBeforeGo + 1,
    'GO must play exactly one announcer, never a stacked male/female call');
  assert.ok(Number(state.announcementBusGain) > Number(state.eventBusGain),
    `GO speech must own dedicated headroom above generic events: ${JSON.stringify(state)}`);
  assert.ok(Number(state.goImpactDelay) >= 0.28 && Number(state.goImpactDelay) <= 0.46,
    `the impact must follow the decoded clip tail, not a fixed early timer: ${state.goImpactDelay}`);
  assert.ok(Number(state.musicDuck) <= 0.25,
    `the score must clear space while the GO word is active: ${state.musicDuck}`);
  assert.ok(Number(state.musicFilterHz) > 4200, `GO must start opening the score: ${state.musicFilterHz}`);
  await page.waitForTimeout(650);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.musicFilterHz) > 9000, `the score must finish opening after GO: ${state.musicFilterHz}`);
  const openingGain = Number(state.musicBusGain);
  await page.evaluate(() => window.__harness.advance(8));
  await page.waitForTimeout(500);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.musicBusGain) > openingGain, `racing score must build gradually: ${openingGain} -> ${state.musicBusGain}`);

  // Starting a later run may change the mix for 3/2/1, but must preserve the
  // same browser-session media timeline instead of seeking to an intro point.
  const beforeNextRun = Number(state.musicTime);
  await page.evaluate(() => window.__harness.scenario('countdown'));
  await page.waitForTimeout(220);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.notEqual(state.countdownVoice, firstAnnouncer, 'the next fresh run must alternate the GO announcer');
  assert.equal(Number(state.countdownVoiceEvents), voiceEventsBeforeGo + 1,
    'the next 3/2/1 still must not speak before GO');
  assert.ok(Number(state.musicTime) >= beforeNextRun,
    `a new run must continue the full song: ${beforeNextRun} -> ${state.musicTime}`);
  assert.equal(state.musicPlaying, true);

  await page.evaluate(() => window.__harness.scenario('drift-charge'));
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.driftTier) >= 1, `drift must expose its first audible charge tier: ${state.driftTier}`);
  await page.evaluate(() => window.__harness.advance(0.35));
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.driftTier) >= 2, `holding the drift must advance to a higher audible tier: ${state.driftTier}`);

  await page.evaluate(() => window.__harness.scenario('overtake'));
  await page.waitForTimeout(40);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.musicDuck) <= 0.67, `an overtake callout must duck the score: ${state.musicDuck}`);
  // The phone-normalized announcer carries a short arena tail. Synthetic
  // harness scenarios can trigger several GO calls without wall-clock time,
  // so wait past the longest local clip before checking recovery.
  await page.waitForTimeout(750);
  await page.evaluate(() => window.__harness.advance(0.1));
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(Number(state.musicDuck), 1, 'event ducking must recover instead of permanently muting the score');

  await page.evaluate(() => window.__harness.setVisibility(true));
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(state.scene, 'hidden');
  assert.equal(state.outputGain, 0, 'backgrounding must synchronously silence master');
  assert.equal(state.musicPlaying, false, 'backgrounding must pause the streamed track');
  await page.evaluate(() => window.__harness.setVisibility(false));
  await page.waitForTimeout(150);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.equal(state.outputGain, 0, 'foreground return stays silent until explicit GO/gesture');
  assert.equal(state.musicPlaying, false);
  await page.evaluate(() => window.__harness.resumeInterruption());
  await page.waitForTimeout(450);
  state = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(state.outputGain) > 0.08, 'explicit foreground gesture restores audio');
  assert.equal(state.musicPlaying, true);
  assert.equal(state.scene, 'countdown', 'foreground GO must resume through 3/2/1');

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__harness?.ready);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('board-race.audio.v1')));
  assert.deepEqual(
    { master: persisted.master, music: persisted.music, sfx: persisted.sfx, ambience: persisted.ambience },
    { master: 1, music: 1, sfx: 1, ambience: 1 },
    'mixer settings must survive reload',
  );

  // Safari/iOS commonly declines Vorbis. Force the capability probe down the
  // MP3 path and delay the unused female file: a cold Android-style first GO
  // must prioritize the selected male voice instead of waiting for the pair.
  const mobileContext = await browser.newContext({ viewport:{ width:844, height:390 }, hasTouch:true, isMobile:true });
  await mobileContext.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) {
      if (String(type).includes('ogg')) return '';
      return original.call(this, type);
    };
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.route(/countdown-go-female/, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await route.continue().catch(() => undefined);
  });
  await mobilePage.goto(`http://127.0.0.1:${port}/?harness=1&mobile=1&quality=performance`, { waitUntil:'load', timeout:60000 });
  await mobilePage.waitForFunction(() => window.__harness?.ready, null, { timeout:60000 });
  let mobileAudio = await mobilePage.evaluate(() => window.__harness.audioState());
  const mobileVoiceEvents = Number(mobileAudio.countdownVoiceEvents);
  await mobilePage.locator('.driver-select-go').click();
  await advanceWithWallClock(mobilePage, 6.2);
  mobileAudio = await mobilePage.evaluate(() => window.__harness.audioState());
  assert.equal((await mobilePage.evaluate(() => window.__harness.playerState())).phase, 'racing');
  assert.equal(mobileAudio.countdownVoiceFormat, 'mp3');
  assert.equal(mobileAudio.countdownSelectedVoiceReady, true, 'the selected mobile MP3 announcer must decode independently');
  assert.equal(mobileAudio.contextStateAtGo, 'running', 'the real mobile GO gesture must leave Web Audio running at GO');
  assert.equal(mobileAudio.lastGoDisposition, 'played');
  assert.equal(Number(mobileAudio.resumeFailures), 0);
  assert.equal(Number(mobileAudio.countdownVoiceEvents), mobileVoiceEvents + 1,
    'the actual cold mobile countdown must emit exactly one selected GO announcer');
  await mobileContext.close();

  // If every voice asset misses the deadline, emit the electronic GO exactly
  // on time and never play a detached word after racing has already started.
  const delayedContext = await browser.newContext({ viewport:{ width:844, height:390 }, hasTouch:true, isMobile:true });
  await delayedContext.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) {
      if (String(type).includes('ogg')) return '';
      return original.call(this, type);
    };
  });
  let releaseVoices;
  const heldVoices = new Promise((resolve) => { releaseVoices = resolve; });
  const delayedPage = await delayedContext.newPage();
  await delayedPage.route(/countdown-go-/, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    await heldVoices;
    await route.continue().catch(() => undefined);
  });
  await delayedPage.goto(`http://127.0.0.1:${port}/?harness=1&mobile=1&quality=performance`, { waitUntil:'load', timeout:60000 });
  await delayedPage.waitForFunction(() => window.__harness?.ready, null, { timeout:60000 });
  const delayedBefore = await delayedPage.evaluate(() => window.__harness.audioState());
  await delayedPage.locator('.driver-select-go').click();
  await advanceWithWallClock(delayedPage, 6.2);
  let delayedAudio = await delayedPage.evaluate(() => window.__harness.audioState());
  assert.equal((await delayedPage.evaluate(() => window.__harness.playerState())).phase, 'racing');
  assert.equal(delayedAudio.lastGoDisposition, 'not_ready');
  assert.equal(Number(delayedAudio.countdownVoiceEvents), Number(delayedBefore.countdownVoiceEvents));
  assert.equal(Number(delayedAudio.countdownFallbackEvents), Number(delayedBefore.countdownFallbackEvents) + 1,
    'a cold decode miss must fall back to one exact-time electronic GO');
  releaseVoices();
  await delayedPage.waitForFunction(() => window.__harness.audioState().countdownSelectedVoiceReady === true, null, { timeout:5000 });
  await delayedPage.waitForTimeout(350);
  delayedAudio = await delayedPage.evaluate(() => window.__harness.audioState());
  assert.equal(Number(delayedAudio.countdownVoiceEvents), Number(delayedBefore.countdownVoiceEvents),
    'a voice that becomes ready after GO must never play late');
  await delayedContext.close();
  console.log('audio contract: OK');
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
