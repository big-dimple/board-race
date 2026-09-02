import * as THREE from 'three';
import type { IBoat, RacerState } from '../contracts';
import type { LocalDeviceId, LocalMultiplayerInput } from '../core/localMultiplayerInput';
import { TacticalReticle } from './tacticalReticle';

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
  kind: 'tomahawk' | 'shark';
}

export interface ReplayMissileSnapshot {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  active: boolean;
  isDwell: boolean;
  dwellProgress: number;
  kind: 'tomahawk' | 'shark';
}

const MAX_CHARGES = 7;
const COOLDOWN_S = 3.5;
const PRANK_SPEED = 58;
const PRANK_LIFETIME_S = 5.8;
const PRANK_HIT_RADIUS = 6.2;
const MAX_PROJECTILES = 4;

// Lighthouse reef launch complex position coordinates
const LAUNCH_PADS = [
  { x: 105.8, y: 1.95, z: 186.8, angle: -0.42 },
  { x: 108.4, y: 2.10, z: 185.0, angle: -0.15 },
  { x: 111.6, y: 2.10, z: 185.0, angle: 0.15 },
  { x: 114.2, y: 1.95, z: 186.8, angle: 0.42 },
] as const;

const _missileDir = new THREE.Vector3();
const _forwardZ = new THREE.Vector3(0, 0, 1);
const _scratchQuat = new THREE.Quaternion();

