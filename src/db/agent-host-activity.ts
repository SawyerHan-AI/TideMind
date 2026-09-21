import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { touchAgent } from './agents.js';

export type HostActivityComponent = 'memory_tools' | 'lifecycle';
export type HostActivitySignal =
  | 'brain_prepare'
  | 'brain_recall'
  | 'brain_digest'
  | 'session_start'
  | 'pre_compact'
  | 'session_end'
  | 'post_compact';

export type RecordHostActivityResult =
  | { status: 'recorded'; evidenceId: string; installationId: string }
  | {
      status: 'rejected';
      reason:
        | 'unknown_agent'
        | 'agent_archived'
        | 'installation_removed'
        | 'installation_not_managed'
        | 'installation_tombstoned'
        | 'host_not_present'
        | 'host_variant_mismatch'
        | 'signal_component_mismatch'
        | 'component_not_managed'
        | 'activity_generation_mismatch'
        | 'version_binding_missing';
    };

export interface RecordHostActivityInput {
  agentId: string;
  componentKey: HostActivityComponent;
  signalName: HostActivitySignal;
  tideMindVersion: string;
  /** Exact Catalog host variant emitted by the managed projection. */
  hostVariant: string;
  /** Opaque token returned by the exact managed runtime projection. */
  activityGenerationToken: string;
  observedAt?: string;
}

export interface RecordHookActivityInput {
  agentId: string;
  tool: string;
  signalName: 'session_start' | 'pre_compact' | 'session_end' | 'post_compact';
  tideMindVersion: string;
  activityGenerationToken: string;
  observedAt?: string;
}

interface ActivityBindingRow {
  installation_id: string;
  host_variant: string;
  desired_state: string;
  tombstoned_at: string | null;
  health_state: string;
  detected_version: string | null;
  legacy_archived: number | null;
  component_desired_state: string | null;
  component_delivery_mode: string | null;
  component_artifact_id: string | null;
  component_consent_id: string | null;
  consumer_state: string | null;
  consumer_desired_state: string | null;
  consumer_consent_id: string | null;
  current_consent_id: string | null;
  current_consent_active: number;
  pending_activation_authorized: number;
}

interface GenerationBindingRow {
  id: string;
  adapter_version: string | null;
  projection_version: string | null;
  activity_generation_token: string | null;
  activity_generation_token_hash: string | null;
}

function sha256(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function evidenceId(): string {
  return `aha_${randomBytes(12).toString('hex')}`;
}

function validIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function diagnoseRejectedIdentity(
  db: Database.Database,
  agentId: string,
  reason: 'unknown_agent' | 'agent_archived' | 'installation_removed' | 'installation_tombstoned',
): RecordHostActivityResult {
  // Reuse the legacy activity diagnostic path because it already deduplicates
  // unknown/archived/removed/tombstoned events without reviving the identity.
  // Diagnostic persistence is deliberately best-effort and never changes the
  // rejection returned to this stricter evidence writer.
  try {
    touchAgent(db, agentId);
  } catch {
    // A missing/repairing diagnostic table must not turn rejection into an MCP
    // business failure or allow evidence to be written.
  }
  return { status: 'rejected', reason };
}

const TOOL_HOST_VARIANTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'claude-code': ['claude-code-cli', 'claude-code-native'],
  codex: ['codex-cli', 'codex-desktop'],
  cursor: ['cursor-desktop'],
  windsurf: ['windsurf-desktop'],
  gemini: ['gemini-cli'],
  'kimi-code': ['kimi-code-cli', 'kimi-code-native'],
  openclaw: ['openclaw-local'],
  'qwen-code': ['qwen-code-cli'],
  qwen: ['qwen-code-cli'],
  qwenwork: ['qwenwork-desktop'],
  zcode: ['zcode-desktop'],
  opencode: ['opencode-v1-cli', 'opencode-v2-beta-cli'],
  pi: ['pi-official-cli'],
  omp: ['omp-cli'],
});

