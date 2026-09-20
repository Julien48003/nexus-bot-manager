'use strict';
/**
 * Nexus Bot Manager — Frontend SPA
 * Single-page application — no full reloads, async updates only.
 */

// ── Global State ───────────────────────────────────────────
const App = {
  bots: [],
  systemInfo: null,
  settings: {},
  currentPage: 'dashboard',
  currentBotName: null,
  socket: null,
  pm2StatusMap: {},          // name -> pm2 status object (live from socket)
  refreshTimers: {},
  instanceName: 'Nexus Bot Manager',
};

// ════════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════════
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtUptime(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s/60)}m`;
  if (s < 86400) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
  return `${Math.floor(s/86400)}j ${Math.floor((s%86400)/3600)}h`;
}

function fmtMem(mb) {
  if (!mb) return '0 Mo';
  return mb >= 1024 ? `${(mb/1024).toFixed(1)} Go` : `${mb} Mo`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function botInitials(name) {
  return name.split('-').map(w => (w[0] || '').toUpperCase()).join('').slice(0, 2) || '??';
}

const COLORS = [
  ['rgba(37,99,235,0.15)','#58a6ff'],   ['rgba(63,185,80,0.15)','#3fb950'],
  ['rgba(210,153,34,0.15)','#d29922'],  ['rgba(248,81,73,0.15)','#f85149'],
  ['rgba(139,92,246,0.15)','#a78bfa'],  ['rgba(236,72,153,0.15)','#f472b6'],
  ['rgba(6,182,212,0.15)','#22d3ee'],   ['rgba(249,115,22,0.15)','#fb923c'],
];

function botColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % COLORS.length;
  return COLORS[h];
}

function statusBadge(pm2) {
  if (!pm2) return '<span class="badge badge-unknown"><span class="badge-dot"></span>Inconnu</span>';
  const map = {
    online:    '<span class="badge badge-online"><span class="badge-dot"></span>En ligne</span>',
    stopped:   '<span class="badge badge-stopped"><span class="badge-dot"></span>Arrêté</span>',
    errored:   '<span class="badge badge-errored"><span class="badge-dot"></span>Erreur</span>',
    stopping:  '<span class="badge badge-stopping"><span class="badge-dot"></span>Arrêt...</span>',
    launching: '<span class="badge badge-launching"><span class="badge-dot"></span>Démarrage</span>',
  };
  return map[pm2.status] || `<span class="badge badge-unknown"><span class="badge-dot"></span>${esc(pm2.status)}</span>`;
}

function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (name === '.env' || name.endsWith('.env')) return '<i class="ti ti-lock fi-env"></i>';
  if (name === '.gitignore') return '<i class="ti ti-brand-git fi-dir"></i>';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return '<i class="ti ti-file-type-js fi-js"></i>';
  if (ext === 'ts') return '<i class="ti ti-brand-typescript fi-ts"></i>';
  if (ext === 'json') return '<i class="ti ti-file-type-json fi-json"></i>';
  if (ext === 'md') return '<i class="ti ti-markdown fi-md"></i>';
  if (ext === 'sh') return '<i class="ti ti-terminal" style="color:var(--tx-3)"></i>';
  if (ext === 'yaml' || ext === 'yml') return '<i class="ti ti-file-code" style="color:var(--amber)"></i>';
  return '<i class="ti ti-file" style="color:var(--tx-3)"></i>';
}

// ════════════════════════════════════════════════════════════
// TOAST
// ════════════════════════════════════════════════════════════
function toast(type, title, msg = '', duration = 4000) {
  const ICONS = { success:'ti-circle-check', error:'ti-alert-circle', warning:'ti-alert-triangle', info:'ti-info-circle' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="ti ${ICONS[type]||'ti-info-circle'} toast-icon"></i>
    <div><div class="toast-title">${esc(title)}</div>${msg ? `<div class="toast-msg">${esc(msg)}</div>` : ''}</div>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.style.cssText += 'opacity:0;transition:opacity 0.3s;'; setTimeout(() => el.remove(), 300); }, duration);
}

// ════════════════════════════════════════════════════════════
// CONFIRM DIALOG
// ════════════════════════════════════════════════════════════
function confirm(title, msg, onYes, danger = true) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal modal-sm">
    <div class="modal-body" style="text-align:center;padding:28px 24px 16px;">
      <div style="font-size:32px;margin-bottom:12px;">${danger ? '🗑️' : 'ℹ️'}</div>
      <div style="font-size:15px;font-weight:600;color:var(--tx-1);margin-bottom:8px;">${esc(title)}</div>
      <div style="font-size:13px;color:var(--tx-3);">${msg}</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="no">Annuler</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="yes">Confirmer</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#no').onclick  = () => ov.remove();
  ov.querySelector('#yes').onclick = () => { ov.remove(); onYes(); };
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
}

// ════════════════════════════════════════════════════════════
// ROUTER
// ════════════════════════════════════════════════════════════
function navigate(page, params = {}) {
  // Stop any per-page refresh timers
  Object.values(App.refreshTimers).forEach(clearInterval);
  App.refreshTimers = {};

  App.currentPage = page;
  Object.assign(App.currentParams || {}, params);
  App.currentParams = params;

  // Sidebar active state
  document.querySelectorAll('.sb-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));

  // Pages visibility
  document.querySelectorAll('.page, .page-editor').forEach(el => el.classList.remove('active'));

  const PAGE_LABELS = {
    dashboard:'Vue d\'ensemble', bots:'Mes Bots', 'new-bot':'Nouveau Bot',
    templates:'Templates', editor:'Éditeur Monaco', logs:'Logs & Erreurs',
    npm:'Dépendances npm', backups:'Sauvegardes', settings:'Paramètres', bot:'Détail Bot'
  };

  // Set breadcrumb
  const bc = document.getElementById('bc-current');
  if (bc) bc.textContent = PAGE_LABELS[page] || page;

  if (page === 'editor') {
    const el = document.getElementById('page-editor');
    if (el) el.classList.add('active');
    document.getElementById('content').style.overflow = 'hidden';
    if (typeof openEditorForBot === 'function' && params.botName) openEditorForBot(params.botName);
  } else {
    document.getElementById('content').style.overflow = '';
    const el = document.getElementById('page-' + page);
    if (el) { el.classList.add('active'); renderPage(page, params); }
  }
}

function renderPage(page, params = {}) {
  switch (page) {
    case 'dashboard': loadDashboard(); break;
    case 'bots':      loadBotsList();  break;
    case 'bot':       loadBotDetail(params.botName); break;
    case 'new-bot':   renderNewBot();  break;
    case 'templates': loadTemplates(); break;
    case 'logs':      loadLogs(params.botName); break;
    case 'npm':       loadNpm(params.botName);  break;
    case 'backups':   loadBackups();   break;
    case 'settings':  loadSettings();  break;
  }
}

// ════════════════════════════════════════════════════════════
// AUTH & SETUP
// ════════════════════════════════════════════════════════════
async function bootApp() {
  try {
    // 1. Check if setup is needed
    const status = await NexusAPI.auth.setupStatus();
    if (!status.done) { showSetup(); return; }

    // 2. Check existing token
    const token = NexusAuth.getToken();
    if (token) {
      try {
        const me = await NexusAPI.auth.me();
        NexusAuth.setUser(me);
        App.instanceName = me.instance_name || 'Nexus Bot Manager';
        updateInstanceName(App.instanceName);
        showApp();
        initSocket();
        navigate('dashboard');
        return;
      } catch (_) {
        NexusAuth.removeToken();
      }
    }

    showLogin();
  } catch (e) {
    // Server may be starting
    document.getElementById('boot-msg').textContent = 'Connexion au serveur...';
    setTimeout(bootApp, 2000);
  }
}

function showApp() {
  document.getElementById('boot-screen').style.display = 'none';
  document.getElementById('login-page').classList.remove('visible');
  document.getElementById('setup-page').classList.remove('visible');
  document.getElementById('app').style.display = 'flex';
}

function showLogin() {
  document.getElementById('boot-screen').style.display = 'none';
  document.getElementById('login-page').classList.add('visible');
  document.getElementById('setup-page').classList.remove('visible');
  document.getElementById('app').style.display = 'none';
  setTimeout(() => document.getElementById('login-user')?.focus(), 100);
}

function showSetup() {
  document.getElementById('boot-screen').style.display = 'none';
  document.getElementById('setup-page').classList.add('visible');
  document.getElementById('login-page').classList.remove('visible');
  document.getElementById('app').style.display = 'none';
  setupStep(1);
}

async function doLogin() {
  const username = document.getElementById('login-user')?.value?.trim();
  const password = document.getElementById('login-pass')?.value;
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('login-btn');

  errEl.style.display = 'none';
  if (!username || !password) { errEl.textContent = 'Remplissez tous les champs.'; errEl.style.display = 'block'; return; }

  btn.disabled = true;
  btn.innerHTML = '<div class="spinner spinner-sm"></div> Connexion...';

  try {
    const data = await NexusAPI.auth.login(username, password);
    NexusAuth.setToken(data.token);
    NexusAuth.setUser(data);
    App.instanceName = data.instance_name || 'Nexus Bot Manager';
    updateInstanceName(App.instanceName);

    // Update sidebar user
    const av = document.querySelector('.sb-user-av');
    const nm = document.querySelector('.sb-user-name');
    if (av) av.textContent = data.username.slice(0, 2).toUpperCase();
    if (nm) nm.textContent = data.username;

    showApp();
    initSocket();
    navigate('dashboard');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-login"></i> Se connecter';
  }
}

function doLogout() {
  NexusAuth.removeToken();
  if (App.socket) { App.socket.disconnect(); App.socket = null; }
  document.getElementById('app').style.display = 'none';
  showLogin();
}

function updateInstanceName(name) {
  const el = document.getElementById('sb-instance-name');
  if (el) el.textContent = name;
  document.title = `${name} — Nexus Bot Manager`;
}

// ── Setup wizard ──────────────────────────────────────────
let _setupData = {};
let _setupCurrentStep = 1;

function setupStep(n) {
  _setupCurrentStep = n;

  // Update step indicators
  document.querySelectorAll('.setup-step').forEach((el, i) => {
    el.classList.remove('done', 'current');
    if (i + 1 < n) el.classList.add('done');
    else if (i + 1 === n) el.classList.add('current');
  });

  const body = document.getElementById('setup-body');
  const prevBtn = document.getElementById('setup-prev');
  const nextBtn = document.getElementById('setup-next');

  if (prevBtn) prevBtn.style.display = n > 1 ? 'block' : 'none';
  if (nextBtn) nextBtn.textContent = n < 3 ? 'Suivant →' : 'Terminer la configuration';

  const steps = {
    1: `
      <div style="text-align:center;padding:8px 0 16px;">
        <div style="font-size:48px;margin-bottom:16px;">🚀</div>
        <h2 style="font-size:18px;font-weight:700;color:var(--tx-1);margin-bottom:8px;">Bienvenue sur Nexus Bot Manager</h2>
        <p style="color:var(--tx-3);font-size:13px;line-height:1.6;">La plateforme de gestion de bots Discord pour votre serveur Proxmox.<br>
        Gérez vos bots Node.js depuis une interface web professionnelle, sans jamais ouvrir un terminal.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px;text-align:left;">
          ${['🤖 Gestion complète des bots PM2','📝 Éditeur Monaco intégré','📊 Monitoring temps réel','🔒 Authentification sécurisée','💾 Sauvegardes & restauration','🎨 7 templates prêts à l\'emploi'].map(f =>
            `<div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-elevated);border-radius:var(--r);font-size:12px;color:var(--tx-2);">${f}</div>`
          ).join('')}
        </div>
      </div>`,

    2: `
      <div class="form-group">
        <label class="form-label">Nom de votre instance
          <span class="form-label-hint">Affiché dans l'interface</span>
        </label>
        <input class="form-control" id="setup-instance" placeholder="ex: Mon Bot Manager, Serveur Discord..." value="${esc(_setupData.instance_name || '')}"/>
        <div class="form-hint"><i class="ti ti-info-circle"></i>Vous pourrez le modifier plus tard dans les Paramètres.</div>
      </div>`,

    3: `
      <div class="form-group">
        <label class="form-label">Identifiant administrateur</label>
        <input class="form-control" id="setup-user" placeholder="ex: admin, julien..." value="${esc(_setupData.username || '')}" autocomplete="username"/>
      </div>
      <div class="form-group">
        <label class="form-label">Mot de passe <span class="form-label-hint">min. 6 caractères</span></label>
        <input class="form-control" id="setup-pwd" type="password" autocomplete="new-password"/>
      </div>
      <div class="form-group">
        <label class="form-label">Confirmer le mot de passe</label>
        <input class="form-control" id="setup-pwd2" type="password" autocomplete="new-password"/>
      </div>
      <div id="setup-err" style="display:none;" class="form-error"></div>`,
  };

  if (body) body.innerHTML = steps[n] || '';

  // Focus first input
  setTimeout(() => body?.querySelector('input')?.focus(), 100);
}

async function setupNext() {
  if (_setupCurrentStep === 1) {
    setupStep(2);
  } else if (_setupCurrentStep === 2) {
    _setupData.instance_name = document.getElementById('setup-instance')?.value?.trim() || 'Nexus Bot Manager';
    setupStep(3);
  } else if (_setupCurrentStep === 3) {
    const username = document.getElementById('setup-user')?.value?.trim();
    const password = document.getElementById('setup-pwd')?.value;
    const confirm2 = document.getElementById('setup-pwd2')?.value;
    const errEl    = document.getElementById('setup-err');

    if (!username || username.length < 3) { errEl.textContent = 'Identifiant trop court (min. 3 chars).'; errEl.style.display = 'block'; return; }
    if (!password || password.length < 6) { errEl.textContent = 'Mot de passe trop court (min. 6 chars).'; errEl.style.display = 'block'; return; }
    if (password !== confirm2)            { errEl.textContent = 'Les mots de passe ne correspondent pas.'; errEl.style.display = 'block'; return; }

    errEl.style.display = 'none';
    const btn = document.getElementById('setup-next');
    btn.disabled = true;
    btn.textContent = 'Configuration...';

    try {
      const data = await NexusAPI.auth.setup({
        instance_name: _setupData.instance_name,
        username, password
      });
      NexusAuth.setToken(data.token);
      NexusAuth.setUser(data);
      App.instanceName = data.instance_name;
      updateInstanceName(data.instance_name);
      const av = document.querySelector('.sb-user-av');
      const nm = document.querySelector('.sb-user-name');
      if (av) av.textContent = data.username.slice(0, 2).toUpperCase();
      if (nm) nm.textContent = data.username;
      showApp();
      initSocket();
      navigate('dashboard');
      toast('success', '🎉 Configuration terminée !', `Bienvenue, ${data.username} !`);
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Terminer la configuration';
    }
  }
}

function setupPrev() {
  if (_setupCurrentStep > 1) setupStep(_setupCurrentStep - 1);
}

// ════════════════════════════════════════════════════════════
// SOCKET.IO — Real-time status
// ════════════════════════════════════════════════════════════
function initSocket() {
  if (typeof io === 'undefined' || App.socket) return;
  try {
    App.socket = io({
      auth: { token: NexusAuth.getToken() },
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
      transports: ['websocket', 'polling']
    });

    App.socket.on('connect',       () => { console.log('[socket] Connected'); updateConnStatus(true); });
    App.socket.on('disconnect',    () => { updateConnStatus(false); });
    App.socket.on('connect_error', (e) => { console.warn('[socket] Error:', e.message); });

    // Live PM2 status — update in memory and patch UI rows
    App.socket.on('pm2:status', (list) => {
      if (!Array.isArray(list)) return;
      list.forEach(p => { App.pm2StatusMap[p.name] = p; });
      // Update live badge in bot tables without re-rendering
      list.forEach(p => patchBotStatusInUI(p));
    });

  } catch (e) {
    console.warn('[socket] Init failed:', e.message);
  }
}

function patchBotStatusInUI(pm2) {
  const els = document.querySelectorAll(`[data-bot-status="${pm2.name}"]`);
  els.forEach(el => {
    // Build a fake pm2 obj compatible with statusBadge
    el.innerHTML = statusBadge({ status: pm2.status });
  });
  // Also update cpu/memory cells
  document.querySelectorAll(`[data-bot-cpu="${pm2.name}"]`).forEach(el => {
    el.textContent = pm2.status === 'online' ? `${pm2.cpu}%` : '—';
  });
  document.querySelectorAll(`[data-bot-mem="${pm2.name}"]`).forEach(el => {
    el.textContent = pm2.status === 'online' ? fmtMem(pm2.memory) : '—';
  });
}

function updateConnStatus(connected) {
  const dot = document.getElementById('conn-dot');
  if (dot) { dot.style.background = connected ? 'var(--green)' : 'var(--red)'; dot.title = connected ? 'Connecté' : 'Déconnecté'; }
}

// ════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════
async function loadDashboard() {
  const page = document.getElementById('page-dashboard');
  page.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;

  try {
    const [bots, sysInfo, activity] = await Promise.all([
      NexusAPI.bots.list(),
      NexusAPI.system.info(),
      NexusAPI.system.activity(10),
    ]);

    App.bots = bots;
    App.systemInfo = sysInfo;

    // Merge live PM2 status
    bots.forEach(b => { if (App.pm2StatusMap[b.name]) b.pm2 = App.pm2StatusMap[b.name]; });

    const online  = bots.filter(b => b.pm2?.status === 'online').length;
    const errored = bots.filter(b => b.pm2?.status === 'errored').length;
    const stopped = bots.length - online - errored;

    document.getElementById('bots-badge').textContent = bots.length;

    page.innerHTML = `
      <!-- Stats -->
      <div class="stats-row mb-16">
        ${statCard('blue',  'ti-robot',       bots.length, 'Bots enregistrés', `${bots.length} au total`)}
        ${statCard('green', 'ti-wifi',        online,      'En ligne',         `${bots.length>0?Math.round(online/bots.length*100):0}% disponibles`)}
        ${statCard('red',   'ti-alert-circle',errored,     'En erreur',        errored > 0 ? 'Vérifiez les logs' : 'Aucun problème')}
        ${statCard('amber', 'ti-clock',       `${sysInfo.uptime.days}j`,  'Uptime serveur', `${sysInfo.uptime.hours}h ${sysInfo.uptime.minutes}m`)}
      </div>

      <!-- System metrics -->
      <div class="grid-3 mb-16">
        ${metricCard('ti-cpu',      '#58a6ff', 'CPU',    `${sysInfo.cpu.load}%`,
          sysInfo.cpu.load, 'blue', sysInfo.os.distro, sysInfo.os.hostname)}
        ${metricCard('ti-database', '#a78bfa', 'RAM',    `${sysInfo.memory.used} / ${sysInfo.memory.total} Go`,
          sysInfo.memory.pct, 'green', `${sysInfo.memory.pct}% utilisé`, `${(sysInfo.memory.total-sysInfo.memory.used).toFixed(1)} Go libres`)}
        ${metricCard('ti-server',   '#d29922', 'Disque', `${sysInfo.disk.used} / ${sysInfo.disk.total} Go`,
          sysInfo.disk.pct, 'amber', sysInfo.disk.mount, `${sysInfo.disk.pct}% utilisé`)}
      </div>

      <!-- Env versions -->
      <div class="grid-4 mb-16">
        ${envCard('#3fb950','ti-brand-nodejs','Node.js', sysInfo.versions.node)}
        ${envCard('#cb3837','ti-package',    'npm',     sysInfo.versions.npm)}
        ${envCard('#58a6ff','ti-refresh',    'PM2',     sysInfo.versions.pm2)}
        ${envCard('#5865f2','ti-brand-discord','discord.js','v14')}
      </div>

      <!-- Bots + Activity side by side -->
      <div class="grid-2" style="grid-template-columns:2fr 1fr;">
        <div>
          <div class="section-header mb-8">
            <span class="section-title"><i class="ti ti-robot"></i> Bots Discord</span>
            <div class="tabs">
              <button class="tab-btn active" onclick="filterDash('all',this)">Tous (${bots.length})</button>
              <button class="tab-btn" onclick="filterDash('online',this)">En ligne (${online})</button>
              <button class="tab-btn" onclick="filterDash('offline',this)">Hors ligne (${stopped+errored})</button>
            </div>
          </div>
          <div class="table-wrap" id="dash-bots">${renderBotsTable(bots)}</div>
        </div>
        <div>
          <div class="section-header mb-8"><span class="section-title"><i class="ti ti-activity"></i> Activité récente</span></div>
          <div class="card">${renderActivity(activity)}</div>
        </div>
      </div>`;

    // Auto-refresh stats every 15s (lightweight)
    App.refreshTimers.dashboard = setInterval(async () => {
      try {
        const info = await NexusAPI.system.info();
        App.systemInfo = info;
        // Patch only the metric values, not full re-render
        const cpuEl = document.querySelector('[data-metric="cpu"]');
        if (cpuEl) cpuEl.textContent = `${info.cpu.load}%`;
        const ramEl = document.querySelector('[data-metric="ram"]');
        if (ramEl) ramEl.textContent = `${info.memory.used} / ${info.memory.total} Go`;
      } catch (_) {}
    }, 15000);

  } catch (e) {
    page.innerHTML = `<div class="loader" style="color:var(--red);"><i class="ti ti-alert-circle" style="font-size:28px;"></i><span>${esc(e.message)}</span></div>`;
  }
}

function statCard(color, icon, value, label, delta) {
  return `<div class="stat-card ${color}">
    <div class="stat-icon"><i class="ti ${icon}"></i></div>
    <div class="stat-value">${esc(String(value))}</div>
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-delta" style="color:var(--tx-3)">${esc(delta)}</div>
  </div>`;
}

function metricCard(icon, color, title, value, pct, fillClass, row1, row2) {
  const safeVal = esc(String(value ?? ''));
  const safePct = Math.min(100, Math.max(0, Number(pct) || 0));
  return `<div class="card">
    <div class="card-header">
      <span class="card-title"><i class="ti ${icon}" style="color:${color}"></i>${esc(title)}</span>
      <span style="font-size:14px;font-weight:700;color:${color}" data-metric="${title.toLowerCase()}">${safeVal}</span>
    </div>
    <div class="card-body">
      <div class="progress mb-8"><div class="progress-fill ${fillClass}" style="width:${safePct}%"></div></div>
      <div class="metric-row"><span class="metric-key">${esc(row1?.split(':')[0] || '')}
        </span><span class="metric-val">${esc(row1?.split(':').slice(1).join(':').trim() || row1 || '')}</span></div>
      <div class="metric-row"><span class="metric-key">${esc(row2?.split(':')[0] || '')}
        </span><span class="metric-val">${esc(row2?.split(':').slice(1).join(':').trim() || row2 || '')}</span></div>
    </div>
  </div>`;
}

function envCard(color, icon, label, value) {
  return `<div class="card" style="padding:12px 14px;">
    <div style="display:flex;align-items:center;gap:10px;">
      <span style="font-size:20px;color:${color};"><i class="ti ${icon}"></i></span>
      <div>
        <div style="font-size:10px;color:var(--tx-3);text-transform:uppercase;letter-spacing:0.3px;">${esc(label)}</div>
        <div style="font-size:13px;font-weight:600;font-family:var(--font-mono);">${esc(value)}</div>
      </div>
    </div>
  </div>`;
}

function renderActivity(activity) {
  if (!activity || activity.length === 0) {
    return '<div class="empty-state" style="padding:20px;"><i class="ti ti-history"></i><span style="color:var(--tx-3);font-size:12px;">Aucune activité</span></div>';
  }
  const icons = { bot_started:'ti-player-play', bot_stopped:'ti-player-pause', bot_restarted:'ti-refresh', bot_created:'ti-plus', bot_deleted:'ti-trash', bot_exported:'ti-archive', bot_imported:'ti-upload', login:'ti-login', setup_complete:'ti-check', password_changed:'ti-key' };
  return `<div style="padding:4px 0;">${activity.map(a => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border);">
      <i class="ti ${icons[a.action]||'ti-activity'}" style="color:var(--tx-3);font-size:14px;flex-shrink:0;"></i>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;color:var(--tx-2);font-weight:500;">${esc(a.bot_name || a.details || a.action)}</div>
        <div style="font-size:10px;color:var(--tx-3);">${fmtDate(a.created_at)}</div>
      </div>
    </div>`).join('')}</div>`;
}

