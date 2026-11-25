'use strict';
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SAFE_ENV, isInside, isSafeRelativePath, isValidPackageName } = require('../middleware/security');
const templates     = require('./templates.service');

function botsRoot() { return path.resolve(process.env.BOTS_ROOT || '/opt'); }
function botPath(name) { return path.join(botsRoot(), name); }

// -- GitHub import ------------------------------------------
/**
 * Parse a public GitHub repository URL. Only https://github.com/<owner>/<repo>
 * (optionally ending in .git) is accepted; credentials, ports, query strings
 * and other hosts are refused before git is ever invoked.
 */
function parseGitHubUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null;
  if (u.username || u.password || u.port || u.search || u.hash) return null;
  const parts = u.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(parts[0])) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(parts[1])) return null;
  return {
    owner: parts[0],
    repo:  parts[1],
    url:   `https://github.com/${parts[0]}/${parts[1]}.git`
  };
}

function normalizeBranch(branch) {
  const b = String(branch || '').trim();
  if (!b) return '';
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(b)) return null;
  if (b.includes('..') || b.startsWith('-') || b.startsWith('/') || b.endsWith('/')) return null;
  return b;
}

function detectEntryFile(dir, pkg) {
  const candidates = [];
  if (pkg && typeof pkg.main === 'string') candidates.push(pkg.main);
  candidates.push('index.js', 'bot.js', 'main.js', 'src/index.js', 'src/bot.js', 'src/main.js');
  for (const candidate of candidates) {
    const clean = String(candidate).replace(/^\.\//, '');
    if (!isSafeRelativePath(clean)) continue;
    if (fs.existsSync(path.join(dir, clean)) && fs.statSync(path.join(dir, clean)).isFile()) {
      return clean;
    }
  }
  return 'index.js';
}

function ensureEnvToken(dir, token) {
  const envPath = path.join(dir, '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch (_) {}
  if (/^\s*TOKEN\s*=/m.test(content)) {
    // A public repository must not decide which Discord token the bot uses.
    content = content.replace(/^\s*TOKEN\s*=.*$/m, `TOKEN=${token}`);
  } else {
    content += (content && !content.endsWith('\n') ? '\n' : '') + `TOKEN=${token}\n`;
  }
  fs.writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch (_) {}
}

async function importFromGitHub({ name, repoUrl, branch = '', token, language = 'en' }) {
  const dir = botPath(name);
  if (fs.existsSync(dir)) throw new Error(`Le dossier ${dir} existe déjà.`);

  const repo = parseGitHubUrl(repoUrl);
  if (!repo) throw new Error('URL GitHub invalide. Utilisez https://github.com/utilisateur/depot');
  const cleanBranch = normalizeBranch(branch);
  if (cleanBranch === null) throw new Error('Nom de branche invalide');

  try {
    const args = ['clone', '--depth', '1', '--single-branch'];
    if (cleanBranch) args.push('--branch', cleanBranch);
    args.push('--', repo.url, dir);
    try {
      execFileSync('git', args, {
        timeout: 180000, env: SAFE_ENV, stdio: 'pipe', shell: false
      });
    } catch (e) {
      const detail = String(e.stderr || e.message || '').split('\n')[0];
      if (e.code === 'ENOENT') throw new Error('Git n\'est pas installé sur le serveur.');
      throw new Error(`Clonage GitHub échoué : ${detail}`);
    }

    // The panel manages the source tree itself; keep the import lean and
    // avoid exposing a nested repository in the file manager.
    try { fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true }); } catch (_) {}

    let pkg = null;
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) {}
    }
    const entry = detectEntryFile(dir, pkg);
    if (!pkg) {
      pkg = {
        name,
        version: '1.0.0',
        private: true,
        main: entry,
        scripts: { start: `node ${entry}` },
        description: 'Discord bot imported from GitHub'
      };
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    } else if (!pkg.main || !fs.existsSync(path.join(dir, String(pkg.main)))) {
      pkg.main = entry;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }

    ensureEnvToken(dir, token);

    // Install runtime dependencies without executing lifecycle scripts:
    // an imported repository is untrusted code until the operator starts it.
    if (pkg && pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
      const npmArgs = hasLock
        ? ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=warn']
        : ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=warn'];
      try {
        execFileSync('npm', npmArgs, {
          cwd: dir, timeout: 180000, env: SAFE_ENV, stdio: 'pipe', shell: false
        });
      } catch (e) {
        console.warn(`[fs] npm install warning for imported ${name}:`, String(e.stderr || e.message || '').split('\n')[0]);
        // Non-fatal: the operator can reinstall from the npm page.
      }
    }

    return { dir, entry, repoUrl: `https://github.com/${repo.owner}/${repo.repo}` };
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
}


