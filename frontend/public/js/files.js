'use strict';
/**
 * Nexus Bot Manager — Drive-style file manager.
 *
 * One directory level at a time, drag & drop from the OS or inside the
 * panel, list/grid views, and "open in Monaco" integration.
 */

const FilesState = {
  bot: null,
  path: '',
  view: localStorage.getItem('nexus.files.view') || 'grid',
  entries: [],
  search: '',
  loading: false,
  drag: null
};

const FILES_TEXT_EXT = new Set([
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'jsonc', 'env', 'md', 'txt',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'csv', 'log', 'sh', 'bash',
  'bat', 'cmd', 'ps1', 'html', 'css', 'scss', 'less', 'vue', 'svelte', 'sql',
  'graphql', 'gql', 'prisma', 'properties', 'lock', 'map', 'gitignore',
  'gitattributes', 'editorconfig', 'npmrc', 'nvmrc', 'dockerignore', 'example',
  'sample'
]);

const FILES_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);

function filesExt(name) {
  const n = String(name || '').toLowerCase();
  const i = n.lastIndexOf('.');
  return i >= 0 ? n.slice(i + 1) : '';
}

function filesIsText(name) {
  const ext = filesExt(name);
  return !ext || FILES_TEXT_EXT.has(ext);
}

function filesIsImage(name) {
  return FILES_IMAGE_EXT.has(filesExt(name));
}

function filesIcon(name, type) {
  if (type === 'dir') return 'ti-folder-filled';
  const ext = filesExt(name);
  if (FILES_IMAGE_EXT.has(ext)) return 'ti-photo';
  if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx'].includes(ext)) return 'ti-file-code';
  if (ext === 'json') return 'ti-braces';
  if (['md', 'txt'].includes(ext)) return 'ti-file-text';
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext)) return 'ti-file-zip';
  if (['yaml', 'yml', 'toml', 'ini', 'conf', 'env'].includes(ext)) return 'ti-settings';
  return 'ti-file';
}

function filesFmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function filesFmtDate(ms) {
  try {
    return new Date(ms).toLocaleString(
      window.NexusI18n && NexusI18n.current() === 'fr' ? 'fr-FR'
        : window.NexusI18n && NexusI18n.current() === 'de' ? 'de-DE' : 'en-GB',
      { dateStyle: 'short', timeStyle: 'short' }
    );
  } catch (_) { return ''; }
}

function filesT(key, vars) {
  return window.NexusI18n ? NexusI18n.t(key, vars) : key;
}

async function loadFilesPage(params = {}) {
  const page = document.getElementById('page-files');
  if (!page) return;

  let bots = Array.isArray(App.bots) ? App.bots : [];
  if (!bots.length) {
    try { bots = await NexusAPI.bots.list(); App.bots = bots; } catch (_) { bots = []; }
  }

  if (params.botName) {
    FilesState.bot = params.botName;
    FilesState.path = '';
  } else if (!FilesState.bot || !bots.some(b => b.name === FilesState.bot)) {
    FilesState.bot = localStorage.getItem('nexus.files.bot') || (bots[0] && bots[0].name) || null;
    FilesState.path = '';
  }
  if (FilesState.bot) localStorage.setItem('nexus.files.bot', FilesState.bot);

  page.innerHTML = filesShell(bots);
  filesBindUpload();
  if (FilesState.bot) await filesRefresh();
  else filesRenderContent();
}

