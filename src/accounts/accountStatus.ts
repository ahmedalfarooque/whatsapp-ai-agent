import type { WhatsappAccount } from './accountRepo';

export type AccountUiStatus = 'connected' | 'connecting' | 'qr_required' | 'disconnected' | 'disabled' | 'error';

/** Coarse state shown in the sidebar and on the dashboard. `phase` is the live connection phase, else the last stored status. */
export function accountUiStatus(account: Pick<WhatsappAccount, 'enabled'>, phase: string): AccountUiStatus {
  if (!account.enabled) return 'disabled';
  if (phase === 'connected') return 'connected';
  if (['starting', 'connecting', 'reconnecting'].includes(phase)) return 'connecting';
  if (['scan', 'qr_expired', 'idle', 'logged_out'].includes(phase)) return 'qr_required';
  if (phase === 'error') return 'error';
  return 'disconnected';
}
