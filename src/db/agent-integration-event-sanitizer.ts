import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Agent Integration events are durable diagnostics, not a raw logging sink.
 * Keep this module free of Electron dependencies so every SQLite writer and
 * every schema entrypoint can use exactly the same persistence boundary.
 */
export const AGENT_INTEGRATION_EVENT_SANITIZER_VERSION = 16;
export const AGENT_INTEGRATION_EVENT_MAX_PAYLOAD_BYTES = 8 * 1024;
export const AGENT_INTEGRATION_EVENT_MAX_STRING_LENGTH = 512;
export const AGENT_INTEGRATION_EVENT_MAX_DEDUPE_LENGTH = 256;
export const AGENT_INTEGRATION_EVENT_MAX_DEPTH = 6;
export const AGENT_INTEGRATION_EVENT_MAX_COLLECTION_SIZE = 32;

const SANITIZER_VERSION_KEY = 'agent_integration_event_sanitizer_version';
const REDACTED_CREDENTIAL = '<redacted-credential>';
const REDACTED_PATH = '<local-path>';
const REDACTED_CONTENT = '<redacted-config-content>';
const TRUNCATED_DEPTH = '<truncated-depth>';
const TRUNCATED_COLLECTION = '<truncated-items>';
const TRUNCATION_METADATA_KEY = '_truncated';
const SCRUBBED_LEGACY_V15_TRUNCATED_OBJECT = 'legacy_v15_truncated_object';

const SENSITIVE_KEY = /(?:^|[_-])(?:access[_-]?key|api[_-]?key|auth(?:orization)?|bearer|cookie|credential|pass(?:word)?|private[_-]?key|refresh[_-]?token|secret|session[_-]?(?:id|key|token)|token)(?:$|[_-])/iu;
const CONTENT_KEY = /(?:^|[_-])(?:args?|arguments?|command|config(?:uration)?|content|document|env(?:ironment)?|file[_-]?(?:body|content|text)|input|output|prompt|raw|request(?:[_-]?body)?|response(?:[_-]?body)?|stderr|stdin|stdout|transcript)(?:$|[_-])/iu;
const HEADER_CREDENTIAL = /\b(authorization|cookie)\s*[:=]\s*[^\r\n,;]+/giu;
const INLINE_CREDENTIAL = /["']?\b(token|secret|password|passphrase|api[-_]?key|access[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?(?:id|key|token)|authorization|cookie|credential)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const SECRET_TOKEN = /\b(?:sk|key|token|secret|bearer)[-_][A-Za-z0-9._-]{12,}\b/giu;
const PEM_BLOCK = /-----BEGIN [^-\r\n]{1,80}-----[\s\S]*?-----END [^-\r\n]{1,80}-----/gu;
const HASHED_DEDUPE_KEY = /^sha256:[a-f0-9]{64}$/u;

export interface SanitizedAgentIntegrationEventPersistence {
  dedupeKey: string | null;
  payloadJson: string;
}

interface SanitizeContext {
  readonly seen: WeakSet<object>;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 3))}...`;
}

function normalizedFieldName(fieldName: string): string {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase();
}

function isSensitiveField(fieldName: string): boolean {
  return SENSITIVE_KEY.test(normalizedFieldName(fieldName));
}

function isContentField(fieldName: string): boolean {
  return CONTENT_KEY.test(normalizedFieldName(fieldName));
}

function looksLikeConfigurationText(value: string, fieldName?: string): boolean {
  if (fieldName && isContentField(fieldName)) return true;
  const trimmed = value.trim();
  if (/\b(?:config|configuration|document|file content)\s*[:=]\s*[[{]/iu.test(trimmed)) return true;
  if (/^\s*[[{]/u.test(trimmed)
    && /["'](?:mcpServers|mcp_servers|hooks|command|env|environment)["']\s*:/u.test(trimmed)) return true;
  if (!trimmed.includes('\n')) return false;
  return /(^|\n)\s*(?:\[[^\]]+\]|[A-Za-z0-9_.-]+\s*=|[{[])/u.test(trimmed);
}

function sanitizeText(value: string, maximum: number, fieldName?: string): string {
  if (looksLikeConfigurationText(value, fieldName)) return REDACTED_CONTENT;
  let sanitized = value
    .replace(PEM_BLOCK, REDACTED_CREDENTIAL)
    .replace(HEADER_CREDENTIAL, (_match, key: string) => `${key}=<redacted-credential>`)
    .replace(BEARER_CREDENTIAL, `Bearer ${REDACTED_CREDENTIAL}`)
    .replace(INLINE_CREDENTIAL, (_match, key: string) => `${key}=<redacted-credential>`)
    .replace(SECRET_TOKEN, REDACTED_CREDENTIAL);
  sanitized = redactLocalPathTokens(sanitized);
  sanitized = sanitized.replace(/\0/gu, '');
  return truncate(sanitized, maximum);
}

function pathBoundary(character: string | undefined): boolean {
  if (character === undefined) return true;
  if (character === '/' || character === '\\') return false;
  if ((character.codePointAt(0) ?? 0) <= 0x7f) {
    return /[\s("'`=,:;!?@+#\]{}<>|).-]|\[/u.test(character);
  }
  return /[\p{Z}\p{P}\p{S}]/u.test(character);
}

