'use strict';
require('dotenv').config();

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const jwt     = require('jsonwebtoken');
const pm2     = require('pm2');
const os      = require('os');

const { securityHeaders, apiLimiter } = require('./middleware/security');
const { getDb }    = require('./db/db');
const authRoutes   = require('./routes/auth');
const botsRoutes   = require('./routes/bots');
const filesRoutes  = require('./routes/files');
const systemRoutes = require('./routes/system');
const backupRoutes = require('./routes/backup');
const updateRoutes = require('./routes/update');
const versionSvc   = require('./services/version.service');
const updateSvc    = require('./services/update.service');

// ── Validate environment ─────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET manquant ou trop court (min 32 chars). Créez un fichier .env.');
  console.error('        Générez un secret avec: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

// ── Trust proxy off (no HTTPS redirect) ─────────────────
app.set('trust proxy', false);

// ── Middleware ────────────────────────────────────────────
app.use(securityHeaders);
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/api/', apiLimiter);

// ── Static frontend ───────────────────────────────────────
const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'public');
if (fs.existsSync(FRONTEND)) {
  app.use(express.static(FRONTEND, { maxAge: 0, redirect: false }));
} else {
  console.warn('[static] Frontend non trouvé:', FRONTEND);
}

// ── API Routes ────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/bots',    botsRoutes);
app.use('/api/files',   filesRoutes);
app.use('/api/system',  systemRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api/update',  updateRoutes);

app.get('/api/health', (req, res) => {
  const local = versionSvc.loadLocal();
  res.json({ status: 'ok', version: local.version, uptime: process.uptime(), time: new Date().toISOString() });
});

// SPA fallback
app.get('*', (req, res) => {
  const idx = path.join(FRONTEND, 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.json({ name: 'Nexus Bot Manager API', version: versionSvc.loadLocal().version });
});

// Detect a pending update from a previous run
const _pendingUpdate = updateSvc.checkPendingRestart();
if (_pendingUpdate) {
  console.log(`[update] Redémarrage détecté après mise à jour ${_pendingUpdate.expectedVersion} → version actuelle ${_pendingUpdate.actualVersion}`);
}

// ── Global error handler ──────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// ════════════════════════════════════════════════════════════
// SOCKET.IO — Real-time logs & PM2 status
// ════════════════════════════════════════════════════════════

// Auth middleware for Socket.IO
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Non authentifié'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    next(new Error('Token invalide'));
  }
});

// Track active log watchers per socket
const watchers = new Map();

function clearWatcher(socketId) {
  const w = watchers.get(socketId);
  if (w) { clearInterval(w); watchers.delete(socketId); }
}

io.on('connection', (socket) => {
  console.log(`[socket] ${socket.user.username} connecté`);

  // ── Subscribe to bot logs ────────────────────────────
  socket.on('subscribe:logs', (botName) => {
    clearWatcher(socket.id);

    const logDir = path.join(os.homedir(), '.pm2', 'logs');
    const outLog = path.join(logDir, `${botName}-out.log`);
    const errLog = path.join(logDir, `${botName}-error.log`);
    let outPos = 0, errPos = 0;

    // Init positions
    try { if (fs.existsSync(outLog)) outPos = fs.statSync(outLog).size; } catch (_) {}
    try { if (fs.existsSync(errLog)) errPos = fs.statSync(errLog).size; } catch (_) {}

    // Send last 80 lines immediately
    try {
      if (fs.existsSync(outLog)) {
        fs.readFileSync(outLog, 'utf8').split('\n').filter(Boolean).slice(-80)
          .forEach(line => socket.emit('log:out', { bot: botName, line, ts: Date.now() }));
      }
    } catch (_) {}
    try {
      if (fs.existsSync(errLog)) {
        fs.readFileSync(errLog, 'utf8').split('\n').filter(Boolean).slice(-30)
          .forEach(line => socket.emit('log:err', { bot: botName, line, ts: Date.now() }));
      }
    } catch (_) {}

    // Poll every 800ms for new lines
    const interval = setInterval(() => {
      for (const [logPath, getPos, setPos, evt] of [
        [outLog, () => outPos, v => { outPos = v; }, 'log:out'],
        [errLog, () => errPos, v => { errPos = v; }, 'log:err']
      ]) {
        try {
          if (!fs.existsSync(logPath)) continue;
          const stat = fs.statSync(logPath);
          if (stat.size <= getPos()) continue;
          const fd  = fs.openSync(logPath, 'r');
          const buf = Buffer.alloc(stat.size - getPos());
          fs.readSync(fd, buf, 0, buf.length, getPos());
          fs.closeSync(fd);
          setPos(stat.size);
          buf.toString().split('\n').filter(Boolean)
            .forEach(line => socket.emit(evt, { bot: botName, line, ts: Date.now() }));
        } catch (_) {}
      }
    }, 800);

    watchers.set(socket.id, interval);
    socket.emit('log:subscribed', { bot: botName });
  });

  socket.on('unsubscribe:logs', () => clearWatcher(socket.id));

  // ── PM2 status broadcast every 4s ───────────────────
  const pm2Interval = setInterval(() => {
    pm2.connect(false, err => {
      if (err) return;
      pm2.list((err2, list) => {
        pm2.disconnect();
        if (err2 || !list) return;
        socket.emit('pm2:status', list.map(p => ({
          name:     p.name,
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

// ── Start ─────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3001;

server.listen(PORT, '0.0.0.0', () => {
  getDb(); // Initialize DB

  const ip = Object.values(os.networkInterfaces())
    .flat().find(i => i?.family === 'IPv4' && !i.internal)?.address || 'localhost';

  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║        Nexus Bot Manager v1.0.0           ║');
  console.log('╠═══════════════════════════════════════════╣');
  console.log(`║  Local  → http://localhost:${PORT}            ║`);
  console.log(`║  Réseau → http://${ip}:${PORT}          ║`);
  console.log('╚═══════════════════════════════════════════╝\n');
});

module.exports = { app, server, io };
