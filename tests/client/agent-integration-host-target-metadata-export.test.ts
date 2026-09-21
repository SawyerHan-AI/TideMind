import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertNativeAgentHostAcceptanceExecutionEnvironment,
  exportAgentHostTargetMetadata,
  directoryIdentitySha256,
  inspectAgentHostAcceptanceExecutionEnvironment,
  readAgentHostPhysicalDistribution,
} from '../../client/electron/agent-integration/host-target-metadata-export'
import { sha256Json } from '../../client/electron/agent-integration/fingerprint'
import type { AgentReleaseDistributionArtifactReceipt } from '../../client/electron/agent-integration/release-manifest'
import type { DiscoveredInstallation } from '../../client/electron/agent-integration/discovery'
import type { AgentInstallationRow } from '../../client/electron/agent-integration/repository'
import { metadataEvidenceRuntimeContext } from '../../client/electron/agent-integration/production-service'

const roots: string[] = []
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

afterEach(() => {
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
