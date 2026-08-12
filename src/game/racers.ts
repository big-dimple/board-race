import type { RacerDefinition } from '../contracts';
import { PALETTE } from '../core/palette';
import axlePortrait from '../assets/drivers/axle.webp';
import tidePortrait from '../assets/drivers/tide.webp';
import solPortrait from '../assets/drivers/sol.webp';
import reefPortrait from '../assets/drivers/reef.webp';
import kaiPortrait from '../assets/drivers/kai.webp';
import jinxPortrait from '../assets/drivers/jinx.webp';

export type DriverMood = '沉稳' | '骄傲' | '愤怒' | '专注' | '兴奋' | '冷酷';

export interface DriverHandling {
  acceleration: number;
  steering: number;
  driftCharge: number;
  airControl: number;
}

export interface DriverProfile {
  id: string;
  name: string;
  callsign: string;
  age: number;
  pronouns: '他' | '她';
  portraitUrl: string;
  /** CSS object-position for portraits with different source compositions. */
  portraitPosition: string;
  color: number;
  personality: RacerDefinition['personality'];
  pace: number;
  mood: DriverMood;
  moodIcon: string;
  specialty: string;
  strength: string;
  weakness: string;
  quote: string;
  handling: DriverHandling;
  rivalRank: number;
}

const DRIVER_STORAGE_KEY = 'board-race:driver:v1';

/** Adult drivers. Percent-style stats stay close enough that choice expresses style, not a difficulty trap. */
export const DRIVER_PROFILES: readonly DriverProfile[] = [
  {
    id: 'axle', name: 'AXLE', callsign: '轴心', age: 28, pronouns: '他', portraitUrl: axlePortrait, portraitPosition: '50% 22%',
    color: PALETTE.hullPlayer, personality: 'clean', pace: 0.985, mood: '沉稳', moodIcon: '◆',
    specialty: '平衡型', strength: '入弯稳定，空中修正宽容', weakness: '爆发力不是最高',
    quote: '让线路说话。', handling: { acceleration: 1, steering: 1, driftCharge: 1, airControl: 1.04 }, rivalRank: 2,
  },
  {
    id: 'tide', name: 'TIDE', callsign: '潮汐', age: 27, pronouns: '她', portraitUrl: tidePortrait, portraitPosition: '50% 5%',
    color: PALETTE.hullNova, personality: 'clean', pace: 0.99, mood: '冷酷', moodIcon: '◈',
    specialty: '飞行专家', strength: '空刹精准，姿态恢复最快', weakness: '水面漂移蓄能稍慢',
    quote: '别眨眼，我只给一次机会。', handling: { acceleration: 0.99, steering: 1.01, driftCharge: 0.96, airControl: 1.06 }, rivalRank: 4,
  },
  {
    id: 'sol', name: 'SOL', callsign: '日曜', age: 26, pronouns: '她', portraitUrl: solPortrait, portraitPosition: '50% 22%',
    color: PALETTE.hullKai, personality: 'aggressive', pace: 1.01, mood: '骄傲', moodIcon: '▲',
    specialty: '起步猎手', strength: '加速强，超车窗口大胆', weakness: '急弯容易推头',
    quote: '第一名的位置，镜头最好。', handling: { acceleration: 1.05, steering: 0.97, driftCharge: 1.02, airControl: 0.99 }, rivalRank: 5,
  },
  {
    id: 'reef', name: 'REEF', callsign: '礁锋', age: 31, pronouns: '他', portraitUrl: reefPortrait, portraitPosition: '50% 22%',
    color: PALETTE.hullReef, personality: 'aggressive', pace: 1.025, mood: '愤怒', moodIcon: '!',
    specialty: '贴身强攻', strength: '晚刹、卡位、出弯速度极强', weakness: '持续施压时线路偏冒险',
    quote: '你领先，只是因为我还没动手。', handling: { acceleration: 1.04, steering: 1.03, driftCharge: 1.04, airControl: 0.98 }, rivalRank: 6,
  },
  {
    id: 'kai', name: 'KAI', callsign: '界线', age: 30, pronouns: '他', portraitUrl: kaiPortrait, portraitPosition: '50% 22%',
    color: PALETTE.hullVolt, personality: 'clean', pace: 1.02, mood: '专注', moodIcon: '●',
    specialty: '基准冠军', strength: '线路近乎无误，后程持续追击', weakness: '被迫近身时略保守',
    quote: '误差会累积，我不会。', handling: { acceleration: 1.01, steering: 1.04, driftCharge: 0.99, airControl: 1.04 }, rivalRank: 7,
  },
  {
    id: 'jinx', name: 'JINX', callsign: '变数', age: 25, pronouns: '他', portraitUrl: jinxPortrait, portraitPosition: '50% 22%',
    color: PALETTE.hullJinx, personality: 'erratic', pace: 0.965, mood: '兴奋', moodIcon: '✦',
    specialty: '漂移赌徒', strength: '蓄能快，偶尔跑出神级线路', weakness: '节奏波动明显',
    quote: '稳有什么意思？', handling: { acceleration: 0.98, steering: 1.02, driftCharge: 1.06, airControl: 0.97 }, rivalRank: 1,
  },
] as const;

