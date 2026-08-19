/**
 * Shared water spray. Droplets and landing volumes are dense, allocation-free
 * instance pools: idle effects submit no instances and update no dead slots.
 */

import * as THREE from 'three';
import type { ISpray } from '../contracts';
import type { RenderQualityMode } from '../core/stage';
import { waterHeight } from './waves';

const GRAVITY = 14;
const DRAG = 1.15;
const POOF_SPEED = -2.5;
const LANDING_VOLUME_CAPACITY = 12;
const LANDING_DROPLETS: Record<RenderQualityMode, number> = {
  performance: 18,
  auto: 28,
  high: 40,
};

export interface SprayDebugState {
  activeDroplets: number;
  activeLandingVolumes: number;
  dropletCapacity: number;
  landingVolumeCapacity: number;
  landingEvents: number;
  playerLandingEvents: number;
}

function markActive(attribute: THREE.InstancedBufferAttribute, count: number): void {
  attribute.clearUpdateRanges();
  if (count > 0) attribute.addUpdateRange(0, count * attribute.itemSize);
  attribute.needsUpdate = true;
}

const DROPLET_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aVelocity;
attribute float aSize;
attribute float aShade;
attribute float aAspect;

varying vec2 vUv;
varying float vShade;

void main() {
  vUv = uv;
  vShade = aShade;
  vec4 center = viewMatrix * modelMatrix * vec4(aPos, 1.0);
  vec2 travel = (mat3(viewMatrix * modelMatrix) * aVelocity).xy;
  vec2 along = length(travel) > 0.01 ? normalize(travel) : vec2(0.0, 1.0);
  vec2 across = vec2(-along.y, along.x);
  center.xy += across * position.x * aSize + along * position.y * aSize * aAspect;
  gl_Position = projectionMatrix * center;
}
`;

const DROPLET_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vShade;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float taper = mix(0.72, 0.38, smoothstep(0.16, 1.0, abs(p.y)));
  float d = length(vec2(p.x / taper, p.y));
  float alpha = 1.0 - smoothstep(0.76, 1.0, d);
  float core = 1.0 - smoothstep(0.18, 0.72, d);
  vec3 foam = vec3(0.91, 0.98, 1.0);
  vec3 water = vec3(0.34, 0.79, 0.94);
  vec3 col = mix(water, foam, 0.68 + core * 0.32);
  if (vShade > 1.5) col *= 0.7;
  else if (vShade > 0.5) col *= 0.86;
  gl_FragColor = vec4(col, alpha * 0.95);
  #include <colorspace_fragment>
}
`;

function buildLandingVolumeGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const parts: number[] = [];
  const edges: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number, z: number, part: number, edge: number): number => {
    const index = positions.length / 3;
    positions.push(x, y, z);
    parts.push(part);
    edges.push(edge);
    return index;
  };

  const segments = 16;
  for (let i = 0; i < segments; i++) {
    const center = (i / segments) * Math.PI * 2;
    // Adjacent shutters meet at the same angular edge. Duplicate vertices
    // preserve the fixed triangle budget while closing the crown into one
    // continuous curtain instead of a sixteen-spoke fan.
    const half = (Math.PI * 2 / segments) * 0.5;
    const a0 = center - half;
    const a1 = center + half;
    const inner = 0.22;
    const outer = 0.6 + 0.055 * Math.sin(center * 2.0 + 0.8) + 0.03 * Math.sin(center * 5.0);
    const height = 0.38 + 0.065 * Math.sin(center * 2.0 - 0.4) + 0.045 * Math.sin(center * 5.0 + 0.7);
    const nextCenter = ((i + 1) / segments) * Math.PI * 2;
    const nextOuter = 0.6 + 0.055 * Math.sin(nextCenter * 2.0 + 0.8) + 0.03 * Math.sin(nextCenter * 5.0);
    const nextHeight = 0.38 + 0.065 * Math.sin(nextCenter * 2.0 - 0.4) + 0.045 * Math.sin(nextCenter * 5.0 + 0.7);
    const v0 = push(Math.cos(a0) * inner, 0.03, Math.sin(a0) * inner, 0, 0.42);
    const v1 = push(Math.cos(a1) * inner, 0.03, Math.sin(a1) * inner, 0, 0.42);
    const v2 = push(Math.cos(a0) * outer, height, Math.sin(a0) * outer, 0, 0.58);
    const v3 = push(Math.cos(a1) * nextOuter, nextHeight, Math.sin(a1) * nextOuter, 0, 0.58);
    indices.push(v0, v2, v1, v1, v2, v3);
  }

  // One continuous curved curtain per chine. A subdivided surface with a
  // scalloped top edge bends as a single volume, avoiding the radial shard
  // silhouette produced by independent triangular spray cards.
  for (const side of [-1, 1]) {
    const lengthSegments = 8;
    const riseSegments = 5;
    const grid: number[][] = [];
    for (let along = 0; along <= lengthSegments; along++) {
      const u = along / lengthSegments;
      const zBase = 0.82 - u * 2.35;
      const endFade = Math.pow(Math.sin(u * Math.PI), 0.42);
      const crestVariation = 0.88 + 0.14 * Math.sin(u * Math.PI * 3 + (side + 1) * 0.7);
      const reach = (0.72 + Math.sin(u * Math.PI) * 0.26) * crestVariation;
      const peak = (0.3 + Math.sin(u * Math.PI) * 0.16) * crestVariation;
      const row: number[] = [];
      for (let rise = 0; rise <= riseSegments; rise++) {
        const p = rise / riseSegments;
        const lift = Math.sin(p * Math.PI * 0.56);
        const x = side * (0.43 + reach * (0.14 * p + 0.86 * p * p));
        const y = 0.035 + peak * lift;
        const z = zBase - p * (0.14 + u * 0.28);
        const acrossFade = 0.12 + 0.88 * Math.sin(p * Math.PI * 0.82);
        row.push(push(x, y, z, 1, endFade * acrossFade));
      }
      grid.push(row);
    }
    for (let along = 0; along < lengthSegments; along++) {
      for (let rise = 0; rise < riseSegments; rise++) {
        const a = grid[along][rise];
        const b = grid[along + 1][rise];
        const c = grid[along][rise + 1];
        const d = grid[along + 1][rise + 1];
        if (side < 0) indices.push(a, b, c, c, b, d);
        else indices.push(a, c, b, c, d, b);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aPart', new THREE.Float32BufferAttribute(parts, 1));
  geometry.setAttribute('aEdge', new THREE.Float32BufferAttribute(edges, 1));
  geometry.setIndex(indices);
  return geometry;
}

const LANDING_VERT = /* glsl */ `
attribute float aPart;
attribute float aEdge;
attribute vec3 aOrigin;
attribute vec2 aForward;
attribute vec2 aRight;
attribute float aStrength;
attribute float aAge;
attribute float aScale;

varying float vPart;
varying float vAlpha;
varying float vHeight;
varying vec2 vFlowCoord;
varying float vAge;

void main() {
  float age = clamp(aAge, 0.0, 1.0);
  float attack = smoothstep(0.0, 0.11, age);
  float crownDecay = 1.0 - smoothstep(0.38, 0.92, age);
  float sheetDecay = 1.0 - smoothstep(0.28, 0.78, age);
  float decay = mix(crownDecay, sheetDecay, step(0.5, aPart));
  float spread = mix(0.64, 1.48, smoothstep(0.0, 0.58, age));
  float height = attack * decay * mix(0.82, 1.32, aStrength);

  vec3 local = position;
  local.xz *= spread * mix(0.9, 1.15, aStrength);
  local.y *= height;
  if (aPart > 0.5) {
    local.x *= 0.9 + age * 0.42;
    local.z -= age * (0.42 + aStrength * 0.3);
    local.y -= max(0.0, age - 0.34) * max(0.0, age - 0.34) * 1.9;
  }
  local *= aScale;

  vec2 worldXZ = aOrigin.xz + aRight * local.x + aForward * local.z;
  vec3 world = vec3(worldXZ.x, aOrigin.y + local.y, worldXZ.y);
  vPart = aPart;
  vHeight = clamp(local.y / max(0.1, aScale * 2.2), 0.0, 1.0);
  vAlpha = aEdge * attack * decay * mix(0.7, 1.0, aStrength);
  vFlowCoord = local.xz;
  vAge = age;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(world, 1.0);
}
`;

const LANDING_FRAG = /* glsl */ `
varying float vPart;
varying float vAlpha;
varying float vHeight;
varying vec2 vFlowCoord;
varying float vAge;

void main() {
  vec3 water = vec3(0.48, 0.8, 0.93);
  vec3 foam = vec3(0.97, 0.995, 1.0);
  float sheet = step(0.5, vPart);
  float foamMix = mix(0.68 + vHeight * 0.24, 0.4 + vHeight * 0.4, sheet);
  float flow = 0.72 + 0.28 * smoothstep(-0.25, 0.65,
    sin(vFlowCoord.x * 7.1 + vFlowCoord.y * 4.8 - vAge * 11.0));
  // A crown should dissolve around its curved rim, not expose sixteen hard
  // triangular shutters. The radial falloff and slow azimuthal breakup keep
  // the single shared volume soft at close range without adding a texture.
  float radius = length(vFlowCoord);
  float crownRim = 1.0 - smoothstep(0.62, 0.94, radius);
  float curtainRim = 1.0 - smoothstep(2.15, 3.25, radius);
  float rim = mix(crownRim, curtainRim, sheet);
  float azimuth = atan(vFlowCoord.y, vFlowCoord.x);
  float breakup = 0.72 + 0.28 * sin(azimuth * 8.0 + vAge * 4.0 + sin(azimuth * 3.0) * 0.8);
  float curtain = smoothstep(0.06, 0.28, vHeight) *
    (1.0 - smoothstep(0.56, 0.94, vHeight));
  float fold = 0.58 + 0.42 * smoothstep(-0.45, 0.55,
    sin(vFlowCoord.x * 8.4 - vFlowCoord.y * 5.2 - vAge * 9.0));
  // The side curtains are a supporting volume, never the silhouette of the
  // impact. Keep them as a soft glint between droplets so the crown remains
  // the readable event instead of turning into a pair of plastic fins.
  float sheetAlpha = 0.28 * flow * curtain * fold;
  // Keep both layers soft: the crown is a rounded pressure ring, while the
  // chine sheets stretch back into the wake without becoming hard fins.
  float alpha = vAlpha * mix(0.5, sheetAlpha, sheet) * rim * breakup;
  vec3 col = mix(water, foam, clamp(foamMix + rim * 0.08, 0.0, 1.0));
  col = mix(col, foam, smoothstep(0.45, 0.95, vHeight) * 0.12);
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

export class SpraySystem implements ISpray {
  readonly object: THREE.Object3D;

  private readonly capacity: number;
  private readonly quality: RenderQualityMode;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly shade: Float32Array;
  private readonly renderSize: Float32Array;
  private readonly aspect: Float32Array;
  private readonly attrPos: THREE.InstancedBufferAttribute;
  private readonly attrVelocity: THREE.InstancedBufferAttribute;
  private readonly attrSize: THREE.InstancedBufferAttribute;
  private readonly attrShade: THREE.InstancedBufferAttribute;
  private readonly attrAspect: THREE.InstancedBufferAttribute;
  private readonly dropletGeometry: THREE.InstancedBufferGeometry;
  private readonly dropletMesh: THREE.Mesh;
  private activeCount = 0;
  private replacementCursor = 0;

  private readonly volumeOrigin = new Float32Array(LANDING_VOLUME_CAPACITY * 3);
  private readonly volumeForward = new Float32Array(LANDING_VOLUME_CAPACITY * 2);
  private readonly volumeRight = new Float32Array(LANDING_VOLUME_CAPACITY * 2);
  private readonly volumeStrength = new Float32Array(LANDING_VOLUME_CAPACITY);
  private readonly volumeAge = new Float32Array(LANDING_VOLUME_CAPACITY);
  private readonly volumeDuration = new Float32Array(LANDING_VOLUME_CAPACITY);
  private readonly volumeScale = new Float32Array(LANDING_VOLUME_CAPACITY);
  private readonly attrVolumeOrigin: THREE.InstancedBufferAttribute;
  private readonly attrVolumeForward: THREE.InstancedBufferAttribute;
  private readonly attrVolumeRight: THREE.InstancedBufferAttribute;
  private readonly attrVolumeStrength: THREE.InstancedBufferAttribute;
  private readonly attrVolumeAge: THREE.InstancedBufferAttribute;
  private readonly attrVolumeScale: THREE.InstancedBufferAttribute;
  private readonly volumeGeometry: THREE.InstancedBufferGeometry;
  private readonly volumeMesh: THREE.Mesh;
  private activeVolumes = 0;
  private volumeReplacementCursor = 0;
  private volumeStaticDirty = false;
  private landingEvents = 0;
  private playerLandingEvents = 0;
  private rngState = 0x51f15e7d;

  constructor(quality: RenderQualityMode = 'auto', capacity = 1536) {
    this.quality = quality;
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.shade = new Float32Array(capacity);
    this.renderSize = new Float32Array(capacity);
    this.aspect = new Float32Array(capacity);

    const droplets = new THREE.InstancedBufferGeometry();
    droplets.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ], 3));
    droplets.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    droplets.setIndex([0, 1, 2, 0, 2, 3]);
    const dyn = THREE.DynamicDrawUsage;
    this.attrPos = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(dyn);
    this.attrVelocity = new THREE.InstancedBufferAttribute(this.vel, 3).setUsage(dyn);
    this.attrSize = new THREE.InstancedBufferAttribute(this.renderSize, 1).setUsage(dyn);
    this.attrShade = new THREE.InstancedBufferAttribute(this.shade, 1).setUsage(dyn);
    this.attrAspect = new THREE.InstancedBufferAttribute(this.aspect, 1).setUsage(dyn);
    droplets.setAttribute('aPos', this.attrPos);
    droplets.setAttribute('aVelocity', this.attrVelocity);
    droplets.setAttribute('aSize', this.attrSize);
    droplets.setAttribute('aShade', this.attrShade);
    droplets.setAttribute('aAspect', this.attrAspect);
    droplets.instanceCount = 0;
    this.dropletGeometry = droplets;

    this.dropletMesh = new THREE.Mesh(droplets, new THREE.ShaderMaterial({
      vertexShader: DROPLET_VERT,
      fragmentShader: DROPLET_FRAG,
      side: THREE.FrontSide,
      transparent: true,
      depthWrite: false,
    }));
    this.dropletMesh.name = 'spray-droplets';
    this.dropletMesh.frustumCulled = false;
    this.dropletMesh.visible = false;
    this.dropletMesh.renderOrder = 7;

    const volumeBase = buildLandingVolumeGeometry();
    const volumes = new THREE.InstancedBufferGeometry();
    volumes.index = volumeBase.index;
    for (const [name, attribute] of Object.entries(volumeBase.attributes)) volumes.setAttribute(name, attribute);
    this.attrVolumeOrigin = new THREE.InstancedBufferAttribute(this.volumeOrigin, 3).setUsage(dyn);
    this.attrVolumeForward = new THREE.InstancedBufferAttribute(this.volumeForward, 2).setUsage(dyn);
    this.attrVolumeRight = new THREE.InstancedBufferAttribute(this.volumeRight, 2).setUsage(dyn);
    this.attrVolumeStrength = new THREE.InstancedBufferAttribute(this.volumeStrength, 1).setUsage(dyn);
    this.attrVolumeAge = new THREE.InstancedBufferAttribute(this.volumeAge, 1).setUsage(dyn);
    this.attrVolumeScale = new THREE.InstancedBufferAttribute(this.volumeScale, 1).setUsage(dyn);
    volumes.setAttribute('aOrigin', this.attrVolumeOrigin);
    volumes.setAttribute('aForward', this.attrVolumeForward);
    volumes.setAttribute('aRight', this.attrVolumeRight);
    volumes.setAttribute('aStrength', this.attrVolumeStrength);
    volumes.setAttribute('aAge', this.attrVolumeAge);
    volumes.setAttribute('aScale', this.attrVolumeScale);
    volumes.instanceCount = 0;
    this.volumeGeometry = volumes;

    this.volumeMesh = new THREE.Mesh(volumes, new THREE.ShaderMaterial({
      vertexShader: LANDING_VERT,
      fragmentShader: LANDING_FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    }));
    this.volumeMesh.name = 'landing-splash-volume';
    this.volumeMesh.frustumCulled = false;
    this.volumeMesh.visible = false;
    this.volumeMesh.renderOrder = 6;

    const root = new THREE.Group();
    root.add(this.volumeMesh, this.dropletMesh);
    this.object = root;
  }

  burst(pos: THREE.Vector3, count: number, speed: number): void {
    const n = Math.min(count, this.capacity);
    for (let i = 0; i < n; i++) {
      const az = this.random() * Math.PI * 2;
      const r = this.random() * 0.6;
      const dx = Math.cos(az) * r;
      const dy = 0.7 + this.random() * 0.5;
      const dz = Math.sin(az) * r;
      const il = 1 / Math.hypot(dx, dy, dz);
      const s = speed * (0.5 + this.random() * 0.6) * il;
      this.spawn(
        pos.x + (this.random() - 0.5) * 0.3,
        pos.y + 0.05,
        pos.z + (this.random() - 0.5) * 0.3,
        dx * s, dy * s, dz * s,
        0.7 + this.random() * 0.4,
        Math.min(0.38, (0.07 + 0.015 * speed) * (0.72 + this.random() * 0.42) * 1.12),
        this.random() < 0.25 ? 1 : 0,
        1.35 + this.random() * 0.65,
      );
    }
  }

  takeoff(pos: THREE.Vector3, forward: THREE.Vector3, right: THREE.Vector3, count: number, speed: number): void {
    const n = Math.min(count, this.capacity);
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const lateral = side * (0.65 + this.random() * 0.65);
      const aft = 0.65 + this.random() * 0.7;
      const up = 0.38 + this.random() * 0.38;
      const s = speed * (0.72 + this.random() * 0.42);
      this.spawn(
        pos.x + right.x * side * (0.35 + this.random() * 0.65) - forward.x * this.random() * 1.5,
        pos.y + 0.03 + this.random() * 0.12,
        pos.z + right.z * side * (0.35 + this.random() * 0.65) - forward.z * this.random() * 1.5,
        (right.x * lateral - forward.x * aft) * s,
        up * s,
        (right.z * lateral - forward.z * aft) * s,
        0.62 + this.random() * 0.32,
        Math.min(0.47, (0.12 + speed * 0.017 + this.random() * 0.09) * 1.12),
        this.random() < 0.3 ? 1 : 0,
        1.25 + this.random() * 0.55,
      );
    }
  }

  landing(
    pos: THREE.Vector3,
    forward: THREE.Vector3,
    right: THREE.Vector3,
    impact: number,
    forwardSpeed: number,
    visualScale = 1,
    sourceId = -1,
  ): void {
    if (impact <= 0.5 || visualScale <= 0) return;
    const strength = THREE.MathUtils.clamp((impact - 3.5) / 10.5, 0.18, 1);
    const scale = THREE.MathUtils.clamp(visualScale, 0.3, 1) * (0.9 + strength * 0.34) * 1.2;
    this.spawnLandingVolume(pos, forward, right, strength, scale);
    this.landingEvents++;
    if (sourceId === 0) this.playerLandingEvents++;

    const count = Math.max(8, Math.round(LANDING_DROPLETS[this.quality] * visualScale));
    const eject = (4.8 + strength * 4.6) * 1.1;
    for (let i = 0; i < count; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const lateral = side * (0.5 + this.random() * 0.82);
      const aft = 0.5 + this.random() * 0.72;
      const up = 0.62 + this.random() * 0.62;
      const inherit = Math.min(4.2, Math.max(0, forwardSpeed) * 0.08);
      const originSide = side * (0.42 + this.random() * 0.58);
      const originAft = (this.random() - 0.35) * 1.5;
      this.spawn(
        pos.x + right.x * originSide - forward.x * originAft,
        pos.y + 0.12 + this.random() * 0.16,
        pos.z + right.z * originSide - forward.z * originAft,
        right.x * lateral * eject + forward.x * (inherit - aft * eject),
        up * eject,
        right.z * lateral * eject + forward.z * (inherit - aft * eject),
        0.62 + this.random() * 0.28,
        (0.095 + strength * 0.055) * (0.76 + this.random() * 0.44) * scale * 1.55,
        this.random() < 0.28 ? 1 : 0,
        1.1 + strength * 0.28 + this.random() * 0.45,
      );
    }
  }

  update(dt: number, t: number): void {
    this.updateDroplets(dt, t);
    this.updateLandingVolumes(dt);
  }

  clear(): void {
    this.activeCount = 0;
    this.activeVolumes = 0;
    this.replacementCursor = 0;
    this.volumeReplacementCursor = 0;
    this.volumeStaticDirty = false;
    this.landingEvents = 0;
    this.playerLandingEvents = 0;
    this.rngState = 0x51f15e7d;
    this.dropletGeometry.instanceCount = 0;
    this.volumeGeometry.instanceCount = 0;
    this.dropletMesh.visible = false;
    this.volumeMesh.visible = false;
  }

  debugState(): SprayDebugState {
    return {
      activeDroplets: this.activeCount,
      activeLandingVolumes: this.activeVolumes,
      dropletCapacity: this.capacity,
      landingVolumeCapacity: LANDING_VOLUME_CAPACITY,
      landingEvents: this.landingEvents,
      playerLandingEvents: this.playerLandingEvents,
    };
  }

  private updateDroplets(dt: number, t: number): void {
    const drag = Math.max(0, 1 - DRAG * dt);
    let i = 0;
    while (i < this.activeCount) {
      const i3 = i * 3;
      this.vel[i3 + 1] -= GRAVITY * dt;
      this.vel[i3] *= drag;
      this.vel[i3 + 1] *= drag;
      this.vel[i3 + 2] *= drag;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.life[i] -= dt;

      const surface = waterHeight(this.pos[i3], this.pos[i3 + 2], t);
      if (this.pos[i3 + 1] < surface && this.vel[i3 + 1] < POOF_SPEED && this.shade[i] < 2) {
        this.pos[i3 + 1] = surface + 0.05;
        this.vel[i3] = (this.random() - 0.5) * 0.8;
        this.vel[i3 + 1] = 0.9 + this.random() * 0.4;
        this.vel[i3 + 2] = (this.random() - 0.5) * 0.8;
        this.life[i] = 0.32;
        this.maxLife[i] = 0.32;
        this.size0[i] *= 0.65;
        this.aspect[i] = 1;
        this.shade[i] = 2;
      } else if (this.life[i] <= 0 || this.pos[i3 + 1] < surface) {
        this.removeDroplet(i);
        continue;
      }

      const age = 1 - this.life[i] / this.maxLife[i];
      const fade = age < 0.68 ? 1 : Math.max(0, 1 - (age - 0.68) / 0.32);
      this.renderSize[i] = this.size0[i] * fade;
      i++;
    }

    this.dropletGeometry.instanceCount = this.activeCount;
    this.dropletMesh.visible = this.activeCount > 0;
    if (this.activeCount > 0) {
      markActive(this.attrPos, this.activeCount);
      markActive(this.attrVelocity, this.activeCount);
      markActive(this.attrSize, this.activeCount);
      markActive(this.attrShade, this.activeCount);
      markActive(this.attrAspect, this.activeCount);
    }
  }

  private updateLandingVolumes(dt: number): void {
    let i = 0;
    while (i < this.activeVolumes) {
      this.volumeAge[i] += dt / this.volumeDuration[i];
      if (this.volumeAge[i] >= 1) {
        this.removeLandingVolume(i);
        continue;
      }
      i++;
    }
    this.volumeGeometry.instanceCount = this.activeVolumes;
    this.volumeMesh.visible = this.activeVolumes > 0;
    if (this.activeVolumes > 0) {
      if (this.volumeStaticDirty) {
        markActive(this.attrVolumeOrigin, this.activeVolumes);
        markActive(this.attrVolumeForward, this.activeVolumes);
        markActive(this.attrVolumeRight, this.activeVolumes);
        markActive(this.attrVolumeStrength, this.activeVolumes);
        markActive(this.attrVolumeScale, this.activeVolumes);
        this.volumeStaticDirty = false;
      }
      markActive(this.attrVolumeAge, this.activeVolumes);
    }
  }

  private spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, shade: number, aspect: number,
  ): void {
    const i = this.activeCount < this.capacity
      ? this.activeCount++
      : this.replacementCursor++ % this.capacity;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.renderSize[i] = size;
    this.shade[i] = shade;
    this.aspect[i] = aspect;
  }

  private spawnLandingVolume(
    pos: THREE.Vector3,
    forward: THREE.Vector3,
    right: THREE.Vector3,
    strength: number,
    scale: number,
  ): void {
    const i = this.activeVolumes < LANDING_VOLUME_CAPACITY
      ? this.activeVolumes++
      : this.volumeReplacementCursor++ % LANDING_VOLUME_CAPACITY;
    const i3 = i * 3;
    const i2 = i * 2;
    this.volumeOrigin[i3] = pos.x;
    this.volumeOrigin[i3 + 1] = pos.y;
    this.volumeOrigin[i3 + 2] = pos.z;
    this.volumeForward[i2] = forward.x;
    this.volumeForward[i2 + 1] = forward.z;
    this.volumeRight[i2] = right.x;
    this.volumeRight[i2 + 1] = right.z;
    this.volumeStrength[i] = strength;
    this.volumeAge[i] = 0;
    this.volumeDuration[i] = 0.68 + strength * 0.17;
    this.volumeScale[i] = scale;
    this.volumeStaticDirty = true;
  }

  private removeDroplet(index: number): void {
    const last = --this.activeCount;
    if (index === last) return;
    const to3 = index * 3;
    const from3 = last * 3;
    for (let axis = 0; axis < 3; axis++) {
      this.pos[to3 + axis] = this.pos[from3 + axis];
      this.vel[to3 + axis] = this.vel[from3 + axis];
    }
    this.life[index] = this.life[last];
    this.maxLife[index] = this.maxLife[last];
    this.size0[index] = this.size0[last];
    this.renderSize[index] = this.renderSize[last];
    this.shade[index] = this.shade[last];
    this.aspect[index] = this.aspect[last];
  }

  private removeLandingVolume(index: number): void {
    const last = --this.activeVolumes;
    if (index === last) return;
    const to3 = index * 3;
    const from3 = last * 3;
    const to2 = index * 2;
    const from2 = last * 2;
    for (let axis = 0; axis < 3; axis++) this.volumeOrigin[to3 + axis] = this.volumeOrigin[from3 + axis];
    for (let axis = 0; axis < 2; axis++) {
      this.volumeForward[to2 + axis] = this.volumeForward[from2 + axis];
      this.volumeRight[to2 + axis] = this.volumeRight[from2 + axis];
    }
    this.volumeStrength[index] = this.volumeStrength[last];
    this.volumeAge[index] = this.volumeAge[last];
    this.volumeDuration[index] = this.volumeDuration[last];
    this.volumeScale[index] = this.volumeScale[last];
    this.volumeStaticDirty = true;
  }

  private random(): number {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 4294967296;
  }
}
