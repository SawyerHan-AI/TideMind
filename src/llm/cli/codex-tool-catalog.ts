import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODEX_EXEC_CONFIG_OVERRIDES, isValidManualModelId } from './catalogs.js';
import { codexDisableArgs, type CodexExecutionContract } from './gate-codex.js';
import { sanitizeCliEnvironment } from './environment.js';
import { cliProcessRegistry } from './runtime-process-registry.js';
import { CliLLMError } from './errors.js';
import { createCliRuntimeDirectory } from './runtime-dir.js';
import { assertResolvedCliIdentity } from './resolve-cli.js';
import { isProcessGroupAlive, signalProcessGroupId, waitForProcessGroupExit } from './child-process-runner.js';
import type { ResolvedCli } from './types.js';

/** Execution-only copy, never a replacement for the account model discovery catalog.
 * Contract evidence: official rust-v0.157.1 tools/spec_plan.rs and models-manager.
 * Keep the full catalog/default ordering; remove only tool-selection capabilities.
 */
export const CODEX_TOOL_CATALOG_LIMITS = { maxBytes: 4 * 1024 * 1024, maxModels: 500, budgetMs: 10_000 } as const;
const MODEL_FIELDS = new Set(`slug display_name description default_reasoning_level supported_reasoning_levels shell_type visibility supported_in_api priority additional_speed_tiers service_tiers default_service_tier available_access_programs availability_nux upgrade model_messages base_instructions include_skills_usage_instructions include_plugin_usage_instructions include_apps_usage_instructions supports_reasoning_summary_parameter default_reasoning_summary support_verbosity default_verbosity apply_patch_tool_type web_search_tool_type truncation_policy supports_image_detail_original context_window max_context_window auto_compact_token_limit comp_hash effective_context_window_percent experimental_supported_tools input_modalities used_fallback_model_metadata supports_search_tool supports_experimental_context use_responses_lite supports_reasoning_effort_updates guardian node_repl_auto_review_required node_repl_disabled auto_review_model_override model_specialty tool_mode multi_agent_version multi_agent_reasoning_effort`.split(' '));

function invalid(message: string): never {
  throw new CliLLMError('unsupported_version', `Codex 无工具执行目录无法验证：${message}`, { needsUserAction: true });
}

export function sanitizeCodexToolCatalog(raw: string): string {
  if (Buffer.byteLength(raw) > CODEX_TOOL_CATALOG_LIMITS.maxBytes) invalid('output limit');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalid('malformed JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('invalid root');
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some(key => key !== 'models') || !Array.isArray(root.models)
    || root.models.length === 0 || root.models.length > CODEX_TOOL_CATALOG_LIMITS.maxModels) invalid('invalid models');
  const seen = new Set<string>();
  for (const value of root.models) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('invalid model');
    const model = value as Record<string, unknown>;
    // Unknown execution metadata can introduce unconditional tools. Discovery itself
    // still accepts unknown optional fields; this stronger gate is only for execution.
    if (Object.keys(model).some(key => !MODEL_FIELDS.has(key))) invalid('unreviewed model metadata');
    if (typeof model.slug !== 'string' || !isValidManualModelId(model.slug) || seen.has(model.slug)) invalid('invalid model slug');
    seen.add(model.slug);
    if (!Object.hasOwn(model, 'apply_patch_tool_type')
      || ![null, 'freeform', 'function'].includes(model.apply_patch_tool_type as null | string)
      || !Array.isArray(model.experimental_supported_tools)
      || !model.experimental_supported_tools.every(tool => typeof tool === 'string' && tool.length <= 128)
      || typeof model.priority !== 'number' || !Number.isFinite(model.priority)) invalid('missing tool/default metadata');
    if (model.tool_mode != null && !['direct', 'code_mode', 'code_mode_only'].includes(String(model.tool_mode))) invalid('unknown tool mode');
    if (model.multi_agent_version != null && !['disabled', 'v1', 'v2'].includes(String(model.multi_agent_version))) invalid('unknown agent mode');
    model.apply_patch_tool_type = null;
    model.experimental_supported_tools = [];
    // These fields may override feature flags in upstream tool construction.
    delete model.tool_mode;
    delete model.multi_agent_version;
    if (Object.hasOwn(model, 'supports_search_tool')) model.supports_search_tool = false;
  }
  return JSON.stringify(root);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export type CodexCatalogExec = (args: readonly string[], cwd: string, signal: AbortSignal) => Promise<string>;

