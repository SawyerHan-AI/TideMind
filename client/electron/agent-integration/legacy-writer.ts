import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY,
  AGENT_INTEGRATION_WRITER_PROTOCOL,
} from '@server/db/agent-integration-schema.js'

/**
 * 旧 self-heal 能理解的最低 writer protocol。这个常量只能在 bridge
 * 真正实现了新协议后提升，不能为了绕过数据库门禁而修改。
 */
export const LEGACY_WRITER_PROTOCOL_VERSION = AGENT_INTEGRATION_WRITER_PROTOCOL
export const LEGACY_WRITER_MODE_KEY = 'agent_integration_legacy_writer_mode'
export const LEGACY_WRITER_ADAPTER_MODE_PREFIX = 'agent_integration_legacy_writer_mode:'

export type LegacyWriterMode = 'write' | 'observe-only'

export interface LegacyMutationScope {
  /** 现有 Adapter registry 使用的 legacy ID，用于按 Adapter 切换。 */
  adapterId: string
  /** 物理文件 target；建域时会尽可能 realpath。 */
  target: string
  /** 旧 writer 会重写整个文档，因此当前固定使用 document selector。 */
  selector: 'document'
}

export type LegacyWriterBlockReason =
  | 'observe_only'
  | 'adapter_observe_only'
  | 'protocol_too_old'
  | 'protocol_invalid'
  | 'scope_owned'
  | 'fence_unavailable'

export type LegacyWriterDecision =
  | { allowed: true; reason: 'legacy_schema' }
  | { allowed: true; reason: 'unmanaged_scope' | 'released_scope'; domain: string }
  | { allowed: false; reason: LegacyWriterBlockReason; domain?: string }

export interface LegacyWriterGuard {
  canWrite(scope: LegacyMutationScope): LegacyWriterDecision
}

export interface LegacyWriterGuardOptions {
  mode?: LegacyWriterMode
  observeOnlyAdapters?: readonly string[]
  writerProtocol?: number
}

interface WriterFenceRow {
  scope_mode?: 'legacy' | 'managed'
  minimum_writer_protocol: number
  owner_instance_id: string | null
  lease_expires_at: number | null
  state: string
}

export function canonicalMutationTarget(target: string): string {
  const absolute = path.resolve(target)
  const suffix = [path.basename(absolute)]
  let ancestor = path.dirname(absolute)
  while (ancestor !== path.dirname(ancestor)) {
    try {
      // Canonicalize the nearest existing ancestor but never dereference the
      // leaf. Missing parents stay as a frozen lexical suffix; adapters must
      // reject any later symlink inserted into that suffix before applying.
      return path.join(fs.realpathSync.native(ancestor), ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      suffix.unshift(path.basename(ancestor))
      ancestor = path.dirname(ancestor)
    }
  }
  return path.join(fs.realpathSync.native(ancestor), ...suffix)
}

/**
 * 新 Reconciler 在接管 legacy target 时也必须使用这个 domain 构造器，
 * 否则两边键不一致会让 fence 形同虚设。
 */
export function buildLegacyMutationDomain(scope: LegacyMutationScope): string {
  // v34 Repository 以 local_macos 作为当前用户 runtime realm；DB 本身已是
  // per-user，不再把 uid 混入键。新 writer 接管存量 self-heal 时应把
  // ownership_key 设为 document，与旧 writer 重写整文档的事实一致。
  return `local_macos:file:${canonicalMutationTarget(scope.target)}:${scope.selector}`
}

function tableExists(db: Database.Database, table: string): boolean {
  try {
    return Boolean(db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    ).get(table))
  } catch {
    // 旧测试替身或尚未初始化的 DB 没有 prepare，等价于 bridge 前 schema。
    return false
  }
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some(row => row.name === column)
  } catch {
    return false
  }
}

function readMetadataValue(db: Database.Database, key: string): string | null | 'invalid' {
  if (!tableExists(db, 'metadata')) return null
  try {
    const row = db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return 'invalid'
  }
}

function readGlobalMinimumProtocol(db: Database.Database): number | null | 'invalid' {
  const raw = readMetadataValue(db, AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY)
  if (raw === null || raw === 'invalid') return raw
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 'invalid'
  return parsed
}

/**
 * 给现有同步 self-heal 提供最小安全桥。
 *
 * - v34 之前的 DB 没有 fence 表，默认保留旧行为；此时也不存在新 writer。
 * - 一旦 v34 宣告了更高的最低协议，旧 writer 必须全局只观察。
 * - 已被新 writer 用 active fence 接管的物理 domain，旧 writer 只报告不落盘；
 *   即使 lease 已过期，也要等恢复流程显式 release。
 *
 * 这个 bridge 不尝试抢占 fence。新 writer 切换时先持有 active fence，
 * 而旧 writer 在每个原子写之前重读，使未迁移 scope 保持兼容。
 */
