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

export type HonorTargetKind = 'duck' | 'ring' | 'bell' | 'star' | 'crown' | 'comet';

export interface HonorHit {
  targetId: number;
  kind: HonorTargetKind;
  racerId: number;
  value: number;
  at: number;
  x: number;
  y: number;
  z: number;
  /** Center = a deliberate ring-line, edge = a graze that only earns the accolade. */
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
  'target.duck': { title: '鸭鸭爆点', detail: '撞飞气球，触发大螺旋爆破', value: 120, color: PALETTE.hullKai },
  'target.ring': { title: '穿环快艇', detail: '贴着水面撞进发光环', value: 100, color: PALETTE.flight },
  'target.bell': { title: '海铃连响', detail: '把会摇摆的海铃撞到发声', value: 110, color: PALETTE.sunFlare },
  'target.star': { title: '浪尖摘星', detail: '在浪尖上拿到星标', value: 140, color: PALETTE.racingLine },
  'target.crown': { title: '王冠掠过', detail: '从王冠中心高速穿过', value: 160, color: PALETTE.hullPlayer },
  'target.center': { title: '舵轮掌舵', detail: '精准穿过环心，回收一格飞行能量', value: 180, color: PALETTE.uiAccent },
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
  { u: 0.075, lateral: 4.6, kind: 'duck', phase: 0.1 },
  { u: 0.185, lateral: -4.2, kind: 'ring', phase: 1.4 },
  { u: 0.305, lateral: 5.1, kind: 'bell', phase: 2.7 },
  { u: 0.435, lateral: -4.8, kind: 'star', phase: 3.8 },
  { u: 0.575, lateral: 4.3, kind: 'crown', phase: 4.9 },
  { u: 0.695, lateral: -5.2, kind: 'comet', phase: 6.0 },
  { u: 0.815, lateral: 4.1, kind: 'duck', phase: 7.1 },
  { u: 0.925, lateral: -3.8, kind: 'ring', phase: 8.3 },
];

const TARGET_RADIUS = 4.25;
// The pass-through opening is 2.5m clear; stay inside it to earn resources.
const TARGET_CENTER_RADIUS = 2.35;
const TARGET_MIN_FORWARD_ALIGN = 0.7;
const TARGET_BASE_Y = 3.45;
const MAX_HIT_EVENTS = TARGET_LAYOUT.length * 6;
const MAX_TARGET_RACERS = 8;

interface HonorTargetVisual {
  group: THREE.Group;
  ring: THREE.Mesh;
  core: THREE.Object3D;
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
  bestDistanceSq: Float32Array;
  bestForwardAlign: Float32Array;
  bestX: Float32Array;
  bestY: Float32Array;
  bestZ: Float32Array;
  bestAt: Float32Array;
}

/**
 * Large, optional collision targets. They are presentation-rich and emit a
 * deterministic center/edge result; the boat remains the sole transform and
 * collision truth while main applies the discrete center-line reward.
 */
