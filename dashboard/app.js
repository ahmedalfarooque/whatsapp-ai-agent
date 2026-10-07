// WhatsApp AI Agent — Dashboard SPA
// Vanilla JS, hash-routed, no framework/bundler. Every view fetches real
// data from the dashboard's read (and, for knowledge, write) APIs, which
// themselves reuse the application's existing repositories/config — there
// is no separate dataset here.

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(value) {
  if (!value) return '—';
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return esc(value);
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------
// Selected WhatsApp account (business). Every API call carries it in the
// X-Whatsapp-Account header; the server validates it and scopes the data.
// ---------------------------------------------------------------------

const ACCOUNT_STORAGE_KEY = 'workspace.selectedAccount';
let selectedAccountId = (() => {
  try { const v = Number.parseInt(localStorage.getItem(ACCOUNT_STORAGE_KEY) || '', 10); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
})();
let knownAccounts = [];

function getSelectedAccountId() {
  return selectedAccountId;
}

function currentAccount() {
  return knownAccounts.find((a) => a.id === selectedAccountId) || null;
}

async function api(url, options) {
  let response;
  try {
    const headers = { ...((options && options.headers) || {}) };
    if (selectedAccountId) headers['X-Whatsapp-Account'] = String(selectedAccountId);
    response = await fetch(url, { credentials: 'include', ...options, headers });
  } catch {
    // The browser's own network-layer failure (server not running,
    // connection refused, DNS failure) — its native message is the terse
    // "Failed to fetch", which tells the user nothing actionable. This is
    // the ONLY place that error can originate; every server-provided error
    // below carries the server's own real message instead.
    throw new Error(`Could not reach the server at ${location.origin} — is it running?`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 401 && location.hash !== '#/login') {
    location.hash = '#/login';
    throw new Error('unauthenticated');
  }
  if ((response.status === 404 || response.status === 403) && body && /WhatsApp account/i.test(body.error || '') && selectedAccountId) {
    // The remembered account no longer exists or is no longer ours: fall back to the server default.
    selectAccount(null, { silent: true });
  }
  if (!response.ok) {
    const message = (body && body.error) || `Request failed (${response.status})`;
    const error = new Error(message);
    if (body && body.fields) error.fields = body.fields;
    throw error;
  }
  return body;
}

function toast(message, kind) {
  const host = document.querySelector('#toast-host');
  const el = document.createElement('div');
  el.className = `toast ${kind || 'info'}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

function loadingView() {
  return '<div class="state-block"><div class="spinner"></div><p>Loading…</p></div>';
}

function errorView(message, onRetry) {
  const id = `retry-${Math.random().toString(36).slice(2)}`;
  setTimeout(() => {
    const btn = document.getElementById(id);
    if (btn && onRetry) btn.addEventListener('click', onRetry);
  }, 0);
  return `<div class="state-block error"><p>${esc(message || 'Something went wrong loading this page.')}</p>${onRetry ? `<button id="${id}" class="btn">Retry</button>` : ''}</div>`;
}

function emptyView(message) {
  return `<div class="state-block"><p>${esc(message)}</p></div>`;
}

function badge(text, tone) {
  return `<span class="badge ${tone || ''}">${esc(text)}</span>`;
}

function stateTone(state) {
  const s = String(state || '').toLowerCase();
  if (s.includes('mock') || s === 'confirmed' || s === 'connected' || s === 'available' || s === 'configured') return 'green';
  if (s.includes('production')) return 'blue';
  if (s.includes('missing') || s === 'uncertain' || s.includes('unavailable')) return 'red';
  if (s === 'pending' || s === 'active') return 'amber';
  return '';
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

const routes = [];
let disposeView = () => {};
function route(pattern, title, subtitle, render) {
  routes.push({ pattern, title, subtitle, render });
}

function matchRoute(hash) {
  for (const r of routes) {
    if (typeof r.pattern === 'string') {
      if (hash === r.pattern) return { route: r, params: {} };
      continue;
    }
    const match = r.pattern.exec(hash);
    if (match) return { route: r, params: match.groups || {} };
  }
  return null;
}

async function renderRoute() {
  disposeView();
  disposeView = () => {};
  const hash = location.hash || '#/';
  document.body.classList.toggle('auth-page', hash === '#/login');
  const matched = matchRoute(hash);
  const view = document.querySelector('#view');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.remove('active'));

  if (!matched) {
    document.querySelector('#page-title').textContent = 'Not found';
    document.querySelector('#page-subtitle').textContent = '';
    view.innerHTML = emptyView('This page does not exist.');
    return;
  }

  const topLevelKey = `#${hash.split('/')[1] ? '/' + hash.split('/')[1] : '/'}`;
  const navLink = document.querySelector(`#nav a[data-route="${topLevelKey}"]`) || document.querySelector('#nav a[data-route="#/"]');
  if (navLink) navLink.classList.add('active');

  document.querySelector('#page-title').textContent = matched.route.title;
  document.querySelector('#page-subtitle').textContent = matched.route.subtitle || '';
  view.innerHTML = loadingView();
  try {
    await matched.route.render(view, matched.params);
  } catch (error) {
    view.innerHTML = errorView(error.message, renderRoute);
  }
}

window.addEventListener('hashchange', () => {
  if (location.hash === '#/login') {
    renderRoute();
  } else {
    boot();
  }
});

// ---------------------------------------------------------------------
// WhatsApp accounts: sidebar list + switcher
// ---------------------------------------------------------------------

const ACCOUNT_STATUS = {
  connected: { label: 'Connected', dot: 'green' },
  connecting: { label: 'Connecting', dot: 'amber' },
  qr_required: { label: 'QR required', dot: 'amber' },
  disconnected: { label: 'Disconnected', dot: 'red' },
  disabled: { label: 'Disabled', dot: '' },
  error: { label: 'Error', dot: 'red' },
};

function accountStatusInfo(status) {
  return ACCOUNT_STATUS[status] || { label: status || 'Unknown', dot: '' };
}

function renderAccountList() {
  const host = document.querySelector('#account-list');
  if (!host) return;
  if (!knownAccounts.length) { host.innerHTML = '<span class="muted">No accounts yet</span>'; return; }
  host.innerHTML = knownAccounts.map((a) => {
    const info = accountStatusInfo(a.uiStatus);
    const active = a.id === selectedAccountId;
    return `<button type="button" class="account-item ${active ? 'active' : ''} ${a.enabled ? '' : 'off'}" data-account="${a.id}" title="${esc(a.name)} · ${esc(info.label)}" aria-pressed="${active}">
      <span class="dot ${info.dot}"></span>
      <span class="account-text"><span class="account-name" dir="auto">${esc(a.name)}</span><small>${esc(a.phoneNumber || info.label)}</small></span>
    </button>`;
  }).join('');
  host.querySelectorAll('[data-account]').forEach((btn) => btn.addEventListener('click', () => selectAccount(Number(btn.dataset.account))));
  const chip = document.querySelector('#account-chip');
  const current = currentAccount();
  if (chip) {
    chip.hidden = !current;
    if (current) document.querySelector('#account-chip-name').textContent = current.name;
  }
  const eyebrow = document.querySelector('#page-eyebrow');
  if (eyebrow && current) eyebrow.textContent = current.name;
}

/** Loads the accounts the signed-in admin may see and settles the selection (remembered id when still valid, else the server default). */
async function loadAccounts() {
  try {
    const data = await api('/api/dashboard/accounts');
    knownAccounts = data.accounts || [];
    const valid = knownAccounts.some((a) => a.id === selectedAccountId);
    if (!valid) {
      selectedAccountId = data.selected || (knownAccounts[0] ? knownAccounts[0].id : null);
      try { if (selectedAccountId) localStorage.setItem(ACCOUNT_STORAGE_KEY, String(selectedAccountId)); } catch { /* storage unavailable */ }
    }
    renderAccountList();
    document.dispatchEvent(new CustomEvent('workspace:accounts', { detail: { accounts: knownAccounts, selected: selectedAccountId } }));
  } catch (error) {
    const host = document.querySelector('#account-list');
    if (host) host.innerHTML = `<span class="muted">${esc(error.message)}</span>`;
  }
}

/** Switches the whole dashboard to another business: same pages, that account's data. */
function selectAccount(accountId, opts = {}) {
  const changed = accountId !== selectedAccountId;
  selectedAccountId = accountId;
  try {
    if (accountId) localStorage.setItem(ACCOUNT_STORAGE_KEY, String(accountId));
    else localStorage.removeItem(ACCOUNT_STORAGE_KEY);
  } catch { /* storage unavailable */ }
  if (opts.silent) return;
  renderAccountList();
  const current = currentAccount();
  if (changed && current) toast(`Switched to ${current.name}`, 'success');
  document.dispatchEvent(new CustomEvent('workspace:account-changed', { detail: { selected: selectedAccountId } }));
  if (changed) renderRoute();
}

let accountsTimer;
async function pollAccounts() {
  clearTimeout(accountsTimer);
  await loadAccounts();
  accountsTimer = setTimeout(pollAccounts, 10000);
}

// ---------------------------------------------------------------------
// Small-screen navigation drawer (the sidebar is off-canvas at <= 900px)
// ---------------------------------------------------------------------

(function navDrawer() {
  const toggle = document.querySelector('#nav-toggle');
  const scrim = document.querySelector('#nav-scrim');
  const side = document.querySelector('#sidebar');
  if (!toggle || !scrim || !side) return;
  const set = (open) => {
    document.body.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    if (open) { const first = side.querySelector('a, button'); if (first) first.focus(); } else if (side.contains(document.activeElement)) toggle.focus();
  };
  toggle.addEventListener('click', () => set(!document.body.classList.contains('nav-open')));
  scrim.addEventListener('click', () => set(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) set(false); });
  window.addEventListener('hashchange', () => set(false));
  side.addEventListener('click', (e) => { if (e.target.closest('a, button')) set(false); });
})();

// ---------------------------------------------------------------------
// Shared header bits (environment badge, sidebar mode note)
// ---------------------------------------------------------------------

async function loadHeader() {
  try {
    const status = await api('/api/dashboard/status');
    document.querySelector('#environment').textContent =
      status.environment === 'development' ? 'Development' : status.environment === 'production' ? 'Production' : status.environment;
    document.querySelector('#sidebar-mode').textContent =
      status.providerMode === 'mock' ? 'Signed in · mock providers' : 'Signed in · production providers';
    document.querySelector('#logout-btn').style.display = 'inline-flex';
  } catch {
    document.querySelector('#environment').textContent = 'Unavailable';
  }
}

document.querySelector('#logout-btn').addEventListener('click', async () => {
  try {
    await fetch('/api/dashboard/auth/logout', { method: 'POST', credentials: 'include' });
  } finally {
    location.hash = '#/login';
    location.reload();
  }
});

/** Runs once at page load and again right after a successful sign-in: checks
 * auth status and either boots the real app or forces the login screen. */
async function boot() {
  const status = await fetch('/api/dashboard/auth/status', { credentials: 'include' }).then((r) => r.json());
  if (!status.authenticated) {
    document.querySelector('#logout-btn').style.display = 'none';
    if (location.hash !== '#/login') location.hash = '#/login';
    await renderRoute();
    return;
  }
  if (location.hash === '#/login') location.hash = '#/';
  await loadAccounts(); // settles the selected account before any account-scoped request
  await loadHeader();
  document.dispatchEvent(new Event('workspace:authenticated'));
  clearTimeout(accountsTimer);
  accountsTimer = setTimeout(pollAccounts, 10000);
  await renderRoute();
}

// ---------------------------------------------------------------------
// Login / first-run admin setup
// ---------------------------------------------------------------------

route('#/login', 'Sign in', '', async (view) => {
  const status = await fetch('/api/dashboard/auth/status', { credentials: 'include' }).then((r) => r.json());
  const isSetup = !status.hasAdmin;

  view.innerHTML = `
    <div class="auth-layout"><section class="auth-story">
      <p class="eyebrow light">ROWAD ALFA · AI WORKSPACE</p>
      <h2>A better conversation.<br>A closer connection.</h2>
      <p>One workspace for your WhatsApp conversations, customer care, and appointments.</p>
      <div class="auth-visual" aria-hidden="true"><span class="chat-bubble">Hello. How can we help?</span><span class="chat-bubble answer" dir="rtl">أهلاً بك، كيف نقدر نخدمك؟</span><div class="auth-signal">◎ <span>People first. Powered by AI.</span></div></div>
      <small>Your business. Your conversations. One clear view.</small>
    </section><section class="panel detail auth-card">
      <span class="auth-logo" aria-hidden="true">◎</span><p class="eyebrow">WELCOME TO YOUR WORKSPACE</p>
      <h3>${isSetup ? 'Set up your workspace' : 'Welcome back'}</h3>
      <p class="muted">${isSetup ? 'Create an administrator account to get started.' : 'Sign in to manage your AI assistant.'}</p>
      <form id="auth-form">
        <label class="muted" for="username">Username</label>
        <input id="username" type="text" autocomplete="username" required style="width:100%;margin:6px 0 14px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:#fafbfe" />
        <label class="muted" for="password">Password${isSetup ? ' (min 12 characters)' : ''}</label>
        <div class="password-wrap"><input id="password" type="password" autocomplete="${isSetup ? 'new-password' : 'current-password'}" ${isSetup ? 'minlength="12"' : ''} required /><button type="button" id="show-password" aria-controls="password" aria-pressed="false">Show</button></div>
        <div id="auth-error" class="form-error" hidden></div>
        <button type="submit" class="btn primary" style="width:100%">${isSetup ? 'Create account & sign in' : 'Sign in'}</button>
      </form>
      <p class="auth-footnote">Secure administrator access</p>
    </section></div>`;

  view.querySelector('#show-password').addEventListener('click', (event) => {
    const input = view.querySelector('#password');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    event.currentTarget.textContent = reveal ? 'Hide' : 'Show';
    event.currentTarget.setAttribute('aria-pressed', String(reveal));
  });

  const errorBox = view.querySelector('#auth-error');
  view.querySelector('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    const submit = view.querySelector('[type=submit]');
    submit.disabled = true;
    const username = view.querySelector('#username').value.trim();
    const password = view.querySelector('#password').value;
    try {
      const res = await fetch(isSetup ? '/api/dashboard/auth/setup' : '/api/dashboard/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        errorBox.hidden = false;
        errorBox.textContent = body.error || 'Sign-in failed.';
        return;
      }
      location.hash = '#/';
      await boot();
    } catch {
      errorBox.hidden = false;
      errorBox.textContent = 'Could not reach the server.';
    } finally {
      submit.disabled = false;
    }
  });
});

// ---------------------------------------------------------------------
// Dashboard home
// ---------------------------------------------------------------------

route('#/', 'Dashboard', 'A clear view of your customer conversations and agent health.', async (view) => {
  const [summary, status, conversations, bookings] = await Promise.all([
    api('/api/dashboard/summary'),
    api('/api/dashboard/status'),
    api('/api/dashboard/conversations-recent'),
    api('/api/dashboard/bookings/upcoming'),
  ]);

  const cards = [
    ['Customers', summary.customers, '♙'],
    ['Conversations', summary.conversations, '◌'],
    ['Confirmed bookings', summary.bookings, '◷'],
    ['AI replies sent', summary.aiRequests, '✦'],
  ];

  view.innerHTML = `
    <section class="hero">
      <div>
        <p class="eyebrow light">SYSTEM OVERVIEW</p>
        <h2>Every conversation starts here.</h2>
        <p>${status.providerMode === 'mock' ? 'Your development workspace. Connections use test providers.' : 'Keep your customers, conversations, and assistant in sync.'}</p>
        <a class="btn primary" style="margin-top:16px" href="#/whatsapp">Open WhatsApp Connection ↗</a>
      </div>
      <div class="hero-orb">✦</div>
    </section>
    <section class="stats">${cards.map(([l, v, i]) => `<div class="stat"><div class="stat-label"><span>${l}</span><span class="stat-icon">${i}</span></div><div class="stat-value">${esc(v)}</div></div>`).join('')}</section>
    <div class="grid two">
      <section class="panel">
        <div class="panel-head"><div><p class="eyebrow">SERVICE HEALTH</p><h3>Connected systems</h3></div><a class="live" href="#/integrations"><span class="dot green"></span> Details</a></div>
        <div class="status-list">${status.services.map((s) => `<div class="status-row"><span class="status-name"><span class="dot ${stateTone(s.state) === 'green' || stateTone(s.state) === 'blue' ? 'green' : ''}"></span>${esc(s.name)}</span><span class="state">${esc(s.state)}</span></div>`).join('')}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><p class="eyebrow">KNOWLEDGE BASE</p><h3>Source files</h3></div><a class="muted" href="#/knowledge">Manage →</a></div>
        <div class="knowledge-list">${status.knowledge.map((k) => `<div class="knowledge-row"><span class="knowledge-name"><span class="file">${esc(k.name)}</span></span><span class="${k.status === 'Available' ? 'available' : 'missing'}">${esc(k.status)}</span></div>`).join('')}</div>
      </section>
    </div>
    <div class="grid two lower">
      <section class="panel">
        <div class="panel-head"><div><p class="eyebrow">RECENT ACTIVITY</p><h3>Conversations</h3></div><a class="muted" href="#/conversations">View all →</a></div>
        <div class="list ${conversations.conversations.length ? '' : 'empty'}">${
          conversations.conversations.length
            ? conversations.conversations
                .map((c) => `<div class="activity-row"><div class="activity-main"><div class="activity-name">${esc(c.customer)}</div><div class="activity-text">${esc(c.lastMessage || 'No messages yet')}</div></div><div class="activity-meta">${formatDate(c.updatedAt)}<br>${badge(c.status, stateTone(c.status))}</div></div>`)
                .join('')
            : 'No conversations yet. They will appear here as customers message the agent.'
        }</div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><p class="eyebrow">SCHEDULE</p><h3>Upcoming bookings</h3></div><a class="muted" href="#/bookings">View all →</a></div>
        <div class="list ${bookings.bookings.length ? '' : 'empty'}">${
          bookings.bookings.length
            ? bookings.bookings
                .map((b) => `<div class="activity-row"><div class="activity-main"><div class="activity-name">${esc(b.customer)}</div><div class="activity-text">${esc(b.date || '—')} ${esc(b.time || '')}</div></div><div class="activity-meta">${badge(b.status, stateTone(b.status))}</div></div>`)
                .join('')
            : 'No confirmed bookings yet.'
        }</div>
      </section>
    </div>`;
});

// ---------------------------------------------------------------------
// Customers (list + search + pagination + detail)
// ---------------------------------------------------------------------

route('#/customers', 'Customers', 'Everyone who has messaged the agent, from the live database.', async (view) => {
  let state = { search: '', offset: 0, limit: 20 };

  async function draw() {
    const data = await api(`/api/dashboard/customers?search=${encodeURIComponent(state.search)}&limit=${state.limit}&offset=${state.offset}`);
    view.innerHTML = `
      <section class="panel">
        <div class="toolbar"><input id="search" type="search" placeholder="Search by name or WhatsApp number…" value="${esc(state.search)}" /></div>
        ${
          data.items.length
            ? `<table class="data-table"><thead><tr><th>Customer</th><th>Conversations</th><th>Bookings</th><th>Last interaction</th></tr></thead><tbody>${data.items
                .map(
                  (c) =>
                    `<tr class="row-link" data-id="${c.id}"><td>${esc(c.display_name || c.wa_id)}</td><td>${c.conversationCount}</td><td>${c.bookingCount}</td><td>${formatDate(c.lastInteractionAt)}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : emptyView(state.search ? 'No customers match that search.' : 'No customers yet — they appear automatically once someone messages the agent.')
        }
        <div class="pager"><span class="muted">${data.total} total</span><div><button id="prev" class="btn" ${state.offset === 0 ? 'disabled' : ''}>← Prev</button><button id="next" class="btn" ${state.offset + state.limit >= data.total ? 'disabled' : ''}>Next →</button></div></div>
      </section>`;

    const searchInput = view.querySelector('#search');
    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.search = e.target.value;
        state.offset = 0;
        draw();
      }, 250);
    });
    view.querySelector('#prev')?.addEventListener('click', () => {
      state.offset = Math.max(0, state.offset - state.limit);
      draw();
    });
    view.querySelector('#next')?.addEventListener('click', () => {
      state.offset += state.limit;
      draw();
    });
    view.querySelectorAll('.row-link').forEach((row) => {
      row.addEventListener('click', () => {
        location.hash = `#/customers/${row.dataset.id}`;
      });
    });
  }

  await draw();
});

