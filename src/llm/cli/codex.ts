import { randomUUID } from 'node:crypto';
import type { CodexCapabilityManifest } from './catalogs.js';
import { CliChildProcessRunner } from './child-process-runner.js';
import { CliLLMError } from './errors.js';
import { sanitizeCliEnvironment } from './environment.js';
import { parseCodexJsonLines } from './parser-codex.js';
import { createCliRuntimeDirectory } from './runtime-dir.js';
import { assertResolvedCliIdentity } from './resolve-cli.js';
import type {
  CliAdapter,
  CliCapabilities,
  CliInvocationHooks,
  CliLLMRequest,
  CliLLMResult,
  ResolvedCli,
} from './types.js';

export interface CodexCliAdapterOptions {
  resolved: ResolvedCli;
  manifest: CodexCapabilityManifest;
  dataDir: string;
  runner: CliChildProcessRunner;
  preflight: () => void | Promise<void>;
  hooks?: CliInvocationHooks;
  sourceEnv?: NodeJS.ProcessEnv;
  invocationId?: () => string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export class CodexCliAdapter implements CliAdapter {
  readonly providerType = 'codex-cli' as const;
  readonly capabilities: CliCapabilities = {
    maxOutputTokens: 'soft',
    structuredOutput: 'strict',
    thinking: 'soft',
    toolsDisabled: 'strict',
  };

  constructor(private readonly options: CodexCliAdapterOptions) {
    if (options.resolved.kind !== 'codex') throw new Error('Codex adapter requires codex CLI');
    if (options.manifest.version !== options.resolved.version) {
      throw new CliLLMError('unsupported_version', 'Codex manifest does not match CLI version');
    }
  }

  async run(request: CliLLMRequest): Promise<CliLLMResult> {
    if (request.providerType !== this.providerType) throw new Error('CLI provider mismatch');
    await this.options.preflight();
    const runtime = createCliRuntimeDirectory(
      this.options.dataDir,
      (this.options.invocationId ?? randomUUID)(),
    );
    let outcome: Parameters<NonNullable<CliInvocationHooks['onFinished']>>[1] =
      'definite_failure';
    try {
      const softLimits: string[] = [];
      if (request.maxOutputTokens !== undefined) {
        softLimits.push(`Keep the final answer within approximately ${request.maxOutputTokens} output tokens.`);
      }
      const instructionFile = runtime.createPrivateFile(
        'system.txt',
        [
          request.system,
          ...softLimits,
          'Return only the requested text. Do not invoke tools, commands, applications, browsers, search, skills, plugins, hooks, MCP servers, memory, or sub-agents.',
        ].filter(Boolean).join('\n\n'),
      );
      const args = [
        'exec',
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        '--json',
        '--skip-git-repo-check',
        '--strict-config',
        '-C',
        runtime.invocationDir,
        '-s',
        'read-only',
      ];
      if (request.modelAlias !== 'default') args.push('-m', request.modelAlias);
      for (const feature of this.options.manifest.disableFeatures) {
        args.push('--disable', feature);
      }
      args.push(
        '-c', 'approval_policy="never"',
        '-c', 'skills.include_instructions=false',
        '-c', 'mcp_servers={}',
        '-c', 'hooks={}',
        '-c', 'notify=[]',
        '-c', 'marketplaces={}',
        '-c', 'plugins={}',
        '-c', 'apps={}',
        '-c', 'web_search="disabled"',
        '-c', 'include_environment_context=false',
        '-c', 'include_permissions_instructions=false',
        '-c', 'include_apps_instructions=false',
        '-c', 'include_collaboration_mode_instructions=false',
        '-c', `model_instructions_file=${tomlString(instructionFile)}`,
        '-',
      );
      await assertResolvedCliIdentity(this.options.resolved);
      const result = await this.options.runner.run({
        executable: this.options.resolved.path,
        args,
        cwd: runtime.invocationDir,
        env: sanitizeCliEnvironment(
          this.options.sourceEnv ?? process.env,
          this.options.resolved.path,
          this.options.resolved.controlledPath,
        ),
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        purpose: request.purpose ?? 'background',
        onBeforePromptCommit: () => this.options.hooks?.beforePromptCommit?.(request),
        onPromptCommitted: () => this.options.hooks?.onPromptCommitted?.(request),
      });
      try {
        const parsed = parseCodexJsonLines(
          result.stdout,
          request.modelAlias,
          result.exitCode,
          result.stderr,
        );
        outcome = 'completed';
        return parsed;
      } catch (error) {
        if (
          result.promptCommitted &&
          (request.purpose ?? 'background') === 'background' &&
          error instanceof CliLLMError
        ) {
          outcome = 'ambiguous_outcome';
          throw new CliLLMError(
            'ambiguous_outcome',
            'Codex result is unknown after prompt submission',
            { promptCommitted: true, needsUserAction: true, cause: error },
          );
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof CliLLMError) {
        outcome =
          error.kind === 'ambiguous_outcome'
            ? 'ambiguous_outcome'
            : error.kind === 'aborted'
              ? 'aborted'
              : 'definite_failure';
      }
      throw error;
    } finally {
      try {
        runtime.cleanup();
      } catch {
        // Stale private directories are reclaimed at startup. Cleanup failure
        // must never replace a provider result or an ambiguous primary error.
      }
      try {
        await this.options.hooks?.onFinished?.(request, outcome);
      } catch {
        // Optional bookkeeping is not part of the provider outcome.
      }
    }
  }
}
