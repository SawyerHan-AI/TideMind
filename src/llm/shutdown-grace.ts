/**
 * Grace given to already committed CLI invocations when a long-lived runtime
 * shuts down. Covers the slowest observed background call (~89s).
 *
 * Dependency-free on purpose: the Electron Worker controller sizes its stopped
 * deadline from this value without loading the LLM client.
 */
export const LLM_SHUTDOWN_GRACE_MS = 120_000;
