/**
 * Hook 输出协议适配层。
 *
 * 不同 CLI 给 SessionStart / PostCompact / PreCompact 等 hook 的 stdout 协议不同:
 *   - Claude Code:纯文本 stdout 直接注入为上下文
 *   - Codex 0.126+ / Gemini CLI 0.26+:必须输出严格 JSON
 *     `{hookSpecificOutput: {hookEventName: "<EventName>", additionalContext: "..."}}`
 *     stdout 不能掺杂任何非 JSON 文本,且 hookEventName 必须严格匹配触发事件
 *
 * 历史 bug(2026-05-09):hookEventName 硬编码 'SessionStart',PostCompact 共用同函数
 * 导致 Codex/Gemini 严格按事件名校验时 additionalContext 静默丢失;PreCompact 则
 * 完全没走该层,直接 process.stdout.write 纯文本被当 JSON 解析失败。
 * 现在把事件名作为参数显式传入。
 */

export type HookEventName = 'SessionStart' | 'PostCompact' | 'PreCompact';

export function formatHookOutput(
  content: string,
  tool: string,
  hookEventName: HookEventName = 'SessionStart',
): string {
  if (tool === 'codex' || tool === 'gemini') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext: content,
      },
    });
  }
  return content;
}

export function writeHookOutput(
  content: string,
  tool: string,
  hookEventName: HookEventName = 'SessionStart',
): void {
  process.stdout.write(formatHookOutput(content, tool, hookEventName));
}
