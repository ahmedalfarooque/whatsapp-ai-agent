#!/usr/bin/env node
// READ-ONLY report of WHICH environment this checkout is: the Git state, the database it would open, the accounts in it and where the
// WhatsApp session files live. It answers "why does localhost show different accounts than production?" without guessing.
//
//   node scripts/env-report.cjs
//
// It opens the database read-only, prints counts / statuses / file metadata only, and never prints a credential, a token, a message or a
// session file. Production and a developer machine intentionally have DIFFERENT databases and WhatsApp sessions; this report never changes either.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const sh = (args) => { try { return cp.execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

/** DATABASE_PATH from the process environment, else from the .env file (that one key only), else the application default. */
function resolveDbPath() {
  let raw = process.env.DATABASE_PATH;
  let source = 'process environment';
  if (!raw) {
    const envFile = path.join(ROOT, '.env');
    if (fs.existsSync(envFile)) {
      const line = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => /^\s*DATABASE_PATH\s*=/.test(l));
      if (line) { raw = line.replace(/^\s*DATABASE_PATH\s*=\s*/, '').trim().replace(/^['"]|['"]$/g, ''); source = '.env'; }
    }
  }
  if (!raw) { raw = './data/app.db'; source = 'application default'; }
  return { file: path.resolve(ROOT, raw), source };
}

function dirStats(dir) {
  if (!fs.existsSync(dir)) return null;
  let files = 0; let bytes = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files += 1; bytes += fs.statSync(p).size; } } };
  walk(dir);
  return { files, bytes };
}

function main() {
  const lines = [];
  const out = (s = '') => lines.push(s);
  const branch = sh(['branch', '--show-current']) || '(detached)';
  const head = sh(['rev-parse', '--short', 'HEAD']);
  const upstream = sh(['rev-parse', '--short', 'origin/master']);
  const ahead = sh(['rev-list', '--count', 'origin/master..HEAD']);
  const behind = sh(['rev-list', '--count', 'HEAD..origin/master']);
  const dirty = sh(['status', '--porcelain', '--untracked-files=no']).split('\n').filter((l) => l && !l.includes('.project-sync/')).length;
  out('ENVIRONMENT REPORT (read-only)');
  out(`repository : ${ROOT}`);
  out(`git        : branch ${branch} @ ${head}; origin/master @ ${upstream || 'unknown (run git fetch)'}; ahead ${ahead || '?'} / behind ${behind || '?'}; tracked changes ${dirty}`);

  const { file, source } = resolveDbPath();
  out(`database   : ${file} (from ${source})`);
  if (!fs.existsSync(file)) {
    out('             does not exist yet: the application creates an EMPTY database here on first start');
  } else {
    const st = fs.statSync(file);
    out(`             ${st.size} bytes, modified ${st.mtime.toISOString()}`);
    let Database;
    try { Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3')); } catch { Database = null; }
    if (!Database) {
      out('             (better-sqlite3 is not installed: run npm install to see accounts)');
    } else {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        const one = (sql) => { try { return db.prepare(sql).get(); } catch { return null; } };
        out(`             integrity ${db.pragma('integrity_check', { simple: true })}; latest migration ${(one('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1') || {}).id || 'n/a'}`);
        let accounts = [];
        try { accounts = db.prepare("SELECT id, name, status, CASE WHEN ifnull(phone_number,'')='' THEN 'unset' ELSE 'set' END AS number FROM whatsapp_accounts ORDER BY id").all(); } catch { /* no table yet */ }
        out(`accounts   : ${accounts.length}`);
        for (const a of accounts) out(`             #${a.id} ${a.name} - ${a.status} (phone number ${a.number})`);
        const count = (t) => { const r = one(`SELECT count(*) c FROM ${t}`); return r ? r.c : 'n/a'; };
        out(`data       : customers ${count('customers')}, conversations ${count('conversations')}, requests ${count('customer_requests')}, offers ${count('offers')}, users ${count('admin_users')}`);
      } finally { db.close(); }
    }
  }
  const dataDir = path.dirname(file);
  const sessions = dirStats(path.join(dataDir, 'baileys-auth'));
  out(`sessions   : ${sessions ? `${sessions.files} WhatsApp session files in ${path.join(dataDir, 'baileys-auth')}` : 'no WhatsApp session directory on this machine'}`);
  out('');
  out('Remember: this machine\'s database and WhatsApp sessions are its own. Production keeps its own on the server and they are NEVER');
  out('copied here or to GitHub. Never run the same WhatsApp number from two machines. Source code is the only thing that is released');
  out('(see docs/ENVIRONMENTS_AND_RELEASES.md).');
  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
