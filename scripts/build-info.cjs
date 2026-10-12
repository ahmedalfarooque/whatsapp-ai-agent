#!/usr/bin/env node
/**
 * Stamps THIS checkout's dashboard with its own commit so the footer (and, off production, the banner) can say what is running:
 *
 *   node scripts/build-info.cjs            writes dashboard/build-info.json  (environment: "local-isolated")
 *   node scripts/build-info.cjs --print    prints it and writes nothing
 *
 * For a local backend with its own database (`npm start`). The file is ignored by Git and is never part of a release; the production release script writes its own stamp
 * on the server, and scripts/dev-proxy.cjs serves its own. Reads only `git` and writes only that one file. No secrets, no data.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const git = (...args) => { try { return cp.execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

function buildInfo() {
  const fullCommit = git('rev-parse', 'HEAD');
  return {
    commit: fullCommit.slice(0, 7), fullCommit, branch: git('branch', '--show-current') || 'detached',
    uncommittedChanges: git('status', '--porcelain', '--untracked-files=no').length > 0,
    environment: 'local-isolated', dataSource: 'local-database', generatedAt: new Date().toISOString(),
  };
}

if (require.main === module) {
  const info = buildInfo();
  if (!/^[0-9a-f]{40}$/.test(info.fullCommit)) { console.error('not a git checkout with a commit'); process.exit(1); }
  if (process.argv.includes('--print')) console.log(JSON.stringify(info, null, 2));
  else {
    fs.writeFileSync(path.join(ROOT, 'dashboard', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
    console.log(`stamped dashboard/build-info.json: ${info.commit} (${info.branch})${info.uncommittedChanges ? ' + uncommitted changes' : ''}`);
  }
}
module.exports = { buildInfo };
