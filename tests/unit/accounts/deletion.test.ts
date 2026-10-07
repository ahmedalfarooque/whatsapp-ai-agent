import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount, getAccount, dataDir, grantAccountAccess, listAccounts } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { AccountDeletionError, deleteAccount, describeDeletion } from '../../../src/accounts/accountDeletion';
import { getOrCreateCustomer } from '../../../src/memory/customerRepo';
import { getOrCreateActiveConversation, appendMessage } from '../../../src/memory/conversationRepo';
import { createCustomerRequest } from '../../../src/memory/customerRequestRepo';
import { enqueueNotification } from '../../../src/notifications/outbox';
import { recordReplyActivity } from '../../../src/automation/settingsRepo';
import { createOffer } from '../../../src/offers/offerRepo';
import { listTemplates, publishTemplate } from '../../../src/templates/templateRepo';
import { saveDocument, uploadsDir, uploadsDirFor, documentPath } from '../../../src/documents/documentStore';
import { createLink } from '../../../src/setup/linksRepo';
import { createDraft } from '../../../src/setup/draftRepo';
import { emptyDraft } from '../../../src/setup/types';
import { saveMenuConfig, DEFAULT_GENERIC_MENU } from '../../../src/automation/menuConfig';
import { writeKnowledgeFile, listKnowledgeFiles } from '../../../src/dashboard/knowledgeAdmin';
import { knowledgeDirForAccount } from '../../../src/knowledge/paths';
import { claimWebhookEvent } from '../../../src/memory/webhookEventRepo';
import { updateBusinessSettings } from '../../../src/config/businessSettings';
import { updateAutomationSettings } from '../../../src/automation/settingsRepo';
import { TINY_PNG } from '../../fixtures/makePdf';

const ACCOUNT_TABLES: [string, string][] = [
  ['customers', 'whatsapp_account_id'], ['conversations', 'whatsapp_account_id'], ['customer_requests', 'whatsapp_account_id'],
  ['notification_outbox', 'whatsapp_account_id'], ['reply_activity', 'whatsapp_account_id'], ['business_documents', 'whatsapp_account_id'],
  ['offers', 'whatsapp_account_id'], ['reply_templates', 'whatsapp_account_id'], ['business_links', 'whatsapp_account_id'],
  ['setup_drafts', 'whatsapp_account_id'], ['account_menus', 'whatsapp_account_id'], ['business_settings', 'id'], ['automation_settings', 'id'],
];

function count(table: string, column: string, accountId: number): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(accountId) as { n: number }).n;
}
function snapshot(accountId: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [table, column] of ACCOUNT_TABLES) out[table] = count(table, column, accountId);
  out.messages = (getDb().prepare('SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE whatsapp_account_id = ?)').get(accountId) as { n: number }).n;
  out.requestEvents = (getDb().prepare('SELECT COUNT(*) AS n FROM request_events WHERE request_id IN (SELECT id FROM customer_requests WHERE whatsapp_account_id = ?)').get(accountId) as { n: number }).n;
  return out;
}

