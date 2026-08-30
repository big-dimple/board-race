/**
 * boat.ts — procedural hard-chine race boat + arcade planing physics.
 *
 * Visuals: a ~5.2 m planing hull lofted from hand-placed cross-sections
 * (pointed V bow, flared sides, chine flats, color-wrapped deck with an ink
 * panel line, cockpit + coaming, side sponsons, faired-in jet pump, spoiler),
 * flat-shaded for the analytic toon bands and outlined once via cel/outline. Zero
 * assets: the racing-number decal is drawn into a canvas at build time.
 *
 * Physics: planar heading/velocity model with strong hydrodynamic grip,
 * speed-sensitive steering capped by lateral G, hold-to-powerslide with a
 * drift→boost payout, and 5-point buoyancy sampling of the Gerstner field
 * from water/waves.ts (the same sum the GPU displaces). Crest launches go
 * ballistic; re-contact impact speed is exposed via state.landImpulse for
 * camera shake + audio (>= TUNING.slamThreshold is a slam).
 *
 * update() runs on the fixed 1/60 sim step and allocates nothing per frame.
 */
import * as THREE from 'three';
import { BOAT_GRIP_LOCAL, LAYER_ENERGY, LAYER_INK, MAX_FLIGHT_CHARGES, markInk } from '../contracts';
import type {
  BoatInput,
  BoatState,
  FlightFailureSnapshot,
  FlightPhase,
  HullWaterInteraction,
  IBoat,
  IJetTrail,
  ISpray,
  IWake,
  SurfaceActionMode,
} from '../contracts';
import { PALETTE } from '../core/palette';
import { waterHeight, waterNormalInto } from '../water/waves';
import { createToonMaterial } from '../cel/toonMaterial';
import { addOutline } from '../cel/outline';
import type { DriverHandling } from './racers';

export interface BoatOptions {
  id: number;
  color: number;
  wake: IWake;
  spray: ISpray;
  trail: IJetTrail;
  detailedInk?: boolean;
}

// ---------------------------------------------------------------- tuning ----
// Handling tuning — the polish pass iterates HERE. Units: meters, seconds,
// radians. dt is fixed at 1/60, so per-second rates are integrated directly.
const TUNING = {
  // -- planar drive --
  topSpeed: 34,          // reference top speed, m/s (wake intensity + rpm scale too)
  taperHeadroom: 1.18,   // engine taper reference = topSpeed × this; quadratic drag
                         // settles the REAL top speed back at ≈ topSpeed
  reverseSpeed: 7,       // m/s
  accel: 14,             // m/s² at standstill, tapering to 0 at the taper reference
  reverseAccel: 9,       // m/s²
  brakeDecel: 16,        // m/s², throttle < 0 while still moving forward
  dragQuad: 0.0018,      // quadratic drag: a = −dragQuad · v · |v|
  lateralGrip: 7.5,      // 1/s exponential kill of sideways velocity (hydrodynamic grip)

  // -- steering --
  yawRateMax: 2.0,       // rad/s yaw authority once up to speed
  latGMax: 11,           // m/s² lateral-G cap → turn radius tightens with speed, then grows as v²
  steerFullSpeed: 5,     // m/s where steering reaches full authority (no spinning in place)
  yawDamp: 9,            // 1/s approach rate of yaw rate → target

  // -- drift / boost --
  driftLatGMax: 19.5,    // boosted lateral-G authority during surface drift for crisp apex cutting
  driftYawRateMax: 2.85, // boosted yaw authority during surface drift
  driftGripMul: 0.45,    // lateral grip × this while drifting (−55%)
  driftYawDampMul: 1.0,  // responsive yaw damping while drifting
  driftScrub: 0.1,       // 1/s extra forward speed scrub while drifting (slight — not a brake)
  driftMinSpeed: 12,     // m/s — below this, drifting builds no charge
  driftChargeTime: 1.05, // s of held drift for a full 0→1 charge
  boostReleaseMin: 0.32, // minimum charge that pays out on release
  boostDuration: 1.1,    // s of boost per unit of charge
  boostTopMul: 1.42,     // taper reference × while boosting → ≈ +35% real top speed
  boostAccelMul: 1.4,    // accel × while boosting

  // -- controlled-flight vector braking --
  airBrakeTargetSpeed: 29,
  airBrakeDecel: 24,
  airBrakeLatG: 24,
  airBrakeYawDamp: 14,
  airBrakeGrip: 10,
  airBrakeAttack: 0.08,
  airBrakeRelease: 0.16,

  // -- Final return brake (same turn authority, lower surface target) --
  returnBrakeTargetSpeed: 18,
  returnBrakeDecel: 28,

  // -- earned anti-grav flight --
  flightSpool: 0.12,
  flightAscend: 0.62,
  flightCruise: 5.10,
  flightExtension: 2.40,
  flightDescend: 0.88,
  flightClearance: 20.0,  // hull-root height above the live mean water surface
  flightLandingLead: 0.45, // counter moving-wave lag so the landing envelope seats cleanly
  flightOmega: 9,        // critically damped vertical target tracking
  flightAccelMax: 120,   // m/s², keeps elevated launch responsive and smooth
  flightDriveAccel: 22,
  flightDriveGain: 3.2,
  flightHardCap: 50,
  flightDescentSpeed: 36,
  flightMissSpeedMul: 0.7,
  flightMissDriveMul: 0.3,
  flightMissDriveTime: 1.0,

  // -- buoyancy --
  gravity: 9.8,
  floatK: 38,            // vertical spring stiffness toward (sampled mean − draft)
  floatDamp: 7,          // vertical spring damping
  draft: 0.42,           // m the hull origin sits below the sampled mean surface
                         // (deep enough that the rub rail rides AT the water plane)
  sampleLong: 2.1,       // m, longitudinal offset of bow/stern sample points
  sampleLat: 0.85,       // m, lateral offset of side sample points
  takeoffG: 1.0,         // fraction of gravity: hull unloads when the spring would have to
                         // pull it down harder than this (water can't pull — it separates)
  takeoffDwell: 0.1,     // s of continuous unload before the hull counts as airborne —
                         // micro-skips over chop keep thrust; only crest-lip launches latch
  slamThreshold: 7,      // m/s — landImpulse above this is a slam (camera shake + audio)
  landingVisualCooldown: 1.1, // coalesce the immediate rebound from one water entry

  // -- orientation --
  tiltOmega: 7,          // rad/s, critically-damped pitch/roll spring frequency
  bankMax: 0.244,        // rad (14°) max steering bank into turns
  pitchAccelMax: 0.1,    // rad bow-up at full accel / nose-drop under braking
  idleBobTilt: 0.25,     // extra wave-normal tilt blended in at low speed
  idleBobFadeSpeed: 4,   // m/s where the idle bob finishes fading out
  airTiltKeep: 0.35,     // fraction of wave tilt targets kept while airborne

  // -- wake / spray --
  wakeDriftBoost: 0.4,   // wake intensity add while drifting
  wakeBoostBoost: 0.5,   // wake intensity add while boosting
  cruiseSprayMinSpeed: 10, // m/s, speed threshold where hull chine spray begins
  cruiseSprayPeriod: 0.065, // s between straight-line cruising spray pulses
  turnSprayG: 6,         // |lateralG| that starts leeward-chine spray
  turnSprayPeriod: 0.09, // s between chine spray bursts
  boostSprayPeriod: 0.08,// s between stern spray bursts while boosting
  opponentWakeScale: 0.68, // retain water contact without competing with the raised chain-drift wind
} as const;

// Wake coupling is a body-readability cue, not a hidden steering assist. Keep
// the physics contribution below the threshold that can create a wave launch.
const WAKE_HULL_LIFT_SCALE = 0.22;

