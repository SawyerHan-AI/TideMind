import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { getSharedAgentConsumers, sharedAgentActivityKey } from './db/agent-identity-binding.js';
import { evaluateBridgeAdmission } from './agent-bridge-guard.js';
import { currentAntigravityRule } from './antigravity-rule-evidence.js';
import type { HostActivitySignal } from './db/agent-host-activity.js';

export interface SharedActivityQuery {
  installationId: string;
  agentId: string;
  hostVariant: string;
  componentKey: 'memory_tools' | 'lifecycle';
  signalNames: readonly HostActivitySignal[];
  tideMindVersion: string;
  adapterVersion: string;
  projectionVersion: string;
  hostVersion: string;
  activationRunId: string;
  activityGenerationToken: string;
  observedAfter: string;
}
export interface SharedActivityObservation {
  id: string;
  signalName: HostActivitySignal;
  evidenceHash: string;
  observedAt: string;
}
const sha256Json = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Read current configuration-domain activity; never synthesizes host receipts. */
export function readAntigravitySharedActivity(db: Database.Database, query: SharedActivityQuery): readonly SharedActivityObservation[] {
    const shared = getSharedAgentConsumers(db, query.agentId)
    if (!shared || !shared.consumers.every(member => member.family === 'antigravity')
      || !shared.consumers.some(member => member.id === query.installationId)) return []
    if (!evaluateBridgeAdmission(db, {agentId:query.agentId,
      activityGenerationToken:query.activityGenerationToken,componentKey:query.componentKey}).allowed) return []
    // A domain event can satisfy a current consumer's component contract, but
    // does not become a host-version / host-origin receipt for that consumer.
    const current = db.prepare(`SELECT a.id, a.owned_fragment_hash FROM reconcile_runs r
      JOIN agent_installations i ON i.id=r.installation_id
      JOIN agent_consents consent ON consent.id=i.consent_envelope_id
      JOIN installation_components component ON component.installation_id=i.id AND component.component_key=?
      JOIN artifact_consumers c ON c.installation_id=i.id AND c.component_key=component.component_key AND c.artifact_id=component.artifact_id
      JOIN managed_artifacts a ON a.id=c.artifact_id
      WHERE r.id=? AND i.id=? AND i.host_variant=? AND i.detected_version=?
        AND i.family='antigravity' AND i.desired_state='managed' AND i.tombstoned_at IS NULL AND i.health_state='discovered'
        AND consent.status='active' AND r.consent_envelope_id=consent.id
        AND component.consent_envelope_id=consent.id AND c.consent_envelope_id=consent.id
        AND c.tombstoned_at IS NULL AND c.state IN ('active','disabled')
        AND component.desired_state IN ('managed','disabled') AND c.desired_state IN ('managed','disabled')
        AND r.operation_type!='disconnect' AND r.state IN ('applied_unverified','verified','committed')
        AND r.adapter_version=? AND r.projection_version=?
        AND json_extract(r.prepared_plan_json,'$.activityGenerationToken')=?
        AND a.owned_fragment_hash=a.observed_fragment_hash
        AND a.state IN ('healthy','paused','needs_recovery')
        AND EXISTS (SELECT 1 FROM projection_mutations p JOIN reconcile_runs carrier ON carrier.id=p.run_id
          WHERE p.id=(SELECT last.id FROM projection_mutations last WHERE last.artifact_id=a.id
            AND last.state='committed' AND last.idempotency_strategy!='consumer_detach_only'
            ORDER BY last.committed_at DESC,last.rowid DESC LIMIT 1)
          AND json_extract(carrier.prepared_plan_json,'$.activityGenerationToken')=?)
    `).get(query.componentKey,query.activationRunId,query.installationId,query.hostVariant,query.hostVersion,
      query.adapterVersion,query.projectionVersion,query.activityGenerationToken,query.activityGenerationToken)
    if (!current) return []
    const rule = query.signalNames.includes('brain_prepare') ? currentAntigravityRule(db,query.agentId) : null
    return query.signalNames.flatMap(signal => {
      const event = db.prepare(`SELECT id,payload_json,created_at FROM agent_integration_events
        WHERE kind='shared_agent_activity' AND dedupe_key=?`).get(sharedAgentActivityKey(
          shared.bindingId,shared.generation,query.componentKey,signal,query.activityGenerationToken)) as
          {id:string;payload_json:string;created_at:string}|undefined
      if (!event) return []
      try {
        const payload = JSON.parse(event.payload_json)
        if (payload.tide_mind_version !== query.tideMindVersion) return []
        const observedAt = typeof payload.lastObservedAt === 'string' ? payload.lastObservedAt : event.created_at
        if (signal==='brain_prepare' && (!rule || payload.instruction_hash!==rule.hash
          || payload.instruction_artifact_id!==rule.artifactId || Date.parse(observedAt)<Date.parse(rule.appliedAt))) return []
        return [{id:event.id,signalName:signal,observedAt,evidenceHash:sha256Json([
          shared.bindingId,shared.generation,query.activityGenerationToken,current,signal,payload,
        ])}]
      } catch { return [] }
    })
  
}
