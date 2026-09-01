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

export interface HighlightCandidate {
  time: number;
  kind: StuntKind;
  weight: number; // 0 - 100
  score: number;  // 100 - 1500
  title: string;
  detail: string;
  badge: string;
  rating: string;
}

export class HighlightRecorder {
  private readonly samples: HighlightSample[] = [];
  private readonly candidates: HighlightCandidate[] = [];
  private sampleCursor = 0;
  private sampleCount = 0;

  // Fallback defaults
  private peakStuntScore = 0;
  private peakStuntTime = 0;
  private peakStuntKind: StuntKind = 'flight';
  private peakStuntTitle = '🚀 破空翱翔 · 极速穿云';
  private peakStuntDetail = '天际雾桥 · 完美腾空穿透光门';
  private peakStuntBadge = '👑 破空神话';
  private peakStuntRating = '[ SSS · 破空神话 ]';

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
    this.candidates.length = 0;
    this.peakStuntScore = 0;
    this.peakStuntTime = 0;
    this.peakStuntKind = 'flight';
    this.peakStuntTitle = '🚀 破空翱翔 · 极速穿云';
    this.peakStuntDetail = '天际雾桥 · 完美腾空穿透光门';
    this.peakStuntBadge = '👑 破空神话';
    this.peakStuntRating = '[ SSS · 破空神话 ]';
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

    // Evaluate dynamic positive stunts (High Weight Candidates)
    if (p.flightPhase !== 'surface') {
      // 1. SSS Flight Corridor Gate Pass (Weight: 100)
      const speedKmh = Math.round(p.speed * 3.6);
      const score = 1200 + Math.min(300, Math.max(0, p.speed - 22) * 15);
      this.tagCandidate('flight', score, 100, time, `🚀 破空翱翔 · ${speedKmh} KM/H 穿云过门`, '天际雾桥 · 完美腾空穿透光门', '👑 破空神话', '[ SSS · 破空神话 ]');
    } else if (p.drifting && Math.abs(p.lateralG) > 6.5 && p.speed > 10) {
      // 2. SSS Apex High-G Power Drift (Weight: 85)
      const speedKmh = Math.round(p.speed * 3.6);
      const score = 900 + Math.min(300, Math.abs(p.lateralG) * 15 + Math.max(0, p.speed - 12) * 8);
      this.tagCandidate('apex_drift', score, 85, time, `⚡ 极限贴弯 · ${speedKmh} KM/H 完美过弯`, '牢牢咬住弯心 · 侧舷水花漫天', '⚡ 弯道主宰', '[ SSS · 弯道主宰 ]');
    } else if (p.boosting && p.speed > 16) {
      // 3. SS Jet Boost / Overtake Burst (Weight: 75)
      const speedKmh = Math.round(p.speed * 3.6);
      const score = 800 + Math.min(250, p.speed * 6);
      this.tagCandidate('speed_burst', score, 75, time, `🔥 绝影突袭 · ${speedKmh} KM/H 破风喷射`, '尾焰全开 · 狂暴推进超速破浪', '🔥 破风之刃', '[ SS · 猎风突袭 ]');
    } else if (p.position.y > 1.2 && !p.drifting && p.flightPhase === 'surface') {
      // 4. S Wave Crest Jump (Weight: 65)
      const speedKmh = Math.round(p.speed * 3.6);
      const score = 700 + Math.min(200, Math.max(0, p.position.y) * 40 + p.speed * 3);
      this.tagCandidate('coin_frenzy', score, 65, time, `🌊 惊涛腾跃 · ${speedKmh} KM/H 踏浪起飞`, '逐浪腾空绝美滑翔 · 极致水花视觉拉满', '🌊 逐浪之魂', '[ S · 逐浪飞仙 ]');
    }

