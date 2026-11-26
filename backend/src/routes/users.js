'use strict';
/**
 * Administrator-only account management.
 *
 * A regular account can only reach the bots listed in allowed_bots; an
 * admin account keeps full access. Passwords are bcrypt-hashed here and
 * never returned by the API.
 */
const express = require('express');
const bcrypt  = require('bcryptjs');
const { requireAdmin } = require('../middleware/auth.middleware');
const { getDb } = require('../db/db');
const {
  normalizeDisplayName, normalizeAvatar, normalizeAllowedBots, publicUser
} = require('../services/user.service');
const { MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES, MAX_USERNAME_LENGTH } = require('./auth');

const router = express.Router();
router.use(requireAdmin);

function passwordBytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function validatePassword(value) {
  if (typeof value !== 'string') return 'Mot de passe invalide';
  const plain = value.trim();
  if (passwordBytes(plain) < MIN_PASSWORD_LENGTH || passwordBytes(plain) > MAX_PASSWORD_BYTES) {
    return `Mot de passe invalide (${MIN_PASSWORD_LENGTH} à ${MAX_PASSWORD_BYTES} octets)`;
  }
  return null;
}

function validateUsername(value) {
  const uname = typeof value === 'string' ? value.trim() : '';
  if (uname.length < 3 || uname.length > MAX_USERNAME_LENGTH) {
    return { error: `Identifiant invalide (${3}-${MAX_USERNAME_LENGTH} caractères)` };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(uname)) {
    return { error: 'Identifiant invalide (lettres, chiffres, _ et - uniquement)' };
  }
  return { value: uname };
}

function adminCount() {
  return getDb().getAllUsers().filter(u => u.role === 'admin').length;
}

// GET /api/users
router.get('/', (req, res) => {
  const users = getDb().getAllUsers()
    .map(publicUser)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  res.json(users);
});

// POST /api/users
router.post('/', async (req, res) => {
  const body = req.body || {};
  const parsed = validateUsername(body.username);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const pwdError = validatePassword(body.password);
  if (pwdError) return res.status(400).json({ error: pwdError });

  const display = body.display_name === undefined || body.display_name === ''
    ? parsed.value
    : normalizeDisplayName(body.display_name);
  if (!display) return res.status(400).json({ error: 'Nom affiché invalide (1-80 caractères)' });

  const av = normalizeAvatar(body.avatar);
  if (av.invalid) return res.status(400).json({ error: 'Avatar invalide (PNG/JPEG/WebP/GIF, max 512 Ko)' });

  const role = body.role === 'admin' ? 'admin' : 'user';
  const db = getDb();
  const allowed = normalizeAllowedBots(role === 'user' ? body.allowed_bots : [], db);
  if (allowed.invalid) return res.status(400).json({ error: 'Liste de bots autorisés invalide' });

  try {
    const hash = await bcrypt.hash(body.password.trim(), 12);
    const user = db.createUser({
      username: parsed.value,
      password_hash: hash,
      role,
      display_name: display,
      avatar: av.value,
      allowed_bots: allowed.value || [],
      language: db.getSettings().language || 'en'
    }, { allowAfterSetup: true });
    db.logActivity({ action: 'user_created', user: req.user.username, details: `${user.username} (${role})` });
    res.status(201).json(publicUser(user));
  } catch (e) {
    if (/already exists/i.test(e.message)) return res.status(409).json({ error: 'Identifiant déjà utilisé' });
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/users/:id
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });
  const db = getDb();
  const user = db.getUser(id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const body = req.body || {};
  const patch = {};

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
  if (body.role !== undefined) {
    if (!['admin', 'user'].includes(body.role)) {
      return res.status(400).json({ error: 'Rôle invalide' });
    }
    if (user.role === 'admin' && body.role !== 'admin' && adminCount() <= 1) {
      return res.status(400).json({ error: 'Le dernier administrateur ne peut pas être rétrogradé' });
    }
    patch.role = body.role;
  }
  if (body.allowed_bots !== undefined) {
    const role = patch.role || user.role;
    const allowed = normalizeAllowedBots(role === 'user' ? body.allowed_bots : [], db);
    if (allowed.invalid) return res.status(400).json({ error: 'Liste de bots autorisés invalide' });
    patch.allowed_bots = allowed.value || [];
  }

  const previousRole = user.role;
  const updated = db.updateUser(id, patch);
  // A role change must not leave old sessions carrying the previous role.
  if (patch.role && patch.role !== previousRole) db.revokeAllUserTokens(id);
  db.logActivity({ action: 'user_updated', user: req.user.username, details: user.username });
  res.json(publicUser(updated));
});

// POST /api/users/:id/password
router.post('/:id/password', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });
  const db = getDb();
  const user = db.getUser(id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const pwdError = validatePassword((req.body || {}).password);
  if (pwdError) return res.status(400).json({ error: pwdError });

  try {
    const hash = await bcrypt.hash(req.body.password.trim(), 12);
    db.updateUser(id, { password_hash: hash });
    db.revokeAllUserTokens(id);
    db.logActivity({ action: 'user_password_reset', user: req.user.username, details: user.username });
    res.json({ ok: true });
  } catch (_) {
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// DELETE /api/users/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });
  if (id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });

  const db = getDb();
  const user = db.getUser(id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (user.role === 'admin' && adminCount() <= 1) {
    return res.status(400).json({ error: 'Le dernier administrateur ne peut pas être supprimé' });
  }

  db.deleteUser(id);
  db.logActivity({ action: 'user_deleted', user: req.user.username, details: user.username });
  res.json({ ok: true });
});

module.exports = router;
