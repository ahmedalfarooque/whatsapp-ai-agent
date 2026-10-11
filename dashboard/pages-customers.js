// Customers section: the directory, one customer's profile (timeline, requests & quotations, documents, notes), the quotation
// workspace, and Customer Reports. Reads/writes only through the dashboard API, which scopes everything to the selected WhatsApp
// account and enforces the user's permissions on the server — what is hidden here is only a convenience.

const REQUEST_STATUS_LABEL = {
  pending: 'Pending', preparing: 'Being prepared', contacted: 'Contacted', approved: 'Approved', sent: 'Sent', confirmed: 'Confirmed',
  rejected: 'Rejected', cancelled: 'Cancelled', completed: 'Completed', expired: 'Expired', closed: 'Closed',
};
const REQUEST_STATUS_TONE = { pending: 'amber', preparing: 'amber', contacted: 'amber', approved: 'blue', sent: 'green', confirmed: 'green', completed: 'green', rejected: 'red', cancelled: 'red', expired: 'red', closed: '' };
const statusBadge = (s) => badge(REQUEST_STATUS_LABEL[s] || s, REQUEST_STATUS_TONE[s] || '');
const canEditCustomers = () => can('customers', 'edit');
const canEditRequests = () => can('requests', 'edit');

const jsonPost = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const qs = (obj) => Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === true ? '1' : v)}`).join('&');
const fmtSize = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const METRIC_LABEL = {
  totalCustomers: 'Total customers', newCustomers: 'New in period', activeCustomers: 'Active in period', customersWithInquiries: 'With requests in period', inquiries: 'Quotation requests',
  appointmentRequests: 'Appointment requests', quotationsByStatus: 'Quotation requests by status', quotationsSent: 'Quotations delivered', awaitingSend: 'Approved, not yet sent',
  openRequests: 'Open requests', cartsSubmitted: 'Carts submitted', openCarts: 'Open carts', staleCarts: 'Carts idle 7+ days', documentsReceived: 'Documents received',
  documentsSent: 'Documents sent', filesNeedingReview: 'Files to review', followUpsOutstanding: 'Follow-ups outstanding', followUpsOverdue: 'Follow-ups overdue',
};
const money = (minor, cur) => (minor == null ? '—' : `${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? ` ${cur}` : ''}`);

/** Opens/downloads a customer file through an authenticated request (the account header travels with it; a plain link would not carry it). */
async function openCustomerFile(url, name, download) {
  const headers = {};
  if (typeof selectedAccountId !== 'undefined' && selectedAccountId) headers['X-Whatsapp-Account'] = String(selectedAccountId);
  try {
    const res = await fetch(download ? `${url}${url.includes('?') ? '&' : '?'}download=1` : url, { credentials: 'include', headers });
    if (!res.ok) { toast('That file is not available.', 'error'); return; }
    const blobUrl = URL.createObjectURL(await res.blob());
    if (download || !/inline/i.test(res.headers.get('Content-Disposition') || '')) {
      const a = document.createElement('a');
      a.href = blobUrl; a.download = name || 'file';
      document.body.appendChild(a); a.click(); a.remove();
    } else {
      window.open(blobUrl, '_blank', 'noopener');
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch { toast('Could not reach the server.', 'error'); }
}

async function downloadReport(url, filename) {
  const headers = {};
  if (typeof selectedAccountId !== 'undefined' && selectedAccountId) headers['X-Whatsapp-Account'] = String(selectedAccountId);
  try {
    const res = await fetch(url, { credentials: 'include', headers });
    if (!res.ok) { toast('Export failed.', 'error'); return; }
    const blobUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = blobUrl; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch { toast('Could not reach the server.', 'error'); }
}

/** Opens the print-ready report in a hidden frame and starts the print dialog (Print → Save as PDF). Nothing is stored; the data never leaves the page. */
async function printReport(url) {
  const headers = {};
  if (typeof selectedAccountId !== 'undefined' && selectedAccountId) headers['X-Whatsapp-Account'] = String(selectedAccountId);
  try {
    const res = await fetch(url, { credentials: 'include', headers });
    if (!res.ok) { toast('Export failed.', 'error'); return; }
    const html = await res.text();
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;inset-inline-end:0;bottom:0;width:0;height:0;border:0';
    frame.addEventListener('load', () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { toast('Printing is not available here.', 'error'); }
      setTimeout(() => frame.remove(), 60000);
    });
    frame.srcdoc = html;
    document.body.appendChild(frame);
  } catch { toast('Could not reach the server.', 'error'); }
}

// ---------------------------------------------------------------------
// Directory (shared by Customers and Customer Reports)
// ---------------------------------------------------------------------

function directoryFilterBar(f) {
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(label)}</option>`;
  return `<div class="toolbar cu-filters">
    <input id="f-search" type="search" placeholder="Search name, number, company, email or reference…" value="${esc(f.search || '')}" aria-label="Search customers" />
    <select id="f-status" aria-label="Request status">${opt('', 'Any request status', f.requestStatus || '')}${Object.entries(REQUEST_STATUS_LABEL).map(([v, l]) => opt(v, l, f.requestStatus || '')).join('')}</select>
    <select id="f-lang" aria-label="Language">${opt('', 'Any language', f.language || '')}${opt('ar', 'Arabic', f.language || '')}${opt('en', 'English', f.language || '')}</select>
    <select id="f-follow" aria-label="Follow-ups">${opt('', 'Any follow-up state', f.followUp || '')}${opt('outstanding', 'Follow-up outstanding', f.followUp || '')}${opt('overdue', 'Follow-up overdue', f.followUp || '')}</select>
    <label class="cu-check"><input id="f-open" type="checkbox" ${f.openOnly ? 'checked' : ''}> Open work only</label>
    <label class="cu-check"><input id="f-files" type="checkbox" ${f.hasFiles ? 'checked' : ''}> Has documents</label>
    <select id="f-sort" aria-label="Sort">${opt('recent', 'Latest interaction', f.sort || 'recent')}${opt('name', 'Name', f.sort || 'recent')}${opt('inquiries', 'Most inquiries', f.sort || 'recent')}</select>
  </div>`;
}

