// Rowad Alfa AI Workspace — business setup workspace (one per WhatsApp account).
// Route: #/accounts/<id>. Loaded after app.js (api, esc, badge, toast, route, formatDate,
// selectAccount, loadAccounts, getSelectedAccountId, accountStatusInfo).
//
// Tabs: Business information · Links · PDFs & images · Analyze & Generate · Menu · Manage.
// Everything here talks to /api/dashboard/accounts/<id>/setup/... — the account id is part of
// the URL and is authorised by the server on every call; nothing is read from another business.

(function () {
  const TABS = [
    { id: 'info', label: 'Business information' },
    { id: 'links', label: 'Business links' },
    { id: 'files', label: 'PDFs & images' },
    { id: 'catalogues', label: 'Catalogues', feature: 'catalogues' },
    { id: 'generate', label: 'Analyze & Generate' },
    { id: 'menu', label: 'WhatsApp menu' },
    { id: 'manage', label: 'Manage account' },
  ];
  const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
  const KIND_LABELS = { website: 'Website', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', linkedin: 'LinkedIn', youtube: 'YouTube', google_maps: 'Google Maps', menu: 'Menu / catalogue page', other: 'Other' };
  const PURPOSE_LABELS = {
    company_profile: 'Company profile', service_catalogue: 'Service catalogue', product_catalogue: 'Product catalogue', price_list: 'Price list', menu: 'Menu', brochure: 'Brochure', terms: 'Terms & policies', faq: 'FAQ', promotion: 'Promotional PDF',
    logo: 'Logo', product_image: 'Product image', service_image: 'Service image', catalogue_image: 'Catalogue image', promo_image: 'Promotional image', menu_image: 'Menu image', storefront: 'Storefront', certificate: 'Certificate', other: 'Other',
  };
  const DOC_PURPOSES = ['company_profile', 'service_catalogue', 'product_catalogue', 'price_list', 'menu', 'brochure', 'terms', 'faq', 'promotion', 'other'];
  const IMAGE_PURPOSES = ['logo', 'product_image', 'service_image', 'catalogue_image', 'promo_image', 'menu_image', 'storefront', 'certificate', 'other'];
  const MENU_KINDS = [['info', 'Information page'], ['submenu', 'Sub-menu'], ['location', 'Location & hours'], ['offers', 'Current offers'], ['appointment', 'Book an appointment'], ['catalogues', 'Catalogue list'], ['quotation', 'Request a quotation'], ['handoff', 'Talk to a person']];

  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const val = (v) => (v === null || v === undefined ? '' : String(v));
  const nul = (v) => { const t = String(v === undefined ? '' : v).trim(); return t === '' ? null : t; };
  const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^[^a-z]+/, '').slice(0, 20);
  const errText = (error) => (error && error.fields ? Object.entries(error.fields).map(([k, v]) => `${k}: ${v}`).join(' · ') : (error && error.message) || 'Something went wrong');

  // ---------------------------------------------------------------- confirmation dialog (typed word)

  function confirmTyped({ title, bodyHtml, word, confirmLabel, danger }) {
    return new Promise((resolve) => {
      let dialog = document.querySelector('#typed-confirm');
      if (dialog) dialog.remove();
      dialog = document.createElement('dialog');
      dialog.id = 'typed-confirm';
      dialog.className = 'confirm-dialog';
      dialog.innerHTML = `<form method="dialog" class="confirm-form">
        <h3>${esc(title)}</h3>
        <div class="confirm-body">${bodyHtml}</div>
        <label class="confirm-label" for="typed-confirm-input">Type <b>${esc(word)}</b> to confirm</label>
        <input id="typed-confirm-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="typed-confirm-hint">
        <p id="typed-confirm-hint" class="field-help">Capital letters are required.</p>
        <div class="actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="submit" class="btn ${danger ? 'danger' : 'primary'}" disabled>${esc(confirmLabel)}</button></div>
      </form>`;
      document.body.appendChild(dialog);
      const input = dialog.querySelector('input');
      const submit = dialog.querySelector('[type=submit]');
      input.addEventListener('input', () => { submit.disabled = input.value !== word; });
      dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close('cancel'));
      dialog.addEventListener('close', () => { const ok = dialog.returnValue !== 'cancel' && input.value === word; dialog.remove(); resolve(ok); });
      dialog.querySelector('form').addEventListener('submit', (e) => { if (input.value !== word) e.preventDefault(); });
      dialog.showModal();
      input.focus();
    });
  }

  // ---------------------------------------------------------------- the page

  route(/^#\/accounts\/(?<id>\d+)$/, 'Business setup', 'Everything this business needs in one place: information, links, documents, the WhatsApp menu and generated content.', async (view, params) => {
    const id = Number(params.id);
    // Working on a business makes it the active one, so every other page shows the same business.
    if (getSelectedAccountId() !== id) {
      selectAccount(id, { silent: true });
      await loadAccounts();
    }
    const S = { id, tab: sessionStorage.getItem(`setup-tab-${id}`) || 'info', data: null, draft: null, report: null, busy: false };
    if (!TABS.some((t) => t.id === S.tab)) S.tab = 'info';
    const visibleTabs = () => TABS.filter((t) => !t.feature || (S.data && S.data.account.features && S.data.account.features[t.feature]));
    const base = `/api/dashboard/accounts/${id}/setup`;
    let disposed = false;
    disposeView = () => { disposed = true; };

    async function load() {
      S.data = await api(base);
      S.draft = S.data.draft && S.data.draft.status === 'draft' ? S.data.draft : null;
      S.lastApplied = S.data.draft && S.data.draft.status === 'applied' ? S.data.draft : null;
      document.title = `${S.data.account.name} — setup`;
    }

    function acc() { return knownAccounts.find((a) => a.id === id) || null; }

    function header() {
      const a = acc();
      const info = a ? accountStatusInfo(a.uiStatus) : { label: '', dot: '' };
      const d = S.data;
      return `<section class="panel setup-head">
        <div class="setup-head-main">
          <p class="crumb"><a href="#/accounts">WhatsApp accounts</a> / ${d.account.isLegacy ? 'Original business' : `Account ${id}`}</p>
          <h2 dir="auto">${esc(d.account.name)}</h2>
          ${d.account.nameAr ? `<p class="muted" dir="rtl">${esc(d.account.nameAr)}</p>` : ''}
          <p class="setup-badges">${a ? badge(info.label, a.uiStatus === 'connected' ? 'green' : a.uiStatus === 'disabled' ? '' : a.uiStatus === 'error' || a.uiStatus === 'disconnected' ? 'red' : 'amber') : ''}
            ${a && a.phoneNumber ? `<span class="phone-inline">${esc(a.phoneNumber)}</span>` : '<span class="muted">No number linked yet</span>'}
            ${d.account.isLegacy ? badge('Protected — cannot be deleted', 'blue') : ''}</p>
        </div>
        <div class="actions"><a class="btn" href="#/whatsapp">WhatsApp connection</a><a class="btn ghost" href="#/accounts">All accounts</a></div>
      </section>
      <div class="tabs" role="tablist" aria-label="Business setup sections">${visibleTabs().map((t) => {
        const count = t.id === 'links' ? d.links.length : t.id === 'files' ? d.documents.length + d.images.length : '';
        return `<button role="tab" id="tab-${t.id}" aria-selected="${S.tab === t.id}" aria-controls="tabpanel" tabindex="${S.tab === t.id ? 0 : -1}" class="tab ${S.tab === t.id ? 'active' : ''}" data-tab="${t.id}">${esc(t.label)}${count !== '' ? ` <span class="tab-count">${count}</span>` : ''}</button>`;
      }).join('')}</div>`;
    }

    async function draw() {
      if (disposed) return;
      if (!visibleTabs().some((t) => t.id === S.tab)) S.tab = 'info';
      if (S.tab === 'catalogues' && !S.cat) { try { await loadCatalogues(); } catch (error) { toast(errText(error), 'error'); S.tab = 'info'; } }
      const keepScroll = window.scrollY;
      view.innerHTML = `${header()}<div id="tabpanel" role="tabpanel" aria-labelledby="tab-${S.tab}" tabindex="0">${panel()}</div>`;
      view.querySelectorAll('[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => { S.tab = btn.dataset.tab; sessionStorage.setItem(`setup-tab-${id}`, S.tab); draw(); });
        btn.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          const tabs = visibleTabs();
          const i = tabs.findIndex((t) => t.id === S.tab);
          const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          S.tab = next.id; sessionStorage.setItem(`setup-tab-${id}`, S.tab); draw().then(() => view.querySelector(`#tab-${next.id}`).focus());
        });
      });
      ({ info: bindInfo, links: bindLinks, files: bindFiles, catalogues: bindCatalogues, generate: bindGenerate, menu: bindMenu, manage: bindManage })[S.tab]();
      window.scrollTo(0, keepScroll);
    }

    function panel() {
      return ({ info: infoPanel, links: linksPanel, files: filesPanel, catalogues: cataloguesPanel, generate: generatePanel, menu: menuPanel, manage: managePanel })[S.tab]();
    }

    // ============================================================== Business information
    function infoPanel() {
      const s = S.data.profile.settings;
      const o = S.data.profile.overrides;
      const a = S.data.account;
      const days = new Set(s.businessDays);
      const hoursNote = s.hoursConfigured ? '' : '<p class="field-help">No opening hours entered yet — the assistant will not state any.</p>';
      return `<form id="info-form" class="panel setup-form" autocomplete="off">
        <fieldset><legend>Names &amp; category</legend>
          <div class="form-grid">
            <div class="field"><label for="inf-name">Business name (English) *</label><input id="inf-name" name="name" type="text" maxlength="200" required value="${esc(a.name)}"></div>
            <div class="field"><label for="inf-name-ar">Business name (Arabic)</label><input id="inf-name-ar" name="nameAr" type="text" maxlength="200" dir="rtl" value="${esc(val(a.nameAr))}"></div>
            <div class="field"><label for="inf-category">Business category</label><input id="inf-category" name="businessCategory" type="text" maxlength="200" value="${esc(val(a.businessCategory))}" placeholder="e.g. Beauty salon · Paint store · Car care"><p class="field-help">The category shapes the menu that is generated.</p></div>
          </div>
        </fieldset>
        <fieldset><legend>About the business</legend>
          <div class="form-grid two">
            <div class="field"><label for="inf-desc-en">Description (English)</label><textarea id="inf-desc-en" name="descriptionEn" rows="4" maxlength="3000">${esc(val(s.descriptionEn))}</textarea></div>
            <div class="field"><label for="inf-desc-ar">Description (Arabic)</label><textarea id="inf-desc-ar" name="descriptionAr" rows="4" maxlength="3000" dir="rtl">${esc(val(s.descriptionAr))}</textarea></div>
          </div>
        </fieldset>
        <fieldset><legend>Address &amp; location</legend>
          <div class="form-grid two">
            <div class="field"><label for="inf-addr-en">Address (English)</label><input id="inf-addr-en" name="addressEn" type="text" maxlength="500" value="${esc(val(s.addressEn))}"></div>
            <div class="field"><label for="inf-addr-ar">Address (Arabic)</label><input id="inf-addr-ar" name="addressAr" type="text" maxlength="500" dir="rtl" value="${esc(val(s.addressAr))}"></div>
            <div class="field"><label for="inf-maps">Google Maps link</label><input id="inf-maps" name="googleMapsUrl" type="url" maxlength="500" value="${esc(o.googleMapsUrl || a.isLegacy ? val(s.googleMapsUrl) : '')}" placeholder="https://maps.app.goo.gl/…"><p class="field-help">Must be a Google Maps link. Left empty, no location link is shown to customers.</p></div>
            <div class="field"><label for="inf-lat">Latitude / longitude (optional)</label><div class="pair"><input id="inf-lat" name="latitude" type="number" step="any" min="-90" max="90" value="${esc(val(s.latitude))}" aria-label="Latitude"><input id="inf-lng" name="longitude" type="number" step="any" min="-180" max="180" value="${esc(val(s.longitude))}" aria-label="Longitude"></div></div>
            <div class="field"><label for="inf-notes-en">Location notes (English)</label><input id="inf-notes-en" name="locationNotesEn" type="text" maxlength="1000" value="${esc(val(s.locationNotesEn))}" placeholder="e.g. Free parking behind the building"></div>
            <div class="field"><label for="inf-notes-ar">Location notes (Arabic)</label><input id="inf-notes-ar" name="locationNotesAr" type="text" maxlength="1000" dir="rtl" value="${esc(val(s.locationNotesAr))}"></div>
          </div>
        </fieldset>
        <fieldset><legend>Business hours</legend>
          <div class="form-grid">
            <div class="field"><label for="inf-start">Opens</label><input id="inf-start" name="businessHoursStart" type="time" value="${s.hoursConfigured ? esc(s.businessHoursStart) : ''}"></div>
            <div class="field"><label for="inf-end">Closes</label><input id="inf-end" name="businessHoursEnd" type="time" value="${s.hoursConfigured ? esc(s.businessHoursEnd) : ''}"></div>
            <div class="field"><label for="inf-fri-start">Friday opens (if different)</label><input id="inf-fri-start" name="fridayHoursStart" type="time" value="${esc(val(s.fridayHoursStart))}"></div>
            <div class="field"><label for="inf-fri-end">Friday closes</label><input id="inf-fri-end" name="fridayHoursEnd" type="time" value="${esc(val(s.fridayHoursEnd))}"></div>
            <div class="field"><label for="inf-tz">Time zone</label><input id="inf-tz" name="businessTimezone" type="text" list="tz-list" value="${esc(val(s.businessTimezone))}"><datalist id="tz-list"><option>Asia/Riyadh</option><option>Asia/Dubai</option><option>Asia/Kuwait</option><option>Asia/Qatar</option><option>Asia/Bahrain</option><option>Africa/Cairo</option><option>Europe/London</option></datalist></div>
          </div>
          <div class="field"><span class="label" id="days-label">Open on</span><div class="days" role="group" aria-labelledby="days-label">${DAYS.map(([n, name]) => `<label class="day"><input type="checkbox" name="days" value="${n}" ${days.has(n) ? 'checked' : ''}> ${name}</label>`).join('')}</div></div>
          ${hoursNote}
        </fieldset>
        <fieldset><legend>Contact information</legend>
          <div class="form-grid">
            <div class="field"><label for="inf-phone">Contact phone</label><input id="inf-phone" name="contactPhone" type="tel" maxlength="40" value="${esc(val(s.contactPhone))}" placeholder="+966 5x xxx xxxx"></div>
            <div class="field"><label for="inf-email">Contact email</label><input id="inf-email" name="contactEmail" type="email" maxlength="200" value="${esc(val(s.contactEmail))}"></div>
          </div>
          <p class="field-help">Website, Instagram, Facebook and other links are managed in the <a href="#/accounts/${id}" data-goto="links">Business links</a> tab.</p>
        </fieldset>
        <div class="actions"><button type="submit" class="btn primary">Save business information</button><span id="info-status" class="muted" role="status" aria-live="polite"></span></div>
      </form>`;
    }

    function bindInfo() {
      view.querySelector('[data-goto]')?.addEventListener('click', (e) => { e.preventDefault(); S.tab = 'links'; draw(); });
      const form = view.querySelector('#info-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = form.elements;
        const days = [...form.querySelectorAll('[name=days]:checked')].map((c) => c.value);
        const profile = {
          descriptionEn: nul(f.descriptionEn.value), descriptionAr: nul(f.descriptionAr.value),
          addressEn: nul(f.addressEn.value), addressAr: nul(f.addressAr.value), googleMapsUrl: nul(f.googleMapsUrl.value),
          latitude: nul(f.latitude.value) === null ? null : Number(f.latitude.value), longitude: nul(f.longitude.value) === null ? null : Number(f.longitude.value),
          locationNotesEn: nul(f.locationNotesEn.value), locationNotesAr: nul(f.locationNotesAr.value),
          businessHoursStart: nul(f.businessHoursStart.value), businessHoursEnd: nul(f.businessHoursEnd.value),
          fridayHoursStart: nul(f.fridayHoursStart.value), fridayHoursEnd: nul(f.fridayHoursEnd.value),
          businessTimezone: nul(f.businessTimezone.value), businessDays: days.length ? days.join(',') : null,
          contactPhone: nul(f.contactPhone.value), contactEmail: nul(f.contactEmail.value),
        };
        const status = view.querySelector('#info-status');
        const submit = form.querySelector('[type=submit]');
        submit.disabled = true;
        status.textContent = 'Saving…';
        try {
          await api(`/api/dashboard/accounts/${id}`, json('PUT', { name: f.name.value.trim(), nameAr: nul(f.nameAr.value), businessCategory: nul(f.businessCategory.value) }));
          await api(`${base}/profile`, json('PUT', profile));
          await loadAccounts();
          await load();
          toast('Business information saved.', 'success');
          await draw();
        } catch (error) {
          status.textContent = '';
          toast(errText(error), 'error');
          submit.disabled = false;
        }
      });
    }

    // ============================================================== Business links
    function linkStatus(l) {
      if (l.status === 'ok') return `${badge('Readable', 'green')}<span class="muted small">${l.title ? esc(l.title) + ' · ' : ''}${l.textLength.toLocaleString()} characters read${l.fetchedAt ? ' · ' + esc(formatDate(l.fetchedAt)) : ''}</span>`;
      if (l.status === 'unavailable') return `${badge('Unavailable', 'red')}<span class="form-error">${esc(l.error || 'The page could not be read.')}</span>`;
      return `${badge('Not read yet', 'amber')}`;
    }

    function linksPanel() {
      const d = S.data;
      return `<section class="panel">
        <div class="panel-head"><div><p class="eyebrow">Public pages</p><h3>Business links</h3></div>
          <button type="button" class="btn" id="read-all" ${d.links.length ? '' : 'disabled'}>Read all links</button></div>
        <p class="muted">Add your website, social pages, maps and any other public page. The assistant's analysis reads only what a visitor can see; pages that need a login (Instagram and Facebook often do) show as unavailable and are never guessed at. Up to ${d.maxLinks} links.</p>
        <form id="link-form" class="link-form" autocomplete="off">
          <div class="field"><label for="lnk-url">Link</label><input id="lnk-url" name="url" type="text" inputmode="url" required placeholder="https://example.com/services"></div>
          <div class="field"><label for="lnk-kind">Category</label><select id="lnk-kind" name="kind"><option value="auto">Detect automatically</option>${d.linkKinds.map((k) => `<option value="${k}">${esc(KIND_LABELS[k] || k)}</option>`).join('')}</select></div>
          <div class="field"><label for="lnk-label">Label (optional)</label><input id="lnk-label" name="label" type="text" maxlength="100" placeholder="e.g. Main website"></div>
          <div class="field end"><button type="submit" class="btn primary">Add link</button></div>
        </form>
        ${d.links.length ? `<div class="table-scroll"><table class="data-table links-table"><thead><tr><th>Category</th><th>Link</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
          ${d.links.map((l) => `<tr data-link="${l.id}"><td>${esc(KIND_LABELS[l.kind] || l.kind)}</td><td class="link-cell"><div>${l.label ? `<b>${esc(l.label)}</b><br>` : ''}<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" dir="ltr">${esc(l.url)}</a></div></td><td class="status-cell">${linkStatus(l)}</td>
          <td class="row-actions"><button class="btn small" data-act="read" data-id="${l.id}">Read</button><button class="btn small ghost" data-act="edit" data-id="${l.id}">Edit</button><button class="btn small danger" data-act="remove" data-id="${l.id}">Remove</button></td></tr>`).join('')}
        </tbody></table></div>` : emptyView('No links yet. Add your website or social pages above.')}
      </section>`;
    }

    function bindLinks() {
      view.querySelector('#link-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.currentTarget.elements;
        const submit = e.currentTarget.querySelector('[type=submit]');
        submit.disabled = true;
        try {
          const created = await api(`${base}/links`, json('POST', { url: f.url.value, kind: f.kind.value, label: nul(f.label.value) }));
          toast('Link added. Reading it now…', 'success');
          await load(); await draw();
          await readLink(created.id);
        } catch (error) { toast(errText(error), 'error'); submit.disabled = false; }
      });
      view.querySelector('#read-all')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true; e.currentTarget.textContent = 'Reading…';
        try { await api(`${base}/links/read/all`, { method: 'POST' }); await load(); await draw(); toast('All links were read.', 'success'); } catch (error) { toast(errText(error), 'error'); await draw(); }
      });
      view.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
        const linkId = Number(btn.dataset.id);
        if (btn.dataset.act === 'read') { btn.disabled = true; btn.textContent = 'Reading…'; await readLink(linkId); return; }
        if (btn.dataset.act === 'remove') {
          if (!window.confirm('Remove this link? Content already analysed is not changed.')) return;
          try { await api(`${base}/links/${linkId}`, { method: 'DELETE' }); await load(); await draw(); toast('Link removed.', 'success'); } catch (error) { toast(errText(error), 'error'); }
          return;
        }
        if (btn.dataset.act === 'edit') editLinkRow(linkId);
      }));
    }

    async function readLink(linkId) {
      try { await api(`${base}/links/read/${linkId}`, { method: 'POST' }); } catch (error) { toast(errText(error), 'error'); }
      await load(); await draw();
    }

    function editLinkRow(linkId) {
      const l = S.data.links.find((x) => x.id === linkId);
      const row = view.querySelector(`tr[data-link="${linkId}"]`);
      if (!l || !row) return;
      row.innerHTML = `<td colspan="4"><form class="link-edit" autocomplete="off">
        <div class="field"><label>Category</label><select name="kind">${S.data.linkKinds.map((k) => `<option value="${k}" ${k === l.kind ? 'selected' : ''}>${esc(KIND_LABELS[k] || k)}</option>`).join('')}</select></div>
        <div class="field grow"><label>Link</label><input name="url" type="text" required value="${esc(l.url)}"></div>
        <div class="field"><label>Label</label><input name="label" type="text" maxlength="100" value="${esc(val(l.label))}"></div>
        <div class="field end"><button class="btn primary small" type="submit">Save</button> <button class="btn ghost small" type="button" data-cancel>Cancel</button></div></form></td>`;
      row.querySelector('[data-cancel]').addEventListener('click', () => draw());
      row.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.currentTarget.elements;
        try { await api(`${base}/links/${linkId}`, json('PUT', { url: f.url.value, kind: f.kind.value, label: nul(f.label.value) })); await load(); await draw(); toast('Link updated. Read it again to refresh its content.', 'success'); } catch (error) { toast(errText(error), 'error'); }
      });
      row.querySelector('input[name=url]').focus();
    }

    // ============================================================== PDFs & images
    function processingBadge(d) {
      if (d.processing === 'text_extracted') return badge('Text read', 'green');
      if (d.processing === 'extraction_failed') return badge('Could not read text', 'red');
      if (d.processing === 'stored') return badge(d.extension === 'pdf' ? 'Reading…' : 'Stored', 'amber');
      return badge('No text (not supported)', '');
    }

    function purposeSelect(name, list, selected) {
      return `<select name="${name}" aria-label="Type">${`<option value="">— not set —</option>`}${list.map((p) => `<option value="${p}" ${p === selected ? 'selected' : ''}>${esc(PURPOSE_LABELS[p] || p)}</option>`).join('')}</select>`;
    }

    function filesPanel() {
      const d = S.data;
      return `<section class="panel">
        <div class="panel-head"><div><p class="eyebrow">Documents &amp; pictures</p><h3>Upload PDFs and images</h3></div></div>
        <p class="muted">Files belong to this business only. PDFs (catalogues, price lists, menus, brochures, terms, FAQs…) are read for text that Analyze &amp; Generate and the assistant can use. Images are stored with a caption and purpose; their descriptions — not their pixels — are what gets analysed. Max ${bytes(d.limits.maxBytes)} per file.</p>
        <form id="upload-form" class="upload-form">
          <div class="field grow"><label for="up-file">File</label><input id="up-file" type="file" name="file" required multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.docx,.pptx"></div>
          <div class="field"><label for="up-purpose">Type / purpose</label><select id="up-purpose" name="purpose"><option value="">— choose —</option><optgroup label="Documents">${DOC_PURPOSES.map((p) => `<option value="${p}">${esc(PURPOSE_LABELS[p])}</option>`).join('')}</optgroup><optgroup label="Images">${IMAGE_PURPOSES.filter((p) => p !== 'other').map((p) => `<option value="${p}">${esc(PURPOSE_LABELS[p])}</option>`).join('')}</optgroup></select></div>
          <div class="field grow"><label for="up-caption">Caption / description (images)</label><input id="up-caption" name="caption" type="text" maxlength="500" placeholder="What does the picture show?"></div>
          <div class="field"><label for="up-vis">Assistant access</label><select id="up-vis" name="visibility"><option value="ai_knowledge">Assistant may use its text</option><option value="internal">Internal — setup only</option></select></div>
          <div class="field end"><button class="btn primary" type="submit">Upload</button></div>
        </form>
        <p id="upload-status" class="muted" role="status" aria-live="polite"></p>
      </section>
      <section class="panel">
        <div class="panel-head"><div><p class="eyebrow">${d.documents.length} file(s)</p><h3>PDFs &amp; documents</h3></div></div>
        ${d.documents.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>File</th><th>Type</th><th>Status</th><th>Uploaded</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
          ${d.documents.map((f) => `<tr data-file="${f.id}"><td><b dir="auto">${esc(f.title || f.original_name)}</b><br><span class="muted small" dir="auto">${esc(f.original_name)} · ${bytes(f.size_bytes)}</span></td>
            <td>${purposeSelect('purpose', DOC_PURPOSES, f.purpose)}</td>
            <td>${processingBadge(f)}${f.processing_error ? `<br><span class="form-error">${esc(f.processing_error)}</span>` : f.hasExtractedText ? `<br><span class="muted small">${f.textLength.toLocaleString()} characters</span>` : ''}</td>
            <td class="muted small">${esc(formatDate(f.created_at))}</td>
            <td class="row-actions"><a class="btn small" href="${esc(f.fileUrl)}" target="_blank" rel="noopener noreferrer">View</a><a class="btn small ghost" href="${esc(f.fileUrl)}?download=1">Download</a>${f.extension === 'pdf' ? `<button class="btn small ghost" data-act="extract" data-id="${f.id}">Re-read text</button>` : ''}<button class="btn small danger" data-act="delete" data-id="${f.id}">Delete</button></td></tr>`).join('')}
        </tbody></table></div>` : emptyView('No documents yet.')}
      </section>
      <section class="panel">
        <div class="panel-head"><div><p class="eyebrow">${d.images.length} image(s)</p><h3>Images</h3></div></div>
        ${d.images.length ? `<div class="image-grid">${d.images.map((f) => `<figure class="image-card" data-file="${f.id}">
          <img src="${esc(f.fileUrl)}" alt="${esc(f.caption || f.title || f.original_name)}" loading="lazy">
          <figcaption>
            <label class="sr-only" for="cap-${f.id}">Caption</label><input id="cap-${f.id}" name="caption" type="text" maxlength="500" value="${esc(val(f.caption))}" placeholder="Caption / description">
            ${purposeSelect('purpose', IMAGE_PURPOSES, f.purpose)}
            <span class="muted small" dir="auto">${esc(f.original_name)} · ${bytes(f.size_bytes)}</span>
            <span class="row-actions"><button class="btn small" data-act="save-image" data-id="${f.id}">Save</button><button class="btn small danger" data-act="delete" data-id="${f.id}">Delete</button></span>
          </figcaption></figure>`).join('')}</div>` : emptyView('No images yet.')}
      </section>`;
    }

    function bindFiles() {
      const form = view.querySelector('#upload-form');
      const status = view.querySelector('#upload-status');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const files = [...form.elements.file.files];
        const submit = form.querySelector('[type=submit]');
        submit.disabled = true;
        let done = 0;
        for (const file of files) {
          status.textContent = `Uploading ${file.name} (${done + 1} of ${files.length})…`;
          const isImage = /\.(png|jpe?g|webp)$/i.test(file.name);
          const purpose = form.elements.purpose.value;
          const purposeOk = isImage ? IMAGE_PURPOSES.includes(purpose) : DOC_PURPOSES.includes(purpose);
          try {
            await api(`${base}/files`, {
              method: 'POST',
              headers: {
                'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Visibility': form.elements.visibility.value,
                ...(purposeOk ? { 'X-Purpose': purpose } : {}), ...(isImage && form.elements.caption.value.trim() ? { 'X-Caption': encodeURIComponent(form.elements.caption.value.trim()) } : {}),
              },
              body: file,
            });
            done += 1;
          } catch (error) { toast(`${file.name}: ${errText(error)}`, 'error'); }
        }
        if (done) toast(`${done} file(s) uploaded.`, 'success');
        await load(); await draw();
      });
      view.querySelectorAll('tr[data-file] select[name=purpose]').forEach((sel) => sel.addEventListener('change', async () => {
        const fileId = Number(sel.closest('tr').dataset.file);
        try { await api(`${base}/files/${fileId}`, json('PATCH', { purpose: sel.value || null })); toast('Type saved.', 'success'); } catch (error) { toast(errText(error), 'error'); }
      }));
      view.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
        const fileId = Number(btn.dataset.id);
        try {
          if (btn.dataset.act === 'extract') { btn.disabled = true; btn.textContent = 'Reading…'; await api(`${base}/files/${fileId}/extract`, { method: 'POST' }); await load(); await draw(); return; }
          if (btn.dataset.act === 'save-image') {
            const card = btn.closest('[data-file]');
            await api(`${base}/files/${fileId}`, json('PATCH', { caption: nul(card.querySelector('[name=caption]').value), purpose: card.querySelector('[name=purpose]').value || null }));
            toast('Image details saved.', 'success'); await load(); await draw(); return;
          }
          if (btn.dataset.act === 'delete') {
            if (!window.confirm('Delete this file permanently? Content already generated from it is not removed.')) return;
            await api(`${base}/files/${fileId}`, { method: 'DELETE' }); await load(); await draw(); toast('File deleted.', 'success');
          }
        } catch (error) { toast(errText(error), 'error'); }
      }));
    }

    // ============================================================== Catalogues (a business with the catalogue library)
    const catBase = `/api/dashboard/accounts/${id}/catalogues`;
    async function loadCatalogues() { S.cat = await api(catBase); }

    function cataloguesPanel() {
      const c = S.cat;
      const q = (S.catFilter || '').trim().toLowerCase();
      const rows = c.catalogues.filter((x) => !q || `${x.title} ${x.originalName}`.toLowerCase().includes(q));
      const maxMb = Math.round(c.limits.maxBytes / 1048576);
      return `<section class="panel">
        <div class="panel-head"><div><p class="eyebrow">${c.catalogues.length} catalogue(s) · ${c.enabledCount} offered to customers</p><h3>Upload catalogue PDFs</h3></div></div>
        <p class="muted">Customers who ask for a catalogue (or choose it in the WhatsApp menu) are shown the list below and receive the PDF they pick. PDF only, up to ${maxMb} MB each. A disabled catalogue is hidden from customers and from the assistant; deleting one removes the file for good.</p>
        <form id="cat-upload" class="upload-form">
          <div class="field grow"><label for="cat-file">PDF files (you can choose several)</label><input id="cat-file" type="file" name="file" accept="application/pdf,.pdf" multiple required></div>
          <div class="field grow"><label for="cat-title">Title (optional — one file only)</label><input id="cat-title" name="title" type="text" maxlength="${c.limits.maxTitle}" placeholder="Shown to customers"></div>
          <div class="field end"><button class="btn primary" type="submit">Upload</button></div>
        </form>
        <p id="cat-status" class="muted" role="status" aria-live="polite"></p>
      </section>
      <section class="panel">
        <div class="panel-head"><div><p class="eyebrow">Library</p><h3>Uploaded catalogues</h3></div>
          <div class="field"><label class="sr-only" for="cat-filter">Search catalogues</label><input id="cat-filter" type="search" placeholder="Search catalogues…" value="${esc(S.catFilter || '')}"></div></div>
        ${rows.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Order</th><th>Catalogue</th><th>Pages</th><th>Size</th><th>Status</th><th>Uploaded</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
          ${rows.map((x, i) => `<tr data-cat="${x.id}">
            <td class="row-actions"><button class="btn small ghost" data-act="up" data-id="${x.id}" aria-label="Move up" ${q || i === 0 ? 'disabled' : ''}>↑</button><button class="btn small ghost" data-act="down" data-id="${x.id}" aria-label="Move down" ${q || i === rows.length - 1 ? 'disabled' : ''}>↓</button></td>
            <td><label class="sr-only" for="cat-title-${x.id}">Title</label><input id="cat-title-${x.id}" name="title" type="text" dir="auto" maxlength="${c.limits.maxTitle}" value="${esc(x.title)}"><br><span class="muted small" dir="auto">${esc(x.originalName)}</span></td>
            <td>${x.pageCount === null ? '—' : x.pageCount}</td>
            <td>${bytes(x.sizeBytes)}</td>
            <td>${x.enabled ? badge('Offered to customers', 'green') : badge('Disabled', 'amber')}${x.hasText ? '' : '<br>' + badge('No readable text', '')}</td>
            <td class="muted small">${esc(formatDate(x.uploadedAt))}</td>
            <td class="row-actions"><button class="btn small" data-act="save-title" data-id="${x.id}">Save title</button><a class="btn small ghost" href="${esc(x.fileUrl)}" target="_blank" rel="noopener noreferrer">Preview</a><a class="btn small ghost" href="${esc(x.fileUrl)}?download=1">Download</a><button class="btn small ghost" data-act="toggle" data-id="${x.id}" data-enabled="${x.enabled ? 1 : 0}">${x.enabled ? 'Disable' : 'Enable'}</button><label class="btn small ghost">Replace<input type="file" accept="application/pdf,.pdf" data-act="replace" data-id="${x.id}" hidden></label><button class="btn small danger" data-act="delete" data-id="${x.id}">Delete</button></td>
          </tr>`).join('')}
        </tbody></table></div>` : emptyView(c.catalogues.length ? 'No catalogue matches your search.' : 'No catalogues yet — upload a PDF above.')}
      </section>
      <section class="panel">
        <div class="panel-head"><div><p class="eyebrow">Preview</p><h3>What customers see</h3></div></div>
        <p class="muted">Generated from the enabled catalogues above; it updates the moment you enable, disable, reorder, add or delete one.</p>
        <div class="reply-compare"><div><p class="eyebrow">English</p><pre class="reply-preview" dir="auto">${esc(c.customerPreview.en)}</pre></div><div><p class="eyebrow">العربية</p><pre class="reply-preview" dir="rtl">${esc(c.customerPreview.ar)}</pre></div></div>
      </section>`;
    }

    function bindCatalogues() {
      const form = view.querySelector('#cat-upload');
      const status = view.querySelector('#cat-status');
      const refresh = async () => { await loadCatalogues(); await draw(); };
      const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      const send = (path, method, file, title) => api(path, { method, headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name), ...(title ? { 'X-Title': encodeURIComponent(title) } : {}) }, body: file });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const files = [...form.elements.file.files];
        const title = form.elements.title.value.trim();
        const submit = form.querySelector('[type=submit]');
        submit.disabled = true;
        let done = 0;
        for (const [i, file] of files.entries()) {
          status.textContent = `Uploading ${file.name} (${i + 1} of ${files.length})…`;
          if (!isPdf(file)) { toast(`${file.name}: only PDF files can be added.`, 'error'); continue; }
          try { await send(catBase, 'POST', file, files.length === 1 ? title : ''); done += 1; } catch (error) { toast(`${file.name}: ${errText(error)}`, 'error'); }
        }
        if (done) toast(`${done} catalogue(s) added.`, 'success');
        await refresh();
      });

      const filter = view.querySelector('#cat-filter');
      filter.addEventListener('input', async () => { S.catFilter = filter.value; await draw(); const f = view.querySelector('#cat-filter'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); });

      view.querySelectorAll('[data-act]').forEach((el) => {
        const cid = Number(el.dataset.id);
        if (el.dataset.act === 'replace') {
          el.addEventListener('change', async () => {
            const file = el.files[0];
            if (!file) return;
            if (!isPdf(file)) { toast('Only PDF files can be used.', 'error'); return; }
            if (!window.confirm('Replace this catalogue file? Customers will receive the new file from now on.')) return;
            try { await send(`${catBase}/${cid}/file`, 'PUT', file); toast('Catalogue file replaced.', 'success'); await refresh(); } catch (error) { toast(errText(error), 'error'); }
          });
          return;
        }
        el.addEventListener('click', async () => {
          try {
            if (el.dataset.act === 'save-title') { await api(`${catBase}/${cid}`, json('PATCH', { title: view.querySelector(`#cat-title-${cid}`).value })); toast('Title saved.', 'success'); await refresh(); return; }
            if (el.dataset.act === 'toggle') { const enable = el.dataset.enabled !== '1'; await api(`${catBase}/${cid}`, json('PATCH', { enabled: enable })); toast(enable ? 'Catalogue is now offered to customers.' : 'Catalogue hidden from customers.', 'success'); await refresh(); return; }
            if (el.dataset.act === 'up' || el.dataset.act === 'down') { await api(`${catBase}/${cid}/move`, json('POST', { direction: el.dataset.act })); await refresh(); return; }
            if (el.dataset.act === 'delete') {
              if (!window.confirm('Delete this catalogue and its file permanently? Customers will no longer see it.')) return;
              await api(`${catBase}/${cid}`, { method: 'DELETE' }); toast('Catalogue deleted.', 'success'); await refresh();
            }
          } catch (error) { toast(errText(error), 'error'); }
        });
      });
    }

    // ============================================================== Analyze & Generate
    function sourcesSummary() {
      const d = S.data;
      const readable = d.links.filter((l) => l.status === 'ok').length;
      const unreadable = d.links.filter((l) => l.status === 'unavailable').length;
      const pending = d.links.filter((l) => l.status === 'pending').length;
      const docs = d.documents.filter((f) => f.hasExtractedText).length;
      const docsNoText = d.documents.filter((f) => !f.hasExtractedText).length;
      return `<ul class="source-list">
        <li>${badge(String(readable), readable ? 'green' : '')} link(s) read${unreadable ? ` · ${badge(String(unreadable), 'red')} unavailable` : ''}${pending ? ` · ${badge(String(pending), 'amber')} not read yet` : ''}</li>
        <li>${badge(String(docs), docs ? 'green' : '')} document(s) with readable text${docsNoText ? ` · ${badge(String(docsNoText), 'red')} without` : ''}</li>
        <li>${badge(String(d.images.length), '')} image(s) — captions and purposes are used, not the pixels</li>
        <li>Business information: ${d.profile.settings.descriptionEn || d.profile.settings.descriptionAr ? badge('description provided', 'green') : badge('no description yet', 'amber')}</li>
      </ul>`;
    }

    function generatePanel() {
      const d = S.data;
      const draft = S.draft;
      const aiLine = d.ai.available ? 'AI analysis is available — it only keeps facts it can quote from your sources.' : d.ai.mode === 'mock' ? 'AI analysis is in mock mode here — sources are analysed by rules (headings, lists, prices, Q&amp;A).' : 'OpenRouter is not configured — sources are analysed by rules (headings, lists, prices, Q&amp;A).';
      return `<section class="panel">
        <div class="panel-head"><div><p class="eyebrow">Step 1</p><h3>Analyze &amp; Generate</h3></div></div>
        <p class="muted">Reads <b>only this business's</b> information, links, PDFs and image notes and prepares a <b>draft</b>. Nothing is published or overwritten until you review, edit and apply it. Anything the sources do not state stays "Not provided" — prices, offers, hours, addresses and policies are never invented.</p>
        ${sourcesSummary()}
        <p class="muted small">${aiLine}</p>
        <div class="actions"><button type="button" class="btn primary big" id="generate-btn">${draft ? 'Analyze again (new draft)' : 'Analyze & Generate'}</button>
          <label class="inline-check"><input type="checkbox" id="use-ai" ${d.ai.available ? 'checked' : 'disabled'}> Use AI when available</label>
          <span id="gen-status" class="muted" role="status" aria-live="polite"></span></div>
      </section>
      ${draft ? draftEditor() : S.lastApplied ? appliedSummary(S.lastApplied) : `<section class="panel">${emptyView('No draft yet. Click "Analyze & Generate" to prepare one.')}</section>`}`;
    }

    function appliedSummary(applied) {
      return `<section class="panel" id="applied-summary"><div class="panel-head"><div><p class="eyebrow">Last applied</p><h3>Draft #${applied.id} was applied</h3></div></div>
        <p class="muted small">${esc(formatDate(applied.appliedAt || applied.updatedAt))} · ${esc(applied.apply ? applied.apply.mode.replace('_', ' ') : '')}</p>${applied.apply ? reportHtml(applied.apply) : ''}<p class="muted small">Edit the generated text in the <a href="#/replies">Manual Reply Editor</a>, <a href="#/knowledge">Business Knowledge</a> and <a href="#/offers">Offers</a>.</p></section>`;
    }

    function reportHtml(report) {
      const tone = { applied: 'green', staged: 'blue', kept: 'amber', skipped: '', error: 'red' };
      return `<ul class="report-list">${report.entries.map((e) => `<li>${badge(e.section, tone[e.action] || '')} <b>${esc(e.action)}</b> — ${esc(e.detail)}</li>`).join('')}</ul>
        ${report.backups && report.backups.length ? `<p class="muted small">Backups: ${report.backups.map((b) => esc(b)).join(' · ')}</p>` : ''}`;
    }

    // ---- draft editor (state lives in S.draft.content; inputs carry a data-path)
    const getAt = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    const setAt = (obj, path, value) => { const keys = path.split('.'); const last = keys.pop(); const target = keys.reduce((o, k) => o[k], obj); target[last] = value; };

    function tf(path, label, value, opts = {}) {
      const id = `d-${path.replace(/\./g, '-')}`;
      const common = `id="${id}" data-path="${path}" ${opts.rtl ? 'dir="rtl"' : ''} ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : 'placeholder="Not provided"'}`;
      const input = opts.rows ? `<textarea ${common} rows="${opts.rows}">${esc(val(value))}</textarea>` : `<input ${common} type="text" value="${esc(val(value))}">`;
      return `<div class="field ${opts.cls || ''}"><label for="${id}">${esc(label)}</label>${input}</div>`;
    }

    function includeBox(path, checked) {
      return `<label class="include"><input type="checkbox" data-bool="${path}" ${checked ? 'checked' : ''}> <span>Include</span></label>`;
    }

    function itemRows(listPath, items, kind) {
      if (!items.length) return `<p class="muted small">None found in the sources. Add one by hand if you want it included.</p>`;
      return items.map((it, i) => {
        const p = `${listPath}.${i}`;
        return `<div class="draft-item ${it.include ? '' : 'excluded'}">
          <div class="draft-item-head">${includeBox(`${p}.include`, it.include)}<span class="src" title="${esc(it.evidence || '')}">${esc(it.source)}</span><button type="button" class="btn small ghost" data-remove="${listPath}" data-index="${i}">Remove</button></div>
          <div class="form-grid two">${tf(`${p}.nameEn`, 'Name (English)', it.nameEn)}${tf(`${p}.nameAr`, 'Name (Arabic)', it.nameAr, { rtl: true })}
          ${tf(`${p}.descriptionEn`, 'Description (English)', it.descriptionEn, { rows: 2 })}${tf(`${p}.descriptionAr`, 'Description (Arabic)', it.descriptionAr, { rtl: true, rows: 2 })}
          ${kind === 'offer' ? '' : tf(`${p}.price`, 'Price, exactly as the source states it', it.price, { placeholder: 'Not provided' })}</div>
          ${it.evidence ? `<p class="evidence">“${esc(it.evidence)}”</p>` : ''}</div>`;
      }).join('');
    }

    function draftSection(title, count, body, open) {
      return `<details class="draft-section" ${open ? 'open' : ''}><summary><span>${esc(title)}</span>${count !== null ? `<span class="tab-count">${count}</span>` : ''}</summary><div class="draft-body">${body}</div></details>`;
    }

    function draftEditor() {
      const draft = S.draft;
      const c = draft.content;
      const warn = draft.warnings.length ? `<div class="notice amber" role="status"><b>Notes about this analysis</b><ul>${draft.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
      const gaps = c.gaps.length ? `<details class="draft-section" open><summary><span>Not provided / not found</span><span class="tab-count">${c.gaps.length}</span></summary><div class="draft-body"><ul class="gap-list">${c.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div></details>` : '';
      const biz = `<div class="form-grid two">${tf('profile.introEn', 'Introduction (English)', c.profile.introEn, { rows: 2 })}${tf('profile.introAr', 'Introduction (Arabic)', c.profile.introAr, { rows: 2, rtl: true })}
        ${tf('profile.shortEn', 'Short description (English)', c.profile.shortEn, { rows: 2 })}${tf('profile.shortAr', 'Short description (Arabic)', c.profile.shortAr, { rows: 2, rtl: true })}
        ${tf('profile.detailedEn', 'Detailed description (English)', c.profile.detailedEn, { rows: 4 })}${tf('profile.detailedAr', 'Detailed description (Arabic)', c.profile.detailedAr, { rows: 4, rtl: true })}</div>`;
      const loc = `<div class="form-grid two">${tf('hours.en', 'Opening hours (English)', c.hours.en, { rows: 3 })}${tf('hours.ar', 'Opening hours (Arabic)', c.hours.ar, { rows: 3, rtl: true })}
        ${tf('location.addressEn', 'Address (English)', c.location.addressEn)}${tf('location.addressAr', 'Address (Arabic)', c.location.addressAr, { rtl: true })}
        ${tf('location.mapsUrl', 'Google Maps link', c.location.mapsUrl)}${tf('location.notesEn', 'Location notes (English)', c.location.notesEn)}
        ${tf('contact.phone', 'Phone', c.contact.phone)}${tf('contact.email', 'Email', c.contact.email)}${tf('contact.website', 'Website', c.contact.website)}</div>`;
      const faqs = c.faqs.length ? c.faqs.map((f, i) => `<div class="draft-item ${f.include ? '' : 'excluded'}"><div class="draft-item-head">${includeBox(`faqs.${i}.include`, f.include)}<span class="src" title="${esc(f.evidence || '')}">${esc(f.source)}</span><button type="button" class="btn small ghost" data-remove="faqs" data-index="${i}">Remove</button></div>
        <div class="form-grid two">${tf(`faqs.${i}.questionEn`, 'Question (English)', f.questionEn)}${tf(`faqs.${i}.questionAr`, 'Question (Arabic)', f.questionAr, { rtl: true })}${tf(`faqs.${i}.answerEn`, 'Answer (English)', f.answerEn, { rows: 2 })}${tf(`faqs.${i}.answerAr`, 'Answer (Arabic)', f.answerAr, { rows: 2, rtl: true })}</div></div>`).join('') : '<p class="muted small">No FAQs found in the sources.</p>';
      const info = `<div class="form-grid two">${tf('appointmentInfo.en', 'Appointment information (English)', c.appointmentInfo.en, { rows: 2 })}${tf('appointmentInfo.ar', 'Appointment information (Arabic)', c.appointmentInfo.ar, { rows: 2, rtl: true })}
        ${tf('quotationInfo.en', 'Quotation information (English)', c.quotationInfo.en, { rows: 2 })}${tf('quotationInfo.ar', 'Quotation information (Arabic)', c.quotationInfo.ar, { rows: 2, rtl: true })}
        ${tf('handoffInfo.en', 'Human-support hand-off (English)', c.handoffInfo.en, { rows: 2 })}${tf('handoffInfo.ar', 'Human-support hand-off (Arabic)', c.handoffInfo.ar, { rows: 2, rtl: true })}
        ${tf('outOfHours.en', 'Out-of-hours response (English)', c.outOfHours.en, { rows: 3 })}${tf('outOfHours.ar', 'Out-of-hours response (Arabic)', c.outOfHours.ar, { rows: 3, rtl: true })}</div>`;
      const replies = c.autoReplies.length ? c.autoReplies.map((t, i) => `<div class="draft-item ${t.include ? '' : 'excluded'}"><div class="draft-item-head">${includeBox(`autoReplies.${i}.include`, t.include)}<b>${esc(t.titleEn)}</b><code class="src">${esc(t.key)}</code>${t.edited ? badge('edited by you', 'blue') : ''}</div>
        <div class="form-grid two">${tf(`autoReplies.${i}.en`, 'Reply (English)', t.en, { rows: 6 })}${tf(`autoReplies.${i}.ar`, 'Reply (Arabic)', t.ar, { rows: 6, rtl: true })}</div></div>`).join('') : '<p class="muted small">No replies are proposed for this business.</p>';
      const knowledge = c.aiKnowledge.length ? c.aiKnowledge.map((k, i) => `<div class="draft-item ${k.include ? '' : 'excluded'}"><div class="draft-item-head">${includeBox(`aiKnowledge.${i}.include`, k.include)}<span class="src">${esc(k.source)}</span><button type="button" class="btn small ghost" data-remove="aiKnowledge" data-index="${i}">Remove</button></div>
        <div class="form-grid two">${tf(`aiKnowledge.${i}.title`, 'Title', k.title)}${tf(`aiKnowledge.${i}.text`, 'Fact the assistant may use', k.text, { rows: 2 })}</div></div>`).join('') : '<p class="muted small">No extra facts found.</p>';
      const hasMenu = S.data.account.isLegacy ? '<p class="muted">The original business keeps its built-in menu and reply wording. Generated content is applied to its profile, knowledge files and offers.</p>' : `<div id="draft-menu">${menuEditorHtml(c.menu, 'draft')}</div><p class="field-help">After changing the menu, press "Save edits" to refresh the menu text and pages below.</p>`;

      return `<section class="panel draft-panel" aria-labelledby="draft-title">
        <div class="panel-head"><div><p class="eyebrow">Step 2 · Draft #${draft.id} · ${draft.generator === 'ai' ? `AI-assisted${draft.model ? ' (' + esc(draft.model) + ')' : ''}` : 'rule-based'}</p><h3 id="draft-title">Review &amp; edit the draft</h3></div>
          <button class="btn ghost" id="discard-draft" type="button">Discard draft</button></div>
        <p class="muted small">Untick “Include” to leave an item out. Everything is editable. Nothing below is live yet.</p>
        ${warn}${gaps}
        ${draftSection('Business introduction & descriptions', null, biz, true)}
        ${draftSection('Hours, location & contact', null, loc, false)}
        ${draftSection('Services', c.services.length, itemRows('services', c.services, 'item') + '<button type="button" class="btn small" data-add="services">Add a service</button>', c.services.length > 0)}
        ${draftSection('Products', c.products.length, itemRows('products', c.products, 'item') + '<button type="button" class="btn small" data-add="products">Add a product</button>', c.products.length > 0)}
        ${draftSection('Categories, brands & colours', c.categories.length, itemRows('categories', c.categories, 'item') + '<button type="button" class="btn small" data-add="categories">Add a category</button>', false)}
        ${draftSection('Offers (created as draft offers — you publish them)', c.offers.length, itemRows('offers', c.offers, 'offer') + '<button type="button" class="btn small" data-add="offers">Add an offer</button>', c.offers.length > 0)}
        ${draftSection('FAQs', c.faqs.length, faqs + '<button type="button" class="btn small" data-add="faqs">Add a FAQ</button>', false)}
        ${draftSection('Appointments, quotations, hand-off & out-of-hours', null, info, false)}
        ${draftSection('WhatsApp menu', S.data.account.isLegacy ? null : c.menu.items.length, hasMenu, !S.data.account.isLegacy)}
        ${draftSection('WhatsApp auto replies (menu text and pages)', c.autoReplies.length, replies, false)}
        ${draftSection('AI knowledge entries', c.aiKnowledge.length, knowledge + '<button type="button" class="btn small" data-add="aiKnowledge">Add a fact</button>', false)}
        <div class="actions sticky-actions"><button class="btn" id="save-draft-edits" type="button">Save edits</button><span id="draft-status" class="muted" role="status" aria-live="polite"></span></div>
      </section>
      <section class="panel apply-panel" aria-labelledby="apply-title">
        <div class="panel-head"><div><p class="eyebrow">Step 3</p><h3 id="apply-title">Apply the draft</h3></div></div>
        <fieldset class="apply-modes"><legend class="sr-only">How should the draft be applied?</legend>
          <label class="mode"><input type="radio" name="apply-mode" value="save_draft"><span><b>Save as draft</b><small>Stage replies and offers as unpublished drafts. Nothing customers or the assistant see changes.</small></span></label>
          <label class="mode"><input type="radio" name="apply-mode" value="merge" checked><span><b>Merge (recommended)</b><small>Fill empty fields, refresh generated text you have not edited, keep everything you wrote by hand. Offers become draft offers.</small></span></label>
          <label class="mode danger"><input type="radio" name="apply-mode" value="replace"><span><b>Replace existing</b><small>Overwrite existing profile fields, knowledge files (backed up first), replies and menu with this draft. Needs confirmation.</small></span></label>
        </fieldset>
        <fieldset class="apply-sections"><legend>What to apply</legend>
          ${[['profile', 'Business information'], ['knowledge', 'Knowledge files (business, services, FAQ, policies, AI facts)'], ['offers', 'Offers'], ['templates', 'WhatsApp replies'], ['menu', 'WhatsApp menu']].map(([k, label]) => `<label class="inline-check"><input type="checkbox" name="apply-section" value="${k}" checked> ${esc(label)}</label>`).join('')}
        </fieldset>
        <div class="actions"><button class="btn primary big" id="apply-btn" type="button">Apply draft</button><span id="apply-status" class="muted" role="status" aria-live="polite"></span></div>
        ${S.report ? `<div class="notice" role="status" tabindex="-1" id="apply-report"><b>Result</b>${reportHtml(S.report)}<p class="muted small">Edit the generated text in the <a href="#/replies">Manual Reply Editor</a>, <a href="#/knowledge">Business Knowledge</a> and <a href="#/offers">Offers</a>.</p></div>` : ''}
      </section>`;
    }

    function bindGenerate() {
      view.querySelector('#generate-btn').addEventListener('click', async (e) => {
        if (S.draft && !window.confirm('Start a new analysis? The current open draft (and any edits you made to it) will be replaced by the new one.')) return;
        const btn = e.currentTarget;
        btn.disabled = true;
        const status = view.querySelector('#gen-status');
        status.textContent = 'Analyzing sources… this can take up to a minute with AI.';
        try {
          const prev = S.draft;
          const draft = await api(`${base}/generate`, json('POST', { useAi: view.querySelector('#use-ai').checked }));
          if (prev) { try { await api(`${base}/drafts/${prev.id}`, { method: 'DELETE' }); } catch { /* already gone */ } }
          S.draft = draft; S.report = null;
          await draw();
          toast('Draft ready — review it below.', 'success');
          view.querySelector('#draft-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (error) { status.textContent = ''; toast(errText(error), 'error'); btn.disabled = false; }
      });
      if (!S.draft) return;
      const panelEl = view.querySelector('.draft-panel');
      panelEl.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.path) setAt(S.draft.content, t.dataset.path, t.value.trim() === '' && /(\.(nameEn|nameAr|descriptionEn|descriptionAr|price|questionEn|questionAr|answerEn|answerAr)|^(profile|hours|location|contact)\.|Info\.|outOfHours\.)/.test(t.dataset.path) ? null : t.value);
      });
      panelEl.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.bool) { setAt(S.draft.content, t.dataset.bool, t.checked); t.closest('.draft-item')?.classList.toggle('excluded', !t.checked); }
      });
      panelEl.addEventListener('click', (e) => {
        const add = e.target.closest('[data-add]');
        const remove = e.target.closest('[data-remove]');
        if (add) {
          const list = S.draft.content[add.dataset.add];
          const n = list.length + 1;
          if (add.dataset.add === 'faqs') list.push({ id: `x${Date.now()}`, questionEn: null, questionAr: null, answerEn: null, answerAr: null, source: 'manual', evidence: null, include: true });
          else if (add.dataset.add === 'aiKnowledge') list.push({ id: `x${Date.now()}`, title: 'New fact', text: 'Write the fact here', source: 'manual', include: true });
          else list.push({ id: `x${Date.now()}${n}`, nameEn: null, nameAr: null, descriptionEn: null, descriptionAr: null, price: null, source: 'manual', evidence: null, include: true });
          draw();
        }
        if (remove) { S.draft.content[remove.dataset.remove].splice(Number(remove.dataset.index), 1); draw(); }
      });
      const menuHost = view.querySelector('#draft-menu');
      if (menuHost) bindMenuEditor(menuHost, () => S.draft.content.menu, (m) => { S.draft.content.menu = m; }, () => { menuHost.innerHTML = menuEditorHtml(S.draft.content.menu, 'draft'); }, 'draft');
      view.querySelector('#save-draft-edits').addEventListener('click', () => saveDraftEdits(true));
      view.querySelector('#discard-draft').addEventListener('click', async () => {
        if (!window.confirm('Discard this draft? The analysis can be run again at any time.')) return;
        try { await api(`${base}/drafts/${S.draft.id}`, { method: 'DELETE' }); S.draft = null; S.report = null; await load(); await draw(); toast('Draft discarded.', 'success'); } catch (error) { toast(errText(error), 'error'); }
      });
      view.querySelector('#apply-btn').addEventListener('click', applyDraftClick);
    }

    async function saveDraftEdits(announce) {
      const status = view.querySelector('#draft-status');
      if (status) status.textContent = 'Saving…';
      try {
        const saved = await api(`${base}/drafts/${S.draft.id}`, json('PUT', { content: S.draft.content }));
        S.draft = saved;
        if (announce) { await draw(); toast('Draft edits saved.', 'success'); }
        return true;
      } catch (error) { if (status) status.textContent = ''; toast(errText(error), 'error'); return false; }
    }

    async function applyDraftClick() {
      const mode = view.querySelector('[name=apply-mode]:checked').value;
      const sections = [...view.querySelectorAll('[name=apply-section]:checked')].map((c) => c.value);
      if (!sections.length) { toast('Choose at least one thing to apply.', 'error'); return; }
      let confirmWord;
      if (mode === 'replace') {
        const ok = await confirmTyped({
          title: 'Replace existing content?',
          bodyHtml: '<p>This overwrites the existing business information fields, knowledge files, WhatsApp replies and menu of this business with the draft. Knowledge files are backed up first; replies and profile values are not.</p><p><b>Hand-written changes will be lost.</b> Choose Merge to keep them.</p>',
          word: 'REPLACE', confirmLabel: 'Replace existing content', danger: true,
        });
        if (!ok) return;
        confirmWord = 'REPLACE';
      }
      const btn = view.querySelector('#apply-btn');
      btn.disabled = true;
      const status = view.querySelector('#apply-status');
      status.textContent = 'Saving edits and applying…';
      if (!(await saveDraftEdits(false))) { btn.disabled = false; return; }
      try {
        const result = await api(`${base}/drafts/${S.draft.id}/apply`, json('POST', { mode, confirm: confirmWord, sections }));
        S.report = result.report;
        if (mode === 'save_draft') { S.draft = result.draft; } else { S.lastApplied = result.draft; S.draft = null; }
        await loadAccounts(); await load();
        if (mode !== 'save_draft') S.draft = null;
        await draw();
        toast(mode === 'save_draft' ? 'Draft staged — nothing live changed.' : 'Draft applied.', 'success');
        const resultEl = view.querySelector('#apply-report') || view.querySelector('#applied-summary');
        if (resultEl) { resultEl.setAttribute('tabindex', '-1'); resultEl.scrollIntoView({ block: 'start' }); resultEl.focus(); }
      } catch (error) { toast(errText(error), 'error'); btn.disabled = false; status.textContent = ''; }
    }

    // ============================================================== menu editor (shared by the Menu tab and the draft)
    function menuEditorHtml(config, scope) {
      const rows = (items, prefix, depth) => items.map((it, i) => {
        const p = `${prefix}${i}`;
        const kindOptions = MENU_KINDS.filter(([k]) => !(depth > 0 && k === 'submenu') && !(k === 'catalogues' && (depth > 0 || !(S.data.account.features && S.data.account.features.catalogues)))).map(([k, label]) => `<option value="${k}" ${k === it.kind ? 'selected' : ''}>${esc(label)}</option>`).join('');
        return `<li class="menu-item depth-${depth}" data-mpath="${p}">
          <span class="menu-no" aria-hidden="true">${i + 1}</span>
          <div class="menu-fields">
            <select data-mf="kind" aria-label="Type of menu entry ${i + 1}">${kindOptions}</select>
            <input data-mf="labelEn" type="text" maxlength="60" value="${esc(it.labelEn)}" placeholder="English label" aria-label="English label ${i + 1}">
            <input data-mf="labelAr" type="text" maxlength="60" dir="rtl" value="${esc(it.labelAr)}" placeholder="التسمية العربية" aria-label="Arabic label ${i + 1}">
          </div>
          <span class="menu-acts"><button type="button" class="btn small ghost" data-ma="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="btn small ghost" data-ma="down" aria-label="Move down" ${i === items.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="btn small danger" data-ma="remove" aria-label="Remove entry ${i + 1}">Remove</button></span>
          ${it.kind === 'submenu' ? `<ol class="menu-children">${rows(it.children || [], `${p}.`, depth + 1)}<li><button type="button" class="btn small" data-ma="addchild">Add entry to this sub-menu</button></li></ol>` : ''}
        </li>`;
      }).join('');
      return `<ol class="menu-editor" data-scope="${scope}">${rows(config.items, '', 0)}</ol>
        <div class="actions"><button type="button" class="btn small" data-ma="add" ${config.items.length >= 9 ? 'disabled' : ''}>Add menu entry</button><span class="muted small">Up to 9 entries; customers pick them by number.</span></div>`;
    }

    // path helpers: "2" = items[2]; "2.1" = items[2].children[1]
    function menuAt(config, path) {
      const idx = path.split('.').map(Number);
      let list = config.items; let item = null; let parent = null;
      idx.forEach((n, d) => { parent = d === 0 ? null : item; item = list[n]; if (d < idx.length - 1) list = item.children; });
      return { item, list: idx.length === 1 ? config.items : parent.children, index: idx[idx.length - 1], parent };
    }

    function bindMenuEditor(host, getConfig, setConfig, rerender, scope) {
      host.addEventListener('input', (e) => {
        const f = e.target.dataset.mf; if (!f) return;
        const li = e.target.closest('[data-mpath]');
        const { item } = menuAt(getConfig(), li.dataset.mpath);
        item[f] = e.target.value;
      });
      host.addEventListener('change', (e) => {
        if (e.target.dataset.mf !== 'kind') return;
        const li = e.target.closest('[data-mpath]');
        const { item } = menuAt(getConfig(), li.dataset.mpath);
        item.kind = e.target.value;
        if (item.kind === 'submenu') item.children = item.children && item.children.length ? item.children : [{ id: `${item.id}e1`, kind: 'info', labelEn: 'Details', labelAr: 'التفاصيل' }];
        else delete item.children;
        rerender();
      });
      host.addEventListener('click', (e) => {
        const b = e.target.closest('[data-ma]'); if (!b) return;
        const act = b.dataset.ma; const config = getConfig();
        const uniqueId = (label, base0) => { const all = new Set(); const collect = (items) => items.forEach((i) => { all.add(i.id); if (i.children) collect(i.children); }); collect(config.items); let id0 = slug(label) || base0; let n = 1; let id = id0; while (all.has(id)) { n += 1; id = `${id0}${n}`.slice(0, 24); } return id; };
        if (act === 'add') { config.items.push({ id: uniqueId('', 'item'), kind: 'info', labelEn: 'New entry', labelAr: 'قسم جديد' }); rerender(); return; }
        const li = b.closest('[data-mpath]');
        if (act === 'addchild') { const { item } = menuAt(config, b.closest('[data-mpath]').dataset.mpath); item.children.push({ id: uniqueId('', 'entry'), kind: 'info', labelEn: 'New entry', labelAr: 'قسم جديد' }); rerender(); return; }
        if (!li) return;
        const { list, index } = menuAt(config, li.dataset.mpath);
        if (act === 'remove') list.splice(index, 1);
        if (act === 'up' && index > 0) [list[index - 1], list[index]] = [list[index], list[index - 1]];
        if (act === 'down' && index < list.length - 1) [list[index + 1], list[index]] = [list[index], list[index + 1]];
        rerender();
      });
      // new ids follow the English label while the entry is still unsaved ("newentry" style ids keep working)
      host.addEventListener('blur', (e) => {
        if (e.target.dataset.mf !== 'labelEn') return;
        const li = e.target.closest('[data-mpath]');
        const { item } = menuAt(getConfig(), li.dataset.mpath);
        if (/^(item|entry)\d*$/.test(item.id) || /^newentry\d*$/.test(item.id)) { const s = slug(item.labelEn); if (s) { const taken = JSON.stringify(getConfig()).includes(`"id":"${s}"`); if (!taken) item.id = s; } }
      }, true);
    }

    // ============================================================== WhatsApp menu tab
    function menuPanel() {
      const m = S.data.menu;
      if (m.builtIn) {
        return `<section class="panel"><div class="panel-head"><div><p class="eyebrow">Original business</p><h3>Built-in WhatsApp menu</h3></div></div>
          <p class="muted">This business keeps its built-in menu structure (car audio, accessories, care, tinting, prices, location, appointment, staff, about). Edit the wording of every option in the <a href="#/replies">Manual Reply Editor</a>; see how the numbers connect in the <a href="#/flow">Flow map</a>.</p></section>`;
      }
      if (!S.menuDraft) S.menuDraft = structuredClone(m.config);
      return `<section class="panel">
        <div class="panel-head"><div><p class="eyebrow">${esc(m.source === 'default' ? 'Neutral default menu' : m.source === 'generated' ? 'Generated from your sources' : 'Edited by hand')}</p><h3>WhatsApp menu</h3></div></div>
        <p class="muted">Customers choose these entries by number. Each information page's text lives in the <a href="#/replies">Manual Reply Editor</a> (look for the "Business Menu" category). After you change the structure, save it and update the menu text so the numbers shown to customers match.</p>
        <div id="menu-host">${menuEditorHtml(S.menuDraft, 'menu')}</div>
        <div class="actions"><button class="btn primary" id="menu-save" type="button">Save menu</button><button class="btn" id="menu-sync" type="button">Update menu text in replies</button><button class="btn ghost" id="menu-reset" type="button">Reset to neutral default</button><span id="menu-status" class="muted" role="status" aria-live="polite"></span></div>
        <details class="draft-section"><summary><span>Preview of the main menu text</span></summary><div class="draft-body"><div class="field"><label>English</label><pre class="preview" id="menu-preview-en"></pre></div><div class="field"><label>Arabic</label><pre class="preview" dir="rtl" id="menu-preview-ar"></pre></div></div></details>
      </section>`;
    }

    function previewMenuText(config, lang) {
      const caps = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
      const lines = config.items.map((it, i) => `${caps[i + 1] || i + 1} ${lang === 'ar' ? it.labelAr : it.labelEn}`).join('\n');
      return lang === 'ar' ? `أهلاً بك في ${S.data.account.nameAr || S.data.account.name}\n\nكيف يمكننا خدمتك اليوم؟\n\n${lines}\n\nأرسل رقم الخيار.` : `Welcome to ${S.data.account.name}\n\nHow can we help you today?\n\n${lines}\n\nPlease reply with the option number.`;
    }

    function bindMenu() {
      const host = view.querySelector('#menu-host');
      if (!host) return;
      const refreshPreview = () => { view.querySelector('#menu-preview-en').textContent = previewMenuText(S.menuDraft, 'en'); view.querySelector('#menu-preview-ar').textContent = previewMenuText(S.menuDraft, 'ar'); };
      const rerender = () => { host.innerHTML = menuEditorHtml(S.menuDraft, 'menu'); refreshPreview(); };
      bindMenuEditor(host, () => S.menuDraft, (m) => { S.menuDraft = m; }, rerender, 'menu');
      host.addEventListener('input', refreshPreview);
      refreshPreview();
      const status = view.querySelector('#menu-status');
      view.querySelector('#menu-save').addEventListener('click', async () => {
        try { await api(`${base}/menu`, json('PUT', S.menuDraft)); await load(); S.menuDraft = null; toast('Menu saved. Click "Update menu text in replies" so customers see the new numbers.', 'success'); await draw(); } catch (error) { toast(errText(error), 'error'); }
      });
      view.querySelector('#menu-sync').addEventListener('click', async () => {
        status.textContent = 'Updating…';
        try { await api(`${base}/menu/sync-text`, { method: 'POST' }); status.textContent = ''; toast('The main-menu reply now matches the saved menu.', 'success'); } catch (error) { status.textContent = ''; toast(errText(error), 'error'); }
      });
      view.querySelector('#menu-reset').addEventListener('click', async () => {
        if (!window.confirm('Reset to the neutral default menu? Your menu structure is replaced; pages you edited in the Manual Reply Editor keep their text.')) return;
        try { await api(`${base}/menu`, { method: 'DELETE' }); await load(); S.menuDraft = null; toast('Menu reset.', 'success'); await draw(); } catch (error) { toast(errText(error), 'error'); }
      });
    }

    // ============================================================== Manage (disable / delete)
    function managePanel() {
      const a = acc();
      const legacy = S.data.account.isLegacy;
      // Disabling, enabling and deleting a business need connection access; others see an explanation instead of dead buttons.
      if (!hasCap('connection')) {
        return '<section class="panel"><div class="panel-head"><div><p class="eyebrow">Connection</p><h3>Managed by an administrator</h3></div></div><p class="muted">Enabling, disabling or deleting this business, and pairing its WhatsApp number, are limited to the Super Admin and administrators who were given connection access.</p></section>';
      }
      return `<section class="panel">
        <div class="panel-head"><div><p class="eyebrow">Connection</p><h3>Disable or enable</h3></div></div>
        <p class="muted"><b>Disable</b> closes this business's WhatsApp connection and stops automatic replies, but keeps all its data and its saved WhatsApp session. Enable it again at any time — no new QR scan is needed.</p>
        <div class="actions">${a && a.enabled ? '<button class="btn danger" id="toggle-btn" data-to="disable" type="button">Disable account</button>' : '<button class="btn primary" id="toggle-btn" data-to="enable" type="button">Enable account</button>'}<a class="btn" href="#/whatsapp">Open WhatsApp connection</a></div>
      </section>
      <section class="panel danger-zone">
        <div class="panel-head"><div><p class="eyebrow">Danger zone</p><h3>Delete this business</h3></div></div>
        ${legacy ? `<p><b>This is the original business account and it is protected.</b> It cannot be deleted from the dashboard. You can edit it, disable it, or disconnect its WhatsApp number from the connection page.</p>`
          : `<p class="muted"><b>Delete</b> permanently removes this business and everything that belongs to it: customers, conversations, messages, requests, appointments, templates, business settings, automation, knowledge, offers, generated content, uploaded PDFs and images, and its WhatsApp session. Other businesses and shared data are not touched. This cannot be undone.</p>
        <div class="actions"><button class="btn danger" id="delete-btn" type="button">Delete this business…</button></div>`}
      </section>`;
    }

    function bindManage() {
      view.querySelector('#toggle-btn')?.addEventListener('click', async (e) => {
        const to = e.currentTarget.dataset.to;
        if (to === 'disable' && !window.confirm('Disable this account? Its WhatsApp connection closes and customers get no automatic replies until it is enabled again. Data and the saved session are kept.')) return;
        try { await api(`/api/dashboard/accounts/${id}/${to}`, { method: 'POST' }); await loadAccounts(); toast(to === 'enable' ? 'Account enabled — resuming its saved session.' : 'Account disabled. Data kept.', 'success'); await draw(); } catch (error) { toast(errText(error), 'error'); }
      });
      view.querySelector('#delete-btn')?.addEventListener('click', async () => {
        let preview;
        try { preview = await api(`/api/dashboard/accounts/${id}/delete-preview`); } catch (error) { toast(errText(error), 'error'); return; }
        const c = preview.counts;
        const ok = await confirmTyped({
          title: `Delete “${preview.name}”?`,
          bodyHtml: `<p>This permanently removes:</p><ul class="delete-list"><li>${c.customers} customer(s), ${c.conversations} conversation(s), ${c.messages} message(s)</li><li>${c.requests} request(s) / appointment(s)</li><li>${c.documents} uploaded file(s) (PDFs and images)</li><li>${c.offers} offer(s), ${c.templates} reply template(s), ${c.links} link(s)</li><li>its business settings, automation, knowledge files, generated content and WhatsApp session</li></ul><p>Other businesses are not affected. <b>This cannot be undone.</b></p>`,
          word: 'DELETE', confirmLabel: 'Delete permanently', danger: true,
        });
        if (!ok) return;
        try {
          const res = await api(`/api/dashboard/accounts/${id}`, json('DELETE', { confirm: 'DELETE' }));
          toast(`“${res.report.name}” was deleted.`, 'success');
          selectAccount(1, { silent: true });
          await loadAccounts();
          location.hash = '#/accounts';
        } catch (error) { toast(errText(error), 'error'); }
      });
    }

    await load();
    S.menuDraft = null;
    await draw();
  });
})();
