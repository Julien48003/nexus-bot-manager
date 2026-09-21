'use strict';
/**
 * Nexus Bot Manager — Diagnostics
 *
 * Detect common Discord.js / PM2 errors in bot logs and produce a
 * friendly, non-secret-leaking explanation. Complements raw logs.
 * NEVER echoes tokens or other secrets.
 */
(function () {
  const RULES = [
    {
      id: 'token-invalid',
      test: /TokenInvalid|invalid token was provided/i,
      title: () => window.NexusI18n ? NexusI18n.t('errors.tokenInvalid') : 'Invalid Discord token',
      explain: () => window.NexusI18n ? NexusI18n.t('errors.tokenInvalidHint') : 'Token is invalid.'
    },
    {
      id: 'disallowed-intents',
      test: /disallowed intents|Used disallowed intents|Missing Permissions|PrivilegedIntentsRequired/i,
      title: () => window.NexusI18n ? NexusI18n.t('errors.disallowedIntents') : 'Disallowed intents',
      explain: () => window.NexusI18n ? NexusI18n.t('errors.disallowedIntentsHint') : 'Intents not enabled.'
    },
    {
      id: 'cannot-find-module',
      test: /Cannot find module ['"`]?([^\s'"`]+)['"`]?/,
      title: () => window.NexusI18n ? NexusI18n.t('errors.missingModule') : 'Missing dependency',
      explain: () => window.NexusI18n ? NexusI18n.t('errors.missingModuleHint') : 'A Node.js package is missing.'
    },
    {
      id: 'missing-env',
      test: /\[FATAL\] La variable TOKEN est manquante|TOKEN manquant|process\.env\.TOKEN/i,
      title: () => window.NexusI18n ? NexusI18n.t('errors.missingEnv') : 'Missing env var',
      explain: () => window.NexusI18n ? NexusI18n.t('errors.missingEnvHint') : 'Required env var missing.'
    },
    {
      id: 'eaddrinuse',
      test: /EADDRINUSE|address already in use/i,
      title: () => window.NexusI18n ? NexusI18n.t('errors.eaddrinuse') : 'Port in use',
      explain: () => window.NexusI18n ? NexusI18n.t('errors.eaddrinuseHint') : 'Port busy.'
    },
    {
      id: 'econnrefused',
      test: /ECONNREFUSED|ENOTFOUND|getaddrinfo/i,
      title: () => window.NexusI18n ? NexusI18n.t('errors.econnrefused') : 'Connection refused',
      explain: () => window.NexusI18n ? NexusI18n.t('errors.econnrefusedHint') : 'External service unreachable.'
    },
    {
      id: 'permission',
      test: /Missing Permissions|MISSING_PERMISSIONS/i,
      title: () => 'Permissions insuffisantes',
      explain: () => 'Le bot Discord n\'a pas les permissions nécessaires pour cette action. Vérifiez les permissions du rôle du bot sur Discord.'
    }
  ];

  function sanitize(line) {
    if (typeof line !== 'string') return '';
    return String(line)
      .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]')
      .replace(/[M][A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]')
      .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer [REDACTED]')
      .replace(/[A-Za-z0-9_-]{50,}/g, '[REDACTED]');
  }

  function analyze(logs) {
    const seen = new Set();
    const out = [];
    if (!Array.isArray(logs)) return out;
    for (const raw of logs) {
      const safe = sanitize(raw);
      for (const r of RULES) {
        if (seen.has(r.id)) continue;
        if (r.test.test(safe)) {
          seen.add(r.id);
          out.push({ id: r.id, title: r.title(), explain: r.explain() });
          if (out.length >= 4) return out;
        }
      }
    }
    return out;
  }

  function renderHTML(logs) {
    const items = analyze(logs);
    if (!items.length) return '';
    const panelTitle = window.NexusI18n ? NexusI18n.t('diagnostics.title') : 'Nexus diagnostic';
    return `
      <div class="diag-panel">
        <div class="diag-header"><i class="ti ti-shield-check"></i> ${escapeHtml(panelTitle)}</div>
        ${items.map(it => `
          <div class="diag-item">
            <div class="diag-title"><i class="ti ti-alert-circle"></i> ${escapeHtml(it.title)}</div>
            <div class="diag-body">${escapeHtml(it.explain)}</div>
          </div>`).join('')}
      </div>`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  window.NexusDiagnostics = { analyze, sanitize, renderHTML };
})();