function readDirectoryFilters(host, f) {
  const v = (sel) => host.querySelector(sel);
  if (v('#f-search')) f.search = v('#f-search').value.trim();
  if (v('#f-status')) f.requestStatus = v('#f-status').value;
  if (v('#f-lang')) f.language = v('#f-lang').value;
  if (v('#f-follow')) f.followUp = v('#f-follow').value;
  if (v('#f-open')) f.openOnly = v('#f-open').checked;
  if (v('#f-files')) f.hasFiles = v('#f-files').checked;
  if (v('#f-sort')) f.sort = v('#f-sort').value;
  f.offset = 0;
}

function directoryTable(items) {
  if (!items.length) return emptyView('No customers match these filters.');
  const rows = items.map((c) => `<tr class="row-link" data-id="${c.id}">
      <td><b dir="auto">${esc(c.display_name || c.wa_id)}</b><br><span class="muted">${esc(c.wa_id)}${c.company_name ? ` · ${esc(c.company_name)}` : ''}</span></td>
      <td>${c.inquiries}${c.appointments ? ` <span class="muted">+${c.appointments} appt.</span>` : ''}</td>
      <td>${c.openRequests ? badge(`${c.openRequests} open`, 'amber') : '<span class="muted">—</span>'}${c.openCart ? ` ${badge('cart', 'blue')}` : ''}</td>
      <td>${c.quotationsSent}</td><td>${c.files}</td><td>${formatDate(c.lastInteractionAt)}</td>
      <td>${c.nextFollowUpAt ? `${new Date(`${c.nextFollowUpAt.replace(' ', 'T')}Z`) < new Date() ? badge('overdue', 'red') : ''} ${formatDate(c.nextFollowUpAt)}` : '<span class="muted">—</span>'}</td></tr>`).join('');
  return `<table class="data-table"><thead><tr><th>Customer</th><th>Inquiries</th><th>Open</th><th>Quotations sent</th><th>Documents</th><th>Last interaction</th><th>Next follow-up</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Draws the filter bar + table + pager into `host` and keeps `f` (the filter state) in sync. */
async function drawDirectory(host, f, extra, onDrawn) {
  const data = await api(`/api/dashboard/customers/directory?${qs({ ...f, limit: f.limit, offset: f.offset })}`);
  host.innerHTML = `${directoryFilterBar(f)}${directoryTable(data.items)}
    <div class="pager"><span class="muted">${data.total.toLocaleString()} customer${data.total === 1 ? '' : 's'}</span>
    <div>${extra || ''}<button id="cu-prev" class="btn" ${f.offset === 0 ? 'disabled' : ''}>← Prev</button><button id="cu-next" class="btn" ${f.offset + f.limit >= data.total ? 'disabled' : ''}>Next →</button></div></div>`;
  let timer;
  host.querySelector('#f-search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { readDirectoryFilters(host, f); drawDirectory(host, f, extra, onDrawn); }, 300); });
  host.querySelectorAll('#f-status,#f-lang,#f-follow,#f-open,#f-files,#f-sort').forEach((el) => el.addEventListener('change', () => { readDirectoryFilters(host, f); drawDirectory(host, f, extra, onDrawn); }));
  host.querySelector('#cu-prev').addEventListener('click', () => { f.offset = Math.max(0, f.offset - f.limit); drawDirectory(host, f, extra, onDrawn); });
  host.querySelector('#cu-next').addEventListener('click', () => { f.offset += f.limit; drawDirectory(host, f, extra, onDrawn); });
  host.querySelectorAll('.row-link').forEach((row) => row.addEventListener('click', () => { location.hash = `#/customers/${row.dataset.id}`; }));
  const input = host.querySelector('#f-search');
  if (document.activeElement === document.body && f.search) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  if (onDrawn) onDrawn();
  return data;
}

// ---------------------------------------------------------------------
// #/customers — directory + files that need review
// ---------------------------------------------------------------------

route('#/customers', 'Customers', 'Everyone who has written to this business: profile, history, quotations and documents in one place.', async (view) => {
  const f = { search: '', requestStatus: '', language: '', followUp: '', openOnly: false, hasFiles: false, sort: 'recent', limit: 20, offset: 0 };
  view.innerHTML = `<section class="panel"><div class="tabs" role="tablist"><button class="tab active" role="tab" data-tab="dir">Directory</button><button class="tab" role="tab" data-tab="review">Files to review <span id="review-count" class="chip"></span></button></div><div id="cu-body"></div></section>`;
  const body = view.querySelector('#cu-body');
  const tabs = view.querySelectorAll('.tab');
  const show = async (tab) => {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    body.innerHTML = loadingView();
    try {
      if (tab === 'dir') await drawDirectory(body, f);
      else await drawReviewQueue(body);
    } catch (error) { body.innerHTML = errorView(error.message, () => show(tab)); }
  };
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  api('/api/dashboard/customers/files/review').then((r) => { const el = view.querySelector('#review-count'); if (el) { el.textContent = r.files.length; el.className = `chip ${r.files.length ? 'amber' : ''}`; } }).catch(() => {});
  await show('dir');
});