/** Resolves a hook's legacy --tool hint back to the exact managed variant. */
export function recordHookActivityEvidence(
  db: Database.Database,
  input: RecordHookActivityInput,
): RecordHostActivityResult {
  const agentId = input.agentId.trim();
  if (!agentId) return { status: 'rejected', reason: 'version_binding_missing' };
  const installation = db.prepare(`
    SELECT host_variant FROM agent_installations WHERE agent_id = ? LIMIT 1
  `).get(agentId) as { host_variant: string } | undefined;
  if (!installation) return diagnoseRejectedIdentity(db, agentId, 'unknown_agent');
  const allowed = TOOL_HOST_VARIANTS[input.tool.trim()] ?? [];
  if (!allowed.includes(installation.host_variant)) {
    return { status: 'rejected', reason: 'host_variant_mismatch' };
  }
  return recordHostActivityEvidence(db, {
    agentId,
    hostVariant: installation.host_variant,
    componentKey: 'lifecycle',
    signalName: input.signalName,
    tideMindVersion: input.tideMindVersion,
    activityGenerationToken: input.activityGenerationToken,
    observedAt: input.observedAt,
  });
}

/**
 * Records a successful invocation from a managed projection.
 *
 * The caller supplies only non-secret identity/version facts. Installation,
 * component ownership, host version and current Adapter/projection generations
 * are re-read transactionally from the local integration ledger. Unknown,
 * removed, tombstoned, archived or physically absent hosts are rejected and
 * never revived.
 */
