import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Exercises scripts/deploy-static-ui.sh in --check-only mode against disposable local git repositories.
// Nothing here connects to, reads or mutates production; the script's apply path is never run.

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'deploy-static-ui.sh');
const BASH = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe', '/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p));
const d = BASH ? describe : describe.skip;

const posix = (p: string) => (process.platform === 'win32' ? '/' + p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, l: string) => l.toLowerCase()) : p);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function put(root: string, rel: string, content: string) {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, content);
}

const INDEX_OLD = '<link href="/dashboard/styles.css"><link href="/dashboard/theme-dark.css"><script src="/dashboard/app.js"></script>';
const INDEX_NEW = '<link href="/dashboard/styles.css"><link href="/dashboard/tokens.css"><script src="/dashboard/app.js"></script>';

let tmp = '';

function makeEnv(name: string, opts: { target?: (w: string) => void } = {}) {
  const work = path.join(tmp, name + '-work');
  const bare = path.join(tmp, name, 'origin.git');
  const live = path.join(tmp, name, 'live');
  const data = path.join(tmp, name, 'data');
  const backups = path.join(tmp, name, 'backups');
  mkdirSync(bare, { recursive: true });
  git(tmp, 'init', '--bare', '-b', 'master', bare);
  mkdirSync(work, { recursive: true });
  git(work, 'init', '-b', 'master');
  put(work, 'dashboard/index.html', INDEX_OLD);
  put(work, 'dashboard/styles.css', 'a{}');
  put(work, 'dashboard/theme-dark.css', 'b{}');
  put(work, 'dashboard/app.js', '1');
  put(work, 'knowledge/k.md', 'k');
  put(work, 'src/a.ts', 'export {}');
  git(work, 'add', '-A'); git(work, 'commit', '-m', 'base');
  const base = git(work, 'rev-parse', '--short', 'HEAD');
  git(work, 'remote', 'add', 'origin', bare);
  put(work, 'dashboard/index.html', INDEX_NEW);
  put(work, 'dashboard/tokens.css', ':root{}');
  rmSync(path.join(work, 'dashboard/theme-dark.css'));
  put(work, 'docs/a.md', 'doc');
  opts.target?.(work);
  git(work, 'add', '-A'); git(work, 'commit', '-m', 'target');
  const target = git(work, 'rev-parse', '--short', 'HEAD');
  git(work, 'push', 'origin', 'master');
  git(tmp, 'clone', '-b', 'master', bare, live);
  git(live, 'reset', '--hard', base);
  mkdirSync(data, { recursive: true }); writeFileSync(path.join(data, 'app.db'), 'x');
  mkdirSync(backups, { recursive: true });
  return { work, bare, live, data, backups, base, target };
}

