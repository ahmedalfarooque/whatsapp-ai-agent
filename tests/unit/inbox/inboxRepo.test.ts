import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { getOrCreateCustomer } from '../../../src/memory/customerRepo';
import { appendMessage, getOrCreateActiveConversation, resetConversation } from '../../../src/memory/conversationRepo';
import { acceptHandoff, requestHandoff, resolveHandoff } from '../../../src/handoff/handoffRepo';
import { MAX_PAGE, MAX_THREAD_PAGE, inboxCounts, inboxRevision, listInbox, threadMessages, customerInAccount } from '../../../src/inbox/inboxRepo';

const STAFF = { type: 'staff' as const, adminId: 31, canManage: false };
const OTHER = { type: 'staff' as const, adminId: 32, canManage: false };
const VIEWER = 31;

let A: number;
let B: number;
let tick = 0;

type Msg = { role: 'user' | 'assistant' | 'tool'; content: string; type?: string; meta?: Record<string, unknown> };
/** One customer with a conversation. Message timestamps are set explicitly so ordering never depends on how fast the test runs. */
function seed(account: number, name: string | null, wa: string, msgs: Msg[], at = '2026-10-01 10:00:00') {
  const customer = runWithAccount(account, () => getOrCreateCustomer(wa, name ?? undefined));
  const conversation = runWithAccount(account, () => getOrCreateActiveConversation(customer.id));
  const base = new Date(`${at.replace(' ', 'T')}Z`).getTime();
  msgs.forEach((m, i) => {
    const row = appendMessage(conversation.id, { role: m.role, content: m.content, direction: m.role === 'user' ? 'inbound' : 'outbound', messageType: m.type ?? 'text', metadata: m.meta });
    getDb().prepare('UPDATE conversation_messages SET created_at = ? WHERE id = ?').run(new Date(base + i * 60_000 + ++tick).toISOString().slice(0, 19).replace('T', ' '), row.id);
  });
  return { customer, conversation };
}
const q = (query: Partial<Parameters<typeof listInbox>[0]> = {}, account = A) => listInbox({ viewerAdminId: VIEWER, ...query }, account);
const names = (query: Partial<Parameters<typeof listInbox>[0]> = {}, account = A) => q(query, account).items.map((i) => i.name ?? i.waId);

beforeAll(() => {
  getDb();
  A = createAccount({ name: 'Inbox A' }).id;
  B = createAccount({ name: 'Inbox B' }).id;
  // Account A — eight customers in every handling state
  seed(A, 'Khalid Al-Harbi', '966511000001', [{ role: 'user', content: 'Hello, quotation please' }, { role: 'assistant', content: 'Sure, what do you need?', meta: { templateKey: 'main_menu' } }], '2026-10-01 09:00:00');
  const sara = seed(A, 'سارة محمد', '966511000002', [{ role: 'user', content: 'أريد التحدث إلى موظف' }], '2026-10-02 09:00:00');
  requestHandoff({ customerId: sara.customer.id, conversationId: sara.conversation.id, source: 'customer' });
  const omar = seed(A, 'Omar Fahad', '966511000003', [{ role: 'user', content: 'Need a person' }, { role: 'assistant', content: 'On it', meta: { staff: true, staffAdminId: STAFF.adminId } }], '2026-10-03 09:00:00');
  const omarHandoff = requestHandoff({ customerId: omar.customer.id, source: 'customer' }).handoff;
  acceptHandoff(omarHandoff.id, STAFF, A);
  const noura = seed(A, 'Noura Ali', '966511000004', [{ role: 'user', content: 'Thanks!' }, { role: 'assistant', content: 'Glad to help' }], '2026-10-04 09:00:00');
  const nouraHandoff = requestHandoff({ customerId: noura.customer.id, source: 'customer' }).handoff;
  acceptHandoff(nouraHandoff.id, OTHER, A);
  resolveHandoff(nouraHandoff.id, OTHER, A);
  seed(A, null, '966511000005', [{ role: 'user', content: '100% sure? _wild_' }, { role: 'tool', content: '{"x":1}' }, { role: 'assistant', content: '[requested tools: web_search]' }], '2026-10-05 09:00:00');
  seed(A, 'Layla Hassan', '966511000006', [{ role: 'user', content: 'What are your hours?' }, { role: 'assistant', content: 'We open at nine.' }], '2026-10-06 09:00:00');
  seed(A, 'Faisal', '966511000007', [{ role: 'user', content: 'x'.repeat(400) }], '2026-10-07 09:00:00');
  seed(A, 'Photo Sender', '966511000008', [{ role: 'user', content: '[image] my contract', type: 'image' }], '2026-10-08 09:00:00');
  // Account B — must never appear in A's inbox
  const bCustomer = seed(B, 'Khalid Al-Harbi', '966511000001', [{ role: 'user', content: 'I am customer B' }], '2026-10-09 09:00:00');
  requestHandoff({ customerId: bCustomer.customer.id, source: 'customer' });
});

