import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { scanTomlTableHeaders } from './toml-table-headers.js';

export const CODEX_MCP_SEMANTIC_VERSION = 1;
export const MAX_CODEX_MCP_CONFIG_BYTES = 4 * 1024 * 1024;

export interface CodexMcpMeaning {
  enabled: true;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CodexMcpBlock {
  selector: string;
  raw: string;
  rawHash: string;
  semanticHash: string;
  meaning: CodexMcpMeaning;
}

export type CodexMcpComparison = {
  kind: 'exact' | 'equivalent';
  expected: CodexMcpBlock;
  observed: CodexMcpBlock;
} | {
  kind: 'different' | 'unverifiable';
  reason: 'unsupported_selector' | 'invalid_document' | 'unsupported_baseline'
    | 'unsupported_layout' | 'unsupported_entry' | 'meaning_changed';
};

const object = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype ? value as Record<string, unknown> : null;
};
const owns = (value: object, key: string): boolean => Object.hasOwn(value, key);
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

/** This is a versioned comparison contract, not a general TOML normalizer. */
function meaning(value: unknown): CodexMcpMeaning | null {
  const entry = object(value);
  if (!entry || Object.keys(entry).some(key => !['enabled', 'command', 'args', 'env'].includes(key))) return null;
  if (owns(entry, 'enabled') && entry.enabled !== true) return null;
  if (typeof entry.command !== 'string' || !entry.command || entry.command.includes('\0')) return null;
  if (!Array.isArray(entry.args) || !entry.args.length
    || !entry.args.every(value => typeof value === 'string' && !value.includes('\0'))) return null;
  const environment = object(entry.env);
  if (!environment || Object.keys(environment).some(key => ![
    'EB_AGENT_ID', 'EB_ACTIVITY_GENERATION_TOKEN', 'EB_HOST_VARIANT',
  ].includes(key))) return null;
  if (typeof environment.EB_AGENT_ID !== 'string' || !environment.EB_AGENT_ID
    || typeof environment.EB_ACTIVITY_GENERATION_TOKEN !== 'string' || !environment.EB_ACTIVITY_GENERATION_TOKEN) return null;
  if (owns(environment, 'EB_HOST_VARIANT') && !['codex-cli', 'codex-desktop'].includes(String(environment.EB_HOST_VARIANT))) return null;
  const env: Record<string, string> = Object.create(null);
  for (const key of Object.keys(environment).sort()) {
    const value = environment[key];
    if (typeof value !== 'string' || value.includes('\0')) return null;
    env[key] = value;
  }
  return { enabled: true, command: entry.command, args: [...entry.args] as string[], env };
}

function encoded(value: CodexMcpMeaning): string {
  return JSON.stringify(['codex-mcp-semantic', CODEX_MCP_SEMANTIC_VERSION, value]);
}

function readBlock(source: string, selector: string, baseline: boolean): CodexMcpBlock | CodexMcpComparison {
  if (Buffer.byteLength(source, 'utf8') > MAX_CODEX_MCP_CONFIG_BYTES) return { kind: 'unverifiable', reason: 'invalid_document' };
  let document: Record<string, unknown> | null;
  try { document = object(parse(source)); }
  catch { return { kind: 'unverifiable', reason: 'invalid_document' }; }
  const serverName = selector.slice('mcp_servers.'.length);
  const servers = object(document?.mcp_servers);
  if (!document || !servers || !owns(servers, serverName)) return { kind: 'unverifiable', reason: 'unsupported_layout' };
  if (baseline && (Object.keys(document).length !== 1 || Object.keys(servers).length !== 1)) {
    return { kind: 'unverifiable', reason: 'unsupported_baseline' };
  }
  const headers = scanTomlTableHeaders(source);
  const matches = headers.filter(header => !header.array && header.key === selector);
  if (matches.length !== 1) return { kind: 'unverifiable', reason: 'unsupported_layout' };
  const start = headers.indexOf(matches[0]);
  let next = start + 1;
  while (next < headers.length && headers[next].key.startsWith(`${selector}.`)) {
    if (headers[next].array || headers[next].key !== `${selector}.env`) return { kind: 'unverifiable', reason: 'unsupported_layout' };
    next++;
  }
  if (headers.slice(next).some(header => header.key === selector || header.key.startsWith(`${selector}.`))) {
    return { kind: 'unverifiable', reason: 'unsupported_layout' };
  }
  const lines = source.split('\n');
  const raw = `${lines.slice(matches[0].line, headers[next]?.line ?? lines.length).join('\n').trimEnd()}\n`;
  let isolated: Record<string, unknown> | null;
  try { isolated = object(object(parse(raw).mcp_servers)?.[serverName]); }
  catch { return { kind: 'unverifiable', reason: 'unsupported_layout' }; }
  const full = meaning(servers[serverName]);
  const part = meaning(isolated);
  if (!full || !part) return { kind: 'different', reason: 'unsupported_entry' };
  if (encoded(full) !== encoded(part)) return { kind: 'unverifiable', reason: 'unsupported_layout' };
  return { selector, raw, rawHash: sha(raw), semanticHash: sha(encoded(full)), meaning: full };
}

/** Caller separately proves ownership, current runtime, identity, consent and source.
 * Neither a successful comparison nor a hash grants bridge access.
 * Errors intentionally contain no parser excerpts or configuration values.
 */
export function compareCodexMcpSemantics(expectedBlock: string, currentDocument: string, selector: string): CodexMcpComparison {
  if (!/^mcp_servers\.tidemind-[A-Za-z0-9_-]+$/u.test(selector)) {
    return { kind: 'unverifiable', reason: 'unsupported_selector' };
  }
  const expected = readBlock(expectedBlock, selector, true);
  if ('kind' in expected) return expected;
  const observed = readBlock(currentDocument, selector, false);
  if ('kind' in observed) return observed;
  if (encoded(expected.meaning) !== encoded(observed.meaning)) return { kind: 'different', reason: 'meaning_changed' };
  return { kind: expected.raw === observed.raw ? 'exact' : 'equivalent', expected, observed };
}
