'use strict';
const fs   = require('fs');
const path = require('path');

// Strip a UTF-8 BOM from the .env file before dotenv parses it.
// INF-18: a BOM turns the first key into "﻿PORT" instead of "PORT",
// so PORT was silently ignored and the server fell back to 3001.
const envPath = path.join(__dirname, '..', '.env');
try {
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) {
      fs.writeFileSync(envPath, raw.slice(1), 'utf8');
      console.log('[env] BOM UTF-8 retiré de .env');
    }
  }
} catch (_) { /* non fatal */ }

require('dotenv').config();

// Optional: read the signing key from a dedicated file (for example a
// systemd credential or a 0400 file outside the repository) instead of
// keeping it inline in .env. The file must not be group/world readable.
if (!process.env.JWT_SECRET && process.env.JWT_SECRET_FILE) {
  try {
    const secretPath = path.resolve(process.env.JWT_SECRET_FILE);
    const st = fs.lstatSync(secretPath);
    if (!st.isFile()) throw new Error('pas un fichier régulier (symlink refusé)');
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      throw new Error('permissions trop larges (attendu 0400 ou 0600)');
    }
    process.env.JWT_SECRET = fs.readFileSync(secretPath, 'utf8').trim();
  } catch (e) {
    console.error('[FATAL] JWT_SECRET_FILE illisible ou non sécurisé:', e.message);
    process.exit(1);
  }
}

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');
const pm2     = require('pm2');
const os      = require('os');

const {
  securityHeaders, apiLimiter, sanitizeBotName,
  registerSecret, redactSecrets
} = require('./middleware/security');
const { getDb }             = require('./db/db');
const { resolveSession, verifyOptions } = require('./middleware/auth.middleware');
const authRoutes   = require('./routes/auth');
const botsRoutes   = require('./routes/bots');
const filesRoutes  = require('./routes/files');
const systemRoutes = require('./routes/system');
const backupRoutes = require('./routes/backup');
const updateRoutes = require('./routes/update');
const versionSvc   = require('./services/version.service');
const updateSvc    = require('./services/update.service');

// -- Validate environment ---------------------------------
// AUTH-02: a length check alone is satisfied by the public placeholder
// shipped in .env.example, which turned the startup guard into a no-op
// and made forging an admin token trivial. Validate entropy, reject the
// shipped example value and reject low-diversity secrets.
(function assertStrongSecret() {
  const secret = process.env.JWT_SECRET;
  const fatal = (msg, help) => {
    console.error(`[FATAL] ${msg}`);
    if (help) console.error(`        ${help}`);
    process.exit(1);
  };

  if (!secret) {
    fatal('JWT_SECRET manquant. Créez un fichier .env.',
      'Générez un secret avec: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  }
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    fatal('JWT_SECRET trop court (min 32 octets).',
      'Générez un secret avec: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  }

  // Values that must never be accepted, whatever their length.
  const PLACEHOLDERS = new Set([
    'secret', 'changeme', 'change_me', 'nexus', 'jwt_secret', 'jwtsecret',
    'nexusbotmanager', 'nexus-bot-manager', 'password', 'admin', 'test',
    'your-secret-here', 'replace-me', 'example', 'insecure',
    // AUTH-02: the exact placeholder published by earlier releases. It is
    // no longer in .env.example (which is now empty), so the file check
    // below cannot catch it; existing installs that copied the old
    // template must still be refused.
    'change_this_to_a_random_64_char_hex_string'
  ]);
  const lower = secret.toLowerCase();
  if (PLACEHOLDERS.has(lower)) {
    fatal('JWT_SECRET est une valeur générique.', 'Générez-en une aléatoire.');
  }

  // The literal placeholder from .env.example must be rejected even if an
  // operator edits the surrounding comment but not the value.
  try {
    const examplePath = path.join(__dirname, '..', '.env.example');
    if (fs.existsSync(examplePath)) {
      const example = fs.readFileSync(examplePath, 'utf8')
        .match(/^JWT_SECRET=(.*)$/m)?.[1]?.trim();
      if (example && example.toLowerCase() === lower) {
        fatal('JWT_SECRET est encore la valeur d\'exemple de .env.example.',
          'Générez-en une : node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
      }
    }
  } catch (_) { /* the checks below still apply */ }

  if (/^(.)\1+$/.test(secret)) fatal('JWT_SECRET est une chaîne répétitive.');
  // Hex is the documented format (128 hex chars -> 16 distinct symbols at
  // random). Anything else must still show reasonable character variety.
  const isHex = /^[0-9a-fA-F]+$/.test(secret);
  if (!isHex && new Set(secret).size < 12) {
    fatal('JWT_SECRET trop peu diversifié (entropie insuffisante).',
      'Générez-en une aléatoire.');
  }
  if (isHex && Buffer.byteLength(secret, 'utf8') < 64) {
    fatal('JWT_SECRET hexadécimal trop court (min 64 caractères = 256 bits).');
  }
})();

// The signing key must never be echoed into the logs relayed to the UI.
registerSecret(process.env.JWT_SECRET);

const app    = express();
const server = http.createServer(app);

// -- CORS (UPD-12 / SEC-10) ----------------------------------
// The panel serves its own API from its own origin, so a wildcard is not
// needed for normal use and it is what makes any website able to talk to
// the API. Same-origin (the default) is preserved; CORS_ORIGIN allows a
// deliberate extra origin, e.g. CORS_ORIGIN=https://panel.example.lan
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : false,
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e5
});

// -- Trust proxy --------------------------------------------
// Still OFF by default: enabling it blindly would let any client forge
// X-Forwarded-For and defeat the IP rate limiters. Opt in when the app
// really is behind a reverse proxy (which is the documented deployment).
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY && !/^(0|false|no|off)$/i.test(TRUST_PROXY)) {
  // The documented value is a hop count (usually 1). A numeric string must
  // be converted to a number: Express treats a string as an IP/subnet.
  if (TRUST_PROXY === 'true') app.set('trust proxy', 1);
  else if (/^\d+$/.test(TRUST_PROXY)) app.set('trust proxy', parseInt(TRUST_PROXY, 10));
  else app.set('trust proxy', TRUST_PROXY);
}

// -- Middleware --------------------------------------------
app.use(securityHeaders);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                 // same-origin / curl
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);                              // foreign origin: no CORS headers
  },
  credentials: true
}));

