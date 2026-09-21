export const WINDSURF_LIFECYCLE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
] as const;

export type WindsurfLifecycleHookEvent = typeof WINDSURF_LIFECYCLE_HOOK_EVENTS[number];

/** Safe metadata retained from Devin Desktop's documented Hook envelope. */
export interface WindsurfLifecycleHookMetadata {
  event: WindsurfLifecycleHookEvent;
  sessionId: string;
  lifecycleReason: string;
}

/**
 * Validate only the lifecycle fields needed to bind runtime evidence to a real
 * Devin session. Prompt, response and tool fields are neither returned nor
 * accepted as proof by this parser.
 */
export function parseWindsurfLifecycleHookMetadata(
  source: string,
  expectedEvent: WindsurfLifecycleHookEvent,
): WindsurfLifecycleHookMetadata {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('windsurf_hook_input_not_json');
  }
  if (!isObject(value)) throw new Error('windsurf_hook_input_not_object');
  if (value.hook_event_name !== expectedEvent) throw new Error('windsurf_hook_event_mismatch');
  if (typeof value.session_id !== 'string' || !value.session_id.trim()) {
    throw new Error('windsurf_hook_session_missing');
  }
  const lifecycleField = expectedEvent === 'SessionStart' ? 'source' : 'reason';
  const lifecycleReason = value[lifecycleField];
  if (typeof lifecycleReason !== 'string' || !lifecycleReason.trim()) {
    throw new Error(`windsurf_hook_${lifecycleField}_missing`);
  }
  return {
    event: expectedEvent,
    sessionId: value.session_id,
    lifecycleReason,
  };
}

/** Devin command Hooks must emit one JSON document and no raw stdout text. */
export function formatWindsurfLifecycleHookOutput(
  event: WindsurfLifecycleHookEvent,
  additionalContext?: string,
): string {
  if (event === 'SessionStart' && additionalContext) {
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    })}\n`;
  }
  return '{}\n';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
