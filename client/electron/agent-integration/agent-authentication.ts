import { claudeConfigRootEnvironment } from './claude-config-environment'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { CliChildProcessRunner, CliProcessRegistry } from '@server/llm/cli/child-process-runner.js'
import { parseCodexAccount } from '@server/llm/cli/codex-app-server.js'
import { CliLLMError } from '@server/llm/cli/errors.js'
import { createCliRuntimeDirectory } from '@server/llm/cli/runtime-dir.js'
import { readAgentCodexAuthentication } from './agent-authentication-rpc'
import { checkCodexDeclaredRouting, hasCodexRouteOverride } from '@server/llm/cli/codex-declared-routing.js'

export interface AgentAuthenticationTarget {
  installationId: string
  hostVariant: string
  executable: string
  configRoot: string
  homeDir: string
}

export interface AgentAuthenticationResult {
  status: 'authenticated' | 'explicitly_unauthenticated' | 'unsupported' | 'unavailable' | 'cancelled'
  billing: 'confirmed_subscription' | 'metered' | 'unknown'
  reason: string
}

export interface AgentAuthenticationOptions {
  target: AgentAuthenticationTarget
  /** Application-owned scratch parent; credentials/config are never copied here. */
  dataDir: string
  /** Required A-side source + current Installation check, immediately before spawn. */
  attest: (target: Readonly<AgentAuthenticationTarget>, signal: AbortSignal) => Promise<boolean>
  sourceEnv?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  /** Hermetic tests supply synthetic system paths instead of the local layers. */
  codexSystemConfigPaths?: readonly string[]
}

const result = (status: AgentAuthenticationResult['status'], billing: AgentAuthenticationResult['billing'], reason: string): AgentAuthenticationResult => ({ status, billing, reason })
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const normalized = (value: unknown): string => typeof value === 'string' ? value.trim().toLowerCase() : ''
const CLAUDE_SUBSCRIPTIONS = new Set(['pro', 'max', 'team', 'enterprise'])
const CODEX_SUBSCRIPTIONS = new Set(['plus', 'pro', 'team', 'business', 'enterprise', 'edu'])

export function classifyClaudeAuthentication(value: unknown): AgentAuthenticationResult {
  const status = object(value)
  if (!status || typeof status.loggedIn !== 'boolean') return result('unavailable', 'unknown', 'auth_protocol_unknown')
  if (!status.loggedIn) return result('explicitly_unauthenticated', 'unknown', 'host_reports_not_authenticated')
  const method = normalized(status.authMethod), provider = normalized(status.apiProvider)
  const firstParty = ['firstparty', 'first-party', 'anthropic'].includes(provider)
  if (firstParty && ['claude.ai', 'oauth', 'subscription'].includes(method)
    && CLAUDE_SUBSCRIPTIONS.has(normalized(status.subscriptionType))) return result('authenticated', 'confirmed_subscription', 'subscription_confirmed')
  if (['api_key', 'api_key_helper'].includes(method) || ['bedrock', 'vertex', 'foundry'].includes(provider)) {
    return result('authenticated', 'metered', 'metered_authentication')
  }
  return result('authenticated', 'unknown', 'billing_unconfirmed')
}

export function classifyCodexAuthentication(accountValue: unknown, configuration: unknown): AgentAuthenticationResult {
  const raw = object(accountValue)
  if (!raw || !('account' in raw) || (raw.account !== null && !object(raw.account))) return result('unavailable', 'unknown', 'auth_protocol_unknown')
  const account = parseCodexAccount(raw)
  const config = object(object(configuration)?.config)
  // Require the observed effective provider. A ChatGPT account alone says
  // nothing about a user-selected custom provider, including an 'openai' override.
  const providers = object(config?.model_providers)
  const officialProvider = config?.model_provider === 'openai'
    && (config.profile === undefined || config.profile === null || config.profile === '')
    && (config.model_providers === undefined || config.model_providers === null || providers !== null)
    && !Object.prototype.hasOwnProperty.call(providers ?? {}, 'openai')
    && !hasCodexRouteOverride(config)
  if (account.kind === 'none') {
    return account.requiresOpenaiAuth && officialProvider
      ? result('explicitly_unauthenticated', 'unknown', 'host_reports_not_authenticated')
      : result('unavailable', 'unknown', 'provider_authentication_unconfirmed')
  }
  if (account.kind === 'api_key') return result('authenticated', 'metered', 'metered_authentication')
  if (account.kind === 'chatgpt' && officialProvider && CODEX_SUBSCRIPTIONS.has(normalized(account.planType))) {
    return result('authenticated', 'confirmed_subscription', 'subscription_confirmed')
  }
  return result('authenticated', 'unknown', 'billing_unconfirmed')
}

