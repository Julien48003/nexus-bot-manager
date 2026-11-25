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
const { SAFE_ENV } = require('../middleware/security');

// Persistent state (lives next to the DB so it survives restarts)
const DATA_DIR  = process.env.NEXUS_DATA_DIR
  ? path.resolve(process.env.NEXUS_DATA_DIR)
  : path.join(__dirname, '..', '..', 'data');
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
  { id: 'stop',         label: 'Préparation' },
  { id: 'apply',        label: 'Application des fichiers' },
  { id: 'dependencies', label: 'Installation des dépendances' },
  { id: 'syntax',       label: 'Vérification de la syntaxe' },
  { id: 'restart',      label: 'Redémarrage du service' },
  { id: 'verify',       label: 'Vérification du service' },
  { id: 'finalize',     label: 'Finalisation' }
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
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

// -- Lock helpers ------------------------------------------
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

// -- Pending (post-restart) --------------------------------
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

// -- Public API --------------------------------------------

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
    // Surface the from/to versions so the frontend can render
    // "v1.1.2 -> v1.1.4" instead of "v? -> v?".
    if (progress.fromVersion) live.fromVersion = progress.fromVersion;
    if (progress.toVersion)   live.toVersion   = progress.toVersion;
    if (progress.error)       live.error       = progress.error;
    if (progress.startedAt)   live.startedAt   = progress.startedAt;
    if (progress.finishedAt)  live.finishedAt  = progress.finishedAt;
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
      ...SAFE_ENV,
      // A panel running as a dedicated user must update its own tree and
      // PM2 home without sudo. The script still refuses writes it cannot do.
      ...(typeof process.getuid === 'function' && process.getuid() !== 0
        ? { NEXUS_ALLOW_NONROOT: '1' }
        : {}),
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
  // UPD-16: only claim success when the version that is now running is
  // actually the one the update targeted. Previously any pending marker
  // was reported as a success, whatever the resulting version was.
  const succeeded = versionSvc.compareVersions(local.version, pending.expectedVersion) >= 0;
  const state = readState() || {};
  state.status = succeeded ? 'success' : 'failed';
  if (succeeded) {
    state.lastUpdateAt = new Date().toISOString();
  } else {
    state.lastError = `Mise à jour incomplète : v${pending.expectedVersion} attendue, v${local.version} en cours d'exécution`;
  }
  writeState(state);
  return {
    expectedVersion: pending.expectedVersion,
    actualVersion: local.version,
    succeeded
  };
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

// -- GitHub archive download -------------------------------
const ARCHIVE_TIMEOUT = 30000; // 30s
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

/**
 * Pinned release digests (UPD-01).
 *
 * Format: { "<version>": "<sha256 of the GitHub source tarball>" }
 * The file is version-controlled and reviewed by commit, so it is never
 * fetched from the same place as the archive it authenticates. CI must
 * publish the digest when cutting a release.
 *
 * Operational override, for a self-hosted fork that ships its own
 * builds: NEXUS_UPDATE_ALLOW_UNVERIFIED=1 in .env. Without it, and
 * without a pinned digest, the update is refused — an unverified archive
 * is arbitrary code executed as root.
 */
const DIGEST_FILE = path.join(__dirname, '..', '..', 'release-digests.json');

function loadPinnedDigests() {
  try {
    const raw = JSON.parse(fs.readFileSync(DIGEST_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    // Accept both { "1.1.6": "<sha>" } and { "digests": { "1.1.6": "<sha>" } }
    // so the file can carry documentation keys alongside the digests.
    const table = (raw.digests && typeof raw.digests === 'object' && !Array.isArray(raw.digests))
      ? raw.digests
      : raw;
    const out = {};
    for (const [k, v] of Object.entries(table)) {
      if (k.startsWith('_') || k === 'digests') continue;
      if (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)) out[k] = v;
    }
    return out;
  } catch (_) {
    return {};
  }
}

function allowUnverified() {
  return /^(1|true|yes|on)$/i.test(String(process.env.NEXUS_UPDATE_ALLOW_UNVERIFIED || ''));
}

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
      let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > MAX_ARCHIVE_BYTES) { req.destroy(new Error('Archive trop volumineuse')); return; }
        chunks.push(c);
      });
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(ARCHIVE_TIMEOUT, () => { req.destroy(new Error('Timeout du téléchargement')); });
    req.on('error', reject);
  });
}

