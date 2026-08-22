/**
 * rider.ts — procedural cel-shaded rider with a code-driven forward-kinematic rig.
 *
 * One `Rider` is parented to `boat.riderMount` (+Z = boat forward, +Y = up).
 * The character is built from primitives only (no external assets), posed in a
 * permanent riding crouch, and animated purely from `BoatState` each frame:
 *
 *   - lean into turns ∝ lateralG (head counter-lean, inside-knee flare)
 *   - weight shift ∝ longG (pitch back on accel, hunch on braking)
 *   - drift hip twist, throttle wrist, rpm vibration
 *   - airborne "whee" pose, springy landing crouch on landImpulse
 *   - idle breathing + secondary motion lagging the boat's pitch/roll
 *   - celebration loop (arm pumps, head nod) blended in over ~0.4s
 *
 * All animation state lives in a handful of scalar damped springs; update()
 * applies DELTA rotations on top of the baked rest pose. Zero per-frame
 * allocation; stable at fixed dt = 1/60.
 */
import * as THREE from 'three';
import { LAYER_INK, markInk, type BoatState } from '../contracts';
import { addOutline } from '../cel/outline';
import { buildSkinnedRider, updateSkinnedRiderColor, type RiderBones, type RiderLook, type RiderSkin } from './riderMesh';

// ------------------------------------------------------------- tuning ----
// Every number a polish pass might want to touch lives here. Angles in
// radians, frequencies in Hz, spring omegas in rad/s (zeta: 1 = critical).
const TUNING = {
  // Lean into turns: 28° max, reached at ~1g lateral.
  leanMax: 0.49,          // ~28°
  leanGRef: 9.8,          // lateralG that maps to full lean
  leanSign: -1,           // flip if lean goes the wrong way on screen
  leanOmega: 8, leanZeta: 0.95,
  leanHips: 0.45, leanSpine: 0.55, leanChest: 0.15, // distribution up the chain
  headCounter: 0.35,      // head counter-lean fraction
  kneeFlare: 0.55,        // inside knee opens this much at full lean
  elbowDrop: 0.4,         // outside elbow drops this much at full lean

  // Weight shift from longG: pitch back on hard accel, hunch on braking.
  pitchPerG: 0.032, pitchMax: 0.22,
  pitchOmega: 6, pitchZeta: 1,

  // Drift: hips twist into the slide.
  driftTwist: 0.45, driftSign: 1,
  driftOmega: 8, driftZeta: 1,

  // Controls: throttle wrist twist + speed/rpm vibration on the arms.
  throttleWrist: 0.5,
  vibAmp: 0.014, vibF1: 47, vibF2: 31.3,

  // Airborne "whee" pose.
  airOmega: 6, airZeta: 1,
  airArmRise: 0.28, airElbowTuck: 0.2, airLegExtend: 0.22,
  airBodyOpen: 0.16, airHeadUp: 0.2,

  // Controlled anti-gravity flight: a compact, braced pose rather than the
  // natural-airborne "whee" animation used for wave jumps.
  flightOmega: 7, flightZeta: 1,
  flightHipsDrop: 0.08, flightHunch: 0.12,
  flightArmBrace: 0.08, flightKnee: 0.14,

  // Landing crouch: kicked by landImpulse (m/s), springy ~0.4s recovery.
  landKick: 0.05, landMax: 1.2,
  landOmega: 16, landZeta: 0.35,
  landHipsDrop: 0.16, landSpine: 0.45, landKnee: 0.6, landHip: 0.35,

  // Idle: breathing + secondary motion lagging boat pitch/roll.
  breathHz: 0.35, breathAmp: 0.03, breathBob: 0.008,
  followOmega: 3.5, followZeta: 1, followGain: 0.6, followMax: 0.12,
  lockSpeed: 12,          // m/s where idle bob is fully replaced by bracing
  braceShoulder: 0.08, braceElbow: 0.06,
  armTuck: 0.22,          // constant shoulder z-tuck: arms angle in to the grips

  // Celebration: ~0.4s blend in, loops while `celebrating`.
  celOmega: 7, celZeta: 1,
  pumpHz: 1.7, pumpAmp: 0.45, pumpRaise: -2.3,
  celLeftRaise: -2.1, celLeftLag: 0.9, // both hands off the bar at the line
  celNodHz: 0.9, celNodAmp: 0.12,
  celUpright: 0.35,

  // Head-look into the steering direction: the rider eyes the corner, not
  // the bow. Small, damped, suppressed while celebrating or taunting.
  headSteerLook: 0.3,

  // Taunt: a alongside rival gets a square head turn for ~1.6s, then a long
  // personal cooldown keeps it a spice, not a loop. No raised fist — the
  // whole grid pumping one arm read as a mechanical puppet wave.
  tauntOmega: 9, tauntZeta: 1,
  tauntSeconds: 1.6, tauntCooldown: 8,
  tauntHeadYaw: 0.95,
} as const;

