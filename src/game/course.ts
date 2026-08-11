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
 *   GRID_SLOTS    — 2x2 staggered start positions just behind the line
 */
import * as THREE from 'three';
import { markInk, LAYER_INK, type ICourse, type CourseSample } from '../contracts';
import { PALETTE } from '../core/palette';
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

// -------------------------------------------------------------- grid ----

/** 4 staggered start positions just behind the start line (2x2, ~7m spacing). */
export const GRID_SLOTS: { x: number; z: number; heading: number }[] = (() => {
  const slots: { x: number; z: number; heading: number }[] = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const behind = 9 + row * 7; // metres behind the line
      const lateral = col === 0 ? -3.5 : 3.5;
      const u = (1 - behind / LAP_LENGTH) % 1;
      const i = u * TABLE_N;
      const i0 = Math.floor(i) % TABLE_N;
      const i1 = (i0 + 1) % TABLE_N;
      const f = i - Math.floor(i);
      const px = TAB_X[i0] + (TAB_X[i1] - TAB_X[i0]) * f;
      const pz = TAB_Z[i0] + (TAB_Z[i1] - TAB_Z[i0]) * f;
      const tx = TAB_TX[i0] + (TAB_TX[i1] - TAB_TX[i0]) * f;
      const tz = TAB_TZ[i0] + (TAB_TZ[i1] - TAB_TZ[i0]) * f;
      // right normal of the tangent = (tz, -tx)
      slots.push({
        x: px + tz * lateral,
        z: pz - tx * lateral,
        heading: Math.atan2(-tx, tz),
      });
    }
  }
  return slots;
})();

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
      varying float vS;
      varying float vSide;
      varying float vDist;
      void main() {
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
        float fade = vDist < 220.0 ? 1.0 : (vDist < 600.0 ? 0.62 : 0.3);
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

  private readonly ribbonMat: THREE.ShaderMaterial;
  private readonly stripMat: THREE.ShaderMaterial;
  private readonly floaters: Floater[] = [];

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'course';
    this.ribbonMat = this.buildRibbon();
    this.stripMat = this.buildStartStrip();
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

  /**
   * Nearest-spline lookup: table coarse scan + parabolic refine, then one
   * projection step against the TRUE curve (the table's linear interpolation
   * cuts tight corners by up to ~1.4m). Zero allocation.
   */
  sample(pos: THREE.Vector3, out: CourseSample): CourseSample {
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
    return out;
  }

  update(_dt: number, t: number): void {
    this.ribbonMat.uniforms.uTime.value = t;
    this.stripMat.uniforms.uTime.value = t;
    for (const f of this.floaters) {
      f.obj.position.y = waterHeight(f.x, f.z, t);
      waterNormalInto(_n, f.x, f.z, t);
      _q.setFromUnitVectors(UP, _n).multiply(f.yawQ);
      f.obj.quaternion.copy(_q);
    }
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
        this.floaters.push({ obj: buoy, x, z, yawQ: new THREE.Quaternion() });
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
