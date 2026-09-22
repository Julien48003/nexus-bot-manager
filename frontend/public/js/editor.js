'use strict';
/**
 * Nexus Bot Manager — Monaco Editor Module
 * Full VS Code-like editing experience in the browser.
 */

const EditorState = {
  monaco:       null,   // Monaco instance
  editor:       null,   // Editor instance
  tabs:         [],     // [{id, botName, filePath, fileName, content, modified, language, model}]
  activeTabId:  null,
  currentBot:   null,
  treeData:     {},     // botName → tree array
  treeExpanded: {},     // path → bool
};

// ── Monaco loader ────────────────────────────────────────
//
// Robust, idempotent, shared loader:
//  - If Monaco is already on `window`, resolve immediately.
//  - If a load is already in flight, return the SAME promise so concurrent
//    callers don't trigger parallel fetches.
//  - If the previous load failed, the next call retries from scratch.
//  - 15s safety timeout so the UI never stays stuck on "Chargement…".
//  - Surfaces a clear error in the container so the user can retry.
const MONACO_LOAD_TIMEOUT = 15000;
const MonacoLoader = {
  state: 'idle',     // 'idle' | 'loading' | 'ready' | 'error'
  promise: null,
  error: null,

  load() {
    if (window.monaco) { this.state = 'ready'; return Promise.resolve(window.monaco); }
    if (this.state === 'loading' && this.promise) return this.promise;
    if (this.state === 'ready')                    return Promise.resolve(window.monaco);

    this.state = 'loading';
    this.error = null;

    this.promise = new Promise((resolve, reject) => {
      if (typeof require === 'undefined') {
        const e = new Error('Monaco loader not available');
        this._fail(reject, e);
        return;
      }

      const CDN = '//cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs';
      require.config({ paths: { vs: CDN } });

      let settled = false;
      const onLoaded = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (window.monaco) {
          this.state = 'ready';
          this.error = null;
          resolve(window.monaco);
        } else {
          this._fail(reject, new Error('Monaco a chargé le script mais window.monaco est absent'));
        }
      };
      const onError = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._fail(reject, new Error('Échec du téléchargement de Monaco : ' + (err && err.message ? err.message : err)));
      };

      // AMD load
      try {
        require(['vs/editor/editor.main'], onLoaded, onError);
      } catch (e) {
        return this._fail(reject, e);
      }

      // Safety timeout
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._fail(reject, new Error('Le chargement de Monaco a dépassé ' + (MONACO_LOAD_TIMEOUT / 1000) + 's'));
      }, MONACO_LOAD_TIMEOUT);
    });

    return this.promise;
  },

  _fail(reject, err) {
    this.state = 'error';
    this.error = err;
    this.promise = null;
    reject(err);
  },

  reset() {
    // Allow the next load() call to retry from scratch.
    this.state = 'idle';
    this.promise = null;
    this.error = null;
  },
};

function loadMonaco() {
  return MonacoLoader.load();
}

// ════════════════════════════════════════════════════════════
// OPEN EDITOR FOR BOT
// ════════════════════════════════════════════════════════════
async function openEditorForBot(botName) {
  EditorState.currentBot = botName;
  renderEditorShell(botName);
  await loadFileTree(botName);
  initMonacoIfNeeded();
}

