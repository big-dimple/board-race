import * as THREE from 'three';
import type { IBoat, FlightFailureSnapshot } from '../contracts';
import type { ReplayMissileSnapshot } from './duoInteraction';

export type StuntKind = 'flight' | 'apex_drift' | 'coin_frenzy' | 'speed_burst' | 'airbrake' | 'crash_climax' | 'missile_strike';

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
  missiles: ReplayMissileSnapshot[];
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

function createEmptyMissileSample(index: number): ReplayMissileSnapshot {
  return {
    x: 0,
    y: 0,
    z: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    active: false,
    isDwell: false,
    dwellProgress: 0,
    kind: index % 2 === 1 ? 'shark' : 'tomahawk',
  };
}

export interface HighlightCandidate {
  time: number;
  kind: StuntKind;
  weight: number; // 0 - 100
  score: number;  // 100 - 1800
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
  private readonly scratchQuat = new THREE.Quaternion();

  constructor() {
    for (let i = 0; i < MAX_SAMPLES; i++) {
      this.samples.push({
        time: 0,
        player: createEmptyBoatSample(),
        rivals: Array.from({ length: 5 }, () => createEmptyBoatSample()),
        missiles: Array.from({ length: 4 }, (_, m) => createEmptyMissileSample(m)),
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

  recordFrame(
    boats: readonly IBoat[],
    time: number,
    waveHeight = 0,
    missiles?: readonly ReplayMissileSnapshot[],
  ): void {
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

    // Record Active Missiles
    if (missiles) {
      for (let m = 0; m < missiles.length && m < sample.missiles.length; m++) {
        const src = missiles[m];
        const dst = sample.missiles[m];
        dst.active = src.active;
        dst.isDwell = src.isDwell;
        dst.dwellProgress = src.dwellProgress;
        dst.kind = src.kind;
        dst.x = src.x;
        dst.y = src.y;
        dst.z = src.z;
        dst.qx = src.qx;
        dst.qy = src.qy;
        dst.qz = src.qz;
        dst.qw = src.qw;
      }
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
    const isMissile = failure?.reason === 'missile_blast';
    const isFlightCorridor = failure !== null && failure !== undefined;
    const peakTime = Math.max(0, time);

    if (isMissile) {
      // Missile Strike Climax: Maximum Weight (100) & Score (1680) so it 100% takes the highlight spot!
      this.tagCandidate(
        'missile_strike',
        1680,
        100,
        peakTime,
        '💥 遭遇超音速导弹轰杀 · 翻滚 720°',
        '飞行空域遭遇战斧/鲨鱼导弹精准直击 · 720° 腾云爆炸坠海',
        '🎪 喜剧之神',
        '[ EX · 喜剧之神 // 凌空轰炸 ]',
      );
    } else if (isDuo && isFlightCorridor) {
      this.tagCandidate(
        'crash_climax',
        1350,
        90,
        peakTime,
        '💥 极限空翻 · 华丽坠海！',
        '双人竞技遭遇极限失误 · 华丽翻滚喜剧拉满',
        '🎪 喜剧之神',
        '[ EX · 喜剧之神 ]',
      );
    } else if (isFlightCorridor) {
      this.tagCandidate(
        'crash_climax',
        1250,
        85,
        peakTime,
        '💥 极限腾空 · 华丽坠海！',
        '空中走廊极限挑战 · 华丽姿态喜剧拉满',
        '🎪 喜剧之王',
        '[ EX · 喜剧之王 ]',
      );
    } else {
      const speedKmh = Math.round(speed * 3.6);
      this.tagCandidate(
        'crash_climax',
        1100,
        70,
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

    // Lead-in 2.8s before peak, 4.7s after peak (total 7.5s clip)
    let startTime = peakTime - 2.8;
    let endTime = peakTime + 4.7;

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
          missiles: s.missiles.map((m) => ({ ...m })),
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
    outMissiles?: ReplayMissileSnapshot[],
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
      if (outMissiles) {
        for (let m = 0; m < outMissiles.length && m < s.missiles.length; m++) {
          const sm = s.missiles[m];
          const om = outMissiles[m];
          om.active = sm.active;
          om.isDwell = sm.isDwell;
          om.dwellProgress = sm.dwellProgress;
          om.kind = sm.kind;
          om.x = sm.x;
          om.y = sm.y;
          om.z = sm.z;
          om.qx = sm.qx;
          om.qy = sm.qy;
          om.qz = sm.qz;
          om.qw = sm.qw;
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
      if (outMissiles) {
        for (let m = 0; m < outMissiles.length && m < last.missiles.length; m++) {
          const sm = last.missiles[m];
          const om = outMissiles[m];
          om.active = sm.active;
          om.isDwell = sm.isDwell;
          om.dwellProgress = sm.dwellProgress;
          om.kind = sm.kind;
          om.x = sm.x;
          om.y = sm.y;
          om.z = sm.z;
          om.qx = sm.qx;
          om.qy = sm.qy;
          om.qz = sm.qz;
          om.qw = sm.qw;
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

    if (outMissiles) {
      for (let m = 0; m < outMissiles.length && m < sa.missiles.length && m < sb.missiles.length; m++) {
        const ma = sa.missiles[m];
        const mb = sb.missiles[m];
        const om = outMissiles[m];
        om.active = alpha > 0.5 ? mb.active : ma.active;
        om.isDwell = alpha > 0.5 ? mb.isDwell : ma.isDwell;
        om.dwellProgress = ma.dwellProgress + (mb.dwellProgress - ma.dwellProgress) * alpha;
        om.kind = mb.kind;
        om.x = ma.x + (mb.x - ma.x) * alpha;
        om.y = ma.y + (mb.y - ma.y) * alpha;
        om.z = ma.z + (mb.z - ma.z) * alpha;
        this.qA.set(ma.qx, ma.qy, ma.qz, ma.qw);
        this.qB.set(mb.qx, mb.qy, mb.qz, mb.qw);
        this.scratchQuat.copy(this.qA).slerp(this.qB, alpha);
        om.qx = this.scratchQuat.x;
        om.qy = this.scratchQuat.y;
        om.qz = this.scratchQuat.z;
        om.qw = this.scratchQuat.w;
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
