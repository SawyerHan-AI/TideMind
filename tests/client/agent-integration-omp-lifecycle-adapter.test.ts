import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createOmpLifecycleHostAdapter,
  OMP_LIFECYCLE_ADAPTER_VERSION,
  ompExtensionContent,
  ompExtensionTarget,
} from '../../client/electron/agent-integration/hosts/omp-lifecycle-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type {
  AdapterOperationContext,
  HostActivityEvidenceRecord,
  OwnedArtifactBaseline,
} from '../../client/electron/agent-integration/types'

describe('OMP unified Extension lifecycle adapter', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-lifecycle-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function context(
    profile = 'default',
    componentConfigFiles?: { instruction?: string; lifecycle?: string },
  ): AdapterOperationContext {
    const configRoot = profile === 'default'
      ? path.join(root, '.omp', 'agent')
      : path.join(root, '.omp', 'profiles', profile, 'agent')
    fs.mkdirSync(configRoot, { recursive: true })
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
        osUserIdentity: 'usr_01JOMPADAPTER',
        productFamilyId: 'omp',
        hostVariant: 'omp-cli',
        configRoot,
        componentConfigFiles,
        explicitProfile: profile,
        distribution: {
          distributionId: 'omp:oh-my-pi',
          executableRealpath: path.join(root, 'bin', 'omp'),
          packageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
          capabilityFingerprint: 'cli-surface:omp',
        },
      }),
      agentId: `eb_omp_${profile}`,
      operationId: `operation_omp_${profile}`,
      activityGenerationToken: `generation_omp_${profile}`,
    }
  }

  async function connectPlan(
    ctx: AdapterOperationContext,
    ownedArtifacts: readonly OwnedArtifactBaseline[] = [],
  ) {
    const adapter = createOmpLifecycleHostAdapter()
    return adapter.plan(ctx, {
      desiredCapability: 4,
      desiredComponents: ['lifecycle'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts,
    })
  }

  it('derives exactly one profile-scoped target from the frozen Installation', async () => {
    const defaultContext = context()
    const workContext = context('work')

    expect(ompExtensionTarget(defaultContext)).toBe(path.join(
      root, '.omp', 'agent', 'extensions', 'tidemind.ts',
    ))
    expect(ompExtensionTarget(workContext)).toBe(path.join(
      root, '.omp', 'profiles', 'work', 'agent', 'extensions', 'tidemind.ts',
    ))
    expect(defaultContext.installation.installKey).not.toBe(workContext.installation.installKey)

    const plan = await connectPlan(workContext)
    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      componentKey: 'lifecycle',
      physicalTarget: ompExtensionTarget(workContext),
      ownershipKey: 'document',
      operation: 'create',
      reload: 'restart_host',
      commandCategory: 'file_write',
      idempotent: true,
    })
    expect(plan.mutations[0].physicalTarget).not.toContain('/agent/extensions/tidemind.ts/')
  })

  it('honors frozen component paths and emits a unified Extension, never a legacy Hook', async () => {
    const configRoot = path.join(root, '.omp', 'profiles', 'work', 'agent')
    const lifecycle = path.join(configRoot, 'extensions', 'tide-mind-managed.ts')
    const instruction = path.join(configRoot, 'skills', 'managed-tidemind', 'SKILL.md')
    const ctx = context('work', { lifecycle, instruction })
    const adapter = createOmpLifecycleHostAdapter()
    const source = ompExtensionContent(ctx)

    expect(ompExtensionTarget(ctx)).toBe(lifecycle)
    expect(adapter.implementationTypes).toEqual({ lifecycle: ['plugin'] })
    expect(source).toContain('ExtensionAPI')
    expect(source).not.toContain('HookAPI')
    expect(source).toContain('pi.on("session_start"')
    expect(source).toContain('pi.on("session_switch"')
    expect(source).toContain('pi.on("session_before_compact"')
    expect(source).toContain('pi.on("session.compacting"')
    expect(source).toContain('pi.on("session_compact"')
    expect(source).toContain('pi.on("session_shutdown"')
    expect(source).toContain('hook-session-end.cjs')
    expect(source).toContain('await endSession(1_500)')
    expect(source).toContain(JSON.stringify(instruction))
    expect(source).toContain('"--tool", "omp"')
    expect(source).toContain('const PROFILE = "work"')
    expect(source).toContain('deliverAs: "nextTurn"')
  })

  it('executes in-process session switches and contributes pre-compact context exactly once', async () => {
    const generated = transpileModule(ompExtensionContent(context('work')), {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText
    const module = { exports: {} as Record<string, unknown> }
    const load = new Function('require', 'module', 'exports', generated)
    load(() => {
      throw new Error('The generated OMP extension must not have runtime imports')
    }, module, module.exports)

    const handlers = new Map<string, () => Promise<unknown>>()
    const executions: Array<{ command: string; args: string[]; timeout?: number }> = []
    const messages: Array<{ content: string; deliverAs?: string }> = []
    const register = (module.exports as {
      default: (pi: {
        setLabel(label: string): void
        on(event: string, handler: () => Promise<unknown>): void
        exec(command: string, args: string[], options?: { timeout?: number }): Promise<{ code: number; stdout: string }>
        logger: { warn(): void }
        sendMessage(message: { content: string }, options?: { deliverAs?: string }): void
      }) => void
    }).default
    register({
      setLabel: () => {},
      on: (event, handler) => handlers.set(event, handler),
      exec: async (command, args, options) => {
        executions.push({ command, args, timeout: options?.timeout })
        const script = path.basename(args[0] ?? '')
        return {
          code: 0,
          stdout: script === 'hook-session-start.cjs'
            ? 'fresh context\n'
            : script === 'hook-pre-compact.cjs'
              ? 'pre-compact preservation context\n'
              : '',
        }
      },
      logger: { warn: () => {} },
      sendMessage: (message, options) => messages.push({
        content: message.content,
        deliverAs: options?.deliverAs,
      }),
    })

    await handlers.get('session_switch')!()

    expect(executions.map(item => path.basename(item.args[0]))).toEqual([
      'hook-session-end.cjs',
      'hook-session-start.cjs',
    ])
    expect(executions.every(item => item.args.includes('omp'))).toBe(true)
    expect(messages).toEqual([{ content: 'fresh context', deliverAs: 'nextTurn' }])

    executions.length = 0
    await handlers.get('session_before_compact')!()
    const firstCompacting = await handlers.get('session.compacting')!()
    const repeatedCompacting = await handlers.get('session.compacting')!()

    expect(executions.map(item => path.basename(item.args[0]))).toEqual([
      'hook-pre-compact.cjs',
    ])
    expect(firstCompacting).toEqual({ context: ['pre-compact preservation context'] })
    expect(repeatedCompacting).toBeUndefined()

    executions.length = 0
    await handlers.get('session_shutdown')!()
    expect(executions).toEqual([expect.objectContaining({ timeout: 1_500 })])
  })

  it('creates with CAS, preserves sibling user Extensions, and is idempotent with exact ownership', async () => {
    const ctx = context('work')
    const extensions = path.join(ctx.installation.canonicalConfigRoot, 'extensions')
    const userExtension = path.join(extensions, 'user-owned.ts')
    fs.mkdirSync(extensions, { recursive: true })
    fs.writeFileSync(userExtension, 'export default () => {}\n')

    const adapter = createOmpLifecycleHostAdapter()
    const first = await connectPlan(ctx)
    await adapter.apply(ctx, first.mutations[0])
    expect(fs.readFileSync(userExtension, 'utf8')).toBe('export default () => {}\n')
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
    const second = await connectPlan(ctx, [owned])
    expect(second.mutations).toEqual([])
    expect(second.diagnostics).toEqual([])
  })

  it('fails closed for an unowned target and for a container changed after preview', async () => {
    const occupied = context('occupied')
    const target = ompExtensionTarget(occupied)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'export default function userExtension() {}\n')

    const occupiedPlan = await connectPlan(occupied)
    expect(occupiedPlan.mutations).toEqual([])
    expect(occupiedPlan.diagnostics).toContain('target_document_already_exists')
    expect(fs.readFileSync(target, 'utf8')).toBe('export default function userExtension() {}\n')

    const changed = context('changed')
    const changedPlan = await connectPlan(changed)
    const changedTarget = changedPlan.mutations[0].physicalTarget
    fs.mkdirSync(path.dirname(changedTarget), { recursive: true })
    fs.writeFileSync(changedTarget, 'created after frozen preview\n')
    await expect(createOmpLifecycleHostAdapter().apply(changed, changedPlan.mutations[0]))
      .rejects.toThrow()
    expect(fs.readFileSync(changedTarget, 'utf8')).toBe('created after frozen preview\n')
  })

  it('disconnects idempotently without unsafe automatic whole-file deletion', async () => {
    const ctx = context()
    const adapter = createOmpLifecycleHostAdapter()
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
    expect(fs.existsSync(owned.physicalTarget)).toBe(true)

    fs.unlinkSync(owned.physicalTarget)
    const alreadyAbsent = await adapter.disconnect(ctx, {
      componentKeys: ['lifecycle'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: [owned],
    })
    expect(alreadyAbsent.mutations).toEqual([])
    expect(alreadyAbsent.requiredUserActions).toEqual([])
    expect(alreadyAbsent.diagnostics).toEqual([])
  })

  it('keeps static read-back unverified and reaches C4 only with fresh unified Extension activity', async () => {
    let ctx = context('verified')
    const adapter = createOmpLifecycleHostAdapter()
    const plan = await connectPlan(ctx)
    await adapter.apply(ctx, plan.mutations[0])
    const inspection = await adapter.inspect(ctx)

    const staticOnly = await adapter.verify(ctx, {
      componentKeys: ['lifecycle'],
      expectedCapability: 4,
      inspection,
    })
    expect(staticOnly[0]).toMatchObject({
      status: 'unverified',
      verifiedCapability: null,
      diagnostics: ['static_readback_passed', 'host_activity_evidence_reader_unavailable'],
    })

    ctx = {
      ...ctx,
      hostActivityEvidence: {
        find(query) {
          expect(query).toMatchObject({
            installationId: 'installation-omp-work',
            agentId: 'eb_omp_verified',
            hostVariant: 'omp-cli',
            componentKey: 'lifecycle',
            signalNames: ['session_start', 'pre_compact', 'post_compact', 'session_end'],
          })
          return [activityRecord(ctx, 'session_start')]
        },
      },
    }
    const incomplete = await adapter.verify(ctx, {
      componentKeys: ['lifecycle'],
      expectedCapability: 4,
      inspection,
      activityBinding: {
        installationId: 'installation-omp-work',
        tideMindVersion: '0.2.92',
        adapterVersion: OMP_LIFECYCLE_ADAPTER_VERSION,
        projectionVersion: '1',
        hostVersion: '17.0.4',
        activationRunId: 'run-omp-work',
        activityGenerationToken: 'generation_omp_verified',
        observedAfter: '2026-09-02T00:00:00.000Z',
        verifiedAt: '2026-09-02T00:10:00.000Z',
      },
    })
    expect(incomplete[0]).toMatchObject({
      status: 'unverified',
      verifiedCapability: null,
      diagnostics: ['static_readback_passed', 'fresh_host_activity_evidence_missing'],
    })

    ctx = {
      ...ctx,
      hostActivityEvidence: {
        find: () => (['session_start', 'pre_compact', 'post_compact', 'session_end'] as const)
          .map(signal => activityRecord(ctx, signal)),
      },
    }
    const verified = await adapter.verify(ctx, {
      componentKeys: ['lifecycle'],
      expectedCapability: 4,
      inspection,
      activityBinding: {
        installationId: 'installation-omp-work',
        tideMindVersion: '0.2.92',
        adapterVersion: OMP_LIFECYCLE_ADAPTER_VERSION,
        projectionVersion: '1',
        hostVersion: '17.0.4',
        activationRunId: 'run-omp-work',
        activityGenerationToken: 'generation_omp_verified',
        observedAfter: '2026-09-02T00:00:00.000Z',
        verifiedAt: '2026-09-02T00:10:00.000Z',
      },
    })
    expect(verified[0]).toMatchObject({
      status: 'verified',
      verifiedCapability: 4,
      identityAssertion: 'eb_omp_verified',
      diagnostics: ['host_activity_recognized:post_compact,pre_compact,session_end,session_start'],
    })
  })

  it.each(['session_start', 'pre_compact', 'post_compact', 'session_end'] as const)(
    'does not verify OMP C4 when %s evidence is missing',
    async (missingSignal) => {
      let ctx = context('verified')
      const adapter = createOmpLifecycleHostAdapter()
      const plan = await connectPlan(ctx)
      await adapter.apply(ctx, plan.mutations[0])
      ctx = {
        ...ctx,
        hostActivityEvidence: {
          find: () => (['session_start', 'pre_compact', 'post_compact', 'session_end'] as const)
            .filter(signal => signal !== missingSignal)
            .map(signal => activityRecord(ctx, signal)),
        },
      }
      const result = await adapter.verify(ctx, {
        componentKeys: ['lifecycle'],
        expectedCapability: 4,
        inspection: await adapter.inspect(ctx),
        activityBinding: {
          installationId: 'installation-omp-work',
          tideMindVersion: '0.2.92',
          adapterVersion: OMP_LIFECYCLE_ADAPTER_VERSION,
          projectionVersion: '1',
          hostVersion: '17.0.4',
          activationRunId: 'run-omp-work',
          activityGenerationToken: 'generation_omp_verified',
          observedAfter: '2026-09-02T00:00:00.000Z',
          verifiedAt: '2026-09-02T00:10:00.000Z',
        },
      })
      expect(result[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })
    },
  )

  function activityRecord(
    ctx: AdapterOperationContext,
    signalName: 'session_start' | 'pre_compact' | 'post_compact' | 'session_end',
  ): HostActivityEvidenceRecord {
    return {
      id: `activity-omp-${signalName}`,
      installationId: 'installation-omp-work',
      agentId: ctx.agentId,
      hostVariant: 'omp-cli',
      componentKey: 'lifecycle',
      signalName,
      tideMindVersion: '0.2.92',
      adapterVersion: OMP_LIFECYCLE_ADAPTER_VERSION,
      projectionVersion: '1',
      hostVersion: '17.0.4',
      evidenceHash: 'activity-hash',
      observedAt: '2026-09-02T00:05:00.000Z',
    }
  }
})
