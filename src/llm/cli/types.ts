export type CliProviderType = 'claude-cli' | 'codex-cli';
export type CliKind = 'claude' | 'codex';
export type CliInvocationPurpose = 'background' | 'connection_test';
export type CliCapabilityLevel = 'strict' | 'soft' | 'unsupported';

export interface CliLLMRequest {
  connectionId: string;
  providerType: CliProviderType;
  modelAlias: string;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  thinking?: { mode?: 'manual' | 'adaptive'; budget?: number };
  timeoutMs: number;
  operationName?: string;
  signal?: AbortSignal;
  purpose?: CliInvocationPurpose;
}

export interface CliLLMResult {
  text: string;
  selectedModelAlias: string;
  actualModel: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  providerUsage: Record<string, unknown> | null;
}

export interface CliCapabilities {
  maxOutputTokens: CliCapabilityLevel;
  structuredOutput: CliCapabilityLevel;
  thinking: CliCapabilityLevel;
  toolsDisabled: CliCapabilityLevel;
}

export interface ResolvedCli {
  kind: CliKind;
  path: string;
  version: string;
  controlledPath: string;
  source: 'development_override' | 'known_path' | 'login_shell';
  identity: {
    device: number;
    inode: number;
    size: number;
    ctimeMs: number;
    sha256: string;
  };
}

export type CliScopeState = 'known' | 'unknown';

/**
 * Non-secret authentication observation. `scopeKey` is a hash of official,
 * non-token account metadata (Codex account/read workspace id, Claude orgId).
 * `unknown` means the CLI only reports "logged in": such connections may run
 * an explicit user test but never unattended background inference (design §6.1).
 */
export interface CliAuthIdentity {
  providerType: CliProviderType;
  method: string;
  accountIdentifier: string | null;
  /** Capacity-lease key; `<provider>:local-login` when unknown. */
  accountScope: string;
  scopeState: CliScopeState;
  /** `<provider>:<sha256>` when known, `<provider>:unknown` otherwise. */
  scopeKey: string;
  /** Short non-secret display hint (plan type / org name). */
  scopeLabel: string | null;
}

export type CliCatalogItemKind = 'model' | 'alias';

/** One discovered (or fallback) model entry. Untrusted upstream data, validated on parse. */
export interface CliCatalogModel {
  /** Catalog key and the value users select/persist. */
  id: string;
  /** Value passed as the CLI model argument (independent argv element). */
  invocationId: string;
  displayName: string;
  kind: CliCatalogItemKind;
  isDefault: boolean;
  hidden: boolean;
  upgrade: string | null;
  retirementAt: number | null;
  reasoningEfforts: string[];
}

export type CliCatalogSource = 'codex_app_server' | 'claude_aliases' | 'unsupported';

export interface CliInvocationHooks {
  beforePromptCommit?: (request: CliLLMRequest) => void | Promise<void>;
  onPromptCommitted?: (request: CliLLMRequest) => void | Promise<void>;
  onFinished?: (
    request: CliLLMRequest,
    outcome: 'completed' | 'definite_failure' | 'ambiguous_outcome' | 'aborted',
  ) => void | Promise<void>;
}

export interface CliAdapter {
  readonly providerType: CliProviderType;
  readonly capabilities: CliCapabilities;
  run(request: CliLLMRequest): Promise<CliLLMResult>;
}
