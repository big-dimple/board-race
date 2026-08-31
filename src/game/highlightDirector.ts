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

    // Commercial AAA Speed Ramping (5.2s duration):
    // 0.0s - 1.8s: 1.0x panoramic approach (establishing environment & race context)
    // 1.8s - 3.8s: 0.35x slow-mo climax (bullet time at peak jump / apex drift)
    // 3.8s - 5.2s: 1.1x speed recovery burst & outro flyaway
    let timeScale = 1.0;
    let slowMoActive = false;
    if (this.elapsed >= 1.8 && this.elapsed <= 3.8) {
      const slowPhase = (this.elapsed - 1.8) / 2.0;
      // Smooth bell curve dip to 0.35
      timeScale = 0.35 + 0.65 * Math.pow(Math.abs(slowPhase - 0.5) * 2, 2);
      slowMoActive = true;
    } else if (this.elapsed > 3.8) {
      timeScale = 1.15;
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
    let camLabel = '[ CAM 01 // PANORAMIC ESTABLISHING TRACK ]';
    let targetFov = 72;

    if (this.elapsed < 1.8) {
      // Angle 1: Wide-Angle Panoramic Establishing Track Cam (大景深全景建立追焦)
      // Camera is elevated and set back to show the boat carving through waves, mist gates & scenery
      camIndex = 1;
      camLabel = '[ CAM 01 // PANORAMIC ESTABLISHING TRACK ]';
      targetFov = 72;

      const sideDist = -8.5;
      const backDist = -7.5;
      const height = 3.8;
      this.targetCamPos.copy(this.boatPos)
        .addScaledVector(this.right, sideDist)
        .addScaledVector(this.forward, backDist);
      this.targetCamPos.y = Math.max(1.8, this.boatPos.y + height);

      this.targetLookAt.copy(this.boatPos)
        .addScaledVector(this.forward, 5.0)
        .addScaledVector(this.up, 0.8);

    } else if (this.elapsed < 3.8) {
      // Angle 2: Aero Drone Swoop & Bullet-Time Orbit (空中无人机大俯冲 / 子弹时间慢镜头定格回旋)
      // Elevated aerial angle sweeping around with cinematic dolly in and focal breathing
      camIndex = 2;
      camLabel = '[ CAM 02 // AERO DRONE BULLET-TIME ORBIT ]';
      const orbitPhase = (this.elapsed - 1.8) / 2.0;
      const orbitAngle = -0.55 + orbitPhase * 1.15; // Sweeping from 3/4 front to side
      const orbitRadius = 9.2 - Math.sin(orbitPhase * Math.PI) * 2.2; // Smooth dolly in at climax
      const orbitHeight = 4.2 - orbitPhase * 1.6; // High-altitude swoop down

      targetFov = 66 + Math.sin(orbitPhase * Math.PI) * 6; // Dynamic focal zoom

      const cosA = Math.cos(orbitAngle);
      const sinA = Math.sin(orbitAngle);

      this.targetCamPos.copy(this.boatPos)
        .addScaledVector(this.right, cosA * orbitRadius)
        .addScaledVector(this.forward, sinA * orbitRadius + 3.2);
      this.targetCamPos.y = Math.max(1.5, this.boatPos.y + orbitHeight);

      this.targetLookAt.copy(this.boatPos)
        .addScaledVector(this.up, 0.7);

    } else {
      // Angle 3: Outro Flyaway & Telephoto Pass (长焦高速前迎掠影 / 绝尘而去)
      // Camera looks back down the course as the boat blasts past and rockets off into the distance!
      camIndex = 3;
      camLabel = '[ CAM 03 // OUTRO FLYAWAY & TELEPHOTO PASS ]';
      targetFov = 68;

      const flybyPhase = (this.elapsed - 3.8) / 1.4;
      const aheadDist = 18.0 - flybyPhase * 32.0; // Long distance pass
      const sideOffset = 4.8;

      this.targetCamPos.copy(this.boatPos)
        .addScaledVector(this.forward, aheadDist)
        .addScaledVector(this.right, sideOffset);
      this.targetCamPos.y = Math.max(1.2, this.boatPos.y + 2.2);

      this.targetLookAt.copy(this.boatPos)
        .addScaledVector(this.up, 0.6);
    }

    // Smooth camera transition
    if (this.elapsed <= 0.05 || this.elapsed === 1.8 || this.elapsed === 3.8) {
      this.camPosSmooth.copy(this.targetCamPos);
      this.lookAtSmooth.copy(this.targetLookAt);
    } else {
      const lerpFactor = Math.min(1, dt * 12);
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
