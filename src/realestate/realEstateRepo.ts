import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { getDocument } from '../documents/documentStore';
import {
  AUTO_STATUSES, DOCUMENT_STATUSES, LEAD_KINDS, LEAD_STATUSES, isQualified, parseDetails, sanitizeFields,
  type DocumentStatus, type FieldKey, type LeadKind, type LeadStatus,
} from './leadFields';

/**
 * Projects and leads of the one business that has the real estate add-on. Every function reads and writes ONLY rows of the account it is
 * given (default: the account of the running request), and nothing here invents data: a project exists only because staff entered it, and a
 * lead exists only because a customer of this business wrote to it.
 */

export class RealEstateError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

// ---------------------------------------------------------------- projects

export const PROJECT_STAGES = ['upcoming', 'under_construction', 'completed', 'sold_out', 'other'] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];
const STAGE_LABEL: Record<ProjectStage, { en: string; ar: string }> = {
  upcoming: { en: 'Upcoming', ar: 'قريباً' },
  under_construction: { en: 'Under construction', ar: 'قيد الإنشاء' },
  completed: { en: 'Completed', ar: 'مكتمل' },
  sold_out: { en: 'Sold out', ar: 'نفدت الوحدات' },
  other: { en: 'See details', ar: 'التفاصيل' },
};

