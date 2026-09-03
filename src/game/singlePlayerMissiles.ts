import * as THREE from 'three';
import type { IBoat, RacerState, ICourse } from '../contracts';
import type { ReplayMissileSnapshot } from './duoInteraction';
import { CHECKPOINT_US } from './course';
import { TacticalReticle } from './tacticalReticle';

const TOTAL_LIFETIME = 4.2;

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

export interface SinglePlayerMissileTelemetry {
  active: boolean;
  targetedPlayer: boolean;
  targetId: number;
  missilePos: THREE.Vector3;
  missileDir: THREE.Vector3;
  targetPos: THREE.Vector3;
  distance: number;
  timeRemaining: number;
  isEvadeWindow: boolean;
  state: 'idle' | 'approaching' | 'deflected' | 'hit';
  dismissTimer: number;
}

export class SinglePlayerMissilesSystem {
  public readonly object: THREE.Group;
  private course: ICourse;
  private scanTimers: { racerId: number; gateIndex: number; timer: number }[] = [];
  private activeMissile: {
    active: boolean;
    timer: number;
    targetId: number;
    isPlayer: boolean;
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    mesh: THREE.Group;
    tacticalReticle: TacticalReticle;
    locked: boolean;
    state: 'idle' | 'approaching' | 'deflected' | 'hit';
    dismissTimer: number;
  } | null = null;
  private hudNotice: (msg: string, title: string) => void;
  private onMissileAudio: (kind: 'launch' | 'lock' | 'tracking') => void;
  private readonly fallbackCamera = new THREE.PerspectiveCamera();

  private telemetry: SinglePlayerMissileTelemetry = {
    active: false,
    targetedPlayer: false,
    targetId: -1,
    missilePos: new THREE.Vector3(),
    missileDir: new THREE.Vector3(0, 0, 1),
    targetPos: new THREE.Vector3(),
    distance: 0,
    timeRemaining: 0,
    isEvadeWindow: false,
    state: 'idle',
    dismissTimer: 0,
  };

  constructor(course: ICourse, hudNotice: (msg: string, title: string) => void, onMissileAudio: (kind: 'launch' | 'lock' | 'tracking') => void) {
    this.object = new THREE.Group();
    this.object.name = 'sp-missile-system';
    this.course = course;
    this.hudNotice = hudNotice;
    this.onMissileAudio = onMissileAudio;

    const mesh = buildDominatorModel();
    mesh.visible = false;
    this.object.add(mesh);

    const tacticalReticle = new TacticalReticle();
    this.object.add(tacticalReticle.object);

    this.activeMissile = {
      active: false,
      timer: 0,
      targetId: -1,
      isPlayer: false,
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      mesh,
      tacticalReticle,
      locked: false,
      state: 'idle',
      dismissTimer: 0,
    };
  }

  private readonly replaySnapshotsScratch: ReplayMissileSnapshot[] = [
    {
      x: 0,
      y: 0,
      z: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      active: false,
      isDwell: false,
      dwellProgress: 0,
      kind: 'tomahawk',
    },
  ];

  public getAllActiveMissiles(): readonly ReplayMissileSnapshot[] {
    const snap = this.replaySnapshotsScratch[0];
    if (this.activeMissile && this.activeMissile.active) {
      const m = this.activeMissile;
      snap.x = m.x;
      snap.y = m.y;
      snap.z = m.z;
      snap.qx = m.mesh.quaternion.x;
      snap.qy = m.mesh.quaternion.y;
      snap.qz = m.mesh.quaternion.z;
      snap.qw = m.mesh.quaternion.w;
      snap.active = true;
      snap.isDwell = m.dismissTimer > 0;
      snap.dwellProgress = m.dismissTimer > 0 ? (1 - m.dismissTimer / 0.9) : 0;
      snap.kind = 'tomahawk';
    } else {
      snap.active = false;
      snap.isDwell = false;
      snap.dwellProgress = 0;
    }
    return this.replaySnapshotsScratch;
  }

  public syncReplayVisuals(snapshots: readonly ReplayMissileSnapshot[]): void {
    const snap = snapshots[0];
    if (!this.activeMissile) return;
    if (!snap || !snap.active) {
      this.activeMissile.mesh.visible = false;
      this.activeMissile.tacticalReticle.setVisible(false);
      return;
    }
    this.activeMissile.mesh.visible = true;
    this.activeMissile.mesh.position.set(snap.x, snap.y, snap.z);
    this.activeMissile.mesh.quaternion.set(snap.qx, snap.qy, snap.qz, snap.qw);
  }

  public hideAllVisuals(): void {
    if (this.activeMissile) {
      this.activeMissile.mesh.visible = false;
      this.activeMissile.tacticalReticle.setVisible(false);
    }
  }

  public getTelemetry(): SinglePlayerMissileTelemetry {
    return this.telemetry;
  }

