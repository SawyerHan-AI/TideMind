import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LEGACY_WRITER_PROTOCOL_VERSION,
  LEGACY_WRITER_ADAPTER_MODE_PREFIX,
  LEGACY_WRITER_MODE_KEY,
  buildLegacyMutationDomain,
  createLegacyWriterGuard,
  type LegacyMutationScope,
} from '../../client/electron/agent-integration/legacy-writer'

describe('legacy writer minimum protocol bridge', () => {
  let db: Database.Database
  let tmpRoot: string
  let target: string
  let scope: LegacyMutationScope

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE writer_fences (
        mutation_domain TEXT PRIMARY KEY,
        minimum_writer_protocol INTEGER NOT NULL DEFAULT 1,
        writer_generation INTEGER NOT NULL DEFAULT 0,
        owner_instance_id TEXT,
        epoch INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER,
        state TEXT NOT NULL DEFAULT 'released',
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO metadata (key, value)
      VALUES ('agent_integration_minimum_writer_protocol', '1');
    `)
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-writer-'))
    target = path.join(tmpRoot, 'mcp.json')
    fs.writeFileSync(target, '{}')
    scope = {
      adapterId: 'cursor',
      target,
      selector: 'document',
    }
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('没有 v34 表时保持未迁移 scope 兼容', () => {
    const legacyDb = new Database(':memory:')
    const decision = createLegacyWriterGuard(legacyDb).canWrite(scope)
    legacyDb.close()
    expect(decision).toEqual({ allowed: true, reason: 'legacy_schema' })
  })

  it('显式 observe-only 时所有 scope 拒绝写入', () => {
    const decision = createLegacyWriterGuard(db, { mode: 'observe-only' }).canWrite(scope)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('observe_only')
  })

  it('持久化全局 observe-only 开关不需改调用入口即生效', () => {
    db.prepare(`INSERT INTO metadata (key, value) VALUES (?, 'observe-only')`).run(
      LEGACY_WRITER_MODE_KEY,
    )

    const decision = createLegacyWriterGuard(db).canWrite(scope)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('observe_only')
  })

  it('持久化 per-Adapter 开关只冻结指定 legacy Adapter', () => {
    db.prepare(`INSERT INTO metadata (key, value) VALUES (?, 'observe-only')`).run(
      `${LEGACY_WRITER_ADAPTER_MODE_PREFIX}cursor`,
    )

    expect(createLegacyWriterGuard(db).canWrite(scope).reason).toBe('adapter_observe_only')
    expect(createLegacyWriterGuard(db).canWrite({
      ...scope,
      adapterId: 'windsurf',
    }).allowed).toBe(true)
  })

  it('全局 minimum writer protocol 高于当前 bridge 时 fail closed', () => {
    db.prepare(`UPDATE metadata SET value = ? WHERE key = ?`).run(
      String(LEGACY_WRITER_PROTOCOL_VERSION + 1),
      'agent_integration_minimum_writer_protocol',
    )

    const decision = createLegacyWriterGuard(db).canWrite(scope)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('protocol_too_old')
  })

  it('v34 已声明 protocol 但 fence 表缺失时 fail closed', () => {
    const partialDb = new Database(':memory:')
    partialDb.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    partialDb.prepare(`INSERT INTO metadata (key, value) VALUES (?, '1')`).run(
      'agent_integration_minimum_writer_protocol',
    )

    const decision = createLegacyWriterGuard(partialDb).canWrite(scope)

    partialDb.close()
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('fence_unavailable')
  })

  it('活跃 fence 持有对应物理 scope 时旧 writer 被阻止', () => {
    const domain = buildLegacyMutationDomain(scope)
    db.prepare(`
      INSERT INTO writer_fences (
        mutation_domain, minimum_writer_protocol, writer_generation,
        owner_instance_id, epoch, lease_expires_at, state, created_at, updated_at
      ) VALUES (?, 1, 2, 'managed-reconciler', 3, ?, 'active', ?, ?)
    `).run(domain, Date.now() + 60_000, new Date().toISOString(), new Date().toISOString())

    const decision = createLegacyWriterGuard(db).canWrite(scope)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('scope_owned')
    expect(decision.domain).toBe(domain)
  })

  it('其他 scope 的 fence 不影响未迁移 target', () => {
    const otherDomain = buildLegacyMutationDomain({
      adapterId: 'windsurf',
      target: path.join(tmpRoot, 'other.json'),
      selector: 'document',
    })
    db.prepare(`
      INSERT INTO writer_fences (
        mutation_domain, minimum_writer_protocol, writer_generation,
        owner_instance_id, epoch, lease_expires_at, state, created_at, updated_at
      ) VALUES (?, 1, 2, 'managed-reconciler', 3, ?, 'active', ?, ?)
    `).run(otherDomain, Date.now() + 60_000, new Date().toISOString(), new Date().toISOString())

    expect(createLegacyWriterGuard(db).canWrite(scope)).toEqual({
      allowed: true,
      reason: 'unmanaged_scope',
      domain: buildLegacyMutationDomain(scope),
    })
  })

  it('过期 active fence 仍 fail closed，只有显式 released 才交还 scope', () => {
    const domain = buildLegacyMutationDomain(scope)
    db.prepare(`
      INSERT INTO writer_fences (
        mutation_domain, minimum_writer_protocol, writer_generation,
        owner_instance_id, epoch, lease_expires_at, state, created_at, updated_at
      ) VALUES (?, 1, 2, 'old-owner', 3, ?, 'active', ?, ?)
    `).run(domain, Date.now() - 1, new Date().toISOString(), new Date().toISOString())

    expect(createLegacyWriterGuard(db).canWrite(scope)).toEqual({
      allowed: false,
      reason: 'scope_owned',
      domain,
    })

    db.prepare(`UPDATE writer_fences SET state = 'released', lease_expires_at = ? WHERE mutation_domain = ?`)
      .run(Date.now() + 60_000, domain)
    expect(createLegacyWriterGuard(db).canWrite(scope).allowed).toBe(true)
  })

  it('leaf symlink 删除前后保持同一个 canonical ownership domain', () => {
    const realTarget = path.join(tmpRoot, 'real.json')
    const symlinkTarget = path.join(tmpRoot, 'linked.json')
    fs.writeFileSync(realTarget, '{}')
    fs.symlinkSync(realTarget, symlinkTarget)
    const before = buildLegacyMutationDomain({ adapterId: 'cursor', target: symlinkTarget, selector: 'document' })
    fs.unlinkSync(symlinkTarget)
    const after = buildLegacyMutationDomain({ adapterId: 'cursor', target: symlinkTarget, selector: 'document' })
    expect(after).toBe(before)
  })

  it('missing parent creation through a symlink keeps one canonical ownership domain', () => {
    const realRoot = path.join(tmpRoot, 'real-root')
    const aliasRoot = path.join(tmpRoot, 'alias-root')
    fs.mkdirSync(realRoot)
    fs.symlinkSync(realRoot, aliasRoot)
    const missingTarget = path.join(aliasRoot, 'nested', 'mcp.json')

    const before = buildLegacyMutationDomain({ adapterId: 'cursor', target: missingTarget, selector: 'document' })
    fs.mkdirSync(path.join(realRoot, 'nested'))
    const after = buildLegacyMutationDomain({ adapterId: 'cursor', target: missingTarget, selector: 'document' })

    expect(after).toBe(before)
    expect(before).toContain(path.join(realRoot, 'nested', 'mcp.json'))
  })

  it('新 writer 显式接管后即使 operation lease 已释放，legacy scope 仍长期只读', () => {
    db.exec("ALTER TABLE writer_fences ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'legacy'")
    const domain = buildLegacyMutationDomain(scope)
    db.prepare(`
      INSERT INTO writer_fences (
        mutation_domain, scope_mode, minimum_writer_protocol, writer_generation,
        epoch, state, created_at, updated_at
      ) VALUES (?, 'managed', 1, 1, 1, 'released', ?, ?)
    `).run(domain, T0(), T0())
    expect(createLegacyWriterGuard(db).canWrite(scope)).toEqual({
      allowed: false,
      reason: 'scope_owned',
      domain,
    })
  })
})

function T0(): string {
  return '2026-08-25T00:00:00.000Z'
}
