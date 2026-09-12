// Local cooperative coordination. No network, dependencies, or file contents in records.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, '.project-sync');
const file = name => path.join(dir, name);
const read = (name, fallback = null) => fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), 'utf8')) : fallback;
function atomic(name, value) {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true });
  const tmp = file(`${name}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, file(name));
}
function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); }
function allowed(p) {
  return !p.split('/').some(s => /^(node_modules|dist|coverage|data|secrets|\.git|\.project-sync)$/i.test(s))
    && !/(^|\/)(\.env(?!\.example$)|.*(?:secret|credential|token|private.key).*|settings\.local\.json$)/i.test(p)
    && !/\.(db|sqlite|log|pem|key|p12|pfx)(?:-|$)/i.test(p);
}
function snapshot() {
  const files = {};
  for (const p of [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0'))].sort()) {
    if (!p || !allowed(p)) continue;
    const full = path.join(root, p);
    if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) continue;
    if (!fs.realpathSync(full).toLowerCase().startsWith((root + path.sep).toLowerCase())) continue;
    files[p] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  return { head: git('rev-parse', 'HEAD').trim(), files };
}
function diff(a, b) {
  return [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort()
    .filter(p => a.files[p] !== b.files[p]).map(p => ({ path: p, change: !a.files[p] ? 'added' : !b.files[p] ? 'deleted' : 'modified' }));
}
function check() {
  const state = read('state.json');
  return { root, state, writer: read('writer.json'), unattributed: state ? diff(state.snapshot, snapshot()) : 'No baseline yet' };
}
function owner(session) {
  const lock = read('writer.json');
  if (!lock || lock.session !== session) throw Error('Writer lock belongs to another session or is absent. Run check; do not edit.');
  return lock;
}
function start(agent, task, session = crypto.randomUUID()) {
  if (!agent || !task || !/^[a-zA-Z0-9_-]{1,100}$/.test(session)) throw Error('Agent, task and safe session ID required');
  fs.mkdirSync(dir, { recursive: true });
  // Exclusive creation is the arbiter; never steal a lock based on elapsed time.
  const fd = fs.openSync(file('writer.json'), 'wx');
  try {
    const baseline = snapshot();
    const previous = read('state.json');
    const lock = { session, agent, task, started: new Date().toISOString(), baseline,
      inherited: previous ? diff(previous.snapshot, baseline) : [...new Set([...git('diff', '--name-only', 'HEAD').trim().split('\n'), ...git('ls-files', '--others', '--exclude-standard').trim().split('\n')])].filter(p => p && allowed(p)).map(p => ({ path: p, change: 'pre-existing', owner: 'unknown' })) };
    fs.writeFileSync(fd, JSON.stringify(lock, null, 2));
    if (!previous) atomic('state.json', { summary: 'Initial baseline; existing edits have unknown ownership.', snapshot: baseline, lastHandoff: null });
    return { session, inherited: lock.inherited };
  } catch (e) { fs.unlinkSync(file('writer.json')); throw e; }
  finally { fs.closeSync(fd); }
}
function record(session, report, finish) {
  const lock = owner(session);
  for (const k of ['summary', 'reason', 'tests', 'nextSteps']) if (typeof report[k] !== 'string' || !report[k].trim()) throw Error(`Report requires ${k}`);
  const snap = snapshot();
  const name = `handoffs/${session}-${crypto.randomUUID()}.json`;
  const entry = { session, agent: lock.agent, task: lock.task, at: new Date().toISOString(), finished: finish,
    summary: report.summary, reason: report.reason, tests: report.tests, nextSteps: report.nextSteps,
    changedFiles: diff(lock.baseline, snap), inherited: lock.inherited,
    attribution: 'Observed during this session; not proof of exclusive authorship.' };
  atomic(name, entry);
  atomic('state.json', { summary: report.summary, nextSteps: report.nextSteps, tests: report.tests, lastHandoff: name, snapshot: snap });
  if (finish) fs.unlinkSync(file('writer.json'));
  return entry;
}
function main() {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'check') result = check();
  else if (command === 'start') result = start(...args);
  else if (command === 'checkpoint' || command === 'finish') {
    const reportPath = path.resolve(args[1] || '');
    if (!reportPath.startsWith(dir + path.sep)) throw Error('Reports must be inside .project-sync');
    result = record(args[0], JSON.parse(fs.readFileSync(reportPath, 'utf8')), command === 'finish');
  } else if (command === 'guard') { owner(args[0]); result = { allowed: true }; }
  else if (command === 'hook') {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (input.hook_event_name === 'PreToolUse') {
      // All tool calls are gated while another participant owns the writer lock.
      const lock = read('writer.json');
      if (lock && lock.session !== input.session_id && !['Read', 'Glob', 'Grep'].includes(input.tool_name)) throw Error('Another AI owns the project writer lock. Wait for its handoff.');
      if (!lock && ['Edit', 'Write', 'NotebookEdit'].includes(input.tool_name)) throw Error('Acquire project-sync start with this Claude session_id before editing.');
      result = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Before any mutation acquire project-sync start using this Claude session_id. Read .project-sync/PROTOCOL.md.' } };
    } else result = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Read AGENTS.md and .project-sync/PROTOCOL.md. Run node scripts/project-sync.cjs check. Claude session ID: ' + input.session_id + '\n' + JSON.stringify(check()) } };
  } else throw Error('Commands: check | start AGENT TASK [SESSION] | guard SESSION | checkpoint SESSION REPORT | finish SESSION REPORT | hook');
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) { try { main(); } catch (e) { console.error(e.code === 'EEXIST' ? 'Another writer is active; run check.' : e.message); process.exitCode = 2; } }
module.exports = { allowed, diff };
