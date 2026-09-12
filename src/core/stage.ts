/** Renderer, camera, resize coalescing, and drawing-pixel budget.
 *
 * Phones never render below CSS resolution (1.0x), the performance profile
 * included: its old 0.5 floor let the governor shave mid phones (iPhone 12
 * class) into a blurry slide show. Weak hardware still reaches the floor
 * within seconds through the severe-drop path; borderline ~50 fps devices
 * hold their ratio because mild pressure only counts below roughly 47 fps.
 */
import * as THREE from 'three';

export const BASE_FOV = 62;

export type RenderQualityMode = 'auto' | 'performance' | 'high';

export interface RenderQualityProfile {
  mode: RenderQualityMode;
  pixelBudget: number;
  maxPixelRatio: number;
  minPixelRatio: number;
  samples: number;
  energyScale: number;
  detailedAiInk: boolean;
}

const AUTO_DESKTOP_CLARITY_BUDGET = 3_200_000;
const AUTO_DESKTOP_MAX_PIXEL_RATIO = 1.35;
const AUTO_MOBILE_MAX_PIXEL_RATIO = 2.5;
const AUTO_MOBILE_MIN_PIXEL_RATIO = 1;
/** Performance mode starts cheap but lets strong devices earn sharpness back. */
const PERFORMANCE_GOVERNOR_MAX_PIXEL_RATIO = 2.0;
/**
 * Performance mode opens at 1.5x instead of the 1.0x floor: first impressions
 * are formed in the first seconds, and a sharp READY grid beats a soft one.
 * Weak hardware pays it back within ~2s via the severe-drop path, well before
 * the countdown hands over the wheel.
 */
const PERFORMANCE_START_MAX_PIXEL_RATIO = 1.5;
/**
 * Split play pays for the same rAF budget twice: two cameras, two pipelines,
 * one frame. The governor used to read the resulting frame time as a slow
 * machine and kept shaving resolution until the picture went soft. Split views
 * are small and full of readable detail, so they stop earlier and in smaller
 * steps than a whole-screen view would.
 */
const SPLIT_MIN_PIXEL_RATIO = 1.0;
const SPLIT_DOWNSCALE_STEP = 0.1;

const PROFILES: Record<RenderQualityMode, RenderQualityProfile> = {
  auto: {
    mode: 'auto', pixelBudget: 2_100_000, maxPixelRatio: 1.25,
    minPixelRatio: 0.5, samples: 0, energyScale: 0.35, detailedAiInk: false,
  },
  performance: {
    mode: 'performance', pixelBudget: 1_300_000, maxPixelRatio: 1,
    minPixelRatio: 0.5, samples: 0, energyScale: 0.25, detailedAiInk: false,
  },
  high: {
    mode: 'high', pixelBudget: 4_100_000, maxPixelRatio: 2,
    minPixelRatio: 0.75, samples: 2, energyScale: 0.5, detailedAiInk: true,
  },
};

