import type { IRepository } from '../../../src/db/repository.js';
import type Database from 'better-sqlite3';
import { createLogger } from '../../../src/utils/logger.js';
import { isLoggedIn, getCloudBaseUrl, refreshTokenIfNeeded } from './auth-client.js';
import { enqueueOutbox } from './outbox.js';
import { getConfig } from '../../../src/config.js';

const log = createLogger('cloud-router');

let onlineCache: { value: boolean; checkedAt: number } = { value: false, checkedAt: 0 };
// F7 (audit-7): 同一进程多个 tool 并发到 `handle()` 会同时调 isOnline,
// 缓存未命中时各自起一个 fetch,造成 cache stampede(每个 MCP 调用一次 /health)。
// inflight Promise 复用第一个还在进行中的探测,等待它结束。
let inflightHealthCheck: Promise<boolean> | null = null;

export class CloudMcpRouter {
  constructor(private localRepo: IRepository, private db: Database.Database) {}

  isActive(): boolean {
    const config = getConfig();
    return (config.cloud?.enabled ?? false) && isLoggedIn();
  }

  async isOnline(): Promise<boolean> {
    if (Date.now() - onlineCache.checkedAt < 10000) return onlineCache.value;
    if (inflightHealthCheck) return inflightHealthCheck;
    inflightHealthCheck = (async () => {
      try {
        const base = getCloudBaseUrl();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await fetch(`${base}/health`, { signal: controller.signal });
          onlineCache = { value: res.ok, checkedAt: Date.now() };
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        onlineCache = { value: false, checkedAt: Date.now() };
      }
      return onlineCache.value;
    })().finally(() => {
      inflightHealthCheck = null;
    });
    return inflightHealthCheck;
  }

  async handle(toolName: string, args: Record<string, unknown>): Promise<object> {
    const online = await this.isOnline();

    if (online) {
      return this.forwardToCloud(toolName, args);
    } else {
      return this.handleOffline(toolName, args);
    }
  }

  private async forwardToCloud(toolName: string, args: Record<string, unknown>): Promise<object> {
    const token = await refreshTokenIfNeeded();
    if (!token) return this.handleOffline(toolName, args);

    const base = getCloudBaseUrl();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    });

    if (!res.ok) {
      log.warn(`cloud MCP failed (${res.status}), falling back to local`);
      return this.handleOffline(toolName, args);
    }

    const data = await res.json();
    if (data.error) {
      log.warn(`cloud MCP error: ${data.error.message}`);
      return this.handleOffline(toolName, args);
    }

    // Extract the tool result content
    return data.result;
  }

  private async handleOffline(toolName: string, args: Record<string, unknown>): Promise<object> {
    log.info(`offline mode: ${toolName}`);

    if (toolName === 'brain_digest') {
      // Enqueue to outbox for later sync
      const id = enqueueOutbox(this.db, 'digest', args);
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'queued', message: '已暂存，联网后同步', outbox_id: id }) }],
      };
    }

    // For prepare and recall, delegate to local repo (already handled by index.ts localHandler)
    // Return a structured error so callers can detect and fall back to the local handler.
    return {
      error: 'offline',
      message: 'Cloud sync is offline. Please check your connection.',
    };
  }
}