const COMMON_ENV = ['USER', 'LOGNAME', 'LANG', 'TMPDIR', 'SHELL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']
const CLAUDE_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_MODEL', 'AWS_PROFILE', 'AWS_REGION', 'GOOGLE_CLOUD_PROJECT']
const CODEX_ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY']

/** Configuration only: never opens .credentials.json, auth.json or Keychain.
 * Keep only a routing verdict, never retain/log the settings or credential values.
 */
async function claudeSettingsRouting(configRoot: string): Promise<'clear' | 'override' | 'unknown'> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path.join(configRoot, 'settings.json'), 'r')
    const buffer = Buffer.alloc(64 * 1024 + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 64 * 1024) return 'unknown'
    const settings = object(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')))
    if (!settings) return 'unknown'
    if (settings.apiKeyHelper !== undefined && settings.apiKeyHelper !== null && settings.apiKeyHelper !== '') return 'override'
    if (settings.env === undefined) return 'clear'
    const env = object(settings.env)
    if (!env) return 'unknown'
    return CLAUDE_ENV.some(key => env[key] !== undefined && env[key] !== null && env[key] !== '')
      ? 'override' : 'clear'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'clear' : 'unknown'
  } finally { await file?.close() }
}

/** Only known target-routing/auth variables; no PATH discovery or shell startup. */
function environment(target: AgentAuthenticationTarget, source: NodeJS.ProcessEnv, claude: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: target.homeDir,
    PATH: [path.dirname(target.executable), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter) }
  for (const key of [...COMMON_ENV, ...(claude ? CLAUDE_ENV : CODEX_ENV)]) if (source[key] !== undefined) env[key] = source[key]
  for (const key of Object.keys(source)) if (key.startsWith('LC_')) env[key] = source[key]
  if (claude) Object.assign(env, claudeConfigRootEnvironment(target.homeDir, target.configRoot, source))
  else env.CODEX_HOME = target.configRoot
  return env
}

