import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const DASH = path.resolve(__dirname, '../../../dashboard');
const read = (file: string): string => fs.readFileSync(path.join(DASH, file), 'utf8');
const DICTIONARIES = ['i18n-ar.js', 'i18n-ar-2.js', 'i18n-ar-3.js', 'i18n-ar-4.js', 'i18n-ar-5.js', 'i18n-ar-6.js'];

interface Engine {
  dict: Record<string, string>;
  patterns: [RegExp, (...args: string[]) => string | null | undefined][];
  lookup: (text: string) => string | null;
  t: (text: string, vars?: Record<string, unknown>) => string;
}

/** Loads the dictionaries and the engine exactly as the browser does, in a sandbox with just enough of a window to boot without a page. */
function load(lang: 'ar' | 'en'): Engine {
  const storage = new Map<string, string>([['workspace.lang', lang]]);
  const win: Record<string, unknown> = {};
  const sandbox = {
    window: win,
    document: { readyState: 'loading', addEventListener: () => undefined },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
    CustomEvent: class {},
    console,
  };
  win.window = win;
  vm.createContext(sandbox);
  for (const file of [...DICTIONARIES, 'i18n.js']) vm.runInContext(read(file), sandbox, { filename: file });
  const i18n = win.I18N as { lookup: Engine['lookup']; t: Engine['t'] };
  return { dict: win.I18N_AR as Record<string, string>, patterns: win.I18N_AR_PATTERNS as Engine['patterns'], lookup: i18n.lookup, t: i18n.t };
}

const HAS_ARABIC = /[؀-ۿ]/;

