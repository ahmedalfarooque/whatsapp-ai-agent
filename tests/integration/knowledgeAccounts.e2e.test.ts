import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { updateBusinessSettings } from '../../src/config/businessSettings';
import { saveDocument } from '../../src/documents/documentStore';
import { createLink, recordFetchResult } from '../../src/setup/linksRepo';
import { loadKnowledgeBase } from '../../src/knowledge/loader';
import { knowledgeDirForAccount } from '../../src/knowledge/paths';
import { listKnowledgeFiles, writeKnowledgeFile } from '../../src/dashboard/knowledgeAdmin';
import { getKnowledgeStatus } from '../../src/dashboard/data';
import { buildSystemPrompt } from '../../src/llm/buildSystemPrompt';
import { repairMissingKnowledge } from '../../src/setup/repairKnowledge';

/**
 * Per-account knowledge: what each business's files hold, what the dashboard reports about them, and what the assistant is given.
 * Three businesses (ids 1, 2, 3) each carry a unique marker that must never appear in another's data or prompt.
 */
const MARK = { 1: 'ALPHA-CAR-CARE-MARKER', 2: 'BRAVO-PAINT-SHOP-MARKER', 3: 'CHARLIE-REALTY-MARKER' } as const;
const FILES = ['business.md', 'services.md', 'policies.md', 'faq.md', 'ai-knowledge.md', 'booking.json'];

let legacyDir: string;
let accountsDir: string;
const saved = { legacy: process.env.KNOWLEDGE_LEGACY_DIR, accounts: process.env.KNOWLEDGE_ACCOUNTS_DIR };

const dirOf = (id: number): string => knowledgeDirForAccount(id);
const write = (id: number, name: string, text: string): void => {
  fs.mkdirSync(dirOf(id), { recursive: true });
  fs.writeFileSync(path.join(dirOf(id), name), text, 'utf-8');
};