export interface Project {
  id: number;
  accountId: number;
  nameEn: string;
  nameAr: string | null;
  city: string | null;
  district: string | null;
  propertyType: string | null;
  stage: ProjectStage | null;
  summaryEn: string | null;
  summaryAr: string | null;
  brochureDocumentId: number | null;
  published: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  id: number; whatsapp_account_id: number; name_en: string; name_ar: string | null; city: string | null; district: string | null; property_type: string | null;
  stage: string | null; summary_en: string | null; summary_ar: string | null; brochure_document_id: number | null; published: number; archived: number; created_at: string; updated_at: string;
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id, accountId: r.whatsapp_account_id, nameEn: r.name_en, nameAr: r.name_ar, city: r.city, district: r.district, propertyType: r.property_type,
    stage: (PROJECT_STAGES as readonly string[]).includes(r.stage ?? '') ? (r.stage as ProjectStage) : null, summaryEn: r.summary_en, summaryAr: r.summary_ar,
    brochureDocumentId: r.brochure_document_id, published: r.published === 1, archived: r.archived === 1, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export interface ProjectInput {
  nameEn?: unknown; nameAr?: unknown; city?: unknown; district?: unknown; propertyType?: unknown; stage?: unknown; summaryEn?: unknown; summaryAr?: unknown;
  brochureDocumentId?: unknown; published?: unknown;
}

function text(value: unknown, field: string, max: number, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RealEstateError('validation_failed', `${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new RealEstateError('validation_failed', `${field} must be text`);
  const t = value.replace(/[ \t]+/g, ' ').trim();
  if (!t && required) throw new RealEstateError('validation_failed', `${field} is required`);
  if (t.length > max) throw new RealEstateError('validation_failed', `${field} is too long (max ${max} characters)`);
  return t || null;
}

function checkBrochure(id: unknown, accountId: number, db: Database.Database): number | null {
  if (id === undefined || id === null || id === '') return null;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new RealEstateError('validation_failed', 'brochureDocumentId is invalid');
  const doc = getDocument(n, db, accountId); // account-scoped: another business's file is simply not found
  if (!doc || doc.status !== 'active') throw new RealEstateError('validation_failed', 'That brochure is not one of this business\'s active documents');
  if (doc.visibility !== 'customer') throw new RealEstateError('validation_failed', 'Only a document marked customer-visible can be shared as a brochure');
  return n;
}

function projectValues(input: ProjectInput, accountId: number, db: Database.Database, partial: boolean): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  const has = (k: keyof ProjectInput) => !partial || input[k] !== undefined;
  if (has('nameEn')) out.name_en = text(input.nameEn, 'English name', 120, true);
  if (has('nameAr')) out.name_ar = text(input.nameAr, 'Arabic name', 120);
  if (has('city')) out.city = text(input.city, 'City', 80);
  if (has('district')) out.district = text(input.district, 'District', 80);
  if (has('propertyType')) out.property_type = text(input.propertyType, 'Property type', 80);
  if (has('summaryEn')) out.summary_en = text(input.summaryEn, 'English summary', 1200);
  if (has('summaryAr')) out.summary_ar = text(input.summaryAr, 'Arabic summary', 1200);
  if (has('stage')) {
    const stage = input.stage === undefined || input.stage === null || input.stage === '' ? null : String(input.stage);
    if (stage !== null && !(PROJECT_STAGES as readonly string[]).includes(stage)) throw new RealEstateError('validation_failed', 'Unknown project stage');
    out.stage = stage;
  }
  if (has('brochureDocumentId')) out.brochure_document_id = checkBrochure(input.brochureDocumentId, accountId, db);
  if (has('published')) out.published = input.published === true || input.published === 1 || input.published === 'true' ? 1 : 0;
  return out;
}

export function createProject(input: ProjectInput, actor: string, accountId: number = currentAccountId(), db: Database.Database = getDb()): Project {
  const v = projectValues(input, accountId, db, false);
  const result = db.prepare(
    `INSERT INTO real_estate_projects (whatsapp_account_id, name_en, name_ar, city, district, property_type, stage, summary_en, summary_ar, brochure_document_id, published, created_by)
     VALUES (@acc, @name_en, @name_ar, @city, @district, @property_type, @stage, @summary_en, @summary_ar, @brochure_document_id, @published, @by)`,
  ).run({ acc: accountId, by: actor, published: 0, name_ar: null, city: null, district: null, property_type: null, stage: null, summary_en: null, summary_ar: null, brochure_document_id: null, ...v });
  return getProject(Number(result.lastInsertRowid), accountId, db)!;
}

export function updateProject(id: number, input: ProjectInput, accountId: number = currentAccountId(), db: Database.Database = getDb()): Project {
  if (!getProject(id, accountId, db)) throw new RealEstateError('not_found', 'Project not found', 404);
  const v = projectValues(input, accountId, db, true);
  const keys = Object.keys(v);
  if (keys.length > 0) {
    db.prepare(`UPDATE real_estate_projects SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id AND whatsapp_account_id = @acc`).run({ ...v, id, acc: accountId });
  }
  return getProject(id, accountId, db)!;
}

export function archiveProject(id: number, archived: boolean, accountId: number = currentAccountId(), db: Database.Database = getDb()): Project {
  if (!getProject(id, accountId, db)) throw new RealEstateError('not_found', 'Project not found', 404);
  // an archived project is also unpublished: nothing archived is ever shown to a customer
  db.prepare("UPDATE real_estate_projects SET archived = ?, published = CASE WHEN ? = 1 THEN 0 ELSE published END, updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ?").run(archived ? 1 : 0, archived ? 1 : 0, id, accountId);
  return getProject(id, accountId, db)!;
}

export function getProject(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): Project | null {
  const row = db.prepare('SELECT * FROM real_estate_projects WHERE id = ? AND whatsapp_account_id = ?').get(id, accountId) as ProjectRow | undefined;
  return row ? toProject(row) : null;
}

export function listProjects(opts: { includeArchived?: boolean } = {}, accountId: number = currentAccountId(), db: Database.Database = getDb()): Project[] {
  const rows = db.prepare(`SELECT * FROM real_estate_projects WHERE whatsapp_account_id = ? ${opts.includeArchived ? '' : 'AND archived = 0'} ORDER BY archived, published DESC, id DESC`).all(accountId) as ProjectRow[];
  return rows.map(toProject);
}

/** What customers may be told about: published and not archived. Nothing else is ever offered to the assistant or the menu. */
export function publishedProjects(accountId: number = currentAccountId(), db: Database.Database = getDb()): Project[] {
  const rows = db.prepare('SELECT * FROM real_estate_projects WHERE whatsapp_account_id = ? AND published = 1 AND archived = 0 ORDER BY id').all(accountId) as ProjectRow[];
  return rows.map(toProject);
}

export function searchPublishedProjects(q: { propertyType?: string; city?: string; query?: string }, accountId: number = currentAccountId(), db: Database.Database = getDb()): Project[] {
  const norm = (s?: string) => (s ?? '').toLowerCase().trim();
  const type = norm(q.propertyType); const city = norm(q.city); const query = norm(q.query);
  return publishedProjects(accountId, db).filter((p) => {
    const hay = [p.nameEn, p.nameAr, p.city, p.district, p.propertyType, p.summaryEn, p.summaryAr].filter(Boolean).join(' ').toLowerCase();
    return (!type || (p.propertyType ?? '').toLowerCase().includes(type) || hay.includes(type)) && (!city || [p.city, p.district].some((x) => (x ?? '').toLowerCase().includes(city))) && (!query || hay.includes(query));
  }).slice(0, 5);
}

/** The numbered list for the "Explore Our Projects" page: published projects only. Empty string when there are none. */
export function renderPublishedProjects(language: 'ar' | 'en', accountId: number = currentAccountId(), db: Database.Database = getDb()): string {
  return publishedProjects(accountId, db).slice(0, 8).map((p) => {
    const name = language === 'ar' && p.nameAr ? p.nameAr : p.nameEn;
    const where = [p.district, p.city].filter(Boolean).join(language === 'ar' ? '، ' : ', ');
    const kind = [p.propertyType, p.stage ? STAGE_LABEL[p.stage][language] : null].filter(Boolean).join(' · ');
    const summary = (language === 'ar' && p.summaryAr ? p.summaryAr : p.summaryEn ?? p.summaryAr ?? '').slice(0, 160);
    return `🏗️ ${name}${where ? ` — ${where}` : ''}${kind ? `\n${kind}` : ''}${summary ? `\n${summary}` : ''}`;
  }).join('\n\n');
}

// ---------------------------------------------------------------- leads

export interface Lead {
  id: number;
  accountId: number;
  customerId: number;
  reference: string;
  kind: LeadKind;
  status: LeadStatus;
  priority: 'normal' | 'high';
  language: string | null;
  summary: string | null;
  details: Record<string, string>;
  needsStaff: boolean;
  documentsStatus: DocumentStatus;
  consentNote: string | null;
  assignedAdminId: number | null;
  nextAction: string | null;
  followUpAt: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface LeadRow {
  id: number; whatsapp_account_id: number; customer_id: number; reference: string; kind: string; status: string; priority: string; language: string | null; summary: string | null;
  details: string; needs_staff: number; documents_status: string; consent_note: string | null; assigned_admin_id: number | null; next_action: string | null; follow_up_at: string | null;
  source: string; created_at: string; updated_at: string; closed_at: string | null;
}

function toLead(r: LeadRow): Lead {
  return {
    id: r.id, accountId: r.whatsapp_account_id, customerId: r.customer_id, reference: r.reference, kind: r.kind as LeadKind, status: r.status as LeadStatus, priority: r.priority === 'high' ? 'high' : 'normal',
    language: r.language, summary: r.summary, details: parseDetails(r.details), needsStaff: r.needs_staff === 1, documentsStatus: r.documents_status as DocumentStatus, consentNote: r.consent_note,
    assignedAdminId: r.assigned_admin_id, nextAction: r.next_action, followUpAt: r.follow_up_at, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at,
  };
}

function newReference(accountId: number, db: Database.Database): string {
  const year = new Date().getFullYear();
  for (let i = 0; i < 20; i += 1) {
    const ref = `RE-${year}-${1000 + crypto.randomInt(9000)}`;
    if (!db.prepare('SELECT 1 FROM real_estate_leads WHERE whatsapp_account_id = ? AND reference = ?').get(accountId, ref)) return ref;
  }
  return `RE-${year}-${Date.now()}`;
}

export function addLeadEvent(leadId: number, actor: string, event: string, detail: string | null, accountId: number = currentAccountId(), db: Database.Database = getDb()): void {
  db.prepare('INSERT INTO real_estate_lead_events (lead_id, whatsapp_account_id, actor, event, detail) VALUES (?, ?, ?, ?, ?)').run(leadId, accountId, actor, event, detail ? detail.slice(0, 500) : null);
}

export function getLead(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): Lead | null {
  const row = db.prepare('SELECT * FROM real_estate_leads WHERE id = ? AND whatsapp_account_id = ?').get(id, accountId) as LeadRow | undefined;
  return row ? toLead(row) : null;
}

/** The customer's open enquiries (for the assistant's context so it resumes instead of starting again). */
export function openLeadsForCustomer(customerId: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): Lead[] {
  const rows = db.prepare("SELECT * FROM real_estate_leads WHERE whatsapp_account_id = ? AND customer_id = ? AND status <> 'closed' ORDER BY id").all(accountId, customerId) as LeadRow[];
  return rows.map(toLead);
}

export interface AssistantLeadInput {
  customerId: number;
  kind: LeadKind;
  fields?: unknown;
  summary?: string | null;
  needsStaff?: boolean;
  projectIds?: number[];
  language?: string | null;
  documentsRequested?: boolean;
  consentNote?: string | null;
}

export interface AssistantLeadResult {
  lead: Lead;
  created: boolean;
  /** The enquiry just became (or was created) qualified: staff should hear about it once. */
  becameQualified: boolean;
  rejected: string[];
  sensitive: boolean;
  linkedProjects: number[];
}

/**
 * Creates the customer's enquiry of this kind, or merges the new answers into the open one (one open enquiry per customer and kind, enforced by
 * the database too). The assistant can set the status only between new / awaiting_info / qualified; a status staff chose is never overwritten.
 */
export function upsertLeadFromAssistant(input: AssistantLeadInput, accountId: number = currentAccountId(), db: Database.Database = getDb()): AssistantLeadResult {
  if (!(LEAD_KINDS as readonly string[]).includes(input.kind)) throw new RealEstateError('validation_failed', 'Unknown enquiry kind');
  const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND whatsapp_account_id = ?').get(input.customerId, accountId);
  if (!customer) throw new RealEstateError('customer_not_found', 'Customer not found', 404);
  const cleaned = sanitizeFields(input.fields);
  const summary = typeof input.summary === 'string' ? input.summary.replace(/\s+/g, ' ').trim().slice(0, 500) || null : null;

  return db.transaction((): AssistantLeadResult => {
    const row = db.prepare("SELECT * FROM real_estate_leads WHERE whatsapp_account_id = ? AND customer_id = ? AND kind = ? AND status <> 'closed'").get(accountId, input.customerId, input.kind) as LeadRow | undefined;
    const existing = row ? toLead(row) : null;
    const details = { ...(existing?.details ?? {}), ...cleaned.fields } as Record<string, string>;
    const qualified = isQualified(input.kind, details);
    const autoStatus: LeadStatus = qualified ? 'qualified' : Object.keys(details).length > 0 ? 'awaiting_info' : 'new';
    let lead: Lead;
    let created = false;
    if (!existing) {
      const needsStaff = input.needsStaff === true;
      const result = db.prepare(
        `INSERT INTO real_estate_leads (whatsapp_account_id, customer_id, reference, kind, status, priority, language, summary, details, needs_staff, documents_status, consent_note, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assistant')`,
      ).run(accountId, input.customerId, newReference(accountId, db), input.kind, autoStatus, needsStaff ? 'high' : 'normal', input.language ?? null, summary, JSON.stringify(details), needsStaff ? 1 : 0, input.documentsRequested ? 'requested' : 'not_requested', input.consentNote ? String(input.consentNote).slice(0, 300) : null);
      lead = getLead(Number(result.lastInsertRowid), accountId, db)!;
      created = true;
      addLeadEvent(lead.id, 'assistant', 'created', `${input.kind} enquiry started`, accountId, db);
    } else {
      const status = (AUTO_STATUSES as readonly string[]).includes(existing.status) ? autoStatus : existing.status;
      const needsStaff = existing.needsStaff || input.needsStaff === true;
      db.prepare(
        `UPDATE real_estate_leads SET status = ?, priority = ?, language = COALESCE(?, language), summary = COALESCE(?, summary), details = ?, needs_staff = ?,
           documents_status = CASE WHEN ? = 1 AND documents_status = 'not_requested' THEN 'requested' ELSE documents_status END,
           consent_note = COALESCE(?, consent_note), updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ?`,
      ).run(status, needsStaff ? 'high' : existing.priority, input.language ?? null, summary, JSON.stringify(details), needsStaff ? 1 : 0, input.documentsRequested ? 1 : 0, input.consentNote ? String(input.consentNote).slice(0, 300) : null, existing.id, accountId);
      lead = getLead(existing.id, accountId, db)!;
      if (Object.keys(cleaned.fields).length > 0 || status !== existing.status) addLeadEvent(lead.id, 'assistant', status !== existing.status ? 'status' : 'updated', `${Object.keys(cleaned.fields).join(', ') || 'status'} ${status !== existing.status ? `→ ${status}` : ''}`.trim(), accountId, db);
    }
    const linked: number[] = [];
    for (const projectId of [...new Set(input.projectIds ?? [])].slice(0, 5)) {
      const p = getProject(projectId, accountId, db);
      if (!p || !p.published || p.archived) continue; // only a published project of THIS business can be recorded as an interest
      db.prepare('INSERT OR IGNORE INTO real_estate_lead_projects (lead_id, project_id) VALUES (?, ?)').run(lead.id, projectId);
      linked.push(projectId);
    }
    const becameQualified = lead.status === 'qualified' && (created || existing?.status !== 'qualified');
    return { lead, created, becameQualified, rejected: cleaned.rejected, sensitive: cleaned.sensitive, linkedProjects: linked };
  })();
}

