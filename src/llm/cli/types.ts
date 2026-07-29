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

export interface CliAuthIdentity {
  providerType: CliProviderType;
  method: string;
  accountIdentifier: string | null;
  accountScope: string;
}

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
