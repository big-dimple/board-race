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
import { markInk } from '../contracts';
import type { BoatInput, BoatState, IBoat, IWake, ISpray } from '../contracts';
import { PALETTE } from '../core/palette';
import { waterHeight, waterNormalInto } from '../water/waves';
import { createToonMaterial } from '../cel/toonMaterial';
import { addOutline } from '../cel/outline';

export interface BoatOptions {
  id: number;
  color: number;
  wake: IWake;
  spray: ISpray;
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
  private wasDrifting = false;
  // bookkeeping
  private prevSpeed = 0;
  private lateralG = 0;
  private turnSprayCd = 0;
  private boostSprayCd = 0;
  private lastT = 0;
  private readonly blob: THREE.Mesh;

  constructor(opts: BoatOptions) {
    this.id = opts.id;
    this.wake = opts.wake;
    this.spray = opts.spray;

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

    // boost timer (release payout from a previous frame)
    if (this.boostTimer > 0) this.boostTimer = Math.max(0, this.boostTimer - dt);
    const boosting = this.boostTimer > 0;
    const taperRef = TUNING.topSpeed * TUNING.taperHeadroom * (boosting ? TUNING.boostTopMul : 1);
    const accel = TUNING.accel * (boosting ? TUNING.boostAccelMul : 1);

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

    if (!st.airborne) {
      // longitudinal: tapered engine + quadratic drag (+ drift scrub)
      let aF: number;
      if (thr >= 0) {
        aF = thr * accel * Math.max(0, 1 - vF / taperRef);
      } else if (vF > 0.5) {
        aF = thr * TUNING.brakeDecel; // braking while still moving forward
      } else {
        aF = thr * TUNING.reverseAccel * Math.max(0, 1 + vF / TUNING.reverseSpeed);
      }
      aF -= TUNING.dragQuad * vF * Math.abs(vF);
      if (input.drift) aF -= TUNING.driftScrub * vF;
      vF += aF * dt;

      // lateral hydrodynamic grip — cut while drifting (powerslide)
      const grip = TUNING.lateralGrip * (input.drift ? TUNING.driftGripMul : 1);
      vL *= Math.max(0, 1 - grip * dt);
    }
    // airborne: ballistic — horizontal velocity carries through untouched

    this.velX = fwdX * vF + portX * vL;
    this.velZ = fwdZ * vF + portZ * vL;

    // steering: full authority once moving, capped by lateral G at speed,
    // reversed in reverse
    const speedAbs = Math.abs(vF);
    const gCap = TUNING.latGMax / Math.max(speedAbs, 0.5);
    const authority = Math.min(speedAbs / TUNING.steerFullSpeed, 1) * (vF < 0 ? -1 : 1);
    const yawTarget = -steer * Math.min(TUNING.yawRateMax, gCap) * authority;
    const yawDamp = TUNING.yawDamp * (input.drift ? TUNING.driftYawDampMul : 1);
    this.yawRate += (yawTarget - this.yawRate) * Math.min(1, yawDamp * dt);
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    this.lateralG = vF * this.yawRate; // + = turning left

    // drift charge / boost payout on release
    if (input.drift) {
      if (speedAbs > TUNING.driftMinSpeed) {
        st.boostCharge = Math.min(1, st.boostCharge + dt / TUNING.driftChargeTime);
      }
    } else if (this.wasDrifting) {
      if (st.boostCharge >= TUNING.boostReleaseMin) {
        this.boostTimer = st.boostCharge * TUNING.boostDuration;
      }
      st.boostCharge = 0;
    }
    this.wasDrifting = input.drift;

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
    const targetY = (hBowL + hBowR + hMidL + hMidR + hSt) / 5 - TUNING.draft;

    st.landImpulse = 0; // only landing frames report an impact
    if (st.airborne) {
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
      const gap = clamp(pos.y - targetY, 0, 4);
      const air = gap / 2.2;
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
      (this.blob.material as THREE.MeshBasicMaterial).opacity = 0.36 - air * 0.16;
    }

    // ---- wake ribbon (every frame) ----
    _v1.set(pos.x - fwdX * 2.3, hSt + 0.04, pos.z - fwdZ * 2.3);
    const wakeI =
      clamp(vF / TUNING.topSpeed, 0, 1) + (input.drift ? TUNING.wakeDriftBoost : 0) + (boosting ? TUNING.wakeBoostBoost : 0);
    // Zero intensity while airborne: the ribbon coasts (no emission in flight)
    // instead of drawing an unbroken confetti trail beneath a flying boat.
    this.wake.push(_v1, fwdX, fwdZ, st.airborne ? 0 : Math.min(1, wakeI));

    // ---- turn spray off the leeward chine ----
    if (!st.airborne && Math.abs(this.lateralG) > TUNING.turnSprayG) {
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
    if (boosting && !st.airborne) {
      this.boostSprayCd -= dt;
      if (this.boostSprayCd <= 0) {
        this.boostSprayCd = TUNING.boostSprayPeriod;
        _v2.set(pos.x - fwdX * 2.4, hSt + 0.1, pos.z - fwdZ * 2.4);
        this.spray.burst(_v2, 3, 3 + speedAbs * 0.15);
      }
    }

    // ---- state ----
    st.speed = vF;
    st.throttle = thr;
    st.steer = steer;
    st.drifting = input.drift;
    st.boosting = boosting;
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
    this.wasDrifting = false;
    this.prevSpeed = 0;
    this.lateralG = 0;
    this.turnSprayCd = 0;
    this.boostSprayCd = 0;

    const st = this.state;
    st.boostCharge = 0;
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
