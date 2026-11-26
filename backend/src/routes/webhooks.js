'use strict';
const express = require('express');
const { requireAdmin } = require('../middleware/auth.middleware');
const { getDb } = require('../db/db');
const { sanitizeLogText } = require('../middleware/security');
const webhookSvc = require('../services/webhook.service');

const router = express.Router();
router.use(requireAdmin);

function normalizeName(value) {
  const clean = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!clean || clean.length > 80) return null;
  return clean;
}

function parseId(value) {
  const id = parseInt(value, 10);
  return Number.isFinite(id) ? id : null;
}

// GET /api/webhooks/events
router.get('/events', (req, res) => {
  res.json({ groups: webhookSvc.EVENT_GROUPS });
});

// GET /api/webhooks
router.get('/', (req, res) => {
  res.json(getDb().getAllWebhooks().map(webhookSvc.publicWebhook));
});

// POST /api/webhooks
router.post('/', (req, res) => {
  const body = req.body || {};
  const name = normalizeName(body.name);
  if (!name) return res.status(400).json({ error: 'Nom invalide (1-80 caractères)' });
  const url = webhookSvc.normalizeUrl(body.url);
  if (!url) return res.status(400).json({ error: 'URL invalide (http ou https uniquement)' });
  const events = webhookSvc.normalizeEvents(body.events);
  if (!events) return res.status(400).json({ error: 'Sélection d’événements invalide' });
  if (events.length === 0) return res.status(400).json({ error: 'Sélectionnez au moins un événement' });

  const hook = getDb().createWebhook({
    name,
    url,
    events,
    enabled: body.enabled !== false
  });
  getDb().logActivity({ action: 'webhook_created', user: req.user.username, details: name });
  res.status(201).json(webhookSvc.publicWebhook(hook));
});

// PATCH /api/webhooks/:id
router.patch('/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'ID invalide' });
  const db = getDb();
  const hook = db.getWebhook(id);
  if (!hook) return res.status(404).json({ error: 'Webhook introuvable' });

  const body = req.body || {};
  const patch = {};
  if (body.name !== undefined) {
    const name = normalizeName(body.name);
    if (!name) return res.status(400).json({ error: 'Nom invalide (1-80 caractères)' });
    patch.name = name;
  }
  if (body.url !== undefined) {
    const url = webhookSvc.normalizeUrl(body.url);
    if (!url) return res.status(400).json({ error: 'URL invalide (http ou https uniquement)' });
    patch.url = url;
  }
  if (body.events !== undefined) {
    const events = webhookSvc.normalizeEvents(body.events);
    if (!events || events.length === 0) return res.status(400).json({ error: 'Sélectionnez au moins un événement' });
    patch.events = events;
  }
  if (body.enabled !== undefined) patch.enabled = body.enabled === true;

  const updated = db.updateWebhook(id, patch);
  db.logActivity({ action: 'webhook_updated', user: req.user.username, details: updated.name });
  res.json(webhookSvc.publicWebhook(updated));
});

// DELETE /api/webhooks/:id
router.delete('/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'ID invalide' });
  const db = getDb();
  const hook = db.getWebhook(id);
  if (!hook) return res.status(404).json({ error: 'Webhook introuvable' });
  db.deleteWebhook(id);
  db.logActivity({ action: 'webhook_deleted', user: req.user.username, details: hook.name });
  res.json({ ok: true });
});

// POST /api/webhooks/:id/test
router.post('/:id/test', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'ID invalide' });
  const hook = getDb().getWebhook(id);
  if (!hook) return res.status(404).json({ error: 'Webhook introuvable' });
  const result = await webhookSvc.testWebhook(hook);
  if (!result.ok) {
    return res.status(502).json({
      error: result.error || 'Livraison échouée',
      status: result.status
    });
  }
  res.json({ ok: true, status: result.status });
});

module.exports = router;
