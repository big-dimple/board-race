import * as THREE from 'three';
import type {
  HonorAward,
  HonorSummary,
  IBoat,
  ICourse,
  RacerState,
} from '../contracts';
import { PALETTE } from '../core/palette';
import { waterHeight } from '../water/waves';
import { createToonMaterial } from '../cel/toonMaterial';
import { addOutline } from '../cel/outline';
import { markInk } from '../contracts';
import { FLIGHT_ROUTES } from './course';
import { coinTextures, createCoinMaterial, setCoinSpin } from './coinVisual';

/** Coins are the only authored water prop. Retired kinds stay readable as legacy ids. */
export type HonorTargetKind = 'coin';

export interface HonorHit {
  targetId: number;
  kind: HonorTargetKind;
  racerId: number;
  value: number;
  at: number;
  x: number;
  y: number;
  z: number;
  /** Contact quality is retained for replay/netcode compatibility; every prop
   * awards the authored honor and never changes flight charge state. */
  precision: 'center' | 'edge';
}

export interface HonorHighlight {
  id: string;
  title: string;
  detail: string;
  racerId: number;
  count: number;
  score: number;
}

export interface HonorDefinition {
  title: string;
  detail: string;
  value: number;
  color: number;
}

/** Stable ids are deliberately protocol-safe: these are future server fields. */
export const HONOR_DEFINITIONS: Readonly<Record<string, HonorDefinition>> = {
  'target.coin': { title: '金币猎手', detail: '偏离主线撞取实体金币', value: 130, color: PALETTE.sunFlare },
  // Legacy ids remain readable in historical records; no new target uses
  // these props or the old ring/center-energy mechanic.
  'target.duck': { title: '鸭鸭爆点', detail: '历史版本荣誉记录', value: 120, color: PALETTE.hullKai },
  'target.ring': { title: '旧制穿环', detail: '历史版本荣誉记录', value: 100, color: PALETTE.flight },
  'target.bell': { title: '海铃连响', detail: '把会摇摆的海铃撞到发声', value: 110, color: PALETTE.sunFlare },
  'target.star': { title: '浪尖摘星', detail: '在浪尖上拿到星标', value: 140, color: PALETTE.racingLine },
  'target.crown': { title: '王冠掠过', detail: '从王冠中心高速穿过', value: 160, color: PALETTE.hullPlayer },
  'target.center': { title: '旧制精准线', detail: '历史版本荣誉记录', value: 180, color: PALETTE.uiAccent },
  'target.comet': { title: '彗尾追击', detail: '追上移动彗星并留下尾焰', value: 135, color: 0x9b7cff },
  'flight.ace': { title: '空中王牌', detail: '完整通过一条飞行路线', value: 90, color: PALETTE.flight },
  'overtake.artist': { title: '超车艺术家', detail: '在关键门前完成一次超车', value: 75, color: PALETTE.uiAccent },
  'duo.assist': { title: '及时援手', detail: '淘汰席为队友送出支援', value: 80, color: PALETTE.uiAccent },
  'duo.intervention': { title: '浪花导演', detail: '用互动改变了队友的线路', value: 65, color: PALETTE.uiWarn },
  'comeback.sailor': { title: '逆风回航', detail: '落后后重新回到前三', value: 180, color: PALETTE.sunCore },
  'clean.run': { title: '清洁航线', detail: '整局没有撞击其他赛艇', value: 150, color: PALETTE.foam },
  'finale.captain': { title: '终点船长', detail: '完成七飞并穿过 Final Station', value: 250, color: PALETTE.sunFlare },
} as const;

const TARGET_LAYOUT: readonly {
  u: number;
  lateral: number;
  kind: HonorTargetKind;
  phase: number;
}[] = [
  // Optional side-route props live in the authored surface sectors between
  // flight spans. Lateral offsets keep the racing line clear while making the
  // float and the collectible silhouette readable from the chase camera.
  // The former duck props are gone: a physical checkpoint buoy already pops a
  // rubber duck, so a second duck marker only muddied the honor prompt.
  // Two opposing coins replace the former start-line prop inside the broad
  // surface sector between flights one and two.
  { u: 0.155, lateral: -5.2, kind: 'coin', phase: 0.9 },
  { u: 0.215, lateral: 5.2, kind: 'coin', phase: 1.4 },
  { u: 0.33, lateral: -5.8, kind: 'coin', phase: 2.7 },
  { u: 0.49, lateral: 5.6, kind: 'coin', phase: 3.8 },
  { u: 0.607, lateral: -5.2, kind: 'coin', phase: 4.9 },
  { u: 0.882, lateral: -5.8, kind: 'coin', phase: 7.1 },
];

const TARGET_RADIUS = 4.65;
/** The start/finish at u=0 keeps a clean opening view in both directions. */
const COIN_START_CLEARANCE_U = 0.1;
// A generous contact radius makes the optional side route feel physical; the
// center/edge telemetry remains descriptive only.
const TARGET_CENTER_RADIUS = 2.8;
const TARGET_MIN_FORWARD_ALIGN = 0.7;
// Targets are water props, not airborne gates. Keep the root close to the
// hull's float plane so the silhouette reads as a buoy and never as a jump
// prompt. The small bob is visual only; collision still samples the live wave.
const TARGET_BASE_Y = 0.38;
const TARGET_BOB_AMPLITUDE = 0.12;
const MAX_TARGET_RACERS = 8;
const COIN_BURST_POOL_SIZE = 8;
const COIN_BURST_DURATION = 1.05;
/** World radius the ring starts at, and how far it travels over its 0.45s. */
const COIN_BURST_RING_START = 1.0;
const COIN_BURST_RING_TRAVEL = 2.4;
/** Local Y of the live water plane: the root sits TARGET_BASE_Y above it. */
const WATERLINE_Y = -TARGET_BASE_Y;
/** Radians of waterline tip per metre of height difference across the buoy. */
const WATERLINE_TILT = 0.38;
/** rad/s of the coin's mint-axis rotation; drives the milled-edge sweep. */
const COIN_SPIN_RATE = 0.62;
/** rad/s of the slow face-presenting turn that shows both minted sides. */
const COIN_PRESENT_RATE = 0.34;
// Keep the fixed event pool large enough for every supported racer to leave a
// target in the same fixed step. The live six-boat race uses fewer slots, but
// the contract is intentionally future-room safe for local/net replay probes.
const MAX_HIT_EVENTS = TARGET_LAYOUT.length * MAX_TARGET_RACERS;

