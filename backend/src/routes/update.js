'use strict';
/**
 * Nexus Bot Manager — Update routes
 *
 * All endpoints require auth. No shell access from the frontend:
 *  - The only script we ever spawn is the trusted scripts/update.sh.
 *  - The frontend cannot choose any URL, command or branch.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const updateSvc = require('../services/update.service');
const versionSvc = require('../services/version.service');

const router = express.Router();
router.use(requireAuth);

// GET /api/update/status — full status incl. current progress if running
router.get('/status', (req, res) => {
  res.json(updateSvc.getStatus());
});

// GET /api/update/version — minimal version only (used by footer / sidebar)
router.get('/version', (req, res) => {
  res.json(versionSvc.loadLocal());
});

// POST /api/update/check — triggers a GitHub check (no body required)
router.post('/check', async (req, res) => {
  try {
    const result = await updateSvc.checkForUpdates();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/update/perform — starts the update (locked if one is in progress)
// The frontend must first call /check and confirm the version is actually newer.
router.post('/perform', async (req, res) => {
  // Defense in depth: refuse any unexpected payload
  if (req.body && Object.keys(req.body).length > 0) {
    return res.status(400).json({ error: 'Aucun paramètre attendu' });
  }
  try {
    const result = await updateSvc.startUpdate();
    res.json(result);
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

// POST /api/update/acknowledge — frontend tells the backend it saw the result
router.post('/acknowledge', (req, res) => {
  updateSvc.acknowledge();
  res.json({ ok: true });
});

module.exports = router;