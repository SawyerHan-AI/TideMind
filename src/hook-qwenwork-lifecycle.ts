#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { fstatSync, readFileSync } from 'node:fs';
import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { recordHookActivityEvidence } from './db/agent-host-activity.js';
import { SqliteRepository } from './db/sqlite-repository.js';
import {
  formatQwenWorkLifecycleHookOutput,
  parseQwenWorkLifecycleHookMetadata,
  type QwenWorkLifecycleHookEvent,
} from './hook-qwenwork-protocol.js';
import { assembleSessionContext, formatProfileSection, formatRestSections } from './hook-session-format.js';
import { prepare } from './tools/prepare.js';
import { getTideMindVersion } from './utils/app-version.js';
import { createLogger } from './utils/logger.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';

const STDIN_TIMEOUT_MS = 2_000;
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const migrationLog = createLogger('migrate');

export const QWENWORK_PRE_COMPACT_CONTEXT = `[TIDE MIND — PRE-COMPACT CHECK]

上下文即将被压缩。请检查本轮对话中是否有尚未 brain_digest 的重要信息——
用户表达的观点、做出的决策、讨论产生的洞察、被否定的方案、对某话题的态度变化等，
如有请立刻 digest 沉淀到外脑，否则会随摘要流失。`;

interface QwenWorkHookArgs {
  event: QwenWorkLifecycleHookEvent;
  agentId: string;
  skillPath: string | null;
  skillSha256: string | null;
  activityGenerationToken: string;
}

function parseArgs(): QwenWorkHookArgs {
  const argv = process.argv.slice(2);
  let event: QwenWorkLifecycleHookEvent | null = null;
  let agentId = '';
  let skillPath: string | null = null;
  let skillSha256: string | null = null;
  let activityGenerationToken = '';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--event' && argv[index + 1]) {
      const candidate = argv[index + 1];
      if (candidate === 'SessionStart' || candidate === 'PreCompact' || candidate === 'SessionEnd') event = candidate;
      index += 1;
    } else if (value === '--agent-id' && argv[index + 1]) {
      agentId = argv[index + 1];
      index += 1;
    } else if (value === '--skill-path' && argv[index + 1]) {
      skillPath = argv[index + 1];
      index += 1;
    } else if (value === '--skill-sha256' && argv[index + 1]) {
      skillSha256 = argv[index + 1];
      index += 1;
    } else if (value === '--activity-generation-token' && argv[index + 1]) {
      activityGenerationToken = argv[index + 1];
      index += 1;
    }
  }
  if (!event) throw new Error('qwenwork_hook_event_missing');
  if (!agentId.trim()) throw new Error('qwenwork_hook_agent_id_missing');
  if (!activityGenerationToken.trim()) throw new Error('qwenwork_hook_activity_generation_token_missing');
  if (event === 'SessionStart' && !skillPath) throw new Error('qwenwork_hook_skill_path_missing');
  if (event === 'SessionStart' && !skillSha256?.match(/^[a-f0-9]{64}$/u)) {
    throw new Error('qwenwork_hook_skill_sha256_missing');
  }
  return { event, agentId, skillPath, skillSha256, activityGenerationToken };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('qwenwork_hook_input_missing');
  try {
    const stat = fstatSync(0);
    if (stat.isFile()) {
      if (stat.size > MAX_STDIN_BYTES) throw new Error('qwenwork_hook_input_too_large');
      const source = readFileSync(0, 'utf8');
      if (!source.trim()) throw new Error('qwenwork_hook_input_missing');
      return source;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('qwenwork_hook_input_')) throw error;
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      try { process.stdin.pause(); } catch { /* best effort */ }
      if (error) reject(error);
      else {
        const source = Buffer.concat(chunks).toString('utf8');
        if (!source.trim()) reject(new Error('qwenwork_hook_input_missing'));
        else resolve(source);
      }
    };
    const timer = setTimeout(() => finish(new Error('qwenwork_hook_input_timeout')), STDIN_TIMEOUT_MS);
    timer.unref?.();
    process.stdin.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STDIN_BYTES) finish(new Error('qwenwork_hook_input_too_large'));
      else chunks.push(chunk);
    });
    process.stdin.on('end', () => finish());
    process.stdin.on('error', () => finish(new Error('qwenwork_hook_input_failed')));
  });
}

function readVerifiedSkill(skillPath: string, expectedSha256: string): string {
  const bytes = readFileSync(skillPath);
  const observedSha256 = createHash('sha256').update(bytes).digest('hex');
  if (observedSha256 !== expectedSha256) throw new Error('qwenwork_hook_skill_hash_mismatch');
  let content = bytes.toString('utf8');
  if (content.startsWith('---')) {
    const end = content.indexOf('---', 3);
    if (end !== -1) content = content.slice(end + 3).trim();
  }
  return content;
}

