#!/usr/bin/env node

/**
 * Claude Code PreCompact Hook 脚本
 *
 * 在上下文即将被压缩前由 Claude Code hooks 机制调用，输出一段提示文字，
 * 引导模型在压缩前检查有没有尚未 brain_digest 的重要信息并立刻 digest。
 *
 * 本阶段（Phase 3）只做文案输出，不调用 DB 也不做 auto-digest。
 * 把 PreCompact 从硬编码 echo 改成脚本调用的目的：
 *   1) 让所有 hook 形态统一（SessionStart / PostCompact / PreCompact 都是脚本）
 *   2) 文案未来可 i18n
 *   3) 为后续 auto-digest 能力留下脚手架
 *
 * 用法：node hook-pre-compact.js --agent-id eb_xxx
 */

function parseArgs(): { agentId: string } {
  const args = process.argv.slice(2);
  let agentId = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent-id' && args[i + 1]) {
      agentId = args[i + 1];
      i++;
    }
  }

  if (!agentId) {
    throw new Error('Missing --agent-id');
  }

  return { agentId };
}

function main(): void {
  try {
    parseArgs(); // 仅做参数校验，当前不需要 agentId 的值
  } catch (err) {
    process.stderr.write(`[eb:hook-pre-compact] ${(err as Error).message}\n`);
    // 参数缺失也不要阻断压缩流程，输出通用提示
  }

  const content = `[TIDE MIND — PRE-COMPACT CHECK]

上下文即将被压缩。请检查本轮对话中是否有尚未 brain_digest 的重要信息——
用户表达的观点、做出的决策、讨论产生的洞察、被否定的方案、对某话题的态度变化等，
如有请立刻 digest 沉淀到外脑，否则会随摘要流失。`;

  process.stdout.write(content);
}

main();
