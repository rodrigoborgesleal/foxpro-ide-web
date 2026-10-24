'use strict';

/**
 * Log contínuo com rotação simples (app.log -> app.log.1).
 * O mesmo logger é usado pelo servidor CLI e pelo aplicativo de bandeja.
 */

const fs = require('fs');
const { getLogFile } = require('./config');

const MAX_LOG_BYTES = 2 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    const file = getLogFile();
    const stat = fs.statSync(file);
    if (stat.size > MAX_LOG_BYTES) {
      try {
        fs.rmSync(`${file}.1`, { force: true });
      } catch {
        /* melhor esforço */
      }
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* ainda não existe log */
  }
}

function formatArg(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level, args) {
  const line = `[${new Date().toISOString()}] ${level} ${args.map(formatArg).join(' ')}`;
  try {
    rotateIfNeeded();
    fs.appendFileSync(getLogFile(), `${line}\n`, 'utf8');
  } catch {
    /* log é melhor esforço */
  }
  return line;
}

function createLogger(options = {}) {
  const mirror = options.mirror === true;
  const mirrorFn = options.mirrorFn;
  const log = (...args) => {
    const line = write('INFO', args);
    if (mirror) console.log(line);
    if (mirrorFn) mirrorFn(line);
    return line;
  };
  const error = (...args) => {
    const line = write('ERROR', args);
    if (mirror) console.error(line);
    if (mirrorFn) mirrorFn(line);
    return line;
  };
  const warn = (...args) => {
    const line = write('WARN', args);
    if (mirror) console.warn(line);
    if (mirrorFn) mirrorFn(line);
    return line;
  };
  return { log, error, warn };
}

function readLogTail(maxLines = 200) {
  try {
    const text = fs.readFileSync(getLogFile(), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

const defaultLogger = createLogger();

module.exports = {
  createLogger,
  readLogTail,
  formatArg,
  MAX_LOG_BYTES,
  logger: defaultLogger,
};