function distanceFromStart(u: number): number {
  const wrapped = ((u % 1) + 1) % 1;
  return Math.min(wrapped, 1 - wrapped);
}

function radialShape(vertexCount: number, radiusAt: (index: number) => number): THREE.Shape {
  const shape = new THREE.Shape();
  for (let index = 0; index < vertexCount; index++) {
    const angle = Math.PI / 2 + index / vertexCount * Math.PI * 2;
    const radius = radiusAt(index);
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

interface HonorTargetVisual {
  group: THREE.Group;
  emblem: THREE.Object3D;
  float: THREE.Mesh;
  floatFoam: THREE.Mesh;
  /** Flat foam annulus pinned to the live water plane; the buoy's waterline. */
  waterline: THREE.Mesh;
  /** Additive gold bloom that keeps the marker readable at chase distance. */
  halo: THREE.Sprite;
  orbit: THREE.Group;
  x: number;
  z: number;
  y: number;
  forwardX: number;
  forwardZ: number;
  kind: HonorTargetKind;
  phase: number;
  pulse: number;
  hitMask: number;
  activeMask: number;
  flySlot: number;
  flyT: number;
  flyStartX: number;
  flyStartY: number;
  flyStartZ: number;
  bestDistanceSq: Float32Array;
  bestForwardAlign: Float32Array;
  bestX: Float32Array;
  bestY: Float32Array;
  bestZ: Float32Array;
  bestAt: Float32Array;
}

interface CoinBurstSlot {
  root: THREE.Group;
  ring: THREE.Sprite;
  flash: THREE.Sprite;
  rays: THREE.Sprite[];
  chips: THREE.Sprite[];
  ringMaterial: THREE.SpriteMaterial;
  rayMaterials: THREE.SpriteMaterial[];
  chipMaterials: THREE.SpriteMaterial[];
  flashMaterial: THREE.SpriteMaterial;
  life: number;
  baseY: number;
  strength: number;
}

/**
 * Large, optional collision targets. They are presentation-rich and emit a
 * deterministic center/edge telemetry; the boat remains the sole transform
 * and collision truth, and every contact awards only the authored honor.
 */
export class HonorTargetSystem {
  readonly object: THREE.Group;
  private readonly targets: HonorTargetVisual[] = [];
  private readonly coinBursts: CoinBurstSlot[] = [];
  private readonly eventPool: HonorHit[] = Array.from({ length: MAX_HIT_EVENTS }, () => ({
    targetId: -1,
    kind: 'coin',
    racerId: -1,
    value: 0,
    at: 0,
    x: 0,
    y: 0,
    z: 0,
    precision: 'edge',
  }));
  private eventCursor = 0;
  private hitCount = 0;
  private centerHitCount = 0;
  private edgeHitCount = 0;
  private coinBurstCursor = 0;
  private coinBurstCount = 0;
  private coinSpin = 0;

  constructor(private readonly course: ICourse) {
    this.object = new THREE.Group();
    this.object.name = 'honor-targets';
    this.buildTargets();
    this.buildCoinBursts();
  }

  reset(): void {
    this.hitCount = 0;
    this.centerHitCount = 0;
    this.edgeHitCount = 0;
    this.coinBurstCursor = 0;
    this.coinBurstCount = 0;
    this.coinSpin = 0;
    for (const target of this.targets) {
      target.hitMask = 0;
      target.activeMask = 0;
      target.pulse = 0;
      target.flySlot = -1;
      target.flyT = 0;
      target.flyStartX = target.x;
      target.flyStartY = target.y;
      target.flyStartZ = target.z;
      target.bestDistanceSq.fill(Infinity);
      target.bestForwardAlign.fill(-1);
      target.group.visible = true;
      target.group.position.set(target.x, target.y, target.z);
      target.group.scale.setScalar(1);
    }
    for (const burst of this.coinBursts) {
      burst.life = 0;
      burst.root.visible = false;
    }
  }

  /** Animate targets and emit deterministic hit events during a racing step. */
  update(
    dt: number,
    time: number,
    boats: readonly IBoat[],
    racers: readonly RacerState[],
    out: HonorHit[],
    detect = true,
  ): void {
    out.length = 0;
    this.eventCursor = 0;
    this.updateCoinBursts(dt);
    // Every coin shares one milled-edge sweep, so a single uniform write per
    // frame drives the travelling highlight on the whole set.
    this.coinSpin = (this.coinSpin + dt * COIN_SPIN_RATE) % (Math.PI * 4);
    setCoinSpin(this.coinSpin);
    for (let targetIndex = 0; targetIndex < this.targets.length; targetIndex++) {
      const target = this.targets[targetIndex];
      target.phase += dt * (1.2 + targetIndex * 0.035);
      target.pulse = Math.max(0, target.pulse - dt * 2.4);
      const bob = Math.sin(target.phase * 1.7) * TARGET_BOB_AMPLITUDE;
      target.y = waterHeight(target.x, target.z, time) + TARGET_BASE_Y + bob;
      if (target.flySlot < 0) {
        target.group.position.y = target.y;
      }
      const swayX = Math.sin(target.phase * 0.83) * 0.055;
      const swayZ = Math.cos(target.phase * 0.71) * 0.075;
      target.group.rotation.x = swayX;
      target.group.rotation.z = swayZ;
      // A struck coin turns on its own mint axis and presents its faces
      // slowly. The old three-axis wobble read as a dangling souvenir.
      target.emblem.rotation.y += dt * 3.8;
      target.emblem.rotation.z = 0;
      target.emblem.rotation.x = 0;
      target.float.rotation.z = Math.sin(target.phase * 0.92) * 0.14;
      target.floatFoam.rotation.z = Math.cos(target.phase * 0.86) * 0.12;
      target.floatFoam.position.y = WATERLINE_Y + 0.06 + Math.sin(target.phase * 1.7) * 0.05;
      target.orbit.rotation.y -= dt * 2.8;

      // The waterline foam must stay welded to the live surface even though
      // the mast above it sways. Cancel the parent sway, then tip the ring by
      // the local wave gradient so the buoy sits *in* the water, not on a
      // flat plate hovering over it.
      const gx = waterHeight(target.x + 1.3, target.z, time) - waterHeight(target.x - 1.3, target.z, time);
      const gz = waterHeight(target.x, target.z + 1.3, time) - waterHeight(target.x, target.z - 1.3, time);
      target.waterline.rotation.x = -swayX - gz * WATERLINE_TILT;
      target.waterline.rotation.z = -swayZ + gx * WATERLINE_TILT;
      target.waterline.position.y = WATERLINE_Y - bob;

      // The halo breathes against the idle pulse so the marker never reads as
      // a static decal at chase distance.
      const halo = 1 + Math.sin(target.phase * 1.9) * 0.09 + target.pulse * 0.5;
      target.halo.scale.set(3.4 * halo, 3.4 * halo, 1);

      const idlePulse = 1 + Math.sin(target.phase * 2.1) * 0.035;
      target.group.scale.setScalar(idlePulse + target.pulse * 0.2);

      // Magnetic collection arc: smoothly leap into the boat driver's head
      if (target.flySlot >= 0) {
        const flyingBoat = boats[target.flySlot];
        if (flyingBoat) {
          target.flyT = Math.min(1, target.flyT + dt / 0.32);
          const tVal = target.flyT;
          const easeT = tVal * tVal * (3 - 2 * tVal);
          const headX = flyingBoat.state.position.x;
          const headY = flyingBoat.state.position.y + 1.25;
          const headZ = flyingBoat.state.position.z;
          const midX = (target.flyStartX + headX) * 0.5;
          const midY = Math.max(target.flyStartY, headY) + 2.2;
          const midZ = (target.flyStartZ + headZ) * 0.5;
          const inv = 1 - easeT;
          target.group.position.x = inv * inv * target.flyStartX + 2 * inv * easeT * midX + easeT * easeT * headX;
          target.group.position.y = inv * inv * target.flyStartY + 2 * inv * easeT * midY + easeT * easeT * headY;
          target.group.position.z = inv * inv * target.flyStartZ + 2 * inv * easeT * midZ + easeT * easeT * headZ;
          target.emblem.rotation.y += dt * 18.0;
          target.group.scale.setScalar(Math.max(0.01, (idlePulse + target.pulse * 0.3) * (1 - easeT * 0.55)));

          // When coin completes flight arc and reaches the player cockpit
          if (tVal >= 1 && (target.hitMask & (1 << target.flySlot)) === 0) {
            const slot = target.flySlot;
            const bit = 1 << slot;
            target.hitMask |= bit;
            target.activeMask &= ~bit;
            target.pulse = 1.35;
            const event = this.eventPool[this.eventCursor++ % this.eventPool.length];
            event.targetId = targetIndex;
            event.kind = target.kind;
            event.racerId = flyingBoat.id;
            event.value = HONOR_DEFINITIONS[`target.${target.kind}`]?.value ?? 100;
            event.at = target.bestAt[slot] || time;
            event.x = headX;
            event.y = headY;
            event.z = headZ;
            const isCenter = target.bestDistanceSq[slot] <= TARGET_CENTER_RADIUS * TARGET_CENTER_RADIUS;
            event.precision = isCenter ? 'center' : 'edge';
            out.push(event);
            this.hitCount++;
            if (event.precision === 'center') this.centerHitCount++;
            else this.edgeHitCount++;
            target.group.visible = false;
            target.bestDistanceSq[slot] = Infinity;
            target.bestForwardAlign[slot] = -1;
          }
        }
      }

      if (!detect) continue;

      for (const boat of boats) {
        const racer = racers[boat.id];
        const slot = boat.id;
        if (slot < 0 || slot >= MAX_TARGET_RACERS) continue;
        const bit = 1 << slot;
        if (!racer || racer.eliminated || racer.finished) {
          target.activeMask &= ~bit;
          continue;
        }
        if ((target.hitMask & bit) !== 0) continue;
        const state = boat.state;
        const dx = state.position.x - target.x;
        const dz = state.position.z - target.z;
        const distanceSq = dx * dx + dz * dz;
        const valid = (Math.abs(state.speed) >= 4 || state.airborne) &&
          Math.abs(state.position.y - target.y) <= 7.2;

        // Lateral distance to the authored coin trajectory line
        const forwardAlign = Math.sin(state.heading) * target.forwardX + Math.cos(state.heading) * target.forwardZ;
        const lateralDist = Math.abs((state.position.x - target.x) * target.forwardZ - (state.position.z - target.z) * target.forwardX);
        if (target.bestDistanceSq[slot] === Infinity || lateralDist * lateralDist < target.bestDistanceSq[slot]) {
          target.bestDistanceSq[slot] = lateralDist * lateralDist;
          target.bestForwardAlign[slot] = forwardAlign;
          target.bestX[slot] = state.position.x;
          target.bestY[slot] = state.position.y + 0.4;
          target.bestZ[slot] = state.position.z;
          target.bestAt[slot] = time;
        }

        // Long-range magnetic attraction (18m approach when heading toward the coin)
        const toTargetX = target.x - state.position.x;
        const toTargetZ = target.z - state.position.z;
        const boatDirX = Math.sin(state.heading);
        const boatDirZ = Math.cos(state.heading);
        const dotHeading = (toTargetX * boatDirX + toTargetZ * boatDirZ) / (Math.hypot(toTargetX, toTargetZ) || 1);

        if (valid && distanceSq <= 18.0 * 18.0 && dotHeading > 0.15) {
          if (target.flySlot < 0 && (target.hitMask & bit) === 0) {
            target.flySlot = boat.id;
            target.flyT = 0;
            target.flyStartX = target.x;
            target.flyStartY = target.y;
            target.flyStartZ = target.z;
          }
        }

        const inChallenge = valid && distanceSq <= TARGET_RADIUS * TARGET_RADIUS;
        if (inChallenge) {
          target.pulse = Math.max(target.pulse, 0.28);
          // If boat is directly inside contact zone and hasn't started flying yet
          if (target.flySlot < 0 && (target.hitMask & bit) === 0) {
            target.flySlot = boat.id;
            target.flyT = 0;
            target.flyStartX = target.x;
            target.flyStartY = target.y;
            target.flyStartZ = target.z;
          }
        }
      }
    }
  }

  /** Play a fixed-pool gold burst without changing target ownership or rewards. */
  presentHitFx(hit: HonorHit): void {
    if (this.coinBursts.length === 0) return;
    const slot = this.coinBursts[this.coinBurstCursor++ % this.coinBursts.length];
    const target = this.targets[hit.targetId];
    slot.life = COIN_BURST_DURATION;
    // The contact sample is at hull height. Resolve the target's authored
    // emblem height so the expanding ring frames the minted face rather than
    // reading as a second ring around the float.
    slot.baseY = target ? target.y + 1.1 : hit.y + 0.92;
    slot.strength = hit.precision === 'center' ? 1.08 : 0.9;
    slot.root.visible = true;
    // Pull the burst a fraction toward the approaching boat so the readable
    // ring/chips sit in front of the marker instead of disappearing inside it.
    const forwardX = target?.forwardX ?? 0;
    const forwardZ = target?.forwardZ ?? 1;
    slot.root.position.set(hit.x - forwardX * 0.42, slot.baseY, hit.z - forwardZ * 0.42);
    // No authored rotation: the sprites billboard per camera and the burst
    // layout is radial, so orienting the root would only spin the chips.
    slot.root.rotation.set(0, 0, 0);
    slot.root.scale.setScalar(slot.strength);
    this.applyCoinBurst(slot);
    this.coinBurstCount++;
  }

  /**
   * The burst is built from Sprites rather than meshes. Sprites billboard in
   * the vertex shader against whichever camera is drawing them, so the dual
   * split-screen windows each get a correctly facing effect from the same
   * world object — a manual billboard would have to pick one camera and show
   * the other a ring seen edge-on.
   */
  private buildCoinBursts(): void {
    const maps = coinTextures();

    for (let burstIndex = 0; burstIndex < COIN_BURST_POOL_SIZE; burstIndex++) {
      const root = new THREE.Group();
      root.name = `honor-coin-burst-${burstIndex + 1}`;
      root.visible = false;
      root.renderOrder = 12;

      const spriteMaterial = (map: THREE.Texture, color: number, additive: boolean): THREE.SpriteMaterial =>
        new THREE.SpriteMaterial({
          map,
          color,
          transparent: true,
          opacity: 0,
          blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        });

      // The ring is a soft annulus, not a tube: it expands as a pressure wave
      // with falloff on both lips instead of reading as a hard wire hoop.
      const ringMaterial = spriteMaterial(maps.ring, PALETTE.sunFlare, false);
      const flashMaterial = spriteMaterial(maps.spark, PALETTE.sparkle, true);
      const ring = new THREE.Sprite(ringMaterial);
      ring.name = 'honor-coin-burst-ring';
      const flash = new THREE.Sprite(flashMaterial);
      flash.name = 'honor-coin-burst-flash';
      root.add(ring, flash);

      // Radial streaks. Each keeps its own material so its in-plane rotation
      // can point outward from the coin face.
      const rayMaterials: THREE.SpriteMaterial[] = [];
      const rays: THREE.Sprite[] = [];
      for (let rayIndex = 0; rayIndex < 8; rayIndex++) {
        const rayMaterial = spriteMaterial(maps.spark, PALETTE.sunCore, true);
        const ray = new THREE.Sprite(rayMaterial);
        ray.name = 'honor-coin-burst-ray';
        ray.center.set(0.5, 0);
        root.add(ray);
        rays.push(ray);
        rayMaterials.push(rayMaterial);
      }

      // Torn metal flakes. The sprite never turns edge-on, so the flip is
      // faked by squeezing its width through zero — the same trick arcade
      // shards use, and it costs nothing compared to real tumbling geometry.
      const chipMaterials: THREE.SpriteMaterial[] = [];
      const chips: THREE.Sprite[] = [];
      for (let chipIndex = 0; chipIndex < 10; chipIndex++) {
        const chipMaterial = spriteMaterial(maps.shard, PALETTE.sunFlare, false);
        const chip = new THREE.Sprite(chipMaterial);
        chip.name = 'honor-coin-burst-chip';
        root.add(chip);
        chips.push(chip);
        chipMaterials.push(chipMaterial);
      }

      this.object.add(root);
      this.coinBursts.push({
        root,
        ring,
        flash,
        rays,
        chips,
        ringMaterial,
        rayMaterials,
        chipMaterials,
        flashMaterial,
        life: 0,
        baseY: 0,
        strength: 1,
      });
    }
  }

  private applyCoinBurst(slot: CoinBurstSlot): void {
    slot.ringMaterial.opacity = 0.95;
    slot.flashMaterial.opacity = 1;
    // Start just inside the coin rim, then clear the silhouette within the
    // first beat so the pickup reads as a deliberate minted-ring snap.
    const ringSize = COIN_BURST_RING_START * 2;
    slot.ring.scale.set(ringSize, ringSize, 1);
    const flashSize = 1.1;
    slot.flash.scale.set(flashSize, flashSize, 1);
    for (let index = 0; index < slot.rays.length; index++) {
      slot.rays[index].position.set(0, 0, 0);
      slot.rayMaterials[index].opacity = 1;
      slot.rayMaterials[index].rotation = index * Math.PI / 4;
    }
    for (let index = 0; index < slot.chips.length; index++) {
      slot.chips[index].position.set(0, 0, 0);
      slot.chipMaterials[index].opacity = 1;
    }
  }

  private updateCoinBursts(dt: number): void {
    for (const slot of this.coinBursts) {
      if (slot.life <= 0) continue;
      slot.life = Math.max(0, slot.life - dt);
      if (slot.life <= 0) {
        slot.root.visible = false;
        slot.ringMaterial.opacity = 0;
        slot.flashMaterial.opacity = 0;
        for (const material of slot.rayMaterials) material.opacity = 0;
        for (const material of slot.chipMaterials) material.opacity = 0;
        continue;
      }
      const progress = 1 - slot.life / COIN_BURST_DURATION;
      // Three separate clocks: the flash is a 2-frame punch, the ring and rays
      // are the 0.45s shockwave, and the chips carry the full second. A single
      // shared curve makes all three read as one mushy blob.
      const ringT = Math.min(1, progress / 0.45);
      const ringEase = 1 - Math.pow(1 - ringT, 3);
      const flashT = Math.min(1, progress / 0.18);
      const chipT = Math.max(0, (progress - 0.04) / 0.96);

      slot.root.position.y = slot.baseY + Math.sin(Math.min(1, progress) * Math.PI) * 0.08;

      // Ring: a pressure wave that thins as it grows.
      const ringRadius = COIN_BURST_RING_START + ringEase * COIN_BURST_RING_TRAVEL;
      const ringSize = ringRadius * 2;
      slot.ring.scale.set(ringSize, ringSize, 1);
      slot.ringMaterial.opacity = Math.pow(1 - ringT, 1.5) * 0.95;

      // Flash: hard pop, gone before the ring has travelled a coin width.
      const flashSize = 1.1 + flashT * 3.4;
      slot.flash.scale.set(flashSize, flashSize, 1);
      slot.flashMaterial.opacity = Math.pow(1 - flashT, 2.2);

      // Rays: stretched outward, thinning as they go.
      const rayRadius = 0.9 + ringEase * (COIN_BURST_RING_TRAVEL + 0.5);
      for (let index = 0; index < slot.rays.length; index++) {
        const material = slot.rayMaterials[index];
        const angle = index * Math.PI / 4 + ringT * 0.5;
        slot.rays[index].position.set(Math.cos(angle) * rayRadius, Math.sin(angle) * rayRadius, 0);
        material.rotation = angle - Math.PI / 2;
        const length = 1.5 * (1 - ringT * 0.55);
        slot.rays[index].scale.set(0.34 * (1 - ringT * 0.5), length, 1);
        material.opacity = Math.pow(1 - ringT, 1.4) * 0.9;
      }

      // Chips: real 3D ballistic arc, with the flip faked by squeezing width.
      const chipEase = 1 - Math.pow(1 - chipT, 2.4);
      for (let index = 0; index < slot.chips.length; index++) {
        const chip = slot.chips[index];
        const material = slot.chipMaterials[index];
        const lane = index / slot.chips.length;
        const angle = lane * Math.PI * 2 + chipT * (1.5 + (index % 3) * 0.5);
        const radius = 0.5 + chipEase * (1.5 + (index % 4) * 0.24);
        const launch = 0.5 + (index % 3) * 0.22;
        const height = Math.sin(chipT * Math.PI) * launch - chipT * chipT * 0.9;
        chip.position.set(Math.cos(angle) * radius, height, Math.sin(angle) * radius * 0.5);
        // Squeeze the width through zero twice: a torn flake turning over.
        const flip = Math.cos(chipT * (7 + index * 0.6));
        const size = (0.62 + (index % 3) * 0.14) * (1 - chipT * 0.3);
        chip.scale.set(size * flip, size, 1);
        material.opacity = Math.pow(1 - chipT, 0.8);
      }
    }
  }

  debugState(): {
    targets: number;
    hits: number;
    centerHits: number;
    edgeHits: number;
    visible: number;
    coinBursts: number;
    activeCoinBursts: number;
    surfaceLayoutValid: boolean;
  } {
    let visible = 0;
    for (const target of this.targets) if (target.group.visible) visible++;
    return {
      targets: this.targets.length,
      hits: this.hitCount,
      centerHits: this.centerHitCount,
      edgeHits: this.edgeHitCount,
      visible,
      coinBursts: this.coinBurstCount,
      activeCoinBursts: this.coinBursts.reduce((count, burst) => count + (burst.life > 0 ? 1 : 0), 0),
      surfaceLayoutValid: TARGET_LAYOUT.every((spec) => !FLIGHT_ROUTES.some((route) => spec.u >= route.entryU && spec.u <= route.exitU)),
    };
  }

  debugTargets(): ReadonlyArray<{
    index: number;
    u: number;
    kind: HonorTargetKind;
    lateral: number;
    x: number;
    y: number;
    z: number;
    forwardX: number;
    forwardZ: number;
  }> {
    return this.targets.map((target, index) => ({
      index,
      u: TARGET_LAYOUT[index].u,
      kind: target.kind,
      lateral: TARGET_LAYOUT[index].lateral,
      x: target.x,
      y: target.y,
      z: target.z,
      forwardX: target.forwardX,
      forwardZ: target.forwardZ,
    }));
  }

  hasNearbyUnclaimedTarget(boat: IBoat, radius = 38): boolean {
    const slot = boat.id;
    if (slot < 0 || slot >= MAX_TARGET_RACERS) return false;
    const bit = 1 << slot;
    const limitSq = radius * radius;
    for (const target of this.targets) {
      if ((target.hitMask & bit) !== 0) continue;
      const dx = boat.state.position.x - target.x;
      const dz = boat.state.position.z - target.z;
      if (dx * dx + dz * dz <= limitSq) return true;
    }
    return false;
  }

  private buildTargets(): void {
    for (const spec of TARGET_LAYOUT) {
      if (FLIGHT_ROUTES.some((route) => spec.u >= route.entryU && spec.u <= route.exitU)) {
        throw new Error(`honor target ${spec.kind} is inside a flight span at u=${spec.u}`);
      }
      if (distanceFromStart(spec.u) < COIN_START_CLEARANCE_U) {
        throw new Error(`honor coin is inside the start/finish buffer at u=${spec.u}`);
      }
    }
    // Streamlined iconic 3D Gold Coin with embossed star crest and beveled rim
    const coinCoreGeometry = new THREE.CylinderGeometry(1.05, 1.05, 0.26, 32);
    coinCoreGeometry.rotateX(Math.PI / 2);
    const coinFaceGeometry = new THREE.CylinderGeometry(0.88, 0.88, 0.06, 32);
    coinFaceGeometry.rotateX(Math.PI / 2);
    const coinRimGeometry = new THREE.TorusGeometry(0.96, 0.09, 8, 32);
    const coinGrooveGeometry = new THREE.TorusGeometry(0.72, 0.03, 6, 28);
    const coinHighlightGeometry = new THREE.TorusGeometry(0.82, 0.04, 6, 18, Math.PI * 0.6);
    const coinStampGeometry = new THREE.ShapeGeometry(radialShape(8, (index) => index % 2 === 0 ? 0.54 : 0.22));
    const coinStampHubGeometry = new THREE.CircleGeometry(0.15, 14);
    const coinMiniGeometry = new THREE.CylinderGeometry(0.2, 0.2, 0.06, 12);
    coinMiniGeometry.rotateX(Math.PI / 2);
    const coinGlintGeometry = new THREE.OctahedronGeometry(0.25, 0);

    // Flat foam annulus pinned to the live water plane.
    const waterlineGeometry = new THREE.RingGeometry(1.05, 1.85, 24, 1);
    waterlineGeometry.rotateX(-Math.PI / 2);

    const beamMaterial = createToonMaterial({
      color: PALETTE.foam,
      emissive: PALETTE.flight,
      emissiveIntensity: 0.48,
      rimColor: PALETTE.flight,
      rimStrength: 0.65,
    });
    const floatMaterial = createToonMaterial({
      color: PALETTE.foam,
      emissive: PALETTE.flight,
      emissiveIntensity: 0.2,
      rimColor: PALETTE.ink,
      rimStrength: 0.4,
    });
    // The milled outer band is where the coin actually reads as struck metal:
    // full anisotropic sweep, 48 lobes, and deep gold that stays saturated in shade.
    const coinEdgeMaterial = createCoinMaterial({
      color: PALETTE.sunFlare,
      deep: 0xa8660c,
      milled: 1,
      lobes: 48,
      specColor: PALETTE.sparkle,
      spec1: 0.86,
      rimColor: PALETTE.sunCore,
      rimStrength: 0.42,
      rimThreshold: 0.6,
    });
    // The face is polished with a gleaming golden sheen.
    const coinFaceMaterial = createCoinMaterial({
      color: PALETTE.sunCore,
      deep: 0xd9a12a,
      milled: 0.3,
      lobes: 12,
      specColor: PALETTE.sparkle,
      spec1: 0.93,
      rimColor: PALETTE.foam,
      rimStrength: 0.3,
      rimThreshold: 0.66,
    });
    const coinRimMaterial = createCoinMaterial({
      color: 0xffdc63,
      deep: 0xb0760f,
      milled: 0.72,
      lobes: 32,
      specColor: PALETTE.sparkle,
      spec1: 0.88,
      rimColor: PALETTE.sunCore,
      rimStrength: 0.46,
      rimThreshold: 0.56,
    });
    // The stamp is recessed: darker than the face with almost no specular.
    const coinStampMaterial = createCoinMaterial({
      color: 0x8c5a08,
      deep: 0x4d3006,
      milled: 0,
      specColor: PALETTE.sunFlare,
      spec1: 0.985,
      rimColor: PALETTE.sunCore,
      rimStrength: 0.22,
      rimThreshold: 0.7,
    });
    const coinHighlightMaterial = createCoinMaterial({
      color: PALETTE.foam,
      deep: PALETTE.sunCore,
      milled: 0,
      specColor: PALETTE.sparkle,
      spec1: 0.9,
      rimColor: PALETTE.foam,
      rimStrength: 0.3,
      rimThreshold: 0.5,
    });
    const waterlineMaterial = new THREE.MeshBasicMaterial({
      color: PALETTE.foam,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });

    for (let index = 0; index < TARGET_LAYOUT.length; index++) {
      const spec = TARGET_LAYOUT[index];
      const point = new THREE.Vector3();
      const tangent = new THREE.Vector3();
      this.course.pointAt(spec.u, point);
      this.course.tangentAt(spec.u, tangent);
      const rightX = tangent.z;
      const rightZ = -tangent.x;
      const x = point.x + rightX * spec.lateral;
      const z = point.z + rightZ * spec.lateral;
      const group = new THREE.Group();
      group.name = `honor-target-${index + 1}`;
      group.position.set(x, waterHeight(x, z, 0) + TARGET_BASE_Y, z);
      const heading = Math.atan2(tangent.x, tangent.z);
      group.rotation.y = heading;

      const emblem = new THREE.Group();
      emblem.name = `honor-emblem-${spec.kind}`;
      const coin = new THREE.Mesh(coinCoreGeometry, coinEdgeMaterial);
      coin.name = 'honor-coin-core';
      emblem.add(coin);

      for (const side of [-1, 1]) {
        const faceZ = side * 0.13;
        const face = new THREE.Mesh(coinFaceGeometry, coinFaceMaterial);
        face.name = 'honor-coin-face';
        face.position.z = faceZ;
        face.userData.noOutline = true;
        emblem.add(face);

        const rim = new THREE.Mesh(coinRimGeometry, coinRimMaterial);
        rim.name = 'honor-coin-rim';
        rim.position.z = side * 0.135;
        emblem.add(rim);

        const groove = new THREE.Mesh(coinGrooveGeometry, coinStampMaterial);
        groove.name = 'honor-coin-groove';
        groove.position.z = side * 0.138;
        groove.userData.noOutline = true;
        emblem.add(groove);

        const stamp = new THREE.Mesh(coinStampGeometry, coinStampMaterial);
        stamp.name = 'honor-coin-stamp';
        stamp.position.z = side * 0.142;
        if (side < 0) stamp.rotation.y = Math.PI;
        stamp.userData.noOutline = true;
        emblem.add(stamp);

        const stampHub = new THREE.Mesh(coinStampHubGeometry, coinRimMaterial);
        stampHub.name = 'honor-coin-stamp-hub';
        stampHub.position.z = side * 0.145;
        if (side < 0) stampHub.rotation.y = Math.PI;
        stampHub.userData.noOutline = true;
        emblem.add(stampHub);

        const highlight = new THREE.Mesh(coinHighlightGeometry, coinHighlightMaterial);
        highlight.name = 'honor-coin-highlight';
        highlight.position.z = side * 0.148;
        highlight.rotation.z = side > 0 ? 0.56 : -2.58;
        if (side < 0) highlight.rotation.y = Math.PI;
        highlight.userData.noOutline = true;
        emblem.add(highlight);
      }

      // Float coin cleanly above the water
      emblem.position.set(0, 0.52, 0);
      emblem.scale.setScalar(1.0);
      group.add(emblem);

      // Lightweight underwater keel anchor
      const float = new THREE.Mesh(coinMiniGeometry, floatMaterial);
      float.name = 'honor-float';
      float.position.y = -0.22;
      float.visible = false;
      group.add(float);
      const floatFoam = new THREE.Mesh(coinMiniGeometry, beamMaterial);
      floatFoam.name = 'honor-float-foam';
      floatFoam.visible = false;
      group.add(floatFoam);

      const waterline = new THREE.Mesh(waterlineGeometry, waterlineMaterial);
      waterline.name = 'honor-waterline-foam';
      waterline.position.y = WATERLINE_Y;
      waterline.renderOrder = 3;
      waterline.userData.noInk = true;
      waterline.userData.noOutline = true;
      waterline.layers.set(0);
      group.add(waterline);

      // Golden ambient halo sprite
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: coinTextures().spark,
        color: PALETTE.sunFlare,
        transparent: true,
        opacity: 0.52,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }));
      halo.name = 'honor-halo';
      halo.scale.set(3.8, 3.8, 1);
      halo.position.y = 0.52;
      halo.renderOrder = 8;
      halo.userData.noInk = true;
      halo.userData.noOutline = true;
      halo.layers.set(0);
      group.add(halo);

      // Orbiting sparkle particles
      const orbit = new THREE.Group();
      orbit.name = 'honor-orbit';
      const orbitCount = 4;
      for (let orbitIndex = 0; orbitIndex < orbitCount; orbitIndex++) {
        const isCoinChip = orbitIndex % 2 === 0;
        const orb = new THREE.Mesh(
          isCoinChip ? coinMiniGeometry : coinGlintGeometry,
          isCoinChip ? coinRimMaterial : coinHighlightMaterial,
        );
        orb.name = isCoinChip ? 'honor-orbit-coin' : 'honor-coin-glint';
        orb.userData.noOutline = true;
        const angle = orbitIndex * (Math.PI * 2 / orbitCount);
        orb.position.set(Math.cos(angle) * 2.0, 0.52 + Math.sin(angle * 1.3) * 0.28, Math.sin(angle) * 2.0);
        orbit.add(orb);
      }
      group.add(orbit);

      addOutline(group, { width: 0.65 });
      markInk(group);
      this.object.add(group);
      this.targets.push({
        group,
        emblem,
        float,
        floatFoam,
        waterline,
        halo,
        orbit,
        x,
        z,
        y: group.position.y,
        forwardX: tangent.x,
        forwardZ: tangent.z,
        kind: spec.kind,
        phase: spec.phase,
        pulse: 0,
        hitMask: 0,
        activeMask: 0,
        flySlot: -1,
        flyT: 0,
        flyStartX: x,
        flyStartY: group.position.y,
        flyStartZ: z,
        bestDistanceSq: Float32Array.from({ length: MAX_TARGET_RACERS }, () => Infinity),
        bestForwardAlign: Float32Array.from({ length: MAX_TARGET_RACERS }, () => -1),
        bestX: new Float32Array(MAX_TARGET_RACERS),
        bestY: new Float32Array(MAX_TARGET_RACERS),
        bestZ: new Float32Array(MAX_TARGET_RACERS),
        bestAt: new Float32Array(MAX_TARGET_RACERS),
      });
    }
  }
}

