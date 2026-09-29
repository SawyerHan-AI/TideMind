import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
  isProcessGroupAlive,
  signalProcessGroupId,
  waitForProcessGroupExit,
} from './child-process-runner.js';
import { cliProcessRegistry } from './runtime-process-registry.js';
import { CliLLMError } from './errors.js';
import { sanitizeCliEnvironment } from './environment.js';
import { createCliRuntimeDirectory } from './runtime-dir.js';
import { assertResolvedCliIdentity } from './resolve-cli.js';
import type { CliCatalogModel, ResolvedCli } from './types.js';

/**
 * Codex app-server 只读元数据会话。
 *
 * P0 证据（docs/design/adaptive-agent-compatibility-and-model-discovery-p0-cli-evidence-2026-09-25.md）：
 * - 只允许 initialize / account/read / model/list 三个方法，不创建 thread，不发送生成 prompt；
 * - account/read 必须显式 refreshToken:false，不触发凭据刷新；
 * - app-server 不支持 --ignore-user-config，因此用 -c 覆盖 MCP/Hook/插件/Apps/Web 搜索；
 * - npm wrapper 会再 spawn 原生二进制，结束时必须终止整个进程组。
 *
 * 上游响应按不可信输入处理：单行/总字节、页数、条目数和总时长都有上限；任何形状
 * 不符、分页循环、超限都使整个目录读取失败，不能返回“成功的空目录”。
 */

const ALLOWED_METHODS = new Set(['initialize', 'account/read', 'model/list']);
const METADATA_OVERRIDES = [
  '-c', 'mcp_servers={}',
  '-c', 'hooks={}',
  '-c', 'notify=[]',
  '-c', 'plugins={}',
  '-c', 'apps={}',
  '-c', 'marketplaces={}',
  '-c', 'web_search="disabled"',
] as const;

export const CODEX_METADATA_LIMITS = Object.freeze({
  budgetMs: 10_000,
  maxPages: 20,
  pageSize: 50,
  maxModels: 500,
  maxLineBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
});

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

export type CodexAccountSnapshot =
  | { kind: 'chatgpt'; accountId: string | null; email: string | null; planType: string | null }
  | { kind: 'api_key' }
  | { kind: 'other'; type: string }
  | { kind: 'none'; requiresOpenaiAuth: boolean };

export interface CodexMetadataResult {
  /** null: the CLI does not implement account/read (older protocol). */
  account: CodexAccountSnapshot | null;
  /** Second account read taken after model/list; only present when models were requested. */
  accountAfter: CodexAccountSnapshot | null;
  /** null: the CLI does not implement model/list (older protocol). */
  models: CliCatalogModel[] | null;
}

export interface CodexMetadataOptions {
  resolved: ResolvedCli;
  dataDir: string;
  includeModels: boolean;
  sourceEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  limits?: Partial<typeof CODEX_METADATA_LIMITS>;
  /** Test seam. */
  spawnImpl?: typeof spawn;
}

class MethodNotFound extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // Strip control characters; display strings come from an untrusted process.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, max) : null;
}

export function parseCodexAccount(result: unknown): CodexAccountSnapshot {
  const root = record(result);
  if (!root) throw new CliLLMError('protocol', 'Codex account/read returned an invalid result');
  const account = record(root.account);
  if (!account) {
    return { kind: 'none', requiresOpenaiAuth: root.requiresOpenaiAuth === true };
  }
  const type = typeof account.type === 'string' ? account.type : '';
  if (type === 'apiKey') return { kind: 'api_key' };
  if (type !== 'chatgpt') return { kind: 'other', type: type.slice(0, 64) || 'unknown' };
  const routing = record(root.workspaceRouting);
  const accountId = boundedString(routing?.chatgptAccountId, 256);
  const email = boundedString(account.email, 320);
  const planType = boundedString(account.planType, 64);
  return { kind: 'chatgpt', accountId, email: email?.toLowerCase() ?? null, planType };
}

