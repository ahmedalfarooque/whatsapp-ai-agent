#!/usr/bin/env node
/**
 * `npm run dev` — the ONE local command. It starts the WhatsApp AI Agent dashboard of THIS checkout on PRODUCTION's data (the local window,
 * scripts/dev-proxy.cjs run in this very process) and opens the browser on the port it chose.
 *
 *   npm run dev                          read-only window on production's data (the normal case)
 *   npm run dev -- --write-business-data the approved business-content writes go to production (connections, sending, users, keys stay blocked)
 *   npm run dev -- --no-open             do not open the browser
 *   npm run dev -- --port 3200           use exactly this port (never 3005); otherwise the first free one of PORT_ORDER
 *   npm run dev -- --status              only report what is running and exit
 *
 * Port selection: 3000, then 3100, 3200, 3300, 3400. A port is taken only when this process could bind it; nothing is ever terminated. What already
 * listens on a candidate is identified first: a window of THIS checkout (its /dashboard/build-info.json names this repository root) is REUSED — the
 * browser is opened on it and this command exits, so there is never a second instance; a window of another checkout, the legacy isolated backend
 * (`npm run legacy:isolated-backend`), or any unrelated program is reported and left alone, and the next port is tried. Two launchers started at the
 * same moment resolve the race at bind time: the one that loses the port re-identifies the winner and reuses it. Port 3005 belongs to another project
 * and is never probed, bound or opened.
 *
 * The browser is sent to http://localhost:<port>/dashboard, which the window redirects to http://workspace.localhost:<port>/dashboard — a loopback
 * name every browser resolves without any hosts-file entry; the production session cookie is scoped to that name, so no other local web app (on any
 * port) ever receives it. There is no local database and no local WhatsApp session in this mode; nothing is copied from production.
 *
 * Ctrl+C stops this process and therefore the window; nothing else is started, so nothing can be orphaned. A failure before the window is proven
 * leaves no listener behind (the server is closed before exiting non-zero).
 *
 * Exported for tests: PORT_ORDER, classify(), selectPort(), occupant(). Test-only environment: DEV_PORT_ORDER (comma-separated candidate ports) and
 * --upstream http://127.0.0.1:<port> (a loopback stand-in for production; dev-proxy.cjs refuses any other upstream).
 */
'use strict';
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const cp = require('node:child_process');
const { createProxyServer, COOKIE_HOST, PRODUCTION_UPSTREAM } = require('./dev-proxy.cjs');

const ROOT = path.resolve(__dirname, '..');
const PORT_ORDER = [3000, 3100, 3200, 3300, 3400];
const FORBIDDEN_PORT = 3005;

