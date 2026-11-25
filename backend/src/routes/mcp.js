'use strict';
/**
 * Nexus Bot Manager — MCP endpoint.
 *
 * Mounted at /mcp on the main HTTP server. Disabled unless the admin turns
 * it on in Settings > MCP. Every request needs the rotating bearer token.
 */
const os     = require('os');
const crypto = require('crypto');

const { createMcpHandler } = require('@modelcontextprotocol/server');
const { toNodeHandler, hostHeaderValidation, originValidation } = require('@modelcontextprotocol/node');

const { getDb } = require('../db/db');
const { buildServer } = require('../services/mcp.service');

function allowedHostnames() {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (!entry || !entry.address) continue;
        hosts.add(entry.address);
        if (entry.address.includes(':')) hosts.add(`[${entry.address}]`);
      }
    }
  } catch (_) {}
  for (const raw of String(process.env.MCP_ALLOWED_HOSTS || '').split(',')) {
    const host = raw.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return [...hosts];
}

const HOSTS = allowedHostnames();
const validateHost = hostHeaderValidation(HOSTS);
const validateOrigin = originValidation(HOSTS);

const nodeHandler = toNodeHandler(
  createMcpHandler(() => buildServer(), {
    onerror: err => console.warn('[mcp]', err && err.message ? err.message : err)
  }),
  {
    onerror: err => console.warn('[mcp] adapter:', err && err.message ? err.message : err)
  }
);

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleMcp(req, res) {
  const settings = getDb().getSettings();
  if (!settings.mcp_enabled) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!settings.mcp_token) {
    return res.status(503).json({ error: 'MCP token is not configured' });
  }

  // DNS-rebinding protection: the Host header must name this machine.
  if (!validateHost(req, res)) return;
  if (!validateOrigin(req, res)) return;

  const header = String(req.headers.authorization || '');
  const provided = header.replace(/^Bearer\s+/i, '').trim();
  if (!tokenMatches(provided, settings.mcp_token)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="nexus-bot-manager"');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await nodeHandler(req, res, req.body);
  } catch (e) {
    console.warn('[mcp] request failed:', e && e.message ? e.message : e);
    if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    else { try { res.end(); } catch (_) {} }
  }
}

module.exports = { handleMcp, allowedHostnames };
