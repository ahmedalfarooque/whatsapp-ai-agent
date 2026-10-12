import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The premium workspace layout (header bar, attention bar + KPI strip, two-column home, conversation workspace) is pinned here so a later
// colour tweak cannot quietly bring back the card-per-metric dashboard or the floating hero header.

const DASH = path.resolve(__dirname, '..', '..', '..', 'dashboard');
const read = (f: string): string => fs.readFileSync(path.join(DASH, f), 'utf8');
const comment = /\/\*[\s\S]*?\*\//g;
const ui = read('ui.css').replace(comment, '');
const tokens = read('tokens.css').replace(comment, '');
const home = read('pages-home.js');
const inbox = read('pages-inbox.js');

describe('shell', () => {
  it('the header is a sticky full-width bar with one hairline, not a floating card', () => {
    const rule = /\.topbar\{([^}]*)\}/.exec(ui)![1]!;
    expect(rule).toMatch(/position:sticky/);
    expect(rule).toMatch(/border-bottom:1px solid var\(--color-border\)/);
    expect(rule).toMatch(/border-radius:0/);
    expect(ui).toMatch(/\.main\{[^}]*--gutter:max\(28px,calc\(\(100% - 1480px\) \/ 2\)\)/);
  });

  it('the page description stays for assistive technology but is not drawn, and phones anchor the header, so the account menu spans the screen', () => {
    expect(ui).toMatch(/\.topbar #page-subtitle\{position:absolute;width:1px;height:1px/);
    expect(ui).toMatch(/@media \(max-width:700px\)\{\.topbar\{position:relative\}\}/);
    expect(ui).toMatch(/\.profile\{position:static\}[^}]*\}?\s*\.profile-panel\{left:14px;right:14px/);
  });

  it('labels use the body face, navigation has no coloured side rail, and radii come from the scale', () => {
    expect(ui).not.toMatch(/\.nav-group[^{]*\{[^}]*font-family:var\(--font-mono\)/);
    expect(ui).not.toMatch(/nav a\.active\{[^}]*box-shadow:inset/);
    expect(read('rtl.css')).not.toMatch(/nav a\.active\{box-shadow/);
    expect(tokens).toMatch(/--radius-sm:6px;--radius-md:8px;--radius-lg:10px;--radius-xl:12px;--radius-2xl:14px/);
  });

  it('a table wider than its panel scrolls inside the panel instead of the page', () => {
    expect(ui).toMatch(/\.panel\{padding:18px 20px;overflow-x:auto\}/);
  });
});

describe('dashboard home', () => {
  it('is a status hero, a KPI strip and two columns, with no mascot and no per-metric icon chips', () => {
    expect(home).toMatch(/class="hero2 /);
    expect(home).toMatch(/class="hero2-side"/);
    expect(home).toMatch(/class="kpis"/);
    expect(home).toMatch(/<div class="dash-main">/);
    expect(home).not.toMatch(/ROBOT|mascot|kpi-icon/);
    expect(home).not.toContain('class="alerts"');
    expect(ui).toMatch(/\.hero2\{[^}]*grid-template-columns:minmax\(0,1\.75fr\) minmax\(250px,1fr\)/);
    expect(ui).toMatch(/\.kpis\{display:grid;grid-template-columns:repeat\(var\(--n,5\),minmax\(0,1fr\)\)/);
    expect(ui).toMatch(/\.dash-main\{display:grid;grid-template-columns:minmax\(0,1\.5fr\) minmax\(0,1fr\)/);
  });

  it('keeps every figure and link of the previous home (counts, requests, activity tabs, AI state, recent conversations)', () => {
    for (const needle of ['href="#/conversations/', 'Reply activity', 'Customer Requests', 'AI & Automation', 'data-tab=', '/api/dashboard/overview?range=']) expect(home.includes(needle), needle).toBe(true);
  });

  it('a figure is never colour alone: every bar and every segment carries its number as text', () => {
    expect(home).toMatch(/class="bar-row/);
    expect(home).toMatch(/<b>\$\{/);
    expect(home).toMatch(/sr-only/);
  });

  it('stacks the hero and the columns on narrow screens', () => {
    expect(ui).toMatch(/@media \(max-width:1240px\)\{[^@]*\.hero2\{grid-template-columns:1fr\}/);
    expect(ui).toMatch(/@media \(max-width:1100px\)\{\s*\.dash-main\{grid-template-columns:1fr\}/);
  });
});

describe('conversations workspace', () => {
  it('is one bordered workspace that fills the viewport, with an independently scrolling list and transcript', () => {
    expect(ui).toMatch(/\.inbox\{display:grid;grid-template-columns:minmax\(300px,360px\) minmax\(0,1fr\);[^}]*height:calc\(100dvh - 148px\)/);
    expect(ui).toMatch(/\.inbox-items\{[^}]*overflow-y:auto;flex:1;min-height:0\}/);
    expect(ui).toMatch(/\.inbox-thread \.transcript\{flex:1;min-height:0;max-height:none/);
  });

  it('the thread groups messages by sender with day separators and a sender badge; the composer is one box inside the thread', () => {
    expect(inbox).toMatch(/function inboxThreadHtml\(messages, customerName = ''\)/);
    expect(inbox).toContain('class="day-sep" role="separator"');
    expect(inbox).toContain('inboxThreadHtml(t.messages, customerName)');
    expect(inbox).toContain('UiKit.groupFlags(messages)');
    expect(inbox).toContain('class="reply-form composer"');
    expect(ui).toMatch(/\.msg-row\{/);
    expect(ui).toMatch(/\.msg-av\.ai\{/);
    expect(ui).toMatch(/\.bubble\.out\.staff\{/);
    expect(ui).toMatch(/\.composer-box:focus-within\{/);
    expect(ui).toMatch(/\.inbox-thread \.reply-form\{/);
  });

  it('phones keep list-then-thread with a back button, and bubbles use the width', () => {
    expect(ui).toMatch(/@media \(max-width:900px\)\{\s*\.inbox\{grid-template-columns:1fr\}/);
    expect(ui).toContain('.thread-back{display:inline-flex}');
    expect(ui).toMatch(/\.bubble\{max-width:88%\}/);
  });
});

// REGRESSION: the Super Admin / account dropdown used to open behind the page content. A menu is a descendant of the sticky header, so it can only rise
// above the cards below when the header itself outranks them, and anything that makes the header (or the menu's wrapper) a new stacking context or a
// clipping box (backdrop-filter, filter, transform, overflow, contain) would trap or cut the menu. These tests pin both halves of that contract.
describe('account menu (Super Admin dropdown)', () => {
  const css = read('ui.css') + '\n' + read('styles.css');
  const stripped = css.replace(comment, '');
  const rulesFor = (selector: RegExp): string[] => [...stripped.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].filter((m) => selector.test(m[1]!.trim())).map((m) => m[2]!);
  const zOf = (decl: string): number | null => { const m = /(?:^|;)\s*z-index:\s*(-?\d+)/.exec(decl); return m ? Number(m[1]) : null; };

  it('the header is sticky with a z-index above page content and never becomes a clipping box or a transformed layer', () => {
    const decls = rulesFor(/^\.topbar$/);
    expect(decls.length).toBeGreaterThan(0);
    const all = decls.join(';');
    expect(all).toMatch(/position:sticky/);
    expect(Math.max(...decls.map((d) => zOf(d) ?? -1))).toBeGreaterThanOrEqual(40);
    expect(all).not.toMatch(/(?:^|;)\s*(?:overflow(?:-[xy])?|transform|filter|perspective|contain|will-change|backdrop-filter|-webkit-backdrop-filter|clip-path|mask)\s*:/);
  });

  it('no @supports or media rule puts a backdrop-filter back on the header or the menu wrapper', () => {
    expect(stripped).not.toMatch(/\.topbar[^{}]*\{[^}]*backdrop-filter/);
    expect(stripped).not.toMatch(/\.topbar-controls[^{}]*\{[^}]*(?:overflow|transform|filter)\s*:/);
    expect(stripped).not.toMatch(/\.profile\s*\{[^}]*(?:overflow|transform|filter|contain)\s*:/);
  });

  it('the menu panel is positioned inside the header and ranks above its siblings; on phones it spans the screen instead of running off the edge', () => {
    const panel = rulesFor(/^\.profile-panel$/);
    expect(panel.join(';')).toMatch(/position:absolute/);
    expect(Math.max(...panel.map((d) => zOf(d) ?? -1))).toBeGreaterThanOrEqual(10);
    expect(stripped).toMatch(/@media \(max-width:700px\)\{[^@]*\.profile\{position:static\}[^@]*\.profile-panel\{left:14px;right:14px/);
  });

  it('no page-content rule outranks the header: every other z-index in the stylesheets is below it, except overlays that are meant to cover it', () => {
    const OVERLAY = /topbar|profile|palette|toast|dialog|modal|overlay|scrim|drawer|sidebar|nav-toggle|backdrop/;
    const offenders = [...stripped.matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
      .map((m) => ({ sel: m[1]!.trim(), z: zOf(m[2]!) }))
      .filter((r) => r.z !== null && r.z >= 40 && !OVERLAY.test(r.sel));
    expect(offenders).toEqual([]);
  });

  it('the markup is a disclosure menu: a button that owns aria-expanded and a panel of menu items, closed on Escape, Tab and outside clicks', () => {
    const shell = read('shell.js');
    expect(shell).toMatch(/aria-haspopup/);
    expect(shell).toMatch(/aria-expanded/);
    expect(shell).toMatch(/role="menuitem"|\[role="menuitem"\]/);
    expect(shell).toMatch(/Escape/);
    expect(shell).toMatch(/Tab/);
    expect(shell).toMatch(/document\.addEventListener\('(?:click|pointerdown|mousedown)'/);
  });
});

describe('build identifier, environment banner and quick search are wired', () => {
  const html = read('index.html');
  it('the page loads the kit before the shell, the palette after the app, and has a banner and a build stamp', () => {
    const order = (s: string) => html.indexOf(s);
    expect(order('/dashboard/ui-kit.js')).toBeGreaterThan(-1);
    expect(order('/dashboard/ui-kit.js')).toBeLessThan(order('/dashboard/shell.js'));
    expect(order('/dashboard/palette.js')).toBeGreaterThan(order('/dashboard/app.js'));
    expect(html).toMatch(/id="env-banner"[^>]*role="status"/);
    expect(html).toMatch(/id="build-info"/);
    expect(html).toMatch(/data-open-palette/);
  });
});