  public onCheckpoint(racer: RacerState, gateIndex: number): void {
    // Gates 2~7 are indices 1 to 6 in CHECKPOINT_US
    if (gateIndex >= 1 && gateIndex <= 6) {
      if (racer.place === 1) {
        this.scanTimers.push({ racerId: racer.id, gateIndex, timer: 1.0 });
      }
    }
  }

  public update(dt: number, racers: readonly RacerState[], boats: readonly IBoat[], camera?: THREE.Camera): void {
    for (let i = this.scanTimers.length - 1; i >= 0; i--) {
      const scan = this.scanTimers[i];
      scan.timer -= dt;
      if (scan.timer <= 0) {
        const racer = racers[scan.racerId];
        const targetBoat = boats[scan.racerId];
        // CRITICAL: Only target when the leader is on the WATER SURFACE (never during airborne flight)
        const isSurface = targetBoat && targetBoat.state.flightPhase === 'surface' && targetBoat.state.flightRouteState === 'idle';

        if (racer && racer.place === 1 && !racer.eliminated && !racer.finished) {
          if (isSurface) {
            if (!this.activeMissile!.active) {
              this.launchMissile(scan.racerId, scan.gateIndex, racers, boats);
            }
            this.scanTimers.splice(i, 1);
          } else {
            // Still in flight: wait 0.5s and check again until safely landed on water
            scan.timer = 0.5;
          }
        } else {
          this.scanTimers.splice(i, 1);
        }
      }
    }

    if (this.activeMissile && this.activeMissile.active) {
      this.updateMissile(dt, racers, boats, camera);
    } else {
      this.telemetry.active = false;
      this.telemetry.state = 'idle';
    }
  }

  private launchMissile(targetId: number, gateIndex: number, racers: readonly RacerState[], boats: readonly IBoat[]): void {
    const m = this.activeMissile!;
    m.active = true;
    m.timer = 0;
    m.targetId = targetId;
    m.isPlayer = Boolean(racers[targetId]?.isPlayer);
    m.locked = false;
    m.state = 'approaching';
    m.dismissTimer = 0;

    // Launch from lighthouse reef missile battery base
    m.x = 114.2;
    m.y = 4.5;
    m.z = 186.8;

    const targetBoat = boats[targetId];
    if (targetBoat) {
      const dx = targetBoat.state.position.x - m.x;
      const dz = targetBoat.state.position.z - m.z;
      const horizDist = Math.hypot(dx, dz) || 1;
      const horizSpeed = 38.0;
      m.vx = (dx / horizDist) * horizSpeed;
      m.vy = 28.0; // Initial ignition climb from lighthouse
      m.vz = (dz / horizDist) * horizSpeed;
    }

    m.mesh.visible = true;
    m.mesh.position.set(m.x, m.y, m.z);

    // Only broadcast notice & sound alarm if the player is targeted!
    if (m.isPlayer) {
      this.hudNotice('灯塔防空发射拦截飞弹锁定领跑者', '🚀 防空启动 · 飞弹来袭！');
      this.onMissileAudio('launch');
    }
  }