async function buildSessionStartContext(
  agentId: string,
  skillPath: string,
  skillSha256: string,
  source: string,
): Promise<{ context: string; skillVerified: boolean }> {
  let skillContent: string;
  let skillVerified = false;
  try {
    skillContent = readVerifiedSkill(skillPath, skillSha256);
    skillVerified = true;
  } catch (error) {
    process.stderr.write(`[eb:hook-qwenwork-lifecycle] skill unavailable — ${message(error)}\n`);
    skillContent = '（Skill 文件读取或完整性校验失败，请通过记忆工具 brain_prepare/recall/digest 与 Tide Mind 交互）';
  }
  if (source === 'clear') {
    return {
      context: assembleSessionContext({
        skillContent,
        profileSection: '',
        restSection: '（/clear 已执行，用户上下文已在本 session 内保留，无需重新加载）',
      }),
      skillVerified,
    };
  }
  try {
    loadConfig();
    ensureDataDirs();
    const result = await prepare(new SqliteRepository(getDb()), {
      tool: 'qwenwork',
      agent_id: agentId,
      detail_level: 'standard',
    });
    return {
      context: assembleSessionContext({
        skillContent,
        profileSection: formatProfileSection(result),
        restSection: formatRestSections(result),
      }),
      skillVerified,
    };
  } catch (error) {
    process.stderr.write(`[eb:hook-qwenwork-lifecycle] prepare failed — ${message(error)}\n`);
    return {
      context: assembleSessionContext({
        skillContent,
        profileSection: '',
        restSection: '（用户上下文加载失败，请手动调用 brain_prepare 工具）',
      }),
      skillVerified,
    };
  } finally {
    try { closeDb(); } catch { /* best effort */ }
  }
}

function signalFor(event: QwenWorkLifecycleHookEvent): 'session_start' | 'pre_compact' | 'session_end' {
  if (event === 'SessionStart') return 'session_start';
  if (event === 'PreCompact') return 'pre_compact';
  return 'session_end';
}

function recordActivity(args: QwenWorkHookArgs): void {
  try {
    loadConfig();
    ensureDataDirs();
    const result = recordHookActivityEvidence(getDb(), {
      agentId: args.agentId,
      tool: 'qwenwork',
      signalName: signalFor(args.event),
      tideMindVersion: getTideMindVersion(),
      activityGenerationToken: args.activityGenerationToken,
    });
    if (result.status === 'rejected') {
      process.stderr.write(`[eb:hook-qwenwork-lifecycle] activity evidence rejected — ${result.reason}\n`);
    }
  } catch (error) {
    process.stderr.write(`[eb:hook-qwenwork-lifecycle] activity evidence unavailable — ${message(error)}\n`);
  } finally {
    try { closeDb(); } catch { /* best effort */ }
  }
}

class StdoutDeliveryError extends Error {
  constructor(cause: Error) {
    super(`qwenwork_hook_stdout_delivery_failed:${cause.message}`, { cause });
    this.name = 'StdoutDeliveryError';
  }
}

/** Resolve only after Node confirms the write callback and drain when buffered. */
function writeStdout(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let callbackComplete = false;
    let drainComplete = false;
    const cleanup = () => {
      process.stdout.removeListener('error', onError);
      process.stdout.removeListener('drain', onDrain);
    };
    const finish = (error?: Error | null) => {
      if (settled) return;
      if (error) {
        settled = true;
        // A failed write callback may be followed by the stream's `error`
        // event. Keep the once-listener installed so EPIPE cannot become an
        // unhandled process exception after this Promise rejects.
        process.stdout.removeListener('drain', onDrain);
        reject(new StdoutDeliveryError(error));
      } else if (callbackComplete && drainComplete) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => finish(error);
    const onDrain = () => {
      drainComplete = true;
      finish();
    };
    process.stdout.once('error', onError);
    try {
      const accepted = process.stdout.write(source, error => {
        callbackComplete = true;
        finish(error);
      });
      if (accepted) {
        drainComplete = true;
        finish();
      } else {
        process.stdout.once('drain', onDrain);
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  const metadata = parseQwenWorkLifecycleHookMetadata(await readStdin(), args.event);
  try {
    migrateDataDirIfNeeded(migrationLog);
  } catch {
    // The normal config/database path remains authoritative.
  }

  if (args.event === 'SessionStart') {
    const prepared = await buildSessionStartContext(
      args.agentId,
      args.skillPath!,
      args.skillSha256!,
      metadata.lifecycleReason,
    );
    await writeStdout(formatQwenWorkLifecycleHookOutput(args.event, prepared.context));
    if (prepared.skillVerified) recordActivity(args);
    return;
  }
  if (args.event === 'PreCompact') {
    await writeStdout(formatQwenWorkLifecycleHookOutput(args.event, QWENWORK_PRE_COMPACT_CONTEXT));
    recordActivity(args);
    return;
  }
  await writeStdout(formatQwenWorkLifecycleHookOutput(args.event));
  recordActivity(args);
}

main().catch(async (error: unknown) => {
  process.stderr.write(`[eb:hook-qwenwork-lifecycle] fatal error — ${message(error)}\n`);
  process.exitCode = 1;
  if (!(error instanceof StdoutDeliveryError)) {
    try { await writeStdout('{}\n'); } catch { /* stdout remains unavailable */ }
  }
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
