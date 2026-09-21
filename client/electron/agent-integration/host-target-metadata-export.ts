import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parse as parseToml } from 'smol-toml';
import { inspectAgentHostActivityEvidenceV34Schema } from '@server/db/agent-integration-schema.js';
import { readStableDistributionTree } from './distribution-artifact.js';
import {
  createProductionAgentHostMetadataEvidenceRuntime,
  metadataEvidenceRuntimeContext,
} from './production-service.js';
import { SqliteHostActivityEvidenceReader } from './host-activity-evidence.js';
import type { AdapterRuntimeContext } from './types.js';
import type { PreparedCoordinatorPlan } from './planner.js';
import { sha256Json as canonicalSha256Json } from './fingerprint.js';
import { customGuidedProjection, customMcpConfiguration } from './hosts/custom-mcp-configuration.js';
import {
  AGENT_INTEGRATION_RELEASE_ENTRY_MAP,
  AGENT_INTEGRATION_RELEASE_MANIFEST,
  type AgentReleaseDistributionArtifactReceipt,
  type AgentReleaseMacArchitecture,
} from './release-manifest.js';
import type { DiscoveredInstallation } from './discovery.js';
import {
  normalizedOpenClawWrapperBytes,
  normalizedQwenLauncherBytes,
  readStableFileFingerprint,
} from './passive-cli-version.js';
import {
  persistedComponentConfigFiles,
  persistedDistribution,
  type AgentInstallationRow,
} from './repository.js';

declare const __TIDEMIND_BUNDLED_SOURCE_COMMIT__: string;

const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40,64}$/u;

export type AgentHostAcceptanceProcessArchitecture = 'arm64' | 'x64';
export type AgentHostAcceptanceHardwareArchitecture = 'arm64' | 'x86_64';
export type AgentHostAcceptanceTranslationMode = 'not_translated' | 'rosetta';

export interface AgentHostAcceptanceExecutionEnvironment {
  processArchitecture: AgentHostAcceptanceProcessArchitecture;
  hardwareArchitecture: AgentHostAcceptanceHardwareArchitecture;
  translationMode: AgentHostAcceptanceTranslationMode;
}

type SysctlResult = { status: number | null; stdout: string; stderr: string; error?: Error };

