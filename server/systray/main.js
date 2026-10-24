'use strict';

/**
 * FoxPro IDE Web — aplicativo de bandeja (Windows).
 *
 * Mantém o Local Bridge Service rodando em segundo plano, oferece o menu da
 * bandeja, a janela de configurações e o acesso rápido à IDE no navegador.
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  dialog,
  shell,
  ipcMain,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadConfig,
  saveConfig,
  getConfigPath,
  getLogsDir,
  getLogFile,
  getDataDir,
  getWorkspacesDir,
} = require('../config');
const { startServer } = require('../server');
const { getVfpPath, listWorkspaces } = require('../core');

const APP_ID = 'br.com.foxproideweb.bridge';
const APP_NAME = 'FoxPro IDE Web';
const MAX_LOG_LINES = 400;

let tray = null;
let settingsWindow = null;
let serverApp = null;
let serverError = null;
let quitting = false;

app.setName(APP_NAME);
app.setPath(
  'userData',
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME),
);

function assetPath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', name)
    : path.join(__dirname, 'assets', name);
}

function formatArg(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendLog(level, args) {
  const line = `[${new Date().toISOString()}] ${level} ${args.map(formatArg).join(' ')}`;
  try {
    rotateLog();
    fs.appendFileSync(getLogFile(), `${line}\n`, 'utf8');
  } catch {
    /* log é melhor esforço */
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:log', line);
  }
  return line;
}

const serverLogger = {
  log: (...args) => appendLog('INFO', args),
  error: (...args) => appendLog('ERROR', args),
};

