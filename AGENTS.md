# Board Race Working Notes

Board Race is a landscape-only Three.js arcade boat racer. The boat advances
automatically; players steer, drift/air-brake, and trigger flight.

## Commands

- `npm run dev` starts Vite.
- `npm run build` type-checks and builds production assets.
- `npm run verify:release` runs gameplay, mobile, collision, audio, systems,
  endurance, and performance contracts.
- After staging only reviewed files, `npm run release:checked -- "type: message"`
  runs deterministic knowledge/workspace closeout, all release gates, commit,
  push, remote-SHA verification, and Pages verification as one operation.
  When the user explicitly says not to wait for Pages, add `--no-wait-pages`;
  all gates, commit, push, and remote-SHA verification still run.

## Stack And Layout

- TypeScript, Vite, Three.js, Web Audio, and Playwright.
- Gameplay lives in `src/game/`; keyboard, gamepad, and mobile input adapters
  live in `src/core/`; HUD in `src/hud/`; sound in `src/audio/`; deterministic
  checks in `harness/`.
- `README.md` is the user-facing source of truth for controls and behavior.
- `docs/llmwiki.md` is the AI-facing source of truth for runtime ownership,
  onboarding state, hidden mechanics, verification, and closeout discipline.

## Constraints

- Support landscape phone and desktop play. Portrait must remain a blocking
  rotate prompt, not a separately designed gameplay layout.
- Mobile steering modes may change only the left-thumb zone; keep drift/
  air-brake and flight fixed in the same right-thumb positions.
- Mobile browser zoom prevention must stay scoped to active landscape play and
  preserve independent PointerEvent ownership. Do not add viewport scaling
  locks, global touchmove cancellation, zoom-reset hacks, or fake fullscreen.
- Preserve the unified `BoatInput` contract and fixed-step simulation.
- Treat action edges and physical holds as separate keyboard contracts. Focus,
  fullscreen, or system UI may erase the first keydown; repeat events must
  restore held steering/drift without recreating edge actions such as flight.
- Keep flight guidance player-owned: at most one active branch may be visible.
- End-to-end flight-route tests must run gate crossing through descent, landing,
  and route handoff without teleporting or resetting the boat; gate-only helpers
  are not recovery coverage.
- Gamepad changes must cover first-edge activation, multiple connected pads,
  unknown mappings, disconnect cleanup, and bounded actuator feedback.
- Changes to physics, lifecycle, audio, records, or rendering need the matching
  harness contract. Do not weaken thresholds to make a release pass.
- GitHub Pages deploys `main` through `.github/workflows/deploy.yml`.
- 本项目发布默认使用 `npm run release:checked -- --no-wait-pages "type: message"`；Pages 的 Actions / live 核验独立进行，不得阻塞提交和推送。
- Do not leave manual Vite servers running. Port `5173` is strict; use an
  explicit alternate port only for a deliberate concurrent session, and stop
  the exact recorded process before handoff.
- GitHub mutation or release work must use the available GitHub operations
  skill. The checked release script includes the repository's deterministic
  jiepi-clear closeout gate; run extra interactive closeout only when new facts,
  conflicts, or cleanup candidates are discovered.

## Current State

- Seven-flight Final Station and the frozen dossier viewer are implemented.
- First-run onboarding remains non-modal. Every fresh desktop keyboard run before
  the first passed flight gets one dismissible lower-left `Shift -> yellow BANK ->
  release -> Space` console driven only by accepted boat-state and launch-cue
  edges; banking alone does not retire it. An explicit close or the first pass
  does. Later launch/extension windows use one tokenized upper-right prompt per
  actionable cue, never per inventory increase. Mobile never renders the PC
  console. Only the first real failure may
  invite the persistent spotlight guide. Schema v8 still owns that full
  guide's eligibility, progress, and disable state.
- Countdown lights decrease `3 -> 2 -> 1 -> GO dark`; the numbers use restrained
  ticks only. `GO` uses exactly one deterministic non-verbal synthesized start
  signal; voice assets, speech fetches, and announcement buses are removed. If
  the context is not running, one exact-time electronic fallback plays and no
  late signal is inserted.
- Continuous water/air white-noise loops are disabled pending owner approval of
  an environment recording. Landing splash is a player-only, rate-limited
  event. Collision and landing haptics queue behind drift/air-brake control
  pulses and route only to the most recently active device. Player collision
  presentation coalesces per fixed step and uses the real contact side/point;
  directional camera impact is bounded and offers `standard / weak / off`.
