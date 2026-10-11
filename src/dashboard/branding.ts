import fs from 'node:fs';
import type { Request, Response, Router } from 'express';
import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { getAccount } from '../accounts/accountRepo';
import { getBusinessSettings } from '../config/businessSettings';
import { documentPath, getDocument } from '../documents/documentStore';
import { accessibleAccountIds, isSuperAdmin, type AuthUser } from './permissions';

/**
 * Who is the interface "for"?  Decided here, on the server, from the authenticated user's real account assignments, and nowhere else.
 *
 *   Super Admin                                  -> SynrTech Studio (the developer's administrative experience)
 *   a user granted "all accounts"                -> SynrTech Studio
 *   exactly ONE assigned, existing, enabled account -> that company
 *   several assigned accounts, none, or anything unclear (account missing / disabled, access revoked) -> SynrTech Studio
 *
 * Never from a URL parameter, a header, browser storage or a company id the client sends: the only input is the signed-in user. A company
 * branding carries only what is already visible to that user on their own account (its name, Arabic name and logo); no other company's
 * identity can be produced for them, and the unclear cases resolve to the developer identity instead of a guess.
 */

export interface CompanyBranding {
  accountId: number;
  name: string;
  nameAr: string | null;
  /** Where the browser loads the logo from. null = no verified logo: the interface draws a neutral initial tile, never another company's logo. */
  logoUrl: string | null;
}

export interface BrandingView {
  mode: 'developer' | 'company';
  company: CompanyBranding | null;
}

export const DEVELOPER_BRANDING: BrandingView = { mode: 'developer', company: null };

/** The bundled logo of the original business (account 1). It is public application artwork, served from the dashboard assets as it always was. */
export const LEGACY_ACCOUNT_ID = 1;
export const BUNDLED_LEGACY_LOGO_URL = '/dashboard/assets/logo.webp';
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

interface StoredLogo {
  path: string;
  mime: string;
  version: string;
}

/** The account's own verified logo document: an active image, within the size limit, still present on disk, owned by that account. */
function storedLogo(accountId: number, db: Database.Database): StoredLogo | null {
  try {
    const id = getBusinessSettings(accountId).logoDocumentId;
    if (!id) return null;
    const doc = getDocument(id, db, accountId); // account-scoped: a document id from another business is simply not found
    if (!doc || doc.status !== 'active' || !LOGO_TYPES.has(doc.mime_type) || doc.size_bytes > MAX_LOGO_BYTES) return null;
    const file = documentPath(doc);
    if (!fs.existsSync(file)) return null;
    return { path: file, mime: doc.mime_type, version: `${doc.id}-${String(doc.updated_at ?? doc.created_at).replace(/\D/g, '')}` };
  } catch {
    return null;
  }
}

export function resolveBranding(user: AuthUser | null | undefined, db: Database.Database = getDb()): BrandingView {
  if (!user || user.disabled || isSuperAdmin(user) || user.allAccounts) return DEVELOPER_BRANDING;
  const ids = accessibleAccountIds(user, db);
  if (ids === 'all' || ids.length !== 1) return DEVELOPER_BRANDING;
  const accountId = ids[0]!;
  const account = getAccount(accountId, db);
  if (!account || !account.enabled || !account.name.trim()) return DEVELOPER_BRANDING;
  const logo = storedLogo(accountId, db);
  return {
    mode: 'company',
    company: {
      accountId,
      name: account.name,
      nameAr: account.nameAr?.trim() || null,
      logoUrl: logo ? `/api/dashboard/branding/logo?v=${logo.version}` : accountId === LEGACY_ACCOUNT_ID ? BUNDLED_LEGACY_LOGO_URL : null,
    },
  };
}

/** The logo file of the signed-in user's own company (the one resolveBranding names). Anything else is null. */
export function companyLogoFor(user: AuthUser | null | undefined, db: Database.Database = getDb()): StoredLogo | null {
  const branding = resolveBranding(user, db);
  return branding.company ? storedLogo(branding.company.accountId, db) : null;
}

export function registerBrandingRoutes(router: Router): void {
  // Takes no id: the file is the one that belongs to the signed-in user's own single company, or nothing.
  router.get('/api/dashboard/branding/logo', (req: Request, res: Response) => {
    const logo = companyLogoFor(req.authUser);
    if (!logo) {
      res.status(404).json({ error: 'No logo' });
      return;
    }
    res.setHeader('Content-Type', logo.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(logo.path).on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }).pipe(res);
  });
}
