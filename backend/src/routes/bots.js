'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { execFileSync } = require('child_process');

const { requireAuth, requireAdmin, requireBotAccess } = require('../middleware/auth.middleware');
const { sanitizeBotName, safeFilePath, isValidPackageName, SAFE_ENV, sanitizeLogText, redactSecrets, isSafeRelativePath } = require('../middleware/security');
const { getDb }                                = require('../db/db');
const pm2Service                               = require('../services/pm2.service');
const fsService                                = require('../services/fs.service');
const snapshotService                          = require('../services/snapshot.service');
const { canAccessBot }                         = require('../services/user.service');

const router = express.Router();
router.use(requireAuth);

// CMD-03: package lifecycle scripts run arbitrary code with the
// privileges of the backend process, and the environment they inherit
// used to contain the JWT signing secret. --ignore-scripts removes the
// script execution; SAFE_ENV additionally keeps the secret out of the
// few children that still need an environment.
const NPM_COMMON_ARGS = ['--no-audit', '--no-fund', '--loglevel=warn', '--ignore-scripts'];

function normalizeStartupFile(value) {
  const clean = String(value || '').trim().replace(/^\.\//, '');
  if (!clean || !/\.(js|mjs|cjs)$/i.test(clean)) return null;
  if (!isSafeRelativePath(clean)) return null;
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
  if (raw.length > 100) return { invalid: true };
  const fields = raw.split(/\s+/);
  if (fields.length !== 5) return { invalid: true };
  if (!fields.every(f => /^[0-9*/,.-]+$/.test(f))) return { invalid: true };
  return { value: raw };
}

function normalizeDisplayName(value) {
  const clean = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean || clean.length > 80) return null;
  return clean;
}

function normalizeAvatar(value) {
  if (value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { invalid: true };
  if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)) return { invalid: true };
  if (value.length > 750000) return { invalid: true };
  return { value };
}

function serializeSnapshot(s) {
  return {
    id:         s.id,
    bot_name:   s.bot_name,
    label:      s.label,
    size_bytes: s.size_bytes,
    created_by: s.created_by,
    created_at: s.created_at
  };
}

