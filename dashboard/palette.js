// Quick search / command palette (Ctrl+K, Cmd+K or "/"): jump to any page the signed-in user may open, switch WhatsApp account, change appearance or language.
// It follows the WAI-ARIA combobox pattern (focus stays in the input; the highlighted option is announced through aria-activedescendant).
// It only ever navigates or calls the same functions the visible controls call (selectAccount, setTheme, I18N.setLang), so it grants nothing the UI does not already offer.
// Loaded after app.js. Pure ranking lives in ui-kit.js.
(function () {
  'use strict';
  const ICON = {
    page: 'M5 3h9l5 5v13H5zM14 3v5h5',
    account: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
    action: 'M13 2 3 14h9l-1 8 10-12h-9z',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  };
  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let root = null;
  let input = null;
  let list = null;
  let empty = null;
  let opener = null;
  let results = [];
  let active = 0;

  function navigationItems() {
    const out = [];
    document.querySelectorAll('#nav a[data-route]').forEach((a) => {
      if (a.hidden) return;
      const label = (a.querySelector('span') || a).textContent.trim();
      if (!label) return;
      let group = '';
      for (let el = a.previousElementSibling; el; el = el.previousElementSibling) if (el.classList.contains('nav-group')) { group = el.textContent.trim(); break; }
      out.push({ id: `nav:${a.dataset.route}`, label, hint: group, group: 'Pages', icon: ICON.page, run: () => { location.hash = a.dataset.route; } });
    });
    return out;
  }

  function accountItems() {
    if (typeof knownAccounts === 'undefined' || !Array.isArray(knownAccounts) || knownAccounts.length < 2) return [];
    return knownAccounts.map((a) => ({
      id: `acct:${a.id}`, label: a.name, hint: typeof accountStatusInfo === 'function' ? accountStatusInfo(a.uiStatus).label : '', group: 'WhatsApp accounts', icon: ICON.account,
      keywords: ['account', 'business', 'switch', a.phoneNumber || ''], run: () => { if (typeof selectAccount === 'function') selectAccount(a.id); },
    }));
  }

  function actionItems() {
    const dark = typeof currentTheme === 'function' && currentTheme() === 'dark';
    const lang = (window.I18N && window.I18N.lang) || 'en';
    const items = [
      { id: 'act:theme', label: dark ? 'Switch to light appearance' : 'Switch to dark appearance', group: 'Actions', icon: ICON.action, keywords: ['theme', 'dark', 'light', 'night', 'mode'], run: () => setTheme(dark ? 'light' : 'dark') },
    ];
    if (window.I18N) items.push({ id: 'act:lang', label: lang === 'ar' ? 'Switch to English' : 'Switch to Arabic', group: 'Actions', icon: ICON.action, keywords: ['language', 'arabic', 'english', 'rtl', 'عربي'], run: () => window.I18N.setLang(lang === 'ar' ? 'en' : 'ar') });
    return items;
  }

  const t = (s) => (window.I18N && window.I18N.t ? window.I18N.t(s) : s);

  function render() {
    const all = [...navigationItems(), ...accountItems(), ...actionItems()];
    results = window.UiKit.rankCommands(all, input.value);
    active = Math.min(active, Math.max(0, results.length - 1));
    let html = '';
    let lastGroup = '';
    results.forEach((r, i) => {
      if (r.group !== lastGroup) { html += `<li role="presentation" class="palette-group">${esc(t(r.group))}</li>`; lastGroup = r.group; }
      html += `<li role="option" id="pal-${i}" class="palette-item" data-i="${i}" aria-selected="${i === active}">${svg(r.icon)}<span class="palette-label" dir="auto">${esc(t(r.label))}</span>${r.hint ? `<span class="palette-hint" dir="auto">${esc(t(r.hint))}</span>` : ''}</li>`;
    });
    list.innerHTML = html;
    empty.hidden = results.length > 0;
    empty.textContent = input.value ? `${t('No results for')} “${input.value}”` : '';
    input.setAttribute('aria-activedescendant', results.length ? `pal-${active}` : '');
    const el = list.querySelector('[aria-selected="true"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    if (!results.length) return;
    active = (active + delta + results.length) % results.length;
    render();
  }

  function choose(i) {
    const item = results[i];
    if (!item) return;
    close(false);
    item.run();
  }

  function build() {
    root = document.createElement('div');
    root.id = 'palette';
    root.className = 'palette';
    root.hidden = true;
    root.innerHTML = `<div class="palette-scrim" data-close></div>
      <div class="palette-box" role="dialog" aria-modal="true" aria-label="Quick search">
        <div class="palette-field">${svg(ICON.search)}
          <input id="palette-input" type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-activedescendant="" placeholder="Search pages, accounts and actions…" autocomplete="off" spellcheck="false">
          <kbd>Esc</kbd></div>
        <ul id="palette-list" role="listbox" aria-label="Results"></ul>
        <p class="palette-empty" id="palette-empty" hidden></p>
        <p class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> select</span><span><kbd>Esc</kbd> close</span></p>
      </div>`;
    document.body.appendChild(root);
    input = root.querySelector('#palette-input');
    list = root.querySelector('#palette-list');
    empty = root.querySelector('#palette-empty');
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { close(true); return; }
      const li = e.target.closest('[data-i]');
      if (li) choose(Number(li.dataset.i));
    });
    list.addEventListener('mousemove', (e) => {
      const li = e.target.closest('[data-i]');
      if (li && Number(li.dataset.i) !== active) { active = Number(li.dataset.i); list.querySelectorAll('[aria-selected]').forEach((o) => o.setAttribute('aria-selected', String(Number(o.dataset.i) === active))); input.setAttribute('aria-activedescendant', `pal-${active}`); }
    });
    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') { e.preventDefault(); if (input.value) { input.value = ''; active = 0; render(); } else close(true); }
      else if (e.key === 'Tab') { e.preventDefault(); } // the dialog keeps focus until it is closed
    });
  }

  function open() {
    if (!root) build();
    if (!root.hidden) return;
    opener = document.activeElement;
    root.hidden = false;
    document.body.classList.add('palette-open');
    input.value = '';
    active = 0;
    render();
    input.focus();
  }

  function close(restoreFocus) {
    if (!root || root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('palette-open');
    if (restoreFocus && opener && opener.focus) opener.focus();
  }

  const typing = (el) => el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k' && typeof me !== 'undefined' && me) { e.preventDefault(); root && !root.hidden ? close(true) : open(); return; }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(document.activeElement) && typeof me !== 'undefined' && me) { e.preventDefault(); open(); }
  });
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('[data-open-palette]')) open(); });
  window.WorkspacePalette = { open, close };
})();
