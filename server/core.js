'use strict';

/**
 * Núcleo do FoxPro IDE Web.
 *
 * Responsável por:
 *  - preparar o runtime embutido do FoxBin2Prg em %TEMP% (sem instalar nada);
 *  - importar um projeto .pjx/.pjt (cópia isolada + descompilação em textos);
 *  - manter as fontes editadas no workspace do usuário;
 *  - recompilar os textos editados com FoxBin2Prg e devolver um ZIP.
 *
 * O Visual FoxPro 9 é usado como host de execução do FoxBin2Prg (o PRG roda
 * dentro do VFP). O caminho do vfp9.exe é configurável; se não for informado,
 * procuramos as instalações padrão.
 */

const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  loadConfig,
  getWorkspacesDir,
  getRuntimeDir,
  getConfigPath,
} = require('./config');
const { createZip } = require('./zip');
const { logger: defaultLogger } = require('./log');

const VENDOR_FB2P = path.join(__dirname, 'vendor', 'foxbin2prg');
const WRAPPER_SRC = path.join(__dirname, 'vfp', 'fb2p_batch.prg');
const RUNTIME_FB2P = path.join(getRuntimeDir(), 'foxbin2prg');
const RUNTIME_WRAPPER = path.join(RUNTIME_FB2P, 'fb2p_batch.prg');
const VFP_CONFIG_FB2P = path.join(getRuntimeDir(), 'config-fb2p.fpw');
const FB2P_VERSION = '1.21.05';
const FB2P_MARKER = path.join(RUNTIME_FB2P, '.foxpro-ide-web-vendor');

// Em VFP 9 RTM (build 2412) o FoxBin2Prg oficial recusa a execução por não
// encontrar o SP1. O código usado nas conversões não depende do SP1
// (round-trip validado); a cópia em %TEMP% recebe apenas a troca do limite.
const FB2P_VERSION_GUARD = ') < 3504';
const FB2P_VERSION_GUARD_RTM = ') < 0';

const TEXT_EXTENSIONS = new Set([
  'prg',
  'sc2',
  'vc2',
  'fr2',
  'mn2',
  'lb2',
  'pj2',
  'h',
  'ini',
  'txt',
]);

// Texto editável -> binário gerado pelo FoxBin2Prg.
const TEXT_TO_BINARY = new Map([
  ['sc2', 'scx'],
  ['vc2', 'vcx'],
  ['fr2', 'frx'],
  ['mn2', 'mnx'],
  ['lb2', 'lbx'],
  ['pj2', 'pjx'],
]);

// Binário -> memo companheiro (o código dos métodos fica no memo).
const MEMO_EXTENSION = new Map([
  ['scx', 'sct'],
  ['vcx', 'vct'],
  ['frx', 'frt'],
  ['mnx', 'mnt'],
  ['lbx', 'lbt'],
  ['pjx', 'pjt'],
  ['dbc', 'dct'],
]);

const BINARY_EXTENSIONS = new Set(['scx', 'vcx', 'frx', 'mnx', 'lbx', 'dbc', 'pjx']);

const CATEGORY_BY_EXT = new Map([
  ['prg', 'programs'],
  ['sc2', 'forms'],
  ['vc2', 'classes'],
  ['fr2', 'reports'],
  ['mn2', 'menus'],
]);

const TYPE_BY_EXT = new Map([
  ['prg', 'PRG'],
  ['sc2', 'FORM'],
  ['vc2', 'CLASS'],
  ['fr2', 'REPORT'],
  ['mn2', 'MENU'],
  ['lb2', 'LABEL'],
  ['pj2', 'PROJECT'],
  ['h', 'HEADER'],
  ['ini', 'CONFIG'],
  ['txt', 'TEXT'],
]);

const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'dist',
  'build',
  'bin',
  'obj',
  'coverage',
  '.vs',
  '.vscode',
  '.idea',
  '.fpi',
]);

const SKIP_FILE_EXTENSIONS = new Set([
  'bak',
  'fxp',
  'exe',
  'app',
  'dll',
  'zip',
  'rar',
  '7z',
  'gz',
  'log',
  'err',
  'tmp',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'cur',
  'wav',
  'mp3',
  'avi',
  'mp4',
  'pdf',
]);

const SUPPORT_EXTENSIONS = new Set(['prg', 'h', 'ini', 'txt']);

const MAX_SUPPORT_FILES = 3000;
const MAX_SUPPORT_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;

// Sentinela de migração: workspaces da 1.0.0 não guardavam o hash de
// referência. Arquivos salvos depois da importação ficam marcados como
// modificados até serem recompilados uma vez.
const LEGACY_MODIFIED = 'legacy:saved-after-import';

class ServiceError extends Error {
  constructor(message, code = 'SERVICE_ERROR', details = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDir(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function normalizeRelative(value) {
  return toPosix(path.normalize(String(value))).replace(/^\.\/+/, '');
}

function extOf(file) {
  return path.extname(String(file)).replace(/^\./, '').toLowerCase();
}

function stemOf(file) {
  return path.basename(String(file), path.extname(String(file)));
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return `${path.basename(file)}:${stat.size}:${stat.mtimeMs}:${sha1(fs.readFileSync(file))}`;
  } catch {
    return null;
  }
}

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    if (fs.statSync(from).isDirectory()) {
      copyDirectory(from, to);
    } else {
      fs.writeFileSync(to, fs.readFileSync(from));
    }
  }
}

function copyDirectoryFiltered(source, target, skip) {
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    let stat;
    try {
      stat = fs.statSync(from);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (skip && skip(from, name, true)) continue;
      copyDirectoryFiltered(from, to, skip);
    } else {
      if (skip && skip(from, name, false)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, fs.readFileSync(from));
    }
  }
}

function getVfpPath() {
  const config = loadConfig();
  const candidates = [
    process.env.FPIW_VFP,
    config.vfpPath,
    'C:\\Program Files (x86)\\Microsoft Visual FoxPro 9\\vfp9.exe',
    'C:\\Program Files\\Microsoft Visual FoxPro 9\\vfp9.exe',
  ].filter(Boolean);
  return candidates.find(isFile) || null;
}

function getTimeoutMs(override) {
  const env = Number(process.env.FPIW_TIMEOUT_MS);
  const config = loadConfig();
  const value =
    Number(override) > 0
      ? Number(override)
      : Number.isFinite(env) && env > 0
        ? env
        : config.timeoutMs;
  return Number.isFinite(value) && value >= 10000 ? Math.min(value, 1800000) : 300000;
}

function isKeepJobs() {
  return process.env.FPIW_KEEP === '1' || loadConfig().keepJobs;
}