const PATH_CLOSER_BY_OPENER: Readonly<Record<string, string>> = Object.freeze({
  '"': '"',
  "'": "'",
  '`': '`',
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
  '（': '）',
  '【': '】',
  '「': '」',
  '『': '』',
  '《': '》',
  '〈': '〉',
});

function diagnosticSuffixStart(value: string, index: number): boolean {
  const rest = value.slice(index);
  // Comma, semicolon, quotes, brackets and plus are all legal filename bytes
  // on POSIX/macOS (and most are legal below a Windows share). Do not use one
  // byte as a path terminator: that redacts only a prefix such as
  // `/Users/Alice, Private/...` and persists the sensitive suffix. Preserve a
  // trailing diagnostic only when it has an explicit separator followed by a
  // bounded key/value label. Ambiguous prose is privacy-first and remains part
  // of the redacted token.
  return /^(?:[,;]\s+|\s+(?:->|=>|→|\|)\s*)(?:[\p{L}_][\p{L}\p{N}_.-]{0,40})\s*[:=]/u.test(rest);
}

function unquotedPathTerminator(value: string, index: number): boolean {
  const character = value[index];
  return character === '\0'
    || character === '\r'
    || character === '\n'
    || character === '\t'
    || diagnosticSuffixStart(value, index);
}

function matchingCloserTerminates(value: string, index: number, closer: string): boolean {
  if (value[index] !== closer) return false;
  // Quotes/backticks are explicit diagnostic delimiters. Treat their matching
  // closer as the token end so a following public URL or diagnostic is not
  // swallowed into the local path. Brackets remain privacy-first because they
  // are common legal filename bytes and need an unambiguous trailing boundary.
  if (closer === '"' || closer === "'" || closer === '`') return true;
  const next = value[index + 1];
  return next === undefined
    || next === '\0'
    || next === '\r'
    || next === '\n'
    || next === '\t'
    || diagnosticSuffixStart(value, index + 1)
    || /^[.!?。！？]\s*(?:$|[\r\n])/u.test(value.slice(index + 1));
}

