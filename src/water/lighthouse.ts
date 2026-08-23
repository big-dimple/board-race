import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addOutline } from '../cel/outline';
import { createToonMaterial } from '../cel/toonMaterial';
import { LAYER_ENERGY, markInk } from '../contracts';
import { PALETTE } from '../core/palette';
import { WAVES_GLSL } from './waves';

const WORLD_X = 110;
const WORLD_Z = 190;
const TOWER_HEIGHT = 34;
const BEAM_RADIUS = 70;
const BEAM_PERIOD_S = 18;
const REDUCED_BEAM_PERIOD_S = 36;
const TAU = Math.PI * 2;

type Vec3 = readonly [number, number, number];

export interface LighthouseDebugState {
  x: number;
  z: number;
  height: number;
  beamRadius: number;
  beamYaw: number;
  solidMeshes: number;
  effectMeshes: number;
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
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(position[0], position[1], position[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2])),
    new THREE.Vector3(1, 1, 1),
  );
  geometry.applyMatrix4(matrix);
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
  const segments = 14;
  const variation = [1, 0.91, 1.08, 0.95, 1.04, 0.9, 1.07, 0.94, 1.03, 0.92, 1.09, 0.93, 1.02, 0.9];
  const rings: readonly (readonly [number, number, number, number])[] = [
    [-1.15, 9.8, 7.2, 0.03],
    [0.35, 9.2, 6.7, 0.12],
    [1.65, 7.25, 5.15, -0.08],
    [2.48, 4.8, 3.65, 0.05],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring < rings.length; ring++) {
    const [y, rx, rz, offset] = rings[ring];
    for (let i = 0; i < segments; i++) {
      const angle = i / segments * TAU + offset;
      const wobble = variation[(i + ring * 3) % segments];
      positions.push(Math.sin(angle) * rx * wobble, y, Math.cos(angle) * rz * wobble);
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    const a0 = ring * segments;
    const b0 = (ring + 1) * segments;
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      indices.push(a0 + i, b0 + i, a0 + next, a0 + next, b0 + i, b0 + next);
    }
  }
  const topCenter = positions.length / 3;
  positions.push(0, 2.44, 0);
  const topStart = (rings.length - 1) * segments;
  for (let i = 0; i < segments; i++) {
    indices.push(topStart + i, topCenter, topStart + (i + 1) % segments);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return prepareGeometry(geometry);
}

function shaftRadiusAt(y: number): number {
  return THREE.MathUtils.lerp(3.25, 2.25, THREE.MathUtils.clamp((y - 3.6) / 21.4, 0, 1));
}

function makeIvoryGeometry(): THREE.BufferGeometry {
  return mergeParts([
    transformed(new THREE.CylinderGeometry(3.5, 3.72, 0.6, 14), [0, 2.8, 0]),
    transformed(new THREE.CylinderGeometry(3.25, 3.5, 0.5, 14), [0, 3.35, 0]),
    transformed(new THREE.CylinderGeometry(2.25, 3.25, 21.4, 14), [0, 14.3, 0]),
    transformed(new THREE.CylinderGeometry(2.45, 2.25, 0.5, 14), [0, 25.25, 0]),
    transformed(new THREE.CylinderGeometry(2.08, 2.18, 0.52, 14), [0, 26.1, 0]),
  ]);
}

function makeAccentBand(y: number, height: number): THREE.BufferGeometry {
  const bottom = y - height * 0.5;
  const top = y + height * 0.5;
  return transformed(new THREE.CylinderGeometry(
    shaftRadiusAt(top) + 0.075,
    shaftRadiusAt(bottom) + 0.075,
    height,
    14,
    1,
    true,
  ), [0, y, 0]);
}

function radialPanel(y: number, angle: number): THREE.BufferGeometry {
  const radius = shaftRadiusAt(y) + 0.07;
  return transformed(
    new THREE.BoxGeometry(0.72, 1.35, 0.12),
    [Math.sin(angle) * radius, y, Math.cos(angle) * radius],
    [0, angle, 0],
  );
}

function makeNavyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    transformed(new THREE.CylinderGeometry(3.18, 3.18, 0.46, 14), [0, 25.72, 0]),
    transformed(new THREE.TorusGeometry(2.84, 0.105, 6, 28), [0, 27.2, 0], [Math.PI / 2, 0, 0]),
    transformed(new THREE.TorusGeometry(1.86, 0.12, 6, 28), [0, 26.52, 0], [Math.PI / 2, 0, 0]),
    transformed(new THREE.TorusGeometry(1.86, 0.12, 6, 28), [0, 29.48, 0], [Math.PI / 2, 0, 0]),
    transformed(new THREE.CylinderGeometry(2.34, 2.08, 0.34, 14), [0, 29.7, 0]),
    transformed(new THREE.ConeGeometry(2.34, 1.72, 14), [0, 30.72, 0]),
    transformed(new THREE.CylinderGeometry(0.26, 0.26, 0.25, 8), [0, 31.7, 0]),
    transformed(new THREE.CylinderGeometry(0.075, 0.075, 1.95, 6), [0, 32.8, 0]),
    transformed(new THREE.ConeGeometry(0.17, 0.45, 6), [0, 33.88, 0]),
    radialPanel(7.0, -2.62),
    radialPanel(14.1, -0.54),
    radialPanel(21.2, 1.55),
  ];
  for (let i = 0; i < 10; i++) {
    const angle = i / 10 * TAU;
    parts.push(transformed(
      new THREE.CylinderGeometry(0.065, 0.065, 1.32, 6),
      [Math.sin(angle) * 2.84, 26.55, Math.cos(angle) * 2.84],
    ));
  }
  for (let i = 0; i < 8; i++) {
    const angle = i / 8 * TAU;
    parts.push(transformed(
      new THREE.CylinderGeometry(0.075, 0.075, 2.96, 6),
      [Math.sin(angle) * 1.84, 28.0, Math.cos(angle) * 1.84],
    ));
  }
  return mergeParts(parts);
}

function makeBeamGeometry(): THREE.BufferGeometry {
  const rings = 8;
  const positions: number[] = [];
  const alpha: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring < rings; ring++) {
    const t = ring / (rings - 1);
    const z = THREE.MathUtils.lerp(2.2, BEAM_RADIUS, t);
    const centerY = THREE.MathUtils.lerp(28.0, 2.5, t);
    const halfWidth = THREE.MathUtils.lerp(0.25, 6.0, t);
    const halfHeight = THREE.MathUtils.lerp(0.2, 2.25, t);
    const fade = Math.sin(Math.PI * Math.min(0.98, t + 0.02)) * (1 - t * 0.34);
    positions.push(
      -halfWidth, centerY - halfHeight, z,
      halfWidth, centerY - halfHeight, z,
      halfWidth, centerY + halfHeight, z,
      -halfWidth, centerY + halfHeight, z,
    );
    alpha.push(fade, fade, fade, fade);
  }
  for (let ring = 0; ring < rings - 1; ring++) {
    const a = ring * 4;
    const b = (ring + 1) * 4;
    for (let side = 0; side < 4; side++) {
      const next = (side + 1) % 4;
      indices.push(a + side, b + side, a + next, a + next, b + side, b + next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alpha, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function makeBeamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'LighthouseBeaconVolume',
    uniforms: {
      uColor: { value: new THREE.Color().setHex(PALETTE.lighthouseBeacon, THREE.NoColorSpace) },
      uOpacity: { value: 0.42 },
    },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity * vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });
}

