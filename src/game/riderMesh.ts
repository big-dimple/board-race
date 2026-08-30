/**
 * Procedural rider skin with an independently rigged hair accessory.
 *
 * The animation rig remains code-driven in rider.ts. This module turns that
 * rig into one body SkinnedMesh plus a style-specific hair SkinnedMesh.
 * The split lets bob and braid silhouettes use secondary-motion bones while
 * face, gloves and boots retain the shared compact body palette.
 * Identity is portrait-locked: bare head, per-driver hair color/style and
 * skin, white racing suit with team-color gloves and piping.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { createToonMaterial } from '../cel/toonMaterial';
import { addOutline } from '../cel/outline';
import { LAYER_INK, markInk } from '../contracts';

export interface RiderLook {
  driverId: string;
  hair: number;
  hairAccent?: number;
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
  hair: HairAccessory;
  faceMesh: THREE.Mesh;
}

export interface HairAccessory {
  object: THREE.Group;
  mesh: THREE.SkinnedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  colorAttribute: THREE.BufferAttribute;
  roles: Uint8Array;
  bones: readonly THREE.Bone[];
  head: THREE.Bone;
  detailed: boolean;
  style: RiderLook['hairStyle'];
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
  HairLight,
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
    case Role.HairLight: return look.hairAccent !== undefined
      ? new THREE.Color().setHex(look.hairAccent, THREE.NoColorSpace)
      : new THREE.Color().setHex(look.hair, THREE.NoColorSpace)
        .lerp(new THREE.Color().setHex(PALETTE.sparkle, THREE.NoColorSpace), 0.26);
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

/** A broad, tapered blade makes a readable lock from the chase camera. */
function appendHairBlade(
  out: SkinAssembler,
  bone: THREE.Bone,
  position: readonly [number, number, number],
  bottomWidth: number,
  topWidth: number,
  height: number,
  depth: number,
  rotation: readonly [number, number, number] = [0, 0, 0],
  role: Role.Hair | Role.HairLight = Role.Hair,
): void {
  appendPanel(out, bone, role, position, [bottomWidth, topWidth, height, depth], rotation);
}

