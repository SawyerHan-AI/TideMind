import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { nativeBrainToolContracts } from '../../client/electron/agent-integration/hosts/native-tool-contracts'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createOpenClawPluginHostAdapter,
  type OpenClawPluginAdapterDependencies,
} from '../../client/electron/agent-integration/hosts/openclaw-plugin-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { sha256Json } from '../../client/electron/agent-integration/fingerprint'
import type {
  AdapterOperationContext,
  HostActivityEvidenceQuery,
  HostActivityEvidenceRecord,
  OwnedArtifactBaseline,
} from '../../client/electron/agent-integration/types'

describe('OpenClaw native Plugin adapter', () => {
  let root: string
  let context: AdapterOperationContext
  let fake: ReturnType<typeof fakeOpenClaw>

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-plugin-adapter-'))
    const configRoot = path.join(root, '.openclaw')
    const executable = path.join(root, 'bin', 'openclaw')
    const runtimeRoot = path.join(root, 'Tide Mind.app', 'Contents', 'Resources')
    for (const asset of [
      executable,
      path.join(runtimeRoot, 'tm-node'),
      path.join(runtimeRoot, 'mcp-server.cjs'),
      path.join(runtimeRoot, 'hook-session-start.cjs'),
      path.join(runtimeRoot, 'hook-pre-compact.cjs'),
      path.join(runtimeRoot, 'hook-post-compact.cjs'),
      path.join(runtimeRoot, 'hook-openclaw-lifecycle.cjs'),
    ]) {
      fs.mkdirSync(path.dirname(asset), { recursive: true })
      fs.writeFileSync(asset, '')
    }
    fs.mkdirSync(configRoot, { recursive: true })
    context = {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: root,
        applicationDataDir: path.join(root, 'tide-mind-data'),
        shimPath: path.join(runtimeRoot, 'tm-node'),
        mcpServerPath: path.join(runtimeRoot, 'mcp-server.cjs'),
        hookScriptPath: path.join(runtimeRoot, 'hook-session-start.cjs'),
        preCompactScriptPath: path.join(runtimeRoot, 'hook-pre-compact.cjs'),
        postCompactScriptPath: path.join(runtimeRoot, 'hook-post-compact.cjs'),
        tideMindVersion: '0.2.92',
        catalogVersion: '1.3.0',
        projectionVersion: '7',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_01JOPENCLAW',
        productFamilyId: 'openclaw',
        hostVariant: 'openclaw-local',
        configRoot,
        distribution: {
          distributionId: 'openclaw:npm',
          executableRealpath: executable,
          packageProvenance: 'npm_metadata:openclaw',
          capabilityFingerprint: 'cli-surface:openclaw-2026.8.1',
        },
      }),
      installationId: 'installation_openclaw',
      hostVersion: '2026.8.1',
      agentId: 'eb_openclaw_1234',
      operationId: 'operation_openclaw',
      activityGenerationToken: 'generation-openclaw',
    }
    fake = fakeOpenClaw(context)
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  async function connectPlan(ownedArtifacts: readonly OwnedArtifactBaseline[] = []) {
    const adapter = createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
    return adapter.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      observed: await adapter.inspect(context),
      ownedArtifacts,
    })
  }

  it('freezes one aggregate plugin mutation, official commands, config root and executable', async () => {
    const plan = await connectPlan()
    expect(plan.diagnostics).toEqual([])
    expect(plan.mutations).toHaveLength(1)
    const mutation = plan.mutations[0]
    expect(mutation).toMatchObject({
      componentKey: 'instruction',
      coveredComponentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      operation: 'host_command',
      domainKind: 'plugin_manager',
      reload: 'restart_host',
      frozenCommands: [
        { args: ['plugins', 'install', expect.stringContaining('/openclaw-plugins/eb-openclaw-1234'), '--link', '--force', '--accept-capabilities'] },
        { args: ['config', 'set', 'plugins.entries.tidemind-eb-openclaw-1234.hooks.allowPromptInjection', 'true', '--strict-json'] },
        { args: ['config', 'set', 'plugins.entries.tidemind-eb-openclaw-1234.hooks.allowConversationAccess', 'true', '--strict-json'] },
        { args: ['plugins', 'enable', 'tidemind-eb-openclaw-1234', '--accept-capabilities'] },
        { args: ['gateway', 'restart', '--safe', '--json'] },
      ],
    })
    expect(mutation.additionalFenceTargets).toEqual(expect.arrayContaining([
      { domainKind: 'file_fragment', physicalTarget: path.join(context.installation.canonicalConfigRoot, 'openclaw.json') },
      { domainKind: 'directory', physicalTarget: context.installation.canonicalConfigRoot },
    ]))
  })

  it('installs a native plugin with Skill, native tools, hooks, identity and a real restart', async () => {
    const adapter = createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
    const mutation = (await connectPlan()).mutations[0]
    await adapter.apply(context, mutation)
    expect(await adapter.readBack(context, mutation)).toMatchObject({ observed: true, matchesDesired: true, visibility: 'dedicated' })

    const pluginRoot = (mutation.metadata as { pluginRoot: string }).pluginRoot
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8'))
    const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'))
    const source = fs.readFileSync(path.join(pluginRoot, 'index.js'), 'utf8')
    expect(manifest).toMatchObject({
      id: 'tidemind-eb-openclaw-1234',
      activation: { onStartup: true },
      contracts: { tools: ['brain_prepare', 'brain_recall', 'brain_digest'] },
      skills: ['./skills'],
    })
    expect(packageJson).toMatchObject({
      openclaw: { extensions: ['./index.js'], install: { minHostVersion: '>=2026.8.1' }, compat: { pluginApi: '>=2026.8.1' } },
    })
    expect(source).toContain('definePluginEntry')
    expect(source).toContain('api.registerTool')
    expect(source).toContain('api.on("session_start"')
    expect(source).toContain('api.on("session_end"')
    expect(source).toContain('EB_AGENT_ID: BINDING.agentId')
    expect(fake.calls.map(call => call.args)).toEqual(expect.arrayContaining([
      ['plugins', 'install', pluginRoot, '--link', '--force', '--accept-capabilities'],
      ['plugins', 'enable', 'tidemind-eb-openclaw-1234', '--accept-capabilities'],
      ['gateway', 'restart', '--safe', '--json'],
    ]))
    expect(fake.calls.every(call => call.env.OPENCLAW_STATE_DIR === context.installation.canonicalConfigRoot)).toBe(true)
    expect(fake.calls.every(call => call.env.OPENCLAW_CONFIG_PATH === path.join(context.installation.canonicalConfigRoot, 'openclaw.json'))).toBe(true)
  })

  it('returns native context and records evidence only after exact model-input delivery', async () => {
    const plan = await connectPlan()
    const source = (plan.mutations[0].metadata as { payloadFiles: Record<string, string> }).payloadFiles['index.js']
    const generated = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
    const signals: string[] = []
    let eligible = true
    let failPreparation = false
    const spawn = (_executable: string, args: string[], options: { stdio: string[] }) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): boolean }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => true
      expect(options.stdio[1]).toBe('pipe')
      queueMicrotask(() => {
        if (args.includes('--signal')) signals.push(args[args.indexOf('--signal') + 1])
        else if (!failPreparation) child.stdout.emit('data', Buffer.from(JSON.stringify({
          protocol: 'tidemind-openclaw-context-v1', evidenceEligible: eligible,
          content: args[0].includes('post-compact') ? 'RESTORED EXACT CONTEXT' : 'INITIAL EXACT CONTEXT',
        })))
        child.emit('close', failPreparation && !args.includes('--signal') ? 1 : 0)
      })
      return child
    }
    const module = { exports: {} as { default?: { register(api: unknown): void } } }
    new Function('require', 'module', 'exports', generated)((name: string) => {
      if (name === 'node:child_process') return { spawn }
      if (name === 'openclaw/plugin-sdk/plugin-entry') return { definePluginEntry: (entry: unknown) => entry }
      throw new Error(`Unexpected import ${name}`)
    }, module, module.exports)
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<Record<string, string> | undefined>>()
    const tools: Record<string, { description: string; parameters: unknown }> = {}
    module.exports.default!.register({
      registerTool: (tool: { name: string; description: string; parameters: unknown }) => { tools[tool.name] = tool },
      on: (name: string, callback: (event: unknown, ctx?: unknown) => Promise<Record<string, string> | undefined>) => handlers.set(name, callback),
    })
    for (const [name, contract] of Object.entries(nativeBrainToolContracts())) expect(tools[name]).toMatchObject(contract)
    const ctx = { sessionId: 'session-a' }
    await handlers.get('session_start')!({}, ctx)
    expect(signals).toEqual([])
    const input = await handlers.get('before_prompt_build')!({}, ctx)
    expect(input).toEqual({ prependSystemContext: 'INITIAL EXACT CONTEXT' })
    expect(signals).toEqual([])
    await handlers.get('llm_input')!({ systemPrompt: 'different text' }, ctx)
    expect(signals).toEqual([])
    const delivered = Object.defineProperties({ systemPrompt: input!.prependSystemContext }, {
      prompt: { get() { throw new Error('must not read user prompt') } },
      historyMessages: { get() { throw new Error('must not read conversation history') } },
    })
    await handlers.get('llm_input')!(delivered, { sessionId: 'other-session' })
    expect(signals).toEqual([])
    await handlers.get('llm_input')!(delivered, ctx)
    await handlers.get('llm_input')!(delivered, ctx)
    expect(signals).toEqual(['session_start'])
    await handlers.get('before_compaction')!({}, ctx)
    await handlers.get('after_compaction')!({}, ctx)
    expect(signals).toEqual(['session_start', 'pre_compact'])
    const restored = await handlers.get('before_prompt_build')!({}, ctx)
    expect(restored!.prependSystemContext).toContain('RESTORED EXACT CONTEXT')
    await handlers.get('llm_input')!({ systemPrompt: restored!.prependSystemContext }, ctx)
    expect(signals).toEqual(['session_start', 'pre_compact', 'post_compact'])
    await handlers.get('session_end')!({}, ctx)
    expect(signals.at(-1)).toBe('session_end')
    eligible = false
    expect(await handlers.get('before_prompt_build')!({}, { sessionId: 'bad-skill' })).toBeUndefined()
    eligible = true
    failPreparation = true
    expect(await handlers.get('before_prompt_build')!({}, { sessionId: 'failed-command' })).toBeUndefined()
    expect(signals).toHaveLength(4)
  })

  it('preserves other plugin settings and refuses explicitly denied prompt permissions', async () => {
    const adapter = createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
    const target = path.join(context.installation.canonicalConfigRoot, 'openclaw.json')
    fs.writeFileSync(target, JSON.stringify({ unrelated: 'keep', plugins: { entries: {
      'tidemind-eb-openclaw-1234': { hooks: { timeouts: { session_start: 1234 } } },
    } } }))
    const plan = await connectPlan()
    await adapter.apply(context, plan.mutations[0])
    const stored = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(stored.unrelated).toBe('keep')
    expect(stored.plugins.entries['tidemind-eb-openclaw-1234'].hooks).toEqual({
      timeouts: { session_start: 1234 }, allowPromptInjection: true, allowConversationAccess: true,
    })
    stored.plugins.entries['tidemind-eb-openclaw-1234'].hooks.allowPromptInjection = false
    fs.writeFileSync(target, JSON.stringify(stored))
    const blocked = await connectPlan()
    expect(blocked.mutations).toEqual([])
    expect(blocked.diagnostics).toContain('openclaw_prompt_hooks_explicitly_disabled')
  })

  it('fails closed on an unowned same-id plugin', async () => {
    const first = await connectPlan()
    await createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies }).apply(context, first.mutations[0])
    const repeated = await connectPlan()
    expect(repeated.mutations).toEqual([])
    expect(repeated.diagnostics).toContain('openclaw_plugin_exact_state_requires_aggregate_ownership')
  })

  it('fails closed when the plugin id points at another source', async () => {
    fake.state.installed = true
    fake.state.enabled = true
    fake.state.root = path.join(root, 'user-plugin')
    fake.state.version = '9.9.9'
    const plan = await connectPlan()
    expect(plan.mutations).toEqual([])
    expect(plan.diagnostics).toContain('openclaw_plugin_registration_conflict')
    expect(fake.calls.some(call => call.args[1] === 'install')).toBe(false)
  })

  it('rejects source drift after preview before invoking install', async () => {
    const plan = await connectPlan()
    const mutation = plan.mutations[0]
    const pluginRoot = (mutation.metadata as { pluginRoot: string }).pluginRoot
    fs.mkdirSync(pluginRoot, { recursive: true })
    fs.writeFileSync(path.join(pluginRoot, 'user.txt'), 'do not overwrite')
    await expect(createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
      .apply(context, mutation)).rejects.toThrow(/precondition|unknown|unexpected/)
    expect(fake.calls.some(call => call.args[1] === 'install')).toBe(false)
  })

  it('resumes after install and enable but before Gateway restart marker', async () => {
    const adapter = createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
    const mutation = (await connectPlan()).mutations[0]
    const metadata = mutation.metadata as { pluginRoot: string; payloadFiles: Record<string, string>; pluginId: string; pluginVersion: string }
    for (const [relative, content] of Object.entries(metadata.payloadFiles)) {
      const target = path.join(metadata.pluginRoot, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
    fake.state.installed = true
    fake.state.enabled = true
    fake.state.root = metadata.pluginRoot
    fake.state.version = metadata.pluginVersion
    fs.writeFileSync(path.join(context.installation.canonicalConfigRoot, 'openclaw.json'), JSON.stringify({
      plugins: { entries: { 'tidemind-eb-openclaw-1234': { hooks: { allowPromptInjection: true, allowConversationAccess: true } } } },
    }))
    const interrupted = await adapter.readBack(context, mutation)
    expect(interrupted.safeToResumeFrom).toMatchObject({ completedStepIds: ['plugin_source_written', 'plugin_install', 'plugin_enable'] })
    await adapter.apply(context, mutation)
    expect(fake.calls.filter(call => call.args[0] === 'gateway' && call.args[1] === 'restart')).toHaveLength(1)
    expect(fake.calls.some(call => call.args[1] === 'install')).toBe(false)
    expect(await adapter.readBack(context, mutation)).toMatchObject({ matchesDesired: true })
  })

  it('recognizes the disabled post-install prefix and resumes with enable', async () => {
    const adapter = createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
    const mutation = (await connectPlan()).mutations[0]
    const metadata = mutation.metadata as { pluginRoot: string; payloadFiles: Record<string, string>; pluginVersion: string }
    for (const [relative, content] of Object.entries(metadata.payloadFiles)) {
      const target = path.join(metadata.pluginRoot, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
    fake.state.installed = true
    fake.state.enabled = false
    fake.state.root = metadata.pluginRoot
    fake.state.version = metadata.pluginVersion
    expect(await adapter.readBack(context, mutation)).toMatchObject({
      safeToResumeFrom: { completedStepIds: ['plugin_source_written', 'plugin_install'] },
    })
    await adapter.apply(context, mutation)
    expect(fake.calls.some(call => call.args[1] === 'enable')).toBe(true)
    expect(await adapter.readBack(context, mutation)).toMatchObject({ matchesDesired: true })
  })

  it('upgrades an exact owned older plugin without adopting or replacing user state', async () => {
    const adapterV1 = createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
    const first = await connectPlan()
    await adapterV1.apply(context, first.mutations[0])
    const oldBaselines = aggregateBaselines(first.mutations[0])

    context = {
      ...context,
      runtime: { ...context.runtime, projectionVersion: '8' },
      operationId: 'operation_upgrade',
    }
    const adapterV2 = createOpenClawPluginHostAdapter({ adapterVersion: '2', dependencies: fake.dependencies })
    const plan = await adapterV2.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      observed: await adapterV2.inspect(context),
      ownedArtifacts: oldBaselines,
    })
    expect(plan.diagnostics).toEqual([])
    expect(plan.mutations).toHaveLength(1)
    await adapterV2.apply(context, plan.mutations[0])
    expect(await adapterV2.readBack(context, plan.mutations[0])).toMatchObject({ matchesDesired: true })
  })

  it('disconnects only an exact owned plugin and performs uninstall before restart', async () => {
    const adapter = createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
    const connected = await connectPlan()
    await adapter.apply(context, connected.mutations[0])
    fake.calls.length = 0
    const disconnect = await adapter.disconnect(context, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      observed: await adapter.inspect(context),
      ownedArtifacts: aggregateBaselines(connected.mutations[0]),
    })
    expect(disconnect.mutations).toHaveLength(1)
    await adapter.apply(context, disconnect.mutations[0])
    expect(fake.calls.filter(call => ['uninstall', 'restart'].includes(call.args[1] ?? '')).map(call => call.args[1])).toEqual(['uninstall', 'restart'])
    expect(await adapter.readBack(context, disconnect.mutations[0])).toMatchObject({ matchesDesired: true, visibility: 'absent' })
  })

  it('does not claim C4 from static inspect and requires fresh version-bound tool and lifecycle activity', async () => {
    const adapter = createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
    const mutation = (await connectPlan()).mutations[0]
    await adapter.apply(context, mutation)
    const inspection = await adapter.inspect(context)
    const activityBinding = {
      installationId: 'installation_openclaw', tideMindVersion: '0.2.92', adapterVersion: '1', projectionVersion: '7',
      hostVersion: '2026.8.1', activationRunId: 'run-openclaw', activityGenerationToken: 'generation-openclaw', observedAfter: '2026-09-03T00:00:00.000Z', verifiedAt: '2026-09-03T00:10:00.000Z',
    }
    const staticOnly = await adapter.verify(context, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'], expectedCapability: 4, inspection, activityBinding,
    })
    expect(staticOnly.every(item => item.status === 'unverified')).toBe(true)

    context = {
      ...context,
      hostActivityEvidence: {
        find(query: HostActivityEvidenceQuery) {
          const signals = query.componentKey === 'lifecycle'
            ? query.signalNames
            : query.signalNames
          return signals.map(signalName => activityFromQuery(query, signalName))
        },
      },
    }
    const verified = await adapter.verify(context, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'], expectedCapability: 4, inspection, activityBinding,
    })
    expect(verified.map(item => [item.componentKey, item.status, item.verifiedCapability])).toEqual([
      ['instruction', 'verified', 1], ['memory_tools', 'verified', 2], ['lifecycle', 'verified', 4],
    ])
  })

  it.each(['session_start', 'pre_compact', 'post_compact', 'session_end'] as const)(
    'does not verify OpenClaw C4 when %s evidence is missing',
    async (missingSignal) => {
      const adapter = createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
      const mutation = (await connectPlan()).mutations[0]
      await adapter.apply(context, mutation)
      const inspection = await adapter.inspect(context)
      const activityBinding = {
        installationId: 'installation_openclaw', tideMindVersion: '0.2.92', adapterVersion: '1', projectionVersion: '7',
        hostVersion: '2026.8.1', activationRunId: 'run-openclaw', activityGenerationToken: 'generation-openclaw', observedAfter: '2026-09-03T00:00:00.000Z', verifiedAt: '2026-09-03T00:10:00.000Z',
      }
      context = {
        ...context,
        hostActivityEvidence: {
          find(query) {
            return query.signalNames
              .filter(signal => query.componentKey !== 'lifecycle' || signal !== missingSignal)
              .map(signal => activityFromQuery(query, signal))
          },
        },
      }
      const results = await adapter.verify(context, {
        componentKeys: ['lifecycle'], expectedCapability: 4, inspection, activityBinding,
      })
      expect(results[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })
    },
  )

  it('atomically migrates an exact owned loose MCP selector into the native aggregate plugin', async () => {
    const configPath = path.join(context.installation.canonicalConfigRoot, 'openclaw.json')
    const legacyEntry = { command: '/runtime/tm-node', args: ['/runtime/mcp-server.cjs'], env: { EB_AGENT_ID: context.agentId } }
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'keep', mcp: { servers: { [`tidemind-${context.agentId}`]: legacyEntry } } }, null, 2))
    const legacy: OwnedArtifactBaseline = {
      componentKey: 'memory_tools',
      physicalTarget: configPath,
      ownershipKey: `mcp.servers.tidemind-${context.agentId}`,
      ownedFragmentHash: sha256Json(legacyEntry),
      selectorSchemaVersion: 1,
    }
    const plan = await connectPlan([legacy])
    expect(plan.diagnostics).toEqual([])
    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      componentKey: 'memory_tools',
      coveredComponentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      ownershipTransferFrom: {
        physicalTarget: configPath,
        ownershipKey: legacy.ownershipKey,
        ownedFragmentHash: legacy.ownedFragmentHash,
      },
      metadata: { artifactType: 'plugin', migrationSummary: '旧 MCP 升级为原生 Plugin' },
    })
    const adapter = createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
    await adapter.apply(context, plan.mutations[0])
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(config.theme).toBe('keep')
    expect(config.mcp?.servers?.[`tidemind-${context.agentId}`]).toBeUndefined()
    expect(await adapter.readBack(context, plan.mutations[0])).toMatchObject({ matchesDesired: true })
  })

  it('adopts only the exact 0.2.89/0.2.91 MCP and bootstrap hook identity', async () => {
    const configPath = path.join(context.installation.canonicalConfigRoot, 'openclaw.json')
    const key = `tidemind-${context.agentId}`
    fs.writeFileSync(configPath, JSON.stringify({ mcp: { servers: { [key]: { command: context.runtime.shimPath, args: [context.runtime.mcpServerPath], env: { EB_AGENT_ID: context.agentId } } } } }, null, 2))
    const hookRoot = path.join(context.installation.canonicalConfigRoot, 'hooks', key)
    fs.mkdirSync(hookRoot, { recursive: true })
    fs.writeFileSync(path.join(hookRoot, 'HOOK.md'), [
      '---', `name: ${key}`, 'description: "Tide Mind — 自动加载外脑上下文"', 'metadata:', '  openclaw:', '    emoji: "🧠"', '    events: ["agent:bootstrap"]', '---', '',
      '在 Agent Bootstrap 时自动调用 Tide Mind 的 prepare 接口，将用户画像、记忆索引和行为指导注入为 MEMORY.md。',
    ].join('\n'))
    const skillPath = path.join(context.runtime.applicationDataDir, 'skill', 'openclaw-skill.md')
    fs.writeFileSync(path.join(hookRoot, 'handler.ts'), [
      "import { spawnSync } from 'child_process'", '',
      `const SHIM = ${JSON.stringify(context.runtime.shimPath)}`,
      `const HOOK_SCRIPT = ${JSON.stringify(context.runtime.hookScriptPath)}`,
      `const SKILL_PATH = ${JSON.stringify(skillPath)}`,
      `const AGENT_ID = ${JSON.stringify(context.agentId)}`, '',
      'const handler = async (event: any) => {', "  if (event.type !== 'agent' || event.action !== 'bootstrap') return", '  try {',
      `    const result = spawnSync(SHIM, [HOOK_SCRIPT, '--agent-id', AGENT_ID, '--skill-path', SKILL_PATH, '--tool', 'openclaw'], {`,
      '      timeout: 15000,', "      encoding: 'utf-8',", '    })', "    const output = result.stdout ?? ''", '    if (output.trim() && event.context.bootstrapFiles) {', "      event.context.bootstrapFiles.push({ name: 'MEMORY.md', content: output })", '    }',
      '  } catch { /* prepare 失败不阻断启动 */ }', '}', '', 'export default handler', '',
    ].join('\n'))

    const host = createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
    expect((await host.inspectAdoptableArtifacts!(context)).map(item => item.componentKey)).toEqual(['memory_tools', 'instruction', 'lifecycle'])
    fs.appendFileSync(path.join(hookRoot, 'handler.ts'), '// user edit')
    expect(await host.inspectAdoptableArtifacts!(context)).toEqual([])
  })

  it('fails closed when an owned legacy selector changes after preview', async () => {
    const configPath = path.join(context.installation.canonicalConfigRoot, 'openclaw.json')
    const key = `tidemind-${context.agentId}`
    const legacyEntry = { command: '/runtime/tm-node', args: ['/runtime/mcp-server.cjs'] }
    fs.writeFileSync(configPath, JSON.stringify({ mcp: { servers: { [key]: legacyEntry } } }, null, 2))
    const legacy: OwnedArtifactBaseline = {
      componentKey: 'memory_tools', physicalTarget: configPath,
      ownershipKey: `mcp.servers.${key}`, ownedFragmentHash: sha256Json(legacyEntry), selectorSchemaVersion: 1,
    }
    const mutation = (await connectPlan([legacy])).mutations[0]
    fs.writeFileSync(configPath, JSON.stringify({ mcp: { servers: { [key]: { ...legacyEntry, userChanged: true } } } }, null, 2))
    await expect(createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies: fake.dependencies })
      .apply(context, mutation)).rejects.toThrow('openclaw_legacy_mcp_transfer_cas_conflict')
    expect(fake.calls.some(call => call.args[1] === 'install')).toBe(false)
  })
})

