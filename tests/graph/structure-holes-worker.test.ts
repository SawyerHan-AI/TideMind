/**
 * structure-holes worker 集成测试（v0.2.74 CRITICAL #1）
 *
 * 验证编译产物 dist/graph/structure-holes-worker.js 作为 worker_threads 入口能:
 *   - 用 workerData.dbPath 开自己的只读 better-sqlite3 连接
 *   - 跑 computeStructureHoles
 *   - postMessage 把 { ok, holes } 传回主线程
 *   - 失败时 postMessage { ok: false, error }(而不是崩溃)
 *
 * 这是 worker 路径唯一能在 CI/本地(非打包)验证的层:worker 只依赖 better-sqlite3
 * (普通 node 原生模块,node-ABI 能加载)。打包后(Electron ABI + asar.unpacked)的
 * 加载链路由 build-bin / electron-builder 保证,跟 mcp-server.cjs 同链路。
 *
 * 用编译产物(dist)而非源码,因为 worker_threads 不能直接跑 .ts。dist 不存在时
 * (没跑过 npm run build)skip —— 发版流程(sync-oss)和 health 都会先 build。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { ensureSchema } from '../../src/db/schema.js';
import { createNode } from '../../src/db/nodes.js';
import { createLink } from '../../src/db/links.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.resolve(__dirname, '../../dist/graph/structure-holes-worker.js');
const workerBuilt = fs.existsSync(WORKER_PATH);

interface WorkerOutput {
  ok: boolean;
  holes?: Array<{ nodeA: string; nodeB: string; sharedCount: number }>;
  error?: string;
}

function runWorker(dbPath: string, limit?: number): Promise<WorkerOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: { dbPath, limit } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('worker test timeout'));
    }, 20_000);
    worker.on('message', (msg: WorkerOutput) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(msg);
    });
    worker.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

let tmpDir: string;
let dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-worker-test-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  const db = new Database(dbPath);
  ensureSchema(db);
  // A,B 共享 X,Y 两个邻居且无 A-B 直接链接 → (A,B) 和 (X,Y) 都是结构洞
  const mk = (content: string) => createNode(db, { type: 'fact', content, is_meta: 0, is_crystal: 0, is_tag: 0 });
  const A = mk('A content');
  const B = mk('B content');
  const X = mk('X content');
  const Y = mk('Y content');
  for (const [f, t] of [[A.id, X.id], [B.id, X.id], [A.id, Y.id], [B.id, Y.id]] as const) {
    createLink(db, { from_id: f, to_id: t, relation: [{ type: 'analogous', confidence: 0.7 }] });
  }
  db.close();
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe.skipIf(!workerBuilt)('structure-holes-worker (compiled)', () => {
  it('worker 开自己的只读连接计算并 postMessage 回结果', async () => {
    const out = await runWorker(dbPath);
    expect(out.ok).toBe(true);
    expect(out.holes).toBeDefined();
    // (A,B) 与 (X,Y) 两个结构洞
    expect(out.holes!.length).toBe(2);
    for (const h of out.holes!) expect(h.sharedCount).toBe(2);
  });

  it('limit 参数透传到 worker', async () => {
    const out = await runWorker(dbPath, 1);
    expect(out.ok).toBe(true);
    expect(out.holes!.length).toBe(1);
  });

  it('dbPath 不存在时 worker 返回 { ok:false, error },不崩溃', async () => {
    const out = await runWorker(path.join(tmpDir, 'nonexistent.sqlite'));
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });

  it('worker 用只读连接,不会写库(写缓存由主线程做)', async () => {
    await runWorker(dbPath);
    // worker 只读,不应创建/改动 structure_holes_cache(那是主线程 writeStructureHolesCache 的事)
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM structure_holes_cache').get() as { c: number };
    db.close();
    expect(row.c).toBe(0);
  });
});
