import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createP0JsonMcpAdapters, P0_JSON_MCP_SPECS } from '../../client/electron/agent-integration/hosts/p0-json-registry'
import { sha256Json } from '../../client/electron/agent-integration/fingerprint'
import { parseJsoncObject } from '../../client/electron/agent-integration/jsonc-document'
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

function legacyOpenCodeV2Entry(ctx: AdapterOperationContext) {
  return {
    type: 'local',
    command: [ctx.runtime.shimPath, ctx.runtime.mcpServerPath],
    environment: {
      EB_AGENT_ID: ctx.agentId,
      EB_HOST_VARIANT: ctx.installation.hostVariant,
    },
  }
}

function ownedMemoryArtifact(
  ctx: AdapterOperationContext,
  ownershipKey: string,
  ownedFragmentHash: string,
  selectorSchemaVersion = 1,
  physicalTarget?: string,
) {
  return {
    componentKey: 'memory_tools' as const,
    physicalTarget: physicalTarget ?? ctx.installation.componentConfigFiles?.memory_tools
      ?? path.join(ctx.installation.canonicalConfigRoot, 'opencode.json'),
    ownershipKey,
    ownedFragmentHash,
    selectorSchemaVersion,
  }
}

describe('P0 documented JSON MCP registry', () => {
  it('does not expose OpenClaw loose JSON MCP now that the native Plugin owns the surface', () => {
    expect(P0_JSON_MCP_SPECS['openclaw-local']).toBeUndefined()
    expect(createP0JsonMcpAdapters().has('openclaw-local')).toBe(false)
  })

  it('has one adapter for every declared JSON surface', () => {
    const adapters = createP0JsonMcpAdapters()
    expect([...adapters.keys()].sort()).toEqual(Object.keys(P0_JSON_MCP_SPECS).sort())
  })

  it('does not override OMP disabledServers and returns an actionable activation request', async () => {
    const adapter = createP0JsonMcpAdapters().get('omp-cli')!
    const ctx = context('omp-cli')
    const target = path.join(ctx.installation.canonicalConfigRoot, 'mcp.json')
    const document = { disabledServers: [`tidemind-${ctx.agentId}`, 'user-owned-server'] }
    fs.writeFileSync(target, JSON.stringify(document))
    const observed = await adapter.inspect(ctx)
    const plan = await adapter.plan(ctx, {
      desiredCapability: 2,
      desiredComponents: ['memory_tools'],
      observed,
      ownedArtifacts: [],
    })

    expect(observed.components[0].visibility).toBe('absent')
    expect(observed.diagnostics).toContain('omp_mcp_server_explicitly_disabled')
    expect(plan.mutations).toEqual([])
    expect(plan.requiredUserActions).toEqual([`remove_omp_mcp_disabled_server:tidemind-${ctx.agentId}`])
    expect(plan.requiredUserActionDetails).toEqual([
      expect.objectContaining({ kind: 'mcp_activation', reason: 'excluded' }),
    ])
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(document)
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

  it('uses one V1-compatible selector shape for a shared OpenCode V1/V2 config', async () => {
    const adapters = createP0JsonMcpAdapters()
    const v1 = context('opencode-v1-cli')
    const v2: AdapterOperationContext = {
      ...context('opencode-v2-beta-cli'),
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos', osUserIdentity: 'usr_01JABCDEF0123456789', productFamilyId: 'opencode',
        hostVariant: 'opencode-v2-beta-cli', configRoot: v1.installation.canonicalConfigRoot,
      }),
      agentId: 'eb_fixture_v2',
    }
    const plan1 = await adapters.get('opencode-v1-cli')!.plan(v1, {
      desiredCapability: 2, desiredComponents: ['memory_tools'],
      observed: await adapters.get('opencode-v1-cli')!.inspect(v1), ownedArtifacts: [],
    })
    await adapters.get('opencode-v1-cli')!.apply(v1, plan1.mutations[0])
    const plan2 = await adapters.get('opencode-v2-beta-cli')!.plan(v2, {
      desiredCapability: 2, desiredComponents: ['memory_tools'],
      observed: await adapters.get('opencode-v2-beta-cli')!.inspect(v2), ownedArtifacts: [],
    })
    expect(plan1.mutations[0].ownershipKey).toBe('mcp.tidemind-eb_fixture')
    expect(plan2.mutations[0].ownershipKey).toBe('mcp.tidemind-eb_fixture_v2')
    await adapters.get('opencode-v2-beta-cli')!.apply(v2, plan2.mutations[0])
    const document = JSON.parse(fs.readFileSync(path.join(v1.installation.canonicalConfigRoot, 'opencode.json'), 'utf8'))
    expect(Object.keys(document.mcp).sort()).toEqual(['tidemind-eb_fixture', 'tidemind-eb_fixture_v2'])
    expect(document.mcp.servers).toBeUndefined()
  })

  it('updates an OpenCode JSONC configuration without rewriting unrelated comments or formatting', async () => {
    const adapter = createP0JsonMcpAdapters().get('opencode-v1-cli')!
    const ctx = context('opencode-v1-cli')
    const target = path.join(ctx.installation.canonicalConfigRoot, 'opencode.jsonc')
    fs.writeFileSync(target, '{\n  // user-owned heading\n  "theme": "dark",\n}\n')
    const observed = await adapter.inspect(ctx)
    const plan = await adapter.plan(ctx, {
      desiredCapability: 2,
      desiredComponents: ['memory_tools'],
      observed,
      ownedArtifacts: [],
    })
    expect(observed.detected).toBe(true)
    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0].physicalTarget).toBe(target)
    await adapter.apply(ctx, plan.mutations[0])
    expect(await adapter.readBack(ctx, plan.mutations[0])).toMatchObject({ matchesDesired: true })
    const after = fs.readFileSync(target, 'utf8')
    expect(after).toContain('// user-owned heading')
    expect(after).toContain('  "theme": "dark",')
    expect(after).toContain('"tidemind-eb_fixture"')
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

  it('manages an exact OPENCODE_CONFIG JSONC file and preserves comments', async () => {
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

    expect(observed.detected).toBe(true)
    expect(plan.mutations).toHaveLength(1)
    await adapter.apply(ctx, plan.mutations[0])
    expect(await adapter.readBack(ctx, plan.mutations[0])).toMatchObject({ matchesDesired: true })
    expect(fs.readFileSync(customFile, 'utf8')).toContain('// comments remain host-owned')
  })

  it('atomically migrates an owned OpenCode V2 selector to the V1-compatible selector', async () => {
    const adapter = createP0JsonMcpAdapters().get('opencode-v2-beta-cli')!
    const ctx = context('opencode-v2-beta-cli')
    const target = path.join(ctx.installation.canonicalConfigRoot, 'opencode.json')
    const legacy = legacyOpenCodeV2Entry(ctx)
    fs.writeFileSync(target, JSON.stringify({
      theme: 'dark',
      mcp: {
        servers: {
          [`tidemind-${ctx.agentId}`]: legacy,
          remote: { type: 'remote', url: 'https://example.invalid/mcp' },
        },
      },
    }, null, 2))
    const baseline = ownedMemoryArtifact(
      ctx,
      `mcp.servers.tidemind-${ctx.agentId}`,
      sha256Json(legacy),
    )
    const plan = await adapter.plan(ctx, {
      desiredCapability: 3,
      desiredComponents: ['memory_tools'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: [baseline],
    })

    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      operation: 'create',
      ownershipKey: `mcp.tidemind-${ctx.agentId}`,
      selectorSchemaVersion: 1,
      preconditionHash: sha256Json(legacy),
      ownershipTransferFrom: {
        physicalTarget: target,
        ownershipKey: `mcp.servers.tidemind-${ctx.agentId}`,
        ownedFragmentHash: sha256Json(legacy),
        selectorSchemaVersion: 1,
      },
      metadata: {
        migrationSourceSelector: ['mcp', 'servers', `tidemind-${ctx.agentId}`],
        migrationSourceFragmentHash: sha256Json(legacy),
      },
    })
    expect(await adapter.readBack(ctx, plan.mutations[0])).toMatchObject({
      observed: true,
      matchesDesired: false,
      observedFragmentHash: sha256Json(legacy),
    })

    await adapter.apply(ctx, plan.mutations[0])
    expect(await adapter.readBack(ctx, plan.mutations[0])).toMatchObject({ matchesDesired: true })
    const after = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(after.theme).toBe('dark')
    expect(after.mcp[`tidemind-${ctx.agentId}`].enabled).toBe(true)
    expect(after.mcp.servers[`tidemind-${ctx.agentId}`]).toBeUndefined()
    expect(after.mcp.servers.remote.url).toBe('https://example.invalid/mcp')

    const idempotent = await adapter.plan(ctx, {
      desiredCapability: 3,
      desiredComponents: ['memory_tools'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: [ownedMemoryArtifact(
        ctx,
        `mcp.tidemind-${ctx.agentId}`,
        plan.mutations[0].desiredFragmentHash!,
        2,
      )],
    })
    expect(idempotent.mutations).toEqual([])
  })

  it('atomically migrates an owned OpenCode V2 selector inside JSONC without losing comments', async () => {
    const ctx = context('opencode-v2-beta-cli')
    const target = path.join(ctx.installation.canonicalConfigRoot, 'opencode.jsonc')
    const adapter = createP0JsonMcpAdapters().get('opencode-v2-beta-cli')!
    const legacy = legacyOpenCodeV2Entry(ctx)
    fs.writeFileSync(target, `{\n  // keep this host-owned comment\n  "theme": "dark",\n  "mcp": {\n    "servers": {\n      "tidemind-${ctx.agentId}": ${JSON.stringify(legacy)},\n      "remote": { "type": "remote" },\n    },\n  },\n}\n`)
    const plan = await adapter.plan(ctx, {
      desiredCapability: 3,
      desiredComponents: ['memory_tools'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: [ownedMemoryArtifact(
        ctx,
        `mcp.servers.tidemind-${ctx.agentId}`,
        sha256Json(legacy),
        1,
        target,
      )],
    })

    await adapter.apply(ctx, plan.mutations[0])
    const after = fs.readFileSync(target, 'utf8')
    const parsed = parseJsoncObject(after).root
    expect(after).toContain('// keep this host-owned comment')
    expect(parsed.theme).toBe('dark')
    expect((parsed.mcp as Record<string, unknown>)[`tidemind-${ctx.agentId}`]).toBeDefined()
    expect(((parsed.mcp as Record<string, unknown>).servers as Record<string, unknown>)[`tidemind-${ctx.agentId}`])
      .toBeUndefined()
    expect(((parsed.mcp as Record<string, unknown>).servers as Record<string, unknown>).remote).toEqual({ type: 'remote' })
  })

  it('fails closed on an unowned or drifted legacy OpenCode V2 selector', async () => {
    const adapter = createP0JsonMcpAdapters().get('opencode-v2-beta-cli')!
    const ctx = context('opencode-v2-beta-cli')
    const target = path.join(ctx.installation.canonicalConfigRoot, 'opencode.json')
    const legacy = legacyOpenCodeV2Entry(ctx)
    const original = JSON.stringify({ mcp: { servers: { [`tidemind-${ctx.agentId}`]: legacy } } }, null, 2)
    fs.writeFileSync(target, original)

    const unowned = await adapter.plan(ctx, {
      desiredCapability: 3,
      desiredComponents: ['memory_tools'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: [],
    })
    expect(unowned.mutations).toEqual([])
    expect(unowned.diagnostics).toContain('legacy_selector_occupied_without_ownership')

    const drifted = await adapter.plan(ctx, {
      desiredCapability: 3,
      desiredComponents: ['memory_tools'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: [ownedMemoryArtifact(
        ctx,
        `mcp.servers.tidemind-${ctx.agentId}`,
        sha256Json({ ...legacy, command: ['/old/shim', '/old/mcp'] }),
      )],
    })
    expect(drifted.mutations).toEqual([])
    expect(drifted.diagnostics).toContain('legacy_owned_fragment_modified')
    expect(fs.readFileSync(target, 'utf8')).toBe(original)
  })

  it('restores a missing owned V2 selector directly at the canonical selector', async () => {
    const adapter = createP0JsonMcpAdapters().get('opencode-v2-beta-cli')!
    const ctx = context('opencode-v2-beta-cli')
    const legacy = legacyOpenCodeV2Entry(ctx)
    const target = path.join(ctx.installation.canonicalConfigRoot, 'opencode.json')
    fs.writeFileSync(target, '{\n  "theme": "dark"\n}\n')
    const plan = await adapter.plan(ctx, {
      desiredCapability: 3,
      desiredComponents: ['memory_tools'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: [ownedMemoryArtifact(
        ctx,
        `mcp.servers.tidemind-${ctx.agentId}`,
        sha256Json(legacy),
      )],
    })

    expect(plan.mutations[0]).toMatchObject({
      operation: 'create',
      ownershipKey: `mcp.tidemind-${ctx.agentId}`,
      preconditionHash: undefined,
      metadata: { migrationSourceFragmentHash: null },
    })
    await adapter.apply(ctx, plan.mutations[0])
    const after = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(after.theme).toBe('dark')
    expect(after.mcp[`tidemind-${ctx.agentId}`]).toBeDefined()
    expect(after.mcp.servers).toBeUndefined()
  })

  it('disconnects an owned legacy V2 selector without creating the canonical selector', async () => {
    const adapter = createP0JsonMcpAdapters().get('opencode-v2-beta-cli')!
    const ctx = context('opencode-v2-beta-cli')
    const target = path.join(ctx.installation.canonicalConfigRoot, 'opencode.json')
    const legacy = legacyOpenCodeV2Entry(ctx)
    fs.writeFileSync(target, JSON.stringify({ mcp: { servers: { [`tidemind-${ctx.agentId}`]: legacy } } }))
    const baseline = ownedMemoryArtifact(
      ctx,
      `mcp.servers.tidemind-${ctx.agentId}`,
      sha256Json(legacy),
    )
    const plan = await adapter.disconnect(ctx, {
      componentKeys: ['memory_tools'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: [baseline],
    })

    expect(plan.mutations[0]).toMatchObject({
      operation: 'remove',
      ownershipKey: `mcp.servers.tidemind-${ctx.agentId}`,
      preconditionHash: sha256Json(legacy),
      selectorSchemaVersion: 1,
    })
    await adapter.apply(ctx, plan.mutations[0])
    expect(await adapter.readBack(ctx, plan.mutations[0])).toMatchObject({
      observed: false,
      matchesDesired: true,
    })
    const after = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(after.mcp).toBeUndefined()
  })

  it('rejects a concurrent container edit before an owned selector migration', async () => {
    const adapter = createP0JsonMcpAdapters().get('opencode-v2-beta-cli')!
    const ctx = context('opencode-v2-beta-cli')
    const target = path.join(ctx.installation.canonicalConfigRoot, 'opencode.json')
    const legacy = legacyOpenCodeV2Entry(ctx)
    fs.writeFileSync(target, JSON.stringify({ theme: 'dark', mcp: { servers: { [`tidemind-${ctx.agentId}`]: legacy } } }))
    const plan = await adapter.plan(ctx, {
      desiredCapability: 3,
      desiredComponents: ['memory_tools'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: [ownedMemoryArtifact(
        ctx,
        `mcp.servers.tidemind-${ctx.agentId}`,
        sha256Json(legacy),
      )],
    })
    fs.writeFileSync(target, JSON.stringify({ theme: 'light', mcp: { servers: { [`tidemind-${ctx.agentId}`]: legacy } } }))

    await expect(adapter.apply(ctx, plan.mutations[0])).rejects.toThrow(/container_precondition_changed/)
    const after = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(after.theme).toBe('light')
    expect(after.mcp[`tidemind-${ctx.agentId}`]).toBeUndefined()
    expect(after.mcp.servers[`tidemind-${ctx.agentId}`]).toEqual(legacy)
  })
})