route(/^#\/customers\/(?<id>\d+)$/, 'Customer', '', async (view, params) => {
  const customer = await api(`/api/dashboard/customers/${params.id}`);
  view.innerHTML = `
    <a class="back-link" href="#/customers">← Back to customers</a>
    <section class="panel detail">
      <h3>${esc(customer.display_name || customer.wa_id)}</h3>
      <dl class="detail-grid">
        <dt>WhatsApp number</dt><dd>${esc(customer.wa_id)}</dd>
        <dt>Conversations</dt><dd>${customer.conversationCount}</dd>
        <dt>Confirmed bookings</dt><dd>${customer.bookingCount}</dd>
        <dt>Last interaction</dt><dd>${formatDate(customer.lastInteractionAt)}</dd>
        <dt>Customer since</dt><dd>${formatDate(customer.created_at)}</dd>
      </dl>
    </section>`;
});

// ---------------------------------------------------------------------
// Conversations (list + status filter + pagination + detail with messages)
// ---------------------------------------------------------------------

route('#/conversations', 'Conversations', 'Every stored conversation thread, oldest to newest message.', async (view) => {
  let state = { status: '', offset: 0, limit: 20 };

  async function draw() {
    const data = await api(`/api/dashboard/conversations?status=${state.status}&limit=${state.limit}&offset=${state.offset}`);
    view.innerHTML = `
      <section class="panel">
        <div class="toolbar">
          <select id="status-filter">
            <option value="">All statuses</option>
            <option value="active" ${state.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="ended" ${state.status === 'ended' ? 'selected' : ''}>Ended</option>
          </select>
        </div>
        ${
          data.items.length
            ? `<table class="data-table"><thead><tr><th>Customer</th><th>Status</th><th>Messages</th><th>Last activity</th></tr></thead><tbody>${data.items
                .map(
                  (c) =>
                    `<tr class="row-link" data-id="${c.id}"><td>${esc(c.customerLabel || c.waId)}</td><td>${badge(c.status, stateTone(c.status))}</td><td>${c.messageCount}</td><td>${formatDate(c.lastMessageAt || c.started_at)}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : emptyView('No conversations recorded yet.')
        }
        <div class="pager"><span class="muted">${data.total} total</span><div><button id="prev" class="btn" ${state.offset === 0 ? 'disabled' : ''}>← Prev</button><button id="next" class="btn" ${state.offset + state.limit >= data.total ? 'disabled' : ''}>Next →</button></div></div>
      </section>`;

    view.querySelector('#status-filter').addEventListener('change', (e) => {
      state.status = e.target.value;
      state.offset = 0;
      draw();
    });
    view.querySelector('#prev')?.addEventListener('click', () => {
      state.offset = Math.max(0, state.offset - state.limit);
      draw();
    });
    view.querySelector('#next')?.addEventListener('click', () => {
      state.offset += state.limit;
      draw();
    });
    view.querySelectorAll('.row-link').forEach((row) => {
      row.addEventListener('click', () => {
        location.hash = `#/conversations/${row.dataset.id}`;
      });
    });
  }

  await draw();
});

route(/^#\/conversations\/(?<id>\d+)$/, 'Conversation', '', async (view, params) => {
  const data = await api(`/api/dashboard/conversations/${params.id}`);
  const { conversation, messages } = data;
  view.innerHTML = `
    <a class="back-link" href="#/conversations">← Back to conversations</a>
    <section class="panel detail">
      <h3>${esc(conversation.customerLabel || conversation.waId)} ${badge(conversation.status, stateTone(conversation.status))}</h3>
      <p class="muted">Started ${formatDate(conversation.started_at)}${conversation.ended_at ? ` · Ended ${formatDate(conversation.ended_at)}` : ''}</p>
      <div class="transcript">
        ${
          messages.length
            ? messages
                .map(
                  (m) =>
                    `<div class="bubble ${m.role === 'user' ? 'in' : m.role === 'assistant' ? 'out' : 'sys'}"><div class="bubble-role">${esc(m.role)}${m.toolName ? ` · ${esc(m.toolName)}` : ''}</div><div class="bubble-text">${esc(m.content)}</div><div class="bubble-time">${formatDate(m.createdAt)}</div></div>`,
                )
                .join('')
            : emptyView('No messages recorded for this conversation.')
        }
      </div>
    </section>`;
});

// ---------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------

route('#/bookings', 'Bookings', 'Real appointment records from the booking system — confirmed, pending, and uncertain.', async (view) => {
  let state = { status: '', offset: 0, limit: 20 };

  async function draw() {
    const data = await api(`/api/dashboard/bookings?status=${state.status}&limit=${state.limit}&offset=${state.offset}`);
    view.innerHTML = `
      <section class="panel">
        <div class="toolbar">
          <select id="status-filter">
            <option value="">All statuses</option>
            <option value="confirmed" ${state.status === 'confirmed' ? 'selected' : ''}>Confirmed</option>
            <option value="pending" ${state.status === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="uncertain" ${state.status === 'uncertain' ? 'selected' : ''}>Uncertain (needs reconciliation)</option>
          </select>
        </div>
        ${
          data.items.length
            ? `<table class="data-table"><thead><tr><th>Customer</th><th>Start</th><th>End</th><th>Status</th><th>Calendar event</th><th></th></tr></thead><tbody>${data.items
                .map(
                  (b) =>
                    `<tr><td>${esc(b.customerLabel || b.waId)}</td><td>${formatDate(b.start_iso)}</td><td>${formatDate(b.end_iso)}</td><td>${badge(b.status, stateTone(b.status))}</td><td class="file">${esc(b.calendar_event_id || '—')}</td><td>${
                      b.status === 'uncertain'
                        ? `<div class="toolbar" style="margin:0"><button class="btn small reconcile-confirmed" data-id="${b.id}">Mark confirmed…</button><button class="btn small reconcile-not-booked" data-id="${b.id}">Mark not booked</button></div>`
                        : ''
                    }</td></tr>`,
                )
                .join('')}</tbody></table>`
            : emptyView('No bookings recorded yet — bookings created through the WhatsApp agent appear here.')
        }
        ${
          data.items.some((b) => b.status === 'uncertain')
            ? `<p class="muted" style="margin-top:10px">Uncertain bookings mean the system could not confirm whether Google actually created the event. Before reconciling, manually check the real Google Calendar for this exact time slot — never guess. "Mark confirmed" requires the real event ID you found there; "Mark not booked" releases the slot for a fresh attempt and should only be used once you've confirmed no event exists.</p>`
            : ''
        }
        <div class="pager"><span class="muted">${data.total} total</span><div><button id="prev" class="btn" ${state.offset === 0 ? 'disabled' : ''}>← Prev</button><button id="next" class="btn" ${state.offset + state.limit >= data.total ? 'disabled' : ''}>Next →</button></div></div>
      </section>`;
    if (window.renderWhatsappRequests) {
      const host = document.createElement('div');
      view.appendChild(host);
      await window.renderWhatsappRequests(host);
    }

    view.querySelector('#status-filter').addEventListener('change', (e) => {
      state.status = e.target.value;
      state.offset = 0;
      draw();
    });
    view.querySelector('#prev')?.addEventListener('click', () => {
      state.offset = Math.max(0, state.offset - state.limit);
      draw();
    });
    view.querySelector('#next')?.addEventListener('click', () => {
      state.offset += state.limit;
      draw();
    });

    view.querySelectorAll('.reconcile-confirmed').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const calendarEventId = prompt(
          'Enter the real Google Calendar event ID you found by manually checking the calendar for this exact time slot:',
        );
        if (!calendarEventId) return;
        try {
          await api(`/api/dashboard/bookings/${btn.dataset.id}/reconcile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolution: 'confirmed', calendarEventId }),
          });
          toast('Booking marked confirmed', 'success');
          await draw();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    });
    view.querySelectorAll('.reconcile-not-booked').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (
          !confirm(
            'Only do this if you have manually confirmed in the real Google Calendar that NO event exists for this time slot. This releases the slot for a fresh booking attempt. Continue?',
          )
        )
          return;
        try {
          await api(`/api/dashboard/bookings/${btn.dataset.id}/reconcile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolution: 'not_booked' }),
          });
          toast('Booking marked not booked — slot released', 'success');
          await draw();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    });
  }

  await draw();
});

// ---------------------------------------------------------------------
// Knowledge (list + view + edit with safe save)
// ---------------------------------------------------------------------

route('#/knowledge', 'Knowledge', 'The exact files the AI reads business facts from — nothing else.', async (view) => {
  const data = await api('/api/dashboard/knowledge');
  view.innerHTML = `
    <section class="panel">
      <table class="data-table"><thead><tr><th>File</th><th>Status</th><th>Size</th><th>Last modified</th><th></th></tr></thead><tbody>
        ${data.files
          .map(
            (f) =>
              `<tr><td class="file">${esc(f.name)}</td><td>${f.exists ? badge('Available', 'green') : badge('Missing', 'red')}</td><td>${f.sizeBytes != null ? `${f.sizeBytes} B` : '—'}</td><td>${formatDate(f.modifiedAt)}</td><td><a class="btn small" href="#/knowledge/${encodeURIComponent(f.name)}">${f.exists ? 'View / Edit' : 'Create'}</a></td></tr>`,
          )
          .join('')}
      </tbody></table>
    </section>`;
});

route(/^#\/knowledge\/(?<name>[\w.-]+)$/, 'Knowledge file', '', async (view, params) => {
  const name = decodeURIComponent(params.name);
  let original = '';
  try {
    const data = await api(`/api/dashboard/knowledge/${encodeURIComponent(name)}`);
    original = data.content;
  } catch {
    original = '';
  }

  view.innerHTML = `
    <a class="back-link" href="#/knowledge">← Back to knowledge files</a>
    <section class="panel detail">
      <h3 class="file">${esc(name)}</h3>
      <p class="muted">Saving creates a timestamped backup of the previous version first. ${name.endsWith('.json') ? 'Content must be valid JSON.' : ''}</p>
      <textarea id="editor" class="editor" spellcheck="false">${esc(original)}</textarea>
      <div id="editor-error" class="form-error" hidden></div>
      <div class="toolbar">
        <button id="save" class="btn primary">Save</button>
        <button id="cancel" class="btn">Cancel</button>
        <button id="reset" class="btn">Reset to last saved</button>
      </div>
    </section>`;

  const editor = view.querySelector('#editor');
  const errorBox = view.querySelector('#editor-error');

  view.querySelector('#cancel').addEventListener('click', () => {
    location.hash = '#/knowledge';
  });
  view.querySelector('#reset').addEventListener('click', () => {
    editor.value = original;
    errorBox.hidden = true;
  });
  view.querySelector('#save').addEventListener('click', async () => {
    errorBox.hidden = true;
    if (name.endsWith('.json')) {
      try {
        JSON.parse(editor.value);
      } catch {
        errorBox.hidden = false;
        errorBox.textContent = 'This is not valid JSON — fix the syntax before saving.';
        return;
      }
    }
    try {
      await api(`/api/dashboard/knowledge/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editor.value }),
      });
      original = editor.value;
      toast(`${name} saved`, 'success');
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = error.message;
    }
  });
});

