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

describe('release-full.ps1 (the full-release wrapper) and release-full.sh (the server-side script)', () => {
  const wrapper = read('release-full.ps1');
  const c = code(wrapper);
  const sh = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'scripts', 'release-full.sh'), 'utf8');
  it('is a rehearsal (--check-only) unless -Apply is given, and the release only follows a passed rehearsal', () => {
    expect(wrapper).toMatch(/\[switch\]\$Apply/);
    expect(c).toMatch(/--check-only/);
    expect(c.indexOf('--check-only')).toBeLessThan(c.indexOf('if (-not $Apply)'));
    expect(c).toMatch(/REHEARSAL FAILED[^\n]*exit 1/);
    expect(c.indexOf('REHEARSAL PASSED')).toBeLessThan(c.indexOf('Invoke-Server "bash $Remote --base $baseFull --target $targetFull"\n'));
  });
  it('REGRESSION 2026-10-13: never defines a function whose body calls the bare command `ssh` (PowerShell names are case-insensitive: `function Ssh { & ssh }` recursed until "call depth overflow"); the client is resolved once as an application', () => {
    const functions = [...c.matchAll(/function\s+([A-Za-z-]+)\b[^\n]*\{([^\n]*)\}/g)];
    for (const [, name, body] of functions) expect({ name, callsBareSsh: /&\s*ssh\b/.test(body) }).toEqual({ name, callsBareSsh: false });
    expect(c).not.toMatch(/function\s+ssh\b/i);
    expect(c).toMatch(/Get-Command ssh -CommandType Application/);
    expect(c).toMatch(/&\s*\$SshExe\b/);
    expect(c).not.toMatch(/&\s+ssh\s/);
  });
  it('takes the target from master == origin/master only, and the base from production itself (ssh live HEAD, cross-checked with the published stamp)', () => {
    expect(c).toMatch(/differ; push or reconcile first/);
    expect(c).toMatch(/is not master == origin\/master/);
    expect(c).toContain('build-info.json');
    expect(c).toMatch(/rev-parse HEAD/);
    expect(c).toMatch(/its published stamp says/);
    expect(c).toMatch(/merge-base --is-ancestor \$baseFull \$targetFull/);
  });
  it('stages the script with CRLF stripped, uses the documented key, and never touches port 3005 or runs the script locally', () => {
    expect(c).toContain("tr -d '\\r' > $Remote");
    expect(c).toContain('oracle-whatsapp-ai.key');
    expect(c).not.toMatch(/\b3005\b/);
    expect(c).not.toMatch(/bash scripts\/release-full\.sh/);
  });
  it('REGRESSION 2026-10-13 (4d5c9ce): under set -e every `grep -c` count in the server script tolerates a zero count (grep exits 1 then); nothing on port 3005 ended the proof silently after the restart', () => {
    const counts = [...sh.matchAll(/grep -c [^\n)]*/g)].map((m) => m[0]);
    expect(counts.length).toBeGreaterThan(0);
    for (const c of counts) expect({ c, guarded: /\|\| true/.test(c) }).toEqual({ c, guarded: true });
    expect(sh).toMatch(/set -e/);
    expect(sh.indexOf('L3005=$(ss -ltn | grep -c \':3005 \' || true)')).toBeGreaterThan(sh.indexOf('systemctl restart $SVC'));
  });
  it('REGRESSION 2026-10-14: the baileys identity fingerprint counts only PAIRED identities (a placeholder creds.json without "me" must not roll a release back), and still includes registrationId and me.id', () => {
    const line = sh.split(/\r?\n/).find((l) => l.startsWith('fp()'))!;
    expect(line).toMatch(/m and print\('\$f',d\.get\('registrationId'\),m\)/);
    expect(line).toContain("(d.get('me') or {}).get('id')");
    expect(line).not.toMatch(/print\('\$f',d\.get\('registrationId'\),\(d\.get\('me'\) or \{\}\)\.get\('id'\)\)/);
  });  it('the server script explains its two hashes and refuses to run outside the production checkout', () => {
    expect(sh).toMatch(/--base <commit production is live on> and --target <commit of origin\/master> are both required/);
    expect(sh).toMatch(/pwsh scripts\/release-full\.ps1/);
    expect(sh).toMatch(/abort server .* is not the production checkout/);
    expect(sh.indexOf('abort server')).toBeLessThan(sh.indexOf('git -C $R remote get-url origin'));
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
