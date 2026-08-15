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
- Preserve the unified `BoatInput` contract and fixed-step simulation.
- Keep flight guidance player-owned: at most one active branch may be visible.
- End-to-end flight-route tests must run gate crossing through descent, landing,
  and route handoff without teleporting or resetting the boat; gate-only helpers
  are not recovery coverage.
- Gamepad changes must cover first-edge activation, multiple connected pads,
  unknown mappings, disconnect cleanup, and bounded actuator feedback.
- Changes to physics, lifecycle, audio, records, or rendering need the matching
  harness contract. Do not weaken thresholds to make a release pass.
- GitHub Pages deploys `main` through `.github/workflows/deploy.yml`.
- Do not leave manual Vite servers running. Port `5173` is strict; use an
  explicit alternate port only for a deliberate concurrent session, and stop
  the exact recorded process before handoff.
- GitHub mutation or release work must use the available GitHub operations
  skill. The checked release script includes the repository's deterministic
  neat-freak closeout gate; run extra interactive closeout only when new facts,
  conflicts, or cleanup candidates are discovered.

## Current State

- Seven-flight Final Station and the frozen dossier viewer are implemented.
- First-run onboarding remains non-modal. A brand-new desktop keyboard run gets
  one dismissible lower-left `Shift -> bank -> Space` primer driven only by
  accepted boat-state edges; mobile never renders it. Only the first real
  failure may invite the persistent spotlight guide. Schema v8 still owns that
  full guide's eligibility, progress, and disable state.
- Countdown lights decrease `3 -> 2 -> 1 -> GO dark`; the numbers use restrained
  ticks only. `GO` uses exactly one deterministic non-verbal synthesized start
  signal; voice assets, speech fetches, and announcement buses are removed. If
  the context is not running, one exact-time electronic fallback plays and no
  late signal is inserted.
- Continuous water/air white-noise loops are disabled pending owner approval of
  an environment recording. Landing splash is a player-only, rate-limited
  event. Collision and landing haptics queue behind drift/air-brake control
  pulses and route only to the most recently active device.
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
  its non-charging return brake.
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
- The seventh scored flight atomically retires route warnings and failures.
  Its recovery still completes, then the player may approach the visible gold
  Final portal from either direction; passing outside the columns is retryable.
  Shift/mobile brake then targets 18m/s with air-brake turn authority and cannot
  drift, boost, charge, spend a cell, reverse, or emit a new feedback cue.
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
