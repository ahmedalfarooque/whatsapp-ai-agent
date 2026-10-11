import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/** The inbox's browser-side logic (dashboard/inbox-core.js), loaded exactly as the browser loads it, then exercised on its own. */
const file = path.join(__dirname, '..', '..', '..', 'dashboard', 'inbox-core.js');
const sandbox: { module?: { exports: unknown }; self?: unknown } = {};
vm.runInNewContext(fs.readFileSync(file, 'utf-8'), { module: undefined, self: sandbox, URLSearchParams }); // as in a browser
const Core = (sandbox as unknown as { InboxCore: Record<string, (...args: never[]) => unknown> & { FILTERS: { key: string; label: string }[]; HANDLING: Record<string, { label: string; tone: string }> } }).InboxCore;
const call = <T>(name: string, ...args: unknown[]): T => (Core[name] as unknown as (...a: unknown[]) => T)(...args);

describe('inbox core — handling and message labels', () => {
  it('names every handling state in plain words and degrades safely for an unknown one', () => {
    expect(call('handlingInfo', 'AI_ACTIVE')).toEqual({ label: 'AI active', tone: 'green' });
    expect(call('handlingInfo', 'HUMAN_REQUESTED')).toEqual({ label: 'Waiting for staff', tone: 'amber' });
    expect(call('handlingInfo', 'HUMAN_ACTIVE', 'Sam Staff')).toEqual({ label: 'With Sam Staff', tone: 'blue' });
    expect(call('handlingInfo', 'HUMAN_ACTIVE')).toEqual({ label: 'With staff', tone: 'blue' });
    expect(call<{ label: string }>('handlingInfo', 'RESOLVED').label).toMatch(/Resolved/);
    expect(call('handlingInfo', 'SOMETHING_NEW')).toEqual({ label: 'SOMETHING_NEW', tone: '' });
    expect(call<{ label: string }>('handlingInfo', undefined).label).toBe('Unknown');
  });

  it('tells customer, AI, automatic and staff messages apart', () => {
    expect(call('messageLabel', { kind: 'customer' })).toBe('Customer');
    expect(call('messageLabel', { kind: 'ai' })).toBe('AI assistant');
    expect(call('messageLabel', { kind: 'auto' })).toBe('Automatic reply');
    expect(call('messageLabel', { kind: 'staff', staffName: 'Sam Staff' })).toBe('Staff — Sam Staff');
    expect(call('messageLabel', { kind: 'staff', staffName: null })).toBe('Staff');
  });

  it('only ever says "Sent" for a staff reply the connection accepted — never delivered or read', () => {
    expect(call('deliveryLabel', { kind: 'staff', status: 'sent' })).toBe('Sent');
    for (const m of [{ kind: 'ai', status: null }, { kind: 'auto', status: 'sent' }, { kind: 'customer', status: 'sent' }, { kind: 'staff', status: null }, { kind: 'staff', status: 'delivered' }, { kind: 'staff', status: 'read' }]) {
      expect(call('deliveryLabel', m), JSON.stringify(m)).toBe('');
    }
    expect(fs.readFileSync(file, 'utf-8')).not.toMatch(/Delivered|'Read'|Seen/);
  });

  it('keeps supported media readable: the kind of file and its caption separately, plain text untouched', () => {
    expect(call('splitMedia', { type: 'image', content: '[image] my contract' })).toEqual({ media: 'Image', text: 'my contract' });
    expect(call('splitMedia', { type: 'document', content: '[document]' })).toEqual({ media: 'Document', text: '' });
    expect(call('splitMedia', { type: 'audio', content: '[audio]' })).toEqual({ media: 'Voice note', text: '' });
    expect(call('splitMedia', { type: 'weird', content: '[weird] x' })).toEqual({ media: 'Attachment', text: 'x' });
    expect(call('splitMedia', { type: 'text', content: 'hello [image] there' })).toEqual({ media: null, text: 'hello [image] there' });
    expect(call('splitMedia', { type: 'interactive', content: '[menu_main]' })).toEqual({ media: null, text: '[menu_main]' });
    expect(call('splitMedia', { content: 'no type' })).toEqual({ media: null, text: 'no type' });
  });
});

describe('inbox core — merging live updates', () => {
  it('merges new messages without duplicates and always in order, whatever order they arrive in', () => {
    const a = [{ id: 1, content: 'one' }, { id: 2, content: 'two' }];
    const merged = call<{ id: number }[]>('mergeMessages', a, [{ id: 4, content: 'four' }, { id: 2, content: 'two (again)' }, { id: 3, content: 'three' }]);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(call<{ content: string }[]>('mergeMessages', a, [{ id: 2, content: 'two (again)' }])[1]!.content).toBe('two (again)');
    expect(call('mergeMessages', a, [])).toEqual(a);
    expect(call('mergeMessages', undefined, undefined)).toEqual([]);
    // loading earlier history prepends in order
    expect(call<{ id: number }[]>('mergeMessages', [{ id: 10 }, { id: 11 }], [{ id: 8 }, { id: 9 }]).map((m) => m.id)).toEqual([8, 9, 10, 11]);
  });
});