/**
 * CSRF defence (AUTH-01 / UPD-12 / SEC-10).
 *
 * A cross-origin HTML form is a "simple request": no preflight, and CORS
 * does not stop the request from being *sent*, only from being read.
 * So state-changing requests are additionally rejected when they carry a
 * foreign Origin header. Browsers always attach Origin to cross-origin
 * POST/PUT/DELETE; same-origin requests and non-browser clients (curl,
 * the install scripts) send none and are unaffected.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
app.use((req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let originHost;
  try { originHost = new URL(origin).host; } catch (_) {
    return res.status(403).json({ error: 'Origine refusée' });
  }
  if (originHost === req.get('host')) return next();
  if (allowedOrigins.includes(origin)) return next();
  return res.status(403).json({ error: 'Origine refusée' });
});

// INF-09: the rate limiter must run BEFORE the body parsers, otherwise
// a large body is parsed before the request is ever counted. The limit
// sits comfortably above the app's own 2 MB per-file cap so writing a
// maximum-size file through PUT /api/files/:bot/write still works.
app.use('/api/', apiLimiter);
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 100 }));

// -- Static frontend ---------------------------------------
const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'public');
if (fs.existsSync(FRONTEND)) {
  app.use(express.static(FRONTEND, { maxAge: 0, redirect: false, dotfiles: 'deny' }));
} else {
  console.warn('[static] Frontend non trouvé:', FRONTEND);
}

// Monaco is served from the installed npm package, not a public CDN. This
// keeps the editor CSS, fonts and web workers same-origin and avoids the
// cross-origin worker restrictions that made the editor freeze.
const MONACO_VENDOR = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min');
if (fs.existsSync(MONACO_VENDOR)) {
  app.use('/vendor/monaco', express.static(MONACO_VENDOR, {
    maxAge: '7d',
    immutable: true,
    redirect: false,
    dotfiles: 'deny'
  }));
} else {
  console.warn('[static] Monaco package not found:', MONACO_VENDOR);
}

// -- API Routes --------------------------------------------
app.use('/api/auth',    authRoutes);
app.use('/api/bots',    botsRoutes);
app.use('/api/files',   filesRoutes);
app.use('/api/system',  systemRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api/update',  updateRoutes);

// INF-13: the health probe no longer advertises the exact version, the
// uptime or the server clock to an unauthenticated caller.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// SEC-09: an unknown /api/* path used to fall through to the SPA
// fallback and answer HTTP 200 with index.html, which hid typos and
// turned a mistyped endpoint into a 200 in every monitoring system.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Point de terminaison introuvable' });
});

// SPA fallback
app.get('*', (req, res) => {
  const idx = path.join(FRONTEND, 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.json({ name: 'Nexus Bot Manager API' });
});

// Detect a pending update from a previous run
const _pendingUpdate = updateSvc.checkPendingRestart();
if (_pendingUpdate) {
  console.log(`[update] Redémarrage détecté après mise à jour ${_pendingUpdate.expectedVersion} -> version actuelle ${_pendingUpdate.actualVersion}`);
}

// -- Global error handler ----------------------------------
app.use((err, req, res, next) => {
  console.error('[error]', err && err.message);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// ------------------------------------------------------------
// SOCKET.IO — Real-time logs & PM2 status
// ------------------------------------------------------------

// Auth middleware for Socket.IO.
// AUTH-08: the session is now revalidated against the database on every
// subscribe, so a logout or a password change cuts a live connection
// too instead of only taking effect at the next handshake.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Non authentifié'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, verifyOptions);
    const user = resolveSession(payload);
    if (!user) return next(new Error('Token invalide ou révoqué'));
    if (user.role !== 'admin') return next(new Error('Accès administrateur requis'));
    socket.user = { id: user.id, username: user.username, role: user.role, jti: payload.jti, exp: payload.exp };
    next();
  } catch (e) {
    next(new Error('Token invalide'));
  }
});

function socketSessionStillValid(socket) {
  // The handshake verified the token once; a long-lived socket must not
  // outlive the token's own exp claim.
  if (socket.user.exp && Math.floor(Date.now() / 1000) >= Number(socket.user.exp)) return false;
  try {
    return !!resolveSession({ id: socket.user.id, username: socket.user.username, role: socket.user.role, jti: socket.user.jti });
  } catch (_) { return false; }
}

// CMD-04 / AUTH-09 / XSS-03: the requested bot name is now validated
// with the same sanitiser the REST API uses, so it cannot contain path
// separators. The log file names are then built only from characters we
// chose, and the watcher cannot read outside the PM2 log directory.
const LOG_TAIL_BYTES = 64 * 1024;   // cap on the initial replay + per-poll read

// Track active log watchers per socket
const watchers = new Map();

function clearWatcher(socketId) {
  const w = watchers.get(socketId);
  if (w) { clearInterval(w); watchers.delete(socketId); }
}

io.on('connection', (socket) => {
  console.log(`[socket] ${socket.user.username} connecté`);

  // -- Subscribe to bot logs ----------------------------
  socket.on('subscribe:logs', (botName) => {
    clearWatcher(socket.id);

    // The session may have been revoked since the handshake.
    if (!socketSessionStillValid(socket)) {
      socket.emit('log:error', { error: 'Session révoquée' });
      return;
    }

    const safeName = sanitizeBotName(botName);
    if (!safeName) {
      socket.emit('log:error', { error: 'Nom de bot invalide' });
      return;
    }

    const logDir = path.join(os.homedir(), '.pm2', 'logs');
    const outLog = path.join(logDir, `${safeName}-out.log`);
    const errLog = path.join(logDir, `${safeName}-error.log`);
    let outPos = 0, errPos = 0;

    // Init positions
    try { if (fs.existsSync(outLog)) outPos = fs.statSync(outLog).size; } catch (_) {}
    try { if (fs.existsSync(errLog)) errPos = fs.statSync(errLog).size; } catch (_) {}

    // Send the last lines immediately — reading only the tail of the file
    // so a huge log cannot be pulled into memory at once.
    const tail = (logPath, count, evt) => {
      try {
        if (!fs.existsSync(logPath)) return;
        const size = fs.statSync(logPath).size;
        const from = Math.max(0, size - LOG_TAIL_BYTES);
        const len  = size - from;
        if (len <= 0) return;
        const fd  = fs.openSync(logPath, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, from);
        fs.closeSync(fd);
        buf.toString().split('\n').filter(Boolean).slice(-count)
          .forEach(line => socket.emit(evt, { bot: safeName, line: redactSecrets(line), ts: Date.now() }));
      } catch (_) {}
    };
    tail(outLog, 80, 'log:out');
    tail(errLog, 30, 'log:err');

    // Poll every 800ms for new lines
    const interval = setInterval(() => {
      if (!socketSessionStillValid(socket)) {
        clearWatcher(socket.id);
        socket.emit('log:error', { error: 'Session révoquée' });
        return;
      }
      for (const [logPath, getPos, setPos, evt] of [
        [outLog, () => outPos, v => { outPos = v; }, 'log:out'],
        [errLog, () => errPos, v => { errPos = v; }, 'log:err']
      ]) {
        try {
          if (!fs.existsSync(logPath)) continue;
          const stat = fs.statSync(logPath);
          if (stat.size <= getPos()) continue;
          const chunk = Math.min(stat.size - getPos(), LOG_TAIL_BYTES);
          const fd  = fs.openSync(logPath, 'r');
          const buf = Buffer.alloc(chunk);
          fs.readSync(fd, buf, 0, chunk, getPos());
          fs.closeSync(fd);
          setPos(getPos() + chunk);
          buf.toString().split('\n').filter(Boolean)
            .forEach(line => socket.emit(evt, { bot: safeName, line: redactSecrets(line), ts: Date.now() }));
        } catch (_) {}
      }
    }, 800);

    watchers.set(socket.id, interval);
    socket.emit('log:subscribed', { bot: safeName });
  });

  socket.on('unsubscribe:logs', () => clearWatcher(socket.id));

  // -- PM2 status broadcast every 4s -------------------
  const pm2Interval = setInterval(() => {
    // A revoked session must not keep receiving PM2 status.
    if (!socketSessionStillValid(socket)) {
      clearInterval(pm2Interval);
      clearWatcher(socket.id);
      socket.disconnect(true);
      return;
    }
    pm2.connect(false, err => {
      if (err) return;
      pm2.list((err2, list) => {
        pm2.disconnect();
        if (err2 || !list) return;
        socket.emit('pm2:status', list.map(p => ({
          // sanitizeBotName on every value that reaches the browser: the
          // process name comes from a package.json a bot controls (SEC-12).
          name:     sanitizeBotName(String(p.name || '')) || 'bot',
          status:   p.pm2_env?.status    ?? 'unknown',
          cpu:      p.monit?.cpu         ?? 0,
          memory:   Math.round((p.monit?.memory ?? 0) / 1024 / 1024),
          pid:      p.pid,
          uptime:   p.pm2_env?.pm_uptime ?? null,
          restarts: p.pm2_env?.restart_time ?? 0
        })));
      });
    });
  }, 4000);

  socket.on('disconnect', () => {
    clearWatcher(socket.id);
    clearInterval(pm2Interval);
    console.log(`[socket] ${socket.user.username} déconnecté`);
  });
});

// -- Start -------------------------------------------------
const PORT = parseInt(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  const db = getDb();   // Initialize DB

  const ip = Object.values(os.networkInterfaces())
    .flat().find(i => i?.family === 'IPv4' && !i.internal)?.address || 'localhost';

  const local = versionSvc.loadLocal();
  console.log('\n---------------------------------------------');
  console.log(`-        Nexus Bot Manager v${local.version}           -`);
  console.log('---------------------------------------------');
  console.log(`-  Local  -> http://localhost:${PORT}            -`);
  console.log(`-  Réseau -> http://${ip}:${PORT}          -`);
  console.log('---------------------------------------------\n');

  // AUTH-01: surface the one-time setup token where the operator will
  // see it, instead of leaving the setup endpoint remotely claimable.
  // The token is generated here, at boot, so it exists before the very
  // first request and can be printed straight away.
  if (!db.isSetupDone()) {
    const token = authRoutes.ensureSetupToken();
    console.log('------------------------------------------------------------');
    console.log('- CONFIGURATION INITIALE REQUISE');
    console.log('-');
    console.log('- Jeton de configuration (à saisir dans l\'assistant) :');
    console.log(`-   ${token}`);
    console.log('- (également stocké dans backend/data/setup-token, 0600)');
    console.log('------------------------------------------------------------\n');
  }
});

module.exports = { app, server, io };