// ---------------------------------------------------------------------
// Services (read view of services.md — the real source of truth)
// ---------------------------------------------------------------------

route('#/services', 'Services', 'Derived from knowledge/services.md — edit it from the Knowledge page.', async (view) => {
  const data = await api('/api/dashboard/services');
  view.innerHTML = `
    <section class="panel">
      ${
        data.available
          ? `<pre class="content-view">${esc(data.content)}</pre><a class="btn" href="#/knowledge/${encodeURIComponent(data.sourceFile)}">Edit in Knowledge →</a>`
          : emptyView(`${data.sourceFile} does not exist yet. Create it from the Knowledge page to list your services.`)
      }
    </section>`;
});

// ---------------------------------------------------------------------
// AI configuration (read-only)
// ---------------------------------------------------------------------

route('#/ai', 'AI', 'Current agent configuration — no secrets are shown here.', async (view) => {
  const ai = await api('/api/dashboard/ai');
  view.innerHTML = `
    <section class="panel">
      <dl class="detail-grid">
        <dt>Mode</dt><dd>${ai.providerMode === 'mock' ? badge('Development mock', 'green') : badge('Production', 'blue')}</dd>
        <dt>Model</dt><dd class="file">${esc(ai.model)}</dd>
        <dt>Max tool rounds</dt><dd>${ai.maxToolRounds}</dd>
        <dt>Conversation history sent to model</dt><dd>${ai.conversationHistoryLimit} messages</dd>
        <dt>OpenRouter timeout</dt><dd>${ai.timeouts.openRouterMs} ms</dd>
        <dt>Tools available</dt><dd>${ai.toolsEnabled.map((t) => `<span class="file">${esc(t)}</span>`).join(', ')}</dd>
      </dl>
      <p class="muted">Model and provider mode are controlled by environment variables (<span class="file">OPENROUTER_MODEL</span>, <span class="file">NODE_ENV</span>) — changing them requires updating the server's <span class="file">.env</span> and restarting, never from this page.</p>
    </section>`;
});