export class HonorTargetSystem {
  readonly object: THREE.Group;
  private readonly targets: HonorTargetVisual[] = [];
  private readonly eventPool: HonorHit[] = Array.from({ length: MAX_HIT_EVENTS }, () => ({
    targetId: -1,
    kind: 'duck',
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

  constructor(private readonly course: ICourse) {
    this.object = new THREE.Group();
    this.object.name = 'honor-targets';
    this.buildTargets();
  }

  reset(): void {
    this.hitCount = 0;
    this.centerHitCount = 0;
    this.edgeHitCount = 0;
    for (const target of this.targets) {
      target.hitMask = 0;
      target.activeMask = 0;
      target.pulse = 0;
      target.bestDistanceSq.fill(Infinity);
      target.bestForwardAlign.fill(-1);
      target.group.visible = true;
      target.group.scale.setScalar(1);
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
    for (let targetIndex = 0; targetIndex < this.targets.length; targetIndex++) {
      const target = this.targets[targetIndex];
      target.phase += dt * (1.2 + targetIndex * 0.035);
      target.pulse = Math.max(0, target.pulse - dt * 2.4);
      const bob = Math.sin(target.phase * 1.7) * 0.22;
      target.y = waterHeight(target.x, target.z, time) + TARGET_BASE_Y + bob;
      target.group.position.y = target.y;
      target.ring.rotation.z += dt * (target.kind === 'comet' ? -1.9 : 1.15);
      target.core.rotation.y += dt * (target.kind === 'bell' ? 2.4 : 0.8);
      target.orbit.rotation.y -= dt * 1.6;
      const idlePulse = 1 + Math.sin(target.phase * 2.1) * 0.035;
      target.group.scale.setScalar(idlePulse + target.pulse * 0.2);
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
        const inChallenge = valid && distanceSq <= TARGET_RADIUS * TARGET_RADIUS;
        if (inChallenge) {
          const forwardAlign = Math.sin(state.heading) * target.forwardX + Math.cos(state.heading) * target.forwardZ;
          if ((target.activeMask & bit) === 0 || distanceSq < target.bestDistanceSq[slot]) {
            target.activeMask |= bit;
            target.bestDistanceSq[slot] = distanceSq;
            target.bestForwardAlign[slot] = forwardAlign;
            target.bestX[slot] = state.position.x;
            target.bestY[slot] = state.position.y + 0.4;
            target.bestZ[slot] = state.position.z;
            target.bestAt[slot] = time;
          }
          target.pulse = Math.max(target.pulse, 0.28);
          continue;
        }
        if ((target.activeMask & bit) === 0) continue;

        // Resolve after the boat exits the outer circle. The old one-frame
        // trigger rewarded the first edge contact, making a genuine centre
        // line indistinguishable from a graze.
        target.activeMask &= ~bit;
        target.hitMask |= bit;
        target.pulse = 1.25;
        const event = this.eventPool[this.eventCursor++ % this.eventPool.length];
        event.targetId = targetIndex;
        event.kind = target.kind;
        event.racerId = boat.id;
        event.value = HONOR_DEFINITIONS[`target.${target.kind}`]?.value ?? 100;
        event.at = target.bestAt[slot];
        event.x = target.bestX[slot];
        event.y = target.bestY[slot];
        event.z = target.bestZ[slot];
        event.precision = target.bestDistanceSq[slot] <= TARGET_CENTER_RADIUS * TARGET_CENTER_RADIUS &&
          target.bestForwardAlign[slot] >= TARGET_MIN_FORWARD_ALIGN
          ? 'center'
          : 'edge';
        out.push(event);
        this.hitCount++;
        if (event.precision === 'center') this.centerHitCount++;
        else this.edgeHitCount++;
        target.bestDistanceSq[slot] = Infinity;
        target.bestForwardAlign[slot] = -1;
      }
    }
  }

  debugState(): { targets: number; hits: number; centerHits: number; edgeHits: number; visible: number } {
    let visible = 0;
    for (const target of this.targets) if (target.group.visible) visible++;
    return {
      targets: this.targets.length,
      hits: this.hitCount,
      centerHits: this.centerHitCount,
      edgeHits: this.edgeHitCount,
      visible,
    };
  }

  debugTargets(): ReadonlyArray<{ index: number; kind: HonorTargetKind; x: number; z: number; forwardX: number; forwardZ: number }> {
    return this.targets.map((target, index) => ({
      index,
      kind: target.kind,
      x: target.x,
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
    const ringGeometry = new THREE.TorusGeometry(2.72, 0.22, 8, 32);
    const coreGeometry = new THREE.SphereGeometry(0.72, 12, 10);
    const gripGeometry = new THREE.BoxGeometry(0.25, 0.52, 0.2);
    const starGeometry = new THREE.OctahedronGeometry(0.95, 0);
    const stemGeometry = new THREE.CylinderGeometry(0.08, 0.14, 4.6, 8);
    const orbitGeometry = new THREE.SphereGeometry(0.14, 8, 6);
    const materials = new Map<HonorTargetKind, THREE.ShaderMaterial>();
    const materialFor = (kind: HonorTargetKind): THREE.ShaderMaterial => {
      const cached = materials.get(kind);
      if (cached) return cached;
      const color = HONOR_DEFINITIONS[`target.${kind}`]?.color ?? PALETTE.flight;
      const material = createToonMaterial({
        color,
        emissive: color,
        emissiveIntensity: kind === 'duck' ? 0.42 : 0.3,
        rimColor: PALETTE.foam,
        rimStrength: 0.72,
      });
      materials.set(kind, material);
      return material;
    };

    const inkMaterial = createToonMaterial({ color: PALETTE.ink });
    const beamMaterial = createToonMaterial({
      color: PALETTE.foam,
      emissive: PALETTE.flight,
      emissiveIntensity: 0.48,
      rimColor: PALETTE.flight,
      rimStrength: 0.65,
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
      // The target is a vertical, track-facing skill gate. The old horizontal
      // torus read as an inexplicable rack and made its centre impossible to
      // understand as a route choice.
      group.rotation.y = heading;

      const ring = new THREE.Mesh(ringGeometry, materialFor(spec.kind));
      ring.name = 'honor-ring';
      group.add(ring);

      const core = spec.kind === 'star'
        ? new THREE.Mesh(starGeometry, materialFor(spec.kind))
        : new THREE.Mesh(coreGeometry, materialFor(spec.kind));
      core.name = `honor-core-${spec.kind}`;
      if (spec.kind === 'duck') {
        core.scale.set(1.1, 0.82, 1.25);
        const bill = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.34, 8), materialFor(spec.kind));
        bill.rotation.x = Math.PI / 2;
        bill.position.set(0, 0.02, 0.77);
        core.add(bill);
      } else if (spec.kind === 'bell') {
        core.scale.set(0.9, 1.25, 0.9);
      } else if (spec.kind === 'crown') {
        core.scale.set(1.3, 0.68, 1.3);
      } else if (spec.kind === 'comet') {
        core.scale.set(0.8, 0.8, 1.5);
      }
      // Keep the collectible's identity on the rim instead of filling the
      // gate's pass-through opening. A player can now read the line before
      // committing to a detour.
      core.position.set(2.9, 0.46, 0);
      core.scale.multiplyScalar(0.72);
      group.add(core);

      // Four chunky grips make the crown target read as a helm while the centre
      // remains open for the actual precision pass.
      if (spec.kind === 'crown') {
        for (const angle of [0.48, Math.PI - 0.48, Math.PI + 0.48, -0.48]) {
          const grip = new THREE.Mesh(gripGeometry, beamMaterial);
          grip.name = 'technique-helm-grip';
          grip.position.set(Math.sin(angle) * 2.6, Math.cos(angle) * 2.6, 0);
          grip.rotation.z = angle;
          grip.userData.noOutline = true;
          group.add(grip);
        }
      }

      const stem = new THREE.Mesh(stemGeometry, inkMaterial);
      stem.name = 'honor-stem';
      stem.position.y = -2.15;
      group.add(stem);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.08, 4.0, 6), beamMaterial);
      beam.name = 'honor-beam';
      beam.position.y = -2.25;
      beam.userData.noOutline = true;
      group.add(beam);

      const orbit = new THREE.Group();
      orbit.name = 'honor-orbit';
      for (let orbitIndex = 0; orbitIndex < 3; orbitIndex++) {
        const orb = new THREE.Mesh(orbitGeometry, materialFor(spec.kind));
        const angle = orbitIndex * (Math.PI * 2 / 3);
        orb.position.set(Math.cos(angle) * 2.8, Math.sin(angle * 1.3) * 0.34, Math.sin(angle) * 2.8);
        orbit.add(orb);
      }
      group.add(orbit);

      addOutline(group, { width: 0.72 });
      markInk(group);
      this.object.add(group);
      this.targets.push({
        group,
        ring,
        core,
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
