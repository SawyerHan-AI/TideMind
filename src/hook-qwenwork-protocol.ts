export const QWENWORK_LIFECYCLE_HOOK_EVENTS = [
  'SessionStart',
  'PreCompact',
  'SessionEnd',
] as const;

export type QwenWorkLifecycleHookEvent = typeof QWENWORK_LIFECYCLE_HOOK_EVENTS[number];

export interface QwenWorkLifecycleHookMetadata {
  event: QwenWorkLifecycleHookEvent;
  sessionId: string;
  lifecycleReason: string;
}

/**
 * Retain only the documented lifecycle identity fields. Conversation/tool
 * content present in the stdin envelope must never become activity evidence.
 */
export function parseQwenWorkLifecycleHookMetadata(
  source: string,
  expectedEvent: QwenWorkLifecycleHookEvent,
): QwenWorkLifecycleHookMetadata {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('qwenwork_hook_input_not_json');
  }
  if (!isObject(value)) throw new Error('qwenwork_hook_input_not_object');
  if (value.hook_event_name !== expectedEvent) throw new Error('qwenwork_hook_event_mismatch');
  if (typeof value.session_id !== 'string' || !value.session_id.trim()) {
    throw new Error('qwenwork_hook_session_missing');
  }
  const lifecycleField = expectedEvent === 'SessionStart'
    ? 'source'
    : expectedEvent === 'PreCompact'
      ? 'trigger'
      : 'reason';
  const lifecycleReason = value[lifecycleField];
  if (typeof lifecycleReason !== 'string' || !lifecycleReason.trim()) {
    throw new Error(`qwenwork_hook_${lifecycleField}_missing`);
  }
  return { event: expectedEvent, sessionId: value.session_id, lifecycleReason };
}

/** QwenWork command Hooks parse stdout as one JSON document. */
export function formatQwenWorkLifecycleHookOutput(
  event: QwenWorkLifecycleHookEvent,
  additionalContext?: string,
): string {
  if ((event === 'SessionStart' || event === 'PreCompact') && additionalContext) {
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext,
      },
    })}\n`;
  }
  return '{}\n';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
