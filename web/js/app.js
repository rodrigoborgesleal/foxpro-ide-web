'use strict';

import { createApi, normalizeBaseUrl, ApiError } from './api.js';
import {
  loadSettings,
  saveSettings,
  loadSession,
  saveSession,
  clearSession,
  readEdits,
  writeEdits,
  readSnapshot,
  writeSnapshot,
  clearSnapshot,
  clearEdits,
} from './store.js';
import { initVfpLanguage, applyEditorTheme, createEditor } from './vfp-monaco.js';
import { createFormPreviewController } from './form-preview.js';
import { buildUnifiedExport, buildPartitionedExport } from './exporter.js';
import { createZipBlob } from './zip.js';

const CATEGORY_ORDER = ['main', 'programs', 'forms', 'classes', 'reports', 'menus', 'others'];

const CATEGORY_META = {
  main: { label: 'Programa Principal' },
  programs: { label: 'Programas' },
  forms: { label: 'Formulários' },
  classes: { label: 'Classes' },
  reports: { label: 'Relatórios' },
  menus: { label: 'Menus' },
  others: { label: 'Outros Arquivos' },
};

// Paleta de ícones alinhada às cores de sintaxe do tema Dark Modern.
const FILE_ICON = {
  prg: { glyph: 'ƒ', color: '#dcdcaa' },
  sc2: { glyph: '▣', color: '#4fc1ff' },
  vc2: { glyph: '◇', color: '#c586c0' },
  fr2: { glyph: '▤', color: '#73c991' },
  mn2: { glyph: '☰', color: '#f48771' },
  lb2: { glyph: '▦', color: '#d7ba7d' },
  pj2: { glyph: '▧', color: '#ce9178' },
  h: { glyph: '#', color: '#9cdcfe' },
  ini: { glyph: '⚙', color: '#9d9d9d' },
  txt: { glyph: '¶', color: '#9d9d9d' },
};

const state = {
  settings: loadSettings(),
  api: null,
  status: null,
  online: false,
  statusInFlight: false,
  workspace: null,
  files: new Map(),
  openPaths: [],
  activePath: '',
  collapsed: new Set(),
  filter: '',
  monaco: null,
  editor: null,
  models: new Map(),
  viewStates: new Map(),
  saving: false,
  compiling: false,
  importing: false,
  offlineWorkspace: false,
  recent: [],
  lastZipUrl: null,
  browserPath: '',
  editTimer: null,
  quotaWarned: false,
  formViewModes: new Map(),
  formPreview: null,
  formPreviewTimer: null,
};

const els = {
  app: document.getElementById('app'),
  sidebar: document.getElementById('sidebar'),
  activityExplorer: document.getElementById('activityExplorer'),
  tree: document.getElementById('tree'),
  treeEmpty: document.getElementById('treeEmpty'),
  treeFilter: document.getElementById('treeFilter'),
  projectName: document.getElementById('projectName'),
  projectPath: document.getElementById('projectPath'),
  fileCount: document.getElementById('fileCount'),
  modifiedCount: document.getElementById('modifiedCount'),
  tabs: document.getElementById('tabs'),
  breadcrumb: document.getElementById('breadcrumb'),
  editorViewbar: document.getElementById('editorViewbar'),
  viewCodeBtn: document.getElementById('viewCodeBtn'),
  viewPreviewBtn: document.getElementById('viewPreviewBtn'),
  editor: document.getElementById('editor'),
  formPreview: document.getElementById('formPreview'),
  formPreviewMeta: document.getElementById('formPreviewMeta'),
  formPreviewStage: document.getElementById('formPreviewStage'),
  formPreviewStatus: document.getElementById('formPreviewStatus'),
  formZoomLabel: document.getElementById('formZoomLabel'),
  formZoomIn: document.getElementById('formZoomIn'),
  formZoomOut: document.getElementById('formZoomOut'),
  formZoomFit: document.getElementById('formZoomFit'),
  formRefresh: document.getElementById('formRefresh'),
  welcome: document.getElementById('welcome'),
  welcomeStatus: document.getElementById('welcomeStatus'),
  welcomeImportBtn: document.getElementById('welcomeImportBtn'),
  welcomeSettingsBtn: document.getElementById('welcomeSettingsBtn'),
  recentProjects: document.getElementById('recentProjects'),
  recentList: document.getElementById('recentList'),
  serverPill: document.getElementById('serverPill'),
  serverDot: document.getElementById('serverDot'),
  serverLabel: document.getElementById('serverLabel'),
  settingsBtn: document.getElementById('settingsBtn'),
  importBtn: document.getElementById('importBtn'),
  compileSideBtn: document.getElementById('compileSideBtn'),
  offlineBanner: document.getElementById('offlineBanner'),
  statusServerBtn: document.getElementById('statusServerBtn'),
  statusDot: document.getElementById('statusDot'),
  statusServer: document.getElementById('statusServer'),
  statusProject: document.getElementById('statusProject'),
  statusModified: document.getElementById('statusModified'),
  statusMain: document.getElementById('statusMain'),
  statusPosition: document.getElementById('statusPosition'),
  statusVfp: document.getElementById('statusVfp'),
  importModal: document.getElementById('importModal'),
  projectPathInput: document.getElementById('projectPathInput'),
  browseBtn: document.getElementById('browseBtn'),
  browser: document.getElementById('browser'),
  browserPath: document.getElementById('browserPath'),
  browserList: document.getElementById('browserList'),
  browserUp: document.getElementById('browserUp'),
  doImportBtn: document.getElementById('doImportBtn'),
  importFeedback: document.getElementById('importFeedback'),
  importRecent: document.getElementById('importRecent'),
  importRecentList: document.getElementById('importRecentList'),
  settingsModal: document.getElementById('settingsModal'),
  serverUrlInput: document.getElementById('serverUrlInput'),
  testServerBtn: document.getElementById('testServerBtn'),
  testServerResult: document.getElementById('testServerResult'),
  serverDetail: document.getElementById('serverDetail'),
  settingsFeedback: document.getElementById('settingsFeedback'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  compileModal: document.getElementById('compileModal'),
  compileSummary: document.getElementById('compileSummary'),
  compileList: document.getElementById('compileList'),
  compileWarnings: document.getElementById('compileWarnings'),
  compileDownloadBtn: document.getElementById('compileDownloadBtn'),
  aboutModal: document.getElementById('aboutModal'),
  aboutBody: document.getElementById('aboutBody'),
  exportHelpModal: document.getElementById('exportHelpModal'),
  exportHelpCode: document.getElementById('exportHelpCode'),
  logsModal: document.getElementById('logsModal'),
  logsContent: document.getElementById('logsContent'),
  logsFile: document.getElementById('logsFile'),
  refreshLogsBtn: document.getElementById('refreshLogsBtn'),
  overlay: document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlayTitle'),
  overlayText: document.getElementById('overlayText'),
  toasts: document.getElementById('toasts'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return String(value);
  }
}

function baseName(file) {
  return String(file || '').split(/[\\/]/).pop() || '';
}

function fileEntry(path) {
  return state.files.get(path);
}

function isFormFile(fileOrPath) {
  const file =
    typeof fileOrPath === 'string'
      ? fileEntry(fileOrPath)
      : fileOrPath && typeof fileOrPath === 'object'
        ? fileOrPath
        : null;
  if (!file) return false;
  return String(file.ext || '').toLowerCase() === 'sc2' || /\.sc2$/i.test(file.path || '');
}

function formViewMode(path = state.activePath) {
  return state.formViewModes.get(path) === 'preview' ? 'preview' : 'code';
}

function isFormPreviewVisible() {
  return Boolean(state.activePath && isFormFile(state.activePath) && formViewMode() === 'preview');
}

function formClassFiles() {
  return Array.from(state.files.values())
    .filter((file) => /\.vc2$/i.test(file.path || ''))
    .map((file) => ({ path: file.path, content: file.content }));
}

function renderFormPreview(options = {}) {
  if (!state.formPreview) return;
  const file = fileEntry(state.activePath);
  if (!isFormFile(file)) {
    state.formPreview.clear();
    return;
  }
  state.formPreview.render({
    content: file.content,
    files: formClassFiles(),
    path: file.path,
    fit: options.fit !== false,
  });
}

function scheduleFormPreviewRefresh() {
  if (!isFormPreviewVisible()) return;
  if (state.formPreviewTimer) clearTimeout(state.formPreviewTimer);
  state.formPreviewTimer = setTimeout(() => {
    state.formPreviewTimer = null;
    if (isFormPreviewVisible()) renderFormPreview({ fit: false });
  }, 160);
}

function applyActiveView(options = {}) {
  const isForm = isFormFile(state.activePath);
  els.editorViewbar.hidden = !isForm;

  if (!isForm) {
    els.formPreview.hidden = true;
    els.editor.hidden = false;
    if (state.formPreview) state.formPreview.clear();
    if (state.editor) {
      if (options.focus !== false) state.editor.focus();
      setTimeout(() => state.editor.layout(), 0);
    }
    updatePosition();
    return;
  }

  const preview = formViewMode() === 'preview';
  els.viewCodeBtn.classList.toggle('is-active', !preview);
  els.viewPreviewBtn.classList.toggle('is-active', preview);
  els.viewCodeBtn.setAttribute('aria-selected', String(!preview));
  els.viewPreviewBtn.setAttribute('aria-selected', String(preview));
  els.editor.hidden = preview;
  els.formPreview.hidden = !preview;

  if (preview) {
    els.statusPosition.hidden = true;
    renderFormPreview({ fit: true });
    return;
  }

  if (state.formPreview) state.formPreview.clear();
  if (state.editor) {
    if (options.focus !== false) state.editor.focus();
    setTimeout(() => state.editor.layout(), 0);
  }
  updatePosition();
}

function setFormView(mode) {
  if (!isFormFile(state.activePath)) return;
  const next = mode === 'preview' ? 'preview' : 'code';
  state.formViewModes.set(state.activePath, next);
  applyActiveView({ focus: next === 'code' });
}

function dirtyFiles() {
  return Array.from(state.files.values()).filter((file) => file.dirty);
}

/**
 * M (estilo Git): o texto difere da última compilação bem-sucedida (ou da
 * importação). Salvar no workspace não remove o marcador; compilar remove.
 */
function isModified(file) {
  if (!file) return false;
  return file.pendingCompile === true || file.content !== file.baseContent;
}

function modifiedFiles() {
  return Array.from(state.files.values()).filter(isModified);
}

function primaryCategoryLabel(category) {
  return (CATEGORY_META[category] && CATEGORY_META[category].label) || 'Outros Arquivos';
}

function toast(message, type = 'info', ttl = 6000) {
  const item = document.createElement('div');
  item.className = `toast${type && type !== 'info' ? ` ${type}` : ''}`;
  const icons = {
    error:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16 9.4"/></svg>',
    warn:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17.2v.1"/></svg>',
    info:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.1"/></svg>',
  };
  item.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-message">${escapeHtml(message)}</span>`;
  els.toasts.appendChild(item);
  const timer = setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateX(10px)';
    item.style.transition = 'opacity .18s ease, transform .18s ease';
    setTimeout(() => item.remove(), 220);
  }, ttl);
  item.addEventListener('click', () => {
    clearTimeout(timer);
    item.remove();
  });
}