function renderEditorShell(botName) {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  const page = document.getElementById('page-editor');
  page.innerHTML = `
    <!-- Editor topbar -->
    <div style="display:flex;align-items:center;height:42px;padding:0 14px;background:var(--bg-surface);border-bottom:1px solid var(--border);flex-shrink:0;gap:10px;">
      <button class="btn btn-ghost btn-sm" onclick="navigate('bots')"><i class="ti ti-arrow-left"></i>${esc(_t('nav.bots'))}</button>
      <div style="width:1px;height:20px;background:var(--border);"></div>
      <div style="font-size:13px;font-weight:600;color:var(--tx-1);">
        <i class="ti ti-code" style="color:var(--blue);margin-right:4px;"></i>
        ${esc(botName)}
      </div>
      <div style="flex:1;"></div>
      <button class="btn btn-ghost btn-sm" onclick="newFilePrompt()"><i class="ti ti-file-plus"></i>${esc(_t('editor.newFile'))}</button>
      <button class="btn btn-ghost btn-sm" onclick="newFolderPrompt()"><i class="ti ti-folder-plus"></i>${esc(_t('editor.newFolder'))}</button>
      <button class="btn btn-success btn-sm" id="btn-save" onclick="saveActive()" disabled><i class="ti ti-device-floppy"></i>${esc(_t('editor.saveShortcut'))}</button>
      <button class="btn btn-primary btn-sm" onclick="botAction('restart','${esc(botName)}',this)"><i class="ti ti-refresh"></i>${esc(_t('common.restart'))}</button>
    </div>

    <div id="editor-shell">
      <!-- File tree -->
      <div id="file-tree">
        <div class="ft-header">
          ${esc(_t('editor.fileTree'))}
          <div class="ft-header-actions">
            <button class="btn btn-ghost btn-xs btn-icon" onclick="newFilePrompt()" title="${esc(_t('editor.newFile'))}"><i class="ti ti-file-plus"></i></button>
            <button class="btn btn-ghost btn-xs btn-icon" onclick="newFolderPrompt()" title="${esc(_t('editor.newFolder'))}"><i class="ti ti-folder-plus"></i></button>
            <button class="btn btn-ghost btn-xs btn-icon" onclick="loadFileTree('${esc(botName)}')" title="${esc(_t('common.refresh'))}"><i class="ti ti-refresh"></i></button>
          </div>
        </div>
        <div class="ft-body" id="ft-body">
          <div class="loader" style="background:transparent;padding:20px;"><div class="spinner"></div></div>
        </div>
        <div class="ft-footer">
          <div class="drop-zone" id="ft-dz" style="padding:12px;font-size:11px;">
            <i class="ti ti-upload"></i>${esc(_t('editor.dropFiles'))}
          </div>
        </div>
      </div>

      <!-- Editor main -->
      <div id="editor-main">
        <!-- Tabs bar -->
        <div id="editor-tabs-bar">
          <div id="editor-tabs-empty" style="display:flex;align-items:center;padding:0 14px;font-size:12px;color:var(--tx-3);font-style:italic;">
            ${esc(_t('editor.tabsEmpty'))}
          </div>
        </div>

        <!-- Monaco -->
        <div id="monaco-container">
          <div class="loader" style="height:100%;">
            <div class="spinner spinner-lg"></div>
            <span>${esc(_t('editor.loading'))}</span>
          </div>
        </div>

        <!-- Bottom panel -->
        <div id="editor-bottom">
          <div class="eb-tabs-bar">
            <button class="eb-tab active" onclick="switchEbTab('logs',this)">${esc(_t('editor.logsTab'))}</button>
            <button class="eb-tab" onclick="switchEbTab('err',this)">${esc(_t('editor.errTab'))}</button>
            <button class="eb-tab" onclick="switchEbTab('npm',this)">${esc(_t('editor.npmTab'))}</button>
            <div class="eb-spacer"></div>
            <button class="btn btn-ghost btn-xs" onclick="clearEbPanel()" style="margin:3px 8px;"><i class="ti ti-trash"></i>${esc(_t('editor.clearPanel'))}</button>
            <button class="btn btn-ghost btn-xs" onclick="refreshEbPanel('${esc(botName)}')" style="margin:3px 8px;"><i class="ti ti-refresh"></i></button>
          </div>
          <div id="eb-logs" class="eb-panel active"></div>
          <div id="eb-err"  class="eb-panel"></div>
          <div id="eb-npm"  class="eb-panel" style="background:var(--bg-card);"></div>
        </div>
      </div>
    </div>`;

  setupDropZone(botName);
}

