import { randomUUID } from 'node:crypto';
import { CliChildProcessRunner } from './child-process-runner.js';
import { CliLLMError } from './errors.js';
import { sanitizeCliEnvironment } from './environment.js';
import { parseClaudeResult } from './parser-claude.js';
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

export interface ClaudeCliAdapterOptions {
  resolved: ResolvedCli;
  dataDir: string;
  runner: CliChildProcessRunner;
  preflight: () => void | Promise<void>;
  hooks?: CliInvocationHooks;
  sourceEnv?: NodeJS.ProcessEnv;
  invocationId?: () => string;
}

export class ClaudeCliAdapter implements CliAdapter {
  readonly providerType = 'claude-cli' as const;
  readonly capabilities: CliCapabilities = {
    maxOutputTokens: 'soft',
    structuredOutput: 'strict',
    thinking: 'soft',
    toolsDisabled: 'strict',
  };

  constructor(private readonly options: ClaudeCliAdapterOptions) {
    if (options.resolved.kind !== 'claude') throw new Error('Claude adapter requires claude CLI');
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
      if (request.thinking?.mode) {
        softLimits.push(`Use ${request.thinking.mode} reasoning effort without exposing private chain-of-thought.`);
      }
      const systemText = [request.system, ...softLimits].filter(Boolean).join('\n\n');
      const systemFile = runtime.createPrivateFile('system.txt', systemText);
      const args = [
        '-p',
        '--safe-mode',
        '--tools',
        '',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--output-format',
        'json',
        '--system-prompt-file',
        systemFile,
      ];
      if (request.modelAlias !== 'default') args.push('--model', request.modelAlias);
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
        const parsed = parseClaudeResult(
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
            'Claude result is unknown after prompt submission',
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
