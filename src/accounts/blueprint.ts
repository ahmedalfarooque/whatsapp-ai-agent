import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { createAccount, listAccounts } from './accountRepo';
import { runWithAccount } from './accountContext';
import { saveMenuConfig, type MenuConfig } from '../automation/menuConfig';
import { getTemplate, listTemplates, publishTemplate } from '../templates/templateRepo';
import { setAccountFeature, type AccountFeature } from './accountFeatures';
import { getBusinessSettings } from '../config/businessSettings';
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
  /** Add-on features this business has (switched on before its menu is saved, because the menu may use them). */
  features?: AccountFeature[];
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
      for (const feature of blueprint.features ?? []) setAccountFeature(account.id, feature, true, db);
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

export interface UpgradeOptions {
  actor: string;
  db?: Database.Database;
  /** Rewrite knowledge files that already exist (each is backed up first by the knowledge editor). Missing ones are always written. */
  overwriteKnowledge?: boolean;
  /** Template authors whose text may be replaced: the first provisioning and the seeded defaults. Anything a person edited is left alone. */
  replaceableAuthors?: string[];
  /** Business-profile fields to refresh, each only while its current value still equals one of the listed old values (i.e. nobody changed it). */
  refreshProfile?: Partial<Record<'humanEscalationInfo' | 'fallbackMessage', string[]>>;
}

/**
 * Brings an EXISTING business up to its current blueprint (new menu, new customer texts, add-on features, knowledge) without touching what staff
 * have edited: a template is replaced only while it still carries its original author, a profile field only while it still has its old value.
 * Everything database-related is one transaction. Returns what was done and what was deliberately left alone.
 */
export function upgradeBlueprint(blueprint: BusinessBlueprint, options: UpgradeOptions): ProvisionResult {
  const db = options.db ?? getDb();
  const steps: string[] = [];
  const existing = listAccounts(db).filter((a) => a.name === blueprint.name);
  if (existing.length !== 1) throw new Error(`expected exactly one account named "${blueprint.name}", found ${existing.length}`);
  const accountId = existing[0]!.id;
  const replaceable = new Set(options.replaceableAuthors ?? ['provision script', 'system']);

  db.transaction(() => {
    runWithAccount(accountId, () => {
      for (const feature of blueprint.features ?? []) { setAccountFeature(accountId, feature, true, db); steps.push(`feature "${feature}" enabled`); }
      saveMenuConfig(accountId, blueprint.menu, 'manual', db);
      steps.push(`menu saved: ${blueprint.menu.items.length} main options`);
      listTemplates(db, accountId); // seeds the template set for the new menu (and the add-on's own texts) without touching existing rows
      let published = 0;
      for (const t of blueprint.templates) {
        const current = getTemplate(t.key, db, accountId);
        if (!current) throw new Error(`template ${t.key} does not exist for this menu`);
        if (current.updatedBy && !replaceable.has(current.updatedBy)) { steps.push(`template ${t.key}: edited by "${current.updatedBy}" — left as it is`); continue; }
        publishTemplate(t.key, { ar: t.ar, en: t.en }, options.actor, db, accountId);
        published += 1;
      }
      steps.push(`${published} reply template(s) published`);
      const settings = getBusinessSettings(accountId);
      const patch: BlueprintProfile = {};
      for (const [field, oldValues] of Object.entries(options.refreshProfile ?? {}) as ['humanEscalationInfo' | 'fallbackMessage', string[]][]) {
        const now = settings[field] ?? '';
        const next = blueprint.profile[field];
        if (next && now !== next && (oldValues.includes(now) || !now)) { (patch as Record<string, unknown>)[field] = next; steps.push(`profile ${field} refreshed`); }
        else if (next && now !== next) steps.push(`profile ${field}: changed by staff — left as it is`);
      }
      if (Object.keys(patch).length > 0) updateBusinessSettings(patch, accountId);
    });
  })();

  const dir = knowledgeDirForAccount(accountId);
  for (const name of EDITABLE_KNOWLEDGE_FILES) {
    const content = blueprint.knowledge[name];
    if (content === undefined) continue;
    const present = fs.existsSync(path.join(dir, name));
    if (present && !options.overwriteKnowledge) { steps.push(`knowledge/${name} exists — kept (overwrite not requested)`); continue; }
    const { backedUpAs } = writeKnowledgeFile(name, content, accountId);
    steps.push(`knowledge/${name} ${present ? `rewritten (previous copy: ${backedUpAs ?? 'none'})` : 'written'}`);
  }
  return { accountId, created: false, steps };
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
