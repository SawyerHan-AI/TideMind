import { delimiter, dirname } from 'node:path';

const SAFE_EXACT = new Set([
  'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'SHELL',
]);

function isLocaleKey(key: string): boolean {
  return key.startsWith('LC_');
}

export function sanitizeCliEnvironment(
  source: NodeJS.ProcessEnv,
  executablePath?: string,
  controlledPath?: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (SAFE_EXACT.has(key) || isLocaleKey(key))) result[key] = value;
  }
  const pathParts = [
    executablePath ? dirname(executablePath) : null,
    ...(controlledPath ?? '/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
      .split(delimiter),
  ].filter((value): value is string => Boolean(value?.startsWith('/')));
  result.PATH = [...new Set(pathParts)].join(delimiter);
  return result;
}

export function assertNoForbiddenEnvironment(env: NodeJS.ProcessEnv): void {
  const forbidden = [
    /(?:API|ACCESS|AUTH|SESSION|BUSINESS|REFRESH)_?(?:KEY|TOKEN)$/i,
    /(?:^|_)BASE_URL$/i,
    /^NODE_OPTIONS$/,
    /^(?:DYLD|LD)_/,
    /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i,
    /^(?:SSL_CERT|NODE_EXTRA_CA_CERT)/,
    /^SSH_AUTH_SOCK$/,
    /^CODEX_HOME$/,
    /^CLAUDE_CONFIG_DIR$/,
  ];
  const leaked = Object.keys(env).filter((key) => forbidden.some((pattern) => pattern.test(key)));
  if (leaked.length > 0) throw new Error(`unsafe CLI environment keys: ${leaked.join(', ')}`);
}
