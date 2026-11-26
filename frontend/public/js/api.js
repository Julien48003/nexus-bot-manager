'use strict';
/**
 * Nexus Bot Manager — API Client
 * All HTTP calls go through here. Protocol-relative URLs = no HTTPS forcing.
 */

const _host = window.location.host;
const _proto = window.location.protocol;
const API = `${_proto}//${_host}/api`;

// -- Token storage -----------------------------------------
const Auth = {
  getToken:    () => localStorage.getItem('nbm_token'),
  setToken:    (t) => localStorage.setItem('nbm_token', t),
  removeToken: () => { localStorage.removeItem('nbm_token'); localStorage.removeItem('nbm_user'); },
  getUser:     () => { try { return JSON.parse(localStorage.getItem('nbm_user') || 'null'); } catch { return null; } },
  setUser:     (u) => localStorage.setItem('nbm_user', JSON.stringify(u)),
};

// -- Core fetch wrapper ------------------------------------
async function apiFetch(method, endpoint, body, opts = {}) {
  const token = Auth.getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (opts.headers) Object.assign(headers, opts.headers);

  const fetchOpts = { method, headers };
  if (body !== undefined && body !== null) fetchOpts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(API + endpoint, fetchOpts);
  } catch (e) {
    throw new Error('Serveur inaccessible. Vérifiez que Nexus Bot Manager est démarré.');
  }

  // Session expired
  if (res.status === 401) {
    Auth.removeToken();
    if (!endpoint.includes('/auth/')) window.location.reload();
    throw new Error('Session expirée');
  }

  let data;
  try { data = await res.json(); } catch { data = {}; }

  if (!res.ok) throw new Error(data.error || `Erreur HTTP ${res.status}`);
  return data;
}

