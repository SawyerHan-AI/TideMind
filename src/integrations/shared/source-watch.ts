export type WatcherChangeDecision = 'process' | 'retry' | 'skip' | 'drop';

/**
 * Retry 次数上界。lock 持续 30 次（默认 30s）仍未释放就放弃当前事件，
 * 避免极端情况下 watcher 自我入队 1Hz 永久消耗 CPU 与日志。下一次文件变化
 * 仍会重新触发，正常恢复后立刻能跟上。
 */
export const MAX_WATCHER_LOCK_RETRIES = 30;

export function decideWatcherChange(opts: {
  sourceActive: boolean;
  fileExists: boolean;
  sourceLocked: boolean;
  attempts?: number;
}): WatcherChangeDecision {
  if (!opts.sourceActive) return 'skip';
  if (!opts.fileExists) return 'skip';
  if (opts.sourceLocked) {
    if ((opts.attempts ?? 0) >= MAX_WATCHER_LOCK_RETRIES) return 'drop';
    return 'retry';
  }
  return 'process';
}