function showOverlay(title, text) {
  els.overlayTitle.textContent = title;
  els.overlayText.textContent = text || '';
  els.overlay.hidden = false;
}

function hideOverlay() {
  els.overlay.hidden = true;
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.hidden = false;
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.hidden = true;
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.hidden = true;
  });
}

/* ------------------------------------------------------------------ */
/* Servidor / status                                                   */
/* ------------------------------------------------------------------ */

function applySidebarVisibility() {
  const hidden = state.settings.sidebarHidden === true;
  els.app.classList.toggle('sidebar-hidden', hidden);
  if (els.activityExplorer) {
    els.activityExplorer.classList.toggle('active', !hidden);
    els.activityExplorer.setAttribute('aria-pressed', String(!hidden));
  }
}

function renderServer() {
  const online = state.online;
  els.serverPill.classList.toggle('online', online);
  els.serverPill.classList.toggle('offline', !online);
  els.serverDot.className = `dot ${online ? 'online' : 'offline'}`;
  els.statusDot.className = `dot ${online ? 'online' : 'offline'}`;
  els.serverLabel.textContent = online ? 'Online' : 'Offline';
  els.statusServer.textContent = online
    ? `Online · ${state.settings.baseUrl.replace(/^https?:\/\//, '')}`
    : 'Offline';

  if (online && state.status) {
    const vfp = state.status.vfp || {};
    els.statusVfp.textContent = vfp.found ? 'VFP ok' : 'VFP ausente';
    els.statusVfp.title = vfp.found ? vfp.path : 'vfp9.exe não encontrado nas configurações do servidor';
  } else {
    els.statusVfp.textContent = 'VFP —';
    els.statusVfp.title = 'Servidor offline';
  }

  els.offlineBanner.hidden = online || !state.workspace;
  renderWelcomeStatus();
  if (!els.settingsModal.hidden) renderServerDetail();
}

function renderWelcomeStatus() {
  if (!els.welcomeStatus) return;
  if (!state.online) {
    els.welcomeStatus.innerHTML = `<span class="bad">● Servidor offline</span> — inicie o FoxPro IDE Web pelo ícone da bandeja. <button class="btn tiny ghost" id="retryConnectBtn" type="button">Tentar novamente</button>`;
    const retry = document.getElementById('retryConnectBtn');
    if (retry) {
      retry.addEventListener('click', async () => {
        els.welcomeStatus.textContent = 'Verificando…';
        await refreshStatus();
        if (state.online) {
          await loadRecent();
          const session = loadSession();
          if (session && session.workspaceId && !state.workspace) {
            loadWorkspaceById(session.workspaceId, { silent: true }).catch(() => {});
          }
        }
      });
    }
    return;
  }

  const status = state.status || {};
  const vfp = status.vfp || {};
  const fb = status.foxbin2prg || {};
  const vfpText = vfp.found ? `VFP: ${escapeHtml(baseName(vfp.path))}` : 'VFP não encontrado';
  els.welcomeStatus.innerHTML = `<span class="ok">● Online</span> em ${escapeHtml(
    state.settings.baseUrl,
  )} · ${escapeHtml(vfpText)} · FoxBin2Prg ${escapeHtml(fb.version || '—')}`;
}

async function refreshStatus(options = {}) {
  if (state.statusInFlight) return;
  state.statusInFlight = true;
  const wasOnline = state.online;
  try {
    const status = await state.api.status();
    state.status = status;
    state.online = true;
    if (!wasOnline && state.initialized && !options.silent) {
      toast('Servidor local reconectado.', 'ok');
      loadRecent().catch(() => {});
    }
    renderServer();
  } catch {
    state.online = false;
    state.status = null;
    if (wasOnline && !options.silent) {
      toast('Servidor local offline. As edições continuam salvas no navegador.', 'warn');
    }
    renderServer();
  } finally {
    state.statusInFlight = false;
    state.initialized = true;
  }
}

