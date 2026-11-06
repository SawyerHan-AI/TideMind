/** Bounded error metadata only: never serialize requests, responses, stdout or stack. */
export function cliErrorChain(error: unknown): Array<Record<string, string>> {
  const chain: Array<Record<string, string>> = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current) && chain.length < 6) {
    seen.add(current);
    const item = current as Error & { kind?: unknown; code?: unknown; cause?: unknown };
    // execFile errors may embed the entire command and child output in message.
    let message = item instanceof SyntaxError
      ? 'Invalid structured data (parser input omitted)'
      : item.message.startsWith('Command failed:')
      ? 'Command failed (command/output omitted)'
      : item.message.split(/[\r\n]/, 1)[0];
    message = message
      .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
      .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[redacted]')
      .replace(/https?:\/\/[^\s]+/g, '[url omitted]');
    const entry: Record<string, string> = { name: item.name.slice(0, 80), message: message.slice(0, 500) };
    for (const key of ['kind', 'code'] as const) {
      const value = item[key];
      if (typeof value === 'string' || typeof value === 'number') entry[key] = String(value).slice(0, 80);
    }
    chain.push(entry);
    current = item.cause;
  }
  return chain;
}