// ── Monaco init ────────────────────────────────────────────
async function initMonacoIfNeeded() {
  if (EditorState.editor) {
    // Already initialized — just resize
    EditorState.editor.layout();
    return;
  }

  // Show "loading" while the shared Promise resolves (in case the user
  // switched pages and came back before Monaco finished).
  renderMonacoLoader();

  try {
    const monaco = await loadMonaco();
    EditorState.monaco = monaco;

    const container = document.getElementById('monaco-container');
    if (!container) return;
    container.innerHTML = '';

    // Define Nexus dark theme
    monaco.editor.defineTheme('nexus-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background':         '#0d1117',
        'editor.foreground':         '#e6edf3',
        'editor.lineHighlightBackground': '#1c2128',
        'editorLineNumber.foreground':   '#6e7681',
        'editorLineNumber.activeForeground': '#8b949e',
        'editor.selectionBackground': 'rgba(37,99,235,0.25)',
        'editorWidget.background':   '#1c2128',
        'editorSuggestWidget.background': '#1c2128',
        'editorSuggestWidget.border':     '#30363d',
        'input.background':          '#161b22',
        'input.border':              '#30363d',
        'focusBorder':               '#2563eb',
        'scrollbar.shadow':          '#00000000',
      }
    });

    EditorState.editor = monaco.editor.create(container, {
      value:                '',
      language:             'javascript',
      // Pick the Monaco UI language from the Nexus active language so
      // commands/menus/snippets that ship with Monaco come out in the
      // user-selected language. We map 'en' / 'fr' / 'de' to the closest
      // locale Monaco supports.
      uiLanguage:           (window.NexusI18n && window.NexusI18n.current) === 'fr' ? 'fr'
                          : (window.NexusI18n && window.NexusI18n.current) === 'de' ? 'de'
                          : 'en',
      theme:                'nexus-dark',
      fontSize:             13,
      fontFamily:           "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontLigatures:        true,
      lineNumbers:          'on',
      minimap:              { enabled: true, scale: 1 },
      scrollBeyondLastLine: false,
      automaticLayout:      true,
      wordWrap:             'off',
      tabSize:              2,
      insertSpaces:         true,
      bracketPairColorization: { enabled: true },
      guides:               { bracketPairs: true, indentation: true },
      renderLineHighlight:  'line',
      cursorBlinking:       'smooth',
      cursorSmoothCaretAnimation: 'on',
      smoothScrolling:      true,
      padding:              { top: 10, bottom: 10 },
      quickSuggestions:     { other: true, comments: false, strings: true },
      folding:              true,
      suggest:              { showMethods: true, showFunctions: true, showClasses: true },
      renderWhitespace:     'selection',
      scrollbar: { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    });

    // Ctrl+S → save
    EditorState.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
    // Ctrl+W → close tab
    EditorState.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => closeTab(EditorState.activeTabId));

    // Track modifications
    EditorState.editor.onDidChangeModelContent(() => markModified(EditorState.activeTabId));

    console.log('[Monaco] Editor initialized');

    // Load initial logs
    setTimeout(() => refreshEbPanel(EditorState.currentBot), 500);

  } catch (e) {
    console.error('[Monaco] Error:', e.message);
    renderMonacoError(e.message);
  }
}

// ── Monaco loader/error UI helpers ────────────────────────
function renderMonacoLoader() {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  const c = document.getElementById('monaco-container');
  if (!c) return;
  c.innerHTML = `
    <div class="loader" style="height:100%;">
      <div class="spinner spinner-lg"></div>
      <span>${esc(_t('editor.loading'))}</span>
    </div>`;
}

function renderMonacoError(message) {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  const c = document.getElementById('monaco-container');
  if (!c) return;
  c.innerHTML = `
    <div class="loader" style="height:100%;color:var(--red);gap:6px;">
      <i class="ti ti-alert-circle" style="font-size:28px;"></i>
      <span>${esc(_t('editor.loadError'))}</span>
      <div style="font-size:11px;color:var(--tx-3);max-width:380px;text-align:center;">${esc(message || _t('errors.generic'))}<br>${esc(_t('editor.loadErrorHint'))}</div>
      <button class="btn btn-primary btn-sm" onclick="retryMonacoLoad()" style="margin-top:8px;"><i class="ti ti-refresh"></i>${esc(_t('editor.retry'))}</button>
    </div>`;
}

function retryMonacoLoad() {
  // Reset the shared loader so the next call triggers a fresh attempt.
  MonacoLoader.reset();
  // Tear down any previously created editor instance to avoid leaks on retry.
  try { EditorState.editor?.dispose(); } catch (_) {}
  EditorState.editor = null;
  EditorState.monaco = null;
  initMonacoIfNeeded();
}

