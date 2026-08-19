/**
 * World-space English racer nameplates.
 *
 * One atlas, one plane geometry, one shader material, and six bounded instances
 * keep identity readable without creating a screen-space label layer. Instance
 * matrices are rebuilt from each boat's riderMount world anchor, then faced to
 * the active camera. Depth testing remains enabled so hulls, riders, gates, and
 * route geometry can occlude the text naturally.
 */
import * as THREE from 'three';
import type { IBoat } from '../contracts';

export interface WorldNameplateTarget {
  readonly boat: IBoat;
  readonly name: string;
}

const MAX_NAMEPLATES = 6;
const ATLAS_WIDTH = 2048;
const ATLAS_HEIGHT = 128;
const ATLAS_CELL_WIDTH = 320;
const LABEL_FADE_START_M = 96;
const LABEL_DESPAWN_M = 160;
const LABEL_ANCHOR = new THREE.Vector3(0, 1.72, -1.18);
const LABEL_SCALE = new THREE.Vector3(1.75, 0.58, 1);
const _anchor = new THREE.Vector3();
const _screenAnchor = new THREE.Vector3();
const _instanceMatrix = new THREE.Matrix4();
const _hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

function createAtlas(names: readonly string[]): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_WIDTH;
  canvas.height = ATLAS_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('world nameplate atlas requires a 2D canvas context');

  context.clearRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);
  context.font = '700 54px Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  for (let i = 0; i < MAX_NAMEPLATES; i++) {
    const name = names[i] ?? '';
    const x = i * ATLAS_CELL_WIDTH + ATLAS_CELL_WIDTH * 0.5;
    context.lineWidth = 12;
    context.strokeStyle = 'rgba(4, 12, 28, 0.92)';
    context.strokeText(name, x, ATLAS_HEIGHT * 0.5);
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    context.strokeText(name, x, ATLAS_HEIGHT * 0.5);
    context.fillStyle = '#ffffff';
    context.fillText(name, x, ATLAS_HEIGHT * 0.5);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { canvas, texture };
}

