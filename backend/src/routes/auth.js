'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { getDb, DATA_DIR } = require('../db/db');
const {
  loginLimiter, setupLimiter, safeEqual,
  registerLoginFailure, clearLoginFailures, loginLockoutRemaining, sanitizeLogText
} = require('../middleware/security');
const { requireAuth, requireAdmin, signToken } = require('../middleware/auth.middleware');

const router = express.Router();

// Minimum password length. The previous value was 6, which is trivially
// brute-forced against an unauthenticated endpoint that also has a rate
// limit keyed on IP alone (INF-15 / AUTH-13). Existing accounts keep
// working: this only applies to newly set passwords.
const MIN_PASSWORD_LENGTH = 8;
// bcrypt only uses the first 72 bytes. Refusing longer values avoids a
// silent truncation surprise and caps the CPU cost of a request.
const MAX_PASSWORD_BYTES = 72;
const MAX_USERNAME_LENGTH = 64;
const MAX_INSTANCE_NAME_LENGTH = 80;

function passwordBytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

// A real bcrypt hash of a value nobody can guess, used to keep the
// response time of a login identical whether or not the account exists
// (AUTH-06 — account enumeration through the bcrypt timing channel).
const DUMMY_HASH = '$2a$12$m/.N21b72XRY00f/XihZ5O5LlDIDKzCpIWs5fOkoqJHMG93LqINbe';

// -- One-time bootstrap token (AUTH-01) ------------------------
// POST /api/auth/setup is necessarily unauthenticated: it is how the
// first admin is created. It is NOT allowed to be a remote
// "claim the instance" button though. A random token is generated on
// first boot, written to data/setup-token (0600, outside the repo) and
// printed in the server console. The operator must paste it into the
// setup wizard. The token is single-use: it is deleted as soon as setup
// completes, and the DB refuses a second setup regardless.
const SETUP_TOKEN_FILE = path.join(DATA_DIR, 'setup-token');

function readSetupToken() {
  try {
    const st = fs.lstatSync(SETUP_TOKEN_FILE);
    // Never read through a symlink planted in the data directory.
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const raw = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim();
    return raw || null;
  } catch (_) { return null; }
}

/**
 * Return the current bootstrap token, generating it if needed.
 * Never re-generates while a valid one is on disk.
 *
 * Called at boot by server.js so the token exists before the first request
 * and can be printed in the startup banner — otherwise the operator has no
 * way to obtain it until they have already failed one setup attempt.
 */
function ensureSetupToken() {
  const existing = readSetupToken();
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    // Remove any stale entry (not its target) and create exclusively, so a
    // symlink planted in the data directory cannot redirect the token write.
    try { fs.rmSync(SETUP_TOKEN_FILE, { force: true }); } catch (_) {}
    fs.writeFileSync(SETUP_TOKEN_FILE, token + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(SETUP_TOKEN_FILE, 0o600); } catch (_) {}
  } catch (e) {
    console.error('[setup] Impossible d\'écrire le jeton de configuration:', e.message);
  }
  return token;
}

function consumeSetupToken() {
  try { fs.unlinkSync(SETUP_TOKEN_FILE); } catch (_) {}
}

// GET /api/auth/setup-status — is setup complete?
router.get('/setup-status', (req, res) => {
  const db = getDb();
  const done = db.isSetupDone();
  res.json({
    done,
    // Tells the wizard to show the bootstrap-token field. The token
    // itself is never sent over the network.
    tokenRequired: !done
  });
});

