import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseJsoncObject } from '../../client/electron/agent-integration/jsonc-document'
import { createCustomLocalMcpHostAdapter } from '../../client/electron/agent-integration/hosts/custom-local-mcp-adapter'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type {
  AdapterOperationContext,
  AdapterPlanRequest,
  HostActivityEvidenceRecord,
} from '../../client/electron/agent-integration/types'

const schemas = [
  ['standard_mcp_servers', ['mcpServers', 'memory'], false],
  ['nested_mcp_servers', ['mcp', 'servers', 'memory'], true],
  ['opencode_mcp', ['mcp', 'memory'], false],
] as const

describe('guided Custom local MCP adapter', () => {
  let root: string
  let context: AdapterOperationContext

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'custom-local-mcp-')))
    const configRoot = path.join(root, 'client-config')
    const runtimeRoot = path.join(root, 'runtime')
    fs.mkdirSync(configRoot, { recursive: true })
    fs.mkdirSync(runtimeRoot, { recursive: true })
    const executable = path.join(root, 'custom-client')
    const shim = path.join(runtimeRoot, 'tm-node')
    const server = path.join(runtimeRoot, 'mcp-server.cjs')
    fs.writeFileSync(executable, 'client', { mode: 0o755 })
    fs.writeFileSync(shim, 'shim')
    fs.writeFileSync(server, 'server')
    const configFile = path.join(configRoot, 'client.json')
    fs.writeFileSync(configFile, '{"userSetting":true}\n')
    context = {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: root,
        applicationDataDir: path.join(root, 'app-data'),
        shimPath: shim,
        mcpServerPath: server,
        hookScriptPath: path.join(runtimeRoot, 'hook.cjs'),
        preCompactScriptPath: path.join(runtimeRoot, 'pre.cjs'),
        postCompactScriptPath: path.join(runtimeRoot, 'post.cjs'),
        tideMindVersion: '0.2.92',
        catalogVersion: '2',
        projectionVersion: '4',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'local-user',
        productFamilyId: 'custom-local-agent',
        hostVariant: 'custom-local-mcp',
        configRoot,
        componentConfigFiles: { memory_tools: configFile },
        explicitProfile: 'custom-mcp:standard_mcp_servers:memory',
        hostOwnedIdentity: 'custom-local:fixture',
        distribution: {
          executableRealpath: executable,
          packageProvenance: 'user_selected_local_executable',
          capabilityFingerprint: `custom-local-surface:${'a'.repeat(64)}`,
        },
      }),
      agentId: 'eb_custom01',
      operationId: 'custom-run-1',
      activityGenerationToken: 'generation-custom-1',
    }
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  async function request(ownedArtifacts: AdapterPlanRequest['ownedArtifacts'] = []): Promise<AdapterPlanRequest> {
    const host = createCustomLocalMcpHostAdapter()
    return {
      desiredCapability: 2,
      desiredComponents: ['memory_tools'],
      observed: await host.inspect(context),
      ownedArtifacts,
    }
  }

  function select(rootValue: any, selector: readonly string[]) {
    return selector.reduce((value, key) => value[key], rootValue)
  }

  it.each(schemas)('projects only the frozen local runtime for %s', async (schema, selector, jsonc) => {
    const configRoot = context.installation.canonicalConfigRoot
    const configFile = path.join(configRoot, jsonc ? 'client.jsonc' : 'client.json')
    fs.writeFileSync(configFile, jsonc ? '{\n  // retained\n  "userSetting": true\n}\n' : '{"userSetting":true}\n')
    context = {
      ...context,
      installation: canonicalizeInstallationIdentity({
        ...context.installation,
        configRoot,
        componentConfigFiles: { memory_tools: configFile },
        explicitProfile: `custom-mcp:${schema}:memory`,
      }),
    }
    const host = createCustomLocalMcpHostAdapter()
    const plan = await host.plan(context, await request())
    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      operation: 'create',
      physicalTarget: configFile,
      ownershipKey: selector.join('.'),
    })
    await host.apply(context, plan.mutations[0])
    const source = fs.readFileSync(configFile, 'utf8')
    const document = jsonc ? parseJsoncObject(source).root : JSON.parse(source)
    expect((document as any).userSetting).toBe(true)
    if (jsonc) expect(source).toContain('// retained')
    const entry = select(document, selector)
    expect(JSON.stringify(entry)).not.toContain(context.installation.distribution.executableRealpath)
    if (schema === 'opencode_mcp') {
      expect(entry).toEqual({
        type: 'local',
        command: [context.runtime.shimPath, context.runtime.mcpServerPath],
        enabled: true,
        environment: {
          EB_AGENT_ID: context.agentId,
          EB_HOST_VARIANT: 'custom-local-mcp',
          EB_ACTIVITY_GENERATION_TOKEN: 'generation-custom-1',
        },
      })
    } else {
      expect(entry).toEqual({
        command: context.runtime.shimPath,
        args: [context.runtime.mcpServerPath],
        env: {
          EB_AGENT_ID: context.agentId,
          EB_HOST_VARIANT: 'custom-local-mcp',
          EB_ACTIVITY_GENERATION_TOKEN: 'generation-custom-1',
        },
      })
    }
    expect(await host.readBack(context, plan.mutations[0])).toMatchObject({
      observed: true, matchesDesired: true, visibility: 'dedicated',
    })
  })

  it('fails closed for unknown schemas, unsafe keys, remote-shaped roots and untrusted executables', async () => {
    const host = createCustomLocalMcpHostAdapter()
    for (const explicitProfile of [
      'custom-mcp:unknown:memory',
      'custom-mcp:standard_mcp_servers:__proto__',
      'custom-mcp:standard_mcp_servers:https://remote.example',
    ]) {
      context = { ...context, installation: { ...context.installation, explicitProfile } }
      const inspection = await host.inspect(context)
      expect(inspection).toMatchObject({ detected: false, components: [{ visibility: 'unknown' }] })
    }
    context = {
      ...context,
      installation: {
        ...context.installation,
        explicitProfile: 'custom-mcp:standard_mcp_servers:memory',
        distribution: { ...context.installation.distribution, packageProvenance: 'user-command' },
      },
    }
    expect(await host.inspect(context)).toMatchObject({ detected: false })
    expect((await host.plan(context, await request())).mutations).toEqual([])
  })

  it('requires ownership for same-name state, adopts only an exact identity-bound entry, and disconnects exactly', async () => {
    const host = createCustomLocalMcpHostAdapter()
    const connect = await host.plan(context, await request())
    await host.apply(context, connect.mutations[0])
    expect(await host.inspectAdoptableArtifacts!(context)).toHaveLength(1)
    const withoutOwnership = await host.plan(context, await request())
    expect(withoutOwnership.mutations).toEqual([])
    expect(withoutOwnership.diagnostics).toContain('matching_selector_has_no_ownership_evidence')

    const ownedArtifacts = [{
      componentKey: 'memory_tools' as const,
      physicalTarget: connect.mutations[0].physicalTarget,
      ownershipKey: connect.mutations[0].ownershipKey,
      ownedFragmentHash: connect.mutations[0].desiredFragmentHash!,
      selectorSchemaVersion: connect.mutations[0].selectorSchemaVersion,
    }]
    const disconnect = await host.disconnect(context, {
      componentKeys: ['memory_tools'], observed: await host.inspect(context), ownedArtifacts,
    })
    expect(disconnect.mutations).toHaveLength(1)
    await host.apply(context, disconnect.mutations[0])
    expect(JSON.parse(fs.readFileSync(context.installation.componentConfigFiles!.memory_tools!, 'utf8')))
      .toEqual({ userSetting: true })
  })

  it('protects the whole container with CAS and does not overwrite an external edit', async () => {
    const host = createCustomLocalMcpHostAdapter()
    const plan = await host.plan(context, await request())
    const target = context.installation.componentConfigFiles!.memory_tools!
    fs.writeFileSync(target, '{"external":true}\n')
    await expect(host.apply(context, plan.mutations[0])).rejects.toThrow(/container_precondition_changed/)
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ external: true })
  })

  it('reaches only C2 after exact static state and fresh real memory read/write activity', async () => {
    const host = createCustomLocalMcpHostAdapter()
    const plan = await host.plan(context, await request())
    await host.apply(context, plan.mutations[0])
    const inspection = await host.inspect(context)
    const binding = {
      installationId: 'custom-installation',
      tideMindVersion: '0.2.92',
      adapterVersion: '1',
      projectionVersion: '4',
      hostVersion: 'custom-client-v1',
      activationRunId: 'custom-run-1',
      activityGenerationToken: 'generation-custom-1',
      observedAfter: '2026-09-03T00:00:00.000Z',
      verifiedAt: '2026-09-03T00:10:00.000Z',
    }
    expect((await host.verify(context, {
      componentKeys: ['memory_tools'], expectedCapability: 2, inspection, activityBinding: binding,
    }))[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })

    let includeDigest = false
    context = {
      ...context,
      hostActivityEvidence: {
        find(query) {
          expect(query).toMatchObject({
            activationRunId: 'custom-run-1',
            activityGenerationToken: 'generation-custom-1',
          })
          expect(query.signalNames).toEqual(['brain_recall', 'brain_digest'])
          const recall = {
            id: 'custom-brain-use',
            installationId: query.installationId,
            agentId: query.agentId,
            hostVariant: 'custom-local-mcp',
            componentKey: 'memory_tools',
            signalName: 'brain_recall',
            tideMindVersion: query.tideMindVersion,
            adapterVersion: query.adapterVersion,
            projectionVersion: query.projectionVersion,
            hostVersion: query.hostVersion,
            evidenceHash: 'real-use',
            observedAt: '2026-09-03T00:05:00.000Z',
          } satisfies HostActivityEvidenceRecord
          const digest = {
            ...recall,
            id: 'custom-brain-digest',
            signalName: 'brain_digest' as const,
            evidenceHash: 'real-write',
            observedAt: '2026-09-03T00:06:00.000Z',
          } satisfies HostActivityEvidenceRecord
          return includeDigest ? [recall, digest] : [recall]
        },
      },
    }
    expect((await host.verify(context, {
      componentKeys: ['memory_tools'], expectedCapability: 2, inspection, activityBinding: binding,
    }))[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })
    includeDigest = true
    expect((await host.verify(context, {
      componentKeys: ['memory_tools'], expectedCapability: 2, inspection, activityBinding: binding,
    }))[0]).toMatchObject({ status: 'verified', verifiedCapability: 2 })
  })

  it('is registered without claiming instruction or lifecycle support', () => {
    const adapter = createP0HostAdapters().get('custom-local-mcp')
    expect(adapter).toBeDefined()
    expect(adapter!.componentKeys).toEqual(['memory_tools'])
    expect(adapter!.implementationTypes).toEqual({ memory_tools: ['mcp'] })
  })
})