// -- GET /api/bots -----------------------------------------
router.get('/', async (req, res) => {
  try {
    const db   = getDb();
    const user = req.dbUser;
    if (user.role !== 'admin' && user.role !== 'user') {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const bots = user.role === 'admin'
      ? db.getAllBots()
      : db.getAllBots().filter(bot => canAccessBot(user, bot.name));

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

// -- POST /api/bots ----------------------------------------
router.post('/', requireAdmin, async (req, res) => {
  const {
    name,
    token,
    source = 'template',
    repoUrl,
    branch = '',
    displayName,
    templateId = 'discordjs-blank',
    extraPackages = [],
    envVars = {},
    description = '',
    language = 'en',
    autostart = false,
    startupFile = 'index.js',
    memoryLimit = null,
    restartCron = null,
    exposeOnMcp = false
  } = req.body || {};

  const safeName = sanitizeBotName(name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide (minuscules, chiffres, tirets, 2-64 chars)' });
  if (!token || String(token).trim().length < 20) return res.status(400).json({ error: 'Token Discord invalide (trop court)' });

  const isGithub = source === 'github';
  if (isGithub && !fsService.parseGitHubUrl(repoUrl)) {
    return res.status(400).json({ error: 'URL GitHub invalide. Utilisez https://github.com/utilisateur/depot' });
  }
  if (isGithub && branch && fsService.normalizeBranch(branch) === null) {
    return res.status(400).json({ error: 'Nom de branche invalide' });
  }

  const entry = isGithub ? 'index.js' : normalizeStartupFile(startupFile);
  if (!isGithub && !entry) return res.status(400).json({ error: 'Fichier de démarrage invalide' });
  const mem = normalizeMemoryLimit(memoryLimit);
  if (mem.invalid) return res.status(400).json({ error: 'Limite mémoire invalide (64-8192 Mo)' });
  const cron = normalizeRestartCron(restartCron);
  if (cron.invalid) return res.status(400).json({ error: 'Planification de redémarrage invalide (cron 5 champs)' });
  const display = displayName ? normalizeDisplayName(displayName) : null;
  if (displayName && !display) return res.status(400).json({ error: 'Nom affiché invalide (1-80 caractères)' });

  if (!Array.isArray(extraPackages)) return res.status(400).json({ error: 'Liste de paquets invalide' });
  const badPkg = extraPackages.find(p => !isValidPackageName(String(p)));
  if (badPkg) return res.status(400).json({ error: `Nom de paquet invalide : ${sanitizeLogText(String(badPkg), 40)}` });

  const db = getDb();
  if (db.getBot(safeName)) return res.status(409).json({ error: `Le bot "${safeName}" existe déjà` });

  try {
    let importedEntry = null;
    if (isGithub) {
      const imported = await fsService.importFromGitHub({
        name: safeName,
        repoUrl,
        branch,
        token: String(token).trim(),
        language
      });
      importedEntry = imported.entry;
    } else {
      await fsService.createBot({
        name: safeName,
        token: String(token).trim(),
        templateId,
        extraPackages: extraPackages.map(String),
        envVars,
        language
      });
    }

    const bot = db.createBot({
      name: safeName,
      display_name: display || safeName,
      description,
      template: isGithub ? 'github' : templateId,
      language,
      autostart: autostart === true,
      startup_file: isGithub ? importedEntry : entry,
      memory_limit: mem.value,
      restart_cron: cron.value,
      mcp_exposed: exposeOnMcp === true
    });
    db.logActivity({
      action: isGithub ? 'bot_imported' : 'bot_created',
      bot_name: safeName,
      user: req.user.username,
      details: isGithub ? `GitHub: ${fsService.parseGitHubUrl(repoUrl).url}` : `Template: ${templateId} (lang=${language})`
    });
    res.status(201).json({
      message: isGithub ? `Bot "${safeName}" importé depuis GitHub` : `Bot "${safeName}" créé avec succès`,
      bot
    });
  } catch (e) {
    // Cleanup partial dir if creation failed
    try { fsService.deleteBot(safeName); } catch (_) {}
    try { db.deleteBot(safeName); } catch (_) {}
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// Every route below is scoped to one bot: admins, or an account whose
// allowlist contains it. The check happens before the bot is revealed.
router.use('/:name', requireBotAccess('name'));

// -- GET /api/bots/:name -----------------------------------
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

// -- GET /api/bots/:name/snapshots -------------------------
router.get('/:name/snapshots', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  res.json(getDb().getSnapshots(safeName).map(serializeSnapshot));
});

// -- POST /api/bots/:name/snapshots ------------------------
router.post('/:name/snapshots', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  const label = String((req.body && req.body.label) || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  try {
    const shot = await snapshotService.createSnapshot({
      botName: safeName,
      label,
      user: req.user.username
    });
    res.status(201).json(serializeSnapshot(shot));
  } catch (e) {
    const status = e.code === 'SNAPSHOT_LIMIT' ? 409
      : e.code === 'BOT_NOT_FOUND' ? 404
      : ['SNAPSHOT_TOO_LARGE', 'SNAPSHOT_EMPTY'].includes(e.code) ? 400
      : 500;
    res.status(status).json({ error: sanitizeLogText(e.message) });
  }
});

// -- POST /api/bots/:name/snapshots/:id/restore ------------
router.post('/:name/snapshots/:id/restore', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });
  try {
    await snapshotService.restoreSnapshot({ botName: safeName, id, user: req.user.username });
    res.json({ message: 'Snapshot restauré' });
  } catch (e) {
    const status = ['SNAPSHOT_NOT_FOUND', 'BOT_NOT_FOUND'].includes(e.code) ? 404
      : ['ARCHIVE_UNSAFE', 'ARCHIVE_INVALID'].includes(e.code) || /snapshot est vide/i.test(e.message) ? 400
      : 500;
    res.status(status).json({ error: sanitizeLogText(e.message) });
  }
});

// -- DELETE /api/bots/:name/snapshots/:id ------------------
router.delete('/:name/snapshots/:id', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });
  const ok = snapshotService.deleteSnapshot(safeName, id);
  if (!ok) return res.status(404).json({ error: 'Snapshot introuvable' });
  getDb().logActivity({ action: 'bot_snapshot_deleted', bot_name: safeName, user: req.user.username });
  res.json({ ok: true });
});

// -- PATCH /api/bots/:name ---------------------------------
router.patch('/:name', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const db  = getDb();
  const bot = db.getBot(safeName);
  if (!bot) return res.status(404).json({ error: 'Bot introuvable' });

  const body = req.body || {};
  const patch = {};

  if (body.description !== undefined) patch.description = String(body.description).slice(0, 2000);
  if (body.notes !== undefined)       patch.notes = String(body.notes).slice(0, 4000);

  if (body.display_name !== undefined) {
    const display = normalizeDisplayName(body.display_name);
    if (!display) return res.status(400).json({ error: 'Nom affiché invalide (1-80 caractères)' });
    patch.display_name = display;
  }
  if (body.avatar !== undefined) {
    const av = normalizeAvatar(body.avatar);
    if (av.invalid) return res.status(400).json({ error: 'Avatar invalide (PNG/JPEG/WebP/GIF, max 512 Ko)' });
    patch.avatar = av.value;
  }
  if (body.autostart !== undefined) patch.autostart = body.autostart === true;
  if (body.mcp_exposed !== undefined) {
    // MCP exposure is a panel-wide security decision, not a bot edit.
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Seul un administrateur peut modifier l’exposition MCP' });
    }
    patch.mcp_exposed = body.mcp_exposed === true;
  }
  if (body.startup_file !== undefined) {
    const entry = normalizeStartupFile(body.startup_file);
    if (!entry) return res.status(400).json({ error: 'Fichier de démarrage invalide (.js/.mjs/.cjs)' });
    patch.startup_file = entry;
  }
  if (body.memory_limit !== undefined) {
    const mem = normalizeMemoryLimit(body.memory_limit);
    if (mem.invalid) return res.status(400).json({ error: 'Limite mémoire invalide (64-8192 Mo)' });
    patch.memory_limit = mem.value;
  }
  if (body.restart_cron !== undefined) {
    const cron = normalizeRestartCron(body.restart_cron);
    if (cron.invalid) return res.status(400).json({ error: 'Planification de redémarrage invalide (cron 5 champs)' });
    patch.restart_cron = cron.value;
  }

  const updated = db.updateBot(safeName, patch);
  db.logActivity({ action: 'bot_updated', bot_name: safeName, user: req.user.username });
  res.json(updated);
});