function isFoxBin2PrgAvailable() {
  return Boolean(
    fs.existsSync(path.join(VENDOR_FB2P, 'foxbin2prg.prg')) &&
      fs.existsSync(path.join(VENDOR_FB2P, 'props_all.txt')) &&
      fs.existsSync(WRAPPER_SRC),
  );
}

let runtimeSignature = null;
let runtimePatched = false;

/**
 * Copia o FoxBin2Prg para %TEMP% e aplica o ajuste para VFP 9 RTM.
 * A pasta server/vendor permanece intacta.
 */
function installFoxBin2Prg() {
  if (!isFoxBin2PrgAvailable()) return false;

  const signature = [
    FB2P_VERSION,
    fileSignature(path.join(VENDOR_FB2P, 'foxbin2prg.prg')),
    fileSignature(path.join(VENDOR_FB2P, 'props_all.txt')),
    fileSignature(path.join(VENDOR_FB2P, 'foxbin2prg_keywords.dbf')),
    fileSignature(WRAPPER_SRC),
  ].join('|');

  if (
    runtimeSignature === signature &&
    fs.existsSync(FB2P_MARKER) &&
    fs.existsSync(path.join(RUNTIME_FB2P, 'foxbin2prg.prg')) &&
    fs.existsSync(RUNTIME_WRAPPER)
  ) {
    runtimePatched = true;
    return true;
  }

  const marker = fs.existsSync(FB2P_MARKER)
    ? fs.readFileSync(FB2P_MARKER, 'utf8').trim()
    : '';
  if (marker !== signature || !fs.existsSync(path.join(RUNTIME_FB2P, 'foxbin2prg.prg'))) {
    fs.rmSync(RUNTIME_FB2P, { recursive: true, force: true });
    fs.mkdirSync(RUNTIME_FB2P, { recursive: true });
    copyDirectory(VENDOR_FB2P, RUNTIME_FB2P);
  }

  const prg = path.join(RUNTIME_FB2P, 'foxbin2prg.prg');
  let source = fs.readFileSync(prg, 'latin1');
  if (source.includes(FB2P_VERSION_GUARD)) {
    source = source.replace(FB2P_VERSION_GUARD, FB2P_VERSION_GUARD_RTM);
    fs.writeFileSync(prg, source, 'latin1');
    runtimePatched = true;
  } else {
    runtimePatched = source.includes(FB2P_VERSION_GUARD_RTM);
  }

  const config = [
    '* FoxPro IDE Web - round-trip via FoxBin2Prg',
    'ClearUniqueID: 0',
    'NoTimestamps: 0',
    'ShowProgressbar: 0',
    'DontShowErrors: 1',
    'ExtraBackupLevels: 0',
    'SCX_Conversion_Support: 2',
    'VCX_Conversion_Support: 2',
    'FRX_Conversion_Support: 2',
    'MNX_Conversion_Support: 2',
    'LBX_Conversion_Support: 2',
    'PJX_Conversion_Support: 2',
    'UseClassPerFile: 0',
    'UseFormPerFile: 0',
    'UseFormSettings: 0',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(RUNTIME_FB2P, 'foxbin2prg.cfg'), config, 'latin1');

  const wrapper = fs.readFileSync(WRAPPER_SRC);
  const current = fs.existsSync(RUNTIME_WRAPPER) ? fs.readFileSync(RUNTIME_WRAPPER) : null;
  if (!current || !wrapper.equals(current)) {
    fs.writeFileSync(RUNTIME_WRAPPER, wrapper);
  }

  const fpw = [
    `COMMAND = DO ("${RUNTIME_WRAPPER}")`,
    'RESOURCE = OFF',
    '',
  ].join('\r\n');
  const currentFpw = fs.existsSync(VFP_CONFIG_FB2P)
    ? fs.readFileSync(VFP_CONFIG_FB2P, 'latin1')
    : '';
  if (currentFpw !== fpw) {
    fs.writeFileSync(VFP_CONFIG_FB2P, fpw, 'latin1');
  }

  fs.writeFileSync(FB2P_MARKER, signature, 'utf8');
  runtimeSignature = signature;
  return true;
}

const CP1252_EXTRA = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/**
 * Texto editado chega em UTF-8/JS; o VFP e o FoxBin2Prg usam cp1252.
 * Caracteres fora da cp1252 são rejeitados para não gravar dados corrompidos.
 */
function encodeCp1252(text) {
  const normalized = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '\r\n');
  const bytes = Buffer.alloc(normalized.length);
  let offset = 0;
  for (const char of normalized) {
    const code = char.codePointAt(0);
    let byte;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      byte = code;
    } else if (CP1252_EXTRA.has(code)) {
      byte = CP1252_EXTRA.get(code);
    } else {
      throw new ServiceError(
        `O texto contém o caractere "${char}" (U+${code
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')}), que não existe no cp1252 usado pelo VFP. ` +
          'Remova ou substitua esse caractere antes de salvar/compilar.',
        'TEXT_ENCODING',
      );
    }
    bytes[offset] = byte;
    offset += 1;
  }
  return bytes.subarray(0, offset);
}

function decodeCp1252(buffer) {
  return new TextDecoder('windows-1252').decode(buffer);
}

function normalizeSc2(text) {
  return String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('*< FOXBIN2PRG:'))
    .map((line) =>
      line.replace(/_memberdata\s*=\s*"<VFPData><\/VFPData>"/, '_memberdata = '),
    );
}

