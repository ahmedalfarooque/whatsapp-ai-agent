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

async function api(url, options) {
  const response = await fetch(url, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = (body && body.error) || `Request failed (${response.status})`;
    throw new Error(message);
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
  const hash = location.hash || '#/';
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

window.addEventListener('hashchange', renderRoute);

// ---------------------------------------------------------------------
// Shared header bits (environment badge, sidebar mode note)
// ---------------------------------------------------------------------

async function loadHeader() {
  try {
    const status = await api('/api/dashboard/status');
    document.querySelector('#environment').textContent =
      status.environment === 'development' ? 'Development' : status.environment === 'production' ? 'Production' : status.environment;
    document.querySelector('#sidebar-mode').textContent =
      status.providerMode === 'mock' ? 'Read-only · mock providers' : 'Read-only · production providers';
  } catch {
    document.querySelector('#environment').textContent = 'Unavailable';
  }
}

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
        <h2>Your agent is ready to help.</h2>
        <p>${status.providerMode === 'mock' ? 'Running locally with safe mock providers and persistent SQLite memory.' : 'Production provider mode is active — real WhatsApp/OpenRouter/Google Calendar calls are made.'}</p>
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
            ? `<table class="data-table"><thead><tr><th>Customer</th><th>Start</th><th>End</th><th>Status</th><th>Calendar event</th></tr></thead><tbody>${data.items
                .map(
                  (b) =>
                    `<tr><td>${esc(b.customerLabel || b.waId)}</td><td>${formatDate(b.start_iso)}</td><td>${formatDate(b.end_iso)}</td><td>${badge(b.status, stateTone(b.status))}</td><td class="file">${esc(b.calendar_event_id || '—')}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : emptyView('No bookings recorded yet — bookings created through the WhatsApp agent appear here.')
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

route('#/integrations', 'Integrations', 'Configuration status only — opening this page never makes a real API call.', async (view) => {
  async function draw() {
    const data = await api('/api/dashboard/integrations');
    view.innerHTML = `
      <section class="panel">
        <div class="status-list">${data.integrations
          .map(
            (i) =>
              `<div class="status-row"><span class="status-name"><span class="dot ${stateTone(i.state) === 'green' || stateTone(i.state) === 'blue' ? 'green' : stateTone(i.state) === 'red' ? '' : ''}"></span>${esc(i.name)}</span><span class="state">${badge(i.state, stateTone(i.state))} <span class="muted">${esc(i.detail)}</span></span></div>`,
          )
          .join('')}</div>
        <div class="toolbar"><button id="refresh" class="btn">Re-check configuration</button></div>
        <p class="muted">This reads server configuration only. It never contacts WhatsApp, OpenRouter, or Google — that only happens when a real customer message is processed.</p>
      </section>`;
    view.querySelector('#refresh').addEventListener('click', async () => {
      await draw();
      toast('Configuration status refreshed', 'success');
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

route('#/settings', 'Settings', 'Server-controlled configuration — change these via .env and redeploy, not from the browser.', async (view) => {
  const data = await api('/api/dashboard/settings');
  view.innerHTML = `
    <section class="panel">
      <h3>Business</h3>
      <dl class="detail-grid">
        <dt>Name</dt><dd>${esc(data.business.name)}</dd>
        <dt>Timezone</dt><dd class="file">${esc(data.business.timezone)}</dd>
        <dt>Hours</dt><dd>${esc(data.business.hoursStart)} – ${esc(data.business.hoursEnd)}</dd>
        <dt>Open days (1=Mon..7=Sun)</dt><dd>${data.business.days.join(', ')}</dd>
      </dl>
      <h3>Booking</h3>
      <dl class="detail-grid">
        <dt>Default duration</dt><dd>${data.booking.durationMinutes} min</dd>
        <dt>Buffer</dt><dd>${data.booking.bufferMinutes} min</dd>
      </dl>
      <h3>Agent</h3>
      <dl class="detail-grid">
        <dt>Restart keywords</dt><dd>${data.agent.restartKeywords.map((k) => `<span class="file">${esc(k)}</span>`).join(', ')}</dd>
        <dt>Conversation history limit</dt><dd>${data.agent.conversationHistoryLimit} messages</dd>
      </dl>
      <h3>Security</h3>
      <dl class="detail-grid">
        <dt>Rate limit</dt><dd>${data.security.rateLimitPerMinute} requests / minute</dd>
        <dt>Max request body size</dt><dd>${esc(data.security.maxBodySize)}</dd>
      </dl>
      <p class="muted">These are read from the server's environment configuration (src/config/env.ts). This page cannot change them — there is no arbitrary environment-variable or file editor here on purpose.</p>
    </section>`;
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

loadHeader();
renderRoute();
