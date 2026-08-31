import * as THREE from 'three';
import type { IBoat, FlightFailureSnapshot } from '../contracts';

export type StuntKind = 'flight' | 'apex_drift' | 'coin_frenzy' | 'speed_burst' | 'airbrake' | 'crash_climax';

export interface BoatReplaySample {
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
  drifting: boolean;
  boosting: boolean;
}

export interface HighlightSample {
  time: number;
  player: BoatReplaySample;
  rivals: BoatReplaySample[];
  waveHeight: number;
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

const MAX_SAMPLES = 720; // 12 seconds ring buffer at 60 Hz
export const CLIP_DURATION = 7.5; // 7.5 seconds complete broadcast clip

function createEmptyBoatSample(): BoatReplaySample {
  return {
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
    drifting: false,
    boosting: false,
  };
}

export class HighlightRecorder {
  private readonly samples: HighlightSample[] = [];
  private sampleCursor = 0;
  private sampleCount = 0;
  private peakStuntScore = 0;
  private peakStuntTime = 0;
  private peakStuntKind: StuntKind = 'flight';
  private peakStuntTitle = '🚀 破空翱翔 · 极速穿云';
  private peakStuntDetail = '天际雾桥 · 完美腾空穿透光门';
  private peakStuntBadge = '👑 绝顶破空';
  private peakStuntRating = '[ SSS · 极速传说 ]';

  // Scratch quaternions for slerp
  private readonly qA = new THREE.Quaternion();
  private readonly qB = new THREE.Quaternion();

  constructor() {
    for (let i = 0; i < MAX_SAMPLES; i++) {
      this.samples.push({
        time: 0,
        player: createEmptyBoatSample(),
        rivals: Array.from({ length: 5 }, () => createEmptyBoatSample()),
        waveHeight: 0,
      });
    }
  }

  reset(): void {
    this.sampleCursor = 0;
    this.sampleCount = 0;
    this.peakStuntScore = 0;
    this.peakStuntTime = 0;
    this.peakStuntKind = 'flight';
    this.peakStuntTitle = '🚀 破空翱翔 · 极速穿云';
    this.peakStuntDetail = '天际雾桥 · 完美腾空穿透光门';
    this.peakStuntBadge = '👑 绝顶破空';
    this.peakStuntRating = '[ SSS · 极速传说 ]';
  }