describe('Arabic dictionary', () => {
  const ar = load('ar');

  it('every dictionary file loads and contributes entries and the engine boots', () => {
    expect(Object.keys(ar.dict).length).toBeGreaterThan(1000);
    expect(ar.patterns.length).toBeGreaterThan(30);
  });

  it('every translation is a non-empty Arabic text (or a deliberate identical acronym such as CSV)', () => {
    const bad: string[] = [];
    for (const [key, value] of Object.entries(ar.dict)) {
      if (typeof value !== 'string' || !value.trim()) bad.push(`${key} -> empty`);
      else if (!HAS_ARABIC.test(value) && value.trim() !== key.trim() && !/^[\d\W]+$/.test(value)) bad.push(`${key} -> ${value} (no Arabic)`);
      if (/\b(undefined|null|NaN)\b/.test(String(value))) bad.push(`${key} -> contains ${value}`);
    }
    expect(bad).toEqual([]);
  });

  it('the same English text never has two different translations across the files', () => {
    const seen = new Map<string, { value: string; file: string }>();
    const conflicts: string[] = [];
    const pair = /'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)'/g;
    for (const file of DICTIONARIES) {
      for (const line of read(file).split(/\r?\n/).filter((l) => !/^\s*\[\//.test(l))) for (const m of line.matchAll(pair)) {
        const key = m[1]!.replace(/\\'/g, "'").replace(/\s+/g, ' ').trim();
        const value = m[2]!;
        const before = seen.get(key);
        if (before && before.value !== value) conflicts.push(`${key}: "${before.value}" (${before.file}) vs "${value}" (${file})`);
        else if (!before) seen.set(key, { value, file });
      }
    }
    expect(conflicts).toEqual([]);
  });

  it('every pattern is a regular expression with a function that returns Arabic text or declines', () => {
    for (const [re, fn] of ar.patterns) {
      expect(Object.prototype.toString.call(re)).toBe('[object RegExp]'); // (a different realm than the test, so not instanceof)
      expect(typeof fn).toBe('function');
    }
    // run a few: pluralised / formatted messages keep their numbers and read in Arabic
    expect(ar.lookup('5m ago')).toMatch(HAS_ARABIC);
    expect(ar.lookup('5m ago')).toContain('5');
    expect(ar.lookup('Please wait 12s before requesting another code.')).toContain('12');
    expect(ar.lookup('Too many sign-in attempts. Please wait a few minutes and try again.')).toMatch(HAS_ARABIC);
  });

  it('translates exact texts, patterns and " · " lines; leaves unknown text (names, messages, ids) alone', () => {
    expect(ar.lookup('Customers')).toBe('العملاء');
    expect(ar.lookup('  Customers \n')).toBe('العملاء'); // whitespace is normalised
    expect(ar.lookup('Pending · Customers')).toBe(`${ar.lookup('Pending')} · ${ar.lookup('Customers')}`);
    expect(ar.lookup('Pending · Layla Al Harbi')).toBe(`${ar.lookup('Pending')} · Layla Al Harbi`); // a name inside a line stays as written
    expect(ar.lookup('Layla Al Harbi')).toBeNull();
    expect(ar.lookup('INQ-2026-5709')).toBeNull();
    expect(ar.lookup('owner@example.com')).toBeNull();
    expect(ar.lookup('+965 5000 0000')).toBeNull();
    expect(ar.lookup('')).toBeNull();
    expect(ar.lookup('x'.repeat(5000))).toBeNull();
    expect(ar.lookup('(.*)[a-z]+? \\d{2,}')).toBeNull(); // regex-looking text is just text
    expect(ar.lookup('toString')).toBeNull(); // inherited object keys are not translations
    expect(ar.lookup('constructor')).toBeNull();
  });

  it('server messages that must stay generic are translated without adding detail', () => {
    const generic = ar.lookup('invalid username or password');
    expect(generic).toMatch(HAS_ARABIC);
    expect(generic).not.toMatch(/email|exist|found|بريد|موجود/i); // never hints whether an account exists
  });

  it('t() returns Arabic when Arabic is selected and the original English otherwise, and fills {placeholders}', () => {
    expect(ar.t('Customers')).toBe('العملاء');
    expect(load('en').t('Customers')).toBe('Customers');
    expect(load('en').t('Hello {name}', { name: 'Sara' })).toBe('Hello Sara');
    expect(ar.t('Some text with no translation')).toBe('Some text with no translation');
  });
});

describe('Arabic coverage of the application text', () => {
  const ar = load('ar');
  const scripts = fs.readdirSync(DASH).filter((f) => f.endsWith('.js') && !f.startsWith('i18n'));

  it('every sidebar entry is translated', () => {
    const html = read('index.html');
    const labels = [...html.matchAll(/<a [^>]*href="#\/[^"]*"[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]!.replace(/&amp;/g, '&').trim()).filter(Boolean);
    expect(labels.length).toBeGreaterThan(15);
    expect(labels.filter((l) => ar.lookup(l) === null)).toEqual([]);
  });

  it('every page title and description is translated', () => {
    const missing: string[] = [];
    for (const file of scripts) {
      for (const m of read(file).matchAll(/route\(\s*'#\/[^']*'\s*,\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'/g)) {
        for (const text of [m[1]!, m[2]!]) {
          const clean = text.replace(/\\'/g, "'");
          if (clean && ar.lookup(clean) === null) missing.push(`${file}: ${clean}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('buttons and toasts written as plain strings in the scripts are translated', () => {
    const missing: string[] = [];
    for (const file of scripts) {
      const source = read(file);
      for (const m of source.matchAll(/toast\(\s*'((?:[^'\\]|\\.)*)'/g)) {
        const text = m[1]!.replace(/\\'/g, "'");
        if (/[A-Za-z]{3}/.test(text) && ar.lookup(text) === null) missing.push(`${file} toast: ${text}`);
      }
      for (const m of source.matchAll(/<button[^>]*>\s*([A-Z][A-Za-z ,'’-]{2,40})\s*<\/button>/g)) {
        if (ar.lookup(m[1]!.trim()) === null) missing.push(`${file} button: ${m[1]!.trim()}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('the language switch is a pure display change', () => {
  it('the i18n scripts never call the API or change stored data', () => {
    for (const file of [...DICTIONARIES, 'i18n.js']) {
      const source = read(file);
      expect(source, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|\bapi\s*\(/);
    }
    // the only thing remembered is the language itself, in this browser
    const engine = read('i18n.js');
    const writes = [...engine.matchAll(/localStorage\.setItem\(([^,]+),/g)].map((m) => m[1]!.trim());
    expect(writes).toEqual(['KEY']);
  });

  it('theme-init applies the saved language before the first paint', () => {
    const init = read('theme-init.js');
    expect(init).toContain("workspace.lang");
    expect(init).toContain('rtl');
  });

  it('the page loads the dictionaries before the engine, and rtl.css after the other styles', () => {
    const html = read('index.html');
    const order = [...DICTIONARIES, 'i18n.js'].map((f) => html.indexOf(`/dashboard/${f}`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
    expect(html.indexOf('rtl.css')).toBeGreaterThan(html.indexOf('ui.css'));
  });
});
