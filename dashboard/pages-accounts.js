// Rowad Alfa AI Workspace — WhatsApp Accounts (multi-business).
// Loaded after app.js and reuses its helpers (api, esc, badge, toast, route,
// formatDate, selectAccount, loadAccounts, accountStatusInfo). One login, one
// application: each WhatsApp account is a separate business with its own
// linked number, QR session, profile, catalogue, offers, customers and replies.

route('#/accounts', 'WhatsApp Accounts', 'Every business this workspace answers for. Select one to work on it; each has its own WhatsApp number, session and data.', async (view) => {
  let editing = null;

  async function draw() {
    let data;
    try { data = await api('/api/dashboard/accounts'); } catch (error) { view.innerHTML = `<section class="panel"><p class="form-error">${esc(error.message)}</p></section>`; return; }
    const accounts = data.accounts || [];
    const selected = getSelectedAccountId();

    view.innerHTML = `
      <section class="panel" style="margin-bottom:18px">
        <div class="panel-head"><div><p class="eyebrow">ADD A BUSINESS</p><h3>New WhatsApp account</h3></div></div>
        <form id="account-create" class="form-grid" autocomplete="off">
          <div class="field"><label for="acc-name">Business name (English) *</label><input id="acc-name" name="name" type="text" maxlength="200" required placeholder="e.g. Noor Salon"></div>
          <div class="field"><label for="acc-name-ar">Business name (Arabic)</label><input id="acc-name-ar" name="nameAr" type="text" maxlength="200" dir="rtl" placeholder="مثال: صالون نور"></div>
          <div class="field"><label for="acc-category">Business category</label><input id="acc-category" name="businessCategory" type="text" maxlength="200" placeholder="e.g. Beauty salon · Restaurant · Car care"></div>
          <div class="field" style="align-self:end"><button type="submit" class="btn primary">Create account</button></div>
        </form>
        <p class="muted" style="margin-top:10px">After creating the account, select it and open <b>WhatsApp Connection</b> to scan its QR code with that business's phone. Its profile, catalogue, offers, templates and knowledge start empty and never share data with other accounts.</p>
      </section>
      <div class="account-grid" id="account-cards">${accounts.length ? accounts.map((a) => card(a, a.id === selected)).join('') : '<p class="muted">No accounts yet.</p>'}</div>`;

    view.querySelector('#account-create').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const body = { name: form.name.value.trim(), nameAr: form.nameAr.value.trim() || null, businessCategory: form.businessCategory.value.trim() || null };
      const submit = form.querySelector('[type=submit]');
      submit.disabled = true;
      try {
        const created = await api('/api/dashboard/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        toast(`Account "${created.name}" created. Select it and open WhatsApp Connection to scan its QR code.`, 'success');
        await loadAccounts();
        selectAccount(created.id, { silent: true });
        await loadAccounts();
        await draw();
      } catch (error) {
        toast(error.fields ? Object.values(error.fields).join(' · ') : error.message, 'error');
      } finally {
        submit.disabled = false;
      }
    });

    view.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => act(btn.dataset.act, Number(btn.dataset.id), btn)));
    view.querySelectorAll('form[data-edit]').forEach((form) => form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = Number(form.dataset.edit);
      const body = { name: form.name.value.trim(), nameAr: form.nameAr.value.trim() || null, businessCategory: form.businessCategory.value.trim() || null };
      try {
        await api(`/api/dashboard/accounts/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        toast('Account updated.', 'success');
        editing = null;
        await loadAccounts();
        await draw();
      } catch (error) {
        toast(error.fields ? Object.values(error.fields).join(' · ') : error.message, 'error');
      }
    }));
  }

  function card(a, isSelected) {
    const info = accountStatusInfo(a.uiStatus);
    const tone = a.uiStatus === 'connected' ? 'green' : a.uiStatus === 'connecting' || a.uiStatus === 'qr_required' ? 'amber' : a.uiStatus === 'disabled' ? '' : 'red';
    if (editing === a.id) {
      return `<section class="panel account-card">
        <p class="eyebrow">EDIT ACCOUNT #${a.id}</p>
        <form data-edit="${a.id}" class="form-grid" autocomplete="off">
          <div class="field"><label>Business name (English) *</label><input name="name" type="text" maxlength="200" required value="${esc(a.name)}"></div>
          <div class="field"><label>Business name (Arabic)</label><input name="nameAr" type="text" maxlength="200" dir="rtl" value="${esc(a.nameAr || '')}"></div>
          <div class="field"><label>Business category</label><input name="businessCategory" type="text" maxlength="200" value="${esc(a.businessCategory || '')}"></div>
          <div class="actions"><button type="submit" class="btn primary">Save</button><button type="button" class="btn ghost" data-act="cancel" data-id="${a.id}">Cancel</button></div>
        </form>
      </section>`;
    }
    return `<section class="panel account-card ${isSelected ? 'selected' : ''}">
      <p class="eyebrow">${a.isLegacy ? 'Account #1 · original business' : `Account #${a.id}`}${isSelected ? ' · selected' : ''}</p>
      <h3><span class="dot ${info.dot}"></span><span dir="auto">${esc(a.name)}</span></h3>
      ${a.nameAr ? `<p class="muted" dir="rtl">${esc(a.nameAr)}</p>` : ''}
      <dl class="kv">
        <dt>Status</dt><dd>${badge(info.label, tone)}${a.enabled ? '' : ' ' + badge('Disabled', '')}${a.protected ? ' ' + badge('Protected', 'blue') : ''}</dd>
        <dt>WhatsApp number</dt><dd class="phone-inline">${a.phoneNumber ? esc(a.phoneNumber) : '<span class="muted">Not paired yet</span>'}</dd>
        <dt>Profile name</dt><dd>${esc(a.displayName || '—')}</dd>
        <dt>Category</dt><dd>${esc(a.businessCategory || '—')}</dd>
        <dt>Transport</dt><dd>${a.connectionMethod === 'meta' ? 'Meta Cloud API' : 'QR / linked device'}</dd>
        <dt>Connected since</dt><dd>${a.connectedAt ? formatDate(a.connectedAt) : '—'}</dd>
        <dt>Last error</dt><dd class="${a.lastError ? '' : 'muted'}">${esc(a.lastError || 'None')}</dd>
      </dl>
      <div class="actions">
        <button class="btn primary" data-act="setup" data-id="${a.id}">Set up business</button>
        ${isSelected ? '<button class="btn" disabled>Selected</button>' : `<button class="btn" data-act="select" data-id="${a.id}">Switch to this account</button>`}
        <button class="btn" data-act="connection" data-id="${a.id}">${a.uiStatus === 'connected' ? 'Open connection' : 'Connect / show QR'}</button>
        <button class="btn ghost" data-act="edit" data-id="${a.id}">Edit</button>
        ${a.enabled
          ? `<button class="btn danger" data-act="disable" data-id="${a.id}" ${a.isLegacy ? 'title="The original business account can be disabled too; its session is kept."' : ''}>Disable</button>`
          : `<button class="btn" data-act="enable" data-id="${a.id}">Enable</button>`}
      </div>
    </section>`;
  }

  async function act(action, id, btn) {
    if (action === 'edit') { editing = id; await draw(); return; }
    if (action === 'cancel') { editing = null; await draw(); return; }
    if (action === 'select') { selectAccount(id); return; }
    if (action === 'setup') { location.hash = `#/accounts/${id}`; return; }
    if (action === 'connection') {
      if (getSelectedAccountId() !== id) selectAccount(id, { silent: true });
      await loadAccounts();
      location.hash = '#/whatsapp';
      return;
    }
    if (action === 'disable' && !window.confirm('Disable this account? Its WhatsApp socket closes and customers get no automatic replies until it is enabled again. The saved session is kept — no new QR scan is needed later.')) return;
    btn.disabled = true;
    try {
      await api(`/api/dashboard/accounts/${id}/${action}`, { method: 'POST' });
      toast(action === 'enable' ? 'Account enabled — resuming its saved session.' : 'Account disabled.', 'success');
      await loadAccounts();
      await draw();
    } catch (error) {
      toast(error.message, 'error');
      btn.disabled = false;
    }
  }

  await draw();
  if (sessionStorage.getItem('focus-create-account')) {
    sessionStorage.removeItem('focus-create-account');
    const first = view.querySelector('#acc-name');
    if (first) { first.scrollIntoView({ block: 'center' }); first.focus(); }
  }
});

// "Add WhatsApp account" in the sidebar lands on the create form with the name field focused.
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-add-account]')) return;
  sessionStorage.setItem('focus-create-account', '1');
  const field = location.hash === '#/accounts' ? document.querySelector('#acc-name') : null;
  if (field) { sessionStorage.removeItem('focus-create-account'); field.scrollIntoView({ block: 'center' }); field.focus(); }
});
