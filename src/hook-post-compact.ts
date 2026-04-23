#!/usr/bin/env node

/**
 * Claude Code PostCompact Hook 脚本
 *
 * 在上下文压缩完成后由 Claude Code hooks 机制调用，重注一份精简的外脑画像，
 * 防止长对话中 [TIDE MIND — SESSION CONTEXT] 被压缩摘要吞掉后，模型后续
 * 对话失去用户画像参照。
 *
 * 和 SessionStart hook 的差异：
 *   - 不需要 --skill-path（skill 正文在 compact 后由 Claude Code 自己保留最近一次 invocation）
 *   - detail_level 用 'brief' 而非 'standard'，避免压缩后立刻又吞大量 token
 *   - 输出格式更精简：一句画像 + 最多 3 个枢纽 + 最多 3 个结晶 + 最多 3 条最近活跃
 *
 * 用法：node hook-post-compact.js --agent-id eb_xxx [--tool claude-code]
 */

import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { SqliteRepository } from './db/sqlite-repository.js';
import { touchAgent } from './db/agents.js';
import { prepare } from './tools/prepare.js';
import type { PrepareOutput } from './types.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';
import { createLogger } from './utils/logger.js';

const migrationLog = createLogger('migrate');

function parseArgs(): { agentId: string; tool: string } {
  const args = process.argv.slice(2);
  let agentId = '';
  let tool = 'claude-code';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent-id' && args[i + 1]) {
      agentId = args[i + 1];
      i++;
    } else if (args[i] === '--tool' && args[i + 1]) {
      tool = args[i + 1];
      i++;
    }
  }

  if (!agentId) {
    throw new Error('Missing --agent-id');
  }

  return { agentId, tool };
}

/**
 * 压缩后重注的上下文要控制体积。和 SessionStart 的全量 formatPrepareOutput 不同，
 * 这里只取每类最多 3 条，画像用 profile.text 的第一段。
 */
function formatBriefContext(result: PrepareOutput): string {
  const sections: string[] = [];

  if (result.profile?.text) {
    const firstPara = result.profile.text.split(/\n\n/)[0]?.trim();
    if (firstPara) sections.push(`## 用户画像\n${firstPara}`);
  }

  if (result.keystones.length > 0) {
    const lines = result.keystones.slice(0, 3).map(k =>
      `- ${k.title ?? k.id}（id: ${k.id}）`
    );
    sections.push(`## 关键枢纽\n${lines.join('\n')}`);
  }

  // 结晶：优先 highlighted（含 snippet 可摘要显示），不足 3 条再补 others（只有 title）
  const crystalLines: string[] = [];
  for (const c of result.crystals.highlighted) {
    if (crystalLines.length >= 3) break;
    crystalLines.push(`- ${c.title ?? c.snippet}（id: ${c.id}）`);
  }
  for (const c of result.crystals.others) {
    if (crystalLines.length >= 3) break;
    crystalLines.push(`- ${c.title ?? c.id}（id: ${c.id}）`);
  }
  if (crystalLines.length > 0) {
    sections.push(`## 近期结晶\n${crystalLines.join('\n')}`);
  }

  if (result.recent.length > 0) {
    const lines = result.recent.slice(0, 3).map(r =>
      `- ${r.title ?? r.id}（id: ${r.id}）`
    );
    sections.push(`## 最近活跃\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

function outputHook(content: string): void {
  process.stdout.write(content);
}

async function main(): Promise<void> {
  try {
    migrateDataDirIfNeeded(migrationLog);
  } catch {
    // 迁移失败不阻断 hook，降级走正常流程
  }

  const { agentId, tool } = parseArgs();

  let briefText: string;
  try {
    loadConfig();
    ensureDataDirs();
    const db = getDb();
    const repo = new SqliteRepository(db);

    touchAgent(db, agentId);

    const result = await prepare(repo, {
      tool,
      agent_id: agentId,
      detail_level: 'brief',
    });

    briefText = formatBriefContext(result);
  } catch (err) {
    // 之前是裸 catch {} — 所有 prepare 异常都变成同一条 fallback,调 hook 的
    // 用户永远看不到真实错误。至少把错误名/message/前 3 行 stack 打到 stderr。
    const errLine = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stderr.write(`[eb:hook-post-compact] prepare failed — ${errLine}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack.split('\n').slice(0, 3).join('\n') + '\n');
    }
    briefText = '（外脑上下文恢复失败，如需参照用户画像请手动调用 brain_prepare 工具）';
  } finally {
    try { closeDb(); } catch { /* ignore */ }
  }

  const content = `[TIDE MIND — CONTEXT RESTORED]

${briefText}

---
以上是压缩后由 Tide Mind 自动重注的精简画像。如需完整记忆，仍可通过 brain_recall / brain_prepare 获取。`;

  outputHook(content);
}

main().catch((err: unknown) => {
  const stack = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[eb:hook-post-compact] fatal error: ${stack}\n`);
  // 错误标识符嵌入 fallback 文案中，方便用户关联到 stderr 中的真实 stack。
  // 保留原中文 fallback 本体。
  const code = err instanceof Error && err.name ? err.name : 'unknown';
  outputHook(`Tide Mind 压缩后上下文恢复失败。如需用户画像请手动调用 brain_prepare。[internal error: HOOK_POST_COMPACT_FATAL/${code}]`);
});
