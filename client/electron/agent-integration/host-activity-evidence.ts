import type Database from 'better-sqlite3'
import { sha256Json } from './fingerprint'
import type {
  AdapterOperationContext,
  AdapterVerificationRequest,
  ComponentVerificationResult,
  HostActivityEvidenceQuery,
  HostActivityEvidenceReader,
  HostActivityEvidenceRecord,
  HostActivitySignal,
} from './types'

interface EvidenceRow {
  id: string
  installation_id: string
  agent_id: string
  host_variant: HostActivityEvidenceRecord['hostVariant']
  component_key: HostActivityEvidenceRecord['componentKey']
  signal_name: HostActivitySignal
  tide_mind_version: string
  adapter_version: string
  projection_version: string
  host_version: string
  evidence_hash: string
  observed_at: string
}

/** Read-only SQLite projection used only by Adapter verification. */
export class SqliteHostActivityEvidenceReader implements HostActivityEvidenceReader {
  constructor(private readonly db: Database.Database) {}

  find(query: HostActivityEvidenceQuery): readonly HostActivityEvidenceRecord[] {
    if (query.signalNames.length === 0) return []
    const placeholders = query.signalNames.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT evidence.*
      FROM agent_host_activity_evidence evidence
      JOIN agent_installations installation
        ON installation.id = evidence.installation_id
       AND installation.agent_id = evidence.agent_id
       AND installation.host_variant = evidence.host_variant
       AND installation.detected_version = evidence.host_version
      JOIN installation_components component
        ON component.installation_id = installation.id
       AND component.component_key = evidence.component_key
      JOIN artifact_consumers consumer
        ON consumer.installation_id = component.installation_id
       AND consumer.component_key = component.component_key
       AND consumer.artifact_id = component.artifact_id
      WHERE evidence.installation_id = ?
        AND evidence.agent_id = ?
        AND evidence.host_variant = ?
        AND evidence.component_key = ?
        AND evidence.signal_name IN (${placeholders})
        AND evidence.tide_mind_version = ?
        AND evidence.adapter_version = ?
        AND evidence.projection_version = ?
        AND evidence.host_version = ?
        AND evidence.observed_at >= ?
        AND evidence.evidence_hash != ''
        AND installation.desired_state = 'managed'
        AND installation.tombstoned_at IS NULL
        AND installation.health_state = 'discovered'
        AND component.desired_state = 'managed'
        AND consumer.state = 'active'
        AND (
          consumer.desired_state = 'managed'
          OR (
            consumer.desired_state = 'disabled'
            AND consumer.consent_envelope_id = installation.consent_envelope_id
            AND component.consent_envelope_id = installation.consent_envelope_id
            AND EXISTS (
              SELECT 1 FROM agent_consents consent
              WHERE consent.id = installation.consent_envelope_id
                AND consent.installation_id = installation.id
                AND consent.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM reconcile_runs pending
              WHERE pending.installation_id = installation.id
                AND pending.consent_envelope_id = installation.consent_envelope_id
                AND pending.operation_type != 'disconnect'
                AND pending.state = 'applied_unverified'
                AND pending.adapter_version = evidence.adapter_version
                AND pending.projection_version = evidence.projection_version
                AND EXISTS (
                  SELECT 1 FROM json_each(
                    CASE WHEN json_valid(pending.prepared_plan_json)
                      THEN pending.prepared_plan_json ELSE '{}' END,
                    '$.componentKeys'
                  ) pending_component
                  WHERE pending_component.value = component.component_key
                )
            )
          )
        )
      ORDER BY evidence.observed_at DESC, evidence.id DESC
    `).all(
      query.installationId,
      query.agentId,
      query.hostVariant,
      query.componentKey,
      ...query.signalNames,
      query.tideMindVersion,
      query.adapterVersion,
      query.projectionVersion,
      query.hostVersion,
      query.observedAfter,
    ) as EvidenceRow[]
    return rows.map(row => ({
      id: row.id,
      installationId: row.installation_id,
      agentId: row.agent_id,
      hostVariant: row.host_variant,
      componentKey: row.component_key,
      signalName: row.signal_name,
      tideMindVersion: row.tide_mind_version,
      adapterVersion: row.adapter_version,
      projectionVersion: row.projection_version,
      hostVersion: row.host_version,
      evidenceHash: row.evidence_hash,
      observedAt: row.observed_at,
    }))
  }
}

export interface VerifyHostActivityOptions {
  componentKey: 'memory_tools' | 'lifecycle'
  signalNames: readonly HostActivitySignal[]
  require: 'any' | 'all'
}

/**
 * Converts fresh runtime invocations into a component verification result.
 * Static file presence remains a separate Adapter precondition.
 */
export async function verifyHostActivity(
  context: AdapterOperationContext,
  request: AdapterVerificationRequest,
  options: VerifyHostActivityOptions,
): Promise<ComponentVerificationResult> {
  const binding = request.activityBinding
  if (!context.hostActivityEvidence || !binding) {
    return unverified(options.componentKey, 'host_activity_evidence_reader_unavailable')
  }
  if (!binding.hostVersion) {
    return unverified(options.componentKey, 'host_version_unproven')
  }
  const freshnessStartMs = Date.parse(binding.observedAfter)
  const verificationMs = Date.parse(binding.verifiedAt)
  if (!Number.isFinite(freshnessStartMs)
    || !Number.isFinite(verificationMs)
    || verificationMs <= freshnessStartMs) {
    return unverified(options.componentKey, 'host_activity_freshness_binding_invalid')
  }
  const records = (await context.hostActivityEvidence.find({
    installationId: binding.installationId,
    agentId: context.agentId,
    hostVariant: context.installation.hostVariant,
    componentKey: options.componentKey,
    signalNames: options.signalNames,
    tideMindVersion: binding.tideMindVersion,
    adapterVersion: binding.adapterVersion,
    projectionVersion: binding.projectionVersion,
    hostVersion: binding.hostVersion,
    observedAfter: binding.observedAfter,
  })).filter(record => {
    const observedMs = Date.parse(record.observedAt)
    // The lower bound is exclusive so a record expiring exactly at
    // verification time cannot be persisted as a verified token. The upper
    // bound prevents a clock-skewed/future row from proving the current run.
    return Number.isFinite(observedMs)
      && observedMs > freshnessStartMs
      && observedMs <= verificationMs
  })
  const present = new Set(records.map(record => record.signalName))
  const recognized = options.require === 'all'
    ? options.signalNames.every(signal => present.has(signal))
    : options.signalNames.some(signal => present.has(signal))
  if (!recognized) {
    return unverified(options.componentKey, 'fresh_host_activity_evidence_missing')
  }
  const selected = options.require === 'all'
    ? options.signalNames.map(signal => records.find(record => record.signalName === signal)!)
    : [records[0]!]
  const freshnessMs = verificationMs - freshnessStartMs
  const expiresAt = new Date(Math.min(...selected.map(record => Date.parse(record.observedAt))) + freshnessMs)
    .toISOString()
  return {
    componentKey: options.componentKey,
    status: 'verified',
    verifiedCapability: options.componentKey === 'memory_tools' ? 2 : 4,
    identityAssertion: context.agentId,
    evidenceRef: `host-activity:${selected.map(record => record.id).sort().join(',')}`,
    evidenceHash: sha256Json(selected.map(record => ({
      id: record.id,
      signalName: record.signalName,
      evidenceHash: record.evidenceHash,
      observedAt: record.observedAt,
    })).sort((left, right) => left.signalName.localeCompare(right.signalName))),
    expiresAt,
    invalidationKeys: [
      'artifact_hash',
      'host_version',
      'adapter_version',
      'projection_version',
      'tide_mind_version',
      'activity_freshness',
    ],
    diagnostics: [`host_activity_recognized:${selected.map(record => record.signalName).sort().join(',')}`],
  }
}

function unverified(
  componentKey: 'memory_tools' | 'lifecycle',
  diagnostic: string,
): ComponentVerificationResult {
  return {
    componentKey,
    status: 'unverified',
    verifiedCapability: null,
    invalidationKeys: [
      'artifact_hash',
      'host_version',
      'adapter_version',
      'projection_version',
      'tide_mind_version',
      'activity_freshness',
    ],
    diagnostics: [diagnostic],
  }
}