// POST /api/auth/setup — first-time setup wizard
router.post('/setup', setupLimiter, async (req, res) => {
  const db = getDb();
  if (db.isSetupDone()) {
    return res.status(409).json({ error: 'Configuration déjà effectuée' });
  }

  // Bootstrap token gate. Checked BEFORE any credential work so an
  // unauthenticated attacker cannot even reach the bcrypt path.
  const expected = ensureSetupToken();
  const provided = req.get('x-setup-token') || '';
  if (!safeEqual(provided, expected)) {
    db.logActivity({ action: 'setup_denied', user: 'anonymous', details: 'Jeton de configuration invalide ou absent' });
    return res.status(401).json({
      error: 'Jeton de configuration invalide. Lire le jeton dans la console du serveur au démarrage (ou dans backend/data/setup-token).'
    });
  }

  const { instance_name, username, password, language } = req.body || {};

  const uname = typeof username === 'string' ? username.trim() : '';
  if (uname.length < 3 || uname.length > MAX_USERNAME_LENGTH) {
    return res.status(400).json({ error: `Identifiant invalide (${3}-${MAX_USERNAME_LENGTH} caractères)` });
  }
  if (typeof password !== 'string') {
    return res.status(400).json({ error: 'Mot de passe invalide' });
  }
  const plain = password.trim();
  if (passwordBytes(plain) < MIN_PASSWORD_LENGTH || passwordBytes(plain) > MAX_PASSWORD_BYTES) {
    return res.status(400).json({ error: `Mot de passe invalide (${MIN_PASSWORD_LENGTH} à ${MAX_PASSWORD_BYTES} octets)` });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(uname)) return res.status(400).json({ error: 'Identifiant invalide (lettres, chiffres, _ et - uniquement)' });

  const instanceName = typeof instance_name === 'string'
    ? instance_name.trim().slice(0, MAX_INSTANCE_NAME_LENGTH)
    : '';

  // Whitelist language
  const lang = ['en', 'fr', 'de'].includes(language) ? language : 'en';

  try {
    // Async bcrypt: hashing no longer blocks the whole event loop (AUTH-07).
    const hash  = await bcrypt.hash(plain, 12);
    const user  = db.createUser({ username: uname, password_hash: hash, role: 'admin' });

    db.updateSettings({
      setup_done:    true,
      instance_name: instanceName || 'Nexus Bot Manager',
      language:      lang
    });
    // Second, independent lock that survives a database restore.
    db.markSetupCompleted();
    // The bootstrap token is single-use.
    consumeSetupToken();

    db.logActivity({ action: 'setup_complete', user: user.username, details: `Instance: ${db.getSettings().instance_name} (lang=${lang})` });

    const token = signToken(user);
    res.json({ token, username: user.username, role: user.role, instance_name: db.getSettings().instance_name, language: lang });
  } catch (e) {
    res.status(400).json({ error: sanitizeLogText(e.message) });
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Identifiants manquants' });
  }

  const db   = getDb();
  const ip   = req.ip;
  const lock = loginLockoutRemaining(username, ip);
  if (lock > 0) {
    const retry = Math.ceil(lock / 1000);
    res.set('Retry-After', String(retry));
    return res.status(429).json({
      error: `Compte temporairement verrouillé. Réessayez dans ${retry} secondes.`
    });
  }

  const user = db.getUserByUsername(String(username).trim());

  // Always run a bcrypt comparison, even for an unknown account, so the
  // response time does not reveal whether the account exists.
  const hash = user ? user.password_hash : DUMMY_HASH;
  let ok = false;
  try { ok = await bcrypt.compare(String(password).trim(), hash); }
  catch (_) { ok = false; }   // a malformed stored hash must not crash the process

  if (!user || !ok) {
    registerLoginFailure(username, ip);
    db.logActivity({ action: 'login_failed', user: String(username).slice(0, 64) });
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }

  clearLoginFailures(username, ip);
  db.updateUser(user.id, { last_login: new Date().toISOString() });
  db.logActivity({ action: 'login', user: user.username });

  const token = signToken(user);
  res.json({ token, username: user.username, role: user.role, instance_name: db.getSettings().instance_name });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const db   = getDb();
  const user = db.getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const settings = db.getSettings();
  res.json({
    id: user.id, username: user.username, role: user.role,
    last_login: user.last_login,
    instance_name: settings.instance_name,
    language: settings.language || 'en'
  });
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string')
    return res.status(400).json({ error: 'Mot de passe invalide' });
  const plainNew = newPassword.trim();
  if (passwordBytes(plainNew) < MIN_PASSWORD_LENGTH || passwordBytes(plainNew) > MAX_PASSWORD_BYTES)
    return res.status(400).json({ error: `Mot de passe invalide (${MIN_PASSWORD_LENGTH} à ${MAX_PASSWORD_BYTES} octets)` });

  const db   = getDb();
  const user = db.getUser(req.user.id);

  let currentOk = false;
  try { currentOk = await bcrypt.compare(String(currentPassword).trim(), user ? user.password_hash : ''); }
  catch (_) { currentOk = false; }
  if (!user || !currentOk)
    return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

  // trim() is applied on both login and setup: a password with leading or
  // trailing spaces can now always be typed back in consistently.
  let hash;
  try { hash = await bcrypt.hash(plainNew, 12); }
  catch (_) { return res.status(500).json({ error: 'Erreur serveur interne' }); }
  db.updateUser(user.id, { password_hash: hash });
  // Revoke every token issued with the old password (AUTH-03).
  db.revokeAllUserTokens(user.id);
  db.logActivity({ action: 'password_changed', user: user.username, details: 'Toutes les sessions ont été révoquées' });
  res.json({ message: 'Mot de passe modifié avec succès. Toutes les autres sessions ont été déconnectées.' });
});

// POST /api/auth/logout — revoke the token that was just presented.
router.post('/logout', requireAuth, (req, res) => {
  const db = getDb();
  // Use the token's real exp claim: a fixed 24 h window would under-live a
  // token configured with a longer JWT_EXPIRES_IN and stop revoking it early.
  const exp = Number(req.user.exp) || Math.floor(Date.now() / 1000) + 86400;
  db.revokeToken(req.user.jti, exp);
  db.logActivity({ action: 'logout', user: req.user.username });
  res.json({ message: 'Session révoquée' });
});

// POST /api/auth/language — change UI language
router.post('/language', requireAdmin, (req, res) => {
  const { language } = req.body || {};
  if (!['en', 'fr', 'de'].includes(language))
    return res.status(400).json({ error: 'Langue non supportée' });
  const db = getDb();
  db.updateSettings({ language });
  res.json({ ok: true, language });
});

module.exports = router;
module.exports.SETUP_TOKEN_FILE = SETUP_TOKEN_FILE;
module.exports.MIN_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH;
module.exports.MAX_PASSWORD_BYTES = MAX_PASSWORD_BYTES;
module.exports.MAX_USERNAME_LENGTH = MAX_USERNAME_LENGTH;
module.exports.ensureSetupToken = ensureSetupToken;