/**
 * Tactical Cruise Missiles and Duo Support Controller.
 * Features ultra-high-definition Dominator Tomahawk & Kawaii Chibi Shark 3D models,
 * dynamic gantry launch sequence, homing physics, and replay recording snapshots.
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
  private readonly projectileState = Array.from({ length: MAX_PROJECTILES }, (_, i) => ({
    active: false,
    actorId: -1,
    targetId: -1,
    padIndex: 0,
    kind: (i % 2 === 1 ? 'shark' : 'tomahawk') as 'tomahawk' | 'shark',
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
    blastPlume: THREE.Mesh;
    flame: THREE.Mesh;
    flameCore: THREE.Mesh;
    flameOuter?: THREE.Mesh;
    machRing1?: THREE.Mesh;
    machRing2?: THREE.Mesh;
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
    kind: 'tomahawk',
  };

  private readonly replaySnapshotsScratch: ReplayMissileSnapshot[] = Array.from({ length: MAX_PROJECTILES }, (_, i) => ({
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
    kind: (i % 2 === 1 ? 'shark' : 'tomahawk') as 'tomahawk' | 'shark',
  }));

  private readonly reticles: TacticalReticle[];
  private readonly fallbackCamera = new THREE.PerspectiveCamera();

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'duo-interaction-projectiles';
    this.object.userData.noInk = true;
    this.object.userData.noOutline = true;

    this.reticles = Array.from({ length: MAX_PROJECTILES }, () => {
      const reticle = new TacticalReticle();
      this.object.add(reticle.object);
      return reticle;
    });

    // --- High-Contrast Vibrant Materials for Dominator Dark Tactical Tomahawk ---
    const domBodyMat = new THREE.MeshBasicMaterial({ color: 0x283038, toneMapped: false });
    const domNoseMat = new THREE.MeshBasicMaterial({ color: 0x181e22, toneMapped: false });
    const domSeekerMat = new THREE.MeshBasicMaterial({ color: 0xff1e00, toneMapped: false }); // Glowing ruby red infrared seeker eye
    const domFinMat = new THREE.MeshBasicMaterial({ color: 0x1e242a, toneMapped: false });
    const domTipMat = new THREE.MeshBasicMaterial({ color: 0xff3300, toneMapped: false }); // Red warning fin tips
    const domBandMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, toneMapped: false }); // High-visibility hazard yellow
    const domBlackBandMat = new THREE.MeshBasicMaterial({ color: 0x0a0c0e, toneMapped: false });
    const domMachMat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.85, toneMapped: false });
    const domNozzleMat = new THREE.MeshBasicMaterial({ color: 0x111315, toneMapped: false });

    // --- High-Contrast Kawaii Materials for Chibi Anime Shark Banger ---
    const sharkBodyMat = new THREE.MeshBasicMaterial({ color: 0x00bcd4, toneMapped: false }); // Oceanic vibrant turquoise
    const sharkBellyMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }); // Pearl white belly
    const sharkFinMat = new THREE.MeshBasicMaterial({ color: 0x00838f, toneMapped: false }); // Deep aquatic blue fins
    const sharkEyeWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const sharkEyePupilMat = new THREE.MeshBasicMaterial({ color: 0x0d1b2a, toneMapped: false });
    const sharkEyeSparkleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const sharkBlushMat = new THREE.MeshBasicMaterial({ color: 0xff4081, toneMapped: false }); // Vivid anime pink blush
    const sharkTeethMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });

    const gantryMat = new THREE.MeshBasicMaterial({ color: 0x37474f, toneMapped: false });
    const padBaseMat = new THREE.MeshBasicMaterial({ color: 0x1c242b, toneMapped: false });
    const hazardStripeMat = new THREE.MeshBasicMaterial({ color: 0xffb300, toneMapped: false });
    const flameCoreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.98, toneMapped: false });
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xff4500, transparent: true, opacity: 0.92, toneMapped: false });
    const flameOuterMat = new THREE.MeshBasicMaterial({ color: 0xff9100, transparent: true, opacity: 0.78, toneMapped: false });

    // --- Model 1: Dominator Dark Tactical Tomahawk (2.2x Scale for crisp visibility) ---
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

    // --- Model 2: Chibi Kawaii Shark Banger (2.2x Scale) ---
    const sharkBodyGeo = new THREE.CylinderGeometry(0.62, 0.52, 4.2, 16);
    sharkBodyGeo.rotateX(Math.PI / 2);
    const sharkNoseGeo = new THREE.SphereGeometry(0.62, 14, 14);
    const sharkBellyGeo = new THREE.CylinderGeometry(0.625, 0.525, 3.5, 14, 1, false, Math.PI * 0.75, Math.PI * 0.5);
    sharkBellyGeo.rotateX(Math.PI / 2);
    const sharkDorsalFinGeo = new THREE.BoxGeometry(0.09, 0.95, 1.05);
    const sharkPectoralFinGeo = new THREE.BoxGeometry(0.95, 0.08, 0.72);
    const sharkTailFinGeo = new THREE.BoxGeometry(0.08, 1.10, 0.85);
    const sharkEyeWhiteGeo = new THREE.SphereGeometry(0.22, 10, 10);
    const sharkEyePupilGeo = new THREE.SphereGeometry(0.13, 10, 10);
    const sharkEyeSparkleGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const sharkBlushGeo = new THREE.SphereGeometry(0.15, 8, 8);
    const sharkTeethGeo = new THREE.BoxGeometry(0.42, 0.12, 0.24);

    const flameCoreGeo = new THREE.ConeGeometry(0.24, 2.8, 8);
    flameCoreGeo.rotateX(-Math.PI / 2);
    const flameGeo = new THREE.ConeGeometry(0.45, 4.4, 8);
    flameGeo.rotateX(-Math.PI / 2);
    const flameOuterGeo = new THREE.ConeGeometry(0.65, 5.8, 8);
    flameOuterGeo.rotateX(-Math.PI / 2);

    const buildDominatorModel = (includePlume: boolean) => {
      const g = new THREE.Group();
      g.name = 'scud-dominator';
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

      let flameMesh: THREE.Mesh | undefined;
      let flameCoreMesh: THREE.Mesh | undefined;
      let flameOuterMesh: THREE.Mesh | undefined;
      let machRing1: THREE.Mesh | undefined;
      let machRing2: THREE.Mesh | undefined;

      if (includePlume) {
        flameCoreMesh = new THREE.Mesh(flameCoreGeo, flameCoreMat);
        flameCoreMesh.position.z = -4.1;
        flameMesh = new THREE.Mesh(flameGeo, flameMat);
        flameMesh.position.z = -4.9;
        flameOuterMesh = new THREE.Mesh(flameOuterGeo, flameOuterMat);
        flameOuterMesh.position.z = -5.6;

        machRing1 = new THREE.Mesh(domMachRingGeo, domMachMat);
        machRing1.position.z = -3.6;
        machRing2 = new THREE.Mesh(domMachRingGeo, domMachMat);
        machRing2.position.z = -4.6;
        machRing2.scale.set(1.25, 1.25, 1.25);

        g.add(flameCoreMesh, flameMesh, flameOuterMesh, machRing1, machRing2);
      }

      return { group: g, flame: flameMesh, flameCore: flameCoreMesh, flameOuter: flameOuterMesh, machRing1, machRing2 };
    };

    const buildChibiSharkModel = (includePlume: boolean) => {
      const g = new THREE.Group();
      g.name = 'scud-chibi-shark';
      g.userData.noInk = true;
      g.userData.noOutline = true;

      const body = new THREE.Mesh(sharkBodyGeo, sharkBodyMat);
      const nose = new THREE.Mesh(sharkNoseGeo, sharkBodyMat);
      nose.position.z = 2.0;

      const belly = new THREE.Mesh(sharkBellyGeo, sharkBellyMat);
      belly.position.y = -0.08;

      // Cute big shark dorsal fin
      const dorsal = new THREE.Mesh(sharkDorsalFinGeo, sharkFinMat);
      dorsal.position.set(0, 0.88, -0.4);
      dorsal.rotation.x = -0.3;

      // Pectoral cute side fins
      const pecLeft = new THREE.Mesh(sharkPectoralFinGeo, sharkFinMat);
      pecLeft.position.set(-0.72, -0.12, 0.4);
      pecLeft.rotation.z = -0.3;
      const pecRight = new THREE.Mesh(sharkPectoralFinGeo, sharkFinMat);
      pecRight.position.set(0.72, -0.12, 0.4);
      pecRight.rotation.z = 0.3;

      // Tail fins
      const tailTop = new THREE.Mesh(sharkTailFinGeo, sharkFinMat);
      tailTop.position.set(0, 0.65, -2.4);
      tailTop.rotation.x = -0.4;
      const tailBottom = new THREE.Mesh(sharkTailFinGeo, sharkFinMat);
      tailBottom.position.set(0, -0.52, -2.4);
      tailBottom.rotation.x = 0.4;

      // Cute anime big eyes with sparkle
      const eyeL = new THREE.Mesh(sharkEyeWhiteGeo, sharkEyeWhiteMat);
      eyeL.position.set(-0.48, 0.32, 1.6);
      const pupilL = new THREE.Mesh(sharkEyePupilGeo, sharkEyePupilMat);
      pupilL.position.set(-0.55, 0.32, 1.74);
      const sparkleL = new THREE.Mesh(sharkEyeSparkleGeo, sharkEyeSparkleMat);
      sparkleL.position.set(-0.57, 0.38, 1.82);

      const eyeR = new THREE.Mesh(sharkEyeWhiteGeo, sharkEyeWhiteMat);
      eyeR.position.set(0.48, 0.32, 1.6);
      const pupilR = new THREE.Mesh(sharkEyePupilGeo, sharkEyePupilMat);
      pupilR.position.set(0.55, 0.32, 1.74);
      const sparkleR = new THREE.Mesh(sharkEyeSparkleGeo, sharkEyeSparkleMat);
      sparkleR.position.set(0.57, 0.38, 1.82);

      // Pink blush cheeks
      const blushL = new THREE.Mesh(sharkBlushGeo, sharkBlushMat);
      blushL.position.set(-0.55, -0.05, 1.35);
      const blushR = new THREE.Mesh(sharkBlushGeo, sharkBlushMat);
      blushR.position.set(0.55, -0.05, 1.35);

      // Comical shark teeth
      const teeth = new THREE.Mesh(sharkTeethGeo, sharkTeethMat);
      teeth.position.set(0, -0.32, 2.15);

      const nozzle = new THREE.Mesh(domNozzleGeo, domNozzleMat);
      nozzle.position.z = -2.4;

      g.add(body, nose, belly, dorsal, pecLeft, pecRight, tailTop, tailBottom, eyeL, pupilL, sparkleL, eyeR, pupilR, sparkleR, blushL, blushR, teeth, nozzle);

      let flameMesh: THREE.Mesh | undefined;
      let flameCoreMesh: THREE.Mesh | undefined;
      let flameOuterMesh: THREE.Mesh | undefined;

      if (includePlume) {
        flameCoreMesh = new THREE.Mesh(flameCoreGeo, flameCoreMat);
        flameCoreMesh.position.z = -3.7;
        flameMesh = new THREE.Mesh(flameGeo, flameMat);
        flameMesh.position.z = -4.5;
        flameOuterMesh = new THREE.Mesh(flameOuterGeo, flameOuterMat);
        flameOuterMesh.position.z = -5.2;
        g.add(flameCoreMesh, flameMesh, flameOuterMesh);
      }

      return { group: g, flame: flameMesh, flameCore: flameCoreMesh, flameOuter: flameOuterMesh, machRing1: undefined, machRing2: undefined };
    };

    // Construct static launch gantry battery at lighthouse reef base
    this.launchComplexGroup = new THREE.Group();
    this.launchComplexGroup.name = 'scud-launch-complex';
    this.launchComplexGroup.userData.noInk = true;
    this.launchComplexGroup.userData.noOutline = true;

    const padBoxGeo = new THREE.BoxGeometry(2.8, 0.7, 4.8);
    const hazardStripeGeo = new THREE.BoxGeometry(2.85, 0.15, 4.85);
    const railGeo = new THREE.BoxGeometry(0.36, 0.44, 6.8);
    const strutGeo = new THREE.CylinderGeometry(0.08, 0.08, 2.8, 6);

    for (let p = 0; p < LAUNCH_PADS.length; p++) {
      const padInfo = LAUNCH_PADS[p];
      const padGroup = new THREE.Group();
      padGroup.name = `scud-launch-pad-${p + 1}`;
      padGroup.position.set(padInfo.x, padInfo.y, padInfo.z);
      padGroup.rotation.y = padInfo.angle;

      const padBase = new THREE.Mesh(padBoxGeo, padBaseMat);
      padBase.position.y = 0.35;
      const hazardStripe = new THREE.Mesh(hazardStripeGeo, hazardStripeMat);
      hazardStripe.position.y = 0.65;
      padGroup.add(padBase, hazardStripe);

      const gantryRail = new THREE.Group();
      gantryRail.position.set(0, 0.9, -0.4);
      gantryRail.rotation.x = -Math.PI * 0.32; // Elevated ~58 deg launch angle

      const railBeamLeft = new THREE.Mesh(railGeo, gantryMat);
      railBeamLeft.position.x = -0.65;
      const railBeamRight = new THREE.Mesh(railGeo, gantryMat);
      railBeamRight.position.x = 0.65;
      gantryRail.add(railBeamLeft, railBeamRight);

      const strutLeft = new THREE.Mesh(strutGeo, gantryMat);
      strutLeft.position.set(-0.7, -0.8, -1.2);
      strutLeft.rotation.x = 0.4;
      const strutRight = new THREE.Mesh(strutGeo, gantryMat);
      strutRight.position.set(0.7, -0.8, -1.2);
      strutRight.rotation.x = 0.4;
      padGroup.add(strutLeft, strutRight);

      // Alternating static missile styles across gantry pads
      const isChibi = p % 2 === 1;
      const staticScud = isChibi ? buildChibiSharkModel(false) : buildDominatorModel(false);
      staticScud.group.position.set(0, 0.45, 0.6);
      gantryRail.add(staticScud.group);
      this.staticMissiles.push(staticScud.group);

      padGroup.add(gantryRail);
      this.launchComplexGroup.add(padGroup);
    }
    this.object.add(this.launchComplexGroup);

    const blastPlumeGeo = new THREE.SphereGeometry(2.4, 14, 14);
    const blastPlumeMat = new THREE.MeshBasicMaterial({ color: 0xff5500, transparent: true, opacity: 0.95, toneMapped: false });

    // Active in-flight missile visual projectiles (alternating styles)
    for (let index = 0; index < MAX_PROJECTILES; index++) {
      const group = new THREE.Group();
      group.name = `duo-interaction-scud-${index + 1}`;
      group.userData.noInk = true;
      group.userData.noOutline = true;

      const isChibi = index % 2 === 1;
      const { group: missileMeshGroup, flame, flameCore, flameOuter, machRing1, machRing2 } = isChibi ? buildChibiSharkModel(true) : buildDominatorModel(true);

      const blastPlume = new THREE.Mesh(blastPlumeGeo, blastPlumeMat.clone());
      blastPlume.visible = false;

      group.add(missileMeshGroup, blastPlume);
      group.visible = false;
      this.object.add(group);
      this.projectileVisuals.push({
        group,
        body: missileMeshGroup,
        blastPlume,
        flame: flame!,
        flameCore: flameCore!,
        flameOuter,
        machRing1,
        machRing2,
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
    this.activeMissileScratch.kind = shot.kind;
    return this.activeMissileScratch;
  }

  getAllActiveMissiles(): readonly ReplayMissileSnapshot[] {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const shot = this.projectileState[i];
      const snap = this.replaySnapshotsScratch[i];
      snap.active = shot.active;
      snap.kind = shot.kind;
      snap.isDwell = shot.isDwell;
      snap.dwellProgress = shot.isDwell ? Math.max(0, 1 - shot.dwellTimer / 0.85) : 0;
      snap.x = shot.x;
      snap.y = shot.y;
      snap.z = shot.z;

      if (shot.active) {
        const speed = Math.hypot(shot.vx, shot.vy, shot.vz) || 1;
        _missileDir.set(shot.vx / speed, shot.vy / speed, shot.vz / speed).normalize();
        _scratchQuat.setFromUnitVectors(_forwardZ, _missileDir);
        snap.qx = _scratchQuat.x;
        snap.qy = _scratchQuat.y;
        snap.qz = _scratchQuat.z;
        snap.qw = _scratchQuat.w;
      }
    }
    return this.replaySnapshotsScratch;
  }

  syncReplayVisuals(snapshots: readonly ReplayMissileSnapshot[]): void {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const snap = snapshots[i];
      const visual = this.projectileVisuals[i];
      if (!snap || !snap.active) {
        visual.group.visible = false;
        continue;
      }
      visual.group.visible = true;
      if (snap.isDwell) {
        visual.body.visible = false;
        visual.blastPlume.visible = true;
        const scale = 1.6 + snap.dwellProgress * 11.0;
        visual.blastPlume.scale.set(scale, scale * 1.9, scale);
        visual.blastPlume.position.set(snap.x, Math.max(0.6, snap.y), snap.z);
        (visual.blastPlume.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - snap.dwellProgress * 1.12);
      } else {
        visual.body.visible = true;
        visual.blastPlume.visible = false;
        visual.group.position.set(snap.x, snap.y, snap.z);
        visual.group.quaternion.set(snap.qx, snap.qy, snap.qz, snap.qw);
      }
    }
  }

  hideAllVisuals(): void {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.projectileVisuals[i].group.visible = false;
    }
  }

  launchPrankMissile(actorId: number, targetId: number, preferredStyle?: 'tomahawk' | 'shark'): boolean {
    const shot = this.projectileState.find((item) => !item.active);
    if (!shot) return false;

    const padIndex = this.counts.prank % LAUNCH_PADS.length;
    const pad = LAUNCH_PADS[padIndex];
    const spawnX = pad.x;
    const spawnY = pad.y + 1.2;
    const spawnZ = pad.z;

    const launchAngle = pad.angle;
    const elev = 0.32 * Math.PI; // 58 deg launch inclination
    const railDirX = Math.sin(launchAngle) * Math.cos(elev);
    const railDirY = Math.sin(elev);
    const railDirZ = -Math.cos(launchAngle) * Math.cos(elev);

    const initSpeed = 12.0;

    shot.active = true;
    shot.actorId = actorId;
    shot.targetId = targetId;
    shot.padIndex = padIndex;
    shot.kind = preferredStyle ?? (padIndex % 2 === 1 ? 'shark' : 'tomahawk');
    shot.x = spawnX;
    shot.y = spawnY;
    shot.z = spawnZ;
    shot.vx = railDirX * initSpeed;
    shot.vy = railDirY * initSpeed;
    shot.vz = railDirZ * initSpeed;
    shot.age = 0;
    shot.isDwell = false;
    shot.dwellTimer = 0;

    for (let i = 0; i < 16; i++) {
      shot.historyX[i] = spawnX;
      shot.historyY[i] = spawnY;
      shot.historyZ[i] = spawnZ;
    }

    if (this.staticMissiles[padIndex]) {
      this.staticMissiles[padIndex].visible = false;
    }

    this.syncProjectileVisual(this.projectileState.indexOf(shot), shot);
    return true;
  }

  update(
    dt: number,
    racers: readonly RacerState[],
    boats: readonly IBoat[],
    devices: readonly [LocalDeviceId, LocalDeviceId] | null,
    input: LocalMultiplayerInput | null,
    emit: (event: DuoInteractionEvent) => void,
    camera?: THREE.Camera,
  ): void {
    this.updateProjectiles(dt, racers, boats, emit, camera);
    if (!devices || !input) return;

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
        const launched = this.launchPrankMissile(actor, target);
        if (launched) {
          this.consumeCharge(actor);
          emit({ actorId: actor, targetId: target, action, phase: 'prank-launch', accepted: true, chargesLeft: this.charges[actor] });
        }
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
    camera?: THREE.Camera,
  ): void {
    for (let index = 0; index < MAX_PROJECTILES; index++) {
      const shot = this.projectileState[index];
      if (!shot.active) {
        this.projectileVisuals[index].group.visible = false;
        this.reticles[index].setVisible(false);
        continue;
      }

      // If in post-impact dwell, countdown before releasing projectile
      if (shot.isDwell) {
        shot.dwellTimer -= dt;
        this.projectileVisuals[index].group.visible = true;
        this.reticles[index].setVisible(false);
        if (shot.dwellTimer <= 0) {
          shot.active = false;
          shot.isDwell = false;
          this.projectileVisuals[index].group.visible = false;
          if (this.staticMissiles[shot.padIndex]) {
            this.staticMissiles[shot.padIndex].visible = true;
          }
        } else {
          this.syncProjectileVisual(index, shot);
        }
        continue;
      }

      shot.age += dt;
      const targetBoat = boats[shot.targetId];
      const targetState = racers[shot.targetId];
      if (!targetBoat || !targetState || targetState.eliminated || targetState.finished || shot.age > PRANK_LIFETIME_S) {
        shot.active = false;
        this.projectileVisuals[index].group.visible = false;
        this.reticles[index].setVisible(false);
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

      // Update tactical holographic reticle on target boat
      const activeCam = camera ?? this.fallbackCamera;
      this.reticles[index].setVisible(true);
      this.reticles[index].update({
        targetPos: targetBoat.state.position,
        targetQuat: targetBoat.state.quaternion,
        distance,
        timeRemaining: Math.max(0, PRANK_LIFETIME_S - shot.age),
        isEvadeWindow: distance < 25 || shot.age > 2.8,
        isPlayer: Boolean(targetState?.isPlayer),
        state: 'approaching',
        elapsed: shot.age,
      }, activeCam);

      // Proportional homing guidance towards target boat
      if (shot.age < 0.45) {
        // Initial ignition climb phase from lighthouse battery
        shot.vy += (-9.8 + 38.0) * dt;
        const horizDist = Math.hypot(dx, dz) || 1;
        const steer = dt * 5.0;
        shot.vx += ((dx / horizDist) * PRANK_SPEED - shot.vx) * steer;
        shot.vz += ((dz / horizDist) * PRANK_SPEED - shot.vz) * steer;
      } else {
        // High-agility terminal cruise homing phase
        const desiredX = (dx / distance) * PRANK_SPEED;
        const desiredY = (dy / distance) * PRANK_SPEED;
        const desiredZ = (dz / distance) * PRANK_SPEED;
        const steer = Math.min(1, dt * 11.5);
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
        (hitDistHoriz <= PRANK_HIT_RADIUS && hitDistVert <= 7.5) ||
        (shot.age > 0.8 && directDist <= 8.5 && (shot.vx * (tx - shot.x) + shot.vz * (tz - shot.z) < 0));

      if (reachedTarget) {
        this.reticles[index].setVisible(false);
        // 90% Base precision hit rate; ONLY true water surface drifting grants 50% dodge exemption.
        // Airborne/flying/jumping/cruising is ALWAYS 90% direct hit & blast out of the sky!
        const isSurfaceDrifting = targetBoat.state.drifting && targetBoat.state.flightPhase === 'surface' && !targetBoat.state.airborne && targetBoat.state.speed > 8.0;
        const hitProbability = isSurfaceDrifting ? 0.45 : 0.90;
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
        shot.dwellTimer = 0.85; // 0.85s dwell for dramatic explosion viewing
        this.syncProjectileVisual(index, shot);
      } else {
        this.syncProjectileVisual(index, shot);
      }
    }
  }

  private syncProjectileVisual(index: number, shot: (typeof this.projectileState)[number]): void {
    const visual = this.projectileVisuals[index];
    visual.group.visible = shot.active;
    if (!shot.active) return;

    if (shot.isDwell) {
      // Dynamic water surface fireball & geyser plume expansion during dwell
      visual.body.visible = false;
      visual.blastPlume.visible = true;
      const progress = 1 - shot.dwellTimer / 0.85;
      const scale = 1.6 + progress * 11.0;
      visual.blastPlume.scale.set(scale, scale * 1.9, scale);
      visual.blastPlume.position.set(shot.x, Math.max(0.6, shot.y), shot.z);
      (visual.blastPlume.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - progress * 1.12);
      return;
    }

    visual.body.visible = true;
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
    if (visual.machRing1 && visual.machRing2) {
      const ringPulse = 1 + Math.sin(shot.age * 40) * 0.15;
      visual.machRing1.scale.set(ringPulse, ringPulse, ringPulse);
      visual.machRing2.scale.set(ringPulse * 1.1, ringPulse * 1.1, ringPulse * 1.1);
    }
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
