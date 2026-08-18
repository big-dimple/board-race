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
 *   node harness/screenshot.mjs --responsive ready # desktop + compact selection layouts
 *   node harness/screenshot.mjs --mobile start       # default touch controls
 *   node harness/screenshot.mjs --mobile --tilt start
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SHOT_PORT || 5199);
const BASE = `http://localhost:${PORT}/?harness=1`;
const OUT = path.join(root, 'shots');
const systemChrome = '/usr/bin/google-chrome';
const chromePath = process.env.CHROME_PATH || (existsSync(systemChrome) ? systemChrome : undefined);

// name → harness scenario call (+ optional freeCam before render)
const SCENARIOS = {
  ready: { scenario: 'ready' },
  countdown: { scenario: 'countdown' },
  start: { scenario: 'start' },
  'pc-primer': { scenario: 'pc-primer', settleMs: 260 },
  sweeper: { scenario: 'sweeper' },
  chicane: { scenario: 'chicane' },
  hairpin: { scenario: 'hairpin' },
  'sky-sun': { scenario: 'hairpin' },
  'post-third-turn': { scenario: 'post-third-turn' },
  airtime: { scenario: 'airtime' },
  'drift-charge': { scenario: 'drift-charge' },
  'coach-drift': { scenario: 'coach-drift' },
  'opponent-drift': {
    scenario: 'opponent-drift',
    freeCamDynamic: { back: 7.5, side: -7.5, up: 4.4, lookUp: 0.5, target: 'rival', role: 1 },
  },
  'boost-burst': { scenario: 'boost-burst', freeCamDynamic: { back: 8.5, up: 2.3, lookUp: 0.55 } },
  'flight-ready': { scenario: 'flight-ready' },
  'flight-prompt': { scenario: 'flight-prompt', settleMs: 180 },
  'radio-technique': { scenario: 'radio-technique', settleMs: 900 },
  interrupted: { scenario: 'interrupted' },
  'flight-rule': { scenario: 'flight-rule' },
  'flight-spool': { scenario: 'flight-spool', freeCamDynamic: { back: 7, up: 1.45, lookUp: 0.3 } },
  'flight-cruise': { scenario: 'flight-cruise' },
  'flight-extension-ready': { scenario: 'flight-extension-ready' },
  'flight-extension-spool': { scenario: 'flight-extension-spool' },
  'flight-extension-descent': { scenario: 'flight-extension-descent' },
  'flight-airbrake': { scenario: 'flight-airbrake' },
  'flight-route3-turn': { scenario: 'flight-route3-turn' },
  'flight-route4-prepare': { scenario: 'flight-route4-prepare' },
  'flight-route4-approach': { scenario: 'flight-route4-approach' },
  'flight-route5-prepare': { scenario: 'flight-route5-prepare' },
  'flight-route5-launch': { scenario: 'flight-route5-launch' },
  'flight-route5-turn': { scenario: 'flight-route5-turn' },
  'flight-route5-counter': { scenario: 'flight-route5-counter' },
  'flight-route6-prepare': { scenario: 'flight-route6-prepare' },
  'flight-route6-turn': { scenario: 'flight-route6-turn' },
  'flight-route7-cruise': { scenario: 'flight-route7-cruise' },
  'flight-combo': { scenario: 'flight-combo', freeCamDynamic: { back: 7, up: 1.55, lookUp: 0.4 } },
  'flight-descent': { scenario: 'flight-descent' },
  'flight-miss': { scenario: 'flight-miss', settleMs: 760 },
  'flight-no-launch': { scenario: 'flight-no-launch', settleMs: 760 },
  'retry-lesson': { scenario: 'retry-lesson', settleMs: 380 },
  'first-failure-offer': { scenario: 'first-failure-offer', settleMs: 180 },
  'flight-route': { scenario: 'flight-route' },
  'flight-recovery-air': { scenario: 'flight-recovery-air' },
  'flight-route4-recovery-air': { scenario: 'flight-route4-recovery-air' },
  'flight-recovery-surface': { scenario: 'flight-recovery-surface' },
  'third-recovery-air': { scenario: 'third-recovery-air' },
  'third-recovery-surface': { scenario: 'third-recovery-surface' },
  'flight-spent-charge': { scenario: 'flight-spent-charge' },
  'endless-qualified': { scenario: 'endless-qualified', timeout: 180000, settleMs: 180 },
  'two-flight-taunt': { scenario: 'endless-two', settleMs: 350 },
  'medal-ceremony': { scenario: 'medal-ceremony', timeout: 180000, settleMs: 180 },
  'endless-four': { scenario: 'endless-four', timeout: 180000, settleMs: 180 },
  'endless-medal-fail': { scenario: 'endless-medal-fail', timeout: 180000, settleMs: 180 },
  'final-station': { scenario: 'final-station', timeout: 180000, settleMs: 180 },
  'final-rival-portal': { scenario: 'final-rival-portal', freeCamDynamic: { back: 5, up: 3.2, lookUp: 0.6 } },
  'expansion-gallery': { scenario: 'expansion-gallery', timeout: 180000, settleMs: 180 },
  overtake: { scenario: 'overtake', settleMs: 140, freeCamDynamic: { back: 10, up: 3.2, lookUp: 0.8 } },
  'overtake-chain': { scenario: 'overtake-chain', settleMs: 140, freeCamDynamic: { back: 10, up: 3.2, lookUp: 0.8 } },
  'position-lost': { scenario: 'position-lost', freeCamDynamic: { back: 10, up: 3.2, lookUp: 0.8 } },
  // Free-camera close-ups, driven off the mid-race pack.
  rider: {
    scenario: 'sweeper',
    // placed dynamically: just astern of the player, low, rider-height
    freeCamDynamic: { back: 5.5, up: 1.9, lookUp: 1.2 },
  },
  'rider-side': {
    scenario: 'sweeper',
    freeCamDynamic: { back: 0, side: 6, up: 1.3, lookAhead: 0, lookUp: 0.9 },
  },
  'vehicle-three-quarter': {
    scenario: 'sweeper',
    freeCamDynamic: { back: -5.5, side: 3.5, up: 1.6, lookAhead: 0, lookUp: 0.8 },
  },
  water: {
    scenario: 'airtime',
    freeCamDynamic: { back: 26, up: 3.2, lookUp: 0 },
  },
  'wake-close': {
    scenario: 'sweeper',
    freeCamDynamic: { back: 6, side: 10, up: 12, lookAhead: -6, lookUp: 0.2 },
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

async function advanceToControlledWaterContact(page, maxFrames = 180) {
  return page.evaluate((limit) => {
    let before = window.__harness.playerState();
    for (let frame = 1; frame <= limit; frame++) {
      window.__harness.advance(1 / 60);
      const after = window.__harness.playerState();
      if (before.flightPhase !== 'surface' && after.flightPhase === 'surface') {
        return { before, after, frames:frame };
      }
      before = after;
    }
    throw new Error(`controlled flight did not contact water within ${limit} fixed steps`);
  }, maxFrames);
}

async function verifySurfaceGuideVisualContract(page) {
  await page.evaluate(() => window.__harness.scenario('hairpin'));
  const visual = await page.evaluate(() => {
    const ribbon = window.__scene.getObjectByName('racing-line');
    const arrows = window.__scene.getObjectByName('surface-guide-chevrons');
    const arrowInk = window.__scene.getObjectByName('surface-guide-chevron-ink');
    if (!ribbon?.isMesh || !arrows?.isMesh || !arrowInk?.isMesh) return null;
    return {
      ribbonVertices: ribbon.geometry.attributes.position.count,
      ribbonSide: ribbon.material.side,
      ribbonVertexShader: ribbon.material.vertexShader,
      ribbonFragmentShader: ribbon.material.fragmentShader,
      arrowVertices: arrows.geometry.attributes.position.count,
      arrowInstances: arrows.count,
      arrowIsInstanced: Boolean(arrows.isInstancedMesh),
      arrowHasTurnAttribute: Boolean(arrows.geometry.attributes.aTurn),
      arrowPhases: [...new Set(Array.from(arrows.geometry.attributes.aPhase.array)
        .map((value) => Number(value.toFixed(3))))],
      arrowSide: arrows.material.side,
      arrowVertexShader: arrows.material.vertexShader,
      arrowFragmentShader: arrows.material.fragmentShader,
      inkInstances: arrowInk.count,
      inkIsInstanced: Boolean(arrowInk.isInstancedMesh),
      inkVertexShader: arrowInk.material.vertexShader,
      inkFragmentShader: arrowInk.material.fragmentShader,
    };
  });
  assert.ok(visual, 'surface guide meshes must exist in the rendered scene');
  assert.equal(visual.ribbonVertices, (1400 + 1) * 9,
    'the surface veil must be tessellated across eight strips so it follows local waves');
  assert.equal(visual.ribbonSide, 0, 'the surface veil must render once from above, not double-blend');
  assert.match(visual.ribbonVertexShader, /waveHeight\(p\.xz, uTime\)/,
    'the translucent veil must follow the live ocean displacement');
  assert.doesNotMatch(visual.ribbonFragmentShader, /railInk|crossbar|arrowPhase/,
    'the retired thick rails and procedural V wallpaper must not return');
  assert.equal(visual.arrowIsInstanced, true, 'the visible arrow field must be a bounded moving instance set');
  assert.equal(visual.arrowVertices, 12, 'each moving marker must stay a thin two-stroke open chevron');
  assert.ok(visual.arrowInstances >= 15 && visual.arrowInstances <= 17,
    `only the actionable lookahead may carry arrows: ${visual.arrowInstances}`);
  assert.equal(visual.arrowHasTurnAttribute, true, 'arrow geometry must distinguish ordinary and turn cues');
  assert.ok(visual.arrowPhases.length >= 3,
    `route arrows need ordered animation phases rather than one static pulse: ${visual.arrowPhases}`);
  assert.equal(visual.arrowSide, 0, 'surface arrows must avoid a second transparent back-face pass');
  assert.match(visual.arrowVertexShader, /waveHeight\(world\.xz, uTime\)/,
    'each arrow vertex must move with the water instead of floating as a rigid panel');
  assert.match(visual.arrowFragmentShader ?? '', /fract\(uTime \* 0\.65 - vPhase\)/,
    'route arrows must light in forward station order rather than breathing in place');
  assert.equal(visual.inkIsInstanced, true, 'the arrow outline must share the bounded instance path');
  assert.equal(visual.inkInstances, visual.arrowInstances,
    'every readable arrow must have exactly one dark cel-shaded outline');
  assert.match(visual.inkVertexShader, /position \* 1\.18/,
    'the outline must be geometry-backed rather than a blurred glow');
  assert.match(visual.inkFragmentShader, /vec3 color = uInk/,
    'the arrow outline must use the shared ink palette');
  assert.doesNotMatch(visual.ribbonFragmentShader, /\bdiscard\b/,
    'surface guide masking must use zero alpha instead of fragment discard');
  assert.match(visual.ribbonFragmentShader, /float visible = 1\.0/,
    'surface guide masking must expose its zero-alpha visibility path');
  assert.match(visual.ribbonFragmentShader, /step\(uLaunchGateS, vS\) \* step\(vS, uLaunchGateEndS\)/,
    'the launch aperture must own one continuous surface-guide cut through the flight exit');
  assert.doesNotMatch(visual.arrowFragmentShader, /\bdiscard\b/,
    'surface guide arrow masking must avoid fragment discard');
  assert.match(visual.arrowFragmentShader, /step\(uLaunchGateS, vS\) \* step\(vS, uLaunchGateEndS\)/,
    'surface arrows must use the same continuous launch ownership as the route veil');

  const launchGateTopology = await page.evaluate(() => Array.from({ length: 7 }, (_, routeIndex) => {
    const id = `flight-${routeIndex + 1}`;
    const group = window.__scene.getObjectByName(`${id}-launch-gate`);
    const postureDirectionDots = [1, 2].map((index) => {
      const posture = group?.getObjectByName(`${id}-launch-posture-${index}`);
      const root = posture?.parent;
      if (!posture || !root) return null;
      posture.updateWorldMatrix(true, false);
      root.updateWorldMatrix(true, false);
      const arrow = posture.matrixWorld.elements;
      const frame = root.matrixWorld.elements;
      const portX = frame[10];
      const portZ = -frame[8];
      const side = group?.userData?.launchPostureDirection === 'right' ? -1 : 1;
      return (arrow[0] * portX * side + arrow[2] * portZ * side) /
        (Math.max(1e-6, Math.hypot(arrow[0], arrow[2])) * Math.max(1e-6, Math.hypot(portX, portZ)));
    }).filter((dot) => dot !== null);
    return {
      exists: Boolean(group),
      projectors: ['left', 'right'].filter((side) => group?.getObjectByName(`${id}-launch-projector-${side}`)).length,
      diamonds: [1, 2, 3].filter((index) => group?.getObjectByName(`${id}-launch-diamond-${index}`)).length,
      packets: [1, 2, 3].filter((index) => group?.getObjectByName(`${id}-launch-energy-packet-${index}`)).length,
      packetVertices: group?.getObjectByName(`${id}-launch-energy-packet-1`)?.geometry?.attributes?.position?.count ?? 0,
      postureMarkers: [1, 2].filter((index) => group?.getObjectByName(`${id}-launch-posture-${index}`)).length,
      vectorPathLengthM: group?.userData?.launchVectorPathLengthM ?? -1,
      vectorDirection: group?.userData?.launchVectorDirection ?? 'missing',
      measuredDirection: group?.userData?.launchMeasuredDirection ?? 'missing',
      authoredDirection: group?.userData?.launchAuthoredDirection ?? 'missing',
      postureDirection: group?.userData?.launchPostureDirection ?? 'missing',
      postureDirectionDots,
    };
  }));
  assert.equal(launchGateTopology.length, 7);
  for (const [routeIndex, topology] of launchGateTopology.entries()) {
    const postureMarkers = routeIndex === 0 || routeIndex === 6 ? 0 : 2;
    const {
      vectorPathLengthM,
      vectorDirection,
      measuredDirection,
      authoredDirection,
      postureDirection,
      postureDirectionDots,
      ...staticTopology
    } = topology;
    assert.deepEqual(staticTopology, {
      exists: true,
      projectors: 2,
      diamonds: 3,
      packets: 3,
      packetVertices: 12,
      postureMarkers,
    },
      `flight ${routeIndex + 1} must use the same authored launch-gate grammar`);
    const vectorRange = routeIndex === 3 ? [32, 36] : [20, 26];
    assert.ok(vectorPathLengthM >= vectorRange[0] && vectorPathLengthM <= vectorRange[1],
      `flight ${routeIndex + 1} must preview a readable launch vector: ${JSON.stringify(topology)}`);
    if (postureMarkers > 0) {
      assert.equal(vectorDirection, authoredDirection,
        `flight ${routeIndex + 1} launch cue must retain the authored gameplay turn`);
      assert.equal(postureDirection, authoredDirection,
        `flight ${routeIndex + 1} posture arrows must retain the authored gameplay turn`);
      assert.equal(postureDirectionDots.length, 2);
      assert.ok(postureDirectionDots.every((dot) => dot > 0.9),
        `flight ${routeIndex + 1} upper diamond arrows point to the wrong side: ${JSON.stringify(topology)}`);
    } else {
      assert.equal(postureDirection, 'none',
        `flight ${routeIndex + 1} must not invent turn arrows without an authored bend`);
      assert.equal(postureDirectionDots.length, 0);
    }
    assert.ok(['left', 'right', 'straight'].includes(measuredDirection),
      `flight ${routeIndex + 1} launch geometry must expose a valid diagnostic direction`);
  }

  const arrowMotion = await page.evaluate(() => {
    const arrows = window.__scene.getObjectByName('surface-guide-chevrons');
    const before = Array.from(arrows.instanceMatrix.array);
    window.__harness.advance(0.25);
    const after = Array.from(arrows.instanceMatrix.array);
    let maxTranslation = 0;
    for (let i = 0; i < arrows.count; i++) {
      const offset = i * 16;
      maxTranslation = Math.max(maxTranslation, Math.hypot(
        after[offset + 12] - before[offset + 12],
        after[offset + 14] - before[offset + 14],
      ));
    }
    return maxTranslation;
  });
  assert.ok(arrowMotion > 0.5,
    `arrow instances must actually travel along the route: ${arrowMotion}`);

  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector('#app > canvas');
    const scene = window.__scene;
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    // Rival tuning legitimately changes where boats occlude the route. The
    // guide contract owns water-versus-guide readability, so remove racers
    // from both halves of the A/B capture and restore them immediately after.
    const actors = [
      ...Array.from({ length:6 }, (_, index) => scene.getObjectByName(`boat-${index}`)),
      ...Array.from({ length:6 }, (_, index) => scene.getObjectByName(`wake-${index}`)),
      scene.getObjectByName('spray-system'),
      scene.getObjectByName('jet-trail'),
    ].filter(Boolean);
    const actorVisibility = actors.map((actor) => actor.visible);
    for (const actor of actors) actor.visible = false;
    const read = () => {
      window.__harness.render();
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      context.drawImage(canvas, 0, 0);
      return context.getImageData(0, 0, copy.width, copy.height).data;
    };
    const compareToggle = (names, includeVariance) => {
      const meshes = (Array.isArray(names) ? names : [names]).map((name) => scene.getObjectByName(name));
      const wasVisible = meshes.map((mesh) => mesh.visible);
      for (const mesh of meshes) mesh.visible = false;
      const off = read();
      for (const mesh of meshes) mesh.visible = true;
      const on = read();
      meshes.forEach((mesh, index) => { mesh.visible = wasVisible[index]; });
      window.__harness.render();
      let changed = 0;
      let deltaSum = 0;
      let offSum = 0;
      let onSum = 0;
      let offSq = 0;
      let onSq = 0;
      let softCount = 0;
      let softDeltaSum = 0;
      let softOffSum = 0;
      let softOnSum = 0;
      let softOffSq = 0;
      let softOnSq = 0;
      const deltas = [];
      for (let i = 0; i < on.length; i += 4) {
        const delta = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) +
          Math.abs(on[i + 2] - off[i + 2]);
        if (delta <= 2) continue;
        changed++;
        deltaSum += delta;
        deltas.push(delta);
        if (includeVariance) {
          const offLuma = off[i] * 0.2126 + off[i + 1] * 0.7152 + off[i + 2] * 0.0722;
          const onLuma = on[i] * 0.2126 + on[i + 1] * 0.7152 + on[i + 2] * 0.0722;
          offSum += offLuma;
          onSum += onLuma;
          offSq += offLuma * offLuma;
          onSq += onLuma * onLuma;
          // The same mesh intentionally contains a high-contrast navigation
          // spine. Keep the broad water veil's translucency contract separate
          // from that readable centerline instead of averaging both away.
          if (delta <= 100) {
            softCount++;
            softDeltaSum += delta;
            softOffSum += offLuma;
            softOnSum += onLuma;
            softOffSq += offLuma * offLuma;
            softOnSq += onLuma * onLuma;
          }
        }
      }
      deltas.sort((a, b) => a - b);
      const offVariance = includeVariance && changed > 0
        ? offSq / changed - (offSum / changed) ** 2
        : 0;
      const onVariance = includeVariance && changed > 0
        ? onSq / changed - (onSum / changed) ** 2
        : 0;
      const softOffVariance = includeVariance && softCount > 0
        ? softOffSq / softCount - (softOffSum / softCount) ** 2
        : 0;
      const softOnVariance = includeVariance && softCount > 0
        ? softOnSq / softCount - (softOnSum / softCount) ** 2
        : 0;
      return {
        changed,
        meanDelta: deltaSum / Math.max(1, changed),
        p90Delta: deltas[Math.floor(deltas.length * 0.9)] ?? 0,
        p95Delta: deltas[Math.floor(deltas.length * 0.95)] ?? 0,
        varianceRetention: includeVariance ? onVariance / Math.max(1, offVariance) : 0,
        softShare: softCount / Math.max(1, changed),
        softMeanDelta: softDeltaSum / Math.max(1, softCount),
        softVarianceRetention: includeVariance ? softOnVariance / Math.max(1, softOffVariance) : 0,
      };
    };
    const result = {
      veil: compareToggle('racing-line', true),
      arrows: compareToggle(['surface-guide-chevron-ink', 'surface-guide-chevrons'], false),
    };
    actors.forEach((actor, index) => { actor.visible = actorVisibility[index]; });
    window.__harness.render();
    return result;
  });
  assert.ok(pixels, 'surface guide pixel probe needs the live renderer canvas');
  assert.ok(pixels.veil.changed > 20000,
    `the water veil must be visible in a real rendered frame: ${JSON.stringify(pixels.veil)}`);
  assert.ok(pixels.veil.meanDelta >= 27,
    `the water route must remain immediately findable against the ocean: ${JSON.stringify(pixels.veil)}`);
  assert.ok(pixels.veil.softShare >= 0.72 && pixels.veil.softMeanDelta >= 30 && pixels.veil.softMeanDelta < 55,
    `most guide pixels must remain a translucent water veil: ${JSON.stringify(pixels.veil)}`);
  assert.ok(pixels.veil.softVarianceRetention >= 0.68,
    `ocean directional texture must remain legible through the translucent part of the guide: ${JSON.stringify(pixels.veil)}`);
  assert.ok(pixels.veil.p90Delta >= 90 && pixels.veil.p90Delta < 185 &&
    pixels.veil.p95Delta >= pixels.veil.p90Delta + 10 && pixels.veil.p95Delta < 260,
  `the soft field must stay bounded while its narrow center spine remains readable: ${JSON.stringify(pixels.veil)}`);
  assert.ok(pixels.arrows.changed > 200,
    `open-chevron geometry must produce visible pixels in the driving view: ${JSON.stringify(pixels.arrows)}`);

  await page.evaluate(() => window.__harness.scenario('post-third-turn'));
  const postThird = await page.evaluate(() => {
    const route = window.__scene.getObjectByName('flight-3-ribbon');
    const recoveryArrows = window.__scene.getObjectByName('flight-3-recovery-arrows');
    return {
      guidance: window.__harness.guidance(),
      recoveryFragmentShader: route?.material?.fragmentShader ?? '',
      recoveryArrowVertices: recoveryArrows?.geometry?.attributes?.position?.count ?? 0,
      recoveryArrowVertexShader: recoveryArrows?.material?.vertexShader ?? '',
    };
  });
  assert.ok(postThird.guidance.surfaceGuideTurnArrowCount >= 3,
    `the third-flight exit must expose an advance left-turn sequence: ${JSON.stringify(postThird.guidance)}`);
  assert.match(postThird.recoveryFragmentShader, /recoveryVeil/,
    'the pre-water recovery tail must use the same soft veil language as the surface route');
  assert.match(postThird.recoveryFragmentShader, /recoveryEdge/,
    'the pre-water recovery tail must retain the same cel edge hierarchy as active flight');
  assert.doesNotMatch(postThird.recoveryFragmentShader, /recoveryDash/,
    'the retired dashed recovery funnel must not reappear before water contact');
  assert.equal(postThird.recoveryArrowVertices, 12,
    'pre-water recovery arrows and surface arrows must share the same open-chevron geometry');
  assert.match(postThird.recoveryArrowVertexShader, /waveHeight\(world\.xz, uTime\)/,
    'recovery arrows must ride the same live water surface as the main route');

  const thirdRecoveryBeats = [];
  for (const beat of ['third-recovery-air', 'third-recovery-surface']) {
    await page.evaluate((name) => window.__harness.scenario(name), beat);
    thirdRecoveryBeats.push(await page.evaluate(() => {
      const route = window.__scene.getObjectByName('flight-3-ribbon');
      const arrows = window.__scene.getObjectByName('flight-3-recovery-arrows');
      return {
        state: window.__harness.playerState(),
        guidance: window.__harness.guidance(),
        ribbonVisible: Boolean(route?.visible),
        ribbonShader: route?.material?.fragmentShader ?? '',
        flightColor: route?.material?.uniforms?.uFlight?.value?.getHex?.() ?? -1,
        recoveryColor: route?.material?.uniforms?.uRecoveryColor?.value?.getHex?.() ?? -1,
        recoverySurfaceBlend: route?.material?.uniforms?.uRecoverySurface?.value ?? -1,
        arrowVisible: Boolean(arrows?.visible),
        arrowShader: arrows?.material?.fragmentShader ?? '',
        arrowColor: arrows?.material?.uniforms?.uColor?.value?.getHex?.() ?? -1,
        arrowSurfaceBlend: arrows?.material?.uniforms?.uSurfaceBlend?.value ?? -1,
      };
    }));
  }
  const [airRecovery, surfaceRecovery] = thirdRecoveryBeats;
  for (const beat of thirdRecoveryBeats) {
    assert.equal(beat.state.flightRouteState, 'passed',
      `the third-flight visual beat must remain inside certified recovery: ${JSON.stringify(beat)}`);
    assert.equal(beat.guidance.activeRouteIndex, 2,
      'water contact must not swap the third-flight recovery guide for flight four');
    assert.equal(beat.guidance.recoveryRouteIndex, 2);
    assert.equal(beat.guidance.visibleRouteCount, 1);
    assert.equal(beat.ribbonVisible, true);
    assert.equal(beat.arrowVisible, true);
    assert.equal(beat.recoveryColor, beat.flightColor,
      'a certified flight must stay in the neutral mist branch until handoff');
    assert.equal(beat.arrowColor, beat.flightColor,
      'recovery direction markers must remain part of the neutral mist flight branch');
    assert.match(beat.arrowShader, /fract\(uTime \* 0\.65 - vPhase\)/,
      'recovery arrows must share the moving phase rhythm used by the surface route');
  }
  assert.notEqual(airRecovery.state.flightPhase, 'surface');
  assert.equal(surfaceRecovery.state.flightPhase, 'surface');
  assert.ok(airRecovery.recoverySurfaceBlend < 0.05 && airRecovery.arrowSurfaceBlend < 0.05,
    `the airborne recovery must keep its authored flight height: ${JSON.stringify(airRecovery)}`);
  assert.ok(surfaceRecovery.recoverySurfaceBlend > 0.2 && surfaceRecovery.arrowSurfaceBlend > 0.2,
    `the same mist recovery may settle onto the swell only after contact: ${JSON.stringify(surfaceRecovery)}`);
  assert.equal(airRecovery.ribbonShader, surfaceRecovery.ribbonShader,
    'the third-flight route must keep one material language across water contact');

  await page.evaluate(() => window.__harness.scenario('flight-route4-recovery-air'));
  const routeFourRecovery = await page.evaluate(() => {
    const route = window.__scene.getObjectByName('flight-4-ribbon');
    const arrows = window.__scene.getObjectByName('flight-4-recovery-arrows');
    return {
      state: window.__harness.playerState(),
      guidance: window.__harness.guidance(),
      flightColor: route?.material?.uniforms?.uFlight?.value?.getHex?.() ?? -1,
      recoveryColor: route?.material?.uniforms?.uRecoveryColor?.value?.getHex?.() ?? -1,
      recoverySurfaceBlend: route?.material?.uniforms?.uRecoverySurface?.value ?? -1,
      arrowColor: arrows?.material?.uniforms?.uColor?.value?.getHex?.() ?? -1,
      arrowSurfaceBlend: arrows?.material?.uniforms?.uSurfaceBlend?.value ?? -1,
    };
  });
  assert.equal(routeFourRecovery.state.flightRouteState, 'passed');
  assert.notEqual(routeFourRecovery.state.flightPhase, 'surface');
  assert.equal(routeFourRecovery.guidance.activeRouteIndex, 3);
  assert.equal(routeFourRecovery.guidance.visibleRouteCount, 1);
  assert.equal(routeFourRecovery.recoveryColor, routeFourRecovery.flightColor,
    `flight four must not turn into the green water guide after its portal: ${JSON.stringify(routeFourRecovery)}`);
  assert.equal(routeFourRecovery.arrowColor, routeFourRecovery.flightColor);
  assert.ok(routeFourRecovery.recoverySurfaceBlend < 0.05 && routeFourRecovery.arrowSurfaceBlend < 0.05,
    `flight four must retain the authored aerial tail until water contact: ${JSON.stringify(routeFourRecovery)}`);
}

async function verifyOceanMaterialContract(page) {
  await page.evaluate(() => window.__harness.scenario('start'));
  const ocean = await page.evaluate(() => {
    const mesh = window.__scene.getObjectByName('ocean');
    if (!mesh?.isMesh || !mesh.material?.isShaderMaterial) return null;
    const uniforms = mesh.material.uniforms;
    return {
      vertices:mesh.geometry.attributes.position.count,
      drawCalls:1,
      vertexShader:mesh.material.vertexShader,
      fragmentShader:mesh.material.fragmentShader,
      transparent:mesh.material.transparent,
      depthWrite:mesh.material.depthWrite,
      rippleStrength:uniforms.uRippleStrength?.value,
      rippleFade:[uniforms.uRippleFadeStart?.value, uniforms.uRippleFadeEnd?.value],
      crest:[uniforms.uCrestHeight?.value, uniforms.uCrestSlope?.value, uniforms.uCrestRise?.value],
      foamStrength:uniforms.uFoamStrength?.value,
      glintStrength:uniforms.uGlintStrength?.value,
      windNormalStrength:uniforms.uWindNormalStrength?.value,
      windFade:[uniforms.uWindFadeStart?.value, uniforms.uWindFadeEnd?.value],
      windSpecStrength:uniforms.uWindSpecStrength?.value,
      fog:[uniforms.uFogStart?.value, uniforms.uFogFar?.value],
    };
  });
  assert.ok(ocean && ocean.vertices > 100000 && ocean.drawCalls === 1,
    `the ocean must remain one camera-following LOD draw: ${JSON.stringify(ocean)}`);
  assert.equal(ocean.transparent, false);
  assert.equal(ocean.depthWrite, true);
  assert.ok(ocean.rippleStrength > 0 && ocean.rippleStrength <= 0.06 &&
    ocean.rippleFade[0] >= 50 && ocean.rippleFade[1] <= 160,
  `near normal detail must fade before it can shimmer in the distance: ${JSON.stringify(ocean)}`);
  assert.ok(ocean.crest[0] >= 0.2 && ocean.crest[0] <= 0.3 &&
    ocean.crest[1] >= 0.008 && ocean.crest[2] >= 0.01 && ocean.foamStrength <= 1,
  `whitecaps must stay sparse and tied to a high, steep, rising face: ${JSON.stringify(ocean)}`);
  assert.ok(ocean.glintStrength >= 0.35 && ocean.glintStrength <= 0.6,
    `moving glints must restore surface life without becoming a sparkle field: ${JSON.stringify(ocean)}`);
  assert.ok(ocean.windNormalStrength >= 0.02 && ocean.windNormalStrength <= 0.05 &&
    ocean.windFade[0] >= 12 && ocean.windFade[0] <= 40 &&
    ocean.windFade[1] >= 160 && ocean.windFade[1] <= 240 &&
    ocean.windSpecStrength >= 0.08 && ocean.windSpecStrength <= 0.24,
  `mid-scale wind detail must stay restrained and distance-faded: ${JSON.stringify(ocean)}`);
  assert.ok(ocean.fog[0] >= 200 && ocean.fog[1] >= 2500,
    `ocean detail must collapse continuously into the horizon: ${JSON.stringify(ocean)}`);
  assert.match(ocean.vertexShader, /vWorldPos = disp/);
  assert.match(ocean.fragmentShader, /gerstnerNormal\(vOrigXZ, uTime\)/);
  assert.match(ocean.fragmentShader, /vec3 viewDir = normalize\(cameraPosition - vWorldPos\)/);
  assert.match(ocean.fragmentShader, /float whitecap = crest \* steep \* rising \* foamBreak/);
  assert.match(ocean.fragmentShader, /whitecap \*= 1\.0 - smoothstep\(170\.0, 340\.0, dist\)/);
  assert.match(ocean.fragmentShader, /fwidth\(glintField\)/,
    'micro glints must be derivative-filtered instead of aliasing across the water');
  assert.match(ocean.fragmentShader, /float windFade = 1\.0 - smoothstep\(uWindFadeStart, uWindFadeEnd, dist\)/,
    'wind detail must fade continuously before the horizon');
  assert.match(ocean.fragmentShader, /fwidth\(windField\)/,
    'mid-scale wind highlights must be derivative-filtered instead of shimmering');
  assert.doesNotMatch(ocean.fragmentShader, /uBand|vHw|deepToMid|midToCrest|floor\(vH/,
    'retired height slabs and graphic sparkle fields must not return');

  const temporal = await page.evaluate(() => {
    const h = window.__harness;
    const scene = window.__scene;
    const canvas = document.querySelector('#app > canvas');
    const oceanMesh = scene.getObjectByName('ocean');
    if (!(canvas instanceof HTMLCanvasElement) || !oceanMesh) return null;
    const p = h.playerPose();
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    h.freeCam(p.x - fx * 24, p.y + 5.2, p.z - fz * 24, p.x + fx * 18, p.y, p.z + fz * 18);
    const visibility = scene.children.map((child) => [child, child.visible]);
    for (const child of scene.children) child.visible = child === oceanMesh;
    const read = () => {
      h.render();
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      context.drawImage(canvas, 0, 0);
      return context.getImageData(0, 0, copy.width, copy.height).data;
    };
    const before = read();
    h.advance(0.24);
    const after = read();
    let samples = 0;
    let changed = 0;
    let deltaSum = 0;
    let lumSum = 0;
    let lumSq = 0;
    const x0 = Math.floor(canvas.width * 0.24);
    const x1 = Math.floor(canvas.width * 0.76);
    const y0 = Math.floor(canvas.height * 0.5);
    const y1 = Math.floor(canvas.height * 0.84);
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * canvas.width + x) * 4;
        const delta = Math.abs(after[i] - before[i]) + Math.abs(after[i + 1] - before[i + 1]) +
          Math.abs(after[i + 2] - before[i + 2]);
        const lum = after[i] * 0.2126 + after[i + 1] * 0.7152 + after[i + 2] * 0.0722;
        samples++;
        if (delta > 10) changed++;
        deltaSum += delta;
        lumSum += lum;
        lumSq += lum * lum;
      }
    }
    for (const [child, visible] of visibility) child.visible = visible;
    h.chaseCam();
    h.render();
    const meanLum = lumSum / Math.max(1, samples);
    return {
      changedRatio: changed / Math.max(1, samples),
      meanDelta: deltaSum / Math.max(1, samples),
      luminanceDeviation: Math.sqrt(Math.max(0, lumSq / Math.max(1, samples) - meanLum * meanLum)),
    };
  });
  assert.ok(temporal && temporal.changedRatio >= 0.08 && temporal.changedRatio <= 0.72 &&
    temporal.meanDelta >= 3 && temporal.luminanceDeviation >= 6,
  `the mid-distance ocean must move and sparkle without turning into full-frame noise: ${JSON.stringify(temporal)}`);
}

