import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Snapshots and restores process.env around a test that mutates it (same pattern as env.test.ts). */
function withEnv(vars: Record<string, string | undefined>, fn: (load: () => Promise<typeof import('../../../src/config/env')>) => Promise<void>) {
  return async () => {
    const snapshot = { ...process.env };
    try {
      for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      vi.resetModules();
      await fn(() => import('../../../src/config/env'));
    } finally {
      process.env = snapshot;
      vi.resetModules();
    }
  };
}

describe('media tool paths and local AI provider settings live in the central configuration', () => {
  beforeEach(() => { vi.resetModules(); });

  it('FFMPEG_PATH and PDFTOPPM_PATH are optional, trimmed and default to empty (the tools are then looked up on PATH)', withEnv({ FFMPEG_PATH: undefined, PDFTOPPM_PATH: undefined }, async (load) => {
    const { env } = await load();
    expect(env.FFMPEG_PATH).toBe('');
    expect(env.PDFTOPPM_PATH).toBe('');
  }));

  it('a Windows path with spaces and parentheses, and a Linux path, are accepted as written', withEnv({ FFMPEG_PATH: '  C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe ', PDFTOPPM_PATH: '/home/ubuntu/media-tools/usr/bin/pdftoppm' }, async (load) => {
    const { env } = await load();
    expect(env.FFMPEG_PATH).toBe('C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe');
    expect(env.PDFTOPPM_PATH).toBe('/home/ubuntu/media-tools/usr/bin/pdftoppm');
  }));

  for (const bad of ['ffmpeg; rm something', 'ffmpeg && other', 'a|b', '$(whoami)', '`id`', '"quoted"', "it's", 'out > file', 'new\nline', 'tab\tbad\u0001', 'wild*card', 'q?mark']) {
    it(`a path that could be read as a command is refused at startup: ${JSON.stringify(bad)}`, withEnv({ FFMPEG_PATH: bad }, async (load) => {
      await expect(load()).rejects.toThrow(/Invalid environment configuration/);
    }));
  }

  it('local HTTP AI providers: allowed by default in development and test, refused by default in production, and an explicit setting wins either way', async () => {
    const run = (vars: Record<string, string | undefined>, expected: boolean) => withEnv(vars, async (load) => { expect((await load()).env.allowLocalHttpProviders).toBe(expected); })();
    await run({ NODE_ENV: 'development', AI_ALLOW_LOCAL_HTTP_PROVIDERS: undefined }, true);
    await run({ NODE_ENV: 'test', AI_ALLOW_LOCAL_HTTP_PROVIDERS: undefined }, true);
    await run({ NODE_ENV: 'development', AI_ALLOW_LOCAL_HTTP_PROVIDERS: 'false' }, false);
    await run({ NODE_ENV: 'production', AI_ALLOW_LOCAL_HTTP_PROVIDERS: undefined, OPENROUTER_API_KEY: 'sk-or-v1-production-test-key-0123456789', WHATSAPP_CONNECTION_METHOD: 'qr' }, false);
    await run({ NODE_ENV: 'production', AI_ALLOW_LOCAL_HTTP_PROVIDERS: 'true', OPENROUTER_API_KEY: 'sk-or-v1-production-test-key-0123456789', WHATSAPP_CONNECTION_METHOD: 'qr' }, true);
  });

  it('OMNIROUTE_BASE_URL: unset by default; the loopback gateway address is accepted; anything that is not this machine is refused at startup', async () => {
    await withEnv({ OMNIROUTE_BASE_URL: undefined }, async (load) => { expect((await load()).env.OMNIROUTE_BASE_URL).toBe(''); })();
    for (const ok of ['http://127.0.0.1:20128/v1', 'http://localhost:20999/v1', 'https://localhost:20128/v1']) {
      await withEnv({ OMNIROUTE_BASE_URL: ok }, async (load) => { expect((await load()).env.OMNIROUTE_BASE_URL, ok).toBe(ok); })();
    }
    for (const bad of ['https://evil.example/v1', 'http://10.0.0.5:20128/v1', 'http://169.254.169.254/v1', 'http://user:pw@127.0.0.1:20128/v1', 'http://127.0.0.1:20128/v1?x=1', 'ftp://127.0.0.1/v1', 'not a url']) {
      await withEnv({ OMNIROUTE_BASE_URL: bad }, async (load) => { await expect(load(), bad).rejects.toThrow(/Invalid environment configuration/); })();
    }
  });

  it('SKILLS_DIR and OMNIROUTE_API_KEY are optional; SKILLS_DIR must be a plain path like the tool paths', async () => {
    await withEnv({ SKILLS_DIR: undefined, OMNIROUTE_API_KEY: undefined }, async (load) => { const { env } = await load(); expect(env.SKILLS_DIR).toBe(''); expect(env.OMNIROUTE_API_KEY).toBe(''); })();
    await withEnv({ SKILLS_DIR: '/srv/app/skills' }, async (load) => { expect((await load()).env.SKILLS_DIR).toBe('/srv/app/skills'); })();
    await withEnv({ SKILLS_DIR: 'skills; echo hi' }, async (load) => { await expect(load()).rejects.toThrow(/Invalid environment configuration/); })();
  });
});
