#!/usr/bin/env node
/**
 * Local dashboard on PRODUCTION DATA — one source of truth, no copies.
 *
 *   npm run dev                      <- the supported command (scripts/dev.cjs runs this server in-process on the first free port of 3000, 3100, 3200, ...)
 *   node scripts/dev-proxy.cjs [--port 3100] [--write-business-data] [--check]   <- the bare server, one fixed port, no port selection, no browser
 *   then open  http://localhost:<port>/dashboard  (redirected to http://workspace.localhost:<port>/dashboard) and sign in with your normal production account.
 *
 * What it is: a tiny local web server. It serves the dashboard (HTML/CSS/JS) from THIS checkout, so you see your local, uncommitted UI work immediately,
 * and it forwards every data request (/api/dashboard/...) to production's own authenticated backend over HTTPS. The accounts, company information,
 * customers, configuration and live WhatsApp connection status you see are production's records, read through production's own login, permissions and
 * account isolation. Nothing is copied to this machine, there is no local database and no local WhatsApp session in this mode.
 *
 * What it will NOT do (enforced here, in decide()):
 *   - start, pair, show a QR for, enable, disable, create or delete a WhatsApp account or session;
 *   - send a WhatsApp message (replies, take-over, quotation send, notification flush/retry);
 *   - change users, passwords, credentials, API keys, AI keys or system settings;
 *   - write anything at all, unless you start it with --write-business-data, and then ONLY the business-content operations in BUSINESS_WRITES.
 * Production remains the sole owner of live WhatsApp sessions and of every record; this machine is just another window onto it.
 *
 * Safety properties: listens on 127.0.0.1 only; serves only the Host `workspace.localhost:<port>` (the session cookie is therefore scoped to that name and is
 * never sent to any other local web app, nor to http://localhost:<other port>; localhost/127.0.0.1 on the same port are redirected there, every other host gets
 * 421 and nothing else); the upstream is fixed to production (an override is allowed only for a
 * loopback test server); same-origin check on writes; no request/response body is ever logged, only "METHOD path status" for writes.
 */
'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const localAiTest = require('./local-ai-test.cjs');

const ROOT = path.resolve(__dirname, '..');
const DASHBOARD_DIR = path.join(ROOT, 'dashboard');
const PRODUCTION_UPSTREAM = 'https://whatsapp.alfarooque.com';
const COOKIE_HOST = 'workspace.localhost';

// ------------------------------------------------------------------ policy (pure, unit-tested)

const AUTH_OK = /^\/api\/dashboard\/auth\/(login|logout|otp\/verify|otp\/resend|otp\/cancel)$/;
// READ paths that must never be reachable from this window: pairing QR codes (pairing belongs to production), credentials and webhook secrets.
const READ_DENY = [/^\/api\/dashboard\/accounts\/\d+\/qr\b/, /^\/api\/dashboard\/whatsapp\/qr\b/, /^\/api\/dashboard\/credentials\b/, /^\/api\/dashboard\/webhook-info\b/];

/** The ONLY writes --write-business-data allows: editing business content. Everything else (connections, sending, users, credentials, settings) is refused. */
const BUSINESS_WRITES = [
  ['PUT', /^\/api\/dashboard\/business-profile$/],
  ['POST|PATCH|PUT|DELETE', /^\/api\/dashboard\/documents(\/\d+(\/file)?)?$/],
  ['POST|PUT|DELETE', /^\/api\/dashboard\/offers(\/\d+(\/[a-z-]+)?)?$/],
  ['POST', /^\/api\/dashboard\/templates\/[^/]+\/(preview|draft|publish|discard-draft|reset)$/],
  ['PATCH', /^\/api\/dashboard\/automation$/],
  ['PUT', /^\/api\/dashboard\/knowledge\/[^/]+$/],
  ['POST|PUT|PATCH|DELETE', /^\/api\/dashboard\/accounts\/\d+\/setup(\/|$)/],
  ['POST|PUT|PATCH|DELETE', /^\/api\/dashboard\/accounts\/\d+\/catalogues(\/|$)/],
  ['POST', /^\/api\/dashboard\/customers\/(files\/\d+\/(assign|extract)|\d+\/(profile|notes|notes\/\d+\/done|pause|resume))$/],
  // quotations: everything except /send (which messages the customer) and the request status change (which can notify them)
  ['POST', /^\/api\/dashboard\/requests\/\d+\/quotation\/(draft|approve|reject|mark-sent|attachment|versions\/\d+\/finalize)$/],
  ['POST', /^\/api\/dashboard\/bookings\/\d+\/reconcile$/],
  ['POST|PUT|PATCH', /^\/api\/dashboard\/realestate\/(leads\/\d+|projects(\/\d+(\/archive)?)?)$/],
];

