import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import {
  createOpenCodeV1LifecycleHostAdapter,
  openCodeV1PluginContent,
  openCodeV1PluginTarget,
} from '../../client/electron/agent-integration/hosts/opencode-v1-lifecycle-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type {
  AdapterOperationContext,
  HostActivityEvidenceRecord,
  OwnedArtifactBaseline,
} from '../../client/electron/agent-integration/types'

describe('OpenCode V1 lifecycle Plugin adapter', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v1-lifecycle-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function context(
    hostVariant: 'opencode-v1-cli' | 'opencode-v2-beta-cli' = 'opencode-v1-cli',
    options: { hostVersion?: string; includeFrozenTargets?: boolean } = {},
  ): AdapterOperationContext {
    const configRoot = path.join(root, 'custom-config')
    const instructionRoot = path.join(root, '.agents', 'skills')
    const lifecycleRoot = path.join(root, 'opencode-resources')
    fs.mkdirSync(configRoot, { recursive: true })
    fs.mkdirSync(instructionRoot, { recursive: true })
    fs.mkdirSync(lifecycleRoot, { recursive: true })
    const includeFrozenTargets = options.includeFrozenTargets ?? true
    return {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: root,
        applicationDataDir: path.join(root, 'tide-mind-data'),
        shimPath: path.join(root, 'Tide Mind.app', 'tm-node'),
        mcpServerPath: path.join(root, 'Tide Mind.app', 'mcp-server.cjs'),
        hookScriptPath: path.join(root, 'Tide Mind.app', 'hook-session-start.cjs'),
        preCompactScriptPath: path.join(root, 'Tide Mind.app', 'hook-pre-compact.cjs'),
        postCompactScriptPath: path.join(root, 'Tide Mind.app', 'hook-post-compact.cjs'),
        tideMindVersion: '0.2.92',
        catalogVersion: '1.3.0',
        projectionVersion: '1',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_01JOPENCODEV1',
        productFamilyId: 'opencode',
        hostVariant,
        configRoot,
        componentConfigRoots: includeFrozenTargets
          ? { instruction: instructionRoot, lifecycle: lifecycleRoot }
          : undefined,
        componentConfigFiles: includeFrozenTargets
          ? {
              instruction: path.join(instructionRoot, 'tidemind', 'SKILL.md'),
              memory_tools: path.join(configRoot, 'opencode.jsonc'),
              lifecycle: path.join(lifecycleRoot, 'plugins', hostVariant === 'opencode-v1-cli'
                ? 'tidemind-v1.ts'
                : 'tidemind-v2.ts'),
            }
          : undefined,
        distribution: {
          distributionId: `cli:${hostVariant}`,
          executableRealpath: path.join(root, 'bin', hostVariant === 'opencode-v1-cli' ? 'opencode' : 'opencode2'),
          packageProvenance: hostVariant === 'opencode-v1-cli'
            ? 'npm_metadata:opencode-ai'
            : 'npm_metadata:@opencode-ai/cli',
          capabilityFingerprint: `cli-surface:${hostVariant}`,
        },
      }),
      installationId: 'installation-opencode-v1',
      hostVersion: options.hostVersion === undefined ? '1.8.0' : options.hostVersion,
      agentId: 'eb_opencode_v1',
      operationId: 'operation_opencode_v1',
      activityGenerationToken: 'generation-opencode-v1',
    }
  }

  async function connectPlan(
    ctx: AdapterOperationContext,
    ownedArtifacts: readonly OwnedArtifactBaseline[] = [],
  ) {
    const adapter = createOpenCodeV1LifecycleHostAdapter()
    return adapter.plan(ctx, {
      desiredCapability: 4,
      desiredComponents: ['lifecycle'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts,
    })
  }

  it('uses only frozen component roots and keeps V1/V2 plugin files distinct', async () => {
    const ctx = context()
    const target = path.join(root, 'opencode-resources', 'plugins', 'tidemind-v1.ts')
    expect(openCodeV1PluginTarget(ctx)).toBe(target)
    expect(target).not.toContain(path.join(root, 'custom-config'))

    const plan = await connectPlan(ctx)
    expect(plan.mutations).toEqual([expect.objectContaining({
      componentKey: 'lifecycle',
      physicalTarget: target,
      ownershipKey: 'document',
      operation: 'create',
      reload: 'restart_host',
      commandCategory: 'file_write',
      idempotent: true,
    })])
    expect(() => openCodeV1PluginTarget(context('opencode-v2-beta-cli')))
      .toThrow('opencode_v1_adapter_variant_mismatch')
    await expect(connectPlan(context('opencode-v1-cli', { includeFrozenTargets: false })))
      .rejects.toThrow(/lifecycle_target_not_frozen|lifecycle_root_not_frozen/)
  })

  it('emits official Plugin hooks with exact runtime-version and Agent binding', () => {
    const ctx = context()
    const source = openCodeV1PluginContent(ctx)
    expect(source).toContain('import type { Plugin } from "@opencode-ai/plugin"')
    expect(source).toContain('const EXPECTED_HOST_VERSION = "1.8.0"')
    expect(source).toContain('await client.global.health()')
    expect(source).toContain('health.data.version !== EXPECTED_HOST_VERSION')
    expect(source).toContain('"experimental.chat.system.transform"')
    expect(source).toContain('output.system[0] = [output.system[0], context]')
    expect(source).not.toContain('output.system.push(context)')
    expect(source).toContain('"experimental.session.compacting"')
    expect(source).toContain('"experimental.compaction.autocontinue"')
    expect(source).toContain('"--agent-id", AGENT_ID')
    expect(source).toContain('"--tool", "opencode"')
    expect(source).toContain('"--activity-generation-token", ACTIVITY_GENERATION_TOKEN')
    expect(source).toContain('"--expected-skill-sha256", EXPECTED_SKILL_SHA256')
    expect(source).toContain(JSON.stringify(ctx.installation.componentConfigFiles!.instruction))
    expect(source).not.toContain('opencode2')
    expect(createOpenCodeV1LifecycleHostAdapter().implementationTypes)
      .toEqual({ lifecycle: ['plugin'] })
  })

  it('registers no lifecycle hooks when a shared plugin directory is loaded by another host version', async () => {
    const generated = transpileModule(openCodeV1PluginContent(context()), {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText
    const module = await import(`data:text/javascript;base64,${Buffer.from(generated).toString('base64')}`)
    const plugin = module.default as (input: unknown) => Promise<Record<string, unknown>>

    const guarded = await plugin({
      client: { global: { health: async () => ({ data: { healthy: true, version: '2.0.0-beta.2' } }) } },
    })
    expect(guarded).toEqual({})

    const active = await plugin({
      client: { global: { health: async () => ({ data: { healthy: true, version: '1.8.0' } }) } },
    })
    expect(active).toEqual(expect.objectContaining({
      'experimental.chat.system.transform': expect.any(Function),
      'experimental.session.compacting': expect.any(Function),
      'experimental.compaction.autocontinue': expect.any(Function),
    }))
  })

  it('fails closed when discovery did not freeze a host version', async () => {
    const ctx = { ...context(), hostVersion: undefined }
    expect(() => openCodeV1PluginContent(ctx)).toThrow('opencode_v1_host_version_not_frozen')
    await expect(connectPlan(ctx)).rejects.toThrow('opencode_v1_host_version_not_frozen')
  })

  it('fails closed when the projection generation token was not frozen', async () => {
    const ctx = { ...context(), activityGenerationToken: undefined }
    expect(() => openCodeV1PluginContent(ctx)).toThrow('opencode_v1_activity_generation_not_frozen')
    await expect(connectPlan(ctx)).rejects.toThrow('opencode_v1_activity_generation_not_frozen')
  })

  it('preserves sibling plugins and is idempotent only with exact ownership', async () => {
    const ctx = context()
    const plugins = path.dirname(openCodeV1PluginTarget(ctx))
    const userPlugin = path.join(plugins, 'user-owned.ts')
    fs.mkdirSync(plugins, { recursive: true })
    fs.writeFileSync(userPlugin, 'export default async () => ({})\n')

    const adapter = createOpenCodeV1LifecycleHostAdapter()
    const first = await connectPlan(ctx)
    await adapter.apply(ctx, first.mutations[0])
    expect(fs.readFileSync(userPlugin, 'utf8')).toBe('export default async () => ({})\n')
    expect(await adapter.readBack(ctx, first.mutations[0])).toMatchObject({
      observed: true,
      matchesDesired: true,
      visibility: 'dedicated',
    })

    const owned: OwnedArtifactBaseline = {
      componentKey: 'lifecycle',
      physicalTarget: first.mutations[0].physicalTarget,
      ownershipKey: 'document',
      ownedFragmentHash: first.mutations[0].desiredFragmentHash!,
    }
    expect((await connectPlan(ctx, [owned])).mutations).toEqual([])
  })

  it('fails closed for an unowned target and a post-preview container race', async () => {
    const occupied = context()
    const target = openCodeV1PluginTarget(occupied)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'export const userPlugin = async () => ({})\n')
    const occupiedPlan = await connectPlan(occupied)
    expect(occupiedPlan.mutations).toEqual([])
    expect(occupiedPlan.diagnostics).toContain('target_document_already_exists')

    fs.unlinkSync(target)
    const changedPlan = await connectPlan(occupied)
    fs.writeFileSync(target, 'created after preview\n')
    await expect(createOpenCodeV1LifecycleHostAdapter().apply(occupied, changedPlan.mutations[0]))
      .rejects.toThrow()
    expect(fs.readFileSync(target, 'utf8')).toBe('created after preview\n')
  })

  it('requires manual exact-file cleanup and then disconnects idempotently', async () => {
    const ctx = context()
    const adapter = createOpenCodeV1LifecycleHostAdapter()
    const connected = await connectPlan(ctx)
    await adapter.apply(ctx, connected.mutations[0])
    const owned: OwnedArtifactBaseline = {
      componentKey: 'lifecycle',
      physicalTarget: connected.mutations[0].physicalTarget,
      ownershipKey: 'document',
      ownedFragmentHash: connected.mutations[0].desiredFragmentHash!,
    }
    const disconnect = await adapter.disconnect(ctx, {
      componentKeys: ['lifecycle'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: [owned],
    })
    expect(disconnect.mutations).toEqual([])
    expect(disconnect.requiredUserActions).toContain('manually_remove_owned_document')
    expect(disconnect.diagnostics).toContain('managed_text_manual_cleanup_required')

    fs.unlinkSync(owned.physicalTarget)
    const absent = await adapter.disconnect(ctx, {
      componentKeys: ['lifecycle'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: [owned],
    })
    expect(absent.mutations).toEqual([])
    expect(absent.requiredUserActions).toEqual([])
  })

  it('keeps static plugin presence below C4 until fresh exact-bound lifecycle activity', async () => {
    let ctx = context()
    const adapter = createOpenCodeV1LifecycleHostAdapter()
    const plan = await connectPlan(ctx)
    await adapter.apply(ctx, plan.mutations[0])
    const inspection = await adapter.inspect(ctx)

    expect((await adapter.verify(ctx, {
      componentKeys: ['lifecycle'],
      expectedCapability: 4,
      inspection,
    }))[0]).toMatchObject({
      status: 'unverified',
      verifiedCapability: null,
      diagnostics: ['static_readback_passed', 'host_activity_evidence_reader_unavailable'],
    })

    ctx = {
      ...ctx,
      hostActivityEvidence: {
        find(query) {
          expect(query).toMatchObject({
            installationId: 'installation-opencode-v1',
            agentId: 'eb_opencode_v1',
            hostVariant: 'opencode-v1-cli',
            componentKey: 'lifecycle',
            signalNames: ['session_start', 'pre_compact', 'post_compact'],
            hostVersion: '1.8.0',
          })
          return [activityRecord(ctx, 'session_start')]
        },
      },
    }
    expect((await adapter.verify(ctx, {
      componentKeys: ['lifecycle'],
      expectedCapability: 4,
      inspection,
      activityBinding: {
        installationId: 'installation-opencode-v1',
        tideMindVersion: '0.2.92',
        adapterVersion: '1',
        projectionVersion: '1',
        hostVersion: '1.8.0',
        activationRunId: 'run-current',
        activityGenerationToken: 'generation-opencode-v1',
        activationEpoch: '2026-09-03T00:04:00.000Z',
        observedAfter: '2026-09-03T00:00:00.000Z',
        verifiedAt: '2026-09-03T00:10:00.000Z',
      },
    }))[0]).toMatchObject({
      status: 'unverified',
      verifiedCapability: null,
      diagnostics: ['static_readback_passed', 'fresh_host_activity_evidence_missing'],
    })

    ctx = {
      ...ctx,
      hostActivityEvidence: {
        find: () => (['session_start', 'pre_compact', 'post_compact'] as const)
          .map(signal => activityRecord(ctx, signal)),
      },
    }
    expect((await adapter.verify(ctx, {
      componentKeys: ['lifecycle'],
      expectedCapability: 4,
      inspection,
      activityBinding: {
        installationId: 'installation-opencode-v1',
        tideMindVersion: '0.2.92',
        adapterVersion: '1',
        projectionVersion: '1',
        hostVersion: '1.8.0',
        activationRunId: 'run-current',
        activityGenerationToken: 'generation-opencode-v1',
        activationEpoch: '2026-09-03T00:04:00.000Z',
        observedAfter: '2026-09-03T00:00:00.000Z',
        verifiedAt: '2026-09-03T00:10:00.000Z',
      },
    }))[0]).toMatchObject({
      status: 'verified',
      verifiedCapability: 4,
      identityAssertion: 'eb_opencode_v1',
      diagnostics: ['host_activity_recognized:post_compact,pre_compact,session_start'],
    })
  })

  function activityRecord(
    ctx: AdapterOperationContext,
    signalName: 'session_start' | 'pre_compact' | 'post_compact',
  ): HostActivityEvidenceRecord {
    return {
      id: `activity-opencode-v1-${signalName}`,
      installationId: 'installation-opencode-v1',
      agentId: ctx.agentId,
      hostVariant: 'opencode-v1-cli',
      componentKey: 'lifecycle',
      signalName,
      tideMindVersion: '0.2.92',
      adapterVersion: '1',
      projectionVersion: '1',
      hostVersion: '1.8.0',
      evidenceHash: 'activity-hash',
      observedAt: '2026-09-03T00:05:00.000Z',
    }
  }
})
