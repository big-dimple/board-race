/**
 * contracts.ts — shared types crossing subsystem boundaries.
 *
 * Every subsystem (water / cel / boat / course+AI / riders / HUD+camera+audio)
 * implements against these exact shapes. main.ts wires them together.
 * Do not change these without updating every consumer.
 */
import type * as THREE from 'three';

// ---------------------------------------------------------------- boats ----

/** Per-frame driving input, produced by the player keyboard or an AI controller. */
export interface BoatInput {
  /** -1 (full reverse/brake) .. 1 (full throttle). */
  throttle: number;
  /** -1 (full left) .. 1 (full right). */
  steer: number;
  /** Held = powerslide. Releasing after a long drift pays out boost. */
  drift: boolean;
}

/**
 * Everything other subsystems need to know about a boat each frame.
 * Owned and written by Boat.update(); read-only for everyone else.
 */
export interface BoatState {
  /** World transform of the hull root. */
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  /** Signed forward speed along heading, m/s. */
  speed: number;
  /** Engine revs 0..1 for audio. */
  rpm: number;
  throttle: number;
  steer: number;
  drifting: boolean;
  /** 0..1, charged by drifting, spent by boosting. */
  boostCharge: number;
  boosting: boolean;
  airborne: boolean;
  airTime: number;
  /** >0 only on the frame a landing impact happens; magnitude = impact speed m/s. */
  landImpulse: number;
  /** Signed lateral acceleration (for rider lean + camera roll), m/s². */
  lateralG: number;
  /** Signed longitudinal acceleration (throttle/brake weight shift), m/s². */
  longG: number;
  /** Yaw heading, radians. 0 = +Z, positive turning left (CCW from above). */
  heading: number;
}

// ------------------------------------------------------ subsystem views ----
// Structural interfaces so subsystems depend on contracts, not on each
// other's implementation files. The concrete classes implement these.

export interface IBoat {
  readonly id: number;
  readonly object: THREE.Object3D;
  readonly state: BoatState;
  /** Attach point for the rider, positioned at the helm. */
  readonly riderMount: THREE.Object3D;
  update(dt: number, input: BoatInput, t: number): void;
  teleport(x: number, z: number, heading: number): void;
}

export interface IWake {
  readonly object: THREE.Object3D;
  /** Deposit a wake point at the stern. dirX/dirZ = normalized boat forward direction. intensity 0..1. */
  push(pos: THREE.Vector3, dirX: number, dirZ: number, intensity: number): void;
  update(dt: number, t: number): void;
  clear(): void;
}

export interface ISpray {
  /** Emit `count` spray particles at pos with base speed (m/s). */
  burst(pos: THREE.Vector3, count: number, speed: number): void;
  update(dt: number, t: number): void;
}

export interface CourseSample {
  /** Normalized position on the closed spline, 0..1. */
  u: number;
  /** Lateral distance from the spline center line, meters. */
  distance: number;
  /** Nearest point on the spline (y = 0, water level). */
  point: THREE.Vector3;
  /** Unit tangent at that point, XZ plane. */
  tangent: THREE.Vector3;
}

export interface ICourse {
  readonly object: THREE.Object3D;
  /** Total lap length in meters. */
  readonly length: number;
  /** Number of checkpoint gates (start/finish excluded). */
  readonly checkpoints: number;
  pointAt(u: number, out: THREE.Vector3): THREE.Vector3;
  tangentAt(u: number, out: THREE.Vector3): THREE.Vector3;
  /** Nearest-spline lookup for progress + wrong-way detection. */
  sample(pos: THREE.Vector3, out: CourseSample): CourseSample;
  update(dt: number, t: number): void;
}

/** What the HUD and camera are allowed to know about the race. */
export interface RaceView {
  readonly phase: RacePhase;
  /** 3, 2, 1, or 0 (GO). */
  readonly countdownValue: number;
  readonly raceTime: number;
  readonly totalLaps: number;
  readonly racers: readonly RacerState[];
}

// ----------------------------------------------------------------- race ----

export type RacePhase = 'countdown' | 'racing' | 'finished';

export type Personality = 'aggressive' | 'clean' | 'erratic';

export interface RacerState {
  id: number;
  name: string;
  isPlayer: boolean;
  color: number;
  /** 1-based current lap. */
  lap: number;
  /** Total race distance along the course spline, meters (lap * length + segment). */
  progress: number;
  /** 1-based place, updated each frame. */
  place: number;
  /** Last completed lap time, seconds. -1 if none. */
  lastLapTime: number;
  bestLapTime: number;
  /** Split delta vs leader at last checkpoint gate, seconds. 0 if none. */
  splitDelta: number;
  finished: boolean;
  finishTime: number;
  wrongWay: boolean;
}

// --------------------------------------------------------------- camera ----

export type CameraMode = 'orbit' | 'chase' | 'results';

// --------------------------------------------------------------- layers ----

/**
 * Layer for "solid ink" objects: boats, riders, gates, buoys.
 * The normal/depth prepass camera renders ONLY this layer, and the Sobel
 * edge pass + ocean foam-ring mask read that prepass. Ocean, sky, racing
 * line, wakes and spray stay OFF this layer (they handle their own style).
 */
export const LAYER_INK = 1;

/** Recursively enable the ink layer on an object subtree (call after building a mesh tree). */
export function markInk(root: THREE.Object3D): void {
  root.traverse((o) => o.layers.enable(LAYER_INK));
}