/** Per-run ledger. It is intentionally independent of rendering and netcode. */
export class HonorLedger {
  private readonly countsByRacer: Array<Record<string, number>> = [];
  private readonly scoresByRacer: number[] = [];
  private readonly awards: HonorAward[] = [];
  private readonly racerIds = new Set<number>();

  constructor(racerCount = 6) {
    this.resize(racerCount);
  }

  reset(racerCount = this.countsByRacer.length || 6): void {
    this.resize(racerCount);
    for (const counts of this.countsByRacer) {
      for (const id of Object.keys(counts)) delete counts[id];
    }
    this.scoresByRacer.fill(0);
    this.awards.length = 0;
    this.racerIds.clear();
  }

  award(id: string, racerId: number, value: number | undefined, at: number): void {
    const definition = HONOR_DEFINITIONS[id];
    if (!definition || !Number.isInteger(racerId) || racerId < 0 || racerId >= this.countsByRacer.length) return;
    const points = Math.max(1, Math.round(value ?? definition.value));
    const counts = this.countsByRacer[racerId];
    counts[id] = (counts[id] ?? 0) + 1;
    this.scoresByRacer[racerId] += points;
    this.racerIds.add(racerId);
    if (this.awards.length < 128) this.awards.push({ id, racerId, value: points, at: Math.max(0, at) });
  }

