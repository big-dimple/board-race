import * as THREE from 'three';
import type { IBoat, RacerState, ICourse } from '../contracts';
import { CHECKPOINT_US } from './course';

// Reuse materials and geometries for the missile
const domBodyMat = new THREE.MeshBasicMaterial({ color: 0x283038, toneMapped: false });
const domNoseMat = new THREE.MeshBasicMaterial({ color: 0x181e22, toneMapped: false });
const domSeekerMat = new THREE.MeshBasicMaterial({ color: 0xff1e00, toneMapped: false });
const domFinMat = new THREE.MeshBasicMaterial({ color: 0x1e242a, toneMapped: false });
const domTipMat = new THREE.MeshBasicMaterial({ color: 0xff3300, toneMapped: false });
const domBandMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, toneMapped: false });
const domBlackBandMat = new THREE.MeshBasicMaterial({ color: 0x0a0c0e, toneMapped: false });
const domMachMat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.85, toneMapped: false });
const domNozzleMat = new THREE.MeshBasicMaterial({ color: 0x111315, toneMapped: false });

const flameCoreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.98, toneMapped: false });
const flameMat = new THREE.MeshBasicMaterial({ color: 0xff4500, transparent: true, opacity: 0.92, toneMapped: false });
const flameOuterMat = new THREE.MeshBasicMaterial({ color: 0xff9100, transparent: true, opacity: 0.78, toneMapped: false });

const domBodyGeo = new THREE.CylinderGeometry(0.42, 0.42, 5.2, 14);
domBodyGeo.rotateX(Math.PI / 2);
const domWarheadGeo = new THREE.ConeGeometry(0.42, 2.2, 14);
domWarheadGeo.rotateX(Math.PI / 2);
const domSeekerGeo = new THREE.SphereGeometry(0.16, 10, 10);
const domBandGeo = new THREE.CylinderGeometry(0.428, 0.428, 0.28, 14);
domBandGeo.rotateX(Math.PI / 2);
const domBlackBandGeo = new THREE.CylinderGeometry(0.43, 0.43, 0.14, 14);
domBlackBandGeo.rotateX(Math.PI / 2);
const domCanardGeo = new THREE.BoxGeometry(0.05, 0.58, 0.72);
const domFinGeo = new THREE.BoxGeometry(0.06, 1.45, 1.15);
const domFinTipGeo = new THREE.BoxGeometry(0.065, 0.32, 0.32);
const domMachRingGeo = new THREE.TorusGeometry(0.55, 0.045, 6, 16);
const domNozzleGeo = new THREE.CylinderGeometry(0.28, 0.38, 0.75, 12);
domNozzleGeo.rotateX(Math.PI / 2);

const flameCoreGeo = new THREE.ConeGeometry(0.24, 2.8, 8);
flameCoreGeo.rotateX(-Math.PI / 2);
const flameGeo = new THREE.ConeGeometry(0.45, 4.4, 8);
flameGeo.rotateX(-Math.PI / 2);
const flameOuterGeo = new THREE.ConeGeometry(0.65, 5.8, 8);
flameOuterGeo.rotateX(-Math.PI / 2);

