'use strict';
/**
 * The local AI-provider Test button.
 *
 * The local window (scripts/dev-proxy.cjs) shows PRODUCTION's data through production's own login, read-only. A provider test is not a read: production would decrypt its
 * stored key, spend its quota and record the result in its database — which is exactly what this window must never trigger. So the proxy does not forward the test and
 * does not just refuse it either: it answers it HERE, with a real, minimal inference that goes
 *   - from THIS PC, directly to the provider's own address (or to the OmniRoute gateway on this PC's loopback),
 *   - with a key that belongs to THIS PC (its .env or environment, or OmniRoute's own key on this machine) — never production's key, which production never reveals,
 *   - and writes NOTHING to production: no test record, no settings, no credentials. The result goes back to the page only.
 * The provider's identity (name, address, models, adapter) is read from production through the person's own authenticated session (so only a user production
 * would let see that page can run this), and the key comes from local sources only. A paid route is never called; a private / internal address is never called.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const PROMPT = 'Reply with the single word: ok';

/** Which local variable holds this PC's key for a vendor (the first one found is used). `AI_TEST_KEY_<VENDOR>` works for any vendor. */
const LOCAL_KEY_ENV = {
  openrouter: ['OPENROUTER_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  xai: ['XAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  omniroute: ['OMNIROUTE_API_KEY'],
};

const usableKey = (v) => typeof v === 'string' && /^[!-~]{16,200}$/.test(v) && !/["'`]/.test(v);
const plausibleOmniKey = (v) => typeof v === 'string' && /^sk-[A-Za-z0-9._-]{8,200}$/.test(v);

/** The environment of this PC: the process environment first, then this checkout's .env for anything not already set. Values are never logged. */
function loadLocalEnv(root, base = process.env) {
  const out = { ...base };
  try {
    const parsed = require('dotenv').parse(fs.readFileSync(path.join(root, '.env')));
    for (const [k, v] of Object.entries(parsed)) if (out[k] === undefined || out[k] === '') out[k] = v;
  } catch { /* no .env: only the process environment is used */ }
  return out;
}

// -------------------------------------------------------------- address policy (the same rules as src/llm/endpointPolicy.ts)
function classifyV4(host) {
  const [a, b] = host.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return 'private';
  return 'public';
}
function classifyHost(hostname) {
  let host = String(hostname).trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return classifyV4(host);
  if (host.includes(':')) return host === '::1' ? 'loopback' : /^fe[89ab]/.test(host) ? 'link_local' : /^f[cd]/.test(host) || host === '::' ? 'private' : 'public';
  if (!host.includes('.') || /\.(local|internal|lan|home|corp|intranet|localdomain)$/.test(host)) return 'private';
  return 'public';
}
/** null = the address may be called from this PC; otherwise why not. A gateway on this PC's loopback is the only place plain HTTP is accepted. */
function endpointRefusal(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { return 'the provider address is not a valid URL'; }
  if (u.username || u.password) return 'the provider address contains credentials';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'the provider address is not HTTP(S)';
  const cls = classifyHost(u.hostname);
  if (cls === 'loopback') return null;
  if (cls !== 'public') return 'the provider address is a private or internal address';
  return u.protocol === 'https:' ? null : 'the provider address is not HTTPS';
}

// -------------------------------------------------------------- OmniRoute on this PC
const DPAPI_READER = "$p = Join-Path $env:USERPROFILE '.omniroute\\client-api-key.dpapi'; if (-not (Test-Path -LiteralPath $p)) { exit 3 }; $s = ConvertTo-SecureString ((Get-Content -LiteralPath $p -Raw).Trim()); [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";

/** OmniRoute's client key on THIS Windows PC: the DPAPI-protected file of the current user (a fixed script, no input). Null when there is none. */
function discoverOmniRouteKeyFromDisk() {
  if (process.platform !== 'win32' || !fs.existsSync(path.join(os.homedir(), '.omniroute', 'client-api-key.dpapi'))) return Promise.resolve(null);
  return new Promise((resolve) => {
    cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_READER], { timeout: 10000, windowsHide: true }, (error, stdout) => {
      const key = String(stdout || '').trim();
      resolve(!error && plausibleOmniKey(key) ? key : null);
    });
  });
}

async function omniRouteHealthy(baseUrl, fetchImpl) {
  try {
    const r = await fetchImpl(`${new URL(baseUrl).origin}/api/monitoring/health`, { redirect: 'error', signal: AbortSignal.timeout(2500) });
    if (!r.ok) return false;
    const body = await r.json().catch(() => null);
    return Boolean(body) && body.status === 'healthy';
  } catch { return false; }
}