describe('listing and account scope', () => {
  it('lists one row per customer of the account only, newest activity first, with the latest real message as preview', () => {
    const { items, total } = q();
    expect(total).toBe(8);
    expect(items.map((i) => i.waId)).toEqual(['966511000008', '966511000007', '966511000006', '966511000005', '966511000004', '966511000003', '966511000002', '966511000001']);
    expect(items.some((i) => i.last.preview.includes('customer B'))).toBe(false);
    const byWa = Object.fromEntries(items.map((i) => [i.waId, i]));
    expect(byWa['966511000001']!.last).toMatchObject({ role: 'assistant', preview: 'Sure, what do you need?' });
    expect(byWa['966511000006']!.last.preview).toBe('We open at nine.');
    // who sent the last message: an automatic menu reply, the AI, or a named staff member's reply
    expect(byWa['966511000001']!.last.kind).toBe('auto');
    expect(byWa['966511000006']!.last.kind).toBe('ai');
    expect(byWa['966511000003']!.last.kind).toBe('staff');
    expect(byWa['966511000002']!.last.kind).toBe('customer');
    // the assistant's tool trail is not a message: customer 5's last visible message is the customer's own
    expect(byWa['966511000005']!.last).toMatchObject({ role: 'user', preview: '100% sure? _wild_' });
    expect(byWa['966511000008']!.last).toMatchObject({ type: 'image', preview: '[image] my contract' });
  });

  it('the other account sees only its own customers — the same phone number is a different row', () => {
    const { items, total } = q({}, B);
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ waId: '966511000001', name: 'Khalid Al-Harbi', handling: { state: 'HUMAN_REQUESTED' } });
    expect(items[0]!.last.preview).toBe('I am customer B');
  });

  it('long previews are cut, whitespace is collapsed, and the number is masked in the safe field', () => {
    const faisal = q({ q: 'Faisal' }).items[0]!;
    expect(faisal.last.preview.length).toBeLessThanOrEqual(141);
    expect(faisal.last.preview.endsWith('…')).toBe(true);
    expect(faisal.waIdMasked).toBe('********0007');
    expect(faisal.waIdMasked).not.toContain('96651100');
  });

  it('a customer who wrote in several conversations is still ONE row, whose latest message is the newest across them', () => {
    const { customer } = seed(A, 'Two Conversations', '966511000009', [{ role: 'user', content: 'first chat' }], '2026-10-10 09:00:00');
    const fresh = runWithAccount(A, () => resetConversation(customer.id));
    const row = appendMessage(fresh.id, { role: 'user', content: 'second chat', direction: 'inbound', messageType: 'text' });
    getDb().prepare("UPDATE conversation_messages SET created_at = '2026-10-10 10:00:00' WHERE id = ?").run(row.id);
    const rows = q({ q: 'Two Conversations' }).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last.preview).toBe('second chat');
    expect(rows[0]!.last.conversationId).toBe(fresh.id);
    expect(threadMessages(customer.id, {}, A).messages.map((m) => m.content)).toEqual(['first chat', 'second chat']);
  });

  it('shows who handles each conversation: AI, waiting, a named staff member, resolved', () => {
    const by = Object.fromEntries(q().items.map((i) => [i.waId, i.handling]));
    expect(by['966511000001']).toMatchObject({ state: 'AI_ACTIVE', handoffId: null, assignedAdminId: null });
    expect(by['966511000002']).toMatchObject({ state: 'HUMAN_REQUESTED', assignedAdminId: null, requestCount: 1 });
    expect(by['966511000003']).toMatchObject({ state: 'HUMAN_ACTIVE', assignedAdminId: STAFF.adminId });
    expect(by['966511000004']).toMatchObject({ state: 'RESOLVED', assignedAdminId: OTHER.adminId });
  });

  it('marks conversations where the customer wrote last (awaiting reply) — it is NOT an unread count', () => {
    const awaiting = q().items.filter((i) => i.needsReply).map((i) => i.waId).sort();
    expect(awaiting).toEqual(['966511000002', '966511000005', '966511000007', '966511000008', '966511000009']);
  });
});

