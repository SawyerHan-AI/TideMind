/**
 * Skill 文件同步：把 data/skill/*.md 同步到运行时 ~/.tidemind/skill/*.md。
 *
 * ## 两种同步模式
 *
 * 1. **Hash-based 模式（推荐，传入 hashStore 时启用）**：
 *    记录"上次推送到运行时的源文件 hash"，下次同步时：
 *      - source hash 不变 → 跳过
 *      - source hash 变了 + target 仍等于上次推送的 hash → 用户没改过，安全覆盖
 *      - source hash 变了 + target 也变了 → 用户自定义过，保留（记为 userModified）
 *    这和 src/config.ts 里 strategies 的 syncStrategyParams 用的是同一张 sync_hashes 表，
 *    通过 key 前缀 `skill/` 做命名空间隔离。
 *
 * 2. **Fallback 模式（无 hashStore）**：
 *    只做"旧品牌遗留"字串检测。运行时文件里含 External Brain / ExternaBrain
 *    就从源覆盖，其他情况保留。仅用于测试或临时兜底。
 *
 * ## 为什么还保留 legacy marker 检测？
 *
 * 即使开了 hash 模式，第一次运行时（sync_hashes 无历史记录）仍需要"初始化"。
 * 对于用户在 rebrand 之前就已有的运行时 skill 文件，它们含有 "External Brain"
 * 字串 —— 这是明确的"不是用户自己写的，是系统老版本留下的"信号，应该被覆盖。
 * 其他情况下（不含老品牌字串）则保守地把当前 source hash 作为基线写入 DB，
 * 假装"上次已推送"，避免下次把用户可能的自定义覆盖掉。
 *
 * ## 为什么把 SyncHashStore 抽成接口？
 *
 * 这样 syncSkillFiles 本身零运行时依赖（只用 node:fs / node:path / node:crypto），
 * 单元测试里用 Map 实现 store 就能完整覆盖所有分支。真实的 SQLite 包装放在
 * createSyncHashStoreFromDb() 里，单独做集成测试。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 运行时 skill 文件中若出现以下任一子串，视为旧品牌遗留，需要从源覆盖。 */
export const LEGACY_BRAND_MARKERS = ['External Brain', 'ExternaBrain'] as const;

/**
 * 抽象的 sync hash 存储。Hash-based 模式下由调用方提供。
 * 键为 skill 文件名（不含目录前缀），实现方自行决定是否加命名空间前缀。
 */
export interface SyncHashStore {
  /** 读取 file 上次推送的源 hash，没有记录时返回 null。 */
  get(fileName: string): string | null;
  /** 记录 file 的源 hash（通常是 SHA-256）。 */
  set(fileName: string, hash: string): void;
}

export interface SyncSkillOptions {
  /** 可选：hash 存储。不传则退化为 legacy marker 模式。 */
  hashStore?: SyncHashStore;
}

