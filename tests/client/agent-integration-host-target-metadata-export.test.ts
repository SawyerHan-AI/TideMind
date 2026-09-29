import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertNativeAgentHostAcceptanceExecutionEnvironment,
  exportAgentHostTargetMetadata,
  currentUserOwnedCustomActivityProof,
  directoryIdentitySha256,
  inspectAgentHostAcceptanceExecutionEnvironment,
  readAgentHostPhysicalDistribution,
} from '../../client/electron/agent-integration/host-target-metadata-export'
import { sha256Json } from '../../client/electron/agent-integration/fingerprint'
import type { AgentReleaseDistributionArtifactReceipt } from '../../client/electron/agent-integration/release-manifest'
import type { DiscoveredInstallation } from '../../client/electron/agent-integration/discovery'
import type { AgentInstallationRow } from '../../client/electron/agent-integration/repository'
import { metadataEvidenceRuntimeContext } from '../../client/electron/agent-integration/production-service'

import * as productionService from '../../client/electron/agent-integration/production-service'
import { ensureSchema } from '../../src/db/schema'
import { recordHostActivityEvidence } from '../../src/db/agent-host-activity'
import { customMcpConfiguration, type CustomMcpSchema } from '../../client/electron/agent-integration/hosts/custom-mcp-configuration'
import { readStableFileFingerprint } from '../../client/electron/agent-integration/passive-cli-version'
import { AGENT_INTEGRATION_RELEASE_MANIFEST as manifest } from '../../client/electron/agent-integration/release-manifest'

vi.mock('../../client/node_modules/better-sqlite3/lib/index.js', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url)('better-sqlite3') }
})
const databases: Database.Database[] = []

const roots: string[] = []
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