function createMaterial(texture: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      nameplateAtlas: { value: texture },
    },
    vertexShader: `
      attribute vec4 aAtlasRect;
      attribute float aFade;
      varying vec2 vAtlasUv;
      varying float vFade;

      void main() {
        vec4 localPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          localPosition = instanceMatrix * localPosition;
        #endif
        vAtlasUv = aAtlasRect.xy + uv * aAtlasRect.zw;
        vFade = aFade;
        gl_Position = projectionMatrix * modelViewMatrix * localPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D nameplateAtlas;
      varying vec2 vAtlasUv;
      varying float vFade;

      void main() {
        vec4 texel = texture2D(nameplateAtlas, vAtlasUv);
        gl_FragColor = vec4(texel.rgb, texel.a * vFade);
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.FrontSide,
    toneMapped: false,
  });
}

export class WorldNameplates {
  readonly object: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly targets: readonly WorldNameplateTarget[];
  private readonly atlasCanvas: HTMLCanvasElement;
  private readonly atlasTexture: THREE.CanvasTexture;
  private readonly atlasMaterial: THREE.ShaderMaterial;
  private readonly fadeAttribute: THREE.InstancedBufferAttribute;
  private readonly mobile: boolean;
  private visibleCount = 0;
  private peakVisibleCount = 0;

  constructor(camera: THREE.PerspectiveCamera, targets: readonly WorldNameplateTarget[]) {
    this.camera = camera;
    this.targets = targets.slice(0, MAX_NAMEPLATES);
    this.mobile = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    const atlas = createAtlas(this.targets.map((target) => target.name));
    this.atlasCanvas = atlas.canvas;
    this.atlasTexture = atlas.texture;
    this.atlasMaterial = createMaterial(this.atlasTexture);

    const geometry = new THREE.PlaneGeometry(1, 0.25);
    const rectAttribute = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NAMEPLATES * 4), 4);
    this.fadeAttribute = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NAMEPLATES), 1);
    geometry.setAttribute('aAtlasRect', rectAttribute);
    geometry.setAttribute('aFade', this.fadeAttribute);
    for (let i = 0; i < MAX_NAMEPLATES; i++) {
      rectAttribute.setXYZW(i, (i * ATLAS_CELL_WIDTH) / ATLAS_WIDTH, 0, ATLAS_CELL_WIDTH / ATLAS_WIDTH, 1);
      this.fadeAttribute.setX(i, 0);
    }

    this.object = new THREE.InstancedMesh(geometry, this.atlasMaterial, MAX_NAMEPLATES);
    this.object.name = 'world-nameplates';
    this.object.renderOrder = 5;
    this.object.frustumCulled = false;
    this.object.count = 0;
    this.object.userData.owner = 'M5-world-nameplates';
    this.object.userData.capacity = MAX_NAMEPLATES;
    this.object.userData.atlasWidth = ATLAS_WIDTH;
    this.object.userData.atlasHeight = ATLAS_HEIGHT;
    this.object.userData.geometryReuse = 'one shared PlaneGeometry';
    this.object.userData.materialReuse = 'one shared ShaderMaterial';
    this.object.userData.depthPolicy = 'depthTest=true, depthWrite=false, camera-facing';
    this.object.userData.mobileControlPolicy = 'hide only when the world anchor projects into the bottom control band';
    this.object.userData.fadeStartM = LABEL_FADE_START_M;
    this.object.userData.despawnM = LABEL_DESPAWN_M;
    this.object.userData.visibleLabels = 0;
    this.object.userData.peakVisibleLabels = 0;
    this.object.userData.drawInstances = 0;
    this.object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.object.instanceMatrix.needsUpdate = true;
    rectAttribute.needsUpdate = true;
    this.fadeAttribute.needsUpdate = true;

    for (let i = 0; i < MAX_NAMEPLATES; i++) this.object.setMatrixAt(i, _hiddenMatrix);
  }

  /** Refresh the atlas after the READY roster changes, never during fixed-step play. */
  setNames(names: readonly string[]): void {
    const context = this.atlasCanvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);
    context.font = '700 54px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    for (let i = 0; i < MAX_NAMEPLATES; i++) {
      const x = i * ATLAS_CELL_WIDTH + ATLAS_CELL_WIDTH * 0.5;
      const name = names[i] ?? '';
      context.lineWidth = 12;
      context.strokeStyle = 'rgba(4, 12, 28, 0.92)';
      context.strokeText(name, x, ATLAS_HEIGHT * 0.5);
      context.lineWidth = 3;
      context.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      context.strokeText(name, x, ATLAS_HEIGHT * 0.5);
      context.fillStyle = '#ffffff';
      context.fillText(name, x, ATLAS_HEIGHT * 0.5);
    }
    this.atlasTexture.needsUpdate = true;
  }

  /**
   * Update only from the render phase. The anchor is world-derived from the
   * rider mount; the instance matrix is never advanced by a cosmetic timer.
   */
  update(active: boolean): void {
    if (!active) {
      this.visibleCount = 0;
      this.object.count = 0;
      this.object.visible = false;
      this.object.userData.visibleLabels = 0;
      this.object.userData.drawInstances = 0;
      return;
    }

    this.object.visible = true;
    this.visibleCount = 0;
    const cameraPosition = this.camera.position;
    const cameraQuaternion = this.camera.quaternion;
    const fadeRange = LABEL_DESPAWN_M - LABEL_FADE_START_M;
    for (let i = 0; i < MAX_NAMEPLATES; i++) {
      const target = this.targets[i];
      if (!target || !target.boat.object.visible) {
        this.fadeAttribute.setX(i, 0);
        this.object.setMatrixAt(i, _hiddenMatrix);
        continue;
      }

      target.boat.riderMount.updateWorldMatrix(true, false);
      _anchor.copy(LABEL_ANCHOR);
      target.boat.riderMount.localToWorld(_anchor);
      const distance = _anchor.distanceTo(cameraPosition);
      if (!Number.isFinite(distance) || distance >= LABEL_DESPAWN_M) {
        this.fadeAttribute.setX(i, 0);
        this.object.setMatrixAt(i, _hiddenMatrix);
        continue;
      }

      // Mobile controls own the bottom band. Suppress a label that is already
      // in that world projection; never move it to a different screen slot.
      _screenAnchor.copy(_anchor).project(this.camera);
      if (this.mobile && _screenAnchor.y < -0.24) {
        this.fadeAttribute.setX(i, 0);
        this.object.setMatrixAt(i, _hiddenMatrix);
        continue;
      }

      const fade = distance <= LABEL_FADE_START_M ? 1 :
        Math.max(0, 1 - (distance - LABEL_FADE_START_M) / fadeRange);
      _instanceMatrix.compose(_anchor, cameraQuaternion, LABEL_SCALE);
      this.object.setMatrixAt(i, _instanceMatrix);
      this.fadeAttribute.setX(i, fade);
      this.visibleCount++;
    }

    this.object.count = MAX_NAMEPLATES;
    this.object.instanceMatrix.needsUpdate = true;
    this.fadeAttribute.needsUpdate = true;
    this.peakVisibleCount = Math.max(this.peakVisibleCount, this.visibleCount);
    this.object.userData.visibleLabels = this.visibleCount;
    this.object.userData.peakVisibleLabels = this.peakVisibleCount;
    this.object.userData.drawInstances = this.object.count;
  }
}
