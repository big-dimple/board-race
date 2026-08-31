import * as THREE from 'three';
import type { IBoat, FlightFailureSnapshot } from '../contracts';

export type StuntKind = 'flight' | 'apex_drift' | 'coin_frenzy' | 'speed_burst' | 'airbrake' | 'crash_climax';

export interface HighlightSample {
  time: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  speed: number;
  lateralG: number;
  mode: string;
  boostCharge: number;
  flightClearance: number;
  waveHeight: number;
  stuntKind?: StuntKind;
  stuntScore?: number;
  stuntTitle?: string;
  stuntDetail?: string;
}

export interface HighlightClip {
  startTime: number;
  endTime: number;
  peakTime: number;
  duration: number;
  stuntKind: StuntKind;
  stuntScore: number;
  stuntTitle: string;
  stuntDetail: string;
  stuntBadge: string;
  stuntRating: string;
  samples: readonly HighlightSample[];
}

const MAX_SAMPLES = 600; // ~10 seconds at 60 Hz
const CLIP_DURATION = 4.5; // 4.5 seconds clip length

export class HighlightRecorder {
  private readonly samples: HighlightSample[] = [];
  private sampleCursor = 0;
  private sampleCount = 0;
  private peakStuntScore = 0;
  private peakStuntTime = 0;
  private peakStuntKind: StuntKind = 'crash_climax';
  private peakStuntTitle = '绝境冲刺 · 虽败犹荣';
  private peakStuntDetail = '极速入弯 · 极限姿态';
  private peakStuntBadge = '★ 精彩回放';
  private peakStuntRating = '[ SS · 极限冲刺 ]';

  // Scratch vectors for interpolation
  private readonly qA = new THREE.Quaternion();
  private readonly qB = new THREE.Quaternion();

  constructor() {
    for (let i = 0; i < MAX_SAMPLES; i++) {
      this.samples.push({
        time: 0,
        x: 0,
        y: 0,
        z: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
        speed: 0,
        lateralG: 0,
        mode: 'surface',
        boostCharge: 0,
        flightClearance: 0,
        waveHeight: 0,
      });
    }
  }

  reset(): void {
    this.sampleCursor = 0;
    this.sampleCount = 0;
    this.peakStuntScore = 0;
    this.peakStuntTime = 0;
    this.peakStuntKind = 'crash_climax';
    this.peakStuntTitle = '绝境冲刺 · 虽败犹荣';
    this.peakStuntDetail = '极速入弯 · 极限姿态';
    this.peakStuntBadge = '★ 精彩回放';
    this.peakStuntRating = '[ SS · 极限冲刺 ]';
  }

  recordFrame(boat: IBoat, time: number, waveHeight = 0): void {
    const s = boat.state;
    const sample = this.samples[this.sampleCursor];
    sample.time = time;
    sample.x = s.position.x;
    sample.y = s.position.y;
    sample.z = s.position.z;
    sample.qx = s.quaternion.x;
    sample.qy = s.quaternion.y;
    sample.qz = s.quaternion.z;
    sample.qw = s.quaternion.w;
    sample.speed = s.speed;
    sample.lateralG = s.lateralG;
    sample.mode = s.flightPhase !== 'surface' ? s.flightPhase : s.boosting ? 'boost' : s.drifting ? 'drift' : 'surface';
    sample.boostCharge = s.boostCharge;
    sample.flightClearance = s.flightClearance;
    sample.waveHeight = waveHeight;
    sample.stuntKind = undefined;
    sample.stuntScore = undefined;
    sample.stuntTitle = undefined;
    sample.stuntDetail = undefined;

    // Evaluate dynamic stunts in flight / drift
    if (s.flightPhase !== 'surface') {
      const speedKmh = Math.round(s.speed * 3.6);
      if (s.speed > 28) {
        const score = 80 + Math.min(40, (s.speed - 28) * 3);
        if (score > this.peakStuntScore) {
          this.tagEvent('flight', score, time, `🚀 破空翱翔 · ${speedKmh} km/h 穿云过门`, '天际雾桥 · 完美腾空穿透光门', '👑 绝顶破空', '[ SSS · 极速传说 ]');
        }
      }
    } else if (s.boosting) {
      const speedKmh = Math.round(s.speed * 3.6);
      const score = 70 + Math.min(30, s.speed * 1.5);
      if (score > this.peakStuntScore) {
        this.tagEvent('speed_burst', score, time, `⚡ 极速狂飙 · ${speedKmh} km/h 破空喷射`, '尾焰全开 · 狂暴冲刺', '🔥 破风之刃', '[ SS · 极速破空 ]');
      }
    } else if (s.drifting && Math.abs(s.lateralG) > 12) {
      const score = 65 + Math.min(35, Math.abs(s.lateralG) * 2);
      if (score > this.peakStuntScore) {
        this.tagEvent('apex_drift', score, time, `🏎️ 极限贴弯 · 完美弯心过弯`, '死死咬住弯心 · 侧舷水花漫天', '⚡ 弯心狂鲨', '[ SS · 破浪狂鲨 ]');
      }
    }

    this.sampleCursor = (this.sampleCursor + 1) % MAX_SAMPLES;
    if (this.sampleCount < MAX_SAMPLES) this.sampleCount++;
  }

