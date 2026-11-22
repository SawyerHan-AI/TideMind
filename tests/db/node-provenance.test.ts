import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ensureSchema } from '../../src/db/schema'
import { createNode, listNodes } from '../../src/db/nodes'
import { provenanceNodeIds, recordNodeProvenance } from '../../src/db/node-provenance'

describe('node provenance', () => {
  it('filters by the recorded origin while keeping note sources and legacy self-reported names', () => {
    const db = new Database(':memory:'); ensureSchema(db)
    db.prepare("INSERT INTO agents(id,name,tool_type,created) VALUES ('eb_a','Desktop','codex','2026-01-01')").run()
    const typo = createNode(db, { content: '星海科技 决策', source_tool: 'Codex Desktop' })
    const note = createNode(db, { content: 'DataPilot 笔记', source_tool: 'logseq' })
    const legacy = createNode(db, { content: '旧记录', source_tool: 'codex' })
    recordNodeProvenance(db, typo.id, 'eb_a')
    recordNodeProvenance(db, typo.id, 'eb_a')
    recordNodeProvenance(db, note.id, undefined)
    recordNodeProvenance(db, legacy.id, 'eb_unknown')

    expect(provenanceNodeIds(db, ['codex'])).toEqual(new Set([typo.id]))
    // The product is called Devin; its stored family id is still the historical one.
    db.prepare("INSERT INTO agents(id,name,tool_type,created) VALUES ('eb_d','Desktop','windsurf','2026-01-01')").run()
    const devin = createNode(db, { content: 'DataPilot 发布记录', source_tool: 'whatever' })
    recordNodeProvenance(db, devin.id, 'eb_d')
    expect(listNodes(db, { fromAgents: ['devin'] }).map(n => n.id)).toEqual([devin.id])
    db.prepare('DELETE FROM nodes WHERE id=?').run(devin.id)
    expect(listNodes(db, { fromAgents: ['codex'] }).map(n => n.id).sort()).toEqual([typo.id, legacy.id].sort())
    expect(listNodes(db, { fromAgents: ['logseq'] }).map(n => n.id)).toEqual([note.id])

    db.prepare('DELETE FROM nodes WHERE id=?').run(typo.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM node_provenance').get()).toEqual({ n: 0 })
    db.close()
  })
})
