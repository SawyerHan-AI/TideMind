/**
 * Obsidian initialization (runInitialization → processFileForInit) 集成测试
 *
 * 当前专测：初始全量导入路径的 TOCTOU——digest（分钟级）期间用户编辑文件,
 * 写回 sync state 的 content_hash + mtime + size 必须都来自被 digest 的那份内容
 * （snapshot），而不是 digest 后重读盘的新值。否则下一轮增量 isFileChanged 的
 * mtime+size 快速路径会短路判未变更,这次编辑永久丢失（.md + canvas 两个分支）。
 * 与增量路径(queue.ts processOneFile)的 snapshot 修复对齐。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- Mocks（必须在 import 之前） ----

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock('../../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb', user_name: 'tester' },
    anthropic: { api_key: 'test-key' },
    vertex: { project_id: '', region: 'us-central1' },
    ollama: { url: 'http://localhost:11434' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', light_model: 'test', standard_model: 'test', heavy_model: 'test' },
    embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
    search: { alpha: 0.4, beta: 0.3, gamma: 0.2, delta: 0.1 },
    metabolism: { daily_check_hours: [3], weekly_check_days: [0] },
    gates: {
      vector_search: 50, graph_expansion: 20, graph_expansion_links: 10,
      crystal_generation: 100, divergent_scan: 200,
      learning_2_min_nodes: 30, learning_2_min_recall_ops: 10,
    },
    sources: {},
  }),
  reloadConfig: () => {},
  getDataDir: () => '/tmp/test-eb',
  // LLM 关掉：Phase 4/6/8 直接跳过，测试只跑 Phase 0-3（含 Phase 2 = processFileForInit）。
  isLlmConfigured: () => false,
}));

const mockGetDb = vi.fn();
vi.mock('../../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false, getDb: () => mockGetDb() };
});

vi.mock('../../../src/llm/embedding.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(3072)),
}));

vi.mock('../../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('LLM response'),
}));

vi.mock('../../../src/graph/landing.js', () => ({
  findLandingConnections: vi.fn().mockReturnValue({ action: 'new', confirmedLinks: [], pendingLinks: [] }),
}));

vi.mock('../../../src/graph/dedup.js', () => ({
  reconsolidateNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/vectors.js', () => ({
  insertVector: vi.fn(),
  getVectorForNode: vi.fn().mockReturnValue(null),
}));

// 代谢阶段（Phase 3.5 / 5 / 7 / 8）no-op，让测试聚焦 Phase 2 入库 + sync state。
vi.mock('../../../src/metabolism/tag-promote.js', () => ({
  promoteFrequentTags: vi.fn().mockResolvedValue({ promoted: 0, linksCreated: 0 }),
}));
vi.mock('../../../src/metabolism/annotate.js', () => ({
  runAnnotation: vi.fn().mockResolvedValue({ annotated: 0 }),
}));
vi.mock('../../../src/metabolism/link-evaluate.js', () => ({
  runLinkEvaluate: vi.fn().mockResolvedValue({ evaluated: 0 }),
}));
vi.mock('../../../src/metabolism/divergent.js', () => ({
  runKeystoneIdentification: vi.fn().mockReturnValue(0),
  runCrystalEmergence: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/metabolism/temporal-crystal.js', () => ({
  runTemporalCrystal: vi.fn().mockResolvedValue({ crystals_created: 0 }),
}));

vi.mock('../../../src/stream/writer.js', () => ({
  appendToStream: vi.fn().mockReturnValue('stream:2026-01-01:abc:1'),
}));

vi.mock('../../../src/integrations/obsidian/vault-config.js', () => ({
  readVaultConfig: () => ({ dailyNotes: null, attachmentFolder: '', templateFolder: '', useMarkdownLinks: false }),
  getExcludedDirs: () => ['.obsidian', '.trash'],
}));

// 部分 mock sync-state：默认保留真实实现,只在 dataless→readable race 测试里
// 控制 getFileStat 返回 null,其余函数走真实逻辑。两种 race 模式:
//   - forceFileStatNull=true: 全部 getFileStat 返回 null(连 read-time 补抓也失败,
//     极罕见兜底:走 mtime/size=0 + hash,验证不产生孤儿)。
//   - nullFirstFileStatOnly=true: 仅入口那次 getFileStat 返回 null(stat 时 dataless),
//     read-time 补抓那次返回真实 stat(文件已被 iCloud 下载) → 真实 race,
//     验证 read-time snapshot 与 hash 同源(bug A 不丢编辑 / bug B 不留孤儿)。
let forceFileStatNull = false;
let nullFirstFileStatOnly = false;
let fileStatCallCount = 0;
vi.mock('../../../src/integrations/obsidian/sync-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/integrations/obsidian/sync-state.js')>();
  return {
    ...actual,
    getFileStat: (filePath: string) => {
      fileStatCallCount++;
      if (forceFileStatNull) return null;
      if (nullFirstFileStatOnly && fileStatCallCount === 1) return null;
      return actual.getFileStat(filePath);
    },
  };
});

import type Database from 'better-sqlite3';
import { setupTestDb } from '../../helpers/test-db.js';
import { runInitialization } from '../../../src/integrations/obsidian/initialization.js';
import { ensureSyncSchema, getFileState, isFileChanged, hasCompletedFullScan } from '../../../src/integrations/obsidian/sync-state.js';
import { appendToStream } from '../../../src/stream/writer.js';
import type { InitSessionContext } from '../../../src/integrations/shared/init-session.js';

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-obsidian-init-'));
  db = setupTestDb();
  mockGetDb.mockReturnValue(db);
  ensureSyncSchema(db);
  // setupTestDb 不含 sqlite-vec。Phase 5 的 embeddedCount 查询会 JOIN nodes_vec,
  // 建个普通占位表让查询不报 "no such table"（向量逻辑已被 mock,这里只需表存在）。
  db.exec('CREATE TABLE IF NOT EXISTS nodes_vec (id TEXT PRIMARY KEY, embedding BLOB)');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.mocked(appendToStream).mockReset();
  vi.mocked(appendToStream).mockReturnValue('stream:2026-01-01:abc:1' as never);
  forceFileStatNull = false;
  nullFirstFileStatOnly = false;
  fileStatCallCount = 0;
  db.close();
});

/** 写 .md（递归建目录） */
function writeMd(relPath: string, content: string): string {
  const absPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
  return absPath;
}

