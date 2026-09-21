'use strict';
/**
 * Nexus Bot Manager — Internationalization
 *
 * Architecture:
 *   - Translations live in `frontend/public/translations/{lang}.js`
 *   - window.NexusI18n exposes the API: t(), setLang(), current(), apply()
 *   - On boot, the language is restored from localStorage ('nexus.lang').
 *   - The setup wizard sets the language before the rest of the UI loads.
 *   - Persisted languages: 'en' (default), 'fr', 'de'.
 *
 * The translation files register themselves on a shared dictionary via
 * window.NEXUS_I18N_DATA. Loading is synchronous: each translation file
 * just adds its keys to the dictionary. If a key is missing in the active
 * language, English is used as fallback.
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
    if (params) {
      s = String(s).replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? params[k] : m));
    }
    return s;
  }

  function lookup(obj, dotted) {
    if (!obj) return null;
    const parts = dotted.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return null;
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
   * Apply translations to a DOM subtree. Elements with data-i18n="key" get
   * their textContent replaced. Elements with data-i18n-attr="title:key"
   * get their attribute set. data-i18n-placeholder sets the placeholder.
   */
  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const s = t(key);
      if (s != null) el.textContent = s;
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const s = t(key);
      if (s != null) el.setAttribute('placeholder', s);
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(el => {
      const spec = el.getAttribute('data-i18n-attr'); // "attr:key,attr2:key2"
      spec.split(',').forEach(pair => {
        const [attr, key] = pair.split(':').map(s => s.trim());
        if (!attr || !key) return;
        const s = t(key);
        if (s != null) el.setAttribute(attr, s);
      });
    });
    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      const key = el.getAttribute('data-i18n-html');
      const s = t(key);
      if (s != null) el.innerHTML = s;
    });
  }

  // Register a translation dictionary for a given lang (called by the loaded file).
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

  // Set <html lang> early so screen readers and CSS hooks see it
  document.documentElement.setAttribute('lang', current());
})();