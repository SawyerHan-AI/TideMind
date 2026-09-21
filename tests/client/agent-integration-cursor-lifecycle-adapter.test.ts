import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createCursorLifecycleHostAdapter,
  cursorLifecycleRuntimeScript,
} from '../../client/electron/agent-integration/hosts/cursor-lifecycle-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type {
  AdapterOperationContext,
  AdapterPlanRequest,
  HostActivityEvidenceRecord,
} from '../../client/electron/agent-integration/types'

describe('Cursor lifecycle hook host adapter', () => {
  let root: string
  let context: AdapterOperationContext

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-lifecycle-adapter-'))
    const configRoot = path.join(root, '.cursor')
    const bin = path.join(root, 'app-runtime')
    fs.mkdirSync(configRoot, { recursive: true })
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'tm-node'), 'runtime')
    fs.writeFileSync(path.join(bin, 'hook-cursor-lifecycle.cjs'), 'bundle')
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
        osUserIdentity: 'usr_cursor_test',
        productFamilyId: 'cursor',
        hostVariant: 'cursor-desktop',
        configRoot,
        distribution: { executableRealpath: path.join(root, 'Cursor.app') },
      }),
      agentId: 'eb_cursor01',
      operationId: 'cursor-run-1',
      activityGenerationToken: 'generation-cursor-1',
    }
    fs.writeFileSync(context.installation.distribution.executableRealpath!, 'cursor')
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  async function request(owned?: AdapterPlanRequest['ownedArtifacts']): Promise<AdapterPlanRequest> {
    const host = createCursorLifecycleHostAdapter()
    return {
      desiredCapability: 4,
      desiredComponents: ['lifecycle'],
      observed: await host.inspect(context),
      ownedArtifacts: owned ?? [],
    }
  }

  it('writes official Cursor selectors to hooks.json and preserves unrelated content', async () => {
    const target = path.join(context.installation.canonicalConfigRoot, 'hooks.json')
    fs.writeFileSync(target, JSON.stringify({
      version: 1,
      theme: 'user',
      hooks: { sessionStart: [{ command: 'echo user', timeout: 5 }] },
    }))
    const host = createCursorLifecycleHostAdapter()
    const plan = await host.plan(context, await request())
    expect(plan.mutations).toHaveLength(1)
    await host.apply(context, plan.mutations[0])

    const document = JSON.parse(fs.readFileSync(target, 'utf8')) as any
    expect(document).toMatchObject({ version: 1, theme: 'user' })
    expect(document.hooks.sessionStart[0]).toEqual({ command: 'echo user', timeout: 5 })
    for (const [event, timeout] of [['sessionStart', 30], ['preCompact', 10], ['sessionEnd', 10]] as const) {
      const entry = document.hooks[event].at(-1)
      expect(entry.timeout).toBe(timeout)
      expect(entry.command).toContain(`'${cursorLifecycleRuntimeScript(context)}'`)
      expect(entry.command).toContain(`'--event' '${event}'`)
      expect(entry.command).toContain(`'--agent-id' '${context.agentId}'`)
      expect(entry.command).toMatch(/# tidemind-lifecycle-[a-f0-9]{24}$/u)
    }
    expect(document.hooks.sessionStart.at(-1).command).toContain("'--skill-path'")
    expect(await host.readBack(context, plan.mutations[0])).toMatchObject({
      observed: true,
      matchesDesired: true,
      visibility: 'dedicated',
    })
  })

  it('requires all three fresh Cursor lifecycle signals after exact static read-back', async () => {
    const host = createCursorLifecycleHostAdapter()
    const plan = await host.plan(context, await request())
    await host.apply(context, plan.mutations[0])
    const inspection = await host.inspect(context)
    const binding = {
      installationId: 'cursor-installation',
      tideMindVersion: '0.2.92',
      adapterVersion: '1',
      projectionVersion: '3',
      hostVersion: '2.1.0',
      activationRunId: 'cursor-run-1',
      activityGenerationToken: 'generation-cursor-1',
      observedAfter: '2026-09-02T10:00:00.000Z',
      verifiedAt: '2026-09-02T10:10:00.000Z',
    }
    const staticOnly = await host.verify(context, {
      componentKeys: ['lifecycle'], expectedCapability: 4, inspection, activityBinding: binding,
    })
    expect(staticOnly[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })

    let requestedSignals: readonly string[] = []
    context = {
      ...context,
      hostActivityEvidence: {
        find(query) {
          requestedSignals = query.signalNames
          expect(query).toMatchObject({
            activationRunId: 'cursor-run-1',
            activityGenerationToken: 'generation-cursor-1',
          })
          return query.signalNames.map((signalName, index) => ({
            id: `cursor-activity-${index}`,
            installationId: query.installationId,
            agentId: query.agentId,
            hostVariant: query.hostVariant,
            componentKey: 'lifecycle',
            signalName,
            tideMindVersion: query.tideMindVersion,
            adapterVersion: query.adapterVersion,
            projectionVersion: query.projectionVersion,
            hostVersion: query.hostVersion,
            evidenceHash: `evidence-${index}`,
            observedAt: `2026-09-02T10:0${index + 1}:00.000Z`,
          } satisfies HostActivityEvidenceRecord))
        },
      },
    }
    const verified = await host.verify(context, {
      componentKeys: ['lifecycle'], expectedCapability: 4, inspection, activityBinding: binding,
    })
    expect(requestedSignals).toEqual(['session_start', 'pre_compact', 'session_end'])
    expect(verified[0]).toMatchObject({ status: 'verified', verifiedCapability: 4 })
  })

  it('fails closed on a stale container CAS and malformed JSON', async () => {
    const host = createCursorLifecycleHostAdapter()
    const plan = await host.plan(context, await request())
    const target = path.join(context.installation.canonicalConfigRoot, 'hooks.json')
    fs.writeFileSync(target, '{"version":1,"external":true}\n')
    await expect(host.apply(context, plan.mutations[0]))
      .rejects.toThrow(/container_precondition_changed/)
    fs.writeFileSync(target, '{broken')
    const inspection = await host.inspect(context)
    expect(inspection.components[0].visibility).toBe('unknown')
    expect((await host.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['lifecycle'],
      observed: inspection,
      ownedArtifacts: [],
    })).diagnostics.join(' ')).toMatch(/malformed/)
    expect(fs.readFileSync(target, 'utf8')).toBe('{broken')
  })

  it('disconnects only the exactly owned members even when runtime assets are gone', async () => {
    const target = path.join(context.installation.canonicalConfigRoot, 'hooks.json')
    fs.writeFileSync(target, JSON.stringify({
      version: 1,
      hooks: { sessionEnd: [{ command: 'echo user', timeout: 2 }] },
    }))
    const host = createCursorLifecycleHostAdapter()
    const connect = await host.plan(context, await request())
    await host.apply(context, connect.mutations[0])
    const ownedArtifacts = [{
      componentKey: 'lifecycle' as const,
      physicalTarget: target,
      ownershipKey: connect.mutations[0].ownershipKey,
      ownedFragmentHash: connect.mutations[0].desiredFragmentHash!,
    }]
    fs.rmSync(context.runtime.shimPath)
    fs.rmSync(cursorLifecycleRuntimeScript(context))
    const disconnect = await host.disconnect(context, {
      componentKeys: ['lifecycle'],
      observed: await host.inspect(context),
      ownedArtifacts,
    })
    expect(disconnect.mutations).toHaveLength(1)
    await host.apply(context, disconnect.mutations[0])
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({
      version: 1,
      hooks: { sessionEnd: [{ command: 'echo user', timeout: 2 }] },
    })
  })

  it('will not adopt, replace, or remove matching hooks without ownership evidence', async () => {
    const host = createCursorLifecycleHostAdapter()
    const connect = await host.plan(context, await request())
    await host.apply(context, connect.mutations[0])
    const reconnect = await host.plan(context, await request())
    expect(reconnect.mutations).toEqual([])
    expect(reconnect.diagnostics).toContain('matching_cursor_hooks_have_no_ownership_evidence')
    expect(await host.inspectAdoptableArtifacts!(context)).toHaveLength(1)
    const disconnect = await host.disconnect(context, {
      componentKeys: ['lifecycle'], observed: await host.inspect(context), ownedArtifacts: [],
    })
    expect(disconnect.mutations).toEqual([])
    expect(disconnect.diagnostics).toContain('remove_requires_exact_owned_cursor_hooks')
  })
})
