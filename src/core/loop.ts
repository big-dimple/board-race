/**
 * loop.ts — fixed-timestep simulation loop.
 *
 * Simulation always advances in fixed SIM_DT steps (deterministic, stable
 * buoyancy/AI), rendering happens once per rAF. An accumulator with a max
 * step count prevents the spiral of death on slow frames. The harness can
 * pause the rAF pump and step manually for deterministic screenshots.
 *
 * Presentation flag: on the rAF path only the LAST step of a frame reports
 * `present = true`, so per-frame work (riders, ocean, HUD, audio buses) runs
 * once per render instead of once per catch-up step — at 30 fps that halves
 * presentation cost. Physics and edge-triggered gameplay events stay in every
 * step. `advance()` marks every step present so harness screenshots keep
 * their deterministic per-step presentation.
 */

export const SIM_DT = 1 / 60;
const MAX_STEPS = 4;

export class Loop {
  /** Total simulated seconds since boot. Wave time = this. */
  simTime = 0;
  /** How many fixed steps the most recent rAF tick ran. */
  stepsLastFrame = 0;
  private accumulator = 0;
  private lastNow = 0;
  private rafId = 0;
  private running = false;

  constructor(
    private readonly step: (dt: number, simTime: number, present: boolean) => void,
    private readonly render: (frameMs: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastNow = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(tick);
      let frameMs = now - this.lastNow;
      this.lastNow = now;
      if (frameMs > 250) frameMs = 250; // tab was hidden — don't lurch
      this.accumulator += frameMs / 1000;
      const planned = Math.min(MAX_STEPS, Math.floor(this.accumulator / SIM_DT));
      let steps = 0;
      while (this.accumulator >= SIM_DT && steps < MAX_STEPS) {
        this.step(SIM_DT, this.simTime, steps + 1 === planned);
        this.simTime += SIM_DT;
        this.accumulator -= SIM_DT;
        steps++;
      }
      if (steps === MAX_STEPS) this.accumulator = 0;
      this.stepsLastFrame = steps;
      this.render(frameMs);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Harness: advance the sim exactly `seconds` without rendering. */
  advance(seconds: number): void {
    const steps = Math.round(seconds / SIM_DT);
    for (let i = 0; i < steps; i++) {
      this.step(SIM_DT, this.simTime, true);
      this.simTime += SIM_DT;
    }
  }
}
