import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Ajv2020 from 'ajv/dist/2020.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureSchema } from '../../src/db/schema'
import { recordHostActivityEvidence } from '../../src/db/agent-host-activity'
import { sha256Json } from '../../client/electron/agent-integration/fingerprint'
import { currentUserOwnedCustomActivityProof, exportAgentHostTargetMetadata } from '../../client/electron/agent-integration/host-target-metadata-export'
import { metadataEvidenceRuntimeContext } from '../../client/electron/agent-integration/production-service'
import * as productionService from '../../client/electron/agent-integration/production-service'
import { readStableFileFingerprint } from '../../client/electron/agent-integration/passive-cli-version'
import { AGENT_INTEGRATION_RELEASE_MANIFEST as manifest } from '../../client/electron/agent-integration/release-manifest'
import type { AgentInstallationRow } from '../../client/electron/agent-integration/repository'
import { customMcpConfiguration, type CustomMcpSchema } from '../../client/electron/agent-integration/hosts/custom-mcp-configuration'

// The exporter normally uses the Electron-ABI driver. Node Vitest uses the
// same real SQLite package from the root workspace, without rebuilding either.
vi.mock('../../client/node_modules/better-sqlite3/lib/index.js', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url)('better-sqlite3') }
})

const databases: Database.Database[] = []
const roots: string[] = []
afterEach(() => {
  databases.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const T0 = '2026-09-05T00:00:00.000Z', T1 = '2026-09-05T00:01:00.000Z', T2 = '2026-09-05T00:02:00.000Z'
const runtime = metadataEvidenceRuntimeContext('/fixture/home', '/fixture/Tide Mind.app/Contents/MacOS/Tide Mind')

function fixture(schemaKind: CustomMcpSchema = 'standard_mcp_servers', selectorKey = 'tidemind') {
  const db = new Database(':memory:'); databases.push(db); ensureSchema(db)
  db.prepare("INSERT INTO agents(id,name,tool_type,created) VALUES('eb_custom','Custom','custom',?)").run(T0)
  db.prepare(`INSERT INTO agent_installations(id,family,host_variant,profile_id,install_key,display_name,
    agent_id,detected_version,desired_state,health_state,metadata_json,created_at,updated_at)
    VALUES('custom','custom-local-agent','custom-local-mcp',?,'custom','Custom',
      'eb_custom','custom-123','managed','discovered',?,?,?)`)
    .run(`custom-guided:${schemaKind}:${selectorKey}`, JSON.stringify({ customInstallation: {
      kind: 'manual_mcp_client', configurationOwnership: 'user', schemaKind, selectorKey,
    } }), T0, T0)
  db.prepare(`INSERT INTO agent_consents(id,installation_id,policy_version,allowed_components_json,
    allowed_scopes_json,normalized_targets_json,selector_schema_version,selector_resolution_json,
    executable_realpaths_json,command_categories_json,maximum_risk,status,confirmed_at,created_at)
    VALUES('consent','custom','1','["memory_tools"]','[]','[]','1','{}','[]','[]','low','active',?,?)`).run(T0,T0)
  db.prepare("UPDATE agent_installations SET consent_envelope_id='consent'").run()
  db.prepare(`INSERT INTO installation_components(installation_id,component_key,desired_state,delivery_mode,
    verification_status,visibility_state,consent_envelope_id,created_at,updated_at)
    VALUES('custom','memory_tools','managed','guided','verified','unknown','consent',?,?)`).run(T0,T0)
  const token = 'generation-custom'
  const environment = { EB_AGENT_ID: 'eb_custom', EB_HOST_VARIANT: 'custom-local-mcp', EB_ACTIVITY_GENERATION_TOKEN: token }
  const configuration = JSON.parse(customMcpConfiguration(schemaKind, selectorKey, 'eb_custom', runtime, token))
  const prepared = { componentKeys: ['memory_tools'], activityGenerationToken: token,
    executionPlan: { activityGenerationTokenHash: sha256Json(token) },
    adapterPlan: { requiredUserActionDetails: [{ kind: 'custom_mcp_import', operation: 'connect',
      installationId: 'custom', agentId: 'eb_custom', hostVariant: 'custom-local-mcp', hostVersion: 'custom-123',
      tideMindVersion: runtime.tideMindVersion, adapterVersion: '1', projectionVersion: runtime.projectionVersion,
      command: runtime.shimPath, args: [runtime.mcpServerPath], environment,
      connectorName: selectorKey,
      configurationJson: JSON.stringify(configuration), connectorConfigurationHash: sha256Json(configuration),
    }] } }
  db.prepare(`INSERT INTO reconcile_runs(id,installation_id,operation_type,execution_plan_hash,state,recovery_strategy,
    consent_envelope_id,adapter_version,projection_version,prepared_plan_json,created_at,updated_at)
    VALUES('run-custom','custom','connect','hash','committed','readback_before_replay','consent','1','1',?,?,?)`)
    .run(JSON.stringify(prepared),T0,T0)
  const row = db.prepare("SELECT * FROM agent_installations WHERE id='custom'").get() as AgentInstallationRow
  const record = (signalName: 'brain_recall' | 'brain_digest') => recordHostActivityEvidence(db, {
    agentId: row.agent_id!, hostVariant: row.host_variant, componentKey: 'memory_tools', signalName,
    tideMindVersion: runtime.tideMindVersion, activityGenerationToken: token, observedAt: T1,
  })
  return { db, row, record, prepared, proof: () => currentUserOwnedCustomActivityProof(db, row, runtime, new Date(T2)) }
}

describe('user-owned Custom real-activity acceptance binding', () => {
  it.each(['standard_mcp_servers','nested_mcp_servers','opencode_mcp'] as const)('runs the full %s metadata exporter against a real SQLite fixture', async schemaKind => {
    const data = fixture(schemaKind, 'memory_bank'); data.record('brain_recall'); data.record('brain_digest')
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'custom-guided-export-'))); roots.push(root)
    const executable = path.join(root, 'client'); fs.writeFileSync(executable, 'fixture client', { mode: 0o700 })
    const proof = await readStableFileFingerprint(executable, 1024)
    const metadata = JSON.parse(data.row.metadata_json)
    metadata.customInstallation.executableFingerprint = proof.fingerprint
    metadata.componentConfigFiles = {}
    metadata.distribution = { distributionId: 'custom-fixture', packageProvenance: 'user_selected_local_executable' }
    data.db.prepare('UPDATE agent_installations SET config_root=?, executable_path=?, metadata_json=?')
      .run(root, executable, JSON.stringify(metadata))
    const databasePath = path.join(root, 'brain.sqlite'); await data.db.backup(databasePath)
    // Only the external trust/discovery boundary is stubbed. Export selection,
    // read-only DB, frozen config, activity reader and output all execute normally.
    vi.spyOn(productionService, 'metadataEvidenceRuntimeContext').mockReturnValue(runtime)
    vi.spyOn(productionService, 'createProductionAgentHostMetadataEvidenceRuntime').mockReturnValue({
      scan: async () => { throw new Error('guided export must not scan unrelated hosts') },
      attest: async () => null, attestCustom: async () => sha256Json('trust-fixture'),
      inspectCliVersion: async () => ({ exitCode: 1, stdout: '', stderr: '' }), readExecutable: async () => proof,
      inspect: async () => ({ catalogId: 'custom-local-mcp', detected: true, components: [], provenance: [], diagnostics: [] }),
    })
    const sourceCommit = 'a'.repeat(40); vi.stubGlobal('__TIDEMIND_BUNDLED_SOURCE_COMMIT__', sourceCommit)
    const releaseContractSha256 = crypto.createHash('sha256').update(JSON.stringify({
      version: manifest.appVersion, schemaVersion: manifest.schemaVersion, entries: manifest.entries,
      customEnabled: manifest.features.customLocalAgent.enabledByDefault, customModes: manifest.features.customLocalAgent.modes,
    })).digest('hex')
    const outputPath = path.join(root, 'metadata.json')
    const fixtureArchitecture = process.arch === 'x64' ? 'x64' : 'arm64'
    await exportAgentHostTargetMetadata({ targetKey: `manual_mcp_client:${schemaKind}:memory_bank`,
      candidateBundleSha256: sha256Json('candidate'), sourceCommit, releaseContractSha256, outputPath,
      databasePath, homeDir: root, now: () => new Date(T2),
      customHostFixture: {
        executionEnvironment: {
          processArchitecture: fixtureArchitecture,
          hardwareArchitecture: fixtureArchitecture === 'x64' ? 'x86_64' : 'arm64',
          translationMode: 'not_translated',
        },
        osVersion: '15.0.0',
        hostIdentitySha256: sha256Json('custom-guided-linux-ci-host'),
      },
    })
    const exported = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    expect(exported.evidenceClass).toBe('fixture')
    expect(exported.targetMetadata.customBinding).toMatchObject({
      configurationOwnership: 'user', configFileIdentitySha256: null, readBackProofSha256: null,
      activityBinding: { schemaKind, selectorKey: 'memory_bank', installationId: 'custom', agentId: 'eb_custom' },
    })
  })
  it.each(['standard_mcp_servers','nested_mcp_servers','opencode_mcp'] as const)('exports %s from real recorder/reader evidence without any config file or artifact', schemaKind => {
    const data = fixture(schemaKind, 'memory_bank')
    expect(data.record('brain_recall').status).toBe('recorded')
    expect(data.record('brain_digest').status).toBe('recorded')
    expect(data.proof()).toMatchObject({ installationId: 'custom', agentId: 'eb_custom', activationRunId: 'run-custom',
      generationSha256: sha256Json('generation-custom'), tideMindVersion: runtime.tideMindVersion, schemaKind, selectorKey: 'memory_bank' })
    expect(data.proof().evidence.map(record => record.signalName)).toEqual(['brain_recall','brain_digest'])
    expect(data.db.prepare('SELECT count(*) AS n FROM managed_artifacts').get()).toEqual({ n: 0 })
  })
  it('does not accept a recall-only connector', () => {
    const data = fixture(); data.record('brain_recall')
    expect(data.proof).toThrow('lacks current brain_digest')
  })
  it('keeps the published JSON schema aligned with guided null-file/null-read-back bindings', () => {
    const data = fixture(); data.record('brain_recall'); data.record('brain_digest')
    const schema = JSON.parse(fs.readFileSync(new URL('../../scripts/agent-integration-host-acceptance-v3.schema.json', import.meta.url), 'utf8'))
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile({
      $schema: schema.$schema, $defs: schema.$defs, $ref: '#/$defs/customBinding',
    })
    const binding = {
      kind: 'manual_mcp_client', configurationOwnership: 'user', sourceInstallationId: null, sourceCatalogId: null,
      configRootIdentitySha256: sha256Json('root'), configFileIdentitySha256: null,
      selectorIdentitySha256: sha256Json('selector'), executableFingerprint: sha256Json('executable'),
      sourceLiveTrustProofSha256: null, liveTrustProofSha256: sha256Json('trust'), readBackProofSha256: null,
      activityBinding: data.proof(),
    }
    expect(validate(binding), JSON.stringify(validate.errors)).toBe(true)
    expect(validate({ ...binding, readBackProofSha256: sha256Json('imaginary') })).toBe(false)
    expect(validate({ ...binding, activityBinding: undefined })).toBe(false)
    expect(validate({ ...binding, configurationOwnership: undefined, activityBinding: undefined })).toBe(false)
  })
  it.each(['identity','runtime','generation','revoked','future','tampered','selector','schema','configuration'])('rejects %s drift', kind => {
    const data = fixture(); data.record('brain_recall'); data.record('brain_digest')
    if (kind === 'identity') data.prepared.adapterPlan.requiredUserActionDetails[0].agentId = 'other'
    if (kind === 'runtime') data.prepared.adapterPlan.requiredUserActionDetails[0].command = '/another/runtime'
    if (kind === 'generation') data.prepared.activityGenerationToken = 'new-generation'
    if (kind === 'selector') data.prepared.adapterPlan.requiredUserActionDetails[0].connectorName = 'another_selector'
    if (kind === 'configuration') data.prepared.adapterPlan.requiredUserActionDetails[0].configurationJson = customMcpConfiguration('opencode_mcp','other','eb_custom',runtime,'generation-custom')
    if (kind === 'schema') data.row.profile_id = 'custom-guided:opencode_mcp:tidemind'
    if (['identity','runtime','generation','selector','configuration'].includes(kind)) data.db.prepare('UPDATE reconcile_runs SET prepared_plan_json=?').run(JSON.stringify(data.prepared))
    if (kind === 'revoked') data.db.prepare("UPDATE agent_consents SET status='revoked'").run()
    if (kind === 'future') data.db.prepare("UPDATE agent_host_activity_evidence SET observed_at='2099-01-01T00:00:00.000Z'").run()
    if (kind === 'tampered') data.db.prepare("UPDATE agent_host_activity_evidence SET evidence_hash='not-real'").run()
    expect(data.proof).toThrow()
  })
})
