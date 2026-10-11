// Whose interface is this? The server decides (GET /api/dashboard/me -> me.branding, see src/dashboard/branding.ts) from the signed-in user's
// real account assignments; this file only DRAWS that decision. It never reads the browser's storage, the URL or a company id to choose a
// company: the single input is the `branding` object the server returned for the authenticated session.
//
//   developer  Super Admin, users with several accounts, and anything unclear  -> the SynrTech Studio wordmark
//   company    a user with exactly one assigned account                        -> that company's name and logo
//
// Loaded after shell.js (which calls applyBranding() whenever /me is (re)loaded) and before app.js.

const DEV_NAME = 'SynrTech Studio';
const DEV_WORDMARK = { light: '/dashboard/assets/developer/synrtech-studio-wordmark-black.svg', dark: '/dashboard/assets/developer/synrtech-studio-wordmark-white.svg' };

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
  return `<span class="wm ${cls}"><img class="wm-light" src="${DEV_WORDMARK.light}" alt="${DEV_NAME}" width="104" height="25"><img class="wm-dark" src="${DEV_WORDMARK.dark}" alt="${DEV_NAME}" width="104" height="25"></span>`;
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
    const mark = document.querySelector('.topbar-mark');
    if (mark) {
      mark.classList.toggle('has-brand', model.mode === 'company');
      if (!mark.dataset.defaultHtml) mark.dataset.defaultHtml = mark.innerHTML;
      mark.innerHTML = model.mode === 'company' ? brandMarkHtml(model, 'topbar-logo') : mark.dataset.defaultHtml;
      mark.querySelectorAll('[data-brand-logo]').forEach((img) => img.addEventListener('error', () => { img.outerHTML = brandMarkHtml({ ...model, logoUrl: null }, 'topbar-logo'); }, { once: true }));
    }
  }
  if (brand) brand.removeAttribute('data-pending');
  const footerBrand = document.querySelector('#footer-brand');
  const product = typeof t === 'function' ? t('AI Workspace') : 'AI Workspace'; // in the interface language
  if (footerBrand) footerBrand.textContent = `${model.name} · ${product}`;
  const credit = document.querySelector('#dev-credit');
  if (credit) credit.hidden = model.mode !== 'company'; // the developer is credited next to a company's workspace, not next to its own
  document.title = `${model.name} · ${product}`;
}

document.addEventListener('workspace:lang', () => { appliedBrandKey = ''; applyBranding(); });