  addTargetHit(hit: HonorHit): void {
    this.award(`target.${hit.kind}`, hit.racerId, hit.value, hit.at);
  }

  scoreFor(racerId: number): number {
    return this.scoresByRacer[racerId] ?? 0;
  }

  countFor(racerId: number, id: string): number {
    return this.countsByRacer[racerId]?.[id] ?? 0;
  }

  summaryFor(racerIds: readonly number[]): HonorSummary {
    const selected = new Set(racerIds);
    const counts: Record<string, number> = {};
    let score = 0;
    for (const racerId of racerIds) {
      score += this.scoresByRacer[racerId] ?? 0;
      for (const [id, count] of Object.entries(this.countsByRacer[racerId] ?? {})) {
        counts[id] = (counts[id] ?? 0) + count;
      }
    }
    return {
      score,
      counts,
      awards: this.awards.filter((award) => selected.has(award.racerId)).map((award) => ({ ...award })),
    };
  }

  highlightCards(racerIds: readonly number[], racerNames: readonly string[], max = 4): HonorHighlight[] {
    const cards: HonorHighlight[] = [];
    for (const [id, definition] of Object.entries(HONOR_DEFINITIONS)) {
      let bestRacer = -1;
      let bestCount = 0;
      for (const racerId of racerIds) {
        const count = this.countFor(racerId, id);
        if (count > bestCount) {
          bestCount = count;
          bestRacer = racerId;
        }
      }
      if (bestRacer < 0 || bestCount <= 0) continue;
      cards.push({
        id,
        title: definition.title,
        detail: `${racerNames[bestRacer] ?? `选手 ${bestRacer + 1}`} · ${definition.detail}`,
        racerId: bestRacer,
        count: bestCount,
        // The card is an accolade, so its points describe this accolade rather
        // than repeating the racer's all-in total on every card.
        score: bestCount * definition.value,
      });
    }
    cards.sort((a, b) => (b.count * 1000 + b.score) - (a.count * 1000 + a.score));
    return cards.slice(0, max);
  }

  debugState(): { score: number; awardCount: number; racers: number } {
    let score = 0;
    for (const value of this.scoresByRacer) score += value;
    return { score, awardCount: this.awards.length, racers: this.racerIds.size };
  }

  private resize(racerCount: number): void {
    const count = Math.max(1, Math.floor(racerCount));
    while (this.countsByRacer.length < count) this.countsByRacer.push({});
    while (this.scoresByRacer.length < count) this.scoresByRacer.push(0);
    if (this.countsByRacer.length > count) this.countsByRacer.length = count;
    if (this.scoresByRacer.length > count) this.scoresByRacer.length = count;
  }
}
