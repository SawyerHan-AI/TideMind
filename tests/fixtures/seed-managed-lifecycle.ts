import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

export function seedLifecycle(
  db: Database.Database,
  agentId: string,
  family: string,
  hostVariant: string,
): void {
  const now = new Date().toISOString()
  const suffix = agentId.replace(/[^a-z0-9]/giu, '_')
  const installationId = `installation_${suffix}`
  const consentId = `consent_${suffix}`
  const artifactId = `artifact_${suffix}`
  const generation = `generation_${suffix}`
  const generationHash = createHash('sha256').update(JSON.stringify(generation)).digest('hex')
  db.prepare(`INSERT INTO agents (id, name, tool_type, archived, created)
    VALUES (?, ?, ?, 0, ?)`).run(agentId, agentId, family, now)
  db.prepare(`INSERT INTO agent_installations (
    id, family, host_variant, runtime_realm, profile_id, install_key, provenance,
    display_name, detected_version, agent_id, desired_state, supported_capability,
    desired_capability, health_state, created_at, updated_at
  ) VALUES (?, ?, ?, 'local_macos', 'default', ?, 'fixture', ?, '1.0.0', ?,
    'managed', 4, 4, 'discovered', ?, ?)`).run(
    installationId, family, hostVariant, `${hostVariant}:${suffix}`, agentId, agentId, now, now,
  )
  db.prepare(`INSERT INTO managed_artifacts (
    id, component_type, target_path, ownership_key, mutation_domain,
    projection_version, selector_schema_version, owned_fragment_hash,
    observed_fragment_hash, state, created_at, updated_at
  ) VALUES (?, 'hook', ?, 'document', ?, '3', '1', 'owned', 'owned', 'healthy', ?, ?)`).run(
    artifactId, `/fixture/${suffix}`, `local_macos:file:/fixture/${suffix}:document`, now, now,
  )
  db.prepare(`INSERT INTO installation_components (
    installation_id, component_key, desired_state, desired_capability, delivery_mode,
    verification_status, artifact_id, visibility_state, created_at, updated_at
  ) VALUES (?, 'lifecycle', 'managed', 4, 'managed', 'unverified', ?, 'dedicated', ?, ?)`).run(
    installationId, artifactId, now, now,
  )
  db.prepare(`INSERT INTO artifact_consumers (
    artifact_id, installation_id, component_key, required_capability, desired_state,
    discover_reachability, state, added_at, updated_at
  ) VALUES (?, ?, 'lifecycle', 4, 'managed', 'dedicated', 'active', ?, ?)`).run(
    artifactId, installationId, now, now,
  )
  db.prepare(`INSERT INTO reconcile_runs (
    id, installation_id, operation_type, execution_plan_hash, state, recovery_strategy,
    adapter_version, catalog_version, projection_version, selector_schema_version,
    prepared_plan_json, desired_capability, created_at, updated_at
  ) VALUES (?, ?, 'connect', ?, 'committed', 'readback_before_replay', '1', '2', '3', '1', ?, 4, ?, ?)`).run(
    `run_${suffix}`, installationId, `plan_${suffix}`, JSON.stringify({
      componentKeys: ['lifecycle'],
      activityGenerationToken: generation,
      executionPlan: { activityGenerationTokenHash: generationHash },
    }), now, now,
  )
  db.prepare(`INSERT INTO agent_consents (
    id, installation_id, policy_version, allowed_components_json,
    allowed_scopes_json, normalized_targets_json, selector_schema_version,
    selector_resolution_json, executable_realpaths_json, command_categories_json,
    maximum_risk, status, confirmed_at, created_at
  ) VALUES (?, ?, '1', '["lifecycle"]', '[]', '[]', '1', '{}', '[]', '[]',
    'low', 'active', ?, ?)`).run(consentId, installationId, now, now)
  db.prepare('UPDATE agent_installations SET consent_envelope_id = ? WHERE id = ?').run(consentId, installationId)
  db.prepare('UPDATE installation_components SET consent_envelope_id = ? WHERE installation_id = ?').run(consentId, installationId)
  db.prepare('UPDATE artifact_consumers SET consent_envelope_id = ? WHERE installation_id = ?').run(consentId, installationId)
  db.prepare('UPDATE reconcile_runs SET consent_envelope_id = ? WHERE installation_id = ?').run(consentId, installationId)
}