// -------------------------------------------------- module-scope temps ----
// Zero per-frame allocations: every update() scratches through these.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _wakeSample = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _euler = new THREE.Euler();
const _blobQ = new THREE.Quaternion();
const _fxMatrix = new THREE.Matrix4();
const _fxPos = new THREE.Vector3();
const _fxScale = new THREE.Vector3();
const _fxIdentityQ = new THREE.Quaternion();
const _fxQBoost = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _fxAxisY = new THREE.Vector3(0, 1, 0);
const _fxAxisZ = new THREE.Vector3(0, 0, 1);
const _fxFlowDir = new THREE.Vector3();
const _fxFlowQ = new THREE.Quaternion();
const _fxRingQ = new THREE.Quaternion();
const _fxRingSpinQ = new THREE.Quaternion();
const _fxLiftDirs = [
  new THREE.Vector3(-0.18, -0.98, -0.08).normalize(),
  new THREE.Vector3(0.18, -0.98, -0.08).normalize(),
] as const;
const _fxQLifts = _fxLiftDirs.map((dir) =>
  new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
const _fxColor = new THREE.Color();

// ------------------------------------------------------------ blob shadow ----
// Hard-edged ink ellipse riding the water surface under each hull. Pins the
// boat visually to the ocean (the "seat") and sells airtime: when the hull
// flies, the blob stays on the water, swelling and thinning with the gap.
let _blobTex: THREE.CanvasTexture | null = null;
function blobTexture(): THREE.CanvasTexture {
  if (_blobTex) return _blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(16, 14, 40, 1)');
  grad.addColorStop(0.74, 'rgba(16, 14, 40, 1)');
  grad.addColorStop(0.8, 'rgba(16, 14, 40, 0)'); // near-hard cel edge
  grad.addColorStop(1, 'rgba(16, 14, 40, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  _blobTex = new THREE.CanvasTexture(c);
  _blobTex.colorSpace = THREE.SRGBColorSpace;
  return _blobTex;
}

function buildBlobShadow(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2); // flat, normal +Y
  const mat = new THREE.MeshBasicMaterial({
    map: blobTexture(),
    transparent: true,
    opacity: 0.36,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'blobShadow';
  mesh.renderOrder = 2; // over the ocean surface, under spray
  return mesh;
}

let _footprintTex: THREE.CanvasTexture | null = null;
function footprintTexture(): THREE.CanvasTexture {
  if (_footprintTex) return _footprintTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 3, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.62)');
  grad.addColorStop(0.22, 'rgba(255,255,255,0.18)');
  grad.addColorStop(0.23, 'rgba(255,255,255,0.72)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.08)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.05)');
  grad.addColorStop(0.56, 'rgba(255,255,255,0.82)');
  grad.addColorStop(0.65, 'rgba(255,255,255,0.12)');
  grad.addColorStop(0.78, 'rgba(255,255,255,0.64)');
  grad.addColorStop(0.83, 'rgba(255,255,255,0.04)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  _footprintTex = new THREE.CanvasTexture(c);
  _footprintTex.colorSpace = THREE.NoColorSpace;
  return _footprintTex;
}

function buildFlightFootprint(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: footprintTexture(),
    color: PALETTE.flight,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'anti-grav-footprint';
  mesh.renderOrder = 4;
  return mesh;
}

interface ThrustVisual {
  shell: THREE.InstancedMesh;
  outer: THREE.InstancedMesh;
  core: THREE.InstancedMesh;
  rings: THREE.InstancedMesh;
}

function buildThrustVisual(): ThrustVisual {
  const geo = new THREE.ConeGeometry(1, 1, 12, 1, true);
  const shellMat = new THREE.MeshBasicMaterial({
    color: PALETTE.flightDeep,
    transparent: true,
    opacity: 0.34,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const outerMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const coreMat = new THREE.MeshBasicMaterial({
    color: PALETTE.foam,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const shell = new THREE.InstancedMesh(geo, shellMat, 4);
  const outer = new THREE.InstancedMesh(geo, outerMat, 5);
  const core = new THREE.InstancedMesh(geo, coreMat, 5);
  const ringGeo = new THREE.TorusGeometry(1, 0.045, 4, 12, Math.PI * 1.18);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.52,
    blending: THREE.NormalBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const rings = new THREE.InstancedMesh(ringGeo, ringMat, 12);
  shell.name = 'thrust-shell';
  outer.name = 'thrust-outer';
  core.name = 'thrust-core';
  rings.name = 'thrust-flow-rings';
  shell.renderOrder = 7;
  outer.renderOrder = 8;
  core.renderOrder = 9;
  rings.renderOrder = 8;
  // Instanced matrices are local to each boat. Inflate the shared local
  // bounds once, then let Three reject the whole effect with its owning hull.
  for (const geometry of [geo, ringGeo]) {
    geometry.computeBoundingSphere();
    geometry.boundingSphere!.center.set(0, 0, 0);
    geometry.boundingSphere!.radius = 6;
  }
  shell.frustumCulled = true;
  outer.frustumCulled = true;
  core.frustumCulled = true;
  rings.frustumCulled = true;
  shell.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  outer.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  core.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  outer.setColorAt(0, _fxColor.setHex(PALETTE.boost, THREE.NoColorSpace));
  outer.setColorAt(1, _fxColor.setHex(PALETTE.flight, THREE.NoColorSpace));
  outer.setColorAt(2, _fxColor.setHex(PALETTE.flight, THREE.NoColorSpace));
  outer.setColorAt(3, _fxColor.setHex(PALETTE.flight, THREE.NoColorSpace));
  outer.setColorAt(4, _fxColor.setHex(PALETTE.flight, THREE.NoColorSpace));
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < 4; i++) shell.setMatrixAt(i, hidden);
  for (let i = 0; i < 5; i++) {
    outer.setMatrixAt(i, hidden);
    core.setMatrixAt(i, hidden);
  }
  for (let i = 0; i < 12; i++) {
    rings.setMatrixAt(i, hidden);
    rings.setColorAt(i, _fxColor.setHex(i % 3 === 1 ? 0x9b7cff : i % 3 === 2 ? PALETTE.foam : PALETTE.flight, THREE.NoColorSpace));
  }
  shell.instanceMatrix.needsUpdate = true;
  outer.instanceMatrix.needsUpdate = true;
  core.instanceMatrix.needsUpdate = true;
  rings.instanceMatrix.needsUpdate = true;
  if (outer.instanceColor) outer.instanceColor.needsUpdate = true;
  if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  outer.layers.enable(LAYER_ENERGY);
  core.layers.enable(LAYER_ENERGY);
  return { shell, outer, core, rings };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smooth01(v: number): number {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// ------------------------------------------------------------ hull loft ----

type Profile = Array<[number, number]>; // (x, y) points, port (+x) → starboard (−x)
interface LoftStation {
  z: number;
  pts: Profile;
}

/**
 * Loft stations (bow +Z → stern −Z) into a flat-shaded, non-indexed
 * BufferGeometry. Winding: profiles run port→starboard; `reverse` flips for
 * surfaces facing the other way (deck faces up, hull faces out).
 */
function loftInto(pos: number[], stations: LoftStation[], closed: boolean, reverse: boolean): void {
  const m = stations[0].pts.length;
  const bands = closed ? m : m - 1;
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    for (let j = 0; j < bands; j++) {
      const j2 = (j + 1) % m;
      const p00 = a.pts[j];
      const p01 = a.pts[j2];
      const p10 = b.pts[j2];
      const p11 = b.pts[j];
      if (!reverse) {
        pos.push(p00[0], p00[1], a.z, p01[0], p01[1], a.z, p10[0], p10[1], b.z);
        pos.push(p00[0], p00[1], a.z, p10[0], p10[1], b.z, p11[0], p11[1], b.z);
      } else {
        pos.push(p00[0], p00[1], a.z, p10[0], p10[1], b.z, p01[0], p01[1], a.z);
        pos.push(p00[0], p00[1], a.z, p11[0], p11[1], b.z, p10[0], p10[1], b.z);
      }
    }
  }
}

/** Fan-cap a closed (x, y, z) loop around its centroid. flip picks the normal side. */
function pushCap(pos: number[], loop: number[][], flip: boolean): void {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of loop) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  cx /= loop.length;
  cy /= loop.length;
  cz /= loop.length;
  for (let j = 0; j < loop.length; j++) {
    const a = loop[j];
    const b = loop[(j + 1) % loop.length];
    if (!flip) {
      pos.push(cx, cy, cz, a[0], a[1], a[2], b[0], b[1], b[2]);
    } else {
      pos.push(cx, cy, cz, b[0], b[1], b[2], a[0], a[1], a[2]);
    }
  }
}

function flatGeometry(pos: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals(); // non-indexed → per-face normals → flat facets
  return geo;
}

/** Batch disconnected flat-shaded parts that share one material and transform. */
function mergeFlatGeometryParts(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const part of parts) {
    const position = part.getAttribute('position');
    const normal = part.getAttribute('normal');
    for (let i = 0; i < position.count; i++) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return merged;
}

/** Bake a primitive's local transform before it enters a material batch. */
function transformedPart(
  source: THREE.BufferGeometry,
  position: readonly [number, number, number] = [0, 0, 0],
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
): THREE.BufferGeometry {
  const geometry = source.index === null ? source.clone() : source.toNonIndexed();
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2]));
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(position[0], position[1], position[2]),
    quaternion,
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
  geometry.applyMatrix4(matrix);
  source.dispose();
  return geometry;
}

function pushQuad(
  pos: number[],
  a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[],
  reverse = false,
): void {
  if (reverse) {
    pos.push(...a, ...c, ...b, ...a, ...d, ...c);
  } else {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
}

// [z, sheerHalfWidth, chineHalfWidth, keelY, chineY, sheerY]
// Keel rises to the bow (V entry), dead-flat planing bottom aft, flared sides.
type HullRow = readonly [number, number, number, number, number, number];
const HULL_TABLE: ReadonlyArray<HullRow> = [
  [2.6, 0.03, 0.02, 0.5, 0.54, 0.64],
  [2.3, 0.26, 0.2, 0.3, 0.35, 0.6],
  [1.8, 0.48, 0.4, 0.15, 0.2, 0.57],
  [1.2, 0.66, 0.57, 0.07, 0.12, 0.54],
  [0.6, 0.77, 0.69, 0.03, 0.07, 0.52],
  [0.0, 0.83, 0.75, 0.01, 0.05, 0.51],
  [-0.6, 0.86, 0.78, 0.0, 0.04, 0.51],
  [-1.2, 0.88, 0.8, 0.0, 0.04, 0.51],
  [-1.8, 0.88, 0.8, 0.0, 0.04, 0.52],
  [-2.6, 0.86, 0.79, 0.02, 0.05, 0.54],
];
const DECK_CROWN = 0.075;

function hullStations(): LoftStation[] {
  return HULL_TABLE.map((row): LoftStation => {
    const [z, sw, cw, ky, cy, sy] = row;
    return {
      z,
      pts: [
        [sw, sy], // sheer port
        [cw, cy], // chine port
        [0, ky], // keel
        [-cw, cy], // chine starboard
        [-sw, sy], // sheer starboard
      ],
    };
  });
}

/** Hull shell: bottom + flared sides, capped bow and transom (caps include the deck crown point). */
function buildHullGeometry(): THREE.BufferGeometry {
  const stations = hullStations();
  const pos: number[] = [];
  loftInto(pos, stations, false, false);
  const capLoop = (i: number): number[][] => {
    const st = stations[i];
    const loop = st.pts.map(([x, y]) => [x, y, st.z] as number[]);
    loop.push([0, HULL_TABLE[i][5] + DECK_CROWN, st.z]); // deck crown closes the top
    return loop;
  };
  pushCap(pos, capLoop(0), true); // bow faces +z
  pushCap(pos, capLoop(stations.length - 1), false); // transom faces −z
  return flatGeometry(pos);
}

/** Deck: sheer → crown → sheer, slightly proud of the hull sheer line to hide the seam. */
function buildDeckGeometry(): THREE.BufferGeometry {
  const stations = HULL_TABLE.map((row): LoftStation => {
    const [z, sw, , , , sy] = row;
    return {
      z,
      pts: [
        [sw + 0.02, sy - 0.01],
        [0, sy + DECK_CROWN],
        [-(sw + 0.02), sy - 0.01],
      ],
    };
  });
  const pos: number[] = [];
  loftInto(pos, stations, false, true); // faces up
  return flatGeometry(pos);
}

/**
 * Slim ink panel-line strip down the foredeck crown, lofted 8 mm proud of the
 * deck so it hugs the crown exactly (no z-fighting). Graphic separation so
 * the colored deck doesn't read as one flat blob from the chase camera.
 */
function buildDeckStripeGeometry(halfWidth = 0.09, lift = 0.008): THREE.BufferGeometry {
  const stations = HULL_TABLE.filter((row) => row[0] <= 2.3 && row[0] >= 0.0).map((row): LoftStation => {
    const [z, , , , , sy] = row;
    return {
      z,
      pts: [
        [halfWidth, sy + DECK_CROWN + lift],
        [-halfWidth, sy + DECK_CROWN + lift],
      ],
    };
  });
  const pos: number[] = [];
  loftInto(pos, stations, false, true); // faces up
  return flatGeometry(pos);
}

/** Narrow tubular rub rail following the full sheer, one per hull side. */
function buildRubRailGeometry(side: 1 | -1): THREE.BufferGeometry {
  const points = HULL_TABLE.map((row) => new THREE.Vector3(
    side * (row[1] + 0.025), row[5] + 0.018, row[0],
  ));
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 36, 0.024, 6, false);
}

/** Foam livery ribbon embedded in the upper hull side, below the rub rail. */
function buildSideLiveryGeometry(side: 1 | -1): THREE.BufferGeometry {
  const rows = HULL_TABLE.filter((row) => row[0] <= 1.8 && row[0] >= -1.8);
  const pos: number[] = [];
  const point = (row: HullRow, heightT: number): number[] => {
    const [, sw, cw, , cy, sy] = row;
    const y = THREE.MathUtils.lerp(cy, sy, heightT);
    const x = THREE.MathUtils.lerp(cw, sw, heightT) + 0.012;
    return [side * x, y, row[0]];
  };
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    pushQuad(pos, point(a, 0.48), point(b, 0.48), point(b, 0.62), point(a, 0.62), side < 0);
  }
  return flatGeometry(pos);
}

interface CockpitStation {
  z: number;
  outer: number;
  inner: number;
  y: number;
}

const COCKPIT: readonly CockpitStation[] = [
  { z: -0.18, outer: 0.43, inner: 0.3, y: 0.695 },
  { z: -0.52, outer: 0.54, inner: 0.405, y: 0.71 },
  { z: -1.2, outer: 0.59, inner: 0.45, y: 0.7 },
  { z: -1.72, outer: 0.54, inner: 0.39, y: 0.69 },
  { z: -1.94, outer: 0.43, inner: 0.31, y: 0.675 },
];

/** Sculpted coaming with top lip plus outer and inner vertical faces. */
function buildCockpitCoamingGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const side of [1, -1] as const) {
    for (let i = 0; i < COCKPIT.length - 1; i++) {
      const a = COCKPIT[i];
      const b = COCKPIT[i + 1];
      const outerA = [side * a.outer, a.y, a.z];
      const outerB = [side * b.outer, b.y, b.z];
      const innerB = [side * b.inner, b.y + 0.012, b.z];
      const innerA = [side * a.inner, a.y + 0.012, a.z];
      pushQuad(pos, outerA, outerB, innerB, innerA, side < 0);
      pushQuad(pos,
        [side * a.outer, a.y - 0.075, a.z],
        [side * b.outer, b.y - 0.075, b.z],
        outerB, outerA, side < 0);
      pushQuad(pos, innerA, innerB,
        [side * b.inner, b.y - 0.105, b.z],
        [side * a.inner, a.y - 0.105, a.z], side < 0);
    }
  }
  for (const index of [0, COCKPIT.length - 1]) {
    const station = COCKPIT[index];
    const reverse = index === 0;
    pushQuad(pos,
      [station.outer, station.y, station.z],
      [-station.outer, station.y, station.z],
      [-station.inner, station.y + 0.012, station.z],
      [station.inner, station.y + 0.012, station.z], reverse);
  }
  return flatGeometry(pos);
}

/** Recessed cockpit floor and side walls, shaped to the coaming opening. */
function buildCockpitTubGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const floorY = 0.565;
  for (let i = 0; i < COCKPIT.length - 1; i++) {
    const a = COCKPIT[i];
    const b = COCKPIT[i + 1];
    pushQuad(pos,
      [a.inner, floorY, a.z], [b.inner, floorY, b.z],
      [-b.inner, floorY, b.z], [-a.inner, floorY, a.z]);
    pushQuad(pos,
      [a.inner, floorY, a.z], [a.inner, a.y + 0.01, a.z],
      [b.inner, b.y + 0.01, b.z], [b.inner, floorY, b.z], true);
    pushQuad(pos,
      [-a.inner, floorY, a.z], [-b.inner, floorY, b.z],
      [-b.inner, b.y + 0.01, b.z], [-a.inner, a.y + 0.01, a.z], true);
  }
  return flatGeometry(pos);
}

function ovalStation(z: number, halfWidth: number, centerY: number, halfHeight: number): LoftStation {
  const pts: Profile = [];
  for (let i = 0; i < 10; i++) {
    const angle = i / 10 * Math.PI * 2;
    pts.push([Math.cos(angle) * halfWidth, centerY + Math.sin(angle) * halfHeight]);
  }
  return { z, pts };
}

/** Low integrated engine cowl that replaces the old floating seat box. */
function buildTailCowlGeometry(): THREE.BufferGeometry {
  const stations = [
    ovalStation(-1.68, 0.3, 0.655, 0.09),
    ovalStation(-1.92, 0.42, 0.665, 0.12),
    ovalStation(-2.22, 0.39, 0.63, 0.095),
    ovalStation(-2.42, 0.25, 0.595, 0.055),
  ];
  const pos: number[] = [];
  loftInto(pos, stations, true, false);
  const cap = (station: LoftStation): number[][] => station.pts.map(([x, y]) => [x, y, station.z]);
  pushCap(pos, cap(stations[0]), true);
  pushCap(pos, cap(stations[stations.length - 1]), false);
  return flatGeometry(pos);
}

type PlanPoint = readonly [number, number];

function clockwisePlan(plan: readonly PlanPoint[]): readonly PlanPoint[] {
  let signedArea = 0;
  for (let i = 0; i < plan.length; i++) {
    const next = plan[(i + 1) % plan.length];
    signedArea += plan[i][0] * next[1] - next[0] * plan[i][1];
  }
  return signedArea > 0 ? [...plan].reverse() : plan;
}

function prismFromPlan(
  plan: readonly PlanPoint[],
  bottomY: number,
  topY: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  // Mirroring x reverses polygon winding. Solids still need +Y top normals on
  // both sides or one half of a paired wing falls into the darkest toon band.
  const ordered = clockwisePlan(plan);
  const bottom = ordered.map(([x, z]) => [x, bottomY, z]);
  const top = ordered.map(([x, z]) => [x, topY, z]);
  pushCap(pos, bottom, true);
  pushCap(pos, top, false);
  for (let i = 0; i < ordered.length; i++) {
    const next = (i + 1) % ordered.length;
    pushQuad(pos, bottom[i], bottom[next], top[next], top[i]);
  }
  return flatGeometry(pos);
}

const REAR_WING_ROOT_X = 0.18;
const REAR_WING_ROOT_Y = 1.08;
const REAR_WING_FOLD_SLOPE = 0.26;

function rearWingBottomY(x: number): number {
  return REAR_WING_ROOT_Y + Math.max(0, Math.abs(x) - REAR_WING_ROOT_X) * REAR_WING_FOLD_SLOPE;
}

/**
 * Aerodynamic folded flap with chordwise thickness tapering: thick structural
 * leading edge spar tapering smoothly to a razor-thin knife-edge trailing plate.
 */
function prismFromTaperedFoldedPlan(
  plan: readonly PlanPoint[],
  rootBottomY: number,
  zLeading: number,
  zTrailing: number,
  tLeading: number,
  tTrailing: number,
  yOffset = 0,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const ordered = clockwisePlan(plan);
  const zSpan = Math.max(1e-4, Math.abs(zTrailing - zLeading));
  const bottom = ordered.map(([x, z]) => {
    const yBase = rootBottomY + yOffset + Math.max(0, Math.abs(x) - REAR_WING_ROOT_X) * REAR_WING_FOLD_SLOPE;
    return [x, yBase, z];
  });
  const top = ordered.map(([x, z], i) => {
    // z is negative (e.g. -2.08 to -2.75); chord fraction runs 0 at nose to 1 at trailing edge
    const chordT = Math.min(1, Math.max(0, (zLeading - z) / zSpan));
    const thickness = tLeading + (tTrailing - tLeading) * chordT;
    return [x, bottom[i][1] + thickness, z];
  });
  pushCap(pos, bottom, true);
  pushCap(pos, top, false);
  for (let i = 0; i < ordered.length; i++) {
    const next = (i + 1) % ordered.length;
    pushQuad(pos, bottom[i], bottom[next], top[next], top[i]);
  }
  return flatGeometry(pos);
}

function counterClockwiseProfile(
  profile: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  let signedArea = 0;
  for (let i = 0; i < profile.length; i++) {
    const next = profile[(i + 1) % profile.length];
    signedArea += profile[i][0] * next[1] - profile[i][1] * next[0];
  }
  return signedArea > 0 ? [...profile].reverse() : profile;
}

/** Extrude a (y, z) side silhouette across x for fins and dorsal structures. */
function prismFromSide(
  profile: readonly (readonly [number, number])[],
  halfWidth: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const ordered = counterClockwiseProfile(profile);
  const left = ordered.map(([y, z]) => [-halfWidth, y, z]);
  const right = ordered.map(([y, z]) => [halfWidth, y, z]);
  pushCap(pos, left, false);
  pushCap(pos, right, true);
  for (let i = 0; i < ordered.length; i++) {
    const next = (i + 1) % ordered.length;
    pushQuad(pos, left[i], right[i], right[next], left[next]);
  }
  return flatGeometry(pos);
}

/** Static rear wing pylons mounted firmly to the hull. */
function buildRearWingBaseGeometry(): THREE.BufferGeometry {
  return mergeFlatGeometryParts([
    // Twin swept blade pylons: raked aerodynamic struts tapering from deck to wing spar
    transformedPart(prismFromSide([[0.64, -1.82], [1.10, -2.12], [1.10, -2.36], [0.64, -2.26]], 0.015),
      [0.34, 0, 0]),
    transformedPart(prismFromSide([[0.64, -1.82], [1.10, -2.12], [1.10, -2.36], [0.64, -2.26]], 0.015),
      [-0.34, 0, 0]),
  ]);
}

/**
 * Articulated aerodynamic flap geometry for one side (side = 1 for Left +X, -1 for Right -X).
 * Pivot origin is at [side * 0.18, 1.08, -2.06].
 */
