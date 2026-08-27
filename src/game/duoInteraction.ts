import * as THREE from 'three';
import type { IBoat, RacerState } from '../contracts';
import type { LocalDeviceId, LocalMultiplayerInput } from '../core/localMultiplayerInput';
import { PALETTE } from '../core/palette';

export type DuoInteractionAction = 'support' | 'prank';
export type DuoInteractionPhase = 'support' | 'prank-launch' | 'prank-impact' | 'blocked';
export type DuoInteractionBlockReason = 'unsafe-window' | 'full-bank';

export interface DuoInteractionEvent {
  actorId: number;
  targetId: number;
  action: DuoInteractionAction;
  phase: DuoInteractionPhase;
  accepted: boolean;
  chargesLeft: number;
  reason?: DuoInteractionBlockReason;
}

export interface DuoInteractionStatus {
  available: boolean;
  cooldown: number;
  charges: number;
  actorId: number;
}

const MAX_CHARGES = 3;
const COOLDOWN_S = 4.2;
const PRANK_IMPULSE = 0.82;
const PRANK_SPEED = 28;
const PRANK_LIFETIME_S = 1.35;
const PRANK_HIT_RADIUS = 2.15;
const MAX_PROJECTILES = 3;

/**
 * A deterministic post-elimination role. It never writes to BoatInput: the
 * eliminated player's device emits a separate edge, safely hands off a flight
 * cell, or launches a visible, dodgeable duck that can only nudge a surface
 * boat during a safe window.
 */
