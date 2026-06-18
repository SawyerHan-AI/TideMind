#!/usr/bin/env node

/**
 * Claude Code SessionStart Hook 脚本
 *
 * 在会话启动时由 Claude Code hooks 机制调用，直接注入：
 * 1. SKILL.md 使用指南全文
 * 2. brain_prepare 返回的用户上下文（画像、索引、行为指导）
 *
 * 用法：node hook-session-start.js --agent-id eb_xxx --skill-path /path/to/SKILL.md [--tool claude-code]
 * 输出：JSON { hookSpecificOutput: { additionalContext: "..." } }
 */

import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { SqliteRepository } from './db/sqlite-repository.js';
import { touchAgent } from './db/agents.js';
import { prepare } from './tools/prepare.js';
import { readFileSync, fstatSync } from 'node:fs';
import { formatProfileSection, formatRestSections, assembleSessionContext } from './hook-session-format.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';
import { createLogger } from './utils/logger.js';
import { writeHookOutput as outputHook } from './hook-output.js';

/**
 * 异步读取 stdin JSON payload（Codex 0.120+ 会传 `session_start_reason` 等字段）。
 * - stdin 是 tty 或无输入时返回 null，避免手动运行脚本时阻塞
 * - JSON 解析失败也返回 null
 * - 返回值用于区分 startup / resume / clear，不影响其他工具（Claude Code 等无此字段）
 *
 * 历史卡死：之前用 `readFileSync(0, 'utf-8')`——若调用方把 stdin 管道保持打开
 * 但不写数据（比如上游 hook runner bug 或 shell wrapper 错连管道），
 * readFileSync 会无限阻塞，整个 SessionStart hook 永远不返回，Claude Code
 * 启动看起来 "hang 住"。
 *
 * 现在实现：regular file 仍用 readFileSync（有确定的 EOF，不会阻塞）；
 * 管道/socket 用 process.stdin stream + 2s 超时，超时后放弃返回 null。
 */
const STDIN_READ_TIMEOUT_MS = 2_000;

async function readStdinPayload(): Promise<Record<string, unknown> | null> {
  try {
    if (process.stdin.isTTY) return null;
    // regular file（如 `node script < file.json`）可以一次读完，不会阻塞
    try {
      const st = fstatSync(0);
      if (st.isFile()) {
        const data = readFileSync(0, 'utf-8');
        if (!data.trim()) return null;
        return JSON.parse(data) as Record<string, unknown>;
      }
    } catch {
      // fstat 失败就当 pipe 处理
    }
    // 管道/socket：走 stream + timeout，超时后放弃
    const data = await new Promise<string | null>((resolve) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        try { process.stdin.removeAllListeners('data'); } catch { /* ignore */ }
        try { process.stdin.removeAllListeners('end'); } catch { /* ignore */ }
        try { process.stdin.removeAllListeners('error'); } catch { /* ignore */ }
        try { process.stdin.pause(); } catch { /* ignore */ }
        resolve(value);
      };
      const timer = setTimeout(() => {
        process.stderr.write(`[eb:hook-session-start] stdin read timeout ${STDIN_READ_TIMEOUT_MS}ms，忽略 payload\n`);
        finish(null);
      }, STDIN_READ_TIMEOUT_MS);
      timer.unref?.();
      process.stdin.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      process.stdin.on('end', () => {
        clearTimeout(timer);
        finish(Buffer.concat(chunks).toString('utf-8'));
      });
      process.stdin.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
    });
    if (!data || !data.trim()) return null;
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const migrationLog = createLogger('migrate');

// --- 解析命令行参数 ---
function parseArgs(): { agentId: string; skillPath: string; tool: string } {
  const args = process.argv.slice(2);
  let agentId = '';
  let skillPath = '';
  let tool = 'claude-code';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent-id' && args[i + 1]) {
      agentId = args[i + 1];
      i++;
    } else if (args[i] === '--skill-path' && args[i + 1]) {
      skillPath = args[i + 1];
      i++;
    } else if (args[i] === '--tool' && args[i + 1]) {
      tool = args[i + 1];
      i++;
    }
  }

  if (!agentId) {
    throw new Error('Missing --agent-id');
  }
  if (!skillPath) {
    throw new Error('Missing --skill-path');
  }

  return { agentId, skillPath, tool };
}

// 注入正文格式化 + G1 预算安全网已拆到 ./hook-session-format.ts(纯函数,零副作用,供单测)。

