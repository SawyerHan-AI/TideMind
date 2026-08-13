import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { buildMetabolismWorkerRuntimeSnapshotFromInitializedMain } from '../../src/metabolism/worker-runtime-snapshot-source.js'
import { ensureSchema } from '../../src/db/schema.js'
import type { AppConfig } from '../../src/types.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-runtime-source-'))
  roots.push(dataDir)
  const db = new Database(path.join(dataDir, 'brain.sqlite'))
  ensureSchema(db)
  db.prepare('INSERT INTO model_connections (id, name, provider_type, credentials, created) VALUES (?, ?, ?, ?, ?)').run('mc_12345678', 'test', 'anthropic', JSON.stringify({ api_key: 'secret' }), new Date().toISOString())
  const config = {
    general: { data_dir: dataDir }, metabolism: { annotate_interval_minutes: 3 },
    llm: { provider: 'anthropic' }, embedding: { provider: 'vertex', dimensions: 768 },
  } as unknown as AppConfig
  return { dataDir, db, config }
}

describe('main-owned metabolism Worker snapshot source', () => {
  it('captures fixed connection credentials without exposing them in the commitment', () => {
    const { dataDir, db, config } = fixture()
    const snapshot = buildMetabolismWorkerRuntimeSnapshotFromInitializedMain(db, config, dataDir, 1)
    expect(snapshot.connections).toEqual([expect.objectContaining({ id: 'mc_12345678', providerType: 'anthropic' })])
    expect(snapshot.commitment).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.commitment).not.toContain('secret')
    db.close()
  })

  it('rejects malformed durable credentials before creating a generation', () => {
    const { dataDir, db, config } = fixture()
    db.prepare('UPDATE model_connections SET credentials = ?').run('{broken')
    expect(() => buildMetabolismWorkerRuntimeSnapshotFromInitializedMain(db, config, dataDir, 1)).toThrow(/credentials are invalid/)
    db.close()
  })

  it('fails closed when an observed strategy source is not a readable regular file', () => {
    const { dataDir, db, config } = fixture()
    const strategies = path.join(dataDir, 'strategies')
    fs.mkdirSync(strategies)
    fs.mkdirSync(path.join(strategies, 'broken.system.md'))
    expect(() => buildMetabolismWorkerRuntimeSnapshotFromInitializedMain(db, config, dataDir, 1))
      .toThrow(/not a regular file/)
    db.close()
  })

  it('rejects symlinked credential files and strategy directories outside the authorized root', () => {
    const { dataDir, db, config } = fixture()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-runtime-source-outside-'))
    roots.push(outside)
    fs.writeFileSync(path.join(outside, 'credential.json'), '{}')
    fs.symlinkSync(path.join(outside, 'credential.json'), path.join(dataDir, 'vertex-credentials.json'))
    expect(() => buildMetabolismWorkerRuntimeSnapshotFromInitializedMain(db, config, dataDir, 1))
      .toThrow(/single-link regular file/)
    fs.unlinkSync(path.join(dataDir, 'vertex-credentials.json'))
    fs.mkdirSync(path.join(outside, 'strategies'))
    fs.symlinkSync(path.join(outside, 'strategies'), path.join(dataDir, 'strategies'))
    expect(() => buildMetabolismWorkerRuntimeSnapshotFromInitializedMain(db, config, dataDir, 1))
      .toThrow(/canonical directory/)
    db.close()
  })
})
