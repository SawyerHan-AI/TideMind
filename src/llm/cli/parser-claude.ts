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

export function parseClaudeResult(
  stdout: string,
  selectedModelAlias: string,
  exitCode = 0,
  stderr = '',
): CliLLMResult {
  if (exitCode !== 0) {
    const kind = classifyCliFailure(stderr);
    throw new CliLLMError(kind, `Claude CLI failed with exit code ${exitCode}`, {
      needsUserAction: ['not_authenticated', 'quota', 'permission_policy'].includes(kind),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new CliLLMError('protocol', 'Claude CLI returned malformed JSON', { cause });
  }
  const root = record(parsed);
  if (
    !root ||
    root.type !== 'result' ||
    root.subtype !== 'success' ||
    root.is_error === true ||
    typeof root.result !== 'string' ||
    root.result.trim().length === 0
  ) {
    throw new CliLLMError('protocol', 'Claude CLI did not return a successful text result');
  }
  const usage = record(root.usage);
  const modelUsage = record(root.modelUsage);
  const actualModel = modelUsage ? Object.keys(modelUsage)[0] ?? null : null;
  const selectedUsage = actualModel ? record(modelUsage?.[actualModel]) : null;
  return {
    text: root.result,
    selectedModelAlias,
    actualModel:
      typeof root.model === 'string'
        ? root.model
        : actualModel,
    inputTokens: numberOrNull(usage?.input_tokens ?? selectedUsage?.inputTokens),
    cachedInputTokens: numberOrNull(
      usage?.cache_read_input_tokens ?? selectedUsage?.cacheReadInputTokens,
    ),
    outputTokens: numberOrNull(usage?.output_tokens ?? selectedUsage?.outputTokens),
    reasoningTokens: numberOrNull(usage?.reasoning_tokens),
    providerUsage: usage,
  };
}