function rotateLog() {
  try {
    const logFile = getLogFile();
    const stat = fs.statSync(logFile);
    if (stat.size > 2 * 1024 * 1024) {
      try {
        fs.unlinkSync(`${logFile}.1`);
      } catch {
        /* ainda não existe */
      }
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    /* sem log ainda */
  }
}

function readLogTail(maxLines = 200) {
  try {
    const text = fs.readFileSync(getLogFile(), 'utf8');
    return text.split(/\r?\n/).slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

function countWorkspaces() {
  try {
    return listWorkspaces().length;
  } catch {
    return 0;
  }
}

function friendlyError(error) {
  if (error && error.code === 'EADDRINUSE') {
    const port = loadConfig().port;
    return (
      `A porta ${port} já está em uso. Feche o outro processo ` +
      '(ou outra instância do FoxPro IDE Web) e tente novamente.'
    );
  }
  return error && error.message ? error.message : String(error);
}

function statePayload() {
  const current = loadConfig();
  const running = Boolean(serverApp && serverApp.running);
  return {
    config: current,
    server: {
      running,
      url: running ? serverApp.info().url : null,
      ideUrl: running ? serverApp.info().ideUrl : null,
      error: serverError,
    },
    paths: {
      config: getConfigPath(),
      logs: getLogsDir(),
      logFile: getLogFile(),
      data: getDataDir(),
      workspaces: getWorkspacesDir(),
    },
    workspaceCount: countWorkspaces(),
    vfpDetected: getVfpPath(),
    version: app.getVersion(),
    log: readLogTail(MAX_LOG_LINES),
  };
}

function broadcastState() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:state', statePayload());
  }
}

async function startFoxServer() {
  if (serverApp && serverApp.running) {
    return { ok: true, state: statePayload() };
  }
  if (serverApp) {
    await serverApp.stop().catch(() => {});
    serverApp = null;
  }

  const current = loadConfig();
  serverError = null;
  try {
    serverApp = await startServer({
      host: current.host,
      port: current.port,
      logger: serverLogger,
    });
    serverLogger.log(`servidor iniciado em ${serverApp.info().url}`);
    updateTray();
    broadcastState();
    return { ok: true, state: statePayload() };
  } catch (error) {
    serverApp = null;
    serverError = friendlyError(error);
    serverLogger.error(`falha ao iniciar o servidor: ${serverError}`);
    updateTray();
    broadcastState();
    return { ok: false, error: serverError, state: statePayload() };
  }
}

async function stopFoxServer() {
  if (!serverApp) {
    return { ok: true, state: statePayload() };
  }
  try {
    await serverApp.stop();
    serverLogger.log('servidor parado');
    serverApp = null;
    serverError = null;
    updateTray();
    broadcastState();
    return { ok: true, state: statePayload() };
  } catch (error) {
    serverError = friendlyError(error);
    serverLogger.error(`falha ao parar o servidor: ${serverError}`);
    updateTray();
    broadcastState();
    return { ok: false, error: serverError, state: statePayload() };
  }
}

function currentIdeUrl() {
  if (serverApp && serverApp.running) return serverApp.info().ideUrl;
  const config = loadConfig();
  return `http://${config.host || '127.0.0.1'}:${config.port || 8080}/`;
}

async function openIde() {
  if (!serverApp || !serverApp.running) {
    const result = await startFoxServer();
    if (!result.ok) {
      dialog.showErrorBox(
        'FoxPro IDE Web',
        `Não foi possível iniciar o servidor local.\n\n${result.error || serverError || ''}`,
      );
      openSettings();
      return;
    }
  }
  const url = currentIdeUrl();
  serverLogger.log(`abrindo a IDE no navegador: ${url}`);
  shell.openExternal(url).catch((error) => {
    serverLogger.error(`não foi possível abrir o navegador: ${error.message}`);
  });
}

function applyLoginItem() {
  if (process.platform !== 'win32') return;
  const current = loadConfig();
  // No executável portátil, process.execPath aponta para a cópia temporária.
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  const executable = app.isPackaged && portableExe ? portableExe : process.execPath;
  try {
    app.setLoginItemSettings({
      openAtLogin: current.launchAtLogin,
      path: executable,
      args: app.isPackaged ? [] : [app.getAppPath()],
    });
  } catch (error) {
    serverLogger.error(`não foi possível configurar a inicialização com o Windows: ${error.message}`);
  }
}

function updateTray() {
  if (!tray) return;
  const running = Boolean(serverApp && serverApp.running);
  const url = running ? serverApp.info().url : null;
  const config = loadConfig();
  const template = [
    {
      label: running ? `Servidor: ${url}` : 'Servidor: parado',
      enabled: false,
    },
    {
      label: `Porta: ${url ? serverApp.info().port : config.port}`,
      enabled: false,
    },
    {
      label: running ? 'Parar servidor' : 'Iniciar servidor',
      click: () => {
        (running ? stopFoxServer() : startFoxServer()).catch(() => {});
      },
    },
    { type: 'separator' },
    { label: 'Abrir IDE no navegador', click: () => openIde().catch(() => {}) },
    { label: 'Configurações…', click: () => openSettings() },
    { label: 'Abrir logs', click: () => openPathSafe(getLogsDir()) },
    { label: 'Abrir pasta de projetos', click: () => openPathSafe(getWorkspacesDir()) },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(
    running
      ? `FoxPro IDE Web — servidor online (${url})`
      : serverError
        ? 'FoxPro IDE Web — servidor parado (erro; abra Configurações)'
        : 'FoxPro IDE Web — servidor parado',
  );
}

function createTray() {
  let image = nativeImage.createFromPath(assetPath('icon.ico'));
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(assetPath('icon.png'));
  }
  if (image.isEmpty()) {
    // fallback mínimo para nunca falhar na criação da bandeja
    image = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVR42mNkYGD4z0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC',
    );
  }
  tray = new Tray(image);
  tray.on('click', () => openIde().catch(() => {}));
  tray.on('double-click', () => openIde().catch(() => {}));
  updateTray();
}

function openSettings() {
  if (!app.isReady()) return;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 800,
    height: 900,
    minWidth: 660,
    minHeight: 620,
    title: 'FoxPro IDE Web — Configurações',
    icon: assetPath('icon.ico'),
    show: false,
    backgroundColor: '#1f1f1f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  settingsWindow.webContents.on('did-finish-load', () => broadcastState());
  settingsWindow.webContents.on('console-message', (_event, ...args) => {
    const details = args[0] && typeof args[0] === 'object' ? args[0] : null;
    const level = details ? details.level : args[0];
    const message = details ? details.message : args[1];
    const line = details ? details.lineNumber : args[2];
    const sourceId = details ? details.sourceId : args[3];
    const isProblem =
      level === 'error' ||
      level === 'warning' ||
      (Number.isFinite(Number(level)) && Number(level) >= 2);
    if (isProblem) {
      serverLogger.error(`renderer: ${message} (${sourceId}:${line})`);
    }
  });
  settingsWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    serverLogger.error(`falha ao carregar a tela de configurações: ${description} (${code}) ${url}`);
  });
  settingsWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    serverLogger.error(`falha no preload (${preloadPath}): ${error.message}`);
  });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function openPathSafe(target) {
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    shell.openPath(target).catch(() => {});
  } catch {
    /* melhor esforço */
  }
}

