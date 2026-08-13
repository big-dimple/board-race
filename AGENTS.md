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

## Current State

- Seven-flight Final Station and the frozen dossier viewer are implemented.
- Final presentation is functional but its visual climax is still a planned
  redesign; see `docs/expansion-gallery-handoff.md`.
- Expansion images are replaceable owner-supplied WebP concept assets under
  `src/assets/expansions/`; prompts and semantic filenames are the durable contract.
- The dossier pages are concept previews; no expansion gameplay exists yet.
