'use strict';
/**
 * Outgoing webhooks for notable panel events.
 *
 * Webhooks are configured by an administrator and delivered as a JSON POST.
 * Delivery is fire-and-forget: a slow or broken endpoint must never delay a
 * login, a bot action or an API response. Each delivery updates the webhook's
 * last status so the UI can show the result.
 */
const { getDb } = require('../db/db');

const MAX_URL_LENGTH = 2000;
const DELIVERY_TIMEOUT_MS = 10000;

const EVENT_GROUPS = [
  {
    id: 'bots',
    events: [
      'bot_created', 'bot_deleted', 'bot_started', 'bot_stopped', 'bot_restarted',
      'bot_updated', 'bot_errored', 'bot_env_updated',
      'bot_snapshot_created', 'bot_snapshot_restored', 'bot_snapshot_deleted',
      'bot_exported', 'bot_imported'
    ]
  },
  {
    id: 'auth',
    events: ['login', 'login_failed', 'logout', 'logout_all', 'password_changed', 'profile_updated']
  },
  {
    id: 'users',
    events: ['user_created', 'user_updated', 'user_deleted', 'user_password_reset']
  },
  {
    id: 'system',
    events: ['setup_complete', 'mcp_token_rotated', 'bot_deps_reinstalled']
  }
];

const SUPPORTED_EVENTS = new Set(EVENT_GROUPS.flatMap(group => group.events));

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

function normalizeEvents(value) {
  if (!Array.isArray(value) || value.length > SUPPORTED_EVENTS.size) return null;
  const unique = [];
  for (const raw of value) {
    const event = String(raw || '');
    if (!SUPPORTED_EVENTS.has(event)) return null;
    if (!unique.includes(event)) unique.push(event);
  }
  return unique;
}

function publicWebhook(hook) {
  return {
    id:               hook.id,
    name:             hook.name,
    url:              hook.url,
    events:           Array.isArray(hook.events) ? [...hook.events] : [],
    enabled:          hook.enabled === true,
    created_at:       hook.created_at,
    last_delivery_at: hook.last_delivery_at || null,
    last_status:      hook.last_status || null,
    last_error:       hook.last_error || null
  };
}

function buildPayload(activity, instanceName) {
  return {
    app:       'Nexus Bot Manager',
    instance:  instanceName,
    event:     activity.action,
    timestamp: activity.created_at || new Date().toISOString(),
    activity: {
      id:         activity.id || null,
      action:     activity.action,
      bot_name:   activity.bot_name || null,
      details:    activity.details || '',
      user:       activity.user || 'system',
      created_at: activity.created_at || new Date().toISOString()
    }
  };
}

async function deliver(hook, activity, instanceName, db = getDb()) {
  const payload = buildPayload(activity, instanceName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  let status = null;
  let error = null;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Nexus-Bot-Manager',
        'X-Nexus-Event': activity.action
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e && e.name === 'AbortError' ? 'Timeout' : (e.message || 'Erreur réseau');
  } finally {
    clearTimeout(timer);
  }
  try {
    if (db.getWebhook(hook.id)) {
      db.updateWebhook(hook.id, {
        last_delivery_at: new Date().toISOString(),
        last_status: status,
        last_error: error
      });
    }
  } catch (_) {}
  return { ok: !error, status, error };
}

/** Called from NexusDB.logActivity for every recorded action. */
function dispatchActivity(activity, db = getDb()) {
  if (!activity || !activity.action || !SUPPORTED_EVENTS.has(activity.action)) return;
  let hooks;
  let instanceName;
  try {
    hooks = db.getAllWebhooks().filter(hook => hook.enabled && Array.isArray(hook.events) && hook.events.includes(activity.action));
    instanceName = db.getSettings().instance_name || 'Nexus Bot Manager';
  } catch (_) { return; }
  if (!hooks.length) return;
  // Deliberately not awaited: logActivity is called from request handlers.
  Promise.allSettled(hooks.map(hook => deliver(hook, activity, instanceName, db))).catch(() => {});
}

async function testWebhook(hook) {
  const db = getDb();
  return deliver(hook, {
    id: null,
    action: 'test',
    bot_name: null,
    details: 'Test from Nexus Bot Manager',
    user: 'system',
    created_at: new Date().toISOString()
  }, db.getSettings().instance_name || 'Nexus Bot Manager', db);
}

module.exports = {
  EVENT_GROUPS,
  SUPPORTED_EVENTS,
  normalizeUrl,
  normalizeEvents,
  publicWebhook,
  dispatchActivity,
  testWebhook
};