afterEach(() => {
  databases.splice(0).forEach(db => db.close())
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-target-export-'))
  roots.push(root)
  const architecture = process.arch === 'x64' ? 'x64' : 'arm64'
  const executablePath = path.join(root, 'bin', 'agent')
  const configRoot = path.join(root, 'config')
  const distributionId = 'npm:fixture-agent'
  const executableSha256 = hash('executable')
  const distributionSha256 = hash('distribution')
  const portableArtifactFingerprint = hash('portable')
  const receipt: AgentReleaseDistributionArtifactReceipt = {
    distributionId,
    packageProvenance: 'npm_metadata:fixture-agent',
    version: '1.2.3',
    architecture,
    artifactSha256: hash('artifact'),
    artifactSizeBytes: 303,
    executableSha256,
    executableSizeBytes: 101,
    distributionSha256,
    distributionSizeBytes: 202,
    portableFingerprintSchema: 'npm-owned-package-surface-v1',
    portableArtifactFingerprint,
    signedCode: null,
    npmPackage: {
      integrity: null,
      ownedPackageSha256: distributionSha256,
      ownedEntryCount: 2,
      ownedTotalBytes: 202,
      proofNodes: [],
    },
  }
  const identity = {
    runtimeRealm: 'local_macos' as const,
    osUserIdentity: 'usr_fixture_1234',
    productFamilyId: 'codex' as const,
    hostVariant: 'codex-cli' as const,
    canonicalConfigRoot: configRoot,
    explicitProfile: 'default',
    distribution: {
      distributionId,
      executableRealpath: executablePath,
      packageProvenance: receipt.packageProvenance,
      portableArtifactFingerprint,
    },
    installKey: 'fixture-install-key',
  }
  const discovered: DiscoveredInstallation = {
    catalogId: 'codex-cli',
    displayName: 'Fixture Agent',
    identity,
    configRoot,
    executablePath,
    detectedVersion: receipt.version,
    versionDetectionMethod: 'cli_version',
    managementEligibility: { eligible: true, reason: 'eligible' },
    provenance: ['fixture'],
    evidence: [],
  }
  const row: AgentInstallationRow = {
    id: 'installation-fixture',
    family: 'codex',
    host_variant: discovered.catalogId,
    runtime_realm: identity.runtimeRealm,
    profile_id: 'default',
    install_key: identity.installKey,
    distribution_id: distributionId,
    provenance: 'fixture',
    os_user_identity: identity.osUserIdentity,
    display_name: discovered.displayName,
    display_alias: null,
    config_root: configRoot,
    executable_path: executablePath,
    app_path: null,
    detected_version: receipt.version,
    version_detection_method: 'cli_version',
    agent_id: 'agent-fixture',
    desired_state: 'managed',
    tombstoned_at: null,
    tombstone_reason: null,
    consent_envelope_id: 'consent-fixture',
    consented_at: '2026-09-05T00:00:00.000Z',
    supported_capability: 4,
    desired_capability: 4,
    verified_capability: 4,
    delivery_summary: 'fully_managed',
    verification_summary: 'verified',
    health_state: 'healthy',
    status_reason: null,
    reconcile_state: 'idle',
    last_detected_at: '2026-09-05T00:00:00.000Z',
    last_verified_at: '2026-09-05T00:00:00.000Z',
    verification_result_id: 'verification-fixture',
    last_repaired_at: null,
    metadata_json: '{}',
    created_at: '2026-09-05T00:00:00.000Z',
    updated_at: '2026-09-05T00:00:00.000Z',
  }
  return {
    root,
    architecture,
    receipt,
    row,
    discovered,
    physicalDistribution: {
      rawExecutableSha256: executableSha256,
      rawExecutableSizeBytes: receipt.executableSizeBytes,
      executableSha256,
      executableSizeBytes: receipt.executableSizeBytes,
      distributionSha256,
      distributionSizeBytes: receipt.distributionSizeBytes,
    },
  }
}

describe('formal host target metadata exporter', () => {
  it.runIf(process.platform === 'darwin')('reads the current physical macOS execution environment', () => {
    const environment = inspectAgentHostAcceptanceExecutionEnvironment()
    expect(environment.processArchitecture).toBe(process.arch === 'x64' ? 'x64' : 'arm64')
    expect(() => assertNativeAgentHostAcceptanceExecutionEnvironment(environment)).not.toThrow()
  })

  it('treats an absent proc_translated sysctl on Intel as native without a shell', () => {
    const calls: string[] = []
    const environment = inspectAgentHostAcceptanceExecutionEnvironment({
      platform: 'darwin',
      processArchitecture: 'x64',
      executeSysctl: name => {
        calls.push(name)
        if (name === 'hw.optional.arm64') return { status: 0, stdout: '0\n', stderr: '' }
        return { status: 1, stdout: '', stderr: "sysctl: unknown oid 'sysctl.proc_translated'\n" }
      },
    })
    expect(calls).toEqual(['hw.optional.arm64', 'sysctl.proc_translated'])
    expect(environment).toEqual({
      processArchitecture: 'x64', hardwareArchitecture: 'x86_64', translationMode: 'not_translated',
    })
    expect(() => assertNativeAgentHostAcceptanceExecutionEnvironment(environment)).not.toThrow()
  })

  it('detects Rosetta explicitly and rejects it from formal real-host acceptance', () => {
    const environment = inspectAgentHostAcceptanceExecutionEnvironment({
      platform: 'darwin',
      processArchitecture: 'x64',
      executeSysctl: name => ({
        status: 0,
        stdout: name === 'hw.optional.arm64' ? '1\n' : '1\n',
        stderr: '',
      }),
    })
    expect(environment).toEqual({
      processArchitecture: 'x64', hardwareArchitecture: 'arm64', translationMode: 'rosetta',
    })
    expect(() => assertNativeAgentHostAcceptanceExecutionEnvironment(environment))
      .toThrow(/Rosetta is compatibility preflight only/)
  })

  it('fails closed when proc_translated is missing on Apple silicon', () => {
    expect(() => inspectAgentHostAcceptanceExecutionEnvironment({
      platform: 'darwin',
      processArchitecture: 'arm64',
      executeSysctl: name => name === 'hw.optional.arm64'
        ? { status: 0, stdout: '1\n', stderr: '' }
        : { status: 1, stdout: '', stderr: "sysctl: unknown oid 'sysctl.proc_translated'\n" },
    })).toThrow(/translation state is unavailable/)
  })

  it('matches the canonical directory fingerprint frozen by Custom preflight', () => {
    const data = fixture()
    const root = fs.realpathSync(data.root)
    const stat = fs.statSync(root, { bigint: true })
    expect(directoryIdentitySha256(root)).toBe(sha256Json({
      realpath: root, device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
    }))
  })

  it('exports a signed Kimi CLI physical surface without consulting local updater state', async () => {
    const data = fixture()
    const executable = path.join(data.root, 'bin', 'kimi')
    const bytes = Buffer.from('signed-kimi-fixture')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, bytes, { mode: 0o700 })
    const executableSha256 = hash(bytes.toString())
    const receipt: AgentReleaseDistributionArtifactReceipt = {
      ...data.receipt,
      distributionId: 'cli:kimi-code-native',
      packageProvenance: 'signed_cli:identifier=kimi;team=2J9472RW75',
      version: '0.41.0',
      executableSha256,
      executableSizeBytes: bytes.length,
      distributionSha256: executableSha256,
      distributionSizeBytes: bytes.length,
      portableFingerprintSchema: 'signed-cli-kimi-release-v2',
      signedCode: {
        identifier: 'kimi', teamIdentifier: '2J9472RW75', cdhash: 'a'.repeat(40),
        designatedRequirement: 'identifier "kimi" and anchor apple generic',
      },
      npmPackage: null,
    }
    const discovered: DiscoveredInstallation = {
      ...data.discovered,
      catalogId: 'kimi-code-native',
      executablePath: executable,
      detectedVersion: receipt.version,
      versionDetectionMethod: 'release_receipt',
    }
    let updaterStateReads = 0
    const physical = await readAgentHostPhysicalDistribution(receipt, discovered, {
      readExecutable: async () => ({
        sha256: executableSha256, size: bytes.length, executable: true, fingerprint: hash('stable'),
      }),
      inspectCliVersion: async () => {
        updaterStateReads += 1
        throw new Error('local updater state must not be read')
      },
    } as never)
    expect(updaterStateReads).toBe(0)
    expect(physical).toEqual({
      rawExecutableSha256: executableSha256,
      rawExecutableSizeBytes: bytes.length,
      executableSha256,
      executableSizeBytes: bytes.length,
      distributionSha256: executableSha256,
      distributionSizeBytes: bytes.length,
    })
  })
  it('resolves Custom Adapter paths under Electron-as-Node without the GUI app API', () => {
    const home = '/Users/acceptance'
    const contents = '/Candidates/Tide Mind.app/Contents'
    const runtime = metadataEvidenceRuntimeContext(home, `${contents}/MacOS/Tide Mind`)
    expect(runtime.shimPath).toBe(`${home}/.tidemind/bin/tm-node`)
    expect(runtime.mcpServerPath).toBe(`${contents}/Resources/app.asar.unpacked/out/bin/mcp-server.cjs`)
    expect(runtime.hookScriptPath).toBe(`${contents}/Resources/app.asar.unpacked/out/bin/hook-session-start.cjs`)
    expect(() => metadataEvidenceRuntimeContext(home, '/usr/bin/node'))
      .toThrow('requires the packaged candidate executable')
  })
  it('exports only fixture-injected physical evidence to a new explicit file', async () => {
    const data = fixture()
    const outputPath = path.join(data.root, 'target.json')
    await exportAgentHostTargetMetadata({
      targetKey: `codex-cli:${data.architecture}:${encodeURIComponent(data.receipt.distributionId)}`,
      candidateBundleSha256: hash('candidate'),
      sourceCommit: 'a'.repeat(40),
      releaseContractSha256: hash('contract'),
      outputPath,
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      fixture: {
        receipt: data.receipt,
        row: data.row,
        discovered: data.discovered,
        liveTrustProof: hash('attestation'),
        physicalDistribution: data.physicalDistribution,
        osVersion: '15.6.1',
        hostIdentitySha256: hash('anonymous-host'),
      },
    })

    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    expect(output.evidenceClass).toBe('fixture')
    expect(output.targetMetadata).toMatchObject({
      targetId: 'codex-cli',
      installationId: data.row.id,
      agentId: data.row.agent_id,
      distribution: data.physicalDistribution,
    })
    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600)
    expect(output.exportHash).toBe(hash(JSON.stringify({
      exporterVersion: output.exporterVersion,
      evidenceClass: output.evidenceClass,
      candidateBundleSha256: output.candidateBundleSha256,
      sourceCommit: output.sourceCommit,
      releaseContractSha256: output.releaseContractSha256,
      targetMetadata: output.targetMetadata,
      exportedAt: output.exportedAt,
    })))
  })

  it('rejects a physical distribution that differs from the immutable receipt', async () => {
    const data = fixture()
    await expect(exportAgentHostTargetMetadata({
      targetKey: `codex-cli:${data.architecture}:${encodeURIComponent(data.receipt.distributionId)}`,
      candidateBundleSha256: hash('candidate'),
      sourceCommit: 'a'.repeat(40),
      releaseContractSha256: hash('contract'),
      outputPath: path.join(data.root, 'target.json'),
      fixture: {
        receipt: data.receipt,
        row: data.row,
        discovered: data.discovered,
        liveTrustProof: hash('attestation'),
        physicalDistribution: { ...data.physicalDistribution, distributionSha256: hash('tampered') },
        osVersion: '15.6.1',
        hostIdentitySha256: hash('anonymous-host'),
      },
    })).rejects.toThrow('live physical distribution does not match')
  })

  it('refuses to create parent directories for the output', async () => {
    const data = fixture()
    await expect(exportAgentHostTargetMetadata({
      targetKey: `codex-cli:${data.architecture}:${encodeURIComponent(data.receipt.distributionId)}`,
      candidateBundleSha256: hash('candidate'),
      sourceCommit: 'a'.repeat(40),
      releaseContractSha256: hash('contract'),
      outputPath: path.join(data.root, 'missing', 'target.json'),
      fixture: {
        receipt: data.receipt,
        row: data.row,
        discovered: data.discovered,
        liveTrustProof: hash('attestation'),
        physicalDistribution: data.physicalDistribution,
        osVersion: '15.6.1',
        hostIdentitySha256: hash('anonymous-host'),
      },
    })).rejects.toThrow()
    expect(fs.existsSync(path.join(data.root, 'missing'))).toBe(false)
  })
})

