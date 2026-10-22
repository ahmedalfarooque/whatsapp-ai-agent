import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env';
import { logger } from '../logger';
import { isLoopbackUrl } from './endpointPolicy';

/**
 * OmniRoute (npm "omniroute") is a local AI gateway: an OpenAI-compatible API at http://localhost:20128/v1 (Bearer client key), a health endpoint at
 * /api/monitoring/health and a free-only combo, `auto/best-free`. These helpers only DISCOVER it — whether it is running on this machine and, on a Windows
 * PC that has it installed, the client key it keeps DPAPI-protected for the current user. The key is returned to the caller (which encrypts it into the
 * provider store) and is never logged. Nothing here is reached with a user-supplied address: the gateway is looked for on loopback only, and a credential
 * is sent there ONLY after it passed the shape check below and only when an administrator explicitly chose the OmniRoute provider (never guessed from a name
 * or by trying an unknown key on the local port).
 */
export const OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1';

/** The gateway address: OMNIROUTE_BASE_URL when it is set (the central config only accepts a loopback address), else the default for local development. */
export function omniRouteBaseUrl(): string {
  const configured = env.OMNIROUTE_BASE_URL.trim().replace(/\/+$/, '');
  return configured || OMNIROUTE_BASE_URL;
}
export const OMNIROUTE_FREE_MODEL = 'auto/best-free';

const originOf = (baseUrl: string): string => new URL(baseUrl).origin;

/** OmniRoute client keys are plain `sk-…` tokens. Anything else (spaces, other prefixes, odd lengths, URLs) is never sent to the local gateway. */
export const isPlausibleOmniRouteKey = (key: string): boolean => /^sk-[A-Za-z0-9._-]{8,200}$/.test(key);

/** True when a healthy OmniRoute answers on the loopback address (its own health endpoint, no key needed). */
export async function omniRouteReachable(baseUrl: string = omniRouteBaseUrl(), timeoutMs = 2500): Promise<boolean> {
  if (!isLoopbackUrl(baseUrl)) return false; // never probe anything but this machine's own loopback address
  try {
    const response = await fetch(`${originOf(baseUrl)}/api/monitoring/health`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
    return body?.status === 'healthy';
  } catch {
    return false;
  }
}

/**
 * Whether a credential is accepted by the OmniRoute gateway on loopback (its authenticated model list). It is only ever called for a key the administrator
 * assigned to the OmniRoute provider explicitly, and the key is refused BEFORE any request when it is not shaped like an OmniRoute key or the address is not loopback.
 */
export async function isOmniRouteKey(key: string, baseUrl: string = omniRouteBaseUrl()): Promise<boolean> {
  if (!isPlausibleOmniRouteKey(key) || !isLoopbackUrl(baseUrl)) return false;
  if (!(await omniRouteReachable(baseUrl))) return false;
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { redirect: 'error', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    return response.ok;
  } catch {
    return false;
  }
}

// Tests switch the key-file fallback off so they never depend on, or read, the real key file of the PC they run on.
let keyFileEnabled = true;
export function setOmniRouteKeyFileEnabledForTests(enabled: boolean): void { keyFileEnabled = enabled; }

const DPAPI_READER = "$p = Join-Path $env:USERPROFILE '.omniroute\\client-api-key.dpapi'; if (-not (Test-Path -LiteralPath $p)) { exit 3 }; $s = ConvertTo-SecureString ((Get-Content -LiteralPath $p -Raw).Trim()); [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";

/** The OmniRoute client key already configured on THIS machine: OMNIROUTE_API_KEY, else (Windows) the DPAPI-protected key file of the current user. Null when there is none. */
export async function discoverLocalOmniRouteKey(): Promise<string | null> {
  const fromEnv = env.OMNIROUTE_API_KEY.trim();
  if (fromEnv) return isPlausibleOmniRouteKey(fromEnv) ? fromEnv : null;
  if (process.platform !== 'win32' || !keyFileEnabled) return null;
  if (!fs.existsSync(path.join(os.homedir(), '.omniroute', 'client-api-key.dpapi'))) return null;
  return new Promise((resolve) => {
    // A fixed script, no user input: it reads one file of the current user and prints the decrypted key to this process only.
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_READER], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      const key = String(stdout ?? '').trim();
      if (error || !key) { logger.warn({ reason: error ? 'unreadable' : 'empty' }, 'OmniRoute: the local client key could not be read'); resolve(null); return; }
      resolve(isPlausibleOmniRouteKey(key) ? key : null);
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The models the gateway offers. A LIST is not proof: OmniRoute lists every model of every connected account, and many cannot be called (a deprecated model, a missing
// credential inside the gateway, a paid-only one). So this only fills the form's suggestions; the model the administrator picks is tested with a real request when saved.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const LISTED_MODEL_ID = /^(?!.*:\/\/)[A-Za-z0-9._:/@-]{1,120}$/; // the same rule as a saved model id: an address is never a model
export const MAX_LISTED_MODELS = 500;

export type OmniRouteModelList =
  | { ok: true; baseUrl: string; models: string[]; truncated: boolean }
  | { ok: false; baseUrl: string; reason: 'not_running' | 'no_key' | 'rejected' | 'unreadable' };

/** Asks the local gateway for its model ids with THIS server's own key (OMNIROUTE_API_KEY, or the key file on this Windows PC). The key never leaves this function. */
export async function listOmniRouteModels(): Promise<OmniRouteModelList> {
  const baseUrl = omniRouteBaseUrl();
  if (!(await omniRouteReachable(baseUrl))) return { ok: false, baseUrl, reason: 'not_running' };
  const key = await discoverLocalOmniRouteKey();
  if (!key) return { ok: false, baseUrl, reason: 'no_key' };
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { redirect: 'error', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (response.status === 401 || response.status === 403) return { ok: false, baseUrl, reason: 'rejected' };
    if (!response.ok) return { ok: false, baseUrl, reason: 'unreadable' };
    const body = (await response.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    if (!body || !Array.isArray(body.data)) return { ok: false, baseUrl, reason: 'unreadable' };
    const ids = [...new Set(body.data.map((m) => (typeof m?.id === 'string' ? m.id : '')).filter((id) => LISTED_MODEL_ID.test(id)))];
    // the gateway's own combos (auto/…) first: they are what it recommends; then the rest alphabetically
    ids.sort((a, b) => Number(b.startsWith('auto/')) - Number(a.startsWith('auto/')) || a.localeCompare(b));
    return { ok: true, baseUrl, models: ids.slice(0, MAX_LISTED_MODELS), truncated: ids.length > MAX_LISTED_MODELS };
  } catch {
    return { ok: false, baseUrl, reason: 'unreadable' };
  }
}
