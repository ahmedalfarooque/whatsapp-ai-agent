// Rowad Alfa AI Workspace — WhatsApp connection, automation control center,
// manual reply editor, support queue, flow map, catalogue placeholders.
// Loaded after app.js and reuses its helpers (api, esc, badge, toast, route,
// formatDate, emptyView, disposeView). Every control here calls a real API.

// ---------------------------------------------------------------------
// Shared: connection status → human labels
// ---------------------------------------------------------------------

const QR_PHASES = {
  idle: { label: 'Not connected', tone: '', icon: '○', title: 'WhatsApp is not linked', explain: 'Click Connect to generate a QR code, then scan it from the phone that should answer customers.' },
  starting: { label: 'Preparing session', tone: 'amber', icon: '↻', title: 'Preparing the WhatsApp session', explain: 'Opening the socket. This takes a few seconds; if it stays here for more than 30 s use Retry Connection.' },
  scan: { label: 'QR code ready — waiting for scan', tone: 'amber', icon: '▦', title: 'Scan the QR code now', explain: 'WhatsApp → Linked devices → Link a device. The code rotates automatically; use Refresh QR Code if it goes stale.' },
  qr_expired: { label: 'QR code expired', tone: 'amber', icon: '⟳', title: 'The QR code expired', explain: 'Nobody scanned in time. Click Refresh QR Code for a new one.' },
  connecting: { label: 'Pairing / connecting', tone: 'amber', icon: '↻', title: 'Pairing in progress', explain: 'The phone was scanned or the saved session is being restored. WhatsApp usually finishes within 10 s.' },
  connected: { label: 'Connected', tone: 'green', icon: '✓', title: 'Device linked — WhatsApp connected', explain: 'Customer messages arrive on this server and automatic replies go out through this number.' },
  reconnecting: { label: 'Reconnecting', tone: 'amber', icon: '↻', title: 'Connection dropped — reconnecting', explain: 'WhatsApp closed the socket (this is routine); the saved session is reconnecting automatically.' },
  disconnected: { label: 'Disconnected', tone: 'red', icon: '✕', title: 'WhatsApp is disconnected', explain: 'Use Retry Connection to reconnect with the saved session.' },
  logged_out: { label: 'Logged out — authentication required', tone: '', icon: '○', title: 'Authentication required', explain: 'The session was removed (from the phone or via Log out). Scan a new QR code to link again.' },
  error: { label: 'Connection error', tone: 'red', icon: '!', title: 'Connection error', explain: 'See the last error below. Retry Connection re-opens the session; nothing is deleted.' },
};

function phaseInfo(phase) {
  return QR_PHASES[phase] || { label: phase || 'Unknown', tone: '', icon: '?' };
}

function updateHeaderConnection(status) {
  const pill = document.querySelector('#wa-pill');
  const text = document.querySelector('#wa-pill-text');
  const scope = document.querySelector('#scope-chip');
  const number = document.querySelector('#scope-number');
  if (!pill || !text) return;
  const info = phaseInfo(status.phase);
  pill.className = `wa-pill ${status.phase === 'connected' ? 'live' : info.tone === 'amber' ? 'warn' : 'off'}`;
  text.textContent = status.phase === 'connected' ? 'WhatsApp Live' : `WhatsApp: ${info.label}`;
  if (status.phoneNumber) {
    number.textContent = status.phoneNumber;
    scope.hidden = false;
  } else {
    scope.hidden = true;
  }
}

let headerTimer;
async function pollHeaderConnection() {
  clearTimeout(headerTimer);
  try {
    const [status, automation] = await Promise.all([api('/api/dashboard/whatsapp/qr'), api('/api/dashboard/automation')]);
    updateHeaderConnection(status);
    const drafts = automation.templates.filter((t) => t.hasDraft).length;
    const draftsEl = document.querySelector('#nav-drafts');
    draftsEl.textContent = drafts;
    draftsEl.hidden = drafts === 0;
    const supportEl = document.querySelector('#nav-support');
    supportEl.textContent = automation.pausedCustomers;
    supportEl.hidden = automation.pausedCustomers === 0;
  } catch {
    /* header is best-effort; the page itself reports errors */
  }
  headerTimer = setTimeout(pollHeaderConnection, 5000);
}
document.addEventListener('workspace:authenticated', pollHeaderConnection);

function confirmDialog(message) {
  return window.confirm(message);
}

// ---------------------------------------------------------------------
// WhatsApp Connection (QR pairing)
// ---------------------------------------------------------------------

route('#/whatsapp', 'WhatsApp Connection', 'Connect WhatsApp by scanning the QR code. The number that scans becomes the active agent number.', async (view) => {
  let timer;
  let disposed = false;
  let lastStatus = null;
  let acting = false;
  disposeView = () => { disposed = true; clearTimeout(timer); };

  view.innerHTML = `
    <div id="opstate"></div>
    <div class="conn-grid">
      <section class="panel">
        <p class="eyebrow">LINKED DEVICE · QR PAIRING</p>
        <h3 id="conn-title">Checking connection…</h3>
        <p class="muted" id="conn-explain"></p>
        <div class="linked-banner" id="linked-banner" hidden></div>
        <ol class="conn-steps" id="conn-steps">
          <li><span>1</span><div>Open WhatsApp on the phone that should answer customers.</div></li>
          <li><span>2</span><div>Tap <b>Settings</b> (or the ⋮ menu on Android) → <b>Linked devices</b> → <b>Link a device</b>.</div></li>
          <li><span>3</span><div>Point the camera at the code on the right. This page updates automatically — no refresh needed.</div></li>
        </ol>
        <dl class="kv" id="conn-kv"></dl>
        <div class="toolbar" style="margin-top:18px;flex-wrap:wrap">
          <button class="btn primary" id="btn-connect">Connect</button>
          <button class="btn" id="btn-refresh-qr">Refresh QR Code</button>
          <button class="btn" id="btn-retry" hidden>Retry Connection</button>
          <button class="btn ghost" id="btn-status">Refresh Status</button>
          <button class="btn danger" id="btn-logout" style="margin-left:auto">Log out &amp; unlink</button>
        </div>
        <details style="margin-top:14px"><summary class="muted" style="cursor:pointer">Runtime diagnostics</summary><dl class="kv" id="conn-diag" style="margin-top:8px"></dl></details>
        <details style="margin-top:10px"><summary class="muted" style="cursor:pointer">Troubleshooting</summary>
          <div class="trouble">
            <b>QR keeps expiring</b> — WhatsApp rotates codes every ~20–60 s. Have the phone ready before clicking Refresh QR Code.<br>
            <b>Stuck on “Pairing”</b> — the phone finished the scan but WhatsApp is still syncing; give it up to a minute, then Retry Connection.<br>
            <b>Reconnecting in a loop</b> — the phone lost internet or WhatsApp was force-closed. Open WhatsApp on the phone.<br>
            <b>Drops every minute or two (codes 408 / 428)</b> — the internet connection of <i>this server</i> is unstable (Wi-Fi, VPN, proxy). The session reconnects by itself; messages sent while it was down are answered when it is back. Nothing needs to be re-scanned.<br>
            <b>Logged out (code 401)</b> — WhatsApp removed this device (from the phone’s Linked devices, or WhatsApp invalidated the session). The old credentials are archived on the server; scan again to relink.<br>
            <b>Different number</b> — Log out &amp; unlink first, then scan with the other phone. The new number becomes the active agent number.
          </div>
        </details>
      </section>
      <section class="panel qr-stage">
        <div class="qr-frame" id="qr-frame"><span class="glyph">▦</span></div>
        <div class="qr-timer" id="qr-timer" hidden><span></span></div>
        <p class="muted" id="qr-meta" style="margin:0;font-size:12px"></p>
        <span class="badge" id="qr-badge">Checking…</span>
        <p class="muted" id="qr-detail" role="status" aria-live="polite">Loading connection status…</p>
        <div class="phone-big" id="qr-phone" hidden></div>
      </section>
    </div>`;

  const $ = (sel) => view.querySelector(sel);
  const frame = $('#qr-frame'); const badgeEl = $('#qr-badge'); const detailEl = $('#qr-detail'); const phoneEl = $('#qr-phone');
  const timerEl = $('#qr-timer'); const kv = $('#conn-kv'); const diag = $('#conn-diag');
  const btnConnect = $('#btn-connect'); const btnRefreshQr = $('#btn-refresh-qr'); const btnRetry = $('#btn-retry'); const btnStatus = $('#btn-status'); const btnLogout = $('#btn-logout');
  const allButtons = [btnConnect, btnRefreshQr, btnRetry, btnStatus, btnLogout];

  function paint(status) {
    if (disposed) return;
    lastStatus = status;
    const info = phaseInfo(status.phase);
    const connected = status.phase === 'connected';
    updateHeaderConnection(status);
    const diagNow = status.diagnostics || {};
    $('#conn-title').textContent = diagNow.networkUnstable && status.phase === 'reconnecting' ? 'Unstable network — reconnecting' : (info.title || info.label);
    $('#conn-explain').textContent = diagNow.networkUnstable && status.phase === 'reconnecting'
      ? `The socket dropped ${diagNow.dropsLast10Min} times in the last 10 minutes (WhatsApp codes 408/428 = no data / closed by the server). The saved session reconnects automatically; check this server's internet connection (Wi-Fi, VPN, proxy).`
      : (info.explain || '');
    $('#conn-steps').hidden = connected;
    const banner = $('#linked-banner');
    banner.hidden = !connected;
    if (connected) {
      banner.innerHTML = `<div class="ok-icon">✓</div><div><b>Device linked successfully — WhatsApp connected</b><br><span class="muted">Active number <b class="phone-inline">${esc(status.phoneNumber || 'unknown')}</b>${status.displayName ? ` · ${esc(status.displayName)}` : ''} · connected since ${formatDate(status.connectedAt)} · session saved on this server · automatic replies ${status.autoReplyReady === false ? 'paused' : 'ready'}.</span></div>`;
    }
    badgeEl.textContent = info.label;
    badgeEl.className = `badge ${info.tone}`;
    detailEl.textContent = status.available ? status.detail : 'QR linking needs a persistent Node server — it is unavailable in test and serverless environments.';

    frame.className = `qr-frame ${connected ? 'connected' : ''} ${status.phase === 'qr_expired' ? 'dim' : ''}`;
    frame.replaceChildren();
    const meta = $('#qr-meta');
    if (status.qr) {
      const img = document.createElement('img'); img.src = status.qr; img.alt = 'WhatsApp linking QR code'; frame.appendChild(img);
      const remaining = Math.max(0, new Date(status.qrExpiresAt).getTime() - Date.now());
      timerEl.hidden = false;
      timerEl.firstElementChild.style.transform = `scaleX(${Math.min(1, remaining / 60000)})`;
      meta.textContent = `QR generated ${status.qrGeneratedAt ? new Date(status.qrGeneratedAt).toLocaleTimeString() : ''} · expires in ${Math.ceil(remaining / 1000)} s`;
    } else {
      const glyph = document.createElement('span'); glyph.className = 'glyph'; glyph.textContent = info.icon; frame.appendChild(glyph);
      timerEl.hidden = true;
      meta.textContent = connected ? 'No QR needed — the session is linked.' : '';
      if (status.phase === 'qr_expired') { const overlay = document.createElement('div'); overlay.className = 'qr-overlay'; overlay.textContent = 'Expired — click Refresh QR Code'; frame.appendChild(overlay); }
    }
    phoneEl.hidden = !status.phoneNumber;
    phoneEl.textContent = status.phoneNumber || '';

    const d = status.diagnostics || {};
    kv.innerHTML = `
      <dt>Status</dt><dd>${badge(info.label, info.tone)}</dd>
      <dt>Active number</dt><dd class="phone-big" style="font-size:16px">${status.phoneNumber ? esc(status.phoneNumber) : '<span class="muted">Not paired yet</span>'}</dd>
      <dt>Profile name</dt><dd>${esc(status.displayName || '—')}</dd>
      <dt>Connected since</dt><dd>${status.connectedAt ? formatDate(status.connectedAt) : '—'}</dd>
      <dt>Last disconnect</dt><dd>${status.disconnectedAt ? formatDate(status.disconnectedAt) : '—'}${d.lastDisconnectCode ? ` <span class="muted">(code ${esc(d.lastDisconnectCode)})</span>` : ''}</dd>
      <dt>QR generated</dt><dd>${status.qrGeneratedAt ? formatDate(status.qrGeneratedAt) : '—'}</dd>
      <dt>Saved session</dt><dd>${status.hasSavedSession ? badge('On this server', 'green') : badge('None', '')}</dd>
      <dt>Session owner</dt><dd>${d.ownsAuthStore ? badge(`This server · pid ${esc(d.pid)}`, 'green') : d.ownerPid ? badge(`Another process · pid ${esc(d.ownerPid)}`, 'red') : badge('Unclaimed', '')}</dd>
      <dt>Reconnect attempts</dt><dd>${status.reconnectAttempts || 0}</dd>
      <dt>Last error</dt><dd class="${status.lastError ? '' : 'muted'}">${esc(status.lastError || 'None')}</dd>`;
    diag.innerHTML = `
      <dt>Process</dt><dd>pid ${esc(d.pid)} · port ${esc(d.port)}</dd>
      <dt>Working directory</dt><dd class="file">${esc(d.cwd || '')}</dd>
      <dt>Socket generation</dt><dd>${esc(d.socketGeneration)} · active sockets: ${esc(d.activeSockets)}</dd>
      <dt>Last connection event</dt><dd>${d.lastConnectionEvent ? `${esc(d.lastConnectionEvent.type)}${d.lastConnectionEvent.statusCode ? ' (' + esc(d.lastConnectionEvent.statusCode) + ')' : ''} · ${formatDate(d.lastConnectionEvent.at)}` : '—'}</dd>
      <dt>Socket open since</dt><dd>${d.connectedSince ? formatDate(d.connectedSince) : '—'}</dd>
      <dt>Drops (last 10 min)</dt><dd>${esc(d.dropsLast10Min ?? 0)}${d.lastCloseAt ? ` · last ${formatDate(d.lastCloseAt)}` : ''}${d.networkUnstable ? ' ' + badge('Unstable network', 'amber') : ''}</dd>
      <dt>WhatsApp Web version</dt><dd>${d.versionSource === 'fetched' ? 'fetched from Baileys' : d.versionSource === 'cached' ? 'cached (last known good)' : d.versionSource === 'library_default' ? 'library default' : '—'}</dd>
      <dt>Last QR event</dt><dd>${d.lastQrAt ? formatDate(d.lastQrAt) : '—'}</dd>`;

    const busy = acting || ['starting', 'connecting'].includes(status.phase);
    btnConnect.hidden = connected || ['scan', 'qr_expired', 'reconnecting', 'disconnected', 'error'].includes(status.phase);
    btnConnect.disabled = !status.available || busy;
    btnRefreshQr.disabled = !status.available || busy || connected || status.phase === 'idle' || status.phase === 'logged_out';
    btnRefreshQr.title = connected ? 'WhatsApp is already connected — no QR is needed.' : 'Generate a fresh QR code (credentials are never deleted).';
    btnRetry.hidden = !['reconnecting', 'disconnected', 'error', 'starting'].includes(status.phase);
    btnRetry.disabled = !status.available || acting;
    btnStatus.disabled = acting;
    btnLogout.disabled = !status.available || busy || (['idle', 'logged_out'].includes(status.phase) && !status.hasSavedSession);
    $('#opstate').innerHTML = renderOpState(status, null);
  }

  async function poll() {
    clearTimeout(timer);
    if (disposed) return;
    try { paint(await api('/api/dashboard/whatsapp/qr')); } catch (error) { if (!disposed) detailEl.textContent = error.message; }
    if (!disposed) timer = setTimeout(poll, lastStatus && lastStatus.phase === 'scan' ? 1500 : 3000);
  }

  async function act(action, confirmText, labels) {
    if (acting) return;
    if (confirmText && !confirmDialog(confirmText)) return;
    acting = true;
    allButtons.forEach((b) => { b.disabled = true; });
    const btn = labels && labels.button; const original = btn ? btn.textContent : '';
    if (btn) btn.textContent = labels.working;
    try {
      const status = await api(`/api/dashboard/whatsapp/qr/${action}`, { method: 'POST' });
      paint(status);
      if (action === 'refresh') {
        if (status.notice === 'already_connected') toast(`WhatsApp is already connected as ${status.phoneNumber || 'the linked number'} — no new QR needed.`, 'success');
        else if (status.notice === 'busy') toast('The session is changing right now; wait a moment and try again.', 'error');
        else toast('New QR code requested. Scan it within 60 seconds.', 'success');
      } else if (action === 'retry') {
        toast(status.notice === 'not_needed' ? `No retry needed — current state: ${phaseInfo(status.phase).label}.` : 'Reconnecting with the saved session…', 'success');
      } else if (action === 'status') {
        toast(`Status refreshed: ${phaseInfo(status.phase).label}${status.phoneNumber ? ' · ' + status.phoneNumber : ''}.`, 'success');
      } else if (action === 'disconnect') {
        toast('Session unlinked. Scan a QR code to connect a phone.', 'success');
      } else if (action === 'connect') {
        toast('Session starting — the QR code appears here in a few seconds.', 'success');
      }
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      acting = false;
      if (btn) btn.textContent = original;
      await poll();
    }
  }
  btnConnect.addEventListener('click', () => act('connect', null, { button: btnConnect, working: 'Starting…' }));
  btnRefreshQr.addEventListener('click', () => act('refresh', null, { button: btnRefreshQr, working: 'Refreshing…' }));
  btnRetry.addEventListener('click', () => act('retry', null, { button: btnRetry, working: 'Retrying…' }));
  btnStatus.addEventListener('click', () => act('status', null, { button: btnStatus, working: 'Checking…' }));
  btnLogout.addEventListener('click', () => act('disconnect', 'Log out this WhatsApp number and delete the saved session on this server? You will need to scan a QR code again, and customers get no automatic replies until then.', { button: btnLogout, working: 'Logging out…' }));
  await poll();
});

