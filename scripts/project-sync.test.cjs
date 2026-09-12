const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { allowed } = require('./project-sync.cjs');

test('exclude secrets and runtime data, retain source and example config', () => {
  for (const p of ['.env', '.env.local', 'secrets/a.json', 'data/a.db', 'nested/private-key.pem', '.claude/settings.local.json', 'node_modules/a.js']) assert.equal(allowed(p), false, p);
  for (const p of ['src/app.ts', '.env.example', 'CLAUDE.md']) assert.equal(allowed(p), true, p);
});
test('handoffs across apps, lock exclusion, checkpoints, unknown edits, deletions and hooks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-project-sync-test-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(__dirname + '/project-sync.cjs', root + '/scripts/project-sync.cjs');
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    fs.writeFileSync(root + '/app.txt', 'initial'); git('add', '.'); git('commit', '-m', 'fixture');
    const call = (args, input) => spawnSync(process.execPath, ['scripts/project-sync.cjs', ...args], { cwd: root, encoding: 'utf8', input: input && JSON.stringify(input) });
    const ok = (...args) => { const r = call(args); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
    fs.writeFileSync(root + '/untracked.txt', 'existing unknown work');
    fs.writeFileSync(root + '/.env', 'DO_NOT_EXPORT');
    const start = ok('start', 'Codex', 'test task', 'codex-test');
    assert(start.inherited.some(x => x.path === 'untracked.txt'));
    assert.equal(call(['start', 'Claude', 'other', 'claude-test']).status, 2);
    assert.equal(call(['guard', 'claude-test']).status, 2);
    assert.equal(ok('check').writer.agent, 'Codex');
    const blocked = call(['hook'], { hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'claude-test' });
    assert.equal(blocked.status, 2);
    assert.equal(call(['hook'], { hook_event_name: 'PreToolUse', tool_name: 'Read', session_id: 'claude-test' }).status, 0);
    fs.writeFileSync(root + '/app.txt', 'Codex edit');
    fs.writeFileSync(root + '/.project-sync/report.json', JSON.stringify({ summary: 'Edited app', reason: 'test', tests: 'simulated', nextSteps: 'Claude review' }));
    ok('checkpoint', 'codex-test', '.project-sync/report.json');
    assert(ok('check').writer);
    ok('finish', 'codex-test', '.project-sync/report.json');
    assert.equal(ok('check').writer, null);
    assert.equal(call(['hook'], { hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'x' }).status, 2);
    const context = call(['hook'], { hook_event_name: 'SessionStart', session_id: 'claude-test' });
    assert.match(context.stdout, /Edited app/);
    assert(!context.stdout.includes('DO_NOT_EXPORT'));
    fs.writeFileSync(root + '/app.txt', 'outside edit');
    assert(ok('check').unattributed.some(x => x.path === 'app.txt'));
    ok('start', 'Claude-Code', 'review', 'claude-test');
    fs.unlinkSync(root + '/app.txt'); fs.writeFileSync(root + '/new.txt', 'new');
    const handoff = ok('finish', 'claude-test', '.project-sync/report.json');
    assert(handoff.changedFiles.some(x => x.change === 'deleted'));
    assert(handoff.changedFiles.some(x => x.change === 'added'));
    assert.equal(ok('check').state.lastHandoff.includes('claude-test'), true);
    assert.equal(ok('check').unattributed.length, 0);
  } finally {
    assert(root.startsWith(path.join(os.tmpdir(), 'whatsapp-project-sync-test-')));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
