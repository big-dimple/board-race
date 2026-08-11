# board-race

Cel-shaded arcade boat racing on an infinite open ocean. Vite + Three.js (r185) + TypeScript, ES modules. **Zero external assets** — every mesh is procedural geometry, every texture is generated in code (Canvas 2D or shader noise), every sound is synthesized with the Web Audio API.

**Play online:** [https://cnwinds.github.io/board-race/](https://cnwinds.github.io/board-race/)

## Run

```bash
npm install
npm run dev
```

Open the printed localhost URL. You are dropped straight into a race: 4 boats, 3 laps, countdown start, checkpoints, results screen.

## Controls

| Input | Action |
| --- | --- |
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake / reverse |
| `A` `D` / `←` `→` | Steer (tightens with speed) |
| `Space` (hold) | Drift / powerslide — release for a boost payout |
| `Enter` | Race again (on the results screen) |

Audio starts on the first keypress (browser autoplay policy).

## Architecture

```
src/
  contracts.ts      Shared interfaces (IBoat, ICourse, IWake, ISpray, RaceView, LAYER_INK)
  core/             palette.ts (single source of the limited palette), stage.ts (renderer
                    + adaptive pixel ratio), loop.ts (fixed 60Hz sim), input.ts,
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
    postPipeline.ts EffectComposer wiring (prePass → render → edge → output)
    sky.ts          Gradient sky dome, graphic sun (disc + alternating-length rays),
                    two parallax layers of flat cel clouds, all hard steps
    ramp.ts         Gradient ramp texture generation
  game/
    boat.ts         Hull loft + deck/sponsons/spoiler/jet-pump geometry, arcade handling
                    (tapered engine curve, speed-tightened steering, drift→boost, 5-point
                    Gerstner buoyancy with pitch/roll springs, crest-launch airtime with
                    landing impact), ink blob shadow seating the hull
    rider.ts        Code-rigged cel rider, fully procedural skeleton + capsule flesh.
                    Animated from BoatState: lean ∝ lateral G, weight shift ∝ long G,
                    drift hip twist, throttle wrist, landing crouch spring, airborne
                    "whee" pose, idle breathing, celebration pump
    course.ts       CatmullRom circuit (sweeper, chicane, hairpin, across-the-swell jump
                    section), racing-line ribbon riding the waves, gates/buoys with foam
                    collars, START/finish gantry + checker strip
    ai.ts           Spline-following AI with lookahead, three personalities (aggressive /
                    clean / erratic), rubber-banding, collision avoidance, deliberate mistakes
    race.ts         Race state machine: countdown, laps, checkpoints, wrong-way,
                    positions, split times, finish extrapolation
    chaseCamera.ts  Spring-damped chase cam, speed FOV kick, slam screenshake,
                    cinematic orbit for countdown/results
  hud/
    hud.ts/.css     Cel HUD: skewed ink-bordered panels, speedometer, lap/position,
                    boost meter, minimap (spline + live dots), results table
  audio/
    audio.ts        Web Audio synth: engine pitch ∝ RPM, water rush ∝ speed, impact
                    thuds, countdown beeps + start horn, finish jingle
harness/
    screenshot.mjs  Playwright screenshot harness — deterministic (?harness=1) scenarios
                    (countdown/start/sweeper/chicane/hairpin/airtime/rider/water/finish/
                    results), retina captures into shots/, --stats for draw calls/tris
```

## Performance notes

- Fixed 60 Hz simulation, render decoupled; adaptive pixel ratio holds frame time under load.
- Ocean is one draw call per LOD shell; wake is one draw call per boat; spray is one instanced draw call total.
- Racing: ~200-250 draw calls / ~280k triangles (measured via `node harness/screenshot.mjs --stats`).
- Zero per-frame allocation in hot paths (ring buffers, module-scope temps).

## Verification harness

```bash
node harness/screenshot.mjs                 # all scenarios → shots/*.png (retina)
node harness/screenshot.mjs water rider     # subset
node harness/screenshot.mjs --stats sweeper # + renderer.info stats
```

`?harness=1` runs the game deterministically (seeded, fixed-step) and exposes `window.__harness` for scenario driving and free-camera placement.
