/**
 * SessionStart evidence is valid only when this invocation loaded the exact
 * managed Skill generation and stdout delivery completed. Kimi's legacy and
 * current UserPromptSubmit commands are context-delivery fallbacks, not real
 * SessionStart events, so every kimi-code + once-per-session invocation is
 * permanently suppressed even if the explicit flag is absent. Kimi records
 * that signal through its dedicated silent SessionStart hook instead.
 */
export function shouldRecordSessionStartActivity(input: {
  tool: string;
  oncePerSession: boolean;
  suppressSessionStartActivity: boolean;
  exactSkillGenerationLoaded: boolean;
}): boolean {
  if (input.suppressSessionStartActivity) return false;
  if (input.tool === 'kimi-code' && input.oncePerSession) return false;
  return input.exactSkillGenerationLoaded;
}