// ---------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------

const OPTIONAL_CREDENTIAL_GROUPS = [{ title: 'Google Calendar', keys: ['GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY'] }];

// Browsers' password managers autofill by structural heuristic (a text field
// immediately preceding a password field inside a <form> reads as "username
// + password"), largely ignoring autocomplete="off" for that judgment. These
// fields hold WhatsApp/Meta configuration, never login credentials, so every
// input below gets a form-unique id, autocomplete="new-password" (the value
// Chromium actually honors to suppress both save-prompts and autofill —
// plain "off" is not reliable), and the assorted per-manager "ignore this
// field" attributes. A decoy username/password pair (see waDecoyFields) sits
// before the real fields in the DOM to absorb whatever the browser still
// insists on offering.
function pwField(name, label, help, value) {
  const id = `wa-field-${name}`;
  return `
    <div class="field">
      <label for="${id}">${esc(label)}</label>
      <div class="pw-wrap">
        <input id="${id}" name="${name}" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore data-bwignore data-form-type="other" spellcheck="false" placeholder="${value ? 'Saved — enter a new value to replace' : 'Enter value'}" />
        <button type="button" class="pw-toggle" data-for="${id}" aria-label="Show value">Show</button>
      </div>
      ${help ? `<p class="field-help">${help}</p>` : ''}
    </div>`;
}