async function verifyToonMaterialContract(page) {
  await page.evaluate(() => window.__harness.scenario('start'));
  const toon = await page.evaluate(() => {
    let found = null;
    window.__scene.traverse((object) => {
      if (found || !object.material) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const material = materials.find((candidate) => candidate?.name === 'CelToon');
      if (!material) return;
      found = {
        name: material.name,
        uniforms: Object.keys(material.uniforms ?? {}),
        fragmentShader: material.fragmentShader ?? '',
      };
    });
    return found;
  });
  assert.ok(toon, 'the scene must expose a shared cel material for the rendering contract');
  assert.equal(toon.name, 'CelToon');
  assert.equal(toon.uniforms.includes('uRamp'), false,
    'toon diffuse must not bind the retired per-fragment ramp texture');
  assert.doesNotMatch(toon.fragmentShader, /sampler2D\s+uRamp|texture2D\(uRamp/,
    'toon diffuse must use arithmetic instead of a ramp texture fetch');
  assert.match(toon.fragmentShader, /float band = 0\.46/,
    'toon diffuse must keep the authored darkest band level');
  for (const threshold of ['0\\.125', '0\\.250', '0\\.375', '0\\.500', '0\\.625', '0\\.750', '0\\.875']) {
    assert.match(toon.fragmentShader, new RegExp(`step\\(${threshold}, ndl\\)`),
      `toon diffuse must preserve its analytic eight-band threshold ${threshold}`);
  }
}

async function verifySkyMaterialContract(page) {
  // Keep this contract's setup time-neutral: later ocean temporal probes rely
  // on the deterministic start scenario and should not inherit a hairpin step.
  await page.evaluate(() => window.__harness.scenario('start'));
  const sky = await page.evaluate(() => {
    const root = window.__scene.getObjectByName('sky');
    if (!root) return null;
    const dome = root.children.find((child) => child.isMesh && child.material?.name === 'CelSky');
    const sprites = root.children.filter((child) => child.isSprite);
    const materials = [];
    for (const sprite of sprites) {
      if (!materials.includes(sprite.material)) materials.push(sprite.material);
    }
    const spriteInfo = sprites.map((sprite) => ({
      opacity: sprite.material?.opacity ?? -1,
      width: sprite.material?.map?.image?.width ?? 0,
      height: sprite.material?.map?.image?.height ?? 0,
    }));
    return {
      spriteCount: sprites.length,
      materialCount: materials.length + (dome ? 1 : 0),
      fragmentShader: dome?.material?.fragmentShader ?? '',
      uniformKeys: Object.keys(dome?.material?.uniforms ?? {}),
      spriteInfo,
    };
  });
  assert.ok(sky && sky.spriteCount === 16 && sky.materialCount === 3,
    `sky must keep one dome and two batched cloud materials: ${JSON.stringify(sky)}`);
  assert.ok(sky.spriteInfo.slice(0, 8).every((cloud) => cloud.width === 256 && cloud.height === 160) &&
    sky.spriteInfo.slice(8).every((cloud) => cloud.width === 512 && cloud.height === 220 &&
      cloud.opacity >= 0.7 && cloud.opacity <= 0.85),
  `far clouds must use the wide atmospheric texture without becoming a bright slab: ${JSON.stringify(sky.spriteInfo)}`);
  assert.ok(sky.uniformKeys.includes('uSunVisualDir'));
  assert.match(sky.fragmentShader, /uSunVisualDir/);
  assert.match(sky.fragmentShader, /float disc = 1\.0 - smoothstep\(0\.026, 0\.040, ang\)/,
    'the visible sun must remain a small, soft-edged disc');
  assert.match(sky.fragmentShader, /pow\(max\(cos\(/,
    'sun rays must use tapered angular lobes instead of equal rectangular dashes');
}

async function verifyCommercialCopyContract(page) {
  await page.evaluate(() => window.__harness.scenario('endless-two'));
  const impact = await page.evaluate(() => ({
    title: document.querySelector('.hud-impact-title')?.textContent?.trim() ?? '',
    detail: document.querySelector('.hud-impact-detail')?.textContent?.trim() ?? '',
  }));
  assert.equal(impact.title, '你已超过天下 80%的男人',
    `the second-flight challenge line must land as the authored taunt: ${JSON.stringify(impact)}`);
  assert.equal(impact.detail, '最后一飞，定级。');
  await page.evaluate(() => window.__harness.scenario('radio-technique'));
  const radio = await page.locator('.race-radio-body').textContent();
  assert.match(radio ?? '', /空刹压住速度，转向咬住弯心/,
    'the technique broadcast must explain the move in one clean sentence');
}

async function verifyWakeMaterialContract(page) {
  await page.evaluate(() => window.__harness.scenario('start'));
  const wakes = await page.evaluate(() => Array.from({ length: 6 }, (_, id) => {
    const mesh = window.__scene.getObjectByName(`wake-${id}`);
    const material = mesh?.material;
    return {
      id,
      isMesh: Boolean(mesh?.isMesh),
      childCount: mesh?.children?.length ?? -1,
      positionCount: mesh?.geometry?.attributes?.position?.count ?? -1,
      indexCount: mesh?.geometry?.index?.count ?? -1,
      drawRange: mesh?.geometry?.drawRange?.count ?? -1,
      transparent: material?.transparent ?? null,
      depthWrite: material?.depthWrite ?? null,
      side: material?.side ?? -1,
      vertexShader: material?.vertexShader ?? '',
      fragmentShader: material?.fragmentShader ?? '',
      life: material?.uniforms?.uLife?.value ?? -1,
      visualScale: material?.uniforms?.uVisualScale?.value ?? -1,
    };
  }));

  assert.equal(wakes.length, 6);
  for (const wake of wakes) {
    assert.ok(wake.isMesh && wake.childCount === 0,
      `wake ${wake.id} must stay one direct mesh/draw path: ${JSON.stringify(wake)}`);
    assert.equal(wake.positionCount, 720,
      `wake ${wake.id} must keep the preallocated smooth ring geometry: ${JSON.stringify(wake)}`);
    assert.equal(wake.indexCount, 2154,
      `wake ${wake.id} must use one indexed triangle strip: ${JSON.stringify(wake)}`);
    assert.ok(wake.drawRange >= 0 && wake.drawRange <= wake.indexCount && wake.drawRange % 6 === 0,
      `wake ${wake.id} has an invalid live draw range: ${JSON.stringify(wake)}`);
    assert.equal(wake.transparent, true);
    assert.equal(wake.depthWrite, false);
    assert.equal(wake.side, 2, 'wake should render both sides without a second mesh pass');
    assert.match(wake.vertexShader, /vWorldPos = \(modelMatrix \* vec4/);
    assert.match(wake.fragmentShader, /gerstnerNormal\(vWorldPos\.xz, uTime\)/,
      'wake highlights must use the same live normal field as the ocean');
    assert.match(wake.fragmentShader, /float contact =/);
    assert.match(wake.fragmentShader, /float center =/);
    assert.match(wake.fragmentShader, /float shoulderBreak =/);
    assert.match(wake.fragmentShader, /float bodyAlpha =/);
    assert.doesNotMatch(wake.fragmentShader, /\bdiscard\b/,
      'wake masking must stay on the zero-alpha path for early depth tests');
    assert.doesNotMatch(wake.fragmentShader, /hash12|uGapW|uGapL|floor\(vAlong|railCenter|shoulderHalo/,
      'wake foam must not regress to hash-cell or stamped-bar breakup');
    assert.ok(wake.life >= 4.8 && wake.life <= 5.6,
      `wake lifetime must preserve a readable near-field trail: ${JSON.stringify(wake)}`);
    assert.ok(wake.visualScale >= 0.75 && wake.visualScale <= 1,
      `wake visual scale must remain a bounded clutter control: ${JSON.stringify(wake)}`);
  }

  const silhouette = await page.evaluate(() => {
    const h = window.__harness;
    const scene = window.__scene;
    h.scenario('sweeper');
    const canvas = document.querySelector('#app > canvas');
    const wake = window.__scene.getObjectByName('wake-0');
    if (!(canvas instanceof HTMLCanvasElement) || !wake) return null;
    const p = h.playerPose();
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    h.freeCam(
      p.x - fx * 6 + fz * 10, p.y + 12, p.z - fz * 6 - fx * 10,
      p.x - fx * 6, p.y + 0.2, p.z - fz * 6,
    );
    const isolated = [
      scene.getObjectByName('racing-line'),
      scene.getObjectByName('surface-guide-chevrons'),
      scene.getObjectByName('surface-guide-chevron-ink'),
      ...Array.from({ length: 5 }, (_, index) => scene.getObjectByName(`wake-${index + 1}`)),
      ...Array.from({ length: 5 }, (_, index) => scene.getObjectByName(`boat-${index + 1}`)),
    ].filter(Boolean);
    const isolatedVisibility = isolated.map((object) => [object, object.visible]);
    for (const object of isolated) object.visible = false;
    const read = () => {
      h.render();
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      context.drawImage(canvas, 0, 0);
      return context.getImageData(0, 0, copy.width, copy.height).data;
    };
    const wasVisible = wake.visible;
    wake.visible = false;
    const withoutWake = read();
    wake.visible = true;
    const withWake = read();
    wake.visible = wasVisible;
    for (const [object, visible] of isolatedVisibility) object.visible = visible;
    h.chaseCam();
    h.render();
    const fills = [];
    let centerRows = 0;
    let changed = 0;
    for (let y = Math.floor(canvas.height * 0.42); y < Math.floor(canvas.height * 0.9); y += 2) {
      const xs = [];
      for (let x = 0; x < canvas.width; x += 2) {
        const i = (y * canvas.width + x) * 4;
        const delta = Math.abs(withWake[i] - withoutWake[i]) +
          Math.abs(withWake[i + 1] - withoutWake[i + 1]) +
          Math.abs(withWake[i + 2] - withoutWake[i + 2]);
        if (delta <= 8) continue;
        xs.push(x);
        changed++;
      }
      if (xs.length < 5) continue;
      const lo = xs[0];
      const hi = xs[xs.length - 1];
      const slots = Math.floor((hi - lo) / 2) + 1;
      if (slots < 12) continue;
      fills.push(xs.length / slots);
      const center = (lo + hi) * 0.5;
      const tolerance = Math.max(4, (hi - lo) * 0.12);
      if (xs.some((x) => Math.abs(x - center) <= tolerance)) centerRows++;
    }
    const rect = canvas.getBoundingClientRect();
    const deviceArea = Math.max(1, (canvas.width / Math.max(1, rect.width)) *
      (canvas.height / Math.max(1, rect.height)));
    return {
      changedCss: changed * 4 / deviceArea,
      rows: fills.length,
      meanFill: fills.reduce((sum, value) => sum + value, 0) / Math.max(1, fills.length),
      meanChangedWidthCss: changed * 2 / Math.max(1, fills.length) /
        Math.max(1, canvas.width / Math.max(1, rect.width)),
      centerHitRatio: centerRows / Math.max(1, fills.length),
    };
  });
  assert.ok(silhouette && silhouette.changedCss >= 600 && silhouette.rows >= 20 &&
    silhouette.meanFill >= 0.22 && silhouette.meanChangedWidthCss >= 18 &&
    silhouette.meanChangedWidthCss <= 280 && silhouette.centerHitRatio >= 0.45,
  `wake pixels must form a broken central wash, neither a filled road nor two empty rails: ${JSON.stringify(silhouette)}`);
}

async function verifyFlightGuideVisualContract(page) {
  const materialContract = await page.evaluate(() => Array.from({ length: 7 }, (_, index) => {
    const ribbon = window.__scene.getObjectByName(`flight-${index + 1}-ribbon`);
    const material = ribbon?.material;
    return {
      route: index + 1,
      exists: Boolean(ribbon?.isMesh),
      style: ribbon?.userData?.guideStyle ?? 'missing',
      deep: material?.uniforms?.uFlightDeep?.value?.getHex?.() ?? -1,
      mist: material?.uniforms?.uFlight?.value?.getHex?.() ?? -1,
      panel: material?.uniforms?.uPanelAlpha?.value ?? -1,
      panelBeat: material?.uniforms?.uPanelBeatAlpha?.value ?? -1,
      center: material?.uniforms?.uCenterAlpha?.value ?? -1,
      edge: material?.uniforms?.uEdgeAlpha?.value ?? -1,
      flow: material?.uniforms?.uFlowAlpha?.value ?? -1,
      farStart: material?.uniforms?.uFarStart?.value ?? -1,
      farEnd: material?.uniforms?.uFarEnd?.value ?? -1,
      transparent: Boolean(material?.transparent),
      depthTest: Boolean(material?.depthTest),
      depthWrite: Boolean(material?.depthWrite),
      forceSinglePass: Boolean(material?.forceSinglePass),
      visualStartU: ribbon?.userData?.visualStartU ?? -1,
      authoredEntryU: ribbon?.userData?.authoredEntryU ?? -1,
      vertexShader: material?.vertexShader ?? '',
      fragmentShader: material?.fragmentShader ?? '',
    };
  }));
  assert.equal(materialContract.length, 7);
  for (const route of materialContract) {
    assert.equal(route.exists, true, `flight ${route.route} needs a rendered corridor mesh`);
    assert.equal(route.style, 'white-mist-corridor');
    assert.ok(Math.abs(route.visualStartU - route.authoredEntryU) <= 1e-6,
      `flight ${route.route} corridor must start at its real entry, with no pre-entry mist bridge: ${JSON.stringify(route)}`);
    assert.equal(route.mist, 0xffffff,
      `flight ${route.route} must use neutral white mist, not a second blue-green slab`);
    assert.equal(route.deep, 0xe8e8e8,
      `flight ${route.route} must use the neutral mist shade for its panel`);
    assert.ok(route.panel >= 0.09 && route.panel <= 0.1 &&
      route.panelBeat >= 0.035 && route.panelBeat <= 0.045 &&
      route.center >= 0.04 && route.center <= 0.05 &&
      route.edge >= 0.32 && route.edge <= 0.36 &&
      route.flow >= 0.52 && route.flow <= 0.56,
    `flight ${route.route} needs the readable neutral mist hierarchy: ${JSON.stringify(route)}`);
    assert.deepEqual({
      farStart:route.farStart,
      farEnd:route.farEnd,
      transparent:route.transparent,
      depthTest:route.depthTest,
      depthWrite:route.depthWrite,
      forceSinglePass:route.forceSinglePass,
    }, {
      farStart:55,
      farEnd:145,
      transparent:true,
      depthTest:true,
      depthWrite:false,
      forceSinglePass:true,
    }, `flight ${route.route} must preserve the ocean and avoid a transparent double pass`);
    assert.match(route.vertexShader, /vViewDepth = max\(0\.0, -viewPosition\.z\)/,
      `flight ${route.route} must measure real view depth for distant structure`);
    assert.match(route.fragmentShader, /float uvPixel = max\(fwidth\(vUv\.x\), 0\.0005\)/,
      `flight ${route.route} must keep its lines screen-readable at distance`);
    assert.match(route.fragmentShader, /float packetHead =/,
      `flight ${route.route} needs a directional head and fading tail`);
    assert.doesNotMatch(route.fragmentShader, /\bdiscard\b/,
      `flight ${route.route} must stay on the early-test-friendly alpha path`);
    assert.match(route.fragmentShader, /vec3 edgeColor = uFlight/,
      `flight ${route.route} edge flow must remain neutral instead of mixing blue-green uniforms`);
    assert.match(route.fragmentShader, /float recoveryEdge =/,
      `flight ${route.route} recovery must retain the same cel edge hierarchy`);
  }
  assert.equal(new Set(materialContract.map((route) => route.fragmentShader)).size, 1,
    'all seven flights and their recovery tails must share one visual grammar');

  const beats = [
    ['flight-cruise', 0],
    ['flight-airbrake', 1],
    ['flight-route3-turn', 2],
    ['flight-route4-approach', 3],
    ['flight-route5-turn', 4],
    ['flight-route6-turn', 5],
    ['flight-route7-cruise', 6],
  ];
  for (const [scenario, routeIndex] of beats) {
    await page.evaluate((name) => window.__harness.scenario(name), scenario);
    const pixels = await page.evaluate((index) => {
      const canvas = document.querySelector('#app > canvas');
      const ribbon = window.__scene.getObjectByName(`flight-${index + 1}-ribbon`);
      if (!(canvas instanceof HTMLCanvasElement) || !ribbon?.isMesh) return null;
      const read = () => {
        window.__harness.render();
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = copy.getContext('2d', { willReadFrequently:true });
        context.drawImage(canvas, 0, 0);
        return context.getImageData(0, 0, copy.width, copy.height).data;
      };
      const compare = (before, after, threshold = 2) => {
        let changed = 0;
        let deltaSum = 0;
        let beforeSum = 0;
        let afterSum = 0;
        let beforeSq = 0;
        let afterSq = 0;
        const deltas = [];
        for (let i = 0; i < after.length; i += 4) {
          const delta = Math.abs(after[i] - before[i]) +
            Math.abs(after[i + 1] - before[i + 1]) + Math.abs(after[i + 2] - before[i + 2]);
          if (delta <= threshold) continue;
          changed++;
          deltaSum += delta;
          deltas.push(delta);
          const beforeLuma = before[i] * 0.2126 + before[i + 1] * 0.7152 + before[i + 2] * 0.0722;
          const afterLuma = after[i] * 0.2126 + after[i + 1] * 0.7152 + after[i + 2] * 0.0722;
          beforeSum += beforeLuma;
          afterSum += afterLuma;
          beforeSq += beforeLuma * beforeLuma;
          afterSq += afterLuma * afterLuma;
        }
        deltas.sort((a, b) => a - b);
        const beforeVariance = changed > 0 ? beforeSq / changed - (beforeSum / changed) ** 2 : 0;
        const afterVariance = changed > 0 ? afterSq / changed - (afterSum / changed) ** 2 : 0;
        return {
          changed,
          meanDelta:deltaSum / Math.max(1, changed),
          p95Delta:deltas[Math.floor(deltas.length * 0.95)] ?? 0,
          varianceRetention:afterVariance / Math.max(1, beforeVariance),
        };
      };
      const wasVisible = ribbon.visible;
      ribbon.visible = false;
      const withoutGuide = read();
      ribbon.visible = true;
      const withGuide = read();
      const visibility = compare(withoutGuide, withGuide);
      const time = ribbon.material.uniforms.uTime.value;
      ribbon.material.uniforms.uTime.value = time + 0.25;
      const movedGuide = read();
      ribbon.material.uniforms.uTime.value = time;
      ribbon.visible = wasVisible;
      window.__harness.render();
      return { visibility, motion:compare(withGuide, movedGuide, 4) };
    }, routeIndex);
    assert.ok(pixels, `${scenario} needs a live WebGL pixel probe`);
    assert.ok(pixels.visibility.changed >= 2500 && pixels.visibility.meanDelta >= 18 &&
      pixels.visibility.p95Delta >= 45,
    `${scenario} corridor must be findable in the actual frame: ${JSON.stringify(pixels.visibility)}`);
    assert.ok(pixels.visibility.varianceRetention >= 0.42,
      `${scenario} must preserve cel-water variation instead of becoming a solid road: ${JSON.stringify(pixels.visibility)}`);
    assert.ok(pixels.motion.changed >= 120,
      `${scenario} flow packets must visibly advance instead of only changing uniforms: ${JSON.stringify(pixels.motion)}`);
  }
}

async function verifyFlightContract(page) {
  // A fresh page waits forever. Enter is advertised, while Space is the quiet
  // one-hand alternative; R remains retry-only.
  await assertDriverSelectComposition(page, 'desktop-1440x900');
  await verifyDesktopDriverTransition(page);
  await verifyDesktopDriverViewports(page);
  const coldStart = await page.evaluate(() => window.__harness.startGantryStatus());
  assert.equal(coldStart.canvasTextures, 0,
    `START landmark must not depend on a first-load CanvasTexture upload: ${JSON.stringify(coldStart)}`);
  assert.equal(coldStart.glyphInstances, 18,
    `START must expose every authored geometry segment before the first render: ${JSON.stringify(coldStart)}`);
  assert.equal(coldStart.checkerInstances, 48,
    `START must preserve its approach and finish checkers: ${JSON.stringify(coldStart)}`);
  let state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready');
  const readyPose = { x: state.playerX, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime };
  const readyCamera = await page.evaluate(() => window.__harness.stats());
  await page.evaluate(() => window.__harness.advance(1));
  const heldCamera = await page.evaluate(() => window.__harness.stats());
  for (const axis of ['cameraX', 'cameraY', 'cameraZ', 'cameraFov']) {
    assert.ok(Math.abs(Number(heldCamera[axis]) - Number(readyCamera[axis])) < 0.0001,
      `desktop READY camera must remain frozen on ${axis}: ${JSON.stringify({ readyCamera, heldCamera })}`);
  }
  await page.keyboard.press('KeyR');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready', 'R must not start a fresh run');
  assert.equal(state.playerX, readyPose.x);
  assert.equal(state.playerZ, readyPose.z);
  assert.equal(state.raceTime, readyPose.raceTime);
  assert.equal(state.worldTime, readyPose.worldTime);
  await page.keyboard.down('Space');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'countdown', 'Space must start the same full countdown as Enter');
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'countdown');
  await page.evaluate(() => window.__harness.advance(1 / 60));
  assert.equal(await page.locator('.hud-countdown-light.on').count(), 3,
    'the countdown must begin with all three remaining lights on');
  assert.equal(await page.locator('.hud-countdown-label').textContent(), '3');
  const countdownPrimer = await page.evaluate(() => ({
    primer:window.__harness.pcPrimerState(),
    title:document.querySelector('.hud-pc-primer-title')?.textContent ?? '',
    detail:document.querySelector('.hud-pc-primer-detail')?.textContent ?? '',
  }));
  assert.equal(countdownPrimer.primer.presentationStep, 'drift',
    `the first gameplay instruction must be visible during 3-2-1: ${JSON.stringify(countdownPrimer)}`);
  assert.match(`${countdownPrimer.title} ${countdownPrimer.detail}`, /SHIFT.*黄线.*松开.*飞行/,
    'the first instruction must teach the complete Shift -> yellow line -> release -> one stock rule');
  assert.doesNotMatch(`${countdownPrimer.title} ${countdownPrimer.detail}`, /SPACE/,
    'Space must not be taught before a flight stock exists');
  await page.evaluate(() => window.__harness.advance(4.3));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing');
  assert.equal(state.flightPhase, 'surface', 'held Space may confirm READY but must never buffer a launch');
  await page.keyboard.up('Space');
  await page.evaluate(() => window.__harness.advance(0.22));
  await page.locator('.hud-pc-primer').evaluate((element) => {
    getComputedStyle(element).opacity;
    for (const animation of element.getAnimations({ subtree:true })) animation.finish();
  });
  const primer = await page.evaluate(() => {
    const element = document.querySelector('.hud-pc-primer');
    const rect = element.getBoundingClientRect();
    return {
      state:window.__harness.pcPrimerState(),
      role:element.getAttribute('role'),
      label:element.getAttribute('aria-label'),
      key:element.querySelector('.hud-pc-primer-key')?.textContent,
      title:element.querySelector('.hud-pc-primer-title')?.textContent,
      pointerEvents:getComputedStyle(element).pointerEvents,
      className:element.className,
      transform:getComputedStyle(element).transform,
      opacity:getComputedStyle(element).opacity,
      visibility:getComputedStyle(element).visibility,
      rect:{ left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom },
    };
  });
  assert.equal(primer.state.presentationStep, 'drift', 'the first fresh PC run must begin with drift, not flight inventory');
  assert.equal(primer.state.visible, true);
  assert.equal(primer.role, 'note');
  assert.equal(primer.key, 'SHIFT');
  assert.match(`${primer.title} ${primer.label}`, /SHIFT.*不放/,
    'the first keyboard hint must make the physical hold explicit');
  assert.equal(primer.pointerEvents, 'none', 'the primer body must never intercept driving input');
  assert.ok(primer.rect.left >= 0 && primer.rect.right < 480 && primer.rect.bottom <= 900,
    `the keyboard primer must stay in the quiet lower-left lane: ${JSON.stringify(primer)}`);
  assert.equal(await page.locator('.hud-coach.on').count(), 0,
    'the first-run primer must remain non-modal and must not arm the failure coach');
  for (const viewport of [
    { width:1366, height:650 },
    { width:1536, height:700 },
    { width:1920, height:900 },
    { width:2560, height:1440 },
    { width:3440, height:1440 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const rect = (selector) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value && { left:value.left, right:value.right, top:value.top, bottom:value.bottom };
      };
      return { primer:rect('.hud-pc-primer'), power:rect('.hud-power') };
    });
    assert.ok(layout.primer.left >= 0 && layout.primer.bottom <= viewport.height,
      `primer must remain inside ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
    assert.ok(layout.primer.right + 24 < layout.power.left,
      `primer must stay clear of the bottom power HUD at ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
  }
  await page.setViewportSize({ width:1440, height:900 });
  await page.emulateMedia({ reducedMotion:'reduce' });
  const reducedPrimer = await page.locator('.hud-pc-primer').evaluate((element) => ({
    transform:getComputedStyle(element).transform,
    transition:getComputedStyle(element).transitionDuration,
  }));
  assert.equal(reducedPrimer.transform, 'none', 'reduced motion must remove primer movement');
  assert.match(reducedPrimer.transition, /(^|, )0s/, 'reduced motion must remove primer transitions');
  await page.emulateMedia({ reducedMotion:'no-preference' });
  const primerSequence = await page.evaluate(() => window.__harness.pcPrimerCase());
  assert.deepEqual(primerSequence.steps,
    ['drift', 'charging', 'release', 'banked', 'banked', 'waiting-launch', 'launch', 'success', 'off'],
    `primer progress must follow accepted bank and launch state edges: ${JSON.stringify(primerSequence)}`);
  assert.equal(primerSequence.active, false);
  assert.equal(primerSequence.comboStep, 'success',
    'same-frame Shift release + Space launch must use accepted spool state, not the net inventory count');
  assert.equal(primerSequence.coachComboLaunched, true,
    'the contextual coach must learn the same accepted combo launch without requiring a net inventory drop');
  assert.equal(primerSequence.coachLaunchStep, 'launch',
    'the contextual coach must teach SPACE at the authored launch cue, before the branch is already airborne');
  await page.locator('.hud-pc-primer-close').click();
  await page.evaluate(() => window.__harness.advance(1 / 30));
  const dismissedPrimer = await page.evaluate(() => window.__harness.pcPrimerState());
  assert.equal(dismissedPrimer.step, 'dismissed', 'the first-run hint must be dismissible immediately');
  assert.equal(dismissedPrimer.visible, false);
  const dismissedCoach = await page.evaluate(() => window.__harness.coachState());
  assert.equal(dismissedCoach.mastery.bankedCharge, false,
    'closing the legend must never claim that a real charge was banked');
  assert.equal(dismissedCoach.knowledge.bankRule, true,
    'closing the legend must persist its acknowledgement');
  assert.equal(dismissedCoach.automaticEligible, true,
    'closing the lightweight legend must not disable the first-failure coach');

  await page.evaluate(() => window.__harness.scenario('countdown'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(await page.locator('.hud-pc-primer.on').count(), 0,
    'a deliberately dismissed primer must not revive on the next fresh countdown');
  assert.equal(state.place, 4, 'player must start fourth');
  assert.equal(state.totalRacers, 6, 'the challenge must field six racers');
  assert.equal(await page.locator('.hud-countdown-light').count(), 3);
  assert.equal(await page.locator('.hud-countdown-light.on').count(), 2,
    'the visual start rail must mirror the mid-countdown number without spoken numerals');
  assert.equal(await page.locator('.hud-countdown-label').textContent(), '2');
  await page.evaluate(() => window.__harness.advance(1.4));
  assert.equal(await page.locator('.hud-countdown-light.on').count(), 1,
    'one red lamp must remain at 1');
  assert.equal(await page.locator('.hud-countdown-label').textContent(), '1');
  await page.evaluate(() => window.__harness.advance(1.15));
  assert.equal(await page.locator('.hud-countdown-light.on').count(), 0,
    'GO releases the start with every red lamp dark');
  assert.equal(await page.locator('.hud-countdown-label').textContent(), 'GO!');

  await page.evaluate(() => window.__harness.scenario('start'));
  await page.evaluate(() => {
    window.__harness.setPlayerInput({ throttle: 1, flightTrigger: true });
    window.__harness.advance(1 / 60);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, false, 'flight without a qualifying drift must not create a charge');
  assert.equal(state.flightPhase, 'surface', 'flight without a charge must stay on the surface');
  assert.equal(state.flightDenied, true, 'a rejected flight press must emit feedback');

  // Backgrounding is a hard pause. Returning requires an explicit GO and a
  // fresh full countdown before this exact run resumes.
  const interruptedRace = {
    x: state.playerX, y: state.playerY, z: state.playerZ,
    raceTime: state.raceTime, worldTime: state.worldTime,
  };
  await page.evaluate(() => window.__harness.setVisibility(true));
  await page.evaluate(() => window.__harness.advance(1));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.interruptionActive, true);
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    interruptedRace,
    'backgrounding must freeze the full race state',
  );
  const hiddenAudio = await page.evaluate(() => window.__harness.audioState());
  assert.equal(hiddenAudio.scene, 'hidden');
  assert.equal(hiddenAudio.outputGain, 0, 'background audio output must stop immediately');
  await page.evaluate(() => window.__harness.setVisibility(false));
  assert.equal(await page.locator('.hud-interruption').evaluate((el) => el.classList.contains('on')), true);
  await page.evaluate(() => window.__harness.advance(0.5));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    interruptedRace,
    'returning to the foreground must remain frozen before GO',
  );
  await page.keyboard.press('Space');
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'resume-countdown', 'Space must also resume a background-frozen run');
  assert.equal(state.interruptionActive, false);
  await page.evaluate(() => window.__harness.advance(2));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    interruptedRace,
    'background resume countdown must keep the race frozen',
  );
  await page.evaluate(() => window.__harness.advance(2.25));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'racing');

  // The first run is a clean skill check. Its first real failure arms a light,
  // immediately skippable coach for the next run.
  const freshCoach = await page.evaluate(() => window.__harness.coachState());
  assert.equal(freshCoach.status, 'dormant');
  assert.equal(freshCoach.automaticEligible, true);
  assert.equal(await page.locator('.hud-coach.on').count(), 0, 'the first run must add no modal spotlight tutorial');
  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(await page.locator('.hud-results').evaluate((el) => el.classList.contains('on')), false,
    'failure must bypass the old result modal');
  await page.evaluate(() => window.__harness.advance(0.6));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.retryLessonActive, true, 'failure must enter its focused review automatically');
  assert.ok(Math.abs(state.retryLessonDuration - 5) < 0.05, `failure review duration ${state.retryLessonDuration}`);
  assert.equal(state.retryLessonMinRead, 0, 'failure review must be skippable from its first frame');
  assert.equal(state.coachStatus, 'active', 'the first real failure arms the spotlight guide');
  assert.equal((await page.evaluate(() => window.__harness.coachState())).automaticEligible, false,
    'the first real failure permanently consumes the automatic invitation');
  assert.equal(await page.locator('.hud-lesson-disable:visible').count(), 1, 'first failure exposes a permanent close choice');
  assert.equal(await page.locator('.hud-lesson-continue').textContent(), '带标注再冲');
  assert.equal(await page.locator('.hud-lesson-disable').textContent(), '不用引导');
  await page.locator('.hud-lesson-continue').click();
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready', 'first-frame continue returns to READY, never directly to countdown');
  await page.evaluate(() => window.__harness.advance(0.5));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'ready', 'READY requires a fresh confirmation edge');

  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.setCoachEnabled(true);
  });
  await page.evaluate(() => {
    for (let i = 0; i < 20 && !window.__harness.playerState().coachVisible; i++) window.__harness.advance(0.15);
  });
  await page.locator('.hud-pc-primer').evaluate((element) => {
    getComputedStyle(element).opacity;
    for (const animation of element.getAnimations({ subtree:true })) animation.finish();
  });
  await page.evaluate(() => window.__harness.advance(1 / 60));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).coachVisible, true);
  const coachSpotlight = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value && { left:value.left, right:value.right, top:value.top, bottom:value.bottom };
    };
    return {
      coach:window.__harness.coachState(),
      title:document.querySelector('.hud-coach-title')?.textContent,
      control:document.querySelector('.hud-coach-control')?.textContent,
      internalControlHidden:document.querySelector('.hud-coach-control')?.hidden,
      spotlight:rect('.hud-coach-spotlight.on'),
      controlRect:rect('.hud-pc-primer-key'),
      anchorTitle:document.querySelector('.hud-pc-primer-title')?.textContent,
    };
  });
  assert.equal(coachSpotlight.coach.activeStep, 'drift', 'the first missing core action must teach PC drift');
  assert.equal(coachSpotlight.coach.focus, 'drift-control');
  assert.match(`${coachSpotlight.title} ${coachSpotlight.control}`, /SHIFT/,
    'desktop drift onboarding must make the Shift control unmistakable');
  assert.equal(coachSpotlight.internalControlHidden, true,
    'desktop drift coaching must not duplicate a fake keycap inside its annotation card');
  assert.match(coachSpotlight.anchorTitle ?? '', /SHIFT/,
    'the lower-left live anchor must carry the coached Shift action');
  assert.ok(coachSpotlight.spotlight && coachSpotlight.controlRect &&
    coachSpotlight.spotlight.left <= coachSpotlight.controlRect.left &&
    coachSpotlight.spotlight.right >= coachSpotlight.controlRect.right,
  `the spotlight must frame the live Shift keycap: ${JSON.stringify(coachSpotlight)}`);
  const chargesBeforeDismiss = (await page.evaluate(() => window.__harness.playerState())).flightCharges;
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.coachStatus, 'disabled', 'Escape permanently closes the spotlight guide');
  assert.equal(state.coachVisible, false);
  assert.equal(state.flightPhase, 'surface', 'closing a hint cannot buffer or trigger flight');
  assert.equal(state.flightCharges, chargesBeforeDismiss);

  await page.evaluate(() => window.__harness.scenario('start'));
  await page.evaluate(() => window.__harness.advance(0.2));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.coachStatus, 'disabled');
  assert.equal(state.coachVisible, false);
  await page.evaluate(() => window.__harness.setCoachEnabled(true));
  await page.evaluate(() => {
    for (let i = 0; i < 20 && !window.__harness.playerState().coachVisible; i++) window.__harness.advance(0.15);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.coachStatus, 'active');
  assert.notEqual(state.coachStep, 'none', 'READY help can re-enable the remaining spotlight curriculum');

  // Surface abandonment uses the same terminal pipeline as a flight miss. A
  // brief collision excursion gets a recovery window, but sustained departure
  // or deliberate reverse driving cannot continue forever in open water.
  await page.evaluate(() => window.__harness.scenario('surface-off-course-grace'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing', 'a sub-0.8s course-edge excursion must remain recoverable');
  assert.equal(state.courseWarning, 'none', 'returning to the circuit must clear the course warning');

  await page.evaluate(() => window.__harness.scenario('surface-off-course'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated', 'sustained surface course abandonment must be terminal');
  assert.equal(state.challengeReason, 'off_course');
  assert.equal(state.flightFailureTargetGateRaw, null,
    'surface course abandonment must not invent a portal target');
  assert.equal(state.challengeGate, 0,
    'surface course abandonment is not a gate result');
  assert.equal(state.flightFailureLateralOffsetM, null);
  assert.equal(state.flightFailureLateralLimitM, null);
  assert.ok((state.flightFailureCorridorDistanceM ?? 0) >= 42,
    `surface abandonment must retain its route distance evidence: ${JSON.stringify(state)}`);
  await page.evaluate(() => window.__harness.advance(0.6));
  assert.match(await page.locator('.hud-lesson-title').textContent() ?? '', /偏离绿色主线/);
  assert.equal(await page.locator('.hud-lesson-disable:visible').textContent(), '不用引导',
    'every failure while the guide is active must retain a direct opt-out');

  await page.evaluate(() => window.__harness.scenario('surface-wrong-way'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated', 'sustained reverse driving must be terminal');
  assert.equal(state.challengeReason, 'wrong_way');
  assert.equal(state.flightFailureTargetGateRaw, null,
    'surface reverse must not invent a portal target');
  assert.equal(state.challengeGate, 0,
    'surface reverse is not a gate result');
  assert.equal(state.flightFailureLateralOffsetM, null);
  assert.equal(state.flightFailureLateralLimitM, null);
  assert.equal(state.flightFailureCorridorDistanceM, null,
    'reverse evidence must not be mislabeled as a corridor distance');

  const surfaceEnforcement = await page.evaluate(() => window.__harness.surfaceRouteEnforcementCase());
  assert.equal(surfaceEnforcement.cut.finalStationArmed, false,
    `surface route enforcement must run before Final is armed: ${JSON.stringify(surfaceEnforcement)}`);
  assert.equal(surfaceEnforcement.cut.flightRouteState, 'idle',
    'the second-flight shortcut fixture must remain a surface-route case');
  assert.equal(surfaceEnforcement.cut.phase, 'defeated',
    `crossing continuously from flight two to a non-adjacent green segment must be terminal: ${JSON.stringify(surfaceEnforcement)}`);
  assert.equal(surfaceEnforcement.cut.reason, 'off_course');
  assert.ok(surfaceEnforcement.cut.warningFrames > 0,
    `a cross-course cut must present a stable correction before defeat: ${JSON.stringify(surfaceEnforcement)}`);
  assert.ok(surfaceEnforcement.cut.travelled < surfaceEnforcement.cut.distance,
    `the route cut must fail before reaching and adopting the later segment: ${JSON.stringify(surfaceEnforcement)}`);
  assert.equal(surfaceEnforcement.cut.checkpointDelta, 0,
    'an illegal projection switch must not emit checkpoint events');
  assert.equal(surfaceEnforcement.facing.finalStationArmed, false);
  assert.equal(surfaceEnforcement.facing.phase, 'racing',
    'the wrong-way banner must appear before its longer terminal window');
  assert.equal(surfaceEnforcement.facing.warning, 'wrong_way',
    `a visibly reversed hull must stay warned while inertia still slides forward: ${JSON.stringify(surfaceEnforcement)}`);
  assert.ok(surfaceEnforcement.facing.warningFrame >= 40 && surfaceEnforcement.facing.warningFrame <= 46,
    `wrong-way onset must remain near the authored 0.7s hold: ${JSON.stringify(surfaceEnforcement)}`);

  await page.evaluate(() => window.__harness.scenario('surface-flight-off-course'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(state.challengeReason, 'off_course',
    'being beyond the green-route hard edge must not be mislabeled as a missed launch');
  assert.equal(state.flightFailureTargetGateRaw, null);
  assert.equal(state.challengeGate, 0);

  await page.evaluate(() => window.__harness.scenario('flight-stock-away'));
  assert.equal(await page.locator('.hud-flight-prompt.on').count(), 0,
    'banking a stock away from a launch cue must not flash an upper-right SPACE prompt');
  await page.evaluate(() => window.__harness.scenario('flight-ready'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, true, 'a qualifying Shift release must earn a flight charge');
  assert.equal(state.flightPhase, 'surface');
  assert.match(await page.locator('.hud-flight-prompt').textContent() ?? '', /SPACE.*起飞/,
    'earned-flight prompt must use the new Space mapping');
  const promptGeometry = await page.locator('.hud-flight-prompt').evaluate((prompt) => {
    const key = prompt.querySelector('.hud-keycap').getBoundingClientRect();
    const copy = prompt.querySelector('.hud-flight-prompt-copy').getBoundingClientRect();
    return { keyWidth: key.width, keyScrollWidth: prompt.querySelector('.hud-keycap').scrollWidth, keyRight: key.right, copyLeft: copy.left };
  });
  assert.ok(promptGeometry.keyWidth >= 64, `SPACE key cap collapsed to ${promptGeometry.keyWidth}px`);
  assert.ok(promptGeometry.keyScrollWidth <= promptGeometry.keyWidth + 1, 'SPACE text must not overflow its key cap');
  assert.ok(promptGeometry.keyRight <= promptGeometry.copyLeft, 'SPACE key cap must not overlap the flight copy');
  const promptOverlaps = await page.evaluate(() => {
    const prompt = document.querySelector('.hud-flight-prompt.on')?.getBoundingClientRect();
    if (!prompt) return ['missing flight prompt'];
    const selectors = ['.race-tower.on', '.hud-topleft', '.audio-mixer.visible'];
    return selectors.flatMap((selector) => {
      const node = document.querySelector(selector);
      if (!node) return [];
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return [];
      const rect = node.getBoundingClientRect();
      const width = Math.min(prompt.right, rect.right) - Math.max(prompt.left, rect.left);
      const height = Math.min(prompt.bottom, rect.bottom) - Math.max(prompt.top, rect.top);
      return width > 1 && height > 1 ? [`${selector}:${width.toFixed(1)}x${height.toFixed(1)}`] : [];
    });
  });
  assert.deepEqual(promptOverlaps, [], `flight prompt overlap: ${promptOverlaps.join(', ')}`);
  await page.evaluate(() => window.__harness.advance(2.2));
  assert.equal(await page.locator('.hud-flight-prompt.on').count(), 0,
    'one launch cue may create only one bounded SPACE presentation');
  await page.evaluate(() => window.__harness.advance(0.35));
  assert.equal(await page.locator('.hud-flight-prompt.on').count(), 0,
    'the same still-actionable launch cue must not restart the prompt after its reading window');

  await page.evaluate(() => window.__harness.scenario('drift-charge'));
  const driftAudio = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(driftAudio.driftTier) >= 1, `a real drift must cross a readable charge tier: ${JSON.stringify(driftAudio)}`);

  // Drift qualification is short and explicit: a tap remains invalid, while a
  // deliberate ~0.35s hold reaches the shared release-ready state.
  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.setPlayerInput({ throttle: 1, drift: true });
    window.__harness.advance(0.29);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.driftReleaseReady, false, 'a short drift tap must not earn flight');
  await page.evaluate(() => window.__harness.advance(0.08));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.driftReleaseReady, true, 'the release threshold must be readable by about 0.35s');
  assert.equal(await page.locator('.hud-boost').evaluate((el) => el.classList.contains('release-ready')), true);
  await page.evaluate(() => {
    window.__harness.setPlayerInput({ throttle: 1 });
    window.__harness.advance(1 / 30);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1, 'releasing after the threshold must earn exactly one charge');

  // Each distinct release earns one launch, and one launch consumes one cell.
  // The five-cell boundary runs last so its extra fixed steps cannot alter the
  // deterministic wave phase of later route and Final contracts.
  await page.evaluate(() => window.__harness.earnFlight(false));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 2, 'a second qualifying drift must add exactly one launch cell');
  await page.evaluate(() => window.__harness.earnFlight(false));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 3,
    'a third qualifying drift must no longer be clipped by the retired two-cell cap');
  assert.equal(state.boosting, true, 'earning another inventory cell must preserve the drift boost payout');
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 2, 'one launch must consume exactly one stored charge');
  assert.notEqual(state.flightPhase, 'surface');

  await page.evaluate(() => window.__harness.scenario('opponent-drift'));
  let opponentFx = await page.evaluate(() => window.__harness.opponentFx());
  const leadHoldEvidence = await page.evaluate(() => [
    window.__harness.rivalChainState(0),
    window.__harness.rivalChainState(1),
  ]);
  assert.ok(leadHoldEvidence.every((item) => item.holdStarts >= 1 && item.drifting && item.burstStrength === 0),
    `real drift holds must not leave a cosmetic exhaust loop: ${JSON.stringify(leadHoldEvidence)}`);
  assert.equal(opponentFx.activeBursts, 0,
    `a hold must stay visually quiet until a real BOOST release: ${JSON.stringify(opponentFx)}`);
  assert.ok(opponentFx.minBurstScale >= 0 && opponentFx.maxBurstScale <= 1,
    `opponent burst LOD must remain bounded: ${JSON.stringify(opponentFx)}`);
  assert.ok(opponentFx.wakeScale >= 0.66 && opponentFx.wakeScale <= 0.7,
    `ordinary rival wake must retain water volume while yielding to the chain cue: ${JSON.stringify(opponentFx)}`);
  let chainFx = await page.evaluate(() => {
    const h = window.__harness;
    let state = h.rivalChainState(0);
    for (let frame = 0; frame < 150 && !(state.drifting && state.holdStarts >= 1); frame++) {
      h.advance(1 / 60);
      state = h.rivalChainState(0);
    }
    return state;
  });
  const startingCycles = chainFx.boostCycles;
  const startingReleaseBeats = chainFx.releaseBeats;
  const startingHoldStarts = chainFx.holdStarts;
  assert.ok(chainFx.drifting && chainFx.burstStrength === 0,
    `the hold frame must remain free of detached exhaust: ${JSON.stringify(chainFx)}`);
  for (let frame = 0; frame < 120 &&
      !(chainFx.releaseBeats > startingReleaseBeats && chainFx.boosting && !chainFx.drifting); frame++) {
    await page.evaluate(() => window.__harness.advance(1 / 60));
    chainFx = await page.evaluate(() => window.__harness.rivalChainState(0));
  }
  assert.ok(chainFx.releaseBeats > startingReleaseBeats && chainFx.boosting && !chainFx.drifting &&
    chainFx.phase === 'release' && chainFx.burstStrength > 0 && chainFx.burstActive,
    `a real drift release must create the short stern pulse: ${JSON.stringify(chainFx)}`);
  for (let frame = 0; frame < 150 &&
      !(chainFx.holdStarts > startingHoldStarts && chainFx.drifting && chainFx.burstStrength === 0); frame++) {
    await page.evaluate(() => window.__harness.advance(1 / 60));
    chainFx = await page.evaluate(() => window.__harness.rivalChainState(0));
  }
  assert.ok(chainFx.boostCycles > startingCycles && chainFx.holdStarts > startingHoldStarts && chainFx.drifting &&
    chainFx.burstStrength === 0,
  `a lead rival must re-enter a clean real hold after the burst: ${JSON.stringify(chainFx)}`);
  await page.evaluate(() => window.__harness.scenario('ready'));
  chainFx = await page.evaluate(() => window.__harness.rivalChainState(0));
  assert.equal(chainFx.burstActive, false,
    `READY reset must clear every drift-release burst: ${JSON.stringify(chainFx)}`);

  await page.evaluate(() => window.__harness.scenario('flight-combo'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightReady, false, 'launch must consume the charge');
  assert.equal(state.boosting, true, 'drift boost must survive a same-frame flight launch');
  assert.notEqual(state.flightPhase, 'surface', 'same-frame drift release + flight must launch');

  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.earnFlight(false);
    window.__harness.earnFlight(false);
    window.__harness.setPlayerInput({ throttle: 1, drift: true });
    window.__harness.advance(0.62);
    window.__harness.setPlayerInput({ throttle: 1, flightTrigger: true });
    window.__harness.advance(1 / 60);
    window.__harness.setPlayerInput(null);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 2,
    'same-frame qualifying release/launch must add one and spend one without losing existing stock');

  await page.evaluate(() => window.__harness.scenario('flight-cruise'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'cruise');
  assert.ok(state.flightClearance > 4 && state.flightClearance < 6.5, `cruise clearance ${state.flightClearance}`);
  assert.ok(state.flightRemaining > 0 && state.flightRemaining < 1);
  assert.ok(state.speed >= 40 && state.speed <= 43, `first flight cruise speed ${state.speed}`);
  assert.ok(state.flightPressure > 0.25, `flight pressure ${state.flightPressure}`);
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'flight');
  assert.ok(state.flightFxRings >= 8, `controlled flight must open the vortex rings: ${state.flightFxRings}`);
  assert.ok(state.flightFxPlumeLength < 2.8, `flight core must remain a short plume, not a beam: ${state.flightFxPlumeLength}`);
  assert.equal(await page.locator('.hud-flight-token.active').count(), state.flightCharges,
    'an active flight must light exactly its real spare inventory, never every stock cell');
  const flightStats = await page.evaluate(() => window.__harness.stats());
  assert.ok(flightStats.cameraFov >= 77 && flightStats.cameraFov <= 86, `flight FOV ${flightStats.cameraFov}`);
  const guidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(guidance.visibleRouteCount, 1, 'only the current player flight guide may be visible');
  assert.equal(guidance.activeRouteIndex, 0);
  assert.equal(guidance.surfaceMaskRouteIndex, 0, 'the green surface ribbon must be masked through the active detour');
  assert.ok(guidance.targetGateDistance > 0, `the unique target gate must expose a real distance: ${JSON.stringify(guidance)}`);
  assert.ok(guidance.targetAnchorScale >= 1 && guidance.targetAnchorScale <= 1.75,
    `the visual locator must stay bounded: ${JSON.stringify(guidance)}`);

  // The spare stored cell becomes a deliberate airborne extension. It must
  // reject launch double-taps, become explicit at cruise, consume exactly one
  // cell, increase remaining airtime, and refuse any second extension.
  await page.evaluate(() => window.__harness.scenario('flight-extension-spool'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1, 'a second press during spool/ascending must not consume the spare cell');
  assert.equal(state.flightExtensionUsed, false);
  assert.equal(state.flightDenied, true, 'an early double-tap needs explicit rejection feedback');

  await page.evaluate(() => window.__harness.scenario('flight-extension-ready'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'cruise');
  assert.equal(state.flightCharges, 4);
  assert.equal(state.flightExtensionReady, true);
  assert.equal(state.flightExtensionUsed, false);
  assert.deepEqual(await page.evaluate(() => ({
    count:document.querySelector('.hud-flight-count')?.textContent ?? '',
    ready:document.querySelectorAll('.hud-flight-token.ready').length,
    active:document.querySelectorAll('.hud-flight-token.active').length,
  })), { count:'x4', ready:4, active:4 },
  'airborne stock styling must match the four real spare cells');
  assert.equal(await page.locator('.hud-flight-prompt.on').count(), 1,
    'the first actionable extension window must own exactly one SPACE prompt');
  assert.match(await page.locator('.hud-flight-prompt').textContent() ?? '', /SPACE.*续航.*\+2\.4/,
    'desktop HUD must make the airborne use of the spare cell explicit');
  const remainingBeforeExtension = state.flightRemaining;
  const routeProgressBeforeExtension = state.flightGateProgress;
  const audioExtensionsBefore = Number((await page.evaluate(() => window.__harness.audioState())).flightExtendEvents);
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightExtended, true, 'the accepted Space edge must expose a one-frame extension pulse');
  assert.equal(state.flightCharges, 3, 'airborne extension consumes exactly one stored cell');
  assert.equal(state.flightExtensionUsed, true);
  assert.equal(state.flightExtensionReady, false);
  assert.equal(state.flightPhase, 'cruise');
  assert.ok(state.flightRemaining > remainingBeforeExtension,
    `extension must add real envelope time: ${remainingBeforeExtension} -> ${state.flightRemaining}`);
  assert.equal(state.flightGateProgress, routeProgressBeforeExtension, 'extension must never reset portal progress');
  assert.equal(Number((await page.evaluate(() => window.__harness.audioState())).flightExtendEvents), audioExtensionsBefore + 1,
    'accepted extension needs exactly one dedicated sound event');
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightDenied, true, 'a current flight can be extended at most once');
  assert.equal(state.flightExtensionUsed, true);
  assert.equal(state.flightCharges, 3,
    'a rejected second extension must preserve spare inventory even when several cells remain');

  await page.evaluate(() => window.__harness.scenario('flight-extension-descent'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'descending');
  assert.equal(state.flightExtensionReady, true, 'a spare cell must remain usable during descent');
  const descentClearance = state.flightClearance;
  const descentRemaining = state.flightRemaining;
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'cruise', 'late extension must return to the cruise envelope without teleporting');
  assert.equal(state.flightCharges, 0);
  assert.equal(state.flightExtensionUsed, true);
  assert.ok(state.flightRemaining > descentRemaining, 'late extension must add real remaining time');
  assert.ok(Math.abs(state.flightClearance - descentClearance) < 0.5,
    `late extension may arrest descent but must never snap altitude: ${descentClearance} -> ${state.flightClearance}`);

  const budget = await page.evaluate(() => window.__harness.flightBudgetCase());
  assert.ok(Math.abs(budget.envelope.descendAt - 5.7) < 0.001, `flight descent envelope ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.total - 6.45) < 0.001, `flight total envelope ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.extension - 2.4) < 0.001, `flight extension ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.extendedDescendAt - 8.1) < 0.001,
    `extended descent envelope ${JSON.stringify(budget.envelope)}`);
  assert.ok(Math.abs(budget.envelope.extendedTotal - 8.85) < 0.001,
    `extended total envelope ${JSON.stringify(budget.envelope)}`);
  assert.equal(budget.routes.length, 7);
  for (const route of budget.routes) {
    assert.ok(route.earliestToGate >= 140 && route.earliestToGate <= 152,
      `route ${route.index + 1} launch budget must stay comparable: ${JSON.stringify(route)}`);
    assert.ok(route.latestToGate > 75 && route.latestToGate < route.earliestToGate,
      `route ${route.index + 1} latest launch must retain a real approach: ${JSON.stringify(route)}`);
    assert.ok(route.secondsAt29 <= 5.2,
      `route ${route.index + 1} must pass before descent at sustained air-brake speed: ${JSON.stringify(route)}`);
    assert.ok(route.gateToExit >= 30,
      `route ${route.index + 1} must leave enough authored landing distance: ${JSON.stringify(route)}`);
  }
  // The old helper stopped three frames after the portal and teleported into
  // the next setup. These cases stage once, then preserve the real velocity
  // through descent, water contact, authored recovery and surface handoff.
  for (let route = 3; route < 7; route++) {
    await page.evaluate(() => window.__harness.scenario('start'));
    const recovery = await page.evaluate((index) => window.__harness.flightRecoveryCase(index), route);
    assert.equal(recovery.phase, 'racing', `flight ${route + 1} recovery must not defeat a valid line: ${JSON.stringify(recovery)}`);
    assert.equal(recovery.routeState, 'idle', `flight ${route + 1} must hand back to the surface route: ${JSON.stringify(recovery)}`);
    assert.equal(recovery.sawPassed, true);
    assert.equal(recovery.sawSurfaceRecovery, true, `flight ${route + 1} must retain ownership after water contact`);
    assert.equal(recovery.handoffCount, 1, `flight ${route + 1} route ownership must switch exactly once`);
    assert.equal(recovery.warningFrames, 0, `flight ${route + 1} inertia must not pre-arm a course warning`);
    assert.equal(recovery.routePasses, 1);
    assert.equal(recovery.routeFails, 0);
    assert.ok(recovery.maxVisibleRoutes <= 1, `only one player-owned guide may render: ${JSON.stringify(recovery)}`);
    assert.equal(recovery.sawRecoveryGuide, true, `flight ${route + 1} must switch to the recovery visual grammar`);
    assert.ok(recovery.maxRecoveryArrows >= 2, `flight ${route + 1} must expose directional recovery markers: ${JSON.stringify(recovery)}`);
    assert.ok(recovery.maxStep < 1.5, `flight ${route + 1} must never teleport during recovery: ${JSON.stringify(recovery)}`);
    assert.ok(recovery.minPlanarSpeed > 3, `flight ${route + 1} must preserve planar inertia: ${JSON.stringify(recovery)}`);
    assert.ok(recovery.minProgressDelta > -2, `flight ${route + 1} merge must not jump progress backwards: ${JSON.stringify(recovery)}`);
  }

  const medalRecovery = await page.evaluate(() => window.__harness.medalRecoveryCase());
  assert.equal(medalRecovery.phaseAtPass, 'medal',
    `the third portal must enter the medal freeze before recovery resumes: ${JSON.stringify(medalRecovery)}`);
  assert.equal(medalRecovery.phase, 'racing',
    `a delayed but valid left correction after the medal must remain playable: ${JSON.stringify(medalRecovery)}`);
  assert.equal(medalRecovery.routeState, 'idle');
  assert.equal(medalRecovery.flightPhase, 'surface');
  assert.equal(medalRecovery.flightsCleared, 3);
  assert.ok(medalRecovery.freezePositionDelta < 0.001,
    `medal and resume countdown must freeze the hull: ${JSON.stringify(medalRecovery)}`);
  assert.ok(Math.abs(medalRecovery.freezeWorldDelta) < 0.001);
  assert.ok(Math.abs(medalRecovery.freezeRaceDelta) < 0.001);
  assert.ok(Math.abs(medalRecovery.freezeRecoveryDelta) < 0.001);
  assert.equal(medalRecovery.sawSurfaceRecovery, true,
    'the third branch must retain ownership after touching water');
  assert.equal(medalRecovery.recoveryOwnerBeforeWater, true,
    'the third recovery guide must own the descent before water contact');
  assert.equal(medalRecovery.recoveryOwnerAfterWater, true,
    'the same third recovery guide must remain visible after water contact');
  assert.equal(medalRecovery.routeFourPreviewBeforeHandoff, false,
    'flight four must not replace the recovery visual before its authored handoff');
  assert.equal(medalRecovery.sawPostThirdTurnGuidance, true,
    'the flowing surface route must expose the sharp post-third turn in advance');
  assert.ok(medalRecovery.postThirdTurnLeadSeconds >= 1.8,
    `the route-embedded turn beat needs a conservative reaction window: ${JSON.stringify(medalRecovery)}`);
  assert.ok(medalRecovery.maxTurnArrowsBeforeWater >= 3);
  assert.ok(medalRecovery.maxTurnArrowsAfterWater >= 3);
  assert.equal(medalRecovery.handoffCount, 1,
    'the third branch must hand navigation to the surface exactly once');
  assert.equal(medalRecovery.warningFrames, 0,
    `valid third-flight inertia must not flash an off-course banner: ${JSON.stringify(medalRecovery)}`);
  assert.equal(medalRecovery.warningEvents, 0,
    'a visually suppressed warning must not still emit warning haptics');
  assert.ok(medalRecovery.maxVisibleRoutes <= 1);
  assert.ok(medalRecovery.maxStep < 1.5,
    `medal recovery must preserve continuous motion without teleporting: ${JSON.stringify(medalRecovery)}`);
  assert.equal(medalRecovery.routePasses, 1);
  assert.equal(medalRecovery.routeFails, 0);
  assert.equal(medalRecovery.finalArmed, false,
    'third-flight recovery must never borrow the Final free-route exemption');

  const route45 = await page.evaluate(() => window.__harness.route45ContinuousCase());
  assert.equal(route45.phase, 'racing', `the fourth-to-fifth journey must remain live: ${JSON.stringify(route45)}`);
  assert.equal(route45.flightsCleared, 5, `both gates must be earned without restaging: ${JSON.stringify(route45)}`);
  assert.equal(route45.routePasses, 2);
  assert.equal(route45.routeFails, 0);
  assert.equal(route45.sawRouteFourPassed, true);
  assert.equal(route45.sawRouteFourSurfaceRecovery, true,
    'flight four must really land before the fifth-flight preparation window');
  assert.equal(route45.sawRouteFourHandoff, true,
    'the fifth-flight cue may not skip the authored recovery ownership');
  assert.equal(route45.sawBankCue, true, 'the green line must expose drift preparation before flight five');
  assert.equal(route45.sawLaunchCue || route45.routeFiveChargeEdges >= 1, true,
    'a stored charge must either expose the armed launch beat or be spent by the valid same-frame bank-to-launch edge');
  assert.ok(route45.cueLeadSeconds >= 1.2,
    `route guidance needs a human reaction window before launch: ${JSON.stringify(route45)}`);
  assert.ok(route45.routeFiveChargeEdges >= 1,
    `flight five must be earned through a real drift release: ${JSON.stringify(route45)}`);
  assert.equal(route45.routeFourLandingBridged, true,
    `held air brake must become drift on flight four's exact landing frame: ${JSON.stringify(route45)}`);
  assert.ok(route45.routeFourLandingCharge > 0 && route45.routeFourLandingCharge < 0.08,
    `continuous route four-to-five play must start with one fixed drift step: ${JSON.stringify(route45)}`);
  assert.ok(route45.routeFourLandingBrakeEnvelope < 0.001,
    `route four landing may not carry air-brake damping into the fifth-flight bank: ${JSON.stringify(route45)}`);
  assert.ok(route45.airBrakeLatencySeconds >= 0 && route45.airBrakeLatencySeconds <= 0.35,
    `air brake must engage promptly after the real fifth launch: ${JSON.stringify(route45)}`);
  assert.equal(route45.warningFrames, 0);
  assert.ok(route45.maxVisibleRoutes <= 1);
  assert.ok(route45.maxStep < 1.5, `continuous route four-to-five motion may not teleport: ${JSON.stringify(route45)}`);
  assert.equal(route45.finalArmed, false, 'flight-five guidance must not borrow Final state');

  // Seventh-flight certification changes the objective atomically: the
  // authored recovery still plays, then the green route becomes optional and
  // only the visible gold portal can finish the run.
  const finalApproach = await page.evaluate(() => window.__harness.finalApproachCase());
  assert.equal(finalApproach.armedAtPass, true, `seventh pass must arm Final immediately: ${JSON.stringify(finalApproach)}`);
  assert.equal(finalApproach.phaseAfterExcursion, 'racing', 'free Final approach must not be defeated off-route');
  assert.equal(finalApproach.routeStateAfterExcursion, 'idle');
  assert.equal(finalApproach.flightPhaseAfterExcursion, 'surface');
  assert.equal(finalApproach.sawSurfaceRecovery, true, 'route seven must retain recovery ownership through water contact');
  assert.equal(finalApproach.sawHandoff, true, 'route seven must hand off before free approach');
  assert.equal(finalApproach.finalLandingObserved, true);
  assert.equal(finalApproach.finalLandingDrifting, false,
    'Final Shift remains return brake and must never bridge into drift');
  assert.equal(finalApproach.finalLandingBoostCharge, 0,
    'Final water contact may not manufacture drift charge');
  assert.ok(finalApproach.finalLandingBrakeEnvelope > 0.7,
    `Final must preserve its return-brake envelope through water contact: ${JSON.stringify(finalApproach)}`);
  assert.ok(finalApproach.recoveryFrames > 0);
  assert.ok(finalApproach.maxRouteDistance >= 48,
    `the contract must actually leave the old 42m fail corridor: ${JSON.stringify(finalApproach)}`);
  assert.equal(finalApproach.warningFrames, 0, 'Final approach must never emit route warnings');
  assert.equal(finalApproach.warningAfterExcursion, 'none');
  assert.ok(finalApproach.maxStep < 1.5, `the continuous gate-to-excursion path must not teleport: ${JSON.stringify(finalApproach)}`);
  assert.ok(finalApproach.progressDrift < 0.001,
    `off-route projection must not manufacture place progress: ${JSON.stringify(finalApproach)}`);
  assert.equal(finalApproach.routePasses, 1);
  assert.equal(finalApproach.routeFails, 0);
  assert.equal(finalApproach.finalGuideCount, 1, 'Final must expose one authoritative target');
  assert.equal(finalApproach.visibleRouteCount, 0, 'flight seven must not remain as a stale branch after handoff');
  assert.equal(finalApproach.activeRouteIndex, -1);
  assert.ok(finalApproach.maxBrakeEnvelope >= 0.9,
    `Final Shift must engage the return-brake envelope: ${JSON.stringify(finalApproach)}`);
  assert.ok(finalApproach.speedAfterBrake <= 20 && finalApproach.speedAfterBrake < finalApproach.speedBeforeBrake - 6,
    `the return brake must settle near its 18m/s target: ${JSON.stringify(finalApproach)}`);
  assert.ok(finalApproach.speedAfterBrakeRelease > finalApproach.speedAfterBrake + 4,
    `releasing Final brake must restore automatic throttle: ${JSON.stringify(finalApproach)}`);
  assert.ok(finalApproach.minBrakeSpeed >= 0, 'Final return braking must never select reverse');
  assert.ok(finalApproach.brakeHeadingDelta >= 0.45,
    `return braking must provide enough authority to recover around the portal: ${JSON.stringify(finalApproach)}`);
  assert.equal(finalApproach.chargesAfterBrake, finalApproach.chargesBeforeBrake,
    'Final braking must not earn or spend a flight cell');
  assert.equal(finalApproach.boostChargeAfterBrake, finalApproach.boostChargeBeforeBrake,
    'Final braking must not charge a drift payout');
  assert.equal(finalApproach.driftingAfterBrake, false);
  assert.equal(finalApproach.boostingAfterBrake, false);
  assert.ok(finalApproach.brakeEnvelopeAfterRelease < 0.02,
    'the return brake envelope must fully release back to automatic drive');
  assert.equal(finalApproach.outsidePhase, 'racing', 'passing outside a gold column is retryable, not terminal');
  assert.equal(finalApproach.outsideWarning, 'none');
  assert.equal(finalApproach.finishedPhase, 'finished', 'a reverse-side pass through the visible portal must finish');
  assert.deepEqual(finalApproach.geometry, {
    centerForward: true,
    centerReverse: true,
    insideLeft: true,
    insideRight: true,
    outsideLeft: false,
    outsideRight: false,
    highSpeedSweep: true,
    teleportRejected: false,
  });
  const finalOrder = await page.evaluate(() => window.__harness.finalOrderCase());
  assert.deepEqual(finalOrder.sameFrameOrder, [1, 2],
    `same-step Final crossings must use swept sub-frame time: ${JSON.stringify(finalOrder)}`);
  assert.equal(finalOrder.opponentsFinishedBeforePlayer, true,
    `all five rivals must be able to finish while the player waits: ${JSON.stringify(finalOrder)}`);
  assert.equal(finalOrder.rivalsVisibleBeforePlayer, true,
    `finished rivals must remain visible and physical before the player finishes: ${JSON.stringify(finalOrder)}`);
  assert.equal(finalOrder.allFinished, true);
  assert.equal(finalOrder.phase, 'finished');
  assert.equal(finalOrder.playerPlace, 6);
  assert.equal(finalOrder.resultPlace, 6,
    `the last physical crossing must settle as 6/6: ${JSON.stringify(finalOrder)}`);
  assert.equal(finalOrder.totalRacers, 6);
  assert.deepEqual(finalOrder.order, [1, 2, 3, 4, 5, 0]);
  assert.ok(finalOrder.finishTimes.every((time, index, times) => index === 0 || time >= times[index - 1]),
    `finish times must remain monotonic in locked place order: ${JSON.stringify(finalOrder)}`);

  await page.evaluate(() => window.__harness.scenario('start'));
  for (let route = 0; route < 7; route++) {
    await page.evaluate((index) => window.__harness.passFlight(index, 1, true), route);
    state = await page.evaluate(() => window.__harness.playerState());
    assert.equal(state.flightRouteState, 'passed', `route ${route + 1} must pass under continuous air brake`);
    if (state.phase === 'medal') {
      await page.evaluate(() => window.__harness.advance(8.9));
    }
  }
  await page.evaluate(() => window.__harness.passExtendedFlight(2, true));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'passed',
    `third flight must support early launch + airborne extension + continuous air brake: ${JSON.stringify(state)}`);
  assert.equal(state.flightExtensionUsed, true);
  assert.equal(state.flightCharges, 0);

  await page.evaluate(() => window.__harness.passFlight(0, 2, true));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'passed');
  assert.equal(state.flightCharges, 1, 'a clean gate keeps the unspent spare cell');
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightDenied, true, 'a passed gate must reject extension instead of prolonging its landing');
  assert.equal(state.flightCharges, 1, 'a rejected post-gate press must not consume the spare cell');
  assert.equal(state.flightExtensionUsed, false);

  await page.evaluate(() => window.__harness.scenario('flight-descent'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'descending');
  await page.evaluate(() => window.__harness.usePlayerInput(true));
  await page.keyboard.down('Shift');
  const keyboardWaterContact = await advanceToControlledWaterContact(page);
  assert.notEqual(keyboardWaterContact.before.flightPhase, 'surface');
  assert.equal(keyboardWaterContact.after.flightPhase, 'surface');
  assert.equal(keyboardWaterContact.after.drifting, true,
    `held keyboard Shift must become drift on the exact water-contact step: ${JSON.stringify(keyboardWaterContact)}`);
  assert.ok(keyboardWaterContact.after.boostCharge > 0 && keyboardWaterContact.after.boostCharge < 0.08,
    `water contact must earn exactly the first fixed step, not backdate airborne time: ${JSON.stringify(keyboardWaterContact)}`);
  assert.ok(keyboardWaterContact.after.driftBankProgress > 0,
    `the nearby BANK gauge must move on the contact step: ${JSON.stringify(keyboardWaterContact)}`);
  assert.ok(keyboardWaterContact.after.flightAirBrake < 0.001,
    `normal landing must retire the air-brake envelope before surface handling: ${JSON.stringify(keyboardWaterContact)}`);
  assert.equal(keyboardWaterContact.after.flightReady, false, 'a spent charge must not silently re-arm');
  await page.keyboard.up('Shift');
  await page.evaluate(() => {
    window.__harness.advance(1 / 60);
    window.__harness.usePlayerInput(false);
  });

  await page.evaluate(() => window.__harness.scenario('flight-route'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'passed', `authored route must be completable: ${JSON.stringify(state)}`);
  assert.equal(state.flightGateProgress, 1, 'each flight has one scoring portal');
  assert.equal(state.flightsCleared, 1, 'the first route advances only one of three flights');
  assert.equal(state.phase, 'racing', 'the first flight must not finish the challenge');
  assert.equal(state.routePasses, 1);

  await page.evaluate(() => window.__harness.scenario('flight-spent-charge'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightsCleared, 1);
  assert.equal(state.flightPhase, 'surface');
  assert.equal(state.flightReady, false, 'a completed flight cannot preserve an already spent charge');
  assert.equal(state.flightDenied, true, 'another launch requires a stored drift charge');

  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.earnFlight(false);
    window.__harness.earnFlight(false);
    window.__harness.passFlight(0, 2);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 1, 'an unused second charge must survive a clean route and landing envelope');

  await page.evaluate(() => window.__harness.scenario('flight-miss'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightRouteState, 'failed', 'abandoning a mandatory pylon gate must fail the attempt');
  assert.equal(state.phase, 'defeated', 'a missed pylon is an immediate terminal result');
  assert.ok(['corridor', 'gate', 'gate_left', 'gate_right'].includes(state.flightRouteFailReason),
    `expected a gate miss, got ${state.flightRouteFailReason}`);
  assert.equal(state.flightFailureNumber, 1, 'failure evidence must identify the flight segment');
  const routeLevelReasons = ['no_launch', 'corridor', 'landing', 'exit', 'teleport'];
  if (routeLevelReasons.includes(state.flightRouteFailReason)) {
    assert.equal(state.flightFailureTargetGateRaw, null, 'a route-level miss has no fake portal target');
    assert.equal(state.challengeGate, 0, 'a route-level miss is not a gate result');
  } else {
    assert.equal(state.flightFailureTargetGateRaw, 1, `portal misses must identify the scoring gate: ${JSON.stringify(state)}`);
    assert.equal(state.challengeGate, 1);
  }
  assert.equal(state.routeFails, 1, 'a failed attempt must resolve exactly once');
  if (state.flightRouteFailReason === 'corridor') {
    await page.evaluate(() => window.__harness.advance(0.6));
    assert.match(await page.locator('.hud-lesson-metric').textContent() ?? '', /悬空通道偏离/,
      'aerial corridor review must identify the neutral mist flight channel');
  }

  await page.evaluate(() => window.__harness.scenario('flight-landing-failure'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(state.flightRouteFailReason, 'landing',
    'descent on an uncleared route must be classified as early landing before corridor drift');
  assert.equal(state.flightFailureTargetGateRaw, null);
  assert.equal(state.challengeGate, 0);
  await page.evaluate(() => window.__harness.advance(0.6));
  assert.match(await page.locator('.hud-lesson-title').textContent() ?? '', /提前落水/);
  assert.match(await page.locator('.hud-lesson-metric').textContent() ?? '', /当前高度/,
    'landing review must expose landing evidence instead of corridor copy');

  await page.evaluate(() => window.__harness.scenario('flight-airbrake'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.ok(state.flightFxDeflection > 0.12, `air-brake must visibly deform the airflow: ${state.flightFxDeflection}`);
  assert.ok(state.flightAirBrake > 0.7, `air brake envelope must attack immediately: ${state.flightAirBrake}`);

  let routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.surfaceGuideStyle, 'translucent-wave-spine',
    'the full-lap route must combine a water-conforming veil with a readable navigation spine');
  assert.ok(routeGuidance.surfaceGuideBaseAlpha >= 0.16 && routeGuidance.surfaceGuideBaseAlpha <= 0.19,
    `the guide field must stay legible without becoming a painted road: ${JSON.stringify(routeGuidance)}`);
  assert.ok(routeGuidance.surfaceGuidePeakAlpha >= 0.55 && routeGuidance.surfaceGuidePeakAlpha <= 0.6,
    `the guide veil must never become an opaque road: ${JSON.stringify(routeGuidance)}`);
  assert.equal(routeGuidance.surfaceGuideArrowCadenceM, 10,
    'moving direction markers need a readable but bounded route cadence');
  assert.equal(routeGuidance.surfaceGuideArrowSpeedMps, 10,
    'surface arrows must move forward rather than only pulsing in place');
  assert.ok(routeGuidance.surfaceGuideArrowCount >= 15 && routeGuidance.surfaceGuideArrowCount <= 17,
    `only the current lookahead needs moving arrows: ${JSON.stringify(routeGuidance)}`);
  assert.equal(routeGuidance.surfaceGuideTurnChevronCount, 3,
    'sharp turns must use the highway-style three-chevron beat');
  assert.equal(routeGuidance.actionCue, 'turn');
  assert.equal(routeGuidance.actionRouteIndex, 1);
  assert.equal(routeGuidance.actionDirection, 'left');
  assert.equal(routeGuidance.actionMarkerCount, 3,
    'the second-flight bend must use the same three-chevron route language');

  await verifySurfaceGuideVisualContract(page);
  await verifyToonMaterialContract(page);
  await verifySkyMaterialContract(page);
  await verifyCommercialCopyContract(page);
  await verifyOceanMaterialContract(page);
  await verifyWakeMaterialContract(page);
  await verifyFlightGuideVisualContract(page);

  await page.evaluate(() => window.__harness.scenario('flight-route4-prepare'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.activeRouteIndex, 3);
  assert.equal(routeGuidance.launchGateState, 'armed');
  assert.equal(routeGuidance.actionDirection, 'left');
  assert.ok(routeGuidance.surfaceGuideLaunchTurnArrowCount >= 2,
    `flight four needs multiple water-bound posture beats before launch: ${JSON.stringify(routeGuidance)}`);
  assert.ok(Math.abs(routeGuidance.surfaceGuideMaskStartU - 0.493) <= 1e-6,
    `flight four surface ownership must end at launch, not entry: ${JSON.stringify(routeGuidance)}`);
  assert.equal(routeGuidance.surfaceGuideAfterLaunchMeters, 0,
    'the surface route must not reappear between the fourth launch aperture and flight corridor');
  const routeFourLaunch = await page.evaluate(() => {
    const group = window.__scene.getObjectByName('flight-4-launch-gate');
    const corridor = window.__scene.getObjectByName('flight-4-ribbon');
    return {
      cueU:group?.userData?.launchCueU ?? -1,
      pathLengthM:group?.userData?.launchVectorPathLengthM ?? -1,
      corridorVisible:Boolean(corridor?.visible),
      corridorVisualStartU:corridor?.userData?.visualStartU ?? -1,
      corridorAuthoredEntryU:corridor?.userData?.authoredEntryU ?? -1,
      corridorTurnTintMax:corridor?.material?.uniforms?.uTurnTintMax?.value ?? -1,
    };
  });
  assert.ok(Math.abs(routeFourLaunch.cueU - 0.493) <= 1e-6,
    `flight four needs an earlier player cue without moving its scoring route: ${JSON.stringify(routeFourLaunch)}`);
  assert.ok(routeFourLaunch.pathLengthM >= 32 && routeFourLaunch.pathLengthM <= 36,
    `flight four needs a longer turn-in vector than the standard launch beat: ${JSON.stringify(routeFourLaunch)}`);
  assert.equal(routeFourLaunch.corridorVisible, true,
    'the airborne route must already be visible while the early fourth-flight cue is actionable');
  assert.ok(Math.abs(routeFourLaunch.corridorVisualStartU - 0.515) <= 1e-6,
    `the fourth mist route must begin at its real airborne entry: ${JSON.stringify(routeFourLaunch)}`);
  assert.ok(routeFourLaunch.corridorVisualStartU > routeFourLaunch.cueU,
    `the rising launch diamonds must bridge the surface cue to the real corridor: ${JSON.stringify(routeFourLaunch)}`);
  assert.equal(routeFourLaunch.corridorVisualStartU, routeFourLaunch.corridorAuthoredEntryU,
    `flight four must not retain a misleading pre-entry mist face: ${JSON.stringify(routeFourLaunch)}`);
  assert.ok(routeFourLaunch.corridorTurnTintMax > 0 && routeFourLaunch.corridorTurnTintMax <= 0.15,
    `warm turn emphasis must stay on chevrons instead of recoloring the mist corridor: ${JSON.stringify(routeFourLaunch)}`);

  await page.evaluate(() => window.__harness.scenario('flight-route4-approach'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.actionCue, 'turn');
  assert.equal(routeGuidance.actionRouteIndex, 3);
  assert.equal(routeGuidance.actionDirection, 'left');
  assert.equal(routeGuidance.actionMarkerCount, 3,
    'the wave-obscured fourth-flight bend must announce itself on the flight ribbon');
  assert.equal(routeGuidance.visibleRouteCount, 1,
    'fourth-flight chevrons must remain part of the single player-owned branch');

  await page.evaluate(() => window.__harness.scenario('flight-route6-prepare'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.activeRouteIndex, 5);
  assert.equal(routeGuidance.visibleRouteCount, 1);
  assert.equal(routeGuidance.launchGateState, 'armed');
  assert.ok(Math.abs(routeGuidance.surfaceGuideMaskStartU - 0.76) <= 1e-6,
    `flight six must hand surface ownership to the launch aperture: ${JSON.stringify(routeGuidance)}`);
  assert.ok(routeGuidance.surfaceGuideMaskEndU >= 0.855,
    `flight six surface mask must stay continuous through its authored exit: ${JSON.stringify(routeGuidance)}`);
  assert.equal(routeGuidance.surfaceGuideAfterLaunchMeters, 0,
    'flight six must never show a green-water segment beneath the active air route');

  await page.evaluate(() => window.__harness.scenario('flight-route6-turn'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.activeRouteIndex, 5);
  assert.equal(routeGuidance.launchGateState, 'committed');
  assert.equal(routeGuidance.actionDirection, 'left');
  assert.ok(Math.abs(routeGuidance.surfaceGuideMaskStartU - 0.76) <= 1e-6,
    `committing flight six must preserve launch ownership: ${JSON.stringify(routeGuidance)}`);
  assert.equal(routeGuidance.surfaceGuideAfterLaunchMeters, 0,
    'flight six surface guidance must stay hidden after the launch facility retires');

  await page.evaluate(() => window.__harness.scenario('flight-route5-prepare'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.actionCue, 'bank');
  assert.equal(routeGuidance.actionRouteIndex, 4);
  assert.equal(routeGuidance.actionDirection, 'right');
  assert.equal(routeGuidance.actionMarkerCount, 3,
    'the fifth-flight approach must expose all three rising launch diamonds');
  assert.equal(routeGuidance.launchGateState, 'unarmed');
  assert.equal(routeGuidance.launchGateRouteIndex, 4);
  assert.equal(routeGuidance.launchGateDiamondCount, 3);
  assert.ok(routeGuidance.launchGateDistanceM > 0 && routeGuidance.launchGateDistanceM <= 140,
    `the unarmed launch gate must appear with a useful reaction distance: ${JSON.stringify(routeGuidance)}`);
  const unarmedLaunchGate = await page.evaluate(() => {
    const group = window.__scene.getObjectByName('flight-5-launch-gate');
    const corridor = window.__scene.getObjectByName('flight-5-ribbon');
    const diamonds = [1, 2, 3].map((index) => window.__scene.getObjectByName(`flight-5-launch-diamond-${index}`));
    const projectors = ['left', 'right'].map((side) => window.__scene.getObjectByName(`flight-5-launch-projector-${side}`));
    const packets = [1, 2, 3].map((index) => window.__scene.getObjectByName(`flight-5-launch-energy-packet-${index}`));
    return {
      visible: Boolean(group?.visible),
      projectorCount: projectors.filter(Boolean).length,
      packetCount: packets.filter(Boolean).length,
      diamondPositions: diamonds.map((diamond) => diamond?.position.toArray() ?? []),
      launchVectorDirection: group?.userData?.launchVectorDirection ?? 'missing',
      launchAuthoredDirection: group?.userData?.launchAuthoredDirection ?? 'missing',
      launchPostureDirection: group?.userData?.launchPostureDirection ?? 'missing',
      launchVectorPathLengthM: group?.userData?.launchVectorPathLengthM ?? -1,
      launchVectorHeadingDeltaDeg: group?.userData?.launchVectorHeadingDeltaDeg ?? 0,
      launchVectorClearances: group?.userData?.launchVectorClearances ?? [],
      corridorAlpha: {
        panel: corridor?.material?.uniforms?.uPanelAlpha?.value ?? -1,
        center: corridor?.material?.uniforms?.uCenterAlpha?.value ?? -1,
        edge: corridor?.material?.uniforms?.uEdgeAlpha?.value ?? -1,
        flow: corridor?.material?.uniforms?.uFlowAlpha?.value ?? -1,
      },
      postureCount: [1, 2].filter((index) =>
        group?.getObjectByName(`flight-5-launch-posture-${index}`)).length,
      postureInkCount: [1, 2].filter((index) =>
        group?.getObjectByName(`flight-5-launch-posture-ink-${index}`)).length,
      postureDirections: [1, 2].map((index) =>
        group?.getObjectByName(`flight-5-launch-posture-${index}`)?.scale?.x ?? 0),
      postureDirectionDots: [1, 2].map((index) => {
        const posture = group?.getObjectByName(`flight-5-launch-posture-${index}`);
        const root = posture?.parent;
        if (!posture || !root) return -2;
        posture.updateWorldMatrix(true, false);
        root.updateWorldMatrix(true, false);
        const arrow = posture.matrixWorld.elements;
        const frame = root.matrixWorld.elements;
        const arrowX = arrow[0];
        const arrowZ = arrow[2];
        const forwardX = frame[8];
        const forwardZ = frame[10];
        const portX = forwardZ;
        const portZ = -forwardX;
        const side = group?.userData?.launchPostureDirection === 'right' ? -1 : 1;
        return (arrowX * portX * side + arrowZ * portZ * side) /
          (Math.max(1e-6, Math.hypot(arrowX, arrowZ)) * Math.max(1e-6, Math.hypot(portX, portZ)));
      }),
      energyColor: diamonds[0]?.children?.[1]?.material?.color?.getHex() ?? -1,
      allEnergyDepthIndependent: diamonds.every((diamond) => diamond?.children?.[1]?.material?.depthTest === false),
      containsTextGeometry: Boolean(group?.getObjectByProperty('type', 'Sprite')),
      packetPositions: packets.map((packet) => packet?.position.toArray() ?? []),
    };
  });
  assert.equal(unarmedLaunchGate.visible, true);
  assert.equal(unarmedLaunchGate.projectorCount, 2,
    'the launch marker must be projected by two small waterborne fixtures, not a floating billboard');
  assert.equal(unarmedLaunchGate.packetCount, 3);
  assert.equal(unarmedLaunchGate.diamondPositions.length, 3);
  assert.equal(unarmedLaunchGate.launchVectorDirection, 'right',
    'the fifth-flight launch aperture must communicate its actual entry vector');
  assert.equal(unarmedLaunchGate.launchAuthoredDirection, unarmedLaunchGate.launchVectorDirection,
    'authored fifth-flight direction must agree with the vector players actually see');
  assert.equal(unarmedLaunchGate.launchPostureDirection, 'right');
  assert.ok(unarmedLaunchGate.launchVectorPathLengthM >= 20 &&
    unarmedLaunchGate.launchVectorPathLengthM <= 26,
    `the launch aperture must preview a readable airborne vector: ${JSON.stringify(unarmedLaunchGate)}`);
  assert.ok(unarmedLaunchGate.launchVectorHeadingDeltaDeg >= 4,
    `positive launch-vector rotation must describe the fifth-flight right turn: ${JSON.stringify(unarmedLaunchGate)}`);
  assert.equal(unarmedLaunchGate.postureCount, 2);
  assert.equal(unarmedLaunchGate.postureInkCount, 2);
  assert.ok(unarmedLaunchGate.postureDirections.every((direction) => direction < 0),
    'right-facing posture chevrons must mirror local +X toward starboard');
  assert.ok(unarmedLaunchGate.postureDirectionDots.every((dot) => dot > 0.9),
    `the two upper beats must point toward the actual right side of their ascent vector: ${JSON.stringify(unarmedLaunchGate)}`);
  assert.ok(unarmedLaunchGate.corridorAlpha.panel >= 0.09 &&
    unarmedLaunchGate.corridorAlpha.panel <= 0.1 &&
    unarmedLaunchGate.corridorAlpha.center >= 0.04 &&
    unarmedLaunchGate.corridorAlpha.center <= 0.05 &&
    unarmedLaunchGate.corridorAlpha.edge >= 0.32 &&
    unarmedLaunchGate.corridorAlpha.edge <= 0.36 &&
    unarmedLaunchGate.corridorAlpha.flow >= 0.52 &&
    unarmedLaunchGate.corridorAlpha.flow <= 0.56,
    `the airborne corridor must stay translucent but readable: ${JSON.stringify(unarmedLaunchGate)}`);
  assert.equal(unarmedLaunchGate.allEnergyDepthIndependent, true,
    'the virtual ascent aperture must survive wave occlusion without changing collision geometry');
  assert.equal(unarmedLaunchGate.containsTextGeometry, false,
    'launch preparation must be communicated by the world object rather than an in-world text sign');
  const firstDiamond = unarmedLaunchGate.diamondPositions[0];
  const lastDiamond = unarmedLaunchGate.diamondPositions[2];
  assert.ok(unarmedLaunchGate.launchVectorClearances[2] -
    unarmedLaunchGate.launchVectorClearances[0] >= 4.5,
    `the three beats must unmistakably rise out of the water: ${JSON.stringify(unarmedLaunchGate)}`);
  assert.ok(Math.hypot(lastDiamond[0] - firstDiamond[0], lastDiamond[2] - firstDiamond[2]) >= 20,
    `the ascent beats must preview the first airborne heading, not form a vertical stack: ${JSON.stringify(unarmedLaunchGate)}`);
  await page.evaluate(() => window.__harness.advance(0.25));
  const movedPackets = await page.evaluate(() => [1, 2, 3].map((index) =>
    window.__scene.getObjectByName(`flight-5-launch-energy-packet-${index}`)?.position.toArray() ?? []));
  assert.ok(movedPackets.some((position, index) => Math.hypot(
    position[0] - unarmedLaunchGate.packetPositions[index][0],
    position[1] - unarmedLaunchGate.packetPositions[index][1],
    position[2] - unarmedLaunchGate.packetPositions[index][2],
  ) > 0.2), 'energy packets must visibly climb through the launch aperture');

  await page.evaluate(() => window.__harness.scenario('flight-route5-launch'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.actionCue, 'launch');
  assert.equal(routeGuidance.actionRouteIndex, 4);
  assert.equal(routeGuidance.actionMarkerCount, 3,
    'a stored charge must transfer emphasis to all three mist launch diamonds');
  assert.equal(routeGuidance.launchGateState, 'armed');
  assert.equal(routeGuidance.launchGateRouteIndex, 4);
  assert.equal(routeGuidance.launchGateDiamondCount, 3);
  const armedLaunchGate = await page.evaluate(() => {
    const group = window.__scene.getObjectByName('flight-5-launch-gate');
    const diamond = window.__scene.getObjectByName('flight-5-launch-diamond-1');
    return {
      visible: Boolean(group?.visible),
      energyColor: diamond?.children?.[1]?.material?.color?.getHex() ?? -1,
    };
  });
  assert.equal(armedLaunchGate.visible, true);
  assert.notEqual(armedLaunchGate.energyColor, unarmedLaunchGate.energyColor,
    'earning a flight stock must turn the same world gate from warning to launch-ready');

  await page.evaluate(() => window.__harness.scenario('flight-route5-turn'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.actionCue, 'turn');
  assert.equal(routeGuidance.actionDirection, 'right');
  assert.equal(routeGuidance.actionMarkerCount, 3,
    'the hardest bend must retain three supported marine chevrons');
  assert.equal(routeGuidance.visibleRouteCount, 1,
    'route action markers must not manufacture a second flight branch');
  assert.equal(routeGuidance.launchGateState, 'committed');
  assert.equal(await page.evaluate(() => window.__scene.getObjectByName('flight-5-launch-gate')?.visible), false,
    'the waterborne launch marker must retire as soon as the real flight branch owns navigation');
  const routeFiveWarning = await page.locator('.hud-turn-warning').textContent() ?? '';
  assert.match(routeFiveWarning, /急右航道/);
  assert.match(routeFiveWarning, /SHIFT/);
  assert.match(routeFiveWarning, /→/);
  assert.doesNotMatch(routeFiveWarning, /A\s*\/\s*D/,
    'the right-turn combo must not ask players to translate a generic A/D label');
  const routeFiveMarkers = await page.evaluate(() => {
    const group = window.__scene.getObjectByName('flight-5-marine-chevrons-right');
    const floorMarkers = window.__scene.getObjectByName('flight-5-chevron-fill');
    const supports = [1, 2, 3, 4, 5].map((index) =>
      window.__scene.getObjectByName(`flight-5-chevron-buoy-${index}`));
    floorMarkers?.updateWorldMatrix(true, false);
    const floorMatrices = floorMarkers?.instanceMatrix?.array ?? [];
    const floorWorld = floorMarkers?.matrixWorld?.elements ?? [];
    const directionDots = supports.map((support, index) => {
      if (!support || floorMatrices.length < (index + 1) * 16 || floorWorld.length < 16) return -2;
      support.updateWorldMatrix(true, false);
      const supportWorld = support.matrixWorld.elements;
      const sx = supportWorld[0];
      const sz = supportWorld[2];
      const tx = Number(support.userData.routeTangentX);
      const tz = Number(support.userData.routeTangentZ);
      const side = support.userData.turnDirection === 'right' ? -1 : 1;
      const expectedX = tz * side;
      const expectedZ = -tx * side;
      const floorOffset = index * 16;
      const localX = floorMatrices[floorOffset];
      const localY = floorMatrices[floorOffset + 1];
      const localZ = floorMatrices[floorOffset + 2];
      const fx = floorWorld[0] * localX + floorWorld[4] * localY + floorWorld[8] * localZ;
      const fz = floorWorld[2] * localX + floorWorld[6] * localY + floorWorld[10] * localZ;
      const expectedLength = Math.max(1e-6, Math.hypot(expectedX, expectedZ));
      return {
        sign: (sx * expectedX + sz * expectedZ) /
          (Math.max(1e-6, Math.hypot(sx, sz)) * expectedLength),
        floor: (fx * expectedX + fz * expectedZ) /
          (Math.max(1e-6, Math.hypot(fx, fz)) * expectedLength),
      };
    });
    return {
      entryCount: group?.userData?.entryMarkerCount ?? -1,
      counterCount: group?.userData?.counterMarkerCount ?? -1,
      counterDirection: group?.userData?.counterDirection ?? 'missing',
      supportCount: supports.filter(Boolean).length,
      lateRoles: supports.slice(3).map((support) => support?.userData?.turnRole ?? 'missing'),
      lateDirections: supports.slice(3).map((support) => support?.userData?.turnDirection ?? 'missing'),
      signDirectionDots: directionDots.map((entry) => entry.sign),
      floorDirectionDots: directionDots.map((entry) => entry.floor),
    };
  });
  assert.equal(routeFiveMarkers.entryCount, 3);
  assert.equal(routeFiveMarkers.counterCount, 2,
    `flight five needs two explicit exit corrections after its hard bend: ${JSON.stringify(routeFiveMarkers)}`);
  assert.equal(routeFiveMarkers.supportCount, 5);
  assert.equal(routeFiveMarkers.counterDirection, 'left');
  assert.deepEqual(routeFiveMarkers.lateRoles, ['counter', 'counter']);
  assert.deepEqual(routeFiveMarkers.lateDirections, ['left', 'left'],
    'the final two signs must oppose the entry rotation instead of encouraging more oversteer');
  assert.equal(routeFiveMarkers.signDirectionDots.length, 5,
    'all five authored freestanding turn plates must participate in the direction contract');
  assert.ok(routeFiveMarkers.signDirectionDots.every((dot) => dot > 0.9),
    `every freestanding plate must point to the authored side of the route tangent: ${JSON.stringify(routeFiveMarkers)}`);
  assert.ok(routeFiveMarkers.floorDirectionDots.every((dot) => dot > 0.9),
    `every in-route chevron must independently point to the authored side: ${JSON.stringify(routeFiveMarkers)}`);

  await page.evaluate(() => window.__harness.scenario('flight-route5-counter'));
  routeGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(routeGuidance.actionCue, 'turn');
  assert.equal(routeGuidance.actionRouteIndex, 4);
  assert.equal(routeGuidance.actionDirection, 'left');
  assert.equal(routeGuidance.actionMarkerCount, 2,
    `the exit correction must transfer authority to exactly two opposite signs: ${JSON.stringify(routeGuidance)}`);
  const routeFiveCounterWarning = await page.locator('.hud-turn-warning').textContent() ?? '';
  assert.match(routeFiveCounterWarning, /急左航道/);
  assert.match(routeFiveCounterWarning, /SHIFT/);
  assert.match(routeFiveCounterWarning, /←/);

  await page.evaluate(() => window.__harness.scenario('overtake'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.battleOvertakes, 1);
  assert.equal(state.lastBattleKind, 'overtake');
  await assertBattleFeedbackVisible(page, 'overtake-desktop');
  await assertBattleLeavesDrivingRoiClear(page, 'overtake-desktop');
  const vp = { label: 'overtake-landscape', width: 844, height: 390 };
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__harness.render());
  await assertBattleFeedbackVisible(page, vp.label);
  await assertBattleLeavesDrivingRoiClear(page, vp.label);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(120);

  await page.evaluate(() => window.__harness.scenario('overtake-chain'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.battleOvertakes, 2);
  assert.equal(state.lastBattleStreak, 2);

  await page.evaluate(() => window.__harness.scenario('position-lost'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.battlePositionLosses, 1);
  assert.equal(state.lastBattleKind, 'lost');

  const medalsBefore = state.manMedalsTotal;
  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.passFlight(0);
    window.__harness.passFlight(1);
    window.__harness.passFlight(2, 2);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal', 'the third flight must enter the medal ceremony');
  assert.equal(state.flightsCleared, 3);
  assert.notEqual(state.challengeTier, 'unqualified');
  assert.equal(state.flightCharges, 1, 'the spare launch charge must survive the medal freeze');
  assert.equal(state.manMedalsTotal, medalsBefore + 1, 'the third flight grants exactly one medal in the run');
  assert.equal(await page.locator('.hud-medal-ceremony').evaluate((el) => el.classList.contains('on')), true);
  assert.equal(await page.locator('.hud-medal-title').textContent(), '猛男');
  assert.match(await page.locator('.hud-medal-count').textContent() ?? '', /男人勋章 \+1/,
    'the ceremonial title may evolve, but the earned reward must stay explicit');
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'medal',
    'the qualification frame must not overwrite the medal music mix');
  const medalBeforeBackground = state.medalElapsed;
  await page.evaluate(() => window.__harness.setVisibility(true));
  await page.evaluate(() => window.__harness.advance(1));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.medalElapsed, medalBeforeBackground, 'backgrounding must not consume medal ceremony time');
  await page.evaluate(() => window.__harness.setVisibility(false));
  assert.equal(await page.locator('.hud-interruption').evaluate((el) => el.classList.contains('on')), true,
    'the pause GO must remain visible over the medal layer');
  await page.evaluate(() => window.__harness.resumeInterruption());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal', 'resuming a medal screen continues the remaining ceremony first');
  const frozen = {
    x: state.playerX, y: state.playerY, z: state.playerZ,
    raceTime: state.raceTime, worldTime: state.worldTime, medals: state.manMedalsTotal,
  };
  await page.evaluate(() => window.__harness.advance(4.2));
  assert.equal(await page.locator('.hud-medal-next').evaluate((el) => el.classList.contains('on')), true,
    'the final 1.8s must reveal the far-sea follow-up goal');
  await page.evaluate(() => window.__harness.retry());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal', 'ceremony cannot skip before the full 4.5s');
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    { x: frozen.x, y: frozen.y, z: frozen.z, raceTime: frozen.raceTime, worldTime: frozen.worldTime },
    'ceremony must freeze boat, race clock, and world clock',
  );
  await page.evaluate(() => window.__harness.advance(0.35));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'resume-countdown', 'the full ceremony must continue through a resume countdown');
  await page.evaluate(() => window.__harness.advance(2));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'resume-countdown');
  assert.deepEqual(
    { x: state.playerX, y: state.playerY, z: state.playerZ, raceTime: state.raceTime, worldTime: state.worldTime },
    { x: frozen.x, y: frozen.y, z: frozen.z, raceTime: frozen.raceTime, worldTime: frozen.worldTime },
    'resume countdown must remain frozen',
  );
  await page.evaluate(() => window.__harness.advance(2.25));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing');
  assert.equal(state.manMedalsTotal, frozen.medals, 'resume must not award the medal twice');
  assert.equal(state.flightCharges, 1, 'the spare charge must survive medal and full resume countdown');

  // A physical Shift hold must survive the third-flight ceremony and full
  // resume countdown. Space is edge-triggered and must never survive with it.
  await page.evaluate(() => window.__harness.scenario('endless-two'));
  await page.keyboard.down('Shift');
  await page.keyboard.down('Space');
  await page.evaluate(() => {
    window.__harness.passFlight(2);
    window.__harness.usePlayerInput(true);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'medal');
  const heldChargeBeforeLanding = state.flightCharges;
  await page.evaluate(() => window.__harness.advance(4.6));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'resume-countdown');
  await page.evaluate(() => window.__harness.advance(4.3));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing');
  assert.notEqual(state.flightPhase, 'spool', 'held Space must not auto-launch after the ceremony');
  const medalWaterContact = await advanceToControlledWaterContact(page);
  state = medalWaterContact.after;
  assert.equal(state.drifting, true, 'held Shift must become surface drift on the medal landing frame');
  assert.ok(state.boostCharge > 0 && state.boostCharge < 0.08,
    `medal resume must not lose or backdate the first drift step: ${JSON.stringify(medalWaterContact)}`);
  assert.ok(state.flightAirBrake < 0.001,
    `medal landing must hand air-brake ownership to drift immediately: ${JSON.stringify(medalWaterContact)}`);
  await page.evaluate(() => {
    for (let i = 0; i < 60 && !window.__harness.playerState().driftReleaseReady; i++) {
      window.__harness.advance(1 / 60);
    }
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.driftReleaseReady, true, 'the preserved hold must reach a readable release threshold');
  assert.equal(state.flightCharges, heldChargeBeforeLanding,
    'holding drift must preserve the spare cell without silently issuing another before release');
  await page.keyboard.up('Space');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).flightPhase, 'surface');
  await page.keyboard.up('Shift');
  await page.evaluate(() => window.__harness.advance(1 / 30));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, Math.min(5, heldChargeBeforeLanding + 1),
    'releasing the preserved Shift hold must add exactly one cell, capped at five');
  await page.evaluate(() => window.__harness.usePlayerInput(false));

  await page.evaluate(() => window.__harness.scenario('endless-four'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'racing', 'the fourth flight must remain playable');
  assert.equal(state.flightsCleared, 4);
  assert.ok(state.bestFlights >= 4, 'endless flight PB must persist');

  await page.evaluate(() => window.__harness.scenario('ready'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 0, 'a fresh run/reset must clear both stored launch cells');

  await page.evaluate(() => window.__harness.scenario('endless-medal-fail'));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.phase, 'defeated');
  assert.equal(state.retryLessonActive, true);
  assert.equal(state.manMedalEarned, true, 'post-qualification failure must settle the earned medal');
  assert.ok(state.manMedalsTotal >= medalsBefore + 3);
  assert.equal(state.retryLessonDuration, 5, 'post-medal failure uses the same skippable review');
  assert.equal(state.coachStatus, 'expert', 'three flights permanently exempt the basic curriculum');
  assert.match(await page.locator('.hud-lesson-medal').textContent() ?? '', /男人勋章 \+1/);
  assert.match(await page.locator('.hud-lesson-copy').textContent() ?? '', /空刹/,
    'flight-course failures must teach the contextual air brake on first occurrence');
  assert.equal((await page.evaluate(() => window.__harness.audioState())).scene, 'lesson');

  // Keep this additional continuous run last: AI personalities deliberately
  // retain RNG state across resets, so inserting a new run earlier would alter
  // unrelated endurance/finale trajectories instead of testing this cue.
  const routeFourCueLaunch = await page.evaluate(() => window.__harness.routeFourCueLaunchCase());
  assert.equal(routeFourCueLaunch.phase, 'racing',
    `the earlier fourth-flight cue must remain inside the live run: ${JSON.stringify(routeFourCueLaunch)}`);
  assert.equal(routeFourCueLaunch.launchAccepted, true,
    `the earlier fourth-flight world cue must launch through the unchanged input path: ${JSON.stringify(routeFourCueLaunch)}`);
  assert.ok(routeFourCueLaunch.cueDistanceM >= 0 && routeFourCueLaunch.cueDistanceM <= 3,
    `the continuous case must launch at the visible cue rather than a hidden fixture: ${JSON.stringify(routeFourCueLaunch)}`);
  assert.equal(routeFourCueLaunch.routeState, 'passed');
  assert.equal(routeFourCueLaunch.flightsCleared, 4);
  assert.equal(routeFourCueLaunch.routePasses, 1);
  assert.equal(routeFourCueLaunch.routeFails, 0);
  assert.equal(routeFourCueLaunch.visibleRouteCount, 1);

  for (const mode of ['during-recovery', 'after-handoff']) {
    const earlyLaunch = await page.evaluate((launchMode) =>
      window.__harness.medalEarlyFourthLaunchCase(launchMode), mode);
    assert.equal(earlyLaunch.phase, 'racing',
      `the real medal-to-fourth-flight chain must stay live: ${JSON.stringify(earlyLaunch)}`);
    assert.equal(earlyLaunch.accepted, true,
      `a retained cell must launch before the recommended marker: ${JSON.stringify(earlyLaunch)}`);
    assert.equal(earlyLaunch.flightsCleared, 3);
    assert.equal(earlyLaunch.recoveryOwnerAtWater, 2);
    assert.ok(earlyLaunch.launchU >= 0.438 && earlyLaunch.launchU < earlyLaunch.routeFourCueU,
      `the fixture must exercise the previously uncovered early-launch span: ${JSON.stringify(earlyLaunch)}`);
    assert.equal(earlyLaunch.immediateCommitRoute, 3);
    assert.equal(earlyLaunch.immediateRecoveryOwner, -1,
      `an accepted next flight must atomically retire the previous recovery owner: ${JSON.stringify(earlyLaunch)}`);
    assert.equal(earlyLaunch.immediateActiveOwner, 3);
    assert.equal(earlyLaunch.immediateVisibleRoutes, 1);
    assert.equal(earlyLaunch.immediateLaunchGateCommitted, true,
      `the launch facility must retire on the accepted input edge, not at scoring entry: ${JSON.stringify(earlyLaunch)}`);
    assert.ok(Math.abs(earlyLaunch.immediateMaskStartU - 0.493) <= 1e-6,
      `green guidance must remain authoritative until the fourth-flight launch marker: ${JSON.stringify(earlyLaunch)}`);
    assert.equal(earlyLaunch.afterCommitRoute, 3);
    assert.equal(earlyLaunch.afterRecoveryOwner, -1);
    assert.equal(earlyLaunch.afterActiveOwner, 3);
    assert.equal(earlyLaunch.afterVisibleRoutes, 1);
    assert.equal(earlyLaunch.warningFrames, 0);
    assert.equal(earlyLaunch.maxVisibleRoutes, 1);
    assert.equal(earlyLaunch.routePasses, 1);
    assert.equal(earlyLaunch.routeFails, 0);
    assert.equal(earlyLaunch.finalArmed, false);

    const visibility = await page.evaluate(() => {
      const effectivelyVisible = (name) => {
        let object = window.__scene.getObjectByName(name);
        if (!object) return false;
        while (object) {
          if (!object.visible) return false;
          object = object.parent;
        }
        return true;
      };
      return {
        flightThree: effectivelyVisible('flight-3-ribbon'),
        flightFour: effectivelyVisible('flight-4-ribbon'),
        launchGate: effectivelyVisible('flight-4-launch-gate'),
        visualStartU: window.__scene.getObjectByName('flight-4-ribbon')?.userData?.visualStartU ?? -1,
      };
    });
    assert.equal(visibility.flightThree, false,
      `the prior recovery branch must not remain effectively visible: ${JSON.stringify(visibility)}`);
    assert.equal(visibility.flightFour, true,
      `the fourth branch must be visible through its complete parent chain: ${JSON.stringify(visibility)}`);
    assert.equal(visibility.launchGate, false);
    assert.ok(Math.abs(visibility.visualStartU - 0.515) <= 1e-6);

    if (mode === 'during-recovery') {
      const pixelContribution = await page.evaluate(() => {
        const canvas = document.querySelector('#app > canvas');
        const group = window.__scene.getObjectByName('flight-4-guide');
        if (!(canvas instanceof HTMLCanvasElement) || !group) return -1;
        const read = () => {
          window.__harness.render();
          const copy = document.createElement('canvas');
          copy.width = canvas.width;
          copy.height = canvas.height;
          const context = copy.getContext('2d', { willReadFrequently: true });
          context.drawImage(canvas, 0, 0);
          return context.getImageData(0, 0, copy.width, copy.height).data;
        };
        const wasVisible = group.visible;
        group.visible = false;
        const withoutRoute = read();
        group.visible = true;
        const withRoute = read();
        group.visible = wasVisible;
        window.__harness.render();
        let changed = 0;
        for (let pixel = 0; pixel < withRoute.length; pixel += 4) {
          const delta = Math.abs(withRoute[pixel] - withoutRoute[pixel]) +
            Math.abs(withRoute[pixel + 1] - withoutRoute[pixel + 1]) +
            Math.abs(withRoute[pixel + 2] - withoutRoute[pixel + 2]);
          if (delta > 2) changed++;
        }
        return changed;
      });
      assert.ok(pixelContribution > 10000,
        `the early fourth branch must contribute real rendered pixels: ${pixelContribution}`);
    }
  }

  // Keep this after pixel-sensitive guide checks: harness world time is
  // intentionally monotonic, so extra fixed steps before those probes would
  // change their authored wave phase. Fullscreen/focus transitions may clear
  // the initial keydown while physical Shift remains held, after which Chrome
  // resumes with repeat events. Run that PC-only boundary through flight
  // four's real recovery and require the recovered hold to reach BANK-ready.
  await page.evaluate(() => {
    window.__harness.scenario('flight-route4-recovery-air');
    window.__harness.usePlayerInput(true);
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'ShiftLeft', key: 'Shift', repeat: true, bubbles: true,
    }));
  });
  const routeFourRepeatWaterContact = await advanceToControlledWaterContact(page);
  assert.equal(routeFourRepeatWaterContact.after.drifting, true,
    `a repeated physical Shift must recover after focus loss before flight-four landing: ${JSON.stringify(routeFourRepeatWaterContact)}`);
  assert.ok(routeFourRepeatWaterContact.after.boostCharge > 0,
    `flight-four water contact must start a real drift charge: ${JSON.stringify(routeFourRepeatWaterContact)}`);
  await page.evaluate(() => {
    for (let i = 0; i < 60 && !window.__harness.playerState().driftReleaseReady; i++) {
      window.__harness.advance(1 / 60);
    }
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.driftReleaseReady, true,
    `the recovered flight-four hold must reach the yellow BANK line: ${JSON.stringify(state)}`);
  assert.equal(state.flightRouteCursor, 4, 'the regression must remain the real fourth-to-fifth handoff');
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'Space', key: ' ', repeat: true, bubbles: true,
    }));
    window.__harness.advance(1 / 60);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightPhase, 'surface',
    'a recovered repeat may restore held controls but must never recreate a Space launch edge');
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', {
      code: 'Space', key: ' ', bubbles: true,
    }));
    window.dispatchEvent(new KeyboardEvent('keyup', {
      code: 'ShiftLeft', key: 'Shift', bubbles: true,
    }));
    window.__harness.advance(1 / 60);
    window.__harness.usePlayerInput(false);
  });

  // Keep the capacity exercise last: every cell is earned through the real
  // fixed-step drift release path, but its extra simulation time cannot perturb
  // any wave-sensitive route contract above.
  await page.evaluate(() => {
    window.__harness.scenario('start');
    for (let i = 0; i < 5; i++) window.__harness.earnFlight(false);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 5, 'five qualifying drifts must fill all five launch cells');
  const fullStockHud = await page.evaluate(() => ({
    count:document.querySelector('.hud-flight-count')?.textContent ?? '',
    rack:document.querySelectorAll('.hud-flight-token').length,
    ready:document.querySelectorAll('.hud-flight-token.ready').length,
    near:document.querySelectorAll('.hud-driver-stock').length,
    nearOn:document.querySelectorAll('.hud-driver-stock.on').length,
  }));
  assert.deepEqual(fullStockHud, { count:'x5', rack:5, ready:5, near:5, nearOn:5 },
    `all desktop stock reads must expose the five-cell cap: ${JSON.stringify(fullStockHud)}`);
  await page.evaluate(() => window.__harness.earnFlight(false));
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 5, 'a sixth qualifying release must not overflow flight storage');
  assert.equal(state.boosting, true, 'a full magazine must not suppress the drift boost payout');
  await page.evaluate(() => window.__harness.tapFlight());
  state = await page.evaluate(() => window.__harness.playerState());
  assert.equal(state.flightCharges, 4, 'one launch from full storage must consume exactly one cell');

  console.log('gameplay contract: OK');
}