  tagEvent(
    kind: StuntKind,
    score: number,
    time: number,
    title: string,
    detail: string,
    badge = '★ 精彩高光',
    rating = '[ S · 荣耀瞬间 ]',
  ): void {
    if (score >= this.peakStuntScore) {
      this.peakStuntScore = score;
      this.peakStuntTime = time;
      this.peakStuntKind = kind;
      this.peakStuntTitle = title;
      this.peakStuntDetail = detail;
      this.peakStuntBadge = badge;
      this.peakStuntRating = rating;
    }
  }

  tagDefeat(failure: FlightFailureSnapshot | null | undefined, time: number, speed: number): void {
    if (this.peakStuntScore < 60) {
      const speedKmh = Math.round(speed * 3.6);
      const reasonLabel = failure?.reason === 'gate_left' || failure?.reason === 'gate_right' ? '掠门极速俯冲' :
        failure?.reason === 'corridor' ? '狂暴气流撕裂' :
          failure?.reason === 'landing' ? '水花剧烈激荡' : '极速狂飙';
      this.peakStuntScore = 60;
      this.peakStuntTime = Math.max(0, time - 0.6);
      this.peakStuntKind = 'crash_climax';
      this.peakStuntTitle = `💥 绝境狂飙 · ${speedKmh} km/h ${reasonLabel}`;
      this.peakStuntDetail = '极速冲刺至最后一刻 · 虽败犹荣';
      this.peakStuntBadge = '★ 狂暴冲刺';
      this.peakStuntRating = '[ SS · 极限冲刺 ]';
    }
  }

  getBestClip(currentTime: number): HighlightClip {
    const totalSamples = this.sampleCount;
    if (totalSamples === 0) {
      return {
        startTime: 0,
        endTime: CLIP_DURATION,
        peakTime: CLIP_DURATION * 0.5,
        duration: CLIP_DURATION,
        stuntKind: 'crash_climax',
        stuntScore: 50,
        stuntTitle: '绝境狂飙 · 虽败犹荣',
        stuntDetail: '极速入弯 · 极限姿态',
        stuntBadge: '★ 精彩回放',
        stuntRating: '[ S · 荣耀瞬间 ]',
        samples: [],
      };
    }

    let peakTime = this.peakStuntTime;
    const earliestTime = this.getEarliestSampleTime();
    if (peakTime <= 0 || peakTime < earliestTime || peakTime > currentTime) {
      peakTime = Math.max(earliestTime + CLIP_DURATION * 0.5, currentTime - 1.5);
    }

    const half = CLIP_DURATION * 0.5;
    let startTime = peakTime - half;
    let endTime = peakTime + half;

    if (startTime < earliestTime) {
      const shift = earliestTime - startTime;
      startTime += shift;
      endTime += shift;
    }
    if (endTime > currentTime) {
      const shift = endTime - currentTime;
      startTime = Math.max(earliestTime, startTime - shift);
      endTime = currentTime;
    }

    const clipSamples: HighlightSample[] = [];
    for (let i = 0; i < totalSamples; i++) {
      const idx = (this.sampleCursor - totalSamples + i + MAX_SAMPLES) % MAX_SAMPLES;
      const s = this.samples[idx];
      if (s.time >= startTime - 0.1 && s.time <= endTime + 0.1) {
        clipSamples.push({ ...s });
      }
    }

    return {
      startTime,
      endTime,
      peakTime,
      duration: Math.max(1.0, endTime - startTime),
      stuntKind: this.peakStuntKind,
      stuntScore: this.peakStuntScore,
      stuntTitle: this.peakStuntTitle,
      stuntDetail: this.peakStuntDetail,
      stuntBadge: this.peakStuntBadge,
      stuntRating: this.peakStuntRating,
      samples: clipSamples,
    };
  }