/** Writes that exist only on production, with the sentence the person is shown instead of a bare "blocked". */
const PRODUCTION_ONLY_HINTS = [
  [/^\/api\/dashboard\/(super-admin\/ai|ai-routing)\/(providers|adopt-openrouter|entries|settings)/, "AI provider settings, keys and order are saved on production only (use the production dashboard). The Test button on this window does work: it runs on this PC with this PC's own key and writes nothing to production"],
];
const productionOnlyHint = (pathname) => (PRODUCTION_ONLY_HINTS.find(([re]) => re.test(pathname)) || [])[1];

function safePath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  return !(/[\0\\]/.test(decoded) || decoded.split('/').some((s) => s === '..' || s === '.') || decoded.includes('//'));
}

/**
 * Decides whether this window may forward a request to production.
 * mode: 'read-only' (default) or 'business-data' (--write-business-data).
 */
function decide(method, pathname, mode = 'read-only') {
  const m = String(method).toUpperCase();
  if (!safePath(pathname)) return { allow: false, reason: 'malformed path' };
  const isApi = pathname.startsWith('/api/dashboard/') || pathname === '/health' || pathname === '/readiness';
  if (!isApi) return { allow: false, reason: 'not an API path' };
  // The OmniRoute "Load models" list is read from THIS PC's gateway (not production's), so it is answered locally.
  if (localAiTest.matchOmniRouteModels(m, pathname)) return { allow: false, local: 'omniroute-models', reason: "the OmniRoute model list of this PC is read locally, not from production" };
  if (m === 'GET' || m === 'HEAD') {
    if (READ_DENY.some((re) => re.test(pathname))) return { allow: false, reason: 'WhatsApp pairing, credentials and webhook secrets are never exposed through this local window' };
    return { allow: true, reason: 'read' };
  }
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) return { allow: false, reason: `method ${m} is not supported` };
  if (m === 'POST' && AUTH_OK.test(pathname)) return { allow: true, reason: 'sign-in / sign-out of your own session' };
  // An AI provider TEST is not forwarded (production would decrypt its own key, spend its quota and record the result): the server answers it locally, from this PC, in EVERY mode.
  if (localAiTest.matchProviderTest(m, pathname)) return { allow: false, local: 'ai-provider-test', reason: "AI provider tests are not sent to production: they run on this PC with this PC's own key" };
  const hint = productionOnlyHint(pathname);
  if (mode !== 'business-data') return { allow: false, reason: hint || 'this local window is read-only (restart with --write-business-data to edit business content)' };
  const hit = BUSINESS_WRITES.some(([methods, re]) => methods.split('|').includes(m) && re.test(pathname));
  return hit ? { allow: true, reason: 'business content' } : { allow: false, reason: hint || 'this operation connects WhatsApp, sends a message or changes users, credentials or settings: it must be done on production itself' };
}

/** Only production, or a loopback test server, may be the upstream. */
function isAllowedUpstream(value) {
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.origin === PRODUCTION_UPSTREAM) return u.pathname === '/' && !u.search;
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) && Boolean(u.port) && u.pathname === '/';
}