function filesShell(bots) {
  const botOptions = bots.map(b =>
    `<option value="${esc(b.name)}" ${b.name === FilesState.bot ? 'selected' : ''}>${esc(b.display_name || b.name)}</option>`
  ).join('');

  return `
    <div class="files-page">
      <div class="files-head">
        <div>
          <div class="section-title mb-4"><i class="ti ti-folder"></i> ${esc(filesT('filesPage.title'))}</div>
          <div class="files-subtitle">${esc(filesT('filesPage.subtitle'))}</div>
        </div>
        <div class="files-head-actions">
          ${bots.length ? `
            <select class="form-control files-bot-select" onchange="filesSelectBot(this.value)" aria-label="${esc(filesT('filesPage.selectBot'))}">
              ${botOptions}
            </select>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="filesRefresh()" title="${esc(filesT('common.refresh'))}"><i class="ti ti-refresh"></i></button>
        </div>
      </div>

      ${bots.length ? `
      <div class="files-toolbar">
        <div class="files-breadcrumb" id="files-breadcrumb"></div>
        <div class="files-toolbar-actions">
          <input class="form-control files-search" id="files-search" placeholder="${esc(filesT('filesPage.search'))}" oninput="filesSearch(this.value)"/>
          <div class="files-view-toggle" role="group">
            <button class="btn btn-ghost btn-icon btn-sm ${FilesState.view === 'grid' ? 'active' : ''}" id="files-view-grid" onclick="filesSetView('grid')" title="${esc(filesT('filesPage.grid'))}"><i class="ti ti-layout-grid"></i></button>
            <button class="btn btn-ghost btn-icon btn-sm ${FilesState.view === 'list' ? 'active' : ''}" id="files-view-list" onclick="filesSetView('list')" title="${esc(filesT('filesPage.list'))}"><i class="ti ti-list"></i></button>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="filesNewFolder()"><i class="ti ti-folder-plus"></i>${esc(filesT('filesPage.newFolder'))}</button>
          <button class="btn btn-ghost btn-sm" onclick="filesNewFile()"><i class="ti ti-file-plus"></i>${esc(filesT('filesPage.newFile'))}</button>
          <button class="btn btn-primary btn-sm" onclick="document.getElementById('files-upload-input').click()"><i class="ti ti-upload"></i>${esc(filesT('filesPage.upload'))}</button>
          <input type="file" id="files-upload-input" multiple style="display:none"/>
        </div>
      </div>

      <div class="files-dropzone" id="files-content"
           ondragover="event.preventDefault(); this.classList.add('dragover');"
           ondragleave="if (event.target === this) this.classList.remove('dragover');"
           ondrop="filesDrop(event)">
      </div>` : `
      <div class="empty-state files-empty">
        <i class="ti ti-robot"></i>
        <div class="empty-state-title">${esc(filesT('filesPage.noBotsTitle'))}</div>
        <div class="empty-state-desc">${esc(filesT('filesPage.noBotsDesc'))}</div>
        <button class="btn btn-primary btn-sm mt-8" onclick="navigate('new-bot')"><i class="ti ti-plus"></i>${esc(filesT('filesPage.createBot'))}</button>
      </div>`}
    </div>`;
}

function filesBindUpload() {
  const input = document.getElementById('files-upload-input');
  if (input) input.addEventListener('change', () => filesUpload(input));
}

function filesSelectBot(name) {
  FilesState.bot = name;
  FilesState.path = '';
  FilesState.entries = [];
  localStorage.setItem('nexus.files.bot', name);
  filesRefresh();
}

function filesSetView(view) {
  FilesState.view = view === 'list' ? 'list' : 'grid';
  localStorage.setItem('nexus.files.view', FilesState.view);
  document.getElementById('files-view-grid')?.classList.toggle('active', FilesState.view === 'grid');
  document.getElementById('files-view-list')?.classList.toggle('active', FilesState.view === 'list');
  filesRenderContent();
}

function filesSearch(value) {
  FilesState.search = String(value || '').toLowerCase();
  filesRenderContent();
}

async function filesRefresh() {
  const content = document.getElementById('files-content');
  if (!content) return;
  if (!FilesState.bot) { filesRenderContent(); return; }
  FilesState.loading = true;
  content.innerHTML = `<div class="loader"><div class="spinner spinner-lg"></div></div>`;
  try {
    const data = await NexusAPI.files.list(FilesState.bot, FilesState.path);
    FilesState.entries = data.entries || [];
    FilesState.path = data.path || '';
    filesRenderBreadcrumb();
    filesRenderContent();
  } catch (e) {
    FilesState.loading = false;
    content.innerHTML = `<div class="files-error"><i class="ti ti-alert-circle"></i>${esc(e.message)}</div>`;
  }
}

function filesRenderBreadcrumb() {
  const bc = document.getElementById('files-breadcrumb');
  if (!bc) return;
  const parts = FilesState.path ? FilesState.path.split('/') : [];
  const crumbs = [`<button class="files-crumb" onclick="filesNavigate('')" ondragover="event.preventDefault()" ondrop="filesDropOnFolder(event, '')">${esc(filesT('filesPage.root'))}</button>`];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const target = acc;
    crumbs.push(`<i class="ti ti-chevron-right files-crumb-sep"></i><button class="files-crumb" onclick="filesNavigate('${escJs(target)}')" ondragover="event.preventDefault()" ondrop="filesDropOnFolder(event, '${escJs(target)}')">${esc(part)}</button>`);
  }
  bc.innerHTML = crumbs.join('');
}

function filesFilteredEntries() {
  const q = FilesState.search;
  return FilesState.entries.filter(e => !q || e.name.toLowerCase().includes(q));
}

function filesRenderContent() {
  const content = document.getElementById('files-content');
  if (!content) return;
  FilesState.loading = false;
  content.classList.remove('dragover');

  if (!FilesState.bot) return;
  const entries = filesFilteredEntries();
  if (!entries.length) {
    content.innerHTML = `<div class="empty-state files-empty">
      <i class="ti ti-folder-open"></i>
      <div class="empty-state-title">${esc(filesT('filesPage.emptyTitle'))}</div>
      <div class="empty-state-desc">${esc(filesT('filesPage.emptyDesc'))}</div>
      <button class="btn btn-primary btn-sm mt-8" onclick="document.getElementById('files-upload-input').click()"><i class="ti ti-upload"></i>${esc(filesT('filesPage.upload'))}</button>
    </div>`;
    return;
  }

  if (FilesState.view === 'list') {
    content.innerHTML = `<div class="files-table-wrap"><table class="data-tbl files-table">
      <thead><tr>
        <th>${esc(filesT('filesPage.name'))}</th>
        <th>${esc(filesT('filesPage.size'))}</th>
        <th>${esc(filesT('filesPage.modified'))}</th>
        <th class="files-actions-col">${esc(filesT('filesPage.actions'))}</th>
      </tr></thead>
      <tbody>${entries.map(e => filesRow(e)).join('')}</tbody>
    </table></div>`;
  } else {
    content.innerHTML = `<div class="files-grid">${entries.map(e => filesCard(e)).join('')}</div>`;
  }
}

function filesRow(e) {
  const isDir = e.type === 'dir';
  return `<tr class="files-row" draggable="true"
      ondragstart="filesDragStart(event, '${escJs(e.rel)}')"
      ondragend="filesDragEnd(event)"
      ${isDir ? `ondragover="event.preventDefault(); this.classList.add('drop-target')" ondragleave="this.classList.remove('drop-target')" ondrop="filesDropOnFolder(event, '${escJs(e.rel)}')"` : ''}>
    <td onclick="filesOpen('${escJs(e.rel)}','${escJs(e.type)}','${escJs(e.name)}')">
      <div class="files-name-cell">
        <i class="ti ${filesIcon(e.name, e.type)} files-icon ${isDir ? 'dir' : ''}"></i>
        <span class="files-name">${esc(e.name)}</span>
        ${e.hidden ? '<span class="files-hidden-badge">.</span>' : ''}
      </div>
    </td>
    <td class="td-mono">${isDir ? '—' : filesFmtSize(e.size)}</td>
    <td class="td-mono">${esc(filesFmtDate(e.mtime))}</td>
    <td class="files-actions" onclick="event.stopPropagation()"><div class="files-actions-inner">${filesActions(e)}</div></td>
  </tr>`;
}

function filesCard(e) {
  const isDir = e.type === 'dir';
  return `<div class="file-card" draggable="true"
      ondragstart="filesDragStart(event, '${escJs(e.rel)}')"
      ondragend="filesDragEnd(event)"
      ${isDir ? `ondragover="event.preventDefault(); this.classList.add('drop-target')" ondragleave="this.classList.remove('drop-target')" ondrop="filesDropOnFolder(event, '${escJs(e.rel)}')"` : ''}
      onclick="filesOpen('${escJs(e.rel)}','${escJs(e.type)}','${escJs(e.name)}')">
    ${isDir ? `<i class="ti ${filesIcon(e.name, e.type)} file-card-icon dir"></i>`
      : `<i class="ti ${filesIcon(e.name, e.type)} file-card-icon"></i>`}
    <div class="file-card-name" title="${esc(e.name)}">${esc(e.name)}</div>
    <div class="file-card-meta">${isDir ? esc(filesT('filesPage.folder')) : filesFmtSize(e.size)}</div>
    <div class="file-card-actions" onclick="event.stopPropagation()">${filesActions(e)}</div>
  </div>`;
}

function filesActions(e) {
  const openIcon = e.type === 'dir' ? 'ti-folder-open' : (filesIsText(e.name) ? 'ti-code' : 'ti-eye');
  const openTitle = e.type === 'dir' ? filesT('filesPage.open') : (filesIsText(e.name) ? filesT('filesPage.edit') : filesT('filesPage.preview'));
  return `<button class="act-btn" title="${esc(openTitle)}" onclick="filesOpen('${escJs(e.rel)}','${escJs(e.type)}','${escJs(e.name)}')"><i class="ti ${openIcon}"></i></button>
    <button class="act-btn" title="${esc(filesT('filesPage.download'))}" onclick="filesDownload('${escJs(e.rel)}','${escJs(e.name)}')"><i class="ti ti-download"></i></button>
    <button class="act-btn" title="${esc(filesT('filesPage.rename'))}" onclick="filesRename('${escJs(e.rel)}','${escJs(e.name)}')"><i class="ti ti-pencil"></i></button>
    <button class="act-btn act-danger" title="${esc(filesT('filesPage.delete'))}" onclick="filesDelete('${escJs(e.rel)}','${escJs(e.name)}')"><i class="ti ti-trash"></i></button>`;
}

function filesOpen(rel, type, name) {
  if (type === 'dir') return filesNavigate(rel);
  if (filesIsText(name)) {
    const entry = FilesState.entries.find(e => e.rel === rel);
    navigate('editor', {
      botName: FilesState.bot,
      filePath: entry?.absPath || rel,
      fileName: name
    });
    return;
  }
  if (filesIsImage(name)) return filesPreview(rel, name);
  filesDownload(rel, name);
}

function filesNavigate(path) {
  FilesState.path = path || '';
  FilesState.search = '';
  const search = document.getElementById('files-search');
  if (search) search.value = '';
  filesRefresh();
}

function filesDragStart(event, rel) {
  FilesState.drag = rel;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-nexus-file', rel);
  event.dataTransfer.setData('text/plain', rel);
  event.currentTarget.classList.add('dragging');
}

function filesDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
}

async function filesDrop(event) {
  event.preventDefault();
  const content = document.getElementById('files-content');
  if (content) content.classList.remove('dragover');
  if (!FilesState.bot) return;

  const files = Array.from(event.dataTransfer.files || []);
  if (files.length) return filesUploadFiles(files, FilesState.path);

  const rel = event.dataTransfer.getData('application/x-nexus-file')
    || event.dataTransfer.getData('text/plain');
  if (!rel) return;
  await filesMove(rel, FilesState.path);
}

async function filesDropOnFolder(event, targetDir) {
  event.preventDefault();
  event.stopPropagation();
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  if (!FilesState.bot) return;

  const files = Array.from(event.dataTransfer.files || []);
  if (files.length) return filesUploadFiles(files, targetDir);

  const rel = event.dataTransfer.getData('application/x-nexus-file')
    || event.dataTransfer.getData('text/plain');
  if (!rel) return;
  if (rel === targetDir) return;
  await filesMove(rel, targetDir);
}

async function filesMove(from, toDir) {
  try {
    const res = await NexusAPI.files.move(FilesState.bot, [{ from, toDir }]);
    if (res.errors && res.errors.length) {
      toast('error', filesT('filesPage.moveError'), res.errors[0].error);
    } else {
      toast('success', filesT('filesPage.moved'), filesT('filesPage.movedDesc'));
    }
    await filesRefresh();
  } catch (e) {
    toast('error', filesT('filesPage.moveError'), e.message);
  }
}

function filesUpload(input) {
  const files = Array.from(input.files || []);
  input.value = '';
  if (files.length) filesUploadFiles(files, FilesState.path);
}

async function filesUploadFiles(files, targetDir) {
  if (!FilesState.bot || !files.length) return;
  try {
    toast('info', filesT('filesPage.uploading'), filesT('filesPage.uploadingDesc', { n: files.length }));
    const res = await NexusAPI.files.upload(FilesState.bot, files, targetDir);
    const ok = (res.uploaded || []).length;
    if (ok) toast('success', filesT('filesPage.uploaded'), filesT('filesPage.uploadedDesc', { n: ok }));
    if (res.errors && res.errors.length) {
      toast('error', filesT('filesPage.uploadErrors'), res.errors.map(x => `${x.name}: ${x.error}`).slice(0, 3).join(' · '));
    }
    await filesRefresh();
  } catch (e) {
    toast('error', filesT('filesPage.uploadError'), e.message);
  }
}

function filesNewFolder() {
  if (!FilesState.bot) return;
  simpleModal(filesT('filesPage.newFolderTitle'), filesT('filesPage.folderName'), filesT('filesPage.folderPlaceholder'), async (name) => {
    try {
      await NexusAPI.files.create(FilesState.bot, name, 'dir', FilesState.path);
      toast('success', filesT('filesPage.folderCreated'), name);
      await filesRefresh();
    } catch (e) { toast('error', filesT('filesPage.createError'), e.message); }
  });
}

function filesNewFile() {
  if (!FilesState.bot) return;
  simpleModal(filesT('filesPage.newFileTitle'), filesT('filesPage.fileName'), filesT('filesPage.filePlaceholder'), async (name) => {
    try {
      await NexusAPI.files.create(FilesState.bot, name, 'file', FilesState.path);
      await filesRefresh();
      const entry = FilesState.entries.find(e => e.name === name);
      if (entry) filesOpen(entry.rel, 'file', entry.name);
    } catch (e) { toast('error', filesT('filesPage.createError'), e.message); }
  });
}

function filesRename(rel, name) {
  if (!FilesState.bot) return;
  simpleModal(filesT('filesPage.renameTitle'), filesT('filesPage.newName'), filesT('filesPage.newNamePlaceholder'), async (newName) => {
    if (newName === name) return;
    try {
      await NexusAPI.files.rename(FilesState.bot, rel, newName);
      toast('success', filesT('filesPage.renamed'), newName);
      await filesRefresh();
    } catch (e) { toast('error', filesT('filesPage.renameError'), e.message); }
  }, name);
}

function filesDelete(rel, name) {
  if (!FilesState.bot) return;
  confirm(filesT('filesPage.deleteTitle'), `<p>${esc(filesT('filesPage.deleteConfirm', { name }))}</p>`, async () => {
    try {
      await NexusAPI.files.delete(FilesState.bot, rel);
      toast('success', filesT('filesPage.deleted'), name);
      await filesRefresh();
    } catch (e) { toast('error', filesT('filesPage.deleteError'), e.message); }
  });
}

async function filesDownload(rel, name) {
  if (!FilesState.bot) return;
  try {
    const { blob, filename } = await NexusAPI.files.download(FilesState.bot, rel);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || name || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    toast('error', filesT('filesPage.downloadError'), e.message);
  }
}

async function filesPreview(rel, name) {
  if (!FilesState.bot) return;
  try {
    const { blob } = await NexusAPI.files.download(FilesState.bot, rel);
    const url = URL.createObjectURL(blob);
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal files-preview-modal">
      <div class="modal-header">
        <span class="modal-title"><i class="ti ti-photo"></i>${esc(name)}</span>
        <button class="btn-close" onclick="this.closest('.modal-overlay').remove(); URL.revokeObjectURL('${url}')"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body" style="text-align:center;background:var(--bg-base);">
        <img src="${url}" alt="${esc(name)}" style="max-width:100%;max-height:65vh;border-radius:8px;"/>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="filesDownload('${escJs(rel)}','${escJs(name)}')"><i class="ti ti-download"></i>${esc(filesT('filesPage.download'))}</button>
        <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove(); URL.revokeObjectURL('${url}')">${esc(filesT('common.close'))}</button>
      </div>
    </div>`;
    document.body.appendChild(ov);
  } catch (e) {
    toast('error', filesT('filesPage.downloadError'), e.message);
  }
}
