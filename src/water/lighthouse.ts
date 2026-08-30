import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addOutline } from '../cel/outline';
import { createToonMaterial } from '../cel/toonMaterial';
import { markInk } from '../contracts';
import { PALETTE } from '../core/palette';
import { NIGHT_PALETTE } from '../core/nightPalette';
import type { TimeOfDay } from '../core/timeOfDay';

const WORLD_X = 110;
const WORLD_Z = 190;
const TOWER_HEIGHT = 34;
const TAU = Math.PI * 2;

type Vec3 = readonly [number, number, number];

export interface LighthouseDebugState {
  x: number;
  z: number;
  height: number;
  daylightBeam: boolean;
  solidMeshes: number;
  effectMeshes: number;
}

const activeLighthouses = new Set<LighthouseLandmark>();

export function setLighthouseTimeOfDay(tod: TimeOfDay, blend?: number): void {
  activeLighthouses.forEach((lh) => lh.setTimeOfDay(tod, blend));
}

function prepareGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function transformed(
  geometry: THREE.BufferGeometry,
  position: Vec3 = [0, 0, 0],
  rotation: Vec3 = [0, 0, 0],
): THREE.BufferGeometry {
  geometry.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
    new THREE.Vector3(1, 1, 1),
  ));
  return prepareGeometry(geometry);
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  if (!merged) throw new Error('Unable to merge lighthouse geometry');
  merged.computeBoundingSphere();
  return merged;
}

function makeRockGeometry(): THREE.BufferGeometry {
  const segments = 18;
  const variation = [1, 0.96, 1.04, 0.98, 1.03, 0.95, 1.02, 0.97, 1.05, 0.96, 1.01, 0.95, 1.03, 0.98, 1.02, 0.96, 1.04, 0.97];
  const rings: readonly (readonly [number, number, number, number])[] = [
    [-0.7, 7.6, 5.5, 0.02],
    [0.28, 7.25, 5.15, 0.08],
    [1.35, 5.6, 4.15, -0.04],
    [1.88, 3.75, 3.05, 0.03],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring < rings.length; ring++) {
    const [y, rx, rz, offset] = rings[ring];
    for (let i = 0; i < segments; i++) {
      const angle = i / segments * TAU + offset;
      const scale = variation[(i + ring * 5) % segments];
      positions.push(Math.sin(angle) * rx * scale, y, Math.cos(angle) * rz * scale);
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = ring * segments;
    const upper = (ring + 1) * segments;
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      indices.push(lower + i, upper + i, lower + next, lower + next, upper + i, upper + next);
    }
  }
  const center = positions.length / 3;
  positions.push(0, 1.9, 0);
  const top = (rings.length - 1) * segments;
  for (let i = 0; i < segments; i++) indices.push(top + i, center, top + (i + 1) % segments);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return prepareGeometry(geometry);
}

function shaftRadiusAt(y: number): number {
  return THREE.MathUtils.lerp(2.8, 1.88, THREE.MathUtils.clamp((y - 2.65) / 22.6, 0, 1));
}

function makeIvoryGeometry(): THREE.BufferGeometry {
  return mergeParts([
    transformed(new THREE.CylinderGeometry(3.05, 3.24, 0.55, 24), [0, 2.16, 0]),
    transformed(new THREE.CylinderGeometry(2.8, 3.05, 0.44, 24), [0, 2.64, 0]),
    transformed(new THREE.CylinderGeometry(1.88, 2.8, 22.6, 24), [0, 13.95, 0]),
    transformed(new THREE.CylinderGeometry(2.02, 1.88, 0.42, 24), [0, 25.45, 0]),
  ]);
}

function makeAccentBand(y: number, height: number): THREE.BufferGeometry {
  const bottom = y - height * 0.5;
  const top = y + height * 0.5;
  return transformed(new THREE.CylinderGeometry(
    shaftRadiusAt(top) + 0.045,
    shaftRadiusAt(bottom) + 0.045,
    height,
    24,
    1,
    true,
  ), [0, y, 0]);
}

function radialPanel(y: number, angle: number): THREE.BufferGeometry {
  const radius = shaftRadiusAt(y) + 0.045;
  return transformed(
    new THREE.BoxGeometry(0.48, 1.05, 0.08),
    [Math.sin(angle) * radius, y, Math.cos(angle) * radius],
    [0, angle, 0],
  );
}

function makeNavyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    transformed(new THREE.CylinderGeometry(2.7, 2.7, 0.3, 24), [0, 25.82, 0]),
    transformed(new THREE.TorusGeometry(2.4, 0.065, 6, 36), [0, 27.05, 0], [Math.PI / 2, 0, 0]),
    transformed(new THREE.TorusGeometry(1.58, 0.07, 6, 32), [0, 26.35, 0], [Math.PI / 2, 0, 0]),
    transformed(new THREE.TorusGeometry(1.58, 0.07, 6, 32), [0, 29.15, 0], [Math.PI / 2, 0, 0]),
    transformed(new THREE.CylinderGeometry(1.95, 1.68, 0.24, 24), [0, 29.32, 0]),
    transformed(new THREE.ConeGeometry(1.95, 1.15, 24), [0, 30.02, 0]),
    transformed(new THREE.CylinderGeometry(0.16, 0.16, 0.22, 10), [0, 30.72, 0]),
    transformed(new THREE.CylinderGeometry(0.055, 0.055, 2.45, 8), [0, 32.05, 0]),
    transformed(new THREE.ConeGeometry(0.12, 0.35, 8), [0, 33.45, 0]),
    radialPanel(8.2, -2.56),
    radialPanel(19.4, -0.42),
  ];
  for (let i = 0; i < 12; i++) {
    const angle = i / 12 * TAU;
    parts.push(transformed(
      new THREE.CylinderGeometry(0.045, 0.045, 1.2, 6),
      [Math.sin(angle) * 2.4, 26.47, Math.cos(angle) * 2.4],
    ));
  }
  for (let i = 0; i < 8; i++) {
    const angle = i / 8 * TAU;
    parts.push(transformed(
      new THREE.CylinderGeometry(0.055, 0.055, 2.8, 6),
      [Math.sin(angle) * 1.56, 27.75, Math.cos(angle) * 1.56],
    ));
  }
  return mergeParts(parts);
}

function makeSearchlightBeamGeometry(): THREE.BufferGeometry {
  const length = 260.0;
  const radiusTop = 0.8;
  const radiusBottom = 32.0;
  const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, 24, 8, true);
  // Extend forward from apex (0, 0, 0) along +Z, tilted down slightly (~0.11 rad / 6.3 deg)
  geo.translate(0, -length / 2, 0);
  geo.rotateX(-Math.PI / 2 + 0.11);
  return geo;
}

const beamVertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const beamFragmentShader = /* glsl */ `
uniform float uTime;
uniform float uBlend;
uniform vec3 uColorCore;
uniform vec3 uColorHalo;

varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  if (uBlend <= 0.001) discard;
  // In CylinderGeometry, uv.y goes 1.0 (top/apex) -> 0.0 (bottom/tip)
  float tAxis = 1.0 - vUv.y; // 0.0 at lantern apex -> 1.0 at distant tip

  // Axial falloff: bright and dense near lantern room, long smooth taper into night
  float apexRamp = smoothstep(0.0, 0.025, tAxis);
  float tipTaper = 1.0 - smoothstep(0.52, 1.0, tAxis);
  float axial = apexRamp * tipTaper;

  // Circumferential radial soft profile
  float radial = abs(fract(vUv.x * 2.0) - 0.5) * 2.0;
  float radialSoft = smoothstep(0.0, 1.0, radial);

  // Subtle atmospheric dust stream
  float dust = 0.85 + 0.15 * sin(tAxis * 32.0 - uTime * 2.2 + vUv.x * 12.0);

  float intensity = axial * (0.65 + 0.35 * radialSoft) * dust * uBlend * 0.52;
  vec3 col = mix(uColorHalo, uColorCore, pow(clamp(1.0 - tAxis, 0.0, 1.0), 0.6));
  gl_FragColor = vec4(col * intensity, 1.0);
}
`;

const coreVertexShader = /* glsl */ `
varying vec3 vNormal;
varying vec3 vViewPos;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const coreFragmentShader = /* glsl */ `
uniform float uBlend;
uniform vec3 uGlowColor;

varying vec3 vNormal;
varying vec3 vViewPos;

