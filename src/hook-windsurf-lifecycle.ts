#!/usr/bin/env node

import { fstatSync, readFileSync } from 'node:fs';
import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { recordHookActivityEvidence } from './db/agent-host-activity.js';
import { SqliteRepository } from './db/sqlite-repository.js';
import {
  formatWindsurfLifecycleHookOutput,
  parseWindsurfLifecycleHookMetadata,
  type WindsurfLifecycleHookEvent,
} from './hook-windsurf-protocol.js';
import { assembleSessionContext, formatProfileSection, formatRestSections } from './hook-session-format.js';
import { prepare } from './tools/prepare.js';
import { getTideMindVersion } from './utils/app-version.js';
import { createLogger } from './utils/logger.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';
import { matchesExpectedInstructionSha256 } from './agent-integration-recognition.js';
import { writeSerializedHookOutput, writeSerializedHookOutputBeforeEvidence } from './hook-output.js';

const STDIN_TIMEOUT_MS = 2_000;
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const migrationLog = createLogger('migrate');

interface WindsurfHookArgs {
  event: WindsurfLifecycleHookEvent;
  agentId: string;
  skillPath: string | null;
  activityGenerationToken: string;
  expectedSkillSha256: string | null;
}

function parseArgs(): WindsurfHookArgs {
  const args = process.argv.slice(2);
  let event: WindsurfLifecycleHookEvent | null = null;
  let agentId = '';
  let skillPath: string | null = null;
  let activityGenerationToken = '';
  let expectedSkillSha256: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--event' && args[index + 1]) {
      const candidate = args[index + 1];
      if (candidate === 'SessionStart' || candidate === 'SessionEnd') event = candidate;
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
  if (!event) throw new Error('windsurf_hook_event_missing');
  if (!agentId.trim()) throw new Error('windsurf_hook_agent_id_missing');
  if (!activityGenerationToken.trim()) throw new Error('windsurf_hook_activity_generation_token_missing');
  if (event === 'SessionStart' && !skillPath) throw new Error('windsurf_hook_skill_path_missing');
  if (event === 'SessionStart' && !expectedSkillSha256?.match(/^[a-f0-9]{64}$/u)) {
    throw new Error('windsurf_hook_skill_sha256_missing');
  }
  return { event, agentId, skillPath, activityGenerationToken, expectedSkillSha256 };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('windsurf_hook_input_missing');
  try {
    const stat = fstatSync(0);
    if (stat.isFile()) {
      if (stat.size > MAX_STDIN_BYTES) throw new Error('windsurf_hook_input_too_large');
      const source = readFileSync(0, 'utf8');
      if (!source.trim()) throw new Error('windsurf_hook_input_missing');
      return source;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('windsurf_hook_input_')) throw error;
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
        if (!source.trim()) reject(new Error('windsurf_hook_input_missing'));
        else resolve(source);
      }
    };
    const timer = setTimeout(() => finish(new Error('windsurf_hook_input_timeout')), STDIN_TIMEOUT_MS);
    timer.unref?.();
    process.stdin.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STDIN_BYTES) finish(new Error('windsurf_hook_input_too_large'));
      else chunks.push(chunk);
    });
    process.stdin.on('end', () => finish());
    process.stdin.on('error', () => finish(new Error('windsurf_hook_input_failed')));
  });
}

function readSkill(skillPath: string, expectedSha256: string): string {
  let content = readFileSync(skillPath, 'utf8');
  if (!matchesExpectedInstructionSha256(content, expectedSha256)) {
    throw new Error('windsurf_hook_skill_hash_mismatch');
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
    process.stderr.write(`[eb:hook-windsurf-lifecycle] skill unavailable — ${message(error)}\n`);
    skillContent = '（Skill 文件读取失败，请通过记忆工具 brain_prepare/recall/digest 与 Tide Mind 交互）';
  }
  loadConfig();
  ensureDataDirs();
  const result = await prepare(new SqliteRepository(getDb()), {
    // Keep the stable internal tool identity so existing activity/source
    // attribution survives the upstream Windsurf -> Devin rename.
    tool: 'windsurf',
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

function recordActivity(args: WindsurfHookArgs): void {
  try {
    loadConfig();
    ensureDataDirs();
    const result = recordHookActivityEvidence(getDb(), {
      agentId: args.agentId,
      tool: 'windsurf',
      signalName: args.event === 'SessionStart' ? 'session_start' : 'session_end',
      tideMindVersion: getTideMindVersion(),
      activityGenerationToken: args.activityGenerationToken,
    });
    if (result.status === 'rejected') {
      process.stderr.write(`[eb:hook-windsurf-lifecycle] activity evidence rejected — ${result.reason}\n`);
    }
  } catch (error) {
    process.stderr.write(`[eb:hook-windsurf-lifecycle] activity evidence unavailable — ${message(error)}\n`);
  } finally {
    try { closeDb(); } catch { /* best effort */ }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  // The parser returns only non-content lifecycle metadata.
  parseWindsurfLifecycleHookMetadata(await readStdin(), args.event);
  try {
    migrateDataDirIfNeeded(migrationLog);
  } catch {
    // The normal config/database path below remains authoritative.
  }

  if (args.event === 'SessionEnd') {
    await writeSerializedHookOutputBeforeEvidence(formatWindsurfLifecycleHookOutput(args.event), () => {
      recordActivity(args);
    });
    return;
  }

  let prepared: { context: string; skillVerified: boolean };
  try {
    prepared = await buildSessionStartContext(args.agentId, args.skillPath!, args.expectedSkillSha256!);
  } catch (error) {
    process.stderr.write(`[eb:hook-windsurf-lifecycle] prepare failed — ${message(error)}\n`);
    await writeSerializedHookOutput(formatWindsurfLifecycleHookOutput(
      args.event,
      'Tide Mind 用户上下文加载失败，请手动调用 brain_prepare。',
    ));
    return;
  } finally {
    try { closeDb(); } catch { /* best effort */ }
  }
  await writeSerializedHookOutputBeforeEvidence(
    formatWindsurfLifecycleHookOutput(args.event, prepared.context),
    () => { if (prepared.skillVerified) recordActivity(args); },
  );
}

main().catch(async (error: unknown) => {
  process.stderr.write(`[eb:hook-windsurf-lifecycle] fatal error — ${message(error)}\n`);
  const eventIndex = process.argv.indexOf('--event');
  const event: WindsurfLifecycleHookEvent = process.argv[eventIndex + 1] === 'SessionEnd'
    ? 'SessionEnd'
    : 'SessionStart';
  try {
    await writeSerializedHookOutput(formatWindsurfLifecycleHookOutput(event));
  } catch {
    process.exitCode = 1;
  }
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
