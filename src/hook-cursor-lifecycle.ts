#!/usr/bin/env node

import { fstatSync, readFileSync } from 'node:fs';
import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { recordHookActivityEvidence } from './db/agent-host-activity.js';
import { SqliteRepository } from './db/sqlite-repository.js';
import {
  formatCursorLifecycleHookOutput,
  parseCursorLifecycleHookPayload,
  type CursorLifecycleHookEvent,
} from './hook-cursor-protocol.js';
import { assembleSessionContext, formatProfileSection, formatRestSections } from './hook-session-format.js';
import { prepare } from './tools/prepare.js';
import { getTideMindVersion } from './utils/app-version.js';
import { createLogger } from './utils/logger.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';
import { matchesExpectedInstructionSha256 } from './agent-integration-recognition.js';
import { writeSerializedHookOutput, writeSerializedHookOutputBeforeEvidence } from './hook-output.js';

const STDIN_TIMEOUT_MS = 2_000;
const migrationLog = createLogger('migrate');

interface CursorHookArgs {
  event: CursorLifecycleHookEvent;
  agentId: string;
  skillPath: string | null;
  activityGenerationToken: string;
  expectedSkillSha256: string | null;
}

function parseArgs(): CursorHookArgs {
  const args = process.argv.slice(2);
  let event: CursorLifecycleHookEvent | null = null;
  let agentId = '';
  let skillPath: string | null = null;
  let activityGenerationToken = '';
  let expectedSkillSha256: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--event' && args[index + 1]) {
      const candidate = args[index + 1];
      if (candidate === 'sessionStart' || candidate === 'preCompact' || candidate === 'sessionEnd') {
        event = candidate;
      }
      index += 1;
    } else if (value === '--agent-id' && args[index + 1]) {
      agentId = args[index + 1];
      index += 1;
    } else if (value === '--skill-path' && args[index + 1]) {
      skillPath = args[index + 1];
      index += 1;
    } else if (value === '--activity-generation-token' && args[index + 1]) {
      activityGenerationToken = args[index + 1];
      index += 1;
    } else if (value === '--expected-skill-sha256' && args[index + 1]) {
      expectedSkillSha256 = args[index + 1].toLowerCase();
      index += 1;
    }
  }
  if (!event) throw new Error('cursor_hook_event_missing');
  if (!agentId.trim()) throw new Error('cursor_hook_agent_id_missing');
  if (!activityGenerationToken.trim()) throw new Error('cursor_hook_activity_generation_token_missing');
  if (event === 'sessionStart' && !skillPath) throw new Error('cursor_hook_skill_path_missing');
  if (event === 'sessionStart' && !expectedSkillSha256?.match(/^[a-f0-9]{64}$/u)) {
    throw new Error('cursor_hook_skill_sha256_missing');
  }
  return { event, agentId, skillPath, activityGenerationToken, expectedSkillSha256 };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('cursor_hook_input_missing');
  try {
    const stat = fstatSync(0);
    if (stat.isFile()) {
      const source = readFileSync(0, 'utf8');
      if (!source.trim()) throw new Error('cursor_hook_input_missing');
      return source;
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'cursor_hook_input_missing') throw error;
  }
  const source = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
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
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => finish(new Error('cursor_hook_input_timeout')), STDIN_TIMEOUT_MS);
    timer.unref?.();
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => finish());
    process.stdin.on('error', () => finish(new Error('cursor_hook_input_failed')));
  });
  if (!source.trim()) throw new Error('cursor_hook_input_missing');
  return source;
}

function readSkill(skillPath: string, expectedSha256: string): string {
  let content = readFileSync(skillPath, 'utf8');
  if (!matchesExpectedInstructionSha256(content, expectedSha256)) {
    throw new Error('cursor_hook_skill_hash_mismatch');
  }
  if (content.startsWith('---')) {
    const end = content.indexOf('---', 3);
    if (end !== -1) content = content.slice(end + 3).trim();
  }
  return content;
}

async function buildSessionStartContext(agentId: string, skillPath: string, expectedSha256: string): Promise<{
  context: string;
  skillVerified: boolean;
}> {
  let skillContent: string;
  let skillVerified = false;
  try {
    skillContent = readSkill(skillPath, expectedSha256);
    skillVerified = true;
  } catch (error) {
    process.stderr.write(`[eb:hook-cursor-lifecycle] skill unavailable — ${message(error)}\n`);
    skillContent = '（Skill 文件读取失败，请通过记忆工具 brain_prepare/recall/digest 与 Tide Mind 交互）';
  }
  loadConfig();
  ensureDataDirs();
  const repository = new SqliteRepository(getDb());
  const result = await prepare(repository, {
    tool: 'cursor',
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
}

function signalFor(event: CursorLifecycleHookEvent): 'session_start' | 'pre_compact' | 'session_end' {
  if (event === 'sessionStart') return 'session_start';
  if (event === 'preCompact') return 'pre_compact';
  return 'session_end';
}

function recordActivity(args: CursorHookArgs): boolean {
  try {
    loadConfig();
    ensureDataDirs();
    const result = recordHookActivityEvidence(getDb(), {
      agentId: args.agentId,
      tool: 'cursor',
      signalName: signalFor(args.event),
      tideMindVersion: getTideMindVersion(),
      activityGenerationToken: args.activityGenerationToken,
    });
    if (result.status === 'rejected') {
      process.stderr.write(`[eb:hook-cursor-lifecycle] activity evidence rejected — ${result.reason}\n`);
      return false;
    }
    return true;
  } catch (error) {
    process.stderr.write(`[eb:hook-cursor-lifecycle] activity evidence unavailable — ${message(error)}\n`);
    return false;
  } finally {
    try { closeDb(); } catch { /* best effort */ }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const payload = parseCursorLifecycleHookPayload(await readStdin(), args.event);
  void payload;
  try {
    migrateDataDirIfNeeded(migrationLog);
  } catch {
    // Migration failure is handled by the normal config/database path below.
  }

  if (args.event !== 'sessionStart') {
    await writeSerializedHookOutputBeforeEvidence(formatCursorLifecycleHookOutput(args.event), () => {
      recordActivity(args);
    });
    return;
  }

  let prepared: { context: string; skillVerified: boolean };
  try {
    prepared = await buildSessionStartContext(args.agentId, args.skillPath!, args.expectedSkillSha256!);
  } catch (error) {
    process.stderr.write(`[eb:hook-cursor-lifecycle] prepare failed — ${message(error)}\n`);
    await writeSerializedHookOutput(formatCursorLifecycleHookOutput(
      args.event,
      'Tide Mind 用户上下文加载失败，请手动调用 brain_prepare。',
    ));
    return;
  } finally {
    try { closeDb(); } catch { /* best effort */ }
  }
  await writeSerializedHookOutputBeforeEvidence(
    formatCursorLifecycleHookOutput(args.event, prepared.context),
    () => { if (prepared.skillVerified) recordActivity(args); },
  );
}

main().catch(async (error: unknown) => {
  process.stderr.write(`[eb:hook-cursor-lifecycle] fatal error — ${message(error)}\n`);
  let event: CursorLifecycleHookEvent = 'sessionStart';
  const eventIndex = process.argv.indexOf('--event');
  const candidate = eventIndex >= 0 ? process.argv[eventIndex + 1] : undefined;
  if (candidate === 'preCompact' || candidate === 'sessionEnd') event = candidate;
  try {
    await writeSerializedHookOutput(formatCursorLifecycleHookOutput(event));
  } catch {
    process.exitCode = 1;
  }
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
