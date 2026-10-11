import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DASH = path.resolve(__dirname, '../../../dashboard');
const read = (file: string): string => fs.readFileSync(path.join(DASH, file), 'utf8');
const dark = read('theme-dark.css');

/** WCAG 2.1 contrast ratio between two #rrggbb colours. */
function ratio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The value of a custom property declared in the dark layer, e.g. token('--syn-panel') -> '#0b1c4a'. */
function token(name: string): string {
  const m = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*(#[0-9a-fA-F]{6})`).exec(dark);
  if (!m) throw new Error(`token ${name} not found`);
  return m[1]!.toLowerCase();
}

describe('dark theme: SYNRTECHS brand', () => {
  it('uses the palette of the supplied brand guide exactly (navy, teal, purple) and the derived steps between them', () => {
    expect(token('--syn-navy')).toBe('#071740');
    expect(token('--syn-teal')).toBe('#27e6c5');
    expect(token('--syn-violet')).toBe('#6941e2');
    expect(token('--syn-white')).toBe('#ffffff');
    // derived from the navy (documented in the file header): canvas, panel, raised row, hairline, input border, muted text
    expect(token('--syn-canvas')).toBe('#050e2d');
    expect(token('--syn-panel')).toBe('#0b1c4a');
    expect(token('--syn-raised')).toBe('#122760');
    expect(token('--syn-line')).toBe('#26396f');
    expect(token('--syn-line-strong')).toBe('#6f83c0');
    expect(token('--syn-muted')).toBe('#aab6dc');
    expect(dark).toContain('#ff6b6b'); // coral: danger
  });

  it('never uses a retired brand colour, and keeps the rules: titles white, body white, primary action teal with a navy label', () => {
    for (const retired of ['#155e75', '#5cb8f4', '#f7f3ee', '#9b6046', '#111112', '#222222', '#d7a17f', '#20afbd', '#a1a3a4', '#363637']) expect(dark.toLowerCase()).not.toContain(retired);
    expect(dark).toMatch(/h1[^{]*\{[^}]*color:var\(--syn-title\)/);
    expect(dark).toMatch(/--color-text:var\(--syn-white\)/);
    expect(dark).toMatch(/--color-primary:var\(--syn-teal\)/);
    expect(dark).toMatch(/--color-on-primary:var\(--syn-canvas\)/);
    expect(dark).toMatch(/\.btn\.primary\{[^}]*color:var\(--syn-canvas\)/);
  });

  it('every rule is scoped to the dark appearance, so the light theme (the default) cannot change', () => {
    const css = dark.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = css.replace(/@font-face\{[^}]*\}/g, '');
    const selectors = [...rules.matchAll(/(?:^|\})\s*([^{}@][^{}]*)\{/g)].map((m) => m[1]!.trim());
    expect(selectors.length).toBeGreaterThan(100);
    const unscoped = selectors.filter((s) => s.split(',').some((part) => !/^(:root)?\[data-theme="dark"\]/.test(part.trim())));
    expect(unscoped).toEqual([]);
    expect(read('index.html')).toContain('<html lang="en" data-theme="light">'); // light stays the default
  });

  it('reaches the contrast levels for the pairs the interface uses', () => {
    const canvas = token('--syn-canvas');
    const panel = token('--syn-panel');
    const raised = token('--syn-raised');
    const navy = token('--syn-navy');
    const teal = token('--syn-teal');
    const muted = token('--syn-muted');
    const checks: [string, string, string, number][] = [
      ['white body on canvas', '#ffffff', canvas, 4.5], ['white body on panel', '#ffffff', panel, 4.5], ['white body on raised rows', '#ffffff', raised, 4.5],
      ['muted on canvas', muted, canvas, 4.5], ['muted on panel', muted, panel, 4.5], ['muted on raised', muted, raised, 4.5],
      ['teal text and figures on canvas', teal, canvas, 4.5], ['teal on panel', teal, panel, 4.5], ['teal on raised', teal, raised, 4.5],
      ['navy label on teal button', canvas, teal, 4.5], ['brand navy label on teal', navy, teal, 4.5],
      ['violet text tint on panel', token('--syn-violet-text'), panel, 4.5],
      ['input border on panel (UI component)', token('--syn-line-strong'), panel, 3], ['input border on canvas', token('--syn-line-strong'), canvas, 3],
      // the sign-in brand panel (login.css) is navy in both appearances
      ['white on the navy panel', '#ffffff', navy, 4.5], ['hero copy on the navy panel', '#c3cdee', navy, 4.5], ['small copy on the navy panel', '#aab6dc', navy, 4.5], ['teal on the navy panel', teal, navy, 4.5],
      ['white on the violet hover of the sign-in button', '#ffffff', token('--syn-violet'), 4.5], ['white on the navy sign-in button', '#ffffff', navy, 4.5],
    ];
    const failures = checks.filter(([, fg, bg, min]) => ratio(fg, bg) < min).map(([name, fg, bg, min]) => `${name}: ${ratio(fg, bg).toFixed(2)} < ${min} (${fg} on ${bg})`);
    expect(failures).toEqual([]);
    // functional status colours read on the panels they appear on
    for (const [name, value] of [['success', '#6fd0a7'], ['warning', '#f5b94a'], ['danger', '#ff6b6b']] as const) {
      expect(dark, name).toContain(value);
      expect(ratio(value, panel), `${name} on panel`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(value, canvas), `${name} on canvas`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('ships only open-licence fonts (Cairo for Arabic, Space Mono for labels, Geist), each with its licence, and never the Thmanyah files', () => {
    const files = fs.readdirSync(path.join(DASH, 'assets'), { recursive: true }).map(String);
    expect(files.filter((f) => /thmanyah/i.test(f))).toEqual([]);
    const fonts = ['Geist-Variable.woff2', 'Geist-OFL.txt', 'cairo-arabic-wght-normal.woff2', 'cairo-latin-wght-normal.woff2', 'space-mono-latin-400-normal.woff2', 'space-mono-latin-700-normal.woff2', 'Cairo-SpaceMono-OFL.txt'];
    expect(files).toEqual(expect.arrayContaining(fonts.map((f) => path.join('fonts', f))));
    expect(read('assets/fonts/Cairo-SpaceMono-OFL.txt')).toMatch(/SIL Open Font License/);
    expect(dark).not.toMatch(/url\([^)]*thmanyah/i);
    for (const m of dark.matchAll(/url\("\/dashboard\/assets\/fonts\/([^"]+)"\)/g)) expect(files, m[1]).toContain(path.join('fonts', m[1]!)); // every declared font file exists
    expect(dark).toMatch(/--font-sans:"Cairo","Segoe UI",Tahoma,Arial/); // Arabic (dark)
    expect(read('rtl.css')).toMatch(/:root\[dir="rtl"\] body\{font-family:"Cairo"/); // Arabic (both appearances)
    expect(dark).toMatch(/--font-mono:"Space Mono"/);
  });

  it('developer credit uses the official name and logo and does not replace the business identity', () => {
    const html = read('index.html');
    const app = read('app.js');
    expect(html).toContain('alt="SYNRTECHS"');
    expect(app).toContain('alt="SYNRTECHS"');
    expect(html + app).not.toMatch(/SynrTech Studio|Synrtech Studio|SYNRTECHS Studio/);
    // no customer business is hard-coded into the interface: company identity comes from the server (me.branding), the sign-in page and the
    // default shell are SYNRTECHS's
    const scripts = fs.readdirSync(DASH).filter((f) => f.endsWith('.js') && !f.startsWith('i18n')).map(read).join('\n');
    expect(scripts + html).not.toMatch(/Rowad Alfa|JOTUN|QMULATE/);
    expect(html).not.toContain('/dashboard/assets/logo-192.png');
    expect(html).toMatch(/id="dev-credit" hidden/); // the credit appears next to a company's workspace only
  });
});

describe('theme switch', () => {
  it('light is the default; a stored choice is applied before first paint', () => {
    const init = read('theme-init.js');
    expect(init).toContain("localStorage.getItem('workspace.theme')");
    expect(init).toMatch(/stored === 'dark' \|\| stored === 'light'/);
    expect(read('index.html').indexOf('theme-init.js')).toBeLessThan(read('index.html').indexOf('styles.css'));
  });

  it('the sign-in page and the top bar both offer an accessible switch that persists the choice', () => {
    const shell = read('shell.js');
    const app = read('app.js');
    expect(app).toContain('data-theme-switch');
    expect(app).toContain('mountThemeSwitches()');
    expect(shell).toMatch(/role="switch"/);
    expect(shell).toMatch(/aria-label="Dark appearance"/);
    expect(shell).toContain("localStorage.setItem(THEME_KEY");
    expect(read('index.html')).toMatch(/id="theme-toggle" role="switch" aria-checked="false" aria-label="Dark appearance"/);
    expect(read('login.css')).toMatch(/\.theme-switch:focus-visible\{outline:2px solid var\(--focus-ring\)/);
  });

  it('changing the appearance is a display change only: no network call or credential access in the switch code', () => {
    const shell = read('shell.js');
    const start = shell.indexOf('function setTheme');
    const end = shell.indexOf('// The signed-in user');
    const block = shell.slice(start, end);
    expect(block).not.toMatch(/\bfetch\s*\(|\bapi\s*\(|XMLHttpRequest|sendBeacon|password|session/i);
  });

  it('the new labels are translated', () => {
    const dictionaries = ['i18n-ar.js', 'i18n-ar-2.js', 'i18n-ar-3.js', 'i18n-ar-4.js', 'i18n-ar-5.js', 'i18n-ar-6.js'].map(read).join('\n');
    for (const key of ["'Dark appearance'", "'Dark'", "'Developed by'"]) expect(dictionaries).toContain(key);
  });
});
