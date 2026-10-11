import express, { type Request, type Response, type Router } from 'express';
import fs from 'node:fs';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import { MAX_DOCUMENT_BYTES } from '../documents/documentStore';
import { getCustomerRequest } from '../memory/customerRequestRepo';
import { RequestTransitionError } from '../requests/quotationLifecycle';
import {
  CustomerFileError, assignFileToCustomer, customerFilePath, getCustomerFile, publicFile, saveCustomerFile, type CustomerFile,
} from '../files/customerFileRepo';
import { extractCustomerFileText } from '../files/fileTextExtraction';
import {
  CustomerNotFoundError, addNote, completeFollowUp, getCustomerProfile, getCustomerTimeline, listCustomerDocuments, listFileExceptions, listNotes, updateCustomerProfile,
} from '../customers/customerProfile';
import { exportCustomersCsv, exportQuotationsCsv, listDirectory, reportSummary, toCsv, type DirectoryParams } from '../customers/customerReports';
import { buildExportDataset, datasetToPrintHtml, datasetToXlsx, type ExportDatasetKind } from '../customers/reportExport';
import {
  QuotationError, approveQuotation, finalizeVersion, markQuotationSentManually, quotationView, rejectQuotation, saveDraft, sendQuotation, type StaffActor,
} from '../quotations/quotationService';
import { MoneyError } from '../quotations/money';
import { nextStatuses } from '../requests/quotationLifecycle';

/**
 * Staff API for the Customers section, Customer Reports and the quotation workflow. Every route runs inside the business the staff
 * member selected (account middleware) and has already passed the server-side permission check (authorize.ts): `customers` for the
 * customer pages and reports, `requests` for the quotation workflow. Reads need view, anything that changes data needs edit.
 * A customer, file, request or note id from another business is simply "not found".
 */

const rawUpload = express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES + 1024 });

function staffOf(req: Request): StaffActor {
  const user = req.authUser;
  return { adminId: user?.id ?? null, name: user ? user.displayName || user.username : null };
}

function fail(res: Response, error: unknown): void {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status < 500 && (error instanceof Error)) {
    res.status(status).json({ error: error.message });
    return;
  }
  logger.error({ errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? error).slice(0, 200) }, 'customer request failed');
  res.status(500).json({ error: 'internal_server_error' });
}

function idParam(value: unknown): number | null {
  const n = Number.parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(value) ? n : null;
}

const bool = (v: unknown): boolean => v === '1' || v === 'true';
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const page = (v: unknown, fallback: number): number => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function directoryParams(req: Request): DirectoryParams {
  const q = req.query;
  return {
    search: str(q.search), from: str(q.from), to: str(q.to), requestStatus: str(q.requestStatus), openOnly: bool(q.openOnly), hasFiles: bool(q.hasFiles),
    language: q.language === 'ar' || q.language === 'en' ? q.language : undefined,
    followUp: q.followUp === 'outstanding' || q.followUp === 'overdue' ? q.followUp : undefined,
    sort: q.sort === 'name' || q.sort === 'inquiries' ? q.sort : 'recent',
    limit: page(q.limit, 25), offset: page(q.offset, 0),
  };
}

