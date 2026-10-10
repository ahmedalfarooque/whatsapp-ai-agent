import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/whatsapp/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/whatsapp/client')>();
  return { ...real, sendTextMessage: vi.fn(), sendInteractiveMessage: vi.fn(), sendImageMessage: vi.fn(), sendDocumentMessage: vi.fn() };
});
vi.mock('../../../src/llm/agentLoop', () => ({ runAgentLoop: vi.fn().mockResolvedValue({ finalText: 'AI reply', generatedMessages: [] }) }));

import { sendTextMessage, sendImageMessage, sendDocumentMessage } from '../../../src/whatsapp/client';
import { processInboundMessage } from '../../../src/pipeline/processInboundMessage';
import { getDb } from '../../../src/memory/db';
import { createAccount, getAccount, listAccounts, authDirFor } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { provisionBlueprint } from '../../../src/accounts/blueprint';
import { QMULATE_BLUEPRINT, QMULATE_MENU } from '../../../src/accounts/blueprints/qmulate';
import { getBusinessSettings, updateBusinessSettings } from '../../../src/config/businessSettings';
import { getMenuConfig, saveMenuConfig, MAX_MENU_ITEMS } from '../../../src/automation/menuConfig';
import { listTemplates, publishTemplate, renderTemplateText, resolveTemplate } from '../../../src/templates/templateRepo';
import { documentPath, getDocument } from '../../../src/documents/documentStore';
import { createOffer, setOfferStatus } from '../../../src/offers/offerRepo';
import { listLinks } from '../../../src/setup/linksRepo';
import { knowledgeDirForAccount, writeKnowledgeFile, readKnowledgeFile } from '../../../src/dashboard/knowledgeAdmin';
import { loadKnowledgeBase } from '../../../src/knowledge/loader';
import { buildSystemPrompt } from '../../../src/llm/buildSystemPrompt';

const KNOWLEDGE_EMPTY = { sections: [], asPromptText: '' };
/** Words that belong to the two existing businesses and must never appear anywhere in QMULATE's content. */
const FOREIGN = /rowad|jotun|\balfa\b|\bppf\b|car audio|dashcam|window tint/i;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('qmulate-test-logo-bytes')]);

const ACC1 = 1;
let ACC2: number;
let Q: number; // QMULATE
let logoFile: string;
let counter = 0;
let before1: string;
let before2: string;

const sent: string[] = [];
const sentNow = () => sent.splice(0, sent.length);

/** Everything stored for one account, as one hash: every account-scoped table plus its profile, automation and menu rows. */
function fingerprint(accountId: number): string {
  const db = getDb();
  const parts: unknown[] = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
    if (cols.some((c) => c.name === 'whatsapp_account_id')) parts.push([name, db.prepare(`SELECT * FROM ${name} WHERE whatsapp_account_id = ? ORDER BY rowid`).all(accountId)]);
  }
  parts.push(db.prepare('SELECT * FROM whatsapp_accounts WHERE id = ?').get(accountId));
  parts.push(db.prepare('SELECT * FROM business_settings WHERE id = ?').get(accountId));
  parts.push(db.prepare('SELECT * FROM automation_settings WHERE id = ?').get(accountId));
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function say(waId: string, text: string, accountId = Q): Promise<string[]> {
  sentNow();
  await processInboundMessage({ waId, messageId: `wamid.qm.${accountId}.${++counter}`, timestamp: Date.now(), type: 'text', text, accountId }, { knowledge: KNOWLEDGE_EMPTY });
  return sentNow();
}
const newCustomer = () => `96655${String(++counter).padStart(7, '0')}`;
/** A customer who already picked a language and stands on the main menu. */
async function onMainMenu(language: 'en' | 'ar' = 'en', accountId = Q): Promise<string> {
  const waId = newCustomer();
  await say(waId, 'hi', accountId);
  await say(waId, language === 'ar' ? '1' : '2', accountId);
  return waId;
}