function textField(name, label, help, value, opts = {}) {
  const id = `wa-field-${name}`;
  const numericAttrs = opts.numeric ? ' inputmode="numeric" pattern="[0-9]*"' : '';
  return `
    <div class="field">
      <label for="${id}">${esc(label)}</label>
      <input id="${id}" name="${name}" type="text" value="${esc(value || '')}" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore data-form-type="other"${numericAttrs} />
      ${help ? `<p class="field-help">${help}</p>` : ''}
    </div>`;
}

// Invisible (but present-in-DOM, not display:none) decoy username/password
// pair — the classic, documented mitigation for browsers that fill a text+
// password pair regardless of autocomplete hints. Placed first in the form
// so it, not the real fields, is whatever the browser's heuristic targets.
// Excluded by name from the real payload (see readFormFields).
function autofillDecoy() {
  return `
    <div aria-hidden="true" style="position:absolute;width:1px;height:1px;overflow:hidden;left:-9999px">
      <input type="text" name="username" autocomplete="username" tabindex="-1" />
      <input type="password" name="password" autocomplete="current-password" tabindex="-1" />
    </div>`;
}

// Reads only the named, expected fields from a form — never a blind
// Object.fromEntries(new FormData(form).entries()), so a decoy or any
// browser-injected extra field can never leak into the JSON sent to the server.
function readFormFields(form, names) {
  const payload = {};
  for (const name of names) {
    payload[name] = form.elements.namedItem(name)?.value ?? '';
  }
  return payload;
}

