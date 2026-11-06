import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareClaudeDiagnostic, classifyClaudeNativeBilling } from '../../client/electron/agent-integration/claude-diagnostic-adapter'
import type { NativeDiagnosticInput } from '../../client/electron/agent-integration/native-diagnostic-adapter'
import type { DiagnosticProcessSession, DiagnosticProcessStart } from '../../client/electron/agent-integration/diagnostic-process'
import type { DiagnosticProcessResult } from '../../src/agent-diagnostic-runner'
import { DiagnosticProcessError } from '../../src/agent-diagnostic-runner'

const roots: string[] = []
const sessions: DiagnosticProcessSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.stop()))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function save(file: string, value: unknown) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-diagnostic-adapter-'))); roots.push(root)
  const home = path.join(root, 'home'), configRoot = path.join(home, '.claude'), plugin = path.join(configRoot, 'plugins', 'cache', 'synthetic', 'tidemind-fixture')
  const dataDir = path.join(root, 'diagnostic'); fs.mkdirSync(dataDir)
  const settingsFile = path.join(configRoot, 'settings.json')
  save(settingsFile, { enabledPlugins: { 'tidemind-fixture@synthetic': true }, model: 'preserved-model',
    permissions: { defaultMode: 'manual', allow: [], deny: ['Bash'] } })
  save(path.join(configRoot, 'plugins', 'installed_plugins.json'), { version: 2, plugins: {
    'tidemind-fixture@synthetic': [{ scope: 'user', installPath: plugin, version: '1.0.0' }],
  } })
  const manifest = { name: 'tidemind-fixture', version: '1.0.0' }
  const mcp = { mcpServers: { tidemind: { command: process.execPath, args: ['/synthetic/mcp-server.cjs'],
    env: { EB_AGENT_ID: 'eb_fixture', EB_ACTIVITY_GENERATION_TOKEN: 'fixture-memory-generation' } } } }
  save(path.join(plugin, '.claude-plugin', 'plugin.json'), manifest)
  save(path.join(plugin, '.mcp.json'), mcp)
  save(path.join(home, '.claude.json'), { mcpServers: { foreign: { command: '/synthetic/foreign' } } })
  const input: NativeDiagnosticInput = {
    binding: { connectionKey: 'installation:fixture', configurationVersion: 'configuration-fixture', runtimeVersion: '0.2.94',
      installationSourceHash: 'source', domainKey: 'domain', intentRevision: 0, installationId: 'fixture',
      installationAgentId: 'eb_fixture', canonicalAgentId: 'eb_fixture', installKey: 'install', bindingId: null,
      bindingGeneration: null, hostVariant: 'claude-code-native', hostVersion: '2.1.296', executablePath: process.execPath,
      configRoot, distributionId: 'synthetic-native', sourceIdentityHash: 'source',
      components: { memory_tools: { artifactId: 'memory', ownedFragmentHash: 'owned', activityGenerationToken: 'fixture-memory-generation' } } },
    run: { runId: 'diag_' + 'a'.repeat(32), nonce: 'b'.repeat(48), dataDir, databasePath: path.join(dataDir, 'brain.sqlite'),
      expiresAt: new Date(Date.now() + 90000).toISOString(),
      environment: { TIDEMIND_DIAGNOSTIC_REQUIRED: '1', TIDEMIND_DIAGNOSTIC_CONTEXT: 'SYNTHETIC_CAPABILITY_NOT_FOR_OUTPUT' } },
    homeDir: home, sourceEnv: { PATH: '/usr/bin:/bin', ANTHROPIC_MODEL: 'preserved-model' },
    launch: { executable: process.execPath, args: ['/synthetic/supervisor'] }, signal: new AbortController().signal,
    attest: vi.fn(async () => true), onProcess: vi.fn(),
    claudeCarrier: { qualifiedPlugin: 'tidemind-fixture@synthetic', manifest, mcp },
  }
  return { input, root, plugin, settingsFile }
}
function fakeRuntime(input: NativeDiagnosticInput, options: {
  marker?: string; extraServer?: boolean; tools?: string[]; permission?: boolean; account?: unknown; earlyActivity?: boolean; nativeMode?: string
} = {}) {
  let spec!: DiagnosticProcessStart
  let resolveExit!: (value: DiagnosticProcessResult) => void
  let stopped = false, armed = false, observed = 0
  const writes: any[] = []
  const result = new Promise<DiagnosticProcessResult>(resolve => { resolveExit = resolve })
  const emit = (message: unknown) => queueMicrotask(() => { void spec.onStdout(JSON.stringify(message) + '\n') })
  const exit = (): DiagnosticProcessResult => ({ reason: 'cancelled', exitCode: 0, signal: null,
    processGroupExited: true, supervisorExited: true, rawStdoutBytes: 1000, rawStderrBytes: 0,
    observedOutputBytes: observed, modelWindowArmed: armed })
  const processSession: DiagnosticProcessSession = {
    pid: 123, supervisorPid: 122,
    identity: { protocolVersion: 1, pid: 123, processGroupId: 123, supervisorPid: 122, startedAt: new Date().toISOString(),
      osStartIdentity: 'synthetic-start', executableRealpath: input.binding.executablePath, argumentsHash: 'a'.repeat(64), cwd: input.run.dataDir },
    result,
    write: vi.fn(async text => {
      const message = JSON.parse(text); writes.push(message)
      expect(input.onProcess).toHaveBeenCalledTimes(1)
      if (message.type === 'control_request') {
        const response = message.request.subtype === 'initialize'
          ? { claude_code_version: '2.1.296', current_permission_mode: options.nativeMode ?? 'default',
              account: options.account ?? { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' } }
          : { mcpServers: [{ name: 'plugin:tidemind-fixture:tidemind', source: 'plugin', status: 'connected',
              serverInfo: { name: options.marker ?? 'tidemind-diagnostic-v1:' + input.run.runId + ':' + input.run.nonce, version: '0.2.94' },
              config: { command: process.execPath, args: ['/synthetic/mcp-server.cjs'] },
              tools: (options.tools ?? ['brain_prepare', 'brain_recall', 'brain_digest']).map(name => ({ name })) },
              ...(options.extraServer ? [{ name: 'foreign', source: 'user', status: 'connected' }] : [])] }
        emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
        if (options.earlyActivity) emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'unexpected' }] } })
      } else if (message.type === 'user') {
        if (options.permission) emit({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true,
          content: 'No such tool available: mcp__plugin_tidemind-fixture_tidemind__brain_digest' }] } })
        emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Synthetic completion' }] } })
        emit({ type: 'result', subtype: 'success', is_error: false, result: 'Synthetic completion' })
      }
    }),
    endInput: vi.fn(async () => {}),
    armModelWindow: vi.fn(async () => { armed = true }),
    observeOutput: vi.fn(async text => { if (!armed) throw new Error('not armed'); observed += Buffer.byteLength(text) }),
    stop: vi.fn(async () => { if (!stopped) { stopped = true; resolveExit(exit()) } return result }),
  }
  sessions.push(processSession)
  const startProcess = vi.fn(async (given: DiagnosticProcessStart) => { spec = given; return processSession })
  return { startProcess, processSession, writes, get spec() { return spec },
    dependencies: { startProcess, managedPolicyPresent: () => false } }
}

