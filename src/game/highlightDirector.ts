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

  // Spatial keyframe anchors for broadcast sky towers
  private readonly startPos = new THREE.Vector3();
  private readonly peakPos = new THREE.Vector3();
  private readonly endPos = new THREE.Vector3();
  private startHeading = 0;
  private peakHeading = 0;

  private readonly camStation1 = new THREE.Vector3();
  private readonly camStation3 = new THREE.Vector3();

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

    const samples = clip.samples;
    if (samples.length > 0) {
      const first = samples[0];
      const mid = samples[Math.floor(samples.length * 0.5)];
      const last = samples[samples.length - 1];

      this.startPos.set(first.x, first.y, first.z);
      this.peakPos.set(mid.x, mid.y, mid.z);
      this.endPos.set(last.x, last.y, last.z);

      const dx1 = mid.x - first.x;
      const dz1 = mid.z - first.z;
      this.startHeading = Math.atan2(dx1, dz1) || 0;

      const dx2 = last.z - mid.z;
      const dz2 = last.z - mid.z;
      this.peakHeading = Math.atan2(dx2, dz2) || this.startHeading;

      // Station 1: High God's-Eye Sky Tower (上帝天眼俯瞰高塔)
      // Elevated 22m in the sky, offset 28m to the diagonal side of approach
      const sideAngle1 = this.startHeading - 0.72;
      this.camStation1.set(
        this.startPos.x - Math.sin(sideAngle1) * 28.0,
        Math.max(18.0, this.startPos.y + 22.0),
        this.startPos.z - Math.cos(sideAngle1) * 28.0,
      );

      // Station 3: Sky Exit Overlook Tower (高空俯拍过顶长焦塔)
      // Elevated 18m, positioned 36m ahead along the exit vector
      this.camStation3.set(
        this.endPos.x + Math.sin(this.peakHeading) * 36.0 + Math.cos(this.peakHeading) * 14.0,
        Math.max(16.0, this.endPos.y + 18.0),
        this.endPos.z + Math.cos(this.peakHeading) * 36.0 - Math.sin(this.peakHeading) * 14.0,
      );
    }
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

    // Multi-angle Cinematic Camera Director (TRUE GOD'S-EYE BROADCAST VIEWS)
    let newCamIndex: 1 | 2 | 3 = 1;
    let camLabel = '[ CAM 01 // GODS-EYE SKY TOWER OVERVIEW ]';
    let targetFov = 58;

    if (this.elapsed < 1.8) {
      // Angle 1: High God's-Eye Sky Tower Overview (上帝天眼俯瞰高塔机位)
      // Stationary overhead camera overlooking the entire sector, panning to track boat racing below
      newCamIndex = 1;
      camLabel = '[ CAM 01 // GODS-EYE SKY TOWER OVERVIEW ]';
      targetFov = 58;

      const craneDrift = (this.elapsed / 1.8) * 3.5;
      this.targetCamPos.copy(this.camStation1).add(new THREE.Vector3(0, craneDrift, 0));
      this.targetLookAt.set(this.boatPos.x, this.boatPos.y + 0.8, this.boatPos.z);

    } else if (this.elapsed < 3.8) {
      // Angle 2: 360° Sky Orbit & Bullet-Time (上帝高空360度大回旋 / 子弹时间慢镜头定格)
      // Elevated aerial helicopter camera smoothly sweeps 360 around the climax from high above
      newCamIndex = 2;
      camLabel = '[ CAM 02 // 360° SKY-ORBIT BULLET-TIME ]';
      targetFov = 52;

      const orbitPhase = (this.elapsed - 1.8) / 2.0;
      const orbitAngle = this.peakHeading + Math.PI * 0.65 + orbitPhase * Math.PI * 1.6;
      const radius = 24.0;
      const height = 16.0 - Math.sin(orbitPhase * Math.PI) * 4.0; // High aerial swoop

      this.targetCamPos.set(
        this.peakPos.x + Math.sin(orbitAngle) * radius,
        Math.max(12.0, this.peakPos.y + height),
        this.peakPos.z + Math.cos(orbitAngle) * radius,
      );

      this.targetLookAt.set(
        this.boatPos.x,
        this.boatPos.y + 0.85,
        this.boatPos.z,
      );

    } else {
      // Angle 3: Sky High Telephoto Exit Overlook (高空长焦前迎过顶俯拍 / 绝尘而去)
      // Stationary sky camera perched ahead looking back as the boat blazes past underneath
      newCamIndex = 3;
      camLabel = '[ CAM 03 // SKY HIGH TELEPHOTO OVERLOOK ]';
      targetFov = 48;

      this.targetCamPos.copy(this.camStation3);
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
