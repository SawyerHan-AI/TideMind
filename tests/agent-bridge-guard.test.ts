import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureSchema } from '../src/db/schema.js'
import { evaluateBridgeAdmission } from '../src/agent-bridge-guard.js'
import { seedLifecycle } from './fixtures/seed-managed-lifecycle'

function installation(db: Database.Database, agentId: string, fields: Record<string, string | null> = {}): void {
  seedLifecycle(db, agentId, 'codex', 'codex-cli')
  for (const [column, value] of Object.entries(fields)) {
    db.prepare(`UPDATE agent_installations SET ${column} = ? WHERE agent_id = ?`).run(value, agentId)
  }
}

const eligibility = (reason: string) => JSON.stringify({
  managementEligibility: { schemaVersion: 1, eligible: false, reason, proofLimitBytes: 1 },
})

describe('Tide Mind bridge generation guard (design §3.5)', () => {
  it('stops only generation-bound entries of removed, stopped or rejected managed Installations', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    installation(db, 'eb_managed')
    installation(db, 'eb_paused', { desired_state: 'disabled' })
    installation(db, 'eb_removed', { desired_state: 'removed', tombstoned_at: '2026-09-25T00:01:00.000Z' })
    installation(db, 'eb_tombstoned', { tombstoned_at: '2026-09-25T00:01:00.000Z' })
    installation(db, 'eb_bridge_stopped', { bridge_state: 'stopped', bridge_state_reason: 'disconnect_pending_manual_removal' })
    installation(db, 'eb_rejected', { metadata_json: eligibility('source_not_official') })
    installation(db, 'eb_pending_source', { metadata_json: eligibility('source_verification_pending') })
    installation(db, 'eb_legacy_callable', {
      desired_state: 'unmanaged', status_reason: 'legacy_callable_unmanaged', metadata_json: eligibility('source_not_official'),
    })
    const admit = (agentId: string | null, token: string | null = `generation_${agentId}`) =>
      evaluateBridgeAdmission(db, { agentId, activityGenerationToken: token, componentKey: 'lifecycle' })

    expect(admit('eb_managed')).toEqual({ allowed: true })
    // Pausing maintenance is not deactivation: the bridge keeps serving.
    expect(admit('eb_paused')).toEqual({ allowed: true })
    // Not yet definitive: verification pending does not stop an existing bridge.
    expect(admit('eb_pending_source')).toEqual({ allowed: true })
    expect(admit('eb_removed')).toEqual({ allowed: false, reason: 'installation_removed' })
    expect(admit('eb_tombstoned')).toEqual({ allowed: false, reason: 'installation_tombstoned' })
    expect(admit('eb_bridge_stopped')).toEqual({ allowed: false, reason: 'bridge_stopped' })
    expect(admit('eb_rejected')).toEqual({ allowed: false, reason: 'source_rejected' })

    // Legacy paths keep working unchanged.
    expect(admit('eb_legacy_callable')).toEqual({ allowed: true })
    expect(admit('eb_unknown_legacy_agent')).toEqual({ allowed: true })
    expect(admit(null)).toEqual({ allowed: true })
    // An entry without a generation token is an older script: it is not claimed protected.
    expect(admit('eb_removed', null)).toEqual({ allowed: true })
    db.close()
  })

  it('rejects a replaced token while preserving another consumer and the paused current generation', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    installation(db, 'eb_first')
    installation(db, 'eb_second')
    const admit = (agentId: string, token: string) => evaluateBridgeAdmission(db, {
      agentId, activityGenerationToken: token, componentKey: 'lifecycle',
    })
    expect(admit('eb_first', 'generation_eb_first')).toEqual({ allowed: true })
    expect(admit('eb_first', 'stale')).toEqual({ allowed: false, reason: 'activity_generation_mismatch' })
    db.prepare(`UPDATE reconcile_runs SET prepared_plan_json = (
      SELECT prepared_plan_json FROM reconcile_runs WHERE installation_id = 'installation_eb_second'
    ) WHERE installation_id = 'installation_eb_first'`).run()
    expect(admit('eb_first', 'generation_eb_first')).toEqual({ allowed: false, reason: 'activity_generation_mismatch' })
    expect(admit('eb_second', 'generation_eb_second')).toEqual({ allowed: true })
    db.prepare("UPDATE agent_installations SET desired_state = 'disabled' WHERE agent_id = 'eb_second'").run()
    expect(admit('eb_second', 'generation_eb_second')).toEqual({ allowed: true })
    expect(evaluateBridgeAdmission(db, { agentId: 'eb_first', activityGenerationToken: null })).toEqual({ allowed: true })
    db.close()
  })

  it('does not revive pre-disconnect carriers while reconnect is waiting to apply', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    installation(db, 'eb_reconnect')
    const admit = (token: string) => evaluateBridgeAdmission(db, {
      agentId: 'eb_reconnect', activityGenerationToken: token, componentKey: 'lifecycle',
    })
    const cloneRun = (id: string, operation: string, state: string) => db.prepare(`
      INSERT INTO reconcile_runs (id, installation_id, operation_type, execution_plan_hash,
        state, recovery_strategy, adapter_version, catalog_version, projection_version,
        selector_schema_version, prepared_plan_json, desired_capability, created_at, updated_at)
      SELECT ?, installation_id, ?, execution_plan_hash, ?, recovery_strategy,
        adapter_version, catalog_version, projection_version, selector_schema_version,
        prepared_plan_json, desired_capability, created_at, updated_at
      FROM reconcile_runs WHERE id = 'run_eb_reconnect'
    `).run(id, operation, state)
    expect(admit('generation_eb_reconnect')).toEqual({ allowed: true })
    cloneRun('disconnect_run', 'disconnect', 'committed')
    // prepare reopens desired_state/bridge before the reconnect has applied.
    cloneRun('reconnect_run', 'connect', 'planned')
    expect(admit('generation_eb_reconnect')).toEqual({ allowed: false, reason: 'activity_generation_mismatch' })
    db.prepare("UPDATE reconcile_runs SET state = 'applied_unverified', prepared_plan_json = ? WHERE id = 'reconnect_run'").run(JSON.stringify({
      componentKeys: ['lifecycle'], activityGenerationToken: 'new-generation',
      executionPlan: { activityGenerationTokenHash: createHash('sha256').update(JSON.stringify('new-generation')).digest('hex') },
    }))
    expect(admit('generation_eb_reconnect')).toEqual({ allowed: false, reason: 'activity_generation_mismatch' })
    expect(admit('new-generation')).toEqual({ allowed: true })
    db.close()
  })

  it('refuses bound entry admission when the ledger is malformed or cannot be read', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE agent_installations (agent_id TEXT)')
    const input = { agentId: 'eb_bound', activityGenerationToken: 'generation' }
    expect(evaluateBridgeAdmission(db, input)).toEqual({ allowed: false, reason: 'guard_unavailable' })
    db.close()
    expect(evaluateBridgeAdmission(db, input)).toEqual({ allowed: false, reason: 'guard_unavailable' })
    expect(evaluateBridgeAdmission(db, { ...input, activityGenerationToken: null })).toEqual({ allowed: true })
  })

  it('treats a database without the managed-integration ledger as unbound', () => {
    const db = new Database(':memory:')
    expect(evaluateBridgeAdmission(db, { agentId: 'eb_any', activityGenerationToken: 'generation' }))
      .toEqual({ allowed: true })
    db.close()
  })
})