/** Fills one business with a row in every table and a file in every folder it owns. */
function populate(accountId: number): { upload: string; authFile: string; knowledgeFile: string | null } {
  runWithAccount(accountId, () => {
    const customer = getOrCreateCustomer(`96650000${accountId}001`, `Customer ${accountId}`);
    const conversation = getOrCreateActiveConversation(customer.id);
    appendMessage(conversation.id, { role: 'user', content: `hello ${accountId}` });
    const request = createCustomerRequest({ customerId: customer.id, waId: customer.wa_id, kind: 'appointment', payload: { name: 'X' } });
    getDb().prepare("INSERT INTO request_events (request_id, reference, old_status, new_status, actor) VALUES (?, ?, 'new', 'confirmed', 'dashboard')").run(request.id, request.reference);
    enqueueNotification({ dedupeKey: `d-${accountId}`, kind: 'business_new_request', requestId: request.id, targetJid: '966500000000@s.whatsapp.net', body: 'alert' });
    recordReplyActivity({ customerId: customer.id, waId: customer.wa_id, channel: 'qr', kind: 'rule' });
    createOffer({ titleAr: 'عرض', titleEn: `Offer ${accountId}` }, 'test');
    listTemplates(); // seeds this business's templates
    publishTemplate('human_support', { ar: `دعم ${accountId}`, en: `Support ${accountId}` }, 'test');
    createLink({ url: `https://biz${accountId}.example` });
    createDraft({ content: emptyDraft(), generator: 'rules', model: null, sources: {}, warnings: [], createdBy: 't' });
    if (accountId !== 1) saveMenuConfig(accountId, DEFAULT_GENERIC_MENU, 'manual');
    updateBusinessSettings({ descriptionEn: `Business ${accountId}` });
    updateAutomationSettings({ aiRepliesEnabled: false });
    claimWebhookEvent(accountId === 1 ? `qr:evt${accountId}` : `qr:${accountId}:evt`, 'test');
  });
  const doc = saveDocument({ originalName: 'catalogue.txt', mimeType: 'text/plain', bytes: Buffer.from(`catalogue ${accountId}`), accountId });
  saveDocument({ originalName: 'logo.png', mimeType: 'image/png', bytes: TINY_PNG, accountId, purpose: 'logo' });
  const authDir = path.join(dataDir(), accountId === 1 ? 'baileys-auth-test-account-1' : `accounts/${accountId}/baileys-auth`);
  fs.mkdirSync(authDir, { recursive: true });
  const authFile = path.join(authDir, 'creds.json');
  fs.writeFileSync(authFile, '{"secret":"session"}');
  // The original business's knowledge IS the repository's knowledge/ folder (tracked files): a test must never write there.
  if (accountId !== 1) writeKnowledgeFile('services.md', `# Services ${accountId}\n`, accountId);
  return { upload: documentPath(doc), authFile, knowledgeFile: accountId === 1 ? null : path.join(knowledgeDirForAccount(accountId), 'services.md') };
}

let two: number;
let three: number;
const files: Record<number, { upload: string; authFile: string; knowledgeFile: string | null }> = {};
let adminId: number;

beforeAll(() => {
  const db = getDb();
  adminId = Number(db.prepare("INSERT INTO admin_users (username, password_hash) VALUES ('owner', 'x')").run().lastInsertRowid);
  two = createAccount({ name: 'To be deleted' }).id;
  three = createAccount({ name: 'Must survive' }).id;
  grantAccountAccess(adminId, two);
  grantAccountAccess(adminId, three);
  for (const id of [1, two, three]) files[id] = populate(id);
});

const mockDeps = () => ({ discardConnection: vi.fn(async () => ({ loggedOut: true })) });

