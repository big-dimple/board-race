import * as THREE from 'three';
import type { IBoat, RacerState } from '../contracts';
import type { LocalDeviceId, LocalMultiplayerInput } from '../core/localMultiplayerInput';
import { PALETTE } from '../core/palette';

export type DuoInteractionAction = 'support' | 'prank';
export type DuoInteractionPhase = 'support' | 'prank-launch' | 'prank-impact' | 'prank-miss' | 'blocked';
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

const MAX_CHARGES = 7;
const COOLDOWN_S = 3.5;
const PRANK_IMPULSE = 1.85;
const PRANK_SPEED = 36;
const PRANK_LIFETIME_S = 2.0;
const PRANK_HIT_RADIUS = 2.8;
const MAX_PROJECTILES = 4;

const _missileDir = new THREE.Vector3();
const _forwardZ = new THREE.Vector3(0, 0, 1);

/**
 * A deterministic post-elimination role. It never writes to BoatInput: the
 * eliminated player's device emits a separate edge, safely hands off a flight
 * cell, or launches a realistic Scud tactical missile with 75% hit rate that
 * launches the survivor into a 720° comical airborne tumble along its inertia vector.
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
    historyX: new Float32Array(16),
    historyY: new Float32Array(16),
    historyZ: new Float32Array(16),
  }));
  private readonly projectileVisuals: Array<{
    group: THREE.Group;
    trail: THREE.Line;
    flame: THREE.Mesh;
    smokeRing: THREE.Mesh;
  }> = [];

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'duo-interaction-projectiles';

    // Realistic Scud-B / tactical ballistic missile materials
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x3d4b3d, toneMapped: false }); // Olive military drab
    const warheadMat = new THREE.MeshBasicMaterial({ color: 0xd62828, toneMapped: false }); // Danger crimson nose
    const finMat = new THREE.MeshBasicMaterial({ color: 0x1f2421, toneMapped: false }); // Gunmetal dark fins
    const bandMat = new THREE.MeshBasicMaterial({ color: 0xf4a261, toneMapped: false }); // Hazard yellow ring
    const nozzleMat = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false });
    const flameMat = new THREE.MeshBasicMaterial({ color: PALETTE.sunFlare, transparent: true, opacity: 0.95, toneMapped: false });
    const trailMat = new THREE.LineBasicMaterial({ color: 0xffeedd, transparent: true, opacity: 0.88, toneMapped: false });
    const smokeRingMat = new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.75, toneMapped: false });

    const bodyGeo = new THREE.CylinderGeometry(0.24, 0.24, 2.4, 10);
    bodyGeo.rotateX(Math.PI / 2);
    const warheadGeo = new THREE.ConeGeometry(0.24, 0.85, 10);
    warheadGeo.rotateX(Math.PI / 2);
    const bandGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.22, 10);
    bandGeo.rotateX(Math.PI / 2);
    const finGeo = new THREE.BoxGeometry(0.04, 0.55, 0.45);
    const nozzleGeo = new THREE.CylinderGeometry(0.14, 0.20, 0.32, 8);
    nozzleGeo.rotateX(Math.PI / 2);
    const flameGeo = new THREE.ConeGeometry(0.18, 1.25, 8);
    flameGeo.rotateX(-Math.PI / 2);
    const ringGeo = new THREE.TorusGeometry(0.85, 0.08, 6, 16);

    for (let index = 0; index < MAX_PROJECTILES; index++) {
      const group = new THREE.Group();
      group.name = `duo-interaction-scud-${index + 1}`;

      const missileMeshGroup = new THREE.Group();
      missileMeshGroup.name = 'scud-body';

      const fuselage = new THREE.Mesh(bodyGeo, bodyMat);
      const warhead = new THREE.Mesh(warheadGeo, warheadMat);
      warhead.position.z = 1.55;
      const band = new THREE.Mesh(bandGeo, bandMat);
      band.position.z = 0.55;

      const nozzle = new THREE.Mesh(nozzleGeo, nozzleMat);
      nozzle.position.z = -1.32;

      // 4 stabilization delta tail fins
      for (let f = 0; f < 4; f++) {
        const fin = new THREE.Mesh(finGeo, finMat);
        fin.position.z = -0.95;
        fin.rotation.z = (f * Math.PI) / 2;
        if (f % 2 === 0) fin.position.y = (f === 0 ? 0.35 : -0.35);
        else fin.position.x = (f === 1 ? 0.35 : -0.35);
        missileMeshGroup.add(fin);
      }

      const flame = new THREE.Mesh(flameGeo, flameMat);
      flame.position.z = -2.05;

      missileMeshGroup.add(fuselage, warhead, band, nozzle, flame);

      const smokeRing = new THREE.Mesh(ringGeo, smokeRingMat);
      smokeRing.rotation.x = Math.PI / 2;

      const trailGeometry = new THREE.BufferGeometry();
      trailGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
      const trail = new THREE.Line(trailGeometry, trailMat);
      trail.frustumCulled = false;

      group.add(trail, smokeRing, missileMeshGroup);
      group.visible = false;
      this.object.add(group);
      this.projectileVisuals.push({ group, trail, flame, smokeRing });
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
        const heading = targetBoat.state.heading;
        const forwardX = Math.sin(heading);
        const forwardZ = Math.cos(heading);
        const spawnDist = 18;
        const spawnX = targetBoat.state.position.x - forwardX * spawnDist;
        const spawnZ = targetBoat.state.position.z - forwardZ * spawnDist;
        const chaseSpeed = Math.max(PRANK_SPEED, Math.abs(targetBoat.state.speed) + 16);
        shot.active = true;
        shot.actorId = actor;
        shot.targetId = target;
        shot.x = spawnX;
        shot.z = spawnZ;
        shot.vx = forwardX * chaseSpeed;
        shot.vz = forwardZ * chaseSpeed;
        shot.age = 0;
        const originY = targetBoat.state.position.y + 1.15;
        shot.historyX.fill(spawnX);
        shot.historyY.fill(originY);
        shot.historyZ.fill(spawnZ);
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
      const chaseSpeed = Math.max(PRANK_SPEED, Math.abs(targetBoat.state.speed) + 16);
      const dx = targetBoat.state.position.x - shot.x;
      const dz = targetBoat.state.position.z - shot.z;
      const distance = Math.hypot(dx, dz) || 1;
      const desiredX = dx / distance * chaseSpeed;
      const desiredZ = dz / distance * chaseSpeed;
      const steer = Math.min(1, dt * 8.5);
      shot.vx += (desiredX - shot.vx) * steer;
      shot.vz += (desiredZ - shot.vz) * steer;
      const speed = Math.hypot(shot.vx, shot.vz) || chaseSpeed;
      shot.vx *= chaseSpeed / speed;
      shot.vz *= chaseSpeed / speed;
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
          const isHit = Math.random() < 0.75;
          if (isHit) {
            const heading = targetBoat.state.heading;
            const forwardX = Math.sin(heading) * PRANK_IMPULSE;
            const forwardZ = Math.cos(heading) * PRANK_IMPULSE;
            const sideSign = ((shot.actorId + Math.round(shot.age * 10)) % 2 === 0) ? 1 : -1;
            const sideX = sideSign * Math.cos(heading) * 1.2;
            const sideZ = sideSign * -Math.sin(heading) * 1.2;
            targetBoat.applyScudHit(forwardX + sideX, forwardZ + sideZ, 9.0);
            emit({ actorId: shot.actorId, targetId: shot.targetId, action: 'prank', phase: 'prank-impact', accepted: true, chargesLeft: this.charges[shot.actorId] });
          } else {
            emit({ actorId: shot.actorId, targetId: shot.targetId, action: 'prank', phase: 'prank-miss', accepted: true, chargesLeft: this.charges[shot.actorId] });
          }
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

    // Orient missile directly along velocity vector in world space
    const speed = Math.hypot(shot.vx, shot.vz) || 1;
    const dy = shot.historyY[0] - shot.historyY[1];
    _missileDir.set(shot.vx / speed, Math.max(-0.6, Math.min(0.6, dy * 2)), shot.vz / speed).normalize();
    visual.group.quaternion.setFromUnitVectors(_forwardZ, _missileDir);

    // Dynamic flame scale pulsing
    visual.flame.scale.set(
      1 + Math.sin(shot.age * 32) * 0.25,
      1 + Math.cos(shot.age * 32) * 0.25,
      1.1 + Math.sin(shot.age * 45) * 0.35,
    );
    visual.smokeRing.scale.setScalar(1 + (shot.age % 0.3) * 3);
    visual.smokeRing.position.z = -1.6 - (shot.age % 0.3) * 2;

    const positions = visual.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let history = 0; history < 16; history++) {
      const fade = 1 - history / 16;
      const swirl = 0.45 * fade * (0.2 + (history / 16) * 0.8);
      const swirlPhase = shot.age * 12 - history * 0.65;
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
