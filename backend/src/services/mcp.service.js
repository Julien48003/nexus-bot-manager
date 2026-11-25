'use strict';
/**
 * Nexus Bot Manager — MCP server tools.
 *
 * Exposes a deliberately small, admin-scoped set of bot operations to MCP
 * clients (n8n, Claude Desktop, Cursor, ...). Bot-scoped tools only work on
 * bots whose `mcp_exposed` flag is enabled in the panel.
 */
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { McpServer } = require('@modelcontextprotocol/server');
const z = require('zod');

const { getDb } = require('../db/db');
const versionSvc = require('./version.service');
const pm2Service = require('./pm2.service');
const fsService = require('./fs.service');
const templatesSvc = require('./templates.service');
const { toRelative, resolveDir, resolveAny, resolveFile } = require('./file.service');
const {
  sanitizeBotName, isValidPackageName, isValidFileName, isInside, isInsideReal,
  SAFE_ENV, redactSecrets, sanitizeLogText
} = require('../middleware/security');

const NPM_ARGS = ['--no-audit', '--no-fund', '--loglevel=warn', '--ignore-scripts'];

// -- Small helpers -----------------------------------------
function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

function publicBot(bot) {
  return {
    name: bot.name,
    displayName: bot.display_name || bot.name,
    description: bot.description || '',
    template: bot.template || 'blank',
    language: bot.language || 'en',
    startupFile: bot.startup_file || 'index.js',
    memoryLimit: bot.memory_limit || null,
    restartCron: bot.restart_cron || null,
    autostart: bot.autostart === true,
    mcpExposed: bot.mcp_exposed === true,
    lastStarted: bot.last_started || null,
    createdAt: bot.created_at || null
  };
}

function requireExposed(name) {
  const safeName = sanitizeBotName(name);
  if (!safeName) throw new Error('Invalid bot name');
  const bot = getDb().getBot(safeName);
  if (!bot) throw new Error(`Bot "${safeName}" not found`);
  if (!bot.mcp_exposed) throw new Error(`Bot "${safeName}" is not exposed on MCP`);
  return bot;
}

function requireBot(name) {
  const safeName = sanitizeBotName(name);
  if (!safeName) throw new Error('Invalid bot name');
  const bot = getDb().getBot(safeName);
  if (!bot) throw new Error(`Bot "${safeName}" not found`);
  return bot;
}

function parseEnvFile(content) {
  const vars = [];
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) vars.push({ key, value });
  }
  return vars;
}