async function verifyGamepadContract(page) {
  await page.evaluate(() => {
    window.__gamepadFixture.disconnectAll();
    window.__gamepadFixture.clearAll();
    window.__harness.scenario('ready');
    // Real browsers may expose a newly connected pad only after its first
    // button is already down. That first edge must not be swallowed.
    window.__gamepadFixture.connect(1);
    window.__gamepadFixture.padButton(1, 0, true);
    window.__harness.advance(1 / 30);
  });
  let padStatus = await page.evaluate(() => window.__harness.gamepadStatus());
  assert.equal(padStatus.connected, true);
  assert.equal(padStatus.index, 1);
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'countdown',
    'the first A / Cross edge that reveals a controller must start READY immediately');
  await page.evaluate(() => {
    window.__gamepadFixture.padButton(1, 0, false);
    window.__harness.scenario('ready');
    window.__harness.advance(1 / 30);
  });
  assert.match(await page.locator('.driver-controller-status').textContent() ?? '', /G50S.*标准.*震动/,
    'READY must identify the active controller, mapping and rumble capability');

  const initialDriver = await page.locator('.driver-card.selected').getAttribute('data-driver');
  await page.evaluate(() => {
    window.__gamepadFixture.padAxis(1, 0, 0.12);
    window.__harness.advance(1 / 30);
  });
  assert.equal((await page.evaluate(() => window.__harness.gamepadStatus())).steer, 0,
    'left-stick noise inside the dead zone must be zero');
  assert.equal(await page.locator('.driver-card.selected').getAttribute('data-driver'), initialDriver,
    'dead-zone noise must not rotate the driver roster');

  await page.evaluate(() => {
    window.__gamepadFixture.padAxis(1, 0, 0.92);
    window.__harness.advance(1 / 30);
  });
  const nextDriver = await page.locator('.driver-card.selected').getAttribute('data-driver');
  assert.notEqual(nextDriver, initialDriver, 'right stick edge must select exactly one next driver');
  await page.evaluate(() => window.__harness.advance(0.5));
  assert.equal(await page.locator('.driver-card.selected').getAttribute('data-driver'), nextDriver,
    'holding a stick must not scroll through the whole roster');
  await page.evaluate(() => {
    window.__gamepadFixture.padAxis(1, 0, 0);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.padButton(1, 0, true);
    window.__harness.advance(1 / 30);
  });
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'countdown',
    'A / Cross must confirm the selected driver and start the countdown');
  await page.evaluate(() => window.__harness.advance(4.4));
  let heldCountdownState = await page.evaluate(() => window.__harness.playerState());
  assert.equal(heldCountdownState.phase, 'racing');
  assert.equal(heldCountdownState.flightPhase, 'surface',
    'holding A through the countdown must never buffer a flight edge');

  await page.evaluate(() => {
    window.__gamepadFixture.clear(1);
    window.__harness.scenario('start');
    window.__harness.usePlayerInput(true);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.padAxis(1, 0, 0.9);
    window.__gamepadFixture.padButton(1, 2, true);
    window.__harness.advance(0.5);
  });
  let state = await page.evaluate(() => window.__harness.playerState());
  assert.ok(state.steer > 0.7, `left stick must reach the boat input: ${JSON.stringify(state)}`);
  assert.equal(state.drifting, true, 'X / Square must hold the contextual drift action');
  assert.equal(state.driftReleaseReady, true, 'a held gamepad drift must reach the real release threshold');

  // The same physical X / Square hold is an air brake in flight and must
  // become drift on the exact fixed step that the hull contacts water.
  await page.evaluate(() => {
    window.__gamepadFixture.clear(1);
    window.__harness.scenario('flight-descent');
    window.__harness.usePlayerInput(true);
    window.__gamepadFixture.padButton(1, 2, true);
    window.__harness.advance(1 / 60);
  });
  const gamepadWaterContact = await advanceToControlledWaterContact(page);
  assert.equal(gamepadWaterContact.after.drifting, true,
    `held X / Square must bridge air brake to drift at water contact: ${JSON.stringify(gamepadWaterContact)}`);
  assert.ok(gamepadWaterContact.after.boostCharge > 0 && gamepadWaterContact.after.boostCharge < 0.08);
  assert.ok(gamepadWaterContact.after.flightAirBrake < 0.001);
  await page.evaluate(() => {
    window.__gamepadFixture.padButton(1, 2, false);
    window.__harness.advance(1 / 60);
  });

  // A second idle controller may be present, but deliberate input must take
  // ownership and steer in the same frame. Small idle noise cannot steal it.
  await page.evaluate(() => {
    window.__gamepadFixture.connect(0);
    window.__gamepadFixture.padAxis(0, 0, 0.11);
    window.__gamepadFixture.clear(1);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.padAxis(0, 0, -0.96);
    window.__harness.advance(1 / 30);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  padStatus = await page.evaluate(() => window.__harness.gamepadStatus());
  assert.equal(padStatus.connectedCount, 2);
  assert.equal(padStatus.index, 0, 'the pad producing deliberate input must become active');
  assert.ok(state.steer < -0.7, `a newly active second pad must steer without a dead frame: ${JSON.stringify(state)}`);

  await page.evaluate(() => {
    window.__gamepadFixture.padAxis(0, 0, 0);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.padAxis(1, 0, 0.94);
    window.__gamepadFixture.padButton(1, 2, true);
    window.__harness.advance(0.5);
    window.__gamepadFixture.disconnect(1);
    window.__harness.advance(1 / 30);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  padStatus = await page.evaluate(() => window.__harness.gamepadStatus());
  assert.equal(padStatus.connected, true);
  assert.equal(padStatus.index, 0, 'disconnecting the active pad must fall back to another connected pad');
  assert.equal(state.drifting, false, 'disconnect must release drift in the next simulation frame');
  assert.ok(Math.abs(state.steer) < 0.01, `disconnect must release steering: ${state.steer}`);
  assert.ok(state.flightCharges >= 1, 'disconnecting a qualified held drift may release its earned charge once');

  await page.evaluate(() => {
    window.__gamepadFixture.clear(0);
    window.__harness.advance(1 / 30);
  });
  assert.match(await page.locator('.hud-flight-prompt').textContent() ?? '', /A.*起飞/s,
    'a connected controller must be taught A / Cross before spending its charge');
  await page.evaluate(() => {
    window.__gamepadFixture.button(0, true);
    window.__harness.advance(1 / 30);
  });
  state = await page.evaluate(() => window.__harness.playerState());
  assert.notEqual(state.flightPhase, 'surface', 'A / Cross must spend one stored charge and start flight');
  await page.evaluate(() => {
    window.__gamepadFixture.clear();
    window.__gamepadFixture.disconnect();
    window.__harness.usePlayerInput(false);
  });

  // Non-standard devices use a four-action READY calibration rather than a
  // guessed vendor layout. The resulting map survives a reconnect.
  await page.evaluate(() => {
    window.__gamepadFixture.disconnectAll();
    window.__gamepadFixture.clearAll();
    window.__gamepadFixture.configure(1, { id:'Generic DirectInput Racer', mapping:'' });
    window.__gamepadFixture.connect(1);
    window.__harness.scenario('ready');
    window.__harness.advance(1 / 30);
  });
  padStatus = await page.evaluate(() => window.__harness.gamepadStatus());
  assert.equal(padStatus.mappingSource, 'fallback');
  assert.equal(padStatus.calibrationStep, 'left');
  for (let i = 0; i < 7; i++) {
    await page.evaluate((step) => {
      const actions = [
        () => window.__gamepadFixture.padAxis(1, 1, -0.9),
        () => window.__gamepadFixture.padAxis(1, 1, 0),
        () => window.__gamepadFixture.padAxis(1, 1, 0.9),
        () => window.__gamepadFixture.padAxis(1, 1, 0),
        () => window.__gamepadFixture.padButton(1, 5, true),
        () => window.__gamepadFixture.padButton(1, 5, false),
        () => window.__gamepadFixture.padButton(1, 1, true),
      ];
      actions[step]();
      window.__harness.advance(1 / 30);
    }, i);
  }
  padStatus = await page.evaluate(() => window.__harness.gamepadStatus());
  assert.equal(padStatus.mappingSource, 'custom');
  assert.equal(padStatus.calibrationStep, '');
  assert.ok(await page.evaluate(() => Boolean(localStorage.getItem('board-race.gamepad.v1'))),
    'custom mapping must persist by device signature');
  await page.evaluate(() => {
    window.__gamepadFixture.padButton(1, 1, false);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.disconnect(1);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.connect(1);
    window.__harness.advance(1 / 30);
  });
  assert.equal((await page.evaluate(() => window.__harness.gamepadStatus())).mappingSource, 'custom',
    'reconnecting the same unknown controller must restore its mapping without recalibration');

  // Haptics are discrete, bounded, priority-aware and independent from mute.
  await page.evaluate(() => {
    window.__harness.setHapticsEnabled(false);
    window.__harness.setHapticsEnabled(true);
    window.__gamepadFixture.clearEffects();
    window.__harness.hapticCue('collision-heavy');
    window.__harness.hapticCue('drift-active');
  });
  let effects = await page.evaluate(() => window.__gamepadFixture.effects(1));
  const pulses = effects.filter((entry) => entry.kind === 'play' && Number(entry.options?.duration) > 0);
  assert.equal(pulses.length, 1, 'a lower-priority cue must not stack over a heavy collision pulse');
  assert.ok(Number(pulses[0].options.duration) <= 80, `controller feedback must remain short: ${JSON.stringify(pulses[0])}`);
  assert.ok(Number(pulses[0].options.strongMagnitude) <= 0.55,
    `controller feedback must remain conservative: ${JSON.stringify(pulses[0])}`);
  // A skill pulse owns the right-hand feel. A collision received while drift
  // is held queues behind it and cannot replace the first actuator effect.
  await page.evaluate(() => {
    window.__harness.setHapticsEnabled(false);
    window.__harness.setHapticsEnabled(true);
    window.__gamepadFixture.clearEffects();
    window.__harness.hapticCue('air-brake');
    window.__harness.hapticImpact('collision-heavy', 1, true);
  });
  await page.waitForTimeout(110);
  await page.evaluate(() => window.__harness.advance(1 / 30));
  effects = await page.evaluate(() => window.__gamepadFixture.effects(1));
  const protectedPulses = effects.filter((entry) => entry.kind === 'play' && Number(entry.options?.duration) > 0);
  assert.ok(protectedPulses.length >= 1 && protectedPulses.length <= 2,
    `control/impact scheduler must stay single-slot: ${JSON.stringify(protectedPulses)}`);
  const protectedHaptics = await page.evaluate(() => window.__harness.hapticStatus());
  assert.ok(Number(protectedHaptics.queuedImpacts) >= 1, 'impact must be queued while the skill pulse is held');
  await page.locator('.audio-mixer-toggle').click();
  const hapticButton = page.locator('.audio-mixer-haptics');
  await hapticButton.click();
  assert.equal((await page.evaluate(() => window.__harness.hapticStatus())).enabled, false);
  await page.evaluate(() => {
    window.__gamepadFixture.clearEffects();
    window.__harness.hapticCue('gate');
  });
  effects = await page.evaluate(() => window.__gamepadFixture.effects(1));
  assert.equal(effects.filter((entry) => entry.kind === 'play' && Number(entry.options?.duration) > 0).length, 0,
    'the independent haptic switch must silence controller feedback');
  await hapticButton.click();
  assert.equal((await page.evaluate(() => window.__harness.hapticStatus())).enabled, true);
  await page.locator('.audio-mixer-toggle').click();

  await page.evaluate(() => {
    window.__gamepadFixture.clear(1);
    window.__harness.scenario('start');
    window.__harness.usePlayerInput(true);
    window.__harness.advance(1 / 30);
    window.__harness.setVisibility(true);
    window.__harness.setVisibility(false);
    window.__harness.advance(1 / 30);
    window.__gamepadFixture.padButton(1, 1, true);
    window.__harness.advance(1 / 30);
  });
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'resume-countdown',
    'the calibrated flight/confirm button must resume a background-paused run');
  await page.evaluate(() => {
    window.__gamepadFixture.clearAll();
    window.__gamepadFixture.disconnectAll();
  });
  console.log('gamepad input contract: OK');
}

async function verifyMobileControls(page) {
  const start = page.locator('.mobile-start');
  const contractGo = page.locator('.driver-select-go');
  const viewportFill = async () => page.evaluate(() => {
    const box = (node) => {
      const rect = node?.getBoundingClientRect();
      return rect && { left:rect.left, top:rect.top, right:rect.right, bottom:rect.bottom,
        width:rect.width, height:rect.height };
    };
    return {
      innerWidth,
      innerHeight,
      app:box(document.querySelector('#app')),
      canvas:box(document.querySelector('#app > canvas')),
      htmlHeight:getComputedStyle(document.documentElement).height,
      bodyHeight:getComputedStyle(document.body).height,
      stats:window.__harness.stats(),
    };
  });
  let fill = await viewportFill();
  assert.deepEqual(fill.app, fill.canvas,
    `the WebGL canvas must share the app viewport instead of ending above the Home indicator: ${JSON.stringify(fill)}`);
  assert.ok(fill.app && Math.abs(fill.app.width - fill.innerWidth) <= 1 &&
    Math.abs(fill.app.height - fill.innerHeight) <= 1,
  `the normal mobile root must fill the visible viewport: ${JSON.stringify(fill)}`);

  // WebKit standalone mode can report a JavaScript viewport height that omits
  // the bottom safe-area strip. Prove that Stage follows its actual app
  // container (ResizeObserver), not window.innerHeight, then restore the real
  // edge-to-edge standalone root before any gameplay assertion.
  await page.evaluate(() => {
    document.documentElement.classList.add('ios-standalone');
    const app = document.querySelector('#app');
    app.style.setProperty('min-height', '0', 'important');
    app.style.setProperty('height', 'calc(100vh - 31px)', 'important');
  });
  await page.waitForFunction(() => {
    const app = document.querySelector('#app')?.getBoundingClientRect();
    const canvas = document.querySelector('#app > canvas')?.getBoundingClientRect();
    const stats = window.__harness.stats();
    return app && canvas && Math.abs(app.height - (innerHeight - 31)) <= 1 &&
      Math.abs(canvas.height - app.height) <= 1 && Math.abs(Number(stats.viewportHeight) - app.height) <= 1;
  });
  fill = await viewportFill();
  assert.equal(Number(fill.stats.viewportHeight), Math.round(fill.app.height),
    `renderer sizing must be container-owned when standalone metrics disagree: ${JSON.stringify(fill)}`);
  await page.evaluate(() => {
    const app = document.querySelector('#app');
    app.style.removeProperty('height');
    app.style.removeProperty('min-height');
  });
  await page.waitForFunction(() => {
    const app = document.querySelector('#app')?.getBoundingClientRect();
    const canvas = document.querySelector('#app > canvas')?.getBoundingClientRect();
    return app && canvas && Math.abs(app.height - innerHeight) <= 1 &&
      Math.abs(canvas.height - app.height) <= 1 &&
      Math.abs(Number(window.__harness.stats().viewportHeight) - app.height) <= 1;
  });
  fill = await viewportFill();
  assert.deepEqual(fill.app, fill.canvas,
    `iOS standalone restore must leave no bottom background strip: ${JSON.stringify(fill)}`);
  const repairedCoach = await page.evaluate(() => ({
    records:window.__harness.recordsState(),
    coach:window.__harness.coachState(),
  }));
  assert.equal(repairedCoach.records.version, 8);
  assert.equal(repairedCoach.coach.status, 'dormant');
  assert.equal(repairedCoach.coach.automaticEligible, true,
    'the shipped v7 novice must be repaired before its next real failure');
  assert.equal(await contractGo.isVisible(), true, 'mobile must start behind the explicit driver-contract GO');
  assert.equal(await start.isVisible(), false, 'the legacy activation button must not compete with driver selection');
  assert.equal(await page.locator('.hud-pc-primer:visible').count(), 0,
    'mobile must never render the desktop keyboard primer');
  await assertDriverSelectComposition(page, 'mobile-844x390');
  const coldStart = await page.evaluate(() => window.__harness.startGantryStatus());
  assert.equal(coldStart.canvasTextures, 0,
    `mobile cold load must use texture-independent START geometry: ${JSON.stringify(coldStart)}`);
  assert.equal(coldStart.glyphInstances, 18);
  assert.equal(coldStart.checkerInstances, 48);
  await page.evaluate(() => {
    window.__gamepadFixture.clearVibrations();
    window.__harness.hapticCue('gate');
  });
  let vibrationLog = await page.evaluate(() => window.__gamepadFixture.vibrations());
  assert.equal(vibrationLog.length, 1, 'a mobile gate event must emit one discrete phone vibration');
  assert.ok(Number(vibrationLog[0]) >= 8 && Number(vibrationLog[0]) <= 20,
    `mobile feedback must remain brief: ${JSON.stringify(vibrationLog)}`);
  await page.evaluate(() => {
    window.__harness.setHapticsEnabled(false);
    window.__gamepadFixture.clearVibrations();
    window.__harness.hapticCue('launch');
  });
  vibrationLog = await page.evaluate(() => window.__gamepadFixture.vibrations());
  assert.deepEqual(vibrationLog, [], 'disabling haptics must silence phone vibration independently');
  await page.evaluate(() => window.__harness.setHapticsEnabled(true));

  const selectedBefore = await page.locator('.driver-card.selected').getAttribute('data-driver');
  const featuredBefore = await page.locator('.driver-featured').boundingBox();
  const alternate = page.locator('.driver-switch-next');
  await alternate.click();
  await page.waitForTimeout(95);
  assert.equal(await page.locator('.driver-select').evaluate((el) => el.classList.contains('switching')), true,
    'a driver change must enter the finite selection-lock state');
  assert.notEqual(await page.locator('.driver-card.selected').getAttribute('data-driver'), selectedBefore);
  const backdropAnimation = await page.locator('.driver-mobile-backdrop').evaluate((el) => {
    const style = getComputedStyle(el);
    return { name:style.animationName, duration:parseFloat(style.animationDuration) };
  });
  assert.equal(backdropAnimation.name, 'driver-mobile-backdrop-soft',
    `the standing portrait must run the authored lock-in animation: ${JSON.stringify(backdropAnimation)}`);
  assert.ok(backdropAnimation.duration >= 0.4 && backdropAnimation.duration <= 0.6,
    `the standing portrait lock-in must stay finite and readable: ${JSON.stringify(backdropAnimation)}`);
  const selectAudio = await page.evaluate(() => window.__harness.audioState());
  assert.ok(Number(selectAudio.driverSelectEvents) >= 1, `driver selection must emit its own event: ${JSON.stringify(selectAudio)}`);
  assert.equal(selectAudio.scoreArmed, false, 'selection SFX must never start the background score');
  assert.equal(selectAudio.musicPlaying, true, 'selection SFX must sit over the persistent READY score');
  assert.deepEqual(await page.locator('.driver-featured').boundingBox(), featuredBefore,
    'the selection lock may not reflow the featured contract grid');
  const beforeSwipe = await page.locator('.driver-card.selected').getAttribute('data-driver');
  assert.equal(await page.locator('.driver-carousel').isVisible(), false,
    'mobile must not cover the standing portrait with a second card rail');
  await page.locator('.driver-switch-next').click();
  assert.notEqual(await page.locator('.driver-card.selected').getAttribute('data-driver'), beforeSwipe,
    'the explicit next control must advance exactly one hidden roster destination');
  const visitedDrivers = new Set();
  const visitedRosterSlots = new Set();
  for (let i = 0; i < 6; i++) {
    const selection = await page.evaluate(() => ({
      id:document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
      cardSrc:document.querySelector('.driver-card.selected img')?.currentSrc ?? '',
      backdropSrc:document.querySelector('.driver-mobile-backdrop')?.currentSrc ?? '',
      roster:document.querySelector('.driver-roster-index')?.textContent ?? '',
    }));
    assert.equal(selection.backdropSrc, selection.cardSrc,
      `standing portrait must follow every roster change: ${JSON.stringify(selection)}`);
    assert.match(selection.roster, /^选手 \d{2} \/ 06$/);
    visitedDrivers.add(selection.id);
    visitedRosterSlots.add(selection.roster);
    await page.locator('.driver-switch-next').click();
    await page.waitForTimeout(75);
  }
  assert.equal(visitedDrivers.size, 6, `the explicit next control must visit all six drivers: ${[...visitedDrivers].join(', ')}`);
  assert.equal(visitedRosterSlots.size, 6, `the roster counter must expose all six positions: ${[...visitedRosterSlots].join(', ')}`);
  for (let i = 0; i < 12; i++) await page.locator('.driver-switch-next').click();
  await page.waitForTimeout(650);
  const selectSettled = await page.evaluate(() => window.__harness.audioState());
  assert.equal(Number(selectSettled.activeOneShots), 0, 'rapid driver changes must release every transient audio node');
  assert.equal(await page.locator('.driver-select').evaluate((el) => el.classList.contains('switching')), false,
    'the finite selection lock must release its compositing hint after the last switch');
  for (const height of [390, 330, 300]) {
    await page.setViewportSize({ width: 844, height });
    await page.waitForTimeout(50);
    await assertDriverSelectComposition(page, `mobile-844x${height}`);
    const contract = await page.evaluate(() => {
      const selectors = [
        '.driver-select-header', '.driver-featured', '.driver-select-footer',
      ];
      const rects = selectors.map((selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? { selector, top:rect.top, right:rect.right, bottom:rect.bottom, left:rect.left } : null;
      }).filter(Boolean);
      const go = document.querySelector('.driver-select-go')?.getBoundingClientRect();
      const overlaps = [];
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          if (Math.min(a.right,b.right) - Math.max(a.left,b.left) > 1 &&
              Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top) > 1) overlaps.push(`${a.selector} x ${b.selector}`);
        }
      }
      return {
        rects, overlaps,
        go:go && { top:go.top, right:go.right, bottom:go.bottom, left:go.left },
        goCenterX:go ? (go.left + go.right) / 2 : null,
        cardCount:document.querySelectorAll('.driver-card').length,
        visibleCards:[...document.querySelectorAll('.driver-card')]
          .filter((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().width > 0)
          .map((node) => {
            const r = node.getBoundingClientRect();
            return { id:node.dataset.driver, top:r.top, right:r.right, bottom:r.bottom, left:r.left };
          }),
        dotCount:document.querySelectorAll('.driver-dot').length,
        selectedDotCount:document.querySelectorAll('.driver-dot.selected').length,
        archiveCount:document.querySelectorAll('.driver-archive,.driver-archive-button').length,
        switchControls:[...document.querySelectorAll('.driver-switch-control')].map((node) => {
          const r = node.getBoundingClientRect();
          return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height };
        }),
        scrollHeight:document.scrollingElement?.scrollHeight ?? 0,
        width:innerWidth, height:innerHeight,
      };
    });
    assert.deepEqual(contract.overlaps, [], `driver selector rows overlap at 844x${height}: ${contract.overlaps.join(', ')}`);
    assert.ok(contract.go && contract.go.top >= 0 && contract.go.bottom <= contract.height,
      `GO must remain inside the first visual viewport at 844x${height}: ${JSON.stringify(contract.go)}`);
    assert.ok(Math.abs(contract.goCenterX - contract.width / 2) <= 1.5,
      `GO must own the horizontal center at 844x${height}: ${JSON.stringify(contract.go)}`);
    assert.equal(contract.cardCount, 6, 'all six drivers must remain reachable in the carousel');
    assert.equal(contract.visibleCards.length, 0, 'mobile must keep all six destinations behind the two explicit rotation controls');
    assert.equal(contract.dotCount, 6, 'the carousel must expose all six destinations without six cards');
    assert.equal(contract.selectedDotCount, 1, 'exactly one carousel destination must be selected');
    assert.equal(contract.switchControls.length, 2, 'the main driver stage needs two explicit rotation controls');
    for (const control of contract.switchControls) {
      assert.ok(control.left >= 0 && control.right <= contract.width && control.top >= 0 && control.bottom <= contract.height,
        `driver rotation control clips at 844x${height}: ${JSON.stringify(control)}`);
      assert.ok(control.width >= 44 && control.height >= 44,
        `driver rotation control needs a reliable touch target at 844x${height}: ${JSON.stringify(control)}`);
    }
    assert.equal(contract.archiveCount, 0, 'archive import/export must not compete with selection');
    assert.ok(contract.scrollHeight <= contract.height + 1,
      `driver selector must not depend on address-bar collapse at 844x${height}: scrollHeight=${contract.scrollHeight}`);
  }
  const portraitContract = await page.locator('.driver-card img').evaluateAll((images) => images.map((image) => ({
    width:image.naturalWidth, height:image.naturalHeight, src:image.currentSrc,
  })));
  assert.equal(portraitContract.length, 6);
  assert.equal(new Set(portraitContract.map((portrait) => portrait.src)).size, 6, 'every driver needs a distinct portrait');
  for (const portrait of portraitContract) {
    assert.deepEqual({ width: portrait.width, height: portrait.height }, { width: 640, height: 960 },
      `portrait must use the mobile-safe 2:3 master: ${portrait.src}`);
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(120);
  let renderStats = await page.evaluate(() => window.__harness.stats());
  assert.equal(Number(renderStats.mobileClarity), 1, 'touch devices must use the mobile clarity governor');
  assert.ok(Math.abs(Number(renderStats.pixelRatio) - 2.5) < 0.02,
    `844x390 DPR3 must start at the 2.5x clarity cap: ${JSON.stringify(renderStats)}`);
  assert.ok(Number(renderStats.drawingPixels) >= 2_030_000 && Number(renderStats.drawingPixels) <= 2_120_000,
    `mobile Auto must spend, but never exceed, its 2.1M budget: ${JSON.stringify(renderStats)}`);
  const clearRatio = Number(renderStats.pixelRatio);
  await page.evaluate(() => window.__harness.perfFrames(28, 110));
  renderStats = await page.evaluate(() => window.__harness.stats());
  assert.ok(Number(renderStats.pixelRatio) < clearRatio && Number(renderStats.pixelRatio) >= 1,
    `sustained pressure must lower mobile clarity safely: ${clearRatio} -> ${renderStats.pixelRatio}`);
  const reducedRatio = Number(renderStats.pixelRatio);
  await page.evaluate(() => window.__harness.perfFrames(16.7, 380));
  renderStats = await page.evaluate(() => window.__harness.stats());
  assert.ok(Number(renderStats.pixelRatio) > reducedRatio && Number(renderStats.pixelRatio) <= 2.5,
    `stable frames must restore mobile clarity: ${reducedRatio} -> ${renderStats.pixelRatio}`);
  await page.evaluate(async () => {
    if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
    const calls = [];
    let rejectNext = true;
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable:true,
      value:(options) => {
        calls.push(options ?? null);
        if (rejectNext) {
          rejectNext = false;
          return Promise.reject(new DOMException('fixture rejection', 'NotAllowedError'));
        }
        return Promise.resolve();
      },
    });
    Object.defineProperty(window, '__fullscreenFixture', {
      configurable:true,
      value:{ calls:() => calls.length },
    });
  });
  const fullscreenFailuresBefore = Number((await page.evaluate(() => window.__harness.mobileStatus())).fullscreenFailures);
  await page.locator('.driver-switch-next').click();
  await page.waitForFunction((before) => {
    const status = window.__harness.mobileStatus();
    return status.fullscreenOutcome === 'rejected' && Number(status.fullscreenFailures) === before + 1;
  }, fullscreenFailuresBefore);
  const attemptsAfterRejection = await page.evaluate(() => window.__fullscreenFixture.calls());
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerdown', {
    pointerId:901, pointerType:'touch', isPrimary:true,
  });
  await page.waitForFunction((before) =>
    window.__harness.mobileStatus().fullscreenOutcome === 'entered' && window.__fullscreenFixture.calls() === before + 1,
  attemptsAfterRejection);
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerup', {
    pointerId:901, pointerType:'touch', isPrimary:true,
  });
  let status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.fullscreenOutcome, 'entered',
    'a rejected supported-browser fullscreen attempt must retry on the next real control gesture');
  assert.equal(Number(status.fullscreenFailures), fullscreenFailuresBefore + 1);
  assert.equal(status.activation, 'idle');
  assert.equal(status.mode, 'touch', 'mobile must expose touch steering before the first GO');
  const inactiveGesture = await page.evaluate(() => {
    const before = window.__harness.mobileStatus();
    const event = new Event('gesturestart', { bubbles:true, cancelable:true });
    document.querySelector('[data-mobile-action="drift"]')?.dispatchEvent(event);
    return {
      prevented:event.defaultPrevented,
      before:Number(before.gestureSuppressions),
      after:Number(window.__harness.mobileStatus().gestureSuppressions),
    };
  });
  assert.equal(inactiveGesture.prevented, false,
    'Safari gestures must remain browser-owned while the driver selector is active');
  assert.equal(inactiveGesture.after, inactiveGesture.before);
  assert.equal(await page.locator('.mobile-mode').textContent(), '转向 · 触控');
  assert.ok(Number(status.fullscreenRequests) >= 1,
    `any real driver-selector click may request fullscreen: ${JSON.stringify(status)}`);
  assert.equal(status.fullscreenRequestSource, 'control');
  const goGesturesBefore = Number(status.fullscreenGoGestures);
  await contractGo.click();
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(Number(status.fullscreenGoGestures), goGesturesBefore + 1,
    `GO must retain its own reliable fullscreen path even after selector interactions: ${JSON.stringify(status)}`);
  assert.equal(status.activation, 'ready', 'default touch steering must not wait for sensor calibration');
  assert.equal(status.mode, 'touch');

  const mode = page.locator('.mobile-mode');
  const touchActions = await readMobileControlGeometry(page);
  const topControlsOverlap = await page.evaluate(() => {
    const modeRect = document.querySelector('.mobile-mode')?.getBoundingClientRect();
    const soundRect = document.querySelector('.audio-mixer-toggle')?.getBoundingClientRect();
    if (!modeRect || !soundRect) return false;
    return Math.min(modeRect.right, soundRect.right) > Math.max(modeRect.left, soundRect.left) &&
      Math.min(modeRect.bottom, soundRect.bottom) > Math.max(modeRect.top, soundRect.top);
  });
  assert.equal(topControlsOverlap, false, 'SOUND may not cover the tilt/touch mode switch');

  // Gravity steering remains an explicit opt-in. Only this mode-switch click
  // may enter the permission/calibration path.
  await mode.click();
  await page.waitForFunction(() => {
    const s = window.__harness.mobileStatus();
    return s.activation === 'calibrating' || s.activation === 'ready';
  });
  status = await page.evaluate(() => window.__harness.mobileStatus());
  if (status.activation === 'calibrating') {
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        const event = new Event('deviceorientation');
        Object.defineProperties(event, {
          beta: { value: 0.6 },
          gamma: { value: 0.4 },
        });
        window.dispatchEvent(event);
      });
      await page.waitForTimeout(55);
    }
  }
  await page.waitForFunction(() => window.__harness.mobileStatus().activation === 'ready', null, { timeout: 2500 });
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).mode, 'tilt',
    'the explicit mode switch must still enable calibrated gravity steering');
  const tiltActions = await readMobileControlGeometry(page);
  for (const action of ['drift', 'flight']) {
    const before = tiltActions.controls[action];
    const after = touchActions.controls[action];
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      assert.ok(Math.abs(before[edge] - after[edge]) < 0.5,
        `${action} must not move when steering mode changes (${edge}: ${before[edge]} -> ${after[edge]})`);
    }
    assert.ok(after.faceCenterX > touchActions.width * 0.58,
      `${action} must remain in the right-thumb skill zone: ${JSON.stringify(after)}`);
  }

  await mode.click();
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).mode, 'touch',
    'the mode switch must return immediately to touch steering');
  assert.ok(touchActions.controls.drift.faceCenterX > touchActions.controls.flight.faceCenterX &&
    touchActions.controls.drift.faceCenterY > touchActions.controls.flight.faceCenterY,
  'drift must be the lower-right primary skill and flight its upper-left secondary skill');
  for (const action of ['left', 'right']) {
    assert.ok(touchActions.controls[action].faceCenterX < touchActions.width * 0.44,
      `${action} must remain in the left-thumb steering zone: ${JSON.stringify(touchActions.controls[action])}`);
  }

  await page.evaluate(() => {
    window.__harness.scenario('flight-route5-turn');
    window.__gamepadFixture.clearVibrations();
  });
  const mobileRouteGuidance = await page.evaluate(() => window.__harness.guidance());
  assert.equal(mobileRouteGuidance.actionCue, 'turn');
  assert.equal(mobileRouteGuidance.actionDirection, 'right');
  assert.equal(await page.locator('.mobile-controls').evaluate((element) =>
    element.classList.contains('route-action-turn') && element.classList.contains('route-turn-right')), true,
  'the fifth-flight bend must pair air brake with the fixed right steering zone');
  assert.equal(await page.locator('.hud-turn-warning').isVisible(), false,
    'phone guidance must stay in-world and on the controls instead of adding a text card');
  const routeTurnActions = await readMobileControlGeometry(page);
  await page.locator('.mobile-controls').evaluate((element) => {
    element.classList.remove('route-action-turn', 'route-turn-right');
  });
  const routeNeutralActions = await readMobileControlGeometry(page);
  await page.locator('.mobile-controls').evaluate((element) => {
    element.classList.add('route-action-turn', 'route-turn-right');
  });
  for (const action of ['drift', 'flight', 'left', 'right']) {
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      assert.ok(Math.abs(routeTurnActions.controls[action][edge] - routeNeutralActions.controls[action][edge]) < 0.5,
        `route guidance may not move the ${action} hit zone (${edge})`);
    }
  }
  await page.evaluate(() => window.__harness.advance(0.1));
  vibrationLog = await page.evaluate(() => window.__gamepadFixture.vibrations());
  assert.equal(vibrationLog.length, 0,
    `settled route markers must not emit any extra vibration: ${JSON.stringify(vibrationLog)}`);

  // Exercise the production path that failed in the shipped v7 build:
  // migrated novice -> first failure -> immediate continue -> real GO ->
  // contextual mobile spotlight. No visual fixture or forced coach state.
  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  await page.evaluate(() => window.__harness.advance(0.6));
  let firstFailure = await page.evaluate(() => window.__harness.playerState());
  assert.equal(firstFailure.retryLessonActive, true);
  assert.equal(firstFailure.retryLessonMinRead, 0, 'the first-failure offer must be skippable immediately');
  assert.equal(firstFailure.coachStatus, 'active');
  assert.equal(await page.locator('.hud-lesson-continue').textContent(), '带标注再冲');
  await page.locator('.hud-lesson-continue').click();
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'ready');
  await page.locator('.driver-select-go').click();
  await page.evaluate(() => window.__harness.advance(4.35));
  await page.evaluate(() => {
    for (let i = 0; i < 30 && !window.__harness.playerState().coachVisible; i++) window.__harness.advance(0.15);
  });
  const liveMobileCoach = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value && { left:value.left, right:value.right, top:value.top, bottom:value.bottom };
    };
    return {
      coach:window.__harness.coachState(),
      card:rect('.hud-coach.on'),
      spotlight:rect('.hud-coach-spotlight.on'),
      drift:rect('[data-mobile-action="drift"] span'),
      title:document.querySelector('.hud-coach-title')?.textContent ?? '',
      dim:getComputedStyle(document.querySelector('.hud-coach-spotlight')).getPropertyValue('--coach-dim').trim(),
    };
  });
  assert.equal(liveMobileCoach.coach.activeStep, 'drift');
  assert.equal(liveMobileCoach.coach.device, 'mobile');
  assert.match(liveMobileCoach.title, /右下「漂」/,
    'the first mobile step must name the actual fixed drift control');
  assert.equal(liveMobileCoach.dim, '.5', 'the phone spotlight must visibly dim everything outside the live control');
  assert.ok(liveMobileCoach.card && liveMobileCoach.spotlight && liveMobileCoach.drift &&
    liveMobileCoach.spotlight.left <= liveMobileCoach.drift.left &&
    liveMobileCoach.spotlight.right >= liveMobileCoach.drift.right &&
    liveMobileCoach.spotlight.top <= liveMobileCoach.drift.top &&
    liveMobileCoach.spotlight.bottom >= liveMobileCoach.drift.bottom,
  `the real post-failure path must frame the live drift thumb control: ${JSON.stringify(liveMobileCoach)}`);
  await page.locator('.hud-coach-close').click();
  await page.evaluate(() => window.__harness.advance(1 / 30));
  firstFailure = await page.evaluate(() => window.__harness.playerState());
  assert.equal(firstFailure.coachStatus, 'disabled');
  assert.equal(firstFailure.coachVisible, false, 'mobile must be able to close the guide from its first visible step');

  // With the production touch adapter activated by GO, a held contextual
  // action must hand air-brake ownership to drift on the exact landing step.
  // This runs after novice onboarding assertions so accepted gameplay edges
  // cannot pre-master the first-failure curriculum under test above.
  await page.evaluate(() => {
    window.__harness.scenario('flight-descent');
    window.__harness.usePlayerInput(true);
  });
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerdown', {
    pointerId: 71, pointerType: 'touch', isPrimary: true,
  });
  const mobileWaterContact = await advanceToControlledWaterContact(page);
  assert.equal(mobileWaterContact.after.drifting, true,
    `a held mobile air-brake must become drift at water contact: ${JSON.stringify(mobileWaterContact)}`);
  assert.ok(mobileWaterContact.after.boostCharge > 0 && mobileWaterContact.after.boostCharge < 0.08);
  assert.ok(mobileWaterContact.after.flightAirBrake < 0.001);
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerup', {
    pointerId: 71, pointerType: 'touch', isPrimary: true,
  });
  await page.evaluate(() => {
    window.__harness.advance(1 / 60);
    window.__harness.usePlayerInput(false);
  });

  // The medal presentation and resume countdown expose direction/drift for
  // preloading, but keep flight disabled. A touch that begins after the medal
  // appears must survive presentation -> preparing -> racing.
  await page.evaluate(() => {
    window.__harness.scenario('start');
    window.__harness.passFlight(0);
    window.__harness.passFlight(1);
    window.__harness.passFlight(2);
    window.__harness.usePlayerInput(true);
  });
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.controlPhase, 'presentation', 'third flight must enter the mobile medal presentation');
  const presentationHitTargets = await page.evaluate(() => {
    const hit = (action) => {
      const el = document.querySelector(`[data-mobile-action="${action}"]`);
      const rect = el?.getBoundingClientRect();
      if (!rect) return null;
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        ?.closest('[data-mobile-action]')?.getAttribute('data-mobile-action') ?? null;
    };
    return { left:hit('left'), drift:hit('drift'), flight:hit('flight') };
  });
  assert.equal(presentationHitTargets.left, 'left',
    `medal overlay must not swallow the visible steering zone: ${JSON.stringify(presentationHitTargets)}`);
  assert.equal(presentationHitTargets.drift, 'drift',
    `medal overlay must not swallow the visible drift zone: ${JSON.stringify(presentationHitTargets)}`);
  assert.notEqual(presentationHitTargets.flight, 'flight',
    'the medal presentation must keep the edge-triggered flight control disabled');
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointerdown', { pointerId: 31, pointerType: 'touch', isPrimary: true });
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerdown', { pointerId: 32, pointerType: 'touch', isPrimary: true });
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'left'], 'pointers pressed on the medal must remain owned by the controls');
  await page.evaluate(() => window.__harness.advance(4.6));
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.controlPhase, 'preparing');
  const preparingCharge = (await page.evaluate(() => window.__harness.playerState())).flightCharges;
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointerdown', { pointerId: 21, pointerType: 'touch', isPrimary: true });
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerdown', { pointerId: 22, pointerType: 'touch' });
  await page.locator('[data-mobile-action="flight"]').dispatchEvent('pointerdown', { pointerId: 23, pointerType: 'touch' });
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'left'], 'preparing may capture steering/drift but never flight');
  await page.evaluate(() => window.__harness.advance(2));
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).controlPhase, 'preparing');
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'left'], 'held preparation pointers must survive the frozen countdown');
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointerup', { pointerId: 21, pointerType: 'touch' });
  await page.evaluate(() => window.__harness.advance(2.3));
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.controlPhase, 'racing');
  await page.evaluate(() => window.__harness.advance(1.15));
  const resumedState = await page.evaluate(() => window.__harness.playerState());
  assert.equal(resumedState.flightPhase, 'surface');
  assert.equal(resumedState.drifting, true);
  assert.equal(resumedState.driftReleaseReady, true);
  assert.equal(resumedState.flightCharges, preparingCharge,
    'a rejected preparing flight tap must not alter the legitimately preserved spare cell');
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerup', { pointerId: 22, pointerType: 'touch' });
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointerup', { pointerId: 31, pointerType: 'touch' });
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointerup', { pointerId: 32, pointerType: 'touch' });
  await page.evaluate(() => window.__harness.advance(1 / 30));
  assert.equal((await page.evaluate(() => window.__harness.playerState())).flightCharges, Math.min(5, preparingCharge + 1),
    'releasing the held drift after GO must add exactly one cell');
  await page.evaluate(() => window.__harness.usePlayerInput(false));

  await page.evaluate(() => window.__harness.scenario('start'));
  status = await page.evaluate(() => window.__harness.mobileStatus());
  assert.equal(status.controlPhase, 'racing', 'racing must activate the scoped game-surface gesture guard');
  const activeGestures = await page.evaluate(() => {
    const target = document.querySelector('[data-mobile-action="drift"]');
    const before = window.__harness.mobileStatus();
    const prevented = ['gesturestart', 'gesturechange'].map((type) => {
      const event = new Event(type, { bubbles:true, cancelable:true });
      target?.dispatchEvent(event);
      return event.defaultPrevented;
    });
    const after = window.__harness.mobileStatus();
    return {
      prevented,
      before:Number(before.gestureSuppressions),
      after:Number(after.gestureSuppressions),
      scale:Number(after.pageScale),
    };
  });
  assert.deepEqual(activeGestures.prevented, [true, true],
    'active two-thumb play must suppress Safari pinch gesture defaults');
  assert.equal(activeGestures.after, activeGestures.before + 2);
  assert.ok(Math.abs(activeGestures.scale - 1) < 1e-6,
    `gesture suppression must not mutate viewport scale: ${JSON.stringify(activeGestures)}`);
  const hiddenOverlayGesture = await page.evaluate(() => {
    const root = document.querySelector('.mobile-controls');
    root?.classList.add('overlay-hidden');
    const before = window.__harness.mobileStatus();
    const event = new Event('gesturestart', { bubbles:true, cancelable:true });
    document.querySelector('[data-mobile-action="drift"]')?.dispatchEvent(event);
    const after = window.__harness.mobileStatus();
    root?.classList.remove('overlay-hidden');
    return {
      prevented:event.defaultPrevented,
      before:Number(before.gestureSuppressions),
      after:Number(after.gestureSuppressions),
    };
  });
  assert.equal(hiddenOverlayGesture.prevented, false,
    'a full-screen dossier/gallery overlay must retain browser gesture ownership');
  assert.equal(hiddenOverlayGesture.after, hiddenOverlayGesture.before);
  const geometry = await readMobileControlGeometry(page);
  for (const [name, r] of Object.entries(geometry.controls)) {
    assert.ok(r.width >= 140 && r.height >= 100, `${name} touch target is too small: ${r.width}x${r.height}`);
    assert.ok(r.top >= geometry.height - 170 && r.bottom <= geometry.height, `${name} must stay at the bottom edge`);
    assert.ok(r.faceWidth >= 70 && r.faceWidth <= 100 && r.faceHeight >= 70 && r.faceHeight <= 100,
      `${name} needs a compact thumb disc inside its large hit target: ${JSON.stringify(r)}`);
    assert.equal(r.buttonBackground, 'rgba(0, 0, 0, 0)', `${name} must not paint the rectangular hit target`);
  }
  assert.ok(geometry.controls.right.right < geometry.controls.drift.left,
    'steering and action groups must remain separate');

  // Touch-capable browsers must still accept a real keyboard. The old input
  // branch discarded ArrowLeft/ArrowRight whenever mobile controls existed.
  await page.evaluate(() => window.__harness.usePlayerInput(true));
  await page.keyboard.down('ArrowRight');
  await page.evaluate(() => window.__harness.advance(0.25));
  const keyboardState = await page.evaluate(() => window.__harness.playerState());
  await page.keyboard.up('ArrowRight');
  assert.ok(keyboardState.steer > 0.7,
    `ArrowRight must steer even in a touch-capable Chrome session: ${JSON.stringify(keyboardState)}`);
  await page.evaluate(() => window.__harness.usePlayerInput(false));

  for (const [selector, pointerId] of [
    ['[data-mobile-action="left"]', 31],
    ['[data-mobile-action="drift"]', 32],
    ['[data-mobile-action="flight"]', 33],
  ]) {
    await page.locator(selector).dispatchEvent('pointerdown', { pointerId, pointerType: 'touch', isPrimary: pointerId === 31 });
  }
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'flight', 'left'], 'multi-touch actions must be tracked independently');
  const heldGesture = await page.evaluate(() => {
    const before = window.__harness.mobileStatus();
    const target = document.querySelector('[data-mobile-action="drift"]');
    const events = ['gesturestart', 'gesturechange'].map((type) => {
      const event = new Event(type, { bubbles:true, cancelable:true });
      target?.dispatchEvent(event);
      return event.defaultPrevented;
    });
    return {
      events,
      before:Number(before.gestureSuppressions),
      after:Number(window.__harness.mobileStatus().gestureSuppressions),
    };
  });
  assert.deepEqual(heldGesture.events, [true, true]);
  assert.equal(heldGesture.after, heldGesture.before + 2);
  assert.deepEqual(await page.locator('.held').evaluateAll((els) => els.map((el) => el.dataset.mobileAction).sort()),
    ['drift', 'flight', 'left'], 'Safari gesture suppression must not release or merge owned pointers');
  await page.locator('[data-mobile-action="left"]').dispatchEvent('pointercancel', { pointerId: 31, pointerType: 'touch' });
  await page.locator('[data-mobile-action="drift"]').dispatchEvent('pointercancel', { pointerId: 32, pointerType: 'touch' });
  await page.locator('[data-mobile-action="flight"]').dispatchEvent('pointercancel', { pointerId: 33, pointerType: 'touch' });
  assert.equal(await page.locator('.held').count(), 0, 'cancelled touches must never leave sticky controls');

  await page.evaluate(() => window.__harness.scenario('coach-drift'));
  const coachLayout = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value && { left:value.left, right:value.right, top:value.top, bottom:value.bottom };
    };
    return {
      root:rect('.hud'),
      rootScrollLeft:document.querySelector('.hud')?.scrollLeft ?? -1,
      coach:rect('.hud-coach.on'),
      spotlight:rect('.hud-coach-spotlight.on'),
      objective:rect('.hud-topleft'),
      objectiveStyle:(() => {
        const element = document.querySelector('.hud-topleft');
        if (!element) return null;
        const style = getComputedStyle(element);
        const parent = element.offsetParent?.getBoundingClientRect();
        return {
          left:style.left,
          transform:style.transform,
          translate:style.translate,
          animation:style.animationName,
          offsetLeft:element.offsetLeft,
          scrollX,
          parent:parent && { left:parent.left, right:parent.right },
        };
      })(),
      tower:rect('.race-tower.on'),
      driverPower:rect('.hud-driver-power'),
      flight:rect('[data-mobile-action="flight"]'),
      drift:rect('[data-mobile-action="drift"]'),
      driftDisc:rect('[data-mobile-action="drift"] span'),
      coachState:window.__harness.coachState(),
      playerState:window.__harness.playerState(),
      impactVisible:Boolean(document.querySelector('.hud-impact.on')),
      battleVisible:Boolean(document.querySelector('.hud-battle.on')),
      turnWarningVisible:Boolean(document.querySelector('.hud-turn-warning.on')),
    };
  });
  assert.ok(coachLayout.coach && coachLayout.driverPower && coachLayout.flight && coachLayout.drift && coachLayout.driftDisc,
    `mobile spotlight guide must render with all fixed controls: ${JSON.stringify(coachLayout)}`);
  assert.equal(coachLayout.rootScrollLeft, 0,
    `the clipped HUD must never scroll while focus moves between mobile controls: ${JSON.stringify(coachLayout)}`);
  const overlaps = (a, b, gap = 6) => a && b &&
    a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap;
  assert.equal(overlaps(coachLayout.coach, coachLayout.driverPower), false,
    `coach must not cover the near-boat meter: ${JSON.stringify(coachLayout)}`);
  assert.equal(overlaps(coachLayout.coach, coachLayout.flight), false,
    `coach must not cover the fixed right-thumb flight zone: ${JSON.stringify(coachLayout)}`);
  assert.equal(overlaps(coachLayout.coach, coachLayout.drift), false,
    `coach must not cover the fixed right-thumb drift zone: ${JSON.stringify(coachLayout)}`);
  assert.equal(overlaps(coachLayout.coach, coachLayout.objective), false,
    `coach must not cover the objective block: ${JSON.stringify(coachLayout)}`);
  assert.equal(overlaps(coachLayout.coach, coachLayout.tower), false,
    `coach must not cover the race tower: ${JSON.stringify(coachLayout)}`);
  assert.equal(coachLayout.coachState.focus, 'drift-control');
  assert.ok(coachLayout.spotlight &&
    coachLayout.spotlight.left <= coachLayout.driftDisc.left && coachLayout.spotlight.right >= coachLayout.driftDisc.right &&
    coachLayout.spotlight.top <= coachLayout.driftDisc.top && coachLayout.spotlight.bottom >= coachLayout.driftDisc.bottom,
  `mobile drift onboarding must frame the actual fixed thumb control: ${JSON.stringify(coachLayout)}`);

  // Browsers may discard a hidden 2D backing store. Re-entering READY after a
  // real death must redraw the selected driver's radar, not show an empty box.
  await page.evaluate(() => window.__harness.scenario('flight-no-launch'));
  await page.evaluate(() => window.__harness.advance(0.6));
  await page.locator('.driver-radar').evaluate((canvas) => {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  });
  await page.evaluate(() => window.__harness.advance(4.1));
  await page.evaluate(() => window.__harness.retry());
  await page.waitForTimeout(50);
  assert.equal((await page.evaluate(() => window.__harness.playerState())).phase, 'ready');
  const radarPixels = await page.locator('.driver-radar').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) visible++;
    return visible;
  });
  assert.ok(radarPixels > 1200, `radar must redraw after death and READY restore: ${radarPixels} pixels`);

  await page.evaluate(() => window.__harness.scenario('start'));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.mobile-orientation').isVisible(), true, 'portrait must show the landscape blocker');
  assert.match(await page.locator('.mobile-orientation').textContent() ?? '', /仅支持横屏/);
  assert.equal(await page.locator('.driver-select-go').isVisible(), false, 'portrait blocker must own the whole interaction surface');
  assert.equal(await page.locator('[data-mobile-action="flight"]').isVisible(), false, 'portrait must expose no driving controls');
  const portraitFrozen = await page.evaluate(() => window.__harness.playerState());
  await page.evaluate(() => window.__harness.advance(1));
  const portraitAfter = await page.evaluate(() => window.__harness.playerState());
  assert.deepEqual(
    { raceTime: portraitAfter.raceTime, worldTime: portraitAfter.worldTime, x: portraitAfter.playerX, z: portraitAfter.playerZ },
    { raceTime: portraitFrozen.raceTime, worldTime: portraitFrozen.worldTime, x: portraitFrozen.playerX, z: portraitFrozen.playerZ },
    'portrait blocker must freeze gameplay instead of failing behind the overlay',
  );
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.mobile-orientation').isVisible(), false, 'rotating back must dismiss the blocker');
  assert.equal(await page.locator('[data-mobile-action="flight"]').isVisible(), true, 'landscape controls must recover after rotation');

  await page.evaluate(() => window.__harness.scenario('radio-technique'));
  const mobileBroadcast = await page.evaluate(() => {
    const radio = document.querySelector('.race-radio.broadcast.on')?.getBoundingClientRect();
    const controls = [...document.querySelectorAll('[data-mobile-action]')].map((node) => ({
      name:node.dataset.mobileAction,
      rect:node.getBoundingClientRect(),
    }));
    const collisions = radio ? controls.flatMap(({ name, rect }) => {
      const width = Math.min(radio.right, rect.right) - Math.max(radio.left, rect.left);
      const height = Math.min(radio.bottom, rect.bottom) - Math.max(radio.top, rect.top);
      return width > 1 && height > 1 ? [`${name}:${width.toFixed(1)}x${height.toFixed(1)}`] : [];
    }) : ['missing'];
    return {
      rect:radio && { left:radio.left, right:radio.right, top:radio.top, bottom:radio.bottom },
      collisions,
      text:document.querySelector('.race-radio-body')?.textContent ?? '',
    };
  });
  assert.ok(mobileBroadcast.rect && mobileBroadcast.rect.left >= 0 && mobileBroadcast.rect.right <= 844 &&
    mobileBroadcast.rect.top >= 0 && mobileBroadcast.rect.bottom <= 390,
  `mobile technique radio must remain inside the landscape viewport: ${JSON.stringify(mobileBroadcast)}`);
  assert.deepEqual(mobileBroadcast.collisions, [],
    `mobile technique radio must not cover any touch target: ${JSON.stringify(mobileBroadcast)}`);
  assert.match(mobileBroadcast.text, /空刹压住速度.*转向咬住弯心/);

  const mobileFinal = await page.evaluate(() => window.__harness.finalApproachCase());
  assert.ok(mobileFinal.maxBrakeEnvelope >= 0.9,
    `the mobile Final path must exercise the same return brake: ${JSON.stringify(mobileFinal)}`);
  await page.evaluate(() => window.__harness.advance(1 / 60));
  const finalControls = await page.evaluate(() => {
    const drift = document.querySelector('[data-mobile-action="drift"]');
    const flight = document.querySelector('[data-mobile-action="flight"]');
    const root = document.querySelector('.mobile-controls');
    return {
      drift:drift?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      driftLabel:drift?.getAttribute('aria-label') ?? '',
      flight:flight?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      flightDisabled:flight?.getAttribute('aria-disabled') ?? '',
      overlayHidden:root?.classList.contains('overlay-hidden') ?? false,
    };
  });
  assert.match(finalControls.drift, /刹.*BRAKE/);
  assert.equal(finalControls.driftLabel, '回港刹车');
  assert.match(finalControls.flight, /终.*FINAL/);
  assert.equal(finalControls.flightDisabled, 'true', 'Final flight control must be visibly and semantically inert');
  assert.equal(finalControls.overlayHidden, true,
    'the frozen mobile finale must hide the entire gameplay control layer');
  const mobileEarlyLaunch = await page.evaluate(() =>
    window.__harness.medalEarlyFourthLaunchCase('during-recovery'));
  assert.equal(mobileEarlyLaunch.accepted, true);
  assert.equal(mobileEarlyLaunch.immediateRecoveryOwner, -1);
  assert.equal(mobileEarlyLaunch.immediateActiveOwner, 3);
  assert.equal(mobileEarlyLaunch.immediateVisibleRoutes, 1);
  assert.ok(Math.abs(mobileEarlyLaunch.immediateMaskStartU - 0.493) <= 1e-6);
  const mobileEarlyVisibility = await page.evaluate(() => {
    const effectivelyVisible = (name) => {
      let object = window.__scene.getObjectByName(name);
      if (!object) return false;
      while (object) {
        if (!object.visible) return false;
        object = object.parent;
      }
      return true;
    };
    return {
      flightThree: effectivelyVisible('flight-3-ribbon'),
      flightFour: effectivelyVisible('flight-4-ribbon'),
      launchGate: effectivelyVisible('flight-4-launch-gate'),
    };
  });
  assert.deepEqual(mobileEarlyVisibility, {
    flightThree: false,
    flightFour: true,
    launchGate: false,
  }, 'mobile must use the same atomic route ownership as desktop');

  await page.evaluate(() => {
    window.__harness.scenario('start');
    for (let i = 0; i < 5; i++) window.__harness.earnFlight(false);
  });
  const mobileFullStock = await page.evaluate(() => {
    const root = document.querySelector('.mobile-controls');
    const stock = document.querySelector('.mobile-stock');
    return {
      charges:root?.getAttribute('data-flight-charges') ?? '',
      label:stock?.textContent ?? '',
      color:stock ? getComputedStyle(stock).color : '',
    };
  });
  assert.deepEqual(mobileFullStock, { charges:'5', label:'x5', color:'rgb(248, 255, 122)' },
    `mobile stock must expose and distinguish the five-cell cap: ${JSON.stringify(mobileFullStock)}`);

  console.log('mobile controls contract: OK');
}

