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
import { readFileSync } from 'node:fs';
import type { PrepareOutput } from './types.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';
import { createLogger } from './utils/logger.js';

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

// --- 格式化 prepare 结果为可读文本 ---
function formatPrepareOutput(result: PrepareOutput): string {
  const sections: string[] = [];

  // 用户画像
  if (result.profile?.text) {
    sections.push(`## 用户画像\n${result.profile.text}`);
  }

  // 枢纽节点
  if (result.keystones.length > 0) {
    const lines = result.keystones.map(k =>
      `- ${k.title ?? k.id}（${k.link_count} 条关联，id: ${k.id}）`
    );
    sections.push(`## 枢纽节点\n${lines.join('\n')}`);
  }

  // 标签索引
  if (result.tags.length > 0) {
    const lines = result.tags.map(t =>
      `- ${t.title}（${t.link_count} 条关联，id: ${t.id}）`
    );
    sections.push(`## 标签索引\n${lines.join('\n')}`);
  }

  // 结晶
  if (result.crystals.highlighted.length > 0 || result.crystals.others.length > 0) {
    const lines: string[] = [];
    for (const c of result.crystals.highlighted) {
      lines.push(`- ${c.title ?? c.snippet}（id: ${c.id}）`);
    }
    for (const c of result.crystals.others) {
      lines.push(`- ${c.title ?? c.id}（id: ${c.id}）`);
    }
    sections.push(`## 结晶\n${lines.join('\n')}`);
  }

  // 最近活跃
  if (result.recent.length > 0) {
    const lines = result.recent.map(r =>
      `- ${r.title ?? r.id}（${r.type}，${r.timestamp}，id: ${r.id}）`
    );
    sections.push(`## 最近活跃\n${lines.join('\n')}`);
  }

  // 行为指导
  if (result.guidance) {
    sections.push(`## 行为指导\n${result.guidance}`);
  }

  return sections.join('\n\n');
}

// --- 输出 hook 结果 ---
// SessionStart hook 不支持 hookSpecificOutput.additionalContext，
// 直接输出纯文本到 stdout，Claude Code 会自动注入为上下文。
function outputHook(content: string): void {
  process.stdout.write(content);
}

// --- 主逻辑 ---
async function main(): Promise<void> {
  // 数据目录一次性迁移必须是第一步（在 loadConfig / getDb 之前）
  try {
    migrateDataDirIfNeeded(migrationLog);
  } catch {
    // 迁移失败不阻断 hook，降级走正常流程
  }

  const { agentId, skillPath, tool } = parseArgs();

  // 读取 SKILL.md（即使后续步骤失败，至少有使用指南）
  let skillContent = '';
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

  // 调用 prepare
  let prepareText = '';
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

    prepareText = formatPrepareOutput(result);
  } catch {
    prepareText = '（用户上下文加载失败，请手动调用 brain_prepare 工具）';
  } finally {
    try { closeDb(); } catch { /* ignore */ }
  }

  // 拼合输出
  const content = `[TIDE MIND — SESSION CONTEXT]

## 使用指南
${skillContent}

${prepareText}

---
以上内容由 Tide Mind 在会话启动时自动注入。brain_recall 和 brain_digest 工具仍可在对话过程中使用。`;

  outputHook(content);
}

main().catch((err: unknown) => {
  // 最终兜底
  const stack = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[eb:hook-session-start] fatal error: ${stack}\n`);
  outputHook('Tide Mind 启动失败。请手动调用 brain_prepare 工具加载上下文。');
});
