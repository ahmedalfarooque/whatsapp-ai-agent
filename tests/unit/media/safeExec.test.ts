import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { minimalToolEnv, runTool } from '../../../src/media/safeExec';

/** These run a REAL child process (this Node binary, not FFmpeg): they prove the way media tools are started, which is what matters when one of them parses a hostile file. */
const SECRET_NAMES = ['OPENROUTER_API_KEY', 'DASHBOARD_MASTER_KEY', 'WHATSAPP_ACCESS_TOKEN', 'META_APP_SECRET', 'GOOGLE_PRIVATE_KEY', 'RESEND_API_KEY', 'DATABASE_PATH', 'OMNIROUTE_API_KEY', 'GEMINI_API_KEY', 'TEST_SECRET_FOR_SAFE_EXEC'];
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); for (const n of SECRET_NAMES) delete process.env[n]; });
const tmp = async (): Promise<string> => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-exec-')); dirs.push(d); return d; };

describe('how a media tool is started', () => {
  it('the environment handed to a tool contains none of this application\'s secrets, only what is needed to start', () => {
    const source: NodeJS.ProcessEnv = { PATH: '/usr/bin', Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', HOME: '/home/app', LANG: 'C', TMPDIR: '/tmp', TEMP: 'C:\\Temp', TMP: 'C:\\Temp' };
    for (const n of SECRET_NAMES) source[n] = 'super-secret-value';
    const out = minimalToolEnv(source);
    for (const n of SECRET_NAMES) expect(out[n], n).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('super-secret-value');
    expect(Object.keys(out).length).toBeGreaterThan(0);
  });

  it('a real child process runs in the given working directory and does NOT see the parent\'s secrets', async () => {
    for (const n of SECRET_NAMES) process.env[n] = `value-of-${n}`;
    const dir = await tmp();
    const script = "const fs=require('fs');fs.writeFileSync('report.json',JSON.stringify({cwd:process.cwd(),keys:Object.keys(process.env)}))";
    const result = await runTool(process.execPath, ['-e', script], 20_000, { cwd: dir });
    expect(result).toEqual({ ok: true });
    const report = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8')) as { cwd: string; keys: string[] };
    expect(await fs.realpath(report.cwd)).toBe(await fs.realpath(dir));
    for (const n of SECRET_NAMES) expect(report.keys, n).not.toContain(n);
  });

  it('arguments are never interpreted by a shell', async () => {
    const dir = await tmp();
    const marker = path.join(dir, 'pwned');
    const hostile = `"; node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}','x')" #`;
    await runTool(process.execPath, ['-e', 'void 0', hostile], 20_000, { cwd: dir });
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it('a tool that hangs is killed at the timeout, and a cancel signal stops it at once; failure is reported, not thrown', async () => {
    const hang = ['-e', 'setInterval(() => {}, 1000)'];
    const started = Date.now();
    expect(await runTool(process.execPath, hang, 400)).toEqual({ ok: false });
    expect(Date.now() - started).toBeLessThan(10_000);
    const controller = new AbortController();
    const pending = runTool(process.execPath, hang, 60_000, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect(await pending).toEqual({ ok: false });
    expect(await runTool(path.join(os.tmpdir(), 'no-such-binary-xyz'), [], 5_000)).toEqual({ ok: false });
  });
});
