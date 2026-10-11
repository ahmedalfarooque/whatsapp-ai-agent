import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DASH = path.resolve(__dirname, '../../../dashboard');
const read = (file: string): string => fs.readFileSync(path.join(DASH, file), 'utf8');
const tokensCss = read('tokens.css');

/** The declarations of the first rule whose selector starts with `selector` (a design-token block). */
function block(selector: string): string {
  const start = tokensCss.indexOf(`${selector}{`);
  if (start < 0) throw new Error(`block ${selector} not found`);
  let depth = 0;
  for (let i = tokensCss.indexOf('{', start); i < tokensCss.length; i += 1) {
    if (tokensCss[i] === '{') depth += 1;
    if (tokensCss[i] === '}') { depth -= 1; if (depth === 0) return tokensCss.slice(tokensCss.indexOf('{', start) + 1, i); }
  }
  throw new Error('unterminated block');
}
const LIGHT = block(':root,:root[data-theme="light"]');
const DARK = block(':root[data-theme="dark"]');
const declared = (css: string): Map<string, string> => new Map([...css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];
function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) .concat(1) as Rgba;
  const rgba = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`cannot parse colour ${value}`);
}
const over = (fg: Rgba, bg: Rgb): Rgb => [0, 1, 2].map((i) => Math.round(fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!))) as Rgb;
const lum = ([r, g, b]: Rgb): number => {
  const [rr, gg, bb] = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * rr! + 0.7152 * gg! + 0.0722 * bb!;
};
const ratio = (a: Rgb, b: Rgb): number => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

/** Resolves a token of an appearance to an opaque colour, laying translucent values over `base`. */
function colour(tokens: Map<string, string>, name: string, base: Rgb = [255, 255, 255]): Rgb {
  const value = tokens.get(name);
  if (!value) throw new Error(`token ${name} missing`);
  const c = parse(value);
  return c[3] === 1 ? [c[0], c[1], c[2]] : over(c, base);
}

