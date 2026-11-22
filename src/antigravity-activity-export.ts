import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { resolveInstallationAgentIdentity, getSharedAgentConsumers } from './db/agent-identity-binding.js';
import { readAntigravitySharedActivity } from './antigravity-shared-activity.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Export a current domain observation, not a claim that this member emitted it. */
export function readAntigravityStartupExport(db: Database.Database, input: {
  eventId: string; installationId: string; targetKey: string; tideMindVersion: string;
}) {
  const member = db.prepare('SELECT host_variant, detected_version FROM agent_installations WHERE id=?')
    .get(input.installationId) as {host_variant:string;detected_version:string}|undefined;
  if (!member || !['antigravity-app','antigravity-cli'].includes(member.host_variant)
    || !input.targetKey.startsWith(`${member.host_variant}:`) || !['0.2.101', '0.2.102'].includes(input.tideMindVersion)) {
    throw new Error('shared activity export requires an Antigravity 0.2.101 or 0.2.102 target');
  }
  const identity = resolveInstallationAgentIdentity(db, input.installationId);
  const shared = getSharedAgentConsumers(db, identity.canonicalAgentId);
  if (!shared || !shared.consumers.every(row => row.family === 'antigravity')) throw new Error('shared activity domain missing');
  const runs = db.prepare(`SELECT r.id,r.adapter_version,r.projection_version,r.created_at,
      json_extract(r.prepared_plan_json,'$.activityGenerationToken') AS token,
      a.owned_fragment_hash AS artifact_hash
    FROM reconcile_runs r
    JOIN installation_components c ON c.installation_id=r.installation_id AND c.component_key='lifecycle'
    JOIN managed_artifacts a ON a.id=c.artifact_id
    WHERE r.installation_id=? AND r.state IN ('applied_unverified','verified','committed')
      AND r.operation_type!='disconnect'
      AND EXISTS (SELECT 1 FROM json_each(r.prepared_plan_json,'$.componentKeys') WHERE value='lifecycle')
    ORDER BY r.created_at DESC,r.rowid DESC LIMIT 8`).all(input.installationId) as Array<{
      id:string;adapter_version:string;projection_version:string;created_at:string;token:string;artifact_hash:string;
    }>;
  for (const run of runs) {
    if (!run.token) continue;
    const observations = readAntigravitySharedActivity(db, {
      installationId:input.installationId,agentId:identity.canonicalAgentId,hostVariant:member.host_variant,
      hostVersion:member.detected_version,componentKey:'lifecycle',signalNames:['session_start'],
      tideMindVersion:input.tideMindVersion,adapterVersion:run.adapter_version,projectionVersion:run.projection_version,
      activationRunId:run.id,activityGenerationToken:run.token,observedAfter:run.created_at,
    });
    const observation = observations.find(item => item.id === input.eventId);
    if (!observation || Date.parse(observation.observedAt)<Date.parse(run.created_at)
      || Date.parse(observation.observedAt)>Date.now()) continue;
    const row = {
      evidenceScope: 'configuration_domain' as const,
      id:observation.id,requestedInstallationId:input.installationId,
      bindingId:shared.bindingId,bindingGeneration:shared.generation,agentId:identity.canonicalAgentId,
      activationRunId:run.id,activityGenerationSha256:hash(run.token),artifactSha256:run.artifact_hash,
      componentKey:'lifecycle' as const,signalName:'session_start' as const,tideMindVersion:input.tideMindVersion,
      adapterVersion:run.adapter_version,projectionVersion:run.projection_version,
      domainEvidenceHash:observation.evidenceHash,observedAt:observation.observedAt,
    };
    return { ...row, evidenceHash: hash([
      row.evidenceScope,row.id,row.requestedInstallationId,row.bindingId,row.bindingGeneration,row.agentId,
      row.activationRunId,row.activityGenerationSha256,row.artifactSha256,row.componentKey,row.signalName,
      row.tideMindVersion,row.adapterVersion,row.projectionVersion,row.domainEvidenceHash,row.observedAt,
    ]) };
  }
  throw new Error('current shared startup activity not found');
}
