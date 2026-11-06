import Database from 'better-sqlite3';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateBridgeAdmission } from './agent-bridge-guard.js';
import { getTideMindVersion } from './utils/app-version.js';
import { assertSupportedDatabaseSchema, CURRENT_SCHEMA_VERSION } from './db/schema-compatibility.js';
import { agentIdentityDomainKey, resolveInstallationAgentIdentity } from './db/agent-identity-binding.js';

export const AGENT_DIAGNOSTIC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_diagnostic_runs (
  id TEXT PRIMARY KEY,
  protocol_version INTEGER NOT NULL DEFAULT 1 CHECK(protocol_version=1),
  connection_key TEXT NOT NULL,
  configuration_version TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  capability_hash TEXT NOT NULL,
  capability_revoked_at TEXT,
  expires_at TEXT NOT NULL,
  data_dir TEXT NOT NULL UNIQUE,
  allowed_operations_json TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('automatic','manual')),
  billing TEXT CHECK(billing IS NULL OR billing='confirmed_subscription'),
  time_zone TEXT NOT NULL,
  budget_day TEXT NOT NULL,
  budget_reserved INTEGER NOT NULL DEFAULT 0 CHECK(budget_reserved IN (0,1)),
  phase TEXT NOT NULL CHECK(phase IN ('prepared','reserved','submitted','uncertain','succeeded','failed','cancelled','released')),
  active_slot INTEGER CHECK(active_slot IS NULL OR active_slot=1),
  submitted_at TEXT,
  finished_at TEXT,
  outcome_code TEXT,
  process_identity_json TEXT,
  processes_exited_at TEXT,
  cleaned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_diagnostic_one_active
  ON agent_diagnostic_runs(active_slot) WHERE active_slot=1;
