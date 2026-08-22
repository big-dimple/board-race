/**
 * One-batch procedural rider skin.
 *
 * The animation rig remains code-driven in rider.ts. This module turns that
 * rig into one SkinnedMesh with a small authored palette, so body, hair,
 * face, gloves and boots move as one character instead of separate meshes.
 * Identity is portrait-locked: bare head, per-driver hair color/style and
 * skin, white racing suit with team-color gloves and piping.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { createToonMaterial } from '../cel/toonMaterial';

export interface RiderLook {
  hair: number;
  skin: number;
  hairStyle: 'short' | 'bob' | 'ponytail';
}

export interface RiderBones {
  hips: THREE.Bone;
  spine: THREE.Bone;
  chest: THREE.Bone;
  head: THREE.Bone;
  shoulderL: THREE.Bone;
  shoulderR: THREE.Bone;
  elbowL: THREE.Bone;
  elbowR: THREE.Bone;
  handL: THREE.Bone;
  handR: THREE.Bone;
  hipL: THREE.Bone;
  hipR: THREE.Bone;
  kneeL: THREE.Bone;
  kneeR: THREE.Bone;
  footL: THREE.Bone;
  footR: THREE.Bone;
}

export interface RiderSkin {
  mesh: THREE.SkinnedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  roles: Uint8Array;
  colorAttribute: THREE.BufferAttribute;
}

const enum Role {
  Suit,
  SuitDark,
  SuitLight,
  Ink,
  Foam,
  Accent,
  Skin,
  Hair,
  Metal,
}

type Weight = readonly [bone: THREE.Bone, weight: number];
type WeightFn = (pointInBoneSpace: THREE.Vector3) => readonly Weight[];
type RoleFn = (pointInBoneSpace: THREE.Vector3) => Role;

const _up = new THREE.Vector3(0, 1, 0);
const _position = new THREE.Vector3();
const _localPosition = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _matrix = new THREE.Matrix4();
const _boneMatrix = new THREE.Matrix4();
const _rootInverse = new THREE.Matrix4();
const _normalMatrix = new THREE.Matrix3();

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function transform(
  position: readonly [number, number, number] = [0, 0, 0],
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
): THREE.Matrix4 {
  _quaternion.setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2]));
  return new THREE.Matrix4().compose(
    new THREE.Vector3(position[0], position[1], position[2]),
    _quaternion.clone(),
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
}

interface LoftRing {
  y: number;
  z: number;
  halfWidth: number;
  halfDepth: number;
}

function bodyLoft(rings: readonly LoftRing[], sides: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const ring of rings) {
    for (let side = 0; side < sides; side++) {
      const angle = side / sides * Math.PI * 2;
      positions.push(
        Math.cos(angle) * ring.halfWidth,
        ring.y,
        ring.z + Math.sin(angle) * ring.halfDepth,
      );
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    const nextRing = ring + 1;
    for (let side = 0; side < sides; side++) {
      const nextSide = (side + 1) % sides;
      const a = ring * sides + side;
      const b = ring * sides + nextSide;
      const c = nextRing * sides + nextSide;
      const d = nextRing * sides + side;
      indices.push(a, d, b, b, d, c);
    }
  }
  const bottomCenter = positions.length / 3;
  positions.push(0, rings[0].y, rings[0].z);
  const topCenter = positions.length / 3;
  const top = rings[rings.length - 1];
  positions.push(0, top.y, top.z);
  for (let side = 0; side < sides; side++) {
    const nextSide = (side + 1) % sides;
    indices.push(bottomCenter, nextSide, side);
    const topOffset = (rings.length - 1) * sides;
    indices.push(topCenter, topOffset + side, topOffset + nextSide);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A hard-surface tapered plate, centered on its height axis. */