async function assertDriverSelectComposition(page, label) {
  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      return r && { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height,
        centerX:(r.left + r.right) / 2, centerY:(r.top + r.bottom) / 2 };
    };
    return {
      width:innerWidth,
      height:innerHeight,
      featured:rect('.driver-featured'),
      portrait:rect('.driver-portrait-frame'),
      identity:rect('.driver-identity'),
      radar:rect('.driver-radar-wrap'),
      backdrop:rect('.driver-mobile-backdrop'),
      go:rect('.driver-select-go'),
      mobileBackdropStyle:(() => {
        const backdrop = document.querySelector('.driver-mobile-backdrop');
        const portrait = document.querySelector('.driver-portrait-frame > .driver-portrait-primary');
        if (!backdrop || !portrait) return null;
        const style = getComputedStyle(backdrop);
        const portraitStyle = getComputedStyle(portrait);
        return {
          display:style.display,
          opacity:Number(style.opacity),
          objectFit:style.objectFit,
          backdropSrc:backdrop.currentSrc,
          portraitSrc:portrait.currentSrc,
          portraitDisplay:getComputedStyle(portrait).display,
          portraitOpacity:Number(portraitStyle.opacity),
          portraitBlend:portraitStyle.mixBlendMode,
          naturalWidth:backdrop.naturalWidth,
          naturalHeight:backdrop.naturalHeight,
          coarse:matchMedia('(pointer:coarse)').matches,
          desktopStage:matchMedia('(pointer:fine) and (min-width:1366px) and (min-height:768px)').matches,
        };
      })(),
      radarBacking:(() => {
        const canvas = document.querySelector('.driver-radar');
        return canvas && { width:canvas.width, height:canvas.height, cssWidth:canvas.clientWidth, cssHeight:canvas.clientHeight, dpr:devicePixelRatio };
      })(),
      radarLayout:(() => {
        const canvas = document.querySelector('.driver-radar');
        try { return JSON.parse(canvas?.dataset.layout ?? 'null'); } catch { return null; }
      })(),
      rosterIndex:document.querySelector('.driver-roster-index')?.textContent ?? '',
      switchControls:[...document.querySelectorAll('.driver-switch-control')].map((node) => rect(`.${node.classList.contains('driver-switch-previous') ? 'driver-switch-previous' : 'driver-switch-next'}`)),
      cardCount:document.querySelectorAll('.driver-card').length,
      visibleCardCount:[...document.querySelectorAll('.driver-card')]
        .filter((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().width > 0).length,
      dotCount:document.querySelectorAll('.driver-dot').length,
      selectedDotCount:document.querySelectorAll('.driver-dot.selected').length,
      archiveCount:document.querySelectorAll('.driver-archive,.driver-archive-button').length,
    };
  });
  const { featured, portrait, identity, radar, go } = geometry;
  assert.ok(featured && portrait && identity && radar && go, `${label} driver composition is incomplete`);
  assert.ok(Math.abs(featured.centerX - geometry.width / 2) <= 1.5,
    `${label} featured stage is not centered: ${JSON.stringify(geometry)}`);
  assert.ok(Math.abs(go.centerX - geometry.width / 2) <= 1.5,
    `${label} contract GO must sit on the center axis: ${JSON.stringify(go)}`);
  assert.match(geometry.rosterIndex, /^选手 \d{2} \/ 06$/, `${label} must expose the current place in the six-driver roster`);
  assert.equal(geometry.switchControls.length, 2, `${label} needs previous and next driver controls`);
  if (geometry.mobileBackdropStyle?.coarse) {
    assert.equal(geometry.radarLayout?.mode, 'compact', `${label} mobile radar must keep its compact layout`);
    assert.ok(geometry.backdrop, `${label} needs a standing mobile portrait`);
    assert.equal(geometry.mobileBackdropStyle.display, 'block', `${label} standing portrait must be visible`);
    assert.equal(geometry.mobileBackdropStyle.objectFit, 'contain', `${label} standing portrait must never be cropped`);
    assert.ok(geometry.mobileBackdropStyle.opacity >= 0.06 && geometry.mobileBackdropStyle.opacity <= 0.18,
      `${label} standing portrait must remain a restrained background echo: ${JSON.stringify(geometry.mobileBackdropStyle)}`);
    assert.equal(geometry.mobileBackdropStyle.backdropSrc, geometry.mobileBackdropStyle.portraitSrc,
      `${label} background and selected driver must stay in sync`);
    assert.deepEqual(
      { width:geometry.mobileBackdropStyle.naturalWidth, height:geometry.mobileBackdropStyle.naturalHeight },
      { width:640, height:960 },
      `${label} standing portrait must use the 2:3 master`,
    );
    assert.ok(Math.abs(geometry.backdrop.width / geometry.backdrop.height - 2 / 3) < 0.02,
      `${label} standing portrait element lost its vertical aspect: ${JSON.stringify(geometry.backdrop)}`);
    assert.notEqual(geometry.mobileBackdropStyle.portraitDisplay, 'none', `${label} must retain a solid foreground portrait`);
    assert.ok(geometry.mobileBackdropStyle.portraitOpacity >= 0.9,
      `${label} foreground portrait must be solid enough to inspect: ${JSON.stringify(geometry.mobileBackdropStyle)}`);
    assert.equal(geometry.mobileBackdropStyle.portraitBlend, 'normal',
      `${label} foreground portrait must not inherit screen blending: ${JSON.stringify(geometry.mobileBackdropStyle)}`);
    assert.ok(radar.left - portrait.right >= 4 && radar.left - portrait.right <= 18,
      `${label} mobile decision column must sit beside, not over, the driver: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(identity.left - radar.left) <= 2 && Math.abs(identity.right - radar.right) <= 2,
      `${label} identity and radar must form one right-side decision column: ${JSON.stringify(geometry)}`);
    assert.ok(radar.bottom <= identity.top + 1,
      `${label} radar and identity must not overlap: ${JSON.stringify(geometry)}`);
  } else {
    assert.ok(Math.abs(identity.centerX - geometry.width / 2) <= 1.5,
      `${label} desktop identity must anchor the screen center: ${JSON.stringify(identity)}`);
    assert.ok(portrait.right < identity.left && identity.right < radar.left,
      `${label} desktop stage must read portrait / identity / radar: ${JSON.stringify(geometry)}`);
    assert.ok(identity.left - portrait.right >= 20 && radar.left - identity.right >= 20,
      `${label} desktop panels need stable breathing room: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(portrait.centerY - radar.centerY) <= 2,
      `${label} desktop portrait and radar left their shared axis: ${portrait.centerY} vs ${radar.centerY}`);
    assert.ok(Math.abs(portrait.width / portrait.height - 2 / 3) < 0.01,
      `${label} desktop portrait must preserve the 2:3 source frame: ${JSON.stringify(portrait)}`);
    assert.equal(geometry.mobileBackdropStyle?.display, 'none', `${label} desktop must retain the framed portrait composition`);
    assert.notEqual(geometry.mobileBackdropStyle?.portraitDisplay, 'none', `${label} desktop framed portrait disappeared`);
    const requiredDpr = Math.min(2, Math.max(1, geometry.radarBacking.dpr));
    assert.ok(geometry.radarBacking.width >= Math.floor(geometry.radarBacking.cssWidth * requiredDpr) - 1 &&
      geometry.radarBacking.height >= Math.floor(geometry.radarBacking.cssHeight * requiredDpr) - 1,
    `${label} radar backing store must cover CSS pixels at bounded DPR: ${JSON.stringify(geometry.radarBacking)}`);
    const radarLayout = geometry.radarLayout;
    assert.equal(radarLayout?.mode, 'desktop', `${label} radar must use the desktop label layout`);
    assert.equal(radarLayout?.labels?.length, 4, `${label} radar must place all four handling labels`);
    assert.ok(radarLayout.radius >= radarLayout.width * 0.27,
      `${label} radar polygon became too small for the data panel: ${JSON.stringify(radarLayout)}`);
    assert.ok(radarLayout.labelGap >= 8 && radarLayout.labelGap <= 14,
      `${label} radar labels must stay close to their vertices: ${JSON.stringify(radarLayout)}`);
    for (const axis of radarLayout.labels) {
      assert.ok(axis.left >= -0.5 && axis.right <= radarLayout.width + 0.5 && axis.top >= -0.5 && axis.bottom <= radarLayout.height + 0.5,
        `${label} radar label ${axis.label} clips outside the canvas: ${JSON.stringify(radarLayout)}`);
      const overlapsPolygon = axis.left < radarLayout.polygon.right && axis.right > radarLayout.polygon.left &&
        axis.top < radarLayout.polygon.bottom && axis.bottom > radarLayout.polygon.top;
      assert.equal(overlapsPolygon, false,
        `${label} radar label ${axis.label} overlaps the data polygon: ${JSON.stringify(radarLayout)}`);
    }
  }
  assert.equal(geometry.cardCount, 6, `${label} must keep all six carousel destinations`);
  assert.equal(geometry.visibleCardCount, geometry.mobileBackdropStyle?.coarse
    ? 0
    : geometry.mobileBackdropStyle?.desktopStage ? 6 : 3,
    `${label} must use the viewport-appropriate roster presentation`);
  assert.equal(geometry.dotCount, 6, `${label} must expose six compact destination marks`);
  assert.equal(geometry.selectedDotCount, 1, `${label} must select one destination mark`);
  assert.equal(geometry.archiveCount, 0, `${label} must not render archive tools`);
  for (const [name, surface] of Object.entries({ featured, portrait, identity, radar })) {
    assert.ok(surface.left >= -1 && surface.right <= geometry.width + 1 && surface.top >= -1 && surface.bottom <= geometry.height + 1,
      `${label} ${name} clips outside the viewport: ${JSON.stringify(surface)}`);
  }
}