/** 写 .canvas */
function writeCanvas(relPath: string, data: unknown): string {
  const absPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(data), 'utf-8');
  return absPath;
}

/** 最小 InitSessionContext stub（不 abort，回调全 no-op） */
function makeCtx(sourceId: string): InitSessionContext {
  return {
    sourceId,
    signal: new AbortController().signal,
    reportPhase: () => {},
    advance: () => {},
    setProgress: () => {},
    heartbeat: () => {},
  };
}

// ============================================================
// TOCTOU：init digest 期间文件被编辑（对齐增量路径 queue.ts）
// ============================================================

describe('TOCTOU: init digest 期间文件被编辑', () => {
  it('.md：init digest 期间编辑文件后,state 记录 snapshot;下一轮 isFileChanged 仍为 true', async () => {
    const rel = 'notes/init-toctou.md';
    const absPath = writeMd(
      rel,
      '# Topic\n\nThis original paragraph is intentionally long enough to remain its own semantic segment and comfortably pass the minimum content quality gate for digest.',
    );

    // appendToStream 在 digest 内部、updateSyncState 之前被 await：借此模拟
    // "init digest 期间用户编辑文件"的 TOCTOU 窗口。第一次调用时把文件改成新内容,
    // 并把 mtime 明显前进（确保不是仅靠 mtime 漂移触发,而是验证快速路径短路问题）。
    let edited = false;
    vi.mocked(appendToStream).mockImplementation((async () => {
      if (!edited) {
        edited = true;
        fs.writeFileSync(
          absPath,
          '# Topic\n\nThis paragraph was edited DURING the init digest window and must be detected on the next sync round, not silently dropped.',
          'utf-8',
        );
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(absPath, future, future);
      }
      return 'stream:2026-01-01:abc:1';
    }) as never);

    await runInitialization(db, makeCtx('__default__'), tmpDir);

    const state = getFileState(db, rel);
    expect(state).not.toBeNull();

    // 关键断言：存储的 content_hash + mtime + size 必须都是 snapshot（被 digest 的原始内容）,
    // 而不是 digest 后重读的新值。磁盘当前是"新内容" → isFileChanged 应判为已变更。
    // 修复前：updateSyncState 走 fs.statSync 重读盘,mtime/size 成了编辑后的新值,
    // isFileChanged 的 mtime+size 快速路径直接短路返回 false,这次编辑永久丢失。
    expect(isFileChanged(absPath, state)).toBe(true);
  });

  it('canvas：init digest 期间编辑文件后,state 记录 snapshot;下一轮 isFileChanged 仍为 true', async () => {
    const rel = 'boards/init-toctou.canvas';
    const original = {
      nodes: [
        { id: 'n1', type: 'text', text: 'Original canvas note that is long enough to survive the digest quality gate and become its own brain node.', x: 0, y: 0, width: 400, height: 200 },
      ],
      edges: [],
    };
    const absPath = writeCanvas(rel, original);

    let edited = false;
    vi.mocked(appendToStream).mockImplementation((async () => {
      if (!edited) {
        edited = true;
        const updated = {
          nodes: [
            { id: 'n1', type: 'text', text: 'This canvas node was edited DURING the init digest window and must be detected on the next sync round, not silently dropped.', x: 0, y: 0, width: 400, height: 200 },
          ],
          edges: [],
        };
        fs.writeFileSync(absPath, JSON.stringify(updated), 'utf-8');
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(absPath, future, future);
      }
      return 'stream:2026-01-01:abc:1';
    }) as never);

    await runInitialization(db, makeCtx('__default__'), tmpDir);

    const state = getFileState(db, rel);
    expect(state).not.toBeNull();

    // 修复前：canvas 分支的 updateSyncState 既不传 snapshotStat 也不传 contentHash,
    // mtime/size + hash 全部重读盘成编辑后的新值,下次跳过此文件,编辑永久丢失。
    expect(isFileChanged(absPath, state)).toBe(true);
  });
});