// ── Language detection ─────────────────────────────────────
function detectLang(filename) {
  const name = filename.toLowerCase();
  const ext  = name.split('.').pop();
  if (name === '.env' || name.endsWith('.env')) return 'ini';
  if (name === '.gitignore' || name === '.dockerignore') return 'plaintext';
  const map = { js:'javascript', mjs:'javascript', cjs:'javascript', ts:'typescript', json:'json', md:'markdown', sh:'shell', bash:'shell', yaml:'yaml', yml:'yaml', html:'html', css:'css', py:'python', txt:'plaintext', log:'plaintext' };
  return map[ext] || 'plaintext';
}

// ════════════════════════════════════════════════════════════
// FILE TREE
// ════════════════════════════════════════════════════════════
async function loadFileTree(botName) {
  const body = document.getElementById('ft-body');
  if (!body) return;
  body.innerHTML = `<div class="loader" style="background:transparent;padding:20px;"><div class="spinner spinner-sm"></div></div>`;
  try {
    const tree = await NexusAPI.files.tree(botName);
    EditorState.treeData[botName] = tree;
    renderFileTree(botName, tree.children || []);
  } catch (e) {
    body.innerHTML = `<div style="padding:12px;color:var(--red);font-size:12px;"><i class="ti ti-alert-circle"></i> ${esc(e.message)}</div>`;
  }
}

function renderFileTree(botName, items) {
  const body = document.getElementById('ft-body');
  if (!body) return;
  body.innerHTML = renderTreeItems(botName, items, 0);
}

function renderTreeItems(botName, items, depth) {
  return items.map(item => {
    const dc = depth > 0 ? `depth-${Math.min(depth, 3)}` : '';
    if (item.type === 'dir') {
      const expanded = EditorState.treeExpanded[item.path] !== false;
      const slug     = slugify(item.path);
      return `
        <div class="ft-item dir ${dc}" onclick="toggleDir('${esc(item.path)}','${esc(botName)}',this)">
          <i class="ti ${expanded ? 'ti-folder-open' : 'ti-folder'} fi-dir" id="dir-ico-${slug}"></i>
          <span class="ft-item-name">${esc(item.name)}</span>
          <i class="ti ${expanded ? 'ti-chevron-down' : 'ti-chevron-right'}" style="margin-left:auto;font-size:10px;color:var(--tx-3);" id="dir-chv-${slug}"></i>
        </div>
        <div id="dir-${slug}" style="${expanded ? '' : 'display:none;'}">
          ${item.children ? renderTreeItems(botName, item.children, depth + 1) : ''}
        </div>`;
    } else {
      const isActive = EditorState.tabs.find(t => t.filePath === item.path && t.id === EditorState.activeTabId);
      return `
        <div class="ft-item ${dc} ${isActive ? 'active' : ''}"
             onclick="openFile('${esc(botName)}','${esc(item.path)}','${esc(item.name)}')"
             oncontextmenu="fileCtxMenu(event,'${esc(botName)}','${esc(item.path)}','${esc(item.name)}')"
             id="ft-${slugify(item.path)}">
          ${fileIcon(item.name)}
          <span class="ft-item-name">${esc(item.name)}</span>
        </div>`;
    }
  }).join('');
}

function toggleDir(dirPath, botName, el) {
  const slug     = slugify(dirPath);
  const content  = document.getElementById('dir-' + slug);
  const ico      = document.getElementById('dir-ico-' + slug);
  const chv      = document.getElementById('dir-chv-' + slug);
  const isOpen   = EditorState.treeExpanded[dirPath] !== false;
  EditorState.treeExpanded[dirPath] = !isOpen;
  if (content) content.style.display = isOpen ? 'none' : '';
  if (ico)     ico.className = `ti ${!isOpen ? 'ti-folder-open' : 'ti-folder'} fi-dir`;
  if (chv)     chv.className = `ti ${!isOpen ? 'ti-chevron-down' : 'ti-chevron-right'}`;
  chv && (chv.style.cssText = 'margin-left:auto;font-size:10px;color:var(--tx-3);');
}

