import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const DASH = path.resolve(__dirname, '../../../dashboard');
const read = (file: string): string => fs.readFileSync(path.join(DASH, file), 'utf8');

interface Model { mode: string; name: string; initial: string; logoUrl: string | null; accountId: number | null; nameEn: string; nameAr: string | null }
interface Identity { accountId: number; name: string; initial: string; logoUrl: string | null; number: string; status: string; statusDot: string }
interface Sandbox { accountIdentityModel: (account: unknown, lang: string, status?: string) => Identity | null; maskAccountNumber: (v: unknown) => string; brandModel: (me: unknown, lang: string) => Model; brandInitial: (name: string) => string; registerAccountNames: (accounts: unknown) => void; window: { I18N_AR: Record<string, string> } }

/** Loads dashboard/branding.js the way the browser does, without a page: it only needs `document`, `window` and `esc`. */
function load(): Sandbox {
  const win = { I18N_AR: {} as Record<string, string>, I18N: undefined };
  const sandbox = { window: win, document: { addEventListener: () => undefined, querySelector: () => null, querySelectorAll: () => [], body: {} }, esc: (s: unknown) => String(s), console };
  vm.createContext(sandbox);
  vm.runInContext(read('branding.js'), sandbox, { filename: 'branding.js' });
  return sandbox as unknown as Sandbox;
}

const company = (extra: Record<string, unknown> = {}) => ({ branding: { mode: 'company', company: { accountId: 3, name: 'QMULATE Real Estate Consultancy', nameAr: 'QMULATE للاستشارات العقارية', logoUrl: '/api/dashboard/branding/logo?v=6-1', ...extra } } });

