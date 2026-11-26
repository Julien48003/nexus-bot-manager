'use strict';
/**
 * MCP permission scopes.
 *
 * Every MCP tool belongs to one scope. The server only registers the tools
 * whose scope is enabled, so a client cannot even discover a capability the
 * administrator has not granted. Existing installations keep the behaviour
 * of the original MCP release: bot/files/env/package read-write is enabled
 * by default, while the newer account, webhook, snapshot-write, settings
 * and export scopes are off by default.
 */
const MCP_SCOPE_DEFAULTS = {
  bots_read:       true,
  bots_write:      true,
  files_read:      true,
  files_write:     true,
  env_read:        true,
  env_write:       true,
  packages_read:   true,
  packages_write:  true,
  snapshots_read:  true,
  snapshots_write: false,
  users:           false,
  webhooks:        false,
  settings:        false,
  exports:         false
};

function normalizeMcpScopes(value) {
  const out = { ...MCP_SCOPE_DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const key of Object.keys(MCP_SCOPE_DEFAULTS)) {
    if (value[key] !== undefined) out[key] = value[key] === true;
  }
  return out;
}

function mcpScopes(settings) {
  return normalizeMcpScopes(settings && settings.mcp_scopes);
}

module.exports = { MCP_SCOPE_DEFAULTS, normalizeMcpScopes, mcpScopes };
