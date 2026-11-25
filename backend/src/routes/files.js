'use strict';
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

const { requireAuth, requireAdmin }        = require('../middleware/auth.middleware');
const {
  sanitizeBotName, safeFilePath, isInside, isInsideOrEqual, isInsideReal,
  isValidFileName, sanitizeLogText
} = require('../middleware/security');
const fsService                            = require('../services/fs.service');

const router = express.Router();
router.use(requireAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 20 } });

// Helper: resolve a file path safely from request
function resolveFile(botName, rawPath) {
  const bPath   = fsService.botPath(botName);
  const relPath = String(rawPath).replace(/^\/opt\/[^/]+\/?/, '').replace(/^\//, '');
  const safe    = safeFilePath(botName, relPath);
  if (!safe) return null;
  // FILE-03: a textual path can be contained while a symlink inside the
  // bot directory points somewhere else entirely. Re-check after
  // resolving links, on the part of the chain that already exists.
  if (!isInsideReal(bPath, safe)) return null;
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
    const stat = fs.lstatSync(filePath);
    // A symlink must not be used as an indirection (FILE-03). lstat, not
    // stat: stat follows links and would report the target instead.
    if (stat.isSymbolicLink()) return res.status(403).json({ error: 'Accès refusé' });
    if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'Fichier trop volumineux (max 2 Mo)' });
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content, name: path.basename(filePath), path: filePath, size: stat.size, ext: path.extname(filePath) });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// PUT /api/files/:bot/write
// CMD-01: writing arbitrary .js is equivalent to choosing what PM2 will
// execute. The endpoint now requires the admin role.
router.put('/:bot/write', requireAdmin, (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const { path: rawPath, content } = req.body || {};
  if (!rawPath || content === undefined) return res.status(400).json({ error: 'Chemin ou contenu manquant' });

  // Reject absurdly large content (server-side guard)
  if (typeof content === 'string' && Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
    return res.status(413).json({ error: 'Contenu trop volumineux (max 2 Mo)' });
  }

  const filePath = resolveFile(safeName, rawPath);
  if (!filePath) return res.status(403).json({ error: 'Accès refusé' });

  try {
    fsService.writeFile(filePath, content);
    res.json({ message: 'Sauvegardé', path: filePath });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// POST /api/files/:bot/create
router.post('/:bot/create', requireAdmin, (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const { name, type = 'file', parentPath = '' } = req.body || {};
  // XSS-02: `'` and backtick are refused in stored file names.
  if (!isValidFileName(name)) return res.status(400).json({ error: 'Nom de fichier invalide' });

  const bPath    = fsService.botPath(safeName);
  const relParent = String(parentPath || '').replace(/^\/opt\/[^/]+\/?/, '');
  const targetDir = path.resolve(bPath, relParent);
  // FILE-02: the previous test was `targetDir.startsWith(bPath)`, which
  // also accepts /opt/monbot2 for a bot in /opt/monbot. isInside()
  // appends path.sep, and the base directory itself is accepted here
  // because creating a file directly in the bot folder is legitimate.
  if (!isInsideOrEqual(bPath, targetDir)) return res.status(403).json({ error: 'Accès refusé' });
  if (!isInsideReal(bPath, targetDir))     return res.status(403).json({ error: 'Accès refusé' });

  const targetPath = path.join(targetDir, name);
  if (!isInside(bPath, targetPath))       return res.status(403).json({ error: 'Accès refusé' });
  if (!isInsideReal(bPath, targetPath))   return res.status(403).json({ error: 'Accès refusé' });

  try {
    if (type === 'dir') {
      fs.mkdirSync(targetPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      // Use wx flag for atomic create-only (avoids race condition)
      try {
        fs.writeFileSync(targetPath, '', {
          encoding: 'utf8',
          flag: 'wx',
          mode: path.basename(targetPath) === '.env' ? 0o600 : 0o644
        });
      } catch (e) {
        if (e.code === 'EEXIST') return res.status(409).json({ error: 'Le fichier existe déjà' });
        throw e;
      }
    }
    res.json({ message: 'Créé', path: targetPath });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// DELETE /api/files/:bot/delete?path=...
router.delete('/:bot/delete', requireAdmin, (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const bPath    = fsService.botPath(safeName);
  const rawPath  = req.query.path || '';
  const relPath  = String(rawPath).replace(/^\/opt\/[^/]+\/?/, '').replace(/^\//, '');
  const safePath = path.resolve(bPath, relPath);

  // Must be inside bot directory and not root
  if (!isInside(bPath, safePath) || !isInsideReal(bPath, safePath)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  try {
    const stat = fs.lstatSync(safePath);
    if (stat.isSymbolicLink()) fs.unlinkSync(safePath);
    else if (stat.isDirectory()) fs.rmSync(safePath, { recursive: true, force: true });
    else fs.unlinkSync(safePath);
    res.json({ message: 'Supprimé' });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// POST /api/files/:bot/rename
router.post('/:bot/rename', requireAdmin, (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const { oldPath, newName } = req.body || {};
  if (!oldPath || !isValidFileName(newName)) return res.status(400).json({ error: 'Paramètres invalides' });

  const bPath   = fsService.botPath(safeName);
  const relOld  = String(oldPath).replace(/^\/opt\/[^/]+\/?/, '');
  const oldFull = path.resolve(bPath, relOld);
  const newFull = path.join(path.dirname(oldFull), newName);

  if (!isInside(bPath, oldFull) || !isInside(bPath, newFull)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  if (!isInsideReal(bPath, oldFull) || !isInsideReal(bPath, newFull)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  try {
    fs.renameSync(oldFull, newFull);
    if (path.basename(newFull) === '.env') {
      try { fs.chmodSync(newFull, 0o600); } catch (_) {}
    }
    res.json({ message: 'Renommé', newPath: newFull });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// POST /api/files/:bot/upload
router.post('/:bot/upload', requireAdmin, upload.array('files', 20), (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const bPath     = fsService.botPath(safeName);
  const rawTarget = req.body.targetDir || '';
  const relTarget = String(rawTarget).replace(/^\/opt\/[^/]+\/?/, '');
  const uploadDir = path.resolve(bPath, relTarget);
  // FILE-01: the previous test was `uploadDir.startsWith(bPath)` without
  // path.sep, so targetDir="../monbot2" escaped into a sibling bot.
  if (!isInsideOrEqual(bPath, uploadDir)) return res.status(403).json({ error: 'Accès refusé' });
  if (!isInsideReal(bPath, uploadDir))     return res.status(403).json({ error: 'Accès refusé' });

  const uploaded = [], errors = [];
  for (const file of req.files || []) {
    const safeFname = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = path.extname(safeFname).toLowerCase();
    const allowed = ['.js', '.ts', '.mjs', '.cjs', '.json', '.env', '.md', '.txt', '.yaml', '.yml', '.sh', '.log', '.gitignore', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'];
    if (ext && !allowed.includes(ext)) { errors.push({ name: sanitizeLogText(file.originalname), error: 'Extension non autorisée' }); continue; }
    const dest = path.join(uploadDir, safeFname);
    if (!isInside(bPath, dest) || !isInsideReal(bPath, dest)) {
      errors.push({ name: sanitizeLogText(file.originalname), error: 'Accès refusé' });
      continue;
    }
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(dest, file.buffer);
      if (path.basename(dest) === '.env') {
        try { fs.chmodSync(dest, 0o600); } catch (_) {}
      }
      uploaded.push({ name: safeFname, path: dest, size: file.size });
    } catch (e) {
      errors.push({ name: sanitizeLogText(file.originalname), error: sanitizeLogText(e.message) });
    }
  }
  res.json({ uploaded, errors });
});

module.exports = router;
