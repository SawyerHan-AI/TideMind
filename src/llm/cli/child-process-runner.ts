import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { CliLLMError } from './errors.js';
import type { CliInvocationPurpose } from './types.js';

export interface CliProcessSpec {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  purpose: CliInvocationPurpose;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  onBeforePromptCommit?: () => void | Promise<void>;
  onPromptCommitted?: () => void | Promise<void>;
}

export interface CliProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  promptCommitted: boolean;
}

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcessWithoutNullStreams;

export class CliProcessRegistry {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly processGroups = new Set<number>();
  private pendingAdmissions = 0;
  private readonly admissionWaiters = new Set<() => void>();
  private stopping = false;

  assertAccepting(): void {
    if (this.stopping) throw new CliLLMError('aborted', 'CLI runtime is stopping');
  }

  beginAdmission(): () => void {
    this.assertAccepting();
    this.pendingAdmissions++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingAdmissions--;
      if (this.pendingAdmissions === 0) {
        for (const resolve of this.admissionWaiters) resolve();
        this.admissionWaiters.clear();
      }
    };
  }

  registerAdmitted(child: ChildProcessWithoutNullStreams): void {
    this.children.add(child);
    if (process.platform !== 'win32' && child.pid && child.pid > 0) {
      this.processGroups.add(child.pid);
    }
  }

  async unregister(child: ChildProcessWithoutNullStreams, graceMs = 100): Promise<void> {
    this.children.delete(child);
    if (process.platform === 'win32' || !child.pid || child.pid <= 0) return;
    const group = child.pid;
    if (!this.processGroups.has(group)) return;
    if (isProcessGroupAlive(group)) {
      signalProcessGroupId(group, 'SIGTERM');
      await waitForProcessGroupExit(group, graceMs);
    }
    if (isProcessGroupAlive(group)) {
      signalProcessGroupId(group, 'SIGKILL');
      await waitForProcessGroupExit(group, graceMs);
    }
    if (isProcessGroupAlive(group)) {
      throw new CliLLMError('process_crash', 'CLI process group survived cleanup');
    }
    this.processGroups.delete(group);
  }

  async shutdown(graceMs = 750): Promise<void> {
    this.stopping = true;
    if (this.pendingAdmissions > 0) {
      await new Promise<void>(resolve => this.admissionWaiters.add(resolve));
    }
    const children = [...this.children];
    const groups = [...this.processGroups];
    for (const group of groups) signalProcessGroupId(group, 'SIGTERM');
    if (process.platform === 'win32') {
      for (const child of children) child.kill('SIGTERM');
    }
    await Promise.all(
      children.map((child) => this.children.has(child) ? waitForClose(child, graceMs) : undefined),
    );
    for (const group of groups) {
      if (isProcessGroupAlive(group)) signalProcessGroupId(group, 'SIGKILL');
    }
    if (process.platform === 'win32') {
      for (const child of children) {
        if (this.children.has(child)) child.kill('SIGKILL');
      }
    }
    await Promise.all(
      children.map((child) => this.children.has(child) ? waitForClose(child, graceMs) : undefined),
    );
    for (const group of groups) {
      if (!isProcessGroupAlive(group)) this.processGroups.delete(group);
    }
    if (this.children.size > 0 || this.processGroups.size > 0) {
      throw new CliLLMError('process_crash', 'CLI child process did not exit after SIGKILL');
    }
  }

  get activeCount(): number {
    return this.children.size;
  }
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid && child.pid > 0) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // Exit/close is the final source of truth.
  }
}

function signalProcessGroupId(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {
    // ESRCH means the complete group is already gone.
  }
}