function renderServerDetail() {
  const status = state.status;
  if (!status) {
    els.serverDetail.innerHTML = '<span>Servidor offline — não foi possível obter os detalhes.</span>';
    return;
  }
  const vfp = status.vfp || {};
  const fb = status.foxbin2prg || {};
  els.serverDetail.innerHTML = `
    <span>Versão: <b>${escapeHtml(status.version || '—')}</b> · Serviço: <b>${escapeHtml(
      status.service || 'foxpro-ide-web',
    )}</b></span>
    <span>VFP: <code>${escapeHtml(vfp.found ? vfp.path : 'não encontrado')}</code></span>
    <span>FoxBin2Prg: <b>${escapeHtml(fb.version || '—')}</b> · disponível: <b>${
      fb.available ? 'sim' : 'não'
    }</b>${fb.patchedForVfp9Rtm ? ' · patch VFP9 RTM ativo' : ''}</span>
    <span>Workspaces: <b>${escapeHtml(String(status.workspaces ?? 0))}</b> · Ocupado: <b>${
      status.busy ? 'sim' : 'não'
    }</b></span>
    <span>Configuração: <code>${escapeHtml(status.configFile || '—')}</code></span>
  `;
}

/* ------------------------------------------------------------------ */
/* Workspace / editor                                                  */
/* ------------------------------------------------------------------ */

function disposeModels() {
  if (state.editor) {
    try {
      state.editor.setModel(null);
    } catch {
      /* melhor esforço */
    }
  }
  for (const model of state.models.values()) {
    try {
      model.dispose();
    } catch {
      /* melhor esforço */
    }
  }
  state.models.clear();
  state.viewStates.clear();
}

function resetWorkspace() {
  disposeModels();
  state.workspace = null;
  state.files.clear();
  state.openPaths = [];
  state.activePath = '';
  state.offlineWorkspace = false;
  state.lastZipUrl = null;
  state.formViewModes.clear();
  if (state.formPreviewTimer) {
    clearTimeout(state.formPreviewTimer);
    state.formPreviewTimer = null;
  }
  if (state.formPreview) state.formPreview.clear();
  els.tabs.innerHTML = '';
  els.breadcrumb.hidden = true;
  els.breadcrumb.innerHTML = '';
  els.editor.hidden = true;
  els.formPreview.hidden = true;
  els.editorViewbar.hidden = true;
  els.statusPosition.hidden = true;
  els.welcome.hidden = false;
  els.offlineBanner.hidden = true;
  document.title = 'FoxPro IDE Web';
  renderTree();
  updateSummaries();
}

function applyWorkspace(workspace, files, options = {}) {
  disposeModels();
  state.workspace = workspace;
  state.files.clear();
  state.openPaths = [];
  state.activePath = '';
  state.offlineWorkspace = options.offline === true;
  state.lastZipUrl = null;
  state.formViewModes.clear();
  if (state.formPreviewTimer) {
    clearTimeout(state.formPreviewTimer);
    state.formPreviewTimer = null;
  }
  if (state.formPreview) state.formPreview.clear();

  for (const file of files || []) {
    const content = String(file.content ?? '');
    state.files.set(file.path, {
      ...file,
      content,
      baseContent: typeof file.baseContent === 'string' ? file.baseContent : content,
      savedContent: content,
      pendingCompile: file.changed === true,
      dirty: false,
    });
  }

  // Sobrepõe edições locais não salvas (resiliência a recarregar a página).
  const edits = readEdits(workspace.id);
  let restoredEdits = 0;
  for (const [path, content] of Object.entries(edits)) {
    const file = state.files.get(path);
    if (!file) continue;
    if (typeof content === 'string' && content !== file.savedContent) {
      file.content = content;
      file.dirty = true;
      restoredEdits += 1;
    }
  }

  const allowed = new Set(state.files.keys());
  const requested = (options.openPaths || []).filter((path) => allowed.has(path));
  const active = options.activePath && allowed.has(options.activePath) ? options.activePath : '';
  const mainPath = workspace.mainFile && allowed.has(workspace.mainFile) ? workspace.mainFile : '';
  const first = Array.from(state.files.keys())[0] || '';

  state.openPaths = requested.length
    ? requested
    : [mainPath || active || first].filter(Boolean);
  if (active && !state.openPaths.includes(active)) state.openPaths.push(active);
  state.activePath = active || state.openPaths[0] || '';

  for (const path of state.openPaths) ensureModel(path);

  els.projectName.textContent = workspace.name || 'Projeto';
  els.projectPath.textContent = workspace.projectPath || '';
  els.projectPath.title = workspace.projectPath || '';
  document.title = `${workspace.name || 'Projeto'} — FoxPro IDE Web`;

  els.welcome.hidden = true;
  els.editor.hidden = false;
  els.offlineBanner.hidden = state.online || !state.offlineWorkspace;

  renderTree();
  updateSummaries();

  if (state.activePath) {
    openFile(state.activePath, { focus: false, addToOpen: false });
  } else {
    els.editor.hidden = true;
    els.welcome.hidden = false;
    els.breadcrumb.hidden = true;
  }

  if (state.editor) setTimeout(() => state.editor.layout(), 30);

  persistSession();
  persistSnapshot();

  if (restoredEdits > 0) {
    toast(
      `${restoredEdits} arquivo(s) com edições locais restauradas do navegador.`,
      'info',
    );
  }
  const warnings = (workspace && workspace.warnings) || [];
  if (warnings.length) {
    toast(
      `${warnings.length} aviso(s) na importação: ${warnings[0]}${
        warnings.length > 1 ? '…' : ''
      }`,
      'warn',
      9000,
    );
  }
}

function ensureModel(path) {
  if (state.models.has(path)) return state.models.get(path);
  const file = fileEntry(path);
  if (!file) return null;
  const uri = state.monaco.Uri.from({
    scheme: 'fpiw',
    authority: state.workspace ? state.workspace.id : 'local',
    path: `/${String(path).replace(/\\/g, '/')}`,
  });
  const model = state.monaco.editor.createModel(file.content, 'foxpro', uri);
  state.models.set(path, model);
  return model;
}

function saveViewState() {
  if (!state.editor || !state.activePath) return;
  const view = state.editor.saveViewState();
  if (view) state.viewStates.set(state.activePath, view);
}

function openFile(path, options = {}) {
  const file = fileEntry(path);
  if (!file) return;
  if (options.addToOpen !== false && !state.openPaths.includes(path)) {
    state.openPaths.push(path);
  }
  if (state.activePath !== path) saveViewState();

  const model = ensureModel(path);
  if (!model) return;

  state.activePath = path;
  if (state.editor) {
    state.editor.setModel(model);
    const view = state.viewStates.get(path);
    if (view) {
      try {
        state.editor.restoreViewState(view);
      } catch {
        /* melhor esforço */
      }
    }
  }

  els.welcome.hidden = true;
  els.offlineBanner.hidden = state.online || !state.offlineWorkspace;
  applyActiveView({ focus: options.focus !== false });
  renderTabs();
  renderTree();
  renderBreadcrumb();
  updateSummaries();
  persistSession();
  if (state.editor) setTimeout(() => state.editor.layout(), 0);
}

function closeTab(path) {
  const index = state.openPaths.indexOf(path);
  if (index < 0) return;
  const wasActive = state.activePath === path;
  saveViewState();
  state.openPaths.splice(index, 1);
  state.formViewModes.delete(path);

  const model = state.models.get(path);
  if (model) {
    try {
      model.dispose();
    } catch {
      /* melhor esforço */
    }
    state.models.delete(path);
  }
  state.viewStates.delete(path);

  if (wasActive) {
    const next = state.openPaths[index] || state.openPaths[index - 1] || '';
    state.activePath = '';
    if (next) {
      openFile(next, { focus: false });
    } else {
      state.activePath = '';
      if (state.editor) state.editor.setModel(null);
      els.editor.hidden = true;
      els.formPreview.hidden = true;
      els.editorViewbar.hidden = true;
      els.statusPosition.hidden = true;
      if (state.formPreview) state.formPreview.clear();
      els.welcome.hidden = false;
      els.breadcrumb.hidden = true;
      els.breadcrumb.innerHTML = '';
      renderTabs();
      renderTree();
      updateSummaries();
      persistSession();
    }
  } else {
    renderTabs();
    renderTree();
  }
}

