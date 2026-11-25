'use strict';
const rateLimit = require('express-rate-limit');
const path      = require('path');
const crypto    = require('crypto');

// PATH for shell commands — works regardless of how Node was launched
const SAFE_PATH = [
  '/usr/local/bin', '/usr/local/lib/node_modules/.bin',
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  process.env.PATH || ''
].filter(Boolean).join(path.delimiter);

// Environment handed to child processes (npm, tar, ...).
// SECURITY: the JWT signing secret must NEVER leak into a child process —
// `npm install` runs package lifecycle scripts, which would otherwise be
// able to read it (CMD-03 / CMD-07). Only the variables the panel itself
// needs are forwarded.
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME',
  'NODE_ENV', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_USERCONFIG',
  'INSTALL_DIR', 'BOTS_ROOT', 'PORT', 'PM2_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy'
];
const SAFE_ENV = SAFE_ENV_KEYS.reduce((acc, k) => {
  if (process.env[k] !== undefined) acc[k] = process.env[k];
  return acc;
}, {});
SAFE_ENV.PATH = SAFE_PATH;

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes.' },
  standardHeaders: true, legacyHeaders: false
});

// Dedicated limiter for the unauthenticated setup endpoint (AUTH-07):
// it hashes with bcrypt, which is CPU-expensive.
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Trop de tentatives de configuration, réessayez dans 15 minutes.' },
  standardHeaders: true, legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300,
  message: { error: 'Trop de requêtes.' },
  standardHeaders: true, legacyHeaders: false
});

// -- Per-account lockout (AUTH-05 / INF-15) --------------------
// The IP-only limiter above is trivially sidestepped behind a reverse
// proxy. This adds a second, username-keyed gate with exponential
// back-off. In-memory on purpose: no new persistence, no new dependency.
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MS   = 60 * 1000;
const LOCKOUT_MAX_MS    = 30 * 60 * 1000;
const _loginFailures    = new Map();

// A per-(username, IP) lockout stops a single host, but a distributed
// attacker can rotate IPs. A second, global per-username counter with a
// higher threshold closes that gap while keeping the admin's own IP usable
// for longer than a trivially-triggered lockout.
const ACCOUNT_LOCKOUT_THRESHOLD = 20;
const ACCOUNT_LOCKOUT_BASE_MS   = 5 * 60 * 1000;
const ACCOUNT_LOCKOUT_MAX_MS    = 30 * 60 * 1000;
const _accountFailures          = new Map();

function loginKey(username, ip) {
  return `${String(username || '').toLowerCase().slice(0, 64)}|${ip || '-'}`;
}

function accountKey(username) {
  return String(username || '').toLowerCase().slice(0, 64);
}

function bumpFailures(map, key, threshold, baseMs, maxMs) {
  const rec = map.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= threshold) {
    const over = rec.count - threshold;
    rec.until = Date.now() + Math.min(baseMs * Math.pow(2, over), maxMs);
  }
  map.set(key, rec);
  // Bound each map so it cannot be grown without limit.
  if (map.size > 5000) {
    const oldest = [...map.entries()].sort((a, b) => a[1].until - b[1].until);
    for (let i = 0; i < 1000; i++) map.delete(oldest[i][0]);
  }
  return rec;
}

function registerLoginFailure(username, ip) {
  const rec = bumpFailures(_loginFailures, loginKey(username, ip),
    LOCKOUT_THRESHOLD, LOCKOUT_BASE_MS, LOCKOUT_MAX_MS);
  bumpFailures(_accountFailures, accountKey(username),
    ACCOUNT_LOCKOUT_THRESHOLD, ACCOUNT_LOCKOUT_BASE_MS, ACCOUNT_LOCKOUT_MAX_MS);
  return rec;
}

function clearLoginFailures(username, ip) {
  _loginFailures.delete(loginKey(username, ip));
  _accountFailures.delete(accountKey(username));
}

/** @returns {number} remaining lockout in ms, 0 when not locked. */
function loginLockoutRemaining(username, ip) {
  const perIp = _loginFailures.get(loginKey(username, ip));
  const account = _accountFailures.get(accountKey(username));
  const now = Date.now();
  return Math.max(
    perIp ? perIp.until - now : 0,
    account ? account.until - now : 0,
    0
  );
}

