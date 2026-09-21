'use strict';
/**
 * Nexus Bot Manager — Version service
 *
 * The INSTALLED version is the source of truth and is read from
 *   <INSTALL_DIR>/.nexus-version
 * If this file is missing (existing installations), we migrate by
 * reading backend/package.json (legacy behaviour).
 *
 * The REMOTE version is fetched from GitHub via /releases/latest,
 * with /tags as fallback for projects that don't publish Releases.
 *
 * Comparison is done with proper SemVer semantics, NOT naive string compare.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const GITHUB_OWNER = 'Julien48003';
const GITHUB_REPO  = 'nexus-bot-manager';
const GITHUB_API   = 'api.github.com';
const CHECK_TIMEOUT = 8000; // ms

// Locations for the installed version file:
//   1. INSTALL_DIR/.nexus-version    (production install)
const PKG_PATH = path.join(__dirname, '..', '..', 'package.json');

let _cached = null;

function readVersionFile() {
  // 1) Try .nexus-version (production)
  const installDir = process.env.INSTALL_DIR;
  if (installDir) {
    const fp = path.join(installDir, '.nexus-version');
    try {
      const raw = fs.readFileSync(fp, 'utf8').trim();
      if (raw) {
        // File format: just a version string on the first line, e.g. "v1.2.0"
        const v = raw.replace(/^v/i, '').split(/\s/)[0];
        return { version: v, source: fp };
      }
    } catch (_) { /* not present */ }
  }
  return null;
}

function loadLocal() {
  if (_cached) return _cached;

  const fromFile = readVersionFile();
  if (fromFile) {
    _cached = { version: fromFile.version, source: fromFile.source };
    return _cached;
  }

  // 2) Fallback: read package.json (legacy / dev only)
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    _cached = { version: pkg.version || '0.0.0', source: PKG_PATH };
  } catch (_) {
    _cached = { version: '0.0.0', source: null };
  }
  return _cached;
}

function clearCache() { _cached = null; }

/**
 * Persist a new installed version to .nexus-version.
 * Creates the file (or overwrites it) so future reads pick it up.
 *
 * @returns {boolean} true if written, false on error
 */
function writeInstalledVersion(version) {
  const installDir = process.env.INSTALL_DIR;
  if (!installDir) return false;
  try {
    const target = path.join(installDir, '.nexus-version');
    // Single line, with v-prefix for clarity, no whitespace
    fs.writeFileSync(target, `v${String(version).replace(/^v/i, '').trim()}\n`, 'utf8');
    clearCache();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Migration helper: if .nexus-version is missing but package.json exists,
 * create the .nexus-version file so future reads use the proper source.
 */
function migrateFromPackageJson() {
  if (!process.env.INSTALL_DIR) return false;
  const target = path.join(process.env.INSTALL_DIR, '.nexus-version');
  if (fs.existsSync(target)) return false; // already migrated
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    if (!pkg.version) return false;
    return writeInstalledVersion(pkg.version);
  } catch (_) {
    return false;
  }
}

// ────────────────────────────────────────────────────────────
// SemVer comparison
// ────────────────────────────────────────────────────────────
function parseVersion(v) {
  if (typeof v !== 'string') return { major: 0, minor: 0, patch: 0, pre: null, raw: String(v || '') };
  let s = v.trim().replace(/^v/i, '');
  const dashIdx = s.indexOf('-');
  const pre = dashIdx >= 0 ? s.slice(dashIdx + 1) : null;
  if (dashIdx >= 0) s = s.slice(0, dashIdx);
  const parts = s.split('.').map(n => parseInt(n, 10));
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    pre,
    raw: v
  };
}

/** Returns -1 if a<b, 0 if equal, 1 if a>b. Pre-release versions are LOWER than the same base. */
function compareVersions(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  if (A.major !== B.major) return A.major < B.major ? -1 : 1;
  if (A.minor !== B.minor) return A.minor < B.minor ? -1 : 1;
  if (A.patch !== B.patch) return A.patch < B.patch ? -1 : 1;
  if (!A.pre &&  B.pre) return 1;
  if ( A.pre && !B.pre) return -1;
  if (!A.pre && !B.pre) return 0;
  return A.pre.localeCompare(B.pre);
}

// ────────────────────────────────────────────────────────────
// GitHub check
// ────────────────────────────────────────────────────────────
function fetchJson(hostname, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, port: 443, path: p, method: 'GET',
      headers: { 'User-Agent': 'Nexus-Bot-Manager', 'Accept': 'application/vnd.github+json', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Réponse GitHub invalide')); }
        } else if (res.statusCode === 404) {
          reject(new Error('Ressource GitHub introuvable (404)'));
        } else if (res.statusCode === 403) {
          reject(new Error('Limite de requêtes GitHub atteinte (403)'));
        } else {
          reject(new Error(`GitHub a répondu ${res.statusCode}`));
        }
      });
    });
    req.setTimeout(CHECK_TIMEOUT, () => { req.destroy(new Error('Timeout GitHub')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Check the latest version available on GitHub.
 * Per spec: GitHub Releases is the source of truth for the latest
 * published version. We DO NOT use arbitrary tags as a fallback — a tag
 * may exist for an unreleased commit on `main` and must never be reported
 * as "the latest version available".
 *
 * Strategy:
 *  1) /releases/latest — returns the latest non-prerelease release.
 *     404 means "no releases yet" (very unusual).
 *  2) /releases?per_page=1 — list endpoint, returns the latest release
 *     including prereleases (used as a last resort if /latest somehow
 *     disagrees with the list, which can happen on GitHub).
 *  3) If both 404, fail with a clear error.
 */
async function checkRemoteVersion() {
  // 1) Latest stable release
  try {
    const release = await fetchJson(GITHUB_API, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
    if (release?.tag_name) {
      return {
        version:      release.tag_name.replace(/^v/i, ''),
        name:         release.name || release.tag_name,
        html_url:     release.html_url,
        published_at: release.published_at,
        prerelease:   !!release.prerelease,
        source:       'release'
      };
    }
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }

  // 2) Fallback: any release from the list endpoint
  try {
    const list = await fetchJson(GITHUB_API, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=1`);
    if (Array.isArray(list) && list.length > 0 && list[0].tag_name) {
      const r = list[0];
      return {
        version:      r.tag_name.replace(/^v/i, ''),
        name:         r.name || r.tag_name,
        html_url:     r.html_url,
        published_at: r.published_at,
        prerelease:   !!r.prerelease,
        source:       'release-list'
      };
    }
  } catch (_) { /* fallthrough */ }

  // 3) No release published yet
  throw new Error('Aucune release GitHub publiée — créez une Release pour activer la détection de mise à jour.');
}

function getUpdateStatus(localVer, remoteVer) {
  // Per spec: "À jour" covers both "equal" and "local is newer than remote".
  // We do NOT report an update as available when the remote is behind.
  const cmp = compareVersions(localVer, remoteVer);
  if (cmp < 0) return 'update_available';
  return 'up_to_date';
}

module.exports = {
  loadLocal,
  clearCache,
  writeInstalledVersion,
  migrateFromPackageJson,
  compareVersions,
  checkRemoteVersion,
  getUpdateStatus,
  GITHUB_OWNER, GITHUB_REPO
};