'use strict';
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const archiver  = require('archiver');
const extract   = require('extract-zip');
const multer    = require('multer');
const os        = require('os');

const { requireAuth }    = require('../middleware/auth.middleware');
const { sanitizeBotName } = require('../middleware/security');
const { getDb }          = require('../db/db');
const fsService          = require('../services/fs.service');
const pm2Service         = require('../services/pm2.service');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir(), filename: (r, f, cb) => cb(null, `nbm-import-${Date.now()}.zip`) }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.originalname.endsWith('.zip') || file.mimetype.includes('zip'))
});

// GET /api/backups
router.get('/', (req, res) => {
  res.json(getDb().getAllBackups());
});

// POST /api/backups/:botName/export
router.post('/:botName/export', (req, res) => {
  const safeName = sanitizeBotName(req.params.botName);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const dir = fsService.botPath(safeName);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Bot introuvable' });

  const filename = `${safeName}-${new Date().toISOString().slice(0, 10)}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
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
router.post('/import', upload.single('archive'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });

  const tmpFile    = req.file.path;
  const tmpExtract = path.join(os.tmpdir(), `nbm-imp-${Date.now()}`);

  try {
    await extract(tmpFile, { dir: tmpExtract });

    const entries = fs.readdirSync(tmpExtract);
    const botDir  = entries.find(e => fs.statSync(path.join(tmpExtract, e)).isDirectory());
    if (!botDir) throw new Error('Structure d\'archive invalide (aucun dossier trouvé)');

    const safeName = sanitizeBotName(botDir);
    if (!safeName) throw new Error(`Nom de bot invalide dans l'archive : ${botDir}`);

    const destPath = fsService.botPath(safeName);
    if (fs.existsSync(destPath)) throw new Error(`Le bot "${safeName}" existe déjà`);

    fs.renameSync(path.join(tmpExtract, botDir), destPath);

    const db = getDb();
    if (!db.getBot(safeName)) db.createBot({ name: safeName, templateId: 'imported' });
    db.logActivity({ action: 'bot_imported', bot_name: safeName, user: req.user.username });

    res.json({ message: `Bot "${safeName}" importé avec succès`, name: safeName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (_) {}
  }
});

// DELETE /api/backups/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' });
  getDb().deleteBackup(id);
  res.json({ message: 'Entrée supprimée' });
});

module.exports = router;