const PUNCTUATION_PATH_SEGMENT_START = /[\][{}!?,;:'"]/u;

function explicitPathContext(value: string, pathStart: number): boolean {
  if (pathStart === 0) return true;
  const previous = value[pathStart - 1];
  if (previous !== undefined
    && Object.prototype.hasOwnProperty.call(PATH_CLOSER_BY_OPENER, previous)) return true;
  // Diagnostics are frequently localized (`路径：/ private`, `目标→/ private`).
  // pathBoundary already treats non-ASCII punctuation/symbols as token
  // boundaries; treat the same characters as an explicit context for the
  // otherwise ambiguous, but legal, leading-space POSIX segment. ASCII prose
  // such as `yes / no` stays outside this branch, and `/?` is still rejected by
  // validPathBodyStart below.
  if (previous !== undefined
    && (previous.codePointAt(0) ?? 0) > 0x7f
    && /[\p{P}\p{S}]/u.test(previous)) return true;
  return /(?:^|[\s,;|→])(?:[\p{L}_][\p{L}\p{N}_.-]{0,40})\s*[:=]\s*$/u
    .test(value.slice(Math.max(0, pathStart - 64), pathStart));
}

function validPathBodyStart(
  value: string,
  index: number,
  separators: readonly string[],
  allowLeadingSpace = false,
): boolean {
  let bodyStart = index;
  if (value[bodyStart] === ' ') {
    if (!allowLeadingSpace) return false;
    while (value[bodyStart] === ' ') bodyStart += 1;
  }
  const character = value[bodyStart];
  if (character === undefined || /[\s/\0]/u.test(character)) return false;
  if (!PUNCTUATION_PATH_SEGMENT_START.test(character)) return true;

  // Keep the conventional help spelling `/?` as ordinary text. Other
  // punctuation-leading leaf names are legal local paths and are privacy-first
  // even when they contain no second separator (`/[private]`, `C:\\!secret`).
  if (character === '?' && (value[bodyStart + 1] === undefined || /\s/u.test(value[bodyStart + 1]))) {
    return false;
  }
  if (/[^\s/\\\0]/u.test(value.slice(bodyStart + 1, bodyStart + 65))) return true;

  // A leading punctuation byte is legal in POSIX/macOS path segments and some
  // Windows spellings. The fallback covers a punctuation-only first segment
  // followed by another path segment while the special-case above preserves
  // the conventional `/?` help spelling.
  const lineEnd = value.slice(bodyStart).search(/[\0\r\n\t]/u);
  const boundedEnd = lineEnd < 0 ? value.length : bodyStart + lineEnd;
  return separators.some(separator => {
    const next = value.indexOf(separator, bodyStart + 1);
    const following = next < 0 ? undefined : value[next + 1];
    return next > bodyStart + 1
      && next < boundedEnd
      && following !== undefined
      && !/[\s/\\\0]/u.test(following);
  });
}

function scanPathEnd(value: string, start: number, minimumEnd: number): number {
  const closer = PATH_CLOSER_BY_OPENER[value[start - 1] ?? ''];
  let end = minimumEnd;
  while (end < value.length) {
    if (closer
      ? matchingCloserTerminates(value, end, closer)
      : unquotedPathTerminator(value, end)) break;
    end += 1;
  }
  // Preserve surrounding layout while replacing the complete sensitive token.
  // Spaces are legal within a path, but trailing diagnostic padding is not part
  // of it and does not need to disappear with the token.
  while (end > minimumEnd && /\s/u.test(value[end - 1])) end -= 1;
  return end;
}

const WINDOWS_GUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
const UNC_SERVER = /^[\p{L}\p{N}\p{M}_$-][\p{L}\p{N}\p{M}._$-]*$/u;

function validUncServer(server: string): boolean {
  return server !== '.' && server !== '..' && UNC_SERVER.test(server);
}

function validUncShare(share: string): boolean {
  return share.length > 0
    && share.trim() === share
    && share !== '.'
    && share !== '..'
    && /[\p{L}\p{N}\p{M}_$-]/u.test(share)
    && !/[\\/:*?"<>|\p{C}]/u.test(share);
}

function validUncAuthority(value: string, authorityStart: number): boolean {
  const serverEnd = value.indexOf('\\', authorityStart);
  if (serverEnd <= authorityStart) return false;
  const shareEnd = value.indexOf('\\', serverEnd + 1);
  const server = value.slice(authorityStart, serverEnd);
  const share = value.slice(serverEnd + 1, shareEnd < 0 ? value.length : shareEnd);
  // Conservative complete server/share grammar covers Unicode and WSL names,
  // while excluding regex text such as `\\d+\\w+` whose segments contain `+`.
  return validUncServer(server) && validUncShare(share);
}

function validWindowsNamespaceStart(value: string, index: number): boolean {
  const rest = value.slice(index);
  if (!path.win32.isAbsolute(rest)) return false;
  if (/^\\\\\?\\UNC\\/iu.test(rest)) return validUncAuthority(value, index + 8);
  if (/^\\\\[^?.][^\\]*\\/u.test(rest)) return validUncAuthority(value, index + 2);
  if (/^\\\\wsl\$\\/iu.test(rest)) return validUncAuthority(value, index + 2);
  if (/^\\\\[?.]\\[A-Za-z]:\\[^\\\s]/u.test(rest)) return true;
  const volume = new RegExp(`^\\\\\\\\\\?\\\\Volume\\{${WINDOWS_GUID}\\}\\\\[^\\\\\\s]`, 'iu');
  if (volume.test(rest)) return true;
  return /^\\\\\?\\GLOBALROOT\\Device\\[\p{L}\p{N}\p{M}._$-]+\\[^\\\s]/iu.test(rest);
}

function windowsNamespaceMinimumEnd(value: string, index: number): number {
  const rest = value.slice(index);
  const volume = new RegExp(`^\\\\\\\\\\?\\\\Volume\\{${WINDOWS_GUID}\\}\\\\[^\\\\\\s]`, 'iu').exec(rest);
  if (volume) return index + volume[0].length;
  return index + 2;
}

function validFileUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.port) return false;
    if (parsed.hostname === '' || parsed.hostname.toLowerCase() === 'localhost') {
      return path.posix.isAbsolute(fileURLToPath(parsed));
    }
    // Node correctly rejects non-local file URL authorities on POSIX. They are
    // nevertheless absolute network filesystem locations, so require both an
    // authority and a non-empty share/path before treating the token as local.
    return parsed.pathname.startsWith('/') && parsed.pathname.slice(1).length > 0;
  } catch {
    return false;
  }
}