CREATE INDEX IF NOT EXISTS idx_agent_diagnostic_budget_day ON agent_diagnostic_runs(budget_day,budget_reserved);
CREATE INDEX IF NOT EXISTS idx_agent_diagnostic_configuration ON agent_diagnostic_runs(connection_key,configuration_version,mode);
`;

export type DiagnosticComponent = 'memory_tools' | 'lifecycle';
export type DiagnosticOperation = 'brain_prepare' | 'brain_recall' | 'brain_digest'
  | 'session_start' | 'pre_compact' | 'post_compact' | 'session_end';
export type DiagnosticPhase = 'prepared' | 'reserved' | 'submitted' | 'uncertain' | 'succeeded' | 'failed' | 'cancelled' | 'released';
export type DiagnosticBilling = 'confirmed_subscription' | 'metered_api' | 'unknown';
export interface DiagnosticComponentBinding {
  artifactId: string;
  ownedFragmentHash: string;
  activityGenerationToken: string;
}
export interface DiagnosticBinding {
  connectionKey: string;
  configurationVersion: string;
  runtimeVersion: string;
  installationSourceHash: string;
  domainKey: string;
  intentRevision: number;
  installationId: string;
  installationAgentId: string;
  canonicalAgentId: string;
  installKey: string;
  bindingId: string | null;
  bindingGeneration: number | null;
  hostVariant: string;
  hostVersion: string;
  executablePath: string;
  configRoot: string;
  distributionId: string;
  sourceIdentityHash: string;
  components: { memory_tools: DiagnosticComponentBinding; lifecycle?: DiagnosticComponentBinding };
}
export interface DiagnosticContextEnvelope {
  protocolVersion: 1;
  controlDatabasePath: string;
  runId: string;
  capability: string;
}
export interface AgentDiagnosticRunRow {
  id: string; protocol_version: 1; connection_key: string; configuration_version: string; binding_json: string;
  nonce: string; capability_hash: string; capability_revoked_at: string | null; expires_at: string; data_dir: string;
  allowed_operations_json: string; mode: 'automatic' | 'manual'; billing: 'confirmed_subscription' | null;
  time_zone: string; budget_day: string; budget_reserved: 0 | 1; phase: DiagnosticPhase; active_slot: 1 | null;
  submitted_at: string | null; finished_at: string | null; outcome_code: string | null;
  process_identity_json: string | null; processes_exited_at: string | null; cleaned_at: string | null; created_at: string; updated_at: string;
}
export interface ValidatedDiagnosticContext {
  kind: 'diagnostic'; protocolVersion: 1; runId: string; nonce: string; dataDir: string;
  databasePath: string; expiresAt: string; binding: DiagnosticBinding; allowedOperations: readonly DiagnosticOperation[];
}
export class AgentDiagnosticError extends Error {
  constructor(readonly code: string) { super(`agent_diagnostic:${code}`); this.name = 'AgentDiagnosticError'; }
}
const fail = (code: string): never => { throw new AgentDiagnosticError(code); };
export const DIAGNOSTIC_OPERATIONS: readonly DiagnosticOperation[] = [
  'brain_prepare','brain_recall','brain_digest','session_start','pre_compact','post_compact','session_end',
];
export function diagnosticHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b))
    .map(([key,item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function diagnosticBindingHash(binding: DiagnosticBinding): string { return diagnosticHash(stableJson(binding)); }
function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return fail('invalid_record');
  try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string,unknown>; }
  catch { /* Never surface input text or credentials in errors. */ }
  return fail('invalid_record');
}
interface InstallationRow {
  id: string; agent_id: string | null; family: string; host_variant: string; runtime_realm: string;
  os_user_identity: string | null; config_root: string | null; profile_id: string; install_key: string;
  desired_state: string; tombstoned_at: string | null; bridge_state: string | null;
  health_state: string; status_reason: string | null; detected_version: string | null;
  executable_path: string | null; distribution_id: string | null; metadata_json: string;
  consent_envelope_id: string | null;
}
function sourceIdentity(row: InstallationRow): unknown {
  const metadata = parseObject(row.metadata_json);
  const source = metadata.distribution && typeof metadata.distribution === 'object' ? metadata.distribution as Record<string,unknown> : {};
  return [row.id,row.host_variant,row.detected_version,row.executable_path,row.config_root,row.distribution_id,
    ...['distributionId','executableRealpath','packageProvenance','capabilityFingerprint','portableArtifactFingerprint'].map(key => source[key] ?? null)];
}
function intentDomain(row: InstallationRow): string {
  if (row.family === 'codex' && ['codex-cli','codex-desktop'].includes(row.host_variant) && row.config_root) {
    return `codex:${agentIdentityDomainKey(row)}`;
  }
  return `installation:${diagnosticHash(JSON.stringify([row.family,row.host_variant,row.runtime_realm,
    row.os_user_identity,row.config_root ?? row.install_key,row.profile_id]))}`;
}
function readAdmittedComponent(
  db: Database.Database, row: InstallationRow,
  identity: ReturnType<typeof resolveInstallationAgentIdentity>, component: DiagnosticComponent, token: string,
): DiagnosticComponentBinding {
  const metadata = parseObject(row.metadata_json);
  const eligibility = metadata.managementEligibility as { reason?: unknown } | undefined;
  // A shared bridge may be served by another member. Do not let that other
  // member's admission stand in for this consumer's explicitly rejected source.
  if (['release_entry_missing','release_mode_detect_only','release_distribution_not_accepted','source_not_official']
    .includes(String(eligibility?.reason))) return fail('source_rejected');
  if (typeof token !== 'string' || !token.trim() || token.length > 1024) return fail('generation_missing');
  const artifact = db.prepare(`SELECT a.id,a.owned_fragment_hash FROM installation_components c
    JOIN artifact_consumers consumer ON consumer.installation_id=c.installation_id
      AND consumer.component_key=c.component_key AND consumer.artifact_id=c.artifact_id
    JOIN managed_artifacts a ON a.id=c.artifact_id
    JOIN agent_consents consent ON consent.id=c.consent_envelope_id AND consent.installation_id=c.installation_id
    WHERE c.installation_id=? AND c.component_key=? AND c.consent_envelope_id=?
      AND c.desired_state IN ('managed','disabled') AND c.tombstoned_at IS NULL
      AND consumer.state='active' AND consumer.desired_state IN ('managed','disabled') AND consumer.tombstoned_at IS NULL
      AND consumer.consent_envelope_id=c.consent_envelope_id AND consent.status='active'
      AND a.state IN ('healthy','paused') AND a.owned_fragment_hash IS NOT NULL
      AND a.owned_fragment_hash=a.observed_fragment_hash AND a.owned_fragment_hash=a.desired_fragment_hash`)
    .get(row.id,component,row.consent_envelope_id) as { id: string; owned_fragment_hash: string } | undefined;
  if (!artifact || !evaluateBridgeAdmission(db,{agentId:identity.canonicalAgentId,activityGenerationToken:token,componentKey:component}).allowed) {
    return fail('bridge_unavailable');
  }
  // Even the single-host legacy admission path must have a real physical carrier.
  const carrier = db.prepare(`SELECT p.after_hash,r.installation_id,r.prepared_plan_json,r.state,r.failure_code,r.operation_type
    FROM projection_mutations p JOIN reconcile_runs r ON r.id=p.run_id
    WHERE p.artifact_id=? AND p.state='committed' AND p.idempotency_strategy!='consumer_detach_only'
    ORDER BY p.committed_at DESC,p.rowid DESC LIMIT 1`).get(artifact.id) as
    { after_hash: string | null; installation_id: string; prepared_plan_json: string; state: string; failure_code: string | null; operation_type: string } | undefined;
  if (!carrier || carrier.after_hash !== artifact.owned_fragment_hash || carrier.operation_type === 'disconnect'
    || !(['applied_unverified','verified','committed'].includes(carrier.state)
      || (carrier.state === 'cancelled' && ['superseded_by_shared_disconnect','superseded_by_same_generation_connect',
        'superseded_by_same_generation_repair','superseded_by_confirmed_generation','superseded_by_disconnect'].includes(carrier.failure_code ?? '')))) return fail('carrier_unavailable');
  const carrierPlan = parseObject(carrier.prepared_plan_json);
  const execution = carrierPlan.executionPlan as Record<string,unknown> | undefined;
  if (carrierPlan.activityGenerationToken !== token || execution?.activityGenerationTokenHash !== diagnosticHash(JSON.stringify(token))) return fail('generation_changed');
  if (identity.bindingId) {
    const member = db.prepare('SELECT 1 FROM agent_identity_binding_members WHERE installation_id=? AND binding_id=?').get(carrier.installation_id,identity.bindingId);
    if (!member) return fail('carrier_identity_changed');
  } else if (carrier.installation_id !== row.id) return fail('carrier_identity_changed');
  return { artifactId: artifact.id, ownedFragmentHash: artifact.owned_fragment_hash, activityGenerationToken: token };
}

/** Reads only. Missing/empty ledgers are never a diagnostic admission shortcut. */
export function captureDiagnosticBinding(
  db: Database.Database,
  installationId: string,
  tokens: { memory_tools: string; lifecycle?: string },
  options: { runtimeVersion?: string } = {},
): DiagnosticBinding {
  try {
    const runtimeVersion = options.runtimeVersion ?? getTideMindVersion();
    if (typeof runtimeVersion !== 'string' || !runtimeVersion.trim() || runtimeVersion.length > 128) return fail('runtime_version_missing');
    return db.transaction(() => {
      const row = db.prepare('SELECT * FROM agent_installations WHERE id=?').get(installationId) as InstallationRow | undefined;
      if (!row || !row.agent_id || row.desired_state !== 'managed' || row.tombstoned_at || row.bridge_state === 'stopped'
        || row.health_state !== 'discovered' || row.status_reason === 'conflict' || !row.consent_envelope_id
        || !row.detected_version || !row.executable_path || !row.config_root || !row.distribution_id) return fail('installation_unavailable');
      const identity = resolveInstallationAgentIdentity(db, row.id);
      const agent = db.prepare('SELECT archived FROM agents WHERE id=?').get(identity.canonicalAgentId) as { archived: number } | undefined;
      if (!agent || agent.archived !== 0) return fail('identity_unavailable');
      const domainKey = intentDomain(row);
      const storedIntent = db.prepare('SELECT value FROM metadata WHERE key=?').get(`agent_connection_intent:${domainKey}`) as { value: string } | undefined;
      let revision = 0;
      if (storedIntent) {
        const intent = parseObject(storedIntent.value);
        if (intent.domainKey !== domainKey || !Number.isSafeInteger(intent.revision) || Number(intent.revision) < 1
          || intent.state !== 'active' || !Array.isArray(intent.excludedMemberIds)
          || intent.excludedMemberIds.some(id => typeof id !== 'string') || intent.excludedMemberIds.includes(row.id)) return fail('intent_inactive');
        revision = Number(intent.revision);
      }
      const components: DiagnosticBinding['components'] = {} as DiagnosticBinding['components'];
      for (const component of ['memory_tools','lifecycle'] as const) {
        const token = tokens[component];
        if (component === 'lifecycle' && token === undefined) continue;
        components[component] = readAdmittedComponent(db,row,identity,component,token!);
      }
      const members = identity.bindingId ? db.prepare(`SELECT i.* FROM agent_identity_binding_members m
        JOIN agent_installations i ON i.id=m.installation_id WHERE m.binding_id=? ORDER BY i.id`).all(identity.bindingId) as InstallationRow[] : [row];
      const sourceIdentityHash = diagnosticHash(stableJson(members.map(sourceIdentity)));
      const connectionKey = identity.bindingId ? `binding:${identity.bindingId}` : `installation:${row.id}`;
      const installationSourceHash = diagnosticHash(stableJson(sourceIdentity(row)));
      const configurationVersion = diagnosticHash(stableJson({ connectionKey,bindingGeneration:identity.bindingGeneration,sourceIdentityHash,runtimeVersion,components }));
      return { connectionKey,configurationVersion,runtimeVersion,installationSourceHash,domainKey,intentRevision:revision,installationId:row.id,
        installationAgentId:identity.installationAgentId,canonicalAgentId:identity.canonicalAgentId,installKey:row.install_key,
        bindingId:identity.bindingId,bindingGeneration:identity.bindingGeneration,hostVariant:row.host_variant,
        hostVersion:row.detected_version,executablePath:row.executable_path,configRoot:row.config_root,
        distributionId:row.distribution_id,sourceIdentityHash,components };
    })();
  } catch (error) { if (error instanceof AgentDiagnosticError) throw error; return fail('control_ledger_unavailable'); }
}
export function assertDiagnosticBindingCurrent(db: Database.Database, binding: DiagnosticBinding): void {
  try {
    if (typeof binding.runtimeVersion !== 'string' || !binding.runtimeVersion.trim()) return fail('runtime_version_missing');
    const current = captureDiagnosticBinding(db,binding.installationId,{
      memory_tools:binding.components.memory_tools.activityGenerationToken,
      ...(binding.components.lifecycle ? { lifecycle:binding.components.lifecycle.activityGenerationToken } : {}),
    },{runtimeVersion:binding.runtimeVersion});
    if (diagnosticBindingHash(current) !== diagnosticBindingHash(binding)) fail('binding_changed');
  } catch (error) { if (error instanceof AgentDiagnosticError) throw error; fail('invalid_binding'); }
}
/**
 * Historical connection-level memory evidence only: never execution authority,
 * a host-specific Desktop/CLI receipt, or lifecycle evidence. The controller
 * separately requires a successful diagnostic receipt within its freshness window.
 */
export function isDiagnosticMemoryEvidenceCurrent(db: Database.Database, binding: DiagnosticBinding,
  options: { runtimeVersion?: string } = {}): boolean {
  try {
    const runtimeVersion = options.runtimeVersion ?? getTideMindVersion();
    if (!binding.runtimeVersion || binding.runtimeVersion !== runtimeVersion
      || !binding.components?.memory_tools?.activityGenerationToken) return false;
    return db.transaction(() => {
      assertSupportedDatabaseSchema(db,CURRENT_SCHEMA_VERSION);
      const agent = db.prepare('SELECT archived FROM agents WHERE id=?').get(binding.canonicalAgentId) as { archived: number } | undefined;
      if (!agent || agent.archived !== 0) return false;
      let candidates: InstallationRow[];
      if (binding.bindingId !== null) {
        const current = db.prepare('SELECT canonical_agent_id,generation FROM agent_identity_bindings WHERE id=?').get(binding.bindingId) as
          { canonical_agent_id: string; generation: number } | undefined;
        if (!current || current.canonical_agent_id !== binding.canonicalAgentId || current.generation !== binding.bindingGeneration
          || binding.connectionKey !== `binding:${binding.bindingId}`) return false;
        candidates = db.prepare(`SELECT i.* FROM agent_identity_binding_members m JOIN agent_installations i ON i.id=m.installation_id
          WHERE m.binding_id=? ORDER BY i.id`).all(binding.bindingId) as InstallationRow[];
      } else {
        if (binding.bindingGeneration !== null || binding.connectionKey !== `installation:${binding.installationId}`) return false;
        const row = db.prepare('SELECT * FROM agent_installations WHERE id=?').get(binding.installationId) as InstallationRow | undefined;
        candidates = row ? [row] : [];
      }
      const stored = db.prepare('SELECT value FROM metadata WHERE key=?').get(`agent_connection_intent:${binding.domainKey}`) as { value: string } | undefined;
      let excluded: string[] = [];
      if (stored) {
        const intent = parseObject(stored.value);
        if (intent.domainKey !== binding.domainKey || !['active','paused'].includes(String(intent.state))
          || !Number.isSafeInteger(intent.revision) || Number(intent.revision) < 1
          || !Array.isArray(intent.excludedMemberIds) || intent.excludedMemberIds.some(id => typeof id !== 'string')) return false;
        excluded = intent.excludedMemberIds as string[];
      }
      for (const row of candidates) {
        if (!['managed','disabled'].includes(row.desired_state) || row.tombstoned_at || row.bridge_state === 'stopped'
          || (row.health_state === 'inaccessible' && row.status_reason === 'conflict')
          || excluded.includes(row.id) || !row.consent_envelope_id || !row.agent_id || intentDomain(row) !== binding.domainKey) continue;
        try {
          const identity = resolveInstallationAgentIdentity(db,row.id);
          if (identity.canonicalAgentId !== binding.canonicalAgentId || identity.bindingId !== binding.bindingId
            || identity.bindingGeneration !== binding.bindingGeneration) continue;
          if (binding.bindingId === null && (identity.installationAgentId !== binding.installationAgentId
            || row.install_key !== binding.installKey
            || diagnosticHash(stableJson(sourceIdentity(row))) !== binding.installationSourceHash)) continue;
          // Do not compare the group budget version: a member exit or an
          // unrelated Hook generation cannot revoke an unchanged memory carrier.
          const current = readAdmittedComponent(db,row,identity,'memory_tools',binding.components.memory_tools.activityGenerationToken);
          const previous = binding.components.memory_tools;
          if (current.artifactId === previous.artifactId && current.ownedFragmentHash === previous.ownedFragmentHash
            && current.activityGenerationToken === previous.activityGenerationToken) return true;
        } catch { /* This consumer is not authoritative; a shared sibling may still be. */ }
      }
      return false;
    })();
  } catch { return false; }
}

export function parseDiagnosticEnvironment(env: NodeJS.ProcessEnv): DiagnosticContextEnvelope | null {
  const required = env.TIDEMIND_DIAGNOSTIC_REQUIRED;
  const raw = env.TIDEMIND_DIAGNOSTIC_CONTEXT;
  if (required === undefined && raw === undefined) return null;
  if (required !== '1' || !raw || raw.length > 16_384) return fail('credential_required');
  const value = parseObject(raw);
  if (value.protocolVersion !== 1 || typeof value.controlDatabasePath !== 'string' || !path.isAbsolute(value.controlDatabasePath)
    || typeof value.runId !== 'string' || !/^diag_[a-f0-9]{32}$/.test(value.runId)
    || typeof value.capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.capability)) return fail('invalid_credential');
  return value as unknown as DiagnosticContextEnvelope;
}
/** Must be called before loading business configuration, and again at each diagnostic tool/hook entry. */
function validateDiagnosticContext(env: NodeJS.ProcessEnv, options: {
  /** Resolved from normal configuration BEFORE any diagnostic redirection, never from this envelope. */
  trustedControlDatabasePath: string;
  componentKey?: DiagnosticComponent;
  agentId?: string;
  activityGenerationToken?: string;
  operation?: DiagnosticOperation;
  now?: Date;
}): { kind: 'normal' } | ValidatedDiagnosticContext {
  const envelope = parseDiagnosticEnvironment(env);
  if (!envelope) return { kind:'normal' };
  let db: Database.Database | undefined;
  try {
    if (!path.isAbsolute(options.trustedControlDatabasePath)
      || fs.realpathSync(envelope.controlDatabasePath) !== fs.realpathSync(options.trustedControlDatabasePath)) return fail('control_path_mismatch');
    db = new Database(options.trustedControlDatabasePath,{ readonly:true,fileMustExist:true });
    assertSupportedDatabaseSchema(db,CURRENT_SCHEMA_VERSION);
    return db.transaction((): ValidatedDiagnosticContext => {
      const row = db!.prepare('SELECT * FROM agent_diagnostic_runs WHERE id=?').get(envelope.runId) as AgentDiagnosticRunRow | undefined;
      const now = options.now ?? new Date();
      if (!row || row.protocol_version !== 1 || !['prepared','reserved','submitted'].includes(row.phase) || row.active_slot !== 1
        || row.capability_revoked_at || row.cleaned_at || row.processes_exited_at
        || !(Date.parse(row.expires_at) > now.getTime())) return fail('credential_inactive');
      if (!/^[a-f0-9]{64}$/.test(row.capability_hash)
        || !timingSafeEqual(Buffer.from(row.capability_hash,'hex'),Buffer.from(diagnosticHash(envelope.capability),'hex'))) return fail('credential_mismatch');
      const binding = parseObject(row.binding_json) as unknown as DiagnosticBinding;
      if (row.connection_key !== binding.connectionKey || row.configuration_version !== binding.configurationVersion
        || !/^[a-f0-9]{48}$/.test(row.nonce)
        || (row.phase === 'prepared' && (row.budget_reserved !== 0 || row.billing !== null || row.submitted_at !== null))
        || (row.phase === 'reserved' && (row.budget_reserved !== 1 || row.billing !== 'confirmed_subscription' || row.submitted_at !== null))
        || (row.phase === 'submitted' && (row.budget_reserved !== 1 || row.billing !== 'confirmed_subscription' || !row.submitted_at))) return fail('invalid_record');
      assertDiagnosticBindingCurrent(db!,binding);
      if (options.componentKey) {
        const component = binding.components[options.componentKey];
        if (!component || (options.agentId ?? env.EB_AGENT_ID) !== binding.canonicalAgentId
          || (options.activityGenerationToken ?? env.EB_ACTIVITY_GENERATION_TOKEN) !== component.activityGenerationToken) return fail('caller_binding_mismatch');
      }
      let operations: DiagnosticOperation[];
      try { operations=JSON.parse(row.allowed_operations_json) as DiagnosticOperation[]; } catch { return fail('invalid_operations'); }
      if (!Array.isArray(operations) || !operations.length || operations.some(operation => !DIAGNOSTIC_OPERATIONS.includes(operation))
        || (options.operation && (!operations.includes(options.operation)
          || options.operation.startsWith('brain_') !== (options.componentKey === 'memory_tools')))) return fail('operation_denied');
      if (!path.isAbsolute(row.data_dir) || path.basename(row.data_dir) !== row.id || fs.lstatSync(row.data_dir).isSymbolicLink()
        || !fs.lstatSync(row.data_dir).isDirectory() || fs.realpathSync(row.data_dir) !== row.data_dir) return fail('diagnostic_directory_invalid');
      const directoryStat = fs.statSync(row.data_dir);
      if ((directoryStat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid())) return fail('diagnostic_directory_invalid');
      const marker = parseObject(fs.readFileSync(path.join(row.data_dir,'.agent-diagnostic-run.json'),'utf8'));
      if (marker.protocolVersion !== 1 || marker.runId !== row.id || marker.nonce !== row.nonce) return fail('diagnostic_directory_invalid');
      return {kind:'diagnostic',protocolVersion:1,runId:row.id,nonce:row.nonce,dataDir:row.data_dir,
        databasePath:path.join(row.data_dir,'graph','brain.sqlite'),expiresAt:row.expires_at,binding,allowedOperations:operations};
    })();
  } catch (error) {
    if (error instanceof AgentDiagnosticError || (error && typeof error === 'object'
      && 'code' in error && typeof error.code === 'string' && error.code.startsWith('DATABASE_'))) throw error;
    return fail('diagnostic_unavailable');
  }
  finally { db?.close(); }
}

const contextCredentials = new WeakMap<ValidatedDiagnosticContext, { env: NodeJS.ProcessEnv; trustedControlDatabasePath: string }>();
export function isDiagnosticRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TIDEMIND_DIAGNOSTIC_REQUIRED !== undefined || env.TIDEMIND_DIAGNOSTIC_CONTEXT !== undefined;
}
export function readDiagnosticContext(options: {
  trustedControlDatabasePath: string; env?: NodeJS.ProcessEnv; now?: Date;
}): ValidatedDiagnosticContext | null {
  const source = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = { TIDEMIND_DIAGNOSTIC_REQUIRED: source.TIDEMIND_DIAGNOSTIC_REQUIRED,
    TIDEMIND_DIAGNOSTIC_CONTEXT: source.TIDEMIND_DIAGNOSTIC_CONTEXT };
  const context = validateDiagnosticContext(env,options);
  if (context.kind === 'normal') return null;
  contextCredentials.set(context,{env,trustedControlDatabasePath:options.trustedControlDatabasePath});
  return context;
}
export function assertDiagnosticBridge(context: ValidatedDiagnosticContext, input: {
  agentId: string; activityGenerationToken: string; componentKey: DiagnosticComponent; operation?: DiagnosticOperation; now?: Date;
}): void {
  const credentials = contextCredentials.get(context);
  if (!credentials) return fail('unbound_context');
  const current = validateDiagnosticContext(credentials.env,{...input,trustedControlDatabasePath:credentials.trustedControlDatabasePath});
  if (current.kind !== 'diagnostic' || current.runId !== context.runId || current.nonce !== context.nonce
    || current.dataDir !== context.dataDir || diagnosticBindingHash(current.binding) !== diagnosticBindingHash(context.binding)) fail('context_changed');
}
/** Convenience entry for callers which already know their exact MCP/hook identity. */
export function resolveAgentDiagnosticContext(env: NodeJS.ProcessEnv, options: {
  trustedControlDatabasePath: string; componentKey: DiagnosticComponent; agentId?: string;
  activityGenerationToken?: string; operation?: DiagnosticOperation; now?: Date;
}): { kind: 'normal' } | ValidatedDiagnosticContext {
  const context = readDiagnosticContext({...options,env});
  if (!context) return {kind:'normal'};
  assertDiagnosticBridge(context,{...options,agentId:options.agentId ?? env.EB_AGENT_ID ?? '',
    activityGenerationToken:options.activityGenerationToken ?? env.EB_ACTIVITY_GENERATION_TOKEN ?? ''});
  return context;
}
