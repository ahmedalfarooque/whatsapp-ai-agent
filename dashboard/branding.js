// Whose interface is this? The server decides (GET /api/dashboard/me -> me.branding, see src/dashboard/branding.ts) from the signed-in user's
// real account assignments; this file only DRAWS that decision. It never reads the browser's storage, the URL or a company id to choose a
// company: the single input is the `branding` object the server returned for the authenticated session.
//
//   developer  Super Admin, users with several accounts, and anything unclear  -> the SYNRTECHS logo
//   company    a user with exactly one assigned account                        -> that company's name and logo
//
// Loaded after shell.js (which calls applyBranding() whenever /me is (re)loaded) and before app.js.

const DEV_NAME = 'SYNRTECHS';
// Official artwork taken as drawn from the supplied brand guide: the colour lockup for light surfaces, the white lockup for dark ones (never retyped or recoloured).
const DEV_WORDMARK = { light: '/dashboard/assets/developer/synrtechs-logo.svg', dark: '/dashboard/assets/developer/synrtechs-logo-white.svg' };

/** First letter of the name as shown (Latin or Arabic) for the neutral tile used when a company has no verified logo. */
function brandInitial(name) {
  const letter = Array.from(String(name || '').trim().replace(/^[^\p{L}\p{N}]+/u, ''))[0];
  return letter ? letter.toLocaleUpperCase() : '•';
}

/** Pure: the branding the page should show for `meObj` (the /me response) in `lang`. Anything unclear is the developer identity. */
function brandModel(meObj, lang) {
  const b = meObj && meObj.branding;
  const c = b && b.mode === 'company' ? b.company : null;
  if (!c || typeof c.name !== 'string' || !c.name.trim()) return { mode: 'developer', name: DEV_NAME, initial: 'S', logoUrl: null, accountId: null, nameEn: DEV_NAME, nameAr: null };
  const shown = lang === 'ar' && c.nameAr ? c.nameAr : c.name;
  const logo = typeof c.logoUrl === 'string' && /^\/(dashboard\/assets\/|api\/dashboard\/branding\/logo)/.test(c.logoUrl) ? c.logoUrl : null; // only our own paths
  return { mode: 'company', name: shown, initial: brandInitial(shown), logoUrl: logo, accountId: c.accountId, nameEn: c.name, nameAr: c.nameAr || null };
}

/** Lets the Arabic interface show each business under its Arabic name wherever the English name appears (sidebar, chips, titles). */
function registerAccountNames(accounts) {
  if (!window.I18N_AR || !Array.isArray(accounts)) return;
  let added = false;
  for (const a of accounts) {
    if (a && typeof a.name === 'string' && typeof a.nameAr === 'string' && a.nameAr.trim() && !Object.prototype.hasOwnProperty.call(window.I18N_AR, a.name)) { window.I18N_AR[a.name] = a.nameAr; added = true; }
  }
  if (added && window.I18N && window.I18N.lang === 'ar') window.I18N.translate(document.body);
}

function brandMarkHtml(model, cls) {
  if (model.mode === 'company' && model.logoUrl) return `<img class="${cls}" src="${esc(model.logoUrl)}" alt="" width="44" height="44" data-brand-logo>`;
  return `<span class="brand-initial ${cls === 'topbar-logo' ? 'sm' : ''}" aria-hidden="true" translate="no">${esc(model.initial)}</span>`;
}

function wordmarkHtml(cls) {
  return `<span class="wm ${cls}"><img class="wm-light" src="${DEV_WORDMARK.light}" alt="${DEV_NAME}" width="132" height="24"><img class="wm-dark" src="${DEV_WORDMARK.dark}" alt="${DEV_NAME}" width="132" height="24"></span>`;
}

/** Digits of a phone number with all but the last four hidden (the same convention the customer lists use). */
function maskAccountNumber(value) {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '');
  return digits.length > 4 ? `••••${digits.slice(-4)}` : digits;
}

/**
 * Pure: what the selected-account identity shows for one account of the server's (already access-filtered) accounts list.
 * The logo URL is only accepted when it points inside this application (the account's own logo route or the bundled artwork).
 */
function accountIdentityModel(account, lang, statusLabel) {
  if (!account || typeof account.name !== 'string' || !account.name.trim()) return null;
  const name = lang === 'ar' && account.nameAr ? account.nameAr : account.name;
  const logoUrl = typeof account.logoUrl === 'string' && /^\/(dashboard\/assets\/|api\/dashboard\/accounts\/\d+\/logo\?v=[\w-]+$|api\/dashboard\/branding\/logo\?v=[\w-]+$)/.test(account.logoUrl) ? account.logoUrl : null;
  return { accountId: account.id, name, initial: brandInitial(name), logoUrl, number: maskAccountNumber(account.phoneNumber), status: statusLabel || '', statusDot: account.uiStatus || '' };
}

/** The account's logo (or the neutral initial tile when it has none or it fails to load). Never another account's artwork. */
function accountAvatarHtml(model, cls) {
  const tile = `<span class="acct-av acct-av-initial ${cls}" aria-hidden="true" translate="no">${esc(model.initial)}</span>`;
  return model.logoUrl ? `<img class="acct-av ${cls}" src="${esc(model.logoUrl)}" alt="" width="44" height="44" data-acct-logo data-fallback="${esc(model.initial)}">` : tile;
}

