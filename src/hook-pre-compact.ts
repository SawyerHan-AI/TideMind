#!/usr/bin/env node

/**
 * Claude Code PreCompact Hook 脚本
 *
 * 在上下文即将被压缩前由 Claude Code hooks 机制调用，输出一段提示文字，
 * 引导模型在压缩前检查有没有尚未 brain_digest 的重要信息并立刻 digest。
 *
 * 仍只输出提示、不做 auto-digest；同时在独立的本机集成证据表中记录
 * 宿主确实调用了本 hook。证据写入失败不影响提示输出。
 * 把 PreCompact 从硬编码 echo 改成脚本调用的目的：
 *   1) 让所有 hook 形态统一（SessionStart / PostCompact / PreCompact 都是脚本）
 *   2) 文案未来可 i18n
 *   3) 为后续 auto-digest 能力留下脚手架
 *
 * 用法：node hook-pre-compact.js --agent-id eb_xxx [--tool claude-code]
 *
 * 协议适配(2026-05-09):历史直接 process.stdout.write 纯文本,Codex 0.126+ /
 * Gemini 0.26+ 严格按 JSON 解析 hook stdout,纯文本会被解析失败 → 整段提示丢失。
 * 现在统一走 hook-output.ts::writeHookOutput,带 hookEventName='PreCompact'。
 */

import { writeHookOutput as outputHook } from './hook-output.js';
import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { recordHookActivityEvidence } from './db/agent-host-activity.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';
import { createLogger } from './utils/logger.js';
import { getTideMindVersion } from './utils/app-version.js';

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

  // agentId 缺失只 warn,不 throw —— 历史 bug:throw 会跳过下方 tool 赋值,
  // catch 路径把 tool 重置成默认 'claude-code',导致传了 --tool codex 但
  // 漏 --agent-id 的调用退化为 claude-code 输出 → Codex JSON 解析失败。
  if (!agentId) {
    process.stderr.write('[eb:hook-pre-compact] Missing --agent-id (continuing anyway)\n');
  }

  return { agentId, tool };
}

function main(): void {
  // parseArgs 已保证 tool 可用(不再因 agentId 缺失抛错)
  const { agentId, tool } = parseArgs();

  const content = `[TIDE MIND — PRE-COMPACT CHECK]

上下文即将被压缩。请检查本轮对话中是否有尚未 brain_digest 的重要信息——
用户表达的观点、做出的决策、讨论产生的洞察、被否定的方案、对某话题的态度变化等，
如有请立刻 digest 沉淀到外脑，否则会随摘要流失。`;

  try {
    migrateDataDirIfNeeded(migrationLog);
    loadConfig();
    ensureDataDirs();
    const activity = recordHookActivityEvidence(getDb(), {
      agentId,
      tool,
      signalName: 'pre_compact',
      tideMindVersion: getTideMindVersion(),
    });
    if (activity.status === 'rejected') {
      process.stderr.write(`[eb:hook-pre-compact] activity evidence rejected — ${activity.reason}\n`);
    }
  } catch (error) {
    process.stderr.write(`[eb:hook-pre-compact] activity evidence unavailable — ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    try { closeDb(); } catch { /* ignore */ }
  }

  outputHook(content, tool, 'PreCompact');
}

main();
