import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// scripts/release.ps1 (the single release command) and scripts/release-status.ps1 (the three-way commit report) are PowerShell tools for the owner's machine.
// They are not executed here (they talk to production); these tests pin the properties that make them safe to rely on.

const read = (f: string): string => fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'scripts', f), 'utf8');
const release = read('release.ps1');
const status = read('release-status.ps1');
const code = (s: string): string => s.replace(/<#[\s\S]*?#>/g, '').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

describe('release.ps1', () => {
  it('releases only through the guarded launcher, never by its own ssh write, merge, pull or restart', () => {
    const c = code(release);
    expect(c).toContain('deploy-static-ui.ps1');
    const remote = c.match(/&\s*ssh [^\n]*/g) ?? [];
    expect(remote.length).toBeGreaterThan(0);
    for (const line of remote) expect(line).toContain('rev-parse HEAD'); // the only thing it ever runs on the server itself
    expect(c).not.toMatch(/systemctl\s+(restart|stop|start)/);
    expect(c).not.toMatch(/sudo\b/);
    expect(c).not.toMatch(/\b3005\b/);
  });

  it('is a rehearsal unless -Apply is given, and the check-only runs against production\'s real live commit', () => {
    expect(release).toMatch(/\[switch\]\$Apply/);
    expect(release).toMatch(/if \(-not \$Apply\)/);
    expect(release).toMatch(/rev-parse HEAD/);
    expect(release).toMatch(/-CheckOnly/);
    expect(release.indexOf('-CheckOnly')).toBeLessThan(release.indexOf("Step 'release'"));
  });

  it('requires master == origin/master, a clean tracked tree and a fast-forwardable base before anything else runs', () => {
    expect(release).toMatch(/current branch is not master/);
    expect(release).toMatch(/differ; push or reconcile first/);
    expect(release).toMatch(/merge-base --is-ancestor/);
    expect(release).toMatch(/uncommitted changes/);
  });

  it('runs typecheck, lint, tests and build, and says so when they were skipped', () => {
    for (const gate of ['typecheck', 'lint', 'tests', 'build']) expect(release).toContain(`Run '${gate}'`);
    expect(release).toMatch(/quality gates SKIPPED/);
  });

  it('only reports success after production\'s own checkout, stamp and served files were re-read, and writes a failure report otherwise', () => {
    expect(release).toMatch(/Step 'verify'/);
    expect(release).toContain('release-status.ps1');
    expect(release).toMatch(/RELEASED AND VERIFIED/);
    expect(release).toMatch(/RELEASE FAILED at step/);
  });
});

describe('local-window.ps1 (the one local launcher)', () => {
  const launcher = read('local-window.ps1');
  const c = code(launcher);
  it('opens the canonical URL, never ports 3000/3005, and identifies a listener by command line before anything else', () => {
    expect(c).toContain('http://workspace.localhost:$Port/dashboard');
    expect(c).toMatch(/\$Port -eq 3005 -or \$Port -eq 3000/);
    expect(c).toMatch(/Win32_Process/);
    expect(c).toContain("dev-proxy\\.cjs");
  });
  it('stops a process only when it is positively a dev-proxy (and a foreign one only with -Replace); unrelated listeners are reported, never killed', () => {
    const stops = [...c.matchAll(/Stop-Process[^\n]*/g)].map((m) => m[0]);
    expect(stops.length).toBeGreaterThan(0);
    for (const s of stops) expect(s).toMatch(/\$existing\.Pid/);
    expect(c).toMatch(/if \(-not \(IsOurProxy \$existing\)\) \{ Write-Error/);
    expect(c).toMatch(/if \(-not \$Replace\) \{ Write-Error/);
    expect(c).toMatch(/which is not this project's proxy\. Not touched/);
    expect(c).not.toMatch(/taskkill|Get-Process node \||Stop-Process -Name/);
  });
  it('reuses a running proxy of this checkout, verifies commit, environment, data source and production health, and reports no local storage', () => {
    expect(c).toContain('reusing the running local window proxy');
    expect(c).toMatch(/environment -ne 'local-ui' -or \$stamp\.dataSource -ne 'production'/);
    expect(c).toMatch(/fullCommit -ne \$head/);
    expect(c).toContain('https://whatsapp.alfarooque.com/health');
    expect(c).toContain('no local database, no WhatsApp session');
  });
});

describe('release-status.ps1', () => {
  it('is read-only: no write, restart, merge or file transfer anywhere', () => {
    const c = code(status);
    expect(c).not.toMatch(/Set-Content|Out-File|Remove-Item|systemctl|sudo|scp\b|rsync|git\s+(pull|merge|reset|checkout|push)/);
    expect(c).not.toMatch(/\b3005\b/);
    const ssh = c.match(/&\s*ssh [^\n]*/g) ?? [];
    expect(ssh.length).toBeGreaterThan(0);
    for (const line of ssh) expect(line).toContain('rev-parse HEAD');
  });

  it('never calls GitHub having a commit "production runs it": it reads the checkout, the published stamp and the served files', () => {
    expect(status).toContain('build-info.json');
    expect(status).toMatch(/Production checkout HEAD/);
    expect(status).toMatch(/Served dashboard\/\$f vs origin\/master/);
    expect(status).toMatch(/PRODUCTION BEHIND/);
  });

  it('uses distinct exit codes for in sync, behind or different, and unknown', () => {
    expect(status).toMatch(/\$code = 2/);
    expect(status).toMatch(/\$code = 1/);
    expect(status).toMatch(/exit \$code/);
  });
});
