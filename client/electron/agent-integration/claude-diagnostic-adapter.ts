import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { DiagnosticProcessError } from '@server/agent-diagnostic-runner.js'
import { claudeConfigRootEnvironment } from './claude-config-environment'
import { startDiagnosticProcess, type DiagnosticProcessSession } from './diagnostic-process'
import { NativeDiagnosticError, type NativeDiagnosticInput, type NativeDiagnosticSession } from './native-diagnostic-adapter'

type Json = Record<string, unknown>
type Completion = Awaited<NativeDiagnosticSession['completion']>
const TOOLS = ['brain_digest', 'brain_prepare', 'brain_recall']
const object = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
const fail = (code: string): never => { throw new NativeDiagnosticError(code) }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function jsonFile(file: string, optional = false): Json {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) return fail('claude_profile_unreadable')
    return object(JSON.parse(fs.readFileSync(file, 'utf8'))) ?? fail('claude_profile_unreadable')
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return fail('claude_profile_unreadable')
  }
}
interface Profile {
  fingerprint: string; pluginId: string; serverName: string; command: string; args: string[]
  toolNames: string[]; overrides: Json; routeOverride: boolean; permissionMode: string
}
const normalizedPermissionMode = (value: unknown) => value === 'manual' || value === 'default' ? 'default' : String(value)
function permissionHookMatches(hooks: unknown, names: string[]): boolean {
  const configured = object(hooks)
  if (!configured) return hooks !== undefined
  for (const event of ['PreToolUse', 'PermissionRequest']) {
    const entries = configured[event]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) return true
    for (const entry of entries) {
      const matcher = object(entry)?.matcher
      if (typeof matcher !== 'string' || matcher === '' || matcher === '*') return true
      if (/^[A-Za-z0-9_,| -]+$/u.test(matcher)) {
        if (matcher.split(/[,| ]+/u).some(name => names.includes(name))) return true
      } else {
        try { if (names.some(name => new RegExp(matcher).test(name))) return true } catch { return true }
      }
    }
  }
  return false
}
function managedPolicyPresent(): boolean {
  return ['managed-settings.json', 'managed-mcp.json', 'CLAUDE.md', 'managed-settings.d']
    .some(file => fs.existsSync(path.join('/Library/Application Support/ClaudeCode', file)))
}
const ROUTING_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
function pluginHooks(directory: string, manifest: Json): unknown {
  if (object(manifest.hooks)) return object(manifest.hooks)!.hooks ?? manifest.hooks
  if (manifest.hooks !== undefined && typeof manifest.hooks !== 'string') return fail('claude_plugin_layout_unsupported')
  const file = typeof manifest.hooks === 'string' ? path.resolve(directory, manifest.hooks) : path.join(directory, 'hooks', 'hooks.json')
  if (path.relative(directory, file).startsWith('..')) return fail('claude_plugin_layout_unsupported')
  return jsonFile(file, true).hooks
}

/** Reads the installed registry; does not install a plugin, replace MCP, read
 * credential files, or grant a permission. No lifecycle capability is required. */