function closeAllTabs() {
  const paths = [...state.openPaths];
  for (const path of paths) closeTab(path);
  toast('Todas as abas foram fechadas.', 'info', 3000);
}

function renderTabs() {
  els.tabs.innerHTML = '';
  for (const path of state.openPaths) {
    const file = fileEntry(path);
    if (!file) continue;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `tab${path === state.activePath ? ' active' : ''}${
      isModified(file) ? ' is-modified' : ''
    }${file.dirty ? ' is-unsaved' : ''}`;
    tab.dataset.tabPath = path;
    tab.title = path;
    tab.innerHTML = `<span class="tab-name">${escapeHtml(file.name || baseName(path))}</span>
      <span class="dirty" title="Modificado desde a última compilação">M</span>
      <span class="unsaved-dot" title="Alterações não salvas"></span>
      <span class="tab-close" role="button" aria-label="Fechar">×</span>`;
    tab.addEventListener('click', (event) => {
      if (event.target.closest('.tab-close')) {
        event.stopPropagation();
        closeTab(path);
        return;
      }
      openFile(path);
    });
    tab.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        closeTab(path);
      }
    });
    els.tabs.appendChild(tab);
  }
}

function renderBreadcrumb() {
  if (!state.activePath) {
    els.breadcrumb.hidden = true;
    return;
  }
  const file = fileEntry(state.activePath);
  if (!file) {
    els.breadcrumb.hidden = true;
    return;
  }
  const parts = String(file.path).split('/');
  const html = [
    `<span>${escapeHtml(primaryCategoryLabel(file.category))}</span>`,
    ...parts.map((part, index) =>
      index === parts.length - 1
        ? `<b>${escapeHtml(part)}</b>`
        : `<span>${escapeHtml(part)}</span><span>›</span>`,
    ),
  ];
  els.breadcrumb.innerHTML = html.join(' ');
  els.breadcrumb.hidden = false;
}

function renderTree() {
  els.tree.querySelectorAll('.tree-group').forEach((node) => node.remove());
  const groups = new Map(CATEGORY_ORDER.map((id) => [id, []]));
  const filter = state.filter.trim().toLowerCase();

  for (const file of state.files.values()) {
    if (filter && !`${file.path} ${file.name}`.toLowerCase().includes(filter)) continue;
    const category = groups.has(file.category) ? file.category : 'others';
    groups.get(category).push(file);
  }
  for (const list of groups.values()) {
    list.sort((a, b) =>
      String(a.path).localeCompare(String(b.path), 'pt-BR', { sensitivity: 'base' }),
    );
  }

  const total = Array.from(groups.values()).reduce((sum, list) => sum + list.length, 0);
  els.treeEmpty.hidden = total > 0 || Boolean(filter);

  for (const category of CATEGORY_ORDER) {
    const list = groups.get(category);
    if (!list.length) continue;
    const meta = CATEGORY_META[category];
    const collapsed = state.collapsed.has(category);

    const group = document.createElement('div');
    group.className = `tree-group${collapsed ? ' collapsed' : ''}`;
    group.dataset.category = category;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'tree-group-head';
    head.innerHTML = `<span class="tree-caret" aria-hidden="true"></span>
      <span class="tree-label">${escapeHtml(meta.label)}</span>
      <span class="tree-count">${list.length}</span>`;

    const items = document.createElement('div');
    items.className = 'tree-items';
    for (const file of list) {
      const icon = FILE_ICON[file.ext] || { glyph: '•', color: '#9d9d9d' };
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `tree-item${file.path === state.activePath ? ' active' : ''}${
        isModified(file) ? ' is-modified' : ''
      }`;
      item.dataset.treePath = file.path;
      item.title = file.path;
      item.innerHTML = `<span class="file-icon" style="color:${icon.color}">${icon.glyph}</span>
        <span class="file-name">${escapeHtml(file.name)}</span>
        <span class="dirty" title="Modificado desde a última compilação">M</span>`;
      item.addEventListener('click', () => openFile(file.path));
      items.appendChild(item);
    }

    head.addEventListener('click', () => {
      if (state.collapsed.has(category)) state.collapsed.delete(category);
      else state.collapsed.add(category);
      group.classList.toggle('collapsed');
    });

    group.appendChild(head);
    group.appendChild(items);
    els.tree.appendChild(group);
  }

  if (filter && total === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.innerHTML = `<div class="tree-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>
      </div><p>Nenhum arquivo corresponde a “${escapeHtml(state.filter)}”.</p>`;
    els.tree.appendChild(empty);
  }
}

function updateSummaries() {
  const files = Array.from(state.files.values());
  const modified = files.filter(isModified).length;
  const unsaved = files.filter((file) => file.dirty).length;
  els.fileCount.textContent = `${files.length} arquivo${files.length === 1 ? '' : 's'}`;
  els.modifiedCount.textContent = `${modified} modificado${modified === 1 ? '' : 's'}`;
  els.statusModified.textContent = unsaved
    ? `${modified} modificado${modified === 1 ? '' : 's'} · ${unsaved} não salvo${
        unsaved === 1 ? '' : 's'
      }`
    : `${modified} modificado${modified === 1 ? '' : 's'}`;
  els.statusProject.textContent = state.workspace ? state.workspace.name : 'Sem projeto';
  els.statusMain.hidden = !(state.workspace && state.workspace.mainFile);
  els.statusMain.textContent = state.workspace && state.workspace.mainFile
    ? `Main: ${state.workspace.mainFile}`
    : '';

  document.querySelectorAll('.tab[data-tab-path]').forEach((tab) => {
    const file = fileEntry(tab.dataset.tabPath);
    tab.classList.toggle('is-modified', isModified(file));
    tab.classList.toggle('is-unsaved', Boolean(file && file.dirty));
  });
  document.querySelectorAll('.tree-item[data-tree-path]').forEach((item) => {
    const file = fileEntry(item.dataset.treePath);
    item.classList.toggle('is-modified', isModified(file));
    item.classList.toggle(
      'active',
      item.dataset.treePath === state.activePath,
    );
  });
}

function updatePosition() {
  if (!state.editor) return;
  const position = state.editor.getPosition();
  els.statusPosition.hidden = !position || !state.activePath;
  if (position) {
    els.statusPosition.textContent = `Ln ${position.lineNumber}, Col ${position.column}`;
  }
}

/* ------------------------------------------------------------------ */
/* Edição / persistência                                               */
/* ------------------------------------------------------------------ */

function syncActiveFile() {
  if (!state.editor || !state.activePath) return;
  const file = fileEntry(state.activePath);
  const model = state.editor.getModel();
  if (!file || !model) return;
  const content = model.getValue();
  if (file.content === content) return;
  file.content = content;
  file.dirty = content !== file.savedContent;
  updateSummaries();
  scheduleEditPersist();
  scheduleFormPreviewRefresh();
}

function scheduleEditPersist() {
  if (state.editTimer) clearTimeout(state.editTimer);
  state.editTimer = setTimeout(() => persistEditsNow(), 350);
}

function persistEditsNow() {
  if (!state.workspace) return;
  const edits = {};
  for (const file of state.files.values()) {
    if (file.dirty) edits[file.path] = file.content;
  }
  const ok = writeEdits(state.workspace.id, edits);
  if (!ok && !state.quotaWarned) {
    state.quotaWarned = true;
    toast(
      'O LocalStorage está cheio. As edições continuam na memória; salve no servidor para não perder.',
      'warn',
      10000,
    );
  }
}

function persistSession() {
  if (!state.workspace) {
    saveSession({ workspaceId: '', openPaths: [], activePath: '' });
    return;
  }
  saveSession({
    workspaceId: state.workspace.id,
    openPaths: state.openPaths,
    activePath: state.activePath,
  });
}