/** No login/logout, direct credential reads, model invocation or explicit refresh request. */
export async function probeAgentAuthentication(options: AgentAuthenticationOptions): Promise<AgentAuthenticationResult> {
  const target = Object.freeze({ ...options.target })
  const claude = ['claude-code-cli', 'claude-code-native'].includes(target.hostVariant)
  if (!claude && target.hostVariant !== 'codex-cli') return result('unsupported', 'unknown', 'auth_probe_unsupported')
  if (!target.installationId || ![target.executable, target.configRoot, target.homeDir, options.dataDir].every(value => path.isAbsolute(value))
    || typeof options.attest !== 'function') return result('unavailable', 'unknown', 'source_attestation_required')
  if (options.signal?.aborted) return result('cancelled', 'unknown', 'cancelled')
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5000, 10000))
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  let runtime: ReturnType<typeof createCliRuntimeDirectory> | undefined
  try {
    // Race admission as well as process I/O; a slow attestor must never cause a
    // late spawn after the user's cancellation or our deadline.
    const admitted = await new Promise<boolean>((resolve, reject) => {
      const aborted = () => reject(new CliLLMError('aborted', 'Authentication check cancelled'))
      controller.signal.addEventListener('abort', aborted, { once: true })
      Promise.resolve().then(() => options.attest(target, controller.signal)).then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', aborted))
      if (controller.signal.aborted) aborted()
    })
    if (!admitted) return result('unavailable', 'unknown', 'source_attestation_failed')
    if (controller.signal.aborted) throw new CliLLMError('aborted', 'Authentication check cancelled')
    if (!claude) {
      // The native app-server can discover account routing at startup. Check
      // explicit profile overrides before a credential-bearing process exists.
      const routing = await checkCodexDeclaredRouting(target.configRoot, options.codexSystemConfigPaths)
      if (controller.signal.aborted) throw new CliLLMError('aborted', 'Authentication check cancelled')
      if (routing !== 'clear') return result('unavailable', 'unknown',
        routing === 'override' ? 'billing_settings_override' : 'billing_settings_unconfirmed')
    }
    runtime = createCliRuntimeDirectory(options.dataDir, `auth_${randomUUID()}`)
    const env = environment(target, options.sourceEnv ?? process.env, claude)
    let observation: AgentAuthenticationResult
    if (claude) {
      const output = await new CliChildProcessRunner(new CliProcessRegistry()).run({ executable: target.executable,
        args: ['auth', 'status', '--json'], cwd: runtime.invocationDir, env, stdin: '', timeoutMs,
        signal: controller.signal, purpose: 'connection_test', stdoutLimitBytes: 32 * 1024, stderrLimitBytes: 32 * 1024 })
      let parsed: unknown
      try { parsed = JSON.parse(output.stdout) } catch { return result('unavailable', 'unknown', output.exitCode === 0 ? 'auth_protocol_unknown' : 'auth_process_failed') }
      observation = classifyClaudeAuthentication(parsed)
      if (output.exitCode !== 0 && observation.status !== 'explicitly_unauthenticated') return result('unavailable', 'unknown', 'auth_process_failed')
    } else {
      const metadata = await readAgentCodexAuthentication({ executable: target.executable, cwd: runtime.invocationDir, env, signal: controller.signal })
      if (controller.signal.aborted) throw new CliLLMError('aborted', 'Authentication check cancelled')
      if (metadata.routingBlocked) return result('unavailable', 'unknown', 'billing_settings_override')
      observation = classifyCodexAuthentication(metadata.account, metadata.configuration)
    }
    if (controller.signal.aborted) throw new CliLLMError('aborted', 'Authentication check cancelled')
    // Auth status cannot prove how these environment overrides affect billing.
    // Preserve the genuine routing for the probe, but never upgrade it to an
    // unattended subscription grant based on a second unrelated login record.
    const billingOverrides = claude ? CLAUDE_ENV.filter(key => !['AWS_PROFILE', 'AWS_REGION', 'GOOGLE_CLOUD_PROJECT'].includes(key)) : CODEX_ENV
    if (observation.billing === 'confirmed_subscription' && billingOverrides.some(key => Boolean(env[key]))) {
      return result(observation.status, 'unknown', 'billing_environment_override')
    }
    if (claude && observation.billing === 'confirmed_subscription') {
      const routing = await claudeSettingsRouting(target.configRoot)
      if (controller.signal.aborted) throw new CliLLMError('aborted', 'Authentication check cancelled')
      if (routing !== 'clear') return result(observation.status, 'unknown',
        routing === 'override' ? 'billing_settings_override' : 'billing_settings_unconfirmed')
    }
    return observation
  } catch (error) {
    if (controller.signal.aborted) return result(options.signal?.aborted ? 'cancelled' : 'unavailable', 'unknown', timedOut ? 'auth_timeout' : 'cancelled')
    if (error instanceof CliLLMError) return result(error.kind === 'unsupported_version' ? 'unsupported' : 'unavailable', 'unknown', `auth_${error.kind}`)
    return result('unavailable', 'unknown', 'auth_probe_failed')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    try { runtime?.cleanup() } catch { /* No credentials are copied into this private scratch directory. */ }
  }
}