function setupIpc() {
  ipcMain.handle('settings:get', () => statePayload());

  ipcMain.handle('settings:save', async (_event, patch) => {
    const previous = loadConfig();
    const allowed = {};
    for (const key of [
      'port',
      'vfpPath',
      'timeoutMs',
      'autoStart',
      'launchAtLogin',
      'keepJobs',
      'debug',
      'openIdeOnStart',
    ]) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
        allowed[key] = patch[key];
      }
    }

    const next = saveConfig(allowed);
    applyLoginItem();
    serverLogger.log('configurações salvas');

    let restarted = false;
    let restartError = null;
    const portChanged = next.port !== previous.port;
    if (portChanged && serverApp && serverApp.running) {
      serverLogger.log(`porta alterada de ${previous.port} para ${next.port}; reiniciando servidor`);
      await stopFoxServer();
      const result = await startFoxServer();
      restarted = result.ok;
      restartError = result.ok ? null : result.error || 'Falha ao reiniciar o servidor.';
    }

    broadcastState();
    return {
      ok: !restartError,
      error: restartError || undefined,
      restarted,
      portChanged,
      state: statePayload(),
    };
  });

  ipcMain.handle('settings:start', () => startFoxServer());
  ipcMain.handle('settings:stop', () => stopFoxServer());
  ipcMain.handle('settings:open-ide', async () => {
    await openIde();
    return { ok: true, url: currentIdeUrl() };
  });

  ipcMain.handle('settings:pick-vfp', async () => {
    const options = {
      title: 'Selecione o vfp9.exe',
      properties: ['openFile'],
      filters: [{ name: 'Visual FoxPro 9', extensions: ['exe'] }],
      defaultPath: loadConfig().vfpPath || getVfpPath() || undefined,
    };
    const result = settingsWindow
      ? await dialog.showOpenDialog(settingsWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('settings:detect-vfp', () => {
    const detected = getVfpPath();
    return detected
      ? { ok: true, path: detected, message: 'vfp9.exe encontrado.' }
      : {
          ok: false,
          path: '',
          message: 'Não encontrei o vfp9.exe nas instalações padrão. Informe o caminho manualmente.',
        };
  });

  ipcMain.handle('settings:test-vfp', (_event, vfpPath) => {
    const candidate = String(vfpPath || '')
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (!candidate) {
      return { ok: false, message: 'Informe o caminho do vfp9.exe.' };
    }
    if (!/vfp9\.exe$/i.test(candidate)) {
      return { ok: false, message: 'O arquivo deve se chamar vfp9.exe.' };
    }
    try {
      if (!fs.statSync(candidate).isFile()) {
        return { ok: false, message: 'O caminho não aponta para um arquivo.' };
      }
    } catch {
      return { ok: false, message: 'Arquivo não encontrado nesse caminho.' };
    }
    return { ok: true, path: candidate, message: 'vfp9.exe encontrado.' };
  });

  ipcMain.handle('settings:open-data', () => {
    openPathSafe(getDataDir());
    return { ok: true };
  });

  ipcMain.handle('settings:open-workspaces', () => {
    openPathSafe(getWorkspacesDir());
    return { ok: true };
  });

  ipcMain.handle('settings:open-logs', () => {
    openPathSafe(getLogsDir());
    return { ok: true };
  });

  ipcMain.handle('settings:open-config', () => {
    saveConfig({});
    shell.showItemInFolder(getConfigPath());
    return { ok: true };
  });
}

async function bootstrap() {
  app.setAppUserModelId(APP_ID);
  const firstRun = !fs.existsSync(getConfigPath());
  rotateLog();
  setupIpc();
  createTray();
  applyLoginItem();
  if (firstRun) saveConfig({});

  if (loadConfig().autoStart) {
    await startFoxServer();
  }

  if (firstRun || loadConfig().openIdeOnStart) {
    openSettings();
  }
  if (loadConfig().openIdeOnStart) {
    openIde().catch(() => {});
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettings());
  app.whenReady().then(bootstrap).catch((error) => {
    appendLog('ERROR', [`falha ao iniciar o app: ${error.message}`]);
    dialog.showErrorBox(
      'FoxPro IDE Web',
      `Não foi possível iniciar o aplicativo:\n\n${error.message}`,
    );
    app.quit();
  });

  // Fecha a janela, mas mantém o app na bandeja.
  app.on('window-all-closed', () => {});

  app.on('before-quit', (event) => {
    if (quitting || !serverApp) return;
    event.preventDefault();
    quitting = true;
    stopFoxServer().finally(() => app.quit());
  });

  app.on('will-quit', () => {
    if (tray) tray.destroy();
  });
}
