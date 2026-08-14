# Board Race Working Notes

Board Race is a landscape-only Three.js arcade boat racer. The boat advances
automatically; players steer, drift/air-brake, and trigger flight.

## Commands

- `npm run dev` starts Vite.
- `npm run build` type-checks and builds production assets.
- `npm run verify:release` runs gameplay, mobile, collision, audio, systems,
  endurance, and performance contracts.

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
  skill. Knowledge/workspace closeout must use `neat-freak`; neither is implied
  by a local implementation request.

## Current State

- Seven-flight Final Station and the frozen dossier viewer are implemented.
- First-run onboarding is intentionally absent. Only a brand-new save's first
  real failure may invite the immediately skippable, action-observed spotlight
  guide; schema v8 also repairs only dormant novices disarmed by the rejected
  v7 rollout. Progress, eligibility, and disable state persist in schema v8.
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
  recovery handoff. That transition may rebase route sampling, but it must never
  snap the boat, clear horizontal momentum, or preload a surface warning.
- The seventh scored flight atomically retires route warnings and failures.
  Its recovery still completes, then the player may approach the visible gold
  Final portal from either direction; passing outside the columns is retryable.
- Desktop READY uses a frozen three-column driver stage from 1366x768 upward,
  six stable roster destinations, a cancellable clip reveal, and a DPR-backed
  radar. The accepted coarse-pointer mobile portrait composition stays separate.
- Final presentation uses a world-first frozen celebration: the live finish
  station remains visible while a code-authored Canvas2D flash, gold crown,
  radial particles, camera kick, and staged result actions play. The PNG
  capture composites that transparent celebration layer instead of a dark
  result card; deterministic Final screenshots cover impact, hero, and settled
  beats.
- Expansion images are replaceable owner-supplied WebP concept assets under
  `src/assets/expansions/`; prompts and semantic filenames are the durable contract.
- The dossier pages are concept previews; no expansion gameplay exists yet.
