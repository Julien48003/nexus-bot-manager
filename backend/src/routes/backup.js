'use strict';
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const archiver  = require('archiver');
const archive   = require('../services/archive.service');
const multer    = require('multer');
const os        = require('os');

const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');
const { sanitizeBotName, isInsideReal, sanitizeLogText } = require('../middleware/security');
const { getDb }          = require('../db/db');
const fsService          = require('../services/fs.service');

const router = express.Router();
router.use(requireAdmin);

// UPD-06: 500 MB is an unreasonable ceiling for a bot folder and gives
// the extractor a very large decompression-bomb surface.
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
// A 200 MB zip can expand to far more than 200 MB: cap the total
// uncompressed size so a decompression bomb cannot fill the disk.
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    // fs.mkdtemp-style randomness instead of a Date.now() name that a
    // local user can pre-create (symlink attack on a predictable path).
    filename: (r, f, cb) => cb(null, `nbm-import-${crypto.randomUUID()}.zip`)
  }),
  limits: { fileSize: MAX_ARCHIVE_BYTES },
  fileFilter: (req, file, cb) => cb(null, file.originalname.endsWith('.zip') || file.mimetype.includes('zip'))
});

// GET /api/backups
router.get('/', (req, res) => {
  res.json(getDb().getAllBackups());
});

// POST /api/backups/:botName/export
router.post('/:botName/export', requireAdmin, (req, res) => {
  const safeName = sanitizeBotName(req.params.botName);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const dir = fsService.botPath(safeName);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Bot introuvable' });

  const filename = `${safeName}-${new Date().toISOString().slice(0, 10)}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { if (!res.headersSent) res.status(500).json({ error: sanitizeLogText(err.message) }); });
  archive.pipe(res);
  archive.glob('**/*', { cwd: dir, ignore: ['node_modules/**', '*.log'], dot: true });
  archive.finalize().then(() => {
    try {
      getDb().createBackup({ bot_name: safeName, filename, size_bytes: 0 });
      getDb().logActivity({ action: 'bot_exported', bot_name: safeName, user: req.user.username });
    } catch (_) {}
  });
});

// POST /api/backups/import
// CMD-01: importing an archive installs executable code (index.js) and a
// package.json that the panel will run with PM2, so it is an admin action.
router.post('/import', requireAdmin, upload.single('archive'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });

  const tmpFile    = req.file.path;
  const tmpExtract = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-imp-'));

  try {
    await archive.extractZipSafe(tmpFile, tmpExtract, {
      maxTotalBytes: MAX_EXTRACTED_BYTES
    });

    const entries = fs.readdirSync(tmpExtract);
    if (entries.length !== 1) {
      const err = new Error('Structure d\'archive invalide (un seul dossier racine attendu)');
      err.code = 'ARCHIVE_UNSAFE';
      throw err;
    }

    const botDir = entries[0];
    const botDirPath = path.join(tmpExtract, botDir);
    let botDirStat;
    try { botDirStat = fs.lstatSync(botDirPath); } catch (_) { botDirStat = null; }
    if (!botDirStat || !botDirStat.isDirectory() || botDirStat.isSymbolicLink()) {
      const err = new Error('Structure d\'archive invalide (dossier racine manquant)');
      err.code = 'ARCHIVE_UNSAFE';
      throw err;
    }

    const safeName = sanitizeBotName(botDir);
    if (!safeName) {
      const err = new Error(`Nom de bot invalide dans l'archive : ${sanitizeLogText(botDir, 64)}`);
      err.code = 'ARCHIVE_UNSAFE';
      throw err;
    }

    // Defense in depth: the service already walked the tree, but the rename
    // below moves the whole directory and this check is cheap.
    if (!isInsideReal(tmpExtract, botDirPath)) {
      const err = new Error('Archive invalide (lien symbolique)');
      err.code = 'ARCHIVE_UNSAFE';
      throw err;
    }

    const destPath = fsService.botPath(safeName);
    if (fs.existsSync(destPath)) {
      const err = new Error(`Le bot "${safeName}" existe déjà`);
      err.code = 'EEXIST_BOT';
      throw err;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.renameSync(botDirPath, destPath);
    // The imported bot's .env carries its Discord token.
    try { fs.chmodSync(path.join(destPath, '.env'), 0o600); } catch (_) {}

    const db = getDb();
    if (!db.getBot(safeName)) db.createBot({ name: safeName, templateId: 'imported' });
    db.logActivity({ action: 'bot_imported', bot_name: safeName, user: req.user.username });

    res.json({ message: `Bot "${safeName}" importé avec succès`, name: safeName });
  } catch (e) {
    const archiveError = e && typeof e.code === 'string' && e.code.startsWith('ARCHIVE_');
    const status = e && e.code === 'EEXIST_BOT' ? 409 : archiveError ? 400 : 500;
    res.status(status).json({ error: sanitizeLogText(e.message) });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (_) {}
  }
});

// DELETE /api/backups/:id
router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' });
  getDb().deleteBackup(id);
  res.json({ message: 'Entrée supprimée' });
});

module.exports = router;
