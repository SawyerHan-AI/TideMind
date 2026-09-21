export const CURSOR_LIFECYCLE_HOOK_EVENTS = [
  'sessionStart',
  'preCompact',
  'sessionEnd',
] as const;

export type CursorLifecycleHookEvent = typeof CURSOR_LIFECYCLE_HOOK_EVENTS[number];

export interface CursorLifecycleHookPayload {
  hook_event_name: CursorLifecycleHookEvent;
  conversation_id: string;
  session_id?: string;
  cursor_version: string;
  [key: string]: unknown;
}

/** Parse only the host fields used to bind runtime evidence to a real Cursor session. */
export function parseCursorLifecycleHookPayload(
  source: string,
  expectedEvent: CursorLifecycleHookEvent,
): CursorLifecycleHookPayload {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('cursor_hook_input_not_json');
  }
  if (!isObject(value)) throw new Error('cursor_hook_input_not_object');
  if (value.hook_event_name !== expectedEvent) throw new Error('cursor_hook_event_mismatch');
  if (typeof value.cursor_version !== 'string' || !value.cursor_version.trim()) {
    throw new Error('cursor_hook_version_missing');
  }
  if (typeof value.conversation_id !== 'string' || !value.conversation_id.trim()) {
    throw new Error('cursor_hook_conversation_missing');
  }
  if (expectedEvent === 'sessionStart' || expectedEvent === 'sessionEnd') {
    if (typeof value.session_id !== 'string' || !value.session_id.trim()) {
      throw new Error('cursor_hook_session_missing');
    }
    if (value.session_id !== value.conversation_id) {
      throw new Error('cursor_hook_session_identity_mismatch');
    }
  }
  return value as CursorLifecycleHookPayload;
}

/** Cursor command hooks must emit one JSON document and no raw stdout text. */
export function formatCursorLifecycleHookOutput(
  event: CursorLifecycleHookEvent,
  additionalContext?: string,
): string {
  if (event === 'sessionStart' && additionalContext) {
    return `${JSON.stringify({ additional_context: additionalContext })}\n`;
  }
  return '{}\n';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