function readProfile(input: NativeDiagnosticInput): Profile {
  const { binding } = input, root = fs.realpathSync(binding.configRoot)
  const carrier = input.claudeCarrier
  if (!carrier) return fail('claude_managed_carrier_unavailable')
  const settings = jsonFile(path.join(root, 'settings.json'))
  const registry = jsonFile(path.join(root, 'plugins', 'installed_plugins.json'))
  if (registry.version !== 2 || !object(registry.plugins)) return fail('claude_registry_unsupported')
  const enabled = object(settings.enabledPlugins) ?? {}
  const candidates: Array<{ id: string; directory: string; manifest: Json; mcp: Json; entry: Json; hooks: unknown }> = []
  const policies: Array<{ id: string; hooks: unknown }> = []
  for (const [id, records] of Object.entries(registry.plugins as Json)) {
    if (enabled[id] === false || !Array.isArray(records)) continue
    for (const record of records) {
      const installed = object(record)
      if (installed?.scope !== 'user' || typeof installed.installPath !== 'string' || !path.isAbsolute(installed.installPath)) continue
      const directory = fs.realpathSync(installed.installPath)
      const manifest = jsonFile(path.join(directory, '.claude-plugin', 'plugin.json'))
      if (manifest.name !== id.slice(0, id.lastIndexOf('@'))) continue
      const hooks = pluginHooks(directory, manifest)
      policies.push({ id, hooks })
      if (!id.startsWith('tidemind-') || enabled[id] !== true) continue
      const mcp = jsonFile(path.join(directory, '.mcp.json')), servers = object(mcp.mcpServers)
      if (!servers || Object.keys(servers).length !== 1 || !object(servers.tidemind)) continue
      const entry = servers.tidemind as Json, env = object(entry.env)
      if (env?.EB_AGENT_ID !== binding.canonicalAgentId
        || env.EB_ACTIVITY_GENERATION_TOKEN !== binding.components.memory_tools.activityGenerationToken) continue
      candidates.push({ id, directory, manifest, mcp, entry, hooks })
    }
  }
  if (candidates.length !== 1) return fail('claude_managed_mcp_ambiguous')
  const selected = candidates[0], entry = selected.entry
  if (selected.id !== carrier.qualifiedPlugin || !isDeepStrictEqual(selected.manifest, carrier.manifest)
    || !isDeepStrictEqual(selected.mcp, carrier.mcp)) return fail('claude_mcp_generation_changed')
  if (typeof entry.command !== 'string' || !path.isAbsolute(entry.command) || !Array.isArray(entry.args)
    || entry.args.some(arg => typeof arg !== 'string') || (entry.type !== undefined && entry.type !== 'stdio')) return fail('claude_mcp_transport_unsupported')
  const pluginName = String(selected.manifest.name)
  const toolNames = TOOLS.map(tool => 'mcp__plugin_' + pluginName + '_tidemind__' + tool)
  if (permissionHookMatches(settings.hooks, toolNames) || policies.some(policy => permissionHookMatches(policy.hooks, toolNames))) return fail('claude_permission_hooks_present')
  const permissions = object(settings.permissions)
  if (permissions?.defaultMode && !['default', 'manual', 'dontAsk', 'plan'].includes(String(permissions.defaultMode))) return fail('claude_permission_mode_unsupported')
  if (settings.agent || (settings.outputStyle && settings.outputStyle !== 'default')) return fail('claude_custom_context_unsupported')
  const configEnv = claudeConfigRootEnvironment(input.homeDir, root, input.sourceEnv)
  const globalPath = configEnv.CLAUDE_CONFIG_DIR ? path.join(root, '.claude.json') : path.join(input.homeDir, '.claude.json')
  const global = jsonFile(globalPath, true)
  // Startup updates pluginUsage/timestamps. Bind routing, not those normal writes.
  const relevantGlobal = Object.fromEntries(['mcpServers', 'model', 'defaultModel', 'modelOverrides', 'oauthAccount', 'primaryApiKey']
    .filter(key => global[key] !== undefined).map(key => [key, global[key]]))
  const disabled = Object.fromEntries([...new Set([...Object.keys(enabled), ...Object.keys(registry.plugins as Json)])]
    .filter(id => id !== selected.id).map(id => [id, false]))
  const route = object(settings.env) ?? {}
  return {
    fingerprint: hash({ settings, registry: registry.plugins, relevantGlobal, selected, policies }),
    pluginId: selected.id, serverName: 'plugin:' + pluginName + ':tidemind',
    command: entry.command, args: entry.args as string[], toolNames,
    permissionMode: normalizedPermissionMode(permissions?.defaultMode ?? 'default'),
    routeOverride: Boolean(settings.apiKeyHelper) || ROUTING_ENV.some(key => Boolean(route[key]) || Boolean(input.sourceEnv[key])),
    overrides: { disableAllHooks: true, autoMemoryEnabled: false,
      claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md', '**/.claude/rules/**'],
      disableClaudeAiConnectors: true, enabledPlugins: disabled,
      allowedMcpServers: [{ serverCommand: [entry.command, ...entry.args] }],
      deniedMcpServers: Object.keys(object(global.mcpServers) ?? {}).map(serverName => ({ serverName })),
    },
  }
}

/** 2.1.296 initialize uses SDK display labels, unlike auth status's raw tiers.
 * Its ordinary subscription branch omits tokenSource; environment-token modes
 * set tokenSource instead. Keep unknown display names/routes unconfirmed. */
export function classifyClaudeNativeBilling(value: unknown, routeOverride: boolean): NativeDiagnosticSession['billing'] {
  const account = object(value)
  if (!account) return 'unknown'
  const provider = String(account.apiProvider ?? '').toLowerCase()
  const apiKeySource = String(account.apiKeySource ?? 'none').toLowerCase()
  if (apiKeySource !== 'none' && apiKeySource !== '') return 'metered'
  if (routeOverride || !['firstparty', 'first-party', 'anthropic'].includes(provider)) return 'unknown'
  const tokenSource = String(account.tokenSource ?? '').toLowerCase()
  if (!['', 'none', 'claude.ai'].includes(tokenSource)) return 'unknown'
  return ['claude pro', 'claude max', 'claude team', 'claude enterprise'].includes(String(account.subscriptionType ?? '').trim().toLowerCase())
    ? 'confirmed_subscription' : 'unknown'
}
function childEnvironment(input: NativeDiagnosticInput, scratch: string): NodeJS.ProcessEnv {
  const source = input.sourceEnv, env: NodeJS.ProcessEnv = {
    HOME: input.homeDir, PATH: source.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: scratch, CLAUDE_CODE_TMPDIR: scratch,
  }
  const exact = ['USER', 'LOGNAME', 'LANG', 'SHELL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'AWS_PROFILE', 'AWS_REGION', 'GOOGLE_CLOUD_PROJECT',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER']
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (exact.includes(key) || key.startsWith('ANTHROPIC_') || key.startsWith('LC_'))) env[key] = value
  }
  Object.assign(env, claudeConfigRootEnvironment(input.homeDir, input.binding.configRoot, source), input.run.environment)
  return env
}
export interface ClaudeDiagnosticDependencies {
  /** Hermetic tests only; production uses the owned supervisor and OS policy. */
  startProcess?: typeof startDiagnosticProcess
  managedPolicyPresent?: () => boolean
}

export async function prepareClaudeDiagnostic(input: NativeDiagnosticInput,
  dependencies: ClaudeDiagnosticDependencies = {}): Promise<NativeDiagnosticSession> {
  if (input.binding.hostVersion !== '2.1.296' || !['claude-code-cli', 'claude-code-native'].includes(input.binding.hostVariant)) return fail('claude_version_unsupported')
  if (input.signal.aborted) return fail('cancelled')
  if (typeof input.attest !== 'function' || typeof input.onProcess !== 'function'
    || !await input.attest(input.binding, input.signal)) return fail('source_attestation_failed')
  if (input.signal.aborted) return fail('cancelled')
  if ((dependencies.managedPolicyPresent ?? managedPolicyPresent)()
    || fs.existsSync(path.join(input.binding.configRoot, 'managed-settings.json'))) return fail('claude_managed_profile_unsupported')
  const profile = readProfile(input), sourceHash = hash(input.sourceEnv)
  const scratch = path.join(input.run.dataDir, 'claude-session')
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
  const settingsPath = path.join(scratch, 'diagnostic-settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify(profile.overrides), { mode: 0o600, flag: 'wx' })
  const expectedServerName = 'tidemind-diagnostic-v1:' + input.run.runId + ':' + input.run.nonce
  let processSession: DiagnosticProcessSession | undefined
  let submitted = false, submitting = false, armed = false, finished = false, closed = false, nextId = 0
  let buffer = '', sticky: Completion | undefined
  let resolveCompletion!: (result: Completion) => void
  const completion = new Promise<Completion>(resolve => { resolveCompletion = resolve })
  const pending = new Map<string, { resolve(value: Json): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  const settle = (value: Completion) => { if (!finished) { finished = true; resolveCompletion(value) } }
  const rejectPending = (code: string) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new NativeDiagnosticError(code)) }
    pending.clear()
  }
  const abortProtocol = (code: string) => {
    sticky ??= { status: 'failed', reason: code }
    settle(sticky); rejectPending(code); void processSession?.stop()
  }
  const observedText = async (text: string) => { if (text) await processSession!.observeOutput(text) }
  const handle = async (message: Json) => {
    if (message.type === 'control_response') {
      const response = object(message.response), id = response?.request_id
      if (typeof id !== 'string') return fail('claude_protocol_invalid')
      const waiter = pending.get(id)
      if (!waiter) return
      clearTimeout(waiter.timer); pending.delete(id)
      if (response!.subtype !== 'success' || !object(response!.response)) waiter.reject(new NativeDiagnosticError('claude_control_rejected'))
      else waiter.resolve(response!.response as Json)
      return
    }
    if (message.type === 'control_request') {
      sticky = { status: 'permission_required', reason: 'native_permission_required' }
      settle(sticky); rejectPending('native_permission_required'); void processSession?.stop(); return
    }
    if (['assistant', 'user', 'result', 'stream_event'].includes(String(message.type)) && !submitted) return fail('unexpected_pre_submit_activity')
    if (message.type === 'assistant' || message.type === 'user') {
      const payload = object(message.message)
      for (const raw of Array.isArray(payload?.content) ? payload!.content : []) {
        const block = object(raw)
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') await observedText(block.text)
        if (block.type === 'tool_use') {
          if (!profile.toolNames.includes(String(block.name))) return fail('unexpected_diagnostic_tool')
          await observedText(JSON.stringify(block.input ?? {}))
        }
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? [])
          await observedText(content)
          if (block.is_error === true) {
            const permission = /permission|not allowed|not permitted|no such tool available/iu.test(content)
            sticky = { status: permission ? 'permission_required' : 'failed', reason: permission ? 'native_permission_required' : 'native_tool_failed' }
          }
        }
      }
    }
    if (message.type === 'result') {
      const denied = Array.isArray(message.permission_denials) && message.permission_denials.length > 0
      settle(denied ? { status: 'permission_required', reason: 'native_permission_required' }
        : sticky ?? (message.is_error === false && message.subtype === 'success'
          ? { status: 'completed', reason: 'native_turn_completed' }
          : { status: 'failed', reason: 'native_turn_failed' }))
      void processSession?.endInput().catch(() => {})
    }
  }
  let parsing = Promise.resolve()
  const consume = (text: string): Promise<void> => {
    parsing = parsing.then(async () => {
      buffer += text
      if (Buffer.byteLength(buffer) > 1024 * 1024) return fail('claude_protocol_limit')
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        let message: Json | null
        try { message = object(JSON.parse(line)) } catch { return fail('claude_protocol_invalid') }
        if (!message) return fail('claude_protocol_invalid')
        await handle(message)
      }
    }).catch(error => {
      abortProtocol(error instanceof NativeDiagnosticError || error instanceof DiagnosticProcessError
        ? error.code : 'claude_protocol_failed')
    })
    return parsing
  }
  const request = (subtype: 'initialize' | 'mcp_status'): Promise<Json> => {
    if (!processSession || closed || finished) return Promise.reject(new NativeDiagnosticError('claude_session_closed'))
    const requestId = 'diagnostic-' + (++nextId)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new NativeDiagnosticError('claude_preflight_timeout')) }, 5000)
      pending.set(requestId, { resolve, reject, timer })
      void processSession!.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype } }) + '\n')
        .catch(() => { clearTimeout(timer); pending.delete(requestId); reject(new NativeDiagnosticError('claude_transport_failed')) })
    })
  }
  const checkServers = (response: Json): boolean => {
    if (!Array.isArray(response.mcpServers)) return fail('claude_mcp_status_invalid')
    const active = response.mcpServers.map(object).filter(server => server?.status !== 'disabled')
    if (active.length !== 1 || active[0]?.name !== profile.serverName || active[0]?.source !== 'plugin') return fail('claude_mcp_inventory_changed')
    const server = active[0]!
    if (server.status === 'pending') return false
    if (server.status !== 'connected') return fail('claude_mcp_unavailable')
    const info = object(server.serverInfo), config = object(server.config)
    if (info?.name !== expectedServerName || info.version !== input.binding.runtimeVersion) return fail('diagnostic_server_identity_mismatch')
    if (config?.command !== profile.command || JSON.stringify(config.args) !== JSON.stringify(profile.args)) return fail('claude_mcp_entry_changed')
    const names = Array.isArray(server.tools) ? server.tools.map(tool => object(tool)?.name).sort() : []
    if (JSON.stringify(names) !== JSON.stringify(TOOLS)) return fail('claude_mcp_tools_changed')
    return true
  }
  try {
    processSession = await (dependencies.startProcess ?? startDiagnosticProcess)({
      executable: input.binding.executablePath,
      args: ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--no-session-persistence', '--no-chrome', '--disable-slash-commands', '--tools', '',
        '--permission-prompts', 'none', '--setting-sources', 'user', '--settings', settingsPath],
      cwd: scratch, env: childEnvironment(input, scratch), signal: input.signal, onStdout: consume,
    }, input.launch)
    const original = processSession
    processSession = { ...original, armModelWindow: async deadline => { await original.armModelWindow(deadline); armed = true } }
    input.onProcess(processSession)
    void original.result.then(async result => {
      closed = true; rejectPending('claude_process_exited'); await parsing
      settle({ status: 'failed', reason: result.reason === 'cancelled' ? 'cancelled' : 'native_process_exited' })
    })
    const initialized = await request('initialize')
    if (initialized.claude_code_version !== '2.1.296') return fail('claude_version_changed')
    if (!['default', 'manual', 'dontAsk', 'plan'].includes(String(initialized.current_permission_mode))) return fail('claude_permission_mode_unsupported')
    if (normalizedPermissionMode(initialized.current_permission_mode) !== profile.permissionMode) return fail('claude_permission_mode_changed')
    const deadline = Date.now() + 15000
    while (!checkServers(await request('mcp_status'))) {
      if (Date.now() >= deadline || input.signal.aborted) return fail(input.signal.aborted ? 'cancelled' : 'claude_preflight_timeout')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    const assertUnchanged = async () => {
      if (input.signal.aborted || closed || finished) return fail('claude_session_closed')
      if (hash(input.sourceEnv) !== sourceHash || readProfile(input).fingerprint !== profile.fingerprint) return fail('claude_configuration_changed')
      if (!await input.attest(input.binding, input.signal) || input.signal.aborted) return fail('source_attestation_failed')
      if (!checkServers(await request('mcp_status'))) return fail('claude_mcp_unavailable')
    }
    await assertUnchanged()
    return {
      process: processSession, billing: classifyClaudeNativeBilling(initialized.account, profile.routeOverride), completion, assertUnchanged,
      submit: async prompt => {
        if (submitted || submitting) return fail('diagnostic_already_submitted')
        if (!armed) return fail('model_window_not_armed')
        if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > 32 * 1024) return fail('diagnostic_prompt_invalid')
        submitting = true
        // Controller awaits assertUnchanged after arming, immediately before its
        // synchronous durable markSubmitted. Do not run metadata I/O after that
        // point: this method crosses the user-prompt boundary exactly once.
        if (input.signal.aborted) return fail('cancelled')
        submitted = true // A failed write may have delivered a prefix; never retry.
        await processSession!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt },
          parent_tool_use_id: null, session_id: '' }) + '\n')
      },
    }
  } catch (error) {
    rejectPending('claude_preflight_failed')
    if (processSession) await processSession.stop()
    // A ready-before-failure/failed-supervisor error carries cleanup evidence.
    // Do not erase it: the controller must retain the run directory when exit
    // was not proved, including failures before onProcess received a handle.
    if (error instanceof NativeDiagnosticError || error instanceof DiagnosticProcessError) throw error
    const wrapped = new NativeDiagnosticError('claude_preflight_failed')
    if (error && typeof error === 'object' && 'processExitConfirmed' in error && typeof error.processExitConfirmed === 'boolean') {
      Object.assign(wrapped, { processExitConfirmed: error.processExitConfirmed })
    }
    throw wrapped
  }
}