async function drawReviewQueue(host) {
  const data = await api('/api/dashboard/customers/files/review');
  if (!data.files.length) { host.innerHTML = emptyView('Nothing to review: every file received is tied to a customer.'); return; }
  host.innerHTML = `<p class="muted">Files that could not be tied to a customer for certain, or could not be stored. Nothing here has been treated as verified. Attach a file to the right customer, or leave it.</p>
    <table class="data-table"><thead><tr><th>File</th><th>Received</th><th>Status</th><th>Reason</th><th></th></tr></thead><tbody>${data.files.map(({ file: f }) => `<tr>
      <td><b dir="auto">${esc(f.original_name || f.kind)}</b><br><span class="muted">${esc(f.mime_type || '')} ${fmtSize(f.size_bytes)}</span></td>
      <td>${formatDate(f.created_at)}</td><td>${badge(String(f.status).replace('_', ' '), f.status === 'needs_review' ? 'amber' : 'red')}</td><td>${esc(f.error || (f.customer_id ? '' : 'Customer not identified'))}</td>
      <td class="row-actions">${f.previewable ? `<button class="btn small" data-act="view" data-id="${f.id}" data-name="${esc(f.original_name || '')}">Open</button>` : ''}${canEditCustomers() && f.previewable ? `<input type="number" min="1" placeholder="Customer ID" aria-label="Customer ID" class="cu-id" data-id="${f.id}" value="${f.customer_id || ''}" style="width:110px"><button class="btn small primary" data-act="assign" data-id="${f.id}">Attach</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  host.querySelectorAll('[data-act="view"]').forEach((b) => b.addEventListener('click', () => openCustomerFile(`/api/dashboard/customers/files/${b.dataset.id}/download`, b.dataset.name, false)));
  host.querySelectorAll('[data-act="assign"]').forEach((b) => b.addEventListener('click', async () => {
    const id = host.querySelector(`.cu-id[data-id="${b.dataset.id}"]`).value;
    if (!id) { toast('Enter the customer ID (shown in the customer\'s page address).', 'error'); return; }
    try { await jsonPost(`/api/dashboard/customers/files/${b.dataset.id}/assign`, { customerId: Number(id) }); toast('File attached.', 'success'); await drawReviewQueue(host); } catch (error) { toast(error.message, 'error'); }
  }));
}

// ---------------------------------------------------------------------
// #/customers/<id> — the customer profile
// ---------------------------------------------------------------------

const TIMELINE_TYPES = {
  first_contact: 'First contact', inquiry: 'Inquiry / request', cart_item_added: 'Cart: added', cart_item_removed: 'Cart: removed', cart_submitted: 'Cart submitted',
  status_change: 'Status change', quotation_prepared: 'Quotation prepared', quotation_finalized: 'Quotation finalised', quotation_sent: 'Quotation sent',
  document_received: 'Document received', document_sent: 'Document sent', note: 'Note', follow_up: 'Follow-up', follow_up_done: 'Follow-up done', handoff: 'Asked for staff',
};
const TIMELINE_ICON = { first_contact: '👋', inquiry: '📝', cart_item_added: '🛒', cart_item_removed: '🛒', cart_submitted: '🛒', status_change: '🔁', quotation_prepared: '🧾', quotation_finalized: '🧾', quotation_sent: '📤', document_received: '📥', document_sent: '📤', note: '🗒️', follow_up: '⏰', follow_up_done: '✅', handoff: '🙋' };

route(/^#\/customers\/(?<id>\d+)$/, 'Customer', '', async (view, params) => {
  const id = Number(params.id);
  let tab = 'timeline';
  const timelineState = { q: '', types: '', from: '', to: '', order: 'desc' };
  const profile = await api(`/api/dashboard/customers/${id}/profile`);
  const c = profile.customer;
  document.querySelector('#page-title').textContent = c.display_name || c.wa_id;
  document.querySelector('#page-subtitle').textContent = `Customer since ${formatDate(c.created_at)}`;

  const s = profile.stats;
  view.innerHTML = `
    <a class="back-link" href="#/customers">← Back to customers</a>
    <section class="panel cu-head">
      <div class="cu-head-main">
        <h3 dir="auto">${esc(c.display_name || c.wa_id)}</h3>
        <p class="muted">${esc(c.wa_id)} · ${c.language === 'ar' ? 'Arabic' : c.language === 'en' ? 'English' : 'Language not chosen'} · last interaction ${formatDate(c.lastInteractionAt)}</p>
        <a class="btn small" href="#/conversations/customer/${c.id}">Open conversation</a>
      </div>
      <form id="cu-profile-form" class="cu-contact">
        <label class="field"><span>Company</span><input type="text" name="companyName" maxlength="200" value="${esc(c.company_name || '')}" ${canEditCustomers() ? '' : 'disabled'} dir="auto"></label>
        <label class="field"><span>Email</span><input type="email" name="email" maxlength="200" value="${esc(c.email || '')}" ${canEditCustomers() ? '' : 'disabled'}></label>
        ${canEditCustomers() ? '<button class="btn primary" type="submit">Save</button>' : ''}
      </form>
    </section>
    <div class="stat-boxes cu-stats">
      <div class="stat-box"><b>${s.inquiries}</b><span>Inquiries</span></div>
      <div class="stat-box ${s.openRequests ? 'amber' : ''}"><b>${s.openRequests}</b><span>Open requests</span></div>
      <div class="stat-box blue"><b>${s.quotationsSent}</b><span>Quotations sent</span></div>
      <div class="stat-box"><b>${s.filesReceived}</b><span>Documents received</span></div>
      <div class="stat-box"><b>${s.filesSent}</b><span>Documents sent</span></div>
      <div class="stat-box ${s.followUpsOverdue ? 'red' : s.followUpsOutstanding ? 'amber' : ''}"><b>${s.followUpsOutstanding}</b><span>Follow-ups${s.followUpsOverdue ? ` (${s.followUpsOverdue} overdue)` : ''}</span></div>
    </div>
    ${profile.openCart ? `<section class="panel cu-cart"><b>🛒 Open inquiry cart</b> <span class="muted">(not submitted yet · updated ${formatDate(profile.openCart.updatedAt)})</span><ul>${profile.openCart.items.map((i) => `<li dir="auto">${esc(i.description)}${i.quantity ? ` × ${i.quantity}` : ''}</li>`).join('')}</ul></section>` : ''}
    <section class="panel">
      <div class="tabs" role="tablist">${[['timeline', 'Timeline'], ['requests', 'Requests & quotations'], ['documents', `Documents${s.filesNeedingReview ? ` (${s.filesNeedingReview} to review)` : ''}`], ['notes', 'Notes & follow-ups']].map(([k, l]) => `<button class="tab ${k === tab ? 'active' : ''}" role="tab" data-tab="${k}">${esc(l)}</button>`).join('')}</div>
      <div id="cu-tab"></div>
    </section>`;

  view.querySelector('#cu-profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try { await jsonPost(`/api/dashboard/customers/${id}/profile`, { companyName: form.get('companyName') || null, email: form.get('email') || null }); toast('Profile saved.', 'success'); } catch (error) { toast(error.message, 'error'); }
  });

  const host = view.querySelector('#cu-tab');
  const refreshAll = () => renderRoute();
  const draw = async () => {
    view.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    host.innerHTML = loadingView();
    try {
      if (tab === 'timeline') await drawTimeline(host, id, timelineState);
      else if (tab === 'requests') drawCustomerRequests(host, profile, refreshAll);
      else if (tab === 'documents') await drawCustomerDocuments(host, id);
      else await drawNotes(host, id, profile, refreshAll);
    } catch (error) { host.innerHTML = errorView(error.message, draw); }
  };
  view.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; draw(); }));
  await draw();
});

async function drawTimeline(host, id, st) {
  const data = await api(`/api/dashboard/customers/${id}/timeline?${qs({ ...st, limit: 300 })}`);
  const link = (e) => [
    e.requestId && can('requests') ? `<button class="btn small ghost" data-open-request="${e.requestId}">${esc(e.reference || 'Request')}</button>` : (e.reference ? `<span class="chip">${esc(e.reference)}</span>` : ''),
    e.fileId ? `<button class="btn small ghost" data-open-file="${e.fileId}">Open file</button>` : '',
    e.conversationId ? `<a class="btn small ghost" href="#/conversations/${e.conversationId}" title="${e.whatsappMessageId ? `WhatsApp message ${esc(e.whatsappMessageId)}` : 'The conversation this belongs to'}">Conversation</a>` : '',
  ].join(' ');
  host.innerHTML = `
    <div class="toolbar cu-filters">
      <input id="tl-q" type="search" placeholder="Search the timeline…" value="${esc(st.q)}" aria-label="Search the timeline">
      <select id="tl-type" aria-label="Event type"><option value="">All events</option>${Object.entries(TIMELINE_TYPES).map(([k, l]) => `<option value="${k}" ${st.types === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <label class="cu-check">From <input id="tl-from" type="date" value="${esc(st.from)}"></label><label class="cu-check">To <input id="tl-to" type="date" value="${esc(st.to)}"></label>
      <select id="tl-order" aria-label="Order"><option value="desc" ${st.order === 'desc' ? 'selected' : ''}>Newest first</option><option value="asc" ${st.order === 'asc' ? 'selected' : ''}>Oldest first</option></select>
    </div>
    ${data.events.length ? `<ol class="cu-timeline">${data.events.map((e) => `<li class="cu-ev ${esc(e.type)}"><span class="cu-ev-ico" aria-hidden="true">${TIMELINE_ICON[e.type] || '•'}</span>
        <div class="cu-ev-body"><div class="cu-ev-top"><b dir="auto">${esc(e.title)}</b><span class="muted">${formatDate(e.at)}${e.actor ? ` · ${esc(e.actor)}` : ''}</span></div>
        ${e.detail ? `<div class="cu-ev-detail" dir="auto">${esc(e.detail)}</div>` : ''}<div class="cu-ev-links">${link(e)}</div></div></li>`).join('')}</ol>` : emptyView('No events match.')}
    <p class="muted">${data.total} event${data.total === 1 ? '' : 's'}. The chat itself stays on the Conversations page; links open the conversation an event came from.</p>`;
  let timer;
  host.querySelector('#tl-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { st.q = e.target.value; drawTimeline(host, id, st); }, 300); });
  host.querySelector('#tl-type').addEventListener('change', (e) => { st.types = e.target.value; drawTimeline(host, id, st); });
  host.querySelector('#tl-from').addEventListener('change', (e) => { st.from = e.target.value; drawTimeline(host, id, st); });
  host.querySelector('#tl-to').addEventListener('change', (e) => { st.to = e.target.value; drawTimeline(host, id, st); });
  host.querySelector('#tl-order').addEventListener('change', (e) => { st.order = e.target.value; drawTimeline(host, id, st); });
  host.querySelectorAll('[data-open-request]').forEach((b) => b.addEventListener('click', () => window.openQuotationPanel(Number(b.dataset.openRequest), () => drawTimeline(host, id, st))));
  host.querySelectorAll('[data-open-file]').forEach((b) => b.addEventListener('click', () => openCustomerFile(`/api/dashboard/customers/${id}/files/${b.dataset.openFile}/download`, '', false)));
}

function drawCustomerRequests(host, profile, refresh) {
  const rows = profile.requests;
  host.innerHTML = rows.length ? `<table class="data-table"><thead><tr><th>Reference</th><th>Type</th><th>Service</th><th>Status</th><th>Created</th><th>Updated</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr>
    <td class="file">${esc(r.reference)}</td><td>${esc(r.kind)}${r.source === 'cart' ? ' · cart' : ''}</td><td dir="auto">${esc(r.service || '')}</td><td>${statusBadge(r.status)}</td><td>${formatDate(r.created_at)}</td><td>${formatDate(r.updated_at)}</td>
    <td>${can('requests') ? `<button class="btn small" data-open-request="${r.id}">${r.kind === 'quotation' ? 'Quotation…' : 'Open'}</button>` : ''}</td></tr>`).join('')}</tbody></table>` : emptyView('No requests yet.');
  host.querySelectorAll('[data-open-request]').forEach((b) => b.addEventListener('click', () => window.openQuotationPanel(Number(b.dataset.openRequest), refresh)));
}

/** What happened to the text layer of a PDF: read (shown, labelled unverified), not read (why, with a retry), or still waiting. Customer text is never translated. */
function extractionView(f) {
  if (f.extension !== 'pdf' || f.status === 'failed' || f.status === 'too_large' || f.status === 'unsupported') return '';
  if (f.processing === 'text_extracted') {
    return `<div class="muted">${badge('text read', 'green')} ${f.extraction_pages ? ` page(s) · ` : ''}${formatDate(f.extracted_at)}</div>
      <details><summary>Extracted text (unverified)</summary><pre class="cu-pre" dir="auto" translate="no">${esc((f.extracted_text_unverified || '').slice(0, 6000))}</pre></details>`;
  }
  if (f.processing === 'extraction_failed') {
    const retry = canEditCustomers() && (f.extraction_attempts || 0) < 5 ? `<button class="btn small" data-extract="${f.id}">Try reading the text again</button>` : '';
    return `<div>${badge('text not read', 'red')} <span class="muted">${esc(f.extraction_error || '')}</span><br><span class="muted">The file is kept; open it to read it yourself.</span> ${retry}</div>`;
  }
  return `<div>${badge('text not read yet', 'amber')} ${canEditCustomers() ? `<button class="btn small" data-extract="${f.id}">Read the text now</button>` : ''}</div>`;
}

async function drawCustomerDocuments(host, id) {
  const data = await api(`/api/dashboard/customers/${id}/documents`);
  if (!data.documents.length) { host.innerHTML = emptyView('No documents received or sent yet.'); return; }
  const deliveryBadge = (d) => (d.delivery === 'delivered' ? badge('delivered', 'green') : d.delivery === 'failed' ? badge('delivery failed', 'red') : d.delivery === 'queued' ? badge('queued', 'amber') : '');
  host.innerHTML = `<p class="muted">Text read from a file is shown only as unverified customer content; it is never used as business policy.</p>
    <table class="data-table"><thead><tr><th>File</th><th>Direction</th><th>When</th><th>Related</th><th>Caption</th><th>Status</th><th></th></tr></thead><tbody>${data.documents.map(({ file: f, reference, delivery, needsReview }) => `<tr>
      <td><b dir="auto">${esc(f.original_name || f.kind)}</b><br><span class="muted">${esc(f.mime_type || '')} ${fmtSize(f.size_bytes)}</span></td>
      <td>${f.direction === 'inbound' ? '📥 Received' : '📤 Sent'}</td><td>${formatDate(f.created_at)}</td><td>${reference ? `<span class="chip">${esc(reference)}</span>` : '<span class="muted">—</span>'}</td>
      <td dir="auto">${esc(f.caption || '')}${extractionView(f)}</td>
      <td>${f.status === 'stored' ? badge('stored', 'green') : badge(String(f.status).replace('_', ' '), f.status === 'needs_review' ? 'amber' : 'red')} ${deliveryBadge({ delivery })} ${needsReview ? badge('identity to review', 'amber') : ''}${f.error ? `<br><span class="muted">${esc(f.error)}</span>` : ''}</td>
      <td class="row-actions">${f.previewable ? `<button class="btn small" data-act="view" data-id="${f.id}" data-name="${esc(f.original_name || '')}">Open</button><button class="btn small ghost" data-act="dl" data-id="${f.id}" data-name="${esc(f.original_name || '')}">Download</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  host.querySelectorAll('[data-act="view"]').forEach((b) => b.addEventListener('click', () => openCustomerFile(`/api/dashboard/customers/${id}/files/${b.dataset.id}/download`, b.dataset.name, false)));
  host.querySelectorAll('[data-act="dl"]').forEach((b) => b.addEventListener('click', () => openCustomerFile(`/api/dashboard/customers/${id}/files/${b.dataset.id}/download`, b.dataset.name, true)));
  host.querySelectorAll('[data-extract]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api(`/api/dashboard/customers/files/${b.dataset.extract}/extract`, { method: 'POST' });
      toast(r.state === 'text_extracted' ? 'Text read from the file' : 'The text could not be read; the file is kept', r.state === 'text_extracted' ? 'success' : 'error');
    } catch (e) { toast(e.message, 'error'); }
    drawCustomerDocuments(host, id);
  }));
}

async function drawNotes(host, id, profile, refresh) {
  const data = await api(`/api/dashboard/customers/${id}/notes`);
  const edit = canEditCustomers();
  host.innerHTML = `${edit ? `<form id="note-form" class="cu-note-form">
      <textarea name="body" rows="3" maxlength="4000" placeholder="Internal note (never shown to the customer)…" required dir="auto"></textarea>
      <div class="toolbar"><label class="cu-check">Follow-up on <input type="date" name="followUpAt"></label>
      <select name="requestId" aria-label="Related request"><option value="">Not about a specific request</option>${profile.requests.map((r) => `<option value="${r.id}">${esc(r.reference)}</option>`).join('')}</select>
      <button class="btn primary" type="submit">Add note</button></div></form>` : ''}
    ${data.notes.length ? `<ul class="cu-notes">${data.notes.map((n) => `<li class="${n.follow_up_at && !n.follow_up_done_at ? 'due' : ''}"><div class="cu-ev-top"><b>${esc(n.author_name || 'Staff')}</b><span class="muted">${formatDate(n.created_at)}</span></div>
      <div dir="auto" style="white-space:pre-wrap">${esc(n.body)}</div>
      ${n.follow_up_at ? `<div>${n.follow_up_done_at ? badge(`done ${formatDate(n.follow_up_done_at)}`, 'green') : `${new Date(`${n.follow_up_at.replace(' ', 'T')}Z`) < new Date() ? badge('overdue', 'red') : badge('follow-up', 'amber')} ${formatDate(n.follow_up_at)}${edit ? ` <button class="btn small" data-done="${n.id}">Mark done</button>` : ''}`}</div>` : ''}</li>`).join('')}</ul>` : emptyView('No notes yet.')}`;
  host.querySelector('#note-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await jsonPost(`/api/dashboard/customers/${id}/notes`, { body: f.get('body'), followUpAt: f.get('followUpAt') || undefined, requestId: f.get('requestId') || undefined }); toast('Note added.', 'success'); refresh(); } catch (error) { toast(error.message, 'error'); }
  });
  host.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async () => {
    try { await jsonPost(`/api/dashboard/customers/${id}/notes/${b.dataset.done}/done`); toast('Follow-up done.', 'success'); refresh(); } catch (error) { toast(error.message, 'error'); }
  }));
}