// ============================================================
// 真实 race（Round 6 回归）：入口 getFileStat=null(dataless),read-time 补抓成功。
// read-time snapshot 必须与 contentHash 同源:
//   - bug A：digest 期间编辑 → 下一轮 isFileChanged 仍为 true(不丢编辑)。
//   - bug B：无编辑 → state 写入且 isFileChanged 为 false(无孤儿、下轮不重复 digest)。
// 修复前(c08a2ce):snapshotStat===null 分支在 digest 后才 getFileStat 重抓,mtime/size=
// 编辑后新值 配 digest 前 hash → bug A 下 isFileChanged 快速路径短路判未变更,编辑永久丢失。
// ============================================================

describe('dataless→readable 真实 race: 入口 null + read-time 补抓成功（Round 6）', () => {
  it('bug A：入口 dataless + digest 期间编辑 → 下一轮 isFileChanged 仍为 true（不丢编辑）', async () => {
    const rel = 'notes/init-race-edit.md';
    const absPath = writeMd(
      rel,
      '# Topic\n\nThis original paragraph is intentionally long enough to remain its own semantic segment and pass the digest quality gate.',
    );

    // 仅入口 getFileStat 返回 null（stat 时 dataless）；read-time 补抓返回真实 stat。
    nullFirstFileStatOnly = true;

    let edited = false;
    vi.mocked(appendToStream).mockImplementation((async () => {
      if (!edited) {
        edited = true;
        fs.writeFileSync(
          absPath,
          '# Topic\n\nThis paragraph was edited DURING the digest window in the dataless race and must survive into the next sync round.',
          'utf-8',
        );
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(absPath, future, future);
      }
      return 'stream:2026-01-01:abc:1';
    }) as never);

    await runInitialization(db, makeCtx('__default__'), tmpDir);

    const state = getFileState(db, rel);
    expect(state).not.toBeNull();
    // read-time snapshot = 编辑前 mtime/size,与编辑前 hash 同源。磁盘当前是编辑后内容 →
    // mtime/size 已变 → 快速路径不短路 → hash 比对 → 判变更。回归守卫(bug A)。
    expect(isFileChanged(absPath, state)).toBe(true);
  });

  it('bug B：入口 dataless + 无编辑 → state 写入且 isFileChanged 为 false（无孤儿/不重复 digest）', async () => {
    const rel = 'notes/init-race-stable.md';
    const absPath = writeMd(
      rel,
      '# Topic\n\nA stable paragraph in the dataless race that is never edited; the read-time snapshot must match disk so the next round skips it.',
    );

    nullFirstFileStatOnly = true;

    await runInitialization(db, makeCtx('__default__'), tmpDir);

    const state = getFileState(db, rel);
    expect(state).not.toBeNull();
    expect(state!.node_ids.length).toBeGreaterThan(0); // 节点非孤儿
    // read-time snapshot = 真实 mtime/size,与磁盘一致 → 下轮跳过,不重复 digest。回归守卫(bug B)。
    expect(isFileChanged(absPath, state)).toBe(false);
  });
});