function runSysctl(name: string): SysctlResult {
  const result = spawnSync('/usr/sbin/sysctl', ['-n', name], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', LANG: 'C' },
    timeout: 2_000,
    maxBuffer: 16 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

function sysctlBit(
  name: string,
  execute: (name: string) => SysctlResult,
  allowUnknownOid = false,
): 0 | 1 | null {
  const result = execute(name);
  if (result.error) throw new Error(`macOS ${name} probe failed: ${result.error.message}`);
  if (result.status === 0) {
    const value = result.stdout.trim();
    if (value === '0' || value === '1') return Number(value) as 0 | 1;
    throw new Error(`macOS ${name} probe returned an invalid value`);
  }
  if (allowUnknownOid && result.status === 1 && /^sysctl: unknown oid ['"]?sysctl\.proc_translated['"]?\s*$/iu.test(result.stderr.trim())) {
    return null;
  }
  throw new Error(`macOS ${name} probe failed with status ${String(result.status)}`);
}

/** Distinguish the executing Mach architecture from the physical Mac architecture. */
export function inspectAgentHostAcceptanceExecutionEnvironment(options: {
  platform?: NodeJS.Platform;
  processArchitecture?: string;
  executeSysctl?: (name: string) => SysctlResult;
} = {}): AgentHostAcceptanceExecutionEnvironment {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('formal target metadata export requires macOS');
  }
  const rawProcessArchitecture = options.processArchitecture ?? process.arch;
  if (rawProcessArchitecture !== 'arm64' && rawProcessArchitecture !== 'x64') {
    throw new Error('formal target metadata export requires an arm64 or x64 process');
  }
  const execute = options.executeSysctl ?? runSysctl;
  const arm64Hardware = sysctlBit('hw.optional.arm64', execute);
  const translated = sysctlBit('sysctl.proc_translated', execute, true);
  const hardwareArchitecture: AgentHostAcceptanceHardwareArchitecture = arm64Hardware === 1 ? 'arm64' : 'x86_64';
  if (hardwareArchitecture === 'arm64' && translated === null) {
    throw new Error('Apple silicon translation state is unavailable');
  }
  if (hardwareArchitecture === 'x86_64' && translated === 1) {
    throw new Error('Intel hardware cannot report a translated process');
  }
  return {
    processArchitecture: rawProcessArchitecture,
    hardwareArchitecture,
    translationMode: translated === 1 ? 'rosetta' : 'not_translated',
  };
}

export function assertNativeAgentHostAcceptanceExecutionEnvironment(
  environment: AgentHostAcceptanceExecutionEnvironment,
): void {
  const nativeArm64 = environment.processArchitecture === 'arm64'
    && environment.hardwareArchitecture === 'arm64'
    && environment.translationMode === 'not_translated';
  const nativeX64 = environment.processArchitecture === 'x64'
    && environment.hardwareArchitecture === 'x86_64'
    && environment.translationMode === 'not_translated';
  if (!nativeArm64 && !nativeX64) {
    throw new Error('formal real-host acceptance requires native hardware; Rosetta is compatibility preflight only');
  }
}

function arg(name: string): string {
  const matches = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (matches.length !== 1) throw new Error(`expected exactly one ${name}`);
  const value = process.argv[matches[0] + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

function sha256Bytes(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Json(value: unknown): string {
  return sha256Bytes(JSON.stringify(value));
}

function resolveRealProfileDatabase(): string {
  const defaultDataDir = path.join(os.homedir(), '.tidemind');
  const configPath = path.join(defaultDataDir, 'config.toml');
  let dataDir = defaultDataDir;
  if (fs.existsSync(configPath)) {
    const stat = fs.lstatSync(configPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error('Tide Mind profile config is not a bounded regular file');
    }
    const parsed = parseToml(fs.readFileSync(configPath, 'utf8')) as { general?: { data_dir?: string } };
    const configured = parsed.general?.data_dir;
    if (configured !== undefined) {
      if (typeof configured !== 'string' || configured.length > 4096) {
        throw new Error('Tide Mind profile data directory is invalid');
      }
      const expanded = configured.replace(/^~(?=$|\/)/u, os.homedir());
      if (!path.isAbsolute(expanded)) throw new Error('Tide Mind profile data directory must be absolute');
      dataDir = expanded;
    }
  }
  const database = path.resolve(dataDir, 'graph', 'brain.sqlite');
  if (!path.isAbsolute(database)) throw new Error('Tide Mind profile database path is not absolute');
  return database;
}

function releaseContractSha256(): string {
  const manifest = AGENT_INTEGRATION_RELEASE_MANIFEST;
  return sha256Json({
    version: manifest.appVersion,
    schemaVersion: manifest.schemaVersion,
    entries: manifest.entries,
    customEnabled: manifest.features.customLocalAgent.enabledByDefault,
    customModes: manifest.features.customLocalAgent.modes,
  });
}

type ParsedTarget = {
  kind: 'release'; catalogId: string; architecture: AgentReleaseMacArchitecture; distributionId: string;
} | {
  kind: 'custom'; mode: 'nonstandard_config_root' | 'manual_mcp_client';
  schemaKind?: string; selectorKey?: string; configurationOwnership?: 'user';
};

function parseTargetKey(targetKey: string): ParsedTarget {
  if (targetKey === 'nonstandard_config_root' || targetKey === 'manual_mcp_client') {
    return { kind: 'custom', mode: targetKey };
  }
  if (targetKey.startsWith('manual_mcp_client:')) {
    const projection = customGuidedProjection(targetKey.replace(/^manual_mcp_client:/u, 'custom-guided:'));
    return { kind: 'custom', mode: 'manual_mcp_client', configurationOwnership: 'user',
      schemaKind: projection.schema, selectorKey: projection.selectorKey };
  }
  const match = targetKey.match(/^([^:]+):(arm64|x64):(.+)$/u);
  if (!match) throw new Error('target key must bind catalog, architecture, and distribution');
  let distributionId: string;
  try {
    distributionId = decodeURIComponent(match[3]);
  } catch {
    throw new Error('target key distribution is not valid percent encoding');
  }
  if (!distributionId || encodeURIComponent(distributionId) !== match[3]) {
    throw new Error('target key distribution is not canonically encoded');
  }
  return { kind: 'release', catalogId: match[1], architecture: match[2] as AgentReleaseMacArchitecture, distributionId };
}

function hostIdentitySha256(): string {
  if (process.platform !== 'darwin') throw new Error('formal target metadata export requires macOS');
  const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 2_000,
    maxBuffer: 256 * 1024,
  });
  const platformUuid = output.match(/"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"/u)?.[1]?.toLowerCase();
  if (!platformUuid) throw new Error('macOS platform identity is unavailable');
  return sha256Json({ schema: 'tidemind-acceptance-host-v1', platformUuid, uid: process.getuid?.() ?? null });
}

function macOsVersion(): string {
  const version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2_000, maxBuffer: 16 * 1024,
  }).trim();
  if (!/^\d+(?:\.\d+){1,2}$/u.test(version)) throw new Error('macOS version is unavailable');
  return version;
}

function exactReceipt(
  catalogId: string,
  distributionId: string,
  version: string,
  architecture: AgentReleaseMacArchitecture,
): AgentReleaseDistributionArtifactReceipt {
  const entry = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get(catalogId as never);
  if (!entry || !entry.enabledByDefault || entry.releaseMode !== 'production') {
    throw new Error('target is not enabled by the frozen production release contract');
  }
  if (!entry.releaseAcceptedExactVersions.includes(version)) {
    throw new Error('target version is not accepted by the frozen release contract');
  }
  const candidates = entry.acceptedDistributionArtifacts.filter(receipt => (
    receipt.distributionId === distributionId
      && receipt.version === version
      && receipt.architecture === architecture
  ));
  if (candidates.length !== 1) throw new Error('target requires exactly one immutable release receipt');
  return candidates[0];
}

function sameInstallation(row: AgentInstallationRow, discovered: DiscoveredInstallation): boolean {
  const sameOptionalPath = (left: string | null | undefined, right: string | null | undefined): boolean => {
    if (left == null || right == null) return left == null && right == null;
    return path.resolve(left) === path.resolve(right);
  };
  return row.runtime_realm === discovered.identity.runtimeRealm
    && row.install_key === discovered.identity.installKey
    && row.host_variant === discovered.catalogId
    && row.os_user_identity === discovered.identity.osUserIdentity
    && row.detected_version === discovered.detectedVersion
    && sameOptionalPath(row.executable_path, discovered.executablePath)
    && sameOptionalPath(row.app_path, discovered.appPath)
    && row.distribution_id === discovered.identity.distribution.distributionId;
}

function storedMetadata(row: AgentInstallationRow): Record<string, unknown> {
  const value = JSON.parse(row.metadata_json) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('target Installation metadata is invalid');
  }
  return value as Record<string, unknown>;
}

