/**
 * 用户自定义 strategy prompt 上云推送(silent)
 *
 * 触发点: client/electron/ipc/config.ts 的 strategy update IPC handler 写文件
 *   成功后调用本模块的 schedulePush(name, content)。
 *
 * 设计取舍:
 *   - **silent**: 不阻塞 IPC return,不抛错给前端。用户编辑 prompt 只关心文件是否
 *     写成功;云端同步是后台行为。
 *   - **fire-and-forget + per-name 串行**: 同一 strategy 短时间多次编辑(常见 —
 *     用户连续保存)只保留最后一次,避免堆 N 个 in-flight 请求。
 *   - **门控**: 未开 sync_enabled 或未登录直接返回;不消耗任何资源。
 *   - **不重试**: 这只是 prompt 同步,云端没收到就用 default,产品体验只是
 *     "云端用默认 prompt"。不值得引入 retry / 持久化 outbox 复杂度。
 *     用户下一次保存会自动重试。
 *
 * 限制: 只推 *.system.md;.user.md / .params.md 不在本通道范围内(云端代谢
 *   目前只用 system prompt)。
 */

import { getConfig } from '../../../src/config.js';
import { createLogger } from '../../../src/utils/logger.js';

const log = createLogger('cloud-strategy-push');

// 同一 strategy 同时只允许 1 个 in-flight,新请求覆盖等待中的旧值
const pending = new Map<string, { content: string; inFlight: Promise<void> | null }>();

/**
 * silent push 用户自定义 prompt 到云端。
 *
 * 调用方在 IPC handler 写文件成功后直接 `schedulePush(name, content)` 即可,
 * 无需 await(本函数同步入队,实际网络 IO 在 microtask 队列后执行)。
 *
 * @param strategyName 策略 base name(不含 .system.md 后缀)
 * @param content 文件最新内容
 */
export function schedulePush(strategyName: string, content: string): void {
  // 门控:cloud.sync_enabled 关 / 未登录 → 直接 return,不查文件不发包
  try {
    const config = getConfig();
    if (!config.cloud?.sync_enabled) return;
  } catch {
    return;
  }

  const existing = pending.get(strategyName);
  if (existing && existing.inFlight) {
    // 有 in-flight,只更新待发送的 content,inFlight 完成后会读这个新值再发。
    existing.content = content;
    return;
  }

  // 启动新的 in-flight
  const slot = { content, inFlight: null as Promise<void> | null };
  pending.set(strategyName, slot);
  slot.inFlight = runPushLoop(strategyName, slot).finally(() => {
    // 完成后清表项,下一次 schedulePush 再起。但如果 loop 中有新内容被覆盖,
    // runPushLoop 内部已经会自循环,所以这里只有真正"无新内容"时才会到这。
    pending.delete(strategyName);
  });
}

/**
 * 拉一个 push 循环:发完一次后如果 slot.content 又被更新了,自动再发一次。
 * 这样保证"用户连续保存 5 次"最终云端拿到的是最后那一次,而不是中间随机一次。
 */
async function runPushLoop(
  strategyName: string,
  slot: { content: string; inFlight: Promise<void> | null },
): Promise<void> {
  // 最多重试 3 次同步循环(防御无限循环 — 不该发生,但保险)
  for (let i = 0; i < 3; i++) {
    const snapshot = slot.content;
    try {
      await pushOnce(strategyName, snapshot);
    } catch (err) {
      log.warn(`push ${strategyName} failed: ${(err as Error).message}`);
      // silent — 不抛,不重试
      return;
    }
    // 发完后如果 content 没变 → 真的完成,退出
    if (slot.content === snapshot) return;
    // 否则继续 loop 再发一次最新的
  }
  log.warn(`push ${strategyName}: too many in-flight content updates, dropping`);
}

async function pushOnce(strategyName: string, content: string): Promise<void> {
  // 动态 import,避免模块加载时强依赖 auth-client(测试 / 启动早期场景)
  const { getCloudAuth, getCloudBaseUrl, refreshTokenIfNeeded, isLoggedIn } =
    await import('./auth-client.js');

  if (!isLoggedIn() || !getCloudAuth()) {
    log.debug(`push ${strategyName}: not logged in`);
    return;
  }

  let token: string | null;
  try {
    token = await refreshTokenIfNeeded();
  } catch (err) {
    // refresh 暂时性失败(网络) → silent skip;下次保存会重试
    log.debug(`push ${strategyName}: token refresh transient failure: ${(err as Error).message}`);
    return;
  }
  if (!token) {
    log.debug(`push ${strategyName}: no token (login expired)`);
    return;
  }

  const base = getCloudBaseUrl();
  const url = `${base}/api/v1/strategy/upload`;

  // 加 8s timeout,strategy upload 应该秒级返回;超时直接放弃。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ strategy_name: strategyName, content }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn(`push ${strategyName} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return;
    }
    log.debug(`push ${strategyName} ok (len=${content.length})`);
  } finally {
    clearTimeout(timer);
  }
}