function slugify(s) { return String(s).replace(/[^a-zA-Z0-9]/g, '_'); }

// ── Context menu ───────────────────────────────────────────
function fileCtxMenu(e, botName, filePath, fileName) {
  e.preventDefault();
  e.stopPropagation();
  document.querySelector('.ctx-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.cssText = `position:fixed;left:${Math.min(e.clientX, window.innerWidth-160)}px;top:${Math.min(e.clientY, window.innerHeight-120)}px;
    background:var(--bg-card);border:1px solid var(--border);border-radius:var(--r-lg);
    box-shadow:var(--shadow-lg);z-index:5000;min-width:160px;padding:4px 0;`;

  const item = (icon, label, fn, danger = false) => {
    const el = document.createElement('div');
    el.style.cssText = `display:flex;align-items:center;gap:8px;padding:7px 14px;font-size:12px;cursor:pointer;color:${danger?'var(--red)':'var(--tx-2)'};transition:background 0.1s;font-family:var(--font);`;
    el.innerHTML     = `<i class="ti ${icon}" style="font-size:13px;width:14px;"></i>${label}`;
    el.onmouseenter  = () => el.style.background = danger ? 'var(--red-bg)' : 'var(--bg-hover)';
    el.onmouseleave  = () => el.style.background = 'transparent';
    el.onclick       = () => { menu.remove(); fn(); };
    return el;
  };

  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  menu.appendChild(item('ti-code',   _t('common.open'),     () => openFile(botName, filePath, fileName)));
  menu.appendChild(item('ti-pencil', _t('common.edit'),     () => renameFilePrompt(botName, filePath, fileName)));
  const sep = document.createElement('div');
  sep.style.cssText = 'height:1px;background:var(--border);margin:4px 0;';
  menu.appendChild(sep);
  menu.appendChild(item('ti-trash',  _t('common.delete'),   () => deleteFileConfirm(botName, filePath, fileName), true));

  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ════════════════════════════════════════════════════════════
// TABS
// ════════════════════════════════════════════════════════════
async function openFile(botName, filePath, fileName) {
  // Check if already open
  const existing = EditorState.tabs.find(t => t.filePath === filePath);
  if (existing) { activateTab(existing.id); return; }

  try {
    const data  = await NexusAPI.files.read(botName, filePath);
    const lang  = detectLang(fileName);
    const id    = `tab-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

    let model = null;
    if (EditorState.monaco) {
      const uri = EditorState.monaco.Uri.parse(`file://${filePath}`);
      model = EditorState.monaco.editor.getModel(uri)
        || EditorState.monaco.editor.createModel(data.content, lang, uri);
    }

    EditorState.tabs.push({ id, botName, filePath, fileName, content: data.content, modified: false, language: lang, model });
    renderTabs();
    activateTab(id);
    updateTreeActive(filePath);
  } catch (e) {
    const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
    toast('error', _t('errors.generic'), e.message);
  }
}

function activateTab(id) {
  EditorState.activeTabId = id;
  const tab = EditorState.tabs.find(t => t.id === id);
  if (!tab) return;

  if (EditorState.editor) {
    if (tab.model) {
      EditorState.editor.setModel(tab.model);
    } else {
      const monaco = EditorState.monaco;
      if (monaco) {
        const uri   = monaco.Uri.parse(`file://${tab.filePath}`);
        const model = monaco.editor.getModel(uri) || monaco.editor.createModel(tab.content, tab.language, uri);
        tab.model   = model;
        EditorState.editor.setModel(model);
      }
    }
  }

  renderTabs();
  updateTreeActive(tab.filePath);
  document.getElementById('btn-save').disabled = false;
}