describe('branding model: what the page draws for the server\'s decision', () => {
  const b = load();

  it('developer mode (Super Admin, several accounts, anything unclear) is SYNRTECHS and carries no company', () => {
    for (const me of [{ branding: { mode: 'developer', company: null } }, {}, null, undefined, { branding: null }, { branding: { mode: 'company', company: null } }, { branding: { mode: 'company', company: { accountId: 1, name: '   ' } } }, { branding: { mode: 'somethingElse', company: { name: 'X' } } }]) {
      expect(b.brandModel(me, 'en')).toMatchObject({ mode: 'developer', name: 'SYNRTECHS', logoUrl: null, accountId: null });
    }
  });

  it('company mode shows the company name in the interface language, falling back to the English name', () => {
    expect(b.brandModel(company(), 'en')).toMatchObject({ mode: 'company', name: 'QMULATE Real Estate Consultancy', initial: 'Q', accountId: 3 });
    expect(b.brandModel(company(), 'ar')).toMatchObject({ mode: 'company', name: 'QMULATE للاستشارات العقارية', initial: 'Q' });
    expect(b.brandModel(company({ nameAr: null, name: 'JOTUN Rowad Alfa' }), 'ar').name).toBe('JOTUN Rowad Alfa');
    expect(b.brandModel(company({ name: 'Rowad Alfa Auto Care', nameAr: 'شركة رواد ألفا للعناية بالسيارات' }), 'ar').initial).toBe('ش');
  });

  it('a logo is accepted only from this application\'s own paths: no external or script URL can be drawn', () => {
    expect(b.brandModel(company(), 'en').logoUrl).toBe('/api/dashboard/branding/logo?v=6-1');
    expect(b.brandModel(company({ logoUrl: '/dashboard/assets/logo.webp' }), 'en').logoUrl).toBe('/dashboard/assets/logo.webp');
    for (const hostile of ['https://evil.example/logo.png', '//evil.example/x.png', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>', '/api/dashboard/customers/directory', '../../etc/passwd', '', null, 42]) {
      expect(b.brandModel(company({ logoUrl: hostile }), 'en').logoUrl, String(hostile)).toBeNull(); // a neutral initial tile is drawn instead
    }
  });

  it('the neutral tile uses the first letter of the shown name (never another company\'s logo)', () => {
    expect(b.brandInitial('jotun rowad alfa')).toBe('J');
    expect(b.brandInitial('  (QMULATE)')).toBe('Q');
    expect(b.brandInitial('جوتن رواد الفا')).toBe('ج');
    expect(b.brandInitial('')).toBe('•');
  });

  it('the selected-account identity is built from the server\'s accounts list: own name, own logo, masked number, status', () => {
    const rowad = { id: 1, name: 'Rowad Alfa Auto Care', nameAr: 'شركة رواد ألفا للعناية بالسيارات', phoneNumber: '966550000545', uiStatus: 'connected', logoUrl: '/dashboard/assets/logo.webp' };
    const jotun = { id: 2, name: 'JOTUN Rowad Alfa', nameAr: 'جوتن رواد الفا', phoneNumber: '+966 55 000 7115', uiStatus: 'connected', logoUrl: '/api/dashboard/accounts/2/logo?v=7-20261011121340' };
    const q = { id: 3, name: 'QMULATE Real Estate Consultancy', nameAr: null, phoneNumber: null, uiStatus: 'qr_required', logoUrl: '/api/dashboard/accounts/3/logo?v=6-20261010115649' };
    expect(b.accountIdentityModel(rowad, 'en', 'Connected')).toMatchObject({ accountId: 1, name: 'Rowad Alfa Auto Care', logoUrl: '/dashboard/assets/logo.webp', number: '••••0545', status: 'Connected' });
    expect(b.accountIdentityModel(jotun, 'ar', 'متصل')).toMatchObject({ accountId: 2, name: 'جوتن رواد الفا', number: '••••7115', initial: 'ج' });
    expect(b.accountIdentityModel(q, 'ar')).toMatchObject({ accountId: 3, name: 'QMULATE Real Estate Consultancy', number: '', statusDot: 'qr_required' });
    // each account carries its own logo URL (no shared constant); accounts 1 and 2 show the same artwork under different names
    expect(new Set([rowad, jotun, q].map((a) => b.accountIdentityModel(a, 'en')!.logoUrl)).size).toBe(3);
    expect(b.accountIdentityModel(jotun, 'en')!.name).not.toBe(b.accountIdentityModel(rowad, 'en')!.name);
  });

  it('the identity never draws a logo from outside the application or a blank account', () => {
    for (const hostile of ['https://evil.example/x.png', '//evil.example/x.png', 'javascript:alert(1)', '/api/dashboard/customers/directory', '/api/dashboard/accounts/2/logo', '/api/dashboard/accounts/2/logo?v=1&x=<script>', null, 7]) {
      expect(b.accountIdentityModel({ id: 2, name: 'JOTUN Rowad Alfa', logoUrl: hostile }, 'en')!.logoUrl, String(hostile)).toBeNull();
    }
    for (const blank of [null, undefined, {}, { id: 1, name: '   ' }, { id: 1, name: 42 }]) expect(b.accountIdentityModel(blank, 'en')).toBeNull();
    expect(b.maskAccountNumber('966550000545')).toBe('••••0545');
    expect(b.maskAccountNumber('0545')).toBe('0545');
    expect(b.maskAccountNumber(null)).toBe('');
  });

  it('is wired to every place the selection changes: list load, account switch, language change and branding', () => {
    const branding = read('branding.js');
    const app = read('app.js');
    expect(branding).toMatch(/document\.addEventListener\('workspace:accounts', \(\) => \{ renderAccountIdentity\(\);/);
    expect(branding).toMatch(/document\.addEventListener\('workspace:account-changed', \(\) => \{ renderAccountIdentity\(\);/);
    expect(branding).toContain("appliedIdentityKey = ''; applyBranding()"); // a language change redraws it
    expect(app).toContain('renderAccountIdentity()');
    expect(app).toContain('accountAvatarHtml(identity');
    expect(read('ui.css')).toMatch(/\.topbar-mark,body:not\(\.route-home\) \.topbar-mark\{width:38px;height:38px\}/); // stays visible on phones
  });

  it('Arabic company names are registered for the interface without overwriting existing translations', () => {
    b.window.I18N_AR['Already Translated'] = 'مترجم سابقاً';
    b.registerAccountNames([{ name: 'JOTUN Rowad Alfa', nameAr: 'جوتن رواد الفا' }, { name: 'Already Translated', nameAr: 'مختلف' }, { name: 'No Arabic', nameAr: null }, null]);
    expect(b.window.I18N_AR['JOTUN Rowad Alfa']).toBe('جوتن رواد الفا');
    expect(b.window.I18N_AR['Already Translated']).toBe('مترجم سابقاً');
    expect(b.window.I18N_AR).not.toHaveProperty('No Arabic');
  });
});

describe('the browser never chooses the company', () => {
  const source = read('branding.js');
  it('branding.js reads no storage, URL, cookie or query string: its only input is the /me response', () => {
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|location\.|URLSearchParams|indexedDB|history\./);
    expect(source).not.toMatch(/\bfetch\s*\(|\bapi\s*\(/); // it draws the server's decision; it asks for nothing
  });

  it('nothing else in the dashboard derives a company from the URL or storage: the stored account id only selects an account the server already allows', () => {
    const shell = read('shell.js');
    expect(shell).toContain("applyBranding()");
    const app = read('app.js');
    expect(app).not.toMatch(/branding\s*=\s*.*(localStorage|location)/);
    // a changed set of accessible accounts (access granted or revoked) re-reads /me, so permissions and branding never stay stale
    expect(app).toMatch(/assignmentChanged\s*=/);
    expect(app).toMatch(/if \(assignmentChanged\) loadMe\(\)/);
  });

  it('is loaded after the shell (which calls it) and before the application', () => {
    const html = read('index.html');
    expect(html.indexOf('/dashboard/shell.js')).toBeLessThan(html.indexOf('/dashboard/branding.js'));
    expect(html.indexOf('/dashboard/branding.js')).toBeLessThan(html.indexOf('/dashboard/app.js'));
  });
});

describe('company-branded workspace: styling and identity rules', () => {
  const css = read('company.css');
  const selectorsOf = (text: string): string[] => [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}@][^{}]*)\{/g)].map((m) => m[1]!.trim());

  it('a single-account user sees no account switcher, add-account link or other business', () => {
    for (const hidden of ['#account-list', '#nav>.nav-group:first-child', 'a[data-add-account]', 'a[data-route="#/accounts"]', '#account-chip']) expect(css).toContain(`body[data-brand="company"] ${hidden}`);
  });

  it('every company rule is scoped to the company experience or to the new brand elements, so the default look cannot change', () => {
    // body:not([data-brand="company"]) = the developer-mode brand block (SYNRTECHS lockup above the "AI WORKSPACE" line), nothing else
    const allowed = /^(\.brand\[data-pending\]|\.brand-wm|\.brand-initial|\.topbar-mark|body\[data-brand="company"\]|body:not\(\[data-brand="company"\]\) (\.brand|#brand-name small)|:root\[dir="rtl"\] body:not\(\[data-brand="company"\]\) #brand-name small|@media \(max-width:640px\)|\.acct-(av|line)|\.account-item \.list-av|\.topbar \.crumb\.acct-line|\[data-theme="light"\] body\[data-brand="company"\]|:root\[data-theme="dark"\] (\.brand-initial|\.acct-av|body\[data-brand="company"\]))/;
    const offenders = selectorsOf(css).filter((s) => s.split(',').some((p) => !allowed.test(p.trim())));
    expect(offenders).toEqual([]);
  });

  it('light company sidebar reuses the sign-in brand panel gradient and the dark appearance has its own counterpart (in the same file, on the dark tokens)', () => {
    expect(css).toMatch(/\[data-theme="light"\] body\[data-brand="company"\] \.sidebar\{\s*background:radial-gradient\([^;]*linear-gradient\(168deg,#071740/);
    expect(css).toContain(':root[data-theme="dark"] body[data-brand="company"] .brand');
    expect(css).toContain(':root[data-theme="dark"] .brand-initial');
  });

  it('the company logo sits on a white tile so any logo stays legible in both themes', () => {
    expect(css).toMatch(/body\[data-brand="company"\] \.brand-logo\{[^}]*background:#fff/);
    expect(css).not.toMatch(/data-theme="dark"\] body\[data-brand="company"\] \.brand-logo\{[^}]*background:/); // the dark appearance keeps the white tile
  });

  it('SYNRTECHS stays the identity of the sign-in page, the default shell and developer mode: only the official logo artwork is used', () => {
    const app = read('app.js');
    const branding = read('branding.js');
    const html = read('index.html');
    expect(app).not.toContain('lg-logo');
    expect(app).toContain('synrtechs-logo-white.svg');
    expect(app).toContain('synrtechs-logo.svg');
    expect(branding).toContain('synrtechs-logo.svg');
    expect(branding).toContain('synrtechs-logo-white.svg');
    expect(html).toContain('<title>SYNRTECHS · AI Workspace</title>');
    expect(html).toContain('synrtechs-mark-white.svg'); // compact header: the official S mark
    // no stale developer artwork from the earlier brand kit is referenced anywhere
    for (const file of fs.readdirSync(DASH).filter((f) => /\.(js|html|css)$/.test(f))) expect(read(file), file).not.toMatch(/synrtech-studio-wordmark|pattern-sculpted-contours/);
  });

  it('the sign-in page shows only the developer identity: no customer logo in the page, the favicon or the icon files', () => {
    const app = read('app.js');
    const html = read('index.html');
    const login = app.slice(app.indexOf('<section class="lg-brand"'), app.indexOf('function renderOtpStep'));
    expect(login).not.toMatch(/logo\.webp|branding\/logo|company/i);
    expect(html).toContain('<link rel="icon" type="image/png" href="/dashboard/assets/favicon.png">');
    // favicon and app icon are the guide's navy S tile (rendered from the supplied PDF), not the Rowad Alfa logo the tab used to show
    for (const icon of ['assets/favicon.png', 'assets/logo-192.png']) {
      const png = fs.readFileSync(path.join(DASH, icon));
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.equals(fs.readFileSync(path.join(DASH, 'assets/logo.webp')))).toBe(false);
    }
    expect(fs.statSync(path.join(DASH, 'assets/favicon.png')).size).toBeLessThan(6000); // the navy tile (≈2.6 KB), not the 30 KB knot artwork it replaced
  });

  it('the supplied SYNRTECHS artwork is shipped as drawn: colour lockup (navy + violet mark, black lettering) and the white variant', () => {
    const colour = read('assets/developer/synrtechs-logo.svg');
    const white = read('assets/developer/synrtechs-logo-white.svg');
    const mark = read('assets/developer/synrtechs-mark.svg');
    const markWhite = read('assets/developer/synrtechs-mark-white.svg');
    expect(colour.match(/<path /g)).toHaveLength(12); // nine letters + the three parts of the S mark
    expect(white.match(/<path /g)).toHaveLength(12);
    expect(mark.match(/<path /g)).toHaveLength(3);
    expect(markWhite.match(/<path /g)).toHaveLength(3);
    expect(colour).toContain('#071740');
    expect(colour).toContain('#6941E2');
    expect([...new Set([...white.matchAll(/fill="(#[0-9A-F]{6})"/g)].map((m) => m[1]))]).toEqual(['#FFFFFF']);
    for (const svg of [colour, white, mark, markWhite]) expect(svg).not.toMatch(/<script|<image|href=|onload/i); // plain vector artwork only
  });

  it('the developer is credited next to a company workspace and not next to its own identity', () => {
    expect(read('index.html')).toMatch(/id="dev-credit" hidden/);
    expect(read('branding.js')).toContain("credit.hidden = model.mode !== 'company'");
  });
});