function protocolRelativeNetworkUrl(candidate: string): boolean {
  try {
    const parsed = new URL(`https:${candidate}`);
    if (parsed.username || parsed.password || !parsed.hostname) return false;
    const authority = candidate.slice(2).split('/')[0] ?? '';
    // Single-label `//absolute/path` is intentionally privacy-first POSIX.
    // Preserve only unambiguous network URL authorities.
    return parsed.hostname.toLowerCase() === 'localhost'
      || parsed.hostname.includes('.')
      || authority.includes(':');
  } catch {
    return false;
  }
}

interface ProtectedSchemeUrl {
  readonly end: number;
  readonly sanitized: string;
}

function scanUrlTokenEnd(value: string, start: number, minimumEnd: number): number {
  const closer = PATH_CLOSER_BY_OPENER[value[start - 1] ?? ''];
  let end = minimumEnd;
  while (end < value.length) {
    const character = value[end];
    if (/\s|\0/u.test(character)) break;
    if (closer && character === closer) break;
    // Diagnostics commonly append another field without whitespace, for
    // example `url=https://host/docs;path=/Users/name/file`. Protecting that
    // entire byte sequence as a URL would persist the local path. Query and
    // fragment separators remain URL syntax; only an explicit diagnostic
    // delimiter plus key=absolute-local-path ends the protected URL token.
    if (urlDiagnosticPathAssignmentAt(value, end)) break;
    end += 1;
  }
  return end;
}

