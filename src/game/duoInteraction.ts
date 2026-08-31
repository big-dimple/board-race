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

export interface ActiveMissileInfo {
  active: boolean;
  position: THREE.Vector3;
  direction: THREE.Vector3;
  velocity: THREE.Vector3;
  speed: number;
  age: number;
  actorId: number;
  targetId: number;
  isDwell: boolean;
}

const MAX_CHARGES = 7;
const COOLDOWN_S = 3.5;
const PRANK_IMPULSE = 2.4;
const PRANK_SPEED = 58;
const PRANK_LIFETIME_S = 5.2;
const PRANK_HIT_RADIUS = 5.5;
const MAX_PROJECTILES = 4;

// Lighthouse reef launch complex position coordinates
const LAUNCH_PADS = [
  { x: 106.2, y: 1.85, z: 186.5, angle: -0.42 },
  { x: 108.6, y: 1.95, z: 185.0, angle: -0.15 },
  { x: 111.4, y: 1.95, z: 185.0, angle: 0.15 },
  { x: 113.8, y: 1.85, z: 186.5, angle: 0.42 },
] as const;

const _missileDir = new THREE.Vector3();
const _forwardZ = new THREE.Vector3(0, 0, 1);

/**
 * A deterministic post-elimination role. It never writes to BoatInput: the
 * eliminated player's device emits a separate edge, safely hands off a flight
 * cell, or launches a realistic Scud tactical missile with 90% hit rate from
 * the lighthouse missile complex that launches the survivor into a 720° comical airborne tumble.
 */