// -- DELETE /api/bots/:name --------------------------------
router.delete('/:name', requireAdmin, async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const db  = getDb();
  const bot = db.getBot(safeName);
  if (!bot) return res.status(404).json({ error: 'Bot introuvable' });

  try {
    // Stop & remove from PM2 (non-fatal)
    try { await pm2Service.remove(safeName); } catch (_) {}
    // Delete files and every server-side snapshot.
    fsService.deleteBot(safeName);
    try { snapshotService.deleteSnapshotsForBot(safeName); } catch (_) {}
    // A deleted bot must not linger in a regular account's allowlist.
    for (const u of db.getAllUsers()) {
      if (Array.isArray(u.allowed_bots) && u.allowed_bots.includes(safeName)) {
        db.updateUser(u.id, { allowed_bots: u.allowed_bots.filter(name => name !== safeName) });
      }
    }
    db.deleteBot(safeName);
    db.logActivity({ action: 'bot_deleted', bot_name: safeName, user: req.user.username });
    res.json({ message: `Bot "${safeName}" supprimé` });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// -- POST /api/bots/:name/start ----------------------------
router.post('/:name/start', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const bPath = fsService.botPath(safeName);
  if (!fs.existsSync(bPath))           return res.status(404).json({ error: 'Dossier du bot introuvable' });
  const bot = getDb().getBot(safeName) || {};
  let entry = bot.startup_file || 'index.js';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(bPath, 'package.json'), 'utf8'));
    if (!bot.startup_file && pkg.main) entry = String(pkg.main);
  } catch (_) {}
  if (!fs.existsSync(path.join(bPath, entry))) {
    return res.status(400).json({ error: `Fichier de démarrage "${entry}" introuvable` });
  }

  try {
    await pm2Service.start(safeName, bPath, {
      script: entry,
      maxMemory: bot.memory_limit,
      cronRestart: bot.restart_cron
    });
    getDb().updateBot(safeName, { last_started: new Date().toISOString() });
    getDb().logActivity({ action: 'bot_started', bot_name: safeName, user: req.user.username });
    res.json({ message: `Bot "${safeName}" démarré` });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// -- POST /api/bots/:name/stop -----------------------------
router.post('/:name/stop', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  try {
    await pm2Service.stop(safeName);
    getDb().logActivity({ action: 'bot_stopped', bot_name: safeName, user: req.user.username });
    res.json({ message: `Bot "${safeName}" arrêté` });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// -- POST /api/bots/:name/restart --------------------------
router.post('/:name/restart', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  try {
    await pm2Service.restart(safeName);
    getDb().logActivity({ action: 'bot_restarted', bot_name: safeName, user: req.user.username });
    res.json({ message: `Bot "${safeName}" redémarré` });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// -- GET /api/bots/:name/pm2 -------------------------------
router.get('/:name/pm2', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  try {
    const proc = await pm2Service.describe(safeName);
    res.json(pm2Service.formatProcess(proc));
  } catch (_) { res.json(null); }
});

// -- GET /api/bots/:name/logs ------------------------------
router.get('/:name/logs', async (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  const lines = Math.min(parseInt(req.query.lines) || 100, 500);
  try {
    const logs = await pm2Service.getLogs(safeName, lines);
    // CMD-05: never hand a Discord token / JWT to the browser, even on the
    // REST path (the Socket.IO path already redacts).
    logs.out = (logs.out || []).map(redactSecrets);
    logs.err = (logs.err || []).map(redactSecrets);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// -- GET /api/bots/:name/npm -------------------------------
router.get('/:name/npm', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  const pkgPath = path.join(fsService.botPath(safeName), 'package.json');
  if (!fs.existsSync(pkgPath)) return res.status(404).json({ error: 'package.json introuvable' });
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    res.json({ dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {}, scripts: pkg.scripts || {} });
  } catch (e) { res.status(500).json({ error: sanitizeLogText(e.message) }); }
});

// -- POST /api/bots/:name/npm/install ---------------------
router.post('/:name/npm/install', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const { packages, dev = false } = req.body || {};
  if (!Array.isArray(packages) || packages.length === 0) return res.status(400).json({ error: 'Packages manquants' });

  // CMD-02: the old regex /^[a-zA-Z0-9@/_.-]{1,100}$/ accepted
  // "--prefix=/tmp" or "--registry=http://evil", which npm happily
  // consumes as options, letting a request escape the bot sandbox and
  // rewrite arbitrary paths. isValidPackageName() forbids a leading
  // dash, path segments and the double dot.
  const valid = packages.map(String).filter(isValidPackageName);
  if (valid.length === 0 || valid.length !== packages.length) {
    return res.status(400).json({ error: 'Noms de paquets invalides' });
  }

  const dir = fsService.botPath(safeName);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Bot introuvable' });

  try {
    const flag = dev ? '--save-dev' : '--save';
    const args = ['install', ...valid, flag, ...NPM_COMMON_ARGS];
    const out  = execFileSync('npm', args, {
      cwd: dir, timeout: 120000, env: SAFE_ENV, encoding: 'utf8', shell: false
    });
    res.json({ message: `Installé : ${valid.join(', ')}`, output: out });
  } catch (e) {
    res.status(500).json({ error: `npm install échoué : ${sanitizeLogText(e.message.split('\n')[0])}`, output: e.stdout || '' });
  }
});

// -- DELETE /api/bots/:name/npm/:pkg ----------------------
router.delete('/:name/npm/:pkg', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });

  const pkg = req.params.pkg;
  if (!isValidPackageName(pkg)) return res.status(400).json({ error: 'Package invalide' });

  const dir = fsService.botPath(safeName);
  try {
    execFileSync('npm', ['uninstall', pkg, '--save', ...NPM_COMMON_ARGS], {
      cwd: dir, timeout: 60000, env: SAFE_ENV, shell: false
    });
    res.json({ message: `Désinstallé : ${pkg}` });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// -- GET /api/bots/:name/env -------------------------------
function parseEnvFile(content) {
  const vars = [];
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) vars.push({ key, value });
  }
  return vars;
}

function serializeEnvFile(name, vars) {
  const lines = [`# Bot: ${name}`, '# Managed by Nexus Bot Manager', ''];
  for (const { key, value } of vars) {
    const needsQuote = /[\s#"']/.test(value);
    const rendered = needsQuote
      ? `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : String(value);
    lines.push(`${key}=${rendered}`);
  }
  return lines.join('\n') + '\n';
}

router.get('/:name/env', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  const envPath = path.join(fsService.botPath(safeName), '.env');
  try {
    const exists = fs.existsSync(envPath);
    const content = exists ? fs.readFileSync(envPath, 'utf8') : '';
    res.json({ exists, vars: parseEnvFile(content) });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

router.put('/:name/env', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  const dir = fsService.botPath(safeName);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Bot introuvable' });

  const vars = Array.isArray(req.body && req.body.vars) ? req.body.vars : null;
  if (!vars || vars.length > 100) return res.status(400).json({ error: 'Liste de variables invalide' });

  const seen = new Set();
  const clean = [];
  for (const item of vars) {
    const key = String(item && item.key || '').trim();
    const value = item && item.value !== undefined ? String(item.value) : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      return res.status(400).json({ error: `Nom de variable invalide : ${sanitizeLogText(key, 40)}` });
    }
    if (seen.has(key)) return res.status(400).json({ error: `Variable dupliquée : ${key}` });
    if (/[\r\n]/.test(value) || value.length > 4096) {
      return res.status(400).json({ error: `Valeur invalide pour ${key}` });
    }
    seen.add(key);
    clean.push({ key, value });
  }

  try {
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, serializeEnvFile(safeName, clean), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(envPath, 0o600); } catch (_) {}
    getDb().logActivity({ action: 'bot_env_updated', bot_name: safeName, user: req.user.username });
    res.json({ message: 'Variables enregistrées', vars: clean });
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// -- POST /api/bots/:name/npm/reinstall --------------------
router.post('/:name/npm/reinstall', (req, res) => {
  const safeName = sanitizeBotName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
  const dir = fsService.botPath(safeName);
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    return res.status(400).json({ error: 'package.json introuvable' });
  }
  const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
  const args = hasLock
    ? ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=warn']
    : ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=warn'];
  try {
    const out = execFileSync('npm', args, {
      cwd: dir, timeout: 180000, env: SAFE_ENV, encoding: 'utf8', shell: false
    });
    getDb().logActivity({ action: 'bot_deps_reinstalled', bot_name: safeName, user: req.user.username });
    res.json({ message: 'Dépendances réinstallées', output: out });
  } catch (e) {
    res.status(500).json({
      error: `Réinstallation échouée : ${sanitizeLogText(String(e.message || '').split('\n')[0])}`,
      output: e.stdout || ''
    });
  }
});

module.exports = router;
