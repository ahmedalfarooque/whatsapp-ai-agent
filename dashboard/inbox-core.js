// Unified inbox — the pure logic (no DOM, no network), so it can be tested on its own and shared by pages-inbox.js.
// Loaded as a plain script in the browser (window.InboxCore) and as a CommonJS module by the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InboxCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const HANDLING = {
    AI_ACTIVE: { label: 'AI active', tone: 'green' },
    HUMAN_REQUESTED: { label: 'Waiting for staff', tone: 'amber' },
    HUMAN_ACTIVE: { label: 'With staff', tone: 'blue' },
    RESOLVED: { label: 'Resolved — AI paused', tone: '' },
  };

  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'waiting', label: 'Waiting for staff' },
    { key: 'in_progress', label: 'With staff' },
    { key: 'ai', label: 'AI active' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'needs_reply', label: 'Awaiting reply' },
  ];

  const MEDIA_LABELS = { image: 'Image', document: 'Document', audio: 'Voice note', video: 'Video', sticker: 'Sticker', location: 'Location', contacts: 'Contact', other: 'Attachment' };

  /** Label + tone for the handling state; unknown values degrade to a neutral label instead of breaking the row. */
  function handlingInfo(state, assignedToName) {
    const base = HANDLING[state] || { label: String(state || 'Unknown'), tone: '' };
    return { label: state === 'HUMAN_ACTIVE' && assignedToName ? `With ${assignedToName}` : base.label, tone: base.tone };
  }

  /** Who a message is from: customer, the AI, an automatic (menu/template) reply, or a named staff member. */
  function messageLabel(message) {
    if (message.kind === 'customer') return 'Customer';
    if (message.kind === 'staff') return message.staffName ? `Staff — ${message.staffName}` : 'Staff';
    if (message.kind === 'auto') return 'Automatic reply';
    return 'AI assistant';
  }

  /** What may be said about delivery. Only a staff reply accepted by the WhatsApp connection is "Sent"; no other delivery state is ever claimed. */
  function deliveryLabel(message) {
    return message.kind === 'staff' && message.status === 'sent' ? 'Sent' : '';
  }

  /** Media messages are stored as "[image] caption": show the kind and the caption separately. */
  function splitMedia(message) {
    const type = message.type && message.type !== 'text' && message.type !== 'interactive' ? message.type : null;
    if (!type) return { media: null, text: message.content };
    const text = String(message.content || '').replace(new RegExp(`^\\[${type}\\]\\s*`), '');
    return { media: MEDIA_LABELS[type] || MEDIA_LABELS.other, text };
  }

  /** Merge freshly fetched messages into what is on screen: no duplicates (by id), always in id order. */
  function mergeMessages(existing, incoming) {
    const byId = new Map();
    for (const m of existing || []) byId.set(m.id, m);
    for (const m of incoming || []) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }

  /** The query string of a list request from the UI state — everything that narrows the list is sent to the server. */
  function buildInboxQuery(state) {
    const params = new URLSearchParams();
    if (state.q && state.q.trim()) params.set('q', state.q.trim());
    if (state.handling && state.handling !== 'all') params.set('handling', state.handling);
    if (state.assignee) params.set('assignee', state.assignee);
    if (state.sort === 'waiting_first') params.set('sort', 'waiting_first');
    params.set('limit', String(state.limit || 25));
    params.set('offset', String(state.offset || 0));
    return params.toString();
  }

  /**
   * How long to wait before the next refresh. Null = do not poll now (the tab is hidden). After failures the delay doubles up to a minute,
   * so a server or network problem is never hammered, and it snaps back as soon as one request succeeds.
   */
  function pollDelay(options) {
    if (options.hidden) return null;
    const base = options.base || 6000;
    const failures = Math.max(0, options.failures || 0);
    return Math.min(60000, base * Math.pow(2, failures));
  }

  /** True when the text starts with a right-to-left letter (Arabic, Hebrew) — used to set the text direction of one message, not of the page. */
  function isRtl(text) {
    const match = /[A-Za-zÀ-ɏ֐-ࣿ]/.exec(String(text || ''));
    return Boolean(match && /[֐-ࣿ]/.test(match[0]));
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  /** What the buttons of a conversation should offer, from the handoff view the server returned. The server enforces every rule again. */
  function actionsFor(thread) {
    const h = thread.handoff;
    const caps = thread.you || {};
    if (!caps.canAct) return { buttons: [], composer: false, note: '' };
    if (!h) return { buttons: ['take_over'], composer: false, note: 'The assistant is answering this customer.' };
    const state = h.handoff.state;
    const mine = Boolean(h.you && h.you.owns);
    const override = Boolean(h.you && h.you.canOverride);
    if (state === 'HUMAN_REQUESTED') return { buttons: ['accept', 'return'], composer: false, note: 'The assistant is not answering this customer. Accept the request to reply.' };
    if (state === 'HUMAN_ACTIVE') {
      if (mine || override) return { buttons: ['resolve', 'return'], composer: true, note: '' };
      return { buttons: [], composer: false, note: `${h.assignedTo ? h.assignedTo.name : 'Another staff member'} is handling this conversation; only they (or a manager) can reply or resolve it.` };
    }
    if (state === 'RESOLVED') return { buttons: ['return'], composer: false, note: 'Resolved. The assistant stays silent for this customer until the conversation is returned to the AI.' };
    return { buttons: [], composer: false, note: '' };
  }

  return { HANDLING, FILTERS, handlingInfo, messageLabel, deliveryLabel, splitMedia, mergeMessages, buildInboxQuery, pollDelay, isRtl, initials, actionsFor };
});
