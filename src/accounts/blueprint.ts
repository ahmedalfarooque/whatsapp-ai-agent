import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { createAccount, listAccounts } from './accountRepo';
import { runWithAccount } from './accountContext';
import { saveMenuConfig, type MenuConfig } from '../automation/menuConfig';
import { listTemplates, publishTemplate } from '../templates/templateRepo';
import type { z } from 'zod';
import { updateBusinessSettings, type businessSettingsInputSchema } from '../config/businessSettings';
import { createLink, listLinks, type LinkKind } from '../setup/linksRepo';
import { saveDocument } from '../documents/documentStore';
import { EDITABLE_KNOWLEDGE_FILES, knowledgeDirForAccount, writeKnowledgeFile, type EditableKnowledgeFile } from '../dashboard/knowledgeAdmin';

/**
 * A whole new business described as data: who it is, its WhatsApp menu, the words customers receive and what the AI
 * assistant may know. `provisionBlueprint` turns it into a normal WhatsApp account with the application's own functions
 * (the same ones the dashboard uses), so the result is indistinguishable from a business set up by hand and is
 * scoped to its own account id from the first write. No account id, name or business fact is hard-coded here.
 *
 * The WhatsApp number is NEVER part of a blueprint: the account is created as an unpaired QR account (status "idle",
 * no phone number, no JID, its own empty Baileys auth directory) and only becomes connected when someone scans the QR code.
 */

/** The business-profile fields as the dashboard accepts them (before validation). */
export type BlueprintProfile = z.input<typeof businessSettingsInputSchema>;

export interface BlueprintTemplate {
  key: string;
  ar: string;
  en: string;
}

export interface BusinessBlueprint {
  /** Exact, unique account name; also how an existing account is recognised, so re-running changes nothing. */
  name: string;
  nameAr: string;
  businessCategory: string;
  /** Business profile fields (validated by the same schema as the dashboard). Never the WhatsApp number or a staff number. */
  profile: BlueprintProfile;
  links: { url: string; kind: LinkKind; label: string }[];
  menu: MenuConfig;
  /** Customised customer-facing texts, published live. Every key must exist for this menu. */
  templates: BlueprintTemplate[];
  knowledge: Partial<Record<EditableKnowledgeFile, string>>;
}

export interface ProvisionOptions {
  /** Recorded as the author of the published templates and uploaded files. */
  actor: string;
  /** A logo image on disk (stored in the account's own uploads, never in Git). */
  logo?: { path: string; originalName?: string; mimeType?: string };
  db?: Database.Database;
}

export interface ProvisionResult {
  accountId: number;
  created: boolean;
  steps: string[];
}

const LOGO_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/**
 * Creates the business if it does not exist yet. For an account that already exists it never overwrites anything a person may
 * have edited since (profile, menu, templates): it only writes knowledge files that are missing. Everything database-related
 * happens in one transaction, so a failure leaves no half-built account.
 */
export function provisionBlueprint(blueprint: BusinessBlueprint, options: ProvisionOptions): ProvisionResult {
  const db = options.db ?? getDb();
  const steps: string[] = [];
  const existing = listAccounts(db).filter((a) => a.name === blueprint.name);
  if (existing.length > 1) throw new Error(`more than one account is named "${blueprint.name}" — refusing to guess which one to use`);

  if (existing.length === 1) {
    const accountId = existing[0]!.id;
    steps.push(`account ${accountId} "${blueprint.name}" already exists — profile, menu and templates left exactly as they are`);
    steps.push(...writeMissingKnowledge(blueprint, accountId));
    return { accountId, created: false, steps };
  }

  const logoBytes = options.logo ? readLogo(options.logo.path) : null;

  const accountId = db.transaction(() => {
    const account = createAccount({ name: blueprint.name, nameAr: blueprint.nameAr, businessCategory: blueprint.businessCategory, connectionMethod: 'qr' }, db);
    steps.push(`account ${account.id} created (QR connection, status ${account.status}, no phone number)`);
    runWithAccount(account.id, () => {
      saveMenuConfig(account.id, blueprint.menu, 'manual', db);
      steps.push(`menu saved: ${blueprint.menu.items.length} main options`);

      // Seeds the account's own template set from the menu just saved, then publishes the customised texts over it.
      listTemplates(db, account.id);
      for (const t of blueprint.templates) publishTemplate(t.key, { ar: t.ar, en: t.en }, options.actor, db, account.id);
      steps.push(`${blueprint.templates.length} reply templates published (Arabic and English)`);

      for (const link of blueprint.links) {
        if (listLinks(account.id, db).some((l) => l.url.replace(/\/$/, '') === link.url.replace(/\/$/, ''))) continue;
        createLink({ url: link.url, kind: link.kind, label: link.label }, account.id, db);
      }
      steps.push(`${blueprint.links.length} link(s) recorded`);

      const patch: BlueprintProfile = { ...blueprint.profile };
      if (logoBytes && options.logo) {
        const originalName = options.logo.originalName ?? path.basename(options.logo.path);
        const mimeType = options.logo.mimeType ?? LOGO_MIME[path.extname(originalName).toLowerCase()] ?? 'application/octet-stream';
        const logo = saveDocument({ originalName, mimeType, bytes: logoBytes, visibility: 'internal', title: `${blueprint.name} logo`, uploadedBy: options.actor, accountId: account.id, purpose: 'logo' }, db);
        patch.logoDocumentId = logo.id;
        steps.push(`logo stored in the account's own uploads (document ${logo.id}, internal, ${logo.size_bytes} bytes)`);
      }
      updateBusinessSettings(patch, account.id);
      steps.push('business profile saved');
    });
    return account.id;
  })();

  steps.push(...writeMissingKnowledge(blueprint, accountId));
  return { accountId, created: true, steps };
}

function readLogo(file: string): Buffer {
  if (!fs.existsSync(file)) throw new Error(`logo file not found: ${file}`);
  return fs.readFileSync(file);
}

function writeMissingKnowledge(blueprint: BusinessBlueprint, accountId: number): string[] {
  const dir = knowledgeDirForAccount(accountId);
  const out: string[] = [];
  for (const name of EDITABLE_KNOWLEDGE_FILES) {
    const content = blueprint.knowledge[name];
    if (content === undefined) continue;
    if (fs.existsSync(path.join(dir, name))) {
      out.push(`knowledge/${name} already exists — kept`);
      continue;
    }
    writeKnowledgeFile(name, content, accountId);
    out.push(`knowledge/${name} written (${Buffer.byteLength(content, 'utf-8')} bytes)`);
  }
  return out;
}
