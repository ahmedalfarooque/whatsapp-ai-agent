// Real estate section (a business with the real estate add-on only — the sidebar shows it for that business alone and the server answers 404
// for every other one): overview, enquiries (buyers, sellers, investors), one enquiry in detail, verified projects, follow-ups and documents.
// Everything is read and written through the dashboard API, which scopes it to the selected WhatsApp account and enforces the user's
// permissions on the server; what is hidden here is only a convenience. Nothing on these pages invents data: an empty list says it is empty.

const RE_STATUS_LABEL = { new: 'New', qualified: 'Qualified', awaiting_info: 'Awaiting information', assigned: 'Assigned', follow_up: 'Follow-up required', closed: 'Closed' };
const RE_STATUS_TONE = { new: 'blue', qualified: 'green', awaiting_info: 'amber', assigned: 'blue', follow_up: 'amber', closed: '' };
const RE_KIND_LABEL = { buyer: 'Buyer', seller: 'Seller', investor: 'Investor', general: 'General' };
const RE_DOC_LABEL = { not_requested: 'Not requested', requested: 'Requested', received: 'Received', reviewed: 'Reviewed by staff' };
const RE_STAGE_LABEL = { upcoming: 'Upcoming', under_construction: 'Under construction', completed: 'Completed', sold_out: 'Sold out', other: 'See details' };
const reStatusBadge = (s) => badge(RE_STATUS_LABEL[s] || s, RE_STATUS_TONE[s] || '');
const reKindBadge = (k) => badge(RE_KIND_LABEL[k] || k, k === 'seller' ? 'purple' : k === 'buyer' ? 'blue' : '');
const canEditLeads = () => can('requests', 'edit');
const canEditProjects = () => can('business', 'edit');
const reSend = (method, url, body) => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const reQs = (obj) => Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === true ? '1' : v)}`).join('&');
const reAnswers = (d) => ['property_type', 'city', 'budget', 'currency', 'asking_price'].map((k) => d[k]).filter(Boolean).join(' · ');
const reDate = (v) => (v ? formatDate(v.includes('T') ? v : `${String(v).replace(' ', 'T')}Z`) : '—');

function reTabs(items, current) {
  return `<div class="tabs" role="tablist">${items.map(([key, label]) => `<button type="button" class="tab ${key === current ? 'active' : ''}" role="tab" data-tab="${esc(key)}">${esc(label)}</button>`).join('')}</div>`;
}

// ---------------------------------------------------------------------
// #/re-overview
// ---------------------------------------------------------------------

route('#/re-overview', 'Real Estate Overview', 'Enquiries, follow-ups, consultation requests and the verified projects of this business.', async (view) => {
  const o = await api('/api/dashboard/realestate/overview');
  const box = (label, value, href, tone) => `<a class="stat-box ${tone || ''}" ${href ? `href="${href}"` : ''}><b>${Number(value).toLocaleString()}</b><span>${esc(label)}</span></a>`;
  const statusRows = Object.entries(o.leads.byStatus).map(([s, n]) => `<tr><td>${reStatusBadge(s)}</td><td>${n}</td></tr>`).join('');
  const kindRows = Object.entries(o.leads.byKind).map(([k, n]) => `<tr><td>${reKindBadge(k)}</td><td>${n}</td></tr>`).join('');
  view.innerHTML = `
    <section class="panel"><div class="stat-grid">
      ${box('New today', o.leads.newToday, '#/re-leads')}
      ${box('Open enquiries', o.leads.open, '#/re-leads')}
      ${box('Qualified, not assigned', o.leads.qualifiedUnassigned, '#/re-leads', o.leads.qualifiedUnassigned ? 'amber' : '')}
      ${box('Need a person', o.leads.needsStaff, '#/re-followups', o.leads.needsStaff ? 'red' : '')}
      ${box('Follow-ups due', o.leads.followUpsDue, '#/re-followups', o.leads.followUpsDue ? 'amber' : '')}
      ${box('Consultation requests awaiting confirmation', o.consultations.pending, '#/re-followups', o.consultations.pending ? 'amber' : '')}
      ${box('Published projects', o.projects.published, '#/re-projects', 'green')}
    </div></section>
    <div class="dash-grid">
      <section class="panel"><div class="panel-head"><h2>Enquiries by status</h2></div><table class="data-table"><tbody>${statusRows}</tbody></table></section>
      <section class="panel"><div class="panel-head"><h2>Open enquiries by type</h2></div><table class="data-table"><tbody>${kindRows}</tbody></table>
        ${o.projects.published + o.projects.draft === 0 ? '<p class="muted">No project has been entered yet. Customers are told that the team will review their requirements until you publish verified projects.</p>' : ''}</section>
    </div>`;
});

// ---------------------------------------------------------------------
// #/re-leads — list
// ---------------------------------------------------------------------

async function drawReLeads(host, f) {
  const data = await api(`/api/dashboard/realestate/leads?${reQs({ kind: f.kind === 'all' ? '' : f.kind, status: f.status, q: f.q, followUpDue: f.due, limit: f.limit, offset: f.offset })}`);
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(label)}</option>`;
  const rows = data.items.map((l) => `<tr class="row-link" data-id="${l.id}">
      <td><b>${esc(l.reference)}</b><br><span class="muted">${formatDate(l.updatedAt.replace(' ', 'T') + 'Z')}</span></td>
      <td><b dir="auto">${esc(l.displayName || l.waMasked)}</b><br><span class="muted" dir="ltr">${esc(l.waMasked)}</span></td>
      <td>${reKindBadge(l.kind)}</td><td>${reStatusBadge(l.status)}${l.priority === 'high' ? ` ${badge('Priority', 'red')}` : ''}</td>
      <td dir="auto">${esc(reAnswers(l.details) || '—')}${l.missing.length ? `<br><span class="muted">Missing: ${esc(l.missing.slice(0, 3).join(', '))}</span>` : ''}</td>
      <td>${l.assignedAdminId ? 'Assigned' : '<span class="muted">—</span>'}</td></tr>`).join('');
  host.innerHTML = `${reTabs([['all', 'All'], ['buyer', 'Buyers'], ['seller', 'Sellers'], ['investor', 'Investors'], ['general', 'General']], f.kind)}
    <div class="toolbar cu-filters">
      <input id="f-q" type="search" placeholder="Search reference, name, number or answers…" value="${esc(f.q)}" aria-label="Search enquiries" />
      <select id="f-status" aria-label="Status">${opt('open', 'Open enquiries', f.status)}${opt('all', 'All statuses', f.status)}${Object.entries(RE_STATUS_LABEL).map(([v, l]) => opt(v, l, f.status)).join('')}</select>
      <label class="cu-check"><input id="f-due" type="checkbox" ${f.due ? 'checked' : ''}> Follow-up due</label>
    </div>
    ${data.items.length ? `<table class="data-table"><thead><tr><th>Reference</th><th>Customer</th><th>Type</th><th>Status</th><th>What they want</th><th>Staff</th></tr></thead><tbody>${rows}</tbody></table>` : emptyView('No enquiries match these filters. Enquiries appear here when customers describe what they want to buy or sell on WhatsApp.')}
    <div class="pager"><span class="muted">${data.total.toLocaleString()} enquir${data.total === 1 ? 'y' : 'ies'}</span><div><button id="re-prev" class="btn" ${f.offset === 0 ? 'disabled' : ''}>← Prev</button><button id="re-next" class="btn" ${f.offset + f.limit >= data.total ? 'disabled' : ''}>Next →</button></div></div>`;
  host.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { f.kind = t.dataset.tab; f.offset = 0; drawReLeads(host, f).catch((e) => { host.innerHTML = errorView(e.message); }); }));
  let timer;
  host.querySelector('#f-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value.trim(); f.offset = 0; drawReLeads(host, f); }, 300); });
  host.querySelector('#f-status').addEventListener('change', (e) => { f.status = e.target.value; f.offset = 0; drawReLeads(host, f); });
  host.querySelector('#f-due').addEventListener('change', (e) => { f.due = e.target.checked; f.offset = 0; drawReLeads(host, f); });
  host.querySelector('#re-prev').addEventListener('click', () => { f.offset = Math.max(0, f.offset - f.limit); drawReLeads(host, f); });
  host.querySelector('#re-next').addEventListener('click', () => { f.offset += f.limit; drawReLeads(host, f); });
  host.querySelectorAll('.row-link').forEach((row) => row.addEventListener('click', () => { location.hash = `#/re-leads/${row.dataset.id}`; }));
}

