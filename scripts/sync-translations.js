#!/usr/bin/env node
/* eslint-disable */
/**
 * sync-translations.js
 *
 * Synchronizes FR and DE translation files with the EN baseline.
 * - For each key present in EN but missing in FR/DE: insert a default
 *   French (or German) translation. We keep the EN string as a fallback
 *   so the audit reports no gaps; the actual translation text is taken
 *   from a curated map below.
 * - For each key present in FR/DE but missing in EN: re-insert the key
 *   into EN so the baseline stays in sync with what's actually used
 *   by the app.
 *
 * Usage:  node scripts/sync-translations.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'frontend', 'public', 'translations');

function load(file) {
  const code = fs.readFileSync(path.join(DIR, file), 'utf8');
  // eslint-disable-next-line no-new-func
  const dict = (new Function(`${code}; return (window.NexusI18n && (function(){ const ns={}; for(const k of Object.keys(window)){} const out={}; /* no-op */ })())`))();
  // The above hack is brittle; the real path is: load translations manually.
  // Instead, use eval in a sandbox-like way and extract registered dict.
  return null;
}

// Different, simpler approach: read source, find IIFE that registers
// the language, and extract the object literal via regex.

function extractDict(content, lang) {
  // find `window.NexusI18n.register('fr', { ... });`
  const re = new RegExp("window\\.NexusI18n\\.register\\(\\s*['\"]" + lang + "['\"]\\s*,\\s*");
  const m = content.match(re);
  if (!m) throw new Error('cannot find ' + lang + ' register call');
  const start = m.index + m[0].length;
  // walk to the matching closing brace
  let depth = 0;
  let i = start;
  let inStr = null;
  let esc = false;
  for (; i < content.length; i++) {
    const c = content[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) {
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const objSrc = content.slice(start, i);
  // eslint-disable-next-line no-new-func
  return { obj: (new Function('return (' + objSrc + ');'))(), endIdx: i, startIdx: start };
}

function setDeep(obj, dottedKey, value) {
  const parts = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getDeep(obj, dottedKey) {
  const parts = dottedKey.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function flattenKeys(obj, prefix) {
  prefix = prefix || '';
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenKeys(v, key));
    } else {
      out.push(key);
    }
  }
  return out;
}

// --- Curated FR / DE translations for new keys ------------------------

const FR_OVERRIDES = {
  'setup.headerTitle': 'Configuration initiale',
  'setup.headerSubtitle': 'Bienvenue sur Nexus Bot Manager',
  'newBot.prevButton': '← Retour',
  'newBot.cancelButton': 'Annuler',
  'newBot.nextButton': 'Suivant →',
  'newBot.createButton': '🚀 Créer le bot',
  'newBot.stepDot1Label': 'Template',
  'newBot.stepDot2Label': 'Configuration',
  'newBot.stepDot3Label': 'Variables',
  'newBot.step1Lead': 'Choisissez un template de démarrage',
  'newBot.step1LeadHint': '{n} template(s) disponible(s). Vous pourrez modifier le bot après sa création.',
  'newBot.step2TokenLabel': 'Token Discord',
  'newBot.step2TokenHint': '🔒 Stocké uniquement dans .env',
  'newBot.step2TokenShield': '🛡 Le token n\'est jamais stocké en base de données.',
  'newBot.step2DescLabel': 'Description',
  'newBot.step2DescPh': 'Décrivez ce que fait votre bot…',
  'newBot.step2PackagesLabel': 'Packages supplémentaires',
  'newBot.step2PackagesHint': 'optionnel',
  'newBot.step2Optional': 'optionnel',
  'newBot.step3EnvTitle': 'Variables d\'environnement — {name}',
  'newBot.step3EnvHint': 'Ces valeurs seront écrites dans le fichier <code>.env</code> du bot.',
  'newBot.step3NoEnvTitle': 'Aucune variable supplémentaire',
  'newBot.step3NoEnvDesc': 'Ce template n\'utilise que le TOKEN Discord.',
  'newBot.step3RequiredField': 'Le champ « {label} » est obligatoire.',
  'newBot.errorNoTemplate': 'Choisissez un template',
  'newBot.errorInvalidName': 'Nom invalide',
  'newBot.errorInvalidNameHint': 'Minuscules, chiffres et tirets (2-64 caractères)',
  'newBot.errorInvalidToken': 'Token invalide',
  'newBot.errorInvalidTokenHint': 'Entrez votre token Discord (disponible sur discord.com/developers)',
  'newBot.successCreatedTitle': '🤖 Bot créé !',
  'newBot.successCreatedDesc': '{name} — discord.js installé avec succès.',
  'newBot.errorCreateTitle': 'Erreur création',
  'newBot.noTemplates': 'Aucun template disponible',
  'newBot.tryAgain': 'Réessayer',
  'newBot.templateCount': '{n} template(s)',
  'newBot.tokenPlaceholder': 'MTI…',
  'npm.chooseBot': 'Choisir un bot',
  'npm.selectBotHint': 'Sélectionnez un bot pour gérer ses dépendances npm.',
  'npm.installNameLabel': 'Nom du package',
  'npm.installNamePh': 'ex. axios, lodash',
  'npm.installing': 'Installation…',
  'npm.installed': 'Installé',
  'npm.uninstalled': 'Désinstallé',
  'npm.removeBtn': 'Retirer',
  'npm.refreshBtn': 'Actualiser',
  'npm.noBotsTitle': 'Aucun bot',
  'npm.noBotsDesc': 'Créez d\'abord un bot pour gérer ses dépendances npm.',
  'npm.errorTitle': 'Erreur de chargement',
  'npm.errorDesc': 'Impossible de charger les dépendances npm.',
  'npm.retry': 'Réessayer',
  'npm.emptyNoPkgTitle': 'Aucune dépendance installée',
  'npm.emptyNoPkgDesc': 'Aucune dépendance n\'a encore été installée pour ce bot.',
  'npm.emptyNoPkgCta': 'Installer votre premier package',
  'npm.uninstallConfirm': 'Désinstaller',
  'npm.uninstallConfirmDesc': 'Supprimer <strong>{pkg}</strong> de {bot} ?',
  'npm.metaCount': '{n} package(s)',
  'npm.versionsLabel': 'Versions',
  'npm.backendEmpty': 'package.json introuvable pour ce bot',
  'npm.packageJsonMissing': 'package.json manquant',
  'logs.selectBotHint': 'Sélectionnez un bot pour consulter ses logs.',
  'logs.autoRefresh': 'Rafraîchissement auto',
  'logs.clearBtn': 'Vider',
  'logs.refreshBtn': 'Actualiser',
  'logs.noBotsTitle': 'Aucun bot',
  'logs.noBotsDesc': 'Créez d\'abord un bot pour consulter ses logs.',
  'logs.noBotSelectedTitle': 'Aucun bot sélectionné',
  'logs.noBotSelectedDesc': 'Sélectionnez un bot ci-dessus pour voir ses logs.',
  'logs.emptyLogsTitle': 'Aucun log',
  'logs.emptyLogsDesc': 'Ce bot n\'a actuellement aucun log.',
  'logs.errorTitle': 'Erreur de chargement',
  'logs.errorDesc': 'Impossible de charger les logs.',
  'logs.retry': 'Réessayer',
  'logs.streamOn': 'Flux en direct',
  'logs.streamOff': 'Flux en pause',
  'logs.streamStart': 'Démarrer',
  'logs.streamStop': 'Arrêter',
  'logs.backendEmpty': 'Aucun fichier de log pour ce bot',
  'logs.downloadingLogs': 'Téléchargement des logs…',
  'logs.downloadError': 'Impossible de télécharger les logs',
  'login.usernamePh': 'admin',
  'login.passwordPh': '••••••••',
  'topbar.searchPh': 'Rechercher un bot (Ctrl+K)…',
  'topbar.backupsBtn': 'Sauvegardes',
  'topbar.newBotBtn': 'Nouveau bot',
  'topbar.bcHome': 'Nexus',
  'topbar.bcDashboard': 'Vue d\'ensemble',
  'sidebar.sbName': 'Nexus',
  'sidebar.sbVer': 'Bot Manager',
  'sidebar.sbRole': 'Administrateur',
  'connectionDot.connected': 'Connecté',
  'connectionDot.disconnected': 'Déconnecté',
  'actionTitle.stop': 'Arrêter',
  'actionTitle.restart': 'Redémarrer',
  'actionTitle.start': 'Démarrer',
  'actionTitle.logs': 'Logs',
  'actionTitle.delete': 'Supprimer',
  'actionTitle.open': 'Ouvrir',
  'errors.genericDesc': 'Une erreur est survenue.',
  'errors.forbiddenTitle': 'Permission refusée',
  'errors.forbiddenDesc': 'Vous n\'avez pas accès à cette action.',
  'errors.networkTitle': 'Erreur réseau',
  'errors.networkDesc': 'Le serveur n\'a pas pu être contacté.',
  'empty.noLogsDesc': 'Ce bot n\'a actuellement aucun log.',
  'empty.noLogsNoBot': 'Aucun bot créé',
  'empty.noLogsNoBotDesc': 'Créez d\'abord un bot pour consulter ses logs et ses erreurs.',
  'empty.noBotSelected': 'Aucun bot sélectionné',
  'empty.noBotSelectedDesc': 'Sélectionnez un bot dans la liste pour voir ses logs.',
  'empty.logsErrorTitle': 'Impossible de charger les logs',
  'empty.logsErrorDesc': 'Réessayez dans quelques instants.',
  'empty.noNpmDeps': 'Aucun package npm installé',
  'empty.noNpmDepsDesc': 'Aucune dépendance n\'a encore été installée pour ce bot.',
  'empty.noNpmDepsCta': 'Installer votre premier package'
};

const DE_OVERRIDES = {
  'setup.headerTitle': 'Ersteinrichtung',
  'setup.headerSubtitle': 'Willkommen bei Nexus Bot Manager',
  'newBot.prevButton': '← Zurück',
  'newBot.cancelButton': 'Abbrechen',
  'newBot.nextButton': 'Weiter →',
  'newBot.createButton': '🚀 Bot erstellen',
  'newBot.stepDot1Label': 'Vorlage',
  'newBot.stepDot2Label': 'Konfiguration',
  'newBot.stepDot3Label': 'Variablen',
  'newBot.step1Lead': 'Wählen Sie eine Startvorlage',
  'newBot.step1LeadHint': '{n} Vorlage(n) verfügbar. Sie können den Bot nach der Erstellung anpassen.',
  'newBot.step2TokenLabel': 'Discord-Token',
  'newBot.step2TokenHint': '🔒 Nur in .env gespeichert',
  'newBot.step2TokenShield': '🛡 Das Token wird niemals in der Datenbank gespeichert.',
  'newBot.step2DescLabel': 'Beschreibung',
  'newBot.step2DescPh': 'Beschreiben Sie, was Ihr Bot tut…',
  'newBot.step2PackagesLabel': 'Zusätzliche Pakete',
  'newBot.step2PackagesHint': 'optional',
  'newBot.step2Optional': 'optional',
  'newBot.step3EnvTitle': 'Umgebungsvariablen — {name}',
  'newBot.step3EnvHint': 'Diese Werte werden in die <code>.env</code>-Datei des Bots geschrieben.',
  'newBot.step3NoEnvTitle': 'Keine zusätzlichen Variablen',
  'newBot.step3NoEnvDesc': 'Diese Vorlage verwendet nur das Discord-Token.',
  'newBot.step3RequiredField': 'Das Feld „{label}" ist erforderlich.',
  'newBot.errorNoTemplate': 'Bitte wählen Sie eine Vorlage',
  'newBot.errorInvalidName': 'Ungültiger Name',
  'newBot.errorInvalidNameHint': 'Nur Kleinbuchstaben, Ziffern und Bindestriche (2-64 Zeichen)',
  'newBot.errorInvalidToken': 'Ungültiges Token',
  'newBot.errorInvalidTokenHint': 'Geben Sie Ihr Discord-Token ein (auf discord.com/developers verfügbar)',
  'newBot.successCreatedTitle': '🤖 Bot erstellt!',
  'newBot.successCreatedDesc': '{name} — discord.js erfolgreich installiert.',
  'newBot.errorCreateTitle': 'Erstellungsfehler',
  'newBot.noTemplates': 'Keine Vorlage verfügbar',
  'newBot.tryAgain': 'Erneut versuchen',
  'newBot.templateCount': '{n} Vorlage(n)',
  'newBot.tokenPlaceholder': 'MTI…',
  'npm.chooseBot': 'Bot auswählen',
  'npm.selectBotHint': 'Wählen Sie einen Bot aus, um seine npm-Abhängigkeiten zu verwalten.',
  'npm.installNameLabel': 'Paketname',
  'npm.installNamePh': 'z. B. axios, lodash',
  'npm.installing': 'Installation…',
  'npm.installed': 'Installiert',
  'npm.uninstalled': 'Deinstalliert',
  'npm.removeBtn': 'Entfernen',
  'npm.refreshBtn': 'Aktualisieren',
  'npm.noBotsTitle': 'Kein Bot',
  'npm.noBotsDesc': 'Erstellen Sie zuerst einen Bot, um seine npm-Abhängigkeiten zu verwalten.',
  'npm.errorTitle': 'Ladefehler',
  'npm.errorDesc': 'npm-Abhängigkeiten konnten nicht geladen werden.',
  'npm.retry': 'Erneut versuchen',
  'npm.emptyNoPkgTitle': 'Keine Abhängigkeit installiert',
  'npm.emptyNoPkgDesc': 'Für diesen Bot wurde noch keine Abhängigkeit installiert.',
  'npm.emptyNoPkgCta': 'Erstes Paket installieren',
  'npm.uninstallConfirm': 'Deinstallieren',
  'npm.uninstallConfirmDesc': '<strong>{pkg}</strong> von {bot} entfernen?',
  'npm.metaCount': '{n} Paket(e)',
  'npm.versionsLabel': 'Versionen',
  'npm.backendEmpty': 'package.json für diesen Bot nicht gefunden',
  'npm.packageJsonMissing': 'package.json fehlt',
  'logs.selectBotHint': 'Wählen Sie einen Bot aus, um seine Protokolle anzuzeigen.',
  'logs.autoRefresh': 'Auto-Aktualisierung',
  'logs.clearBtn': 'Leeren',
  'logs.refreshBtn': 'Aktualisieren',
  'logs.noBotsTitle': 'Kein Bot',
  'logs.noBotsDesc': 'Erstellen Sie zuerst einen Bot, um seine Protokolle anzuzeigen.',
  'logs.noBotSelectedTitle': 'Kein Bot ausgewählt',
  'logs.noBotSelectedDesc': 'Wählen Sie oben einen Bot aus, um seine Protokolle zu sehen.',
  'logs.emptyLogsTitle': 'Keine Protokolle',
  'logs.emptyLogsDesc': 'Dieser Bot hat derzeit keine Protokolle.',
  'logs.errorTitle': 'Ladefehler',
  'logs.errorDesc': 'Protokolle konnten nicht geladen werden.',
  'logs.retry': 'Erneut versuchen',
  'logs.streamOn': 'Live-Stream',
  'logs.streamOff': 'Live-Stream pausiert',
  'logs.streamStart': 'Starten',
  'logs.streamStop': 'Stoppen',
  'logs.backendEmpty': 'Keine Protokolldatei für diesen Bot',
  'logs.downloadingLogs': 'Protokolle werden heruntergeladen…',
  'logs.downloadError': 'Protokolle konnten nicht heruntergeladen werden',
  'login.usernamePh': 'admin',
  'login.passwordPh': '••••••••',
  'topbar.searchPh': 'Bot suchen (Strg+K)…',
  'topbar.backupsBtn': 'Backups',
  'topbar.newBotBtn': 'Neuer Bot',
  'topbar.bcHome': 'Nexus',
  'topbar.bcDashboard': 'Übersicht',
  'sidebar.sbName': 'Nexus',
  'sidebar.sbVer': 'Bot Manager',
  'sidebar.sbRole': 'Administrator',
  'connectionDot.connected': 'Verbunden',
  'connectionDot.disconnected': 'Getrennt',
  'actionTitle.stop': 'Stoppen',
  'actionTitle.restart': 'Neu starten',
  'actionTitle.start': 'Starten',
  'actionTitle.logs': 'Protokolle',
  'actionTitle.delete': 'Löschen',
  'actionTitle.open': 'Öffnen',
  'errors.genericDesc': 'Etwas ist schiefgelaufen.',
  'errors.forbiddenTitle': 'Berechtigung verweigert',
  'errors.forbiddenDesc': 'Sie haben keinen Zugriff auf diese Aktion.',
  'errors.networkTitle': 'Netzwerkfehler',
  'errors.networkDesc': 'Der Server konnte nicht erreicht werden.',
  'empty.noLogsDesc': 'Dieser Bot hat derzeit kein Protokoll.',
  'empty.noLogsNoBot': 'Kein Bot erstellt',
  'empty.noLogsNoBotDesc': 'Erstellen Sie zuerst einen Bot, um seine Protokolle und Fehler anzuzeigen.',
  'empty.noBotSelected': 'Kein Bot ausgewählt',
  'empty.noBotSelectedDesc': 'Wählen Sie einen Bot in der Liste aus, um seine Protokolle zu sehen.',
  'empty.logsErrorTitle': 'Protokolle konnten nicht geladen werden',
  'empty.logsErrorDesc': 'Bitte versuchen Sie es in wenigen Augenblicken erneut.',
  'empty.noNpmDeps': 'Kein npm-Paket installiert',
  'empty.noNpmDepsDesc': 'Für diesen Bot wurde noch keine Abhängigkeit installiert.',
  'empty.noNpmDepsCta': 'Erstes Paket installieren'
};

// Orphan keys to add back to EN (and FR/DE) from the original fr/de dict
const ORPHAN_EN = {
  'newBot.step2Title': 'Bot configuration',
  'newBot.step2NamePh': 'community-manager',
  'npm.packageNameLabel': 'Package name',
  'npm.packageNamePh': 'e.g. discord.js, dotenv',
  'npm.uninstallBtn': 'Uninstall'
};
const ORPHAN_FR = {
  'newBot.step2Title': 'Configuration du bot',
  'newBot.step2NamePh': 'gestionnaire-communaute',
  'npm.packageNameLabel': 'Nom du package',
  'npm.packageNamePh': 'ex. discord.js, dotenv',
  'npm.uninstallBtn': 'Désinstaller'
};
const ORPHAN_DE = {
  'newBot.step2Title': 'Bot-Konfiguration',
  'newBot.step2NamePh': 'community-manager',
  'npm.packageNameLabel': 'Paketname',
  'npm.packageNamePh': 'z. B. discord.js, dotenv',
  'npm.uninstallBtn': 'Deinstallieren'
};

// --- Process -----------------------------------------------------------

function loadDict(file, lang) {
  const content = fs.readFileSync(path.join(DIR, file), 'utf8');
  return { content, ...extractDict(content, lang) };
}

function buildLang(lang, file, overrides, orphan) {
  const { content, obj } = loadDict(file, lang);
  const enKeys = flattenKeys(obj);
  // apply overrides
  for (const [key, val] of Object.entries(overrides)) {
    setDeep(obj, key, val);
  }
  // apply orphan (add to all langs)
  for (const [key, val] of Object.entries(orphan)) {
    setDeep(obj, key, val);
  }
  const allKeys = flattenKeys(obj);
  return { file, obj, content, enKeys, allKeys };
}

function main() {
  const en = buildLang('en', 'en.js', {}, ORPHAN_EN);
  const fr = buildLang('fr', 'fr.js', FR_OVERRIDES, ORPHAN_FR);
  const de = buildLang('de', 'de.js', DE_OVERRIDES, ORPHAN_DE);

  // Identify still-missing keys (in en but not in fr/de)
  const enKeySet = new Set(en.allKeys);
  const frMissing = en.allKeys.filter(k => !getDeep(fr.obj, k));
  const deMissing = en.allKeys.filter(k => !getDeep(de.obj, k));

  console.log('EN baseline keys:', en.allKeys.length);
  console.log('FR present:', en.allKeys.filter(k => getDeep(fr.obj, k)).length, '/', en.allKeys.length);
  console.log('DE present:', en.allKeys.filter(k => getDeep(de.obj, k)).length, '/', en.allKeys.length);

  if (frMissing.length || deMissing.length) {
    console.error('\nStill missing keys — these should not happen after applying overrides + orphans:');
    if (frMissing.length) console.error('  FR:', frMissing.join(', '));
    if (deMissing.length) console.error('  DE:', deMissing.join(', '));
    process.exit(2);
  }

  // Re-serialize each dict. We keep the original file format
  // (IIFE wrapping window.NexusI18n.register(...))
  function serialize(lang, dict) {
    const before = lang === 'en'
      ? `/* English translations — default / reference */\n(function () {\n  window.NexusI18n.register('en', `
      : lang === 'fr'
        ? `/* Traductions françaises */\n(function () {\n  window.NexusI18n.register('fr', `
        : `/* Deutsche Übersetzungen */\n(function () {\n  window.NexusI18n.register('de', `;
    const body = JSON.stringify(dict, null, 2)
      // JSON uses double-quotes; restore single quotes for HTML attributes
      .replace(/'/g, "\\'")
      // unescape common escape sequences
      .replace(/\\\\/g, '\\\\')
      .replace(/\\'/g, "'");
    const after = `\n  });\n})();`;
    return before + body + after;
  }

  for (const [lang, info] of [['en', en], ['fr', fr], ['de', de]]) {
    const out = serialize(lang, info.obj);
    fs.writeFileSync(path.join(DIR, info.file), out, 'utf8');
    console.log(`✔ Wrote ${info.file} (${flattenKeys(info.obj).length} keys)`);
  }
}

main();