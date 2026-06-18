/**
 * Reconciler 全局互斥 + abort 入口(单实例)。
 *
 * 约束:reconcile 是收敛/幂等的,但两个 Reconciler 实例并发跑会:
 *   - 交错 bulk-upsert / bulk-fetch 同一批数据,重复多分钟的网络 + DB 负载
 *   - 同时写同一组 metadata key(last_reconcile_at_* / status / error),终态取决于交错顺序
 *   - 同时向 'reconcile-progress' channel 发进度,UI 进度条在两台状态机间跳变
 *
 * 触发并发的两条路径:
 *   - 自动:sync-client.maybeTriggerReconcile(启动 10s 后,7 天 stale)
 *   - 手动:cloud:force-reconcile(设置页"强制对齐")
 * 原实现的互斥只在 ipc/cloud.ts 的手动 handler 里(模块私有 activeReconciler),
 * 自动路径完全绕过,且 cloud:abort-reconcile 对自动实例返回 not_running 无法中止。
 *
 * 本模块把互斥/注册/abort 下沉为进程级单一入口,两条路径都走 runExclusive,
 * 保证全局至多一个 reconciler 在跑,abort 能命中任意来源的实例。
 */

import type { Reconciler } from './reconciler.js';

/** 当前持锁的来源标记(非空即表示有 reconcile 在跑或正在准备跑)。 */
let running = false;
/** 已注册的真实 Reconciler 实例(runner 内部创建后回填),供 abort 命中。 */
let active: Reconciler | null = null;
/** 占位期(running=true 但 active 未回填)收到的 abort 请求,待实例注册后补发。 */
let pendingAbort = false;

/** 是否有 reconcile 正在跑(含尚未注册实例的准备阶段)。 */
export function isReconcileRunning(): boolean {
  return running;
}

/**
 * 在全局互斥下跑一个 reconciler。已有 reconcile 在跑时返回 already_running,
 * 不创建第二个实例。runner 内自行创建 Reconciler 并通过 register 回填,
 * 让 abort 能命中;跑完(成功/失败)一定释放锁。
 */
export async function runExclusive<T>(
  runner: (register: (r: Reconciler) => void) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: 'already_running' }> {
  if (running) return { ok: false, error: 'already_running' };
  running = true;
  active = null;
  pendingAbort = false;
  try {
    return {
      ok: true,
      value: await runner((r) => {
        active = r;
        // 占位期已请求 abort → 实例一注册立即补发,避免 abort 被静默吞掉。
        if (pendingAbort) {
          try { r.abort(); } catch { /* noop */ }
        }
      }),
    };
  } finally {
    running = false;
    active = null;
    pendingAbort = false;
  }
}

/**
 * 中止当前正在跑的 reconcile(若有)。abort 只在当前 batch 结束后生效(非立即)。
 * 返回是否真有 reconcile 在跑(可被 abort)。
 */
export function abortActiveReconcile(): boolean {
  if (!running) return false;
  if (active) {
    try { active.abort(); } catch { /* noop */ }
  } else {
    // 实例还没注册(runner 在第一个 await 之前):记下 abort,等 register 时补发。
    pendingAbort = true;
  }
  return true;
}