function armAvatarFallback(root) {
  root.querySelectorAll('[data-acct-logo]').forEach((img) => img.addEventListener('error', () => {
    const tile = document.createElement('span');
    tile.className = `${img.className} acct-av-initial`;
    tile.setAttribute('aria-hidden', 'true');
    tile.setAttribute('translate', 'no');
    tile.textContent = img.dataset.fallback || '•';
    img.replaceWith(tile);
  }, { once: true }));
}

let appliedIdentityKey = '';

/**
 * The selected WhatsApp account's identity, drawn once for every page: the top-bar logo, the line above the page title (name, masked number,
 * connection status) and the footer/title context. The single source is the server's accounts list for the signed-in user; it runs again whenever
 * the account, its status or the language changes, so a switch never leaves a stale logo or name behind.
 */
function renderAccountIdentity() {
  const current = typeof currentAccount === 'function' ? currentAccount() : null;
  const lang = (window.I18N && window.I18N.lang) || 'en';
  const info = current && typeof accountStatusInfo === 'function' ? accountStatusInfo(current.uiStatus) : { label: '' };
  const label = typeof t === 'function' && info.label ? t(info.label) : info.label;
  // before the accounts list has loaded, a single-company user already has their company from the server's branding decision
  const early = !current && typeof me !== 'undefined' && me && me.branding && me.branding.mode === 'company' ? me.branding.company : null;
  const model = accountIdentityModel(current || early, lang, label);
  const mark = document.querySelector('.topbar-mark');
  const eyebrow = document.querySelector('#page-eyebrow');
  const key = model ? [model.accountId, model.name, model.logoUrl, model.number, model.status, model.statusDot, lang].join('|') : '';
  if (key === appliedIdentityKey) return;
  appliedIdentityKey = key;
  if (mark) {
    if (!mark.dataset.defaultHtml) mark.dataset.defaultHtml = mark.innerHTML;
    mark.classList.toggle('acct-mark', Boolean(model));
    mark.innerHTML = model ? accountAvatarHtml(model, 'topbar-av') : mark.dataset.defaultHtml;
    armAvatarFallback(mark);
  }
  if (eyebrow) {
    eyebrow.classList.toggle('acct-line', Boolean(model));
    eyebrow.innerHTML = model
      ? `<b class="acct-name" dir="auto" translate="no">${esc(model.name)}</b>${model.number ? `<span class="acct-sep" aria-hidden="true">·</span><span class="acct-num" dir="ltr" translate="no">${esc(model.number)}</span>` : ''}${model.status ? `<span class="acct-sep" aria-hidden="true">·</span><span class="acct-st"><i class="dot ${esc(model.statusDot === 'connected' ? 'green' : model.statusDot === 'connecting' || model.statusDot === 'qr_required' ? 'amber' : model.statusDot === 'disconnected' || model.statusDot === 'error' ? 'red' : '')}" aria-hidden="true"></i>${esc(model.status)}</span>` : ''}`
      : '';
  }
}

let appliedBrandKey = '';

function applyBranding() {
  if (typeof me === 'undefined' || !me) return;
  const lang = (window.I18N && window.I18N.lang) || 'en';
  const model = brandModel(me, lang);
  document.body.dataset.brand = model.mode;
  const brand = document.querySelector('#sidebar .brand');
  const key = [model.mode, model.accountId, model.name, model.logoUrl, lang].join('|');
  if (brand && key !== appliedBrandKey) {
    appliedBrandKey = key;
    if (model.mode === 'company') {
      brand.innerHTML = `${brandMarkHtml(model, 'brand-logo')}<span id="brand-name"><b dir="auto" translate="no">${esc(model.name)}</b><small>AI WORKSPACE</small></span>`;
    } else {
      brand.innerHTML = `${wordmarkHtml('brand-wm')}<span id="brand-name"><small>AI WORKSPACE</small></span>`;
    }
    // A logo that fails to load becomes the neutral tile (never a different company's logo).
    brand.querySelectorAll('[data-brand-logo]').forEach((img) => img.addEventListener('error', () => { img.outerHTML = brandMarkHtml({ ...model, logoUrl: null }, 'brand-logo'); }, { once: true }));
  }
  appliedIdentityKey = '';
  renderAccountIdentity(); // the top-bar logo and the account line above the title (selected account, or the single company before the list loads)
  if (brand) brand.removeAttribute('data-pending');
  const footerBrand = document.querySelector('#footer-brand');
  const product = typeof t === 'function' ? t('AI Workspace') : 'AI Workspace'; // in the interface language
  if (footerBrand) footerBrand.textContent = `${model.name} · ${product}`;
  const credit = document.querySelector('#dev-credit');
  if (credit) credit.hidden = model.mode !== 'company'; // the developer is credited next to a company's workspace, not next to its own
  document.title = `${model.name} · ${product}`;
}

document.addEventListener('workspace:lang', () => { appliedBrandKey = ''; appliedIdentityKey = ''; applyBranding(); });
// The accounts list (re)loaded, or the user switched account: redraw the identity from the server's list for the new selection.
document.addEventListener('workspace:accounts', () => { renderAccountIdentity(); if (typeof applyNavVisibility === 'function') applyNavVisibility(); }); // add-on pages follow the selected account
document.addEventListener('workspace:account-changed', () => { renderAccountIdentity(); if (typeof applyNavVisibility === 'function') applyNavVisibility(); });
