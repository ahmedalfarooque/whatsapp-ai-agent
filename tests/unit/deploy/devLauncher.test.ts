import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';

// scripts/dev.cjs — `npm run dev`, the one local command. Port selection, reuse and shutdown are exercised with DISPOSABLE ports and a loopback
// stand-in for production; the real ports 3000/3100/... and production itself are never touched by this file.
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..', '..', '..');
const launcher = require(path.join(ROOT, 'scripts', 'dev.cjs')) as {
  PORT_ORDER: number[];
  FORBIDDEN_PORT: number;
  classify: (info: unknown, root?: string) => { kind: string; text: string };
  selectPort: (o: Record<string, unknown>) => Promise<{ port?: number; server?: http.Server; reused?: boolean; info?: unknown; failed?: string[] }>;
  tryListen: (s: net.Server, port: number) => Promise<boolean>;
};
const proxy = require(path.join(ROOT, 'scripts', 'dev-proxy.cjs')) as { createProxyServer: (o: Record<string, unknown>) => http.Server & { proxyState: { port: number } } };

const freePort = (): Promise<number> => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); });
const listenOn = (s: net.Server, port: number): Promise<void> => new Promise((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', () => resolve()); });
// a silent "stranger" keeps the probe's half-closed sockets around; closing it must not hold the test (the worker exits anyway)
const closeAll = async (...servers: Array<net.Server | undefined>) => { for (const s of servers) if (s && s.listening) await Promise.race([new Promise((r) => s.close(() => r(null))), new Promise((r) => setTimeout(r, 500))]); };
const isListening = (port: number): Promise<boolean> => new Promise((resolve) => { const c = net.connect({ host: '127.0.0.1', port }); c.once('connect', () => { c.destroy(); resolve(true); }); c.once('error', () => resolve(false)); });

let upstream: http.Server;
let upstreamUrl = '';
beforeAll(async () => {
  upstream = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeAll(upstream); });

describe('the documented order and the identification of what already listens', () => {
  it('tries 3000, then 3100, 3200, 3300, 3400 — and 3005 is the forbidden port', () => {
    expect(launcher.PORT_ORDER).toEqual([3000, 3100, 3200, 3300, 3400]);
    expect(launcher.FORBIDDEN_PORT).toBe(3005);
    expect(launcher.PORT_ORDER).not.toContain(3005);
  });

  it('recognises its own window by checkout root; another checkout, the legacy backend and strangers are named, never treated as its own', () => {
    expect(launcher.classify({ environment: 'local-ui', root: ROOT, commit: 'abc1234', mode: 'read-only' }, ROOT).kind).toBe('ours');
    expect(launcher.classify({ environment: 'local-ui', root: path.join(ROOT, '..', 'other-checkout'), commit: 'abc1234' }, ROOT).kind).toBe('other-window');
    expect(launcher.classify({ environment: 'local-ui', commit: 'abc1234' }, ROOT).kind).toBe('other-window'); // an older proxy without a root is not assumed to be ours
    expect(launcher.classify({ environment: 'local-isolated', dataSource: 'local-database' }, ROOT)).toMatchObject({ kind: 'legacy', text: expect.stringContaining('LEGACY') });
    expect(launcher.classify(null, ROOT).kind).toBe('unknown');
    expect(launcher.classify({ environment: 'production' }, ROOT).kind).toBe('unknown');
  });
});

describe('port selection with disposable ports', () => {
  const makeServer = () => proxy.createProxyServer({ upstream: upstreamUrl, mode: 'read-only' });

  it('1. the first port is free -> it is chosen and bound', async () => {
    const [p1, p2] = [await freePort(), await freePort()];
    const r = await launcher.selectPort({ order: [p1, p2], makeServer });
    expect(r).toMatchObject({ port: p1, reused: false });
    expect(r.server!.listening).toBe(true);
    await closeAll(r.server);
  });

  it('2. the first port is held by an unrelated listener -> the next one is chosen and the unrelated process is not touched', async () => {
    const [p1, p2] = [await freePort(), await freePort()];
    const stranger = net.createServer(); // not even HTTP: nothing to identify, nothing to kill
    await listenOn(stranger, p1);
    const lines: string[] = [];
    const r = await launcher.selectPort({ order: [p1, p2], makeServer, log: (l: string) => lines.push(l), who: () => ({ pid: 4242, name: 'stranger.exe' }) });
    expect(r).toMatchObject({ port: p2, reused: false });
    expect(stranger.listening).toBe(true);
    expect(await isListening(p1)).toBe(true);
    expect(lines[0]).toMatch(new RegExp(`port ${p1}: in use by not this project.*pid 4242, stranger\\.exe.*left alone`));
    await closeAll(r.server, stranger);
  });

  it('3. the first two are occupied -> the third; the legacy isolated backend is recognised by its stamp and skipped', async () => {
    const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()];
    const stranger = net.createServer();
    await listenOn(stranger, p1);
    const legacy = http.createServer((req, res) => { // what src/dashboard/router.ts serves for an unstamped checkout
      if (req.url === '/dashboard/build-info.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ commit: 'abc1234', environment: 'local-isolated', dataSource: 'local-database', stamped: false, supportedCommand: 'npm run dev' })); } else { res.writeHead(404); res.end(); }
    });
    await listenOn(legacy, p2);
    const lines: string[] = [];
    const r = await launcher.selectPort({ order: [p1, p2, p3], makeServer, log: (l: string) => lines.push(l), who: () => null });
    expect(r).toMatchObject({ port: p3, reused: false });
    expect(lines).toEqual([expect.stringContaining(`port ${p1}: in use by not this project`), expect.stringContaining(`port ${p2}: in use by the LEGACY isolated backend`), `port ${p3}: free — bound`]);
    expect(stranger.listening && legacy.listening).toBe(true);
    await closeAll(r.server, stranger, legacy);
  });

  it('4. a window of THIS checkout already runs -> it is reused, no second server is created; a window of ANOTHER checkout is left alone and skipped', async () => {
    const [p1, p2] = [await freePort(), await freePort()];
    const running = makeServer();
    await listenOn(running, p1);
    running.proxyState.port = p1;
    let created = 0;
    const r = await launcher.selectPort({ order: [p1, p2], makeServer: () => { created += 1; return makeServer(); } });
    expect(r).toMatchObject({ port: p1, reused: true });
    expect(created).toBe(0);
    expect((r.info as { root: string }).root).toBe(ROOT);
    // the same window seen from another checkout: not ours, not stopped, next port
    const lines: string[] = [];
    const other = await launcher.selectPort({ order: [p1, p2], makeServer, root: path.join(ROOT, '..', 'elsewhere'), log: (l: string) => lines.push(l), who: () => null });
    expect(other).toMatchObject({ port: p2, reused: false });
    expect(lines[0]).toContain('a local window of ANOTHER checkout');
    expect(running.listening).toBe(true);
    await closeAll(running, other.server);
  });

  it('nothing available -> a line per port and no server left behind; 3005 is never probed or bound', async () => {
    const p1 = await freePort();
    const stranger = net.createServer();
    await listenOn(stranger, p1);
    const probed: number[] = [];
    const r = await launcher.selectPort({ order: [3005, p1], makeServer, probe: async (port: number) => { probed.push(port); return null; }, who: () => null });
    expect(r.failed).toEqual([`port 3005: reserved for another project, never used`, expect.stringContaining(`port ${p1}: in use by not this project`)]);
    expect(probed).toEqual([p1, p1]); // once before the bind attempt, once after it failed (the race check); 3005 never
    expect(probed).not.toContain(3005);
    expect(r.server).toBeUndefined();
    await closeAll(stranger);
  });

  it('a lost bind race re-identifies the winner: when it is this checkout\'s window it is reused instead of trying the next port', async () => {
    const [p1, p2] = [await freePort(), await freePort()];
    // the other launcher wins the bind between our first probe (port looks free) and our own bind attempt (EADDRINUSE)
    const winner = makeServer();
    let probes = 0;
    const raced = await launcher.selectPort({
      order: [p1, p2],
      makeServer,
      probe: async (port: number) => {
        probes += 1;
        if (probes === 1) { await listenOn(winner, p1); return null; }
        return port === p1 ? { environment: 'local-ui', root: ROOT, commit: 'abc1234', mode: 'read-only' } : null;
      },
      who: () => null,
    });
    expect(raced).toMatchObject({ port: p1, reused: true });
    expect(probes).toBe(2);
    await closeAll(winner);
  });
});

describe('the command itself (npm run dev = node scripts/dev.cjs), spawned with disposable ports and a loopback stand-in for production', () => {
  const waitFor = (child: ChildProcess, event: string, ms = 15000): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no "${event}" within ${ms} ms; output so far:\n${out}`)), ms);
    child.stdout!.on('data', (c) => {
      out += String(c);
      for (const line of out.split(/\r?\n/)) {
        if (!line.startsWith('{')) continue;
        try { const j = JSON.parse(line); if (j.event === event) { clearTimeout(timer); resolve(j); } } catch { /* partial */ }
      }
    });
    child.once('exit', (code) => { if (event !== 'exit') { clearTimeout(timer); reject(new Error(`exited with ${code} before "${event}":\n${out}`)); } });
  });
  const run = (ports: number[], extra: string[] = []): ChildProcess => spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev.cjs'), '--no-open', '--json', '--upstream', upstreamUrl, ...extra], { cwd: ROOT, env: { ...process.env, DEV_PORT_ORDER: ports.join(',') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = (child: ChildProcess): Promise<{ code: number | null; stderr: string }> => new Promise((resolve) => { let stderr = ''; child.stderr!.on('data', (c) => { stderr += String(c); }); child.once('exit', (code) => resolve({ code, stderr })); });

  it('4/5. starting twice gives ONE instance (the second run reports it and exits 0); stopping the first releases its port and nothing else', async () => {
    const [p1, p2] = [await freePort(), await freePort()];
    const first = run([p1, p2]);
    const ready = await waitFor(first, 'ready');
    expect(ready).toMatchObject({ port: p1, pid: first.pid, url: `http://localhost:${p1}/dashboard`, privateUrl: `http://workspace.localhost:${p1}/dashboard`, mode: 'read-only', upstream: upstreamUrl });
    expect(await isListening(p1)).toBe(true);

    const second = run([p1, p2]);
    const reused = await waitFor(second, 'reused');
    expect(reused).toMatchObject({ port: p1, url: `http://localhost:${p1}/dashboard` });
    expect((await exited(second)).code).toBe(0);
    expect(await isListening(p2)).toBe(false); // no second instance anywhere
    expect(await isListening(p1)).toBe(true); // the first is untouched by the second run

    first.kill(process.platform === 'win32' ? undefined : 'SIGINT');
    await exited(first);
    expect(await isListening(p1)).toBe(false);
    expect(upstream.listening).toBe(true); // the stand-in for production (an unrelated process) is still there
  }, 30000);

  it('6. no candidate usable -> exit 1, "NO PORT AVAILABLE", nothing started, the occupant untouched', async () => {
    const p1 = await freePort();
    const stranger = net.createServer();
    await listenOn(stranger, p1);
    const child = run([p1]);
    const { code, stderr } = await exited(child);
    expect(code).toBe(1);
    expect(stderr).toContain('NO PORT AVAILABLE');
    expect(stderr).toContain(`port ${p1}: in use by not this project`);
    expect(stranger.listening).toBe(true);
    await closeAll(stranger);
  }, 20000);

  it('refuses --port 3005 before touching the network', async () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev.cjs'), '--no-open', '--port', '3005'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const { code, stderr } = await exited(child);
    expect(code).toBe(2);
    expect(stderr).toContain('never 3005');
  });
});

describe('package.json and the preview configuration point at the one command', () => {
  const pkg = require(path.join(ROOT, 'package.json')) as { scripts: Record<string, string> };
  const launch = require(path.join(ROOT, '.claude', 'launch.json')) as { configurations: Array<{ name: string; runtimeExecutable: string; runtimeArgs: string[]; port: number; url?: string }> };
  it('npm run dev is scripts/dev.cjs; the isolated backend is a clearly named legacy script; no "window" script remains', () => {
    expect(pkg.scripts.dev).toBe('node scripts/dev.cjs');
    expect(pkg.scripts['legacy:isolated-backend']).toBe('tsx watch src/index.ts');
    expect(pkg.scripts.window).toBeUndefined();
    expect(pkg.scripts.start).toBe('node dist/index.js'); // production's command is unchanged
  });
  it('.claude/launch.json has exactly one configuration, running npm run dev', () => {
    expect(launch.configurations).toHaveLength(1);
    expect(launch.configurations[0]).toMatchObject({ name: 'dev', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev', '--', '--no-open'], port: 3000 });
  });
});
