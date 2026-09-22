'use strict';
/**
 * Nexus Bot Manager — Update service
 *
 * Responsibilities:
 *  - Manage a persistent "update state" file (status, steps, log)
 *  - Ensure only one update runs at a time (lockfile)
 *  - Download the new release from GitHub into a temp directory
 *  - Spawn the existing scripts/update.sh with proper arguments
 *  - Capture progress from the script's progress file
 *  - Detect a restart after the update so the UI can re-fetch status
 *
 * The script writes JSON progress lines to UPDATE_PROGRESS_FILE.
 * We poll this file to track steps.
 *
 * On restart, the script also writes UPDATE_PENDING_FILE so the backend
 * knows the running version is newer than the one it had at boot.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');
const { execFile } = require('child_process');
const versionSvc = require('./version.service');

// Persistent state (lives next to the DB so it survives restarts)
const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const LOCK_FILE = path.join(DATA_DIR, 'update.lock');
const STATE_FILE = path.join(DATA_DIR, 'update-state.json');

// Paths the update script reads/writes
const INSTALL_DIR        = process.env.INSTALL_DIR || '/opt/nexus-bot-manager';
const UPDATE_SCRIPT      = path.join(INSTALL_DIR, 'scripts', 'update.sh');
const UPDATE_PROGRESS    = path.join(DATA_DIR, 'update.progress.json');
const UPDATE_PENDING     = path.join(DATA_DIR, 'update.pending.json');

// Steps the frontend will display (must match the script)
const STEPS = [
  { id: 'preflight',    label: 'Vérifications préalables' },
  { id: 'backup',       label: 'Sauvegarde de la configuration' },
  { id: 'fetch',        label: 'Téléchargement de la nouvelle version' },
  { id: 'stop',         label: 'Arrêt du service' },
  { id: 'apply',        label: 'Application des fichiers' },
  { id: 'dependencies', label: 'Installation des dépendances' },
  { id: 'syntax',       label: 'Vérification de la syntaxe' },
  { id: 'restart',      label: 'Redémarrage du service' },
  { id: 'verify',       label: 'Vérification du service' },
  { id: 'finalize',     label: 'Finalisation' }
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return null; }
}
function writeState(s) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function readProgress() {
  try { return JSON.parse(fs.readFileSync(UPDATE_PROGRESS, 'utf8')); }
  catch (_) { return null; }
}

// ── Lock helpers ──────────────────────────────────────────
function isLocked() {
  try {
    const stat = fs.statSync(LOCK_FILE);
    // A stale lock (>30 min) is treated as a crashed process and ignored
    if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) return false;
    return true;
  } catch (_) { return false; }
}
function lock()   { ensureDataDir(); fs.writeFileSync(LOCK_FILE, String(process.pid)); }
function unlock() { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} }

// ── Pending (post-restart) ────────────────────────────────
function setPending(remoteVersion) {
  ensureDataDir();
  fs.writeFileSync(UPDATE_PENDING, JSON.stringify({
    expectedVersion: remoteVersion,
    startedAt:       Date.now()
  }, null, 2));
}
function consumePending() {
  try {
    const data = JSON.parse(fs.readFileSync(UPDATE_PENDING, 'utf8'));
    fs.unlinkSync(UPDATE_PENDING);
    return data;
  } catch (_) { return null; }
}

// ── Public API ────────────────────────────────────────────

/**
 * Return the current local + (cached) remote state.
 */
function getStatus() {
  const local = versionSvc.loadLocal();
  const state = readState() || {
    status: 'idle',
    lastCheck: null,
    remoteVersion: null,
    updateAvailable: false
  };
  // Compute current status (may have advanced past restart)
  const progress = readProgress();
  let live = { ...state };
  if (progress && progress.steps) {
    live.steps = progress.steps;
    live.currentStep = progress.currentStep;
    live.percent = progress.percent || 0;
    live.status = progress.status || 'running';
    live.message = progress.message || '';
  }
  return {
    local: local,
    ...live,
    pending: !!consumePending() && false // peek only via checkPendingRestart
  };
}

/**
 * Check GitHub, cache the result, and return it.
 */
