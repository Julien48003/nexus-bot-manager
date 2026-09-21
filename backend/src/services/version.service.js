'use strict';
/**
 * Nexus Bot Manager — Version service
 *
 * Single source of truth for the local Nexus version.
 * Reads from backend/package.json (cached in memory for performance).
 *
 * Also handles GitHub version checking via the GitHub API.
 * Uses the official Releases endpoint: /repos/{owner}/{repo}/releases/latest
 * Falls back to /tags if no Releases exist (e.g. early project).
 *
 * Comparison is done with proper SemVer semantics, NOT naive string compare.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const PKG_PATH = path.join(__dirname, '..', '..', 'package.json');

const GITHUB_OWNER = 'Julien48003';
const GITHUB_REPO  = 'nexus-bot-manager';
const GITHUB_API    = 'api.github.com';
const CHECK_TIMEOUT = 8000; // ms

let _cached = null;
function loadLocal() {
  if (_cached) return _cached;
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    _cached = {
      version: pkg.version || '0.0.0',
      name:    pkg.name    || 'nexus-bot-manager'
    };
  } catch (_) {
    _cached = { version: '0.0.0', name: 'nexus-bot-manager' };
  }
  return _cached;
}

function clearCache() { _cached = null; }

// ────────────────────────────────────────────────────────────
// SemVer comparison
// ────────────────────────────────────────────────────────────
/** Strip leading 'v' and any pre-release suffix for the base compare. */
function parseVersion(v) {
  if (typeof v !== 'string') return { major: 0, minor: 0, patch: 0, pre: null, raw: String(v || '') };
  let s = v.trim().replace(/^v/i, '');
  // Strip everything after first '-' for base (e.g. 1.2.0-beta.1)
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
  // Stable release > any pre-release of same base
  if (!A.pre &&  B.pre) return 1;
  if ( A.pre && !B.pre) return -1;
  if (!A.pre && !B.pre) return 0;
  return A.pre.localeCompare(B.pre);
}

// ────────────────────────────────────────────────────────────
// GitHub check
// ────────────────────────────────────────────────────────────
function fetchJson(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, port: 443, path, method: 'GET',
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
 * Tries the Releases endpoint first, then falls back to the Tags endpoint
 * so it works for projects that don't publish Releases yet.
 *
 * @returns {Promise<{version:string, name:string, html_url:string, published_at:string, source:'release'|'tag'}>}
 */
async function checkRemoteVersion() {
  // 1) Try the latest release
  try {
    const release = await fetchJson(GITHUB_API, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
    if (release?.tag_name) {
      return {
        version:      release.tag_name.replace(/^v/i, ''),
        name:         release.name || release.tag_name,
        html_url:     release.html_url,
        published_at: release.published_at,
        source:       'release'
      };
    }
  } catch (e) {
    // 404 means "no releases published yet" — try tags.
    if (!/404/.test(e.message)) throw e;
  }

  // 2) Fallback: most recent tag
  const tags = await fetchJson(GITHUB_API, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/tags?per_page=1`);
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error('Aucune release ni tag disponible sur GitHub');
  }
  return {
    version:      tags[0].name.replace(/^v/i, ''),
    name:         tags[0].name,
    html_url:     `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tags[0].name}`,
    published_at: null,
    source:       'tag'
  };
}

function getUpdateStatus(localVer, remoteVer) {
  const cmp = compareVersions(localVer, remoteVer);
  if (cmp < 0) return 'update_available';
  if (cmp > 0) return 'ahead';
  return 'up_to_date';
}

module.exports = {
  loadLocal,
  clearCache,
  compareVersions,
  checkRemoteVersion,
  getUpdateStatus,
  GITHUB_OWNER, GITHUB_REPO
};