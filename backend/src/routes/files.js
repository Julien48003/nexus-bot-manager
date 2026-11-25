'use strict';
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const archiver = require('archiver');

const { requireAuth, requireAdmin }        = require('../middleware/auth.middleware');
const {
  sanitizeBotName, safeFilePath, isInside, isInsideOrEqual, isInsideReal,
  isValidFileName, sanitizeLogText
} = require('../middleware/security');
const fsService                            = require('../services/fs.service');

const router = express.Router();
router.use(requireAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 20 } });

// Helper: turn any accepted path shape (relative, absolute under the bot,
// or a legacy /opt/<bot>/... path) into a bot-relative path. Returns null
// when an absolute path points outside the bot.
function toRelative(botName, rawPath) {
  const bPath = fsService.botPath(botName);
  const raw = String(rawPath || '');
  if (!raw) return '';
  const resolved = path.resolve(raw);
  if (path.isAbsolute(raw)) {
    if (resolved === bPath) return '';
    if (resolved.startsWith(bPath + path.sep)) return path.relative(bPath, resolved);
    const legacy = raw.replace(/^\/opt\/[^/]+\/?/, '');
    return legacy !== raw ? legacy.replace(/^\//, '') : null;
  }
  return raw.replace(/^\//, '');
}

// Helper: resolve a file path safely from request
function resolveFile(botName, rawPath) {
  const bPath = fsService.botPath(botName);
  const relPath = toRelative(botName, rawPath);
  if (relPath === null) return null;
  const safe = safeFilePath(botName, relPath);
  if (!safe) return null;
  // FILE-03: a textual path can be contained while a symlink inside the
  // bot directory points somewhere else entirely. Re-check after
  // resolving links, on the part of the chain that already exists.
  if (!isInsideReal(bPath, safe)) return null;
  return safe;
}

// Resolve a directory inside a bot (root allowed). No extension filter:
// the Drive page manages every file, the editor keeps its text allowlist.
function resolveDir(botName, rawPath) {
  const bPath = fsService.botPath(botName);
  const rel = toRelative(botName, rawPath);
  if (rel === null || /%2e|%2f|%5c/i.test(rel)) return { forbidden: true };
  const dir = path.resolve(bPath, rel);
  if (!isInsideOrEqual(bPath, dir)) return { forbidden: true };
  if (!isInsideReal(bPath, dir)) return { forbidden: true };
  let stat;
  try { stat = fs.lstatSync(dir); } catch (_) { return { missing: true }; }
  if (stat.isSymbolicLink()) return { forbidden: true };
  if (!stat.isDirectory()) return { missing: true };
  return { bPath, dir, rel: rel.replace(/\\/g, '/') };
}

function resolveAny(botName, rawPath) {
  const bPath = fsService.botPath(botName);
  const rel = toRelative(botName, rawPath);
  if (rel === null || !rel || /%2e|%2f|%5c/i.test(rel)) return { forbidden: true };
  const full = path.resolve(bPath, rel);
  if (!isInside(bPath, full)) return { forbidden: true };
  if (!isInsideReal(bPath, full)) return { forbidden: true };
  let stat;
  try { stat = fs.lstatSync(full); } catch (_) { return { missing: true }; }
  if (stat.isSymbolicLink()) return { forbidden: true };
  return { bPath, full, rel: rel.replace(/\\/g, '/'), stat };
}

// GET /api/files/:bot/tree
router.get('/:bot/tree', (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const dir = fsService.botPath(safeName);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Bot introuvable' });

  res.json({ name: safeName, path: dir, children: fsService.listDirectory(dir) });
});

// GET /api/files/:bot/list?path=...
// One directory level, with relative paths, for the Drive-style page.
router.get('/:bot/list', (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const target = resolveDir(safeName, req.query.path || '');
  if (target.forbidden) return res.status(403).json({ error: 'Accès refusé' });
  if (target.missing) return res.status(404).json({ error: 'Dossier introuvable' });

  try {
    const entries = [];
    for (const entry of fs.readdirSync(target.dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(target.dir, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch (_) { continue; }
      if (stat.isSymbolicLink()) continue;
      const rel = path.relative(target.bPath, full).replace(/\\/g, '/');
      entries.push({
        name: entry.name,
        type: stat.isDirectory() ? 'dir' : 'file',
        size: stat.isDirectory() ? 0 : stat.size,
        mtime: stat.mtimeMs,
        hidden: entry.name.startsWith('.'),
        rel,
        absPath: full
      });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: target.rel, root: target.bPath, entries });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// GET /api/files/:bot/download?path=...
// A single file, or a folder as a zip (node_modules and .git excluded).
router.get('/:bot/download', (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const source = resolveAny(safeName, req.query.path || '');
  if (source.forbidden) return res.status(403).json({ error: 'Accès refusé' });
  if (source.missing) return res.status(404).json({ error: 'Fichier introuvable' });

  res.setHeader('Cache-Control', 'no-store');
  if (!source.stat.isDirectory()) {
    return res.download(source.full, path.basename(source.full), err => {
      if (err && !res.headersSent) res.status(500).end();
    });
  }

  const zipName = `${path.basename(source.full) || safeName}.zip`;
  res.attachment(zipName);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', () => {});
  archive.on('error', () => { try { res.destroy(); } catch (_) {} });
  archive.pipe(res);
  archive.glob('**/*', {
    cwd: source.full,
    dot: true,
    ignore: ['node_modules/**', '.git/**']
  });
  archive.finalize().catch(() => { try { res.destroy(); } catch (_) {} });
});
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

  const target = resolveDir(safeName, parentPath);
  if (target.forbidden) return res.status(403).json({ error: 'Accès refusé' });
  if (target.missing) return res.status(404).json({ error: 'Dossier introuvable' });
  const bPath = target.bPath;
  const targetPath = path.join(target.dir, name);
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

  const source = resolveAny(safeName, req.query.path || '');
  if (source.forbidden) return res.status(403).json({ error: 'Accès refusé' });
  if (source.missing) return res.status(404).json({ error: 'Fichier introuvable' });

  try {
    if (source.stat.isDirectory()) fs.rmSync(source.full, { recursive: true, force: true });
    else fs.unlinkSync(source.full);
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

  const source = resolveAny(safeName, oldPath);
  if (source.forbidden) return res.status(403).json({ error: 'Accès refusé' });
  if (source.missing) return res.status(404).json({ error: 'Fichier introuvable' });
  const newFull = path.join(path.dirname(source.full), newName);

  if (!isInside(source.bPath, newFull) || !isInsideReal(source.bPath, newFull)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  if (fs.existsSync(newFull)) return res.status(409).json({ error: 'Une entrée porte déjà ce nom' });

  try {
    fs.renameSync(source.full, newFull);
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

  const target = resolveDir(safeName, req.body.targetDir || '');
  if (target.forbidden) return res.status(403).json({ error: 'Accès refusé' });
  if (target.missing) return res.status(404).json({ error: 'Dossier introuvable' });

  const bPath = target.bPath;
  const uploadDir = target.dir;
  const uploaded = [], errors = [];
  for (const file of req.files || []) {
    const safeFname = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!safeFname || safeFname === '.' || safeFname === '..') {
      errors.push({ name: sanitizeLogText(file.originalname), error: 'Nom invalide' });
      continue;
    }
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

// POST /api/files/:bot/move
// Move files/folders into another folder within the same bot (drag & drop).
router.post('/:bot/move', requireAdmin, (req, res) => {
  const safeName = sanitizeBotName(req.params.bot);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const body = req.body || {};
  const items = Array.isArray(body.items)
    ? body.items
    : (body.from !== undefined ? [{ from: body.from, toDir: body.toDir }] : []);
  if (!items.length || items.length > 100) return res.status(400).json({ error: 'Liste de déplacements invalide' });

  const moved = [], errors = [];
  for (const item of items) {
    const from = String(item?.from || '');
    const toDir = String(item?.toDir || '');
    const source = resolveAny(safeName, from);
    const target = resolveDir(safeName, toDir);
    if (!source || source.missing) { errors.push({ from, error: 'Source introuvable' }); continue; }
    if (source.forbidden) { errors.push({ from, error: 'Accès refusé' }); continue; }
    if (!target || target.missing) { errors.push({ from, error: 'Dossier cible introuvable' }); continue; }
    if (target.forbidden) { errors.push({ from, error: 'Accès refusé' }); continue; }

    const dest = path.join(target.dir, path.basename(source.full));
    if (dest === source.full) { moved.push({ from, to: dest, unchanged: true }); continue; }
    if (source.stat.isDirectory() && isInsideOrEqual(source.full, target.dir)) {
      errors.push({ from, error: 'Impossible de déplacer un dossier dans lui-même' });
      continue;
    }
    if (!isInside(source.bPath, dest) || !isInsideReal(source.bPath, dest)) {
      errors.push({ from, error: 'Accès refusé' });
      continue;
    }
    if (fs.existsSync(dest)) { errors.push({ from, error: 'Une entrée porte déjà ce nom' }); continue; }

    try {
      fs.renameSync(source.full, dest);
      if (path.basename(dest) === '.env') {
        try { fs.chmodSync(dest, 0o600); } catch (_) {}
      }
      moved.push({ from, to: dest });
    } catch (e) {
      errors.push({ from, error: sanitizeLogText(e.message) });
    }
  }
  res.json({ moved, errors });
});

module.exports = router;
