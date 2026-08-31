import * as THREE from 'three';
import type { HighlightClip } from './highlightRecorder';

export interface HighlightCameraState {
  camIndex: 1 | 2 | 3;
  camLabel: string;
  fov: number;
  slowMoActive: boolean;
  timeScale: number;
  clipProgress: number;
  currentReplayTime: number;
  speedKmh: number;
}

export class HighlightDirector {
  private clip: HighlightClip | null = null;
  private elapsed = 0;
  private replayTime = 0;
  private isPlaying = false;
  private isFinished = false;

  // Scratch vectors and objects for zero-allocation camera math
  private readonly boatPos = new THREE.Vector3();
  private readonly boatQuat = new THREE.Quaternion();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly targetCamPos = new THREE.Vector3();
  private readonly targetLookAt = new THREE.Vector3();
  private readonly camPosSmooth = new THREE.Vector3();
  private readonly lookAtSmooth = new THREE.Vector3();

  constructor() {}

  start(clip: HighlightClip): void {
    this.clip = clip;
    this.elapsed = 0;
    this.replayTime = clip.startTime;
    this.isPlaying = true;
    this.isFinished = false;
  }

  stop(): void {
    this.isPlaying = false;
    this.clip = null;
  }

  togglePause(): boolean {
    this.isPlaying = !this.isPlaying;
    return this.isPlaying;
  }

  restart(): void {
    if (!this.clip) return;
    this.elapsed = 0;
    this.replayTime = this.clip.startTime;
    this.isPlaying = true;
    this.isFinished = false;
  }

  seek(progress: number): void {
    if (!this.clip) return;
    const clamped = Math.max(0, Math.min(1, progress));
    this.elapsed = clamped * this.clip.duration;
    this.replayTime = this.clip.startTime + this.elapsed;
    this.isFinished = clamped >= 1;
  }

  get active(): boolean {
    return this.clip !== null;
  }

  get finished(): boolean {
    return this.isFinished;
  }

  get currentClip(): HighlightClip | null {
    return this.clip;
  }