function customInstallationMetadata(row: AgentInstallationRow): Record<string, unknown> {
  const value = storedMetadata(row).customInstallation;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('target has no frozen Custom Installation binding');
  }
  return value as Record<string, unknown>;
}

export function directoryIdentitySha256(directory: string): string {
  const canonical = path.resolve(directory);
  const stat = fs.lstatSync(canonical, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(canonical) !== canonical) {
    throw new Error('Custom configuration root is not a canonical physical directory');
  }
  return canonicalSha256Json({
    realpath: canonical,
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
  });
}

function customRows(database: Database.Database, target: Extract<ParsedTarget, { kind: 'custom' }>): AgentInstallationRow[] {
  const rows = database.prepare(`
    SELECT * FROM agent_installations
    WHERE family = 'custom-local-agent'
      AND desired_state != 'removed' AND tombstoned_at IS NULL
  `).all() as AgentInstallationRow[];
  return rows.filter(row => {
    try {
      const custom = customInstallationMetadata(row);
      return custom.kind === target.mode
        && (target.mode !== 'manual_mcp_client' || (target.configurationOwnership === 'user'
          ? custom.configurationOwnership === 'user' && custom.schemaKind === target.schemaKind && custom.selectorKey === target.selectorKey
          : custom.configurationOwnership !== 'user'));
    } catch {
      return false;
    }
  });
}

function currentReadBackProof(
  database: Database.Database,
  row: AgentInstallationRow,
  inspection: Awaited<ReturnType<ReturnType<typeof createProductionAgentHostMetadataEvidenceRuntime>['inspect']>>,
  requiredComponents: readonly string[],
): string {
  if (!inspection?.detected || inspection.diagnostics.length > 0) {
    throw new Error('Custom target Adapter read-back is not clean');
  }
  const componentRows = database.prepare(`
    SELECT c.component_key, c.desired_state, c.verification_status, c.visibility_state,
           a.target_path, a.ownership_key, a.state AS artifact_state,
           a.owned_fragment_hash, a.observed_fragment_hash
    FROM installation_components c
    LEFT JOIN managed_artifacts a ON a.id = c.artifact_id
    WHERE c.installation_id = ?
    ORDER BY c.component_key
  `).all(row.id) as Array<Record<string, unknown>>;
  const adapterComponents = requiredComponents.map(componentKey => {
    const observed = inspection.components.find(component => component.componentKey === componentKey);
    const persisted = componentRows.find(component => component.component_key === componentKey);
    if (!observed || !persisted
      || !['dedicated', 'shared_visible'].includes(observed.visibility)
      || persisted.desired_state !== 'managed'
      || persisted.verification_status !== 'verified'
      || !['dedicated', 'shared_visible'].includes(String(persisted.visibility_state))) {
      throw new Error(`Custom target ${componentKey} does not have current verified read-back`);
    }
    if (observed.observedFragmentHash
      && persisted.owned_fragment_hash
      && observed.observedFragmentHash !== persisted.owned_fragment_hash) {
      throw new Error(`Custom target ${componentKey} read-back differs from its owned fragment`);
    }
    return {
      componentKey,
      visibility: observed.visibility,
      observedTargetSha256: observed.observedTarget ? sha256Bytes(path.resolve(observed.observedTarget)) : null,
      observedFragmentHash: observed.observedFragmentHash ?? null,
      persistedVisibility: persisted.visibility_state,
      artifactState: persisted.artifact_state ?? null,
      targetPathSha256: persisted.target_path ? sha256Bytes(path.resolve(String(persisted.target_path))) : null,
      ownershipKeySha256: persisted.ownership_key ? sha256Bytes(String(persisted.ownership_key)) : null,
      ownedFragmentHash: persisted.owned_fragment_hash ?? null,
      persistedObservedFragmentHash: persisted.observed_fragment_hash ?? null,
    };
  });
  return sha256Json({
    schema: 'custom-adapter-read-back-v1',
    catalogId: inspection.catalogId,
    installationId: row.id,
    agentId: row.agent_id,
    components: adapterComponents,
  });
}