function aggregateBaselines(mutation: { physicalTarget: string; ownershipKey: string; desiredFragmentHash?: string }): OwnedArtifactBaseline[] {
  return (['instruction', 'memory_tools', 'lifecycle'] as const).map(componentKey => ({
    componentKey,
    physicalTarget: mutation.physicalTarget,
    ownershipKey: mutation.ownershipKey,
    ownedFragmentHash: mutation.desiredFragmentHash!,
    selectorSchemaVersion: 1,
  }))
}

function fakeOpenClaw(context: AdapterOperationContext): {
  dependencies: OpenClawPluginAdapterDependencies
  state: { installed: boolean; enabled: boolean; root: string; version: string }
  calls: Array<{ executable: string; args: string[]; env: Readonly<Record<string, string>> }>
} {
  const state = { installed: false, enabled: false, root: '', version: '' }
  const calls: Array<{ executable: string; args: string[]; env: Readonly<Record<string, string>> }> = []
  const dependencies: OpenClawPluginAdapterDependencies = {
    async run(executable, args, options) {
      calls.push({ executable, args: [...args], env: options.env })
      if (executable !== context.installation.distribution.executableRealpath) return failure('wrong executable')
      if (options.env.OPENCLAW_STATE_DIR !== context.installation.canonicalConfigRoot) return failure('wrong state root')
      if (options.env.OPENCLAW_CONFIG_PATH !== (context.installation.componentConfigFiles?.memory_tools ?? path.join(context.installation.canonicalConfigRoot, 'openclaw.json'))) return failure('wrong config path')
      if (args[0] === 'plugins' && args[1] === 'list') return success(JSON.stringify({ plugins: state.installed ? [record()] : [] }))
      if (args[0] === 'plugins' && args[1] === 'inspect') return state.installed
        ? success(JSON.stringify({ plugin: { ...record(), toolNames: ['brain_prepare', 'brain_recall', 'brain_digest'], hookNames: ['session_start', 'session_end', 'before_compaction', 'after_compaction', 'before_prompt_build', 'llm_input'] } }))
        : failure('Plugin not found')
      if (args[0] === 'plugins' && args[1] === 'install') {
        const pluginRoot = args[2]
        const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8')) as { id: string; version: string }
        state.installed = true
        state.enabled = false
        state.root = pluginRoot
        state.version = manifest.version
        return success('{}')
      }
      if (args[0] === 'plugins' && args[1] === 'enable') { state.enabled = true; return success('{}') }
      if (args[0] === 'config' && args[1] === 'set') {
        const target = options.env.OPENCLAW_CONFIG_PATH
        const document = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {}
        let cursor = document
        const segments = args[2].split('.')
        for (const segment of segments.slice(0, -1)) cursor = cursor[segment] ??= {}
        cursor[segments.at(-1)!] = JSON.parse(args[3])
        fs.writeFileSync(target, JSON.stringify(document))
        return success('{}')
      }
      if (args[0] === 'plugins' && args[1] === 'uninstall') { state.installed = false; state.enabled = false; return success('{}') }
      if (args[0] === 'gateway' && args[1] === 'restart') return success(JSON.stringify({ ok: true }))
      return failure('unexpected command')
    },
  }
  function record() {
    return {
      id: 'tidemind-eb-openclaw-1234',
      rootDir: state.root,
      version: state.version,
      enabled: state.enabled,
      status: state.enabled ? 'loaded' : 'disabled',
    }
  }
  return { dependencies, state, calls }
}

function success(stdout: string) { return { exitCode: 0, stdout, stderr: '' } }
function failure(stderr: string) { return { exitCode: 1, stdout: '', stderr } }

function activityFromQuery(
  query: HostActivityEvidenceQuery,
  signalName: HostActivityEvidenceRecord['signalName'],
): HostActivityEvidenceRecord {
  return {
    id: `evidence_${query.componentKey}_${signalName}`,
    installationId: query.installationId,
    agentId: query.agentId,
    hostVariant: query.hostVariant,
    componentKey: query.componentKey,
    signalName,
    tideMindVersion: query.tideMindVersion,
    adapterVersion: query.adapterVersion,
    projectionVersion: query.projectionVersion,
    hostVersion: query.hostVersion,
    evidenceHash: `hash_${signalName}`,
    observedAt: '2026-09-03T00:01:00.000Z',
  }
}