  private updateMissile(dt: number, racers: readonly RacerState[], boats: readonly IBoat[], camera?: THREE.Camera): void {
    const m = this.activeMissile!;

    if (m.dismissTimer > 0) {
      m.dismissTimer -= dt;
      this.telemetry.active = true;
      this.telemetry.state = m.state;
      this.telemetry.dismissTimer = m.dismissTimer;
      if (m.dismissTimer <= 0) {
        m.active = false;
        m.mesh.visible = false;
        m.tacticalReticle.setVisible(false);
        this.telemetry.active = false;
        this.telemetry.state = 'idle';
      }
      return;
    }

    m.timer += dt;

    const targetBoat = boats[m.targetId];
    if (!targetBoat || racers[m.targetId]?.eliminated || racers[m.targetId]?.finished) {
      m.active = false;
      m.mesh.visible = false;
      m.tacticalReticle.setVisible(false);
      this.telemetry.active = false;
      this.telemetry.state = 'idle';
      return;
    }

    if (m.timer >= 1.0 && !m.locked) {
      m.locked = true;
      m.tacticalReticle.setVisible(true);
      if (m.isPlayer) {
        this.hudNotice('准备入弯漂移诱爆飞弹', '⚠️ 拦截飞弹已锁定！');
        this.onMissileAudio('lock');
      }
    }

    // Guidance towards target boat
    const tx = targetBoat.state.position.x;
    const ty = targetBoat.state.position.y + 0.8;
    const tz = targetBoat.state.position.z;
    const dx = tx - m.x;
    const dy = ty - m.y;
    const dz = tz - m.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const TRACK_SPEED = 52; // Steady readable speed

    if (m.locked) {
      const activeCam = camera ?? this.fallbackCamera;
      m.tacticalReticle.update({
        targetPos: targetBoat.state.position,
        targetQuat: targetBoat.state.quaternion,
        distance: dist,
        timeRemaining: Math.max(0, TOTAL_LIFETIME - m.timer),
        isEvadeWindow: m.timer >= 2.8 && m.timer < TOTAL_LIFETIME,
        isPlayer: m.isPlayer,
        state: m.state,
        elapsed: m.timer,
      }, activeCam);
      if (m.isPlayer && Math.floor((m.timer - dt) * 3) !== Math.floor(m.timer * 3)) {
        this.onMissileAudio('tracking');
      }
    }

    // Climb arc in first 1.0s from lighthouse, then homing dive
    if (m.timer < 1.0) {
      m.vy = Math.max(8.0, 28.0 - m.timer * 22.0);
    } else {
      const steer = Math.min(1, dt * 8.0);
      m.vx += ((dx / dist) * TRACK_SPEED - m.vx) * steer;
      m.vy += ((dy / dist) * TRACK_SPEED - m.vy) * steer;
      m.vz += ((dz / dist) * TRACK_SPEED - m.vz) * steer;
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

    // Telemetry update: 4.2s total lifecycle, final 1.2s is evade window
    this.telemetry.active = true;
    this.telemetry.targetedPlayer = m.isPlayer;
    this.telemetry.targetId = m.targetId;
    this.telemetry.missilePos.set(m.x, m.y, m.z);
    this.telemetry.missileDir.copy(dir);
    this.telemetry.targetPos.copy(targetBoat.state.position);
    this.telemetry.distance = dist;
    this.telemetry.timeRemaining = Math.max(0, TOTAL_LIFETIME - m.timer);
    this.telemetry.isEvadeWindow = m.timer >= 3.0 && m.timer < TOTAL_LIFETIME;
    this.telemetry.state = 'approaching';
    this.telemetry.dismissTimer = 0;

    if (m.timer >= TOTAL_LIFETIME || dist < 4.0) {
      // 1. AIRBORNE IMMUNITY: If target is in flight or airborne, missile CANNOT hit!
      const isAirborne = targetBoat.state.flightPhase !== 'surface' || targetBoat.state.airborne || targetBoat.state.position.y > 1.2;
      if (isAirborne) {
        if (m.isPlayer) this.hudNotice('千钧一发凌空拔起脱离制导！', '🌊 万幸腾空 · 绝妙闪避！');
        targetBoat.applyScudNearMiss(m.x, m.z, 0, 0);
        m.state = 'deflected';
        m.dismissTimer = 1.1;
        m.mesh.visible = false;
        m.tacticalReticle.setVisible(false);
        return;
      }

      // 2. Counterplay: Drift Wake Deflection
      const isDrifting = targetBoat.state.drifting;
      if (isDrifting && m.timer >= 2.8) {
        if (m.isPlayer) this.hudNotice('掀起水幕诱爆飞弹 · 获得涡轮冲刺！', '👑 神技诱爆 · 极限反击！');
        targetBoat.activateTechniqueBoost();
        targetBoat.applyScudNearMiss(m.x, m.z, 0, 0);
        m.state = 'deflected';
        m.dismissTimer = 1.1;
        m.mesh.visible = false;
        m.tacticalReticle.setVisible(false);
        return;
      }

      // 3. Friendly Fire Shield: check other AIs
      let hitTarget = targetBoat;
      for (const otherBoat of boats) {
        if (otherBoat.id === targetBoat.id) continue;
        const otherDist = targetBoat.state.position.distanceTo(otherBoat.state.position);
        if (otherDist <= 5.0 && !racers[otherBoat.id]?.eliminated && !racers[otherBoat.id]?.isPlayer) {
          hitTarget = otherBoat;
          break;
        }
      }

      // 4. Impact execution
      hitTarget.applyScudHit(0, 0, 14.0);

      if (hitTarget.id !== targetBoat.id) {
        // Successfully led missile into opponent!
        if (m.isPlayer) this.hudNotice('极限走位引诱飞弹轰飞对手！', '🎯 借刀炸人 · 走位成仙！');
        m.state = 'deflected';
      } else {
        if (m.isPlayer) this.hudNotice('受到水浪冲击 · 保持操舵！', '⚠️ 飞弹冲击警报');
        m.state = 'hit';
      }
      m.dismissTimer = 1.1;
      m.mesh.visible = false;
      m.tacticalReticle.setVisible(false);
    }
  }

  public reset(): void {
    this.scanTimers.length = 0;
    if (this.activeMissile) {
      this.activeMissile.active = false;
      this.activeMissile.mesh.visible = false;
      this.activeMissile.tacticalReticle.setVisible(false);
      this.activeMissile.locked = false;
      this.activeMissile.state = 'idle';
      this.activeMissile.dismissTimer = 0;
    }
    this.telemetry.active = false;
    this.telemetry.state = 'idle';
  }
}