function persistSnapshot() {
  if (!state.workspace) return;
  const files = Array.from(state.files.values()).map((file) => ({
    path: file.path,
    name: file.name,
    ext: file.ext,
    type: file.type,
    category: file.category,
    bytes: file.bytes,
    modified: file.modified,
    changed: file.pendingCompile === true,
    // Só duplica o texto quando o arquivo realmente difere da referência.
    baseContent: file.content === file.baseContent ? undefined : file.baseContent,
    content: file.content,
  }));
  writeSnapshot(state.workspace.id, {
    workspace: state.workspace,
    files,
  });
}

async function saveWorkspace(options = {}) {
  if (state.saving) return;
  if (!state.workspace) {
    if (!options.silent) toast('Nenhum projeto aberto para salvar.', 'warn');
    return;
  }
  const dirty = dirtyFiles();
  if (!dirty.length) {
    if (!options.silent) toast('Nenhuma alteração pendente.', 'info', 3000);
    return;
  }
  if (!state.online) {
    persistEditsNow();
    if (!options.silent) {
      toast('Servidor offline: as alterações foram salvas no navegador.', 'warn');
    }
    return;
  }

  state.saving = true;
  showOverlay('Salvando alterações…', `${dirty.length} arquivo(s) serão gravados no workspace.`);
  try {
    const payload = dirty.map((file) => ({ path: file.path, content: file.content }));
    const sent = new Map(payload.map((entry) => [entry.path.toLowerCase(), entry.content]));
    const result = await state.api.save(state.workspace.id, payload);
    const savedList = Array.isArray(result.files) ? result.files : null;
    for (const file of dirty) {
      const saved = savedList
        ? savedList.some(
            (entry) => String(entry.path).toLowerCase() === file.path.toLowerCase(),
          )
        : true;
      if (!saved) continue;
      const sentContent = sent.get(file.path.toLowerCase());
      if (typeof sentContent !== 'string') continue;
      // O arquivo salvo passa a ser a referência de "não salvo", mas o
      // marcador M continua (só sai com compilação bem-sucedida).
      file.savedContent = sentContent;
      file.dirty = file.content !== sentContent;
    }
    persistEditsNow();
    persistSnapshot();
    renderTabs();
    renderTree();
    updateSummaries();
    if (result.errors && result.errors.length) {
      toast(
        `Alguns arquivos não foram salvos: ${result.errors
          .map((error) => error.error)
          .join(' | ')}`,
        'error',
        9000,
      );
    } else if (!options.silent) {
      toast(`${result.saved ?? dirty.length} arquivo(s) salvos no servidor.`, 'ok');
    }
  } catch (error) {
    toast(error.message || 'Falha ao salvar.', 'error');
  } finally {
    state.saving = false;
    hideOverlay();
  }
}

/* ------------------------------------------------------------------ */
/* Importação                                                          */
/* ------------------------------------------------------------------ */

function renderRecentList(container, list, options = {}) {
  container.innerHTML = '';
  for (const item of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';
    button.innerHTML = `<span class="recent-item-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.8A1.8 1.8 0 0 1 3.3 2h2.9l1.5 1.6h5A1.8 1.8 0 0 1 14.5 5.4v6.8a1.8 1.8 0 0 1-1.8 1.8H3.3a1.8 1.8 0 0 1-1.8-1.8V3.8Z"/></svg>
      </span>
      <span class="recent-item-body">
        <span class="recent-item-name">${escapeHtml(item.name)}</span>
        <span class="recent-item-path">${escapeHtml(item.projectPath || '')}</span>
      </span>
      <span class="recent-item-meta">${escapeHtml(
        `${item.fileCount || 0} arq. · ${formatDate(item.updatedAt)}`,
      )}</span>`;
    button.addEventListener('click', () => {
      closeAllModals();
      loadWorkspaceById(item.id).catch((error) => {
        toast(error.message || 'Falha ao abrir o workspace.', 'error');
      });
    });
    container.appendChild(button);
    if (options.limit && container.children.length >= options.limit) break;
  }
}

async function loadRecent() {
  if (!state.online) {
    state.recent = [];
    els.recentProjects.hidden = true;
    els.importRecent.hidden = true;
    return;
  }
  try {
    const result = await state.api.listWorkspaces();
    state.recent = result.workspaces || [];
    els.recentProjects.hidden = state.recent.length === 0;
    els.recentList.innerHTML = '';
    renderRecentList(els.recentList, state.recent, { limit: 5 });
    els.importRecent.hidden = state.recent.length === 0;
    els.importRecentList.innerHTML = '';
    renderRecentList(els.importRecentList, state.recent, { limit: 6 });
  } catch {
    state.recent = [];
    els.recentProjects.hidden = true;
    els.importRecent.hidden = true;
  }
}

function openImportModal() {
  openModal('importModal');
  const input = els.projectPathInput;
  input.value = state.settings.lastProjectPath || '';
  els.importFeedback.textContent = '';
  els.importFeedback.className = 'modal-feedback';
  els.browser.hidden = true;
  state.browserPath = '';
  loadRecent().catch(() => {});
  setTimeout(() => input.focus(), 30);
}

async function loadBrowser(path) {
  els.browser.hidden = false;
  els.browserList.innerHTML = '<div class="browser-empty">Carregando…</div>';
  try {
    const result = await state.api.fsList(path || '');
    state.browserPath = result.path || '';
    els.browserPath.textContent = result.path || 'Unidades e pastas';
    els.browserUp.disabled = !result.parent && !result.path;
    els.browserList.innerHTML = '';

    const roots = result.roots || [];
    for (const root of roots) {
      addBrowserItem(root.name, root.path, 'dir');
    }
    for (const dir of result.dirs || []) {
      addBrowserItem(dir.name, dir.path, 'dir');
    }
    for (const file of result.files || []) {
      addBrowserItem(file.name, file.path, 'file');
    }
    if (!els.browserList.children.length) {
      els.browserList.innerHTML = '<div class="browser-empty">Nenhuma pasta ou .pjx aqui.</div>';
    }
  } catch (error) {
    els.browserList.innerHTML = `<div class="browser-empty">${escapeHtml(
      error.message || 'Falha ao listar a pasta.',
    )}</div>`;
  }
}

function addBrowserItem(name, path, type) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'browser-item';
  item.dataset.path = path;
  item.dataset.kind = type;
  const icon =
    type === 'dir'
      ? '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.8A1.8 1.8 0 0 1 3.3 2h2.9l1.5 1.6h5A1.8 1.8 0 0 1 14.5 5.4v6.8a1.8 1.8 0 0 1-1.8 1.8H3.3a1.8 1.8 0 0 1-1.8-1.8V3.8Z"/></svg>'
      : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 1.8h5L13 5.6v8.6H4V1.8Z"/><path d="M9 1.8v3.8h4"/></svg>';
  item.innerHTML = `<span class="bi-icon">${icon}</span><span class="bi-name">${escapeHtml(name)}</span>`;
  if (type === 'file') {
    const selected = normalizePath(els.projectPathInput.value) === normalizePath(path);
    if (selected) item.classList.add('selected');
  }
  item.addEventListener('click', () => {
    if (type === 'file') {
      els.projectPathInput.value = path;
      state.settings = saveSettings({ lastProjectPath: path });
      els.browserList.querySelectorAll('.browser-item').forEach((node) => {
        node.classList.toggle('selected', node === item);
      });
      els.importFeedback.textContent = '';
      els.importFeedback.className = 'modal-feedback';
    } else {
      loadBrowser(path);
    }
  });
  els.browserList.appendChild(item);
}