async function checkForUpdates() {
  const local = versionSvc.loadLocal();
  let remote = null, error = null;
  try {
    remote = await versionSvc.checkRemoteVersion();
  } catch (e) {
    error = e.message;
  }

  const state = {
    status: 'idle',
    lastCheck: new Date().toISOString(),
    remoteVersion: remote?.version || null,
    remoteUrl:     remote?.html_url || null,
    remoteSource:  remote?.source || null,
    remotePublishedAt: remote?.published_at || null,
    updateAvailable: false,
    checkError: error
  };
  if (remote) {
    // versionSvc exports compareVersions(a, b) which returns -1 / 0 / 1.
    // The local version is older than the remote one when compareVersions < 0.
    state.updateAvailable = versionSvc.compareVersions(local.version, remote.version) < 0;
    state.status = state.updateAvailable ? 'update_available' : 'up_to_date';
  } else {
    state.status = 'check_failed';
  }

  writeState(state);
  return state;
}

/**
 * Start the update. Throws if one is already running or if no update is available.
 * The script runs asynchronously; progress is read from the progress file.
 *
 * Two-phase: first download the archive (synchronous, awaitable for better errors),
 * then spawn the script with the source tree path in the env.
 */
async function startUpdate({ targetVersion } = {}) {
  if (isLocked()) {
    throw new Error('Une mise à jour est déjà en cours');
  }
  const state = readState();
  if (!state || !state.remoteVersion) {
    throw new Error('Aucune vérification distante récente — vérifiez d\'abord les mises à jour');
  }
  if (!state.updateAvailable) {
    throw new Error('Aucune mise à jour disponible');
  }
  if (!fs.existsSync(UPDATE_SCRIPT)) {
    throw new Error(`Script de mise à jour introuvable : ${UPDATE_SCRIPT}`);
  }
  // Defense in depth: ensure the version looks like a semver string
  // (avoids bizarre values in URL construction downstream).
  if (!/^\d{1,3}(\.\d{1,3}){0,3}([-+][0-9A-Za-z.+-]+)?$/.test(state.remoteVersion)) {
    throw new Error('Numéro de version distante invalide');
  }
  // Re-confirm the version is actually newer than local (defense vs. stale state)
  const local = versionSvc.loadLocal();
  if (versionSvc.compareVersions(local.version, state.remoteVersion) >= 0) {
    throw new Error('La version distante n\'est pas plus récente que la version locale');
  }

  // Mark pending so we know we expect a restart
  setPending(state.remoteVersion);

  // Initialize progress (will be filled in the script)
  const initial = {
    status: 'running',
    startedAt: Date.now(),
    fromVersion: local.version,
    toVersion:   state.remoteVersion,
    currentStep: 'preflight',
    percent:     0,
    message:     'Préparation…',
    steps: STEPS.map(s => ({ ...s, status: 'pending', at: null, error: null }))
  };
  ensureDataDir();
  fs.writeFileSync(UPDATE_PROGRESS, JSON.stringify(initial, null, 2));

  // Lock + download + spawn
  lock();

  let sourceTree;
  try {
    sourceTree = await fetchReleaseSource(state.remoteVersion, versionSvc.GITHUB_OWNER, versionSvc.GITHUB_REPO);
  } catch (e) {
    unlock();
    const prog = readProgress() || {};
    prog.status = 'failed';
    prog.error  = e.message;
    prog.message = 'Téléchargement échoué';
    prog.finishedAt = Date.now();
    fs.writeFileSync(UPDATE_PROGRESS, JSON.stringify(prog, null, 2));
    writeState({ ...readState(), status: 'failed', lastError: e.message });
    throw e;
  }

  const child = execFile('bash', [UPDATE_SCRIPT, '--from-version', state.remoteVersion], {
    cwd: INSTALL_DIR,
    env: {
      ...process.env,
      NEXUS_FROM_VERSION:    local.version,
      NEXUS_TO_VERSION:      state.remoteVersion,
      NEXUS_UPDATE_SOURCE:   sourceTree,
      NEXUS_PROGRESS_FILE:   UPDATE_PROGRESS
    },
    timeout: 30 * 60 * 1000 // 30 minutes max
  }, (err) => {
    // Script finished (success or failure)
    unlock();
    let prog = readProgress() || {};
    if (err) {
      prog.status  = 'failed';
      prog.error   = (err.message || 'Erreur inconnue').split('\n')[0];
      prog.message = 'Échec de la mise à jour';
      writeState({ ...readState(), status: 'failed', lastError: prog.error });
    } else {
      prog.status  = 'success';
      prog.percent = 100;
      prog.message = 'Mise à jour terminée — redémarrage en cours';
      writeState({
        ...readState(),
        status: 'success',
        lastUpdateAt: new Date().toISOString()
      });
    }
    prog.finishedAt = Date.now();
    fs.writeFileSync(UPDATE_PROGRESS, JSON.stringify(prog, null, 2));
  });

  // Stream stdout for diagnostics (we don't expose the raw log to the UI)
  child.stdout.on('data', d => process.stdout.write(`[update.sh] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[update.sh:err] ${d}`));

  return { started: true, targetVersion: state.remoteVersion, pid: child.pid };
}