// -- Raw fetch (for file downloads) -----------------------
async function apiFetchRaw(method, endpoint, body) {
  const token = Auth.getToken();
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(API + endpoint, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

// -- API namespaces ----------------------------------------
const api = {
  // Auth
  auth: {
    setupStatus:    ()                       => apiFetch('GET',  '/auth/setup-status'),
    // `opts` carries the one-time X-Setup-Token header required by the
    // first-run wizard.
    setup:          (data, opts)             => apiFetch('POST', '/auth/setup', data, opts),
    login:          (username, password)     => apiFetch('POST', '/auth/login', { username, password }),
    me:             ()                       => apiFetch('GET',  '/auth/me'),
    logout:         ()                       => apiFetch('POST', '/auth/logout'),
    logoutAll:      ()                       => apiFetch('POST', '/auth/logout-all'),
    changePassword: (cur, nw)               => apiFetch('POST', '/auth/change-password', { currentPassword: cur, newPassword: nw }),
    updateProfile:  (data)                   => apiFetch('PATCH', '/auth/profile', data),
    setLanguage:    (language)               => apiFetch('POST', '/auth/language', { language }),
  },

  // Bots
  bots: {
    list:      ()                     => apiFetch('GET',    '/bots'),
    get:       (name)                 => apiFetch('GET',    `/bots/${name}`),
    create:    (data)                 => apiFetch('POST',   '/bots', data),
    update:    (name, data)           => apiFetch('PATCH',  `/bots/${name}`, data),
    delete:    (name)                 => apiFetch('DELETE', `/bots/${name}`),
    start:     (name)                 => apiFetch('POST',   `/bots/${name}/start`),
    stop:      (name)                 => apiFetch('POST',   `/bots/${name}/stop`),
    restart:   (name)                 => apiFetch('POST',   `/bots/${name}/restart`),
    pm2Status: (name)                 => apiFetch('GET',    `/bots/${name}/pm2`),
    logs:      (name, lines = 100)    => apiFetch('GET',    `/bots/${name}/logs?lines=${lines}`),
    npmList:   (name)                 => apiFetch('GET',    `/bots/${name}/npm`),
    npmInstall:(name, pkgs, dev)      => apiFetch('POST',   `/bots/${name}/npm/install`, { packages: pkgs, dev }),
    npmRemove: (name, pkg)            => apiFetch('DELETE', `/bots/${name}/npm/${encodeURIComponent(pkg)}`),
    npmReinstall: (name)              => apiFetch('POST',   `/bots/${name}/npm/reinstall`),
    env:       (name)                 => apiFetch('GET',    `/bots/${name}/env`),
    updateEnv: (name, vars)           => apiFetch('PUT',    `/bots/${name}/env`, { vars }),
    snapshots: (name)                 => apiFetch('GET',    `/bots/${name}/snapshots`),
    createSnapshot: (name, label)     => apiFetch('POST',   `/bots/${name}/snapshots`, { label }),
    restoreSnapshot: (name, id)       => apiFetch('POST',   `/bots/${name}/snapshots/${id}/restore`),
    deleteSnapshot: (name, id)        => apiFetch('DELETE', `/bots/${name}/snapshots/${id}`),
  },

  // User accounts (admin only)
  users: {
    list:          ()            => apiFetch('GET',    '/users'),
    create:        (data)        => apiFetch('POST',   '/users', data),
    update:        (id, data)    => apiFetch('PATCH',  `/users/${id}`, data),
    resetPassword: (id, password)=> apiFetch('POST',   `/users/${id}/password`, { password }),
    delete:        (id)          => apiFetch('DELETE', `/users/${id}`),
  },

  // Files
  files: {
    tree:   (bot)                  => apiFetch('GET',    `/files/${bot}/tree`),
    list:   (bot, fp = '')         => apiFetch('GET',    `/files/${bot}/list?path=${encodeURIComponent(fp)}`),
    read:   (bot, fp)              => apiFetch('GET',    `/files/${bot}/read?path=${encodeURIComponent(fp)}`),
    write:  (bot, fp, content)     => apiFetch('PUT',    `/files/${bot}/write`, { path: fp, content }),
    create: (bot, name, type, par) => apiFetch('POST',   `/files/${bot}/create`, { name, type, parentPath: par }),
    delete: (bot, fp)              => apiFetch('DELETE', `/files/${bot}/delete?path=${encodeURIComponent(fp)}`),
    rename: (bot, old, newName)    => apiFetch('POST',   `/files/${bot}/rename`, { oldPath: old, newName }),
    move:   (bot, items)           => apiFetch('POST',   `/files/${bot}/move`, { items }),
    download: async (bot, fp) => {
      const token = Auth.getToken();
      const res = await fetch(`${API}/files/${bot}/download?path=${encodeURIComponent(fp)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Téléchargement échoué');
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      let filename = 'download';
      if (m) { try { filename = decodeURIComponent(m[1]); } catch (_) { filename = m[1]; } }
      return { blob, filename };
    },
    upload: async (bot, files, targetDir = '') => {
      const token = Auth.getToken();
      const fd = new FormData();
      files.forEach(f => fd.append('files', f));
      fd.append('targetDir', targetDir);
      const res = await fetch(`${API}/files/${bot}/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Upload échoué'); }
      return res.json();
    }
  },

  // System
  system: {
    info:         () => apiFetch('GET',   '/system/info'),
    activity:     (limit) => apiFetch('GET', `/system/activity${limit ? `?limit=${limit}` : ''}`),
    settings:     () => apiFetch('GET',   '/system/settings'),
    updateSettings:(patch) => apiFetch('PATCH', '/system/settings', patch),
    mcpRotate:    ()      => apiFetch('POST',  '/system/mcp/token'),
    templates:    () => {
      // Pass the active language so the backend localizes template metadata
      // (name, description, features, difficulty, category label).
      const lang = (window.NexusI18n && typeof window.NexusI18n.current === 'function') ? window.NexusI18n.current() : 'en';
      return apiFetch('GET', `/system/templates?lang=${encodeURIComponent(lang)}`);
    },
    template:     (id) => apiFetch('GET', `/system/templates/${id}`),
  },

  // Webhooks
  webhooks: {
    list:   ()            => apiFetch('GET',    '/webhooks'),
    events: ()            => apiFetch('GET',    '/webhooks/events'),
    create: (data)        => apiFetch('POST',   '/webhooks', data),
    update: (id, data)    => apiFetch('PATCH',  `/webhooks/${id}`, data),
    delete: (id)          => apiFetch('DELETE', `/webhooks/${id}`),
    test:   (id)          => apiFetch('POST',   `/webhooks/${id}/test`),
  },

  // Panel exports
  exportData: {
    settings: () => apiFetchRaw('GET', '/export/settings'),
    full:     () => apiFetchRaw('GET', '/export/full'),
  },

  // Backups
  backups: {
    list:    ()      => apiFetch('GET',    '/backups'),
    delete:  (id)    => apiFetch('DELETE', `/backups/${id}`),
    export:  (name)  => apiFetchRaw('POST', `/backups/${name}/export`),
    import: async (file) => {
      const token = Auth.getToken();
      const fd = new FormData();
      fd.append('archive', file);
      const res = await fetch(`${API}/backups/import`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Import échoué'); }
      return res.json();
    }
  },

  // Update / version
  update: {
    status:      ()          => apiFetch('GET',  '/update/status'),
    version:     ()          => apiFetch('GET',  '/update/version'),
    check:       ()          => apiFetch('POST', '/update/check'),
    perform:     ()          => apiFetch('POST', '/update/perform'),
    acknowledge: ()          => apiFetch('POST', '/update/acknowledge'),
  },

  health: () => apiFetch('GET', '/health'),
};

window.NexusAPI = api;
window.NexusAuth = Auth;
