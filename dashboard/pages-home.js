// AI Workspace — dashboard home ("mission control").
// Every figure comes from GET /api/dashboard/overview for the SELECTED WhatsApp account (the server scopes it and leaves out any section the signed-in user may
// not read); the conversation pipeline and the live inbox come from GET /api/dashboard/inbox (only when the user may read conversations). Nothing here is a demo
// value: an unavailable section is simply not drawn, and an empty one says so. Loaded after app.js (api, esc, route, errorView, formatDate, knownAccounts,
// currentAccount, …), shell.js (me, can, hasCap, dashboardRange, rangeLabel, displayName) and ui-kit.js (UiKit).

(function () {
  const SVG = (d, extra = '') => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" ${extra}><path d="${d}"/></svg>`;
  const I = {
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    warn: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
    check: 'M20 6 9 17l-5-5',
    clipboard: 'M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1zM8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M9 12h6M9 16h4',
    sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
    phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
    right: 'm9 18 6-6-6-6', arrow: 'M5 12h14M13 6l6 6-6 6',
    up: 'M7 17 17 7M8 7h9v9', down: 'M7 7l10 10M17 8v9H8',
    pause: 'M6 4h4v16H6zM14 4h4v16h-4z', book: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z',
  };
  const icon = (key) => SVG(I[key]);

  const AVATAR_COLORS = ['#0b6b66', '#5a33d0', '#1f4fa8', '#7a3f9a', '#8a5a00', '#a23b5c', '#2b4a7a']; // deep tones, white initials read at 4.5:1 or better in both appearances
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
  const DOT_TONE = { connected: 'green', connecting: 'amber', qr_required: 'amber', disconnected: 'red', error: 'red', disabled: 'off' };

  function delta(change) {
    if (change === null || change === undefined) return '';
    const up = change >= 0;
    return `<span class="delta ${up ? 'up' : 'down'}" title="Compared with the previous period of the same length">${SVG(up ? I.up : I.down, 'style="width:12px;height:12px"')}${up ? '+' : '−'}${Math.abs(change)}%</span>`;
  }

  // ---------------------------------------------------------------- attention items (what needs a person's eyes)
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
        tone: d.requests.pending ? 'amber' : 'green', icon: 'clipboard', title: 'Requests', count: d.requests.pending,
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
      const bad = ['needs_key', 'error'].includes(a.ai.state);
      const attention = (bad ? 1 : 0) + (a.errors > 0 ? 1 : 0) + (a.pausedCustomers > 0 ? 1 : 0);
      cards.push({ tone: bad || a.errors > 0 ? 'red' : a.pausedCustomers > 0 ? 'amber' : a.ai.state === 'active' ? 'green' : 'blue', icon: 'sparkle', title: 'AI & automation', count: attention, items });
    }
    return cards;
  }

  // ---------------------------------------------------------------- hero: one sentence, the things that need attention, and the system at a glance
  function heroHtml(d, alerts, range) {
    const summary = UiKit.attentionSummary(alerts);
    const bits = [];
    if (d.requests) bits.push(`${d.requests.pending} customer request${d.requests.pending === 1 ? '' : 's'} waiting`);
    bits.push(`${d.accounts.connected} of ${d.accounts.total} WhatsApp account${d.accounts.total === 1 ? '' : 's'} connected`);
    if (d.automation) bits.push(d.automation.ai.label);
    const rows = alerts.map((c) => {
      const first = c.items[0];
      const more = c.items.length > 1 ? ` <span class="more">+${c.items.length - 1} more</span>` : '';
      return `<li class="hero-item ${c.tone}"><span class="hero-dot" aria-hidden="true"></span><div class="hero-item-text"><b>${esc(c.title)}</b><span dir="auto">${esc(first.main)}</span><small dir="auto">${esc(first.sub)}${more}</small></div><a class="hero-link" href="${esc(first.href)}">View ${icon('arrow')}</a></li>`;
    }).join('');
    const a = d.automation;
    const sys = [];
    sys.push(['WhatsApp', `${d.accounts.connected}/${d.accounts.total} connected`, d.accounts.needAttention.length ? 'red' : 'green']);
    if (a) {
      sys.push(['AI replies', a.ai.label, ['needs_key', 'error'].includes(a.ai.state) ? 'red' : a.ai.state === 'active' ? 'green' : 'amber']);
      sys.push(['Staff queue', `${a.pausedCustomers} waiting`, a.pausedCustomers ? 'amber' : 'green']);
      sys.push(['Reply problems', String(a.errors), a.errors ? 'red' : 'green']);
    }
    return `<section class="hero2 ${summary.need ? 'warn' : 'ok'}" aria-labelledby="hero-title">
      <div class="hero2-main">
        <p class="hero2-state"><span class="pulse" aria-hidden="true"></span>${esc(summary.need ? 'Needs attention' : 'All clear')}</p>
        <h2 id="hero-title">${esc(summary.headline)}</h2>
        <p class="hero2-sub">${esc(bits.join(' · '))}</p>
        <ul class="hero-items">${rows}</ul>
      </div>
      <aside class="hero2-side" aria-label="System status">
        <h3>System</h3>
        <ul>${sys.map(([label, value, tone]) => `<li><span class="sys-dot ${tone}" aria-hidden="true"></span><span class="sys-label">${esc(label)}</span><b dir="auto">${esc(value)}</b></li>`).join('')}</ul>
        <p class="hero2-note">${esc(rangeLabel(range))} · live from the database</p>
      </aside>
    </section>`;
  }

  // ---------------------------------------------------------------- KPI tiles, each with a small honest visualisation
  const dotsViz = (items) => `<span class="viz dots" role="img" aria-label="${esc(items.map((a) => `${a.name}: ${ACCOUNT_STATE[a.uiStatus] || (a.uiStatus === 'connected' ? 'Connected' : a.uiStatus)}`).join('; '))}">${items.map((a) => `<i class="${DOT_TONE[a.uiStatus] || 'red'}" title="${esc(a.name)}"></i>`).join('')}</span>`;

  /** A segmented bar. `parts` = [[label, value, tone]]; every value is also written out in the aria-label, so colour is never the only carrier of meaning. */
  function segBar(parts, label) {
    const widths = UiKit.segmentWidths(parts.map((p) => p[1]));
    const text = parts.map((p) => `${p[0]} ${p[1]}`).join(', ');
    if (!widths.some((w) => w > 0)) return `<span class="viz seg empty" role="img" aria-label="${esc(label)}: nothing yet"><i style="width:100%"></i></span>`;
    return `<span class="viz seg" role="img" aria-label="${esc(`${label}: ${text}`)}">${parts.map((p, i) => (widths[i] ? `<i class="${p[2]}" style="width:${widths[i]}%" title="${esc(`${p[0]}: ${p[1]}`)}"></i>` : '')).join('')}</span>`;
  }

  function buildKpis(d, range, pipeline) {
    const per = periodText(range);
    const cards = [];
    const own = d.accounts;
    cards.push({
      k: 'k1', href: '#/accounts', label: 'Accounts', value: `${own.connected}/${own.total}`, viz: dotsViz(own.items || []),
      foot: own.needAttention.length ? `<span>connected · ${own.needAttention.length} need${own.needAttention.length === 1 ? 's' : ''} attention</span>` : '<span>WhatsApp accounts · all connected</span>',
    });
    if (d.conversations) {
      const viz = pipeline ? segBar([['AI active', pipeline.ai || 0, 'c-ai'], ['Waiting for staff', pipeline.waiting || 0, 'c-wait'], ['With staff', pipeline.in_progress || 0, 'c-staff'], ['Resolved', pipeline.resolved || 0, 'c-done']], 'Conversations by handling') : '<span class="viz seg pending" aria-hidden="true"><i style="width:100%"></i></span>';
      cards.push({ k: 'k2', href: '#/conversations', label: 'Conversations', value: d.conversations.count.toLocaleString(), viz, foot: `${delta(d.conversations.change)}<span>${d.conversations.active} active · ${per}</span>` });
    }
    if (d.requests) {
      const done = Math.max(0, d.requests.count - d.requests.pending);
      cards.push({ k: 'k3', href: '#/bookings', label: 'Requests', value: d.requests.count.toLocaleString(), viz: segBar([['Pending', d.requests.pending, 'c-wait'], ['Handled', done, 'c-done']], 'Requests'), foot: `${delta(d.requests.change)}<span>${d.requests.pending} pending · ${per}</span>` });
    }
    if (d.offers) {
      const extra = d.offers.catalogues !== null ? ` · ${d.offers.catalogues} catalogue${d.offers.catalogues === 1 ? '' : 's'}` : '';
      cards.push({ k: 'k4', href: '#/offers', label: 'Active offers', value: d.offers.active.toLocaleString(), viz: '', foot: `<span>${d.offers.views.toLocaleString()} offer views · ${per}${extra}</span>` });
    }
    if (d.automation) {
      const a = d.automation;
      cards.push({ k: 'k5', href: '#/automation', label: 'AI replies', value: a.aiCount.toLocaleString(), viz: segBar([['Menu', a.menuCount, 'c-menu'], ['AI', a.aiCount, 'c-ai'], ['Staff', a.handoffs, 'c-wait']], 'Automatic replies'), foot: `${delta(a.aiChange)}<span>${a.menuCount.toLocaleString()} menu replies · ${per}</span>` });
    }
    return cards;
  }

  const kpiHtml = (c) => `<a class="kpi ${c.k}" href="${c.href}"><span class="kpi-label">${esc(c.label)}</span><span class="kpi-value">${esc(c.value)}</span>${c.viz || ''}<span class="kpi-foot">${c.foot}</span></a>`;

  // ---------------------------------------------------------------- content panels
  const handlingChip = (item) => {
    const info = InboxCore.handlingInfo(item.handling.state, item.handling.assignedToName);
    return `<span class="chip ${info.tone || ''}">${esc(info.label)}</span>`;
  };

  /** The live inbox: the newest conversations with who is handling them. Falls back to the overview's plain list when the inbox is not readable. */
  function inboxPanel(d, inboxData) {
    const items = inboxData ? inboxData.items.slice(0, 6) : null;
    const counts = inboxData ? inboxData.counts || {} : null;
    const head = `<div class="dpanel-head"><h3 id="dp-conv">Conversations</h3>${counts && counts.waiting ? `<span class="chip amber" title="Waiting for staff">${counts.waiting} waiting</span>` : ''}<span class="spacer"></span><a class="view-all" href="#/conversations">Open inbox</a></div>`;
    let list;
    if (items) {
      list = items.length
        ? items.map((c) => `<a class="drow ${c.needsReply ? 'unread' : ''}" href="#/conversations/customer/${c.customerId}">${avatar(c.name || c.waIdMasked)}<span class="drow-main"><span class="drow-name" dir="auto">${esc(c.name || c.waIdMasked)}</span><span class="drow-sub" dir="auto">${esc(InboxCore.splitMedia({ type: c.last.type, content: c.last.preview }).text || InboxCore.splitMedia({ type: c.last.type, content: c.last.preview }).media || '')}</span></span><span class="drow-end">${handlingChip(c)}<span class="drow-time">${esc(ago(c.last.at))}</span></span></a>`).join('')
        : '<div class="dempty">No conversations yet. They appear here as customers message this WhatsApp number.</div>';
    } else if (d.recentConversations) {
      list = d.recentConversations.length
        ? d.recentConversations.slice(0, 6).map((c) => `<a class="drow" href="#/conversations/${c.id}">${avatar(c.customer)}<span class="drow-main"><span class="drow-name" dir="auto">${esc(c.customer)}</span><span class="drow-sub" dir="auto">${esc(c.lastMessage || 'No messages yet')}</span></span><span class="drow-end"><span class="drow-time">${esc(ago(c.updatedAt))}</span></span></a>`).join('')
        : '<div class="dempty">No conversations yet. They appear here as customers message this WhatsApp number.</div>';
    } else return '';
    return `<section class="dpanel" aria-labelledby="dp-conv">${head}<div class="dlist" id="home-inbox">${list}</div></section>`;
  }

  function requestsPanel(d, range) {
    const r = d.requests;
    if (!r) return '';
    const list = r.recent.length
      ? r.recent.slice(0, 4).map((q) => {
          const [label, tone] = STATUS_CHIP[q.status] || [q.status, ''];
          return `<a class="drow" href="#/bookings">${avatar(q.customer)}<span class="drow-main"><span class="drow-name" dir="auto">${esc(q.customer)}</span><span class="drow-sub">${esc(KIND_LABEL[q.kind] || q.kind)} · ${esc(ago(q.createdAt))}</span></span><span class="drow-end"><span class="chip ${tone}">${esc(label)}</span></span></a>`;
        }).join('')
      : '<div class="dempty">No customer requests yet. They appear here when customers ask for a quotation or an appointment.</div>';
    return `<section class="dpanel" aria-labelledby="dp-req"><div class="dpanel-head"><h3 id="dp-req">Customer Requests</h3><span class="spacer"></span><a class="view-all" href="#/bookings">View All</a></div>
      <div class="dlist">${list}</div>
      <div class="stat-boxes"><div class="stat-box amber"><b>${r.pending.toLocaleString()}</b><span>Pending now</span></div><div class="stat-box blue"><b>${r.count.toLocaleString()}</b><span>${esc(rangeLabel(range))}</span></div></div></section>`;
  }

  /** Reply activity for the chosen window as a bar chart; every bar carries its number, and a table is available to assistive technology. */
  function activityPanel(d, state) {
    const a = d.activity;
    if (!a) return '';
    const w = a.windows[state.tab];
    const prev = state.tab === 'today' ? a.windows.yesterday : null;
    const tabs = [['yesterday', 'Yesterday'], ['today', 'Today'], ['weekly', 'Weekly']];
    const rows = [
      ['menu', 'Replies sent', w.replies, prev && prev.replies, '#/automation'],
      ['ai', 'AI replies', w.ai, prev && prev.ai, '#/automation'],
      ['handoff', 'Handed to staff', w.handoff, prev && prev.handoff, '#/support'],
      ['attn', 'Needs attention', w.attention, prev && prev.attention, '#/automation'],
    ];
    const max = Math.max(1, ...rows.map((r) => r[2]));
    const cmp = (now, before) => (before === null || before === undefined ? '' : now === before ? 'same as yesterday' : `${now > before ? '+' : '−'}${Math.abs(now - before)} vs yesterday`);
    return `<section class="dpanel" aria-labelledby="dp-activity"><div class="dpanel-head"><h3 id="dp-activity">Reply activity</h3><span class="live-chip">${SVG('M3 12h4l3-8 4 16 3-8h4', 'style="width:14px;height:14px"')}Live</span></div>
      <div class="seg" role="tablist" aria-label="Activity period">${tabs.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`).join('')}</div>
      <div class="bars" role="group" aria-label="Replies by kind">${rows.map(([cls, label, n, before, href]) => `<a class="bar-row ${cls}" href="${href}"><span class="bar-label">${label}</span><span class="bar-track"><i style="width:${UiKit.barPercent(n, max)}%"></i></span><b>${n.toLocaleString()}</b>${prev ? `<small>${esc(cmp(n, before))}</small>` : ''}</a>`).join('')}</div>
      <table class="sr-only"><caption>Replies ${esc(state.tab)}</caption><tbody>${rows.map((r) => `<tr><th scope="row">${r[1]}</th><td>${r[2]}</td></tr>`).join('')}</tbody></table>
      <a class="dlink" href="#/automation">View all activity ${icon('arrow')}</a></section>`;
  }

  function automationPanel(d, range) {
    const a = d.automation;
    if (!a) return '';
    const total = a.aiCount + a.menuCount + a.handoffs;
    const share = total > 0 ? Math.round((a.aiCount / total) * 100) : null;
    const stateTone = { active: 'green', mock: 'amber', off: 'amber', needs_key: 'red', error: 'red' }[a.ai.state] || '';
    return `<section class="dpanel" aria-labelledby="dp-ai"><div class="dpanel-head"><h3 id="dp-ai">AI & Automation</h3><span class="chip ${stateTone}">${esc(a.ai.label)}</span><span class="spacer"></span><a class="view-all" href="#/automation">Open</a></div>
      <div class="ring-wrap"><div class="ring" style="--p:${share ?? 0}" role="img" aria-label="${share === null ? 'No replies yet' : `${share}% of automatic replies came from the AI`}"><i>${share === null ? '—' : `${share}%`}</i></div>
        <div class="t"><b>${a.aiCount.toLocaleString()}</b><span>AI replies · ${esc(rangeLabel(range))}</span><span>${share === null ? 'No automatic replies in this period yet' : 'of all automatic replies'}</span></div></div>
      <div class="stat-boxes"><div class="stat-box blue"><b>${a.menuCount.toLocaleString()}</b><span>Menu replies</span></div><div class="stat-box green"><b>${a.aiCount.toLocaleString()}</b><span>AI replies</span></div><div class="stat-box ${a.handoffs ? 'amber' : ''}"><b>${a.handoffs.toLocaleString()}</b><span>To staff</span></div></div>
      <div class="qlist">
        <div class="qrow">${icon('sparkle')}<span class="t">AI replies</span><b>${a.aiReplies && a.autoReplies ? 'On' : 'Off'}</b></div>
        <div class="qrow">${icon('book')}<span class="t">Menu replies</span><b>${a.ruleReplies && a.autoReplies ? 'On' : 'Off'}</b></div>
        <div class="qrow">${icon('pause')}<span class="t">Paused for staff</span><b>${a.pausedCustomers}</b></div>
        <div class="qrow">${icon('warn')}<span class="t">Reply problems</span><b>${a.errors}</b></div>
      </div></section>`;
  }

  // ---------------------------------------------------------------- page
  route('#/', 'Dashboard', 'A clear view of your customer conversations and agent health.', async (view) => {
    const state = { tab: 'today' };
    let disposed = false;
    let timer;
    let last = null;
    let inboxData = null; // { items, counts } from /api/dashboard/inbox, or null when the user may not read conversations

    const skeleton = () => `<div class="dash" aria-busy="true"><div class="dskel" style="height:190px"></div><div class="dskel" style="height:116px"></div><div class="dash-main"><div class="dash-col"><div class="dskel" style="height:340px"></div><div class="dskel" style="height:240px"></div></div><div class="dash-col"><div class="dskel" style="height:260px"></div><div class="dskel" style="height:330px"></div></div></div></div>`;

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
      const kpis = buildKpis(d, range, inboxData && inboxData.counts);
      view.innerHTML = `<div class="dash">
        ${heroHtml(d, alerts, range)}
        <div class="kpis" style="--n:${kpis.length}">${kpis.map(kpiHtml).join('')}</div>
        <div class="dash-main">
          <div class="dash-col">${inboxPanel(d, inboxData)}${requestsPanel(d, range)}</div>
          <div class="dash-col">${activityPanel(d, state)}${automationPanel(d, range)}</div>
        </div>
        <p class="dash-note">Figures are live from the database for ${esc(d.account.name)} · ${esc(rangeLabel(range))}${range === 'all' ? '' : ' compared with the previous ' + range + ' days'}. Updated ${esc(new Date(d.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}.</p>
      </div>`;
      view.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(last); }));
    }

    async function loadInbox() {
      if (!can('conversations')) { inboxData = null; return; }
      try {
        const data = await api('/api/dashboard/inbox?limit=6&offset=0&sort=recent');
        inboxData = { items: data.items || [], counts: data.counts || {} };
      } catch { inboxData = null; }
    }

    async function load(showSkeleton) {
      if (showSkeleton) { view.innerHTML = skeleton(); heading(null); }
      try {
        const [d] = await Promise.all([api(`/api/dashboard/overview?range=${encodeURIComponent(dashboardRange())}`), loadInbox()]);
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