export class DuoInteractionController {
  readonly object: THREE.Group;
  private readonly launchComplexGroup: THREE.Group;
  private readonly staticMissiles: THREE.Group[] = [];
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
    padIndex: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    age: 0,
    isDwell: false,
    dwellTimer: 0,
    historyX: new Float32Array(16),
    historyY: new Float32Array(16),
    historyZ: new Float32Array(16),
  }));
  private readonly projectileVisuals: Array<{
    group: THREE.Group;
    body: THREE.Group;
    trail: THREE.Line;
    blastPlume: THREE.Mesh;
    flame: THREE.Mesh;
    flameCore: THREE.Mesh;
    flameOuter?: THREE.Mesh;
  }> = [];

  private readonly activeMissileScratch: ActiveMissileInfo = {
    active: false,
    position: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    speed: 0,
    age: 0,
    actorId: -1,
    targetId: -1,
    isDwell: false,
  };

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'duo-interaction-projectiles';

    // Realistic Military Tactical Cruise / Ballistic Missile materials
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x222629, toneMapped: false }); // Matte military gunmetal / graphite
    const noseMat = new THREE.MeshBasicMaterial({ color: 0x14181a, toneMapped: false }); // Titanium radome
    const seekerMat = new THREE.MeshBasicMaterial({ color: 0x050708, toneMapped: false }); // Infrared seeker dome
    const finMat = new THREE.MeshBasicMaterial({ color: 0x181c1f, toneMapped: false }); // High-strength carbon-titanium fins
    const actuatorMat = new THREE.MeshBasicMaterial({ color: 0x33393f, toneMapped: false }); // Hydraulic actuator pods
    const bandMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, toneMapped: false }); // Tactical hazard yellow stripe
    const blackBandMat = new THREE.MeshBasicMaterial({ color: 0x0e1012, toneMapped: false }); // Tactical black chevron stripe
    const nozzleMat = new THREE.MeshBasicMaterial({ color: 0x151515, toneMapped: false }); // Rocket motor nozzle
    const gantryMat = new THREE.MeshBasicMaterial({ color: 0x282e34, toneMapped: false }); // Gantry frame steel
    const padBaseMat = new THREE.MeshBasicMaterial({ color: 0x15181c, toneMapped: false }); // Concrete launch pad
    const flameCoreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.98, toneMapped: false });
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xff5500, transparent: true, opacity: 0.92, toneMapped: false });
    const flameOuterMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.75, toneMapped: false });
    const trailMat = new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.88, toneMapped: false });

    // Sleek aerodynamic military missile fuselage
    const bodyGeo = new THREE.CylinderGeometry(0.22, 0.22, 2.8, 12);
    bodyGeo.rotateX(Math.PI / 2);
    const warheadGeo = new THREE.ConeGeometry(0.22, 1.15, 12);
    warheadGeo.rotateX(Math.PI / 2);
    const seekerGeo = new THREE.SphereGeometry(0.07, 8, 8);
    const bandGeo = new THREE.CylinderGeometry(0.225, 0.225, 0.14, 12);
    bandGeo.rotateX(Math.PI / 2);
    const blackBandGeo = new THREE.CylinderGeometry(0.226, 0.226, 0.07, 12);
    blackBandGeo.rotateX(Math.PI / 2);

    // Aerodynamic titanium forward canards (swept trapezoidal)
    const canardGeo = new THREE.BoxGeometry(0.025, 0.28, 0.36);
    // Rear cruciform delta stabilization control fins
    const finGeo = new THREE.BoxGeometry(0.035, 0.72, 0.58);
    const actuatorGeo = new THREE.BoxGeometry(0.08, 0.08, 0.28);

    const nozzleGeo = new THREE.CylinderGeometry(0.14, 0.20, 0.42, 10);
    nozzleGeo.rotateX(Math.PI / 2);
    const flameCoreGeo = new THREE.ConeGeometry(0.10, 1.45, 8);
    flameCoreGeo.rotateX(-Math.PI / 2);
    const flameGeo = new THREE.ConeGeometry(0.19, 2.35, 8);
    flameGeo.rotateX(-Math.PI / 2);
    const flameOuterGeo = new THREE.ConeGeometry(0.28, 3.1, 8);
    flameOuterGeo.rotateX(-Math.PI / 2);

    const buildScudModel = (includePlume: boolean): { group: THREE.Group; flame?: THREE.Mesh; flameCore?: THREE.Mesh; flameOuter?: THREE.Mesh } => {
      const missileMeshGroup = new THREE.Group();
      missileMeshGroup.name = 'scud-body';

      const fuselage = new THREE.Mesh(bodyGeo, bodyMat);
      const warhead = new THREE.Mesh(warheadGeo, noseMat);
      warhead.position.z = 1.85;
      const seeker = new THREE.Mesh(seekerGeo, seekerMat);
      seeker.position.z = 2.45;

      const bandYellow = new THREE.Mesh(bandGeo, bandMat);
      bandYellow.position.z = 0.95;
      const bandBlack = new THREE.Mesh(blackBandGeo, blackBandMat);
      bandBlack.position.z = 0.95;

      const nozzle = new THREE.Mesh(nozzleGeo, nozzleMat);
      nozzle.position.z = -1.55;

      for (let c = 0; c < 4; c++) {
        const canard = new THREE.Mesh(canardGeo, finMat);
        canard.position.z = 0.65;
        canard.rotation.z = (c * Math.PI) / 2;
        if (c % 2 === 0) canard.position.y = (c === 0 ? 0.26 : -0.26);
        else canard.position.x = (c === 1 ? 0.26 : -0.26);
        missileMeshGroup.add(canard);
      }

      for (let f = 0; f < 4; f++) {
        const fin = new THREE.Mesh(finGeo, finMat);
        fin.position.z = -1.15;
        fin.rotation.z = (f * Math.PI) / 2;
        if (f % 2 === 0) fin.position.y = (f === 0 ? 0.44 : -0.44);
        else fin.position.x = (f === 1 ? 0.44 : -0.44);

        const actuator = new THREE.Mesh(actuatorGeo, actuatorMat);
        actuator.position.z = -1.15;
        actuator.rotation.z = (f * Math.PI) / 2;
        if (f % 2 === 0) actuator.position.y = (f === 0 ? 0.22 : -0.22);
        else actuator.position.x = (f === 1 ? 0.22 : -0.22);

        missileMeshGroup.add(fin, actuator);
      }

      missileMeshGroup.add(fuselage, warhead, seeker, bandYellow, bandBlack, nozzle);

      let flameMesh: THREE.Mesh | undefined;
      let flameCoreMesh: THREE.Mesh | undefined;
      let flameOuterMesh: THREE.Mesh | undefined;
      if (includePlume) {
        flameCoreMesh = new THREE.Mesh(flameCoreGeo, flameCoreMat);
        flameCoreMesh.position.z = -2.25;
        flameMesh = new THREE.Mesh(flameGeo, flameMat);
        flameMesh.position.z = -2.70;
        flameOuterMesh = new THREE.Mesh(flameOuterGeo, flameOuterMat);
        flameOuterMesh.position.z = -3.10;
        missileMeshGroup.add(flameCoreMesh, flameMesh, flameOuterMesh);
      }

      return { group: missileMeshGroup, flame: flameMesh, flameCore: flameCoreMesh, flameOuter: flameOuterMesh };
    };

    // Construct static launch gantry battery at lighthouse reef base
    this.launchComplexGroup = new THREE.Group();
    this.launchComplexGroup.name = 'scud-launch-complex';

    const padBoxGeo = new THREE.BoxGeometry(1.4, 0.35, 2.4);
    const railGeo = new THREE.BoxGeometry(0.18, 0.22, 3.4);
    const strutGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6);

    for (let p = 0; p < LAUNCH_PADS.length; p++) {
      const padInfo = LAUNCH_PADS[p];
      const padGroup = new THREE.Group();
      padGroup.name = `scud-launch-pad-${p + 1}`;
      padGroup.position.set(padInfo.x, padInfo.y, padInfo.z);
      padGroup.rotation.y = padInfo.angle;

      const padBase = new THREE.Mesh(padBoxGeo, padBaseMat);
      padBase.position.y = 0.17;
      padGroup.add(padBase);

      const gantryRail = new THREE.Group();
      gantryRail.position.set(0, 0.45, -0.2);
      gantryRail.rotation.x = -Math.PI * 0.32; // Elevated ~58 deg launch angle

      const railBeamLeft = new THREE.Mesh(railGeo, gantryMat);
      railBeamLeft.position.x = -0.32;
      const railBeamRight = new THREE.Mesh(railGeo, gantryMat);
      railBeamRight.position.x = 0.32;
      gantryRail.add(railBeamLeft, railBeamRight);

      const strutLeft = new THREE.Mesh(strutGeo, gantryMat);
      strutLeft.position.set(-0.35, -0.4, -0.6);
      strutLeft.rotation.x = 0.4;
      const strutRight = new THREE.Mesh(strutGeo, gantryMat);
      strutRight.position.set(0.35, -0.4, -0.6);
      strutRight.rotation.x = 0.4;
      padGroup.add(strutLeft, strutRight);

      // Parked static Scud missile on launch rail
      const staticScud = buildScudModel(false);
      staticScud.group.position.set(0, 0.22, 0.3);
      gantryRail.add(staticScud.group);
      this.staticMissiles.push(staticScud.group);

      padGroup.add(gantryRail);
      this.launchComplexGroup.add(padGroup);
    }
    this.object.add(this.launchComplexGroup);

    const blastPlumeGeo = new THREE.SphereGeometry(1.4, 12, 12);
    const blastPlumeMat = new THREE.MeshBasicMaterial({ color: 0xff6611, transparent: true, opacity: 0.95, toneMapped: false });

    // Active in-flight missile visual projectiles
    for (let index = 0; index < MAX_PROJECTILES; index++) {
      const group = new THREE.Group();
      group.name = `duo-interaction-scud-${index + 1}`;

      const { group: missileMeshGroup, flame, flameCore, flameOuter } = buildScudModel(true);

      const trailGeometry = new THREE.BufferGeometry();
      trailGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
      const trail = new THREE.Line(trailGeometry, trailMat);
      trail.frustumCulled = false;

      const blastPlume = new THREE.Mesh(blastPlumeGeo, blastPlumeMat.clone());
      blastPlume.visible = false;

      group.add(trail, missileMeshGroup, blastPlume);
      group.visible = false;
      this.object.add(group);
      this.projectileVisuals.push({
        group,
        body: missileMeshGroup,
        trail,
        blastPlume,
        flame: flame!,
        flameCore: flameCore!,
        flameOuter,
      });
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
      state.isDwell = false;
      state.dwellTimer = 0;
      this.projectileVisuals[i].group.visible = false;
      this.projectileState[i].historyX.fill(0);
      this.projectileState[i].historyY.fill(0);
      this.projectileState[i].historyZ.fill(0);
    }
    for (const missile of this.staticMissiles) missile.visible = true;
    for (let i = 0; i < 2; i++) this.syncStatus(i, false);
  }

  getActiveMissileInfo(actorId?: number): ActiveMissileInfo | null {
    const shot = this.projectileState.find((item) => item.active && (actorId === undefined || item.actorId === actorId));
    if (!shot) return null;
    this.activeMissileScratch.active = true;
    this.activeMissileScratch.position.set(shot.x, shot.y, shot.z);
    const speed = Math.hypot(shot.vx, shot.vy, shot.vz) || 1;
    this.activeMissileScratch.direction.set(shot.vx / speed, shot.vy / speed, shot.vz / speed);
    this.activeMissileScratch.velocity.set(shot.vx, shot.vy, shot.vz);
    this.activeMissileScratch.speed = speed;
    this.activeMissileScratch.age = shot.age;
    this.activeMissileScratch.actorId = shot.actorId;
    this.activeMissileScratch.targetId = shot.targetId;
    this.activeMissileScratch.isDwell = shot.isDwell;
    return this.activeMissileScratch;
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
        const shot = this.projectileState.find((item) => !item.active);
        if (!shot) continue;

        // Launch from the lighthouse missile complex on the reef platform
        const padIndex = this.counts.prank % LAUNCH_PADS.length;
        const pad = LAUNCH_PADS[padIndex];
        const spawnX = pad.x;
        const spawnY = pad.y + 0.85;
        const spawnZ = pad.z;

        // Calculate initial launch direction climbing from static gantry rail
        const launchAngle = pad.angle;
        const elev = 0.32 * Math.PI; // 58 deg launch inclination
        const railDirX = Math.sin(launchAngle) * Math.cos(elev);
        const railDirY = Math.sin(elev);
        const railDirZ = -Math.cos(launchAngle) * Math.cos(elev);

        const initSpeed = 10.0; // Rapid rail ignition boost from static gantry

        shot.active = true;
        shot.actorId = actor;
        shot.targetId = target;
        shot.padIndex = padIndex;
        shot.x = spawnX;
        shot.y = spawnY;
        shot.z = spawnZ;
        shot.vx = railDirX * initSpeed;
        shot.vy = railDirY * initSpeed;
        shot.vz = railDirZ * initSpeed;
        shot.age = 0;
        shot.isDwell = false;
        shot.dwellTimer = 0;

        // Hide the static missile on this gantry as it launches
        if (this.staticMissiles[padIndex]) {
          this.staticMissiles[padIndex].visible = false;
        }

        shot.historyX.fill(spawnX);
        shot.historyY.fill(spawnY);
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

      // If in post-impact dwell, countdown before releasing projectile
      if (shot.isDwell) {
        shot.dwellTimer -= dt;
        this.projectileVisuals[index].group.visible = false;
        if (shot.dwellTimer <= 0) {
          shot.active = false;
          shot.isDwell = false;
          if (this.staticMissiles[shot.padIndex]) {
            this.staticMissiles[shot.padIndex].visible = true;
          }
        }
        continue;
      }

      shot.age += dt;
      const targetBoat = boats[shot.targetId];
      const targetState = racers[shot.targetId];
      if (!targetBoat || !targetState || targetState.eliminated || targetState.finished || shot.age > PRANK_LIFETIME_S) {
        shot.active = false;
        this.projectileVisuals[index].group.visible = false;
        if (this.staticMissiles[shot.padIndex]) {
          this.staticMissiles[shot.padIndex].visible = true;
        }
        continue;
      }

      const tx = targetBoat.state.position.x;
      const ty = targetBoat.state.position.y + 0.8;
      const tz = targetBoat.state.position.z;
      const heading = targetBoat.state.heading;
      const targetSpeed = targetBoat.state.speed;
      const velX = targetSpeed * Math.sin(heading);
      const velZ = targetSpeed * Math.cos(heading);

      // Lead intercept aim point
      const leadTime = Math.min(0.35, Math.hypot(tx - shot.x, tz - shot.z) / PRANK_SPEED);
      const aimX = tx + velX * leadTime;
      const aimY = ty;
      const aimZ = tz + velZ * leadTime;

      const dx = aimX - shot.x;
      const dy = aimY - shot.y;
      const dz = aimZ - shot.z;
      const distance = Math.hypot(dx, dy, dz) || 1;

      // Proportional homing guidance towards survivor boat
      if (shot.age < 0.45) {
        // Initial ignition climb phase from lighthouse battery
        shot.vy += (-9.8 + 36.0) * dt;
        const horizDist = Math.hypot(dx, dz) || 1;
        const steer = dt * 5.0;
        shot.vx += ((dx / horizDist) * PRANK_SPEED - shot.vx) * steer;
        shot.vz += ((dz / horizDist) * PRANK_SPEED - shot.vz) * steer;
      } else {
        // High-agility terminal cruise homing phase
        const desiredX = (dx / distance) * PRANK_SPEED;
        const desiredY = (dy / distance) * PRANK_SPEED;
        const desiredZ = (dz / distance) * PRANK_SPEED;
        const steer = Math.min(1, dt * 10.0);
        shot.vx += (desiredX - shot.vx) * steer;
        shot.vy += (desiredY - shot.vy) * steer;
        shot.vz += (desiredZ - shot.vz) * steer;

        const currentSpeed = Math.hypot(shot.vx, shot.vy, shot.vz) || PRANK_SPEED;
        shot.vx *= PRANK_SPEED / currentSpeed;
        shot.vy *= PRANK_SPEED / currentSpeed;
        shot.vz *= PRANK_SPEED / currentSpeed;
      }

      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      shot.z += shot.vz * dt;

      for (let history = 15; history > 0; history--) {
        shot.historyX[history] = shot.historyX[history - 1];
        shot.historyY[history] = shot.historyY[history - 1];
        shot.historyZ[history] = shot.historyZ[history - 1];
      }
      shot.historyX[0] = shot.x;
      shot.historyY[0] = shot.y;
      shot.historyZ[0] = shot.z;

      const directDist = Math.hypot(tx - shot.x, ty - shot.y, tz - shot.z);
      const hitDistHoriz = Math.hypot(tx - shot.x, tz - shot.z);
      const hitDistVert = Math.abs(ty - shot.y);

      // Terminal detonation trigger
      const reachedTarget = directDist <= PRANK_HIT_RADIUS ||
        (hitDistHoriz <= PRANK_HIT_RADIUS && hitDistVert <= 6.5) ||
        (shot.age > 0.8 && directDist <= 7.5 && (shot.vx * (tx - shot.x) + shot.vz * (tz - shot.z) < 0));

      if (reachedTarget) {
        // 90% Base precision hit rate; continuous drifting on water grants 50% dodge exemption
        const isDrifting = targetBoat.state.drifting;
        const hitProbability = isDrifting ? 0.45 : 0.90;
        const isHit = Math.random() < hitProbability;
        const sideSign = ((shot.actorId + Math.round(shot.age * 10)) % 2 === 0) ? 1 : -1;
        const forwardX = Math.sin(heading) * 18.0;
        const forwardZ = Math.cos(heading) * 18.0;
        const sideX = sideSign * Math.cos(heading) * 12.0;
        const sideZ = sideSign * -Math.sin(heading) * 12.0;

        if (isHit) {
          targetBoat.applyScudHit(forwardX + sideX, forwardZ + sideZ, 18.5);
          emit({ actorId: shot.actorId, targetId: shot.targetId, action: 'prank', phase: 'prank-impact', accepted: true, chargesLeft: this.charges[shot.actorId] });
        } else {
          targetBoat.applyScudNearMiss(shot.x, shot.z, sideX * 0.75, sideZ * 0.75);
          emit({ actorId: shot.actorId, targetId: shot.targetId, action: 'prank', phase: 'prank-miss', accepted: true, chargesLeft: this.charges[shot.actorId] });
        }
        shot.isDwell = true;
        shot.dwellTimer = 0.65; // 0.65s dwell for dramatic explosion viewing
      }
      this.syncProjectileVisual(index, shot);
    }
  }

  private syncProjectileVisual(index: number, shot: (typeof this.projectileState)[number]): void {
    const visual = this.projectileVisuals[index];
    visual.group.visible = shot.active;
    if (!shot.active) return;

    if (shot.isDwell) {
      // Dynamic water surface fireball & geyser plume expansion during dwell
      visual.body.visible = false;
      visual.trail.visible = false;
      visual.blastPlume.visible = true;
      const progress = 1 - shot.dwellTimer / 0.65;
      const scale = 1.2 + progress * 8.5;
      visual.blastPlume.scale.set(scale, scale * 1.8, scale);
      visual.blastPlume.position.set(shot.x, Math.max(0.6, shot.y), shot.z);
      (visual.blastPlume.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - progress * 1.15);
      return;
    }

    visual.body.visible = true;
    visual.trail.visible = true;
    visual.blastPlume.visible = false;
    visual.group.position.set(shot.x, shot.y, shot.z);

    // Orient missile directly along 3D velocity vector in world space
    const speed = Math.hypot(shot.vx, shot.vy, shot.vz) || 1;
    _missileDir.set(shot.vx / speed, shot.vy / speed, shot.vz / speed).normalize();
    visual.group.quaternion.setFromUnitVectors(_forwardZ, _missileDir);

    // Dynamic supersonic afterburner pulsing
    const pulse = Math.sin(shot.age * 36);
    visual.flame.scale.set(
      1 + pulse * 0.22,
      1 + Math.cos(shot.age * 36) * 0.22,
      1.15 + Math.sin(shot.age * 48) * 0.35,
    );
    visual.flameCore.scale.set(
      0.95 + Math.cos(shot.age * 45) * 0.18,
      0.95 + Math.sin(shot.age * 45) * 0.18,
      1.10 + pulse * 0.28,
    );
    if (visual.flameOuter) {
      visual.flameOuter.scale.set(
        1.05 + Math.sin(shot.age * 30) * 0.25,
        1.05 + Math.cos(shot.age * 30) * 0.25,
        1.2 + pulse * 0.4,
      );
    }

    const positions = visual.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let history = 0; history < 16; history++) {
      const fade = 1 - history / 16;
      const swirl = 0.38 * fade * (0.2 + (history / 16) * 0.8);
      const swirlPhase = shot.age * 12 - history * 0.65;
      positions.setXYZ(history,
        shot.historyX[history] - shot.x + Math.cos(swirlPhase) * swirl,
        shot.historyY[history] - shot.y,
        shot.historyZ[history] - shot.z + Math.sin(swirlPhase) * swirl,
      );
    }
    positions.needsUpdate = true;
  }

  private syncStatus(actor: number, available: boolean): void {
    this.status[actor].available = available && this.cooldown[actor] <= 0 && this.charges[actor] > 0;
    this.status[actor].cooldown = this.cooldown[actor];
    this.status[actor].charges = this.charges[actor];
  }
}

function isSafeSurfaceWindow(boat: IBoat): boolean {
  const state = boat.state;
  return state.flightPhase === 'surface' && !state.airborne && !state.boosting && state.flightRouteState === 'idle';
}
