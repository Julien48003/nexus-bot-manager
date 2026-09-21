'use strict';
/**
 * Nexus Bot Manager — Diagnostics helpers
 *
 * Detect common Discord.js / PM2 errors in bot logs and produce a friendly,
 * non-secret-leaking explanation the user can act on.
 *
 * IMPORTANT: this complements the raw logs. It NEVER masks or replaces them
 * and NEVER echoes the token or other secrets.
 */
(function () {

  // ── Patterns ────────────────────────────────────────────
  // Each rule has: a regex, an id, a title, and a builder function returning
  // an explanation string. The regex never matches a token (token-like 24+ char
  // runs are stripped from the displayed log line before matching).
  const RULES = [
    {
      id: 'token-invalid',
      test: /TokenInvalid|invalid token was provided/i,
      title: 'Token Discord invalide',
      explain: 'Le token du bot fourni dans le fichier .env est invalide, révoqué ou a été régénéré. Régénérez un nouveau token dans le portail développeur Discord (https://discord.com/developers/applications → votre bot → Reset Token) puis mettez à jour la variable TOKEN du bot.'
    },
    {
      id: 'disallowed-intents',
      test: /disallowed intents|Used disallowed intents|Missing Permissions|PrivilegedIntentsRequired/i,
      title: 'Intents Discord non autorisés',
      explain: 'Le bot utilise un ou plusieurs intents Discord qui ne sont pas activés pour cette application. Ouvrez le Portail Développeur Discord → votre application → Bot, activez les intents nécessaires (Server Members, Message Content, Presence…) puis redémarrez le bot. N\'oubliez pas d\'activer explicitement les intents privilégiés si besoin.'
    },
    {
      id: 'cannot-find-module',
      test: /Cannot find module ['"`]?([^\s'"`]+)['"`]?/,
      title: 'Dépendance manquante',
      explain: 'Une dépendance Node.js est absente du dossier du bot. Ouvrez la section npm du bot et installez le paquet manquant (ou exécutez \`npm install\` à la racine du bot).'
    },
    {
      id: 'missing-env',
      test: /\[FATAL\] La variable TOKEN est manquante|TOKEN manquant|process\.env\.TOKEN/i,
      title: 'Variable d\'environnement manquante',
      explain: 'Le bot n\'a pas trouvé la variable d\'environnement requise (souvent TOKEN). Ouvrez le fichier .env du bot et vérifiez que la ligne est bien définie et sans espace parasite.'
    },
    {
      id: 'eaddrinuse',
      test: /EADDRINUSE|address already in use/i,
      title: 'Port déjà utilisé',
      explain: 'Le port que le bot essayait d\'écouter est déjà occupé par un autre processus (autre instance du bot, autre service). Arrêtez l\'autre processus ou changez le port.'
    },
    {
      id: 'econnrefused',
      test: /ECONNREFUSED|ENOTFOUND|getaddrinfo/i,
      title: 'Connexion réseau impossible',
      explain: 'Le bot n\'a pas pu atteindre un service externe (souvent la base de données, une API HTTP ou Discord lui-même). Vérifiez la connectivité réseau du serveur et les éventuels pares-feux.'
    },
    {
      id: 'permission',
      test: /Missing Permissions|MISSING_PERMISSIONS/i,
      title: 'Permissions insuffisantes',
      explain: 'Le bot Discord n\'a pas les permissions nécessaires dans le salon ou pour l\'action demandée. Vérifiez les permissions du rôle du bot sur Discord (l\'action est affichée dans les logs).'
    },
  ];

  /**
   * Strip anything that looks like a Discord token or other secret before we
   * echo a log line back to the user. We keep the line readable but remove
   * the dangerous substrings.
   */
  function sanitize(line) {
    if (typeof line !== 'string') return '';
    // Discord bot tokens look like: 3 chunks of base64url joined by dots, total ~70 chars.
    // Also strip anything that looks like a JWT (3 base64url chunks).
    return String(line)
      .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]')
      .replace(/[M][A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]')
      .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer [REDACTED]')
      // Generic long base64-looking runs sometimes found in tokens
      .replace(/[A-Za-z0-9_-]{50,}/g, '[REDACTED]');
  }

  /**
   * Detect diagnostics for a list of log lines (typical stderr of a bot).
   * Returns a deduplicated list of {id, title, explain} (max 4 entries).
   */
  function analyze(logs) {
    const seen = new Set();
    const out  = [];
    if (!Array.isArray(logs)) return out;
    for (const raw of logs) {
      const safe = sanitize(raw);
      for (const r of RULES) {
        if (seen.has(r.id)) continue;
        if (r.test.test(safe)) {
          seen.add(r.id);
          out.push({ id: r.id, title: r.title, explain: r.explain });
          if (out.length >= 4) return out;
        }
      }
    }
    return out;
  }

  /**
   * Render a diagnostics panel HTML. Empty string if no diagnostics.
   */
  function renderHTML(logs) {
    const items = analyze(logs);
    if (!items.length) return '';
    return `
      <div class="diag-panel">
        <div class="diag-header"><i class="ti ti-shield-check"></i> Diagnostic Nexus</div>
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

  // Expose
  window.NexusDiagnostics = { analyze, sanitize, renderHTML };
})();