function renderTabs() {
  const bar   = document.getElementById('editor-tabs-bar');
  const empty = document.getElementById('editor-tabs-empty');
  if (!bar) return;

  // Remove old tabs (keep static empty label)
  bar.querySelectorAll('.ed-tab, .ed-tab-actions').forEach(el => el.remove());
  if (empty) empty.style.display = EditorState.tabs.length > 0 ? 'none' : '';

  EditorState.tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className      = `ed-tab ${tab.id === EditorState.activeTabId ? 'active' : ''}`;
    el.dataset.tabId  = tab.id;
    el.innerHTML      = `
      <span style="flex-shrink:0;font-size:12px;">${fileIcon(tab.fileName)}</span>
      <span style="max-width:120px;overflow:hidden;text-overflow:ellipsis;" title="${esc(tab.filePath)}">${esc(tab.fileName)}</span>
      ${tab.modified ? '<span class="tab-modified" title="Non sauvegardé"></span>' : ''}
      <span class="tab-close" onclick="event.stopPropagation();closeTab('${tab.id}')"><i class="ti ti-x"></i></span>`;
    el.onclick = () => activateTab(tab.id);
    bar.insertBefore(el, bar.querySelector('.ed-tab-actions'));
  });

  // Actions bar (right side)
  if (EditorState.tabs.length > 0 && !bar.querySelector('.ed-tab-actions')) {
    const acts = document.createElement('div');
    acts.className = 'ed-tab-actions';
    acts.innerHTML = `<button class="btn btn-ghost btn-xs" onclick="closeAllTabs()" title="Fermer tout"><i class="ti ti-x"></i></button>`;
    bar.appendChild(acts);
  }
}

function markModified(tabId) {
  const tab = EditorState.tabs.find(t => t.id === tabId);
  if (!tab) return;
  tab.content  = EditorState.editor?.getValue() ?? tab.content;
  if (!tab.modified) { tab.modified = true; renderTabs(); }
}

function updateTreeActive(filePath) {
  document.querySelectorAll('#ft-body .ft-item:not(.dir)').forEach(el => {
    el.classList.remove('active');
  });
  const el = document.getElementById('ft-' + slugify(filePath));
  if (el) el.classList.add('active');
}

