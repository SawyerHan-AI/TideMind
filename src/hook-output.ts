/**
 * Hook 输出协议适配层。
 *
 * 不同 CLI 给 SessionStart / PostCompact 等 hook 的 stdout 协议不同：
 *   - Claude Code / Codex 0.120+：纯文本 stdout 直接注入为上下文
 *   - Gemini CLI 0.26+：必须输出严格 JSON `{hookSpecificOutput: {additionalContext: "..."}}`
 *     stdout 不能掺杂任何非 JSON 文本
 *
 * 把这层格式选择抽出独立模块，hook-session-start.ts / hook-post-compact.ts 共用，
 * 同时单元测试可直接 import 而不会触发 hook 主循环的副作用。
 */

export function formatHookOutput(content: string, tool: string): string {
  if (tool === 'gemini') {
    return JSON.stringify({
      hookSpecificOutput: { additionalContext: content },
    });
  }
  return content;
}

export function writeHookOutput(content: string, tool: string): void {
  process.stdout.write(formatHookOutput(content, tool));
}