export function parseCodexModelPage(
  result: unknown,
): { models: CliCatalogModel[]; nextCursor: string | null } {
  const root = record(result);
  if (!root || !Array.isArray(root.data)) {
    throw new CliLLMError('protocol', 'Codex model/list returned an invalid page');
  }
  const models: CliCatalogModel[] = [];
  for (const raw of root.data) {
    const item = record(raw);
    if (!item) throw new CliLLMError('protocol', 'Codex model/list returned an invalid item');
    const id = typeof item.id === 'string' ? item.id : '';
    const model = typeof item.model === 'string' ? item.model : '';
    if (!MODEL_ID.test(id) || !MODEL_ID.test(model)) {
      throw new CliLLMError('protocol', 'Codex model/list returned an unsafe model identifier');
    }
    if (typeof item.isDefault !== 'boolean' || typeof item.hidden !== 'boolean') {
      throw new CliLLMError('protocol', 'Codex model/list item is missing required flags');
    }
    const upgradeInfo = record(item.upgradeInfo);
    const upgrade = typeof item.upgrade === 'string' && MODEL_ID.test(item.upgrade)
      ? item.upgrade
      : null;
    const retirementAt = typeof upgradeInfo?.retirementAt === 'number'
      && Number.isFinite(upgradeInfo.retirementAt)
      ? upgradeInfo.retirementAt
      : null;
    const efforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts
        .map((entry) => {
          const value = typeof entry === 'string' ? entry : record(entry)?.reasoningEffort;
          return typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : null;
        })
        .filter((value): value is string => value !== null)
        .slice(0, 16)
      : [];
    models.push({
      id,
      invocationId: model,
      displayName: boundedString(item.displayName, 120) ?? id,
      kind: 'model',
      isDefault: item.isDefault,
      hidden: item.hidden,
      upgrade,
      retirementAt,
      reasoningEfforts: efforts,
    });
  }
  const next = root.nextCursor;
  if (next !== null && next !== undefined && (typeof next !== 'string' || next.length > 4096)) {
    throw new CliLLMError('protocol', 'Codex model/list returned an invalid cursor');
  }
  return { models, nextCursor: typeof next === 'string' && next.length > 0 ? next : null };
}

/**
 * Run one bounded metadata session against the exact resolved Codex CLI.
 * Throws CliLLMError on transport/protocol failure; never returns partial models.
 */
