// Rowad Alfa AI Workspace — application shell: theme, signed-in user and permissions, sidebar icons/visibility,
// top bar controls (AI status, appearance, date range, profile menu). Loaded BEFORE app.js; it only defines globals and
// event wiring — it reads data through app.js's api() once the page is running.
//
// The browser's view of permissions (me.permissions / me.capabilities) is a CONVENIENCE for hiding what a user cannot use.
// The server enforces every rule on every request (src/dashboard/authorize.ts); nothing here grants access.

// ---------------------------------------------------------------------
// Appearance: light (default) or the original dark theme, remembered per browser
// ---------------------------------------------------------------------

const THEME_KEY = 'workspace.theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, currentTheme()); } catch { /* storage unavailable: the choice just is not remembered */ }
  const toggle = document.querySelector('#theme-toggle');
  if (toggle) toggle.setAttribute('aria-checked', String(currentTheme() === 'dark'));
  document.dispatchEvent(new CustomEvent('workspace:theme', { detail: { theme: currentTheme() } }));
}

// ---------------------------------------------------------------------
// The signed-in user (GET /api/dashboard/me) and what they may open
// ---------------------------------------------------------------------

let me = null;

const LEVEL_RANK = { view: 1, edit: 2, manage: 3 };

/** True when the signed-in user holds `feature` at `level` or better on the selected account. */
function can(feature, level = 'view') {
  if (!me) return false;
  if (me.superAdmin) return true;
  const have = (me.permissions || {})[feature];
  return Boolean(have) && LEVEL_RANK[have] >= LEVEL_RANK[level];
}

/** connection | configuration | users — account-independent capabilities. */
function hasCap(name) {
  return Boolean(me && me.capabilities && me.capabilities[name]);
}

/**
 * What each page needs. `any` = every signed-in user; a string = that feature (view); { cap } = a capability.
 * Mirrors src/dashboard/authorize.ts so a hidden menu item and a refused API call always agree.
 */
const ROUTE_ACCESS = {
  '#/': 'dashboard',
  '#/accounts': 'any',
  '#/whatsapp': { cap: 'connection' },
  '#/conversations': 'conversations',
  '#/customers': 'customers',
  '#/flow': 'menus',
  '#/automation': 'menus',
  '#/replies': 'menus',
  '#/support': 'support',
  '#/bookings': 'requests',
  '#/services': 'ai',
  '#/products': 'ai',
  '#/prices': 'ai',
  '#/offers': 'offers',
  '#/business': 'business',
  '#/location': 'business',
  '#/knowledge': 'ai',
  '#/ai': 'ai',
  '#/integrations': { cap: 'configuration' },
  '#/analytics': 'dashboard',
  '#/security': { cap: 'configuration' },
  '#/system': { cap: 'configuration' },
  '#/settings': { cap: 'configuration' },
  '#/project-sync': { cap: 'configuration' },
  '#/users': { cap: 'users' },
  '#/logs': 'activity',
};

function routeAllowed(topKey) {
  const need = ROUTE_ACCESS[topKey];
  if (need === undefined) return Boolean(me && me.superAdmin);
  if (need === 'any') return Boolean(me);
  if (typeof need === 'string') return can(need);
  return hasCap(need.cap);
}

async function loadMe() {
  me = await api('/api/dashboard/me');
  applyAccessToShell();
  document.dispatchEvent(new CustomEvent('workspace:me', { detail: { me } }));
  return me;
}

// ---------------------------------------------------------------------
// Sidebar: consistent icons, items the user cannot use are hidden (groups with nothing left disappear too)
// ---------------------------------------------------------------------

const ICON = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICONS = {
  '#/': 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  '#/whatsapp': 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  '#/conversations': 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  '#/customers': 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  '#/flow': 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9a9 9 0 0 1-9 9',
  '#/automation': 'M13 2 3 14h9l-1 8 10-12h-9z',
  '#/replies': 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  '#/support': 'M3 18v-6a9 9 0 0 1 18 0v6M3 18a3 3 0 0 0 3 3h1v-7H6a3 3 0 0 0-3 3zM21 18a3 3 0 0 1-3 3h-1v-7h1a3 3 0 0 1 3 3z',
  '#/bookings': 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  '#/services': 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  '#/products': 'M21 8 12 3 3 8v8l9 5 9-5zM3.3 7.5 12 12.5l8.7-5M12 22V12',
  '#/prices': 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01',
  '#/offers': 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z',
  '#/business': 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M14 9h1M14 13h1M10 21v-4h4v4',
  '#/location': 'M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  '#/knowledge': 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z',
  '#/ai': 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
  '#/integrations': 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  '#/analytics': 'M12 20V10M18 20V4M6 20v-4',
  '#/security': 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  '#/system': 'M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 9h6v6H9z',
  '#/settings': 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  '#/project-sync': 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  '#/users': 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6',
  '#/accounts': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  add: 'M12 5v14M5 12h14',
};

