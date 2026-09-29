/** Explicit opt-in, one real generation against the existing Codex login.
 * No retries, credential copies, daily config writes, or production DB access.
 * A 32-token instruction is soft; Codex offers no hard monetary/output-token cap.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../src/db/connection.js';
import { createConnection } from '../src/db/connections.js';
import { checkCliEnvironment } from '../src/llm/cli/readiness.js';
import { runCliLLM, shutdownCliRuntime } from '../src/llm/cli/service.js';
import { isValidManualModelId } from '../src/llm/cli/catalogs.js';

const args = process.argv.slice(2);
if (args[0] !== '--confirm-one-generation' || args.length > 2) {
  throw new Error('Usage: tsx scripts/verify-codex-cli-isolated-once.ts --confirm-one-generation [model-id|default]. This consumes current Codex account quota; no hard cost cap is available.');
}
const model = args[1] ?? 'default';
if (!isValidManualModelId(model)) throw new Error('invalid model ID');
const dir = mkdtempSync(join(tmpdir(), 'tidemind-codex-once-'));
const db = createTestDb();
const controller = new AbortController();
const abort = () => controller.abort(new Error('user cancelled'));
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
try {
  const environment = await checkCliEnvironment({ providerType: 'codex-cli', dataDir: dir, freshAuth: true, signal: controller.signal });
  if (environment.auth.scopeState !== 'known') throw new Error('Cannot identify current account scope; no generation submitted.');
  const connection = createConnection(db, { name: 'Isolated one-call acceptance', provider_type: 'codex-cli' });
  console.log(JSON.stringify({ phase: 'ready', cliVersion: environment.resolved.version, selected: model,
    defaultSource: model === 'default' ? 'isolated_cli_bundled' : null,
    maxGenerations: 1, softOutputTokenTarget: 32, timeoutMs: 45000, hardCostCap: null }));
  const result = await runCliLLM(db, dir, {
    connectionId: connection.id, providerType: 'codex-cli', modelAlias: model,
    system: 'This is an isolated connection test. Return only the exact requested marker.',
    prompt: 'Reply with exactly: TIDEMIND_CONNECTION_OK',
    maxOutputTokens: 32, timeoutMs: 45000, signal: controller.signal, purpose: 'connection_test',
    operationName: 'isolated-one-call-acceptance',
  }, { purpose: 'connection_test', environment });
  console.log(JSON.stringify({ phase: 'result', markerMatches: result.text.trim() === 'TIDEMIND_CONNECTION_OK',
    actualModel: result.actualModel, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    reasoningTokens: result.reasoningTokens,
    invocations: db.prepare('SELECT outcome, prompt_committed FROM cli_invocations').all() }));
  if (result.text.trim() !== 'TIDEMIND_CONNECTION_OK') process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
  await shutdownCliRuntime();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