export function resolveQualityMode(value: string | null, preferPerformance = false): RenderQualityMode {
  if (value === 'high' || value === 'performance' || value === 'auto') return value;
  // Stock browsers on low-end phones cannot absorb the full auto pipeline at a
  // 2.5x drawing ratio; they start in performance and may climb back via the
  // governor. An explicit ?quality= always wins.
  return preferPerformance ? 'performance' : 'auto';
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly quality: RenderQualityProfile;

  pixelRatio: number;
  private frameEma = 16.7;
  private badFrameSeconds = 0;
  private goodFrameSeconds = 0;
  private adjustmentCooldown = 0;
  private resizeRaf = 0;
  private resizeCount = 0;
  private lastBaseRatio = 1;
  /**
   * AIMD up-step: climbs fast while frames prove headroom, and halves after
   * every downshift so a borderline device converges instead of oscillating.
   */
  private upStep = 0.3;
  private readonly desktopClarity: boolean;
  /** Auto-mode mobile path (floor 1.0, higher ceiling). */
  private readonly mobileClarity: boolean;
  /** Coarse/touch hardware regardless of quality mode; drives the 1.0 floor. */
  private readonly mobileHardware: boolean;
  private readonly effectiveMinPixelRatio: number;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly resizeCbs: Array<(w: number, h: number, pr: number) => void> = [];
  private readonly governorRatioCap: number;
  private readonly startRatioCap: number;

  constructor(container: HTMLElement, mode: RenderQualityMode = 'auto') {
    this.container = container;
    const initialSize = this.viewportSize();
    this.quality = PROFILES[mode];
    this.governorRatioCap = mode === 'performance'
      ? PERFORMANCE_GOVERNOR_MAX_PIXEL_RATIO
      : this.quality.maxPixelRatio;
    this.startRatioCap = mode === 'performance'
      ? PERFORMANCE_START_MAX_PIXEL_RATIO
      : this.quality.maxPixelRatio;
    this.desktopClarity = mode === 'auto' &&
      initialSize.width >= 1000 &&
      !window.matchMedia('(pointer: coarse)').matches;
    this.mobileHardware = window.matchMedia('(pointer: coarse)').matches ||
      navigator.maxTouchPoints > 0;
    this.mobileClarity = mode === 'auto' && this.mobileHardware;
    const initialBudgetRatio = Math.sqrt(this.quality.pixelBudget /
      Math.max(1, initialSize.width * initialSize.height));
    // The phone floor holds in every quality mode: below CSS resolution the
    // picture turns to mush on a 3x screen while gaining little frame time.
    this.effectiveMinPixelRatio = (this.mobileClarity || this.mobileHardware)
      ? Math.min(AUTO_MOBILE_MIN_PIXEL_RATIO, initialBudgetRatio)
      : this.quality.minPixelRatio;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = true;
    // Keep opaque batches front-to-back so the browser/GPU can reject hidden
    // fragments before running their material shader. Transparent route and
    // effect layers keep their authored render order below.
    this.renderer.sortObjects = true;
    this.renderer.info.autoReset = false;
    this.renderer.setPixelRatio(1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 6000);
    this.camera.position.set(0, 8, 20);

    this.pixelRatio = this.desktopClarity
      ? this.clarityCeilingRatio(initialSize.width, initialSize.height)
      : this.baseBudgetRatio(initialSize.width, initialSize.height);
    this.lastBaseRatio = this.pixelRatio;
    const schedule = (): void => this.scheduleResize();
    window.addEventListener('resize', schedule, { passive: true });
    document.addEventListener('fullscreenchange', schedule);
    this.resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    this.resizeObserver?.observe(container);
    this.applySize();
  }

  onResize(cb: (w: number, h: number, pr: number) => void): void {
    this.resizeCbs.push(cb);
    const { width, height } = this.viewportSize();
    cb(width, height, this.pixelRatio);
  }

  /** `views` is how many cameras this frame rendered; split play renders two. */
  updatePerf(frameMs: number, views = 1): void {
    if (document.hidden || frameMs <= 0 || frameMs >= 250) return;
    const split = views > 1;
    const floor = split
      ? Math.max(this.effectiveMinPixelRatio, this.desktopClarity ? 1.0 : SPLIT_MIN_PIXEL_RATIO)
      : this.effectiveMinPixelRatio;
    this.frameEma += (frameMs - this.frameEma) * 0.12;
    const dt = Math.min(0.1, frameMs / 1000);
    this.adjustmentCooldown = Math.max(0, this.adjustmentCooldown - dt);

    // A racing game cannot wait seconds for the governor to notice overload:
    // severe frames step down immediately and decisively, mild pressure steps
    // after a short proof. Climbing back up stays slow and deliberate — a
    // phone bouncing between ratios feels worse than one holding a stable one.
    // Mild pressure starts below ~47 fps: a phone pacing at 50-57 fps is not
    // struggling, and shaving it anyway only trades a stable ratio for blur.
    const badThreshold = split ? 24 : 21;
    const severeThreshold = split ? 34 : 30;
    const goodThreshold = split ? 20 : 16.9;
    if (this.frameEma > badThreshold) {
      this.badFrameSeconds += dt;
      this.goodFrameSeconds = 0;
    } else if (this.frameEma < goodThreshold) {
      this.goodFrameSeconds += dt;
      this.badFrameSeconds = 0;
    } else {
      this.badFrameSeconds = 0;
      this.goodFrameSeconds = 0;
    }

    if (this.adjustmentCooldown > 0) return;
    const severe = this.frameEma > severeThreshold;
    if ((severe || this.badFrameSeconds >= 0.6) && this.pixelRatio > floor) {
      const stepDown = severe ? 0.35 : split ? SPLIT_DOWNSCALE_STEP : 0.2;
      this.pixelRatio = Math.max(floor, this.pixelRatio - stepDown);
      this.upStep = Math.max(0.1, this.upStep * 0.5);
      this.badFrameSeconds = 0;
      this.adjustmentCooldown = 1;
      this.applySize();
    } else if (this.goodFrameSeconds >= 2) {
      const { width, height } = this.viewportSize();
      const ceiling = this.clarityCeilingRatio(width, height);
      if (this.pixelRatio < ceiling) {
        this.pixelRatio = Math.min(ceiling, this.pixelRatio + this.upStep);
        this.applySize();
      }
      this.goodFrameSeconds = 0;
      this.adjustmentCooldown = 2;
    }
  }

  /** Harness-only deterministic governor input; production uses measured rAF time. */
  debugPerfFrames(frameMs: number, frames: number, views = 1): void {
    for (let i = 0; i < Math.max(0, frames); i++) this.updatePerf(frameMs, views);
  }

  private ratioForBudget(w: number, h: number, pixelBudget: number, maxPixelRatio: number): number {
    const device = Math.max(1, window.devicePixelRatio || 1);
    const budget = Math.sqrt(pixelBudget / Math.max(1, w * h));
    const floor = (this.mobileClarity || this.mobileHardware)
      ? Math.min(this.effectiveMinPixelRatio, budget)
      : this.effectiveMinPixelRatio;
    return Math.max(floor, Math.min(device, maxPixelRatio, budget));
  }

  private baseBudgetRatio(w: number, h: number): number {
    const max = this.mobileClarity ? AUTO_MOBILE_MAX_PIXEL_RATIO : this.startRatioCap;
    const ratio = this.ratioForBudget(w, h, this.quality.pixelBudget, max);
    return ratio;
  }

  private clarityCeilingRatio(w: number, h: number): number {
    if (this.desktopClarity) {
      return this.ratioForBudget(w, h, AUTO_DESKTOP_CLARITY_BUDGET, AUTO_DESKTOP_MAX_PIXEL_RATIO);
    }
    const cap = this.mobileClarity ? AUTO_MOBILE_MAX_PIXEL_RATIO : this.governorRatioCap;
    return this.ratioForBudget(w, h, this.quality.pixelBudget, cap);
  }

  private scheduleResize(): void {
    if (this.resizeRaf) return;
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0;
      // A fullscreen/resize jump first returns to the conservative budget. The
      // governor may then restore desktop clarity only after sustained headroom.
      // Preserve a real performance penalty, but do not strand a small window
      // at the ratio required by the previous 4K viewport.
      const { width, height } = this.viewportSize();
      const nextBase = this.baseBudgetRatio(width, height);
      const perfScale = Math.min(1, this.pixelRatio / Math.max(this.effectiveMinPixelRatio, this.lastBaseRatio));
      this.pixelRatio = Math.max(this.effectiveMinPixelRatio, nextBase * perfScale);
      this.lastBaseRatio = nextBase;
      this.applySize();
    });
  }

  private applySize(count = true): void {
    const { width: w, height: h } = this.viewportSize();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(Math.floor(w * this.pixelRatio), Math.floor(h * this.pixelRatio), false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    if (count) this.resizeCount++;
    for (const cb of this.resizeCbs) cb(w, h, this.pixelRatio);
  }

  private viewportSize(): { width: number; height: number } {
    const rect = this.container.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(rect.width || this.container.clientWidth || window.innerWidth)),
      height: Math.max(1, Math.round(rect.height || this.container.clientHeight || window.innerHeight)),
    };
  }

  stats(): Record<string, number | string> {
    const { width: w, height: h } = this.viewportSize();
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      sortObjects: this.renderer.sortObjects ? 1 : 0,
      frameMs: this.frameEma,
      pixelRatio: this.pixelRatio,
      drawingPixels: Math.floor(w * this.pixelRatio) * Math.floor(h * this.pixelRatio),
      quality: this.quality.mode,
      basePixelBudget: this.quality.pixelBudget,
      clarityPixelBudget: this.desktopClarity ? AUTO_DESKTOP_CLARITY_BUDGET : this.quality.pixelBudget,
      clarityCeilingRatio: this.clarityCeilingRatio(w, h),
      minPixelRatio: this.effectiveMinPixelRatio,
      splitPixelFloor: Math.max(this.effectiveMinPixelRatio, SPLIT_MIN_PIXEL_RATIO),
      desktopClarity: this.desktopClarity ? 1 : 0,
      mobileClarity: this.mobileClarity ? 1 : 0,
      resizeCount: this.resizeCount,
      viewportWidth: w,
      viewportHeight: h,
    };
  }
}