function serializeEnvFile(name, vars) {
  const lines = [`# Bot: ${name}`, '# Managed by Nexus Bot Manager', ''];
  for (const { key, value } of vars) {
    const needsQuote = /[\s#"']/.test(value);
    lines.push(`${key}=${needsQuote ? `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value}`);
  }
  return lines.join('\n') + '\n';
}

async function pm2View(bot) {
  try {
    return pm2Service.formatProcess(await pm2Service.describe(bot.name));
  } catch (_) {
    return null;
  }
}

function fileResult(entry) {
  return {
    name: entry.name,
    type: entry.type,
    size: entry.type === 'dir' ? 0 : entry.size,
    mtime: entry.mtime,
    path: entry.rel,
    hidden: entry.name.startsWith('.')
  };
}

function listEntries(botName, relPath) {
  const target = resolveDir(botName, relPath || '');
  if (target.forbidden) throw new Error('Access denied');
  if (target.missing) throw new Error('Directory not found');
  const entries = [];
  for (const entry of fs.readdirSync(target.dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(target.dir, entry.name);
    let stat;
    try { stat = fs.lstatSync(full); } catch (_) { continue; }
    if (stat.isSymbolicLink()) continue;
    entries.push(fileResult({
      name: entry.name,
      type: stat.isDirectory() ? 'dir' : 'file',
      size: stat.isDirectory() ? 0 : stat.size,
      mtime: stat.mtimeMs,
      rel: path.relative(target.bPath, full).replace(/\\/g, '/')
    }));
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: target.rel, entries };
}

async function botWithStatus(bot) {
  return { ...publicBot(bot), pm2: await pm2View(bot) };
}

// -- Server factory ----------------------------------------
function buildServer() {
  const version = versionSvc.loadLocal().version;
  const server = new McpServer({ name: 'nexus-bot-manager', version });

  // Global -------------------------------------------------
  server.registerTool('list_bots', {
    title: 'List exposed bots',
    description: 'List the Discord bots exposed on MCP, with their PM2 status. Bots without the "Expose on MCP" option are omitted.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    const pm2List = await pm2Service.list().catch(() => []);
    const byName = new Map(pm2List.map(p => [p.name, pm2Service.formatProcess(p)]));
    const bots = getDb().getAllBots()
      .filter(b => b.mcp_exposed)
      .map(b => ({ ...publicBot(b), pm2: byName.get(b.name) || null }));
    return textResult({ bots });
  });

  server.registerTool('list_templates', {
    title: 'List bot templates',
    description: 'List the built-in Discord.js templates accepted by create_bot.',
    inputSchema: z.object({ language: z.enum(['en', 'fr', 'de']).optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ language }) => {
    const lang = language || 'en';
    const list = templatesSvc.getAllTemplates(lang).map(t => ({
      id: t.id, name: t.name, description: t.description || t.longDescription || ''
    }));
    return textResult({ templates: list });
  });

  server.registerTool('create_bot', {
    title: 'Create a bot',
    description: 'Create a new Discord bot from a template or a public GitHub repository. Set exposeOnMcp=true to make it available to the other MCP tools immediately.',
    inputSchema: z.object({
      name: z.string().describe('Technical bot name: lowercase letters, digits and hyphens'),
      token: z.string().min(20).describe('Discord bot token; stored in the bot .env with mode 0600'),
      displayName: z.string().optional().describe('Friendly name shown in the panel'),
      templateId: z.string().optional().describe('Template id from list_templates (default: discordjs-blank)'),
      description: z.string().optional(),
      source: z.enum(['template', 'github']).optional().describe('Creation source (default: template)'),
      repoUrl: z.string().optional().describe('Public GitHub URL when source=github'),
      branch: z.string().optional(),
      exposeOnMcp: z.boolean().optional().describe('Expose the new bot on MCP (default: false)')
    })
  }, async ({ name, token, displayName, templateId = 'discordjs-blank', description = '', source = 'template', repoUrl, branch = '', exposeOnMcp = false }) => {
    const safeName = sanitizeBotName(name);
    if (!safeName) throw new Error('Invalid bot name (lowercase, digits, hyphens, 2-64 chars)');
    if (!token || String(token).trim().length < 20) throw new Error('Discord token is too short');
    if (getDb().getBot(safeName)) throw new Error(`Bot "${safeName}" already exists`);

    let entry = 'index.js';
    try {
      if (source === 'github') {
        if (!fsService.parseGitHubUrl(repoUrl)) throw new Error('Invalid GitHub URL. Use https://github.com/owner/repo');
        const imported = await fsService.importFromGitHub({
          name: safeName, repoUrl, branch, token: String(token).trim(), language: 'en'
        });
        entry = imported.entry;
      } else {
        await fsService.createBot({
          name: safeName, token: String(token).trim(), templateId, language: 'en'
        });
      }
      const bot = getDb().createBot({
        name: safeName,
        display_name: displayName || safeName,
        description,
        template: source === 'github' ? 'github' : templateId,
        language: 'en',
        startup_file: entry,
        mcp_exposed: exposeOnMcp === true
      });
      getDb().logActivity({
        action: source === 'github' ? 'bot_imported' : 'bot_created',
        bot_name: safeName,
        user: 'mcp',
        details: source === 'github' ? `MCP GitHub import: ${repoUrl}` : `MCP template: ${templateId}`
      });
      return textResult({ bot: publicBot(bot), startupFile: entry });
    } catch (e) {
      try { fsService.deleteBot(safeName); } catch (_) {}
      try { getDb().deleteBot(safeName); } catch (_) {}
      throw e;
    }
  });

  server.registerTool('get_bot', {
    title: 'Get bot details',
    description: 'Return the exposed bot configuration, PM2 status, top-level files and dependencies.',
    inputSchema: z.object({ bot: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ bot: name }) => {
    const bot = requireExposed(name);
    const bPath = fsService.botPath(bot.name);
    let files = [];
    try { files = listEntries(bot.name, '').entries.map(e => e.path); } catch (_) {}
    let dependencies = {};
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(bPath, 'package.json'), 'utf8'));
      dependencies = pkg.dependencies || {};
    } catch (_) {}
    return textResult({ bot: await botWithStatus(bot), files, dependencies });
  });

  server.registerTool('set_bot_mcp_exposure', {
    title: 'Expose or hide a bot on MCP',
    description: 'Toggle the "Expose on MCP" option for a bot. This is the same option available in the bot customization page.',
    inputSchema: z.object({ bot: z.string(), exposed: z.boolean() })
  }, async ({ bot: name, exposed }) => {
    const bot = requireBot(name);
    const updated = getDb().updateBot(bot.name, { mcp_exposed: exposed === true });
    getDb().logActivity({ action: 'bot_mcp_exposure', bot_name: bot.name, user: 'mcp', details: exposed ? 'exposed' : 'hidden' });
    return textResult({ bot: publicBot(updated) });
  });

  // Power --------------------------------------------------
  for (const [tool, action] of [['start_bot', 'start'], ['stop_bot', 'stop'], ['restart_bot', 'restart']]) {
    server.registerTool(tool, {
      title: action === 'start' ? 'Start a bot' : action === 'stop' ? 'Stop a bot' : 'Restart a bot',
      description: `Ask PM2 to ${action} an exposed bot.`,
      inputSchema: z.object({ bot: z.string() }),
      annotations: action === 'stop' ? { destructiveHint: true } : undefined
    }, async ({ bot: name }) => {
      const bot = requireExposed(name);
      const bPath = fsService.botPath(bot.name);
      const entry = bot.startup_file || 'index.js';
      if (action !== 'stop' && !fs.existsSync(path.join(bPath, entry))) {
        throw new Error(`Startup file "${entry}" not found`);
      }
      if (action === 'start') {
        await pm2Service.start(bot.name, bPath, {
          script: entry, maxMemory: bot.memory_limit, cronRestart: bot.restart_cron
        });
        getDb().updateBot(bot.name, { last_started: new Date().toISOString() });
      } else if (action === 'stop') {
        await pm2Service.stop(bot.name);
      } else {
        await pm2Service.restart(bot.name);
      }
      getDb().logActivity({ action: `bot_${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'}`, bot_name: bot.name, user: 'mcp' });
      return textResult({ bot: bot.name, action, pm2: await pm2View(bot) });
    });
  }

  server.registerTool('get_bot_logs', {
    title: 'Read bot logs',
    description: 'Return the last stdout/stderr lines of an exposed bot. Known secrets are redacted.',
    inputSchema: z.object({ bot: z.string(), lines: z.number().int().min(1).max(500).optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ bot: name, lines = 100 }) => {
    const bot = requireExposed(name);
    const logs = await pm2Service.getLogs(bot.name, lines);
    return textResult({
      bot: bot.name,
      stdout: (logs.out || []).map(redactSecrets),
      stderr: (logs.err || []).map(redactSecrets)
    });
  });

  // Files --------------------------------------------------
  server.registerTool('list_files', {
    title: 'List bot files',
    description: 'List one directory of an exposed bot. Paths are relative to the bot root; use "" for the root.',
    inputSchema: z.object({ bot: z.string(), path: z.string().optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ bot: name, path: rel = '' }) => {
    const bot = requireExposed(name);
    return textResult({ bot: bot.name, ...listEntries(bot.name, rel) });
  });

  server.registerTool('read_file', {
    title: 'Read a bot file',
    description: 'Read a UTF-8 text file from an exposed bot (max 2 MB). Secrets may be present in .env; handle the output carefully.',
    inputSchema: z.object({ bot: z.string(), path: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ bot: name, path: rel }) => {
    const bot = requireExposed(name);
    const filePath = resolveFile(bot.name, rel);
    if (!filePath) throw new Error('Access denied or unsupported file type');
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Not a regular file');
    if (stat.size > 2 * 1024 * 1024) throw new Error('File is larger than 2 MB');
    return textResult({
      bot: bot.name,
      path: toRelative(bot.name, rel),
      size: stat.size,
      content: fs.readFileSync(filePath, 'utf8')
    });
  });

  server.registerTool('write_file', {
    title: 'Write a bot file',
    description: 'Create or replace a UTF-8 text file in an exposed bot (max 2 MB). The bot must be restarted to apply code changes.',
    inputSchema: z.object({ bot: z.string(), path: z.string(), content: z.string().max(2 * 1024 * 1024) }),
    annotations: { destructiveHint: true }
  }, async ({ bot: name, path: rel, content }) => {
    const bot = requireExposed(name);
    if (Buffer.byteLength(String(content || ''), 'utf8') > 2 * 1024 * 1024) throw new Error('Content is larger than 2 MB');
    const filePath = resolveFile(bot.name, rel);
    if (!filePath) throw new Error('Access denied or unsupported file type');
    fsService.writeFile(filePath, content);
    getDb().logActivity({ action: 'file_saved', bot_name: bot.name, user: 'mcp', details: toRelative(bot.name, rel) });
    return textResult({ bot: bot.name, path: toRelative(bot.name, rel), saved: true });
  });

  server.registerTool('create_path', {
    title: 'Create a file or folder',
    description: 'Create an empty file or a folder in an exposed bot. The parent folder must already exist.',
    inputSchema: z.object({
      bot: z.string(),
      path: z.string().describe('Relative path including the new name, e.g. src/commands/ping.js'),
      type: z.enum(['file', 'dir']).optional()
    })
  }, async ({ bot: name, path: rel, type = 'file' }) => {
    const bot = requireExposed(name);
    const relClean = String(rel || '').replace(/\\/g, '/');
    const parts = relClean.split('/').filter(Boolean);
    const baseName = parts.pop();
    if (!baseName || !isValidFileName(baseName)) throw new Error('Invalid file name');
    const parent = resolveDir(bot.name, parts.join('/'));
    if (parent.forbidden) throw new Error('Access denied');
    if (parent.missing) throw new Error('Parent folder not found');
    const target = path.join(parent.dir, baseName);
    if (!isInside(parent.bPath, target) || !isInsideReal(parent.bPath, target)) throw new Error('Access denied');
    if (fs.existsSync(target)) throw new Error('An entry with this name already exists');
    if (type === 'dir') {
      fs.mkdirSync(target);
    } else {
      fs.writeFileSync(target, '', { encoding: 'utf8', flag: 'wx', mode: baseName === '.env' ? 0o600 : 0o644 });
    }
    getDb().logActivity({ action: type === 'dir' ? 'folder_created' : 'file_created', bot_name: bot.name, user: 'mcp', details: relClean });
    return textResult({ bot: bot.name, path: relClean, type });
  });

  server.registerTool('delete_path', {
    title: 'Delete a file or folder',
    description: 'Delete a file or folder inside an exposed bot. The bot root cannot be deleted.',
    inputSchema: z.object({ bot: z.string(), path: z.string() }),
    annotations: { destructiveHint: true }
  }, async ({ bot: name, path: rel }) => {
    const bot = requireExposed(name);
    const source = resolveAny(bot.name, rel);
    if (source.forbidden) throw new Error('Access denied');
    if (source.missing) throw new Error('Entry not found');
    if (source.stat.isDirectory()) fs.rmSync(source.full, { recursive: true, force: true });
    else fs.unlinkSync(source.full);
    getDb().logActivity({ action: 'file_deleted', bot_name: bot.name, user: 'mcp', details: source.rel });
    return textResult({ bot: bot.name, path: source.rel, deleted: true });
  });

  server.registerTool('rename_path', {
    title: 'Rename a file or folder',
    description: 'Rename an entry inside an exposed bot without changing its parent folder.',
    inputSchema: z.object({ bot: z.string(), path: z.string(), newName: z.string() })
  }, async ({ bot: name, path: rel, newName }) => {
    const bot = requireExposed(name);
    if (!isValidFileName(newName)) throw new Error('Invalid new name');
    const source = resolveAny(bot.name, rel);
    if (source.forbidden) throw new Error('Access denied');
    if (source.missing) throw new Error('Entry not found');
    const dest = path.join(path.dirname(source.full), newName);
    if (!isInside(source.bPath, dest) || !isInsideReal(source.bPath, dest)) throw new Error('Access denied');
    if (fs.existsSync(dest)) throw new Error('An entry with this name already exists');
    fs.renameSync(source.full, dest);
    if (path.basename(dest) === '.env') { try { fs.chmodSync(dest, 0o600); } catch (_) {} }
    getDb().logActivity({ action: 'file_renamed', bot_name: bot.name, user: 'mcp', details: `${source.rel} -> ${newName}` });
    return textResult({ bot: bot.name, from: source.rel, to: toRelative(bot.name, dest) });
  });

  server.registerTool('move_path', {
    title: 'Move a file or folder',
    description: 'Move an entry inside an exposed bot to another folder.',
    inputSchema: z.object({ bot: z.string(), path: z.string(), toDir: z.string().optional() })
  }, async ({ bot: name, path: rel, toDir = '' }) => {
    const bot = requireExposed(name);
    const source = resolveAny(bot.name, rel);
    if (source.forbidden) throw new Error('Access denied');
    if (source.missing) throw new Error('Entry not found');
    const target = resolveDir(bot.name, toDir);
    if (target.forbidden) throw new Error('Access denied');
    if (target.missing) throw new Error('Target folder not found');
    const dest = path.join(target.dir, path.basename(source.full));
    if (dest === source.full) return textResult({ bot: bot.name, from: source.rel, to: source.rel, unchanged: true });
    if (source.stat.isDirectory() && (dest === source.full || target.dir.startsWith(source.full + path.sep))) {
      throw new Error('Cannot move a folder inside itself');
    }
    if (fs.existsSync(dest)) throw new Error('An entry with this name already exists in the target folder');
    if (!isInside(source.bPath, dest) || !isInsideReal(source.bPath, dest)) throw new Error('Access denied');
    fs.renameSync(source.full, dest);
    if (path.basename(dest) === '.env') { try { fs.chmodSync(dest, 0o600); } catch (_) {} }
    getDb().logActivity({ action: 'file_moved', bot_name: bot.name, user: 'mcp', details: `${source.rel} -> ${toDir || '/'}` });
    return textResult({ bot: bot.name, from: source.rel, to: toRelative(bot.name, dest) });
  });

  // Environment --------------------------------------------
  server.registerTool('get_bot_env', {
    title: 'Read bot environment variables',
    description: 'Return the parsed .env key/value pairs of an exposed bot. Values may include the Discord token.',
    inputSchema: z.object({ bot: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ bot: name }) => {
    const bot = requireExposed(name);
    let content = '';
    try { content = fs.readFileSync(path.join(fsService.botPath(bot.name), '.env'), 'utf8'); } catch (_) {}
    return textResult({ bot: bot.name, vars: parseEnvFile(content) });
  });

  server.registerTool('update_bot_env', {
    title: 'Update bot environment variables',
    description: 'Replace the .env key/value pairs of an exposed bot. The bot must be restarted to load the new values.',
    inputSchema: z.object({
      bot: z.string(),
      vars: z.array(z.object({ key: z.string(), value: z.string() })).max(100)
    }),
    annotations: { destructiveHint: true }
  }, async ({ bot: name, vars }) => {
    const bot = requireExposed(name);
    const seen = new Set();
    const clean = [];
    for (const item of vars) {
      const key = String(item.key || '').trim();
      const value = String(item.value || '');
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`Invalid variable name: ${key}`);
      if (seen.has(key)) throw new Error(`Duplicate variable: ${key}`);
      if (/[\r\n]/.test(value) || value.length > 4096) throw new Error(`Invalid value for ${key}`);
      seen.add(key); clean.push({ key, value });
    }
    const envPath = path.join(fsService.botPath(bot.name), '.env');
    fs.writeFileSync(envPath, serializeEnvFile(bot.name, clean), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(envPath, 0o600); } catch (_) {}
    getDb().logActivity({ action: 'bot_env_updated', bot_name: bot.name, user: 'mcp' });
    return textResult({ bot: bot.name, vars: clean });
  });

  // npm ----------------------------------------------------
  server.registerTool('list_packages', {
    title: 'List bot dependencies',
    description: 'Return the dependencies and scripts declared by an exposed bot package.json.',
    inputSchema: z.object({ bot: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ bot: name }) => {
    const bot = requireExposed(name);
    const pkgPath = path.join(fsService.botPath(bot.name), 'package.json');
    if (!fs.existsSync(pkgPath)) throw new Error('package.json not found');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return textResult({ bot: bot.name, dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {}, scripts: pkg.scripts || {} });
  });

  server.registerTool('install_package', {
    title: 'Install an npm package',
    description: 'Install a runtime npm package in an exposed bot with lifecycle scripts disabled.',
    inputSchema: z.object({ bot: z.string(), package: z.string(), dev: z.boolean().optional() })
  }, async ({ bot: name, package: pkg, dev = false }) => {
    const bot = requireExposed(name);
    if (!isValidPackageName(pkg)) throw new Error('Invalid package name');
    const dir = fsService.botPath(bot.name);
    try {
      const out = execFileSync('npm', ['install', pkg, dev ? '--save-dev' : '--save', ...NPM_ARGS], {
        cwd: dir, timeout: 120000, env: SAFE_ENV, encoding: 'utf8', shell: false
      });
      getDb().logActivity({ action: 'npm_installed', bot_name: bot.name, user: 'mcp', details: pkg });
      return textResult({ bot: bot.name, package: pkg, installed: true, output: String(out || '').slice(-2000) });
    } catch (e) {
      throw new Error(`npm install failed: ${sanitizeLogText(String(e.message || '').split('\n')[0])}`);
    }
  });

  server.registerTool('remove_package', {
    title: 'Remove an npm package',
    description: 'Uninstall a package from an exposed bot.',
    inputSchema: z.object({ bot: z.string(), package: z.string() }),
    annotations: { destructiveHint: true }
  }, async ({ bot: name, package: pkg }) => {
    const bot = requireExposed(name);
    if (!isValidPackageName(pkg)) throw new Error('Invalid package name');
    const dir = fsService.botPath(bot.name);
    try {
      execFileSync('npm', ['uninstall', pkg, '--save', ...NPM_ARGS], {
        cwd: dir, timeout: 60000, env: SAFE_ENV, encoding: 'utf8', shell: false
      });
      getDb().logActivity({ action: 'npm_removed', bot_name: bot.name, user: 'mcp', details: pkg });
      return textResult({ bot: bot.name, package: pkg, removed: true });
    } catch (e) {
      throw new Error(`npm uninstall failed: ${sanitizeLogText(String(e.message || '').split('\n')[0])}`);
    }
  });

  return server;
}

module.exports = { buildServer };
