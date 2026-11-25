'use strict';
/**
 * Nexus Bot Manager — Database Layer
 * Pure-JS JSON store. No native bindings = works on any Node version.
 * Schema-less internally but enforces structure via the API layer.
 *
 * SECURITY NOTES (2026 hardening)
 *  - A corrupt/ truncated data file must NEVER silently fall back to
 *    DEFAULT_DATA: doing so made the app believe setup had never
 *    happened and re-opened POST /api/auth/setup (INF-03 / AUTH-01).
 *    A damaged file is now fatal and loudly reported.
 *  - A separate, never-deleted marker file records that setup completed,
 *    so restoring an old backup of nexus.db.json cannot re-open the
 *    setup window.
 *  - Writes are fsync'ed and chmod'ed 0600: the file holds bcrypt
 *    hashes and the activity log.
 */

const path = require('path');
const fs   = require('fs');
const { sanitizeLogText } = require('../middleware/security');

// The data directory can be relocated with NEXUS_DATA_DIR. Production
// keeps the default (backend/data); the test suite points it at a
// throwaway sandbox so a run never touches a real install.
const DATA_DIR = process.env.NEXUS_DATA_DIR
  ? path.resolve(process.env.NEXUS_DATA_DIR)
  : path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'nexus.db.json');

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const DEFAULT_DATA = {
  _version: 2,
  _counters: {},
  settings: {
    instance_name: null,       // null = setup not done
    setup_done: false,
    theme: 'dark',
    language: 'fr',
    bot_autorestart: true,
    bot_max_restarts: 5,
    monitoring_interval: 5,    // seconds
    notifications_enabled: true,
    mcp_enabled: false,
    mcp_token: null
  },
  users: [],
  bots: [],
  backups: [],
  activity_log: [],
  templates: []
};

let _db = null;
let _saveTimer = null;