function armorPlate(bottomWidth: number, topWidth: number, height: number, depth: number): THREE.BufferGeometry {
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

class SkinAssembler {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];
  private readonly weights: number[] = [];
  private readonly roleList: number[] = [];
  private readonly boneIndex = new Map<THREE.Bone, number>();

  constructor(
    private readonly root: THREE.Object3D,
    readonly bones: readonly THREE.Bone[],
    private color: number,
    private readonly look: RiderLook,
  ) {
    bones.forEach((bone, index) => this.boneIndex.set(bone, index));
    root.updateMatrixWorld(true);
    _rootInverse.copy(root.matrixWorld).invert();
  }

  append(
    geometry: THREE.BufferGeometry,
    bone: THREE.Bone,
    role: Role | RoleFn,
    localMatrix = new THREE.Matrix4(),
    weightFn?: WeightFn,
  ): void {
    const source = geometry.index === null ? geometry.clone() : geometry.toNonIndexed();
    if (source.getAttribute('normal') === undefined) source.computeVertexNormals();
    const pos = source.getAttribute('position');
    const normal = source.getAttribute('normal');
    _boneMatrix.multiplyMatrices(_rootInverse, bone.matrixWorld);
    _matrix.multiplyMatrices(_boneMatrix, localMatrix);
    _normalMatrix.getNormalMatrix(_matrix);

    for (let i = 0; i < pos.count; i++) {
      _localPosition.fromBufferAttribute(pos, i).applyMatrix4(localMatrix);
      _position.copy(_localPosition).applyMatrix4(_boneMatrix);
      _normal.fromBufferAttribute(normal, i).applyMatrix3(_normalMatrix).normalize();
      this.positions.push(_position.x, _position.y, _position.z);
      this.normals.push(_normal.x, _normal.y, _normal.z);

      const vertexRole = typeof role === 'function' ? role(_localPosition) : role;
      this.roleList.push(vertexRole);
      const vertexColor = roleColor(vertexRole, this.color, this.look);
      this.colors.push(vertexColor.r, vertexColor.g, vertexColor.b);

      const vertexWeights = weightFn?.(_localPosition) ?? [[bone, 1]];
      let total = 0;
      for (const entry of vertexWeights) total += entry[1];
      for (let slot = 0; slot < 4; slot++) {
        const entry = vertexWeights[slot];
        this.indices.push(entry === undefined ? 0 : (this.boneIndex.get(entry[0]) ?? 0));
        this.weights.push(entry === undefined || total <= 0 ? 0 : entry[1] / total);
      }
    }
    source.dispose();
    geometry.dispose();
  }

  finish(): { geometry: THREE.BufferGeometry; roles: Uint8Array; colorAttribute: THREE.BufferAttribute } {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    const colorAttribute = new THREE.Float32BufferAttribute(this.colors, 3);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', colorAttribute);
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.indices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.weights, 4));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { geometry, roles: Uint8Array.from(this.roleList), colorAttribute };
  }
}

function roleColor(role: Role, baseHex: number, look: RiderLook): THREE.Color {
  const base = new THREE.Color().setHex(baseHex, THREE.NoColorSpace);
  const foam = new THREE.Color().setHex(PALETTE.foam, THREE.NoColorSpace);
  switch (role) {
    // Portrait-matched racing suit: near-white body with a faint team tint,
    // dark navy side panels, saturated team color reserved for gloves and
    // piping — never a head-to-toe single-color onesie.
    case Role.Suit: return base.clone().lerp(foam, 0.84);
    case Role.SuitDark: return new THREE.Color(0x232a44).lerp(base.clone().multiplyScalar(0.4), 0.25);
    case Role.SuitLight: return base.clone().lerp(foam, 0.55);
    case Role.Ink: return new THREE.Color().setHex(PALETTE.ink, THREE.NoColorSpace);
    case Role.Foam: return foam;
    case Role.Accent: return base.clone().lerp(new THREE.Color().setHex(PALETTE.sparkle, THREE.NoColorSpace), 0.22);
    case Role.Skin: return new THREE.Color().setHex(look.skin, THREE.NoColorSpace);
    case Role.Hair: return new THREE.Color().setHex(look.hair, THREE.NoColorSpace);
    case Role.Metal: return new THREE.Color().setHex(0x66758c, THREE.NoColorSpace);
  }
}