function requestGitHubJson(apiPath) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.github.com', port: 443,
      path: apiPath, method: 'GET',
      headers: { 'User-Agent': 'Nexus-Bot-Manager', 'Accept': 'application/vnd.github+json' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch (_) { reject(new Error('Réponse GitHub invalide')); }
      });
    });
    r.on('error', reject);
    r.setTimeout(ARCHIVE_TIMEOUT, () => r.destroy(new Error('Timeout GitHub')));
    r.end();
  });
}

/**
 * Resolve a tag to the immutable commit it points at (UPD-03).
 * A tag is a mutable reference: `git tag -f v1.1.7 && git push -f`
 * changes what every installation downloads while the GitHub Releases
 * API still reports the same, legitimate tag name.
 *
 * Annotated tags point to a tag object, not directly to a commit. GitHub
 * returns 404 when its tarball endpoint is given that tag-object SHA, so
 * follow the tag object chain until a commit is reached. The legacy
 * v1.1.6 annotated tag is the regression this handles.
 */
async function resolveTagToCommit(owner, repo, version, requestJson = requestGitHubJson) {
  const candidates = [`/repos/${owner}/${repo}/git/ref/tags/v${version}`,
                      `/repos/${owner}/${repo}/git/ref/tags/${version}`];

  async function resolveObject(object, depth = 0) {
    if (!object || !object.sha) return null;
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag' || !object.url || depth >= 3) return null;
    const url = new URL(object.url);
    const tagObject = await requestJson(url.pathname + url.search);
    return resolveObject(tagObject && tagObject.object, depth + 1);
  }

  for (const candidate of candidates) {
    try {
      const ref = await requestJson(candidate);
      const sha = await resolveObject(ref && ref.object);
      if (sha) return sha;
    } catch (_) {
      // Try the unprefixed candidate and then fail with the same public error.
    }
  }
  throw new Error('Tag introuvable sur GitHub');
}

/**
 * UPD-05 — refuse an archive whose entries try to escape the extraction
 * directory before `tar` gets a chance to write them (absolute paths,
 * parent-directory segments).
 */
function assertSafeTarEntries(tarball) {
  return new Promise((resolve, reject) => {
    // `tar -tzf` lists the archive without extracting it.
    execFile('tar', ['-tzf', tarball], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`Lecture de l'archive impossible : ${err.message}`));
      const bad = [];
      for (const rawLine of String(stdout).split('\n')) {
        const name = rawLine.trim();
        if (!name) continue;
        if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name) || name.split('/').includes('..')) {
          bad.push(name.slice(0, 120));
          if (bad.length >= 5) break;
        }
      }
      if (bad.length) {
        return reject(new Error(`Archive refusée — entrées non sûres : ${bad.join(', ')}`));
      }
      resolve();
    });
  });
}

/**
 * UPD-05 (defence in depth) — a tar entry listing cannot be trusted to
 * describe link targets safely, and `rsync -a` would reproduce a symlink
 * in the installed tree. Refuse any symlink in the extracted release.
 */
function assertNoSymlinks(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new Error(`Lien symbolique interdit dans l'archive : ${path.relative(dir, full)}`);
      }
      if (st.isDirectory()) stack.push(full);
    }
  }
}

/**
 * Download the new release tarball from GitHub into a temp directory and
 * return the path. The tarball is extracted using `tar`.
 *
 * This runs BEFORE the script is spawned, so by the time the script starts
 * the source tree is already on disk and we don't need network in the script.
 */