  update(
    dt: number,
    camera: THREE.PerspectiveCamera,
    boatPosition: THREE.Vector3,
    boatQuaternion: THREE.Quaternion,
    speed: number,
  ): HighlightCameraState {
    if (!this.clip) {
      return {
        camIndex: 1,
        camLabel: '[ CAM 01 // LOW-APEX TRACK ]',
        fov: 78,
        slowMoActive: false,
        timeScale: 1,
        clipProgress: 1,
        currentReplayTime: 0,
        speedKmh: 0,
      };
    }

    const duration = this.clip.duration;
    const clipProgress = Math.max(0, Math.min(1, this.elapsed / duration));

    // Commercial AAA Speed Ramping:
    // 0.0s - 1.4s: 1.0x normal approach
    // 1.4s - 3.2s: 0.35x slow-mo climax (bullet time at peak jump / apex drift)
    // 3.2s - 4.5s: 1.1x speed recovery burst
    let timeScale = 1.0;
    let slowMoActive = false;
    if (this.elapsed >= 1.4 && this.elapsed <= 3.2) {
      const slowPhase = (this.elapsed - 1.4) / 1.8;
      // Smooth bell curve dip to 0.35
      timeScale = 0.35 + 0.65 * Math.pow(Math.abs(slowPhase - 0.5) * 2, 2);
      slowMoActive = true;
    } else if (this.elapsed > 3.2) {
      timeScale = 1.1;
    }

    if (this.isPlaying) {
      this.elapsed += dt * timeScale;
      this.replayTime = this.clip.startTime + (this.elapsed / duration) * (this.clip.endTime - this.clip.startTime);
      if (this.elapsed >= duration) {
        this.elapsed = duration;
        this.isFinished = true;
      }
    }

    this.boatPos.copy(boatPosition);
    this.boatQuat.copy(boatQuaternion);

    // Compute boat direction basis
    this.forward.set(0, 0, 1).applyQuaternion(this.boatQuat).normalize();
    this.right.set(1, 0, 0).applyQuaternion(this.boatQuat).normalize();

    // Multi-angle Cinematic Camera Director
    let camIndex: 1 | 2 | 3 = 1;
    let camLabel = '[ CAM 01 // LOW-ANGLE APEX TRACK ]';
    let targetFov = 84;

    if (this.elapsed < 1.5) {
      // Angle 1: Low-Angle Waterline Apex Track Cam (贴地低机位水线追焦)
      // Camera is close to water line on left/right side, looking slightly up at the hull & bow wave
      camIndex = 1;
      camLabel = '[ CAM 01 // LOW-ANGLE APEX TRACK ]';
      targetFov = 84;

      const sideDist = -4.2;
      const backDist = -3.5;
      const height = 0.75;
      this.targetCamPos.copy(this.boatPos)
        .addScaledVector(this.right, sideDist)
        .addScaledVector(this.forward, backDist);
      this.targetCamPos.y = Math.max(0.65, this.boatPos.y + height);

      this.targetLookAt.copy(this.boatPos)
        .addScaledVector(this.forward, 3.8)
        .addScaledVector(this.up, 0.4);

    } else if (this.elapsed < 3.3) {
      // Angle 2: Aero Drone Swoop & Bullet-Time Orbit (空中无人机俯冲 / 子弹时间定格旋转)
      // Elevated aerial angle sweeping around the front-quarter with dynamic focal breathing
      camIndex = 2;
      camLabel = '[ CAM 02 // DYNAMIC HELI-DRONE SWOOP ]';
      const orbitPhase = (this.elapsed - 1.5) / 1.8;
      const orbitAngle = -0.45 + orbitPhase * 0.95; // Sweep from side-front to 3/4 front
      const orbitRadius = 6.2 - Math.sin(orbitPhase * Math.PI) * 1.5; // Dolly in at peak
      const orbitHeight = 2.4 - orbitPhase * 0.7; // Swoop downwards

      targetFov = 68 + Math.sin(orbitPhase * Math.PI) * 6; // Dynamic focal zoom

      const cosA = Math.cos(orbitAngle);
      const sinA = Math.sin(orbitAngle);

      this.targetCamPos.copy(this.boatPos)
        .addScaledVector(this.right, cosA * orbitRadius)
        .addScaledVector(this.forward, sinA * orbitRadius + 2.0);
      this.targetCamPos.y = this.boatPos.y + orbitHeight;

      this.targetLookAt.copy(this.boatPos)
        .addScaledVector(this.up, 0.6);

    } else {
      // Angle 3: Dynamic Flyby / Exit Cam (前置广角高速掠影)
      // Camera is ahead of the boat looking back at a low dramatic angle as the boat blasts past!
      camIndex = 3;
      camLabel = '[ CAM 03 // ACTION FLYBY CAM ]';
      targetFov = 78;

      const flybyPhase = (this.elapsed - 3.3) / 1.2;
      const aheadDist = 9.0 - flybyPhase * 16.0; // Boat passes camera from front to behind
      const sideOffset = 2.8;

      this.targetCamPos.copy(this.boatPos)
        .addScaledVector(this.forward, aheadDist)
        .addScaledVector(this.right, sideOffset);
      this.targetCamPos.y = Math.max(0.65, this.boatPos.y + 1.2);

      this.targetLookAt.copy(this.boatPos)
        .addScaledVector(this.up, 0.45);
    }

    // Smooth camera transition
    if (this.elapsed <= 0.05 || this.elapsed === 1.5 || this.elapsed === 3.3) {
      this.camPosSmooth.copy(this.targetCamPos);
      this.lookAtSmooth.copy(this.targetLookAt);
    } else {
      const lerpFactor = Math.min(1, dt * 14);
      this.camPosSmooth.lerp(this.targetCamPos, lerpFactor);
      this.lookAtSmooth.lerp(this.targetLookAt, lerpFactor);
    }

    camera.position.copy(this.camPosSmooth);
    camera.lookAt(this.lookAtSmooth);
    camera.fov = targetFov;
    camera.updateProjectionMatrix();

    return {
      camIndex,
      camLabel,
      fov: targetFov,
      slowMoActive,
      timeScale,
      clipProgress,
      currentReplayTime: this.replayTime,
      speedKmh: Math.round(speed * 3.6),
    };
  }
}
