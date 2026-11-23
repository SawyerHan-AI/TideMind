/** Creating this local table grants no access. Only active, currently valid
 * equivalent proofs can participate in the new bridge admission path.
 */
export const CODEX_MCP_SEMANTIC_PROOF_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_mcp_semantic_member_proofs (
  binding_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  component_key TEXT NOT NULL CHECK(component_key = 'memory_tools'),
  installation_id TEXT NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  binding_generation INTEGER NOT NULL CHECK(binding_generation > 0),
  mutation_id TEXT NOT NULL REFERENCES projection_mutations(id) ON DELETE CASCADE,
  journal_version INTEGER NOT NULL CHECK(journal_version >= 4),
  anchor_fingerprint TEXT NOT NULL CHECK(length(anchor_fingerprint) = 64 AND anchor_fingerprint NOT GLOB '*[^0-9a-f]*'),
  proof_version INTEGER NOT NULL CHECK(proof_version = 1),
  evidence_phase TEXT NOT NULL CHECK(evidence_phase IN ('collected','active')),
  layout_kind TEXT NOT NULL CHECK(layout_kind IN ('exact','equivalent')),
  collection_epoch TEXT NOT NULL CHECK(length(collection_epoch) > 0),
  observed_fragment_hash TEXT NOT NULL CHECK(length(observed_fragment_hash) = 64 AND observed_fragment_hash NOT GLOB '*[^0-9a-f]*'),
  semantic_hash TEXT NOT NULL CHECK(length(semantic_hash) = 64 AND semantic_hash NOT GLOB '*[^0-9a-f]*'),
  container_hash TEXT NOT NULL CHECK(length(container_hash) = 64 AND container_hash NOT GLOB '*[^0-9a-f]*'),
  file_identity TEXT NOT NULL CHECK(length(file_identity) > 0),
  consent_id TEXT NOT NULL REFERENCES agent_consents(id) ON DELETE CASCADE,
  intent_revision INTEGER NOT NULL CHECK(intent_revision >= 0),
  surface_fingerprint TEXT NOT NULL CHECK(length(surface_fingerprint) = 64 AND surface_fingerprint NOT GLOB '*[^0-9a-f]*'),
  source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  observed_at TEXT NOT NULL,
  CHECK(evidence_phase != 'active' OR layout_kind = 'equivalent'),
  PRIMARY KEY(binding_id,artifact_id,component_key,installation_id),
  FOREIGN KEY(binding_id,artifact_id,component_key)
    REFERENCES codex_bridge_anchors(binding_id,artifact_id,component_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_codex_mcp_semantic_member_proofs_installation
  ON codex_mcp_semantic_member_proofs(installation_id);
`;