async function fetchReleaseSource(remoteVersion, owner, repo) {
  const crypto = require('crypto');
  const { isInsideReal } = require('../middleware/security');
  ensureDataDir();
  // UPD-04: a private temp directory created by the OS, not a predictable
  // name in a world-writable /tmp that a local user can pre-create or
  // point a symlink at.
  const dest = fs.mkdtempSync(path.join(DATA_DIR, 'update-source-'));
  const tarball = path.join(dest, 'release.tar.gz');
  const extractDir = path.join(dest, 'tree');

  try {
    // 1. Pin the tag to an immutable commit SHA.
    const commitSha = await resolveTagToCommit(owner, repo, remoteVersion);

    // 2. Download by commit SHA (immutable object), not by tag.
    const buf = await downloadToBuffer(`https://api.github.com/repos/${owner}/${repo}/tarball/${commitSha}`);

    // 3. Verify the digest BEFORE anything touches the filesystem.
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    const pinned = loadPinnedDigests()[String(remoteVersion)];
    if (pinned) {
      if (String(pinned).toLowerCase() !== digest) {
        throw new Error(`ÉCHEC D'INTÉGRITÉ pour v${remoteVersion} : sha256=${digest}, attendu=${pinned}. Mise à jour annulée, rien n'a été appliqué.`);
      }
    } else if (!allowUnverified()) {
      throw new Error(
        `Aucune empreinte SHA-256 épinglée pour v${remoteVersion}. ` +
        `Ajoutez {"${remoteVersion}": "<sha256>"} dans backend/release-digests.json ` +
        `(la CI publie cette valeur au moment du tag), ou définissez ` +
        `NEXUS_UPDATE_ALLOW_UNVERIFIED=1 dans .env pour assumer une archive non vérifiée.`
      );
    } else {
      console.warn(`[update] ATTENTION — v${remoteVersion} installée SANS vérification d'intégrité (NEXUS_UPDATE_ALLOW_UNVERIFIED=1). sha256=${digest}`);
    }

    fs.writeFileSync(tarball, buf, { mode: 0o600 });

    // 4. Reject an archive whose entries would escape the destination.
    fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
    await assertSafeTarEntries(tarball);

    // 5. Extract hardened: no owner restoration, no permission escalation.
    await new Promise((resolve, reject) => {
      execFile('tar', [
        '-xzf', tarball,
        '-C', extractDir,
        '--no-same-owner',
        '--no-same-permissions',
        '--no-overwrite-dir',
        '--delay-directory-restore'
      ], { timeout: 60000 }, (err) => {
        if (err) return reject(new Error(`Extraction échouée : ${err.message}`));
        resolve();
      });
    });

    // 6. Refuse any symlink in the extracted tree before it can be
    //    reproduced by `rsync -a` in update.sh.
    assertNoSymlinks(extractDir);

    // GitHub archives are named `${repo}-${tag}/`. Find the actual root.
    const entries = fs.readdirSync(extractDir);
    if (entries.length !== 1) throw new Error('Archive inattendue');
    const root = path.join(extractDir, entries[0]);
    if (!fs.statSync(root).isDirectory()) throw new Error('Archive inattendue');
    if (!isInsideReal(extractDir, root)) throw new Error('Archive inattendue');

    // Drop the tarball, keep only the extracted tree.
    try { fs.unlinkSync(tarball); } catch (_) {}
    return root;
  } catch (e) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
}

module.exports = {
  STEPS,
  getStatus,
  checkForUpdates,
  startUpdate,
  checkPendingRestart,
  acknowledge,
  // For testing / inspection
  _isLocked: isLocked,
  _loadPinnedDigests: loadPinnedDigests,
  _assertSafeTarEntries: assertSafeTarEntries,
  _assertNoSymlinks: assertNoSymlinks,
  _allowUnverified: allowUnverified,
  _resolveTagToCommit: resolveTagToCommit
};