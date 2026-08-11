/**
 * chaseCamera.ts — camera rig: countdown orbit, spring chase cam, results hero orbit.
 *
 * The chase cam is deliberately NOT a rigid stick: a damped spring drags the
 * camera toward a rest pose behind the boat, the rest distance breathes with
 * longitudinal G (hangs back under throttle, tucks in under braking), the FOV
 * stretches with speed and kicks under boost, and shake() injects decaying
 * positional noise. The horizon stays stable — the camera only yaws with the
 * boat, plus a tiny roll into turns proportional to lateralG.
 *
 * Mode switches blend position + lookAt + FOV over ~0.8s.
 * Zero per-frame allocation: every scratch vector is a reused field.
 * dt is the fixed sim step (1/60).
 */
import * as THREE from 'three';
import type { IBoat, CameraMode } from '../contracts';
import { waterHeight } from '../water/waves';
import { BASE_FOV } from '../core/stage';

// ---- chase tuning -----------------------------------------------------------
const V_MAX = 34; // speed (m/s) that maps to max FOV
const MAX_FOV = 74; // FOV at V_MAX
const BOOST_FOV = 3; // extra degrees while boosting
const FOV_RATE = 6; // /s base FOV smoothing
const BOOST_IN = 14; // /s boost FOV attack (fast in)
const BOOST_OUT = 1.8; // /s boost FOV release (slow out)
const CHASE_BACK = 9.5; // rest distance behind the boat (m)
const CHASE_UP = 3.6; // rest height above the boat (m)
const CHASE_MIN_DIST = 6.5; // hard floor for the brake tuck-in (m)
const LOOK_AHEAD = 4; // look-at point this far past the bow (m)
const SPRING_K = 58; // follow-spring stiffness
const SPRING_DAMP = 11; // slightly under critical (2*sqrt(K) ≈ 15.2)
const ACCEL_LAG = 0.24; // extra hang-back meters per m/s² of longG
const ACCEL_LAG_MAX = 2.2;
const ACCEL_LAG_RATE = 4; // /s smoothing on the lag term
const ROLL_PER_G = 0.008; // rad of camera roll per m/s² lateralG
const ROLL_MAX = 0.061; // ≈ 3.5°
const ROLL_RATE = 7; // /s roll smoothing
const LOOK_RATE = 12; // /s look-at smoothing (chase)
const ORBIT_RATE = 2.6; // /s position smoothing (orbit/results)
const ORBIT_LOOK_RATE = 5; // /s look-at smoothing (orbit/results)
const WATER_CLEARANCE = 0.6; // camera never closer than this to the waves (m)

// ---- orbit / results tuning ---------------------------------------------------
const ORBIT_RADIUS = 14;
const ORBIT_HEIGHT = 5;
const ORBIT_OMEGA = (Math.PI * 2) / 12; // ~12 s/rev
const ORBIT_BOB = 0.5; // gentle vertical bob amplitude (m)
const RESULTS_RADIUS = 8;
const RESULTS_HEIGHT = 2.2;
const RESULTS_OMEGA = (Math.PI * 2) / 10;
const RESULTS_DUTCH = 0.14; // ≈ 8° dutch angle

