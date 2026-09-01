import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createP0JsonMcpAdapters, P0_JSON_MCP_SPECS } from '../../client/electron/agent-integration/hosts/p0-json-registry'
import { getCatalogVariant } from '../../client/electron/agent-integration/catalog'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type { AdapterOperationContext, CatalogId } from '../../client/electron/agent-integration/types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function context(
  catalogId: CatalogId,
  componentConfigFiles?: AdapterOperationContext['installation']['componentConfigFiles'],
): AdapterOperationContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-json-'))
  roots.push(root)
  const configRoot = path.join(root, 'config')
  fs.mkdirSync(configRoot)
  return {
    runtime: {
      runtimeRealm: 'local_macos',
      homeDir: root,
      applicationDataDir: path.join(root, 'data'),
      shimPath: '/Applications/Tide Mind.app/tm-node',
      mcpServerPath: '/Applications/Tide Mind.app/mcp-server.cjs',
      hookScriptPath: '/Applications/Tide Mind.app/hook.cjs',
      preCompactScriptPath: '/Applications/Tide Mind.app/pre.cjs',
      postCompactScriptPath: '/Applications/Tide Mind.app/post.cjs',
      tideMindVersion: '1',
      catalogVersion: '1',
      projectionVersion: '1',
    },
    installation: canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_01JABCDEF0123456789',
      productFamilyId: getCatalogVariant(catalogId).productFamilyId,
      hostVariant: catalogId,
      configRoot,
      componentConfigFiles,
    }),
    agentId: 'eb_fixture',
    operationId: 'op',
  }
}

describe('P0 documented JSON MCP registry', () => {
  it('has one adapter for every declared JSON surface', () => {
    const adapters = createP0JsonMcpAdapters()
    expect([...adapters.keys()].sort()).toEqual(Object.keys(P0_JSON_MCP_SPECS).sort())
  })

  for (const catalogId of Object.keys(P0_JSON_MCP_SPECS) as CatalogId[]) {
    it(`${catalogId} plans an isolated Tide Mind selector`, async () => {
      const adapter = createP0JsonMcpAdapters().get(catalogId)!
      const ctx = context(catalogId)
      const inspection = await adapter.inspect(ctx)
      const plan = await adapter.plan(ctx, {
        desiredCapability: 2,
        desiredComponents: ['memory_tools'],
        observed: inspection,
        ownedArtifacts: [],
      })
      expect(plan.catalogId).toBe(catalogId)
      expect(plan.mutations).toHaveLength(1)
      expect(plan.mutations[0]).toMatchObject({
        componentKey: 'memory_tools',
        operation: 'create',
        commandCategory: 'file_write',
      })
      await adapter.apply(ctx, plan.mutations[0])
      expect(await adapter.readBack(ctx, plan.mutations[0])).toMatchObject({ matchesDesired: true })
    })
  }

  it('uses distinct shared-file selectors for OpenCode V1 and V2', async () => {
    const adapters = createP0JsonMcpAdapters()
    const v1 = context('opencode-v1-cli')
    const v2: AdapterOperationContext = {
      ...context('opencode-v2-beta-cli'),
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos', osUserIdentity: 'usr_01JABCDEF0123456789', productFamilyId: 'opencode',
        hostVariant: 'opencode-v2-beta-cli', configRoot: v1.installation.canonicalConfigRoot,
      }),
    }
    const plan1 = await adapters.get('opencode-v1-cli')!.plan(v1, {
      desiredCapability: 2, desiredComponents: ['memory_tools'],
      observed: await adapters.get('opencode-v1-cli')!.inspect(v1), ownedArtifacts: [],
    })
    const plan2 = await adapters.get('opencode-v2-beta-cli')!.plan(v2, {
      desiredCapability: 2, desiredComponents: ['memory_tools'],
      observed: await adapters.get('opencode-v2-beta-cli')!.inspect(v2), ownedArtifacts: [],
    })
    expect(plan1.mutations[0].ownershipKey).toBe('mcp.tidemind-eb_fixture')
    expect(plan2.mutations[0].ownershipKey).toBe('mcp.servers.tidemind-eb_fixture')
  })

  it('fails closed instead of overwriting an OpenCode JSONC configuration', async () => {
    const adapter = createP0JsonMcpAdapters().get('opencode-v1-cli')!
    const ctx = context('opencode-v1-cli')
    fs.writeFileSync(path.join(ctx.installation.canonicalConfigRoot, 'opencode.jsonc'), '{ // user config\n}')
    const observed = await adapter.inspect(ctx)
    const plan = await adapter.plan(ctx, {
      desiredCapability: 2,
      desiredComponents: ['memory_tools'],
      observed,
      ownedArtifacts: [],
    })
    expect(observed.detected).toBe(false)
    expect(plan.mutations).toEqual([])
    expect(plan.diagnostics).toContain('host_not_detected_or_projection_format_unsupported')
  })

  it('targets the exact OPENCODE_CONFIG JSON file instead of the default sibling', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-json-custom-'))
    roots.push(root)
    const customFile = path.join(root, 'profile', 'custom-config.json')
    fs.mkdirSync(path.dirname(customFile), { recursive: true })
    const base = context('opencode-v1-cli')
    const ctx: AdapterOperationContext = {
      ...base,
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_01JABCDEF0123456789',
        productFamilyId: 'opencode',
        hostVariant: 'opencode-v1-cli',
        configRoot: path.dirname(customFile),
        componentConfigFiles: { memory_tools: customFile },
      }),
    }
    const adapter = createP0JsonMcpAdapters().get('opencode-v1-cli')!
    const observed = await adapter.inspect(ctx)
    const plan = await adapter.plan(ctx, {
      desiredCapability: 2,
      desiredComponents: ['memory_tools'],
      observed,
      ownedArtifacts: [],
    })

    expect(plan.mutations[0].physicalTarget).toBe(customFile)
    await adapter.apply(ctx, plan.mutations[0])
    expect(fs.existsSync(customFile)).toBe(true)
    expect(fs.existsSync(path.join(path.dirname(customFile), 'opencode.json'))).toBe(false)
  })

  it('keeps an exact OPENCODE_CONFIG JSONC file observe-only', async () => {
    const base = context('opencode-v2-beta-cli')
    const customFile = path.join(base.installation.canonicalConfigRoot, 'custom.jsonc')
    fs.writeFileSync(customFile, '{ // comments remain host-owned\n}')
    const ctx: AdapterOperationContext = {
      ...base,
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_01JABCDEF0123456789',
        productFamilyId: 'opencode',
        hostVariant: 'opencode-v2-beta-cli',
        configRoot: base.installation.canonicalConfigRoot,
        componentConfigFiles: { memory_tools: customFile },
      }),
    }
    const adapter = createP0JsonMcpAdapters().get('opencode-v2-beta-cli')!
    const observed = await adapter.inspect(ctx)
    const plan = await adapter.plan(ctx, {
      desiredCapability: 2,
      desiredComponents: ['memory_tools'],
      observed,
      ownedArtifacts: [],
    })

    expect(observed.detected).toBe(false)
    expect(plan.mutations).toEqual([])
    expect(fs.readFileSync(customFile, 'utf8')).toContain('// comments remain host-owned')
  })
})