export function recordHostActivityEvidence(
  db: Database.Database,
  input: RecordHostActivityInput,
): RecordHostActivityResult {
  const agentId = input.agentId.trim();
  const tideMindVersion = input.tideMindVersion.trim();
  const hostVariant = input.hostVariant.trim();
  const activityGenerationToken = input.activityGenerationToken?.trim() ?? '';
  const rawObservedAt = input.observedAt ?? new Date().toISOString();
  if (!agentId || !tideMindVersion || !hostVariant || !activityGenerationToken || !validIso(rawObservedAt)) {
    return { status: 'rejected', reason: 'version_binding_missing' };
  }
  // Persist one canonical UTC representation so lexical SQLite ordering and
  // the evidence hash agree even when a host reports an explicit offset.
  const observedAt = new Date(Date.parse(rawObservedAt)).toISOString();
  const memorySignal = input.signalName.startsWith('brain_');
  if ((input.componentKey === 'memory_tools') !== memorySignal) {
    return { status: 'rejected', reason: 'signal_component_mismatch' };
  }

  return db.transaction((): RecordHostActivityResult => {
    const installation = db.prepare(`
      SELECT i.id AS installation_id, i.host_variant, i.desired_state,
             i.tombstoned_at, i.health_state, i.detected_version,
             legacy.archived AS legacy_archived,
             component.desired_state AS component_desired_state,
             component.delivery_mode AS component_delivery_mode,
             component.artifact_id AS component_artifact_id,
             component.consent_envelope_id AS component_consent_id,
             consumer.state AS consumer_state,
             consumer.desired_state AS consumer_desired_state,
             consumer.consent_envelope_id AS consumer_consent_id,
             i.consent_envelope_id AS current_consent_id,
             CASE WHEN EXISTS (
               SELECT 1 FROM agent_consents current_consent
               WHERE current_consent.id = i.consent_envelope_id
                 AND current_consent.installation_id = i.id
                 AND current_consent.status = 'active'
             ) THEN 1 ELSE 0 END AS current_consent_active,
             CASE WHEN consumer.desired_state = 'disabled'
                    AND consumer.state = 'active'
                    AND consumer.consent_envelope_id = i.consent_envelope_id
                    AND component.consent_envelope_id = i.consent_envelope_id
                    AND EXISTS (
                      SELECT 1 FROM agent_consents consent
                      WHERE consent.id = i.consent_envelope_id
                        AND consent.installation_id = i.id
                        AND consent.status = 'active'
                    )
                    AND EXISTS (
                      SELECT 1 FROM reconcile_runs pending
                      WHERE pending.installation_id = i.id
                        AND pending.consent_envelope_id = i.consent_envelope_id
                        AND pending.operation_type != 'disconnect'
                        AND pending.state = 'applied_unverified'
                        AND EXISTS (
                          SELECT 1 FROM json_each(
                            CASE WHEN json_valid(pending.prepared_plan_json)
                              THEN pending.prepared_plan_json ELSE '{}' END,
                            '$.componentKeys'
                          ) pending_component
                          WHERE pending_component.value = component.component_key
                        )
                    )
                  THEN 1 ELSE 0 END AS pending_activation_authorized
      FROM agent_installations i
      LEFT JOIN agents legacy ON legacy.id = i.agent_id
      LEFT JOIN installation_components component
        ON component.installation_id = i.id AND component.component_key = ?
      LEFT JOIN artifact_consumers consumer
        ON consumer.installation_id = i.id
       AND consumer.component_key = component.component_key
       AND consumer.artifact_id = component.artifact_id
      WHERE i.agent_id = ?
      LIMIT 1
    `).get(input.componentKey, agentId) as ActivityBindingRow | undefined;

    if (!installation) return diagnoseRejectedIdentity(db, agentId, 'unknown_agent');
    if (installation.legacy_archived === 1) {
      return diagnoseRejectedIdentity(db, agentId, 'agent_archived');
    }
    if (installation.desired_state === 'removed') {
      return diagnoseRejectedIdentity(db, agentId, 'installation_removed');
    }
    if (installation.tombstoned_at !== null) {
      return diagnoseRejectedIdentity(db, agentId, 'installation_tombstoned');
    }
    if (installation.desired_state !== 'managed') {
      return { status: 'rejected', reason: 'installation_not_managed' };
    }
    if (installation.health_state !== 'discovered') {
      return { status: 'rejected', reason: 'host_not_present' };
    }
    if (installation.host_variant !== hostVariant) {
      return { status: 'rejected', reason: 'host_variant_mismatch' };
    }
    const activeManagedConsumer = installation.consumer_state === 'active'
      && installation.consumer_desired_state === 'managed'
      && installation.current_consent_id !== null
      && installation.component_consent_id === installation.current_consent_id
      && installation.consumer_consent_id === installation.current_consent_id
      && installation.current_consent_active === 1;
    const exactPendingConsumer = installation.consumer_state === 'active'
      && installation.consumer_desired_state === 'disabled'
      && installation.pending_activation_authorized === 1;
    const guidedComponent = installation.component_delivery_mode === 'guided'
      && installation.component_artifact_id === null
      && installation.component_consent_id === installation.current_consent_id
      && Boolean(db.prepare(`
        SELECT 1 FROM agent_consents consent
        WHERE consent.id = ? AND consent.installation_id = ? AND consent.status = 'active'
      `).get(installation.current_consent_id, installation.installation_id));
    if (installation.component_desired_state !== 'managed'
      || (!activeManagedConsumer && !exactPendingConsumer && !guidedComponent)) {
      return { status: 'rejected', reason: 'component_not_managed' };
    }
    if (!installation.detected_version) {
      return { status: 'rejected', reason: 'version_binding_missing' };
    }

    const generation = db.prepare(`
      SELECT run.id, run.adapter_version, run.projection_version,
             json_extract(run.prepared_plan_json, '$.activityGenerationToken') AS activity_generation_token,
             json_extract(run.prepared_plan_json, '$.executionPlan.activityGenerationTokenHash') AS activity_generation_token_hash
      FROM reconcile_runs run
      WHERE run.installation_id = ?
        AND run.operation_type != 'disconnect'
        AND (
          (? = 0 AND run.state IN ('applied_unverified','verified','committed')
            AND run.consent_envelope_id = ?)
          OR (
            ? = 1 AND run.state = 'applied_unverified'
            AND run.consent_envelope_id = ?
          )
          OR (
            ? = 2 AND run.state IN ('applied_unverified','verified','committed')
            AND run.consent_envelope_id = ?
          )
        )
        AND EXISTS (
          SELECT 1 FROM json_each(
            CASE WHEN json_valid(run.prepared_plan_json) THEN run.prepared_plan_json ELSE '{}' END,
            '$.componentKeys'
          ) component
          WHERE component.value = ?
        )
      ORDER BY run.rowid DESC
      LIMIT 1
    `).get(
      installation.installation_id,
      guidedComponent ? 2 : exactPendingConsumer ? 1 : 0,
      installation.current_consent_id,
      guidedComponent ? 2 : exactPendingConsumer ? 1 : 0,
      installation.current_consent_id,
      guidedComponent ? 2 : exactPendingConsumer ? 1 : 0,
      installation.current_consent_id,
      input.componentKey,
    ) as GenerationBindingRow | undefined;
    const adapterVersion = generation?.adapter_version?.trim();
    const projectionVersion = generation?.projection_version?.trim();
    if (!generation || !adapterVersion || !projectionVersion) {
      return { status: 'rejected', reason: 'version_binding_missing' };
    }
    if (generation.activity_generation_token !== activityGenerationToken
      || generation.activity_generation_token_hash !== sha256Json(activityGenerationToken)) {
      return { status: 'rejected', reason: 'activity_generation_mismatch' };
    }

    const id = evidenceId();
    const hash = sha256([
      installation.installation_id,
      generation.id,
      agentId,
      hostVariant,
      input.componentKey,
      input.signalName,
      tideMindVersion,
      adapterVersion,
      projectionVersion,
      installation.detected_version,
      activityGenerationToken,
      observedAt,
    ]);
    db.prepare(`
      INSERT INTO agent_host_activity_evidence (
        id, installation_id, activation_run_id, agent_id, host_variant, component_key,
        signal_name, tide_mind_version, adapter_version, projection_version,
        host_version, evidence_hash, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        activation_run_id, installation_id, component_key, signal_name, tide_mind_version,
        adapter_version, projection_version, host_version
      ) DO UPDATE SET
        id = excluded.id,
        agent_id = excluded.agent_id,
        host_variant = excluded.host_variant,
        evidence_hash = excluded.evidence_hash,
        observed_at = excluded.observed_at
      -- The writer already proved the exact current activation generation.
      -- Within that run, equal wall-clock timestamps may replace a prior
      -- observation only when the exact payload hash changed.
      WHERE julianday(excluded.observed_at) > julianday(agent_host_activity_evidence.observed_at)
         OR (
           julianday(excluded.observed_at) = julianday(agent_host_activity_evidence.observed_at)
           AND excluded.evidence_hash != agent_host_activity_evidence.evidence_hash
         )
    `).run(
      id,
      installation.installation_id,
      generation.id,
      agentId,
      hostVariant,
      input.componentKey,
      input.signalName,
      tideMindVersion,
      adapterVersion,
      projectionVersion,
      installation.detected_version,
      hash,
      observedAt,
    );

    const persisted = db.prepare(`
      SELECT id FROM agent_host_activity_evidence
      WHERE activation_run_id = ? AND installation_id = ? AND component_key = ? AND signal_name = ?
        AND tide_mind_version = ? AND adapter_version = ?
        AND projection_version = ? AND host_version = ?
    `).get(
      generation.id,
      installation.installation_id,
      input.componentKey,
      input.signalName,
      tideMindVersion,
      adapterVersion,
      projectionVersion,
      installation.detected_version,
    ) as { id: string };
    db.prepare(`
      UPDATE agents SET last_active = ?
      WHERE id = ? AND archived = 0
        AND (last_active IS NULL OR julianday(?) > julianday(last_active))
    `).run(observedAt, agentId, observedAt);
    return {
      status: 'recorded',
      evidenceId: persisted.id,
      installationId: installation.installation_id,
    };
  })();
}
