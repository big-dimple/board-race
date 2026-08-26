import type { IBoat, RacerState } from '../contracts';
import type { LocalDeviceId, LocalMultiplayerInput } from '../core/localMultiplayerInput';

export type DuoInteractionAction = 'support' | 'prank';

export interface DuoInteractionEvent {
  actorId: number;
  targetId: number;
  action: DuoInteractionAction;
  accepted: boolean;
  chargesLeft: number;
}

export interface DuoInteractionStatus {
  available: boolean;
  cooldown: number;
  charges: number;
  actorId: number;
}

const MAX_CHARGES = 3;
const COOLDOWN_S = 4.2;
const SUPPORT_IMPULSE = 3.6;
const PRANK_IMPULSE = 2.4;

/**
 * A small, deterministic post-elimination role. It never writes to BoatInput:
 * the eliminated player's device emits a separate edge and applies one
 * bounded physics response to the surviving human boat.
 */
export class DuoInteractionController {
  private readonly cooldown = [0, 0];
  private readonly charges = [MAX_CHARGES, MAX_CHARGES];
  private readonly counts = { support: 0, prank: 0 };
  private readonly status: DuoInteractionStatus[] = [
    { available: false, cooldown: 0, charges: MAX_CHARGES, actorId: 0 },
    { available: false, cooldown: 0, charges: MAX_CHARGES, actorId: 1 },
  ];

  reset(): void {
    this.cooldown[0] = 0;
    this.cooldown[1] = 0;
    this.charges[0] = MAX_CHARGES;
    this.charges[1] = MAX_CHARGES;
    this.counts.support = 0;
    this.counts.prank = 0;
    for (let i = 0; i < 2; i++) this.syncStatus(i, false);
  }

  update(
    dt: number,
    racers: readonly RacerState[],
    boats: readonly IBoat[],
    devices: readonly [LocalDeviceId, LocalDeviceId],
    input: LocalMultiplayerInput,
    emit: (event: DuoInteractionEvent) => void,
  ): void {
    for (let actor = 0; actor < 2; actor++) {
      this.cooldown[actor] = Math.max(0, this.cooldown[actor] - dt);
      const actorState = racers[actor];
      const target = actor === 0 ? 1 : 0;
      const targetState = racers[target];
      const available = Boolean(actorState?.eliminated && targetState && !targetState.eliminated && !targetState.finished);
      this.syncStatus(actor, available);
      if (!available || this.cooldown[actor] > 0 || this.charges[actor] <= 0) continue;
      const edges = input.interactionEdges(devices[actor]);
      if (!edges.support && !edges.prank) continue;
      const action: DuoInteractionAction = edges.support ? 'support' : 'prank';
      const targetBoat = boats[target];
      let accepted = false;
      if (action === 'support') {
        accepted = targetBoat.grantFlightCharge();
        if (!accepted) {
          // A full charge bank still receives a readable forward nudge rather
          // than wasting the helper's turn.
          const heading = targetBoat.state.heading;
          targetBoat.applyCollisionResponse(0, 0, Math.sin(heading) * SUPPORT_IMPULSE, Math.cos(heading) * SUPPORT_IMPULSE);
          accepted = true;
        }
        this.counts.support++;
      } else {
        const heading = targetBoat.state.heading;
        // The prank is a playful side splash, never a teleport or a hard stop.
        targetBoat.applyCollisionResponse(
          Math.cos(heading) * PRANK_IMPULSE * 0.08,
          -Math.sin(heading) * PRANK_IMPULSE * 0.08,
          Math.cos(heading) * PRANK_IMPULSE,
          -Math.sin(heading) * PRANK_IMPULSE,
        );
        accepted = true;
        this.counts.prank++;
      }
      if (!accepted) continue;
      this.charges[actor]--;
      this.cooldown[actor] = COOLDOWN_S;
      this.syncStatus(actor, true);
      emit({ actorId: actor, targetId: target, action, accepted, chargesLeft: this.charges[actor] });
    }
  }

  snapshot(): { statuses: readonly DuoInteractionStatus[]; support: number; prank: number } {
    return {
      statuses: this.status.map((item) => ({ ...item })),
      support: this.counts.support,
      prank: this.counts.prank,
    };
  }

  private syncStatus(actor: number, available: boolean): void {
    // Match the public readiness flag to the same cooldown gate used by the
    // simulation; an edge during cooldown is intentionally ignored.
    this.status[actor].available = available && this.cooldown[actor] <= 0 && this.charges[actor] > 0;
    this.status[actor].cooldown = this.cooldown[actor];
    this.status[actor].charges = this.charges[actor];
  }
}
