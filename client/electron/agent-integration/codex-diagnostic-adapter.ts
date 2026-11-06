import fs from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { CliChildProcessRunner, CliProcessRegistry } from '@server/llm/cli/child-process-runner.js'
import { sanitizeCodexToolCatalog } from '@server/llm/cli/codex-tool-catalog.js'
import { DiagnosticProcessError } from '@server/agent-diagnostic-runner.js'
import { scanTomlTableHeaders } from '../ipc/toml-utils'
import { sha256Bytes, sha256Json } from './fingerprint'
import { classifyCodexAuthentication } from './agent-authentication'
import { checkCodexDeclaredRouting, hasCodexRouteOverride } from '@server/llm/cli/codex-declared-routing.js'
import { startDiagnosticProcess, type DiagnosticProcessSession } from './diagnostic-process'
import { NativeDiagnosticError, type NativeDiagnosticInput, type NativeDiagnosticSession } from './native-diagnostic-adapter'

const VERSION = '0.157.1'
const TOOLS = ['brain_digest', 'brain_prepare', 'brain_recall'] as const
const FORCED = new Set(['unified_exec','unified_exec_zsh_fork','terminal_resize_reflow','sqlite',
  'tool_search_always_defer_mcp_tools','resize_all_images','item_ids','steer','collaboration_modes','tui_app_server'])