async function verifyDesktopDriverTransition(page) {
  const before = await page.evaluate(() => {
    const frame = document.querySelector('.driver-portrait-frame').getBoundingClientRect();
    return {
      selected:document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
      primary:document.querySelector('.driver-portrait-primary')?.currentSrc ?? '',
      frame:{ left:frame.left, top:frame.top, width:frame.width, height:frame.height },
    };
  });
  await page.evaluate(async () => {
    const button = document.querySelector('.driver-switch-next');
    const selected = document.querySelector('.driver-card.selected');
    const cards = [...document.querySelectorAll('.driver-card')];
    const index = cards.indexOf(selected);
    const targetImage = cards[(index + 1) % cards.length]?.querySelector('img');
    await targetImage?.decode?.().catch(() => undefined);
    button.click();
    // Let the already-decoded portrait promise create its WAAPI animation,
    // then pin the intermediate frame before any wall-clock timer can fire.
    await Promise.resolve();
    await Promise.resolve();
    const animation = document.querySelector('.driver-portrait-incoming').getAnimations()[0];
    if (!animation) throw new Error('desktop portrait reveal animation did not start');
    animation.pause();
    animation.currentTime = 90;
  });
  const during = await page.evaluate(() => {
    const root = document.querySelector('.driver-select');
    const incoming = document.querySelector('.driver-portrait-incoming');
    const primary = document.querySelector('.driver-portrait-primary');
    const frame = document.querySelector('.driver-portrait-frame').getBoundingClientRect();
    const style = getComputedStyle(incoming);
    return {
      selected:document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
      switching:root.classList.contains('switching'),
      mode:root.dataset.transitionMode ?? '',
      primary:primary.currentSrc,
      incoming:incoming.currentSrc,
      incomingOpacity:Number(style.opacity),
      incomingClip:style.clipPath,
      contractCards:document.querySelectorAll('.driver-contract-card').length,
      frame:{ left:frame.left, top:frame.top, width:frame.width, height:frame.height },
    };
  });
  assert.notEqual(during.selected, before.selected, 'desktop next must change the logical selection immediately');
  assert.equal(during.switching, true, `desktop reveal must be active at 90ms: ${JSON.stringify(during)}`);
  assert.equal(during.mode, 'desktop');
  assert.equal(during.primary, before.primary, 'the old portrait must remain the stable reveal backing');
  assert.notEqual(during.incoming, during.primary, 'the incoming layer must contain only the destination portrait');
  assert.ok(during.incomingOpacity >= 0.99);
  assert.notEqual(during.incomingClip, 'inset(0px)',
    `the intermediate frame must be directionally clipped, never a full-image double exposure: ${JSON.stringify(during)}`);
  assert.equal(during.contractCards, 0, 'browse changes must not fabricate a DRIVER CONTRACT card');
  assert.deepEqual(during.frame, before.frame, 'portrait reveal must not reflow the stage');
  await page.evaluate(() => {
    document.querySelector('.driver-portrait-incoming').getAnimations()[0]?.finish();
  });
  await page.waitForFunction(() => !document.querySelector('.driver-select').classList.contains('switching'));
  let settled = await page.evaluate(() => ({
    switching:document.querySelector('.driver-select').classList.contains('switching'),
    selected:document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
    selectedSrc:document.querySelector('.driver-card.selected img')?.currentSrc ?? '',
    primary:document.querySelector('.driver-portrait-primary')?.currentSrc ?? '',
    incomingOpacity:Number(getComputedStyle(document.querySelector('.driver-portrait-incoming')).opacity),
  }));
  assert.equal(settled.switching, false);
  assert.equal(settled.primary, settled.selectedSrc, 'settled hero must match the final logical selection');
  assert.equal(settled.incomingOpacity, 0);

  for (let i = 0; i < 8; i++) await page.locator('.driver-switch-next').click();
  const rapidTarget = await page.locator('.driver-card.selected').getAttribute('data-driver');
  await page.waitForTimeout(300);
  settled = await page.evaluate(() => ({
    switching:document.querySelector('.driver-select').classList.contains('switching'),
    selected:document.querySelector('.driver-card.selected')?.dataset.driver ?? '',
    selectedSrc:document.querySelector('.driver-card.selected img')?.currentSrc ?? '',
    primary:document.querySelector('.driver-portrait-primary')?.currentSrc ?? '',
    incomingOpacity:Number(getComputedStyle(document.querySelector('.driver-portrait-incoming')).opacity),
  }));
  assert.equal(settled.selected, rapidTarget, 'rapid browsing must keep the latest requested driver');
  assert.equal(settled.primary, settled.selectedSrc, 'rapid browsing must settle the hero on the latest driver');
  assert.equal(settled.switching, false);
  assert.equal(settled.incomingOpacity, 0);

  await page.emulateMedia({ reducedMotion:'reduce' });
  await page.locator('.driver-switch-next').click();
  await page.waitForTimeout(20);
  const reduced = await page.evaluate(() => ({
    switching:document.querySelector('.driver-select').classList.contains('switching'),
    selectedSrc:document.querySelector('.driver-card.selected img')?.currentSrc ?? '',
    primary:document.querySelector('.driver-portrait-primary')?.currentSrc ?? '',
    incomingOpacity:Number(getComputedStyle(document.querySelector('.driver-portrait-incoming')).opacity),
  }));
  assert.equal(reduced.switching, false, 'reduced motion must switch immediately');
  assert.equal(reduced.primary, reduced.selectedSrc);
  assert.equal(reduced.incomingOpacity, 0);
  await page.emulateMedia({ reducedMotion:'no-preference' });
}

