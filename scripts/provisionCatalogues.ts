/**
 * One-time, idempotent provisioning of the catalogue library for ONE business.
 *
 * It switches the "catalogues" feature on for the named account, adds the catalogue PDFs, inserts the catalogue entry
 * into that business's WhatsApp menu, records the official web pages the assistant may search, and (optionally) sets the
 * business's Google Maps link and location note. Everything goes through the application's own functions and is scoped to
 * the one account. It REFUSES to run for the original business (account 1) and unless the account's name matches exactly.
 *
 * Usage (from the application directory, uses DATABASE_PATH from .env):
 *   npx tsx scripts/provisionCatalogues.ts --account 2 --expect-name "JOTUN Rowad Alfa" [--dry-run] \
 *     [--register "<documentId>|<title>"]...        add an already-stored PDF document of that business as a catalogue
 *     [--upload "<file.pdf>|<title>|<original name>"]...  add a new catalogue from a file on disk
 *     [--link "<url>|<label>"]...                    official page the assistant may search (read now)
 *     [--maps-url <url>] [--notes-en <text>] [--notes-ar <text>]
 *     [--menu-label-en <text>] [--menu-label-ar <text>]
 *
 * Nothing is deleted or overwritten: existing catalogues, links, settings and a menu that already has the entry are kept.
 */
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { getDb, closeDb } from '../src/memory/db';
import { getAccount } from '../src/accounts/accountRepo';
import { LEGACY_ACCOUNT_ID, runWithAccount } from '../src/accounts/accountContext';
import { FEATURES, accountHasFeature, setAccountFeature } from '../src/accounts/accountFeatures';
import { listCatalogues, registerExistingDocument, uploadCatalogue } from '../src/catalogues/catalogueRepo';
import { getMenuConfig, saveMenuConfig, MAX_MENU_ITEMS, type MenuConfig, type MenuItem } from '../src/automation/menuConfig';
import { createLink, listLinks, recordFetchResult } from '../src/setup/linksRepo';
import { fetchLinkContent } from '../src/setup/linkFetcher';
import { updateBusinessSettings } from '../src/config/businessSettings';
import { listTemplates } from '../src/templates/templateRepo';

interface Args {
  single: Record<string, string>;
  multi: Record<string, string[]>;
  flags: Set<string>;
}

const MULTI = new Set(['register', 'upload', 'link']);
const FLAGS = new Set(['dry-run']);

