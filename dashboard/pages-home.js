// Rowad Alfa AI Workspace — dashboard home.
// Every figure comes from GET /api/dashboard/overview for the SELECTED WhatsApp account (the server scopes it and leaves out
// any section the signed-in user may not read). Nothing here is a demo value: an unavailable section is simply not drawn, and
// an empty one says so. Loaded after app.js (api, esc, route, errorView, formatDate, knownAccounts, currentAccount, …) and
// shell.js (me, can, hasCap, dashboardRange, rangeLabel, displayName).

(function () {
  const SVG = (d, extra = '') => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" ${extra}><path d="${d}"/></svg>`;
  const I = {
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    warn: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
    check: 'M20 6 9 17l-5-5',
    clipboard: 'M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1zM8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M9 12h6M9 16h4',
    sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
    phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
    users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    gift: 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z',
    link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
    left: 'm15 18-6-6 6-6', right: 'm9 18 6-6-6-6', arrow: 'M5 12h14M13 6l6 6-6 6',
    up: 'M7 17 17 7M8 7h9v9', down: 'M7 7l10 10M17 8v9H8',
    pause: 'M6 4h4v16H6zM14 4h4v16h-4z', shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    bolt: 'M13 2 3 14h9l-1 8 10-12h-9z', book: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z',
  };
  const icon = (key) => SVG(I[key]);

  const AVATAR_COLORS = ['#0e9aa7', '#12a37f', '#2f6fe0', '#7a5ce0', '#d97706', '#c2417a', '#0f8a80'];
  const colorFor = (text) => { let h = 0; for (const ch of String(text || '?')) h = (h * 31 + ch.codePointAt(0)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; };
  const avatar = (name) => `<span class="avatar-c" style="background:${colorFor(name)}" aria-hidden="true">${esc(initialsOf(name))}</span>`;

  /** "5m ago" from the database's UTC timestamps. */
  function ago(value) {
    if (!value) return '';
    const iso = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
    const t = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
    if (Number.isNaN(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return formatDate(value);
  }

  const greeting = () => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  };

  const periodText = (range) => (range === 'all' ? 'all time' : `last ${range} days`);
  const KIND_LABEL = { quotation: 'Quotation request', appointment: 'Appointment request' };
  const STATUS_CHIP = { pending: ['Pending', 'amber'], confirmed: ['Confirmed', 'green'], completed: ['Completed', 'green'], cancelled: ['Cancelled', 'red'], rejected: ['Rejected', 'red'] };
  const ACCOUNT_STATE = { connecting: 'Connecting', qr_required: 'QR code needed', disconnected: 'Disconnected', error: 'Connection error' };

  function delta(change) {
    if (change === null || change === undefined) return '';
    const up = change >= 0;
    return `<span class="delta ${up ? 'up' : 'down'}" title="Compared with the previous period of the same length">${SVG(up ? I.up : I.down, 'style="width:12px;height:12px"')}${up ? '+' : '−'}${Math.abs(change)}%</span>`;
  }

  // ---------------------------------------------------------------- alert panels
  function buildAlerts(d, range) {
    const cards = [];

    // 1. WhatsApp connection
    {
      const items = d.accounts.needAttention.map((a) => {
        const full = knownAccounts.find((k) => k.id === a.id) || {};
        return { main: a.name, sub: `${ACCOUNT_STATE[a.status] || a.status}${full.disconnectedAt ? ` · since ${formatDate(full.disconnectedAt)}` : ''}`, href: hasCap('connection') ? '#/whatsapp' : '#/accounts' };
      });
      const ok = items.length === 0;
      cards.push({
        tone: ok ? 'green' : 'red', icon: ok ? 'check' : 'warn', title: 'Connections', count: items.length,
        items: ok ? [{ main: 'All accounts connected', sub: `${d.accounts.connected} of ${d.accounts.total} WhatsApp account${d.accounts.total === 1 ? '' : 's'} online`, href: '#/accounts' }] : items,
      });
    }

    // 2. Customer requests waiting for staff
    if (d.requests) {
      const pending = d.requests.recent.filter((r) => r.status === 'pending');
      cards.push({
        tone: 'green', icon: 'clipboard', title: 'Requests', count: d.requests.pending,
        items: pending.length
          ? pending.map((r) => ({ main: r.customer, sub: `${KIND_LABEL[r.kind] || r.kind} · ${r.reference} · ${ago(r.createdAt)}`, href: '#/bookings' }))
          : [{ main: 'No pending requests', sub: 'Quotation and appointment requests from WhatsApp appear here.', href: '#/bookings' }],
      });
    }

    // 3. AI and automation
    if (d.automation) {
      const a = d.automation;
      const items = [{ main: a.ai.label, sub: a.ai.detail, href: hasCap('configuration') && ['needs_key', 'error'].includes(a.ai.state) ? '#/integrations' : '#/automation' }];
      if (a.errors > 0) items.push({ main: `${a.errors} reply problem${a.errors === 1 ? '' : 's'}`, sub: `Logged in the ${periodText(range)} — open the activity log`, href: '#/automation' });
      if (a.pausedCustomers > 0) items.push({ main: `${a.pausedCustomers} customer${a.pausedCustomers === 1 ? '' : 's'} waiting for a person`, sub: 'Automation is paused for them until staff resume it', href: '#/support' });
      const attention = (['needs_key', 'error'].includes(a.ai.state) ? 1 : 0) + (a.errors > 0 ? 1 : 0) + (a.pausedCustomers > 0 ? 1 : 0);
      cards.push({ tone: 'blue', icon: 'sparkle', title: 'AI & automation', count: attention, items });
    }
    return cards;
  }

  function alertHtml(card, i) {
    return `<article class="alert-card ${card.tone}" data-alert="${i}">
      <div class="alert-icon">${icon(card.icon)}</div>
      <div class="alert-head"><h3>${esc(card.title)}</h3><span class="count-pill">${card.count}</span>
        <span class="alert-nav"><button type="button" data-dir="-1" aria-label="Previous ${esc(card.title)} item">${icon('left')}</button><button type="button" data-dir="1" aria-label="Next ${esc(card.title)} item">${icon('right')}</button></span></div>
      <p class="alert-main" data-main></p><p class="alert-sub" data-sub></p>
      <div class="alert-foot"><a class="alert-view" data-view href="#/">View ${icon('arrow')}</a></div>
    </article>`;
  }

  function wireAlerts(host, cards) {
    host.querySelectorAll('[data-alert]').forEach((el) => {
      const card = cards[Number(el.dataset.alert)];
      let at = 0;
      const paint = () => {
        const item = card.items[at];
        el.querySelector('[data-main]').textContent = item.main;
        el.querySelector('[data-main]').title = item.main;
        el.querySelector('[data-sub]').textContent = item.sub;
        el.querySelector('[data-view]').setAttribute('href', item.href);
        const [prev, next] = el.querySelectorAll('.alert-nav button');
        prev.disabled = at === 0;
        next.disabled = at >= card.items.length - 1;
        el.querySelector('.alert-nav').style.visibility = card.items.length > 1 ? 'visible' : 'hidden';
      };
      el.querySelectorAll('.alert-nav button').forEach((b) => b.addEventListener('click', () => { at = Math.min(card.items.length - 1, Math.max(0, at + Number(b.dataset.dir))); paint(); }));
      paint();
    });
  }

  // ---------------------------------------------------------------- KPI cards
  function buildKpis(d, range) {
    const per = periodText(range);
    const cards = [];
    const own = d.accounts;
    cards.push({
      k: 'k1', href: '#/accounts', label: 'Accounts', icon: 'link', value: `${own.connected}/${own.total}`,
      foot: own.needAttention.length ? `<span>connected · ${own.needAttention.length} need${own.needAttention.length === 1 ? 's' : ''} attention</span>` : '<span>WhatsApp accounts · all connected</span>',
    });
    if (d.conversations) {
      cards.push({ k: 'k2', href: '#/conversations', label: 'Conversations', icon: 'chat', value: d.conversations.count.toLocaleString(), foot: `${delta(d.conversations.change)}<span>${d.conversations.active} active · ${per}</span>` });
    }
    if (d.requests) {
      cards.push({ k: 'k3', href: '#/bookings', label: 'Requests', icon: 'clipboard', value: d.requests.count.toLocaleString(), foot: `${delta(d.requests.change)}<span>${d.requests.pending} pending · ${per}</span>` });
    }
    if (d.offers) {
      const extra = d.offers.catalogues !== null ? ` · ${d.offers.catalogues} catalogue${d.offers.catalogues === 1 ? '' : 's'}` : '';
      cards.push({ k: 'k4', href: '#/offers', label: 'Active offers', icon: 'gift', value: d.offers.active.toLocaleString(), foot: `<span>${d.offers.views.toLocaleString()} offer views · ${per}${extra}</span>` });
    }
    if (d.automation) {
      cards.push({ k: 'k5', href: '#/automation', label: 'AI replies', icon: 'sparkle', value: d.automation.aiCount.toLocaleString(), foot: `${delta(d.automation.aiChange)}<span>${d.automation.menuCount.toLocaleString()} menu replies · ${per}</span>` });
    }
    return cards;
  }

  const kpiHtml = (c) => `<a class="kpi ${c.k}" href="${c.href}"><div class="kpi-top"><span class="kpi-label">${esc(c.label)}</span><span class="kpi-icon">${icon(c.icon)}</span></div><div class="kpi-value">${esc(c.value)}</div><div class="kpi-foot">${c.foot}</div></a>`;

  // ---------------------------------------------------------------- content panels
  const ROBOT = `<svg viewBox="0 0 120 140" aria-hidden="true"><defs><linearGradient id="bot-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8ff0e2"/><stop offset="1" stop-color="#1aa7b6"/></linearGradient></defs>
    <line x1="60" y1="12" x2="60" y2="26" stroke="#1aa7b6" stroke-width="4" stroke-linecap="round"/><circle cx="60" cy="9" r="6" fill="#4fe08a"/>
    <rect x="20" y="26" width="80" height="58" rx="24" fill="url(#bot-g)"/><rect x="29" y="38" width="62" height="34" rx="15" fill="#12323b"/>
    <circle cx="46" cy="55" r="6.5" fill="#7dffa8"/><circle cx="74" cy="55" r="6.5" fill="#7dffa8"/>
    <rect x="30" y="90" width="60" height="42" rx="19" fill="url(#bot-g)"/><circle cx="60" cy="111" r="7.5" fill="#fff" opacity=".85"/>
    <rect x="10" y="94" width="17" height="32" rx="8.5" fill="url(#bot-g)"/><rect x="93" y="94" width="17" height="32" rx="8.5" fill="url(#bot-g)"/></svg>`;

  function activityPanel(d, state) {
    const a = d.activity;
    if (!a) return '';
    const w = a.windows[state.tab];
    const tabs = [['yesterday', 'Yesterday'], ['today', 'Today'], ['weekly', 'Weekly']];
    const rows = [
      ['menu', 'chat', 'Replies sent', w.replies, '#/automation'],
      ['ai', 'sparkle', 'AI replies', w.ai, '#/automation'],
      ['handoff', 'phone', 'Handed to staff', w.handoff, '#/support'],
      ['attn', 'warn', 'Needs attention', w.attention, '#/automation'],
    ];
    return `<section class="dpanel" aria-labelledby="dp-activity"><div class="dpanel-head"><span class="glyph">${icon('bolt')}</span><h3 id="dp-activity">Activity Log</h3><span class="live-chip">${SVG('M3 12h4l3-8 4 16 3-8h4', 'style="width:14px;height:14px"')}Live</span></div>
      <div class="activity-body">
        <div class="mascot">${ROBOT}<div class="mascot-card"><b>${a.windows.today.replies.toLocaleString()}</b>replies today<br>automation is running</div></div>
        <div><div class="seg" role="tablist" aria-label="Activity period">${tabs.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`).join('')}</div>
          <div class="act-list">${rows.map(([cls, ic, label, n, href]) => `<a class="act-item ${cls}" href="${href}">${icon(ic)}<span class="t">${label}</span><b>${n.toLocaleString()}</b>${icon('right')}</a>`).join('')}</div></div>
      </div>
      <a class="dlink" href="#/automation">View all activity ${icon('arrow')}</a></section>`;
  }

  function requestsPanel(d, range) {
    const r = d.requests;
    if (!r) return '';
    const list = r.recent.length
      ? r.recent.slice(0, 4).map((q) => {
          const [label, tone] = STATUS_CHIP[q.status] || [q.status, ''];
          return `<a class="drow" href="#/bookings">${avatar(q.customer)}<span class="drow-main"><span class="drow-name">${esc(q.customer)}</span><span class="drow-sub">${esc(KIND_LABEL[q.kind] || q.kind)} · ${esc(ago(q.createdAt))}</span></span><span class="chip ${tone}">${esc(label)}</span></a>`;
        }).join('')
      : '<div class="dempty">No customer requests yet. They appear here when customers ask for a quotation or an appointment.</div>';
    return `<section class="dpanel" aria-labelledby="dp-req"><div class="dpanel-head"><span class="glyph">${icon('clipboard')}</span><h3 id="dp-req">Customer Requests</h3><span class="spacer"></span><a class="view-all" href="#/bookings">View All</a></div>
      <div class="dlist">${list}</div>
      <div class="stat-boxes"><div class="stat-box amber"><b>${r.pending.toLocaleString()}</b><span>Pending now</span></div><div class="stat-box blue"><b>${r.count.toLocaleString()}</b><span>${esc(rangeLabel(range))}</span></div></div></section>`;
  }

  function automationPanel(d, range) {
    const a = d.automation;
    if (!a) return '';
    const total = a.aiCount + a.menuCount + a.handoffs;
    const share = total > 0 ? Math.round((a.aiCount / total) * 100) : null;
    const stateTone = { active: 'green', mock: 'amber', off: 'amber', needs_key: 'red', error: 'red' }[a.ai.state] || '';
    return `<section class="dpanel" aria-labelledby="dp-ai"><div class="dpanel-head"><span class="glyph">${icon('sparkle')}</span><h3 id="dp-ai">AI & Automation</h3><span class="spacer"></span><a class="view-all" href="#/automation">Open</a></div>
      <div class="ring-wrap"><div class="ring" style="--p:${share ?? 0}" role="img" aria-label="${share === null ? 'No replies yet' : `${share}% of automatic replies came from the AI`}"><i>${share === null ? '—' : `${share}%`}</i></div>
        <div class="t"><b>${a.aiCount.toLocaleString()}</b><span>AI replies · ${esc(rangeLabel(range))}</span><span>${share === null ? 'No automatic replies in this period yet' : 'of all automatic replies'}</span></div></div>
      <div class="stat-boxes"><div class="stat-box blue"><b>${a.menuCount.toLocaleString()}</b><span>Menu replies</span></div><div class="stat-box green"><b>${a.aiCount.toLocaleString()}</b><span>AI replies</span></div><div class="stat-box ${a.handoffs ? 'amber' : ''}"><b>${a.handoffs.toLocaleString()}</b><span>To staff</span></div></div>
      <div class="dash-subhead"><span>Quick insights</span><span class="chip ${stateTone}">${esc(a.ai.label)}</span></div>
      <div class="qlist">
        <div class="qrow">${icon('sparkle')}<span class="t">AI replies</span><b>${a.aiReplies && a.autoReplies ? 'On' : 'Off'}</b></div>
        <div class="qrow">${icon('book')}<span class="t">Menu replies</span><b>${a.ruleReplies && a.autoReplies ? 'On' : 'Off'}</b></div>
        <div class="qrow">${icon('pause')}<span class="t">Paused for staff</span><b>${a.pausedCustomers}</b></div>
        <div class="qrow">${icon('warn')}<span class="t">Reply problems</span><b>${a.errors}</b></div>
      </div></section>`;
  }

  function conversationsPanel(d) {
    const rows = d.recentConversations;
    if (!rows) return '';
    const list = rows.length
      ? rows.slice(0, 5).map((c) => `<a class="drow" href="#/conversations/${c.id}">${avatar(c.customer)}<span class="drow-main"><span class="drow-name">${esc(c.customer)}</span><span class="drow-sub">${esc(c.lastMessage || 'No messages yet')}</span></span><span class="drow-time">${esc(ago(c.updatedAt))}</span></a>`).join('')
      : '<div class="dempty">No conversations yet. They appear here as customers message this WhatsApp number.</div>';
    return `<section class="dpanel" aria-labelledby="dp-conv"><div class="dpanel-head"><span class="glyph">${icon('chat')}</span><h3 id="dp-conv">Conversations</h3><span class="spacer"></span><a class="view-all" href="#/conversations">View All</a></div>
      <div class="dlist">${list}</div><a class="dlink" href="#/conversations">View all conversations ${icon('arrow')}</a></section>`;
  }

  // ---------------------------------------------------------------- page
  route('#/', 'Dashboard', 'A clear view of your customer conversations and agent health.', async (view) => {
    const state = { tab: 'today' };
    let disposed = false;
    let timer;
    let last = null;

    const skeleton = () => `<div class="dash" aria-busy="true"><div class="alerts">${'<div class="dskel" style="height:116px"></div>'.repeat(3)}</div><div class="kpis">${'<div class="dskel" style="height:128px"></div>'.repeat(5)}</div><div class="dash-grid">${'<div class="dskel" style="height:340px"></div>'.repeat(4)}</div></div>`;

    function heading(d) {
      const account = d ? d.account.name : (currentAccount() || {}).name;
      document.querySelector('#page-title').textContent = `${greeting()}, ${displayName()}`;
      document.querySelector('#page-subtitle').textContent = account ? `${account} · WhatsApp AI workspace` : 'WhatsApp AI workspace';
    }

    function render(d) {
      last = d;
      const range = d.range;
      heading(d);
      const alerts = buildAlerts(d, range);
      const kpis = buildKpis(d, range);
      view.innerHTML = `<div class="dash">
        <div class="alerts" style="--n:${alerts.length}">${alerts.map(alertHtml).join('')}</div>
        <div class="kpis" style="--n:${kpis.length}">${kpis.map(kpiHtml).join('')}</div>
        <div class="dash-grid">${activityPanel(d, state)}${requestsPanel(d, range)}${automationPanel(d, range)}${conversationsPanel(d)}</div>
        <p class="dash-note">Figures are live from the database for ${esc(d.account.name)} · ${esc(rangeLabel(range))}${range === 'all' ? '' : ' compared with the previous ' + range + ' days'}. Updated ${esc(new Date(d.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}.</p>
      </div>`;
      wireAlerts(view, alerts);
      view.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(last); }));
    }

    async function load(showSkeleton) {
      if (showSkeleton) { view.innerHTML = skeleton(); heading(null); }
      try {
        const d = await api(`/api/dashboard/overview?range=${encodeURIComponent(dashboardRange())}`);
        if (!disposed) render(d);
      } catch (error) {
        if (!disposed && showSkeleton) view.innerHTML = errorView(error.message, () => load(true));
      }
      if (!disposed) { clearTimeout(timer); timer = setTimeout(() => { if (!document.hidden) load(false); else timer = setTimeout(() => load(false), 30000); }, 30000); }
    }

    const onRange = () => load(true);
    document.addEventListener('workspace:range', onRange);
    disposeView = () => { disposed = true; clearTimeout(timer); document.removeEventListener('workspace:range', onRange); };
    await load(true);
  });
})();