function appendEllipsoid(
  out: SkinAssembler,
  bone: THREE.Bone,
  role: Role,
  position: readonly [number, number, number],
  scale: readonly [number, number, number],
  sides: number,
): void {
  out.append(
    new THREE.SphereGeometry(1, sides, Math.max(6, Math.floor(sides * 0.72))),
    bone,
    role,
    transform(position, [0, 0, 0], scale),
  );
}

function appendSegment(
  out: SkinAssembler,
  from: THREE.Bone,
  to: THREE.Bone,
  startRadius: number,
  endRadius: number,
  role: Role,
  sides: number,
): void {
  const dir = to.position.clone();
  const length = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(_up, dir.clone().normalize());
  const localMatrix = new THREE.Matrix4().compose(
    dir.clone().multiplyScalar(0.5),
    q,
    new THREE.Vector3(1, 1, 1),
  );
  const invLengthSq = 1 / Math.max(1e-6, length * length);
  out.append(
    new THREE.CylinderGeometry(endRadius, startRadius, length, sides, 3, false),
    from,
    role,
    localMatrix,
    (point) => {
      const along = THREE.MathUtils.clamp(point.dot(dir) * invLengthSq, 0, 1);
      const childWeight = smoothstep(0.48, 0.92, along);
      return [[from, 1 - childWeight], [to, childWeight]];
    },
  );
}

/**
 * One continuous limb: gentle muscle swell at ~1/3, no contrasting joint
 * balls. The robot read of the old build came from dark elbow/knee spheres
 * interrupting the sleeve — joints now share the garment color and only
 * swell the silhouette.
 */
function appendLimb(
  out: SkinAssembler,
  from: THREE.Bone,
  to: THREE.Bone,
  r0: number,
  rMid: number,
  r1: number,
  role: Role,
  sides: number,
): void {
  const dir = to.position.clone();
  const length = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(_up, dir.clone().normalize());
  const localMatrix = new THREE.Matrix4().compose(new THREE.Vector3(), q, new THREE.Vector3(1, 1, 1));
  const invLengthSq = 1 / Math.max(1e-6, length * length);
  out.append(
    bodyLoft([
      { y: 0, z: 0, halfWidth: r0, halfDepth: r0 * 0.92 },
      { y: length * 0.36, z: 0, halfWidth: rMid, halfDepth: rMid * 0.92 },
      { y: length * 0.78, z: 0, halfWidth: (rMid + r1) * 0.52, halfDepth: (rMid + r1) * 0.48 },
      { y: length, z: 0, halfWidth: r1, halfDepth: r1 * 0.92 },
    ], sides),
    from,
    role,
    localMatrix,
    (point) => {
      const along = THREE.MathUtils.clamp(point.dot(dir) * invLengthSq, 0, 1);
      const childWeight = smoothstep(0.42, 0.9, along);
      return [[from, 1 - childWeight], [to, childWeight]];
    },
  );
}

function appendPanel(
  out: SkinAssembler,
  bone: THREE.Bone,
  role: Role,
  position: readonly [number, number, number],
  size: readonly [bottomWidth: number, topWidth: number, height: number, depth: number],
  rotation: readonly [number, number, number] = [0, 0, 0],
  weightFn?: WeightFn,
): void {
  out.append(armorPlate(size[0], size[1], size[2], size[3]), bone, role, transform(position, rotation), weightFn);
}

/**
 * Portrait hair in three authored shapes. The cap opens at the face (phi gap
 * centered on +Z) so skin reads as forehead; a swept fringe band marks the
 * hairline. Everything sits slightly proud of the skull so the toon outline
 * reads hair silhouette, never scalp.
 *
 * The chase camera mostly sees the BACK of the head: a bare cap there reads
 * as a swim cap / helmet. Every style gets a nape mass below the skull line;
 * the bob grows shoulder-length curtains, the ponytail drops past the neck —
 * silhouette identity from behind, not just from the front.
 */
