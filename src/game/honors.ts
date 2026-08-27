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
  'target.duck': { title: '鸭鸭爆点', detail: '撞飞气球，触发大螺旋爆破', value: 120, color: PALETTE.hullKai },
  // Legacy ids remain readable in historical records; no new target uses the
  // ring or center-energy mechanic.
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
  { u: 0.045, lateral: -5.4, kind: 'duck', phase: 0.1 },
  { u: 0.185, lateral: 5.2, kind: 'bell', phase: 1.4 },
  { u: 0.33, lateral: -5.8, kind: 'star', phase: 2.7 },
  { u: 0.49, lateral: 5.6, kind: 'crown', phase: 3.8 },
  { u: 0.607, lateral: -5.2, kind: 'comet', phase: 4.9 },
  { u: 0.748, lateral: 5.5, kind: 'duck', phase: 6.0 },
  { u: 0.882, lateral: -5.8, kind: 'bell', phase: 7.1 },
  { u: 0.99, lateral: 5.1, kind: 'star', phase: 8.3 },
];

const TARGET_RADIUS = 4.65;
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
// Keep the fixed event pool large enough for every supported racer to leave a
// target in the same fixed step. The live six-boat race uses fewer slots, but
// the contract is intentionally future-room safe for local/net replay probes.
const MAX_HIT_EVENTS = TARGET_LAYOUT.length * MAX_TARGET_RACERS;

interface HonorTargetVisual {
  group: THREE.Group;
  emblem: THREE.Object3D;
  float: THREE.Mesh;
  floatFoam: THREE.Mesh;
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
 * deterministic center/edge telemetry; the boat remains the sole transform
 * and collision truth, and every contact awards only the authored honor.
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
      const bob = Math.sin(target.phase * 1.7) * TARGET_BOB_AMPLITUDE;
      target.y = waterHeight(target.x, target.z, time) + TARGET_BASE_Y + bob;
      target.group.position.y = target.y;
      target.group.rotation.x = Math.sin(target.phase * 0.83) * 0.055;
      target.group.rotation.z = Math.cos(target.phase * 0.71) * 0.075;
      target.emblem.rotation.z += dt * (target.kind === 'comet' ? -0.45 : 0.24);
      target.emblem.rotation.x = Math.sin(target.phase * 1.3) * 0.06;
      target.float.rotation.z = Math.sin(target.phase * 0.92) * 0.14;
      target.floatFoam.rotation.z = Math.cos(target.phase * 0.86) * 0.12;
      target.floatFoam.position.y = -0.3 + Math.sin(target.phase * 1.7) * 0.05;
      target.emblem.rotation.y += dt * (target.kind === 'bell' ? 2.4 : 0.8);
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