async function resolveKey(vendor, env, options) {
  const names = [...(LOCAL_KEY_ENV[vendor] || []), `AI_TEST_KEY_${String(vendor || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  for (const name of names) {
    const v = String(env[name] || '').trim();
    if (vendor === 'omniroute' ? plausibleOmniKey(v) : usableKey(v)) return v;
  }
  if (vendor === 'omniroute') return (options.discoverOmniRouteKey || discoverOmniRouteKeyFromDisk)();
  return null;
}

const noKeyMessage = (view) => {
  const names = LOCAL_KEY_ENV[view.vendor] || [`AI_TEST_KEY_${String(view.vendor || 'CUSTOM').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  return `Not tested: this PC has no ${view.name || view.vendor} key. Set ${names[0]} in this checkout's .env (a key of YOUR OWN for local testing). Production's stored key is never revealed, so it cannot be used from here, and nothing was changed on production.`;
};

// -------------------------------------------------------------- the real request
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}
function answerOf(adapter, json) {
  if (adapter === 'gemini') return ((json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || []).map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
  const message = json && json.choices && json.choices[0] && json.choices[0].message;
  return textOf(message && message.content).trim();
}
function classifyStatus(status) {
  if (status === 401 || status === 403) return { category: 'credential', why: 'the provider rejected this PC\'s key' };
  if (status === 402) return { category: 'payment_required', why: 'the provider says the credit or free allowance is used up' };
  if (status === 404) return { category: 'model_unavailable', why: 'the provider does not offer that model to this key' };
  if (status === 429) return { category: 'rate_limited', why: 'the provider is rate-limiting this key (free allowance or burst limit)' };
  if (status >= 500) return { category: 'provider_error', why: 'the provider had an error or is overloaded' };
  return { category: 'bad_request', why: 'the provider refused the request' };
}

async function callOnce(view, model, key, maxTokens, fetchImpl, timeoutMs) {
  const base = String(view.baseUrl).replace(/\/+$/, '');
  const gemini = view.adapter === 'gemini';
  const url = gemini ? `${base}/models/${encodeURIComponent(String(model).replace(/^models\//, ''))}:generateContent` : `${base}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', ...(gemini ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` }) };
  const body = gemini
    ? { contents: [{ role: 'user', parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0 } }
    : { model, messages: [{ role: 'user', content: PROMPT }], max_tokens: maxTokens, temperature: 0 };
  const response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const json = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, answer: response.ok ? answerOf(view.adapter, json) : '' };
}

/**
 * One real, minimal inference for a provider (`view` = the dashboard's provider view from production: name, vendor, adapter, baseUrl, models, freeTier — never a key).
 * Never throws; the result has the shape the Test button expects ({ ok, detail, latencyMs, category }) plus `local: true`.
 */
async function runLocalProviderTest(view, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const env = options.env || loadLocalEnv(options.root || path.resolve(__dirname, '..'));
  const started = Date.now();
  const done = (ok, detail, extra = {}) => ({ ok, detail, latencyMs: Date.now() - started, local: true, ...extra });
  const model = (view.models && view.models[0]) || (view.visionModels && view.visionModels[0]);
  if (!model) return done(false, 'No model is configured for this provider.', { category: 'model_required' });
  if (view.freeTier === false) return done(false, 'Not tested: this provider is marked as paid, and a test from the local window never spends money.', { skipped: true, category: 'paid_route' });
  const refusal = endpointRefusal(view.baseUrl);
  if (refusal) return done(false, `Not tested: ${refusal}.`, { skipped: true, category: 'endpoint' });
  if (view.vendor === 'omniroute' && !(await omniRouteHealthy(view.baseUrl, fetchImpl))) {
    return done(false, 'Not tested: OmniRoute is not running on this PC (nothing healthy answered on its loopback address). Start it with "omniroute" from its own folder, then test again.', { skipped: true, category: 'omniroute_not_running' });
  }
  const key = await resolveKey(view.vendor, env, options);
  if (!key) {
    return done(false, view.vendor === 'omniroute'
      ? 'Not tested: OmniRoute is running, but this PC has no OmniRoute client key (set OMNIROUTE_API_KEY in .env, or sign in to OmniRoute so its key file exists). No key was invented.'
      : noKeyMessage(view), { skipped: true, category: 'no_local_key' });
  }
  const timeoutMs = Math.min(Math.max(Number(view.timeoutMs) || 20000, 5000), 30000);
  try {
    let result = await callOnce(view, model, key, 64, fetchImpl, timeoutMs);
    // An EMPTY answer from a reasoning model (it spent the whole budget thinking) is retried ONCE with a larger bounded budget — never a rate limit or an error.
    if (result.ok && !result.answer) result = await callOnce(view, model, key, 256, fetchImpl, timeoutMs);
    if (result.ok && result.answer) {
      return done(true, `Model ${model} answered a real test request in ${((Date.now() - started) / 1000).toFixed(1)} s (run from this PC with this PC's own key; production was not touched).`, { category: 'ok' });
    }
    if (result.ok) return done(false, `Model ${model} returned HTTP 200 but no text, so it is not recorded as working.`, { category: 'empty_response' });
    const c = classifyStatus(result.status);
    return done(false, `${view.name || view.vendor}: HTTP ${result.status} — ${c.why}. (Local test from this PC; production was not touched.)`, { category: c.category, httpStatus: result.status });
  } catch (error) {
    const timeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return done(false, `${view.name || view.vendor}: ${timeout ? 'no answer within the time limit' : 'the provider could not be reached from this PC'}. (Local test; production was not touched.)`, { category: timeout ? 'timeout' : 'network' });
  }
}