async function saveActive() {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  const tab = EditorState.tabs.find(t => t.id === EditorState.activeTabId);
  if (!tab) return;
  const content = EditorState.editor?.getValue() ?? tab.content;
  const btn     = document.getElementById('btn-save');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner spinner-sm"></div>'; }
  try {
    await NexusAPI.files.write(tab.botName, tab.filePath, content);
    tab.content  = content;
    tab.modified = false;
    renderTabs();
    toast('success', _t('toasts.saved'), tab.fileName);
  } catch (e) {
    toast('error', _t('errors.generic'), e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-device-floppy"></i>Ctrl+S'; }
  }
}

function closeTab(id) {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  const tab = EditorState.tabs.find(t => t.id === id);
  if (!tab) return;
  if (tab.modified) {
    confirm(_t('editor.closeWithoutSaving'), `<p>${_t('editor.modificationsLost', { name: esc(tab.fileName) })}</p>`, () => doCloseTab(id));
    return;
  }
  doCloseTab(id);
}

function doCloseTab(id) {
  const idx = EditorState.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = EditorState.tabs[idx];
  tab.model?.dispose();
  EditorState.tabs.splice(idx, 1);

  if (EditorState.activeTabId === id) {
    const next = EditorState.tabs[Math.min(idx, EditorState.tabs.length - 1)];
    EditorState.activeTabId = next?.id ?? null;
    if (next) activateTab(next.id);
    else if (EditorState.editor) {
      EditorState.editor.setModel(EditorState.monaco?.editor.createModel('', 'plaintext'));
      document.getElementById('btn-save').disabled = true;
    }
  }
  renderTabs();
}

function closeAllTabs() {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  const modified = EditorState.tabs.filter(t => t.modified);
  const doClose  = () => { EditorState.tabs.forEach(t => t.model?.dispose()); EditorState.tabs = []; EditorState.activeTabId = null; if (EditorState.editor) EditorState.editor.setValue(''); renderTabs(); };
  if (modified.length) confirm(_t('editor.closeAllTitle'), _t('editor.closeAllDesc', { n: modified.length }), doClose);
  else doClose();
}

// ════════════════════════════════════════════════════════════
// FILE OPERATIONS
// ════════════════════════════════════════════════════════════
function newFilePrompt() {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  const botName = EditorState.currentBot;
  if (!botName) return;
  simpleModal(_t('editor.newFileTitle'), _t('editor.fileName'), _t('editor.filePlaceholder'), async (name) => {
    if (!name) return;
    try {
      await NexusAPI.files.create(botName, name, 'file', `/opt/${botName}`);
      await loadFileTree(botName);
      openFile(botName, `/opt/${botName}/${name}`, name);
      toast('success', _t('editor.fileCreated'), name);
    } catch (e) { toast('error', _t('errors.generic'), e.message); }
  });
}

function newFolderPrompt() {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  const botName = EditorState.currentBot;
  if (!botName) return;
  simpleModal(_t('editor.newFolderTitle'), _t('editor.folderName'), _t('editor.folderPlaceholder'), async (name) => {
    if (!name) return;
    try {
      await NexusAPI.files.create(botName, name, 'dir', `/opt/${botName}`);
      await loadFileTree(botName);
      toast('success', _t('editor.folderCreated'), name);
    } catch (e) { toast('error', _t('errors.generic'), e.message); }
  });
}

function renameFilePrompt(botName, filePath, fileName) {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  simpleModal(_t('editor.renameTitle'), _t('editor.newName'), fileName, async (newName) => {
    if (!newName || newName === fileName) return;
    try {
      await NexusAPI.files.rename(botName, filePath, newName);
      const tab = EditorState.tabs.find(t => t.filePath === filePath);
      if (tab) doCloseTab(tab.id);
      await loadFileTree(botName);
      toast('success', _t('editor.renamed'), newName);
    } catch (e) { toast('error', _t('errors.generic'), e.message); }
  }, fileName);
}

function deleteFileConfirm(botName, filePath, fileName) {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  confirm(_t('common.delete'), `<p>${_t('editor.deleteConfirm', { name: '<strong>' + esc(fileName) + '</strong>' })}</p>`, async () => {
    try {
      await NexusAPI.files.delete(botName, filePath);
      const tab = EditorState.tabs.find(t => t.filePath === filePath);
      if (tab) doCloseTab(tab.id);
      await loadFileTree(botName);
      toast('success', _t('editor.deleted'), fileName);
    } catch (e) { toast('error', _t('errors.generic'), e.message); }
  });
}

// ── Simple single-input modal ──────────────────────────────
function simpleModal(title, label, placeholder, onConfirm, defaultValue = '') {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal modal-sm">
    <div class="modal-header">
      <span class="modal-title"><i class="ti ti-edit"></i>${esc(title)}</span>
      <button class="btn-close" onclick="this.closest('.modal-overlay').remove()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">${esc(label)}</label>
        <input class="form-control" id="sm-input" placeholder="${esc(placeholder)}" value="${esc(defaultValue)}" autofocus/>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">${esc(_t('confirmDialog.no'))}</button>
      <button class="btn btn-primary" id="sm-ok"><i class="ti ti-check"></i>${esc(_t('confirmDialog.yes'))}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const input = ov.querySelector('#sm-input');
  input.focus(); input.select();
  const ok = () => { const v = input.value.trim(); ov.remove(); if (v) onConfirm(v); };
  ov.querySelector('#sm-ok').onclick = ok;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
}

// ════════════════════════════════════════════════════════════
// DRAG & DROP UPLOAD
// ════════════════════════════════════════════════════════════
function setupDropZone(botName) {
  const dz = document.getElementById('ft-dz');
  if (!dz) return;

  dz.onclick = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true;
    input.onchange = e => handleUpload(botName, Array.from(e.target.files));
    input.click();
  };

  const highlight = on => dz.classList.toggle('drag-over', on);
  dz.addEventListener('dragover',  e => { e.preventDefault(); highlight(true); });
  dz.addEventListener('dragleave', () => highlight(false));
  dz.addEventListener('drop', e => {
    e.preventDefault(); highlight(false);
    handleUpload(botName, Array.from(e.dataTransfer.files));
  });

  // Also accept drops on editor main area
  const edMain = document.getElementById('editor-main');
  if (edMain) {
    edMain.addEventListener('dragover',  e => { e.preventDefault(); highlight(true); });
    edMain.addEventListener('dragleave', () => highlight(false));
    edMain.addEventListener('drop', e => {
      e.preventDefault(); highlight(false);
      handleUpload(botName, Array.from(e.dataTransfer.files));
    });
  }
}