function renderOpState(conn, automation) {
  const info = phaseInfo(conn.phase);
  const connected = conn.phase === 'connected';
  let title;
  let tone;
  let icon = info.icon;
  if (!connected) {
    title = conn.phase === 'scan' ? 'Waiting for QR scan' : conn.phase === 'connecting' || conn.phase === 'starting' ? 'Connecting to WhatsApp' : 'WhatsApp disconnected';
    tone = info.tone === 'amber' ? 'warn' : 'off';
  } else if (automation && !automation.settings.autoRepliesEnabled) {
    title = 'Automatic replies paused';
    tone = 'warn';
    icon = '⏸';
  } else if (automation && !automation.settings.ruleRepliesEnabled && !automation.settings.aiRepliesEnabled) {
    title = 'Manual support mode';
    tone = 'warn';
    icon = '☎';
  } else {
    title = 'Automatic replies active';
    tone = 'live';
    icon = '⚡';
  }
  const chips = [];
  chips.push(badge(connected ? `WhatsApp connected${conn.phoneNumber ? ' · ' + conn.phoneNumber : ''}` : info.label, connected ? 'green' : info.tone));
  if (automation) {
    chips.push(badge(automation.settings.ruleRepliesEnabled ? 'Menu rules on' : 'Menu rules off', automation.settings.ruleRepliesEnabled ? 'blue' : ''));
    chips.push(badge(automation.settings.aiRepliesEnabled ? 'AI replies on' : 'AI replies off', automation.settings.aiRepliesEnabled ? 'purple' : ''));
    if (automation.pausedCustomers) chips.push(badge(`${automation.pausedCustomers} waiting for a human`, 'amber'));
  }
  return `<section class="opstate ${tone}"><div class="icon">${icon}</div><div><p class="eyebrow">OPERATING STATE</p><h3>${esc(title)}</h3><p class="muted">${esc(conn.detail || '')}</p></div><div class="chips">${chips.join('')}</div></section>`;
}

// ---------------------------------------------------------------------
// Automatic Reply Control Center
// ---------------------------------------------------------------------