export interface SyncSkillResult {
  /** 运行时原本没有的文件，从源复制 */
  copied: string[];
  /** 检测到需要更新并从源覆盖的文件（legacy marker 触发 或 hash 变化且用户未改） */
  refreshed: string[];
  /** 保持不变的文件（源未变，或用户未改过且暂时不需要同步） */
  preserved: string[];
  /** hash 模式下：源变了但运行时文件也和上次推送的 hash 不一致，判断为用户修改过，保留 */
  userModified: string[];
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function hasLegacyBrandMarker(content: string): boolean {
  return LEGACY_BRAND_MARKERS.some((marker) => content.includes(marker));
}

/**
 * 同步 skill 文件。返回一个 summary，调用方可以用于日志或测试断言。
 *
 * - 如果 sourceSkillDir 不存在：直接返回空 result（视为 no-op）
 * - 如果 targetSkillDir 不存在：自动 mkdir -p
 * - 源目录里只处理 `.md` 文件，非 markdown 和子目录都忽略
 */
export function syncSkillFiles(
  sourceSkillDir: string,
  targetSkillDir: string,
  options: SyncSkillOptions = {},
): SyncSkillResult {
  const result: SyncSkillResult = {
    copied: [],
    refreshed: [],
    preserved: [],
    userModified: [],
  };

  if (!fs.existsSync(sourceSkillDir)) {
    return result;
  }

  fs.mkdirSync(targetSkillDir, { recursive: true });

  const { hashStore } = options;
  const files = fs
    .readdirSync(sourceSkillDir)
    .filter((f) => f.endsWith('.md'));

  for (const file of files) {
    const sourcePath = path.join(sourceSkillDir, file);
    const targetPath = path.join(targetSkillDir, file);

    let sourceContent: string;
    try {
      sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    } catch {
      // 源文件读失败（被删了？）跳过
      continue;
    }
    const sourceHash = hashContent(sourceContent);

    // ── Case 1: 运行时缺文件 → 从源复制 ──
    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(sourcePath, targetPath);
      hashStore?.set(file, sourceHash);
      result.copied.push(file);
      continue;
    }

    // ── Case 2: 运行时文件已存在 ──
    let targetContent: string;
    try {
      targetContent = fs.readFileSync(targetPath, 'utf-8');
    } catch {
      // 读不动就保留
      result.preserved.push(file);
      continue;
    }

    const isLegacy = hasLegacyBrandMarker(targetContent);

    // ── Case 2a: 没有 hashStore → 只做 legacy marker 检测（fallback 模式） ──
    if (!hashStore) {
      if (isLegacy) {
        fs.copyFileSync(sourcePath, targetPath);
        result.refreshed.push(file);
      } else {
        result.preserved.push(file);
      }
      continue;
    }

    // ── Case 2b: 有 hashStore → 进入 hash-based 同步 ──
    const lastPushedHash = hashStore.get(file);

    if (lastPushedHash === null) {
      // 首次启用 hash 模式，没有历史记录
      if (isLegacy) {
        // Rebrand 遗留：强制覆盖
        fs.copyFileSync(sourcePath, targetPath);
        hashStore.set(file, sourceHash);
        result.refreshed.push(file);
      } else {
        // 保守策略：把当前 source hash 作为基线写入 DB，不动 target。
        // 这样即使当前 target ≠ source，下次比较时源没变就不会重复尝试。
        // 下次源变了，再看 target 是否等于此 baseline 决定是否覆盖。
        hashStore.set(file, sourceHash);
        result.preserved.push(file);
      }
      continue;
    }

    // 已有历史记录
    if (sourceHash === lastPushedHash) {
      // 源未变 → 无论 target 现在是什么样都不动
      result.preserved.push(file);
      continue;
    }

    // 源变了。根据 target 是否等于"上次推送" 判断用户是否修改过
    const targetHash = hashContent(targetContent);
    if (targetHash === lastPushedHash) {
      // 用户没改过 target（仍等于上次推送）→ 安全覆盖
      fs.copyFileSync(sourcePath, targetPath);
      hashStore.set(file, sourceHash);
      result.refreshed.push(file);
    } else {
      // 用户改过了 target。但若仍带 legacy marker，视为不完整清理，强制覆盖
      if (isLegacy) {
        fs.copyFileSync(sourcePath, targetPath);
        hashStore.set(file, sourceHash);
        result.refreshed.push(file);
      } else {
        // 用户真的自定义过，保留并标记
        result.userModified.push(file);
      }
    }
  }

  return result;
}

/**
 * 把 better-sqlite3 Database 包成 SyncHashStore。
 *
 * 使用 sync_hashes 表（和 strategies 共用），通过 key 前缀 `skill/` 做命名空间隔离。
 * 表不存在时自动创建。
 *
 * 这里用结构类型声明 db 参数而不是直接 import better-sqlite3，
 * 避免把核心 syncSkillFiles 文件与原生模块耦合。实际 db 对象需要具备
 * prepare()/exec() 方法（better-sqlite3 的标准接口）。
 *
 * 注意：参数类型刻意用 `any[]`/`any`，因为 better-sqlite3 的 Statement 类型用了
 * `Statement<[{}], unknown>` 这种变型较严格的签名，无法和 `unknown[]` 结构兼容。
 * 这里是 adapter 层，类型宽松一点换来下游调用方无需 cast 是合理取舍。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface MinimalDbStatement {
  get: (...params: any[]) => any;
  run: (...params: any[]) => any;
}
export interface MinimalDb {
  prepare: (sql: string) => MinimalDbStatement;
  exec: (sql: string) => void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function createSyncHashStoreFromDb(
  db: MinimalDb,
  keyPrefix = 'skill/',
): SyncHashStore {
  db.exec(
    'CREATE TABLE IF NOT EXISTS sync_hashes (file_name TEXT PRIMARY KEY, source_hash TEXT NOT NULL, synced_at TEXT NOT NULL)',
  );
  const getStmt = db.prepare('SELECT source_hash FROM sync_hashes WHERE file_name = ?');
  const setStmt = db.prepare(
    "INSERT OR REPLACE INTO sync_hashes (file_name, source_hash, synced_at) VALUES (?, ?, datetime('now'))",
  );
  return {
    get(fileName: string): string | null {
      const row = getStmt.get(keyPrefix + fileName) as
        | { source_hash: string }
        | undefined;
      return row?.source_hash ?? null;
    },
    set(fileName: string, hash: string): void {
      setStmt.run(keyPrefix + fileName, hash);
    },
  };
}
