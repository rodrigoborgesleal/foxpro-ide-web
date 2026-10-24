'use strict';

/**
 * FoxPro IDE Web - Local Bridge Service
 *
 * Servidor HTTP em loopback que:
 *  - serve a IDE web (Monaco) empacotada;
 *  - expõe a API REST usada pela IDE;
 *  - executa o FoxBin2Prg embutido para descompilar/recompilar projetos VFP.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const {
  ServiceError,
  importProject,
  loadWorkspace,
  saveWorkspace,
  compileProject,
  listWorkspaces,
  deleteWorkspace,
  readLastZip,
  getHealth,
  getVfpPath,
  enqueue,
} = require('./core');
const { loadConfig, getConfigPath, getLogFile } = require('./config');
const { createLogger, readLogTail } = require('./log');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;
const DEFAULT_MAX_BODY = 256 * 1024 * 1024;

function resolveWebDir() {
  const candidates = [
    process.env.FPIW_WEB_DIR,
    process.versions.electron && process.resourcesPath
      ? path.join(process.resourcesPath, 'web')
      : null,
    path.join(__dirname, '..', 'web'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html'))) || null;
}

const WEB_DIR = resolveWebDir();

const MIME_TYPES = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['ico', 'image/x-icon'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['map', 'application/json; charset=utf-8'],
  ['txt', 'text/plain; charset=utf-8'],
  ['md', 'text/markdown; charset=utf-8'],
]);

function allowedOrigin(origin) {
  if (!origin) return '';
  try {
    const value = new URL(origin);
    if (value.protocol !== 'http:' && value.protocol !== 'https:') return '';
    const host = value.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      return origin;
    }
  } catch {
    /* origem inválida */
  }
  return '';
}

function allowedHost(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (!value) return false;
  const host = value.replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function setCors(req, res) {
  const origin = allowedOrigin(req.headers.origin);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, maxBody) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) {
      throw new ServiceError('Corpo da requisição muito grande.', 'BODY_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError('JSON inválido.', 'INVALID_JSON');
  }
}

function httpStatusFor(error) {
  if (!(error instanceof ServiceError)) return 500;
  const code = String(error.code || '');
  if (/INVALID|NOT_FOUND|NO_FILES|NO_SOURCE|UNKNOWN_FILE|TEXT_ENCODING|EMPTY|MISSING|VFP_NOT_FOUND|WORKSPACE_NOT_FOUND/.test(code)) {
    return 400;
  }
  return 500;
}

function safeError(error) {
  const known = error instanceof ServiceError;
  return {
    ok: false,
    error: error && error.message ? error.message : 'Erro desconhecido.',
    code: known ? error.code : 'INTERNAL_ERROR',
    details: known && loadConfig().debug ? error.details : undefined,
  };
}

function serveStatic(req, res, pathname) {
  if (!WEB_DIR) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('A pasta web/ da IDE não foi encontrada no pacote.');
    return;
  }

  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Caminho inválido.');
    return;
  }
  if (relative === '/' || relative === '') relative = '/index.html';
  const file = path.normalize(path.join(WEB_DIR, relative));
  const relativeToWeb = path.relative(WEB_DIR, file);
  if (
    !relativeToWeb ||
    relativeToWeb.startsWith('..') ||
    path.isAbsolute(relativeToWeb)
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acesso negado.');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Arquivo não encontrado.');
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Arquivo não encontrado.');
    return;
  }

  const ext = path.extname(file).replace(/^\./, '').toLowerCase();
  const type = MIME_TYPES.get(ext) || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': ext === 'html' ? 'no-store' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

