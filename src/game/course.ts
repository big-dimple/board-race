/**
 * course.ts — the circuit: spline, racing-line ribbon, start/finish checker
 * strip + gantry, gates, buoys, grid.
 *
 * One closed centripetal CatmullRom through 18 designed control points:
 *   (1) start/finish on a ~290m straight heading +Z through the origin,
 *   (2) fast right-hand sweeper,
 *   (3) L-R chicane,
 *   (4) a 180-degree hairpin (reached via a long right loop corner that
 *       drops down off the chicane plateau),
 *   (5) a 350m straight running ~85-90 degrees ACROSS the primary swell
 *       [0.94, 0.34] — the AIRTIME section, boats launch off crests,
 *   (6) a wide carousel back to the line.
 *   DESIGN NOTE: the brief asked for a LEFT carousel. With a +Z start
 *   straight, an early right sweeper and a swell-perpendicular airtime
 *   straight, a left carousel geometrically cannot close a compact
 *   non-crossing loop (it always exits ~2R to the wrong side or crosses
 *   the hairpin corridor); the carousel is therefore right-handed.
 *   Everything else matches the brief. Verified by the module-load sanity
 *   log below: lap 2511m, min non-adjacent clearance ~67m.
 *
 * u is ALWAYS arc-length-normalized here (getPointAt/getTangentAt), so
 * progress, splits and ribbon dashes are all true meters.
 *
 * Also exports:
 *   CHECKPOINT_US — gate u-positions (race.ts consumes these so splits and
 *                   the anti-cheat order line up with the physical gates)
 *   GRID_SLOTS    — four staggered start positions, with the player at the back
 */
import * as THREE from 'three';
import {
  markInk,
  LAYER_ENERGY,
  LAYER_INK,
  type CourseRouteId,
  type CourseSample,
  type FlightCourseRouteId,
  type FlightRouteDefinition,
  type FlightRouteFailReason,
  type IBoat,
  type ICourse,
} from '../contracts';
import { PALETTE } from '../core/palette';
import { RACER_DEFS } from './racers';
import { WAVES_GLSL, waterHeight, waterNormalInto } from '../water/waves';
import { createToonMaterial } from '../cel/toonMaterial';
import { addOutline } from '../cel/outline';

// -------------------------------------------------------------- spline ----

const CONTROL_POINTS: readonly (readonly [number, number])[] = [
  [0, 0],         //  0 start/finish line (u = 0), main straight heading +Z
  [0, 280],       //  1 main straight end
  [22.8, 365],    //  2 fast right sweeper
  [98.2, 434.1],  //  3 sweeper
  [199.5, 447.4], //  4 sweeper exit
  [240, 445],     //  5 chicane kink L
  [310, 500],     //  6 chicane apex
  [393.8, 475.3], //  7 chicane kink R
  [433.2, 468.3], //  8 chicane exit
  [506.5, 430.1], //  9 right loop corner (~240 deg, descends to the hairpin)
  [528.4, 264.1], // 10 loop corner
  [373.7, 200.1], // 11 loop corner
  [256.5, 350.8], // 12 hairpin entry
  [198.8, 377.8], // 13 hairpin apex
  [171.9, 320.2], // 14 hairpin exit -> airtime straight
  [291, -8.7],    // 15 airtime straight end -> carousel
  [225, -189.9],  // 16 carousel
  [10, -130],     // 17 carousel exit -> back to the straight
];

const CURVE = new THREE.CatmullRomCurve3(
  CONTROL_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)),
  true,
  'centripetal',
);
CURVE.arcLengthDivisions = 800;

const LAP_LENGTH = CURVE.getLength();

// ---------------------------------------------------- arc-length table ----

const TABLE_N = 2048;
const TAB_X = new Float32Array(TABLE_N);
const TAB_Z = new Float32Array(TABLE_N);
const TAB_TX = new Float32Array(TABLE_N);
const TAB_TZ = new Float32Array(TABLE_N);

{
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let i = 0; i < TABLE_N; i++) {
    CURVE.getPointAt(i / TABLE_N, p);
    CURVE.getTangentAt(i / TABLE_N, t);
    TAB_X[i] = p.x;
    TAB_Z[i] = p.z;
    const il = 1 / (Math.hypot(t.x, t.z) || 1);
    TAB_TX[i] = t.x * il;
    TAB_TZ[i] = t.z * il;
  }
}

/** Module temp for nearestOnSpline — reused, never allocated per call. */
const _near = { u: 0, x: 0, z: 0, tx: 0, tz: 1 };

/**
 * Nearest point on the spline to world (x, z): coarse scan over the 2048-entry
 * table + local parabolic refine between the best sample's neighbours.
 * Result in _near (u arc-length 0..1, point, unit XZ tangent).
 */
function nearestOnSpline(x: number, z: number): void {
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < TABLE_N; i++) {
    const dx = x - TAB_X[i];
    const dz = z - TAB_Z[i];
    const d = dx * dx + dz * dz;
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  const im = (bi - 1 + TABLE_N) % TABLE_N;
  const ip = (bi + 1) % TABLE_N;
  const dxm = x - TAB_X[im];
  const dzm = z - TAB_Z[im];
  const dm = dxm * dxm + dzm * dzm;
  const dxp = x - TAB_X[ip];
  const dzp = z - TAB_Z[ip];
  const dp = dxp * dxp + dzp * dzp;
  const denom = dm - 2 * bd + dp;
  let off = denom > 1e-9 ? (0.5 * (dm - dp)) / denom : 0;
  if (off > 1) off = 1;
  else if (off < -1) off = -1;
  _near.u = (((bi + off) / TABLE_N) % 1 + 1) % 1;
  if (off >= 0) {
    _near.x = TAB_X[bi] + (TAB_X[ip] - TAB_X[bi]) * off;
    _near.z = TAB_Z[bi] + (TAB_Z[ip] - TAB_Z[bi]) * off;
    _near.tx = TAB_TX[bi] + (TAB_TX[ip] - TAB_TX[bi]) * off;
    _near.tz = TAB_TZ[bi] + (TAB_TZ[ip] - TAB_TZ[bi]) * off;
  } else {
    _near.x = TAB_X[bi] + (TAB_X[bi] - TAB_X[im]) * -off;
    _near.z = TAB_Z[bi] + (TAB_Z[bi] - TAB_Z[im]) * -off;
    _near.tx = TAB_TX[bi] + (TAB_TX[bi] - TAB_TX[im]) * -off;
    _near.tz = TAB_TZ[bi] + (TAB_TZ[bi] - TAB_TZ[im]) * -off;
  }
  const il = 1 / (Math.hypot(_near.tx, _near.tz) || 1);
  _near.tx *= il;
  _near.tz *= il;
}

// ------------------------------------------------------------ checkpoints ----

/** World-XZ anchors for the 8 checkpoint gates, snapped to the spline below. */
const GATE_ANCHORS: readonly (readonly [number, number])[] = [
  [60, 400],     // sweeper mid
  [240, 445],    // chicane in
  [310, 500],    // chicane apex
  [528, 340],    // loop corner mid
  [230, 372],    // hairpin
  [180, 300],    // airtime entry
  [291, -8.7],   // airtime end
  [215, -180],   // carousel mid
];

/** Gate u-positions on the closed spline, ascending. race.ts relies on the order. */
export const CHECKPOINT_US: readonly number[] = GATE_ANCHORS.map(([x, z]) => {
  nearestOnSpline(x, z);
  return _near.u;
});

// ---------------------------------------------------- anti-grav branches ----

