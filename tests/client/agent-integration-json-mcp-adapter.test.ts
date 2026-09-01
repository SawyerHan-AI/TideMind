import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Json } from '../../client/electron/agent-integration/fingerprint'
import { createJsonMcpHostAdapter } from '../../client/electron/agent-integration/hosts/json-mcp-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type { AdapterOperationContext, AdapterPlanRequest } from '../../client/electron/agent-integration/types'

describe('managed JSON MCP host adapter', () => {
  let root: string
  let context: AdapterOperationContext

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'json-mcp-adapter-'))
    context = {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: root,
        applicationDataDir: path.join(root, 'app-data'),
        shimPath: '/Applications/Tide Mind.app/Contents/Resources/tm-node',
        mcpServerPath: '/Applications/Tide Mind.app/Contents/Resources/mcp-server.cjs',
        hookScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook.cjs',
        preCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/pre.cjs',
        postCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/post.cjs',
        tideMindVersion: '1.0.0',
        catalogVersion: '1.0.0',
        projectionVersion: '1',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_01JABCDEF0123456789',
        productFamilyId: 'cursor',
        hostVariant: 'cursor-desktop',
        configRoot: path.join(root, '.cursor'),
      }),
      agentId: 'eb_12345678',
      operationId: 'run-1',
    }
    fs.mkdirSync(context.installation.canonicalConfigRoot, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const adapter = () => createJsonMcpHostAdapter({
    catalogId: 'cursor-desktop',
    adapterVersion: '1',
    configFile: ctx => path.join(ctx.installation.canonicalConfigRoot, 'mcp.json'),
    reload: 'new_session',
  })

  function request(ownedFragmentHash?: string): AdapterPlanRequest {
    const target = path.join(context.installation.canonicalConfigRoot, 'mcp.json')
    return {
      desiredCapability: 2,
      desiredComponents: ['memory_tools'],
      observed: {
        catalogId: 'cursor-desktop',
        detected: true,
        distribution: {},
        components: [],
        provenance: [],
        diagnostics: [],
      },
      ownedArtifacts: ownedFragmentHash === undefined ? [] : [{
        componentKey: 'memory_tools',
        physicalTarget: target,
        ownershipKey: 'mcpServers.tidemind-eb_12345678',
        ownedFragmentHash,
      }],
    }
  }

  it('plans, applies and reads back a dedicated MCP selector', async () => {
    const host = adapter()
    const plan = await host.plan(context, request())
    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      operation: 'create',
      componentKey: 'memory_tools',
      ownershipKey: 'mcpServers.tidemind-eb_12345678',
    })
    expect(plan.mutations[0].preconditionHash).toBeUndefined()
    expect(plan.mutations[0].containerPreconditionHash).toBeUndefined()

    await host.apply(context, plan.mutations[0])
    expect(await host.readBack(context, plan.mutations[0])).toMatchObject({
      observed: true,
      matchesDesired: true,
      visibility: 'dedicated',
    })
    const config = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'mcp.json'), 'utf8'))
    expect(config.mcpServers['tidemind-eb_12345678'].env.EB_AGENT_ID).toBe('eb_12345678')
    expect(config.mcpServers['tidemind-eb_12345678'].env.EB_HOST_VARIANT).toBe('cursor-desktop')
  })

  it('creates the approved config root for an installed host with no prior configuration', async () => {
    const executable = path.join(root, 'kimi')
    fs.writeFileSync(executable, '')
    context = {
      ...context,
      installation: {
        ...context.installation,
        distribution: { executableRealpath: executable, distributionId: 'kimi-code' },
      },
    }
    fs.rmSync(context.installation.canonicalConfigRoot, { recursive: true })
    const host = adapter()

    const inspected = await host.inspect(context)
    expect(inspected).toMatchObject({ detected: true })
    expect(inspected.components[0]).toMatchObject({ visibility: 'absent' })
    const plan = await host.plan(context, request())
    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0].operation).toBe('create')

    await host.apply(context, plan.mutations[0])
    expect(fs.existsSync(path.join(context.installation.canonicalConfigRoot, 'mcp.json'))).toBe(true)
  })

  it('does not claim host verification from static file read-back', async () => {
    const host = adapter()
    const plan = await host.plan(context, request())
    await host.apply(context, plan.mutations[0])
    const inspection = await host.inspect(context)
    const result = await host.verify(context, {
      componentKeys: ['memory_tools'],
      expectedCapability: 2,
      inspection,
    })
    expect(result[0]).toMatchObject({
      status: 'unverified',
      verifiedCapability: null,
      identityAssertion: 'eb_12345678',
    })
  })

  it('fails closed on a matching but unowned selector', async () => {
    const host = adapter()
    const first = await host.plan(context, request())
    await host.apply(context, first.mutations[0])
    const second = await host.plan(context, request())
    expect(second.mutations).toEqual([])
    expect(second.diagnostics).toContain('matching_selector_has_no_ownership_evidence')
  })

  it('accepts an exact identity-bound copy after a stable Installation moves config root', async () => {
    const host = adapter()
    const oldTarget = path.join(context.installation.canonicalConfigRoot, 'mcp.json')
    const initial = await host.plan(context, request())
    await host.apply(context, initial.mutations[0])
    const desiredHash = initial.mutations[0].desiredFragmentHash!
    const copiedDocument = fs.readFileSync(oldTarget, 'utf8')
    const movedRoot = path.join(root, '.cursor-moved')
    fs.mkdirSync(movedRoot, { recursive: true })
    fs.writeFileSync(path.join(movedRoot, 'mcp.json'), copiedDocument)
    context = {
      ...context,
      installation: { ...context.installation, canonicalConfigRoot: movedRoot },
    }

    const moved = await host.plan(context, {
      ...request(),
      ownedArtifacts: [{
        componentKey: 'memory_tools',
        physicalTarget: oldTarget,
        ownershipKey: 'mcpServers.tidemind-eb_12345678',
        ownedFragmentHash: desiredHash,
      }],
    })

    expect(moved.mutations).toEqual([])
    expect(moved.diagnostics).not.toContain('matching_selector_has_no_ownership_evidence')
  })

  it('updates and disconnects only with the exact owned hash', async () => {
    const host = adapter()
    const initial = await host.plan(context, request())
    await host.apply(context, initial.mutations[0])
    const desired = {
      command: context.runtime.shimPath,
      args: [context.runtime.mcpServerPath],
      env: {
        EB_AGENT_ID: context.agentId,
        EB_HOST_VARIANT: context.installation.hostVariant,
      },
    }
    const ownedHash = sha256Json(desired)

    const disconnect = await host.disconnect(context, {
      componentKeys: ['memory_tools'],
      observed: (await host.inspect(context)),
      ownedArtifacts: request(ownedHash).ownedArtifacts,
    })
    expect(disconnect.mutations).toHaveLength(1)
    expect(disconnect.mutations[0].operation).toBe('remove')
    expect(disconnect.mutations[0].preconditionHash).toBe(ownedHash)
    expect(disconnect.mutations[0].containerPreconditionHash).toMatch(/^[a-f0-9]{64}$/)
    await host.apply(context, disconnect.mutations[0])
    expect(await host.readBack(context, disconnect.mutations[0])).toMatchObject({
      observed: false,
      matchesDesired: true,
    })
  })

  it('reports malformed host config as unknown and never overwrites it', async () => {
    const target = path.join(root, '.cursor', 'mcp.json')
    fs.writeFileSync(target, '{')
    const inspection = await adapter().inspect(context)
    expect(inspection.components[0].visibility).toBe('unknown')
    expect(inspection.diagnostics[0]).toMatch(/malformed/)
    expect(fs.readFileSync(target, 'utf8')).toBe('{')
  })
})
