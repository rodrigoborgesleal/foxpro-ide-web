'use strict';

const els = {
  version: document.getElementById('version'),
  serverUrl: document.getElementById('serverUrl'),
  serverBadge: document.getElementById('serverBadge'),
  serverError: document.getElementById('serverError'),
  openIdeBtn: document.getElementById('openIdeBtn'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  openLogsBtn: document.getElementById('openLogsBtn'),
  port: document.getElementById('port'),
  autoStart: document.getElementById('autoStart'),
  launchAtLogin: document.getElementById('launchAtLogin'),
  openIdeOnStart: document.getElementById('openIdeOnStart'),
  vfpPath: document.getElementById('vfpPath'),
  pickVfpBtn: document.getElementById('pickVfpBtn'),
  detectVfpBtn: document.getElementById('detectVfpBtn'),
  testVfpBtn: document.getElementById('testVfpBtn'),
  vfpStatus: document.getElementById('vfpStatus'),
  timeoutSec: document.getElementById('timeoutSec'),
  keepJobs: document.getElementById('keepJobs'),
  debug: document.getElementById('debug'),
  workspaceCount: document.getElementById('workspaceCount'),
  workspacesPath: document.getElementById('workspacesPath'),
  openWorkspacesBtn: document.getElementById('openWorkspacesBtn'),
  openDataBtn: document.getElementById('openDataBtn'),
  openConfigBtn: document.getElementById('openConfigBtn'),
  refreshLogBtn: document.getElementById('refreshLogBtn'),
  log: document.getElementById('log'),
  logPath: document.getElementById('logPath'),
  feedback: document.getElementById('feedback'),
  saveBtn: document.getElementById('saveBtn'),
};

let feedbackTimer = null;
let saveInFlight = false;
let actionInFlight = false;
let initialLoadDone = false;

function setFeedback(message, type = '') {
  els.feedback.textContent = message || '';
  els.feedback.className = `feedback${type ? ` ${type}` : ''}`;
  if (feedbackTimer) clearTimeout(feedbackTimer);
  if (message) {
    feedbackTimer = setTimeout(() => {
      els.feedback.textContent = '';
      els.feedback.className = 'feedback';
    }, 9000);
  }
}

function setLog(text) {
  const value = String(text || '').trim();
  els.log.textContent = value || '(sem linhas)';
  els.log.scrollTop = els.log.scrollHeight;
}

function appendLog(line) {
  if (!line) return;
  const current = els.log.textContent === '(sem linhas)' ? '' : els.log.textContent;
  const lines = `${current}${current ? '\n' : ''}${line}`.split(/\r?\n/);
  setLog(lines.slice(-500).join('\n'));
}

function iconForState(state) {
  const server = state && state.server ? state.server : {};
  if (server.error) return { text: 'erro', className: 'badge erro' };
  if (server.running) return { text: 'online', className: 'badge on' };
  return { text: 'parado', className: 'badge off' };
}

function renderServer(state) {
  const server = state.server || {};
  const config = state.config || {};
  const badge = iconForState(state);
  els.serverBadge.textContent = badge.text;
  els.serverBadge.className = badge.className;

  els.startBtn.disabled = Boolean(server.running) || actionInFlight;
  els.stopBtn.disabled = !server.running || actionInFlight;
  els.openIdeBtn.disabled = actionInFlight;

  if (server.error) {
    els.serverError.hidden = false;
    els.serverError.textContent = server.error;
  } else {
    els.serverError.hidden = true;
    els.serverError.textContent = '';
  }

  const host = config.host || '127.0.0.1';
  const port = config.port || 8080;
  els.serverUrl.textContent = server.running && server.url ? server.url : `http://${host}:${port}`;
}

function renderPaths(state) {
  const paths = state.paths || {};
  els.logPath.textContent = paths.logFile || paths.logs || '—';
  els.workspacesPath.textContent = paths.workspaces || '—';
  els.workspaceCount.textContent = String(state.workspaceCount ?? 0);
}

function renderVfpStatus(state, customMessage) {
  if (customMessage) {
    els.vfpStatus.textContent = customMessage;
    return;
  }
  const configured = state && state.config ? state.config.vfpPath : '';
  const detected = state ? state.vfpDetected : null;
  if (configured && detected && configured.toLowerCase() !== detected.toLowerCase()) {
    els.vfpStatus.textContent = `Caminho configurado não encontrado; usando ${detected}`;
    return;
  }
  if (detected) {
    els.vfpStatus.textContent = `Detectado: ${detected}`;
  } else {
    els.vfpStatus.textContent = 'Nenhum vfp9.exe detectado nas instalações padrão.';
  }
}

function fillForm(state) {
  const config = state.config || {};
  els.version.textContent = state.version ? `v${state.version}` : 'v0.0.0';
  els.port.value = String(config.port || 8080);
  els.vfpPath.value = config.vfpPath || '';
  els.timeoutSec.value = String(Math.max(10, Math.round((config.timeoutMs || 300000) / 1000)));
  els.autoStart.checked = config.autoStart !== false;
  els.launchAtLogin.checked = Boolean(config.launchAtLogin);
  els.openIdeOnStart.checked = Boolean(config.openIdeOnStart);
  els.keepJobs.checked = Boolean(config.keepJobs);
  els.debug.checked = Boolean(config.debug);
}

function applyState(state, { fill = false, log = false } = {}) {
  if (!state) return;
  if (fill) fillForm(state);
  renderServer(state);
  renderPaths(state);
  renderVfpStatus(state);
  if (log) setLog(state.log);
}

function gatherForm() {
  const port = Number(els.port.value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('A porta deve ser um número inteiro entre 1024 e 65535.');
  }
  const timeoutSeconds = Number(els.timeoutSec.value);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 1800) {
    throw new Error('O tempo limite deve ficar entre 10 e 1800 segundos.');
  }
  return {
    port,
    vfpPath: els.vfpPath.value.trim(),
    timeoutMs: Math.round(timeoutSeconds * 1000),
    autoStart: els.autoStart.checked,
    launchAtLogin: els.launchAtLogin.checked,
    openIdeOnStart: els.openIdeOnStart.checked,
    keepJobs: els.keepJobs.checked,
    debug: els.debug.checked,
  };
}