// ---------------------------------------------------------------------
// The quotation workspace (opened from the requests list and from the customer profile)
// ---------------------------------------------------------------------

window.openQuotationPanel = async function openQuotationPanel(requestId, onChange) {
  let dlg = document.querySelector('#quotation-dialog');
  if (dlg) dlg.remove();
  dlg = document.createElement('dialog');
  dlg.id = 'quotation-dialog';
  dlg.className = 'cu-dialog';
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); if (typeof onChange === 'function') onChange(); });
  dlg.showModal();

  const draw = async () => {
    dlg.innerHTML = '<div class="state-block"><div class="spinner"></div><p>Loading…</p></div>';
    let data;
    try { data = await api(`/api/dashboard/requests/${requestId}/quotation`); } catch (error) { dlg.innerHTML = `<div class="state-block error"><p>${esc(error.message)}</p><button class="btn" data-close>Close</button></div>`; dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close()); return; }
    const r = data.request;
    const isQuote = r.kind === 'quotation';
    const edit = canEditRequests();
    const draft = data.versions.find((v) => v.state === 'draft');
    const finals = data.versions.filter((v) => v.state === 'final');
    const current = finals[finals.length - 1];
    const lineRow = (l, i) => `<tr class="ql"><td><input type="text" class="ql-desc" maxlength="300" value="${esc(l?.description || '')}" placeholder="Item or service" dir="auto"></td><td><input type="text" class="ql-qty" inputmode="decimal" value="${l?.quantity_milli != null ? l.quantity_milli / 1000 : ''}" placeholder="Qty"></td><td><input type="text" class="ql-price" inputmode="decimal" value="${l?.unit_price_minor != null ? (l.unit_price_minor / 100).toFixed(2) : ''}" placeholder="Unit price"></td><td><button type="button" class="btn small ghost ql-del" aria-label="Remove line ${i + 1}">✕</button></td></tr>`;
    const lines = draft ? draft.lines : [];
    const nextBtns = (data.nextStatuses || []).filter((s) => !['approved', 'rejected'].includes(s)).map((s) => `<button class="btn small" data-status="${s}">${esc(REQUEST_STATUS_LABEL[s] || s)}</button>`).join('');
    dlg.innerHTML = `
      <form method="dialog" class="cu-dialog-head"><div><p class="eyebrow">${esc(r.kind.toUpperCase())} · ${esc(r.reference)}</p><h3>${statusBadge(r.status)} ${esc(r.reference)}</h3></div><button class="btn small" aria-label="Close">Close</button></form>
      <div class="cu-dialog-body">
        <dl class="detail-grid">${Object.entries(r.payload || {}).filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd dir="auto" style="white-space:pre-wrap">${esc(v)}</dd>`).join('')}</dl>
        ${edit ? `<div class="toolbar cu-actions">
          ${isQuote && !['approved', 'sent', 'rejected', 'cancelled', 'closed', 'completed', 'expired'].includes(r.status) ? '<button class="btn primary" data-act="approve">Approve quotation</button><button class="btn danger" data-act="reject">Reject…</button>' : ''}
          ${isQuote && r.status === 'approved' ? `<button class="btn primary" data-act="send" ${current ? '' : 'disabled title="Finalise a quotation version first"'}>Send to customer on WhatsApp</button><button class="btn" data-act="mark-sent" ${current ? '' : 'disabled'}>Mark as sent outside WhatsApp…</button>` : ''}
          ${nextBtns}
        </div>` : ''}
        ${isQuote && r.status === 'approved' ? '<p class="muted">Approved means you decided to quote. The customer receives the quotation only when you send it; the request becomes <b>Sent</b> once WhatsApp has accepted that message.</p>' : ''}
        ${isQuote ? `
        <h4>Quotation</h4>
        ${data.versions.filter((v) => v.state !== 'draft').map((v) => `<details class="cu-version"><summary><b>${esc(v.quote_number)}</b> · ${esc(v.state)}${v.sent_at ? ` · sent ${formatDate(v.sent_at)}` : ''} · total ${esc(money(v.total_minor, v.currency))}</summary><pre class="cu-pre" dir="auto">${esc(v.preview)}</pre><p class="muted">Prepared by ${esc(v.prepared_by_name || '—')} ${formatDate(v.created_at)}${v.internal_note ? ` · internal note: ${esc(v.internal_note)}` : ''}</p></details>`).join('') || '<p class="muted">No quotation prepared yet.</p>'}
        ${edit && !['rejected', 'cancelled', 'closed', 'completed', 'expired'].includes(r.status) ? `
        <form id="q-form" class="cu-qform">
          <p class="eyebrow">${draft ? `DRAFT · ${esc(draft.quote_number)}` : (current ? `NEW VERSION (revises ${esc(current.quote_number)})` : 'NEW QUOTATION')}</p>
          <div class="cu-qgrid">
            <label class="field"><span>Currency</span><input type="text" id="q-cur" maxlength="3" placeholder="e.g. SAR" value="${esc(draft?.currency || current?.currency || '')}"></label>
            <label class="field"><span>VAT / tax %</span><input type="text" id="q-tax" inputmode="decimal" placeholder="optional" value="${draft?.tax_rate_bp != null ? draft.tax_rate_bp / 100 : ''}"></label>
            <label class="field"><span>Valid until</span><input type="date" id="q-valid" value="${esc(draft?.valid_until || '')}"></label>
          </div>
          <table class="data-table"><thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th></th></tr></thead><tbody id="q-lines">${(lines.length ? lines : [null]).map(lineRow).join('')}</tbody></table>
          <button type="button" class="btn small" id="q-add">+ Add line</button>
          <p class="muted">Only what you enter is shown to the customer. Leave a price empty if it is not decided: there will then be no total. A price needs a quantity and a currency.</p>
          <label class="field"><span>Message to the customer (optional)</span><textarea id="q-msg" rows="2" maxlength="2000" dir="auto">${esc(draft?.customer_message || '')}</textarea></label>
          <label class="field"><span>Internal note (never sent)</span><textarea id="q-note" rows="2" maxlength="2000" dir="auto">${esc(draft?.internal_note || '')}</textarea></label>
          <label class="field"><span>Attach a document (PDF, image, Word…)</span><input type="file" id="q-file"> <span class="muted" id="q-file-state">${draft?.file_id ? 'A document is attached.' : ''}</span></label>
          <div class="toolbar"><button class="btn" type="submit">Save draft</button>${draft ? '<button class="btn primary" type="button" id="q-final">Finalise this version</button>' : ''}</div>
        </form>` : ''}
        <h4>Delivery</h4>
        ${data.deliveries.length ? `<table class="data-table"><thead><tr><th>Queued</th><th>Status</th><th>Attempts</th><th>Detail</th></tr></thead><tbody>${data.deliveries.map((o) => `<tr><td>${formatDate(o.created_at)}</td><td>${badge(o.status === 'sent' ? 'delivered' : o.status, o.status === 'sent' ? 'green' : o.status === 'failed' ? 'red' : 'amber')}</td><td>${o.attempts}</td><td>${esc(o.last_error || (o.sent_at ? `accepted ${formatDate(o.sent_at)}` : ''))}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing sent yet.</p>'}` : '<p class="muted">This is an appointment request; use the status list on the Appointments page.</p>'}
      </div>`;

    dlg.querySelector('form[method="dialog"] button').addEventListener('click', () => dlg.close());
    const run = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg, 'success'); await draw(); } catch (error) { toast(error.message, 'error'); } };
    const act = (name) => dlg.querySelector(`[data-act="${name}"]`);
    act('approve')?.addEventListener('click', () => run(() => jsonPost(`/api/dashboard/requests/${requestId}/quotation/approve`), 'Quotation approved. The customer was told once.'));
    act('reject')?.addEventListener('click', () => {
      const reason = window.prompt('Why is this quotation being rejected? (The customer is notified; the reason stays internal.)');
      if (reason === null) return;
      run(() => jsonPost(`/api/dashboard/requests/${requestId}/quotation/reject`, { reason }), 'Quotation rejected.');
    });
    act('send')?.addEventListener('click', () => {
      if (!confirmDialog('Send the quotation to the customer on WhatsApp now?')) return;
      run(async () => { const res = await jsonPost(`/api/dashboard/requests/${requestId}/quotation/send`); toast(res.alreadyQueued ? 'Already queued.' : 'Queued for delivery. It shows as Sent when WhatsApp accepts it.', 'success'); }, null);
    });
    act('mark-sent')?.addEventListener('click', () => {
      const reason = window.prompt('How was it sent? (for example "Emailed the PDF on 10 Oct")');
      if (reason === null) return;
      run(() => jsonPost(`/api/dashboard/requests/${requestId}/quotation/mark-sent`, { reason }), 'Recorded as sent.');
    });
    dlg.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => {
      const st = b.dataset.status;
      if (['cancelled', 'closed', 'expired'].includes(st) && !confirmDialog(`Set this request to "${REQUEST_STATUS_LABEL[st] || st}"?`)) return;
      run(() => jsonPost(`/api/dashboard/requests/${requestId}/status`, { status: st }), 'Status saved.');
    }));

    const form = dlg.querySelector('#q-form');
    if (form) {
      const body = form.querySelector('#q-lines');
      form.querySelector('#q-add').addEventListener('click', () => { body.insertAdjacentHTML('beforeend', lineRow(null, body.children.length)); });
      body.addEventListener('click', (e) => { if (e.target.closest('.ql-del') && body.children.length > 1) e.target.closest('tr').remove(); });
      let fileId = draft?.file_id || null;
      form.querySelector('#q-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const state = form.querySelector('#q-file-state');
        state.textContent = 'Uploading…';
        try {
          const headers = { 'x-file-name': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' };
          const res = await api(`/api/dashboard/requests/${requestId}/quotation/attachment`, { method: 'POST', headers, body: file });
          fileId = res.file.id; state.textContent = `Attached: ${file.name}`;
        } catch (error) { state.textContent = ''; toast(error.message, 'error'); }
      });
      const collect = () => ({
        currency: form.querySelector('#q-cur').value.trim(), taxRatePercent: form.querySelector('#q-tax').value.trim(), validUntil: form.querySelector('#q-valid').value,
        customerMessage: form.querySelector('#q-msg').value, internalNote: form.querySelector('#q-note').value, fileId,
        lines: [...body.querySelectorAll('tr.ql')].map((tr) => ({ description: tr.querySelector('.ql-desc').value.trim(), quantity: tr.querySelector('.ql-qty').value.trim(), unitPrice: tr.querySelector('.ql-price').value.trim() })).filter((l) => l.description),
      });
      form.addEventListener('submit', (e) => { e.preventDefault(); run(() => jsonPost(`/api/dashboard/requests/${requestId}/quotation/draft`, collect()), 'Draft saved.'); });
      form.querySelector('#q-final')?.addEventListener('click', () => {
        if (!confirmDialog('Finalise this version? It can no longer be edited (a change becomes a new version).')) return;
        run(async () => { const saved = await jsonPost(`/api/dashboard/requests/${requestId}/quotation/draft`, collect()); await jsonPost(`/api/dashboard/requests/${requestId}/quotation/versions/${saved.version.id}/finalize`); }, 'Version finalised.');
      });
    }
  };
  await draw();
};

// ---------------------------------------------------------------------
// #/customer-reports
// ---------------------------------------------------------------------

route('#/customer-reports', 'Customer Reports', 'How customers, inquiries, quotations and documents are doing — every figure opens the customers behind it.', async (view) => {
  const range = { from: '', to: '' };
  const f = { search: '', requestStatus: '', language: '', followUp: '', openOnly: false, hasFiles: false, sort: 'recent', limit: 15, offset: 0 };
  const iso = (d) => d.toISOString().slice(0, 10);
  const preset = (days) => { const to = new Date(); const from = new Date(Date.now() - days * 864e5); range.from = days ? iso(from) : ''; range.to = days ? iso(to) : ''; };
  preset(30);

  const drawAll = async () => {
    view.innerHTML = loadingView();
    const sum = await api(`/api/dashboard/customer-reports/summary?${qs(range)}`);
    const m = sum.metrics;
    const d = sum.definitions;
    const tile = (label, value, key, drill, tone) => `<button type="button" class="stat-box cu-tile ${tone || ''}" ${drill ? `data-drill='${esc(JSON.stringify(drill))}'` : 'disabled'} title="${esc(d[key] || '')}"><b>${Number(value).toLocaleString()}</b><span>${esc(label)}</span></button>`;
    const statusRows = Object.entries(m.quotationsByStatus).map(([s, n]) => `<button type="button" class="cu-status-row" data-drill='${esc(JSON.stringify({ requestStatus: s }))}'><span>${statusBadge(s)}</span><b>${n}</b></button>`).join('');
    view.innerHTML = `
      <section class="panel">
        <div class="toolbar cu-filters">
          <span class="muted">Period</span>
          <label class="cu-check">From <input type="date" id="r-from" value="${esc(range.from)}"></label><label class="cu-check">To <input type="date" id="r-to" value="${esc(range.to)}"></label>
          ${[[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All time']].map(([n, l]) => `<button class="btn small" data-preset="${n}">${l}</button>`).join('')}
          <span class="muted" style="margin-left:auto">${currentAccount() ? esc(currentAccount().name) : ''}</span>
        </div>
        <h4>Customers</h4>
        <div class="stat-boxes cu-tiles">${tile('Total customers', m.totalCustomers, 'totalCustomers', {})}${tile('New in period', m.newCustomers, 'newCustomers', { from: range.from, to: range.to, sort: 'recent' }, 'blue')}${tile('Active in period', m.activeCustomers, 'activeCustomers', { from: range.from, to: range.to })}${tile('With requests in period', m.customersWithInquiries, 'customersWithInquiries', { from: range.from, to: range.to, sort: 'inquiries' })}</div>
        <h4>Inquiries &amp; carts</h4>
        <div class="stat-boxes cu-tiles">${tile('Quotation requests', m.inquiries, 'inquiries', { sort: 'inquiries', from: range.from, to: range.to })}${tile('Appointment requests', m.appointmentRequests, 'appointmentRequests', null)}${tile('Carts submitted', m.cartsSubmitted, 'cartsSubmitted', null)}${tile('Open carts', m.openCarts, 'openCarts', null, m.openCarts ? 'amber' : '')}${tile('Carts idle 7+ days', m.staleCarts, 'staleCarts', null, m.staleCarts ? 'amber' : '')}</div>
        <h4>Quotations</h4>
        <div class="stat-boxes cu-tiles">${tile('Quotations delivered', m.quotationsSent, 'quotationsSent', { requestStatus: 'sent' }, 'green')}${tile('Approved, not yet sent', m.awaitingSend, 'awaitingSend', { requestStatus: 'approved' }, m.awaitingSend ? 'amber' : '')}${tile('Open requests (waiting for staff)', m.openRequests, 'openRequests', { openOnly: true }, m.openRequests ? 'amber' : '')}</div>
        <div class="cu-status-list"><p class="muted">Quotation requests created in the period, by status today:</p>${statusRows}</div>
        <h4>Documents &amp; follow-ups</h4>
        <div class="stat-boxes cu-tiles">${tile('Documents received', m.documentsReceived, 'documentsReceived', { hasFiles: true })}${tile('Documents sent', m.documentsSent, 'documentsSent', { hasFiles: true })}${tile('Files to review', m.filesNeedingReview, 'filesNeedingReview', null, m.filesNeedingReview ? 'amber' : '')}${tile('Follow-ups outstanding', m.followUpsOutstanding, 'followUpsOutstanding', { followUp: 'outstanding' }, m.followUpsOutstanding ? 'amber' : '')}${tile('Follow-ups overdue', m.followUpsOverdue, 'followUpsOverdue', { followUp: 'overdue' }, m.followUpsOverdue ? 'red' : '')}</div>
        <details class="cu-defs"><summary>How each figure is defined</summary><dl>${Object.entries(d).map(([k, v]) => `<dt>${esc(METRIC_LABEL[k] || k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>
      </section>
      <section class="panel" style="margin-top:16px"><div class="panel-head"><h3>Customers</h3></div><div id="r-dir"></div></section>`;

    const host = view.querySelector('#r-dir');
    const exportParams = () => qs({ ...f, from: range.from, to: range.to, limit: undefined, offset: undefined });
    const lang = () => (window.I18N && window.I18N.lang) || 'en';
    const exportGroup = (key, label, formats) => `<span class="cu-export" role="group" aria-label="${esc(label)}"><span class="muted">${esc(label)}</span>${formats.map(([fmt, text]) => `<button type="button" class="btn small" data-exp="${key}:${fmt}">${text}</button>`).join('')}</span>`;
    const extra = can('customers')
      ? `<span class="cu-exports">${exportGroup('customers', 'Export customers', [['csv', 'CSV'], ['xlsx', 'Excel'], ['pdf', 'PDF']])}${exportGroup('quotations', 'Export quotations', [['csv', 'CSV'], ['xlsx', 'Excel'], ['pdf', 'PDF']])}${exportGroup('summary', 'Export summary', [['xlsx', 'Excel'], ['pdf', 'PDF']])}</span>`
      : '';
    const wire = () => {
      host.querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', () => {
        const [dataset, format] = b.dataset.exp.split(':');
        // The file carries exactly what the screen shows: the customer list uses the active filters, the others the selected dates.
        const url = `/api/dashboard/customer-reports/export?dataset=${dataset}&format=${format}&lang=${lang()}&${dataset === 'customers' ? exportParams() : qs(range)}`;
        if (format === 'pdf') printReport(url); else downloadReport(url, `customer-report-${dataset}.${format}`);
      }));
    };
    f.from = range.from; f.to = range.to;
    await drawDirectory(host, f, extra, wire).catch((e) => { host.innerHTML = errorView(e.message); });

    view.querySelector('#r-from').addEventListener('change', (e) => { range.from = e.target.value; drawAll(); });
    view.querySelector('#r-to').addEventListener('change', (e) => { range.to = e.target.value; drawAll(); });
    view.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { preset(Number(b.dataset.preset)); drawAll(); }));
    view.querySelectorAll('[data-drill]').forEach((b) => b.addEventListener('click', () => {
      const drill = JSON.parse(b.dataset.drill);
      Object.assign(f, { search: '', requestStatus: '', language: '', followUp: '', openOnly: false, hasFiles: false, sort: 'recent', offset: 0 }, drill);
      if (drill.from !== undefined) { range.from = drill.from; range.to = drill.to; }
      f.from = range.from; f.to = range.to;
      drawDirectory(host, f, extra, wire);
      host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  };
  await drawAll();
});
