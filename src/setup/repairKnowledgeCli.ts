import { repairMissingKnowledge } from './repairKnowledge';
import { getAccount } from '../accounts/accountRepo';

/**
 * Operator tool: create the knowledge files a business is missing from its own stored information.
 *
 *   node dist/setup/repairKnowledgeCli.js <accountId> [<accountId> ...]            dry run (default): prints what would be created
 *   node dist/setup/repairKnowledgeCli.js --apply <accountId> [<accountId> ...]    writes the files
 *
 * Files that already hold text are never modified; every account is processed on its own data only. Run on the server that holds the
 * real database and knowledge folder, after taking a backup.
 */
const out = (line: string): void => void process.stdout.write(`${line}\n`);
const err = (line: string): void => void process.stderr.write(`${line}\n`);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const ids = args.filter((a) => a !== '--apply').map((a) => Number.parseInt(a, 10));
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    err('usage: repairKnowledgeCli [--apply] <accountId> [<accountId> ...]');
    process.exit(2);
  }
  for (const id of ids) {
    const account = getAccount(id);
    if (!account) {
      err(`account ${id}: not found`);
      process.exitCode = 1;
      continue;
    }
    const report = await repairMissingKnowledge(id, { dryRun: !apply });
    out(`account ${id} (${account.name}) — ${apply ? 'APPLIED' : 'dry run'}`);
    out(`  ${apply ? 'created' : 'would create'}: ${report.created.map((c) => `${c.file} (${c.bytes} B)`).join(', ') || 'nothing'}`);
    out(`  kept (already has content): ${report.keptExisting.join(', ') || 'none'}`);
    out(`  not derivable from stored data: ${report.notDerivable.join(', ') || 'none'}`);
    if (!apply) for (const [file, text] of Object.entries(report.preview)) out(`\n----- ${file} -----\n${text}`);
  }
}

main().catch((error) => {
  err(`repair failed: ${(error as Error).message}`);
  process.exit(1);
});
