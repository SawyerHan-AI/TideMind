import crypto from 'node:crypto'
import fs from 'node:fs'
import { assertCodexUpgradeIdentity } from './codex-upgrade-baseline.mjs'

const SHA256 = /^[a-f0-9]{64}$/u
const CORE_HISTORY_TABLES = ['agents', 'nodes', 'node_versions', 'operation_log', 'links', 'llm_usage_log']
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
function need(ok, message) { if (!ok) throw new Error(`database migration evidence: ${message}`) }
function jsonEvidence(key, files) { need(SHA256.test(key ?? '') && files.has(key), 'raw observation missing'); return JSON.parse(files.get(key).toString('utf8')) }
function timestamp(value) { const n = typeof value === 'number' ? value : Date.parse(value); need(Number.isFinite(n), 'invalid observation time'); return n }
function retainRows(before, after, table) {
  const old = before.tables?.[table], current = after.tables?.[table]
  if (!old?.present) return
  need(current?.present && JSON.stringify(old.columns) === JSON.stringify(current.columns), `${table} comparison columns changed`)
  need(Array.isArray(old.rowHashes) && Array.isArray(current.rowHashes)
    && old.rowCount === old.rowHashes.length && current.rowCount === current.rowHashes.length, `${table} row observations missing`)
  const counts = new Map()
  for (const value of current.rowHashes) { need(SHA256.test(value), `${table} row hash invalid`); counts.set(value, (counts.get(value) ?? 0) + 1) }
  for (const value of old.rowHashes) {
    need(SHA256.test(value) && counts.get(value) > 0, `${table} historical rows were lost or changed`)
    counts.set(value, counts.get(value) - 1)
  }
}
function inspectObserved41Objects(objects) {
  // Reuse the production migration's frozen observed structure contract.
  const source = fs.readFileSync(new URL('../src/db/schema41-contract.ts', import.meta.url), 'utf8')
  const contract = JSON.parse(source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1))
  need(Array.isArray(objects), 'schema41 observed structure missing')
  const actual = new Map(objects.filter(item => !item.name.startsWith('sqlite_')).map(item => [item.name, item]))
  for (const [name, expected] of Object.entries(contract)) {
    const item = actual.get(name)
    if (!item && expected.optional) continue
    need(item && item.type === expected.type && item.tbl_name === expected.table
      && hash(item.sql.replace(/\bIF NOT EXISTS\b/gi, '').replace(/\s+/g, ' ').trim()) === expected.sha256,
    `schema41 structure differs at ${name}`)
  }
  for (const name of actual.keys()) need(contract[name], `unknown schema41 object ${name}`)
}

