import { CliLLMError, classifyCliFailure } from './errors.js';
import type { CliLLMResult } from './types.js';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const SAFE_ITEM_TYPES = new Set(['agent_message', 'reasoning']);
const SAFE_EVENTS = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'item.started',
  'item.updated',
  'item.completed',
]);

export function parseCodexJsonLines(
  stdout: string,
  selectedModelAlias: string,
  exitCode = 0,
  stderr = '',
): CliLLMResult {
  if (exitCode !== 0) {
    const kind = classifyCliFailure(stderr);
    throw new CliLLMError(kind, `Codex CLI failed with exit code ${exitCode}`, {
      needsUserAction: ['not_authenticated', 'quota', 'permission_policy'].includes(kind),
    });
  }
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new CliLLMError('protocol', 'Codex CLI returned no JSONL events');
  const messages: string[] = [];
  let completed = false;
  let usage: Record<string, unknown> | null = null;
  let actualModel: string | null = null;

  for (const line of lines) {
    let event: Record<string, unknown> | null;
    try {
      event = record(JSON.parse(line));
    } catch (cause) {
      throw new CliLLMError('protocol', 'Codex CLI returned truncated or malformed JSONL', { cause });
    }
    if (!event || typeof event.type !== 'string') {
      throw new CliLLMError('protocol', 'Codex CLI event is missing its type');
    }
    if (event.type === 'error' || event.type === 'turn.failed') {
      const message = typeof event.message === 'string' ? event.message : 'Codex turn failed';
      throw new CliLLMError(classifyCliFailure(message), 'Codex turn failed');
    }
    if (!SAFE_EVENTS.has(event.type)) {
      throw new CliLLMError(
        'permission_policy',
        'Codex emitted an unsupported active event',
        { needsUserAction: true },
      );
    }
    const item = record(event.item);
    if (item) {
      if (item.type === 'error') {
        const message =
          typeof item.message === 'string'
            ? item.message
            : typeof item.text === 'string'
              ? item.text
              : 'Codex turn failed';
        const kind = classifyCliFailure(message);
        throw new CliLLMError(kind, 'Codex turn failed', {
          needsUserAction: ['not_authenticated', 'quota', 'permission_policy'].includes(kind),
        });
      }
      if (typeof item.type !== 'string' || !SAFE_ITEM_TYPES.has(item.type)) {
        throw new CliLLMError(
          'permission_policy',
          'Codex emitted a forbidden item type',
          { needsUserAction: true },
        );
      }
      if (
        event.type === 'item.completed' &&
        item.type === 'agent_message' &&
        typeof item.text === 'string'
      ) {
        messages.push(item.text);
      }
    }
    if (event.type === 'thread.started') {
      actualModel =
        typeof event.model === 'string'
          ? event.model
          : typeof record(event.thread)?.model === 'string'
            ? String(record(event.thread)?.model)
            : actualModel;
    }
    if (event.type === 'turn.completed') {
      completed = true;
      usage = record(event.usage) ?? record(record(event.turn)?.usage);
      const model = event.model ?? record(event.turn)?.model;
      if (typeof model === 'string') actualModel = model;
    }
  }
  const text = messages.join('');
  if (!completed || text.trim().length === 0) {
    throw new CliLLMError('protocol', 'Codex CLI output is missing completion or assistant text');
  }
  return {
    text,
    selectedModelAlias,
    actualModel,
    inputTokens: numberOrNull(usage?.input_tokens ?? usage?.inputTokens),
    cachedInputTokens: numberOrNull(
      usage?.cached_input_tokens ?? usage?.cachedInputTokens,
    ),
    outputTokens: numberOrNull(usage?.output_tokens ?? usage?.outputTokens),
    reasoningTokens: numberOrNull(
      usage?.reasoning_tokens ?? usage?.reasoningTokens,
    ),
    providerUsage: usage,
  };
}
