import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// dashboard/ui-kit.js holds the pure logic behind the account menu, the command palette, message grouping and the small charts.
const source = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'dashboard', 'ui-kit.js'), 'utf8');
const sandbox: { globalThis?: unknown; UiKit?: any } = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox);
const kit = sandbox.UiKit!;

describe('menu button keyboard contract (WAI-ARIA APG)', () => {
  it('ArrowDown / ArrowUp move and wrap, Home / End jump, the button itself is -1', () => {
    expect(kit.menuNavIndex('ArrowDown', -1, 4)).toBe(0);
    expect(kit.menuNavIndex('ArrowDown', 3, 4)).toBe(0);
    expect(kit.menuNavIndex('ArrowUp', -1, 4)).toBe(3);
    expect(kit.menuNavIndex('ArrowUp', 0, 4)).toBe(3);
    expect(kit.menuNavIndex('Home', 2, 4)).toBe(0);
    expect(kit.menuNavIndex('End', 0, 4)).toBe(3);
  });
  it('other keys (Escape, Tab, Enter) are not navigation, and an empty menu navigates nowhere', () => {
    for (const k of ['Escape', 'Tab', 'Enter', ' ', 'a']) expect(kit.menuNavIndex(k, 1, 4)).toBeNull();
    expect(kit.menuNavIndex('ArrowDown', -1, 0)).toBeNull();
  });
  it('type-ahead jumps to the next item starting with the typed letter, wrapping', () => {
    const labels = ['Users & permissions', 'WhatsApp accounts', 'Settings', 'Log out'];
    expect(kit.menuTypeAhead('s', -1, labels)).toBe(2);
    expect(kit.menuTypeAhead('l', 2, labels)).toBe(3);
    expect(kit.menuTypeAhead('u', 3, labels)).toBe(0);
    expect(kit.menuTypeAhead('z', 0, labels)).toBe(-1);
  });
});

describe('command palette ranking', () => {
  const items = [
    { id: 'dash', label: 'Dashboard', group: 'Navigate' },
    { id: 'conv', label: 'Conversations', group: 'Navigate', keywords: ['inbox', 'chat'] },
    { id: 'cust', label: 'Customers CRM', group: 'Navigate' },
    { id: 'theme', label: 'Switch to dark appearance', group: 'Actions', keywords: ['theme', 'night'] },
    { id: 'acct', label: 'WhatsApp Connection', group: 'Navigate' },
  ];
  it('keeps the given order for an empty query', () => expect(kit.rankCommands(items, '').map((i: any) => i.id)).toEqual(items.map((i) => i.id)));
  it('prefers label prefixes, then word prefixes, then substrings, then keywords', () => {
    expect(kit.rankCommands(items, 'c').map((i: any) => i.id).slice(0, 3)).toEqual(['conv', 'cust', 'acct']);
    expect(kit.rankCommands(items, 'crm').map((i: any) => i.id)).toEqual(['cust']);
    expect(kit.rankCommands(items, 'inbox').map((i: any) => i.id)).toEqual(['conv']);
    expect(kit.rankCommands(items, 'night').map((i: any) => i.id)).toEqual(['theme']);
    expect(kit.rankCommands(items, 'zzz')).toEqual([]);
  });
  it('ignores case and accents', () => expect(kit.rankCommands([{ id: 'x', label: 'Café menu' }], 'CAFE').map((i: any) => i.id)).toEqual(['x']));
});

describe('message grouping', () => {
  const at = (min: number) => `2026-10-12 10:${String(min).padStart(2, '0')}:00`;
  it('collapses consecutive messages of one sender within the gap and splits on a new sender or a long pause', () => {
    const m = [{ kind: 'customer', at: at(0) }, { kind: 'customer', at: at(1) }, { kind: 'ai', at: at(2) }, { kind: 'ai', at: at(30) }, { kind: 'staff', at: at(31) }];
    expect(kit.groupFlags(m)).toEqual([
      { first: true, last: false }, { first: false, last: true },
      { first: true, last: true }, { first: true, last: true }, { first: true, last: true },
    ]);
  });
  it('handles empty and single-message transcripts', () => {
    expect(kit.groupFlags([])).toEqual([]);
    expect(kit.groupFlags([{ kind: 'customer', at: at(0) }])).toEqual([{ first: true, last: true }]);
  });
});

describe('chart maths', () => {
  it('segment widths always fill the bar exactly and zero segments stay empty', () => {
    for (const values of [[1, 1, 1], [5, 0, 2], [3, 3, 3, 1], [0.1, 0.2, 0.7]]) {
      const w: number[] = kit.segmentWidths(values);
      expect(Math.round(w.reduce((a, b) => a + b, 0) * 10) / 10).toBe(100);
      values.forEach((v, i) => { if (!v) expect(w[i]).toBe(0); });
    }
    expect(kit.segmentWidths([0, 0])).toEqual([0, 0]);
  });
  it('a bar is proportional to the maximum, never negative or above 100, and a non-zero value stays visible', () => {
    expect(kit.barPercent(5, 10)).toBe(50);
    expect(kit.barPercent(1, 1000)).toBe(4);
    expect(kit.barPercent(0, 10)).toBe(0);
    expect(kit.barPercent(20, 10)).toBe(100);
    expect(kit.barPercent(-3, 10)).toBe(0);
    expect(kit.barPercent(5, 0)).toBe(0);
  });
  it('the attention headline counts everything that is not green', () => {
    expect(kit.attentionSummary([{ tone: 'green' }, { tone: 'green' }]).headline).toBe('Everything is running');
    expect(kit.attentionSummary([{ tone: 'red' }, { tone: 'green' }]).headline).toBe('1 thing needs attention');
    expect(kit.attentionSummary([{ tone: 'red' }, { tone: 'blue' }, { tone: 'green' }]).need).toBe(2);
  });
});