function buildDominatorModel() {
  const g = new THREE.Group();
  g.name = 'sp-missile';
  g.userData.noInk = true;
  g.userData.noOutline = true;

  const fuselage = new THREE.Mesh(domBodyGeo, domBodyMat);
  const warhead = new THREE.Mesh(domWarheadGeo, domNoseMat);
  warhead.position.z = 3.4;
  const seeker = new THREE.Mesh(domSeekerGeo, domSeekerMat);
  seeker.position.z = 4.5;
  const bandYellow1 = new THREE.Mesh(domBandGeo, domBandMat);
  bandYellow1.position.z = 1.8;
  const bandBlack1 = new THREE.Mesh(domBlackBandGeo, domBlackBandMat);
  bandBlack1.position.z = 1.8;
  const bandYellow2 = new THREE.Mesh(domBandGeo, domBandMat);
  bandYellow2.position.z = -0.6;
  const nozzle = new THREE.Mesh(domNozzleGeo, domNozzleMat);
  nozzle.position.z = -2.85;

  for (let c = 0; c < 4; c++) {
    const canard = new THREE.Mesh(domCanardGeo, domFinMat);
    canard.position.z = 1.25;
    canard.rotation.z = (c * Math.PI) / 2;
    if (c % 2 === 0) canard.position.y = (c === 0 ? 0.52 : -0.52);
    else canard.position.x = (c === 1 ? 0.52 : -0.52);
    g.add(canard);
  }

  for (let f = 0; f < 4; f++) {
    const fin = new THREE.Mesh(domFinGeo, domFinMat);
    fin.position.z = -2.15;
    fin.rotation.z = (f * Math.PI) / 2;
    if (f % 2 === 0) fin.position.y = (f === 0 ? 0.88 : -0.88);
    else fin.position.x = (f === 1 ? 0.88 : -0.88);
    const tip = new THREE.Mesh(domFinTipGeo, domTipMat);
    tip.position.z = -2.15;
    tip.rotation.z = (f * Math.PI) / 2;
    if (f % 2 === 0) tip.position.y = (f === 0 ? 1.55 : -1.55);
    else tip.position.x = (f === 1 ? 1.55 : -1.55);
    g.add(fin, tip);
  }

  g.add(fuselage, warhead, seeker, bandYellow1, bandBlack1, bandYellow2, nozzle);

  const flameCoreMesh = new THREE.Mesh(flameCoreGeo, flameCoreMat);
  flameCoreMesh.position.z = -4.1;
  const flameMesh = new THREE.Mesh(flameGeo, flameMat);
  flameMesh.position.z = -4.9;
  const flameOuterMesh = new THREE.Mesh(flameOuterGeo, flameOuterMat);
  flameOuterMesh.position.z = -5.6;
  const machRing1 = new THREE.Mesh(domMachRingGeo, domMachMat);
  machRing1.position.z = -3.6;
  const machRing2 = new THREE.Mesh(domMachRingGeo, domMachMat);
  machRing2.position.z = -4.6;
  machRing2.scale.set(1.25, 1.25, 1.25);
  g.add(flameCoreMesh, flameMesh, flameOuterMesh, machRing1, machRing2);

  return g;
}

export class SinglePlayerMissilesSystem {
  public readonly object: THREE.Group;
  private course: ICourse;
  private scanTimers: { racerId: number; gateIndex: number; timer: number }[] = [];
  private activeMissile: {
    active: boolean;
    timer: number;
    targetId: number;
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    mesh: THREE.Group;
    reticle: THREE.Group;
    locked: boolean;
  } | null = null;
  private hudNotice: (msg: string, title: string) => void;
  private playBeep: () => void;

