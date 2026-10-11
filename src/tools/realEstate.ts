import fs from 'node:fs';
import { TOOL_NAMES } from '../config/constants';
import { getDb } from '../memory/db';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import { getCustomerFlowData, setCustomerMenuState } from '../memory/customerRepo';
import { MENU_STATES } from '../automation/menuStatic';
import { documentPath, getDocument } from '../documents/documentStore';
import { sendDocumentMessage, DocumentDeliveryUnsupportedError } from '../whatsapp/client';
import { enqueueNotification } from '../notifications/outbox';
import { businessNotificationJid, kickOutbox } from '../requests/requestService';
import { FIELD_KEYS, FIELD_LABELS, LEAD_KINDS, missingFields, nextQuestions } from '../realestate/leadFields';
import { RealEstateError, getProject, searchPublishedProjects, upsertLeadFromAssistant, publishedProjects, type Lead } from '../realestate/realEstateRepo';

/**
 * The three tools of the real estate assistant (offered ONLY to a business with the real estate add-on, see tools/index.ts).
 * Every handler works through the conversation it runs in, so it can only touch THIS customer of THIS business, and reads only
 * this business's published projects. Nothing here can create inventory, a price or a booking.
 */

interface ConversationRow { customerId: number; waId: string; language: string | null; menuState: string | null; displayName: string | null }

function conversationCustomer(conversationId: number): ConversationRow | null {
  const row = getDb()
    .prepare(
      `SELECT c.customer_id AS customerId, cu.wa_id AS waId, cu.language AS language, cu.menu_state AS menuState, cu.display_name AS displayName
         FROM conversations c JOIN customers cu ON cu.id = c.customer_id WHERE c.id = ? AND c.whatsapp_account_id = ? AND cu.whatsapp_account_id = c.whatsapp_account_id`,
    )
    .get(conversationId, currentAccountId()) as ConversationRow | undefined;
  return row ?? null;
}

const fieldProps = Object.fromEntries(FIELD_KEYS.map((k) => [k, { type: ['string', 'number'], maxLength: 300, description: FIELD_LABELS[k] }]));

export const saveRealEstateLeadSchema = {
  type: 'function' as const,
  function: {
    name: TOOL_NAMES.SAVE_REAL_ESTATE_LEAD,
    description:
      'Save or update THIS customer\'s real estate enquiry (buying, selling, investing or a general enquiry) with what they have told you so far. Call it every time the customer gives new requirements or corrects an earlier answer (send only the new or corrected fields; earlier answers are kept). It resumes the open enquiry instead of creating a duplicate. It does NOT book anything and does not make the team available: never say a callback or consultation is arranged because of it. Do not put identity numbers, bank or card numbers in any field.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...LEAD_KINDS], description: 'buyer = wants to buy; seller = wants to sell/list a property; investor = development/investment/asset enquiry; general = anything else real-estate related.' },
        fields: { type: 'object', description: 'Short answers in the customer\'s own words. Only these keys are stored.', properties: fieldProps },
        summary: { type: 'string', maxLength: 500, description: 'One or two sentences a staff member can read to understand the enquiry without asking again.' },
        needs_staff: { type: 'boolean', description: 'true only when a person should follow up with priority (asked for an advisor, high intent, urgent, or a legal/ownership question you cannot answer).' },
        interested_project_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Ids from search_real_estate_projects the customer asked about.' },
        documents_requested: { type: 'boolean', description: 'true only if you told the customer a person will request documents through a secure process.' },
      },
      required: ['kind'],
    },
  },
};

export const searchRealEstateProjectsSchema = {
  type: 'function' as const,
  function: {
    name: TOOL_NAMES.SEARCH_REAL_ESTATE_PROJECTS,
    description:
      'Look up this business\'s PUBLISHED, verified projects. The result is the ONLY source for any project you mention: name, location, property type, stage and summary exactly as recorded. If nothing matches, there is no such published project — say the team will review the requirements; never describe, name or imply one.',
    parameters: {
      type: 'object',
      properties: {
        property_type: { type: 'string', maxLength: 80, description: 'e.g. apartment, villa, land, office' },
        city: { type: 'string', maxLength: 80 },
        query: { type: 'string', maxLength: 120, description: 'A project name or keyword.' },
      },
      required: [],
    },
  },
};

export const sendProjectBrochureSchema = {
  type: 'function' as const,
  function: {
    name: TOOL_NAMES.SEND_PROJECT_BROCHURE,
    description: 'Send the official brochure (PDF or image) of ONE published project to this customer on WhatsApp. Works only for a project id returned by search_real_estate_projects that has a brochure. If it returns sent:false, tell the customer the team will share the details.',
    parameters: { type: 'object', properties: { project_id: { type: 'integer', minimum: 1 } }, required: ['project_id'] },
  },
};

const LEAD_ALERT = (lead: Lead, customerName: string | null, waId: string, why: string): string => {
  const d = lead.details;
  const lines = [
    `🏠 Real estate enquiry ${lead.reference} — ${lead.kind} (${why})`,
    `Customer: ${customerName || '—'} · ${waId}`,
    lead.summary ? `Summary: ${lead.summary}` : null,
    ...(['property_type', 'city', 'district', 'budget', 'currency', 'asking_price', 'timeframe', 'preferred_contact', 'callback_time'] as const).filter((k) => d[k]).map((k) => `${FIELD_LABELS[k]}: ${d[k]}`),
    'Open Real Estate → Leads in the dashboard to follow up.',
  ];
  return lines.filter(Boolean).join('\n');
};