describe('Claude 2.1.296 diagnostic adapter', () => {
  it.each([
    { command: '/usr/bin/false' },
    { args: ['/synthetic/replaced.cjs'] },
    { env: { EB_AGENT_ID: 'eb_fixture', EB_ACTIVITY_GENERATION_TOKEN: 'fixture-memory-generation', NODE_OPTIONS: '--require /synthetic/replaced.cjs' } },
  ])('rejects a cache MCP entry that differs from the frozen carrier before spawning', async change => {
    const f = fixture(), runtime = fakeRuntime(f.input)
    const file = path.join(f.plugin, '.mcp.json'), mcp = JSON.parse(fs.readFileSync(file, 'utf8'))
    Object.assign(mcp.mcpServers.tidemind, change)
    save(file, mcp)
    await expect(prepareClaudeDiagnostic(f.input, runtime.dependencies)).rejects.toThrow('claude_mcp_generation_changed')
    expect(runtime.startProcess).not.toHaveBeenCalled()
  })

  it('rejects changed cache manifest metadata before spawning', async () => {
    const f = fixture(), runtime = fakeRuntime(f.input)
    save(path.join(f.plugin, '.claude-plugin', 'plugin.json'), {
      ...f.input.claudeCarrier!.manifest, mcpServers: { foreign: { command: '/usr/bin/false' } },
    })
    await expect(prepareClaudeDiagnostic(f.input, runtime.dependencies)).rejects.toThrow('claude_mcp_generation_changed')
    expect(runtime.startProcess).not.toHaveBeenCalled()
  })

  it('preflights original registry MCP and marker without submitting; preserves default root, model and permissions', async () => {
    const f = fixture(), runtime = fakeRuntime(f.input)
    const original = fs.readFileSync(f.settingsFile, 'utf8')
    const session = await prepareClaudeDiagnostic(f.input, runtime.dependencies)
    expect(runtime.writes.every(message => message.type === 'control_request')).toBe(true)
    expect(runtime.writes.map(message => message.request.subtype)).toEqual(['initialize', 'mcp_status', 'mcp_status'])
    expect(session.billing).toBe('metered')
    expect(runtime.spec.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(runtime.spec.env.HOME).toBe(f.input.homeDir)
    expect(runtime.spec.env.ANTHROPIC_MODEL).toBe('preserved-model')
    expect(runtime.spec.env.TIDEMIND_DIAGNOSTIC_CONTEXT).toBe(f.input.run.environment.TIDEMIND_DIAGNOSTIC_CONTEXT)
    expect(runtime.spec.args).not.toEqual(expect.arrayContaining(['--plugin-dir', '--strict-mcp-config', '--allowedTools', '--dangerously-skip-permissions', '--model']))
    const override = JSON.parse(fs.readFileSync(runtime.spec.args.at(-1)!, 'utf8'))
    expect(override).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false })
    expect(override.permissions).toBeUndefined()
    expect(fs.readFileSync(f.settingsFile, 'utf8')).toBe(original)
    expect(f.input.onProcess).toHaveBeenCalledWith(session.process)
    await expect(session.submit('synthetic prompt')).rejects.toThrow('model_window_not_armed')
    await session.process.armModelWindow(Date.now() + 1000)
    await session.assertUnchanged()
    const preSubmitWriteCount = runtime.writes.length
    await session.submit('synthetic prompt')
    expect(runtime.writes.slice(preSubmitWriteCount).map(message => message.type)).toEqual(['user'])
    expect(await session.completion).toMatchObject({ status: 'completed' })
    expect(runtime.writes.filter(message => message.type === 'user')).toHaveLength(1)
    await expect(session.submit('second prompt')).rejects.toThrow('diagnostic_already_submitted')
  })
  it.each([{ marker: 'tidemind' }, { marker: 'tidemind-diagnostic-v1:other:wrong' }, { extraServer: true }, { tools: ['brain_prepare'] }])(
    'stops failed preflight after onProcess and never sends a user turn: %j', async option => {
      const f = fixture(), runtime = fakeRuntime(f.input, option)
      await expect(prepareClaudeDiagnostic(f.input, runtime.dependencies)).rejects.toThrow()
      expect(f.input.onProcess).toHaveBeenCalledTimes(1)
      expect(runtime.processSession.stop).toHaveBeenCalled()
      expect(runtime.writes.some(message => message.type === 'user')).toBe(false)
    })
  it('rejects unsupported versions and failed attestation before spawning', async () => {
    const f = fixture(), runtime = fakeRuntime(f.input)
    f.input.binding.hostVersion = '2.1.297'
    await expect(prepareClaudeDiagnostic(f.input, runtime.dependencies)).rejects.toThrow('claude_version_unsupported')
    f.input.binding.hostVersion = '2.1.296'; f.input.attest = async () => false
    await expect(prepareClaudeDiagnostic(f.input, runtime.dependencies)).rejects.toThrow('source_attestation_failed')
    expect(runtime.startProcess).not.toHaveBeenCalled()
  })
  it('preserves unconfirmed process exit on a failed supervisor startup', async () => {
    const f = fixture(), error = new DiagnosticProcessError('supervisor_failed', false)
    await expect(prepareClaudeDiagnostic(f.input, {
      managedPolicyPresent: () => false, startProcess: async () => { throw error },
    })).rejects.toBe(error)
    expect(error.processExitConfirmed).toBe(false)
    expect(f.input.onProcess).not.toHaveBeenCalled()
  })
  it('stops if immediate identity persistence fails, without leaking the callback error', async () => {
    const f = fixture(), runtime = fakeRuntime(f.input)
    f.input.onProcess = vi.fn(() => { throw new Error('PRIVATE_CALLBACK_SENTINEL') })
    await expect(prepareClaudeDiagnostic(f.input, runtime.dependencies)).rejects.toThrow('claude_preflight_failed')
    expect(runtime.processSession.stop).toHaveBeenCalled()
    expect(runtime.writes).toEqual([])
  })
  it('rejects unexpected model activity during preparation', async () => {
    const f = fixture(), runtime = fakeRuntime(f.input, { earlyActivity: true })
    await expect(prepareClaudeDiagnostic(f.input, runtime.dependencies)).rejects.toThrow()
    expect(runtime.processSession.stop).toHaveBeenCalled()
    expect(runtime.writes.some(message => message.type === 'user')).toBe(false)
  })
  it('does not disable permission hooks matching diagnostic tools', async () => {
    const f = fixture(), runtime = fakeRuntime(f.input), settings = JSON.parse(fs.readFileSync(f.settingsFile, 'utf8'))
    settings.hooks = { PreToolUse: [{ matcher: 'mcp__.*', hooks: [{ type: 'command', command: '/synthetic/policy' }] }] }
    save(f.settingsFile, settings)
    await expect(prepareClaudeDiagnostic(f.input, runtime.dependencies)).rejects.toThrow('claude_permission_hooks_present')
    expect(runtime.startProcess).not.toHaveBeenCalled()
  })
  it('rechecks configuration and never submits after a permission change', async () => {
    const f = fixture(), runtime = fakeRuntime(f.input)
    const session = await prepareClaudeDiagnostic(f.input, runtime.dependencies)
    const settings = JSON.parse(fs.readFileSync(f.settingsFile, 'utf8')); settings.permissions.deny.push('mcp__*'); save(f.settingsFile, settings)
    await session.process.armModelWindow(Date.now() + 1000)
    await expect(session.assertUnchanged()).rejects.toThrow('claude_configuration_changed')
    expect(runtime.writes.some(message => message.type === 'user')).toBe(false)
  })
  it.each(['plan', 'dontAsk'])('rejects native normalization that would change the frozen %s permission mode', async mode => {
    const f = fixture(), settings = JSON.parse(fs.readFileSync(f.settingsFile, 'utf8'))
    settings.permissions.defaultMode = mode; save(f.settingsFile, settings)
    const runtime = fakeRuntime(f.input, { nativeMode: 'default' })
    await expect(prepareClaudeDiagnostic(f.input, runtime.dependencies)).rejects.toThrow('claude_permission_mode_changed')
    expect(runtime.processSession.stop).toHaveBeenCalled()
    expect(runtime.writes.some(message => message.type === 'user')).toBe(false)
  })
  it('keeps an unchanged plan mode rather than replacing it with ordinary permissions', async () => {
    const f = fixture(), settings = JSON.parse(fs.readFileSync(f.settingsFile, 'utf8'))
    settings.permissions.defaultMode = 'plan'; save(f.settingsFile, settings)
    const runtime = fakeRuntime(f.input, { nativeMode: 'plan' })
    await prepareClaudeDiagnostic(f.input, runtime.dependencies)
    expect(runtime.spec.args).not.toContain('--permission-mode')
  })
  it('keeps concurrent submit calls single-use', async () => {
    const f = fixture(), runtime = fakeRuntime(f.input)
    const session = await prepareClaudeDiagnostic(f.input, runtime.dependencies)
    await session.process.armModelWindow(Date.now() + 1000)
    const settled = await Promise.allSettled([session.submit('first'), session.submit('second')])
    expect(settled.map(value => value.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(runtime.writes.filter(message => message.type === 'user')).toHaveLength(1)
  })
  it('surfaces native deny even when the model later returns success text', async () => {
    const f = fixture(), runtime = fakeRuntime(f.input, { permission: true })
    const session = await prepareClaudeDiagnostic(f.input, runtime.dependencies)
    await session.process.armModelWindow(Date.now() + 1000); await session.submit('synthetic')
    expect(await session.completion).toEqual({ status: 'permission_required', reason: 'native_permission_required' })
  })
  it('uses actual SDK subscription display names with the ordinary omitted tokenSource', () => {
    expect(classifyClaudeNativeBilling({ tokenSource: 'claude.ai', apiProvider: 'firstParty' }, false)).toBe('unknown')
    for (const subscriptionType of ['Claude Pro', 'Claude Max', 'Claude Team', 'Claude Enterprise']) {
      expect(classifyClaudeNativeBilling({ subscriptionType, apiProvider: 'firstParty' }, false)).toBe('confirmed_subscription')
    }
    expect(classifyClaudeNativeBilling({ subscriptionType: 'Claude Max', apiProvider: 'firstParty' }, true)).toBe('unknown')
    expect(classifyClaudeNativeBilling({ subscriptionType: 'Claude API', apiProvider: 'firstParty' }, false)).toBe('unknown')
    expect(classifyClaudeNativeBilling({ subscriptionType: 'Custom plan display', apiProvider: 'firstParty' }, false)).toBe('unknown')
    expect(classifyClaudeNativeBilling({ subscriptionType: 'max', apiProvider: 'firstParty' }, false)).toBe('unknown')
    expect(classifyClaudeNativeBilling({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', subscriptionType: 'Claude Max', apiProvider: 'firstParty' }, false)).toBe('unknown')
    expect(classifyClaudeNativeBilling({ apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }, false)).toBe('metered')
    expect(classifyClaudeNativeBilling({ apiKeySource: 'ANTHROPIC_API_KEY', subscriptionType: 'Claude Max', apiProvider: 'firstParty' }, false)).toBe('metered')
    expect(classifyClaudeNativeBilling({ subscriptionType: 'Claude Max', apiProvider: 'gateway' }, false)).toBe('unknown')
  })
})
