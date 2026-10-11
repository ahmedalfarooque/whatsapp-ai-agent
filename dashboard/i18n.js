// Interface language (English / العربية): ONE shared mechanism for the whole dashboard.
//
// How it works: the pages are written in English. A single dictionary (i18n-ar.js, source string -> Arabic) is applied to the text
// the pages render — text nodes and the placeholder / title / aria-label attributes — when Arabic is selected, and again whenever the
// page adds or changes content (MutationObserver). Switching back to English restores the original text. Because it works on what is
// rendered, it covers navigation, tables, dialogs, toasts and every page added later, and nothing is duplicated as "if (ar) ..." in code.
//
// Never translated: user-entered content and technical values. Mark such an element translate="no" (customer names, notes, messages,
// references, phone numbers are already inside such elements or are not in the dictionary). Strings the dictionary does not know stay
// as written — a missing translation degrades to English, never to a wrong word.
//
// The choice is remembered in this browser (localStorage) and applies to the interface only: it changes no account, user, customer or
// business setting and has no server side.
(function () {
  'use strict';
  var KEY = 'workspace.lang';
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, SVG: 1 };
  var originals = new WeakMap(); // text node -> English text, element -> { attr: English value }
  var lang = 'en';
  try { var saved = localStorage.getItem(KEY); if (saved === 'ar' || saved === 'en') lang = saved; } catch (e) { /* storage unavailable */ }

  var normalized = null; var normalizedFrom = 0;
  function dict() {
    var raw = window.I18N_AR || {};
    var size = Object.keys(raw).length;
    if (!normalized || normalizedFrom !== size) {
      normalized = {};
      Object.keys(raw).forEach(function (k) { var nk = k.replace(/\s+/g, ' ').trim(); if (!(nk in normalized)) normalized[nk] = raw[k]; });
      normalizedFrom = size;
    }
    return normalized;
  }
  function patterns() { return window.I18N_AR_PATTERNS || []; }

  /** Arabic for an English UI string, or null when there is none (the original is then left as is). */
  function lookup(text) {
    var key = text.replace(/\s+/g, ' ').trim();
    if (!key) return null;
    var d = dict();
    if (Object.prototype.hasOwnProperty.call(d, key)) return d[key];
    var p = patterns();
    for (var i = 0; i < p.length; i += 1) {
      var m = p[i][0].exec(key);
      if (m) { var r = p[i][1].apply(null, m.slice(1)); if (r !== null && r !== undefined) return r; }
    }
    // "A · B · C" lines (breadcrumbs, meta lines): translate each part we know and keep the rest (references, names, dates) as they are.
    if (key.indexOf(' · ') > 0 && !inSegments) {
      inSegments = true;
      try {
        var parts = key.split(' · ');
        var changed = false;
        var out = parts.map(function (part) { var ar = lookup(part); if (ar !== null) { changed = true; return ar; } return part; });
        if (changed) return out.join(' · ');
      } finally { inSegments = false; }
    }
    return null;
  }
  var inSegments = false;

  /** t('Saved.') — for the few places that build a message in code. Returns the Arabic when Arabic is selected. */
  function t(text, vars) {
    var out = lang === 'ar' ? (lookup(text) || text) : text;
    if (vars) Object.keys(vars).forEach(function (k) { out = out.split('{' + k + '}').join(String(vars[k])); });
    return out;
  }

  function skipSelf(n) {
    if (SKIP_TAGS[(n.tagName || '').toUpperCase()] || n.getAttribute('translate') === 'no' || n.hasAttribute('data-i18n-skip')) return true;
    // references, ids and paths are technical values; message bodies, notes and previews are what customers/staff wrote
    var c = n.classList;
    return !!(c && (c.contains('file') || c.contains('bubble-text') || c.contains('wa-msg') || c.contains('cu-notes')));
  }
  function skipped(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
      if (skipSelf(n)) return true;
    }
    return false;
  }

  function translateText(node) {
    var current = node.nodeValue;
    if (!current || !current.trim()) return;
    if (skipped(node.parentNode)) return;
    var known = originals.get(node);
    if (known !== undefined) { var done = lookup(known); if (done !== null && current.trim() === done) return; } // already our translation
    var source = current.replace(/\s+/g, ' ').trim();
    var ar = lookup(source);
    if (ar === null) return;
    originals.set(node, source);
    var lead = /^\s*/.exec(current)[0];
    var trail = /\s*$/.exec(current)[0];
    node.nodeValue = lead + ar + trail;
  }

  function translateAttrs(el) {
    if (skipped(el)) return;
    ATTRS.forEach(function (attr) {
      if (!el.hasAttribute(attr)) return;
      var cur = el.getAttribute(attr);
      var rec = originals.get(el) || {};
      if (rec[attr] !== undefined && lookup(rec[attr]) === cur) return; // already our translation
      var ar = lookup(cur);
      if (ar === null) return;
      rec[attr] = cur;
      originals.set(el, rec);
      el.setAttribute(attr, ar);
    });
  }
  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (skipped(root)) return; translateAttrs(root); }
    var walker = document.createTreeWalker(root, 1 | 4, {
      acceptNode: function (n) {
        if (n.nodeType === 1) return skipSelf(n) ? 2 : 1;
        return 1;
      },
    });
    var n = walker.nextNode();
    while (n) {
      if (n.nodeType === 3) translateText(n); else translateAttrs(n);
      n = walker.nextNode();
    }
  }

  function restoreTree(root) {
    var walker = document.createTreeWalker(root, 1 | 4, null);
    var n = walker.nextNode();
    while (n) {
      var rec = originals.get(n);
      if (n.nodeType === 3 && typeof rec === 'string') { var lead = /^\s*/.exec(n.nodeValue)[0]; var trail = /\s*$/.exec(n.nodeValue)[0]; n.nodeValue = lead + rec + trail; originals.delete(n); }
      else if (n.nodeType === 1 && rec && typeof rec === 'object') { Object.keys(rec).forEach(function (a) { n.setAttribute(a, rec[a]); }); originals.delete(n); }
      n = walker.nextNode();
    }
  }

  var observer = null;
  function observe() {
    if (observer || !window.MutationObserver) return;
    observer = new MutationObserver(function (muts) {
      if (lang !== 'ar') return;
      muts.forEach(function (m) {
        if (m.type === 'childList') m.addedNodes.forEach(translateTree);
        else if (m.type === 'characterData') translateText(m.target);
        else if (m.type === 'attributes') translateAttrs(m.target);
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function applyDocument() {
    var root = document.documentElement;
    root.setAttribute('lang', lang);
    root.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    root.setAttribute('data-lang', lang);
    var title = document.querySelector('title');
    if (lang === 'ar') { translateTree(document.body); if (title) translateText(title.firstChild); } else { restoreTree(document.documentElement); }
    document.querySelectorAll('.lang-switch [data-lang]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang)); });
  }

  function setLang(next) {
    if (next !== 'ar' && next !== 'en') return;
    lang = next;
    try { localStorage.setItem(KEY, next); } catch (e) { /* the choice just is not remembered */ }
    applyDocument();
    document.dispatchEvent(new CustomEvent('workspace:lang', { detail: { lang: next } }));
  }

  /** English / العربية: two buttons. The labels are fixed (never translated) so each language is always findable. */
  function switchHtml() {
    return '<div class="lang-switch" role="group" aria-label="Language" translate="no">' +
      '<button type="button" data-lang="en" lang="en" aria-pressed="' + (lang === 'en') + '">English</button>' +
      '<button type="button" data-lang="ar" lang="ar" aria-pressed="' + (lang === 'ar') + '">العربية</button></div>';
  }
  function mountSwitches() {
    document.querySelectorAll('[data-lang-switch]').forEach(function (slot) {
      if (slot.querySelector('.lang-switch')) return;
      slot.insertAdjacentHTML('beforeend', switchHtml());
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.lang-switch [data-lang]');
    if (b) setLang(b.getAttribute('data-lang'));
  });

  // Dates and numbers: Gregorian calendar and Western digits in Arabic (matching quotations, references and phone numbers).
  var LOCALE = { ar: 'ar-u-ca-gregory-nu-latn', en: undefined };
  ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach(function (name) {
    var original = Date.prototype[name];
    Date.prototype[name] = function (locales, options) {
      var noLocale = locales === undefined || (Array.isArray(locales) && locales.length === 0);
      return original.call(this, noLocale && lang === 'ar' ? LOCALE.ar : locales, options);
    };
  });
  var numberOriginal = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (locales, options) {
    var noLocale = locales === undefined || (Array.isArray(locales) && locales.length === 0);
    return numberOriginal.call(this, noLocale && lang === 'ar' ? 'ar-u-nu-latn' : locales, options);
  };

  window.I18N = { get lang() { return lang; }, get dir() { return lang === 'ar' ? 'rtl' : 'ltr'; }, t: t, setLang: setLang, translate: translateTree, lookup: lookup, mountSwitches: mountSwitches };
  window.t = t;

  function start() {
    mountSwitches();
    observe();
    applyDocument();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