function normalizePath(value) {
  return String(value || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

async function doImport() {
  if (state.importing) return;
  const path = els.projectPathInput.value.trim();
  if (!path) {
    els.importFeedback.textContent = 'Informe o caminho do arquivo .pjx.';
    els.importFeedback.className = 'modal-feedback error';
    return;
  }
  if (!/\.(pjx|pjt)$/i.test(path)) {
    els.importFeedback.textContent = 'Selecione um arquivo .pjx (ou .pjt do mesmo projeto).';
    els.importFeedback.className = 'modal-feedback error';
    return;
  }
  if (!state.online) {
    els.importFeedback.textContent =
      'Servidor offline. Inicie o FoxPro IDE Web e clique em "Tentar novamente".';
    els.importFeedback.className = 'modal-feedback error';
    return;
  }

  state.importing = true;
  els.doImportBtn.disabled = true;
  closeModal('importModal');
  showOverlay(
    'Importando e descompilando…',
    'O FoxBin2Prg está convertendo os binários do projeto em textos editáveis. ' +
      'Projetos grandes podem levar alguns segundos.',
  );
  try {
    const result = await state.api.importProject(path);
    state.settings = saveSettings({ lastProjectPath: path });
    applyWorkspace(result.workspace, result.files, {});
    await loadRecent();
    toast(
      `Projeto importado: ${(result.files || []).length} arquivo(s) de código.`,
      'ok',
    );
  } catch (error) {
    els.importFeedback.textContent = error.message || 'Falha ao importar o projeto.';
    els.importFeedback.className = 'modal-feedback error';
    openModal('importModal');
    toast(error.message || 'Falha ao importar o projeto.', 'error', 9000);
  } finally {
    state.importing = false;
    els.doImportBtn.disabled = false;
    hideOverlay();
  }
}

function isMissingWorkspaceError(error) {
  if (!(error instanceof ApiError)) return false;
  return (
    error.code === 'WORKSPACE_NOT_FOUND' ||
    error.status === 404 ||
    (error.status === 400 && /workspace|projeto/i.test(error.message || ''))
  );
}

async function loadWorkspaceById(id, options = {}) {
  if (!id) return;
  if (!state.online) {
    const snapshot = readSnapshot(id);
    if (snapshot) {
      applyWorkspace(snapshot.workspace, snapshot.files, { offline: true });
      toast('Servidor offline: projeto carregado da cópia local.', 'warn');
      return;
    }
    throw new Error('Servidor offline e sem cópia local deste projeto.');
  }

  if (!options.silent) showOverlay('Abrindo projeto…', 'Carregando os textos do workspace.');
  try {
    const result = await state.api.loadWorkspace(id);
    applyWorkspace(result.workspace, result.files, {
      openPaths: options.openPaths,
      activePath: options.activePath,
    });
  } catch (error) {
    if (isMissingWorkspaceError(error)) {
      clearSnapshot(id);
      clearEdits(id);
      const session = loadSession();
      if (session && session.workspaceId === id) clearSession();
      const replacingCurrent = !state.workspace || state.workspace.id === id;
      if (replacingCurrent) {
        resetWorkspace();
        if (typeof renderWelcomeStatus === 'function') renderWelcomeStatus();
      }
      toast(
        replacingCurrent
          ? 'O projeto anterior não está mais no servidor local. Importe o projeto novamente.'
          : 'Esse projeto não está mais no servidor local.',
        'warn',
        10000,
      );
      return;
    }
    const snapshot = readSnapshot(id);
    if (snapshot) {
      applyWorkspace(snapshot.workspace, snapshot.files, { offline: true });
      toast('Não foi possível abrir no servidor; usando a cópia local.', 'warn');
      return;
    }
    throw error;
  } finally {
    if (!options.silent) hideOverlay();
  }
}

/* ------------------------------------------------------------------ */
/* Compilação                                                          */
/* ------------------------------------------------------------------ */

function blobToBase64Url(base64, type = 'application/zip') {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type }));
}

function triggerDownload(url, name) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name || 'download';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function compileModified() {
  if (state.compiling) return;
  if (!state.workspace) {
    toast('Importe um projeto antes de compilar.', 'warn');
    return;
  }
  const modified = modifiedFiles();
  if (!modified.length) {
    toast(
      'Nenhum arquivo modificado desde a última compilação. Edite um programa, formulário, classe, relatório ou menu antes de compilar.',
      'warn',
      7000,
    );
    return;
  }
  if (!state.online) {
    toast('Servidor offline: não é possível compilar agora.', 'warn');
    return;
  }

  state.compiling = true;
  const payload = modified.map((file) => ({ path: file.path, content: file.content }));
  const sent = new Map(payload.map((entry) => [entry.path.toLowerCase(), entry.content]));
  showOverlay(
    'Compilando alterações…',
    `${payload.length} arquivo(s) modificado(s) serão processados: binários com FoxBin2Prg e fontes atualizados.`,
  );
  try {
    const result = await state.api.compile(state.workspace.id, payload);
    const report = new Map(
      (result.files || []).map((entry) => [String(entry.path).toLowerCase(), entry]),
    );

    for (const file of modified) {
      const key = file.path.toLowerCase();
      const entry = report.get(key);
      if (entry && !entry.ok) continue; // falhou: mantém M para nova tentativa
      const sentContent = sent.get(key);
      if (typeof sentContent !== 'string') continue;
      if (file.content !== sentContent) {
        // Editado durante a compilação: continua pendente.
        file.pendingCompile = true;
        continue;
      }
      // Binário gerado (ou fonte incluído no pacote): nova referência.
      file.baseContent = sentContent;
      file.savedContent = sentContent;
      file.pendingCompile = false;
      file.dirty = false;
    }
    persistEditsNow();
    persistSnapshot();
    renderTabs();
    renderTree();
    updateSummaries();

    showCompileResult(result);
    if (result.zip) {
      if (state.lastZipUrl) URL.revokeObjectURL(state.lastZipUrl);
      state.lastZipUrl = blobToBase64Url(result.zip);
      els.compileDownloadBtn.href = state.lastZipUrl;
      els.compileDownloadBtn.download = result.zipName || 'projeto.recompilado.zip';
      triggerDownload(state.lastZipUrl, result.zipName || 'projeto.recompilado.zip');
    }

    if (result.ok) {
      toast(`Compilação concluída: ${result.stats.compiled} arquivo(s).`, 'ok');
    } else {
      toast(
        `Compilação com falhas: ${result.stats.failed} de ${result.stats.targets} arquivo(s).`,
        'warn',
        9000,
      );
    }
  } catch (error) {
    toast(error.message || 'Falha ao compilar.', 'error', 9000);
  } finally {
    state.compiling = false;
    hideOverlay();
  }
}

