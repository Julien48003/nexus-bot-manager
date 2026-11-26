'use strict';
/**
 * On-server snapshots of a bot folder.
 *
 * A snapshot is a zip stored under DATA_DIR/snapshots/<bot>/ and indexed
 * in the database. Creating one never leaves the bot folder (symlinks are
 * skipped), and restoring uses the same hardened ZIP extractor as backup
 * imports before replacing the live folder with a rollback copy.
 */
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const crypto  = require('crypto');
const archiver = require('archiver');

const { getDb, DATA_DIR } = require('../db/db');
const { sanitizeBotName }  = require('../middleware/security');
const archive              = require('./archive.service');
const fsService            = require('./fs.service');
const pm2Service           = require('./pm2.service');

const MAX_SNAPSHOTS_PER_BOT = 20;
const MAX_SOURCE_BYTES      = 250 * 1024 * 1024;
const MAX_EXTRACTED_BYTES   = 1024 * 1024 * 1024;

function snapshotsRoot() {
  return path.join(DATA_DIR, 'snapshots');
}

function botSnapshotDir(botName) {
  const safe = sanitizeBotName(botName);
  if (!safe) throw new Error('Nom de bot invalide');
  return path.join(snapshotsRoot(), safe);
}

function ensureSnapshotDir(botName) {
  const dir = botSnapshotDir(botName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  return dir;
}

/**
 * Walk regular files only. node_modules, VCS data, logs and symlinks are
 * deliberately excluded so a snapshot stays small and cannot leave the
 * bot directory.
 */
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
      if (state.bytes > MAX_SOURCE_BYTES) {
        const err = new Error('Le bot dépasse la taille maximale d’un snapshot (250 Mo)');
        err.code = 'SNAPSHOT_TOO_LARGE';
        throw err;
      }
      state.files.push({ abs: full, rel: nextRel.replace(/\\/g, '/') });
    }
  }
  return state;
}

async function createSnapshot({ botName, label = '', user = 'system' }) {
  const safe = sanitizeBotName(botName);
  if (!safe) throw new Error('Nom de bot invalide');
  const db = getDb();
  const bot = db.getBot(safe);
  if (!bot) {
    const err = new Error('Bot introuvable');
    err.code = 'BOT_NOT_FOUND';
    throw err;
  }
  const botDir = fsService.botPath(safe);
  if (!fs.existsSync(botDir)) {
    const err = new Error('Dossier du bot introuvable');
    err.code = 'BOT_NOT_FOUND';
    throw err;
  }
  if (fs.lstatSync(botDir).isSymbolicLink()) {
    throw new Error('Le dossier du bot est un lien symbolique');
  }
  if (db.getSnapshots(safe).length >= MAX_SNAPSHOTS_PER_BOT) {
    const err = new Error(`Limite de ${MAX_SNAPSHOTS_PER_BOT} snapshots atteinte pour ce bot`);
    err.code = 'SNAPSHOT_LIMIT';
    throw err;
  }

  const { files } = collectFiles(botDir);
  if (files.length === 0) {
    const err = new Error('Le dossier du bot est vide');
    err.code = 'SNAPSHOT_EMPTY';
    throw err;
  }

  const dir = ensureSnapshotDir(safe);
  const filename = `${crypto.randomUUID()}.zip`;
  const finalPath = path.join(dir, filename);
  const tmpPath = path.join(dir, `.${crypto.randomUUID()}.tmp`);

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(tmpPath, { mode: 0o600 });
      const zip = archiver('zip', { zlib: { level: 6 } });
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { zip.abort(); } catch (_) {}
        try { output.destroy(); } catch (_) {}
        reject(err);
      };
      output.on('close', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      output.on('error', fail);
      zip.on('error', fail);
      zip.pipe(output);
      for (const file of files) zip.file(file.abs, { name: file.rel });
      zip.finalize();
    });

    const stat = fs.statSync(tmpPath);
    if (stat.size > MAX_SOURCE_BYTES) {
      const err = new Error('Le snapshot dépasse la taille maximale (250 Mo)');
      err.code = 'SNAPSHOT_TOO_LARGE';
      throw err;
    }
    if (stat.size === 0) {
      const err = new Error('Le snapshot est vide');
      err.code = 'SNAPSHOT_EMPTY';
      throw err;
    }
    fs.renameSync(tmpPath, finalPath);
    try { fs.chmodSync(finalPath, 0o600); } catch (_) {}

    const shot = db.createSnapshot({
      bot_name: safe,
      label,
      filename,
      size_bytes: stat.size,
      created_by: user
    });
    db.logActivity({ action: 'bot_snapshot_created', bot_name: safe, user, details: label || filename });
    return shot;
  } catch (err) {
    for (const p of [tmpPath, finalPath]) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
    throw err;
  }
}