describe('account knowledge: storage, status, retrieval and repair', () => {
  let app: ReturnType<typeof createApp>;
  let agent: ReturnType<typeof request.agent>;
  const as = (id: number) => ({ 'X-Whatsapp-Account': String(id) });

  beforeAll(async () => {
    legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-legacy-'));
    accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-accounts-'));
    process.env.KNOWLEDGE_LEGACY_DIR = legacyDir;
    process.env.KNOWLEDGE_ACCOUNTS_DIR = accountsDir;
    getDb();
    app = createApp();
    agent = request.agent(app);
    expect((await agent.post('/api/dashboard/auth/setup').send({ username: 'knowledge-admin', password: 'a-very-long-test-password-123' })).status).toBe(201);
    expect(createAccount({ name: 'Bravo Paint Shop', businessCategory: 'Paint store' }).id).toBe(2);
    expect(createAccount({ name: 'Charlie Realty' }).id).toBe(3);
    // Account 1 and 3 have full hand-written knowledge; account 2 starts with none (the JOTUN situation).
    for (const id of [1, 3] as const) {
      write(id, 'business.md', `# ${MARK[id]}\nBusiness ${id}\n`);
      write(id, 'services.md', `# Services\n- ${MARK[id]} service\n`);
      write(id, 'policies.md', `# Policies\n${MARK[id]} policy\n`);
      write(id, 'faq.md', `# FAQ\n${MARK[id]} faq\n`);
    }
  });

  afterAll(() => {
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(accountsDir, { recursive: true, force: true });
    for (const [key, value] of [['KNOWLEDGE_LEGACY_DIR', saved.legacy], ['KNOWLEDGE_ACCOUNTS_DIR', saved.accounts]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('the reported status equals what is on disk', () => {
    it('reports missing / available / empty / invalid for every file, per account', async () => {
      const states = (id: number) => Object.fromEntries(listKnowledgeFiles(id).map((f) => [f.name, f.state]));
      expect(states(1)).toEqual({ 'business.md': 'available', 'services.md': 'available', 'policies.md': 'available', 'faq.md': 'available', 'ai-knowledge.md': 'missing', 'booking.json': 'missing' });
      expect(Object.values(states(2)).every((s) => s === 'missing')).toBe(true);

      write(3, 'booking.json', '{ not json');
      write(3, 'ai-knowledge.md', '   \n  ');
      expect(states(3)).toMatchObject({ 'booking.json': 'invalid', 'ai-knowledge.md': 'empty', 'business.md': 'available' });
      const invalid = listKnowledgeFiles(3).find((f) => f.name === 'booking.json')!;
      expect(invalid).toMatchObject({ exists: true, optional: true });
      expect(invalid.problem).toMatch(/not valid JSON/);

      // The very same truth reaches the dashboard through HTTP, and nothing is shared between accounts.
      for (const id of [1, 2, 3]) {
        const body = (await agent.get('/api/dashboard/knowledge').set(as(id))).body as { files: Array<{ name: string; state: string }> };
        expect(Object.fromEntries(body.files.map((f) => [f.name, f.state]))).toEqual(states(id));
      }
      // the Status page / overview strings
      expect(Object.fromEntries(runWithAccount(3, () => getKnowledgeStatus()).map((s) => [s.name, s.status]))).toMatchObject({ 'booking.json': 'Invalid', 'ai-knowledge.md': 'Empty', 'business.md': 'Available' });
      expect(Object.fromEntries(getKnowledgeStatus(2).map((s) => [s.name, s.status]))).toMatchObject({ 'business.md': 'Missing', 'ai-knowledge.md': 'Not created', 'booking.json': 'Not created' });

      fs.rmSync(path.join(dirOf(3), 'booking.json'));
      fs.rmSync(path.join(dirOf(3), 'ai-knowledge.md'));
    });

    it('a malformed JSON save is refused and the existing file is left exactly as it was', async () => {
      write(3, 'booking.json', '{"note":"keep me"}');
      const bad = await agent.put('/api/dashboard/knowledge/booking.json').set(as(3)).send({ content: '{ nope' });
      expect(bad.status).toBe(400);
      expect(fs.readFileSync(path.join(dirOf(3), 'booking.json'), 'utf-8')).toBe('{"note":"keep me"}');
      fs.rmSync(path.join(dirOf(3), 'booking.json'));
    });

    it('a directory where a file should be is never reported as an available file', () => {
      fs.mkdirSync(path.join(dirOf(3), 'ai-knowledge.md'));
      expect(listKnowledgeFiles(3).find((f) => f.name === 'ai-knowledge.md')!.state).toBe('missing');
      fs.rmSync(path.join(dirOf(3), 'ai-knowledge.md'), { recursive: true });
    });
  });

  describe('create / edit persists, updates the status and survives a restart', () => {
    it('creating and then editing a file for one account changes only that account', async () => {
      const created = await agent.put('/api/dashboard/knowledge/faq.md').set(as(2)).send({ content: `# FAQ\n${MARK[2]} answer one\n` });
      expect(created.status).toBe(200);
      expect(created.body.backedUpAs).toBeNull();
      expect(listKnowledgeFiles(2).find((f) => f.name === 'faq.md')!.state).toBe('available');
      expect(listKnowledgeFiles(1).find((f) => f.name === 'faq.md')!.state).toBe('available');
      expect(fs.readFileSync(path.join(dirOf(1), 'faq.md'), 'utf-8')).toContain(MARK[1]);

      const edited = await agent.put('/api/dashboard/knowledge/faq.md').set(as(2)).send({ content: `# FAQ\n${MARK[2]} answer two\n` });
      expect(edited.body.backedUpAs).toMatch(/^faq\.md\..*\.bak$/);
      expect((await agent.get('/api/dashboard/knowledge/faq.md').set(as(2))).body.content).toContain('answer two');
      // the backup of the previous version lives in THAT account's folder
      expect(fs.readdirSync(path.join(dirOf(2), '.backups')).length).toBe(1);
      expect(fs.existsSync(path.join(dirOf(1), '.backups'))).toBe(false);
    });

    it('files survive a restart: a brand-new application instance reads the same files', async () => {
      const restarted = request.agent(createApp());
      expect((await restarted.post('/api/dashboard/auth/login').send({ username: 'knowledge-admin', password: 'a-very-long-test-password-123' })).status).toBe(200);
      const got = await restarted.get('/api/dashboard/knowledge/faq.md').set(as(2));
      expect(got.status).toBe(200);
      expect(got.body.content).toContain('answer two');
      expect(loadKnowledgeBase(dirOf(2)).asPromptText).toContain('answer two');
    });

    it('a file that does not exist answers 404 (so the editor offers Create) and never another account\'s file', async () => {
      expect((await agent.get('/api/dashboard/knowledge/business.md').set(as(2))).status).toBe(404);
      expect((await agent.get('/api/dashboard/knowledge/business.md').set(as(3))).body.content).toContain(MARK[3]);
    });
  });

  describe('the assistant is given only its own account\'s knowledge', () => {
    const promptFor = (id: number): string => runWithAccount(id, () => buildSystemPrompt(loadKnowledgeBase(dirOf(id))));

    it('accounts 1, 2 and 3 each retrieve their own facts and none of the others', () => {
      write(2, 'business.md', `# ${MARK[2]}\nBusiness 2\n`);
      for (const id of [1, 2, 3] as const) {
        const prompt = promptFor(id);
        expect(prompt, `account ${id} sees its own marker`).toContain(MARK[id]);
        for (const other of [1, 2, 3] as const) if (other !== id) expect(prompt, `account ${id} must not see account ${other}`).not.toContain(MARK[other]);
      }
    });

    it('no stale knowledge when switching accounts back and forth, or after a file is edited', async () => {
      const order = [1, 2, 3, 2, 1, 3, 1];
      for (const id of order) {
        const kb = loadKnowledgeBase(dirOf(id));
        expect(kb.asPromptText).toContain(MARK[id as 1 | 2 | 3]);
        expect(kb.sections.every((s) => !Object.values(MARK).some((m) => m !== MARK[id as 1 | 2 | 3] && s.content.includes(m)))).toBe(true);
      }
      await agent.put('/api/dashboard/knowledge/services.md').set(as(1)).send({ content: `# Services\n- ${MARK[1]} NEW-SERVICE-LINE\n` });
      expect(loadKnowledgeBase(dirOf(1)).asPromptText).toContain('NEW-SERVICE-LINE');
      expect(loadKnowledgeBase(dirOf(2)).asPromptText).not.toContain('NEW-SERVICE-LINE');
      expect(loadKnowledgeBase(dirOf(3)).asPromptText).not.toContain('NEW-SERVICE-LINE');
    });

    it('a malformed JSON file fails safely: it is skipped, the other files still load, and the dashboard reports it', () => {
      write(3, 'booking.json', '{ broken');
      const kb = loadKnowledgeBase(dirOf(3));
      expect(kb.sections.map((s) => s.fileName)).not.toContain('booking.json');
      expect(kb.asPromptText).toContain(MARK[3]);
      expect(listKnowledgeFiles(3).find((f) => f.name === 'booking.json')!.state).toBe('invalid');
      write(3, 'booking.json', '{"note":"valid"}');
      expect(loadKnowledgeBase(dirOf(3)).sections.map((s) => s.fileName)).toContain('booking.json');
      expect(listKnowledgeFiles(3).find((f) => f.name === 'booking.json')!.state).toBe('available');
      fs.rmSync(path.join(dirOf(3), 'booking.json'));
    });

    it('an account with no files loads an empty knowledge base without throwing', () => {
      const empty = createAccount({ name: 'Empty Co' }).id;
      expect(loadKnowledgeBase(dirOf(empty))).toEqual({ sections: [], asPromptText: '' });
    });
  });

  describe('repairing missing files from verified stored data only', () => {
    let bravo = 0;
    let blank = 0;

    beforeAll(() => {
      bravo = 2;
      // earlier tests wrote files for this account: start from the "nothing on disk" state of the real situation
      fs.rmSync(dirOf(bravo), { recursive: true, force: true });
      updateBusinessSettings({
        descriptionEn: 'A paint shop selling interior paints and colour charts.', addressEn: '12 Colour Street, Jeddah', googleMapsUrl: 'https://maps.app.goo.gl/bravo123',
        contactPhone: '+966 50 123 4567', businessHoursStart: '08:00', businessHoursEnd: '20:00', businessDays: '1,2,3,4,6,7',
      }, bravo);
      saveDocument({ originalName: 'bravo-prices.txt', mimeType: 'text/plain', bytes: Buffer.from('Services\n- Colour matching — 30 SAR\n\nFAQ\nQ: Do you deliver? A: Yes, within the city.\n'), visibility: 'ai_knowledge', purpose: 'price_list', accountId: bravo });
      const link = createLink({ url: 'https://bravo.example' }, bravo);
      recordFetchResult(link.id, { ok: true, httpStatus: 200, error: null, title: 'Bravo', text: 'Email: hello@bravo.example', sha256: 'h' }, bravo);
      // another business's confidential material must never leak into Bravo's files
      saveDocument({ originalName: 'charlie.txt', mimeType: 'text/plain', bytes: Buffer.from(`Services\n- ${MARK[3]}-SERVICE — 999 SAR\n`), visibility: 'ai_knowledge', purpose: 'price_list', accountId: 3 });
      blank = createAccount({ name: 'Blank Business' }).id;
    });

    it('a dry run reports what it would create and writes nothing', async () => {
      const dry = await repairMissingKnowledge(bravo, { dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(dry.created.map((c) => c.file)).toContain('business.md');
      expect(Object.keys(dry.preview).length).toBe(dry.created.length);
      expect(fs.existsSync(path.join(dirOf(bravo), 'business.md'))).toBe(false);
    });

    it('creates the missing files from this account\'s own profile, documents and links, with unknown facts marked Not provided', async () => {
      const report = await repairMissingKnowledge(bravo);
      expect(report.created.map((c) => c.file)).toEqual(['business.md', 'services.md', 'faq.md', 'policies.md', 'ai-knowledge.md']);
      expect(Object.fromEntries(report.created.map((c) => [c.file, c.placeholder]))).toEqual({ 'business.md': false, 'services.md': false, 'faq.md': false, 'policies.md': true, 'ai-knowledge.md': false });
      // policies: no policy is stored, so the file says so — it never carries the platform's own process wording as if it were a policy
      const policies = fs.readFileSync(path.join(dirOf(bravo), 'policies.md'), 'utf-8');
      expect(policies).toContain('No policies');
      expect(policies).not.toMatch(/Appointment requests are sent|Talk to our team|currently closed/);
      expect(listKnowledgeFiles(bravo).find((f) => f.name === 'policies.md')).toMatchObject({ state: 'available', placeholder: true });
      expect(listKnowledgeFiles(bravo).find((f) => f.name === 'business.md')).toMatchObject({ state: 'available', placeholder: false });
      expect(Object.fromEntries(getKnowledgeStatus(bravo).map((s) => [s.name, s.status]))).toMatchObject({ 'policies.md': 'Placeholder', 'business.md': 'Available' });
      // the sources inventory names this account's own documents and pages only
      const sourcesFile = fs.readFileSync(path.join(dirOf(bravo), 'ai-knowledge.md'), 'utf-8');
      expect(sourcesFile).toContain('bravo-prices.txt');
      expect(sourcesFile).not.toContain('charlie.txt');
      const business = fs.readFileSync(path.join(dirOf(bravo), 'business.md'), 'utf-8');
      expect(business).toContain('12 Colour Street, Jeddah');
      expect(business).toContain('https://maps.app.goo.gl/bravo123');
      expect(business).toContain('+966 50 123 4567');
      expect(business).toContain('hello@bravo.example');
      expect(fs.readFileSync(path.join(dirOf(bravo), 'services.md'), 'utf-8')).toContain('Colour matching');
      expect(fs.readFileSync(path.join(dirOf(bravo), 'services.md'), 'utf-8')).toMatch(/30 SAR/);
      // nothing from any other account, and no invented content
      for (const file of FILES.filter((f) => fs.existsSync(path.join(dirOf(bravo), f)))) {
        const text = fs.readFileSync(path.join(dirOf(bravo), file), 'utf-8');
        expect(text, file).not.toContain(MARK[1]);
        expect(text, file).not.toContain(MARK[3]);
        expect(text, file).not.toContain('SECRET');
      }
      // the generated files are valid and now reported as available
      expect(listKnowledgeFiles(bravo).filter((f) => f.state === 'available').map((f) => f.name)).toEqual(['business.md', 'services.md', 'policies.md', 'faq.md', 'ai-knowledge.md']);
    });

    it('a business with only a profile gets its facts plus explicit "nothing provided" placeholders — no invented content', async () => {
      const profileOnly = createAccount({ name: 'Profile Only Co' }).id;
      updateBusinessSettings({ addressEn: '9 Quiet Road, Riyadh', contactPhone: '+966 55 000 0000' }, profileOnly);
      const report = await repairMissingKnowledge(profileOnly);
      expect(Object.fromEntries(report.created.map((c) => [c.file, c.placeholder]))).toEqual({ 'business.md': false, 'services.md': true, 'faq.md': true, 'policies.md': true });
      expect(report.notDerivable).toEqual(['ai-knowledge.md']);
      expect(fs.readFileSync(path.join(dirOf(profileOnly), 'business.md'), 'utf-8')).toContain('9 Quiet Road, Riyadh');
      for (const file of ['services.md', 'faq.md', 'policies.md']) {
        const text = fs.readFileSync(path.join(dirOf(profileOnly), file), 'utf-8');
        expect(text).toContain('knowledge:placeholder');
        expect(text).not.toMatch(/\d+\s?(SAR|ريال)/); // no prices
      }
      // a later "Analyze & Generate" (merge) may replace an untouched placeholder, because it is a generated block
      expect(fs.readFileSync(path.join(dirOf(profileOnly), 'services.md'), 'utf-8')).toMatch(/<!-- setup:begin v1 hash=[0-9a-f]{10} -->/);
    });

    it('is idempotent and never overwrites a file that already holds text', async () => {
      const before = Object.fromEntries(FILES.filter((f) => fs.existsSync(path.join(dirOf(bravo), f))).map((f) => [f, fs.readFileSync(path.join(dirOf(bravo), f), 'utf-8')]));
      const again = await repairMissingKnowledge(bravo);
      expect(again.created).toEqual([]);
      for (const [f, text] of Object.entries(before)) expect(fs.readFileSync(path.join(dirOf(bravo), f), 'utf-8')).toBe(text);

      // hand-written content stays exactly as written; a malformed JSON file is not "repaired" over
      writeKnowledgeFile('services.md', 'HAND WRITTEN SERVICES\n', bravo);
      write(bravo, 'booking.json', '{ keep');
      await repairMissingKnowledge(bravo);
      expect(fs.readFileSync(path.join(dirOf(bravo), 'services.md'), 'utf-8')).toBe('HAND WRITTEN SERVICES\n');
      expect(fs.readFileSync(path.join(dirOf(bravo), 'booking.json'), 'utf-8')).toBe('{ keep');
    });

    it('leaves a business with nothing stored without files rather than inventing them, and never touches the others', async () => {
      const snapshot = (id: number) => FILES.map((f) => (fs.existsSync(path.join(dirOf(id), f)) ? fs.readFileSync(path.join(dirOf(id), f), 'utf-8') : null));
      const before = { 1: snapshot(1), 3: snapshot(3) };
      const report = await repairMissingKnowledge(blank);
      expect(report.created).toEqual([]);
      expect(report.notDerivable).toEqual(expect.arrayContaining(['business.md']));
      expect(fs.existsSync(dirOf(blank)) ? fs.readdirSync(dirOf(blank)).filter((f) => !f.startsWith('.')) : []).toEqual([]);
      // repairing a business never edits a file it already has (it may only add a missing one) and never touches another account
      await repairMissingKnowledge(3);
      await repairMissingKnowledge(1);
      const after = { 1: snapshot(1), 3: snapshot(3) };
      for (const id of [1, 3] as const) before[id].forEach((text, i) => { if (text !== null) expect(after[id][i], `account ${id} ${FILES[i]}`).toBe(text); });
      expect(after[1]).toEqual(before[1]); // account 1 has nothing stored that could fill its missing files
    });
  });

  it('running the test suite never touches the real repository knowledge folder', () => {
    const realKnowledge = path.join(__dirname, '..', '..', 'knowledge');
    expect(path.resolve(dirOf(1))).not.toBe(path.resolve(realKnowledge));
    expect(path.resolve(dirOf(2)).startsWith(path.resolve(realKnowledge))).toBe(false);
  });
});