describe('search, filters, sorting', () => {
  it('searches by name (English and Arabic, partial, case-insensitive) and by number (partial, with +, spaces or Arabic digits)', () => {
    expect(names({ q: 'khalid' })).toEqual(['Khalid Al-Harbi']);
    expect(names({ q: 'سارة' })).toEqual(['سارة محمد']);
    expect(names({ q: 'محمد' })).toEqual(['سارة محمد']);
    expect(names({ q: '511000003' })).toEqual(['Omar Fahad']);
    expect(names({ q: '+966 511 000 004' })).toEqual(['Noura Ali']);
    expect(names({ q: '٩٦٦٥١١٠٠٠٠٠٦' })).toEqual(['Layla Hassan']);
    expect(names({ q: 'no such customer' })).toEqual([]);
  });

  it('treats % and _ in the search literally, and ignores a one-or-two-digit number fragment instead of matching everyone', () => {
    expect(names({ q: '%' })).toEqual([]);
    expect(names({ q: '_' })).toEqual([]);
    expect(names({ q: "'; DROP TABLE customers; --" })).toEqual([]);
    expect(q({ q: '96' }).total).toBe(0);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM customers').get()).not.toEqual({ n: 0 });
  });

  it('filters by handling state', () => {
    expect(names({ handling: 'waiting' })).toEqual(['سارة محمد']);
    expect(names({ handling: 'in_progress' })).toEqual(['Omar Fahad']);
    expect(names({ handling: 'resolved' })).toEqual(['Noura Ali']);
    expect(q({ handling: 'ai' }).total).toBe(6);
    expect(q({ handling: 'needs_reply' }).total).toBe(5);
    expect(q({ handling: 'all' }).total).toBe(9);
  });

  it('filters by assigned staff member: me, unassigned (waiting), or a specific person', () => {
    expect(names({ assignee: 'me' })).toEqual(['Omar Fahad']);
    expect(names({ assignee: 'unassigned' })).toEqual(['سارة محمد']);
    expect(names({ assignee: OTHER.adminId })).toEqual(['Noura Ali']);
    expect(names({ assignee: 987 })).toEqual([]);
  });

  it('combines search, state and assignee', () => {
    expect(names({ q: 'o', handling: 'in_progress', assignee: 'me' })).toEqual(['Omar Fahad']);
    expect(names({ q: 'Omar', handling: 'resolved' })).toEqual([]);
  });

  it('sorts by recent activity by default and can put the customers waiting for staff first', () => {
    expect(names().slice(0, 2)).toEqual(['Two Conversations', 'Photo Sender']);
    const first = q({ sort: 'waiting_first' }).items;
    expect(first[0]!.handling.state).toBe('HUMAN_REQUESTED');
    expect(first.slice(1).every((i) => i.handling.state !== 'HUMAN_REQUESTED')).toBe(true);
    // everything after the waiting ones is still newest-first
    const rest = first.slice(1).map((i) => i.last.at);
    expect([...rest].sort().reverse()).toEqual(rest);
  });

  it('counts for the filter chips', () => {
    expect(inboxCounts(A)).toEqual({ all: 9, waiting: 1, in_progress: 1, ai: 6, resolved: 1, needs_reply: 5 });
    expect(inboxCounts(B)).toMatchObject({ all: 1, waiting: 1, ai: 0 });
  });
});