function decorateNav() {
  document.querySelectorAll('#nav a').forEach((a) => {
    if (a.querySelector(':scope > svg.ico')) return;
    const key = a.matches('[data-add-account]') ? 'add' : a.dataset.route;
    const d = ICONS[key];
    if (!d) return;
    // The old text glyph (◎, ⚡, …) is replaced by a consistent line icon; the label span is left untouched.
    for (const node of [...a.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
    a.insertAdjacentHTML('afterbegin', ICON(d));
  });
}

function applyAccessToShell() {
  if (!me) return;
  document.querySelectorAll('#nav a[data-route]').forEach((a) => {
    a.hidden = !routeAllowed(a.dataset.route);
  });
  document.querySelectorAll('#nav a[data-add-account]').forEach((a) => { a.hidden = !hasCap('connection'); });
  // A group heading disappears when every link under it is hidden.
  const nav = document.querySelector('#nav');
  if (nav) {
    let heading = null;
    let visible = 0;
    const flush = () => { if (heading) heading.hidden = visible === 0; };
    for (const el of nav.children) {
      if (el.classList.contains('nav-group')) { flush(); heading = el; visible = 0; continue; }
      if (el.id === 'account-list') { visible += 1; continue; }
      if (!el.hidden) visible += 1;
    }
    flush();
  }
  renderProfile();
  const settingsBtn = document.querySelector('#settings-btn');
  if (settingsBtn) settingsBtn.hidden = !hasCap('configuration');
  pollAiStatus();
}

// ---------------------------------------------------------------------
// Top bar: profile menu, appearance toggle, date range, AI status
// ---------------------------------------------------------------------

const ROLE_LABEL = { super_admin: 'Super Admin', admin: 'Admin', manager: 'Manager', user: 'User', custom: 'Custom' };

function displayName() {
  if (!me) return '';
  if (me.name) return me.name;
  const local = String(me.email || '').split('@')[0] || 'User';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function initialsOf(text) {
  const parts = String(text || '?').trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function renderProfile() {
  const label = document.querySelector('#profile-name');
  const menu = document.querySelector('#profile-items');
  if (!label || !menu || !me) return;
  label.textContent = ROLE_LABEL[me.role] || displayName();
  document.querySelector('#profile-who').innerHTML = `<b>${esc(displayName())}</b><small>${esc(me.email || '')}</small><span class="badge ${me.superAdmin ? 'blue' : ''}">${esc(ROLE_LABEL[me.role] || me.role)}</span>`;
  const items = [];
  if (hasCap('users')) items.push('<a role="menuitem" href="#/users">Users &amp; permissions</a>');
  items.push('<a role="menuitem" href="#/accounts">WhatsApp accounts</a>');
  if (hasCap('configuration')) items.push('<a role="menuitem" href="#/settings">Settings</a>');
  menu.innerHTML = items.join('');
}

(function topbar() {
  const profile = document.querySelector('#profile-menu');
  const button = document.querySelector('#profile-btn');
  const panel = document.querySelector('#profile-panel');
  if (!profile || !button || !panel) return;
  const set = (open) => { panel.hidden = !open; button.setAttribute('aria-expanded', String(open)); };
  button.addEventListener('click', (e) => { e.stopPropagation(); set(panel.hidden); });
  document.addEventListener('click', (e) => { if (!profile.contains(e.target)) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { set(false); button.focus(); } });
  panel.addEventListener('click', (e) => { if (e.target.closest('a, button')) set(false); });

  const toggle = document.querySelector('#theme-toggle');
  if (toggle) {
    toggle.setAttribute('aria-checked', String(currentTheme() === 'dark'));
    toggle.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  }
})();

// Date range for the dashboard's figures (remembered per browser).
const RANGE_KEY = 'workspace.range';
const RANGES = [['7', '7 Days'], ['30', '30 Days'], ['90', '90 Days'], ['all', 'All time']];
function dashboardRange() {
  let value = '30';
  try { value = localStorage.getItem(RANGE_KEY) || '30'; } catch { /* storage unavailable */ }
  return RANGES.some(([v]) => v === value) ? value : '30';
}
function rangeLabel(range) {
  return (RANGES.find(([v]) => v === range) || RANGES[1])[1];
}

(function rangeControl() {
  const select = document.querySelector('#range-select');
  if (!select) return;
  select.innerHTML = RANGES.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  select.value = dashboardRange();
  select.addEventListener('change', () => {
    try { localStorage.setItem(RANGE_KEY, select.value); } catch { /* storage unavailable */ }
    document.dispatchEvent(new CustomEvent('workspace:range', { detail: { range: select.value } }));
  });
})();

/** Shows the date-range control only on pages whose figures it actually changes. */
function syncTopbarForRoute(hash) {
  const range = document.querySelector('#range-ctl');
  if (range) range.hidden = hash !== '#/';
  document.body.classList.toggle('route-home', hash === '#/');
}

// The REAL state of AI replies for the selected account (never "active" while the key is unusable or the switch is off).
let aiTimer;
async function pollAiStatus() {
  clearTimeout(aiTimer);
  const pill = document.querySelector('#ai-pill');
  if (!pill || !me) return;
  if (!can('dashboard')) { pill.hidden = true; return; }
  try {
    const state = await api('/api/dashboard/ai-status');
    pill.hidden = false;
    pill.dataset.state = state.state;
    pill.querySelector('.ai-label').textContent = state.label;
    pill.querySelector('.ai-detail').textContent = state.state === 'active' ? 'Real-time sync' : state.detail;
    pill.title = state.detail;
  } catch {
    pill.hidden = true;
  }
  aiTimer = setTimeout(pollAiStatus, 60000);
}
document.addEventListener('workspace:account-changed', () => { if (me) pollAiStatus(); });
