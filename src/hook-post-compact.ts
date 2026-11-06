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
 * Codex PostCompact 的官方合同不支持 additionalContext；该宿主仅输出 {}，
 * 不能将本脚本执行/活动记录视为画像重注成功。
 *
 * 用法：node hook-post-compact.js --agent-id eb_xxx [--tool claude-code]
 */

import { handleDiagnosticHook, isDiagnosticRequested } from './agent-diagnostic-runtime.js';
import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { SqliteRepository } from './db/sqlite-repository.js';
import { recordHookActivityEvidence } from './db/agent-host-activity.js';
import { prepare } from './tools/prepare.js';
import { formatBriefContext } from './hook-brief-context.js';
export { formatBriefContext } from './hook-brief-context.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';
import { createLogger } from './utils/logger.js';
import { writeHookOutput as outputHook, writeHookOutputBeforeEvidence } from './hook-output.js';
import { hookBridgeRejection } from './hook-bridge-guard.js';
import { getTideMindVersion } from './utils/app-version.js';

import { recordCodexPostCompactCapture } from './hook-codex-restore-capture.js';
import { codexRestoreInput, openCodexRestoreRuntime, readCodexHookPayload } from './hook-codex-restore-runtime.js';

let codexOutputStarted = false;
const migrationLog = createLogger('migrate');

function parseArgs(): { agentId: string; tool: string; activityGenerationToken: string } {
  const args = process.argv.slice(2);
  let agentId = '';
  let tool = 'claude-code';
  let activityGenerationToken = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent-id' && args[i + 1]) {
      agentId = args[i + 1];
      i++;
    } else if (args[i] === '--tool' && args[i + 1]) {
      tool = args[i + 1];
      i++;
    } else if (args[i] === '--activity-generation-token' && args[i + 1]) {
      activityGenerationToken = args[i + 1];
      i++;
    }
  }

  if (!agentId) {
    throw new Error('Missing --agent-id');
  }

  if (!activityGenerationToken) throw new Error('Missing --activity-generation-token');
  return { agentId, tool, activityGenerationToken };
}

// 协议适配见 hook-output.ts（已在文件顶部 import）。

async function codexPostCompact(agentId: string, generation: string): Promise<void> {
  const input = codexRestoreInput(await readCodexHookPayload(), 'PostCompact');
  if (!input) process.stderr.write('[eb:hook-post-compact] codex_input_invalid\n');
  const runtime = input ? openCodexRestoreRuntime(agentId, generation, input.sessionId) : null;
  try {
    const admitted = runtime?.admitted() ?? false;
    if (runtime && admitted && input) {
      const revision = runtime.store.markPending(runtime.scope);
      recordCodexPostCompactCapture(runtime.scope, input, revision);
    }
    codexOutputStarted = true;
    await outputHook('', 'codex', 'PostCompact');
    if (runtime && admitted && runtime.admitted()) recordHookActivityEvidence(runtime.db, {
      agentId, tool: 'codex', signalName: 'post_compact',
      tideMindVersion: getTideMindVersion(), activityGenerationToken: generation,
    });
  } finally { runtime?.close(); }
}

async function main(): Promise<void> {
  if (isDiagnosticRequested() && await handleDiagnosticHook('post_compact', parseArgs(), 'PostCompact')) return;
  const toolIndex = process.argv.indexOf('--tool');
  if (toolIndex >= 0 && process.argv[toolIndex + 1] === 'codex') {
    const parsed = parseArgs();
    await codexPostCompact(parsed.agentId, parsed.activityGenerationToken);
    return;
  }
  try {
    migrateDataDirIfNeeded(migrationLog);
  } catch {
    // 迁移失败不阻断 hook，降级走正常流程
  }

  const { agentId, tool, activityGenerationToken } = parseArgs();

  if (hookBridgeRejection({ scope: 'hook-post-compact', agentId, activityGenerationToken })) {
    await outputHook(tool === 'openclaw'
      ? JSON.stringify({ protocol: 'tidemind-openclaw-context-v1', content: '', evidenceEligible: false })
      : '', tool, 'PostCompact');
    return;
  }

  let briefText: string;
  let contextPrepared = false;
  try {
    loadConfig();
    ensureDataDirs();
    const db = getDb();
    const repo = new SqliteRepository(db);

    const result = await prepare(repo, {
      tool,
      agent_id: agentId,
      detail_level: 'brief',
    });

    briefText = formatBriefContext(result);
    contextPrepared = true;
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

  const hostOutput = tool === 'openclaw'
    ? JSON.stringify({ protocol: 'tidemind-openclaw-context-v1', content, evidenceEligible: contextPrepared })
    : content;
  await writeHookOutputBeforeEvidence(hostOutput, tool, 'PostCompact', () => {
    if (tool === 'openclaw') return;
    try {
      loadConfig();
      ensureDataDirs();
      const activity = recordHookActivityEvidence(getDb(), {
        agentId,
        tool,
        signalName: 'post_compact',
        tideMindVersion: getTideMindVersion(),
        activityGenerationToken,
      });
      if (activity.status === 'rejected') {
        process.stderr.write(`[eb:hook-post-compact] activity evidence rejected — ${activity.reason}\n`);
      }
    } catch (error) {
      process.stderr.write(`[eb:hook-post-compact] activity evidence unavailable — ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      try { closeDb(); } catch { /* ignore */ }
    }
  });

}

main().catch(async (err: unknown) => {
  if (codexOutputStarted) {
    process.stderr.write('[eb:hook-post-compact] codex_output_or_evidence_failed\n');
    return;
  }
  const stack = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[eb:hook-post-compact] fatal error: ${stack}\n`);
  // 错误标识符嵌入 fallback 文案中，方便用户关联到 stderr 中的真实 stack。
  // 保留原中文 fallback 本体。
  const code = err instanceof Error && err.name ? err.name : 'unknown';
  // catch 闭包外 tool 不在作用域，重新解析一次（与 hook-session-start.ts 同模式）
  let tool = 'claude-code';
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--tool' && args[i + 1]) { tool = args[i + 1]; break; }
    }
  } catch { /* ignore */ }
  try {
    await outputHook(`Tide Mind 压缩后上下文恢复失败。如需用户画像请手动调用 brain_prepare。[internal error: HOOK_POST_COMPACT_FATAL/${code}]`, tool, 'PostCompact');
  } catch (outputError) {
    process.stderr.write(`[eb:hook-post-compact] fallback output failed — ${outputError instanceof Error ? outputError.message : String(outputError)}\n`);
    process.exitCode = 1;
  }
});
