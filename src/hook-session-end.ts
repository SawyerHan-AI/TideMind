#!/usr/bin/env node

import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { recordHookActivityEvidence } from './db/agent-host-activity.js';
import { getTideMindVersion } from './utils/app-version.js';
import { createLogger } from './utils/logger.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';

const migrationLog = createLogger('migrate');

function parseArgs(): { agentId: string; tool: string; activityGenerationToken: string } {
  const args = process.argv.slice(2);
  let agentId = '';
  let tool = '';
  let activityGenerationToken = '';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--agent-id' && args[index + 1]) {
      agentId = args[index + 1];
      index += 1;
    } else if (args[index] === '--tool' && args[index + 1]) {
      tool = args[index + 1];
      index += 1;
    } else if (args[index] === '--activity-generation-token' && args[index + 1]) {
      activityGenerationToken = args[index + 1];
      index += 1;
    }
  }
  if (!agentId.trim()) throw new Error('session_end_agent_id_missing');
  if (!tool.trim()) throw new Error('session_end_tool_missing');
  if (!activityGenerationToken.trim()) throw new Error('session_end_activity_generation_token_missing');
  return { agentId, tool, activityGenerationToken };
}

function main(): void {
  const args = parseArgs();
  try {
    migrateDataDirIfNeeded(migrationLog);
    loadConfig();
    ensureDataDirs();
    const result = recordHookActivityEvidence(getDb(), {
      agentId: args.agentId,
      tool: args.tool,
      signalName: 'session_end',
      tideMindVersion: getTideMindVersion(),
      activityGenerationToken: args.activityGenerationToken,
    });
    if (result.status === 'rejected') {
      process.stderr.write(`[eb:hook-session-end] activity evidence rejected — ${result.reason}\n`);
      process.exitCode = 2;
    }
  } finally {
    try { closeDb(); } catch { /* best effort */ }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[eb:hook-session-end] fatal error — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