  constructor(course: ICourse, hudNotice: (msg: string, title: string) => void, playBeep: () => void) {
    this.object = new THREE.Group();
    this.object.name = 'sp-missile-system';
    this.course = course;
    this.hudNotice = hudNotice;
    this.playBeep = playBeep;

    const mesh = buildDominatorModel();
    mesh.visible = false;
    this.object.add(mesh);

    const reticleGeo = new THREE.RingGeometry(2.5, 3.0, 16);
    const reticleMat = new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide, transparent: true, opacity: 0.8, toneMapped: false });
    const reticle = new THREE.Mesh(reticleGeo, reticleMat);
    reticle.visible = false;
    this.object.add(reticle);

    this.activeMissile = {
      active: false,
      timer: 0,
      targetId: -1,
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      mesh,
      reticle: reticle as any, // lazy group wrap
      locked: false,
    };
  }

  public onCheckpoint(racer: RacerState, gateIndex: number): void {
    // Gates 2~7 are indices 1 to 6 in CHECKPOINT_US
    if (gateIndex >= 1 && gateIndex <= 6) {
      if (racer.place === 1) {
        this.scanTimers.push({ racerId: racer.id, gateIndex, timer: 1.0 });
      }
    }
  }

  public update(dt: number, racers: readonly RacerState[], boats: readonly IBoat[]): void {
    for (let i = this.scanTimers.length - 1; i >= 0; i--) {
      const scan = this.scanTimers[i];
      scan.timer -= dt;
      if (scan.timer <= 0) {
        // scan elapsed, check if they are still Rank 1
        const racer = racers[scan.racerId];
        if (racer && racer.place === 1 && !this.activeMissile!.active && !racer.eliminated && !racer.finished) {
          this.launchMissile(scan.racerId, scan.gateIndex, boats);
        }
        this.scanTimers.splice(i, 1);
      }
    }

    if (this.activeMissile && this.activeMissile.active) {
      this.updateMissile(dt, racers, boats);
    }
  }

  private launchMissile(targetId: number, gateIndex: number, boats: readonly IBoat[]): void {
    const m = this.activeMissile!;
    m.active = true;
    m.timer = 0;
    m.targetId = targetId;
    m.locked = false;

    // Launch from gate gantry (gate coordinate + height)
    const u = CHECKPOINT_US[gateIndex];
    const spawnPt = new THREE.Vector3();
    this.course.pointAt(u, spawnPt);
    m.x = spawnPt.x;
    m.y = spawnPt.y + 25;
    m.z = spawnPt.z;

    const targetBoat = boats[targetId];
    if (targetBoat) {
      const dx = targetBoat.state.position.x - m.x;
      const dy = targetBoat.state.position.y - m.y;
      const dz = targetBoat.state.position.z - m.z;
      const dist = Math.hypot(dx, dy, dz);
      const speed = 40;
      m.vx = (dx / dist) * speed;
      m.vy = (dy / dist) * speed;
      m.vz = (dz / dist) * speed;
    }

    m.mesh.visible = true;
    m.mesh.position.set(m.x, m.y, m.z);

    // Audio and banner at t=0
    this.hudNotice('📺【收视率拯救计划】第 1 名太装了！导弹升空！', '');
    // Rocket launch audio is handled externally or just beep
    this.playBeep();
  }

  private updateMissile(dt: number, racers: readonly RacerState[], boats: readonly IBoat[]): void {
    const m = this.activeMissile!;
    m.timer += dt;

    const targetBoat = boats[m.targetId];
    if (!targetBoat || racers[m.targetId].eliminated || racers[m.targetId].finished) {
      m.active = false;
      m.mesh.visible = false;
      m.reticle.visible = false;
      return;
    }

    if (m.timer >= 0.8 && !m.locked) {
      m.locked = true;
      m.reticle.visible = true;
      this.hudNotice('⚠️ MISSILE LOCK-ON [ 2.0s ]', '');
      this.playBeep();
    }

    if (m.locked) {
      // update reticle position
      m.reticle.position.copy(targetBoat.state.position);
      m.reticle.position.y += 2.0;
      m.reticle.lookAt(this.course.object.position); // face up or something
      // For simple reticle facing:
      m.reticle.quaternion.copy(targetBoat.state.quaternion);
      // Play beep occasionally
      if (Math.floor((m.timer - dt) * 5) !== Math.floor(m.timer * 5)) {
        this.playBeep();
      }
    }

    // Guidance
    const tx = targetBoat.state.position.x;
    const ty = targetBoat.state.position.y + 1.0;
    const tz = targetBoat.state.position.z;
    const dx = tx - m.x;
    const dy = ty - m.y;
    const dz = tz - m.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const PRANK_SPEED = 65; // Terminal supersonic

    // terminal supersonic descent
    if (m.timer > 1.5) {
      const steer = Math.min(1, dt * 15.0);
      m.vx += ((dx / dist) * PRANK_SPEED - m.vx) * steer;
      m.vy += ((dy / dist) * PRANK_SPEED - m.vy) * steer;
      m.vz += ((dz / dist) * PRANK_SPEED - m.vz) * steer;
    }

    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.z += m.vz * dt;
    m.mesh.position.set(m.x, m.y, m.z);

    const dir = new THREE.Vector3(m.vx, m.vy, m.vz).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, dir).normalize();
    const newUp = new THREE.Vector3().crossVectors(dir, right).normalize();
    const mat = new THREE.Matrix4().makeBasis(right, newUp, dir);
    m.mesh.quaternion.setFromRotationMatrix(mat);

    if (m.timer >= 2.0 || dist < 4.0) {
      // IMPACT
      m.active = false;
      m.mesh.visible = false;
      m.reticle.visible = false;

      // 4. Counterplay: Drift Wake Deflection
      const isDrifting = targetBoat.state.drifting;
      if (isDrifting && m.timer >= 1.5) { // final 0.5s window
        this.hudNotice('💥 浪花诱爆！MISSILE DEFLECTED!', '');
        targetBoat.activateTechniqueBoost(); // +15% turbo short boost (technique boost is appropriate)
        targetBoat.applyScudNearMiss(m.x, m.z, 0, 0);
        return;
      }

      // Friendly Fire Shield: check other AIs
      let hitTarget = targetBoat;
      for (const otherBoat of boats) {
        if (otherBoat.id === targetBoat.id) continue;
        const otherDist = targetBoat.state.position.distanceTo(otherBoat.state.position);
        if (otherDist <= 4.5 && !racers[otherBoat.id].eliminated && !racers[otherBoat.id].isPlayer) {
          hitTarget = otherBoat;
          break;
        }
      }

      // Impact Physics: Non-fatal vertical blast vy = 17.5 m/s, 720 deg tumble spin, water geyser
      const heading = hitTarget.state.heading;
      const forwardX = Math.sin(heading) * 5.0; // small push
      const forwardZ = Math.cos(heading) * 5.0;
      hitTarget.applyScudHit(forwardX, forwardZ, 17.5);
    }
  }

  public reset(): void {
    this.scanTimers.length = 0;
    if (this.activeMissile) {
      this.activeMissile.active = false;
      this.activeMissile.mesh.visible = false;
      this.activeMissile.reticle.visible = false;
      this.activeMissile.locked = false;
    }
  }
}
