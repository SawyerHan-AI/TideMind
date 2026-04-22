/**
 * elicit-helper — 封装 MCP elicitation 调用 + 能力检测 + 节流 + 用户交互模式开关
 *
 * 设计背景：
 *   MCP 2025-06-18 spec 引入 elicitation（server 可以在工具处理中请求用户输入），
 *   Claude Code 作为 client 支持 form / url 两种模式。我们在 brain_digest 遇到
 *   归类模糊的决策点（比如 intent=correction 但 target_node 不存在，或未给 target）
 *   时 elicit 用户，让外脑不再"替用户猜"。
 *
 * 本模块只提供能力层，不决定在哪些决策点调用——调用点在 tools/digest.ts 里选。
 *
 * 默认 silent：
 *   用户的 config.digest.interactive_mode 默认 "silent"，本 helper 对任何请求
 *   直接返回 null（表示未发起），调用方走 fallback 路径。用户手动切 "ask"
 *   （或未来通过 UI 开关）后本 helper 才真正调用 elicitInput。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ElicitResult, ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('elicit');

// 节流：同一 topicKey 在窗口内只 elicit 一次，避免用户被重复打扰
const THROTTLE_WINDOW_MS = 10 * 60 * 1000; // 10 分钟
const lastElicitAt = new Map<string, number>();

/**
 * 尝试向客户端发起 elicit 请求。
 *
 * 以下情况返回 `null`（表示未发起，调用方应走 fallback）：
 *   1) server 未提供（例如单元测试或非 MCP 上下文）
 *   2) config.digest.interactive_mode === "silent"
 *   3) client 未声明 elicitation.form capability
 *   4) 同 topicKey 在节流窗口内（10 分钟）已 elicit 过一次
 *   5) elicitInput 抛错（capability 声称支持但实际失败）
 *
 * 发起成功时返回 client 的 ElicitResult（action 为 accept/decline/cancel）。
 */
export async function tryElicit(
  server: McpServer | undefined,
  topicKey: string,
  params: ElicitRequestFormParams,
): Promise<ElicitResult | null> {
  if (!server) {
    log.debug(`skip(no-server) topic=${topicKey}`);
    return null;
  }

  // 用户开关：默认 silent，完全绕过 elicit
  let mode: 'silent' | 'ask';
  try {
    mode = getConfig().digest?.interactive_mode ?? 'silent';
  } catch {
    // getConfig 未初始化时（比如测试环境）按 silent 处理
    mode = 'silent';
  }
  if (mode === 'silent') {
    log.debug(`skip(silent-mode) topic=${topicKey}`);
    return null;
  }

  // Capability 检测：Claude Code 会在 initialize 时声明 elicitation.form
  // 不支持的客户端直接 fallback，不要让 elicitInput 抛错污染日志
  const caps = server.server.getClientCapabilities();
  if (!caps?.elicitation?.form) {
    log.info(`skip(capability-unsupported) topic=${topicKey}`);
    return null;
  }

  // 节流：同一 topicKey 短期内反复 elicit 会骚扰用户。
  // 惰性清理过期条目，避免 Electron 长期运行时 Map 无限增长
  //（topicKey 含 target_node 等用户可输入 ID，种类没有上限）
  const now = Date.now();
  for (const [k, t] of lastElicitAt) {
    if (now - t >= THROTTLE_WINDOW_MS) lastElicitAt.delete(k);
  }
  const last = lastElicitAt.get(topicKey);
  if (last && now - last < THROTTLE_WINDOW_MS) {
    log.debug(`skip(throttled) topic=${topicKey} elapsed=${now - last}ms`);
    return null;
  }
  lastElicitAt.set(topicKey, now);

  try {
    const result = await server.server.elicitInput(params);
    log.info(`elicit topic=${topicKey} action=${result.action}`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`elicit failed topic=${topicKey} err=${msg}`);
    return null;
  }
}

/**
 * 仅供测试使用：重置节流窗口
 */
export function resetElicitThrottle(): void {
  lastElicitAt.clear();
}
