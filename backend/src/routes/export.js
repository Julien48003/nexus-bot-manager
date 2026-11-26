'use strict';
const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const crypto  = require('crypto');
const { requireAdmin } = require('../middleware/auth.middleware');
const { sanitizeLogText } = require('../middleware/security');
const { getDb } = require('../db/db');
const exportSvc = require('../services/export.service');
const archive = require('../services/archive.service');

const router = express.Router();
router.use(requireAdmin);

const uploadJson = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

const uploadZip = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, `nbm-import-${crypto.randomUUID()}.zip`)
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, file.originalname.endsWith('.zip') || file.mimetype.includes('zip'))
});

const MAX_EXTRACTED_BYTES = 8 * 1024 * 1024 * 1024;

function importStatus(e) {
  return (e && (e.code === 'EXPORT_INVALID' || String(e.code || '').startsWith('ARCHIVE_'))) ? 400 : 500;
}

// GET /api/export/settings — JSON configuration without auth secrets.
router.get('/settings', (req, res) => {
  const data = exportSvc.settingsExport();
  const date = data.exported_at.slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="nexus-settings-${date}.json"`);
  res.send(JSON.stringify(data, null, 2));
  getDb().logActivity({
    action: 'panel_exported_settings',
    user: req.user.username,
    details: 'settings export'
  });
});

// GET /api/export/full — complete ZIP backup (raw database, bots, snapshots).
router.get('/full', (req, res) => {
  exportSvc.streamFullExport(res, req.user.username);
});

// POST /api/export/import-settings — restore a redacted settings JSON.
router.post('/import-settings', uploadJson.single('file'), (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Fichier manquant' });
  let data;
  try { data = JSON.parse(req.file.buffer.toString('utf8')); }
  catch (_) { return res.status(400).json({ error: 'JSON invalide' }); }
  try {
    const summary = exportSvc.applySettingsImport(data, req.user.username);
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(importStatus(e)).json({ error: sanitizeLogText(e.message) });
  }
});

// POST /api/export/import-full — restore a full ZIP backup.
router.post('/import-full', uploadZip.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
  const tmpFile = req.file.path;
  const tmpExtract = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-full-'));
  try {
    await archive.extractZipSafe(tmpFile, tmpExtract, { maxTotalBytes: MAX_EXTRACTED_BYTES });
    const summary = await exportSvc.applyFullImport(tmpExtract, { user: req.user.username });
    res.json({
      ok: true,
      summary,
      reload: true
    });
  } catch (e) {
    res.status(importStatus(e)).json({ error: sanitizeLogText(e.message) });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (_) {}
  }
});

module.exports = router;