async function waitForDriverRadarBacking(page) {
  await page.waitForFunction(() => {
    const radar = document.querySelector('.driver-radar');
    if (!(radar instanceof HTMLCanvasElement)) return false;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const expectedWidth = Math.max(1, Math.round(radar.clientWidth * dpr));
    const expectedHeight = Math.max(1, Math.round(radar.clientHeight * dpr));
    return Math.abs(radar.width - expectedWidth) <= 1 &&
      Math.abs(radar.height - expectedHeight) <= 1;
  }, undefined, { timeout:2_000 });
}

async function verifyDesktopDriverViewports(page) {
  for (const viewport of [
    { width:1366, height:768 },
    { width:1920, height:1080 },
    { width:2560, height:1440 },
    { width:3440, height:1440 },
  ]) {
    await page.setViewportSize(viewport);
    await waitForDriverRadarBacking(page);
    await assertDriverSelectComposition(page, `desktop-${viewport.width}x${viewport.height}`);
    const layout = await page.evaluate(() => {
      const selectors = ['.driver-select-header', '.driver-featured', '.driver-carousel', '.driver-select-footer'];
      const rects = selectors.map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom };
      });
      const cards = [...document.querySelectorAll('.driver-card')].map((card) => {
        const rect = card.getBoundingClientRect();
        return { id:card.dataset.driver, width:rect.width, height:rect.height };
      });
      return { rects, cards, scrollWidth:document.documentElement.scrollWidth, scrollHeight:document.documentElement.scrollHeight };
    });
    for (let i = 1; i < layout.rects.length; i++) {
      assert.ok(layout.rects[i - 1].bottom <= layout.rects[i].top + 1,
        `desktop bands must not overlap at ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
    }
    assert.ok(layout.scrollWidth <= viewport.width && layout.scrollHeight <= viewport.height,
      `desktop selection must not scroll at ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
    const widths = layout.cards.map((card) => card.width);
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 1,
      `selected desktop card must not reflow the roster: ${JSON.stringify(layout.cards)}`);
  }
  await page.setViewportSize({ width:1440, height:900 });
  await waitForDriverRadarBacking(page);
}

