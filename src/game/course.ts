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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  markInk,
  LAYER_ENERGY,
  LAYER_INK,
  type CourseRouteId,
  type CourseGuidanceStatus,
  type CourseSample,
  type FlightCourseRouteId,
  type FlightPhase,
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

/** Surface distance at which the run is no longer a missed launch attempt. */
export const SURFACE_ROUTE_FAIL_DISTANCE_M = 42;
const FINAL_PORTAL_HALF_WIDTH_M = 7.15;
const FINAL_PORTAL_MAX_STEP_M = 4;

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

function refineNearestOnSpline(x: number, z: number, bi: number, bd: number): void {
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
  refineNearestOnSpline(x, z, bi, bd);
}

/** Nearest surface point inside a bounded arc window around an accepted u. */
function nearestOnSplineNear(x: number, z: number, referenceU: number, maxDeltaU: number): void {
  const radius = Math.max(2, Math.min(Math.floor(TABLE_N / 2) - 1, Math.ceil(maxDeltaU * TABLE_N)));
  if (radius >= Math.floor(TABLE_N / 2) - 1) {
    nearestOnSpline(x, z);
    return;
  }
  const center = Math.round((((referenceU % 1) + 1) % 1) * TABLE_N) % TABLE_N;
  let bi = center;
  let bd = Infinity;
  for (let offset = -radius; offset <= radius; offset++) {
    const i = (center + offset + TABLE_N) % TABLE_N;
    const dx = x - TAB_X[i];
    const dz = z - TAB_Z[i];
    const d = dx * dx + dz * dz;
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  refineNearestOnSpline(x, z, bi, bd);
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
    navigation: {
      turn: { fromU: 0.258, toU: 0.292, direction: 'left' },
    },
  },
  {
    id: 'flight-3',
    index: 2,
    entryU: 0.39,
    exitU: 0.47,
    gateUs: [0.45],
    nodes: [
      { u: 0.39, lateral: 0, height: 0 },
      { u: 0.404, lateral: 13, height: 4.5 },
      { u: 0.419, lateral: 22, height: 4.5 },
      { u: 0.435, lateral: 11, height: 4.5 },
      { u: 0.47, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5,
    gateHalfWidth: 5,
    passHalfWidth: 5.25,
    targetSpeed: 48,
    qualifyFromU: 0.33,
    launchFromU: 0.375,
    launchToU: 0.398,
    turnWarningFromU: 0.397,
    turnWarningToU: 0.447,
    navigation: {
      turn: { fromU: 0.397, toU: 0.447, direction: 'left' },
      postGateRecovery: { handoffMarginM: 18, maxDurationS: 5.2 },
    },
  },
  {
    id: 'flight-4',
    index: 3,
    entryU: 0.515,
    exitU: 0.58,
    gateUs: [0.56],
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
    turnWarningFromU: 0.515,
    turnWarningToU: 0.558,
    navigation: {
      turn: { fromU: 0.515, toU: 0.558, direction: 'left' },
      locatorU: 0.56,
      // The medal resume leaves less usable turn-in time than the raw surface
      // distance suggests. Preview the branch at handoff and recommend an
      // earlier launch, while leaving AI timing, physics and scoring intact.
      guideFromU: 0.465,
      launchCueU: 0.493,
      launchVectorLengthM: 34,
      launchAlignM: 65,
    },
  },
  {
    id: 'flight-5',
    index: 4,
    entryU: 0.635,
    exitU: 0.72,
    gateUs: [0.69875],
    nodes: [
      { u: 0.635, lateral: 0, height: 0 },
      { u: 0.647, lateral: -15, height: 4.5 },
      { u: 0.661, lateral: -28, height: 4.5 },
      { u: 0.677, lateral: -11, height: 4.5 },
      { u: 0.72, lateral: 0, height: 0 },
    ],
    // The strongest lateral route needs a recovery funnel before its precise
    // 5.775m scoring portal. At full vector air-brake the lower approach speed
    // otherwise lets a correct late correction trip the corridor first.
    corridorHalfWidth: 7,
    gateHalfWidth: 5.5,
    passHalfWidth: 5.775,
    targetSpeed: 48,
    qualifyFromU: 0.59,
    launchFromU: 0.62,
    launchToU: 0.642,
    turnWarningFromU: 0.645,
    turnWarningToU: 0.694,
    navigation: {
      turn: { fromU: 0.645, toU: 0.694, direction: 'right' },
      // The route returns toward its exit after the hard initial turn. Two
      // opposite chevrons tell the player when to arrest that rotation.
      counterTurn: { fromU: 0.672, toU: 0.696, direction: 'left' },
    },
  },
  {
    id: 'flight-6',
    index: 5,
    entryU: 0.775,
    exitU: 0.855,
    gateUs: [0.835],
    nodes: [
      { u: 0.775, lateral: 0, height: 0 },
      { u: 0.788, lateral: 12, height: 4.5 },
      { u: 0.803, lateral: 21, height: 4.5 },
      { u: 0.819, lateral: 10, height: 4.5 },
      { u: 0.855, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5,
    gateHalfWidth: 5,
    passHalfWidth: 5.25,
    targetSpeed: 50,
    qualifyFromU: 0.73,
    launchFromU: 0.76,
    launchToU: 0.782,
    turnWarningFromU: 0.785,
    turnWarningToU: 0.831,
    navigation: {
      turn: { fromU: 0.785, toU: 0.831, direction: 'left' },
    },
  },
  {
    id: 'flight-7',
    index: 6,
    entryU: 0.905,
    exitU: 0.975,
    gateUs: [0.9575],
    nodes: [
      { u: 0.905, lateral: 0, height: 0 },
      { u: 0.917, lateral: -3, height: 4.5 },
      { u: 0.933, lateral: -6, height: 4.5 },
      { u: 0.948, lateral: -3, height: 4.5 },
      { u: 0.975, lateral: 0, height: 0 },
    ],
    corridorHalfWidth: 5.5,
    gateHalfWidth: 5.5,
    passHalfWidth: 5.775,
    targetSpeed: 50,
    qualifyFromU: 0.865,
    launchFromU: 0.89,
    launchToU: 0.912,
    turnWarningFromU: 0.916,
    turnWarningToU: 0.954,
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
  recoveryCurve: THREE.CubicBezierCurve3 | null;
  tableN: number;
  routeLength: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  tx: Float32Array;
  ty: Float32Array;
  tz: Float32Array;
  u: Float32Array;
  gateFraction: number;
  gateToExitDistance: number;
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
  const lastGateU = def.gateUs[def.gateUs.length - 1];
  let recoveryCurve: THREE.CubicBezierCurve3 | null = null;
  if (def.navigation?.postGateRecovery) {
    const gatePoint = curve.getPoint(flightCurveT(def, lastGateU), new THREE.Vector3());
    const gateTangent = curve.getTangent(flightCurveT(def, lastGateU), new THREE.Vector3()).setY(0).normalize();
    const exitPoint = CURVE.getPointAt(def.exitU, new THREE.Vector3());
    exitPoint.y = 0;
    const exitTangent = CURVE.getTangentAt(def.exitU, new THREE.Vector3()).setY(0).normalize();
    const planarDistance = Math.hypot(exitPoint.x - gatePoint.x, exitPoint.z - gatePoint.z);
    const startHandle = Math.min(34, planarDistance * 0.34);
    const endHandle = Math.min(38, planarDistance * 0.4);
    recoveryCurve = new THREE.CubicBezierCurve3(
      gatePoint,
      gatePoint.clone().addScaledVector(gateTangent, startHandle),
      exitPoint.clone().addScaledVector(exitTangent, -endHandle),
      exitPoint,
    );
    recoveryCurve.arcLengthDivisions = 160;
  }
  const authoredLength = curve.getLength() + (recoveryCurve?.getLength() ?? 0);
  const tableN = Math.max(256, Math.ceil(authoredLength / 0.45));
  const runtime: FlightRouteRuntime = {
    def,
    curve,
    recoveryCurve,
    tableN,
    routeLength: 0,
    x: new Float32Array(tableN),
    y: new Float32Array(tableN),
    z: new Float32Array(tableN),
    tx: new Float32Array(tableN),
    ty: new Float32Array(tableN),
    tz: new Float32Array(tableN),
    u: new Float32Array(tableN),
    gateFraction: 0,
    gateToExitDistance: 0,
    near: { u: def.entryU, x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 1, distance: Infinity },
  };
  for (let i = 0; i < tableN; i++) {
    const f = i / (tableN - 1);
    const u = def.entryU + (def.exitU - def.entryU) * f;
    runtimePointAt(runtime, u, p);
    runtimeTangentAt(runtime, u, t).normalize();
    runtime.x[i] = p.x;
    runtime.y[i] = p.y;
    runtime.z[i] = p.z;
    runtime.tx[i] = t.x;
    runtime.ty[i] = t.y;
    runtime.tz[i] = t.z;
    runtime.u[i] = u;
    if (i > 0) {
      runtime.routeLength += Math.hypot(
        runtime.x[i] - runtime.x[i - 1],
        runtime.y[i] - runtime.y[i - 1],
        runtime.z[i] - runtime.z[i - 1],
      );
    }
  }
  runtime.gateFraction = flightCurveT(def, lastGateU);
  const gateIndex = Math.max(0, Math.min(tableN - 1, Math.round(runtime.gateFraction * (tableN - 1))));
  for (let i = gateIndex + 1; i < tableN; i++) {
    runtime.gateToExitDistance += Math.hypot(runtime.x[i] - runtime.x[i - 1], runtime.z[i] - runtime.z[i - 1]);
  }
  return runtime;
}

function runtimePointAt(runtime: FlightRouteRuntime, u: number, out: THREE.Vector3): THREE.Vector3 {
  const recovery = runtime.recoveryCurve;
  const gateU = runtime.def.gateUs[runtime.def.gateUs.length - 1];
  if (recovery && u > gateU) {
    return recovery.getPoint(THREE.MathUtils.clamp((u - gateU) / Math.max(1e-6, runtime.def.exitU - gateU), 0, 1), out);
  }
  return runtime.curve.getPoint(flightCurveT(runtime.def, u), out);
}

function runtimeTangentAt(runtime: FlightRouteRuntime, u: number, out: THREE.Vector3): THREE.Vector3 {
  const recovery = runtime.recoveryCurve;
  const gateU = runtime.def.gateUs[runtime.def.gateUs.length - 1];
  if (recovery && u > gateU) {
    return recovery.getTangent(THREE.MathUtils.clamp((u - gateU) / Math.max(1e-6, runtime.def.exitU - gateU), 0, 1), out);
  }
  return runtime.curve.getTangent(flightCurveT(runtime.def, u), out);
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

function flightGuideFromU(def: FlightRouteDefinition): number {
  return def.navigation?.guideFromU ?? def.qualifyFromU;
}

function flightLaunchCueU(def: FlightRouteDefinition): number {
  return def.navigation?.launchCueU ?? def.launchFromU;
}

/** Normalize route-space effects against the authored flight corridor. */
function flightVisualT(def: FlightRouteDefinition, u: number): number {
  return THREE.MathUtils.clamp((u - def.entryU) / Math.max(1e-6, def.exitU - def.entryU), 0, 1);
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
const _recoveryVelocity = new THREE.Vector2();
const _hiddenRecoveryArrow = new THREE.Matrix4().makeScale(0, 0, 0);
const _surfaceArrowCenter = new THREE.Vector3();
const _surfaceArrowNext = new THREE.Vector3();
const _surfaceArrowForward = new THREE.Vector3();
const _surfaceArrowScale = new THREE.Vector3(1, 1, 1);
const _surfaceArrowQuaternion = new THREE.Quaternion();
const _surfaceArrowMatrix = new THREE.Matrix4();
const _launchPacketForward = new THREE.Vector3(0, 0, 1);
const _launchPacketDirection = new THREE.Vector3();

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

/** Continuous block strokes keep START legible without a canvas upload. */
const START_GLYPHS: Record<string, readonly (readonly [number, number, number, number])[]> = {
  S: [[0, .78, 1, .22], [0, .39, 1, .22], [0, 0, 1, .22], [0, .5, .22, .5], [.78, 0, .22, .5]],
  T: [[0, .78, 1, .22], [.39, 0, .22, 1]],
  A: [[0, .39, 1, .22], [0, .78, 1, .22], [0, 0, .22, 1], [.78, 0, .22, 1]],
  R: [[0, .39, 1, .22], [0, .78, 1, .22], [0, 0, .22, 1], [.78, .5, .22, .5], [.55, 0, .22, .55]],
};

function makeStartGantryVisuals(): {
  towerMaterial: THREE.Material;
  bannerFront: THREE.Group;
  bannerBack: THREE.Group;
} {
  const foamMat = createToonMaterial({ color: PALETTE.foam, emissive: PALETTE.foam, emissiveIntensity: 0.12 });
  const inkMat = createToonMaterial({ color: PALETTE.ink });
  const accentMat = createToonMaterial({ color: PALETTE.uiAccent, emissive: PALETTE.uiAccent, emissiveIntensity: 0.28 });
  const bannerFront = new THREE.Group();
  const bannerBack = new THREE.Group();
  const panelGeo = new THREE.BoxGeometry(17, 2.6, 0.16);
  const panel = new THREE.Mesh(panelGeo, foamMat);
  panel.userData.noOutline = true;
  bannerFront.add(panel);
  const backPanel = new THREE.Mesh(panelGeo, foamMat);
  backPanel.userData.noOutline = true;
  bannerBack.add(backPanel);
  const edgeParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 2; i++) {
    const edge = new THREE.BoxGeometry(0.3, 2.05, 0.18);
    edge.translate(i === 0 ? -8.32 : 8.32, 0, 0.15);
    edgeParts.push(edge);
  }
  const edgeGeo = mergeGeometries(edgeParts, false);
  edgeParts.forEach((part) => part.dispose());
  if (!edgeGeo) throw new Error('Unable to merge START banner edges');
  const edges = new THREE.Mesh(edgeGeo, accentMat);
  edges.name = 'start-banner-edges';
  edges.userData.noOutline = true;
  bannerFront.add(edges);
  const backEdges = edges.clone();
  backEdges.name = 'start-banner-edges-back';
  bannerBack.add(backEdges);

  // Restore the race-checker identity without restoring the CanvasTexture
  // upload that could turn the entire landmark black on a cold mobile load.
  // The approach face keeps one checker row above and below START; the exit
  // face is the original full 16 x 4 finish checker.
  const cellWidth = 17 / 16;
  const cellHeight = 2.6 / 4;
  const checkerParts = (fullFace: boolean): THREE.BufferGeometry[] => {
    const parts: THREE.BufferGeometry[] = [];
    for (let row = 0; row < 4; row++) {
      if (!fullFace && row !== 0 && row !== 3) continue;
      for (let col = 0; col < 16; col++) {
        if ((row + col) % 2 !== 0) continue;
        const part = new THREE.BoxGeometry(cellWidth, cellHeight, 0.12);
        part.translate(
          -8.5 + (col + 0.5) * cellWidth,
          -1.3 + (row + 0.5) * cellHeight,
          0.18,
        );
        parts.push(part);
      }
    }
    return parts;
  };
  const addChecker = (target: THREE.Group, fullFace: boolean, name: string): void => {
    const parts = checkerParts(fullFace);
    const geometry = mergeGeometries(parts, false);
    parts.forEach((part) => part.dispose());
    if (!geometry) throw new Error(`Unable to merge ${name}`);
    const checker = new THREE.Mesh(geometry, inkMat);
    checker.name = name;
    checker.userData.noOutline = true;
    checker.userData.startCheckerInstances = fullFace ? 32 : 16;
    target.add(checker);
  };
  addChecker(bannerFront, false, 'start-checker-front');
  addChecker(bannerBack, true, 'start-checker-back');

  const text = 'START';
  const letterWidth = 2.05;
  const startX = -(text.length - 1) * letterWidth * 0.5;
  const segmentCount = [...text].reduce((sum, glyph) => sum + START_GLYPHS[glyph].length, 0);
  const letterParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < text.length; i++) {
    for (const [x, y, width, height] of START_GLYPHS[text[i]]) {
      const part = new THREE.BoxGeometry(width * 1.65, height * 1.45, 0.12);
      part.translate(
        startX + i * letterWidth + (x + width * 0.5 - 0.5) * 1.65,
        (y + height * 0.5 - 0.5) * 1.45,
        0.18,
      );
      letterParts.push(part);
    }
  }
  const letterGeo = mergeGeometries(letterParts, false);
  letterParts.forEach((part) => part.dispose());
  if (!letterGeo) throw new Error('Unable to merge START glyphs');
  const letters = new THREE.Mesh(letterGeo, inkMat);
  letters.name = 'start-glyphs';
  letters.userData.noOutline = true;
  letters.userData.startGlyphInstances = segmentCount;
  bannerFront.add(letters);
  bannerFront.name = 'start-banner-front';
  bannerBack.name = 'start-banner-back';
  return { towerMaterial: foamMat, bannerFront, bannerBack };
}

/** Pink low-altitude lock: the open mist aperture only exists above this field. */
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
// Eight-meter navigation field. The surface guide is tessellated across its
// width so every part follows the swell instead of bridging it like a panel.
const RIBBON_HALF_W = 4;
const SURFACE_GUIDE_CROSS_SEGS = 8;
const SURFACE_GUIDE_STYLE = 'translucent-wave-spine' as const;
const SURFACE_GUIDE_BASE_ALPHA = 0.168;
const SURFACE_GUIDE_PEAK_ALPHA = 0.55;
const SURFACE_GUIDE_ARROW_CADENCE_M = 10;
const SURFACE_GUIDE_ARROW_SPEED_MPS = 10;
const SURFACE_GUIDE_ARROW_START_M = 16;
const SURFACE_GUIDE_ARROW_COUNT = Math.ceil((170 - SURFACE_GUIDE_ARROW_START_M) / SURFACE_GUIDE_ARROW_CADENCE_M);
// Keep a short wake behind the hull, then let it settle into the swell instead
// of cutting the authored guide off on a single fragment boundary.
const SURFACE_GUIDE_TAIL_FADE_START_M = 12;
const SURFACE_GUIDE_TAIL_FADE_END_M = 30;
const SURFACE_GUIDE_MASK_FEATHER_M = 5;
const SURFACE_GUIDE_TURN_CHEVRON_COUNT = 3;
const SURFACE_GUIDE_LAUNCH_ALIGN_M = 40;
const FLIGHT_GUIDE_STYLE = 'white-mist-corridor' as const;
const FLIGHT_ROUTE_MARKER_COLOR = PALETTE.flightMist;
const FLIGHT_ROUTE_MARKER_SHADE = PALETTE.flightMistShade;
// The corridor is a mist veil, not a filled blue road. Ink edges and moving
// white flow marks carry its readable shape; the ocean remains visible through
// the neutral panel.
const FLIGHT_GUIDE_PANEL_ALPHA = 0.095;
const FLIGHT_GUIDE_PANEL_BEAT_ALPHA = 0.04;
const FLIGHT_GUIDE_CENTER_ALPHA = 0.045;
const FLIGHT_GUIDE_EDGE_ALPHA = 0.34;
const FLIGHT_GUIDE_FLOW_ALPHA = 0.54;
const FLIGHT_GUIDE_FAR_START_M = 55;
const FLIGHT_GUIDE_FAR_END_M = 145;
// A corridor is a volume of mist, not a cut-out rectangle. The final few
// metres taper its footprint and opacity so both authored terminals breathe
// into the air instead of ending on a hard cross-section.
const FLIGHT_GUIDE_ENDPOINT_TAPER_F = 0.07;
const FLIGHT_GUIDE_ENDPOINT_MIN_WIDTH = 0.14;
const FLIGHT_GUIDE_ENDPOINT_MIN_ALPHA = 0.2;
const LAUNCH_GATE_PREVIEW_M = 140;
const LAUNCH_GATE_FOCUS_M = 30;
const LAUNCH_TORNADO_FULL_M = 32;
const LAUNCH_TORNADO_PREVIEW_M = LAUNCH_GATE_PREVIEW_M;
const LAUNCH_TORNADO_FAR_SCALE = 1.36;
const LAUNCH_TORNADO_FAR_OPACITY = 0.78;
const LAUNCH_TORNADO_SPIN_RAD_S = 0.22;
const LAUNCH_TORNADO_BREATH = 0.035;
const LAUNCH_TORNADO_BURST_PERIOD_S = 2.35;
const LAUNCH_TORNADO_BURST_DUTY = 0.11;
const LAUNCH_TORNADO_HEIGHT_M = 7.4;
const LAUNCH_TORNADO_MAX_RADIUS_M = 1.75;

// These are shared across the seven dormant route roots. Only one launch gate
// can be visible, so the shared material opacity remains deterministic.
function makeLaunchTornadoSmokeRibbonGeometry(phase: number, width: number): THREE.BufferGeometry {
  const segments = 26;
  const vertices = new Float32Array((segments + 1) * 2 * 3);
  const indices = new Uint16Array(segments * 6);
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const angle = phase + f * Math.PI * 2.7;
    const radius = 0.22 + (LAUNCH_TORNADO_MAX_RADIUS_M - 0.22) * Math.pow(f, 0.72);
    const halfWidth = width * (0.42 + f * 0.58);
    const centerX = Math.cos(angle) * radius;
    const centerZ = Math.sin(angle) * radius;
    const tangentX = -Math.sin(angle);
    const tangentZ = Math.cos(angle);
    const base = i * 6;
    vertices[base] = centerX - tangentX * halfWidth;
    vertices[base + 1] = 0.08 + f * LAUNCH_TORNADO_HEIGHT_M - halfWidth * 0.16;
    vertices[base + 2] = centerZ - tangentZ * halfWidth;
    vertices[base + 3] = centerX + tangentX * halfWidth;
    vertices[base + 4] = 0.08 + f * LAUNCH_TORNADO_HEIGHT_M + halfWidth * 0.16;
    vertices[base + 5] = centerZ + tangentZ * halfWidth;
    if (i < segments) {
      const index = i * 6;
      const row = i * 2;
      indices[index] = row;
      indices[index + 1] = row + 1;
      indices[index + 2] = row + 2;
      indices[index + 3] = row + 1;
      indices[index + 4] = row + 3;
      indices[index + 5] = row + 2;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

const LAUNCH_TORNADO_SMOKE_RIBBON_GEOMETRIES = [
  makeLaunchTornadoSmokeRibbonGeometry(0, 0.32),
  makeLaunchTornadoSmokeRibbonGeometry(Math.PI * 0.94, 0.26),
] as const;
const LAUNCH_TORNADO_SMOKE_RIBBON_MATERIALS = [
  new THREE.MeshBasicMaterial({
    color: PALETTE.ink,
    transparent: true,
    opacity: 0.36,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  }),
  new THREE.MeshBasicMaterial({
    color: PALETTE.uiPanel,
    transparent: true,
    opacity: 0.26,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  }),
] as const;
const LAUNCH_TORNADO_SMOKE_PUFF_GEOMETRY = new THREE.SphereGeometry(1, 12, 8);
const LAUNCH_TORNADO_SMOKE_PUFF_MATERIALS = [
  new THREE.MeshBasicMaterial({
    color: PALETTE.ink,
    transparent: true,
    opacity: 0.18,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  }),
  new THREE.MeshBasicMaterial({
    color: PALETTE.cloudShade,
    transparent: true,
    opacity: 0.12,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  }),
] as const;
const LAUNCH_TORNADO_BASE_GEOMETRY = new THREE.TorusGeometry(0.58, 0.055, 6, 16);
const LAUNCH_TORNADO_BASE_MATERIAL = new THREE.MeshBasicMaterial({
  color: PALETTE.cloudShade,
  transparent: true,
  opacity: 0.18,
  depthTest: true,
  depthWrite: false,
  blending: THREE.NormalBlending,
  toneMapped: false,
});

function makeLaunchTornadoSmokePuffs(phase: number, material: THREE.MeshBasicMaterial): THREE.InstancedMesh {
  const count = 7;
  const puffs = new THREE.InstancedMesh(LAUNCH_TORNADO_SMOKE_PUFF_GEOMETRY, material, count);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Euler();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  for (let index = 0; index < count; index++) {
    const f = (index + 0.35) / count;
    const angle = phase + f * Math.PI * 2.15;
    const radius = 0.14 + (LAUNCH_TORNADO_MAX_RADIUS_M - 0.36) * Math.pow(f, 0.78);
    position.set(
      Math.cos(angle) * radius,
      0.22 + f * (LAUNCH_TORNADO_HEIGHT_M - 0.34),
      Math.sin(angle) * radius,
    );
    rotation.set(f * 1.8, angle * 0.5, index * 1.1);
    quaternion.setFromEuler(rotation);
    const breadth = 0.28 + f * 0.58;
    scale.set(breadth * 1.08, 0.22 + f * 0.34, breadth);
    matrix.compose(position, quaternion, scale);
    puffs.setMatrixAt(index, matrix);
  }
  puffs.instanceMatrix.needsUpdate = true;
  puffs.computeBoundingSphere();
  return puffs;
}

function makeLaunchTornadoBoltGeometry(): THREE.TubeGeometry {
  // A real tube, rather than a camera-dependent flat Shape, keeps the short
  // flash legible while the vortex turns across the chase camera.
  const points = [
    new THREE.Vector3(-0.06, 0.08, 0.02),
    new THREE.Vector3(0.12, 0.38, -0.08),
    new THREE.Vector3(-0.1, 0.68, 0.07),
    new THREE.Vector3(0.15, 1.02, -0.04),
    new THREE.Vector3(-0.04, 1.3, 0.1),
    new THREE.Vector3(0.12, 1.9, -0.02),
  ];
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 10, 0.052, 5, false);
}

const LAUNCH_TORNADO_BOLT_GEOMETRY = makeLaunchTornadoBoltGeometry();
const LAUNCH_TORNADO_BOLT_MATERIALS = [-1, 1].map(() => new THREE.MeshBasicMaterial({
  color: PALETTE.uiWarn,
  transparent: true,
  opacity: 0.28,
  depthTest: true,
  depthWrite: false,
  blending: THREE.NormalBlending,
  side: THREE.DoubleSide,
  toneMapped: false,
}));
const LAUNCH_TORNADO_CORE_GEOMETRY = new THREE.IcosahedronGeometry(0.34, 1);
const LAUNCH_TORNADO_ORBIT_GEOMETRY = new THREE.TorusGeometry(0.42, 0.025, 6, 16);
const LAUNCH_TORNADO_CORE_MATERIALS = [-1, 1].map(() => new THREE.MeshBasicMaterial({
  color: PALETTE.uiWarn,
  transparent: true,
  opacity: 0.16,
  depthTest: true,
  depthWrite: false,
  blending: THREE.NormalBlending,
  side: THREE.DoubleSide,
  toneMapped: false,
}));
const LAUNCH_TORNADO_ORBIT_MATERIALS = [-1, 1].map(() => new THREE.MeshBasicMaterial({
  color: PALETTE.uiWarn,
  transparent: true,
  opacity: 0.18,
  depthTest: true,
  depthWrite: false,
  blending: THREE.NormalBlending,
  toneMapped: false,
}));

function createSurfaceGuideUniforms() {
  return {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color().setHex(PALETTE.racingLine, THREE.NoColorSpace) },
    uFoam: { value: new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace) },
    uTurnColor: { value: new THREE.Color().setHex(PALETTE.sunFlare, THREE.NoColorSpace) },
    uInk: { value: new THREE.Color().setHex(PALETTE.ink, THREE.NoColorSpace) },
    uPlayerS: { value: 0 },
    uLapLength: { value: LAP_LENGTH },
    uMaskStart: { value: 0 },
    uMaskEnd: { value: 0 },
    uGuideActive: { value: 0 },
    uFinalApproach: { value: 0 },
    uLaunchGateActive: { value: 0 },
    uLaunchGateS: { value: 0 },
    uLaunchGateEndS: { value: 0 },
    uMaskFeather: { value: SURFACE_GUIDE_MASK_FEATHER_M },
  };
}

type SurfaceGuideUniforms = ReturnType<typeof createSurfaceGuideUniforms>;

/**
 * A low-opacity virtual wake. The ocean remains the dominant surface; soft
 * packets and two inner filaments carry motion without drawing road edges.
 */
function buildRibbonMaterial(uniforms: SurfaceGuideUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'RacingLine',
    uniforms,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying float vS;
      varying float vSide;
      varying float vDist;
      ${WAVES_GLSL}
      void main() {
        vec3 p = position;
        p.y = waveHeight(p.xz, uTime) + 0.135;
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
      uniform vec3 uFoam;
      uniform float uPlayerS;
      uniform float uLapLength;
      uniform float uMaskStart;
      uniform float uMaskEnd;
      uniform float uGuideActive;
      uniform float uFinalApproach;
      uniform float uLaunchGateActive;
      uniform float uLaunchGateS;
      uniform float uLaunchGateEndS;
      uniform float uMaskFeather;
      varying float vS;
      varying float vSide;
      varying float vDist;
      void main() {
        float ahead = mod(vS - uPlayerS + uLapLength, uLapLength);
        float behind = mod(uPlayerS - vS + uLapLength, uLapLength);
        float forwardVisible = 1.0 - smoothstep(145.0, 170.0, ahead);
        float trailingVisible = 1.0 - smoothstep(${SURFACE_GUIDE_TAIL_FADE_START_M.toFixed(1)}, ${SURFACE_GUIDE_TAIL_FADE_END_M.toFixed(1)}, behind);
        float trailingSide = 1.0 - step(0.5 * uLapLength, behind);
        float distanceVisible = mix(forwardVisible, trailingVisible, trailingSide);
        float visible = 1.0;
        visible *= distanceVisible;
        // Keep the exact ownership interval, but feather both ends over a few
        // metres so the green route dissolves into the water rather than snaps.
        float guideMask = step(uMaskStart, vS) * step(vS, uMaskEnd);
        float guideMaskSoft = smoothstep(uMaskStart - uMaskFeather, uMaskStart + uMaskFeather, vS) *
          (1.0 - smoothstep(uMaskEnd - uMaskFeather, uMaskEnd + uMaskFeather, vS));
        visible *= 1.0 - uGuideActive * guideMaskSoft;
        float launchMask = step(uLaunchGateS, vS) * step(vS, uLaunchGateEndS);
        float launchMaskSoft = smoothstep(uLaunchGateS - uMaskFeather, uLaunchGateS + uMaskFeather, vS) *
          (1.0 - smoothstep(uLaunchGateEndS - uMaskFeather, uLaunchGateEndS + uMaskFeather, vS));
        visible *= 1.0 - uLaunchGateActive * launchMaskSoft;
        float side = abs(vSide);
        float softEdge = 1.0 - smoothstep(0.72, 1.0, side);
        float packetPhase = fract(vS / 21.0 - uTime * 0.42);
        float packet = smoothstep(0.04, 0.2, packetPhase) *
          (1.0 - smoothstep(0.66, 0.94, packetPhase));
        float drift = sin(vS * 0.19 - uTime * 1.7) * 0.025;
        float flowA = 1.0 - smoothstep(0.018, 0.066, abs(vSide - (0.22 + drift)));
        float flowB = 1.0 - smoothstep(0.018, 0.066, abs(vSide - (-0.22 - drift)));
        float flow = max(flowA, flowB) * (0.42 + packet * 0.58);
        // The route is a wake laid over the water, not a painted lane. Keep
        // enough body for long-range navigation, then carve it into moving
        // translucent pockets so the wave texture remains the hero surface.
        float current = 0.5 + 0.26 * sin(vS * 0.31 - uTime * 1.15 + vSide * 2.8) +
          0.16 * sin(vS * 0.77 + uTime * 0.62 - vSide * 5.4) +
          0.08 * sin(vS * 1.43 - uTime * 1.9);
        float waterPocket = smoothstep(0.28, 0.78, current);
        float centerVeil = (1.0 - smoothstep(0.08, 0.62, side)) * (0.34 + waterPocket * 0.66);
        float navSpine = 1.0 - smoothstep(0.04, 0.12, side);
        float veil = softEdge * (${SURFACE_GUIDE_BASE_ALPHA.toFixed(3)} * (0.48 + waterPocket * 0.52) + packet * 0.035);
        float alpha = veil + centerVeil * 0.045 + navSpine * (0.34 + packet * 0.06) + flow * 0.26;
        float localFade = 1.0 - smoothstep(140.0, 170.0, ahead) * 0.18;
        float fade = (vDist < 220.0 ? 1.0 : 0.78) * localFade;
        vec3 col = mix(uColor, uFoam, 0.24 + navSpine * 0.22 + flow * 0.34 + packet * 0.08);
        alpha *= fade;
        alpha *= mix(1.0, 0.18, uFinalApproach);
        alpha = min(alpha, ${SURFACE_GUIDE_PEAK_ALPHA.toFixed(2)});
        alpha *= visible * step(0.008, alpha);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: false,
  });
}

interface SurfaceGuideBuild {
  ribbon: THREE.ShaderMaterial;
  arrows: THREE.InstancedMesh;
  arrowInk: THREE.InstancedMesh;
  arrowStations: THREE.InstancedBufferAttribute;
  arrowTurns: THREE.InstancedBufferAttribute;
  arrowPhases: THREE.InstancedBufferAttribute;
  arrowCount: number;
}

const _surfaceTurnA = new THREE.Vector3();
const _surfaceTurnB = new THREE.Vector3();

function surfaceTurnAhead(s: number): number {
  CURVE.getTangentAt(((s + 8) % LAP_LENGTH) / LAP_LENGTH, _surfaceTurnA).setY(0).normalize();
  CURVE.getTangentAt(((s + 38) % LAP_LENGTH) / LAP_LENGTH, _surfaceTurnB).setY(0).normalize();
  return Math.atan2(
    _surfaceTurnA.x * _surfaceTurnB.z - _surfaceTurnA.z * _surfaceTurnB.x,
    _surfaceTurnA.x * _surfaceTurnB.x + _surfaceTurnA.z * _surfaceTurnB.z,
  );
}

function buildSurfaceChevronGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const addWing = (startX: number, startZ: number, endX: number, endZ: number): void => {
    const dx = endX - startX;
    const dz = endZ - startZ;
    const inv = 1 / Math.hypot(dx, dz);
    const px = -dz * inv;
    const pz = dx * inv;
    const startHalf = 0.32;
    const endHalf = 0.24;
    const a = [startX + px * startHalf, 0, startZ + pz * startHalf];
    const b = [startX - px * startHalf, 0, startZ - pz * startHalf];
    const c = [endX + px * endHalf, 0, endZ + pz * endHalf];
    const d = [endX - px * endHalf, 0, endZ - pz * endHalf];
    positions.push(...a, ...c, ...b, ...b, ...c, ...d);
  };
  addWing(-1.9, -1.8, 0, 2.6);
  addWing(1.9, -1.8, 0, 2.6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function buildSurfaceArrowMaterial(uniforms: SurfaceGuideUniforms, ink = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'SurfaceGuideChevrons',
    uniforms,
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute float aStation;
      attribute float aTurn;
      attribute float aPhase;
      varying float vS;
      varying float vTurn;
      varying float vPhase;
      varying float vDist;
      ${WAVES_GLSL}
      void main() {
        vec4 local = vec4(position * ${ink ? '1.18' : '1.0'}, 1.0);
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
        #endif
        vec4 world = modelMatrix * local;
        world.y = waveHeight(world.xz, uTime) + ${ink ? '0.185' : '0.215'};
        vS = aStation;
        vTurn = aTurn;
        vPhase = aPhase;
        vec4 mv = viewMatrix * world;
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uFoam;
      uniform vec3 uTurnColor;
      uniform vec3 uInk;
      uniform float uPlayerS;
      uniform float uLapLength;
      uniform float uMaskStart;
      uniform float uMaskEnd;
      uniform float uGuideActive;
      uniform float uFinalApproach;
      uniform float uLaunchGateActive;
      uniform float uLaunchGateS;
      uniform float uLaunchGateEndS;
      uniform float uMaskFeather;
      varying float vS;
      varying float vTurn;
      varying float vPhase;
      varying float vDist;
      void main() {
        float ahead = mod(vS - uPlayerS + uLapLength, uLapLength);
        float behind = mod(uPlayerS - vS + uLapLength, uLapLength);
        float forwardVisible = 1.0 - smoothstep(145.0, 170.0, ahead);
        float trailingVisible = 1.0 - smoothstep(${SURFACE_GUIDE_TAIL_FADE_START_M.toFixed(1)}, ${SURFACE_GUIDE_TAIL_FADE_END_M.toFixed(1)}, behind);
        float trailingSide = 1.0 - step(0.5 * uLapLength, behind);
        float visible = 1.0;
        visible *= mix(forwardVisible, trailingVisible, trailingSide);
        float guideMask = step(uMaskStart, vS) * step(vS, uMaskEnd);
        float guideMaskSoft = smoothstep(uMaskStart - uMaskFeather, uMaskStart + uMaskFeather, vS) *
          (1.0 - smoothstep(uMaskEnd - uMaskFeather, uMaskEnd + uMaskFeather, vS));
        visible *= 1.0 - uGuideActive * guideMaskSoft;
        float launchMask = step(uLaunchGateS, vS) * step(vS, uLaunchGateEndS);
        float launchMaskSoft = smoothstep(uLaunchGateS - uMaskFeather, uLaunchGateS + uMaskFeather, vS) *
          (1.0 - smoothstep(uLaunchGateEndS - uMaskFeather, uLaunchGateEndS + uMaskFeather, vS));
        visible *= 1.0 - uLaunchGateActive * launchMaskSoft;
        // Actual instance motion carries direction; the phase sweep keeps a
        // readable front-to-back rhythm without making arrows blink off.
        float travel = fract(uTime * 0.65 - vPhase);
        float pulse = 1.0 - smoothstep(0.02, 0.34, travel);
        float nearFade = smoothstep(4.0, 12.0, ahead);
        float localFade = 1.0 - smoothstep(145.0, 170.0, ahead);
        float fade = nearFade * localFade * (vDist < 220.0 ? 1.0 : 0.78);
        vec3 base = mix(uColor, uTurnColor, vTurn);
        vec3 color = ${ink ? 'uInk' : 'mix(base, uFoam, 0.2 + pulse * 0.3)'};
        float alpha = ${ink ? '0.86' : 'mix(0.82, 0.94, vTurn) * (0.88 + pulse * 0.12)'} * fade;
        alpha *= mix(1.0, 0.18, uFinalApproach);
        alpha *= visible;
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: false,
  });
}

function buildSurfaceCueMaterial(
  timeUniform: THREE.IUniform<number>,
  color: number,
  opacity: number,
  flowing = false,
  surfaceBlendUniform: THREE.IUniform<number> = { value: 1 },
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'SurfaceActionChevron',
    uniforms: {
      uTime: timeUniform,
      uColor: { value: new THREE.Color().setHex(color, THREE.NoColorSpace) },
      uOpacity: { value: opacity },
      uFlowing: { value: flowing ? 1 : 0 },
      uSurfaceBlend: surfaceBlendUniform,
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uSurfaceBlend;
      attribute float aPhase;
      varying float vPhase;
      ${WAVES_GLSL}
      void main() {
        vec4 local = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
        #endif
        vec4 world = modelMatrix * local;
        world.y = mix(world.y + 0.205, waveHeight(world.xz, uTime) + 0.205, uSurfaceBlend);
        vPhase = aPhase;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uFlowing;
      uniform float uTime;
      varying float vPhase;
      void main() {
        float travel = fract(uTime * 0.65 - vPhase);
        float pulse = 1.0 - smoothstep(0.02, 0.34, travel);
        float flowingAlpha = 0.72 + pulse * 0.28;
        gl_FragColor = vec4(uColor, uOpacity * mix(1.0, flowingAlpha, uFlowing));
      }
    `,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: false,
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
  anchor: THREE.Mesh;
  cleared: boolean;
}

interface FlightRouteVisual {
  runtime: FlightRouteRuntime;
  group: THREE.Group;
  ribbonMesh: THREE.Mesh;
  ribbon: THREE.ShaderMaterial;
  rail: THREE.MeshBasicMaterial;
  ring: THREE.MeshBasicMaterial;
  recoveryArrows: THREE.InstancedMesh;
  recoveryArrowMaterial: THREE.ShaderMaterial;
  recoveryArrowFractions: number[];
  turnChevronGroup: THREE.Group | null;
  turnChevronFill: THREE.MeshBasicMaterial | null;
  turnChevronCount: number;
  gates: FlightGate[];
  deployActive: boolean;
  deployTime: number;
  recoveryFade: number;
  recoveryProgress: number;
  recoverySurfaceBlend: number;
}

interface LaunchGateDiamond {
  root: THREE.Group;
  ink: THREE.MeshBasicMaterial;
  energy: THREE.MeshBasicMaterial;
  postureInk: THREE.MeshBasicMaterial | null;
  postureFill: THREE.MeshBasicMaterial | null;
  x: number;
  z: number;
  clearance: number;
  waveWeight: number;
}

interface LaunchGateProjector {
  root: THREE.Group;
  lens: THREE.MeshBasicMaterial;
  x: number;
  z: number;
}

interface LaunchGateTornado {
  root: THREE.Group;
  smoke: THREE.Group;
  core: THREE.Group;
  bolt: THREE.Mesh;
  branch: THREE.Mesh;
  x: number;
  z: number;
  side: number;
  phase: number;
}

interface LaunchGateVisual {
  group: THREE.Group;
  projectors: LaunchGateProjector[];
  tornadoes: LaunchGateTornado[];
  diamonds: LaunchGateDiamond[];
  packets: THREE.Mesh[];
  packetMaterial: THREE.MeshBasicMaterial;
  deploy: number;
}

function makeOpenChevronGeometry(depth = 0): THREE.BufferGeometry {
  const points = [
    -1.12, depth, 0.82, -0.86, depth, 1.08, 0.34, depth, 0.13,
    -1.12, depth, 0.82, 0.34, depth, 0.13, 0.06, depth, -0.1,
    -1.12, depth, -0.82, 0.06, depth, 0.1, 0.34, depth, -0.13,
    -1.12, depth, -0.82, 0.34, depth, -0.13, -0.86, depth, -1.08,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function makeVerticalChevronGeometry(depth = 0): THREE.BufferGeometry {
  const points = [
    -1.12, 0.82, depth, -0.86, 1.08, depth, 0.34, 0.13, depth,
    -1.12, 0.82, depth, 0.34, 0.13, depth, 0.06, -0.1, depth,
    -1.12, -0.82, depth, 0.06, 0.1, depth, 0.34, -0.13, depth,
    -1.12, -0.82, depth, 0.34, -0.13, depth, -0.86, -1.08, depth,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.computeVertexNormals();
  return geometry;
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
  private readonly surfaceGuideArrows: THREE.InstancedMesh;
  private readonly surfaceGuideArrowInk: THREE.InstancedMesh;
  private readonly surfaceGuideArrowStations: THREE.InstancedBufferAttribute;
  private readonly surfaceGuideArrowTurns: THREE.InstancedBufferAttribute;
  private readonly surfaceGuideArrowPhases: THREE.InstancedBufferAttribute;
  private readonly surfaceGuideArrowCount: number;
  private readonly stripMat: THREE.ShaderMaterial;
  private readonly flightVisuals: FlightRouteVisual[];
  private readonly launchGateVisuals: LaunchGateVisual[];
  private readonly floaters: Floater[] = [];
  private readonly flightPrev: THREE.Vector3[] = [];
  private readonly flightPrevClearance: number[] = [];
  private readonly flightLatched: number[] = [];
  private readonly flightOffCorridorT: number[] = [];
  private readonly flightOffCorridorD: number[] = [];
  private readonly flightRecoveryT: number[] = [];
  private readonly flightRecoveryLimit: number[] = [];
  private readonly flightDebug: string[] = [];
  private readonly flightTurnWarn: boolean[] = [];
  private flightWarn = 0;
  private flightWarnRoute = -1;
  private playerFlightReady = false;
  private playerFlightIndex = 0;
  private playerFlightPressure = 0;
  private flightFlowTime = 0;
  private playerSurfaceU = 0;
  private readonly playerPosition = new THREE.Vector3();
  private playerTargetGateDistance = -1;
  private playerTargetAnchorScale = 1;
  private playerActionCue: CourseGuidanceStatus['actionCue'] = 'none';
  private playerActionRouteIndex = -1;
  private playerActionDirection: CourseGuidanceStatus['actionDirection'] = 'none';
  private playerActionTargetU = -1;
  private playerActionMarkerCount = 0;
  private playerLaunchGateState: CourseGuidanceStatus['launchGateState'] = 'hidden';
  private playerLaunchGateRouteIndex = -1;
  private playerLaunchGateDistanceM = -1;
  private playerLaunchGateDiamondCount = 0;
  private playerPreviousFlightPhase: FlightPhase = 'surface';
  private playerLaunchCommittedRoute = -1;
  private playerLaunchCommittedU = -1;
  private surfaceGuideTurnArrowCount = 0;
  private surfaceGuideLaunchTurnArrowCount = 0;
  private activeGuideRoute = -1;
  private playerRecoveryRoute = -1;
  private playerRecoverySurface = false;
  private playerRecoveryElapsed = 0;
  private playerRecoveryLimit = 0;
  private startGantry: THREE.Group | null = null;
  private finalStation: THREE.Group | null = null;
  private finalStationBlend = 0;
  private finalCrossingPulse = 0;
  private finalArmed = false;
  private finalCelebrating = false;
  private finalCelebrationTime = 0;
  private readonly finalPortalCenter = new THREE.Vector3();
  private readonly finalPortalForward = new THREE.Vector3();
  private readonly finalPortalRight = new THREE.Vector3();

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'course';
    const surfaceGuide = this.buildRibbon();
    this.ribbonMat = surfaceGuide.ribbon;
    this.surfaceGuideArrows = surfaceGuide.arrows;
    this.surfaceGuideArrowInk = surfaceGuide.arrowInk;
    this.surfaceGuideArrowStations = surfaceGuide.arrowStations;
    this.surfaceGuideArrowTurns = surfaceGuide.arrowTurns;
    this.surfaceGuideArrowPhases = surfaceGuide.arrowPhases;
    this.surfaceGuideArrowCount = surfaceGuide.arrowCount;
    this.stripMat = this.buildStartStrip();
    this.flightVisuals = FLIGHT_RUNTIME.map((runtime) => this.buildFlightRoute(runtime));
    this.buildGates();
    this.launchGateVisuals = FLIGHT_RUNTIME.map((runtime) => this.buildLaunchGateVisual(runtime));
    this.pointAt(0, this.finalPortalCenter);
    this.tangentAt(0, this.finalPortalForward);
    this.finalPortalRight.set(this.finalPortalForward.z, 0, -this.finalPortalForward.x).normalize();
  }

  /** Cold-load contract for the START landmark. No browser canvas upload is allowed. */
  startGantryStatus(): Record<string, number> {
    let canvasTextures = 0;
    let meshes = 0;
    let glyphInstances = 0;
    let checkerInstances = 0;
    this.startGantry?.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes++;
      glyphInstances += Number(object.userData.startGlyphInstances ?? 0);
      checkerInstances += Number(object.userData.startCheckerInstances ?? 0);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.CanvasTexture) canvasTextures++;
        }
        if (material instanceof THREE.ShaderMaterial) {
          for (const uniform of Object.values(material.uniforms)) {
            if (uniform?.value instanceof THREE.CanvasTexture) canvasTextures++;
          }
        }
      }
    });
    return { canvasTextures, meshes, glyphInstances, checkerInstances };
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
    return runtimePointAt(runtime, u, out);
  }

  routeTangentAt(routeId: CourseRouteId, u: number, out: THREE.Vector3): THREE.Vector3 {
    if (routeId === 'surface') return this.tangentAt(u, out);
    const runtime = flightRuntime(routeId);
    if (u < runtime.def.entryU || u > runtime.def.exitU) return this.tangentAt(u, out);
    runtimeTangentAt(runtime, u, out);
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
    this.writeSurfaceSample(pos, out);

    if (routeHint !== 'surface') {
      const runtime = flightRuntime(routeHint);
      nearestOnFlight(runtime, pos.x, pos.z);
      const near = runtime.near;
      // An explicit route hint is ownership, not a suggestion. Falling back
      // to the globally nearest surface segment during a fast merge can jump
      // progress to an unrelated bend and manufacture a wrong-way warning.
      out.u = near.u;
      out.point.set(near.x, near.y, near.z);
      const il = 1 / (Math.hypot(near.tx, near.tz) || 1);
      out.tangent.set(near.tx * il, 0, near.tz * il);
      out.distance = near.distance;
      out.routeId = routeHint;
    }
    return out;
  }

  sampleSurfaceNear(pos: THREE.Vector3, referenceU: number, maxDeltaU: number, out: CourseSample): CourseSample {
    const boundedDeltaU = Math.max(1 / TABLE_N, maxDeltaU);
    nearestOnSplineNear(pos.x, pos.z, referenceU, boundedDeltaU);
    return this.writeSurfaceSample(pos, out, referenceU, boundedDeltaU);
  }

  private writeSurfaceSample(
    pos: THREE.Vector3,
    out: CourseSample,
    referenceU?: number,
    maxDeltaU?: number,
  ): CourseSample {
    let u = _near.u;
    CURVE.getPointAt(u, _sp);
    this.tangentAt(u, out.tangent);
    let du = ((pos.x - _sp.x) * out.tangent.x + (pos.z - _sp.z) * out.tangent.z) / LAP_LENGTH;
    if (referenceU !== undefined && maxDeltaU !== undefined) {
      // The true-curve correction only compensates table interpolation. When
      // the boat is far off this local segment it must not project along the
      // tangent into a different fold of the course.
      const refineLimit = 2 / TABLE_N;
      du = Math.max(-refineLimit, Math.min(refineLimit, du));
    }
    u = wrapU(u + du);
    if (referenceU !== undefined && maxDeltaU !== undefined) {
      let bounded = u - referenceU;
      if (bounded < -0.5) bounded += 1;
      else if (bounded > 0.5) bounded -= 1;
      bounded = Math.max(-maxDeltaU, Math.min(maxDeltaU, bounded));
      u = wrapU(referenceU + bounded);
    }
    CURVE.getPointAt(u, _sp);
    this.tangentAt(u, out.tangent);
    out.u = u;
    out.point.set(_sp.x, 0, _sp.z);
    out.distance = Math.hypot(pos.x - _sp.x, pos.z - _sp.z);
    out.routeId = 'surface';
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
    this.flightRecoveryT.length = 0;
    this.flightRecoveryLimit.length = 0;
    this.flightDebug.length = 0;
    this.flightTurnWarn.length = 0;
    this.flightWarn = 0;
    this.flightWarnRoute = -1;
    this.playerFlightReady = false;
    this.playerFlightIndex = 0;
    this.playerFlightPressure = 0;
    this.flightFlowTime = 0;
    this.playerSurfaceU = 0;
    this.playerTargetGateDistance = -1;
    this.playerTargetAnchorScale = 1;
    this.playerActionCue = 'none';
    this.playerActionRouteIndex = -1;
    this.playerActionDirection = 'none';
    this.playerActionTargetU = -1;
    this.playerActionMarkerCount = 0;
    this.playerLaunchGateState = 'hidden';
    this.playerLaunchGateRouteIndex = -1;
    this.playerLaunchGateDistanceM = -1;
    this.playerLaunchGateDiamondCount = 0;
    this.playerPreviousFlightPhase = 'surface';
    this.playerLaunchCommittedRoute = -1;
    this.playerLaunchCommittedU = -1;
    this.activeGuideRoute = -1;
    this.playerRecoveryRoute = -1;
    this.playerRecoverySurface = false;
    this.playerRecoveryElapsed = 0;
    this.playerRecoveryLimit = 0;
    this.finalArmed = false;
    this.finalCelebrating = false;
    this.finalCelebrationTime = 0;
    this.finalStationBlend = 0;
    if (this.finalStation) this.finalStation.visible = false;
    this.ribbonMat.uniforms.uGuideActive.value = 0;
    this.ribbonMat.uniforms.uFinalApproach.value = 0;
    this.ribbonMat.uniforms.uLaunchGateActive.value = 0;
    for (const visual of this.launchGateVisuals) {
      visual.group.visible = false;
      visual.deploy = 0;
    }
    for (const visual of this.flightVisuals) {
      visual.group.visible = false;
      visual.deployActive = false;
      visual.deployTime = 0;
      visual.recoveryFade = 0;
      visual.recoveryProgress = flightVisualT(
        visual.runtime.def,
        visual.runtime.def.gateUs[visual.runtime.def.gateUs.length - 1],
      );
      visual.recoverySurfaceBlend = 0;
      for (const gate of visual.gates) {
        gate.deploy = 0;
        gate.pulse = 0;
        gate.cleared = false;
        gate.group.visible = true;
        gate.anchor.visible = true;
      }
    }
    for (const floater of this.floaters) floater.obj.visible = true;
  }

  armFinalStation(): void {
    this.finalArmed = true;
    this.ribbonMat.uniforms.uFinalApproach.value = 1;
    if (this.finalStation) this.finalStation.visible = true;
  }

  finalStationArmed(): boolean {
    return this.finalArmed;
  }

  pulseFinalStation(): void {
    this.finalCrossingPulse = 1;
  }

  crossFinalStation(previous: THREE.Vector3, current: THREE.Vector3): number {
    const dx = current.x - previous.x;
    const dz = current.z - previous.z;
    const stepSq = dx * dx + dz * dz;
    if (stepSq <= 1e-8 || stepSq > FINAL_PORTAL_MAX_STEP_M * FINAL_PORTAL_MAX_STEP_M) return -1;
    const px = previous.x - this.finalPortalCenter.x;
    const pz = previous.z - this.finalPortalCenter.z;
    const cx = current.x - this.finalPortalCenter.x;
    const cz = current.z - this.finalPortalCenter.z;
    const fromPlane = px * this.finalPortalForward.x + pz * this.finalPortalForward.z;
    const toPlane = cx * this.finalPortalForward.x + cz * this.finalPortalForward.z;
    if ((fromPlane < 0 && toPlane < 0) || (fromPlane > 0 && toPlane > 0)) return -1;
    const denominator = fromPlane - toPlane;
    if (Math.abs(denominator) < 1e-6) return -1;
    const crossingT = fromPlane / denominator;
    if (crossingT < 0 || crossingT > 1) return -1;
    const crossX = previous.x + dx * crossingT - this.finalPortalCenter.x;
    const crossZ = previous.z + dz * crossingT - this.finalPortalCenter.z;
    const lateral = crossX * this.finalPortalRight.x + crossZ * this.finalPortalRight.z;
    return Math.abs(lateral) <= FINAL_PORTAL_HALF_WIDTH_M ? crossingT : -1;
  }

  triggerFinaleCelebration(): void {
    this.finalCelebrating = true;
    this.finalCelebrationTime = 0;
    if (this.finalStation) this.finalStation.visible = true;
  }

  finaleCelebrating(): boolean {
    return this.finalCelebrating;
  }

  resetFinalStation(): void {
    this.finalArmed = false;
    this.finalCelebrating = false;
    this.finalCelebrationTime = 0;
    this.finalStationBlend = 0;
    this.finalCrossingPulse = 0;
    this.ribbonMat.uniforms.uFinalApproach.value = 0;
    if (this.finalStation) this.finalStation.visible = false;
  }

  /** Deterministic harness diagnostic for the single-guide contract. */
  guidanceStatus(): CourseGuidanceStatus {
    const recoveryVisual = this.playerRecoveryRoute >= 0 ? this.flightVisuals[this.playerRecoveryRoute] : undefined;
    return {
      activeRouteIndex: this.activeGuideRoute,
      visibleRouteCount: this.flightVisuals.reduce((sum, visual) => sum + (visual.group.visible ? 1 : 0), 0),
      surfaceMaskRouteIndex: this.activeGuideRoute,
      recoveryRouteIndex: this.playerRecoveryRoute,
      recoveryActive: this.playerRecoveryRoute >= 0 ? 1 : 0,
      recoveryElapsed: this.playerRecoveryElapsed,
      recoveryLimit: this.playerRecoveryLimit,
      recoveryArrowCount: recoveryVisual
        ? recoveryVisual.recoveryArrowFractions.filter((f) => f >= recoveryVisual.recoveryProgress - 0.018).length
        : 0,
      recoveryGuideOpacity: recoveryVisual ? 1 : 0,
      handoffOverlapMeters: 16,
      playerSurfaceU: this.playerSurfaceU,
      targetGateDistance: this.playerTargetGateDistance,
      targetAnchorScale: this.playerTargetAnchorScale,
      finalActive: this.finalArmed,
      finalDistance: Math.hypot(
        this.playerPosition.x - this.finalPortalCenter.x,
        this.playerPosition.z - this.finalPortalCenter.z,
      ),
      finalGuideCount: this.finalArmed ? 1 : 0,
      actionCue: this.playerActionCue,
      actionRouteIndex: this.playerActionRouteIndex,
      actionDirection: this.playerActionDirection,
      actionTargetU: this.playerActionTargetU,
      actionMarkerCount: this.playerActionMarkerCount,
      launchGateState: this.playerLaunchGateState,
      launchGateRouteIndex: this.playerLaunchGateRouteIndex,
      launchGateDistanceM: this.playerLaunchGateDistanceM,
      launchGateDiamondCount: this.playerLaunchGateDiamondCount,
      launchCommitRouteIndex: this.playerLaunchCommittedRoute,
      launchCommitU: this.playerLaunchCommittedU,
      surfaceGuideStyle: SURFACE_GUIDE_STYLE,
      surfaceGuideBaseAlpha: SURFACE_GUIDE_BASE_ALPHA,
      surfaceGuidePeakAlpha: SURFACE_GUIDE_PEAK_ALPHA,
      surfaceGuideArrowCadenceM: SURFACE_GUIDE_ARROW_CADENCE_M,
      surfaceGuideArrowSpeedMps: SURFACE_GUIDE_ARROW_SPEED_MPS,
      surfaceGuideArrowCount: this.surfaceGuideArrowCount,
      surfaceGuideTurnArrowCount: this.surfaceGuideTurnArrowCount,
      surfaceGuideTailFadeStartM: SURFACE_GUIDE_TAIL_FADE_START_M,
      surfaceGuideTailFadeEndM: SURFACE_GUIDE_TAIL_FADE_END_M,
      surfaceGuideMaskFeatherM: SURFACE_GUIDE_MASK_FEATHER_M,
      surfaceGuideLaunchTurnArrowCount: this.surfaceGuideLaunchTurnArrowCount,
      surfaceGuideTurnChevronCount: SURFACE_GUIDE_TURN_CHEVRON_COUNT,
      flightGuideStyle: FLIGHT_GUIDE_STYLE,
      flightGuidePanelAlpha: FLIGHT_GUIDE_PANEL_ALPHA,
      flightGuidePanelBeatAlpha: FLIGHT_GUIDE_PANEL_BEAT_ALPHA,
      flightGuideCenterAlpha: FLIGHT_GUIDE_CENTER_ALPHA,
      flightGuideEdgeAlpha: FLIGHT_GUIDE_EDGE_ALPHA,
      flightGuideFlowAlpha: FLIGHT_GUIDE_FLOW_ALPHA,
      flightGuideFarStartM: FLIGHT_GUIDE_FAR_START_M,
      flightGuideFarEndM: FLIGHT_GUIDE_FAR_END_M,
      surfaceGuideMaskStartU: this.activeGuideRoute >= 0
        ? this.ribbonMat.uniforms.uMaskStart.value / LAP_LENGTH
        : -1,
      surfaceGuideMaskEndU: this.activeGuideRoute >= 0
        ? this.ribbonMat.uniforms.uMaskEnd.value / LAP_LENGTH
        : -1,
      surfaceGuideAfterLaunchMeters: this.activeGuideRoute >= 0
        ? Math.max(0, this.ribbonMat.uniforms.uMaskStart.value -
          flightLaunchCueU(FLIGHT_ROUTES[this.activeGuideRoute]) * LAP_LENGTH)
        : 0,
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
    const routeLevelFailure = reason === 'no_launch' || reason === 'corridor' ||
      reason === 'landing' || reason === 'exit' || reason === 'teleport';
    boat.applyFlightRouteMiss({
      reason,
      flightNumber: boat.state.flightRouteCursor + 1,
      routeSlot: visual.runtime.def.index,
      flightsCleared: boat.state.flightsCleared,
      gatesPassed,
      gateCount: visual.gates.length,
      // A route-level miss is not evidence of a specific portal. The HUD may
      // derive the next suggested gate from gatesPassed, but the snapshot must
      // keep the distinction between "missed the corridor" and "missed gate".
      targetGate: routeLevelFailure ? null : targetGate,
      routeU,
      lateralOffsetM,
      lateralLimitM,
      corridorDistanceM,
      clearanceM: boat.state.flightClearance,
    });
  }

  updateFlightRoute(dt: number, boats: readonly IBoat[]): void {
    this.playerActionCue = 'none';
    this.playerActionRouteIndex = -1;
    this.playerActionDirection = 'none';
    this.playerActionTargetU = -1;
    this.playerActionMarkerCount = 0;
    this.playerLaunchGateState = 'hidden';
    this.playerLaunchGateRouteIndex = -1;
    this.playerLaunchGateDistanceM = -1;
    this.playerLaunchGateDiamondCount = 0;
    for (const boat of boats) {
      const id = boat.id;
      const pos = boat.state.position;
      const st = boat.state;
      if (st.flightRouteState === 'idle') this.flightDebug[id] = 'idle';
      this.sample(pos, _routeSample, 'surface');
      const surfaceU = _routeSample.u;
      if (id === 0) {
        const acceptedLaunch = this.playerPreviousFlightPhase === 'surface' && st.flightPhase === 'spool';
        this.playerPreviousFlightPhase = st.flightPhase;
        this.playerSurfaceU = surfaceU;
        this.playerPosition.copy(pos);
        this.playerFlightReady = st.flightCharges > 0;
        const finalApproach = this.finalArmed && st.flightsCleared >= FLIGHT_ROUTES.length;
        this.playerFlightIndex = finalApproach ? -1 : st.flightRouteIndex >= 0
          ? st.flightRouteIndex
          : st.flightRouteCursor % FLIGHT_ROUTES.length;
        this.playerFlightPressure = st.flightPressure;
        const targetGate = this.flightVisuals[this.playerFlightIndex]?.gates[st.flightGateProgress];
        this.playerTargetGateDistance = targetGate ? targetGate.center.distanceTo(pos) : -1;
        if (acceptedLaunch && !this.finalArmed) {
          const committedRoute = st.flightRouteCursor % FLIGHT_ROUTES.length;
          this.playerLaunchCommittedRoute = committedRoute;
          this.playerLaunchCommittedU = surfaceU;
          for (let route = 0; route < this.flightVisuals.length; route++) {
            if (route === committedRoute) continue;
            this.flightVisuals[route].recoveryFade = 0;
            this.flightVisuals[route].recoverySurfaceBlend = 0;
          }
          if (this.playerRecoveryRoute >= 0 && this.playerRecoveryRoute !== committedRoute) {
            const retired = this.flightVisuals[this.playerRecoveryRoute];
            retired.recoveryFade = 0;
            retired.recoverySurfaceBlend = 0;
            this.playerRecoveryRoute = -1;
            this.playerRecoverySurface = false;
            this.playerRecoveryElapsed = 0;
            this.playerRecoveryLimit = 0;
            this.flightRecoveryT[id] = 0;
            this.flightRecoveryLimit[id] = 0;
            this.flightLatched[id] = -1;
          }
          this.flightDebug[id] = `launch-commit:f${committedRoute + 1}:u${surfaceU.toFixed(4)}`;
        } else if (st.flightRouteState === 'passed' || st.flightRouteState === 'failed' ||
            (st.flightPhase === 'surface' && st.flightRouteState === 'idle')) {
          this.playerLaunchCommittedRoute = -1;
          this.playerLaunchCommittedU = -1;
        }
      }
      let prev = this.flightPrev[id];
      if (!prev) {
        prev = new THREE.Vector3().copy(pos);
        this.flightPrev[id] = prev;
        this.flightPrevClearance[id] = st.flightClearance;
        this.flightLatched[id] = -1;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
        this.flightRecoveryT[id] = 0;
        this.flightRecoveryLimit[id] = 0;
        continue;
      }

      const jump = prev.distanceToSquared(pos) > 60 * 60;
      const flightActive = st.flightPhase !== 'surface';
      if (id === 0 && !this.finalArmed) {
        if (flightActive && this.playerLaunchCommittedRoute >= 0) {
          this.playerLaunchGateState = 'committed';
          this.playerLaunchGateRouteIndex = this.playerLaunchCommittedRoute;
          this.playerLaunchGateDistanceM = 0;
        } else if (flightActive && st.flightRouteState === 'active' && st.flightRouteIndex >= 0) {
          this.playerLaunchGateState = 'committed';
          this.playerLaunchGateRouteIndex = st.flightRouteIndex;
          this.playerLaunchGateDistanceM = 0;
        } else if (st.flightRouteState === 'idle' || st.flightRouteState === 'passed') {
          const launchRouteIndex = st.flightRouteCursor % FLIGHT_ROUTES.length;
          const launchRoute = FLIGHT_ROUTES[launchRouteIndex];
          const surfaceS = surfaceU * LAP_LENGTH;
          const launchCueU = flightLaunchCueU(launchRoute);
          const launchS = launchCueU * LAP_LENGTH;
          const launchDistance = (launchS - surfaceS + LAP_LENGTH) % LAP_LENGTH;
          if (launchDistance <= LAUNCH_GATE_PREVIEW_M) {
            const armed = st.flightCharges > 0;
            this.playerLaunchGateState = armed ? 'armed' : 'unarmed';
            this.playerLaunchGateRouteIndex = launchRouteIndex;
            this.playerLaunchGateDistanceM = launchDistance;
            this.playerLaunchGateDiamondCount = 3;
            if (!flightActive) {
              this.playerActionCue = armed ? 'launch' : 'bank';
              this.playerActionRouteIndex = launchRouteIndex;
              this.playerActionDirection = launchRoute.navigation?.turn?.direction ?? 'none';
              this.playerActionTargetU = launchCueU;
              this.playerActionMarkerCount = 3;
            }
          }
        }
      }
      if (id === 0 && this.finalArmed && st.flightsCleared >= FLIGHT_ROUTES.length &&
          st.flightRouteState === 'idle') {
        // The seventh pass owns the approach until Race certifies the line.
        prev.copy(pos);
        this.flightPrevClearance[id] = st.flightClearance;
        continue;
      }
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
          (surfaceU >= flightGuideFromU(def) && surfaceU <= def.exitU + 0.01))) visual.deployActive = true;
      this.flightTurnWarn[id] = flightActive && st.flightRouteState === 'active' &&
        near.u >= def.turnWarningFromU && near.u <= def.turnWarningToU;
      const primaryTurn = def.navigation?.turn;
      const counterTurn = def.navigation?.counterTurn;
      const activeTurn = counterTurn && near.u >= counterTurn.fromU && near.u <= counterTurn.toU
        ? counterTurn
        : primaryTurn && near.u >= primaryTurn.fromU && near.u <= primaryTurn.toU
          ? primaryTurn
          : null;
      if (id === 0 && !this.finalArmed && activeTurn &&
          flightActive && st.flightRouteState === 'active') {
        this.playerActionCue = 'turn';
        this.playerActionRouteIndex = routeIndex;
        this.playerActionDirection = activeTurn.direction;
        this.playerActionTargetU = Math.min(activeTurn.toU, near.u + 0.008);
        this.playerActionMarkerCount = activeTurn === counterTurn ? 2 : 3;
      }

      if (jump) {
        if (st.flightRouteState === 'active') this.failFlight(boat, visual, 'teleport', surfaceU, null);
        if (st.flightRouteState !== 'passed') this.flightLatched[id] = -1;
        this.flightOffCorridorT[id] = 0;
        this.flightOffCorridorD[id] = 0;
        prev.copy(pos);
        this.flightPrevClearance[id] = st.flightClearance;
        continue;
      }

      if (st.flightRouteState === 'passed') {
        this.flightLatched[id] = routeIndex;
        const elapsed = (this.flightRecoveryT[id] ?? 0) + dt;
        const recoveryConfig = def.navigation?.postGateRecovery;
        const limit = this.flightRecoveryLimit[id] > 0
          ? this.flightRecoveryLimit[id]
          : recoveryConfig?.maxDurationS ??
            Math.max(2.5, Math.min(4, runtime.gateToExitDistance / Math.max(1, def.targetSpeed) + 1.5));
        this.flightRecoveryT[id] = elapsed;
        this.flightRecoveryLimit[id] = limit;
        if (id === 0) {
          this.playerRecoveryRoute = routeIndex;
          this.playerRecoverySurface = !flightActive;
          this.playerRecoveryElapsed = elapsed;
          this.playerRecoveryLimit = limit;
          visual.recoveryProgress = flightVisualT(def, near.u);
        }
        const end = runtime.tableN - 1;
        const tx = runtime.tx[end];
        const tz = runtime.tz[end];
        const il = 1 / (Math.hypot(tx, tz) || 1);
        const nx = tx * il;
        const nz = tz * il;
        const dx = pos.x - runtime.x[end];
        const dz = pos.z - runtime.z[end];
        const forwardOfExit = dx * nx + dz * nz >= 0;
        const signedLateralToExit = dx * nz - dz * nx;
        const lateralToExit = Math.abs(signedLateralToExit);
        boat.collisionVelocity(_recoveryVelocity);
        const forwardVelocity = _recoveryVelocity.x * nx + _recoveryVelocity.y * nz;
        const handoffMargin = recoveryConfig?.handoffMarginM ?? 24;
        const predictedLateral = Math.abs(
          signedLateralToExit + (_recoveryVelocity.x * nz - _recoveryVelocity.y * nx) * 0.35,
        );
        const stableRecovery = !recoveryConfig || predictedLateral < 24;
        const certifiedHandoff = !flightActive && forwardOfExit && lateralToExit <= handoffMargin &&
          stableRecovery && forwardVelocity >= 0;
        const timedOut = !flightActive && elapsed >= limit;
        this.flightDebug[id] = `recovery:${near.u.toFixed(4)}:${elapsed.toFixed(2)}/${limit.toFixed(2)}`;
        if (certifiedHandoff || timedOut) {
          boat.settleFlightRoute();
          this.flightLatched[id] = -1;
          this.flightRecoveryT[id] = 0;
          this.flightRecoveryLimit[id] = 0;
          this.flightDebug[id] = certifiedHandoff ? 'handoff:exit' : 'handoff:timeout';
          if (id === 0) {
            visual.recoveryFade = 0.3;
            this.playerRecoveryRoute = -1;
            this.playerRecoveryElapsed = 0;
            this.playerRecoveryLimit = 0;
          }
        }
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
          _routeSample.distance < SURFACE_ROUTE_FAIL_DISTANCE_M &&
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
              if (id === 0) {
                gate.pulse = 0.36;
                gate.cleared = true;
                gate.anchor.visible = false;
              }
              if (gateIndex + 1 >= visual.gates.length) {
                boat.completeFlightRoute(routeIndex, st.flightRouteCursor);
                this.flightRecoveryT[id] = 0;
                this.flightRecoveryLimit[id] = def.navigation?.postGateRecovery?.maxDurationS ??
                  Math.max(2.5, Math.min(4,
                    runtime.gateToExitDistance / Math.max(1, def.targetSpeed) + 1.5));
                if (id === 0) {
                  this.playerLaunchCommittedRoute = -1;
                  this.playerLaunchCommittedU = -1;
                  this.playerRecoveryRoute = routeIndex;
                  this.playerRecoverySurface = false;
                  this.playerRecoveryElapsed = 0;
                  this.playerRecoveryLimit = this.flightRecoveryLimit[id];
                }
                this.flightDebug[id] = 'passed';
              }
            } else {
              const reason = lateral < 0 ? 'gate_left' : 'gate_right';
              this.flightDebug[id] = `gate${gateIndex + 1}:lat${lateral.toFixed(2)}:limit${lateralLimit.toFixed(2)}`;
              this.failFlight(boat, visual, reason, gate.u, gateIndex + 1, lateral, lateralLimit);
              if (id === 0) {
                this.flightWarn = 0.8;
                this.flightWarnRoute = routeIndex;
              }
            }
          }
          if (st.flightRouteState === 'active' && near.u > gate.u + FLIGHT_GATE_BYPASS_U) {
            this.flightDebug[id] = `bypass${gateIndex + 1}:u${near.u.toFixed(4)}`;
            this.failFlight(boat, visual, 'gate', near.u, gateIndex + 1);
            if (id === 0) {
              this.flightWarn = 0.8;
              this.flightWarnRoute = routeIndex;
            }
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
            if (id === 0) {
              this.flightWarn = Math.max(this.flightWarn, 0.25);
              this.flightWarnRoute = routeIndex;
            }
          }
          if (offT >= FLIGHT_CORRIDOR_FAIL || offD >= FLIGHT_CORRIDOR_FAIL_DISTANCE) {
            this.failFlight(boat, visual, 'corridor', near.u, null, null, null, near.distance);
            if (id === 0) {
              this.flightWarn = 0.8;
              this.flightWarnRoute = routeIndex;
            }
          }
        }
      }

      if (st.flightRouteState === 'active' && surfaceU > def.exitU + 0.006) {
        this.flightDebug[id] = `exit:g${st.flightGateProgress}`;
        this.failFlight(boat, visual, 'exit', surfaceU, null);
        if (id === 0) {
          this.flightWarn = 0.8;
          this.flightWarnRoute = routeIndex;
        }
      }

      if (id === 0 && st.flightRouteMiss) {
        this.flightWarn = 0.8;
        this.flightWarnRoute = routeIndex;
      }

      if (st.flightRouteState !== 'active' &&
          (!flightActive || surfaceU < def.entryU - 0.03 || surfaceU > def.exitU + 0.006)) {
        this.flightLatched[id] = -1;
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
      // Water contact is a physics edge, not a visual style boundary. Keep the
      // scored branch through descent, landing and its short recovery fade.
      const recoverySlot = this.playerRecoveryRoute >= 0
        ? this.playerRecoveryRoute
        : this.flightVisuals.findIndex((visual) => visual.recoveryFade > 0);
      const committedSlot = this.playerLaunchCommittedRoute >= 0 && st.flightPhase !== 'surface'
        ? this.playerLaunchCommittedRoute
        : -1;
      const finalApproach = this.finalArmed &&
        st.flightsCleared >= FLIGHT_ROUTES.length && recoverySlot < 0;
      const slot = committedSlot >= 0
        ? committedSlot
        : recoverySlot >= 0
        ? recoverySlot
        : finalApproach ? -1
          : st.flightRouteIndex >= 0 ? st.flightRouteIndex : st.flightRouteCursor % FLIGHT_ROUTES.length;
      const def = FLIGHT_ROUTES[slot];
      if (def && (recoverySlot >= 0 ||
          st.flightRouteState !== 'idle' || st.flightPhase !== 'surface' ||
          (this.playerSurfaceU >= flightGuideFromU(def) && this.playerSurfaceU <= def.exitU + 0.01))) {
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
            gate.cleared = false;
            gate.group.visible = true;
            gate.anchor.visible = true;
          }
        }
      }
      this.activeGuideRoute = next;
    }
    const active = next >= 0 ? FLIGHT_ROUTES[next] : null;
    const recovering = next >= 0 && (this.playerRecoveryRoute === next || this.flightVisuals[next].recoveryFade > 0);
    const maskStartU = active ? flightLaunchCueU(active) : 0;
    this.ribbonMat.uniforms.uGuideActive.value = active ? 1 : 0;
    // The surface guide hands off at the launch diamonds. Before takeoff the
    // marker is the only visual bridge to the corridor at authored entryU; an
    // accepted early launch still retires it without restoring a false mist
    // surface before the gate.
    this.ribbonMat.uniforms.uMaskStart.value = maskStartU * LAP_LENGTH;
    this.ribbonMat.uniforms.uMaskEnd.value = active
      ? Math.min(LAP_LENGTH, active.exitU * LAP_LENGTH + (recovering ? -16 : 8))
      : 0;
    for (const floater of this.floaters) {
      floater.obj.visible = !active || floater.routeU === undefined ||
        floater.routeU < maskStartU || floater.routeU > active.exitU;
    }
  }

  private updateSurfaceGuideArrowFlow(t: number): void {
    const playerS = this.playerSurfaceU * LAP_LENGTH;
    const travel = (t * SURFACE_GUIDE_ARROW_SPEED_MPS) % SURFACE_GUIDE_ARROW_CADENCE_M;
    const postThirdFromU = FLIGHT_ROUTES[2].exitU - 0.003;
    const postThirdToU = FLIGHT_ROUTES[2].exitU + 0.012;
    const launchRoute = this.activeGuideRoute >= 0 ? FLIGHT_ROUTES[this.activeGuideRoute] : undefined;
    const launchRuntime = this.activeGuideRoute >= 0 ? FLIGHT_RUNTIME[this.activeGuideRoute] : undefined;
    const launchTurn = launchRoute?.navigation?.turn;
    const launchS = launchRoute ? flightLaunchCueU(launchRoute) * LAP_LENGTH : -1;
    const launchAlignM = launchRoute?.navigation?.launchAlignM ?? SURFACE_GUIDE_LAUNCH_ALIGN_M;
    this.surfaceGuideTurnArrowCount = 0;
    this.surfaceGuideLaunchTurnArrowCount = 0;
    for (let i = 0; i < this.surfaceGuideArrowCount; i++) {
      const station = (playerS + SURFACE_GUIDE_ARROW_START_M +
        i * SURFACE_GUIDE_ARROW_CADENCE_M + travel) % LAP_LENGTH;
      const u = station / LAP_LENGTH;
      const phase = (i % SURFACE_GUIDE_TURN_CHEVRON_COUNT) / SURFACE_GUIDE_TURN_CHEVRON_COUNT;
      this.surfaceGuideArrowStations.setX(i, station);
      this.surfaceGuideArrowPhases.setX(i, phase);
      const authoredPostThirdTurn = u >= postThirdFromU && u <= postThirdToU;
      const metersToLaunch = launchRoute
        ? (launchS - station + LAP_LENGTH) % LAP_LENGTH
        : Number.POSITIVE_INFINITY;
      const authoredLaunchTurn = Boolean(launchTurn) && metersToLaunch <= launchAlignM;
      const turn = authoredLaunchTurn || authoredPostThirdTurn ||
        Math.abs(surfaceTurnAhead(station)) >= THREE.MathUtils.degToRad(16);
      const lookAheadS = station + (turn ? 18 : 6);
      CURVE.getPointAt(u, _surfaceArrowCenter);
      CURVE.getPointAt((lookAheadS % LAP_LENGTH) / LAP_LENGTH, _surfaceArrowNext);
      _surfaceArrowForward.subVectors(_surfaceArrowNext, _surfaceArrowCenter).setY(0).normalize();
      if (_surfaceArrowForward.lengthSq() < 0.5) {
        CURVE.getTangentAt(u, _surfaceArrowForward).setY(0).normalize();
      }
      if (authoredLaunchTurn && launchTurn && launchRuntime) {
        const postureU = THREE.MathUtils.lerp(launchTurn.fromU, launchTurn.toU, 0.18);
        runtimePointAt(launchRuntime, postureU, _surfaceArrowNext);
        _surfaceArrowNext.sub(_surfaceArrowCenter).setY(0).normalize();
        if (_surfaceArrowNext.lengthSq() > 0.5) {
          const alignment = 1 - THREE.MathUtils.clamp(
            metersToLaunch / launchAlignM,
            0,
            1,
          );
          _surfaceArrowForward.lerp(_surfaceArrowNext, 0.28 + alignment * 0.42).normalize();
        }
        this.surfaceGuideLaunchTurnArrowCount++;
      }
      _surfaceArrowQuaternion.setFromAxisAngle(UP, Math.atan2(_surfaceArrowForward.x, _surfaceArrowForward.z));
      const ahead = (station - playerS + LAP_LENGTH) % LAP_LENGTH;
      const farScaleT = THREE.MathUtils.smoothstep(ahead, 35, 150);
      const distanceScale = THREE.MathUtils.lerp(1, 1.6, farScaleT);
      _surfaceArrowScale.setScalar(distanceScale * (turn ? 1.35 : 1));
      _surfaceArrowMatrix.compose(_surfaceArrowCenter, _surfaceArrowQuaternion, _surfaceArrowScale);
      this.surfaceGuideArrows.setMatrixAt(i, _surfaceArrowMatrix);
      this.surfaceGuideArrowInk.setMatrixAt(i, _surfaceArrowMatrix);
      this.surfaceGuideArrowTurns.setX(i, turn ? 1 : 0);
      if (turn) this.surfaceGuideTurnArrowCount++;
    }
    this.surfaceGuideArrows.instanceMatrix.needsUpdate = true;
    this.surfaceGuideArrowInk.instanceMatrix.needsUpdate = true;
    this.surfaceGuideArrowStations.needsUpdate = true;
    this.surfaceGuideArrowTurns.needsUpdate = true;
    this.surfaceGuideArrowPhases.needsUpdate = true;
  }

  private updateLaunchGateVisuals(dt: number, t: number): void {
    const activeState = this.playerLaunchGateState === 'unarmed' || this.playerLaunchGateState === 'armed';
    const routeIndex = activeState ? this.playerLaunchGateRouteIndex : -1;
    const armed = this.playerLaunchGateState === 'armed';
    this.ribbonMat.uniforms.uLaunchGateActive.value = activeState ? 1 : 0;
    this.ribbonMat.uniforms.uLaunchGateS.value = routeIndex >= 0
      ? flightLaunchCueU(FLIGHT_ROUTES[routeIndex]) * LAP_LENGTH
      : 0;
    this.ribbonMat.uniforms.uLaunchGateEndS.value = routeIndex >= 0
      ? Math.min(LAP_LENGTH, FLIGHT_ROUTES[routeIndex].exitU * LAP_LENGTH + 8)
      : 0;
    for (let i = 0; i < this.launchGateVisuals.length; i++) {
      const visual = this.launchGateVisuals[i];
      const active = i === routeIndex;
      if (!active) {
        visual.group.visible = false;
        visual.deploy = 0;
        continue;
      }
      visual.group.visible = true;
      visual.deploy = Math.min(1, visual.deploy + dt / 0.35);
      const deploy = visual.deploy * visual.deploy * (3 - 2 * visual.deploy);
      const focus = 1 - THREE.MathUtils.clamp(this.playerLaunchGateDistanceM / LAUNCH_GATE_FOCUS_M, 0, 1);
      const farScale = 1 + THREE.MathUtils.clamp(this.playerLaunchGateDistanceM / LAUNCH_GATE_PREVIEW_M, 0, 1) * 0.62;
      const energyColor = armed ? FLIGHT_ROUTE_MARKER_COLOR : PALETTE.sunFlare;
      const tornadoNearness = 1 - THREE.MathUtils.smoothstep(
        this.playerLaunchGateDistanceM,
        LAUNCH_TORNADO_FULL_M,
        LAUNCH_TORNADO_PREVIEW_M,
      );
      // This is a route landmark, so it must remain legible at the launch
      // preview boundary. A small perspective compensation makes it recede
      // gracefully toward its true near-field scale instead of popping in.
      const tornadoScale = THREE.MathUtils.lerp(LAUNCH_TORNADO_FAR_SCALE, 1, tornadoNearness) * deploy;
      const tornadoOpacity = THREE.MathUtils.lerp(LAUNCH_TORNADO_FAR_OPACITY, 1, tornadoNearness) * deploy;
      const ribbonOpacities = [0.36, 0.26] as const;
      for (let ribbon = 0; ribbon < LAUNCH_TORNADO_SMOKE_RIBBON_MATERIALS.length; ribbon++) {
        LAUNCH_TORNADO_SMOKE_RIBBON_MATERIALS[ribbon].opacity = ribbonOpacities[ribbon] * tornadoOpacity;
      }
      const puffOpacities = [0.18, 0.12] as const;
      for (let puff = 0; puff < LAUNCH_TORNADO_SMOKE_PUFF_MATERIALS.length; puff++) {
        LAUNCH_TORNADO_SMOKE_PUFF_MATERIALS[puff].opacity = puffOpacities[puff] * tornadoOpacity;
      }
      LAUNCH_TORNADO_BASE_MATERIAL.color.setHex(
        PALETTE.cloudShade,
        THREE.NoColorSpace,
      );
      LAUNCH_TORNADO_BASE_MATERIAL.opacity = 0.18 * tornadoOpacity;
      for (const projector of visual.projectors) {
        projector.root.position.y = waterHeight(projector.x, projector.z, t);
        projector.lens.color.setHex(energyColor, THREE.NoColorSpace);
        projector.lens.opacity = (armed ? 0.92 : 0.74) * deploy;
        projector.root.scale.setScalar(0.82 + deploy * (0.18 + focus * 0.08));
      }
      for (const tornado of visual.tornadoes) {
        tornado.root.position.y = waterHeight(tornado.x, tornado.z, t);
        const breath = 1 + Math.sin(t * 1.1 + tornado.phase) * LAUNCH_TORNADO_BREATH;
        // A short, deterministic burst reads as lightning without allocating a
        // particle system or turning the gate into a constantly blinking sign.
        const burstPhase = THREE.MathUtils.euclideanModulo(
          t + tornado.phase * 0.73,
          LAUNCH_TORNADO_BURST_PERIOD_S,
        ) / LAUNCH_TORNADO_BURST_PERIOD_S;
        const burst = burstPhase < LAUNCH_TORNADO_BURST_DUTY
          ? Math.sin(Math.PI * burstPhase / LAUNCH_TORNADO_BURST_DUTY) ** 2
          : 0;
        const boltMaterial = LAUNCH_TORNADO_BOLT_MATERIALS[tornado.side < 0 ? 0 : 1];
        const coreMaterial = LAUNCH_TORNADO_CORE_MATERIALS[tornado.side < 0 ? 0 : 1];
        const orbitMaterial = LAUNCH_TORNADO_ORBIT_MATERIALS[tornado.side < 0 ? 0 : 1];
        boltMaterial.opacity = (0.07 + burst * 0.86) * tornadoOpacity;
        coreMaterial.opacity = (0.12 + burst * 0.26) * tornadoOpacity;
        orbitMaterial.opacity = (0.1 + burst * 0.2) * tornadoOpacity;
        tornado.root.scale.setScalar(tornadoScale * breath);
        tornado.root.rotation.y = tornado.phase + t * LAUNCH_TORNADO_SPIN_RAD_S * tornado.side;
        tornado.smoke.rotation.y = t * 0.48 * -tornado.side;
        tornado.smoke.rotation.z = Math.sin(t * 0.82 + tornado.phase) * 0.035;
        tornado.core.rotation.set(
          t * 0.72 * tornado.side,
          t * 1.38 * -tornado.side,
          t * 0.48,
        );
        tornado.core.scale.setScalar(0.94 + burst * 0.22);
        tornado.bolt.scale.set(0.92 + burst * 0.32, 1.1 + burst * 0.32, 1);
        tornado.branch.scale.set(0.64 + burst * 0.28, 0.7 + burst * 0.26, 1);
      }
      for (let diamondIndex = 0; diamondIndex < visual.diamonds.length; diamondIndex++) {
        const diamond = visual.diamonds[diamondIndex];
        const wave = waterHeight(diamond.x, diamond.z, t);
        diamond.root.position.set(
          diamond.x,
          diamond.clearance + wave * diamond.waveWeight,
          diamond.z,
        );
        const sequence = 0.5 + 0.5 * Math.sin(t * (armed ? 7.4 : 3.8) - diamondIndex * 1.55);
        const baseScale = (1.85 + diamondIndex * 0.2) * farScale;
        const pulseScale = 1 + sequence * (armed ? 0.09 : 0.045) + focus * 0.04;
        diamond.root.scale.setScalar(baseScale * deploy * pulseScale);
        diamond.ink.opacity = 0.82 * deploy;
        diamond.energy.color.setHex(energyColor, THREE.NoColorSpace);
        diamond.energy.opacity = (armed ? 0.78 + sequence * 0.18 : 0.58 + sequence * 0.16) * deploy;
        if (diamond.postureInk) diamond.postureInk.opacity = 0.84 * deploy;
        if (diamond.postureFill) {
          diamond.postureFill.color.setHex(
            armed ? PALETTE.foam : PALETTE.sunFlare,
            THREE.NoColorSpace,
          );
          diamond.postureFill.opacity = (armed ? 0.9 : 0.72 + sequence * 0.12) * deploy;
        }
      }
      visual.packetMaterial.color.setHex(armed ? PALETTE.foam : PALETTE.sunFlare, THREE.NoColorSpace);
      visual.packetMaterial.opacity = (armed ? 0.94 : 0.62) * deploy;
      const speed = armed ? 1.35 : 0.62;
      for (let packetIndex = 0; packetIndex < visual.packets.length; packetIndex++) {
        const packet = visual.packets[packetIndex];
        const phase = (t * speed + packetIndex / visual.packets.length) % 1;
        const scaled = phase * (visual.diamonds.length - 1);
        const segment = Math.min(visual.diamonds.length - 2, Math.floor(scaled));
        const local = scaled - segment;
        packet.position.lerpVectors(
          visual.diamonds[segment].root.position,
          visual.diamonds[segment + 1].root.position,
          local,
        );
        const packetScale = deploy * (armed ? 1 + focus * 0.35 : 0.72);
        packet.scale.setScalar(packetScale);
        _launchPacketDirection.subVectors(
          visual.diamonds[segment + 1].root.position,
          visual.diamonds[segment].root.position,
        ).normalize();
        packet.quaternion.setFromUnitVectors(_launchPacketForward, _launchPacketDirection);
      }
    }
  }

  update(dt: number, t: number): void {
    this.ribbonMat.uniforms.uTime.value = t;
    this.ribbonMat.uniforms.uPlayerS.value = this.playerSurfaceU * LAP_LENGTH;
    this.updateSurfaceGuideArrowFlow(t);
    this.updateLaunchGateVisuals(dt, t);
    this.stripMat.uniforms.uTime.value = t;
    this.flightWarn = Math.max(0, this.flightWarn - dt);
    this.flightFlowTime += dt * (1 + this.playerFlightPressure * 1.4);
    if (this.finalStation) {
      if (this.finalCelebrating) this.finalCelebrationTime += dt;
      this.finalCrossingPulse = Math.max(0, this.finalCrossingPulse - dt * 3.4);
      const target = this.finalArmed || this.finalCelebrating ? 1 : 0;
      this.finalStationBlend += (target - this.finalStationBlend) * (1 - Math.exp(-dt * 4.5));
      const blend = Math.max(0, Math.min(1, this.finalStationBlend));
      this.finalStation.visible = blend > 0.005;
      const burst = this.finalCelebrating ? Math.max(0, 1 - this.finalCelebrationTime / 1.2) : 0;
      const cross = this.finalCrossingPulse * this.finalCrossingPulse;
      this.finalStation.scale.set(
        1 + burst * 0.08 + cross * 0.025,
        0.24 + blend * (0.76 + burst * 0.32 + cross * 0.08),
        1 + burst * 0.08 + cross * 0.025,
      );
      const pulse = 0.82 + Math.sin(t * (this.finalCelebrating ? 8.5 : 3.2)) *
        (this.finalCelebrating ? 0.28 : 0.18) + burst * 0.22 + cross * 0.2;
      this.finalStation.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const material = object.material as THREE.MeshBasicMaterial;
        const baseOpacity = Number(object.userData.finalBaseOpacity ?? 0);
        if (baseOpacity > 0) material.opacity = baseOpacity * blend * pulse;
        const particle = Number(object.userData.finalParticle ?? -1);
        if (particle >= 0) {
          object.position.y = 1.2 + ((t * (1.5 + particle * 0.035) + particle * 1.17) % 10.5);
          object.rotation.y = t * (0.9 + particle * 0.04);
          const drift = Math.sin(t * 1.7 + particle * 2.1) * 0.28;
          object.position.z = drift;
        }
      });
    }
    const readyStep = this.playerFlightReady && Math.floor(t * 4) % 2 === 0 ? 1 : 0;
    for (let routeIndex = 0; routeIndex < this.flightVisuals.length; routeIndex++) {
      const visual = this.flightVisuals[routeIndex];
      visual.recoveryFade = Math.max(0, visual.recoveryFade - dt);
      if (visual.deployActive) visual.deployTime += dt;
      const warn = this.flightWarnRoute === routeIndex ? Math.min(1, this.flightWarn * 4) : 0;
      const upcoming = routeIndex === this.playerFlightIndex;
      visual.ribbon.uniforms.uTime.value = this.flightFlowTime;
      visual.ribbon.uniforms.uWarn.value = warn;
      visual.ribbon.uniforms.uReady.value = upcoming && this.playerFlightReady ? 1 : 0;
      visual.ribbon.uniforms.uTurn.value = upcoming && this.flightTurnWarn[0] ? 1 : 0;
      const recovery = this.playerRecoveryRoute === routeIndex ? 1 : visual.recoveryFade > 0 ? visual.recoveryFade / 0.3 : 0;
      const recoveryOnSurface = this.playerRecoveryRoute === routeIndex
        ? this.playerRecoverySurface
        : visual.recoveryFade > 0;
      const surfaceTarget = recovery > 0 && recoveryOnSurface ? 1 : 0;
      const surfaceResponse = Math.min(1, dt / 0.16);
      visual.recoverySurfaceBlend += (surfaceTarget - visual.recoverySurfaceBlend) * surfaceResponse;
      if (recovery <= 0.001) visual.recoverySurfaceBlend = 0;
      visual.ribbon.uniforms.uRecovery.value = recovery;
      visual.ribbon.uniforms.uRecoverySurface.value = visual.recoverySurfaceBlend;
      visual.ribbon.uniforms.uRecoveryProgress.value = visual.recoveryProgress;
      if (recovery > 0) visual.ribbonMesh.layers.disable(LAYER_ENERGY);
      else visual.ribbonMesh.layers.enable(LAYER_ENERGY);
      visual.recoveryArrows.visible = recovery > 0.04;
      visual.recoveryArrowMaterial.uniforms.uOpacity.value = 0.62 * recovery;
      if (recovery > 0) {
        const def = visual.runtime.def;
        const gateFraction = flightVisualT(def, def.gateUs[def.gateUs.length - 1]);
        const minFraction = Math.max(gateFraction, visual.recoveryProgress - 0.018);
        for (let i = 0; i < visual.recoveryArrowFractions.length; i++) {
          const flow = (this.flightFlowTime * SURFACE_GUIDE_ARROW_SPEED_MPS /
            Math.max(1, visual.runtime.routeLength)) % 1;
          const phase = (i / visual.recoveryArrowFractions.length + flow) % 1;
          const fraction = minFraction + (1 - minFraction) * phase;
          visual.recoveryArrowFractions[i] = fraction;
          const u = def.entryU + (def.exitU - def.entryU) * fraction;
          runtimePointAt(visual.runtime, u, _surfaceArrowCenter);
          runtimeTangentAt(visual.runtime, u, _surfaceArrowForward).setY(0).normalize();
          _surfaceArrowQuaternion.setFromAxisAngle(
            UP,
            Math.atan2(_surfaceArrowForward.x, _surfaceArrowForward.z),
          );
          _surfaceArrowScale.setScalar(0.92);
          _surfaceArrowMatrix.compose(_surfaceArrowCenter, _surfaceArrowQuaternion, _surfaceArrowScale);
          visual.recoveryArrows.setMatrixAt(i, _surfaceArrowMatrix);
        }
        visual.recoveryArrows.instanceMatrix.needsUpdate = true;
      }
      visual.rail.color.setHex(warn > 0.5 ? PALETTE.uiWarn : FLIGHT_ROUTE_MARKER_COLOR, THREE.NoColorSpace);
      visual.ring.color.setHex(warn > 0.5 ? PALETTE.uiWarn : FLIGHT_ROUTE_MARKER_COLOR, THREE.NoColorSpace);
      visual.rail.opacity = recovery > 0
        ? 0.34 * (1 - visual.recoverySurfaceBlend)
        : warn > 0.5 ? 0.72 : 0.34 + (upcoming ? readyStep * 0.08 : 0);
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
        gate.group.visible = !gate.cleared || gate.pulse > 0.06;
        const distance = upcoming ? gate.center.distanceTo(this.playerPosition) : 0;
        const far = Math.max(0, Math.min(1, (distance - 70) / 150));
        const smoothFar = far * far * (3 - 2 * far);
        const anchorScale = 1 + smoothFar * 0.75;
        gate.anchor.scale.setScalar(anchorScale);
        if (upcoming) this.playerTargetAnchorScale = anchorScale;
        gate.anchor.rotation.z = this.flightFlowTime * 0.18;
        (gate.anchor.material as THREE.MeshBasicMaterial).opacity =
          0.68 + Math.sin(this.flightFlowTime * 3.4) * 0.12;
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
    const visualStartU = def.entryU;
    const SEG = Math.max(64, Math.ceil(runtime.routeLength / 1.8));
    const HALF_W = def.corridorHalfWidth;
    const pos = new Float32Array((SEG + 1) * 2 * 3);
    const uv = new Float32Array((SEG + 1) * 2 * 2);
    const idx = new Uint16Array(SEG * 6);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();

    for (let i = 0; i <= SEG; i++) {
      const f = i / SEG;
      const u = visualStartU + (def.exitU - visualStartU) * f;
      this.routePointAt(def.id, u, p);
      this.routeTangentAt(def.id, u, t);
      const rx = t.z;
      const rz = -t.x;
      const startTaper = THREE.MathUtils.smoothstep(f, 0, FLIGHT_GUIDE_ENDPOINT_TAPER_F);
      const endTaper = THREE.MathUtils.smoothstep(1 - f, 0, FLIGHT_GUIDE_ENDPOINT_TAPER_F);
      const endpointWidth = FLIGHT_GUIDE_ENDPOINT_MIN_WIDTH +
        (1 - FLIGHT_GUIDE_ENDPOINT_MIN_WIDTH) * Math.min(startTaper, endTaper);
      const width = HALF_W * endpointWidth;
      const o = i * 6;
      pos[o] = p.x + rx * width;
      pos[o + 1] = p.y + 0.05;
      pos[o + 2] = p.z + rz * width;
      pos[o + 3] = p.x - rx * width;
      pos[o + 4] = p.y + 0.05;
      pos[o + 5] = p.z - rz * width;
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
        uHasTurn: { value: def.navigation?.turn ? 1 : 0 },
        uTurnFrom: { value: def.navigation?.turn ? flightVisualT(def, def.navigation.turn.fromU) : 0 },
        uTurnTo: { value: def.navigation?.turn ? flightVisualT(def, def.navigation.turn.toU) : 1 },
        uEntryF: { value: flightVisualT(def, def.entryU) },
        uRecovery: { value: 0 },
        uRecoverySurface: { value: 0 },
        uRecoveryProgress: { value: flightVisualT(def, def.gateUs[def.gateUs.length - 1]) },
        uGateF: { value: flightVisualT(def, def.gateUs[def.gateUs.length - 1]) },
        uFlight: { value: new THREE.Color().setHex(PALETTE.flightMist, THREE.NoColorSpace) },
        uFlightDeep: { value: new THREE.Color().setHex(PALETTE.flightMistShade, THREE.NoColorSpace) },
        uRecoveryColor: { value: new THREE.Color().setHex(PALETTE.flightMist, THREE.NoColorSpace) },
        uInk: { value: new THREE.Color().setHex(PALETTE.ink, THREE.NoColorSpace) },
        uFoam: { value: new THREE.Color().setHex(PALETTE.flightMist, THREE.NoColorSpace) },
        uTurnColor: { value: new THREE.Color().setHex(PALETTE.sunFlare, THREE.NoColorSpace) },
        uWarnColor: { value: new THREE.Color().setHex(PALETTE.uiWarn, THREE.NoColorSpace) },
        // A neutral mist corridor: the ocean supplies its own blue while white
        // structure carries distance and motion without another color slab.
        uPanelAlpha: { value: FLIGHT_GUIDE_PANEL_ALPHA },
        uPanelBeatAlpha: { value: FLIGHT_GUIDE_PANEL_BEAT_ALPHA },
        uCenterAlpha: { value: FLIGHT_GUIDE_CENTER_ALPHA },
        uEdgeAlpha: { value: FLIGHT_GUIDE_EDGE_ALPHA },
        uFlowAlpha: { value: FLIGHT_GUIDE_FLOW_ALPHA },
        uFarStart: { value: FLIGHT_GUIDE_FAR_START_M },
        uFarEnd: { value: FLIGHT_GUIDE_FAR_END_M },
        // Warm color belongs to the authored chevrons, never the whole route.
        uTurnTintMax: { value: 0.14 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uRecovery;
        uniform float uRecoverySurface;
        uniform float uGateF;
        uniform float uEntryF;
        varying vec2 vUv;
        varying float vViewDepth;
        ${WAVES_GLSL}
        void main() {
          vUv = uv;
          vec3 p = position;
          float approach = 1.0 - smoothstep(uEntryF, min(1.0, uEntryF + 0.03), uv.y);
          p.y = mix(p.y, waveHeight(p.xz, uTime) + 0.22, approach);
          float recoveryTail = uRecovery * uRecoverySurface * step(uGateF - 0.003, uv.y);
          p.y = mix(p.y, waveHeight(p.xz, uTime) + 0.22, recoveryTail);
          vec4 viewPosition = modelViewMatrix * vec4(p, 1.0);
          vViewDepth = max(0.0, -viewPosition.z);
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uWarn;
        uniform float uReady;
        uniform float uTurn;
        uniform float uHasTurn;
        uniform float uTurnFrom;
        uniform float uTurnTo;
        uniform float uRecovery;
        uniform float uRecoveryProgress;
        uniform float uGateF;
        uniform vec3 uFlight;
        uniform vec3 uFlightDeep;
        uniform vec3 uRecoveryColor;
        uniform vec3 uInk;
        uniform vec3 uFoam;
        uniform vec3 uTurnColor;
        uniform vec3 uWarnColor;
        uniform float uPanelAlpha;
        uniform float uPanelBeatAlpha;
        uniform float uCenterAlpha;
        uniform float uEdgeAlpha;
        uniform float uFlowAlpha;
        uniform float uFarStart;
        uniform float uFarEnd;
        uniform float uTurnTintMax;
        varying vec2 vUv;
        varying float vViewDepth;
        void main() {
          float farBoost = smoothstep(uFarStart, uFarEnd, vViewDepth);
          float uvPixel = max(fwidth(vUv.x), 0.0005);
          float side = min(vUv.x, 1.0 - vUv.x);
          float inkWidth = max(0.009, uvPixel * 1.05);
          float edgeWidth = max(0.032, uvPixel * 2.2);
          float inkEdge = 1.0 - smoothstep(inkWidth * 0.25, inkWidth, side);
          float edgeBand = (1.0 - smoothstep(inkWidth * 0.7, edgeWidth, side)) *
            (1.0 - inkEdge * 0.82);

          float wave = sin(vUv.y * 46.0 - uTime * 4.2) * 0.011;
          float flowWidth = max(0.018, uvPixel * 1.2);
          float flowA = 1.0 - smoothstep(flowWidth * 0.35, flowWidth,
            abs(vUv.x - (0.42 + wave)));
          float flowB = 1.0 - smoothstep(flowWidth * 0.35, flowWidth,
            abs(vUv.x - (0.58 - wave)));
          float packetPhase = fract(vUv.y * 12.0 - uTime * 1.72);
          float packetTail = smoothstep(0.02, 0.18, packetPhase) *
            (1.0 - smoothstep(0.58, 0.96, packetPhase));
          float packetHead = 1.0 - smoothstep(0.035, 0.13, abs(packetPhase - 0.18));
          float packet = max(packetTail * 0.58, packetHead);
          float flow = max(flowA, flowB) * (0.34 + packet * 0.66);
          float turnIn = smoothstep(uTurnFrom, min(uTurnFrom + 0.025, uTurnTo), vUv.y);
          float turnOut = 1.0 - smoothstep(max(uTurnFrom, uTurnTo - 0.025), uTurnTo, vUv.y);
          float turnZone = uHasTurn * turnIn * turnOut;
          float panelCell = smoothstep(0.04, 0.13, fract(vUv.y * 18.0)) *
            (1.0 - smoothstep(0.82, 0.96, fract(vUv.y * 18.0)));
          // Low-frequency density changes make the corridor read as moving
          // air and sea spray. The field never reaches zero, so the route
          // remains stable while its surface stops looking like glass.
          float mistWave = 0.5 + 0.24 * sin(vUv.y * 13.0 - uTime * 0.72 + vUv.x * 5.0) +
            0.17 * sin(vUv.y * 31.0 + uTime * 0.38 - vUv.x * 9.0) +
            0.09 * sin(vUv.y * 57.0 - uTime * 1.1 + vUv.x * 13.0);
          float mistDensity = smoothstep(0.22, 0.72, mistWave);
          float mistBreak = 0.36 + mistDensity * 0.64;
          float scan = step(0.78, fract(vUv.y * 22.0 - uTime * 0.8));
          vec3 panelColor = mix(uFlightDeep, uFlight, 0.34 + panelCell * 0.12);
          vec3 edgeColor = uFlight;
          vec3 flowColor = uFlight;
          vec3 color = panelColor;
          color = mix(color, edgeColor, edgeBand * (0.72 + farBoost * 0.16));
          color = mix(color, flowColor, flow * (0.76 + farBoost * 0.14));
          color = mix(color, uInk, inkEdge * (0.72 + farBoost * 0.12));
          float brakeInk = turnZone * (0.32 + packet * 0.14);
          float turnTint = min(uTurnTintMax, brakeInk * 0.34 + uTurn * turnZone * 0.06);
          color = mix(color, uTurnColor, turnTint);
          color = mix(color, uWarnColor, uWarn);
          float ready = uReady * step(0.5, fract(uTime * 4.0));
          float virtualPanel = (1.0 - inkEdge) *
            (uPanelAlpha * mix(0.76, 1.0, panelCell) + scan * uPanelBeatAlpha + farBoost * 0.04) * 0.12;
          float centerVeil = (1.0 - smoothstep(0.08, 0.48, abs(vUv.x - 0.5))) * mistBreak;
          float alpha = virtualPanel * mistBreak + centerVeil * uCenterAlpha * 0.2 +
            edgeBand * (uEdgeAlpha * 0.58 + farBoost * 0.08) +
            inkEdge * (0.2 + farBoost * 0.06) +
            flow * (uFlowAlpha + farBoost * 0.14 + ready * 0.08);
          alpha += turnZone * (0.055 + packet * 0.05);

          float recoveryT = smoothstep(uGateF, 1.0, vUv.y);
          float recoverySide = abs(vUv.x - 0.5);
          float recoveryHalf = mix(0.48, 0.14, recoveryT);
          float recoveryNorm = recoverySide / max(0.001, recoveryHalf);
          float recoveryPixel = uvPixel / max(0.15, recoveryHalf * 2.0);
          float recoveryInkWidth = max(0.024, recoveryPixel * 1.05);
          float recoveryEdgeWidth = max(0.09, recoveryPixel * 2.2);
          float recoveryInk = smoothstep(1.0 - recoveryInkWidth, 1.0, recoveryNorm) *
            (1.0 - smoothstep(1.0, 1.0 + recoveryInkWidth, recoveryNorm));
          float recoveryEdge = smoothstep(1.0 - recoveryEdgeWidth, 1.0 - recoveryInkWidth * 0.5,
            recoveryNorm) * (1.0 - recoveryInk * 0.8);
          float recoveryVeil = (1.0 - smoothstep(0.78, 1.02, recoveryNorm)) * mistBreak;
          float recoveryCenter = (1.0 - smoothstep(0.08, 0.7, recoveryNorm)) * mistBreak;
          float recoveryFlowWidth = max(0.022, uvPixel * 1.2);
          float recoveryFlow = (1.0 - smoothstep(recoveryFlowWidth * 0.35, recoveryFlowWidth,
            abs(recoverySide - recoveryHalf * 0.3))) * (0.34 + packet * 0.66);
          float recoveryAlpha = recoveryVeil *
            (uPanelAlpha * mix(0.78, 1.0, panelCell) + farBoost * 0.04) * 0.12 +
            recoveryCenter * uCenterAlpha * 0.2 +
            recoveryEdge * (uEdgeAlpha * 0.58 + farBoost * 0.08) +
            recoveryInk * (0.2 + farBoost * 0.06) +
            recoveryFlow * (uFlowAlpha * 0.9 + farBoost * 0.14);
          recoveryAlpha = min(recoveryAlpha, 0.82);
          float recoveryStart = max(uGateF - 0.003, uRecoveryProgress - 0.035);
          float recoveryVisibleHard = step(recoveryStart, vUv.y);
          float recoveryVisible = smoothstep(recoveryStart, min(1.0, recoveryStart + 0.035), vUv.y);
          // Keep the ownership edge available for deterministic diagnostics,
          // while the rendered mist eases in across the first few metres.
          recoveryVisible = mix(recoveryVisibleHard, recoveryVisible, 0.94);
          vec3 recoveryColor = panelColor;
          recoveryColor = mix(recoveryColor, edgeColor, recoveryEdge * (0.72 + farBoost * 0.16));
          recoveryColor = mix(recoveryColor, flowColor, recoveryFlow * (0.76 + farBoost * 0.14));
          recoveryColor = mix(recoveryColor, uInk, recoveryInk * (0.72 + farBoost * 0.12));
          float recoveryMode = step(0.001, uRecovery);
          color = mix(color, recoveryColor, recoveryMode * recoveryVisible);
          alpha = mix(min(alpha, 0.82), recoveryAlpha * recoveryVisible * uRecovery, recoveryMode);
          float endpointDistance = min(vUv.y, 1.0 - vUv.y);
          float endpointFade = smoothstep(0.0, ${FLIGHT_GUIDE_ENDPOINT_TAPER_F.toFixed(3)}, endpointDistance);
          float endpointAlpha = mix(${FLIGHT_GUIDE_ENDPOINT_MIN_ALPHA.toFixed(2)}, 1.0, endpointFade);
          gl_FragColor = vec4(color, min(alpha * endpointAlpha, 0.82));
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    ribbonMat.forceSinglePass = true;
    const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
    ribbon.name = `${def.id}-ribbon`;
    ribbon.userData.visualStartU = visualStartU;
    ribbon.userData.authoredEntryU = def.entryU;
    ribbon.userData.turnTintMax = ribbonMat.uniforms.uTurnTintMax.value;
    ribbon.userData.guideStyle = FLIGHT_GUIDE_STYLE;
    ribbon.userData.endpointTaperF = FLIGHT_GUIDE_ENDPOINT_TAPER_F;
    ribbon.userData.endpointMinWidth = FLIGHT_GUIDE_ENDPOINT_MIN_WIDTH;
    ribbon.userData.endpointMinAlpha = FLIGHT_GUIDE_ENDPOINT_MIN_ALPHA;
    ribbon.renderOrder = 3;
    ribbon.layers.enable(LAYER_ENERGY);
    routeGroup.add(ribbon);

    // Directional handoff markers appear only after the scoring portal. They
    // stay neutral mist and follow the authored flight height until the hull actually
    // reaches water; contact then blends the same markers onto the swell.
    const arrowGeo = buildSurfaceChevronGeometry();
    const recoveryArrowMaterial = buildSurfaceCueMaterial(
      this.ribbonMat.uniforms.uTime,
      FLIGHT_ROUTE_MARKER_COLOR,
      0,
      true,
      ribbonMat.uniforms.uRecoverySurface,
    );
    const recoveryArrows = new THREE.InstancedMesh(arrowGeo, recoveryArrowMaterial, 7);
    recoveryArrows.name = `${def.id}-recovery-arrows`;
    recoveryArrows.visible = false;
    recoveryArrows.renderOrder = 5;
    const arrowTransform = new THREE.Object3D();
    const recoveryArrowFractions: number[] = [];
    const recoveryArrowPhases = new THREE.InstancedBufferAttribute(new Float32Array(7), 1);
    for (let i = 0; i < 7; i++) recoveryArrowPhases.setX(i, i / 7);
    arrowGeo.setAttribute('aPhase', recoveryArrowPhases);
    for (let i = 0; i < 7; i++) {
      const routeF = runtime.gateFraction + (1 - runtime.gateFraction) * ((i + 0.7) / 7.7);
      const u = def.entryU + (def.exitU - def.entryU) * routeF;
      recoveryArrowFractions.push(flightVisualT(def, u));
      runtimePointAt(runtime, u, p);
      runtimeTangentAt(runtime, u, t);
      arrowTransform.position.set(p.x, 0.28, p.z);
      arrowTransform.rotation.set(0, Math.atan2(t.x, t.z), 0);
      const taper = 0.96 - i * 0.025;
      arrowTransform.scale.setScalar(taper);
      arrowTransform.updateMatrix();
      recoveryArrows.setMatrixAt(i, arrowTransform.matrix);
    }
    recoveryArrows.instanceMatrix.needsUpdate = true;
    routeGroup.add(recoveryArrows);

    let turnChevronGroup: THREE.Group | null = null;
    let turnChevronFill: THREE.MeshBasicMaterial | null = null;
    let turnChevronCount = 0;
    const turn = def.navigation?.turn;
    if (turn) {
      const markerSpecs: Array<{
        cue: { fromU: number; toU: number; direction: 'left' | 'right' };
        f: number;
        role: 'entry' | 'counter';
      }> = [0.16, 0.31, 0.46].map((f) => ({ cue: turn, f, role: 'entry' }));
      if (def.navigation?.counterTurn) {
        markerSpecs.push(
          { cue: def.navigation.counterTurn, f: 0.28, role: 'counter' },
          { cue: def.navigation.counterTurn, f: 0.7, role: 'counter' },
        );
      }
      turnChevronCount = markerSpecs.length;
      turnChevronGroup = new THREE.Group();
      turnChevronGroup.name = `${def.id}-marine-chevrons-${turn.direction}`;
      turnChevronGroup.userData.entryMarkerCount = 3;
      turnChevronGroup.userData.counterMarkerCount = markerSpecs.length - 3;
      turnChevronGroup.userData.counterDirection = def.navigation?.counterTurn?.direction ?? 'none';
      const backingMaterial = new THREE.MeshBasicMaterial({
        color: PALETTE.ink,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      turnChevronFill = new THREE.MeshBasicMaterial({
        color: PALETTE.sunFlare,
        transparent: true,
        opacity: def.index === 4 ? 0.9 : 0.82,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const backing = new THREE.InstancedMesh(makeOpenChevronGeometry(), backingMaterial, turnChevronCount);
      const fill = new THREE.InstancedMesh(makeOpenChevronGeometry(0.055), turnChevronFill, turnChevronCount);
      backing.name = `${def.id}-chevron-ink`;
      fill.name = `${def.id}-chevron-fill`;
      backing.renderOrder = 5;
      fill.renderOrder = 6;
      const marker = new THREE.Object3D();
      const fillMarker = new THREE.Object3D();
      for (let i = 0; i < markerSpecs.length; i++) {
        const spec = markerSpecs[i];
        // Keep the three road-grade chevrons together near the decision point.
        // A compact, lane-width cluster reads through waves and perspective;
        // small markers spread across the whole bend disappear one by one.
        const u = THREE.MathUtils.lerp(spec.cue.fromU, spec.cue.toU, spec.f);
        runtimePointAt(runtime, u, p);
        runtimeTangentAt(runtime, u, t).setY(0).normalize();
        marker.position.set(p.x, p.y + 0.17, p.z);
        // In this boat frame local +X is port/left when +Z follows the route.
        // Flip only right-turn chevrons toward starboard.
        marker.rotation.set(0, Math.atan2(t.x, t.z) + (spec.cue.direction === 'right' ? Math.PI : 0), 0);
        marker.scale.set(Math.min(4.5, Math.max(3.4, HALF_W * 0.62)), 1.08, 1.85);
        marker.updateMatrix();
        backing.setMatrixAt(i, marker.matrix);
        fillMarker.position.copy(marker.position);
        fillMarker.rotation.copy(marker.rotation);
        fillMarker.scale.copy(marker.scale).multiplyScalar(0.7);
        fillMarker.updateMatrix();
        fill.setMatrixAt(i, fillMarker.matrix);
      }
      backing.instanceMatrix.needsUpdate = true;
      fill.instanceMatrix.needsUpdate = true;
      turnChevronGroup.add(backing, fill);
      if (def.index === 4) {
        const verticalInk = makeVerticalChevronGeometry();
        const verticalFill = makeVerticalChevronGeometry(0.055);
        const mastGeometry = new THREE.CylinderGeometry(0.07, 0.11, 1, 6);
        const buoyGeometry = new THREE.CylinderGeometry(0.34, 0.48, 0.5, 8);
        const foamGeometry = makeFoamRingGeometry();
        const mastMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.ink, toneMapped: false });
        const buoyMaterial = new THREE.MeshBasicMaterial({ color: FLIGHT_ROUTE_MARKER_SHADE, toneMapped: false });
        const foamMaterial = new THREE.MeshBasicMaterial({
          color: PALETTE.foam,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        for (let i = 0; i < markerSpecs.length; i++) {
          const spec = markerSpecs[i];
          const u = THREE.MathUtils.lerp(spec.cue.fromU, spec.cue.toU, spec.f);
          runtimePointAt(runtime, u, p);
          runtimeTangentAt(runtime, u, t).setY(0).normalize();
          const outside = spec.cue.direction === 'right' ? 1 : -1;
          const support = new THREE.Group();
          support.name = `${def.id}-chevron-buoy-${i + 1}`;
          support.userData.turnRole = spec.role;
          support.userData.turnDirection = spec.cue.direction;
          support.userData.routeTangentX = t.x;
          support.userData.routeTangentZ = t.z;
          support.position.set(p.x + t.z * (HALF_W + 1.75) * outside, 0, p.z - t.x * (HALF_W + 1.75) * outside);
          const buoy = new THREE.Mesh(buoyGeometry, buoyMaterial);
          buoy.position.y = 0.24;
          const foam = new THREE.Mesh(foamGeometry, foamMaterial);
          foam.position.y = 0.45;
          foam.scale.setScalar(0.38);
          const mastHeight = Math.max(3.8, p.y + 1.05);
          const mast = new THREE.Mesh(mastGeometry, mastMaterial);
          mast.position.y = mastHeight * 0.5;
          mast.scale.y = mastHeight;
          const signInk = new THREE.Mesh(verticalInk, backingMaterial);
          signInk.position.y = mastHeight;
          signInk.scale.setScalar(1.08);
          const sign = new THREE.Mesh(verticalFill, turnChevronFill);
          sign.position.set(0, mastHeight, 0.055);
          sign.scale.setScalar(0.78);
          sign.renderOrder = 6;
          support.add(buoy, foam, mast, signInk, sign);
          turnChevronGroup.add(support);
          // Local +X is port/left in the route frame, so right cues need the
          // half-turn. DoubleSide affects visibility, never cue direction.
          const yaw = Math.atan2(t.x, t.z) + (spec.cue.direction === 'right' ? Math.PI : 0);
          this.floaters.push({
            obj: support,
            x: support.position.x,
            z: support.position.z,
            yawQ: new THREE.Quaternion().setFromAxisAngle(UP, yaw),
          });
        }
      }
      routeGroup.add(turnChevronGroup);
    }

    const railMat = new THREE.MeshBasicMaterial({
      color: FLIGHT_ROUTE_MARKER_COLOR,
      transparent: true,
      opacity: 0.42,
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
      const rail = new THREE.Mesh(new THREE.TubeGeometry(railCurve, 120, 0.07, 5, false), railMat);
      rail.name = `${def.id}-rail-${side > 0 ? 'r' : 'l'}`;
      rail.renderOrder = 4;
      rail.layers.enable(LAYER_ENERGY);
      routeGroup.add(rail);
    }

    const ringMat = new THREE.MeshBasicMaterial({
      color: FLIGHT_ROUTE_MARKER_COLOR,
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
    const anchorMat = new THREE.MeshBasicMaterial({
      color: PALETTE.ink,
      transparent: true,
      opacity: 0.76,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const spineMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink, toneMapped: false });
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
      runtimeTangentAt(runtime, u, tangent3).normalize();
      const normal = new THREE.Vector3(tangent3.x, 0, tangent3.z).normalize();
      const right = new THREE.Vector3(normal.z, 0, -normal.x);
      const gateGroup = new THREE.Group();
      gateGroup.name = `${def.id}-gate-${i + 1}`;
      gateGroup.position.copy(center);
      gateGroup.quaternion.setFromUnitVectors(forward, tangent3);
      const pillarHeight = gateHalfHeight * 2 + 1.8;
      const corePillars: THREE.Mesh[] = [];
      for (const side of [-1, 1]) {
        const spine = new THREE.Mesh(beamGeo, spineMat);
        spine.position.set(side * (def.passHalfWidth + 0.42), 0, 0.18);
        spine.scale.set(0.8, pillarHeight * 1.08, 0.28);
        const outer = new THREE.Mesh(pillarGeo, ringMat);
        outer.position.set(side * (def.passHalfWidth + 0.52), 0, 0);
        outer.scale.set(0.5, pillarHeight, 0.5);
        const core = new THREE.Mesh(corePillarGeo, coreMat);
        corePillars.push(core);
        core.position.copy(outer.position);
        core.scale.set(0.16, pillarHeight * 1.04, 0.16);
        const buoy = new THREE.Mesh(buoyGeo, ringMat);
        buoy.position.set(side * def.gateHalfWidth, -pillarHeight * 0.46, 0);
        buoy.scale.set(0.95, 0.55, 0.95);
        gateGroup.add(spine, outer, core, buoy);
      }
      const beamSpine = new THREE.Mesh(beamGeo, spineMat);
      beamSpine.position.y = gateHalfHeight + 0.62;
      beamSpine.position.z = 0.2;
      beamSpine.scale.set(def.passHalfWidth * 2 + 1.85, 0.62, 0.28);
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
      const anchor = new THREE.Mesh(
        new THREE.RingGeometry(def.passHalfWidth + 1.2, def.passHalfWidth + 1.62, 32),
        anchorMat,
      );
      anchor.position.z = 0.42;
      gateGroup.add(beamSpine, beam, beamCore, surfaceLock, lockBeam, anchor);
      if (def.navigation?.locatorU !== undefined && Math.abs(def.navigation.locatorU - u) < 0.012) {
        const locatorMaterial = new THREE.MeshBasicMaterial({
          color: FLIGHT_ROUTE_MARKER_COLOR,
          transparent: true,
          opacity: 0.72,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        const locatorStem = new THREE.Mesh(beamGeo, locatorMaterial);
        locatorStem.name = `${def.id}-locator-stem`;
        locatorStem.position.set(0, gateHalfHeight + 2.25, 0.46);
        locatorStem.scale.set(0.09, 2.7, 0.09);
        const locator = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.34, 4), locatorMaterial);
        locator.name = `${def.id}-locator-diamond`;
        locator.position.set(0, gateHalfHeight + 4.7, 0.48);
        locator.rotation.z = Math.PI * 0.25;
        locator.renderOrder = 8;
        gateGroup.add(locatorStem, locator);
      }
      gateGroup.traverse((o) => o.layers.enable(LAYER_ENERGY));
      gateGroup.traverse((o) => {
        if (o.name.startsWith(`${def.id}-locator-`)) o.layers.disable(LAYER_ENERGY);
      });
      surfaceLock.layers.disable(LAYER_ENERGY);
      beamCore.layers.disable(LAYER_ENERGY);
      for (const core of corePillars) core.layers.disable(LAYER_ENERGY);
      beamSpine.layers.disable(LAYER_ENERGY);
      anchor.layers.disable(LAYER_ENERGY);
      gateGroup.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material === spineMat) o.layers.disable(LAYER_ENERGY);
      });
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
        anchor,
        cleared: false,
      });
    }

    return {
      runtime,
      group: routeGroup,
      ribbonMesh: ribbon,
      ribbon: ribbonMat,
      rail: railMat,
      ring: ringMat,
      recoveryArrows,
      recoveryArrowMaterial,
      recoveryArrowFractions,
      turnChevronGroup,
      turnChevronFill,
      turnChevronCount,
      gates,
      deployActive: false,
      deployTime: 0,
      recoveryFade: 0,
      recoveryProgress: flightVisualT(def, def.gateUs[def.gateUs.length - 1]),
      recoverySurfaceBlend: 0,
    };
  }

  // ------------------------------------------------------------- ribbon ----

  private buildLaunchGateVisual(runtime: FlightRouteRuntime): LaunchGateVisual {
    const def = runtime.def;
    const group = new THREE.Group();
    group.name = `${def.id}-launch-gate`;
    group.visible = false;
    this.object.add(group);
    const launchCueU = flightLaunchCueU(def);
    const launch = this.pointAt(launchCueU, new THREE.Vector3());
    const launchTangent = this.tangentAt(launchCueU, new THREE.Vector3()).setY(0).normalize();
    const postureU = def.navigation?.turn?.fromU ?? THREE.MathUtils.lerp(def.entryU, def.gateUs[0], 0.18);
    const postureTarget = runtimePointAt(runtime, postureU, new THREE.Vector3());
    const postureDirection = new THREE.Vector3(
      postureTarget.x - launch.x,
      0,
      postureTarget.z - launch.z,
    ).normalize();
    if (postureDirection.lengthSq() < 0.5) postureDirection.copy(launchTangent);
    const vectorLength = def.navigation?.launchVectorLengthM ?? 22;
    const vectorControl = launch.clone().addScaledVector(
      launchTangent,
      Math.min(12, vectorLength * 0.386),
    );
    vectorControl.y = 0;
    const vectorEnd = launch.clone().addScaledVector(postureDirection, vectorLength);
    vectorEnd.y = 0;
    const vectorCurve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(launch.x, 0, launch.z),
      vectorControl,
      vectorEnd,
    );
    const clearances = [1.4, 4, 6.3];
    group.userData.launchVectorClearances = [...clearances];
    const path = [0, 0.5, 1].map((fraction, index) => {
      const point = vectorCurve.getPoint(fraction);
      point.y = clearances[index];
      return point;
    });
    const firstVector = new THREE.Vector3().subVectors(path[1], path[0]).setY(0).normalize();
    const finalVector = new THREE.Vector3().subVectors(path[2], path[1]).setY(0).normalize();
    const headingDelta = Math.atan2(
      firstVector.x * finalVector.z - firstVector.z * finalVector.x,
      firstVector.x * finalVector.x + firstVector.z * finalVector.z,
    );
    const measuredVectorDirection = Math.abs(headingDelta) < THREE.MathUtils.degToRad(0.5)
      ? 'straight'
      : headingDelta > 0 ? 'right' : 'left';
    const authoredDirection = def.navigation?.turn?.direction ?? 'straight';
    group.userData.launchVectorDirection = authoredDirection;
    group.userData.launchMeasuredDirection = measuredVectorDirection;
    group.userData.launchAuthoredDirection = authoredDirection;
    group.userData.launchCueU = launchCueU;
    group.userData.launchVectorPathLengthM = path.slice(1).reduce((sum, point, index) =>
      sum + Math.hypot(point.x - path[index].x, point.z - path[index].z), 0);
    group.userData.launchVectorHeadingDeltaDeg = THREE.MathUtils.radToDeg(headingDelta);

    const projectorBody = new THREE.CylinderGeometry(0.34, 0.43, 0.62, 8);
    const projectorFloat = new THREE.TorusGeometry(0.48, 0.14, 8, 16);
    projectorFloat.rotateX(Math.PI / 2);
    const projectorLens = new THREE.OctahedronGeometry(0.26, 0);
    const bodyMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.ink, toneMapped: false });
    const floatMaterial = new THREE.MeshBasicMaterial({ color: FLIGHT_ROUTE_MARKER_SHADE, toneMapped: false });
    const lensMaterial = new THREE.MeshBasicMaterial({
      color: PALETTE.sunFlare,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      toneMapped: false,
    });
    const right = new THREE.Vector3(launchTangent.z, 0, -launchTangent.x);
    const entry = this.pointAt(def.entryU, new THREE.Vector3());
    const entryTangent = this.tangentAt(def.entryU, new THREE.Vector3()).setY(0).normalize();
    const entryRight = new THREE.Vector3(entryTangent.z, 0, -entryTangent.x);
    const tornadoBoundaryOffset = def.corridorHalfWidth + 0.45;
    group.userData.launchTornadoEntryU = def.entryU;
    group.userData.launchTornadoBoundaryOffsetM = tornadoBoundaryOffset;
    const projectors: LaunchGateProjector[] = [];
    const tornadoes: LaunchGateTornado[] = [];
    for (const side of [-1, 1]) {
      const tornadoPhase = side < 0 ? -0.48 : 0.48;
      const root = new THREE.Group();
      root.name = `${def.id}-launch-projector-${side < 0 ? 'left' : 'right'}`;
      const x = launch.x + right.x * 5.2 * side;
      const z = launch.z + right.z * 5.2 * side;
      root.position.set(x, 0, z);
      const floater = new THREE.Mesh(projectorFloat, floatMaterial);
      floater.position.y = 0.2;
      const body = new THREE.Mesh(projectorBody, bodyMaterial);
      body.position.y = 0.54;
      const lens = new THREE.Mesh(projectorLens, lensMaterial);
      lens.position.y = 1.02;
      lens.rotation.y = Math.PI * 0.25;
      lens.layers.enable(LAYER_ENERGY);
      root.add(floater, body, lens);
      group.add(root);
      projectors.push({ root, lens: lensMaterial, x, z });

      const tornadoRoot = new THREE.Group();
      tornadoRoot.name = `${def.id}-launch-tornado-${side < 0 ? 'left' : 'right'}`;
      const tornadoX = entry.x + entryRight.x * tornadoBoundaryOffset * side;
      const tornadoZ = entry.z + entryRight.z * tornadoBoundaryOffset * side;
      tornadoRoot.position.set(tornadoX, 0, tornadoZ);
      const smoke = new THREE.Group();
      smoke.name = `${def.id}-launch-tornado-smoke-${side < 0 ? 'left' : 'right'}`;
      for (let ribbon = 0; ribbon < LAUNCH_TORNADO_SMOKE_RIBBON_GEOMETRIES.length; ribbon++) {
        const mesh = new THREE.Mesh(
          LAUNCH_TORNADO_SMOKE_RIBBON_GEOMETRIES[ribbon],
          LAUNCH_TORNADO_SMOKE_RIBBON_MATERIALS[ribbon],
        );
        mesh.name = `${def.id}-launch-tornado-smoke-ribbon-${side}-${ribbon + 1}`;
        mesh.renderOrder = 5;
        smoke.add(mesh);
      }
      for (let puff = 0; puff < LAUNCH_TORNADO_SMOKE_PUFF_MATERIALS.length; puff++) {
        const mesh = makeLaunchTornadoSmokePuffs(
          tornadoPhase + puff * Math.PI * 0.8,
          LAUNCH_TORNADO_SMOKE_PUFF_MATERIALS[puff],
        );
        mesh.name = `${def.id}-launch-tornado-smoke-puffs-${side}-${puff + 1}`;
        mesh.renderOrder = 4;
        smoke.add(mesh);
      }
      const foamRing = new THREE.Mesh(LAUNCH_TORNADO_BASE_GEOMETRY, LAUNCH_TORNADO_BASE_MATERIAL);
      foamRing.name = `${def.id}-launch-tornado-base-${side}`;
      foamRing.rotation.x = Math.PI * 0.5;
      foamRing.position.y = 0.08;
      foamRing.renderOrder = 5;
      const bolt = new THREE.Mesh(
        LAUNCH_TORNADO_BOLT_GEOMETRY,
        LAUNCH_TORNADO_BOLT_MATERIALS[side < 0 ? 0 : 1],
      );
      bolt.name = `${def.id}-launch-tornado-bolt-${side < 0 ? 'left' : 'right'}`;
      bolt.position.y = 1.78;
      bolt.rotation.y = Math.atan2(entryTangent.x, entryTangent.z);
      bolt.renderOrder = 6;
      const branch = new THREE.Mesh(
        LAUNCH_TORNADO_BOLT_GEOMETRY,
        LAUNCH_TORNADO_BOLT_MATERIALS[side < 0 ? 0 : 1],
      );
      branch.name = `${def.id}-launch-tornado-branch-${side < 0 ? 'left' : 'right'}`;
      branch.position.set(0.12 * side, 2.42, 0);
      branch.rotation.y = Math.atan2(entryTangent.x, entryTangent.z) + side * 0.65;
      branch.renderOrder = 6;
      const core = new THREE.Group();
      core.name = `${def.id}-launch-tornado-core-${side < 0 ? 'left' : 'right'}`;
      core.position.y = LAUNCH_TORNADO_HEIGHT_M * 0.54;
      const coreShell = new THREE.Mesh(
        LAUNCH_TORNADO_CORE_GEOMETRY,
        LAUNCH_TORNADO_CORE_MATERIALS[side < 0 ? 0 : 1],
      );
      coreShell.name = `${def.id}-launch-tornado-core-shell-${side < 0 ? 'left' : 'right'}`;
      coreShell.renderOrder = 6;
      const orbitA = new THREE.Mesh(
        LAUNCH_TORNADO_ORBIT_GEOMETRY,
        LAUNCH_TORNADO_ORBIT_MATERIALS[side < 0 ? 0 : 1],
      );
      orbitA.name = `${def.id}-launch-tornado-core-orbit-a-${side < 0 ? 'left' : 'right'}`;
      orbitA.rotation.set(Math.PI * 0.31, side * 0.24, 0);
      orbitA.renderOrder = 6;
      const orbitB = new THREE.Mesh(
        LAUNCH_TORNADO_ORBIT_GEOMETRY,
        LAUNCH_TORNADO_ORBIT_MATERIALS[side < 0 ? 0 : 1],
      );
      orbitB.name = `${def.id}-launch-tornado-core-orbit-b-${side < 0 ? 'left' : 'right'}`;
      orbitB.rotation.set(-Math.PI * 0.34, side * 1.1, Math.PI * 0.25);
      orbitB.renderOrder = 6;
      core.add(coreShell, orbitA, orbitB);
      tornadoRoot.add(smoke, foamRing, core, bolt, branch);
      group.add(tornadoRoot);
      tornadoes.push({
        root: tornadoRoot,
        smoke,
        core,
        bolt,
        branch,
        x: tornadoX,
        z: tornadoZ,
        side,
        phase: tornadoPhase,
      });
    }

    const inkGeometry = new THREE.RingGeometry(0.72, 1.12, 4);
    const energyGeometry = new THREE.RingGeometry(0.68, 1.02, 4);
    const postureGeometry = makeVerticalChevronGeometry(0);
    const diamonds: LaunchGateDiamond[] = [];
    const forward = new THREE.Vector3(0, 0, 1);
    const waveWeights = [1, 0.42, 0];
    const turnDirection = authoredDirection === 'straight' ? 'none' : authoredDirection;
    group.userData.launchPostureDirection = turnDirection;
    const bankDirection = turnDirection === 'left' ? 1 : turnDirection === 'right' ? -1 : 0;
    for (let i = 0; i < path.length; i++) {
      const root = new THREE.Group();
      root.name = `${def.id}-launch-diamond-${i + 1}`;
      const direction = i < path.length - 1
        ? new THREE.Vector3().subVectors(path[i + 1], path[i]).setY(0).normalize()
        : postureDirection;
      root.quaternion.setFromUnitVectors(forward, direction);
      if (bankDirection !== 0) root.rotateZ(bankDirection * THREE.MathUtils.degToRad(7 + i * 6));
      const ink = new THREE.MeshBasicMaterial({
        color: PALETTE.ink,
        transparent: true,
        opacity: 0.86,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const energy = new THREE.MeshBasicMaterial({
        color: PALETTE.sunFlare,
        transparent: true,
        opacity: 0.78,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const inkRing = new THREE.Mesh(inkGeometry, ink);
      inkRing.renderOrder = 7;
      const energyRing = new THREE.Mesh(energyGeometry, energy);
      energyRing.position.z = 0.035;
      energyRing.renderOrder = 8;
      energyRing.layers.enable(LAYER_ENERGY);
      root.add(inkRing, energyRing);
      let postureInk: THREE.MeshBasicMaterial | null = null;
      let postureFill: THREE.MeshBasicMaterial | null = null;
      if (turnDirection !== 'none' && i > 0) {
        postureInk = new THREE.MeshBasicMaterial({
          color: PALETTE.ink,
          transparent: true,
          opacity: 0.84,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        postureFill = new THREE.MeshBasicMaterial({
          color: PALETTE.foam,
          transparent: true,
          opacity: 0.9,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        // The diamond root follows local +Z and local +X is port/left.
        // Mirroring X therefore points right-turn posture toward starboard.
        const postureSign = turnDirection === 'left' ? 1 : -1;
        const postureInkMesh = new THREE.Mesh(postureGeometry, postureInk);
        postureInkMesh.name = `${def.id}-launch-posture-ink-${i}`;
        postureInkMesh.position.z = 0.055;
        postureInkMesh.scale.set(postureSign * 0.66, 0.66, 0.66);
        postureInkMesh.renderOrder = 9;
        const postureFillMesh = new THREE.Mesh(postureGeometry, postureFill);
        postureFillMesh.name = `${def.id}-launch-posture-${i}`;
        postureFillMesh.position.z = 0.075;
        postureFillMesh.scale.set(postureSign * 0.52, 0.52, 0.52);
        postureFillMesh.renderOrder = 10;
        postureFillMesh.layers.enable(LAYER_ENERGY);
        root.add(postureInkMesh, postureFillMesh);
      }
      root.position.set(path[i].x, clearances[i], path[i].z);
      group.add(root);
      diamonds.push({
        root,
        ink,
        energy,
        postureInk,
        postureFill,
        x: path[i].x,
        z: path[i].z,
        clearance: clearances[i],
        waveWeight: waveWeights[i],
      });
    }

    const packetMaterial = new THREE.MeshBasicMaterial({
      color: FLIGHT_ROUTE_MARKER_COLOR,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    // These are directional packets, not generic sparkles: their forward
    // motion makes the required launch posture legible before takeoff.
    const packetGeometry = makeOpenChevronGeometry(0);
    packetGeometry.rotateY(-Math.PI / 2);
    packetGeometry.scale(0.62, 0.62, 0.62);
    const packets: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const packet = new THREE.Mesh(packetGeometry, packetMaterial);
      packet.name = `${def.id}-launch-energy-packet-${i + 1}`;
      packet.renderOrder = 9;
      packet.layers.enable(LAYER_ENERGY);
      group.add(packet);
      packets.push(packet);
    }
    return { group, projectors, tornadoes, diamonds, packets, packetMaterial, deploy: 0 };
  }

  /** Wave-conforming translucent route plus sparse authored arrow geometry. */
  private buildRibbon(): SurfaceGuideBuild {
    const rows = RIBBON_SEGS + 1;
    const columns = SURFACE_GUIDE_CROSS_SEGS + 1;
    const pos = new Float32Array(rows * columns * 3);
    const uv = new Float32Array(rows * columns * 2);
    const idx = new Uint32Array(RIBBON_SEGS * SURFACE_GUIDE_CROSS_SEGS * 6);
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
      for (let j = 0; j < columns; j++) {
        const side = 1 - (j / SURFACE_GUIDE_CROSS_SEGS) * 2;
        const vertex = i * columns + j;
        pos[vertex * 3] = p.x + lx * RIBBON_HALF_W * side;
        pos[vertex * 3 + 1] = 0;
        pos[vertex * 3 + 2] = p.z + lz * RIBBON_HALF_W * side;
        uv[vertex * 2] = s;
        uv[vertex * 2 + 1] = side;
      }
    }
    for (let i = 0; i < RIBBON_SEGS; i++) {
      for (let j = 0; j < SURFACE_GUIDE_CROSS_SEGS; j++) {
        const a = i * columns + j;
        const b = a + 1;
        const c = (i + 1) * columns + j;
        const d = c + 1;
        const index = (i * SURFACE_GUIDE_CROSS_SEGS + j) * 6;
        // +Y winding lets the always-above-water guide render FrontSide only.
        idx[index] = a;
        idx[index + 1] = c;
        idx[index + 2] = b;
        idx[index + 3] = b;
        idx[index + 4] = c;
        idx[index + 5] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const uniforms = createSurfaceGuideUniforms();
    const mat = buildRibbonMaterial(uniforms);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'racing-line';
    mesh.frustumCulled = false; // spans the whole course
    mesh.renderOrder = 2; // over the water
    this.object.add(mesh);

    const arrowGeo = buildSurfaceChevronGeometry();
    const arrowStations = new THREE.InstancedBufferAttribute(new Float32Array(SURFACE_GUIDE_ARROW_COUNT), 1);
    const arrowTurns = new THREE.InstancedBufferAttribute(new Float32Array(SURFACE_GUIDE_ARROW_COUNT), 1);
    const arrowPhases = new THREE.InstancedBufferAttribute(new Float32Array(SURFACE_GUIDE_ARROW_COUNT), 1);
    arrowStations.setUsage(THREE.DynamicDrawUsage);
    arrowTurns.setUsage(THREE.DynamicDrawUsage);
    arrowPhases.setUsage(THREE.DynamicDrawUsage);
    arrowGeo.setAttribute('aStation', arrowStations);
    arrowGeo.setAttribute('aTurn', arrowTurns);
    arrowGeo.setAttribute('aPhase', arrowPhases);
    const arrowMat = buildSurfaceArrowMaterial(uniforms);
    const arrowInkMat = buildSurfaceArrowMaterial(uniforms, true);
    const arrows = new THREE.InstancedMesh(arrowGeo, arrowMat, SURFACE_GUIDE_ARROW_COUNT);
    arrows.name = 'surface-guide-chevrons';
    arrows.frustumCulled = false;
    arrows.renderOrder = 3;
    arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const arrowInk = new THREE.InstancedMesh(arrowGeo, arrowInkMat, SURFACE_GUIDE_ARROW_COUNT);
    arrowInk.name = 'surface-guide-chevron-ink';
    arrowInk.frustumCulled = false;
    arrowInk.renderOrder = 2;
    arrowInk.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < SURFACE_GUIDE_ARROW_COUNT; i++) {
      arrows.setMatrixAt(i, _hiddenRecoveryArrow);
      arrowInk.setMatrixAt(i, _hiddenRecoveryArrow);
    }
    arrows.instanceMatrix.needsUpdate = true;
    arrowInk.instanceMatrix.needsUpdate = true;
    this.object.add(arrowInk, arrows);
    return {
      ribbon: mat,
      arrows,
      arrowInk,
      arrowStations,
      arrowTurns,
      arrowPhases,
      arrowCount: SURFACE_GUIDE_ARROW_COUNT,
    };
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
    // START/FINISH uses pure geometry for its towers, panel and lettering.
    // This avoids a first-load mobile GPU race that could upload CanvasTexture
    // data as black until the page was refreshed.
    const startVisuals = makeStartGantryVisuals();
    const towerMat = startVisuals.towerMaterial;
    const towerBandMat = createToonMaterial({ color: PALETTE.ink });
    const towerAccentMat = createToonMaterial({
      color: PALETTE.uiAccent,
      emissive: PALETTE.uiAccent,
      emissiveIntensity: 0.28,
    });
    const towerCapMat = createToonMaterial({
      color: PALETTE.hullPlayer,
      emissive: PALETTE.hullPlayer,
      emissiveIntensity: 0.5,
    });
    // ~30% smaller float: the old disc was wider than the buoy above it is tall
    const floatGeo = new THREE.TorusGeometry(0.88, 0.3, 10, 20);
    floatGeo.rotateX(Math.PI / 2);
    const bodyGeo = new THREE.CylinderGeometry(0.75, 0.85, 1.9, 14);
    const coneGeo = new THREE.ConeGeometry(0.66, 0.85, 14); // short squat cap, not a spire
    const foamRingGeo = makeFoamRingGeometry();
    const towerGeo = new THREE.CylinderGeometry(0.72, 1.05, 10.0, 12);
    const towerRadiusAt = (y: number): number => THREE.MathUtils.lerp(1.05, 0.72, y / 10);
    const towerSection = (fromY: number, toY: number): THREE.BufferGeometry => {
      const geometry = new THREE.CylinderGeometry(
        towerRadiusAt(toY) + 0.035,
        towerRadiusAt(fromY) + 0.035,
        toY - fromY,
        12,
      );
      geometry.translate(0, (fromY + toY) * 0.5, 0);
      return geometry;
    };
    // Same proportions as the original texture: white / black / white /
    // black / green from the waterline to the cap, now expressed as geometry.
    const towerInkParts = [towerSection(1.875, 2.8125), towerSection(7.1875, 8.125)];
    const towerBandGeo = mergeGeometries(towerInkParts, false);
    towerInkParts.forEach((part) => part.dispose());
    if (!towerBandGeo) throw new Error('Unable to merge START tower bands');
    const towerAccentGeo = towerSection(8.125, 10);
    const towerCapGeo = new THREE.ConeGeometry(1.08, 1.5, 12);

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
    gantry.name = 'start-gantry';
    for (const side of [-1, 1]) {
      const tower = new THREE.Group();
      const shaft = new THREE.Mesh(towerGeo, towerMat);
      shaft.position.y = 5.0;
      const bands = new THREE.Mesh(towerBandGeo, towerBandMat);
      bands.name = 'start-tower-black-bands';
      bands.userData.noOutline = true;
      const collar = new THREE.Mesh(towerAccentGeo, towerAccentMat);
      collar.name = 'start-tower-accent-collar';
      collar.userData.noOutline = true;
      const cap = new THREE.Mesh(towerCapGeo, towerCapMat);
      cap.position.y = 10.6;
      tower.add(shaft, bands, collar, cap);
      tower.position.x = side * 8.5;
      gantry.add(tower);
    }
    // START faces the approaching pack. The reverse restores the full finish
    // checker instead of mirroring or duplicating the word.
    const bannerFront = startVisuals.bannerFront;
    bannerFront.rotation.y = Math.PI;
    bannerFront.position.set(0, 8.6, -0.06);
    const bannerBack = startVisuals.bannerBack;
    bannerBack.position.set(0, 8.6, 0.06);
    gantry.add(bannerFront, bannerBack);
    addOutline(gantry);
    markInk(gantry);
    gantry.position.set(p.x, 0, p.z);
    const yawQ = new THREE.Quaternion().setFromAxisAngle(UP, -heading);
    gantry.quaternion.copy(yawQ);
    this.object.add(gantry);
    this.startGantry = gantry;
    this.buildFinalStation(gantry);
    this.floaters.push({ obj: gantry, x: p.x, z: p.z, yawQ });
  }

  /** Gold energy columns that remain dormant until all seven routes are cleared. */
  private buildFinalStation(gantry: THREE.Group): void {
    const station = new THREE.Group();
    station.name = 'final-station';
    station.visible = false;
    const makeEnergyMaterial = (color: number, opacity: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const addEnergy = (mesh: THREE.Mesh, opacity: number): void => {
      mesh.userData.noOutline = true;
      mesh.userData.finalBaseOpacity = opacity;
      mesh.layers.enable(LAYER_ENERGY);
      station.add(mesh);
    };
    const coreGeo = new THREE.CylinderGeometry(0.32, 0.58, 11.5, 12, 1, true);
    const glowGeo = new THREE.CylinderGeometry(0.9, 1.22, 12.5, 12, 1, true);
    for (const side of [-1, 1]) {
      const glow = new THREE.Mesh(glowGeo, makeEnergyMaterial(PALETTE.sunFlare, 0.24));
      glow.position.set(side * 7.15, 6.1, 0);
      addEnergy(glow, 0.24);
      const core = new THREE.Mesh(coreGeo, makeEnergyMaterial(PALETTE.sunCore, 0.88));
      core.position.set(side * 7.15, 6, 0);
      addEnergy(core, 0.88);
      for (let i = 0; i < 8; i++) {
        const particle = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.14 + (i % 3) * 0.04, 0),
          makeEnergyMaterial(i % 2 ? PALETTE.sunCore : PALETTE.sunFlare, 0.72),
        );
        particle.position.x = side * (6.7 + (i % 4) * 0.28);
        particle.userData.finalParticle = i + (side > 0 ? 8 : 0);
        addEnergy(particle, 0.72);
      }
    }
    const crown = new THREE.Mesh(
      new THREE.TorusGeometry(5.8, 0.2, 8, 36),
      makeEnergyMaterial(PALETTE.sunCore, 0.72),
    );
    crown.position.y = 8.6;
    crown.scale.set(1.22, 0.66, 1);
    addEnergy(crown, 0.72);
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(13.8, 0.16, 0.2),
      makeEnergyMaterial(PALETTE.sunFlare, 0.62),
    );
    beam.position.y = 9.1;
    addEnergy(beam, 0.62);
    station.traverse((object) => object.layers.enable(LAYER_ENERGY));
    gantry.add(station);
    this.finalStation = station;
  }
}
