# 是男人就飞三次

Cel-shaded arcade boat racing on an open ocean. The boat moves automatically; three independently earned flights grant a `男人勋章`, and seven route flights unlock the golden `FINAL STATION`. Cross it to finish, view the post-race easter egg and expansion dossier, then choose `继续游戏` to carry the same run onward. Take first place after qualifying to lock `优秀男人`. Vite + Three.js (r185) + TypeScript, ES modules. World geometry and effects are authored in code; project character portraits and the owner-supplied score are documented under `src/assets/**/LICENSES.md`.

The dossier is a frozen, full-screen, one-game-per-page viewer for seven planned
games: `沙漠：圣甲虫`, `城市：磁轨轮滑手`, `雪地：北极狐`, `沼泽：树蛙`,
`丛林：长臂猿`, `外星：浮空鳐形生命`, and `肠道：益生菌`. It supports the
arrow buttons, `←` / `→`, `A` / `D`, touch swipes, clickable Chinese page tabs,
and `Esc` / `返回结算`. Each image loads only when its page is opened, with an
explicit loading/retry state; neighboring pages are not prefetched. Mobile game
controls yield the full screen while the dossier is open. The images are concept art; the seven playable games
remain tracked in [`docs/expansion-gallery-handoff.md`](docs/expansion-gallery-handoff.md).