route('#/automation', 'Auto-Reply Control Center', 'Decide what answers customers automatically: menu rules, AI, or a person.', async (view) => {
  let timer;
  let disposed = false;
  disposeView = () => { disposed = true; clearTimeout(timer); };

  async function draw() {
    const [data, conn, activity, errors] = await Promise.all([
      api('/api/dashboard/automation'),
      api('/api/dashboard/whatsapp/qr'),
      api('/api/dashboard/automation/activity?limit=40'),
      api('/api/dashboard/automation/activity?kind=error&limit=10'),
    ]);
    if (disposed) return;
    const s = data.settings;
    const published = data.templates.filter((t) => !t.hasDraft);
    const drafts = data.templates.filter((t) => t.hasDraft);

    const toggle = (key, label, sub, checked, disabled) => `
      <label class="switch ${disabled ? 'disabled' : ''}"><input type="checkbox" data-key="${key}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span class="track"></span><span><span class="label">${label}</span><span class="sub">${sub}</span></span></label>`;

    view.innerHTML = `
      ${renderOpState(conn, data)}
      <div class="cc-grid">
        <section class="panel">
          <p class="eyebrow">REPLY MODES</p><h3>What answers customers</h3>
          <div class="toggle-list" style="margin-top:14px">
            ${toggle('autoRepliesEnabled', 'Automatic replies', 'Master switch. Off = every message is stored but nothing is sent.', s.autoRepliesEnabled, false)}
            ${toggle('ruleRepliesEnabled', 'Rule-based menu replies', 'Language selection, main menu, category prompts, restart, change language.', s.ruleRepliesEnabled, !s.autoRepliesEnabled)}
            ${toggle('aiRepliesEnabled', 'AI replies (OpenRouter)', 'Free-text questions answered from the knowledge base. Off = customers get the “AI disabled” template.', s.aiRepliesEnabled, !s.autoRepliesEnabled)}
          </div>
          <p class="muted" style="margin-top:14px">Human support mode is per customer: a customer who types <b>agent</b>, <b>موظف</b>, etc. is paused and listed in the <a href="#/support">Support Queue</a>. Staff can also pause any customer from their profile.</p>
        </section>
        <section class="panel">
          <p class="eyebrow">FALLBACK &amp; HANDOFF</p><h3>Safety templates</h3>
          <div class="rule-list">
            ${['fallback_error', 'ai_disabled', 'human_support', 'unsupported_message'].map((k) => {
              const t = data.templates.find((x) => x.key === k);
              return t ? `<div class="rule-row"><a href="#/replies/${k}">${esc(t.titleEn)}</a>${badge(t.hasDraft ? 'draft pending' : t.isModified ? 'customised' : 'default', t.hasDraft ? 'amber' : t.isModified ? 'blue' : '')}</div>` : '';
            }).join('')}
          </div>
          <p class="muted" style="margin-top:12px">Business-hours and after-hours behaviour is not implemented yet; the assistant answers 24/7 while connected.</p>
        </section>
        <section class="panel">
          <p class="eyebrow">RULES</p><h3>${published.length} live · ${drafts.length} with drafts</h3>
          <div class="rule-list">
            ${data.templates.map((t) => `<div class="rule-row"><a href="#/replies/${esc(t.key)}"><span dir="rtl">${esc(t.titleAr)}</span> · ${esc(t.titleEn)}</a>${badge(t.hasDraft ? 'draft' : 'published', t.hasDraft ? 'amber' : 'green')}</div>`).join('')}
          </div>
        </section>
        <section class="panel">
          <p class="eyebrow">RECENT REPLY ACTIVITY</p><h3>Last ${activity.activity.length} events</h3>
          ${activity.activity.length ? `<div class="act-list">${activity.activity.map((a) => `<div class="act-row ${esc(a.kind)}"><span class="k"></span><span>${esc(labelKind(a.kind))}${a.templateKey ? ` · <span class="file">${esc(a.templateKey)}</span>` : ''}${a.detail ? ` — ${esc(a.detail)}` : ''}<br><span class="muted">${esc(a.channel)} · ${esc(maskNumber(a.waId))}</span></span><time>${formatDate(a.createdAt)}</time></div>`).join('')}</div>` : emptyView('No replies sent yet. Activity appears here as customers message the connected number.')}
        </section>
        <section class="panel">
          <p class="eyebrow">ERRORS &amp; FAILED REPLIES</p><h3>${errors.activity.length ? `${errors.activity.length} recent` : 'None'}</h3>
          ${errors.activity.length ? `<div class="act-list">${errors.activity.map((a) => `<div class="act-row error"><span class="k"></span><span>${esc(a.detail || 'Error')}<br><span class="muted">${esc(a.channel)} · ${esc(maskNumber(a.waId))}</span></span><time>${formatDate(a.createdAt)}</time></div>`).join('')}</div>` : '<p class="muted">No failed replies recorded.</p>'}
        </section>
        <section class="panel">
          <p class="eyebrow">TEST A REPLY FLOW</p><h3>Try it from a phone</h3>
          <p class="muted">Send <b>restart</b> from any WhatsApp number to the connected agent number: you should receive the restart confirmation and the language selection, then <b>1</b>/<b>2</b> picks a language and shows the menu. Every step is logged above. No test messages are sent from this page — only real customer traffic is answered.</p>
        </section>
      </div>`;

    view.querySelectorAll('.switch input').forEach((input) => {
      input.addEventListener('change', async () => {
        const key = input.dataset.key;
        try {
          await api('/api/dashboard/automation', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: input.checked }) });
          toast('Automation settings saved', 'success');
          await draw();
        } catch (error) {
          input.checked = !input.checked;
          toast(error.message, 'error');
        }
      });
    });
    timer = setTimeout(draw, 10000);
  }
  await draw();
});

function labelKind(kind) {
  return { rule: 'Menu rule', ai: 'AI reply', human_handoff: 'Handed to human', suppressed: 'Suppressed', error: 'Error' }[kind] || kind;
}
function maskNumber(v) {
  if (!v) return '—';
  const d = String(v).replace(/\D/g, '');
  return d.length > 4 ? `${'•'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}` : d;
}

// ---------------------------------------------------------------------
// Human Support Queue
// ---------------------------------------------------------------------

route('#/support', 'Human Support Queue', 'Customers whose automation is paused and are waiting for a person.', async (view) => {
  async function draw() {
    const data = await api('/api/dashboard/support-queue');
    view.innerHTML = `
      <section class="panel">
        <div class="panel-head"><div><p class="eyebrow">WAITING FOR A HUMAN</p><h3>${data.queue.length} customer${data.queue.length === 1 ? '' : 's'}</h3></div></div>
        ${data.queue.length ? `<table class="data-table"><thead><tr><th>Customer</th><th>Number</th><th>Last message</th><th>Paused</th><th>Reason</th><th></th></tr></thead><tbody>
          ${data.queue.map((c) => `<tr><td>${esc(c.display_name || 'Customer')} ${c.language ? badge(c.language.toUpperCase(), 'blue') : ''}</td><td class="file">${esc(maskNumber(c.wa_id))}</td><td style="max-width:320px">${esc(c.lastMessage || '—')}</td><td>${formatDate(c.paused_at)}</td><td class="muted">${esc(c.pause_reason || '—')}</td><td><a class="btn small" href="#/conversations">Open chats</a> <button class="btn small success" data-resume="${c.id}">Resume automation</button></td></tr>`).join('')}
        </tbody></table>` : emptyView('No one is waiting. When a customer asks for a person (e.g. “agent” or “موظف”), they appear here and automatic replies stop for them until you resume.')}
        <p class="muted" style="margin-top:14px">Reply to these customers from the WhatsApp app on the connected phone; the workspace only pauses the assistant. Resuming sends the main menu again.</p>
      </section>`;
    view.querySelectorAll('[data-resume]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/api/dashboard/customers/${btn.dataset.resume}/resume`, { method: 'POST' });
        toast('Automation resumed for this customer', 'success');
        await draw();
      } catch (error) {
        toast(error.message, 'error');
        btn.disabled = false;
      }
    }));
  }
  await draw();
});

// ---------------------------------------------------------------------
// Manual Reply Editor — three panels: templates · editor · WhatsApp preview
// ---------------------------------------------------------------------

