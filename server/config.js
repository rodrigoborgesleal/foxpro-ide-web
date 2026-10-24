'use strict';

/**
 * Configuração persistente do FoxPro IDE Web.
 *
 * Local padrão: %APPDATA%\FoxProIDEWeb
 * Pode ser sobrescrito com FPIW_CONFIG (arquivo) ou FPIW_CONFIG_DIR (pasta).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'FoxProIDEWeb';

const APP_DIR =
  process.env.FPIW_CONFIG_DIR ||
  path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    APP_NAME,
  );

const CONFIG_FILE = process.env.FPIW_CONFIG || path.join(APP_DIR, 'config.json');
const LOGS_DIR = path.join(APP_DIR, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'app.log');
const WORKSPACES_DIR = path.join(APP_DIR, 'workspaces');
const RUNTIME_DIR = path.join(os.tmpdir(), 'foxpro-ide-web');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8080,
  vfpPath: '',
  timeoutMs: 300000,
  autoStart: true,
  launchAtLogin: false,
  keepJobs: false,
  debug: false,
  openIdeOnStart: false,
};

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalize(raw = {}) {
  return {
    host: '127.0.0.1',
    port: clampInt(raw.port, 1024, 65535, DEFAULTS.port),
    vfpPath: String(raw.vfpPath || '')
      .trim()
      .replace(/^"(.*)"$/, '$1'),
    timeoutMs: clampInt(raw.timeoutMs, 10000, 1800000, DEFAULTS.timeoutMs),
    autoStart: raw.autoStart !== false,
    launchAtLogin: raw.launchAtLogin === true,
    keepJobs: raw.keepJobs === true,
    debug: raw.debug === true,
    openIdeOnStart: raw.openIdeOnStart === true,
  };
}

function ensureDirs() {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function loadConfig() {
  ensureDirs();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    stored = {};
  }
  return normalize(stored);
}

function saveConfig(patch = {}) {
  ensureDirs();
  const next = normalize({ ...loadConfig(), ...patch });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function getConfigPath() {
  return CONFIG_FILE;
}

function getLogsDir() {
  ensureDirs();
  return LOGS_DIR;
}

function getLogFile() {
  ensureDirs();
  return LOG_FILE;
}

function getWorkspacesDir() {
  ensureDirs();
  return WORKSPACES_DIR;
}

function getRuntimeDir() {
  ensureDirs();
  return RUNTIME_DIR;
}

function getDataDir() {
  return APP_DIR;
}

module.exports = {
  APP_NAME,
  APP_DIR,
  CONFIG_FILE,
  LOGS_DIR,
  LOG_FILE,
  WORKSPACES_DIR,
  RUNTIME_DIR,
  DEFAULTS,
  loadConfig,
  saveConfig,
  getConfigPath,
  getLogsDir,
  getLogFile,
  getWorkspacesDir,
  getRuntimeDir,
  getDataDir,
  normalize,
};
