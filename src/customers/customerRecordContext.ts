import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { env } from '../config/env';

/**
 * The VERIFIED record of the customer who is writing now, as a short block for the assistant's prompt: who they are in this business's
 * records, what they asked before (older conversations included, not just the last hours), the status of their requests, callbacks and
 * files. Everything comes from this business's own tables for THIS customer (account and customer are both in every query), is bounded in
 * size, and is stated as recorded fact — the assistant is told to say "not recorded" for anything else. Staff-only internal notes and other
 * customers' data are never included. Nothing here writes: what the assistant says is never learned back as a fact.
 */
const clip = (text: string | null | undefined, n: number): string => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const day = (sqlTime: string | null | undefined): string => (sqlTime ?? '').slice(0, 10);

interface CustomerRow { id: number; display_name: string | null; wa_id: string; language: string | null; created_at: string; email: string | null; company_name: string | null }

export function customerRecordSection(customerId: number, scale = 1, db: Database.Database = getDb(), accountId: number = currentAccountId()): string {
  const customer = db.prepare('SELECT id, display_name, wa_id, language, created_at, email, company_name FROM customers WHERE id = ? AND whatsapp_account_id = ?').get(customerId, accountId) as CustomerRow | undefined;
  if (!customer) return '';
  const lines: string[] = [];
  const digits = customer.wa_id.replace(/\D/g, '');
  const phone = /^\d{8,15}$/.test(customer.wa_id) ? `+${digits}` : null;
  lines.push(`Customer: ${customer.display_name ? clip(customer.display_name, 60) : '(name not recorded)'}${phone ? `, WhatsApp number ${phone}` : ' (WhatsApp private id: no phone number recorded)'}${customer.email ? `, email ${clip(customer.email, 80)}` : ''}${customer.company_name ? `, company ${clip(customer.company_name, 60)}` : ''}; first contact ${day(customer.created_at)}${customer.language ? `; language ${customer.language}` : ''}.`);

  const requests = db.prepare(`SELECT reference, kind, status, created_at, payload FROM customer_requests WHERE customer_id = ? AND whatsapp_account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(customerId, accountId, scale < 0.5 ? 3 : 6) as Array<{ reference: string; kind: string; status: string; created_at: string; payload: string }>;
  if (requests.length) {
    lines.push('Requests (latest first):');
    for (const r of requests) {
      let service = '';
      try { const p = JSON.parse(r.payload) as Record<string, unknown>; service = typeof p.service === 'string' ? clip(p.service, 50) : ''; } catch { /* payload is optional detail */ }
      lines.push(`- ${r.reference} · ${r.kind} · status ${r.status}${service ? ` · ${service}` : ''} · ${day(r.created_at)}`);
    }
  } else lines.push('Requests: none recorded.');

  const callbacks = db.prepare(`SELECT reference, status, contact_method, requested_at, asap, created_at FROM followup_requests WHERE customer_id = ? AND whatsapp_account_id = ? AND status IN ('pending','scheduled','eligible','assigned','overdue') ORDER BY id DESC LIMIT 3`).all(customerId, accountId) as Array<{ reference: string; status: string; contact_method: string; requested_at: string | null; asap: number; created_at: string }>;
  if (callbacks.length) {
    lines.push('Open callback / staff-message requests:');
    for (const c of callbacks) lines.push(`- ${c.reference} · ${c.contact_method === 'whatsapp' ? 'WhatsApp message' : 'phone call'} · ${c.asap ? 'as soon as possible' : `at ${clip(c.requested_at, 16).replace('T', ' ')} UTC`} · status ${c.status}`);
  }

  const files = db.prepare(`SELECT direction, kind, original_name, created_at FROM customer_files WHERE customer_id = ? AND whatsapp_account_id = ? ORDER BY id DESC LIMIT ?`).all(customerId, accountId, scale < 0.5 ? 2 : 5) as Array<{ direction: string; kind: string; original_name: string | null; created_at: string }>;
  const fileCount = (db.prepare(`SELECT COUNT(*) AS n FROM customer_files WHERE customer_id = ? AND whatsapp_account_id = ?`).get(customerId, accountId) as { n: number }).n;
  if (fileCount) lines.push(`Files on record: ${fileCount} (${files.map((f) => `${f.direction === 'inbound' ? 'received' : 'sent'} ${f.kind}${f.original_name ? ` "${clip(f.original_name, 40)}"` : ''} ${day(f.created_at)}`).join('; ')}).`);

  if (scale >= 0.5) {
    const stats = db.prepare(`SELECT COUNT(DISTINCT c.id) AS conversations, COUNT(m.id) AS messages FROM conversations c LEFT JOIN conversation_messages m ON m.conversation_id = c.id AND m.role IN ('user','assistant') WHERE c.customer_id = ? AND c.whatsapp_account_id = ?`).get(customerId, accountId) as { conversations: number; messages: number };
    lines.push(`Conversation history on record: ${stats.conversations} conversation${stats.conversations === 1 ? '' : 's'}, ${stats.messages} messages in total.`);
    // What the customer said BEFORE the live history window (older conversations and older messages of this chat): their own words, dated.
    const older = db.prepare(
      `SELECT m.content, m.created_at FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.customer_id = ? AND c.whatsapp_account_id = ? AND m.role = 'user' AND m.direction = 'inbound' AND m.content NOT LIKE '[%'
         AND m.created_at < datetime('now', ?)
       ORDER BY m.id DESC LIMIT 4`,
    ).all(customerId, accountId, `-${Math.max(1, env.CONVERSATION_MEMORY_HOURS)} hours`) as Array<{ content: string; created_at: string }>;
    if (older.length) {
      lines.push('Earlier messages from this customer, before the recent conversation (their own words):');
      for (const o of older.reverse()) lines.push(`- ${day(o.created_at)}: "${clip(o.content, 140)}"`);
    }
  }

  return `\nCUSTOMER RECORD (verified records of THIS business about the customer who is writing now):\n${lines.join('\n')}\nRules for the record: use it to answer questions about this customer's identity, past requests, their status, callbacks, files and earlier conversations. State only what it says; if something is not in it (and not in the conversation) say it is not recorded and ask. It never describes any other customer. Do not guess the customer's relationship with the business beyond these records.\n`;
}
