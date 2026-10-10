import { requireAccount } from '../accounts/accountRepo';
import { runWithAccount } from '../accounts/accountContext';
import { getConnection } from './qrConnection';
import { sendTextMessage } from './client';

/**
 * Sends one text typed by a staff member to a customer, through the SAME connection the business's customers talk to:
 * the account's own linked-device (QR) socket, or the Cloud API for a Meta account. It reuses the existing senders and
 * never opens a second route. Resolves with the provider's message id (or null when the transport reports none) only when the
 * transport accepted the message; any failure — account not connected, provider error — rejects, and nothing is claimed.
 */
export interface StaffSendTarget {
  wa_id: string;
  reply_jid: string | null;
}

export type StaffSender = (accountId: number, target: StaffSendTarget, text: string) => Promise<string | null>;

export const sendStaffText: StaffSender = async (accountId, target, text) => {
  const account = requireAccount(accountId);
  if (account.connectionMethod === 'qr') {
    // The address the customer last wrote from (it may be an opaque @lid); the phone JID only when nothing better is known.
    const jid = target.reply_jid || `${target.wa_id}@s.whatsapp.net`;
    return getConnection(accountId).send(jid, text);
  }
  const response = await runWithAccount(accountId, () => sendTextMessage(target.wa_id, text));
  return response.messages?.[0]?.id ?? null;
};
