export interface WhatsAppInteractiveReply {
  type: 'button_reply' | 'list_reply';
  button_reply?: { id: string; title: string };
  list_reply?: { id: string; title: string; description?: string };
}

export interface WhatsAppTextMessagePayload {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: WhatsAppInteractiveReply;
  [key: string]: unknown;
}

export interface WhatsAppContact {
  profile?: { name?: string };
  wa_id: string;
}

export interface WhatsAppWebhookValue {
  messaging_product: 'whatsapp';
  metadata?: { display_phone_number: string; phone_number_id: string };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppTextMessagePayload[];
  statuses?: unknown[];
}

export interface WhatsAppWebhookChange {
  value: WhatsAppWebhookValue;
  field: string;
}

export interface WhatsAppWebhookEntry {
  id: string;
  changes: WhatsAppWebhookChange[];
}

export interface WhatsAppWebhookBody {
  object: string;
  entry?: WhatsAppWebhookEntry[];
}

export interface SendTextMessageResponse {
  messaging_product: 'whatsapp';
  contacts: { input: string; wa_id: string }[];
  messages: { id: string }[];
}

export interface InteractiveButton {
  /** Stable internal ID (never shown to the customer) used to route the button_reply. */
  id: string;
  /** Visible label — WhatsApp caps button titles at 20 characters. */
  title: string;
}

export interface InteractiveListRow {
  id: string;
  title: string;
  description?: string;
}

export interface InteractiveListSection {
  title?: string;
  rows: InteractiveListRow[];
}

export type OutboundInteractiveMessage =
  | { kind: 'buttons'; body: string; buttons: InteractiveButton[]; header?: string; footer?: string }
  | {
      kind: 'list';
      body: string;
      buttonLabel: string;
      sections: InteractiveListSection[];
      header?: string;
      footer?: string;
    };

/** A file sent to a customer (the catalogue PDFs): the bytes, the name WhatsApp shows, and an optional caption. */
export interface OutboundDocument {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  caption?: string;
}