function startsAbsoluteLocalPath(value: string, index: number): boolean {
  const boundary = true;
  if (windowsDriveMinimumEnd(value, index, boundary) !== null) return true;
  if (value.slice(index, index + 7).toLowerCase() === 'file://') {
    return validFileUrl(value.slice(index, scanPathEnd(value, index, index + 7)));
  }
  if (value[index] === '~' && value[index + 1] === '/') {
    return validPathBodyStart(value, index + 2, ['/'], true);
  }
  if (value[index] === '\\' && value[index + 1] === '\\') {
    return validWindowsNamespaceStart(value, index);
  }
  if (value[index] !== '/') return false;
  let bodyStart = index + 1;
  while (value[bodyStart] === '/') bodyStart += 1;
  const slashCount = bodyStart - index;
  if (!validPathBodyStart(value, bodyStart, ['/'], true)) return false;
  const candidate = value.slice(index, scanPathEnd(value, index, bodyStart));
  return slashCount !== 2 || !protocolRelativeNetworkUrl(candidate);
}

function urlDiagnosticPathAssignmentAt(value: string, index: number): boolean {
  const match = /^(?:[,;|]|→|->|=>)\s*[\p{L}_][\p{L}\p{N}_.-]{0,40}\s*=\s*/u.exec(value.slice(index));
  return Boolean(match && startsAbsoluteLocalPath(value, index + match[0].length));
}