describe('pagination', () => {
  it('pages without gaps or repeats and reports the real total', () => {
    const all = q({ limit: 100 }).items.map((i) => i.customerId);
    const seen: number[] = [];
    for (let offset = 0; offset < all.length; offset += 4) {
      const page = q({ limit: 4, offset });
      expect(page.total).toBe(all.length);
      expect(page.items.length).toBeLessThanOrEqual(4);
      seen.push(...page.items.map((i) => i.customerId));
    }
    expect(seen).toEqual(all);
  });

  it('clamps silly values: limit to 1..100, offset to 0, and an offset past the end is an empty page, not an error', () => {
    expect(q({ limit: 100000 }).limit).toBe(MAX_PAGE);
    expect(q({ limit: 0 }).limit).toBe(1);
    expect(q({ limit: -5 }).limit).toBe(1);
    expect(q({ offset: -10 }).offset).toBe(0);
    expect(q({ offset: 5000 })).toMatchObject({ items: [], total: 9 });
    expect(q({ limit: Number.NaN as unknown as number }).limit).toBe(25);
  });

  it('a list page costs a fixed number of queries however many conversations there are (no per-row lookups)', () => {
    const db = getDb();
    let prepares = 0;
    const counting = new Proxy(db, { get: (target, prop) => (prop === 'prepare' ? (sql: string) => { prepares += 1; return target.prepare(sql); } : Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop)) });
    listInbox({ viewerAdminId: VIEWER, limit: 100 }, A, counting as typeof db);
    expect(prepares).toBeLessThanOrEqual(2);
    prepares = 0;
    threadMessages(1, { limit: 100 }, A, counting as typeof db);
    expect(prepares).toBeLessThanOrEqual(4);
  });
});

describe('revision (what the browser polls)', () => {
  it('changes when a message arrives or a handoff changes in THIS account, and not when another account changes', () => {
    const before = inboxRevision(A);
    const beforeB = inboxRevision(B);
    expect(inboxRevision(A)).toBe(before); // stable while nothing happens
    const { conversation } = seed(A, 'Revision Test', '966511000010', [{ role: 'user', content: 'ping' }], '2026-10-11 09:00:00');
    const afterMessage = inboxRevision(A);
    expect(afterMessage).not.toBe(before);
    expect(inboxRevision(B)).toBe(beforeB);
    appendMessage(conversation.id, { role: 'assistant', content: 'pong', direction: 'outbound', messageType: 'text' });
    expect(inboxRevision(A)).not.toBe(afterMessage);
    const handoff = requestHandoff({ customerId: conversation.customer_id, source: 'customer' }).handoff;
    const afterHandoff = inboxRevision(A);
    getDb().prepare("UPDATE human_handoffs SET updated_at = datetime('now', '+1 second') WHERE id = ?").run(handoff.id);
    expect(inboxRevision(A)).not.toBe(afterHandoff);
    expect(inboxRevision(B)).toBe(beforeB);
  });
});