route('#/re-leads', 'Real Estate Leads', 'Buyer, seller and investor enquiries from WhatsApp, with what each customer still has to tell us.', async (view) => {
  view.innerHTML = '<section class="panel" id="re-body"></section>';
  await drawReLeads(view.querySelector('#re-body'), { kind: 'all', status: 'open', q: '', due: false, limit: 20, offset: 0 });
});

// ---------------------------------------------------------------------
// #/re-leads/:id — one enquiry
// ---------------------------------------------------------------------

route(/^#\/re-leads\/(?<id>\d+)$/, 'Enquiry', 'Requirements, documents and follow-up for one customer.', async (view, params) => {
  const d = await api(`/api/dashboard/realestate/leads/${params.id}`);
  const l = d.lead;
  const edit = canEditLeads();
  const dis = edit ? '' : 'disabled';
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(label)}</option>`;
  const answers = Object.entries(l.details).map(([k, v]) => `<tr><th>${esc(d.labels[k] || k)}</th><td dir="auto">${esc(v)}</td></tr>`).join('');
  const files = d.files.map((f) => `<tr><td dir="auto">${esc(f.original_name || 'file')}</td><td>${esc(f.kind)}</td><td>${f.size_bytes ? `${Math.max(1, Math.round(f.size_bytes / 1024))} KB` : ''}</td><td>${formatDate(f.created_at.replace(' ', 'T') + 'Z')}</td><td>${f.previewable ? `<button type="button" class="btn" data-file="${f.id}" data-url="${esc(f.downloadUrl)}" data-name="${esc(f.original_name || 'file')}">Open</button>` : '<span class="muted">Not available</span>'}</td></tr>`).join('');
  view.innerHTML = `
    <p><a href="#/re-leads">← All enquiries</a></p>
    <section class="panel">
      <div class="panel-head"><h2>${esc(l.reference)} ${reKindBadge(l.kind)} ${reStatusBadge(l.status)} ${l.priority === 'high' ? badge('Priority', 'red') : ''}</h2></div>
      <p dir="auto"><b>${esc(d.customer ? d.customer.displayName || d.customer.waMasked : '—')}</b> <span class="muted" dir="ltr">${esc(d.customer ? d.customer.waMasked : '')}</span>${d.customer ? ` · <a href="#/customers/${d.customer.id}">Customer profile</a>` : ''}</p>
      ${l.summary ? `<p dir="auto">${esc(l.summary)}</p>` : ''}
      ${l.needsStaff ? '<p class="notice">The customer asked for a person or the assistant flagged this enquiry for staff.</p>' : ''}
      <div class="form-cols">
        <div class="field"><label for="re-status">Status</label><select id="re-status" ${dis}>${Object.entries(RE_STATUS_LABEL).map(([v, t]) => opt(v, t, l.status)).join('')}</select></div>
        <div class="field"><label for="re-priority">Priority</label><select id="re-priority" ${dis}>${opt('normal', 'Normal', l.priority)}${opt('high', 'High', l.priority)}</select></div>
        <div class="field"><label for="re-docs">Documents</label><select id="re-docs" ${dis}>${Object.entries(RE_DOC_LABEL).map(([v, t]) => opt(v, t, l.documentsStatus)).join('')}</select></div>
        <div class="field"><label for="re-follow">Follow-up on</label><input id="re-follow" type="datetime-local" value="${esc(l.followUpAt ? l.followUpAt.replace(' ', 'T').slice(0, 16) : '')}" ${dis}></div>
      </div>
      <div class="field"><label for="re-next">Next action</label><input id="re-next" type="text" maxlength="300" value="${esc(l.nextAction || '')}" ${dis}></div>
      <div class="field"><label for="re-note">Add a note (kept in the history)</label><textarea id="re-note" rows="2" maxlength="500" ${dis}></textarea></div>
      ${edit ? `<div class="actions"><button id="re-save" class="btn primary" type="button">Save changes</button> <button id="re-me" class="btn" type="button">${l.assignedAdminId === me.id ? 'Unassign me' : 'Assign to me'}</button></div>` : '<p class="muted">You can view this enquiry but not change it.</p>'}
    </section>
    <div class="dash-grid">
      <section class="panel"><div class="panel-head"><h2>What the customer told us</h2></div>${answers ? `<table class="data-table"><tbody>${answers}</tbody></table>` : '<p class="muted">Nothing yet.</p>'}
        ${l.missing.length ? `<p class="muted">Still to ask: ${esc(l.missing.join(', '))}</p>` : ''}
        <p class="muted">The assistant never asks for identity documents or bank details in the chat, and nothing here is verified by the system.</p></section>
      <section class="panel"><div class="panel-head"><h2>Interested projects</h2></div>${d.projects.length ? `<ul>${d.projects.map((p) => `<li dir="auto">${esc(p.nameEn)}${p.city ? ` — ${esc(p.city)}` : ''}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>'}</section>
    </div>
    <section class="panel"><div class="panel-head"><h2>Documents from this customer</h2></div>${files ? `<table class="data-table"><thead><tr><th>File</th><th>Type</th><th>Size</th><th>Received</th><th></th></tr></thead><tbody>${files}</tbody></table>` : '<p class="muted">No documents received.</p>'}</section>
    <section class="panel"><div class="panel-head"><h2>History</h2></div>${d.events.length ? `<ul class="timeline">${d.events.map((e) => `<li><b>${esc(e.event)}</b> <span class="muted">${esc(e.actor)} · ${formatDate(e.createdAt.replace(' ', 'T') + 'Z')}</span>${e.detail ? `<br><span dir="auto">${esc(e.detail)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No history.</p>'}</section>`;
  view.querySelectorAll('[data-file]').forEach((b) => b.addEventListener('click', () => openCustomerFile(b.dataset.url, b.dataset.name, false)));
  const save = async (extra) => {
    const body = { status: view.querySelector('#re-status').value, priority: view.querySelector('#re-priority').value, documentsStatus: view.querySelector('#re-docs').value, nextAction: view.querySelector('#re-next').value.trim(), followUpAt: view.querySelector('#re-follow').value ? new Date(view.querySelector('#re-follow').value).toISOString() : null, ...extra };
    const note = view.querySelector('#re-note').value.trim();
    if (note) body.note = note;
    try { await reSend('PATCH', `/api/dashboard/realestate/leads/${l.id}`, body); toast('Enquiry saved.', 'success'); renderRoute(); } catch (e) { toast(e.message, 'error'); }
  };
  if (edit) {
    view.querySelector('#re-save').addEventListener('click', () => save({}));
    view.querySelector('#re-me').addEventListener('click', () => save(l.assignedAdminId === me.id ? { assignedAdminId: null } : { assignedAdminId: me.id, status: l.status === 'new' || l.status === 'qualified' || l.status === 'awaiting_info' ? 'assigned' : view.querySelector('#re-status').value }));
  }
});

// ---------------------------------------------------------------------
// #/re-projects — verified projects (nothing is ever invented)
// ---------------------------------------------------------------------

function reProjectForm(p, brochures) {
  const v = (x) => esc(x == null ? '' : x);
  return `<section class="panel" id="re-form"><div class="panel-head"><h2>${p ? 'Edit project' : 'Add a project'}</h2></div>
    <p class="muted">Enter only facts you have verified. Customers see a project only while it is published; a draft or archived project is never shown or mentioned.</p>
    <div class="form-cols">
      <div class="field"><label for="p-nameEn">Name (English)</label><input id="p-nameEn" type="text" maxlength="120" value="${v(p && p.nameEn)}"></div>
      <div class="field"><label for="p-nameAr">Name (Arabic)</label><input id="p-nameAr" type="text" maxlength="120" dir="auto" value="${v(p && p.nameAr)}"></div>
      <div class="field"><label for="p-city">City</label><input id="p-city" type="text" maxlength="80" value="${v(p && p.city)}"></div>
      <div class="field"><label for="p-district">District / area</label><input id="p-district" type="text" maxlength="80" value="${v(p && p.district)}"></div>
      <div class="field"><label for="p-type">Property type</label><input id="p-type" type="text" maxlength="80" placeholder="Apartment, villa, land…" value="${v(p && p.propertyType)}"></div>
      <div class="field"><label for="p-stage">Stage</label><select id="p-stage"><option value="">Not stated</option>${Object.entries(RE_STAGE_LABEL).map(([k, t]) => `<option value="${k}" ${p && p.stage === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="p-sumEn">Summary (English)</label><textarea id="p-sumEn" rows="3" maxlength="1200">${v(p && p.summaryEn)}</textarea></div>
    <div class="field"><label for="p-sumAr">Summary (Arabic)</label><textarea id="p-sumAr" rows="3" maxlength="1200" dir="auto">${v(p && p.summaryAr)}</textarea></div>
    <div class="field"><label for="p-broch">Brochure (a customer-visible document)</label><select id="p-broch"><option value="">None</option>${brochures.map((b) => `<option value="${b.id}" ${p && p.brochureDocumentId === b.id ? 'selected' : ''}>${esc(b.title || b.original_name)}</option>`).join('')}</select></div>
    <label class="cu-check"><input id="p-pub" type="checkbox" ${p && p.published ? 'checked' : ''}> Published (customers can see and ask about it)</label>
    <div class="actions"><button id="p-save" class="btn primary" type="button">Save project</button> <button id="p-cancel" class="btn" type="button">Cancel</button></div></section>`;
}

route('#/re-projects', 'Projects & Properties', 'The verified projects customers can be told about. Nothing appears to customers until you publish it.', async (view) => {
  const edit = canEditProjects();
  const load = async () => {
    const data = await api('/api/dashboard/realestate/projects?archived=1');
    const rows = data.projects.map((p) => `<tr><td><b dir="auto">${esc(p.nameEn)}</b>${p.nameAr ? `<br><span class="muted" dir="auto">${esc(p.nameAr)}</span>` : ''}</td><td>${esc([p.district, p.city].filter(Boolean).join(', ') || '—')}</td><td>${esc(p.propertyType || '—')}</td><td>${esc(p.stage ? RE_STAGE_LABEL[p.stage] : '—')}</td>
      <td>${p.archived ? badge('Archived', '') : p.published ? badge('Published', 'green') : badge('Draft', 'amber')}${p.brochureDocumentId ? ` ${badge('Brochure', 'blue')}` : ''}</td>
      <td>${edit ? `<button type="button" class="btn" data-edit="${p.id}">Edit</button> <button type="button" class="btn" data-archive="${p.id}" data-state="${p.archived ? '0' : '1'}">${p.archived ? 'Restore' : 'Archive'}</button>` : ''}</td></tr>`).join('');
    view.innerHTML = `<section class="panel"><div class="panel-head"><h2>Projects</h2>${edit ? '<button id="p-add" class="btn primary" type="button">Add project</button>' : ''}</div>
      ${data.projects.length ? `<table class="data-table"><thead><tr><th>Project</th><th>Location</th><th>Type</th><th>Stage</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : emptyView('No projects have been entered. Customers who ask are told that the team will review their requirements; nothing is invented.')}</section><div id="re-form-host"></div>`;
    const openForm = async (project) => {
      let brochures = [];
      try { brochures = ((await api('/api/dashboard/documents?status=active')).documents || []).filter((d) => d.visibility === 'customer'); } catch { /* no permission to list documents: the brochure stays as it is */ }
      const host = view.querySelector('#re-form-host');
      host.innerHTML = reProjectForm(project, brochures);
      host.querySelector('#p-cancel').addEventListener('click', () => { host.innerHTML = ''; });
      host.querySelector('#p-save').addEventListener('click', async () => {
        const g = (id) => host.querySelector(id).value.trim();
        const body = { nameEn: g('#p-nameEn'), nameAr: g('#p-nameAr'), city: g('#p-city'), district: g('#p-district'), propertyType: g('#p-type'), stage: g('#p-stage'), summaryEn: g('#p-sumEn'), summaryAr: g('#p-sumAr'), brochureDocumentId: g('#p-broch'), published: host.querySelector('#p-pub').checked };
        try { await (project ? reSend('PUT', `/api/dashboard/realestate/projects/${project.id}`, body) : reSend('POST', '/api/dashboard/realestate/projects', body)); toast('Project saved.', 'success'); await load(); } catch (e) { toast(e.message, 'error'); }
      });
      host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    if (edit) {
      view.querySelector('#p-add').addEventListener('click', () => openForm(null));
      view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openForm(data.projects.find((p) => String(p.id) === b.dataset.edit))));
      view.querySelectorAll('[data-archive]').forEach((b) => b.addEventListener('click', async () => { try { await reSend('POST', `/api/dashboard/realestate/projects/${b.dataset.archive}/archive`, { archived: b.dataset.state === '1' }); toast('Project updated.', 'success'); await load(); } catch (e) { toast(e.message, 'error'); } }));
    }
  };
  await load();
});