function run(env: ReturnType<typeof makeEnv>, args: string[], over: Record<string, string> = {}) {
  // stub binaries must win over the Git-for-Windows tools, so PATH is set inside the shell after it has started
  const argv = over.STUB_BIN ? ['-c', 'export PATH="$STUB_BIN:$PATH"; exec bash "$0" "$@"', posix(SCRIPT), ...args] : [posix(SCRIPT), ...args];
  const r = spawnSync(BASH!, argv, {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEPLOY_REPO: posix(env.live), DEPLOY_DATA: posix(env.data), DEPLOY_BACKUP_ROOT: posix(env.backups),
      DEPLOY_ORIGIN_RE: 'origin\\.git$', ...over,
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

d('deploy-static-ui.sh preconditions (check-only, disposable repositories)', () => {
  beforeAll(() => { vi.setConfig({ testTimeout: 60_000 }); tmp = mkdtempSync(path.join(tmpdir(), 'deploy-ui-')); });
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('passes for a correct static release and writes nothing', () => {
    const e = makeEnv('ok');
    const before = git(e.live, 'rev-parse', 'HEAD');
    const r = run(e, ['--base', e.base, '--target', e.target, '--check-only']);
    expect(r.out).toContain('CHECK-ONLY OK');
    expect(r.code).toBe(0);
    expect(git(e.live, 'rev-parse', 'HEAD')).toBe(before);           // live checkout untouched
    expect(readFileSync(path.join(e.live, 'dashboard/index.html'), 'utf8')).toBe(INDEX_OLD);
    expect(existsSync(path.join(e.live, 'dashboard/tokens.css'))).toBe(false);
    expect(readdirSync(e.backups)).toEqual([]);   // no backup directory created in check mode
  });

  it('refuses a wrong live commit', () => {
    const e = makeEnv('wrongbase');
    const r = run(e, ['--base', e.target, '--target', e.target, '--check-only']);
    expect(r.code).toBe(1); expect(r.out).toMatch(/ABORT\[live-commit\].*expected base/);
  });

  it('refuses when origin/master is not the intended target', () => {
    const e = makeEnv('wrongtarget');
    const r = run(e, ['--base', e.base, '--target', e.base, '--check-only']);
    expect(r.code).toBe(1); expect(r.out).toMatch(/ABORT\[target-commit\].*not the intended target/);
  });

  it('refuses malformed arguments', () => {
    const e = makeEnv('args');
    expect(run(e, ['--base', 'main', '--target', e.target, '--check-only']).out).toMatch(/ABORT\[arguments\]/);
    expect(run(e, ['--base', e.base, '--bogus']).out).toMatch(/ABORT\[args\]/);
  });

  it('refuses a dirty live checkout', () => {
    const e = makeEnv('dirty');
    writeFileSync(path.join(e.live, 'dashboard/styles.css'), 'changed');
    const r = run(e, ['--base', e.base, '--target', e.target, '--check-only']);
    expect(r.code).toBe(1); expect(r.out).toMatch(/ABORT\[live-commit\].*uncommitted/);
  });

  it('refuses a wrong repository (path inside another repo, or a different origin)', () => {
    const e = makeEnv('wrongrepo');
    const sub = path.join(e.live, 'dashboard');
    expect(run(e, ['--base', e.base, '--target', e.target, '--check-only'], { DEPLOY_REPO: posix(sub) }).out).toMatch(/ABORT\[repo-identity\].*different repository/);
    expect(run(e, ['--base', e.base, '--target', e.target, '--check-only'], { DEPLOY_ORIGIN_RE: 'ahmedalfarooque/whatsapp-ai-agent' }).out).toMatch(/ABORT\[repo-identity\].*origin is not/);
    expect(run(e, ['--base', e.base, '--target', e.target, '--check-only'], { DEPLOY_REPO: '/nonexistent/dir' }).out).toMatch(/ABORT\[repo-identity\].*does not exist/);
    expect(run(e, ['--base', e.base, '--target', e.target, '--check-only'], { DEPLOY_REPO: 'relative/path' }).out).toMatch(/ABORT\[repo-identity\].*absolute/);
  });

  it('refuses to be pointed at port 3005, another port or another service', () => {
    const e = makeEnv('ports');
    expect(run(e, ['--base', e.base, '--target', e.target, '--check-only'], { DEPLOY_APP_PORT: '3005' }).out).toMatch(/ABORT\[port-guard\].*3005/);
    expect(run(e, ['--base', e.base, '--target', e.target, '--check-only'], { DEPLOY_APP_PORT: '8080' }).out).toMatch(/ABORT\[port-guard\].*must be 3000/);
    expect(run(e, ['--base', e.base, '--target', e.target, '--check-only'], { DEPLOY_SERVICE: 'other-service' }).out).toMatch(/ABORT\[port-guard\].*service/);
  });

  it('refuses a release that touches files outside dashboard/, docs/, tests/', () => {
    const e = makeEnv('scope', { target: (w) => { put(w, 'src/a.ts', 'export const changed = 1;'); put(w, 'package.json', '{}'); } });
    const r = run(e, ['--base', e.base, '--target', e.target, '--check-only']);
    expect(r.code).toBe(1); expect(r.out).toMatch(/ABORT\[release-scope\].*outside/);
    expect(r.out).toContain('src/a.ts'); expect(r.out).toContain('package.json');
  });

  it('accepts the read-only developer tool scripts/env-report.cjs (never loaded by the app) but no other script', () => {
    const ok = makeEnv('envtool', { target: (w) => { put(w, 'scripts/env-report.cjs', '// tool'); } });
    expect(run(ok, ['--base', ok.base, '--target', ok.target, '--check-only']).out).toContain('CHECK-ONLY OK');
    const bad = makeEnv('othertool', { target: (w) => { put(w, 'scripts/other.cjs', '// not allowed'); } });
    expect(run(bad, ['--base', bad.base, '--target', bad.target, '--check-only']).out).toMatch(/ABORT\[release-scope\].*scripts\/other\.cjs/);
  });

  it('accepts the developer proxy and the two release scripts (none is loaded by the app) but still refuses backend, data and other tooling', () => {
    const ok = makeEnv('devtools', { target: (w) => { put(w, 'scripts/dev-proxy.cjs', '// tool'); put(w, 'scripts/build-info.cjs', '// tool'); put(w, 'scripts/release.ps1', '# tool'); put(w, 'scripts/release-status.ps1', '# tool'); } });
    expect(run(ok, ['--base', ok.base, '--target', ok.target, '--check-only']).out).toContain('CHECK-ONLY OK');
    for (const file of ['src/index.ts', 'package.json', 'data/app.db', 'scripts/project-sync.cjs', 'scripts/release.sh', 'scripts/dev-proxy.js']) {
      const bad = makeEnv('reject-' + file.replace(/\W/g, '-'), { target: (w) => { put(w, file, 'x'); } });
      expect(run(bad, ['--base', bad.base, '--target', bad.target, '--check-only']).out, file).toMatch(/ABORT\[release-scope\]/);
    }
  });

  it('refuses a release that lacks tokens.css or whose index references a missing asset', () => {
    const missing = makeEnv('notokens', { target: (w) => { rmSync(path.join(w, 'dashboard/tokens.css')); } });
    expect(run(missing, ['--base', missing.base, '--target', missing.target, '--check-only']).out).toMatch(/ABORT\[release-assets\].*tokens\.css/);
    const dangling = makeEnv('dangling', { target: (w) => { put(w, 'dashboard/index.html', INDEX_NEW + '<link href="/dashboard/ghost.css">'); } });
    expect(run(dangling, ['--base', dangling.base, '--target', dangling.target, '--check-only']).out).toMatch(/ABORT\[release-assets\].*ghost\.css/);
    const stillOld = makeEnv('stillold', { target: (w) => { put(w, 'dashboard/index.html', INDEX_OLD); } });
    expect(run(stillOld, ['--base', stillOld.base, '--target', stillOld.target, '--check-only']).out).toMatch(/ABORT\[release-assets\]/);
  });

  it('refuses an invalid backup destination or insufficient space', () => {
    const e = makeEnv('backup');
    expect(run(e, ['--base', e.base, '--target', e.target, '--check-only'], { DEPLOY_BACKUP_ROOT: posix(path.join(tmp, 'nope')) }).out).toMatch(/ABORT\[backup-destination\].*does not exist/);
    expect(run(e, ['--base', e.base, '--target', e.target, '--check-only'], { DEPLOY_DATA: posix(path.join(tmp, 'nodata')) }).out).toMatch(/ABORT\[backup-destination\].*missing path/);
    expect(run(e, ['--base', e.base, '--target', e.target, '--check-only'], { DEPLOY_SPACE_FACTOR: '1000000000' }).out).toMatch(/ABORT\[backup-destination\].*not enough free space/);
  });

  // ---- apply path against the same disposable repositories, with the server tools (systemctl, curl, ss, sqlite3) replaced by local stubs
  function stubs(name: string, env: ReturnType<typeof makeEnv>) {
    const bin = path.join(tmp, name, 'bin');
    mkdirSync(bin, { recursive: true });
    const w = (n: string, body: string) => writeFileSync(path.join(bin, n), '#!/usr/bin/env bash\n' + body + '\n');
    w('systemctl', 'case "$1" in is-active) echo active;; show) echo 4242;; esac');
    w('ss', 'echo "LISTEN 0 511 *:3000 *:*"');
    w('sqlite3', String.raw`case "$*" in
  *".backup"*) dest="$(echo "$2" | sed "s/^.backup '//; s/'\$//")"; cp "$1" "$dest";;
  *integrity_check*) echo ok;;
  *) echo row;;
esac`);
    w('curl', [
      'url="${@: -1}"; rest="${url#*://}"; p="/${rest#*/}"',
      'if [[ "$*" == *"http_code"* ]]; then',
      '  case "$p" in',
      '    /health|/readiness) printf 200;;',
      '    /dashboard/*) f="${p#/dashboard/}"; if [ "$f" = "${STUB_BREAK:-}" ] || [ ! -f "$DEPLOY_REPO/dashboard/$f" ]; then printf 404; else printf 200; fi;;',
      '    *) printf 404;;',
      '  esac',
      'elif [ "$p" = /dashboard/build-info.json ]; then cat "$DEPLOY_REPO/dashboard/build-info.json" 2>/dev/null',
      'else cat "$DEPLOY_REPO/dashboard/index.html"; fi'].join('\n'));
    mkdirSync(path.join(env.data, 'baileys-auth'), { recursive: true }); writeFileSync(path.join(env.data, 'baileys-auth', 'creds.json'), '{}');
    mkdirSync(path.join(env.data, 'uploads'), { recursive: true }); writeFileSync(path.join(env.data, 'uploads', 'f.pdf'), 'p');
    mkdirSync(path.join(env.live, 'dist'), { recursive: true }); writeFileSync(path.join(env.live, 'dist', 'index.js'), '1');
    return { STUB_BIN: posix(bin), DEPLOY_PUBLIC_URL: 'https://example.invalid' };
  }

  it('apply path: verified backup, fast-forward, served-asset proof, state fingerprints unchanged', () => {
    const e = makeEnv('apply');
    const over = stubs('apply', e);
    const r = run(e, ['--base', e.base, '--target', e.target], over);
    expect(r.out).toContain('DEPLOY OK');
    expect(r.code).toBe(0);
    expect(git(e.live, 'rev-parse', '--short', 'HEAD')).toBe(e.target);
    const made = readdirSync(e.backups);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatch(/^pre-ui-redesign-\d{8}-\d{6}$/);
    expect(existsSync(path.join(e.backups, made[0], 'app.db'))).toBe(true);
    expect(readFileSync(path.join(e.backups, made[0], 'dashboard/index.html'), 'utf8')).toBe(INDEX_OLD); // the backup holds the previous release
    expect(r.out).toMatch(/\/dashboard\/tokens\.css local=200 public=200/);
    expect(r.out).toMatch(/removed \/dashboard\/theme-dark\.css -> 404/);
    const stamp = JSON.parse(readFileSync(path.join(e.live, 'dashboard/build-info.json'), 'utf8')); // the release stamp names the exact commit now running
    expect(stamp.fullCommit).toBe(git(e.live, 'rev-parse', 'HEAD'));
    expect(stamp).toMatchObject({ environment: 'production', branch: 'master' });
    expect(r.out).toContain('release stamp:');
    expect(r.out).toContain(`git checkout --detach`);
  });

  it('apply path: a failed post-release check rolls back to the base commit and keeps the backup', () => {
    const e = makeEnv('rollback');
    const over = stubs('rollback', e);
    const r = run(e, ['--base', e.base, '--target', e.target], { ...over, STUB_BREAK: 'tokens.css' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('VERIFY FAILED');
    expect(r.out).toMatch(/rolled back/);
    expect(git(e.live, 'rev-parse', '--short', 'HEAD')).toBe(e.base);
    expect(readFileSync(path.join(e.live, 'dashboard/index.html'), 'utf8')).toBe(INDEX_OLD);
    expect(JSON.parse(readFileSync(path.join(e.live, 'dashboard/build-info.json'), 'utf8')).fullCommit).toBe(git(e.live, 'rev-parse', 'HEAD')); // the stamp is rolled back with the code
    expect(readdirSync(e.backups)).toHaveLength(1);
  });

  it('contains no restart, destructive git/npm command or recursive ownership change, and names the 3005 guard', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/systemctl\s+(restart|stop|start)/);
    expect(src).not.toMatch(/--force|reset --hard|rm -rf|npm (run|test|install)|chown -R|\bdrop table\b/i);
    expect(src).toMatch(/3005/);
    expect(src).toMatch(/--ff-only/);
  });
});
