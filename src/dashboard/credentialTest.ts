import { google } from 'googleapis';
import { env } from '../config/env';
import { getEffectiveCredential } from '../config/effectiveConfig';
import { fetchWithTimeout } from '../utils/retry';
import type { OverridableKey } from '../config/secretStore';

export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
}

/**
 * Runs a real, bounded connectivity check for one integration using its
 * EFFECTIVE credential (dashboard override if set, else .env). Never
 * returns the credential itself — only a short, provider-error-summarized
 * status string. This is the only place a "Connected" status may be shown
 * from — the dashboard must never claim a connection without one of these
 * actually succeeding.
 */
export async function testConnection(key: OverridableKey): Promise<ConnectionTestResult> {
  switch (key) {
    case 'WHATSAPP_ACCESS_TOKEN':
    case 'WHATSAPP_PHONE_NUMBER_ID':
      return testWhatsApp();
    case 'OPENROUTER_API_KEY':
      return testOpenRouter();
    case 'GOOGLE_CLIENT_EMAIL':
    case 'GOOGLE_PRIVATE_KEY':
      return testGoogleCalendar();
    case 'WHATSAPP_VERIFY_TOKEN':
    case 'META_APP_SECRET':
      // These secure the inbound webhook itself, not an outbound API call —
      // there is no external "connection" to test for them.
      return { ok: false, detail: 'This credential secures inbound webhook requests; there is no outbound connection to test.' };
    default:
      return { ok: false, detail: 'Unknown credential key.' };
  }
}

async function testWhatsApp(): Promise<ConnectionTestResult> {
  const phoneNumberId = getEffectiveCredential('WHATSAPP_PHONE_NUMBER_ID');
  const accessToken = getEffectiveCredential('WHATSAPP_ACCESS_TOKEN');
  if (!phoneNumberId || !accessToken) {
    return { ok: false, detail: 'WhatsApp access token and/or phone number ID are not configured.' };
  }
  try {
    const response = await fetchWithTimeout(
      `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name`,
      { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
      env.WHATSAPP_TIMEOUT_MS,
    );
    if (!response.ok) {
      return { ok: false, detail: `WhatsApp API responded with HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { display_phone_number?: string; verified_name?: string };
    return {
      ok: true,
      detail: `Connected to ${body.verified_name ?? 'WhatsApp number'} (${body.display_phone_number ?? phoneNumberId}).`,
    };
  } catch {
    return { ok: false, detail: 'Could not reach the WhatsApp Graph API (network error or timeout).' };
  }
}

async function testOpenRouter(): Promise<ConnectionTestResult> {
  const apiKey = getEffectiveCredential('OPENROUTER_API_KEY');
  if (!apiKey) {
    return { ok: false, detail: 'OpenRouter API key is not configured.' };
  }
  try {
    // /models is public and returns 200 for any (or no) bearer token — it
    // does NOT validate the key. /auth/key requires a genuinely valid key
    // and 401s otherwise, so it's the only endpoint that actually confirms
    // the credential works rather than merely reachability.
    const response = await fetchWithTimeout(
      'https://openrouter.ai/api/v1/auth/key',
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      env.OPENROUTER_TIMEOUT_MS,
    );
    if (!response.ok) {
      return { ok: false, detail: `OpenRouter API responded with HTTP ${response.status}.` };
    }
    return { ok: true, detail: 'OpenRouter API key is valid.' };
  } catch {
    return { ok: false, detail: 'Could not reach OpenRouter (network error or timeout).' };
  }
}

async function testGoogleCalendar(): Promise<ConnectionTestResult> {
  const clientEmail = getEffectiveCredential('GOOGLE_CLIENT_EMAIL');
  const privateKey = getEffectiveCredential('GOOGLE_PRIVATE_KEY');
  if (!clientEmail || !privateKey) {
    return { ok: false, detail: 'Google service account email and/or private key are not configured.' };
  }
  try {
    const auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    const calendar = google.calendar({ version: 'v3', auth });
    const result = await calendar.calendars.get({ calendarId: env.GOOGLE_CALENDAR_ID });
    return { ok: true, detail: `Connected to calendar "${result.data.summary ?? env.GOOGLE_CALENDAR_ID}".` };
  } catch (error) {
    const status = (error as { code?: number; response?: { status?: number } })?.response?.status ??
      (error as { code?: number })?.code;
    return {
      ok: false,
      detail: status
        ? `Google Calendar API responded with HTTP ${status}. Check the service account has access to calendar "${env.GOOGLE_CALENDAR_ID}".`
        : 'Could not reach the Google Calendar API (network error or timeout).',
    };
  }
}