function buildRearWingFlapGeometry(side: 1 | -1): THREE.BufferGeometry {
  const pivotX = side * 0.18;
  const pivotY = 1.08;
  const pivotZ = -2.06;

  const rawFlap = mergeFlatGeometryParts([
    // Primary lower foil blade: broad swept plate with 26mm leading spar tapering to 6mm trailing flap
    prismFromTaperedFoldedPlan(
      side > 0
        ? [[0.18, -2.06], [0.88, -2.18], [1.02, -2.58], [0.52, -2.68], [0.22, -2.48]]
        : [[-0.18, -2.06], [-0.88, -2.18], [-1.02, -2.58], [-0.52, -2.68], [-0.22, -2.48]],
      1.08, -2.06, -2.68, 0.026, 0.006,
    ),
    // Secondary elevated aero flap: upper slotted Gurney/DRS blade with negative space airflow gap
    prismFromTaperedFoldedPlan(
      side > 0
        ? [[0.24, -2.34], [0.84, -2.42], [0.96, -2.76], [0.46, -2.82], [0.26, -2.64]]
        : [[-0.24, -2.34], [-0.84, -2.42], [-0.96, -2.76], [-0.46, -2.82], [-0.26, -2.64]],
      1.08, -2.34, -2.82, 0.016, 0.005, 0.038,
    ),
    // Thin sculpted endplate winglet: 14mm plate thickness, 25.2-degree outward cant, stepped aero cutouts
    transformedPart(
      prismFromSide([
        [-0.04, -2.14], [0.38, -2.28], [0.32, -2.78], [0.18, -2.76], [0.14, -2.68], [-0.02, -2.62],
      ], 0.007),
      [side * 0.98, rearWingBottomY(0.98), 0],
      [0, 0, -side * 0.44],
    ),
  ]);

  return transformedPart(rawFlap, [-pivotX, -pivotY, -pivotZ]);
}

/**
 * Articulated flap accent trim for one side.
 * Shifted relative to hinge pivot [side * 0.18, 1.08, -2.06].
 */
function buildRearWingFlapAccentGeometry(side: 1 | -1): THREE.BufferGeometry {
  const pivotX = side * 0.18;
  const pivotY = 1.08;
  const pivotZ = -2.06;

  const rawAccent = mergeFlatGeometryParts([
    // Leading-edge trim slats on the lower foil
    prismFromTaperedFoldedPlan(
      side > 0
        ? [[0.28, -2.08], [0.82, -2.19], [0.78, -2.28], [0.32, -2.20]]
        : [[-0.28, -2.08], [-0.82, -2.19], [-0.78, -2.28], [-0.32, -2.20]],
      1.08, -2.08, -2.28, 0.028, 0.022, 0.002,
    ),
    // Upper flap contrast chevron
    prismFromTaperedFoldedPlan(
      side > 0
        ? [[0.32, -2.36], [0.76, -2.43], [0.72, -2.52], [0.36, -2.46]]
        : [[-0.32, -2.36], [-0.76, -2.43], [-0.72, -2.52], [-0.36, -2.46]],
      1.08, -2.36, -2.52, 0.018, 0.014, 0.040,
    ),
    // Endplate exterior aero strakes
    transformedPart(
      prismFromSide([[0.10, -2.24], [0.28, -2.34], [0.24, -2.62], [0.12, -2.56]], 0.010),
      [side * 0.98, rearWingBottomY(0.98), 0],
      [0, 0, -side * 0.44],
    ),
  ]);

  return transformedPart(rawAccent, [-pivotX, -pivotY, -pivotZ]);
}

/** Curved-looking faceted wind deflector with a swept top edge. */
function buildWindscreenGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const a = [-0.44, 0.705, -0.19];
  const b = [0.44, 0.705, -0.19];
  const c = [0.32, 0.895, -0.39];
  const d = [-0.32, 0.895, -0.39];
  pushQuad(pos, a, b, c, d);
  pushQuad(pos, d, c, b, a);
  return flatGeometry(pos);
}

/** Two flush extractor panels on the aft shoulders of the deck. */
function buildAftVentGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const side of [1, -1] as const) {
    const a = [side * 0.5, 0.662, -1.42];
    const b = [side * 0.69, 0.635, -1.62];
    const c = [side * 0.64, 0.63, -1.84];
    const d = [side * 0.45, 0.657, -1.65];
    pushQuad(pos, a, b, c, d, side < 0);
    pushQuad(pos, d, c, b, a, side < 0);
  }
  return flatGeometry(pos);
}

/** Side sponson at the stern quarters. side = +1 port / −1 starboard. */
function buildSponsonGeometry(side: 1 | -1): THREE.BufferGeometry {
  const mk = (z: number, half: number, y: number, thick: number): LoftStation => ({
    z,
    pts: [
      [side * 0.78, y + thick], // top-inner (against the hull)
      [side * (0.78 + half), y], // outer tip
      [side * 0.78, y - thick], // bottom-inner
    ],
  });
  const stations = [mk(-1.3, 0.03, 0.18, 0.03), mk(-2.05, 0.18, 0.15, 0.08), mk(-2.66, 0.13, 0.2, 0.08)];
  const pos: number[] = [];
  loftInto(pos, stations, true, side < 0);
  const capLoop = (i: number): number[][] => stations[i].pts.map(([x, y]) => [x, y, stations[i].z] as number[]);
  pushCap(pos, capLoop(0), side > 0); // bow end faces +z
  pushCap(pos, capLoop(stations.length - 1), side < 0); // stern end faces −z
  return flatGeometry(pos);
}