// -------------------------------------------------------------- the routes the proxy answers locally
const TEST_ROUTES = [
  { re: /^\/api\/dashboard\/super-admin\/ai\/providers\/(\d+)\/test$/, list: '/api/dashboard/super-admin/ai' },
  { re: /^\/api\/dashboard\/ai-routing\/providers\/(\d+)\/test$/, list: '/api/dashboard/ai-routing' },
];
/** The provider-test request this is, or null: { id, list } where `list` is the production page that returns the provider's view. */
function matchProviderTest(method, pathname) {
  if (String(method).toUpperCase() !== 'POST') return null;
  for (const route of TEST_ROUTES) {
    const m = route.re.exec(pathname);
    if (m) return { id: Number(m[1]), list: route.list };
  }
  return null;
}

// -------------------------------------------------------------- "Load models" for the OmniRoute form, answered from THIS PC's gateway
const OMNI_MODELS_PATH = /^\/api\/dashboard\/ai-routing\/omniroute\/models$/;
const DEFAULT_OMNI_BASE = 'http://127.0.0.1:20128/v1';
const LISTED_MODEL_ID = /^(?!.*:\/\/)[A-Za-z0-9._:/@-]{1,120}$/; // the same rule as a saved model id: an address is never a model
const matchOmniRouteModels = (method, pathname) => String(method).toUpperCase() === 'GET' && OMNI_MODELS_PATH.test(pathname);

function omniBaseFrom(env) {
  const configured = String(env.OMNIROUTE_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!configured) return DEFAULT_OMNI_BASE;
  try { const u = new URL(configured); return ['127.0.0.1', 'localhost'].includes(u.hostname) && !u.username && !u.password ? configured : DEFAULT_OMNI_BASE; } catch { return DEFAULT_OMNI_BASE; }
}

/** Same answer as the server's own route (src/llm/omniRoute.ts listOmniRouteModels), but read from the gateway on THIS PC with this PC's key. The key is never returned. */
async function listOmniRouteModelsLocal(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const env = options.env || loadLocalEnv(options.root || path.resolve(__dirname, '..'));
  const baseUrl = omniBaseFrom(env);
  const fail = (reason) => ({ reachable: reason !== 'not_running', keyFound: reason !== 'no_key' && reason !== 'not_running', baseUrl, models: [], reason });
  if (!(await omniRouteHealthy(baseUrl, fetchImpl))) return fail('not_running');
  const key = await resolveKey('omniroute', env, options);
  if (!key) return fail('no_key');
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, { redirect: 'error', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    if (response.status === 401 || response.status === 403) return fail('rejected');
    if (!response.ok) return fail('unreadable');
    const body = await response.json().catch(() => null);
    if (!body || !Array.isArray(body.data)) return fail('unreadable');
    const ids = [...new Set(body.data.map((m) => (m && typeof m.id === 'string' ? m.id : '')).filter((id) => LISTED_MODEL_ID.test(id)))];
    ids.sort((a, b) => Number(b.startsWith('auto/')) - Number(a.startsWith('auto/')) || a.localeCompare(b));
    return { reachable: true, keyFound: true, baseUrl, models: ids.slice(0, 500), truncated: ids.length > 500 };
  } catch { return fail('unreadable'); }
}

module.exports = { runLocalProviderTest, matchProviderTest, matchOmniRouteModels, listOmniRouteModelsLocal, endpointRefusal, classifyHost, loadLocalEnv, LOCAL_KEY_ENV, TEST_ROUTES };