  recordFrame(boats: readonly IBoat[], time: number, waveHeight = 0): void {
    if (boats.length === 0) return;
    const sample = this.samples[this.sampleCursor];
    sample.time = time;
    sample.waveHeight = waveHeight;

    // Record Player Boat (boats[0])
    const p = boats[0].state;
    sample.player.x = p.position.x;
    sample.player.y = p.position.y;
    sample.player.z = p.position.z;
    sample.player.qx = p.quaternion.x;
    sample.player.qy = p.quaternion.y;
    sample.player.qz = p.quaternion.z;
    sample.player.qw = p.quaternion.w;
    sample.player.speed = p.speed;
    sample.player.lateralG = p.lateralG;
    sample.player.drifting = p.drifting;
    sample.player.boosting = p.boosting;
    sample.player.mode = p.flightPhase !== 'surface' ? p.flightPhase : p.boosting ? 'boost' : p.drifting ? 'drift' : 'surface';

    // Record all Rival Boats (boats[1..N])
    for (let r = 1; r < boats.length && r - 1 < sample.rivals.length; r++) {
      const rivalState = boats[r].state;
      const rSample = sample.rivals[r - 1];
      rSample.x = rivalState.position.x;
      rSample.y = rivalState.position.y;
      rSample.z = rivalState.position.z;
      rSample.qx = rivalState.quaternion.x;
      rSample.qy = rivalState.quaternion.y;
      rSample.qz = rivalState.quaternion.z;
      rSample.qw = rivalState.quaternion.w;
      rSample.speed = rivalState.speed;
      rSample.lateralG = rivalState.lateralG;
      rSample.drifting = rivalState.drifting;
      rSample.boosting = rivalState.boosting;
      rSample.mode = rivalState.flightPhase !== 'surface' ? rivalState.flightPhase : rivalState.boosting ? 'boost' : rivalState.drifting ? 'drift' : 'surface';
    }

    // Evaluate dynamic positive stunts
    if (p.flightPhase !== 'surface') {
      const speedKmh = Math.round(p.speed * 3.6);
      const score = 190 + Math.min(50, Math.max(0, p.speed - 24) * 3);
      if (score > this.peakStuntScore) {
        this.tagEvent('flight', score, time, `🚀 破空翱翔 · ${speedKmh} km/h 穿云过门`, '天际雾桥 · 完美腾空穿透光门', '👑 绝顶破空', '[ SSS · 极速传说 ]');
      }
    } else if (p.boosting) {
      const speedKmh = Math.round(p.speed * 3.6);
      const score = 160 + Math.min(40, p.speed * 1.5);
      if (score > this.peakStuntScore) {
        this.tagEvent('speed_burst', score, time, `⚡ 极速狂飙 · ${speedKmh} km/h 破空喷射`, '尾焰全开 · 狂暴冲刺', '🔥 破风之刃', '[ SS · 极速破空 ]');
      }
    } else if (p.drifting && Math.abs(p.lateralG) > 9) {
      const score = 170 + Math.min(40, Math.abs(p.lateralG) * 2.5);
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
    const isFlightCorridor = failure !== null && failure !== undefined;
    const score = isFlightCorridor ? 280 : 40;
    if (score >= this.peakStuntScore) {
      this.peakStuntScore = score;
      this.peakStuntTime = Math.max(0, time - 0.8);
      this.peakStuntKind = 'crash_climax';
      if (isFlightCorridor) {
        this.peakStuntTitle = '💥 我死了你也别想好过！';
        this.peakStuntDetail = '空中走廊遭遇极限坠毁 · 华丽翻车喜剧效果拉满';
        this.peakStuntBadge = '🎪 喜剧之神';
        this.peakStuntRating = '[ EX · 喜剧之神 ]';
      } else {
        const speedKmh = Math.round(speed * 3.6);
        this.peakStuntTitle = `💥 弹力四射 · ${speedKmh} km/h 极限回弹 720°`;
        this.peakStuntDetail = '高强度防撞橡胶梁拉满 · 经典喜剧弹射';
        this.peakStuntBadge = '🎪 喜剧之王';
        this.peakStuntRating = '[ EX · 喜剧之王 ]';
      }
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
        stuntKind: 'flight',
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
      peakTime = Math.max(earliestTime + CLIP_DURATION * 0.5, currentTime - 2.0);
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
        clipSamples.push({
          time: s.time,
          player: { ...s.player },
          rivals: s.rivals.map((r) => ({ ...r })),
          waveHeight: s.waveHeight,
        });
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
    outPlayerPos: THREE.Vector3,
    outPlayerQuat: THREE.Quaternion,
    outRivals?: Array<{ pos: THREE.Vector3; quat: THREE.Quaternion; speed: number; mode: string }>,
  ): BoatReplaySample {
    const list = clip.samples;
    if (list.length === 0) {
      outPlayerPos.set(0, 0, 0);
      outPlayerQuat.identity();
      return createEmptyBoatSample();
    }
    if (list.length === 1 || targetTime <= list[0].time) {
      const s = list[0];
      outPlayerPos.set(s.player.x, s.player.y, s.player.z);
      outPlayerQuat.set(s.player.qx, s.player.qy, s.player.qz, s.player.qw);
      if (outRivals) {
        for (let r = 0; r < outRivals.length && r < s.rivals.length; r++) {
          const riv = s.rivals[r];
          outRivals[r].pos.set(riv.x, riv.y, riv.z);
          outRivals[r].quat.set(riv.qx, riv.qy, riv.qz, riv.qw);
          outRivals[r].speed = riv.speed;
          outRivals[r].mode = riv.mode;
        }
      }
      return s.player;
    }
    const last = list[list.length - 1];
    if (targetTime >= last.time) {
      outPlayerPos.set(last.player.x, last.player.y, last.player.z);
      outPlayerQuat.set(last.player.qx, last.player.qy, last.player.qz, last.player.qw);
      if (outRivals) {
        for (let r = 0; r < outRivals.length && r < last.rivals.length; r++) {
          const riv = last.rivals[r];
          outRivals[r].pos.set(riv.x, riv.y, riv.z);
          outRivals[r].quat.set(riv.qx, riv.qy, riv.qz, riv.qw);
          outRivals[r].speed = riv.speed;
          outRivals[r].mode = riv.mode;
        }
      }
      return last.player;
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

    outPlayerPos.set(
      sa.player.x + (sb.player.x - sa.player.x) * alpha,
      sa.player.y + (sb.player.y - sa.player.y) * alpha,
      sa.player.z + (sb.player.z - sa.player.z) * alpha,
    );

    this.qA.set(sa.player.qx, sa.player.qy, sa.player.qz, sa.player.qw);
    this.qB.set(sb.player.qx, sb.player.qy, sb.player.qz, sb.player.qw);
    outPlayerQuat.copy(this.qA).slerp(this.qB, alpha);

    if (outRivals) {
      for (let r = 0; r < outRivals.length && r < sa.rivals.length && r < sb.rivals.length; r++) {
        const ra = sa.rivals[r];
        const rb = sb.rivals[r];
        outRivals[r].pos.set(
          ra.x + (rb.x - ra.x) * alpha,
          ra.y + (rb.y - ra.y) * alpha,
          ra.z + (rb.z - ra.z) * alpha,
        );
        this.qA.set(ra.qx, ra.qy, ra.qz, ra.qw);
        this.qB.set(rb.qx, rb.qy, rb.qz, rb.qw);
        outRivals[r].quat.copy(this.qA).slerp(this.qB, alpha);
        outRivals[r].speed = ra.speed + (rb.speed - ra.speed) * alpha;
        outRivals[r].mode = alpha > 0.5 ? rb.mode : ra.mode;
      }
    }

    return {
      x: outPlayerPos.x,
      y: outPlayerPos.y,
      z: outPlayerPos.z,
      qx: outPlayerQuat.x,
      qy: outPlayerQuat.y,
      qz: outPlayerQuat.z,
      qw: outPlayerQuat.w,
      speed: sa.player.speed + (sb.player.speed - sa.player.speed) * alpha,
      lateralG: sa.player.lateralG + (sb.player.lateralG - sa.player.lateralG) * alpha,
      mode: alpha > 0.5 ? sb.player.mode : sa.player.mode,
      drifting: alpha > 0.5 ? sb.player.drifting : sa.player.drifting,
      boosting: alpha > 0.5 ? sb.player.boosting : sa.player.boosting,
    };
  }

  private getEarliestSampleTime(): number {
    if (this.sampleCount === 0) return 0;
    const oldestIdx = (this.sampleCursor - this.sampleCount + MAX_SAMPLES) % MAX_SAMPLES;
    return this.samples[oldestIdx].time;
  }
}