function redactUrlUserinfo(candidate: string, prefixLength: number): string {
  const authorityEndOffset = candidate.slice(prefixLength).search(/[/?#]/u);
  const authorityEnd = authorityEndOffset < 0 ? candidate.length : prefixLength + authorityEndOffset;
  const userinfoEnd = candidate.lastIndexOf('@', authorityEnd);
  if (userinfoEnd < prefixLength) return candidate;
  return `${candidate.slice(0, prefixLength)}${REDACTED_CREDENTIAL}@${candidate.slice(userinfoEnd + 1)}`;
}

function protectedSchemeUrl(value: string, index: number, boundary: boolean): ProtectedSchemeUrl | null {
  if (!boundary) return null;
  const prefix = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.exec(value.slice(index))?.[0];
  if (!prefix || prefix.toLowerCase() === 'file://') return null;
  const end = scanUrlTokenEnd(value, index, index + prefix.length);
  const candidate = value.slice(index, end);
  try {
    const parsed = new URL(candidate);
    return parsed.protocol.toLowerCase() === prefix.slice(0, -2).toLowerCase()
      && parsed.hostname
      ? { end, sanitized: redactUrlUserinfo(candidate, prefix.length) }
      : null;
  } catch {
    return null;
  }
}

function windowsDriveMinimumEnd(value: string, index: number, boundary: boolean): number | null {
  if (!boundary || !/[A-Za-z]/u.test(value[index] ?? '') || value[index + 1] !== ':') return null;
  const separator = value[index + 2];
  if (separator !== '\\' && separator !== '/') return null;
  const separatorCount = separator === '/' && value[index + 3] === '/' ? 2 : 1;
  const bodyStart = index + 2 + separatorCount;
  return validPathBodyStart(value, bodyStart, ['\\', '/'], true) ? bodyStart : null;
}

function posixMinimumEnd(value: string, index: number, boundary: boolean): number | null {
  if (!boundary || value[index] !== '/') return null;
  let bodyStart = index + 1;
  while (value[bodyStart] === '/') bodyStart += 1;
  const slashCount = bodyStart - index;
  if (!validPathBodyStart(value, bodyStart, ['/'], slashCount > 1 || explicitPathContext(value, index))) {
    return null;
  }
  const candidate = value.slice(index, scanPathEnd(value, index, bodyStart));
  return slashCount === 2 && protocolRelativeNetworkUrl(candidate) ? null : bodyStart;
}

/**
 * Redacts absolute filesystem tokens after arbitrary diagnostic punctuation.
 * A prefix-only regexp missed common Markdown and shell renderings such as
 * `` `/Users/name/file` ``, `->/private/tmp/file`, and `|C:\\Users\\name`.
 * Unicode diagnostic punctuation remains a valid start boundary, but is not a
 * terminator once a path begins: macOS and Windows both permit spaces and most
 * Unicode punctuation inside path segments. Quoted/bracketed paths terminate
 * at their matching closer; unquoted paths terminate only at unambiguous ASCII
 * diagnostic delimiters or a line boundary. HTTP(S) URLs and unambiguous
 * protocol-relative network URLs remain intact; privacy-first `//absolute`
 * POSIX paths, file URLs and Windows namespaces do not. Embedded `/path`
 * segments whose preceding character is a hostname/path character are ignored.
 */
function redactLocalPathTokens(value: string): string {
  let sanitized = '';
  let index = 0;
  while (index < value.length) {
    const current = value[index];
    const previous = index === 0 ? undefined : value[index - 1];
    const boundary = pathBoundary(previous);
    // A Windows drive is an absolute local path even when written with a
    // doubled forward slash (`C://Users/...`). Handle it before the generic
    // scheme grammar so `C://` can never be protected as a public URL.
    const windowsMinimumEnd = windowsDriveMinimumEnd(value, index, boundary);
    const schemeUrl = windowsMinimumEnd === null ? protectedSchemeUrl(value, index, boundary) : null;
    if (schemeUrl !== null) {
      sanitized += schemeUrl.sanitized;
      index = schemeUrl.end;
      continue;
    }
    const fileUrlStart = value.slice(index, index + 7).toLowerCase() === 'file://'
      && boundary;
    const posixMinimum = posixMinimumEnd(value, index, boundary);
    const home = current === '~'
      && value[index + 1] === '/'
      && validPathBodyStart(value, index + 2, ['/'], true)
      && boundary;
    const windows = windowsMinimumEnd !== null;
    const windowsNamespaceStart = current === '\\' && value[index + 1] === '\\'
      && boundary
      && validWindowsNamespaceStart(value, index);
    const tentativeMinimumEnd = fileUrlStart
      ? index + 7
      : windows
        ? windowsMinimumEnd!
        : windowsNamespaceStart
          ? windowsNamespaceMinimumEnd(value, index)
          : index + 2;
    const tentativeEnd = fileUrlStart || posixMinimum !== null || windowsNamespaceStart
      ? scanPathEnd(value, index, tentativeMinimumEnd)
      : tentativeMinimumEnd;
    const candidate = value.slice(index, tentativeEnd);
    const fileUrl = fileUrlStart && validFileUrl(candidate);
    const posix = posixMinimum !== null;
    const unc = windowsNamespaceStart;
    if (!fileUrl && !posix && !home && !windows && !unc) {
      sanitized += current;
      index += 1;
      continue;
    }
    const minimumEnd = fileUrl
      ? index + 7
      : windows
        ? windowsMinimumEnd!
        : unc
          ? windowsNamespaceMinimumEnd(value, index)
          : index + 2;
    const end = tentativeEnd > minimumEnd ? tentativeEnd : scanPathEnd(value, index, minimumEnd);
    sanitized += REDACTED_PATH;
    index = end;
  }
  return sanitized;
}

function looksLikeConfigurationObject(value: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(value).map(key => key.toLowerCase()));
  return keys.has('mcpservers') || keys.has('hooks');
}

function sanitizedObjectKey(rawKey: string): string {
  if (sanitizeText(rawKey, 96) === rawKey) return rawKey;
  return `_redacted_key_sha256_${createHash('sha256').update(rawKey).digest('hex')}`;
}

function sanitizeValue(
  value: unknown,
  context: SanitizeContext,
  depth: number,
  fieldName?: string,
): unknown {
  if (fieldName && isSensitiveField(fieldName)) return REDACTED_CREDENTIAL;
  if (fieldName && isContentField(fieldName)) return REDACTED_CONTENT;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return sanitizeText(value, AGENT_INTEGRATION_EVENT_MAX_STRING_LENGTH, fieldName);
  }
  if (typeof value === 'bigint') return truncate(value.toString(), AGENT_INTEGRATION_EVENT_MAX_STRING_LENGTH);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (depth >= AGENT_INTEGRATION_EVENT_MAX_DEPTH) return TRUNCATED_DEPTH;
  if (typeof value !== 'object') return null;
  if (context.seen.has(value)) return '<circular-reference>';
  context.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, AGENT_INTEGRATION_EVENT_MAX_COLLECTION_SIZE)
        .map(item => sanitizeValue(item, context, depth + 1));
      if (value.length > AGENT_INTEGRATION_EVENT_MAX_COLLECTION_SIZE) items.push(TRUNCATED_COLLECTION);
      return items;
    }
    const record = value as Record<string, unknown>;
    if (looksLikeConfigurationObject(record)) return REDACTED_CONTENT;
    const recordKeys = Object.keys(record);
    if (recordKeys.length > AGENT_INTEGRATION_EVENT_MAX_COLLECTION_SIZE
      && Object.prototype.hasOwnProperty.call(record, TRUNCATION_METADATA_KEY)) {
      // The internal truncation marker must never overwrite or impersonate a
      // caller-owned field, even when that field falls outside the retained
      // window. Keep the error generic because object keys may be sensitive.
      throw new Error('Agent Integration event object-key redaction collision');
    }
    const sanitized = Object.create(null) as Record<string, unknown>;
    const originalKeys = new Map<string, string>();
    const entries = Object.entries(record).slice(0, AGENT_INTEGRATION_EVENT_MAX_COLLECTION_SIZE);
    for (let index = 0; index < entries.length; index += 1) {
      const [rawKey, item] = entries[index];
      const safeKey = sanitizedObjectKey(rawKey);
      const existing = originalKeys.get(safeKey);
      if (existing !== undefined && existing !== rawKey) {
        // Never echo either raw key: a collision can involve an absolute path
        // or credential-bearing diagnostic. Reject the entire event instead
        // of silently overwriting one field in the durable audit trail.
        throw new Error('Agent Integration event object-key redaction collision');
      }
      originalKeys.set(safeKey, rawKey);
      sanitized[safeKey] = sanitizeValue(item, context, depth + 1, rawKey);
    }
    if (recordKeys.length > AGENT_INTEGRATION_EVENT_MAX_COLLECTION_SIZE) {
      sanitized[TRUNCATION_METADATA_KEY] = TRUNCATED_COLLECTION;
    }
    return sanitized;
  } finally {
    context.seen.delete(value);
  }
}

