'use strict';
const rateLimit = require('express-rate-limit');
const path      = require('path');

// PATH for shell commands — works regardless of how Node was launched
const SAFE_PATH = [
  '/usr/local/bin', '/usr/local/lib/node_modules/.bin',
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  process.env.PATH || ''
].filter(Boolean).join(':');

const SAFE_ENV = { ...process.env, PATH: SAFE_PATH };

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes.' },
  standardHeaders: true, legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300,
  message: { error: 'Trop de requêtes.' },
  standardHeaders: true, legacyHeaders: false
});

// Minimal security headers — NO HTTPS forcing (HTTP-only LXC environment)
function securityHeaders(req, res, next) {
  res.removeHeader('X-Powered-By');
  // Clear any HSTS the browser may have cached
  res.setHeader('Strict-Transport-Security', 'max-age=0');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  // NO Content-Security-Policy — would block CDN resources over HTTP
  next();
}

// Bot name sanitization
function sanitizeBotName(name) {
  if (typeof name !== 'string') return null;
  const clean = name.toLowerCase().replace(/[^a-z0-9-]/g, '').trim();
  if (!clean || clean.length < 2 || clean.length > 64) return null;
  if (clean.startsWith('-') || clean.endsWith('-')) return null;
  if (clean.includes('--')) return null;
  return clean;
}

// Safe path resolution — prevents path traversal
function safeBotPath(botName) {
  const root = path.resolve(process.env.BOTS_ROOT || '/opt');
  const resolved = path.resolve(root, botName);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  return resolved;
}

function safeFilePath(botName, relativeFilename) {
  const root    = path.resolve(process.env.BOTS_ROOT || '/opt');
  const botPath = path.resolve(root, botName);
  const filePath = path.resolve(botPath, relativeFilename);

  if (!filePath.startsWith(botPath + path.sep)) return null;

  const allowed = ['.js', '.ts', '.mjs', '.cjs', '.json', '.env', '.md', '.txt', '.yaml', '.yml', '.sh', '.log', '.gitignore'];
  const ext = path.extname(relativeFilename).toLowerCase();
  // Allow no-extension files like .env, .gitignore
  if (ext && !allowed.includes(ext)) return null;

  return filePath;
}

module.exports = { loginLimiter, apiLimiter, securityHeaders, sanitizeBotName, safeBotPath, safeFilePath, SAFE_ENV };
