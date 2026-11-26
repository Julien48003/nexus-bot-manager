'use strict';
const express = require('express');
const { requireAdmin } = require('../middleware/auth.middleware');
const { getDb } = require('../db/db');
const exportSvc = require('../services/export.service');

const router = express.Router();
router.use(requireAdmin);

// GET /api/export/settings — JSON configuration without auth secrets.
router.get('/settings', (req, res) => {
  const data = exportSvc.settingsExport();
  const date = data.exported_at.slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="nexus-settings-${date}.json"`);
  res.send(JSON.stringify(data, null, 2));
  getDb().logActivity({
    action: 'panel_exported_settings',
    user: req.user.username,
    details: 'settings export'
  });
});

// GET /api/export/full — complete ZIP backup (raw database, bots, snapshots).
router.get('/full', (req, res) => {
  exportSvc.streamFullExport(res, req.user.username);
});

module.exports = router;