async function renderReplyEditor(view, selectedKey) {
  const { templates } = await api('/api/dashboard/templates');
  const categories = [...new Set(templates.map((t) => t.category))];
  const state = { key: selectedKey || (templates[0] && templates[0].key), lang: 'ar', search: '', category: '', status: '', dirty: false, working: { ar: '', en: '' } };

  view.innerHTML = `
    <div class="toolbar">
      <input type="search" id="tpl-search" placeholder="Search templates…" aria-label="Search templates">
      <select id="tpl-cat" aria-label="Filter by category"><option value="">All categories</option>${categories.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
      <select id="tpl-status" aria-label="Filter by status"><option value="">All statuses</option><option value="draft">Has draft</option><option value="published">Published only</option><option value="modified">Customised</option><option value="default">Default text</option></select>
      <span class="muted" style="margin-left:auto">${templates.length} templates · ${templates.filter((t) => t.hasDraft).length} drafts</span>
    </div>
    <div class="editor-layout">
      <aside class="panel" style="padding:14px"><p class="eyebrow" style="margin:4px 4px 10px">MESSAGE TEMPLATES</p><div class="tpl-list" id="tpl-list"></div></aside>
      <section class="panel" id="tpl-editor"></section>
      <aside class="wa-preview" id="tpl-preview"></aside>
    </div>`;

  const listEl = view.querySelector('#tpl-list');
  const editorEl = view.querySelector('#tpl-editor');
  const previewEl = view.querySelector('#tpl-preview');
  const current = () => templates.find((t) => t.key === state.key);

  function drawList() {
    const q = state.search.trim().toLowerCase();
    const visible = templates.filter((t) =>
      (!state.category || t.category === state.category) &&
      (!state.status || (state.status === 'draft' ? t.hasDraft : state.status === 'published' ? !t.hasDraft : state.status === 'default' ? !t.isModified : t.isModified)) &&
      (!q || `${t.titleAr} ${t.titleEn} ${t.key}`.toLowerCase().includes(q)));
    if (!visible.length) { listEl.innerHTML = emptyView('No templates match.'); return; }
    let lastCat = '';
    listEl.innerHTML = visible.map((t) => {
      const head = t.category !== lastCat ? `<div class="tpl-cat">${esc(t.category.toUpperCase())}</div>` : '';
      lastCat = t.category;
      return `${head}<button type="button" class="tpl-item ${t.key === state.key ? 'active' : ''}" data-key="${esc(t.key)}" aria-current="${t.key === state.key}"><div class="t-ar">${esc(t.titleAr)}</div><div class="t-en"><span>${esc(t.titleEn)}</span>${badge(t.hasDraft ? 'draft' : 'published', t.hasDraft ? 'amber' : 'green')}</div></button>`;
    }).join('');
    listEl.querySelectorAll('.tpl-item').forEach((b) => b.addEventListener('click', () => select(b.dataset.key)));
  }

  function select(key) {
    if (state.dirty && !confirmDialog('You have unsaved changes. Discard them?')) return;
    state.key = key;
    state.dirty = false;
    const t = current();
    state.working = { ar: t.draftAr ?? t.liveAr, en: t.draftEn ?? t.liveEn };
    history.replaceState(null, '', `#/replies/${encodeURIComponent(key)}`);
    drawList();
    drawEditor();
    drawPreview();
  }

  function drawEditor() {
    const t = current();
    if (!t) { editorEl.innerHTML = emptyView('Select a template.'); return; }
    const isAr = state.lang === 'ar';
    const text = state.working[state.lang];
    editorEl.innerHTML = `
      <div class="panel-head" style="align-items:center;flex-wrap:wrap;gap:10px">
        <div><p class="eyebrow">${esc(t.category.toUpperCase())} · <span class="file">${esc(t.key)}</span></p><h3><span dir="rtl">${esc(t.titleAr)}</span> <span class="muted">(${esc(t.titleEn)})</span></h3>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${badge(t.hasDraft ? 'Draft saved · not live' : 'Published', t.hasDraft ? 'amber' : 'green')}${t.isModified ? badge('Customised from default', 'blue') : badge('Default text', '')}${t.sourceType === 'data-driven' ? badge('Data-driven: {maps}/{hours}/{address}/{offers} filled from live settings', 'purple') : ''}${t.dataFallback ? badge(`Falls back to ${t.dataFallback} when there is no data`, 'amber') : ''}${t.fallbackOf ? badge(`Sent when ${t.fallbackOf} has no data`, '') : ''}</div></div>
        <div class="lang-tabs" role="tablist"><button role="tab" data-lang="ar" class="${isAr ? 'active' : ''}">العربية</button><button role="tab" data-lang="en" class="${isAr ? '' : 'active'}">English</button></div>
      </div>
      <label class="muted" for="tpl-text">Message content (${isAr ? 'Arabic · RTL' : 'English · LTR'})</label>
      <textarea id="tpl-text" class="editor ${isAr ? 'rtl' : 'ltr'}" dir="${isAr ? 'rtl' : 'ltr'}" lang="${state.lang}" spellcheck="true">${esc(text)}</textarea>
      <div class="placeholders"><span class="muted">Insert:</span>${['{name}', '{business}', '{maps}', '{hours}', '{address}', '{notes}', '{offers}', '{reference}'].map((p) => `<code data-ph="${p}">${p}</code>`).join('')}</div>
      <div class="editor-meta">
        <span>Characters: <b id="tpl-count">${text.length}</b> · <b id="tpl-lines">${text.split('\n').length}</b> lines</span>
        <span id="tpl-dirty" class="unsaved" ${state.dirty ? '' : 'hidden'}>● Unsaved changes</span>
        <span class="muted">Updated ${formatDate(t.updatedAt)}${t.updatedBy ? ` by ${esc(t.updatedBy)}` : ''}</span>
      </div>
      <div class="toolbar" style="margin-top:16px;margin-bottom:0">
        <button class="btn" id="tpl-save-draft">Save Draft</button>
        <button class="btn success" id="tpl-publish">Publish to Live WhatsApp</button>
        ${t.hasDraft ? '<button class="btn ghost" id="tpl-discard">Discard draft</button>' : ''}
        <button class="btn ghost" id="tpl-reset" style="margin-left:auto" ${t.isModified || t.hasDraft ? '' : 'disabled'}>Reset to Default</button>
      </div>
      <p class="muted" style="margin-top:12px">Drafts are never sent to customers. Only <b>Publish to Live WhatsApp</b> changes what the assistant replies.</p>`;

    const ta = editorEl.querySelector('#tpl-text');
    ta.addEventListener('input', () => {
      state.working[state.lang] = ta.value;
      state.dirty = true;
      editorEl.querySelector('#tpl-count').textContent = ta.value.length;
      editorEl.querySelector('#tpl-lines').textContent = ta.value.split('\n').length;
      editorEl.querySelector('#tpl-dirty').hidden = false;
      drawPreview();
    });
    editorEl.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => { state.lang = b.dataset.lang; drawEditor(); drawPreview(); }));
    editorEl.querySelectorAll('[data-ph]').forEach((c) => c.addEventListener('click', () => {
      const start = ta.selectionStart; const end = ta.selectionEnd;
      ta.setRangeText(c.dataset.ph, start, end, 'end');
      ta.dispatchEvent(new Event('input'));
      ta.focus();
    }));

    async function mutate(action, body, successMessage, confirmText) {
      if (confirmText && !confirmDialog(confirmText)) return;
      const empty = !state.working.ar.trim() || !state.working.en.trim();
      if (action !== 'reset' && action !== 'discard-draft' && empty) { toast('Both Arabic and English content are required before saving or publishing.', 'error'); return; }
      editorEl.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        const updated = await api(`/api/dashboard/templates/${encodeURIComponent(t.key)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        Object.assign(t, updated);
        state.dirty = false;
        state.working = { ar: updated.draftAr ?? updated.liveAr, en: updated.draftEn ?? updated.liveEn };
        toast(successMessage, 'success');
        drawList(); drawEditor(); drawPreview();
        pollHeaderConnection();
      } catch (error) {
        toast(error.message, 'error');
        drawEditor();
      }
    }
    editorEl.querySelector('#tpl-save-draft').addEventListener('click', () => mutate('draft', state.working, 'Draft saved. Live replies are unchanged.'));
    editorEl.querySelector('#tpl-publish').addEventListener('click', () => mutate('publish', state.working, 'Published. Future WhatsApp replies use this text.', 'Publish this text to live WhatsApp replies? Customers will receive the new wording immediately.'));
    const discard = editorEl.querySelector('#tpl-discard');
    if (discard) discard.addEventListener('click', () => mutate('discard-draft', {}, 'Draft discarded.', 'Discard the saved draft? The live text stays as it is.'));
    editorEl.querySelector('#tpl-reset').addEventListener('click', () => mutate('reset', {}, 'Restored the default text as live.', 'Reset this message to the original default text and publish it? Your customised wording will be replaced.'));
  }

  // Optimistic local substitution while the server answer is in flight; the
  // authoritative text always comes from POST /templates/:key/preview, which
  // runs the SAME renderer the WhatsApp sender uses (renderTemplateText).
  // Local echo only shows the raw text while the server renders; every placeholder is resolved server-side.
  function localRender(text) {
    return text.replace(/\{name\}/g, 'Ahmed').replace(/\{reference\}/g, 'INQ-2026-1234');
  }
  function bubble(text, isAr, when) {
    const dir = isAr ? 'rtl' : 'ltr';
    return `<div class="wa-row"><div class="wa-msg out ${dir}" dir="${dir}"><span class="wa-text">${esc(text)}</span><span class="wa-meta">${esc(when)} <i>✓✓</i></span></div></div>`;
  }
  let previewTimer;
  let previewSeq = 0;
  function drawPreview() {
    const t = current();
    if (!t) { previewEl.innerHTML = ''; return; }
    const isAr = state.lang === 'ar';
    const working = state.working[state.lang];
    const label = state.dirty ? 'Unsaved draft' : t.hasDraft ? 'Saved draft · not live' : 'Published · live';
    const tone = state.dirty || t.hasDraft ? 'amber' : 'green';
    const when = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const paint = (text, followUp, confirmed) => {
      previewEl.innerHTML = `
        <div class="wa-head">
          <span class="wa-avatar">RA</span>
          <span class="wa-title"><b>Rowad Alfa Auto Care</b><small>Business account · ${isAr ? 'العربية · RTL' : 'English · LTR'}</small></span>
          ${badge(label, tone)}${confirmed && state.previewMeta ? badge(state.previewMeta.sourceType === 'data-driven' ? 'Data-driven' : 'Static', state.previewMeta.sourceType === 'data-driven' ? 'purple' : '') : ''}
        </div>
        <div class="wa-body ${isAr ? 'rtl' : 'ltr'}">
          <div class="wa-day">Today</div>
          ${bubble(text, isAr, when)}
          ${followUp ? `<div class="wa-then">then, automatically</div>${bubble(followUp.text, isAr, when)}` : ''}
          ${confirmed && state.previewMeta && state.previewMeta.fallback ? `<div class="wa-then">right now customers get this instead</div>${bubble(state.previewMeta.fallback.text, isAr, when)}<div class="wa-then" style="text-transform:none;letter-spacing:0">${esc(state.previewMeta.fallback.reason)} (<a href="#/replies/${esc(state.previewMeta.fallback.key)}">${esc(state.previewMeta.fallback.key)}</a>)</div>` : ''}
        </div>
        <div class="wa-note">${confirmed ? 'Exact text customers receive — rendered by the live resolver.' : 'Rendering with the live resolver…'} Nothing is sent. Placeholders show sample values.${followUp ? ` The second bubble is the live <a href="#/replies/${esc(followUp.key)}">${esc(followUp.key)}</a> template.` : ''}</div>`;
    };
    paint(localRender(working), null, false);
    clearTimeout(previewTimer);
    const seq = ++previewSeq;
    previewTimer = setTimeout(async () => {
      try {
        const res = await api(`/api/dashboard/templates/${encodeURIComponent(t.key)}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ar: state.working.ar, en: state.working.en }) });
        if (seq !== previewSeq) return;
        state.previewMeta = { sourceType: res.sourceType, fallback: res.fallback && res.fallback[state.lang] };
        paint(res[state.lang], res.followUp && res.followUp[state.lang], true);
      } catch (error) {
        if (seq === previewSeq) previewEl.querySelector('.wa-note').textContent = `Preview service unavailable: ${error.message}`;
      }
    }, 180);
  }

  view.querySelector('#tpl-search').addEventListener('input', (e) => { state.search = e.target.value; drawList(); });
  view.querySelector('#tpl-cat').addEventListener('change', (e) => { state.category = e.target.value; drawList(); });
  view.querySelector('#tpl-status').addEventListener('change', (e) => { state.status = e.target.value; drawList(); });
  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } }, { once: true });

  if (state.key) {
    const t = current();
    state.working = { ar: t.draftAr ?? t.liveAr, en: t.draftEn ?? t.liveEn };
  }
  drawList(); drawEditor(); drawPreview();
}

