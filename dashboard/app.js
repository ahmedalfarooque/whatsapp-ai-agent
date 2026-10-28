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
    // The local window (scripts/dev-proxy.cjs) refuses production writes with a plain-language reason in `message`: show that, not the bare code.
    const message = (body && (body.error === 'blocked_by_local_window' || body.error === 'cross_origin_blocked') && body.message) || (body && body.error) || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
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
  syncTopbarForRoute(topLevelKey);

  document.querySelector('#page-title').textContent = matched.route.title;
  document.querySelector('#page-subtitle').textContent = matched.route.subtitle || '';
  // The server refuses these requests anyway; this shows a clear page instead of a failed load.
  if (hash !== '#/login' && me && topLevelKey === '#/' && !routeAllowed('#/')) {
    // A user without the dashboard permission lands on the first page they may open instead of an error.
    const first = [...document.querySelectorAll('#nav a[data-route]')].find((a) => !a.hidden && a.dataset.route !== '#/' && a.dataset.route !== '#/accounts');
    if (first) { location.hash = first.dataset.route; return; }
  }
  if (hash !== '#/login' && me && !routeAllowed(topLevelKey)) {
    view.innerHTML = `<div class="state-block restricted"><h2>Access restricted</h2><p>Your role does not include this page for the selected WhatsApp account. Ask an administrator if you need it.</p><a class="btn" href="#/">Back to the dashboard</a></div>`;
    return;
  }
  view.innerHTML = loadingView();
  try {
    await matched.route.render(view, matched.params);
  } catch (error) {
    view.innerHTML = errorView(error.message, renderRoute);
  }
}

// A language switch re-renders the open page so dates, numbers and generated text follow the new language — unless the page holds
// edits that were not saved yet (those are never thrown away by a language change; the text on screen is translated in place).
document.addEventListener('workspace:lang', () => {
  if (document.body.classList.contains('auth-page') || !me) return;
  const view = document.querySelector('#view');
  if (view && /Unsaved changes|تغييرات غير محفوظة/.test(view.textContent || '')) return;
  renderRoute();
});

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
    const identity = accountIdentityModel(a, (window.I18N && window.I18N.lang) || 'en', info.label);
    return `<button type="button" class="account-item ${active ? 'active' : ''} ${a.enabled ? '' : 'off'}" data-account="${a.id}" data-status="${esc(a.uiStatus || '')}" title="${esc(a.name)} · ${esc(info.label)}" aria-pressed="${active}">
      ${identity ? accountAvatarHtml(identity, 'list-av') : ''}<span class="dot ${info.dot}"></span>
      <span class="account-text"><span class="account-name" dir="auto">${esc(a.name)}</span><small>${a.phoneNumber ? `<span class="acct-num" dir="ltr">${esc(a.phoneNumber)}</span>` : ''}<span class="acct-state ${info.dot}">${esc(info.label)}</span></small></span>
    </button>`;
  }).join('');
  host.querySelectorAll('[data-account]').forEach((btn) => btn.addEventListener('click', () => selectAccount(Number(btn.dataset.account))));
  armAvatarFallback(host);
  const chip = document.querySelector('#account-chip');
  const current = currentAccount();
  if (chip) {
    chip.hidden = !current;
    if (current) document.querySelector('#account-chip-name').textContent = current.name;
  }
  if (typeof renderAccountIdentity === 'function') renderAccountIdentity(); // top-bar logo + name line (one shared component, see branding.js)
}

/** Loads the accounts the signed-in admin may see and settles the selection (remembered id when still valid, else the server default). */
const liveSync = { lastOkAt: 0, failures: 0, lastSnapshotAt: '', signature: '', timer: null };
function renderSyncStatus() {
  const el = document.querySelector('#sync-status');
  if (!el) return;
  const label = window.UiKit.syncLabel({ ...liveSync, hidden: document.hidden });
  el.textContent = window.I18N && window.I18N.t ? window.I18N.t(label.text) : label.text;
  el.dataset.tone = label.tone;
  el.title = liveSync.lastOkAt ? `Accounts and connection states are re-read from the server every 10 s while this tab is visible (60 s hidden). Last successful sync: ${new Date(liveSync.lastOkAt).toLocaleTimeString()}` : '';
}
async function loadAccounts() {
  try {
    const data = await api('/api/dashboard/accounts');
    // A slow response from an earlier poll must never overwrite a newer snapshot.
    if (!window.UiKit.isNewerSnapshot(liveSync.lastSnapshotAt, data.generatedAt)) return;
    liveSync.lastSnapshotAt = data.generatedAt || liveSync.lastSnapshotAt;
    liveSync.lastOkAt = Date.now();
    liveSync.failures = 0;
    const previousIds = knownAccounts.map((a) => a.id).join(',');
    const signature = window.UiKit.accountsSignature(data.accounts || []);
    const changed = signature !== liveSync.signature;
    liveSync.signature = signature;
    knownAccounts = data.accounts || [];
    registerAccountNames(knownAccounts);
    // The accounts this user may open changed (access granted or revoked): re-read who they are, so permissions and branding never go stale.
    const assignmentChanged = previousIds !== '' && previousIds !== knownAccounts.map((a) => a.id).join(',');
    const valid = knownAccounts.some((a) => a.id === selectedAccountId);
    if (!valid) {
      selectedAccountId = data.selected || (knownAccounts[0] ? knownAccounts[0].id : null);
      try { if (selectedAccountId) localStorage.setItem(ACCOUNT_STORAGE_KEY, String(selectedAccountId)); } catch { /* storage unavailable */ }
    }
    renderAccountList();
    renderSyncStatus();
    if (assignmentChanged) loadMe().catch(() => {}).finally(() => renderRoute());
    document.dispatchEvent(new CustomEvent('workspace:accounts', { detail: { accounts: knownAccounts, selected: selectedAccountId, changed } }));
  } catch (error) {
    // The list already on screen stays (it is the last known truth); the footer says the sync is failing and the retry backs off.
    liveSync.failures += 1;
    renderSyncStatus();
    const host = document.querySelector('#account-list');
    if (host && !knownAccounts.length) host.innerHTML = `<span class="muted">${esc(error.message)}</span>`;
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
  // Permissions are per account: reload them for the newly selected account before the page is drawn again.
  if (changed) loadMe().catch(() => {}).finally(() => renderRoute());
}

/**
 * Live sync of the account inventory and connection states: bounded polling (10 s visible, 60 s hidden, exponential backoff on failure,
 * immediate refresh when the tab becomes visible again). Through the local production window this is the same loop against production's API,
 * so a new, disabled, renamed, connected or disconnected account shows up within one interval. The footer shows the last sync and any failure.
 */
async function pollAccounts() {
  clearTimeout(liveSync.timer);
  await loadAccounts();
  liveSync.timer = setTimeout(pollAccounts, window.UiKit.syncDelay({ hidden: document.hidden, failures: liveSync.failures }));
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && me) pollAccounts(); });
setInterval(renderSyncStatus, 5000);

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
    // Labels come from /me (non-secret and open to every signed-in user); /status needs the dashboard permission.
    const status = me || (await api('/api/dashboard/me'));
    document.querySelector('#environment').textContent =
      status.environment === 'development' ? 'Development' : status.environment === 'production' ? 'Production' : status.environment;
    document.querySelector('#sidebar-mode').textContent =
      status.providerMode === 'mock' ? 'Signed in · mock providers' : 'Signed in · production providers';
    document.querySelector('#logout-btn').style.display = 'flex';
  } catch {
    document.querySelector('#environment').textContent = 'Unavailable';
  }
}

decorateNav();
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
/**
 * The auth status, or an error when the server (production, through the local window) cannot be reached. A failed or non-JSON answer is NEVER read as
 * "not signed in" or "no administrator yet": that used to turn an unreachable upstream into the first-run "Set up your workspace" screen.
 */
async function authStatus() {
  let response;
  try {
    response = await fetch('/api/dashboard/auth/status', { credentials: 'include', cache: 'no-store' });
  } catch (error) {
    throw new Error(`The application server cannot be reached (${error.message}). Nothing is shown from a cache or a local copy.`);
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try { const body = await response.json(); if (body && (body.message || body.error)) detail = `${body.message || body.error}`; } catch { /* not JSON */ }
    throw new Error(`The application server cannot be reached (${detail}). Nothing is shown from a cache or a local copy.`);
  }
  const status = await response.json();
  if (!status || typeof status.authenticated !== 'boolean') throw new Error('The application server gave an unexpected answer. Nothing is shown from a cache or a local copy.');
  return status;
}

