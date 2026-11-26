'use strict';
/**
 * Panel exports.
 *
 * - Settings export: readable JSON without authentication secrets.
 * - Full backup: ZIP with the raw database, every bot folder (including
 *   .env files), snapshots and a manifest. This archive is sensitive.
 */
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const archiver = require('archiver');

const { getDb, DATA_DIR } = require('../db/db');
const {
  publicUser, normalizeDisplayName, normalizeAvatar, normalizeAllowedBots
} = require('./user.service');
const { normalizeMcpScopes } = require('./mcp-config.service');
const fsService = require('./fs.service');
const pm2Service = require('./pm2.service');
const versionSvc = require('./version.service');
const webhookSvc = require('./webhook.service');
const { isSafeRelativePath, sanitizeBotName } = require('../middleware/security');
const { publicWebhook } = webhookSvc;

function settingsExport() {
  const db = getDb();
  const settings = { ...db.getSettings() };
  // Authentication secrets are never part of the shareable configuration.
  settings.mcp_token = null;
  return {
    format: 'nexus-settings',
    format_version: 1,
    app_version: versionSvc.loadLocal().version,
    exported_at: new Date().toISOString(),
    secrets_redacted: ['settings.mcp_token', 'users[].password_hash'],
    settings,
    users: db.getAllUsers().map(publicUser),
    bots: db.getAllBots(),
    webhooks: db.getAllWebhooks().map(publicWebhook)
  };
}

function collectFiles(root, rel = '', state = { files: [], bytes: 0 }) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch (_) {
    return state;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const nextRel = rel ? path.join(rel, entry.name) : entry.name;
    const full = path.join(root, nextRel);
    let stat;
    try { stat = fs.lstatSync(full); } catch (_) { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      collectFiles(root, nextRel, state);
    } else if (stat.isFile()) {
      if (/\.log$/i.test(entry.name)) continue;
      state.bytes += stat.size;
      state.files.push({ abs: full, rel: nextRel.replace(/\\/g, '/') });
    }
  }
  return state;
}

function appendFullExport(archive, { user = 'system' } = {}) {
  const db = getDb();
  const version = versionSvc.loadLocal().version;
  const exportedAt = new Date().toISOString();
  const bots = db.getAllBots();

  const manifest = {
    format: 'nexus-full-backup',
    format_version: 1,
    app_version: version,
    exported_at: exportedAt,
    counts: {
      users: db.getAllUsers().length,
      bots: bots.length,
      snapshots: bots.reduce((sum, bot) => sum + db.getSnapshots(bot.name).length, 0),
      webhooks: db.getAllWebhooks().length
    },
    warning: 'This archive contains bot .env files, the panel database and authentication secrets.'
  };

  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  archive.append([
    'Nexus Bot Manager - full backup',
    '',
    'This archive contains the panel database, user password hashes, the MCP',
    'token, webhook URLs and every bot folder including its .env file(s).',
    'Store it like a production secret and never attach it to a public issue.',
    ''
  ].join('\n'), { name: 'README.txt' });

  // Export the in-memory document rather than the debounced file: a setting
  // changed less than 100 ms ago must already be part of the backup.
  archive.append(JSON.stringify(db.data, null, 2), { name: 'nexus.db.json' });

  for (const bot of bots) {
    const dir = fsService.botPath(bot.name);
    if (!fs.existsSync(dir)) continue;
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) continue;
      const { files } = collectFiles(dir);
      for (const file of files) {
        archive.file(file.abs, { name: `bots/${bot.name}/${file.rel}` });
      }
    } catch (_) {
      // A bot directory disappearing during the export must not abort the
      // rest of the backup.
    }
  }

  const snapshotsDir = path.join(DATA_DIR, 'snapshots');
  if (fs.existsSync(snapshotsDir)) {
    archive.directory(snapshotsDir, 'snapshots');
  }

  archive.finalize().then(() => {
    try {
      db.logActivity({ action: 'panel_exported', user, details: 'full backup' });
    } catch (_) {}
  }).catch(() => {});

  return { exportedAt, manifest };
}

function streamFullExport(res, user = 'system') {
  const db = getDb();

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="nexus-full-backup-${new Date().toISOString().slice(0, 10)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });
  archive.pipe(res);
  appendFullExport(archive, { user });
  return archive;
}

