import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureAgentIntegrationSchema,
  inspectAgentHostActivityEvidenceV34Schema,
} from '../../src/db/agent-integration-schema.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function v34Database() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-export-schema-'))
  roots.push(root)
  const db = new Database(path.join(root, 'brain.sqlite'))
  ensureAgentIntegrationSchema(db)
  db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('schema_version','34')").run()
  return db
}

describe('activity ledger acceptance exporter schema', () => {
  it('accepts the real schema produced by the v34 authority', () => {
    const db = v34Database()
    expect(inspectAgentHostActivityEvidenceV34Schema(db)).toMatchObject({ schemaVersion: 34 })
    db.close()
  })

  it('rejects a same-named synthetic table with weakened constraints', () => {
    const db = v34Database()
    db.exec(`
      DROP TABLE agent_host_activity_evidence;
      CREATE TABLE agent_host_activity_evidence (
        id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        host_variant TEXT NOT NULL, component_key TEXT NOT NULL, signal_name TEXT NOT NULL,
        tide_mind_version TEXT NOT NULL, adapter_version TEXT NOT NULL,
        projection_version TEXT NOT NULL, host_version TEXT NOT NULL,
        evidence_hash TEXT NOT NULL, observed_at TEXT NOT NULL
      );
    `)
    expect(() => inspectAgentHostActivityEvidenceV34Schema(db)).toThrow(/columns|foreign key|uniqueness|CHECK/)
    db.close()
  })
})
