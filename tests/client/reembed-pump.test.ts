/**
 * 补 embed pump 扫描逻辑测试(M4,解 current-state #2 召回缺口)。
 *
 * findMissingVectorNodes 选出"跨设备 pull 来但缺本地向量"的节点。实际补 embed
 * (insertSegmentVectors → getEmbedding)依赖 embedding 凭证,靠真机/集成验证;这里
 * 只测扫描选择逻辑(纯 SQL,无网络)。
 */

import { describe, expect, it } from 'vitest'
import { setupTestDb, seedNode } from '../helpers/test-db.js'
import { findMissingVectorNodes } from '../../client/electron/cloud/reembed-pump.js'

describe('findMissingVectorNodes', () => {
  it('返回 active 且有 content 但缺向量的节点', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'needs embed' })
    const rows = findMissingVectorNodes(db, 10)
    expect(rows.map((r) => r.id)).toContain(node.id)
    expect(rows.find((r) => r.id === node.id)?.content).toBe('needs embed')
  })

  it('complete mappings with actual vectors are not selected', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'has embed' })
    db.exec('CREATE TABLE IF NOT EXISTS nodes_vec (id TEXT PRIMARY KEY, embedding BLOB)')
    db.prepare('INSERT INTO nodes_vec(id,embedding) VALUES (?,?)').run(`${node.id}#0`,Buffer.from([1,2,3,4]))
    db.prepare('INSERT INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)')
      .run(`${node.id}#0`, node.id, 0)
    const rows = findMissingVectorNodes(db, 10)
    expect(rows.map((r) => r.id)).not.toContain(node.id)
  })

  it('archived 节点不返回(归档本就无向量,不该补)', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'archived' })
    db.prepare('UPDATE nodes SET archived = 1 WHERE id = ?').run(node.id)
    const rows = findMissingVectorNodes(db, 10)
    expect(rows.map((r) => r.id)).not.toContain(node.id)
  })

  it('is_superseded 节点不返回', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'superseded' })
    db.prepare('UPDATE nodes SET is_superseded = 1 WHERE id = ?').run(node.id)
    const rows = findMissingVectorNodes(db, 10)
    expect(rows.map((r) => r.id)).not.toContain(node.id)
  })

  it('content 为空的节点不返回', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'x' })
    db.prepare("UPDATE nodes SET content = '' WHERE id = ?").run(node.id)
    const rows = findMissingVectorNodes(db, 10)
    expect(rows.map((r) => r.id)).not.toContain(node.id)
  })

  it('limit 生效', () => {
    const db = setupTestDb()
    for (let i = 0; i < 5; i++) seedNode(db, { content: `n${i}` })
    expect(findMissingVectorNodes(db, 3).length).toBe(3)
  })
})

it('indexes title-only nodes and excludes whitespace-only nodes', () => {
  const db = setupTestDb()
  const title = seedNode(db, { content: '\n\t ', title: 'A useful crystal' })
  const empty = seedNode(db, { content: '\u3000\u00a0', title: '\u3000\u00a0' })
  const body = seedNode(db, { content: 'Body wins', title: 'Title' })
  const rows = findMissingVectorNodes(db, 10)
  expect(rows.find(r => r.id === title.id)?.content).toBe('A useful crystal')
  expect(rows.some(r => r.id === empty.id)).toBe(false)
  expect(rows.find(r => r.id === body.id)?.content).toBe('Body wins')
  expect(db.prepare('SELECT content FROM nodes WHERE id = ?').get(title.id)).toEqual({ content: '\n\t ' })
})

it('repairs existing partial segments and mappings with no vector payload', () => {
 const db=setupTestDb();
 db.exec('CREATE TABLE IF NOT EXISTS nodes_vec(id TEXT PRIMARY KEY,embedding BLOB)');
 const partial=seedNode(db,{content:'Long memory. '.repeat(200)});
 const dangling=seedNode(db,{content:'missing payload'});
 for(const node of [partial,dangling])db.prepare('INSERT INTO node_segments(segment_id,node_id,segment_index) VALUES (?,?,0)').run(node.id+'#0',node.id);
 db.prepare('INSERT INTO nodes_vec(id,embedding) VALUES (?,?)').run(partial.id+'#0',Buffer.from([1,2,3,4]));
 const selected=findMissingVectorNodes(db,10).map(row=>row.id);
 expect(selected).toContain(partial.id);expect(selected).toContain(dangling.id);
 db.close();
});

it('selects historical empty-input leftovers for cleanup without a model request',()=>{
 const db=setupTestDb();const node=seedNode(db,{content:'old'});
 db.prepare('INSERT INTO node_segments(segment_id,node_id,segment_index) VALUES (?,?,0)').run(node.id+'#0',node.id);
 db.prepare("UPDATE nodes SET content='',title=NULL WHERE id=?").run(node.id);
 expect(findMissingVectorNodes(db,10)).toContainEqual({id:node.id,content:'',cleanupOnly:true});
 db.close();
});