// ---------------------------------------------------------------------
// #/re-followups — enquiries waiting for a person + consultation requests
// ---------------------------------------------------------------------

route('#/re-followups', 'Consultations & Follow-ups', 'Enquiries that need a person, follow-ups that are due and consultation requests waiting for confirmation.', async (view) => {
  const d = await api('/api/dashboard/realestate/followups');
  const leadRows = d.leads.map((l) => `<tr class="row-link" data-id="${l.id}"><td><b>${esc(l.reference)}</b></td><td dir="auto">${esc(l.displayName || l.waMasked)}</td><td>${reKindBadge(l.kind)}</td><td>${reStatusBadge(l.status)}${l.needsStaff ? ` ${badge('Needs a person', 'red')}` : ''}</td><td dir="auto">${esc(l.nextAction || '—')}</td><td>${l.followUpAt ? reDate(l.followUpAt) : '—'}</td></tr>`).join('');
  const consultRows = d.consultations.map((c) => `<tr class="row-link" data-customer="${c.customerId}"><td><b>${esc(c.reference)}</b></td><td dir="auto">${esc(c.displayName || c.waMasked)}</td><td dir="auto">${esc(c.topic || '—')}</td><td dir="auto">${esc([c.date, c.timeAndContact].filter(Boolean).join(' · ') || '—')}</td><td>${badge(c.status === 'confirmed' ? 'Confirmed' : 'Awaiting confirmation', c.status === 'confirmed' ? 'green' : 'amber')}</td></tr>`).join('');
  view.innerHTML = `<section class="panel"><div class="panel-head"><h2>Enquiries to follow up</h2></div>${d.leads.length ? `<table class="data-table"><thead><tr><th>Reference</th><th>Customer</th><th>Type</th><th>Status</th><th>Next action</th><th>Follow-up</th></tr></thead><tbody>${leadRows}</tbody></table>` : emptyView('Nothing needs a person right now.')}</section>
    <section class="panel"><div class="panel-head"><h2>Consultation requests</h2></div><p class="muted">A consultation is only a request until a member of the team confirms it with the customer (use Appointments to change its status).</p>${d.consultations.length ? `<table class="data-table"><thead><tr><th>Reference</th><th>Customer</th><th>Topic</th><th>Preferred day and contact</th><th>Status</th></tr></thead><tbody>${consultRows}</tbody></table>` : emptyView('No consultation requests.')}</section>`;
  view.querySelectorAll('tr[data-id]').forEach((r) => r.addEventListener('click', () => { location.hash = `#/re-leads/${r.dataset.id}`; }));
  view.querySelectorAll('tr[data-customer]').forEach((r) => r.addEventListener('click', () => { location.hash = `#/customers/${r.dataset.customer}`; }));
});