export function driverProfile(id: string): DriverProfile {
  return DRIVER_PROFILES.find((profile) => profile.id === id) ?? DRIVER_PROFILES[0];
}

export function loadSelectedDriver(): string {
  try {
    const id = localStorage.getItem(DRIVER_STORAGE_KEY) ?? '';
    return DRIVER_PROFILES.some((profile) => profile.id === id) ? id : DRIVER_PROFILES[0].id;
  } catch {
    return DRIVER_PROFILES[0].id;
  }
}

export function saveSelectedDriver(id: string): void {
  try {
    localStorage.setItem(DRIVER_STORAGE_KEY, driverProfile(id).id);
  } catch {
    // Selection persistence is optional; the active session still uses the choice.
  }
}

const GRID = [
  { startPlace: 4, startDistance: 22, startLateral: 0, lane: 0 },
  { startPlace: 1, startDistance: 9, startLateral: 0, lane: 0 },
  { startPlace: 2, startDistance: 15, startLateral: -5.5, lane: -4 },
  { startPlace: 3, startDistance: 15, startLateral: 5.5, lane: 4 },
  { startPlace: 5, startDistance: 28, startLateral: -5.5, lane: -4 },
  { startPlace: 6, startDistance: 28, startLateral: 5.5, lane: 4 },
] as const;

/** Put the selected profile in physical slot 0 and seed the two strongest remaining rivals ahead. */
export function buildRaceRoster(selectedId: string): readonly RacerDefinition[] {
  const selected = driverProfile(selectedId);
  const opponents = DRIVER_PROFILES.filter((profile) => profile.id !== selected.id)
    .sort((a, b) => b.rivalRank - a.rivalRank);
  const profiles = [selected, ...opponents];
  return profiles.map((profile, id) => ({
    id,
    profileId: profile.id,
    name: id === 0 ? profile.name : profile.name,
    color: profile.color,
    portraitUrl: profile.portraitUrl,
    isPlayer: id === 0,
    personality: profile.personality,
    pace: id === 0 ? 1 : profile.pace,
    lane: GRID[id].lane,
    startPlace: GRID[id].startPlace,
    startDistance: GRID[id].startDistance,
    startLateral: GRID[id].startLateral,
  }));
}

/** Single source of truth for construction, AI pace, lanes and the six-place grid. */
export const RACER_DEFS: readonly RacerDefinition[] = buildRaceRoster(DRIVER_PROFILES[0].id);

export const RACER_COLORS: readonly number[] = RACER_DEFS.map((racer) => racer.color);
export const RACER_NAMES: readonly string[] = RACER_DEFS.map((racer) => racer.name);
