'use strict';
const si  = require('systeminformation');
const { execFileSync } = require('child_process');
const { SAFE_ENV } = require('../middleware/security');
const os  = require('os');

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 5000; // 5s cache for system info

async function getSystemInfo(force = false) {
  if (!force && _cache && (Date.now() - _cacheTs) < CACHE_TTL) return _cache;

  try {
    const [cpuLoad, mem, disk, osInfo] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.osInfo()
    ]);

    const optDisk = disk.find(d => d.mount === (process.env.BOTS_ROOT || '/opt'))
      || disk.find(d => d.mount === '/')
      || disk[0];

    const getVer = (bin, args) => {
      try { return execFileSync(bin, args, { timeout: 2000, env: SAFE_ENV, shell: false }).toString().trim(); }
      catch { return 'N/A'; }
    };

    _cache = {
      cpu: {
        load: Math.round(cpuLoad.currentLoad * 10) / 10,
        cores: os.cpus().length,
        model: os.cpus()[0]?.model?.split('@')[0]?.trim() || 'Unknown'
      },
      memory: {
        used:  Math.round(mem.used  / 1024 / 1024 / 1024 * 10) / 10,
        total: Math.round(mem.total / 1024 / 1024 / 1024 * 10) / 10,
        pct:   Math.round(mem.used / mem.total * 100)
      },
      disk: {
        used:  Math.round((optDisk?.used  || 0) / 1024 / 1024 / 1024 * 10) / 10,
        total: Math.round((optDisk?.size  || 0) / 1024 / 1024 / 1024 * 10) / 10,
        pct:   optDisk ? Math.round(optDisk.use) : 0,
        mount: optDisk?.mount || '/'
      },
      os: {
        platform: osInfo.platform,
        distro:   osInfo.distro,
        release:  osInfo.release,
        hostname: osInfo.hostname || os.hostname()
      },
      versions: {
        node: process.version,
        npm:  getVer('npm', ['--version']),
        pm2:  getVer('pm2', ['--version'])
      },
      uptime: {
        seconds: Math.floor(os.uptime()),
        days:    Math.floor(os.uptime() / 86400),
        hours:   Math.floor((os.uptime() % 86400) / 3600),
        minutes: Math.floor((os.uptime() % 3600) / 60)
      }
    };
    _cacheTs = Date.now();
    return _cache;
  } catch (e) {
    console.error('[system] Info error:', e.message);
    return _cache || { cpu:{load:0,cores:1,model:'?'}, memory:{used:0,total:0,pct:0}, disk:{used:0,total:0,pct:0,mount:'/'}, os:{hostname:os.hostname(),distro:'Linux'}, versions:{node:process.version,npm:'?',pm2:'?'}, uptime:{seconds:0,days:0,hours:0,minutes:0} };
  }
}

module.exports = { getSystemInfo };
