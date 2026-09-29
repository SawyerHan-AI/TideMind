export type CliLLMErrorKind =
  | 'not_installed'
  | 'unsupported_version'
  | 'not_authenticated'
  | 'wrong_auth_method'
  | 'quota'
  | 'rate_limit'
  | 'capacity'
  | 'model_unavailable'
  | 'permission_policy'
  | 'timeout'
  | 'aborted'
  | 'ambiguous_outcome'
  | 'process_crash'
  | 'output_limit'
  | 'protocol'
  | 'scope_unknown'
  | 'model_mismatch'
  | 'transient';

export class CliLLMError extends Error {
  readonly name = 'CliLLMError';

  constructor(
    public readonly kind: CliLLMErrorKind,
    message: string,
    public readonly options: {
      retryable?: boolean;
      needsUserAction?: boolean;
      retryAt?: number;
      promptCommitted?: boolean;
      /** Admission block reason when the call was refused before submission. */
      admissionReason?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

/**
 * Provider refusals that the CLI reported explicitly (exit code + recognized error
 * text): the request was rejected, no generation result exists, and retrying later
 * cannot double-bill. Unlike crashes, timeouts or unparseable output after prompt
 * submission, these are definite failures and must stay model/connection scoped
 * instead of pausing the whole connection as ambiguous (design §5.4, §7.1).
 */
export const DEFINITIVE_PROVIDER_REJECTIONS: ReadonlySet<CliLLMErrorKind> = new Set([
  'model_unavailable',
  'quota',
  'rate_limit',
  'not_authenticated',
  'wrong_auth_method',
]);

export function isDefinitiveProviderRejection(error: unknown): boolean {
  return error instanceof CliLLMError && DEFINITIVE_PROVIDER_REJECTIONS.has(error.kind);
}

export function classifyCliFailure(message: string): CliLLMErrorKind {
  const text = message.toLowerCase();
  if (/not logged in|not authenticated|login required|unauthorized|http 401/.test(text)) {
    return 'not_authenticated';
  }
  if (/usage.?limit|quota|credit.*exhaust|limit exceeded/.test(text)) return 'quota';
  if (/rate.?limit|too many requests|http 429/.test(text)) return 'rate_limit';
  if (/model.*(?:not found|unavailable|unsupported)|unknown model/.test(text)) {
    return 'model_unavailable';
  }
  if (/deprecated|unknown (?:config|feature)|invalid (?:config|feature)/.test(text)) {
    return 'unsupported_version';
  }
  if (/permission|sandbox|tool|approval/.test(text)) return 'permission_policy';
  return 'process_crash';
}