function appendHair(
  out: SkinAssembler,
  head: THREE.Bone,
  look: RiderLook,
  sides: number,
): void {
  const capTheta = look.hairStyle === 'bob' ? 2.32 : 2.0;
  const capScale: readonly [number, number, number] =
    look.hairStyle === 'bob' ? [0.141, 0.152, 0.145] : [0.133, 0.15, 0.14];
  const faceGap = 0.78;
  out.append(
    new THREE.SphereGeometry(1, sides, Math.max(5, Math.floor(sides * 0.6)),
      Math.PI * 0.5 + faceGap, Math.PI * 2 - faceGap * 2, 0, capTheta),
    head,
    Role.Hair,
    transform([0, 0.104, 0.004], [0, 0, 0], capScale),
  );
  out.append(
    new THREE.SphereGeometry(1, Math.max(4, Math.floor(sides * 0.5)), 4,
      Math.PI * 0.5 - 0.85, 1.7, capTheta - 0.52, 0.52),
    head,
    Role.Hair,
    transform([0, 0.104, 0.006], [0, 0, 0],
      [capScale[0] * 1.012, capScale[1] * 1.012, capScale[2] * 1.012]),
  );
  // Nape mass: hair covering the back of the skull down to the neck line.
  appendEllipsoid(out, head, Role.Hair, [0, 0.015, -0.045], [0.126, 0.115, 0.115], sides);
  if (look.hairStyle === 'bob') {
    // Shoulder-length curtains: fuller back mass plus side locks that break
    // the head-and-shoulders silhouette from behind.
    appendEllipsoid(out, head, Role.Hair, [0, -0.075, -0.055], [0.132, 0.15, 0.118], sides);
    appendEllipsoid(out, head, Role.Hair, [0.112, -0.075, 0.015], [0.045, 0.135, 0.075], sides);
    appendEllipsoid(out, head, Role.Hair, [-0.112, -0.075, 0.015], [0.045, 0.135, 0.075], sides);
  }
  if (look.hairStyle === 'ponytail') {
    // High tail: accent tie band, then a five-bob arc falling past the neck
    // to mid-back — the long braid reads over the white suit from behind.
    appendEllipsoid(out, head, Role.Accent, [0, 0.2, -0.078], [0.032, 0.032, 0.032], 6);
    appendEllipsoid(out, head, Role.Hair, [0, 0.205, -0.115], [0.048, 0.05, 0.055], 8);
    appendEllipsoid(out, head, Role.Hair, [0, 0.165, -0.205], [0.042, 0.047, 0.085], 8);
    appendEllipsoid(out, head, Role.Hair, [0, 0.095, -0.275], [0.034, 0.04, 0.075], 8);
    appendEllipsoid(out, head, Role.Hair, [0, 0.015, -0.31], [0.027, 0.033, 0.062], 8);
    appendEllipsoid(out, head, Role.Hair, [0, -0.055, -0.315], [0.02, 0.026, 0.05], 8);
  }
}