/** User-owned imports have no file read-back; prove the exact active connector instead. */
export function currentUserOwnedCustomActivityProof(
  database: Database.Database,
  row: AgentInstallationRow,
  runtime: AdapterRuntimeContext,
  now = new Date(),
) {
  if (row.host_variant !== 'custom-local-mcp' || !row.profile_id.startsWith('custom-guided:')
    || customInstallationMetadata(row).configurationOwnership !== 'user' || !row.agent_id || !row.detected_version) {
    throw new Error('user-owned Custom target identity is invalid');
  }
  const run = database.prepare(`
    SELECT id, state, operation_type, consent_envelope_id, adapter_version, projection_version,
           created_at, prepared_plan_json
    FROM reconcile_runs WHERE installation_id = ?
      AND EXISTS (SELECT 1 FROM json_each(
        CASE WHEN json_valid(prepared_plan_json) THEN prepared_plan_json ELSE '{}' END,
        '$.componentKeys') component WHERE component.value = 'memory_tools')
    ORDER BY rowid DESC LIMIT 1
  `).get(row.id) as {
    id: string; state: string; operation_type: string; consent_envelope_id: string;
    adapter_version: string; projection_version: string; created_at: string; prepared_plan_json: string;
  } | undefined;
  if (!run || run.state !== 'committed' || run.operation_type === 'disconnect'
    || run.consent_envelope_id !== row.consent_envelope_id || run.adapter_version !== '1'
    || run.projection_version !== runtime.projectionVersion) {
    throw new Error('user-owned Custom target has no current committed activation');
  }
  const prepared = JSON.parse(run.prepared_plan_json) as PreparedCoordinatorPlan;
  const token = prepared.activityGenerationToken;
  const action = prepared.adapterPlan.requiredUserActionDetails?.find(detail => detail.kind === 'custom_mcp_import');
  const projection = customGuidedProjection(row.profile_id);
  const custom = customInstallationMetadata(row);
  if (custom.schemaKind !== projection.schema || custom.selectorKey !== projection.selectorKey) {
    throw new Error('user-owned Custom schema/selector differs from its frozen profile');
  }
  const environment = { EB_AGENT_ID: row.agent_id, EB_HOST_VARIANT: row.host_variant, EB_ACTIVITY_GENERATION_TOKEN: token };
  const configuration = JSON.parse(customMcpConfiguration(projection.schema, projection.selectorKey, row.agent_id, runtime, token));
  if (!token || prepared.executionPlan.activityGenerationTokenHash !== sha256Json(token)
    || !action || action.kind !== 'custom_mcp_import' || action.operation !== 'connect'
    || action.installationId !== row.id || action.agentId !== row.agent_id
    || action.hostVersion !== row.detected_version || action.hostVariant !== row.host_variant
    || action.tideMindVersion !== runtime.tideMindVersion || action.adapterVersion !== run.adapter_version
    || action.projectionVersion !== runtime.projectionVersion
    || action.connectorName !== projection.selectorKey
    || action.command !== runtime.shimPath || JSON.stringify(action.args) !== JSON.stringify([runtime.mcpServerPath])
    || action.connectorConfigurationHash !== canonicalSha256Json(configuration)
    || canonicalSha256Json(JSON.parse(action.configurationJson)) !== canonicalSha256Json(configuration)
    || canonicalSha256Json(action.environment) !== canonicalSha256Json(environment)) {
    throw new Error('user-owned Custom connector does not match the candidate runtime and generation');
  }
  const component = database.prepare(`SELECT delivery_mode, artifact_id FROM installation_components
    WHERE installation_id = ? AND component_key = 'memory_tools'`).get(row.id) as {
    delivery_mode: string; artifact_id: string | null;
  } | undefined;
  if (component?.delivery_mode !== 'guided' || component.artifact_id !== null) {
    throw new Error('user-owned Custom target must not claim a managed artifact');
  }
  const afterMs = Math.max(Date.parse(run.created_at), now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const records = new SqliteHostActivityEvidenceReader(database).find({
    installationId: row.id, agentId: row.agent_id, hostVariant: 'custom-local-mcp', componentKey: 'memory_tools',
    signalNames: ['brain_recall', 'brain_digest'], tideMindVersion: runtime.tideMindVersion,
    adapterVersion: run.adapter_version, projectionVersion: runtime.projectionVersion, hostVersion: row.detected_version,
    activationRunId: run.id, activityGenerationToken: token, observedAfter: new Date(afterMs).toISOString(),
  }).filter(record => Date.parse(record.observedAt) > afterMs && Date.parse(record.observedAt) <= now.getTime());
  const evidence = (['brain_recall', 'brain_digest'] as const).map(signal => {
    const record = records.find(candidate => candidate.signalName === signal);
    if (!record) throw new Error(`user-owned Custom target lacks current ${signal} activity`);
    return { id: record.id, signalName: record.signalName, evidenceHash: record.evidenceHash, observedAt: record.observedAt };
  });
  return {
    installationId: row.id, agentId: row.agent_id, activationRunId: run.id,
    generationSha256: sha256Json(token), connectorConfigurationSha256: canonicalSha256Json(configuration),
    runtimeBindingSha256: sha256Json({ command: runtime.shimPath, args: [runtime.mcpServerPath],
      tideMindVersion: runtime.tideMindVersion, projectionVersion: runtime.projectionVersion }),
    tideMindVersion: runtime.tideMindVersion, adapterVersion: run.adapter_version,
    projectionVersion: runtime.projectionVersion, hostVersion: row.detected_version,
    schemaKind: projection.schema, selectorKey: projection.selectorKey, evidence,
  };
}

export interface AgentHostPhysicalDistribution {
  executableSha256: string;
  executableSizeBytes: number;
  rawExecutableSha256: string;
  rawExecutableSizeBytes: number;
  distributionSha256: string;
  distributionSizeBytes: number;
}

export async function readAgentHostPhysicalDistribution(
  receipt: AgentReleaseDistributionArtifactReceipt,
  discovered: DiscoveredInstallation,
  runtime: ReturnType<typeof createProductionAgentHostMetadataEvidenceRuntime>,
): Promise<AgentHostPhysicalDistribution> {
  const executable = discovered.executablePath;
  if (!executable) throw new Error('fresh discovery did not bind an executable');
  const executableProof = await runtime.readExecutable(executable);
  if (!executableProof.executable) throw new Error('fresh executable proof is not executable');
  const rawExecutable = {
    rawExecutableSha256: executableProof.sha256,
    rawExecutableSizeBytes: executableProof.size,
  };
  if (receipt.signedCode && discovered.appPath) {
    const distribution = await readStableDistributionTree(discovered.appPath);
    return {
      ...rawExecutable,
      executableSha256: executableProof.sha256,
      executableSizeBytes: executableProof.size,
      distributionSha256: distribution.sha256,
      distributionSizeBytes: distribution.sizeBytes,
    };
  }
  if (receipt.signedCode) {
    return {
      ...rawExecutable,
      executableSha256: executableProof.sha256,
      executableSizeBytes: executableProof.size,
      distributionSha256: executableProof.sha256,
      distributionSizeBytes: executableProof.size,
    };
  }
  const inspected = await runtime.inspectCliVersion(executable);
  const expectedPackageTree = receipt.portableFingerprintSchema === 'npm-composed-platform-surface-v1'
    ? receipt.distributionSha256
    : receipt.npmPackage?.ownedPackageSha256;
  if (inspected.exitCode !== 0
    || inspected.stdout !== receipt.version
    || inspected.verifiedPackageProvenance !== receipt.packageProvenance
    || inspected.portableArtifactFingerprint !== receipt.portableArtifactFingerprint
    || inspected.packageTreeSha256 !== expectedPackageTree
    || !inspected.packageProofNodes?.length) {
    throw new Error('fresh npm distribution proof does not match its immutable release receipt');
  }
  const sizeBytes = inspected.packageProofNodes
    .filter(node => node.entryType !== undefined)
    .reduce((sum, node) => sum + node.size, 0);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error('fresh npm distribution size is invalid');
  const distributionSha256 = inspected.packageTreeSha256;
  if (!distributionSha256) throw new Error('fresh npm distribution hash is invalid');
  let portableExecutable: Buffer | undefined;
  if (receipt.portableFingerprintSchema === 'qwen-standalone-surface-v1'
    || receipt.portableFingerprintSchema === 'openclaw-official-wrapper-v1') {
    const qwen = receipt.portableFingerprintSchema === 'qwen-standalone-surface-v1';
    const launchers = inspected.packageProofNodes.filter(node => node.role === (qwen ? 'qwen_launcher' : 'openclaw_wrapper'));
    if (launchers.length !== 1 || launchers[0].fingerprint !== executableProof.fingerprint) {
      throw new Error('live launcher changed during portable distribution inspection');
    }
    if (qwen) portableExecutable = normalizedQwenLauncherBytes();
    else {
      const nodes = inspected.packageProofNodes.filter(node => node.role === 'openclaw_node_runtime');
      const toolchain = nodes.length === 1
        ? nodes[0].path.match(/\/tools\/(node-v\d+\.\d+\.\d+)\/bin\/node$/u)?.[1]
        : undefined;
      if (!toolchain) throw new Error('live OpenClaw toolchain identity is invalid');
      portableExecutable = normalizedOpenClawWrapperBytes(toolchain);
    }
  }
  return {
    ...rawExecutable,
    executableSha256: portableExecutable ? sha256Bytes(portableExecutable) : executableProof.sha256,
    executableSizeBytes: portableExecutable?.length ?? executableProof.size,
    distributionSha256,
    distributionSizeBytes: sizeBytes,
  };
}

export interface AgentHostTargetMetadataExportOptions {
  targetKey: string;
  candidateBundleSha256: string;
  sourceCommit: string;
  releaseContractSha256: string;
  outputPath: string;
  databasePath?: string;
  homeDir?: string;
  now?: () => Date;
  /** Automated tests only; formal CLI never exposes this seam. */
  fixture?: {
    receipt: AgentReleaseDistributionArtifactReceipt;
    row: AgentInstallationRow;
    discovered: DiscoveredInstallation;
    liveTrustProof: string;
    physicalDistribution: AgentHostPhysicalDistribution;
    osVersion: string;
    hostIdentitySha256: string;
    executionEnvironment?: AgentHostAcceptanceExecutionEnvironment;
  };
  /**
   * Automated tests only. This keeps the full Custom SQLite/runtime/export
   * path active on non-macOS CI, but the resulting envelope is permanently
   * labelled `fixture` and therefore cannot satisfy formal host acceptance.
   * The production CLI does not expose this seam.
   */
  customHostFixture?: {
    executionEnvironment: AgentHostAcceptanceExecutionEnvironment;
    osVersion: string;
    hostIdentitySha256: string;
  };
}

export async function exportAgentHostTargetMetadata(options: AgentHostTargetMetadataExportOptions): Promise<void> {
  if (!path.isAbsolute(options.outputPath)) throw new Error('target metadata output must be an absolute path');
  const outputPath = path.resolve(options.outputPath);
  if (outputPath === path.parse(outputPath).root || fs.existsSync(outputPath)) {
    throw new Error('target metadata output must be a new non-root file');
  }
  if (!SHA256.test(options.candidateBundleSha256)
    || !SOURCE_COMMIT.test(options.sourceCommit)
    || !SHA256.test(options.releaseContractSha256)) throw new Error('target export binding is invalid');
  if (!options.fixture && (options.sourceCommit !== __TIDEMIND_BUNDLED_SOURCE_COMMIT__
    || options.releaseContractSha256 !== releaseContractSha256())) {
    throw new Error('target export does not match this candidate build');
  }
  const parsedTarget = parseTargetKey(options.targetKey);
  if (options.fixture && options.customHostFixture) {
    throw new Error('target export cannot combine release and Custom fixtures');
  }
  if (options.customHostFixture && parsedTarget.kind !== 'custom') {
    throw new Error('Custom host fixture may only export a Custom target');
  }
  const fixtureArchitecture = parsedTarget.kind === 'release'
    ? parsedTarget.architecture
    : (process.arch === 'x64' ? 'x64' : 'arm64');
  const executionEnvironment = options.fixture?.executionEnvironment
    ?? options.customHostFixture?.executionEnvironment
    ?? (options.fixture ? {
    processArchitecture: fixtureArchitecture,
    hardwareArchitecture: fixtureArchitecture === 'x64' ? 'x86_64' : 'arm64',
    translationMode: 'not_translated',
  } as const : inspectAgentHostAcceptanceExecutionEnvironment());
  assertNativeAgentHostAcceptanceExecutionEnvironment(executionEnvironment);
  const architecture = executionEnvironment.processArchitecture;
  if (parsedTarget.kind === 'release' && parsedTarget.architecture !== architecture) {
    throw new Error('target architecture differs from this candidate');
  }

  let row: AgentInstallationRow;
  let discovered: DiscoveredInstallation | null = null;
  let receipt: AgentReleaseDistributionArtifactReceipt | null = null;
  let liveTrustProof: string;
  let physical: AgentHostPhysicalDistribution;
  let osVersion: string;
  let anonymousHostIdentity: string;
  let sourceCatalogId: string | null = null;
  let customBinding: Record<string, unknown> | null = null;
  if (options.fixture) {
    if (parsedTarget.kind !== 'release') throw new Error('Custom fixture export requires a dedicated physical fixture');
    ({ row, discovered, liveTrustProof, physicalDistribution: physical, osVersion } = options.fixture);
    receipt = options.fixture.receipt;
    anonymousHostIdentity = options.fixture.hostIdentitySha256;
  } else {
    const database = new Database(options.databasePath ?? resolveRealProfileDatabase(), { readonly: true, fileMustExist: true });
    try {
      if (database.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Agent Integration database quick_check failed');
      inspectAgentHostActivityEvidenceV34Schema(database);
      const rows = parsedTarget.kind === 'release'
        ? database.prepare(`
            SELECT * FROM agent_installations
            WHERE host_variant = ? AND distribution_id = ?
              AND desired_state != 'removed' AND tombstoned_at IS NULL
          `).all(parsedTarget.catalogId, parsedTarget.distributionId) as AgentInstallationRow[]
        : customRows(database, parsedTarget);
      if (rows.length !== 1) throw new Error('target must resolve to exactly one live v34 Installation');
      [row] = rows;
      if (!row.agent_id || row.runtime_realm !== 'local_macos') {
        throw new Error('target Installation has no stable local Agent identity');
      }
      const unknown = database.prepare(`
        SELECT component_key FROM installation_components
        WHERE installation_id = ? AND visibility_state = 'unknown'
      `).all(row.id) as Array<{ component_key: string }>;
      const userOwnedCustom = parsedTarget.kind === 'custom' && parsedTarget.mode === 'manual_mcp_client'
        && row.profile_id.startsWith('custom-guided:')
        && customInstallationMetadata(row).configurationOwnership === 'user';
      if (unknown.some(component => !userOwnedCustom || component.component_key !== 'memory_tools')) {
        throw new Error('target Installation contains unknown component visibility');
      }

      const homeDir = options.homeDir ?? os.homedir();
      const runtime = createProductionAgentHostMetadataEvidenceRuntime(homeDir);
      if (parsedTarget.kind === 'release') {
        const report = await runtime.scan();
        const matches = report.installations.filter(candidate => sameInstallation(row, candidate));
        if (matches.length !== 1) throw new Error('fresh production discovery does not uniquely match the v34 Installation');
        [discovered] = matches;
        if (discovered.managementEligibility?.eligible !== true) {
          throw new Error(`fresh production discovery is not release-eligible: ${discovered.managementEligibility?.reason ?? 'unknown'}`);
        }
        const attestation = await runtime.attest(row);
        if (!attestation || !SHA256.test(attestation)) throw new Error('live production trust attestation failed');
        liveTrustProof = attestation;
        receipt = exactReceipt(parsedTarget.catalogId, parsedTarget.distributionId, row.detected_version ?? '', architecture);
        physical = await readAgentHostPhysicalDistribution(receipt, discovered, runtime);
      } else {
        if (!row.config_root) throw new Error('Custom target has no frozen configuration root');
        const custom = customInstallationMetadata(row);
        if (custom.kind !== parsedTarget.mode) throw new Error('Custom target mode mismatch');
        const attestation = await runtime.attestCustom(row, database);
        if (!attestation || !SHA256.test(attestation)) throw new Error('Custom target live trust attestation failed');
        liveTrustProof = attestation;
        const inspection = await runtime.inspect(row, database);
        const rootIdentity = directoryIdentitySha256(row.config_root);

        if (parsedTarget.mode === 'nonstandard_config_root') {
          if (typeof custom.sourceInstallationId !== 'string'
            || typeof custom.sourceHostVariant !== 'string'
            || typeof custom.configFingerprint !== 'string'
            || custom.configFingerprint !== rootIdentity) {
            throw new Error('nonstandard Custom target root/source binding is invalid');
          }
          const source = database.prepare(`
            SELECT * FROM agent_installations
            WHERE id = ? AND desired_state != 'removed' AND tombstoned_at IS NULL
          `).get(custom.sourceInstallationId) as AgentInstallationRow | undefined;
          if (!source || source.family === 'custom-local-agent'
            || source.host_variant !== custom.sourceHostVariant
            || !source.agent_id) throw new Error('nonstandard Custom target has no live base P0 Installation');
          const releaseEntry = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get(source.host_variant as never);
          if (!releaseEntry?.customConfigRoot.supported) {
            throw new Error('base P0 release contract does not support a nonstandard root');
          }
          const sourceDistribution = persistedDistribution(source);
          if (!sourceDistribution.distributionId) throw new Error('base P0 distribution identity is missing');
          receipt = exactReceipt(
            source.host_variant,
            sourceDistribution.distributionId,
            source.detected_version ?? '',
            architecture,
          );
          const report = await runtime.scan();
          const matches = report.installations.filter(candidate => sameInstallation(source, candidate));
          if (matches.length !== 1) throw new Error('fresh discovery does not uniquely match the base P0 Installation');
          [discovered] = matches;
          const sourceAttestation = await runtime.attest(source);
          if (!sourceAttestation || !SHA256.test(sourceAttestation)) {
            throw new Error('base P0 live trust attestation failed');
          }
          physical = await readAgentHostPhysicalDistribution(receipt, discovered, runtime);
          sourceCatalogId = source.host_variant;
          const requiredComponents = releaseEntry.requiredComponents;
          customBinding = {
            kind: parsedTarget.mode,
            sourceInstallationId: source.id,
            sourceCatalogId,
            configRootIdentitySha256: rootIdentity,
            configFileIdentitySha256: null,
            selectorIdentitySha256: sha256Json({
              profileId: row.profile_id,
              componentConfigRoots: storedMetadata(row).componentConfigRoots ?? {},
              componentConfigFiles: storedMetadata(row).componentConfigFiles ?? {},
            }),
            executableFingerprint: null,
            sourceLiveTrustProofSha256: sourceAttestation,
            liveTrustProofSha256: liveTrustProof,
            readBackProofSha256: currentReadBackProof(database, row, inspection, requiredComponents),
          };
        } else {
          const distribution = persistedDistribution(row);
          const configFile = persistedComponentConfigFiles(row)?.memory_tools;
          if (!row.executable_path || (!userOwnedCustom && !configFile) || (userOwnedCustom && configFile)
            || distribution.packageProvenance !== 'user_selected_local_executable'
            || typeof custom.schemaKind !== 'string'
            || typeof custom.selectorKey !== 'string'
            || typeof custom.executableFingerprint !== 'string') {
            throw new Error('manual Custom target selector/executable binding is invalid');
          }
          const executableProof = await runtime.readExecutable(row.executable_path);
          const configProof = !userOwnedCustom && configFile
            ? await readStableFileFingerprint(configFile, 1024 * 1024) : null;
          if (!executableProof.executable || executableProof.fingerprint !== custom.executableFingerprint) {
            throw new Error('manual Custom executable no longer matches its approved physical identity');
          }
          physical = {
            rawExecutableSha256: executableProof.sha256,
            rawExecutableSizeBytes: executableProof.size,
            executableSha256: executableProof.sha256,
            executableSizeBytes: executableProof.size,
            distributionSha256: executableProof.sha256,
            distributionSizeBytes: executableProof.size,
          };
          customBinding = {
            kind: parsedTarget.mode,
            sourceInstallationId: null,
            sourceCatalogId: null,
            configRootIdentitySha256: rootIdentity,
            configFileIdentitySha256: configProof?.fingerprint ?? null,
            selectorIdentitySha256: sha256Json({
              schemaKind: custom.schemaKind,
              selectorKey: custom.selectorKey,
              configFileRealpath: configFile ? path.resolve(configFile) : null,
            }),
            executableFingerprint: executableProof.fingerprint,
            sourceLiveTrustProofSha256: null,
            liveTrustProofSha256: liveTrustProof,
            readBackProofSha256: userOwnedCustom ? null : currentReadBackProof(database, row, inspection, ['memory_tools']),
            ...(userOwnedCustom ? {
              configurationOwnership: 'user',
              activityBinding: currentUserOwnedCustomActivityProof(
                database, row, metadataEvidenceRuntimeContext(homeDir), (options.now ?? (() => new Date()))(),
              ),
            } : {}),
          };
        }
      }
      osVersion = options.customHostFixture?.osVersion ?? macOsVersion();
      anonymousHostIdentity = options.customHostFixture?.hostIdentitySha256 ?? hostIdentitySha256();
    } finally {
      database.close();
    }
  }

  if (!row.agent_id || !SHA256.test(liveTrustProof) || !SHA256.test(anonymousHostIdentity)) {
    throw new Error('target Installation identity or live trust proof is invalid');
  }
  if (receipt) {
    if (!discovered) throw new Error('release receipt has no fresh physical discovery');
    const expectedDistributionId = parsedTarget.kind === 'release'
      ? parsedTarget.distributionId
      : receipt.distributionId;
    if (receipt.distributionId !== expectedDistributionId
      || receipt.version !== row.detected_version
      || receipt.architecture !== architecture) {
      throw new Error('immutable release receipt does not match the target identity');
    }
    if (discovered.identity.distribution.packageProvenance !== receipt.packageProvenance
      || discovered.identity.distribution.portableArtifactFingerprint !== receipt.portableArtifactFingerprint
      || physical.executableSha256 !== receipt.executableSha256
      || physical.executableSizeBytes !== receipt.executableSizeBytes
      || physical.distributionSha256 !== receipt.distributionSha256
      || physical.distributionSizeBytes !== receipt.distributionSizeBytes) {
      throw new Error('live physical distribution does not match its immutable release receipt');
    }
  }
  const persisted = persistedDistribution(row);
  if (!receipt && (!persisted.distributionId || !persisted.packageProvenance)) {
    throw new Error('Custom target persisted distribution identity is incomplete');
  }
  const targetMetadata = {
    targetKey: options.targetKey,
    targetId: parsedTarget.kind === 'release' ? parsedTarget.catalogId : parsedTarget.mode,
    ...(sourceCatalogId ? { sourceCatalogId } : {}),
    hostVersion: row.detected_version,
    distribution: {
      distributionId: receipt?.distributionId ?? persisted.distributionId,
      packageProvenance: receipt?.packageProvenance ?? persisted.packageProvenance,
      artifactReceiptSha256: receipt ? sha256Json(receipt) : null,
      portableArtifactFingerprint: receipt?.portableArtifactFingerprint ?? null,
      ...physical,
    },
    environment: {
      platform: 'darwin',
      architecture,
      processArchitecture: executionEnvironment.processArchitecture,
      hardwareArchitecture: executionEnvironment.hardwareArchitecture,
      translationMode: executionEnvironment.translationMode,
      osVersion,
      hostIdentitySha256: anonymousHostIdentity,
    },
    installationId: row.id,
    agentId: row.agent_id,
    ...(customBinding ? { customBinding } : {}),
  };
  const binding = {
    exporterVersion: 1,
    evidenceClass: options.fixture || options.customHostFixture ? 'fixture' : 'real_host',
    candidateBundleSha256: options.candidateBundleSha256,
    sourceCommit: options.sourceCommit,
    releaseContractSha256: options.releaseContractSha256,
    targetMetadata,
    exportedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  const output = { ...binding, exportHash: sha256Json(binding) };
  const outputParent = path.dirname(outputPath);
  const parentStat = fs.lstatSync(outputParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('target metadata output parent must be an existing directory, not a symlink');
  }
  const descriptor = fs.openSync(
    outputPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(output, null, 2)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function main(): Promise<void> {
  const allowed = new Set([
    '--target-key', '--candidate-bundle-sha256', '--source-commit', '--release-contract-sha256', '--output',
  ]);
  for (let index = 2; index < process.argv.length; index += 2) {
    if (!allowed.has(process.argv[index]) || !process.argv[index + 1]) throw new Error('invalid target metadata exporter arguments');
  }
  await exportAgentHostTargetMetadata({
    targetKey: arg('--target-key'),
    candidateBundleSha256: arg('--candidate-bundle-sha256'),
    sourceCommit: arg('--source-commit'),
    releaseContractSha256: arg('--release-contract-sha256'),
    outputPath: arg('--output'),
  });
}

const directCliNames = new Set(['agent-host-target-metadata-export.cjs', 'host-target-metadata-export.ts']);
if (process.argv[1] && directCliNames.has(path.basename(process.argv[1]))) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