function listDirectory(input) {
  const target = String(input || '').trim();
  if (!target) {
    const roots = [];
    for (let code = 65; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (fs.existsSync(drive)) roots.push({ name: drive, path: drive });
    }
    const home = process.env.USERPROFILE || require('os').homedir();
    if (home && !roots.some((root) => root.path.toLowerCase() === home.toLowerCase())) {
      roots.unshift({ name: home, path: home });
    }
    return { ok: true, path: '', parent: null, roots, dirs: [], files: [] };
  }

  const abs = path.resolve(target);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new ServiceError(`Pasta não encontrada: ${abs}`, 'PATH_NOT_FOUND');
  }
  if (!stat.isDirectory()) {
    throw new ServiceError(`O caminho não é uma pasta: ${abs}`, 'NOT_A_DIRECTORY');
  }

  const dirs = [];
  const files = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: full });
    } else if (entry.isFile() && /\.(pjx|pjt)$/i.test(entry.name)) {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
      files.push({ name: entry.name, path: full, size });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  return {
    ok: true,
    path: abs,
    parent: path.dirname(abs) === abs ? null : path.dirname(abs),
    dirs,
    files,
  };
}

function createFoxProIdeServer(options = {}) {
  const config = loadConfig();
  const host = String(options.host || process.env.FPIW_HOST || config.host || DEFAULT_HOST);
  const port = Number(options.port || process.env.FPIW_PORT || config.port || DEFAULT_PORT);
  const maxBody = Number(options.maxBody || process.env.FPIW_MAX_BODY || DEFAULT_MAX_BODY);
  const logger = options.logger || createLogger({ mirror: true });

  let listening = false;
  let actualPort = port;
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    if (!allowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Host não permitido. Use 127.0.0.1 ou localhost.');
      return;
    }
    setCors(req, res);
    const url = new URL(req.url, `http://${host}:${actualPort}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Content-Length': '0' });
      res.end();
      return;
    }

    const isApi = url.pathname.startsWith('/api/');
    // O front-end consulta /api/status periodicamente; não poluir o log com o polling.
    const isStatusPoll = req.method === 'GET' && url.pathname === '/api/status';
    res.on('finish', () => {
      if (isApi && !isStatusPoll) {
        logger.log(`${req.method} ${url.pathname} -> ${res.statusCode} (${Date.now() - started}ms)`);
      }
    });

    try {
      if (!isApi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'Método não suportado.' });
          return;
        }
        serveStatic(req, res, url.pathname);
        return;
      }

      if (url.pathname === '/api/status' && req.method === 'GET') {
        sendJson(res, 200, {
          ...getHealth(),
          server: {
            host,
            port: actualPort,
            url: `http://${host}:${actualPort}`,
            ideUrl: `http://${host}:${actualPort}/`,
          },
        });
        return;
      }

      if (url.pathname === '/api/logs' && req.method === 'GET') {
        const requested = Number(url.searchParams.get('lines') || 200);
        const lines = Math.max(1, Math.min(2000, Number.isFinite(requested) ? requested : 200));
        const text = readLogTail(lines);
        sendJson(res, 200, {
          ok: true,
          file: getLogFile(),
          lines: text ? text.split(/\r?\n/) : [],
          text,
        });
        return;
      }

      if (url.pathname === '/api/project/list' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, workspaces: listWorkspaces() });
        return;
      }

      if (url.pathname === '/api/project/load' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        sendJson(res, 200, loadWorkspace(id));
        return;
      }

      if (url.pathname === '/api/project/download' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const zip = readLastZip(id);
        if (!zip) {
          throw new ServiceError('Nenhum pacote compilado disponível para este projeto.', 'ZIP_NOT_FOUND');
        }
        const manifestLess = id.replace(/[^a-zA-Z0-9._-]+/g, '_');
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${manifestLess}.recompilado.zip"`,
          'Content-Length': zip.length,
          'Cache-Control': 'no-store',
        });
        res.end(zip);
        return;
      }

      if (url.pathname === '/api/fs/list' && req.method === 'GET') {
        sendJson(res, 200, listDirectory(url.searchParams.get('path') || ''));
        return;
      }

      if (url.pathname === '/api/project/import' && req.method === 'POST') {
        const body = await readJsonBody(req, maxBody);
        const projectPath = body.path || body.projectPath || '';
        logger.log(`import solicitado: ${projectPath}`);
        const result = await enqueue(() =>
          importProject(projectPath, { timeoutMs: body.timeoutMs, logger }),
        );
        sendJson(res, 200, result);
        return;
      }

      if (url.pathname === '/api/project/compile' && req.method === 'POST') {
        const body = await readJsonBody(req, maxBody);
        logger.log(
          `compile solicitado: workspace=${body.id} arquivos=${Array.isArray(body.files) ? body.files.length : 0}`,
        );
        const result = await enqueue(() =>
          compileProject(body, { timeoutMs: body.timeoutMs, logger }),
        );
        sendJson(res, 200, result);
        return;
      }

      if (url.pathname === '/api/project/save' && req.method === 'POST') {
        const body = await readJsonBody(req, maxBody);
        const result = saveWorkspace(String(body.id || ''), body.files || [], { logger });
        sendJson(res, 200, result);
        return;
      }

      if (url.pathname === '/api/project' && req.method === 'DELETE') {
        const id = String(url.searchParams.get('id') || '');
        sendJson(res, 200, deleteWorkspace(id));
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Rota não encontrada.', code: 'NOT_FOUND' });
    } catch (error) {
      const status = httpStatusFor(error);
      logger.error(`ERRO ${req.method} ${url.pathname}: ${error.message}`);
      if (status >= 500 && error.details && loadConfig().debug) {
        logger.error(error.details);
      }
      sendJson(res, status, { ...safeError(error), ms: Date.now() - started });
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('error', (err) => {
    logger.error(`erro no servidor: ${err.message}`);
  });

  function info() {
    return {
      host,
      port: actualPort,
      url: `http://${host}:${actualPort}`,
      ideUrl: `http://${host}:${actualPort}/`,
      running: listening,
    };
  }

  function start() {
    if (listening) return Promise.resolve(info());
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        listening = true;
        actualPort = server.address().port;
        logger.log(`servidor escutando em ${info().url} (web: ${WEB_DIR || 'não encontrada'})`);
        resolve(info());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!listening) {
        resolve();
        return;
      }
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close(() => {
        listening = false;
        resolve();
      });
      setTimeout(() => {
        listening = false;
        resolve();
      }, 2000).unref();
    });
  }

  return {
    server,
    start,
    stop,
    info,
    get running() {
      return listening;
    },
  };
}

