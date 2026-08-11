# 是男人就飞三次

Cel-shaded arcade boat racing on an infinite open ocean. The boat moves automatically; complete three independently earned low-altitude flights and finish first to become `优秀男人`. Vite + Three.js (r185) + TypeScript, ES modules. **Zero external assets**: every mesh is procedural geometry, every texture is generated in code, and every sound is synthesized with Web Audio.

**Play online:** [https://cnwinds.github.io/board-race/](https://cnwinds.github.io/board-race/)

## Run

```bash
npm install
npm run dev
```

Open the printed localhost URL. You start fourth in a six-racer short challenge, with three rivals ahead and two behind.

## Controls

| Input | Action |
| --- | --- |
| Automatic | Forward throttle; no accelerate key |
| `A` `D` / `←` `→` | Steer |
| `Shift` (hold) | Drift on water; contextual vector air-brake while flying |
| `Space` (press) | Spend the earned token and fly |
| `Enter` / `R` | Request another run after success or defeat |

On mobile, landscape is required. Tilt steering is the default; the small mode control switches to touch steering when sensors are unavailable or unwanted. The lower-left half is the contextual `漂/刹` hold zone and the lower-right half is `飞`. Independent pointer tracking supports holding drift/air-brake while tapping flight. iOS pauses the countdown until motion permission is resolved. Audio starts on the first key or touch gesture.

Each of the three flight segments requires a fresh `Shift` drift and release. The first is a wide straight launch, the second is an air-brake chicane, and the third is a faster precision loop. Missing a portal, failing to launch, landing early, or leaving the corridor ends the run immediately. Failure skips the old result modal and enters a focused loading review: first occurrence `3.2s` (`+0.4s` for a real PB), second `1.8s`, then `1.0s`, each with an earlier manual-skip threshold. Three flights without first place unlock `普通男人` once but do not count as the win; only three flights plus first place yields `优秀男人`.

## Architecture

```
src/
  contracts.ts      Shared interfaces (IBoat, ICourse, IWake, ISpray, RaceView, LAYER_INK)
  core/             palette.ts (single source of the limited palette), stage.ts (renderer
                    + adaptive pixel ratio), loop.ts (fixed 60Hz sim), input.ts,
                    mobileControls.ts (tilt steering, touch fallback, multi-touch actions),
                    prePass.ts (MRT normal/depth prepass for edge detection + foam masks)
  water/
    waves.ts        Gerstner field (5 waves) — ONE definition, compiled into both the
                    GLSL chunk (WAVES_GLSL) and the CPU waterHeight() sampler, so
                    buoyancy and rendering can never diverge
    ocean.ts        Infinite ocean: camera-following recentered mesh (dense 1.4m core +
                    coarse lattice to the horizon, stitched crack-free), cel height bands
                    with domain-warped hard thresholds, crest foam scallop arcs, sun-lane
                    quantized glitter, hull foam collars via depth-difference mask
    wake.ts         Persistent wake ribbon per boat: ring-buffer triangle strip, scalloped
                    wash core + diverging V-arms, rotated diamond cutout cells, three
                    hard tone steps (fresh / wash / aged), dissipates by density
    spray.ts        Instanced billboard spray droplets, hard canvas cutout sprite,
                    CPU ballistic sim, killed at the live wave surface
  cel/
    toonMaterial.ts Extended MeshToonMaterial: 4-band ramp (NearestFilter), Fresnel rim,
                    banded specular, banded distance fog
    outline.ts      Inverted-hull ink outlines, screen-space constant width
                    (push scales with view distance)
    edgePass.ts     Sobel normal/depth edge pass for interior lines (second ink system,
                    tuned against the hull outlines so they don't double up)
    postPipeline.ts Beauty/edge pipeline plus selective energy bloom and the event-driven
                    speed tunnel, chroma punch, warning wash, and air-brake bands
    sky.ts          Gradient sky dome, graphic sun (disc + alternating-length rays),
                    two parallax layers of flat cel clouds, all hard steps
    ramp.ts         Gradient ramp texture generation
  game/
    boat.ts         Hull loft + deck/sponsons/spoiler/jet-pump geometry, arcade handling
                    (tapered engine curve, speed-tightened steering, drift→boost→flight
                    token, controlled anti-gravity lift, 5-point Gerstner buoyancy,
                    crest-launch airtime), ink/cyan water footprint under the hull
    jetTrail.ts     Shared instanced ring buffer for lime boost and cyan flight shards
    rider.ts        Code-rigged cel rider, fully procedural skeleton + capsule flesh.
                    Animated from BoatState: lean ∝ lateral G, weight shift ∝ long G,
                    drift hip twist, throttle wrist, landing crouch spring, airborne
                    "whee" pose, idle breathing, celebration pump
    course.ts       CatmullRom circuit plus three canonical-progress 3D flight branches,
                    animated guide rails/portals, water racing line, gates/buoys with foam
                    collars, START/finish gantry + checker strip
    ai.ts           Spline-following AI with lookahead, fixed six-racer pace profiles,
                    collision avoidance, three-flight qualification, deliberate mistakes
    racers.ts       Single source of racer colors, grid ranks, lanes, and pace
    records.ts      v2 local runs/PB/ordinary/excellent record store with v1 migration
    race.ts         Short-run challenge state machine: countdown, hard flight failure,
                    rival elimination/finish, near-zero-latency overtake/lost-position
                    events, ordinary/excellent result contract
    chaseCamera.ts  Spring-damped chase cam, drift/flight/battle impulses, speed FOV,
                    reduced-motion support, cinematic orbit for countdown/results
  hud/
    hud.ts/.css     Responsive minimal goal HUD: flights, 6-racer position, leader gap,
                    edge action feedback, sky-only overtake feedback, focused adaptive
                    loading reviews, and ordinary/excellent result panels
  audio/
    audio.ts        Web Audio synth: engine, water/air crossfade, directional air-brake
                    pressure, anti-gravity hum, impacts, countdown horn, finish jingle
harness/
    screenshot.mjs  Playwright screenshot harness — deterministic (?harness=1) scenarios
                    (three-flight state, fresh-token rule, adaptive loading, ordinary/
                    excellent, mobile controls, battle events), captures into shots/, responsive
                    HUD overlap, driving-ROI, and gameplay assertions
```

## Performance notes

- Fixed 60 Hz simulation, render decoupled; adaptive pixel ratio holds frame time under load.
- Ocean is one draw call per LOD shell; wake is one draw call per boat; spray is one instanced draw call total.
- The screenshot harness reports per-scenario draw calls, triangles, fixed-step frame time,
  route state, and battle events; use it for before/after performance comparisons.
- Zero per-frame allocation in hot paths (ring buffers, module-scope temps).

## Verification harness

```bash
node harness/screenshot.mjs                 # all scenarios → shots/*.png (retina)
node harness/screenshot.mjs water rider     # subset
node harness/screenshot.mjs --stats sweeper # + renderer.info stats
npm run verify:flight                     # three-flight/hard-fail/loading/battle/result assertions
node harness/screenshot.mjs --responsive flight-cruise # desktop + portrait + landscape
node harness/screenshot.mjs --mobile start              # landscape tilt-control capture
node harness/screenshot.mjs --mobile --touch-fallback start
```

`?harness=1` runs the game deterministically (seeded, fixed-step) and exposes `window.__harness` for scenario driving and free-camera placement.
