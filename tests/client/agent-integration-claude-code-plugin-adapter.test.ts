import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createClaudeCodePluginHostAdapter,
  type ClaudeCodeCommandResult,
  type ClaudeCodePluginAdapterDependencies,
} from '../../client/electron/agent-integration/hosts/claude-code-plugin-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type {
  AdapterOperationContext,
  HostActivityEvidenceRecord,
  OwnedArtifactBaseline,
  PlannedMutation,
} from '../../client/electron/agent-integration/types'

class FakeClaudeCli implements ClaudeCodePluginAdapterDependencies {
  marketplaces = new Map<string, string>()
  plugins = new Map<string, { version: string; enabled: boolean }>()
  calls: string[][] = []
  failAfterStep: string | null = null
  failBeforeStep: string | null = null

  async run(_executable: string, args: readonly string[]): Promise<ClaudeCodeCommandResult> {
    this.calls.push([...args])
    if (args.join(' ') === 'plugin marketplace list --json') {
      return ok([...this.marketplaces].map(([name, marketplacePath]) => ({ name, source: 'directory', path: marketplacePath, installLocation: marketplacePath })))
    }
    if (args.join(' ') === 'plugin list --json') {
      return ok([...this.plugins].map(([id, state]) => ({ id, ...state, scope: 'user' })))
    }
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
      if (this.before('marketplace_add')) return fail('crash-before-marketplace_add')
      const root = args[3]
      const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8')) as { name: string }
      this.marketplaces.set(manifest.name, root)
      return this.after('marketplace_add')
    }
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
      if (this.before('marketplace_remove')) return fail('crash-before-marketplace_remove')
      const marketplace = args[3]
      this.marketplaces.delete(marketplace)
      for (const id of this.plugins.keys()) if (id.endsWith(`@${marketplace}`)) this.plugins.delete(id)
      return this.after('marketplace_remove')
    }
    if (args[0] === 'plugin' && args[1] === 'install') {
      if (this.before('plugin_install')) return fail('crash-before-plugin_install')
      const qualified = args[2]
      const marketplace = qualified.slice(qualified.lastIndexOf('@') + 1)
      const name = qualified.slice(0, qualified.lastIndexOf('@'))
      const root = this.marketplaces.get(marketplace)
      if (!root) return fail('marketplace missing')
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string }
      this.plugins.set(qualified, { version: manifest.version, enabled: true })
      return this.after('plugin_install')
    }
    if (args[0] === 'plugin' && args[1] === 'uninstall') {
      if (this.before('plugin_uninstall')) return fail('crash-before-plugin_uninstall')
      this.plugins.delete(args[2])
      return this.after('plugin_uninstall')
    }
    return fail(`unsupported:${args.join(' ')}`)
  }

  private after(step: string): ClaudeCodeCommandResult {
    if (this.failAfterStep === step) {
      this.failAfterStep = null
      return fail(`crash-after-${step}`)
    }
    return ok({})
  }

  private before(step: string): boolean {
    if (this.failBeforeStep !== step) return false
    this.failBeforeStep = null
    return true
  }
}

function ok(value: unknown): ClaudeCodeCommandResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' }
}

function fail(message: string): ClaudeCodeCommandResult {
  return { exitCode: 1, stdout: '', stderr: message }
}