    this.sampleCursor = (this.sampleCursor + 1) % MAX_SAMPLES;
    if (this.sampleCount < MAX_SAMPLES) this.sampleCount++;
  }

  tagCandidate(
    kind: StuntKind,
    score: number,
    weight: number,
    time: number,
    title: string,
    detail: string,
    badge: string,
    rating: string,
  ): void {
    // Deduplicate or update candidate within 1.5s window
    const existing = this.candidates.find((c) => Math.abs(c.time - time) < 1.5 && c.kind === kind);
    if (existing) {
      if (score > existing.score) {
        existing.score = score;
        existing.weight = weight;
        existing.time = time;
        existing.title = title;
        existing.detail = detail;
        existing.badge = badge;
        existing.rating = rating;
      }
      return;
    }

    this.candidates.push({
      time,
      kind,
      weight,
      score,
      title,
      detail,
      badge,
      rating,
    });

    // Keep candidate buffer bounded
    if (this.candidates.length > 50) {
      this.candidates.shift();
    }
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
    this.tagCandidate(kind, score, 80, time, title, detail, badge, rating);
  }

  tagDefeat(failure: FlightFailureSnapshot | null | undefined, time: number, speed: number, isDuo = false): void {
    const isFlightCorridor = failure !== null && failure !== undefined;
    // Defeat has low weight (15) so it only plays if no positive achievements occurred
    const weight = 15;
    const score = isFlightCorridor ? 120 : 60;
    const peakTime = Math.max(0, time - 0.8);

    if (isDuo && isFlightCorridor) {
      this.tagCandidate(
        'crash_climax',
        score,
        weight,
        peakTime,
        '💥 我挂了你也别想好过！',
        '空中走廊遭遇核弹级背刺 · 华丽翻车同归于尽',
        '🎪 喜剧之神',
        '[ EX · 喜剧之神 ]',
      );
    } else if (isFlightCorridor) {
      this.tagCandidate(
        'crash_climax',
        score,
        weight,
        peakTime,
        '💥 极限空翻 · 华丽翻车！',
        '空中走廊极限翻车 · 华丽姿态喜剧拉满',
        '🎪 喜剧之神',
        '[ EX · 喜剧之神 ]',
      );
    } else {
      const speedKmh = Math.round(speed * 3.6);
      this.tagCandidate(
        'crash_climax',
        score,
        weight,
        peakTime,
        `💥 弹力四射 · ${speedKmh} km/h 极限回弹 720°`,
        '高强度防撞橡胶梁拉满 · 经典喜剧弹射',
        '🎪 喜剧之王',
        '[ EX · 喜剧之王 ]',
      );
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

    const earliestTime = this.getEarliestSampleTime();

    // Find highest weighted candidate within the available buffer window
    let bestCandidate: HighlightCandidate | null = null;
    let bestEffectiveScore = -1;

    for (const c of this.candidates) {
      if (c.time >= earliestTime - 0.5 && c.time <= currentTime + 0.5) {
        const effectiveScore = c.score * (c.weight / 100);
        if (effectiveScore > bestEffectiveScore) {
          bestEffectiveScore = effectiveScore;
          bestCandidate = c;
        }
      }
    }

    let peakTime = bestCandidate ? bestCandidate.time : this.peakStuntTime;
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

    const stuntKind = bestCandidate ? bestCandidate.kind : this.peakStuntKind;
    const stuntScore = bestCandidate ? Math.round(bestCandidate.score) : 100;
    const stuntTitle = bestCandidate ? bestCandidate.title : this.peakStuntTitle;
    const stuntDetail = bestCandidate ? bestCandidate.detail : this.peakStuntDetail;
    const stuntBadge = bestCandidate ? bestCandidate.badge : this.peakStuntBadge;
    const stuntRating = bestCandidate ? bestCandidate.rating : this.peakStuntRating;

    return {
      startTime,
      endTime,
      peakTime,
      duration: Math.max(1.0, endTime - startTime),
      stuntKind,
      stuntScore,
      stuntTitle,
      stuntDetail,
      stuntBadge,
      stuntRating,
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