const object = (value: unknown): Record<string, any> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
const fail = (code: string): never => { throw new NativeDiagnosticError(code) }
function readConfig(file: string): { text: string; value: Record<string, any>; hash: string } {
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > 1024 * 1024) return fail('codex_configuration_unsupported')
  const text = fs.readFileSync(file, 'utf8')
  let value: Record<string, any> | null
  try { value = object(parseToml(text)) } catch { return fail('codex_configuration_unsupported') }
  if (!value) return fail('codex_configuration_unsupported')
  return { text, value, hash: sha256Bytes(text) }
}
function toml(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
  const record = object(value)
  if (record) return `{${Object.entries(record).filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`
  return fail('codex_configuration_unsupported')
}
function ownedEntry(input: NativeDiagnosticInput, config: ReturnType<typeof readConfig>) {
  const servers = object(config.value.mcp_servers) ?? {}
  const entries = Object.entries(servers).filter(([, raw]) => {
    const env = object(object(raw)?.env)
    return env?.EB_AGENT_ID === input.binding.canonicalAgentId
      && env.EB_ACTIVITY_GENERATION_TOKEN === input.binding.components.memory_tools.activityGenerationToken
  })
  if (entries.length !== 1) return fail('codex_original_mcp_missing')
  const [name, raw] = entries[0], entry = object(raw)!
  if (entry.enabled === false || typeof entry.command !== 'string' || !Array.isArray(entry.args)
    || !entry.args.every((arg: unknown) => typeof arg === 'string') || entry.url
    || (entry.env_vars !== undefined && (!Array.isArray(entry.env_vars) || !entry.env_vars.every((key: unknown) => typeof key === 'string')))) return fail('codex_original_mcp_unsupported')
  if (TOOLS.some(tool => (Array.isArray(entry.enabled_tools) && !entry.enabled_tools.includes(tool))
    || (Array.isArray(entry.disabled_tools) && entry.disabled_tools.includes(tool)))) return fail('codex_diagnostic_tools_not_allowed')
  const headers = scanTomlTableHeaders(config.text), key = `mcp_servers.${name}`
  const matching = headers.filter(header => !header.array && header.key === key)
  if (matching.length !== 1) return fail('codex_original_mcp_unsupported')
  const start = matching[0], index = headers.indexOf(start)
  const end = headers.slice(index + 1).find(header => !header.key.startsWith(`${key}.`))?.line
  const block = `${config.text.split('\n').slice(start.line, end).join('\n').trimEnd()}\n`
  if (sha256Bytes(block) !== input.binding.components.memory_tools.ownedFragmentHash) return fail('codex_mcp_generation_changed')
  return { name, entry }
}
function featureOverrides(text: string): Record<string, boolean> {
  const flags: Record<string, boolean> = {}
  for (const line of text.trim().split('\n')) {
    const match = /^([a-z][a-z0-9_.]*)\s+(.+?)\s+(true|false)\s*$/.exec(line)
    if (!match) return fail('codex_feature_contract_unsupported')
    if (match[2] !== 'removed') flags[match[1]] = false
  }
  for (const required of ['shell_tool','plugins','hooks','skip_host_skill_discovery','mcp_2026_07_28']) {
    if (!(required in flags)) return fail('codex_feature_contract_unsupported')
  }
  flags.skip_host_skill_discovery = true
  flags.mcp_2026_07_28 = true
  return flags
}
/** Only deny context files; native account, configuration, model and permission roots stay in place. */
export function codexDiagnosticSandbox(configRoot: string): string {
  const denied = new Set<string>()
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    const file = path.join(configRoot, name)
    denied.add(file)
    try { denied.add(fs.realpathSync(file)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('codex_context_isolation_unavailable')
    }
  }
  return `(version 1)\n(allow default)\n(deny file-read-data ${[...denied].map(file => `(literal ${JSON.stringify(file)})`).join(' ')})\n`
}
function environment(input: NativeDiagnosticInput, forwarded: readonly string[]): NodeJS.ProcessEnv {
  const source = input.sourceEnv
  const env: NodeJS.ProcessEnv = { HOME: input.homeDir, CODEX_HOME: input.binding.configRoot,
    PATH: [path.dirname(input.binding.executablePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter) }
  const keys = new Set(['USER','LOGNAME','LANG','TMPDIR','SHELL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY',
    'SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','OPENAI_API_KEY','OPENAI_BASE_URL','CODEX_API_KEY', ...forwarded])
  for (const key of Object.keys(source)) if (keys.has(key) || key.startsWith('LC_')) env[key] = source[key]
  // A host-configured forward list must not give the offline metadata
  // subprocesses the diagnostic credential inherited from another process.
  delete env.TIDEMIND_DIAGNOSTIC_REQUIRED
  delete env.TIDEMIND_DIAGNOSTIC_CONTEXT
  return env
}

/** Version-qualified A-side native adapter. Preparation sends metadata, never a model turn. */
export async function prepareCodexDiagnostic(input: NativeDiagnosticInput,
  dependencies: { systemConfigPaths?: readonly string[] } = {}): Promise<NativeDiagnosticSession> {
  if (process.platform !== 'darwin' || input.binding.hostVariant !== 'codex-cli' || input.binding.hostVersion !== VERSION) return fail('codex_diagnostic_version_unsupported')
  if (![input.homeDir,input.binding.configRoot,input.binding.executablePath,input.run.dataDir].every(file => path.isAbsolute(file))) return fail('codex_configuration_unsupported')
  const signal = input.signal
  const attest = async () => {
    if (signal.aborted) return fail('cancelled')
    if (!await input.attest(input.binding, signal)) return fail('source_attestation_failed')
    if (signal.aborted) return fail('cancelled')
  }
  const checkRouting = async () => {
    const routing = await checkCodexDeclaredRouting(input.binding.configRoot, dependencies.systemConfigPaths)
    if (signal.aborted) return fail('cancelled')
    if (routing !== 'clear') return fail(routing === 'override' ? 'billing_settings_override' : 'billing_settings_unconfirmed')
  }
  let processSession: DiagnosticProcessSession | undefined
  let rejectPending: (error: Error) => void = () => {}
  try {
    await attest()
    await checkRouting()
    const file = path.join(input.binding.configRoot, 'config.toml'), config = readConfig(file)
    if (hasCodexRouteOverride(config.value)) return fail('billing_settings_override')
    // Named/custom permission profiles and custom instruction files need separate qualification.
    if (config.value.profile || config.value.default_permissions || config.value.permissions
      || config.value.model_instructions_file || (config.value.approvals_reviewer && config.value.approvals_reviewer !== 'user')) return fail('codex_permission_profile_unsupported')
    const original = ownedEntry(input, config)
    const scratch = path.join(input.run.dataDir, 'native-codex')
    fs.mkdirSync(scratch, { recursive: false, mode: 0o700 })
    const cwd = path.join(scratch, 'cwd'); fs.mkdirSync(cwd, { mode: 0o700 })
    const policy = path.join(scratch, 'context-isolation.sb')
    fs.writeFileSync(policy, codexDiagnosticSandbox(input.binding.configRoot), { flag: 'wx', mode: 0o600 })
    const env = environment(input, original.entry.env_vars ?? [])
    const metadataRegistry = new CliProcessRegistry()
    const runner = new CliChildProcessRunner(metadataRegistry)
    const metadata = async (args: readonly string[], limit = 4 * 1024 * 1024): Promise<string> => {
      await attest()
      let output
      try {
        output = await runner.run({ executable: '/usr/bin/sandbox-exec', args: ['-f', policy, input.binding.executablePath, ...args],
          cwd, env, stdin: '', signal, timeoutMs: 10_000, purpose: 'connection_test', stdoutLimitBytes: limit, stderrLimitBytes: 64 * 1024 })
      } catch {
        let exited = true
        try { await metadataRegistry.shutdown() } catch { exited = false }
        throw new DiagnosticProcessError('codex_metadata_unavailable', exited)
      }
      if (output.exitCode !== 0) return fail('codex_metadata_unavailable')
      return output.stdout
    }
    if ((await metadata(['--version'], 1024)).trim() !== `codex-cli ${VERSION}`) return fail('codex_diagnostic_version_unsupported')
    const features = featureOverrides(await metadata(['features', 'list'], 64 * 1024))
    const catalog = sanitizeCodexToolCatalog(await metadata(['debug', 'models', '--bundled']))
    const catalogPath = path.join(scratch, 'model-catalog.json'); fs.writeFileSync(catalogPath, catalog, { flag: 'wx', mode: 0o600 })
    const configuredModel = config.value.model
    // 0.157.1 caches model tool metadata before thread/start. The sanitized
    // catalog must be installed at process launch, so an implicit account
    // default cannot be inferred from that already-modified catalog.
    if (typeof configuredModel !== 'string' || !configuredModel.trim()
      || !JSON.parse(catalog).models.some((model: { slug: string }) => model.slug === configuredModel)) return fail('codex_model_selection_unsupported')
    const forward = [...new Set([...(original.entry.env_vars ?? []), 'TIDEMIND_DIAGNOSTIC_REQUIRED', 'TIDEMIND_DIAGNOSTIC_CONTEXT'])]
    const overrides: Record<string, unknown> = { features,
      mcp_servers: { [original.name]: { ...original.entry, enabled_tools: [...TOOLS], env_vars: forward } },
      model_catalog_json: catalogPath, 'skills.include_instructions': false, project_doc_max_bytes: 0,
      'tools.experimental_request_user_input.enabled': false, notify: [], web_search: 'disabled',
      developer_instructions: '', instructions: '', check_for_update_on_startup: false }
    const args = Object.entries(overrides).flatMap(([key,value]) => ['-c', `${key}=${toml(value)}`])
    // The static catalog must be applied exactly, including original model ordering.
    if (sha256Json(JSON.parse(await metadata([...args, 'debug', 'models']))) !== sha256Json(JSON.parse(catalog))) return fail('codex_catalog_readback_failed')
    await attest()
    await checkRouting()
    if (readConfig(file).hash !== config.hash) return fail('codex_configuration_changed')
    let nextId = 0, buffer = '', submitted = false, submitClaimed = false, armed = false, settled = false, threadId: string | undefined
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
    const observedAgentCharacters = new Map<string, number>()
    let finish!: (result: Awaited<NativeDiagnosticSession['completion']>) => void
    const completion = new Promise<Awaited<NativeDiagnosticSession['completion']>>(resolve => { finish = resolve })
    const complete = (status: Awaited<NativeDiagnosticSession['completion']>['status'], reason: string) => {
      if (!settled) { settled = true; finish({ status, reason }) }
    }
    rejectPending = error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear() }
    const parseStdout = async (text: string) => {
      buffer += text
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,end); buffer = buffer.slice(end+1)
        if (!line.trim()) continue
        let message: Record<string, any>
        try { message = JSON.parse(line) } catch { throw new NativeDiagnosticError('codex_protocol_invalid') }
        if (typeof message.method === 'string') {
          if ('id' in message) {
            complete('permission_required', 'native_permission_required')
            await processSession!.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Diagnostic session requires native user permission' } })+'\n')
            void processSession!.stop()
            continue
          }
          if (submitted && message.method === 'item/agentMessage/delta' && typeof message.params?.delta === 'string') {
            if (typeof message.params.itemId !== 'string') throw new NativeDiagnosticError('codex_protocol_invalid')
            observedAgentCharacters.set(message.params.itemId, (observedAgentCharacters.get(message.params.itemId) ?? 0)+message.params.delta.length)
            await processSession!.observeOutput(message.params.delta)
          }
          if (submitted && message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
            const item = message.params.item
            if (typeof item.text === 'string') {
              const remaining = item.text.slice(observedAgentCharacters.get(item.id) ?? 0)
              if (remaining) await processSession!.observeOutput(remaining)
            }
          }
          if (submitted && message.method === 'item/completed' && message.params?.item?.type === 'mcpToolCall') {
            for (const part of message.params.item.result?.content ?? []) if (part.type === 'text' && typeof part.text === 'string') await processSession!.observeOutput(part.text)
            if (typeof message.params.item.error?.message === 'string') await processSession!.observeOutput(message.params.item.error.message)
          }
          if (submitted && message.method === 'turn/completed' && message.params?.threadId === threadId) {
            complete(message.params.turn?.status === 'completed' ? 'completed' : 'failed', message.params.turn?.status === 'completed' ? 'native_turn_completed' : 'native_turn_failed')
          }
          continue
        }
        const waiter = pending.get(message.id)
        if (!waiter) continue
        pending.delete(message.id)
        if (message.error) waiter.reject(new NativeDiagnosticError('codex_protocol_unavailable'))
        else waiter.resolve(message.result)
      }
    }
    let stdoutWork = Promise.resolve()
    const onStdout = (text: string) => {
      stdoutWork = stdoutWork.then(() => parseStdout(text))
      return stdoutWork
    }
    processSession = await startDiagnosticProcess({ executable: '/usr/bin/sandbox-exec', args: ['-f', policy, input.binding.executablePath, ...args, 'app-server', '--stdio'],
      cwd, env: { ...env, ...input.run.environment }, signal, onStdout }, input.launch)
    const originalProcess = processSession
    processSession = { ...originalProcess, armModelWindow: async deadline => {
      await originalProcess.armModelWindow(deadline)
      armed = true
    } }
    input.onProcess(processSession)
    void processSession.result.then(result => {
      rejectPending(new NativeDiagnosticError('codex_process_exited'))
      if (!settled) complete('failed', result.reason)
    })
    const request = (method: string, params: unknown): Promise<any> => {
      if (settled || signal.aborted) return Promise.reject(new NativeDiagnosticError('cancelled'))
      const id = ++nextId
      return new Promise((resolve,reject) => {
        pending.set(id,{resolve,reject})
        processSession!.write(JSON.stringify({id,method,params})+'\n').catch(error => { pending.delete(id); reject(error) })
      })
    }
    await request('initialize', { clientInfo: { name: 'tidemind-diagnostic', version: '1' }, capabilities: { experimentalApi: true } })
    await processSession.write(JSON.stringify({method:'initialized',params:{}})+'\n')
    const configuration = await request('config/read',{ includeLayers:false,cwd })
    const effective = object(configuration?.config)
    if (effective && hasCodexRouteOverride(effective)) return fail('billing_settings_override')
    const account = await request('account/read',{ refreshToken:false })
    if (!effective || effective.profile || effective.default_permissions || effective.permissions
      || (effective.approvals_reviewer && effective.approvals_reviewer !== 'user')) return fail('codex_permission_profile_unsupported')
    const selectedModel = effective.model
    if (configuredModel !== selectedModel) return fail('codex_model_selection_unsupported')
    const approval = effective.approval_policy ?? 'on-request', sandbox = effective.sandbox_mode ?? 'read-only'
    if (!['on-request','untrusted','never'].includes(approval) || !['read-only','workspace-write'].includes(sandbox)) return fail('codex_permission_profile_unsupported')
    const expectedEntry = (overrides.mcp_servers as Record<string, Record<string, unknown>>)[original.name]
    const effectiveEntry = object(object(effective.mcp_servers)?.[original.name])
    // Native readback adds default fields (for example environment_id=local).
    // Every original/diagnostic entry field still has to match exactly.
    if (!effectiveEntry || Object.entries(expectedEntry).some(([key,value]) => !Object.hasOwn(effectiveEntry,key) || sha256Json(effectiveEntry[key]) !== sha256Json(value))) return fail('codex_original_mcp_changed')
    const started = await request('thread/start',{cwd,model:selectedModel,ephemeral:true,experimentalRawEvents:false,
      allowProviderModelFallback:false,developerInstructions:''})
    threadId = started.thread?.id
    if (!threadId || started.model !== selectedModel || started.modelProvider !== effective.model_provider
      || started.approvalPolicy !== approval || started.approvalsReviewer !== 'user'
      || started.sandbox?.type !== (sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite')) return fail('codex_permission_profile_changed')
    const flags = await request('experimentalFeature/list',{threadId,limit:200})
    if (!Array.isArray(flags.data) || flags.nextCursor) return fail('codex_feature_contract_unsupported')
    const active = flags.data.filter((flag: { enabled?: boolean }) => flag.enabled)
    if (active.some((flag: { name: string }) => !FORCED.has(flag.name) && !['skip_host_skill_discovery','mcp_2026_07_28'].includes(flag.name))
      || !flags.data.some((flag: { name: string; enabled: boolean }) => flag.name === 'shell_tool' && !flag.enabled)
      || !flags.data.some((flag: { name: string; enabled: boolean }) => flag.name === 'plugins' && !flag.enabled)) return fail('codex_feature_contract_unsupported')
    let inventory = await request('mcpServerStatus/list',{threadId,limit:100})
    const inventoryDeadline = Date.now()+10_000
    while (Array.isArray(inventory.data) && inventory.data.length === 1 && inventory.data[0].name === original.name
      && ['notStarted','starting'].includes(inventory.data[0].runtimeStatus) && Date.now()<inventoryDeadline) {
      await new Promise(resolve => setTimeout(resolve,100))
      inventory = await request('mcpServerStatus/list',{threadId,limit:100})
    }
    if (!Array.isArray(inventory.data) || inventory.nextCursor) return fail('codex_mcp_inventory_unavailable')
    const connected = inventory.data.filter((server: { runtimeStatus: string }) => server.runtimeStatus !== 'disabled')
    const server = connected[0], marker = `[TIDEMIND_DIAGNOSTIC_V1:${input.run.runId}:${input.run.nonce}]`
    if (connected.length !== 1 || server.name !== original.name || server.runtimeStatus !== 'connected'
      || server.serverInfo?.name !== `tidemind-diagnostic-v1:${input.run.runId}:${input.run.nonce}`
      || server.serverInfo?.version !== input.binding.runtimeVersion || !object(server.tools)
      || sha256Json(Object.keys(server.tools).sort()) !== sha256Json(TOOLS)
      || Object.values(server.tools).some(tool => typeof (tool as {description?:unknown}).description !== 'string' || !(tool as {description:string}).description.startsWith(marker))
      || !Array.isArray(server.resources) || server.resources.length || !Array.isArray(server.resourceTemplates) || server.resourceTemplates.length) return fail('codex_diagnostic_mcp_unproven')
    const configurationHash = sha256Json(configuration.config), accountHash = sha256Json(account)
    const classifiedBilling = classifyCodexAuthentication(account,configuration).billing
    const billing = classifiedBilling === 'confirmed_subscription' && ['OPENAI_API_KEY','OPENAI_BASE_URL','CODEX_API_KEY'].some(key => Boolean(env[key]))
      ? 'unknown' : classifiedBilling
    const assertUnchanged = async () => {
      await attest()
      if (readConfig(file).hash !== config.hash) return fail('codex_configuration_changed')
      if (fs.readFileSync(policy,'utf8') !== codexDiagnosticSandbox(input.binding.configRoot)) return fail('codex_context_isolation_changed')
      const freshConfig = await request('config/read',{includeLayers:false,cwd})
      const freshAccount = await request('account/read',{refreshToken:false})
      if (sha256Json(freshConfig.config) !== configurationHash || sha256Json(freshAccount) !== accountHash) return fail('codex_account_or_profile_changed')
    }
    await assertUnchanged()
    return { process: processSession, billing, completion, assertUnchanged,
      submit: async prompt => {
        if (submitClaimed) return fail('diagnostic_already_submitted')
        if (!armed) return fail('model_window_not_armed')
        if (typeof prompt !== 'string' || Buffer.byteLength(prompt)>16*1024) return fail('diagnostic_prompt_invalid')
        if (signal.aborted) return fail('cancelled')
        submitClaimed = true
        submitted = true
        await request('turn/start',{threadId,input:[{type:'text',text:prompt,text_elements:[]}]})
      } }
  } catch (error) {
    rejectPending(new NativeDiagnosticError('codex_preflight_failed'))
    if (processSession) await processSession.stop()
    if (error instanceof NativeDiagnosticError || error instanceof DiagnosticProcessError) throw error
    throw new NativeDiagnosticError(input.signal.aborted ? 'cancelled' : 'codex_preflight_failed')
  }
}
