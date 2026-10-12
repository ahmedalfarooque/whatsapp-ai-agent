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
  it('is an attention bar, a KPI strip and two columns, with no mascot and no per-metric icon chips', () => {
    expect(home).toMatch(/class="attn"/);
    expect(home).toMatch(/class="kpis"/);
    expect(home).toMatch(/<div class="dash-main">/);
    expect(home).not.toMatch(/ROBOT|mascot/);
    expect(home).not.toContain('class="alerts"');
    expect(ui).toMatch(/\.kpi-icon\{display:none\}/);
    expect(ui).toMatch(/\.attn\{display:grid;grid-template-columns:repeat\(var\(--n,3\),minmax\(0,1fr\)\)/);
    expect(ui).toMatch(/\.dash-main\{display:grid;grid-template-columns:minmax\(0,1\.45fr\) minmax\(0,1fr\)/);
  });

  it('keeps every figure and link of the previous home (counts, requests, activity tabs, AI state, recent conversations)', () => {
    for (const needle of ['href="#/conversations/', "'Activity Log'", 'Customer Requests', 'AI & Automation', 'data-tab=', '/api/dashboard/overview?range=']) expect(home.includes(needle) || home.includes(needle.replace(/'/g, '')), needle).toBe(true);
  });

  it('stacks the attention bar and the columns on narrow screens', () => {
    expect(ui).toMatch(/@media \(max-width:1240px\)\{[^@]*\.attn\{grid-template-columns:1fr\}/);
    expect(ui).toMatch(/@media \(max-width:1100px\)\{\s*\.dash-main\{grid-template-columns:1fr\}/);
  });
});

describe('conversations workspace', () => {
  it('is one bordered workspace that fills the viewport, with an independently scrolling list and transcript', () => {
    expect(ui).toMatch(/\.inbox\{display:grid;grid-template-columns:minmax\(300px,360px\) minmax\(0,1fr\);[^}]*height:calc\(100dvh - 148px\)/);
    expect(ui).toMatch(/\.inbox-items\{[^}]*overflow-y:auto;flex:1;min-height:0\}/);
    expect(ui).toMatch(/\.inbox-thread \.transcript\{flex:1;min-height:0;max-height:none/);
  });

  it('the thread shows day separators and the sender in each bubble; the composer stays in the thread', () => {
    expect(inbox).toMatch(/function inboxThreadHtml\(messages\)/);
    expect(inbox).toContain('class="day-sep" role="separator"');
    expect(inbox).toContain('inboxThreadHtml(t.messages)');
    expect(ui).toMatch(/\.bubble\.out\.ai\{/);
    expect(ui).toMatch(/\.bubble\.out\.staff\{/);
    expect(ui).toMatch(/\.inbox-thread \.reply-form\{/);
  });

  it('phones keep list-then-thread with a back button, and bubbles use the width', () => {
    expect(ui).toMatch(/@media \(max-width:900px\)\{\s*\.inbox\{grid-template-columns:1fr\}/);
    expect(ui).toContain('.thread-back{display:inline-flex}');
    expect(ui).toMatch(/\.bubble\{max-width:88%\}/);
  });
});
