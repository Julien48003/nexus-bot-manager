'use strict';
/**
 * Nexus Bot Manager — Internationalization
 *
 * Architecture:
 *   - Translations live in `frontend/public/translations/{lang}.js`
 *   - window.NexusI18n exposes: t(), setLang(), current(), apply(), register()
 *   - On boot, language is restored from localStorage ('nexus.lang')
 *   - The setup wizard sets the language before the rest of the UI loads
 *   - Supported languages: 'en' (default), 'fr', 'de'
 *
 * Fallback behaviour:
 *   - If a key is missing in the active language → English is used
 *   - If missing everywhere → returns the dotted key (visible during dev)
 *   - Never returns undefined; never returns the raw key as a silent failure
 */
(function () {
  const STORAGE_KEY = 'nexus.lang';
  const DEFAULT_LANG = 'en';
  const SUPPORTED = ['en', 'fr', 'de'];

  // Aggregated translations keyed by lang → flat key → string
  const DATA = { en: {}, fr: {}, de: {} };

  function current() {
    let lang;
    try { lang = localStorage.getItem(STORAGE_KEY); } catch (_) {}
    return SUPPORTED.includes(lang) ? lang : DEFAULT_LANG;
  }

  /**
   * t(key, params?)
   *  - key: dot-path like "settings.appearance.title"
   *  - params: {name: 'value'} for {name} interpolation
   */
  function t(key, params) {
    if (!key) return '';
    const lang = current();
    let s = lookup(DATA[lang], key);
    if (s == null && lang !== DEFAULT_LANG) s = lookup(DATA[DEFAULT_LANG], key);
    if (s == null) return key; // visible during dev so missing keys are obvious
    if (typeof s !== 'string') return key;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
    }
    return s;
  }

  function lookup(obj, dotted) {
    if (!obj) return null;
    const parts = dotted.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[p];
    }
    return cur == null ? null : cur;
  }

  function setLang(lang, { persist = true } = {}) {
    if (!SUPPORTED.includes(lang)) lang = DEFAULT_LANG;
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
    }
    document.documentElement.setAttribute('lang', lang);
    document.dispatchEvent(new CustomEvent('nexus:langchange', { detail: { lang } }));
  }

  /**
   * Apply translations to a DOM subtree:
   *   data-i18n="key"          → textContent
   *   data-i18n-html="key"     → innerHTML
   *   data-i18n-placeholder="key" → placeholder attribute
   *   data-i18n-attr="attr:key,attr2:key2" → attribute
   */
  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const s = t(key);
      if (s != null && s !== key) el.textContent = s;
    });
    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      const key = el.getAttribute('data-i18n-html');
      const s = t(key);
      if (s != null && s !== key) el.innerHTML = s;
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const s = t(key);
      if (s != null && s !== key) el.setAttribute('placeholder', s);
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(el => {
      const spec = el.getAttribute('data-i18n-attr');
      spec.split(',').forEach(pair => {
        const [attr, key] = pair.split(':').map(s => s.trim());
        if (!attr || !key) return;
        const s = t(key);
        if (s != null && s !== key) el.setAttribute(attr, s);
      });
    });
  }

  function register(lang, dict) {
    if (!DATA[lang]) DATA[lang] = {};
    DATA[lang] = mergeDeep(DATA[lang], dict || {});
  }

  function mergeDeep(target, src) {
    const out = Object.assign({}, target);
    for (const [k, v] of Object.entries(src || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
        out[k] = mergeDeep(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // Public
  window.NexusI18n = {
    t, setLang, current, apply, register,
    SUPPORTED, DEFAULT_LANG,
    supportedNames: { en: 'English', fr: 'Français', de: 'Deutsch' },
    supportedFlags: { en: '🇬🇧', fr: '🇫🇷', de: '🇩🇪' }
  };

  document.documentElement.setAttribute('lang', current());
})();