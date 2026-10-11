import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The header's account identity (logo, name, masked number, connection status) and its controls (language, theme, user) must stay whole on a phone.
 * The real layout was measured in a browser at 320 / 360 / 375 / 390 / 430 px, tablet and desktop, English and Arabic, light and dark, for a
 * single-account and a multi-account user (nothing clipped, nothing overlapping, no horizontal page scroll). These checks keep the CSS rules that
 * achieved it from being undone by accident.
 */
const DIR = path.join(__dirname, '..', '..', '..', 'dashboard');
const css = (name: string) => fs.readFileSync(path.join(DIR, name), 'utf-8');
const mediaBlock = (source: string, query: string): string => {
  const start = source.indexOf(`@media (${query})`);
  expect(start, `@media (${query}) exists`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unterminated media block');
};

describe('responsive header', () => {
  const company = css('company.css');
  const phone = mediaBlock(company, 'max-width:640px');

  it('never hides or cuts the account name, the masked number or the connection status on a narrow screen', () => {
    expect(phone).not.toMatch(/\.acct-num[^{}]*\{[^}]*display:none/);
    expect(phone).not.toMatch(/\.acct-st[^{}]*\{[^}]*display:none/);
    expect(phone).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(phone).not.toMatch(/white-space:\s*nowrap/);
    expect(phone).toMatch(/\.acct-name\{[^}]*white-space:normal/); // a long business name wraps onto a second line
    expect(phone).toMatch(/\.acct-num[^{}]*\{[^}]*flex:none/);
  });

  it('on a phone the header is: menu, logo and identity on the first row, then the title, then the controls — all visible', () => {
    const ui = css('ui.css');
    const small = mediaBlock(ui, 'max-width:480px');
    expect(small).toMatch(/\.topbar \.page-heading\{display:contents\}/);
    expect(small).toMatch(/\.topbar \.crumb\{[^}]*flex:1 1 0;min-width:0/);
    expect(small).toMatch(/\.topbar h1\{flex:0 0 100%/);
    expect(small).toMatch(/\.topbar-controls\{order:3/);
    // the controls are never hidden by the responsive rules
    for (const sel of ['.lang-switch', '#theme-toggle', '.theme-toggle', '#profile-btn', '.profile', '.topbar-controls', '.topbar-mark']) {
      expect(small, sel).not.toMatch(new RegExp(`${sel.replace('.', '\\.')}\\{[^}]*display:none`));
    }
  });

  it('a status chip wider than the screen wraps instead of being cut off', () => {
    const theme = css('theme.css');
    const small = mediaBlock(theme, 'max-width:480px');
    expect(small).toMatch(/\.status-strip>\*\{[^}]*max-width:100%[^}]*white-space:normal/);
  });
});