void main() {
  if (uBlend <= 0.001) discard;
  vec3 N = normalize(vNormal);
  vec3 V = normalize(-vViewPos);
  float fresnel = max(dot(N, V), 0.0);
  float core = pow(fresnel, 1.4);
  vec3 col = uGlowColor * (1.6 + core * 2.2) * uBlend;
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Fixed landmark with 360° volumetric night searchlight beam. */
export class LighthouseLandmark {
  readonly object: THREE.Group;

  private readonly beamAnchor: THREE.Group;
  private readonly beamMesh: THREE.Mesh;
  private readonly beamMaterial: THREE.ShaderMaterial;
  private readonly lanternCoreMesh: THREE.Mesh;
  private readonly lanternCoreMaterial: THREE.ShaderMaterial;

  private _blend = 0.0;
  private _lastTime = 0.0;

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'lighthouse-landmark';
    this.object.position.set(WORLD_X, 0, WORLD_Z);

    const solids = new THREE.Group();
    solids.name = 'lighthouse-solids';

    const rock = new THREE.Mesh(
      makeRockGeometry(),
      createToonMaterial({ color: PALETTE.lighthouseRock, rimStrength: 0.18 }),
    );
    rock.name = 'lighthouse-rock';

    const ivory = new THREE.Mesh(
      makeIvoryGeometry(),
      createToonMaterial({
        color: PALETTE.lighthouseIvory,
        rimStrength: 0.2,
        specColor: PALETTE.sunCore,
        specThreshold: 0.992,
      }),
    );
    ivory.name = 'lighthouse-ivory';

    const accent = new THREE.Mesh(
      mergeParts([makeAccentBand(10.2, 0.82), makeAccentBand(23.1, 0.42)]),
      createToonMaterial({ color: PALETTE.lighthouseTeal, rimStrength: 0.15 }),
    );
    accent.name = 'lighthouse-accent-bands';

    const navy = new THREE.Mesh(
      makeNavyGeometry(),
      createToonMaterial({ color: PALETTE.lighthouseNavy, rimStrength: 0.16 }),
    );
    navy.name = 'lighthouse-lantern-frame';

    const daylightLens = new THREE.Mesh(
      new THREE.CylinderGeometry(1.22, 1.22, 1.72, 24),
      createToonMaterial({ color: PALETTE.lighthouseLens, rimStrength: 0.08 }),
    );
    daylightLens.name = 'lighthouse-daylight-lens';
    daylightLens.position.y = 27.76;

    solids.add(rock, ivory, accent, navy, daylightLens);
    addOutline(solids, { width: 0.38 });
    markInk(solids);
    this.object.add(solids);

    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(1.56, 1.56, 2.76, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: PALETTE.lighthouseGlass,
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    glass.name = 'lighthouse-lantern-glass';
    glass.position.y = 27.76;
    glass.userData.noInk = true;
    glass.userData.noOutline = true;
    glass.layers.set(0);
    this.object.add(glass);

    // --- Night Mode: Volumetric Sweeping Searchlight Beam & Golden Core ---
    this.beamAnchor = new THREE.Group();
    this.beamAnchor.name = 'lighthouse-beam-anchor';
    this.beamAnchor.position.set(0, 27.76, 0);
    this.beamAnchor.visible = false;

    this.beamMaterial = new THREE.ShaderMaterial({
      name: 'LighthouseVolumetricBeam',
      uniforms: {
        uTime: { value: 0 },
        uBlend: { value: 0 },
        uColorCore: { value: new THREE.Color(1.0, 0.94, 0.72) }, // warm incandescent gold
        uColorHalo: { value: new THREE.Color(1.0, 0.72, 0.28) }, // amber halo
      },
      vertexShader: beamVertexShader,
      fragmentShader: beamFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.beamMesh = new THREE.Mesh(makeSearchlightBeamGeometry(), this.beamMaterial);
    this.beamMesh.name = 'lighthouse-searchlight-beam';
    this.beamMesh.userData.noInk = true;
    this.beamMesh.userData.noOutline = true;
    this.beamMesh.layers.set(0);
    this.beamAnchor.add(this.beamMesh);

    this.lanternCoreMaterial = new THREE.ShaderMaterial({
      name: 'LighthouseLanternCore',
      uniforms: {
        uBlend: { value: 0 },
        uGlowColor: { value: new THREE.Color(1.0, 0.88, 0.42) },
      },
      vertexShader: coreVertexShader,
      fragmentShader: coreFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
      toneMapped: false,
    });

    this.lanternCoreMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 16, 12),
      this.lanternCoreMaterial,
    );
    this.lanternCoreMesh.name = 'lighthouse-lantern-glow-core';
    this.lanternCoreMesh.position.set(0, 27.76, 0);
    this.lanternCoreMesh.userData.noInk = true;
    this.lanternCoreMesh.userData.noOutline = true;
    this.lanternCoreMesh.layers.set(0);
    this.lanternCoreMesh.visible = false;

    this.object.add(this.beamAnchor);
    this.object.add(this.lanternCoreMesh);

    // Auto-update hook in render loop to ensure smooth continuous sweeping rotation
    this.object.onBeforeRender = () => {
      if (this._blend > 0) {
        const now = performance.now() * 0.001;
        const t = this._lastTime > 0 ? this._lastTime : now;
        this.beamAnchor.rotation.y = t * 0.32;
        this.beamMaterial.uniforms.uTime.value = t;
      }
    };

    activeLighthouses.add(this);
  }

  setTimeOfDay(tod: TimeOfDay, blend?: number): void {
    const b = blend !== undefined ? blend : tod === 'night' ? 1.0 : 0.0;
    this._blend = Math.max(0, Math.min(1, b));

    const isNightActive = this._blend > 0.001;
    this.beamAnchor.visible = isNightActive;
    this.lanternCoreMesh.visible = isNightActive;
    this.beamMaterial.uniforms.uBlend.value = this._blend;
    this.lanternCoreMaterial.uniforms.uBlend.value = this._blend;
  }

  update(dt: number, t: number): void {
    this._lastTime = t;
    if (this._blend > 0.001) {
      this.beamAnchor.rotation.y = t * 0.32;
      this.beamMaterial.uniforms.uTime.value = t;
    }
  }

  debugState(): LighthouseDebugState {
    return {
      x: this.object.position.x,
      z: this.object.position.z,
      height: TOWER_HEIGHT,
      daylightBeam: false,
      solidMeshes: 5,
      effectMeshes: 1,
    };
  }
}
