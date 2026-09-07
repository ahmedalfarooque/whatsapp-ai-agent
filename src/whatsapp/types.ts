export interface WhatsAppTextMessagePayload {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
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
