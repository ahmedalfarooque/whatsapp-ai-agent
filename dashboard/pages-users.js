// Rowad Alfa AI Workspace — Users & Permissions.
// A real, database-backed page: every action calls /api/dashboard/users (the server hashes passwords, enforces who may change
// whom, protects the permanent Super Admin and checks every permission again on each request). Nothing is stored in the browser.
// Loaded after app.js and shell.js (api, esc, route, toast, badge, formatDate, me, ROLE_LABEL, initialsOf).

(function () {
  const LEVEL_LABEL = { '': 'None', view: 'View', edit: 'Edit', manage: 'Manage' };
  const ROLE_HINT = {
    admin: 'Full access to the accounts assigned. Can manage managers and users. Connection and configuration access must be granted separately by the Super Admin.',
    manager: 'Views and edits everything operational on the assigned accounts (offers, documents, templates, customers…). Cannot delete, and has no connection, configuration or user access.',
    user: 'Read-only access to the operational pages of the assigned accounts. Cannot change anything.',
    custom: 'You choose exactly what this person may view, edit or manage, separately for each assigned account.',
  };
  const ROLE_TONE = { super_admin: 'blue', admin: 'purple', manager: 'green', user: '', custom: 'amber' };
  const PEOPLE = (name) => `<span class="avatar-c" style="background:var(--color-primary)" aria-hidden="true">${esc(initialsOf(name))}</span>`;
  const LOCK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  function randomPassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = new Uint32Array(18);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  }

  function fieldErrors(form, fields) {
    form.querySelectorAll('[data-err-for]').forEach((el) => { el.textContent = ''; });
    for (const [name, message] of Object.entries(fields || {})) {
      const el = form.querySelector(`[data-err-for="${name}"]`);
      if (el) el.textContent = message;
    }
  }

  route('#/users', 'Users & Permissions', 'Create dashboard users and decide which WhatsApp accounts they may open and what they may change. Every rule is enforced by the server.', async (view) => {
    const meta = await api('/api/dashboard/users/meta');
    const state = { search: '', role: '', status: '', offset: 0, limit: 25 };
    let data = { users: [], total: 0 };
    let searchTimer;

    const accountName = (id) => (meta.accounts.find((a) => a.id === id) || {}).name || `Account ${id}`;

    async function load() {
      const q = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
      if (state.search) q.set('search', state.search);
      if (state.role) q.set('role', state.role);
      if (state.status) q.set('status', state.status);
      data = await api(`/api/dashboard/users?${q}`);
      paint();
    }

    function rowActions(u) {
      if (u.protected) return `<span class="protected-note">${LOCK}Permanent Super Admin — protected</span>`;
      if (u.id === me.id) return '<span class="protected-note">This is you</span>';
      if (u.role === 'admin' && !me.superAdmin) return '<span class="protected-note">Managed by the Super Admin</span>';
      return `<div class="row-actions">
        <button class="btn small" data-act="edit" data-id="${u.id}">Edit</button>
        <button class="btn small" data-act="password" data-id="${u.id}">Reset password</button>
        <button class="btn small ghost" data-act="signout" data-id="${u.id}" title="Sign this user out of every device">Sign out</button>
        ${u.status === 'active' ? `<button class="btn small danger" data-act="disable" data-id="${u.id}">Disable</button>` : `<button class="btn small" data-act="enable" data-id="${u.id}">Reactivate</button>`}
      </div>`;
    }

    function userRow(u) {
      const chips = u.allAccounts && u.role === 'admin' || u.protected
        ? '<span class="badge blue">All accounts</span>'
        : (u.accounts.length ? u.accounts.map((a) => `<span class="badge" dir="auto">${esc(a.name)}</span>`).join('') : '<span class="muted">None</span>');
      return `<tr>
        <td><div class="user-cell">${PEOPLE(u.name || u.email)}<span><b dir="auto">${esc(u.name || u.email.split('@')[0])}</b><small>${esc(u.email)}</small></span></div></td>
        <td>${badge(ROLE_LABEL[u.role] || u.role, ROLE_TONE[u.role])}${u.canConnection && u.role === 'admin' ? ' ' + badge('Connections', '') : ''}${u.canConfiguration && u.role === 'admin' ? ' ' + badge('Configuration', '') : ''}</td>
        <td><div class="acct-chips">${chips}</div></td>
        <td>${u.status === 'active' ? badge('Active', 'green') : badge('Disabled', 'red')}</td>
        <td class="muted">${u.lastLoginAt ? esc(formatDate(u.lastLoginAt)) : 'Never'}</td>
        <td>${rowActions(u)}</td></tr>`;
    }

    function paint() {
      const roleOptions = ['super_admin', 'admin', 'manager', 'user', 'custom'].map((r) => `<option value="${r}" ${state.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('');
      const pages = Math.ceil(data.total / state.limit);
      const page = Math.floor(state.offset / state.limit) + 1;
      view.innerHTML = `
        <section class="panel">
          <div class="users-head">
            <div class="toolbar">
              <input type="search" id="u-search" placeholder="Search name or email" value="${esc(state.search)}" aria-label="Search users">
              <select id="u-role" aria-label="Filter by role"><option value="">All roles</option>${roleOptions}</select>
              <select id="u-status" aria-label="Filter by status"><option value="">Any status</option><option value="active" ${state.status === 'active' ? 'selected' : ''}>Active</option><option value="disabled" ${state.status === 'disabled' ? 'selected' : ''}>Disabled</option></select>
            </div>
            <button class="btn primary" id="u-new">＋ New user</button>
          </div>
          ${data.users.length ? `<div style="overflow-x:auto"><table class="data-table users-table"><thead><tr><th>User</th><th>Role</th><th>WhatsApp accounts</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>${data.users.map(userRow).join('')}</tbody></table></div>
          <div class="pager"><span class="muted">${data.total} user${data.total === 1 ? '' : 's'}${pages > 1 ? ` · page ${page} of ${pages}` : ''}</span><div><button class="btn small" id="u-prev" ${state.offset === 0 ? 'disabled' : ''}>Previous</button><button class="btn small" id="u-next" ${state.offset + state.limit >= data.total ? 'disabled' : ''}>Next</button></div></div>`
          : `<div class="empty-note">${state.search || state.role || state.status ? 'No users match these filters.' : 'No users yet.'}</div>`}
        </section>
        <p class="muted" style="margin:12px 4px 0">The permanent Super Admin account cannot be edited, disabled or restricted from this page. Passwords are stored only as salted hashes and are never shown again after they are set.</p>`;

      view.querySelector('#u-new').addEventListener('click', () => openUserDialog(null));
      view.querySelector('#u-search').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.search = e.target.value.trim(); state.offset = 0; load().then(() => { const el = view.querySelector('#u-search'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }, 250); });
      view.querySelector('#u-role').addEventListener('change', (e) => { state.role = e.target.value; state.offset = 0; load(); });
      view.querySelector('#u-status').addEventListener('change', (e) => { state.status = e.target.value; state.offset = 0; load(); });
      const prev = view.querySelector('#u-prev'); const next = view.querySelector('#u-next');
      if (prev) prev.addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); load(); });
      if (next) next.addEventListener('click', () => { state.offset += state.limit; load(); });
      view.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act, data.users.find((u) => u.id === Number(b.dataset.id)), b)));
    }

    // ------------------------------------------------------------ actions
    async function act(action, user, btn) {
      if (!user) return;
      if (action === 'edit') { openUserDialog(user); return; }
      if (action === 'password') { openPasswordDialog(user); return; }
      const messages = {
        disable: [`Disable ${user.email}?`, 'They are signed out immediately and cannot sign in until reactivated. Nothing they created is deleted.', 'Disable user'],
        enable: [`Reactivate ${user.email}?`, 'They can sign in again with their existing password.', 'Reactivate'],
        signout: [`Sign ${user.email} out everywhere?`, 'All of their active sessions end now. They can sign in again.', 'Sign out'],
      };
      const [title, text, label] = messages[action];
      if (!(await confirmModal(title, text, label, action === 'disable'))) return;
      btn.disabled = true;
      try {
        if (action === 'signout') { const r = await api(`/api/dashboard/users/${user.id}/revoke-sessions`, { method: 'POST' }); toast(`Signed out ${r.revoked} session${r.revoked === 1 ? '' : 's'}.`, 'success'); }
        else { await api(`/api/dashboard/users/${user.id}/${action}`, { method: 'POST' }); toast(action === 'disable' ? 'User disabled.' : 'User reactivated.', 'success'); }
        await load();
      } catch (error) { toast(error.message, 'error'); btn.disabled = false; }
    }

    function confirmModal(title, text, label, danger) {
      return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.className = 'user-dialog';
        dlg.style.width = 'min(460px,calc(100vw - 24px))';
        dlg.innerHTML = `<div class="dialog-head"><h2>${esc(title)}</h2></div><div class="dialog-body"><p style="margin:0">${esc(text)}</p></div><div class="dialog-foot"><button class="btn" data-no>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(label)}</button></div>`;
        document.body.appendChild(dlg);
        const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
        dlg.querySelector('[data-no]').addEventListener('click', () => done(false));
        dlg.querySelector('[data-yes]').addEventListener('click', () => done(true));
        dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
        dlg.showModal();
        dlg.querySelector('[data-no]').focus();
      });
    }

    // ------------------------------------------------------------ password dialog
    function openPasswordDialog(user) {
      const dlg = document.createElement('dialog');
      dlg.className = 'user-dialog';
      dlg.style.width = 'min(520px,calc(100vw - 24px))';
      dlg.innerHTML = `<form method="dialog" id="pw-form" autocomplete="off"><div class="dialog-head"><h2>Reset password</h2><button type="button" class="btn ghost small" data-close aria-label="Close">✕</button></div>
        <div class="dialog-body"><p class="muted" style="margin:0">Set a new password for <b dir="auto">${esc(user.email)}</b>. They are signed out everywhere and must use the new password. It is never shown again, so pass it to them securely.</p>
        <div class="field"><label for="pw-new">New password</label><div class="pw-row"><input id="pw-new" name="password" type="password" minlength="${meta.minPasswordLength}" required autocomplete="new-password"><button type="button" class="btn" id="pw-gen">Generate</button><button type="button" class="btn ghost" id="pw-show">Show</button></div><p class="field-help">At least ${meta.minPasswordLength} characters.</p><p class="form-error" data-err-for="password"></p></div><p class="form-error" data-err-for="_"></p></div>
        <div class="dialog-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="pw-save">Set password</button></div></form>`;
      document.body.appendChild(dlg);
      const form = dlg.querySelector('form');
      const close = () => { dlg.close(); dlg.remove(); };
      dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
      const input = dlg.querySelector('#pw-new');
      dlg.querySelector('#pw-gen').addEventListener('click', () => { input.value = randomPassword(); input.type = 'text'; dlg.querySelector('#pw-show').textContent = 'Hide'; });
      dlg.querySelector('#pw-show').addEventListener('click', (e) => { input.type = input.type === 'password' ? 'text' : 'password'; e.target.textContent = input.type === 'password' ? 'Show' : 'Hide'; });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const save = dlg.querySelector('#pw-save');
        save.disabled = true;
        try {
          await api(`/api/dashboard/users/${user.id}/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: input.value }) });
          input.value = '';
          toast('Password changed. The user was signed out everywhere.', 'success');
          close();
          await load();
        } catch (error) { fieldErrors(form, error.fields || { _: error.message }); save.disabled = false; }
      });
      dlg.showModal();
      input.focus();
    }

    // ------------------------------------------------------------ create / edit dialog
    function openUserDialog(user) {
      const editing = Boolean(user);
      const current = user || { role: 'user', accounts: [], allAccounts: false, canConnection: false, canConfiguration: false, name: '', email: '' };
      const selectedIds = new Set(current.accounts.map((a) => a.id));
      const permsOf = (id) => (current.accounts.find((a) => a.id === id) || { permissions: {} }).permissions || {};
      const dlg = document.createElement('dialog');
      dlg.className = 'user-dialog';
      const roleSelect = meta.roles.map((r) => `<option value="${r}" ${current.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('');
      dlg.innerHTML = `<form id="user-form" autocomplete="off" novalidate>
        <div class="dialog-head"><h2>${editing ? 'Edit user' : 'New user'}</h2><button type="button" class="btn ghost small" data-close aria-label="Close">✕</button></div>
        <div class="dialog-body">
          <div class="form-cols">
            <div class="field"><label for="f-name">Name</label><input id="f-name" name="name" type="text" maxlength="80" value="${esc(current.name || '')}" placeholder="Full name"><p class="form-error" data-err-for="name"></p></div>
            <div class="field"><label for="f-email">Email (used to sign in) *</label><input id="f-email" name="email" type="email" maxlength="254" required value="${esc(current.email || '')}" placeholder="name@company.com" autocomplete="off"><p class="form-error" data-err-for="email"></p></div>
            ${editing ? '' : `<div class="field wide"><label for="f-password">Initial password *</label><div class="pw-row"><input id="f-password" name="password" type="password" minlength="${meta.minPasswordLength}" autocomplete="new-password" required><button type="button" class="btn" id="f-gen">Generate</button><button type="button" class="btn ghost" id="f-show">Show</button></div><p class="field-help">At least ${meta.minPasswordLength} characters. The user signs in with this email and password; it is stored only as a salted hash and cannot be viewed again.</p><p class="form-error" data-err-for="password"></p></div>`}
            <div class="field wide"><label for="f-role">Role *</label><select id="f-role" name="role">${roleSelect}</select><p class="role-hint" id="role-hint"></p><p class="form-error" data-err-for="role"></p></div>
          </div>
          <div class="perm-box" id="access-box"></div>
          <p class="form-error" data-err-for="_"></p>
        </div>
        <div class="dialog-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="f-save">${editing ? 'Save changes' : 'Create user'}</button></div></form>`;
      document.body.appendChild(dlg);
      const form = dlg.querySelector('form');
      const close = () => { dlg.close(); dlg.remove(); };
      dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

      let allAccounts = Boolean(current.allAccounts && current.role === 'admin');
      let canConnection = Boolean(current.canConnection);
      let canConfiguration = Boolean(current.canConfiguration);
      const picked = new Map(); // custom role: accountId -> { feature: level }
      for (const id of selectedIds) picked.set(id, { ...permsOf(id) });

      const roleNow = () => form.role.value;

      function matrix(accountId, readonlyMap, editable) {
        const map = readonlyMap;
        return `<table class="perm-matrix ${editable ? '' : 'readonly'}"><thead><tr><th>Feature</th>${['', 'view', 'edit', 'manage'].map((l) => `<th>${LEVEL_LABEL[l]}</th>`).join('')}</tr></thead><tbody>
          ${meta.features.map((f) => `<tr><td>${esc(f.label)}<small>${esc(f.description)}</small></td>${['', 'view', 'edit', 'manage'].map((l) => `<td><input type="radio" name="perm-${accountId}-${f.key}" value="${l}" ${(map[f.key] || '') === l ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="${esc(f.label)}: ${LEVEL_LABEL[l]}"></td>`).join('')}</tr>`).join('')}
        </tbody></table>`;
      }

      function drawAccess() {
        const role = roleNow();
        dlg.querySelector('#role-hint').textContent = ROLE_HINT[role] || '';
        const box = dlg.querySelector('#access-box');
        const accountBoxes = meta.accounts.map((a) => `<label class="acct-opt"><input type="checkbox" name="acct" value="${a.id}" ${picked.has(a.id) ? 'checked' : ''} ${allAccounts && role === 'admin' ? 'disabled' : ''}><span><b dir="auto">${esc(a.name)}</b><small>${esc(a.phoneNumber || 'Not paired yet')}</small></span></label>`).join('');
        let html = `<h3>WhatsApp accounts</h3><p class="muted" style="margin:0">The user can open only the accounts ticked here; the server refuses everything else, even if they change an id in a request.</p>`;
        if (role === 'admin' && meta.canGrantAdminCapabilities) html += `<label class="acct-opt"><input type="checkbox" id="f-all" ${allAccounts ? 'checked' : ''}><span><b>All current and future accounts</b><small>Use only for trusted administrators</small></span></label>`;
        html += `<div class="acct-pick">${accountBoxes}</div><p class="form-error" data-err-for="accountIds"></p><p class="form-error" data-err-for="allAccounts"></p>`;
        if (role === 'custom') {
          html += '<h3>Permissions per account</h3>';
          const ids = [...picked.keys()];
          html += ids.length ? ids.map((id) => `<div><div class="perm-acct-title">${esc(accountName(id))}</div>${matrix(id, picked.get(id), true)}</div>`).join('') : '<p class="muted" style="margin:0">Tick at least one account above to choose its permissions.</p>';
          html += '<p class="form-error" data-err-for="permissions"></p>';
        } else if (role === 'manager' || role === 'user') {
          html += `<h3>What this role can do</h3><p class="muted" style="margin:0">${role === 'manager' ? 'View and edit' : 'View only'} for the features below, on every assigned account.</p>${matrix('preset', meta.presets[role] || {}, false)}`;
        } else if (role === 'admin') {
          html += '<h3>Administrator access</h3><p class="muted" style="margin:0">Administrators manage every feature of their accounts. Connection and configuration pages stay closed unless the Super Admin grants them here.</p>';
          if (meta.canGrantAdminCapabilities) {
            html += `<label class="acct-opt"><input type="checkbox" id="f-conn" ${canConnection ? 'checked' : ''}><span><b>WhatsApp connections</b><small>Pair, reconnect or disconnect numbers; add and delete accounts</small></span></label>
              <label class="acct-opt"><input type="checkbox" id="f-conf" ${canConfiguration ? 'checked' : ''}><span><b>Sensitive configuration</b><small>Providers, credentials, system and settings pages</small></span></label>`;
          } else html += '<p class="muted" style="margin:0">Only the Super Admin can grant these.</p>';
        }
        box.innerHTML = html;
        box.querySelectorAll('input[name="acct"]').forEach((cb) => cb.addEventListener('change', () => {
          const id = Number(cb.value);
          if (cb.checked) picked.set(id, picked.get(id) || {}); else picked.delete(id);
          if (roleNow() === 'custom') { readMatrix(); drawAccess(); }
        }));
        const all = box.querySelector('#f-all'); if (all) all.addEventListener('change', () => { allAccounts = all.checked; drawAccess(); });
        const conn = box.querySelector('#f-conn'); if (conn) conn.addEventListener('change', () => { canConnection = conn.checked; });
        const conf = box.querySelector('#f-conf'); if (conf) conf.addEventListener('change', () => { canConfiguration = conf.checked; });
      }

      function readMatrix() {
        if (roleNow() !== 'custom') return;
        for (const id of picked.keys()) {
          const map = {};
          for (const f of meta.features) { const checked = dlg.querySelector(`input[name="perm-${id}-${f.key}"]:checked`); if (checked && checked.value) map[f.key] = checked.value; }
          picked.set(id, map);
        }
      }

      form.role.addEventListener('change', () => { readMatrix(); if (roleNow() !== 'admin') allAccounts = false; drawAccess(); });
      const gen = dlg.querySelector('#f-gen');
      if (gen) {
        const pw = dlg.querySelector('#f-password');
        gen.addEventListener('click', () => { pw.value = randomPassword(); pw.type = 'text'; dlg.querySelector('#f-show').textContent = 'Hide'; });
        dlg.querySelector('#f-show').addEventListener('click', (e) => { pw.type = pw.type === 'password' ? 'text' : 'password'; e.target.textContent = pw.type === 'password' ? 'Show' : 'Hide'; });
      }
      drawAccess();

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        readMatrix();
        const role = roleNow();
        const body = { name: form.name.value.trim(), email: form.email.value.trim(), role };
        if (!editing) body.password = form.password.value;
        body.allAccounts = role === 'admin' && allAccounts;
        body.accountIds = body.allAccounts ? [] : [...picked.keys()];
        if (role === 'custom') body.permissions = Object.fromEntries([...picked.entries()].map(([id, map]) => [String(id), map]));
        if (role === 'admin' && meta.canGrantAdminCapabilities) { body.canConnection = canConnection; body.canConfiguration = canConfiguration; }
        const save = dlg.querySelector('#f-save');
        save.disabled = true;
        try {
          const saved = await api(editing ? `/api/dashboard/users/${user.id}` : '/api/dashboard/users', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          if (!editing) form.password.value = '';
          toast(editing ? `Saved ${saved.email}.` : `Created ${saved.email}. They can sign in now with the email and password you set.`, 'success');
          close();
          await load();
        } catch (error) {
          fieldErrors(form, error.fields || { _: error.message });
          save.disabled = false;
        }
      });
      dlg.showModal();
      form.name.focus();
    }

    await load();
  });
})();
