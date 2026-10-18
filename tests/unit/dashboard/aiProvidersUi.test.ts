import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowed, specFor } from '../../../src/dashboard/authorize';

/**
 * The AI providers interface as a contract on the dashboard scripts (the page itself was also exercised in a real browser against a
 * disposable local server; these assertions keep the structure from drifting): Super Admin Settings exists only for the Super Admin, the
 * account list has two primary fields and no per-task columns, and every API call the new pages make is a route the server protects.
 */
const DASH = path.join(__dirname, '../../../dashboard');
const read = (f: string) => fs.readFileSync(path.join(DASH, f), 'utf8');
const app = read('app.js');
const shell = read('shell.js');

describe('Super Admin Settings entry', () => {
  it('is added to the account menu only for the Super Admin, next to (not instead of) the selected-business Settings', () => {
    expect(shell).toMatch(/if \(hasCap\('configuration'\)\) items\.push\('<a role="menuitem" href="#\/settings">Settings<\/a>'\);/);
    expect(shell).toMatch(/if \(me\.superAdmin\) items\.push\('<a role="menuitem" href="#\/super-admin-settings">Super Admin Settings<\/a>'\);/);
  });

  it('the page has no entry in the client access table (so only a Super Admin may open it) and its API is super-only on the server for every method', () => {
    expect(shell).not.toMatch(/'#\/super-admin-settings'\s*:/); // routeAllowed(): unknown routes are Super-Admin-only
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) expect(specFor(method, '/super-admin/ai/providers/3')).toEqual({ t: 'super' });
    const admin = { id: 2, role: 'admin', canConfiguration: true, canConnection: true, disabled: false, isProtected: false } as never;
    const owner = { id: 1, role: 'super_admin', disabled: false, isProtected: true } as never;
    expect(isAllowed(admin, 'GET', '/super-admin/ai', undefined)).toBe(false);
    expect(isAllowed(owner, 'GET', '/super-admin/ai', undefined)).toBe(true);
    expect(app).toMatch(/route\('#\/super-admin-settings', 'Super Admin Settings'/);
  });

  it('the selected-account Settings page is untouched (still its own route and its own API)', () => {
    expect(app).toMatch(/route\('#\/settings', 'Settings'/);
    expect(app).toContain("api('/api/dashboard/settings')");
  });
});

describe('the account AI providers list', () => {
  const form = app.slice(app.indexOf('function aiProviderFormHtml'), app.indexOf('function aiEntryRowHtml'));
  const row = app.slice(app.indexOf('function aiEntryRowHtml'), app.indexOf('function readAiForm'));

  it('asks for two things only — a name and the API configuration — with everything else behind "More options"', () => {
    expect(form).toContain("textField('name', 'API / Agent name'");
    expect(form).toContain("pwField('config', 'API configuration'");
    const primary = form.slice(0, form.indexOf('<details class="ai-more">'));
    expect(primary).not.toMatch(/visionModels|audioModels|freeTier|supportsTools|priority|timeoutMs/);
    expect(form).toContain('More options');
  });

  it('shows one row per entry with a compact status and the actions order / test / on-off / edit / remove — Default has no edit or remove', () => {
    for (const act of ['up', 'down', 'test', 'toggle', 'edit', 'remove']) expect(row).toContain(`data-act="${act}"`);
    expect(row).toMatch(/isDefault \? '' : '<button type="button" class="btn small" data-act="edit">/);
    expect(row).toContain('ai-summary'); // the one-line status (class renamed from ai-detail)
    expect(row).toContain('title="${esc(full || summary)}"'); // the full text only in the tooltip / expandable Details
  });

  it('carries no per-task provider columns; the diagnostics sit in one collapsed block', () => {
    const account = app.slice(app.indexOf('async function renderAiRouting'), app.indexOf("route('#/super-admin-settings'"));
    expect(account).not.toMatch(/<th>(Models|Key|Billing|Priority|Last test|Vision|Audio|Pictures|Voice notes)<\/th>/);
    expect(account).toContain('routingDiagnosticsHtml(data)');
    expect(app).toMatch(/<details class="ai-diagnostics"/);
  });

  it('saves the order through the server (PUT order), so the routing really follows it', () => {
    expect(app).toContain("'/api/dashboard/ai-routing/order'");
    expect(app).toContain("'/api/dashboard/ai-routing/entries/default/test'");
  });

  it('the long OpenRouter model form is kept (nothing was removed) but collapsed under an Advanced heading', () => {
    expect(app).toMatch(/<details class="panel setup-card ai-card"[^>]*>\s*<summary><h3 style="display:inline">Advanced — OpenRouter model overrides for this business<\/h3><\/summary>/);
    expect(app).toContain('id="ai-form"');
  });
});

describe('every API call of the new pages is one the server protects', () => {
  it('uses only super-admin or ai-routing paths, and removal always passes the explicit confirmation', () => {
    const block = app.slice(app.indexOf("route('#/super-admin-settings'"), app.indexOf('// System'));
    const paths = [...block.matchAll(/'(\/api\/dashboard\/[^'`]*)'|`(\/api\/dashboard\/[^`]*)`/g)].map((m) => (m[1] ?? m[2])!);
    expect(paths.length).toBeGreaterThan(4);
    for (const p of paths) expect(p).toMatch(/^\/api\/dashboard\/super-admin\/ai/);
    expect(block).toContain('?confirm=yes');
  });
});