describe('a customer\'s conversation', () => {
  it('shows customer, automatic, AI and staff messages distinctly, in order, with the staff member\'s name and only a "sent" status on staff replies', () => {
    const { customer, conversation } = seed(A, 'Kinds', '966511000011', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Welcome menu', meta: { templateKey: 'main_menu' } },
      { role: 'user', content: 'tell me about prices' },
      { role: 'assistant', content: 'Prices depend on the service.' },
      { role: 'assistant', content: 'Hello, this is a person', meta: { staff: true, staffAdminId: 31, handoffId: 1 } },
    ], '2026-10-12 09:00:00');
    getDb().prepare("INSERT OR IGNORE INTO admin_users (id, username, password_hash, display_name) VALUES (31, 'staff31@example.com', 'x', 'Sam Staff')").run();
    const { messages } = threadMessages(customer.id, {}, A);
    expect(messages.map((m) => m.kind)).toEqual(['customer', 'auto', 'customer', 'ai', 'staff']);
    expect(messages.map((m) => m.direction)).toEqual(['inbound', 'outbound', 'inbound', 'outbound', 'outbound']);
    expect(messages[4]).toMatchObject({ staffAdminId: 31, staffName: 'Sam Staff', status: 'sent' });
    expect(messages.filter((m) => m.kind !== 'staff').every((m) => m.status === null)).toBe(true); // never an invented delivery state
    expect(messages.map((m) => m.id)).toEqual([...messages.map((m) => m.id)].sort((a, b) => a - b));
    expect(messages.every((m) => m.conversationId === conversation.id)).toBe(true);
  });

  it('keeps media messages as typed (kind of file + caption) and hides the assistant\'s tool trail', () => {
    const photo = q({ q: 'Photo Sender' }).items[0]!;
    const { messages } = threadMessages(photo.customerId, {}, A);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'image', content: '[image] my contract', kind: 'customer' });
    const tools = q({ q: '966511000005' }).items[0]!;
    expect(threadMessages(tools.customerId, {}, A).messages.map((m) => m.content)).toEqual(['100% sure? _wild_']);
  });

  it('pages back through history, returns only what is new after a known id, and never more than the cap', () => {
    const many: Msg[] = Array.from({ length: 130 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` } as Msg));
    const { customer } = seed(A, 'Long Thread', '966511000012', many, '2026-10-13 09:00:00');
    const newest = threadMessages(customer.id, { limit: 50 }, A);
    expect(newest.messages).toHaveLength(50);
    expect(newest.messages.at(-1)!.content).toBe('m129');
    expect(newest.hasMore).toBe(true);
    const older = threadMessages(customer.id, { before: newest.oldestId!, limit: 50 }, A);
    expect(older.messages.at(-1)!.id).toBeLessThan(newest.oldestId!);
    expect(older.messages[0]!.content).toBe('m30');
    const oldest = threadMessages(customer.id, { before: older.oldestId!, limit: 50 }, A);
    expect(oldest.messages).toHaveLength(30);
    expect(oldest.hasMore).toBe(false);
    expect(threadMessages(customer.id, { limit: 100000 }, A).messages).toHaveLength(Math.min(130, MAX_THREAD_PAGE));
    // incremental refresh: nothing new, then exactly the new message
    expect(threadMessages(customer.id, { after: newest.latestId }, A).messages).toEqual([]);
    const conversationId = newest.messages[0]!.conversationId;
    appendMessage(conversationId, { role: 'user', content: 'brand new', direction: 'inbound', messageType: 'text' });
    const fresh = threadMessages(customer.id, { after: newest.latestId }, A);
    expect(fresh.messages.map((m) => m.content)).toEqual(['brand new']);
    expect(fresh.latestId).toBeGreaterThan(newest.latestId);
  });

  it('another account can neither read the thread nor find the customer', () => {
    const khalidA = q({ q: 'Khalid' }).items[0]!;
    expect(threadMessages(khalidA.customerId, {}, B).messages).toEqual([]);
    expect(customerInAccount(khalidA.customerId, B)).toBeUndefined();
    expect(customerInAccount(khalidA.customerId, A)).toMatchObject({ wa_id: '966511000001' });
    expect(customerInAccount(987654, A)).toBeUndefined();
  });

  it('a new inbound message lands in the right customer\'s row and moves it to the top', () => {
    const target = q({ q: 'Layla' }).items[0]!;
    const conversation = (getDb().prepare('SELECT id FROM conversations WHERE customer_id = ? ORDER BY id DESC').get(target.customerId) as { id: number }).id;
    const row = appendMessage(conversation, { role: 'user', content: 'Are you open on Friday?', direction: 'inbound', messageType: 'text' });
    getDb().prepare("UPDATE conversation_messages SET created_at = '2030-01-01 00:00:00' WHERE id = ?").run(row.id);
    const top = q().items[0]!;
    expect(top.customerId).toBe(target.customerId);
    expect(top.last.preview).toBe('Are you open on Friday?');
    expect(top.needsReply).toBe(true);
    expect(q({}, B).items[0]!.last.preview).toBe('I am customer B');
  });
});
