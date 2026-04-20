/**
 * 统一日志工具
 *
 * 所有日志走 stderr（避免污染 MCP 协议的 stdout 通道）。
 * 通过环境变量 EB_LOG_LEVEL 控制级别（debug/info/warn/error），默认 info。
 *
 * 文件日志：调用 enableFileLogging(dir) 后，日志同时写入文件。
 * 按日期轮转，保留最近 7 天。
 */

import fs from 'node:fs';
import path from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let logDir: string | null = null;
let currentLogDate: string | null = null;
let logStream: fs.WriteStream | null = null;

function getCurrentLevel(): LogLevel {
  const env = process.env.EB_LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_ORDER) return env as LogLevel;
  return 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[getCurrentLevel()];
}

function formatArgs(args: unknown[]): string {
  return args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}

function getDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getTimeStr(): string {
  return new Date().toISOString().slice(11, 19);
}

function ensureLogStream(): fs.WriteStream | null {
  if (!logDir) return null;

  const today = getDateStr();
  if (currentLogDate !== today || !logStream) {
    if (logStream) {
      logStream.end();
    }
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, `${today}.log`);
      logStream = fs.createWriteStream(logPath, { flags: 'a' });
      currentLogDate = today;

      // 必须监听 'error' 事件 — WriteStream 在目录只读、磁盘满、权限问题
      // 时会 emit 'error';没 listener 会把异常冒到 uncaughtException 崩溃进程。
      // 降级为:关掉 stream(后续只走 stderr),不影响 daemon 继续运行。
      logStream.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error(`[logger] file stream error: ${err.message} — continuing with stderr-only`);
        try { logStream?.end(); } catch { /* ignore */ }
        logStream = null;
        // 置空 logDir 避免下次 ensureLogStream 又尝试(目录只读问题会持续)
        logDir = null;
      });
    } catch (err) {
      // mkdir / createWriteStream 同步抛(非 fs-async) — 一样降级
      // eslint-disable-next-line no-console
      console.error(`[logger] failed to init file stream: ${(err as Error).message}`);
      logStream = null;
      return null;
    }

    // 清理超过 7 天的日志(失败无关紧要)
    try { cleanOldLogs(); } catch { /* ignore */ }
  }
  return logStream;
}

function cleanOldLogs(): void {
  if (!logDir) return;
  try {
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log')).sort().reverse();
    for (const old of files.slice(7)) {
      fs.unlinkSync(path.join(logDir, old));
    }
  } catch { /* ignore */ }
}

function writeToFile(level: LogLevel, prefix: string, message: string): void {
  const stream = ensureLogStream();
  if (!stream) return;
  stream.write(`${getTimeStr()} [${level.toUpperCase()}] ${prefix} ${message}\n`);
}

/**
 * 启用文件日志。日志文件按日期命名，保留最近 7 天。
 */
export function enableFileLogging(dir: string): void {
  logDir = dir;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(module: string): Logger {
  const prefix = `[eb:${module}]`;

  return {
    debug(...args: unknown[]) {
      if (shouldLog('debug')) {
        const msg = formatArgs(args);
        console.error(prefix, msg);
        writeToFile('debug', prefix, msg);
      }
    },
    info(...args: unknown[]) {
      if (shouldLog('info')) {
        const msg = formatArgs(args);
        console.error(prefix, msg);
        writeToFile('info', prefix, msg);
      }
    },
    warn(...args: unknown[]) {
      if (shouldLog('warn')) {
        const msg = formatArgs(args);
        console.error(prefix, '⚠', msg);
        writeToFile('warn', prefix, msg);
      }
    },
    error(...args: unknown[]) {
      if (shouldLog('error')) {
        const msg = formatArgs(args);
        console.error(prefix, '✗', msg);
        writeToFile('error', prefix, msg);
      }
    },
  };
}