function compareText(left, right) {
  const counts = new Map();
  for (const line of normalizeSc2(left)) {
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  let added = 0;
  let removed = 0;
  const sample = [];
  for (const line of normalizeSc2(right)) {
    const count = counts.get(line) || 0;
    if (count > 0) {
      counts.set(line, count - 1);
    } else {
      added += 1;
      if (sample.length < 8) sample.push(`+ ${line.slice(0, 200)}`);
    }
  }
  for (const [line, count] of counts) {
    if (count > 0) {
      removed += count;
      if (sample.length < 8) sample.push(`- ${line.slice(0, 200)}`);
    }
  }
  return { identical: added === 0 && removed === 0, added, removed, sample };
}

function runVfp(jobDir, timeoutMs, logger = defaultLogger) {
  const vfpExe = getVfpPath();
  if (!vfpExe) {
    return Promise.reject(
      new ServiceError(
        'Visual FoxPro 9 não encontrado. Informe o caminho do vfp9.exe nas configurações ' +
          'do FoxPro IDE Web (ou defina a variável FPIW_VFP).',
        'VFP_NOT_FOUND',
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(vfpExe, ['-t', `-c${VFP_CONFIG_FB2P}`], {
      cwd: jobDir,
      env: {
        ...process.env,
        FPI_JOB: jobDir,
        FPI_FB2P: RUNTIME_FB2P,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('latin1')).slice(-4000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('latin1')).slice(-4000);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      reject(
        new ServiceError(
          `O Visual FoxPro não respondeu em ${Math.round(timeoutMs / 1000)}s. ` +
            'Verifique se há um diálogo aberto na área de trabalho.',
          'VFP_TIMEOUT',
          { stdout, stderr },
        ),
      );
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ServiceError(`Falha ao iniciar o VFP: ${err.message}`, 'VFP_SPAWN_FAILED'));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.log(`VFP finalizado (codigo ${code}) em ${Date.now() - started}ms`);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

function sanitizeMessage(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

/**
 * Executa uma lista de tarefas em um único processo VFP.
 * @param {string} workDir raiz do job (tasks.txt e status ficam aqui)
 * @param {Array<{type: 'BIN2PRG'|'PRG2BIN', file: string}>} tasks
 */
async function runBatch(workDir, tasks, timeoutMs, logger = defaultLogger) {
  fs.mkdirSync(workDir, { recursive: true });
  const tasksFile = path.join(workDir, 'tasks.txt');
  const statusFile = path.join(workDir, 'fb2p-status.txt');
  fs.rmSync(statusFile, { force: true });

  const content = tasks
    .map((task) => `${task.type}\t${task.file}`)
    .join('\r\n');
  fs.writeFileSync(tasksFile, encodeCp1252(`${content}\r\n`));

  logger.log(
    `FoxBin2Prg: ${tasks.length} tarefa(s) em ${workDir} ` +
      `(${tasks.map((t) => `${t.type}:${path.basename(t.file)}`).join(', ')})`,
  );

  const run = await runVfp(workDir, timeoutMs, logger);

  let lines = [];
  try {
    lines = decodeCp1252(fs.readFileSync(statusFile)).split(/\r?\n/);
  } catch {
    lines = [];
  }

  const results = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    results.push({
      index: Number(parts[0]) || 0,
      type: parts[1] || '',
      ok: (parts[2] || '').toLowerCase() === 'ok',
      file: parts[3] || '',
      message: sanitizeMessage(parts[4] || ''),
    });
  }

  if (results.length === 0) {
    throw new ServiceError(
      'O VFP encerrou sem gerar o status das conversões (possível erro ou diálogo modal).',
      'NO_STATUS',
      { exitCode: run.code, stdout: run.stdout, stderr: run.stderr },
    );
  }

  return { run, results };
}

let queueTail = Promise.resolve();
let busy = false;

function enqueue(task) {
  const run = queueTail.then(async () => {
    busy = true;
    try {
      return await task();
    } finally {
      busy = false;
    }
  });
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function makeWorkspaceId(projectFile) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\..+$/, '')
    .slice(0, 14);
  const slug = String(stemOf(projectFile) || 'projeto')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .toLowerCase();
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${stamp}-${slug || 'projeto'}-${suffix}`;
}

function isValidWorkspaceId(id) {
  return /^[a-zA-Z0-9._-]{3,120}$/.test(String(id || ''));
}

function workspaceDir(id) {
  if (!isValidWorkspaceId(id)) {
    throw new ServiceError('Identificador de workspace inválido.', 'INVALID_WORKSPACE');
  }
  const base = getWorkspacesDir();
  const dir = path.join(base, id);
  if (!isInside(base, dir) || dir === base) {
    throw new ServiceError('Identificador de workspace inválido.', 'INVALID_WORKSPACE');
  }
  return dir;
}

function manifestPath(dir) {
  return path.join(dir, '.fpi', 'manifest.json');
}

function readManifest(id) {
  const dir = workspaceDir(id);
  const file = manifestPath(dir);
  if (!isFile(file)) {
    throw new ServiceError('Workspace não encontrado. Importe o projeto novamente.', 'WORKSPACE_NOT_FOUND');
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ServiceError(`Manifesto do workspace inválido: ${error.message}`, 'INVALID_MANIFEST');
  }
}

function writeManifest(dir, manifest) {
  const file = manifestPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function buildCategory(relativePath, mainFile) {
  const rel = normalizeRelative(relativePath);
  const normalizedMain = mainFile ? normalizeRelative(mainFile).toLowerCase() : '';
  if (normalizedMain && rel.toLowerCase() === normalizedMain) return 'main';
  const ext = extOf(rel);
  return CATEGORY_BY_EXT.get(ext) || 'others';
}

function describeFile(dir, relativePath, mainFile) {
  const rel = normalizeRelative(relativePath);
  const abs = path.join(dir, rel);
  const stat = fs.statSync(abs);
  const ext = extOf(rel);
  return {
    path: rel,
    name: path.basename(rel),
    ext,
    type: TYPE_BY_EXT.get(ext) || ext.toUpperCase() || 'FILE',
    category: buildCategory(rel, mainFile),
    bytes: stat.size,
    modified: stat.mtime.toISOString(),
  };
}

/**
 * Lê a lista de arquivos e o programa principal do .pj2 gerado pelo FoxBin2Prg.
 */
function parseProjectText(text) {
  const sourceMatch = text.match(/SourceFile="([^"]+)"/i);
  const mainMatch = text.match(
    /\.SetMain\(\s*(?:lcCurdir\s*\+\s*)?'([^']+)'\s*\)/i,
  );
  const files = [];
  const re = /\.ADD\(\s*'([^']+)'\s*\)/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const value = match[1].trim();
    if (value && !files.some((item) => item.toLowerCase() === value.toLowerCase())) {
      files.push(value);
    }
  }
  return {
    sourceFile: sourceMatch ? sourceMatch[1] : '',
    mainFile: mainMatch ? normalizeRelative(mainMatch[1]) : '',
    files,
  };
}

function copyFileSafe(from, to) {
  try {
    if (!isFile(from)) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return true;
  } catch {
    return false;
  }
}

function copyMemberWithMemo(srcDir, destDir, relative, warnings) {
  const rel = String(relative).trim();
  if (!rel) return null;

  const sourceAbs = path.isAbsolute(rel) ? rel : path.resolve(srcDir, rel);
  if (!isFile(sourceAbs)) {
    warnings.push(`Arquivo do projeto não encontrado: ${rel}`);
    return null;
  }

  let destRel = normalizeRelative(rel);
  if (!isInside(srcDir, sourceAbs)) {
    destRel = normalizeRelative(path.join('_external', path.basename(sourceAbs)));
    warnings.push(
      `Arquivo fora da pasta do projeto foi copiado para _external: ${rel}`,
    );
  }

  const destAbs = path.join(destDir, destRel);
  if (!copyFileSafe(sourceAbs, destAbs)) {
    warnings.push(`Não foi possível copiar: ${rel}`);
    return null;
  }

  const ext = extOf(sourceAbs);
  const memoExt = MEMO_EXTENSION.get(ext);
  if (memoExt) {
    const memoSource = sourceAbs.replace(/\.[^.]+$/, `.${memoExt}`);
    if (isFile(memoSource)) {
      copyFileSafe(memoSource, destAbs.replace(/\.[^.]+$/, `.${memoExt}`));
    }
  }

  if (ext === 'dbc') {
    const stem = sourceAbs.replace(/\.[^.]+$/, '');
    for (const companion of ['dct', 'dcx']) {
      if (isFile(`${stem}.${companion}`)) {
        copyFileSafe(`${stem}.${companion}`, destAbs.replace(/\.[^.]+$/, `.${companion}`));
      }
    }
  }

  return destRel;
}

function copySupportFiles(srcDir, destDir, alreadyCopied, warnings) {
  let copied = 0;
  let bytes = 0;
  const seen = new Set(
    Array.from(alreadyCopied, (item) => normalizeRelative(item).toLowerCase()),
  );

  function walk(dir) {
    if (copied >= MAX_SUPPORT_FILES || bytes >= MAX_SUPPORT_BYTES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (copied >= MAX_SUPPORT_FILES || bytes >= MAX_SUPPORT_BYTES) return;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = entry.name;
      const ext = extOf(name);
      if (!SUPPORT_EXTENSIONS.has(ext)) continue;
      if (SKIP_FILE_EXTENSIONS.has(ext)) continue;
      if (/^(foxuser|leia-me|readme)\./i.test(name)) continue;
      const rel = normalizeRelative(path.relative(srcDir, abs));
      if (seen.has(rel.toLowerCase())) continue;
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_TEXT_FILE_BYTES) continue;
      if (copyFileSafe(abs, path.join(destDir, rel))) {
        seen.add(rel.toLowerCase());
        alreadyCopied.add(rel);
        copied += 1;
        bytes += stat.size;
      }
    }
  }

  walk(srcDir);
  if (copied >= MAX_SUPPORT_FILES) {
    warnings.push(
      `Foram copiados apenas ${MAX_SUPPORT_FILES} arquivos de apoio (limite de segurança).`,
    );
  }
}

function listTextFiles(dir, mainFile, warnings) {
  const files = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extOf(entry.name);
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      if (/^(foxuser|leia-me)\./i.test(entry.name)) continue;
      const rel = normalizeRelative(path.relative(dir, abs));
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_TEXT_FILE_BYTES) {
        warnings.push(`Arquivo grande ignorado na IDE: ${rel}`);
        continue;
      }
      files.push(describeFile(dir, rel, mainFile));
    }
  }
  walk(dir);
  return files;
}

const CATEGORY_ORDER = ['main', 'programs', 'forms', 'classes', 'reports', 'menus', 'others'];

function sortFiles(files) {
  return files.sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category);
    const cb = CATEGORY_ORDER.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    return a.path.localeCompare(b.path, 'pt-BR', { sensitivity: 'base' });
  });
}

function safeBaseName(fileName) {
  const base = path.basename(String(fileName || 'projeto')).replace(/\.[^.]+$/, '');
  return (base || 'projeto').replace(/[\\/:*?"<>|]+/g, '_');
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Importa um projeto .pjx/.pjt: copia os fontes para um workspace isolado,
 * descompila os binários com FoxBin2Prg e devolve os textos para a IDE.
 */
async function importProject(projectPath, options = {}) {
  const raw = String(projectPath || '')
    .trim()
    .replace(/^"(.*)"$/, '$1');
  if (!raw) {
    throw new ServiceError('Informe o caminho do arquivo .pjx/.pjt.', 'INVALID_PATH');
  }

  let abs = path.resolve(raw);
  if (!isFile(abs)) {
    throw new ServiceError(`Arquivo de projeto não encontrado: ${abs}`, 'PROJECT_NOT_FOUND');
  }
  let ext = extOf(abs);
  if (ext === 'pjt') {
    const pjx = abs.replace(/\.[^.]+$/, '.pjx');
    if (!isFile(pjx)) {
      throw new ServiceError(
        'O arquivo .pjt é apenas o memo do projeto. Selecione o .pjx correspondente.',
        'INVALID_PROJECT',
      );
    }
    abs = pjx;
    ext = 'pjx';
  }
  if (ext !== 'pjx') {
    throw new ServiceError('Selecione um arquivo .pjx do Visual FoxPro.', 'INVALID_PROJECT');
  }
  if (!getVfpPath()) {
    throw new ServiceError(
      'Visual FoxPro 9 não encontrado. Informe o caminho do vfp9.exe nas configurações.',
      'VFP_NOT_FOUND',
    );
  }
  if (!installFoxBin2Prg()) {
    throw new ServiceError(
      'O runtime do FoxBin2Prg não está disponível em server/vendor/foxbin2prg.',
      'FOXBIN2PRG_NOT_FOUND',
    );
  }

  const logger = options.logger || defaultLogger;
  const timeoutMs = getTimeoutMs(options.timeoutMs);
  const srcDir = path.dirname(abs);
  const id = makeWorkspaceId(abs);
  const dir = workspaceDir(id);
  const warnings = [];

  fs.mkdirSync(dir, { recursive: true });

  const projectFileRel = normalizeRelative(path.basename(abs));
  const projectFileAbs = path.join(dir, projectFileRel);
  copyFileSafe(abs, projectFileAbs);
  const memoExt = MEMO_EXTENSION.get(ext);
  if (memoExt) {
    const memo = abs.replace(/\.[^.]+$/, `.${memoExt}`);
    if (isFile(memo)) {
      copyFileSafe(memo, projectFileAbs.replace(/\.[^.]+$/, `.${memoExt}`));
    }
  }

  const jobsRoot = path.join(dir, '.fpi', 'jobs');
  const jobDir = path.join(jobsRoot, `import-pj-${Date.now()}`);
  let pj2Text = '';
  let parsed = { sourceFile: path.basename(abs), mainFile: '', files: [] };

  try {
    logger.log(`[${id}] importando ${abs}`);
    const projectBatch = await runBatch(
      jobDir,
      [{ type: 'BIN2PRG', file: projectFileAbs }],
      timeoutMs,
      logger,
    );
    const projectResult = projectBatch.results[0];
    if (!projectResult || !projectResult.ok) {
      throw new ServiceError(
        `Não foi possível descompilar o projeto: ${
          (projectResult && projectResult.message) || 'falha no FoxBin2Prg'
        }`,
        'PROJECT_CONVERT_FAILED',
      );
    }

    const pj2Path = projectFileAbs.replace(/\.[^.]+$/, '.pj2');
    if (!isFile(pj2Path)) {
      throw new ServiceError(
        'O FoxBin2Prg não gerou o arquivo .pj2 do projeto.',
        'PROJECT_TEXT_MISSING',
      );
    }
    pj2Text = decodeCp1252(fs.readFileSync(pj2Path));
    parsed = parseProjectText(pj2Text);
    if (!parsed.files.length) {
      warnings.push(
        'Não foi possível ler a lista de arquivos do .pj2; os fontes encontrados na pasta foram importados.',
      );
    }
  } finally {
    if (!isKeepJobs()) {
      await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const copied = new Set([projectFileRel]);
  const binaryMembers = [];

  for (const member of parsed.files) {
    const rel = copyMemberWithMemo(srcDir, dir, member, warnings);
    if (!rel) continue;
    copied.add(rel);
    const memberExt = extOf(rel);
    if (BINARY_EXTENSIONS.has(memberExt) && memberExt !== 'pjx') {
      // DBC é copiado, mas não convertido (não é código-fonte).
      if (memberExt !== 'dbc') binaryMembers.push(rel);
    }
  }

  // Fallback: se a lista do .pj2 não pôde ser lida, varre a pasta do projeto
  // atrás dos binários de código-fonte suportados.
  if (parsed.files.length === 0) {
    for (const name of fs.readdirSync(srcDir)) {
      const candidate = path.join(srcDir, name);
      if (!isFile(candidate)) continue;
      const candidateExt = extOf(name);
      if (!BINARY_EXTENSIONS.has(candidateExt)) continue;
      if (candidateExt === 'pjx' || candidateExt === 'dbc') continue;
      const rel = copyMemberWithMemo(srcDir, dir, name, warnings);
      if (!rel) continue;
      copied.add(rel);
      binaryMembers.push(rel);
    }
  }

  copySupportFiles(srcDir, dir, copied, warnings);

  if (binaryMembers.length > 0) {
    const memberJob = path.join(jobsRoot, `import-members-${Date.now()}`);
    const tasks = binaryMembers.map((rel) => ({
      type: 'BIN2PRG',
      file: path.join(dir, rel),
    }));
    try {
      const batch = await runBatch(memberJob, tasks, timeoutMs, logger);
      for (const result of batch.results) {
        if (!result.ok) {
          const rel = normalizeRelative(path.relative(dir, result.file));
          warnings.push(`Falha ao descompilar ${rel}: ${result.message || 'erro desconhecido'}`);
        }
      }
    } finally {
      if (!isKeepJobs()) {
        await fsp.rm(memberJob, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  if (!parsed.mainFile) {
    const candidates = ['main.prg', 'principal.prg', 'programa.prg'];
    for (const candidate of candidates) {
      if (isFile(path.join(dir, candidate))) {
        parsed.mainFile = candidate;
        break;
      }
    }
  }

  let files = listTextFiles(dir, parsed.mainFile, warnings);
  if (!files.length) {
    throw new ServiceError(
      'Nenhum arquivo de código-fonte foi encontrado após a conversão.',
      'NO_SOURCE_FILES',
    );
  }

  // Remove eventuais duplicatas (mesmo caminho em caixas diferentes).
  const unique = new Map();
  for (const file of files) unique.set(file.path.toLowerCase(), file);
  files = sortFiles(Array.from(unique.values()));

  // Referência do texto no momento da importação. O marcador M e o conjunto
  // enviado para compilação comparam o conteúdo atual com este hash; salvar
  // não altera a referência, apenas uma compilação bem-sucedida.
  for (const file of files) {
    try {
      file.baselineHash = sha1(fs.readFileSync(path.join(dir, file.path)));
    } catch {
      /* o arquivo será reportado como ausente em loadWorkspace */
    }
  }

  const manifest = {
    id,
    name: path.basename(abs),
    projectPath: abs,
    projectFile: projectFileRel,
    mainFile: parsed.mainFile || '',
    sourceDir: srcDir,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    files: files.map((file) => ({ ...file })),
    warnings: Array.from(new Set(warnings)),
    foxbin2prg: { version: FB2P_VERSION, patchedForVfp9Rtm: runtimePatched },
  };
  writeManifest(dir, manifest);

  logger.log(
    `[${id}] projeto importado: ${files.length} arquivo(s), ` +
      `${warnings.length} aviso(s), main=${manifest.mainFile || '(não definido)'}`,
  );

  return loadWorkspace(id, { logger });
}

/**
 * Carrega o manifesto + conteúdo atual dos textos do workspace.
 */
function loadWorkspace(id, options = {}) {
  const dir = workspaceDir(id);
  const manifest = readManifest(id);
  const warnings = [...(manifest.warnings || [])];
  const files = [];
  let patchedBaseline = false;

  for (const meta of manifest.files || []) {
    const abs = path.join(dir, meta.path);
    if (!isFile(abs)) {
      warnings.push(`Arquivo ausente no workspace: ${meta.path}`);
      continue;
    }
    let content;
    let changed = false;
    try {
      const buffer = fs.readFileSync(abs);
      content = decodeCp1252(buffer);
      const hash = sha1(buffer);
      if (!meta.baselineHash) {
        // Workspaces criados antes do controle de referência não têm o hash
        // original. Se o arquivo foi salvo depois da importação, assume que
        // está modificado até a próxima compilação; caso contrário, adota o
        // estado atual como base para não marcar tudo.
        const savedAfterImport =
          Boolean(meta.modified) &&
          Boolean(manifest.createdAt) &&
          String(meta.modified) > String(manifest.createdAt);
        meta.baselineHash = savedAfterImport ? LEGACY_MODIFIED : hash;
        patchedBaseline = true;
      }
      changed = meta.baselineHash !== hash;
    } catch (error) {
      warnings.push(`Não foi possível ler ${meta.path}: ${error.message}`);
      continue;
    }
    files.push({ ...meta, content, changed });
  }

  if (patchedBaseline) writeManifest(dir, manifest);

  sortFiles(files);
  return {
    ok: true,
    workspace: {
      id: manifest.id,
      name: manifest.name,
      projectPath: manifest.projectPath,
      projectFile: manifest.projectFile,
      mainFile: manifest.mainFile,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      files: (manifest.files || []).map((file) => ({ ...file })),
      warnings: Array.from(new Set(warnings)),
      foxbin2prg: manifest.foxbin2prg || { version: FB2P_VERSION },
    },
    files: files.map((file) => ({
      path: file.path,
      name: file.name,
      ext: file.ext,
      type: file.type,
      category: file.category,
      bytes: file.bytes,
      modified: file.modified,
      changed: file.changed,
      content: file.content,
    })),
    server: options.server,
  };
}

function validateEditablePath(manifest, relative) {
  const rel = normalizeRelative(relative);
  if (!rel || path.isAbsolute(rel) || rel.startsWith('..')) {
    throw new ServiceError(`Caminho inválido: ${relative}`, 'INVALID_FILE_PATH');
  }
  const known = (manifest.files || []).some(
    (file) => normalizeRelative(file.path).toLowerCase() === rel.toLowerCase(),
  );
  if (!known) {
    throw new ServiceError(`Arquivo não pertence ao projeto: ${relative}`, 'UNKNOWN_FILE');
  }
  return (manifest.files || []).find(
    (file) => normalizeRelative(file.path).toLowerCase() === rel.toLowerCase(),
  ).path;
}

/**
 * Grava os textos editados no workspace (cp1252).
 */
function saveWorkspace(id, files, options = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: true, saved: 0, files: [] };
  }

  const logger = options.logger || defaultLogger;
  const dir = workspaceDir(id);
  const manifest = readManifest(id);
  const saved = [];
  const errors = [];

  for (const entry of files) {
    try {
      const rel = validateEditablePath(manifest, entry && entry.path);
      const content = String((entry && entry.content) ?? '');
      const bytes = encodeCp1252(content);
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
      const meta = manifest.files.find(
        (file) => normalizeRelative(file.path).toLowerCase() === rel.toLowerCase(),
      );
      if (meta) {
        meta.bytes = bytes.length;
        meta.modified = nowIso();
      }
      saved.push({ path: rel, bytes: bytes.length });
    } catch (error) {
      errors.push({
        path: entry && entry.path,
        error: error.message || String(error),
        code: error.code || 'SAVE_FAILED',
      });
    }
  }

  manifest.updatedAt = nowIso();
  writeManifest(dir, manifest);
  logger.log(`[${id}] ${saved.length} arquivo(s) salvo(s), ${errors.length} erro(s)`);

  return {
    ok: errors.length === 0,
    saved: saved.length,
    files: saved,
    errors,
    updatedAt: manifest.updatedAt,
  };
}

function collectOutputs(dir, relText, binaryExt) {
  const expectedRel = normalizeRelative(relText).replace(/\.[^.]+$/, `.${binaryExt}`);
  const expectedAbs = path.join(dir, expectedRel);
  if (!isFile(expectedAbs)) {
    return { outputs: [], missing: expectedRel };
  }
  const outputs = [expectedRel];
  const memoExt = MEMO_EXTENSION.get(binaryExt);
  if (memoExt) {
    const memoRel = expectedRel.replace(/\.[^.]+$/, `.${memoExt}`);
    if (isFile(path.join(dir, memoRel))) outputs.push(memoRel);
  }
  return { outputs, missing: null };
}

/**
 * Recompila os textos editados e devolve um ZIP com os binários.
 */
async function compileProject(input, options = {}) {
  const id = String((input && input.id) || '');
  const requested = Array.isArray(input && input.files) ? input.files : [];
  if (requested.length === 0) {
    throw new ServiceError(
      'Nenhum arquivo modificado foi enviado para compilação.',
      'NO_FILES',
    );
  }

  const logger = options.logger || defaultLogger;
  const timeoutMs = getTimeoutMs((input && input.timeoutMs) || options.timeoutMs);
  const dir = workspaceDir(id);
  const manifest = readManifest(id);

  if (!getVfpPath()) {
    throw new ServiceError(
      'Visual FoxPro 9 não encontrado. Informe o caminho do vfp9.exe nas configurações.',
      'VFP_NOT_FOUND',
    );
  }
  if (!installFoxBin2Prg()) {
    throw new ServiceError(
      'O runtime do FoxBin2Prg não está disponível em server/vendor/foxbin2prg.',
      'FOXBIN2PRG_NOT_FOUND',
    );
  }

  // Normaliza/valida e persiste o estado atual da edição.
  const normalized = requested.map((entry) => ({
    path: validateEditablePath(manifest, entry && entry.path),
    content: String((entry && entry.content) ?? ''),
  }));
  const saveResult = saveWorkspace(id, normalized, { logger });
  if (saveResult.errors.length > 0) {
    throw new ServiceError(
      `Não foi possível preparar os arquivos: ${saveResult.errors
        .map((error) => error.error)
        .join(' | ')}`,
      'SAVE_FAILED',
      { errors: saveResult.errors },
    );
  }

  const targets = normalized.filter((file) => TEXT_TO_BINARY.has(extOf(file.path)));
  const editedSources = normalized.filter((file) => !TEXT_TO_BINARY.has(extOf(file.path)));
  // O .prg é fonte executável: não passa pelo FoxBin2Prg, mas a versão editada
  // é o artefato gerado e deve entrar no relatório e no ZIP.
  const prgSources = editedSources.filter((file) => extOf(file.path) === 'prg');
  const supportSources = editedSources.filter((file) => extOf(file.path) !== 'prg');

  const stamp = `${Date.now()}`;
  const buildDir = path.join(dir, '.fpi', `build-${stamp}`);
  const verifyDir = path.join(dir, '.fpi', `verify-${stamp}`);
  const buildJob = path.join(dir, '.fpi', 'jobs', `build-${stamp}`);
  const verifyJob = path.join(dir, '.fpi', 'jobs', `verify-${stamp}`);
  const started = Date.now();
  const warnings = [];

  const report = [];
  const zipEntries = [];
  const warningsFromVerification = [];

  try {
    copyDirectoryFiltered(dir, buildDir, (abs, name, isDirectory) => {
      if (isDirectory) {
        return abs === path.join(dir, '.fpi');
      }
      return false;
    });

    for (const file of targets) {
      const abs = path.join(buildDir, file.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, encodeCp1252(file.content));
    }
    for (const file of editedSources) {
      const abs = path.join(buildDir, file.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, encodeCp1252(file.content));
    }

    if (targets.length === 0) {
      if (prgSources.length > 0) {
        logger.log(
          `[${id}] nada para converter com FoxBin2Prg; ${prgSources.length} fonte(s) .prg incluído(s) no pacote`,
        );
      } else {
        logger.log(`[${id}] nada para recompilar; gerando pacote só com arquivos de apoio editados`);
        warnings.push(
          'Nenhum arquivo binário ou .prg foi modificado. O pacote contém apenas arquivos de apoio (.h/.ini/.txt) editados.',
        );
      }
    } else {
      const tasks = targets.map((file) => ({
        type: 'PRG2BIN',
        file: path.join(buildDir, file.path),
      }));
      const batch = await runBatch(buildJob, tasks, timeoutMs, logger);
      const byFile = new Map(
        batch.results.map((result) => [normalizeRelative(result.file).toLowerCase(), result]),
      );

      for (const file of targets) {
        const textExt = extOf(file.path);
        const binaryExt = TEXT_TO_BINARY.get(textExt);
        const result = byFile.get(normalizeRelative(path.join(buildDir, file.path)).toLowerCase());
        const entry = {
          path: file.path,
          type: TYPE_BY_EXT.get(textExt) || textExt.toUpperCase(),
          ok: Boolean(result && result.ok),
          message: (result && result.message) || '',
          outputs: [],
          error: null,
          verification: null,
        };

        if (!result) {
          entry.ok = false;
          entry.error = 'O FoxBin2Prg não retornou status para este arquivo.';
        } else if (!result.ok) {
          entry.error = result.message || 'Falha na recompilação.';
        }

        if (entry.ok) {
          const collected = collectOutputs(buildDir, file.path, binaryExt);
          if (!collected.outputs.length) {
            entry.ok = false;
            entry.error = `O FoxBin2Prg não gerou o binário esperado: ${collected.missing}`;
          } else {
            entry.outputs = collected.outputs;
          }
        }

        report.push(entry);
      }
    }

    // Verificação: reexporta cada binário gerado e compara com o texto enviado.
    const verifiable = report.filter(
      (entry) => entry.ok && entry.outputs.length > 0 && !entry.source,
    );
    if (verifiable.length > 0) {
      fs.mkdirSync(verifyDir, { recursive: true });
      const verifyTasks = [];
      for (const entry of verifiable) {
        for (const output of entry.outputs) {
          const from = path.join(buildDir, output);
          const to = path.join(verifyDir, output);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
          if (output === entry.outputs[0]) {
            verifyTasks.push({ type: 'BIN2PRG', file: to });
          }
        }
      }

      try {
        const verifyBatch = await runBatch(verifyJob, verifyTasks, timeoutMs, logger);
        const verifyResults = new Map(
          verifyBatch.results.map((result) => [
            normalizeRelative(path.relative(verifyDir, result.file)).toLowerCase(),
            result,
          ]),
        );

        for (const entry of verifiable) {
          const binaryRel = entry.outputs[0];
          const result = verifyResults.get(normalizeRelative(binaryRel).toLowerCase());
          if (!result || !result.ok) {
            entry.verification = {
              tested: true,
              checked: false,
              identical: null,
              added: 0,
              removed: 0,
              sample: [],
              warning:
                'O binário foi gerado, mas a reexportação de verificação falhou. ' +
                ((result && result.message) || 'sem status.'),
            };
            continue;
          }
          const textRel = normalizeRelative(binaryRel).replace(/\.[^.]+$/, `.${extOf(entry.path)}`);
          const verifyTextPath = path.join(verifyDir, textRel);
          if (!isFile(verifyTextPath)) {
            entry.verification = {
              tested: true,
              checked: false,
              identical: null,
              added: 0,
              removed: 0,
              sample: [],
              warning: `A reexportação não gerou ${textRel}.`,
            };
            continue;
          }
          const verifyText = decodeCp1252(fs.readFileSync(verifyTextPath));
          const submitted = normalized.find(
            (file) => normalizeRelative(file.path).toLowerCase() === entry.path.toLowerCase(),
          );
          const diff = compareText(submitted ? submitted.content : '', verifyText);
          entry.verification = {
            tested: true,
            checked: true,
            identical: diff.identical,
            added: diff.added,
            removed: diff.removed,
            sample: diff.sample,
          };
        }
      } catch (error) {
        const message = `A verificação automática falhou: ${error.message || String(error)}`;
        warnings.push(message);
        for (const entry of verifiable) {
          if (!entry.verification) {
            entry.verification = {
              tested: true,
              checked: false,
              identical: null,
              added: 0,
              removed: 0,
              sample: [],
              warning: message,
            };
          }
        }
      }
    }

    // O .prg editado é o próprio artefato gerado: entra no relatório como
    // arquivo concluído e no ZIP. O VFP compila o fonte ao gerar o APP/EXE.
    for (const file of prgSources) {
      report.push({
        path: file.path,
        type: 'PRG',
        ok: true,
        message: 'Fonte .prg atualizada incluída no pacote.',
        outputs: [file.path],
        source: true,
        error: null,
        verification: null,
      });
    }

    // Conteúdo do ZIP: binários gerados + fontes editados.
    const added = new Set();
    for (const entry of report) {
      if (!entry.ok) continue;
      for (const output of entry.outputs) {
        const abs = path.join(buildDir, output);
        if (!isFile(abs)) continue;
        zipEntries.push({ name: output, data: fs.readFileSync(abs) });
        added.add(output.toLowerCase());
      }
    }
    for (const file of editedSources) {
      const abs = path.join(buildDir, file.path);
      if (!isFile(abs)) continue;
      if (added.has(file.path.toLowerCase())) continue;
      zipEntries.push({ name: file.path, data: fs.readFileSync(abs) });
      added.add(file.path.toLowerCase());
    }

    const okCount = report.filter((entry) => entry.ok).length;
    const failCount = report.length - okCount;
    const binaryOkCount = report.filter((entry) => entry.ok && !entry.source).length;
    const prgOkCount = report.filter((entry) => entry.ok && entry.source).length;
    const readme = [
      'FoxPro IDE Web - pacote de compilação',
      '',
      `Projeto : ${manifest.name}`,
      `Origem  : ${manifest.projectPath}`,
      `Gerado  : ${new Date().toLocaleString('pt-BR')}`,
      `Arquivos gerados: ${okCount} de ${report.length}`,
      `Binários FoxBin2Prg: ${binaryOkCount} de ${targets.length}`,
      ...(prgSources.length
        ? [`Fontes .prg atualizados: ${prgOkCount} de ${prgSources.length}`]
        : []),
      ...(supportSources.length
        ? [`Arquivos de apoio incluídos: ${supportSources.length}`]
        : []),
      '',
      'Como usar:',
      '1. Feche o projeto no Visual FoxPro (evita bloqueio de arquivos).',
      '2. Faça backup dos arquivos originais do projeto.',
      '3. Copie o conteúdo deste ZIP para a pasta do projeto, mantendo a estrutura.',
      '4. Abra o projeto no VFP e confira formulários/classes/relatórios no designer.',
      '5. Os fontes .prg também são copiados; o VFP os recompila ao gerar o APP/EXE.',
      '',
      'Os arquivos originais nunca são alterados pelo FoxPro IDE Web.',
      '',
    ].join('\r\n');

    const reportLines = [
      'Relatório de compilação - FoxPro IDE Web',
      '',
      `Projeto: ${manifest.name}`,
      '',
    ];
    if (report.length === 0) {
      reportLines.push('Nenhum arquivo binário ou .prg foi gerado.');
    } else {
      reportLines.push('Arquivos gerados:');
    }
    for (const entry of report) {
      if (entry.source) {
        reportLines.push(`[OK] ${entry.path} (fonte .prg atualizada)`);
        continue;
      }
      reportLines.push(
        `[${entry.ok ? 'OK' : 'FALHA'}] ${entry.path}` +
          (entry.outputs.length ? ` -> ${entry.outputs.join(', ')}` : ''),
      );
      if (entry.error) reportLines.push(`  Erro: ${entry.error}`);
      if (entry.verification) {
        if (entry.verification.checked) {
          reportLines.push(
            `  Verificação: ${
              entry.verification.identical
                ? 'round-trip idêntico'
                : `${entry.verification.added} linha(s) adicionada(s), ` +
                  `${entry.verification.removed} removida(s) na reexportação`
            }`,
          );
        } else if (entry.verification.warning) {
          reportLines.push(`  Verificação: ${entry.verification.warning}`);
        }
      }
    }
    if (supportSources.length) {
      reportLines.push('', 'Arquivos de apoio incluídos no pacote:');
      for (const file of supportSources) reportLines.push(`- ${file.path}`);
    }
    if (warnings.length) {
      reportLines.push('', 'Avisos:');
      for (const warning of warnings) reportLines.push(`- ${warning}`);
    }

    zipEntries.unshift(
      { name: 'LEIA-ME.txt', data: Buffer.from(readme, 'utf8') },
      { name: 'RELATORIO.txt', data: Buffer.from(reportLines.join('\r\n'), 'utf8') },
    );

    const zip = createZip(zipEntries);
    const zipName = `${safeBaseName(manifest.name)}.recompilado.zip`;
    const zipPath = path.join(dir, '.fpi', 'ultimo-pacote.zip');
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    fs.writeFileSync(zipPath, zip);

    // Compilação bem-sucedida move a referência para o texto compilado: os
    // arquivos deixam de aparecer como modificados (M). Falhas mantêm o M
    // para permitir nova tentativa.
    const handled = new Set(
      report.filter((entry) => entry.ok).map((entry) => entry.path.toLowerCase()),
    );
    for (const file of editedSources) handled.add(file.path.toLowerCase());
    let baselinesUpdated = 0;
    for (const file of normalized) {
      const key = file.path.toLowerCase();
      if (!handled.has(key)) continue;
      const meta = (manifest.files || []).find(
        (candidate) => normalizeRelative(candidate.path).toLowerCase() === key,
      );
      if (!meta) continue;
      try {
        meta.baselineHash = sha1(fs.readFileSync(path.join(dir, file.path)));
        baselinesUpdated += 1;
      } catch {
        /* mantém a referência anterior */
      }
    }
    if (baselinesUpdated > 0) {
      manifest.updatedAt = nowIso();
      writeManifest(dir, manifest);
    }

    logger.log(
      `[${id}] compilação concluída: ${okCount}/${report.length} arquivo(s) gerado(s) ` +
        `(${binaryOkCount}/${targets.length} binário(s), ${prgOkCount}/${prgSources.length} .prg), ` +
        `${zip.length} bytes, ${Date.now() - started}ms`,
    );

    return {
      ok: failCount === 0,
      zip: zip.toString('base64'),
      zipName,
      downloadUrl: `/api/project/download?id=${encodeURIComponent(id)}`,
      files: report,
      warnings: Array.from(new Set(warnings)),
      save: { saved: saveResult.saved, errors: saveResult.errors },
      stats: {
        id,
        project: manifest.name,
        targets: report.length,
        binaryTargets: targets.length,
        sources: prgSources.length,
        supportFiles: supportSources.length,
        compiled: okCount,
        failed: failCount,
        zipBytes: zip.length,
        entries: zipEntries.length,
        ms: Date.now() - started,
        encoding: 'cp1252',
        patchedForVfp9Rtm: runtimePatched,
      },
    };
  } finally {
    if (!isKeepJobs()) {
      await fsp.rm(buildDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(verifyDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(buildJob, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(verifyJob, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function listWorkspaces() {
  const base = getWorkspacesDir();
  const result = [];
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidWorkspaceId(entry.name)) continue;
    const file = path.join(base, entry.name, '.fpi', 'manifest.json');
    if (!isFile(file)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      result.push({
        id: manifest.id,
        name: manifest.name,
        projectPath: manifest.projectPath,
        mainFile: manifest.mainFile,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        fileCount: (manifest.files || []).length,
      });
    } catch {
      /* manifesto inválido: ignora */
    }
  }
  result.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return result;
}

function deleteWorkspace(id) {
  const dir = workspaceDir(id);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, id };
}

function readLastZip(id) {
  const dir = workspaceDir(id);
  const file = path.join(dir, '.fpi', 'ultimo-pacote.zip');
  if (!isFile(file)) return null;
  return fs.readFileSync(file);
}

function getHealth() {
  const vfp = getVfpPath();
  const config = loadConfig();
  return {
    ok: true,
    service: 'foxpro-ide-web',
    version: require('./package.json').version,
    uptime: Math.round(process.uptime()),
    vfp: {
      found: Boolean(vfp),
      path: vfp,
      configured: config.vfpPath || '',
    },
    foxbin2prg: {
      available: isFoxBin2PrgAvailable(),
      version: FB2P_VERSION,
      vendor: isFoxBin2PrgAvailable() ? VENDOR_FB2P : null,
      runtime: fs.existsSync(path.join(RUNTIME_FB2P, 'foxbin2prg.prg')) ? RUNTIME_FB2P : null,
      patchedForVfp9Rtm: runtimePatched,
    },
    workspaces: listWorkspaces().length,
    busy,
    configFile: getConfigPath(),
    keepJobs: isKeepJobs(),
    capabilities: {
      import: Boolean(vfp && isFoxBin2PrgAvailable()),
      compile: Boolean(vfp && isFoxBin2PrgAvailable()),
      llmExport: true,
    },
  };
}

module.exports = {
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
  getTimeoutMs,
  installFoxBin2Prg,
  isFoxBin2PrgAvailable,
  enqueue,
  encodeCp1252,
  decodeCp1252,
  parseProjectText,
  RUNTIME_FB2P,
  VENDOR_FB2P,
  FB2P_VERSION,
  TEXT_TO_BINARY,
  MEMO_EXTENSION,
};