async function boot() {
  let status;
  try {
    status = await authStatus();
  } catch (error) {
    document.querySelector('#view').innerHTML = errorView(error.message, boot);
    return;
  }
  if (!status.authenticated) {
    document.querySelector('#logout-btn').style.display = 'none';
    if (location.hash !== '#/login') location.hash = '#/login';
    await renderRoute();
    return;
  }
  if (location.hash === '#/login') location.hash = '#/';
  await loadAccounts(); // settles the selected account before any account-scoped request
  try {
    await loadMe(); // who is signed in and what they may open on this account
  } catch (error) {
    document.querySelector('#view').innerHTML = errorView(error.message, boot);
    return;
  }
  await loadHeader();
  document.dispatchEvent(new Event('workspace:authenticated'));
  // The accounts were just loaded by boot; the live sync continues from here (10 s visible / 60 s hidden, see pollAccounts).
  clearTimeout(liveSync.timer);
  liveSync.timer = setTimeout(pollAccounts, window.UiKit.syncDelay({ hidden: document.hidden, failures: 0 }));
  await renderRoute();
}

// ---------------------------------------------------------------------
// Login / first-run admin setup
// ---------------------------------------------------------------------

async function renderLogin(view) {
  let status;
  try {
    status = await authStatus();
  } catch (error) {
    view.innerHTML = errorView(error.message, () => renderRoute());
    return;
  }
  const isSetup = !status.hasAdmin;

  const ICON = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M3 3l18 18M10.6 10.6A3 3 0 0 0 13.4 13.4M9.9 5.2A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.1 6.1A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.1-.9"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  };
  const svg = (name) => `<svg class="lg-ico" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

  view.innerHTML = `
    <div class="lg">
      <section class="lg-brand" aria-label="SYNRTECHS AI Workspace">
        <svg class="lg-geo" viewBox="0 0 600 800" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
          <!-- three sheared slabs on the 30° angle of the S mark: a quiet echo of the logo, never a copy of it -->
          <polygon points="150,470 640,188 640,338 330,520" fill="#ffffff" fill-opacity=".045"/>
          <polygon points="290,560 480,452 640,562 450,672" fill="#6941e2" fill-opacity=".34"/>
          <polygon points="200,690 640,436 640,586 380,736" fill="#ffffff" fill-opacity=".045"/>
          <path d="M150 470L640 188" stroke="#27e6c5" stroke-opacity=".55" stroke-width="1.5" fill="none"/>
          <path d="M380 736L640 586" stroke="#27e6c5" stroke-opacity=".30" stroke-width="1.5" fill="none"/>
        </svg>
        <div class="lg-brand-in">
          <div class="lg-mark"><img class="lg-wordmark" src="/dashboard/assets/developer/synrtechs-logo-white.svg" alt="SYNRTECHS" width="260" height="48"><small>AI WORKSPACE</small></div>
          <div class="lg-hero">
            <h2>A better conversation.<br><em>A closer connection.</em></h2>
            <p>One workspace for your WhatsApp conversations, customer care, and appointments.</p>
            <ul class="lg-points">
              <li><span class="lg-pt">${svg('chat')}</span><div><b>Every conversation in one place</b><small>Menu replies, the AI assistant and your team, together</small></div></li>
              <li><span class="lg-pt">${svg('users')}</span><div><b>Customers and quotations</b><small>History, inquiry carts, documents and status tracking</small></div></li>
              <li><span class="lg-pt">${svg('doc')}</span><div><b>Reports you can trust</b><small>Clear figures that open the records behind them</small></div></li>
              <li><span class="lg-pt">${svg('shield')}</span><div><b>Secure access</b><small>Role-based permissions on every action</small></div></li>
            </ul>
          </div>
          <small class="lg-copy">Your business. Your conversations. One clear view.</small>
        </div>
      </section>
      <section class="lg-form">
        <div class="lg-top"><div class="theme-slot" data-theme-switch></div><div class="lang-slot" data-lang-switch></div></div>
        <div class="auth-card lg-card">
          <span class="wm lg-wm"><img class="wm-light" src="/dashboard/assets/developer/synrtechs-logo.svg" alt="SYNRTECHS" width="180" height="33"><img class="wm-dark" src="/dashboard/assets/developer/synrtechs-logo-white.svg" alt="SYNRTECHS" width="180" height="33"></span>
          <p class="lg-brandname"><span>AI WORKSPACE</span></p>
          <h3>${isSetup ? 'Set up your workspace' : 'Welcome back'}</h3>
          <p class="muted lg-sub">${isSetup ? 'Create an administrator account to get started.' : 'Sign in to manage your AI assistant.'}</p>
          <form id="auth-form" novalidate>
            <div class="lg-field">
              <label for="username">${isSetup ? 'Username' : 'Username or email'}</label>
              <div class="lg-input">${svg('user')}<input id="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required dir="ltr" /></div>
            </div>
            <div class="lg-field">
              <label for="password">Password${isSetup ? ' (min 12 characters)' : ''}</label>
              <div class="lg-input">${svg('lock')}<input id="password" type="password" autocomplete="${isSetup ? 'new-password' : 'current-password'}" ${isSetup ? 'minlength="12"' : ''} required dir="ltr" /><button type="button" id="show-password" class="lg-eye" aria-controls="password" aria-pressed="false" aria-label="Show password" title="Show password">${svg('eye')}</button></div>
            </div>
            <div id="auth-error" class="form-error" role="alert" hidden></div>
            <button type="submit" class="lg-submit"><span class="lg-spin" aria-hidden="true"></span><span class="lg-submit-text">${isSetup ? 'Create account & sign in' : 'Sign in'}</span>${svg('arrow')}</button>
          </form>
          <p class="auth-footnote">Secure administrator access</p>
        </div>
      </section>
    </div>`;
  if (window.I18N) window.I18N.mountSwitches();
  mountThemeSwitches();

  view.querySelector('#show-password').addEventListener('click', (event) => {
    const input = view.querySelector('#password');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    const button = event.currentTarget;
    button.setAttribute('aria-pressed', String(reveal));
    button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    button.setAttribute('title', reveal ? 'Hide password' : 'Show password');
    button.innerHTML = svg(reveal ? 'eyeoff' : 'eye');
  });

  // Second sign-in step: the password was accepted, the session exists only after the emailed code is verified.
  // The challenge token stays in this closure — never in storage, never in the URL.
  function renderOtpStep(info) {
    const challenge = info.challenge;
    const card = view.querySelector('.auth-card');
    let timer = null;
    card.innerHTML = `
      <span class="wm lg-wm"><img class="wm-light" src="/dashboard/assets/developer/synrtechs-logo.svg" alt="SYNRTECHS" width="180" height="33"><img class="wm-dark" src="/dashboard/assets/developer/synrtechs-logo-white.svg" alt="SYNRTECHS" width="180" height="33"></span><p class="eyebrow">CHECK YOUR EMAIL</p>
      <h3>Enter your verification code</h3>
      <p class="muted">We sent a 6-digit code to <span class="otp-sent">${esc(info.email || 'your email address')}</span>. It expires in 10 minutes and can be used once.</p>
      <form id="otp-form" autocomplete="off">
        <label class="muted" for="otp-code">Verification code</label>
        <input id="otp-code" class="otp-input" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" spellcheck="false" required />
        <div id="otp-error" class="form-error" hidden></div>
        <button type="submit" class="lg-submit"><span class="lg-spin" aria-hidden="true"></span><span class="lg-submit-text">Verify &amp; sign in</span></button>
      </form>
      <div class="otp-actions"><button type="button" id="otp-resend" class="btn">Resend code</button><button type="button" id="otp-back" class="btn ghost">Back</button></div>
      <p class="auth-footnote">Did not get it? Check your spam folder, or resend once the timer ends.</p>`;
    const codeInput = card.querySelector('#otp-code');
    const otpError = card.querySelector('#otp-error');
    const resendBtn = card.querySelector('#otp-resend');
    const showError = (message) => { otpError.hidden = false; otpError.textContent = message; };
    const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
    const startCooldown = (seconds) => {
      stopTimer();
      let left = seconds;
      const tick = () => {
        if (left <= 0) { stopTimer(); resendBtn.disabled = false; resendBtn.textContent = 'Resend code'; return; }
        resendBtn.disabled = true; resendBtn.textContent = `Resend code (${left}s)`; left -= 1;
      };
      tick();
      timer = setInterval(tick, 1000);
    };
    const backToPassword = async () => {
      stopTimer();
      try { await fetch('/api/dashboard/auth/otp/cancel', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge }) }); } catch { /* best effort */ }
      await renderLogin(view);
    };
    codeInput.focus();
    startCooldown(60);

    card.querySelector('#otp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      otpError.hidden = true;
      const submit = card.querySelector('[type=submit]');
      submit.disabled = true;
      try {
        const res = await fetch('/api/dashboard/auth/otp/verify', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge, code: codeInput.value.replace(/\D/g, '') }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          showError(body.error || (res.status === 429 ? 'Too many attempts. Please wait a few minutes and try again.' : `Verification failed (HTTP ${res.status}).`));
          if (body.code === 'locked' || res.status === 429) { setTimeout(backToPassword, 1800); }
          codeInput.select();
          return;
        }
        stopTimer();
        location.hash = '#/';
        await boot();
      } catch {
        showError('Could not reach the server.');
      } finally {
        submit.disabled = false;
      }
    });
    resendBtn.addEventListener('click', async () => {
      otpError.hidden = true;
      resendBtn.disabled = true;
      try {
        const res = await fetch('/api/dashboard/auth/otp/resend', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          showError(body.error || (res.status === 429 ? 'Too many code requests. Please wait a few minutes and try again.' : `Could not resend the code (HTTP ${res.status}).`));
          if (res.status === 410) { setTimeout(backToPassword, 1800); return; }
          startCooldown(Number(res.headers.get('Retry-After')) || 60);
          return;
        }
        startCooldown(60);
      } catch {
        showError('Could not reach the server.');
        resendBtn.disabled = false;
      }
    });
    card.querySelector('#otp-back').addEventListener('click', backToPassword);
  }

  const errorBox = view.querySelector('#auth-error');
  view.querySelector('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    const submit = view.querySelector('[type=submit]');
    if (submit.disabled) return;
    submit.disabled = true;
    submit.classList.add('loading');
    submit.setAttribute('aria-busy', 'true');
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
        errorBox.textContent = body.error || (res.status === 429 ? 'Too many sign-in attempts. Please wait a few minutes and try again.' : `Sign-in failed (HTTP ${res.status}).`);
        return;
      }
      if (body.otpRequired && body.challenge) {
        // No session yet — the server only sets the cookie after the emailed code is verified.
        renderOtpStep(body);
        return;
      }
      location.hash = '#/';
      await boot();
    } catch {
      errorBox.hidden = false;
      errorBox.textContent = 'Could not reach the server.';
    } finally {
      submit.disabled = false;
      submit.classList.remove('loading');
      submit.removeAttribute('aria-busy');
    }
  });
}
route('#/login', 'Sign in', '', renderLogin);

// ---------------------------------------------------------------------
// Customers: the directory, the customer profile and Customer Reports live in pages-customers.js
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Conversations (the unified inbox: see pages-inbox.js)
// ---------------------------------------------------------------------

// Conversations: the unified inbox (list, search, filters, workspace) lives in pages-inbox.js; the pure logic in inbox-core.js.

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
              `<tr><td class="file">${esc(f.name)}${knowledgeHint(f)}</td><td>${knowledgeBadge(f)}</td><td>${f.sizeBytes != null ? `${f.sizeBytes} B` : '—'}</td><td>${formatDate(f.modifiedAt)}</td><td><a class="btn small" href="#/knowledge/${encodeURIComponent(f.name)}">${f.exists ? 'View / Edit' : 'Create'}</a></td></tr>`,
          )
          .join('')}
      </tbody></table>
    </section>`;
});