  sampleAt(
    clip: HighlightClip,
    targetTime: number,
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): { speed: number; lateralG: number; mode: string; boostCharge: number; flightClearance: number; waveHeight: number } {
    const list = clip.samples;
    if (list.length === 0) {
      outPos.set(0, 0, 0);
      outQuat.identity();
      return { speed: 0, lateralG: 0, mode: 'surface', boostCharge: 0, flightClearance: 0, waveHeight: 0 };
    }
    if (list.length === 1 || targetTime <= list[0].time) {
      const s = list[0];
      outPos.set(s.x, s.y, s.z);
      outQuat.set(s.qx, s.qy, s.qz, s.qw);
      return { speed: s.speed, lateralG: s.lateralG, mode: s.mode, boostCharge: s.boostCharge, flightClearance: s.flightClearance, waveHeight: s.waveHeight };
    }
    const last = list[list.length - 1];
    if (targetTime >= last.time) {
      outPos.set(last.x, last.y, last.z);
      outQuat.set(last.qx, last.qy, last.qz, last.qw);
      return { speed: last.speed, lateralG: last.lateralG, mode: last.mode, boostCharge: last.boostCharge, flightClearance: last.flightClearance, waveHeight: last.waveHeight };
    }

    let low = 0;
    let high = list.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (list[mid].time < targetTime) low = mid + 1;
      else high = mid - 1;
    }
    const idxA = Math.max(0, low - 1);
    const idxB = Math.min(list.length - 1, low);
    const sa = list[idxA];
    const sb = list[idxB];

    const dt = sb.time - sa.time;
    const alpha = dt > 1e-4 ? Math.max(0, Math.min(1, (targetTime - sa.time) / dt)) : 0;

    outPos.set(
      sa.x + (sb.x - sa.x) * alpha,
      sa.y + (sb.y - sa.y) * alpha,
      sa.z + (sb.z - sa.z) * alpha,
    );

    this.qA.set(sa.qx, sa.qy, sa.qz, sa.qw);
    this.qB.set(sb.qx, sb.qy, sb.qz, sb.qw);
    outQuat.copy(this.qA).slerp(this.qB, alpha);

    return {
      speed: sa.speed + (sb.speed - sa.speed) * alpha,
      lateralG: sa.lateralG + (sb.lateralG - sa.lateralG) * alpha,
      mode: alpha > 0.5 ? sb.mode : sa.mode,
      boostCharge: sa.boostCharge + (sb.boostCharge - sa.boostCharge) * alpha,
      flightClearance: sa.flightClearance + (sb.flightClearance - sa.flightClearance) * alpha,
      waveHeight: sa.waveHeight + (sb.waveHeight - sa.waveHeight) * alpha,
    };
  }

  private getEarliestSampleTime(): number {
    if (this.sampleCount === 0) return 0;
    if (this.sampleCount < MAX_SAMPLES) return this.samples[0].time;
    return this.samples[this.sampleCursor].time;
  }
}