/** Streams a stored customer file. Images and PDFs may open in the browser; everything else downloads. Never executed, never sniffed. */
function sendStoredFile(req: Request, res: Response, file: CustomerFile): void {
  const full = customerFilePath(file);
  if (!full || file.status === 'failed' || file.status === 'too_large' || file.status === 'unsupported' || !fs.existsSync(full)) {
    res.status(404).json({ error: 'File not available' });
    return;
  }
  const inlineOk = file.kind === 'image' || file.extension === 'pdf';
  const name = (file.original_name ?? `file.${file.extension ?? 'bin'}`).replace(/[\r\n"]/g, '_');
  res.setHeader('Content-Type', file.mime_type ?? 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `${inlineOk && !req.query.download ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  fs.createReadStream(full).on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }).pipe(res);
}

export function registerCustomerRoutes(router: Router): void {
  // ---- Directory, review queue ------------------------------------------------
  router.get('/api/dashboard/customers/directory', (req, res) => {
    try {
      res.json(listDirectory(directoryParams(req)));
    } catch (error) { fail(res, error); }
  });
  router.get('/api/dashboard/customers/files/review', (_req, res) => {
    try {
      res.json({ files: listFileExceptions() });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/dashboard/customers/files/:fileId/assign', (req, res) => {
    try {
      const fileId = idParam(req.params.fileId);
      const customerId = idParam((req.body as { customerId?: unknown } | undefined)?.customerId);
      if (!fileId || !customerId) { res.status(400).json({ error: 'fileId and customerId are required' }); return; }
      const file = assignFileToCustomer(fileId, customerId);
      if (!file) { res.status(404).json({ error: 'File or customer not found' }); return; }
      res.json({ file: publicFile(file) });
    } catch (error) { fail(res, error); }
  });
  router.get('/api/dashboard/customers/files/:fileId/download', (req, res) => {
    const file = getCustomerFile(idParam(req.params.fileId) ?? -1);
    if (!file) { res.status(404).json({ error: 'File not found' }); return; }
    sendStoredFile(req, res, file);
  });

  // Reads (or re-reads) the text of one stored PDF. The file itself is never changed; the result is unverified customer text for staff only.
  router.post('/api/dashboard/customers/files/:fileId/extract', async (req, res) => {
    try {
      const fileId = idParam(req.params.fileId);
      if (!fileId) { res.status(400).json({ error: 'invalid id' }); return; }
      const outcome = await extractCustomerFileText(fileId, { force: true });
      if (outcome.state === 'skipped') {
        if (outcome.reason === 'not_found') { res.status(404).json({ error: 'File not found' }); return; }
        const messages = { not_pdf: 'Only a PDF has a text layer to read', no_file: 'The file is not available', already_extracted: 'The text was already read', too_many_attempts: 'This file was tried too many times. Open it and read it manually', busy: 'Text extraction is busy, try again in a moment' } as const;
        res.status(outcome.reason === 'busy' ? 503 : 409).json({ error: messages[outcome.reason], reason: outcome.reason });
        return;
      }
      res.json({ state: outcome.state, file: publicFile(outcome.file) });
    } catch (error) { fail(res, error); }
  });

  // ---- One customer -----------------------------------------------------------
  router.get('/api/dashboard/customers/:id/profile', (req, res) => {
    try {
      const id = idParam(req.params.id);
      if (!id) { res.status(400).json({ error: 'invalid customer id' }); return; }
      res.json(getCustomerProfile(id));
    } catch (error) { fail(res, error); }
  });
  router.post('/api/dashboard/customers/:id/profile', (req, res) => {
    try {
      const id = idParam(req.params.id);
      if (!id) { res.status(400).json({ error: 'invalid customer id' }); return; }
      const body = (req.body ?? {}) as { email?: unknown; companyName?: unknown };
      res.json(updateCustomerProfile(id, {
        email: body.email === undefined ? undefined : body.email === null ? null : String(body.email),
        companyName: body.companyName === undefined ? undefined : body.companyName === null ? null : String(body.companyName),
      }));
    } catch (error) { fail(res, error); }
  });
  router.get('/api/dashboard/customers/:id/timeline', (req, res) => {
    try {
      const id = idParam(req.params.id);
      if (!id) { res.status(400).json({ error: 'invalid customer id' }); return; }
      const types = str(req.query.types)?.split(',').map((t) => t.trim()).filter(Boolean);
      res.json(getCustomerTimeline(id, { q: str(req.query.q), types, from: str(req.query.from), to: str(req.query.to), order: req.query.order === 'asc' ? 'asc' : 'desc', limit: page(req.query.limit, 100), offset: page(req.query.offset, 0) }));
    } catch (error) { fail(res, error); }
  });
  router.get('/api/dashboard/customers/:id/documents', (req, res) => {
    try {
      const id = idParam(req.params.id);
      if (!id) { res.status(400).json({ error: 'invalid customer id' }); return; }
      res.json({ documents: listCustomerDocuments(id) });
    } catch (error) { fail(res, error); }
  });
  router.get('/api/dashboard/customers/:id/files/:fileId/download', (req, res) => {
    const id = idParam(req.params.id);
    const file = getCustomerFile(idParam(req.params.fileId) ?? -1);
    // The file must belong to THIS customer (and, by the account scope of the lookup, to this business).
    if (!id || !file || file.customer_id !== id) { res.status(404).json({ error: 'File not found' }); return; }
    sendStoredFile(req, res, file);
  });
  router.get('/api/dashboard/customers/:id/notes', (req, res) => {
    try {
      const id = idParam(req.params.id);
      if (!id) { res.status(400).json({ error: 'invalid customer id' }); return; }
      res.json({ notes: listNotes(id) });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/dashboard/customers/:id/notes', (req, res) => {
    try {
      const id = idParam(req.params.id);
      if (!id) { res.status(400).json({ error: 'invalid customer id' }); return; }
      const body = (req.body ?? {}) as { body?: unknown; requestId?: unknown; followUpAt?: unknown };
      res.status(201).json({ note: addNote(id, { body: String(body.body ?? ''), requestId: body.requestId ? idParam(body.requestId) : null, followUpAt: str(body.followUpAt) ?? null }, staffOf(req)) });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/dashboard/customers/:id/notes/:noteId/done', (req, res) => {
    try {
      const id = idParam(req.params.id);
      const noteId = idParam(req.params.noteId);
      if (!id || !noteId) { res.status(400).json({ error: 'invalid id' }); return; }
      res.json({ note: completeFollowUp(id, noteId, staffOf(req)) });
    } catch (error) { fail(res, error); }
  });

  // ---- Customer Reports -------------------------------------------------------
  router.get('/api/dashboard/customer-reports/summary', (req, res) => {
    try {
      res.json(reportSummary({ from: str(req.query.from), to: str(req.query.to) }));
    } catch (error) { fail(res, error); }
  });
  router.get('/api/dashboard/customer-reports/export', (req, res) => {
    try {
      const dataset: ExportDatasetKind = req.query.dataset === 'quotations' ? 'quotations' : req.query.dataset === 'summary' ? 'summary' : 'customers';
      const format = req.query.format === 'xlsx' ? 'xlsx' : req.query.format === 'pdf' ? 'pdf' : 'csv';
      const lang = req.query.lang === 'ar' ? 'ar' : 'en';
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // The export is built for the business the staff member selected (the account middleware set it); no account id is read from the request.
      if (format === 'xlsx') {
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${dataset}-${stamp}.xlsx"`);
        res.send(datasetToXlsx(buildExportDataset(dataset, directoryParams(req), lang)));
        return;
      }
      if (format === 'pdf') {
        // A print-ready report (Print → Save as PDF): script-free HTML under a locked-down policy.
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
        res.send(datasetToPrintHtml(buildExportDataset(dataset, directoryParams(req), lang)));
        return;
      }
      const dataSet = dataset === 'summary' ? buildExportDataset('summary', directoryParams(req), 'en') : null;
      const csv = dataSet ? toCsv(dataSet.headers, dataSet.rows) : dataset === 'quotations' ? exportQuotationsCsv({ from: str(req.query.from), to: str(req.query.to) }) : exportCustomersCsv(directoryParams(req));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${dataset}-${stamp}.csv"`);
      res.send(csv);
    } catch (error) { fail(res, error); }
  });

  // ---- Quotation workflow (feature: requests) -----------------------------------
  const requestId = (req: Request, res: Response): number | null => {
    const id = idParam(req.params.id);
    if (!id || !getCustomerRequest(id, undefined, currentAccountId())) { res.status(404).json({ error: 'Request not found' }); return null; }
    return id;
  };
  router.get('/api/dashboard/requests/:id/quotation', (req, res) => {
    try {
      const id = requestId(req, res);
      if (id === null) return;
      const request = getCustomerRequest(id)!;
      res.json({ ...(request.kind === 'quotation' ? quotationView(id) : { versions: [], deliveries: [] }), request, nextStatuses: nextStatuses(request.kind, request.status) });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/dashboard/requests/:id/quotation/draft', (req, res) => {
    try {
      const id = requestId(req, res);
      if (id === null) return;
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json({ version: saveDraft(id, {
        currency: str(b.currency) ?? null, validUntil: str(b.validUntil) ?? null, taxRatePercent: b.taxRatePercent === undefined || b.taxRatePercent === '' ? null : (b.taxRatePercent as string | number | null),
        customerMessage: typeof b.customerMessage === 'string' ? b.customerMessage : null, internalNote: typeof b.internalNote === 'string' ? b.internalNote : null,
        fileId: b.fileId ? idParam(b.fileId) : null,
        lines: Array.isArray(b.lines) ? b.lines.map((l) => ({ description: String((l as { description?: unknown }).description ?? ''), quantity: (l as { quantity?: string | number | null }).quantity ?? null, unitPrice: (l as { unitPrice?: string | number | null }).unitPrice ?? null })) : [],
      }, staffOf(req)) });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/dashboard/requests/:id/quotation/versions/:versionId/finalize', (req, res) => {
    try {
      const id = requestId(req, res);
      const versionId = idParam(req.params.versionId);
      if (id === null || !versionId) { if (id !== null) res.status(400).json({ error: 'invalid version id' }); return; }
      res.json({ version: finalizeVersion(id, versionId, staffOf(req)) });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/dashboard/requests/:id/quotation/approve', (req, res) => {
    try {
      const id = requestId(req, res);
      if (id === null) return;
      const result = approveQuotation(id, staffOf(req));
      res.json({ request: result.request, changed: result.changed, queued: result.notifications.length });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/dashboard/requests/:id/quotation/reject', (req, res) => {
    try {
      const id = requestId(req, res);
      if (id === null) return;
      const result = rejectQuotation(id, String((req.body as { reason?: unknown } | undefined)?.reason ?? ''), staffOf(req));
      res.json({ request: result.request, changed: result.changed, queued: result.notifications.length });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/dashboard/requests/:id/quotation/send', (req, res) => {
    try {
      const id = requestId(req, res);
      if (id === null) return;
      const result = sendQuotation(id, staffOf(req));
      // 202: the delivery is queued. The request becomes "sent" only after WhatsApp accepts the message.
      res.status(202).json({ queued: true, alreadyQueued: result.alreadyQueued, version: result.version, delivery: { id: result.outbox.id, status: result.outbox.status } });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/dashboard/requests/:id/quotation/mark-sent', (req, res) => {
    try {
      const id = requestId(req, res);
      if (id === null) return;
      const result = markQuotationSentManually(id, String((req.body as { reason?: unknown } | undefined)?.reason ?? ''), staffOf(req));
      res.json({ request: result.request, changed: result.changed });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/dashboard/requests/:id/quotation/attachment', rawUpload, (req, res) => {
    try {
      const id = requestId(req, res);
      if (id === null) return;
      const request = getCustomerRequest(id)!;
      if (request.kind !== 'quotation') { res.status(400).json({ error: 'Only a quotation request can have a quotation document' }); return; }
      const name = decodeURIComponent(String(req.header('x-file-name') ?? 'quotation.pdf'));
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const file = saveCustomerFile({ customerId: request.customer_id, direction: 'outbound', bytes, originalName: name, mimeType: String(req.header('content-type') ?? ''), requestId: id, purpose: 'quotation', uploadedByAdminId: staffOf(req).adminId ?? null });
      res.status(201).json({ file: publicFile(file) });
    } catch (error) {
      if ((error as { type?: string })?.type === 'entity.too.large') { res.status(413).json({ error: `File exceeds ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB` }); return; }
      fail(res, error);
    }
  });
}

void CustomerFileError; void CustomerNotFoundError; void QuotationError; void MoneyError; void RequestTransitionError;
