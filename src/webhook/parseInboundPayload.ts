import type { WhatsAppWebhookBody } from '../whatsapp/types';

export interface InboundMessage {
  waId: string;
  messageId: string;
  timestamp: number;
  type: string;
  text?: string;
  contactName?: string;
  /** Stable internal ID from a button/list tap (interactive messages only). */
  interactiveId?: string;
  /** Transport the message arrived on: 'cloud' (Meta webhook, default) or 'qr' (linked device). */
  channel?: string;
}

/**
 * Flattens Meta's nested webhook payload (object -> entry[] -> changes[] ->
 * value.messages[]) into a normalized, easy-to-process list. Non-message
 * changes (e.g. status updates) and unsupported message types are safely
 * ignored rather than throwing.
 */
export function parseInboundPayload(body: unknown): InboundMessage[] {
  const results: InboundMessage[] = [];
  const payload = body as WhatsAppWebhookBody;

  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    return results;
  }

  for (const entry of payload.entry) {
    if (!Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      const value = change.value;
      if (!value || !Array.isArray(value.messages)) continue;

      const contactsByWaId = new Map(
        (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]),
      );

      for (const message of value.messages) {
        const interactiveReply = message.type === 'interactive' ? message.interactive : undefined;
        const interactiveId =
          interactiveReply?.type === 'button_reply'
            ? interactiveReply.button_reply?.id
            : interactiveReply?.type === 'list_reply'
              ? interactiveReply.list_reply?.id
              : undefined;

        results.push({
          waId: message.from,
          messageId: message.id,
          timestamp: Number(message.timestamp) * 1000,
          type: message.type,
          text: message.type === 'text' ? message.text?.body : undefined,
          contactName: contactsByWaId.get(message.from),
          interactiveId,
        });
      }
    }
  }

  return results;
}
