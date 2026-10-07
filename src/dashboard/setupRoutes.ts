import express, { type Request, type Response, type Router } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from '../logger';
import { env } from '../config/env';
import { getEffectiveCredential } from '../config/effectiveConfig';
import { assertAccountAccess } from './accountMiddleware';
import { runWithAccount, LEGACY_ACCOUNT_ID } from '../accounts/accountContext';
import { getAccount, AccountValidationError } from '../accounts/accountRepo';
import { AccountDeletionError, deleteAccount, describeDeletion } from '../accounts/accountDeletion';
import {
  BusinessSettingsValidationError, getBusinessSettings, getBusinessSettingsOverrides, updateBusinessSettings, formatBusinessHours, formatAddress,
} from '../config/businessSettings';
import {
  DOCUMENT_PURPOSES, DocumentValidationError, MAX_DOCUMENT_BYTES, ALLOWED_TYPES, deleteDocument, documentPath, extractDocumentText, getDocument,
  listDocuments, saveDocument, serveContentType, updateDocument, type BusinessDocument, type DocumentStatus, type DocumentVisibility,
} from '../documents/documentStore';
import {
  LINK_KINDS, LinkValidationError, createLink, deleteLink, getLink, listLinks, recordFetchResult, updateLink, MAX_LINKS_PER_ACCOUNT,
} from '../setup/linksRepo';
import { fetchLinkContent } from '../setup/linkFetcher';
import { generateDraftContent } from '../setup/generator';
import { sourceSummary } from '../setup/sources';
import {
  DraftStateError, createDraft, discardDraft, getDraft, latestDraft, listDraftSummaries, updateDraftContent,
} from '../setup/draftRepo';
import { ApplyError, applyDraft, APPLY_SECTIONS, type ApplyMode, type ApplySection } from '../setup/applyDraft';
import { DraftValidationError } from '../setup/types';
import {
  MenuValidationError, getMenuConfig, renderMainMenuText, resetMenuConfig, saveMenuConfig, MAX_MENU_ITEMS, MENU_ITEM_KINDS,
} from '../automation/menuConfig';
import { ensureTemplateDefaults, getTemplate, publishTemplate } from '../templates/templateRepo';
import { getDb } from '../memory/db';
import { invalidateAccountKnowledge, discardConnection } from '../whatsapp/qrConnection';

/**
 * Business setup endpoints. Every route names the account in its path and is
 * authorised against it (404 unknown / 403 not permitted); the handler then
 * runs inside that account's context and passes the id explicitly, so nothing
 * here can read or write another business.
 */

const rawUpload = express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES + 1024 });

function aiStatus(): { available: boolean; mode: 'live' | 'mock' | 'unconfigured' } {
  if (env.shouldUseMockProviders) return { available: false, mode: 'mock' };
  try {
    getEffectiveCredential('OPENROUTER_API_KEY');
    return { available: true, mode: 'live' };
  } catch {
    return { available: false, mode: 'unconfigured' };
  }
}

function fileView(d: BusinessDocument, accountId: number) {
  const isImage = ['png', 'jpg', 'jpeg', 'webp'].includes(d.extension);
  const { stored_name: _hidden, extracted_text, ...rest } = d;
  return {
    ...rest,
    kind: isImage ? 'image' : 'document',
    hasExtractedText: Boolean(extracted_text),
    textLength: extracted_text ? extracted_text.length : 0,
    fileUrl: `/api/dashboard/accounts/${accountId}/setup/files/${d.id}/file`,
  };
}