// Rest pose (baked into joint positions, meters). Standing racing crouch at
// the helm: hips back, knees bent into the footwells, torso hinged FORWARD
// (hunchSpine/hunchChest, applied in update()), arms reaching down-forward so
// the hands land on the grips (~±0.26, 0.37, 0.40 in mount space — the bar
// height). Rider's left = +X.
const POSE = {
  hips: [0, 0.58, -0.22],
  spine: [0, 0.13, 0.05],
  chest: [0, 0.19, 0.09],
  head: [0, 0.2, 0.1],
  shoulderL: [0.2, 0.1, 0.03],
  elbowL: [0.045, -0.129, 0.293],
  handL: [-0.02, -0.17, 0.345],
  hipL: [0.11, -0.03, 0.05],
  kneeL: [0.09, -0.2, 0.26],
  footL: [-0.05, -0.28, 0.1],
  hunchSpine: 0.42,       // baked forward hinge at the waist (rad, pitch down)
  hunchChest: 0.18,       // extra hinge at the chest — together ~34°
  headTiltUp: -0.72,      // baked head.rotation.x: un-hunches the neck, eyes up over the bow
} as const;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Scalar damped spring. Semi-implicit Euler — rock solid at dt = 1/60. */
class Spring {
  x = 0;
  v = 0;
  update(target: number, omega: number, zeta: number, dt: number): number {
    const a = omega * omega * (target - this.x) - 2 * zeta * omega * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

type Rig = RiderBones;

export class Rider {
  readonly object: THREE.Object3D;

  private readonly j: Rig;
  private readonly hipsBaseY: number;
  private readonly skin: RiderSkin;

  // Animation state (scalar springs).
  private readonly leanS = new Spring();
  private readonly pitchS = new Spring();
  private readonly driftS = new Spring();
  private readonly airS = new Spring();
  private readonly flightS = new Spring();
  private readonly crouchS = new Spring();
  private readonly celS = new Spring();
  private readonly tauntS = new Spring();
  private readonly boatPitchS = new Spring();
  private readonly boatRollS = new Spring();
  private tauntRemaining = 0;
  private tauntCooldownUntil = 0;
  private tauntSide = 1;
  /** Per-rider animation phase so six riders never breathe or buzz in sync. */
  private readonly phase: number;

  // Scratch (no per-frame allocation).
  private readonly tmp = new THREE.Vector3();

  constructor(opts: { color: number; detailedInk?: boolean; look: RiderLook; phase?: number }) {
    this.phase = opts.phase ?? 0;
    const root = new THREE.Group();
    root.name = 'rider';

    const joint = (parent: THREE.Object3D, name: string, p: readonly number[], mirror = 1): THREE.Bone => {
      const o = new THREE.Bone();
      o.name = name;
      o.position.set(p[0] * mirror, p[1], p[2]);
      parent.add(o);
      return o;
    };

    // ------------------------------------------------------ skeleton ----
    const hips = joint(root, 'hips', POSE.hips);
    const spine = joint(hips, 'spine', POSE.spine);
    const chest = joint(spine, 'chest', POSE.chest);
    const head = joint(chest, 'head', POSE.head);
    head.rotation.x = POSE.headTiltUp;
    const shoulderL = joint(chest, 'shoulderL', POSE.shoulderL);
    const shoulderR = joint(chest, 'shoulderR', POSE.shoulderL, -1);
    const elbowL = joint(shoulderL, 'elbowL', POSE.elbowL);
    const elbowR = joint(shoulderR, 'elbowR', POSE.elbowL, -1);
    const handL = joint(elbowL, 'handL', POSE.handL);
    const handR = joint(elbowR, 'handR', POSE.handL, -1);
    const hipL = joint(hips, 'hipL', POSE.hipL);
    const hipR = joint(hips, 'hipR', POSE.hipL, -1);
    const kneeL = joint(hipL, 'kneeL', POSE.kneeL);
    const kneeR = joint(hipR, 'kneeR', POSE.kneeL, -1);
    const footL = joint(kneeL, 'footL', POSE.footL);
    const footR = joint(kneeR, 'footR', POSE.footL, -1);
    this.j = { hips, spine, chest, head, shoulderL, shoulderR, elbowL, elbowR, handL, handR, hipL, hipR, kneeL, kneeR, footL, footR };
    this.hipsBaseY = hips.position.y;
    this.skin = buildSkinnedRider(root, this.j, opts.color, opts.detailedInk !== false, opts.look);
    if (opts.detailedInk !== false) {
      addOutline(root);
      markInk(root);
    } else {
      this.skin.mesh.layers.enable(LAYER_INK);
    }
    this.object = root;
  }

  setColor(color: number, look: RiderLook): void {
    updateSkinnedRiderColor(this.skin, color, look);
  }

  /**
   * Flash a rival alongside: the head turns their way. Presentation-only;
   * long cooldown keeps races from becoming stare loops.
   */
  taunt(side: number, now: number): void {
    if (now < this.tauntCooldownUntil || this.tauntRemaining > 0) return;
    this.tauntSide = side >= 0 ? 1 : -1;
    this.tauntRemaining = TUNING.tauntSeconds;
    this.tauntCooldownUntil = now + TUNING.tauntSeconds + TUNING.tauntCooldown;
  }

  /** dt is fixed 1/60. Applies delta rotations on top of the baked rest pose. */
  update(dt: number, boat: BoatState, t: number, celebrating: boolean): void {
    const T = TUNING;
    const j = this.j;

    // -------------------------------------------------- target state ----
    const leanT = T.leanSign * clamp(boat.lateralG / T.leanGRef, -1, 1) * T.leanMax;
    const pitchT = clamp(-boat.longG * T.pitchPerG, -T.pitchMax, T.pitchMax);
    const driftT = boat.drifting ? T.driftSign * boat.steer * T.driftTwist : 0;
    const airT = boat.airborne ? 1 : 0;
    const flightT = boat.flightPhase !== 'surface' ? 1 : 0;
    const celT = celebrating ? 1 : 0;

    const lean = this.leanS.update(leanT, T.leanOmega, T.leanZeta, dt);
    const pitch = this.pitchS.update(pitchT, T.pitchOmega, T.pitchZeta, dt);
    const drift = this.driftS.update(driftT, T.driftOmega, T.driftZeta, dt);
    const air = this.airS.update(airT, T.airOmega, T.airZeta, dt);
    const flight = this.flightS.update(flightT, T.flightOmega, T.flightZeta, dt);
    const cel = this.celS.update(celT, T.celOmega, T.celZeta, dt);

    this.tauntRemaining = Math.max(0, this.tauntRemaining - dt);
    const taunt = this.tauntS.update(this.tauntRemaining > 0 ? 1 : 0, T.tauntOmega, T.tauntZeta, dt) * (1 - cel);

    // Landing crouch: impulse kicks the spring, underdamped ~0.4s recovery.
    if (boat.landImpulse > 0) this.crouchS.v += boat.landImpulse * T.landKick;
    const crouch = clamp(this.crouchS.update(0, T.landOmega, T.landZeta, dt), -0.3, T.landMax);

    // Idle weight: 1 at a standstill, 0 at racing speed (locked-in bracing).
    const idleW = 1 - clamp(boat.speed / T.lockSpeed, 0, 1);

    // Secondary motion: rider lags the boat's pitch/roll by a slow spring.
    const q = boat.quaternion;
    this.tmp.set(0, 0, 1).applyQuaternion(q);
    const boatPitch = Math.asin(clamp(this.tmp.y, -1, 1));
    this.tmp.set(1, 0, 0).applyQuaternion(q);
    const boatRoll = Math.asin(clamp(this.tmp.y, -1, 1)); // + = rolled left
    const lagP = boatPitch - this.boatPitchS.update(boatPitch, T.followOmega, T.followZeta, dt);
    const lagR = boatRoll - this.boatRollS.update(boatRoll, T.followOmega, T.followZeta, dt);
    const secP = clamp(lagP * T.followGain, -T.followMax, T.followMax) * idleW;
    const secR = clamp(lagR * T.followGain, -T.followMax, T.followMax) * idleW;

    // Breathing + micro vibration (two incommensurate sines, no noise state).
    const tp = t + this.phase;
    const breath = Math.sin(tp * 2 * Math.PI * T.breathHz) * T.breathAmp * idleW;
    const bob = Math.sin(tp * 2 * Math.PI * T.breathHz + 0.6) * T.breathBob * idleW;
    const vib = (Math.sin(tp * T.vibF1) + Math.sin(tp * T.vibF2)) * 0.5 * T.vibAmp * boat.rpm;

    // Celebration suppresses the driving layer.
    const drive = 1 - cel * 0.85;

    // ------------------------------------------------------ composite ----
    // Hips: lean roll, drift twist, crouch drop, breathing bob.
    j.hips.rotation.set(
      -air * T.airBodyOpen * 0.4 + flight * 0.04 - cel * 0.1,
      drift * drive,
      lean * T.leanHips * drive + secR * 0.5,
    );
    j.hips.position.y = this.hipsBaseY - crouch * T.landHipsDrop - flight * T.flightHipsDrop + bob;

    // Spine: baked forward hunch + weight shift, lean, breathing, secondary
    // lag, celebration upright.
    j.spine.rotation.set(
      POSE.hunchSpine + pitch + breath + secP + crouch * T.landSpine
        - air * T.airBodyOpen + flight * T.flightHunch - cel * T.celUpright,
      0,
      lean * T.leanSpine * drive,
    );
    j.chest.rotation.set(
      POSE.hunchChest + pitch * 0.4 + secP * 0.5 - cel * T.celUpright * 0.4,
      drift * 0.3 * drive,
      lean * T.leanChest * drive,
    );

    // Head: counter-lean, tips up airborne, nods while celebrating, eyes the
    // steering direction, and turns squarely at a taunted rival.
    j.head.rotation.set(
      POSE.headTiltUp - air * T.airHeadUp - pitch * 0.5
        + cel * Math.sin(t * 2 * Math.PI * T.celNodHz) * T.celNodAmp,
      (-boat.steer * T.headSteerLook * drive + taunt * T.tauntHeadYaw * this.tauntSide) * (1 - cel),
      -lean * T.headCounter * drive - secR * 0.4,
    );

    // Legs: inside knee flares with lean (lean < 0 = turning left = left inside),
    // crouch flexes both knees, airborne extends them a touch.
    const flareL = Math.max(0, -lean) / T.leanMax * T.kneeFlare * drive;
    const flareR = Math.max(0, lean) / T.leanMax * T.kneeFlare * drive;
    j.hipL.rotation.set(crouch * T.landHip + air * 0.1 + flight * T.flightKnee * 0.65, 0, flareL);
    j.hipR.rotation.set(crouch * T.landHip + air * 0.1 + flight * T.flightKnee * 0.65, 0, -flareR);
    j.kneeL.rotation.set(-crouch * T.landKnee - air * T.airLegExtend - flight * T.flightKnee, 0, 0);
    j.kneeR.rotation.set(-crouch * T.landKnee - air * T.airLegExtend - flight * T.flightKnee, 0, 0);

    // Arms: bracing tension at speed, rise when airborne, outside elbow drops.
    const brace = (1 - idleW) * drive;
    const dropL = Math.max(0, lean) / T.leanMax * T.elbowDrop * drive;  // left elbow drops on right lean
    const dropR = Math.max(0, -lean) / T.leanMax * T.elbowDrop * drive;
    const armBase = -brace * T.braceShoulder - air * T.airArmRise - flight * T.flightArmBrace + vib;
    const elbBase = brace * T.braceElbow + air * T.airElbowTuck + flight * T.flightArmBrace * 0.75 + vib * 1.3;

    // Celebration pump: right arm overhead in a loop, left joins late and
    // returns to the grip every cycle.
    const pumpT = tp * 2 * Math.PI * T.pumpHz;
    const pumpR = T.pumpRaise + Math.sin(pumpT) * T.pumpAmp;
    const gateL = Math.pow(Math.max(0, Math.sin(pumpT - T.celLeftLag)), 1.5);
    const pumpL = T.celLeftRaise * gateL;

    // Constant arm tuck: shoulders rotated inward so the arms angle toward
    // the bars and read "holding the grips" from behind, not flared out.
    j.shoulderL.rotation.set(
      armBase * (1 - cel) + cel * pumpL,
      0,
      -T.armTuck * (1 - cel) - 0.1 * cel,
    );
    j.shoulderR.rotation.set(
      armBase * (1 - cel) + cel * pumpR,
      0,
      T.armTuck * (1 - cel) + 0.1 * cel,
    );
    j.elbowL.rotation.set(elbBase + dropL, 0, 0);
    j.elbowR.rotation.set(elbBase + dropR + cel * (Math.sin(pumpT) * 0.3 - 0.3), 0, 0);

    // Right wrist works the throttle; left stays quiet on its grip.
    const thr = clamp(boat.throttle, 0, 1);
    j.handR.rotation.set(-thr * T.throttleWrist * (1 - cel), 0, 0);
    j.handL.rotation.set(vib * 0.5, 0, 0);
  }
}
