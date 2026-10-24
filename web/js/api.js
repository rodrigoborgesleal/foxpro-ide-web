'use strict';

/**
 * Cliente HTTP da API do FoxPro Local Bridge Service.
 */

export class ApiError extends Error {
  constructor(message, code = 'API_ERROR', status = 0, details = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function normalizeBaseUrl(value) {
  let base = String(value || '').trim();
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  return base.replace(/\/+$/, '');
}

async function request(baseUrl, path, options = {}) {
  const url = `${baseUrl}${path}`;
  const controller = options.timeout ? new AbortController() : null;
  const timer =
    controller && options.timeout
      ? setTimeout(() => controller.abort(), options.timeout)
      : null;

  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller ? controller.signal : undefined,
      cache: 'no-store',
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new ApiError('O servidor local não respondeu a tempo.', 'TIMEOUT', 0);
    }
    throw new ApiError(
      `Não foi possível conectar em ${baseUrl}. Verifique se o FoxPro IDE Web está aberto.`,
      'OFFLINE',
      0,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      (payload && payload.error) || `Falha na requisição (HTTP ${response.status}).`,
      (payload && payload.code) || 'HTTP_ERROR',
      response.status,
      payload && payload.details,
    );
  }
  if (!payload) {
    throw new ApiError('Resposta inválida do servidor local.', 'INVALID_RESPONSE', response.status);
  }
  return payload;
}

export function createApi(getBaseUrl) {
  const base = () => normalizeBaseUrl(getBaseUrl());

  return {
    base,
    status() {
      return request(base(), '/api/status', { timeout: 5000 });
    },
    logs(lines = 200) {
      return request(base(), `/api/logs?lines=${encodeURIComponent(lines)}`, { timeout: 8000 });
    },
    listWorkspaces() {
      return request(base(), '/api/project/list', { timeout: 8000 });
    },
    loadWorkspace(id) {
      return request(base(), `/api/project/load?id=${encodeURIComponent(id)}`, { timeout: 20000 });
    },
    importProject(path, timeoutMs) {
      return request(base(), '/api/project/import', {
        method: 'POST',
        body: { path, timeoutMs },
        timeout: 30 * 60 * 1000,
      });
    },
    compile(id, files, timeoutMs) {
      return request(base(), '/api/project/compile', {
        method: 'POST',
        body: { id, files, timeoutMs },
        timeout: 30 * 60 * 1000,
      });
    },
    save(id, files) {
      return request(base(), '/api/project/save', {
        method: 'POST',
        body: { id, files },
        timeout: 60000,
      });
    },
    deleteWorkspace(id) {
      return request(base(), `/api/project?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        timeout: 15000,
      });
    },
    fsList(path) {
      return request(
        base(),
        `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`,
        { timeout: 10000 },
      );
    },
    zipUrl(id) {
      return `${base()}/api/project/download?id=${encodeURIComponent(id)}`;
    },
  };
}