function alertStaff(lead: Lead, customer: ConversationRow, why: string, key: string): void {
  try {
    const target = businessNotificationJid(getDb(), lead.accountId);
    if (!target) { logger.warn({ reference: lead.reference, account: lead.accountId }, 'no business WhatsApp number linked — real estate staff alert not queued'); return; }
    enqueueNotification({ kind: 'business_new_request', requestId: null, targetJid: target, body: LEAD_ALERT(lead, customer.displayName, customer.waId, why), dedupeKey: `re-lead:${key}:${lead.accountId}:${lead.id}`, accountId: lead.accountId });
    kickOutbox();
  } catch (error) {
    logger.error({ error, reference: lead.reference }, 'could not queue the real estate staff alert');
  }
}

export async function saveRealEstateLeadHandler(args: unknown, context: { conversationId: number }): Promise<unknown> {
  const a = (args ?? {}) as { kind?: string; fields?: unknown; summary?: string; needs_staff?: boolean; interested_project_ids?: number[]; documents_requested?: boolean };
  const customer = conversationCustomer(context.conversationId);
  if (!customer) return { error: 'conversation_not_found' };
  try {
    const result = upsertLeadFromAssistant({
      customerId: customer.customerId, kind: a.kind as never, fields: a.fields, summary: a.summary ?? null, needsStaff: a.needs_staff === true,
      projectIds: Array.isArray(a.interested_project_ids) ? a.interested_project_ids.filter((n) => Number.isInteger(n)) : [], language: customer.language, documentsRequested: a.documents_requested === true,
    });
    const { lead } = result;
    // From now on the customer's plain answers (including single digits such as "3 bedrooms") go to the assistant, until they send 0 or "menu".
    if (!customer.menuState || customer.menuState === MENU_STATES.MAIN_MENU) {
      const full = getDb().prepare('SELECT flow_data FROM customers WHERE id = ?').get(customer.customerId) as { flow_data: string | null };
      setCustomerMenuState(customer.customerId, MENU_STATES.REAL_ESTATE_CHAT, getCustomerFlowData(full));
    }
    if (result.becameQualified) alertStaff(lead, customer, 'qualified', 'qualified');
    else if (result.created && lead.needsStaff) alertStaff(lead, customer, 'asked for a person', 'staff');
    const still = missingFields(lead.kind, lead.details);
    return {
      ok: true,
      reference: lead.reference,
      status: lead.status,
      created: result.created,
      still_missing: still.map((k) => FIELD_LABELS[k]),
      ask_next: nextQuestions(lead.kind, lead.details).map((k) => FIELD_LABELS[k]),
      linked_projects: result.linkedProjects,
      ...(result.sensitive ? { warning: 'Something that looks like an identity, bank or card number was NOT stored. Tell the customer, kindly, not to share such details in this chat; the team will explain how to provide documents securely.' } : {}),
      note: 'Saved for the team. Nothing is booked or confirmed. Tell the customer the team will review it and follow up; never promise a time.',
    };
  } catch (error) {
    if (error instanceof RealEstateError) return { error: error.code, message: error.message };
    throw error;
  }
}

export async function searchRealEstateProjectsHandler(args: unknown): Promise<unknown> {
  const a = (args ?? {}) as { property_type?: string; city?: string; query?: string };
  const matches = searchPublishedProjects({ propertyType: a.property_type, city: a.city, query: a.query });
  const total = publishedProjects().length;
  return {
    published_projects: total,
    matches: matches.map((p) => ({ id: p.id, name_en: p.nameEn, name_ar: p.nameAr, city: p.city, district: p.district, property_type: p.propertyType, stage: p.stage, summary: p.summaryEn ?? p.summaryAr, has_brochure: p.brochureDocumentId !== null })),
    ...(matches.length === 0 ? { note: total === 0 ? 'No project is published yet. Do not name or describe any project; say our team will review the customer\'s requirements.' : 'No published project matches. Do not invent one; offer a follow-up by the team.' } : {}),
  };
}

export async function sendProjectBrochureHandler(args: unknown, context: { conversationId: number }): Promise<unknown> {
  const projectId = Number((args as { project_id?: unknown })?.project_id);
  const customer = conversationCustomer(context.conversationId);
  if (!customer) return { sent: false, error: 'conversation_not_found' };
  const project = Number.isInteger(projectId) ? getProject(projectId) : null;
  if (!project || !project.published || project.archived) return { sent: false, reason: 'not_available' };
  if (project.brochureDocumentId === null) return { sent: false, reason: 'no_brochure' };
  const doc = getDocument(project.brochureDocumentId, getDb(), currentAccountId());
  if (!doc || doc.status !== 'active' || doc.visibility !== 'customer') return { sent: false, reason: 'not_available' };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(documentPath(doc));
  } catch {
    logger.warn({ account: currentAccountId(), documentId: doc.id }, 'project brochure could not be read');
    return { sent: false, reason: 'file_unavailable' };
  }
  const name = customer.language === 'ar' && project.nameAr ? project.nameAr : project.nameEn;
  try {
    await sendDocumentMessage(customer.waId, { fileName: doc.original_name, mimeType: doc.mime_type, bytes, caption: name });
  } catch (error) {
    if (error instanceof DocumentDeliveryUnsupportedError) return { sent: false, reason: 'channel_cannot_send_files' };
    logger.error({ account: currentAccountId(), documentId: doc.id, errorName: (error as Error)?.name }, 'project brochure could not be sent');
    return { sent: false, reason: 'send_failed' };
  }
  return { sent: true, note: 'The brochure was sent as a WhatsApp file. Do not describe its contents beyond the project summary.' };
}
