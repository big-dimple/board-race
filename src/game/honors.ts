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
  'target.comet': { title: '彗尾追击', detail: '追上移动彗星并留下尾焰', value: 135, color: 0x9b7cff },
  'flight.ace': { title: '空中王牌', detail: '完整通过一条飞行路线', value: 90, color: PALETTE.flight },
  'overtake.artist': { title: '超车艺术家', detail: '在关键门前完成一次超车', value: 75, color: PALETTE.uiAccent },
  'duo.assist': { title: '及时援手', detail: '淘汰席为队友送出支援', value: 80, color: PALETTE.uiAccent },
  'duo.intervention': { title: '浪花导演', detail: '用互动改变了队友的线路', value: 65, color: PALETTE.uiWarn },
  'comeback.sailor': { title: '逆风回航', detail: '落后后重新回到前三', value: 180, color: PALETTE.sunCore },
  'clean.run': { title: '清洁航线', detail: '整局没有撞击其他赛艇', value: 150, color: PALETTE.foam },
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
const TARGET_BASE_Y = 2.2;
const MAX_HIT_EVENTS = TARGET_LAYOUT.length * 6;

interface HonorTargetVisual {
  group: THREE.Group;
  ring: THREE.Mesh;
  core: THREE.Object3D;
  orbit: THREE.Group;
  x: number;
  z: number;
  y: number;
  kind: HonorTargetKind;
  phase: number;
  pulse: number;
  hitMask: number;
}

/**
 * Large, optional collision targets. They are presentation-rich but have no
 * physics authority: the boat remains the sole transform and collision truth.
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
  }));
  private eventCursor = 0;
  private hitCount = 0;

  constructor(private readonly course: ICourse) {
    this.object = new THREE.Group();
    this.object.name = 'honor-targets';
    this.buildTargets();
  }

  reset(): void {
    this.hitCount = 0;
    for (const target of this.targets) {
      target.hitMask = 0;
      target.pulse = 0;
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
        if (!racer || racer.eliminated || racer.finished) continue;
        if ((target.hitMask & (1 << boat.id)) !== 0) continue;
        const state = boat.state;
        if (Math.abs(state.speed) < 4 && !state.airborne) continue;
        const dx = state.position.x - target.x;
        const dz = state.position.z - target.z;
        if (dx * dx + dz * dz > TARGET_RADIUS * TARGET_RADIUS) continue;
        if (Math.abs(state.position.y - target.y) > 7.2) continue;
        target.hitMask |= 1 << boat.id;
        target.pulse = 1.25;
        const event = this.eventPool[this.eventCursor++ % this.eventPool.length];
        event.targetId = targetIndex;
        event.kind = target.kind;
        event.racerId = boat.id;
        event.value = HONOR_DEFINITIONS[`target.${target.kind}`]?.value ?? 100;
        event.at = time;
        event.x = state.position.x;
        event.y = state.position.y + 0.4;
        event.z = state.position.z;
        out.push(event);
        this.hitCount++;
      }
    }
  }

  debugState(): { targets: number; hits: number; visible: number } {
    let visible = 0;
    for (const target of this.targets) if (target.group.visible) visible++;
    return { targets: this.targets.length, hits: this.hitCount, visible };
  }

  private buildTargets(): void {
    const ringGeometry = new THREE.TorusGeometry(2.15, 0.18, 8, 28);
    const coreGeometry = new THREE.SphereGeometry(0.72, 12, 10);
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

      const ring = new THREE.Mesh(ringGeometry, materialFor(spec.kind));
      ring.name = 'honor-ring';
      ring.rotation.x = Math.PI / 2;
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
      group.add(core);

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
        kind: spec.kind,
        phase: spec.phase,
        pulse: 0,
        hitMask: 0,
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
