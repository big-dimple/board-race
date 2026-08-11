# 是男人就飞三次

Cel-shaded arcade boat racing on an infinite open ocean. The boat moves automatically; three independently earned flights grant a `男人勋章`, then the same run continues as an endless flight-record chase. Take first place after qualifying to lock `优秀男人`. Vite + Three.js (r185) + TypeScript, ES modules. **Zero external assets**: every mesh is procedural geometry, every texture is generated in code, and every sound is synthesized with Web Audio.

**Play online:** [https://big-dimple.github.io/board-race/](https://big-dimple.github.io/board-race/)

## Run

```bash
npm install
npm run dev
```

Open the printed localhost URL. You start fourth in a six-racer endless challenge, with three rivals ahead and two behind.

## Controls

| Input | Action |
| --- | --- |
| Automatic | Forward throttle; no accelerate key |
| `A` `D` / `←` `→` | Steer |
| `Shift` (hold) | Drift on water; contextual vector air-brake while flying |
| `Space` (press) | Spend the earned token and fly |
| `Enter` / `R` | Skip a readable loading review after its minimum reading time |

On mobile, landscape is required. The first `开始游戏` gesture requests motion permission, attempts fullscreen/landscape, and calibrates a stable neutral angle. Missing or denied sensors fall back to touch steering automatically. Manual mode has two large steering buttons at bottom-left and separate `漂/刹` plus `飞` buttons at bottom-right. Independent pointer tracking supports steering and holding drift/air-brake while tapping flight.

Every flight requires a fresh drift and release. The first is a wide straight launch, the second is an air-brake chicane, and the third is a precision loop. The third pass immediately grants one medal for that run; flights 4-7 continue around the rest of the circuit and the seven routes repeat each lap. Missing a portal, failing to launch, landing early, or leaving the corridor ends the run immediately.

Failure goes directly to one focused loading review. A new failure type displays for `4.5s`, the second occurrence for `3.2s`, and later repeats for `2.2s`; minimum reading times are `2.0s`, `1.4s`, and `1.0s`. A real PB adds `0.5s`, capped at `5s`. Course-deviation reviews always teach the contextual air brake. The screen also settles flights, PB, and any medal already earned before the mistake.

Runs, medals, excellent finishes, PB flights, and closest misses are saved in browser `localStorage` with v1/v2 migration. This persists normal revisits on the same browser and origin, but it is not cloud storage: clearing site data, private browsing, changing domains, or changing devices will not carry records over.

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
    course.ts       CatmullRom circuit plus seven repeating 3D flight branches, a single
                    player-owned active guide, locally masked water line, gates/buoys with foam
                    collars, START/finish gantry + checker strip
    ai.ts           Spline-following AI with lookahead, fixed six-racer pace profiles,
                    collision avoidance, three-flight qualification, deliberate mistakes
    racers.ts       Single source of racer colors, grid ranks, lanes, and pace
    records.ts      v3 local runs/medals/endless-PB record store with v1/v2 migration
    race.ts         Endless challenge state machine: countdown, third-flight qualification,
                    hard flight failure, laps, and overtake/lost-position events
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
                    (qualification, endless PB, fresh-token rule, adaptive loading,
                    mobile controls, route guidance, performance, and battle events)
```

## Performance notes

- Fixed 60 Hz simulation, render decoupled. Auto starts inside a 2.1M drawing-pixel budget,
  reacts to fullscreen/resize within one animation frame, drops quality after 0.5s over
  20ms, and only climbs after 5s below 15.5ms.
- `?quality=performance` uses a 1.3M budget; `?quality=high` uses 4.1M, 2x MSAA,
  half-resolution energy effects, and detailed AI ink. Auto uses an RGBA8 beauty target,
  no MSAA, 0.35-scale energy effects, and simplified distant AI rider silhouettes.
- Ocean is one draw call per LOD shell; wake is one draw call per boat; spray is one instanced draw call total.
- The harness reports drawing pixels, draw calls, triangles, route state, and battle events.
  Its dedicated performance check samples real animation frames; headless software-renderer
  timings are diagnostic only and must not be presented as hardware FPS.
- Zero per-frame allocation in hot paths (ring buffers, module-scope temps).

## Verification harness

```bash
node harness/screenshot.mjs                 # all scenarios → shots/*.png (retina)
node harness/screenshot.mjs water rider     # subset
node harness/screenshot.mjs --stats sweeper # + renderer.info stats
npm run verify:flight                     # qualification/endless/failure/guidance assertions
npm run verify:mobile                     # first gesture, fallback, bottom controls, multi-touch
npm run verify:performance                # pixel budget, resize coalescing, draw-call ceiling
node harness/screenshot.mjs --responsive flight-cruise # desktop + portrait + landscape
node harness/screenshot.mjs --mobile start              # landscape tilt-control capture
node harness/screenshot.mjs --mobile --touch-fallback start
```

`?harness=1` runs the game deterministically (seeded, fixed-step) and exposes `window.__harness` for scenario driving and free-camera placement.