**Play online:** [https://big-dimple.github.io/board-race/](https://big-dimple.github.io/board-race/)

## Run

```bash
npm install
npm run dev
```

Open the printed localhost URL. You start fourth in a six-racer challenge, with three rivals ahead and two behind.

The grid is intentionally frozen at `READY`. Desktop uses a fixed portrait / identity / radar stage from 1366px upward: all six candidates remain visible, the race world is dimmed and camera-frozen, and browsing uses a short directional reveal rather than overlapping full portraits. On desktop, `Enter` or `Space` starts the full `3 · 2 · 1 · GO` countdown. Mobile keeps its separate standing-portrait layout; the first touch requests fullscreen at the earliest browser-authorized moment, and the single `GO` button remains the reliable fullscreen, permission, and calibration gate.

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
| `Esc` | Dismiss the first-run keyboard hint or skip the active driving guide; READY `?` can enable the full guide again |

Keyboard steering remains active in touch-capable Chrome sessions, including `←` / `→`. Standard-mapped controllers are also supported: left stick or D-pad steers, `A / Cross` flies and confirms, and `X / Square`, `LB`, or `RB` holds drift/air-brake. Connected pads are scanned together and the pad producing deliberate input becomes active; an idle first-listed device cannot block the controller in hand. Unknown browser mappings enter a four-step READY calibration and persist by device signature. Controller rumble and short phone vibration share an independent, default-on `体感反馈` setting and the same no-buffer countdown rule as keyboard input.

On mobile, landscape is required. Portrait mode is a full interaction blocker and freezes the simulation until the device returns to landscape. The first touch attempts fullscreen/landscape, and `GO` retries inside its own user gesture. Touch steering is the default and starts immediately; choosing `转向 · 重力` from the mode switch is the only path that requests motion permission and calibrates a stable neutral angle. Browsers do not permit fullscreen before any user gesture. Missing or denied sensors remain in touch steering automatically. Tilt and touch modes share one fixed two-thumb layout: only the left steering zone changes, while the right thumb always owns the lower-right `漂/空刹` primary skill and its upper-left `飞` secondary skill. Each large invisible target presents a compact round thumb disc, so it is easy to hit without painting four crude rectangles over the race. Independent pointer tracking supports steering and holding drift/air-brake while tapping flight.

A qualifying drift release banks one flight charge, up to two; the button rim and near-boat rail mark the release threshold, while a full drift only lengthens the resulting boost. Takeoff spends one charge, and the remaining cell can be spent once during cruise or descent for `+2.4s` of controlled airtime. The early spool/ascending frames reject a second press so a double-tap cannot waste the spare. Passing or missing the portal still starts descent immediately. Passing completes the flight but does not erase the boat's horizontal momentum: the cyan approach changes into a soft green recovery funnel with water-following arrows, overlaps the main green line, and hands route ownership back only after the landing path reaches its authored exit. Legal recovery momentum cannot preload an off-course or wrong-way warning; those two surface mistakes also use distinct messages. Before the seventh pass, surface progress remains ordered: crossing open water onto a later, spatially nearby piece of the green ribbon cannot adopt that segment or emit its checkpoints. An unused spare survives landing and the third-flight medal freeze, while a fresh run clears both cells. Steering and drift/air-brake may be held before or during the medal and remain held through its frozen presentation and resume countdown; a flight press is still edge-triggered and never buffered. The base `6.45s` envelope still covers every legal portal approach at 29m/s; the optional extension raises it to `8.85s` for early launches and air-braked turn-in. The first is a wide straight launch, the second is an air-brake chicane, and the third is a precision loop. The third pass freezes the same run for a `4.5s` medal ceremony with a back double-biceps champion medal, `猛男`, fireworks, firecrackers, petals, confetti, and a dedicated audio sting. Flights 4-7 continue around the rest of the circuit. The seventh pass atomically retires surface off-course and wrong-way failures, fades the green route to a weak reference, and makes the visible golden `FINAL STATION` the sole scored destination. After the authored descent and landing, the player may approach from any route or direction; crossing between the two gold columns finishes, while passing outside them simply leaves the gate available for another attempt. The frozen finale creates a PNG capture, reveals the seven expansion easter-egg tags, and offers `继续游戏` or the pageable dossier. Before Final is armed, missing a portal, failing to launch, landing early, or leaving the corridor still ends the run immediately. Failure review keeps those causes separate: route-level failures do not invent a gate number, while portal-side misses preserve the actual side and distance evidence.

The first run still has no modal tutorial, dimming, freeze, or altered physics: experienced players can attack the `男人勋章` immediately. A brand-new desktop keyboard run does show one quiet, dismissible lower-left action caption after GO. It starts with `按住 SHIFT 漂移`, follows the real left rail to the yellow mark, changes to `松开 SHIFT` only when release can actually bank a diamond, retracts after the accepted charge, and reveals `SPACE 起飞` only when a stored cell and cyan branch make it useful. It retires after the first accepted launch; pressing Shift alone never advances it, it never appears on mobile, and deliberate gamepad input suppresses the keyboard copy.

Only an eligible novice's first real failure offers the fuller `带标注再冲 / 不用引导`; the focused review is actionable from its first frame, returns only to READY, and never buffers a race input. If accepted, the next run dims the surrounding HUD and spotlights one actual control or near-boat instrument at a time. Desktop Shift coaching reuses the same real lower-left key anchor instead of circling a duplicate keycap inside its explanation card; mobile circles the fixed lower-right `漂` thumb control. Once held, the focus moves to the left rail and yellow line, then to the stored diamond, `SPACE`/`飞`, and the flight timer as those actions become relevant. A drift is mastered only after crossing the yellow `BANK` mark and releasing into a stored diamond, not merely by pressing Shift. Every full-guide step can be permanently skipped by its visible `跳过引导`, keyboard `Esc`, or controller `View / Back`; READY `?` can re-enable remaining lessons on demand. Players who prove three flights before a failure are treated as experts. Schema v8 includes a one-time repair for novices accidentally disarmed by the rejected v7 rollout; it still waits for their next real failure and preserves every explicit skip or expert state.

The near-boat left rail is contextual: drift charge on water, remaining surface `BOOST` after release, or air-brake strength in flight. The yellow line means “enough to bank one cell”; releasing is what stores it. The right rail is the current flight's remaining envelope, while the two diamonds are the actual inventory. Holding a drift longer after the yellow line only lengthens the resulting water boost and never changes the fixed base flight duration. A spare diamond can instead add exactly `+2.4s` during cruise or descent.

Runs, medals, excellent finishes, per-driver PB flights, final completions, expansion pages seen, screenshot counts, closest misses, rival wins, and driving-guide mastery/preferences are saved in versioned browser `localStorage` with v2-v7 migration into schema v8. Schema v8 records the one-time automatic-invitation eligibility explicitly and repairs only complete, dormant novice v7/v6 coach records; explicit skips, completed/expert states, older saves, malformed data, and imports are never re-armed automatically. A deployment on a stable HTTPS domain persists normal revisits on the same browser profile and origin. Clearing site data or private browsing still removes local records; the versioned data contract remains suitable for a future authenticated server sync. Archive controls stay out of the selection screen so the first decision remains focused.

Audio uses the complete owner-selected 127-second instrumental rock track plus Web Audio engine and short, identifiable event layers. Countdown lights visibly count down `3 lit -> 2 -> 1 -> GO dark`, with short ticks and no spoken numbers. `GO` uses one deterministic non-verbal synthesized start signal; there are no voice assets, speech downloads, or late decode paths. The former continuous water/air white-noise loops are disabled pending an explicitly reviewed environment recording; landing splash is a player-only, rate-limited event. Browser policy prevents sound before interaction, so the first keyboard or pointer gesture on READY starts the song; the same media timeline continues through GO, later runs, loading, medals, and READY, and only the natural end loops to the opening. `SOUND` exposes separate master, music, effects, environment-event, visible percentages, and mute. Critical events duck the score, a 48Hz safety high-pass and 16:1 limiter protect phone speakers, and backgrounding pauses both media and context immediately until explicit GO resumes it.

## Architecture

```
src/
  contracts.ts      Shared interfaces (IBoat, ICourse, IWake, ISpray, RaceView, LAYER_INK)
  core/             palette.ts (single source of the limited palette), stage.ts (renderer
                    + adaptive pixel ratio), loop.ts (fixed 60Hz sim), input.ts,
                    gamepadInput.ts (multi-pad arbitration, calibration, rumble), haptics.ts,
                    mobileControls.ts
                    (default touch steering, opt-in tilt, fullscreen, multi-touch actions),
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
    course.ts       CatmullRom circuit plus seven 3D flight branches, single-guide ownership,
                    post-gate recovery handoff, locally masked water line, gates/buoys with
                    foam collars, and swept bidirectional golden Final portal geometry
    ai.ts           Spline-following AI with lookahead, six-racer pace profiles,
                    readable drift, elite consistency, and bounded traffic avoidance
    collision.ts    Swept capsule CCD, bounded arcade impulses, pileup separation,
                    feedback cooldown, and race/gate correction isolation
    rivalDirector.ts Two-rival pace director with hysteresis, battle lock, and impact grace
    racers.ts       Six adult profiles, two women, handling styles, grid ranks, lanes, pace
    records.ts      v8 local records, guide eligibility/mastery, per-driver PBs,
                    final/gallery state, JSON export/import, and v2-v7 migration
    pcControlPrimer.ts One-run desktop Shift -> bank -> Space action observer
    drivingCoach.ts Pure post-failure curriculum and successful-action mastery observer
    race.ts         Explicit READY, fresh/resume countdowns, route-transition rebasing,
                    distinct course warnings, free Final approach, laps, and battle events
    eventLog.ts     Capped local-only gameplay event log; no network analytics transport
    chaseCamera.ts  Spring-damped chase cam, drift/flight/battle impulses, speed FOV,
                    reduced-motion support, cinematic orbit for countdown/results
  hud/
    hud.ts/.css     Responsive goal HUD: flights, position, PC control primer, spotlight guide,
                    focused failure review, READY gate, and medal UI
    driverSelect.ts/.css Three-column desktop stage with cancellable clip reveal and DPR radar;
                    separate mobile standing portrait, real handling modifiers (up to +/-6%),
                    named roster paddles, and six stable desktop destinations
    raceTower.ts/.css Compact six-driver tower and transient team radio
    medalCeremony.ts Asset-backed champion medal plus one DPR-capped Canvas2D particle layer
    expansionGallery.ts Full-screen Chinese-name dossier viewer for planned games
    finaleOverlay.ts Frozen seven-flight result actions and dossier entry point
  audio/
    audio.ts        Streamed local rock plus four-bus Web Audio engine, reviewed impacts,
                    player splash, ducking, non-verbal GO signal, and medal sting
    mixerControls.ts/.css Persistent master/music/effects/ambience controls
harness/
    screenshot.mjs  Playwright screenshot harness — deterministic (?harness=1) scenarios
                    (two-charge storage, seven-route timing, qualification, adaptive loading,
                    keyboard/dual-gamepad/custom-map/mobile controls, haptics, cold START,
                    radar restore, fullscreen request,
                    route guidance, continuous post-gate recovery, free Final approach,
                    desktop selection motion, performance, and battles)
    collision.mjs   15-pair CCD, pileup, cooldown, rule isolation, route-4 boundary tests
    audio.mjs       Media playback, mixer, ducking, background lifecycle, exact-time non-verbal
                    GO signal, environment-loop silence, and one-shot audit contracts
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
node harness/screenshot.mjs --mobile --responsive flight-recovery-air flight-recovery-surface
node harness/screenshot.mjs --mobile start              # landscape touch-control capture (default)
node harness/screenshot.mjs --mobile --tilt start       # explicit tilt-control capture
```

`?harness=1` runs the game deterministically (seeded, fixed-step) and exposes `window.__harness` for scenario driving and free-camera placement.