// -- Security headers -----------------------------------------
// NOTE on CSP: the panel is served over plain HTTP from the same origin
// as its API and loads the Tabler Icons and Google Fonts CDNs. Monaco is
// served from node_modules on the same origin. The policy below is
// therefore permissive enough to keep every existing feature working,
// while still blocking the injection vectors that do not require inline
// script: <object>/<embed>, <base> hijacking, cross-origin form posts,
// and framing by a third party.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://cdn.jsdelivr.net",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');

function securityHeaders(req, res, next) {
  res.removeHeader('X-Powered-By');
  // Clear any HSTS the browser may have cached (HTTP-only LXC deployment)
  res.setHeader('Strict-Transport-Security', 'max-age=0');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // X-XSS-Protection is obsolete and, in some browsers, enables an
  // attacker-controlled filter that can itself mangle pages. Turning it
  // off explicitly is the recommended hardening (INF-17).
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // COOP only applies to secure, potentially trustworthy origins. Sending it
  // over plain HTTP makes Chromium log a warning on every page load, so only
  // emit it when the request is HTTPS or localhost.
  const host = String((req.headers && req.headers.host) || '');
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  if (req.secure || localHost) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  }
  if (process.env.CSP_ENABLED !== 'false') {
    res.setHeader('Content-Security-Policy', CSP);
  }
  next();
}

// -- Path containment (FILE-01 / FILE-02) ---------------------
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
  if (!isInsideOrEqual(root, resolved)) return null;
  return resolved;
}

function safeFilePath(botName, relativeFilename) {
  const root    = path.resolve(process.env.BOTS_ROOT || '/opt');
  const botPath = path.resolve(root, botName);
  const filePath = path.resolve(botPath, relativeFilename);

  if (!isInside(botPath, filePath)) return null;

  // FILE-03 / traversal defence in depth: `path.resolve` treats "%2f" as
  // ordinary text, so an encoded separator is contained today. Refuse it
  // anyway, because any layer that decodes before this one (a proxy, a
  // future rewrite of the handler) would turn it into a real traversal.
  if (/%2e|%2f|%5c/i.test(String(relativeFilename))) return null;

  const allowed = ['.js', '.ts', '.mjs', '.cjs', '.json', '.env', '.md', '.txt', '.yaml', '.yml', '.sh', '.log', '.gitignore'];
  const ext = path.extname(relativeFilename).toLowerCase();
  // Allow no-extension files like .env, .gitignore
  if (ext && !allowed.includes(ext)) return null;

  return filePath;
}

/**
 * True when `target` is strictly contained in `base`.
 * `base` itself returns false — callers that allow the base directory
 * must check for equality explicitly, so an "is it inside?" question
 * can never be answered by a naive string prefix match.
 *
 * This is the single source of truth for path containment in the app:
 * `startsWith(bPath)` without `path.sep` treats /opt/monbot as a prefix
 * of /opt/monbot2, /opt/monbot-backup, ...
 */