describe('deleting a WhatsApp account', () => {
  it('refuses the original business, a missing account, and anything but the exact word DELETE', async () => {
    const deps = mockDeps();
    await expect(deleteAccount(1, 'DELETE', deps)).rejects.toMatchObject({ status: 403, code: 'protected' });
    await expect(deleteAccount(9999, 'DELETE', deps)).rejects.toMatchObject({ status: 404 });
    for (const bad of [undefined, '', 'delete', 'Delete', 'DELETE ', true]) {
      await expect(deleteAccount(two, bad, deps)).rejects.toMatchObject({ status: 400, code: 'confirmation_required' });
    }
    expect(deps.discardConnection).not.toHaveBeenCalled();
    expect(getAccount(two)?.enabled).toBe(true); // a refused request changes nothing, not even "enabled"
    expect(getAccount(1)).toBeDefined();
  });

  it('describes what will be removed before the person confirms', () => {
    const preview = describeDeletion(two);
    expect(preview).toMatchObject({ accountId: two, name: 'To be deleted', protected: false });
    expect(preview.counts).toMatchObject({ customers: 1, conversations: 1, messages: 1, requests: 1, documents: 2, offers: 1, links: 1 });
    expect(preview.counts.templates).toBeGreaterThan(10);
    expect(describeDeletion(1).protected).toBe(true);
  });

  it('is atomic: if the database step fails nothing is deleted and no file is removed', async () => {
    const db = getDb();
    db.exec("CREATE TRIGGER block_delete BEFORE DELETE ON whatsapp_accounts BEGIN SELECT RAISE(ABORT, 'blocked for the test'); END;");
    const before = snapshot(two);
    await expect(deleteAccount(two, 'DELETE', mockDeps())).rejects.toThrow(/blocked for the test/);
    db.exec('DROP TRIGGER block_delete');
    expect(snapshot(two)).toEqual(before);
    expect(fs.existsSync(files[two]!.upload)).toBe(true);
    expect(fs.existsSync(files[two]!.authFile)).toBe(true);
    expect(fs.existsSync(files[two]!.knowledgeFile!)).toBe(true);
    // The account was disabled first so nothing restarts it mid-failure; re-enable as the operator would.
    getDb().prepare('UPDATE whatsapp_accounts SET enabled = 1 WHERE id = ?').run(two);
  });

  it('removes everything of the deleted business — rows, session, uploads, knowledge — and nothing of any other', async () => {
    const survivors = { one: snapshot(1), three: snapshot(three) };
    const sharedBefore = {
      admins: (getDb().prepare('SELECT COUNT(*) AS n FROM admin_users').get() as { n: number }).n,
      accounts: listAccounts().length,
    };
    const deps = { discardConnection: vi.fn(async (id: number) => { expect(getAccount(id)?.enabled).toBe(false); return { loggedOut: true }; }) };

    const report = await deleteAccount(two, 'DELETE', deps);
    expect(deps.discardConnection).toHaveBeenCalledWith(two);
    expect(report).toMatchObject({ accountId: two, name: 'To be deleted', loggedOut: true });
    expect(report.rows).toMatchObject({ customers: 1, conversations: 1, messages: 1, requests: 1, requestEvents: 1, outbox: 1, activity: 1, offers: 1, links: 1, drafts: 1, menus: 1, adminAccess: 1, account: 1 });
    expect(report.filesRemoved.length).toBeGreaterThan(0);

    // every account-owned row is gone
    expect(getAccount(two)).toBeUndefined();
    const gone = snapshot(two);
    for (const [table, n] of Object.entries(gone)) expect(n, table).toBe(0);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM admin_account_access WHERE whatsapp_account_id = ?').get(two) as { n: number }).n).toBe(0);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE message_id LIKE ?").get(`qr:${two}:%`) as { n: number }).n).toBe(0);
    // every file is gone
    expect(fs.existsSync(path.join(dataDir(), 'accounts', String(two)))).toBe(false);
    expect(fs.existsSync(uploadsDirFor(two))).toBe(false);
    expect(fs.existsSync(files[two]!.authFile)).toBe(false);
    expect(fs.existsSync(files[two]!.knowledgeFile!)).toBe(false);
    expect(fs.existsSync(knowledgeDirForAccount(two))).toBe(false);

    // the other businesses are exactly as they were
    expect(snapshot(1)).toEqual(survivors.one);
    expect(snapshot(three)).toEqual(survivors.three);
    expect(fs.existsSync(files[three]!.upload)).toBe(true);
    expect(fs.existsSync(files[three]!.authFile)).toBe(true);
    expect(fs.existsSync(files[three]!.knowledgeFile!)).toBe(true);
    expect(fs.existsSync(files[1]!.upload)).toBe(true);
    expect(listKnowledgeFiles(three).some((f) => f.exists)).toBe(true);
    // shared data survives
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM admin_users').get() as { n: number }).n).toBe(sharedBefore.admins);
    expect(listAccounts().length).toBe(sharedBefore.accounts - 1);
    expect(getDb().prepare('SELECT 1 FROM webhook_events WHERE message_id = ?').get('qr:evt1')).toBeTruthy();
    // and a deleted account cannot be deleted twice
    await expect(deleteAccount(two, 'DELETE', mockDeps())).rejects.toBeInstanceOf(AccountDeletionError);
  });

  it('also removes files an older version stored for the business in the shared upload folder', async () => {
    const four = createAccount({ name: 'Legacy layout' }).id;
    const legacyFile = path.join(uploadsDir(), 'legacy-layout-file.txt');
    fs.mkdirSync(uploadsDir(), { recursive: true });
    fs.writeFileSync(legacyFile, 'old upload');
    getDb().prepare(
      "INSERT INTO business_documents (original_name, stored_name, mime_type, extension, size_bytes, sha256, whatsapp_account_id) VALUES ('old.txt', 'legacy-layout-file.txt', 'text/plain', 'txt', 10, 'x', ?)",
    ).run(four);
    const neighbour = path.join(uploadsDir(), 'neighbour.txt');
    fs.writeFileSync(neighbour, 'someone else');
    await deleteAccount(four, 'DELETE', mockDeps());
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(fs.existsSync(neighbour)).toBe(true);
  });
});
