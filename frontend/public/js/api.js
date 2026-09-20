'use strict';
/**
 * Nexus Bot Manager — API Client
 * All HTTP calls go through here. Protocol-relative URLs = no HTTPS forcing.
 */

const _host = window.location.host;
const _proto = window.location.protocol;
const API = `${_proto}//${_host}/api`;

// ── Token storage ─────────────────────────────────────────
const Auth = {
  getToken:    () => localStorage.getItem('nbm_token'),
  setToken:    (t) => localStorage.setItem('nbm_token', t),
  removeToken: () => { localStorage.removeItem('nbm_token'); localStorage.removeItem('nbm_user'); },
  getUser:     () => { try { return JSON.parse(localStorage.getItem('nbm_user') || 'null'); } catch { return null; } },
  setUser:     (u) => localStorage.setItem('nbm_user', JSON.stringify(u)),
};

// ── Core fetch wrapper ────────────────────────────────────
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

// ── Raw fetch (for file downloads) ───────────────────────
async function apiFetchRaw(method, endpoint, body) {
  const token = Auth.getToken();
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(API + endpoint, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

// ── API namespaces ────────────────────────────────────────
const api = {
  // Auth
  auth: {
    setupStatus:    ()                       => apiFetch('GET',  '/auth/setup-status'),
    setup:          (data)                   => apiFetch('POST', '/auth/setup', data),
    login:          (username, password)     => apiFetch('POST', '/auth/login', { username, password }),
    me:             ()                       => apiFetch('GET',  '/auth/me'),
    changePassword: (cur, nw)               => apiFetch('POST', '/auth/change-password', { currentPassword: cur, newPassword: nw }),
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
  },

  // Files
  files: {
    tree:   (bot)                  => apiFetch('GET',    `/files/${bot}/tree`),
    read:   (bot, fp)              => apiFetch('GET',    `/files/${bot}/read?path=${encodeURIComponent(fp)}`),
    write:  (bot, fp, content)     => apiFetch('PUT',    `/files/${bot}/write`, { path: fp, content }),
    create: (bot, name, type, par) => apiFetch('POST',   `/files/${bot}/create`, { name, type, parentPath: par }),
    delete: (bot, fp)              => apiFetch('DELETE', `/files/${bot}/delete?path=${encodeURIComponent(fp)}`),
    rename: (bot, old, newName)    => apiFetch('POST',   `/files/${bot}/rename`, { oldPath: old, newName }),
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
    templates:    () => apiFetch('GET',   '/system/templates'),
    template:     (id) => apiFetch('GET', `/system/templates/${id}`),
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

  health: () => apiFetch('GET', '/health'),
};

window.NexusAPI = api;
window.NexusAuth = Auth;
