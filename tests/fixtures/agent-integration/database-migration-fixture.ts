import fs from 'node:fs'
import { closureHash } from './memory-closure-fixture.js'

/** Shape of observe-upgrade-profile.py, with synthetic history only. */
export function databaseMigrationFixture(captureCreatedAt: string, observedAt: string, sourceVersion = 35) {
  const start = Date.parse(captureCreatedAt), duration = Date.parse(observedAt) - start
  const at = (fraction: number) => new Date(start + Math.floor(duration * fraction)).toISOString()
  const tables = Object.fromEntries(['agents', 'nodes', 'node_versions', 'operation_log', 'links', 'llm_usage_log'].map(name => [
    name, { present: true, columns: ['id'], rowCount: 1, rowsSha256: closureHash(name), rowHashes: [closureHash(name + '-row')] },
  ]))
  const structure = sourceVersion === 41 ? JSON.parse(fs.readFileSync(
    new URL('../db/v41-observed-structure.json', import.meta.url), 'utf8',
  )).objects.map((item: { type: string; name: string; table: string; sql: string }) => ({
    type: item.type, name: item.name, tbl_name: item.table, sql: item.sql,
  })) : null
  const before = {
    kind: 'upgrade_raw_observation', status: 'not_an_acceptance_assertion',
    phase: 'before', workspace: '/isolated-synthetic-history', observedAt: at(.2),
    schema: { schema_version: String(sourceVersion) }, schemaObjects: structure,
    integrity: 'ok', configurationSha256: closureHash('synthetic-config'), tables,
    backup: { path: '/isolated-synthetic-backup', databaseSha256: closureHash('synthetic-database'),
      configurationPresent: true, configurationSha256: closureHash('synthetic-config') },
  }
  const after = { ...structuredClone(before), phase: 'after', observedAt: at(.8), backup: null,
    schema: { schema_version: '45', schema_lineage: 'stable-0.2.94',
      ...(sourceVersion === 41 ? { schema_recovered_from: 'observed-dormant-41' } : {}) },
  }
  const files = new Map<string, Buffer>()
  const add = (value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)); const hash = closureHash(bytes); files.set(hash, bytes); return hash }
  const beforeHash = add(before)
  const receipt = { schemaVersion: 1, batchId: 'synthetic-upgrade-' + sourceVersion,
    evidenceOrigin: 'isolated_history_fixture', sourceSchemaVersion: sourceVersion, sourceLineage: null,
    targetSchemaVersion: 45, targetLineage: 'stable-0.2.94',
    path: sourceVersion === 41 ? 'observed_schema41_recovery' : 'stable_upgrade',
    beforeEvidenceSha256: beforeHash, afterEvidenceSha256: add(after), backupEvidenceSha256: beforeHash }
  return { before, after, files, receipt, add }
}