beforeAll(() => {
  getDb();
  // A second, unrelated business with its own content, fully set up BEFORE provisioning so any change to it shows up.
  ACC2 = createAccount({ name: 'JOTUN Test Fixture', nameAr: 'جوتن' }).id;
  updateBusinessSettings({ descriptionEn: 'Paints fixture description', contactEmail: 'fixture@example.com' }, ACC2);
  saveMenuConfig(ACC2, { version: 1, items: [{ id: 'about', kind: 'info', labelEn: 'About', labelAr: 'عن' }, { id: 'offers', kind: 'offers', labelEn: 'Offers', labelAr: 'العروض' }] }, 'manual');
  runWithAccount(ACC2, () => {
    listTemplates();
    publishTemplate('menu_about', { ar: 'نص جوتن', en: 'Jotun fixture page' }, 'test');
    const offer = createOffer({ titleAr: 'عرض جوتن', titleEn: 'Jotun fixture offer', descriptionEn: 'd', descriptionAr: 'د' }, 'test', undefined, ACC2);
    setOfferStatus(offer.id, 'published', 'test', undefined, ACC2);
  });
  writeKnowledgeFile('services.md', '# Jotun fixture knowledge', ACC2);
  runWithAccount(ACC1, () => listTemplates());
  before1 = fingerprint(ACC1);
  before2 = fingerprint(ACC2);
  logoFile = path.join(os.tmpdir(), `qmulate-test-logo-${process.pid}.png`);
  fs.writeFileSync(logoFile, PNG);
});

afterAll(() => fs.rmSync(logoFile, { force: true }));

beforeEach(() => {
  vi.mocked(sendTextMessage).mockReset().mockImplementation(async (_to, body) => { sent.push(String(body)); return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 't' }] }; });
  vi.mocked(sendImageMessage).mockReset().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'i' }] });
  vi.mocked(sendDocumentMessage).mockReset().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'd' }] });
});