function sanitizedPayloadJson(payload: unknown): string {
  const sanitized = sanitizeValue(payload === undefined ? {} : payload, { seen: new WeakSet() }, 0);
  const serialized = JSON.stringify(sanitized ?? {});
  if (byteLength(serialized) <= AGENT_INTEGRATION_EVENT_MAX_PAYLOAD_BYTES) return serialized;
  return JSON.stringify({ _scrubbed: 'payload_limit_exceeded' });
}

export function sanitizeAgentIntegrationEventPersistence(input: {
  kind: string;
  dedupeKey?: string | null;
  payload?: unknown;
}): SanitizedAgentIntegrationEventPersistence {
  const dedupeKey = input.dedupeKey == null
    ? null
    : hashDedupeKey(input.kind, input.dedupeKey);
  return {
    dedupeKey,
    payloadJson: sanitizedPayloadJson(input.payload),
  };
}

function hashDedupeKey(kind: string, dedupeKey: string): string | null {
  if (!dedupeKey) return null;
  if (HASHED_DEDUPE_KEY.test(dedupeKey)) return dedupeKey;
  return `sha256:${createHash('sha256').update(kind).update('\0').update(dedupeKey).digest('hex')}`;
}

function parseHistoricalPayload(payloadJson: string): unknown {
  if (byteLength(payloadJson) > AGENT_INTEGRATION_EVENT_MAX_PAYLOAD_BYTES) {
    return { _scrubbed: 'payload_limit_exceeded' };
  }
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    // An invalid historical payload is not useful enough to justify retaining
    // its raw bytes, which may themselves contain a credential or config body.
    return { _scrubbed: 'invalid_payload_json' };
  }
}

