/**
 * structure-holes 计算 worker（2026-05-21 v0.2.74 CRITICAL #1 修复）
 *
 * 背景：computeStructureHoles 的 O(E²/V) CTE 自连接在万节点 vault 跑 50-200s,
 * better-sqlite3 是同步 API,在 Electron 主线程跑会把 UI 完全冻死(实测 107s),
 * 看起来像"应用挂了"。把它搬到 worker_threads:
 *   - worker 开自己的 better-sqlite3 只读连接(WAL 模式可与主线程连接并发读)
 *   - 跑完 postMessage 把结果传回主线程
 *   - 主线程只做一次轻量的单行 UPSERT 写缓存(见 structure-holes.ts)
 * worker 全程纯读,不写库。
 *
 * 打包：esbuild bundle 到 client/out/bin/structure-holes-worker.cjs(随 build-bin.mjs),
 * better-sqlite3 作 external,运行时从 unpacked node_modules 加载(同 mcp-server.cjs 链路)。
 * 该文件被 esbuild 当作独立 entry 打包,不会被任何 src/ 代码 import,所以 tsc 编译进
 * dist/ 后也不会执行(CLI 不用 worker)。
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { computeStructureHoles } from './structure-holes.js';

interface WorkerInput {
  dbPath: string;
  limit?: number;
}

interface WorkerOutput {
  ok: boolean;
  holes?: ReturnType<typeof computeStructureHoles>;
  error?: string;
}

function run(): void {
  if (!parentPort) {
    // 不是作为 worker 启动(理论上不会发生),直接退出。
    return;
  }
  const { dbPath, limit } = (workerData ?? {}) as WorkerInput;
  let db: Database.Database | null = null;
  let out: WorkerOutput;
  try {
    if (!dbPath) throw new Error('structure-holes-worker: missing dbPath');
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    const holes = computeStructureHoles(db, limit);
    out = { ok: true, holes };
  } catch (err) {
    out = { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  parentPort.postMessage(out);
}

run();
