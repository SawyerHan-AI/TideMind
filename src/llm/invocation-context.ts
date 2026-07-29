import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMTier } from './route.js';

export interface LLMInvocationContext {
  taskId: string;
  claimKey: string;
  /** Exact retryable work item, used to atomically suppress ambiguous replay. */
  workItemId?: string;
  tier?: LLMTier;
  operation?: string;
  connectionId?: string | null;
}

export interface ActiveLLMTask {
  taskId: string;
  tier: LLMTier;
  connectionId: string | null;
}

const storage = new AsyncLocalStorage<LLMInvocationContext>();
let activeTaskListener: ((task: ActiveLLMTask | null) => void) | null = null;

export function runWithLLMInvocationContext<T>(
  context: LLMInvocationContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

export function getLLMInvocationContext(): LLMInvocationContext | undefined {
  return storage.getStore();
}

export function noteActiveLLMRoute(tier: LLMTier, connectionId: string | null): void {
  const context = storage.getStore();
  if (!context) return;
  context.tier = tier;
  context.connectionId = connectionId;
  try {
    activeTaskListener?.({ taskId: context.taskId, tier, connectionId });
  } catch {
    // UI notification must not affect task execution.
  }
}

export function clearActiveLLMTask(taskId: string): void {
  const context = storage.getStore();
  if (context?.taskId === taskId) {
    context.connectionId = undefined;
  }
  try {
    activeTaskListener?.(null);
  } catch {
    // UI notification must not affect task execution.
  }
}

export function setActiveLLMTaskListener(
  listener: ((task: ActiveLLMTask | null) => void) | null,
): void {
  activeTaskListener = listener;
}