function connectionDot(live) {
  return `<span class="dot ${live ? 'green' : ''}"></span>`;
}

route('#/integrations', 'Providers & Legacy API', 'AI provider credentials, plus the optional Meta Cloud API path kept for reference. The active WhatsApp channel is the QR-linked device.', async (view) => {
  async function draw() {
    const [waStatus, aiConfig, credentials] = await Promise.all([
      api('/api/dashboard/whatsapp/status'),
      api('/api/dashboard/ai'),
      api('/api/dashboard/credentials'),
    ]);
    const openRouterSaved = credentials.OPENROUTER_API_KEY?.source !== 'unset';
    const openRouterConnected = credentials.OPENROUTER_API_KEY?.lastCheckOk === true;
    const aiChipLabel = openRouterConnected ? 'CONNECTED' : openRouterSaved ? 'NOT CONNECTED' : 'NOT CONFIGURED';
    const waLive = waStatus.syncStatus === 'live';

    const statusLabel = { not_configured: 'Not configured', saved: 'Configuration saved', live: 'Connected — LIVE', failed: 'Connection failed' }[
      waStatus.syncStatus
    ] || 'Not configured';
    const statusTone = { not_configured: 'muted', saved: 'amber', live: 'green', failed: 'red' }[waStatus.syncStatus] || 'muted';

    view.innerHTML = `
      <section class="summary-row">
        <div class="summary-chip">
          <span class="summary-name">Meta Cloud API (legacy)</span>
          ${badge(waLive ? 'LIVE' : 'NOT CONNECTED', waLive ? 'green' : 'muted')}
        </div>
        <div class="summary-chip">
          <span class="summary-name">AI</span>
          ${badge(aiChipLabel, openRouterConnected ? 'green' : 'muted')}
        </div>
      </section>

      <section class="panel setup-card">
        <p class="eyebrow">LEGACY · META CLOUD API (NOT THE ACTIVE CHANNEL)</p><h3>Business API connection</h3><p class="muted">Kept for reference only. Customer messaging runs through the <a href="#/whatsapp">QR-linked WhatsApp session</a>; nothing here is required for it.</p>
        <p class="muted">Enter your production WhatsApp Business details below, save, then click Sync WhatsApp to verify the connection with Meta.</p>

        <form id="wa-form" autocomplete="off">
          ${autofillDecoy()}
          ${textField('wabaId', 'WhatsApp Business Account ID (WABA ID)', 'Numbers only, from Meta Business Manager → WhatsApp Accounts.', waStatus.wabaId, { numeric: true })}
          ${textField('phoneNumberId', 'Phone Number ID', 'Numbers only, from Meta → WhatsApp → API Setup, for the number you are sending from.', waStatus.phoneNumberId, { numeric: true })}
          ${pwField('accessToken', 'Access Token', 'A permanent System User token with WhatsApp messaging permission.', waStatus.configured.accessToken)}
          ${pwField('verifyToken', 'Verify Token', 'A value you choose — enter the same value in Meta\'s webhook setup.', waStatus.configured.verifyToken)}
          ${pwField('appSecret', 'Meta App Secret', 'From Meta App → Settings → Basic. Used to verify incoming webhook signatures.', waStatus.configured.appSecret)}
          ${textField('webhookUrl', 'Webhook URL', `The public HTTPS URL you register with Meta as the Callback URL. This application always answers at ${esc(waStatus.actualWebhookRoute)}.`, waStatus.webhookUrl)}

          <div class="toolbar" style="margin-top:8px">
            <button type="submit" class="btn primary">Save Configuration</button>
            <button type="button" id="wa-sync" class="btn">Sync WhatsApp</button>
          </div>
        </form>

        <div class="status-line">
          ${connectionDot(waLive)}
          <span class="badge ${statusTone}">${statusLabel}</span>
          ${waStatus.wabaName || waStatus.displayPhoneNumber ? `<span class="muted">${esc([waStatus.wabaName, waStatus.displayPhoneNumber].filter(Boolean).join(' · '))}</span>` : ''}
          ${waStatus.lastSyncAt ? `<span class="muted">Last checked ${formatDate(waStatus.lastSyncAt)}</span>` : ''}
        </div>
        ${waStatus.lastSyncDetail ? `<p class="muted" style="margin-top:4px">${esc(waStatus.lastSyncDetail)}</p>` : ''}
      </section>

      <section class="panel setup-card ai-card" style="margin-top:16px">
        <h3>AI</h3>
        <p class="muted">Your OpenRouter API key powers the assistant's replies.</p>
        <form id="ai-form" autocomplete="off">
          ${autofillDecoy()}
          ${pwField('apiKey', 'OpenRouter API Key', null, openRouterSaved)}
          ${textField('model', 'Model', 'Default: openrouter/free — a free model, no payment method needed.', aiConfig.model)}
          <div class="toolbar" style="margin-top:8px">
            <button type="submit" class="btn primary">Save &amp; Test AI</button>
          </div>
        </form>
        <div id="ai-result" class="muted" style="font-size:12px"></div>
      </section>

      <details class="panel setup-card" style="margin-top:16px">
        <summary><h3 style="display:inline">Optional integrations</h3></summary>
        <p class="muted" style="margin-top:10px">Google Calendar is optional. Leave it unconfigured to keep booking replies informational-only.</p>
        ${OPTIONAL_CREDENTIAL_GROUPS.map(
          (group) => `
          ${group.keys
            .map((key) => {
              const info = credentials[key] || { source: 'unset', masked: null };
              return `
              <div class="detail-grid" data-key="${key}" style="margin-top:14px">
                <label class="muted">${esc(key)}</label>
                <div>
                  <span class="file">${info.masked ? esc(info.masked) : 'not set'}</span>
                  ${badge(info.source, info.source === 'override' ? 'blue' : info.source === 'env' ? 'green' : 'muted')}
                </div>
                <span></span>
                <div class="toolbar" style="margin:6px 0">
                  <input type="password" class="cred-input" placeholder="Enter new value…" style="min-width:260px" />
                  <button type="button" class="btn small cred-save">Save</button>
                  <button type="button" class="btn small cred-test">Test connection</button>
                  <button type="button" class="btn small cred-clear" ${info.source !== 'override' ? 'disabled' : ''}>Clear override</button>
                </div>
                <span></span>
                <div class="cred-result muted" style="font-size:12px"></div>
              </div>`;
            })
            .join('')}`,
        ).join('')}
      </details>`;

    view.querySelectorAll('.pw-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = view.querySelector(`#${btn.dataset.for}`);
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        btn.textContent = showing ? 'Show' : 'Hide';
      });
    });

    view.querySelector('#wa-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = readFormFields(e.target, ['wabaId', 'phoneNumberId', 'accessToken', 'verifyToken', 'appSecret', 'webhookUrl']);
      try {
        await api('/api/dashboard/whatsapp/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Configuration saved', 'success');
        await draw();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    view.querySelectorAll('input[inputmode="numeric"]').forEach((input) => {
      input.addEventListener('input', () => {
        const digitsOnly = input.value.replace(/\D/g, '');
        if (digitsOnly !== input.value) input.value = digitsOnly;
      });
    });

    view.querySelector('#wa-sync').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Syncing…';
      try {
        const res = await api('/api/dashboard/whatsapp/sync', { method: 'POST' });
        toast(res.ok ? 'WhatsApp Connected — LIVE' : `Sync failed: ${res.detail}`, res.ok ? 'success' : 'error');
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        await draw();
      }
    });

    view.querySelector('#ai-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = readFormFields(e.target, ['apiKey', 'model']);
      const result = view.querySelector('#ai-result');
      result.textContent = 'Testing…';
      try {
        const res = await api('/api/dashboard/ai/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast(res.ok ? 'AI configured and connected' : 'Saved — connection test failed', res.ok ? 'success' : 'error');
        await draw();
        const newResult = view.querySelector('#ai-result');
        newResult.textContent = res.detail;
        newResult.style.color = res.ok ? '#0e8f68' : '#c0453f';
      } catch (error) {
        result.textContent = error.message;
      }
    });

    view.querySelectorAll('[data-key]').forEach((row) => {
      const key = row.dataset.key;
      const input = row.querySelector('.cred-input');
      const result = row.querySelector('.cred-result');

      row.querySelector('.cred-save').addEventListener('click', async () => {
        if (!input.value) {
          result.textContent = 'Enter a value first.';
          return;
        }
        try {
          await api(`/api/dashboard/credentials/${key}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: input.value }),
          });
          toast(`${key} saved`, 'success');
          await draw();
        } catch (error) {
          result.textContent = error.message;
        }
      });

      row.querySelector('.cred-test').addEventListener('click', async () => {
        result.textContent = 'Testing…';
        try {
          const res = await api(`/api/dashboard/credentials/${key}/test`, { method: 'POST' });
          result.textContent = res.detail;
          result.style.color = res.ok ? '' : '#c0453f';
        } catch (error) {
          result.textContent = error.message;
        }
      });

      row.querySelector('.cred-clear').addEventListener('click', async () => {
        try {
          await api(`/api/dashboard/credentials/${key}`, { method: 'DELETE' });
          toast(`${key} override cleared`, 'success');
          await draw();
        } catch (error) {
          result.textContent = error.message;
        }
      });
    });
  }
  await draw();
});

// ---------------------------------------------------------------------
// System
// ---------------------------------------------------------------------

route('#/system', 'System', 'Live process and dependency status.', async (view) => {
  const data = await api('/api/dashboard/system');
  view.innerHTML = `
    <section class="panel">
      <dl class="detail-grid">
        <dt>Environment</dt><dd>${esc(data.environment)}</dd>
        <dt>Provider mode</dt><dd>${data.providerMode === 'mock' ? badge('Mock', 'green') : badge('Production', 'blue')}</dd>
        <dt>Process uptime</dt><dd>${data.uptimeSeconds}s</dd>
        <dt>Node.js version</dt><dd class="file">${esc(data.nodeVersion)}</dd>
        <dt>Database file</dt><dd class="file">${esc(data.databasePath)}</dd>
        <dt>Database reachable</dt><dd>${data.databaseReachable ? badge('Yes', 'green') : badge('No', 'red')}</dd>
        <dt>Knowledge files available</dt><dd>${data.knowledgeFilesAvailable} / ${data.knowledgeFilesTotal}</dd>
      </dl>
      <div class="toolbar"><a class="btn" href="/health" target="_blank" rel="noopener">Open /health</a><a class="btn" href="/readiness" target="_blank" rel="noopener">Open /readiness</a></div>
    </section>`;
});

// ---------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------

route('#/logs', 'Logs', '', async (view) => {
  view.innerHTML = `
    <section class="panel">
      ${emptyView('Detailed request/error logs are not exposed to the browser for security reasons — they can contain internal request metadata. View them on the server with: docker compose logs -f app (or the terminal running npm run dev).')}
    </section>`;
});

// ---------------------------------------------------------------------
// Settings (read-only, clearly separated from secrets)
// ---------------------------------------------------------------------

route('#/settings', 'Settings', 'Business-facing configuration — editable here, or falls back to the server .env when not set.', async (view) => {
  function overrideHint(field, overrides) {
    return overrides[field]
      ? `<button type="button" class="btn small reset-field" data-field="${field}">Reset to env default</button>`
      : `<span class="muted" style="font-size:11px">using env default</span>`;
  }

  async function draw() {
    const data = await api('/api/dashboard/settings');
    const o = data.overrides;
    view.innerHTML = `
      <section class="panel">
        <form id="settings-form">
          <h3>Business</h3>
          <div class="detail-grid">
            <label class="muted">Name</label><div><input name="businessName" value="${esc(data.business.name)}" /> ${overrideHint('businessName', o)}</div>
            <label class="muted">Timezone</label><div><input name="businessTimezone" value="${esc(data.business.timezone)}" /> ${overrideHint('businessTimezone', o)}</div>
            <label class="muted">Hours start</label><div><input name="businessHoursStart" value="${esc(data.business.hoursStart)}" placeholder="09:00" /> ${overrideHint('businessHoursStart', o)}</div>
            <label class="muted">Hours end</label><div><input name="businessHoursEnd" value="${esc(data.business.hoursEnd)}" placeholder="18:00" /> ${overrideHint('businessHoursEnd', o)}</div>
            <label class="muted">Open days (1=Mon..7=Sun, comma-separated)</label><div><input name="businessDays" value="${data.business.days.join(', ')}" /> ${overrideHint('businessDays', o)}</div>
          </div>
          <h3>Booking</h3>
          <div class="detail-grid">
            <label class="muted">Default duration (min)</label><div><input type="number" name="bookingDurationMinutes" value="${data.booking.durationMinutes}" /> ${overrideHint('bookingDurationMinutes', o)}</div>
            <label class="muted">Buffer (min)</label><div><input type="number" name="bookingBufferMinutes" value="${data.booking.bufferMinutes}" /> ${overrideHint('bookingBufferMinutes', o)}</div>
          </div>
          <h3>Agent</h3>
          <div class="detail-grid">
            <label class="muted">Restart keywords (comma-separated)</label><div><input name="restartKeywords" value="${data.agent.restartKeywords.join(', ')}" /> ${overrideHint('restartKeywords', o)}</div>
            <label class="muted">Conversation history limit</label><div><input type="number" name="conversationHistoryLimit" value="${data.agent.conversationHistoryLimit}" /> ${overrideHint('conversationHistoryLimit', o)}</div>
          </div>
          <h3>Customer-facing content</h3>
          <div class="detail-grid">
            <label class="muted">Welcome message</label><div><textarea name="welcomeMessage" rows="2">${esc(data.content.welcomeMessage || '')}</textarea> ${overrideHint('welcomeMessage', o)}</div>
            <label class="muted">Fallback message</label><div><textarea name="fallbackMessage" rows="2">${esc(data.content.fallbackMessage || '')}</textarea> ${overrideHint('fallbackMessage', o)}</div>
            <label class="muted">Cancellation policy</label><div><textarea name="cancellationPolicy" rows="3">${esc(data.content.cancellationPolicy || '')}</textarea> ${overrideHint('cancellationPolicy', o)}</div>
            <label class="muted">Human escalation info</label><div><textarea name="humanEscalationInfo" rows="2">${esc(data.content.humanEscalationInfo || '')}</textarea> ${overrideHint('humanEscalationInfo', o)}</div>
            <label class="muted">Supported languages (comma-separated)</label><div><input name="supportedLanguages" value="${data.content.supportedLanguages.join(', ')}" /> ${overrideHint('supportedLanguages', o)}</div>
          </div>
          <div id="settings-error" class="form-error" hidden></div>
          <div class="toolbar">
            <button type="submit" class="btn primary">Save</button>
            <button type="button" id="cancel" class="btn">Cancel</button>
          </div>
        </form>
        <h3>Server (env-only — requires editing .env and a restart)</h3>
        <dl class="detail-grid">
          <dt>Rate limit</dt><dd>${data.security.rateLimitPerMinute} requests / minute</dd>
          <dt>Max request body size</dt><dd>${esc(data.security.maxBodySize)}</dd>
        </dl>
        <h3>Security</h3>
        <p class="muted">If you suspect a dashboard session or device was compromised, revoke every active session at once — everyone, including you, will need to log in again.</p>
        <div class="toolbar">
          <button type="button" id="logout-all" class="btn">Log out everywhere</button>
        </div>
      </section>`;

    const form = view.querySelector('#settings-form');
    const errorBox = view.querySelector('#settings-error');

    view.querySelector('#cancel').addEventListener('click', () => draw());

    view.querySelector('#logout-all').addEventListener('click', async () => {
      if (!confirm('This will log out every active dashboard session, including this one. Continue?')) return;
      try {
        await api('/api/dashboard/auth/logout-all', { method: 'POST' });
      } finally {
        location.hash = '#/login';
        location.reload();
      }
    });

    view.querySelectorAll('.reset-field').forEach((btn) => {
      btn.addEventListener('click', async () => {
        errorBox.hidden = true;
        try {
          await api('/api/dashboard/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [btn.dataset.field]: null }),
          });
          toast('Reset to env default', 'success');
          await draw();
        } catch (error) {
          errorBox.hidden = false;
          errorBox.textContent = error.message;
        }
      });
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.hidden = true;
      const raw = Object.fromEntries(new FormData(form).entries());
      const patch = {
        businessName: raw.businessName,
        businessTimezone: raw.businessTimezone,
        businessHoursStart: raw.businessHoursStart,
        businessHoursEnd: raw.businessHoursEnd,
        businessDays: raw.businessDays,
        bookingDurationMinutes: Number(raw.bookingDurationMinutes),
        bookingBufferMinutes: Number(raw.bookingBufferMinutes),
        restartKeywords: raw.restartKeywords,
        conversationHistoryLimit: Number(raw.conversationHistoryLimit),
        welcomeMessage: raw.welcomeMessage || null,
        fallbackMessage: raw.fallbackMessage || null,
        cancellationPolicy: raw.cancellationPolicy || null,
        humanEscalationInfo: raw.humanEscalationInfo || null,
        supportedLanguages: raw.supportedLanguages || null,
      };
      try {
        await api('/api/dashboard/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        toast('Settings saved', 'success');
        await draw();
      } catch (error) {
        errorBox.hidden = false;
        errorBox.textContent = error.fields
          ? Object.entries(error.fields).map(([field, msg]) => `${field}: ${msg}`).join('; ')
          : error.message;
      }
    });
  }

  await draw();
});

// ---------------------------------------------------------------------
// Project Sync / AI Collaboration
// ---------------------------------------------------------------------

route('#/project-sync', 'Project Sync', 'Multi-AI coordination state, read directly from .project-sync.', async (view) => {
  const data = await api('/api/dashboard/project-sync');
  if (!data.available) {
    view.innerHTML = `<section class="panel">${emptyView('No .project-sync coordination state found in this repository.')}</section>`;
    return;
  }
  view.innerHTML = `
    <section class="panel">
      <h3>Writer lock</h3>
      ${
        data.writer
          ? `<dl class="detail-grid"><dt>Held by</dt><dd>${esc(data.writer.agent)}</dd><dt>Session</dt><dd class="file">${esc(data.writer.session)}</dd><dt>Task</dt><dd>${esc(data.writer.task || '—')}</dd></dl>`
          : emptyView('No active writer — the repository is unlocked.')
      }
      <h3>Last handoff</h3>
      <dl class="detail-grid">
        <dt>File</dt><dd class="file">${esc(data.lastHandoffPath || '—')}</dd>
        <dt>Changed files</dt><dd>${data.changedFileCount != null ? data.changedFileCount : '—'}</dd>
      </dl>
      <p class="muted"><strong>Summary:</strong> ${esc(data.lastHandoffSummary || '—')}</p>
      <p class="muted"><strong>Tests recorded:</strong> ${esc(data.lastHandoffTests || '—')}</p>
      <p class="muted"><strong>Next steps recorded:</strong> ${esc(data.lastHandoffNextSteps || '—')}</p>
      <p class="muted">This page only reads existing coordination files — it cannot acquire, release, or bypass the writer lock.</p>
    </section>`;
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

boot();