async function load(initial = false) {
  try {
    const state = await window.fpiw.get();
    applyState(state, { fill: initial || !initialLoadDone, log: true });
    initialLoadDone = true;
    if (initial) {
      const vfp = state && state.config ? state.config.vfpPath : '';
      if (!vfp && state && state.vfpDetected) {
        setFeedback('VFP detectado automaticamente nas instalações padrão.', 'ok');
      }
    }
  } catch (error) {
    setFeedback(`Falha ao carregar as configurações: ${error.message || error}`, 'error');
  }
}

async function save() {
  if (saveInFlight) return;
  let payload;
  try {
    payload = gatherForm();
  } catch (error) {
    setFeedback(error.message, 'error');
    return;
  }

  saveInFlight = true;
  els.saveBtn.disabled = true;
  setFeedback('Salvando…');
  try {
    const result = await window.fpiw.save(payload);
    if (result && result.state) applyState(result.state);
    if (result && result.ok) {
      if (result.portChanged) {
        setFeedback(
          result.restarted
            ? 'Configurações salvas. Servidor reiniciado na nova porta.'
            : 'Configurações salvas. O servidor não pôde ser reiniciado na nova porta; abra o log.',
          result.restarted ? 'ok' : 'warn',
        );
      } else {
        setFeedback(
          'Configurações salvas. A próxima conversão já usa os novos valores.',
          'ok',
        );
      }
    } else {
      setFeedback(
        (result && result.error) || 'Não foi possível salvar as configurações.',
        'error',
      );
    }
  } catch (error) {
    setFeedback(`Não foi possível salvar: ${error.message || error}`, 'error');
  } finally {
    saveInFlight = false;
    els.saveBtn.disabled = false;
  }
}

async function startServer() {
  if (actionInFlight) return;
  actionInFlight = true;
  renderServer({ config: {}, server: { running: false } });
  setFeedback('Iniciando servidor…');
  try {
    const result = await window.fpiw.start();
    if (result && result.state) applyState(result.state);
    if (result && result.ok) {
      setFeedback('Servidor iniciado.', 'ok');
    } else {
      setFeedback(
        (result && result.error) || 'Não foi possível iniciar o servidor.',
        'error',
      );
    }
  } catch (error) {
    setFeedback(`Não foi possível iniciar: ${error.message || error}`, 'error');
  } finally {
    actionInFlight = false;
    if (initialLoadDone) load(false);
  }
}

