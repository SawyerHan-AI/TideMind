/**
 * structure-holes 计算的 worker_threads 调度器（2026-05-21 v0.2.74 CRITICAL #1）。
 *
 * 把 O(E²/V) 的 CTE 自连接(实测在万节点 vault 跑 107s)从 Electron 主线程移到 worker:
 * 主线程 await 这个 Promise 时 event loop 是空闲的(worker 在另一个线程跑同步 SQL),
 * UI 不冻结。worker 算完 postMessage 回结果,主线程拿到后做轻量单行 UPSERT 写缓存
 * (见 @server/graph/structure-holes.ts::runStructureHolesPrecompute)。
 *
 * 设计要点:
 * - single-flight:daemon tick 和 IPC 冷启预热可能同时触发,共用一个 inflight Promise
 *   去重,避免两个 worker 算同一份数据。
 * - 硬超时:worker 跑超过 WORKER_TIMEOUT_MS 强制 terminate + reject,防卡死泄漏线程。
 * - graceful 失败:reject 让上层 catch 后只 log + skip(缓存保持上次的值),绝不崩溃、
 *   绝不回退到主线程内联计算(那会重新引入冻结 bug)。打包后 worker 万一起不来,最坏
 *   结果是 structure-holes 面板显示旧缓存/空,严格优于 107s 冻结。
 */
import { Worker } from 'node:worker_threads'
import type Database from 'better-sqlite3'
import type { StructureHole } from '@server/graph/structure-holes.js'
import { createLogger } from '@server/utils/logger.js'
import { getStructureHolesWorkerPath } from '../runtime/runtime-paths.js'

const log = createLogger('structure-holes-runner')

/** worker 硬超时:正常 50-200s,留足余量后强杀,防异常卡死。 */
const WORKER_TIMEOUT_MS = 5 * 60 * 1000

interface WorkerOutput {
  ok: boolean
  holes?: StructureHole[]
  error?: string
}

let inflight: Promise<StructureHole[]> | null = null
let activeWorker: Worker | null = null

function spawnAndCompute(dbPath: string): Promise<StructureHole[]> {
  const workerPath = getStructureHolesWorkerPath()
  return new Promise<StructureHole[]>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    let worker: Worker
    try {
      worker = new Worker(workerPath, { workerData: { dbPath } })
    } catch (err) {
      // 起 worker 本身就失败(路径错 / 打包问题):graceful reject,上层 skip。
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    activeWorker = worker

    const timer = setTimeout(() => {
      finish(() => {
        log.warn(`structure-holes worker 超时 ${WORKER_TIMEOUT_MS}ms,强制 terminate`)
        void worker.terminate()
        reject(new Error('structure-holes worker timeout'))
      })
    }, WORKER_TIMEOUT_MS)
    // 让 worker 超时计时器不挡进程退出。
    if (typeof timer.unref === 'function') timer.unref()

    worker.on('message', (msg: WorkerOutput) => {
      finish(() => {
        void worker.terminate()
        if (msg?.ok && Array.isArray(msg.holes)) resolve(msg.holes)
        else reject(new Error(msg?.error ?? 'structure-holes worker 返回异常'))
      })
    })
    worker.on('error', (err) => {
      finish(() => {
        void worker.terminate()
        reject(err)
      })
    })
    worker.on('exit', (code) => {
      finish(() => {
        if (code === 0) reject(new Error('structure-holes worker 退出但未返回结果'))
        else reject(new Error(`structure-holes worker 异常退出,code=${code}`))
      })
    })
  })
}

/**
 * 在 worker 里计算结构洞。single-flight:并发调用复用同一个 inflight Promise。
 * @param db 主线程的 better-sqlite3 连接,只用来取 db.name(DB 文件路径)传给 worker。
 */
export function runStructureHolesInWorker(db: Database.Database): Promise<StructureHole[]> {
  if (inflight) return inflight
  const dbPath = db.name
  inflight = spawnAndCompute(dbPath).finally(() => {
    inflight = null
    activeWorker = null
  })
  return inflight
}

/** 停 daemon / 退出时调用:强杀在跑的 worker,避免线程泄漏。 */
export function terminateStructureHolesWorker(): void {
  if (activeWorker) {
    void activeWorker.terminate()
    activeWorker = null
  }
}
