'use strict';
/**
 * Nexus Bot Manager — PM2 Service
 * Wraps PM2 programmatic API. All calls use the native API (no shell).
 */

const pm2  = require('pm2');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Status mapping
const STATUS = {
  online:  { label: 'En ligne',       color: 'green',  icon: '🟢' },
  stopped: { label: 'Arrêté',         color: 'amber',  icon: '🔴' },
  errored: { label: 'Erreur',         color: 'red',    icon: '⚠️'  },
  stopping:{ label: 'Arrêt...',       color: 'amber',  icon: '🟠' },
  launching:{ label: 'Démarrage...', color: 'blue',   icon: '🟡' },
  unknown: { label: 'Inconnu',        color: 'gray',   icon: '⚪' }
};

function connect() {
  return new Promise((resolve, reject) => {
    pm2.connect(false, err => err ? reject(new Error('PM2 non disponible: ' + err.message)) : resolve());
  });
}

function disconnect() {
  try { pm2.disconnect(); } catch (_) {}
}

function withPm2(fn) {
  return connect().then(() => fn()).finally(() => disconnect());
}

async function list() {
  return withPm2(() => new Promise((resolve, reject) => {
    pm2.list((err, list) => err ? reject(err) : resolve(list || []));
  }));
}

async function start(botName, botPath) {
  return withPm2(() => new Promise((resolve, reject) => {
    pm2.start({
      name:          botName,
      script:        'index.js',
      cwd:           botPath,
      watch:         false,
      autorestart:   true,
      max_restarts:  parseInt(process.env.BOT_MAX_RESTARTS) || 5,
      restart_delay: 3000,
      min_uptime:    '5s',
      env:           { NODE_ENV: 'production' }
    }, (err, proc) => {
      if (err) return reject(new Error(humanizeError(err)));
      pm2.dump(dumpErr => {
        if (dumpErr) console.warn('[PM2] dump error:', dumpErr.message);
        resolve(proc);
      });
    });
  }));
}

async function stop(botName) {
  return withPm2(() => new Promise((resolve, reject) => {
    pm2.stop(botName, err => err ? reject(new Error(humanizeError(err))) : resolve());
  })).then(() => withPm2(() => new Promise(res => pm2.dump(()=> res()))));
}

async function restart(botName) {
  return withPm2(() => new Promise((resolve, reject) => {
    pm2.restart(botName, err => err ? reject(new Error(humanizeError(err))) : resolve());
  }));
}

async function remove(botName) {
  return withPm2(() => new Promise((resolve, reject) => {
    pm2.delete(botName, err => {
      if (err) return reject(new Error(humanizeError(err)));
      pm2.dump(() => resolve());
    });
  }));
}

async function describe(botName) {
  return withPm2(() => new Promise((resolve, reject) => {
    pm2.describe(botName, (err, desc) => {
      if (err) return reject(err);
      resolve(desc && desc[0] ? desc[0] : null);
    });
  }));
}

async function getLogs(botName, lines = 100) {
  const logDir = path.join(os.homedir(), '.pm2', 'logs');
  const outLog = path.join(logDir, `${botName}-out.log`);
  const errLog = path.join(logDir, `${botName}-error.log`);
  const result = { out: [], err: [] };

  try {
    if (fs.existsSync(outLog)) {
      result.out = fs.readFileSync(outLog, 'utf8')
        .split('\n').filter(Boolean).slice(-lines);
    }
  } catch (_) {}

  try {
    if (fs.existsSync(errLog)) {
      result.err = fs.readFileSync(errLog, 'utf8')
        .split('\n').filter(Boolean).slice(-Math.floor(lines / 2));
    }
  } catch (_) {}

  return result;
}

function formatProcess(proc) {
  if (!proc) return null;
  const env    = proc.pm2_env || {};
  const monit  = proc.monit  || {};
  const status = STATUS[env.status] ? env.status : 'unknown';

  return {
    name:      proc.name,
    pid:       proc.pid || null,
    status,
    statusMeta: STATUS[status] || STATUS.unknown,
    cpu:       typeof monit.cpu === 'number' ? monit.cpu : 0,
    memory:    monit.memory ? Math.round(monit.memory / 1024 / 1024) : 0,
    uptime:    env.pm_uptime  || null,
    restarts:  env.restart_time || 0,
    createdAt: env.created_at  || null,
    version:   env.version     || null
  };
}

function humanizeError(err) {
  if (!err) return 'Erreur inconnue';
  const msg = err.message || String(err);
  if (msg.includes('process or namespace not found')) return `Bot non trouvé dans PM2. Démarrez-le d'abord.`;
  if (msg.includes('ENOENT') && msg.includes('index.js'))  return `Fichier index.js introuvable dans le dossier du bot.`;
  if (msg.includes('MODULE_NOT_FOUND'))   return `Dépendances manquantes. Lancez npm install dans le dossier du bot.`;
  if (msg.includes('EACCES'))             return `Permission refusée. Vérifiez les droits sur le dossier.`;
  return msg;
}

module.exports = { list, start, stop, restart, remove, describe, getLogs, formatProcess, STATUS };
