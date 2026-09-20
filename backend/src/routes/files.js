'use strict';
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

const { requireAuth }                      = require('../middleware/auth.middleware');
const { sanitizeBotName, safeFilePath }    = require('../middleware/security');
const fsService                            = require('../services/fs.service');

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 20 } });

// Helper: resolve a file path safely from request
function resolveFile(botName, rawPath) {
  const bPath   = fsService.botPath(botName);
  const relPath = rawPath.replace(/^\/opt\/[^/]+\/?/, '').replace(/^\//, '');
  const safe    = safeFilePath(botName, relPath);
  return safe;
}

// GET /api/files/:bot/tree
router.get('/:bot/tree', (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const dir = fsService.botPath(safeName);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Bot introuvable' });

  res.json({ name: safeName, path: dir, children: fsService.listDirectory(dir) });
});

// GET /api/files/:bot/read?path=...
router.get('/:bot/read', (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const filePath = resolveFile(safeName, req.query.path || '');
  if (!filePath) return res.status(403).json({ error: 'Accès refusé ou extension non autorisée' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Fichier introuvable' });

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'Fichier trop volumineux (max 2 Mo)' });
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content, name: path.basename(filePath), path: filePath, size: stat.size, ext: path.extname(filePath) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/files/:bot/write
router.put('/:bot/write', (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const { path: rawPath, content } = req.body;
  if (!rawPath || content === undefined) return res.status(400).json({ error: 'Chemin ou contenu manquant' });

  const filePath = resolveFile(safeName, rawPath);
  if (!filePath) return res.status(403).json({ error: 'Accès refusé' });

  try {
    fsService.writeFile(filePath, content);
    res.json({ message: 'Sauvegardé', path: filePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:bot/create
router.post('/:bot/create', (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const { name, type = 'file', parentPath = '' } = req.body;
  if (!name || /[/\\<>:"|?*\x00-\x1f]/.test(name)) return res.status(400).json({ error: 'Nom de fichier invalide' });

  const bPath    = fsService.botPath(safeName);
  const relParent = (parentPath || '').replace(/^\/opt\/[^/]+\/?/, '');
  const targetDir = path.resolve(bPath, relParent);
  if (!targetDir.startsWith(bPath)) return res.status(403).json({ error: 'Accès refusé' });

  const targetPath = path.join(targetDir, name);
  if (!targetPath.startsWith(bPath)) return res.status(403).json({ error: 'Accès refusé' });

  try {
    if (type === 'dir') {
      fs.mkdirSync(targetPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, '', 'utf8');
    }
    res.json({ message: 'Créé', path: targetPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/files/:bot/delete?path=...
router.delete('/:bot/delete', (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const bPath    = fsService.botPath(safeName);
  const rawPath  = req.query.path || '';
  const relPath  = rawPath.replace(/^\/opt\/[^/]+\/?/, '').replace(/^\//, '');
  const safePath = path.resolve(bPath, relPath);

  // Must be inside bot directory and not root
  if (!safePath.startsWith(bPath + path.sep) || safePath === bPath) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  try {
    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) fs.rmSync(safePath, { recursive: true, force: true });
    else fs.unlinkSync(safePath);
    res.json({ message: 'Supprimé' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:bot/rename
router.post('/:bot/rename', (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const { oldPath, newName } = req.body;
  if (!oldPath || !newName || /[/\\<>:"|?*\x00-\x1f]/.test(newName)) return res.status(400).json({ error: 'Paramètres invalides' });

  const bPath   = fsService.botPath(safeName);
  const relOld  = oldPath.replace(/^\/opt\/[^/]+\/?/, '');
  const oldFull = path.resolve(bPath, relOld);
  const newFull = path.join(path.dirname(oldFull), newName);

  if (!oldFull.startsWith(bPath + path.sep) || !newFull.startsWith(bPath + path.sep)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  try {
    fs.renameSync(oldFull, newFull);
    res.json({ message: 'Renommé', newPath: newFull });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:bot/upload
router.post('/:bot/upload', upload.array('files', 20), (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const bPath     = fsService.botPath(safeName);
  const rawTarget = req.body.targetDir || '';
  const relTarget = rawTarget.replace(/^\/opt\/[^/]+\/?/, '');
  const uploadDir = path.resolve(bPath, relTarget);
  if (!uploadDir.startsWith(bPath)) return res.status(403).json({ error: 'Accès refusé' });

  const uploaded = [], errors = [];
  for (const file of req.files || []) {
    const safeFname = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = path.join(uploadDir, safeFname);
    if (!dest.startsWith(bPath)) { errors.push({ name: file.originalname, error: 'Accès refusé' }); continue; }
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(dest, file.buffer);
      uploaded.push({ name: safeFname, path: dest, size: file.size });
    } catch (e) {
      errors.push({ name: file.originalname, error: e.message });
    }
  }
  res.json({ uploaded, errors });
});

module.exports = router;
