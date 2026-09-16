import { getDb } from '../memory/db';

export type WhatsappSyncStatus = 'not_configured' | 'saved' | 'live' | 'failed';

export interface WhatsappConnectionState {
  webhookUrl: string | null;
  syncStatus: WhatsappSyncStatus;
  lastSyncAt: string | null;
  lastSyncDetail: string | null;
  displayPhoneNumber: string | null;
  wabaName: string | null;
}

interface WhatsappConnectionRow {
  webhook_url: string | null;
  sync_status: string;
  last_sync_at: string | null;
  last_sync_detail: string | null;
  display_phone_number: string | null;
  waba_name: string | null;
}

function readRow(): WhatsappConnectionRow {
  const row = getDb()
    .prepare(
      `SELECT webhook_url, sync_status, last_sync_at, last_sync_detail, display_phone_number, waba_name
       FROM whatsapp_connection WHERE id = 1`,
    )
    .get() as WhatsappConnectionRow | undefined;
  if (!row) throw new Error('whatsapp_connection row (id=1) is missing — migrations did not run correctly');
  return row;
}

export function getWhatsappConnectionState(): WhatsappConnectionState {
  const row = readRow();
  return {
    webhookUrl: row.webhook_url,
    syncStatus: (row.sync_status as WhatsappSyncStatus) ?? 'not_configured',
    lastSyncAt: row.last_sync_at,
    lastSyncDetail: row.last_sync_detail,
    displayPhoneNumber: row.display_phone_number,
    wabaName: row.waba_name,
  };
}

/**
 * Called after Save Configuration succeeds (all required WhatsApp fields
 * present and persisted). Always moves status to 'saved' — even if it was
 * previously 'live' — because the credentials just changed and a fresh Sync
 * is required to re-confirm the connection. This is the "SAVE ≠ LIVE" rule.
 */
export function markWhatsappConfigurationSaved(webhookUrl: string): void {
  getDb()
    .prepare(
      `UPDATE whatsapp_connection
       SET webhook_url = @webhookUrl, sync_status = 'saved', updated_at = datetime('now')
       WHERE id = 1`,
    )
    .run({ webhookUrl });
}

/** Records the outcome of an explicit Sync WhatsApp verification. Never receives a token. */
export function recordWhatsappSyncResult(
  ok: boolean,
  detail: string,
  info?: { displayPhoneNumber?: string; wabaName?: string },
): void {
  getDb()
    .prepare(
      `UPDATE whatsapp_connection
       SET sync_status = @status,
           last_sync_at = datetime('now'),
           last_sync_detail = @detail,
           display_phone_number = COALESCE(@displayPhoneNumber, display_phone_number),
           waba_name = COALESCE(@wabaName, waba_name),
           updated_at = datetime('now')
       WHERE id = 1`,
    )
    .run({
      status: ok ? 'live' : 'failed',
      detail,
      displayPhoneNumber: info?.displayPhoneNumber ?? null,
      wabaName: info?.wabaName ?? null,
    });
}
