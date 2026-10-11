import { inflateRawSync } from 'node:zlib';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { runWithAccount } from '../../src/accounts/accountContext';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';
import { createCustomerRequest } from '../../src/memory/customerRequestRepo';
import { buildXlsx, crc32, sheetName, xmlText } from '../../src/customers/xlsx';
import { buildExportDataset, datasetToPrintHtml } from '../../src/customers/reportExport';
import { listDirectory } from '../../src/customers/customerReports';

const OWNER = 'owner@example.com';
const PASSWORD = 'a-very-long-test-password-123';

/** Minimal zip reader (central directory + inflate) so the tests read the workbook the way any spreadsheet program would. */
function unzip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    expect(buffer.readUInt32LE(p)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    expect(data.length, `${name} size`).toBe(size);
    expect(crc32(data), `${name} crc`).toBe(crc);
    files.set(name, Buffer.from(data));
    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Well-formedness: tags balance and every attribute value is quoted. (Enough to catch an unescaped character or a broken tag.) */
function expectWellFormed(xml: string): void {
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|<\?xml[^>]*\?>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    const between = xml.slice(last, m.index);
    expect(between.includes('<'), `stray "<" near ${between.slice(0, 40)}`).toBe(false);
    last = m.index + m[0].length;
    if (m[0].startsWith('<?')) continue;
    if (m[4]) continue; // self-closing
    if (m[1]) expect(stack.pop(), `closing ${m[2]}`).toBe(m[2]);
    else stack.push(m[2]!);
  }
  expect(xml.slice(last).trim()).toBe('');
  expect(stack).toEqual([]);
}

const sheetCells = (xml: string): string[][] =>
  [...xml.matchAll(/<row r="\d+">(.*?)<\/row>/g)].map((r) => [...r[1]!.matchAll(/<c [^>]*?(?:\/>|>(.*?)<\/c>)/g)].map((c) => (c[1] ?? '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')));

describe('the xlsx writer', () => {
  it('writes a valid package: required parts, intact checksums, well-formed XML', () => {
    const files = unzip(buildXlsx([{ name: 'Data', rows: [['A', 'B'], ['x', 1]] }]));
    expect([...files.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']));
    for (const [name, data] of files) {
      expect(name).toBeTruthy();
      expectWellFormed(data.toString('utf8'));
    }
  });

  it('keeps text as text: formulas never run, special characters and Arabic survive, bad control characters are dropped', () => {
    const nasty = ['=HYPERLINK("http://evil","click")', '+SUM(1,1)', '-2+3', '@cmd', '<b>&amp; "quoted" \'single\'</b>', 'مرحباً بالعميل — شركة الأمل', 'emoji 🚗 ok', 'tab\there', 'bad\u0000\u0007char'];
    const files = unzip(buildXlsx([{ name: 'Data', rows: [['Text'], ...nasty.map((t) => [t])] }]));
    const xml = files.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expectWellFormed(xml);
    expect(xml).not.toContain('<f>'); // no formula element anywhere
    expect(xml).not.toContain('t="str"');
    const cells = sheetCells(xml).slice(1).map((r) => r[0]);
    expect(cells).toEqual([nasty[0], nasty[1], nasty[2], nasty[3], nasty[4], nasty[5], nasty[6], nasty[7], 'badchar']);
  });

  it('numbers are numbers, empty values are empty, very long text is cut to the cell limit, sheet names are made valid and unique', () => {
    const files = unzip(buildXlsx([{ name: 'Qty', rows: [['n', 'empty', 'long'], [12.5, null, 'x'.repeat(50_000)]] }, { name: 'a/b:c*d?[e]\\f' + 'z'.repeat(40), rows: [['x']] }, { name: 'qty', rows: [['x']] }]));
    const xml = files.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(xml).toContain('<v>12.5</v>');
    expect(sheetCells(xml)[1]![1]!.length).toBeLessThanOrEqual(32_000);
    const names = [...files.get('xl/workbook.xml')!.toString('utf8').matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]!);
    expect(names).toHaveLength(3);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3);
    for (const n of names) { expect(n.length).toBeLessThanOrEqual(31); expect(n).not.toMatch(/[[\]:*?/\\]/); }
    expect(sheetName('', new Set())).toBe('Sheet');
    expect(xmlText('a&b<c>"d"')).toBe('a&amp;b&lt;c&gt;&quot;d&quot;');
  });

  it('refuses an empty workbook', () => {
    expect(() => buildXlsx([])).toThrow();
  });
});

