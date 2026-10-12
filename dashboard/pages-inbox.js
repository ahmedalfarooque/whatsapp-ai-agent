// Unified inbox — one list of every conversation of the selected WhatsApp account (whoever is handling it) and a conversation workspace.
// Everything shown comes from /api/dashboard/inbox*; every action calls the existing handoff API, which enforces permissions and
// ownership on the server. Reuses helpers from app.js / pages-automation.js (api, esc, badge, toast, route, formatDate, emptyView,
// newClientMessageId, maskNumber) and the pure logic in inbox-core.js.

const INBOX_STATE_KEY = 'workspace.inbox';
const INBOX_DEFAULTS = { q: '', handling: 'all', assignee: '', sort: 'recent', offset: 0, limit: 25 };
const inbox = (() => {
  try { return { ...INBOX_DEFAULTS, ...JSON.parse(sessionStorage.getItem(INBOX_STATE_KEY) || '{}'), listScroll: 0 }; } catch { return { ...INBOX_DEFAULTS, listScroll: 0 }; }
})();
function saveInboxState() {
  try { sessionStorage.setItem(INBOX_STATE_KEY, JSON.stringify({ account: inbox.account, q: inbox.q, handling: inbox.handling, assignee: inbox.assignee, sort: inbox.sort, offset: inbox.offset })); } catch { /* storage unavailable: the filters are just not remembered */ }
}
let inboxLastList = null; // the last list response of the current account, painted instantly while the fresh one loads

