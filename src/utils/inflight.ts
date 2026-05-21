/**
 * Inflight 单例 helper:同名异步操作多个并发触发时,共享同一个 Promise,
 * 避免重复发请求 / 双跑 cron / 双触发 reconcile 等。
 *
 * LOW 12 (audit-10, 2026-05-21):
 *   仓库内已有 7 处手写 inflight pattern(每处 3-5 行,style 4 种):
 *     - pro/cloud-server/src/billing/downgrade-archive-cron.ts (`inflightSweep`)
 *     - pro/cloud-server/src/metabolism/worker.ts (`runningSweep`)
 *     - src/cloud/mcp-router.ts (`isOnlineInflight`)
 *     - client/electron/cloud/auth-client.ts (`refreshInflight`)
 *     - client/electron/cloud/sync-client.ts (`syncOnceInflight`)
 *     - src/integrations/notion/sync.ts (`fullScanInflight` 等)
 *     - src/integrations/shared/init-session.ts (`pending` map)
 *
 *   每处实现细节不一致(finally 时机 / 是否在 promise resolve 后才清空 /
 *   异常路径是否清空),容易出 bug。本 helper 提供统一实现,**新** callsite 用,
 *   现有 7 处暂不重构(working code,改动风险大;待发现问题再迁)。
 *
 * 设计要点:
 *   1) `run(factory)` 调多次,只在没 inflight 时 factory();已有时返回同一 promise。
 *   2) `finally` 清空 inflight — 不管 resolve 还是 reject,下一次 run 都能重启。
 *      跟"throw 后留着 inflight 让其他 caller 也吃同一错"是两种取舍;这里选
 *      "失败也清空,下一次重试" — 跟现有 7 处中 4 处的语义一致(其余 3 处是
 *      "失败也清"的反面 — auth-client 的 refresh,刻意 reject 后留着防雪崩;
 *      那种 case 需要的是 dedupe+throttle 双重语义,不在本 helper 覆盖范围)。
 *   3) factory 同步抛错也走 finally:用 `Promise.resolve().then(factory)` 包一层
 *      保证 inflight 一定被设置后再触发,清空逻辑统一在 finally。
 *
 * 用法:
 *   const sweepInflight = makeInflight<void>();
 *   await sweepInflight.run(async () => {
 *     await doSomethingSlow();
 *   });
 *
 *   // 并发 3 次:只有第一个真跑,后两个返回同一个 promise
 *   const [a, b, c] = await Promise.all([
 *     sweepInflight.run(() => doSomethingSlow()),
 *     sweepInflight.run(() => doSomethingSlow()),
 *     sweepInflight.run(() => doSomethingSlow()),
 *   ]);
 *   // a === b === c (同 promise)
 */
export interface Inflight<T> {
  /** 当前是否有 inflight 任务(测试用,业务代码不应依赖) */
  readonly isRunning: boolean;
  /**
   * 若已有 inflight 任务 → 返回同一个 promise;否则启动新任务。
   * factory 同步抛错也会被 catch,reject 后清空 inflight。
   */
  run(factory: () => Promise<T>): Promise<T>;
}

export function makeInflight<T>(): Inflight<T> {
  let current: Promise<T> | null = null;
  return {
    get isRunning(): boolean {
      return current !== null;
    },
    run(factory: () => Promise<T>): Promise<T> {
      if (current) return current;
      // Promise.resolve().then 确保 factory 同步抛错也走 finally
      current = Promise.resolve()
        .then(() => factory())
        .finally(() => {
          current = null;
        });
      return current;
    },
  };
}
