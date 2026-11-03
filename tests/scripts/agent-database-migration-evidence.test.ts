import { describe, expect, it } from 'vitest'
// @ts-expect-error acceptance script
import { validateDatabaseMigrationEvidence, assertSharedMigrationBatches } from '../../scripts/agent-database-migration-evidence.mjs'
import { databaseMigrationFixture } from '../fixtures/agent-integration/database-migration-fixture.js'
const expected = { captureCreatedAt: '2026-10-23T00:00:00.000Z', observedAt: '2026-10-23T00:10:00.000Z' }

function fixture(version = 35) {
  const data = databaseMigrationFixture(expected.captureCreatedAt, expected.observedAt, version)
  const validate = () => {
    data.receipt.beforeEvidenceSha256 = data.add(data.before)
    data.receipt.backupEvidenceSha256 = data.receipt.beforeEvidenceSha256
    data.receipt.afterEvidenceSha256 = data.add(data.after)
    return validateDatabaseMigrationEvidence(data.receipt, expected, data.files)
  }
  return { ...data, validate }
}
describe('upgrade database raw observations', () => {
  it('reuses one batch across targets but rejects conflicting source app versions', () => {
    const databaseMigration = fixture().receipt
    expect(() => assertSharedMigrationBatches([
      { fromAppVersion: '0.2.93', databaseMigration }, { fromAppVersion: '0.2.93', databaseMigration },
    ])).not.toThrow()
    expect(() => assertSharedMigrationBatches([
      { fromAppVersion: '0.2.93', databaseMigration }, { fromAppVersion: '0.2.92', databaseMigration },
    ])).toThrow(/conflicting source version/)
  })
  it.each([33, 34, 35, 41])('accepts schema %i with actual lineage and preserved history', version => {
    expect(fixture(version).validate()).toMatchObject({ sourceSchemaVersion: version, targetSchemaVersion: 45 })
  })
  it.each([
    ['unknown-source', 'unsupported source schema'],
    ['wrong-lineage', 'target metadata mismatch'],
    ['wrong-schema', 'source metadata mismatch'],
    ['lost-history', 'historical rows were lost'],
    ['wrong-columns', 'comparison columns changed'],
    ['missing-backup', 'paired database backup missing'],
    ['config-mismatch', 'paired configuration backup mismatch'],
    ['other-profile', 'different profiles'],
  ])('rejects migration defect: %s', (defect, error) => {
    const data = fixture()
    if (defect === 'unknown-source') data.receipt.sourceSchemaVersion = 40
    if (defect === 'wrong-lineage') data.after.schema.schema_lineage = 'unknown'
    if (defect === 'wrong-schema') data.before.schema.schema_version = '34'
    if (defect === 'lost-history') { data.after.tables.nodes.rowHashes = []; data.after.tables.nodes.rowCount = 0 }
    if (defect === 'wrong-columns') data.after.tables.nodes.columns = ['other']
    if (defect === 'missing-backup') data.before.backup.databaseSha256 = ''
    if (defect === 'config-mismatch') data.before.backup.configurationSha256 = 'a'.repeat(64)
    if (defect === 'other-profile') data.after.workspace = '/another-profile'
    expect(data.validate).toThrow(error)
  })
  it.each(['marker', 'structure', 'empty-history'])('rejects incomplete schema41 recovery: %s', defect => {
    const data = fixture(41)
    if (defect === 'marker') delete data.after.schema.schema_recovered_from
    if (defect === 'structure') data.before.schemaObjects[0].sql = 'CREATE TABLE unknown(id)'
    if (defect === 'empty-history') data.before.tables.nodes.rowCount = 0
    expect(data.validate).toThrow(/recovery marker|structure differs|historical business rows/)
  })
  it('allows new rows while preserving every prior row and an absent config snapshot', () => {
    const data = fixture()
    data.after.tables.nodes.rowHashes.push('f'.repeat(64)); data.after.tables.nodes.rowCount++
    data.before.configurationSha256 = null as never
    data.before.backup.configurationPresent = false
    data.before.backup.configurationSha256 = null as never
    expect(data.validate()).toBeTruthy()
  })
})


describe('deferred upgrade identity uses real database relationships', () => {
  function deferred(managed = false) {
    const data = databaseMigrationFixture(expected.captureCreatedAt, expected.observedAt)
    const identity = {deferredTargetId:'cursor-desktop', originalAgentId:'eb_actual', migratedAgentId:'eb_actual', installationId:managed ? 'installation_actual' : null}
    for (const observation of [data.before,data.after]) {
      ;(observation.tables.agents as any).identities = managed ? [] : [{id:'eb_actual'}]
      if (managed) (observation.tables as any).agent_installations = {present:true,identities:[{id:'installation_actual',agentId:'eb_actual',hostVariant:'cursor-desktop',desiredState:'managed'}]}
    }
    const validate = () => {
      data.receipt.beforeEvidenceSha256=data.add(data.before)
      data.receipt.backupEvidenceSha256=data.receipt.beforeEvidenceSha256
      data.receipt.afterEvidenceSha256=data.add(data.after)
      return validateDatabaseMigrationEvidence(data.receipt,{...expected,...identity},data.files)
    }
    return {data,identity,validate}
  }
  it.each([false,true])('accepts preserved actual identity; managed=%s', managed => {expect(()=>deferred(managed).validate()).not.toThrow()})
  it.each(['missing-before','missing-after','fake-installation','hidden-installation','wrong-variant','changed-agent','lost-history'])('rejects %s', defect => {
    const {data,identity,validate}=deferred(true)
    if(defect==='missing-before')(data.before.tables as any).agent_installations.identities=[]
    if(defect==='missing-after')(data.after.tables as any).agent_installations.identities=[]
    if(defect==='fake-installation')identity.installationId='made-up'
    if(defect==='hidden-installation')identity.installationId=null
    if(defect==='wrong-variant')(data.before.tables as any).agent_installations.identities[0].hostVariant='codex-cli'
    if(defect==='changed-agent')identity.migratedAgentId='other'
    if(defect==='lost-history')data.after.tables.nodes.rowHashes=[]
    expect(validate).toThrow()
  })
  it('binds the selected nonstandard Installation to its own prior host variant', () => {
    const {data,identity,validate}=deferred(true)
    identity.deferredTargetId='nonstandard_config_root'
    ;(data.after.tables as any).agent_installations.identities.push({
      id:'installation_other',agentId:'eb_actual',hostVariant:'codex-cli',desiredState:'managed',
    })
    identity.installationId='installation_other'
    expect(validate).toThrow(/nonstandard migration changed the actual host variant/)
    identity.installationId='installation_actual'
    expect(validate).not.toThrow()
  })
  it('does not fabricate an Installation for a legacy Agent-only profile',()=>{
    const f=deferred(false);f.identity.installationId='made-up';expect(f.validate).toThrow(/cannot invent/)
  })
})