async function readMobileControlGeometry(page) {
  return page.evaluate(() => {
    const result = {};
    for (const action of ['left', 'right', 'drift', 'flight']) {
      const el = document.querySelector(`[data-mobile-action="${action}"]`);
      const r = el.getBoundingClientRect();
      const face = el.querySelector('span').getBoundingClientRect();
      const faceStyle = getComputedStyle(el.querySelector('span'));
      result[action] = {
        left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height,
        faceWidth:face.width, faceHeight:face.height, faceRadius:faceStyle.borderRadius,
        faceCenterX:(face.left + face.right) / 2, faceCenterY:(face.top + face.bottom) / 2,
        buttonBackground:getComputedStyle(el).backgroundColor,
      };
    }
    return { controls:result, width:innerWidth, height:innerHeight };
  });
}

async function assertMobileControlLayout(page, label, mode) {
  const geometry = await readMobileControlGeometry(page);
  const { drift, flight, left, right } = geometry.controls;
  for (const [name, control] of Object.entries({ drift, flight })) {
    assert.ok(control.width >= 140 && control.height >= 100,
      `${label} ${name} touch target is too small: ${control.width}x${control.height}`);
    assert.ok(control.faceCenterX > geometry.width * 0.58,
      `${label} ${name} left the right-thumb skill zone: ${JSON.stringify(control)}`);
    assert.ok(control.faceCenterY > geometry.height * 0.42 && control.bottom <= geometry.height,
      `${label} ${name} is outside the lower thumb-reach band: ${JSON.stringify(control)}`);
  }
  assert.ok(drift.faceCenterX > flight.faceCenterX && drift.faceCenterY > flight.faceCenterY,
    `${label} skill arc must keep drift lower-right and flight upper-left`);
  const faceGap = Math.hypot(drift.faceCenterX - flight.faceCenterX, drift.faceCenterY - flight.faceCenterY);
  assert.ok(faceGap > (drift.faceWidth + flight.faceWidth) * 0.52,
    `${label} skill faces visually collide: gap=${faceGap}`);
  if (mode === 'touch') {
    for (const [name, control] of Object.entries({ left, right })) {
      assert.ok(control.width >= 140 && control.height >= 100,
        `${label} ${name} touch target is too small: ${control.width}x${control.height}`);
      assert.ok(control.faceCenterX < geometry.width * 0.44,
        `${label} ${name} left the left-thumb steering zone: ${JSON.stringify(control)}`);
    }
    const steeringFaceGap = right.faceCenterX - left.faceCenterX;
    const steeringSpan = right.right - left.left;
    const rightButtonCenter = (right.left + right.right) / 2;
    const rightFaceInset = rightButtonCenter - right.faceCenterX;
    assert.ok(steeringFaceGap >= 114 && steeringFaceGap <= 122,
      `${label} steering faces must stay within one left-thumb sweep: gap=${steeringFaceGap}`);
    assert.ok(steeringSpan >= 279 && steeringSpan <= 281,
      `${label} steering hit region spread too far across the screen: span=${steeringSpan}`);
    assert.ok(rightFaceInset >= 21 && rightFaceInset <= 23,
      `${label} right steering face must be inset without shrinking its hit target: inset=${rightFaceInset}`);
    assert.ok(right.faceCenterX - right.faceWidth / 2 >= right.left,
      `${label} inset right steering face escaped its own touch target: ${JSON.stringify(right)}`);
    assert.ok(right.faceCenterX <= geometry.width * 0.3,
      `${label} right steering face is too far for the left thumb: ${JSON.stringify(right)}`);
    assert.ok(right.right < flight.left, `${label} steering and skill hit regions overlap`);
  }
  const hudCollisions = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('.mobile-action-zones span, .mobile-steer-zones span')]
      .filter((element) => {
        const style = getComputedStyle(element.closest('button'));
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      })
      .map((element) => ({ name:element.closest('button')?.dataset.mobileAction ?? 'control', rect:element.getBoundingClientRect() }));
    const surfaces = ['.race-tower-list', '.race-radio.on'].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
      return { name:selector, rect:element.getBoundingClientRect() };
    }).filter(Boolean);
    const hits = [];
    for (const control of controls) {
      for (const surface of surfaces) {
        const width = Math.min(control.rect.right, surface.rect.right) - Math.max(control.rect.left, surface.rect.left);
        const height = Math.min(control.rect.bottom, surface.rect.bottom) - Math.max(control.rect.top, surface.rect.top);
        if (width > 1 && height > 1) hits.push(`${control.name} x ${surface.name} (${width.toFixed(1)}x${height.toFixed(1)})`);
      }
    }
    return hits;
  });
  assert.deepEqual(hudCollisions, [], `${label} controls cover race context: ${hudCollisions.join(', ')}`);
  return geometry;
}

async function activateMobileForScreenshots(page, tiltControls) {
  const contractGo = page.locator('.driver-select-go');
  const legacyStart = page.locator('.mobile-start');
  if (await contractGo.isVisible()) await contractGo.click();
  else if (await legacyStart.isVisible()) await legacyStart.click();
  await page.waitForFunction(() => window.__harness.mobileStatus().activation === 'ready', null, { timeout: 3500 });
  let status = await page.evaluate(() => window.__harness.mobileStatus());
  const mode = page.locator('.mobile-mode');
  if (tiltControls && status.mode !== 'tilt') {
    await mode.click();
    await page.waitForFunction(() => {
      const s = window.__harness.mobileStatus();
      return s.activation === 'calibrating' || s.activation === 'ready';
    });
    status = await page.evaluate(() => window.__harness.mobileStatus());
  }
  if (tiltControls && status.activation === 'calibrating') {
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        const event = new Event('deviceorientation');
        Object.defineProperties(event, {
          beta: { value: 0.6 },
          gamma: { value: 0.4 },
        });
        window.dispatchEvent(event);
      });
      await page.waitForTimeout(55);
    }
  }
  await page.waitForFunction(() => window.__harness.mobileStatus().activation === 'ready', null, { timeout: 3500 });
  assert.equal((await page.evaluate(() => window.__harness.mobileStatus())).mode,
    tiltControls ? 'tilt' : 'touch', `mobile screenshot must use the requested ${tiltControls ? 'tilt' : 'touch'} mode`);
}

async function assertVehicleAssetContract(page) {
  const asset = await page.evaluate(() => {
    const player = window.__scene.getObjectByName('boat-0');
    const rival = window.__scene.getObjectByName('boat-1');
    const hull = player?.getObjectByName('hull');
    const rider = player?.getObjectByName('rider-skinned-shell');
    const rivalRider = rival?.getObjectByName('rider-skinned-shell');
    if (!player || !rival || !hull || !rider || !rivalRider) return null;
    const position = rider.geometry?.getAttribute('position');
    const skinIndex = rider.geometry?.getAttribute('skinIndex');
    const skinWeight = rider.geometry?.getAttribute('skinWeight');
    const color = rider.geometry?.getAttribute('color');
    let blendedVertices = 0;
    if (skinWeight) {
      for (let i = 0; i < skinWeight.count; i++) {
        const second = skinWeight.getY(i);
        if (second > 0.01 && second < 0.99) blendedVertices++;
      }
    }
    const batchNames = [
      'boat-shell-batch',
      'boat-safety-trim-batch',
      'boat-mechanical-batch',
      'boat-flight-hardware-batch',
      'boat-number-batch',
    ];
    const outline = rider.getObjectByName('outline');
    return {
      hullClass: hull.userData.assetClass,
      staticBatchCount: hull.userData.staticBatchCount,
      allBatchesPresent: batchNames.every((name) => hull.getObjectByName(name)?.isMesh === true),
      riderClass: rider.userData.assetClass,
      riderIsSkinned: rider.isSkinnedMesh === true,
      riderBones: rider.skeleton?.bones.length ?? 0,
      positionVertices: position?.count ?? 0,
      skinIndexVertices: skinIndex?.count ?? 0,
      colorVertices: color?.count ?? 0,
      blendedVertices,
      vertexColors: rider.material?.vertexColors === true,
      skinnedOutline: outline?.isSkinnedMesh === true,
      rivalUsesRealSkinInPrepass: rivalRider.isSkinnedMesh === true &&
        (rivalRider.layers.mask & 1) !== 0 && (rivalRider.layers.mask & (1 << 1)) !== 0,
      riderFrustumCulled: rider.frustumCulled === true,
      thrustEffectsCulled: ['thrust-shell', 'thrust-outer', 'thrust-core', 'thrust-flow-rings']
        .every((name) => player.getObjectByName(name)?.frustumCulled === true),
      driftPulseCulled: player.getObjectByName('opponent-drift-burst') === null ||
        player.getObjectByName('opponent-drift-burst')?.getObjectByName('opponent-drift-pulse-lobes')?.frustumCulled === true,
    };
  });
  assert.ok(asset && asset.hullClass === 'five-batch-racing-hydrojet' &&
    asset.staticBatchCount === 5 && asset.allBatchesPresent,
  `boat must remain a five-batch authored racing hydrojet: ${JSON.stringify(asset)}`);
  assert.ok(asset.riderClass === 'batched-skinned-rider' && asset.riderIsSkinned &&
    asset.riderBones === 16 && asset.positionVertices >= 1800 &&
    asset.skinIndexVertices === asset.positionVertices && asset.colorVertices === asset.positionVertices &&
    asset.blendedVertices >= 300 && asset.vertexColors && asset.skinnedOutline &&
    asset.rivalUsesRealSkinInPrepass && asset.riderFrustumCulled &&
    asset.thrustEffectsCulled && asset.driftPulseCulled,
  `rider must remain one palette-skinned articulated mesh at every quality: ${JSON.stringify(asset)}`);
}

async function verifyPerformanceContract(page) {
  const assertBudget = async (label) => {
    const stats = await page.evaluate(() => window.__harness.stats());
    assert.equal(stats.quality, 'auto');
    assert.equal(stats.sortObjects, 1, 'opaque renderables must stay front-to-back sortable');
    assert.ok(stats.drawingPixels <= 2_120_000,
      `${label} drawing buffer exceeds Auto budget: ${stats.drawingPixels}`);
    assert.ok(stats.pixelRatio >= 0.5 && stats.pixelRatio <= 1.25,
      `${label} pixel ratio out of bounds: ${stats.pixelRatio}`);
    return stats;
  };

  await page.evaluate(() => window.__harness.scenario('start'));
  await page.evaluate(() => window.__harness.render());
  await assertVehicleAssetContract(page);
  let stats = await assertBudget('1440x900');
  assert.ok(stats.calls <= 600, `Auto start draw calls ${stats.calls} exceed 600`);
  assert.equal(stats.desktopClarity, 1, 'desktop Auto must expose the headroom clarity governor');
  const baseRatio = stats.pixelRatio;
  await page.evaluate(() => window.__harness.perfFrames(16.7, 260));
  stats = await page.evaluate(() => window.__harness.stats());
  assert.ok(stats.pixelRatio > baseRatio, `sustained headroom must sharpen desktop Auto (${baseRatio} -> ${stats.pixelRatio})`);
  assert.ok(stats.drawingPixels <= stats.clarityPixelBudget + 25_000,
    `clarity governor exceeded its hard drawing budget: ${stats.drawingPixels}`);
  const sharpRatio = stats.pixelRatio;
  await page.evaluate(() => window.__harness.perfFrames(28, 90));
  stats = await page.evaluate(() => window.__harness.stats());
  assert.ok(stats.pixelRatio < sharpRatio, `frame pressure must quickly lower clarity (${sharpRatio} -> ${stats.pixelRatio})`);

  const beforeBurst = stats.resizeCount;
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) window.dispatchEvent(new Event('resize'));
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  stats = await page.evaluate(() => window.__harness.stats());
  assert.equal(stats.resizeCount, beforeBurst + 1, 'one resize burst must rebuild render targets exactly once');

  for (const viewport of [
    { label: '1920x1080', width: 1920, height: 1080 },
    { label: '4k', width: 3840, height: 2160 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertBudget(viewport.label);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const sample = await page.evaluate(() => window.__harness.perfSample(45));
  assert.ok(sample.calls <= 600, `sampled Auto start draw calls ${sample.calls} exceed 600`);
  console.log(`performance contract: OK (${sample.drawingPixels} px, calls ${sample.calls}, ` +
    `software p50/p95/p99 ${Number(sample.p50).toFixed(1)}/${Number(sample.p95).toFixed(1)}/${Number(sample.p99).toFixed(1)}ms)`);
}

async function assertHudDoesNotOverlap(page, label) {
  const overlaps = await page.evaluate(() => {
    const selectors = ['.hud-topleft', '.hud-map', '.hud-power', '.hud-speedo', '.hud-flight-prompt'];
    const items = selectors.map((selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      if (style.display === 'none' || Number(style.opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      return { selector, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }).filter(Boolean);
    const hits = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1) hits.push(`${a.selector} x ${b.selector} (${w.toFixed(1)}x${h.toFixed(1)})`);
      }
    }
    return hits;
  });
  assert.deepEqual(overlaps, [], `${label} HUD overlap: ${overlaps.join(', ')}`);
}

async function assertBattleLeavesDrivingRoiClear(page, label) {
  const hits = await page.evaluate(() => {
    const battle = document.querySelector('.hud-battle');
    if (!battle?.classList.contains('on')) return [];
    const w = innerWidth;
    const h = innerHeight;
    const portrait = w <= 600 && h > 520;
    const roi = portrait
      ? { left: w * 0.16, right: w * 0.84, top: h * 0.30, bottom: h * 0.88 }
      : { left: w * 0.28, right: w * 0.72, top: h * 0.24, bottom: h * 0.84 };
    const selectors = [
      '.hud-battle-sky',
      '.hud-battle-copy',
      '.hud-battle-sky-flash',
      '.hud-battle-shard',
    ];
    const collisions = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        const iw = Math.min(r.right, roi.right) - Math.max(r.left, roi.left);
        const ih = Math.min(r.bottom, roi.bottom) - Math.max(r.top, roi.top);
        if (iw > 1 && ih > 1) collisions.push(`${selector} (${iw.toFixed(1)}x${ih.toFixed(1)})`);
      }
    }
    return collisions;
  });
  assert.deepEqual(hits, [], `${label} battle obscures driving ROI: ${hits.join(', ')}`);
}

async function assertBattleFeedbackVisible(page, label) {
  const feedback = await page.evaluate(() => {
    const battle = document.querySelector('.hud-battle');
    const sky = document.querySelector('.hud-battle-sky');
    const copy = document.querySelector('.hud-battle-copy');
    if (!battle || !sky || !copy) return { active: false, visible: false, detail: 'missing DOM' };
    const rootStyle = getComputedStyle(battle);
    const copyStyle = getComputedStyle(copy);
    const compact = innerHeight <= 520;
    const starStyle = getComputedStyle(sky, '::before');
    const visible = compact
      ? starStyle.content !== 'none' && Number(starStyle.opacity) > 0.2
      : copyStyle.display !== 'none' && Number(copyStyle.opacity) > 0.5 && copy.getBoundingClientRect().width > 80;
    return {
      active: battle.classList.contains('on'),
      visible,
      detail: compact ? `star=${starStyle.content}/${starStyle.opacity}` : `copy=${copyStyle.display}/${copyStyle.opacity}`,
      transparentRoot: rootStyle.backgroundColor === 'rgba(0, 0, 0, 0)',
      text: copy.textContent ?? '',
    };
  });
  assert.equal(feedback.active, true, `${label} battle channel is not active`);
  assert.equal(feedback.visible, true, `${label} has no visible overtake feedback (${feedback.detail})`);
  assert.equal(feedback.transparentRoot, true, `${label} battle root must not add a full-screen plate`);
  assert.match(feedback.text, /OVERTAKE|LEAD TAKEN/, `${label} must name the competitive event`);
}

