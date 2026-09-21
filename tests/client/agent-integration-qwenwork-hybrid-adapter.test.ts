import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { sha256Bytes } from '../../client/electron/agent-integration/fingerprint'
import { createQwenWorkHybridHostAdapter } from '../../client/electron/agent-integration/hosts/qwenwork-hybrid-adapter'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { AGENT_INTEGRATION_RELEASE_ENTRIES } from '../../client/electron/agent-integration/release-manifest'
import type {
  AdapterOperationContext,
  AdapterPlanRequest,
  HostActivityEvidenceRecord,
  OwnedArtifactBaseline,
} from '../../client/electron/agent-integration/types'

const SKILL = `---
name: tidemind
description: Tide Mind memory
---

# Tide Mind

Use brain_recall when prior context matters.
`

describe('QwenWork Desktop hybrid Adapter', () => {
  let home: string
  let context: AdapterOperationContext

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qwenwork-hybrid-'))
    const instructionRoot = path.join(home, '.qwenworkcn')
    const lifecycleRoot = instructionRoot
    fs.mkdirSync(instructionRoot)
    context = {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: home,
        applicationDataDir: path.join(home, 'app-data'),
        shimPath: "/Applications/Tide Mind's.app/Contents/Resources/tm-node",
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
        productFamilyId: 'qwenwork',
        hostVariant: 'qwenwork-desktop',
        configRoot: lifecycleRoot,
        componentConfigRoots: {
          instruction: instructionRoot,
          lifecycle: lifecycleRoot,
        },
        distribution: {
          distributionId: 'cn.qwenwork.desktop.mac',
          executableRealpath: '/Applications/QwenWorkCN.app/Contents/MacOS/QwenWorkCN',
          packageProvenance: 'signed_app:cn.qwenwork.desktop.mac:XN6U3EV979',
          capabilityFingerprint: 'signed-release-fingerprint',
        },
      }),
      installationId: 'installation-qwenwork',
      hostVersion: '3.2.1',
      agentId: 'eb_qwenwork_1234',
      operationId: 'run-qwenwork',
      activityGenerationToken: 'generation-qwenwork-1234',
    }
  })

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  const host = () => createQwenWorkHybridHostAdapter({ adapterVersion: '1', skillContent: SKILL })

  it('is registered with the exact released hybrid component surface', () => {
    expect(AGENT_INTEGRATION_RELEASE_ENTRIES).toContainEqual(expect.objectContaining({
      catalogId: 'qwenwork-desktop',
      targetCapability: 4,
      requiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      enabledByDefault: true,
    }))
    const registered = createP0HostAdapters().get('qwenwork-desktop')
    expect(registered).toBeDefined()
    expect(registered?.componentKeys).toEqual(['instruction', 'memory_tools', 'lifecycle'])
    expect(registered?.implementationTypes).toEqual({
      instruction: ['skill'],
      memory_tools: ['mcp'],
      lifecycle: ['hook'],
    })
  })

  async function request(
    componentKeys: AdapterPlanRequest['desiredComponents'],
    ownedArtifacts: readonly OwnedArtifactBaseline[] = [],
  ): Promise<AdapterPlanRequest> {
    const observed = await host().inspect(context)
    return {
      desiredCapability: 4,
      desiredComponents: componentKeys,
      observed,
      ownedArtifacts,
    }
  }

  it('uses the discovery-frozen shared root and never reads process home for targets', async () => {
    const adapter = host()
    const prepared = await adapter.plan(context, await request(['instruction', 'lifecycle']))

    expect(prepared.mutations).toHaveLength(2)
    expect(prepared.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        componentKey: 'instruction',
        physicalTarget: path.join(home, '.qwenworkcn', 'skills', 'tidemind', 'SKILL.md'),
      }),
      expect.objectContaining({
        componentKey: 'lifecycle',
        physicalTarget: path.join(home, '.qwenworkcn', 'settings.json'),
        ownershipKey: 'hooks.tidemind-eb_qwenwork_1234',
        reload: 'restart_host',
      }),
    ]))
    for (const mutation of prepared.mutations) await adapter.apply(context, mutation)

    expect(fs.readFileSync(path.join(home, '.qwenworkcn', 'skills', 'tidemind', 'SKILL.md'), 'utf8')).toBe(SKILL)
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.qwenworkcn', 'settings.json'), 'utf8'))
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.SessionStart[0]).toMatchObject({ matcher: 'startup|resume|clear|new|compact' })
    expect(settings.hooks.SessionStart[0].hooks[0]).toMatchObject({ type: 'command', timeout: 60 })
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("'--tool' 'qwenwork'")
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('hook-qwenwork-lifecycle.cjs')
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("'--event' 'SessionStart'")
    expect(settings.hooks.SessionStart[0].hooks[0].command).toMatch(/'--skill-sha256' '[a-f0-9]{64}'/u)
    const frozenSkillHash = settings.hooks.SessionStart[0].hooks[0].command
      .match(/'--skill-sha256' '([a-f0-9]{64})'/u)?.[1]
    expect(frozenSkillHash).toBe(sha256Bytes(fs.readFileSync(
      path.join(home, '.qwenworkcn', 'skills', 'tidemind', 'SKILL.md'),
      'utf8',
    )))
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("'--activity-generation-token' 'generation-qwenwork-1234'")
    expect(settings.hooks.SessionStart[0].hooks[0].command).not.toContain('/dev/null')
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("Tide Mind'\\''s.app")
    expect(settings.hooks.PreCompact[0]).toMatchObject({ matcher: 'manual|auto' })
    expect(settings.hooks.PreCompact[0].hooks[0].command).toContain('hook-qwenwork-lifecycle.cjs')
    expect(settings.hooks.PreCompact[0].hooks[0].command).toContain("'--event' 'PreCompact'")
    expect(settings.hooks.SessionEnd[0]).toMatchObject({
      matcher: 'clear|resume|logout|prompt_input_exit|bypass_permissions_disabled|other',
    })
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain('hook-qwenwork-lifecycle.cjs')
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain("'--event' 'SessionEnd'")
    for (const event of ['SessionStart', 'PreCompact', 'SessionEnd'] as const) {
      const command = settings.hooks[event][0].hooks[0].command as string
      expect(command.match(/--activity-generation-token/gu)).toHaveLength(1)
      expect(command.match(/generation-qwenwork-1234/gu)).toHaveLength(1)
    }
  })

  it('preserves user hooks, uses container CAS, and removes only its exact lifecycle selector', async () => {
    const adapter = host()
    const target = path.join(home, '.qwenworkcn', 'settings.json')
    fs.writeFileSync(target, JSON.stringify({
      theme: 'light',
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/usr/bin/true' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/check' }] }],
      },
    }))
    const connect = await adapter.plan(context, await request(['lifecycle']))
    fs.writeFileSync(target, JSON.stringify({ concurrentUserChange: true }))
    await expect(adapter.apply(context, connect.mutations[0])).rejects.toThrow('container_precondition_changed')

    fs.writeFileSync(target, JSON.stringify({
      theme: 'light',
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/usr/bin/true' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/check' }] }],
      },
    }))
    const fresh = await adapter.plan(context, await request(['lifecycle']))
    await adapter.apply(context, fresh.mutations[0])
    const ownedHash = fresh.mutations[0].desiredFragmentHash!
    const disconnect = await adapter.disconnect(context, {
      componentKeys: ['lifecycle'],
      observed: await adapter.inspect(context),
      ownedArtifacts: [{
        componentKey: 'lifecycle',
        physicalTarget: target,
        ownershipKey: 'hooks.tidemind-eb_qwenwork_1234',
        ownedFragmentHash: ownedHash,
      }],
    })
    expect(disconnect.mutations).toHaveLength(1)
    await adapter.apply(context, disconnect.mutations[0])
    const after = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(after.theme).toBe('light')
    expect(after.hooks.SessionStart).toEqual([
      { matcher: 'startup', hooks: [{ type: 'command', command: '/usr/bin/true' }] },
    ])
    expect(after.hooks.PreToolUse).toHaveLength(1)
  })

  it('accepts QwenWork JSONC and preserves comments and trailing commas', async () => {
    const adapter = host()
    const target = path.join(home, '.qwenworkcn', 'settings.json')
    fs.writeFileSync(target, `{
  // Existing user preference must survive Tide Mind hook maintenance.
  "theme": "light",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "/usr/bin/check" }] },
    ],
  },
}\n`)

    const connect = await adapter.plan(context, await request(['lifecycle']))
    expect(connect.mutations).toHaveLength(1)
    await adapter.apply(context, connect.mutations[0])

    const after = fs.readFileSync(target, 'utf8')
    expect(after).toContain('// Existing user preference must survive Tide Mind hook maintenance.')
    expect(after).toContain('"theme": "light"')
    expect(after).toMatch(/"PreToolUse"[\s\S]*\/usr\/bin\/check/u)
    expect(after).toContain('"command": "/usr/bin/check" }] },\n    ],')
    const inspection = await adapter.inspect(context)
    expect(inspection.diagnostics).not.toContain(expect.stringContaining('malformed'))
    expect(inspection.components.find(component => component.componentKey === 'lifecycle')?.visibility)
      .toBe('dedicated')

    const disconnect = await adapter.disconnect(context, {
      componentKeys: ['lifecycle'],
      observed: inspection,
      ownedArtifacts: [{
        componentKey: 'lifecycle',
        physicalTarget: target,
        ownershipKey: 'hooks.tidemind-eb_qwenwork_1234',
        ownedFragmentHash: connect.mutations[0].desiredFragmentHash!,
      }],
    })
    await adapter.apply(context, disconnect.mutations[0])
    const removed = fs.readFileSync(target, 'utf8')
    expect(removed).toContain('// Existing user preference must survive Tide Mind hook maintenance.')
    expect(removed).toContain('"command": "/usr/bin/check" }] },\n    ],')
    expect(removed).not.toContain('eb_qwenwork_1234')
  })

  it('keeps MCP guided, freezes exact GUI fields, and performs no private registry mutation', async () => {
    const adapter = host()
    const prepared = await adapter.plan(context, await request(['memory_tools']))

    expect(prepared.mutations).toEqual([])
    expect(prepared.requiredUserActions).toEqual(['qwenwork_mcp_gui_connect_required'])
    expect(prepared.requiredUserActionDetails).toEqual([
      expect.objectContaining({
        kind: 'qwenwork_mcp_gui',
        operation: 'connect',
        componentKey: 'memory_tools',
        installationId: 'installation-qwenwork',
        agentId: 'eb_qwenwork_1234',
        hostVariant: 'qwenwork-desktop',
        hostVersion: '3.2.1',
        tideMindVersion: '0.2.92',
        adapterVersion: adapter.adapterVersion,
        projectionVersion: '1',
        connectorName: 'Tide Mind - eb_qwenwork_1234',
        serverType: 'STDIO',
        command: "/Applications/Tide Mind's.app/Contents/Resources/tm-node",
        args: ['/Applications/Tide Mind.app/Contents/Resources/mcp-server.cjs'],
        environment: {
          EB_AGENT_ID: 'eb_qwenwork_1234',
          EB_HOST_VARIANT: 'qwenwork-desktop',
          EB_ACTIVITY_GENERATION_TOKEN: 'generation-qwenwork-1234',
        },
        steps: expect.arrayContaining([
          '打开 QwenWork，进入「扩展」→「连接器」。',
          '确认连接器已启用，新建一个对话任务，并在同一对话中分别成功调用 Tide Mind 的 brain_recall 与 brain_digest。',
        ]),
      }),
    ])
    const detail = prepared.requiredUserActionDetails![0]
    expect(detail.kind).toBe('qwenwork_mcp_gui')
    if (detail.kind !== 'qwenwork_mcp_gui') throw new Error('unexpected action')
    expect(detail.steps.join('\n')).toContain('brain_recall')
    expect(detail.steps.join('\n')).toContain('brain_digest')
    expect(detail.steps.join('\n')).not.toMatch(/任一|brain_prepare、brain_recall 或 brain_digest/u)
    expect(JSON.parse(detail.configurationJson)).toEqual({
      mcpServers: {
        'Tide Mind - eb_qwenwork_1234': {
          command: "/Applications/Tide Mind's.app/Contents/Resources/tm-node",
          args: ['/Applications/Tide Mind.app/Contents/Resources/mcp-server.cjs'],
          env: {
            EB_AGENT_ID: 'eb_qwenwork_1234',
            EB_HOST_VARIANT: 'qwenwork-desktop',
            EB_ACTIVITY_GENERATION_TOKEN: 'generation-qwenwork-1234',
          },
        },
      },
    })
    expect(detail.steps).toEqual(expect.arrayContaining([
      expect.stringContaining('mcpServers JSON'),
      expect.stringContaining('command、args 和 env 为分离字段'),
    ]))
    expect(detail.configurationJson).not.toContain("Tide Mind'\\''s.app")
    expect(detail.installationBindingHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(detail.connectorConfigurationHash).toMatch(/^[a-f0-9]{64}$/u)

    const disconnected = await adapter.disconnect(context, {
      componentKeys: ['memory_tools'],
      observed: await adapter.inspect(context),
      ownedArtifacts: [],
    })
    expect(disconnected.mutations).toEqual([])
    expect(disconnected.requiredUserActionDetails?.[0]).toMatchObject({
      kind: 'qwenwork_mcp_gui', operation: 'disconnect',
    })
  })

  it('keeps passive maintenance inspection independent from an activation generation', async () => {
    const adapter = host()
    const prepared = await adapter.plan(context, await request(['instruction', 'lifecycle']))
    for (const mutation of prepared.mutations) await adapter.apply(context, mutation)
    const passiveContext: AdapterOperationContext = { ...context, activityGenerationToken: undefined }

    const inspection = await adapter.inspect(passiveContext)

    expect(inspection.detected).toBe(true)
    expect(inspection.diagnostics).toEqual(['qwenwork_connector_registry_not_readable_guided_only'])
    expect(inspection.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentKey: 'instruction', visibility: 'dedicated' }),
      expect.objectContaining({ componentKey: 'lifecycle', visibility: 'dedicated' }),
      expect.objectContaining({
        componentKey: 'memory_tools',
        details: expect.objectContaining({ connectorName: 'Tide Mind - eb_qwenwork_1234' }),
      }),
    ]))
  })

  it('never treats static files as C4 and requires fresh real lifecycle and brain activity', async () => {
    const adapter = host()
    const prepared = await adapter.plan(context, await request(['instruction', 'lifecycle']))
    for (const mutation of prepared.mutations) await adapter.apply(context, mutation)
    const inspection = await adapter.inspect(context)
    const binding = {
      installationId: 'installation-qwenwork',
      tideMindVersion: '0.2.92',
      adapterVersion: adapter.adapterVersion,
      projectionVersion: '1',
      hostVersion: '3.2.1',
      activationRunId: 'run-qwenwork',
      activityGenerationToken: 'generation-qwenwork-1234',
      observedAfter: '2026-09-03T00:00:00.000Z',
      verifiedAt: '2026-09-03T00:10:00.000Z',
    }
    const staticOnly = await adapter.verify(context, {
      componentKeys: ['instruction', 'lifecycle', 'memory_tools'],
      expectedCapability: 4,
      inspection,
      activityBinding: binding,
    })
    expect(staticOnly.every(result => result.status === 'unverified')).toBe(true)

    context.hostActivityEvidence = {
      find(query) {
        if (query.componentKey === 'lifecycle') {
          return (['session_start', 'pre_compact', 'session_end'] as const)
            .map(signal => activity(context, query.componentKey, signal, query.adapterVersion))
        }
        return [
          activity(context, query.componentKey, 'brain_recall', query.adapterVersion),
          activity(context, query.componentKey, 'brain_digest', query.adapterVersion),
        ]
      },
    }
    const verified = await adapter.verify(context, {
      componentKeys: ['instruction', 'lifecycle', 'memory_tools'],
      expectedCapability: 4,
      inspection,
      activityBinding: binding,
    })
    expect(verified).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentKey: 'instruction', status: 'verified', verifiedCapability: 1 }),
      expect.objectContaining({ componentKey: 'lifecycle', status: 'verified', verifiedCapability: 4 }),
      expect.objectContaining({
        componentKey: 'memory_tools',
        status: 'verified',
        verifiedCapability: 2,
        invalidationKeys: [
          'host_version',
          'adapter_version',
          'projection_version',
          'tide_mind_version',
          'activity_freshness',
        ],
      }),
    ]))
  })

  it.each(['session_start', 'pre_compact', 'session_end'] as const)(
    'does not verify QwenWork C4 when %s evidence is missing',
    async (missingSignal) => {
      const adapter = host()
      const prepared = await adapter.plan(context, await request(['lifecycle']))
      for (const mutation of prepared.mutations) await adapter.apply(context, mutation)
      const binding = {
        installationId: 'installation-qwenwork',
        tideMindVersion: '0.2.92',
        adapterVersion: adapter.adapterVersion,
        projectionVersion: '1',
        hostVersion: '3.2.1',
        activationRunId: 'run-qwenwork',
        activityGenerationToken: 'generation-qwenwork-1234',
        observedAfter: '2026-09-03T00:00:00.000Z',
        verifiedAt: '2026-09-03T00:10:00.000Z',
      }
      context.hostActivityEvidence = {
        find: query => (['session_start', 'pre_compact', 'session_end'] as const)
          .filter(signal => signal !== missingSignal)
          .map(signal => activity(context, 'lifecycle', signal, query.adapterVersion)),
      }
      const results = await adapter.verify(context, {
        componentKeys: ['lifecycle'],
        expectedCapability: 4,
        inspection: await adapter.inspect(context),
        activityBinding: binding,
      })
      expect(results[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })
    },
  )

  it('fails closed before planning if roots, version, or strong release identity are not frozen', async () => {
    const adapter = host()
    context = {
      ...context,
      hostVersion: undefined,
      installation: {
        ...context.installation,
        componentConfigRoots: undefined,
        distribution: { distributionId: 'cn.qwenwork.desktop.mac' },
      },
    }
    const observed = await adapter.inspect(context)
    expect(observed.detected).toBe(false)
    expect(observed.diagnostics).toEqual(expect.arrayContaining([
      'qwenwork_package_provenance_unproven',
      'qwenwork_executable_realpath_unproven',
      'qwenwork_distribution_fingerprint_unproven',
      'qwenwork_instruction_component_root_not_frozen',
      'qwenwork_lifecycle_component_root_not_frozen',
    ]))
    const prepared = await adapter.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      observed,
      ownedArtifacts: [],
    })
    expect(prepared.mutations).toEqual([])
    expect(prepared.requiredUserActionDetails).toEqual([])
    expect(prepared.diagnostics).toContain('qwenwork_host_version_unproven')
  })
})

function activity(
  context: AdapterOperationContext,
  componentKey: 'memory_tools' | 'lifecycle',
  signalName: HostActivityEvidenceRecord['signalName'],
  adapterVersion: string,
): HostActivityEvidenceRecord {
  return {
    id: `activity-${componentKey}`,
    installationId: context.installationId!,
    agentId: context.agentId,
    hostVariant: 'qwenwork-desktop',
    componentKey,
    signalName,
    tideMindVersion: '0.2.92',
    adapterVersion,
    projectionVersion: '1',
    hostVersion: '3.2.1',
    evidenceHash: `real-${signalName}`,
    observedAt: '2026-09-03T00:05:00.000Z',
  }
}