async function startServer(options = {}) {
  const app = createFoxProIdeServer(options);
  try {
    await app.start();
    return app;
  } catch (error) {
    await app.stop().catch(() => {});
    throw error;
  }
}

if (require.main === module) {
  const logger = createLogger({ mirror: true });
  startServer({ logger })
    .then((app) => {
      const info = app.info();
      const vfp = getVfpPath();
      console.log('');
      console.log('  FoxPro IDE Web - Local Bridge Service');
      console.log(`  IDE    : ${info.ideUrl}`);
      console.log(`  API    : ${info.url}/api/status`);
      console.log(`  VFP    : ${vfp || 'NÃO ENCONTRADO (defina nas configurações ou em FPIW_VFP)'}`);
      console.log(`  Config : ${getConfigPath()}`);
      console.log(`  Log    : ${getLogFile()}`);
      console.log('');
      console.log('  Deixe esta janela aberta e use a IDE no navegador.');
      console.log('  Ctrl+C encerra.');
      console.log('');

      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
          console.log('\nEncerrando...');
          app.stop().finally(() => process.exit(0));
        });
      }
    })
    .catch((error) => {
      if (error && error.code === 'EADDRINUSE') {
        console.error(
          `A porta ${loadConfig().port} já está em uso. Feche o outro processo ou altere a porta.`,
        );
      } else {
        console.error('Erro ao iniciar o servidor:', error.message || error);
      }
      process.exit(1);
    });
}

module.exports = {
  createFoxProIdeServer,
  startServer,
  resolveWebDir,
  WEB_DIR,
};