/**
 * Called on backend boot. If a pending update file exists, it means the
 * server restarted as part of an update — clear it and reload the cached
 * version so the new version is reported immediately.
 */
function checkPendingRestart() {
  const pending = consumePending();
  if (!pending) return null;
  // Invalidate cached version so the next read picks up the updated package.json
  versionSvc.clearCache();
  const local = versionSvc.loadLocal();
  // Update state file to record success
  const state = readState() || {};
  state.status = 'success';
  state.lastUpdateAt = new Date().toISOString();
  writeState(state);
  return { expectedVersion: pending.expectedVersion, actualVersion: local.version };
}

/**
 * Cleanup any leftover progress file (called after the frontend acknowledges the result).
 */
function acknowledge() {
  try { fs.unlinkSync(UPDATE_PROGRESS); } catch (_) {}
  // Mark state as idle but keep last-check / remote info for display
  const state = readState();
  if (state && (state.status === 'success' || state.status === 'failed')) {
    state.status = state.updateAvailable ? 'update_available' : 'up_to_date';
    writeState(state);
  }
}

// ── GitHub archive download ───────────────────────────────
const ARCHIVE_TIMEOUT = 30000; // 30s
function downloadToBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Nexus-Bot-Manager', 'Accept': 'application/octet-stream' }
    }, (res) => {
      if ([301, 302, 307].includes(res.statusCode) && res.headers.location) {
        // GitHub redirects to S3 — follow once
        return downloadToBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Téléchargement échoué (HTTP ${res.statusCode})`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(ARCHIVE_TIMEOUT, () => { req.destroy(new Error('Timeout du téléchargement')); });
    req.on('error', reject);
  });
}

/**
 * Download the new release tarball from GitHub into a temp directory and
 * return the path. The tarball is extracted using `tar`.
 *
 * This runs BEFORE the script is spawned, so by the time the script starts
 * the source tree is already on disk and we don't need network in the script.
 */
async function fetchReleaseSource(remoteVersion, owner, repo) {
  ensureDataDir();
  const dest = path.join(DATA_DIR, 'update-source');
  // Clean any previous attempt
  try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(dest, { recursive: true });

  const url = `https://github.com/${owner}/${repo}/archive/refs/tags/v${remoteVersion}.tar.gz`;
  let buf;
  try {
    buf = await downloadToBuffer(url);
  } catch (e) {
    // Fallback: try the tag without the 'v' prefix
    const url2 = `https://github.com/${owner}/${repo}/archive/refs/tags/${remoteVersion}.tar.gz`;
    try { buf = await downloadToBuffer(url2); }
    catch (_) { throw new Error(`Téléchargement impossible : ${e.message}`); }
  }

  const tarball = path.join(os.tmpdir(), `nexus-update-${Date.now()}.tar.gz`);
  fs.writeFileSync(tarball, buf);

  // Extract using system `tar` (no shell)
  await new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', tarball, '-C', dest], { timeout: 60000 }, (err) => {
      try { fs.unlinkSync(tarball); } catch (_) {}
      if (err) return reject(new Error(`Extraction échouée : ${err.message}`));
      resolve();
    });
  });

  // GitHub archives are named `${repo}-${tag}/`. Find the actual root.
  const entries = fs.readdirSync(dest);
  if (entries.length !== 1) throw new Error('Archive inattendue');
  return path.join(dest, entries[0]);
}

module.exports = {
  STEPS,
  getStatus,
  checkForUpdates,
  startUpdate,
  checkPendingRestart,
  acknowledge,
  // For testing / inspection
  _isLocked: isLocked
};