function curvedHairLockGeometry(
  bottomWidth: number,
  middleWidth: number,
  topWidth: number,
  height: number,
  depth: number,
  bend: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const widths = [topWidth, middleWidth, bottomWidth];
  for (let ring = 0; ring < 3; ring++) {
    const t = ring / 2;
    const y = -height * t;
    const z = bend * t * t;
    const halfWidth = widths[ring] * 0.5;
    const halfDepth = depth * 0.5;
    positions.push(
      -halfWidth, y, z - halfDepth,
      halfWidth, y, z - halfDepth,
      halfWidth, y, z + halfDepth,
      -halfWidth, y, z + halfDepth,
    );
  }
  for (let ring = 0; ring < 2; ring++) {
    const a = ring * 4;
    const b = a + 4;
    for (let side = 0; side < 4; side++) {
      const next = (side + 1) % 4;
      indices.push(a + side, a + next, b + side, a + next, b + next, b + side);
    }
  }
  indices.push(0, 2, 1, 0, 3, 2, 8, 9, 10, 8, 10, 11);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function appendCurvedHairLock(
  out: SkinAssembler,
  bone: THREE.Bone,
  position: readonly [number, number, number],
  widths: readonly [bottom: number, middle: number, top: number],
  height: number,
  depth: number,
  bend: number,
  rotation: readonly [number, number, number] = [0, 0, 0],
  role: Role.Hair | Role.HairLight = Role.Hair,
): void {
  out.append(
    curvedHairLockGeometry(widths[0], widths[1], widths[2], height, depth, bend),
    bone,
    role,
    transform(position, rotation),
  );
}

function makeHairBone(parent: THREE.Object3D, name: string, position: readonly [number, number, number]): THREE.Bone {
  const bone = new THREE.Bone();
  bone.name = name;
  bone.position.set(position[0], position[1], position[2]);
  parent.add(bone);
  return bone;
}

const sharedFaceTextureCache = new Map<string, THREE.CanvasTexture>();

export function getFaceTextureCacheSize(): number {
  return sharedFaceTextureCache.size;
}

function hexToString(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

function getOrCreateFaceTexture(driverId: string, look: RiderLook): THREE.CanvasTexture {
  const cached = sharedFaceTextureCache.get(driverId);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2d context for face texture canvas');

  ctx.clearRect(0, 0, 512, 512);

  // 1. Natural Anime Skin Tone Gradient
  const skinHex = hexToString(look.skin);
  const hairHex = hexToString(look.hair);

  // Soft stylized cheek gradient
  const skinGrad = ctx.createRadialGradient(256, 260, 20, 256, 260, 220);
  skinGrad.addColorStop(0, skinHex);
  skinGrad.addColorStop(0.85, skinHex);
  skinGrad.addColorStop(1, 'rgba(0,0,0,0.06)');

  // 2. Character-Specific Facial Features & Expressions
  const eyeColors: Record<string, { irisTop: string; irisBottom: string; highlight: string; glow: string }> = {
    axle: { irisTop: '#2a1a10', irisBottom: '#8d5524', highlight: '#ffffff', glow: '#39ff88' },
    tide: { irisTop: '#081c3b', irisBottom: '#00d0ff', highlight: '#ffffff', glow: '#00f0ff' },
    sol: { irisTop: '#5a2500', irisBottom: '#ffaa00', highlight: '#fff2a8', glow: '#ffd020' },
    reef: { irisTop: '#4a0808', irisBottom: '#ff2244', highlight: '#ffffff', glow: '#ff3d7f' },
    kai: { irisTop: '#0c1228', irisBottom: '#448aff', highlight: '#ffffff', glow: '#64b5f6' },
    jinx: { irisTop: '#280c44', irisBottom: '#d500f9', highlight: '#ffffff', glow: '#ea80fc' },
  };
  const eyeColor = eyeColors[driverId] ?? { irisTop: '#101018', irisBottom: '#3878cc', highlight: '#ffffff', glow: '#00f0ff' };

  // Draw Eyes
  for (const [side, cx] of [[-1, 160], [1, 352]] as const) {
    const cy = 248;
    // Sclera (Eye White)
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, 38, 30, (side * 0.08), 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafd';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.stroke();

    // Iris
    ctx.beginPath();
    ctx.ellipse(cx + side * 2, cy + 1, 22, 26, (side * 0.04), 0, Math.PI * 2);
    const irisGrad = ctx.createLinearGradient(cx, cy - 26, cx, cy + 26);
    irisGrad.addColorStop(0, eyeColor.irisTop);
    irisGrad.addColorStop(0.55, eyeColor.irisBottom);
    irisGrad.addColorStop(1, eyeColor.highlight);
    ctx.fillStyle = irisGrad;
    ctx.fill();

    // Dark Pupil
    ctx.beginPath();
    ctx.ellipse(cx + side * 2, cy + 2, 10, 14, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#080a14';
    ctx.fill();

    // Anime Specular Glints
    ctx.beginPath();
    ctx.arc(cx + side * 2 - 6, cy - 8, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + side * 2 + 7, cy + 8, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fill();

    // Eyeliner / Upper Eyelid
    ctx.beginPath();
    ctx.moveTo(cx - side * 44, cy - 4);
    ctx.quadraticCurveTo(cx, cy - 36, cx + side * 44, cy - (driverId === 'tide' ? 14 : 2));
    ctx.lineWidth = driverId === 'tide' ? 9 : 6.5;
    ctx.strokeStyle = '#121524';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Eyelashes for female drivers
    if (driverId === 'tide' || driverId === 'sol') {
      ctx.beginPath();
      ctx.moveTo(cx + side * 38, cy - 18);
      ctx.lineTo(cx + side * 48, cy - 28);
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Draw Eyebrows
  for (const [side, cx] of [[-1, 160], [1, 352]] as const) {
    ctx.save();
    ctx.beginPath();
    if (driverId === 'reef') {
      // Aggressive angled brows
      ctx.moveTo(cx - side * 46, 192);
      ctx.lineTo(cx + side * 36, 162);
    } else if (driverId === 'tide') {
      // Sleek arched brows
      ctx.moveTo(cx - side * 42, 196);
      ctx.quadraticCurveTo(cx + side * 6, 165, cx + side * 42, 178);
    } else if (driverId === 'jinx') {
      // Playful raised brows
      ctx.moveTo(cx - side * 40, 185);
      ctx.quadraticCurveTo(cx, 160, cx + side * 40, 175);
    } else {
      // Confident structured brows
      ctx.moveTo(cx - side * 44, 192);
      ctx.quadraticCurveTo(cx, 168, cx + side * 42, 174);
    }
    ctx.lineWidth = driverId === 'sol' ? 6 : 7.5;
    ctx.strokeStyle = hairHex;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  // Draw Nose
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(254, 305);
  ctx.lineTo(258, 322);
  ctx.lineTo(250, 324);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(120, 60, 40, 0.45)';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();

  // Draw Mouth according to personality
  ctx.save();
  ctx.beginPath();
  if (driverId === 'sol') {
    // Joyful open smile
    ctx.moveTo(215, 375);
    ctx.quadraticCurveTo(256, 420, 297, 375);
    ctx.closePath();
    ctx.fillStyle = '#ff4081';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#3a1220';
    ctx.stroke();
    // Teeth
    ctx.beginPath();
    ctx.moveTo(226, 377);
    ctx.quadraticCurveTo(256, 392, 286, 377);
    ctx.lineTo(286, 375);
    ctx.lineTo(226, 375);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  } else if (driverId === 'jinx') {
    // Playful mischievous grin with canine
    ctx.moveTo(218, 380);
    ctx.quadraticCurveTo(256, 415, 294, 376);
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = '#201530';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(278, 381);
    ctx.lineTo(284, 393);
    ctx.lineTo(290, 380);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  } else if (driverId === 'reef') {
    // Fierce battle grin / clenched teeth
    ctx.moveTo(218, 385);
    ctx.lineTo(294, 385);
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = '#201010';
    ctx.stroke();
  } else if (driverId === 'tide') {
    // Haughty subtle smirk
    ctx.moveTo(225, 384);
    ctx.quadraticCurveTo(256, 394, 288, 380);
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#c2185b';
    ctx.stroke();
  } else {
    // Axle & Kai: Calm confident smirk
    ctx.moveTo(226, 382);
    ctx.quadraticCurveTo(256, 396, 286, 380);
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#3e2723';
    ctx.stroke();
  }
  ctx.restore();

  // 3. Driver-Specific Iconic Face / Head Accessories
  if (driverId === 'axle') {
    // Tang Dynasty Cyber Forehead Ribbon with Jadeite Diamond
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(60, 142);
    ctx.quadraticCurveTo(256, 122, 452, 142);
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#182434';
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#39ff88';
    ctx.stroke();
    // Center Jadeite Gem
    ctx.beginPath();
    ctx.moveTo(256, 114);
    ctx.lineTo(268, 132);
    ctx.lineTo(256, 150);
    ctx.lineTo(244, 132);
    ctx.closePath();
    ctx.fillStyle = '#00e676';
    ctx.shadowColor = '#39ff88';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  } else if (driverId === 'tide') {
    // Left-Eye Holographic Smart Monocle & HUD Reticle [ ⌖ ]
    ctx.save();
    const cx = 352;
    const cy = 248;
    ctx.strokeStyle = '#00f0ff';
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = 12;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 38, -Math.PI * 0.4, Math.PI * 0.4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 38, Math.PI * 0.6, Math.PI * 1.4);
    ctx.stroke();
    // Reticle brackets
    ctx.beginPath();
    ctx.moveTo(cx - 14, cy); ctx.lineTo(cx + 14, cy);
    ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy + 14);
    ctx.stroke();
    ctx.font = '700 11px monospace';
    ctx.fillStyle = '#00f0ff';
    ctx.fillText('TARGET: LOCKED', cx - 40, cy + 54);
    ctx.restore();
  } else if (driverId === 'sol') {
    // Solar Forehead Sunglasses & Sun-Glow Cheeks
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(110, 145);
    ctx.quadraticCurveTo(256, 125, 402, 145);
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#ffd700';
    ctx.stroke();
    // Amber glass lenses
    for (const sx of [175, 337]) {
      ctx.beginPath();
      ctx.roundRect(sx - 48, 128, 96, 28, 8);
      ctx.fillStyle = 'rgba(255, 136, 0, 0.85)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffe082';
      ctx.stroke();
    }
    // Cute blush
    for (const bx of [145, 367]) {
      ctx.beginPath();
      ctx.arc(bx, 285, 18, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 64, 129, 0.28)';
      ctx.fill();
    }
    ctx.restore();
  } else if (driverId === 'reef') {
    // Combat Nose Bridge Tape & Tactical Forehead Strap
    ctx.save();
    // Nose tape
    ctx.fillStyle = '#e0c8b0';
    ctx.strokeStyle = '#8d6e63';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(234, 290, 44, 16, 3);
    ctx.fill();
    ctx.stroke();
    // Forehead Tactical Strap
    ctx.beginPath();
    ctx.moveTo(60, 148);
    ctx.quadraticCurveTo(256, 130, 452, 148);
    ctx.lineWidth = 16;
    ctx.strokeStyle = '#263238';
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ff1744';
    ctx.stroke();
    ctx.restore();
  } else if (driverId === 'kai') {
    // Sleek Purple AR HUD Visor Line
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(100, 215);
    ctx.quadraticCurveTo(256, 195, 412, 215);
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#448aff';
    ctx.shadowColor = '#82b1ff';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.font = '700 10px monospace';
    ctx.fillStyle = '#82b1ff';
    ctx.fillText('SYS.CALIB: 99.8%', 205, 202);
    ctx.restore();
  } else if (driverId === 'jinx') {
    // Cute Pixel Cheek Blush & Cyber Goggle Strap
    ctx.save();
    // Digital pixel blush
    for (const [side, bx] of [[-1, 140], [1, 372]] as const) {
      ctx.fillStyle = '#e040fb';
      ctx.fillRect(bx - 10, 278, 8, 8);
      ctx.fillRect(bx + 2, 278, 8, 8);
      ctx.fillRect(bx - 4, 288, 8, 8);
    }
    // Goggle leather strap
    ctx.beginPath();
    ctx.moveTo(50, 138);
    ctx.quadraticCurveTo(256, 115, 462, 138);
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#3e2723';
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ea80fc';
    ctx.stroke();
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  sharedFaceTextureCache.set(driverId, texture);
  return texture;
}

function buildFacePatch(headBone: THREE.Bone, look: RiderLook): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const xmin = -0.118;
  const xmax = 0.118;
  const ymin = 0.046;
  const ymax = 0.195;

  const numCols = 16;
  const numRows = 10;

  for (let row = 0; row < numRows; row++) {
    const tY = row / (numRows - 1);
    const y = ymin + tY * (ymax - ymin);
    const v = 1 - tY;
    for (let col = 0; col < numCols; col++) {
      const tX = col / (numCols - 1);
      const x = xmin + tX * (xmax - xmin);
      const u = tX;

      const nx = x / 0.136;
      const ny = (y - 0.115) / 0.150;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const z = 0.024 + 0.142 * nz + 0.008;

      positions.push(x, y, z);
      uvs.push(u, v);
    }
  }

  for (let row = 0; row < numRows - 1; row++) {
    for (let col = 0; col < numCols - 1; col++) {
      const a = row * numCols + col;
      const b = a + 1;
      const c = a + numCols;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const faceTexture = getOrCreateFaceTexture(look.driverId, look);
  const faceMat = new THREE.MeshBasicMaterial({
    map: faceTexture,
    color: 0xffffff,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.FrontSide,
    toneMapped: false,
  });
  faceMat.name = 'RiderFacePatch';

  const faceMesh = new THREE.Mesh(geometry, faceMat);
  faceMesh.name = 'rider-face-patch';
  faceMesh.renderOrder = 1;
  faceMesh.frustumCulled = false;
  faceMesh.userData.noInk = true;
  faceMesh.userData.noOutline = true;
  faceMesh.layers.set(0);
  headBone.add(faceMesh);

  return faceMesh;
}

function buildSkullLoftGeometry(detailed: boolean): THREE.BufferGeometry {
  const rings = [
    { y: 0.242, z: -0.006, rx: 0.032, rz: 0.036 }, // crown close
    { y: 0.225, z: 0.015, rx: 0.082, rz: 0.090 }, // crown
    { y: 0.175, z: 0.020, rx: 0.132, rz: 0.136 }, // parietal
    { y: 0.105, z: 0.025, rx: 0.136, rz: 0.132 }, // temple/hairline
    { y: 0.035, z: -0.040, rx: 0.098, rz: 0.075 }, // nape
  ];
  const sides = detailed ? 12 : 8;
  const frontGap = 0.72; // radians on each side of +Z; leave face open
  const sweep = Math.PI * 2 - frontGap * 2;
  const vertices: number[] = [];
  const indices: number[] = [];

  for (const ring of rings) {
    for (let i = 0; i <= sides; i++) {
      const theta = frontGap + (sweep * i) / sides;
      const x = ring.rx * Math.sin(theta);
      const z = ring.z + ring.rz * Math.cos(theta);
      vertices.push(x, ring.y, z - 0.006);
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let i = 0; i < sides; i++) {
      const a = ring * (sides + 1) + i;
      const b = a + 1;
      const c = a + sides + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // Close crown arc
  const crownCenter = vertices.length / 3;
  vertices.push(0, 0.252, -0.014);
  for (let i = 0; i < sides; i++) indices.push(crownCenter, i, i + 1);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildHairAccessory(head: THREE.Bone, look: RiderLook, detailed: boolean): HairAccessory {
  const object = new THREE.Group();
  object.name = `rider-hair-${look.hairStyle}-${look.driverId}`;
  head.add(object);
  const hairRoot = makeHairBone(object, 'hair-root', [0, 0, 0]);
  const bones: THREE.Bone[] = [hairRoot];
  let bobBones: readonly [THREE.Bone, THREE.Bone, THREE.Bone] | null = null;
  let braidBones: readonly [THREE.Bone, THREE.Bone, THREE.Bone, THREE.Bone, THREE.Bone] | null = null;

  if (look.hairStyle === 'bob') {
    const back = makeHairBone(hairRoot, 'bob-back', [0, -0.02, -0.14]);
    const left = makeHairBone(hairRoot, 'bob-left', [0.17, -0.015, -0.11]);
    const right = makeHairBone(hairRoot, 'bob-right', [-0.17, -0.015, -0.11]);
    bones.push(back, left, right);
    bobBones = [back, left, right];
  } else if (look.hairStyle === 'ponytail') {
    const tie = makeHairBone(hairRoot, 'braid-tie', [0.12, 0.19, -0.12]);
    const braid1 = makeHairBone(tie, 'braid-1', [0.03, -0.105, -0.07]);
    const braid2 = makeHairBone(braid1, 'braid-2', [0.04, -0.135, -0.08]);
    const braid3 = makeHairBone(braid2, 'braid-3', [0.035, -0.125, -0.08]);
    const braid4 = makeHairBone(braid3, 'braid-4', [0.025, -0.11, -0.07]);
    bones.push(tie, braid1, braid2, braid3, braid4);
    braidBones = [tie, braid1, braid2, braid3, braid4];
  }

  object.updateWorldMatrix(true, true);
  const out = new SkinAssembler(object, bones, 0xffffff, look);
  const sides = detailed ? 12 : 8;

  // Base skull hair volume
  out.append(buildSkullLoftGeometry(detailed), hairRoot, Role.Hair);

  if (bobBones) {
    // ---- Tide (ChatGPT / 山姆傲慢) ----
    const [back, left, right] = bobBones;
    // Asymmetric swinging bob locks
    appendHairBlade(out, hairRoot, [0, 0.015, -0.115], 0.28, 0.22, 0.25, 0.08, [0.02, 0, 0]);
    appendHairBlade(out, hairRoot, [0, -0.135, -0.18], 0.24, 0.28, 0.14, 0.035, [0.02, 0, 0], Role.HairLight);
    appendCurvedHairLock(out, back, [0.065, -0.02, -0.035], [0.045, 0.13, 0.16], 0.36, 0.1, -0.04, [0.07, 0, -0.05]);
    appendCurvedHairLock(out, back, [-0.065, -0.025, -0.045], [0.04, 0.13, 0.16], 0.37, 0.1, -0.04, [0.08, 0, 0.05]);
    appendCurvedHairLock(out, left, [0.045, -0.015, -0.06], [0.065, 0.18, 0.22], 0.34, 0.115, -0.035, [0.07, 0, -0.12]);
    appendCurvedHairLock(out, right, [-0.045, -0.015, -0.06], [0.065, 0.18, 0.22], 0.34, 0.115, -0.035, [0.07, 0, 0.12]);
    // Cyan-dipped hair overlays
    appendCurvedHairLock(out, back, [0.065, -0.245, -0.095], [0.025, 0.07, 0.085], 0.12, 0.035, -0.018, [0.07, 0, -0.05], Role.HairLight);
    appendCurvedHairLock(out, back, [-0.065, -0.255, -0.1], [0.025, 0.07, 0.085], 0.12, 0.035, -0.018, [0.08, 0, 0.05], Role.HairLight);
    appendCurvedHairLock(out, left, [0.045, -0.215, -0.14], [0.035, 0.11, 0.14], 0.12, 0.04, -0.016, [0.07, 0, -0.12], Role.HairLight);
    appendCurvedHairLock(out, right, [-0.045, -0.215, -0.14], [0.035, 0.11, 0.14], 0.12, 0.04, -0.016, [0.07, 0, 0.12], Role.HairLight);
    // 3D Accessory: Left Holographic Smart Monocle & Right Cyber Ear-Cuff
    appendPanel(out, hairRoot, Role.HairLight, [0.058, 0.125, 0.132], [0.045, 0.045, 0.038, 0.016], [0.06, -0.08, 0]);
    appendPanel(out, hairRoot, Role.Metal, [-0.136, 0.108, 0.008], [0.018, 0.018, 0.042, 0.018], [0, 0, 0.15]);
  } else if (braidBones) {
    // ---- Sol (Gemini / 美国豆包) ----
    const [tie, braid1, braid2, braid3, braid4] = braidBones;
    // Voluminous golden ponytail braid
    appendCurvedHairLock(out, tie, [0, 0, 0], [0.1, 0.125, 0.1], 0.15, 0.1, -0.055, [0.08, 0, -0.12]);
    appendCurvedHairLock(out, braid1, [0, 0, 0], [0.09, 0.115, 0.1], 0.18, 0.1, -0.07, [-0.06, 0, -0.06]);
    appendCurvedHairLock(out, braid2, [0, 0, 0], [0.075, 0.1, 0.09], 0.17, 0.09, -0.065, [0.05, 0, 0.05]);
    appendCurvedHairLock(out, braid3, [0, 0, 0], [0.055, 0.08, 0.07], 0.16, 0.075, -0.055, [-0.04, 0, -0.04]);
    appendCurvedHairLock(out, braid4, [0, 0, 0], [0.022, 0.052, 0.062], 0.14, 0.062, -0.045, [0.03, 0, 0], Role.HairLight);
    // 3D Accessory: High Golden Hair Ring & Forehead Cyber Sunglasses
    appendPanel(out, tie, Role.Metal, [0, 0.025, 0], [0.075, 0.065, 0.045, 0.075], [0, 0, 0]);
    appendPanel(out, hairRoot, Role.Accent, [0, 0.192, 0.108], [0.165, 0.145, 0.038, 0.032], [0.22, 0, 0]);
  } else if (look.driverId === 'reef') {
    // ---- Reef (KK / Kimi) — Fierce Punk Mohawk & Tactical Headband ----
    // Sharp layered crimson mohawk crests
    appendHairBlade(out, hairRoot, [0, 0.245, 0.02], 0.075, 0.045, 0.11, 0.085, [0.16, 0, 0], Role.Hair);
    appendHairBlade(out, hairRoot, [0, 0.235, -0.06], 0.078, 0.042, 0.12, 0.095, [-0.08, 0, 0], Role.HairLight);
    appendHairBlade(out, hairRoot, [0, 0.185, -0.13], 0.072, 0.038, 0.10, 0.085, [-0.32, 0, 0], Role.Hair);
    // Side spike tufts
    appendHairBlade(out, hairRoot, [0.065, 0.21, -0.02], 0.055, 0.025, 0.08, 0.06, [0.08, 0.18, -0.22], Role.HairLight);
    appendHairBlade(out, hairRoot, [-0.065, 0.21, -0.02], 0.055, 0.025, 0.08, 0.06, [0.08, -0.18, 0.22], Role.HairLight);
    // 3D Accessory: Combat Tactical Bandana & Left Ear Antenna
    appendPanel(out, hairRoot, Role.SuitDark, [0, 0.168, 0.096], [0.185, 0.185, 0.038, 0.038], [0.14, 0, 0]);
    appendPanel(out, hairRoot, Role.Metal, [0.078, 0.170, 0.112], [0.028, 0.028, 0.032, 0.018], [0.14, 0, 0]);
    appendPanel(out, hairRoot, Role.Metal, [-0.138, 0.122, -0.008], [0.010, 0.006, 0.115, 0.010], [0.32, 0, -0.15]);
  } else if (look.driverId === 'kai') {
    // ---- Kai (Claude / 打你嗷) — Clean Swept Hair & AR Visor Wings ----
    // Swept anime hair layers
    appendHairBlade(out, hairRoot, [0, 0.225, -0.02], 0.11, 0.06, 0.08, 0.09, [0.06, 0, 0], Role.Hair);
    appendHairBlade(out, hairRoot, [0.065, 0.21, -0.03], 0.075, 0.04, 0.07, 0.07, [0.06, 0.14, -0.16], Role.Hair);
    appendHairBlade(out, hairRoot, [-0.065, 0.21, -0.03], 0.075, 0.04, 0.07, 0.07, [0.06, -0.14, 0.16], Role.Hair);
    appendHairBlade(out, hairRoot, [0.035, 0.19, 0.085], 0.065, 0.03, 0.055, 0.045, [0.22, 0.1, -0.1], Role.HairLight);
    // 3D Accessory: AR Visor Frame & Dual Titanium Ear Wings
    appendPanel(out, hairRoot, Role.Accent, [0, 0.142, 0.126], [0.175, 0.155, 0.026, 0.020], [0.08, 0, 0]);
    for (const side of [-1, 1]) {
      appendPanel(out, hairRoot, Role.Metal, [side * 0.138, 0.108, -0.01], [0.016, 0.012, 0.062, 0.018], [0.16, 0, side * 0.22]);
    }
  } else if (look.driverId === 'jinx') {
    // ---- Jinx (DeepSeek / 梁圣梁子) — Messy Indigo Spikes & Overhead Goggles ----
    // Messy tousled spikes
    appendHairBlade(out, hairRoot, [-0.055, 0.235, 0.01], 0.08, 0.04, 0.09, 0.08, [0.12, -0.18, 0.24], Role.HairLight);
    appendHairBlade(out, hairRoot, [0.055, 0.225, -0.02], 0.075, 0.038, 0.085, 0.075, [0.08, 0.15, -0.18], Role.Hair);
    appendHairBlade(out, hairRoot, [0, 0.22, -0.09], 0.085, 0.045, 0.08, 0.085, [-0.22, 0, 0], Role.HairLight);
    appendHairBlade(out, hairRoot, [0.07, 0.19, 0.06], 0.055, 0.025, 0.06, 0.05, [0.18, 0.22, -0.15], Role.Hair);
    // 3D Accessory: Overhead Dual-Lens Steampunk Cyber Goggles & Ear Antenna
    for (const side of [-1, 1]) {
      appendEllipsoid(out, hairRoot, Role.Metal, [side * 0.055, 0.215, 0.075], [0.032, 0.032, 0.026], sides);
      appendEllipsoid(out, hairRoot, Role.HairLight, [side * 0.055, 0.215, 0.092], [0.022, 0.022, 0.012], sides);
    }
    appendPanel(out, hairRoot, Role.SuitDark, [0, 0.185, 0.09], [0.18, 0.18, 0.032, 0.03], [0.18, 0, 0]);
    appendPanel(out, hairRoot, Role.Accent, [0.138, 0.128, -0.018], [0.008, 0.006, 0.085, 0.008], [-0.18, 0, 0.28]);
  } else {
    // ---- Axle (GLM / 盛唐俊杰) — Tang Dynasty Headband & Temple Comm ----
    // Styled short hair locks
    appendHairBlade(out, hairRoot, [0, 0.225, -0.01], 0.095, 0.05, 0.08, 0.085, [0.06, 0, 0], Role.Hair);
    appendHairBlade(out, hairRoot, [0.055, 0.21, -0.03], 0.068, 0.032, 0.065, 0.065, [0.06, 0.12, -0.14], Role.HairLight);
    appendHairBlade(out, hairRoot, [-0.055, 0.21, -0.03], 0.068, 0.032, 0.065, 0.065, [0.06, -0.12, 0.14], Role.HairLight);
    appendHairBlade(out, hairRoot, [0, 0.19, 0.085], 0.075, 0.035, 0.055, 0.045, [0.2, 0, 0], Role.Hair);
    // 3D Accessory: Tang Dynasty Cyber Headband with Central Jade Gem & Right Comm Rig
    appendPanel(out, hairRoot, Role.SuitDark, [0, 0.172, 0.092], [0.182, 0.182, 0.034, 0.036], [0.12, 0, 0]);
    appendPanel(out, hairRoot, Role.Accent, [0, 0.174, 0.126], [0.030, 0.030, 0.030, 0.022], [0.12, 0, 0]);
    appendEllipsoid(out, hairRoot, Role.Metal, [0.136, 0.095, 0.008], [0.018, 0.032, 0.018], sides);
  }

  const result = out.finish();
  const material = createToonMaterial({
    color: 0xffffff,
    vertexColors: true,
    rimColor: PALETTE.sparkle,
    rimStrength: 0.9,
    rimPower: 2.2,
    rimThreshold: 0.52,
    specColor: PALETTE.sparkle,
    specThreshold: 0.88,
  });
  material.name = 'RiderHairToon';
  material.uniforms.uShadowFloor.value.setHex(0x30284f, THREE.NoColorSpace);
  const mesh = new THREE.SkinnedMesh(result.geometry, material);
  mesh.name = 'rider-hair-skinned';
  mesh.userData.assetClass = 'authored-hair-accessory';
  mesh.userData.hairStyle = look.hairStyle;
  mesh.frustumCulled = false;
  object.add(mesh);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  mesh.normalizeSkinWeights();
  return { object, mesh, colorAttribute: result.colorAttribute, roles: result.roles, bones, head, detailed, style: look.hairStyle };
}

function disposeHairAccessory(accessory: HairAccessory): void {
  accessory.object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || child.userData.noOutline === true) return;
    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
    else mesh.material.dispose();
  });
  accessory.object.removeFromParent();
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

  // Pelvis and torso are authored lofts
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

  // Head and Neck base: Human character head with portrait-locked skin tone
  // +Z is face-forward in head-bone space.
  appendSegment(out, rig.chest, rig.head, 0.064, 0.054, Role.Skin, sides);
  const collarLocalInHead = new THREE.Matrix4().makeTranslation(0, -0.015, 0.005);
  const collarLocalInChest = new THREE.Matrix4()
    .copy(rig.chest.matrixWorld).invert()
    .multiply(rig.head.matrixWorld)
    .multiply(collarLocalInHead);
  out.append(new THREE.CylinderGeometry(0.068, 0.076, 0.055, sides, 1), rig.chest, Role.SuitDark, collarLocalInChest);
  const headSides = detailed ? 20 : 12;

  // 1. Natural Human Head Base (Skin Tone)
  appendEllipsoid(out, rig.head, Role.Skin, [0, 0.105, 0.015], [0.116, 0.134, 0.126], headSides);

  // 2. Stylized Anime Ears (Skin Tone)
  for (const side of [-1, 1]) {
    appendEllipsoid(out, rig.head, Role.Skin, [side * 0.118, 0.095, -0.005], [0.018, 0.032, 0.024], sides);
  }

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
  mesh.userData.paletteRoleCount = 10;
  root.add(mesh);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  mesh.normalizeSkinWeights();
  const hair = buildHairAccessory(rig.head, look, detailed);
  const faceMesh = buildFacePatch(rig.head, look);
  return { mesh, roles: result.roles, colorAttribute: result.colorAttribute, hair, faceMesh };
}

export function updateSkinnedRiderLook(skin: RiderSkin, color: number, look: RiderLook): void {
  const scratch = new THREE.Color();
  for (let i = 0; i < skin.roles.length; i++) {
    scratch.copy(roleColor(skin.roles[i] as Role, color, look));
    skin.colorAttribute.setXYZ(i, scratch.r, scratch.g, scratch.b);
  }
  skin.colorAttribute.needsUpdate = true;
  if (skin.hair.style !== look.hairStyle) {
    const next = buildHairAccessory(skin.hair.head, look, skin.hair.detailed);
    if (next.detailed) {
      addOutline(next.object, { width: 0.9 });
      markInk(next.object);
    } else {
      next.mesh.layers.enable(LAYER_INK);
    }
    disposeHairAccessory(skin.hair);
    skin.hair = next;
  }
  for (let i = 0; i < skin.hair.mesh.geometry.getAttribute('color').count; i++) {
    scratch.copy(roleColor(skin.hair.roles[i] as Role, color, look));
    skin.hair.colorAttribute.setXYZ(i, scratch.r, scratch.g, scratch.b);
  }
  skin.hair.colorAttribute.needsUpdate = true;

  if (skin.faceMesh) {
    const mat = skin.faceMesh.material as THREE.MeshBasicMaterial;
    mat.map = getOrCreateFaceTexture(look.driverId, look);
    mat.needsUpdate = true;
  }
}

export function updateHairAccessory(
  skin: RiderSkin,
  lean: number,
  airborne: number,
  flight: number,
  time: number,
): void {
  const bones = skin.hair.bones;
  if (bones.length < 2) return;
  const sway = Math.sin(time * 1.7) * 0.035 + lean * 0.16;
  const root = bones[0];
  root.rotation.set(-airborne * 0.08 + flight * 0.06, 0, sway);
  for (let i = 1; i < bones.length; i++) {
    const t = i / (bones.length - 1);
    const bone = bones[i];
    bone.rotation.set(
      (airborne * 0.1 + flight * 0.06) * t,
      Math.sin(time * 1.35 + i * 0.7) * 0.045 * t,
      sway * (0.35 + t),
    );
  }
}
