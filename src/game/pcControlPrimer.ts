import type { BoatState } from '../contracts';

export type PcControlPrimerStep =
  | 'off'
  | 'drift'
  | 'charging'
  | 'release'
  | 'banked'
  | 'waiting-launch'
  | 'launch'
  | 'success'
  | 'dismissed';

export interface PcControlPrimerPresentation {
  step: Exclude<PcControlPrimerStep, 'off' | 'waiting-launch' | 'dismissed'>;
  key: string;
  kicker: string;
  title: string;
  detail: string;
  tone: 'drift' | 'flight' | 'success' | 'warning';
}

export interface PcControlPrimerFrame {
  state: BoatState;
  racing: boolean;
  guideActive: boolean;
  keyboardActive: boolean;
  presentationBlocked: boolean;
}

const BANK_CONFIRM_S = 0.62;
const LAUNCH_CONFIRM_S = 0.48;

/**
 * Presentation-only keyboard primer. Progress comes exclusively from
 * accepted simulation state changes; it never writes controls or gameplay.
 */
export class PcControlPrimer {
  private current: PcControlPrimerStep = 'off';
  private timer = 0;
  private previousCharges = 0;
  private previousPhase: BoatState['flightPhase'] = 'surface';
  private sawBankReady = false;

  arm(eligible: boolean, state: BoatState): void {
    this.previousCharges = state.flightCharges;
    this.previousPhase = state.flightPhase;
    this.sawBankReady = state.driftReleaseReady;
    this.timer = 0;
    this.current = eligible ? 'drift' : 'off';
  }

  stop(): void {
    this.current = 'off';
    this.timer = 0;
  }

  dismiss(): void {
    if (!this.active) return;
    this.current = 'dismissed';
    this.timer = 0;
  }

  update(dt: number, frame: PcControlPrimerFrame): PcControlPrimerPresentation | null {
    const state = frame.state;
    if (!this.active) return null;

    if (frame.racing && state.driftReleaseReady) this.sawBankReady = true;
    const banked = frame.racing && state.flightCharges > this.previousCharges && this.sawBankReady;
    const launched = frame.racing && this.previousPhase === 'surface' && state.flightPhase === 'spool' &&
      state.flightCharges < this.previousCharges;

    if (launched) {
      this.current = 'success';
      this.timer = LAUNCH_CONFIRM_S;
    } else if (banked && this.current !== 'success') {
      this.current = 'banked';
      this.timer = BANK_CONFIRM_S;
      this.sawBankReady = false;
    }

    this.previousCharges = state.flightCharges;
    this.previousPhase = state.flightPhase;

    const presentationDt = frame.presentationBlocked ? 0 : Math.max(0, dt);
    if (this.current === 'banked') {
      this.timer = Math.max(0, this.timer - presentationDt);
      if (this.timer <= 0) this.current = 'waiting-launch';
    } else if (this.current === 'success') {
      this.timer = Math.max(0, this.timer - presentationDt);
      if (this.timer <= 0) {
        this.stop();
        return null;
      }
    }

    if (this.current === 'waiting-launch') {
      if (frame.guideActive && state.flightPhase === 'surface' && state.flightCharges > 0) {
        this.current = 'launch';
      } else {
        return null;
      }
    }

    if (!frame.keyboardActive || frame.presentationBlocked) return null;

    if (this.current === 'banked') return {
      step: 'banked', key: '◇ +1', kicker: '飞行库存 +1',
      title: '已存入 1 格飞行', detail: '青色入口出现时再按 SPACE', tone: 'success',
    };
    if (this.current === 'launch') return {
      step: 'launch', key: 'SPACE', kicker: '青色入口出现',
      title: '按 SPACE 起飞', detail: '消耗 1 格 ◇ · 对准两杆中间', tone: 'flight',
    };
    if (this.current === 'success') return {
      step: 'success', key: '✓', kicker: 'FLIGHT ACCEPTED',
      title: '起飞成功', detail: '沿青线穿过两杆', tone: 'success',
    };
    if (state.driftReleaseReady) {
      this.current = 'release';
      return {
        step: 'release', key: 'SHIFT', kicker: '黄线 = 已够 1 格',
        title: '现在松开 SHIFT', detail: '松开才会存入飞行库存 ◇', tone: 'drift',
      };
    }
    if (state.drifting) {
      this.current = 'charging';
      return {
        step: 'charging', key: 'SHIFT', kicker: '第一步 · 先存飞行',
        title: '按住 SHIFT 到黄线', detail: '松开后才会存入 1 格飞行 ◇', tone: 'drift',
      };
    }
    this.current = 'drift';
    return {
      step: 'drift', key: 'SHIFT', kicker: '第一步 · 先存飞行',
      title: '按住 SHIFT 漂移蓄能', detail: '船边左条到黄线就松开 · 存入 1 格 ◇', tone: 'drift',
    };
  }

  get active(): boolean {
    return this.current !== 'off' && this.current !== 'dismissed';
  }

  get step(): PcControlPrimerStep {
    return this.current;
  }
}