describe('customer report exports (Excel, print-ready PDF, CSV)', () => {
  const app = createApp();
  let A: number;
  let B: number;
  let seq = 0;
  const staff: Record<string, number> = {};
  const as = (userId: number) => {
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(userId).token}`;
    return { get: (url: string, account?: number) => { const r = request(app).get(url).set('Cookie', cookie).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); }); return account ? r.set('X-Whatsapp-Account', String(account)) : r; } };
  };
  const body = (res: { body: unknown }): Buffer => res.body as Buffer;

  const customer = (account: number, name: string, opts: { language?: 'ar' | 'en'; quotation?: boolean; company?: string } = {}) =>
    runWithAccount(account, () => {
      const waId = `96566${String(++seq).padStart(7, '0')}`;
      const c = getOrCreateCustomer(waId, name);
      if (opts.language) setCustomerLanguage(c.id, opts.language);
      if (opts.company) getDb().prepare('UPDATE customers SET company_name = ? WHERE id = ?').run(opts.company, c.id);
      const r = opts.quotation ? createCustomerRequest({ customerId: c.id, waId, kind: 'quotation', payload: { name, service: 'Front film' } }) : null;
      return { id: c.id, waId, request: r };
    });

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: OWNER, password: PASSWORD })).status).toBe(201);
    const owner = request.agent(app);
    A = createAccount({ name: 'Export Shop A' }).id;
    B = createAccount({ name: 'Export <Shop> B' }).id;
    const ownerId = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get(OWNER) as { id: number }).id;
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(ownerId).token}`;
    void owner;
    for (const [key, payload] of Object.entries({
      manager: { email: 'mgr@example.com', role: 'manager', accountIds: [A] },
      noCustomers: { email: 'nc@example.com', role: 'custom', accountIds: [A], permissions: { [A]: { conversations: 'view' } } },
      onlyB: { email: 'b@example.com', role: 'manager', accountIds: [B] },
    })) {
      const res = await request(app).post('/api/dashboard/users').set('Cookie', cookie).send({ password: PASSWORD, ...payload });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      staff[key] = res.body.id;
    }
    customer(A, 'Layla Al Harbi', { language: 'en', quotation: true, company: 'Al Harbi Trading' });
    customer(A, 'محمد العتيبي', { language: 'ar', quotation: true, company: 'شركة الأمل' });
    customer(A, '=HYPERLINK("http://evil","x")', { language: 'en' });
    customer(A, '<script>alert(1)</script>', { language: 'en' });
    customer(B, 'Secret Customer Of B', { language: 'en', quotation: true });
  });

  it('the Excel file has exactly the customers the screen lists for the same filters, with the business, dates and filters on a second sheet', async () => {
    const res = await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=customers&format=xlsx&lang=en&language=en', A);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="customers-\d{4}-\d{2}-\d{2}\.xlsx"/);
    expect(res.headers['cache-control']).toContain('no-store');
    const files = unzip(body(res));
    for (const data of files.values()) expectWellFormed(data.toString('utf8'));
    const rows = sheetCells(files.get('xl/worksheets/sheet1.xml')!.toString('utf8'));
    const screen = runWithAccount(A, () => listDirectory({ language: 'en', limit: 100 }));
    expect(rows).toHaveLength(screen.items.length + 1); // header + one row per customer on screen
    expect(rows[0]).toContain('WhatsApp number');
    expect(rows.slice(1).map((r) => r[1]).sort()).toEqual(screen.items.map((i) => i.wa_id).sort());
    const info = Object.fromEntries(sheetCells(files.get('xl/worksheets/sheet2.xml')!.toString('utf8')).slice(1).map((r) => [r[0], r[1]]));
    expect(info.Business).toBe('Export Shop A');
    expect(info.Filters).toContain('Language: English');
    expect(info['Date range']).toBe('All dates');
    expect(info.Records).toBe(String(screen.total));
    expect(info.Generated).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\)$/);
  });

  it('never includes another business\'s customers, even when asked with that business\'s names or ids', async () => {
    for (const format of ['xlsx', 'pdf', 'csv']) {
      const res = await as(staff.manager!).get(`/api/dashboard/customer-reports/export?dataset=customers&format=${format}&search=Secret`, A);
      expect(res.status).toBe(200);
      const text = format === 'xlsx' ? [...unzip(body(res)).values()].map((b) => b.toString('utf8')).join('') : body(res).toString('utf8');
      expect(text, format).not.toContain('Secret Customer Of B');
    }
    const all = await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=quotations&format=xlsx', A);
    expect([...unzip(body(all)).values()].map((b) => b.toString('utf8')).join('')).not.toContain('Secret Customer Of B');
    // another business's own manager gets their own data, not A's
    const mine = await as(staff.onlyB!).get('/api/dashboard/customer-reports/export?dataset=customers&format=xlsx', B);
    const text = [...unzip(body(mine)).values()].map((b) => b.toString('utf8')).join('');
    expect(text).toContain('Secret Customer Of B');
    expect(text).not.toContain('Layla Al Harbi');
    // and a user of B cannot ask for A's export at all
    expect((await as(staff.onlyB!).get('/api/dashboard/customer-reports/export?dataset=customers&format=xlsx', A)).status).toBe(403);
  });

  it('is refused without the customers permission and without a session', async () => {
    const url = '/api/dashboard/customer-reports/export?dataset=customers&format=xlsx';
    expect((await request(app).get(url)).status).toBe(401);
    expect((await as(staff.noCustomers!).get(url, A)).status).toBe(403);
    expect((await as(staff.noCustomers!).get('/api/dashboard/customer-reports/export?dataset=customers&format=pdf', A)).status).toBe(403);
  });

  it('applies the same filters as the screen: a date range and a search narrow the file and are named in it', async () => {
    const res = await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=customers&format=xlsx&search=Layla&from=2020-01-01&to=2099-12-31', A);
    const files = unzip(body(res));
    const rows = sheetCells(files.get('xl/worksheets/sheet1.xml')!.toString('utf8'));
    expect(rows).toHaveLength(2);
    expect(rows[1]![2]).toBe('Layla Al Harbi');
    const info = Object.fromEntries(sheetCells(files.get('xl/worksheets/sheet2.xml')!.toString('utf8')).slice(1).map((r) => [r[0], r[1]]));
    expect(info['Date range']).toBe('2020-01-01 → 2099-12-31');
    expect(info.Filters).toContain('Search: Layla');
    const none = await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=customers&format=xlsx&from=2001-01-01&to=2001-01-02', A);
    expect(sheetCells(unzip(body(none)).get('xl/worksheets/sheet1.xml')!.toString('utf8'))).toHaveLength(1); // header only
  });

  it('customer text that looks like a formula or markup is plain text in Excel and escaped in the print view', async () => {
    const xlsx = await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=customers&format=xlsx', A);
    const xml = unzip(body(xlsx)).get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(xml).not.toContain('<f>');
    expect(sheetCells(xml).map((r) => r[2])).toContain('=HYPERLINK("http://evil","x")');
    const pdf = await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=customers&format=pdf', A);
    const html = body(pdf).toString('utf8');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(pdf.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('the print view is a script-free, complete report; Arabic is right-to-left with Arabic labels and keeps Arabic names', async () => {
    const res = await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=customers&format=pdf&lang=ar', A);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const html = body(res).toString('utf8');
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('العملاء');
    expect(html).toContain('رقم واتساب');
    expect(html).toContain('محمد العتيبي');
    expect(html).toContain('Export Shop A');
    expect(html).toContain('size: A4 landscape');
    const en = (await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=customers&format=pdf&lang=en', A)).body as Buffer;
    expect(en.toString('utf8')).toContain('<html lang="en" dir="ltr">');
  });

  it('exports quotations and the summary too, with Arabic statuses and an RTL workbook', async () => {
    const q = await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=quotations&format=xlsx&lang=ar', A);
    expect(q.status).toBe(200);
    const files = unzip(body(q));
    const rows = sheetCells(files.get('xl/worksheets/sheet1.xml')!.toString('utf8'));
    expect(rows[0]).toContain('المرجع');
    expect(rows).toHaveLength(3); // header + A's two quotations (B's is not here)
    expect(rows[1]).toContain('قيد الانتظار');
    expect(files.get('xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('rightToLeft="1"');
    const s = await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=summary&format=xlsx&lang=en', A);
    const summary = sheetCells(unzip(body(s)).get('xl/worksheets/sheet1.xml')!.toString('utf8'));
    expect(summary[0]).toEqual(['Metric', 'Value']);
    expect(summary.find((r) => r[0] === 'Total customers')![1]).toBe('4');
    const csv = await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=summary&format=csv', A);
    expect(body(csv).toString('utf8')).toContain('Total customers,4');
  });

  it('CSV keeps working exactly as before (same headers, formula-safe cells)', async () => {
    const res = await as(staff.manager!).get('/api/dashboard/customer-reports/export?dataset=customers', A);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = body(res).toString('utf8');
    expect(text).toContain('Customer ID,WhatsApp number,Name,Company');
    expect(text).toContain(`'=HYPERLINK`); // a leading = is neutralised in CSV
  });

  it('builds the dataset for the selected business only, in the business timezone', () => {
    const data = runWithAccount(A, () => buildExportDataset('customers', {}, 'en', { now: new Date('2026-10-10T23:30:00Z') }));
    expect(data.info.find((i) => i.label === 'Business')!.value).toBe('Export Shop A');
    expect(data.total).toBe(4);
    expect(datasetToPrintHtml(data)).toContain('<table class="data">');
  });
});
