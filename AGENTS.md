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
  guide; progress, eligibility, and disable state persist in record schema v7.
- Countdown `3/2/1` uses lights and ticks only. `GO` gets exactly one local
  announcer, alternating male/female by fresh run; resume countdowns keep the
  current run's voice and never stack both.
- Final presentation uses a world-first frozen celebration: the live finish
  station remains visible while a code-authored Canvas2D flash, gold crown,
  radial particles, camera kick, and staged result actions play. The PNG
  capture composites that transparent celebration layer instead of a dark
  result card; deterministic Final screenshots cover impact, hero, and settled
  beats.
- Expansion images are replaceable owner-supplied WebP concept assets under
  `src/assets/expansions/`; prompts and semantic filenames are the durable contract.
- The dossier pages are concept previews; no expansion gameplay exists yet.
