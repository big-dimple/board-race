/**
 * postPipeline.ts — the render chain: PrePass -> beauty -> Sobel ink.
 *
 * EffectComposer over a HalfFloat, 4x MSAA target (the renderer itself runs
 * with antialias off — this target is the ONLY anti-aliasing in the game).
 * Chain: RenderPass -> edgePass (auto-rendered to screen as the last pass).
 *
 * NO bloom pass, by art direction: photographic glow is banned — the sun
 * flare is shader geometry (cel/sky.ts) and water sparkle lives in the
 * water shader.
 *
 * Sizing contract: the stage keeps renderer pixel ratio at 1 and sizes the
 * drawing buffer in device pixels itself, so the composer's pixel ratio is
 * 1 and setSize() receives DEVICE pixels (w * pr, h * pr) straight through.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { PrePass } from '../core/prePass';
import { createEdgePass } from './edgePass';

export interface PostPipeline {
  render(): void;
  setSize(w: number, h: number, pr: number): void;
}

export function createPostPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  prePass: PrePass,
): PostPipeline {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2()); // device px
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: 4,
    depthBuffer: true,
    stencilBuffer: false,
  });

  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(createEdgePass(prePass, camera)); // last pass => renders to screen

  return {
    render(): void {
      // Normals + depth of ink solids FIRST — the edge pass samples them.
      prePass.render(renderer, scene, camera);
      composer.render();
    },
    setSize(w: number, h: number, pr: number): void {
      // Composer pixel ratio is 1: pass DEVICE pixels straight through.
      // This also feeds the edge pass uResolution via Pass.setSize.
      composer.setSize(Math.max(1, Math.floor(w * pr)), Math.max(1, Math.floor(h * pr)));
    },
  };
}
