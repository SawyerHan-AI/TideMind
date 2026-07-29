const activeBackgroundWork = new Set<Promise<unknown>>();

/**
 * 跟踪进程内明确允许脱离请求返回的后台任务，使 shutdown 能在关库前排空它们。
 */
export function trackBackgroundWork<T>(work: Promise<T>): Promise<T> {
  activeBackgroundWork.add(work);
  void work.finally(() => {
    activeBackgroundWork.delete(work);
  }).catch(() => {
    // 原 promise 的调用方负责错误处理；这里只消费 finally 派生 promise。
  });
  return work;
}

export async function waitForBackgroundWork(): Promise<void> {
  while (activeBackgroundWork.size > 0) {
    await Promise.allSettled([...activeBackgroundWork]);
  }
}

export const __testing = {
  size: (): number => activeBackgroundWork.size,
};