  debugState(): { targets: number; hits: number; centerHits: number; edgeHits: number; visible: number; surfaceLayoutValid: boolean } {
    let visible = 0;
    for (const target of this.targets) if (target.group.visible) visible++;
    return {
      targets: this.targets.length,
      hits: this.hitCount,
      centerHits: this.centerHitCount,
      edgeHits: this.edgeHitCount,
      visible,
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
    }
    const coreGeometry = new THREE.SphereGeometry(0.82, 16, 12);
    const gripGeometry = new THREE.BoxGeometry(0.28, 0.58, 0.24);
    const starGeometry = new THREE.OctahedronGeometry(1.22, 0);
    const bellGeometry = new THREE.CylinderGeometry(0.82, 1.08, 1.16, 12);
    const crownBaseGeometry = new THREE.CylinderGeometry(1.08, 1.24, 0.4, 8);
    const crownPointGeometry = new THREE.ConeGeometry(0.32, 1.18, 5);
    const cometTailGeometry = new THREE.ConeGeometry(0.42, 2.5, 8);
    // The mast and pennant are deliberately chunky. They make each optional
    // target read as a real water marker from the chase camera instead of a
    // tiny floating UI glyph. A horizontal pennant cannot be confused with
    // the vertical diamond used by the flight launch cue.
    const mastGeometry = new THREE.CylinderGeometry(0.1, 0.16, 2.55, 8);
    const pennantGeometry = new THREE.BoxGeometry(1.65, 0.62, 0.14);
    const beaconGeometry = new THREE.SphereGeometry(0.25, 10, 8);
    const stemGeometry = new THREE.CylinderGeometry(0.1, 0.16, 1.55, 8);
    const floatGeometry = new THREE.CylinderGeometry(1.05, 1.28, 0.7, 12);
    const floatFoamGeometry = new THREE.TorusGeometry(1.2, 0.13, 7, 24);
    const orbitGeometry = new THREE.SphereGeometry(0.2, 10, 8);
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
    const floatMaterial = createToonMaterial({
      color: PALETTE.foam,
      emissive: PALETTE.flight,
      emissiveIntensity: 0.2,
      rimColor: PALETTE.ink,
      rimStrength: 0.4,
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
      // Every target is a solid, named prop. There is no hole to mistake for a
      // jump gate and no hidden center-line resource rule.
      group.rotation.y = heading;
      const emblem = new THREE.Group();
      emblem.name = `honor-emblem-${spec.kind}`;
      if (spec.kind === 'star') {
        const star = new THREE.Mesh(starGeometry, materialFor(spec.kind));
        star.name = 'honor-star';
        star.rotation.z = Math.PI * 0.25;
        emblem.add(star);
      } else if (spec.kind === 'bell') {
        const bell = new THREE.Mesh(bellGeometry, materialFor(spec.kind));
        bell.name = 'honor-bell';
        const clapper = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), beamMaterial);
        clapper.name = 'honor-bell-clapper';
        clapper.position.y = -0.72;
        emblem.add(bell, clapper);
      } else if (spec.kind === 'crown') {
        const base = new THREE.Mesh(crownBaseGeometry, materialFor(spec.kind));
        base.name = 'honor-crown-base';
        emblem.add(base);
        for (const xOffset of [-0.82, 0, 0.82]) {
          const pointMesh = new THREE.Mesh(crownPointGeometry, materialFor(spec.kind));
          pointMesh.position.set(xOffset, 0.75, 0);
          pointMesh.rotation.z = xOffset * 0.18;
          pointMesh.name = 'honor-crown-point';
          emblem.add(pointMesh);
        }
      } else if (spec.kind === 'comet') {
        const head = new THREE.Mesh(coreGeometry, materialFor(spec.kind));
        head.name = 'honor-comet-head';
        const tail = new THREE.Mesh(cometTailGeometry, beamMaterial);
        tail.name = 'honor-comet-tail';
        tail.rotation.x = -Math.PI / 2;
        tail.position.z = -1.35;
        tail.scale.set(1, 1, 1.15);
        emblem.add(head, tail);
      } else {
        const duck = new THREE.Mesh(coreGeometry, materialFor(spec.kind));
        duck.name = 'honor-duck-body';
        duck.scale.set(1.18, 0.86, 1.28);
        const bill = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.48, 8), beamMaterial);
        bill.name = 'honor-duck-bill';
        bill.rotation.x = Math.PI / 2;
        bill.position.set(0, 0.02, 1.05);
        emblem.add(duck, bill);
      }
      // Keep the collision/root at the live water plane while raising the
      // authored emblem onto its mast. The float remains the visual anchor;
      // nothing here is an airborne trigger or a hidden energy station.
      emblem.position.set(0, 1.02, 0);
      emblem.scale.setScalar(1.18);
      group.add(emblem);

      // Crown grips remain a readable physical frame, but are compact and
      // attached to the emblem rather than forming a misleading ring.
      if (spec.kind === 'crown') {
        for (const angle of [0.48, Math.PI - 0.48, Math.PI + 0.48, -0.48]) {
          const grip = new THREE.Mesh(gripGeometry, beamMaterial);
          grip.name = 'technique-helm-grip';
          grip.position.set(Math.sin(angle) * 1.08, Math.cos(angle) * 0.56, 0);
          grip.rotation.z = angle;
          grip.userData.noOutline = true;
          emblem.add(grip);
        }
      }

      // A chunky float and foam collar make the target physically legible at
      // a glance. The stem terminates in the float instead of disappearing
      // into an empty water surface.
      const mast = new THREE.Mesh(mastGeometry, inkMaterial);
      mast.name = 'honor-signal-mast';
      mast.position.y = 0.62;
      group.add(mast);
      const pennant = new THREE.Mesh(pennantGeometry, materialFor(spec.kind));
      pennant.name = 'honor-signal-pennant';
      pennant.position.set(0.7, 1.65, -0.04);
      pennant.userData.noOutline = true;
      group.add(pennant);
      const beacon = new THREE.Mesh(beaconGeometry, beamMaterial);
      beacon.name = 'honor-signal-beacon';
      beacon.position.y = 1.98;
      group.add(beacon);

      const float = new THREE.Mesh(floatGeometry, floatMaterial);
      float.name = 'honor-float';
      float.position.y = -0.34;
      group.add(float);
      const floatFoam = new THREE.Mesh(floatFoamGeometry, beamMaterial);
      floatFoam.name = 'honor-float-foam';
      floatFoam.rotation.x = Math.PI / 2;
      floatFoam.position.y = -0.3;
      group.add(floatFoam);

      const stem = new THREE.Mesh(stemGeometry, inkMaterial);
      stem.name = 'honor-stem';
      stem.position.y = -0.08;
      group.add(stem);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.06, 1.55, 6), beamMaterial);
      beam.name = 'honor-beam';
      beam.position.y = -0.42;
      beam.userData.noOutline = true;
      group.add(beam);

      const orbit = new THREE.Group();
      orbit.name = 'honor-orbit';
      for (let orbitIndex = 0; orbitIndex < 3; orbitIndex++) {
        const orb = new THREE.Mesh(orbitGeometry, materialFor(spec.kind));
        const angle = orbitIndex * (Math.PI * 2 / 3);
        orb.position.set(Math.cos(angle) * 2.22, 1.02 + Math.sin(angle * 1.3) * 0.28, Math.sin(angle) * 2.22);
        orbit.add(orb);
      }
      group.add(orbit);

      addOutline(group, { width: 0.72 });
      markInk(group);
      this.object.add(group);
      this.targets.push({
        group,
        emblem,
        float,
        floatFoam,
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