describe('首次导入路径身份与恢复', () => {
  const paragraph = 'A sufficiently detailed fictional note paragraph to pass the content quality gate and preserve a distinct memory node for regression verification.';

  it('显式路径和唯一 alias 指向正确的同名文件，索引页也创建链接', async () => {
    writeMd('a/Topic.md', `---\naliases: [UniqueAlias]\n---\n${paragraph} Alpha target.`);
    writeMd('b/Topic.md', `${paragraph} Beta target.`);
    writeMd('Start.md', `${paragraph}\n\n[[a/Topic.md]] [[UniqueAlias]]`);
    await runInitialization(db, makeCtx('paths'), tmpDir);
    const source = getFileState(db, 'Start.md', 'paths')!.node_ids[0];
    const alpha = getFileState(db, 'a/Topic.md', 'paths')!.node_ids[0];
    const beta = getFileState(db, 'b/Topic.md', 'paths')!.node_ids[0];
    expect(db.prepare('SELECT 1 FROM links WHERE from_id = ? AND to_id = ?').get(source, alpha)).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM links WHERE from_id = ? AND to_id = ?').get(source, beta)).toBeUndefined();
  });

  it('恢复已变更文件走替换而非复用旧内容', async () => {
    const file = writeMd('Changed.md', paragraph);
    await runInitialization(db, makeCtx('resume'), tmpDir);
    fs.writeFileSync(file, `${paragraph} Updated version with a new explicit detail.`);
    await runInitialization(db, makeCtx('resume'), tmpDir);
    expect(isFileChanged(file, getFileState(db, 'Changed.md', 'resume'))).toBe(false);
    const ids = getFileState(db, 'Changed.md', 'resume')!.node_ids;
    expect((db.prepare('SELECT content FROM nodes WHERE id = ?').get(ids[0]) as {content: string}).content).toContain('Updated version');
  });

  it('无效 Canvas 不能报告初始化成功', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Invalid.canvas'), '{invalid json');
    await expect(runInitialization(db, makeCtx('invalid'), tmpDir)).rejects.toThrow('文件入库失败');
    expect(hasCompletedFullScan(db, 'invalid')).toBe(false);
  });
});

  it('digest 期间中断不能保存断点或遗留活跃半成品', async () => {
    writeMd('Abort.md', 'Fictional detailed paragraph content for cancellation regression that is sufficiently long to be imported as a memory node.');
    const controller = new AbortController();
    vi.mocked(appendToStream).mockImplementation((() => { controller.abort(new Error('test abort')); return 'stream:2026-01-01:abc:1'; }) as never);
    const ctx = { ...makeCtx('abort'), signal: controller.signal };
    await expect(runInitialization(db, ctx, tmpDir)).rejects.toThrow('test abort');
    expect(getFileState(db, 'Abort.md', 'abort')).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE is_superseded = 0').get() as {n:number}).n).toBe(0);
    expect(hasCompletedFullScan(db, 'abort')).toBe(false);
  });

it('增量引用切换与迟到目标重算，重复执行不创建重复链接', async () => {
  const { refreshObsidianLinks } = await import('../../../src/integrations/obsidian/explicit-links.js');
  const paragraph = 'Fictional sufficiently detailed note for verifying daily Obsidian updates with deterministic source identities and explicit references.';
  writeMd('A.md', paragraph + ' Alpha.');
  writeMd('B.md', paragraph + ' Beta.');
  writeMd('Source.md', paragraph + '\n[[A]]');
  await runInitialization(db, makeCtx('refresh'), tmpDir);
  let source = getFileState(db, 'Source.md', 'refresh')!.node_ids[0];
  const a = getFileState(db, 'A.md', 'refresh')!.node_ids[0];
  const b = getFileState(db, 'B.md', 'refresh')!.node_ids[0];
  writeMd('Source.md', paragraph + '\n[[B]]');
  const { processFileQueue } = await import('../../../src/integrations/obsidian/queue.js');
  await processFileQueue(db, [path.join(tmpDir, 'Source.md')], tmpDir, {}, 'refresh');
  source = getFileState(db, 'Source.md', 'refresh')!.node_ids[0];
  await refreshObsidianLinks(db, tmpDir, 'refresh');
  await refreshObsidianLinks(db, tmpDir, 'refresh');
  expect(db.prepare('SELECT 1 FROM links WHERE from_id = ? AND to_id = ? AND deleted = 0').get(source, a)).toBeUndefined();
  expect((db.prepare('SELECT COUNT(*) AS n FROM links WHERE from_id = ? AND to_id = ? AND deleted = 0').get(source, b) as {n:number}).n).toBe(1);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM links').get() as {n:number}).n;
  await refreshObsidianLinks(db, tmpDir, 'refresh');
  expect((db.prepare('SELECT COUNT(*) AS n FROM links').get() as {n:number}).n).toBe(count);
});