function parse(argv: string[]): Args {
  const out: Args = { single: {}, multi: {}, flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (FLAGS.has(name)) { out.flags.add(name); continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    i += 1;
    if (MULTI.has(name)) (out.multi[name] ??= []).push(value);
    else out.single[name] = value;
  }
  return out;
}

function fail(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

function withCatalogueEntry(config: MenuConfig, labelEn: string, labelAr: string): MenuConfig | null {
  if (config.items.some((i) => i.kind === 'catalogues')) return null; // already there
  if (config.items.length >= MAX_MENU_ITEMS) fail(`the menu already has ${MAX_MENU_ITEMS} entries; remove one in the dashboard first`);
  const entry: MenuItem = { id: 'catalogues', kind: 'catalogues', labelEn, labelAr };
  const at = config.items.findIndex((i) => i.id === 'offerings');
  const items = [...config.items];
  items.splice(at >= 0 ? at + 1 : Math.max(0, items.findIndex((i) => i.kind === 'handoff')), 0, entry);
  return { version: 1, items };
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const accountId = Number.parseInt(args.single.account ?? '', 10);
  const expectName = args.single['expect-name'];
  if (!Number.isInteger(accountId) || accountId <= 0) fail('--account <id> is required');
  if (!expectName) fail('--expect-name "<exact business name>" is required');
  if (accountId === LEGACY_ACCOUNT_ID) fail('account 1 (the original business) never gets the catalogue library');

  const db = getDb();
  const account = getAccount(accountId);
  if (!account) fail(`WhatsApp account ${accountId} does not exist`);
  if (account.name !== expectName) fail(`account ${accountId} is named "${account.name}", not "${expectName}"`);

  const dry = args.flags.has('dry-run');
  const registers = (args.multi.register ?? []).map((v) => v.split('|'));
  const uploads = (args.multi.upload ?? []).map((v) => v.split('|'));
  const links = (args.multi.link ?? []).map((v) => v.split('|'));
  const labelEn = args.single['menu-label-en'] ?? '📚 Jotun Catalogues';
  const labelAr = args.single['menu-label-ar'] ?? '📚 كتالوجات جوتن';

  console.log(`${dry ? 'DRY RUN — ' : ''}account ${accountId} "${account.name}": feature=${accountHasFeature(accountId, FEATURES.CATALOGUES)}, catalogues now=${listCatalogues(accountId).length}`);
  console.log(`plan: register ${registers.length}, upload ${uploads.length}, links ${links.length}, maps=${args.single['maps-url'] ? 'set' : 'keep'}, notes=${args.single['notes-en'] || args.single['notes-ar'] ? 'set' : 'keep'}, menu entry "${labelEn}"`);
  if (dry) return;

  await runWithAccount(accountId, async () => {
    setAccountFeature(accountId, FEATURES.CATALOGUES, true, db);

    const known = new Set(listCatalogues(accountId, db).map((c) => c.title));
    for (const [idText, title] of registers) {
      const c = await registerExistingDocument(accountId, Number.parseInt(idText ?? '', 10), title ?? '', db);
      console.log(`catalogue (existing document ${idText}): "${c.title}" ${c.pageCount} pages, text ${c.hasText ? 'readable' : 'NOT readable'}`);
      known.add(c.title);
    }
    for (const [file, title, originalName] of uploads) {
      if (!file || !fs.existsSync(file)) fail(`file not found: ${file}`);
      if (title && known.has(title)) { console.log(`catalogue "${title}" already present — skipped`); continue; }
      try {
        const c = await uploadCatalogue({ originalName: originalName || path.basename(file), mimeType: 'application/pdf', bytes: fs.readFileSync(file), title: title ?? null, uploadedBy: 'provision script' }, accountId, db);
        console.log(`catalogue (uploaded): "${c.title}" ${c.pageCount} pages, ${c.sizeBytes} bytes, text ${c.hasText ? 'readable' : 'NOT readable'}`);
      } catch (error) {
        if ((error as { status?: number }).status === 409) console.log(`"${title}" is already in the library — skipped (${(error as Error).message})`);
        else throw error;
      }
    }

    const stored = getMenuConfig(accountId, db);
    const next = withCatalogueEntry(stored.config, labelEn, labelAr);
    if (next) { saveMenuConfig(accountId, next, 'manual', db); console.log(`menu: added "${labelEn}" as entry ${next.items.findIndex((i) => i.kind === 'catalogues') + 1} of ${next.items.length}`); }
    else console.log('menu: already has the catalogue entry — kept');

    const existing = new Map(listLinks(accountId).map((l) => [l.url, l.id]));
    for (const [url, label] of links) {
      if (!url) continue;
      let id = existing.get(url);
      if (id === undefined) id = createLink({ url, kind: 'website', label: label ?? null }, accountId, db).id;
      const page = await fetchLinkContent(url);
      recordFetchResult(id, { ok: page.ok, httpStatus: page.httpStatus, error: page.error, title: page.title, text: page.text, sha256: page.sha256 }, accountId, db);
      console.log(`link: ${page.ok ? 'read' : 'UNAVAILABLE'} ${page.text.length} chars — ${url}`);
    }

    const patch: Record<string, string> = {};
    if (args.single['maps-url']) patch.googleMapsUrl = args.single['maps-url'];
    if (args.single['notes-en']) patch.locationNotesEn = args.single['notes-en'];
    if (args.single['notes-ar']) patch.locationNotesAr = args.single['notes-ar'];
    if (Object.keys(patch).length) { updateBusinessSettings(patch, accountId); console.log(`settings: updated ${Object.keys(patch).join(', ')}`); }

    const keys = listTemplates(db, accountId).map((t) => t.key).filter((k) => k.startsWith('catalogue'));
    console.log(`reply templates ready: ${keys.join(', ')}`);
  });
  console.log(`done: ${listCatalogues(accountId, db).map((c) => `${c.sortOrder + 1}. ${c.title}${c.enabled ? '' : ' (disabled)'}`).join(' | ')}`);
}

main()
  .catch((error) => { console.error(`FAILED: ${(error as Error).message}`); process.exitCode = 1; })
  .finally(() => closeDb());
