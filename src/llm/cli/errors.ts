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
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
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