it('无向量扩展也可以正常初始化，日期共享策略识别历史日记', async () => {
  const { inferObsidianFileCreated } = await import('../../../src/integrations/obsidian/time-inference.js');
  db.exec('DROP TABLE nodes_vec');
  const file = writeMd('2020-04-03.md', 'Fictional daily historical journal content sufficient for normal import and preserving the original day instead of the filesystem creation date.');
  expect(inferObsidianFileCreated(file, tmpDir)).toBe('2020-04-03T00:00:00.000Z');
  await expect(runInitialization(db, makeCtx('no-vector'), tmpDir)).resolves.toMatchObject({ totalFiles: 1 });
});

it('首次导入不主动运行全图库代谢阶段', async () => {
  const { runKeystoneIdentification, runCrystalEmergence } = await import('../../../src/metabolism/divergent.js');
  const { promoteFrequentTags } = await import('../../../src/metabolism/tag-promote.js');
  vi.mocked(runKeystoneIdentification).mockClear();
  vi.mocked(runCrystalEmergence).mockClear();
  vi.mocked(promoteFrequentTags).mockClear();
  writeMd('Import.md', 'Fictional source content for checking that initial import leaves global metabolism decisions to the existing background strategy.');
  const report = await runInitialization(db, makeCtx('scope'), tmpDir);
  expect(report.crystalsCreated).toBe(0);
  expect(runKeystoneIdentification).not.toHaveBeenCalled();
  expect(runCrystalEmergence).not.toHaveBeenCalled();
  expect(promoteFrequentTags).not.toHaveBeenCalled();
});

it('迟到目标替换悬空引用并停止后不写关系', async () => {
  const { refreshObsidianLinks } = await import('../../../src/integrations/obsidian/explicit-links.js');
  const paragraph = 'Fictional enough detailed text to establish an imported memory and validate future Obsidian references resolving after the target arrives.';
  writeMd('Source.md', paragraph + '\n[[Future]]');
  await runInitialization(db, makeCtx('late'), tmpDir);
  writeMd('Future.md', paragraph + ' Future target.');
  await runInitialization(db, makeCtx('late'), tmpDir);
  const source = getFileState(db, 'Source.md', 'late')!.node_ids[0];
  const target = getFileState(db, 'Future.md', 'late')!.node_ids[0];
  expect(db.prepare('SELECT 1 FROM links WHERE from_id = ? AND to_id = ? AND deleted = 0').get(source, target)).toBeTruthy();
  expect((db.prepare("SELECT COUNT(*) AS n FROM links WHERE from_id = ? AND note LIKE 'Obsidian 悬空引用:%' AND deleted = 0").get(source) as {n:number}).n).toBe(0);
  await expect(refreshObsidianLinks(db, tmpDir, 'late', () => true)).rejects.toThrow('已停止');
});

it('目标暂离线的 iCloud stub 不会把原引用换成悬空标签', async () => {
  const { refreshObsidianLinks } = await import('../../../src/integrations/obsidian/explicit-links.js');
  const paragraph = 'Fictional detailed content used to validate preserving existing links while the corresponding vault target is temporarily unavailable offline.';
  writeMd('Target.md', paragraph);
  writeMd('Source.md', paragraph + '\n[[Target]]');
  await runInitialization(db, makeCtx('offline'), tmpDir);
  const source = getFileState(db, 'Source.md', 'offline')!.node_ids[0];
  const target = getFileState(db, 'Target.md', 'offline')!.node_ids[0];
  fs.renameSync(path.join(tmpDir, 'Target.md'), path.join(tmpDir, '.Target.md.icloud'));
  await refreshObsidianLinks(db, tmpDir, 'offline');
  expect(db.prepare('SELECT 1 FROM links WHERE from_id = ? AND to_id = ? AND deleted = 0').get(source, target)).toBeTruthy();
  expect(db.prepare('SELECT id FROM nodes WHERE is_tag = 1 AND title = ?').get('Target')).toBeUndefined();
});