// ---------------------------------------------------------------------
// #/re-documents — files customers with an enquiry sent
// ---------------------------------------------------------------------

route('#/re-documents', 'Real Estate Documents', 'Files customers with an enquiry have sent, with the review status of their enquiry. Only this business can open them.', async (view) => {
  const d = await api('/api/dashboard/realestate/documents');
  const rows = d.files.map((f) => `<tr><td dir="auto">${esc(f.original_name || 'file')}</td><td>${esc(f.kind)}</td><td><a href="#/re-leads/${f.leadId}">${esc(f.leadReference)}</a> ${reKindBadge(f.leadKind)}</td><td>${badge(RE_DOC_LABEL[f.reviewStatus] || f.reviewStatus, f.reviewStatus === 'reviewed' ? 'green' : f.reviewStatus === 'requested' ? 'amber' : '')}</td><td>${formatDate(f.created_at.replace(' ', 'T') + 'Z')}</td><td>${f.previewable ? `<button type="button" class="btn" data-url="${esc(f.downloadUrl)}" data-name="${esc(f.original_name || 'file')}">Open</button>` : '<span class="muted">Not available</span>'}</td></tr>`).join('');
  view.innerHTML = `<section class="panel"><p class="muted">Receiving a file does not verify it. Please ask customers to send sensitive documents only through the secure process your advisors explain.</p>${d.files.length ? `<table class="data-table"><thead><tr><th>File</th><th>Type</th><th>Enquiry</th><th>Document status</th><th>Received</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : emptyView('No documents have been received from customers with an enquiry.')}</section>`;
  view.querySelectorAll('[data-url]').forEach((b) => b.addEventListener('click', () => openCustomerFile(b.dataset.url, b.dataset.name, false)));
});
