import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { getDataDir } from '../config.js';
import { today } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('stream-writer');

// 简易跨进程文件锁（不引入新依赖）
//   - 用 fs.openSync(lockPath, 'wx') 排他创建作为锁，写完后 unlink 释放
//   - 失败（EEXIST）时小步退避重试，最多 ~5s
//   - 死锁防护：发现 lock 文件 stale (>30s) 直接清掉重抢
const LOCK_RETRY_MAX_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function acquireLock(lockPath: string): number {
  const deadline = Date.now() + LOCK_RETRY_MAX_MS;
  let attempt = 0;
  // 第一轮 0ms（直接试），后续 10/20/40/80/160ms 退避
  while (true) {
    try {
      return fs.openSync(lockPath, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // stale lock 检测
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { fs.unlinkSync(lockPath); } catch { /* ignore — 另一进程已抢 */ }
          continue; // 立刻重试
        }
      } catch { /* lock 已被释放，下轮重试即可 */ }
      if (Date.now() >= deadline) {
        throw new Error(`appendToStream: 获取文件锁超时 (${lockPath})`);
      }
      // 同步退避
      const delay = Math.min(160, 10 * Math.pow(2, attempt++));
      const until = Date.now() + delay;
      while (Date.now() < until) { /* 自旋等待，毫秒级，避免引入 setTimeout 异步化 */ }
    }
  }
}

function releaseLock(fd: number, lockPath: string): void {
  try { fs.closeSync(fd); } catch { /* ignore */ }
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}

/**
 * 追加一条记录到当日 stream/<YYYY-MM-DD>.md。
 *
 * 持久性 / 并发安全保证：
 * 1. 用 openSync('a') + writeSync + fsyncSync 写入，保证内核 write 完成后立刻刷盘——
 *    避免 appendFileSync 仅 write(2) 不 fsync，OS crash 丢最后一批的问题。
 * 2. 用 <path>.lock 排他创建做跨进程串行化，避免 importer + daemon 同时写交错。
 *    POSIX 对 >PIPE_BUF (4KB) 的 append 不保证原子；锁兜底两边竞争，与 entry 大小无关。
 * 3. 锁释放在 finally，fd 关闭也在 finally，任何抛错都不会泄漏。
 */
export function appendToStream(entry: {
  tool?: string;
  session?: string;
  content: string;
  files?: string[];
}): string {
  const streamDir = path.join(getDataDir(), 'stream');
  const fileName = `${today()}.md`;
  const filePath = path.join(streamDir, fileName);
  const lockPath = `${filePath}.lock`;

  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  // nanoid 长度 12：64^12 ≈ 4.7e21，同毫秒并发 1000 条的碰撞概率 ~1e-16，可忽略。
  // 原长度 4（~1677 万）在高频 digest（importer 批量 / 多进程并发）下会碰撞，导致
  // readStreamEntry 的 indexOf 永远命中第一条，后续条目数据错位。
  const anchorId = `s-${time.replace(/:/g, '')}${ms}-${nanoid(12)}`;

  const header = [
    `## ${time}`,
    entry.tool ? ` · ${entry.tool}` : '',
    entry.session ? ` · ${entry.session}` : '',
  ].join('');

  const parts = [`<a id="${anchorId}"></a>`, '', header, ''];
  parts.push(entry.content);
  if (entry.files?.length) parts.push('', `files: ${entry.files.join(', ')}`);
  parts.push('', '---', '');

  const block = parts.join('\n');

  // mkdir 必须在锁之前——锁文件本身需要目录存在
  fs.mkdirSync(streamDir, { recursive: true });

  // 锁失败（含超时）让异常冒泡，绝不静默丢数据
  const lockFd = acquireLock(lockPath);
  try {
    // 文件不存在时先写头部
    let fileExists = true;
    try { fs.accessSync(filePath); } catch { fileExists = false; }
    if (!fileExists) {
      const headerFd = fs.openSync(filePath, 'a');
      try {
        fs.writeSync(headerFd, `# ${today()}\n\n`);
        fs.fsyncSync(headerFd);
      } finally {
        try { fs.closeSync(headerFd); } catch (err) { log.warn('header fd close 失败', err); }
      }
    }

    // 追加 block：write -> fsync -> close。fsync 抛错也要先尝试关闭 fd 再传播。
    const fd = fs.openSync(filePath, 'a');
    try {
      fs.writeSync(fd, block);
      fs.fsyncSync(fd);
    } finally {
      try { fs.closeSync(fd); } catch (err) { log.warn('append fd close 失败', err); }
    }
  } finally {
    releaseLock(lockFd, lockPath);
  }

  // 返回 stream 锚点引用（fragment-level）
  return `stream/${fileName}#${anchorId}`;
}