route('#/replies', 'Manual Reply Editor', 'Edit every automated message in Arabic and English. Save drafts freely — only Publish changes live replies.', (view) => renderReplyEditor(view));
route(/^#\/replies\/(?<key>[\w-]+)$/, 'Manual Reply Editor', 'Edit every automated message in Arabic and English. Save drafts freely — only Publish changes live replies.', (view, params) => renderReplyEditor(view, params.key));

// ---------------------------------------------------------------------
// Auto-Reply Flow Map — derived from live template statuses
// ---------------------------------------------------------------------

route('#/flow', 'Auto-Reply Flow Map', 'How an incoming message travels through the assistant — built from the router\'s real menu tree and the live templates.', async (view) => {
  const [data, conn, tree, ai] = await Promise.all([api('/api/dashboard/automation'), api('/api/dashboard/whatsapp/qr'), api('/api/dashboard/menu-tree'), api('/api/dashboard/ai')]);
  const t = (k) => data.templates.find((x) => x.key === k) || { titleEn: k, titleAr: '', hasDraft: false };
  const node = (k, label, note) => `<div class="rule-row"><a href="#/replies/${k}"><b>${esc(label || t(k).titleEn)}</b>${note ? `<br><span class="muted">${esc(note)}</span>` : ''}</a>${badge(t(k).hasDraft ? 'draft pending' : 'live', t(k).hasDraft ? 'amber' : 'green')}</div>`;
  const optionLabel = (o) => o.handoff ? 'Talk to staff → pauses automation, joins Support Queue' : o.flow ? `${o.flow === 'appointment' ? 'Appointment' : 'Quotation'} flow (${tree.flows[o.flow].fields.length} questions)` : t(o.template).titleEn;
  const optionKey = (o) => o.handoff ? 'human_support' : o.flow ? tree.flows[o.flow].intro : o.template;
  const list = (options) => Object.entries(options).map(([n, o]) => node(optionKey(o), `${n} · ${optionLabel(o)}`, o.state ? `→ ${o.state.replace('SUBMENU_', '').toLowerCase()} submenu` : '')).join('');
  const submenuTitle = { SUBMENU_AUDIO: 'Car Audio', SUBMENU_ACCESSORIES: 'Car Accessories', SUBMENU_CARE: 'Car Care', SUBMENU_TINT: 'Tinting & Protection', SUBMENU_PRICES: 'Prices & Offers' };
  view.innerHTML = `
    ${renderOpState(conn, data)}
    <div class="cc-grid">
      <section class="panel"><p class="eyebrow">STEP 1 · FIRST CONTACT</p><h3>Language selection</h3><div class="rule-list">${node('language_selection', 'Welcome & language selection', 'Any first message. 1 = العربية, 2 = English (or type the language).')}${node('language_reprompt', 'Language re-prompt', 'Anything else while no language is chosen.')}</div></section>
      <section class="panel"><p class="eyebrow">STEP 2 · MAIN MENU</p><h3>Main menu (numbers route by state)</h3><div class="rule-list">${node('main_menu', 'Main menu', 'Sent in the chosen language. Option numbers below are fixed by the router; the wording is editable.')}${list(tree.mainMenu)}${node('invalid_option', 'Invalid choice', 'Unknown number → this bubble, then the main menu again.')}</div></section>
      ${Object.entries(tree.submenus).map(([state, sub]) => `<section class="panel"><p class="eyebrow">SUBMENU</p><h3>${esc(submenuTitle[state] || state)}</h3><div class="rule-list">${node(sub.menuTemplate, null, '0 returns to the main menu; free text goes to the AI.')}${list(sub.options)}</div></section>`).join('')}
      <section class="panel"><p class="eyebrow">FLOW</p><h3>Appointment request (main menu 7)</h3><div class="rule-list">${tree.flows.appointment.steps.map((k, i) => node(k, `Question ${i + 1} · ${tree.flows.appointment.fields[i]}`)).join('')}${node('appointment_confirm', 'Confirmation', 'Saved as a pending request with a reference (staff confirm on the Bookings page).')}</div></section>
      <section class="panel"><p class="eyebrow">FLOW</p><h3>Custom quotation (prices 4)</h3><div class="rule-list">${tree.flows.quotation.steps.map((k, i) => node(k, `Question ${i + 1} · ${tree.flows.quotation.fields[i]}`)).join('')}${node('quotation_confirm', 'Confirmation', 'Saved as a pending request with an INQ reference.')}</div></section>
      <section class="panel"><p class="eyebrow">ANY TIME</p><h3>Universal commands</h3><div class="rule-list">${node('main_menu', '0 · menu · القائمة · back · greetings', 'Reopen the main menu from any state.')}${node('language_switch_prompt', 'language · اللغة · change language', 'Then 1/2 confirms:')}${node('language_changed', 'Language changed', 'Followed by the main menu in the new language.')}${node('restart_confirmation', 'restart · reset · 00', 'Clears language and menu position, then step 1.')}${node('human_support', 'agent · support · موظف · خدمة العملاء', 'Pauses automation for that customer; "menu"/"0" resumes.')}</div></section>
      <section class="panel"><p class="eyebrow">FREE TEXT</p><h3>AI answer</h3><div class="rule-list"><div class="rule-row"><span><b>OpenRouter · ${esc(ai.model)}</b><br><span class="muted">Any text that is not a number or a command. Grounded in Knowledge Sources; replies in the customer's language.</span></span>${badge(data.settings.aiRepliesEnabled ? 'on' : 'off', data.settings.aiRepliesEnabled ? 'purple' : '')}</div>${node('ai_disabled', 'AI disabled notice', 'Sent instead when AI replies are switched off.')}${node('fallback_error', 'Fallback / error', 'Sent if the AI call fails.')}${node('unsupported_message', 'Non-text message', 'Images, voice notes, stickers.')}</div></section>
    </div>`;
});

// ---------------------------------------------------------------------
// WhatsApp-collected requests (appointment / quotation) — rendered inside
// the Bookings page under the calendar bookings table.
// ---------------------------------------------------------------------
window.renderWhatsappRequests = async function renderWhatsappRequests(host) {
  const draw = async () => {
    let data;
    try { data = await api('/api/dashboard/requests?limit=100'); } catch (error) { host.innerHTML = `<section class="panel"><p class="form-error">${esc(error.message)}</p><button class="btn" id="req-retry">Retry</button></section>`; host.querySelector('#req-retry').addEventListener('click', draw); return; }
    const rows = data.requests;
    const fields = (r) => Object.entries(r.payload).map(([k, v]) => `<span class="muted">${esc(k)}:</span> ${esc(v)}`).join(' · ');
    const notif = (n) => `<span class="badge ${n.status === 'sent' ? 'green' : n.status === 'failed' ? 'red' : 'amber'}" title="${esc(n.last_error || '')}">${esc(n.kind.replace(/_/g, ' '))}: ${esc(n.status)}${n.status === 'pending' && n.attempts ? ` (retry ${n.attempts})` : ''}</span>`;
    const timeline = (r) => r.events.length ? r.events.map((e) => `<div class="muted" style="font-size:11.5px">${formatDate(e.created_at)} · ${esc(e.old_status || '—')} → <b>${esc(e.new_status)}</b> · ${esc(e.actor)}${e.actor_detail ? ' (' + esc(e.actor_detail) + ')' : ''}</div>`).join('') : '<span class="muted" style="font-size:11.5px">No status changes yet</span>';
    const ob = data.outbox || {};
    host.innerHTML = `
      <section class="panel" style="margin-top:20px">
        <div class="panel-head"><div><p class="eyebrow">WHATSAPP MENU · TWO-WAY</p><h3>Appointment & quotation requests</h3><p class="muted">Collected by the guided menu (main menu 7, prices 4). Changing the status here notifies the customer once per status and alerts the business WhatsApp; the operator can also reply <span class="file">CONFIRM APT-…</span> from the business account. Staff alerts go to: ${data.staffTarget === 'linked' ? badge('linked business number', 'green') : badge('no linked number', 'red')}.</p></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${badge(`${data.pending} pending`, data.pending ? 'amber' : '')}${badge(`notifications: ${ob.sent || 0} sent · ${ob.pending || 0} pending · ${ob.failed || 0} failed`, ob.failed ? 'red' : ob.pending ? 'amber' : '')}<button class="btn small" id="req-flush">Retry pending notifications</button></div></div>
        ${rows.length ? `<table class="data-table"><thead><tr><th>Reference</th><th>Type</th><th>Customer</th><th>Details</th><th>Received</th><th>Status</th><th>Notifications · history</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="file">${esc(r.reference)}</td><td>${esc(r.kind)}</td><td>${esc(maskNumber(r.wa_id))}</td><td style="max-width:360px;font-size:12.5px">${fields(r)}</td><td>${formatDate(r.created_at)}</td><td><select data-id="${r.id}" class="req-status" aria-label="Request status">${data.statuses.map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td><td style="max-width:320px"><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px">${r.notifications.length ? r.notifications.map(notif).join('') : '<span class="muted" style="font-size:11.5px">no notifications</span>'}</div>${timeline(r)}</td></tr>`).join('')}</tbody></table>` : emptyView('No WhatsApp requests yet. They appear here when a customer completes the appointment or quotation questions.')}
      </section>`;
    host.querySelectorAll('.req-status').forEach((sel) => sel.addEventListener('change', async () => {
      const previous = [...sel.options].find((o) => o.defaultSelected)?.value;
      if (['rejected', 'cancelled'].includes(sel.value) && !confirmDialog(`Set this request to "${sel.value}"? The customer will be notified automatically.`)) { sel.value = previous; return; }
      sel.disabled = true;
      try {
        const res = await api(`/api/dashboard/requests/${sel.dataset.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: sel.value }) });
        toast(res.changed ? `Status saved · ${res.queued} notification(s) queued.` : 'Status unchanged.', 'success');
        await draw();
      } catch (error) { toast(error.message, 'error'); sel.disabled = false; }
    }));
    host.querySelector('#req-flush').addEventListener('click', async () => {
      try { const res = await api('/api/dashboard/notifications/flush', { method: 'POST' }); toast(`${res.delivered} notification(s) delivered.`, 'success'); await draw(); } catch (error) { toast(error.message, 'error'); }
    });
  };
  await draw();
};

// ---------------------------------------------------------------------
// Catalogue & business pages — real data where it exists, honest planned
// states where the backend does not yet store the entity.
// ---------------------------------------------------------------------

function plannedPage(title, body, items, link) {
  return `<section class="panel planned"><p class="eyebrow">NOT YET IMPLEMENTED</p><h3>${esc(title)}</h3><p class="muted">${esc(body)}</p><ul class="plan-list">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>${link ? `<p style="margin-top:14px"><a class="btn" href="${link.href}">${esc(link.label)}</a></p>` : ''}</section>`;
}

