/**
 * One-time, idempotent creation of a NEW WhatsApp business account from a blueprint (src/accounts/blueprints/<name>.ts).
 *
 * The account is created unpaired: connection method QR, status "idle", no phone number, its own empty Baileys auth directory.
 * It becomes connected only when someone scans its QR code in the dashboard. No existing account, session, setting, template,
 * menu, offer or customer is read or changed; running it again does nothing (an existing account is only topped up with
 * knowledge files that are missing, never overwritten).
 *
 * Usage (from the application directory, uses DATABASE_PATH from .env):
 *   npx tsx scripts/provisionAccount.ts --blueprint qmulate [--logo <image file>] [--dry-run]
 */
/* eslint-disable no-console */
import { getDb, closeDb } from '../src/memory/db';
import { listAccounts } from '../src/accounts/accountRepo';
import { provisionBlueprint, type BusinessBlueprint } from '../src/accounts/blueprint';
import { QMULATE_BLUEPRINT } from '../src/accounts/blueprints/qmulate';

const BLUEPRINTS: Record<string, BusinessBlueprint> = { qmulate: QMULATE_BLUEPRINT };

function fail(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const known = new Set(['--blueprint', '--logo', '--dry-run']);
  for (const a of argv) if (a.startsWith('--') && !known.has(a)) fail(`unknown option ${a}`);
  const blueprintName = get('--blueprint');
  const blueprint = blueprintName ? BLUEPRINTS[blueprintName] : undefined;
  if (!blueprint) fail(`--blueprint <${Object.keys(BLUEPRINTS).join('|')}> is required`);

  const db = getDb();
  const before = listAccounts(db);
  console.log(`accounts before: ${before.map((a) => `${a.id}="${a.name}"`).join(', ')}`);
  if (argv.includes('--dry-run')) {
    const exists = before.some((a) => a.name === blueprint.name);
    console.log(`DRY RUN — "${blueprint.name}" ${exists ? 'already exists: nothing would change' : 'would be created as a new unpaired QR account'}`);
    return;
  }

  const logoPath = get('--logo');
  const result = provisionBlueprint(blueprint, { actor: 'provision script', logo: logoPath ? { path: logoPath } : undefined, db });
  for (const step of result.steps) console.log(`- ${step}`);
  const after = listAccounts(db);
  const account = after.find((a) => a.id === result.accountId)!;
  console.log(`${result.created ? 'CREATED' : 'ALREADY PRESENT'}: account ${account.id} "${account.name}" — method ${account.connectionMethod}, status ${account.status}, phone ${account.phoneNumber ?? 'none'}, auth dir ${account.authDir}`);
  console.log(`accounts after: ${after.map((a) => `${a.id}="${a.name}"`).join(', ')}`);
}

try {
  main();
} catch (error) {
  console.error(`FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
