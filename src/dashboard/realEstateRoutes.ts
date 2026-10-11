import type { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { accountHasFeature, FEATURES } from '../accounts/accountFeatures';
import { canAdminAccessAccount } from '../accounts/accountRepo';
import { listCustomerFiles, publicFile } from '../files/customerFileRepo';
import { LEAD_KINDS, LEAD_STATUSES, FIELD_LABELS, missingFields, type LeadKind, type LeadStatus } from '../realestate/leadFields';
import {
  RealEstateError, archiveProject, createProject, getLead, leadEvents, leadProjects, listLeads, listProjects, overview, updateLeadByStaff, updateProject, type Project,
} from '../realestate/realEstateRepo';

/**
 * Staff API of the real estate section (leads, projects, follow-ups, documents). Header-scoped like the other dashboard routes: it runs inside the
 * business the staff member selected, has already passed the server-side permission check (authorize.ts: `requests` for leads and follow-ups,
 * `business` for projects, `customers` for documents), and exists ONLY for a business with the real estate add-on — for every other business each
 * route answers 404, as if it were not there. An id from another business is simply "not found".
 */

function enabled(req: Request, res: Response): boolean {
  void req;
  if (!accountHasFeature(currentAccountId(), FEATURES.REAL_ESTATE)) {
    res.status(404).json({ error: 'Not available for this business' });
    return false;
  }
  return true;
}

function fail(res: Response, error: unknown): void {
  if (error instanceof RealEstateError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  logger.error({ errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? error).slice(0, 200) }, 'real estate request failed');
  res.status(500).json({ error: 'internal_server_error' });
}

function idParam(value: unknown): number | null {
  const n = Number.parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(value) ? n : null;
}

const maskWa = (v: string): string => {
  const d = String(v).replace(/\D/g, '');
  return d.length > 4 ? `${'•'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}` : d;
};

function projectView(p: Project) {
  return { ...p, customerVisible: p.published && !p.archived };
}

export function registerRealEstateRoutes(router: Router): void {
  router.get('/api/dashboard/realestate/overview', (req, res) => {
    if (!enabled(req, res)) return;
    try { res.json({ ...overview(), labels: FIELD_LABELS }); } catch (error) { fail(res, error); }
  });

  // ---- leads ---------------------------------------------------------------------
  router.get('/api/dashboard/realestate/leads', (req, res) => {
    if (!enabled(req, res)) return;
    try {
      const q = req.query;
      const kind = typeof q.kind === 'string' && (LEAD_KINDS as readonly string[]).includes(q.kind) ? (q.kind as LeadKind) : 'all';
      const status = typeof q.status === 'string' && ((LEAD_STATUSES as readonly string[]).includes(q.status) || q.status === 'all' || q.status === 'open') ? (q.status as LeadStatus | 'all' | 'open') : 'open';
      const result = listLeads({
        kind, status, q: typeof q.q === 'string' ? q.q : undefined, followUpDue: q.followUpDue === '1', limit: Number(q.limit) || 50, offset: Number(q.offset) || 0,
        assignedAdminId: idParam(q.assigned) ?? undefined,
      });
      res.json({
        total: result.total,
        items: result.items.map(({ waId, ...lead }) => ({ ...lead, waMasked: maskWa(waId), missing: missingFields(lead.kind, lead.details).map((k) => FIELD_LABELS[k]) })),
      });
    } catch (error) { fail(res, error); }
  });

  router.get('/api/dashboard/realestate/leads/:id', (req, res) => {
    if (!enabled(req, res)) return;
    const id = idParam(req.params.id);
    const lead = id ? getLead(id) : null;
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    try {
      const customer = getDb().prepare('SELECT id, wa_id, display_name, language, email, company_name FROM customers WHERE id = ? AND whatsapp_account_id = ?').get(lead.customerId, currentAccountId()) as
        { id: number; wa_id: string; display_name: string | null; language: string | null; email: string | null; company_name: string | null } | undefined;
      const files = listCustomerFiles({ customerId: lead.customerId, limit: 50 }).map((f) => ({ ...publicFile(f), downloadUrl: `/api/dashboard/customers/files/${f.id}/download` }));
      res.json({
        lead: { ...lead, missing: missingFields(lead.kind, lead.details).map((k) => FIELD_LABELS[k]) },
        customer: customer ? { id: customer.id, displayName: customer.display_name, waMasked: maskWa(customer.wa_id), language: customer.language, email: customer.email, company: customer.company_name } : null,
        events: leadEvents(lead.id), projects: leadProjects(lead.id).map(projectView), files, labels: FIELD_LABELS,
      });
    } catch (error) { fail(res, error); }
  });

  router.patch('/api/dashboard/realestate/leads/:id', (req, res) => {
    if (!enabled(req, res)) return;
    const id = idParam(req.params.id);
    if (!id) { res.status(404).json({ error: 'Lead not found' }); return; }
    try {
      const adminId = req.adminUserId as number;
      const accountId = currentAccountId();
      const lead = updateLeadByStaff(id, req.body ?? {}, adminId, (candidate) => canAdminAccessAccount(candidate, accountId), accountId);
      logger.info({ account: accountId, lead: lead.reference, admin: adminId }, 'real estate lead updated by staff');
      res.json({ lead });
    } catch (error) { fail(res, error); }
  });

  // ---- projects ------------------------------------------------------------------
  router.get('/api/dashboard/realestate/projects', (req, res) => {
    if (!enabled(req, res)) return;
    try { res.json({ projects: listProjects({ includeArchived: req.query.archived === '1' }).map(projectView) }); } catch (error) { fail(res, error); }
  });

  router.post('/api/dashboard/realestate/projects', (req, res) => {
    if (!enabled(req, res)) return;
    try {
      const actor = `staff:${req.adminUserId}`;
      res.status(201).json({ project: projectView(createProject(req.body ?? {}, actor)) });
    } catch (error) { fail(res, error); }
  });

  router.put('/api/dashboard/realestate/projects/:id', (req, res) => {
    if (!enabled(req, res)) return;
    const id = idParam(req.params.id);
    if (!id) { res.status(404).json({ error: 'Project not found' }); return; }
    try { res.json({ project: projectView(updateProject(id, req.body ?? {})) }); } catch (error) { fail(res, error); }
  });

  router.post('/api/dashboard/realestate/projects/:id/archive', (req, res) => {
    if (!enabled(req, res)) return;
    const id = idParam(req.params.id);
    if (!id) { res.status(404).json({ error: 'Project not found' }); return; }
    try { res.json({ project: projectView(archiveProject(id, req.body?.archived !== false)) }); } catch (error) { fail(res, error); }
  });

  // ---- follow-ups (leads waiting for a person + consultation requests) ------------------
  router.get('/api/dashboard/realestate/followups', (req, res) => {
    if (!enabled(req, res)) return;
    try {
      const accountId = currentAccountId();
      const due = listLeads({ status: 'open', followUpDue: true, limit: 100 }).items;
      const staff = listLeads({ status: 'open', limit: 200 }).items.filter((l) => l.needsStaff || l.status === 'follow_up' || (l.status === 'qualified' && !l.assignedAdminId));
      const seen = new Set<number>();
      const items = [...due, ...staff].filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true))).map(({ waId, ...lead }) => ({ ...lead, waMasked: maskWa(waId) }));
      const consultations = (getDb().prepare(
        `SELECT r.id, r.reference, r.status, r.payload, r.created_at, c.id AS customer_id, c.display_name, c.wa_id
           FROM customer_requests r JOIN customers c ON c.id = r.customer_id AND c.whatsapp_account_id = r.whatsapp_account_id
          WHERE r.whatsapp_account_id = ? AND r.kind = 'appointment' AND r.status IN ('pending','confirmed') ORDER BY r.id DESC LIMIT 100`,
      ).all(accountId) as { id: number; reference: string; status: string; payload: string; created_at: string; customer_id: number; display_name: string | null; wa_id: string }[]).map((r) => {
        let payload: Record<string, string> = {};
        try { payload = JSON.parse(r.payload) as Record<string, string>; } catch { /* keep empty */ }
        return { id: r.id, reference: r.reference, status: r.status, createdAt: r.created_at, customerId: r.customer_id, displayName: r.display_name, waMasked: maskWa(r.wa_id), topic: payload.service ?? null, date: payload.date ?? null, time: payload.time ?? null, contact: payload.time ?? null };
      });
      res.json({ leads: items, consultations });
    } catch (error) { fail(res, error); }
  });

  // ---- documents (files customers sent, for customers who have an enquiry) -------------------
  router.get('/api/dashboard/realestate/documents', (req, res) => {
    if (!enabled(req, res)) return;
    try {
      const accountId = currentAccountId();
      const rows = getDb().prepare(
        `SELECT f.id AS file_id, l.id AS lead_id, l.reference, l.kind, l.documents_status
           FROM customer_files f JOIN real_estate_leads l ON l.customer_id = f.customer_id AND l.whatsapp_account_id = f.whatsapp_account_id
          WHERE f.whatsapp_account_id = ? AND f.direction = 'inbound' ORDER BY f.created_at DESC, f.id DESC LIMIT 200`,
      ).all(accountId) as { file_id: number; lead_id: number; reference: string; kind: string; documents_status: string }[];
      const byFile = new Map(rows.map((r) => [r.file_id, r]));
      const files = listCustomerFiles({ direction: 'inbound', limit: 500 }).filter((f) => byFile.has(f.id)).map((f) => {
        const l = byFile.get(f.id)!;
        return { ...publicFile(f), downloadUrl: `/api/dashboard/customers/files/${f.id}/download`, leadId: l.lead_id, leadReference: l.reference, leadKind: l.kind, reviewStatus: l.documents_status };
      });
      res.json({ files });
    } catch (error) { fail(res, error); }
  });
}
