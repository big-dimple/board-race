/**
 * stage.ts — renderer, scene, camera, adaptive pixel ratio.
 *
 * Performance contract: hold 60fps at retina on an M-series MacBook.
 * The adaptive pixel-ratio governor watches an EMA of real frame times and
 * steps render scale down fast / up slow. Everyone holding a sized target
 * (composer, prepass) registers via onResize().
 */
import * as THREE from 'three';

export const BASE_FOV = 62;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  /** Current render scale (1 = CSS pixels, 2 = full retina). */
  pixelRatio: number;
  private readonly maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  private readonly minPixelRatio = 1;
  private frameEma = 16.7;
  private framesSinceAdjust = 0;
  private readonly resizeCbs: Array<(w: number, h: number, pr: number) => void> = [];

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // MSAA lives on the composer target instead
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.toneMapping = THREE.NoToneMapping; // cel: authored colors go straight to screen
    this.renderer.autoClear = true;
    this.renderer.info.autoReset = false; // main resets once per frame, stats cover the full pipeline
    this.pixelRatio = this.maxPixelRatio; // start optimistic, governor settles it
    this.renderer.setPixelRatio(1); // we do our own scaling via setSize for composer-aware control
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 6000);
    this.camera.position.set(0, 8, 20);

    window.addEventListener('resize', () => this.applySize());
    this.applySize();
  }

  /** Register a sized-target owner. Called immediately with current size, then on every change. */
  onResize(cb: (w: number, h: number, pr: number) => void): void {
    this.resizeCbs.push(cb);
    const w = window.innerWidth;
    const h = window.innerHeight;
    cb(w, h, this.pixelRatio);
  }

  /** Feed the real frame time (ms) once per rendered frame. */
  updatePerf(frameMs: number): void {
    this.frameEma += (frameMs - this.frameEma) * 0.06;
    this.framesSinceAdjust++;
    if (this.framesSinceAdjust < 45) return;

    if (this.frameEma > 17.6 && this.pixelRatio > this.minPixelRatio) {
      // Missing target — drop fast.
      this.pixelRatio = Math.max(this.minPixelRatio, this.pixelRatio - 0.25);
      this.applySize();
      this.framesSinceAdjust = 0;
    } else if (this.frameEma < 14.2 && this.pixelRatio < this.maxPixelRatio) {
      // Headroom — climb slowly.
      this.pixelRatio = Math.min(this.maxPixelRatio, this.pixelRatio + 0.25);
      this.applySize();
      this.framesSinceAdjust = 0;
    }
  }

  private applySize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(Math.floor(w * this.pixelRatio), Math.floor(h * this.pixelRatio), false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    for (const cb of this.resizeCbs) cb(w, h, this.pixelRatio);
  }

  /** Frame stats for the perf HUD / harness. */
  stats(): { calls: number; triangles: number; frameMs: number; pixelRatio: number } {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      frameMs: this.frameEma,
      pixelRatio: this.pixelRatio,
    };
  }
}