function getSnapshotFile(snapshot) {
  const dir = botSnapshotDir(snapshot.bot_name);
  if (path.basename(snapshot.filename) !== snapshot.filename) return null;
  const full = path.join(dir, snapshot.filename);
  try {
    if (!fs.lstatSync(full).isFile()) return null;
  } catch (_) {
    return null;
  }
  return full;
}

function deleteSnapshot(botName, id) {
  const db = getDb();
  const snapshot = db.getSnapshot(id);
  if (!snapshot || snapshot.bot_name !== botName) return false;
  const file = getSnapshotFile(snapshot);
  if (file) { try { fs.unlinkSync(file); } catch (_) {} }
  db.deleteSnapshot(id);
  return true;
}

function deleteSnapshotsForBot(botName) {
  const dir = botSnapshotDir(botName);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  getDb().deleteSnapshotsForBot(botName);
}

async function restoreSnapshot({ botName, id, user = 'system' }) {
  const safe = sanitizeBotName(botName);
  if (!safe) throw new Error('Nom de bot invalide');
  const db = getDb();
  const bot = db.getBot(safe);
  if (!bot) {
    const err = new Error('Bot introuvable');
    err.code = 'BOT_NOT_FOUND';
    throw err;
  }
  const snapshot = db.getSnapshot(id);
  if (!snapshot || snapshot.bot_name !== safe) {
    const err = new Error('Snapshot introuvable');
    err.code = 'SNAPSHOT_NOT_FOUND';
    throw err;
  }
  const snapshotFile = getSnapshotFile(snapshot);
  if (!snapshotFile) {
    const err = new Error('Fichier du snapshot introuvable');
    err.code = 'SNAPSHOT_NOT_FOUND';
    throw err;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-snap-'));
  const botDir = fsService.botPath(safe);
  if (fs.existsSync(botDir) && fs.lstatSync(botDir).isSymbolicLink()) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    const err = new Error('Le dossier du bot est un lien symbolique');
    err.code = 'BOT_NOT_FOUND';
    throw err;
  }
  const backupDir = path.join(path.dirname(botDir), `.nbm-restore-${crypto.randomUUID()}`);
  let wasOnline = false;
  let movedAside = false;

  try {
    await archive.extractZipSafe(snapshotFile, tmpDir, { maxTotalBytes: MAX_EXTRACTED_BYTES });
    if (fs.readdirSync(tmpDir).length === 0) {
      throw new Error('Le snapshot est vide');
    }

    try {
      const proc = await pm2Service.describe(safe);
      const status = proc?.pm2_env?.status || proc?.status;
      wasOnline = status === 'online';
    } catch (_) {}
    if (wasOnline) {
      try { await pm2Service.stop(safe); } catch (_) {}
    }

    if (fs.existsSync(botDir)) {
      fs.renameSync(botDir, backupDir);
      movedAside = true;
    }
    try {
      fs.cpSync(tmpDir, botDir, { recursive: true });
      try { fs.chmodSync(path.join(botDir, '.env'), 0o600); } catch (_) {}
    } catch (err) {
      try { fs.rmSync(botDir, { recursive: true, force: true }); } catch (_) {}
      if (movedAside) {
        try { fs.renameSync(backupDir, botDir); } catch (_) {}
        movedAside = false;
      }
      throw err;
    }

    if (movedAside) {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (_) {}
      movedAside = false;
    }

    if (wasOnline) {
      try { await pm2Service.restart(safe); } catch (_) {
        try {
          await pm2Service.start(safe, botDir, {
            script: bot.startup_file || 'index.js',
            maxMemory: bot.memory_limit,
            cronRestart: bot.restart_cron
          });
        } catch (_) {}
      }
    }

    db.logActivity({
      action: 'bot_snapshot_restored',
      bot_name: safe,
      user,
      details: snapshot.label || snapshot.filename
    });
    return snapshot;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    if (movedAside) {
      // The restore failed before the rollback completed: keep the original
      // folder rather than leaving the bot without a directory.
      try { fs.rmSync(botDir, { recursive: true, force: true }); } catch (_) {}
      try { fs.renameSync(backupDir, botDir); } catch (_) {}
    }
  }
}

module.exports = {
  MAX_SNAPSHOTS_PER_BOT,
  snapshotsRoot,
  createSnapshot,
  getSnapshotFile,
  deleteSnapshot,
  deleteSnapshotsForBot,
  restoreSnapshot
};