export async function prepareCodexToolCatalog(options: {
  resolved: ResolvedCli;
  contract: CodexExecutionContract;
  dataDir: string;
  sourceEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  exec?: CodexCatalogExec;
}): Promise<string> {
  await assertResolvedCliIdentity(options.resolved);
  const runtime = createCliRuntimeDirectory(options.dataDir, `tools_${randomUUID()}`);
  const metadataHome = join(runtime.invocationDir, 'metadata-home');
  try { mkdirSync(metadataHome, { mode: 0o700 }); } catch (error) { runtime.cleanup(); throw error; }
  let cleanupSafe = true;
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new Error('metadata budget exceeded')), CODEX_TOOL_CATALOG_LIMITS.budgetMs);
  const exec: CodexCatalogExec = options.exec ?? ((args, cwd, signal) => new Promise((resolve, reject) => {
    const release = cliProcessRegistry.beginAdmission();
    let child: ReturnType<typeof spawn>;
    try { child = spawn(options.resolved.path, [...args], {
      cwd, env: { ...sanitizeCliEnvironment(options.sourceEnv ?? process.env, options.resolved.path, options.resolved.controlledPath),
        HOME: metadataHome, CODEX_HOME: metadataHome },
      shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
      cliProcessRegistry.registerAdmitted(child as import('node:child_process').ChildProcessWithoutNullStreams);
    } finally { release(); }
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = async (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      const group = child.pid;
      if (group) {
        signalProcessGroupId(group, 'SIGTERM');
        await waitForProcessGroupExit(group, 200);
        if (isProcessGroupAlive(group)) { signalProcessGroupId(group, 'SIGKILL'); await waitForProcessGroupExit(group, 200); }
        if (isProcessGroupAlive(group)) {
          cleanupSafe = false;
          error = new CliLLMError('permission_policy', 'Codex metadata process group did not stop; runtime directory retained for recovery');
        }
      }
      try { await cliProcessRegistry.unregister(child as import('node:child_process').ChildProcessWithoutNullStreams); }
      catch { cleanupSafe = false; error = new CliLLMError('permission_policy', 'Codex metadata process cleanup failed'); }
      child.stdout!.destroy(); child.stderr!.destroy(); child.stdin!.destroy();
      if (error) reject(error); else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const abort = () => { void finish(new CliLLMError(options.signal?.aborted ? 'aborted' : 'timeout', 'Codex 无工具目录元数据读取已取消或超时')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdin!.on('error', () => { void finish(new CliLLMError('process_crash', 'Codex metadata stdin failed')); });
    child.stdin!.end();
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > CODEX_TOOL_CATALOG_LIMITS.maxBytes) void finish(new CliLLMError('output_limit', 'Codex metadata output limit'));
      else chunks.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > CODEX_TOOL_CATALOG_LIMITS.maxBytes) void finish(new CliLLMError('output_limit', 'Codex metadata output limit'));
    });
    child.on('error', () => { void finish(new CliLLMError('unsupported_version', 'Codex 无工具目录元数据进程失败')); });
    child.on('close', code => { void finish(code === 0 ? undefined : new CliLLMError('unsupported_version', 'Codex 无工具目录元数据读取失败')); });
  }));
  const execVerified: CodexCatalogExec = async (args, cwd, signal) => {
    await assertResolvedCliIdentity(options.resolved);
    const output = await exec(args, cwd, signal);
    await assertResolvedCliIdentity(options.resolved);
    return output;
  };
  try {
    // Bundled inference metadata needs no authentication. The child has an empty private HOME;
    // neither user model_catalog_json nor project instructions can enter this execution copy.
    const common = [...codexDisableArgs(options.contract.disableFeatures), ...CODEX_EXEC_CONFIG_OVERRIDES, '-c', 'model_provider="openai"'];
    const raw = await execVerified([...common, 'debug', 'models', '--bundled'], runtime.invocationDir, controller.signal);
    const sanitized = sanitizeCodexToolCatalog(raw);
    const path = runtime.createPrivateFile('model-catalog.json', sanitized);
    const effective = await execVerified([...common, '-c', `model_catalog_json=${JSON.stringify(path)}`, 'debug', 'models'], runtime.invocationDir, controller.signal);
    // Compare the actual static-catalog readback, not merely a configuration receipt.
    if (Buffer.byteLength(effective) > CODEX_TOOL_CATALOG_LIMITS.maxBytes) invalid('readback output limit');
    let parsed: unknown;
    try { parsed = JSON.parse(effective); } catch { return invalid('malformed readback'); }
    if (canonical(parsed) !== canonical(JSON.parse(sanitized))) invalid('static catalog was not applied exactly');
    return sanitized;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (cleanupSafe) runtime.cleanup();
  }
}