// The status shown here is the file's real state on the server: a file that exists but is empty or malformed is NOT "Available".
function knowledgeBadge(f) {
  if (f.state === 'available') return f.placeholder ? badge('Placeholder', 'amber') : badge('Available', 'green');
  if (f.state === 'missing') return f.optional ? badge('Not created', 'muted') : badge('Missing', 'red');
  if (f.state === 'empty') return badge('Empty', 'amber');
  return badge('Invalid', 'red');
}

function knowledgeHint(f) {
  const text = f.problem || (f.placeholder ? ('Not verified: ' + (f.placeholderReason || 'placeholder content') + '. Edit it to add the real information; the assistant treats it as unknown.') : null) || (f.state === 'missing' ? f.note : null);
  return text ? `<div class="muted small">${esc(text)}</div>` : '';
}

route(/^#\/knowledge\/(?<name>[\w.-]+)$/, 'Knowledge file', '', async (view, params) => {
  const name = decodeURIComponent(params.name);
  let original = '';
  try {
    const data = await api(`/api/dashboard/knowledge/${encodeURIComponent(name)}`);
    original = data.content;
  } catch (error) {
    // Only "does not exist yet" opens an empty editor to create the file. Any other failure must NOT show an empty editor:
    // saving it would overwrite a real file the page merely failed to read.
    if (error.status !== 404) {
      view.innerHTML = `<a class="back-link" href="#/knowledge">← Back to knowledge files</a>${errorView(error.message)}`;
      return;
    }
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
    <div aria-hidden="true" style="position:absolute;width:1px;height:1px;overflow:hidden;inset-inline-start:-9999px;top:0">
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
    // A saved key that cannot be decrypted with the current master key is ignored by the server: say so, and say what to do.
    const aiNeedsKey = credentials.OPENROUTER_API_KEY?.overrideStatus === 'undecryptable' && !openRouterConnected;
    const aiChipLabel = openRouterConnected ? 'CONNECTED' : aiNeedsKey ? 'NEEDS A NEW KEY' : openRouterSaved ? 'NOT CONNECTED' : 'NOT CONFIGURED';
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

      <section id="ai-routing-host" class="panel setup-card ai-card" style="margin-top:16px">${loadingView()}</section>

      <details class="panel setup-card ai-card" style="margin-top:16px">
        <summary><h3 style="display:inline">Advanced — OpenRouter model overrides for this business</h3></summary>
        <p class="muted" style="margin-top:10px">Optional. The built-in OpenRouter key is part of the Default entry above; these fields only choose the models and the reply language this business uses with it.</p>
        ${aiNeedsKey ? '<p class="muted" role="alert" style="color:#c0453f;font-size:13px">The key saved earlier can no longer be read (it was stored under a different master key), so the assistant cannot reply. Enter your OpenRouter key again below and press Save &amp; Test AI.</p>' : ''}
        <form id="ai-form" autocomplete="off">
          ${autofillDecoy()}
          ${pwField('apiKey', 'OpenRouter API Key', null, openRouterSaved)}
          ${textField('model', 'Model for this business', 'Applies to the selected business only; the key above is shared by all of them. Leave the key empty to change only the model. openrouter/free costs nothing but is often rate limited, refused by your OpenRouter privacy settings, or answers empty — for dependable replies name a specific model, for example openai/gpt-4o-mini (paid). Saving tests the model with one tiny request.', aiConfig.model)}
          ${textField('visionModel', 'Vision model (customer pictures)', 'The model that is shown the actual photo a customer sends, so the assistant identifies what is in it (a car, a part, a building) before answering. Leave EMPTY to use this business\'s chat model above (it must accept image input — openai/gpt-4.1-mini does; openrouter/free does NOT and answers 404 to pictures). If the model named here refuses pictures, the chat model is tried once. Saving tests it with one tiny picture.', aiConfig.visionModel)}
          ${textField('replyLanguage', 'Reply language override', 'Leave EMPTY for the shared rule every business uses: the assistant answers in the language of the customer\'s latest message (Arabic, English, Malayalam, Chinese, French, …) and switches when the customer switches. Enter a code such as ar or en only if this business must always reply in that one language.', aiConfig.replyLanguage || '')}
          ${textField('fallbackModels', 'Fallback chat models (comma-separated)', 'Tried ONE at a time, with the same conversation, only when the chat model fails for a model-specific reason (refused, provider error, rate limit, empty answer). After an HTTP 402 (credit exhausted / token cap) only a FREE model (price 0 in the OpenRouter catalog) is tried, once. A rejected key or a network problem is never "solved" by switching. Leave EMPTY to inherit the shared default; enter the word none to disable fallback for this business. Free OpenRouter endpoints are unavailable while the account enforces Zero Data Retention (openrouter.ai/settings/privacy).', aiConfig.fallbackModels || '')}
          ${textField('audioModel', 'Audio model (customer voice notes)', 'The model that is given the actual recording when a customer sends a voice note, so the assistant answers what was said. It must accept audio input (for example google/gemini-2.5-flash, paid). Leave EMPTY and voice notes are not transcribed: the customer is told so and asked to type. Nothing paid is chosen for you.', aiConfig.audioModel || '')}
          <div class="toolbar" style="margin-top:8px">
            <button type="submit" class="btn primary">Save &amp; Test AI</button>
          </div>
        </form>
        <div id="ai-result" class="muted" style="font-size:12px"></div>
      </details>

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
      const payload = readFormFields(e.target, ['apiKey', 'model', 'visionModel', 'replyLanguage', 'audioModel', 'fallbackModels']);
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

    // AI routing (providers, keys, free-only / failover, health, history, charts): its own loader so a slow provider test never blocks this page.
    const routingHost = view.querySelector('#ai-routing-host');
    if (routingHost) void renderAiRouting(routingHost);

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
// AI routing: providers, keys, free-only / failover, health, history, charts (real data from ai_route_log)
// ---------------------------------------------------------------------

const ROUTE_CATEGORY_LABEL = {
  auth: 'key rejected', credit: 'credit / payment required', rate_limited: 'rate limited', policy: 'privacy / data policy', capability: 'capability missing',
  model_unavailable: 'model unavailable', timeout: 'timeout', network: 'unreachable', provider_error: 'provider error', empty: 'empty answer', malformed: 'malformed answer',
  disabled: 'disabled', no_key: 'no key', cooldown: 'cooling down', free_only: 'not free', no_time: 'no time left', limit: 'beyond route limit',
};
const categoryLabel = (c) => ROUTE_CATEGORY_LABEL[c] || c || '';
const categoryTone = (c) => (c === 'auth' || c === 'credit' || c === 'policy' ? 'red' : c === 'rate_limited' || c === 'cooldown' || c === 'timeout' ? 'amber' : c === 'free_only' || c === 'capability' ? 'muted' : '');

function priceBadge(free) {
  if (free === true) return badge('FREE', 'green');
  if (free === false) return badge('PAID', 'red');
  return badge('PRICE UNKNOWN', 'muted');
}

/** A bar chart from hourly buckets: successes (green) and failures (red) stacked, with hover titles. Real data only; empty = says so. */
function routeBarsSvg(hourly) {
  if (!hourly || !hourly.length) return `<p class="muted">No AI route attempts recorded in this window yet.</p>`;
  const max = Math.max(1, ...hourly.map((h) => (h.ok || 0) + (h.failed || 0)));
  const w = 760, h = 150, pad = 24, bw = Math.max(4, Math.floor((w - pad * 2) / hourly.length) - 2);
  const bars = hourly.map((b, i) => {
    const total = (b.ok || 0) + (b.failed || 0);
    const x = pad + i * (bw + 2);
    const okH = Math.round(((b.ok || 0) / max) * (h - pad * 2));
    const failH = Math.round(((b.failed || 0) / max) * (h - pad * 2));
    const label = `${b.hour.replace('T', ' ').replace('Z', ' UTC')}: ${b.ok || 0} ok, ${b.failed || 0} failed${b.avgLatencyMs ? `, avg ${(b.avgLatencyMs / 1000).toFixed(1)} s` : ''}`;
    return `<g><title>${esc(label)}</title><rect x="${x}" y="${h - pad - okH - failH}" width="${bw}" height="${failH}" fill="#c0453f"></rect><rect x="${x}" y="${h - pad - okH}" width="${bw}" height="${okH}" fill="#0e8f68"></rect>${total ? '' : ''}</g>`;
  }).join('');
  const first = hourly[0].hour.slice(5, 16).replace('T', ' ');
  const last = hourly[hourly.length - 1].hour.slice(5, 16).replace('T', ' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="AI route successes and failures per hour"><line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="currentColor" stroke-opacity="0.25"></line>${bars}<text x="${pad}" y="${h - 6}" font-size="10" fill="currentColor" fill-opacity="0.7">${esc(first)} UTC</text><text x="${w - pad}" y="${h - 6}" font-size="10" text-anchor="end" fill="currentColor" fill-opacity="0.7">${esc(last)} UTC</text><text x="${pad}" y="14" font-size="10" fill="currentColor" fill-opacity="0.7">max ${max}/h</text></svg>`;
}

/** Average latency of successful answers per hour as a line. */
function routeLatencySvg(hourly) {
  const points = (hourly || []).filter((b) => b.avgLatencyMs != null);
  if (points.length < 2) return `<p class="muted">Latency appears once at least two hours have successful answers.</p>`;
  const w = 760, h = 120, pad = 24;
  const max = Math.max(1000, ...points.map((p) => p.avgLatencyMs));
  const step = (w - pad * 2) / (points.length - 1);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${(pad + i * step).toFixed(1)},${(h - pad - (p.avgLatencyMs / max) * (h - pad * 2)).toFixed(1)}`).join(' ');
  const dots = points.map((p, i) => `<circle cx="${(pad + i * step).toFixed(1)}" cy="${(h - pad - (p.avgLatencyMs / max) * (h - pad * 2)).toFixed(1)}" r="3" fill="#2f6fed"><title>${esc(`${p.hour.replace('T', ' ')} UTC: ${(p.avgLatencyMs / 1000).toFixed(1)} s`)}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Average AI answer latency per hour"><line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="currentColor" stroke-opacity="0.25"></line><path d="${path}" fill="none" stroke="#2f6fed" stroke-width="2"></path>${dots}<text x="${pad}" y="14" font-size="10" fill="currentColor" fill-opacity="0.7">max ${(max / 1000).toFixed(1)} s</text></svg>`;
}

// Messages waiting for an AI answer, recovered ones and the five-minute escalations (counts only: never a customer's words).
function recoveryHtml(recovery) {
  if (!recovery) return '';
  const m = recovery.messages || {};
  const waiting = (m.awaitingAi || 0) + (m.interrupted || 0) + (m.pending || 0) + (m.replaying || 0);
  const escalations = (recovery.escalations || []).map((e) => `<tr><td>${esc(formatDate(e.at))}</td><td>${esc(e.reason)}</td><td>${e.status === 'open' ? badge('OPEN', 'orange') : badge('CLOSED', 'green')}</td><td>${badge('CALL NOT PLACED', 'gray')} <span class="muted">${esc(e.voiceCallDetail || '')}</span></td></tr>`).join('');
  const voice = recovery.voiceCall || { available: false, blockers: [], alternatives: [] };
  return `<p class="muted" style="font-size:12px">${waiting} waiting for an AI answer · ${m.answeredByReplay || 0} answered after recovery · ${m.needsStaff || 0} left for staff. A waiting message is answered once, only while it is recent and nobody replied.</p>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>When</th><th>Reason</th><th>State</th><th>Voice call</th></tr></thead><tbody>${escalations || `<tr><td colspan="4" class="muted">No escalations.</td></tr>`}</tbody></table></div>
    <p class="muted" style="font-size:12px;margin-top:8px"><b>Automatic voice call: ${voice.available ? 'available' : 'disabled'}.</b> ${(voice.blockers || []).map((b) => esc(b)).join(' ')}</p>
    ${(voice.alternatives || []).length ? `<ul class="muted" style="font-size:12px;margin:4px 0 0 18px">${voice.alternatives.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}`;
}

// ---- compact provider list (the account's "AI providers" card and the Super Admin's shared pool use the same pieces) -----------------------

const AI_DEFAULT_BADGE = { ok: ['ELIGIBLE MODEL TESTED', 'green'], failed: ['LAST TEST FAILED', 'red'], untested: ['NOT TESTED', 'amber'], none: ['NO ELIGIBLE MODEL', 'red'] };
const aiDefaultBadge = (status) => { const s = AI_DEFAULT_BADGE[(status && status.state) || 'none']; return badge(s[0], s[1]); };
const AI_STATE = {
  ok: ['OK', 'green'], failed: ['TEST FAILED', 'red'], untested: ['NOT TESTED', 'muted'], off: ['OFF', 'muted'], no_key: ['NO KEY', 'red'], empty: ['NOT SET UP', 'amber'],
};
const aiStateBadge = (state) => { const s = AI_STATE[state] || AI_STATE.untested; return badge(s[0], s[1]); };
// Per-provider health from the server (facts only: eligibility, cooldown, latest request outcome, a passed test): its badge colour.
// The server writes times as "HH:MM UTC"; the operator sees them in their own time zone (from the exact instant the server also sends).
function localizeHealthTimes(text, health) {
  const iso = health && ((health.cooldown && health.cooldown.nextRetryAt) || health.at);
  const when = iso ? new Date(iso) : null;
  if (!text || !when || Number.isNaN(when.getTime())) return text;
  return text.replace(/\d\d:\d\d UTC/g, when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
}
const AI_HEALTH_TONE = {
  ok: 'green', available: 'green', untested: 'muted', off: 'muted', ineligible: 'amber', cooling: 'amber', rate_limited: 'amber',
  no_key: 'red', config_error: 'red', invalid_credentials: 'red', request_failed: 'red',
};
const aiHealthBadge = (h) => badge(h.label, AI_HEALTH_TONE[h.state] || 'muted');
const shortText = (text, n) => { const t = String(text || ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The two-field form: a recognisable name and the API configuration (a key, or the address of a local runtime). Everything else is under "More options". */
function aiProviderFormHtml(meta, entry) {
  const presets = meta.presets;
  const isNew = !entry;
  const presetOptions = presets.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  return `
    <form class="ai-entry-form" autocomplete="off">
      ${autofillDecoy()}
      <input type="hidden" name="id" value="${entry && entry.id ? entry.id : ''}" />
      <form-meta hidden data-rules="${esc(JSON.stringify(meta.rules || {}))}" data-presets="${esc(JSON.stringify(presets.map((x) => ({ id: x.id, baseUrl: x.baseUrl, autoSelect: Boolean(x.autoSelect), hint: x.hint }))))}"></form-meta>
      ${textField('name', 'API / Agent name (optional)', 'Leave empty and the provider\'s name is used. Only the API key is required: the provider, endpoint and model are detected automatically.', entry ? entry.name : '')}
      <p class="field-help ai-err" data-err="name" style="color:#c0453f" hidden></p>
      ${pwField('config', 'API configuration', isNew ? 'Paste the API key (stored encrypted, shown masked afterwards).' : 'Leave empty to keep the saved configuration, or enter a new one to replace it.', !isNew)}
      <p class="field-help ai-err" data-err="config" style="color:#c0453f" hidden></p>
      <details class="ai-more"><summary>More options (only if the key is not recognised automatically)</summary>
        ${isNew ? `<div class="field"><label for="wa-field-provider">Provider</label><select id="wa-field-provider" name="provider"><option value="auto">Detect from the key</option>${presetOptions}</select><p class="field-help ai-provider-hint"></p><p class="field-help ai-err" data-err="provider" style="color:#c0453f" hidden></p></div>` : ''}
        ${textField('models', 'Models (optional, comma-separated, best first)', isNew ? 'Leave empty: when you save, the key is tested with a real request and a model that answered is chosen automatically. Type model ids only to test those instead. Required for a custom endpoint, xAI and Cerebras. A provider is never used until its free tier is confirmed.' : 'The models this provider may use, best first. A provider is never used until its free tier is confirmed.', entry && entry.models ? entry.models.join(', ') : '')}
        <p class="field-help ai-err" data-err="models" style="color:#c0453f" hidden></p>
        ${isNew ? '<div class="ai-omni-models field" hidden><button type="button" class="btn small" data-act="load-models">Load models</button> <span class="muted small ai-omni-status" role="status"></span><datalist id="ai-omni-model-list"></datalist></div>' : ''}
        ${isNew ? textField('baseUrl', 'Endpoint address', 'Filled in for known providers. Required for a custom endpoint: a full https:// address.', '') : ''}
        <p class="field-help ai-err" data-err="baseUrl" style="color:#c0453f" hidden></p>
      </details>
      <div class="toolbar" style="margin-top:8px">
        <button type="submit" class="btn primary">Save</button>
        <button type="button" class="btn ai-cancel">Cancel</button>
      </div>
      <div class="ai-form-result muted" style="font-size:12px" role="status"></div>
    </form>`;
}

/** One row of the list: order, name, configuration, a one-line status and the actions that apply. */
function aiEntryRowHtml(entry, index, count, opts) {
  const isDefault = entry.type === 'default';
  // The status region: a badge and one short summary line; the full diagnostic is in an expandable "Details" (and the tooltip), not a squeezed column.
  const health = entry.health || null;
  const summary = health ? localizeHealthTimes(health.summary, health) : shortText(entry.detail, 100);
  const full = health ? localizeHealthTimes(health.detail, health) : entry.detail || '';
  const detail = summary ? `<span class="muted ai-summary" title="${esc(full || summary)}">${esc(summary)}</span>` : '';
  const more = full && full !== summary ? `<details class="ai-more-detail"><summary class="muted">Details</summary><p class="muted">${esc(full)}</p></details>` : '';
  const config = isDefault ? 'Shared providers managed by the Super Admin' : entry.config || '';
  return `
    <li class="ai-entry${entry.enabled ? '' : ' off'}" data-key="${esc(entry.key || '')}" data-id="${entry.id == null ? '' : entry.id}">
      <span class="ai-pos" aria-hidden="true">${index + 1}</span>
      <div class="ai-main"><strong>${esc(entry.name)}</strong> ${isDefault ? badge('SHARED', 'blue') : ''}<div class="muted ai-config">${isDefault ? `<span>${esc(config)}</span>` : `<span class="file">${esc(config)}</span>`}</div></div>
      <div class="ai-state">${health ? aiHealthBadge(health) : aiStateBadge(entry.state)} ${detail}${more}</div>
      <div class="ai-actions">
        ${opts.reorder ? `<button type="button" class="btn small" data-act="up" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>▲</button><button type="button" class="btn small" data-act="down" aria-label="Move down" ${index === count - 1 ? 'disabled' : ''}>▼</button>` : ''}
        <button type="button" class="btn small" data-act="test">Test</button>
        <button type="button" class="btn small" data-act="toggle">${entry.enabled ? 'Turn off' : 'Turn on'}</button>
        ${isDefault ? '' : '<button type="button" class="btn small" data-act="edit">Edit</button><button type="button" class="btn small danger" data-act="remove">Remove</button>'}
      </div>
    </li>`;
}

/** Reads the presets and rules the server embedded in the form (one source of truth for the checks below). */
function aiFormMeta(form) {
  const el = form.querySelector('form-meta');
  const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  const rules = parse(el && el.dataset.rules, {});
  return {
    presets: parse(el && el.dataset.presets, []),
    baseUrl: rules.baseUrl ? new RegExp(rules.baseUrl) : /^https:\/\/\S{3,200}$/,
    model: rules.model ? new RegExp(rules.model) : /^[A-Za-z0-9._:/@-]{1,120}$/,
  };
}

// Recognises a pasted key by its provider's prefix, only to pre-fill the form (the server detects the same way and stays authoritative).
const AI_KEY_PREFIXES = { openrouter: /^sk-or-/, groq: /^gsk_/, google: /^AIza/, xai: /^xai-/, cerebras: /^csk-/ };

/** The preset chosen in the form, or recognised from the key's prefix. */
function aiFormPreset(form, meta) {
  const asked = form.elements.provider ? form.elements.provider.value : 'auto';
  if (asked && asked !== 'auto') return meta.presets.find((p) => p.id === asked) || null;
  const key = (form.elements.config.value || '').trim();
  const known = Object.keys(AI_KEY_PREFIXES).find((id) => AI_KEY_PREFIXES[id].test(key));
  return known ? meta.presets.find((p) => p.id === known) || null : null;
}

/** Known provider: fill endpoint and free-tier models (never over what the person typed). Custom: ask for both. */
function aiFormApplyPreset(form, meta) {
  const base = form.elements.baseUrl;
  if (!base) return; // editing: the endpoint is not changed here
  const preset = aiFormPreset(form, meta);
  // Only the endpoint is pre-filled. The model is never guessed here: the server picks it by a real test request when the key is saved.
  for (const [input, value] of [[base, preset ? preset.baseUrl : '']]) {
    if (!input.value || input.dataset.auto === '1') { input.value = value; input.dataset.auto = '1'; }
    input.oninput = () => { input.dataset.auto = '0'; };
  }
  form.elements.models.placeholder = !preset ? 'Chosen automatically for known providers' : preset.autoSelect ? 'Chosen automatically when you save' : 'Required for this provider';
  const custom = Boolean(preset && preset.id === 'custom');
  const hint = form.querySelector('.ai-provider-hint');
  if (hint) hint.textContent = preset ? (custom ? 'Custom endpoint: Endpoint address and Models are required.' : preset.hint) : '';
  if (custom) form.querySelector('.ai-more').open = true;
  aiFormModelDiscovery(form, preset || null);
}

/**
 * "Load models" for every provider: the server reads the model list of the provider's OWN API with the key typed above (OmniRoute: with its own gateway key) and the
 * results are only SUGGESTIONS for the Models box. A listed model is not proof that it works or that it is free: nothing is chosen for the person and saving tests the
 * model they pick with a real request. Typing a model id by hand stays possible when a provider offers no list.
 */
function aiFormModelDiscovery(form, preset) {
  const box = form.querySelector('.ai-omni-models');
  if (!box) return;
  const known = Boolean(preset);
  box.hidden = !known;
  if (known) form.elements.models.setAttribute('list', 'ai-omni-model-list'); else form.elements.models.removeAttribute('list');
  if (!known) return;
  const button = box.querySelector('button');
  const status = box.querySelector('.ai-omni-status');
  const list = box.querySelector('datalist');
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = 'Loading models…';
    try {
      const key = String(form.elements.config.value || '').trim();
      const r = await api('/api/dashboard/ai-routing/discover-models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vendor: preset.id, baseUrl: form.elements.baseUrl ? String(form.elements.baseUrl.value || '').trim() : '', apiKey: key }) });
      list.innerHTML = '';
      if (r.ok) {
        for (const m of r.models) { const o = document.createElement('option'); o.value = m.id; o.label = m.price === 'free' ? m.id + ' (free in the provider catalog)' : m.price === 'gateway_combo' ? m.id + ' (gateway combo: free only if the accounts inside are)' : m.id + ' (cost not known)'; list.appendChild(o); }
        const free = r.models.filter((m) => m.price === 'free').length;
        status.textContent = r.models.length + ' models listed' + (free ? ', ' + free + ' marked free by the provider catalog' : '') + '. ' + r.note;
      } else {
        status.textContent = r.message || 'No models were listed.';
      }
    } catch (error) { status.textContent = error.message; }
    button.disabled = false;
  };
}

/** Inline checks before Save, using the server's own rules: returns false when something is missing or invalid. */
function aiFormValidate(form, isNew) {
  const meta = aiFormMeta(form);
  const errors = {};
  const val = (n) => (form.elements[n] ? String(form.elements[n].value || '').trim() : '');
  const omniLocal = isNew && val('provider') === 'omniroute'; // only when OmniRoute is CHOSEN under More options (a name containing "omni" selects nothing): then no pasted key is needed, its own local key is used
  if (isNew && !val('config') && !omniLocal) errors.config = 'Paste the API key.';
  else if (isNew && /^https?:\/\//i.test(val('config'))) errors.config = 'Paste the API key, not an address. The endpoint goes under More options.';
  const preset = isNew ? aiFormPreset(form, meta) : null;
  if (isNew && !preset && !val('baseUrl')) errors.provider = 'This key\'s provider could not be recognised. Choose it under More options, or enter the endpoint address and models of a custom one.';
  if (isNew && !errors.provider) {
    const baseUrl = val('baseUrl') || (preset ? preset.baseUrl : '');
    if (!meta.baseUrl.test(baseUrl)) errors.baseUrl = baseUrl ? 'Endpoint address must be a full https:// address, for example https://api.example.com/v1.' : 'Endpoint address is required for a custom provider.';
  }
  const models = val('models').split(',').map((s) => s.trim()).filter(Boolean);
  // A provider whose vendor documents a stable model is configured automatically (a real test request picks the model when the key is saved).
  if (isNew && models.length === 0 && !(preset && preset.autoSelect)) errors.models = 'Type the model id to use: this provider has no model that can be chosen automatically.';
  else if (models.some((m) => !meta.model.test(m))) errors.models = 'A model id may only contain letters, digits and . _ : / @ - (separate several with commas).';
  form.querySelectorAll('.ai-err').forEach((p) => { const m = errors[p.dataset.err]; p.textContent = m || ''; p.hidden = !m; });
  if (errors.baseUrl || errors.models || errors.provider) form.querySelector('.ai-more').open = true;
  const first = Object.keys(errors)[0];
  if (first && form.elements[first] && form.elements[first].focus) form.elements[first].focus();
  return !first;
}

function readAiForm(form) {
  const f = readFormFields(form, ['id', 'name', 'config', 'provider', 'models', 'baseUrl']);
  const payload = { name: f.name, config: f.config, models: f.models };
  if (f.provider && f.provider !== 'auto') payload.provider = f.provider;
  if (f.baseUrl) payload.baseUrl = f.baseUrl;
  return { id: f.id, payload };
}

/** Shows one compact test / error line (the long diagnostics stay out of the page). */
function showAiStatus(host, text, ok) {
  const line = host.querySelector('.ai-status-line');
  if (!line) return;
  line.textContent = text || '';
  line.style.color = ok === false ? '#c0453f' : ok === true ? '#0e8f68' : '';
}

/** Wires the form shown by either page. `endpoint` is the create URL; `itemUrl(id)` the URL of one provider. */
function bindAiForm(host, { endpoint, itemUrl, extraPayload, onDone }) {
  const form = host.querySelector('.ai-entry-form');
  if (!form) return;
  host.querySelectorAll('.pw-toggle').forEach((btn) => btn.addEventListener('click', () => {
    const input = host.querySelector(`#${btn.dataset.for}`);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  }));
  form.querySelector('.ai-cancel').addEventListener('click', () => onDone(false));
  const meta = aiFormMeta(form);
  if (form.elements.provider) {
    form.elements.provider.addEventListener('change', () => aiFormApplyPreset(form, meta));
    form.elements.config.addEventListener('input', () => { if (form.elements.provider.value === 'auto') aiFormApplyPreset(form, meta); });
    aiFormApplyPreset(form, meta);
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { id, payload } = readAiForm(form);
    if (!aiFormValidate(form, !id)) return;
    const result = form.querySelector('.ai-form-result');
    const submit = form.querySelector('button[type="submit"]');
    result.style.color = '';
    // A new key is configured automatically: the server tests it with real minimal requests (no model list) before anything is saved.
    result.textContent = id ? '' : 'Testing the key with a real request…';
    if (submit) submit.disabled = true;
    try {
      let saved = null;
      if (id) saved = await api(itemUrl(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      else saved = await api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, ...(extraPayload || {}) }) });
      const setup = saved && saved.setup;
      const hit = setup && setup.attempts.find((a) => a.ok);
      const keyCheck = saved && saved.keyCheck;
      if (keyCheck && keyCheck.ok === false) toast(keyCheck.message, 'error'); else
      if (setup && setup.verified === false) toast(`The key was saved, but the test request failed: ${setup.testFailure || 'no model answered'}. It is not marked as working.`, 'error'); else
      toast(hit ? `Saved. ${hit.model} answered a real test request in ${(hit.latencyMs / 1000).toFixed(1)} s.${setup.testFailure ? ' ' + setup.testFailure : ''}${setup.freeConfirmationRequired ? ' Confirm the free tier before it is used.' : ''}` : 'Saved', 'success');
      onDone(true);
    } catch (error) {
      result.textContent = error.fields && error.fields.length && error.message === 'validation_failed' ? `Check ${error.fields.join(', ')}.` : error.message;
      if (error.fields) error.fields.forEach((n) => { const p = form.querySelector(`.ai-err[data-err="${n}"]`); if (p) { p.textContent = `Check ${n === 'baseUrl' ? 'the endpoint address' : n}.`; p.hidden = false; } });
      result.style.color = '#c0453f';
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

// The routing diagnostics (plan, cooldowns, charts, recovery, history) live in one collapsed block so the page stays short.
function routingDiagnosticsHtml(data) {
  const { settings, plan, cooldowns, history, stats, statsWeek, builtin } = data;
  const planList = (p) => p.eligible.length
    ? `<ol class="route-plan">${p.eligible.map((r) => `<li>${esc(r.providerName)} · <span class="file">${esc(r.model)}</span> ${priceBadge(r.free)}${r.local ? badge('LOCAL', 'blue') : ''}</li>`).join('')}</ol>`
    : `<p class="muted" style="color:#c0453f">No eligible route: every customer message gets the automated choices (not an AI answer).</p>`;
  const skippedList = (p) => p.skipped.length
    ? `<ul class="muted route-skipped">${p.skipped.map((s) => `<li>${esc(s.route.providerName)} · <span class="file">${esc(s.route.model)}</span> — ${badge(categoryLabel(s.category), categoryTone(s.category))} ${esc(s.reason)}</li>`).join('')}</ul>`
    : '';
  const perRoute = (stats.perRoute || []).map((r) => `<tr><td>${esc(r.providerName)}</td><td><span class="file">${esc(r.model)}</span></td><td>${r.ok}</td><td>${r.failed}</td><td>${r.avgLatencyMs != null ? `${(r.avgLatencyMs / 1000).toFixed(1)} s` : '—'}</td><td>${r.lastOutcome ? badge(r.lastOutcome === 'ok' ? 'OK' : categoryLabel(r.lastCategory), r.lastOutcome === 'ok' ? 'green' : categoryTone(r.lastCategory) || 'red') : '—'}</td></tr>`).join('');
  const historyRows = (history || []).map((h) => `<tr><td class="muted" style="white-space:nowrap">${esc(formatDate(h.created_at))}</td><td>${esc(h.task)}</td><td>${esc(h.provider_name)} · <span class="file">${esc(h.model)}</span></td><td>${h.outcome === 'ok' ? badge('OK', 'green') : badge(categoryLabel(h.category), categoryTone(h.category) || 'red')}</td><td>${h.http_status ?? ''}</td><td>${(h.latency_ms / 1000).toFixed(1)} s</td><td class="muted" style="font-size:12px">${esc(h.detail || '')}</td></tr>`).join('');
  const coolRows = (cooldowns || []).map((c) => `<li>${esc(c.key)} — ${esc(c.why)} until ${esc(formatDate(c.untilIso))} ${c.resetBasis === 'documented' ? "(the provider's documented daily reset)" : c.resetKnown ? '(reset stated by the provider)' : '(estimated backoff' + (c.strikes > 1 ? `, failure ${c.strikes}` : '') + ')'}</li>`).join('');
  return `
    <details class="ai-diagnostics" style="margin-top:14px"><summary><strong>Routing status and history</strong></summary>
      <div class="detail-grid" style="margin-top:12px">
        <label class="muted">Strict free-only mode</label>
        <div><label><input type="checkbox" id="routing-free-only" ${settings.freeOnly ? 'checked' : ''} /> Never use a route that may cost money (an unknown price counts as paid)</label></div>
        <label class="muted">Automatic failover</label>
        <div><label><input type="checkbox" id="routing-failover" ${settings.failover ? 'checked' : ''} /> After a failure, try the next provider at once (at most ${builtin.budget.maxRoutesPerMessage} routes within ${Math.round(builtin.budget.routingBudgetMs / 1000)} s)</label></div>
        <span></span>
        <div class="toolbar"><button type="button" class="btn" id="routing-save">Save routing switches</button><span id="routing-save-result" class="muted" style="font-size:12px"></span></div>
      </div>
      <h4 style="margin-top:14px">Providers used right now (in order)</h4>
      <div class="detail-grid">
        <label class="muted">Chat</label><div>${planList(plan.chat)}${skippedList(plan.chat)}</div>
        <label class="muted">Pictures</label><div>${planList(plan.vision)}</div>
        <label class="muted">Voice notes</label><div>${planList(plan.audio)}</div>
      </div>
      ${coolRows ? `<p class="muted" style="margin-top:8px">Cooling down now:</p><ul class="muted">${coolRows}</ul>` : ''}
      <h4 style="margin-top:14px">Last 24 hours</h4>
      <p class="muted" style="font-size:12px">${stats.totals.ok} answered · ${stats.totals.failed} failed${stats.totals.avgLatencyMs != null ? ` · average answer ${(stats.totals.avgLatencyMs / 1000).toFixed(1)} s` : ''} · last 7 days: ${statsWeek.totals.ok} answered, ${statsWeek.totals.failed} failed</p>
      ${routeBarsSvg(stats.hourly)}
      ${perRoute ? `<div class="table-wrap" style="margin-top:12px"><table class="data-table"><thead><tr><th>Provider</th><th>Model</th><th>OK</th><th>Failed</th><th>Avg time</th><th>Last</th></tr></thead><tbody>${perRoute}</tbody></table></div>` : ''}
      <h4 style="margin-top:14px">Unanswered messages and escalations</h4>
      ${recoveryHtml(data.recovery)}
      <h4 style="margin-top:14px">Latest attempts</h4>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>When</th><th>Task</th><th>Route</th><th>Outcome</th><th>HTTP</th><th>Time</th><th>Detail</th></tr></thead><tbody>${historyRows || `<tr><td colspan="7" class="muted">No attempts yet.</td></tr>`}</tbody></table></div>
    </details>`;
}

// ---- the account's AI providers: Default (the shared pool) + its own providers, in the order the server follows -----------------------------

async function renderAiRouting(host) {
  let editing = null; // null = list, 'new' = add form, number = edit form
  async function draw() {
    let data;
    try {
      data = await api('/api/dashboard/ai-routing');
    } catch (error) {
      host.innerHTML = errorView(error.message, draw);
      return;
    }
    const entries = data.entries || [];
    const editingEntry = typeof editing === 'number' ? entries.find((e) => e.id === editing) : null;
    host.innerHTML = `
      <h3>AI providers</h3>
      <p class="muted">Providers are tried from the top. If one fails, times out or runs out of its free usage, the next one is used at once. Only free usage is ever allowed.</p>
      <ul class="ai-list">${entries.map((e, i) => aiEntryRowHtml(e, i, entries.length, { reorder: true })).join('')}</ul>
      ${entries.filter((e) => e.needsFreeConfirm).map((e) => `<p class="muted" style="font-size:12px"><b>${esc(e.name)}</b> — <span>Not confirmed as free: this provider is never used until you confirm its free tier.</span> <button type="button" class="btn small" data-confirm-free="${e.id}">Confirm free tier</button></p>`).join('')}
      <div class="toolbar" style="margin-top:8px"><button type="button" class="btn primary" id="ai-add">Add provider</button> <button type="button" class="btn" id="ai-reset-order">Reset routing order</button></div>
      <div class="ai-status-line muted" style="font-size:12px;margin-top:6px" role="status" aria-live="polite"></div>
      <div id="ai-form-host" style="margin-top:10px">${editing === 'new' ? aiProviderFormHtml(data, null) : editingEntry ? aiProviderFormHtml(data, editingEntry) : ''}</div>
      ${routingDiagnosticsHtml(data)}`;

    host.querySelector('#ai-add').addEventListener('click', () => { editing = 'new'; draw(); });
    host.querySelector('#ai-reset-order').addEventListener('click', async () => {
      if (!window.confirm('Reset the routing order and on/off switches of this business to the defaults? Providers and keys are kept.')) return;
      try { await api('/api/dashboard/ai-routing/order/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('Routing order reset to the defaults', 'success'); } catch (error) { toast(error.message, 'error'); }
      await draw();
    });
    host.querySelectorAll('[data-confirm-free]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/api/dashboard/ai-routing/providers/${btn.dataset.confirmFree}/confirm-free`, { method: 'POST' });
        toast('Free tier confirmed', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
      await draw();
    }));
    bindAiForm(host, {
      endpoint: '/api/dashboard/ai-routing/providers',
      itemUrl: (id) => `/api/dashboard/ai-routing/providers/${id}`,
      onDone: (saved) => { editing = null; if (saved) draw(); else draw(); },
    });

    const save = async (list) => {
      await api('/api/dashboard/ai-routing/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: list }) });
    };
    host.querySelectorAll('.ai-entry [data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.ai-entry');
        const key = row.dataset.key;
        const id = row.dataset.id ? Number(row.dataset.id) : null;
        const act = btn.dataset.act;
        const index = entries.findIndex((e) => e.key === key);
        try {
          if (act === 'edit') { editing = id; await draw(); return; }
          if (act === 'up' || act === 'down') {
            const list = entries.map((e) => ({ key: e.key, enabled: e.type === 'default' ? e.enabled : undefined }));
            const to = act === 'up' ? index - 1 : index + 1;
            [list[index], list[to]] = [list[to], list[index]];
            await save(list);
            toast('Order saved', 'success');
          } else if (act === 'toggle') {
            const entry = entries[index];
            if (entry.type === 'default') await save(entries.map((e) => ({ key: e.key, enabled: e.key === key ? !e.enabled : e.type === 'default' ? e.enabled : undefined })));
            else await api(`/api/dashboard/ai-routing/providers/${id}/${entry.enabled ? 'disable' : 'enable'}`, { method: 'POST' });
          } else if (act === 'remove') {
            if (!window.confirm('Remove this provider and its saved configuration?')) return;
            await api(`/api/dashboard/ai-routing/providers/${id}`, { method: 'DELETE' });
            toast('Provider removed', 'success');
          } else if (act === 'test') {
            btn.disabled = true; btn.textContent = 'Testing…';
            const res = entries[index].type === 'default'
              ? await api('/api/dashboard/ai-routing/entries/default/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
              : await api(`/api/dashboard/ai-routing/providers/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            await draw();
            showAiStatus(host, `${entries[index].name}: ${res.ok ? 'passed' : 'failed'} — ${res.detail}`, res.ok);
            return;
          }
          await draw();
        } catch (error) {
          toast(error.message, 'error');
          await draw();
        }
      });
    });

    host.querySelector('#routing-save').addEventListener('click', async () => {
      const result = host.querySelector('#routing-save-result');
      try {
        await api('/api/dashboard/ai-routing/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ freeOnly: host.querySelector('#routing-free-only').checked, failover: host.querySelector('#routing-failover').checked }) });
        toast('Routing switches saved', 'success');
        result.textContent = 'Saved.';
      } catch (error) {
        result.textContent = error.message;
      }
    });
  }
  await draw();
}

// ---------------------------------------------------------------------
// Super Admin Settings: the shared AI defaults (Default pool) of every business
// ---------------------------------------------------------------------

route('#/super-admin-settings', 'Super Admin Settings', 'Shared AI defaults for every business — managed by the Super Admin only.', async (view) => {
  let editing = null;
  async function draw() {
    const data = await api('/api/dashboard/super-admin/ai');
    const providers = data.providers.map((p) => ({
      key: `provider:${p.id}`, type: 'provider', id: p.id, name: p.name, provider: p.kind, enabled: p.enabled, config: p.keyMasked || '', models: p.models, health: p.health,
      state: !p.enabled ? 'off' : p.keyStatus !== 'ok' ? 'no_key' : p.lastTestAt ? (p.lastTestOk ? 'ok' : 'failed') : 'untested',
      detail: p.keyStatus === 'undecryptable' ? 'The saved key cannot be read: enter it again.' : p.lastTestDetail || (p.freeTier ? '' : 'Declared as a paid endpoint: never used while free-only mode is on.'),
    }));
    const editingEntry = typeof editing === 'number' ? providers.find((p) => p.id === editing) : null;
    view.innerHTML = `
      <section class="panel setup-card">
        <h3>Default AI providers</h3>
        <div class="ai-default-status" role="status">${aiDefaultBadge(data.status)} <span class="muted">${esc(data.status.detail)}</span></div>
        <p class="muted">The providers below form the shared Default entry that every business, present and future, inherits. Keys stay here, encrypted and masked; a business only sees one line saying how many shared providers can answer, and decides where Default sits in its own order.</p>
        <p class="muted" style="font-size:12px"><span>Businesses inheriting Default:</span> <b>${data.accounts}</b></p>
        <p class="muted" style="font-size:12px">${esc(data.enforced.note)}</p>
        <p class="muted" style="font-size:12px"><span>Tried in this order:</span> <b>${providers.length ? providers.map((p) => esc(p.name)).join(' → ') : '—'}</b> — a provider that is resting, off or not eligible is skipped, and the next one answers.</p>
        <p class="muted" style="font-size:12px"><span>Active provider (last answer):</span> <b>${data.active ? esc(`${data.active.provider} · ${data.active.model} — ${formatDate(data.active.answeredAt)}`) : '—'}</b></p>
        <p class="muted" style="font-size:12px"><span>The next message would use:</span> <b>${data.nextRoute ? esc(`${data.nextRoute.provider} · ${data.nextRoute.model}`) : data.allResting ? '—  (every provider is resting; customers get one friendly notice and their question is answered later)' : '—'}</b></p>
        ${data.nextRetry ? `<p class="muted" style="font-size:12px"><span>Next retry of a resting provider:</span> <b>${esc(`${data.nextRetry.provider} · ${formatDate(data.nextRetry.at)}`)}</b> <span>${data.nextRetry.basis === 'documented' ? "(the provider's documented daily reset: its response carries no timestamp)" : data.nextRetry.resetKnown ? '(the provider stated this reset time)' : '(our estimated backoff: the provider gave no reset time)'}</span></p>` : ''}
        <ul class="ai-list">${providers.length ? providers.map((e, i) => aiEntryRowHtml(e, i, providers.length, { reorder: true })).join('') : '<li class="muted">No shared provider yet. Add one below; until then each business uses only the providers it added itself.</li>'}</ul>
        ${data.providers.filter((p) => p.kind !== 'openrouter' && !p.freeConfirmed).map((p) => `<p class="muted" style="font-size:12px"><b>${esc(p.name)}</b> — <span>Not confirmed as free: this provider is never used until you confirm its free tier.</span> <button type="button" class="btn small" data-confirm-free="${p.id}">Confirm free tier</button></p>`).join('')}
        <div class="toolbar" style="margin-top:8px"><button type="button" class="btn primary" id="ai-add">Add provider</button></div>
        <div class="ai-status-line muted" style="font-size:12px;margin-top:6px" role="status" aria-live="polite"></div>
        <div id="ai-form-host" style="margin-top:10px">${editing === 'new' ? aiProviderFormHtml(data, null) : editingEntry ? aiProviderFormHtml(data, editingEntry) : ''}</div>
      </section>
      <section class="panel setup-card" style="margin-top:16px">
        <h3>Also part of Default (set on the server)</h3>
        <div class="detail-grid">
          <label class="muted">OpenRouter key saved on this server</label><div>${data.builtin.openRouter.hasKey ? badge('KEY SAVED', 'green') : badge('NO KEY', 'muted')} ${data.builtin.openRouter.adopted ? '<span class="muted">Already in the Default list above.</span>' : data.builtin.openRouter.hasKey ? '<button type="button" class="btn small" id="ai-adopt">Add it to the Default list</button> <span class="muted">The key stays on the server; it is not shown.</span>' : '<span class="muted">Add a provider above with its own key.</span>'}</div>
        </div>
      </section>`;

    view.querySelector('#ai-add').addEventListener('click', () => { editing = 'new'; draw(); });
    view.querySelectorAll('[data-confirm-free]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/api/dashboard/super-admin/ai/providers/${btn.dataset.confirmFree}/confirm-free`, { method: 'POST' });
        toast('Free tier confirmed', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
      await draw();
    }));
    const adopt = view.querySelector('#ai-adopt');
    if (adopt) adopt.addEventListener('click', async () => {
      adopt.disabled = true;
      try {
        await api('/api/dashboard/super-admin/ai/adopt-openrouter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        toast('Added to the Default list', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
      await draw();
    });
    bindAiForm(view, {
      endpoint: '/api/dashboard/super-admin/ai/providers',
      itemUrl: (id) => `/api/dashboard/super-admin/ai/providers/${id}`,
      onDone: () => { editing = null; draw(); },
    });
    view.querySelectorAll('.ai-entry [data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.ai-entry');
        const id = Number(row.dataset.id);
        const index = providers.findIndex((p) => p.id === id);
        const act = btn.dataset.act;
        try {
          if (act === 'edit') { editing = id; await draw(); return; }
          if (act === 'up' || act === 'down') {
            const ids = providers.map((p) => p.id);
            const to = act === 'up' ? index - 1 : index + 1;
            [ids[index], ids[to]] = [ids[to], ids[index]];
            await api('/api/dashboard/super-admin/ai/providers/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
            toast('Order saved', 'success');
          } else if (act === 'toggle') {
            await api(`/api/dashboard/super-admin/ai/providers/${id}/${providers[index].enabled ? 'disable' : 'enable'}`, { method: 'POST' });
          } else if (act === 'remove') {
            if (!window.confirm(`Remove "${providers[index].name}" and its saved key? Every business that uses Default (${data.accounts} now) stops using it.`)) return;
            await api(`/api/dashboard/super-admin/ai/providers/${id}?confirm=yes`, { method: 'DELETE' });
            toast('Provider removed', 'success');
          } else if (act === 'test') {
            btn.disabled = true; btn.textContent = 'Testing…';
            const res = await api(`/api/dashboard/super-admin/ai/providers/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            await draw();
            showAiStatus(view, `${providers[index].name}: ${res.ok ? 'passed' : 'failed'} — ${res.detail}`, res.ok);
            return;
          }
          await draw();
        } catch (error) {
          toast(error.message, 'error');
          await draw();
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
        <dt>Developed by</dt><dd translate="no">SYNRTECHS</dd>
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