function showCompileResult(result) {
  const stats = result.stats || {};
  const summary = [
    `${stats.compiled ?? 0} de ${stats.targets ?? 0} arquivo(s) gerado(s)`,
  ];
  if (stats.binaryTargets) summary.push(`${stats.binaryTargets} binário(s) FoxBin2Prg`);
  if (stats.sources) summary.push(`${stats.sources} fonte(s) .prg`);
  summary.push(
    `${stats.zipBytes ?? 0} bytes`,
    `${stats.ms ?? 0} ms`,
    `codificação ${stats.encoding || 'cp1252'}`,
  );
  els.compileSummary.textContent = summary.join(' · ');

  els.compileList.innerHTML = '';
  const files = result.files || [];
  if (!files.length) {
    els.compileList.innerHTML =
      '<div class="compile-item">Nenhum arquivo binário ou .prg foi recompilado. O pacote contém apenas arquivos de apoio editados.</div>';
  }
  for (const file of files) {
    const item = document.createElement('div');
    item.className = 'compile-item';
    const verify = file.verification;
    let verifyText = '';
    let verifyClass = '';
    if (verify) {
      if (verify.checked && verify.identical) {
        verifyText = 'Verificação: round-trip idêntico.';
      } else if (verify.checked) {
        verifyText = `Verificação: ${verify.added} linha(s) adicionada(s), ${verify.removed} removida(s) na reexportação.`;
        verifyClass = ' warn';
      } else if (verify.warning) {
        verifyText = verify.warning;
        verifyClass = ' warn';
      }
    }
    item.innerHTML = `
      <div class="compile-item-head">
        <span class="compile-badge ${file.ok ? 'ok' : 'fail'}">${file.ok ? 'OK' : 'FALHA'}</span>
        <span class="compile-name">${escapeHtml(file.path)}</span>
      </div>
      ${
        file.source
          ? '<div class="compile-outputs">Fonte .prg atualizada incluída no ZIP.</div>'
          : file.outputs && file.outputs.length
            ? `<div class="compile-outputs">→ ${escapeHtml(file.outputs.join(', '))}</div>`
            : ''
      }
      ${file.error ? `<div class="compile-error">${escapeHtml(file.error)}</div>` : ''}
      ${verifyText ? `<div class="compile-verify${verifyClass}">${escapeHtml(verifyText)}</div>` : ''}
    `;
    els.compileList.appendChild(item);
  }

  const warnings = result.warnings || [];
  els.compileWarnings.className = warnings.length ? 'modal-feedback error' : 'modal-feedback';
  els.compileWarnings.textContent = warnings.length
    ? warnings.join('\n')
    : result.ok
      ? 'Pacote gerado. Copie o conteúdo do ZIP para a pasta do projeto depois de conferir no VFP.'
      : 'Confira os erros acima e o log do servidor.';
  openModal('compileModal');
}

/* ------------------------------------------------------------------ */
/* Exportação LLM                                                      */
/* ------------------------------------------------------------------ */

function currentFilesForExport() {
  return Array.from(state.files.values()).map((file) => ({
    path: file.path,
    category: file.category,
    type: file.type,
    content: file.content,
  }));
}

function ensureExportReady() {
  if (!state.workspace || state.files.size === 0) {
    toast('Importe um projeto antes de exportar para LLM.', 'warn');
    return false;
  }
  return true;
}

function downloadText(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  triggerDownload(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function exportUnified() {
  if (!ensureExportReady()) return;
  const output = buildUnifiedExport(state.workspace, currentFilesForExport());
  downloadText(output.name, output.content);
  toast(`Arquivo único gerado: ${output.name}`, 'ok');
}

function exportPartitioned() {
  if (!ensureExportReady()) return;
  const parts = buildPartitionedExport(state.workspace, currentFilesForExport());
  if (!parts.length) {
    toast('Não há arquivos para exportar.', 'warn');
    return;
  }
  parts.forEach((part, index) => {
    setTimeout(() => downloadText(part.name, part.content), index * 350);
  });
  toast(
    `${parts.length} arquivo(s) .txt gerados (${parts.map((part) => part.name).join(', ')}). ` +
      'Se o navegador bloquear, permita downloads múltiplos.',
    'ok',
    9000,
  );
}

function exportPartitionedZip() {
  if (!ensureExportReady()) return;
  const parts = buildPartitionedExport(state.workspace, currentFilesForExport());
  if (!parts.length) {
    toast('Não há arquivos para exportar.', 'warn');
    return;
  }
  const blob = createZipBlob(parts.map((part) => ({ name: part.name, data: part.content })));
  const url = URL.createObjectURL(blob);
  const stem = String(state.workspace.name || 'projeto').replace(/\.[^.]+$/, '');
  triggerDownload(url, `${stem}_llm.zip`);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`ZIP com ${parts.length} arquivo(s) de contexto gerado.`, 'ok');
}

function showExportHelp() {
  const sample = buildUnifiedExport(
    { name: 'MeuProjeto.pjx' },
    [
      {
        path: 'main.prg',
        category: 'main',
        type: 'PRG',
        content: '* Code for main program\nSET CENTURY ON\nDO form_login',
      },
      {
        path: 'cliente_form.sc2',
        category: 'forms',
        type: 'FORM',
        content: 'DEFINE CLASS form1 AS FORM\n  Caption = "Cadastro de Clientes"\nENDDEFINE',
      },
    ],
  );
  els.exportHelpCode.textContent = sample.content;
  openModal('exportHelpModal');
}

/* ------------------------------------------------------------------ */
/* Configurações                                                       */
/* ------------------------------------------------------------------ */

function openSettings() {
  els.serverUrlInput.value = state.settings.baseUrl || 'http://127.0.0.1:8080';
  els.settingsFeedback.textContent = '';
  els.settingsFeedback.className = 'modal-feedback';
  els.testServerResult.textContent = '—';
  els.testServerResult.className = 'muted inline';
  renderServerDetail();
  openModal('settingsModal');
  setTimeout(() => els.serverUrlInput.focus(), 30);
  refreshStatus({ silent: true }).then(() => renderServerDetail());
}

async function testServer() {
  const candidate = normalizeBaseUrl(els.serverUrlInput.value);
  if (!candidate) {
    els.testServerResult.textContent = 'Informe um endereço.';
    els.testServerResult.className = 'muted inline';
    return;
  }
  els.testServerResult.textContent = 'Testando…';
  els.testServerResult.className = 'muted inline';
  const api = createApi(() => candidate);
  try {
    const status = await api.status();
    state.status = status;
    els.testServerResult.innerHTML = `<span style="color:var(--green)">● Online — versão ${escapeHtml(
      status.version || '',
    )}${status.vfp && status.vfp.found ? ' · VFP ok' : ' · VFP ausente'}</span>`;
    els.testServerResult.className = 'muted inline';
    renderServerDetail();
  } catch (error) {
    els.testServerResult.innerHTML = `<span style="color:var(--red)">● ${escapeHtml(
      error.message || 'Falha na conexão.',
    )}</span>`;
    els.testServerResult.className = 'muted inline';
    els.serverDetail.innerHTML = '<span>Servidor inacessível no endereço informado.</span>';
  }
}

function saveServerSettings() {
  const next = normalizeBaseUrl(els.serverUrlInput.value);
  if (!next) {
    els.settingsFeedback.textContent = 'Informe o endereço do servidor.';
    els.settingsFeedback.className = 'modal-feedback error';
    return;
  }
  const changed = next !== state.settings.baseUrl;
  state.settings = saveSettings({ baseUrl: next });
  state.api = createApi(() => state.settings.baseUrl);
  closeModal('settingsModal');

  if (changed) {
    resetWorkspace();
    clearSession();
    toast('Endereço do servidor atualizado. Importe ou abra um workspace do novo servidor.', 'info');
  } else {
    toast('Configurações salvas.', 'ok', 3000);
  }
  refreshStatus().then(() => loadRecent());
}

/* ------------------------------------------------------------------ */
/* Logs / sobre                                                        */
/* ------------------------------------------------------------------ */

async function showLogs() {
  openModal('logsModal');
  els.logsContent.textContent = 'Carregando…';
  els.logsFile.textContent = '—';
  try {
    const result = await state.api.logs(500);
    els.logsFile.textContent = result.file || '—';
    els.logsContent.textContent = result.text || '(sem linhas)';
    els.logsContent.scrollTop = els.logsContent.scrollHeight;
  } catch (error) {
    els.logsContent.textContent = error.message || 'Falha ao ler o log.';
  }
}

function showAbout() {
  const status = state.status || {};
  const vfp = status.vfp || {};
  const fb = status.foxbin2prg || {};
  els.aboutBody.innerHTML = `
    <p class="muted">
      Aplicação web para visualizar, editar, recompilar e preparar código Visual FoxPro
      para contexto de LLMs. A IDE se comunica com o FoxPro Local Bridge Service, que empacota
      o FoxBin2Prg e devolve os binários recompilados em ZIP.
    </p>
    <p class="muted">
      <b>Preview experimental:</b> abra um arquivo <code>.sc2</code> e alterne entre
      <b>Código</b> e <b>Preview</b>. A renderização é aproximada e não executa código VFP.
    </p>
    <div class="server-detail">
      <span>Versão do bridge: <b>${escapeHtml(status.version || '—')}</b></span>
      <span>Endereço: <code>${escapeHtml(state.settings.baseUrl)}</code></span>
      <span>VFP: <code>${escapeHtml(vfp.found ? vfp.path : 'não encontrado')}</code></span>
      <span>FoxBin2Prg: <b>${escapeHtml(fb.version || '—')}</b> (MIT)</span>
      <span>API: <code>/api/status · /api/project/import · /api/project/compile · /api/logs</code></span>
    </div>
    <p class="muted" style="margin-top:14px">
      Teclas: Ctrl+S salvar · Ctrl+O importar · Ctrl+Shift+B compilar · Ctrl+Shift+E exportar LLM.
    </p>
  `;
  openModal('aboutModal');
}

/* ------------------------------------------------------------------ */
/* Menus / eventos                                                     */
/* ------------------------------------------------------------------ */

function closeMenus() {
  document.querySelectorAll('.menu.open').forEach((menu) => menu.classList.remove('open'));
}

function toggleMenu(name) {
  const menu = document.querySelector(`[data-menu="${name}"]`).closest('.menu');
  const isOpen = menu.classList.contains('open');
  closeMenus();
  if (!isOpen) menu.classList.add('open');
}

async function handleAction(action) {
  closeMenus();
  switch (action) {
    case 'import':
      openImportModal();
      break;
    case 'save':
      saveWorkspace();
      break;
    case 'compile':
      compileModified();
      break;
    case 'export-unified':
      exportUnified();
      break;
    case 'export-partitioned':
      exportPartitioned();
      break;
    case 'export-zip':
      exportPartitionedZip();
      break;
    case 'toggle-sidebar':
      state.settings = saveSettings({
        sidebarHidden: !(state.settings.sidebarHidden === true),
      });
      applySidebarVisibility();
      break;
    case 'close-all':
      closeAllTabs();
      break;
    case 'open-logs':
      showLogs();
      break;
    case 'refresh-status':
      toast('Verificando servidor…', 'info', 2000);
      refreshStatus();
      break;
    case 'about':
      showAbout();
      break;
    case 'export-help':
      showExportHelp();
      break;
    default:
      break;
  }
}

function bindEvents() {
  els.settingsBtn.addEventListener('click', openSettings);
  els.serverPill.addEventListener('click', openSettings);
  els.statusServerBtn.addEventListener('click', () => refreshStatus());
  els.importBtn.addEventListener('click', openImportModal);
  els.welcomeImportBtn.addEventListener('click', openImportModal);
  els.welcomeSettingsBtn.addEventListener('click', openSettings);
  els.compileSideBtn.addEventListener('click', compileModified);
  els.doImportBtn.addEventListener('click', doImport);
  els.browseBtn.addEventListener('click', () => {
    els.browser.hidden = false;
    loadBrowser(els.projectPathInput.value.trim() || state.browserPath || '');
  });
  els.browserUp.addEventListener('click', async () => {
    if (!state.browserPath) {
      loadBrowser('');
      return;
    }
    try {
      const result = await state.api.fsList(state.browserPath);
      if (result.parent) loadBrowser(result.parent);
      else loadBrowser('');
    } catch {
      loadBrowser('');
    }
  });
  els.projectPathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') doImport();
  });

  els.testServerBtn.addEventListener('click', testServer);
  els.saveSettingsBtn.addEventListener('click', saveServerSettings);
  els.refreshLogsBtn.addEventListener('click', showLogs);

  els.viewCodeBtn.addEventListener('click', () => setFormView('code'));
  els.viewPreviewBtn.addEventListener('click', () => setFormView('preview'));
  els.formZoomIn.addEventListener('click', () => {
    if (!state.formPreview) return;
    state.formPreview.setZoom(state.formPreview.getZoom() * 1.1);
  });
  els.formZoomOut.addEventListener('click', () => {
    if (!state.formPreview) return;
    state.formPreview.setZoom(state.formPreview.getZoom() / 1.1);
  });
  els.formZoomFit.addEventListener('click', () => {
    if (state.formPreview) state.formPreview.fit();
  });
  els.formRefresh.addEventListener('click', () => renderFormPreview({ fit: true }));

  els.treeFilter.addEventListener('input', () => {
    state.filter = els.treeFilter.value;
    renderTree();
  });

  document.querySelectorAll('.menu-btn').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleMenu(button.dataset.menu);
    });
  });

  document.querySelectorAll('.menu-item[data-action], .activity-btn[data-action]').forEach((button) => {
    button.addEventListener('click', () => handleAction(button.dataset.action));
  });

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.menu')) closeMenus();
  });

  document.addEventListener('keydown', (event) => {
    const ctrl = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      closeMenus();
      const openModalEl = Array.from(document.querySelectorAll('.modal')).find(
        (modal) => !modal.hidden,
      );
      if (openModalEl) closeModal(openModalEl.id);
      return;
    }
    if (!ctrl) return;
    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      saveWorkspace();
    } else if (key === 'o') {
      event.preventDefault();
      openImportModal();
    } else if (key === 'e' && event.shiftKey) {
      event.preventDefault();
      exportUnified();
    } else if (key === 'b' && event.shiftKey) {
      event.preventDefault();
      compileModified();
    }
  });

  window.addEventListener('beforeunload', () => {
    persistEditsNow();
    persistSession();
  });
}

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */

async function initEditor() {
  const monaco = await window.__monacoPromise;
  if (!monaco) throw new Error('Monaco Editor não carregou.');
  state.monaco = monaco;
  initVfpLanguage(monaco);
  applyEditorTheme(monaco);
  state.editor = createEditor(monaco, els.editor);
  state.editor.onDidChangeModelContent(() => syncActiveFile());
  state.editor.onDidChangeCursorPosition(() => updatePosition());
  state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveWorkspace());
  state.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyB,
    () => compileModified(),
  );
  state.editor.setModel(null);
  state.formPreview = createFormPreviewController({
    stage: els.formPreviewStage,
    meta: els.formPreviewMeta,
    status: els.formPreviewStatus,
    zoomLabel: els.formZoomLabel,
  });
}

async function restoreSession() {
  const session = loadSession();
  if (!session || !session.workspaceId) return;
  try {
    await loadWorkspaceById(session.workspaceId, {
      silent: true,
      openPaths: session.openPaths,
      activePath: session.activePath,
    });
  } catch {
    const snapshot = readSnapshot(session.workspaceId);
    if (snapshot) {
      applyWorkspace(snapshot.workspace, snapshot.files, { offline: true });
      toast('Servidor offline: projeto restaurado da cópia local.', 'warn');
    }
  }
}

async function init() {
  applySidebarVisibility();
  state.api = createApi(() => state.settings.baseUrl);
  bindEvents();
  await initEditor();

  await refreshStatus({ silent: true });
  await restoreSession();
  if (!state.workspace) {
    renderTree();
    updateSummaries();
    renderWelcomeStatus();
  }
  await loadRecent();

  setInterval(() => {
    if (!document.hidden) refreshStatus({ silent: true });
  }, 6000);

  // Expõe o estado para diagnóstico no console do navegador.
  window.__FPIW__ = state;
}

init().catch((error) => {
  console.error(error);
  toast(`Falha ao iniciar a IDE: ${error.message || error}`, 'error', 12000);
  els.welcomeStatus.innerHTML = `<span class="bad">Falha ao iniciar a IDE.</span> ${escapeHtml(
    error.message || '',
  )}`;
});

window.addEventListener('unhandledrejection', (event) => {
  console.error(event.reason);
  const message =
    event.reason && event.reason.message ? event.reason.message : String(event.reason || '');
  if (message) toast(message, 'error');
});
