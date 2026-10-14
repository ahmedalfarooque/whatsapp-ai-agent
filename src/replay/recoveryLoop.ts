import { logger } from '../logger';
import { markInterruptedAtBoot } from './pendingReplyRepo';
import { runReplaySweep, type ReplayRunner } from './replayWorker';
import { runEscalationSweep } from '../escalation/escalationService';

/**
 * Start-up recovery and the two background passes. Nothing here sends anything by itself: a replay goes through the account's live
 * WhatsApp socket only when an AI route works again and the message is still eligible; an escalation only alerts staff.
 */
export const REPLAY_SWEEP_MS = 2 * 60_000;
export const ESCALATION_SWEEP_MS = 60_000;

/** Called once at boot, before the sockets resume: messages cut short by the last shutdown become replayable (or go to staff). */
export function recoverPendingAtBoot(): { interrupted: number; replayingToStaff: number } {
  const result = markInterruptedAtBoot();
  if (result.interrupted || result.replayingToStaff) logger.warn(result, '[REPLAY] customer messages cut short by the previous shutdown were queued for a safe replay / staff');
  return result;
}

let replayTimer: NodeJS.Timeout | null = null;
let escalationTimer: NodeJS.Timeout | null = null;
let replayRunning = false;

export function startRecoveryLoops(runner: ReplayRunner): void {
  if (!replayTimer) {
    const tick = (): void => {
      if (replayRunning) return;
      replayRunning = true;
      void runReplaySweep(runner).catch((error) => logger.warn({ error: String((error as Error)?.message ?? error) }, '[REPLAY] sweep failed')).finally(() => { replayRunning = false; });
    };
    replayTimer = setInterval(tick, REPLAY_SWEEP_MS);
    replayTimer.unref();
    setTimeout(tick, 45_000).unref(); // shortly after the sockets reconnect
  }
  if (!escalationTimer) {
    const tick = (): void => { try { runEscalationSweep(); } catch (error) { logger.warn({ error: String((error as Error)?.message ?? error) }, '[ESCALATION] sweep failed'); } };
    escalationTimer = setInterval(tick, ESCALATION_SWEEP_MS);
    escalationTimer.unref();
    setTimeout(tick, 30_000).unref();
  }
}

export function stopRecoveryLoops(): void {
  if (replayTimer) clearInterval(replayTimer);
  if (escalationTimer) clearInterval(escalationTimer);
  replayTimer = null;
  escalationTimer = null;
}