// -- Bot creation -------------------------------------------
async function createBot({ name, token, templateId = 'discordjs-blank', extraPackages = [], envVars = {}, language = 'en' }) {
  const dir = botPath(name);
  if (fs.existsSync(dir)) throw new Error(`Le dossier /opt/${name} existe déjà.`);

  fs.mkdirSync(dir, { recursive: true });

  // Generate files from template (passing language so the template can
  // localize the user-facing strings it embeds).
  let files;
  try {
    files = templates.generateFiles(templateId, { language });
  } catch (e) {
    // Fallback to minimal bot
    files = { 'index.js': `require('dotenv').config();\nconst { Client, GatewayIntentBits } = require('discord.js');\nconst client = new Client({ intents: [GatewayIntentBits.Guilds] });\nclient.once('ready', () => console.log('Connecté'));\nprocess.on('unhandledRejection', console.error);\nclient.login(process.env.TOKEN);\n` };
  }

  // Write template files.
  // Templates may legitimately produce nested names such as
  // "commands/ping.js", so each path segment is validated and the
  // resolved path is re-checked against the bot directory. A template is
  // data, and data that reaches path.join(dir, fname) must not be able to
  // write outside dir.
  for (const [fname, content] of Object.entries(files)) {
    if (!isSafeRelativePath(fname)) {
      throw new Error(`Nom de fichier de template refusé : ${String(fname).slice(0, 60)}`);
    }
    const fpath = path.join(dir, fname);
    if (!isInside(dir, fpath)) {
      throw new Error(`Nom de fichier de template hors périmètre : ${String(fname).slice(0, 60)}`);
    }
    fs.mkdirSync(path.dirname(fpath), { recursive: true });
    fs.writeFileSync(fpath, content, 'utf8');
  }

  // Write .env — always include TOKEN + any custom vars
  const tpl = templates.getTemplate(templateId);
  let envContent = `# Bot: ${name}\n# Generated by Nexus Bot Manager\n\nTOKEN=${token || ''}\n`;
  if (tpl) {
    for (const ev of tpl.envVars || []) {
      if (ev.key === 'TOKEN') continue;
      const val = envVars[ev.key] || '';
      envContent += `${ev.key}=${val}\n`;
    }
  }
  fs.writeFileSync(path.join(dir, '.env'), envContent, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(path.join(dir, '.env'), 0o600); } catch (_) {}

  // package.json
  const pkgJson = {
    name, version: '1.0.0', main: 'index.js',
    scripts: { start: 'node index.js' },
    description: `Discord bot managed by Nexus Bot Manager`
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2));

  // .gitignore
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n*.log\ndata/\n');

  // README
  fs.writeFileSync(path.join(dir, 'README.md'),
    `# ${name}\n\nBot Discord géré par [Nexus Bot Manager](https://github.com/Julien48003/nexus-bot-manager).\n\n` +
    `- Template: ${templateId}\n- Créé le: ${new Date().toLocaleDateString('fr-FR')}\n\n` +
    `## Démarrage\n\`\`\`bash\nnode index.js\n\`\`\`\n`);

  // npm install
  const tplPkgs = (tpl && tpl.packages) || ['discord.js', 'dotenv'];
  const extra   = (Array.isArray(extraPackages) ? extraPackages : []).map(String).filter(isValidPackageName);
  const allPkgs = [...new Set([...tplPkgs, ...extra])];

  try {
    // --ignore-scripts: a dependency's lifecycle script would otherwise
    // execute with the backend's privileges (and its environment).
    execFileSync('npm', ['install', ...allPkgs, '--save', '--no-audit', '--no-fund', '--loglevel=warn', '--ignore-scripts'], {
      cwd: dir, timeout: 120000, env: SAFE_ENV, stdio: 'pipe', shell: false
    });
  } catch (e) {
    console.warn(`[fs] npm install warning for ${name}:`, e.message?.split('\n')[0]);
    // Non-fatal — bot created, user can install deps manually
  }

  return dir;
}

function deleteBot(name) {
  const dir = botPath(name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// -- File tree (recursive, excludes node_modules) ----------
function listDirectory(dirPath, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return [];
  const items = [];
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      if (entry.name.startsWith('.') && !['env', 'gitignore'].some(n => entry.name.endsWith(n))) continue;

      const full = path.join(dirPath, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;          // never follow a link out of the tree
      if (entry.isDirectory()) {
        items.push({ name: entry.name, type: 'dir', path: full, children: listDirectory(full, depth + 1, maxDepth) });
      } else {
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_) {}
        items.push({ name: entry.name, type: 'file', path: full, size });
      }
    }
  } catch (_) {}

  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function readFile(fp)           { return fs.readFileSync(fp, 'utf8'); }
function writeFile(fp, content) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, { encoding: 'utf8', mode: 0o644 });
  // A bot's .env holds its Discord token: never leave it world-readable.
  if (path.basename(fp) === '.env') {
    try { fs.chmodSync(fp, 0o600); } catch (_) {}
  }
}
function deleteFile(fp)         { fs.unlinkSync(fp); }
function renameFile(old, nw)    { fs.renameSync(old, nw); }
function createDir(dp)          { fs.mkdirSync(dp, { recursive: true }); }

module.exports = {
  createBot, deleteBot, listDirectory, readFile, writeFile, deleteFile, renameFile, createDir,
  botPath, botsRoot, importFromGitHub, parseGitHubUrl, detectEntryFile, normalizeBranch
};