/** The session cookie belongs to production's origin; here it is re-issued for workspace.localhost only (no Secure, no Domain, same other attributes). */
function rewriteSetCookie(value) {
  return String(value).split(';').map((p) => p.trim()).filter((p) => p && !/^secure$/i.test(p) && !/^domain=/i.test(p)).join('; ');
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function git(args) {
  try { return cp.execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function buildInfo(opts) {
  return {
    commit: git(['rev-parse', '--short', 'HEAD']) || 'unknown',
    fullCommit: git(['rev-parse', 'HEAD']) || null,
    branch: git(['branch', '--show-current']) || null,
    uncommittedChanges: git(['status', '--porcelain', '--untracked-files=no']).split('\n').filter((l) => l && !l.includes('.project-sync/')).length,
    environment: 'local-ui',
    root: ROOT, // which checkout serves this window (loopback-only information; lets `npm run dev` recognise and reuse its own window)
    dataSource: 'production',
    dataSourceHost: new URL(opts.upstream).host,
    mode: opts.mode,
    generatedAt: new Date().toISOString(),
  };
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(text);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/dashboard' || pathname === '/dashboard/' ? 'index.html' : pathname.replace(/^\/dashboard\//, '');
  const file = path.resolve(DASHBOARD_DIR, rel);
  if (!file.startsWith(DASHBOARD_DIR + path.sep) || !safePath(pathname)) { sendJson(res, 400, { error: 'bad_path' }); return; }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { sendJson(res, 404, { error: 'not_found' }); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  });
}

function createProxyServer(options = {}) {
  const upstream = options.upstream || PRODUCTION_UPSTREAM;
  if (!isAllowedUpstream(upstream)) throw new Error(`refusing upstream ${upstream}: only ${PRODUCTION_UPSTREAM} (or a loopback test server) is allowed`);
  const mode = options.mode === 'business-data' ? 'business-data' : 'read-only';
  const upstreamUrl = new URL(upstream);
  const client = upstreamUrl.protocol === 'https:' ? https : http;
  const log = options.log || (() => {});
  const state = { port: options.port || 3100 };
  const runLocalTest = options.runLocalTest || ((view) => localAiTest.runLocalProviderTest(view, { root: ROOT }));
  const listLocalModels = options.listLocalModels || (() => localAiTest.listOmniRouteModelsLocal({ root: ROOT }));

  /** GET one dashboard page from production with the person's own session (cookie + selected business); the provider's view is read from it. Never a write. */
  function fetchUpstreamJson(listPath, req) {
    return new Promise((resolve, reject) => {
      const headers = { accept: 'application/json', host: upstreamUrl.host };
      for (const name of ['cookie', 'x-whatsapp-account']) if (req.headers[name]) headers[name] = req.headers[name];
      const up = client.request({ protocol: upstreamUrl.protocol, hostname: upstreamUrl.hostname, port: upstreamUrl.port || undefined, method: 'GET', path: listPath, headers, timeout: 20000 }, (r) => {
        const chunks = [];
        let size = 0;
        r.on('data', (c) => { size += c.length; if (size > 2000000) up.destroy(new Error('response too large')); else chunks.push(c); });
        r.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
          resolve({ status: r.statusCode || 502, json });
        });
      });
      up.on('timeout', () => up.destroy(new Error('upstream timeout')));
      up.on('error', reject);
      up.end();
    });
  }

  /** GET /ai-routing/omniroute/models from this PC's gateway. Needs a signed-in production session with the same permission the real route needs (read from production, nothing written). */
  async function handleLocalOmniModels(req, res) {
    try {
      const probe = await fetchUpstreamJson('/api/dashboard/ai-routing', req);
      if (probe.status !== 200) { sendJson(res, probe.status === 200 ? 502 : probe.status, probe.json && typeof probe.json === 'object' ? probe.json : { error: 'upstream_error', message: 'Production did not confirm the session, so nothing was listed.' }); return; }
      sendJson(res, 200, await listLocalModels());
    } catch (error) {
      if (!res.headersSent) sendJson(res, 502, { error: 'local_models_failed', message: `The model list could not be read (${error && error.message ? error.message : 'unknown error'}); nothing was changed.` });
    }
  }

  async function handleLocalProviderTest(req, res, pathname, expectedHost) {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if ((origin && origin.toLowerCase() !== `http://${expectedHost}`) || (site && !['same-origin', 'none'].includes(site))) { sendJson(res, 403, { error: 'cross_origin_blocked', message: 'Cross-origin write refused.' }); return; }
    req.resume(); // the request body is not used
    const match = localAiTest.matchProviderTest(req.method, pathname);
    try {
      const listed = await fetchUpstreamJson(match.list, req); // production's own permission check decides who may even see this provider
      if (listed.status !== 200 || !listed.json || typeof listed.json !== 'object') {
        sendJson(res, listed.status === 200 ? 502 : listed.status, listed.json && typeof listed.json === 'object' ? listed.json : { error: 'upstream_error', message: 'Production did not return the provider list, so nothing was tested.' });
        return;
      }
      const view = (Array.isArray(listed.json.providers) ? listed.json.providers : []).find((p) => p && p.id === match.id);
      if (!view) { sendJson(res, 404, { error: 'not_found' }); return; }
      const result = await runLocalTest(view);
      log(`LOCAL AI TEST ${pathname} -> ${result.ok ? 'ok' : result.category || 'failed'} (nothing sent to production)`);
      sendJson(res, 200, { ...result, provider: view });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 502, { error: 'local_test_failed', message: `The local test could not run (${error && error.message ? error.message : 'unknown error'}); nothing was changed.` });
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://local');
    const pathname = url.pathname;
    const expectedHost = `${COOKIE_HOST}:${state.port}`;
    const host = (req.headers.host || '').toLowerCase();
    // DNS-rebinding / cookie-scope guard: only workspace.localhost:<port>. The plain loopback names on the SAME port (what `npm run dev` prints and
    // what a person types) are sent there with a redirect, so no hosts-file entry and no knowledge of the private name is needed; anything else is told
    // where to go and gets nothing.
    if (host !== expectedHost) {
      if (['GET', 'HEAD'].includes(req.method) && [`localhost:${state.port}`, `127.0.0.1:${state.port}`, `[::1]:${state.port}`].includes(host)) {
        res.writeHead(302, { Location: `http://${expectedHost}${pathname === '/' ? '/dashboard' : pathname}${url.search}`, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Open http://${expectedHost}/dashboard (this window only answers on that address, so your sign-in cookie stays private to it).\n`);
      return;
    }
    if (pathname === '/') { res.writeHead(302, { Location: '/dashboard' }); res.end(); return; }
    if (pathname === '/dashboard/build-info.json') { sendJson(res, 200, buildInfo({ upstream, mode })); return; }
    if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
      if (!['GET', 'HEAD'].includes(req.method)) { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
      serveStatic(req, res, pathname); return;
    }

    const verdict = decide(req.method, pathname, mode);
    if (verdict.local === 'omniroute-models') { void handleLocalOmniModels(req, res); return; }
    if (verdict.local === 'ai-provider-test') { void handleLocalProviderTest(req, res, pathname, expectedHost); return; }
    if (!verdict.allow) {
      if (req.method !== 'GET') log(`BLOCKED ${req.method} ${pathname} - ${verdict.reason}`);
      sendJson(res, 403, { error: 'blocked_by_local_window', message: `Blocked on this local window: ${verdict.reason}.` });
      return;
    }
    const writing = !['GET', 'HEAD'].includes(req.method);
    if (writing) {
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if ((origin && origin.toLowerCase() !== `http://${expectedHost}`) || (site && !['same-origin', 'none'].includes(site))) {
        sendJson(res, 403, { error: 'cross_origin_blocked', message: 'Cross-origin write refused.' }); return;
      }
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !['origin', 'referer', 'x-http-method-override', 'x-forwarded-for', 'x-forwarded-host'].includes(k)) headers[k] = v;
    headers.host = upstreamUrl.host;
    if (writing) { headers.origin = upstreamUrl.origin; headers.referer = `${upstreamUrl.origin}/dashboard`; }
    if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
    const up = client.request({ protocol: upstreamUrl.protocol, hostname: upstreamUrl.hostname, port: upstreamUrl.port || undefined, method: req.method, path: url.pathname + url.search, headers, timeout: 30000 }, (upRes) => {
      const out = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (HOP.has(k) || ['content-security-policy', 'strict-transport-security'].includes(k)) continue;
        out[k] = k === 'set-cookie' ? upRes.headers['set-cookie'].map(rewriteSetCookie) : v;
      }
      out['cache-control'] = 'no-store';
      out['x-content-type-options'] = 'nosniff';
      out['x-served-by'] = `local window -> ${upstreamUrl.host}`;
      res.writeHead(upRes.statusCode || 502, out);
      upRes.pipe(res);
      if (writing) log(`${req.method} ${pathname} -> ${upRes.statusCode}`);
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', (error) => { if (!res.headersSent) sendJson(res, 502, { error: 'upstream_unreachable', message: `Production could not be reached (${error.message}).` }); else res.destroy(); });
    req.pipe(up);
  });
  server.proxyState = state;
  server.proxyMode = mode;
  return server;
}

// ------------------------------------------------------------------ CLI

function main() {
  const argv = process.argv.slice(2);
  const known = new Set(['--port', '--write-business-data', '--check', '--upstream']);
  for (const a of argv) if (a.startsWith('--') && !known.has(a)) { console.error(`unknown option ${a}`); process.exit(2); }
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const port = Number.parseInt(get('--port') || '3100', 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3005) { console.error('--port must be 1024-65535 and never 3005 (another project)'); process.exit(2); }
  const upstream = get('--upstream') || PRODUCTION_UPSTREAM;
  const mode = argv.includes('--write-business-data') ? 'business-data' : 'read-only';
  const server = createProxyServer({ upstream, mode, port, log: (m) => console.log(`[${new Date().toISOString()}] ${m}`) });
  if (argv.includes('--check')) {
    const info = buildInfo({ upstream, mode });
    console.log(`local UI commit ${info.commit} on ${info.branch} (${info.uncommittedChanges} uncommitted changes); data source ${upstream}; mode ${mode}`);
    const probe = (upstream.startsWith('https') ? https : http).get(`${upstream}/health`, { timeout: 15000 }, (r) => { console.log(`production /health -> HTTP ${r.statusCode}`); r.resume(); });
    probe.on('error', (e) => { console.log(`production unreachable: ${e.message}`); process.exitCode = 1; });
    return;
  }
  server.listen(port, '127.0.0.1', () => {
    console.log(`Local dashboard on production data: http://${COOKIE_HOST}:${port}/dashboard`);
    console.log(`  UI from this checkout (${buildInfo({ upstream, mode }).commit}); data from ${upstream}; mode: ${mode}`);
    console.log(mode === 'read-only' ? '  Read-only: nothing can be changed from here. Use --write-business-data to edit business content.' : '  WRITE MODE: business-content edits go to PRODUCTION immediately. WhatsApp connections and sending stay blocked.');
    console.log("  AI provider Test buttons run on THIS PC with this PC's own keys (see .env.example: OPENROUTER_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, OMNIROUTE_API_KEY); nothing is sent to production.");
    console.log('  Press Ctrl+C to stop.');
  });
}

if (require.main === module) main();

module.exports = { decide, createProxyServer, isAllowedUpstream, rewriteSetCookie, safePath, BUSINESS_WRITES, COOKIE_HOST, PRODUCTION_UPSTREAM };
