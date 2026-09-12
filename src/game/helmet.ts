/**
 * helmet.ts — six closed racing helmets, rigidly hard-bound to the head bone.
 *
 * The portrait-era head (skin loft + portrait face patch + spring-boned hair,
 * including the Tide GLB head) is gone: identity now comes from six closed
 * helmet shells with a reflective visor. Each helmet is a plain rigid Mesh
 * subtree parented directly to the `head` Bone — no skinIndex/skinWeight, no
 * per-frame bone math, no spring updates. Silhouettes are deliberately
 * distinct at the back of the head and in side profile because the chase
 * camera watches the rider from behind:
 *
 *   axle  'round'     small round classic dome
 *   tide  'tailwing'  slim teardrop + twin rear gurney flaps
 *   sol   'brim'      off-road peak + rear ducktail
 *   reef  'angular'   chiseled blade ridge + brow/cheek armor
 *   kai   'aerotail'  long droplet dorsal tail
 *   jinx  'twinfin'   asymmetric side fins + slashed crown
 *
 * Paint is vertex-colored through shared channels (primary = saturated team
 * color, secondary = high-contrast foam white, ink/metal details) so one
 * material serves every shell; the visor shares a second material. Shell
 * lofts carry an unused normalized UV0 (u = ring angle, v = crown height)
 * reserved for a future decal atlas — paint channels map 1:1 onto it.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { createToonMaterial } from '../cel/toonMaterial';

export type HelmetStyle = 'round' | 'tailwing' | 'brim' | 'angular' | 'aerotail' | 'twinfin';

export interface HelmetLook {
  driverId: string;
}

export interface Helmet {
  object: THREE.Group;
  shell: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  visor: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  driverId: string;
  style: HelmetStyle;
  detailed: boolean;
}

const HELMET_STYLES: Record<string, HelmetStyle> = {
  axle: 'round',
  tide: 'tailwing',
  sol: 'brim',
  reef: 'angular',
  kai: 'aerotail',
  jinx: 'twinfin',
};

function helmetStyleFor(driverId: string): HelmetStyle {
  return HELMET_STYLES[driverId] ?? 'round';
}

// Paint channels. Vertex colors, not textures: one shared material per
// surface type across all six riders keeps the batch/atlas path open.
const enum Paint {
  Primary,     // saturated team color
  Secondary,   // high-contrast foam white
  Ink,         // dark navy panel lines
  Metal,       // brushed fittings
}

const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler();

function transform(
  position: readonly [number, number, number] = [0, 0, 0],
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
): THREE.Matrix4 {
  _euler.set(rotation[0], rotation[1], rotation[2]);
  _quaternion.setFromEuler(_euler);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(position[0], position[1], position[2]),
    _quaternion.clone(),
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
}

const _local = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();

/** Rigid counterpart of the body assembler: positions baked in head-bone space, no skin attributes. */
class HelmetAssembler {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];

  constructor(
    private readonly paint: (channel: Paint, point: THREE.Vector3) => THREE.Color,
    private readonly uvOf: (point: THREE.Vector3) => readonly [number, number],
  ) {}

  append(
    geometry: THREE.BufferGeometry,
    localMatrix: THREE.Matrix4,
    channel: Paint | ((point: THREE.Vector3) => Paint),
  ): void {
    const source = geometry.index === null ? geometry.clone() : geometry.toNonIndexed();
    if (source.getAttribute('normal') === undefined) source.computeVertexNormals();
    const pos = source.getAttribute('position');
    const normal = source.getAttribute('normal');
    _normalMatrix.getNormalMatrix(localMatrix);

    for (let i = 0; i < pos.count; i++) {
      _local.fromBufferAttribute(pos, i).applyMatrix4(localMatrix);
      _normal.fromBufferAttribute(normal, i).applyMatrix3(_normalMatrix).normalize();
      this.positions.push(_local.x, _local.y, _local.z);
      this.normals.push(_normal.x, _normal.y, _normal.z);
      const picked = typeof channel === 'function' ? channel(_local) : channel;
      const color = this.paint(picked, _local);
      this.colors.push(color.r, color.g, color.b);
      const uv = this.uvOf(_local);
      this.uvs.push(uv[0], uv[1]);
    }
    const base = this.positions.length / 3 - pos.count;
    for (let i = 0; i < pos.count; i++) this.indices.push(base + i);
    source.dispose();
    geometry.dispose();
  }

  finish(name: string): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    geometry.name = name;
    return geometry;
  }
}

