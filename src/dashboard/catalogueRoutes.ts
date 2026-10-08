import express, { type Request, type Response, type Router } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import { logger } from '../logger';
import { assertAccountAccess } from './accountMiddleware';
import { runWithAccount } from '../accounts/accountContext';
import { getDocument, documentPath } from '../documents/documentStore';
import {
  CatalogueError, MAX_CATALOGUE_BYTES, MAX_CATALOGUE_TITLE, cataloguesEnabledFor, deleteCatalogue, getCatalogue, listCatalogues, moveCatalogue,
  renameCatalogue, renderCustomerCatalogues, replaceCatalogueFile, reorderCatalogues, setCatalogueEnabled, uploadCatalogue, type Catalogue,
} from '../catalogues/catalogueRepo';
import { resolveTemplate } from '../templates/templateRepo';

/**
 * Catalogue management for ONE business (the "Catalogues" tab of its setup page). Every route names the account in its
 * path, is authorised against it, and then requires the business to actually have the catalogue library — for any
 * other account (including the original business) the answer is a plain 404, as if the feature did not exist.
 */

const rawUpload = express.raw({ type: () => true, limit: MAX_CATALOGUE_BYTES + 1024 });

function view(accountId: number, c: Catalogue) {
  return {
    id: c.id, title: c.title, originalName: c.originalName, sizeBytes: c.sizeBytes, pageCount: c.pageCount, enabled: c.enabled, sortOrder: c.sortOrder,
    hasText: c.hasText, textLength: c.textLength, uploadedAt: c.uploadedAt, updatedAt: c.updatedAt,
    fileUrl: `/api/dashboard/accounts/${accountId}/catalogues/${c.id}/file`,
  };
}

export function registerCatalogueRoutes(router: Router, actor: (req: Request) => string): void {
  const base = '/api/dashboard/accounts/:id/catalogues';
  const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many uploads. Please wait a minute and try again.', code: 'rate_limited' } });

  /** The account of the path, only if the admin may see it AND it has the catalogue library. */
  function accountOf(req: Request, res: Response): number | null {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!assertAccountAccess(req, res, id)) return null;
    if (!cataloguesEnabledFor(id)) {
      res.status(404).json({ error: 'The catalogue library is not enabled for this business' });
      return null;
    }
    return id;
  }

  function fail(res: Response, error: unknown): void {
    if (error instanceof CatalogueError) { res.status(error.status).json({ error: error.message }); return; }
    if ((error as { type?: string })?.type === 'entity.too.large') { res.status(413).json({ error: `The file is larger than ${MAX_CATALOGUE_BYTES / 1024 / 1024} MB` }); return; }
    logger.error({ error }, 'catalogue operation failed');
    res.status(500).json({ error: 'Operation failed' });
  }

  const cid = (req: Request): number => Number.parseInt(String(req.params.cid), 10);
  const header = (req: Request, name: string): string | null => {
    const v = req.header(name);
    if (!v) return null;
    try { return decodeURIComponent(String(v)); } catch { return null; }
  };

  router.get(base, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      runWithAccount(id, () => {
        const items = listCatalogues(id);
        let en = renderCustomerCatalogues('en', id);
        let ar = renderCustomerCatalogues('ar', id);
        try { en = resolveTemplate('catalogues_list', 'en'); ar = resolveTemplate('catalogues_list', 'ar'); } catch { /* the plain list is still a fair preview */ }
        res.json({
          catalogues: items.map((c) => view(id, c)),
          enabledCount: items.filter((c) => c.enabled).length,
          limits: { maxBytes: MAX_CATALOGUE_BYTES, maxTitle: MAX_CATALOGUE_TITLE, accept: ['application/pdf'] },
          customerPreview: { en, ar },
        });
      });
    } catch (error) { fail(res, error); }
  });

  router.post(base, uploadLimiter, rawUpload, async (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const created = await uploadCatalogue(
        { originalName: header(req, 'x-file-name') ?? 'catalogue.pdf', mimeType: String(req.header('content-type') ?? ''), bytes, title: header(req, 'x-title'), uploadedBy: actor(req) },
        id,
      );
      res.status(201).json(view(id, created));
    } catch (error) { fail(res, error); }
  });

  router.put(`${base}/order`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const ids = Array.isArray((req.body as { ids?: unknown })?.ids) ? ((req.body as { ids: unknown[] }).ids).map((n) => Number(n)) : [];
      res.json({ catalogues: reorderCatalogues(ids, id).map((c) => view(id, c)) });
    } catch (error) { fail(res, error); }
  });

  router.patch(`${base}/:cid`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const body = (req.body ?? {}) as { title?: unknown; enabled?: unknown };
      if (body.title === undefined && body.enabled === undefined) throw new CatalogueError('Nothing to change');
      let updated = getCatalogue(cid(req), id);
      if (!updated) throw new CatalogueError('Catalogue not found', 404);
      if (body.title !== undefined) updated = renameCatalogue(cid(req), body.title, id);
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') throw new CatalogueError('enabled must be true or false');
        updated = setCatalogueEnabled(cid(req), body.enabled, id);
      }
      res.json(view(id, updated));
    } catch (error) { fail(res, error); }
  });

  router.post(`${base}/:cid/move`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const direction = (req.body as { direction?: unknown })?.direction;
      if (direction !== 'up' && direction !== 'down') throw new CatalogueError('direction must be "up" or "down"');
      res.json({ catalogues: moveCatalogue(cid(req), direction, id).map((c) => view(id, c)) });
    } catch (error) { fail(res, error); }
  });

  router.put(`${base}/:cid/file`, uploadLimiter, rawUpload, async (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const updated = await replaceCatalogueFile(cid(req), { originalName: header(req, 'x-file-name') ?? 'catalogue.pdf', mimeType: String(req.header('content-type') ?? ''), bytes }, id);
      res.json(view(id, updated));
    } catch (error) { fail(res, error); }
  });

  router.delete(`${base}/:cid`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      deleteCatalogue(cid(req), id);
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });

  router.get(`${base}/:cid/file`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const item = getCatalogue(cid(req), id);
      const doc = item ? getDocument(item.documentId, undefined, id) : undefined;
      if (!item || !doc) { res.status(404).json({ error: 'Catalogue not found' }); return; }
      const file = documentPath(doc);
      if (!fs.existsSync(file)) { res.status(404).json({ error: 'The stored file is missing' }); return; }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(doc.original_name)}"`);
      res.sendFile(file); // the original bytes, exactly as uploaded
    } catch (error) { fail(res, error); }
  });
}
