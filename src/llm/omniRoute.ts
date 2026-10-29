import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env';
import { logger } from '../logger';
import { isLoopbackUrl } from './endpointPolicy';
import { GATEWAY_SUMMARY_PREFIX } from './openAiCompatible';

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

/**
 * Asks the loopback gateway for its model ids. The address and key are the ones the administrator is saving (so Load models, Test and inference all talk to the same
 * gateway with the same credential); with none given it falls back to THIS server's own (OMNIROUTE_BASE_URL / OMNIROUTE_API_KEY, or the key file on this Windows PC).
 * A typed key that is not shaped like an OmniRoute key is refused before any request. The key never leaves this function.
 */
export async function listOmniRouteModels(opts: { baseUrl?: string; apiKey?: string | null } = {}): Promise<OmniRouteModelList> {
  const baseUrl = (opts.baseUrl?.trim() || omniRouteBaseUrl()).replace(/\/+$/, '');
  if (!(await omniRouteReachable(baseUrl))) return { ok: false, baseUrl, reason: 'not_running' };
  const typed = (opts.apiKey ?? '').trim();
  if (typed && !isPlausibleOmniRouteKey(typed)) return { ok: false, baseUrl, reason: 'rejected' };
  const key = typed || await discoverLocalOmniRouteKey();
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The layered gateway check shown in Super Admin: each layer is proven separately, because a running gateway, an accepted key and a model list are NOT inference.
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type GatewayState =
  | 'unreachable' | 'invalid_key' | 'no_key' | 'no_models' | 'models_listed'
  | 'no_upstream' | 'rate_limited' | 'model_unavailable' | 'timeout' | 'inference_failed' | 'inference_ok';

export const GATEWAY_STATE_TEXT: Record<GatewayState, string> = {
  unreachable: 'The gateway is not reachable at this address (not running, wrong port, or not on this server).',
  invalid_key: 'The gateway is running but rejected this gateway key. This is the gateway key, not an upstream provider key.',
  no_key: 'The gateway is running, but no gateway key was entered and none is configured on this server.',
  no_models: 'The gateway accepted the key but lists no models.',
  models_listed: 'The gateway is reachable, the key is accepted and models are listed. Nothing has been generated yet, so this is not proof that it answers: run the check with a test request.',
  no_upstream: 'The gateway answered, but none of its upstream provider accounts did (none is connected, or each is out of quota, unavailable or needs a key). Connect or fix an upstream account inside the gateway.',
  rate_limited: 'The gateway reached an upstream, but its free quota or rate limit is used up for now. It is retried later and nothing is purchased.',
  model_unavailable: 'The gateway does not offer, or cannot serve, this model. Pick another from the list.',
  timeout: 'The gateway did not answer in time.',
  inference_failed: 'The gateway answered with an error that could not be classified more precisely.',
  inference_ok: 'Real inference succeeded: the gateway generated text through a connected upstream.',
};

export interface GatewayInferenceAttempt { reason: string; httpStatus: number | null; providerMessage: string | null }
export interface GatewayCheck {
  state: GatewayState;
  baseUrl: string;
  layers: { reachable: boolean; keyAccepted: boolean | null; modelCount: number | null; inference: 'ok' | 'failed' | 'not_run' };
  message: string;
  models?: string[];
}

/** Maps a failed inference attempt to the gateway state it means (never from the provider's own text beyond the fixed markers). */
export function gatewayStateOfAttempt(a: GatewayInferenceAttempt): GatewayState {
  const message = (a.providerMessage ?? '').toLowerCase();
  if (a.reason === 'credential' || a.httpStatus === 401 || a.httpStatus === 403) return 'invalid_key';
  if (message.startsWith(GATEWAY_SUMMARY_PREFIX)) return 'no_upstream';
  if (a.reason === 'rate_limited' || a.reason === 'payment_required' || a.httpStatus === 429) return 'rate_limited';
  if (a.reason === 'model_unavailable') return 'model_unavailable';
  if (message === 'timeout') return 'timeout';
  if (/connection refused|could not be resolved|network error|connection reset/.test(message)) return 'unreachable';
  return 'inference_failed';
}

/**
 * Proves the gateway layer by layer: reachable, key accepted (authenticated model list), models listed and, only when `infer` is given (an explicit request, never
 * automatic: it spends a little free allowance), a real generation. `infer` is supplied by the caller so this file does not depend on the router.
 */
export async function checkOmniRouteGateway(opts: { baseUrl?: string; apiKey?: string | null; infer?: () => Promise<{ ok: true } | { ok: false; attempt: GatewayInferenceAttempt }> } = {}): Promise<GatewayCheck> {
  const list = await listOmniRouteModels({ baseUrl: opts.baseUrl, apiKey: opts.apiKey });
  const baseUrl = list.baseUrl;
  const done = (state: GatewayState, layers: GatewayCheck['layers'], models?: string[]): GatewayCheck => ({ state, baseUrl, layers, message: GATEWAY_STATE_TEXT[state], ...(models ? { models: models.slice(0, 50) } : {}) });
  if (!list.ok) {
    if (list.reason === 'not_running') return done('unreachable', { reachable: false, keyAccepted: null, modelCount: null, inference: 'not_run' });
    if (list.reason === 'no_key') return done('no_key', { reachable: true, keyAccepted: null, modelCount: null, inference: 'not_run' });
    if (list.reason === 'rejected') return done('invalid_key', { reachable: true, keyAccepted: false, modelCount: null, inference: 'not_run' });
    return done('inference_failed', { reachable: true, keyAccepted: null, modelCount: null, inference: 'not_run' }); // answered, but the model list was unreadable
  }
  if (list.models.length === 0) return done('no_models', { reachable: true, keyAccepted: true, modelCount: 0, inference: 'not_run' });
  const listed = { reachable: true, keyAccepted: true, modelCount: list.models.length } as const;
  if (!opts.infer) return done('models_listed', { ...listed, inference: 'not_run' }, list.models);
  const result = await opts.infer();
  if (result.ok) return done('inference_ok', { ...listed, inference: 'ok' }, list.models);
  return done(gatewayStateOfAttempt(result.attempt), { ...listed, inference: 'failed' }, list.models);
}