interface LoftRing {
  y: number;
  z: number;
  hw: number;
  hd: number;
}

/**
 * Closed loft with normalized UV0 (u = angle around the crown, v = height).
 * The back of the head (−Z, theta ≈ PI) carries u ≈ 0.5 — the future atlas
 * slot for the rear graphic that identifies a rider in the chase view.
 */
function helmetLoft(rings: readonly LoftRing[], sides: number, yMin: number, yMax: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring < rings.length; ring++) {
    const { y, z, hw, hd } = rings[ring];
    const v = (y - yMin) / Math.max(1e-6, yMax - yMin);
    for (let side = 0; side <= sides; side++) {
      const theta = (side / sides) * Math.PI * 2;
      positions.push(Math.sin(theta) * hw, y, z + Math.cos(theta) * hd);
      uvs.push(side / sides, v);
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let side = 0; side < sides; side++) {
      const a = ring * (sides + 1) + side;
      const b = a + 1;
      const c = a + sides + 1;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  // Crown cap fan + rim cap fan.
  const top = rings[rings.length - 1];
  const topCenter = positions.length / 3;
  positions.push(0, top.y + (yMax - top.y) * 0.6, top.z);
  uvs.push(0.5, 1);
  const topBase = (rings.length - 1) * (sides + 1);
  for (let side = 0; side < sides; side++) indices.push(topCenter, topBase + side, topBase + side + 1);
  const bottom = rings[0];
  const bottomCenter = positions.length / 3;
  positions.push(0, bottom.y - 0.004, bottom.z);
  uvs.push(0.5, 0);
  for (let side = 0; side < sides; side++) indices.push(bottomCenter, side + 1, side);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Partial-height arc band loft (the visor): sweeps theta across the face
 * front only, with vertical end caps so the band never shows a see-through
 * edge at grazing angles. Geometry is exact-conformance by construction —
 * see buildHelmetGeometry's inflated ring set.
 */
function arcBandLoft(rings: readonly LoftRing[], sides: number, span: number, yMin: number, yMax: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring < rings.length; ring++) {
    const { y, z, hw, hd } = rings[ring];
    const v = (y - yMin) / Math.max(1e-6, yMax - yMin);
    for (let side = 0; side <= sides; side++) {
      const theta = -span * 0.5 + (span * side) / sides;
      positions.push(Math.sin(theta) * hw, y, z + Math.cos(theta) * hd);
      uvs.push(side / sides, v);
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let side = 0; side < sides; side++) {
      const a = ring * (sides + 1) + side;
      const b = a + 1;
      const c = a + sides + 1;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  // Vertical end caps closing the band's thickness at each temple edge.
  for (const end of [0, sides]) {
    const center = positions.length / 3;
    let cy = 0;
    let cz = 0;
    for (let ring = 0; ring < rings.length; ring++) {
      cy += positions[(ring * (sides + 1) + end) * 3 + 1];
      cz += positions[(ring * (sides + 1) + end) * 3 + 2];
    }
    positions.push(0, cy / rings.length, cz / rings.length);
    uvs.push(end === 0 ? 0 : 1, 0.5);
    for (let ring = 0; ring < rings.length - 1; ring++) {
      const a = ring * (sides + 1) + end;
      const b = (ring + 1) * (sides + 1) + end;
      if (end === 0) indices.push(center, b, a);
      else indices.push(center, a, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A hard-surface tapered plate (local copy: riderMesh's helper is module-private). */
function plateGeometry(bottomWidth: number, topWidth: number, height: number, depth: number): THREE.BufferGeometry {
  const by = -height * 0.5;
  const ty = height * 0.5;
  const bd = depth * 0.5;
  const vertices = [
    -bottomWidth * 0.5, by, -bd, bottomWidth * 0.5, by, -bd,
    -topWidth * 0.5, ty, -bd, topWidth * 0.5, ty, -bd,
    -bottomWidth * 0.5, by, bd, bottomWidth * 0.5, by, bd,
    -topWidth * 0.5, ty, bd, topWidth * 0.5, ty, bd,
  ];
  const faces = [
    0, 2, 1, 1, 2, 3,
    4, 5, 6, 5, 7, 6,
    0, 4, 2, 2, 4, 6,
    1, 3, 5, 3, 7, 5,
    2, 6, 3, 3, 6, 7,
    0, 1, 4, 1, 5, 4,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(faces);
  geometry.computeVertexNormals();
  return geometry;
}

// ---------------------------------------------------------------- paint ----

function paintColor(channel: Paint, team: THREE.Color): THREE.Color {
  switch (channel) {
    case Paint.Primary: return team;
    case Paint.Secondary: return new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace);
    case Paint.Ink: return new THREE.Color().setHex(PALETTE.ink, THREE.NoColorSpace);
    case Paint.Metal: return new THREE.Color().setHex(0x8b98ad, THREE.NoColorSpace);
  }
}

/** UV fallback for appended plates: planar map over the helmet silhouette. */
function uvOfPoint(point: THREE.Vector3): readonly [number, number] {
  const u = 0.5 + Math.atan2(point.x, point.z) / (Math.PI * 2);
  return [u - Math.floor(u), THREE.MathUtils.clamp((point.y + 0.04) / 0.34, 0, 1)];
}

// ------------------------------------------------------------- material ----
// One shared shell material + one shared visor material for the whole grid:
// paint varies through vertex colors, so all six shells stay batch-compatible.

let shellMaterial: THREE.ShaderMaterial | null = null;
function getShellMaterial(): THREE.ShaderMaterial {
  if (shellMaterial) return shellMaterial;
  shellMaterial = createToonMaterial({
    color: 0xffffff,
    vertexColors: true,
    rimColor: PALETTE.sparkle,
    rimStrength: 0.85,
    rimPower: 2.1,
    rimThreshold: 0.5,
    specColor: PALETTE.sparkle,
    specThreshold: 0.8,
  });
  shellMaterial.name = 'RiderHelmetToon';
  shellMaterial.uniforms.uShadowFloor.value.setHex(0x3a3560, THREE.NoColorSpace);
  return shellMaterial;
}

let visorMaterial: THREE.ShaderMaterial | null = null;
function getVisorMaterial(): THREE.ShaderMaterial {
  if (visorMaterial) return visorMaterial;
  visorMaterial = createToonMaterial({
    color: 0xffffff,
    vertexColors: true,
    rimColor: 0x9fdcff,
    rimStrength: 1.6,
    rimPower: 1.6,
    rimThreshold: 0.34,
    specColor: 0xffffff,
    specThreshold: 0.42,
  });
  visorMaterial.name = 'RiderHelmetVisorToon';
  // Smoked lens: the broad low-threshold Blinn band reads as a mirror streak.
  visorMaterial.uniforms.uShadowFloor.value.setHex(0x232c4e, THREE.NoColorSpace);
  return visorMaterial;
}

/** Dark smoked base the visor tint multiplies; per-driver hue via vertex color. */
const VISOR_TINTS: Record<string, number> = {
  axle: 0x8fb7d8,
  tide: 0x6fe3f2,
  sol: 0xffd98a,
  reef: 0xff9a86,
  kai: 0x8fffc2,
  jinx: 0xc9a6ff,
};

// ---------------------------------------------------------- shell specs ----

interface HelmetSpec {
  rings: LoftRing[];
  apex: number; // crown cap height
}

const RIM_Y = -0.034;

const HELMET_SPECS: Record<HelmetStyle, HelmetSpec> = {
  // Small round classic: generous dome, no hard edges.
  round: {
    apex: 0.288,
    rings: [
      { y: RIM_Y, z: -0.004, hw: 0.112, hd: 0.12 },
      { y: 0.03, z: -0.002, hw: 0.13, hd: 0.136 },
      { y: 0.1, z: -0.004, hw: 0.136, hd: 0.138 },
      { y: 0.17, z: -0.01, hw: 0.118, hd: 0.12 },
      { y: 0.225, z: -0.018, hw: 0.076, hd: 0.082 },
      { y: 0.26, z: -0.022, hw: 0.034, hd: 0.04 },
    ],
  },
  // Slim teardrop: pulled-in cheeks, nape pushed back for the gurney flaps.
  tailwing: {
    apex: 0.274,
    rings: [
      { y: RIM_Y, z: -0.018, hw: 0.108, hd: 0.124 },
      { y: 0.03, z: -0.014, hw: 0.124, hd: 0.132 },
      { y: 0.1, z: -0.012, hw: 0.13, hd: 0.128 },
      { y: 0.17, z: -0.024, hw: 0.11, hd: 0.106 },
      { y: 0.225, z: -0.036, hw: 0.068, hd: 0.066 },
      { y: 0.256, z: -0.042, hw: 0.03, hd: 0.032 },
    ],
  },
  // Off-road: taller crown, nape kicked up for the ducktail.
  brim: {
    apex: 0.302,
    rings: [
      { y: RIM_Y, z: -0.006, hw: 0.114, hd: 0.122 },
      { y: 0.03, z: -0.004, hw: 0.132, hd: 0.136 },
      { y: 0.1, z: -0.006, hw: 0.138, hd: 0.136 },
      { y: 0.17, z: -0.016, hw: 0.122, hd: 0.114 },
      { y: 0.23, z: -0.026, hw: 0.086, hd: 0.08 },
      { y: 0.268, z: -0.032, hw: 0.042, hd: 0.042 },
    ],
  },
  // Chiseled: flatter sides, squarer crown; armor blades sell the facets.
  angular: {
    apex: 0.28,
    rings: [
      { y: RIM_Y, z: -0.004, hw: 0.118, hd: 0.118 },
      { y: 0.03, z: -0.004, hw: 0.134, hd: 0.128 },
      { y: 0.1, z: -0.008, hw: 0.132, hd: 0.124 },
      { y: 0.17, z: -0.018, hw: 0.112, hd: 0.104 },
      { y: 0.225, z: -0.026, hw: 0.07, hd: 0.066 },
      { y: 0.258, z: -0.03, hw: 0.032, hd: 0.032 },
    ],
  },
  // Long droplet dorsal tail: crown runs straight back into a low tail cone.
  aerotail: {
    apex: 0.262,
    rings: [
      { y: RIM_Y, z: -0.008, hw: 0.11, hd: 0.12 },
      { y: 0.03, z: -0.008, hw: 0.126, hd: 0.132 },
      { y: 0.1, z: -0.014, hw: 0.13, hd: 0.126 },
      { y: 0.17, z: -0.032, hw: 0.106, hd: 0.096 },
      { y: 0.22, z: -0.058, hw: 0.064, hd: 0.056 },
      { y: 0.244, z: -0.082, hw: 0.03, hd: 0.026 },
    ],
  },
  // Slash-cut crown, asymmetric fins added as plates below.
  twinfin: {
    apex: 0.284,
    rings: [
      { y: RIM_Y, z: -0.004, hw: 0.114, hd: 0.12 },
      { y: 0.03, z: -0.002, hw: 0.13, hd: 0.134 },
      { y: 0.1, z: -0.006, hw: 0.136, hd: 0.132 },
      { y: 0.17, z: -0.014, hw: 0.116, hd: 0.112 },
      { y: 0.225, z: -0.022, hw: 0.072, hd: 0.072 },
      { y: 0.258, z: -0.026, hw: 0.034, hd: 0.036 },
    ],
  },
};

// -------------------------------------------------------------- geometry ----

const geometryCache = new Map<string, { shell: THREE.BufferGeometry; visor: THREE.BufferGeometry }>();

function buildHelmetGeometry(style: HelmetStyle, driverId: string, color: number, detailed: boolean): { shell: THREE.BufferGeometry; visor: THREE.BufferGeometry } {
  const key = `${style}|${driverId}|${color.toString(16)}|${detailed ? 'hi' : 'lo'}`;
  const cached = geometryCache.get(key);
  if (cached) return cached;

  const spec = HELMET_SPECS[style];
  const sides = detailed ? 14 : 10;
  const team = new THREE.Color().setHex(color, THREE.NoColorSpace);
  const out = new HelmetAssembler((channel) => paintColor(channel, team), uvOfPoint);

  // Shell base + high-contrast graphics on the BACK and SIDES: the chase
  // camera watches the rider from behind, so the identity stripe runs down
  // the nape (theta ≈ ±PI) with twin side stripes at the temples — not a
  // face-only decal.
  out.append(helmetLoft(spec.rings, sides, RIM_Y, spec.apex), new THREE.Matrix4(), (point) => {
    const theta = Math.abs(Math.atan2(point.x, point.z)); // 0 = face, PI = nape
    const rear = Math.PI - theta;
    const side = Math.abs(theta - Math.PI * 0.5);
    if (point.y < -0.012) return Paint.Ink;                        // rim band
    if (point.y > 0.235) return Paint.Secondary;                    // crown tip
    if (rear < 0.34 && point.y > 0.02) return Paint.Secondary;      // rear spine stripe
    if (side < 0.3 && point.y > 0.0 && point.y < 0.19) return Paint.Secondary; // temple stripes
    return Paint.Primary;
  });

  const plate = (
    channel: Paint,
    position: readonly [number, number, number],
    size: readonly [number, number, number, number],
    rotation: readonly [number, number, number] = [0, 0, 0],
  ) => out.append(plateGeometry(size[0], size[1], size[2], size[3]), transform(position, rotation), channel);

  // Per-style rigid attachments. All silhouette work happens here — the loft
  // stays cheap and shared in spirit, the plates carry the identity.
  switch (style) {
    case 'round':
      // Minimal classic: small round intake dot on the crown.
      out.append(
        new THREE.SphereGeometry(1, detailed ? 10 : 8, detailed ? 7 : 5),
        transform([0, spec.apex + 0.004, -0.024], [0, 0, 0], [0.02, 0.012, 0.02]),
        Paint.Metal,
      );
      break;
    case 'tailwing': {
      // Twin gurney flaps straddling the nape + dark nape panel.
      plate(Paint.Secondary, [0.056, 0.115, -0.15], [0.052, 0.078, 0.11, 0.02], [-0.3, 0.14, 0.1]);
      plate(Paint.Secondary, [-0.056, 0.115, -0.15], [0.052, 0.078, 0.11, 0.02], [-0.3, -0.14, -0.1]);
      plate(Paint.Ink, [0, 0.05, -0.152], [0.1, 0.12, 0.05, 0.018], [-0.24, 0, 0]);
      break;
    }
    case 'brim': {
      // Off-road peak riding above the visor brow + rear ducktail.
      plate(Paint.Secondary, [0, 0.138, 0.152], [0.22, 0.15, 0.024, 0.12], [0.2, 0, 0]);
      plate(Paint.Ink, [0, 0.124, 0.138], [0.18, 0.13, 0.012, 0.09], [0.2, 0, 0]);
      plate(Paint.Secondary, [0, 0.09, -0.142], [0.16, 0.1, 0.05, 0.1], [-0.34, 0, 0]);
      break;
    }
    case 'angular': {
      // Chiseled tech: crown blade ridge, ink nape panel and a pair of
      // swept-back temple blades — edges live on the back half, the face
      // stays one clean visor.
      plate(Paint.Secondary, [0, 0.268, -0.02], [0.042, 0.026, 0.1, 0.11], [-0.1, 0, 0]);
      plate(Paint.Ink, [0, 0.1, -0.15], [0.12, 0.09, 0.07, 0.02], [-0.2, 0, 0]);
      plate(Paint.Metal, [0.118, 0.15, -0.055], [0.032, 0.02, 0.09, 0.045], [0.06, 0.5, -0.12]);
      plate(Paint.Metal, [-0.118, 0.15, -0.055], [0.032, 0.02, 0.09, 0.045], [0.06, -0.5, 0.12]);
      break;
    }
    case 'aerotail': {
      // Dorsal spine fin continuing the droplet.
      plate(Paint.Secondary, [0, 0.2, -0.1], [0.046, 0.02, 0.1, 0.15], [-0.42, 0, 0]);
      plate(Paint.Ink, [0, 0.15, -0.118], [0.026, 0.014, 0.08, 0.12], [-0.4, 0, 0]);
      break;
    }
    case 'twinfin': {
      // Asymmetric fins: tall right, short left — the messy gambler signature.
      plate(Paint.Secondary, [0.128, 0.128, -0.048], [0.05, 0.022, 0.15, 0.075], [-0.12, 0.1, -0.3]);
      plate(Paint.Secondary, [-0.12, 0.108, -0.04], [0.04, 0.018, 0.09, 0.06], [-0.1, -0.08, 0.34]);
      plate(Paint.Ink, [0.01, 0.262, -0.015], [0.055, 0.03, 0.03, 0.07], [-0.08, 0, -0.22]);
      break;
    }
  }

  const shell = out.finish(`helmet-shell-${style}`);

  // Reflective visor: the shell's own front slice rebuilt as a parallel
  // surface — boundary rings are interpolated at the band's exact heights
  // (the shell between rings is a ruled surface) and every cross-section is
  // uniformly inflated about its centerline. Conformance is exact by
  // construction: the band can never sink behind a facet or lift off the
  // shell, at any angle.
  const tint = new THREE.Color(VISOR_TINTS[driverId] ?? 0x8fb7d8).multiplyScalar(0.32);
  const dark = new THREE.Color().setHex(0x10131f, THREE.NoColorSpace);
  const profileAtY = (y: number): LoftRing => {
    let a = spec.rings[0];
    let b = spec.rings[spec.rings.length - 1];
    for (let i = 0; i < spec.rings.length - 1; i++) {
      if (y >= spec.rings[i].y && y <= spec.rings[i + 1].y) {
        a = spec.rings[i];
        b = spec.rings[i + 1];
        break;
      }
    }
    if (y <= a.y) return a;
    if (y >= b.y) return b;
    const t = (y - a.y) / Math.max(1e-6, b.y - a.y);
    return {
      y,
      z: a.z + (b.z - a.z) * t,
      hw: a.hw + (b.hw - a.hw) * t,
      hd: a.hd + (b.hd - a.hd) * t,
    };
  };
  const VISOR_Y0 = 0.0;
  const VISOR_Y1 = 0.118;
  const INFLATE = 1.05;
  const visorRings: LoftRing[] = [profileAtY(VISOR_Y0)];
  for (const ring of spec.rings) {
    if (ring.y > VISOR_Y0 && ring.y < VISOR_Y1) visorRings.push({ ...ring });
  }
  visorRings.push(profileAtY(VISOR_Y1));
  const inflated: LoftRing[] = visorRings.map((ring) => ({
    y: ring.y,
    z: ring.z,
    hw: ring.hw * INFLATE,
    hd: ring.hd * INFLATE,
  }));
  const visorSides = sides % 2 === 0 ? sides : sides + 1;
  const visorOut = new HelmetAssembler((_, point) => {
    const t = THREE.MathUtils.clamp((point.y - VISOR_Y0) / (VISOR_Y1 - VISOR_Y0), 0, 1);
    return dark.clone().lerp(tint, 0.12 + 0.88 * t);
  }, uvOfPoint);
  visorOut.append(arcBandLoft(inflated, visorSides, 1.5, VISOR_Y0, VISOR_Y1), new THREE.Matrix4(), Paint.Primary);
  const visor = visorOut.finish(`helmet-visor-${style}`);
  // Smooth geometric normals let the toon bands wrap the band exactly like
  // the shell it parallels; the glass-frame ink border comes from the shared
  // outline hull (addOutline in rider.ts), which sits safely outside this
  // uniformly-inflated surface.

  const built = { shell, visor };
  geometryCache.set(key, built);
  return built;
}

// --------------------------------------------------------------- builder ----

export function buildHelmet(
  head: THREE.Bone,
  look: HelmetLook,
  color: number,
  detailed: boolean,
): Helmet {
  const style = helmetStyleFor(look.driverId);
  // Team color bakes into the cached geometry's vertex colors at build time;
  // each (driver, color, detail) combination caches its own shell, and all
  // shells share the two module materials.
  const { shell, visor } = buildHelmetGeometry(style, look.driverId, color, detailed);

  const object = new THREE.Group();
  object.name = `rider-helmet-${look.driverId}`;
  head.add(object);

  const shellMesh = new THREE.Mesh(shell, getShellMaterial());
  shellMesh.name = 'rider-helmet-shell';
  shellMesh.userData.assetClass = 'rigid-helmet-shell';
  // No interior Sobel ink on the helmet: the shell + its attachment plates
  // carry many hard folds that the near-field edge pass turns into line
  // noise exactly where the chase camera sits (full strength ≤9m, gone by
  // 26m) — which is why far riders read clean while the player's own helmet
  // scribbles. The helmet owns its contours through the inverted-hull
  // outline alone, the same look far riders already have.
  shellMesh.userData.noInk = true;
  shellMesh.frustumCulled = false;
  object.add(shellMesh);

  const visorMesh = new THREE.Mesh(visor, getVisorMaterial());
  visorMesh.name = 'rider-helmet-visor';
  visorMesh.userData.assetClass = 'rigid-helmet-visor';
  // Surface detail, not flat-ink silhouette (same contract the old Face
  // Patch used); the glass frame is drawn by the shared outline hull.
  visorMesh.userData.noInk = true;
  visorMesh.frustumCulled = false;
  object.add(visorMesh);

  return { object, shell: shellMesh, visor: visorMesh, driverId: look.driverId, style, detailed };
}

/**
 * Remove the helmet subtree. Geometries and materials stay: they are shared
 * across the grid (and across driver re-selection) through the module cache.
 */
export function disposeHelmet(helmet: Helmet): void {
  helmet.object.removeFromParent();
}

/** Harness/debug snapshot: rigidity proof + per-style identity evidence. */
export function helmetDebugInfo(helmet: Helmet | null): {
  driverId: string;
  style: string;
  rigid: boolean;
  shellVertices: number;
  visorVertices: number;
  shellId: string;
  visible: boolean;
} {
  if (!helmet) {
    return { driverId: '', style: '', rigid: false, shellVertices: 0, visorVertices: 0, shellId: '', visible: false };
  }
  const skinned = (helmet.shell as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
  return {
    driverId: helmet.driverId,
    style: helmet.style,
    rigid: !skinned && helmet.shell.parent === helmet.object && helmet.object.parent?.type === 'Bone',
    shellVertices: helmet.shell.geometry.getAttribute('position').count,
    visorVertices: helmet.visor.geometry.getAttribute('position').count,
    shellId: helmet.shell.geometry.uuid,
    visible: helmet.shell.visible && helmet.object.visible,
  };
}