describe('provisioning the QMULATE account', () => {
  let result: ReturnType<typeof provisionBlueprint>;

  beforeAll(() => {
    result = provisionBlueprint(QMULATE_BLUEPRINT, { actor: 'test', logo: { path: logoFile, originalName: 'qmulate-logo.png' } });
    Q = result.accountId;
  });

  it('creates exactly ONE new account, after the two existing ones, and nothing is sent to anyone', () => {
    expect(result.created).toBe(true);
    expect(listAccounts().map((a) => a.id)).toEqual([ACC1, ACC2, Q]);
    expect(Q).toBeGreaterThan(ACC2);
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(sendImageMessage).not.toHaveBeenCalled();
    expect(sendDocumentMessage).not.toHaveBeenCalled();
  });

  it('is an unpaired QR account: no phone number, no JID, never "connected", its own empty Baileys auth directory', () => {
    const account = getAccount(Q)!;
    expect(account).toMatchObject({ name: 'QMULATE Real Estate Consultancy', nameAr: 'QMULATE للاستشارات العقارية', connectionMethod: 'qr', enabled: true, phoneNumber: null, jid: null, displayName: null, connectedAt: null });
    expect(account.status).toBe('idle');
    expect(account.status).not.toBe('connected');
    expect(account.authDir).toBe(`accounts/${Q}/baileys-auth`);
    const dir = authDirFor(account);
    expect(dir).not.toBe(authDirFor(getAccount(ACC1)!));
    expect(dir).not.toBe(authDirFor(getAccount(ACC2)!));
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]); // nothing was copied from any other account
  });

  it('leaves Account 1 and the other business byte-for-byte unchanged (settings, menus, templates, offers, documents, requests, links)', () => {
    expect(fingerprint(ACC1)).toBe(before1);
    expect(fingerprint(ACC2)).toBe(before2);
  });

  it('publishes the business profile from the website facts only — and no number, hours, map link or staff number is invented', () => {
    const s = getBusinessSettings(Q);
    expect(s.businessName).toBe('QMULATE Real Estate Consultancy');
    expect(s.businessNameAr).toBe('QMULATE للاستشارات العقارية');
    expect(s.businessCategory).toMatch(/consultancy.*brokerage.*property management/i);
    expect(s.addressEn).toBe('King Abdulaziz Rd, Albasatin Dist., P.O. Box 23718, Jeddah 9351, Kingdom of Saudi Arabia');
    expect(s.addressAr).toContain('طريق الملك عبدالعزيز');
    expect(s.contactEmail).toBe('ceo@qmulate.com');
    expect(s.contactPhone).toBe('+966 53 333 9052');
    expect(s.businessTimezone).toBe('Asia/Riyadh');
    expect(s.supportedLanguages).toEqual(['ar', 'en']);
    expect(s.descriptionEn).toContain('Transforming Ownership into Enduring Value');
    expect(s.hoursConfigured).toBe(false);
    expect(s.googleMapsUrl).toBe('');
    expect(s.staffWhatsappNumber).toBeNull();
    expect(listLinks(Q).map((l) => [l.kind, l.url])).toEqual([['website', 'https://www.qmulate.ai/'], ['other', 'https://www.qmulate.ai/ar']]);
  });

  it('stores the logo only in this account\'s own uploads (internal, purpose "logo", exact bytes) and nowhere else', () => {
    const settings = getBusinessSettings(Q);
    expect(settings.logoDocumentId).toBeGreaterThan(0);
    const doc = getDocument(settings.logoDocumentId!, getDb(), Q)!;
    expect(doc).toMatchObject({ purpose: 'logo', visibility: 'internal', mime_type: 'image/png', whatsapp_account_id: Q });
    expect(fs.readFileSync(documentPath(doc)).equals(PNG)).toBe(true);
    expect(documentPath(doc)).toContain(`${path.sep}${Q}${path.sep}`);
    expect(getDocument(doc.id, getDb(), ACC1)).toBeUndefined();
    expect(getDocument(doc.id, getDb(), ACC2)).toBeUndefined();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM business_documents WHERE sha256 = ? AND whatsapp_account_id != ?').get(doc.sha256, Q)).toEqual({ n: 0 });
  });

  it('has the nine-option menu in both languages, with no offers, catalogues or location page it has no content for', () => {
    const { config } = getMenuConfig(Q);
    expect(config.items).toHaveLength(9);
    expect(config.items.length).toBeLessThanOrEqual(MAX_MENU_ITEMS);
    expect(config.items.map((i) => i.kind)).toEqual(['submenu', 'submenu', 'submenu', 'submenu', 'submenu', 'info', 'info', 'appointment', 'handoff']);
    expect(config.items.map((i) => i.id)).toEqual(['ownership', 'assets', 'invest', 'advisory', 'clients', 'about', 'contact', 'consult', 'staff']);
    for (const i of config.items) {
      expect(i.labelEn.length).toBeLessThanOrEqual(60);
      expect(i.labelAr.length).toBeLessThanOrEqual(60);
      expect(i.labelAr).toMatch(/[؀-ۿ]/);
    }
    expect(config.items.some((i) => ['offers', 'catalogues', 'location'].includes(i.kind))).toBe(false);
    const main = runWithAccount(Q, () => ({ en: resolveTemplate('main_menu', 'en'), ar: resolveTemplate('main_menu', 'ar') }));
    for (const item of QMULATE_MENU.items) {
      expect(main.en).toContain(item.labelEn);
      expect(main.ar).toContain(item.labelAr);
    }
    // 0 is the permanent Change-language line, placed just above the final "option number" line.
    expect(main.en).toMatch(/0️⃣ 🌐 Change language\n\nPlease reply with the option number\.$/);
    expect(main.ar).toContain('0️⃣');
    expect(main.ar).toMatch(/أرسل رقم الخيار\.$/);
  });

  it('every reply text is written (Arabic and English), mentions no other business, has no unresolved placeholder and fits one WhatsApp message', () => {
    runWithAccount(Q, () => {
      const templates = listTemplates();
      expect(templates.length).toBeGreaterThan(40);
      for (const t of templates) {
        for (const lang of ['en', 'ar'] as const) {
          const live = lang === 'en' ? t.liveEn : t.liveAr;
          const rendered = renderTemplateText(live, { language: lang, templateKey: t.key, reference: 'APT-2026-0001', name: 'Test', service: 'x', date: 'd', time: 't', kind: 'Appointment', customer: '********1234', status: 'Confirmed', actor: 'A', details: 'x' });
          expect(rendered, `${t.key} (${lang})`).not.toMatch(FOREIGN);
          expect(rendered, `${t.key} (${lang})`).not.toMatch(/\{[a-z_]+\}/);
          expect(rendered.length, `${t.key} (${lang})`).toBeLessThan(1700);
        }
      }
      // The customised pages really are QMULATE's own (not the neutral generic text).
      expect(resolveTemplate('menu_about', 'en')).toContain('REGA');
      expect(resolveTemplate('menu_about', 'ar')).toContain('الهيئة العامة للعقار');
    });
  });

  it('shows the licence exactly as published on the website, and nothing beyond it', () => {
    runWithAccount(Q, () => {
      expect(resolveTemplate('menu_about', 'en')).toContain('Licensed by the Real Estate General Authority (REGA) under license numbers 2200005389 and 1200049558.');
      expect(resolveTemplate('menu_about', 'ar')).toContain('مرخص من الهيئة العامة للعقار (REGA) بموجب الترخيصين رقم 2200005389 و1200049558.');
      for (const t of listTemplates()) expect(`${t.liveEn} ${t.liveAr}`).not.toMatch(/ISO\s?\d|certified|guarantee|\bSAR\b|\bROI\b|per cent|%|commission rate/i);
    });
  });

  it('the contact page fills address, phone, email and website from this business\'s own profile', () => {
    runWithAccount(Q, () => {
      const en = resolveTemplate('menu_contact', 'en');
      expect(en).toContain('King Abdulaziz Rd');
      expect(en).toContain('+966 53 333 9052');
      expect(en).toContain('ceo@qmulate.com');
      expect(en).toContain('https://www.qmulate.ai/');
      expect(en).toContain('typically respond within one business day');
      expect(resolveTemplate('menu_contact', 'ar')).toContain('طريق الملك عبدالعزيز');
    });
  });
});

