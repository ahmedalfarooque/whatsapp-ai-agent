import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { specFor } from '../../../src/dashboard/authorize';

/**
 * The dashboard is a static SPA (no bundler), so these checks read the files directly: the redesign must keep the original
 * sidebar, keep every script loadable under the server's Content-Security-Policy, and leave no page or API call without an
 * access rule (a hidden menu item and a refused API call must always agree).
 */
const DIR = path.join(__dirname, '..', '..', '..', 'dashboard');
const read = (name: string) => fs.readFileSync(path.join(DIR, name), 'utf-8');
const SCRIPTS = ['theme-init.js', 'shell.js', 'app.js', 'pages-automation.js', 'pages-accounts.js', 'pages-setup.js', 'pages-users.js', 'pages-home.js'];

/** The sidebar exactly as it was before the redesign: [group, [route, label]...]. */
const ORIGINAL_SIDEBAR: Array<[string, Array<[string, string]>]> = [
  ['WHATSAPP ACCOUNTS', [['#/accounts', 'Manage Accounts']]],
  ['OVERVIEW', [['#/', 'Dashboard'], ['#/whatsapp', 'WhatsApp Connection'], ['#/conversations', 'Conversations'], ['#/customers', 'Customers CRM']]],
  ['AUTOMATION & RULES', [['#/flow', 'Auto-Reply Flow Map'], ['#/automation', 'Auto-Reply Control'], ['#/replies', 'Manual Reply Editor'], ['#/support', 'Human Support Queue'], ['#/bookings', 'Appointments']]],
  ['CATALOG & BUSINESS', [['#/services', 'Services Catalogue'], ['#/products', 'Products Book'], ['#/prices', 'Verified Price Book'], ['#/offers', 'Offers & Discounts'], ['#/business', 'Business Profile'], ['#/location', 'Location & Hours']]],
  ['KNOWLEDGE & AI', [['#/knowledge', 'Knowledge Sources'], ['#/ai', 'AI Configuration'], ['#/integrations', 'Providers & Legacy API']]],
  ['INSIGHTS & SYSTEM', [['#/analytics', 'Analytics & Reports'], ['#/security', 'Security & Tenant'], ['#/system', 'System'], ['#/settings', 'Settings'], ['#/project-sync', 'Project Sync']]],
];

function parseSidebar(html: string): Array<[string, Array<[string, string]>]> {
  const nav = /<nav id="nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1]!;
  const out: Array<[string, Array<[string, string]>]> = [];
  for (const m of nav.matchAll(/<div class="nav-group">([^<]+)<\/div>|<a data-route="([^"]+)"[^>]*>[^<]*<span>([^<]+)<\/span>/g)) {
    if (m[1]) out.push([m[1].replace(/&amp;/g, '&'), []]);
    else out[out.length - 1]![1].push([m[2]!, m[3]!.replace(/&amp;/g, '&')]);
  }
  return out;
}

describe('dashboard shell', () => {
  it('keeps the original sidebar: same groups, same labels, same order and destinations (only Users & Permissions is added)', () => {
    const current = parseSidebar(read('index.html'));
    const withoutUsers = current.map(([group, items]) => [group, items.filter(([route]) => route !== '#/users')] as [string, Array<[string, string]>]);
    expect(withoutUsers).toEqual(ORIGINAL_SIDEBAR);
    const users = current.flatMap(([, items]) => items).filter(([route]) => route === '#/users');
    expect(users).toEqual([['#/users', 'Users & Permissions']]);
    // the account switcher and the "Add WhatsApp account" link are still there
    const html = read('index.html');
    expect(html).toContain('id="account-list"');
    expect(html).toContain('data-add-account');
  });

  it('every script compiles, and the page loads no inline script (the server\'s CSP only allows scripts from its own origin)', () => {
    for (const file of SCRIPTS) expect(() => new vm.Script(read(file), { filename: file }), file).not.toThrow();
    const html = read('index.html');
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
    expect(inline).toHaveLength(0);
    for (const file of SCRIPTS) expect(html, file).toContain(`/dashboard/${file}`);
  });

  it('every sidebar page has an access rule and a registered route', () => {
    const access = read('shell.js');
    const routes = SCRIPTS.map(read).join('\n');
    const ruleKeys = new Set([...access.matchAll(/'(#\/[\w-]*)':\s/g)].map((m) => m[1]));
    for (const [, items] of parseSidebar(read('index.html'))) {
      for (const [route] of items) {
        expect(ruleKeys.has(route), `${route} has no ROUTE_ACCESS entry`).toBe(true);
        expect(routes.includes(`route('${route}'`), `${route} has no registered page`).toBe(true);
      }
    }
  });

  it('every dashboard API call the pages make is covered by a deliberate access rule (nothing falls through to Super-Admin-only by accident)', () => {
    const calls = new Set<string>();
    for (const file of SCRIPTS) {
      for (const m of read(file).matchAll(/['"`]\/api\/dashboard(\/[A-Za-z0-9_\-/${}.]*)/g)) {
        let normalized = m[1]!.replace(/\$\{[^}]*\}/g, '1').replace(/\/+$/, '').replace(/\/\d+(?=\/|$)/g, '/1');
        if (normalized === '/accounts/1/1') normalized = '/accounts/1/enable'; // `/accounts/${id}/${action}` (enable | disable)
        if (normalized && !normalized.startsWith('/auth/')) calls.add(normalized);
      }
    }
    expect(calls.size).toBeGreaterThan(30);
    const intentionallySuperOnly = new Set<string>();
    for (const call of calls) {
      const spec = specFor('GET', call);
      if (spec.t === 'super') intentionallySuperOnly.add(call);
    }
    expect([...intentionallySuperOnly], 'API paths used by the pages that have no access rule').toEqual([]);
  });

  it('the stylesheet provides both appearances and the responsive breakpoints', () => {
    const css = read('ui.css');
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain(':root[data-theme="dark"]');
    for (const bp of ['1240px', '900px', '700px', '480px']) expect(css).toContain(`(max-width:${bp})`);
    expect(css).toContain('prefers-reduced-motion');
  });
});