export function registerSetupRoutes(router: Router, actor: (req: Request) => string): void {
  const base = '/api/dashboard/accounts/:id';
  const fetchLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const generateLimiter = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: true, legacyHeaders: false });
  const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

  function accountOf(req: Request, res: Response): number | null {
    const id = Number.parseInt(String(req.params.id), 10);
    return assertAccountAccess(req, res, id) ? id : null;
  }

  function fail(res: Response, error: unknown): void {
    if (error instanceof BusinessSettingsValidationError || error instanceof AccountValidationError) { res.status(error.status).json({ error: 'validation_failed', fields: error.fields }); return; }
    if (error instanceof AccountDeletionError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    if (error instanceof LinkValidationError || error instanceof DocumentValidationError || error instanceof MenuValidationError || error instanceof DraftValidationError || error instanceof DraftStateError || error instanceof ApplyError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if ((error as { type?: string })?.type === 'entity.too.large') { res.status(413).json({ error: `File exceeds ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB` }); return; }
    logger.error({ error }, 'business setup operation failed');
    res.status(500).json({ error: 'Operation failed' });
  }

  function menuView(accountId: number) {
    const stored = getMenuConfig(accountId);
    return {
      builtIn: accountId === LEGACY_ACCOUNT_ID,
      source: stored.source,
      updatedAt: stored.updatedAt,
      config: accountId === LEGACY_ACCOUNT_ID ? null : stored.config,
      limits: { maxItems: MAX_MENU_ITEMS, kinds: MENU_ITEM_KINDS },
      mainMenuText: accountId === LEGACY_ACCOUNT_ID ? null : { en: renderMainMenuText(stored.config, 'en'), ar: renderMainMenuText(stored.config, 'ar') },
    };
  }

  function profileView(accountId: number) {
    const settings = getBusinessSettings(accountId);
    return {
      settings,
      overrides: getBusinessSettingsOverrides(accountId),
      rendered: { hoursEn: formatBusinessHours(settings, 'en'), hoursAr: formatBusinessHours(settings, 'ar'), addressEn: formatAddress(settings, 'en'), addressAr: formatAddress(settings, 'ar') },
    };
  }

  function draftView(draft: ReturnType<typeof getDraft>) {
    if (!draft) return null;
    return { id: draft.id, status: draft.status, generator: draft.generator, model: draft.model, sources: draft.sources, content: draft.content, warnings: draft.warnings, apply: draft.apply, createdAt: draft.createdAt, updatedAt: draft.updatedAt, appliedAt: draft.appliedAt };
  }

  // ---- overview -------------------------------------------------------------------
  router.get(`${base}/setup`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      runWithAccount(id, () => {
        const account = getAccount(id)!;
        const files = listDocuments({ accountId: id }).map((d) => fileView(d, id));
        res.json({
          account: { id, name: account.name, nameAr: account.nameAr, businessCategory: account.businessCategory, isLegacy: id === LEGACY_ACCOUNT_ID },
          profile: profileView(id),
          links: listLinks(id),
          linkKinds: LINK_KINDS,
          maxLinks: MAX_LINKS_PER_ACCOUNT,
          documents: files.filter((f) => f.kind === 'document'),
          images: files.filter((f) => f.kind === 'image'),
          purposes: DOCUMENT_PURPOSES,
          limits: { maxBytes: MAX_DOCUMENT_BYTES, allowed: Object.keys(ALLOWED_TYPES) },
          menu: menuView(id),
          draft: draftView(latestDraft(id)),
          drafts: listDraftSummaries(id),
          ai: aiStatus(),
        });
      });
    } catch (error) { fail(res, error); }
  });

  // ---- business information -------------------------------------------------------
  router.put(`${base}/setup/profile`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      updateBusinessSettings(req.body ?? {}, id);
      res.json(runWithAccount(id, () => profileView(id)));
    } catch (error) { fail(res, error); }
  });

  // ---- business links -------------------------------------------------------------
  router.get(`${base}/setup/links`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    res.json({ links: listLinks(id), kinds: LINK_KINDS, max: MAX_LINKS_PER_ACCOUNT });
  });
  router.post(`${base}/setup/links`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try { res.status(201).json(createLink(req.body ?? {}, id)); } catch (error) { fail(res, error); }
  });
  router.put(`${base}/setup/links/:linkId`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const link = updateLink(Number.parseInt(String(req.params.linkId), 10), req.body ?? {}, id);
      if (!link) { res.status(404).json({ error: 'Link not found' }); return; }
      res.json(link);
    } catch (error) { fail(res, error); }
  });
  router.delete(`${base}/setup/links/:linkId`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    if (!deleteLink(Number.parseInt(String(req.params.linkId), 10), id)) { res.status(404).json({ error: 'Link not found' }); return; }
    res.json({ ok: true });
  });
  /** Reads one link (or every link that has not been read successfully when :linkId is "all"). */
  async function readLinks(accountId: number, which: 'all' | number): Promise<ReturnType<typeof listLinks>> {
    const targets = which === 'all' ? listLinks(accountId) : [getLink(which, accountId)].filter((l): l is NonNullable<typeof l> => Boolean(l));
    for (const link of targets) {
      const page = await fetchLinkContent(link.url);
      recordFetchResult(link.id, { ok: page.ok, httpStatus: page.httpStatus, error: page.error, title: page.title, text: page.text, sha256: page.sha256 }, accountId);
    }
    return listLinks(accountId);
  }
  router.post(`${base}/setup/links/read/:linkId`, fetchLimiter, async (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const raw = String(req.params.linkId);
      const which = raw === 'all' ? 'all' : Number.parseInt(raw, 10);
      if (which !== 'all' && !getLink(which, id)) { res.status(404).json({ error: 'Link not found' }); return; }
      res.json({ links: await readLinks(id, which) });
    } catch (error) { fail(res, error); }
  });

  // ---- PDFs and images (one account-scoped store) ----------------------------------
  router.get(`${base}/setup/files`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    const files = listDocuments({ accountId: id }).map((d) => fileView(d, id));
    res.json({ documents: files.filter((f) => f.kind === 'document'), images: files.filter((f) => f.kind === 'image'), purposes: DOCUMENT_PURPOSES, limits: { maxBytes: MAX_DOCUMENT_BYTES, allowed: Object.keys(ALLOWED_TYPES) } });
  });
  router.post(`${base}/setup/files`, uploadLimiter, rawUpload, async (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const header = (name: string): string | null => {
        const v = req.header(name);
        return v ? decodeURIComponent(String(v)) : null;
      };
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const visibility = (header('x-visibility') ?? 'ai_knowledge') as DocumentVisibility;
      const doc = saveDocument({
        originalName: header('x-file-name') ?? 'upload', mimeType: String(req.header('content-type') ?? ''), bytes, visibility,
        title: header('x-title'), purpose: header('x-purpose'), caption: header('x-caption'), uploadedBy: actor(req), accountId: id,
      });
      const finished = doc.extension === 'pdf' ? ((await extractDocumentText(doc.id, undefined, id)) ?? doc) : doc;
      res.status(201).json(fileView(finished, id));
    } catch (error) { fail(res, error); }
  });
  router.patch(`${base}/setup/files/:fileId`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const body = (req.body ?? {}) as { title?: string | null; visibility?: DocumentVisibility; status?: DocumentStatus; purpose?: string | null; caption?: string | null };
      const doc = updateDocument(Number.parseInt(String(req.params.fileId), 10), body, undefined, id);
      if (!doc) { res.status(404).json({ error: 'File not found' }); return; }
      res.json(fileView(doc, id));
    } catch (error) { fail(res, error); }
  });
  router.post(`${base}/setup/files/:fileId/extract`, uploadLimiter, async (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const doc = await extractDocumentText(Number.parseInt(String(req.params.fileId), 10), undefined, id);
      if (!doc) { res.status(404).json({ error: 'File not found' }); return; }
      res.json(fileView(doc, id));
    } catch (error) { fail(res, error); }
  });
  router.delete(`${base}/setup/files/:fileId`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    if (!deleteDocument(Number.parseInt(String(req.params.fileId), 10), undefined, id)) { res.status(404).json({ error: 'File not found' }); return; }
    res.json({ ok: true });
  });
  router.get(`${base}/setup/files/:fileId/file`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    const doc = getDocument(Number.parseInt(String(req.params.fileId), 10), undefined, id);
    if (!doc) { res.status(404).json({ error: 'File not found' }); return; }
    try {
      res.setHeader('Content-Type', serveContentType(doc));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(doc.original_name)}"`);
      res.sendFile(documentPath(doc));
    } catch (error) { fail(res, error); }
  });

  // ---- menu -------------------------------------------------------------------------
  router.get(`${base}/setup/menu`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    res.json(menuView(id));
  });
  router.put(`${base}/setup/menu`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      saveMenuConfig(id, req.body, 'manual');
      runWithAccount(id, () => ensureTemplateDefaults(getDb(), id)); // pages for new entries now exist in the Manual Reply Editor
      res.json(menuView(id));
    } catch (error) { fail(res, error); }
  });
  /** Writes the numbered main-menu text from the saved structure (so the numbers customers see always match the router). */
  router.post(`${base}/setup/menu/sync-text`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      if (id === LEGACY_ACCOUNT_ID) throw new MenuValidationError('The original business keeps its built-in menu text; edit it in the Manual Reply Editor.');
      const view = menuView(id);
      runWithAccount(id, () => {
        ensureTemplateDefaults(getDb(), id);
        if (!getTemplate('main_menu', getDb(), id)) throw new MenuValidationError('main_menu template is missing');
        publishTemplate('main_menu', { ar: view.mainMenuText!.ar, en: view.mainMenuText!.en }, `setup:${actor(req)}`, getDb(), id);
      });
      res.json(menuView(id));
    } catch (error) { fail(res, error); }
  });
  router.delete(`${base}/setup/menu`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      if (id === LEGACY_ACCOUNT_ID) throw new MenuValidationError('The original business keeps its built-in menu structure.');
      resetMenuConfig(id);
      runWithAccount(id, () => ensureTemplateDefaults(getDb(), id));
      res.json(menuView(id));
    } catch (error) { fail(res, error); }
  });

  // ---- Analyze & Generate → review → edit → apply -----------------------------------
  router.post(`${base}/setup/generate`, generateLimiter, async (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const useAi = (req.body as { useAi?: unknown } | undefined)?.useAi !== false;
      const result = await generateDraftContent(id, { useAi });
      const draft = createDraft({ content: result.content, generator: result.generator, model: result.model, sources: sourceSummary(result.sources), warnings: result.warnings, createdBy: actor(req) }, id);
      logger.info({ account: id, draft: draft.id, generator: draft.generator }, 'business setup draft generated');
      res.status(201).json(draftView(draft));
    } catch (error) { fail(res, error); }
  });
  router.get(`${base}/setup/drafts/:draftId`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    const draft = getDraft(Number.parseInt(String(req.params.draftId), 10), id);
    if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
    res.json(draftView(draft));
  });
  router.put(`${base}/setup/drafts/:draftId`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const draft = updateDraftContent(Number.parseInt(String(req.params.draftId), 10), (req.body as { content?: unknown })?.content, id);
      if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
      res.json(draftView(draft));
    } catch (error) { fail(res, error); }
  });
  router.post(`${base}/setup/drafts/:draftId/apply`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const body = (req.body ?? {}) as { mode?: ApplyMode; confirm?: string; sections?: ApplySection[] };
      const sections = Array.isArray(body.sections) ? body.sections.filter((s): s is ApplySection => APPLY_SECTIONS.includes(s)) : undefined;
      const report = applyDraft(id, Number.parseInt(String(req.params.draftId), 10), { mode: body.mode as ApplyMode, confirm: body.confirm, sections, actor: actor(req) });
      if (report.knowledgeChanged) invalidateAccountKnowledge(id);
      logger.info({ account: id, mode: report.mode, entries: report.entries.length }, 'business setup draft applied');
      res.json({ report, draft: draftView(getDraft(Number.parseInt(String(req.params.draftId), 10), id)), profile: runWithAccount(id, () => profileView(id)), menu: menuView(id) });
    } catch (error) { fail(res, error); }
  });
  router.delete(`${base}/setup/drafts/:draftId`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    if (!discardDraft(Number.parseInt(String(req.params.draftId), 10), id)) { res.status(404).json({ error: 'Open draft not found' }); return; }
    res.json({ ok: true });
  });

  // ---- delete the whole business ------------------------------------------------------
  router.get(`${base}/delete-preview`, (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try { res.json(describeDeletion(id)); } catch (error) { fail(res, error); }
  });
  router.delete(base, async (req, res) => {
    const id = accountOf(req, res);
    if (id === null) return;
    try {
      const report = await deleteAccount(id, (req.body as { confirm?: unknown } | undefined)?.confirm, { discardConnection });
      res.json({ ok: true, report });
    } catch (error) { fail(res, error); }
  });
}
