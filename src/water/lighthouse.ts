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

function makeSearchlightBeamGeometry(length = 340.0, radiusTop = 0.45, radiusBottom = 7.8): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, 32, 16, true);
  // Extend forward from apex (0, 0, 0) along +Z, tilted down slightly (~0.042 rad / ~2.4 deg)
  geo.translate(0, -length / 2, 0);
  geo.rotateX(-Math.PI / 2 + 0.042);
  return geo;
}

const beamVertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vViewPos;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const beamFragmentShader = /* glsl */ `
uniform float uTime;
uniform float uBlend;
uniform vec3 uColorCore;
uniform vec3 uColorHalo;
uniform float uDensityMul;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vViewPos;

void main() {
  if (uBlend <= 0.001) discard;
  // In CylinderGeometry, uv.y goes 1.0 (top/apex) -> 0.0 (bottom/tip)
  float tAxis = 1.0 - vUv.y; // 0.0 at lantern apex -> 1.0 at distant tip

  // Delicate exponential atmospheric Mie scattering extinction
  float apexRamp = smoothstep(0.0, 0.012, tAxis);
  float axialScatter = exp(-tAxis * 1.85) * (1.0 - smoothstep(0.78, 1.0, tAxis));
  float axial = apexRamp * axialScatter;

  // Analytic smooth volumetric cross-section (limb-brightened soft cylindrical depth)
  float theta = vUv.x * 6.2831853;
  float rho = abs(sin(theta)); // 0 at edges, 1 at center
  float volumeDepth = sqrt(max(0.001, 1.0 - pow(1.0 - rho, 2.0)));
  float gaussianProfile = pow(volumeDepth, 1.6);

  // Delicate dancing micro-atmospheric particle dust
  float dust = 0.94 + 0.06 * sin(tAxis * 28.0 - uTime * 1.2 + vUv.x * 12.0)
                     + 0.04 * cos(tAxis * 42.0 + uTime * 0.9 + vWorldPos.y * 0.5);

  // Silky soft ethereal luminosity
  float intensity = axial * gaussianProfile * dust * uBlend * uDensityMul;
  vec3 col = mix(uColorHalo, uColorCore, exp(-tAxis * 1.6));
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
  float core = pow(fresnel, 2.2);
  vec3 col = uGlowColor * (1.35 + core * 2.2) * uBlend;
  gl_FragColor = vec4(col, 1.0);
}
`;

const flareVertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const flareFragmentShader = /* glsl */ `
uniform float uIntensity;
uniform vec3 uFlareColor;

varying vec2 vUv;

void main() {
  if (uIntensity <= 0.001) discard;
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);

  // Soft circular core halo
  float coreHalo = exp(-r * 3.8);

  // 6-Point sparkling starburst rays
  float angle = atan(p.y, p.x);
  float spikes = pow(abs(cos(angle * 3.0)), 28.0) * exp(-r * 2.2);

  // Horizontal anamorphic cinematic flare streak
  float horizStreak = exp(-abs(p.y) * 24.0) * exp(-abs(p.x) * 1.8) * 1.4;

  float total = (coreHalo * 0.75 + spikes * 0.85 + horizStreak) * uIntensity;
  if (total <= 0.002) discard;
  gl_FragColor = vec4(uFlareColor * total, 1.0);
}
`;

/** Fixed landmark with 360° delicate aesthetic volumetric night searchlight beam & starburst flare. */
export class LighthouseLandmark {
  readonly object: THREE.Group;

  private readonly beamAnchor: THREE.Group;
  private readonly beamCoreMesh: THREE.Mesh;
  private readonly beamCoreMaterial: THREE.ShaderMaterial;
  private readonly beamShaftMesh: THREE.Mesh;
  private readonly beamShaftMaterial: THREE.ShaderMaterial;
  private readonly beamHaloMesh: THREE.Mesh;
  private readonly beamHaloMaterial: THREE.ShaderMaterial;

