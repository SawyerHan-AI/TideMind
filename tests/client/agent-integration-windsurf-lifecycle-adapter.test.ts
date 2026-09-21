import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import {
  createWindsurfLifecycleHostAdapter,
  windsurfLifecycleRuntimeScript,
} from '../../client/electron/agent-integration/hosts/windsurf-lifecycle-adapter'
import type {
  AdapterOperationContext,
  AdapterPlanRequest,
  HostActivityEvidenceRecord,
} from '../../client/electron/agent-integration/types'

describe('Devin Desktop lifecycle Hook adapter', () => {
  let root: string
  let context: AdapterOperationContext

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'windsurf-lifecycle-adapter-'))
    const configRoot = path.join(root, '.config', 'devin')
    const bin = path.join(root, 'runtime')
    const executable = path.join(root, 'Devin.app', 'Contents', 'MacOS', 'Devin')
    fs.mkdirSync(configRoot, { recursive: true })
    fs.mkdirSync(bin, { recursive: true })
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(path.join(bin, 'tm-node'), 'shim')
    fs.writeFileSync(path.join(bin, 'hook-windsurf-lifecycle.cjs'), 'bundle')
    fs.writeFileSync(executable, 'host')
    context = {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: root,
        applicationDataDir: path.join(root, 'app-data'),
        shimPath: path.join(bin, 'tm-node'),
        mcpServerPath: path.join(bin, 'mcp-server.cjs'),
        hookScriptPath: path.join(bin, 'hook-session-start.cjs'),
        preCompactScriptPath: path.join(bin, 'hook-pre-compact.cjs'),
        postCompactScriptPath: path.join(bin, 'hook-post-compact.cjs'),
        tideMindVersion: '0.2.92',
        catalogVersion: '2',
        projectionVersion: '3',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_windsurf_test',
        productFamilyId: 'windsurf',
        hostVariant: 'windsurf-desktop',
        configRoot,
        componentConfigRoots: {
          instruction: configRoot,
          memory_tools: configRoot,
          lifecycle: configRoot,
        },
        componentConfigFiles: {
          instruction: path.join(configRoot, 'skills', 'tidemind', 'SKILL.md'),
          memory_tools: path.join(configRoot, 'mcp_config.json'),
          lifecycle: path.join(configRoot, 'config.json'),
        },
        distribution: {
          executableRealpath: executable,
          distributionId: 'com.exafunction.windsurf',
          packageProvenance: 'signed_app:com.exafunction.windsurf:83Z2LHX6XW',
        },
      }),
      agentId: 'eb_windsurf01',
      operationId: 'windsurf-run-1',
      activityGenerationToken: 'generation-windsurf-1',
    }
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  async function request(ownedArtifacts: AdapterPlanRequest['ownedArtifacts'] = []): Promise<AdapterPlanRequest> {
    const host = createWindsurfLifecycleHostAdapter()
    return {
      desiredCapability: 4,
      desiredComponents: ['lifecycle'],
      observed: await host.inspect(context),
      ownedArtifacts,
    }
  }

  it('writes the documented user Hook selectors and preserves every unrelated entry', async () => {
    const target = path.join(context.installation.canonicalConfigRoot, 'config.json')
    fs.writeFileSync(target, `{
      // This comment and trailing comma are user-owned.
      "userSetting": true,
      "hooks": {
        "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "/usr/bin/true" }] }],
        "PostToolUse": [{ "matcher": "exec", "hooks": [{ "type": "command", "command": "/usr/bin/false" }] }],
      },
    }\n`)
    const host = createWindsurfLifecycleHostAdapter()
    const plan = await host.plan(context, await request())
    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      componentKey: 'lifecycle',
      operation: 'create',
      domainKind: 'file_fragment',
      reload: 'restart_host',
      commandCategory: 'file_write',
    })
    await host.apply(context, plan.mutations[0])

    const source = fs.readFileSync(target, 'utf8')
    expect(source).toContain('// This comment and trailing comma are user-owned.')
    const document = JSON.parse(source.replace(/\/\/.*$/gmu, '').replace(/,\s*([}\]])/gu, '$1'))
    expect(document.userSetting).toBe(true)
    expect(document.hooks.PostToolUse).toEqual([{
      matcher: 'exec',
      hooks: [{ type: 'command', command: '/usr/bin/false' }],
    }])
    expect(document.hooks.SessionStart[0]).toEqual({
      matcher: '',
      hooks: [{ type: 'command', command: '/usr/bin/true' }],
    })
    const start = document.hooks.SessionStart[1]
    const end = document.hooks.SessionEnd[0]
    expect(start).toMatchObject({ matcher: '', hooks: [{ type: 'command', timeout: 60 }] })
    expect(end).toMatchObject({ matcher: '', hooks: [{ type: 'command', timeout: 10 }] })
    expect(start.hooks[0].command).toContain(`'${windsurfLifecycleRuntimeScript(context)}'`)
    expect(start.hooks[0].command).toContain("'--event' 'SessionStart'")
    expect(start.hooks[0].command).toContain("'--skill-path'")
    expect(end.hooks[0].command).toContain("'--event' 'SessionEnd'")
    expect(start.hooks[0].command).toMatch(/# tidemind-windsurf-[a-f0-9]{24}$/u)
    expect(end.hooks[0].command).toMatch(/# tidemind-windsurf-[a-f0-9]{24}$/u)
    expect(await host.readBack(context, plan.mutations[0])).toMatchObject({
      observed: true,
      matchesDesired: true,
      visibility: 'dedicated',
    })
  })

  it('requires both a fresh prepare event and response-complete event for C4', async () => {
    const host = createWindsurfLifecycleHostAdapter()
    const plan = await host.plan(context, await request())
    await host.apply(context, plan.mutations[0])
    const inspection = await host.inspect(context)
    const binding = {
      installationId: 'windsurf-installation',
      tideMindVersion: '0.2.92',
      adapterVersion: '1',
      projectionVersion: '3',
      hostVersion: '1.99.0',
      activationRunId: 'windsurf-run-1',
      activityGenerationToken: 'generation-windsurf-1',
      observedAfter: '2026-09-03T10:00:00.000Z',
      verifiedAt: '2026-09-03T10:10:00.000Z',
    }

    context = {
      ...context,
      hostActivityEvidence: {
        find(query) {
          expect(query).toMatchObject({
            activationRunId: 'windsurf-run-1',
            activityGenerationToken: 'generation-windsurf-1',
          })
          expect(query.signalNames).toEqual(['session_start', 'session_end'])
          return [activity(query.signalNames[0], query)]
        },
      },
    }
    expect((await host.verify(context, {
      componentKeys: ['lifecycle'], expectedCapability: 4, inspection, activityBinding: binding,
    }))[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })

    context = {
      ...context,
      hostActivityEvidence: {
        find: query => query.signalNames.map(signal => activity(signal, query)),
      },
    }
    expect((await host.verify(context, {
      componentKeys: ['lifecycle'], expectedCapability: 4, inspection, activityBinding: binding,
    }))[0]).toMatchObject({
      status: 'verified',
      verifiedCapability: 4,
      diagnostics: ['host_activity_recognized:session_end,session_start'],
    })
  })

  it('uses container CAS and disconnects only its exact owned members', async () => {
    const target = path.join(context.installation.canonicalConfigRoot, 'config.json')
    const host = createWindsurfLifecycleHostAdapter()
    const stale = await host.plan(context, await request())
    fs.writeFileSync(target, JSON.stringify({
      hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'user' }] }] },
    }))
    await expect(host.apply(context, stale.mutations[0])).rejects.toThrow(/container_precondition_changed/)

    fs.rmSync(target)
    const connect = await host.plan(context, await request())
    await host.apply(context, connect.mutations[0])
    const disconnect = await host.disconnect(context, {
      componentKeys: ['lifecycle'],
      observed: await host.inspect(context),
      ownedArtifacts: [{
        componentKey: 'lifecycle',
        physicalTarget: target,
        ownershipKey: connect.mutations[0].ownershipKey,
        ownedFragmentHash: connect.mutations[0].desiredFragmentHash!,
      }],
    })
    expect(disconnect.mutations).toHaveLength(1)
    await host.apply(context, disconnect.mutations[0])
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ hooks: {} })
  })

  it('will not install a command whose packaged runtime is missing', async () => {
    fs.rmSync(windsurfLifecycleRuntimeScript(context))
    const host = createWindsurfLifecycleHostAdapter()
    const plan = await host.plan(context, await request())
    expect(plan.mutations).toEqual([])
    expect(plan.diagnostics).toContain('lifecycle_runtime_missing')
  })
})

function activity(
  signalName: HostActivityEvidenceRecord['signalName'],
  query: {
    installationId: string
    agentId: string
    hostVariant: HostActivityEvidenceRecord['hostVariant']
    tideMindVersion: string
    adapterVersion: string
    projectionVersion: string
    hostVersion: string
  },
): HostActivityEvidenceRecord {
  return {
    id: `activity-${signalName}`,
    installationId: query.installationId,
    agentId: query.agentId,
    hostVariant: query.hostVariant,
    componentKey: 'lifecycle',
    signalName,
    tideMindVersion: query.tideMindVersion,
    adapterVersion: query.adapterVersion,
    projectionVersion: query.projectionVersion,
    hostVersion: query.hostVersion,
    evidenceHash: `evidence-${signalName}`,
    observedAt: signalName === 'session_start'
      ? '2026-09-03T10:03:00.000Z'
      : '2026-09-03T10:04:00.000Z',
  }
}