function makeWaterSweepGeometry(): THREE.BufferGeometry {
  const radialSegments = 14;
  const angularSegments = 4;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= radialSegments; r++) {
    const u = r / radialSegments;
    const radius = THREE.MathUtils.lerp(13, BEAM_RADIUS, u);
    for (let a = 0; a <= angularSegments; a++) {
      const v = a / angularSegments;
      const angle = THREE.MathUtils.lerp(-0.086, 0.086, v);
      positions.push(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
      uvs.push(u, v);
    }
  }
  const row = angularSegments + 1;
  for (let r = 0; r < radialSegments; r++) {
    for (let a = 0; a < angularSegments; a++) {
      const i = r * row + a;
      indices.push(i, i + row, i + 1, i + 1, i + row, i + row + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function makeWaterSweepMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'LighthouseWaterSweep',
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color().setHex(PALETTE.lighthouseBeacon, THREE.NoColorSpace) },
      uOpacity: { value: 0.28 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      ${WAVES_GLSL}
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        world.y = waveHeight(world.xz, uTime) + 0.075;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float side = smoothstep(0.0, 0.28, vUv.y) * (1.0 - smoothstep(0.72, 1.0, vUv.y));
        float nearFade = smoothstep(0.0, 0.12, vUv.x);
        float farFade = 1.0 - smoothstep(0.66, 1.0, vUv.x);
        gl_FragColor = vec4(uColor, uOpacity * side * nearFade * farFade);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });
}

function excludeFromInk(mesh: THREE.Mesh): void {
  mesh.userData.noInk = true;
  mesh.userData.noOutline = true;
  mesh.layers.set(0);
}

/** Fixed, visual-only sea landmark. It owns no route, collision, or race state. */
export class LighthouseLandmark {
  readonly object: THREE.Group;

  private readonly beamPivot = new THREE.Group();
  private readonly waterSweepMaterial: THREE.ShaderMaterial;
  private readonly rotationPeriod: number;
  private beamYaw = 0;
  private readonly solidMeshes = 4;
  private readonly effectMeshes = 4;

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'lighthouse-landmark';
    this.object.position.set(WORLD_X, 0, WORLD_Z);
    this.rotationPeriod = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? REDUCED_BEAM_PERIOD_S
      : BEAM_PERIOD_S;

    const solids = new THREE.Group();
    solids.name = 'lighthouse-solids';

    const rock = new THREE.Mesh(
      makeRockGeometry(),
      createToonMaterial({ color: PALETTE.lighthouseRock, rimStrength: 0.38 }),
    );
    rock.name = 'lighthouse-rock';

    const ivory = new THREE.Mesh(
      makeIvoryGeometry(),
      createToonMaterial({
        color: PALETTE.lighthouseIvory,
        rimStrength: 0.42,
        specColor: PALETTE.sunCore,
        specThreshold: 0.985,
      }),
    );
    ivory.name = 'lighthouse-ivory';

    const accent = new THREE.Mesh(
      mergeParts([makeAccentBand(9.0, 1.08), makeAccentBand(18.2, 0.72)]),
      createToonMaterial({ color: PALETTE.lighthouseTeal, rimStrength: 0.32 }),
    );
    accent.name = 'lighthouse-accent-bands';
    accent.userData.noOutline = true;

    const navy = new THREE.Mesh(
      makeNavyGeometry(),
      createToonMaterial({ color: PALETTE.lighthouseNavy, rimStrength: 0.32 }),
    );
    navy.name = 'lighthouse-lantern-frame';

    solids.add(rock, ivory, accent, navy);
    addOutline(solids, { width: 0.8 });
    markInk(solids);
    this.object.add(solids);

    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(1.34, 1.34, 2.48, 14),
      new THREE.MeshBasicMaterial({
        color: PALETTE.lighthouseBeacon,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    core.name = 'lighthouse-lantern-core';
    core.position.y = 28.0;
    excludeFromInk(core);
    core.layers.enable(LAYER_ENERGY);

    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(1.82, 1.82, 2.86, 14, 1, true),
      new THREE.MeshBasicMaterial({
        color: PALETTE.sunCore,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    glass.name = 'lighthouse-lantern-glass';
    glass.position.y = 28.0;
    glass.renderOrder = 4;
    excludeFromInk(glass);

    const beam = new THREE.Mesh(makeBeamGeometry(), makeBeamMaterial());
    beam.name = 'lighthouse-beacon-volume';
    beam.renderOrder = 5;
    excludeFromInk(beam);
    beam.layers.enable(LAYER_ENERGY);

    this.waterSweepMaterial = makeWaterSweepMaterial();
    const waterSweep = new THREE.Mesh(makeWaterSweepGeometry(), this.waterSweepMaterial);
    waterSweep.name = 'lighthouse-water-sweep';
    waterSweep.renderOrder = 3;
    excludeFromInk(waterSweep);

    this.beamPivot.name = 'lighthouse-beacon-pivot';
    this.beamPivot.add(beam, waterSweep);
    this.object.add(core, glass, this.beamPivot);
    this.update(0);
  }

  update(t: number): void {
    this.beamYaw = ((t / this.rotationPeriod * TAU + 0.32) % TAU + TAU) % TAU;
    this.beamPivot.rotation.y = this.beamYaw;
    this.waterSweepMaterial.uniforms.uTime.value = t;
  }

  debugState(): LighthouseDebugState {
    return {
      x: this.object.position.x,
      z: this.object.position.z,
      height: TOWER_HEIGHT,
      beamRadius: BEAM_RADIUS,
      beamYaw: this.beamYaw,
      solidMeshes: this.solidMeshes,
      effectMeshes: this.effectMeshes,
    };
  }
}
