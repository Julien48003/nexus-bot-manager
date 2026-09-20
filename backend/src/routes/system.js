'use strict';
const express   = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { getDb }       = require('../db/db');
const { getSystemInfo } = require('../services/system.service');
const templatesSvc      = require('../services/templates.service');

const router = express.Router();
router.use(requireAuth);

// GET /api/system/info
router.get('/info', async (req, res) => {
  try {
    const info = await getSystemInfo();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
router.patch('/settings', (req, res) => {
  const allowed = ['instance_name', 'theme', 'language', 'bot_autorestart', 'bot_max_restarts', 'monitoring_interval', 'notifications_enabled'];
  const patch = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  const updated = getDb().updateSettings(patch);
  res.json(updated);
});

// GET /api/system/templates
router.get('/templates', (req, res) => {
  res.json({
    templates:  templatesSvc.getAllTemplates(),
    categories: templatesSvc.getCategories()
  });
});

// GET /api/system/templates/:id
router.get('/templates/:id', (req, res) => {
  const tpl = templatesSvc.getTemplate(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template introuvable' });
  // Return full template including envVars for setup wizard
  res.json(tpl);
});

module.exports = router;