export async function readCodexMetadata(options: CodexMetadataOptions): Promise<CodexMetadataResult> {
  const limits = { ...CODEX_METADATA_LIMITS, ...options.limits };
  if (options.resolved.kind !== 'codex') throw new Error('Codex metadata requires the codex CLI');
  await assertResolvedCliIdentity(options.resolved);
  cliProcessRegistry.assertAccepting();
  const runtime = createCliRuntimeDirectory(options.dataDir, `meta_${randomUUID()}`);
  const spawnImpl = options.spawnImpl ?? spawn;
  const releaseAdmission = cliProcessRegistry.beginAdmission();
  let child: ChildProcessWithoutNullStreams;
  try { child = spawnImpl(
    options.resolved.path,
    ['app-server', '--listen', 'stdio://', ...METADATA_OVERRIDES],
    {
      cwd: runtime.invocationDir,
      env: sanitizeCliEnvironment(
        options.sourceEnv ?? process.env,
        options.resolved.path,
        options.resolved.controlledPath,
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      shell: false,
    },
  ) as ChildProcessWithoutNullStreams;
    cliProcessRegistry.registerAdmitted(child);
  } catch (error) { runtime.cleanup(); throw error; } finally { releaseAdmission(); }

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 0;
  let buffer = '';
  let totalBytes = 0;
  let fatal: Error | null = null;
  const decoder = new StringDecoder('utf8');

  const fail = (error: Error): void => {
    if (fatal) return;
    fatal = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  child.stdout.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > limits.maxTotalBytes) {
      fail(new CliLLMError('output_limit', 'Codex metadata output exceeded its limit'));
      return;
    }
    buffer += decoder.write(chunk);
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown> | null;
      try {
        message = record(JSON.parse(line));
      } catch {
        fail(new CliLLMError('protocol', 'Codex metadata returned malformed JSON'));
        return;
      }
      if (!message) continue;
      if (typeof message.id === 'number' && pending.has(message.id) && !('method' in message)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        const error = record(message.error);
        if (error) {
          if (error.code === -32601) waiter.reject(new MethodNotFound('method not found'));
          else waiter.reject(new CliLLMError(
            'protocol',
            `Codex metadata request failed${typeof error.message === 'string' ? `: ${error.message.slice(0, 200)}` : ''}`,
          ));
        } else {
          waiter.resolve(message.result);
        }
        continue;
      }
      if (typeof message.method === 'string' && message.id !== undefined) {
        // A server-initiated request (approval, elicitation, …). Metadata sessions never
        // grant anything; refuse explicitly so the server cannot wait on us.
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'not supported by metadata session' },
        })}\n`);
      }
      // Notifications are ignored.
    }
    if (buffer.length > limits.maxLineBytes) {
      fail(new CliLLMError('output_limit', 'Codex metadata line exceeded its limit'));
    }
  });
  child.stderr.on('data', () => {
    // stderr is diagnostic only; never parsed and never persisted.
  });
  child.on('error', (error) => fail(new CliLLMError('process_crash', 'Codex metadata process failed', { cause: error })));
  child.on('close', () => fail(new CliLLMError('process_crash', 'Codex metadata process exited early')));

  const request = (method: string, params: unknown): Promise<unknown> => {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`metadata method not allowed: ${method}`);
    if (fatal) return Promise.reject(fatal);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const onAbort = (): void => fail(new CliLLMError('aborted', 'Codex metadata refresh was cancelled'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => fail(new CliLLMError('timeout', 'Codex metadata refresh timed out')),
    limits.budgetMs,
  );

  const readAccount = async (): Promise<CodexAccountSnapshot | null> => {
    try {
      return parseCodexAccount(await request('account/read', { refreshToken: false }));
    } catch (error) {
      if (error instanceof MethodNotFound) return null;
      throw error;
    }
  };

  try {
    if (options.signal?.aborted) onAbort();
    await request('initialize', {
      clientInfo: { name: 'tidemind', title: 'Tide Mind', version: '1' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    const account = await readAccount();
    if (!options.includeModels) return { account, accountAfter: null, models: null };

    const models: CliCatalogModel[] = [];
    const seenCursors = new Set<string>();
    const seenIds = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let supported = true;
    do {
      if (++pages > limits.maxPages) {
        throw new CliLLMError('protocol', 'Codex model/list exceeded its page limit');
      }
      let page: { models: CliCatalogModel[]; nextCursor: string | null };
      try {
        page = parseCodexModelPage(await request('model/list', {
          cursor,
          limit: limits.pageSize,
          includeHidden: false,
        }));
      } catch (error) {
        if (error instanceof MethodNotFound && pages === 1) {
          supported = false;
          break;
        }
        throw error instanceof MethodNotFound
          ? new CliLLMError('protocol', 'Codex model/list disappeared mid-pagination')
          : error;
      }
      for (const model of page.models) {
        if (seenIds.has(model.id)) {
          throw new CliLLMError('protocol', 'Codex model/list returned a duplicate model');
        }
        seenIds.add(model.id);
        models.push(model);
        if (models.length > limits.maxModels) {
          throw new CliLLMError('output_limit', 'Codex model/list exceeded its item limit');
        }
      }
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          throw new CliLLMError('protocol', 'Codex model/list cursor loop detected');
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== null);
    const accountAfter = await readAccount();
    return { account, accountAfter, models: supported ? models : null };
  } catch (error) {
    if (error instanceof MethodNotFound) {
      throw new CliLLMError('unsupported_version', 'Codex app-server does not support metadata initialization');
    }
    throw fatal ?? error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    const group = child.pid;
    if (group && group > 0 && process.platform !== 'win32') {
      signalProcessGroupId(group, 'SIGTERM');
      await waitForProcessGroupExit(group, 500);
      if (isProcessGroupAlive(group)) {
        signalProcessGroupId(group, 'SIGKILL');
        await waitForProcessGroupExit(group, 500);
      }
    } else {
      child.kill('SIGKILL');
    }
    await cliProcessRegistry.unregister(child);
    try {
      runtime.cleanup();
    } catch {
      // Stale private directories are reclaimed at startup.
    }
  }
}