describe('bridge guard in the real SessionStart hook process', { timeout: 60_000 }, () => {
  let isolatedHome: string
  let databasePath: string
  let skillPath: string

  beforeAll(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-guard-hook-'))
    const dataDir = path.join(isolatedHome, '.tidemind')
    const graphDir = path.join(dataDir, 'graph')
    fs.mkdirSync(graphDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config.toml'), `[general]\ndata_dir = ${JSON.stringify(dataDir)}\n`)
    skillPath = path.join(isolatedHome, 'SKILL.md')
    fs.writeFileSync(skillPath, '---\nname: tidemind\n---\nBRIDGE_GUARD_SKILL_MARKER\n')
    databasePath = path.join(graphDir, 'brain.sqlite')
    const db = new Database(databasePath)
    ensureSchema(db)
    seedLifecycle(db, 'eb_hook_removed', 'codex', 'codex-cli')
    db.prepare(`UPDATE agent_installations SET desired_state = 'removed', tombstoned_at = ?, bridge_state = 'stopped'
      WHERE agent_id = ?`).run(new Date().toISOString(), 'eb_hook_removed')
    db.close()
  })

  afterAll(() => fs.rmSync(isolatedHome, { recursive: true, force: true }))

  async function runSessionStart(agentId: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const child = spawn(
      path.resolve('node_modules/.bin/tsx'),
      [path.resolve('src/hook-session-start.ts'), '--agent-id', agentId, '--skill-path', skillPath,
        '--tool', 'claude-code', '--activity-generation-token', `generation_${agentId}`],
      { cwd: path.resolve('.'), env: { ...process.env, HOME: isolatedHome }, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.stdin.end('{}')
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code }
  }

  it('injects nothing for a removed Installation and records no evidence', async () => {
    const result = await runSessionStart('eb_hook_removed')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('bridge refused memory for this Agent — installation_removed')
    const db = new Database(databasePath, { readonly: true })
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence WHERE agent_id = ?`)
        .get('eb_hook_removed')).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('keeps serving an unmanaged legacy Agent', async () => {
    const result = await runSessionStart('eb_hook_legacy_unknown')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('BRIDGE_GUARD_SKILL_MARKER')
    expect(result.stderr).not.toContain('bridge refused memory')
  })
})
