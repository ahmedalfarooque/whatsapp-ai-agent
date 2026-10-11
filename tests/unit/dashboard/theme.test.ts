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

/** The value of a custom property declared in the dark layer, e.g. token('--syn-graphite') -> '#222222'. */
function token(name: string): string {
  const m = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*(#[0-9a-fA-F]{6})`).exec(dark);
  if (!m) throw new Error(`token ${name} not found`);
  return m[1]!.toLowerCase();
}

describe('dark theme: SynrTech Studio brand', () => {
  it('uses the approved palette tokens exactly (brand-tokens.json v2.1)', () => {
    expect(token('--syn-charcoal')).toBe('#111112');
    expect(token('--syn-graphite')).toBe('#222222');
    expect(token('--syn-copper')).toBe('#d7a17f');
    expect(token('--syn-teal')).toBe('#20afbd');
    expect(token('--syn-tertiary')).toBe('#a1a3a4');
    expect(token('--syn-rule')).toBe('#363637');
    expect(token('--syn-white')).toBe('#ffffff');
  });

  it('never uses a retired brand colour, and keeps the brand rules: titles copper, body white, primary action teal with a charcoal label', () => {
    for (const retired of ['#155e75', '#5cb8f4', '#f7f3ee', '#9b6046']) expect(dark.toLowerCase()).not.toContain(retired);
    expect(dark).toMatch(/h1[^{]*\{[^}]*color:var\(--syn-copper\)/);
    expect(dark).toMatch(/--color-text:var\(--syn-white\)/);
    expect(dark).toMatch(/--color-primary:var\(--syn-teal\)/);
    expect(dark).toMatch(/--color-on-primary:var\(--syn-charcoal\)/);
    expect(dark).toMatch(/\.btn\.primary\{[^}]*color:var\(--syn-charcoal\)/);
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

  it('reaches the brand contrast levels for the pairs the interface uses', () => {
    const charcoal = token('--syn-charcoal');
    const graphite = token('--syn-graphite');
    const raised = token('--syn-graphite-2');
    const checks: [string, string, string, number][] = [
      ['white body on charcoal', '#ffffff', charcoal, 4.5], ['white body on graphite', '#ffffff', graphite, 4.5], ['white body on raised rows', '#ffffff', raised, 4.5],
      ['copper titles on charcoal', token('--syn-copper'), charcoal, 4.5], ['copper titles on graphite', token('--syn-copper'), graphite, 4.5], ['copper on raised', token('--syn-copper'), raised, 4.5],
      ['tertiary on charcoal', token('--syn-tertiary'), charcoal, 4.5], ['tertiary on graphite', token('--syn-tertiary'), graphite, 4.5], ['tertiary on raised', token('--syn-tertiary'), raised, 4.5],
      ['charcoal label on teal button', charcoal, token('--syn-teal'), 4.5], ['teal on charcoal (focus, active marks)', token('--syn-teal'), charcoal, 3], ['teal on graphite', token('--syn-teal'), graphite, 3],
      ['input border on graphite (UI component)', token('--syn-rule-strong'), graphite, 3], ['input border on charcoal', token('--syn-rule-strong'), charcoal, 3],
    ];
    const failures = checks.filter(([, fg, bg, min]) => ratio(fg, bg) < min).map(([name, fg, bg, min]) => `${name}: ${ratio(fg, bg).toFixed(2)} < ${min} (${fg} on ${bg})`);
    expect(failures).toEqual([]);
    // functional status colours read on the panels they appear on
    for (const [name, value] of [['success', '#6fd0a7'], ['warning', '#d7a17f'], ['danger', '#e8837a']] as const) {
      expect(dark, name).toContain(value);
      expect(ratio(value, graphite), `${name} on graphite`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(value, charcoal), `${name} on charcoal`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('ships only what the licences allow: Geist (open licence) and the official wordmark, never the Thmanyah font files', () => {
    const files = fs.readdirSync(path.join(DASH, 'assets'), { recursive: true }).map(String);
    expect(files.filter((f) => /thmanyah/i.test(f))).toEqual([]);
    expect(files).toEqual(expect.arrayContaining([path.join('fonts', 'Geist-Variable.woff2'), path.join('fonts', 'Geist-OFL.txt')]));
    expect(dark).not.toMatch(/url\([^)]*thmanyah/i);
    expect(dark).toMatch(/"Thmanyah Sans","Geist",Arial/); // used only when installed on the viewer's device; Arial is the single fallback
    // the logo is always black or white (founder rule): the two wordmark files carry exactly one fill each
    expect(read('assets/developer/synrtech-studio-wordmark-white.svg')).toMatch(/fill="#FFFFFF"/);
    expect(read('assets/developer/synrtech-studio-wordmark-black.svg')).toMatch(/fill="#000000"/);
  });

  it('developer credit uses the approved spelling and does not replace the business identity', () => {
    const html = read('index.html');
    const app = read('app.js');
    expect(html).toContain('alt="SynrTech Studio"');
    expect(app).toContain('alt="SynrTech Studio"');
    expect(html + app).not.toMatch(/Synertech|SYNRTECH(?!\s*Studio)|Synrtech Studio/);
    // no customer business is hard-coded into the interface: company identity comes from the server (me.branding), the sign-in page and the
    // default shell are SynrTech Studio's
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
