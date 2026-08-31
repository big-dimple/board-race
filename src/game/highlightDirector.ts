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

    // Multi-angle Cinematic Camera Director (TRUE GOD'S-EYE BROADCAST VIEWS)
    let newCamIndex: 1 | 2 | 3 = 1;
    let camLabel = '[ CAM 01 // GODS-EYE SKYCAM BROADCAST ]';
    let targetFov = 64;

    if (this.elapsed < 2.8) {
      // Angle 1: High God's-Eye Skycam Overview (上帝天眼高空俯瞰建立机位)
      // Elevated aerial camera tracking above and diagonally to the side, looking down at ~35 deg pitch
      newCamIndex = 1;
      camLabel = '[ CAM 01 // GODS-EYE SKYCAM BROADCAST ]';
      targetFov = 64;

      const sideAngle = heading - 0.52;
      const dist = 14.5;
      const height = 8.5;

      this.targetCamPos.set(
        this.boatPos.x - Math.sin(sideAngle) * dist,
        Math.max(5.5, this.boatPos.y + height),
        this.boatPos.z - Math.cos(sideAngle) * dist,
      );
      this.targetLookAt.set(this.boatPos.x, this.boatPos.y + 0.8, this.boatPos.z);

    } else if (this.elapsed < 5.4) {
      // Angle 2: 360° Sky Orbit & Bullet-Time (上帝高空360度大回旋 / 子弹时间慢镜头定格)
      // Elevated aerial helicopter camera smoothly sweeps 360 around the climax from high above
      newCamIndex = 2;
      camLabel = '[ CAM 02 // 360° SKY-ORBIT BULLET-TIME ]';
      targetFov = 56;

      const orbitPhase = (this.elapsed - 2.8) / 2.6;
      const orbitAngle = heading + Math.PI * 0.72 + orbitPhase * Math.PI * 1.65;
      const radius = 12.0;
      const height = 6.8 - Math.sin(orbitPhase * Math.PI) * 2.2;

      this.targetCamPos.set(
        this.boatPos.x + Math.sin(orbitAngle) * radius,
        Math.max(4.8, this.boatPos.y + height),
        this.boatPos.z + Math.cos(orbitAngle) * radius,
      );

      this.targetLookAt.set(
        this.boatPos.x,
        this.boatPos.y + 0.85,
        this.boatPos.z,
      );

    } else {
      // Angle 3: Sky High Telephoto Exit Overlook (高空长焦前迎过顶俯拍 / 绝尘而去)
      // Perched ahead looking back as the boat speeds past underneath
      newCamIndex = 3;
      camLabel = '[ CAM 03 // SKY HIGH TELEPHOTO OVERLOOK ]';
      targetFov = 52;

      const flybyPhase = (this.elapsed - 5.4) / 2.1;
      const aheadDist = 22.0 - flybyPhase * 36.0;
      const sideDist = 7.5;

      this.targetCamPos.set(
        this.boatPos.x + Math.sin(heading) * aheadDist + Math.cos(heading) * sideDist,
        Math.max(4.5, this.boatPos.y + 6.5),
        this.boatPos.z + Math.cos(heading) * aheadDist - Math.sin(heading) * sideDist,
      );

      this.targetLookAt.set(
        this.boatPos.x,
        this.boatPos.y + 0.6,
        this.boatPos.z,
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