function filterDash(filter, btn) {
  btn.closest('.tabs').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const list = filter === 'online'  ? App.bots.filter(b => b.pm2?.status === 'online')
             : filter === 'offline' ? App.bots.filter(b => !b.pm2 || b.pm2.status !== 'online')
             : App.bots;
  const el = document.getElementById('dash-bots');
  if (el) el.innerHTML = renderBotsTable(list);
}

// ════════════════════════════════════════════════════════════
// BOTS TABLE (reusable)
// ════════════════════════════════════════════════════════════
function renderBotsTable(bots) {
  if (!bots || bots.length === 0) {
    return `<div class="empty-state">
      <i class="ti ti-robot"></i>
      <div class="empty-state-title">Aucun bot</div>
      <div class="empty-state-desc">Créez votre premier bot pour commencer.</div>
      <button class="btn btn-primary btn-sm mt-8" onclick="navigate('new-bot')"><i class="ti ti-plus"></i>Nouveau Bot</button>
    </div>`;
  }

  const rows = bots.map(bot => {
    const [bg, color] = botColor(bot.name);
    const pm2 = App.pm2StatusMap[bot.name] || bot.pm2;
    const isOnline = pm2?.status === 'online';
    return `<tr onclick="navigate('bot',{botName:'${esc(bot.name)}'})">
      <td style="width:32px;padding:10px 8px 10px 14px;">
        <div class="bot-av" style="background:${bg};color:${color};">${botInitials(bot.name)}</div>
      </td>
      <td>
        <div style="font-weight:600;color:var(--tx-1);">${esc(bot.name)}</div>
        <div style="font-size:10px;color:var(--tx-3);font-family:var(--font-mono);">/opt/${esc(bot.name)}</div>
      </td>
      <td><div data-bot-status="${esc(bot.name)}">${statusBadge(pm2)}</div></td>
      <td class="td-mono" data-bot-cpu="${esc(bot.name)}">${isOnline ? (pm2.cpu + '%') : '—'}</td>
      <td class="td-mono" data-bot-mem="${esc(bot.name)}">${isOnline ? fmtMem(pm2.memory) : '—'}</td>
      <td class="td-mono">${fmtUptime(pm2?.uptime)}</td>
      <td onclick="event.stopPropagation()">
        <div class="act-group">
          ${isOnline
            ? `<button class="act-btn act-stop" title="Arrêter"     onclick="botAction('stop','${esc(bot.name)}',this)"><i class="ti ti-player-pause"></i></button>
               <button class="act-btn"          title="Redémarrer"  onclick="botAction('restart','${esc(bot.name)}',this)"><i class="ti ti-refresh"></i></button>`
            : `<button class="act-btn act-start" title="Démarrer"   onclick="botAction('start','${esc(bot.name)}',this)"><i class="ti ti-player-play"></i></button>`
          }
          <button class="act-btn act-edit"   title="Logs"     onclick="navigate('logs',{botName:'${esc(bot.name)}'})"><i class="ti ti-terminal"></i></button>
          <button class="act-btn act-edit"   title="Éditer"   onclick="navigate('editor',{botName:'${esc(bot.name)}'})"><i class="ti ti-code"></i></button>
          <button class="act-btn act-danger" title="Supprimer" onclick="confirmDelete('${esc(bot.name)}')"><i class="ti ti-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<table class="data-tbl">
    <thead><tr><th></th><th>Bot</th><th>Statut</th><th>CPU</th><th>RAM</th><th>Uptime</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ════════════════════════════════════════════════════════════
// BOT ACTIONS — No page reload, patch UI only
// ════════════════════════════════════════════════════════════
async function botAction(action, botName, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner spinner-sm"></div>'; }

  const labels = { start: 'démarré', stop: 'arrêté', restart: 'redémarré' };

  try {
    const fn = { start: () => NexusAPI.bots.start(botName), stop: () => NexusAPI.bots.stop(botName), restart: () => NexusAPI.bots.restart(botName) }[action];
    if (!fn) throw new Error('Action inconnue');
    await fn();
    toast('success', `Bot ${labels[action]}`, botName);

    // Update bot in memory after short delay (PM2 needs time to change status)
    setTimeout(async () => {
      try {
        const pm2 = await NexusAPI.bots.pm2Status(botName);
        if (pm2) {
          App.pm2StatusMap[botName] = pm2;
          patchBotStatusInUI(pm2);
        }
      } catch (_) {}
    }, 1500);

    // Refresh page if on bot detail
    if (App.currentPage === 'bot' && App.currentParams?.botName === botName) {
      setTimeout(() => loadBotDetail(botName), 1500);
    }
  } catch (e) {
    toast('error', 'Erreur', e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = { start:'<i class="ti ti-player-play"></i>', stop:'<i class="ti ti-player-pause"></i>', restart:'<i class="ti ti-refresh"></i>' }[action] || ''; }
  }
}

function confirmDelete(botName) {
  confirm('Supprimer le bot',
    `Cette action supprimera définitivement <strong>${esc(botName)}</strong> et tous ses fichiers dans <code>/opt/${esc(botName)}</code>. Cette action est irréversible.`,
    async () => {
      try {
        await NexusAPI.bots.delete(botName);
        App.bots = App.bots.filter(b => b.name !== botName);
        delete App.pm2StatusMap[botName];
        toast('success', 'Bot supprimé', botName);
        if (App.currentPage === 'bot') navigate('bots');
        else if (App.currentPage === 'dashboard') loadDashboard();
        else if (App.currentPage === 'bots') loadBotsList();
      } catch (e) {
        toast('error', 'Erreur suppression', e.message);
      }
    }
  );
}

// ════════════════════════════════════════════════════════════
// BOTS LIST
// ════════════════════════════════════════════════════════════
async function loadBotsList() {
  const page = document.getElementById('page-bots');
  page.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  try {
    const bots = await NexusAPI.bots.list();
    App.bots   = bots;
    document.getElementById('bots-badge').textContent = bots.length;

    page.innerHTML = `
      <div class="flex-between mb-16">
        <div><div class="section-title mb-4"><i class="ti ti-robot"></i> Gestion des Bots</div>
          <div style="font-size:12px;color:var(--tx-3);">${bots.length} bot${bots.length > 1 ? 's' : ''} enregistré${bots.length > 1 ? 's' : ''}</div>
        </div>
        <div class="flex gap-8">
          <input id="bot-search" class="form-control" style="width:200px;" placeholder="Rechercher..." oninput="filterBotsList(this.value)"/>
          <button class="btn btn-primary" onclick="navigate('new-bot')"><i class="ti ti-plus"></i>Nouveau Bot</button>
        </div>
      </div>
      <div class="table-wrap">
        <div class="table-toolbar">
          <span class="table-title"><i class="ti ti-robot"></i> Tous les bots</span>
          <div class="tabs">
            <button class="tab-btn active" onclick="filterBotsTab('all',this)">Tous</button>
            <button class="tab-btn" onclick="filterBotsTab('online',this)">En ligne</button>
            <button class="tab-btn" onclick="filterBotsTab('errored',this)">Erreurs</button>
          </div>
        </div>
        <div id="bots-table">${renderBotsTable(bots)}</div>
      </div>`;

    App.refreshTimers.bots = setInterval(async () => {
      const updated = await NexusAPI.bots.list().catch(() => null);
      if (updated) { App.bots = updated; }
    }, 10000);
  } catch (e) {
    page.innerHTML = `<div class="loader" style="color:var(--red);">${esc(e.message)}</div>`;
  }
}

function filterBotsList(query) {
  const q = query.toLowerCase();
  const list = q ? App.bots.filter(b => b.name.includes(q) || (b.description || '').toLowerCase().includes(q)) : App.bots;
  const el = document.getElementById('bots-table');
  if (el) el.innerHTML = renderBotsTable(list);
}

function filterBotsTab(filter, btn) {
  btn.closest('.tabs').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const list = filter === 'online'  ? App.bots.filter(b => (App.pm2StatusMap[b.name] || b.pm2)?.status === 'online')
             : filter === 'errored' ? App.bots.filter(b => (App.pm2StatusMap[b.name] || b.pm2)?.status === 'errored')
             : App.bots;
  const el = document.getElementById('bots-table');
  if (el) el.innerHTML = renderBotsTable(list);
}

// ════════════════════════════════════════════════════════════
// BOT DETAIL
// ════════════════════════════════════════════════════════════
async function loadBotDetail(botName) {
  const page = document.getElementById('page-bot');
  page.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  App.currentBotName = botName;

  try {
    const bot = await NexusAPI.bots.get(botName);
    const [bg, color] = botColor(botName);
    const pm2 = App.pm2StatusMap[botName] || bot.pm2;
    const isOnline = pm2?.status === 'online';

    page.innerHTML = `
      <!-- Hero -->
      <div class="card mb-16" style="padding:16px;">
        <div style="display:flex;align-items:center;gap:14px;">
          <div class="bot-av" style="background:${bg};color:${color};width:48px;height:48px;border-radius:10px;font-size:18px;">${botInitials(botName)}</div>
          <div style="flex:1;">
            <div style="font-size:18px;font-weight:700;color:var(--tx-1);">${esc(botName)}</div>
            <div style="font-size:11px;color:var(--tx-3);font-family:var(--font-mono);">/opt/${esc(botName)}</div>
          </div>
          <div class="flex gap-6">
            ${isOnline
              ? `<button class="btn btn-ghost btn-sm" onclick="botAction('restart','${esc(botName)}',this)"><i class="ti ti-refresh"></i>Redémarrer</button>
                 <button class="btn btn-danger btn-sm" onclick="botAction('stop','${esc(botName)}',this)"><i class="ti ti-player-pause"></i>Arrêter</button>`
              : `<button class="btn btn-success btn-sm" onclick="botAction('start','${esc(botName)}',this)"><i class="ti ti-player-play"></i>Démarrer</button>`
            }
            <button class="btn btn-ghost btn-sm" onclick="navigate('editor',{botName:'${esc(botName)}'})"><i class="ti ti-code"></i>Éditeur</button>
            <button class="btn btn-ghost btn-sm" onclick="exportBot('${esc(botName)}')"><i class="ti ti-archive"></i>Exporter</button>
            <button class="btn btn-danger btn-sm btn-icon" onclick="confirmDelete('${esc(botName)}')" title="Supprimer"><i class="ti ti-trash"></i></button>
          </div>
        </div>
      </div>

      <div class="grid-3 mb-16">
        <!-- PM2 Status -->
        <div class="card">
          <div class="card-header"><span class="card-title"><i class="ti ti-activity"></i>Statut PM2</span><div data-bot-status="${esc(botName)}">${statusBadge(pm2)}</div></div>
          <div class="card-body">
            <div class="metric-row"><span class="metric-key">PID</span><span class="metric-val">${pm2?.pid || '—'}</span></div>
            <div class="metric-row"><span class="metric-key">Redémarrages</span><span class="metric-val">${pm2?.restarts ?? '—'}</span></div>
            <div class="metric-row"><span class="metric-key">Uptime</span><span class="metric-val">${fmtUptime(pm2?.uptime)}</span></div>
            <div class="metric-row"><span class="metric-key">Démarré le</span><span class="metric-val">${fmtDate(bot.last_started)}</span></div>
          </div>
        </div>

        <!-- Resources -->
        <div class="card">
          <div class="card-header"><span class="card-title"><i class="ti ti-cpu"></i>Ressources</span></div>
          <div class="card-body">
            <div class="metric-row"><span class="metric-key">CPU</span><span class="metric-val" data-bot-cpu="${esc(botName)}">${isOnline ? pm2.cpu + '%' : '—'}</span></div>
            <div class="metric-row"><span class="metric-key">RAM</span><span class="metric-val" data-bot-mem="${esc(botName)}">${isOnline ? fmtMem(pm2.memory) : '—'}</span></div>
            <div class="metric-row"><span class="metric-key">Template</span><span class="metric-val">${esc(bot.template || 'blank')}</span></div>
            <div class="metric-row"><span class="metric-key">Créé le</span><span class="metric-val">${fmtDate(bot.created_at)}</span></div>
          </div>
        </div>

        <!-- Dependencies -->
        <div class="card">
          <div class="card-header"><span class="card-title"><i class="ti ti-package"></i>Dépendances</span>
            <button class="btn btn-ghost btn-xs" onclick="navigate('npm',{botName:'${esc(botName)}'})">Gérer</button>
          </div>
          <div class="card-body">
            ${bot.packageJson?.dependencies
              ? Object.entries(bot.packageJson.dependencies).slice(0,6).map(([k,v]) =>
                  `<div class="metric-row"><span class="metric-key">${esc(k)}</span><span class="metric-val">${esc(v)}</span></div>`
                ).join('') + (Object.keys(bot.packageJson.dependencies).length > 6 ? `<div style="font-size:11px;color:var(--tx-3);margin-top:6px;">+${Object.keys(bot.packageJson.dependencies).length - 6} autres</div>` : '')
              : '<div style="color:var(--tx-3);font-size:12px;">Aucune dépendance</div>'
            }
          </div>
        </div>
      </div>

      <!-- Logs -->
      <div class="card">
        <div class="card-header">
          <span class="card-title"><i class="ti ti-terminal"></i>Logs — ${esc(botName)}</span>
          <div class="flex gap-6">
            <div class="tabs">
              <button class="tab-btn active" onclick="switchTab('stdout','stderr',this)">stdout</button>
              <button class="tab-btn" onclick="switchTab('stderr','stdout',this)">stderr</button>
            </div>
            <button class="btn btn-ghost btn-xs" onclick="loadBotLogs('${esc(botName)}')"><i class="ti ti-refresh"></i></button>
          </div>
        </div>
        <div id="stdout" style="background:var(--bg-base);border-radius:0 0 10px 10px;min-height:200px;max-height:300px;overflow-y:auto;padding:4px 0;">
          <div class="loader" style="background:transparent;padding:20px;"><div class="spinner"></div></div>
        </div>
        <div id="stderr" style="background:var(--bg-base);border-radius:0 0 10px 10px;min-height:200px;max-height:300px;overflow-y:auto;padding:4px 0;display:none;"></div>
      </div>`;

    loadBotLogs(botName);

    // Live PM2 poll for this detail page
    App.refreshTimers.botDetail = setInterval(async () => {
      try {
        const p = await NexusAPI.bots.pm2Status(botName);
        if (p) { App.pm2StatusMap[botName] = p; patchBotStatusInUI(p); }
      } catch (_) {}
    }, 5000);

  } catch (e) {
    page.innerHTML = `<div class="loader" style="color:var(--red);">${esc(e.message)}</div>`;
  }
}

async function loadBotLogs(botName) {
  try {
    const logs = await NexusAPI.bots.logs(botName, 100);
    const outEl = document.getElementById('stdout');
    const errEl = document.getElementById('stderr');
    if (outEl) {
      outEl.innerHTML = logs.out.length
        ? logs.out.map(l => logLine(l)).join('')
        : '<div class="log-line"><span class="log-out" style="color:var(--tx-3);font-style:italic;padding:0 14px;">Aucun log stdout</span></div>';
      outEl.scrollTop = outEl.scrollHeight;
    }
    if (errEl) {
      errEl.innerHTML = logs.err.length
        ? logs.err.map(l => `<div class="log-line"><span class="log-err">${esc(l)}</span></div>`).join('')
        : '<div class="log-line"><span class="log-out" style="color:var(--tx-3);font-style:italic;padding:0 14px;">Aucune erreur stderr</span></div>';
    }
  } catch (e) {
    const outEl = document.getElementById('stdout');
    if (outEl) outEl.innerHTML = `<div class="log-line"><span class="log-err">${esc(e.message)}</span></div>`;
  }
}

function switchTab(showId, hideId, btn) {
  btn.closest('.tabs').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const s = document.getElementById(showId); if (s) s.style.display = '';
  const h = document.getElementById(hideId); if (h) h.style.display = 'none';
}

function logLine(l) {
  let cls = 'log-out';
  if (/error|err|fatal/i.test(l)) cls = 'log-err';
  else if (/warn/i.test(l))       cls = 'log-warn';
  else if (/✅|connecté|ready/i.test(l)) cls = 'log-ok';
  return `<div class="log-line"><span class="${cls}">${esc(l)}</span></div>`;
}

// ════════════════════════════════════════════════════════════
// NEW BOT — 3-step wizard
// ════════════════════════════════════════════════════════════
const PROMPT_TEMPLATE = `Tu es un expert Node.js et Discord.js. Je travaille sur un bot Discord géré par Nexus Bot Manager (PM2 + Node.js 20).

STRUCTURE DU PROJET :
/opt/[NOM-BOT]/
├── index.js          ← point d'entrée (require('dotenv').config() EN PREMIER)
├── .env              ← TOKEN=... et variables d'environnement
├── package.json      ← dépendances npm
├── commands/         ← commandes slash (optionnel)
└── events/           ← événements Discord (optionnel)

CONTRAINTES OBLIGATOIRES :
- Node.js v20, discord.js v14, dotenv
- require('dotenv').config() TOUJOURS en tout premier
- process.on('unhandledRejection', err => console.error('[ERREUR]', err));
- Logs : console.log(\`[\${new Date().toISOString()}] ...\`)
- JAMAIS hardcoder le TOKEN — toujours process.env.TOKEN

FORMAT DE RÉPONSE :
=== FICHIER : index.js ===
[contenu complet]
=== FIN DU FICHIER ===

MA DEMANDE :
[Décris ici ce que tu veux que le bot fasse]`;

let _newBot = { step: 1, templateId: 'discordjs-blank', packages: {}, envVars: {} };

async function renderNewBot() {
  const page = document.getElementById('page-new-bot');
  _newBot = { step: 1, templateId: 'discordjs-blank', packages: {}, envVars: {} };

  // Fetch templates
  let templates = [];
  try { const data = await NexusAPI.system.templates(); templates = data.templates || []; } catch (_) {}

  page.innerHTML = `
    <div style="max-width:700px;margin:0 auto;">
      <div class="flex-between mb-16">
        <div>
          <div class="section-title mb-4"><i class="ti ti-plus"></i> Nouveau Bot Discord</div>
          <div style="font-size:12px;color:var(--tx-3);">Configurez et déployez en quelques étapes</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="btn-prompt" onclick="togglePrompt()">
          <i class="ti ti-bulb"></i>Prompt IA
        </button>
      </div>

      <!-- Prompt box -->
      <div id="prompt-block" style="display:none;" class="mb-16">
        <div class="prompt-box">
          <div class="prompt-header">
            <span class="prompt-title"><i class="ti ti-robot"></i> Modèle de prompt — Coder vos bots avec l'IA</span>
            <button class="btn-copy" onclick="copyPrompt()"><i class="ti ti-copy"></i>Copier</button>
          </div>
          <div class="prompt-body">${esc(PROMPT_TEMPLATE)}</div>
        </div>
      </div>

      <!-- Step indicator -->
      <div class="flex-center gap-8 mb-16">
        ${[{n:1,l:'Template'},{n:2,l:'Configuration'},{n:3,l:'Variables'}].map(s => `
          <div class="flex-center gap-6">
            <div id="step-dot-${s.n}" style="width:28px;height:28px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--tx-3);transition:all 0.2s;">${s.n}</div>
            <span style="font-size:12px;color:var(--tx-3);">${s.l}</span>
            ${s.n < 3 ? '<i class="ti ti-chevron-right" style="color:var(--tx-3);font-size:12px;"></i>' : ''}
          </div>`).join('')}
      </div>

      <div class="card">
        <div id="nb-body" class="card-body"></div>
        <div class="card-footer">
          <button class="btn btn-ghost" id="nb-prev" style="display:none;" onclick="nbPrev()">← Retour</button>
          <div style="flex:1;"></div>
          <button class="btn btn-ghost" onclick="navigate('bots')">Annuler</button>
          <button class="btn btn-primary" id="nb-next" onclick="nbNext()">Suivant →</button>
        </div>
      </div>
    </div>`;

  _newBot.templates = templates;
  nbStep(1);
}

function nbStep(n) {
  _newBot.step = n;

  // Update step dots
  for (let i = 1; i <= 3; i++) {
    const dot = document.getElementById(`step-dot-${i}`);
    if (!dot) continue;
    dot.style.background = i < n ? 'var(--green)' : i === n ? 'var(--brand)' : 'transparent';
    dot.style.borderColor = i < n ? 'var(--green)' : i === n ? 'var(--brand)' : 'var(--border)';
    dot.style.color       = i <= n ? '#fff' : 'var(--tx-3)';
    dot.innerHTML         = i < n ? '<i class="ti ti-check" style="font-size:12px;"></i>' : String(i);
  }

  const prev = document.getElementById('nb-prev');
  const next = document.getElementById('nb-next');
  if (prev) prev.style.display = n > 1 ? 'block' : 'none';
  if (next) next.textContent   = n < 3 ? 'Suivant →' : '🚀 Créer le bot';

  const body = document.getElementById('nb-body');
  if (!body) return;

  if (n === 1) {
    // Template selection
    const tpls = _newBot.templates || [];
    const cats = [...new Set(tpls.map(t => t.category))];
    body.innerHTML = `
      <div class="mb-12" style="font-size:13px;font-weight:600;color:var(--tx-2);">Choisissez un template de démarrage</div>
      <div class="template-grid" id="tpl-grid">
        ${tpls.map(t => `
          <div class="tpl-card ${t.id === _newBot.templateId ? 'selected' : ''}" onclick="selectTpl('${esc(t.id)}')" id="tpl-${esc(t.id)}">
            <i class="ti ${t.icon} tpl-icon"></i>
            <div class="tpl-name">${esc(t.name)}</div>
            <div class="tpl-desc">${esc(t.description)}</div>
            <div class="tpl-badge">${esc(t.difficulty)}</div>
          </div>`).join('')}
      </div>`;
  } else if (n === 2) {
    // Bot config
    const PKGS = [{id:'axios',icon:'ti-world',label:'axios'},{id:'sqlite3',icon:'ti-database',label:'sqlite3'},{id:'mysql2',icon:'ti-database',label:'mysql2'},{id:'ms',icon:'ti-clock',label:'ms'},{id:'node-cron',icon:'ti-calendar',label:'node-cron'},{id:'canvas',icon:'ti-photo',label:'canvas'},{id:'node-fetch',icon:'ti-cloud',label:'node-fetch'},{id:'jimp',icon:'ti-photo-edit',label:'jimp'}];
    body.innerHTML = `
      <div class="form-group">
        <label class="form-label">Nom du bot <span class="form-label-hint">slug lowercase (ex: mon-bot)</span></label>
        <input class="form-control" id="bot-name" placeholder="ex: nythera-ticket" value="${esc(_newBot.name || '')}" oninput="previewBotName(this.value)" autocomplete="off"/>
        <div id="name-preview" class="form-hint" style="font-family:var(--font-mono);"></div>
      </div>
      <div class="form-group">
        <label class="form-label">Token Discord <span class="form-label-hint"><i class="ti ti-lock"></i>Stocké uniquement dans .env</span></label>
        <input class="form-control mono" id="bot-token" type="password" placeholder="MTI..." value="${esc(_newBot.token || '')}"/>
        <div class="form-hint"><i class="ti ti-shield-check"></i>Le token n'est jamais stocké en base de données.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Description <span class="form-label-hint">optionnel</span></label>
        <input class="form-control" id="bot-desc" placeholder="Description du bot..." value="${esc(_newBot.description || '')}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Packages supplémentaires <span class="form-label-hint">optionnel</span></label>
        <div class="pkg-grid">
          ${PKGS.map(p => `<div class="pkg-item ${_newBot.packages[p.id] ? 'selected' : ''}" onclick="togglePkg('${p.id}')" id="pkg-${p.id}"><i class="ti ${p.icon}"></i>${p.label}</div>`).join('')}
        </div>
      </div>`;
  } else if (n === 3) {
    // ENV vars from template
    const tpl = _newBot.templates?.find(t => t.id === _newBot.templateId);
    const envVars = tpl?.envVars || [];

    body.innerHTML = `
      <div class="mb-8" style="font-size:13px;font-weight:600;color:var(--tx-2);">Variables d'environnement — ${esc(tpl?.name || 'Template')}</div>
      <div class="mb-12 form-hint"><i class="ti ti-info-circle"></i>Ces valeurs seront écrites dans le fichier <code>.env</code> du bot.</div>
      ${envVars.filter(v => v.key !== 'TOKEN').length === 0
        ? '<div class="empty-state" style="padding:16px;"><i class="ti ti-circle-check" style="color:var(--green)"></i><div class="empty-state-title" style="font-size:13px;">Aucune variable supplémentaire</div><div class="empty-state-desc">Ce template n\'utilise que le TOKEN Discord.</div></div>'
        : envVars.filter(v => v.key !== 'TOKEN').map(v => `
          <div class="form-group">
            <label class="form-label">
              ${esc(v.label)} ${v.required ? '<span style="color:var(--red)">*</span>' : '<span class="form-label-hint">optionnel</span>'}
              <span style="font-family:var(--font-mono);font-size:10px;color:var(--tx-3);">${esc(v.key)}</span>
            </label>
            <input class="form-control ${v.secret ? 'mono' : ''}" id="env-${esc(v.key)}" type="${v.secret ? 'password' : 'text'}" placeholder="${esc(v.hint || v.label)}" value="${esc(_newBot.envVars?.[v.key] || '')}"/>
          </div>`).join('')
      }
      <div id="nb-err" class="form-error mt-8"></div>`;
  }
}

function selectTpl(id) {
  _newBot.templateId = id;
  document.querySelectorAll('.tpl-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('tpl-' + id)?.classList.add('selected');
}

function togglePkg(id) {
  _newBot.packages[id] = !_newBot.packages[id];
  document.getElementById('pkg-' + id)?.classList.toggle('selected', !!_newBot.packages[id]);
}

function previewBotName(v) {
  const clean = v.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const el = document.getElementById('name-preview');
  if (el) el.innerHTML = clean ? `<i class="ti ti-folder"></i> /opt/${clean}` : '';
}

function togglePrompt() {
  const bl = document.getElementById('prompt-block');
  const btn = document.getElementById('btn-prompt');
  const vis = bl.style.display === 'none';
  bl.style.display = vis ? 'block' : 'none';
  if (btn) btn.innerHTML = vis ? '<i class="ti ti-eye-off"></i>Masquer' : '<i class="ti ti-bulb"></i>Prompt IA';
}

function copyPrompt() {
  navigator.clipboard.writeText(PROMPT_TEMPLATE).then(() => {
    const btn = document.querySelector('.btn-copy');
    if (btn) { btn.innerHTML = '<i class="ti ti-check"></i>Copié !'; setTimeout(() => btn.innerHTML = '<i class="ti ti-copy"></i>Copier', 2000); }
    toast('success', 'Prompt copié !', 'Collez-le dans votre IA et décrivez votre bot à la fin.');
  });
}

function nbPrev() { if (_newBot.step > 1) nbStep(_newBot.step - 1); }

async function nbNext() {
  const step = _newBot.step;

  if (step === 1) {
    if (!_newBot.templateId) { toast('warning', 'Choisissez un template'); return; }
    nbStep(2);
  } else if (step === 2) {
    const name  = document.getElementById('bot-name')?.value?.trim();
    const token = document.getElementById('bot-token')?.value?.trim();
    if (!name || !/^[a-z0-9-]{2,64}$/.test(name)) { toast('error', 'Nom invalide', 'Minuscules, chiffres et tirets (2-64 chars)'); return; }
    if (!token || token.length < 20) { toast('error', 'Token invalide', 'Entrez votre token Discord (disponible sur discord.com/developers)'); return; }
    _newBot.name = name;
    _newBot.token = token;
    _newBot.description = document.getElementById('bot-desc')?.value?.trim() || '';
    nbStep(3);
  } else if (step === 3) {
    // Collect env vars
    const tpl = _newBot.templates?.find(t => t.id === _newBot.templateId);
    const envVars = tpl?.envVars?.filter(v => v.key !== 'TOKEN') || [];
    for (const v of envVars) {
      const el = document.getElementById('env-' + v.key);
      const val = el?.value?.trim() || '';
      if (v.required && !val) {
        const errEl = document.getElementById('nb-err');
        if (errEl) { errEl.textContent = `Le champ "${v.label}" est obligatoire.`; errEl.style.display = 'block'; }
        return;
      }
      _newBot.envVars[v.key] = val;
    }

    const btn = document.getElementById('nb-next');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner spinner-sm"></div> Création et installation npm...';

    try {
      const result = await NexusAPI.bots.create({
        name:          _newBot.name,
        token:         _newBot.token,
        templateId:    _newBot.templateId,
        description:   _newBot.description,
        extraPackages: Object.keys(_newBot.packages).filter(k => _newBot.packages[k]),
        envVars:       _newBot.envVars,
      });
      toast('success', '🤖 Bot créé !', `${_newBot.name} — discord.js installé avec succès.`);
      navigate('bots');
    } catch (e) {
      toast('error', 'Erreur création', e.message);
      btn.disabled = false;
      btn.innerHTML = '🚀 Créer le bot';
    }
  }
}

// ════════════════════════════════════════════════════════════
// TEMPLATES PAGE
// ════════════════════════════════════════════════════════════
async function loadTemplates() {
  const page = document.getElementById('page-templates');
  page.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  try {
    const { templates, categories } = await NexusAPI.system.templates();

    page.innerHTML = `
      <div class="flex-between mb-16">
        <div>
          <div class="section-title mb-4"><i class="ti ti-layout-grid"></i> Bibliothèque de Templates</div>
          <div style="font-size:12px;color:var(--tx-3);">${templates.length} templates disponibles</div>
        </div>
        <div class="flex gap-8">
          <input id="tpl-search" class="form-control" style="width:200px;" placeholder="Rechercher..." oninput="filterTemplates(this.value)"/>
          <button class="btn btn-primary" onclick="navigate('new-bot')"><i class="ti ti-plus"></i>Créer un bot</button>
        </div>
      </div>

      <div class="flex gap-8 mb-16" id="tpl-cats">
        <button class="tab-btn active" onclick="filterTplCat('',this)">Tous (${templates.length})</button>
        ${categories.map(c => `<button class="tab-btn" onclick="filterTplCat('${esc(c.id)}',this)">${esc(c.label)} (${c.count})</button>`).join('')}
      </div>

      <div class="tpl-lib-grid" id="tpl-lib-grid">
        ${renderTplCards(templates)}
      </div>`;

    page._templates = templates;
  } catch (e) {
    page.innerHTML = `<div class="loader" style="color:var(--red);">${esc(e.message)}</div>`;
  }
}

function renderTplCards(templates) {
  return templates.map(t => `
    <div class="tpl-lib-card" onclick="useTpl('${esc(t.id)}')">
      <div class="lib-icon"><i class="ti ${t.icon}" style="color:var(--blue)"></i></div>
      <div class="lib-name">${esc(t.name)}</div>
      <div class="lib-desc">${esc(t.description)}</div>
      <div class="lib-meta">
        <span class="tpl-lib-meta-tag">${esc(t.runtime)}</span>
        <span class="tpl-lib-meta-tag">${esc(t.difficulty)}</span>
        <span class="tpl-lib-meta-tag">${t.packages.length} deps</span>
      </div>
    </div>`).join('');
}

function filterTemplates(q) {
  const page = document.getElementById('page-templates');
  const all = page._templates || [];
  const filtered = q ? all.filter(t => t.name.toLowerCase().includes(q.toLowerCase()) || t.description.toLowerCase().includes(q.toLowerCase())) : all;
  const el = document.getElementById('tpl-lib-grid');
  if (el) el.innerHTML = renderTplCards(filtered);
}

function filterTplCat(cat, btn) {
  btn.closest('#tpl-cats').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const page = document.getElementById('page-templates');
  const all = page._templates || [];
  const filtered = cat ? all.filter(t => t.category === cat) : all;
  const el = document.getElementById('tpl-lib-grid');
  if (el) el.innerHTML = renderTplCards(filtered);
}

function useTpl(id) {
  _newBot.templateId = id;
  navigate('new-bot');
  // Pre-select after render
  setTimeout(() => selectTpl(id), 100);
}

// ════════════════════════════════════════════════════════════
// LOGS PAGE
// ════════════════════════════════════════════════════════════
async function loadLogs(botName) {
  const page = document.getElementById('page-logs');
  try {
    const bots = App.bots.length ? App.bots : await NexusAPI.bots.list();
    App.bots = bots;
    const first = botName || bots[0]?.name;
    const errorBots = bots.filter(b => (App.pm2StatusMap[b.name] || b.pm2)?.status === 'errored');

    page.innerHTML = `
      <div class="flex-between mb-16">
        <span class="section-title"><i class="ti ti-terminal"></i>Logs & Erreurs</span>
        <div class="flex gap-8">
          <select class="form-control" id="log-sel" style="width:200px;" onchange="switchLogBot(this.value)">
            ${bots.map(b => `<option value="${esc(b.name)}"${b.name===first?' selected':''}>${esc(b.name)}</option>`).join('')}
          </select>
          <button class="btn btn-ghost btn-sm" onclick="clearLogs()"><i class="ti ti-trash"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="exportLogs()"><i class="ti ti-download"></i></button>
        </div>
      </div>

      ${errorBots.length ? `
        <div class="mb-16">
          ${errorBots.map(b => `
            <div class="err-panel">
              <div class="err-panel-title"><i class="ti ti-alert-circle"></i>PM2 Error — ${esc(b.name)}</div>
              <div class="err-line">Le bot a planté. Vérifiez le token dans .env ou les erreurs ci-dessous.</div>
              <div class="flex gap-6 mt-8">
                <button class="btn btn-ghost btn-sm" onclick="navigate('editor',{botName:'${esc(b.name)}'})"><i class="ti ti-code"></i>Éditer</button>
                <button class="btn btn-primary btn-sm" onclick="botAction('restart','${esc(b.name)}',this)"><i class="ti ti-refresh"></i>Redémarrer</button>
              </div>
            </div>`).join('')}
        </div>` : ''}

      <div class="card">
        <div class="card-header">
          <span class="card-title"><i class="ti ti-terminal"></i>Logs — <span id="log-bot-nm">${esc(first || '—')}</span></span>
          <div class="tabs">
            <button class="tab-btn active" onclick="switchTab('log-out','log-err',this)">stdout</button>
            <button class="tab-btn" onclick="switchTab('log-err','log-out',this)">stderr</button>
          </div>
        </div>
        <div id="log-out" style="background:var(--bg-base);border-radius:0 0 10px 10px;min-height:350px;max-height:450px;overflow-y:auto;padding:4px 0;"></div>
        <div id="log-err" style="background:var(--bg-base);border-radius:0 0 10px 10px;min-height:350px;max-height:450px;overflow-y:auto;padding:4px 0;display:none;"></div>
      </div>`;

    if (first) switchLogBot(first);
  } catch (e) {
    page.innerHTML = `<div class="loader" style="color:var(--red);">${esc(e.message)}</div>`;
  }
}

async function switchLogBot(botName) {
  App.currentLogBot = botName;
  const nm = document.getElementById('log-bot-nm'); if (nm) nm.textContent = botName;
  const outEl = document.getElementById('log-out');
  const errEl = document.getElementById('log-err');
  if (outEl) outEl.innerHTML = `<div class="loader" style="background:transparent;padding:20px;"><div class="spinner"></div></div>`;

  try {
    const logs = await NexusAPI.bots.logs(botName, 200);
    if (outEl) {
      outEl.innerHTML = logs.out.length
        ? logs.out.map(l => logLine(l)).join('')
        : '<div class="log-line"><span class="log-out" style="color:var(--tx-3);font-style:italic;padding:0 14px;">Aucun log stdout</span></div>';
      outEl.scrollTop = outEl.scrollHeight;
    }
    if (errEl) {
      errEl.innerHTML = logs.err.length
        ? logs.err.map(l => `<div class="log-line"><span class="log-err">${esc(l)}</span></div>`).join('')
        : '<div class="log-line"><span class="log-out" style="color:var(--tx-3);font-style:italic;padding:0 14px;">Aucune erreur</span></div>';
    }

    // Subscribe live
    if (App.socket) {
      App.socket.emit('subscribe:logs', botName);
      App.socket.off('log:out'); App.socket.off('log:err');
      App.socket.on('log:out', d => {
        if (d.bot === botName && outEl) {
          outEl.insertAdjacentHTML('beforeend', `<div class="log-line"><span class="log-ts">${new Date(d.ts).toLocaleTimeString()}</span><span class="log-out">${esc(d.line)}</span></div>`);
          outEl.scrollTop = outEl.scrollHeight;
        }
      });
      App.socket.on('log:err', d => {
        if (d.bot === botName && errEl)
          errEl.insertAdjacentHTML('beforeend', `<div class="log-line"><span class="log-ts">${new Date(d.ts).toLocaleTimeString()}</span><span class="log-err">${esc(d.line)}</span></div>`);
      });
    }
  } catch (e) {
    if (outEl) outEl.innerHTML = `<div class="log-line"><span class="log-err" style="padding:0 14px;">${esc(e.message)}</span></div>`;
  }
}

function clearLogs() {
  const o = document.getElementById('log-out'); if (o) o.innerHTML = '';
  const e = document.getElementById('log-err'); if (e) e.innerHTML = '';
}

function exportLogs() {
  const txt = document.getElementById('log-out')?.innerText || '';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
  a.download = `${App.currentLogBot || 'nexus'}-logs-${new Date().toISOString().slice(0,10)}.txt`;
  a.click();
}

// ════════════════════════════════════════════════════════════
// NPM PAGE
// ════════════════════════════════════════════════════════════
async function loadNpm(botName) {
  const page = document.getElementById('page-npm');
  try {
    const bots  = App.bots.length ? App.bots : await NexusAPI.bots.list();
    App.bots    = bots;
    const first = botName || bots[0]?.name;

    page.innerHTML = `
      <div class="flex-between mb-16">
        <span class="section-title"><i class="ti ti-package"></i>Dépendances npm</span>
        <div class="flex gap-8">
          <select class="form-control" id="npm-sel" style="width:200px;" onchange="loadNpmForBot(this.value)">
            ${bots.map(b => `<option value="${esc(b.name)}"${b.name===first?' selected':''}>${esc(b.name)}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" onclick="showInstallModal()"><i class="ti ti-plus"></i>Installer</button>
        </div>
      </div>
      <div id="npm-content"><div class="loader"><div class="spinner spinner-lg"></div></div></div>`;

    if (first) loadNpmForBot(first);
  } catch (e) {
    page.innerHTML = `<div class="loader" style="color:var(--red);">${esc(e.message)}</div>`;
  }
}

async function loadNpmForBot(botName) {
  const el = document.getElementById('npm-content');
  if (!el) return;
  el.innerHTML = `<div class="loader" style="padding:20px;"><div class="spinner"></div></div>`;

  try {
    const deps = await NexusAPI.bots.npmList(botName);
    const rows = Object.entries(deps.dependencies || {}).map(([k,v]) => `
      <div style="display:flex;align-items:center;gap:8px;padding:9px 16px;border-bottom:1px solid var(--border);">
        <i class="ti ti-package" style="color:var(--blue);font-size:14px;"></i>
        <span style="font-weight:500;color:var(--tx-1);flex:1;">${esc(k)}</span>
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--tx-3);">${esc(v)}</span>
        <span class="badge badge-blue" style="font-size:9px;">installé</span>
        <button class="btn btn-danger btn-xs" onclick="removePkg('${esc(botName)}','${esc(k)}')"><i class="ti ti-trash"></i>Retirer</button>
      </div>`).join('');

    el.innerHTML = `<div class="card">
      <div class="card-header"><span class="card-title"><i class="ti ti-package"></i>Dépendances — ${esc(botName)}</span>
        <span style="font-size:11px;color:var(--tx-3);">${Object.keys(deps.dependencies||{}).length} packages</span>
      </div>
      ${rows || '<div class="empty-state" style="padding:20px;"><i class="ti ti-package"></i><div class="empty-state-title">Aucune dépendance</div></div>'}
    </div>`;
  } catch (e) {
    el.innerHTML = `<div class="loader" style="color:var(--red);">${esc(e.message)}</div>`;
  }
}

function showInstallModal() {
  const botName = document.getElementById('npm-sel')?.value;
  if (!botName) return;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal modal-sm">
    <div class="modal-header"><span class="modal-title"><i class="ti ti-package"></i>Installer un package</span>
      <button class="btn-close" onclick="this.closest('.modal-overlay').remove()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">Nom du package npm</label>
        <input class="form-control" id="inst-pkg" placeholder="ex: axios lodash @types/node" autofocus/>
        <div class="form-hint"><i class="ti ti-info-circle"></i>Plusieurs packages séparés par des espaces</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Annuler</button>
      <button class="btn btn-primary" onclick="installPkg('${esc(botName)}')"><i class="ti ti-download"></i>Installer</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#inst-pkg').focus();
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
}

async function installPkg(botName) {
  const pkgs = (document.getElementById('inst-pkg')?.value || '').trim().split(/\s+/).filter(Boolean);
  if (!pkgs.length) return;
  document.querySelector('.modal-overlay')?.remove();
  toast('info', 'Installation...', pkgs.join(', '));
  try {
    await NexusAPI.bots.npmInstall(botName, pkgs, false);
    toast('success', 'Installé !', pkgs.join(', '));
    loadNpmForBot(botName);
  } catch (e) { toast('error', 'Erreur npm', e.message); }
}

async function removePkg(botName, pkg) {
  confirm('Désinstaller', `Supprimer <strong>${esc(pkg)}</strong> de ${esc(botName)} ?`, async () => {
    try { await NexusAPI.bots.npmRemove(botName, pkg); toast('success', 'Désinstallé', pkg); loadNpmForBot(botName); }
    catch (e) { toast('error', 'Erreur', e.message); }
  });
}

// ════════════════════════════════════════════════════════════
// BACKUPS PAGE
// ════════════════════════════════════════════════════════════
async function loadBackups() {
  const page = document.getElementById('page-backups');
  try {
    const [bots, backups] = await Promise.all([NexusAPI.bots.list(), NexusAPI.backups.list()]);
    App.bots = bots;

    page.innerHTML = `
      <div class="flex-between mb-16">
        <span class="section-title"><i class="ti ti-archive"></i>Sauvegardes</span>
        <button class="btn btn-ghost btn-sm" onclick="showImportModal()"><i class="ti ti-upload"></i>Importer</button>
      </div>

      <div class="card mb-16">
        <div class="card-header"><span class="card-title"><i class="ti ti-download"></i>Exporter un bot</span></div>
        <div class="card-body">
          <div class="flex gap-8">
            <select class="form-control" id="exp-sel" style="flex:1;">
              ${bots.map(b => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('')}
            </select>
            <button class="btn btn-primary" onclick="exportBot(document.getElementById('exp-sel').value)"><i class="ti ti-archive"></i>Télécharger .zip</button>
          </div>
          <div class="form-hint mt-8"><i class="ti ti-info-circle"></i>L'archive contient tous les fichiers sauf node_modules.</div>
        </div>
      </div>

      <div class="drop-zone mb-16" id="bk-dz" onclick="showImportModal()">
        <i class="ti ti-upload"></i>
        Glisser un fichier <strong>.zip</strong> ici pour restaurer un bot
      </div>

      <div class="table-wrap">
        <div class="table-toolbar"><span class="table-title"><i class="ti ti-history"></i>Historique des exports</span></div>
        ${backups.length ? `<table class="data-tbl">
          <thead><tr><th>Bot</th><th>Fichier</th><th>Date</th><th></th></tr></thead>
          <tbody>${backups.map(b => `<tr>
            <td class="td-bold">${esc(b.bot_name)}</td>
            <td class="td-mono">${esc(b.filename)}</td>
            <td style="color:var(--tx-3);font-size:12px;">${fmtDate(b.created_at)}</td>
            <td><div class="act-group"><button class="act-btn act-danger" onclick="delBackup(${b.id})"><i class="ti ti-trash"></i></button></div></td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="empty-state"><i class="ti ti-archive"></i><div class="empty-state-title">Aucune sauvegarde</div></div>'}
      </div>`;

    const dz = document.getElementById('bk-dz');
    if (dz) {
      dz.ondragover = e => { e.preventDefault(); dz.classList.add('drag-over'); };
      dz.ondragleave = () => dz.classList.remove('drag-over');
      dz.ondrop = async e => { e.preventDefault(); dz.classList.remove('drag-over'); if (e.dataTransfer.files[0]) await importArchive(e.dataTransfer.files[0]); };
    }
  } catch (e) {
    page.innerHTML = `<div class="loader" style="color:var(--red);">${esc(e.message)}</div>`;
  }
}

async function exportBot(name) {
  if (!name) return;
  toast('info', 'Export en cours...', name);
  try {
    const res = await NexusAPI.backups.export(name);
    if (!res.ok) throw new Error((await res.json()).error);
    const blob = await res.blob();
    const cd   = res.headers.get('content-disposition') || '';
    const fn   = cd.match(/filename="([^"]+)"/)?.[1] || `${name}-backup.zip`;
    const a    = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fn; a.click();
    URL.revokeObjectURL(a.href);
    toast('success', 'Exporté !', fn);
    loadBackups();
  } catch (e) { toast('error', 'Erreur export', e.message); }
}

function showImportModal() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal modal-sm">
    <div class="modal-header"><span class="modal-title"><i class="ti ti-upload"></i>Importer un bot</span>
      <button class="btn-close" onclick="this.closest('.modal-overlay').remove()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <div class="drop-zone" onclick="document.getElementById('imp-f').click()" style="margin-bottom:8px;">
        <i class="ti ti-file-zip"></i>Cliquez ou glissez votre archive .zip
      </div>
      <input type="file" id="imp-f" accept=".zip" style="display:none;" onchange="importArchive(this.files[0])"/>
    </div>
    <div class="modal-footer"><button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Fermer</button></div>
  </div>`;
  document.body.appendChild(ov);
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
}

async function importArchive(file) {
  document.querySelector('.modal-overlay')?.remove();
  toast('info', 'Import en cours...', file.name);
  try {
    const r = await NexusAPI.backups.import(file);
    toast('success', 'Bot importé !', r.name);
    if (App.currentPage === 'backups') loadBackups();
  } catch (e) { toast('error', 'Erreur import', e.message); }
}

async function delBackup(id) {
  try { await NexusAPI.backups.delete(id); loadBackups(); }
  catch (e) { toast('error', 'Erreur', e.message); }
}

// ════════════════════════════════════════════════════════════
// SETTINGS PAGE
// ════════════════════════════════════════════════════════════
async function loadSettings() {
  const page = document.getElementById('page-settings');
  page.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  try {
    const settings = await NexusAPI.system.settings();
    App.settings = settings;

    page.innerHTML = `
      <div class="section-title mb-16"><i class="ti ti-settings"></i>Paramètres</div>
      <div class="settings-layout">
        <div class="settings-nav">
          ${[['general','ti-adjustments','Général'],['account','ti-user','Compte'],['appearance','ti-palette','Apparence'],['bots-cfg','ti-robot','Bots'],['about','ti-info-circle','À propos']].map(([id,ic,lbl]) =>
            `<div class="settings-nav-item${id==='general'?' active':''}" onclick="showSettingsSection('${id}',this)"><i class="ti ${ic}"></i>${lbl}</div>`
          ).join('')}
        </div>

        <div>
          <!-- General -->
          <div class="settings-section active" id="section-general">
            <div class="card mb-16">
              <div class="card-header"><span class="card-title"><i class="ti ti-adjustments"></i>Général</span></div>
              <div class="card-body">
                <div class="form-group"><label class="form-label">Nom de l'instance</label>
                  <input class="form-control" id="s-name" value="${esc(settings.instance_name || 'Nexus Bot Manager')}"/>
                  <div class="form-hint">Affiché dans la sidebar et le titre de page.</div>
                </div>
                <div class="form-group"><label class="form-label">Dossier racine des bots</label>
                  <input class="form-control mono" value="${esc(settings.bots_root || '/opt')}" disabled/>
                  <div class="form-hint">Configurable via la variable d'environnement BOTS_ROOT.</div>
                </div>
              </div>
              <div class="card-footer"><button class="btn btn-primary" onclick="saveGeneralSettings()"><i class="ti ti-check"></i>Enregistrer</button></div>
            </div>

            <div class="card">
              <div class="card-header"><span class="card-title"><i class="ti ti-robot"></i>Comportement des Bots</span></div>
              <div class="card-body">
                <div class="form-group">
                  <label class="toggle"><input type="checkbox" id="s-autorestart" ${settings.bot_autorestart ? 'checked' : ''}/>
                    <span class="toggle-label">Redémarrage automatique en cas de crash</span>
                  </label>
                </div>
                <div class="form-group"><label class="form-label">Redémarrages max <span class="form-label-hint">avant abandon</span></label>
                  <input class="form-control" id="s-maxrestart" type="number" value="${settings.bot_max_restarts || 5}" min="1" max="20" style="width:100px;"/>
                </div>
              </div>
              <div class="card-footer"><button class="btn btn-primary" onclick="saveBotSettings()"><i class="ti ti-check"></i>Enregistrer</button></div>
            </div>
          </div>

          <!-- Account -->
          <div class="settings-section" id="section-account">
            <div class="card">
              <div class="card-header"><span class="card-title"><i class="ti ti-lock"></i>Changer le mot de passe</span></div>
              <div class="card-body">
                <div class="form-group"><label class="form-label">Mot de passe actuel</label><input class="form-control" type="password" id="s-curpwd"/></div>
                <div class="form-group"><label class="form-label">Nouveau mot de passe</label><input class="form-control" type="password" id="s-newpwd"/></div>
                <div class="form-group"><label class="form-label">Confirmer</label><input class="form-control" type="password" id="s-cfpwd"/></div>
              </div>
              <div class="card-footer"><button class="btn btn-primary" onclick="changePassword()"><i class="ti ti-key"></i>Changer</button></div>
            </div>
          </div>

          <!-- Appearance -->
          <div class="settings-section" id="section-appearance">
            <div class="card">
              <div class="card-header"><span class="card-title"><i class="ti ti-palette"></i>Apparence</span></div>
              <div class="card-body">
                <div style="padding:8px;background:var(--bg-elevated);border-radius:var(--r);display:flex;align-items:center;gap:10px;">
                  <i class="ti ti-moon" style="color:var(--blue);font-size:20px;"></i>
                  <div>
                    <div style="font-size:13px;font-weight:500;color:var(--tx-1);">Mode sombre</div>
                    <div style="font-size:11px;color:var(--tx-3);">Nexus Bot Manager utilise exclusivement le thème sombre professionnel.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Bots config -->
          <div class="settings-section" id="section-bots-cfg">
            <div class="card">
              <div class="card-header"><span class="card-title"><i class="ti ti-robot"></i>Bots — Paramètres avancés</span></div>
              <div class="card-body">
                <div class="form-group"><label class="form-label">Intervalle de monitoring <span class="form-label-hint">secondes</span></label>
                  <input class="form-control" id="s-monint" type="number" value="${settings.monitoring_interval || 5}" min="2" max="60" style="width:100px;"/>
                </div>
                <div class="form-group">
                  <label class="toggle"><input type="checkbox" id="s-notif" ${settings.notifications_enabled ? 'checked' : ''}/>
                    <span class="toggle-label">Notifications activées</span>
                  </label>
                </div>
              </div>
              <div class="card-footer"><button class="btn btn-primary" onclick="saveAdvancedSettings()"><i class="ti ti-check"></i>Enregistrer</button></div>
            </div>
          </div>

          <!-- About -->
          <div class="settings-section" id="section-about">
            <div class="card">
              <div class="card-header"><span class="card-title"><i class="ti ti-info-circle"></i>À propos de Nexus Bot Manager</span></div>
              <div class="card-body">
                <div class="metric-row"><span class="metric-key">Version</span><span class="metric-val">1.0.0</span></div>
                <div class="metric-row"><span class="metric-key">Stack</span><span class="metric-val">Node.js · Express · Socket.IO · PM2</span></div>
                <div class="metric-row"><span class="metric-key">Licence</span><span class="metric-val">MIT</span></div>
                <div class="metric-row"><span class="metric-key">Dépôt</span><span class="metric-val"><a href="https://github.com/votre-repo/nexus-bot-manager" target="_blank" style="color:var(--blue);">GitHub</a></span></div>
                <div class="metric-row"><span class="metric-key">Node.js</span><span class="metric-val">${esc(App.systemInfo?.versions?.node || '—')}</span></div>
              </div>
            </div>
          </div>

        </div>
      </div>`;
  } catch (e) {
    page.innerHTML = `<div class="loader" style="color:var(--red);">${esc(e.message)}</div>`;
  }
}

function showSettingsSection(id, btn) {
  document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
  document.getElementById('section-' + id)?.classList.add('active');
}

async function saveGeneralSettings() {
  const name = document.getElementById('s-name')?.value?.trim();
  if (!name) { toast('warning', 'Nom manquant'); return; }
  try {
    await NexusAPI.system.updateSettings({ instance_name: name });
    App.instanceName = name;
    updateInstanceName(name);
    toast('success', 'Paramètres sauvegardés');
  } catch (e) { toast('error', 'Erreur', e.message); }
}

async function saveBotSettings() {
  try {
    await NexusAPI.system.updateSettings({
      bot_autorestart: document.getElementById('s-autorestart')?.checked,
      bot_max_restarts: parseInt(document.getElementById('s-maxrestart')?.value) || 5
    });
    toast('success', 'Paramètres bots sauvegardés');
  } catch (e) { toast('error', 'Erreur', e.message); }
}

async function saveAdvancedSettings() {
  try {
    await NexusAPI.system.updateSettings({
      monitoring_interval: parseInt(document.getElementById('s-monint')?.value) || 5,
      notifications_enabled: document.getElementById('s-notif')?.checked
    });
    toast('success', 'Paramètres avancés sauvegardés');
  } catch (e) { toast('error', 'Erreur', e.message); }
}

async function changePassword() {
  const cur = document.getElementById('s-curpwd')?.value;
  const nw  = document.getElementById('s-newpwd')?.value;
  const cf  = document.getElementById('s-cfpwd')?.value;
  if (!cur || !nw)   { toast('error', 'Champs manquants'); return; }
  if (nw !== cf)     { toast('error', 'Les mots de passe ne correspondent pas'); return; }
  if (nw.length < 6) { toast('error', 'Min. 6 caractères'); return; }
  try {
    await NexusAPI.auth.changePassword(cur, nw);
    toast('success', 'Mot de passe modifié');
    ['s-curpwd','s-newpwd','s-cfpwd'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  } catch (e) { toast('error', 'Erreur', e.message); }
}

// ════════════════════════════════════════════════════════════
// GLOBAL SEARCH
// ════════════════════════════════════════════════════════════
function globalSearch(q) {
  if (!q?.trim()) return;
  const match = App.bots.find(b => b.name.toLowerCase().includes(q.toLowerCase()));
  if (match) navigate('bot', { botName: match.name });
}

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); document.getElementById('global-search')?.focus(); }
    if (e.key === 'Escape') { document.querySelector('.modal-overlay')?.remove(); document.querySelector('.ctx-menu')?.remove(); }
  });

  // Login form
  document.getElementById('login-btn')?.addEventListener('click', doLogin);
  document.getElementById('login-pass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('login-user')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // Setup wizard
  document.getElementById('setup-next')?.addEventListener('click', setupNext);
  document.getElementById('setup-prev')?.addEventListener('click', setupPrev);

  // Sidebar items
  document.querySelectorAll('.sb-item[data-page]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.page));
  });

  // Boot
  bootApp();
});
