import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Marks the async scope of an invocation that is settling an already committed
 * prompt (post-response account/binding verification). A quiescing CLI runtime
 * admits child processes only from this scope, so a finished provider call can
 * be finalized instead of being turned into an ambiguous outcome by shutdown.
 */
const settling = new AsyncLocalStorage<true>();

export function runAsSettlingInvocation<T>(fn: () => Promise<T>): Promise<T> {
  return settling.run(true, fn);
}

export function isSettlingInvocation(): boolean {
  return settling.getStore() === true;
}