async function stopServer() {
  if (actionInFlight) return;
  actionInFlight = true;
  renderServer({ config: {}, server: { running: true } });
  setFeedback('Parando servidor…');
  try {
    const result = await window.fpiw.stop();
    if (result && result.state) applyState(result.state);
    if (result && result.ok) {
      setFeedback('Servidor parado.', 'ok');
    } else {
      setFeedback((result && result.error) || 'Não foi possível parar o servidor.', 'error');
    }
  } catch (error) {
    setFeedback(`Não foi possível parar: ${error.message || error}`, 'error');
  } finally {
    actionInFlight = false;
    if (initialLoadDone) load(false);
  }
}

async function openIde() {
  if (actionInFlight) return;
  actionInFlight = true;
  els.openIdeBtn.disabled = true;
  setFeedback('Abrindo a IDE no navegador…');
  try {
    const result = await window.fpiw.openIde();
    if (result && result.url) {
      setFeedback(`IDE aberta em ${result.url}`, 'ok');
    }
    if (initialLoadDone) await load(false);
  } catch (error) {
    setFeedback(`Não foi possível abrir a IDE: ${error.message || error}`, 'error');
  } finally {
    actionInFlight = false;
    els.openIdeBtn.disabled = false;
  }
}

async function pickVfp() {
  try {
    const vfpPath = await window.fpiw.pickVfp();
    if (vfpPath) {
      els.vfpPath.value = vfpPath;
      const result = await window.fpiw.testVfp(vfpPath);
      renderVfpStatus({}, result && result.message ? result.message : '');
      const ok = Boolean(result && result.ok);
      setFeedback(
        ok
          ? 'Caminho do VFP selecionado. Clique em Salvar alterações.'
          : (result && result.message) || 'VFP inválido.',
        ok ? 'ok' : 'error',
      );
    }
  } catch (error) {
    setFeedback(`Não foi possível abrir o seletor de arquivos: ${error.message || error}`, 'error');
  }
}

async function detectVfp() {
  try {
    const result = await window.fpiw.detectVfp();
    if (result && result.ok) {
      els.vfpPath.value = result.path;
      renderVfpStatus({}, result.message);
      setFeedback('Caminho do VFP detectado. Clique em Salvar alterações.', 'ok');
    } else {
      renderVfpStatus({}, (result && result.message) || '');
      setFeedback((result && result.message) || 'VFP não encontrado.', 'warn');
    }
  } catch (error) {
    setFeedback(`Falha ao detectar o VFP: ${error.message || error}`, 'error');
  }
}

async function testVfp() {
  try {
    const result = await window.fpiw.testVfp(els.vfpPath.value);
    renderVfpStatus({}, (result && result.message) || '');
    setFeedback(
      (result && result.message) || (result && result.ok ? 'VFP válido.' : 'VFP inválido.'),
      result && result.ok ? 'ok' : 'error',
    );
  } catch (error) {
    setFeedback(`Falha ao testar o VFP: ${error.message || error}`, 'error');
  }
}

async function refreshLog() {
  try {
    const state = await window.fpiw.get();
    applyState(state);
    setLog(state.log);
  } catch (error) {
    setFeedback(`Falha ao ler o log: ${error.message || error}`, 'error');
  }
}

els.saveBtn.addEventListener('click', save);
els.startBtn.addEventListener('click', startServer);
els.stopBtn.addEventListener('click', stopServer);
els.openIdeBtn.addEventListener('click', openIde);
els.pickVfpBtn.addEventListener('click', pickVfp);
els.detectVfpBtn.addEventListener('click', detectVfp);
els.testVfpBtn.addEventListener('click', testVfp);
els.refreshLogBtn.addEventListener('click', refreshLog);
els.openWorkspacesBtn.addEventListener('click', () => {
  window.fpiw.openWorkspaces().catch((error) => setFeedback(error.message, 'error'));
});
els.openDataBtn.addEventListener('click', () => {
  window.fpiw.openData().catch((error) => setFeedback(error.message, 'error'));
});
els.openLogsBtn.addEventListener('click', () => {
  window.fpiw.openLogs().catch((error) => setFeedback(error.message, 'error'));
});
els.openConfigBtn.addEventListener('click', () => {
  window.fpiw.openConfig().catch((error) => setFeedback(error.message, 'error'));
});
document.querySelectorAll('.nav-item').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((node) => {
      node.classList.toggle('active', node === link);
    });
  });
});
els.port.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') save();
});

if (window.fpiw) {
  window.fpiw.onState((state) => {
    applyState(state);
  });

  window.fpiw.onLog((line) => {
    appendLog(line);
  });

  load(true);
} else {
  setFeedback(
    'A API de configurações não foi carregada. Feche e abra a janela novamente.',
    'error',
  );
}
