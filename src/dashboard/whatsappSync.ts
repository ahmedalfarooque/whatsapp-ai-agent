import { env } from '../config/env';
import { getEffectiveCredential } from '../config/effectiveConfig';
import { fetchWithTimeout } from '../utils/retry';
import { recordWhatsappSyncResult } from '../config/whatsappConnection';

export interface WhatsappSyncResult {
  ok: boolean;
  detail: string;
  displayPhoneNumber?: string;
  wabaName?: string;
}

function graphUrl(pathSegment: string): string {
  return `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${pathSegment}`;
}

async function graphGet(pathSegment: string, accessToken: string): Promise<{ status: number; body: unknown }> {
  const response = await fetchWithTimeout(
    graphUrl(pathSegment),
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
    env.WHATSAPP_TIMEOUT_MS,
  );
  const body = await response.json().catch(() => undefined);
  return { status: response.status, body };
}

function graphErrorMessage(body: unknown, fallback: string): string {
  const message = (body as { error?: { message?: string } } | undefined)?.error?.message;
  return message ? `${fallback}: ${message}` : fallback;
}

/**
 * Performs a REAL, bounded verification against Meta's Graph API for the
 * currently saved production WhatsApp configuration. Never calls the Test
 * WABA/number — it only ever reads the configured (production) phone number
 * ID and WABA ID. Never returns or logs the access token. Persists the
 * result (live/failed) so the dashboard can show real, restart-surviving
 * connection state rather than inferring it from environment variables.
 */
export async function syncWhatsapp(): Promise<WhatsappSyncResult> {
  const accessToken = getEffectiveCredential('WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = getEffectiveCredential('WHATSAPP_PHONE_NUMBER_ID');
  const wabaId = getEffectiveCredential('WHATSAPP_BUSINESS_ACCOUNT_ID');

  const missing = [
    !accessToken && 'Access Token',
    !phoneNumberId && 'Phone Number ID',
    !wabaId && 'WhatsApp Business Account ID',
  ].filter((v): v is string => Boolean(v));
  if (missing.length > 0) {
    const result: WhatsappSyncResult = { ok: false, detail: `Configuration incomplete — missing: ${missing.join(', ')}.` };
    recordWhatsappSyncResult(false, result.detail);
    return result;
  }

  // Step 1: the access token is accepted and the configured phone number ID
  // is reachable with it.
  let phoneInfo: { status: number; body: unknown };
  try {
    phoneInfo = await graphGet(`${phoneNumberId}?fields=display_phone_number,verified_name`, accessToken);
  } catch {
    const result: WhatsappSyncResult = { ok: false, detail: 'Could not reach the WhatsApp Graph API (network error or timeout).' };
    recordWhatsappSyncResult(false, result.detail);
    return result;
  }
  if (phoneInfo.status !== 200) {
    const result: WhatsappSyncResult = {
      ok: false,
      detail: graphErrorMessage(phoneInfo.body, `Access token or Phone Number ID rejected by Meta (HTTP ${phoneInfo.status})`),
    };
    recordWhatsappSyncResult(false, result.detail);
    return result;
  }
  const displayPhoneNumber = (phoneInfo.body as { display_phone_number?: string }).display_phone_number;

  // Step 2: the configured phone number ID actually belongs to the
  // configured production WABA (not the Test WABA, not some other account).
  let wabaPhones: { status: number; body: unknown };
  try {
    wabaPhones = await graphGet(`${wabaId}/phone_numbers?fields=id`, accessToken);
  } catch {
    const result: WhatsappSyncResult = { ok: false, detail: 'Could not reach the WhatsApp Business Account API (network error or timeout).' };
    recordWhatsappSyncResult(false, result.detail);
    return result;
  }
  if (wabaPhones.status !== 200) {
    const result: WhatsappSyncResult = {
      ok: false,
      detail: graphErrorMessage(wabaPhones.body, `WhatsApp Business Account ID rejected by Meta (HTTP ${wabaPhones.status})`),
    };
    recordWhatsappSyncResult(false, result.detail);
    return result;
  }
  const phoneIds = ((wabaPhones.body as { data?: { id?: string }[] }).data ?? []).map((p) => p.id);
  if (!phoneIds.includes(phoneNumberId)) {
    const result: WhatsappSyncResult = {
      ok: false,
      detail: 'The configured Phone Number ID does not belong to the configured WhatsApp Business Account ID.',
    };
    recordWhatsappSyncResult(false, result.detail);
    return result;
  }

  const result: WhatsappSyncResult = {
    ok: true,
    detail: `Connected to ${displayPhoneNumber ?? phoneNumberId} on WABA ${wabaId}.`,
    displayPhoneNumber,
  };
  recordWhatsappSyncResult(true, result.detail, { displayPhoneNumber });
  return result;
}