export class DuoInteractionController {
  readonly object: THREE.Group;
  private readonly cooldown = [0, 0];
  private readonly charges = [MAX_CHARGES, MAX_CHARGES];
  private readonly counts = { support: 0, prank: 0 };
  private readonly status: DuoInteractionStatus[] = [
    { available: false, cooldown: 0, charges: MAX_CHARGES, actorId: 0 },
    { available: false, cooldown: 0, charges: MAX_CHARGES, actorId: 1 },
  ];
  private readonly projectileState = Array.from({ length: MAX_PROJECTILES }, () => ({
    active: false,
    actorId: -1,
    targetId: -1,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vz: 0,
    age: 0,
    historyX: new Float32Array(12),
    historyY: new Float32Array(12),
    historyZ: new Float32Array(12),
  }));
  private readonly projectileVisuals: Array<{ group: THREE.Group; trail: THREE.Line; halo: THREE.Mesh }> = [];

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'duo-interaction-projectiles';
    const duckMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.sunFlare, toneMapped: false });
    const billMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.uiWarn, toneMapped: false });
    const trailMaterial = new THREE.LineBasicMaterial({ color: PALETTE.sunFlare, transparent: true, opacity: 0.76, toneMapped: false });
    const haloMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.foam, transparent: true, opacity: 0.78, toneMapped: false });
    const duckGeometry = new THREE.SphereGeometry(0.62, 12, 8);
    const billGeometry = new THREE.ConeGeometry(0.18, 0.42, 8);
    const haloGeometry = new THREE.TorusGeometry(1.25, 0.1, 6, 24);
    for (let index = 0; index < MAX_PROJECTILES; index++) {
      const group = new THREE.Group();
      group.name = `duo-interaction-duck-${index + 1}`;
      const duck = new THREE.Mesh(duckGeometry, duckMaterial);
      duck.scale.set(1.1, 0.82, 1.22);
      const bill = new THREE.Mesh(billGeometry, billMaterial);
      bill.rotation.x = Math.PI / 2;
      bill.position.z = 0.66;
      duck.add(bill);
      const halo = new THREE.Mesh(haloGeometry, haloMaterial);
      halo.rotation.x = Math.PI / 2;
      const trailGeometry = new THREE.BufferGeometry();
      trailGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12 * 3), 3));
      const trail = new THREE.Line(trailGeometry, trailMaterial);
      trail.frustumCulled = false;
      group.add(trail, halo, duck);
      group.visible = false;
      this.object.add(group);
      this.projectileVisuals.push({ group, trail, halo });
    }
  }

  reset(): void {
    this.cooldown[0] = 0;
    this.cooldown[1] = 0;
    this.charges[0] = MAX_CHARGES;
    this.charges[1] = MAX_CHARGES;
    this.counts.support = 0;
    this.counts.prank = 0;
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const state = this.projectileState[i];
      state.active = false;
      state.actorId = -1;
      state.targetId = -1;
      state.age = 0;
      this.projectileVisuals[i].group.visible = false;
      this.projectileState[i].historyX.fill(0);
      this.projectileState[i].historyY.fill(0);
      this.projectileState[i].historyZ.fill(0);
    }
    for (let i = 0; i < 2; i++) this.syncStatus(i, false);
  }

  update(
    dt: number,
    racers: readonly RacerState[],
    boats: readonly IBoat[],
    devices: readonly [LocalDeviceId, LocalDeviceId],
    input: LocalMultiplayerInput,
    emit: (event: DuoInteractionEvent) => void,
  ): void {
    this.updateProjectiles(dt, racers, boats, emit);
    for (let actor = 0; actor < 2; actor++) {
      this.cooldown[actor] = Math.max(0, this.cooldown[actor] - dt);
      const actorState = racers[actor];
      const target = actor === 0 ? 1 : 0;
      const targetState = racers[target];
      const available = Boolean(actorState?.eliminated && targetState && !targetState.eliminated && !targetState.finished);
      this.syncStatus(actor, available);
      if (!available || this.cooldown[actor] > 0 || this.charges[actor] <= 0) continue;
      const edges = input.interactionEdges(devices[actor]);
      if (!edges.support && !edges.prank) continue;
      const action: DuoInteractionAction = edges.support ? 'support' : 'prank';
      const targetBoat = boats[target];
      if (action === 'support') {
        // Support is deliberately a resource hand-off, never a speed change.
        // A full bank or a flight/landing window must not make the survivor
        // miss a gate because a spectator pressed a button.
        if (!isSafeSurfaceWindow(targetBoat)) {
          emit({ actorId: actor, targetId: target, action, phase: 'blocked', accepted: false, chargesLeft: this.charges[actor], reason: 'unsafe-window' });
          continue;
        }
        if (!targetBoat.grantFlightCharge()) {
          emit({ actorId: actor, targetId: target, action, phase: 'blocked', accepted: false, chargesLeft: this.charges[actor], reason: 'full-bank' });
          continue;
        }
        this.counts.support++;
        this.consumeCharge(actor);
        emit({ actorId: actor, targetId: target, action, phase: 'support', accepted: true, chargesLeft: this.charges[actor] });
      } else {
        // A spectator may always launch the duck. The projectile is harmless
        // during flight / landing and only applies its nudge if it reaches a
        // stable surface window, so timing stays interactive without stealing
        // control from a risky maneuver.
        const shot = this.projectileState.find((item) => !item.active);
        if (!shot) continue;
        const origin = boats[actor].state.position;
        const destination = targetBoat.state.position;
        const dx = destination.x - origin.x;
        const dz = destination.z - origin.z;
        const distance = Math.hypot(dx, dz) || 1;
        shot.active = true;
        shot.actorId = actor;
        shot.targetId = target;
        shot.x = origin.x;
        shot.z = origin.z;
        shot.vx = dx / distance * PRANK_SPEED;
        shot.vz = dz / distance * PRANK_SPEED;
        shot.age = 0;
        const originY = targetBoat.state.position.y + 1.15;
        shot.historyX.fill(origin.x);
        shot.historyY.fill(originY);
        shot.historyZ.fill(origin.z);
        this.counts.prank++;
        this.consumeCharge(actor);
        emit({ actorId: actor, targetId: target, action, phase: 'prank-launch', accepted: true, chargesLeft: this.charges[actor] });
      }
    }
  }

  snapshot(): { statuses: readonly DuoInteractionStatus[]; support: number; prank: number; activeProjectiles: number } {
    return {
      statuses: this.status.map((item) => ({ ...item })),
      support: this.counts.support,
      prank: this.counts.prank,
      activeProjectiles: this.projectileState.reduce((count, item) => count + (item.active ? 1 : 0), 0),
    };
  }

  private consumeCharge(actor: number): void {
    this.charges[actor]--;
    this.cooldown[actor] = COOLDOWN_S;
    this.syncStatus(actor, true);
  }

  private updateProjectiles(
    dt: number,
    racers: readonly RacerState[],
    boats: readonly IBoat[],
    emit: (event: DuoInteractionEvent) => void,
  ): void {
    for (let index = 0; index < MAX_PROJECTILES; index++) {
      const shot = this.projectileState[index];
      if (!shot.active) {
        this.projectileVisuals[index].group.visible = false;
        continue;
      }
      shot.age += dt;
      const targetBoat = boats[shot.targetId];
      const targetState = racers[shot.targetId];
      if (!targetBoat || !targetState || targetState.eliminated || targetState.finished || shot.age > PRANK_LIFETIME_S) {
        shot.active = false;
        this.projectileVisuals[index].group.visible = false;
        continue;
      }
      const dx = targetBoat.state.position.x - shot.x;
      const dz = targetBoat.state.position.z - shot.z;
      const distance = Math.hypot(dx, dz) || 1;
      const desiredX = dx / distance * PRANK_SPEED;
      const desiredZ = dz / distance * PRANK_SPEED;
      const steer = Math.min(1, dt * 7.5);
      shot.vx += (desiredX - shot.vx) * steer;
      shot.vz += (desiredZ - shot.vz) * steer;
      const speed = Math.hypot(shot.vx, shot.vz) || PRANK_SPEED;
      shot.vx *= PRANK_SPEED / speed;
      shot.vz *= PRANK_SPEED / speed;
      shot.x += shot.vx * dt;
      shot.z += shot.vz * dt;
      for (let history = 11; history > 0; history--) {
        shot.historyX[history] = shot.historyX[history - 1];
        shot.historyY[history] = shot.historyY[history - 1];
        shot.historyZ[history] = shot.historyZ[history - 1];
      }
      shot.historyX[0] = shot.x;
      shot.historyY[0] = targetBoat.state.position.y + 1.15 + Math.sin(shot.age * 11) * 0.3;
      shot.historyZ[0] = shot.z;
      const hitDistance = Math.hypot(targetBoat.state.position.x - shot.x, targetBoat.state.position.z - shot.z);
      if (hitDistance <= PRANK_HIT_RADIUS) {
        if (isSafeSurfaceWindow(targetBoat)) {
          const heading = targetBoat.state.heading;
          const sideX = Math.cos(heading) * PRANK_IMPULSE;
          const sideZ = -Math.sin(heading) * PRANK_IMPULSE;
          targetBoat.applyCollisionResponse(0, 0, sideX, sideZ);
          emit({ actorId: shot.actorId, targetId: shot.targetId, action: 'prank', phase: 'prank-impact', accepted: true, chargesLeft: this.charges[shot.actorId] });
        }
        shot.active = false;
      }
      this.syncProjectileVisual(index, shot);
    }
  }

  private syncProjectileVisual(index: number, shot: (typeof this.projectileState)[number]): void {
    const visual = this.projectileVisuals[index];
    visual.group.visible = shot.active;
    if (!shot.active) return;
    visual.group.position.set(shot.x, shot.historyY[0], shot.z);
    visual.group.rotation.y = shot.age * 8.5;
    visual.halo.rotation.z = shot.age * 12;
    visual.halo.scale.setScalar(1 + Math.sin(shot.age * 8) * 0.18);
    const positions = visual.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let history = 0; history < 12; history++) {
      const fade = 1 - history / 12;
      const swirl = 1.25 * fade * (0.18 + history / 12 * 0.82);
      const swirlPhase = shot.age * 9 - history * 0.72;
      positions.setXYZ(history,
        shot.historyX[history] - shot.x + Math.cos(swirlPhase) * swirl,
        (shot.historyY[history] - shot.historyY[0]) * fade,
        shot.historyZ[history] - shot.z + Math.sin(swirlPhase) * swirl,
      );
    }
    positions.needsUpdate = true;
  }

  private syncStatus(actor: number, available: boolean): void {
    // Match the public readiness flag to the same cooldown gate used by the
    // simulation; an edge during cooldown is intentionally ignored.
    this.status[actor].available = available && this.cooldown[actor] <= 0 && this.charges[actor] > 0;
    this.status[actor].cooldown = this.cooldown[actor];
    this.status[actor].charges = this.charges[actor];
  }
}

function isSafeSurfaceWindow(boat: IBoat): boolean {
  const state = boat.state;
  return state.flightPhase === 'surface' && !state.airborne && !state.boosting && state.flightRouteState === 'idle';
}
