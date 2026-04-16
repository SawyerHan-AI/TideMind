import type { IRepository } from '../../../src/db/repository.js';
import type Database from 'better-sqlite3';
import { createLogger } from '../../../src/utils/logger.js';
import { isLoggedIn, getCloudBaseUrl, refreshTokenIfNeeded } from './auth-client.js';
import { enqueueOutbox } from './outbox.js';
import { getConfig } from '../../../src/config.js';

const log = createLogger('cloud-router');

let onlineCache: { value: boolean; checkedAt: number } = { value: false, checkedAt: 0 };

export class CloudMcpRouter {
  constructor(private localRepo: IRepository, private db: Database.Database) {}

  isActive(): boolean {
    const config = getConfig();
    return (config.cloud?.enabled ?? false) && isLoggedIn();
  }

  async isOnline(): Promise<boolean> {
    if (Date.now() - onlineCache.checkedAt < 10000) return onlineCache.value;
    try {
      const base = getCloudBaseUrl();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${base}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      onlineCache = { value: res.ok, checkedAt: Date.now() };
    } catch {
      onlineCache = { value: false, checkedAt: Date.now() };
    }
    return onlineCache.value;
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
