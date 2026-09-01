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
  private activeCamIndex: 1 | 2 | 3 = 1;

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
    this.activeCamIndex = 1;
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
    this.activeCamIndex = 1;
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

  get currentTime(): number {
    return this.replayTime;
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
        camLabel: '[ CAM 01 // GODS-EYE SKYCAM ]',
        fov: 64,
        slowMoActive: false,
        timeScale: 1,
        clipProgress: 1,
        currentReplayTime: 0,
        speedKmh: 0,
      };
    }

    const duration = this.clip.duration;
    const clipProgress = Math.max(0, Math.min(1, this.elapsed / duration));

    // Commercial AAA Speed Ramping (7.5s duration):
    // 0.0s - 2.8s: 1.0x panoramic approach (establishing environment & race context)
    // 2.8s - 5.4s: 0.35x slow-mo climax (bullet time at peak jump / apex drift)
    // 5.4s - 7.5s: 1.15x speed recovery burst & outro flyaway
    let timeScale = 1.0;
    let slowMoActive = false;
    if (this.elapsed >= 2.8 && this.elapsed <= 5.4) {
      const slowPhase = (this.elapsed - 2.8) / 2.6;
      // Smooth bell curve dip to 0.35
      timeScale = 0.35 + 0.65 * Math.pow(Math.abs(slowPhase - 0.5) * 2, 2);
      slowMoActive = true;
    } else if (this.elapsed > 5.4) {
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

    // Extract planar track heading from horizontal direction (isolated from hull pitch & roll)
    const heading = Math.atan2(this.forward.x, this.forward.z);

    // Multi-angle Cinematic Camera Director (REAR & REAR-DIAGONAL ELEVATED GOD'S-EYE BROADCAST)
    let newCamIndex: 1 | 2 | 3 = 1;
    let camLabel = '[ CAM 01 // REAR-DIAGONAL SKYCAM FOLLOW ]';
    let targetFov = 60;

    if (this.elapsed < 2.8) {
      // Angle 1: Rear-Diagonal Elevated Skycam Follow (侧后方45°高空俯瞰上帝视角跟进 - 3x Distance)
      // Elevated aerial camera tracking from the rear-diagonal side looking down at ~30 deg pitch
      newCamIndex = 1;
      camLabel = '[ CAM 01 // REAR-DIAGONAL SKYCAM FOLLOW ]';
      targetFov = 52;

      const rearSideAngle = heading - 0.44;
      const dist = 22.5;
      const height = 12.6;

      this.targetCamPos.set(
        this.boatPos.x - Math.sin(rearSideAngle) * dist,
        Math.max(6.5, this.boatPos.y + height),
        this.boatPos.z - Math.cos(rearSideAngle) * dist,
      );
      this.targetLookAt.set(
        this.boatPos.x + this.forward.x * 3.2,
        this.boatPos.y + 0.5,
        this.boatPos.z + this.forward.z * 3.2,
      );

    } else if (this.elapsed < 5.4) {
      // Angle 2: Rear-Quarter Slow-Mo Dramatic Swoop (侧后方高空弧形慢镜头特写俯瞰 - 3x Distance)
      // Elevated aerial camera smoothly sweeping in a rear-quarter arc during the stunt climax
      newCamIndex = 2;
      camLabel = '[ CAM 02 // REAR-QUARTER SLOW-MO SWOOP ]';
      targetFov = 48;

      const orbitPhase = (this.elapsed - 2.8) / 2.6;
      const rearSwoopAngle = heading - 0.40 + orbitPhase * 0.80;
      const dist = 19.8;
      const height = 10.8 + Math.sin(orbitPhase * Math.PI) * 1.6;

      this.targetCamPos.set(
        this.boatPos.x - Math.sin(rearSwoopAngle) * dist,
        Math.max(6.0, this.boatPos.y + height),
        this.boatPos.z - Math.cos(rearSwoopAngle) * dist,
      );

      this.targetLookAt.set(
        this.boatPos.x + this.forward.x * 2.0,
        this.boatPos.y + 0.5,
        this.boatPos.z + this.forward.z * 2.0,
      );

    } else {
      // Angle 3: Pure Rear Elevated Sky Chase (正后方高空极速追焦冲刺俯瞰 - 3x Distance)
      // Elevated behind tracking the boat as it blazes forward into the horizon
      newCamIndex = 3;
      camLabel = '[ CAM 03 // PURE REAR SKY CHASE ]';
      targetFov = 54;

      const rearChaseAngle = heading - 0.05;
      const dist = 23.4;
      const height = 11.7;

      this.targetCamPos.set(
        this.boatPos.x - Math.sin(rearChaseAngle) * dist,
        Math.max(6.0, this.boatPos.y + height),
        this.boatPos.z - Math.cos(rearChaseAngle) * dist,
      );

      this.targetLookAt.set(
        this.boatPos.x + this.forward.x * 4.2,
        this.boatPos.y + 0.5,
        this.boatPos.z + this.forward.z * 4.2,
      );
    }

    // Handle clean angle cuts
    const isFirstFrame = this.elapsed <= 0.05;
    const isAngleCut = newCamIndex !== this.activeCamIndex;
    this.activeCamIndex = newCamIndex;

    if (isFirstFrame || isAngleCut) {
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
      camIndex: this.activeCamIndex,
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