describe('design tokens: one source for both appearances', () => {
  const light = declared(LIGHT);
  const dark = declared(DARK);

  it('keeps the brand palette of the SYNRTECHS guide exactly, and defines the same semantic tokens in both appearances', () => {
    const brand = declared(block(':root'));
    expect(brand.get('--brand-navy')).toBe('#071740');
    expect(brand.get('--brand-teal')).toBe('#27e6c5');
    expect(brand.get('--brand-purple')).toBe('#6941e2');
    expect(brand.get('--brand-coral')).toBe('#ff6b6b');
    const required = ['--color-canvas', '--color-sidebar', '--color-surface', '--color-surface-raised', '--color-surface-hover', '--color-field', '--color-border', '--color-border-strong',
      '--color-text', '--color-text-2', '--color-text-muted', '--color-text-subtle', '--color-link', '--color-primary', '--color-primary-hover', '--color-primary-soft', '--color-on-primary',
      '--color-accent', '--color-secondary', '--color-secondary-text', '--color-secondary-soft', '--focus-ring', '--focus-glow', '--color-success', '--color-warning', '--color-danger', '--color-info',
      '--color-success-soft', '--color-warning-soft', '--color-danger-soft', '--color-info-soft', '--color-success-line', '--color-warning-line', '--color-danger-line', '--color-info-line',
      '--elev-1', '--elev-2', '--shadow-overlay', '--scrim', '--glass-bg', '--glass-bg-strong', '--glass-border', '--glass-edge', '--wash', '--chart-1', '--chart-2', '--chart-3', '--chart-track', '--chev'];
    for (const name of required) { expect(light.has(name), `light ${name}`).toBe(true); expect(dark.has(name), `dark ${name}`).toBe(true); }
  });

  it('teal carries the primary action with a navy label, purple the secondary emphasis, coral the danger, in the dark appearance', () => {
    expect(dark.get('--color-primary')).toBe('#27e6c5');
    expect(dark.get('--color-secondary')).toBe('#6941e2');
    expect(dark.get('--color-danger')).toBe('#ff6b6b');
    expect(light.get('--color-primary')).toBe('#27e6c5');
    expect(light.get('--color-on-primary')).toBe('#04122e');
    expect(dark.get('--color-on-primary')).toBe('#04122e');
  });

  it('the dark appearance has a real surface hierarchy (canvas < sidebar < card < raised < hover), not one flat navy', () => {
    const steps = ['--color-canvas', '--color-sidebar', '--color-surface', '--color-surface-raised', '--color-surface-hover'].map((n) => lum(colour(dark, n)));
    for (let i = 1; i < steps.length; i += 1) expect(steps[i]!, `step ${i}`).toBeGreaterThan(steps[i - 1]!);
    expect(new Set(steps).size).toBe(5);
    // the light appearance steps the other way: canvas is the darkest neutral, the card is white
    expect(colour(light, '--color-surface')).toEqual([255, 255, 255]);
    expect(lum(colour(light, '--color-canvas'))).toBeLessThan(lum(colour(light, '--color-surface')));
  });

  function check(name: string, tokens: Map<string, string>, surfaces: string[]): void {
    describe(`${name}: contrast of what the interface actually draws`, () => {
      it('body, secondary and quiet text read on every surface (4.5:1)', () => {
        const failures: string[] = [];
        for (const s of surfaces) for (const t of ['--color-text', '--color-text-2', '--color-text-muted', '--color-text-subtle']) {
          const r = ratio(colour(tokens, t), colour(tokens, s));
          if (r < 4.5) failures.push(`${t} on ${s}: ${r.toFixed(2)}`);
        }
        expect(failures).toEqual([]);
      });
      it('accent text, links, purple text and the status colours read on the card and raised surfaces (4.5:1)', () => {
        const failures: string[] = [];
        for (const s of ['--color-surface', '--color-surface-raised']) for (const t of ['--color-accent', '--color-link', '--color-secondary-text', '--color-success', '--color-warning', '--color-danger', '--color-info']) {
          const r = ratio(colour(tokens, t), colour(tokens, s));
          if (r < 4.5) failures.push(`${t} on ${s}: ${r.toFixed(2)}`);
        }
        expect(failures).toEqual([]);
      });
      it('tone text reads on its own soft tint laid over the card (badges, chips, alert icons)', () => {
        const failures: string[] = [];
        const base = colour(tokens, '--color-surface');
        for (const [fg, bg] of [['--color-success', '--color-success-soft'], ['--color-warning', '--color-warning-soft'], ['--color-danger', '--color-danger-soft'], ['--color-info', '--color-info-soft'], ['--color-secondary-text', '--color-secondary-soft'], ['--color-accent', '--color-primary-soft']] as const) {
          const r = ratio(colour(tokens, fg), over(parse(tokens.get(bg)!), base));
          if (r < 4.5) failures.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
        }
        expect(failures).toEqual([]);
      });
      it('the primary button label, the control edge and the focus ring are legible (4.5:1 / 3:1 / 3:1)', () => {
        for (const p of ['--color-primary', '--color-primary-hover']) expect(ratio(colour(tokens, '--color-on-primary'), colour(tokens, p)), p).toBeGreaterThanOrEqual(4.5);
        for (const s of ['--color-surface', '--color-field', '--color-surface-raised']) {
          expect(ratio(colour(tokens, '--color-border-strong'), colour(tokens, s)), `edge on ${s}`).toBeGreaterThanOrEqual(3);
          expect(ratio(colour(tokens, '--focus-ring'), colour(tokens, s)), `focus on ${s}`).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }
  check('light', light, ['--color-canvas', '--color-sidebar', '--color-surface', '--color-surface-raised', '--color-surface-hover']);
  check('dark', dark, ['--color-canvas', '--color-sidebar', '--color-surface', '--color-surface-raised', '--color-surface-hover']);

  it('the sign-in brand panel stays navy in both appearances with readable copy', () => {
    const navy: Rgb = [7, 23, 64];
    for (const [name, hex, min] of [['white', '#ffffff', 4.5], ['hero copy', '#c3cdee', 4.5], ['small copy', '#aab6dc', 4.5], ['teal', '#27e6c5', 4.5]] as const) expect(ratio(parse(hex).slice(0, 3) as Rgb, navy), name).toBeGreaterThanOrEqual(min);
    expect(ratio([255, 255, 255], parse('#6941e2').slice(0, 3) as Rgb), 'white on the violet hover of the light sign-in button').toBeGreaterThanOrEqual(4.5);
    expect(ratio([255, 255, 255], navy), 'white on the navy sign-in button').toBeGreaterThanOrEqual(4.5);
  });
});

describe('component styles use tokens, not theme-specific colours', () => {
  const comment = /\/\*[\s\S]*?\*\//g;
  const stripped = (file: string): string => read(file).replace(comment, '');

  it('ui.css, login.css and company.css never branch on the appearance except for the few documented swaps', () => {
    const allowed = /:root\[data-theme="dark"\] (\.topbar-mark|\.lg-submit|\.brand-initial|body\[data-brand="company"\]|\.acct-av)/;
    for (const file of ['ui.css', 'login.css', 'company.css']) {
      const selectors = [...stripped(file).matchAll(/(?:^|\})\s*([^{}@][^{}]*)\{/g)].map((m) => m[1]!.trim());
      const branching = selectors.flatMap((s) => s.split(',').map((p) => p.trim())).filter((p) => /data-theme/.test(p) && !allowed.test(p) && !/^\[data-theme="light"\] body\[data-brand="company"\]/.test(p));
      expect(branching, file).toEqual([]);
    }
  });

  it('retired colours of the earlier saturated header and cards are gone', () => {
    for (const file of ['ui.css', 'login.css', 'company.css', 'tokens.css']) {
      const css = stripped(file).toLowerCase();
      for (const retired of ['#19b8a5', '#13a9a6', '#0e96ab', '#10a37f', '#0a9a8a', '#26c06a', '#1c93e4', '#155e75', '#5cb8f4', '#f7f3ee', '#9b6046', '#d7a17f']) expect(css, `${file} ${retired}`).not.toContain(retired);
    }
    expect(stripped('ui.css')).not.toMatch(/!important/);
  });

  it('glass is selective and always has a solid fallback: header, menus, toasts and the sign-in card, with reduced-transparency support', () => {
    expect(tokensCss).toMatch(/@media \(prefers-reduced-transparency:reduce\)/);
    expect(tokensCss).toMatch(/@supports \(\(-webkit-backdrop-filter:blur\(1px\)\) or \(backdrop-filter:blur\(1px\)\)\)/);
    const ui = read('ui.css');
    const login = read('login.css');
    // every backdrop-filter sits inside an @supports block: outside those blocks there is none, so unsupported browsers get the solid background
    const withoutSupports = (css: string): string => {
      let out = '';
      let i = 0;
      while (i < css.length) {
        const at = css.indexOf('@supports', i);
        if (at < 0) { out += css.slice(i); break; }
        out += css.slice(i, at);
        let depth = 0;
        let j = css.indexOf('{', at);
        for (; j < css.length; j += 1) { if (css[j] === '{') depth += 1; if (css[j] === '}') { depth -= 1; if (depth === 0) break; } }
        i = j + 1;
      }
      return out;
    };
    for (const css of [ui, login, tokensCss]) expect(withoutSupports(css)).not.toMatch(/backdrop-filter:(?!none)/); // "none" (reduced transparency) is the solid fallback itself
    expect(ui).toMatch(/\.topbar\{[^}]*background:var\(--glass-bg-strong\)/); // solid-enough base where blur is unsupported
    expect(login).toMatch(/\.lg-card\{[^}]*background:var\(--glass-bg-strong\)/);
    // blur is bounded: nothing above the two documented strengths
    expect(tokensCss).toMatch(/--blur:14px;--blur-strong:22px/);
  });

  it('motion respects reduced-motion, and the focus ring is defined for both appearances', () => {
    expect(tokensCss).toMatch(/@media \(prefers-reduced-motion:reduce\)/);
    expect(tokensCss).toMatch(/:focus-visible\{outline:2px solid var\(--focus-ring\)/);
  });

  it('theme-dark.css no longer exists: the dark appearance is the dark token block, not a parallel stylesheet', () => {
    expect(fs.existsSync(path.join(DASH, 'theme-dark.css'))).toBe(false);
    expect(read('index.html')).not.toContain('theme-dark.css');
    expect(read('index.html')).toContain('/dashboard/tokens.css');
    const html = read('index.html');
    expect(html.indexOf('tokens.css')).toBeGreaterThan(html.indexOf('theme.css'));
    expect(html.indexOf('tokens.css')).toBeLessThan(html.indexOf('ui.css'));
  });
});

describe('typography and licensing', () => {
  it('ships only open-licence fonts (Cairo for Arabic, Space Mono for labels, Geist), each with its licence, and never the Thmanyah files', () => {
    const files = fs.readdirSync(path.join(DASH, 'assets'), { recursive: true }).map(String);
    expect(files.filter((f) => /thmanyah/i.test(f))).toEqual([]);
    const fonts = ['Geist-Variable.woff2', 'Geist-OFL.txt', 'cairo-arabic-wght-normal.woff2', 'cairo-latin-wght-normal.woff2', 'space-mono-latin-400-normal.woff2', 'space-mono-latin-700-normal.woff2', 'Cairo-SpaceMono-OFL.txt'];
    expect(files).toEqual(expect.arrayContaining(fonts.map((f) => path.join('fonts', f))));
    expect(read('assets/fonts/Cairo-SpaceMono-OFL.txt')).toMatch(/SIL Open Font License/);
    expect(tokensCss).not.toMatch(/url\([^)]*thmanyah/i);
    for (const m of tokensCss.matchAll(/url\("\/dashboard\/assets\/fonts\/([^"]+)"\)/g)) expect(files, m[1]).toContain(path.join('fonts', m[1]!)); // every declared font file exists
    expect(tokensCss).toMatch(/--font-sans:"Cairo","Segoe UI",Tahoma/); // Arabic
    expect(read('rtl.css')).toMatch(/:root\[dir="rtl"\] body\{font-family:"Cairo"/);
    expect(tokensCss).toMatch(/--font-mono:"Space Mono"/);
    expect(tokensCss).toMatch(/--font-sans:"Geist"/);
  });

  it('developer credit uses the official name and logo and does not replace the business identity', () => {
    const html = read('index.html');
    const app = read('app.js');
    expect(html).toContain('alt="SYNRTECHS"');
    expect(app).toContain('alt="SYNRTECHS"');
    expect(html + app).not.toMatch(/SynrTech Studio|Synrtech Studio|SYNRTECHS Studio/);
    const scripts = fs.readdirSync(DASH).filter((f) => f.endsWith('.js') && !f.startsWith('i18n')).map(read).join('\n');
    expect(scripts + html).not.toMatch(/Rowad Alfa|JOTUN|QMULATE/);
    expect(html).not.toContain('/dashboard/assets/logo-192.png');
    expect(html).toMatch(/id="dev-credit" hidden/);
  });
});

describe('theme switch', () => {
  it('light is the default; a stored choice is applied before first paint', () => {
    const init = read('theme-init.js');
    expect(init).toContain("localStorage.getItem('workspace.theme')");
    expect(init).toMatch(/stored === 'dark' \|\| stored === 'light'/);
    expect(read('index.html')).toContain('<html lang="en" data-theme="light">');
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
    const block2 = shell.slice(start, end);
    expect(block2).not.toMatch(/\bfetch\s*\(|\bapi\s*\(|XMLHttpRequest|sendBeacon|password|session/i);
  });

  it('the new labels are translated', () => {
    const dictionaries = ['i18n-ar.js', 'i18n-ar-2.js', 'i18n-ar-3.js', 'i18n-ar-4.js', 'i18n-ar-5.js', 'i18n-ar-6.js'].map(read).join('\n');
    for (const key of ["'Dark appearance'", "'Dark'", "'Developed by'"]) expect(dictionaries).toContain(key);
  });
});
