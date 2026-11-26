'use strict';
/**
 * Lightweight PM2 watcher used for webhook notifications.
 *
 * The UI already receives live PM2 status over Socket.IO, but a webhook must
 * also fire when nobody has the panel open. This watcher records a bot_errored
 * activity entry (and therefore a webhook event) when a process transitions
 * to PM2's errored state.
 */
const pm2Service = require('./pm2.service');
const { getDb } = require('../db/db');

const previous = new Map();
let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const list = await pm2Service.list();
    const seen = new Set();
    for (const proc of list) {
      const name = String(proc.name || '');
      if (!name) continue;
      seen.add(name);
      const status = proc.pm2_env?.status || 'unknown';
      const restarts = Number(proc.pm2_env?.restart_time) || 0;
      const before = previous.get(name);
      if (before && status === 'errored' && before.status !== 'errored') {
        getDb().logActivity({
          action: 'bot_errored',
          bot_name: name,
          user: 'system',
          details: `PM2 status: errored (restarts: ${restarts})`
        });
      }
      previous.set(name, { status, restarts });
    }
    for (const name of previous.keys()) {
      if (!seen.has(name)) previous.delete(name);
    }
  } catch (_) {
    // PM2 can be temporarily unavailable during an update; the next tick
    // simply tries again.
  } finally {
    running = false;
  }
}

function schedule() {
  if (timer) return;
  const interval = Math.max(5, Number(getDb().getSettings().monitoring_interval) || 5) * 1000;
  timer = setTimeout(async () => {
    timer = null;
    await tick();
    schedule();
  }, interval);
  if (timer.unref) timer.unref();
}

function startBotMonitor() {
  // The test suite and installers that deliberately avoid PM2 set this flag.
  if (process.env.NEXUS_DISABLE_AUTOSTART === '1') return;
  schedule();
}

function stopBotMonitor() {
  if (timer) { clearTimeout(timer); timer = null; }
}

module.exports = { startBotMonitor, stopBotMonitor, _tick: tick };
