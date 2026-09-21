import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createQwenCodeLifecycleHookAdapter,
  createZCodeDesktopLifecycleHookAdapter,
  JsonLifecycleHookConflictError,
} from '../../client/electron/agent-integration/hosts/json-lifecycle-hook-adapter'
import { PORTABLE_TIDEMIND_SKILL_SHA256 } from '../../client/electron/agent-integration/hosts/portable-skill'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type {
  AdapterOperationContext,
  AdapterPlanRequest,
  CatalogId,
  HostActivityEvidenceRecord,
} from '../../client/electron/agent-integration/types'

describe('managed JSON lifecycle Hook adapters', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'json-lifecycle-hook-adapter-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
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
      agentId: catalogId === 'qwen-code-cli' ? 'eb_qwen_1234' : 'eb_zcode_1234',
      operationId: `run-${catalogId}`,
      activityGenerationToken: `generation-${catalogId}`,
    }
  }

  function request(context: AdapterOperationContext, ownedFragmentHash?: string): AdapterPlanRequest {
    return {
      desiredCapability: 4,
      desiredComponents: ['lifecycle'],
      observed: {
        catalogId: context.installation.hostVariant,
        detected: true,
        distribution: context.installation.distribution,
        components: [],
        provenance: [],
        diagnostics: [],
      },
      ownedArtifacts: ownedFragmentHash === undefined ? [] : [{
        componentKey: 'lifecycle',
        physicalTarget: configFile(context),
        ownershipKey: ownershipKey(context),
        ownedFragmentHash,
      }],
    }
  }

  it('writes all current Qwen lifecycle events and preserves unrelated hooks', async () => {
    const ctx = context('qwen-code-cli')
    const target = configFile(ctx)
    fs.writeFileSync(target, JSON.stringify({
      theme: 'GitHub',
      hooks: {
        SessionStart: [{
          matcher: 'startup',
          hooks: [{ type: 'command', command: 'echo user-hook', name: 'user-hook' }],
        }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo check' }] }],
      },
    }))
    const host = createQwenCodeLifecycleHookAdapter()
    const plan = await host.plan(ctx, request(ctx))

    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      componentKey: 'lifecycle',
      operation: 'create',
      ownershipKey: 'hooks.tidemind-eb_qwen_1234',
      reload: 'new_session',
    })
    await host.apply(ctx, plan.mutations[0])

    const document = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(document.theme).toBe('GitHub')
    expect(document.hooks.PreToolUse).toHaveLength(1)
    expect(document.hooks.SessionStart).toHaveLength(2)
    expect(document.hooks.SessionStart[0].hooks[0].name).toBe('user-hook')
    expect(document.hooks.SessionStart[1]).toMatchObject({ matcher: 'startup|resume|clear|compact' })
    expect(document.hooks.SessionStart[1].hooks[0]).toMatchObject({
      type: 'command',
      name: 'tidemind-eb_qwen_1234-session-start',
      timeout: 60_000,
    })
    expect(document.hooks.SessionStart[1].hooks[0].command).toContain("'--tool' 'qwen-code'")
    expect(document.hooks.SessionStart[1].hooks[0].command).toContain(
      "'--skill-path' '" + path.join(root, '.qwen', 'skills', 'tidemind', 'SKILL.md') + "'",
    )
    expect(document.hooks.PreCompact[0]).toMatchObject({ matcher: 'manual|auto' })
    expect(document.hooks.PreCompact[0].hooks[0].name).toBe('tidemind-eb_qwen_1234-pre-compact')
    expect(document.hooks.SessionEnd[0]).toMatchObject({
      matcher: 'clear|logout|prompt_input_exit|bypass_permissions_disabled|other',
    })
    expect(document.hooks.SessionEnd[0].hooks[0].name).toBe('tidemind-eb_qwen_1234-session-end')
    expect(document.hooks.SessionEnd[0].hooks[0].command).toContain('hook-session-end.cjs')
    expect(await host.readBack(ctx, plan.mutations[0])).toMatchObject({
      observed: true,
      matchesDesired: true,
      visibility: 'dedicated',
    })
  })

  it('uses the official ZCode user config/process schema and enables user hooks', async () => {
    const ctx = context('zcode-desktop')
    const target = configFile(ctx)
    fs.writeFileSync(target, JSON.stringify({
      model: 'glm',
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'process', command: '/usr/bin/true' }] }],
        },
      },
    }))
    const host = createZCodeDesktopLifecycleHookAdapter()
    const plan = await host.plan(ctx, request(ctx))
    await host.apply(ctx, plan.mutations[0])

    const document = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(document.model).toBe('glm')
    expect(document.hooks.enabled).toBe(true)
    expect(document.hooks.events.PreToolUse).toHaveLength(1)
    expect(document.hooks.events.SessionStart).toEqual([{
      matcher: 'startup|resume|clear|compact',
      hooks: [{
        type: 'process',
        command: ctx.runtime.shimPath,
        args: [
          ctx.runtime.hookScriptPath,
          '--agent-id', 'eb_zcode_1234',
          '--skill-path', path.join(root, '.zcode', 'skills', 'tidemind', 'SKILL.md'),
          '--expected-skill-sha256', PORTABLE_TIDEMIND_SKILL_SHA256,
          '--tool', 'zcode',
          '--activity-generation-token', 'generation-zcode-desktop',
        ],
        enabled: true,
        timeoutMs: 60_000,
      }],
    }])
    expect(await host.readBack(ctx, plan.mutations[0])).toMatchObject({
      observed: true,
      matchesDesired: true,
      visibility: 'dedicated',
    })
  })

  it('does not activate dormant unrelated ZCode hooks without explicit user confirmation', async () => {
    const ctx = context('zcode-desktop')
    fs.writeFileSync(configFile(ctx), JSON.stringify({
      hooks: {
        events: {
          PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'process', command: '/tmp/user-hook' }] }],
        },
      },
    }))
    const plan = await createZCodeDesktopLifecycleHookAdapter().plan(ctx, request(ctx))

    expect(plan.mutations).toEqual([])
    expect(plan.requiredUserActions).toContain('confirm_enable_existing_zcode_hooks')
    expect(plan.diagnostics).toContain('shared_host_hook_enablement_requires_confirmation')
    expect(JSON.parse(fs.readFileSync(configFile(ctx), 'utf8')).hooks.enabled).toBeUndefined()
  })

  it('enables ZCode hooks automatically when no unrelated dormant hook would be activated', async () => {
    const ctx = context('zcode-desktop')
    const host = createZCodeDesktopLifecycleHookAdapter()
    const plan = await host.plan(ctx, request(ctx))
    expect(plan.mutations).toHaveLength(1)
    await host.apply(ctx, plan.mutations[0])
    expect(JSON.parse(fs.readFileSync(configFile(ctx), 'utf8')).hooks.enabled).toBe(true)
  })

  it('respects an explicit host-wide hook disable instead of overriding it', async () => {
    const qwen = context('qwen-code-cli')
    fs.writeFileSync(configFile(qwen), JSON.stringify({ disableAllHooks: true }))
    const qwenPlan = await createQwenCodeLifecycleHookAdapter().plan(qwen, request(qwen))
    expect(qwenPlan.mutations).toEqual([])
    expect(qwenPlan.diagnostics).toContain('host_hooks_explicitly_disabled')

    const zcode = context('zcode-desktop')
    fs.writeFileSync(configFile(zcode), JSON.stringify({ hooks: { enabled: false, events: {} } }))
    const zcodePlan = await createZCodeDesktopLifecycleHookAdapter().plan(zcode, request(zcode))
    expect(zcodePlan.mutations).toEqual([])
    expect(zcodePlan.diagnostics).toContain('host_hooks_explicitly_disabled')
  })

  it('fails closed on an exact but unowned fragment and exposes exact adoption evidence', async () => {
    const ctx = context('qwen-code-cli')
    const host = createQwenCodeLifecycleHookAdapter()
    const first = await host.plan(ctx, request(ctx))
    await host.apply(ctx, first.mutations[0])

    const second = await host.plan(ctx, request(ctx))
    expect(second.mutations).toEqual([])
    expect(second.diagnostics).toContain('matching_selector_has_no_ownership_evidence')
    expect(await host.inspectAdoptableArtifacts?.(ctx)).toEqual([
      expect.objectContaining({
        componentKey: 'lifecycle',
        artifactType: 'hook',
        ownershipKey: 'hooks.tidemind-eb_qwen_1234',
        fragmentHash: first.mutations[0].desiredFragmentHash,
        identityAssertion: 'eb_qwen_1234',
      }),
    ])
  })

  it('uses container CAS and refuses an uncoordinated edit after planning', async () => {
    const ctx = context('zcode-desktop')
    const host = createZCodeDesktopLifecycleHookAdapter()
    const plan = await host.plan(ctx, request(ctx))
    fs.writeFileSync(configFile(ctx), JSON.stringify({ userChanged: true }))

    await expect(host.apply(ctx, plan.mutations[0])).rejects.toThrow(
      new JsonLifecycleHookConflictError('container_precondition_changed'),
    )
    expect(JSON.parse(fs.readFileSync(configFile(ctx), 'utf8'))).toEqual({ userChanged: true })
  })

  it('disconnects only the exact owned entries and retains shared ZCode enablement', async () => {
    const ctx = context('zcode-desktop')
    const target = configFile(ctx)
    fs.writeFileSync(target, JSON.stringify({
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ matcher: 'startup', hooks: [{ type: 'process', command: '/usr/bin/true' }] }],
        },
      },
    }))
    const host = createZCodeDesktopLifecycleHookAdapter()
    const connect = await host.plan(ctx, request(ctx))
    await host.apply(ctx, connect.mutations[0])
    const ownedHash = connect.mutations[0].desiredFragmentHash!

    const disconnect = await host.disconnect(ctx, {
      componentKeys: ['lifecycle'],
      observed: await host.inspect(ctx),
      ownedArtifacts: request(ctx, ownedHash).ownedArtifacts,
    })
    expect(disconnect.mutations[0]).toMatchObject({ operation: 'remove', preconditionHash: ownedHash })
    await host.apply(ctx, disconnect.mutations[0])

    const document = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(document.hooks.enabled).toBe(true)
    expect(document.hooks.events.SessionStart).toEqual([
      { matcher: 'startup', hooks: [{ type: 'process', command: '/usr/bin/true' }] },
    ])
    expect(await host.readBack(ctx, disconnect.mutations[0])).toMatchObject({
      observed: false,
      matchesDesired: true,
      visibility: 'absent',
    })
  })

  it('never upgrades static read-back to verified, but accepts fresh real host activity', async () => {
    let ctx = context('qwen-code-cli')
    const host = createQwenCodeLifecycleHookAdapter()
    const plan = await host.plan(ctx, request(ctx))
    await host.apply(ctx, plan.mutations[0])
    const inspection = await host.inspect(ctx)

    const staticOnly = await host.verify(ctx, {
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
          expect(query.signalNames).toEqual(['session_start', 'pre_compact', 'session_end'])
          return [activityRecord(ctx.installation.hostVariant, ctx.agentId, 'session_start')]
        },
      },
    }
    const incomplete = await host.verify(ctx, {
      componentKeys: ['lifecycle'],
      expectedCapability: 4,
      inspection,
      activityBinding: {
        installationId: 'installation-qwen',
        tideMindVersion: '0.2.92',
        adapterVersion: '1',
        projectionVersion: '1',
        hostVersion: '0.10.0',
        activationRunId: 'run-qwen-code-cli',
        activityGenerationToken: 'generation-qwen-code-cli',
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
        find: query => {
          expect(query).toMatchObject({
            activationRunId: 'run-qwen-code-cli',
            activityGenerationToken: 'generation-qwen-code-cli',
          })
          return (['session_start', 'pre_compact', 'session_end'] as const)
            .map(signal => activityRecord(ctx.installation.hostVariant, ctx.agentId, signal))
        },
      },
    }
    const verified = await host.verify(ctx, {
      componentKeys: ['lifecycle'],
      expectedCapability: 4,
      inspection,
      activityBinding: {
        installationId: 'installation-qwen',
        tideMindVersion: '0.2.92',
        adapterVersion: '1',
        projectionVersion: '1',
        hostVersion: '0.10.0',
        activationRunId: 'run-qwen-code-cli',
        activityGenerationToken: 'generation-qwen-code-cli',
        observedAfter: '2026-09-02T00:00:00.000Z',
        verifiedAt: '2026-09-02T00:10:00.000Z',
      },
    })
    expect(verified[0]).toMatchObject({
      status: 'verified',
      verifiedCapability: 4,
      identityAssertion: 'eb_qwen_1234',
      diagnostics: ['host_activity_recognized:pre_compact,session_end,session_start'],
    })
  })

  it.each(['session_start', 'pre_compact', 'session_end'] as const)(
    'does not verify Qwen C4 when %s evidence is missing',
    async (missingSignal) => {
      let ctx = context('qwen-code-cli')
      const host = createQwenCodeLifecycleHookAdapter()
      const plan = await host.plan(ctx, request(ctx))
      await host.apply(ctx, plan.mutations[0])
      const signals = (['session_start', 'pre_compact', 'session_end'] as const)
        .filter(signal => signal !== missingSignal)
      ctx = {
        ...ctx,
        hostActivityEvidence: {
          find: () => signals.map(signal => activityRecord(ctx.installation.hostVariant, ctx.agentId, signal)),
        },
      }

      const result = await host.verify(ctx, {
        componentKeys: ['lifecycle'],
        expectedCapability: 4,
        inspection: await host.inspect(ctx),
        activityBinding: {
          installationId: 'installation-qwen',
          tideMindVersion: '0.2.92',
          adapterVersion: '1',
          projectionVersion: '1',
          hostVersion: '0.10.0',
          activationRunId: 'run-qwen-code-cli',
          activityGenerationToken: 'generation-qwen-code-cli',
          observedAfter: '2026-09-02T00:00:00.000Z',
          verifiedAt: '2026-09-02T00:10:00.000Z',
        },
      })
      expect(result[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })
    },
  )

  function configFile(ctx: AdapterOperationContext): string {
    return path.join(ctx.installation.canonicalConfigRoot,
      ctx.installation.hostVariant === 'qwen-code-cli' ? 'settings.json' : 'config.json')
  }

  function ownershipKey(ctx: AdapterOperationContext): string {
    const root = ctx.installation.hostVariant === 'qwen-code-cli' ? 'hooks' : 'hooks.events'
    return `${root}.tidemind-${ctx.agentId}`
  }

  function activityRecord(
    hostVariant: CatalogId,
    agentId: string,
    signalName: 'session_start' | 'pre_compact' | 'post_compact' | 'session_end',
  ): HostActivityEvidenceRecord {
    return {
      id: `activity-${signalName}`,
      installationId: 'installation-qwen',
      agentId,
      hostVariant,
      componentKey: 'lifecycle',
      signalName,
      tideMindVersion: '0.2.92',
      adapterVersion: '1',
      projectionVersion: '1',
      hostVersion: '0.10.0',
      evidenceHash: 'evidence-hash',
      observedAt: '2026-09-02T00:05:00.000Z',
    }
  }
})
