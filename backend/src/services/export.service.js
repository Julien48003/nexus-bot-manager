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
const archiver = require('archiver');

const { getDb, DB_PATH, DATA_DIR } = require('../db/db');
const { publicUser } = require('./user.service');
const fsService = require('./fs.service');
const versionSvc = require('./version.service');
const { publicWebhook } = require('./webhook.service');

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

function streamFullExport(res, user = 'system') {
  const db = getDb();
  const version = versionSvc.loadLocal().version;
  const exportedAt = new Date().toISOString();
  const bots = db.getAllBots();

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="nexus-full-backup-${exportedAt.slice(0, 10)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });
  archive.pipe(res);

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

  if (fs.existsSync(DB_PATH)) {
    archive.file(DB_PATH, { name: 'nexus.db.json' });
  }

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

  return archive;
}

module.exports = { settingsExport, streamFullExport };