export function buildSkinnedRider(
  root: THREE.Object3D,
  rig: RiderBones,
  color: number,
  detailed: boolean,
  look: RiderLook,
): RiderSkin {
  const bones = [
    rig.hips, rig.spine, rig.chest, rig.head,
    rig.shoulderL, rig.shoulderR, rig.elbowL, rig.elbowR, rig.handL, rig.handR,
    rig.hipL, rig.hipR, rig.kneeL, rig.kneeR, rig.footL, rig.footR,
  ];
  const sides = detailed ? 12 : 8;
  const out = new SkinAssembler(root, bones, color, look);

  // Pelvis and torso are authored lofts: narrow waist, broad protected
  // shoulders and a forward-rising racing posture rather than stacked balls.
  // The seat is white sail-cloth with dark navy side panels — from the chase
  // camera the rider reads as a white-suited sailor, not a dark silhouette.
  out.append(bodyLoft([
    { y: -0.08, z: 0.015, halfWidth: 0.135, halfDepth: 0.095 },
    { y: 0.0, z: 0.02, halfWidth: 0.17, halfDepth: 0.12 },
    { y: 0.1, z: 0.025, halfWidth: 0.16, halfDepth: 0.115 },
    { y: 0.16, z: 0.035, halfWidth: 0.13, halfDepth: 0.095 },
  ], sides), rig.hips, (point) => Math.abs(point.x) > 0.105 ? Role.SuitDark : Role.Suit);
  out.append(bodyLoft([
    { y: -0.055, z: 0.0, halfWidth: 0.125, halfDepth: 0.09 },
    { y: 0.045, z: 0.025, halfWidth: 0.155, halfDepth: 0.11 },
    { y: 0.18, z: 0.075, halfWidth: 0.195, halfDepth: 0.13 },
    { y: 0.31, z: 0.14, halfWidth: 0.17, halfDepth: 0.115 },
    { y: 0.385, z: 0.18, halfWidth: 0.115, halfDepth: 0.085 },
  ], sides), rig.spine, Role.Suit, new THREE.Matrix4(), (point) => {
    const chestWeight = smoothstep(0.12, 0.34, point.y);
    return [[rig.spine, 1 - chestWeight], [rig.chest, chestWeight]];
  });

  // The back the player actually watches: a pale team-tinted vest panel, a
  // saturated team-color V yoke, a thin ink zip and a white stand collar.
  const torsoWeights: WeightFn = (point) => {
    const chestWeight = smoothstep(0.08, 0.31, point.y);
    return [[rig.spine, 1 - chestWeight], [rig.chest, chestWeight]];
  };
  appendPanel(out, rig.spine, Role.SuitLight, [0, 0.19, -0.072], [0.27, 0.215, 0.28, 0.04], [0.05, 0, 0], torsoWeights);
  appendPanel(out, rig.spine, Role.Accent, [0.068, 0.235, -0.096], [0.052, 0.03, 0.19, 0.026], [0.05, 0, -0.52], torsoWeights);
  appendPanel(out, rig.spine, Role.Accent, [-0.068, 0.235, -0.096], [0.052, 0.03, 0.19, 0.026], [0.05, 0, 0.52], torsoWeights);
  appendPanel(out, rig.spine, Role.Ink, [0, 0.17, -0.098], [0.02, 0.02, 0.23, 0.02], [0.05, 0, 0], torsoWeights);
  appendPanel(out, rig.spine, Role.Foam, [0.078, 0.33, 0.008], [0.16, 0.12, 0.05, 0.034], [0.06, 0, -0.16], torsoWeights);
  appendPanel(out, rig.spine, Role.Foam, [-0.078, 0.33, 0.008], [0.16, 0.12, 0.05, 0.034], [0.06, 0, 0.16], torsoWeights);
  appendPanel(out, rig.spine, Role.Accent, [0, 0.055, -0.105], [0.14, 0.105, 0.065, 0.03], [0.05, 0, 0], torsoWeights);

  // Arms: one continuous white sleeve from deltoid to cuff, team glove.
  for (const [shoulder, elbow, hand, mirror] of [
    [rig.shoulderL, rig.elbowL, rig.handL, 1],
    [rig.shoulderR, rig.elbowR, rig.handR, -1],
  ] as const) {
    appendEllipsoid(out, shoulder, Role.Suit, [0.012 * mirror, 0.012, 0.008], [0.084, 0.07, 0.08], sides);
    appendLimb(out, shoulder, elbow, 0.063, 0.056, 0.05, Role.Suit, sides);
    appendLimb(out, elbow, hand, 0.05, 0.045, 0.041, Role.Suit, sides);
    appendEllipsoid(out, hand, Role.Accent, [0, 0, 0.012], [0.066, 0.054, 0.077], sides);
  }

  // Legs: white thighs and shins, team knee flash, tall dark boots.
  for (const [hip, knee, foot, mirror] of [
    [rig.hipL, rig.kneeL, rig.footL, 1],
    [rig.hipR, rig.kneeR, rig.footR, -1],
  ] as const) {
    appendEllipsoid(out, hip, Role.Suit, [0.006 * mirror, 0, 0], [0.105, 0.085, 0.1], sides);
    appendLimb(out, hip, knee, 0.1, 0.088, 0.077, Role.Suit, sides);
    appendLimb(out, knee, foot, 0.072, 0.062, 0.055, Role.Suit, sides);
    appendPanel(out, knee, Role.Accent, [0, 0.02, -0.064], [0.105, 0.085, 0.07, 0.027]);
    out.append(new THREE.BoxGeometry(0.125, 0.095, 0.275), foot, Role.Ink,
      transform([0, -0.012, 0.075], [0.03, 0, 0]));
    out.append(new THREE.BoxGeometry(0.132, 0.025, 0.29), foot, Role.Metal,
      transform([0, -0.065, 0.078], [0.03, 0, 0]));
  }

  // Bare head, portrait-locked. Commercial arcade racers keep the face out:
  // hair + skin is the character read from every camera, a full helmet throws
  // the identity away. +Z is face-forward in head-bone space.
  appendSegment(out, rig.chest, rig.head, 0.062, 0.052, Role.Skin, sides);
  out.append(new THREE.CylinderGeometry(0.068, 0.078, 0.06, sides, 1), rig.head, Role.SuitDark,
    transform([0, -0.015, 0.005], [0, 0, 0]));
  const headSides = detailed ? 16 : 10;
  appendEllipsoid(out, rig.head, Role.Skin, [0, 0.1, 0.02], [0.125, 0.14, 0.132], headSides);
  // Face: painted-anime eyes and a small nose bridge, readable at dossier
  // distance without pretending to be a texture.
  appendEllipsoid(out, rig.head, Role.Ink, [0.047, 0.105, 0.143], [0.018, 0.025, 0.01], 6);
  appendEllipsoid(out, rig.head, Role.Ink, [-0.047, 0.105, 0.143], [0.018, 0.025, 0.01], 6);
  appendEllipsoid(out, rig.head, Role.Skin, [0, 0.082, 0.152], [0.014, 0.022, 0.014], 6);
  appendHair(out, rig.head, look, headSides);

  const result = out.finish();
  const material = createToonMaterial({
    color: 0xffffff,
    vertexColors: true,
    rimColor: PALETTE.foam,
    rimStrength: 1.05,
    rimPower: 2.25,
    rimThreshold: 0.55,
    specColor: PALETTE.sparkle,
    specThreshold: 0.82,
  });
  material.name = 'RiderToonSkinned';
  // Lift the shadow floor: dark panels stay ink-navy instead of collapsing to
  // pitch black iron under the toon step.
  material.uniforms.uShadowFloor.value.setHex(0x3a3560, THREE.NoColorSpace);
  const mesh = new THREE.SkinnedMesh(result.geometry, material);
  mesh.name = 'rider-skinned-shell';
  // Bone poses stay inside this conservative local sphere. Keeping culling
  // enabled removes off-camera riders without replacing the real skinned mesh.
  result.geometry.boundingSphere!.center.set(0, 0, 0);
  result.geometry.boundingSphere!.radius = Math.max(result.geometry.boundingSphere!.radius, 4);
  mesh.frustumCulled = true;
  mesh.userData.assetClass = 'batched-skinned-rider';
  mesh.userData.boneCount = bones.length;
  mesh.userData.paletteRoleCount = 9;
  root.add(mesh);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  mesh.normalizeSkinWeights();
  return { mesh, roles: result.roles, colorAttribute: result.colorAttribute };
}

export function updateSkinnedRiderColor(skin: RiderSkin, color: number, look: RiderLook): void {
  const scratch = new THREE.Color();
  for (let i = 0; i < skin.roles.length; i++) {
    scratch.copy(roleColor(skin.roles[i] as Role, color, look));
    skin.colorAttribute.setXYZ(i, scratch.r, scratch.g, scratch.b);
  }
  skin.colorAttribute.needsUpdate = true;
}
