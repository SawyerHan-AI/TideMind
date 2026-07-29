/**
 * --once-per-session 支持(Kimi Code UserPromptSubmit hook)。
 *
 * 背景:Kimi Code 0.29.0 的 SessionStart hook 输出不会注入会话上下文(实测
 * 结果被丢弃),只有 UserPromptSubmit 的 stdout 会以 <hook_result> 用户消息
 * 注入。但 UserPromptSubmit 对每条用户消息都触发,因此用 tmpdir 下的 marker
 * 文件保证每个 session 只注入一次上下文。
 *
 * 拆成独立纯逻辑模块(无副作用 import),方便单元测试。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER_DIR_NAME = 'tidemind-hook-once';

/** marker 目录;baseDir 参数仅供测试注入,生产默认 os.tmpdir()。 */
export function onceMarkerDir(baseDir?: string): string {
  return path.join(baseDir ?? os.tmpdir(), MARKER_DIR_NAME);
}

/**
 * session_id 文件名安全化:只留 [A-Za-z0-9_-],防路径注入('..'、'/'、空字节)。
 * 全部字符被剥掉时返回空串,调用方按"无 session_id"降级处理。
 */
export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '');
}

/** 安全化后的 marker 路径;安全化结果为空(异常 session_id)时返回 null。 */
export function sessionMarkerPath(sessionId: string, baseDir?: string): string | null {
  const safe = sanitizeSessionId(sessionId);
  if (!safe) return null;
  return path.join(onceMarkerDir(baseDir), safe);
}

export function hasSessionMarker(sessionId: string, baseDir?: string): boolean {
  const p = sessionMarkerPath(sessionId, baseDir);
  return p !== null && fs.existsSync(p);
}

export function createSessionMarker(sessionId: string, baseDir?: string): void {
  const p = sessionMarkerPath(sessionId, baseDir);
  if (!p) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, new Date().toISOString());
}
