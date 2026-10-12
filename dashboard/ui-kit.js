// UI kit — pure helpers shared by the shell and the pages (no DOM access at load time, so they are unit-tested in Node).
// Loaded before shell.js. Everything is exposed as window.UiKit.
(function (root) {
  'use strict';

  /**
   * The WAI-ARIA "menu button" keyboard contract: which item gets focus after `key`, given the focused index (-1 = the button itself).
   * Returns the next index, or null when the key is not a navigation key (Escape / Tab / Enter are handled by the caller).
   */
  function menuNavIndex(key, index, count) {
    if (!count || count < 1) return null;
    if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count;
    if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return null;
  }

  /** Type-ahead: the next item (after `from`, wrapping) whose label starts with the typed character. */
  function menuTypeAhead(char, from, labels) {
    const c = String(char || '').toLowerCase();
    if (c.length !== 1 || !labels.length) return -1;
    for (let step = 1; step <= labels.length; step += 1) {
      const i = (from + step + labels.length) % labels.length;
      if (String(labels[i] || '').trim().toLowerCase().startsWith(c)) return i;
    }
    return -1;
  }

  const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ًͯ-ٟ]/g, '').trim();

  /**
   * Ranks command-palette items for `query`. Items: { id, label, group?, keywords?: string[] }. An empty query keeps the given order.
   * Scores: label starts with the query 4, a word starts with it 3, label contains it 2, a keyword contains it 1. Non-matches are dropped.
   */
  function rankCommands(items, query) {
    const q = fold(query);
    if (!q) return items.slice();
    const scored = [];
    items.forEach((item, order) => {
      const label = fold(item.label);
      let score = 0;
      if (label.startsWith(q)) score = 4;
      else if (label.split(/[\s\-/&·]+/).some((w) => w.startsWith(q))) score = 3;
      else if (label.includes(q)) score = 2;
      else if ((item.keywords || []).some((k) => fold(k).includes(q))) score = 1;
      if (score) scored.push({ item, score, order });
    });
    return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.item);
  }

  function parseWhen(value) {
    if (!value) return NaN;
    const iso = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
    return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z').getTime();
  }

  /**
   * Message grouping for a transcript: consecutive messages from the same sender kind within `gapMs` form one group. Returns one flag object per message:
   * { first, last } — the sender label and avatar show on `first`, the timestamp and the tail on `last`.
   */
  function groupFlags(messages, gapMs) {
    const gap = gapMs || 5 * 60 * 1000;
    const same = (a, b) => a && b && a.kind === b.kind && Math.abs(parseWhen(b.at) - parseWhen(a.at)) <= gap;
    return messages.map((m, i) => ({ first: !same(messages[i - 1], m), last: !same(m, messages[i + 1]) }));
  }

  /** Widths (percent, summing to 100) for a segmented bar; zero segments get 0 and an all-zero bar returns all zeros. */
  function segmentWidths(values) {
    const total = values.reduce((a, b) => a + Math.max(0, Number(b) || 0), 0);
    if (!total) return values.map(() => 0);
    const raw = values.map((v) => (Math.max(0, Number(v) || 0) / total) * 100);
    const rounded = raw.map((x) => Math.round(x * 10) / 10);
    const drift = Math.round((100 - rounded.reduce((a, b) => a + b, 0)) * 10) / 10;
    if (drift) rounded[raw.indexOf(Math.max.apply(null, raw))] += drift; // the largest segment absorbs the rounding so the bar is exactly full
    return rounded.map((x) => Math.round(x * 10) / 10);
  }

  /** Percent of `max` for a bar (0..100); a non-zero value never draws narrower than `min` so it stays visible. */
  function barPercent(value, max, min) {
    const v = Math.max(0, Number(value) || 0);
    const m = Math.max(0, Number(max) || 0);
    if (!v || !m) return 0;
    return Math.min(100, Math.max(min === undefined ? 4 : min, (v / m) * 100));
  }

  /** "3 things need attention" / "Everything is running" for the hero: counts the items whose tone is not green. */
  function attentionSummary(items) {
    const need = items.filter((i) => i.tone !== 'green').length;
    return { need, headline: need === 0 ? 'Everything is running' : need === 1 ? '1 thing needs attention' : need + ' things need attention' };
  }

  root.UiKit = { menuNavIndex, menuTypeAhead, rankCommands, groupFlags, segmentWidths, barPercent, attentionSummary, fold };
})(typeof window !== 'undefined' ? window : globalThis);