describe('the customer conversation on the QMULATE number', () => {
  it('first contact: bilingual welcome and language choice naming QMULATE, then the menu in the language chosen', async () => {
    const waId = newCustomer();
    const welcome = await say(waId, 'hi');
    expect(welcome.join('\n')).toContain('QMULATE Real Estate Consultancy');
    expect(welcome.join('\n')).not.toMatch(FOREIGN);
    const en = (await say(waId, '2')).join('\n');
    expect(en).toContain('Welcome to QMULATE Real Estate Consultancy');
    expect(en).toContain('1️⃣ 🏛️ Ownership Structuring & Governance');
    expect(en).toContain('9️⃣ 💬 Talk to Our Team');
    const ar = newCustomer();
    await say(ar, 'hello');
    const arMenu = (await say(ar, '1')).join('\n');
    expect(arMenu).toContain('أهلاً بك في QMULATE للاستشارات العقارية');
    expect(arMenu).toContain('1️⃣ 🏛️ هيكلة الملكية والحوكمة');
  });

  it.each([
    ['en', '1', '1', ['shareholders, partners and investors']],
    ['en', '1', '2', ['personal assets and investments within a framework']],
    ['en', '1', '3', ['across generations']],
    ['en', '2', '1', ['Portfolio management that protects asset value']],
    ['en', '2', '2', ['personal and investment properties']],
    ['en', '2', '3', ['maximise their benefit and sustainability']],
    ['en', '3', '1', ['expansion, development and repositioning']],
    ['en', '3', '2', ['acquisitions, sales, development, retention or exit']],
    ['en', '3', '3', ['sustainable investments']],
    ['en', '4', '1', ['brokerage', 'confidential documents']],
    ['en', '5', '1', ['Ownership structuring & governance', 'Asset management', 'Development & investment']],
    ['en', '5', '2', ['Endowments']],
    ['en', '5', '3', ['Corporates']],
    ['ar', '1', '1', ['المساهمين والشركاء والمستثمرين']],
    ['ar', '2', '2', ['العقارات الشخصية والاستثمارية']],
    ['ar', '3', '3', ['استثمارات مستدامة']],
    ['ar', '4', '1', ['الوساطة العقارية']],
  ] as const)('%s: main option %s, then entry %s shows the right page', async (language, option, entry, expected) => {
    const waId = await onMainMenu(language);
    const list = (await say(waId, option)).join('\n');
    expect(list).toContain(language === 'en' ? 'Main Menu' : 'القائمة الرئيسية');
    const page = (await say(waId, entry)).join('\n');
    for (const fragment of expected) expect(page).toContain(fragment);
    expect(page).not.toMatch(FOREIGN);
    expect(page).not.toMatch(/\{[a-z_]+\}/);
  });
  it('About shows the licence; Contact shows the website\'s contact details; neither goes to the AI', async () => {
    const waId = await onMainMenu('en');
    const about = (await say(waId, '6')).join('\n');
    expect(about).toContain('REGA');
    expect(about).toContain('Discovery, Structuring, Management and Growth');
    const contact = (await say(waId, '7')).join('\n');
    expect(contact).toContain('ceo@qmulate.com');
    expect(contact).toContain('Jeddah 9351');
  });

  it('option 0 on the main menu changes the language; the whole menu then switches (and back)', async () => {
    const waId = await onMainMenu('en');
    expect((await say(waId, '0')).join('\n')).toMatch(/language|اللغة/i);
    const ar = (await say(waId, '1')).join('\n');
    expect(ar).toContain('أهلاً بك في QMULATE للاستشارات العقارية');
    await say(waId, 'language');
    const en = (await say(waId, '2')).join('\n');
    expect(en).toContain('Welcome to QMULATE Real Estate Consultancy');
  });

  it('"0" inside a sub-menu or in the middle of a request goes back to the main menu', async () => {
    const waId = await onMainMenu('en');
    await say(waId, '2');
    expect((await say(waId, '0')).join('\n')).toContain('How can we help you today?');
    await say(waId, '8');
    await say(waId, 'Sara');
    expect((await say(waId, '0')).join('\n')).toContain('How can we help you today?');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM customer_requests WHERE wa_id = ?').get(waId)).toEqual({ n: 0 });
  });

  it('a consultation request (main option 8) collects the details and files ONE request on QMULATE\'s account only', async () => {
    const waId = await onMainMenu('en');
    expect((await say(waId, '8')).join('\n')).toContain('What is your full name?');
    expect((await say(waId, 'Layla Hassan')).join('\n')).toContain('Which area would you like to discuss?');
    expect((await say(waId, 'Ownership structuring for our family')).join('\n')).toContain('What date would suit you best');
    expect((await say(waId, 'Next Sunday')).join('\n')).toContain('how should we reach you');
    expect((await say(waId, 'Afternoon, WhatsApp')).join('\n')).toContain('Which language do you prefer');
    const confirm = (await say(waId, 'English, no other notes')).join('\n');
    expect(confirm).toMatch(/Reference: APT-/);
    expect(confirm).toContain('not confirmed until you receive confirmation from our team');
    expect(confirm).not.toMatch(FOREIGN);
    const rows = getDb().prepare('SELECT whatsapp_account_id AS a, kind, payload FROM customer_requests WHERE wa_id = ?').all(waId) as { a: number; kind: string; payload: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ a: Q, kind: 'appointment' });
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ name: 'Layla Hassan', service: 'Ownership structuring for our family', date: 'Next Sunday', time: 'Afternoon, WhatsApp' });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id IN (?, ?) AND wa_id = ?').get(ACC1, ACC2, waId)).toEqual({ n: 0 });
  });

  it('the consultation request is also offered inside every service sub-menu (option 4) and in Arabic', async () => {
    for (const option of ['1', '2', '3', '5']) {
      const waId = await onMainMenu('ar');
      await say(waId, option);
      expect((await say(waId, '4')).join('\n')).toContain('طلب استشارة');
    }
    const waId = await onMainMenu('ar');
    await say(waId, '8');
    await say(waId, 'سارة');
    await say(waId, 'إدارة الأصول');
    await say(waId, 'الأحد');
    await say(waId, 'مساءً - واتساب');
    const confirm = (await say(waId, 'العربية')).join('\n');
    expect(confirm).toContain('الرقم المرجعي: APT-');
    expect(confirm).toContain('غير مؤكدة حتى يصلك تأكيد');
  });

  it('a consultancy/brokerage inquiry (option 4 → 2) files a quotation-type request and never quotes a price', async () => {
    const waId = await onMainMenu('en');
    await say(waId, '4');
    expect((await say(waId, '2')).join('\n')).toContain('What is your full name?');
    await say(waId, 'Omar');
    await say(waId, 'Selling a building');
    const confirm = (await say(waId, 'One commercial building in Jeddah, want to sell')).join('\n');
    expect(confirm).toMatch(/Reference: INQ-/);
    expect(confirm).not.toMatch(/SAR|riyal|price|fee|commission|%/i);
    const row = getDb().prepare('SELECT whatsapp_account_id AS a, kind FROM customer_requests WHERE wa_id = ?').get(waId);
    expect(row).toEqual({ a: Q, kind: 'quotation' });
  });

  it('"Talk to Our Team" (option 9) hands over to a person and creates no request', async () => {
    const waId = await onMainMenu('en');
    const reply = (await say(waId, '9')).join('\n');
    expect(reply.length).toBeGreaterThan(10);
    expect(reply).not.toMatch(FOREIGN);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM customer_requests WHERE wa_id = ?').get(waId)).toEqual({ n: 0 });
  });

  it('an option that does not exist re-shows the menu instead of guessing', async () => {
    const waId = await onMainMenu('en');
    const reply = (await say(waId, '57')).join('\n');
    expect(reply).toContain('How can we help you today?');
  });
});