function writeFullBackupFile({ user = 'system' } = {}) {
  const dir = path.join(DATA_DIR, 'exports');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `nexus-full-backup-${stamp}.zip`;
  const filePath = path.join(dir, filename);
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath, { mode: 0o600 });
    const archive = archiver('zip', { zlib: { level: 6 } });
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      try { archive.abort(); } catch (_) {}
      try { output.destroy(); } catch (_) {}
      try { fs.unlinkSync(filePath); } catch (_) {}
      reject(err);
    };
    output.on('close', () => {
      if (settled) return;
      settled = true;
      try {
        const stat = fs.statSync(filePath);
        resolve({ path: filePath, filename, size_bytes: stat.size });
      } catch (e) { reject(e); }
    });
    output.on('error', fail);
    archive.on('error', fail);
    archive.pipe(output);
    appendFullExport(archive, { user });
  });
}

// ------------------------------------------------------------
// Imports
// ------------------------------------------------------------
function invalid(message) {
  const err = new Error(message);
  err.code = 'EXPORT_INVALID';
  return err;
}

function normalizeStartupFile(value) {
  const clean = String(value || '').trim().replace(/^\.\//, '');
  if (!clean || !/\.(js|mjs|cjs)$/i.test(clean) || !isSafeRelativePath(clean)) return null;
  return clean;
}

function normalizeMemoryLimit(value) {
  if (value === null || value === undefined || value === '') return { value: null };
  const m = String(value).trim().match(/^(\d{2,5})\s*[Mm]?$/);
  if (!m) return { invalid: true };
  const mb = parseInt(m[1], 10);
  if (!Number.isFinite(mb) || mb < 64 || mb > 8192) return { invalid: true };
  return { value: `${mb}M` };
}

function normalizeRestartCron(value) {
  if (value === null || value === undefined || value === '') return { value: null };
  const raw = String(value).trim();
  const fields = raw.split(/\s+/);
  if (fields.length !== 5 || !fields.every(f => /^[0-9*/,.-]+$/.test(f))) return { invalid: true };
  return { value: raw };
}

function applySettingsImport(data, user = 'admin') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('Fichier de configuration invalide');
  if (data.format !== 'nexus-settings') throw invalid('Ce fichier n’est pas un export de paramètres Nexus');
  if (Number(data.format_version) > 1) throw invalid('Version d’export non prise en charge');

  const db = getDb();
  const sourceSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const patch = {};

  if (sourceSettings.instance_name !== undefined) {
    const name = String(sourceSettings.instance_name).trim().slice(0, 80);
    if (name) patch.instance_name = name;
  }
  if (sourceSettings.theme !== undefined) {
    if (!['dark', 'light', 'system'].includes(sourceSettings.theme)) throw invalid('Thème invalide');
    patch.theme = sourceSettings.theme;
  }
  if (sourceSettings.language !== undefined) {
    if (!['en', 'fr', 'de'].includes(sourceSettings.language)) throw invalid('Langue invalide');
    patch.language = sourceSettings.language;
  }
  for (const key of ['bot_autorestart', 'notifications_enabled', 'mcp_enabled']) {
    if (sourceSettings[key] !== undefined) patch[key] = sourceSettings[key] === true;
  }
  for (const key of ['bot_max_restarts', 'monitoring_interval']) {
    if (sourceSettings[key] !== undefined) {
      const n = parseInt(sourceSettings[key], 10);
      if (!Number.isFinite(n) || n < 1 || n > 999) throw invalid(`Valeur invalide pour ${key}`);
      patch[key] = n;
    }
  }
  if (sourceSettings.mcp_scopes !== undefined) {
    if (!sourceSettings.mcp_scopes || typeof sourceSettings.mcp_scopes !== 'object') throw invalid('Permissions MCP invalides');
    patch.mcp_scopes = normalizeMcpScopes(sourceSettings.mcp_scopes);
  }
  if (sourceSettings.mcp_enabled === true && !db.getSettings().mcp_token) {
    patch.mcp_token = crypto.randomBytes(32).toString('hex');
  }
  db.updateSettings(patch);

  let webhooksImported = 0;
  if (Array.isArray(data.webhooks)) {
    for (const existing of db.getAllWebhooks()) db.deleteWebhook(existing.id);
    for (const raw of data.webhooks) {
      if (!raw || typeof raw !== 'object') continue;
      const name = String(raw.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
      const url = webhookSvc.normalizeUrl(raw.url);
      const events = webhookSvc.normalizeEvents(raw.events);
      if (!name || !url || !events || events.length === 0) continue;
      db.createWebhook({
        name,
        url,
        events,
        enabled: raw.enabled === true,
        format: webhookSvc.normalizeFormat(raw.format)
      });
      webhooksImported++;
    }
  }

  let usersUpdated = 0, usersSkipped = 0;
  if (Array.isArray(data.users)) {
    for (const raw of data.users) {
      if (!raw || typeof raw.username !== 'string') { usersSkipped++; continue; }
      const user = db.getUserByUsername(raw.username);
      if (!user) { usersSkipped++; continue; }
      const userPatch = {};
      if (raw.display_name !== undefined) {
        const display = normalizeDisplayName(raw.display_name);
        if (display) userPatch.display_name = display;
      }
      if (raw.avatar !== undefined) {
        const av = normalizeAvatar(raw.avatar);
        if (!av.invalid) userPatch.avatar = av.value;
      }
      let role = user.role;
      if (raw.role === 'admin' || raw.role === 'user') {
        if (user.role === 'admin' && raw.role !== 'admin' && db.getAllUsers().filter(u => u.role === 'admin').length <= 1) {
          role = user.role;
        } else {
          userPatch.role = raw.role;
          role = raw.role;
        }
      }
      if (Array.isArray(raw.allowed_bots)) {
        const allowed = normalizeAllowedBots(role === 'user' ? raw.allowed_bots : [], db);
        if (!allowed.invalid) userPatch.allowed_bots = allowed.value || [];
      }
      if (['en', 'fr', 'de'].includes(raw.language)) userPatch.language = raw.language;
      const previousRole = user.role;
      db.updateUser(user.id, userPatch);
      if (userPatch.role && userPatch.role !== previousRole) db.revokeAllUserTokens(user.id);
      usersUpdated++;
    }
  }

  let botsUpdated = 0, botsSkipped = 0;
  if (Array.isArray(data.bots)) {
    for (const raw of data.bots) {
      if (!raw || typeof raw.name !== 'string') { botsSkipped++; continue; }
      const bot = db.getBot(raw.name);
      if (!bot) { botsSkipped++; continue; }
      const botPatch = {};
      if (raw.display_name !== undefined) {
        const display = normalizeDisplayName(raw.display_name);
        if (display) botPatch.display_name = display;
      }
      if (raw.description !== undefined) botPatch.description = String(raw.description).slice(0, 2000);
      if (raw.notes !== undefined) botPatch.notes = String(raw.notes).slice(0, 4000);
      if (raw.avatar !== undefined) {
        const av = normalizeAvatar(raw.avatar);
        if (!av.invalid) botPatch.avatar = av.value;
      }
      if (raw.autostart !== undefined) botPatch.autostart = raw.autostart === true;
      if (raw.mcp_exposed !== undefined) botPatch.mcp_exposed = raw.mcp_exposed === true;
      if (raw.startup_file !== undefined) {
        const entry = normalizeStartupFile(raw.startup_file);
        if (entry) botPatch.startup_file = entry;
      }
      if (raw.memory_limit !== undefined) {
        const mem = normalizeMemoryLimit(raw.memory_limit);
        if (!mem.invalid) botPatch.memory_limit = mem.value;
      }
      if (raw.restart_cron !== undefined) {
        const cron = normalizeRestartCron(raw.restart_cron);
        if (!cron.invalid) botPatch.restart_cron = cron.value;
      }
      db.updateBot(bot.name, botPatch);
      botsUpdated++;
    }
  }

  db.logActivity({ action: 'settings_imported', user, details: `users=${usersUpdated}, bots=${botsUpdated}, webhooks=${webhooksImported}` });
  return {
    usersUpdated, usersSkipped,
    botsUpdated, botsSkipped,
    webhooksImported
  };
}

async function replaceBotDirectory(botName, sourceDir, botConfig = {}) {
  const botDir = fsService.botPath(botName);
  if (fs.existsSync(botDir) && fs.lstatSync(botDir).isSymbolicLink()) {
    throw invalid('Le dossier du bot est un lien symbolique');
  }
  let wasOnline = false;
  try {
    const proc = await pm2Service.describe(botName);
    wasOnline = (proc?.pm2_env?.status || proc?.status) === 'online';
  } catch (_) {}
  if (wasOnline) { try { await pm2Service.stop(botName); } catch (_) {} }

  const backupDir = path.join(path.dirname(botDir), `.nbm-import-${crypto.randomUUID()}`);
  let moved = false;
  try {
    if (fs.existsSync(botDir)) {
      fs.renameSync(botDir, backupDir);
      moved = true;
    }
    fs.cpSync(sourceDir, botDir, { recursive: true });
    try { fs.chmodSync(path.join(botDir, '.env'), 0o600); } catch (_) {}
    if (moved) {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (_) {}
      moved = false;
    }
  } catch (e) {
    try { fs.rmSync(botDir, { recursive: true, force: true }); } catch (_) {}
    if (moved) { try { fs.renameSync(backupDir, botDir); } catch (_) {} }
    throw e;
  }

  if (wasOnline) {
    try { await pm2Service.restart(botName); } catch (_) {
      try {
        await pm2Service.start(botName, botDir, {
          script: botConfig.startup_file || 'index.js',
          maxMemory: botConfig.memory_limit,
          cronRestart: botConfig.restart_cron
        });
      } catch (_) {}
    }
  }
}

async function applyFullImport(tempDir, { user = 'system' } = {}) {
  const manifestPath = path.join(tempDir, 'manifest.json');
  const dbPath = path.join(tempDir, 'nexus.db.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(dbPath)) {
    throw invalid('Sauvegarde incomplète : manifest.json ou nexus.db.json manquant');
  }
  let manifest, parsed;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { throw invalid('manifest.json illisible'); }
  if (manifest.format !== 'nexus-full-backup') throw invalid('Ce fichier n’est pas une sauvegarde complète Nexus');
  if (Number(manifest.format_version) > 1) throw invalid('Version de sauvegarde non prise en charge');
  try { parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch (_) { throw invalid('nexus.db.json illisible'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid('Base de données invalide');
  if (!Array.isArray(parsed.users) || !parsed.users.some(u => u && u.role === 'admin' && typeof u.password_hash === 'string' && u.password_hash.length > 0)) {
    throw invalid('La sauvegarde ne contient aucun administrateur valide');
  }
  if (!parsed.settings || typeof parsed.settings !== 'object') throw invalid('Paramètres absents de la sauvegarde');
  if (!Array.isArray(parsed.bots)) parsed.bots = [];
  for (const bot of parsed.bots) {
    if (!bot || typeof bot.name !== 'string' || sanitizeBotName(bot.name) !== bot.name) {
      throw invalid('Nom de bot invalide dans la sauvegarde');
    }
  }
  for (const user of parsed.users) {
    if (!user || typeof user.username !== 'string' || !user.username.trim()) {
      throw invalid('Compte invalide dans la sauvegarde');
    }
  }

  // Restore bot folders that belong to the backup database.
  const botsRoot = path.join(tempDir, 'bots');
  let botsRestored = 0;
  if (fs.existsSync(botsRoot)) {
    const backupBots = new Map(parsed.bots.filter(b => b && b.name).map(b => [b.name, b]));
    for (const entry of fs.readdirSync(botsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const safeName = sanitizeBotName(entry.name);
      if (!safeName || safeName !== entry.name) continue;
      const botConfig = backupBots.get(entry.name);
      if (!botConfig) continue;
      const sourceDir = path.join(botsRoot, entry.name);
      const stat = fs.lstatSync(sourceDir);
      if (stat.isSymbolicLink()) continue;
      await replaceBotDirectory(entry.name, sourceDir, botConfig);
      botsRestored++;
    }
  }

  // Merge snapshot files; the restored database supplies their metadata.
  const sourceSnapshots = path.join(tempDir, 'snapshots');
  if (fs.existsSync(sourceSnapshots)) {
    const destSnapshots = path.join(DATA_DIR, 'snapshots');
    fs.mkdirSync(destSnapshots, { recursive: true, mode: 0o700 });
    fs.cpSync(sourceSnapshots, destSnapshots, { recursive: true });
  }

  getDb().replaceData(parsed);
  getDb().logActivity({ action: 'full_backup_imported', user, details: `bots=${botsRestored}` });
  return {
    botsRestored,
    users: parsed.users.length,
    bots: parsed.bots.length,
    note: 'Bot dependencies (node_modules) are not part of the backup. Reinstall them after restoring.'
  };
}

module.exports = {
  settingsExport,
  streamFullExport,
  writeFullBackupFile,
  applySettingsImport,
  applyFullImport
};
