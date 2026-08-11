/**
 * boat.ts — procedural hard-chine race boat + arcade planing physics.
 *
 * Visuals: a ~5.2 m planing hull lofted from hand-placed cross-sections
 * (pointed V bow, flared sides, chine flats, color-wrapped deck with an ink
 * panel line, cockpit + coaming, side sponsons, faired-in jet pump, spoiler),
 * flat-shaded for the toon ramp and outlined once via cel/outline. Zero
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
import { LAYER_ENERGY, markInk } from '../contracts';
import type { BoatInput, BoatState, FlightFailureSnapshot, FlightPhase, IBoat, IJetTrail, IWake, ISpray } from '../contracts';
import { PALETTE } from '../core/palette';
import { waterHeight, waterNormalInto } from '../water/waves';
import { createToonMaterial } from '../cel/toonMaterial';
import { addOutline } from '../cel/outline';

export interface BoatOptions {
  id: number;
  color: number;
  wake: IWake;
  spray: ISpray;
  trail: IJetTrail;
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
  driftGripMul: 0.45,    // lateral grip × this while drifting (−55%)
  driftYawDampMul: 0.5,  // yaw damping × this while drifting (looser rotation)
  driftScrub: 0.1,       // 1/s extra forward speed scrub while drifting (slight — not a brake)
  driftMinSpeed: 12,     // m/s — below this, drifting builds no charge
  driftChargeTime: 1.2,  // s of held drift for a full 0→1 charge
  boostReleaseMin: 0.35, // minimum charge that pays out on release
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

  // -- earned anti-grav flight --
  flightSpool: 0.12,
  flightAscend: 0.48,
  flightCruise: 8.65,
  flightDescend: 0.75,
  flightClearance: 4.5,  // hull-root height above the live mean water surface
  flightLandingLead: 0.45, // counter moving-wave lag so the landing envelope seats cleanly
  flightOmega: 9,        // critically damped vertical target tracking
  flightAccelMax: 54,    // m/s², keeps a late launch from snapping vertically
  flightDriveAccel: 22,
  flightDriveGain: 3.2,
  flightHardCap: 50,
  flightDescentSpeed: 36,
  flightTargetSpeeds: [42, 46, 48] as readonly number[],
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
  turnSprayG: 6,         // |lateralG| that starts leeward-chine spray
  turnSprayPeriod: 0.09, // s between chine spray bursts
  boostSprayPeriod: 0.08,// s between stern spray bursts while boosting
  slamSprayPer: 2.5,     // spray particles per m/s of landing impact
  slamSprayMax: 36,
} as const;

// -------------------------------------------------- module-scope temps ----
// Zero per-frame allocations: every update() scratches through these.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _euler = new THREE.Euler();
const _blobQ = new THREE.Quaternion();
const _fxMatrix = new THREE.Matrix4();
const _fxPos = new THREE.Vector3();
const _fxScale = new THREE.Vector3();
const _fxQBoost = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
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
}

function buildThrustVisual(): ThrustVisual {
  const geo = new THREE.ConeGeometry(1, 1, 12, 1, true);
  const shellMat = new THREE.MeshBasicMaterial({
    color: PALETTE.flightDeep,
    transparent: true,
    opacity: 0.82,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const outerMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.52,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const coreMat = new THREE.MeshBasicMaterial({
    color: PALETTE.foam,
    transparent: true,
    opacity: 0.58,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const shell = new THREE.InstancedMesh(geo, shellMat, 4);
  const outer = new THREE.InstancedMesh(geo, outerMat, 5);
  const core = new THREE.InstancedMesh(geo, coreMat, 5);
  shell.name = 'thrust-shell';
  outer.name = 'thrust-outer';
  core.name = 'thrust-core';
  shell.renderOrder = 7;
  outer.renderOrder = 8;
  core.renderOrder = 9;
  shell.frustumCulled = false;
  outer.frustumCulled = false;
  core.frustumCulled = false;
  shell.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  outer.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  core.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
  shell.instanceMatrix.needsUpdate = true;
  outer.instanceMatrix.needsUpdate = true;
  core.instanceMatrix.needsUpdate = true;
  if (outer.instanceColor) outer.instanceColor.needsUpdate = true;
  outer.layers.enable(LAYER_ENERGY);
  core.layers.enable(LAYER_ENERGY);
  return { shell, outer, core };
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
function buildDeckStripeGeometry(): THREE.BufferGeometry {
  const stations = HULL_TABLE.filter((row) => row[0] <= 2.3 && row[0] >= 0.0).map((row): LoftStation => {
    const [z, , , , , sy] = row;
    return {
      z,
      pts: [
        [0.09, sy + DECK_CROWN + 0.008],
        [-0.09, sy + DECK_CROWN + 0.008],
      ],
    };
  });
  const pos: number[] = [];
  loftInto(pos, stations, false, true); // faces up
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

function buildBoatVisual(id: number, color: number): { root: THREE.Group; riderMount: THREE.Object3D } {
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
    color: PALETTE.flightDeep,
    emissive: PALETTE.flight,
    emissiveIntensity: 0.55,
    rimColor: PALETTE.foam,
    rimStrength: 0.7,
  });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    root.add(mesh);
    return mesh;
  };

  // hull, deck, sponsons — deck shares the hull color so the racer color
  // wraps over the top and reads from behind/above at gameplay distance
  add(buildHullGeometry(), hullMat);
  add(buildDeckGeometry(), hullMat);
  // sponsons skip the inverted-hull outline: their thin aft tips peek past
  // the transom against the white wake and the ink shell reads as dangling
  // dark hooks; the bare hull-colored wedges fair in cleanly
  add(buildSponsonGeometry(1), hullMat).userData.noOutline = true;
  add(buildSponsonGeometry(-1), hullMat).userData.noOutline = true;
  const deckStripe = add(buildDeckStripeGeometry(), inkMat);
  deckStripe.userData.noOutline = true; // painted-on panel line, no ink halo

  // cockpit: foam coaming ring, ink floor, ink seat + backrest
  add(new THREE.BoxGeometry(1.2, 0.16, 0.1), foamMat, 0, 0.66, -0.32);
  add(new THREE.BoxGeometry(1.2, 0.16, 0.1), foamMat, 0, 0.66, -1.88);
  add(new THREE.BoxGeometry(0.1, 0.16, 1.66), foamMat, 0.55, 0.66, -1.1);
  add(new THREE.BoxGeometry(0.1, 0.16, 1.66), foamMat, -0.55, 0.66, -1.1);
  add(new THREE.BoxGeometry(1.02, 0.05, 1.5), inkMat, 0, 0.6, -1.1);
  add(new THREE.BoxGeometry(0.52, 0.22, 0.5), inkMat, 0, 0.72, -1.58);
  // low seat cowl — a tall backrest poked up behind the rider's back and
  // read as a floating dark square from the side
  add(new THREE.BoxGeometry(0.5, 0.16, 0.14), inkMat, 0, 0.78, -1.84);

  // helm: column leaning toward the rider, handlebar, grips. Curved parts
  // carry enough segments that the Sobel normal pass only inks real creases.
  const column = add(new THREE.CylinderGeometry(0.055, 0.075, 0.42, 16), foamMat, 0, 0.8, -0.55);
  column.rotation.x = -0.25;
  const bar = add(new THREE.CylinderGeometry(0.03, 0.03, 0.62, 16), inkMat, 0, 1.0, -0.65);
  bar.rotation.z = Math.PI / 2;
  const gripL = add(new THREE.CylinderGeometry(0.042, 0.042, 0.15, 12), foamMat, 0.27, 1.0, -0.65);
  gripL.rotation.z = Math.PI / 2;
  const gripR = add(new THREE.CylinderGeometry(0.042, 0.042, 0.15, 12), foamMat, -0.27, 1.0, -0.65);
  gripR.rotation.z = Math.PI / 2;

  // windscreen
  const screen = add(new THREE.BoxGeometry(0.64, 0.02, 0.3), inkMat, 0, 0.72, -0.16);
  screen.rotation.x = -0.55;

  // jet pump faired INTO the transom: hull-colored housing, ink outlet
  // recessed INSIDE the housing silhouette — reads as a nozzle, never a ring
  // floating against the water
  const pump = add(new THREE.CylinderGeometry(0.15, 0.12, 0.3, 16), hullMat, 0, 0.2, -2.56);
  pump.rotation.x = Math.PI / 2;
  const outlet = add(new THREE.CylinderGeometry(0.075, 0.065, 0.1, 16), inkMat, 0, 0.2, -2.63);
  outlet.rotation.x = Math.PI / 2;
  // Anti-grav emitter pads sit under the stern quarters. Their restrained
  // cyan seam is visible before launch; the transparent thrust cones are
  // attached after the ink pass so they never receive outlines.
  for (const side of [-1, 1]) {
    const emitter = add(new THREE.CylinderGeometry(0.16, 0.2, 0.08, 14), flightMat, side * 0.68, 0.12, -1.62);
    emitter.userData.noOutline = true;
  }
  // rear wing in HULL color with ink endplates — a white wing hovering over
  // the stern read as a sail. Struts are chunky and fair into the deck.
  const wing = add(new THREE.BoxGeometry(1.15, 0.05, 0.34), hullMat, 0, 0.78, -2.42);
  wing.rotation.x = -0.12;
  add(new THREE.BoxGeometry(0.06, 0.09, 0.36), inkMat, 0.585, 0.78, -2.42).rotation.x = -0.12;
  add(new THREE.BoxGeometry(0.06, 0.09, 0.36), inkMat, -0.585, 0.78, -2.42).rotation.x = -0.12;
  add(new THREE.BoxGeometry(0.11, 0.22, 0.18), hullMat, 0.36, 0.65, -2.42);
  add(new THREE.BoxGeometry(0.11, 0.22, 0.18), hullMat, -0.36, 0.65, -2.42);

  // antenna — short ink whip, no ball tip, no outline
  const antenna = add(new THREE.CylinderGeometry(0.014, 0.014, 0.42, 8), inkMat, 0.62, 0.78, -2.2);
  antenna.userData.noOutline = true;

  // racing-number decals on the bow sides (canvas texture; unlit sticker material)
  const decalMat = new THREE.MeshBasicMaterial({
    map: numberDecalTexture(id + 1),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const decalGeo = new THREE.PlaneGeometry(0.9, 0.34);
  const decalPort = add(decalGeo, decalMat, 0.55, 0.36, 1.5);
  decalPort.rotation.y = Math.PI / 2 - 0.28; // tracks the bow's plan-view taper
  decalPort.userData.noOutline = true;
  const decalStbd = add(decalGeo, decalMat, -0.55, 0.36, 1.5);
  decalStbd.rotation.y = -(Math.PI / 2 - 0.28);
  decalStbd.userData.noOutline = true;

  // rider attach point at the helm; local +Z = boat forward
  const riderMount = new THREE.Object3D();
  riderMount.name = 'riderMount';
  riderMount.position.set(0, 0.64, -1.05);
  root.add(riderMount);

  return { root, riderMount };
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
  // drift / boost
  private boostTimer = 0;
  private boostTotal = 0;
  private wasDrifting = false;
  // earned anti-grav flight
  private flightElapsed = 0;
  private flightStartClearance = 0;
  private flightPenaltyApplied = false;
  // bookkeeping
  private prevSpeed = 0;
  private lateralG = 0;
  private turnSprayCd = 0;
  private boostSprayCd = 0;
  private trailCd = 0;
  private driftTrailCd = 0;
  private lastT = 0;
  private readonly blob: THREE.Mesh;
  private readonly footprint: THREE.Mesh;
  private readonly thrustShell: THREE.InstancedMesh;
  private readonly thrustOuter: THREE.InstancedMesh;
  private readonly thrustCore: THREE.InstancedMesh;
  private boostFx = 0;
  private flightFx = 0;
  private liftBurstTimer = 0;
  private liftSplashPending = false;
  private flightMissFxTimer = 0;
  private airBrakeFx = 0;

  constructor(opts: BoatOptions) {
    this.id = opts.id;
    this.wake = opts.wake;
    this.spray = opts.spray;
    this.trail = opts.trail;

    this.object = new THREE.Group();
    this.object.name = `boat-${opts.id}`;
    const visual = buildBoatVisual(opts.id, opts.color);
    this.object.add(visual.root);
    this.riderMount = visual.riderMount;

    addOutline(this.object); // once, after the whole mesh tree exists
    markInk(this.object); // solid-ink prepass layer (normal/depth + foam ring)

    // Ink blob shadow — added AFTER outline/ink passes so it stays out of
    // both (transparent, world-flat; posed each frame in update()).
    this.blob = buildBlobShadow();
    this.object.add(this.blob);
    this.footprint = buildFlightFootprint();
    this.footprint.layers.enable(LAYER_ENERGY);
    this.object.add(this.footprint);
    const thrust = buildThrustVisual();
    this.thrustShell = thrust.shell;
    this.thrustOuter = thrust.outer;
    this.thrustCore = thrust.core;
    this.object.add(this.thrustShell, this.thrustOuter, this.thrustCore);

    this.state = {
      position: this.object.position, // live reference — never reassigned
      quaternion: this.object.quaternion,
      speed: 0,
      rpm: 0,
      throttle: 0,
      steer: 0,
      drifting: false,
      boostCharge: 0,
      boosting: false,
      boostRemaining: 0,
      flightReady: false,
      flightPhase: 'surface',
      flightRemaining: 0,
      flightClearance: -TUNING.draft,
      flightThrust: 0,
      flightAirBrake: 0,
      flightsCleared: 0,
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
  update(dt: number, input: BoatInput, t: number): void {
    this.lastT = t;
    const st = this.state;
    const pos = this.object.position;

    const thr = clamp(input.throttle, -1, 1);
    const steer = clamp(input.steer, -1, 1);
    const flightWasActive = st.flightPhase !== 'surface';
    const airBrakeTarget = flightWasActive && input.airBrake ? 1 : 0;
    const airBrakeTau = airBrakeTarget > this.airBrakeFx ? TUNING.airBrakeAttack : TUNING.airBrakeRelease;
    this.airBrakeFx += (airBrakeTarget - this.airBrakeFx) * (1 - Math.exp(-dt / airBrakeTau));
    st.flightDenied = false;
    st.flightRouteMiss = false;
    st.flightPenaltyRemaining = Math.max(0, st.flightPenaltyRemaining - dt);

    // boost timer (release payout from a previous frame)
    if (this.boostTimer > 0) this.boostTimer = Math.max(0, this.boostTimer - dt);
    let boosting = this.boostTimer > 0;
    const surfaceBoost = boosting && !flightWasActive;
    const taperRef = TUNING.topSpeed * TUNING.taperHeadroom * (surfaceBoost ? TUNING.boostTopMul : 1);
    const accel = TUNING.accel * (surfaceBoost ? TUNING.boostAccelMul : 1);

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

    if (!st.airborne || flightWasActive) {
      // longitudinal: tapered engine + quadratic drag (+ drift scrub)
      let aF: number;
      if (flightWasActive) {
        const index = clamp(st.flightRouteIndex >= 0 ? st.flightRouteIndex : st.flightsCleared, 0, 2);
        const cruiseTarget = st.flightPhase === 'descending'
          ? TUNING.flightDescentSpeed
          : TUNING.flightTargetSpeeds[index];
        const target = cruiseTarget + (TUNING.airBrakeTargetSpeed - cruiseTarget) * this.airBrakeFx;
        const dragCompensation = TUNING.dragQuad * vF * Math.abs(vF);
        const maxDecel = TUNING.airBrakeDecel * Math.max(0.5, this.airBrakeFx);
        aF = clamp(
          (target - vF) * TUNING.flightDriveGain + dragCompensation,
          -maxDecel,
          TUNING.flightDriveAccel,
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
      if (input.drift) aF -= TUNING.driftScrub * vF;
      vF += aF * dt;
      if (flightWasActive) vF = Math.min(vF, TUNING.flightHardCap);

      // lateral hydrodynamic grip — cut while drifting (powerslide)
      const brakeGrip = TUNING.lateralGrip + (TUNING.airBrakeGrip - TUNING.lateralGrip) * this.airBrakeFx;
      const driftCut = input.drift ? TUNING.driftGripMul + (1 - TUNING.driftGripMul) * this.airBrakeFx : 1;
      const grip = brakeGrip * driftCut;
      vL *= Math.max(0, 1 - grip * dt);
    }
    // airborne: ballistic — horizontal velocity carries through untouched

    this.velX = fwdX * vF + portX * vL;
    this.velZ = fwdZ * vF + portZ * vL;

    // steering: full authority once moving, capped by lateral G at speed,
    // reversed in reverse
    const speedAbs = Math.abs(vF);
    const latGMax = TUNING.latGMax + (TUNING.airBrakeLatG - TUNING.latGMax) * this.airBrakeFx;
    const gCap = latGMax / Math.max(speedAbs, 0.5);
    const authority = Math.min(speedAbs / TUNING.steerFullSpeed, 1) * (vF < 0 ? -1 : 1);
    const yawTarget = -steer * Math.min(TUNING.yawRateMax, gCap) * authority;
    const baseYawDamp = TUNING.yawDamp + (TUNING.airBrakeYawDamp - TUNING.yawDamp) * this.airBrakeFx;
    const driftYawCut = input.drift ? TUNING.driftYawDampMul + (1 - TUNING.driftYawDampMul) * this.airBrakeFx : 1;
    const yawDamp = baseYawDamp * driftYawCut;
    this.yawRate += (yawTarget - this.yawRate) * Math.min(1, yawDamp * dt);
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    this.lateralG = vF * this.yawRate; // + = turning left

    // drift charge / boost payout on release
    if (input.drift && !flightWasActive) {
      if (speedAbs > TUNING.driftMinSpeed) {
        st.boostCharge = Math.min(1, st.boostCharge + dt / TUNING.driftChargeTime);
      }
    } else if (this.wasDrifting) {
      if (st.boostCharge >= TUNING.boostReleaseMin) {
        this.boostTimer = st.boostCharge * TUNING.boostDuration;
        this.boostTotal = this.boostTimer;
        // Flying never replaces the old payout. A wave jump on the release
        // frame must not steal the earned token; only controlled flight blocks
        // re-arming, which prevents an infinite airborne chain.
        if (!flightWasActive) st.flightReady = true;
      }
      st.boostCharge = 0;
    }
    this.wasDrifting = input.drift;
    boosting = this.boostTimer > 0;

    // Process the trigger after drift payout so releasing Space and pressing F
    // on the same simulation frame is a valid combo.
    if (input.flightTrigger) {
      if (st.flightReady && st.flightPhase === 'surface') {
        st.flightReady = false;
        st.flightPhase = 'spool';
        st.flightRouteState = 'idle';
        st.flightRouteIndex = -1;
        st.flightRouteFailReason = 'none';
        st.flightGateProgress = 0;
        this.flightElapsed = 0;
        this.liftBurstTimer = 0.22;
        this.liftSplashPending = true;
        this.flightPenaltyApplied = false;
        st.airborne = false;
        st.airTime = 0;
        this.unloadTime = 0;
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
    if (st.flightPhase !== 'surface') {
      this.updateFlight(dt, surfaceY, targetY);
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
        _v1.set(pos.x - fwdX * 2.3, hSt + 0.05, pos.z - fwdZ * 2.3);
        if (impact > 0.5) {
          const n = Math.min(TUNING.slamSprayMax, Math.round(impact * TUNING.slamSprayPer));
          this.spray.burst(_v1, n, 2 + impact * 0.6);
        }
        this.wake.push(_v1, fwdX, fwdZ, 1); // slam push
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

    // ---- orientation: wave slope + drive feel, critically damped ----
    const bowH = (hBowL + hBowR) * 0.5;
    const portH = (hBowL + hMidL) * 0.5;
    const stbdH = (hBowR + hMidR) * 0.5;
    let pitchT = Math.atan2(bowH - hSt, L * 2); // bow-up positive
    let rollT = Math.atan2(portH - stbdH, W * 2); // port-up positive

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
    }

    const w = TUNING.tiltOmega; // critically damped: ζ = 1
    this.pitchVel += (w * w * (pitchT - this.pitch) - 2 * w * this.pitchVel) * dt;
    this.pitch += this.pitchVel * dt;
    this.rollVel += (w * w * (rollT - this.roll) - 2 * w * this.rollVel) * dt;
    this.roll += this.rollVel * dt;

    _euler.set(-this.pitch, this.heading, this.roll, 'YXZ'); // euler.x is nose-down positive
    this.object.quaternion.setFromEuler(_euler);

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
    const wakeI =
      clamp(vF / TUNING.topSpeed, 0, 1) + (input.drift ? TUNING.wakeDriftBoost : 0) + (boosting ? TUNING.wakeBoostBoost : 0);
    // Zero intensity while airborne: the ribbon coasts (no emission in flight)
    // instead of drawing an unbroken confetti trail beneath a flying boat.
    const flightWake = 1 - clamp(Math.max(0, st.flightClearance) / 1.5, 0, 1);
    this.wake.push(_v1, fwdX, fwdZ, st.airborne ? 0 : Math.min(1, wakeI) * flightWake);

    // ---- turn spray off the leeward chine ----
    if (!st.airborne && st.flightPhase === 'surface' && Math.abs(this.lateralG) > TUNING.turnSprayG) {
      this.turnSprayCd -= dt;
      if (this.turnSprayCd <= 0) {
        this.turnSprayCd = TUNING.turnSprayPeriod;
        const side = this.lateralG > 0 ? -1 : 1; // turning left → spray off the starboard chine
        _v2.set(
          pos.x + portX * side * (W + 0.1) - fwdX * 0.6,
          (side > 0 ? hMidL : hMidR) + 0.06,
          pos.z + portZ * side * (W + 0.1) - fwdZ * 0.6,
        );
        this.spray.burst(_v2, 2, 1.5 + speedAbs * 0.12);
      }
    } else {
      this.turnSprayCd = 0;
    }

    // ---- boost exhaust spray ----
    if (this.liftSplashPending) {
      this.liftSplashPending = false;
      _v2.set(pos.x, surfaceY + 0.08, pos.z);
      this.spray.burst(_v2, 20, 7);
    }

    if (boosting && !st.airborne && st.flightClearance < 1.2) {
      this.boostSprayCd -= dt;
      if (this.boostSprayCd <= 0) {
        this.boostSprayCd = TUNING.boostSprayPeriod;
        _v2.set(pos.x - fwdX * 2.4, hSt + 0.1, pos.z - fwdZ * 2.4);
        this.spray.burst(_v2, 3, 3 + speedAbs * 0.15);
      }
    }

    this.driftTrailCd -= dt;
    if (input.drift && st.boostCharge > 0.04 && speedAbs > TUNING.driftMinSpeed && this.driftTrailCd <= 0) {
      this.driftTrailCd = 0.05;
      const side = Math.abs(this.lateralG) > 0.5 ? (this.lateralG > 0 ? -1 : 1) : (steer >= 0 ? 1 : -1);
      const charge = st.boostCharge;
      this.trail.emit(
        pos.x + portX * side * 0.88 - fwdX * 1.15,
        pos.y + 0.06,
        pos.z + portZ * side * 0.88 - fwdZ * 1.15,
        -fwdX * (0.7 + charge) + portX * side * 0.65,
        0.2 + charge * 0.45,
        -fwdZ * (0.7 + charge) + portZ * side * 0.65,
        PALETTE.boost,
        0.11 + charge * 0.09,
        0.24 + charge * 0.12,
      );
    }

    this.updateThrustVisual(dt, t, boosting, st.flightThrust, fwdX, fwdZ, portX, portZ);

    // ---- state ----
    st.speed = vF;
    st.throttle = thr;
    st.steer = steer;
    st.drifting = input.drift;
    st.boosting = boosting;
    st.boostRemaining = boosting && this.boostTotal > 0 ? clamp(this.boostTimer / this.boostTotal, 0, 1) : 0;
    st.flightClearance = pos.y - surfaceY;
    st.flightAirBrake = this.airBrakeFx;
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
    const flightTarget = Math.max(flightThrust, st.flightReady ? 0.08 : 0);
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
    const boostLen = 0.08 + this.boostFx * 5.2 * boostPulse;
    this.setThrustInstance('outer', 0, 0, 0.2, -2.64 - boostLen * 0.5, _fxQBoost, 0.46 * this.boostFx, boostLen);
    this.setThrustInstance('core', 0, 0, 0.2, -2.64 - boostLen * 0.42, _fxQBoost, 0.15 * this.boostFx, boostLen * 0.82);

    const burst = clamp(this.liftBurstTimer / 0.22, 0, 1);
    const pulseStep = Math.floor((t * 13 + this.id * 0.73) % 3);
    const pulse = pulseStep === 0 ? 0.88 : pulseStep === 1 ? 1 : 1.12;
    const missCut = warn ? 0.55 : 1;
    const waterGap = Math.max(0, st.flightClearance);
    const pressureLength = st.flightPhase === 'surface' ? 0 : Math.max(2.8, waterGap + 1.15);
    const shellLen = Math.max(pressureLength, 0.1 + this.flightFx * 3.8 + burst * 1.4) * pulse * missCut;
    const outerLen = Math.max(pressureLength * 0.88, 0.08 + this.flightFx * 3.1 + burst) * pulse * missCut;
    const coreLen = Math.max(pressureLength * 0.68, 0.06 + this.flightFx * 2.15 + burst * 0.62) * pulse * missCut;
    const shellRadius = (0.03 + this.flightFx * 0.58 + burst * 0.2) * missCut;
    const outerRadius = (0.03 + this.flightFx * 0.42 + burst * 0.14) * missCut;
    const coreRadius = (0.015 + this.flightFx * 0.16 + burst * 0.05) * missCut;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const dir = _fxLiftDirs[i];
      const q = _fxQLifts[i];
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

    this.trailCd -= dt;
    if (this.trailCd <= 0 && (this.boostFx > 0.25 || this.flightFx > 0.3)) {
      this.trailCd = 0.055;
      const pos = this.object.position;
      const pulse = 0.85 + 0.15 * Math.sin(t * 19 + this.id * 2.3);
      if (this.boostFx > 0.25) {
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
          this.trail.emit(
            pos.x + portX * side * 0.68 - fwdX * 1.62,
            pos.y - 0.25,
            pos.z + portZ * side * 0.68 - fwdZ * 1.62,
            -fwdX * 0.35 + portX * side * 0.2,
            -1.05,
            -fwdZ * 0.35 + portZ * side * 0.2,
            PALETTE.flight,
            0.18 * pulse,
            0.36,
          );
        }
      }
    }
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

  beginFlightRouteAttempt(routeIndex: number): void {
    const st = this.state;
    if (st.flightRouteState !== 'idle' || routeIndex !== st.flightsCleared) return;
    st.flightRouteState = 'active';
    st.flightRouteIndex = routeIndex;
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

  completeFlightRoute(routeIndex: number): void {
    const st = this.state;
    if (st.flightRouteState !== 'active' || st.flightRouteIndex !== routeIndex || routeIndex !== st.flightsCleared) return;
    st.flightRouteState = 'passed';
    st.flightsCleared = Math.min(3, st.flightsCleared + 1);
    // A clean third gate is the authored end of the maneuver. Start the same
    // smooth landing envelope immediately instead of leaving a fast racer
    // hovering for the unused portion of the ten-second safety window.
    const descendAt = TUNING.flightSpool + TUNING.flightAscend + TUNING.flightCruise;
    this.flightElapsed = Math.max(this.flightElapsed, descendAt);
  }

  settleFlightRoute(): void {
    const st = this.state;
    if (st.flightRouteState !== 'passed' || st.flightPhase !== 'surface') return;
    st.flightRouteState = 'idle';
    st.flightRouteIndex = -1;
    st.flightRouteFailReason = 'none';
    st.flightFailure = null;
    st.flightGateProgress = 0;
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
    st.flightRouteIndex = failure.flightNumber - 1;
    st.flightRouteFailReason = failure.reason;
    st.flightFailure = failure;
    if (st.flightPhase !== 'surface') {
      const descentAt = TUNING.flightSpool + TUNING.flightAscend + TUNING.flightCruise;
      this.flightElapsed = Math.max(this.flightElapsed, descentAt);
    }
    st.flightRouteMiss = true;
  }

  private updateFlight(dt: number, surfaceY: number, surfaceTargetY: number): void {
    const st = this.state;
    const total = TUNING.flightSpool + TUNING.flightAscend + TUNING.flightCruise + TUNING.flightDescend;
    const ascendAt = TUNING.flightSpool;
    const cruiseAt = ascendAt + TUNING.flightAscend;
    const descendAt = cruiseAt + TUNING.flightCruise;

    if (this.flightElapsed === 0) this.flightStartClearance = this.object.position.y - surfaceY;
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
      targetClearance = this.flightStartClearance + (TUNING.flightClearance - this.flightStartClearance) * p;
      thrust = 1;
    } else if (this.flightElapsed < descendAt) {
      phase = 'cruise';
      targetClearance = TUNING.flightClearance;
      thrust = 0.72;
    } else {
      phase = 'descending';
      const p = smooth01((this.flightElapsed - descendAt) / TUNING.flightDescend);
      const landingTarget = -TUNING.draft - TUNING.flightLandingLead;
      targetClearance = TUNING.flightClearance + (landingTarget - TUNING.flightClearance) * p;
      thrust = 0.72 * (1 - p);
    }

    const desiredY = surfaceY + targetClearance;
    const w = TUNING.flightOmega;
    const ay = clamp(w * w * (desiredY - this.object.position.y) - 2 * w * this.vy, -TUNING.flightAccelMax, TUNING.flightAccelMax);
    this.vy += ay * dt;
    this.object.position.y += this.vy * dt;
    st.flightPhase = phase;
    st.flightRemaining = clamp(1 - this.flightElapsed / total, 0, 1);
    st.flightThrust = thrust;
    st.airborne = false;
    st.airTime = 0;

    const landingTimedOut = this.flightElapsed >= total + 0.3;
    if (this.flightElapsed >= total && (this.object.position.y <= surfaceTargetY + 0.25 || landingTimedOut)) {
      this.object.position.y = surfaceTargetY;
      this.vy = 0;
      this.unloadTime = 0;
      this.flightElapsed = 0;
      st.flightPhase = 'surface';
      st.flightRemaining = 0;
      st.flightThrust = 0;
    }
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
    this.boostTimer = 0;
    this.boostTotal = 0;
    this.wasDrifting = false;
    this.flightElapsed = 0;
    this.flightStartClearance = 0;
    this.flightPenaltyApplied = false;
    this.prevSpeed = 0;
    this.lateralG = 0;
    this.turnSprayCd = 0;
    this.boostSprayCd = 0;
    this.trailCd = 0;
    this.driftTrailCd = 0;
    this.boostFx = 0;
    this.flightFx = 0;
    this.liftBurstTimer = 0;
    this.liftSplashPending = false;
    this.flightMissFxTimer = 0;
    this.airBrakeFx = 0;

    const st = this.state;
    st.boostCharge = 0;
    st.boostRemaining = 0;
    st.flightReady = false;
    st.flightPhase = 'surface';
    st.flightRemaining = 0;
    st.flightClearance = -TUNING.draft;
    st.flightThrust = 0;
    st.flightAirBrake = 0;
    st.flightsCleared = 0;
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