function git(args) {
  try { return cp.execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

/** GET http://127.0.0.1:<port>/dashboard/build-info.json as the window expects it (Host workspace.localhost:<port>); null when nothing answers. */
function stamp(port, timeout = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/dashboard/build-info.json', headers: { host: `${COOKIE_HOST}:${port}` }, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => { try { finish(res.statusCode === 200 ? JSON.parse(body) : null); } catch { finish(null); } });
    });
    // a listener that accepts the connection but never answers HTTP (any unrelated program) is "not this project" after the timeout;
    // req.destroy() without an error emits no 'error', so the result is settled here and on 'close' as well
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

/** What a build stamp says about the process that served it, relative to THIS checkout. */
function classify(info, root = ROOT) {
  if (!info || typeof info !== 'object') return { kind: 'unknown', text: 'not this project (no build stamp)' };
  if (info.environment === 'local-ui') {
    const same = typeof info.root === 'string' && path.resolve(info.root) === path.resolve(root);
    return same ? { kind: 'ours', text: `the local window of this checkout (commit ${info.commit}, ${info.mode})` } : { kind: 'other-window', text: `a local window of ANOTHER checkout${info.root ? ` (${info.root})` : ''}` };
  }
  if (info.environment === 'local-isolated') return { kind: 'legacy', text: 'the LEGACY isolated backend (own local database, not production data)' };
  if (info.environment === 'production') return { kind: 'unknown', text: 'a server that calls itself production (not touched)' };
  return { kind: 'unknown', text: 'not this project' };
}

/** Best-effort PID and image name of the listener on a port (Windows: netstat + tasklist; else lsof). Never throws. */
function occupant(port) {
  try {
    if (process.platform === 'win32') {
      const out = cp.execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const line = out.split(/\r?\n/).find((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l));
      const pid = line ? Number(line.trim().split(/\s+/).pop()) : NaN;
      if (!Number.isInteger(pid)) return null;
      const list = cp.execFileSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const name = (list.match(/^"([^"]+)"/) || [])[1] || 'unknown';
      return { pid, name };
    }
    const out = cp.execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = Number((out.match(/^p(\d+)/m) || [])[1]);
    const name = (out.match(/^c(.+)$/m) || [])[1] || 'unknown';
    return Number.isInteger(pid) ? { pid, name } : null;
  } catch { return null; }
}

/** Binds a server to 127.0.0.1:<port>; resolves true when bound, false on EADDRINUSE/EACCES (the server is then not listening). */
function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.removeListener('listening', onListening); if (['EADDRINUSE', 'EACCES'].includes(e.code)) resolve(false); else reject(e); };
    const onListening = () => { server.removeListener('error', onError); resolve(true); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Walks the candidate ports. Returns { port, server, reused:false } when a port was bound, { port, info, reused:true } when a window of this checkout
 * already runs, or { failed: [...] } with one line per candidate. `makeServer()` is called once per bind attempt; `log` receives one line per candidate.
 */
async function selectPort({ order = PORT_ORDER, forced, makeServer, root = ROOT, log = () => {}, probe = stamp, who = occupant }) {
  const candidates = forced ? [forced] : order;
  const failed = [];
  for (const port of candidates) {
    if (port === FORBIDDEN_PORT) { failed.push(`port ${port}: reserved for another project, never used`); continue; }
    const before = await probe(port);
    if (before) {
      const c = classify(before, root);
      if (c.kind === 'ours') { log(`port ${port}: ${c.text} is already running — reusing it`); return { port, info: before, reused: true }; }
      const o = who(port);
      const line = `port ${port}: in use by ${c.text}${o ? ` (pid ${o.pid}, ${o.name})` : ''} — left alone`;
      log(line); failed.push(line); continue;
    }
    const server = makeServer();
    if (await tryListen(server, port)) { log(`port ${port}: free — bound`); return { port, server, reused: false }; }
    // lost a race or the listener does not speak HTTP: identify again
    const after = await probe(port);
    const c = classify(after, root);
    if (c.kind === 'ours') { log(`port ${port}: ${c.text} started a moment ago — reusing it`); return { port, info: after, reused: true }; }
    const o = who(port);
    const line = `port ${port}: in use by ${c.text}${o ? ` (pid ${o.pid}, ${o.name})` : ''} — left alone`;
    log(line); failed.push(line);
  }
  return { failed };
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') cp.spawn('cmd', ['/d', '/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') cp.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else cp.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* the URL is printed anyway */ }
}

function healthOf(upstream) {
  return new Promise((resolve) => {
    const req = (upstream.startsWith('https') ? https : http).get(`${upstream}/health`, { timeout: 10000 }, (r) => { r.resume(); resolve(r.statusCode); });
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => resolve(e.code || e.message));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const known = new Set(['--port', '--write-business-data', '--no-open', '--status', '--upstream', '--json']);
  for (const a of argv) if (a.startsWith('--') && !known.has(a)) { console.error(`unknown option ${a}\nusage: npm run dev [-- --write-business-data] [-- --no-open] [-- --port N] [-- --status]`); process.exit(2); }
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const json = argv.includes('--json');
  const say = (m) => { if (!json) console.log(m); };
  const forced = get('--port') ? Number.parseInt(get('--port'), 10) : undefined;
  if (forced !== undefined && (!Number.isInteger(forced) || forced < 1024 || forced > 65535 || forced === FORBIDDEN_PORT)) { console.error(`--port must be 1024-65535 and never ${FORBIDDEN_PORT} (another project)`); process.exit(2); }
  const order = process.env.DEV_PORT_ORDER ? process.env.DEV_PORT_ORDER.split(',').map((p) => Number.parseInt(p, 10)).filter(Number.isInteger) : PORT_ORDER;
  const upstream = get('--upstream') || PRODUCTION_UPSTREAM;
  const mode = argv.includes('--write-business-data') ? 'business-data' : 'read-only';
  const commit = git(['rev-parse', '--short', 'HEAD']) || 'unknown';
  const branch = git(['branch', '--show-current']) || '?';
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).split('\n').filter((l) => l && !l.includes('.project-sync/')).length;

  say('WhatsApp AI Agent — local window on production data');
  say(`  repository:  ${ROOT} (${commit} on ${branch}${dirty ? `, ${dirty} uncommitted change${dirty === 1 ? '' : 's'}` : ''})`);
  say(`  entry point: scripts/dev.cjs -> scripts/dev-proxy.cjs (this process, pid ${process.pid})`);

  if (argv.includes('--status')) {
    for (const port of order) { const info = await probeAndDescribe(port); say(`  ${info}`); }
    return;
  }

  const makeServer = () => createProxyServer({ upstream, mode, log: (m) => say(`  [proxy ${new Date().toISOString()}] ${m}`) });
  const chosen = await selectPort({ order, forced, makeServer, log: (l) => say(`  ${l}`) });
  if (chosen.failed) {
    console.error(`\nNO PORT AVAILABLE: none of ${(forced ? [forced] : order).join(', ')} could be used; nothing was started and nothing was stopped:\n  ${chosen.failed.join('\n  ')}\nFree one of them, or run: npm run dev -- --port <free port>`);
    process.exit(1);
  }
  const url = `http://localhost:${chosen.port}/dashboard`;
  const privateUrl = `http://${COOKIE_HOST}:${chosen.port}/dashboard`;

  if (chosen.reused) {
    const o = occupant(chosen.port);
    say(`\nALREADY RUNNING on port ${chosen.port}${o ? ` (pid ${o.pid})` : ''}: commit ${chosen.info.commit}, mode ${chosen.info.mode}, data from ${chosen.info.dataSourceHost}. No second instance was started.`);
    say(`  URL: ${url}`);
    if (json) console.log(JSON.stringify({ event: 'reused', port: chosen.port, pid: o && o.pid, url }));
    if (!argv.includes('--no-open')) openBrowser(url);
    return;
  }

  const server = chosen.server;
  server.proxyState.port = chosen.port;
  // proof before the browser opens: the window must describe itself as this checkout's, and production should answer
  const info = await stamp(chosen.port);
  const c = classify(info);
  if (c.kind !== 'ours') {
    await new Promise((r) => server.close(() => r()));
    console.error(`\nSTARTUP FAILED: the window on port ${chosen.port} did not identify itself as this checkout (${c.text}); it was closed again, nothing is left running.`);
    process.exit(1);
  }
  const health = await healthOf(upstream);
  const stop = (signal) => {
    say(`\n${signal}: stopping the local window on port ${chosen.port} (pid ${process.pid}); nothing else was started, nothing else is touched.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => stop('Ctrl+C'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGHUP', () => stop('SIGHUP'));

  say('');
  say(`READY: ${url}`);
  say(`  port:        ${chosen.port} (chosen from ${order.join(' -> ')}; 3005 is never used)`);
  say(`  pid:         ${process.pid}`);
  say(`  build:       commit ${info.commit} (${info.branch}${info.uncommittedChanges ? ' + uncommitted changes' : ''}) — UI files from this checkout`);
  say(`  data source: ${upstream} (production), read through its own login and permissions, mode ${mode}${mode === 'read-only' ? ' (nothing can be changed from here)' : ' (business content only; WhatsApp connections, sending, users and keys stay blocked)'}`);
  say(`  environment: ${info.environment} — no local database, no local WhatsApp session, nothing copied`);
  say(`  production:  /health -> ${health}${health === 200 ? '' : '  (the dashboard will show "server cannot be reached" with Retry until production answers; it never shows local data)'}`);
  say(`  private URL: ${privateUrl} (the browser is sent there; the sign-in cookie is scoped to that name and reaches no other local app)`);
  say('  Press Ctrl+C to stop.');
  if (json) console.log(JSON.stringify({ event: 'ready', port: chosen.port, pid: process.pid, url, privateUrl, commit: info.commit, mode, upstream }));
  if (!argv.includes('--no-open')) openBrowser(url);
}

async function probeAndDescribe(port) {
  const info = await stamp(port);
  if (!info) { const o = occupant(port); return o ? `port ${port}: in use by pid ${o.pid} (${o.name}), not this project` : `port ${port}: free`; }
  const c = classify(info);
  const o = occupant(port);
  return `port ${port}: ${c.text}${o ? ` (pid ${o.pid})` : ''}`;
}

if (require.main === module) main().catch((e) => { console.error(`STARTUP FAILED: ${e.message}`); process.exit(1); });

module.exports = { PORT_ORDER, FORBIDDEN_PORT, classify, selectPort, occupant, stamp, tryListen };