  private readonly lanternCoreMesh: THREE.Mesh;
  private readonly lanternCoreMaterial: THREE.ShaderMaterial;
  private readonly starburstFlareMesh: THREE.Mesh;
  private readonly starburstFlareMaterial: THREE.ShaderMaterial;

  private _blend = 0.0;
  private _lastTime = 0.0;
  private readonly _toCam = new THREE.Vector3();
  private readonly _beamForward = new THREE.Vector3();

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

    // --- Night Mode: Tri-Layer Volumetric Searchlight Beam & Golden Core ---
    this.beamAnchor = new THREE.Group();
    this.beamAnchor.name = 'lighthouse-beam-anchor';
    this.beamAnchor.position.set(0, 27.76, 0);
    this.beamAnchor.visible = false;

    // Layer 1: Needle Core Beam (Brilliant diamond gold laser-collimated center)
    this.beamCoreMaterial = new THREE.ShaderMaterial({
      name: 'LighthouseBeamCore',
      uniforms: {
        uTime: { value: 0 },
        uBlend: { value: 0 },
        uColorCore: { value: new THREE.Color(1.0, 0.98, 0.88) }, // diamond incandescent white-gold
        uColorHalo: { value: new THREE.Color(1.0, 0.88, 0.48) },
        uDensityMul: { value: 0.48 },
      },
      vertexShader: beamVertexShader,
      fragmentShader: beamFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.beamCoreMesh = new THREE.Mesh(
      makeSearchlightBeamGeometry(320.0, 0.28, 2.6),
      this.beamCoreMaterial,
    );
    this.beamCoreMesh.name = 'lighthouse-beam-core';
    this.beamCoreMesh.userData.noInk = true;
    this.beamCoreMesh.userData.noOutline = true;
    this.beamCoreMesh.layers.set(0);
    this.beamAnchor.add(this.beamCoreMesh);

    // Layer 2: Atmospheric Tyndall Shaft (Warm golden amber scattering body)
    this.beamShaftMaterial = new THREE.ShaderMaterial({
      name: 'LighthouseBeamShaft',
      uniforms: {
        uTime: { value: 0 },
        uBlend: { value: 0 },
        uColorCore: { value: new THREE.Color(1.0, 0.92, 0.65) },
        uColorHalo: { value: new THREE.Color(1.0, 0.72, 0.25) },
        uDensityMul: { value: 0.32 },
      },
      vertexShader: beamVertexShader,
      fragmentShader: beamFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.beamShaftMesh = new THREE.Mesh(
      makeSearchlightBeamGeometry(340.0, 0.55, 7.8),
      this.beamShaftMaterial,
    );
    this.beamShaftMesh.name = 'lighthouse-beam-shaft';
    this.beamShaftMesh.userData.noInk = true;
    this.beamShaftMesh.userData.noOutline = true;
    this.beamShaftMesh.layers.set(0);
    this.beamAnchor.add(this.beamShaftMesh);

    // Layer 3: Wide Ethereal Mist Halo (Dreamy soft atmospheric outer bloom)
    this.beamHaloMaterial = new THREE.ShaderMaterial({
      name: 'LighthouseBeamHalo',
      uniforms: {
        uTime: { value: 0 },
        uBlend: { value: 0 },
        uColorCore: { value: new THREE.Color(1.0, 0.78, 0.35) },
        uColorHalo: { value: new THREE.Color(1.0, 0.55, 0.15) },
        uDensityMul: { value: 0.14 },
      },
      vertexShader: beamVertexShader,
      fragmentShader: beamFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.beamHaloMesh = new THREE.Mesh(
      makeSearchlightBeamGeometry(360.0, 0.95, 14.5),
      this.beamHaloMaterial,
    );
    this.beamHaloMesh.name = 'lighthouse-beam-halo';
    this.beamHaloMesh.userData.noInk = true;
    this.beamHaloMesh.userData.noOutline = true;
    this.beamHaloMesh.layers.set(0);
    this.beamAnchor.add(this.beamHaloMesh);

    // Lantern Glow Core
    this.lanternCoreMaterial = new THREE.ShaderMaterial({
      name: 'LighthouseLanternCore',
      uniforms: {
        uBlend: { value: 0 },
        uGlowColor: { value: new THREE.Color(1.0, 0.92, 0.52) },
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
      new THREE.SphereGeometry(1.25, 18, 14),
      this.lanternCoreMaterial,
    );
    this.lanternCoreMesh.name = 'lighthouse-lantern-glow-core';
    this.lanternCoreMesh.position.set(0, 27.76, 0);
    this.lanternCoreMesh.userData.noInk = true;
    this.lanternCoreMesh.userData.noOutline = true;
    this.lanternCoreMesh.layers.set(0);
    this.lanternCoreMesh.visible = false;

    // Starburst & Anamorphic Lens Flare
    this.starburstFlareMaterial = new THREE.ShaderMaterial({
      name: 'LighthouseStarburstFlare',
      uniforms: {
        uIntensity: { value: 0 },
        uFlareColor: { value: new THREE.Color(1.0, 0.94, 0.65) },
      },
      vertexShader: flareVertexShader,
      fragmentShader: flareFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.starburstFlareMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(16.0, 16.0),
      this.starburstFlareMaterial,
    );
    this.starburstFlareMesh.name = 'lighthouse-starburst-flare';
    this.starburstFlareMesh.position.set(0, 27.76, 0);
    this.starburstFlareMesh.userData.noInk = true;
    this.starburstFlareMesh.userData.noOutline = true;
    this.starburstFlareMesh.layers.set(0);
    this.starburstFlareMesh.visible = false;

    this.object.add(this.beamAnchor);
    this.object.add(this.lanternCoreMesh);
    this.object.add(this.starburstFlareMesh);

    // Auto-update hook in render loop to ensure smooth continuous sweeping rotation
    this.object.onBeforeRender = (_, __, camera) => {
      if (this._blend > 0) {
        const now = performance.now() * 0.001;
        const t = this._lastTime > 0 ? this._lastTime : now;
        const rotY = t * 0.32;
        this.beamAnchor.rotation.y = rotY;
        this.beamCoreMaterial.uniforms.uTime.value = t;
        this.beamShaftMaterial.uniforms.uTime.value = t;
        this.beamHaloMaterial.uniforms.uTime.value = t;

        // Orient starburst lens flare quad to face camera
        this.starburstFlareMesh.quaternion.copy(camera.quaternion);

        // Calculate direct alignment between searchlight beam direction and camera vector
        this._beamForward.set(Math.sin(rotY), 0, Math.cos(rotY)).normalize();
        this._toCam.set(
          camera.position.x - (WORLD_X),
          camera.position.y - 27.76,
          camera.position.z - (WORLD_Z),
        ).normalize();

        const beamAlignment = Math.max(0, this._beamForward.dot(this._toCam));
        const flareStrength = Math.pow(beamAlignment, 7.5) * this._blend * 1.6;
        this.starburstFlareMaterial.uniforms.uIntensity.value = flareStrength;
        this.starburstFlareMesh.visible = flareStrength > 0.005;
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
    this.beamCoreMaterial.uniforms.uBlend.value = this._blend;
    this.beamShaftMaterial.uniforms.uBlend.value = this._blend;
    this.beamHaloMaterial.uniforms.uBlend.value = this._blend;
    this.lanternCoreMaterial.uniforms.uBlend.value = this._blend;
  }

  update(dt: number, t: number): void {
    this._lastTime = t;
    if (this._blend > 0.001) {
      const rotY = t * 0.32;
      this.beamAnchor.rotation.y = rotY;
      this.beamCoreMaterial.uniforms.uTime.value = t;
      this.beamShaftMaterial.uniforms.uTime.value = t;
      this.beamHaloMaterial.uniforms.uTime.value = t;
    }
  }

  debugState(): LighthouseDebugState {
    return {
      x: this.object.position.x,
      z: this.object.position.z,
      height: TOWER_HEIGHT,
      daylightBeam: false,
      solidMeshes: 5,
      effectMeshes: 4,
    };
  }
}
