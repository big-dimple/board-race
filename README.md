# 是男人就飞三次

Cel-shaded arcade boat racing on an open ocean. The boat moves automatically; three independently earned flights grant a `男人勋章`, and seven route flights unlock the golden `FINAL STATION`. Cross it to finish, view the post-race easter egg and expansion dossier, then choose `继续游戏` to carry the same run onward. Take first place after qualifying to lock `优秀男人`. Vite + Three.js (r185) + TypeScript, ES modules. World geometry and effects are authored in code; project character portraits and the owner-supplied score are documented under `src/assets/**/LICENSES.md`.

The dossier is a frozen, full-screen, one-game-per-page viewer for seven planned
games: `沙漠：圣甲虫`, `城市：磁轨轮滑手`, `雪地：北极狐`, `沼泽：树蛙`,
`丛林：长臂猿`, `外星：浮空鳐形生命`, and `肠道：益生菌`. It supports the
arrow buttons, `←` / `→`, `A` / `D`, touch swipes, clickable Chinese page tabs,
and `Esc` / `返回结算`. The images are concept art; the seven playable games
remain tracked in [`docs/expansion-gallery-handoff.md`](docs/expansion-gallery-handoff.md).

**Play online:** [https://big-dimple.github.io/board-race/](https://big-dimple.github.io/board-race/)

## Run

```bash
npm install
npm run dev
```

Open the printed localhost URL. You start fourth in a six-racer challenge, with three rivals ahead and two behind.

The grid is intentionally frozen at `READY`. On desktop, `Enter` or `Space` starts the full `3 · 2 · 1 · GO` countdown. On mobile, the first touch requests fullscreen at the earliest browser-authorized moment; the single `GO` button remains the reliable fullscreen, permission, and calibration gate.

Backgrounding or minimizing the page immediately freezes simulation and hard-mutes audio. Returning never resumes a live run by itself: the player must press `GO`, then a fresh frozen `3 · 2 · 1 · GO` countdown restores control. READY already acts as that explicit resume gate; medal and loading screens resume their unread remainder only after GO.

## Controls

| Input | Action |
| --- | --- |
| Automatic | Forward throttle; no accelerate key |
| `A` `D` / `←` `→` | Steer |
| `Shift` (hold) | Drift on water; contextual vector air-brake while flying |
| `Space` (press) | Start/continue from a frozen prompt; while racing, spend one charge to take off or extend flight |
| `Enter` | Start from READY; immediately continue a failure review |
| `R` | Immediately continue a failure review |
| `Esc` | Close contextual driving tips; READY `?` can enable them again |

Keyboard steering remains active in touch-capable Chrome sessions, including `←` / `→`. Standard-mapped controllers are also supported: left stick or D-pad steers, `A / Cross` flies and confirms, and `X / Square`, `LB`, or `RB` holds drift/air-brake. Connected pads are scanned together and the pad producing deliberate input becomes active; an idle first-listed device cannot block the controller in hand. Unknown browser mappings enter a four-step READY calibration and persist by device signature. Controller rumble and short phone vibration share an independent, default-on `体感反馈` setting and the same no-buffer countdown rule as keyboard input.

On mobile, landscape is required. Portrait mode is a full interaction blocker and freezes the simulation until the device returns to landscape. The first touch attempts fullscreen/landscape; `GO` retries inside its own user gesture, requests motion permission, and calibrates a stable neutral angle. Browsers do not permit fullscreen before any user gesture. Missing or denied sensors fall back to touch steering automatically. Tilt and touch modes share one fixed two-thumb layout: only the left steering zone changes, while the right thumb always owns the lower-right `漂/空刹` primary skill and its upper-left `飞` secondary skill. Each large invisible target presents a compact round thumb disc, so it is easy to hit without painting four crude rectangles over the race. Independent pointer tracking supports steering and holding drift/air-brake while tapping flight.

A qualifying drift release banks one flight charge, up to two; the button rim and near-boat rail mark the release threshold, while a full drift only lengthens the resulting boost. Takeoff spends one charge, and the remaining cell can be spent once during cruise or descent for `+2.4s` of controlled airtime. The early spool/ascending frames reject a second press so a double-tap cannot waste the spare. Passing or missing the portal still starts descent immediately. An unused spare survives landing and the third-flight medal freeze, while a fresh run clears both cells. The base `6.45s` envelope still covers every legal portal approach at 29m/s; the optional extension raises it to `8.85s` for early launches and air-braked turn-in. The first is a wide straight launch, the second is an air-brake chicane, and the third is a precision loop. The third pass freezes the same run for a `4.5s` medal ceremony with a back double-biceps champion medal, `猛男`, fireworks, firecrackers, petals, confetti, and a dedicated audio sting. Flights 4-7 continue around the rest of the circuit; after the seventh route, two golden energy columns charge at the existing finish gantry and wait for a real water-surface crossing. The frozen finale creates a PNG capture, reveals the seven expansion easter-egg tags, and offers `继续游戏` or the pageable dossier. Missing a portal, failing to launch, landing early, or leaving the corridor ends the run immediately.

The first run deliberately contains no onboarding: experienced players can attack the `男人勋章` immediately. The first real failure arms a contextual driving coach for the next run and opens one focused review with the factual miss, one correction, progress/PB, and any medal already earned. It may be continued from its first frame and returns to READY after `5s`; it never launches a run or buffers a flight input. Each live hint observes successful game state instead of raw button presses: a drift is mastered only after crossing the yellow `BANK` mark and releasing into a stored diamond, a launch only after the charge is accepted, and air-brake only through real use in a flight turn. One hint is visible at a time and can be permanently closed by its `×`, keyboard `Esc`, or controller `View / Back`; READY `?` re-enables remaining lessons. Players who reach three flights before their first failure are treated as experts and only receive the one-line failure review.

The near-boat left rail is contextual: drift charge on water, remaining surface `BOOST` after release, or air-brake strength in flight. The yellow line means “enough to bank one cell”; releasing is what stores it. The right rail is the current flight's remaining envelope, while the two diamonds are the actual inventory. Holding a drift longer after the yellow line only lengthens the resulting water boost and never changes the fixed base flight duration. A spare diamond can instead add exactly `+2.4s` during cruise or descent.

Runs, medals, excellent finishes, per-driver PB flights, final completions, expansion pages seen, screenshot counts, closest misses, rival wins, and driving-coach mastery/preferences are saved in versioned browser `localStorage` with v2-v5 record migration into schema v6. Old saves with three flights or an unlocked medal migrate as experts; other old saves receive the optional coach only after their next real failure. A deployment on a stable HTTPS domain persists normal revisits on the same browser profile and origin. Clearing site data or private browsing still removes local records; the versioned data contract remains suitable for a future authenticated server sync. Archive controls stay out of the selection screen so the first decision remains focused.

Audio uses the complete owner-selected 127-second instrumental rock track plus Web Audio engine, restrained water/air pressure, air-brake, gate, collision, battle, failure, and medal layers. The first explicit GO starts the song from its opening and brings it in progressively; later runs, loading, medals, and READY preserve the same browser-session timeline. Only the natural end loops back to the song opening. `SOUND` exposes separate master, music, effects, ambience, visible percentages, audition feedback, and mute. Critical events duck the score, a 48Hz safety high-pass and 16:1 limiter protect phone speakers, and backgrounding pauses both media and context immediately until explicit GO resumes it.

## Architecture

```
src/
  contracts.ts      Shared interfaces (IBoat, ICourse, IWake, ISpray, RaceView, LAYER_INK)
  core/             palette.ts (single source of the limited palette), stage.ts (renderer
                    + adaptive pixel ratio), loop.ts (fixed 60Hz sim), input.ts,
                    gamepadInput.ts (multi-pad arbitration, calibration, rumble), haptics.ts,
                    mobileControls.ts
                    (tilt steering, touch fallback, fullscreen, multi-touch actions),
                    abilityTelemetry.ts (shared drift/flight HUD state), capture.ts
                    (WebGL plus authored-card PNG capture),
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
                    (tapered engine curve, speed-tightened steering, drift→boost→two-charge
                    flight storage, controlled anti-gravity lift, 5-point Gerstner buoyancy,
                    crest-launch airtime), opponent drift trails, aero vortex rings
    jetTrail.ts     Shared instanced ring buffer for lime boost and cyan flight shards
    rider.ts        Code-rigged cel rider, fully procedural skeleton + capsule flesh.
                    Animated from BoatState: lean ∝ lateral G, weight shift ∝ long G,
                    drift hip twist, throttle wrist, landing crouch spring, airborne
                    "whee" pose, idle breathing, celebration pump
    course.ts       CatmullRom circuit plus seven 3D flight branches, a single player-owned
                    active guide, locally masked water line, gates/buoys with foam collars,
                    cold-load-safe START/finish gantry and armed golden final station
    ai.ts           Spline-following AI with lookahead, six-racer pace profiles,
                    readable drift, elite consistency, and bounded traffic avoidance
    collision.ts    Swept capsule CCD, bounded arcade impulses, pileup separation,
                    feedback cooldown, and race/gate correction isolation
    rivalDirector.ts Two-rival pace director with hysteresis, battle lock, and impact grace
    racers.ts       Six adult profiles, two women, handling styles, grid ranks, lanes, pace
    records.ts      v6 local records, coach mastery, per-driver PBs, final/gallery state,
                    JSON export/import, and v2-v5 migration
    drivingCoach.ts Pure contextual curriculum and successful-action mastery observer
    race.ts         Explicit READY, fresh/resume countdowns, seven-flight final station,
                    medal freeze, hard flight failure, laps, and battle events
    eventLog.ts     Capped local-only gameplay event log; no network analytics transport
    chaseCamera.ts  Spring-damped chase cam, drift/flight/battle impulses, speed FOV,
                    reduced-motion support, cinematic orbit for countdown/results
  hud/
    hud.ts/.css     Responsive minimal goal HUD: flights, position, contextual coach,
                    focused failure review, READY gate, and medal UI
    driverSelect.ts/.css Character contract, centered desktop portrait/radar decision group,
                    mobile standing portrait with a separate ability column, real handling
                    modifiers (up to +/-6%), named roster paddles, and a desktop carousel
    raceTower.ts/.css Compact six-driver tower and transient team radio
    medalCeremony.ts Asset-backed champion medal plus one DPR-capped Canvas2D particle layer
    expansionGallery.ts Full-screen Chinese-name dossier viewer for planned games
    finaleOverlay.ts Frozen seven-flight result actions and dossier entry point
  audio/
    audio.ts        Streamed local rock plus four-bus Web Audio engine, water/air,
                    air-brake pressure, impacts, ducking, horn, and medal sting
    mixerControls.ts/.css Persistent master/music/effects/ambience controls
harness/
    screenshot.mjs  Playwright screenshot harness — deterministic (?harness=1) scenarios
                    (two-charge storage, seven-route timing, qualification, adaptive loading,
                    keyboard/dual-gamepad/custom-map/mobile controls, haptics, cold START,
                    radar restore, fullscreen request,
                    route guidance, performance, and battle events)
    collision.mjs   15-pair CCD, pileup, cooldown, rule isolation, route-4 boundary tests
    audio.mjs       Media playback, mixer, progressive score, ducking, background lifecycle
    systems.mjs     Save migration/import, portraits, rivals, and two-lap/14-flight endurance
```

## Performance notes

- Fixed 60 Hz simulation, render decoupled. Auto starts inside a 2.1M drawing-pixel budget.
  High-DPR phones may use up to 2.5x resolution while remaining inside that same budget;
  desktop Auto retains its conservative 1.25x ceiling. On desktop, sustained frame headroom
  can restore clarity up to 3.2M pixels;
  any pressure or fullscreen resize immediately returns toward the conservative budget.
  It reacts to fullscreen/resize within one animation frame, drops quality after 0.5s over
  20ms, and only climbs after 4s of stable sub-18.2ms frames.
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
npm run verify:flight                     # gameplay plus keyboard/gamepad input contracts
npm run verify:mobile                     # fullscreen, radar restore, fallback, controls, multi-touch
npm run verify:performance                # pixel budget, resize coalescing, draw-call ceiling
npm run verify:collision                  # CCD, impact integration, gate/checkpoint isolation
npm run verify:audio                      # formal track, mixer, ducking, hidden/resume lifecycle
npm run verify:systems                    # records, portraits, rivals, 14-flight endurance
npm run verify:release                    # all release gates in sequence
node harness/screenshot.mjs --responsive flight-cruise # desktop + compact landscape
node harness/screenshot.mjs --mobile start              # landscape tilt-control capture
node harness/screenshot.mjs --mobile --touch-fallback start
```

`?harness=1` runs the game deterministically (seeded, fixed-step) and exposes `window.__harness` for scenario driving and free-camera placement.