describe('Claude Code official aggregate plugin adapter', () => {
  let root: string
  let cli: FakeClaudeCli

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-plugin-adapter-'))
    cli = new FakeClaudeCli()
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  function context(
    catalogId: 'claude-code-cli' | 'claude-code-native' = 'claude-code-cli',
    evidence?: readonly HostActivityEvidenceRecord[],
    nativeProvenance = 'native_bundle:unproven',
  ): AdapterOperationContext {
    const executable = path.join(root, 'bin', 'claude')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, '#!/bin/sh\n')
    const installation = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_01JCLAUDETEST',
      productFamilyId: 'claude-code',
      hostVariant: catalogId,
      configRoot: path.join(root, '.claude'),
      distribution: {
        distributionId: catalogId,
        executableRealpath: executable,
        packageProvenance: catalogId === 'claude-code-cli' ? 'npm_metadata:@anthropic-ai/claude-code' : nativeProvenance,
        capabilityFingerprint: 'claude-plugin-cli',
      },
    })
    return {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: root,
        applicationDataDir: path.join(root, 'app-data'),
        shimPath: path.join(root, 'Tide Mind.app', 'tm-node'),
        mcpServerPath: path.join(root, 'Tide Mind.app', 'mcp-server.cjs'),
        hookScriptPath: path.join(root, 'Tide Mind.app', 'hook-session-start.cjs'),
        preCompactScriptPath: path.join(root, 'Tide Mind.app', 'hook-pre-compact.cjs'),
        postCompactScriptPath: path.join(root, 'Tide Mind.app', 'hook-post-compact.cjs'),
        tideMindVersion: '0.2.92',
        catalogVersion: '2',
        projectionVersion: '4',
      },
      installation,
      installationId: 'installation-claude',
      hostVersion: '2.1.0',
      agentId: 'eb_claude_01',
      operationId: 'operation-claude',
      activityGenerationToken: 'generation-claude',
      hostActivityEvidence: evidence ? {
        find: async query => evidence.filter(record => (
          record.installationId === query.installationId
          && record.componentKey === query.componentKey
          && query.signalNames.includes(record.signalName)
        )),
      } : undefined,
    }
  }

  function adapter(catalogId: 'claude-code-cli' | 'claude-code-native' = 'claude-code-cli') {
    return createClaudeCodePluginHostAdapter({ catalogId, adapterVersion: 'claude-plugin-1', dependencies: cli })
  }

  async function plan(ctx = context(), ownedArtifacts: readonly OwnedArtifactBaseline[] = []) {
    const host = adapter(ctx.installation.hostVariant as 'claude-code-cli' | 'claude-code-native')
    return host.plan(ctx, {
      desiredCapability: 4,
      desiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      observed: await host.inspect(ctx),
      ownedArtifacts,
    })
  }

  function ownership(mutation: PlannedMutation): OwnedArtifactBaseline[] {
    return ['instruction', 'memory_tools', 'lifecycle'].map(componentKey => ({
      componentKey: componentKey as OwnedArtifactBaseline['componentKey'],
      physicalTarget: mutation.physicalTarget,
      ownershipKey: mutation.ownershipKey,
      ownedFragmentHash: mutation.desiredFragmentHash!,
      selectorSchemaVersion: mutation.selectorSchemaVersion,
    }))
  }

  it('plans one aggregate artifact with all frozen commands, fences and three components', async () => {
    const ctx = context()
    const result = await plan(ctx)

    expect(cli.calls).toEqual([])
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0]).toMatchObject({
      componentKey: 'instruction',
      coveredComponentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      operation: 'host_command',
      domainKind: 'plugin_manager',
      commandCategory: 'plugin_install',
      idempotent: true,
    })
    expect(result.mutations[0].frozenCommands?.map(command => command.args.slice(0, 3))).toEqual([
      ['plugin', 'marketplace', 'add'],
      ['plugin', 'install', expect.stringContaining('@')],
    ])
    expect(result.mutations[0].additionalFenceTargets?.map(target => target.physicalTarget)).toEqual(expect.arrayContaining([
      path.join(root, '.claude', 'settings.json'),
      path.join(root, '.claude', 'plugins', 'known_marketplaces.json'),
      path.join(root, '.claude', 'plugins', 'installed_plugins.json'),
    ]))
    expect(result.mutations[0].safeResumeStates?.length).toBeGreaterThan(2)
  })

  it.each([
    ['before', 'marketplace_add'],
    ['after', 'marketplace_add'],
    ['before', 'plugin_install'],
    ['after', 'plugin_install'],
  ] as const)(
    'recognizes the exact crash-visible state %s %s',
    async (timing, step) => {
      const ctx = context()
      const host = adapter()
      const mutation = (await plan(ctx)).mutations[0]
      if (timing === 'before') cli.failBeforeStep = step
      else cli.failAfterStep = step

      await expect(host.apply(ctx, mutation)).rejects.toThrow(`crash-${timing}-${step}`)
      const interrupted = await host.readBack(ctx, mutation)
      if (timing === 'after' && step === 'plugin_install') {
        expect(interrupted).toMatchObject({ matchesDesired: true })
      } else {
        expect(interrupted.matchesDesired).toBe(false)
        expect(interrupted.safeToResumeFrom).toBeDefined()
        await host.apply(ctx, mutation)
        expect(await host.readBack(ctx, mutation)).toMatchObject({ matchesDesired: true, visibility: 'dedicated' })
      }
    },
  )

  it('recognizes the exact no-effect state when the runner crashes before adapter apply', async () => {
    const ctx = context()
    const host = adapter()
    const mutation = (await plan(ctx)).mutations[0]
    const untouched = await host.readBack(ctx, mutation)
    expect(untouched.matchesDesired).toBe(false)
    expect(untouched.safeToResumeFrom).toEqual(expect.objectContaining({
      fingerprint: untouched.observedFragmentHash,
      completedStepIds: ['source_files:0'],
    }))
  })

  it('binds Skill, MCP and all lifecycle hooks to the persisted Agent identity', async () => {
    const ctx = context()
    const host = adapter()
    const mutation = (await plan(ctx)).mutations[0]
    await host.apply(ctx, mutation)
    const marketplaceRoot = mutation.additionalFenceTargets?.[0].physicalTarget as string
    const pluginName = mutation.ownershipKey.slice(0, mutation.ownershipKey.lastIndexOf('@'))
    const pluginRoot = path.join(marketplaceRoot, 'plugins', pluginName)
    const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'))
    const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'))
    const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'tidemind', 'SKILL.md'), 'utf8')

    expect(mcp.mcpServers.tidemind.env).toMatchObject({ EB_AGENT_ID: ctx.agentId, EB_HOST_VARIANT: 'claude-code-cli' })
    expect(Object.keys(hooks.hooks)).toEqual(['SessionStart', 'PreCompact', 'PostCompact'])
    for (const group of Object.values(hooks.hooks) as any[]) expect(group[0].hooks[0].command).toContain(ctx.agentId)
    expect(skill).toContain('brain_prepare')
    expect(skill).toContain('brain_recall')
    expect(skill).toContain('brain_digest')
  })

  it('upgrades an owned plugin through one aggregate uninstall/install journal', async () => {
    const oldContext = context()
    const host = adapter()
    const oldMutation = (await plan(oldContext)).mutations[0]
    await host.apply(oldContext, oldMutation)
    const previousVersion = cli.plugins.get(oldMutation.ownershipKey)?.version

    const nextContext = context()
    nextContext.runtime = { ...nextContext.runtime, tideMindVersion: '0.2.93' }
    nextContext.operationId = 'operation-claude-upgrade'
    const upgradedPlan = await host.plan(nextContext, {
      desiredCapability: 4,
      desiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      observed: await host.inspect(nextContext),
      ownedArtifacts: ownership(oldMutation),
    })
    expect(upgradedPlan.mutations).toHaveLength(1)
    expect(upgradedPlan.mutations[0].frozenCommands?.map(command => command.args[1])).toEqual([
      'marketplace',
      'uninstall',
      'install',
    ])
    await host.apply(nextContext, upgradedPlan.mutations[0])
    expect(cli.plugins.get(oldMutation.ownershipKey)?.version).not.toBe(previousVersion)
    expect(await host.readBack(nextContext, upgradedPlan.mutations[0])).toMatchObject({ matchesDesired: true })
  })

  it('keeps static configuration unverified and requires version-bound real activity for C4', async () => {
    const base = context()
    const host = adapter()
    const mutation = (await plan(base)).mutations[0]
    await host.apply(base, mutation)
    const inspection = await host.inspect(base)
    const request = {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'] as const,
      expectedCapability: 4 as const,
      inspection,
      activityBinding: {
        installationId: 'installation-claude', tideMindVersion: '0.2.92', adapterVersion: 'claude-plugin-1', projectionVersion: '4', hostVersion: '2.1.0', activationRunId: 'run-claude', activityGenerationToken: 'generation-claude', observedAfter: '2026-08-01T00:00:00.000Z', verifiedAt: '2026-09-03T00:00:00.000Z',
      },
    }
    expect((await host.verify(base, request)).every(result => result.status === 'unverified')).toBe(true)

    const evidence = [
      activity('lifecycle', 'session_start'),
      activity('memory_tools', 'brain_recall'),
    ]
    const partialContext = context('claude-code-cli', evidence)
    const partial = await host.verify(partialContext, request)
    expect(partial.find(result => result.componentKey === 'instruction')?.status).toBe('unverified')
    expect(partial.find(result => result.componentKey === 'lifecycle')?.status).toBe('unverified')
    expect(partial.find(result => result.componentKey === 'memory_tools')?.status).toBe('unverified')

    const verifiedContext = context('claude-code-cli', [
      ...evidence,
      activity('memory_tools', 'brain_digest'),
      activity('lifecycle', 'pre_compact'),
      activity('lifecycle', 'post_compact'),
    ])
    const verified = await host.verify(verifiedContext, request)
    expect(verified.map(result => [result.componentKey, result.status, result.verifiedCapability])).toEqual([
      ['instruction', 'verified', 1],
      ['memory_tools', 'verified', 2],
      ['lifecycle', 'verified', 4],
    ])
  })

  it('disconnects one owned aggregate, preserves unrelated plugins, and remains idempotent', async () => {
    const ctx = context()
    const host = adapter()
    const connected = (await plan(ctx)).mutations[0]
    await host.apply(ctx, connected)
    cli.marketplaces.set('user-marketplace', '/Users/user/plugin')
    cli.plugins.set('user-plugin@user-marketplace', { version: '9.0.0', enabled: true })

    const disconnect = await host.disconnect(ctx, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      observed: await host.inspect(ctx),
      ownedArtifacts: ownership(connected),
    })
    expect(disconnect.mutations).toHaveLength(1)
    await host.apply(ctx, disconnect.mutations[0])
    expect(await host.readBack(ctx, disconnect.mutations[0])).toMatchObject({ matchesDesired: true, observed: false })
    expect(cli.marketplaces.get('user-marketplace')).toBe('/Users/user/plugin')
    expect(cli.plugins.has('user-plugin@user-marketplace')).toBe(true)
    await host.apply(ctx, disconnect.mutations[0])
    expect(cli.plugins.has('user-plugin@user-marketplace')).toBe(true)
  })

  it.each([
    ['before', 'plugin_uninstall'],
    ['after', 'plugin_uninstall'],
    ['before', 'marketplace_remove'],
    ['after', 'marketplace_remove'],
  ] as const)('resumes an exact disconnect interruption %s %s', async (timing, step) => {
    const ctx = context()
    const host = adapter()
    const connected = (await plan(ctx)).mutations[0]
    await host.apply(ctx, connected)
    const disconnect = await host.disconnect(ctx, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      observed: await host.inspect(ctx),
      ownedArtifacts: ownership(connected),
    })
    const mutation = disconnect.mutations[0]
    if (timing === 'before') cli.failBeforeStep = step
    else cli.failAfterStep = step

    await expect(host.apply(ctx, mutation)).rejects.toThrow(`crash-${timing}-${step}`)
    const interrupted = await host.readBack(ctx, mutation)
    if (timing === 'before' && step === 'plugin_uninstall') {
      expect(interrupted.safeToResumeFrom).toBeUndefined()
      expect(interrupted.observedFragmentHash).toBe(mutation.preconditionHash)
    } else {
      expect(interrupted.safeToResumeFrom).toBeDefined()
    }
    await host.apply(ctx, mutation)
    expect(await host.readBack(ctx, mutation)).toMatchObject({ matchesDesired: true, observed: false })
  })

  it('fails native distribution closed and never auto-trusts static or conflicting marketplace state', async () => {
    const native = context('claude-code-native')
    const nativePlan = await plan(native)
    expect(nativePlan.mutations).toEqual([])
    expect(nativePlan.diagnostics).toContain('claude_native_distribution_identity_unproven')

    const ctx = context()
    const host = adapter()
    const mutation = (await plan(ctx)).mutations[0]
    const marketplaceId = mutation.ownershipKey.slice(mutation.ownershipKey.lastIndexOf('@') + 1)
    cli.marketplaces.set(marketplaceId, '/Users/user-owned-marketplace')
    await expect(host.apply(ctx, mutation)).rejects.toThrow('claude_marketplace_source_conflict')
    expect(cli.marketplaces.get(marketplaceId)).toBe('/Users/user-owned-marketplace')
    expect(await host.inspectAdoptableArtifacts?.(ctx)).toEqual([])
  })

  it('adopts only the exact identity-bound 0.2.89/0.2.91 Tide Mind plugin bundle', async () => {
    const ctx = context()
    const legacyRoot = path.join(ctx.runtime.applicationDataDir, 'plugins', `claude-code-${ctx.agentId}`)
    const pluginName = `tidemind-${ctx.agentId}`
    const write = (relative: string, content: string) => {
      const target = path.join(legacyRoot, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
    const sourceSkill = '# Legacy Tide Mind skill\n'
    fs.mkdirSync(path.join(ctx.runtime.applicationDataDir, 'skill'), { recursive: true })
    fs.writeFileSync(path.join(ctx.runtime.applicationDataDir, 'skill', 'claude-code-skill.md'), sourceSkill)
    write('.claude-plugin/plugin.json', JSON.stringify({ name: pluginName, version: '1.0.17', description: '外部记忆系统', author: { name: 'TideMind' } }, null, 2))
    write('.mcp.json', JSON.stringify({ mcpServers: { tidemind: { command: ctx.runtime.shimPath, args: [ctx.runtime.mcpServerPath], env: { EB_AGENT_ID: ctx.agentId } } } }, null, 2))
    const session = [JSON.stringify(ctx.runtime.shimPath), JSON.stringify(ctx.runtime.hookScriptPath), '--agent-id', JSON.stringify(ctx.agentId), '--skill-path', JSON.stringify(path.join(legacyRoot, 'skills', 'tidemind', 'SKILL.md')), '--tool', JSON.stringify('claude-code')].join(' ')
    const pre = [JSON.stringify(ctx.runtime.shimPath), JSON.stringify(ctx.runtime.preCompactScriptPath), '--agent-id', JSON.stringify(ctx.agentId), '--tool', JSON.stringify('claude-code')].join(' ')
    const post = [JSON.stringify(ctx.runtime.shimPath), JSON.stringify(ctx.runtime.postCompactScriptPath), '--agent-id', JSON.stringify(ctx.agentId), '--tool', JSON.stringify('claude-code')].join(' ')
    write('hooks/hooks.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: session }] }], PreCompact: [{ hooks: [{ type: 'command', command: pre }] }], PostCompact: [{ hooks: [{ type: 'command', command: post }] }] } }, null, 2))
    write('skills/tidemind/SKILL.md', legacyClaudeSkill(pluginName) + sourceSkill)
    expect(await adapter().inspectAdoptableArtifacts!(ctx)).toEqual([])
    cli.marketplaces.set('tidemind-local', path.join(ctx.runtime.applicationDataDir, 'plugins'))
    cli.plugins.set(`${pluginName}@tidemind-local`, { version: '1.0.17', enabled: true })

    const host = adapter()
    const observations = await host.inspectAdoptableArtifacts!(ctx)
    expect(observations.map(item => item.componentKey)).toEqual(['instruction', 'memory_tools', 'lifecycle'])
    expect(new Set(observations.map(item => item.identityAssertion))).toEqual(new Set([ctx.agentId]))

    fs.appendFileSync(path.join(legacyRoot, 'skills', 'tidemind', 'SKILL.md'), '# user edit\n')
    expect(await host.inspectAdoptableArtifacts!(ctx)).toEqual([])
    write('skills/tidemind/SKILL.md', legacyClaudeSkill(pluginName) + sourceSkill)
    const mcp = JSON.parse(fs.readFileSync(path.join(legacyRoot, '.mcp.json'), 'utf8'))
    mcp.mcpServers.tidemind.env.EB_AGENT_ID = 'eb_someone_else'
    fs.writeFileSync(path.join(legacyRoot, '.mcp.json'), JSON.stringify(mcp, null, 2))
    expect(await host.inspectAdoptableArtifacts!(ctx)).toEqual([])
  })

  it('uses the same aggregate plugin contract for an attested official native executable', async () => {
    const native = context(
      'claude-code-native',
      undefined,
      'signed_cli:com.anthropic.claude-code:Q6L2SF6YDW',
    )
    const nativePlan = await plan(native)
    expect(nativePlan.mutations).toHaveLength(1)
    expect(nativePlan.mutations[0]).toMatchObject({
      componentKey: 'instruction',
      coveredComponentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      domainKind: 'plugin_manager',
    })
  })

  it('rejects a frozen executable or argument changed after preview', async () => {
    const ctx = context()
    const host = adapter()
    const mutation = (await plan(ctx)).mutations[0]
    const changedExecutable = {
      ...mutation,
      frozenCommands: mutation.frozenCommands?.map((command, index) => index === 0
        ? { ...command, executableRealpath: path.join(root, 'bin', 'other-claude') }
        : command),
    }
    await expect(host.apply(ctx, changedExecutable)).rejects.toThrow('claude_plugin_frozen_commands_changed')

    const changedArgs = {
      ...mutation,
      frozenCommands: mutation.frozenCommands?.map((command, index) => index === 1
        ? { ...command, args: [...command.args, '--dangerously-broadened'] }
        : command),
    }
    await expect(host.apply(ctx, changedArgs)).rejects.toThrow('claude_plugin_frozen_commands_changed')
    expect(cli.marketplaces.size).toBe(0)
    expect(cli.plugins.size).toBe(0)
  })

  function activity(componentKey: 'lifecycle' | 'memory_tools', signalName: string): HostActivityEvidenceRecord {
    return {
      id: `activity:${componentKey}:${signalName}`,
      evidenceHash: 'a'.repeat(64),
      installationId: 'installation-claude',
      agentId: 'eb_claude_01',
      hostVariant: 'claude-code-cli',
      componentKey,
      signalName: signalName as HostActivityEvidenceRecord['signalName'],
      tideMindVersion: '0.2.92',
      adapterVersion: 'claude-plugin-1',
      projectionVersion: '4',
      hostVersion: '2.1.0',
      observedAt: '2026-09-02T00:00:00.000Z',
    }
  }
})

function legacyClaudeSkill(pluginName: string): string {
  return [
    '---',
    'description: "Tide Mind 外部记忆系统已连接。用户上下文在会话启动时自动加载。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。"',
    'when_to_use: |',
    '  用户提起"之前"、"上次"、"记得吗"、过去的决定或观点时；',
    '  需要判断用户偏好、历史态度、长期目标时；',
    '  用户明确说"记住"、"别忘了"、"以后不要..."时；',
    '  每次完成实质性请求后、用户做出决策或表达观点时需要沉淀结论。',
    'allowed-tools:',
    '  - mcp__tidemind__brain_prepare',
    '  - mcp__tidemind__brain_recall',
    '  - mcp__tidemind__brain_digest',
    `  - mcp__${pluginName}__brain_prepare`,
    `  - mcp__${pluginName}__brain_recall`,
    `  - mcp__${pluginName}__brain_digest`,
    `  - mcp__plugin_${pluginName}_tidemind__brain_prepare`,
    `  - mcp__plugin_${pluginName}_tidemind__brain_recall`,
    `  - mcp__plugin_${pluginName}_tidemind__brain_digest`,
    '---',
    '',
  ].join('\n')
}