describe('isolation of knowledge and content', () => {
  const promptFor = (accountId: number) =>
    runWithAccount(accountId, () => buildSystemPrompt(loadKnowledgeBase(knowledgeDirForAccount(accountId), { excludeDirs: ['accounts', '.backups'] }), 'en'));

  it('the QMULATE assistant knows QMULATE only: its profile, licence, services, rules — and nothing of the other two businesses', () => {
    const prompt = promptFor(Q);
    expect(prompt).toContain('QMULATE Real Estate Consultancy');
    expect(prompt).toContain('2200005389');
    expect(prompt).toContain('Ownership Structuring & Governance');
    expect(prompt).toContain('Never');
    expect(prompt).toContain('Opening hours: Not provided');
    expect(prompt).toContain('CURRENT OFFERS: none');
    expect(prompt).not.toMatch(FOREIGN);
    expect(prompt).not.toContain('Jotun fixture');
  });

  it('QMULATE\'s knowledge lives in its own folder; no other account\'s knowledge or content mentions QMULATE', () => {
    expect(knowledgeDirForAccount(Q)).toContain(`${path.sep}${Q}`);
    expect(fs.readdirSync(knowledgeDirForAccount(Q)).filter((f) => f.endsWith('.md')).sort()).toEqual(['ai-knowledge.md', 'business.md', 'faq.md', 'policies.md', 'services.md']);
    expect(promptFor(ACC1)).not.toMatch(/qmulate/i);
    expect(promptFor(ACC2)).not.toMatch(/qmulate/i);
    expect(promptFor(ACC2)).toContain('Jotun fixture knowledge');
    for (const acc of [ACC1, ACC2]) {
      runWithAccount(acc, () => {
        for (const t of listTemplates()) expect(`${t.liveEn} ${t.liveAr}`, `${acc}/${t.key}`).not.toMatch(/qmulate/i);
        expect(getBusinessSettings(acc).businessName).not.toMatch(/qmulate/i);
      });
    }
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM offers WHERE whatsapp_account_id = ?").get(Q)).toEqual({ n: 0 });
  });

  it('the assistant rules forbid inventing prices, listings, advice and confidential documents', () => {
    const policies = readKnowledgeFile('policies.md', Q).content;
    for (const rule of [/prices, fees, commissions, rents, yields, returns or valuations/, /List, describe or invent properties/, /legal, regulatory, tax, financial or Sharia advice/, /confidential documents/, /team will confirm/]) expect(policies).toMatch(rule);
  });
});

