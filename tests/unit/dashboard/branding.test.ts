import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const DASH = path.resolve(__dirname, '../../../dashboard');
const read = (file: string): string => fs.readFileSync(path.join(DASH, file), 'utf8');

interface Model { mode: string; name: string; initial: string; logoUrl: string | null; accountId: number | null; nameEn: string; nameAr: string | null }
interface Sandbox { brandModel: (me: unknown, lang: string) => Model; brandInitial: (name: string) => string; registerAccountNames: (accounts: unknown) => void; window: { I18N_AR: Record<string, string> } }

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

  it('developer mode (Super Admin, several accounts, anything unclear) is SynrTech Studio and carries no company', () => {
    for (const me of [{ branding: { mode: 'developer', company: null } }, {}, null, undefined, { branding: null }, { branding: { mode: 'company', company: null } }, { branding: { mode: 'company', company: { accountId: 1, name: '   ' } } }, { branding: { mode: 'somethingElse', company: { name: 'X' } } }]) {
      expect(b.brandModel(me, 'en')).toMatchObject({ mode: 'developer', name: 'SynrTech Studio', logoUrl: null, accountId: null });
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
  const dark = read('theme-dark.css');
  const selectorsOf = (text: string): string[] => [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}@][^{}]*)\{/g)].map((m) => m[1]!.trim());

  it('a single-account user sees no account switcher, add-account link or other business', () => {
    for (const hidden of ['#account-list', '#nav>.nav-group:first-child', 'a[data-add-account]', 'a[data-route="#/accounts"]', '#account-chip']) expect(css).toContain(`body[data-brand="company"] ${hidden}`);
  });

  it('every company rule is scoped to the company experience or to the new brand elements, so the default look cannot change', () => {
    const allowed = /^(\.brand\[data-pending\]|\.brand-wm|\.brand-initial|\.topbar-mark|body\[data-brand="company"\]|\[data-theme="light"\] body\[data-brand="company"\])/;
    const offenders = selectorsOf(css).filter((s) => s.split(',').some((p) => !allowed.test(p.trim())));
    expect(offenders).toEqual([]);
  });

  it('light company sidebar reuses the sign-in brand panel gradient and the dark theme has its own counterpart', () => {
    expect(css).toMatch(/\[data-theme="light"\] body\[data-brand="company"\] \.sidebar\{\s*background:linear-gradient\(168deg,#04233d/);
    expect(dark).toContain('[data-theme="dark"] body[data-brand="company"] .brand');
    expect(dark).toContain('[data-theme="dark"] .brand-initial');
  });

  it('the company logo sits on a white tile so any logo stays legible in both themes', () => {
    expect(css).toMatch(/body\[data-brand="company"\] \.brand-logo\{[^}]*background:#fff/);
    expect(dark).toMatch(/body\[data-brand="company"\] \.brand-logo\{[^}]*background:#fff/);
  });

  it('SynrTech Studio stays the identity of the sign-in page, the default shell and developer mode: only the official wordmark artwork is used', () => {
    const app = read('app.js');
    const branding = read('branding.js');
    expect(app).not.toContain('lg-logo');
    expect(app).toContain('synrtech-studio-wordmark-white.svg');
    expect(app).toContain('synrtech-studio-wordmark-black.svg');
    expect(branding).toContain('synrtech-studio-wordmark-black.svg');
    expect(read('index.html')).toContain('<title>SynrTech Studio · AI Workspace</title>');
  });

  it('the developer is credited next to a company workspace and not next to its own identity', () => {
    expect(read('index.html')).toMatch(/id="dev-credit" hidden/);
    expect(read('branding.js')).toContain("credit.hidden = model.mode !== 'company'");
  });
});
