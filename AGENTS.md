# Board Race Working Notes

Board Race is a landscape-only Three.js arcade boat racer. The boat advances
automatically; players steer, drift/air-brake, and trigger flight.

## Required Context

- Every task starts by reading this file, `docs/llmwiki.md`, and
  `docs/development-handoff.md` in full.
- `README.md` owns player-facing behavior. `docs/llmwiki.md` owns stable
  architecture and contracts. `docs/development-handoff.md` owns only the
  active work package and exact next step.
- A multi-session goal may keep one temporary workstream handoff under its
  evidence directory. Update stable docs only when a stable contract changes.

## Commands

- `npm run dev` starts Vite on port `5173`.
- `npm run build` type-checks and builds production assets.
- `npm run verify:smoke` checks desktop and `844x390` mobile boot, rendering,
  and the current critical HUD contracts.
- `npm run verify:collision` and `verify:audio` are targeted diagnostics for
  changes in those domains; they are not routine release gates.
- After staging reviewed files, `npm run release:checked -- "type: message"`
  runs build and smoke, commits, and performs a normal push to `main`.
  `--no-wait-pages` remains accepted but is a no-op; release never waits for Pages.

## Layout

- Gameplay and state: `src/game/`; input and platform adapters: `src/core/`.
- HUD and presentation: `src/hud/`; audio: `src/audio/`; browser tools: `harness/`.
- GitHub Pages builds `main` through `.github/workflows/deploy.yml`.

## Non-Negotiable Contracts

- Preserve the unified `BoatInput` contract and 60 Hz fixed-step simulation.
- Keep action edges separate from physical holds. Keyboard repeat may restore
  steering/drift after focus loss, but must not recreate a flight edge.
- Support desktop and landscape phone. Portrait remains a blocking rotate prompt.
- Mobile steering changes may affect only the left-thumb area; drift/air-brake
  and flight retain their right-thumb ownership.
- Keep one player-owned flight branch. Gate-to-landing recovery must not
  teleport the boat, clear momentum, or create a second route truth.
- Rendering, collision, AI, and progress share one boat world transform.
- Do not add unreviewed continuous environment noise or fake fullscreen hacks.

## Art And Performance

- Read `docs/art-direction.md` before visual work. Screenshots and human review
  decide visual quality; pixel deltas, draw calls, and shader constants do not.
- The current five-batch boats, 16-bone riders, shared materials, instances,
  and typed-array pools are performance baselines, not permanent art barriers.
  A refactor may change them when it preserves gameplay truth and supplies a
  measured before/after resource or rendering metric.
- Do not hide action information by brightening the whole scene. Reuse pools and
  avoid unbounded allocation in fixed-step paths.
- Pixel changes require desktop and `844x390` screenshots. Physics, lifecycle,
  audio, records, or input changes also require their targeted diagnostic.

## Delivery

- Before every commit or push, invoke `jiepi-clear` in lightweight pre-commit
  mode. It must inspect the actual diff, remove dead tests/code/artifacts, and
  check that `llmwiki` contains only stable contracts while `handoff` contains
  only the current work package and exact next step. Do not turn this into a
  full repository, remote, Pages, or historical screenshot audit.
- Preserve unrelated work and stage only reviewed files.
- `shots/` is disposable local screenshot evidence: never commit it, never
  write auxiliary files (e.g. evidence JSON) into it, and treat the whole
  directory as safe to delete. Machine stats (calls/triangles/frameMs) belong
  in the handoff's evidence section, not in files under `shots/`.
- Do not weaken a relevant threshold to pass a check.
- Stop the exact Vite process used for manual validation before handoff.
- Completed work is normally committed and pushed unless the user explicitly
  requests a local review first. A successful push is the release action;
  Actions/Pages status is optional follow-up, not a commit gate.