async function handleUpload(botName, files) {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  if (!files.length) return;
  toast('info', _t('editor.uploading', { n: files.length }));
  try {
    const result = await NexusAPI.files.upload(botName, files, '');
    if (result.uploaded.length) toast('success', _t('editor.uploaded', { n: result.uploaded.length }), result.uploaded.map(f => f.name).join(', '));
    if (result.errors.length)   toast('error',   _t('editor.uploadErrors', { n: result.errors.length }), result.errors[0].error);
    await loadFileTree(botName);
  } catch (e) {
    toast('error', _t('errors.generic'), e.message);
  }
}

// ════════════════════════════════════════════════════════════
// BOTTOM PANEL
// ════════════════════════════════════════════════════════════
function switchEbTab(tab, btn) {
  document.querySelectorAll('.eb-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.eb-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('eb-' + tab)?.classList.add('active');
}

async function refreshEbPanel(botName) {
  const _t = window.NexusI18n ? window.NexusI18n.t.bind(window.NexusI18n) : (k) => k;
  if (!botName) return;
  try {
    const logs = await NexusAPI.bots.logs(botName, 80);
    const logsEl = document.getElementById('eb-logs');
    const errEl  = document.getElementById('eb-err');

    if (logsEl) {
      logsEl.innerHTML = logs.out.length
        ? logs.out.map(l => logLineEb(l)).join('')
        : `<div class="log-empty"><i class="ti ti-info-circle"></i> ${esc(_t('logs.emptyStdout'))}</div>`;
      logsEl.scrollTop = logsEl.scrollHeight;
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

    // Subscribe live socket
    if (window.App?.socket) {
      App.socket.emit('subscribe:logs', botName);
      App.socket.off('log:out'); App.socket.off('log:err');
      App.socket.on('log:out', d => {
        if (d.bot === botName && logsEl) {
          logsEl.insertAdjacentHTML('beforeend', logLineEb(d.line, d.ts));
          logsEl.scrollTop = logsEl.scrollHeight;
        }
      });
      App.socket.on('log:err', d => {
        if (d.bot === botName && errEl) {
          const safeLine = window.NexusDiagnostics ? NexusDiagnostics.sanitize(d.line) : d.line;
          errEl.insertAdjacentHTML('beforeend', `<div class="log-line"><span class="log-ts">${new Date(d.ts).toLocaleTimeString()}</span><span class="log-err">${esc(safeLine)}</span></div>`);
        }
      });
    }
  } catch (_) {}
}

function logLineEb(line, ts) {
  let cls = 'log-out';
  if (/error|err|fatal/i.test(line)) cls = 'log-err';
  else if (/warn/i.test(line))       cls = 'log-warn';
  else if (/✅|connecté|ready/i.test(line)) cls = 'log-ok';
  const time = ts ? `<span class="log-ts">${new Date(ts).toLocaleTimeString()}</span>` : '';
  return `<div class="log-line">${time}<span class="${cls}">${esc(line)}</span></div>`;
}

function clearEbPanel() {
  document.querySelectorAll('.eb-panel').forEach(p => p.innerHTML = '');
}

// ── Expose globals ─────────────────────────────────────────
window.openEditorForBot  = openEditorForBot;
window.openFile          = openFile;
window.activateTab       = activateTab;
window.closeTab          = closeTab;
window.closeAllTabs      = closeAllTabs;
window.saveActive        = saveActive;
window.loadFileTree      = loadFileTree;
window.toggleDir         = toggleDir;
window.fileCtxMenu       = fileCtxMenu;
window.newFilePrompt     = newFilePrompt;
window.newFolderPrompt   = newFolderPrompt;
window.renameFilePrompt  = renameFilePrompt;
window.deleteFileConfirm = deleteFileConfirm;
window.switchEbTab       = switchEbTab;
window.refreshEbPanel    = refreshEbPanel;
window.clearEbPanel      = clearEbPanel;
window.handleUpload      = handleUpload;