function inboxShortTime(value) {
  if (!value) return '';
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function inboxRow(item, selectedId) {
  const info = InboxCore.handlingInfo(item.handling.state, item.handling.assignedToName);
  const media = InboxCore.splitMedia({ type: item.last.type, content: item.last.preview });
  const who = ({ customer: '', ai: 'AI:', auto: 'Auto:', staff: 'Staff:' })[item.last.kind] || '';
  const label = item.name || item.waIdMasked;
  const waiting = item.handling.state === 'HUMAN_REQUESTED';
  return `<li role="listitem"><a class="inbox-item ${waiting ? 'waiting' : ''} ${item.customerId === selectedId ? 'active' : ''}" href="#/conversations/customer/${item.customerId}" data-customer="${item.customerId}" ${item.customerId === selectedId ? 'aria-current="true"' : ''}>
    <span class="inbox-avatar" aria-hidden="true">${esc(InboxCore.initials(item.name || ''))}</span>
    <span class="inbox-main">
      <span class="inbox-top"><span class="inbox-name" dir="auto">${esc(label)}</span><time class="inbox-time">${esc(inboxShortTime(item.last.at))}</time></span>
      <span class="inbox-sub"><span class="inbox-num">${esc(item.name ? item.waIdMasked : '')}</span></span>
      <span class="inbox-preview">${who ? `<span class="inbox-who" dir="ltr">${esc(who)}</span> ` : ''}${media.media ? `<em>${esc(media.media)}</em> ` : ''}<bdi dir="auto">${esc(media.text)}</bdi></span>
      <span class="inbox-badges">${badge(info.label, info.tone)}${item.needsReply ? ` ${badge('Awaiting reply', 'amber')}` : ''}${item.handling.requestCount > 1 && waiting ? ` <span class="muted">asked ×${item.handling.requestCount}</span>` : ''}</span>
    </span></a></li>`;
}

function inboxBubble(m) {
  const split = InboxCore.splitMedia(m);
  const delivery = InboxCore.deliveryLabel(m);
  const cls = m.kind === 'customer' ? 'in' : `out ${m.kind}`;
  return `<div class="bubble ${cls}" data-id="${m.id}">
    <div class="bubble-role">${esc(InboxCore.messageLabel(m))}</div>
    ${split.media ? `<div class="bubble-media">${esc(split.media)}</div>` : ''}
    ${split.text ? `<div class="bubble-text" dir="auto">${esc(split.text)}</div>` : ''}
    <div class="bubble-time">${esc(formatDate(m.at))}${delivery ? ` · ${esc(delivery)}` : ''}</div></div>`;
}

// Day separators in the transcript: "Today", "Yesterday", then the date. Purely presentational; the messages and their order are untouched.
function inboxDayOf(value) {
  if (!value) return null;
  const iso = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
function inboxDayLabel(date) {
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(date)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
function inboxThreadHtml(messages) {
  let lastDay = '';
  return messages.map((m) => {
    const day = inboxDayOf(m.at);
    const key = day ? day.toDateString() : '';
    const sep = key && key !== lastDay ? `<div class="day-sep" role="separator">${esc(inboxDayLabel(day))}</div>` : '';
    if (key) lastDay = key;
    return sep + inboxBubble(m);
  }).join('');
}
route('#/conversations', 'Conversations', 'Every conversation of this business — handled by the assistant, waiting for staff, with a staff member or resolved.', (view) => renderInbox(view, null));
route(/^#\/conversations\/customer\/(?<id>\d+)$/, 'Conversations', 'Every conversation of this business — handled by the assistant, waiting for staff, with a staff member or resolved.', (view, params) => renderInbox(view, Number.parseInt(params.id, 10)));

// Links from before the inbox existed keep working: a conversation id or a handoff id opens the customer's conversation here.
route(/^#\/conversations\/(?<id>\d+)$/, 'Conversations', '', async (view, params) => {
  view.innerHTML = loadingView();
  try {
    const data = await api(`/api/dashboard/conversations/${params.id}`);
    location.replace(`#/conversations/customer/${data.conversation.customerId}`);
  } catch (error) {
    view.innerHTML = errorView(error.message, () => renderRoute());
  }
});
route(/^#\/handoffs\/(?<id>\d+)$/, 'Conversations', '', async (view, params) => {
  view.innerHTML = loadingView();
  try {
    const data = await api(`/api/dashboard/handoffs/${params.id}`);
    location.replace(`#/conversations/customer/${data.handoff.customerId}`);
  } catch (error) {
    view.innerHTML = errorView(error.message, () => renderRoute());
  }
});

async function renderInbox(view, selectedId) {
  // Search, filters and position belong to ONE account: switching business starts from a clean list.
  if (inbox.account !== getSelectedAccountId()) {
    Object.assign(inbox, INBOX_DEFAULTS, { account: getSelectedAccountId(), listScroll: 0 });
    inboxLastList = null;
    saveInboxState();
  }
  let disposed = false;
  let timer = null;
  let failures = 0;
  let revision = inboxLastList ? inboxLastList.revision : null;
  let listData = inboxLastList && inboxLastList.accountId === getSelectedAccountId() ? inboxLastList : null;
  let thread = null; // the open conversation: { customer, messages, handoff, you, hasMore, latestId, connection }
  let pendingId = null; // id of a staff reply that is not confirmed yet: pressing Send again retries it, it can never be sent twice
  let sending = false;
  let draft = '';
  let searchTimer = null;

  view.innerHTML = `
    <div class="inbox ${selectedId ? 'has-thread' : ''}">
      <section class="inbox-list" aria-label="Conversations">
        <div class="inbox-tools">
          <label class="sr-only" for="ib-q">Search conversations</label>
          <input type="search" id="ib-q" placeholder="Search name or number…" autocomplete="off" value="${esc(inbox.q)}">
          <div class="inbox-chips" role="group" aria-label="Filter conversations" id="ib-chips"></div>
          <div class="inbox-row2">
            <label class="inbox-check"><input type="checkbox" id="ib-first" ${inbox.sort === 'waiting_first' ? 'checked' : ''}> Waiting for staff first</label>
            <select id="ib-assignee" aria-label="Handled by" hidden></select>
          </div>
        </div>
        <div id="ib-banner" class="inbox-banner" role="status" aria-live="polite" hidden></div>
        <ul id="ib-items" class="inbox-items" aria-label="Conversation list"></ul>
        <div class="inbox-pager" id="ib-pager"></div>
      </section>
      <section class="inbox-thread" id="ib-thread" aria-label="Conversation"></section>
    </div>`;
  const $ = (selector) => view.querySelector(selector);

  disposeView = () => {
    disposed = true;
    clearTimeout(timer);
    clearTimeout(searchTimer);
    inbox.listScroll = ($('#ib-items') || { scrollTop: 0 }).scrollTop;
    document.removeEventListener('visibilitychange', onVisibility);
  };

  function banner(message, retry) {
    const el = $('#ib-banner');
    if (!el) return;
    el.hidden = !message;
    el.innerHTML = message ? `${esc(message)}${retry ? ' <button class="btn small" id="ib-retry">Retry now</button>' : ''}` : '';
    $('#ib-retry')?.addEventListener('click', () => { clearTimeout(timer); tick(true); });
  }

  // ---------------------------------------------------------------- list
  function paintChips() {
    const counts = (listData && listData.counts) || {};
    $('#ib-chips').innerHTML = InboxCore.FILTERS.map((f) => `<button type="button" class="ib-chip ${inbox.handling === f.key ? 'on' : ''} ${f.key === 'waiting' && counts.waiting ? 'alert' : ''}" data-filter="${f.key}" aria-pressed="${inbox.handling === f.key}">${esc(f.label)}${counts[f.key === 'all' ? 'all' : f.key] !== undefined ? ` <span class="ib-chip-n">${counts[f.key === 'all' ? 'all' : f.key]}</span>` : ''}</button>`).join('');
    $('#ib-chips').querySelectorAll('[data-filter]').forEach((btn) => btn.addEventListener('click', () => { inbox.handling = btn.dataset.filter; inbox.offset = 0; saveInboxState(); loadList(); }));
  }

  function paintList() {
    const ul = $('#ib-items');
    if (!ul) return;
    paintChips();
    const assignee = $('#ib-assignee');
    if (listData && listData.you && listData.you.canSeeStaff) {
      assignee.hidden = false;
      assignee.innerHTML = `<option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Unassigned</option>`;
      assignee.value = inbox.assignee;
    } else {
      assignee.hidden = true;
    }
    if (!listData) { ul.innerHTML = `<li class="inbox-state">${loadingView()}</li>`; return; }
    if (!listData.items.length) {
      const filtered = inbox.q || inbox.handling !== 'all' || inbox.assignee;
      ul.innerHTML = `<li class="inbox-state">${emptyView(filtered ? 'No conversation matches. Clear the search or the filter.' : 'No conversations yet. They appear here as soon as customers message this business number.')}${filtered ? '<button class="btn small" id="ib-clear">Clear filters</button>' : ''}</li>`;
      $('#ib-clear')?.addEventListener('click', () => { inbox.q = ''; inbox.handling = 'all'; inbox.assignee = ''; inbox.offset = 0; $('#ib-q').value = ''; saveInboxState(); loadList(); });
    } else {
      ul.innerHTML = listData.items.map((item) => inboxRow(item, selectedId)).join('');
    }
    const total = listData.total;
    const from = total ? listData.offset + 1 : 0;
    const to = Math.min(total, listData.offset + listData.items.length);
    $('#ib-pager').innerHTML = `<span class="muted" aria-live="polite">${total ? `${from}–${to} of ${total}` : '0 conversations'}</span>
      <span><button class="btn small" id="ib-prev" ${listData.offset === 0 ? 'disabled' : ''} aria-label="Previous page">←</button> <button class="btn small" id="ib-next" ${to >= total ? 'disabled' : ''} aria-label="Next page">→</button></span>`;
    $('#ib-prev')?.addEventListener('click', () => { inbox.offset = Math.max(0, inbox.offset - inbox.limit); saveInboxState(); loadList(); });
    $('#ib-next')?.addEventListener('click', () => { inbox.offset += inbox.limit; saveInboxState(); loadList(); });
  }

  async function loadList() {
    try {
      const data = await api(`/api/dashboard/inbox?${InboxCore.buildInboxQuery(inbox)}`);
      if (disposed) return;
      // The page may have been emptied by a filter after the last visit: step back to the last page that has rows.
      if (!data.items.length && data.total > 0 && inbox.offset > 0) { inbox.offset = Math.max(0, Math.floor((data.total - 1) / inbox.limit) * inbox.limit); return loadList(); }
      listData = { ...data, accountId: getSelectedAccountId() };
      inboxLastList = listData;
      revision = data.revision;
      paintList();
      if (inbox.listScroll && $('#ib-items')) { $('#ib-items').scrollTop = inbox.listScroll; inbox.listScroll = 0; }
      return true;
    } catch (error) {
      if (disposed) return false;
      if (!listData) $('#ib-items').innerHTML = `<li class="inbox-state">${errorView(error.message || 'Could not load conversations.', () => { paintList(); loadList(); })}</li>`;
      throw error;
    }
  }

  $('#ib-q').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { inbox.q = event.target.value; inbox.offset = 0; saveInboxState(); loadList().catch(() => {}); }, 300);
  });
  $('#ib-first').addEventListener('change', (event) => { inbox.sort = event.target.checked ? 'waiting_first' : 'recent'; inbox.offset = 0; saveInboxState(); loadList().catch(() => {}); });
  $('#ib-assignee').addEventListener('change', (event) => { inbox.assignee = event.target.value; inbox.offset = 0; saveInboxState(); loadList().catch(() => {}); });
  // Arrow keys move between conversations without leaving the list.
  $('#ib-items').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...view.querySelectorAll('.inbox-item')];
    const at = links.indexOf(document.activeElement);
    const next = links[at + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) { event.preventDefault(); next.focus(); }
  });

  // ---------------------------------------------------------------- conversation workspace
  function paintThread() {
    const el = $('#ib-thread');
    if (!el) return;
    if (!selectedId) {
      el.innerHTML = `<div class="inbox-empty">${emptyView('Select a conversation to read it and reply.')}</div>`;
      return;
    }
    if (!thread) { el.innerHTML = loadingView(); return; }
    const t = thread;
    const state = t.handoff ? t.handoff.handoff.state : 'AI_ACTIVE';
    const info = InboxCore.handlingInfo(state, t.handoff && t.handoff.assignedTo ? t.handoff.assignedTo.name : null);
    const act = InboxCore.actionsFor(t);
    const label = (b) => ({ take_over: ['ib-act-take_over', 'Take over this conversation', 'primary'], accept: ['ib-act-accept', 'Accept and take over', 'primary'], resolve: ['ib-act-resolve', 'Mark resolved', 'success'], return: ['ib-act-return', 'Return to AI', ''] })[b];
    const customerName = t.customer.name || t.customer.waIdMasked;
    const keepScroll = el.querySelector('.transcript');
    const atBottom = !keepScroll || keepScroll.scrollHeight - keepScroll.scrollTop - keepScroll.clientHeight < 80;
    el.innerHTML = `
      <div class="thread-head">
        <a class="btn small thread-back" href="#/conversations">← Conversations</a>
        <span class="inbox-avatar" aria-hidden="true">${esc(InboxCore.initials(t.customer.name || ''))}</span>
        <div class="thread-title"><h3 dir="auto">${esc(customerName)}</h3>
          <p class="muted">${esc(t.customer.waId || t.customer.waIdMasked)}${t.customer.language ? ` · ${esc(t.customer.language.toUpperCase())}` : ''} · ${esc(t.account.name)}</p></div>
        <div class="thread-state">${badge(info.label, info.tone)}</div>
        <div class="actions">${act.buttons.map((b) => { const [id, text, tone] = label(b); return `<button class="btn ${tone}" id="${id}">${esc(text)}</button>`; }).join('')}</div>
      </div>
      ${t.connection && !t.connection.connected ? `<div class="inbox-banner warn" role="alert">This business's WhatsApp number is not connected (${esc(t.connection.phase)}). Messages from customers will not arrive and replies cannot be sent until it is reconnected.</div>` : ''}
      ${act.note ? `<p class="muted thread-note">${esc(act.note)}</p>` : ''}
      <div class="transcript" id="ib-transcript" tabindex="0" aria-label="Messages">
        ${t.hasMore ? '<button class="btn small" id="ib-earlier">Load earlier messages</button>' : ''}
        ${t.messages.length ? inboxThreadHtml(t.messages) : emptyView('No messages yet.')}
      </div>
      ${act.composer ? `<form id="ib-form" class="reply-form" autocomplete="off">
        <label class="sr-only" for="ib-text">Reply to the customer</label>
        <textarea id="ib-text" rows="3" maxlength="4000" dir="auto" placeholder="Write your reply… (Ctrl+Enter to send)">${esc(draft)}</textarea>
        <div class="actions"><span class="muted">Sent through this business's WhatsApp number. WhatsApp delivery receipts are not tracked.</span><button class="btn primary" id="ib-send" type="submit">Send</button></div>
      </form>` : ''}`;
    const transcript = $('#ib-transcript');
    if (transcript && atBottom) transcript.scrollTop = transcript.scrollHeight;

    for (const [button, handler] of [['take_over', () => post(`/api/dashboard/customers/${t.customer.id}/take-over`, 'You are now handling this conversation')], ['accept', () => post(`/api/dashboard/handoffs/${t.handoff.handoff.id}/accept`, 'You are now handling this conversation')], ['resolve', () => post(`/api/dashboard/handoffs/${t.handoff.handoff.id}/resolve`, 'Marked as resolved')], ['return', () => post(`/api/dashboard/handoffs/${t.handoff.handoff.id}/return-to-ai`, 'The conversation is back with the assistant')]]) {
      $(`#ib-act-${button}`)?.addEventListener('click', (event) => { event.currentTarget.disabled = true; handler(); });
    }
    $('#ib-earlier')?.addEventListener('click', loadEarlier);
    const form = $('#ib-form');
    if (form) {
      const box = $('#ib-text');
      box.addEventListener('input', () => { draft = box.value; });
      box.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); form.requestSubmit(); } });
      form.addEventListener('submit', sendReply);
    }
  }

  async function post(path, okMessage) {
    try {
      await api(path, { method: 'POST' });
      toast(okMessage, 'success');
    } catch (error) {
      // Someone else acted first, or the state moved on: say what the server said, then show the real current state.
      toast(error.message, 'error');
    }
    await Promise.allSettled([loadThread(true), loadList()]);
  }

  async function loadThread(full) {
    const path = `/api/dashboard/inbox/customers/${selectedId}`;
    const previous = thread;
    const data = await api(full || !previous ? `${path}?limit=50` : `${path}?after=${previous.latestId}`);
    if (disposed) return;
    if (full || !previous) {
      thread = data;
    } else {
      thread = { ...data, messages: InboxCore.mergeMessages(previous.messages, data.messages), hasMore: previous.hasMore, oldestId: previous.oldestId };
    }
    paintThread();
  }

  async function loadEarlier() {
    if (!thread || !thread.hasMore) return;
    const button = $('#ib-earlier');
    if (button) button.disabled = true;
    try {
      const older = await api(`/api/dashboard/inbox/customers/${selectedId}?before=${thread.oldestId}&limit=50`);
      thread = { ...thread, messages: InboxCore.mergeMessages(older.messages, thread.messages), hasMore: older.hasMore, oldestId: older.oldestId };
      paintThread();
    } catch (error) {
      toast(error.message, 'error');
      if (button) button.disabled = false;
    }
  }

  async function sendReply(event) {
    event.preventDefault();
    if (sending) return;
    const text = $('#ib-text').value.trim();
    if (!text) { toast('Write a message first', 'error'); return; }
    const handoffId = thread && thread.handoff ? thread.handoff.handoff.id : null;
    if (!handoffId) return;
    sending = true;
    $('#ib-send').disabled = true;
    // The same id is reused until the server confirms, so a double click or a retry after an error can never deliver twice.
    if (!pendingId) pendingId = newClientMessageId();
    try {
      await api(`/api/dashboard/handoffs/${handoffId}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, clientMessageId: pendingId }) });
      pendingId = null;
      draft = '';
      toast('Message sent', 'success');
      sending = false;
      await Promise.allSettled([loadThread(false), loadList()]);
    } catch (error) {
      toast(error.message, 'error'); // the draft stays in the box; Send retries the same message
      sending = false;
      $('#ib-send') && ($('#ib-send').disabled = false);
      if (/not the owner|another staff|no longer|handled by/i.test(error.message)) await loadThread(true).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- refresh: one tiny request, only reload when something changed
  function onVisibility() {
    if (!document.hidden && !disposed) { clearTimeout(timer); tick(false); }
  }
  document.addEventListener('visibilitychange', onVisibility);

  async function tick(force) {
    clearTimeout(timer);
    if (disposed) return;
    const wait = InboxCore.pollDelay({ hidden: document.hidden, failures });
    if (wait === null) { timer = setTimeout(() => tick(false), 5000); return; } // hidden tab: no requests at all
    try {
      const pulse = await api('/api/dashboard/inbox/pulse');
      if (disposed) return;
      const wasDown = failures > 0;
      failures = 0;
      banner(wasDown ? 'Reconnected — the conversations are up to date.' : '', false);
      if (wasDown) setTimeout(() => !disposed && banner('', false), 3000);
      if (force || pulse.revision !== revision) {
        const jobs = [loadList()];
        if (selectedId && !sending) jobs.push(loadThread(false));
        await Promise.allSettled(jobs);
      } else if (thread && thread.connection && pulse.connection && thread.connection.connected !== pulse.connection.connected) {
        thread = { ...thread, connection: pulse.connection };
        paintThread();
      }
    } catch (error) {
      if (disposed) return;
      failures += 1;
      const seconds = Math.round(InboxCore.pollDelay({ hidden: false, failures }) / 1000);
      banner(`Connection problem — retrying in ${seconds}s.`, true);
    }
    if (!disposed) timer = setTimeout(() => tick(false), InboxCore.pollDelay({ hidden: document.hidden, failures }) || 5000);
  }

  // ---------------------------------------------------------------- start
  paintList();
  paintThread();
  if (listData && inbox.listScroll) $('#ib-items').scrollTop = inbox.listScroll;
  const first = [loadList().catch((error) => { failures += 1; banner(`Could not load conversations: ${error.message}`, true); })];
  if (selectedId) {
    first.push(loadThread(true).catch((error) => {
      if (disposed) return;
      $('#ib-thread').innerHTML = `<div class="inbox-empty">${errorView(error.message || 'Could not open this conversation.', () => { thread = null; paintThread(); loadThread(true).catch((e) => toast(e.message, 'error')); })}<a class="btn small" href="#/conversations">← Conversations</a></div>`;
    }));
  }
  await Promise.allSettled(first);
  if (!disposed) timer = setTimeout(() => tick(false), InboxCore.pollDelay({ hidden: document.hidden, failures }) || 5000);
}