function isProcessGroupAlive(group: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(group: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessGroupAlive(group)) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once('close', finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

function outcomeError(
  kind: 'timeout' | 'aborted' | 'output_limit' | 'process_crash',
  promptCommitted: boolean,
  purpose: CliInvocationPurpose,
  cause?: unknown,
): CliLLMError {
  if (promptCommitted && purpose === 'background') {
    return new CliLLMError('ambiguous_outcome', 'CLI result is unknown after prompt submission', {
      needsUserAction: true,
      promptCommitted: true,
      cause,
    });
  }
  return new CliLLMError(kind, kind === 'aborted' ? 'CLI invocation was cancelled' : `CLI ${kind}`, {
    promptCommitted,
    cause,
  });
}

export class CliChildProcessRunner {
  constructor(
    private readonly registry: CliProcessRegistry,
    private readonly spawnFn: SpawnFn = (command, args, options) =>
      spawn(command, [...args], options) as ChildProcessWithoutNullStreams,
  ) {}

  async run(spec: CliProcessSpec): Promise<CliProcessResult> {
    const releaseAdmission = this.registry.beginAdmission();
    if (spec.signal?.aborted) {
      releaseAdmission();
      throw new CliLLMError('aborted', 'CLI invocation was cancelled before spawn');
    }
    const stdoutLimit = spec.stdoutLimitBytes ?? 16 * 1024 * 1024;
    const stderrLimit = spec.stderrLimitBytes ?? 16 * 1024 * 1024;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      releaseAdmission();
      throw new CliLLMError('process_crash', 'Unable to start CLI process', { cause: error });
    }
    try {
      // shutdown may have started after beginAdmission(). The reservation makes
      // shutdown wait until this child is registered, so it enters the same
      // TERM/KILL/verify barrier as every other active process.
      this.registry.registerAdmitted(child);
    } catch (error) {
      signalProcessGroup(child, 'SIGTERM');
      releaseAdmission();
      throw error;
    }
    releaseAdmission();

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let promptCommitted = false;
    let terminalError: CliLLMError | null = null;
    let terminationStarted = false;
    let killTimer: NodeJS.Timeout | null = null;

    const terminate = (error: CliLLMError): void => {
      if (!terminalError) terminalError = error;
      if (terminationStarted) return;
      terminationStarted = true;
      signalProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), 500);
      killTimer.unref?.();
    };
    const onAbort = () =>
      terminate(outcomeError('aborted', promptCommitted, spec.purpose, spec.signal?.reason));
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(
      () => terminate(outcomeError('timeout', promptCommitted, spec.purpose)),
      spec.timeoutMs,
    );
    timeout.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > stdoutLimit) {
        terminate(outcomeError('output_limit', promptCommitted, spec.purpose));
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > stderrLimit) {
        terminate(outcomeError('output_limit', promptCommitted, spec.purpose));
        return;
      }
      stderr += stderrDecoder.write(chunk);
    });

    const completion = new Promise<CliProcessResult>((resolve, reject) => {
      child.once('error', (error) => {
        terminalError ??= outcomeError('process_crash', promptCommitted, spec.purpose, error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        spec.signal?.removeEventListener('abort', onAbort);
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        void this.registry.unregister(child).then(() => {
          if (terminalError) {
            reject(terminalError);
            return;
          }
          resolve({
            stdout,
            stderr,
            exitCode: code ?? -1,
            signal,
            promptCommitted,
          });
        }, (error) => {
          reject(outcomeError('process_crash', promptCommitted, spec.purpose, error));
        });
      });
    });

    try {
      await spec.onBeforePromptCommit?.();
      if (spec.signal?.aborted) {
        terminate(outcomeError('aborted', false, spec.purpose, spec.signal.reason));
      } else {
        // Conservatively mark committed before write: EPIPE may occur after the
        // child has consumed a prefix, and must not be replayed in background.
        promptCommitted = true;
        await spec.onPromptCommitted?.();
        await new Promise<void>((resolve, reject) => {
          child.stdin.end(spec.stdin, 'utf8', (error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        }).catch((error) => {
          terminate(outcomeError('process_crash', promptCommitted, spec.purpose, error));
        });
      }
      return await completion;
    } catch (error) {
      terminate(
        error instanceof CliLLMError
          ? error
          : outcomeError('process_crash', promptCommitted, spec.purpose, error),
      );
      return await completion;
    }
  }
}
