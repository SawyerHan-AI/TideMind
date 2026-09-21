import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createQwenCodeJsonAggregateAdapter,
  createZCodeDesktopJsonAggregateAdapter,
} from '../../client/electron/agent-integration/hosts/json-mcp-lifecycle-aggregate-adapter'
import { sha256Json } from '../../client/electron/agent-integration/fingerprint'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type {
  AdapterOperationContext,
  AdapterPlanRequest,
  HostActivityEvidenceRecord,
  OwnedArtifactBaseline,
} from '../../client/electron/agent-integration/types'

describe('Qwen/ZCode aggregate JSON adapter', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'json-aggregate-adapter-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it.each(['qwen-code-cli', 'zcode-desktop'] as const)(
    'projects MCP and lifecycle into one CAS mutation for %s',
    async (catalogId) => {
      const ctx = context(catalogId)
      const target = configFile(ctx)
      fs.writeFileSync(target, JSON.stringify({ theme: 'user-owned' }))
      const adapter = catalogId === 'qwen-code-cli'
        ? createQwenCodeJsonAggregateAdapter()
        : createZCodeDesktopJsonAggregateAdapter()
      const plan = await adapter.plan(ctx, request(ctx))

      expect(plan.mutations).toHaveLength(1)
      expect(plan.mutations[0]).toMatchObject({
        componentKey: 'memory_tools',
        coveredComponentKeys: ['memory_tools', 'lifecycle'],
        operation: 'create',
        physicalTarget: target,
      })
      if (catalogId === 'zcode-desktop') {
        expect(plan.mutations[0].ownershipKey).toContain('.activation-owned')
      }
      await adapter.apply(ctx, plan.mutations[0])

      const document = JSON.parse(fs.readFileSync(target, 'utf8'))
      expect(document.theme).toBe('user-owned')
      if (catalogId === 'qwen-code-cli') {
        expect(document.mcpServers[`tidemind-${ctx.agentId}`].env).toMatchObject({
          EB_AGENT_ID: ctx.agentId,
          EB_HOST_VARIANT: catalogId,
        })
        expect(document.hooks.SessionStart[0].hooks[0].name).toContain(ctx.agentId)
      } else {
        expect(document.mcp.servers[`tidemind-${ctx.agentId}`].env).toMatchObject({
          EB_AGENT_ID: ctx.agentId,
          EB_HOST_VARIANT: catalogId,
        })
        expect(document.hooks.enabled).toBe(true)
        expect(document.hooks.events.SessionStart[0].hooks[0].args).toContain(ctx.agentId)
      }
      expect(await adapter.readBack(ctx, plan.mutations[0])).toMatchObject({
        observed: true,
        matchesDesired: true,
        visibility: 'dedicated',
      })
    },
  )

  it('rejects a second writer-window change and preserves the external edit', async () => {
    const ctx = context('qwen-code-cli')
    const adapter = createQwenCodeJsonAggregateAdapter()
    const plan = await adapter.plan(ctx, request(ctx))
    fs.writeFileSync(configFile(ctx), JSON.stringify({ externallyChanged: true }))

    await expect(adapter.apply(ctx, plan.mutations[0])).rejects.toThrow('aggregate_container_precondition_changed')
    expect(JSON.parse(fs.readFileSync(configFile(ctx), 'utf8'))).toEqual({ externallyChanged: true })
  })

  it('disconnects both projections in one mutation and preserves unrelated host data', async () => {
    const ctx = context('zcode-desktop')
    const adapter = createZCodeDesktopJsonAggregateAdapter()
    const connect = await adapter.plan(ctx, request(ctx))
    await adapter.apply(ctx, connect.mutations[0])
    const target = configFile(ctx)
    const current = JSON.parse(fs.readFileSync(target, 'utf8'))
    current.userSetting = 42
    fs.writeFileSync(target, JSON.stringify(current))

    // Re-preview after the unrelated container edit. Selector ownership is
    // still exact; the new frozen container hash safely includes userSetting.
    const hash = connect.mutations[0].desiredFragmentHash!
    const disconnect = await adapter.disconnect(ctx, {
      componentKeys: ['memory_tools', 'lifecycle'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: owned(ctx, hash),
    })
    expect(disconnect.mutations).toHaveLength(1)
    expect(disconnect.mutations[0]).toMatchObject({
      operation: 'remove',
      coveredComponentKeys: ['memory_tools', 'lifecycle'],
      preconditionHash: hash,
    })
    await adapter.apply(ctx, disconnect.mutations[0])

    const after = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(after.userSetting).toBe(42)
    expect(after.mcp).toBeUndefined()
    expect(after.hooks).toBeUndefined()
    expect(await adapter.readBack(ctx, disconnect.mutations[0])).toMatchObject({
      observed: false,
      matchesDesired: true,
    })
  })

  it('borrows a pre-enabled ZCode hook switch and preserves it on disconnect', async () => {
    const ctx = context('zcode-desktop')
    const target = configFile(ctx)
    fs.writeFileSync(target, JSON.stringify({ hooks: { enabled: true } }))
    const adapter = createZCodeDesktopJsonAggregateAdapter()
    const connect = await adapter.plan(ctx, request(ctx))

    expect(connect.mutations[0].ownershipKey).toContain('.activation-borrowed')
    await adapter.apply(ctx, connect.mutations[0])
    const disconnect = await adapter.disconnect(ctx, {
      componentKeys: ['memory_tools', 'lifecycle'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: owned(ctx, connect.mutations[0].desiredFragmentHash!, 'borrowed'),
    })
    await adapter.apply(ctx, disconnect.mutations[0])

    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ hooks: { enabled: true } })
    expect(await adapter.readBack(ctx, disconnect.mutations[0])).toMatchObject({ matchesDesired: true })
  })

  it('refuses to override an explicitly disabled ZCode hook switch', async () => {
    const ctx = context('zcode-desktop')
    fs.writeFileSync(configFile(ctx), JSON.stringify({ hooks: { enabled: false } }))
    const plan = await createZCodeDesktopJsonAggregateAdapter().plan(ctx, request(ctx))

    expect(plan.mutations).toEqual([])
    expect(plan.diagnostics).toContain('host_hooks_explicitly_disabled')
  })

  it('requires a fresh elevated preview before enabling dormant user ZCode hooks', async () => {
    const ctx = context('zcode-desktop')
    fs.writeFileSync(configFile(ctx), JSON.stringify({
      hooks: {
        events: {
          SessionStart: [{ matcher: 'startup', hooks: [{ type: 'process', command: '/usr/bin/true' }] }],
        },
      },
    }))
    const plan = await createZCodeDesktopJsonAggregateAdapter().plan(ctx, request(ctx))

    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({ risk: 'elevated' })
    expect(plan.requiredUserActions).toEqual(['confirm_enable_existing_zcode_hooks:1'])
  })

  it('repairs an owned ZCode activation deleted after connection and becomes idempotent', async () => {
    const ctx = context('zcode-desktop')
    const adapter = createZCodeDesktopJsonAggregateAdapter()
    const connect = await adapter.plan(ctx, request(ctx))
    await adapter.apply(ctx, connect.mutations[0])
    const target = configFile(ctx)
    const document = JSON.parse(fs.readFileSync(target, 'utf8'))
    delete document.hooks.enabled
    fs.writeFileSync(target, JSON.stringify(document))

    const repair = await adapter.plan(ctx, {
      ...request(ctx),
      ownedArtifacts: owned(ctx, connect.mutations[0].desiredFragmentHash!),
    })
    expect(repair.mutations).toHaveLength(1)
    expect(repair.mutations[0]).toMatchObject({ operation: 'update', risk: 'low' })
    await adapter.apply(ctx, repair.mutations[0])
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.enabled).toBe(true)
    expect(await adapter.readBack(ctx, repair.mutations[0])).toMatchObject({ matchesDesired: true })

    const second = await adapter.plan(ctx, {
      ...request(ctx),
      ownedArtifacts: owned(ctx, connect.mutations[0].desiredFragmentHash!),
    })
    expect(second.mutations).toEqual([])
  })

  it('rejects a CAS race while repairing an owned ZCode activation', async () => {
    const ctx = context('zcode-desktop')
    const adapter = createZCodeDesktopJsonAggregateAdapter()
    const connect = await adapter.plan(ctx, request(ctx))
    await adapter.apply(ctx, connect.mutations[0])
    const target = configFile(ctx)
    const document = JSON.parse(fs.readFileSync(target, 'utf8'))
    delete document.hooks.enabled
    fs.writeFileSync(target, JSON.stringify(document))
    const repair = await adapter.plan(ctx, {
      ...request(ctx),
      ownedArtifacts: owned(ctx, connect.mutations[0].desiredFragmentHash!),
    })
    document.userChangedAfterPreview = true
    fs.writeFileSync(target, JSON.stringify(document))

    await expect(adapter.apply(ctx, repair.mutations[0])).rejects.toThrow('aggregate_container_precondition_changed')
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.enabled).toBeUndefined()
  })

  it('keeps shared ZCode activation enabled while removing only owned hooks', async () => {
    const ctx = context('zcode-desktop')
    const adapter = createZCodeDesktopJsonAggregateAdapter()
    const connect = await adapter.plan(ctx, request(ctx))
    await adapter.apply(ctx, connect.mutations[0])
    const target = configFile(ctx)
    const document = JSON.parse(fs.readFileSync(target, 'utf8'))
    document.hooks.events.PreToolUse = [
      { matcher: 'Write', hooks: [{ type: 'process', command: '/usr/bin/true' }] },
      { matcher: 'Read', hooks: [{ type: 'process', command: '/usr/bin/false' }] },
    ]
    fs.writeFileSync(target, JSON.stringify(document))

    const disconnect = await adapter.disconnect(ctx, {
      componentKeys: ['memory_tools', 'lifecycle'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: owned(ctx, connect.mutations[0].desiredFragmentHash!),
    })
    expect(disconnect.requiredUserActions).toEqual([])
    expect(disconnect.mutations[0]).toMatchObject({ operation: 'remove', risk: 'low' })
    await adapter.apply(ctx, disconnect.mutations[0])
    const after = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(after.hooks.enabled).toBe(true)
    expect(after.hooks.events.PreToolUse).toHaveLength(2)
    expect(await adapter.readBack(ctx, disconnect.mutations[0])).toMatchObject({ matchesDesired: true })
  })

  it.each(['qwen-code-cli', 'zcode-desktop'] as const)(
    'atomically upgrades the exact 0.2.91 MCP Ledger into the %s aggregate',
    async (catalogId) => {
      const ctx = context(catalogId)
      const target = configFile(ctx)
      const memory = {
        command: ctx.runtime.shimPath,
        args: [ctx.runtime.mcpServerPath],
        env: { EB_AGENT_ID: ctx.agentId, EB_HOST_VARIANT: catalogId },
      }
      const document = catalogId === 'qwen-code-cli'
        ? { mcpServers: { [`tidemind-${ctx.agentId}`]: memory } }
        : { mcp: { servers: { [`tidemind-${ctx.agentId}`]: memory } } }
      fs.writeFileSync(target, JSON.stringify(document))
      const adapter = catalogId === 'qwen-code-cli'
        ? createQwenCodeJsonAggregateAdapter()
        : createZCodeDesktopJsonAggregateAdapter()
      const baseline = legacyOwnedMemory(ctx, memory)
      const plan = await adapter.plan(ctx, { ...request(ctx), ownedArtifacts: [baseline] })

      expect(plan.mutations).toHaveLength(1)
      expect(plan.mutations[0]).toMatchObject({
        operation: 'update',
        coveredComponentKeys: ['memory_tools', 'lifecycle'],
        ownershipTransferFrom: {
          physicalTarget: target,
          ownershipKey: baseline.ownershipKey,
          ownedFragmentHash: baseline.ownedFragmentHash,
          selectorSchemaVersion: 1,
        },
      })
      await adapter.apply(ctx, plan.mutations[0])
      expect(await adapter.readBack(ctx, plan.mutations[0])).toMatchObject({ matchesDesired: true })
    },
  )

  it.each(['qwen-code-cli', 'zcode-desktop'] as const)(
    'exposes the exact 0.2.91 MCP selector for identity-preserving %s adoption',
    async (catalogId) => {
      const ctx = context(catalogId)
      const target = configFile(ctx)
      const memory = {
        command: ctx.runtime.shimPath,
        args: [ctx.runtime.mcpServerPath],
        env: { EB_AGENT_ID: ctx.agentId, EB_HOST_VARIANT: catalogId },
      }
      fs.writeFileSync(target, JSON.stringify(catalogId === 'qwen-code-cli'
        ? { mcpServers: { [`tidemind-${ctx.agentId}`]: memory } }
        : { mcp: { servers: { [`tidemind-${ctx.agentId}`]: memory } } }))
      const adapter = catalogId === 'qwen-code-cli'
        ? createQwenCodeJsonAggregateAdapter()
        : createZCodeDesktopJsonAggregateAdapter()

      await expect(adapter.inspectAdoptableArtifacts?.(ctx)).resolves.toEqual([
        expect.objectContaining({
          componentKey: 'memory_tools',
          artifactType: 'mcp',
          physicalTarget: fs.realpathSync(target),
          ownershipKey: `${catalogId === 'qwen-code-cli' ? 'mcpServers' : 'mcp.servers'}.tidemind-${ctx.agentId}`,
          fragmentHash: sha256Json(memory),
          identityAssertion: ctx.agentId,
        }),
      ])
    },
  )

  it('rejects a 0.2.91 aggregate upgrade after its owned MCP fragment drifted', async () => {
    const ctx = context('zcode-desktop')
    const memory = {
      command: ctx.runtime.shimPath,
      args: [ctx.runtime.mcpServerPath],
      env: { EB_AGENT_ID: ctx.agentId, EB_HOST_VARIANT: ctx.installation.hostVariant },
    }
    const baseline = legacyOwnedMemory(ctx, memory)
    fs.writeFileSync(configFile(ctx), JSON.stringify({
      mcp: { servers: { [`tidemind-${ctx.agentId}`]: { ...memory, command: '/tmp/changed' } } },
    }))
    const plan = await createZCodeDesktopJsonAggregateAdapter().plan(ctx, {
      ...request(ctx),
      ownedArtifacts: [baseline],
    })

    expect(plan.mutations).toEqual([])
    expect(plan.diagnostics).toContain('legacy_owned_mcp_fragment_modified')
  })

  it('fails closed when an owned ZCode activation is changed to false before disconnect', async () => {
    const ctx = context('zcode-desktop')
    const adapter = createZCodeDesktopJsonAggregateAdapter()
    const connect = await adapter.plan(ctx, request(ctx))
    await adapter.apply(ctx, connect.mutations[0])
    const document = JSON.parse(fs.readFileSync(configFile(ctx), 'utf8'))
    document.hooks.enabled = false
    fs.writeFileSync(configFile(ctx), JSON.stringify(document))

    const disconnect = await adapter.disconnect(ctx, {
      componentKeys: ['memory_tools', 'lifecycle'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: owned(ctx, connect.mutations[0].desiredFragmentHash!),
    })
    expect(disconnect.mutations).toEqual([])
    expect(disconnect.diagnostics).toContain('zcode_owned_hook_activation_modified')
  })

  it('fails closed on partial pre-existing Tide Mind state without aggregate ownership', async () => {
    const ctx = context('qwen-code-cli')
    fs.writeFileSync(configFile(ctx), JSON.stringify({
      mcpServers: {
        [`tidemind-${ctx.agentId}`]: {
          command: ctx.runtime.shimPath,
          args: [ctx.runtime.mcpServerPath],
          env: { EB_AGENT_ID: ctx.agentId, EB_HOST_VARIANT: ctx.installation.hostVariant },
        },
      },
    }))
    const plan = await createQwenCodeJsonAggregateAdapter().plan(ctx, request(ctx))
    expect(plan.mutations).toEqual([])
    expect(plan.diagnostics).toContain('aggregate_selector_partially_occupied')
  })

  it('honors Qwen excluded globs before allowed globs without changing user policy', async () => {
    const ctx = context('qwen-code-cli')
    const target = configFile(ctx)
    const document = {
      mcp: {
        allowed: ['tidemind-*'],
        excluded: ['tidemind-eb_qwen_????'],
      },
    }
    fs.writeFileSync(target, JSON.stringify(document))
    const adapter = createQwenCodeJsonAggregateAdapter()
    const inspected = await adapter.inspect(ctx)
    const plan = await adapter.plan(ctx, request(ctx))

    expect(inspected.diagnostics).toContain('qwen_mcp_server_explicitly_excluded')
    expect(plan.mutations).toEqual([])
    expect(plan.requiredUserActions).toEqual([`remove_qwen_mcp_exclusion:tidemind-${ctx.agentId}`])
    expect(plan.requiredUserActionDetails).toEqual([
      expect.objectContaining({ kind: 'mcp_activation', reason: 'excluded' }),
    ])
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(document)
  })

  it('requires an explicit Qwen allow-list match and accepts a wildcard match', async () => {
    const ctx = context('qwen-code-cli')
    const target = configFile(ctx)
    fs.writeFileSync(target, JSON.stringify({ mcp: { allowed: ['other-*'] } }))
    const adapter = createQwenCodeJsonAggregateAdapter()
    const denied = await adapter.plan(ctx, request(ctx))

    expect(denied.mutations).toEqual([])
    expect(denied.requiredUserActions).toEqual([`allow_qwen_mcp_server:tidemind-${ctx.agentId}`])
    expect(denied.requiredUserActionDetails).toEqual([
      expect.objectContaining({ kind: 'mcp_activation', reason: 'not_allowed' }),
    ])

    fs.writeFileSync(target, JSON.stringify({ mcp: { allowed: ['tidemind-*'] } }))
    const allowed = await adapter.plan(ctx, request(ctx))
    expect(allowed.mutations).toHaveLength(1)
  })

  it('keeps component verification independent and requires fresh activity for both', async () => {
    let ctx = context('qwen-code-cli')
    const adapter = createQwenCodeJsonAggregateAdapter()
    const connect = await adapter.plan(ctx, request(ctx))
    await adapter.apply(ctx, connect.mutations[0])
    ctx = {
      ...ctx,
      hostActivityEvidence: {
        find(query) {
          return query.componentKey === 'memory_tools'
            ? [
                activity(ctx, 'memory_tools', 'brain_recall'),
                activity(ctx, 'memory_tools', 'brain_digest'),
              ]
            : ['session_start', 'pre_compact', 'session_end']
                .map(signal => activity(ctx, 'lifecycle', signal as 'session_start' | 'pre_compact' | 'session_end'))
        },
      },
    }
    const results = await adapter.verify(ctx, {
      componentKeys: ['memory_tools', 'lifecycle'],
      expectedCapability: 4,
      inspection: await adapter.inspect(ctx),
      activityBinding: {
        installationId: 'installation-aggregate',
        tideMindVersion: '0.2.92',
        adapterVersion: '2',
        projectionVersion: '1',
        hostVersion: '0.10.0',
        activationRunId: 'run-qwen-code-cli',
        activityGenerationToken: 'generation-qwen-code-cli',
        observedAfter: '2026-09-02T00:00:00.000Z',
        verifiedAt: '2026-09-02T00:10:00.000Z',
      },
    })
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentKey: 'memory_tools', status: 'verified' }),
      expect.objectContaining({ componentKey: 'lifecycle', status: 'verified' }),
    ]))
  })

  function context(catalogId: 'qwen-code-cli' | 'zcode-desktop'): AdapterOperationContext {
    const configRoot = catalogId === 'qwen-code-cli'
      ? path.join(root, '.qwen')
      : path.join(root, '.zcode', 'cli')
    fs.mkdirSync(configRoot, { recursive: true })
    return {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: root,
        applicationDataDir: path.join(root, 'app-data'),
        shimPath: '/Applications/Tide Mind.app/Contents/Resources/tm-node',
        mcpServerPath: '/Applications/Tide Mind.app/Contents/Resources/mcp-server.cjs',
        hookScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook-session-start.cjs',
        preCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook-pre-compact.cjs',
        postCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook-post-compact.cjs',
        tideMindVersion: '0.2.92',
        catalogVersion: '2026-09-02',
        projectionVersion: '1',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_01JABCDEF0123456789',
        productFamilyId: catalogId === 'qwen-code-cli' ? 'qwen-code' : 'zcode',
        hostVariant: catalogId,
        configRoot,
        distribution: catalogId === 'zcode-desktop' ? { distributionId: 'dev.zcode.app' } : {},
      }),
      installationId: 'installation-aggregate',
      hostVersion: '0.10.0',
      agentId: catalogId === 'qwen-code-cli' ? 'eb_qwen_1234' : 'eb_zcode_1234',
      operationId: `run-${catalogId}`,
      activityGenerationToken: `generation-${catalogId}`,
    }
  }

  function request(ctx: AdapterOperationContext): AdapterPlanRequest {
    return {
      desiredCapability: 4,
      desiredComponents: ['memory_tools', 'lifecycle'],
      observed: {
        catalogId: ctx.installation.hostVariant,
        detected: true,
        distribution: ctx.installation.distribution,
        components: [],
        provenance: [],
        diagnostics: [],
      },
      ownedArtifacts: [],
    }
  }

  function owned(
    ctx: AdapterOperationContext,
    hash: string,
    activation: 'owned' | 'borrowed' = 'owned',
  ): OwnedArtifactBaseline[] {
    const base = `tidemind.aggregate.${ctx.installation.hostVariant}.${ctx.agentId}`
    const ownershipKey = ctx.installation.hostVariant === 'zcode-desktop'
      ? `${base}.activation-${activation}`
      : base
    return (['memory_tools', 'lifecycle'] as const).map(componentKey => ({
      componentKey,
      physicalTarget: configFile(ctx),
      ownershipKey,
      ownedFragmentHash: hash,
      selectorSchemaVersion: 1,
    }))
  }

  function legacyOwnedMemory(
    ctx: AdapterOperationContext,
    fragment: Record<string, unknown>,
  ): OwnedArtifactBaseline {
    const prefix = ctx.installation.hostVariant === 'qwen-code-cli' ? 'mcpServers' : 'mcp.servers'
    return {
      componentKey: 'memory_tools',
      physicalTarget: configFile(ctx),
      ownershipKey: `${prefix}.tidemind-${ctx.agentId}`,
      ownedFragmentHash: sha256Json(fragment),
      selectorSchemaVersion: 1,
    }
  }

  function configFile(ctx: AdapterOperationContext): string {
    return path.join(ctx.installation.canonicalConfigRoot,
      ctx.installation.hostVariant === 'qwen-code-cli' ? 'settings.json' : 'config.json')
  }

  function activity(
    ctx: AdapterOperationContext,
    componentKey: 'memory_tools' | 'lifecycle',
    signalName: 'brain_recall' | 'brain_digest' | 'session_start' | 'pre_compact' | 'post_compact' | 'session_end',
  ): HostActivityEvidenceRecord {
    return {
      id: `activity-${componentKey}`,
      installationId: 'installation-aggregate',
      agentId: ctx.agentId,
      hostVariant: ctx.installation.hostVariant,
      componentKey,
      signalName,
      tideMindVersion: '0.2.92',
      adapterVersion: '2',
      projectionVersion: '1',
      hostVersion: '0.10.0',
      evidenceHash: `evidence-${componentKey}`,
      observedAt: '2026-09-02T00:05:00.000Z',
    }
  }
})