describe('inbox core — what is sent to the server', () => {
  it('turns the UI state into a server query (search and every filter are server-side)', () => {
    expect(call('buildInboxQuery', { q: '  Khalid ', handling: 'waiting', assignee: 'me', sort: 'waiting_first', limit: 25, offset: 50 })).toBe('q=Khalid&handling=waiting&assignee=me&sort=waiting_first&limit=25&offset=50');
    expect(call('buildInboxQuery', { q: '', handling: 'all', assignee: '', sort: 'recent', limit: 25, offset: 0 })).toBe('limit=25&offset=0');
    expect(call('buildInboxQuery', { q: 'محمد', handling: 'all' })).toBe(`q=${encodeURIComponent('محمد')}&limit=25&offset=0`);
    expect(call('buildInboxQuery', { q: 'a&b=c' })).toBe('q=a%26b%3Dc&limit=25&offset=0');
  });

  it('offers the filters the brief asks for', () => {
    expect(Core.FILTERS.map((f) => f.key)).toEqual(['all', 'waiting', 'in_progress', 'ai', 'resolved', 'needs_reply']);
  });
});

describe('inbox core — refresh pacing and recovery', () => {
  it('does not poll at all while the tab is hidden', () => {
    expect(call('pollDelay', { hidden: true, failures: 0 })).toBeNull();
    expect(call('pollDelay', { hidden: true, failures: 5 })).toBeNull();
  });

  it('polls at a steady pace, backs off exponentially after failures (never faster, never beyond a minute) and recovers at once', () => {
    expect(call('pollDelay', { hidden: false, failures: 0 })).toBe(6000);
    const delays = [0, 1, 2, 3, 4, 5, 10, 100].map((failures) => call<number>('pollDelay', { hidden: false, failures }));
    expect(delays).toEqual([6000, 12000, 24000, 48000, 60000, 60000, 60000, 60000]);
    expect(call('pollDelay', { hidden: false, failures: -3 })).toBe(6000);
    expect(call('pollDelay', { hidden: false, failures: 0, base: 3000 })).toBe(3000);
  });
});

describe('inbox core — Arabic, English and right-to-left', () => {
  it('detects the direction of a message from its first letter (so each bubble can align itself)', () => {
    expect(call('isRtl', 'السلام عليكم')).toBe(true);
    expect(call('isRtl', '123 مرحبا')).toBe(true);
    expect(call('isRtl', 'Hello world')).toBe(false);
    expect(call('isRtl', 'שלום')).toBe(true);
    expect(call('isRtl', '12345 :)')).toBe(false);
    expect(call('isRtl', '')).toBe(false);
    expect(call('isRtl', undefined)).toBe(false);
  });

  it('makes sensible initials for Arabic and English names', () => {
    expect(call('initials', 'Khalid Al-Harbi')).toBe('KA');
    expect(call('initials', 'Faisal')).toBe('F');
    expect(call('initials', 'سارة محمد')).toBe('سم');
    expect(call('initials', '')).toBe('?');
    expect(call('initials', null)).toBe('?');
  });
});

describe('inbox core — which actions a staff member is offered (the server decides again)', () => {
  const handoff = (state: string, extra: Record<string, unknown> = {}, you: Record<string, unknown> = {}) => ({ handoff: { state }, assignedTo: extra.assignedTo ?? null, you: { owns: false, canOverride: false, ...you } });
  const actions = (thread: Record<string, unknown>) => call<{ buttons: string[]; composer: boolean; note: string }>('actionsFor', thread);

  it('offers nothing to someone who may not act', () => {
    expect(actions({ you: { canAct: false }, handoff: handoff('HUMAN_REQUESTED') })).toEqual({ buttons: [], composer: false, note: '' });
    expect(actions({ you: {}, handoff: null })).toEqual({ buttons: [], composer: false, note: '' });
  });

  it('AI active: take over. Waiting: accept or decline. Resolved: return to AI', () => {
    expect(actions({ you: { canAct: true }, handoff: null })).toMatchObject({ buttons: ['take_over'], composer: false });
    expect(actions({ you: { canAct: true }, handoff: handoff('HUMAN_REQUESTED') })).toMatchObject({ buttons: ['accept', 'return'], composer: false });
    expect(actions({ you: { canAct: true }, handoff: handoff('RESOLVED') })).toMatchObject({ buttons: ['return'], composer: false });
  });

  it('in progress: the owner (or a manager) may reply, resolve and return; anyone else is told who owns it and offered nothing', () => {
    expect(actions({ you: { canAct: true }, handoff: handoff('HUMAN_ACTIVE', {}, { owns: true }) })).toMatchObject({ buttons: ['resolve', 'return'], composer: true });
    expect(actions({ you: { canAct: true }, handoff: handoff('HUMAN_ACTIVE', {}, { canOverride: true }) })).toMatchObject({ buttons: ['resolve', 'return'], composer: true });
    const other = actions({ you: { canAct: true }, handoff: handoff('HUMAN_ACTIVE', { assignedTo: { name: 'Sam Staff' } }) });
    expect(other).toMatchObject({ buttons: [], composer: false });
    expect(other.note).toContain('Sam Staff');
  });

  it('an unknown state offers nothing instead of guessing', () => {
    expect(actions({ you: { canAct: true }, handoff: handoff('FUTURE_STATE') })).toEqual({ buttons: [], composer: false, note: '' });
  });
});