export const FLIGHT_ROUTES: readonly FlightRouteDefinition[] = [
  {
    id: 'flight-1',
    index: 0,
    entryU: 0.06,
    exitU: 0.115,
    gateUs: [0.1],
    nodes: [
      { u: 0.06, lateral: 0, height: 0 },
      { u: 0.075, lateral: 0, height: 4.5 },
      { u: 0.1, lateral: 0, height: 4.5 },
      { u: 0.115, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 6.5,
    gateHalfWidth: 6.5,
    passHalfWidth: 6.825,
    targetSpeed: 42,
    qualifyFromU: 0.012,
    launchFromU: 0.045,
    launchToU: 0.067,
    turnWarningFromU: 0.06,
    turnWarningToU: 0.06,
  },
  {
    id: 'flight-2',
    index: 1,
    entryU: CHECKPOINT_US[1],
    exitU: 0.315,
    gateUs: [0.3],
    nodes: [
      { u: CHECKPOINT_US[1], lateral: 0, height: 0 },
      { u: 0.262, lateral: 18, height: 4.5 },
      { u: CHECKPOINT_US[2], lateral: 41, height: 4.5 },
      { u: 0.3, lateral: 23, height: 4.5 },
      { u: 0.315, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5.5,
    gateHalfWidth: 5.5,
    passHalfWidth: 5.775,
    targetSpeed: 46,
    qualifyFromU: 0.205,
    launchFromU: 0.233,
    launchToU: 0.253,
    turnWarningFromU: 0.258,
    turnWarningToU: 0.292,
  },
  {
    id: 'flight-3',
    index: 2,
    entryU: 0.39,
    exitU: 0.47,
    gateUs: [0.455],
    nodes: [
      { u: 0.39, lateral: 0, height: 0 },
      { u: 0.415, lateral: 12, height: 4.5 },
      { u: 0.44, lateral: 22, height: 4.5 },
      { u: 0.455, lateral: 14, height: 4.5 },
      { u: 0.47, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5,
    gateHalfWidth: 5,
    passHalfWidth: 5.25,
    targetSpeed: 48,
    qualifyFromU: 0.33,
    launchFromU: 0.375,
    launchToU: 0.398,
    turnWarningFromU: 0.39,
    turnWarningToU: 0.445,
  },
  {
    id: 'flight-4',
    index: 3,
    entryU: 0.515,
    exitU: 0.58,
    gateUs: [0.565],
    nodes: [
      { u: 0.515, lateral: 0, height: 0 },
      { u: 0.535, lateral: 0, height: 4.5 },
      { u: 0.55, lateral: 0, height: 4.5 },
      { u: 0.565, lateral: 0, height: 4.5 },
      { u: 0.58, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 8,
    gateHalfWidth: 8,
    passHalfWidth: 8,
    targetSpeed: 46,
    qualifyFromU: 0.482,
    launchFromU: 0.503,
    launchToU: 0.522,
    turnWarningFromU: 0.548,
    turnWarningToU: 0.568,
  },
  {
    id: 'flight-5',
    index: 4,
    entryU: 0.635,
    exitU: 0.72,
    gateUs: [0.705],
    nodes: [
      { u: 0.635, lateral: 0, height: 0 },
      { u: 0.655, lateral: -18, height: 4.5 },
      { u: 0.68, lateral: -36, height: 4.5 },
      { u: 0.705, lateral: -20, height: 4.5 },
      { u: 0.72, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5.5,
    gateHalfWidth: 5.5,
    passHalfWidth: 5.775,
    targetSpeed: 48,
    qualifyFromU: 0.59,
    launchFromU: 0.62,
    launchToU: 0.642,
    turnWarningFromU: 0.65,
    turnWarningToU: 0.71,
  },
  {
    id: 'flight-6',
    index: 5,
    entryU: 0.775,
    exitU: 0.855,
    gateUs: [0.84],
    nodes: [
      { u: 0.775, lateral: 0, height: 0 },
      { u: 0.8, lateral: 12, height: 4.5 },
      { u: 0.825, lateral: 22, height: 4.5 },
      { u: 0.84, lateral: 14, height: 4.5 },
      { u: 0.855, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5,
    gateHalfWidth: 5,
    passHalfWidth: 5.25,
    targetSpeed: 50,
    qualifyFromU: 0.73,
    launchFromU: 0.76,
    launchToU: 0.782,
    turnWarningFromU: 0.79,
    turnWarningToU: 0.845,
  },
  {
    id: 'flight-7',
    index: 6,
    entryU: 0.905,
    exitU: 0.975,
    gateUs: [0.96],
    nodes: [
      { u: 0.905, lateral: 0, height: 0 },
      { u: 0.925, lateral: -3, height: 4.5 },
      { u: 0.945, lateral: -6, height: 4.5 },
      { u: 0.96, lateral: -3, height: 4.5 },
      { u: 0.975, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5.5,
    gateHalfWidth: 5.5,
    passHalfWidth: 5.775,
    targetSpeed: 50,
    qualifyFromU: 0.865,
    launchFromU: 0.89,
    launchToU: 0.912,
    turnWarningFromU: 0.914,
    turnWarningToU: 0.968,
  },
] as const;

/** Compatibility aliases used by a few deterministic harness helpers. */
export const FLIGHT_ENTRY_U = FLIGHT_ROUTES[0].entryU;
export const FLIGHT_EXIT_U = FLIGHT_ROUTES[0].exitU;
export const FLIGHT_GATE_US = FLIGHT_ROUTES[0].gateUs;
const FLIGHT_CORRIDOR_GRACE = 0.12;
const FLIGHT_CORRIDOR_FAIL = 0.35;
const FLIGHT_CORRIDOR_FAIL_DISTANCE = 10;
const FLIGHT_GATE_BYPASS_U = 2.5 / LAP_LENGTH;
const FLIGHT_ATTEMPT_EARLY_U = 0.012;

interface FlightRouteRuntime {
  def: FlightRouteDefinition;
  curve: THREE.CatmullRomCurve3;
  tableN: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  tx: Float32Array;
  ty: Float32Array;
  tz: Float32Array;
  u: Float32Array;
  near: { u: number; x: number; y: number; z: number; tx: number; ty: number; tz: number; distance: number };
}

function buildFlightRuntime(def: FlightRouteDefinition): FlightRouteRuntime {
  const points: THREE.Vector3[] = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (const node of def.nodes) {
    CURVE.getPointAt(node.u, p);
    CURVE.getTangentAt(node.u, t);
    const il = 1 / (Math.hypot(t.x, t.z) || 1);
    points.push(new THREE.Vector3(p.x + t.z * il * node.lateral, node.height, p.z - t.x * il * node.lateral));
  }
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  curve.arcLengthDivisions = 320;
  const tableN = Math.max(256, Math.ceil(curve.getLength() / 0.45));
  const runtime: FlightRouteRuntime = {
    def,
    curve,
    tableN,
    x: new Float32Array(tableN),
    y: new Float32Array(tableN),
    z: new Float32Array(tableN),
    tx: new Float32Array(tableN),
    ty: new Float32Array(tableN),
    tz: new Float32Array(tableN),
    u: new Float32Array(tableN),
    near: { u: def.entryU, x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 1, distance: Infinity },
  };
  for (let i = 0; i < tableN; i++) {
    const f = i / (tableN - 1);
    curve.getPoint(f, p);
    curve.getTangent(f, t).normalize();
    runtime.x[i] = p.x;
    runtime.y[i] = p.y;
    runtime.z[i] = p.z;
    runtime.tx[i] = t.x;
    runtime.ty[i] = t.y;
    runtime.tz[i] = t.z;
    runtime.u[i] = def.entryU + (def.exitU - def.entryU) * f;
  }
  return runtime;
}

const FLIGHT_RUNTIME = FLIGHT_ROUTES.map(buildFlightRuntime);

function flightRuntime(routeId: FlightCourseRouteId): FlightRouteRuntime {
  return FLIGHT_RUNTIME[Number(routeId.slice(-1)) - 1];
}

function nearestOnFlight(runtime: FlightRouteRuntime, x: number, z: number): void {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < runtime.tableN; i++) {
    const dx = x - runtime.x[i];
    const dz = z - runtime.z[i];
    // Route progress and rail clearance are planar. Height is validated by
    // each authored gate; including it here makes a correctly aligned boat
    // project backward while it is still climbing, producing a false miss.
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const near = runtime.near;
  near.u = runtime.u[best];
  near.x = runtime.x[best];
  near.y = runtime.y[best];
  near.z = runtime.z[best];
  near.tx = runtime.tx[best];
  near.ty = runtime.ty[best];
  near.tz = runtime.tz[best];
  near.distance = Math.hypot(x - near.x, z - near.z);
}

function flightCurveT(def: FlightRouteDefinition, u: number): number {
  return Math.min(1, Math.max(0, (u - def.entryU) / (def.exitU - def.entryU)));
}

// -------------------------------------------------------------- grid ----

export interface GridSlot {
  x: number;
  z: number;
  heading: number;
  startPlace: number;
}

/** Three-column six-racer grid in boat-id order. The player starts fourth. */
export const GRID_SLOTS: readonly GridSlot[] = RACER_DEFS.map((racer) => {
    const u = (1 - racer.startDistance / LAP_LENGTH) % 1;
    const i = u * TABLE_N;
    const i0 = Math.floor(i) % TABLE_N;
    const i1 = (i0 + 1) % TABLE_N;
    const f = i - Math.floor(i);
    const px = TAB_X[i0] + (TAB_X[i1] - TAB_X[i0]) * f;
    const pz = TAB_Z[i0] + (TAB_Z[i1] - TAB_Z[i0]) * f;
    const tx = TAB_TX[i0] + (TAB_TX[i1] - TAB_TX[i0]) * f;
    const tz = TAB_TZ[i0] + (TAB_TZ[i1] - TAB_TZ[i0]) * f;
    return {
      x: px + tz * racer.startLateral,
      z: pz - tx * racer.startLateral,
      heading: Math.atan2(-tx, tz),
      startPlace: racer.startPlace,
    };
});

// -------------------------------------------------------- sanity check ----

{
  const step = LAP_LENGTH / TABLE_N;
  const SKIP = Math.round(90 / step); // "non-adjacent": >= 90m apart along the lap
  let min = Infinity;
  let mi = 0;
  let mj = 0;
  for (let i = 0; i < TABLE_N; i++) {
    for (let j = i + SKIP; j < i + TABLE_N - SKIP; j++) {
      const jj = j % TABLE_N;
      const dx = TAB_X[i] - TAB_X[jj];
      const dz = TAB_Z[i] - TAB_Z[jj];
      const d = dx * dx + dz * dz;
      if (d < min) {
        min = d;
        mi = i;
        mj = jj;
      }
    }
  }
  console.info(
    `[course] lap ${LAP_LENGTH.toFixed(0)}m, ${CONTROL_POINTS.length} control points, ` +
      `${CHECKPOINT_US.length} checkpoints, min non-adjacent clearance ${Math.sqrt(min).toFixed(1)}m ` +
      `(at ${(mi * step).toFixed(0)}m / ${(mj * step).toFixed(0)}m along the lap)`,
  );
}

// -------------------------------------------------------- module temps ----

const UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _sp = new THREE.Vector3();
const _ta = new THREE.Vector3();
const _routeSample: CourseSample = {
  u: 0,
  distance: 0,
  point: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  routeId: 'surface',
};

/** Central-difference span for tangents (~0.6m of arc). */
const TAN_DU = 0.6 / LAP_LENGTH;

function wrapU(u: number): number {
  return ((u % 1) + 1) % 1;
}

// ------------------------------------------------------- canvas textures ----

function hexCss(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

/**
 * Hard-banded horizontal stripe texture for the gate buoys: foam white bands
 * (lower half shaded so the white never reads as a blown #fff slab) + deep
 * ink separators + one committed orange accent band. Crisp rects only
 * (no AA mush), NearestFilter on BOTH filters with no mipmaps so the bands
 * stay razor-hard at any distance instead of blending to gray-green.
 */
function makeStripeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  // big stripe period: accent band reads at range, ink separators stay crisp
  // (canvas y=0 maps to the cylinder TOP: each foam band is bright on its
  // upper half, shade-toned on its lower half)
  const bands: readonly (readonly [number, number])[] = [
    [PALETTE.foam, 10],
    [PALETTE.cloudShade, 10],
    [PALETTE.ink, 8],
    [PALETTE.hullReef, 18],
    [PALETTE.ink, 8],
    [PALETTE.foam, 5],
    [PALETTE.cloudShade, 5],
  ];
  let y = 0;
  for (const [hex, h] of bands) {
    g.fillStyle = hexCss(hex);
    g.fillRect(0, y, 64, h);
    y += h;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace; // palette values verbatim, like the toon pipeline
  tex.wrapS = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** 'START' banner graphic: chunky ink checker borders + bold ink text on foam. */
function makeStartTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = hexCss(PALETTE.foam);
  g.fillRect(0, 0, 512, 128);
  // crisp race checker, cells big enough to read at distance
  g.fillStyle = hexCss(PALETTE.ink);
  const s = 32;
  for (let row = 0; row < 1; row++) {
    for (let x = 0; x < 512 / s; x++) {
      if ((x + row) % 2 === 0) {
        g.fillRect(x * s, row * s, s, s);
        g.fillRect(x * s + s, 128 - s, s, s);
      }
    }
  }
  // ink frame + green end posts
  g.fillStyle = hexCss(PALETTE.uiAccent);
  g.fillRect(0, s, 14, 128 - 2 * s);
  g.fillRect(498, s, 14, 128 - 2 * s);
  g.fillStyle = hexCss(PALETTE.ink);
  g.font = '900 76px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('START', 256, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.NearestFilter; // hard checker up close
  tex.minFilter = THREE.NearestFilter; // ...and no mipmap mush at range
  tex.generateMipmaps = false;
  return tex;
}

/**
 * Reverse face of the banner: full-face race checker on foam (the finish-line
 * read from beyond the line — the old DoubleSide plane showed a washed-out
 * mirrored START). 2 rows of big cells, razor-hard at any distance.
 */
function makeCheckerTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = hexCss(PALETTE.foam);
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = hexCss(PALETTE.ink);
  const s = 32; // 16 x 4 cells
  for (let row = 0; row < 128 / s; row++) {
    for (let x = 0; x < 512 / s; x++) {
      if ((x + row) % 2 === 0) g.fillRect(x * s, row * s, s, s);
    }
  }
  // green end posts, matching the START face
  g.fillStyle = hexCss(PALETTE.uiAccent);
  g.fillRect(0, 0, 14, 128);
  g.fillRect(498, 0, 14, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** Vertical-post stripes for the gantry towers: foam post, ink bands, green collar. */
function makeTowerTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const bands: readonly (readonly [number, number])[] = [
    [PALETTE.uiAccent, 12], // collar just under the cap
    [PALETTE.ink, 6],
    [PALETTE.foam, 28],
    [PALETTE.ink, 6],
    [PALETTE.foam, 12],
  ];
  let y = 0;
  for (const [hex, h] of bands) {
    g.fillStyle = hexCss(hex);
    g.fillRect(0, y, 64, h);
    y += h;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** Pink low-altitude lock: the open cyan aperture only exists above this field. */
function makeFlightLockTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = hexCss(PALETTE.uiWarn);
  g.lineWidth = 15;
  g.beginPath();
  g.moveTo(8, 10);
  g.lineTo(248, 118);
  g.moveTo(248, 10);
  g.lineTo(8, 118);
  g.stroke();
  g.fillStyle = hexCss(PALETTE.foam);
  g.font = '900 27px Arial Black, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('AIR ONLY', 128, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

const STRIPE_SUN = new THREE.Vector3(PALETTE.sunDir[0], PALETTE.sunDir[1], PALETTE.sunDir[2]).normalize();
/** Fog target for striped surfaces: foam pulled toward the horizon color —
 *  far buoys/banner read as pale graphic poles, never black clusters. */
const STRIPE_FOG = new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace)
  .lerp(new THREE.Color().setHex(PALETTE.skyHorizon, THREE.NoColorSpace), 0.35);

/**
 * Minimal banded-toon material with a map (createToonMaterial takes no map):
 * 3 hard lighting bands over the texture, palette sun direction. The shadow
 * floor stays high enough that the shadow band still reads as a COLOR
 * (never the dead-black void the old ink towers fell into). `shadowFloor`
 * 0.8 for the banner: a graphic panel that must read bright from BOTH sides.
 * Distance is tinted in two hard bands toward STRIPE_FOG (same banded-fog
 * language as the ocean/toon fog), so distant stripes melt pale instead of
 * aliasing into ink lumps.
 */
function makeStripeToon(map: THREE.Texture, shadowFloor = 0.52): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'StripeToon',
    uniforms: {
      uMap: { value: map },
      uSunDir: { value: STRIPE_SUN },
      uFloor: { value: shadowFloor },
      uFog: { value: STRIPE_FOG },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec2 vUv;
      varying float vDist;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uSunDir;
      uniform float uFloor;
      uniform vec3 uFog;
      varying vec3 vN;
      varying vec2 vUv;
      varying float vDist;
      void main() {
        vec3 base = texture2D(uMap, vUv).rgb;
        float ndl = dot(normalize(vN), uSunDir) * 0.5 + 0.5;
        float band = step(0.35, ndl) * 0.48 + step(0.72, ndl) * 0.52;
        vec3 col = base * (uFloor + (1.0 - uFloor) * band);
        // two hard distance bands toward the pale stripe-fog color
        float fog = step(240.0, vDist) * 0.35 + step(700.0, vDist) * 0.45;
        col = mix(col, uFog, min(fog, 1.0));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.FrontSide,
  });
}

// ---------------------------------------------------------------- ribbon ----

const RIBBON_SEGS = 1400;
const RIBBON_HALF_W = 1.7; // 3.4m wide — slim painted line, not a paved lane

/**
 * Painted racing line: normal-blended (NOT additive — the old additive core
 * washed out to pale mint over crests and its dim rails/fade steps read as
 * wide dark "asphalt" bands over deep water). Hard-stepped zones across the
 * width: bright dash core flowing along the lap, always-on slim green rails
 * for wayfinding between dashes, thin ink under-stroke edging so the line
 * keeps contrast on pale-cyan crests. The outer glow is a SMOOTH radial
 * falloff to zero at the ribbon edge — the old hard-stepped translucent
 * flank read as a ghost polygon paralleling the line.
 */
function buildRibbonMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'RacingLine',
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color().setHex(PALETTE.racingLine, THREE.NoColorSpace) },
      uInk: { value: new THREE.Color().setHex(PALETTE.ink, THREE.NoColorSpace) },
      uPlayerS: { value: 0 },
      uLapLength: { value: LAP_LENGTH },
      uMaskStart: { value: 0 },
      uMaskEnd: { value: 0 },
      uGuideActive: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying float vS;
      varying float vSide;
      varying float vDist;
      ${WAVES_GLSL}
      void main() {
        vec3 p = position;
        // ride the swell instead of clipping through it. Lift compromise:
        // 0.22 read as an elevated rail bridging troughs; 0.1 clips under
        // far wave slopes (broken line). 0.17 survives both at chase angles.
        p.y = waveHeight(p.xz, uTime) + 0.17;
        vS = uv.x;
        vSide = uv.y;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uInk;
      uniform float uPlayerS;
      uniform float uLapLength;
      uniform float uMaskStart;
      uniform float uMaskEnd;
      uniform float uGuideActive;
      varying float vS;
      varying float vSide;
      varying float vDist;
      void main() {
        float ahead = mod(vS - uPlayerS + uLapLength, uLapLength);
        float behind = mod(uPlayerS - vS + uLapLength, uLapLength);
        if (ahead > 170.0 && behind > 12.0) discard;
        if (uGuideActive > 0.5 && vS >= uMaskStart && vS <= uMaskEnd) discard;
        // hard dash band flowing along the ribbon (~14m period)
        float dash = step(fract(vS * 0.07 - uTime * 0.6), 0.62);
        float a = abs(vSide);
        // zones across the width (hard steps, except the halo: smooth radial
        // falloff to zero at the ribbon edge — no ghost polygon flank)
        float core = 1.0 - step(0.42, a);
        float rail = step(0.42, a) * (1.0 - step(0.58, a));
        // slim ink rails — fat dark borders read as "mostly-black rails" close up
        float edge = step(0.64, a) * (1.0 - step(0.78, a));
        float halo = step(0.78, a) * (1.0 - smoothstep(0.78, 1.0, a));
        // 2-step banded distance fade
        float localFade = ahead <= 135.0 ? 1.0 : 1.0 - smoothstep(135.0, 170.0, ahead);
        float fade = (vDist < 220.0 ? 1.0 : 0.62) * max(localFade, step(0.001, behind) * step(behind, 12.0));
        vec3 col = uColor * (core * (0.55 + 0.75 * dash) + rail * 0.85 + halo * 0.6)
                 + uInk * edge;
        float alpha = (core * dash + rail * 0.9 + edge * 0.95 + halo * 0.22) * fade;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------- gates ----

interface Floater {
  obj: THREE.Object3D;
  x: number;
  z: number;
  yawQ: THREE.Quaternion;
  routeU?: number;
}

interface FlightGate {
  u: number;
  center: THREE.Vector3;
  normal: THREE.Vector3;
  right: THREE.Vector3;
  halfWidth: number;
  halfHeight: number;
  targetY: number;
  deploy: number;
  group: THREE.Group;
  pulse: number;
}

interface FlightRouteVisual {
  runtime: FlightRouteRuntime;
  group: THREE.Group;
  ribbon: THREE.ShaderMaterial;
  rail: THREE.MeshBasicMaterial;
  ring: THREE.MeshBasicMaterial;
  gates: FlightGate[];
  deployActive: boolean;
  deployTime: number;
}

/**
 * Scalloped foam collar for a buoy's waterline: a flat annulus whose outer
 * edge zigzags (hard scallops, geometry not alpha). Sits as a child of the
 * buoy so it bobs and tilts with it. Normals are straight up.
 */
function makeFoamRingGeometry(): THREE.BufferGeometry {
  const SEG = 28; // 14 scallops
  const R_IN = 1.02;
  const R_OUT = 1.52;
  const pos = new Float32Array(SEG * 2 * 3);
  const nrm = new Float32Array(SEG * 2 * 3);
  const idx: number[] = [];
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    const ro = i % 2 === 0 ? R_OUT : R_OUT * 0.82; // zigzag => scalloped rim
    pos[i * 6] = Math.cos(a) * R_IN;
    pos[i * 6 + 2] = Math.sin(a) * R_IN;
    pos[i * 6 + 3] = Math.cos(a) * ro;
    pos[i * 6 + 5] = Math.sin(a) * ro;
    nrm[i * 6 + 1] = 1;
    nrm[i * 6 + 4] = 1;
  }
  for (let i = 0; i < SEG; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = ((i + 1) % SEG) * 2;
    const d = c + 1;
    idx.push(a, c, b, b, c, d); // +Y winding
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  return geo;
}

// ================================================================ Course ====

export class Course implements ICourse {
  readonly object: THREE.Object3D;
  readonly length = LAP_LENGTH;
  readonly checkpoints = CHECKPOINT_US.length;
  readonly flightRoutes = FLIGHT_ROUTES;
  readonly flightEntryU = FLIGHT_ENTRY_U;
  readonly flightExitU = FLIGHT_EXIT_U;
  readonly flightGateUs = FLIGHT_GATE_US;

  private readonly ribbonMat: THREE.ShaderMaterial;
  private readonly stripMat: THREE.ShaderMaterial;
  private readonly flightVisuals: FlightRouteVisual[];
  private readonly floaters: Floater[] = [];
  private readonly flightPrev: THREE.Vector3[] = [];
  private readonly flightPrevClearance: number[] = [];
  private readonly flightLatched: number[] = [];
  private readonly flightOffCorridorT: number[] = [];
  private readonly flightOffCorridorD: number[] = [];
  private readonly flightDebug: string[] = [];
  private readonly flightTurnWarn: boolean[] = [];
  private flightWarn = 0;
  private flightWarnRoute = -1;
  private playerFlightReady = false;
  private playerFlightIndex = 0;
  private playerFlightPressure = 0;
  private flightFlowTime = 0;
  private playerSurfaceU = 0;
  private activeGuideRoute = -1;

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'course';
    this.ribbonMat = this.buildRibbon();
    this.stripMat = this.buildStartStrip();
    this.flightVisuals = FLIGHT_RUNTIME.map((runtime) => this.buildFlightRoute(runtime));
    this.buildGates();
  }

  /** Closed loop; u wraps. Arc-length normalized. */
  pointAt(u: number, out: THREE.Vector3): THREE.Vector3 {
    return CURVE.getPointAt(wrapU(u), out);
  }

  /**
   * Unit XZ tangent at arc-length u. Central difference on getPointAt —
   * Curve.getTangent would allocate two Vector3 per call.
   */
  tangentAt(u: number, out: THREE.Vector3): THREE.Vector3 {
    const w = wrapU(u);
    CURVE.getPointAt(wrapU(w + TAN_DU), out);
    CURVE.getPointAt(wrapU(w - TAN_DU), _ta);
    out.sub(_ta);
    out.y = 0;
    const l = Math.hypot(out.x, out.z) || 1;
    out.x /= l;
    out.z /= l;
    return out;
  }

  routePointAt(routeId: CourseRouteId, u: number, out: THREE.Vector3): THREE.Vector3 {
    // Lookahead is allowed to run through both joins. Returning to the surface
    // curve outside the authored span keeps AI from targeting a clamped end
    // point and spinning at the merge.
    if (routeId === 'surface') return this.pointAt(u, out);
    const runtime = flightRuntime(routeId);
    if (u < runtime.def.entryU || u > runtime.def.exitU) return this.pointAt(u, out);
    return runtime.curve.getPoint(flightCurveT(runtime.def, u), out);
  }

  routeTangentAt(routeId: CourseRouteId, u: number, out: THREE.Vector3): THREE.Vector3 {
    if (routeId === 'surface') return this.tangentAt(u, out);
    const runtime = flightRuntime(routeId);
    if (u < runtime.def.entryU || u > runtime.def.exitU) return this.tangentAt(u, out);
    runtime.curve.getTangent(flightCurveT(runtime.def, u), out);
    out.y = 0;
    const l = Math.hypot(out.x, out.z) || 1;
    out.x /= l;
    out.z /= l;
    return out;
  }

  /**
   * Nearest-spline lookup: table coarse scan + parabolic refine, then one
   * projection step against the TRUE curve (the table's linear interpolation
   * cuts tight corners by up to ~1.4m). Zero allocation.
   */
  sample(pos: THREE.Vector3, out: CourseSample, routeHint: CourseRouteId = 'surface'): CourseSample {
    nearestOnSpline(pos.x, pos.z);
    let u = _near.u;
    CURVE.getPointAt(u, _sp);
    this.tangentAt(u, out.tangent);
    const du = ((pos.x - _sp.x) * out.tangent.x + (pos.z - _sp.z) * out.tangent.z) / LAP_LENGTH;
    u = wrapU(u + du);
    CURVE.getPointAt(u, _sp);
    this.tangentAt(u, out.tangent);
    out.u = u;
    out.point.set(_sp.x, 0, _sp.z);
    out.distance = Math.hypot(pos.x - _sp.x, pos.z - _sp.z);
    out.routeId = 'surface';

    if (routeHint !== 'surface') {
      const runtime = flightRuntime(routeHint);
      nearestOnFlight(runtime, pos.x, pos.z);
      const near = runtime.near;
      if (near.distance <= 32) {
        out.u = near.u;
        out.point.set(near.x, near.y, near.z);
        const il = 1 / (Math.hypot(near.tx, near.tz) || 1);
        out.tangent.set(near.tx * il, 0, near.tz * il);
        out.distance = near.distance;
        out.routeId = routeHint;
      }
    }
    return out;
  }

  routeForBoat(id: number): CourseRouteId {
    const index = this.flightLatched[id] ?? -1;
    return index >= 0 ? FLIGHT_ROUTES[index].id : 'surface';
  }

  flightTurnWarning(id: number): boolean {
    return this.flightTurnWarn[id] ?? false;
  }

  resetFlightChallenge(): void {
    this.flightPrev.length = 0;
    this.flightPrevClearance.length = 0;
    this.flightLatched.length = 0;
    this.flightOffCorridorT.length = 0;
    this.flightOffCorridorD.length = 0;
    this.flightDebug.length = 0;
    this.flightTurnWarn.length = 0;
    this.flightWarn = 0;
    this.flightWarnRoute = -1;
    this.playerFlightReady = false;
    this.playerFlightIndex = 0;
    this.playerFlightPressure = 0;
    this.flightFlowTime = 0;
    this.playerSurfaceU = 0;
    this.activeGuideRoute = -1;
    this.ribbonMat.uniforms.uGuideActive.value = 0;
    for (const visual of this.flightVisuals) {
      visual.group.visible = false;
      visual.deployActive = false;
      visual.deployTime = 0;
      for (const gate of visual.gates) {
        gate.deploy = 0;
        gate.pulse = 0;
      }
    }
    for (const floater of this.floaters) floater.obj.visible = true;
  }

  /** Deterministic harness diagnostic for the single-guide contract. */
  guidanceStatus(): { activeRouteIndex: number; visibleRouteCount: number; surfaceMaskRouteIndex: number; playerSurfaceU: number } {
    return {
      activeRouteIndex: this.activeGuideRoute,
      visibleRouteCount: this.flightVisuals.reduce((sum, visual) => sum + (visual.group.visible ? 1 : 0), 0),
      surfaceMaskRouteIndex: this.activeGuideRoute,
      playerSurfaceU: this.playerSurfaceU,
    };
  }

  /** Deterministic harness diagnostic; updated only on route state edges. */
  flightDebugStatus(id: number): string {
    return this.flightDebug[id] ?? 'idle';
  }

  private failFlight(
    boat: IBoat,
    visual: FlightRouteVisual,
    reason: FlightRouteFailReason,
    routeU: number,
    targetGate: number | null,
    lateralOffsetM: number | null = null,
    lateralLimitM: number | null = null,
    corridorDistanceM: number | null = null,
  ): void {
    const gatesPassed = boat.state.flightGateProgress;
    boat.applyFlightRouteMiss({
      reason,
      flightNumber: boat.state.flightRouteCursor + 1,
      routeSlot: visual.runtime.def.index,
      flightsCleared: boat.state.flightsCleared,
      gatesPassed,
      gateCount: visual.gates.length,
      targetGate: targetGate ?? Math.min(visual.gates.length, gatesPassed + 1),
      routeU,
      lateralOffsetM,
      lateralLimitM,
      corridorDistanceM,
      clearanceM: boat.state.flightClearance,
    });
  }

  updateFlightRoute(dt: number, boats: readonly IBoat[]): void {
    for (const boat of boats) {
      const id = boat.id;
      const pos = boat.state.position;
      const st = boat.state;
      if (st.flightRouteState === 'idle') this.flightDebug[id] = 'idle';
      if (id === 0) {
        this.playerFlightReady = st.flightReady;
        this.playerFlightIndex = st.flightRouteIndex >= 0
          ? st.flightRouteIndex
          : st.flightRouteCursor % FLIGHT_ROUTES.length;
        this.playerFlightPressure = st.flightPressure;
      }
      let prev = this.flightPrev[id];
      if (!prev) {
        prev = new THREE.Vector3().copy(pos);
        this.flightPrev[id] = prev;
        this.flightPrevClearance[id] = st.flightClearance;
        this.flightLatched[id] = -1;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
        continue;
      }

      const jump = prev.distanceToSquared(pos) > 60 * 60;
      this.sample(pos, _routeSample, 'surface');
      const surfaceU = _routeSample.u;
      if (id === 0) this.playerSurfaceU = surfaceU;
      const flightActive = st.flightPhase !== 'surface';
      const routeIndex = st.flightRouteIndex >= 0
        ? st.flightRouteIndex
        : st.flightRouteCursor % FLIGHT_ROUTES.length;
      const visual = this.flightVisuals[routeIndex];
      if (!visual) {
        prev.copy(pos);
        this.flightPrevClearance[id] = st.flightClearance;
        continue;
      }
      const runtime = visual.runtime;
      const def = runtime.def;
      nearestOnFlight(runtime, pos.x, pos.z);
      const near = runtime.near;
      if (id === 0 && (flightActive || st.flightRouteState !== 'idle' ||
          (surfaceU >= def.qualifyFromU && surfaceU <= def.exitU + 0.01))) visual.deployActive = true;
      this.flightTurnWarn[id] = flightActive && st.flightRouteState === 'active' &&
        near.u >= def.turnWarningFromU && near.u <= def.turnWarningToU;

      if (jump) {
        if (st.flightRouteState === 'active') this.failFlight(boat, visual, 'teleport', surfaceU, null);
        this.flightLatched[id] = -1;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
        prev.copy(pos);
        this.flightPrevClearance[id] = st.flightClearance;
        continue;
      }

      if (st.flightRouteState === 'passed' && !flightActive) {
        boat.settleFlightRoute();
        this.flightLatched[id] = -1;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
        prev.copy(pos);
        this.flightPrevClearance[id] = st.flightClearance;
        continue;
      }

      const insideAttemptSpan = surfaceU >= def.entryU - FLIGHT_ATTEMPT_EARLY_U && surfaceU <= def.exitU + 0.006;
      const crossedChallengeEntry = surfaceU >= def.entryU - 0.001;
      if (flightActive && st.flightRouteState === 'idle' && insideAttemptSpan &&
          (near.distance <= def.corridorHalfWidth || crossedChallengeEntry)) {
        boat.beginFlightRouteAttempt(routeIndex, st.flightRouteCursor, def.targetSpeed);
        this.flightDebug[id] = 'active';
        this.flightLatched[id] = routeIndex;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
        if (near.u > visual.gates[0].u + FLIGHT_GATE_BYPASS_U) {
          this.failFlight(boat, visual, 'late', near.u, 1);
        }
      }

      if (!flightActive && st.flightRouteState === 'idle' && insideAttemptSpan &&
          surfaceU >= def.gateUs[0] - FLIGHT_GATE_BYPASS_U) {
        boat.beginFlightRouteAttempt(routeIndex, st.flightRouteCursor, def.targetSpeed);
        this.flightDebug[id] = 'no-launch';
        this.failFlight(boat, visual, 'no_launch', surfaceU, 1);
      }

      if (st.flightRouteState === 'active') {
        this.flightLatched[id] = routeIndex;
        const gateIndex = st.flightGateProgress;
        const gate = visual.gates[gateIndex];
        if (gate && flightActive) {
          const d0 = (prev.x - gate.center.x) * gate.normal.x + (prev.z - gate.center.z) * gate.normal.z;
          const d1 = (pos.x - gate.center.x) * gate.normal.x + (pos.z - gate.center.z) * gate.normal.z;
          if (d0 <= 0 && d1 > 0) {
            const f = d0 / (d0 - d1);
            const ix = prev.x + (pos.x - prev.x) * f;
            const iz = prev.z + (pos.z - prev.z) * f;
            const previousClearance = this.flightPrevClearance[id] ?? st.flightClearance;
            const crossingClearance = previousClearance + (st.flightClearance - previousClearance) * f;
            const lateral = (ix - gate.center.x) * gate.right.x + (iz - gate.center.z) * gate.right.z;
            const lateralLimit = def.passHalfWidth;
            const certifiedPhase = st.flightPhase === 'ascending' || st.flightPhase === 'cruise';
            if (!certifiedPhase || crossingClearance < 2.8) {
              this.flightDebug[id] = `late-height:f${routeIndex + 1}:y${crossingClearance.toFixed(2)}`;
              this.failFlight(boat, visual, 'late', gate.u, gateIndex + 1, lateral, lateralLimit);
            } else if (Math.abs(lateral) <= lateralLimit) {
              boat.applyFlightGatePass(gateIndex);
              if (id === 0) gate.pulse = 0.36;
              if (gateIndex + 1 >= visual.gates.length) {
                boat.completeFlightRoute(routeIndex, st.flightRouteCursor);
                this.flightDebug[id] = 'passed';
              }
            } else {
              const reason = lateral < 0 ? 'gate_left' : 'gate_right';
              this.flightDebug[id] = `gate${gateIndex + 1}:lat${lateral.toFixed(2)}:limit${lateralLimit.toFixed(2)}`;
              this.failFlight(boat, visual, reason, gate.u, gateIndex + 1, lateral, lateralLimit);
              this.flightWarn = 0.8;
              this.flightWarnRoute = routeIndex;
            }
          }
          if (st.flightRouteState === 'active' && near.u > gate.u + FLIGHT_GATE_BYPASS_U) {
            this.flightDebug[id] = `bypass${gateIndex + 1}:u${near.u.toFixed(4)}`;
            this.failFlight(boat, visual, 'gate', near.u, gateIndex + 1);
            this.flightWarn = 0.8;
            this.flightWarnRoute = routeIndex;
          }
        }
      }

      if (st.flightRouteState === 'active') {
        if (!flightActive || st.flightPhase === 'descending') {
          this.flightDebug[id] = `landing:g${st.flightGateProgress}`;
          this.failFlight(boat, visual, 'landing', near.u, null);
        } else {
          const outside = near.distance > def.corridorHalfWidth;
          const offT = outside
            ? (this.flightOffCorridorT[id] ?? 0) + dt
            : Math.max(0, (this.flightOffCorridorT[id] ?? 0) - dt * 2);
          const offD = outside
            ? (this.flightOffCorridorD[id] ?? 0) + Math.sqrt(prev.distanceToSquared(pos))
            : Math.max(0, (this.flightOffCorridorD[id] ?? 0) - dt * 20);
          this.flightOffCorridorT[id] = offT;
          this.flightOffCorridorD[id] = offD;
          if (offT >= FLIGHT_CORRIDOR_GRACE) {
            this.flightDebug[id] = `corridor:${near.distance.toFixed(2)}:f${routeIndex + 1}`;
            this.flightWarn = Math.max(this.flightWarn, 0.25);
            this.flightWarnRoute = routeIndex;
          }
          if (offT >= FLIGHT_CORRIDOR_FAIL || offD >= FLIGHT_CORRIDOR_FAIL_DISTANCE) {
            this.failFlight(boat, visual, 'corridor', near.u, null, null, null, near.distance);
            this.flightWarn = 0.8;
            this.flightWarnRoute = routeIndex;
          }
        }
      }

      if (st.flightRouteState === 'active' && surfaceU > def.exitU + 0.006) {
        this.flightDebug[id] = `exit:g${st.flightGateProgress}`;
        this.failFlight(boat, visual, 'exit', surfaceU, null);
        this.flightWarn = 0.8;
        this.flightWarnRoute = routeIndex;
      }

      if (st.flightRouteMiss) this.flightWarn = 0.8;

      if (st.flightRouteState !== 'active' &&
          (!flightActive || surfaceU < def.entryU - 0.03 || surfaceU > def.exitU + 0.006)) {
        if (st.flightRouteState !== 'passed') this.flightLatched[id] = -1;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
      }

      prev.copy(pos);
      this.flightPrevClearance[id] = st.flightClearance;
    }
    this.updatePlayerGuidance(boats[0]);
  }

  /** Contact separation changes the next frame's baseline, never the just-checked flight path. */
  syncFlightTrackingAfterCollisions(boats: readonly IBoat[]): void {
    for (const boat of boats) {
      const prev = this.flightPrev[boat.id];
      if (prev) prev.copy(boat.state.position);
      this.flightPrevClearance[boat.id] = boat.state.flightClearance;
    }
  }

  private updatePlayerGuidance(player: IBoat | undefined): void {
    let next = -1;
    if (player) {
      const st = player.state;
      const slot = st.flightRouteIndex >= 0 ? st.flightRouteIndex : st.flightRouteCursor % FLIGHT_ROUTES.length;
      const def = FLIGHT_ROUTES[slot];
      if (def && (st.flightRouteState !== 'idle' || st.flightPhase !== 'surface' ||
          (this.playerSurfaceU >= def.qualifyFromU && this.playerSurfaceU <= def.exitU + 0.01))) {
        next = slot;
      }
    }
    if (next !== this.activeGuideRoute) {
      for (let i = 0; i < this.flightVisuals.length; i++) {
        const visual = this.flightVisuals[i];
        visual.group.visible = i === next;
        if (i !== next) {
          visual.deployActive = false;
          visual.deployTime = 0;
          for (const gate of visual.gates) {
            gate.deploy = 0;
            gate.pulse = 0;
          }
        }
      }
      this.activeGuideRoute = next;
    }
    const active = next >= 0 ? FLIGHT_ROUTES[next] : null;
    this.ribbonMat.uniforms.uGuideActive.value = active ? 1 : 0;
    this.ribbonMat.uniforms.uMaskStart.value = active ? Math.max(0, active.entryU * LAP_LENGTH - 4) : 0;
    this.ribbonMat.uniforms.uMaskEnd.value = active ? Math.min(LAP_LENGTH, active.exitU * LAP_LENGTH + 8) : 0;
    for (const floater of this.floaters) {
      floater.obj.visible = !active || floater.routeU === undefined ||
        floater.routeU <= active.entryU + 0.002 || floater.routeU > active.exitU;
    }
  }

  update(dt: number, t: number): void {
    this.ribbonMat.uniforms.uTime.value = t;
    this.ribbonMat.uniforms.uPlayerS.value = this.playerSurfaceU * LAP_LENGTH;
    this.stripMat.uniforms.uTime.value = t;
    this.flightWarn = Math.max(0, this.flightWarn - dt);
    this.flightFlowTime += dt * (1 + this.playerFlightPressure * 1.4);
    const readyStep = this.playerFlightReady && Math.floor(t * 4) % 2 === 0 ? 1 : 0;
    for (let routeIndex = 0; routeIndex < this.flightVisuals.length; routeIndex++) {
      const visual = this.flightVisuals[routeIndex];
      if (visual.deployActive) visual.deployTime += dt;
      const warn = this.flightWarnRoute === routeIndex ? Math.min(1, this.flightWarn * 4) : 0;
      const upcoming = routeIndex === this.playerFlightIndex;
      visual.ribbon.uniforms.uTime.value = this.flightFlowTime;
      visual.ribbon.uniforms.uWarn.value = warn;
      visual.ribbon.uniforms.uReady.value = upcoming && this.playerFlightReady ? 1 : 0;
      visual.ribbon.uniforms.uTurn.value = upcoming && this.flightTurnWarn[0] ? 1 : 0;
      visual.rail.color.setHex(warn > 0.5 ? PALETTE.uiWarn : PALETTE.flight, THREE.NoColorSpace);
      visual.ring.color.setHex(warn > 0.5 ? PALETTE.uiWarn : PALETTE.flight, THREE.NoColorSpace);
      visual.rail.opacity = warn > 0.5 ? 1 : 0.76 + (upcoming ? readyStep * 0.18 : 0);
      visual.ring.opacity = warn > 0.5 ? 1 : 0.78 + (upcoming ? readyStep * 0.2 : 0);
      for (let i = 0; i < visual.gates.length; i++) {
        const gate = visual.gates[i];
        const raw = Math.max(0, Math.min(1, (visual.deployTime - i * 0.12) / 0.5));
        gate.deploy = raw * raw * (3 - 2 * raw);
        const surface = waterHeight(gate.center.x, gate.center.z, t);
        const submerged = surface - gate.halfHeight - 2.8;
        gate.center.y = submerged + (gate.targetY - submerged) * gate.deploy;
        gate.group.position.y = gate.center.y;
        gate.pulse = Math.max(0, gate.pulse - dt);
        const p = gate.pulse / 0.36;
        gate.group.scale.setScalar(1 + p * 0.1);
      }
    }
    for (const f of this.floaters) {
      f.obj.position.y = waterHeight(f.x, f.z, t);
      waterNormalInto(_n, f.x, f.z, t);
      _q.setFromUnitVectors(UP, _n).multiply(f.yawQ);
      f.obj.quaternion.copy(_q);
    }
  }

  // ------------------------------------------------------- flight route ----

  private buildFlightRoute(runtime: FlightRouteRuntime): FlightRouteVisual {
    const def = runtime.def;
    const routeGroup = new THREE.Group();
    routeGroup.name = `${def.id}-guide`;
    routeGroup.visible = false;
    this.object.add(routeGroup);
    const SEG = Math.max(64, Math.ceil(runtime.curve.getLength() / 1.8));
    const HALF_W = def.corridorHalfWidth;
    const pos = new Float32Array((SEG + 1) * 2 * 3);
    const uv = new Float32Array((SEG + 1) * 2 * 2);
    const idx = new Uint16Array(SEG * 6);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();

    for (let i = 0; i <= SEG; i++) {
      const f = i / SEG;
      const u = def.entryU + (def.exitU - def.entryU) * f;
      this.routePointAt(def.id, u, p);
      this.routeTangentAt(def.id, u, t);
      const rx = t.z;
      const rz = -t.x;
      const o = i * 6;
      pos[o] = p.x + rx * HALF_W;
      pos[o + 1] = p.y + 0.05;
      pos[o + 2] = p.z + rz * HALF_W;
      pos[o + 3] = p.x - rx * HALF_W;
      pos[o + 4] = p.y + 0.05;
      pos[o + 5] = p.z - rz * HALF_W;
      const q = i * 4;
      uv[q] = 0;
      uv[q + 1] = f;
      uv[q + 2] = 1;
      uv[q + 3] = f;
      if (i < SEG) {
        const k = i * 6;
        const a = i * 2;
        idx[k] = a;
        idx[k + 1] = a + 1;
        idx[k + 2] = a + 2;
        idx[k + 3] = a + 1;
        idx[k + 4] = a + 3;
        idx[k + 5] = a + 2;
      }
    }

    const ribbonGeo = new THREE.BufferGeometry();
    ribbonGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    ribbonGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    ribbonGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    const ribbonMat = new THREE.ShaderMaterial({
      name: 'FlightRoute',
      uniforms: {
        uTime: { value: 0 },
        uWarn: { value: 0 },
        uReady: { value: 0 },
        uTurn: { value: 0 },
        uFlight: { value: new THREE.Color().setHex(PALETTE.flight, THREE.NoColorSpace) },
        uMystic: { value: new THREE.Color().setHex(0x9b7cff, THREE.NoColorSpace) },
        uWarnColor: { value: new THREE.Color().setHex(PALETTE.uiWarn, THREE.NoColorSpace) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uWarn;
        uniform float uReady;
        uniform float uTurn;
        uniform vec3 uFlight;
        uniform vec3 uMystic;
        uniform vec3 uWarnColor;
        varying vec2 vUv;
        void main() {
          float wave = sin(vUv.y * 52.0 - uTime * 5.5) * 0.035;
          float flowA = 1.0 - smoothstep(0.012, 0.029, abs(vUv.x - (0.44 + wave)));
          float flowB = 1.0 - smoothstep(0.012, 0.029, abs(vUv.x - (0.56 - wave)));
          float packetPhase = fract(vUv.y * 13.0 - uTime * 1.9);
          float packet = smoothstep(0.02, 0.16, packetPhase) * (1.0 - smoothstep(0.55, 0.82, packetPhase));
          float flow = max(flowA, flowB) * (0.28 + packet * 0.72);
          float turnZone = smoothstep(0.08, 0.22, vUv.y) * (1.0 - smoothstep(0.7, 0.9, vUv.y));
          vec3 airColor = mix(uFlight, uMystic, 0.5 + 0.5 * sin(vUv.y * 24.0 - uTime * 3.0));
          vec3 color = mix(airColor, uWarnColor, max(uWarn, uTurn * turnZone));
          float ready = uReady * step(0.5, fract(uTime * 4.0));
          float edge = 1.0 - smoothstep(0.0, 0.08, min(vUv.x, 1.0 - vUv.x));
          float alpha = edge * 0.1 + flow * (0.28 + ready * 0.1);
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
    ribbon.name = `${def.id}-ribbon`;
    ribbon.renderOrder = 3;
    ribbon.layers.enable(LAYER_ENERGY);
    routeGroup.add(ribbon);

    const railMat = new THREE.MeshBasicMaterial({
      color: PALETTE.flight,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
    });
    for (const side of [-1, 1]) {
      const railPoints: THREE.Vector3[] = [];
      for (let i = 0; i <= 36; i++) {
        const f = i / 36;
        const u = def.entryU + (def.exitU - def.entryU) * f;
        this.routePointAt(def.id, u, p);
        this.routeTangentAt(def.id, u, t);
        railPoints.push(new THREE.Vector3(p.x + t.z * HALF_W * side, p.y + 0.12, p.z - t.x * HALF_W * side));
      }
      const railCurve = new THREE.CatmullRomCurve3(railPoints, false, 'centripetal');
      const rail = new THREE.Mesh(new THREE.TubeGeometry(railCurve, 120, 0.065, 5, false), railMat);
      rail.name = `${def.id}-rail-${side > 0 ? 'r' : 'l'}`;
      rail.renderOrder = 4;
      rail.layers.enable(LAYER_ENERGY);
      routeGroup.add(rail);
    }

    const ringMat = new THREE.MeshBasicMaterial({
      color: PALETTE.flight,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      toneMapped: false,
    });
    const coreMat = new THREE.MeshBasicMaterial({
      color: PALETTE.foam,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
    });
    const lockMat = new THREE.MeshBasicMaterial({
      map: makeFlightLockTexture(),
      color: PALETTE.foam,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const lockBeamMat = new THREE.MeshBasicMaterial({
      color: PALETTE.uiWarn,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
    });
    const pillarGeo = new THREE.CylinderGeometry(1, 1.2, 1, 10);
    const corePillarGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
    const beamGeo = new THREE.BoxGeometry(1, 1, 1);
    const buoyGeo = new THREE.SphereGeometry(1, 10, 6);
    const forward = new THREE.Vector3(0, 0, 1);
    const tangent3 = new THREE.Vector3();
    // Controlled flight follows the live water surface, while these authored
    // gates are world-static. A 1.8m vertical radius absorbs wave elevation
    // without allowing a surface boat (roughly y <= 1.2m) through.
    const gates: FlightGate[] = [];
    const gateHalfHeight = 1.8;
    for (let i = 0; i < def.gateUs.length; i++) {
      const u = def.gateUs[i];
      const center = this.routePointAt(def.id, u, new THREE.Vector3());
      runtime.curve.getTangent(flightCurveT(def, u), tangent3).normalize();
      const normal = new THREE.Vector3(tangent3.x, 0, tangent3.z).normalize();
      const right = new THREE.Vector3(normal.z, 0, -normal.x);
      const gateGroup = new THREE.Group();
      gateGroup.name = `${def.id}-gate-${i + 1}`;
      gateGroup.position.copy(center);
      gateGroup.quaternion.setFromUnitVectors(forward, tangent3);
      const pillarHeight = gateHalfHeight * 2 + 1.8;
      const corePillars: THREE.Mesh[] = [];
      for (const side of [-1, 1]) {
        const outer = new THREE.Mesh(pillarGeo, ringMat);
        outer.position.set(side * def.gateHalfWidth, 0, 0);
        outer.scale.set(0.5, pillarHeight, 0.5);
        const core = new THREE.Mesh(corePillarGeo, coreMat);
        corePillars.push(core);
        core.position.copy(outer.position);
        core.scale.set(0.16, pillarHeight * 1.04, 0.16);
        const buoy = new THREE.Mesh(buoyGeo, ringMat);
        buoy.position.set(side * def.gateHalfWidth, -pillarHeight * 0.46, 0);
        buoy.scale.set(0.95, 0.55, 0.95);
        gateGroup.add(outer, core, buoy);
      }
      const beam = new THREE.Mesh(beamGeo, ringMat);
      beam.position.y = gateHalfHeight + 0.55;
      beam.scale.set(def.gateHalfWidth * 2 + 1, 0.34, 0.42);
      const beamCore = new THREE.Mesh(beamGeo, coreMat);
      beamCore.position.copy(beam.position);
      beamCore.scale.set(def.gateHalfWidth * 2 + 0.4, 0.1, 0.16);
      const surfaceLock = new THREE.Mesh(new THREE.PlaneGeometry(def.gateHalfWidth * 2, 2.5), lockMat);
      surfaceLock.position.y = -center.y + 1.45;
      surfaceLock.position.z = 0.14;
      const lockBeam = new THREE.Mesh(beamGeo, lockBeamMat);
      lockBeam.position.set(0, -center.y + 2.8, 0.08);
      lockBeam.scale.set(def.gateHalfWidth * 2 + 0.6, 0.12, 0.18);
      gateGroup.add(beam, beamCore, surfaceLock, lockBeam);
      gateGroup.traverse((o) => o.layers.enable(LAYER_ENERGY));
      surfaceLock.layers.disable(LAYER_ENERGY);
      beamCore.layers.disable(LAYER_ENERGY);
      for (const core of corePillars) core.layers.disable(LAYER_ENERGY);
      gateGroup.renderOrder = 5;
      routeGroup.add(gateGroup);
      gates.push({
        u,
        center,
        normal,
        right,
        halfWidth: def.gateHalfWidth,
        halfHeight: gateHalfHeight,
        targetY: center.y,
        deploy: 0,
        group: gateGroup,
        pulse: 0,
      });
    }

    return {
      runtime,
      group: routeGroup,
      ribbon: ribbonMat,
      rail: railMat,
      ring: ringMat,
      gates,
      deployActive: false,
      deployTime: 0,
    };
  }

  // ------------------------------------------------------------- ribbon ----

  /** ~3.4m wide mitre-joined ribbon hugging the spline; one draw call; OFF LAYER_INK. */
  private buildRibbon(): THREE.ShaderMaterial {
    const rows = RIBBON_SEGS + 1;
    const pos = new Float32Array(rows * 2 * 3);
    const uv = new Float32Array(rows * 2 * 2);
    const idx = new Uint32Array(RIBBON_SEGS * 6);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    for (let i = 0; i < rows; i++) {
      const u = (i % RIBBON_SEGS) / RIBBON_SEGS; // last row closes the loop
      CURVE.getPointAt(u, p);
      CURVE.getTangentAt(u, t);
      const il = 1 / (Math.hypot(t.x, t.z) || 1);
      const lx = -t.z * il; // left normal of the tangent
      const lz = t.x * il;
      const s = i * (LAP_LENGTH / RIBBON_SEGS); // arc-length station (m)
      pos[i * 6] = p.x + lx * RIBBON_HALF_W;
      pos[i * 6 + 1] = 0;
      pos[i * 6 + 2] = p.z + lz * RIBBON_HALF_W;
      pos[i * 6 + 3] = p.x - lx * RIBBON_HALF_W;
      pos[i * 6 + 4] = 0;
      pos[i * 6 + 5] = p.z - lz * RIBBON_HALF_W;
      uv[i * 4] = s;
      uv[i * 4 + 1] = 1;
      uv[i * 4 + 2] = s;
      uv[i * 4 + 3] = -1;
    }
    for (let i = 0; i < RIBBON_SEGS; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      idx[i * 6] = a;
      idx[i * 6 + 1] = b;
      idx[i * 6 + 2] = c;
      idx[i * 6 + 3] = b;
      idx[i * 6 + 4] = d;
      idx[i * 6 + 5] = c;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = buildRibbonMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'racing-line';
    mesh.frustumCulled = false; // spans the whole course
    mesh.renderOrder = 2; // over the water
    this.object.add(mesh);
    return mat;
  }

  // -------------------------------------------------------- start strip ----

  /**
   * Start/finish checker strip painted on the water at u=0: 2 rows of cells
   * laid ALONG the spline direction (never world-axis-aligned square soup).
   * Rides the swell exactly like the ribbon (+0.04 so it paints over the
   * ribbon where they cross); hard cells, same banded distance fade as the
   * ribbon. One draw call, OFF LAYER_INK.
   */
  private buildStartStrip(): THREE.ShaderMaterial {
    const W = 15; // across the gate (towers sit at ±8.5)
    const D = 2.6; // 2 rows of 1.3m cells
    const CELLS_X = 12;
    const CELLS_Y = 2;
    const geo = new THREE.PlaneGeometry(W, D, CELLS_X, CELLS_Y);
    geo.rotateX(-Math.PI / 2); // flat: local x across the track, z along it
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    CURVE.getPointAt(0, p);
    CURVE.getTangentAt(0, t);
    geo.rotateY(Math.atan2(t.x, t.z)); // cells track the spline direction
    geo.translate(p.x, 0, p.z);
    const mat = new THREE.ShaderMaterial({
      name: 'StartStrip',
      uniforms: {
        uTime: { value: 0 },
        uFoam: { value: new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace) },
        uInk: { value: new THREE.Color().setHex(PALETTE.ink, THREE.NoColorSpace) },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying float vDist;
        ${WAVES_GLSL}
        void main() {
          vec3 p = position;
          // ride the swell instead of clipping through it (just above the ribbon)
          p.y = waveHeight(p.xz, uTime) + 0.26;
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uFoam;
        uniform vec3 uInk;
        varying vec2 vUv;
        varying float vDist;
        void main() {
          // hard checker in strip space (u across, v along the track)
          vec2 cell = floor(vec2(vUv.x * ${CELLS_X}.0, vUv.y * ${CELLS_Y}.0));
          float parity = mod(cell.x + cell.y, 2.0);
          vec3 col = mix(uInk, uFoam, parity);
          // same 2-step banded distance fade as the racing line
          float fade = vDist < 220.0 ? 1.0 : (vDist < 600.0 ? 0.62 : 0.3);
          gl_FragColor = vec4(col, 0.95 * fade);
        }
      `,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'start-strip';
    mesh.frustumCulled = false; // the vertex shader displaces y
    mesh.renderOrder = 3; // over the ribbon where they cross
    this.object.add(mesh);
    return mat;
  }

  // -------------------------------------------------------------- gates ----

  private buildGates(): void {
    const stripeTex = makeStripeTexture();
    const bodyMat = makeStripeToon(stripeTex);
    // committed accent: orange cap matching the body's accent band — no more
    // random green wizard hats fighting the racing line
    const coneMat = createToonMaterial({
      color: PALETTE.hullReef,
      emissive: PALETTE.hullReef,
      emissiveIntensity: 0.5,
    });
    // float collar: deep ink-blue (ink lightened 70% toward waterDeep) —
    // the old near-black read as a void disc / distant black lump
    const floatBlue = new THREE.Color()
      .setHex(PALETTE.ink, THREE.NoColorSpace)
      .lerp(new THREE.Color().setHex(PALETTE.waterDeep, THREE.NoColorSpace), 0.7)
      .getHex();
    const floatMat = createToonMaterial({ color: floatBlue });
    // scalloped foam collar at the waterline, seats the buoy on the surface
    const foamRingMat = createToonMaterial({
      color: PALETTE.foam,
      emissive: PALETTE.foam,
      emissiveIntensity: 0.4,
    });
    foamRingMat.side = THREE.DoubleSide;
    // gantry post: foam-white shaft with ink bands + green collar (stripe toon),
    // so even the shadow band reads as a color instead of a dead ink void
    const towerMat = makeStripeToon(makeTowerTexture());
    const towerCapMat = createToonMaterial({
      color: PALETTE.hullPlayer,
      emissive: PALETTE.hullPlayer,
      emissiveIntensity: 0.5,
    });
    // banner is double-FACED (two FrontSide planes back to back): START on the
    // approach face, race checker on the reverse — the old single DoubleSide
    // plane read as a washed-out mirrored START from beyond the line
    const bannerFrontMat = makeStripeToon(makeStartTexture(), 0.8);
    const bannerBackMat = makeStripeToon(makeCheckerTexture(), 0.8);

    // ~30% smaller float: the old disc was wider than the buoy above it is tall
    const floatGeo = new THREE.TorusGeometry(0.88, 0.3, 10, 20);
    floatGeo.rotateX(Math.PI / 2);
    const bodyGeo = new THREE.CylinderGeometry(0.75, 0.85, 1.9, 14);
    const coneGeo = new THREE.ConeGeometry(0.66, 0.85, 14); // short squat cap, not a spire
    const foamRingGeo = makeFoamRingGeometry();
    const towerGeo = new THREE.CylinderGeometry(0.72, 1.05, 10.0, 12);
    const towerCapGeo = new THREE.ConeGeometry(1.08, 1.5, 12);
    const bannerGeo = new THREE.PlaneGeometry(17, 2.6);

    const makeBuoy = (): THREE.Group => {
      const g = new THREE.Group();
      const f = new THREE.Mesh(floatGeo, floatMat);
      f.position.y = 0.35;
      const b = new THREE.Mesh(bodyGeo, bodyMat);
      b.position.y = 1.55;
      const c = new THREE.Mesh(coneGeo, coneMat);
      c.position.y = 2.93; // base sits on the body top (2.5), tip at 3.35
      // scalloped foam ring at the waterline: bobs/tilts with the buoy;
      // never outlined, never written into the ink prepass
      const ring = new THREE.Mesh(foamRingGeo, foamRingMat);
      ring.position.y = 0.1;
      ring.userData.noOutline = true;
      g.add(f, b, c, ring);
      // thinner ink than the gantry: full-width outlines on a far buoy merge
      // into a black cluster — at 0.75 the silhouette stays light-striped
      addOutline(g, { width: 0.75 });
      markInk(g);
      ring.layers.disable(LAYER_INK);
      return g;
    };

    const p = new THREE.Vector3();
    const t = new THREE.Vector3();

    // checkpoint gates: buoy pairs 14m apart, centred on the spline
    for (const u of CHECKPOINT_US) {
      CURVE.getPointAt(u, p);
      CURVE.getTangentAt(u, t);
      const il = 1 / (Math.hypot(t.x, t.z) || 1);
      const rx = t.z * il; // right normal
      const rz = -t.x * il;
      for (const side of [-1, 1]) {
        const buoy = makeBuoy();
        const x = p.x + rx * 7 * side;
        const z = p.z + rz * 7 * side;
        buoy.position.set(x, 0, z);
        this.object.add(buoy);
        this.floaters.push({ obj: buoy, x, z, yawQ: new THREE.Quaternion(), routeU: u });
      }
    }

    // START/FINISH gantry: two tall striped towers + banner slung high enough
    // that the chase camera (and airborne free cams) pass cleanly underneath
    CURVE.getPointAt(0, p);
    CURVE.getTangentAt(0, t);
    const heading = Math.atan2(-t.x, t.z);
    const gantry = new THREE.Group();
    for (const side of [-1, 1]) {
      const tower = new THREE.Group();
      const shaft = new THREE.Mesh(towerGeo, towerMat);
      shaft.position.y = 5.0;
      const cap = new THREE.Mesh(towerCapGeo, towerCapMat);
      cap.position.y = 10.6;
      tower.add(shaft, cap);
      tower.position.x = side * 8.5;
      gantry.add(tower);
    }
    // START face looks back at the approaching pack (local -Z = against
    // travel, see yawQ below); the checker face looks past the line
    const bannerFront = new THREE.Mesh(bannerGeo, bannerFrontMat);
    bannerFront.rotation.y = Math.PI;
    bannerFront.position.set(0, 8.6, -0.045);
    const bannerBack = new THREE.Mesh(bannerGeo, bannerBackMat);
    bannerBack.position.set(0, 8.6, 0.045);
    gantry.add(bannerFront, bannerBack);
    addOutline(gantry);
    markInk(gantry);
    gantry.position.set(p.x, 0, p.z);
    const yawQ = new THREE.Quaternion().setFromAxisAngle(UP, -heading);
    gantry.quaternion.copy(yawQ);
    this.object.add(gantry);
    this.floaters.push({ obj: gantry, x: p.x, z: p.z, yawQ });
  }
}
