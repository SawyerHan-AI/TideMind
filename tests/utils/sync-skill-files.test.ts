/**
 * syncSkillFiles 单元测试。
 *
 * 分两部分：
 *   1. Fallback 模式（不传 hashStore）：只做 legacy marker 检测
 *   2. Hash-based 模式（传入 Map 实现的 SyncHashStore）：覆盖所有 hash 分支
 *   3. createSyncHashStoreFromDb + better-sqlite3 :memory: 集成测试
 *
 * 测试策略：纯文件系统 + 内存 store，不依赖真实 DB。最后一个 describe 用
 * better-sqlite3 :memory: 验证 DB adapter 的 SQL 层行为。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {
  syncSkillFiles,
  createSyncHashStoreFromDb,
  LEGACY_BRAND_MARKERS,
  type SyncHashStore,
} from '../../src/utils/sync-skill-files.js';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function makeMemoryStore(initial: Record<string, string> = {}): SyncHashStore & {
  snapshot: () => Record<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get(file: string) {
      return map.has(file) ? map.get(file)! : null;
    },
    set(file: string, hash: string) {
      map.set(file, hash);
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}

let tmpRoot: string;
let sourceDir: string;
let targetDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sync-'));
  sourceDir = path.join(tmpRoot, 'data-skill');
  targetDir = path.join(tmpRoot, 'runtime-skill');
  fs.mkdirSync(sourceDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSource(name: string, content: string): void {
  fs.writeFileSync(path.join(sourceDir, name), content);
}
function writeTarget(name: string, content: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, name), content);
}
function readTarget(name: string): string {
  return fs.readFileSync(path.join(targetDir, name), 'utf-8');
}

// ===========================================================================
// Part 1: Fallback 模式（不传 hashStore）
// ===========================================================================
describe('syncSkillFiles — fallback 模式（无 hashStore）', () => {
  describe('首次复制', () => {
    it('运行时目录不存在时自动创建并全量复制', () => {
      writeSource('base-skill.md', '# Tide Mind — 使用指南\n新内容');
      writeSource('claude-code-skill.md', '# Claude Code\n');

      const result = syncSkillFiles(sourceDir, targetDir);

      expect(result.copied.sort()).toEqual(['base-skill.md', 'claude-code-skill.md']);
      expect(result.refreshed).toEqual([]);
      expect(result.preserved).toEqual([]);
      expect(result.userModified).toEqual([]);
      expect(fs.existsSync(targetDir)).toBe(true);
      expect(readTarget('base-skill.md')).toContain('Tide Mind');
    });

    it('运行时目录已存在但为空时全量复制', () => {
      fs.mkdirSync(targetDir);
      writeSource('base-skill.md', 'A');
      writeSource('other.md', 'B');

      const result = syncSkillFiles(sourceDir, targetDir);

      expect(result.copied.sort()).toEqual(['base-skill.md', 'other.md']);
    });
  });

  describe('增量补缺', () => {
    it('运行时已有部分文件时只补缺失的', () => {
      writeSource('base-skill.md', 'source-base');
      writeSource('new-skill.md', 'source-new');
      writeTarget('base-skill.md', '已有的用户自定义内容');

      const result = syncSkillFiles(sourceDir, targetDir);

      expect(result.copied).toEqual(['new-skill.md']);
      expect(result.preserved).toEqual(['base-skill.md']);
      expect(readTarget('base-skill.md')).toBe('已有的用户自定义内容');
      expect(readTarget('new-skill.md')).toBe('source-new');
    });
  });

  describe('旧品牌遗留过渡清理', () => {
    it('含 "External Brain" → 从源覆盖', () => {
      writeSource('claude-code-skill.md', '# Tide Mind — Claude Code 使用指南');
      writeTarget('claude-code-skill.md', '# External Brain — Claude Code 使用指南');

      const result = syncSkillFiles(sourceDir, targetDir);
      expect(result.refreshed).toEqual(['claude-code-skill.md']);
      expect(readTarget('claude-code-skill.md')).not.toContain('External Brain');
    });

    it('含 "ExternaBrain" → 从源覆盖', () => {
      writeSource('base-skill.md', '# Tide Mind');
      writeTarget('base-skill.md', 'ExternaBrain 旧名');

      const result = syncSkillFiles(sourceDir, targetDir);
      expect(result.refreshed).toEqual(['base-skill.md']);
    });
  });

  describe('保留用户自定义', () => {
    it('不含旧品牌 → 保留', () => {
      writeSource('base-skill.md', '源文件');
      writeTarget('base-skill.md', '用户自定义内容');

      const result = syncSkillFiles(sourceDir, targetDir);
      expect(result.preserved).toEqual(['base-skill.md']);
      expect(readTarget('base-skill.md')).toBe('用户自定义内容');
    });
  });

  describe('边界', () => {
    it('sourceSkillDir 不存在 → 空 result', () => {
      const result = syncSkillFiles(path.join(tmpRoot, 'nope'), targetDir);
      expect(result).toEqual({ copied: [], refreshed: [], preserved: [], userModified: [] });
    });

    it('只处理 .md 文件', () => {
      writeSource('base-skill.md', '# md');
      writeSource('readme.txt', '不是 markdown');

      const result = syncSkillFiles(sourceDir, targetDir);
      expect(result.copied).toEqual(['base-skill.md']);
      expect(fs.existsSync(path.join(targetDir, 'readme.txt'))).toBe(false);
    });

    it('不递归子目录', () => {
      writeSource('base-skill.md', 'root');
      fs.mkdirSync(path.join(sourceDir, 'nested'));
      fs.writeFileSync(path.join(sourceDir, 'nested', 'deep.md'), 'nested');

      const result = syncSkillFiles(sourceDir, targetDir);
      expect(result.copied).toEqual(['base-skill.md']);
    });
  });
});

// ===========================================================================
// Part 2: Hash-based 模式（传入 Map 实现的 SyncHashStore）
// ===========================================================================
describe('syncSkillFiles — hash-based 模式', () => {
  describe('首次启用（store 为空）— backfill', () => {
    it('运行时缺文件 → 复制 + 记录 source hash', () => {
      writeSource('base-skill.md', '# Tide Mind');
      const store = makeMemoryStore();

      const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });

      expect(result.copied).toEqual(['base-skill.md']);
      expect(store.snapshot()).toEqual({ 'base-skill.md': sha256('# Tide Mind') });
    });

    it('运行时文件含 legacy marker → 覆盖 + 记录 source hash', () => {
      writeSource('base-skill.md', '# Tide Mind');
      writeTarget('base-skill.md', '# External Brain 旧内容');
      const store = makeMemoryStore();

      const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });

      expect(result.refreshed).toEqual(['base-skill.md']);
      expect(readTarget('base-skill.md')).toBe('# Tide Mind');
      expect(store.snapshot()['base-skill.md']).toBe(sha256('# Tide Mind'));
    });

    it('运行时文件不含 legacy marker → 保留 + backfill source hash 作为基线', () => {
      writeSource('base-skill.md', '# Tide Mind 官方');
      writeTarget('base-skill.md', '# 用户自定义内容');
      const store = makeMemoryStore();

      const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });

      expect(result.preserved).toEqual(['base-skill.md']);
      expect(result.refreshed).toEqual([]);
      // 目标不动
      expect(readTarget('base-skill.md')).toBe('# 用户自定义内容');
      // 但基线已经写入（作为"上次推送"）
      expect(store.snapshot()['base-skill.md']).toBe(sha256('# Tide Mind 官方'));
    });

    it('运行时文件已经和源一致 → 保留 + 记录 hash', () => {
      const content = '# Tide Mind';
      writeSource('base-skill.md', content);
      writeTarget('base-skill.md', content);
      const store = makeMemoryStore();

      const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });

      expect(result.preserved).toEqual(['base-skill.md']);
      expect(store.snapshot()['base-skill.md']).toBe(sha256(content));
    });
  });

  describe('增量同步（已有历史记录）', () => {
    it('源未变 → no-op', () => {
      const content = '# Tide Mind v1';
      writeSource('base-skill.md', content);
      writeTarget('base-skill.md', content);
      const store = makeMemoryStore({ 'base-skill.md': sha256(content) });

      const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });

      expect(result.preserved).toEqual(['base-skill.md']);
      expect(result.refreshed).toEqual([]);
    });

    it('源更新，用户没改过 target → 覆盖（核心长期价值场景）', () => {
      const oldContent = '# Tide Mind v1';
      const newContent = '# Tide Mind v2 — 改进的 prompt';
      writeSource('base-skill.md', newContent); // 源已升级到 v2
      writeTarget('base-skill.md', oldContent); // 运行时还是 v1
      const store = makeMemoryStore({
        'base-skill.md': sha256(oldContent), // 上次推送的是 v1，和 target 一致
      });

      const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });

      expect(result.refreshed).toEqual(['base-skill.md']);
      expect(readTarget('base-skill.md')).toBe(newContent);
      expect(store.snapshot()['base-skill.md']).toBe(sha256(newContent));
    });

    it('源更新，用户改过 target → 保留并标记 userModified', () => {
      const oldSource = '# Tide Mind v1';
      const newSource = '# Tide Mind v2';
      const userEdit = '# Tide Mind v1 — 加了点我的笔记';
      writeSource('base-skill.md', newSource);
      writeTarget('base-skill.md', userEdit);
      const store = makeMemoryStore({
        'base-skill.md': sha256(oldSource), // 上次推送的是 v1
      });

      const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });

      expect(result.userModified).toEqual(['base-skill.md']);
      expect(result.refreshed).toEqual([]);
      // 用户编辑未被动
      expect(readTarget('base-skill.md')).toBe(userEdit);
      // hash store 也不更新（下次源再变时还能识别用户是否改过）
      expect(store.snapshot()['base-skill.md']).toBe(sha256(oldSource));
    });

    it('源更新，用户改过 target 但仍含 legacy marker → 强制覆盖', () => {
      // 这是一个边界场景：用户在 rebrand 前自定义过，但内容里仍保留着老品牌名
      // 我们仍认为这是需要清理的老残留
      const oldSource = '# External Brain v1';
      const newSource = '# Tide Mind v2';
      writeSource('base-skill.md', newSource);
      writeTarget('base-skill.md', '# External Brain — 我加了笔记');
      const store = makeMemoryStore({
        'base-skill.md': sha256(oldSource),
      });

      const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });

      expect(result.refreshed).toEqual(['base-skill.md']);
      expect(readTarget('base-skill.md')).toBe(newSource);
    });
  });

  describe('幂等性', () => {
    it('连续调用两次：第二次应为 all preserved', () => {
      writeSource('base-skill.md', '# Tide Mind');
      writeTarget('base-skill.md', '# External Brain 老');
      const store = makeMemoryStore();

      const first = syncSkillFiles(sourceDir, targetDir, { hashStore: store });
      expect(first.refreshed).toEqual(['base-skill.md']);

      const second = syncSkillFiles(sourceDir, targetDir, { hashStore: store });
      expect(second.refreshed).toEqual([]);
      expect(second.preserved).toEqual(['base-skill.md']);
    });

    it('源未变 + 用户后续编辑 target + 再次同步：用户编辑被保留', () => {
      // 1. 初始同步
      writeSource('base-skill.md', '# Tide Mind');
      writeTarget('base-skill.md', '# External Brain 老');
      const store = makeMemoryStore();
      syncSkillFiles(sourceDir, targetDir, { hashStore: store });
      expect(readTarget('base-skill.md')).toBe('# Tide Mind');

      // 2. 用户编辑 target
      fs.writeFileSync(path.join(targetDir, 'base-skill.md'), '# Tide Mind — 我的笔记');

      // 3. 再次同步（源未变）
      const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });
      expect(result.preserved).toEqual(['base-skill.md']);
      expect(readTarget('base-skill.md')).toBe('# Tide Mind — 我的笔记');
    });

    it('用户编辑后，源又更新 → 保留用户版本，标记 userModified', () => {
      // 1. 初始同步
      writeSource('base-skill.md', '# Tide Mind v1');
      const store = makeMemoryStore();
      syncSkillFiles(sourceDir, targetDir, { hashStore: store });

      // 2. 用户编辑
      fs.writeFileSync(path.join(targetDir, 'base-skill.md'), '# Tide Mind v1 — 我的笔记');

      // 3. 源升级到 v2
      fs.writeFileSync(path.join(sourceDir, 'base-skill.md'), '# Tide Mind v2');

      // 4. 同步
      const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });
      expect(result.userModified).toEqual(['base-skill.md']);
      expect(readTarget('base-skill.md')).toBe('# Tide Mind v1 — 我的笔记');
    });
  });

  describe('用户真实 rebrand 场景：5 老 2 新 + hash backfill', () => {
    it('混合场景正确分流', () => {
      // 源全是新品牌
      writeSource('base-skill.md', '# Tide Mind — 使用指南');
      writeSource('claude-code-skill.md', '# Tide Mind — Claude Code 使用指南');
      writeSource('codex-skill.md', '# Tide Mind — Codex 使用指南');
      writeSource('cursor-skill.md', '# Tide Mind — Cursor 使用指南');
      writeSource('cowork-skill.md', '# Tide Mind — Cowork 使用指南');
      writeSource('windsurf-skill.md', '# Tide Mind — Windsurf 使用指南');
      writeSource('openclaw-skill.md', '# Tide Mind — OpenClaw 使用指南');

      // 运行时：5 老 2 新
      writeTarget('base-skill.md', '# External Brain — 使用指南');
      writeTarget('claude-code-skill.md', '# External Brain — Claude Code 使用指南');
      writeTarget('cowork-skill.md', '# External Brain — Cowork');
      writeTarget('windsurf-skill.md', '# External Brain — Windsurf');
      writeTarget('openclaw-skill.md', '# External Brain — OpenClaw');
      writeTarget('codex-skill.md', '# Tide Mind — Codex 使用指南');
      writeTarget('cursor-skill.md', '# Tide Mind — Cursor 使用指南');

      const store = makeMemoryStore(); // 空 store，模拟首次启用 hash 模式
      const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });

      expect(result.refreshed.sort()).toEqual(
        ['base-skill.md', 'claude-code-skill.md', 'cowork-skill.md', 'openclaw-skill.md', 'windsurf-skill.md'].sort(),
      );
      expect(result.preserved.sort()).toEqual(['codex-skill.md', 'cursor-skill.md'].sort());

      // 所有 7 个文件都应该在 store 里有记录
      const snapshot = store.snapshot();
      for (const f of [
        'base-skill.md',
        'claude-code-skill.md',
        'codex-skill.md',
        'cursor-skill.md',
        'cowork-skill.md',
        'windsurf-skill.md',
        'openclaw-skill.md',
      ]) {
        expect(snapshot[f]).toBeDefined();
      }

      // 老品牌应该被清掉
      for (const f of result.refreshed) {
        expect(readTarget(f)).not.toContain('External Brain');
      }
    });
  });

  describe('LEGACY_BRAND_MARKERS 全覆盖', () => {
    it('所有 marker 都触发 refresh（fallback 和 hash 模式都覆盖）', () => {
      for (const marker of LEGACY_BRAND_MARKERS) {
        // Fallback 模式
        fs.rmSync(targetDir, { recursive: true, force: true });
        writeSource('f.md', '# Tide Mind 新');
        writeTarget('f.md', `含 ${marker} 的旧`);
        expect(syncSkillFiles(sourceDir, targetDir).refreshed).toEqual(['f.md']);

        // Hash 模式（空 store，backfill 路径）
        fs.rmSync(targetDir, { recursive: true, force: true });
        writeTarget('f.md', `含 ${marker} 的旧`);
        const store = makeMemoryStore();
        expect(syncSkillFiles(sourceDir, targetDir, { hashStore: store }).refreshed).toEqual(['f.md']);
      }
    });
  });
});

// ===========================================================================
// Part 3: createSyncHashStoreFromDb — better-sqlite3 集成测试
// ===========================================================================
describe('createSyncHashStoreFromDb（SQLite 集成）', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('自动创建 sync_hashes 表', () => {
    createSyncHashStoreFromDb(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_hashes'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('sync_hashes');
  });

  it('sync_hashes 表不存在时 get 返回 null', () => {
    const store = createSyncHashStoreFromDb(db);
    expect(store.get('base-skill.md')).toBeNull();
  });

  it('set 后 get 返回相同 hash', () => {
    const store = createSyncHashStoreFromDb(db);
    store.set('base-skill.md', 'abc123');
    expect(store.get('base-skill.md')).toBe('abc123');
  });

  it('使用 skill/ 前缀做命名空间，不和 strategies 冲突', () => {
    const skillStore = createSyncHashStoreFromDb(db, 'skill/');
    skillStore.set('foo.md', 'hash-skill');

    // 模拟 strategies 直接写 sync_hashes（不带前缀）
    db.prepare(
      "INSERT INTO sync_hashes (file_name, source_hash, synced_at) VALUES ('foo.md', 'hash-strategy', datetime('now'))",
    ).run();

    // 两者互不干扰
    expect(skillStore.get('foo.md')).toBe('hash-skill');
    const strategyRow = db
      .prepare("SELECT source_hash FROM sync_hashes WHERE file_name = 'foo.md'")
      .get() as { source_hash: string };
    expect(strategyRow.source_hash).toBe('hash-strategy');
  });

  it('set 幂等：对同一文件多次 set 只保留最新值', () => {
    const store = createSyncHashStoreFromDb(db);
    store.set('base-skill.md', 'hash-v1');
    store.set('base-skill.md', 'hash-v2');
    expect(store.get('base-skill.md')).toBe('hash-v2');

    const count = (db.prepare('SELECT COUNT(*) as c FROM sync_hashes').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('端到端：把 syncSkillFiles 和 DB store 串起来', () => {
    writeSource('base-skill.md', '# Tide Mind v1');
    writeTarget('base-skill.md', '# External Brain 老');

    const store = createSyncHashStoreFromDb(db);
    const result = syncSkillFiles(sourceDir, targetDir, { hashStore: store });

    expect(result.refreshed).toEqual(['base-skill.md']);
    expect(readTarget('base-skill.md')).toBe('# Tide Mind v1');
    expect(store.get('base-skill.md')).toBe(sha256('# Tide Mind v1'));

    // 源升级到 v2
    fs.writeFileSync(path.join(sourceDir, 'base-skill.md'), '# Tide Mind v2');

    const result2 = syncSkillFiles(sourceDir, targetDir, { hashStore: store });
    expect(result2.refreshed).toEqual(['base-skill.md']);
    expect(readTarget('base-skill.md')).toBe('# Tide Mind v2');

    // 第三次：源未变
    const result3 = syncSkillFiles(sourceDir, targetDir, { hashStore: store });
    expect(result3.preserved).toEqual(['base-skill.md']);
    expect(result3.refreshed).toEqual([]);
  });
});
