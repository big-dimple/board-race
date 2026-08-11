/** Renderer, camera, resize coalescing, and drawing-pixel budget. */
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

export function resolveQualityMode(value: string | null): RenderQualityMode {
  return value === 'high' || value === 'performance' ? value : 'auto';
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
  private readonly resizeCbs: Array<(w: number, h: number, pr: number) => void> = [];

  constructor(container: HTMLElement, mode: RenderQualityMode = 'auto') {
    this.quality = PROFILES[mode];
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = true;
    this.renderer.info.autoReset = false;
    this.renderer.setPixelRatio(1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 6000);
    this.camera.position.set(0, 8, 20);

    this.pixelRatio = this.budgetRatio(window.innerWidth, window.innerHeight);
    const schedule = (): void => this.scheduleResize();
    window.addEventListener('resize', schedule, { passive: true });
    document.addEventListener('fullscreenchange', schedule);
    this.applySize();
  }

  onResize(cb: (w: number, h: number, pr: number) => void): void {
    this.resizeCbs.push(cb);
    cb(window.innerWidth, window.innerHeight, this.pixelRatio);
  }

  updatePerf(frameMs: number): void {
    if (document.hidden || frameMs <= 0 || frameMs >= 250) return;
    this.frameEma += (frameMs - this.frameEma) * 0.06;
    const dt = Math.min(0.1, frameMs / 1000);
    this.adjustmentCooldown = Math.max(0, this.adjustmentCooldown - dt);

    if (this.frameEma > 20) {
      this.badFrameSeconds += dt;
      this.goodFrameSeconds = 0;
    } else if (this.frameEma < 15.5) {
      this.goodFrameSeconds += dt;
      this.badFrameSeconds = 0;
    } else {
      this.badFrameSeconds = 0;
      this.goodFrameSeconds = 0;
    }

    if (this.adjustmentCooldown > 0) return;
    if (this.badFrameSeconds >= 0.5 && this.pixelRatio > this.quality.minPixelRatio) {
      this.pixelRatio = Math.max(this.quality.minPixelRatio, this.pixelRatio - 0.2);
      this.badFrameSeconds = 0;
      this.adjustmentCooldown = 2;
      this.applySize();
    } else if (this.goodFrameSeconds >= 5) {
      const ceiling = this.budgetRatio(window.innerWidth, window.innerHeight);
      if (this.pixelRatio < ceiling) {
        this.pixelRatio = Math.min(ceiling, this.pixelRatio + 0.1);
        this.applySize();
      }
      this.goodFrameSeconds = 0;
      this.adjustmentCooldown = 2;
    }
  }

  private budgetRatio(w: number, h: number): number {
    const device = Math.max(1, window.devicePixelRatio || 1);
    const budget = Math.sqrt(this.quality.pixelBudget / Math.max(1, w * h));
    return Math.max(this.quality.minPixelRatio, Math.min(device, this.quality.maxPixelRatio, budget));
  }

  private scheduleResize(): void {
    if (this.resizeRaf) return;
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0;
      this.pixelRatio = Math.min(this.pixelRatio, this.budgetRatio(window.innerWidth, window.innerHeight));
      this.applySize();
    });
  }

  private applySize(count = true): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(Math.floor(w * this.pixelRatio), Math.floor(h * this.pixelRatio), false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    if (count) this.resizeCount++;
    for (const cb of this.resizeCbs) cb(w, h, this.pixelRatio);
  }

  stats(): Record<string, number | string> {
    const w = window.innerWidth;
    const h = window.innerHeight;
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      frameMs: this.frameEma,
      pixelRatio: this.pixelRatio,
      drawingPixels: Math.floor(w * this.pixelRatio) * Math.floor(h * this.pixelRatio),
      quality: this.quality.mode,
      resizeCount: this.resizeCount,
    };
  }
}