describe('running the provisioning again, and failing safely', () => {
  it('is idempotent: a second run creates nothing and changes nothing', () => {
    const q1 = fingerprint(Q);
    const accounts = listAccounts().length;
    const again = provisionBlueprint(QMULATE_BLUEPRINT, { actor: 'test', logo: { path: logoFile } });
    expect(again).toMatchObject({ created: false, accountId: Q });
    expect(listAccounts()).toHaveLength(accounts);
    expect(fingerprint(Q)).toBe(q1);
    expect(fingerprint(ACC1)).toBe(before1);
    expect(fingerprint(ACC2)).toBe(before2);
  });

  it('never overwrites what a person edited later, but restores a knowledge file that went missing', () => {
    runWithAccount(Q, () => publishTemplate('menu_about', { ar: 'نص معدل', en: 'Edited by staff' }, 'staff'));
    writeKnowledgeFile('faq.md', '# Edited by staff', Q);
    fs.rmSync(path.join(knowledgeDirForAccount(Q), 'policies.md'));
    const again = provisionBlueprint(QMULATE_BLUEPRINT, { actor: 'test' });
    expect(again.created).toBe(false);
    expect(runWithAccount(Q, () => resolveTemplate('menu_about', 'en'))).toBe('Edited by staff');
    expect(readKnowledgeFile('faq.md', Q).content).toBe('# Edited by staff');
    expect(readKnowledgeFile('policies.md', Q).content).toContain('How the assistant behaves');
  });

  it('a blueprint that cannot be applied leaves NO half-built account behind', () => {
    const accounts = listAccounts().length;
    const broken = { ...QMULATE_BLUEPRINT, name: 'Broken Test Co', templates: [{ key: 'no_such_template', ar: 'x', en: 'x' }] };
    expect(() => provisionBlueprint(broken, { actor: 'test' })).toThrow(/Template not found/);
    expect(listAccounts()).toHaveLength(accounts);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM whatsapp_accounts WHERE name = 'Broken Test Co'").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM business_settings WHERE business_name = 'Broken Test Co'").get()).toEqual({ n: 0 });
  });

  it('a missing logo file stops before anything is created', () => {
    const accounts = listAccounts().length;
    expect(() => provisionBlueprint({ ...QMULATE_BLUEPRINT, name: 'No Logo Test Co' }, { actor: 'test', logo: { path: path.join(os.tmpdir(), 'does-not-exist.png') } })).toThrow(/logo file not found/);
    expect(listAccounts()).toHaveLength(accounts);
  });

  it('refuses to guess when two accounts already carry the blueprint\'s name', () => {
    const twin = createAccount({ name: 'Twin Test Co' }).id;
    createAccount({ name: 'Twin Test Co' });
    expect(() => provisionBlueprint({ ...QMULATE_BLUEPRINT, name: 'Twin Test Co' }, { actor: 'test' })).toThrow(/more than one account/);
    expect(twin).toBeGreaterThan(0);
  });

  it('did not touch the original business or the other account while doing any of the above', () => {
    expect(fingerprint(ACC1)).toBe(before1);
    expect(fingerprint(ACC2)).toBe(before2);
  });
});