async function assertCompactActionPromptLeavesDrivingRoiClear(page, label) {
  const hit = await page.evaluate(() => {
    if (innerHeight > 520) return null;
    const prompt = document.querySelector('.hud-flight-prompt.on');
    if (!prompt) return null;
    const r = prompt.getBoundingClientRect();
    const roi = {
      left: innerWidth * 0.28,
      right: innerWidth * 0.72,
      top: innerHeight * 0.24,
      bottom: innerHeight * 0.84,
    };
    const w = Math.min(r.right, roi.right) - Math.max(r.left, roi.left);
    const h = Math.min(r.bottom, roi.bottom) - Math.max(r.top, roi.top);
    return w > 1 && h > 1 ? `${w.toFixed(1)}x${h.toFixed(1)}` : null;
  });
  assert.equal(hit, null, `${label} F prompt obscures the compact driving ROI (${hit})`);
}

async function main() {
  const args = process.argv.slice(2);
  const wantStats = args.includes('--stats');
  const responsive = args.includes('--responsive');
  const verifyFlight = args.includes('--verify-flight');
  const verifyMobile = args.includes('--verify-mobile');
  const verifyPerformance = args.includes('--verify-performance');
  const mobile = args.includes('--mobile');
  const tiltControls = args.includes('--tilt');
  const names = args.filter((a) => !a.startsWith('--'));
  const selected = names.length ? names : (verifyFlight || verifyMobile || verifyPerformance) ? [] : Object.keys(SCENARIOS);

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
      ...(chromePath ? { executablePath: chromePath } : {}),
      // CI containers commonly expose no /dev/dri. ANGLE's software backend
      // still exercises the real WebGL pipeline and keeps screenshots usable.
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--disable-gpu-sandbox',
      ],
    });
    const page = await browser.newPage({
      viewport: mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 },
      deviceScaleFactor: mobile ? 3 : 2,
      reducedMotion: 'no-preference',
      ...(mobile ? { hasTouch: true, isMobile: true } : {}),
    });
    await page.addInitScript(() => {
      const createPad = (index, id) => {
        const buttons = Array.from({ length: 18 }, () => ({ pressed:false, touched:false, value:0 }));
        const effects = [];
        const actuator = {
          effects:['dual-rumble'],
          playEffect(type, options) {
            effects.push({ kind:'play', type, options:{ ...options } });
            return Promise.resolve('complete');
          },
          reset() {
            effects.push({ kind:'reset' });
            return Promise.resolve('complete');
          },
        };
        return {
          connected:false,
          effects,
          gamepad:{
            id, index, connected:true, timestamp:0, mapping:'standard',
            axes:[0,0,0,0], buttons, vibrationActuator:actuator,
          },
        };
      };
      const pads = [
        createPad(0, 'Board Race Idle Controller'),
        createPad(1, 'Thunderobot G50S Test Controller'),
      ];
      const padAt = (index) => {
        const pad = pads[index];
        if (!pad) throw new Error(`unknown virtual pad ${index}`);
        return pad;
      };
      const clearPad = (pad) => {
        pad.gamepad.axes.fill(0);
        for (const button of pad.gamepad.buttons) Object.assign(button, { pressed:false, touched:false, value:0 });
        pad.gamepad.timestamp++;
      };
      const fixture = {
        connect(index = 0) { const pad = padAt(index); pad.connected = true; pad.gamepad.timestamp++; },
        disconnect(index = 0) { const pad = padAt(index); pad.connected = false; pad.gamepad.timestamp++; },
        axis(index, value) { this.padAxis(0, index, value); },
        padAxis(padIndex, index, value) {
          const pad = padAt(padIndex);
          pad.gamepad.axes[index] = value;
          pad.gamepad.timestamp++;
        },
        button(index, pressed) { this.padButton(0, index, pressed); },
        padButton(padIndex, index, pressed) {
          const pad = padAt(padIndex);
          const button = pad.gamepad.buttons[index];
          Object.assign(button, { pressed, touched:pressed, value:pressed ? 1 : 0 });
          pad.gamepad.timestamp++;
        },
        clear(index = 0) { clearPad(padAt(index)); },
        clearAll() { for (const pad of pads) clearPad(pad); },
        disconnectAll() { for (const pad of pads) { pad.connected = false; pad.gamepad.timestamp++; } },
        configure(index, { id, mapping } = {}) {
          const pad = padAt(index);
          if (id !== undefined) pad.gamepad.id = id;
          if (mapping !== undefined) pad.gamepad.mapping = mapping;
          pad.gamepad.timestamp++;
        },
        effects(index = 0) { return padAt(index).effects.map((entry) => structuredClone(entry)); },
        clearEffects(index = null) {
          if (index === null) for (const pad of pads) pad.effects.length = 0;
          else padAt(index).effects.length = 0;
        },
        vibrations() { return [...vibrationLog]; },
        clearVibrations() { vibrationLog.length = 0; },
      };
      const vibrationLog = [];
      Object.defineProperty(window, '__gamepadFixture', { value:fixture });
      Object.defineProperty(navigator, 'vibrate', {
        configurable:true,
        value:(pattern) => {
          vibrationLog.push(pattern);
          return true;
        },
      });
      Object.defineProperty(navigator, 'getGamepads', {
        configurable:true,
        value:() => pads.map((pad) => pad.connected ? pad.gamepad : null),
      });
    });
    page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') console.error(`[console.${msg.type()}] ${msg.text()}`);
    });

    await page.goto(`${BASE}${mobile ? '&mobile=1' : ''}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });

    if (verifyFlight) {
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
      await verifyFlightContract(page);
      await verifyGamepadContract(page);
    }
    if (verifyMobile) {
      // Reproduce the exact browser state created by the rejected v7 release:
      // a complete dormant novice record whose automatic eligibility was false.
      await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('board-race:challenge:v7', JSON.stringify({
          version:7, runs:2, ordinaryUnlocked:false, manMedalsTotal:0, excellentCount:0,
          bestQualificationTime:null, bestExcellentTime:null, bestFlights:0,
          bestRouteProgress:0, closestMissM:null, bestFlightsByDriver:{},
          farSeaDossierUnlocked:false, rivalWins:0, finaleCompletions:0,
          expansionSeenMask:0, finaleScreenshotCount:0,
          coach:{
            status:'dormant', automaticEligible:false,
            mastery:{ steered:false, bankedCharge:false, launched:false, passedRoute:false, airBrakedInTurn:false, extendedFlight:false },
            knowledge:{ bankRule:false, inventory:false, flightGauge:false, extension:false },
          },
        }));
      });
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__harness?.ready, null, { timeout: 60000 });
      await verifyMobileControls(page);
    }
    if (verifyPerformance) await verifyPerformanceContract(page);
    if (mobile && selected.length) {
      await activateMobileForScreenshots(page, tiltControls);
      const mode = page.locator('.mobile-mode');
      if (!tiltControls) {
        assert.equal(await page.locator('.mobile-controls').evaluate((el) => el.classList.contains('touch-steer')), true,
          'default touch steering must expose the two steering zones');
        assert.equal(await mode.textContent(), '转向 · 触控', 'the mode switch must identify default touch steering');
      }
    }

    const mobileSuffix = mobile ? (tiltControls ? '-mobile-tilt' : '-mobile') : '';

    for (const name of selected) {
      const def = SCENARIOS[name];
      if (!def) {
        console.error(`unknown scenario "${name}" — known: ${Object.keys(SCENARIOS).join(', ')}`);
        continue;
      }
      let releaseExpansionImage = null;
      let expansionRoutePattern = null;
      let expansionRouteHandler = null;
      let expansionRequestListener = null;
      const expansionImageRequests = [];
      if (name === 'expansion-gallery') {
        let releaseGate;
        const loadGate = new Promise((resolve) => { releaseGate = resolve; });
        let delayed = false;
        releaseExpansionImage = () => releaseGate();
        expansionRoutePattern = /\/desert(?:-[^/]*)?\.webp(?:\?.*)?$/;
        expansionRouteHandler = async (route) => {
          if (!delayed) {
            delayed = true;
            await loadGate;
            await route.abort('failed');
            return;
          }
          await route.continue();
        };
        expansionRequestListener = (request) => {
          if (/\/assets\/expansions\/[^/?]+\.webp(?:\?.*)?$/.test(request.url())) {
            expansionImageRequests.push(request.url());
          }
        };
        page.on('request', expansionRequestListener);
        await page.route(expansionRoutePattern, expansionRouteHandler);
      }
      console.log(`scenario: ${name} ...`);
      await page.evaluate((n) => window.__harness.scenario(n), def.scenario);
      if (name === 'opponent-drift') {
        await page.evaluate(() => {
          const h = window.__harness;
          let state = h.rivalChainState(1);
          for (let frame = 0; frame < 150 && !(state.drifting && state.holdStarts >= 1); frame++) {
            h.advance(1 / 60);
            state = h.rivalChainState(1);
          }
        });
      }
      if (name === 'final-station') {
        const finalState = await page.evaluate(() => window.__harness.playerState());
        assert.equal(finalState.phase, 'finished', `final station must finish after seven routes: ${JSON.stringify(finalState)}`);
        assert.equal(finalState.flightsCleared, 7);
        assert.equal(finalState.finaleActive, true);
      }
      if (name === 'expansion-gallery') {
        const gallery = page.locator('.expansion-gallery');
        const galleryImage = page.locator('.expansion-gallery-image');
        const galleryLoader = page.locator('.expansion-gallery-loader');
        const mobileControls = page.locator('.mobile-controls');
        const title = page.locator('.expansion-gallery-name');
        const tabs = page.locator('.expansion-gallery-dots button');
        const waitForImage = () => page.waitForFunction(() => {
          const root = document.querySelector('.expansion-gallery');
          const image = document.querySelector('.expansion-gallery-image');
          return root?.classList.contains('on') && !root.classList.contains('loading') &&
            !root.classList.contains('load-error') && image?.classList.contains('ready');
        }, null, { timeout: 10000 });
        assert.equal(await gallery.evaluate((element) => element.classList.contains('on')), true,
          'expansion gallery must open from the frozen finale');
        await page.waitForFunction(() => document.querySelector('.expansion-gallery')?.classList.contains('loading'));
        assert.equal(await gallery.getAttribute('aria-busy'), 'true', 'slow images must expose a busy loading state');
        assert.equal(await galleryLoader.isVisible(), true, 'slow images must show a visible loading surface');
        assert.equal(await galleryLoader.locator('strong').textContent(), '正在载入资料片');
        assert.equal(await galleryLoader.locator('span').textContent(), '01 / 07');
        assert.equal(await page.locator('.expansion-gallery-return').isVisible(), true,
          'return to results must remain available during image loading');
        await page.screenshot({ path: path.join(OUT, `expansion-gallery-loading${mobileSuffix}.png`) });
        if (mobile) {
          assert.equal(await mobileControls.evaluate((element) => element.classList.contains('overlay-hidden')), true,
            'the mobile control layer must yield every game-control pixel to the dossier');
          for (const selector of ['.mobile-start', '.mobile-mode', '.mobile-action-zones', '.mobile-steer-zones', '.mobile-tilt-meter']) {
            assert.equal(await page.locator(selector).isVisible(), false,
              `${selector} must stay hidden while the dossier is open`);
          }
        }
        releaseExpansionImage();
        await page.waitForFunction(() => document.querySelector('.expansion-gallery')?.classList.contains('load-error'));
        assert.equal(await galleryLoader.locator('strong').textContent(), '图片载入失败');
        assert.equal(await galleryLoader.locator('button').isVisible(), true,
          'a failed image must offer an explicit retry instead of a blank screen');
        await page.unroute(expansionRoutePattern, expansionRouteHandler);
        await galleryLoader.locator('button').click();
        await waitForImage();
        assert.equal(await galleryLoader.isVisible(), false, 'the loading surface must leave after the image is decoded');
        assert.equal(await galleryImage.evaluate((image) => image.naturalWidth > 0), true);
        assert.deepEqual([...new Set(expansionImageRequests.map((url) => new URL(url).pathname.split('/').pop()))], ['desert.webp'],
          'opening page one must not prefetch neighboring expansion images');
        assert.equal(await tabs.count(), 7, 'expansion gallery must list seven planned games');
        assert.deepEqual(await tabs.allTextContents(), [
          '沙漠：圣甲虫', '城市：磁轨轮滑手', '雪地：北极狐', '沼泽：树蛙',
          '丛林：长臂猿', '外星：浮空鳐形生命', '肠道：益生菌',
        ]);
        assert.equal(await title.textContent(), '沙漠：圣甲虫');
        await page.keyboard.press('ArrowRight');
        await waitForImage();
        assert.equal(await title.textContent(), '城市：磁轨轮滑手', 'right arrow must advance one page');
        await tabs.nth(6).click();
        await waitForImage();
        assert.equal(await title.textContent(), '肠道：益生菌', 'Chinese game tab must jump directly to its page');
        assert.equal(await page.locator('.expansion-gallery-arrow.next').isDisabled(), true,
          'last page must not wrap to the first page');
        await page.keyboard.press('Escape');
        assert.equal(await gallery.evaluate((element) => element.classList.contains('on')), false,
          'Escape must return to the frozen finale');
        if (mobile) {
          assert.equal(await mobileControls.evaluate((element) => element.classList.contains('overlay-hidden')), true,
            'returning to the frozen finale must keep gameplay controls out of the result composition');
        }
        await page.locator('[data-action="gallery"]').click();
        if (mobile) {
          assert.equal(await mobileControls.evaluate((element) => element.classList.contains('overlay-hidden')), true,
            'reopening the dossier must hide mobile controls again');
        }
        await waitForImage();
        assert.equal(await title.textContent(), '沙漠：圣甲虫', 'reopening starts from the first dossier page');
        const galleryBox = await gallery.boundingBox();
        assert.ok(galleryBox, 'visible gallery must expose a swipe surface');
        await page.mouse.move(galleryBox.x + galleryBox.width * 0.68, galleryBox.y + galleryBox.height * 0.6);
        await page.mouse.down();
        await page.mouse.move(galleryBox.x + galleryBox.width * 0.54, galleryBox.y + galleryBox.height * 0.6, { steps: 4 });
        await page.mouse.up();
        await waitForImage();
        assert.equal(await title.textContent(), '城市：磁轨轮滑手', 'left swipe must advance one page');
        await tabs.nth(0).click();
        await waitForImage();
        if (expansionRequestListener) page.off('request', expansionRequestListener);
      }
      if (def.timeout) await page.waitForTimeout(0); // scenario itself blocks in evaluate
      if (def.settleMs) await page.waitForTimeout(def.settleMs);
      if (name === 'two-flight-taunt') {
        await page.evaluate(() => {
          const impact = document.querySelector('.hud-impact');
          const copy = impact?.querySelector('.hud-impact-copy');
          if (copy instanceof HTMLElement) {
            copy.style.animation = 'none';
            copy.style.opacity = '1';
            copy.style.transform = 'translateX(-50%) skew(-8deg)';
          }
        });
      }

      if (def.freeCamDynamic) {
        await page.evaluate((cfg) => {
          const h = window.__harness;
          // Ask the game for the player pose via stats-free path: use chaseCam-relative math in page.
          const p = cfg.target === 'opponent'
            ? window.__harness.driftingOpponentPose()
            : cfg.target === 'rival'
              ? window.__harness.rivalChainState(cfg.role ?? 0)
              : window.__harness.playerPose();
          const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
          const side = cfg.side ?? 0;
          const lookAhead = cfg.lookAhead ?? 2;
          h.freeCam(
            p.x - fx * cfg.back + fz * side, p.y + cfg.up, p.z - fz * cfg.back - fx * side,
            p.x + fx * lookAhead, p.y + cfg.lookUp, p.z + fz * lookAhead,
          );
        }, def.freeCamDynamic);
      }

      if (name === 'sky-sun') {
        await page.evaluate(() => {
          const p = window.__harness.playerPose();
          const s = [0.53, 0.455, 0.76];
          window.__harness.freeCam(
            p.x, p.y + 2.2, p.z,
            p.x + s[0] * 260, p.y + 2.2 + s[1] * 260, p.z + s[2] * 260,
          );
        });
      }

      if (name === 'wake-close') {
        await page.evaluate(() => {
          const scene = window.__scene;
          const hidden = [
            scene.getObjectByName('racing-line'),
            scene.getObjectByName('surface-guide-chevrons'),
            scene.getObjectByName('surface-guide-chevron-ink'),
            ...Array.from({ length: 5 }, (_, index) => scene.getObjectByName(`wake-${index + 1}`)),
            ...Array.from({ length: 5 }, (_, index) => scene.getObjectByName(`boat-${index + 1}`)),
          ];
          for (const object of hidden) if (object) object.visible = false;
        });
      }

      await page.evaluate(() => window.__harness.render());
      await assertBattleLeavesDrivingRoiClear(page, name);
      await assertCompactActionPromptLeavesDrivingRoiClear(page, name);
      await page.screenshot({ path: path.join(OUT, `${name}${mobileSuffix}.png`) });
      if (name === 'wake-close') {
        await page.evaluate(() => {
          const wake = window.__scene.getObjectByName('wake-0');
          if (wake) wake.visible = false;
          window.__harness.render();
        });
        await page.screenshot({ path: path.join(OUT, `wake-close-no-wake${mobileSuffix}.png`) });
        await page.evaluate(() => {
          const wake = window.__scene.getObjectByName('wake-0');
          if (wake) wake.visible = true;
          window.__harness.render();
        });
      }
      if (name === 'final-rival-portal') {
        const occlusion = await page.evaluate(() => {
          const h = window.__harness;
          const canvas = document.querySelector('#app > canvas');
          const station = window.__scene.getObjectByName('final-station');
          const rival = window.__scene.getObjectByName('boat-1');
          if (!(canvas instanceof HTMLCanvasElement) || !station || !rival) return null;
          const riderSkin = rival.getObjectByName('rider-skinned-shell');
          let inkMeshCount = 0;
          rival.traverse((object) => {
            if (object.isMesh && (object.layers.mask & (1 << 1)) !== 0) inkMeshCount++;
          });
          const read = () => {
            h.render();
            const copy = document.createElement('canvas');
            copy.width = canvas.width;
            copy.height = canvas.height;
            const context = copy.getContext('2d', { willReadFrequently: true });
            context.drawImage(canvas, 0, 0);
            return context.getImageData(0, 0, copy.width, copy.height).data;
          };
          station.visible = true;
          rival.visible = true;
          const both = read();
          station.visible = false;
          const boatOnly = read();
          const nonInkMeshes = [];
          rival.traverse((object) => {
            if (object.isMesh && (object.layers.mask & (1 << 1)) === 0) {
              nonInkMeshes.push([object, object.visible]);
              object.visible = false;
            }
          });
          const inkOnly = read();
          for (const [object, visible] of nonInkMeshes) object.visible = visible;
          rival.visible = false;
          const background = read();
          station.visible = true;
          const stationOnly = read();
          rival.visible = true;
          const mask = stationOnly;
          let inkPixels = 0;
          let inkStationPixels = 0;
          let maxInkDelta = 0;
          let solidPixels = 0;
          let solidEnergy = 0;
          let haloPixels = 0;
          let haloEnergy = 0;
          for (let i = 0; i < both.length; i += 4) {
            const inkDelta = Math.abs(inkOnly[i] - background[i]) +
              Math.abs(inkOnly[i + 1] - background[i + 1]) +
              Math.abs(inkOnly[i + 2] - background[i + 2]);
            const energyDelta = Math.abs(both[i] - boatOnly[i]) +
              Math.abs(both[i + 1] - boatOnly[i + 1]) +
              Math.abs(both[i + 2] - boatOnly[i + 2]);
            const stationDelta = Math.abs(mask[i] - background[i]) +
              Math.abs(mask[i + 1] - background[i + 1]) +
              Math.abs(mask[i + 2] - background[i + 2]);
            maxInkDelta = Math.max(maxInkDelta, inkDelta);
            if (inkDelta > 28) {
              inkPixels++;
              if (stationDelta > 18) inkStationPixels++;
            }
            // Use the same LAYER_INK ownership as the real prepass. Wake,
            // contact shadows and energy attachments belong outside this mask.
            if (inkDelta > 28 && stationDelta > 18) {
              solidPixels++;
              solidEnergy += energyDelta;
            } else if (inkDelta < 10 && stationDelta > 18) {
              haloPixels++;
              haloEnergy += energyDelta;
            }
          }
          station.visible = true;
          rival.visible = true;
          h.render();
          return {
            inkPixels,
            inkStationPixels,
            maxInkDelta,
            solidPixels,
            solidMeanEnergy: solidEnergy / Math.max(1, solidPixels),
            haloPixels,
            haloMeanEnergy: haloEnergy / Math.max(1, haloPixels),
            rivalVisible: rival.visible,
            riderUsesRealSkinInPrepass: riderSkin?.isSkinnedMesh === true &&
              (riderSkin.layers.mask & 1) !== 0 && (riderSkin.layers.mask & (1 << 1)) !== 0,
            inkMeshCount,
          };
        });
        assert.ok(occlusion && occlusion.rivalVisible && occlusion.solidPixels >= 200 &&
          occlusion.haloPixels >= 500 && occlusion.solidMeanEnergy <= 12 &&
          occlusion.haloMeanEnergy >= occlusion.solidMeanEnergy * 1.8 &&
          occlusion.riderUsesRealSkinInPrepass && occlusion.inkMeshCount === 2,
        `Final energy must halo around an opaque rival instead of shining through it: ${JSON.stringify(occlusion)}`);
      }
      if (name === 'opponent-drift') {
        const chainRole = 1;
        const captureChaseBeat = async (beat, settleSeconds) => {
          const state = await page.evaluate(({ settle, role }) => {
            const h = window.__harness;
            h.chaseCam();
            if (settle > 0) h.advance(settle);
            h.render();
            const player = h.playerPose();
            const rival = h.rivalChainState(role);
            const companion = h.rivalChainState(role === 0 ? 1 : 0);
            const dx = rival.x - player.x;
            const dz = rival.z - player.z;
            const companionDx = companion.x - player.x;
            const companionDz = companion.z - player.z;
            return {
              ...rival,
              chaseDistance: Math.hypot(dx, dz),
              chaseForward: dx * Math.sin(player.heading) + dz * Math.cos(player.heading),
              companion: {
                ...companion,
                chaseDistance: Math.hypot(companionDx, companionDz),
                chaseForward: companionDx * Math.sin(player.heading) + companionDz * Math.cos(player.heading),
              },
            };
          }, { settle: settleSeconds, role: chainRole });
          assert.ok(state.chaseDistance >= 10 && state.chaseDistance <= 35 && state.chaseForward > 0,
            `${beat} chase proof needs the real lead rival 10-35m ahead: ${JSON.stringify(state)}`);
          assert.ok(state.companion.chaseDistance >= 10 && state.companion.chaseDistance <= 35 &&
            state.companion.chaseForward > 0,
          `${beat} chase proof must keep both strong rivals in the real learning view: ${JSON.stringify(state)}`);
          await page.screenshot({ path: path.join(OUT, `opponent-drift-chase-${beat}${mobileSuffix}.png`) });
          return state;
        };
        const hold = await captureChaseBeat('hold', 1 / 60);
        assert.ok(hold.drifting && hold.burstStrength === 0,
          `hold chase screenshot must stay free of continuous exhaust: ${JSON.stringify(hold)}`);
        const release = await page.evaluate(({ startReleaseBeats, role }) => {
          const h = window.__harness;
          let state = h.rivalChainState(role);
          for (let frame = 0; frame < 120; frame++) {
            h.advance(1 / 60);
            state = h.rivalChainState(role);
            if (state.releaseBeats > startReleaseBeats && state.boosting && !state.drifting) break;
          }
          return state;
        }, { startReleaseBeats: hold.releaseBeats, role: chainRole });
        assert.ok(release.releaseBeats > hold.releaseBeats && release.boosting && !release.drifting &&
          release.phase === 'release' && release.burstStrength > 0 && release.burstActive,
          `release screenshot must come from a real stern burst payout: ${JSON.stringify(release)}`);
        const releaseChase = await captureChaseBeat('release', 0.12);
        assert.ok(releaseChase.boosting && !releaseChase.drifting && releaseChase.phase === 'release' &&
          releaseChase.burstStrength > 0 && releaseChase.burstActive,
          `release chase screenshot must show the real stern pulse: ${JSON.stringify(releaseChase)}`);
        const burstContract = await page.evaluate((role) => {
          const state = window.__harness.rivalChainState(role);
          const burst = window.__scene.getObjectByName(`boat-${state.id}`)?.getObjectByName('opponent-drift-burst');
          const lobes = burst?.getObjectByName('opponent-drift-pulse-lobes');
          return {
            childCount: burst?.children?.length ?? -1,
            instanced: Boolean(lobes?.isInstancedMesh),
            instances: lobes?.count ?? -1,
            depthTest: lobes?.material?.depthTest ?? null,
            energyLayer: Boolean((lobes?.layers?.mask ?? 0) & (1 << 2)),
            fragmentShader: lobes?.material?.fragmentShader ?? '',
          };
        }, chainRole);
        assert.deepEqual({
          ...burstContract,
          fragmentShader: undefined,
        }, {
          childCount: 1,
          instanced: true,
          instances: 12,
          depthTest: true,
          energyLayer: true,
          fragmentShader: undefined,
        }, `drift release must stay one depth-aware instanced energy draw: ${JSON.stringify(burstContract)}`);
        assert.doesNotMatch(burstContract.fragmentShader, /\bdiscard\b/,
          'drift pulse must stay on the pooled transparent alpha path');
        const burstPixels = await page.evaluate((role) => {
          const h = window.__harness;
          const canvas = document.querySelector('#app > canvas');
          const state = h.rivalChainState(role);
          const burst = window.__scene.getObjectByName(`boat-${state.id}`)?.getObjectByName('opponent-drift-burst');
          if (!(canvas instanceof HTMLCanvasElement) || !burst) return null;
          const read = () => {
            h.render();
            const copy = document.createElement('canvas');
            copy.width = canvas.width;
            copy.height = canvas.height;
            const context = copy.getContext('2d', { willReadFrequently:true });
            context.drawImage(canvas, 0, 0);
            return context.getImageData(0, 0, copy.width, copy.height).data;
          };
          const wasVisible = burst.visible;
          burst.visible = false;
          const withoutBurst = read();
          burst.visible = true;
          const withBurst = read();
          burst.visible = wasVisible;
          h.render();
          let changed = 0;
          let deltaSum = 0;
          for (let i = 0; i < withBurst.length; i += 4) {
            const delta = Math.abs(withBurst[i] - withoutBurst[i]) +
              Math.abs(withBurst[i + 1] - withoutBurst[i + 1]) +
              Math.abs(withBurst[i + 2] - withoutBurst[i + 2]);
            if (delta <= 8) continue;
            changed++;
            deltaSum += delta;
          }
          const rect = canvas.getBoundingClientRect();
          const deviceArea = Math.max(1, (canvas.width / Math.max(1, rect.width)) *
            (canvas.height / Math.max(1, rect.height)));
          return {
            changed,
            changedCss: changed / deviceArea,
            meanDelta: deltaSum / Math.max(1, changed),
          };
        }, chainRole);
        assert.ok(burstPixels && burstPixels.changedCss >= 220 && burstPixels.meanDelta >= 12,
          `the normal 10-35m chase view must carry a readable release pulse: ${JSON.stringify(burstPixels)}`);
        await page.screenshot({ path: path.join(OUT, `opponent-drift-release${mobileSuffix}.png`) });
        const rechain = await page.evaluate(({ start, role }) => {
          const h = window.__harness;
          let state = h.rivalChainState(role);
          for (let frame = 0; frame < 150; frame++) {
            h.advance(1 / 60);
            state = h.rivalChainState(role);
            if (state.holdStarts > start.holdStarts && state.drifting && state.burstStrength === 0) break;
          }
          return state;
        }, { start: { holdStarts: hold.holdStarts }, role: chainRole });
        assert.ok(rechain.holdStarts > hold.holdStarts && rechain.drifting && rechain.burstStrength === 0,
          `rechain screenshot must return to a clean real hold: ${JSON.stringify(rechain)}`);
        const rechainChase = await captureChaseBeat('rechain', 1 / 60);
        assert.ok(rechainChase.drifting && rechainChase.burstStrength === 0,
          `rechain chase screenshot must restore a clean stern: ${JSON.stringify(rechainChase)}`);
        const readyPulse = await page.evaluate((role) => {
          const h = window.__harness;
          h.scenario('ready');
          h.render();
          return h.rivalChainState(role);
        }, chainRole);
        assert.equal(readyPulse.burstActive, false,
          `READY must clear every rival drift-release burst: ${JSON.stringify(readyPulse)}`);
      }
      if (name === 'final-station') {
        const impactState = await page.evaluate(() => window.__harness.playerState());
        assert.ok(['impact', 'crown'].includes(impactState.finaleVisualPhase),
          `final station impact phase must be visible: ${JSON.stringify(impactState)}`);
        const frozenPose = {
          x: impactState.playerX, y: impactState.playerY, z: impactState.playerZ,
          heading: impactState.heading, raceTime: impactState.raceTime, worldTime: impactState.worldTime,
        };
        await page.evaluate(() => window.__harness.advance(0.65));
        await page.evaluate(() => window.__harness.render());
        const heroState = await page.evaluate(() => window.__harness.playerState());
        assert.ok(['crown', 'hero'].includes(heroState.finaleVisualPhase),
          `final station hero phase must be visible: ${JSON.stringify(heroState)}`);
        assert.deepEqual({
          x: heroState.playerX, y: heroState.playerY, z: heroState.playerZ,
          heading: heroState.heading, raceTime: heroState.raceTime, worldTime: heroState.worldTime,
        }, frozenPose, 'finale presentation must freeze race state during the hero beat');
        await page.screenshot({ path: path.join(OUT, `final-station-hero${mobileSuffix}.png`) });
        await page.evaluate(() => window.__harness.advance(2.6));
        await page.evaluate(() => window.__harness.render());
        const settledState = await page.evaluate(() => window.__harness.playerState());
        assert.equal(settledState.finaleVisualPhase, 'settled');
        assert.equal(settledState.finaleActionsVisible, true, 'finale actions must wait for the minimum read');
        assert.equal(settledState.finaleFocusedAction, 'gallery',
          'the mysterious dossier must own default keyboard/gamepad confirmation');
        assert.match(await page.locator('[data-action="gallery"]').textContent() ?? '', /神秘资料片/);
        if (mobile) {
          assert.equal(await page.locator('.mobile-controls').evaluate((element) =>
            element.classList.contains('overlay-hidden')), true,
          'the frozen finale must not leave touch controls over the primary dossier action');
        }
        await page.screenshot({ path: path.join(OUT, `final-station-settled${mobileSuffix}.png`) });
      }
      if (wantStats) console.log(JSON.stringify(await page.evaluate(() => window.__harness.stats())));
      console.log(`  -> shots/${name}${mobileSuffix}.png`);

      if (responsive) {
        const viewports = mobile ? [
          { suffix: tiltControls ? 'tilt-844x390' : 'touch-844x390', width:844, height:390 },
          { suffix: tiltControls ? 'tilt-844x330' : 'touch-844x330', width:844, height:330 },
          { suffix: tiltControls ? 'tilt-844x300' : 'touch-844x300', width:844, height:300 },
          { suffix: tiltControls ? 'tilt-932x430' : 'touch-932x430', width:932, height:430 },
        ] : name === 'ready' ? [
          { suffix:'844x390', width:844, height:390 },
          { suffix:'844x330', width:844, height:330 },
          { suffix:'844x300', width:844, height:300 },
          { suffix:'932x430', width:932, height:430 },
        ] : [
          { suffix:'landscape', width:844, height:390 },
        ];
        for (const vp of viewports) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.waitForTimeout(120); // allow ResizeObserver + renderer targets to settle
          await page.evaluate(() => window.__harness.render());
          await page.waitForTimeout(20);
          if (name === 'ready') await assertDriverSelectComposition(page, `${name}-${vp.suffix}`);
          if (mobile) await assertMobileControlLayout(page, `${name}-${vp.suffix}`, tiltControls ? 'tilt' : 'touch');
          await assertHudDoesNotOverlap(page, `${name}-${vp.suffix}`);
          await assertBattleLeavesDrivingRoiClear(page, `${name}-${vp.suffix}`);
          await assertCompactActionPromptLeavesDrivingRoiClear(page, `${name}-${vp.suffix}`);
          await page.screenshot({ path: path.join(OUT, `${name}-${vp.suffix}.png`) });
          console.log(`  -> shots/${name}-${vp.suffix}.png`);
        }
        await page.setViewportSize(mobile ? { width:844, height:390 } : { width:1440, height:900 });
        await page.waitForTimeout(120);
      }
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
