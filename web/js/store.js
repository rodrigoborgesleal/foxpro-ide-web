'use strict';

/**
 * Persistência no LocalStorage:
 *  - endereço do servidor;
 *  - sessão (workspace/abas abertas);
 *  - edições ainda não salvas;
 *  - snapshot do último projeto (resiliência a recarregar/ficar offline).
 */

const SETTINGS_KEY = 'fpiw.settings.v1';
const SESSION_KEY = 'fpiw.session.v1';
const EDITS_PREFIX = 'fpiw.edits.v1.';
const SNAPSHOT_PREFIX = 'fpiw.snapshot.v1.';
const MAX_SNAPSHOTS = 3;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function defaultBaseUrl() {
  const stored = readJson(SETTINGS_KEY, {});
  if (stored && stored.baseUrl) return stored.baseUrl;
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname)) {
      return location.origin;
    }
    return 'http://127.0.0.1:8080';
  }
  return 'http://127.0.0.1:8080';
}

export function loadSettings() {
  const stored = readJson(SETTINGS_KEY, {});
  return {
    baseUrl: stored.baseUrl || defaultBaseUrl(),
    sidebarHidden: stored.sidebarHidden === true,
    lastProjectPath: typeof stored.lastProjectPath === 'string' ? stored.lastProjectPath : '',
  };
}

export function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };
  const ok = writeJson(SETTINGS_KEY, next);
  return { ...next, persisted: ok };
}

export function loadSession() {
  const stored = readJson(SESSION_KEY, null);
  if (!stored || typeof stored !== 'object') return null;
  return {
    workspaceId: String(stored.workspaceId || ''),
    openPaths: Array.isArray(stored.openPaths) ? stored.openPaths.map(String) : [],
    activePath: stored.activePath ? String(stored.activePath) : '',
    savedAt: stored.savedAt || null,
  };
}

export function saveSession(session) {
  return writeJson(SESSION_KEY, {
    workspaceId: session.workspaceId || '',
    openPaths: session.openPaths || [],
    activePath: session.activePath || '',
    savedAt: new Date().toISOString(),
  });
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* melhor esforço */
  }
}

export function readEdits(workspaceId) {
  if (!workspaceId) return {};
  const value = readJson(`${EDITS_PREFIX}${workspaceId}`, {});
  return value && typeof value === 'object' ? value : {};
}

export function writeEdits(workspaceId, edits) {
  if (!workspaceId) return true;
  const key = `${EDITS_PREFIX}${workspaceId}`;
  if (!edits || Object.keys(edits).length === 0) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* melhor esforço */
    }
    return true;
  }
  return writeJson(key, edits);
}

export function clearEdits(workspaceId) {
  if (!workspaceId) return;
  try {
    localStorage.removeItem(`${EDITS_PREFIX}${workspaceId}`);
  } catch {
    /* melhor esforço */
  }
}

function snapshotKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(SNAPSHOT_PREFIX)) keys.push(key);
    }
  } catch {
    /* melhor esforço */
  }
  return keys;
}

function pruneSnapshots(keepKey) {
  const entries = snapshotKeys()
    .map((key) => {
      const value = readJson(key, null);
      return { key, savedAt: (value && value.savedAt) || '' };
    })
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  for (const entry of entries.slice(MAX_SNAPSHOTS)) {
    if (entry.key === keepKey) continue;
    try {
      localStorage.removeItem(entry.key);
    } catch {
      /* melhor esforço */
    }
  }
}

export function writeSnapshot(workspaceId, snapshot) {
  if (!workspaceId) return false;
  const key = `${SNAPSHOT_PREFIX}${workspaceId}`;
  const ok = writeJson(key, { ...snapshot, savedAt: new Date().toISOString() });
  if (ok) pruneSnapshots(key);
  return ok;
}

export function readSnapshot(workspaceId) {
  if (!workspaceId) return null;
  return readJson(`${SNAPSHOT_PREFIX}${workspaceId}`, null);
}

export function clearSnapshot(workspaceId) {
  if (!workspaceId) return;
  try {
    localStorage.removeItem(`${SNAPSHOT_PREFIX}${workspaceId}`);
  } catch {
    /* melhor esforço */
  }
}

export function clearLocalData() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith('fpiw.')) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* melhor esforço */
  }
}
