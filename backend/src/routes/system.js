'use strict';
const express   = require('express');
const crypto    = require('crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');
const { sanitizeLogText } = require('../middleware/security');
const { getDb }       = require('../db/db');
const { getSystemInfo } = require('../services/system.service');
const templatesSvc      = require('../services/templates.service');

const router = express.Router();
router.use(requireAdmin);

// GET /api/system/info
router.get('/info', async (req, res) => {
  try {
    const info = await getSystemInfo();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: sanitizeLogText(e.message) });
  }
});

// GET /api/system/activity
router.get('/activity', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  res.json(getDb().getActivity(limit));
});

// GET /api/system/settings
router.get('/settings', (req, res) => {
  res.json(getDb().getSettings());
});

// PATCH /api/system/settings
// The allowlist already prevents mass assignment; admin-only and typed
// values keep a stray request from storing nonsense in the settings that
// drive the running configuration.
router.patch('/settings', requireAdmin, (req, res) => {
  const allowed = ['instance_name', 'theme', 'language', 'bot_autorestart', 'bot_max_restarts', 'monitoring_interval', 'notifications_enabled', 'mcp_enabled'];
  const patch = {};
  const body  = req.body || {};
  for (const k of allowed) {
    if (body[k] === undefined) continue;
    const v = body[k];
    if (['bot_autorestart', 'notifications_enabled', 'mcp_enabled'].includes(k)) {
      patch[k] = !!v;
    } else if (k === 'bot_max_restarts' || k === 'monitoring_interval') {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1 || n > 999) return res.status(400).json({ error: `Valeur invalide pour ${k}` });
      patch[k] = n;
    } else if (k === 'language') {
      if (!['en', 'fr', 'de'].includes(v)) return res.status(400).json({ error: 'Langue non supportée' });
      patch[k] = v;
    } else if (k === 'theme') {
      if (!['dark', 'light', 'system'].includes(v)) return res.status(400).json({ error: 'Thème non supporté' });
      patch[k] = v;
    } else {
      patch[k] = String(v).slice(0, 120);
    }
  }
  if (patch.mcp_enabled && !getDb().getSettings().mcp_token) {
    patch.mcp_token = crypto.randomBytes(32).toString('hex');
  }
  const updated = getDb().updateSettings(patch);
  res.json(updated);
});

// POST /api/system/mcp/token
// Rotate the bearer token used by the /mcp endpoint.
router.post('/mcp/token', requireAdmin, (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const updated = getDb().updateSettings({ mcp_token: token });
  getDb().logActivity({ action: 'mcp_token_rotated', user: req.user.username });
  res.json({ token, settings: updated });
});

// GET /api/system/templates[?lang=fr|en|de]
// The `lang` query parameter selects the language used to localize
// the template metadata (name, description, features, difficulty).
// Default = the language associated with the authenticated user, or 'en'.
router.get('/templates', (req, res) => {
  const lang = pickLang(req.query.lang, req.user && req.user.language);
  res.json({
    templates:  templatesSvc.getAllTemplates(lang),
    categories: templatesSvc.getCategories(lang),
    language:   lang
  });
});

function pickLang(qLang, userLang) {
  const candidates = [qLang, userLang, 'en'];
  for (const c of candidates) {
    if (typeof c === 'string' && ['fr', 'en', 'de'].includes(c.toLowerCase())) {
      return c.toLowerCase();
    }
  }
  return 'en';
}

// GET /api/system/templates/:id
router.get('/templates/:id', (req, res) => {
  const tpl = templatesSvc.getTemplate(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template introuvable' });
  // Return full template including envVars for setup wizard
  res.json(tpl);
});

module.exports = router;