/** Existing stopped-profile observations, not a second migration implementation. */
export function validateDatabaseMigrationEvidence(value, expected, files) {
  need(value && value.schemaVersion === 1, 'missing migration receipt')
  const keys = ['schemaVersion', 'batchId', 'evidenceOrigin', 'sourceSchemaVersion', 'sourceLineage',
    'targetSchemaVersion', 'targetLineage', 'path', 'beforeEvidenceSha256', 'afterEvidenceSha256', 'backupEvidenceSha256']
  need(Object.keys(value).length === keys.length && keys.every(key => key in value), 'receipt fields mismatch')
  need(typeof value.batchId === 'string' && value.batchId.trim(), 'batch identity missing')
  need(['isolated_history_fixture', 'user_database'].includes(value.evidenceOrigin), 'evidence origin missing')
  need(Number.isInteger(value.sourceSchemaVersion)
    && ((value.sourceSchemaVersion >= 0 && value.sourceSchemaVersion <= 35) || value.sourceSchemaVersion === 41), 'unsupported source schema')
  need(value.sourceLineage === null || typeof value.sourceLineage === 'string', 'source lineage invalid')
  need(value.targetSchemaVersion === 45 && value.targetLineage === 'stable-0.2.94', 'target schema/lineage mismatch')
  need(value.path === (value.sourceSchemaVersion === 41 ? 'observed_schema41_recovery' : 'stable_upgrade'), 'migration path does not match actual schema')
  const before = jsonEvidence(value.beforeEvidenceSha256, files), after = jsonEvidence(value.afterEvidenceSha256, files)
  const backup = jsonEvidence(value.backupEvidenceSha256, files)
  for (const observation of [before, after, backup]) {
    need(observation.kind === 'upgrade_raw_observation' && observation.integrity === 'ok', 'missing valid stopped-profile observation')
    need(observation.workspace === before.workspace, 'observations belong to different profiles')
  }
  need(before.phase === 'before' && after.phase === 'after', 'before/after phases mismatch')
  need(timestamp(before.observedAt) >= timestamp(expected.captureCreatedAt)
    && timestamp(after.observedAt) >= timestamp(before.observedAt)
    && timestamp(after.observedAt) <= timestamp(expected.observedAt), 'observations outside acceptance window')
  need(Number(before.schema.schema_version) === value.sourceSchemaVersion
    && (before.schema.schema_lineage ?? null) === value.sourceLineage, 'source metadata mismatch')
  need(Number(after.schema.schema_version) === 45 && after.schema.schema_lineage === value.targetLineage, 'target metadata mismatch')
  if (value.sourceSchemaVersion === 41) {
    inspectObserved41Objects(before.schemaObjects)
    need(after.schema.schema_recovered_from === 'observed-dormant-41', 'schema41 recovery marker missing')
    // The approved recovery experiment includes synthetic history, not only DDL.
    need(before.tables?.nodes?.rowCount > 0 && before.tables?.agents?.rowCount > 0, 'schema41 recovery needs historical business rows')
  }
  need(backup.phase === 'before' && backup.schema.schema_version === before.schema.schema_version
    && JSON.stringify(backup.tables) === JSON.stringify(before.tables), 'backup observation does not match the source')
  need(SHA256.test(backup.backup?.databaseSha256 ?? ''), 'paired database backup missing')
  need(backup.backup.configurationPresent === (before.configurationSha256 !== null)
    && backup.backup.configurationSha256 === before.configurationSha256, 'paired configuration backup mismatch')
  if (before.configurationSha256 !== null) need(SHA256.test(before.configurationSha256), 'configuration hash invalid')
  need(before.tables?.agents?.present && before.tables?.nodes?.present && before.tables?.operation_log?.present, 'core history observation missing')
  for (const table of CORE_HISTORY_TABLES) retainRows(before, after, table)
  if (expected.codexDatabaseUpgrade === true) {
    need(expected.originalAgentId === expected.migratedAgentId, 'Codex Agent identity changed')
    need((before.tables.llm_usage_log?.rowCount ?? 0) > 0, 'Codex upgrade statistics were not exercised')
    need(JSON.stringify(backup.codexConfiguration) === JSON.stringify(before.codexConfiguration), 'backup host configuration observation mismatch')
    const scope = assertCodexUpgradeIdentity(before, after, expected.originalAgentId, expected.installationId)
    if (scope === 'configured_host') need(expected.installationId !== null, 'configured host upgrade requires its actual Installation')
  }
  if (expected.deferredTargetId !== undefined) {
    const variant = expected.deferredTargetId === 'manual_mcp_client' ? 'custom-local-mcp'
      : expected.deferredTargetId === 'nonstandard_config_root' ? null : expected.deferredTargetId
    need(typeof expected.originalAgentId === 'string' && expected.originalAgentId.length > 0
      && expected.originalAgentId === expected.migratedAgentId, 'deferred migration must preserve its real Agent ID')
    const rowsFor = observation => (observation.tables?.agent_installations?.identities ?? [])
      .filter(row => row.agentId === expected.originalAgentId)
    for (const observation of [before, after]) {
      const rows = rowsFor(observation)
      if (rows.length) need(rows.some(row => typeof row.hostVariant === 'string' && row.hostVariant.length > 0 && (variant === null || row.hostVariant === variant)), 'deferred migration Agent belongs to another host variant')
      else need(observation.tables?.agents?.identities?.some(row => row.id === expected.originalAgentId),
        'deferred migration Agent identity missing from observed database')
    }
    const installed = rowsFor(after).filter(row => variant === null || row.hostVariant === variant)
    if (variant === null && rowsFor(before).length) need(installed.some(row => row.id === expected.installationId
      && rowsFor(before).some(old => old.hostVariant === row.hostVariant)),
      'deferred nonstandard migration changed the actual host variant')
    if (installed.length) need(typeof expected.installationId === 'string'
      && installed.some(row => row.id === expected.installationId), 'deferred migration Installation identity mismatch')
    else need(expected.installationId === null, 'deferred migration cannot invent a managed Installation')
  }
  return value
}

/** One actual App-upgrade batch may serve several host targets, not two source app versions. */
export function assertSharedMigrationBatches(upgrades) {
  const batches = new Map()
  for (const upgrade of upgrades) {
    const value = JSON.stringify([upgrade.fromAppVersion, upgrade.databaseMigration])
    const id = upgrade.databaseMigration?.batchId
    if (batches.has(id)) need(batches.get(id) === value, 'one batch has conflicting source version or observations')
    else batches.set(id, value)
  }
}
