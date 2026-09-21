'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { execFileSync } = require('child_process');

const { requireAuth }                          = require('../middleware/auth.middleware');
const { sanitizeBotName, safeFilePath, SAFE_ENV } = require('../middleware/security');
const { getDb }                                = require('../db/db');
const pm2Service                               = require('../services/pm2.service');
const fsService                                = require('../services/fs.service');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/bots ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db   = getDb();
    const bots = db.getAllBots();

    let pm2List = [];
    try { pm2List = await pm2Service.list(); } catch (e) {
      console.warn('[bots] PM2 list error:', e.message);
    }

    const pm2Map = {};
    for (const p of pm2List) pm2Map[p.name] = pm2Service.formatProcess(p);

    const result = bots.map(bot => ({
      ...bot,
      pm2:    pm2Map[bot.name] || null,
      exists: fs.existsSync(fsService.botPath(bot.name))
    }));

    res.json(result);
  } catch (e) {
    console.error('[bots] GET /:', e.message);
    res.status(500).json({ error: 'Impossible de récupérer la liste des bots.' });
  }
});

// ── POST /api/bots ────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    name,
    token,
    templateId = 'discordjs-blank',
    extraPackages = [],
    envVars = {},
    description = '',
    language = 'en'
  } = req.body;

  const safeName = sanitizeBotName(name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide (minuscules, chiffres, tirets, 2-64 chars)' });
  if (!token || token.trim().length < 20) return res.status(400).json({ error: 'Token Discord invalide (trop court)' });

  const db = getDb();
  if (db.getBot(safeName)) return res.status(409).json({ error: `Le bot "${safeName}" existe déjà` });

  try {
    await fsService.createBot({
      name: safeName,
      token: token.trim(),
      templateId,
      extraPackages,
      envVars,
      language
    });
    const bot = db.createBot({ name: safeName, description, templateId, language });
    db.logActivity({ action: 'bot_created', bot_name: safeName, user: req.user.username, details: `Template: ${templateId} (lang=${language})` });
    res.status(201).json({ message: `Bot "${safeName}" créé avec succès`, bot });
  } catch (e) {
    // Cleanup partial dir if creation failed
    try { fsService.deleteBot(safeName); } catch (_) {}
    try { db.deleteBot(safeName); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/bots/:name ───────────────────────────────────
router.get('/:name', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const db  = getDb();
  const bot = db.getBot(safeName);
  if (!bot) return res.status(404).json({ error: 'Bot introuvable' });

  const bPath = fsService.botPath(safeName);
  let pm2Info = null, packageJson = null, files = [];

  try { pm2Info = pm2Service.formatProcess(await pm2Service.describe(safeName)); } catch (_) {}
  try { files   = fsService.listDirectory(bPath); } catch (_) {}
  try { packageJson = JSON.parse(fs.readFileSync(path.join(bPath, 'package.json'), 'utf8')); } catch (_) {}

  res.json({ ...bot, pm2: pm2Info, files, packageJson, path: bPath, exists: fs.existsSync(bPath) });
});

// ── PATCH /api/bots/:name ─────────────────────────────────
router.patch('/:name', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const db  = getDb();
  const bot = db.getBot(safeName);
  if (!bot) return res.status(404).json({ error: 'Bot introuvable' });

  const allowed = ['description', 'notes'];
  const patch   = {};
  for (const k of allowed) { if (req.body[k] !== undefined) patch[k] = req.body[k]; }

  const updated = db.updateBot(safeName, patch);
  res.json(updated);
});

// ── DELETE /api/bots/:name ────────────────────────────────
router.delete('/:name', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const db  = getDb();
  const bot = db.getBot(safeName);
  if (!bot) return res.status(404).json({ error: 'Bot introuvable' });

  try {
    // Stop & remove from PM2 (non-fatal)
    try { await pm2Service.remove(safeName); } catch (_) {}
    // Delete files
    fsService.deleteBot(safeName);
    db.deleteBot(safeName);
    db.logActivity({ action: 'bot_deleted', bot_name: safeName, user: req.user.username });
    res.json({ message: `Bot "${safeName}" supprimé` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/bots/:name/start ────────────────────────────
router.post('/:name/start', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const bPath = fsService.botPath(safeName);
  if (!fs.existsSync(bPath))           return res.status(404).json({ error: 'Dossier du bot introuvable' });
  if (!fs.existsSync(path.join(bPath, 'index.js'))) return res.status(400).json({ error: 'Fichier index.js manquant' });

  try {
    await pm2Service.start(safeName, bPath);
    getDb().updateBot(safeName, { last_started: new Date().toISOString() });
    getDb().logActivity({ action: 'bot_started', bot_name: safeName, user: req.user.username });
    res.json({ message: `Bot "${safeName}" démarré` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/bots/:name/stop ─────────────────────────────
router.post('/:name/stop', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  try {
    await pm2Service.stop(safeName);
    getDb().logActivity({ action: 'bot_stopped', bot_name: safeName, user: req.user.username });
    res.json({ message: `Bot "${safeName}" arrêté` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/bots/:name/restart ──────────────────────────
router.post('/:name/restart', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  try {
    await pm2Service.restart(safeName);
    getDb().logActivity({ action: 'bot_restarted', bot_name: safeName, user: req.user.username });
    res.json({ message: `Bot "${safeName}" redémarré` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/bots/:name/pm2 ───────────────────────────────
router.get('/:name/pm2', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  try {
    const proc = await pm2Service.describe(safeName);
    res.json(pm2Service.formatProcess(proc));
  } catch (_) { res.json(null); }
});

// ── GET /api/bots/:name/logs ──────────────────────────────
router.get('/:name/logs', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  const lines = Math.min(parseInt(req.query.lines) || 100, 500);
  try {
    const logs = await pm2Service.getLogs(safeName, lines);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/bots/:name/npm ───────────────────────────────
router.get('/:name/npm', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  const pkgPath = path.join(fsService.botPath(safeName), 'package.json');
  if (!fs.existsSync(pkgPath)) return res.status(404).json({ error: 'package.json introuvable' });
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    res.json({ dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {}, scripts: pkg.scripts || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/bots/:name/npm/install ─────────────────────
router.post('/:name/npm/install', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const { packages, dev = false } = req.body;
  if (!Array.isArray(packages) || packages.length === 0) return res.status(400).json({ error: 'Packages manquants' });

  const valid = packages.filter(p => /^[a-zA-Z0-9@/_.-]{1,100}$/.test(p));
  if (valid.length === 0) return res.status(400).json({ error: 'Noms invalides' });

  const dir = fsService.botPath(safeName);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Bot introuvable' });

  try {
    const flag = dev ? '--save-dev' : '--save';
    const args = ['install', ...valid, flag, '--loglevel=warn'];
    const out  = execFileSync('npm', args, {
      cwd: dir, timeout: 120000, env: SAFE_ENV, encoding: 'utf8', shell: false
    });
    res.json({ message: `Installé : ${valid.join(', ')}`, output: out });
  } catch (e) {
    res.status(500).json({ error: `npm install échoué : ${e.message.split('\n')[0]}`, output: e.stdout || '' });
  }
});

// ── DELETE /api/bots/:name/npm/:pkg ──────────────────────
router.delete('/:name/npm/:pkg', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const pkg = req.params.pkg;
  if (!/^[a-zA-Z0-9@/_.-]{1,100}$/.test(pkg)) return res.status(400).json({ error: 'Package invalide' });

  const dir = fsService.botPath(safeName);
  try {
    execFileSync('npm', ['uninstall', pkg, '--save', '--loglevel=warn'], {
      cwd: dir, timeout: 60000, env: SAFE_ENV, shell: false
    });
    res.json({ message: `Désinstallé : ${pkg}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
