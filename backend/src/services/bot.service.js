'use strict';
/**
 * Nexus Bot Manager — Bot host helpers.
 *
 * PM2 resurrects the whole dump on boot, which restores every process
 * regardless of the per-bot "start on boot" option. Reconcile the two
 * after the panel is up: start the bots that opted in, stop the ones that
 * opted out. The flag is stored in the database (data/nexus.db.json).
 */
const fs   = require('fs');
const path = require('path');

const { getDb } = require('../db/db');
const pm2Service = require('./pm2.service');
const fsService  = require('./fs.service');

async function reconcileAutostart() {
  const bots = getDb().getAllBots();
  if (!bots.length) return { started: [], stopped: [] };

  const list = await pm2Service.list();
  const byName = new Map(list.map(p => [p.name, p]));
  const started = [];
  const stopped = [];

  for (const bot of bots) {
    const bPath = fsService.botPath(bot.name);
    if (!fs.existsSync(bPath)) continue;

    const entry = bot.startup_file || 'index.js';
    if (!fs.existsSync(path.join(bPath, entry))) continue;

    const proc = byName.get(bot.name);
    const online = proc?.pm2_env?.status === 'online';
    const wants = bot.autostart === true;

    try {
      if (wants && !online) {
        await pm2Service.start(bot.name, bPath, {
          script: entry,
          maxMemory: bot.memory_limit,
          cronRestart: bot.restart_cron
        });
        getDb().updateBot(bot.name, { last_started: new Date().toISOString() });
        started.push(bot.name);
      } else if (!wants && online) {
        await pm2Service.stop(bot.name);
        stopped.push(bot.name);
      }
    } catch (e) {
      console.warn(`[autostart] ${bot.name}: ${e.message}`);
    }
  }

  if (started.length) console.log(`[autostart] démarrés : ${started.join(', ')}`);
  if (stopped.length) console.log(`[autostart] arrêtés (option désactivée) : ${stopped.join(', ')}`);
  return { started, stopped };
}

module.exports = { reconcileAutostart };