class NexusDB {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    this._load();
    this._migrate();
  }

  _load() {
    let raw;
    try {
      if (fs.existsSync(this.filePath)) {
        raw = fs.readFileSync(this.filePath, 'utf8');
      }
    } catch (e) {
      this._fatalUnreadable(e);
      return;
    }

    if (raw === undefined) return;   // first run: no file yet

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('la racine du document n\'est pas un objet JSON');
      }
    } catch (e) {
      // INF-03: a damaged file used to be swallowed here, which reset
      // settings.setup_done to false and re-opened the unauthenticated
      // setup endpoint. Refuse to start instead.
      this._fatalCorrupt(e);
      return;
    }

    // Deep merge — preserve defaults for missing keys
    this.data = { ...JSON.parse(JSON.stringify(DEFAULT_DATA)), ...parsed };
    this.data.settings = { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) };
    for (const key of ['users', 'bots', 'backups', 'activity_log', 'templates']) {
      if (!Array.isArray(this.data[key])) this.data[key] = [];
    }
    if (!this.data._counters || typeof this.data._counters !== 'object') {
      this.data._counters = {};
    }
  }

  _fatalCorrupt(err) {
    const backup = `${this.filePath}.corrupt-${Date.now()}`;
    try { fs.renameSync(this.filePath, backup); } catch (_) {}
    console.error('');
    console.error('[DB] FATAL — fichier de base de données illisible :', this.filePath);
    console.error(`[DB]       ${err.message}`);
    console.error(`[DB]       Le fichier d'origine a été préservé sous : ${backup}`);
    console.error('[DB]       L\'instance est ARRÊTÉE. Restaurez une sauvegarde');
    console.error('[DB]       valide de nexus.db.json puis redémarrez.');
    console.error('[DB]       Le service ne redémarre pas sur des données par');
    console.error('[DB]       défaut : cela rouvrirait la configuration initiale');
    console.error('[DB]       en libre-service et permettrait une prise de contrôle.');
    console.error('');
    process.exit(1);
  }

  _fatalUnreadable(err) {
    console.error('[DB] FATAL — impossible de lire', this.filePath, '—', err.message);
    process.exit(1);
  }

  _migrate() {
    let changed = false;
    // v1->v2: add templates array
    if (!Array.isArray(this.data.templates)) {
      this.data.templates = [];
      changed = true;
    }
    // v1->v2: add settings.setup_done
    if (this.data.settings.setup_done === undefined) {
      // If users exist, assume setup was done
      this.data.settings.setup_done = this.data.users.length > 0;
      changed = true;
    }
    // A marker file from a previous install proves setup already ran,
    // even if the JSON file was replaced by an older backup.
    if (!this.data.settings.setup_done && this.setupWasCompleted()) {
      this.data.settings.setup_done = true;
      changed = true;
      console.log('[DB] Setup déjà effectué (marqueur .setup-completed) — configuration verrouillée');
    }
    // v2.1: per-bot hosting options. Existing bots that were started at
    // least once keep their previous "restore on bounce" behaviour.
    for (const bot of this.data.bots) {
      if (bot.autostart === undefined) {
        bot.autostart = !!bot.last_started;
        changed = true;
      }
      if (bot.startup_file === undefined) {
        bot.startup_file = 'index.js';
        changed = true;
      }
      if (bot.avatar === undefined) {
        bot.avatar = null;
        changed = true;
      }
      if (bot.memory_limit === undefined) {
        bot.memory_limit = null;
        changed = true;
      }
      if (bot.restart_cron === undefined) {
        bot.restart_cron = null;
        changed = true;
      }
      if (bot.mcp_exposed === undefined) {
        bot.mcp_exposed = false;
        changed = true;
      }
    }
    if (changed) this._saveNow();
  }

  // -- Setup lock (AUTH-01 defense in depth) -----------------
  /**
   * The marker is derived from this database's own path, not from a
   * shared constant: it belongs to the file it protects, so copying or
   * restoring the JSON file carries its lock with it, and two databases
   * living in one directory never interfere with each other.
   */
  get setupLockPath() { return this.filePath + '.setup-done'; }

  setupWasCompleted() {
    try { return fs.existsSync(this.setupLockPath); } catch (_) { return false; }
  }

  markSetupCompleted() {
    try {
      fs.writeFileSync(this.setupLockPath, new Date().toISOString(), { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      console.error('[DB] Impossible d\'écrire le marqueur de setup:', e.message);
    }
  }

  // -- Debounced save — batches rapid writes into one FS op ---
  _save() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => this._saveNow(), 100);
  }

  _saveNow() {
    try {
      const tmp = this.filePath + '.tmp';
      // Never follow a stale/symlinked temp file: remove the directory entry
      // (not its target) and create exclusively. A local user able to write
      // the data directory cannot redirect this write to another file.
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
      const fd  = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(this.data, null, 2), 'utf8');
        fs.fsyncSync(fd);                 // INF-10: the rename alone is not durable
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.filePath);  // atomic write
      try { fs.chmodSync(this.filePath, 0o600); } catch (_) {}
    } catch (e) {
      console.error('[DB] Save error:', e.message);
    }
  }

  flush() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    this._saveNow();
  }

  _nextId(table) {
    if (!this.data._counters[table]) this.data._counters[table] = 0;
    this.data._counters[table]++;
    return this.data._counters[table];
  }

  // -- Token revocation (AUTH-03) ----------------------------
  // Per-token logout. Kept as a small, self-pruning list of jti values
  // with their expiry, so a stolen token can be killed before its 24h
  // natural expiry without logging the legitimate operator out.
  _revoked() {
    if (!Array.isArray(this.data._revoked_jti)) this.data._revoked_jti = [];
    return this.data._revoked_jti;
  }

  revokeToken(jti, expSeconds) {
    if (!jti) return;
    const list = this._revoked();
    const exp  = Number(expSeconds) || 0;
    if (list.some(e => e.jti === jti)) return;
    list.push({ jti, exp });
    this._pruneRevoked();
    this._save();
  }

  revokeAllUserTokens(userId) {
    // Bumping token_version invalidates every token that does not carry
    // the new value — used after a password change.
    const u = this.getUser(userId);
    if (!u) return null;
    u.token_version = (Number(u.token_version) || 0) + 1;
    this._save();
    return u;
  }

  isTokenRevoked(jti, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!jti) return false;
    this._pruneRevoked(nowSeconds);
    return this._revoked().some(e => e.jti === jti);
  }

  _pruneRevoked(nowSeconds = Math.floor(Date.now() / 1000)) {
    const list = this._revoked();
    const kept = list.filter(e => Number(e.exp) > nowSeconds + 60);
    if (kept.length !== list.length) {
      this.data._revoked_jti = kept;
      if (kept.length === 0) delete this.data._revoked_jti;
    }
  }

  // -- Settings ----------------------------------------------
  getSettings()               { return { ...this.data.settings }; }
  updateSettings(patch)       { Object.assign(this.data.settings, patch); this._save(); return this.getSettings(); }

  // -- Users -------------------------------------------------
  getUser(id)                 { return this.data.users.find(u => u.id === id) || null; }
  getUserByUsername(username) { return this.data.users.find(u => u.username === String(username).toLowerCase()) || null; }
  getAllUsers()               { return [...this.data.users]; }

  /**
   * Setup completion no longer depends on `users.length`: an emptied or
   * restored user list must not re-open the setup endpoint. The marker
   * file is the second, independent lock.
   */
  isSetupDone() {
    return this.data.settings.setup_done === true
      || this.setupWasCompleted()
      || this.data.users.length > 0;
  }

  createUser({ username, password_hash, role = 'admin' }) {
    // Defense in depth: a second setup is refused at the data layer too,
    // so a restored/emptied database cannot be used to mint an admin.
    if (this.isSetupDone()) throw new Error('Setup already completed');
    if (this.getUserByUsername(username)) throw new Error('Username already exists');
    const user = {
      id:            this._nextId('users'),
      username:      String(username).toLowerCase(),
      password_hash,
      role,
      token_version: 0,          // bumped to revoke previously issued tokens
      created_at:    new Date().toISOString(),
      last_login:    null
    };
    this.data.users.push(user);
    this._save();
    return user;
  }

  /** Fields a caller is allowed to change. Anything else is ignored (AUTH-15). */
  static USER_MUTABLE = ['last_login', 'password_hash', 'token_version', 'role'];

  updateUser(id, patch) {
    const u = this.getUser(id);
    if (!u) throw new Error('User not found');
    for (const [k, v] of Object.entries(patch || {})) {
      if (NexusDB.USER_MUTABLE.includes(k)) u[k] = v;   // allowlist, not Object.assign
    }
    this._save();
    return u;
  }

  // -- Bots --------------------------------------------------
  getBot(name)      { return this.data.bots.find(b => b.name === name) || null; }
  getAllBots()       { return [...this.data.bots].sort((a,b) => new Date(b.created_at) - new Date(a.created_at)); }

  createBot({ name, display_name, description = '', template = 'blank', language = 'en', avatar = null, autostart = false, startup_file = 'index.js', memory_limit = null, restart_cron = null, mcp_exposed = false }) {
    if (this.getBot(name)) throw new Error(`Bot "${name}" already exists`);
    // Whitelist supported languages
    const lang = ['en', 'fr', 'de'].includes(language) ? language : 'en';
    const bot = {
      id:           this._nextId('bots'),
      name,
      display_name: display_name || name,
      description,
      template,
      language:     lang,
      avatar:       avatar || null,
      autostart:    autostart === true,
      startup_file: startup_file || 'index.js',
      memory_limit: memory_limit || null,
      restart_cron: restart_cron || null,
      mcp_exposed:  mcp_exposed === true,
      created_at:   new Date().toISOString(),
      last_started: null,
      notes:        ''
    };
    this.data.bots.push(bot);
    this._save();
    return bot;
  }

  updateBot(name, patch) {
    const b = this.getBot(name);
    if (!b) throw new Error('Bot not found');
    Object.assign(b, patch);
    this._save();
    return b;
  }

  deleteBot(name) {
    const before = this.data.bots.length;
    this.data.bots = this.data.bots.filter(b => b.name !== name);
    this._save();
    return before !== this.data.bots.length;
  }

  // -- Backups -----------------------------------------------
  getAllBackups() { return [...this.data.backups].sort((a,b) => new Date(b.created_at) - new Date(a.created_at)); }

  createBackup({ bot_name, filename, size_bytes = 0 }) {
    const bk = {
      id:         this._nextId('backups'),
      bot_name,
      filename,
      size_bytes,
      created_at: new Date().toISOString()
    };
    this.data.backups.push(bk);
    this._save();
    return bk;
  }

  deleteBackup(id) {
    const before = this.data.backups.length;
    this.data.backups = this.data.backups.filter(b => b.id !== id);
    this._save();
    return before !== this.data.backups.length;
  }

  // -- Activity Log ------------------------------------------
  getActivity(limit = 50) {
    return [...this.data.activity_log]
      .sort((a,b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
  }

  logActivity({ action, bot_name = null, details = '', user = 'system' }) {
    // INF-16: activity entries are rendered in the admin UI and must not be
    // able to carry control characters / forged lines from a login attempt.
    const entry = {
      id:         this._nextId('activity_log'),
      action,
      bot_name:   bot_name === null ? null : sanitizeLogText(bot_name, 64),
      details:    sanitizeLogText(details, 500),
      user:       sanitizeLogText(user, 64),
      created_at: new Date().toISOString()
    };
    this.data.activity_log.push(entry);
    // Keep only last 500 entries
    if (this.data.activity_log.length > 500) {
      this.data.activity_log = this.data.activity_log.slice(-500);
    }
    this._save();
    return entry;
  }
}

function getDb() {
  if (!_db) {
    _db = new NexusDB(DB_PATH);
    console.log('[DB] Initialized:', DB_PATH);
  }
  return _db;
}

/** Test seam: reset the singleton so a suite can build a fresh store. */
function _resetDbForTests() { _db = null; if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; } }

module.exports = { getDb, NexusDB, DB_PATH, DATA_DIR, _resetDbForTests };