/**
 * Sanitizer v15 represented an object larger than the collection limit as the
 * first 32 caller keys plus `_truncated: "<truncated-items>"`. V16 reserves
 * that key by rejecting ambiguous new writes, but feeding the old 33-key shape
 * through the new-write path would abort schema initialization. There is no
 * reliable way to distinguish v15's marker from a caller value that happened
 * to be identical, so historical migration drops the whole ambiguous object.
 *
 * This compatibility transform is deliberately used only by the versioned
 * historical scrub. New v16 writes keep the collision fail-closed behavior.
 */
function scrubHistoricalV15TruncatedObjects(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth >= AGENT_INTEGRATION_EVENT_MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => scrubHistoricalV15TruncatedObjects(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === AGENT_INTEGRATION_EVENT_MAX_COLLECTION_SIZE + 1
    && Object.prototype.hasOwnProperty.call(record, TRUNCATION_METADATA_KEY)
    && record[TRUNCATION_METADATA_KEY] === TRUNCATED_COLLECTION) {
    const scrubbed = Object.create(null) as Record<string, string>;
    scrubbed._scrubbed = SCRUBBED_LEGACY_V15_TRUNCATED_OBJECT;
    return scrubbed;
  }

  const normalized = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    normalized[key] = scrubHistoricalV15TruncatedObjects(item, depth + 1);
  }
  return normalized;
}

/**
 * One-time, versioned scrub for rows written before the persistence boundary
 * existed. Bump AGENT_INTEGRATION_EVENT_SANITIZER_VERSION whenever the stored
 * representation changes and the historical pass must run again.
 */
export function scrubPersistedAgentIntegrationEvents(db: Database.Database): void {
  const current = Number((db.prepare('SELECT value FROM metadata WHERE key = ?')
    .get(SANITIZER_VERSION_KEY) as { value?: string } | undefined)?.value ?? 0);
  if (Number.isInteger(current) && current >= AGENT_INTEGRATION_EVENT_SANITIZER_VERSION) return;

  db.transaction(() => {
    const rows = db.prepare(`
      SELECT id, kind, dedupe_key, payload_json
      FROM agent_integration_events
      ORDER BY created_at, id
    `).all() as Array<{
      id: string;
      kind: string;
      dedupe_key: string | null;
      payload_json: string;
    }>;
    const conflictingDedupe = db.prepare(`
      SELECT id FROM agent_integration_events
      WHERE kind = ? AND dedupe_key = ? AND id != ?
      LIMIT 1
    `);
    const update = db.prepare(`
      UPDATE agent_integration_events SET dedupe_key = ?, payload_json = ? WHERE id = ?
    `);
    for (const row of rows) {
      const sanitized = sanitizeAgentIntegrationEventPersistence({
        kind: row.kind,
        dedupeKey: row.dedupe_key,
        payload: scrubHistoricalV15TruncatedObjects(parseHistoricalPayload(row.payload_json)),
      });
      const dedupeKey = sanitized.dedupeKey !== null
        && conflictingDedupe.get(row.kind, sanitized.dedupeKey, row.id)
        ? null
        : sanitized.dedupeKey;
      update.run(dedupeKey, sanitized.payloadJson, row.id);
    }
    db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(SANITIZER_VERSION_KEY, String(AGENT_INTEGRATION_EVENT_SANITIZER_VERSION));
  }).immediate();
}