export interface LeadFilter {
  kind?: LeadKind | 'all';
  status?: LeadStatus | 'open' | 'all';
  q?: string;
  assignedAdminId?: number;
  followUpDue?: boolean;
  limit?: number;
  offset?: number;
}

export interface LeadListItem extends Lead {
  waId: string;
  displayName: string | null;
  projectCount: number;
}

export function listLeads(filter: LeadFilter = {}, accountId: number = currentAccountId(), db: Database.Database = getDb()): { items: LeadListItem[]; total: number } {
  const where = ['l.whatsapp_account_id = @acc'];
  const params: Record<string, unknown> = { acc: accountId };
  if (filter.kind && filter.kind !== 'all') { where.push('l.kind = @kind'); params.kind = filter.kind; }
  if (!filter.status || filter.status === 'open') where.push("l.status <> 'closed'");
  else if (filter.status !== 'all') { where.push('l.status = @status'); params.status = filter.status; }
  if (filter.assignedAdminId) { where.push('l.assigned_admin_id = @assignee'); params.assignee = filter.assignedAdminId; }
  if (filter.followUpDue) where.push("l.follow_up_at IS NOT NULL AND l.follow_up_at <= datetime('now') AND l.status <> 'closed'");
  if (filter.q && filter.q.trim()) { where.push("(l.reference LIKE @q OR l.summary LIKE @q OR l.details LIKE @q OR c.display_name LIKE @q OR c.wa_id LIKE @q)"); params.q = `%${filter.q.trim().slice(0, 80)}%`; }
  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
  const offset = Math.max(Number(filter.offset) || 0, 0);
  const base = `FROM real_estate_leads l JOIN customers c ON c.id = l.customer_id AND c.whatsapp_account_id = l.whatsapp_account_id WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params) as { n: number }).n;
  const rows = db.prepare(
    `SELECT l.*, c.wa_id AS wa_id, c.display_name AS display_name, (SELECT COUNT(*) FROM real_estate_lead_projects p WHERE p.lead_id = l.id) AS project_count ${base}
     ORDER BY CASE l.priority WHEN 'high' THEN 0 ELSE 1 END, l.updated_at DESC, l.id DESC LIMIT @limit OFFSET @offset`,
  ).all({ ...params, limit, offset }) as (LeadRow & { wa_id: string; display_name: string | null; project_count: number })[];
  return { items: rows.map((r) => ({ ...toLead(r), waId: r.wa_id, displayName: r.display_name, projectCount: r.project_count })), total };
}

export interface StaffLeadPatch {
  status?: unknown; priority?: unknown; assignedAdminId?: unknown; nextAction?: unknown; followUpAt?: unknown; documentsStatus?: unknown; note?: unknown;
}

/** A person's change to a lead: validated, scoped to the account, audited. */
export function updateLeadByStaff(id: number, patch: StaffLeadPatch, adminId: number, assigneeAllowed: (adminId: number) => boolean, accountId: number = currentAccountId(), db: Database.Database = getDb()): Lead {
  const lead = getLead(id, accountId, db);
  if (!lead) throw new RealEstateError('not_found', 'Lead not found', 404);
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, acc: accountId };
  const events: [string, string][] = [];
  if (patch.status !== undefined) {
    if (!(LEAD_STATUSES as readonly string[]).includes(String(patch.status))) throw new RealEstateError('validation_failed', 'Unknown lead status');
    sets.push('status = @status', "closed_at = CASE WHEN @status = 'closed' THEN datetime('now') ELSE NULL END");
    params.status = patch.status;
    if (patch.status !== lead.status) events.push(['status', `${lead.status} → ${patch.status}`]);
  }
  if (patch.priority !== undefined) {
    if (patch.priority !== 'normal' && patch.priority !== 'high') throw new RealEstateError('validation_failed', 'Priority must be normal or high');
    sets.push('priority = @priority');
    params.priority = patch.priority;
  }
  if (patch.assignedAdminId !== undefined) {
    if (patch.assignedAdminId === null || patch.assignedAdminId === '') { sets.push('assigned_admin_id = NULL'); events.push(['assigned', 'unassigned']); } else {
      const a = Number(patch.assignedAdminId);
      if (!Number.isInteger(a) || a <= 0 || !assigneeAllowed(a)) throw new RealEstateError('validation_failed', 'That person cannot be assigned to this business\'s leads');
      sets.push('assigned_admin_id = @assignee');
      params.assignee = a;
      events.push(['assigned', `assigned to staff ${a}`]);
    }
  }
  if (patch.nextAction !== undefined) { sets.push('next_action = @next'); params.next = text(patch.nextAction, 'Next action', 300); }
  if (patch.followUpAt !== undefined) {
    if (patch.followUpAt === null || patch.followUpAt === '') { sets.push('follow_up_at = NULL'); } else {
      const raw = String(patch.followUpAt);
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) throw new RealEstateError('validation_failed', 'Follow-up date is not valid');
      sets.push('follow_up_at = @followUp');
      params.followUp = parsed.toISOString().slice(0, 19).replace('T', ' ');
    }
  }
  if (patch.documentsStatus !== undefined) {
    if (!(DOCUMENT_STATUSES as readonly string[]).includes(String(patch.documentsStatus))) throw new RealEstateError('validation_failed', 'Unknown document status');
    sets.push('documents_status = @docs');
    params.docs = patch.documentsStatus;
    events.push(['documents', String(patch.documentsStatus)]);
  }
  const note = text(patch.note, 'Note', 500);
  if (note) events.push(['note', note]);
  if (sets.length > 0) {
    try {
      db.prepare(`UPDATE real_estate_leads SET ${sets.join(', ')}, needs_staff = CASE WHEN @status_set = 1 AND @status IN ('assigned','follow_up','closed') THEN 0 ELSE needs_staff END, updated_at = datetime('now') WHERE id = @id AND whatsapp_account_id = @acc`)
        .run({ status: null, ...params, status_set: patch.status !== undefined ? 1 : 0 });
    } catch (error) {
      if (/UNIQUE/i.test(String((error as Error).message))) throw new RealEstateError('conflict', 'This customer already has another open enquiry of the same kind', 409);
      throw error;
    }
  }
  for (const [event, detail] of events) addLeadEvent(id, `staff:${adminId}`, event, detail, accountId, db);
  return getLead(id, accountId, db)!;
}

export function leadEvents(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): { id: number; actor: string; event: string; detail: string | null; createdAt: string }[] {
  const rows = db.prepare('SELECT id, actor, event, detail, created_at FROM real_estate_lead_events WHERE lead_id = ? AND whatsapp_account_id = ? ORDER BY id DESC LIMIT 100').all(id, accountId) as { id: number; actor: string; event: string; detail: string | null; created_at: string }[];
  return rows.map((r) => ({ id: r.id, actor: r.actor, event: r.event, detail: r.detail, createdAt: r.created_at }));
}

export function leadProjects(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): Project[] {
  const rows = db.prepare('SELECT p.* FROM real_estate_projects p JOIN real_estate_lead_projects lp ON lp.project_id = p.id WHERE lp.lead_id = ? AND p.whatsapp_account_id = ? ORDER BY p.id').all(id, accountId) as ProjectRow[];
  return rows.map(toProject);
}

export interface Overview {
  leads: { total: number; open: number; byStatus: Record<string, number>; byKind: Record<string, number>; newToday: number; qualifiedUnassigned: number; followUpsDue: number; needsStaff: number };
  projects: { published: number; draft: number; archived: number };
  consultations: { pending: number; confirmed: number };
}

export function overview(accountId: number = currentAccountId(), db: Database.Database = getDb()): Overview {
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const byStatus: Record<string, number> = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM real_estate_leads WHERE whatsapp_account_id = ? GROUP BY status').all(accountId) as { status: string; n: number }[]) byStatus[r.status] = r.n;
  const byKind: Record<string, number> = Object.fromEntries(LEAD_KINDS.map((k) => [k, 0]));
  for (const r of db.prepare("SELECT kind, COUNT(*) AS n FROM real_estate_leads WHERE whatsapp_account_id = ? AND status <> 'closed' GROUP BY kind").all(accountId) as { kind: string; n: number }[]) byKind[r.kind] = r.n;
  return {
    leads: {
      total: count('SELECT COUNT(*) AS n FROM real_estate_leads WHERE whatsapp_account_id = ?', accountId),
      open: count("SELECT COUNT(*) AS n FROM real_estate_leads WHERE whatsapp_account_id = ? AND status <> 'closed'", accountId),
      byStatus, byKind,
      newToday: count("SELECT COUNT(*) AS n FROM real_estate_leads WHERE whatsapp_account_id = ? AND date(created_at) = date('now')", accountId),
      qualifiedUnassigned: count("SELECT COUNT(*) AS n FROM real_estate_leads WHERE whatsapp_account_id = ? AND status = 'qualified' AND assigned_admin_id IS NULL", accountId),
      followUpsDue: count("SELECT COUNT(*) AS n FROM real_estate_leads WHERE whatsapp_account_id = ? AND follow_up_at IS NOT NULL AND follow_up_at <= datetime('now') AND status <> 'closed'", accountId),
      needsStaff: count("SELECT COUNT(*) AS n FROM real_estate_leads WHERE whatsapp_account_id = ? AND needs_staff = 1 AND status <> 'closed'", accountId),
    },
    projects: {
      published: count('SELECT COUNT(*) AS n FROM real_estate_projects WHERE whatsapp_account_id = ? AND published = 1 AND archived = 0', accountId),
      draft: count('SELECT COUNT(*) AS n FROM real_estate_projects WHERE whatsapp_account_id = ? AND published = 0 AND archived = 0', accountId),
      archived: count('SELECT COUNT(*) AS n FROM real_estate_projects WHERE whatsapp_account_id = ? AND archived = 1', accountId),
    },
    consultations: {
      pending: count("SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = ? AND kind = 'appointment' AND status = 'pending'", accountId),
      confirmed: count("SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = ? AND kind = 'appointment' AND status IN ('confirmed','completed')", accountId),
    },
  };
}

export type { FieldKey };