/** Racing-number decal texture, drawn in code (ink stroke, foam fill). */
function numberDecalTexture(num: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const g = canvas.getContext('2d');
  if (g) {
    const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;
    g.font = '900 68px "Arial Black", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 12;
    g.strokeStyle = css(PALETTE.ink);
    g.strokeText(String(num), 128, 52);
    g.fillStyle = css(PALETTE.foam);
    g.fillText(String(num), 128, 52);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ------------------------------------------------------------ assembly ----

function buildBoatVisual(id: number, color: number): {
  root: THREE.Group;
  riderMount: THREE.Object3D;
  hullMaterial: THREE.ShaderMaterial;
  lowDetailInkSolids: readonly THREE.Mesh[];
  flapNodeL: THREE.Group;
  flapNodeR: THREE.Group;
} {
  const root = new THREE.Group();
  root.name = 'hull';

  const hullMat = createToonMaterial({
    color,
    rimColor: PALETTE.foam,
    rimStrength: 0.95,
    rimThreshold: 0.55,
    specColor: PALETTE.sparkle,
    specThreshold: 0.72,
  });
  const inkMat = createToonMaterial({ color: PALETTE.ink, rimColor: PALETTE.foam, rimStrength: 0.5 });
  const foamMat = createToonMaterial({
    color: PALETTE.foam,
    rimColor: PALETTE.sparkle,
    rimStrength: 0.6,
    specColor: PALETTE.sparkle,
    specThreshold: 0.6,
  });
  const flightMat = createToonMaterial({
    color: 0x163b68,
    emissive: PALETTE.flight,
    emissiveIntensity: 0.18,
    rimColor: PALETTE.foam,
    rimStrength: 0.7,
  });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    root.add(mesh);
    return mesh;
  };

  // Six static material batches replace the old collection of cockpit boxes
  // and one-mesh-per-fastener primitives. More shape, fewer submissions.
  const shellParts: THREE.BufferGeometry[] = [
    buildHullGeometry(),
    buildDeckGeometry(),
    buildSponsonGeometry(1),
    buildSponsonGeometry(-1),
    buildTailCowlGeometry(),
    buildRearWingBaseGeometry(),
    transformedPart(new THREE.CylinderGeometry(0.16, 0.12, 0.34, 16), [0, 0.21, -2.56], [Math.PI / 2, 0, 0]),
  ];
  const hull = add(mergeFlatGeometryParts(shellParts), hullMat);
  hull.name = 'boat-shell-batch';
  hull.userData.assetClass = 'racing-hydrojet-shell';

  const safetyParts: THREE.BufferGeometry[] = [
    transformedPart(buildRubRailGeometry(1)),
    transformedPart(buildRubRailGeometry(-1)),
    buildCockpitCoamingGeometry(),
    buildDeckStripeGeometry(0.115, 0.009),
    transformedPart(new THREE.CylinderGeometry(0.055, 0.075, 0.43, 14), [0, 0.88, -0.72], [-0.42, 0, 0]),
    transformedPart(new THREE.CylinderGeometry(0.06, 0.06, 0.22, 12), BOAT_GRIP_LOCAL.right, [0, 0, Math.PI / 2]),
    transformedPart(new THREE.CylinderGeometry(0.06, 0.06, 0.22, 12), BOAT_GRIP_LOCAL.left, [0, 0, Math.PI / 2]),
    transformedPart(new THREE.CylinderGeometry(0.018, 0.018, 0.67, 8), [0, 0.895, -0.385], [0, 0, Math.PI / 2]),
  ];
  const safety = add(mergeFlatGeometryParts(safetyParts), foamMat);
  safety.name = 'boat-safety-trim-batch';
  safety.userData.assetClass = 'integrated-safety-trim';

  // Articulated active aero flaps: Left and Right independent damped foil nodes
  const flapNodeL = new THREE.Group();
  flapNodeL.name = 'boat-flap-left';
  flapNodeL.position.set(0.18, 1.08, -2.06);

  const flapShellL = new THREE.Mesh(buildRearWingFlapGeometry(1), hullMat);
  flapShellL.name = 'boat-flap-shell-left';
  flapNodeL.add(flapShellL);

  const flapAccentL = new THREE.Mesh(buildRearWingFlapAccentGeometry(1), foamMat);
  flapAccentL.name = 'boat-flap-accent-left';
  flapNodeL.add(flapAccentL);
  root.add(flapNodeL);

  const flapNodeR = new THREE.Group();
  flapNodeR.name = 'boat-flap-right';
  flapNodeR.position.set(-0.18, 1.08, -2.06);

  const flapShellR = new THREE.Mesh(buildRearWingFlapGeometry(-1), hullMat);
  flapShellR.name = 'boat-flap-shell-right';
  flapNodeR.add(flapShellR);

  const flapAccentR = new THREE.Mesh(buildRearWingFlapAccentGeometry(-1), foamMat);
  flapAccentR.name = 'boat-flap-accent-right';
  flapNodeR.add(flapAccentR);
  root.add(flapNodeR);

  const mechanicalParts: THREE.BufferGeometry[] = [
    buildCockpitTubGeometry(),
    buildDeckStripeGeometry(0.024, 0.017),
    buildAftVentGeometry(),
    transformedPart(new THREE.CylinderGeometry(0.042, 0.042, 0.62, 14), [0, BOAT_GRIP_LOCAL.right[1], BOAT_GRIP_LOCAL.right[2]], [0, 0, Math.PI / 2]),
    transformedPart(new THREE.CylinderGeometry(0.08, 0.066, 0.11, 16), [0, 0.21, -2.66], [Math.PI / 2, 0, 0]),
    transformedPart(new THREE.BoxGeometry(0.42, 0.07, 0.31), [0, 0.605, -1.56], [-0.06, 0, 0]),
  ];
  const mechanical = add(mergeFlatGeometryParts(mechanicalParts), inkMat);
  mechanical.name = 'boat-mechanical-batch';
  mechanical.userData.assetClass = 'cockpit-and-jet-mechanics';
  mechanical.userData.noOutline = true;

  const flightParts: THREE.BufferGeometry[] = [
    buildWindscreenGeometry(),
    buildSideLiveryGeometry(1),
    buildSideLiveryGeometry(-1),
    transformedPart(new THREE.CylinderGeometry(0.16, 0.2, 0.08, 14), [0.68, 0.12, -1.62]),
    transformedPart(new THREE.CylinderGeometry(0.16, 0.2, 0.08, 14), [-0.68, 0.12, -1.62]),
  ];
  const flightHardware = add(mergeFlatGeometryParts(flightParts), flightMat);
  flightHardware.name = 'boat-flight-hardware-batch';
  flightHardware.userData.assetClass = 'anti-grav-hardware';
  flightHardware.userData.noOutline = true;

  const reactorStations = [[0.68, -1.72], [1.04, -2.0], [1.3, -2.43], [1.13, -2.72], [0.76, -2.5]] as const;
  const reactorParts: THREE.BufferGeometry[] = [
    prismFromSide(reactorStations, 0.075),
    transformedPart(prismFromSide(reactorStations, 0.065), [0, 0.0075, 0]),
    transformedPart(new THREE.TorusGeometry(0.14, 0.026, 8, 20), [0, 1.15, -2.6], [Math.PI / 2, 0, 0], [1, 1, 0.7]),
    transformedPart(new THREE.TorusGeometry(0.085, 0.018, 8, 16), [0, 1.15, -2.615], [Math.PI / 2, 0, 0], [1, 1, 0.7]),
    transformedPart(new THREE.CylinderGeometry(0.085, 0.085, 0.04, 16), [0, 0.21, -2.72], [Math.PI / 2, 0, 0]),
  ];
  const reactorMat = createToonMaterial({
    color: 0x163b68,
    emissive: PALETTE.flight,
    emissiveIntensity: 0.85,
    rimColor: PALETTE.foam,
    rimStrength: 0.6,
  });
  const reactor = add(mergeFlatGeometryParts(reactorParts), reactorMat);
  reactor.name = 'boat-reactor-batch';
  reactor.userData.assetClass = 'anti-grav-reactor-batch';
  reactor.layers.set(0);
  reactor.layers.enable(LAYER_ENERGY);
  reactor.userData.noInk = true;
  reactor.userData.noOutline = true;

  // racing-number decals on the bow sides (canvas texture; unlit sticker material)
  const decalMat = new THREE.MeshBasicMaterial({
    map: numberDecalTexture(id + 1),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const decalBatch = add(mergeFlatGeometryParts([
    transformedPart(new THREE.PlaneGeometry(0.9, 0.34), [0.55, 0.36, 1.5], [0, Math.PI / 2 - 0.28, 0]),
    transformedPart(new THREE.PlaneGeometry(0.9, 0.34), [-0.55, 0.36, 1.5], [0, -(Math.PI / 2 - 0.28), 0]),
  ]), decalMat);
  decalBatch.name = 'boat-number-batch';
  decalBatch.userData.assetClass = 'paired-number-decals';
  decalBatch.userData.noOutline = true;

  root.userData.assetClass = 'six-batch-racing-hydrojet';
  root.userData.staticBatchCount = 6;

  // rider attach point at the helm; local +Z = boat forward
  const riderMount = new THREE.Object3D();
  riderMount.name = 'riderMount';
  riderMount.position.set(0, 0.64, -1.05);
  root.add(riderMount);

  return {
    root,
    riderMount,
    hullMaterial: hullMat,
    lowDetailInkSolids: [hull, flapShellL, flapShellR],
    flapNodeL,
    flapNodeR,
  };
}

// ---------------------------------------------------------------- boat ----

export class Boat implements IBoat {
  readonly id: number;
  readonly object: THREE.Group; // main adds it to the scene; object.position IS state.position
  readonly state: BoatState;
  readonly riderMount: THREE.Object3D;

  private readonly wake: IWake;
  private readonly spray: ISpray;
  private readonly trail: IJetTrail;
  private readonly presentation: THREE.Group;
  private readonly hullMaterial: THREE.ShaderMaterial;
  private handling: DriverHandling = { acceleration: 1, steering: 1, driftCharge: 1, airControl: 1 };
  private playerOwned: boolean;

  // planar dynamics
  private heading = 0;
  private velX = 0;
  private velZ = 0;
  private yawRate = 0;
  // vertical dynamics
  private vy = 0;
  private unloadTime = 0;
  // orientation springs
  private pitch = 0;
  private pitchVel = 0;
  private roll = 0;
  private rollVel = 0;
  // dynamic active aero flaps (2nd-order damped harmonic oscillators)
  private readonly flapNodeL: THREE.Group;
  private readonly flapNodeR: THREE.Group;
  private flapPitchL = 0;
  private flapPitchVelL = 0;
  private flapPitchR = 0;
  private flapPitchVelR = 0;
  private flapRollL = 0;
  private flapRollVelL = 0;
  private flapRollR = 0;
  private flapRollVelR = 0;
  private flapTargetPitchL = 0;
  private flapTargetPitchR = 0;
  private flapTurnIntensity = 0;
  // drift / boost
  private boostTimer = 0;
  private boostTotal = 0;
  private wasDrifting = false;
  // earned anti-grav flight
  private flightElapsed = 0;
  private flightExtensionTime = 0;
  private flightStartClearance = 0;
  private flightDesiredYPrev = 0;
  private flightTargetVy = 0;
  private flightWaterContact = false;
  private flightPenaltyApplied = false;
  // bookkeeping
  private prevSpeed = 0;
  private lateralG = 0;
  private cruiseSprayCd = 0;
  private cruiseSpraySide = 1;
  private turnSprayCd = 0;
  private boostSprayCd = 0;
  private trailCd = 0;
  private driftTrailCd = 0;
  private wakeSprayCd = 0;
  private landingVisualCooldown = 0;
  private lastLandingDebugEvent = 0;
  private lastLandingRoll = 0;
  private lastLandingLateralG = 0;
  private lastLandingBias = 0;
  private wakeInteractionStrength = 0;
  private wakeInteractionLift = 0;
  private wakeInteractionLateral = 0;
  private wakePreviousStrength = 0;
  private wakeBowPortLift = 0;
  private wakeBowStarboardLift = 0;
  private wakeMidPortLift = 0;
  private wakeMidStarboardLift = 0;
  private wakeSternLift = 0;
  private opponentFxScale = 1;
  private opponentTechniqueFxScale = 1;
  private driftHoldStarts = 0;
  private opponentBoostWasActive = false;
  private opponentReleaseBeats = 0;
  private lastT = 0;
  private readonly blob: THREE.Mesh;
  private readonly footprint: THREE.Mesh;
  private readonly thrustShell: THREE.InstancedMesh;
  private readonly thrustOuter: THREE.InstancedMesh;
  private readonly thrustCore: THREE.InstancedMesh;
  private readonly thrustRings: THREE.InstancedMesh;
  private driftBurstTimer = 0;
  private boostFx = 0;
  private flightFx = 0;
  private liftBurstTimer = 0;
  private liftSplashPending = false;
  private flightMissFxTimer = 0;
  private airBrakeFx = 0;
  // Corridor-violation storm: re-published by the course every fixed step.
  private corridorDistress = 0;
  private corridorPushX = 0;
  private corridorPushZ = 0;
  private flightTargetSpeed = 42;
  private flightTargetClearance: number = TUNING.flightClearance;
  private flightRingActiveCount = 0;
  private flightPlumeLength = 0;
  private flightFlowDeflection = 0;
  private tumbleSpinTimer = 0;
  private tumbleSpinTotal = 0;

  constructor(opts: BoatOptions) {
    this.id = opts.id;
    this.playerOwned = opts.id === 0;
    this.wake = opts.wake;
    this.wake.setVisualScale(this.playerOwned ? 1 : TUNING.opponentWakeScale);
    this.spray = opts.spray;
    this.trail = opts.trail;

    this.object = new THREE.Group();
    this.object.name = `boat-${opts.id}`;
    const presentation = new THREE.Group();
    presentation.name = 'boat-presentation';
    this.presentation = presentation;
    this.object.add(presentation);
    const visual = buildBoatVisual(opts.id, opts.color);
    presentation.add(visual.root);
    this.riderMount = visual.riderMount;
    this.hullMaterial = visual.hullMaterial;
    this.flapNodeL = visual.flapNodeL;
    this.flapNodeR = visual.flapNodeR;

    if (opts.detailedInk !== false) {
      addOutline(this.object);
      markInk(this.object);
    } else {
      // Auto quality keeps the batched mesh that defines the full hull silhouette
      // in the solid prepass. Tagging every cockpit trim piece would add 29
      // prepass draws per rival without changing the occlusion footprint.
      for (const solid of visual.lowDetailInkSolids) solid.layers.enable(LAYER_INK);
    }

    // Ink blob shadow — added AFTER outline/prepass registration so it stays out of
    // both (transparent, world-flat; posed each frame in update()).
    this.blob = buildBlobShadow();
    presentation.add(this.blob);
    this.footprint = buildFlightFootprint();
    this.footprint.layers.enable(LAYER_ENERGY);
    presentation.add(this.footprint);
    const thrust = buildThrustVisual();
    this.thrustShell = thrust.shell;
    this.thrustOuter = thrust.outer;
    this.thrustCore = thrust.core;
    this.thrustRings = thrust.rings;
    presentation.add(
      this.thrustShell,
      this.thrustOuter,
      this.thrustCore,
      this.thrustRings,
    );

    this.state = {
      position: this.object.position, // live reference — never reassigned
      quaternion: this.object.quaternion,
      speed: 0,
      rpm: 0,
      throttle: 0,
      steer: 0,
      drifting: false,
      boostCharge: 0,
      driftBankProgress: 0,
      driftReleaseReady: false,
      boosting: false,
      boostRemaining: 0,
      flightCharges: 0,
      flightPhase: 'surface',
      flightRemaining: 0,
      flightExtensionReady: false,
      flightExtensionUsed: false,
      flightExtended: false,
      flightClearance: -TUNING.draft,
      flightThrust: 0,
      flightAirBrake: 0,
      flightsCleared: 0,
      flightRouteCursor: 0,
      flightRouteIndex: -1,
      flightPressure: 0,
      flightDenied: false,
      flightRouteMiss: false,
      flightRouteState: 'idle',
      flightRouteFailReason: 'none',
      flightFailure: null,
      flightGateProgress: 0,
      flightPenaltyRemaining: 0,
      airborne: false,
      airTime: 0,
      landImpulse: 0,
      lateralG: 0,
      longG: 0,
      heading: 0,
    };

    this.teleport(0, 0, 0); // snap onto the water surface
  }

  /** dt is FIXED 1/60 — no substepping needed. */
  update(
    dt: number,
    input: BoatInput,
    t: number,
    surfaceAction: SurfaceActionMode,
    surfaceTargetScale = 1,
    flightTargetScale = 1,
    wakeFields: readonly IWake[] = [],
  ): void {
    this.lastT = t;
    const st = this.state;
    const pos = this.object.position;
    // Physics owns the root position once the race starts; any frozen opening
    // offset belongs only to the presentation group and is cleared here.
    this.presentation.position.y = 0;

    const thr = clamp(input.throttle, -1, 1);
    const steer = clamp(input.steer, -1, 1);
    const flightWasActive = st.flightPhase !== 'surface';
    // Final deliberately reuses the proven flight-brake envelope on water
    // without becoming a drift, charge source, boost payout, or reverse gear.
    const surfaceReturnBrake = !flightWasActive && surfaceAction === 'return-brake' && input.airBrake;
    let surfaceDrift = !flightWasActive && surfaceAction === 'drift' && input.drift;
    const airBrakeTarget = input.airBrake && (flightWasActive || surfaceReturnBrake) ? 1 : 0;
    const airBrakeTau = airBrakeTarget > this.airBrakeFx ? TUNING.airBrakeAttack : TUNING.airBrakeRelease;
    this.airBrakeFx += (airBrakeTarget - this.airBrakeFx) * (1 - Math.exp(-dt / airBrakeTau));
    st.flightDenied = false;
    st.flightExtended = false;
    st.flightRouteMiss = false;
    st.flightPenaltyRemaining = Math.max(0, st.flightPenaltyRemaining - dt);
    this.landingVisualCooldown = Math.max(0, this.landingVisualCooldown - dt);

    // boost timer (release payout from a previous frame)
    if (this.boostTimer > 0) this.boostTimer = Math.max(0, this.boostTimer - dt);
    let boosting = this.boostTimer > 0;
    const surfaceBoost = boosting && !flightWasActive && !surfaceReturnBrake;
    // Race-director pacing is a physical target-speed contract, not merely an
    // AI throttle preference. Applying it to the engine taper keeps it effective
    // after throttle has saturated, while locally owned boats ignore AI pacing.
    const aiSurfaceScale = !this.playerOwned ? clamp(surfaceTargetScale, 1, 1.18) : 1;
    const aiFlightScale = !this.playerOwned ? clamp(flightTargetScale, 1, 1.02) : 1;
    const taperRef = TUNING.topSpeed * TUNING.taperHeadroom *
      (surfaceBoost ? TUNING.boostTopMul : 1) * aiSurfaceScale;
    const accel = TUNING.accel * this.handling.acceleration * (surfaceBoost ? TUNING.boostAccelMul : 1);

    // heading frame: forward (sinθ, cosθ) — θ=0 → +Z, +θ turns left (CCW from
    // above); port = local +X
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const fwdX = sinH;
    const fwdZ = cosH;
    const portX = cosH;
    const portZ = -sinH;

    // velocity in the boat frame
    let vF = this.velX * fwdX + this.velZ * fwdZ; // signed forward speed
    let vL = this.velX * portX + this.velZ * portZ; // + = sliding to port

    // A fresh wake can lift and cant the hull for a few frames. Sample the
    // five same points used by buoyancy so the response belongs to the body,
    // not to a detached screen-space effect.
    this.sampleWakeInteraction(wakeFields, t, fwdX, fwdZ, portX, portZ);

    if (!st.airborne || flightWasActive) {
      // longitudinal: tapered engine + quadratic drag (+ drift scrub)
      let aF: number;
      if (flightWasActive) {
        const authoredTarget = st.flightPhase === 'descending'
          ? TUNING.flightDescentSpeed
          : this.flightTargetSpeed;
        const cruiseTarget = Math.min(TUNING.flightHardCap, authoredTarget * aiFlightScale);
        const target = cruiseTarget + (TUNING.airBrakeTargetSpeed - cruiseTarget) * this.airBrakeFx;
        const dragCompensation = TUNING.dragQuad * vF * Math.abs(vF);
        const maxDecel = TUNING.airBrakeDecel * Math.max(0.5, this.airBrakeFx);
        aF = clamp(
          (target - vF) * TUNING.flightDriveGain + dragCompensation,
          -maxDecel,
          TUNING.flightDriveAccel,
        );
      } else if (surfaceReturnBrake) {
        const dragCompensation = TUNING.dragQuad * vF * Math.abs(vF);
        const maxDecel = TUNING.returnBrakeDecel * Math.max(0.5, this.airBrakeFx);
        aF = clamp(
          (TUNING.returnBrakeTargetSpeed - vF) * TUNING.flightDriveGain + dragCompensation,
          -maxDecel,
          0,
        );
      } else if (thr >= 0) {
        const driveMul = st.flightPenaltyRemaining > 0 ? TUNING.flightMissDriveMul : 1;
        aF = thr * accel * driveMul * Math.max(0, 1 - vF / taperRef);
      } else if (vF > 0.5) {
        aF = thr * TUNING.brakeDecel; // braking while still moving forward
      } else {
        aF = thr * TUNING.reverseAccel * Math.max(0, 1 + vF / TUNING.reverseSpeed);
      }
      aF -= TUNING.dragQuad * vF * Math.abs(vF);
      if (surfaceDrift) aF -= TUNING.driftScrub * vF;
      vF += aF * dt;
      if (flightWasActive) vF = Math.min(vF, TUNING.flightHardCap);
      if (surfaceReturnBrake) vF = Math.max(0, vF);

      // lateral hydrodynamic grip — cut while drifting (powerslide)
      const brakeGrip = TUNING.lateralGrip + (TUNING.airBrakeGrip - TUNING.lateralGrip) * this.airBrakeFx;
      const driftCut = surfaceDrift ? TUNING.driftGripMul + (1 - TUNING.driftGripMul) * this.airBrakeFx : 1;
      const grip = brakeGrip * driftCut;
      vL *= Math.max(0, 1 - grip * dt);
    }
    // airborne: ballistic — horizontal velocity carries through untouched

    this.velX = fwdX * vF + portX * vL;
    this.velZ = fwdZ * vF + portZ * vL;

    // Corridor-violation storm. Just past the mist edge the wind is a firm
    // shove the player can still fight; deep into the red it overwhelms the
    // air control and scrubs speed like a stall, so an uncorrected excursion
    // physically runs away toward the corridor fail.
    const distress = flightWasActive ? this.corridorDistress : 0;
    if (distress > 0) {
      const storm = distress * distress;
      const windAccel = 3.5 + 11 * storm;
      this.velX += this.corridorPushX * windAccel * dt;
      this.velZ += this.corridorPushZ * windAccel * dt;
      const stall = smooth01((distress - 0.45) / 0.55);
      if (stall > 0) {
        const drag = 1 - Math.min(0.5, 1.6 * stall * dt);
        this.velX *= drag;
        this.velZ *= drag;
      }
    }

    // steering: full authority once moving, capped by lateral G at speed,
    // reversed in reverse
    const speedAbs = Math.abs(vF);
    const steeringMul = flightWasActive ? this.handling.airControl : this.handling.steering;
    const baseLatG = surfaceDrift ? TUNING.driftLatGMax : TUNING.latGMax;
    const latGMax = (baseLatG + (TUNING.airBrakeLatG - baseLatG) * this.airBrakeFx) * steeringMul;
    const gCap = latGMax / Math.max(speedAbs, 0.5);
    const authority = Math.min(speedAbs / TUNING.steerFullSpeed, 1) * (vF < 0 ? -1 : 1);
    const maxYawRate = (surfaceDrift ? TUNING.driftYawRateMax : TUNING.yawRateMax) * steeringMul;
    const yawTarget = -steer * Math.min(maxYawRate, gCap) * authority;
    const baseYawDamp = TUNING.yawDamp + (TUNING.airBrakeYawDamp - TUNING.yawDamp) * this.airBrakeFx;
    const driftYawCut = surfaceDrift ? TUNING.driftYawDampMul + (1 - TUNING.driftYawDampMul) * this.airBrakeFx : 1;
    const yawDamp = baseYawDamp * driftYawCut;
    this.yawRate += (yawTarget - this.yawRate) * Math.min(1, yawDamp * dt);
    // Storm gusts wander the nose; full control returns the moment the hull
    // is back inside the corridor.
    if (distress > 0) {
      const storm = distress * distress;
      this.yawRate += (Math.sin(t * 9.7 + 1.3) * 0.62 + Math.sin(t * 15.1 + 4.2) * 0.38) * 0.55 * storm * dt;
    }
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    this.lateralG = vF * this.yawRate; // + = turning left

    // drift charge / boost payout on release
    if (surfaceDrift && !this.wasDrifting) {
      if (!this.playerOwned) this.driftHoldStarts++;
    }
    if (surfaceDrift) {
      this.accrueDriftCharge(dt, speedAbs);
    } else if (this.wasDrifting) {
      if (st.boostCharge >= TUNING.boostReleaseMin) {
        this.boostTimer = st.boostCharge * TUNING.boostDuration;
        this.boostTotal = this.boostTimer;
        // Flying never replaces the old payout. A wave jump on the release
        // frame must not steal the earned charge; only controlled flight blocks
        // re-arming, which prevents an infinite airborne chain.
        if (!flightWasActive) st.flightCharges = Math.min(MAX_FLIGHT_CHARGES, st.flightCharges + 1);
      }
      st.boostCharge = 0;
    }
    this.wasDrifting = surfaceDrift;
    boosting = this.boostTimer > 0;

    // Process the trigger after drift payout so releasing Shift and pressing Space
    // on the same simulation frame is a valid combo.
    if (input.flightTrigger) {
      if (st.flightCharges > 0 && st.flightPhase === 'surface') {
        st.flightCharges--;
        st.flightPhase = 'spool';
        st.flightRouteState = 'idle';
        st.flightRouteIndex = -1;
        st.flightRouteFailReason = 'none';
        st.flightGateProgress = 0;
        this.flightElapsed = 0;
        this.flightExtensionTime = 0;
        this.flightWaterContact = false;
        st.flightExtensionReady = false;
        st.flightExtensionUsed = false;
        this.liftBurstTimer = 0.22;
        this.liftSplashPending = true;
        this.flightPenaltyApplied = false;
        st.airborne = false;
        st.airTime = 0;
        this.unloadTime = 0;
      } else if (st.flightCharges > 0 && this.canExtendFlight()) {
        st.flightCharges--;
        this.flightExtensionTime = TUNING.flightExtension;
        st.flightExtensionUsed = true;
        st.flightExtensionReady = false;
        st.flightExtended = true;
        // Arrest a late descent without snapping the hull upward. The regular
        // vertical spring then returns it to authored cruise clearance.
        this.vy = Math.max(this.vy, -1);
        this.flightTargetVy = Math.max(this.flightTargetVy, 0);
        this.liftBurstTimer = Math.max(this.liftBurstTimer, 0.22);
      } else {
        st.flightDenied = true;
      }
    }

    // integrate planar position
    pos.x += this.velX * dt;
    pos.z += this.velZ * dt;

    // ---- buoyancy: 5-point sample of the Gerstner field ----
    const L = TUNING.sampleLong;
    const W = TUNING.sampleLat;
    const hBowL = waterHeight(pos.x + portX * W + fwdX * L, pos.z + portZ * W + fwdZ * L, t);
    const hBowR = waterHeight(pos.x - portX * W + fwdX * L, pos.z - portZ * W + fwdZ * L, t);
    const hMidL = waterHeight(pos.x + portX * W, pos.z + portZ * W, t);
    const hMidR = waterHeight(pos.x - portX * W, pos.z - portZ * W, t);
    const hSt = waterHeight(pos.x - fwdX * L, pos.z - fwdZ * L, t);
    const surfaceY = (hBowL + hBowR + hMidL + hMidR + hSt) / 5;
    const targetY = surfaceY - TUNING.draft;

    st.landImpulse = 0; // only landing frames report an impact
    let landingImpact = 0;
    if (st.flightPhase !== 'surface') {
      landingImpact = this.updateFlight(dt, surfaceY, targetY);
    } else if (st.airborne) {
      this.vy -= TUNING.gravity * dt;
      pos.y += this.vy * dt;
      st.airTime += dt;
      if (this.vy <= 0 && pos.y <= targetY) {
        // water re-contact
        pos.y = targetY;
        const impact = -this.vy;
        this.vy = 0;
        this.unloadTime = 0;
        st.airborne = false;
        st.airTime = 0;
        st.landImpulse = impact;
        landingImpact = impact;
      }
    } else {
      // Water can only push, never pull: downward accel clamps at −g, so brief
      // unloads become free-fall micro-skips that KEEP thrust and grip. The
      // airborne flag latches only after a sustained unload (dwell) — i.e. a
      // real crest-lip launch — and only then does re-contact report
      // landImpulse / spray / wake slam.
      const aY = TUNING.floatK * (targetY - pos.y) - TUNING.floatDamp * this.vy;
      this.vy += Math.max(aY, -TUNING.gravity * TUNING.takeoffG) * dt;
      pos.y += this.vy * dt;
      if (aY <= -TUNING.gravity * TUNING.takeoffG) {
        this.unloadTime += dt;
        if (this.unloadTime >= TUNING.takeoffDwell) {
          st.airborne = true;
          st.airTime = 0;
        }
      } else {
        this.unloadTime = 0;
      }
    }

    // Input is sampled before the vertical integrator discovers water contact.
    // Hand a held air-brake to surface drift on that exact fixed step so the
    // player never has to release and press Shift again after a normal flight.
    // Final keeps air-brake ownership and is intentionally excluded.
    if (flightWasActive && st.flightPhase === 'surface' && surfaceAction === 'drift') {
      this.airBrakeFx = 0;
      if (input.airBrake) {
        surfaceDrift = true;
        this.accrueDriftCharge(dt, speedAbs);
        this.wasDrifting = true;
      }
    }

    // ---- orientation: wave slope + drive feel, critically damped ----
    const bowH = (hBowL + hBowR) * 0.5;
    const portH = (hBowL + hMidL) * 0.5;
    const stbdH = (hBowR + hMidR) * 0.5;
    let pitchT = Math.atan2(bowH - hSt, L * 2); // bow-up positive
    let rollT = Math.atan2(portH - stbdH, W * 2); // port-up positive
    // The wake is a visual/body response here; keep the authored water height
    // untouched so route ownership and launch thresholds remain deterministic.
    const wakeBow = (this.wakeBowPortLift + this.wakeBowStarboardLift) * 0.5;
    const wakeMid = (this.wakeMidPortLift + this.wakeMidStarboardLift) * 0.5;
    const wakePitch = (wakeBow - this.wakeSternLift) * WAKE_HULL_LIFT_SCALE / Math.max(L * 2, 1);
    const wakeRoll = (this.wakeMidPortLift - this.wakeMidStarboardLift) * WAKE_HULL_LIFT_SCALE / Math.max(W * 2, 1);
    pitchT += wakePitch;
    rollT += wakeRoll;

    // idle bob: lean into the local water normal when slow
    const idleW = clamp(1 - speedAbs / TUNING.idleBobFadeSpeed, 0, 1);
    if (idleW > 0) {
      waterNormalInto(_nrm, pos.x, pos.z, t);
      const invY = 1 / Math.max(_nrm.y, 0.3);
      pitchT += -(_nrm.x * fwdX + _nrm.z * fwdZ) * invY * idleW * TUNING.idleBobTilt;
      rollT += -(_nrm.x * portX + _nrm.z * portZ) * invY * idleW * TUNING.idleBobTilt;
    }

    // bank into turns (∝ lateral G), bow-up on accel / nose-drop on braking
    rollT += -clamp(this.lateralG / TUNING.latGMax, -1.3, 1.3) * TUNING.bankMax;
    const longG = (vF - this.prevSpeed) / dt;
    this.prevSpeed = vF;
    pitchT += clamp(longG / TUNING.accel, -1, 1) * TUNING.pitchAccelMax;

    if (st.airborne) {
      pitchT *= TUNING.airTiltKeep;
      rollT *= TUNING.airTiltKeep;
    } else if (st.flightPhase !== 'surface') {
      // Stable anti-grav banking keeps the craft readable as flight, while
      // Space still owns the exact old yaw/grip behavior underneath.
      pitchT *= 0.2;
      rollT = -clamp(this.lateralG / TUNING.latGMax, -1.2, 1.2) * TUNING.bankMax * 1.35;
      // Corridor storm buffet: the hull visibly fights the wind before the
      // fail lands, strongest at deep red.
      if (distress > 0) {
        rollT += (Math.sin(t * 12.9) * 0.62 + Math.sin(t * 7.1 + 2.2) * 0.38) * 0.16 * distress;
        pitchT += Math.sin(t * 10.7 + 0.9) * 0.09 * distress;
      }
    }

    const w = TUNING.tiltOmega; // critically damped: ζ = 1
    this.pitchVel += (w * w * (pitchT - this.pitch) - 2 * w * this.pitchVel) * dt;
    this.pitch += this.pitchVel * dt;
    this.rollVel += (w * w * (rollT - this.roll) - 2 * w * this.rollVel) * dt;
    this.roll += this.rollVel * dt;

    if (landingImpact > 0.5 && this.landingVisualCooldown <= 0) {
      const lateralBias = clamp(
        (-this.roll / TUNING.bankMax) * 0.7 +
        (this.lateralG / TUNING.latGMax) * 0.3,
        -1,
        1,
      );
      if (this.playerOwned) {
        this.lastLandingDebugEvent++;
        this.lastLandingRoll = this.roll;
        this.lastLandingLateralG = this.lateralG;
        this.lastLandingBias = lateralBias;
      }
      this.emitLandingImpact(surfaceY, hSt, fwdX, fwdZ, portX, portZ, landingImpact, speedAbs, lateralBias);
      this.landingVisualCooldown = TUNING.landingVisualCooldown;
    }

    let extraYaw = 0;
    let extraPitch = 0;
    let extraRoll = 0;
    if (this.tumbleSpinTimer > 0) {
      this.tumbleSpinTimer = Math.max(0, this.tumbleSpinTimer - dt);
      const p = 1 - (this.tumbleSpinTimer / Math.max(1e-3, this.tumbleSpinTotal));
      // 720 degrees = Math.PI * 4 radians along inertia
      extraYaw = p * Math.PI * 4;
      extraPitch = Math.sin(p * Math.PI * 4) * 0.42;
      extraRoll = Math.sin(p * Math.PI * 4) * 0.55;
      if (this.tumbleSpinTimer === 0) {
        _v2.set(this.object.position.x, surfaceY, this.object.position.z);
        this.spray.burst(_v2, 16, 7.2);
      }
    }

    _euler.set(-this.pitch + extraPitch, this.heading + extraYaw, this.roll + extraRoll, 'YXZ'); // euler.x is nose-down positive
    this.object.quaternion.setFromEuler(_euler);

    // ---- active aerodynamic rear wing flaps ----
    this.updateDynamicFlaps(
      dt,
      t,
      vF,
      vL,
      steer,
      landingImpact,
      surfaceDrift,
      flightWasActive,
      boosting,
    );

    // ---- ink blob shadow on the water ----
    // Child of the boat group, counter-rotated so it stays world-flat, glued
    // to the local water surface. Gap above the water swells/thins it — the
    // classic anime "off the deck" airtime cue.
    {
      const hMid = (hMidL + hMidR) * 0.5;
      const gap = clamp(pos.y - targetY, 0, 6);
      const air = gap / 4.5;
      _blobQ.copy(this.object.quaternion).invert();
      this.blob.quaternion.copy(_blobQ);
      // biased ~0.45m astern so the ink kisses the transom corners (kills
      // the "levitating stern" daylight gap) without starving the bow
      this.blob.position
        .set(-fwdX * 0.45, hMid + 0.07 - pos.y, -fwdZ * 0.45)
        .applyQuaternion(_blobQ);
      const s = 1 + air * 0.5;
      this.blob.scale.set(2.4 * s, 1, 4.6 * s);
      // 0.36: dark enough to seat the hull, light enough to not read oil-slick
      (this.blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0.11, 0.36 - air * 0.22);

      this.footprint.quaternion.copy(_blobQ);
      this.footprint.position.set(0, hMid + 0.09 - pos.y, 0).applyQuaternion(_blobQ);
      const burstN = clamp(this.liftBurstTimer / 0.22, 0, 1);
      const burstP = 1 - burstN;
      const footprintScale = this.liftBurstTimer > 0 ? 2.8 + burstP * 3.7 : 2.3 + gap * 0.55;
      this.footprint.scale.set(footprintScale, 1, footprintScale * 1.35);
      const footprintMat = this.footprint.material as THREE.MeshBasicMaterial;
      footprintMat.color.setHex(this.flightMissFxTimer > 0 ? PALETTE.uiWarn : PALETTE.flight, THREE.NoColorSpace);
      footprintMat.opacity = this.liftBurstTimer > 0
        ? 0.25 + burstN * 0.6
        : this.flightFx * (0.36 + 0.12 * (1 - air));
    }

    // ---- wake ribbon (every frame) ----
    _v1.set(pos.x - fwdX * 2.3, hSt + 0.04, pos.z - fwdZ * 2.3);
    // White water sells the player's speed, but must not bury an opponent's
    // warm hold wind or green release. Rival technique remains visible through
    // real state-driven energy FX, while their ordinary wash stays restrained.
    const wakeI = clamp(vF / TUNING.topSpeed, 0, 1) +
      (this.playerOwned && input.drift ? TUNING.wakeDriftBoost : 0) +
      (this.playerOwned && boosting ? TUNING.wakeBoostBoost : 0);
    // Zero intensity while airborne: the ribbon coasts (no emission in flight)
    // instead of drawing an unbroken confetti trail beneath a flying boat.
    const flightWake = 1 - clamp(Math.max(0, st.flightClearance) / 1.5, 0, 1);
    this.wake.push(_v1, fwdX, fwdZ, st.airborne ? 0 : Math.min(1, wakeI) * flightWake);

    // Fresh wake contact breaks at the bow once, then settles. The cue is
    // intentionally smaller than a landing splash: it tells the player the
    // hull has crossed another boat's water without masking the line.
    this.wakeSprayCd = Math.max(0, this.wakeSprayCd - dt);
    const wakeRise = this.wakeInteractionStrength - this.wakePreviousStrength;
    if (!st.airborne && st.flightPhase === 'surface' && this.wakeInteractionStrength > 0.36 &&
        wakeRise > 0.055 && this.wakeSprayCd <= 0) {
      this.wakeSprayCd = 0.18;
      _v2.set(pos.x + fwdX * L, (hBowL + hBowR) * 0.5 + 0.08, pos.z + fwdZ * L);
      const count = this.playerOwned ? 4 : Math.max(1, Math.round(2 * this.opponentFxScale));
      this.spray.burst(_v2, count, 1.6 + speedAbs * 0.12);
    }
    this.wakePreviousStrength = this.wakeInteractionStrength;

    // ---- straight-line cruising & planing spray along hull chines ----
    if (!st.airborne && st.flightPhase === 'surface' && speedAbs > TUNING.cruiseSprayMinSpeed &&
        Math.abs(this.lateralG) <= TUNING.turnSprayG) {
      this.cruiseSprayCd -= dt;
      if (this.cruiseSprayCd <= 0) {
        this.cruiseSprayCd = TUNING.cruiseSprayPeriod;
        this.cruiseSpraySide = -this.cruiseSpraySide;
        const side = this.cruiseSpraySide;
        // Chine contact point: mid-to-stern where the planing hull slices the water
        const longOffset = 0.45;
        _v2.set(
          pos.x + portX * side * (W * 0.92) - fwdX * longOffset,
          (side > 0 ? hMidL : hMidR) + 0.04,
          pos.z + portZ * side * (W * 0.92) - fwdZ * longOffset,
        );
        _v1.set(fwdX, 0, fwdZ);
        _v3.set(portX, 0, portZ);
        const count = this.playerOwned ? 3 : Math.max(0, Math.round(3 * this.opponentFxScale));
        if (count > 0) this.spray.chine(_v2, _v1, _v3, side, speedAbs, count);
      }
    } else {
      this.cruiseSprayCd = 0;
    }

    // ---- turn spray off the leeward chine ----
    if (!st.airborne && st.flightPhase === 'surface' && Math.abs(this.lateralG) > TUNING.turnSprayG &&
        !(!this.playerOwned && surfaceDrift)) {
      this.turnSprayCd -= dt;
      if (this.turnSprayCd <= 0) {
        this.turnSprayCd = TUNING.turnSprayPeriod;
        const side = this.lateralG > 0 ? -1 : 1; // turning left → spray off the starboard chine
        _v2.set(
          pos.x + portX * side * (W + 0.1) - fwdX * 0.6,
          (side > 0 ? hMidL : hMidR) + 0.06,
          pos.z + portZ * side * (W + 0.1) - fwdZ * 0.6,
        );
        _v1.set(fwdX, 0, fwdZ);
        _v3.set(portX, 0, portZ);
        const count = this.playerOwned ? 2 : Math.max(1, Math.round(1 * this.opponentFxScale));
        this.spray.chine(_v2, _v1, _v3, side, speedAbs, count);
      }
    } else {
      this.turnSprayCd = 0;
    }

    // ---- boost exhaust spray ----
    if (this.liftSplashPending) {
      this.liftSplashPending = false;
      _v2.set(pos.x, surfaceY + 0.08, pos.z);
      _v1.set(fwdX, 0, fwdZ);
      _v3.set(portX, 0, portZ);
      this.spray.takeoff(_v2, _v1, _v3, this.playerOwned ? 34 : Math.round(12 * this.opponentFxScale), 7.5);
    }

    const opponentBoostStarted = !this.playerOwned && boosting && !this.opponentBoostWasActive &&
      !st.airborne && st.flightClearance < 1.2;
    if (opponentBoostStarted) {
      this.opponentReleaseBeats++;
    }

    if (this.playerOwned && boosting && !st.airborne && st.flightClearance < 1.2) {
      this.boostSprayCd -= dt;
      if (this.boostSprayCd <= 0) {
        this.boostSprayCd = TUNING.boostSprayPeriod;
        _v2.set(pos.x - fwdX * 2.4, hSt + 0.1, pos.z - fwdZ * 2.4);
        this.spray.burst(_v2, 3, 3 + speedAbs * 0.15);
      }
    }

    this.driftTrailCd -= dt;
    if (this.playerOwned && surfaceDrift && st.boostCharge > 0.04 &&
        speedAbs > TUNING.driftMinSpeed && this.driftTrailCd <= 0) {
      this.driftTrailCd = 0.05;
      const side = Math.abs(this.lateralG) > 0.5 ? (this.lateralG > 0 ? -1 : 1) : (steer >= 0 ? 1 : -1);
      const charge = st.boostCharge;
      this.trail.emit(
        pos.x + portX * side * 0.88 - fwdX * 1.15,
        pos.y + 0.06,
        pos.z + portZ * side * 0.88 - fwdZ * 1.15,
        -fwdX * (0.78 + charge) + portX * side * 0.65,
        0.16 + charge * 0.45,
        -fwdZ * (0.78 + charge) + portZ * side * 0.65,
        PALETTE.boost,
        0.11 + charge * 0.14,
        0.24 + charge * 0.18,
      );
    }

    this.updateOpponentDriftBurst(dt, t, opponentBoostStarted);
    this.updateThrustVisual(dt, t, boosting, st.flightThrust, fwdX, fwdZ, portX, portZ);
    this.opponentBoostWasActive = boosting;

    // ---- state ----
    st.speed = vF;
    st.throttle = thr;
    st.steer = steer;
    st.drifting = surfaceDrift;
    st.driftReleaseReady = surfaceDrift && st.flightPhase === 'surface' &&
      speedAbs > TUNING.driftMinSpeed && st.boostCharge >= TUNING.boostReleaseMin;
    st.boosting = boosting;
    st.boostRemaining = boosting && this.boostTotal > 0 ? clamp(this.boostTimer / this.boostTotal, 0, 1) : 0;
    st.driftBankProgress = clamp(st.boostCharge / TUNING.boostReleaseMin, 0, 1);
    st.flightClearance = pos.y - surfaceY;
    st.flightAirBrake = this.airBrakeFx;
    st.flightExtensionReady = this.canExtendFlight();
    st.flightPressure = flightWasActive ? smooth01(clamp((speedAbs - TUNING.topSpeed) / 14, 0, 1)) : 0;
    st.lateralG = this.lateralG;
    st.longG = longG;
    st.heading = this.heading;
    st.rpm = clamp(
      (speedAbs / (TUNING.topSpeed * (boosting ? TUNING.boostTopMul : 1))) * 0.85 + Math.abs(thr) * 0.15 + (boosting ? 0.12 : 0),
      0,
      1,
    );
    // st.position / st.quaternion are live references — already current.
  }

  private updateThrustVisual(
    dt: number,
    t: number,
    boosting: boolean,
    flightThrust: number,
    fwdX: number,
    fwdZ: number,
    portX: number,
    portZ: number,
  ): void {
    const st = this.state;
    const boostTarget = boosting ? 1 : 0;
    const flightTarget = Math.max(flightThrust, st.flightCharges > 0 ? 0.08 : 0);
    const boostRate = boostTarget > this.boostFx ? 22 : 6;
    this.boostFx += (boostTarget - this.boostFx) * (1 - Math.exp(-boostRate * dt));
    if (flightTarget >= this.flightFx) this.flightFx = flightTarget;
    else this.flightFx += (flightTarget - this.flightFx) * (1 - Math.exp(-7 * dt));
    this.liftBurstTimer = Math.max(0, this.liftBurstTimer - dt);
    this.flightMissFxTimer = Math.max(0, this.flightMissFxTimer - dt);

    const warn = st.flightDenied || st.flightRouteMiss || this.flightMissFxTimer > 0;
    const liftColor = warn ? PALETTE.uiWarn : PALETTE.flight;
    (this.thrustShell.material as THREE.MeshBasicMaterial).color.setHex(
      warn ? PALETTE.uiWarn : PALETTE.flightDeep,
      THREE.NoColorSpace,
    );
    this.thrustOuter.setColorAt(1, _fxColor.setHex(liftColor, THREE.NoColorSpace));
    this.thrustOuter.setColorAt(2, _fxColor.setHex(liftColor, THREE.NoColorSpace));
    if (this.thrustOuter.instanceColor) this.thrustOuter.instanceColor.needsUpdate = true;

    const boostPulse = 0.9 + 0.1 * Math.sin(t * 34 + this.id);
    // Surface boost hands off to the twin anti-grav emitters instead of
    // stacking three bright plumes on the launch frame.
    const boostVisual = (this.playerOwned ? this.boostFx : this.boostFx * 1.0 * this.opponentTechniqueFxScale) *
      (1 - this.flightFx * 0.92);
    // A rival's release must survive the chase camera and water contrast. The
    // same pooled emitter is used for the player, but rivals get a restrained
    // readability lift so the real BOOST payout reads as a short stern pulse
    // instead of disappearing behind their hull and wake.
    const opponentReadability = !this.playerOwned ? 1.72 + this.opponentFxScale * 0.72 : 1;
    const boostLen = (0.06 + boostVisual * 4.35 * boostPulse) * opponentReadability;
    const boostY = !this.playerOwned ? 0.34 : 0.2;
    this.setThrustInstance(
      'outer', 0, 0, boostY, -2.64 - boostLen * 0.5, _fxQBoost,
      0.42 * boostVisual * opponentReadability, boostLen,
    );
    this.setThrustInstance(
      'core', 0, 0, boostY, -2.64 - boostLen * 0.42, _fxQBoost,
      0.125 * boostVisual * opponentReadability, boostLen * 0.72,
    );

    const burst = clamp(this.liftBurstTimer / 0.22, 0, 1);
    const pulseStep = Math.floor((t * 13 + this.id * 0.73) % 3);
    const pulse = pulseStep === 0 ? 0.88 : pulseStep === 1 ? 1 : 1.12;
    const missCut = warn ? 0.55 : 1;
    // The emitter is a short energy core. Height is conveyed by the moving
    // rings and footprint below, so flight can never turn it into a solid beam.
    const shellLen = (0.14 + this.flightFx * 1.12 + burst * 0.34) * pulse * missCut;
    const outerLen = (0.1 + this.flightFx * 0.82 + burst * 0.22) * pulse * missCut;
    const coreLen = (0.06 + this.flightFx * 0.48 + burst * 0.12) * pulse * missCut;
    const shellRadius = (0.02 + this.flightFx * 0.35 + burst * 0.09) * missCut;
    const outerRadius = (0.016 + this.flightFx * 0.23 + burst * 0.06) * missCut;
    const coreRadius = (0.01 + this.flightFx * 0.085 + burst * 0.024) * missCut;
    this.flightPlumeLength = shellLen;
    this.flightFlowDeflection = this.airBrakeFx * Math.abs(st.steer);
    this.flightRingActiveCount = 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const dir = _fxFlowDir.set(
        side * 0.15 + st.steer * this.airBrakeFx * 0.32,
        -0.98,
        -0.08 - st.flightPressure * 0.1,
      ).normalize();
      const q = _fxFlowQ.setFromUnitVectors(_fxAxisY, dir);
      this.setThrustInstance(
        'shell', i,
        side * 0.68 + dir.x * shellLen * 0.5,
        0.12 + dir.y * shellLen * 0.5,
        -1.62 + dir.z * shellLen * 0.5,
        q, shellRadius, shellLen,
      );
      this.setThrustInstance(
        'outer', i + 1,
        side * 0.68 + dir.x * outerLen * 0.5,
        0.12 + dir.y * outerLen * 0.5,
        -1.62 + dir.z * outerLen * 0.5,
        q, outerRadius, outerLen,
      );
      this.setThrustInstance(
        'core', i + 1,
        side * 0.68 + dir.x * coreLen * 0.5,
        0.12 + dir.y * coreLen * 0.5,
        -1.62 + dir.z * coreLen * 0.5,
        q, coreRadius, coreLen,
      );

      // Broken travelling arcs shed into the downwash instead of forming a portal tube.
      for (let ring = 0; ring < 6; ring++) {
        const phase = ((t * 1.9 + ring / 6 + i * 0.11) % 1 + 1) % 1;
        const strength = clamp(this.flightFx * (1 - phase * 0.35) + burst * (1 - phase), 0, 1);
        const travel = 0.24 + phase * (1.4 + this.flightFx * 1.2);
        const radius = (0.11 + phase * 0.5) * strength * missCut;
        const spiralAngle = phase * Math.PI * 3.2 + t * 3.4 + i * Math.PI;
        const spiralRadius = Math.sin(phase * Math.PI) * (0.04 + phase * 0.24) * strength;
        _fxRingQ.setFromUnitVectors(_fxAxisZ, dir)
          .multiply(_fxRingSpinQ.setFromAxisAngle(_fxAxisZ, spiralAngle * 0.34));
        this.setFlowRingInstance(
          i * 6 + ring,
          side * 0.68 + dir.x * travel + Math.cos(spiralAngle) * spiralRadius,
          0.12 + dir.y * travel,
          -1.62 + dir.z * travel + Math.sin(spiralAngle) * spiralRadius,
          _fxRingQ,
          radius,
          1 + this.flightFlowDeflection * 0.4,
          1 - this.flightFlowDeflection * 0.22,
        );
        if (radius > 0.01) this.flightRingActiveCount++;
      }
    }

    // S+A/D vector braking: a broad lateral plasma wall on the outside pad.
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const turnAmount = side < 0 ? Math.max(0, -st.steer) : Math.max(0, st.steer);
      const n = this.airBrakeFx * turnAmount;
      _v2.set(side, -0.08, -0.18).normalize();
      _blobQ.setFromUnitVectors(_v1.set(0, 1, 0), _v2);
      const len = n * (2.8 + 0.35 * Math.sin(t * 29 + i));
      this.setThrustInstance('shell', i + 2, side * 0.72 + _v2.x * len * 0.5, 0.2 + _v2.y * len * 0.5,
        -1.45 + _v2.z * len * 0.5, _blobQ, 0.46 * n, len);
      this.setThrustInstance('outer', i + 3, side * 0.72 + _v2.x * len * 0.43, 0.2 + _v2.y * len * 0.43,
        -1.45 + _v2.z * len * 0.43, _blobQ, 0.32 * n, len * 0.86);
      this.setThrustInstance('core', i + 3, side * 0.72 + _v2.x * len * 0.3, 0.2 + _v2.y * len * 0.3,
        -1.45 + _v2.z * len * 0.3, _blobQ, 0.11 * n, len * 0.6);
    }
    this.thrustShell.instanceMatrix.needsUpdate = true;
    this.thrustOuter.instanceMatrix.needsUpdate = true;
    this.thrustCore.instanceMatrix.needsUpdate = true;
    this.thrustRings.instanceMatrix.needsUpdate = true;

    this.trailCd -= dt;
    if (this.trailCd <= 0 && ((this.playerOwned && this.boostFx > 0.25) || this.flightFx > 0.3)) {
      this.trailCd = this.flightFx > 0.3 ? 0.1 : 0.055;
      const pos = this.object.position;
      const pulse = 0.85 + 0.15 * Math.sin(t * 19 + this.id * 2.3);
      if (this.playerOwned && this.boostFx > 0.25) {
        this.trail.emit(
          pos.x - fwdX * 2.85,
          pos.y + 0.2,
          pos.z - fwdZ * 2.85,
          -fwdX * (2.2 + this.boostFx),
          0.25,
          -fwdZ * (2.2 + this.boostFx),
          PALETTE.boost,
          0.15 * pulse,
          0.32,
        );
      }
      if (this.flightFx > 0.3) {
        for (const side of [-1, 1]) {
          const swirl = t * 15 + this.id * 1.7 + (side < 0 ? Math.PI : 0);
          const radial = 0.22 + this.flightFx * 0.18;
          const swirlX = Math.cos(swirl) * radial;
          const swirlZ = Math.sin(swirl) * radial;
          this.trail.emit(
            pos.x + portX * (side * 0.68 + swirlX) - fwdX * (1.62 + swirlZ),
            pos.y - 0.18,
            pos.z + portZ * (side * 0.68 + swirlX) - fwdZ * (1.62 + swirlZ),
            -fwdX * (0.22 + swirlZ) + portX * (side * 0.1 - Math.sin(swirl) * 0.7),
            -0.72 - this.flightFx * 0.38,
            -fwdZ * (0.22 + swirlZ) + portZ * (side * 0.1 - Math.sin(swirl) * 0.7),
            Math.floor(t * 18 + side) % 4 === 0 ? 0x9b7cff : PALETTE.flight,
            0.085 * pulse,
            0.3,
          );
        }
      }
    }
  }

  private updateOpponentDriftBurst(dt: number, _t: number, boostStarted: boolean): void {
    if (this.playerOwned) return;
    // The readable pulse is now the same stern emitter used by the player.
    // Keep a short debug edge for harnesses, but let the actual BOOST envelope
    // own the lifetime so a held drift remains completely clean.
    if (boostStarted) this.driftBurstTimer = 0.18;
    this.driftBurstTimer = Math.max(0, this.driftBurstTimer - dt);
  }

  private setThrustInstance(
    layer: 'shell' | 'outer' | 'core',
    index: number,
    x: number,
    y: number,
    z: number,
    quaternion: THREE.Quaternion,
    radius: number,
    length: number,
  ): void {
    const mesh = layer === 'shell' ? this.thrustShell : layer === 'core' ? this.thrustCore : this.thrustOuter;
    const visible = radius > 0.001 && length > 0.001;
    _fxPos.set(x, y, z);
    _fxScale.set(visible ? radius : 0, visible ? length : 0, visible ? radius : 0);
    _fxMatrix.compose(_fxPos, quaternion, _fxScale);
    mesh.setMatrixAt(index, _fxMatrix);
  }

  private setFlowRingInstance(
    index: number,
    x: number,
    y: number,
    z: number,
    quaternion: THREE.Quaternion,
    radius: number,
    stretchX: number,
    stretchY: number,
  ): void {
    const visible = radius > 0.001;
    _fxPos.set(x, y, z);
    _fxScale.set(visible ? radius * stretchX : 0, visible ? radius * stretchY : 0, visible ? radius : 0);
    _fxMatrix.compose(_fxPos, quaternion, _fxScale);
    this.thrustRings.setMatrixAt(index, _fxMatrix);
  }

  /** Visual-only active aero: readable arcade poses driven by the real control state. */
  private updateDynamicFlaps(
    dt: number,
    t: number,
    vF: number,
    vL: number,
    steer: number,
    landingImpact: number,
    surfaceDrift: boolean,
    inFlight: boolean,
    boosting: boolean,
  ): void {
    const speedRatio = clamp(Math.abs(vF) / 42, 0, 1.4);
    const aeroSpeedPitch = -0.032 * (speedRatio * speedRatio);

    // Keep the low-amplitude cruise trim, but reserve the large silhouette
    // change for drift and flight braking so the wing communicates an action.
    const pitchTrim = -0.16 * this.pitch - 0.035 * this.pitchVel;

    const turnIntensity = clamp(
      steer * 0.82 - (this.roll / TUNING.bankMax) * 0.12 + (vL / 16) * 0.12,
      -1,
      1,
    );
    const differentialGain = inFlight
      ? 0.12 + 0.17 * this.airBrakeFx
      : surfaceDrift ? 0.23 : 0.065;
    const diffElevonL = -differentialGain * turnIntensity;
    const diffElevonR = +differentialGain * turnIntensity;

    const driftFlare = surfaceDrift ? 0.255 : 0;
    const flightTrim = inFlight ? 0.075 * (boosting ? 1.12 : 1) : 0;
    const brakeFlare = 0.43 * this.airBrakeFx;
    const modePitch = driftFlare + flightTrim + brakeFlare;

    const shockG = clamp(landingImpact * 0.028, 0, 0.105);
    const inertialPitch = -shockG;

    const flutterFreq = 16 + speedRatio * 8;
    const flutterScale = (surfaceDrift || this.airBrakeFx > 0.05 ? 0.008 : 0.004) *
      (0.25 + 0.75 * speedRatio);
    const windFlutterL = flutterScale * Math.sin(t * flutterFreq + this.id * 1.7);
    const windFlutterR = flutterScale * Math.sin(t * flutterFreq + this.id * 1.7 + 1.1);

    const targetPitchL = clamp(
      aeroSpeedPitch + pitchTrim + diffElevonL + modePitch + inertialPitch + windFlutterL,
      -0.28,
      0.68,
    );
    const targetPitchR = clamp(
      aeroSpeedPitch + pitchTrim + diffElevonR + modePitch + inertialPitch + windFlutterR,
      -0.28,
      0.68,
    );
    this.flapTargetPitchL = targetPitchL;
    this.flapTargetPitchR = targetPitchR;
    this.flapTurnIntensity = turnIntensity;

    const targetRollL = clamp(+0.09 * targetPitchL - 0.065 * turnIntensity, -0.13, 0.13);
    const targetRollR = clamp(-0.09 * targetPitchR - 0.065 * turnIntensity, -0.13, 0.13);

    // A deliberately under-damped response makes press, steering reversal,
    // and release readable at chase-camera scale without becoming loose.
    const omega = 10.5;
    const zeta = 0.48;
    const fSpring = omega * omega;
    const fDamp = 2 * zeta * omega;

    const accelPitchL = fSpring * (targetPitchL - this.flapPitchL) - fDamp * this.flapPitchVelL;
    this.flapPitchVelL += accelPitchL * dt;
    this.flapPitchL += this.flapPitchVelL * dt;

    const accelPitchR = fSpring * (targetPitchR - this.flapPitchR) - fDamp * this.flapPitchVelR;
    this.flapPitchVelR += accelPitchR * dt;
    this.flapPitchR += this.flapPitchVelR * dt;

    const accelRollL = fSpring * (targetRollL - this.flapRollL) - fDamp * this.flapRollVelL;
    this.flapRollVelL += accelRollL * dt;
    this.flapRollL += this.flapRollVelL * dt;

    const accelRollR = fSpring * (targetRollR - this.flapRollR) - fDamp * this.flapRollVelR;
    this.flapRollVelR += accelRollR * dt;
    this.flapRollR += this.flapRollVelR * dt;

    this.flapNodeL.rotation.x = this.flapPitchL;
    this.flapNodeL.rotation.z = this.flapRollL;

    this.flapNodeR.rotation.x = this.flapPitchR;
    this.flapNodeR.rotation.z = this.flapRollR;
  }

  beginFlightRouteAttempt(routeIndex: number, routeCursor: number, targetSpeed: number, targetClearance?: number): void {
    const st = this.state;
    if (st.flightRouteState !== 'idle' || routeCursor !== st.flightRouteCursor || routeIndex < 0) return;
    st.flightRouteState = 'active';
    st.flightRouteIndex = routeIndex;
    this.flightTargetSpeed = clamp(targetSpeed, TUNING.topSpeed, TUNING.flightHardCap);
    this.flightTargetClearance = targetClearance !== undefined ? targetClearance : TUNING.flightClearance;
    st.flightRouteFailReason = 'none';
    st.flightFailure = null;
    st.flightGateProgress = 0;
    this.flightPenaltyApplied = false;
  }

  applyFlightGatePass(gateIndex: number): void {
    const st = this.state;
    if (st.flightRouteState !== 'active' || gateIndex !== st.flightGateProgress) return;
    st.flightGateProgress = gateIndex + 1;
  }

  completeFlightRoute(routeIndex: number, routeCursor: number): void {
    const st = this.state;
    if (st.flightRouteState !== 'active' || st.flightRouteIndex !== routeIndex || routeCursor !== st.flightRouteCursor) return;
    st.flightRouteState = 'passed';
    st.flightsCleared++;
    st.flightRouteCursor++;
    // A clean third gate is the authored end of the maneuver. Start the same
    // smooth landing envelope immediately instead of leaving a fast racer
    // hovering for the unused portion of the ten-second safety window.
    const descendAt = this.flightDescendAt();
    this.flightElapsed = Math.max(this.flightElapsed, descendAt);
    st.flightExtensionReady = false;
  }

  settleFlightRoute(): void {
    const st = this.state;
    if (st.flightRouteState !== 'passed' || st.flightPhase !== 'surface') return;
    st.flightRouteState = 'idle';
    st.flightRouteIndex = -1;
    st.flightGateProgress = 0;
    st.flightRouteFailReason = 'none';
    st.flightFailure = null;
  }

  recoverFailedFlightRoute(): void {
    const st = this.state;
    if (st.flightRouteState !== 'failed' || st.flightPhase !== 'surface') return;
    st.flightRouteCursor++;
    st.flightRouteState = 'idle';
    st.flightRouteIndex = -1;
    st.flightRouteFailReason = 'none';
    st.flightFailure = null;
    st.flightGateProgress = 0;
    this.flightPenaltyApplied = false;
  }

  /** Capture one stable miss; AI boats retain the physical slowdown while the player terminates. */
  applyFlightRouteMiss(failure: FlightFailureSnapshot): void {
    const st = this.state;
    if (st.flightRouteState !== 'active' || this.flightPenaltyApplied) return;
    this.flightPenaltyApplied = true;
    this.flightMissFxTimer = 0.4;
    this.velX *= TUNING.flightMissSpeedMul;
    this.velZ *= TUNING.flightMissSpeedMul;
    st.flightPenaltyRemaining = TUNING.flightMissDriveTime;
    st.flightRouteState = 'failed';
    st.flightRouteIndex = failure.routeSlot;
    st.flightRouteFailReason = failure.reason;
    st.flightFailure = failure;
    if (st.flightPhase !== 'surface') {
      const descentAt = this.flightDescendAt();
      this.flightElapsed = Math.max(this.flightElapsed, descentAt);
    }
    st.flightExtensionReady = false;
    st.flightRouteMiss = true;
  }

  setCorridorDistress(level: number, pushX: number, pushZ: number): void {
    this.corridorDistress = clamp(level, 0, 1);
    this.corridorPushX = pushX;
    this.corridorPushZ = pushZ;
  }

  setDriver(color: number, handling: DriverHandling): void {
    this.hullMaterial.uniforms.uColor.value.setHex(color, THREE.NoColorSpace);
    this.handling = {
      acceleration: clamp(handling.acceleration, 0.94, 1.06),
      steering: clamp(handling.steering, 0.94, 1.06),
      driftCharge: clamp(handling.driftCharge, 0.94, 1.06),
      airControl: clamp(handling.airControl, 0.94, 1.06),
    };
  }

  /** Local-team ownership changes presentation/pace policy, never the physics model. */
  setPlayerOwned(owned: boolean): void {
    this.playerOwned = owned;
    this.wake.setVisualScale(owned ? 1 : TUNING.opponentWakeScale);
    if (owned) {
      this.opponentFxScale = 1;
      this.opponentTechniqueFxScale = 1;
    }
  }

  /** Restore only authored flight progress after a team checkpoint teleport. */
  restoreFlightCheckpoint(routeCursor: number, charges = 0): void {
    const cursor = Math.max(0, Math.floor(routeCursor));
    const st = this.state;
    this.wasDrifting = false;
    this.boostTimer = 0;
    this.boostTotal = 0;
    st.boostCharge = 0;
    st.driftBankProgress = 0;
    st.driftReleaseReady = false;
    st.drifting = false;
    st.boosting = false;
    st.boostRemaining = 0;
    st.flightCharges = clamp(Math.floor(charges), 0, MAX_FLIGHT_CHARGES);
    st.flightsCleared = cursor;
    st.flightRouteCursor = cursor;
    st.flightRouteIndex = -1;
    st.flightRouteState = 'idle';
    st.flightRouteFailReason = 'none';
    st.flightFailure = null;
    st.flightGateProgress = 0;
    st.flightPenaltyRemaining = 0;
    this.flightPenaltyApplied = false;
  }

  grantFlightCharge(): boolean {
    if (this.state.flightCharges >= MAX_FLIGHT_CHARGES) return false;
    this.state.flightCharges++;
    return true;
  }

  /** Convert an over-cap technique pickup into a readable, discrete boost. */
  activateTechniqueBoost(): void {
    const duration = 0.85;
    const wasBoosting = this.boostTimer > 0;
    this.boostTimer = Math.min(2.4, this.boostTimer + duration);
    this.boostTotal = wasBoosting
      ? Math.min(2.4, this.boostTotal + duration)
      : this.boostTimer;
  }

  /** Main-thread visual LOD; has no effect on physics or AI input. */
  setOpponentEffectDistance(distance: number): void {
    this.opponentFxScale = this.playerOwned ? 1 : clamp(1 - (distance - 24) / 150, 0.3, 1);
    this.opponentTechniqueFxScale = this.playerOwned ? 1 : clamp(1 - (distance - 55) / 95, 0, 1);
  }

  /** Keep the authored READY/countdown presentation seated on the moving swell.
   * Physics is intentionally frozen before GO, so this updates only the visual
   * hull origin; the first racing fixed step resumes full buoyancy normally.
   */
  syncSurfacePresentation(t: number): void {
    const pos = this.object.position;
    const fwdX = Math.sin(this.heading);
    const fwdZ = Math.cos(this.heading);
    const portX = Math.cos(this.heading);
    const portZ = -Math.sin(this.heading);
    const hBowL = waterHeight(pos.x + portX * TUNING.sampleLat + fwdX * TUNING.sampleLong,
      pos.z + portZ * TUNING.sampleLat + fwdZ * TUNING.sampleLong, t);
    const hBowR = waterHeight(pos.x - portX * TUNING.sampleLat + fwdX * TUNING.sampleLong,
      pos.z - portZ * TUNING.sampleLat + fwdZ * TUNING.sampleLong, t);
    const hMidL = waterHeight(pos.x + portX * TUNING.sampleLat, pos.z + portZ * TUNING.sampleLat, t);
    const hMidR = waterHeight(pos.x - portX * TUNING.sampleLat, pos.z - portZ * TUNING.sampleLat, t);
    const hSt = waterHeight(pos.x - fwdX * TUNING.sampleLong, pos.z - fwdZ * TUNING.sampleLong, t);
    const surfaceY = (hBowL + hBowR + hMidL + hMidR + hSt) / 5;
    this.presentation.position.y = surfaceY - TUNING.draft - pos.y;

    // Gentle aerodynamic swell breathing when idling before start
    const idleBreathingL = 0.014 * Math.sin(t * 3.4 + this.id * 1.2);
    const idleBreathingR = 0.014 * Math.sin(t * 3.4 + this.id * 1.2 + 0.6);
    this.flapNodeL.rotation.x = idleBreathingL;
    this.flapNodeR.rotation.x = idleBreathingR;
    this.flapNodeL.rotation.z = 0;
    this.flapNodeR.rotation.z = 0;
  }

  /** Deterministic harness evidence for AI technique visibility. */
  debugDriftEffects(): {
    burstScale: number;
    releaseBeats: number;
    boosting: boolean;
    phase: 'idle' | 'holding' | 'charged' | 'release';
    holdStarts: number;
    burstStrength: number;
    burstActive: boolean;
    wakeScale: number;
  } {
    const burstStrength = !this.playerOwned && this.state.boosting
      ? this.boostFx * 1.0 * this.opponentTechniqueFxScale
      : 0;
    return {
      burstScale: this.opponentTechniqueFxScale,
      releaseBeats: this.opponentReleaseBeats,
      boosting: this.state.boosting,
      phase: this.driftBurstTimer > 0
        ? 'release'
        : this.state.drifting
        ? (this.state.driftReleaseReady ? 'charged' : 'holding')
        : 'idle',
      holdStarts: this.driftHoldStarts,
      burstStrength,
      burstActive: !this.playerOwned && this.state.boosting && !this.state.drifting && burstStrength > 0.05,
      wakeScale: this.playerOwned ? 1 : TUNING.opponentWakeScale,
    };
  }

  /** Deterministic evidence that the selection radar matches live physics. */
  debugDriverHandling(): DriverHandling {
    return { ...this.handling };
  }

  debugFlightEffects(): { rings: number; plumeLength: number; deflection: number } {
    return {
      rings: this.flightRingActiveCount,
      plumeLength: this.flightPlumeLength,
      deflection: this.flightFlowDeflection,
    };
  }

  /** Deterministic evidence for the real-input active-aero response. */
  flapDebug(): {
    leftPitch: number;
    rightPitch: number;
    leftVelocity: number;
    rightVelocity: number;
    leftTarget: number;
    rightTarget: number;
    commonPitch: number;
    differential: number;
    turnIntensity: number;
    airBrake: number;
  } {
    return {
      leftPitch: this.flapPitchL,
      rightPitch: this.flapPitchR,
      leftVelocity: this.flapPitchVelL,
      rightVelocity: this.flapPitchVelR,
      leftTarget: this.flapTargetPitchL,
      rightTarget: this.flapTargetPitchR,
      commonPitch: (this.flapPitchL + this.flapPitchR) * 0.5,
      differential: this.flapPitchL - this.flapPitchR,
      turnIntensity: this.flapTurnIntensity,
      airBrake: this.airBrakeFx,
    };
  }

  /** Deterministic tuning evidence for the release harness. */
  debugFlightEnvelope(): {
    descendAt: number;
    total: number;
    extension: number;
    extendedDescendAt: number;
    extendedTotal: number;
  } {
    const descendAt = TUNING.flightSpool + TUNING.flightAscend + TUNING.flightCruise;
    return {
      descendAt,
      total: descendAt + TUNING.flightDescend,
      extension: TUNING.flightExtension,
      extendedDescendAt: descendAt + TUNING.flightExtension,
      extendedTotal: descendAt + TUNING.flightExtension + TUNING.flightDescend,
    };
  }

  private flightDescendAt(): number {
    return TUNING.flightSpool + TUNING.flightAscend + TUNING.flightCruise + this.flightExtensionTime;
  }

  private accrueDriftCharge(dt: number, speedAbs: number): void {
    if (speedAbs <= TUNING.driftMinSpeed) return;
    this.state.boostCharge = Math.min(
      1,
      this.state.boostCharge + dt * this.handling.driftCharge / TUNING.driftChargeTime,
    );
  }

  private canExtendFlight(): boolean {
    const st = this.state;
    return st.flightCharges > 0 &&
      !st.flightExtensionUsed &&
      (st.flightPhase === 'cruise' || st.flightPhase === 'descending') &&
      st.flightRouteState !== 'passed' &&
      st.flightRouteState !== 'failed';
  }

  private sampleWakeProbe(
    wakeFields: readonly IWake[],
    x: number,
    z: number,
    t: number,
    out: THREE.Vector3,
  ): void {
    let lift = 0;
    let lateral = 0;
    let strength = 0;
    for (const field of wakeFields) {
      if (field === this.wake) continue;
      field.sampleInteraction(x, z, t, _wakeSample);
      lift = Math.min(0.42, lift + _wakeSample.x);
      lateral += _wakeSample.y * _wakeSample.z;
      strength = Math.min(1, strength + _wakeSample.z);
    }
    out.set(lift, clamp(lateral, -1, 1), strength);
  }

  private sampleWakeInteraction(
    wakeFields: readonly IWake[],
    t: number,
    fwdX: number,
    fwdZ: number,
    portX: number,
    portZ: number,
  ): void {
    const previous = this.wakeInteractionStrength;
    this.wakePreviousStrength = previous;
    this.wakeBowPortLift = 0;
    this.wakeBowStarboardLift = 0;
    this.wakeMidPortLift = 0;
    this.wakeMidStarboardLift = 0;
    this.wakeSternLift = 0;
    this.wakeInteractionStrength = 0;
    this.wakeInteractionLift = 0;
    this.wakeInteractionLateral = 0;
    if (wakeFields.length < 2 || this.state.flightPhase !== 'surface' || this.state.airborne) return;

    const p = this.object.position;
    const L = TUNING.sampleLong;
    const W = TUNING.sampleLat;
    this.sampleWakeProbe(wakeFields, p.x + fwdX * L + portX * W, p.z + fwdZ * L + portZ * W, t, _wakeSample);
    this.wakeBowPortLift = _wakeSample.x;
    this.wakeInteractionStrength = Math.max(this.wakeInteractionStrength, _wakeSample.z);
    this.sampleWakeProbe(wakeFields, p.x + fwdX * L - portX * W, p.z + fwdZ * L - portZ * W, t, _wakeSample);
    this.wakeBowStarboardLift = _wakeSample.x;
    this.wakeInteractionStrength = Math.max(this.wakeInteractionStrength, _wakeSample.z);
    this.sampleWakeProbe(wakeFields, p.x + portX * W, p.z + portZ * W, t, _wakeSample);
    this.wakeMidPortLift = _wakeSample.x;
    this.wakeInteractionStrength = Math.max(this.wakeInteractionStrength, _wakeSample.z);
    this.sampleWakeProbe(wakeFields, p.x - portX * W, p.z - portZ * W, t, _wakeSample);
    this.wakeMidStarboardLift = _wakeSample.x;
    this.wakeInteractionStrength = Math.max(this.wakeInteractionStrength, _wakeSample.z);
    this.sampleWakeProbe(wakeFields, p.x - fwdX * L, p.z - fwdZ * L, t, _wakeSample);
    this.wakeSternLift = _wakeSample.x;
    this.wakeInteractionStrength = Math.max(this.wakeInteractionStrength, _wakeSample.z);
    this.sampleWakeProbe(wakeFields, p.x, p.z, t, _wakeSample);
    this.wakeInteractionLift = (_wakeSample.x + this.wakeBowPortLift + this.wakeBowStarboardLift +
      this.wakeMidPortLift + this.wakeMidStarboardLift + this.wakeSternLift) / 6;
    this.wakeInteractionLateral = _wakeSample.y;
  }

  debugWaterInteraction(): HullWaterInteraction {
    return {
      bowPort: this.wakeBowPortLift,
      bowStarboard: this.wakeBowStarboardLift,
      midPort: this.wakeMidPortLift,
      midStarboard: this.wakeMidStarboardLift,
      stern: this.wakeSternLift,
      lateral: this.wakeInteractionLateral,
      strength: this.wakeInteractionStrength,
    };
  }

  landingDebug(): {
    event: number;
    roll: number;
    lateralG: number;
    lateralBias: number;
  } {
    return {
      event: this.lastLandingDebugEvent,
      roll: this.lastLandingRoll,
      lateralG: this.lastLandingLateralG,
      lateralBias: this.lastLandingBias,
    };
  }

  collisionVelocity(out: THREE.Vector2): THREE.Vector2 {
    return out.set(this.velX, this.velZ);
  }

  /** A powered co-op station behaves like a damped mooring, not a teleport. */
  applyMooringAssist(targetX: number, targetZ: number, dt: number, strength = 1): void {
    if (this.state.flightPhase !== 'surface') return;
    const pull = Math.max(0, strength);
    const spring = 2.2 * pull;
    const damping = Math.exp(-8.5 * pull * dt);
    this.velX = (this.velX + (targetX - this.object.position.x) * spring * dt) * damping;
    this.velZ = (this.velZ + (targetZ - this.object.position.z) * spring * dt) * damping;
    this.yawRate *= Math.exp(-6 * pull * dt);
    this.state.speed = this.velX * Math.sin(this.heading) + this.velZ * Math.cos(this.heading);
  }

  applyCollisionResponse(correctionX: number, correctionZ: number, impulseX: number, impulseZ: number): void {
    const correctionLength = Math.hypot(correctionX, correctionZ);
    if (correctionLength > 0.4) {
      const scale = 0.4 / correctionLength;
      correctionX *= scale;
      correctionZ *= scale;
    }
    this.object.position.x += correctionX;
    this.object.position.z += correctionZ;
    this.velX += impulseX;
    this.velZ += impulseZ;
    const speed = Math.hypot(this.velX, this.velZ);
    if (speed > TUNING.flightHardCap) {
      const scale = TUNING.flightHardCap / speed;
      this.velX *= scale;
      this.velZ *= scale;
    }
    this.yawRate = clamp(this.yawRate + (impulseX * Math.cos(this.heading) - impulseZ * Math.sin(this.heading)) * 0.018, -2.4, 2.4);
  }

  applyScudHit(impulseX: number, impulseZ: number, verticalPop = 8.5): void {
    this.vy = verticalPop;
    this.object.position.y += 0.35;
    this.state.airborne = true;
    this.tumbleSpinTimer = 1.35;
    this.tumbleSpinTotal = 1.35;
    this.velX += impulseX;
    this.velZ += impulseZ;
    this.yawRate = 0;
  }

  /** Deterministic collision-harness hook. Gameplay never calls this method. */
  setCollisionTestMotion(x: number, z: number, heading: number, velX: number, velZ: number, y = 0): void {
    this.object.position.set(x, y, z);
    this.heading = heading;
    this.velX = velX;
    this.velZ = velZ;
    this.state.heading = heading;
    this.state.speed = velX * Math.sin(heading) + velZ * Math.cos(heading);
    _euler.set(0, heading, 0, 'YXZ');
    this.object.quaternion.setFromEuler(_euler);
  }

  private updateFlight(dt: number, surfaceY: number, surfaceTargetY: number): number {
    const st = this.state;
    const ascendAt = TUNING.flightSpool;
    const cruiseAt = ascendAt + TUNING.flightAscend;
    const descendAt = this.flightDescendAt();
    const total = descendAt + TUNING.flightDescend;

    const firstFlightFrame = this.flightElapsed === 0;
    if (firstFlightFrame) {
      this.flightStartClearance = this.object.position.y - surfaceY;
      this.flightTargetVy = 0;
    }
    this.flightElapsed += dt;

    let phase: FlightPhase;
    let targetClearance: number;
    let thrust: number;
    if (this.flightElapsed < ascendAt) {
      phase = 'spool';
      const p = clamp(this.flightElapsed / TUNING.flightSpool, 0, 1);
      targetClearance = this.flightStartClearance;
      thrust = p;
    } else if (this.flightElapsed < cruiseAt) {
      phase = 'ascending';
      const p = smooth01((this.flightElapsed - ascendAt) / TUNING.flightAscend);
      targetClearance = this.flightStartClearance + (this.flightTargetClearance - this.flightStartClearance) * p;
      thrust = 1;
    } else if (this.flightElapsed < descendAt) {
      phase = 'cruise';
      targetClearance = this.flightTargetClearance;
      thrust = 0.72;
    } else {
      phase = 'descending';
      const p = smooth01((this.flightElapsed - descendAt) / TUNING.flightDescend);
      const landingTarget = -TUNING.draft - TUNING.flightLandingLead;
      targetClearance = this.flightTargetClearance + (landingTarget - this.flightTargetClearance) * p;
      thrust = 0.72 * (1 - p);
    }

    // Deep corridor red reads as a stall: lift bleeds off and the craft
    // starts its fall before the fail verdict arrives.
    if (phase === 'ascending' || phase === 'cruise') {
      targetClearance -= 2.8 * smooth01((this.corridorDistress - 0.45) / 0.55);
    }

    const desiredY = surfaceY + targetClearance;
    if (firstFlightFrame) this.flightDesiredYPrev = desiredY;
    const rawTargetVy = clamp((desiredY - this.flightDesiredYPrev) / Math.max(1e-4, dt), -42, 42);
    this.flightTargetVy += (rawTargetVy - this.flightTargetVy) * (1 - Math.exp(-18 * dt));
    this.flightDesiredYPrev = desiredY;
    const w = TUNING.flightOmega;
    // Track the moving wave reference as well as its position. Without this
    // feed-forward term, a fast boat chases the previous crest and its visible
    // clearance can swing by almost a metre even during controlled cruise.
    const ay = clamp(
      w * w * (desiredY - this.object.position.y) + 2 * w * (this.flightTargetVy - this.vy),
      -TUNING.flightAccelMax,
      TUNING.flightAccelMax,
    );
    this.vy += ay * dt;
    this.object.position.y += this.vy * dt;
    st.flightPhase = phase;
    st.flightRemaining = clamp(1 - this.flightElapsed / total, 0, 1);
    st.flightThrust = thrust;
    st.airborne = false;
    st.airTime = 0;

    let impact = 0;
    // Contact belongs to the first fixed step inside the live float plane, but
    // the authored flight controller keeps ownership until its original end
    // time. This prevents underwater penetration without advancing the surface
    // driving schedule and changing race pacing.
    if (phase === 'descending' && this.object.position.y <= surfaceTargetY) {
      if (!this.flightWaterContact) {
        impact = Math.max(0, -this.vy);
        this.flightWaterContact = true;
        st.landImpulse = impact;
      }
      this.object.position.y = surfaceTargetY;
      this.vy = 0;
    }

    const landingTimedOut = this.flightElapsed >= total + 0.3;
    if (this.flightElapsed >= total && (this.flightWaterContact ||
        this.object.position.y <= surfaceTargetY + 0.25 || landingTimedOut)) {
      this.unloadTime = 0;
      this.flightElapsed = 0;
      this.flightExtensionTime = 0;
      this.flightTargetVy = 0;
      this.flightWaterContact = false;
      st.flightPhase = 'surface';
      st.flightRemaining = 0;
      st.flightExtensionReady = false;
      st.flightExtensionUsed = false;
      st.flightThrust = 0;
      this.corridorDistress = 0;
    }
    return impact;
  }

  private emitLandingImpact(
    surfaceY: number,
    sternY: number,
    fwdX: number,
    fwdZ: number,
    rightX: number,
    rightZ: number,
    impact: number,
    speedAbs: number,
    lateralBias = 0,
  ): void {
    const pos = this.object.position;
    // Lift the shared splash volume above the sampled plane so the ocean depth
    // pass cannot swallow the first impact frame on a moving crest.
    _v2.set(pos.x - fwdX * 0.28, surfaceY + 0.14, pos.z - fwdZ * 0.28);
    _v1.set(fwdX, 0, fwdZ);
    _v3.set(rightX, 0, rightZ);
    this.spray.landing(
      _v2,
      _v1,
      _v3,
      impact,
      speedAbs,
      this.playerOwned ? 1 : this.opponentFxScale,
      this.id,
      lateralBias,
    );
    _v2.set(pos.x - fwdX * 2.3, sternY + 0.05, pos.z - fwdZ * 2.3);
    this.wake.push(_v2, fwdX, fwdZ, 1);
  }

  teleport(x: number, z: number, heading: number): void {
    this.heading = heading;
    this.yawRate = 0;
    this.velX = 0;
    this.velZ = 0;
    this.vy = 0;
    this.unloadTime = 0;
    this.pitch = 0;
    this.pitchVel = 0;
    this.roll = 0;
    this.rollVel = 0;
    this.flapPitchL = 0;
    this.flapPitchVelL = 0;
    this.flapPitchR = 0;
    this.flapPitchVelR = 0;
    this.flapRollL = 0;
    this.flapRollVelL = 0;
    this.flapRollR = 0;
    this.flapRollVelR = 0;
    this.flapTargetPitchL = 0;
    this.flapTargetPitchR = 0;
    this.flapTurnIntensity = 0;
    this.flapNodeL.rotation.set(0, 0, 0);
    this.flapNodeR.rotation.set(0, 0, 0);
    this.lastLandingDebugEvent = 0;
    this.lastLandingRoll = 0;
    this.lastLandingLateralG = 0;
    this.lastLandingBias = 0;
    this.boostTimer = 0;
    this.boostTotal = 0;
    this.wasDrifting = false;
    this.flightElapsed = 0;
    this.flightExtensionTime = 0;
    this.flightWaterContact = false;
    this.flightStartClearance = 0;
    this.flightDesiredYPrev = 0;
    this.flightTargetVy = 0;
    this.flightPenaltyApplied = false;
    this.prevSpeed = 0;
    this.lateralG = 0;
    this.cruiseSprayCd = 0;
    this.turnSprayCd = 0;
    this.boostSprayCd = 0;
    this.trailCd = 0;
    this.driftTrailCd = 0;
    this.wakeSprayCd = 0;
    this.landingVisualCooldown = 0;
    this.wakeInteractionStrength = 0;
    this.wakeInteractionLift = 0;
    this.wakeInteractionLateral = 0;
    this.wakePreviousStrength = 0;
    this.wakeBowPortLift = 0;
    this.wakeBowStarboardLift = 0;
    this.wakeMidPortLift = 0;
    this.wakeMidStarboardLift = 0;
    this.wakeSternLift = 0;
    this.opponentBoostWasActive = false;
    this.opponentReleaseBeats = 0;
    this.driftHoldStarts = 0;
    this.driftBurstTimer = 0;
    this.boostFx = 0;
    this.flightFx = 0;
    this.liftBurstTimer = 0;
    this.liftSplashPending = false;
    this.flightMissFxTimer = 0;
    this.airBrakeFx = 0;
    this.corridorDistress = 0;
    this.corridorPushX = 0;
    this.corridorPushZ = 0;
    this.flightTargetSpeed = 42;
    this.flightRingActiveCount = 0;
    this.flightPlumeLength = 0;
    this.flightFlowDeflection = 0;

    const st = this.state;
    st.boostCharge = 0;
    st.driftBankProgress = 0;
    st.driftReleaseReady = false;
    st.boostRemaining = 0;
    st.flightCharges = 0;
    st.flightPhase = 'surface';
    st.flightRemaining = 0;
    st.flightExtensionReady = false;
    st.flightExtensionUsed = false;
    st.flightExtended = false;
    st.flightClearance = -TUNING.draft;
    st.flightThrust = 0;
    st.flightAirBrake = 0;
    st.flightsCleared = 0;
    st.flightRouteCursor = 0;
    st.flightRouteIndex = -1;
    st.flightPressure = 0;
    st.flightDenied = false;
    st.flightRouteMiss = false;
    st.flightRouteState = 'idle';
    st.flightRouteFailReason = 'none';
    st.flightFailure = null;
    st.flightGateProgress = 0;
    st.flightPenaltyRemaining = 0;
    st.airborne = false;
    st.airTime = 0;
    st.landImpulse = 0;
    st.speed = 0;
    st.rpm = 0;
    st.throttle = 0;
    st.steer = 0;
    st.drifting = false;
    st.boosting = false;
    st.lateralG = 0;
    st.longG = 0;
    st.heading = heading;

    this.object.position.set(x, waterHeight(x, z, this.lastT) - TUNING.draft, z);
    _euler.set(0, heading, 0, 'YXZ');
    this.object.quaternion.setFromEuler(_euler);
  }
}
