'use strict';
/**
 * Nexus Bot Manager — Version service
 *
 * SINGLE SOURCE OF TRUTH: backend/package.json
 *
 * The installed version is read from <INSTALL_DIR>/backend/package.json,
 * regardless of whether the app is running in production (under
 * /opt/nexus-bot-manager) or in development. There is intentionally
 * NO secondary source of truth: no .nexus-version file, no env var
 * override. The release tag the installer just cloned IS the version
 * we run, because the installer always clones the exact tag and copies
 * its package.json into the install dir.
 *
 * The REMOTE version is fetched from GitHub Releases:
 *   1) /releases/latest  → latest non-prerelease release
 *   2) /releases?per_page=1 → first item of the list (fallback)
 *   3) /tags              → last resort (a tag MAY be an unreleased
 *      commit on main, so this is only used if no Release exists)
 *
 * Comparison uses proper SemVer semantics — not naive string compare
 * (1.9.0 > 1.10.0 is wrong as strings, right as SemVer).
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const GITHUB_OWNER  = 'Julien48003';
const GITHUB_REPO   = 'nexus-bot-manager';
const GITHUB_API    = 'api.github.com';
const CHECK_TIMEOUT = 8000; // ms

// backend/package.json — wherever the backend is running from.
const PKG_PATH = path.join(__dirname, '..', '..', 'package.json');

// Optional INSTALL_DIR override (mainly for dev). When set, we read the
// package.json from $INSTALL_DIR/backend/package.json instead of the
// current process location. This keeps dev (`npm run dev`) and prod
// (PM2 from /opt/...) both pointing at the right file.
function resolvePkgPath() {
  const installDir = process.env.INSTALL_DIR;
  if (installDir) {
    const alt = path.join(installDir, 'backend', 'package.json');
    if (fs.existsSync(alt)) return alt;
  }
  return PKG_PATH;
}

let _cached = null;

/**
 * Read the installed version from backend/package.json. This is the
 * ONLY source consulted — there is no .nexus-version file authority.
 */
function loadLocal() {
  if (_cached) return _cached;

  try {
    const fp = resolvePkgPath();
    const pkg = JSON.parse(fs.readFileSync(fp, 'utf8'));
    _cached = {
      version: pkg.version || '0.0.0',
      name:    pkg.name    || 'nexus-bot-manager',
      source:  fp
    };
  } catch (_) {
    _cached = { version: '0.0.0', name: 'nexus-bot-manager', source: null };
  }
  return _cached;
}

function clearCache() { _cached = null; }

// ──────────────────────────────────────────────────────────────
// SemVer comparison
// ──────────────────────────────────────────────────────────────
function parseVersion(v) {
  if (typeof v !== 'string') return { major: 0, minor: 0, patch: 0, pre: null, raw: String(v || '') };
  let s = v.trim().replace(/^v/i, '');
  const dashIdx = s.indexOf('-');
  const pre = dashIdx >= 0 ? s.slice(dashIdx + 1) : null;
  if (dashIdx >= 0) s = s.slice(0, dashIdx);
  const parts = s.split('.').map(n => parseInt(n, 10));
  return {
    major: Number.isFinite(parts[0]) ? parts[0] : 0,
    minor: Number.isFinite(parts[1]) ? parts[1] : 0,
    patch: Number.isFinite(parts[2]) ? parts[2] : 0,
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

// ──────────────────────────────────────────────────────────────
// GitHub check
// ──────────────────────────────────────────────────────────────
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
          catch (e) { reject(new Error('Invalid GitHub response')); }
        } else if (res.statusCode === 404) {
          reject(new Error('GitHub resource not found (404)'));
        } else if (res.statusCode === 403) {
          reject(new Error('GitHub rate limit reached (403)'));
        } else {
          reject(new Error(`GitHub responded ${res.statusCode}`));
        }
      });
    });
    req.setTimeout(CHECK_TIMEOUT, () => { req.destroy(new Error('GitHub timeout')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Check the latest version available on GitHub.
 *
 * Strategy:
 *  1) /releases/latest — returns the latest non-prerelease release.
 *     404 means "no releases yet".
 *  2) /releases?per_page=1 — list endpoint, first item is the latest
 *     release (including prereleases).
 *  3) /tags — last resort. A tag may exist for an unreleased commit on
 *     main, so we only fall back to tags when there are no Releases.
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
    if (Array.isArray(list) && list.length && list[0]?.tag_name) {
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
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }

  // 3) Tags (last resort)
  try {
    const tags = await fetchJson(GITHUB_API, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/tags?per_page=1`);
    if (Array.isArray(tags) && tags.length && tags[0]?.name) {
      return {
        version:      tags[0].name.replace(/^v/i, ''),
        name:         tags[0].name,
        html_url:     `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tags[0].name}`,
        published_at: null,
        prerelease:   false,
        source:       'tag'
      };
    }
  } catch (_) { /* fall through */ }

  throw new Error('No release or tag found on GitHub');
}

/**
 * Public status combining local + remote + comparison.
 */
async function getStatus({ forceRemote = false } = {}) {
  const local = loadLocal();
  const out = {
    local: { version: local.version, source: local.source },
    remote: null,
    status: 'unknown',
    compare: null,
    checkedAt: null,
    checkError: null
  };

  try {
    const remote = forceRemote ? await checkRemoteVersion() : await checkRemoteVersion();
    out.remote = remote;
    out.checkedAt = new Date().toISOString();
    const cmp = compareVersions(local.version, remote.version);
    out.compare = cmp;
    out.status = cmp < 0 ? 'update_available' : 'up_to_date';
  } catch (e) {
    out.status = 'check_failed';
    out.checkError = e.message;
  }
  return out;
}

module.exports = {
  loadLocal,
  clearCache,
  compareVersions,
  parseVersion,
  checkRemoteVersion,
  getStatus,
  resolvePkgPath,
};