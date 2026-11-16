/** Schema creation grants nothing. Only the desktop coordinator can publish a live readback. */
export const CODEX_BRIDGE_CONTINUITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_bridge_source_blocks (
  binding_id TEXT NOT NULL REFERENCES agent_identity_bindings(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  component_key TEXT NOT NULL CHECK(component_key IN ('memory_tools','lifecycle')),
  token_hash TEXT NOT NULL,
  last_mutation_rowid INTEGER NOT NULL,
  last_consent_rowid INTEGER NOT NULL,
  PRIMARY KEY(binding_id,installation_id,component_key,token_hash)
);
CREATE TABLE IF NOT EXISTS codex_bridge_invalidations (
  installation_id TEXT PRIMARY KEY REFERENCES agent_installations(id) ON DELETE CASCADE,
  last_run_rowid INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_codex_bridge_physical_writes
  ON projection_mutations(artifact_id,state,committed_at DESC);
CREATE TABLE IF NOT EXISTS codex_bridge_anchors (
  binding_id TEXT NOT NULL REFERENCES agent_identity_bindings(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES managed_artifacts(id) ON DELETE CASCADE,
  component_key TEXT NOT NULL CHECK(component_key IN ('memory_tools','lifecycle')),
  binding_generation INTEGER NOT NULL,
  mutation_id TEXT NOT NULL REFERENCES projection_mutations(id) ON DELETE CASCADE,
  journal_version INTEGER NOT NULL,
  target_path TEXT NOT NULL,
  ownership_key TEXT NOT NULL,
  selector_schema_version TEXT NOT NULL,
  fragment_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  PRIMARY KEY(binding_id,artifact_id,component_key)
);
CREATE TABLE IF NOT EXISTS codex_bridge_member_proofs (
  binding_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  component_key TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  binding_generation INTEGER NOT NULL,
  consent_id TEXT NOT NULL REFERENCES agent_consents(id) ON DELETE CASCADE,
  mutation_id TEXT NOT NULL REFERENCES projection_mutations(id) ON DELETE CASCADE,
  journal_version INTEGER NOT NULL,
  surface_fingerprint TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  intent_revision INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(binding_id,artifact_id,component_key,installation_id),
  FOREIGN KEY(binding_id,artifact_id,component_key)
    REFERENCES codex_bridge_anchors(binding_id,artifact_id,component_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_codex_bridge_member_proofs_installation
  ON codex_bridge_member_proofs(installation_id);
`;
