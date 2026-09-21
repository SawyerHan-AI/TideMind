import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CodexMcpTomlConflictError,
  createCodexMcpTomlHostAdapter,
} from '../../client/electron/agent-integration/hosts/codex-mcp-toml-adapter'
import type {
  AdapterOperationContext,
  AdapterPlanRequest,
  HostActivityEvidenceQuery,
  OwnedArtifactBaseline,
} from '../../client/electron/agent-integration/types'

describe('Codex MCP TOML Host Adapter', () => {
  let tempDir: string
  let configRoot: string
  let configFile: string
  let context: AdapterOperationContext

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-codex-mcp-test-')))
    configRoot = path.join(tempDir, '.codex')
    fs.mkdirSync(configRoot)
    configFile = path.join(configRoot, 'config.toml')
    context = createContext('codex-cli')
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates the exact identity-bound TOML table through CAS and verifies read-back', async () => {
    const adapter = createAdapter('codex-cli')
    const plan = await adapter.plan(context, await request(adapter))

    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      componentKey: 'memory_tools',
      operation: 'create',
      domainKind: 'file_fragment',
      physicalTarget: configFile,
      ownershipKey: 'mcp_servers.tidemind-agent-codex',
      reload: 'new_session',
    })
    await adapter.apply(context, plan.mutations[0]!)
    expect(await adapter.readBack(context, plan.mutations[0]!)).toMatchObject({
      matchesDesired: true,
      visibility: 'dedicated',
    })
    expect(parseToml(fs.readFileSync(configFile, 'utf8'))).toMatchObject({
      mcp_servers: {
        'tidemind-agent-codex': {
          enabled: true,
          command: context.runtime.shimPath,
          args: [context.runtime.mcpServerPath],
          env: {
            EB_AGENT_ID: 'agent-codex',
            EB_HOST_VARIANT: 'codex-cli',
          },
        },
      },
    })
  })

  it('preserves user TOML, nested MCP env subtables, and comments on connect/update/disconnect', async () => {
    const original = [
      'model = "gpt-5" # keep model comment',
      '',
      '[mcp_servers.user-tool] # keep tool comment',
      'command = "python"',
      'args = ["server.py"]',
      '',
      '[mcp_servers.user-tool.env]',
      'USER_TOKEN_NAME = "public-name"',
      '',
      '[features]',
      'multi_agent = true',
      '',
    ].join('\n')
    fs.writeFileSync(configFile, original)
    const adapter = createAdapter('codex-cli')
    const create = await adapter.plan(context, await request(adapter))
    await adapter.apply(context, create.mutations[0]!)
    const afterCreate = fs.readFileSync(configFile, 'utf8')
    expect(afterCreate).toContain('model = "gpt-5" # keep model comment')
    expect(afterCreate).toContain('[mcp_servers.user-tool] # keep tool comment')
    expect(afterCreate).toContain('[mcp_servers.user-tool.env]')
    expect(afterCreate).toContain('[features]')

    const baseline = ownedBaseline(create.mutations[0]!.desiredFragmentHash!)
    const noop = await adapter.plan(context, await request(adapter, [baseline]))
    expect(noop.mutations).toEqual([])

    const disconnect = await adapter.disconnect(context, {
      componentKeys: ['memory_tools'],
      observed: await adapter.inspect(context),
      ownedArtifacts: [baseline],
    })
    await adapter.apply(context, disconnect.mutations[0]!)
    const afterDisconnect = fs.readFileSync(configFile, 'utf8')
    expect(afterDisconnect).not.toContain('tidemind-agent-codex')
    expect(afterDisconnect).toContain('model = "gpt-5" # keep model comment')
    expect(afterDisconnect).toContain('[mcp_servers.user-tool] # keep tool comment')
    expect(afterDisconnect).toContain('[mcp_servers.user-tool.env]')
    expect(afterDisconnect).toContain('multi_agent = true')
    expect(() => parseToml(afterDisconnect)).not.toThrow()
  })

  it('adopts only an exact current or legacy identity-bearing Tide Mind table', async () => {
    fs.writeFileSync(configFile, [
      '[mcp_servers.tidemind-agent-codex]',
      'enabled = true',
      `command = ${JSON.stringify(context.runtime.shimPath)}`,
      `args = [${JSON.stringify(context.runtime.mcpServerPath)}]`,
      '',
      '[mcp_servers.tidemind-agent-codex.env]',
      'EB_AGENT_ID = "agent-codex"',
      'EB_HOST_VARIANT = "codex-cli"',
      'EB_ACTIVITY_GENERATION_TOKEN = "generation-codex-mcp"',
      '',
    ].join('\n'))
    const adapter = createAdapter('codex-cli')
    const adoptable = await adapter.inspectAdoptableArtifacts?.(context)
    expect(adoptable).toHaveLength(1)
    expect(adoptable?.[0]).toMatchObject({
      componentKey: 'memory_tools',
      ownershipKey: 'mcp_servers.tidemind-agent-codex',
      identityAssertion: 'agent-codex',
    })

    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace(
      'EB_AGENT_ID = "agent-codex"',
      'EB_AGENT_ID = "somebody-else"',
    ))
    expect(await adapter.inspectAdoptableArtifacts?.(context)).toEqual([])
  })

  it('upgrades an adopted legacy nested-env table without consuming the following user table', async () => {
    fs.writeFileSync(configFile, [
      '[mcp_servers.tidemind-agent-codex]',
      'enabled = true',
      `command = ${JSON.stringify(context.runtime.shimPath)}`,
      `args = [${JSON.stringify(context.runtime.mcpServerPath)}]`,
      '',
      '[mcp_servers.tidemind-agent-codex.env]',
      'EB_AGENT_ID = "agent-codex"',
      '',
      '[features] # must survive',
      'multi_agent = true',
      '',
    ].join('\n'))
    const adapter = createAdapter('codex-cli')
    const adopted = (await adapter.inspectAdoptableArtifacts?.({
      ...context,
      activityGenerationToken: undefined,
    }))![0]!
    const baseline: OwnedArtifactBaseline = {
      componentKey: 'memory_tools',
      physicalTarget: configFile,
      ownershipKey: adopted.ownershipKey,
      ownedFragmentHash: adopted.fragmentHash,
      selectorSchemaVersion: 1,
    }
    const update = await adapter.plan(context, await request(adapter, [baseline]))
    expect(update.mutations[0]?.operation).toBe('update')
    await adapter.apply(context, update.mutations[0]!)

    const source = fs.readFileSync(configFile, 'utf8')
    expect(source).toContain('EB_HOST_VARIANT')
    expect(source).toContain('[features] # must survive')
    expect(source).toContain('multi_agent = true')
    expect(parseToml(source)).toMatchObject({ features: { multi_agent: true } })
  })

  it('fails closed on malformed TOML, unowned selectors, drift, and post-plan container changes', async () => {
    const adapter = createAdapter('codex-cli')
    fs.writeFileSync(configFile, '[mcp_servers.broken\ncommand = "x"')
    const malformed = await adapter.inspect(context)
    expect(malformed.components[0]?.visibility).toBe('unknown')
    expect((await adapter.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['memory_tools'],
      observed: malformed,
      ownedArtifacts: [],
    })).mutations).toEqual([])

    fs.writeFileSync(configFile, [
      '[mcp_servers.tidemind-agent-codex]',
      'enabled = true',
      'command = "/user/owned"',
      'args = []',
      'env = { "EB_AGENT_ID" = "agent-codex" }',
      '',
    ].join('\n'))
    const occupied = await adapter.plan(context, await request(adapter))
    expect(occupied.diagnostics).toEqual(['mcp_table_already_occupied'])

    fs.rmSync(configFile)
    const planned = await adapter.plan(context, await request(adapter))
    fs.writeFileSync(configFile, 'model = "changed-after-plan"\n')
    await expect(adapter.apply(context, planned.mutations[0]!))
      .rejects.toBeInstanceOf(CodexMcpTomlConflictError)
  })

  it('requires fresh real brain activity after exact static MCP read-back', async () => {
    const adapter = createAdapter('codex-cli')
    const plan = await adapter.plan(context, await request(adapter))
    await adapter.apply(context, plan.mutations[0]!)

    let result = await adapter.verify(context, verificationRequest())
    expect(result[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })
    expect(result[0]?.diagnostics).toContain('host_activity_evidence_reader_unavailable')

    context.hostActivityEvidence = activityReader()
    result = await adapter.verify(context, verificationRequest())
    expect(result[0]).toMatchObject({ status: 'verified', verifiedCapability: 2 })
    expect(result[0]?.diagnostics).toContain('host_activity_recognized:brain_digest,brain_recall')
  })

  it('freezes CLI and Desktop onto one config.toml physical domain', async () => {
    const cli = createAdapter('codex-cli')
    const desktop = createAdapter('codex-desktop')
    const cliContext = createContext('codex-cli')
    const desktopContext = createContext('codex-desktop')
    const [cliPlan, desktopPlan] = await Promise.all([
      cli.plan(cliContext, await request(cli, [], cliContext)),
      desktop.plan(desktopContext, await request(desktop, [], desktopContext)),
    ])
    expect(cliPlan.mutations[0]?.physicalTarget).toBe(configFile)
    expect(desktopPlan.mutations[0]?.physicalTarget).toBe(configFile)
    expect(cliPlan.mutations[0]?.ownershipKey).toBe(desktopPlan.mutations[0]?.ownershipKey)
    expect(cliPlan.mutations[0]?.containerPreconditionHash).toBe(desktopPlan.mutations[0]?.containerPreconditionHash)
  })

  function createAdapter(catalogId: 'codex-cli' | 'codex-desktop') {
    return createCodexMcpTomlHostAdapter({ catalogId, adapterVersion: '8' })
  }

  function createContext(hostVariant: 'codex-cli' | 'codex-desktop'): AdapterOperationContext {
    return {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: tempDir,
        applicationDataDir: path.join(tempDir, 'app-data'),
        shimPath: path.join(tempDir, 'runtime', 'node'),
        mcpServerPath: path.join(tempDir, 'runtime', 'mcp-server.cjs'),
        hookScriptPath: path.join(tempDir, 'runtime', 'hook-session-start.cjs'),
        preCompactScriptPath: path.join(tempDir, 'runtime', 'hook-pre-compact.cjs'),
        postCompactScriptPath: path.join(tempDir, 'runtime', 'hook-post-compact.cjs'),
        tideMindVersion: '0.2.92',
        catalogVersion: 'catalog-8',
        projectionVersion: 'projection-8',
      },
      installation: {
        runtimeRealm: 'local_macos',
        osUserIdentity: 'uid:501',
        productFamilyId: 'codex',
        hostVariant,
        canonicalConfigRoot: configRoot,
        componentConfigFiles: { memory_tools: configFile },
        explicitProfile: 'default',
        distribution: { executableRealpath: '/bin/echo' },
        installKey: `codex:${hostVariant}:default`,
      },
      agentId: 'agent-codex',
      operationId: 'operation-codex',
      activityGenerationToken: 'generation-codex-mcp',
    }
  }

  async function request(
    adapter: ReturnType<typeof createAdapter>,
    ownedArtifacts: readonly OwnedArtifactBaseline[] = [],
    operationContext = context,
  ): Promise<AdapterPlanRequest> {
    return {
      desiredCapability: 4,
      desiredComponents: ['memory_tools'],
      observed: await adapter.inspect(operationContext),
      ownedArtifacts,
    }
  }

  function ownedBaseline(hash: string): OwnedArtifactBaseline {
    return {
      componentKey: 'memory_tools',
      physicalTarget: configFile,
      ownershipKey: 'mcp_servers.tidemind-agent-codex',
      ownedFragmentHash: hash,
      selectorSchemaVersion: 1,
    }
  }

  function verificationRequest() {
    return {
      componentKeys: ['memory_tools'] as const,
      expectedCapability: 4 as const,
      inspection: {} as never,
      activityBinding: {
        installationId: 'installation-codex',
        tideMindVersion: '0.2.92',
        adapterVersion: '8',
        projectionVersion: 'projection-8',
        hostVersion: '0.145.0',
        activationRunId: 'run-codex-mcp',
        activityGenerationToken: 'generation-codex-mcp',
        observedAfter: '2026-09-03T00:00:00.000Z',
        verifiedAt: '2026-09-03T00:05:00.000Z',
      },
    }
  }

  function activityReader() {
    return {
      find: async (query: HostActivityEvidenceQuery) => {
        expect(query).toMatchObject({
          activationRunId: 'run-codex-mcp',
          activityGenerationToken: 'generation-codex-mcp',
        })
        return query.signalNames.map((signalName, index) => ({
          id: `activity-mcp-${index + 1}`,
          installationId: query.installationId,
          agentId: query.agentId,
          hostVariant: query.hostVariant,
          componentKey: query.componentKey,
          signalName,
          tideMindVersion: query.tideMindVersion,
          adapterVersion: query.adapterVersion,
          projectionVersion: query.projectionVersion,
          hostVersion: query.hostVersion,
          evidenceHash: `activity-hash-${signalName}`,
          observedAt: '2026-09-03T00:03:00.000Z',
        }))
      },
    }
  }
})