const T0 = '2026-09-05T00:00:00.000Z', T1 = '2026-09-05T00:01:00.000Z', T2 = '2026-09-05T00:02:00.000Z'
const runtime = metadataEvidenceRuntimeContext('/fixture/home', '/fixture/Tide Mind.app/Contents/MacOS/Tide Mind')

function userOwnedActivityFixture(schemaKind: CustomMcpSchema = 'standard_mcp_servers', selectorKey = 'tidemind') {
  const db = new Database(':memory:'); databases.push(db); ensureSchema(db)
  db.prepare("INSERT INTO agents(id,name,tool_type,created) VALUES('eb_custom','Custom','custom',?)").run(T0)
  db.prepare(`INSERT INTO agent_installations(id,family,host_variant,profile_id,install_key,display_name,
    agent_id,detected_version,desired_state,health_state,metadata_json,created_at,updated_at)
    VALUES('custom','custom-local-agent','custom-local-mcp',?,'custom','Custom',
      'eb_custom','custom-123','managed','discovered',?,?,?)`)
    .run(`custom-guided:${schemaKind}:${selectorKey}`, JSON.stringify({ customInstallation: {
      kind: 'manual_mcp_client', configurationOwnership: 'user', schemaKind, selectorKey,
    } }), T0, T0)
  db.prepare(`INSERT INTO agent_consents(id,installation_id,policy_version,allowed_components_json,
    allowed_scopes_json,normalized_targets_json,selector_schema_version,selector_resolution_json,
    executable_realpaths_json,command_categories_json,maximum_risk,status,confirmed_at,created_at)
    VALUES('consent','custom','1','["memory_tools"]','[]','[]','1','{}','[]','[]','low','active',?,?)`).run(T0,T0)
  db.prepare("UPDATE agent_installations SET consent_envelope_id='consent'").run()
  db.prepare(`INSERT INTO installation_components(installation_id,component_key,desired_state,delivery_mode,
    verification_status,visibility_state,consent_envelope_id,created_at,updated_at)
    VALUES('custom','memory_tools','managed','guided','verified','unknown','consent',?,?)`).run(T0,T0)
  const token = 'generation-custom'
  const environment = { EB_AGENT_ID: 'eb_custom', EB_HOST_VARIANT: 'custom-local-mcp', EB_ACTIVITY_GENERATION_TOKEN: token }
  const configuration = JSON.parse(customMcpConfiguration(schemaKind, selectorKey, 'eb_custom', runtime, token))
  const prepared = { componentKeys: ['memory_tools'], activityGenerationToken: token,
    executionPlan: { activityGenerationTokenHash: sha256Json(token) },
    adapterPlan: { requiredUserActionDetails: [{ kind: 'custom_mcp_import', operation: 'connect',
      installationId: 'custom', agentId: 'eb_custom', hostVariant: 'custom-local-mcp', hostVersion: 'custom-123',
      tideMindVersion: runtime.tideMindVersion, adapterVersion: '1', projectionVersion: runtime.projectionVersion,
      command: runtime.shimPath, args: [runtime.mcpServerPath], environment,
      connectorName: selectorKey,
      configurationJson: JSON.stringify(configuration), connectorConfigurationHash: sha256Json(configuration),
    }] } }
  db.prepare(`INSERT INTO reconcile_runs(id,installation_id,operation_type,execution_plan_hash,state,recovery_strategy,
    consent_envelope_id,adapter_version,projection_version,prepared_plan_json,created_at,updated_at)
    VALUES('run-custom','custom','connect','hash','committed','readback_before_replay','consent','1','1',?,?,?)`)
    .run(JSON.stringify(prepared),T0,T0)
  const row = db.prepare("SELECT * FROM agent_installations WHERE id='custom'").get() as AgentInstallationRow
  const record = (signalName: 'brain_recall' | 'brain_digest') => recordHostActivityEvidence(db, {
    agentId: row.agent_id!, hostVariant: row.host_variant, componentKey: 'memory_tools', signalName,
    tideMindVersion: runtime.tideMindVersion, activityGenerationToken: token, observedAt: T1,
  })
  return { db, row, record, prepared, proof: (allowAbsent = false) => currentUserOwnedCustomActivityProof(db, row, runtime, new Date(T2), allowAbsent) }
}


