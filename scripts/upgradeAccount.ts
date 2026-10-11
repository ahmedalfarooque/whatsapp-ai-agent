/**
 * Brings an EXISTING business up to the current version of its blueprint (src/accounts/blueprints/<name>.ts): its add-on features, WhatsApp
 * menu, customer texts and knowledge files. Nothing staff edited is overwritten (see upgradeBlueprint), no other account is touched, no session or
 * pairing is started, and a dry run (the default) changes nothing and only reports.
 *
 * Usage (from the application directory, uses DATABASE_PATH from .env — point DATABASE_PATH at a COPY first):
 *   npx tsx scripts/upgradeAccount.ts --blueprint qmulate [--apply] [--overwrite-knowledge]
 */
/* eslint-disable no-console */
import fs from 'node:fs';
import { getDb, closeDb } from '../src/memory/db';
import { listAccounts } from '../src/accounts/accountRepo';
import { upgradeBlueprint, type BusinessBlueprint } from '../src/accounts/blueprint';
import { QMULATE_BLUEPRINT } from '../src/accounts/blueprints/qmulate';
import { knowledgeDirForAccount } from '../src/dashboard/knowledgeAdmin';

const BLUEPRINTS: Record<string, BusinessBlueprint> = { qmulate: QMULATE_BLUEPRINT };
/** The texts the first version of the QMULATE blueprint stored: a profile field still holding one of them was never changed by staff. */
const OLD_PROFILE: Record<string, { humanEscalationInfo: string[]; fallbackMessage: string[] }> = {
  qmulate: {
    humanEscalationInfo: ['Complex, sensitive or urgent matters are handled by the QMULATE team. The customer can choose option 9 (Talk to Our Team) or write "agent". The team typically responds within one business day.'],
    fallbackMessage: ['Thank you for contacting QMULATE. Please choose an option from the menu (write "menu"), or write "agent" to reach our team.'],
  },
};

function fail(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const known = new Set(['--blueprint', '--apply', '--overwrite-knowledge']);
  for (const a of argv) if (a.startsWith('--') && !known.has(a)) fail(`unknown option ${a}`);
  const name = argv[argv.indexOf('--blueprint') + 1];
  const blueprint = name ? BLUEPRINTS[name] : undefined;
  if (!blueprint || !name) fail(`--blueprint <${Object.keys(BLUEPRINTS).join('|')}> is required`);

  const db = getDb();
  const account = listAccounts(db).filter((a) => a.name === blueprint.name);
  if (account.length !== 1) fail(`expected exactly one account named "${blueprint.name}", found ${account.length}`);
  const id = account[0]!.id;
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE whatsapp_account_id = ?`).get(id) as { n: number }).n;
  const tables = ['customers', 'conversations', 'customer_requests', 'reply_templates'];
  const before = Object.fromEntries(tables.map((t) => [t, count(t)]));
  const otherBefore = db.prepare('SELECT whatsapp_account_id AS a, COUNT(*) AS n FROM reply_templates WHERE whatsapp_account_id <> ? GROUP BY a ORDER BY a').all(id);
  const menuBefore = (db.prepare('SELECT config_json FROM account_menus WHERE whatsapp_account_id <> ? ORDER BY whatsapp_account_id').all(id) as { config_json: string }[]).map((r) => r.config_json.length);
  console.log(`account ${id} "${blueprint.name}": ${JSON.stringify(before)}`);
  console.log(`knowledge dir: ${knowledgeDirForAccount(id)} (${fs.existsSync(knowledgeDirForAccount(id)) ? fs.readdirSync(knowledgeDirForAccount(id)).filter((f) => !f.startsWith('.')).join(', ') : 'missing'})`);
  if (!argv.includes('--apply')) {
    console.log('DRY RUN — nothing was changed. Add --apply to upgrade (and --overwrite-knowledge to rewrite the existing knowledge files, each backed up first).');
    closeDb();
    return;
  }

  const result = upgradeBlueprint(blueprint, { actor: 'upgrade script', db, overwriteKnowledge: argv.includes('--overwrite-knowledge'), refreshProfile: OLD_PROFILE[name] });
  for (const step of result.steps) console.log(`- ${step}`);
  const after = Object.fromEntries(tables.map((t) => [t, count(t)]));
  const otherAfter = db.prepare('SELECT whatsapp_account_id AS a, COUNT(*) AS n FROM reply_templates WHERE whatsapp_account_id <> ? GROUP BY a ORDER BY a').all(id);
  const menuAfter = (db.prepare('SELECT config_json FROM account_menus WHERE whatsapp_account_id <> ? ORDER BY whatsapp_account_id').all(id) as { config_json: string }[]).map((r) => r.config_json.length);
  console.log(`after: ${JSON.stringify(after)}`);
  console.log(`other accounts' template counts unchanged: ${JSON.stringify(otherBefore) === JSON.stringify(otherAfter)}; their menus unchanged: ${JSON.stringify(menuBefore) === JSON.stringify(menuAfter)}`);
  closeDb();
}

main();
