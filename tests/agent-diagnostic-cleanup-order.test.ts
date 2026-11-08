import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  child: undefined as any,
  groupAlive: true,
  unregister: vi.fn<() => Promise<void>>(),
  shutdown: vi.fn<() => Promise<void>>(),
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: () => fixture.child,
}));
vi.mock('../src/llm/cli/child-process-runner.js', () => ({
  isProcessGroupAlive: () => fixture.groupAlive,
  CliProcessRegistry: class {
    beginAdmission() { return () => {}; }
    registerAdmitted() {}
    shutdown() { return fixture.shutdown(); }
    unregister() { return fixture.unregister(); }
  },
}));
import { runDiagnosticSupervisor, type DiagnosticSupervisorEvent } from '../src/agent-diagnostic-runner.js';

describe('diagnostic supervisor cleanup convergence', () => {
  it.each(['cancelled', 'adapter_error'] as const)('joins close cleanup after a provisional shutdown failure and preserves %s', async reason => {
    await exercise(reason, 'exited');
  });
  it('retains cleanup_failed when unregister cannot confirm the group exit', async () => {
    await exercise('cancelled', 'reject');
  });
  it('retains cleanup_failed when the settled unregister leaves the group present', async () => {
    await exercise('cancelled', 'present');
  });
  it('does not erase an unregister failure even if the final group probe is absent', async () => {
    await exercise('cancelled', 'reject-absent');
  });
  it('retains cleanup_failed when the direct child has not closed', async () => {
    await exercise('cancelled', 'open');
  });
  it('waits for unregister before reporting a natural exit', async () => {
    await exercise('exited', 'exited');
  });
});

async function exercise(reason: 'cancelled' | 'adapter_error' | 'exited', outcome: 'exited' | 'reject' | 'reject-absent' | 'present' | 'open') {
  const fail = outcome !== 'exited';
  const child = Object.assign(new EventEmitter(), {
    pid: 424242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  fixture.child = child;
  fixture.groupAlive = true;
  let resolveCleanup!: () => void, rejectCleanup!: (error: Error) => void;
  const pendingCleanup = new Promise<void>((resolve, reject) => { resolveCleanup = resolve; rejectCleanup = reject; });
  fixture.unregister.mockReset().mockReturnValue(pendingCleanup);
  fixture.shutdown.mockReset().mockImplementation(async () => {
    // Real close starts unregister while shutdown is awaiting its close barrier.
    await Promise.resolve();
    if (outcome !== 'open') child.emit('close', null, 'SIGTERM');
    else fixture.groupAlive = false; // Absence alone cannot replace the close barrier.
    throw new Error('group still present while unregister is settling');
  });
  const events: DiagnosticSupervisorEvent[] = [];
  const saved = Object.fromEntries(['connected', 'send', 'disconnect'].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]));
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  Object.defineProperty(process, 'send', { configurable: true, value: (event: DiagnosticSupervisorEvent, callback: () => void) => {
    events.push(event); callback(); return true;
  } });
  Object.defineProperty(process, 'disconnect', { configurable: true, value: () => {} });
  let settled = false;
  const existingMessageListeners = new Set(process.listeners('message'));
  const done = runDiagnosticSupervisor().then(() => { settled = true; });
  try {
    // Exercise only the supervisor listener; process.emit also reaches Vitest's fork IPC decoder.
    const onMessage = process.listeners('message').find(listener => !existingMessageListeners.has(listener))!;
    onMessage({ protocolVersion: 1, type: 'init', spec: {
      executable: process.execPath, args: [], cwd: process.cwd(), env: {},
    } });
    if (reason === 'exited') child.emit('close', 0, null);
    else onMessage({ protocolVersion: 1, type: 'stop', reason });
    if (outcome !== 'open') {
      await vi.waitFor(() => expect(fixture.unregister).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
      expect(events.some(event => event.type === 'result')).toBe(false);
      if (outcome === 'reject' || outcome === 'reject-absent') {
        fixture.groupAlive = outcome !== 'reject-absent';
        rejectCleanup(new Error('group exit unconfirmed'));
      }
      else { fixture.groupAlive = outcome === 'present'; resolveCleanup(); }
    }
    await done;
    expect(events.find(event => event.type === 'result')).toMatchObject({ type: 'result', result: {
      reason: fail ? 'cleanup_failed' : reason,
      processGroupExited: !fail || outcome === 'reject-absent', supervisorExited: false, signal: reason === 'exited' ? null : outcome === 'open' ? null : 'SIGTERM',
    } });
  } finally {
    resolveCleanup();
    await done;
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(process, key, descriptor);
      else Reflect.deleteProperty(process, key);
    }
  }
}