it('首次短中文正文不作为元数据丢弃，初导即写增量段hash', async () => {
  writeMd('Short.md', '---\ntags: [fictional]\n---\n今天完成了虚构项目的第一步。');
  await runInitialization(db, makeCtx('short'), tmpDir);
  const state = getFileState(db, 'Short.md', 'short')!;
  expect(state.node_ids.length).toBeGreaterThan(0);
  expect(state.segment_hashes?.length).toBeGreaterThan(0);
  expect((db.prepare('SELECT content FROM nodes WHERE id = ?').get(state.node_ids[0]) as {content:string}).content).toContain('今天完成');
});

it('拒绝普通文件根目录，只跳过离线文件并报告数量', async () => {
  const file = writeMd('NotDirectory.md', 'Fictional file content.');
  await expect(runInitialization(db, makeCtx('file-root'), file)).rejects.toThrow('directory');
  fs.renameSync(file, path.join(tmpDir, '.NotDirectory.md.icloud'));
  writeMd('Available.md', 'Available synthetic note for incremental iCloud recovery.');
  await expect(runInitialization(db, makeCtx('stub-init'), tmpDir)).resolves.toMatchObject({ totalFiles: 1, offlineFiles: 1 });
  expect(getFileState(db, 'Available.md', 'stub-init')?.node_ids.length).toBeGreaterThan(0);
  expect(hasCompletedFullScan(db, 'stub-init')).toBe(false);
});
it('按来源页面路径解析 Markdown 相对链接，忽略外部 URL 和代码示例', async () => {
  const text = 'Fictional detail about the telescope mount for this isolated document.';
  writeMd('North/Target Page.md', text);
  writeMd('South/Target Page.md', text);
  writeMd('North/Source.md', text + '\n[同目录](Target%20Page.md) [外部](https://example.invalid/South/Target%20Page.md) `[[South/Target Page]]`');
  await runInitialization(db, makeCtx('markdown-link'), tmpDir);
  const id = (file: string) => getFileState(db, file, 'markdown-link')!.node_ids[0];
  const actual = db.prepare("SELECT to_id FROM links WHERE from_id = ? AND note LIKE 'Obsidian 引用:%' AND deleted = 0").pluck().all(id('North/Source.md'));
  expect(actual).toEqual([id('North/Target Page.md')]);
  expect(actual).not.toContain(id('South/Target Page.md'));
});

it('在生成报告时取消，保留可恢复的文件记录并撤销报告，不宣告成功', async () => {
  writeMd('Note.md', 'This is an isolated note for proving cancellation during report generation.');
  const controller = new AbortController();
  vi.mocked(appendToStream).mockImplementation((input => {
    if (String(input.content).includes('Obsidian 初始化报告')) controller.abort(new Error('cancelled at report'));
    return 'stream:2026-01-01:fixture:1';
  }) as typeof appendToStream);
  await expect(runInitialization(db, { ...makeCtx('cancel-report'), signal: controller.signal }, tmpDir)).rejects.toThrow('cancelled at report');
  expect(hasCompletedFullScan(db, 'cancel-report')).toBe(false);
  expect(db.prepare("SELECT 1 FROM nodes WHERE content LIKE 'Obsidian 初始化报告%' AND is_superseded = 0").get()).toBeUndefined();
  expect(getFileState(db, 'Note.md', 'cancel-report')).not.toBeNull();
});

it('引用写入失败后保留重试机会，未改动的文件也能补齐短名称引用', async () => {
  writeMd('Origin.md', 'This synthetic observation has a two-character unresolved reference [[样例]].');
  db.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON links WHEN NEW.note LIKE 'Obsidian 悬空引用:%'
           BEGIN SELECT RAISE(ABORT, 'fixture abort'); END`);
  await expect(runInitialization(db, makeCtx('retry-links'), tmpDir)).rejects.toThrow('fixture abort');
  const { linksNeedRefresh, refreshObsidianLinks } = await import('../../../src/integrations/obsidian/explicit-links.js');
  const { getAllFileStates } = await import('../../../src/integrations/obsidian/sync-state.js');
  const states = getAllFileStates(db, 'retry-links');
  expect(linksNeedRefresh(db, 'retry-links', states)).toBe(true);
  db.exec('DROP TRIGGER synthetic_failure');
  await refreshObsidianLinks(db, tmpDir, 'retry-links');
  expect(linksNeedRefresh(db, 'retry-links', states)).toBe(false);
  expect(db.prepare("SELECT 1 FROM links WHERE note = 'Obsidian 悬空引用: [[样例]]' AND deleted = 0").get()).toBeTruthy();
});
