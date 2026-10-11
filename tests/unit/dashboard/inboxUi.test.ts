import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { specFor } from '../../../src/dashboard/authorize';

/**
 * The inbox page is a static script (no bundler, no jsdom in this project), so these checks read the files: accessibility and
 * right-to-left hooks, the refresh rules, the states the brief asks for (loading, empty, error, retry, disconnected), what the page
 * may never do (notifications, offline channels) and that every API call it makes is covered by a deliberate permission rule.
 */
const DIR = path.join(__dirname, '..', '..', '..', 'dashboard');
const page = fs.readFileSync(path.join(DIR, 'pages-inbox.js'), 'utf-8');
const core = fs.readFileSync(path.join(DIR, 'inbox-core.js'), 'utf-8');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf-8');
const css = fs.readFileSync(path.join(DIR, 'ui.css'), 'utf-8');
const app = fs.readFileSync(path.join(DIR, 'app.js'), 'utf-8');

describe('inbox page — loading, wiring and permissions', () => {
  it('compiles, is loaded as an external script (the CSP forbids inline ones) after the logic it needs, and replaces the old conversation routes', () => {
    expect(() => new vm.Script(page, { filename: 'pages-inbox.js' })).not.toThrow();
    expect(() => new vm.Script(core, { filename: 'inbox-core.js' })).not.toThrow();
    expect(html.indexOf('/dashboard/inbox-core.js')).toBeGreaterThan(-1);
    expect(html.indexOf('/dashboard/inbox-core.js')).toBeLessThan(html.indexOf('/dashboard/pages-inbox.js'));
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    // exactly one owner of #/conversations: the old list/detail pages are gone from app.js
    expect(app).not.toMatch(/route\('#\/conversations'/);
    expect(app).not.toMatch(/route\(\/\^#\\\/conversations/);
    expect(page).toMatch(/route\('#\/conversations'/);
    expect(page).toMatch(/route\(\/\^#\\\/conversations\\\/customer\\\/\(\?<id>\\d\+\)\$\//);
  });

  it('old links keep working: a conversation id and a handoff id both open the customer\'s conversation', () => {
    expect(page).toMatch(/route\(\/\^#\\\/conversations\\\/\(\?<id>\\d\+\)\$\//);
    expect(page).toMatch(/route\(\/\^#\\\/handoffs\\\/\(\?<id>\\d\+\)\$\//);
    expect(page).toContain('location.replace(`#/conversations/customer/');
  });

  it('every API call the page makes has an explicit permission rule (nothing falls to Super-Admin-only by accident, nothing is wider than intended)', () => {
    const calls = new Set<string>();
    for (const m of page.matchAll(/['"`]\/api\/dashboard(\/[A-Za-z0-9_\-/${}.]*)/g)) calls.add(m[1]!.replace(/\$\{[^}]*\}/g, '1').replace(/\/+$/, '').replace(/\/\d+(?=\/|$)/g, '/1'));
    expect(calls.size).toBeGreaterThanOrEqual(8);
    for (const call of calls) expect(specFor('GET', call).t, call).not.toBe('super');
    expect(specFor('GET', '/inbox')).toEqual({ t: 'feature', feature: 'conversations', level: undefined });
    expect(specFor('GET', '/inbox/pulse')).toEqual({ t: 'feature', feature: 'conversations', level: undefined });
    expect(specFor('GET', '/inbox/customers/5')).toEqual({ t: 'feature', feature: 'conversations', level: undefined });
    // the actions are the existing handoff endpoints — the inbox adds no new way to change anything
    expect(page).not.toMatch(/method: '(PUT|PATCH|DELETE)'/);
    for (const action of ['accept', 'resolve', 'return-to-ai', 'reply']) expect(page, action).toMatch(new RegExp(`/api/dashboard/handoffs/\\$\\{[^}]+\\}/${action}`));
    expect(page).toContain('/take-over');
    // filters and position belong to one account: switching business starts clean
    expect(page).toContain('if (inbox.account !== getSelectedAccountId())');
  });
});

describe('inbox page — accessibility, keyboard and right-to-left', () => {
  it('every user-visible string from data is escaped before it reaches innerHTML', () => {
    // every ${...} placed in a template either goes through esc()/badge()/an id, or is a number/handler the server controls
    const unescaped = [...page.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!.trim()).filter((expr) => /\.(name|preview|content|message|label|text|waId|waIdMasked|phase)\b/.test(expr) && !/^(esc|badge|errorView|inboxShortTime|formatDate)\(/.test(expr) && !/esc\(/.test(expr));
    // the only bare one is an error message handed to banner(), which escapes it
    expect(unescaped.filter((expr) => expr !== 'error.message')).toEqual([]);
    const bare = page.split('\n').filter((l) => l.includes('${error.message}'));
    expect(bare.length).toBeGreaterThan(0);
    for (const line of bare) expect(line).toContain('banner(');
  });

  it('marks text direction per message, name and preview (dir="auto"), so Arabic and English each align correctly without changing the page layout', () => {
    expect(page.match(/dir="auto"/g)!.length).toBeGreaterThanOrEqual(5);
    for (const hook of ['class="inbox-name" dir="auto"', '<bdi dir="auto">', 'class="bubble-text" dir="auto"', '<textarea id="ib-text"', 'dir="auto"']) expect(page).toContain(hook);
    // layout uses logical properties so a right-to-left page mirrors correctly
    expect(css).toMatch(/\.inbox-item\{[^}]*border-inline-start/);
    expect(css).toMatch(/\.ib-chip-n\{[^}]*margin-inline-start/);
  });

  it('has labelled controls, status regions, a keyboard-usable list and Ctrl+Enter to send', () => {
    for (const hook of ['aria-label="Conversations"', 'aria-label="Filter conversations"', 'aria-pressed=', 'role="status" aria-live="polite"', 'role="alert"', 'for="ib-q"', 'for="ib-text"', 'aria-label="Handled by"', 'aria-current', 'aria-label="Previous page"', 'aria-label="Next page"', 'tabindex="0"']) expect(page, hook).toContain(hook);
    expect(page).toContain("event.key !== 'ArrowDown' && event.key !== 'ArrowUp'");
    expect(page).toContain("event.key === 'Enter' && (event.ctrlKey || event.metaKey)");
    expect(page).toMatch(/<a class="inbox-item/); // rows are real links: focusable, Enter opens, middle-click works
    expect(css).toMatch(/\.inbox-item:focus-visible/);
  });

  it('keeps the current navigation and design: same sidebar entry, same tokens, the layout collapses on small screens', () => {
    expect(html).toContain('data-route="#/conversations"');
    expect(css).toMatch(/@media \(max-width:900px\)\{\s*\.inbox\{grid-template-columns:1fr\}/);
    expect(css).toContain('.inbox.has-thread .inbox-list{display:none}');
    expect(css).not.toMatch(/\.inbox[^{]*\{[^}]*#[0-9a-fA-F]{3,6}/); // colours come from the existing design tokens
  });
});

describe('inbox page — states, refresh and recovery', () => {
  it('has a loading, an empty, a filtered-empty, an error and a disconnected state, each with the way out', () => {
    for (const text of ['loadingView()', 'No conversations yet. They appear here', 'No conversation matches. Clear the search or the filter.', 'Clear filters', 'Could not load conversations', 'Could not open this conversation', 'errorView(', 'Retry now', 'Connection problem — retrying in', 'Reconnected — the conversations are up to date.', "This business's WhatsApp number is not connected", 'Select a conversation to read it and reply.']) expect(page, text).toContain(text);
  });

  it('refreshes with ONE small request, reloads only on change, pauses when the tab is hidden, and backs off after failures', () => {
    expect(page).toContain('/api/dashboard/inbox/pulse');
    expect(page).toContain('pulse.revision !== revision');
    expect(page).toContain('document.hidden');
    expect(page).toContain("document.addEventListener('visibilitychange', onVisibility)");
    expect(page).toContain("document.removeEventListener('visibilitychange', onVisibility)");
    expect(page).toContain('InboxCore.pollDelay');
    expect(page).toContain('clearTimeout(timer)');
    expect(page).not.toMatch(/setInterval/); // a timer that re-arms itself after each answer can never pile up requests
    // the open conversation asks only for what is new, and merges without duplicates
    expect(page).toContain('?after=${previous.latestId}');
    expect(page).toContain('InboxCore.mergeMessages');
    // typing is never interrupted by a refresh of the list
    expect(page).toContain('if (selectedId && !sending)');
  });

  it('a double click or retry of a reply cannot send twice, stale-tab actions show the real state, and the draft survives an error', () => {
    expect(page).toContain('if (sending) return;');
    expect(page).toContain('if (!pendingId) pendingId = newClientMessageId();');
    expect(page).toContain('pendingId = null;');
    expect(page).toContain('await Promise.allSettled([loadThread(true), loadList()])');
    expect(page).toContain('the draft stays in the box');
    expect(page).toContain('event.currentTarget.disabled = true');
  });

  it('remembers filters, search and list position between visits (session only), and loads older messages on request', () => {
    expect(page).toContain("sessionStorage.setItem(INBOX_STATE_KEY");
    expect(page).toContain('inbox.listScroll');
    expect(page).toContain('Load earlier messages');
  });

  it('never claims what it cannot know: no unread counter, no delivered/read receipts', () => {
    expect(page).not.toMatch(/Unread|unread|Delivered|delivered|Read receipt|Seen/);
    expect(page).toContain('WhatsApp delivery receipts are not tracked.');
    expect(page).toContain("'Awaiting reply'");
  });
});

describe('inbox page — notifications stay out of scope', () => {
  it('uses no browser notification, push, service worker, sound or external channel', () => {
    for (const source of [page, core]) {
      expect(source).not.toMatch(/\bNotification\b|requestPermission|serviceWorker|PushManager|pushManager|navigator\.vibrate|new Audio|AudioContext|mailto:|tel:|sms:|webhook/i);
    }
    expect(page).not.toMatch(/fetch\(\s*['"`]https?:/);
  });
});
