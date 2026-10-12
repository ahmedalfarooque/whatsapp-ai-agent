import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'build-info.cjs');

// scripts/build-info.cjs stamps a LOCAL checkout with its commit for the footer and banner. Read-only toward git; --print writes nothing.
describe('build-info.cjs', () => {
  it('describes the checkout as an isolated local environment with a real commit, and carries no secrets or data', () => {
    const info = require(SCRIPT).buildInfo();
    expect(info.fullCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(info.commit).toBe(info.fullCommit.slice(0, 7));
    expect(info.environment).toBe('local-isolated');
    expect(Object.keys(info).sort()).toEqual(['branch', 'commit', 'dataSource', 'environment', 'fullCommit', 'generatedAt', 'uncommittedChanges']);
  });

  it('--print writes nothing to the dashboard folder', () => {
    const stamp = path.join(ROOT, 'dashboard', 'build-info.json');
    const before = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : null;
    const out = cp.execFileSync(process.execPath, [SCRIPT, '--print'], { encoding: 'utf8' });
    expect(JSON.parse(out).environment).toBe('local-isolated');
    expect(fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : null).toBe(before);
  });

  it('the stamp file is ignored by Git, so it can never be committed or become part of a release', () => {
    expect(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')).toMatch(/^dashboard\/build-info\.json\s*$/m);
  });
});
