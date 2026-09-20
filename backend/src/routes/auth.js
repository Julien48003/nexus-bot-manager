'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { getDb }        = require('../db/db');
const { loginLimiter } = require('../middleware/security');
const { requireAuth }  = require('../middleware/auth.middleware');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );
}

// GET /api/auth/setup-status — is setup complete?
router.get('/setup-status', (req, res) => {
  const db = getDb();
  res.json({ done: db.isSetupDone() });
});

// POST /api/auth/setup — first-time setup wizard
router.post('/setup', (req, res) => {
  const db = getDb();
  if (db.isSetupDone()) {
    return res.status(409).json({ error: 'Configuration déjà effectuée' });
  }

  const { instance_name, username, password } = req.body;

  if (!username || username.length < 3) return res.status(400).json({ error: 'Identifiant trop court (min. 3 caractères)' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min. 6 caractères)' });
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return res.status(400).json({ error: 'Identifiant invalide (lettres, chiffres, _ et - uniquement)' });

  try {
    const hash = bcrypt.hashSync(password.trim(), 12);
    const user = db.createUser({ username: username.trim(), password_hash: hash, role: 'admin' });

    db.updateSettings({
      setup_done:    true,
      instance_name: instance_name?.trim() || 'Nexus Bot Manager'
    });

    db.logActivity({ action: 'setup_complete', user: user.username, details: `Instance: ${db.getSettings().instance_name}` });

    const token = signToken(user);
    res.json({ token, username: user.username, role: user.role, instance_name: db.getSettings().instance_name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Identifiants manquants' });

  const db   = getDb();
  const user = db.getUserByUsername(username.trim());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }

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
    last_login: user.last_login, instance_name: settings.instance_name
  });
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 6)
    return res.status(400).json({ error: 'Mot de passe invalide (min. 6 caractères)' });

  const db   = getDb();
  const user = db.getUser(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash))
    return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

  db.updateUser(user.id, { password_hash: bcrypt.hashSync(newPassword, 12) });
  db.logActivity({ action: 'password_changed', user: user.username });
  res.json({ message: 'Mot de passe modifié avec succès' });
});

module.exports = router;
