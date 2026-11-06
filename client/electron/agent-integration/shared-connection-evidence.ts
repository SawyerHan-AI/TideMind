import type Database from 'better-sqlite3'
import { evaluateBridgeAdmission } from '@server/agent-bridge-guard.js'
import { getSharedAgentConsumers, resolveInstallationAgentIdentity, sharedAgentActivityKey } from '@server/db/agent-identity-binding.js'
import { sha256Json } from './fingerprint.js'

const FRESHNESS_MS = 30 * 24 * 60 * 60 * 1_000
const SIGNALS = {
  memory_tools: ['brain_prepare', 'brain_recall', 'brain_digest'],
  lifecycle: ['session_start', 'pre_compact', 'post_compact', 'session_end'],
} as const

type Component = keyof typeof SIGNALS
export interface SharedComponentEvidence {
  /** Signal set only; callers still combine source/configuration/native trust facts. */
  signalsComplete: boolean
  signals: Partial<Record<(typeof SIGNALS)[Component][number], string>>
  configurationRevision: string
  configurationFingerprint: string | null
}
export interface SharedConnectionEvidence {
  bindingId: string
  bindingGeneration: number
  memberIds: string[]
  components: Record<Component, SharedComponentEvidence>
}

/** Read only. It reuses bridge admission; presentation never grants new authority. */
export function readSharedConnectionEvidence(db: Database.Database, installationId: string, at: string): SharedConnectionEvidence | undefined {
  const identity = resolveInstallationAgentIdentity(db, installationId)
  if (!identity.bindingId) return undefined
  const shared = getSharedAgentConsumers(db, identity.canonicalAgentId)
  if (!shared) return undefined
  const now = Date.parse(at)
  if (!Number.isFinite(now)) throw new Error('invalid shared evidence observation time')
  const components = {} as Record<Component, SharedComponentEvidence>
  for (const component of ['memory_tools', 'lifecycle'] as const) {
    // Enumerate current physical artifacts, then let the existing bridge guard
    // determine which exact token still has an active consumer/consent.
    const candidates = db.prepare(`SELECT DISTINCT a.id AS artifact_id, a.owned_fragment_hash,
        p.id AS mutation_id, p.committed_at AS applied_at, json_extract(r.prepared_plan_json,'$.activityGenerationToken') AS token
      FROM agent_identity_binding_members member
      JOIN agent_installations i ON i.id=member.installation_id
      JOIN artifact_consumers c ON c.installation_id=i.id
      JOIN installation_components component ON component.installation_id=c.installation_id
        AND component.component_key=c.component_key AND component.artifact_id=c.artifact_id
      JOIN managed_artifacts a ON a.id=c.artifact_id
      JOIN agent_consents consent ON consent.id=c.consent_envelope_id AND consent.installation_id=i.id
      JOIN projection_mutations p ON p.id=(SELECT latest.id FROM projection_mutations latest
        WHERE latest.artifact_id=a.id AND latest.state='committed' AND latest.idempotency_strategy!='consumer_detach_only'
        ORDER BY latest.committed_at DESC, latest.rowid DESC LIMIT 1)
      JOIN reconcile_runs r ON r.id=p.run_id
      WHERE member.binding_id=? AND c.component_key=? AND c.state='active' AND c.tombstoned_at IS NULL
        AND c.desired_state IN ('managed','disabled') AND component.desired_state IN ('managed','disabled')
        AND component.tombstoned_at IS NULL AND component.consent_envelope_id=consent.id
        AND consent.status='active' AND i.consent_envelope_id=consent.id
        AND i.desired_state!='removed' AND i.tombstoned_at IS NULL AND COALESCE(i.bridge_state,'serving')!='stopped'
        AND a.state IN ('healthy','paused') AND a.observed_fragment_hash=a.owned_fragment_hash
      ORDER BY a.id`).all(shared.bindingId, component) as Array<{ artifact_id: string; owned_fragment_hash: string; mutation_id: string; applied_at: string | null; token: string | null }>
    const admitted = candidates.filter(candidate => candidate.token && evaluateBridgeAdmission(db, {
      agentId: identity.canonicalAgentId, activityGenerationToken: candidate.token, componentKey: component,
    }).allowed)
    const bundles = admitted.map(carrier => {
      const signals: SharedComponentEvidence['signals'] = {}
      for (const signal of SIGNALS[component]) {
        const key = sharedAgentActivityKey(shared.bindingId, shared.generation, component, signal, carrier.token!)
        const event = db.prepare(`SELECT created_at, payload_json FROM agent_integration_events
          WHERE kind='shared_agent_activity' AND dedupe_key=?`).get(key) as { created_at: string; payload_json: string } | undefined
        if (!event) continue
        let timestamp = event.created_at
        try { const value = JSON.parse(event.payload_json).lastObservedAt; if (typeof value === 'string') timestamp = value } catch { continue }
        const observed = Date.parse(timestamp)
        if (Number.isFinite(observed) && observed >= Date.parse(carrier.applied_at ?? '') && observed > now - FRESHNESS_MS && observed <= now) signals[signal] = timestamp
      }
      return { carrier, signals }
    })
    // Read and write must belong to one currently admitted carrier, not a mix of
    // an old endpoint's read and a replacement endpoint's write.
    const complete = bundles.find(bundle => component === 'memory_tools'
      ? Boolean(bundle.signals.brain_recall && bundle.signals.brain_digest)
      : SIGNALS.lifecycle.every(signal => Boolean(bundle.signals[signal])))
    const selected = complete ?? bundles.sort((a, b) => Object.keys(b.signals).length - Object.keys(a.signals).length)[0]
    components[component] = {
      signalsComplete: Boolean(complete),
      configurationFingerprint: selected ? sha256Json([selected.carrier.artifact_id, selected.carrier.owned_fragment_hash, selected.carrier.applied_at]) : null,
      signals: selected?.signals ?? {},
      configurationRevision: sha256Json([shared.bindingId, shared.generation, component,
        admitted.map(carrier => [carrier.artifact_id, carrier.owned_fragment_hash, carrier.mutation_id])]),
    }
  }
  return { bindingId: shared.bindingId, bindingGeneration: shared.generation,
    memberIds: shared.consumers.map(member => member.id).sort(), components }
}
