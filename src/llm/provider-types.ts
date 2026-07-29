/**
 * LLM provider 运行时目录。
 *
 * 本模块刻意不依赖 Node/Electron，供 core、Electron main 和测试共享。
 * renderer 不复制运行时白名单，而是通过 provider-catalog IPC 获取该目录。
 */
export const LLM_PROVIDER_TYPES = [
  'anthropic',
  'vertex',
  'gemini',
  'ollama',
  'openai-compatible',
  'claude-cli',
  'codex-cli',
] as const;

export type LLMProviderType = typeof LLM_PROVIDER_TYPES[number];

export const EMBEDDING_PROVIDER_TYPES = [
  'vertex',
  'gemini',
  'ollama',
] as const;

export type EmbeddingProviderType = typeof EMBEDDING_PROVIDER_TYPES[number];

export type ProviderSourceType =
  | 'cloud_service'
  | 'local_subscription'
  | 'local_model';

export type ProviderBillingMode =
  | 'api'
  | 'account_cli'
  | 'local_compute';

export type ProviderTransport =
  | 'anthropic_sdk'
  | 'gemini_http'
  | 'openai_compatible_http'
  | 'account_cli';

export interface LLMProviderDefinition {
  id: LLMProviderType;
  labelKey: string;
  sourceType: ProviderSourceType;
  billingMode: ProviderBillingMode;
  transport: ProviderTransport;
  supportsLLM: boolean;
  supportsEmbedding: boolean;
}

export const LLM_PROVIDER_CATALOG: readonly LLMProviderDefinition[] = [
  {
    id: 'anthropic',
    labelKey: 'model.connection.provider.anthropic',
    sourceType: 'cloud_service',
    billingMode: 'api',
    transport: 'anthropic_sdk',
    supportsLLM: true,
    supportsEmbedding: false,
  },
  {
    id: 'vertex',
    labelKey: 'model.connection.provider.vertex',
    sourceType: 'cloud_service',
    billingMode: 'api',
    transport: 'anthropic_sdk',
    supportsLLM: true,
    supportsEmbedding: true,
  },
  {
    id: 'gemini',
    labelKey: 'model.connection.provider.gemini',
    sourceType: 'cloud_service',
    billingMode: 'api',
    transport: 'gemini_http',
    supportsLLM: true,
    supportsEmbedding: true,
  },
  {
    id: 'openai-compatible',
    labelKey: 'model.connection.provider.openai-compatible',
    sourceType: 'cloud_service',
    billingMode: 'api',
    transport: 'openai_compatible_http',
    supportsLLM: true,
    supportsEmbedding: false,
  },
  {
    id: 'claude-cli',
    labelKey: 'model.connection.provider.claude-cli',
    sourceType: 'local_subscription',
    billingMode: 'account_cli',
    transport: 'account_cli',
    supportsLLM: true,
    supportsEmbedding: false,
  },
  {
    id: 'codex-cli',
    labelKey: 'model.connection.provider.codex-cli',
    sourceType: 'local_subscription',
    billingMode: 'account_cli',
    transport: 'account_cli',
    supportsLLM: true,
    supportsEmbedding: false,
  },
  {
    id: 'ollama',
    labelKey: 'model.connection.provider.ollama',
    sourceType: 'local_model',
    billingMode: 'local_compute',
    transport: 'openai_compatible_http',
    supportsLLM: true,
    supportsEmbedding: true,
  },
] as const;

const LLM_PROVIDER_TYPE_SET: ReadonlySet<string> = new Set(LLM_PROVIDER_TYPES);
const EMBEDDING_PROVIDER_TYPE_SET: ReadonlySet<string> = new Set(EMBEDDING_PROVIDER_TYPES);

export function isLLMProviderType(value: unknown): value is LLMProviderType {
  return typeof value === 'string' && LLM_PROVIDER_TYPE_SET.has(value);
}

export function isEmbeddingProviderType(value: unknown): value is EmbeddingProviderType {
  return typeof value === 'string' && EMBEDDING_PROVIDER_TYPE_SET.has(value);
}

export function getLLMProviderDefinition(
  providerType: LLMProviderType,
): LLMProviderDefinition {
  const definition = LLM_PROVIDER_CATALOG.find(item => item.id === providerType);
  if (!definition) {
    throw new Error(`Unknown LLM provider type: ${providerType}`);
  }
  return definition;
}