export function createLegacyWriterGuard(
  db?: Database.Database,
  options: LegacyWriterGuardOptions = {},
): LegacyWriterGuard {
  const mode = options.mode ?? 'write'
  const observeOnlyAdapters = new Set(options.observeOnlyAdapters ?? [])
  const writerProtocol = options.writerProtocol ?? LEGACY_WRITER_PROTOCOL_VERSION

  return {
    canWrite(scope): LegacyWriterDecision {
      if (mode === 'observe-only') return { allowed: false, reason: 'observe_only' }
      if (observeOnlyAdapters.has(scope.adapterId)) {
        return { allowed: false, reason: 'adapter_observe_only' }
      }
      if (!db) {
        return { allowed: true, reason: 'legacy_schema' }
      }

      const domain = buildLegacyMutationDomain(scope)
      const persistedMode = readMetadataValue(db, LEGACY_WRITER_MODE_KEY)
      if (persistedMode === 'observe-only') {
        return { allowed: false, reason: 'observe_only', domain }
      }
      if (persistedMode === 'invalid' || (persistedMode !== null && persistedMode !== 'write')) {
        return { allowed: false, reason: 'protocol_invalid', domain }
      }
      const adapterMode = readMetadataValue(
        db,
        `${LEGACY_WRITER_ADAPTER_MODE_PREFIX}${scope.adapterId}`,
      )
      if (adapterMode === 'observe-only') {
        return { allowed: false, reason: 'adapter_observe_only', domain }
      }
      if (adapterMode === 'invalid' || (adapterMode !== null && adapterMode !== 'write')) {
        return { allowed: false, reason: 'protocol_invalid', domain }
      }
      const globalMinimum = readGlobalMinimumProtocol(db)
      if (globalMinimum === 'invalid') {
        return { allowed: false, reason: 'protocol_invalid', domain }
      }
      const hasFenceTable = tableExists(db, 'writer_fences')
      if (hasFenceTable && globalMinimum === null) {
        // fence 表存在表示已进入 bridge schema，最低协议 key 缺失不能
        // 猜测为 1，否则损坏/手工降级时会绕过门禁。
        return { allowed: false, reason: 'protocol_invalid', domain }
      }
      if (globalMinimum !== null && writerProtocol < globalMinimum) {
        return { allowed: false, reason: 'protocol_too_old', domain }
      }
      if (!hasFenceTable) {
        // 旧 schema 没有全局 key，可继续兼容；v34 已声明 protocol 却丢失
        // fence 表是不完整/损坏状态，必须失效关闭。
        return globalMinimum === null
          ? { allowed: true, reason: 'legacy_schema' }
          : { allowed: false, reason: 'fence_unavailable', domain }
      }

      let fence: WriterFenceRow | undefined
      try {
        const hasScopeMode = columnExists(db, 'writer_fences', 'scope_mode')
        fence = db.prepare(hasScopeMode ? `
            SELECT scope_mode, minimum_writer_protocol, owner_instance_id, lease_expires_at, state
            FROM writer_fences WHERE mutation_domain = ?
          ` : `
            SELECT minimum_writer_protocol, owner_instance_id, lease_expires_at, state
            FROM writer_fences WHERE mutation_domain = ?
          `).get(domain) as WriterFenceRow | undefined
      } catch {
        return { allowed: false, reason: 'fence_unavailable', domain }
      }

      if (!fence) return { allowed: true, reason: 'unmanaged_scope', domain }
      if (fence.scope_mode === 'managed') {
        return { allowed: false, reason: 'scope_owned', domain }
      }
      if (writerProtocol < fence.minimum_writer_protocol) {
        return { allowed: false, reason: 'protocol_too_old', domain }
      }
      // 租约过期只表示 owner 不再被证明存活，不表示崩溃 mutation 已恢复或
      // scope 已安全交还。legacy writer 不会 claim/epoch 恢复，因此任何 active row
      // 都必须失效关闭，只能由新协调器恢复后显式 release。
      if (fence.state === 'active') {
        return { allowed: false, reason: 'scope_owned', domain }
      }
      if (fence.state !== 'released') {
        return { allowed: false, reason: 'fence_unavailable', domain }
      }
      return { allowed: true, reason: 'released_scope', domain }
    },
  }
}