- Opening contact pressure is seeded and occasional. The two strongest rivals use
  real pace and drift-release BOOST input to keep both boats ahead through the
  fourth-flight approach; `releaseFormation()` removes all player-gap assistance
  on the exact fourth-pass frame. Fixed chain-drift personality may remain afterward,
  but its surface auto-throttle may only lift for traffic or recovery and never become
  reverse braking. Teleport, fake progress, collision immunity, and player slowdown are
  forbidden. Drift holds keep a clean stern; the real BOOST rising edge alone adds one
  short, rear-upward 12-lobe blue-white plasma pulse. Do not restore smoke, comic lines,
  continuous exhaust, or a translucent heat cone; ordinary rival wake stays subordinate. These visuals must derive from Boat state,
  never a cosmetic loop detached from input, charge, or BOOST payout.
  All continuously moving surface boats and their AI must project inside a bounded
  neighbourhood of the previously accepted spline `u`; a folded course may not swap
  them to the globally nearest non-adjacent segment. Collision and rendering continue
  to use the same world transform, and a physical post-fourth pass/repass must contribute
  real rival pixels in the player's chase camera.
  Race radio is one prioritized slot and yields to action guidance. Routine passes
  and light contact stay silent; heavy personality reactions are capped per run.
  SOL's unmastered air-brake technique is a once-per-run desktop broadcast and a
  mobile race-slot message, with its reading clock paused by higher-priority play.
- iPhone browser play remains capability-detected rather than fake-fullscreen.
  Active game controls suppress Safari page-pinch defaults without releasing
  held pointers; selector and dossier surfaces do not. A relative standalone
  manifest supports optional Home Screen launch without a Service Worker;
  automatic Chrome install promotion stays suppressed, and rejected supported
  fullscreen requests remain eligible for the next real control gesture. In
  standalone mode the root owns the full `100vh` viewport, the renderer follows
  the measured `#app` container, and only controls consume safe-area insets; do
  not size the scene from `visualViewport.height` or a cached `innerHeight`.
- A passed flight keeps its authored branch through descent and landing until
  recovery handoff. Water contact is not a visual ownership edge: the same
  cyan virtual recovery tail remains visible before and after contact. It keeps
  authored aerial height while airborne, then settles onto the swell without
  turning into the green surface route. An accepted next takeoff from retained
  inventory is the only pre-handoff override: it atomically retires the old
  presentation owner and launch marker, then gives the sole cyan branch to the
  new flight. Neither path may snap the boat, clear horizontal momentum,
  preload a surface warning, or show more than one flight branch.
- Normal water contact atomically hands a held contextual air-brake to surface
  drift on that exact fixed step, starts only one step of charge, and clears
  the air-brake envelope. Final Station is the sole exception: Shift remains
  its non-charging return brake. PC coverage includes a fourth-flight descent
  where focus clears the first keydown and a repeated physical Shift must still
  recover, land, and continuously reach the BANK threshold.
- The full-lap green surface guide is a tessellated translucent wake: it bends
  with the local swell, has no hard rails or filled road core, and carries only
  a bounded 170m lookahead of open chevrons spaced 10m apart and moving forward
  at 10m/s. Sharp bends enlarge and warm at least three consecutive markers.
  Each launch entrance traces a curved three-diamond ascent vector from the
  surface tangent toward the first airborne decision; authored turns add two
  directional posture chevrons. Flight branches retain a translucent cyan
  treatment with explicit panel, edge, and flow contrast floors through the
  scoring portal and recovery; flight five uses three entry-turn buoy signs and
  two opposite exit-correction signs as secondary landmarks.
- Ocean displacement remains shared with boat physics, while its material uses
  continuous directional normals, broad sun response, near-only ripple detail,
  derivative-filtered mid-distance glint runs, and sparse whitecaps tied to high,
  steep, rising waves. Retired cel-height slabs and graphic/hash sparkle fields
  must not return or compete with routes and rival technique cues. Boat wakes use
  a broken central aerated wash with only faint, discontinuous Kelvin shoulders;
  they may be neither two continuous rails nor a filled road.
- The seventh scored flight atomically retires route warnings and failures.
  Its recovery still completes, then the player may approach the visible gold
  Final portal from either direction; passing outside the columns is retryable.
  Shift/mobile brake then targets 18m/s with air-brake turn authority and cannot
  drift, boost, charge, spend a cell, reverse, or emit a new feedback cue.
  Once armed, every physical racer can finish through the same swept portal test;
  sub-frame crossing time locks global order, finished rivals stay visible, and the
  player result is created only after all crossings in that fixed step are sorted.
- Desktop READY uses a frozen three-column driver stage from 1366x768 upward,
  six stable roster destinations, a cancellable clip reveal, and a DPR-backed
  radar. The accepted coarse-pointer mobile portrait composition stays separate.
- Final presentation uses a world-first frozen celebration: the live finish
  station remains visible while a code-authored Canvas2D flash, gold crown,
  radial particles, camera kick, and staged result actions play. The PNG
  capture composites that transparent celebration layer instead of a dark
  result card. `神秘资料片` is the default primary action; screenshot and continue
  are compact utilities, and mobile controls stay hidden throughout finale and
  dossier. Deterministic Final screenshots cover impact, hero, and settled beats.
- Expansion images are replaceable owner-supplied WebP concept assets under
  `src/assets/expansions/`; prompts and semantic filenames are the durable contract.
- The dossier pages are concept previews; no expansion gameplay exists yet.