route('#/products', 'Products Book', 'Bilingual product catalogue with verified pricing.', async (view) => {
  view.innerHTML = plannedPage(
    'Product catalogue is not stored in this application yet',
    'The assistant currently answers product questions from Knowledge Sources (knowledge/services.md). A structured products table with images, availability and “Price on Request” handling is planned but has no backend today — this page will stay empty rather than show sample data.',
    ['Bilingual name/description per product', 'Price status: Price Confirmed · Starting From · Price on Request (never SAR 0)', 'Availability and inquiry toggle', 'Image upload with type/size validation'],
    { href: '#/knowledge', label: 'Edit product facts in Knowledge Sources →' },
  );
});
route('#/prices', 'Verified Price Book', 'Only confirmed prices reach customers. Everything else is “Price on Request”.', async (view) => {
  const data = await api('/api/dashboard/services');
  view.innerHTML = `
    <section class="panel"><p class="eyebrow">ZERO-FABRICATED-PRICING RULE</p><h3>What the assistant may quote</h3>
      <p class="muted">The AI is instructed to quote only prices written in Knowledge Sources and to answer “Price on Request / السعر عند الطلب” for anything else. The current source of truth is <span class="file">${esc(data.sourceFile)}</span>:</p>
      ${data.available ? `<pre class="content-view" style="margin-top:12px">${esc(data.content)}</pre>` : emptyView('knowledge/services.md does not exist yet.')}
      <a class="btn" href="#/knowledge/${encodeURIComponent(data.sourceFile)}">Edit verified prices →</a></section>
    ${plannedPage('Structured price book', 'A per-item price table with confirmation status and audit trail is planned; until then prices live in the knowledge file above.', ['Per product/service confirmed price', 'Who confirmed it and when', 'Automatic “Price on Request” for unconfirmed items'])}`;
});
// ---------------------------------------------------------------------
// Shared: business documents panel (uploads) — used by Business Profile
// ---------------------------------------------------------------------
const DOC_ICONS = { pdf: '📄', ppt: '📊', pptx: '📊', doc: '📝', docx: '📝', html: '🌐', htm: '🌐', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', webp: '🖼️', txt: '📃', md: '📃' };
function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'; }
async function uploadDocument(file, visibility, title, replaceId) {
  const headers = { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Visibility': visibility || 'internal' };
  if (title) headers['X-Title'] = encodeURIComponent(title);
  const url = replaceId ? `/api/dashboard/documents/${replaceId}/file` : '/api/dashboard/documents';
  return api(url, { method: replaceId ? 'PUT' : 'POST', headers, body: file });
}
async function renderDocumentsPanel(host, opts = {}) {
  const draw = async () => {
    const data = await api('/api/dashboard/documents');
    const docs = data.documents;
    host.innerHTML = `
      <section class="panel">
        <div class="panel-head"><div><p class="eyebrow">BUSINESS DOCUMENTS</p><h3>Brochures, price lists, presentations</h3><p class="muted">Allowed: ${data.limits.allowed.join(', ')} · max ${fmtBytes(data.limits.maxBytes)}. HTML is stored but never executed (served as plain text). Nothing is sent to customers automatically.</p></div></div>
        <form id="doc-upload" class="toolbar" style="flex-wrap:wrap">
          <input type="file" id="doc-file" accept=".pdf,.ppt,.pptx,.doc,.docx,.html,.htm,.png,.jpg,.jpeg,.webp,.txt,.md" required>
          <input type="text" id="doc-title" placeholder="Title (optional)" style="min-width:200px">
          <select id="doc-visibility"><option value="internal">Internal only</option><option value="ai_knowledge">AI knowledge only</option><option value="customer">Customer-visible when requested</option></select>
          <button class="btn primary" type="submit">Upload</button>
        </form>
        ${docs.length ? `<table class="data-table"><thead><tr><th></th><th>Name</th><th>Type</th><th>Size</th><th>Uploaded</th><th>Processing</th><th>Visibility</th><th>State</th><th></th></tr></thead><tbody>${docs.map((d) => `<tr class="${d.status === 'archived' ? 'muted' : ''}">
          <td style="font-size:20px">${d.mime_type.startsWith('image/') ? `<img src="${d.fileUrl}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:6px">` : DOC_ICONS[d.extension] || '📎'}</td>
          <td><b>${esc(d.title || d.original_name)}</b>${d.title ? `<br><span class="muted">${esc(d.original_name)}</span>` : ''}</td>
          <td>.${esc(d.extension)}</td><td>${fmtBytes(d.size_bytes)}</td><td>${formatDate(d.created_at)}</td>
          <td>${badge(d.processing === 'text_extracted' ? 'Text extracted' : d.processing === 'stored' ? 'Stored' : 'Stored (no text extraction)', d.processing === 'text_extracted' ? 'green' : '')}</td>
          <td><select data-id="${d.id}" class="doc-vis">${['internal', 'ai_knowledge', 'customer'].map((v) => `<option value="${v}" ${v === d.visibility ? 'selected' : ''}>${v === 'internal' ? 'Internal only' : v === 'ai_knowledge' ? 'AI knowledge only' : 'Customer-visible'}</option>`).join('')}</select></td>
          <td>${badge(d.status, d.status === 'active' ? 'green' : '')}</td>
          <td><div class="toolbar" style="margin:0;gap:4px;flex-wrap:wrap">
            <a class="btn small" href="${d.fileUrl}" target="_blank" rel="noopener">View</a>
            <a class="btn small" href="${d.fileUrl}?download=1">Download</a>
            <label class="btn small" style="cursor:pointer">Replace<input type="file" hidden class="doc-replace" data-id="${d.id}"></label>
            <button class="btn small doc-toggle" data-id="${d.id}" data-next="${d.status === 'active' ? 'archived' : 'active'}">${d.status === 'active' ? 'Archive' : 'Restore'}</button>
            <button class="btn small danger doc-delete" data-id="${d.id}">Delete</button>
          </div></td></tr>`).join('')}</tbody></table>` : emptyView('No documents uploaded yet.')}
      </section>`;
    host.querySelector('#doc-upload').addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = host.querySelector('#doc-file').files[0];
      if (!file) return;
      try { await uploadDocument(file, host.querySelector('#doc-visibility').value, host.querySelector('#doc-title').value); toast('Document uploaded.', 'success'); await draw(); if (opts.onChange) opts.onChange(); }
      catch (error) { toast(error.message, 'error'); }
    });
    host.querySelectorAll('.doc-vis').forEach((sel) => sel.addEventListener('change', async () => {
      try { await api(`/api/dashboard/documents/${sel.dataset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility: sel.value }) }); toast('Visibility updated.', 'success'); } catch (error) { toast(error.message, 'error'); }
    }));
    host.querySelectorAll('.doc-toggle').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/dashboard/documents/${b.dataset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.next }) }); await draw(); } catch (error) { toast(error.message, 'error'); }
    }));
    host.querySelectorAll('.doc-replace').forEach((inp) => inp.addEventListener('change', async () => {
      const file = inp.files[0]; if (!file) return;
      try { await uploadDocument(file, null, null, inp.dataset.id); toast('File replaced.', 'success'); await draw(); } catch (error) { toast(error.message, 'error'); }
    }));
    host.querySelectorAll('.doc-delete').forEach((b) => b.addEventListener('click', async () => {
      if (!confirmDialog('Delete this document permanently? Offers or the profile logo referencing it will lose the file.')) return;
      try { await api(`/api/dashboard/documents/${b.dataset.id}`, { method: 'DELETE' }); toast('Document deleted.', 'success'); await draw(); if (opts.onChange) opts.onChange(); } catch (error) { toast(error.message, 'error'); }
    }));
  };
  await draw();
}

function fieldRow(label, name, value, opts = {}) {
  const v = value === null || value === undefined ? '' : value;
  const input = opts.textarea
    ? `<textarea name="${name}" rows="${opts.rows || 3}" dir="${opts.dir || 'auto'}">${esc(v)}</textarea>`
    : `<input type="${opts.type || 'text'}" name="${name}" value="${esc(v)}" placeholder="${esc(opts.placeholder || '')}" dir="${opts.dir || 'auto'}" ${opts.step ? `step="${opts.step}"` : ''}>`;
  return `<label class="muted">${esc(label)}</label><div>${input}${opts.help ? `<div class="field-help">${opts.help}</div>` : ''}<div class="form-error" data-err="${name}" hidden></div></div>`;
}
function readForm(form, numeric = []) {
  const out = {};
  new FormData(form).forEach((val, key) => {
    const v = String(val).trim();
    out[key] = v === '' ? null : numeric.includes(key) ? Number(v) : v;
  });
  return out;
}
function showFieldErrors(form, fields) {
  form.querySelectorAll('[data-err]').forEach((el) => { el.hidden = true; el.textContent = ''; });
  Object.entries(fields || {}).forEach(([k, msg]) => { const el = form.querySelector(`[data-err="${k}"]`); if (el) { el.hidden = false; el.textContent = msg; } });
}

// ---------------------------------------------------------------------
// Business Profile — editable, one resolver ({business}, AI prompt, dashboard)
// ---------------------------------------------------------------------
route('#/business', 'Business Profile', 'Identity the assistant uses when it introduces the business — published here, used by WhatsApp templates and the AI.', async (view) => {
  let profile;
  try { profile = await api('/api/dashboard/business-profile'); } catch (error) { view.innerHTML = `<section class="panel"><p class="form-error">${esc(error.message)}</p></section>`; return; }
  const s = profile.settings;
  const logo = s.logoDocumentId ? `<img src="/api/dashboard/documents/${s.logoDocumentId}/file" alt="Logo" style="width:72px;height:72px;object-fit:cover;border-radius:16px">` : '<div class="brand-mark" style="width:72px;height:72px;display:grid;place-items:center;font-size:26px">RA</div>';
  view.innerHTML = `
    <div class="cc-grid">
      <section class="panel">
        <div class="panel-head" style="align-items:center;gap:14px">${logo}<div><p class="eyebrow">IDENTITY · LIVE</p><h3 id="bp-name">${esc(s.businessName)}</h3><p class="muted" dir="rtl">${esc(s.businessNameAr || '')}</p></div></div>
        <dl class="detail-grid">
          <dt>Active WhatsApp number</dt><dd>${profile.activeNumber ? `<b class="phone-inline">${esc(profile.activeNumber)}</b>${profile.activeProfileName ? ` · ${esc(profile.activeProfileName)}` : ''}` : '<span class="muted">Not linked — see WhatsApp Connection</span>'}</dd>
          <dt>Category</dt><dd>${esc(s.businessCategory || '—')}</dd>
          <dt>Address</dt><dd>${esc(profile.rendered.addressEn || '—')}<br><span dir="rtl">${esc(profile.rendered.addressAr || '')}</span></dd>
          <dt>Google Maps</dt><dd><a href="${esc(s.googleMapsUrl)}" target="_blank" rel="noopener">${esc(s.googleMapsUrl)}</a></dd>
          <dt>Opening hours</dt><dd style="white-space:pre-line">${esc(profile.rendered.hoursEn)}</dd>
          <dt>Last updated</dt><dd>${profile.updatedAt ? formatDate(profile.updatedAt) : '—'}</dd>
        </dl>
        <p class="muted">Templates use <span class="file">{business}</span>, <span class="file">{address}</span>, <span class="file">{maps}</span> and <span class="file">{hours}</span>; the AI receives the same facts. Hours and map link are edited on <a href="#/location">Location &amp; Hours</a>.</p>
      </section>
      <section class="panel">
        <p class="eyebrow">EDIT PROFILE</p><h3>Business details</h3>
        <form id="bp-form"><div class="detail-grid">
          ${fieldRow('Business name (English)', 'businessName', s.businessName)}
          ${fieldRow('Business name (Arabic)', 'businessNameAr', s.businessNameAr, { dir: 'rtl' })}
          ${fieldRow('Category', 'businessCategory', s.businessCategory, { placeholder: 'Automotive accessories, car audio, car care…' })}
          ${fieldRow('Description (English)', 'descriptionEn', s.descriptionEn, { textarea: true })}
          ${fieldRow('Description (Arabic)', 'descriptionAr', s.descriptionAr, { textarea: true, dir: 'rtl' })}
          ${fieldRow('Logo document id', 'logoDocumentId', s.logoDocumentId, { type: 'number', help: 'Upload an image below, then enter its id (shown in the table).' })}
          ${fieldRow('Staff alerts WhatsApp number', 'staffWhatsappNumber', s.staffWhatsappNumber, { placeholder: '+9665XXXXXXXX', help: 'Where new-request alerts and status changes are sent. Leave empty to use the linked business number\'s own chat.' })}
        </div>
        <div class="toolbar" style="margin-top:14px"><button class="btn success" type="submit">Save &amp; publish live</button><span class="muted" id="bp-status"></span></div>
        <p class="muted">Saving publishes immediately: the next WhatsApp reply and the AI prompt use the new values — no restart. (Profile fields have no separate draft stage; templates do.)</p></form>
      </section>
    </div>
    <div id="bp-docs" style="margin-top:20px"></div>`;
  const form = view.querySelector('#bp-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = readForm(form, ['logoDocumentId']);
    try {
      const updated = await api('/api/dashboard/business-profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      showFieldErrors(form, {});
      toast('Business profile published.', 'success');
      view.querySelector('#bp-name').textContent = updated.settings.businessName;
      view.querySelector('#bp-status').textContent = `Saved ${formatDate(updated.updatedAt)}`;
    } catch (error) {
      showFieldErrors(form, error.fields);
      toast(error.fields ? 'Please fix the highlighted fields.' : error.message, 'error');
    }
  });
  await renderDocumentsPanel(view.querySelector('#bp-docs'));
});

// ---------------------------------------------------------------------
// Location & Hours — editable; feeds {maps}/{hours}/{address} + AI + booking hours
// ---------------------------------------------------------------------
route('#/location', 'Location & Hours', 'What customers receive when they choose Location & Opening Hours — one published source for WhatsApp, preview and AI.', async (view) => {
  let profile;
  let tpl;
  try { [profile, tpl] = await Promise.all([api('/api/dashboard/business-profile'), api('/api/dashboard/templates/location_hours')]); }
  catch (error) { view.innerHTML = `<section class="panel"><p class="form-error">${esc(error.message)}</p></section>`; return; }
  const s = profile.settings;
  const mapEmbed = (lat, lng, url) => {
    if (typeof lat === 'number' && typeof lng === 'number') return `<iframe title="Map" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" loading="lazy" style="width:100%;height:260px;border:0;border-radius:12px" src="https://maps.google.com/maps?q=${lat},${lng}&z=15&output=embed"></iframe>`;
    return `<div class="state-block" style="height:260px;display:grid;place-items:center;border:1px dashed var(--line-2);border-radius:12px">No coordinates yet — enter latitude/longitude to preview the marker.<br><a class="btn" style="margin-top:10px" href="${esc(url)}" target="_blank" rel="noopener">Open in Google Maps ↗</a></div>`;
  };
  view.innerHTML = `
    <div class="cc-grid">
      <section class="panel">
        <p class="eyebrow">PUBLISHED · WHAT CUSTOMERS GET</p><h3>Location &amp; Opening Hours</h3>
        <div id="loc-map">${mapEmbed(s.latitude, s.longitude, s.googleMapsUrl)}</div>
        <dl class="detail-grid" style="margin-top:12px">
          <dt>Google Maps</dt><dd><a href="${esc(s.googleMapsUrl)}" target="_blank" rel="noopener">${esc(s.googleMapsUrl)}</a></dd>
          <dt>Address</dt><dd>${esc(profile.rendered.addressEn || '—')}<br><span dir="rtl">${esc(profile.rendered.addressAr || '')}</span></dd>
          <dt>Hours (EN)</dt><dd style="white-space:pre-line">${esc(profile.rendered.hoursEn)}</dd>
          <dt>Hours (AR)</dt><dd style="white-space:pre-line" dir="rtl">${esc(profile.rendered.hoursAr)}</dd>
          <dt>Timezone</dt><dd>${esc(s.businessTimezone)}</dd>
        </dl>
        <p class="muted">Template <a href="#/replies/location_hours">location_hours</a> renders <span class="file">{address}</span>, <span class="file">{maps}</span>, <span class="file">{hours}</span> from these values ${tpl.hasDraft ? badge('draft pending', 'amber') : badge('live', 'green')}. Booking availability uses the same days/hours.</p>
      </section>
      <section class="panel">
        <p class="eyebrow">EDIT LOCATION</p><h3>Address, map &amp; hours</h3>
        <form id="loc-form"><div class="detail-grid">
          ${fieldRow('Location / branch name', 'businessName', s.businessName)}
          ${fieldRow('Address (English)', 'addressEn', s.addressEn, { placeholder: 'Street, district, city' })}
          ${fieldRow('Address (Arabic)', 'addressAr', s.addressAr, { dir: 'rtl' })}
          ${fieldRow('Google Maps link', 'googleMapsUrl', s.googleMapsUrl, { help: 'Paste a maps.app.goo.gl / maps.google.com link. Default: https://maps.app.goo.gl/8sxNK9wMNsTucvCh7' })}
          ${fieldRow('Latitude', 'latitude', s.latitude, { type: 'number', step: 'any', placeholder: '21.4…' })}
          ${fieldRow('Longitude', 'longitude', s.longitude, { type: 'number', step: 'any', placeholder: '39.2…', help: 'Right-click the spot in Google Maps → copy the coordinates. Map selection by click needs a Maps API key, which this app does not use.' })}
          ${fieldRow('Working days (1=Mon … 7=Sun)', 'businessDays', (s.businessDays || []).join(','), { help: 'Comma-separated. Saudi week Sat–Thu = 6,7,1,2,3,4 (+5 for Friday).' })}
          ${fieldRow('Opening time', 'businessHoursStart', s.businessHoursStart, { placeholder: '09:00' })}
          ${fieldRow('Closing time', 'businessHoursEnd', s.businessHoursEnd, { placeholder: '22:00' })}
          ${fieldRow('Friday opening', 'fridayHoursStart', s.fridayHoursStart, { placeholder: '16:00', help: 'Leave empty if Friday follows the normal hours.' })}
          ${fieldRow('Friday closing', 'fridayHoursEnd', s.fridayHoursEnd, { placeholder: '22:00' })}
          ${fieldRow('Extra instructions (English)', 'locationNotesEn', s.locationNotesEn, { textarea: true, rows: 2 })}
          ${fieldRow('Extra instructions (Arabic)', 'locationNotesAr', s.locationNotesAr, { textarea: true, rows: 2, dir: 'rtl' })}
        </div>
        <div class="toolbar" style="margin-top:14px"><button class="btn success" type="submit">Save &amp; publish live</button><span class="muted" id="loc-status"></span></div>
        <p class="muted">Publishing is immediate — the next “Location &amp; Opening Hours” reply uses these values without a restart.</p></form>
      </section>
    </div>`;
  const form = view.querySelector('#loc-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = readForm(form, ['latitude', 'longitude']);
    try {
      const updated = await api('/api/dashboard/business-profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      showFieldErrors(form, {});
      toast('Location & hours published live.', 'success');
      view.querySelector('#loc-status').textContent = `Saved ${formatDate(updated.updatedAt)}`;
      view.querySelector('#loc-map').innerHTML = mapEmbed(updated.settings.latitude, updated.settings.longitude, updated.settings.googleMapsUrl);
    } catch (error) {
      showFieldErrors(form, error.fields);
      toast(error.fields ? 'Please fix the highlighted fields.' : error.message, 'error');
    }
  });
});

// ---------------------------------------------------------------------
// Offers & Discounts — full lifecycle; customers only ever see the resolver output
// ---------------------------------------------------------------------
const OFFER_STATUS_TONE = { published: 'green', scheduled: 'blue', draft: 'amber', expired: '', finished: '', archived: '' };
route('#/offers', 'Offers & Discounts', 'Promotions the assistant may mention. Customers see only published, in-date, customer-visible offers.', async (view) => {
  const state = { q: '', status: '', category: '', from: '', to: '', layout: 'grid', editing: null };
  let data;
  const draw = async () => {
    try { data = await api('/api/dashboard/offers'); } catch (error) { view.innerHTML = `<section class="panel"><p class="form-error">${esc(error.message)}</p></section>`; return; }
    const cats = [...new Set(data.offers.map((o) => o.category).filter(Boolean))];
    const visible = data.offers.filter((o) =>
      (!state.status || o.effectiveStatus === state.status) &&
      (!state.category || o.category === state.category) &&
      (!state.q || `${o.title_ar} ${o.title_en} ${o.description_ar} ${o.description_en} ${o.related_item || ''}`.toLowerCase().includes(state.q.toLowerCase())) &&
      (!state.from || !o.ends_at || o.ends_at >= new Date(state.from).toISOString()) &&
      (!state.to || !o.starts_at || o.starts_at <= new Date(state.to + 'T23:59:59').toISOString()));
    const k = data.kpis;
    const priceLine = (o) => o.price_status === 'verified'
      ? [o.promotional_price !== null ? `${o.currency} ${o.promotional_price}` : '', o.original_price !== null ? `<s class="muted">${o.currency} ${o.original_price}</s>` : '', o.discount_percent !== null ? `−${o.discount_percent}%` : ''].filter(Boolean).join(' ')
      : o.price_status === 'contact' ? 'Contact us for details' : 'Price on request';
    const card = (o) => `<article class="offer-card ${state.layout}">
        ${o.image_document_id ? `<img class="offer-img" src="/api/dashboard/documents/${o.image_document_id}/file" alt="">` : '<div class="offer-img placeholder">🎁</div>'}
        <div class="offer-body">
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${badge(o.effectiveStatus, OFFER_STATUS_TONE[o.effectiveStatus] || '')}${o.visibility === 'internal' ? badge('internal only', '') : ''}${o.customerVisibleNow ? badge('visible to customers now', 'green') : ''}${o.category ? badge(o.category, 'blue') : ''}</div>
          <h4>${esc(o.title_en)}</h4><p dir="rtl" class="muted" style="margin:0">${esc(o.title_ar)}</p>
          <p class="muted" style="font-size:12.5px">${esc(o.description_en).slice(0, 160)}</p>
          <p style="margin:6px 0"><b>${priceLine(o)}</b></p>
          <p class="muted" style="font-size:11.5px">${o.starts_at ? 'From ' + formatDate(o.starts_at) : ''}${o.ends_at ? ' · until ' + formatDate(o.ends_at) : ''} · priority ${o.priority} · updated ${formatDate(o.updated_at)}${o.updated_by ? ' by ' + esc(o.updated_by) : ''}</p>
          <div class="toolbar" style="margin:0;gap:4px;flex-wrap:wrap">
            <button class="btn small" data-act="preview" data-id="${o.id}">Preview</button>
            <button class="btn small" data-act="edit" data-id="${o.id}">Edit</button>
            <button class="btn small" data-act="duplicate" data-id="${o.id}">Duplicate</button>
            ${o.status === 'published' ? `<button class="btn small" data-act="unpublish" data-id="${o.id}">Unpublish</button><button class="btn small" data-act="finish" data-id="${o.id}">Mark finished</button>` : ''}
            ${o.status === 'draft' ? `<button class="btn small success" data-act="publish" data-id="${o.id}">Publish</button>` : ''}
            ${o.status === 'finished' || o.status === 'archived' ? `<button class="btn small" data-act="restore" data-id="${o.id}">Restore to draft</button>` : ''}
            ${o.status !== 'archived' ? `<button class="btn small" data-act="archive" data-id="${o.id}">Archive</button>` : ''}
            <button class="btn small danger" data-act="delete" data-id="${o.id}">Delete</button>
          </div>
        </div></article>`;
    view.innerHTML = `
      <section class="stats">${[['Active (published now)', k.published, 'green'], ['Drafts', k.draft, 'amber'], ['Scheduled', k.scheduled, 'blue'], ['Expired / finished', k.expired + k.finished, ''], ['Archived', k.archived, '']].map(([l, v]) => `<div class="stat"><div class="stat-label"><span>${l}</span></div><div class="stat-value">${v}</div></div>`).join('')}</section>
      <section class="panel" style="margin-bottom:18px">
        <div class="panel-head"><div><p class="eyebrow">WHAT CUSTOMERS SEE RIGHT NOW · Prices &amp; Offers → 3</p><h3>${data.customerVisible.length ? `${data.customerVisible.length} offer(s) go out via the prices_offers_list template` : 'No offers are visible — customers get the “No Current Offers” template'}</h3></div><a class="btn" href="#/replies/prices_offers_list">Open in Reply Editor →</a></div>
        ${data.preview.en.length ? `<div class="wa-preview" style="max-height:none;position:static"><div class="wa-body ltr" style="min-height:0">${data.preview.en.map((t) => `<div class="wa-row"><div class="wa-msg out ltr"><span class="wa-text">${esc(t)}</span></div></div>`).join('')}</div></div>` : ''}
      </section>
      <div class="toolbar" style="flex-wrap:wrap">
        <input type="search" id="of-q" placeholder="Search offers…" value="${esc(state.q)}">
        <select id="of-status"><option value="">All statuses</option>${['published', 'scheduled', 'draft', 'expired', 'finished', 'archived'].map((s) => `<option ${state.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="of-cat"><option value="">All categories</option>${cats.map((c) => `<option ${state.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <input type="date" id="of-from" value="${state.from}" title="Valid on/after"><input type="date" id="of-to" value="${state.to}" title="Valid on/before">
        <div class="lang-tabs"><button data-layout="grid" class="${state.layout === 'grid' ? 'active' : ''}">Grid</button><button data-layout="list" class="${state.layout === 'list' ? 'active' : ''}">List</button></div>
        <button class="btn primary" id="of-new" style="margin-left:auto">＋ New offer</button>
      </div>
      <div id="of-editor"></div>
      <div class="offer-grid ${state.layout}">${visible.length ? visible.map(card).join('') : emptyView('No offers match. Create one with “New offer”.')}</div>`;
    view.querySelector('#of-q').addEventListener('input', (e) => { state.q = e.target.value; draw(); });
    view.querySelector('#of-status').addEventListener('change', (e) => { state.status = e.target.value; draw(); });
    view.querySelector('#of-cat').addEventListener('change', (e) => { state.category = e.target.value; draw(); });
    view.querySelector('#of-from').addEventListener('change', (e) => { state.from = e.target.value; draw(); });
    view.querySelector('#of-to').addEventListener('change', (e) => { state.to = e.target.value; draw(); });
    view.querySelectorAll('[data-layout]').forEach((b) => b.addEventListener('click', () => { state.layout = b.dataset.layout; draw(); }));
    view.querySelector('#of-new').addEventListener('click', () => openEditor(null));
    view.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => onAction(b.dataset.act, Number(b.dataset.id))));
    if (state.editing !== null) openEditor(state.editing === 'new' ? null : data.offers.find((o) => o.id === state.editing));
  };
  async function onAction(act, id) {
    const o = data.offers.find((x) => x.id === id);
    if (act === 'edit') { openEditor(o); return; }
    if (act === 'preview') {
      const full = await api(`/api/dashboard/offers/${id}`);
      view.querySelector('#of-editor').innerHTML = `<section class="panel" style="margin:14px 0"><div class="panel-head"><div><p class="eyebrow">CUSTOMER PREVIEW · exactly as rendered in WhatsApp</p><h3>${esc(full.title_en)}</h3></div><button class="btn" id="of-close">Close</button></div>
        <div class="cc-grid"><div class="wa-preview" style="max-height:none;position:static"><div class="wa-body ltr" style="min-height:0"><div class="wa-row"><div class="wa-msg out ltr"><span class="wa-text">${esc(full.preview.en)}</span></div></div></div></div>
        <div class="wa-preview" style="max-height:none;position:static"><div class="wa-body rtl" style="min-height:0"><div class="wa-row"><div class="wa-msg out rtl" dir="rtl"><span class="wa-text">${esc(full.preview.ar)}</span></div></div></div></div></div>
        ${full.customerVisibleNow ? '' : `<p class="muted" style="margin-top:10px">Not visible to customers now (${esc(full.effectiveStatus)}${full.visibility === 'internal' ? ', internal' : ''}). The AI will not mention it.</p>`}</section>`;
      view.querySelector('#of-close').addEventListener('click', () => { view.querySelector('#of-editor').innerHTML = ''; });
      return;
    }
    if (act === 'delete' && !confirmDialog('Delete this offer? It is removed from the dashboard and customers; the record is kept for history.')) return;
    if (act === 'finish' && !confirmDialog('Mark this offer as finished? Customers stop seeing it immediately; the record is preserved.')) return;
    try {
      if (act === 'delete') await api(`/api/dashboard/offers/${id}`, { method: 'DELETE' });
      else await api(`/api/dashboard/offers/${id}/${act}`, { method: 'POST' });
      toast(`Offer ${act === 'duplicate' ? 'duplicated' : act === 'delete' ? 'deleted' : act + 'ed'}.`.replace('publishedd', 'published').replace('archiveed', 'archived').replace('finished.', 'marked finished.').replace('restoreed', 'restored').replace('unpublished', 'unpublished'), 'success');
      state.editing = null; await draw(); pollHeaderConnection();
    } catch (error) { toast(error.message, 'error'); }
  }
  function openEditor(o) {
    state.editing = o ? o.id : 'new';
    const host = view.querySelector('#of-editor');
    const v = o || { price_status: 'on_request', visibility: 'customer', currency: 'SAR', priority: 0 };
    const dt = (iso) => (iso ? iso.slice(0, 16) : '');
    host.innerHTML = `<section class="panel" style="margin:14px 0"><div class="panel-head"><div><p class="eyebrow">${o ? 'EDIT OFFER #' + o.id : 'NEW OFFER'}</p><h3>${o ? esc(o.title_en) : 'Create a draft offer'}</h3></div><button class="btn" id="of-cancel">Close</button></div>
      <form id="of-form"><div class="grid two">
        <div class="detail-grid">
          ${fieldRow('Title (English)', 'titleEn', v.title_en)}
          ${fieldRow('Title (Arabic)', 'titleAr', v.title_ar, { dir: 'rtl' })}
          ${fieldRow('Description (English)', 'descriptionEn', v.description_en, { textarea: true })}
          ${fieldRow('Description (Arabic)', 'descriptionAr', v.description_ar, { textarea: true, dir: 'rtl' })}
          ${fieldRow('Category', 'category', v.category, { placeholder: 'Tinting, PPF, Audio…' })}
          ${fieldRow('Related product / service', 'relatedItem', v.related_item)}
          ${fieldRow('Terms (English)', 'termsEn', v.terms_en, { textarea: true, rows: 2 })}
          ${fieldRow('Terms (Arabic)', 'termsAr', v.terms_ar, { textarea: true, rows: 2, dir: 'rtl' })}
        </div>
        <div class="detail-grid">
          <label class="muted">Pricing</label><div><select name="priceStatus">${[['on_request', 'Price on request (no numbers)'], ['contact', 'Contact us for details'], ['verified', 'Verified price — numbers allowed']].map(([k, l]) => `<option value="${k}" ${v.price_status === k ? 'selected' : ''}>${l}</option>`).join('')}</select><div class="field-help">Numeric prices are stored only when marked verified (zero-fabricated-pricing).</div></div>
          ${fieldRow('Original price', 'originalPrice', v.original_price, { type: 'number', step: 'any' })}
          ${fieldRow('Promotional price', 'promotionalPrice', v.promotional_price, { type: 'number', step: 'any' })}
          ${fieldRow('Discount %', 'discountPercent', v.discount_percent, { type: 'number', step: 'any' })}
          ${fieldRow('Currency', 'currency', v.currency)}
          ${fieldRow('Starts at', 'startsAt', dt(v.starts_at), { type: 'datetime-local' })}
          ${fieldRow('Ends at', 'endsAt', dt(v.ends_at), { type: 'datetime-local' })}
          ${fieldRow('Image document id', 'imageDocumentId', v.image_document_id, { type: 'number', help: '<label class="btn small" style="cursor:pointer;margin-top:4px">Upload image…<input type="file" hidden class="of-upload" data-target="imageDocumentId" accept=".png,.jpg,.jpeg,.webp"></label> <span class="of-upload-note"></span>' })}
          ${fieldRow('Supporting document id', 'documentId', v.document_id, { type: 'number', help: '<label class="btn small" style="cursor:pointer;margin-top:4px">Upload PDF / document…<input type="file" hidden class="of-upload" data-target="documentId" accept=".pdf,.ppt,.pptx,.doc,.docx,.html,.txt,.md"></label> <span class="of-upload-note"></span>' })}
          <label class="muted">Customer visibility</label><div><select name="visibility"><option value="customer" ${v.visibility === 'customer' ? 'selected' : ''}>Customer-visible</option><option value="internal" ${v.visibility === 'internal' ? 'selected' : ''}>Internal only</option></select></div>
          ${fieldRow('Priority', 'priority', v.priority, { type: 'number' })}
        </div></div>
        <div class="toolbar" style="margin-top:14px"><button class="btn primary" type="submit">${o ? 'Save changes' : 'Create draft'}</button>${o && o.status === 'draft' ? '<button class="btn success" type="button" id="of-save-publish">Save &amp; publish</button>' : ''}<span class="muted">Status: ${o ? esc(o.effectiveStatus) : 'draft (publish from the card)'}</span></div>
      </form></section>`;
    host.querySelector('#of-cancel').addEventListener('click', () => { state.editing = null; host.innerHTML = ''; });
    const form = host.querySelector('#of-form');
    host.querySelectorAll('.of-upload').forEach((inp) => inp.addEventListener('change', async () => {
      const file = inp.files[0]; if (!file) return;
      const note = inp.closest('.field-help').querySelector('.of-upload-note');
      note.textContent = 'Uploading…';
      try {
        const doc = await uploadDocument(file, 'customer', form.querySelector('[name=titleEn]').value || file.name);
        form.querySelector(`[name=${inp.dataset.target}]`).value = doc.id;
        note.textContent = `Uploaded #${doc.id} · ${doc.original_name}`;
        toast('File uploaded and linked to the offer.', 'success');
      } catch (error) { note.textContent = ''; toast(error.message, 'error'); }
    }));
    const submit = async (publishAfter) => {
      const body = readForm(form, ['originalPrice', 'promotionalPrice', 'discountPercent', 'priority', 'imageDocumentId', 'documentId']);
      try {
        const saved = o
          ? await api(`/api/dashboard/offers/${o.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          : await api('/api/dashboard/offers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (publishAfter) await api(`/api/dashboard/offers/${saved.id}/publish`, { method: 'POST' });
        showFieldErrors(form, {});
        toast(publishAfter ? 'Offer saved and published — live for customers now.' : o ? 'Offer saved.' : 'Draft offer created.', 'success');
        state.editing = null; await draw();
      } catch (error) { showFieldErrors(form, error.fields); toast(error.fields ? 'Please fix the highlighted fields.' : error.message, 'error'); }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
    const sp = host.querySelector('#of-save-publish'); if (sp) sp.addEventListener('click', () => submit(true));
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  await draw();
});

// ---------------------------------------------------------------------
// Analytics & Reports — real counts only
// ---------------------------------------------------------------------

route('#/analytics', 'Analytics & Reports', 'Counts from the live database. No estimates.', async (view) => {
  const [summary, activity, queue] = await Promise.all([api('/api/dashboard/summary'), api('/api/dashboard/automation/activity?limit=200'), api('/api/dashboard/support-queue')]);
  const byKind = activity.activity.reduce((m, a) => { m[a.kind] = (m[a.kind] || 0) + 1; return m; }, {});
  const byChannel = activity.activity.reduce((m, a) => { m[a.channel] = (m[a.channel] || 0) + 1; return m; }, {});
  const cards = [['Customers', summary.customers], ['Conversations', summary.conversations], ['AI replies stored', summary.aiRequests], ['Waiting for a human', queue.queue.length]];
  view.innerHTML = `
    <section class="stats">${cards.map(([l, v]) => `<div class="stat"><div class="stat-label"><span>${l}</span></div><div class="stat-value">${esc(v)}</div></div>`).join('')}</section>
    <div class="grid two">
      <section class="panel"><p class="eyebrow">LAST ${activity.activity.length} REPLY EVENTS</p><h3>By type</h3><div class="rule-list">${Object.keys(byKind).length ? Object.entries(byKind).map(([k, n]) => `<div class="rule-row"><span>${esc(labelKind(k))}</span><b>${n}</b></div>`).join('') : '<p class="muted">No reply activity yet.</p>'}</div></section>
      <section class="panel"><p class="eyebrow">CHANNEL</p><h3>Where replies went</h3><div class="rule-list">${Object.keys(byChannel).length ? Object.entries(byChannel).map(([k, n]) => `<div class="rule-row"><span>${esc(k === 'qr' ? 'WhatsApp (QR linked device)' : k)}</span><b>${n}</b></div>`).join('') : '<p class="muted">No reply activity yet.</p>'}</div></section>
    </div>
    <p class="muted" style="margin-top:16px">Trend charts, response times and per-template performance are not implemented yet.</p>`;
});

// ---------------------------------------------------------------------
// Security & Tenant
// ---------------------------------------------------------------------

route('#/security', 'Security & Tenant', 'Access controls for this workspace.', async (view) => {
  const sys = await api('/api/dashboard/system');
  view.innerHTML = `
    <div class="cc-grid">
      <section class="panel"><p class="eyebrow">TENANT</p><h3>Single business workspace</h3><dl class="detail-grid"><dt>Database</dt><dd class="file">${esc(sys.databasePath)}</dd><dt>Environment</dt><dd>${esc(sys.environment)}</dd><dt>Isolation</dt><dd>One business per deployment. Multi-tenant scoping is not implemented.</dd></dl></section>
      <section class="panel"><p class="eyebrow">ADMIN ACCESS</p><h3>Sessions</h3><p class="muted">Dashboard access uses a single administrator account with httpOnly session cookies (12 h sliding, 7 day cap). API routes return 401 without a session.</p><div class="toolbar" style="margin-top:12px"><button class="btn danger" id="logout-all">Log out everywhere</button></div></section>
      <section class="panel"><p class="eyebrow">SECRETS</p><h3>What never leaves the server</h3><ul class="plan-list"><li>WhatsApp linked-device credentials (data/baileys-auth) — gitignored, never returned by any API</li><li>OpenRouter / Google keys — AES-256-GCM encrypted at rest, masked in the UI</li><li>Customer phone numbers are masked in logs and activity views</li></ul></section>
    </div>`;
  view.querySelector('#logout-all').addEventListener('click', async () => {
    if (!confirmDialog('Revoke every active dashboard session, including this one?')) return;
    try { await api('/api/dashboard/auth/logout-all', { method: 'POST' }); } finally { location.hash = '#/login'; location.reload(); }
  });
});
