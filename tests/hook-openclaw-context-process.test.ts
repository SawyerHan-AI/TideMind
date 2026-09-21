import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureSchema } from '../src/db/schema.js'
import { seedLifecycle } from './fixtures/seed-managed-lifecycle'

describe('OpenClaw prepared context versus acknowledged delivery', { timeout: 30_000 }, () => {
  let root: string
  let databasePath: string
  let skillPath: string
  let skillSha: string
  const agentId = 'eb_openclaw_delivery'
  const generation = `generation_${agentId}`
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-delivery-process-'))
    const dataDir = path.join(root, '.tidemind')
    fs.mkdirSync(path.join(dataDir, 'graph'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config.toml'), `[general]\ndata_dir = ${JSON.stringify(dataDir)}\n`)
    databasePath = path.join(dataDir, 'graph', 'brain.sqlite')
    const db = new Database(databasePath)
    ensureSchema(db)
    seedLifecycle(db, agentId, 'openclaw', 'openclaw-local')
    db.close()
    skillPath = path.join(root, 'SKILL.md')
    fs.writeFileSync(skillPath, '---\nname: tidemind\n---\n\nEXACT_OPENCLAW_SKILL\n')
    skillSha = createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex')
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  const run = (file: string, extra: string[] = []) => spawnSync(path.resolve('node_modules/.bin/tsx'), [
    path.resolve('src', file), '--agent-id', agentId, '--tool', 'openclaw', '--activity-generation-token', generation, ...extra,
  ], { cwd: path.resolve('.'), env: { ...process.env, HOME: root }, input: '{}', encoding: 'utf8', timeout: 15_000 })
  const signals = () => {
    const db = new Database(databasePath, { readonly: true })
    try { return db.prepare('SELECT signal_name FROM agent_host_activity_evidence WHERE agent_id = ? ORDER BY signal_name').all(agentId) }
    finally { db.close() }
  }
  it('does not let successful preparation of startup and restored stdout mint evidence', () => {
    const started = run('hook-session-start.ts', ['--skill-path', skillPath, '--expected-skill-sha256', skillSha])
    expect(started.status, started.stderr).toBe(0)
    expect(JSON.parse(started.stdout)).toMatchObject({ protocol: 'tidemind-openclaw-context-v1', evidenceEligible: true, content: expect.stringContaining('EXACT_OPENCLAW_SKILL') })
    const restored = run('hook-post-compact.ts')
    expect(restored.status, restored.stderr).toBe(0)
    expect(JSON.parse(restored.stdout)).toMatchObject({ protocol: 'tidemind-openclaw-context-v1', content: expect.stringContaining('CONTEXT RESTORED') })
    expect(signals()).toEqual([])
    const mismatch = run('hook-session-start.ts', ['--skill-path', skillPath, '--expected-skill-sha256', '0'.repeat(64)])
    expect(JSON.parse(mismatch.stdout).evidenceEligible).toBe(false)
    expect(signals()).toEqual([])
  })
  it('records the current generation only through the native delivery acknowledgement', () => {
    for (const signal of ['session_start', 'post_compact']) {
      const result = run('hook-openclaw-lifecycle.ts', ['--signal', signal])
      expect(result.status, result.stderr).toBe(0)
    }
    expect(signals()).toEqual([{ signal_name: 'post_compact' }, { signal_name: 'session_start' }])
  })
})
