'use strict';
/**
 * Safe file-path helpers shared by the HTTP file routes and the MCP tools.
 * Every helper resolves a user-supplied path against a bot directory and
 * rejects traversal, encoded separators and symlinks.
 */
const fs   = require('fs');
const path = require('path');

const { safeFilePath, isInside, isInsideOrEqual, isInsideReal } = require('../middleware/security');
const fsService = require('./fs.service');

function toRelative(botName, rawPath) {
  const bPath = fsService.botPath(botName);
  const raw = String(rawPath || '');
  if (!raw) return '';
  const resolved = path.resolve(raw);
  if (path.isAbsolute(raw)) {
    if (resolved === bPath) return '';
    if (resolved.startsWith(bPath + path.sep)) return path.relative(bPath, resolved);
    const legacy = raw.replace(/^\/opt\/[^/]+\/?/, '');
    return legacy !== raw ? legacy.replace(/^\//, '') : null;
  }
  return raw.replace(/^\//, '');
}

function resolveFile(botName, rawPath) {
  const bPath = fsService.botPath(botName);
  const relPath = toRelative(botName, rawPath);
  if (relPath === null) return null;
  const safe = safeFilePath(botName, relPath);
  if (!safe) return null;
  if (!isInsideReal(bPath, safe)) return null;
  return safe;
}

function resolveDir(botName, rawPath) {
  const bPath = fsService.botPath(botName);
  const rel = toRelative(botName, rawPath);
  if (rel === null || /%2e|%2f|%5c/i.test(rel)) return { forbidden: true };
  const dir = path.resolve(bPath, rel);
  if (!isInsideOrEqual(bPath, dir)) return { forbidden: true };
  if (!isInsideReal(bPath, dir)) return { forbidden: true };
  let stat;
  try { stat = fs.lstatSync(dir); } catch (_) { return { missing: true }; }
  if (stat.isSymbolicLink()) return { forbidden: true };
  if (!stat.isDirectory()) return { missing: true };
  return { bPath, dir, rel: rel.replace(/\\/g, '/') };
}

function resolveAny(botName, rawPath) {
  const bPath = fsService.botPath(botName);
  const rel = toRelative(botName, rawPath);
  if (rel === null || !rel || /%2e|%2f|%5c/i.test(rel)) return { forbidden: true };
  const full = path.resolve(bPath, rel);
  if (!isInside(bPath, full)) return { forbidden: true };
  if (!isInsideReal(bPath, full)) return { forbidden: true };
  let stat;
  try { stat = fs.lstatSync(full); } catch (_) { return { missing: true }; }
  if (stat.isSymbolicLink()) return { forbidden: true };
  return { bPath, full, rel: rel.replace(/\\/g, '/'), stat };
}

module.exports = { toRelative, resolveFile, resolveDir, resolveAny };