// --- 输出 hook 结果 ---
// 协议适配（Gemini JSON / 其他纯文本）见 hook-output.ts；
// import 放在文件顶部一起声明，这里仅说明 outputHook 的语义。

// --- 主逻辑 ---
async function main(): Promise<void> {
  // 数据目录一次性迁移必须是第一步（在 loadConfig / getDb 之前）
  try {
    migrateDataDirIfNeeded(migrationLog);
  } catch {
    // 迁移失败不阻断 hook，降级走正常流程
  }

  const { agentId, skillPath, tool } = parseArgs();

  // 不同 CLI 给 SessionStart hook 传的字段名不同：
  //   - Codex 0.120+：`session_start_reason`
  //   - Gemini CLI 0.26+：`source`
  // 字段值都是 startup / resume / clear 三个枚举，下游判断逻辑一致。
  const stdinPayload = await readStdinPayload();
  const reasonRaw =
    (stdinPayload?.session_start_reason as unknown)
    ?? (stdinPayload?.source as unknown);
  const sessionReason = typeof reasonRaw === 'string' ? reasonRaw : null;

  // 读取 SKILL.md（即使后续步骤失败，至少有使用指南）
  let skillContent: string;
  try {
    skillContent = readFileSync(skillPath, 'utf-8');
    // 去掉 YAML frontmatter（仅当文件以 --- 开头时）
    if (skillContent.startsWith('---')) {
      const fmEnd = skillContent.indexOf('---', 3);
      if (fmEnd !== -1) {
        skillContent = skillContent.slice(fmEnd + 3).trim();
      }
    }
  } catch {
    skillContent = '（Skill 文件读取失败，请通过 MCP 工具 brain_prepare/recall/digest 与外脑交互）';
  }

  // 画像段与其余段分离,供 G1 预算按段截断。/clear 与错误路径无画像、用静态短文本走 restSection。
  let profileSection = '';
  let restSection: string;
  if (sessionReason === 'clear') {
    // /clear 发生时 Codex 已保留 session 上下文，只是清屏；重跑 prepare 是重复消耗
    restSection = '（/clear 已执行，用户上下文已在本 session 内保留，无需重新加载）';
  } else {
    // 正常启动 / resume：拉取 prepare 结果
    try {
      loadConfig();
      ensureDataDirs();
      const db = getDb();
      const repo = new SqliteRepository(db);

      touchAgent(db, agentId);

      const result = await prepare(repo, {
        tool,
        agent_id: agentId,
        detail_level: 'standard',
      });

      profileSection = formatProfileSection(result);
      restSection = formatRestSections(result);
    } catch (err) {
      // 之前这里是裸 catch {} — prepare() 的任何异常(DB 损坏、OOM、代码 bug、
      // strategy loader 抛错)都会被吞成同一句静态 fallback,hook 行为看起来
      // "正常"但用户画像一直缺失。走 stderr 而不是 createLogger,因为 hook 脚本
      // 可能在 logger 文件初始化前就崩了,stderr 始终可写。
      const errLine = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      process.stderr.write(`[eb:hook-session-start] prepare failed — ${errLine}\n`);
      if (err instanceof Error && err.stack) {
        process.stderr.write(err.stack.split('\n').slice(0, 3).join('\n') + '\n');
      }
      restSection = '（用户上下文加载失败，请手动调用 brain_prepare 工具）';
    } finally {
      try { closeDb(); } catch { /* ignore */ }
    }
  }

  // 拼合输出（G1 预算安全网在 assembleSessionContext 内统一施加）
  const content = assembleSessionContext({ skillContent, profileSection, restSection });

  outputHook(content, tool);
}

main().catch((err: unknown) => {
  // 最终兜底
  const stack = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[eb:hook-session-start] fatal error: ${stack}\n`);
  // 错误标识符嵌入 fallback 文案中，方便用户拿 "HOOK_SESSION_START_FATAL"
  // 搜 stderr / 日志文件，关联到真实 stack。保留原中文 fallback 本体。
  const code = err instanceof Error && err.name ? err.name : 'unknown';
  // catch 闭包内 tool 不在作用域，重新解析一次（失败也不阻塞——默认 'claude-code'
  // 作为最保守的纯文本输出形式，对所有 CLI 至少都是可读的）。
  let tool = 'claude-code';
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--tool' && args[i + 1]) { tool = args[i + 1]; break; }
    }
  } catch { /* ignore */ }
  outputHook(`Tide Mind 启动失败。请手动调用 brain_prepare 工具加载上下文。[internal error: HOOK_SESSION_START_FATAL/${code}]`, tool);
});
