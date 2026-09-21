'use strict';
/**
 * Nexus Bot Manager — Database Layer
 * Pure-JS JSON store. No native bindings = works on any Node version.
 * Schema-less internally but enforces structure via the API layer.
 */

const path = require('path');
const fs   = require('fs');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'nexus.db.json');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

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
    notifications_enabled: true
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
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        // Deep merge — preserve defaults for missing keys
        this.data = { ...DEFAULT_DATA, ...parsed };
        this.data.settings = { ...DEFAULT_DATA.settings, ...parsed.settings };
      }
    } catch (e) {
      console.error('[DB] Load error:', e.message, '— using defaults');
    }
  }

  _migrate() {
    let changed = false;
    // v1→v2: add templates array
    if (!Array.isArray(this.data.templates)) {
      this.data.templates = [];
      changed = true;
    }
    // v1→v2: add settings.setup_done
    if (this.data.settings.setup_done === undefined) {
      // If users exist, assume setup was done
      this.data.settings.setup_done = this.data.users.length > 0;
      changed = true;
    }
    if (changed) this._saveNow();
  }

  // Debounced save — batches rapid writes into one FS op
  _save() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => this._saveNow(), 100);
  }

  _saveNow() {
    try {
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);  // atomic write
    } catch (e) {
      console.error('[DB] Save error:', e.message);
    }
  }

  _nextId(table) {
    if (!this.data._counters[table]) this.data._counters[table] = 0;
    this.data._counters[table]++;
    return this.data._counters[table];
  }

  // ── Settings ──────────────────────────────────────────────
  getSettings()               { return { ...this.data.settings }; }
  updateSettings(patch)       { Object.assign(this.data.settings, patch); this._save(); return this.data.settings; }

  // ── Users ─────────────────────────────────────────────────
  getUser(id)                 { return this.data.users.find(u => u.id === id) || null; }
  getUserByUsername(username) { return this.data.users.find(u => u.username === username.toLowerCase()) || null; }
  getAllUsers()               { return [...this.data.users]; }
  isSetupDone()               { return this.data.settings.setup_done && this.data.users.length > 0; }

  createUser({ username, password_hash, role = 'admin' }) {
    if (this.getUserByUsername(username)) throw new Error('Username already exists');
    const user = {
      id:            this._nextId('users'),
      username:      username.toLowerCase(),
      password_hash,
      role,
      created_at:    new Date().toISOString(),
      last_login:    null
    };
    this.data.users.push(user);
    this._save();
    return user;
  }

  updateUser(id, patch) {
    const u = this.getUser(id);
    if (!u) throw new Error('User not found');
    Object.assign(u, patch);
    this._save();
    return u;
  }

  // ── Bots ──────────────────────────────────────────────────
  getBot(name)      { return this.data.bots.find(b => b.name === name) || null; }
  getAllBots()       { return [...this.data.bots].sort((a,b) => new Date(b.created_at) - new Date(a.created_at)); }

  createBot({ name, display_name, description = '', template = 'blank', language = 'en' }) {
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

  // ── Backups ───────────────────────────────────────────────
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

  // ── Activity Log ──────────────────────────────────────────
  getActivity(limit = 50) {
    return [...this.data.activity_log]
      .sort((a,b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
  }

  logActivity({ action, bot_name = null, details = '', user = 'system' }) {
    const entry = {
      id:         this._nextId('activity_log'),
      action,
      bot_name,
      details,
      user,
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

module.exports = { getDb };