describe('0.2.93 explicit no-auth user-owned metadata boundary', () => {
  it.each(['standard_mcp_servers', 'nested_mcp_servers', 'opencode_mcp'] as const)(
    '%s allows an absent observation only explicitly and preserves partial/full evidence', schema => {
      const data = userOwnedActivityFixture(schema, 'memory_bank')
      expect(() => data.proof()).toThrow('lacks current brain_recall')
      expect(data.proof(true)).toBeNull()
      expect(data.record('brain_recall').status).toBe('recorded')
      expect(() => data.proof(true)).toThrow('lacks current brain_digest')
      expect(data.record('brain_digest').status).toBe('recorded')
      const full = data.proof()
      expect(data.proof(true)).toEqual(full)
      expect(full!.evidence.map(record => record.signalName)).toEqual(['brain_recall', 'brain_digest'])
      expect(data.db.prepare('SELECT count(*) AS n FROM agent_host_activity_evidence').get()).toEqual({ n: 2 })
    },
  )

  it.each(['runtime', 'generation', 'connector', 'configuration', 'ownership', 'activation', 'revoked-consent', 'archived-agent'])(
    'still rejects static %s drift with no runtime activity', drift => {
      const data = userOwnedActivityFixture()
      const action = data.prepared.adapterPlan.requiredUserActionDetails[0]
      if (drift === 'runtime') action.command = '/other/runtime'
      if (drift === 'generation') data.prepared.activityGenerationToken = 'other-generation'
      if (drift === 'connector') action.connectorName = 'another-connector'
      if (drift === 'configuration') action.configurationJson = '{}'
      data.db.prepare('UPDATE reconcile_runs SET prepared_plan_json=?').run(JSON.stringify(data.prepared))
      if (drift === 'ownership') {
        const metadata = JSON.parse(data.row.metadata_json)
        metadata.customInstallation.configurationOwnership = 'tidemind'
        data.row.metadata_json = JSON.stringify(metadata)
      }
      if (drift === 'activation') data.db.prepare("UPDATE reconcile_runs SET state='applied_unverified'").run()
      if (drift === 'revoked-consent') data.db.prepare("UPDATE agent_consents SET status='revoked'").run()
      if (drift === 'archived-agent') data.db.prepare("UPDATE agents SET archived=1 WHERE id='eb_custom'").run()
      expect(() => data.proof(true)).toThrow()
    },
  )

  it('does not erase existing activity when its evidence has become invalid', () => {
    const data = userOwnedActivityFixture()
    data.record('brain_recall'); data.record('brain_digest')
    data.db.prepare("UPDATE agent_host_activity_evidence SET evidence_hash='tampered'").run()
    expect(() => data.proof(true)).toThrow()
    expect(data.db.prepare('SELECT count(*) AS n FROM agent_host_activity_evidence').get()).toEqual({ n: 2 })
  })

  it.each(['manual_mcp_client', 'nonstandard_config_root', 'codex-cli:arm64:cli%3Acodex-cli'])(
    'rejects explicit no-auth mode for the wrong target %s before output', async targetKey => {
      const data = fixture()
      const outputPath = path.join(data.root, 'wrong-mode.json')
      await expect(exportAgentHostTargetMetadata({
        targetKey, acceptanceMode: 'partial-auth-runtime-0.2.93', candidateBundleSha256: hash('candidate'),
        sourceCommit: 'a'.repeat(40), releaseContractSha256: hash('contract'), outputPath,
        fixture: { receipt: data.receipt, row: data.row, discovered: data.discovered,
          liveTrustProof: hash('attestation'), physicalDistribution: data.physicalDistribution,
          osVersion: '15.6.1', hostIdentitySha256: hash('anonymous-host') },
      })).rejects.toThrow('no-auth metadata mode is restricted')
      expect(fs.existsSync(outputPath)).toBe(false)
    },
  )

  it.each(['standard_mcp_servers', 'nested_mcp_servers', 'opencode_mcp'] as const)(
    'exports zero-activity %s through real SQLite without promoting a fixture to real evidence', async schemaKind => {
      const data = userOwnedActivityFixture(schemaKind, 'memory_bank')
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'custom-no-auth-export-'))); roots.push(root)
      const executable = path.join(root, 'client')
      fs.writeFileSync(executable, 'fixture client; never executed', { mode: 0o700 })
      const proof = await readStableFileFingerprint(executable, 1024)
      const metadata = JSON.parse(data.row.metadata_json)
      metadata.customInstallation.executableFingerprint = proof.fingerprint
      metadata.componentConfigFiles = {}
      metadata.distribution = { distributionId: 'custom-fixture', packageProvenance: 'user_selected_local_executable' }
      data.db.prepare('UPDATE agent_installations SET config_root=?, executable_path=?, metadata_json=?')
        .run(root, executable, JSON.stringify(metadata))
      const databasePath = path.join(root, 'brain.sqlite'); await data.db.backup(databasePath)
      vi.spyOn(productionService, 'metadataEvidenceRuntimeContext').mockReturnValue(runtime)
      vi.spyOn(productionService, 'createProductionAgentHostMetadataEvidenceRuntime').mockReturnValue({
        scan: async () => { throw new Error('must not scan unrelated hosts') },
        attest: async () => null, attestCustom: async () => sha256Json('trust-fixture'),
        inspectCliVersion: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
        readExecutable: () => readStableFileFingerprint(executable, 1024),
        inspect: async () => ({ catalogId: 'custom-local-mcp', detected: true, components: [], provenance: [], diagnostics: [] }),
      })
      const sourceCommit = 'a'.repeat(40); vi.stubGlobal('__TIDEMIND_BUNDLED_SOURCE_COMMIT__', sourceCommit)
      const releaseContractSha256 = hash(JSON.stringify({
        version: manifest.appVersion, schemaVersion: manifest.schemaVersion, entries: manifest.entries,
        customEnabled: manifest.features.customLocalAgent.enabledByDefault, customModes: manifest.features.customLocalAgent.modes,
      }))
      const architecture = process.arch === 'x64' ? 'x64' : 'arm64'
      const options = {
        targetKey: `manual_mcp_client:${schemaKind}:memory_bank`, candidateBundleSha256: hash('candidate'),
        sourceCommit, releaseContractSha256, databasePath, homeDir: root, now: () => new Date(T2),
        customHostFixture: { executionEnvironment: { processArchitecture: architecture,
          hardwareArchitecture: architecture === 'x64' ? 'x86_64' as const : 'arm64' as const,
          translationMode: 'not_translated' as const }, osVersion: '15.0.0', hostIdentitySha256: hash('fixture-host') },
      }
      const defaultOutput = path.join(root, 'default.json')
      await expect(exportAgentHostTargetMetadata({ ...options, outputPath: defaultOutput }))
        .rejects.toThrow('lacks current brain_recall')
      expect(fs.existsSync(defaultOutput)).toBe(false)
      const outputPath = path.join(root, 'partial.json')
      await exportAgentHostTargetMetadata({ ...options, outputPath, acceptanceMode: 'partial-auth-runtime-0.2.93' })
      const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      expect(output.evidenceClass).toBe('fixture')
      expect(output.targetMetadata.customBinding).toMatchObject({ configurationOwnership: 'user', activityBinding: null })
      fs.writeFileSync(executable, 'tampered fixture executable', { mode: 0o700 })
      const tamperedOutput = path.join(root, 'tampered.json')
      await expect(exportAgentHostTargetMetadata({ ...options, outputPath: tamperedOutput, acceptanceMode: 'partial-auth-runtime-0.2.93' }))
        .rejects.toThrow('no longer matches its approved physical identity')
      expect(fs.existsSync(tamperedOutput)).toBe(false)
    },
  )
})