const BLEND_TIME = 0.8; // mode-switch blend duration (s)
const SHAKE_AMP = 0.35; // meters of positional noise at strength 1
const SHAKE_W = 88; // ≈ 14 Hz in rad/s
const SHAKE_DECAY = 5; // /s exponential decay

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class CameraRig {
  mode: CameraMode = 'orbit';

  private readonly camera: THREE.PerspectiveCamera;
  private activeMode: CameraMode = 'orbit';
  private initialized = false;

  // live follow state
  private readonly pos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private fov = BASE_FOV;
  private boostFov = 0;
  private roll = 0;
  private accelLag = 0;
  private shakeAmp = 0;
  private noiseT = 0;

  // mode-blend snapshot
  private blendT = 1;
  private readonly blendPos = new THREE.Vector3();
  private readonly blendLook = new THREE.Vector3();
  private blendFov = BASE_FOV;

  // scratch (reused every frame)
  private readonly target = new THREE.Vector3();
  private readonly targetLook = new THREE.Vector3();
  private readonly helm = new THREE.Vector3();
  private readonly finalPos = new THREE.Vector3();
  private readonly finalLook = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  /** Additive 0..1 shake impulse; decays exponentially at ~5/s. */
  shake(strength: number): void {
    this.shakeAmp = Math.min(1, this.shakeAmp + clamp(strength, 0, 1));
  }

  update(dt: number, boat: IBoat, t: number): void {
    const st = boat.state;
    const bx = st.position.x;
    const by = st.position.y;
    const bz = st.position.z;
    // boat yaw frame (horizon-stable: yaw only, never pitch/roll of the hull)
    const fx = Math.sin(st.heading);
    const fz = Math.cos(st.heading);

    // ---- mode switch: snapshot current state, restart the 0.8s blend ---------
    if (this.mode !== this.activeMode) {
      this.activeMode = this.mode;
      this.blendT = 0;
      this.blendPos.copy(this.pos);
      this.blendLook.copy(this.look);
      this.blendFov = this.fov;
    }

    // ---- per-mode targets -----------------------------------------------------
    const target = this.target;
    const look = this.targetLook;
    let fovTarget = BASE_FOV;
    let rollTarget = 0;

    if (this.activeMode === 'chase') {
      // accel lag: hang back under throttle, tuck in under braking
      const lagT = clamp(st.longG * ACCEL_LAG, -ACCEL_LAG_MAX, ACCEL_LAG_MAX);
      this.accelLag += (lagT - this.accelLag) * (1 - Math.exp(-ACCEL_LAG_RATE * dt));
      const dist = Math.max(CHASE_MIN_DIST, CHASE_BACK + this.accelLag);
      target.set(bx - fx * dist, by + CHASE_UP, bz - fz * dist);

      // look ~4m ahead of the bow, at water height
      const ax = bx + fx * LOOK_AHEAD;
      const az = bz + fz * LOOK_AHEAD;
      look.set(ax, waterHeight(ax, az, t), az);

      // FOV: speed stretch + boost kick (fast in, slow out)
      const speedN = clamp(st.speed / V_MAX, 0, 1);
      const bRate = st.boosting ? BOOST_IN : BOOST_OUT;
      this.boostFov += ((st.boosting ? BOOST_FOV : 0) - this.boostFov) * (1 - Math.exp(-bRate * dt));
      fovTarget = BASE_FOV + (MAX_FOV - BASE_FOV) * speedN + this.boostFov;

      // tiny roll into turns, proportional to lateralG
      rollTarget = clamp(st.lateralG * ROLL_PER_G, -ROLL_MAX, ROLL_MAX);
    } else {
      // cinematic orbits around the helm
      boat.riderMount.getWorldPosition(this.helm);
      look.copy(this.helm);
      const isOrbit = this.activeMode === 'orbit';
      const omega = isOrbit ? ORBIT_OMEGA : RESULTS_OMEGA;
      const radius = isOrbit ? ORBIT_RADIUS : RESULTS_RADIUS;
      const height = isOrbit ? ORBIT_HEIGHT : RESULTS_HEIGHT;
      const a = t * omega + 0.8;
      const bob = isOrbit ? Math.sin(t * 0.8) * ORBIT_BOB : 0;
      target.set(bx + Math.cos(a) * radius, by + height + bob, bz + Math.sin(a) * radius);
      rollTarget = isOrbit ? 0 : RESULTS_DUTCH;
    }
    this.roll += (rollTarget - this.roll) * (1 - Math.exp(-ROLL_RATE * dt));

    // ---- first frame: settle on target, sweep in from the staged camera ------
    if (!this.initialized) {
      this.initialized = true;
      this.pos.copy(target);
      this.vel.set(0, 0, 0);
      this.look.copy(look);
      this.fov = fovTarget;
      this.blendT = 0;
      this.blendPos.copy(this.camera.position);
      this.blendLook.set(bx, by + 1.5, bz);
      this.blendFov = this.camera.fov;
    }

    // ---- integrate ------------------------------------------------------------
    const p = this.pos;
    if (this.activeMode === 'chase') {
      // damped spring: a = (target - pos) * K - vel * D
      const v = this.vel;
      v.x += ((target.x - p.x) * SPRING_K - v.x * SPRING_DAMP) * dt;
      v.y += ((target.y - p.y) * SPRING_K - v.y * SPRING_DAMP) * dt;
      v.z += ((target.z - p.z) * SPRING_K - v.z * SPRING_DAMP) * dt;
      p.x += v.x * dt;
      p.y += v.y * dt;
      p.z += v.z * dt;
      const lk = 1 - Math.exp(-LOOK_RATE * dt);
      this.look.x += (look.x - this.look.x) * lk;
      this.look.y += (look.y - this.look.y) * lk;
      this.look.z += (look.z - this.look.z) * lk;
    } else {
      // lazy exponential drift for the cinematic modes
      const pk = 1 - Math.exp(-ORBIT_RATE * dt);
      p.x += (target.x - p.x) * pk;
      p.y += (target.y - p.y) * pk;
      p.z += (target.z - p.z) * pk;
      this.vel.set(0, 0, 0);
      const lk = 1 - Math.exp(-ORBIT_LOOK_RATE * dt);
      this.look.x += (look.x - this.look.x) * lk;
      this.look.y += (look.y - this.look.y) * lk;
      this.look.z += (look.z - this.look.z) * lk;
    }
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-FOV_RATE * dt));

    // ---- mode blend (position + lookAt + FOV) ----------------------------------
    let e = 1;
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / BLEND_TIME);
      e = this.blendT * this.blendT * (3 - 2 * this.blendT); // smoothstep
    }
    const fp = this.finalPos;
    const fl = this.finalLook;
    fp.lerpVectors(this.blendPos, p, e);
    fl.lerpVectors(this.blendLook, this.look, e);
    const fov = this.blendFov + (this.fov - this.blendFov) * e;

    // ---- shake: additive positional noise, applied post-spring -----------------
    this.noiseT += dt;
    this.shakeAmp *= Math.exp(-SHAKE_DECAY * dt);
    if (this.shakeAmp > 0.001) {
      const nt = this.noiseT;
      const a = this.shakeAmp * SHAKE_AMP;
      fp.x += (Math.sin(nt * SHAKE_W) * 0.62 + Math.sin(nt * SHAKE_W * 1.618 + 1.3) * 0.38) * a;
      fp.y += (Math.sin(nt * SHAKE_W * 1.13 + 2.1) * 0.62 + Math.sin(nt * SHAKE_W * 1.83 + 0.7) * 0.38) * a * 0.7;
      fp.z += (Math.sin(nt * SHAKE_W * 0.97 + 4.2) * 0.62 + Math.sin(nt * SHAKE_W * 1.42 + 2.9) * 0.38) * a;
    }

    // ---- never dip under the waves ----------------------------------------------
    const minY = waterHeight(fp.x, fp.z, t) + WATER_CLEARANCE;
    if (fp.y < minY) fp.y = minY;

    // ---- roll-aware up vector: roll about the view axis --------------------------
    let vx = fl.x - fp.x;
    let vy = fl.y - fp.y;
    let vz = fl.z - fp.z;
    const vlen = Math.hypot(vx, vy, vz) || 1;
    vx /= vlen;
    vy /= vlen;
    vz /= vlen;
    // view-perpendicular "left" in the XZ plane
    let px = vz;
    let pz = -vx;
    const plen = Math.hypot(px, pz) || 1;
    px /= plen;
    pz /= plen;
    const sr = Math.sin(this.roll);
    const cr = Math.cos(this.roll);

    const cam = this.camera;
    cam.position.copy(fp);
    cam.up.set(px * sr, cr, pz * sr);
    cam.lookAt(fl);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
