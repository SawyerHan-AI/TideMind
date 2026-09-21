import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { createClaudeCoworkGuidedHostAdapter } from '../../client/electron/agent-integration/hosts/claude-cowork-guided-adapter'
import { verifyCoworkPluginArchive } from '../../scripts/agent-integration-cowork-archive-evidence.mjs'
import type {
  AdapterOperationContext,
  HostActivityEvidenceRecord,
  OwnedArtifactBaseline,
} from '../../client/electron/agent-integration/types'

describe('Claude Cowork guided plugin Adapter', () => {
  let root: string
  let context: AdapterOperationContext

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-guided-'))
    const appData = path.join(root, 'app-data')
    const exportRoot = path.join(appData, 'agent-integration', 'claude-cowork', 'installation-cowork')
    const target = path.join(exportRoot, 'tidemind-cowork.plugin')
    fs.mkdirSync(appData)
    context = {
      runtime: {
        runtimeRealm: 'local_macos', homeDir: root, applicationDataDir: appData,
        shimPath: '/Applications/Tide Mind.app/Contents/Resources/tm-node',
        mcpServerPath: '/Applications/Tide Mind.app/Contents/Resources/mcp-server.cjs',
        hookScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook-session-start.cjs',
        preCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook-pre-compact.cjs',
        postCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook-post-compact.cjs',
        tideMindVersion: '0.2.92', catalogVersion: '2026-09-02', projectionVersion: '1',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos', osUserIdentity: 'usr_cowork', productFamilyId: 'claude-cowork',
        hostVariant: 'claude-cowork-local', configRoot: path.join(root, 'Library', 'Application Support', 'Claude'),
        explicitProfile: 'cowork-user-guided',
        componentConfigRoots: { instruction: exportRoot, memory_tools: exportRoot },
        componentConfigFiles: { instruction: target, memory_tools: target },
        distribution: {
          distributionId: 'com.anthropic.claudefordesktop',
          executableRealpath: '/Applications/Claude.app/Contents/MacOS/Claude',
          packageProvenance: 'signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW',
          capabilityFingerprint: 'desktop-bundle-surface-v1:abc',
        },
      }),
      installationId: 'installation-cowork', hostVersion: '1.2.3',
      agentId: 'eb_cowork_1234', operationId: 'operation-cowork',
      activityGenerationToken: 'generation-cowork-1234',
    }
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('exports one exact agent-bound .plugin archive without touching Claude Desktop config', async () => {
    const adapter = createClaudeCoworkGuidedHostAdapter()
    const observed = await adapter.inspect(context)
    const plan = await adapter.plan(context, {
      desiredCapability: 3, desiredComponents: ['instruction', 'memory_tools'], observed, ownedArtifacts: [],
    })
    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      componentKey: 'instruction', coveredComponentKeys: ['instruction', 'memory_tools'],
      domainKind: 'file_fragment', operation: 'create', reload: 'user_confirmation',
    })
    expect(plan.requiredUserActionDetails?.[0]).toMatchObject({
      kind: 'claude_cowork_plugin_upload', operation: 'connect', hostVariant: 'claude-cowork-local',
      packageName: 'tidemind-cowork.plugin',
    })
    const action = plan.requiredUserActionDetails?.[0]
    if (action?.kind !== 'claude_cowork_plugin_upload') throw new Error('unexpected action')
    expect(action.steps.join('\n')).toContain('brain_recall')
    expect(action.steps.join('\n')).toContain('brain_digest')
    expect(action.steps.join('\n')).not.toMatch(/任一|brain_prepare、brain_recall 或 brain_digest/u)
    await adapter.apply(context, plan.mutations[0])
    expect((await adapter.readBack(context, plan.mutations[0])).matchesDesired).toBe(true)
    const target = context.installation.componentConfigFiles!.instruction!
    const archive = fs.readFileSync(target)
    expect(archive.readUInt32LE(0)).toBe(0x04034b50)
    expect(archive.toString('utf8')).toContain('EB_HOST_VARIANT')
    expect(archive.toString('utf8')).toContain('claude-cowork-local')
    expect(fs.existsSync(path.join(root, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))).toBe(false)
  })

  it('is idempotent only with exact aggregate ownership and fails closed on an unowned collision', async () => {
    const adapter = createClaudeCoworkGuidedHostAdapter()
    const first = await adapter.plan(context, {
      desiredCapability: 3, desiredComponents: ['instruction', 'memory_tools'],
      observed: await adapter.inspect(context), ownedArtifacts: [],
    })
    await adapter.apply(context, first.mutations[0])
    const hash = first.mutations[0].desiredFragmentHash!
    const target = first.mutations[0].physicalTarget
    const owned: OwnedArtifactBaseline[] = (['instruction', 'memory_tools'] as const).map(componentKey => ({
      componentKey, physicalTarget: target, ownershipKey: first.mutations[0].ownershipKey,
      ownedFragmentHash: hash, selectorSchemaVersion: 1,
    }))
    const stable = await adapter.plan(context, {
      desiredCapability: 3, desiredComponents: ['instruction', 'memory_tools'],
      observed: await adapter.inspect(context), ownedArtifacts: owned,
    })
    expect(stable.mutations).toEqual([])
    const collision = await adapter.plan(context, {
      desiredCapability: 3, desiredComponents: ['instruction', 'memory_tools'],
      observed: await adapter.inspect(context), ownedArtifacts: [],
    })
    expect(collision.diagnostics).toContain('claude_cowork_plugin_archive_exists_without_exact_ownership')
  })

  it('rejects CRC corruption and an unexpected central-directory entry set', async () => {
    const adapter = createClaudeCoworkGuidedHostAdapter()
    const plan = await adapter.plan(context, {
      desiredCapability: 3, desiredComponents: ['instruction', 'memory_tools'],
      observed: await adapter.inspect(context), ownedArtifacts: [],
    })
    await adapter.apply(context, plan.mutations[0])
    const target = plan.mutations[0].physicalTarget
    const archive = fs.readFileSync(target)
    const corrupted = Buffer.from(archive)
    corrupted[corrupted.indexOf(Buffer.from('Tide Mind'))] ^= 0x01
    fs.writeFileSync(target, corrupted)
    expect(() => verifyCoworkPluginArchive({
      pluginPath: target, expectedArchive: archive, expectedEntries: {},
    })).toThrow(/integrity\/CRC check failed/)

    fs.writeFileSync(target, archive)
    expect(() => verifyCoworkPluginArchive({
      pluginPath: target, expectedArchive: archive, expectedEntries: {},
    })).toThrow(/entries differ/)
  })

  it('verifies the archive without an external unzip executable', () => {
    const verifierSource = fs.readFileSync(
      path.resolve('scripts/agent-integration-cowork-archive-evidence.mjs'),
      'utf8',
    )
    expect(verifierSource).not.toMatch(/spawnSync|\/usr\/bin\/unzip/u)
  })

  it('rejects ZIP structures outside the deterministic generator contract before frozen-byte comparison', async () => {
    const adapter = createClaudeCoworkGuidedHostAdapter()
    const plan = await adapter.plan(context, {
      desiredCapability: 3, desiredComponents: ['instruction', 'memory_tools'],
      observed: await adapter.inspect(context), ownedArtifacts: [],
    })
    await adapter.apply(context, plan.mutations[0])
    const target = plan.mutations[0].physicalTarget
    const archive = fs.readFileSync(target)
    const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    const central = archive.readUInt32LE(eocd + 16)

    const reject = (candidate: Buffer, expected: RegExp) => {
      fs.writeFileSync(target, candidate)
      expect(() => verifyCoworkPluginArchive({
        pluginPath: target,
        expectedArchive: candidate,
        expectedEntries: {},
      })).toThrow(expected)
    }

    const flags = Buffer.from(archive)
    flags.writeUInt16LE(0, 6)
    flags.writeUInt16LE(0, central + 8)
    reject(flags, /flags or compression/)

    const prefixed = Buffer.concat([Buffer.from([0]), archive])
    const prefixedEocd = eocd + 1
    const prefixedCentral = central + 1
    prefixed.writeUInt32LE(prefixedCentral, prefixedEocd + 16)
    let centralCursor = prefixedCentral
    const entryCount = prefixed.readUInt16LE(prefixedEocd + 10)
    for (let index = 0; index < entryCount; index += 1) {
      prefixed.writeUInt32LE(prefixed.readUInt32LE(centralCursor + 42) + 1, centralCursor + 42)
      centralCursor += 46
        + prefixed.readUInt16LE(centralCursor + 28)
        + prefixed.readUInt16LE(centralCursor + 30)
        + prefixed.readUInt16LE(centralCursor + 32)
    }
    reject(prefixed, /archive prefix, entry gap, or reordered local entry/)

    const gapBeforeCentral = Buffer.concat([
      archive.subarray(0, central), Buffer.from([0]), archive.subarray(central),
    ])
    gapBeforeCentral.writeUInt32LE(central + 1, eocd + 1 + 16)
    reject(gapBeforeCentral, /gap before its central directory/)

    const localExtra = Buffer.from(archive)
    localExtra.writeUInt16LE(1, 28)
    reject(localExtra, /local entry must not contain an extra field/)

    const centralExtra = Buffer.from(archive)
    centralExtra.writeUInt16LE(1, central + 30)
    reject(centralExtra, /central entry must not contain extra fields or comments/)

    const centralComment = Buffer.from(archive)
    centralComment.writeUInt16LE(1, central + 32)
    reject(centralComment, /central entry must not contain extra fields or comments/)

    const archiveComment = Buffer.concat([archive, Buffer.from([0])])
    archiveComment.writeUInt16LE(1, eocd + 20)
    reject(archiveComment, /must not contain an archive comment/)

    const externalAttributes = Buffer.from(archive)
    externalAttributes.writeUInt32LE((0o100644 << 16) >>> 0, central + 38)
    reject(externalAttributes, /regular-file attributes are invalid/)
  })

  it('requires fresh brain activity before both packaged components reach C3', async () => {
    const adapter = createClaudeCoworkGuidedHostAdapter()
    const plan = await adapter.plan(context, {
      desiredCapability: 3, desiredComponents: ['instruction', 'memory_tools'],
      observed: await adapter.inspect(context), ownedArtifacts: [],
    })
    await adapter.apply(context, plan.mutations[0])
    const evidence = (signalName: 'brain_recall' | 'brain_digest'): HostActivityEvidenceRecord => ({
      id: `e-${signalName}`, installationId: context.installationId!, agentId: context.agentId,
      hostVariant: 'claude-cowork-local', componentKey: 'memory_tools', signalName,
      tideMindVersion: '0.2.92', adapterVersion: '1', projectionVersion: '1', hostVersion: '1.2.3',
      evidenceHash: `runtime-proof-${signalName}`, observedAt: '2026-09-03T00:00:05.000Z',
    })
    context.hostActivityEvidence = { find: () => [evidence('brain_recall')] }
    const request = {
      componentKeys: ['instruction', 'memory_tools'] as const, expectedCapability: 3 as const,
      inspection: await adapter.inspect(context),
      activityBinding: {
        installationId: context.installationId!, tideMindVersion: '0.2.92', adapterVersion: '1',
        projectionVersion: '1', hostVersion: '1.2.3',
        activationRunId: 'run-cowork', activityGenerationToken: 'generation-cowork-1234',
        activationEpoch: '2026-09-03T00:00:00.000Z',
        observedAfter: '2026-09-03T00:00:00.000Z', verifiedAt: '2026-09-03T00:00:10.000Z',
      },
    }
    const { activityGenerationToken: _missingToken, ...missingTokenBinding } = request.activityBinding
    const missingTokenResults = await adapter.verify(context, {
      ...request,
      activityBinding: missingTokenBinding,
    })
    expect(missingTokenResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        componentKey: 'memory_tools',
        status: 'unverified',
        diagnostics: ['host_activity_evidence_reader_unavailable'],
      }),
    ]))
    expect((await adapter.verify(context, request)).every(result => result.status === 'unverified')).toBe(true)
    context.hostActivityEvidence = { find: () => [evidence('brain_recall'), evidence('brain_digest')] }
    const results = await adapter.verify(context, {
      ...request,
      inspection: await adapter.inspect(context),
    })
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentKey: 'instruction', status: 'verified', verifiedCapability: 1 }),
      expect.objectContaining({ componentKey: 'memory_tools', status: 'verified', verifiedCapability: 2 }),
    ]))
  })

  it('never claims machine-readable disconnect completion', async () => {
    const adapter = createClaudeCoworkGuidedHostAdapter()
    const observed = await adapter.inspect(context)
    const plan = await adapter.disconnect(context, {
      componentKeys: ['instruction', 'memory_tools'], observed, ownedArtifacts: [],
    })
    expect(plan.mutations).toEqual([])
    expect(plan.requiredUserActionDetails?.[0]).toMatchObject({ operation: 'disconnect' })
    const result = await adapter.verify(context, { componentKeys: ['instruction'], expectedCapability: 0, inspection: observed })
    expect(result[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })
  })
})