function isInside(base, target) {
  if (typeof base !== 'string' || typeof target !== 'string') return false;
  const b = path.resolve(base);
  const t = path.resolve(target);
  if (b === t) return false;
  return t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** True when `target` is `base` itself or strictly inside it. */
function isInsideOrEqual(base, target) {
  if (typeof base !== 'string' || typeof target !== 'string') return false;
  return path.resolve(base) === path.resolve(target) || isInside(base, target);
}

let _realpathSync = null;
function fsRealpath(p) {
  if (!_realpathSync) _realpathSync = require('fs').realpathSync;
  return _realpathSync(p);
}

/**
 * Resolve symlinks as far as the path exists and re-check containment.
 * Closes FILE-03: a symlink inside the bot directory can point anywhere
 * even though the textual path is contained.
 */
function isInsideReal(base, target) {
  if (!isInsideOrEqual(base, target)) return false;
  const realBase   = realpathExistingPrefix(base);
  const realTarget = realpathExistingPrefix(target);
  if (realBase === realTarget) return true;
  return realTarget.startsWith(realBase.endsWith(path.sep) ? realBase : realBase + path.sep);
}

/**
 * Resolve symlinks in the longest existing prefix of `p`, then append the
 * part that does not exist yet. `realpathSync` alone is not enough: for a
 * new file under a symlinked directory it throws, and falling back to the
 * textual path would let a write follow the symlink outside the bot.
 */
function realpathExistingPrefix(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fsRealpath(current);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch (_) {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

// -- Timing-safe string comparison (AUTH-01 bootstrap token) --
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  // Compare digests so the comparison length does not leak the secret.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb) && ba.length === bb.length;
}

// -- File / package name validation ---------------------------
// XSS-02: `'` and backtick must not be storable in a file name, because
// the frontend historically inlined them into JS event-handler
// attributes. The frontend escaping is the primary fix; this is the
// server-side guard that stops a malicious bot from seeding the payload.
const BAD_NAME_CHARS = /[/\\<>:"|?*'`]/;
function isValidFileName(name) {
  if (typeof name !== 'string') return false;
  if (!name || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('..')) return false;
  if (BAD_NAME_CHARS.test(name)) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 32 || c === 127) return false;             // control characters
  }
  return true;
}

/**
 * Validate a relative path made of several segments, e.g. the file names
 * a template generates ("commands/ping.js"). Every segment must be a valid
 * single name, so no segment can be "..", be absolute, or smuggle a
 * separator. Used before path.join(dir, value) for template output.
 */
function isSafeRelativePath(p) {
  if (typeof p !== 'string' || !p || p.length > 255) return false;
  if (path.isAbsolute(p)) return false;
  if (/^[A-Za-z]:/.test(p)) return false;                 // Windows drive letter
  const parts = p.split(/[\\/]+/);
  if (!parts.length) return false;
  return parts.every(seg => isValidFileName(seg));
}

// CMD-02 / CMD-06: npm package specifiers.
//
// The old route used /^[a-zA-Z0-9@/_.-]{1,100}$/, which happily accepted
// '--prefix=/tmp/pwn' or '-g': npm reads a leading dash as an option, not
// as a package name, so a request could redirect the install outside the
// bot directory.
//
// Two rules do the work:
//   1. the name part follows npm charset and cannot start with a dash,
//      a dot or an underscore;
//   2. an optional @version suffix is still accepted (the UI lets you type
//      'pkg@1.2.3') but its charset excludes '/', whitespace and every
//      shell/CLI metacharacter, and it cannot start with a dash either.
const NPM_NAME_RE    = /^(?:@[a-z0-9-~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const NPM_VERSION_RE = /^[0-9a-zA-Z^~><=.*+][0-9a-zA-Z.^~><=*+_-]{0,63}$/;

function isValidPackageName(name) {
  if (typeof name !== 'string') return false;
  if (!name || name.length > 214) return false;         // npm's own hard limit
  if (name.startsWith('-') || name.startsWith('.')) return false;
  if (name.includes('..')) return false;

  const at = name.lastIndexOf('@');
  // A leading '@' belongs to the scope, not to a version separator.
  if (at > 0) {
    if (!NPM_VERSION_RE.test(name.slice(at + 1))) return false;
    return NPM_NAME_RE.test(name.slice(0, at));
  }
  return NPM_NAME_RE.test(name);
}

// -- Secret redactor (CMD-05) ---------------------------------
const REDACTION_PLACEHOLDER = '[redacted]';
let _secretValues = [];

/** Register a value that must never appear in logs handed to the browser. */
function registerSecret(value) {
  if (typeof value !== 'string' || value.length < 12) return;
  if (_secretValues.includes(value)) return;
  _secretValues.push(value);
}

/**
 * Redact known secrets plus anything shaped like a Discord bot token or
 * a JWT from log lines relayed to the UI.
 */
function redactSecrets(text) {
  let out = String(text ?? '');
  for (const secret of _secretValues) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTION_PLACEHOLDER);
  }
  // Discord bot token: 3 dot-separated base64url segments.
  out = out.replace(/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b/g, REDACTION_PLACEHOLDER);
  // Compact JWT.
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTION_PLACEHOLDER);
  return out;
}

// -- Log injection guard (INF-16) -----------------------------
// Activity-log entries are rendered in the admin UI. Strip CR/LF and
// other control characters so a crafted bot name or npm output cannot
// forge extra log lines in the rendered log.
function sanitizeLogText(value, maxLength = 500) {
  let out = '';
  for (const ch of String(value ?? '')) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) { out += ' '; continue; }  // tab/CR/LF
    if (c < 32 || c === 127) continue;                              // other controls
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  loginLimiter,
  setupLimiter,
  apiLimiter,
  securityHeaders,
  sanitizeBotName,
  safeBotPath,
  safeFilePath,
  isInside,
  isInsideOrEqual,
  isInsideReal,
  safeEqual,
  isValidFileName,
  isSafeRelativePath,
  isValidPackageName,
  redactSecrets,
  registerSecret,
  sanitizeLogText,
  registerLoginFailure,
  clearLoginFailures,
  loginLockoutRemaining,
  SAFE_ENV,
  SAFE_PATH
};
