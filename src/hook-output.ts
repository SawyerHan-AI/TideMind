/**
 * Hook 输出协议适配层。
 *
 * 不同 CLI 给 SessionStart / PostCompact / PreCompact 等 hook 的 stdout 协议不同:
 *   - Claude Code:纯文本 stdout 直接注入为上下文
 *   - Codex 0.126+ / Gemini CLI 0.26+ / Qwen Code / ZCode:必须输出严格 JSON
 *     `{hookSpecificOutput: {hookEventName: "<EventName>", additionalContext: "..."}}`
 *     stdout 不能掺杂任何非 JSON 文本,且 hookEventName 必须严格匹配触发事件
 *
 * 历史 bug(2026-05-09):hookEventName 硬编码 'SessionStart',PostCompact 共用同函数
 * 导致 Codex/Gemini 严格按事件名校验时 additionalContext 静默丢失;PreCompact 则
 * 完全没走该层,直接 process.stdout.write 纯文本被当 JSON 解析失败。
 * 现在把事件名作为参数显式传入。
 */

export type HookEventName = 'SessionStart' | 'SessionEnd' | 'PostCompact' | 'PreCompact' | 'PreCompress';

export function formatHookOutput(
  content: string,
  tool: string,
  hookEventName: HookEventName = 'SessionStart',
): string {
  if (tool === 'codex' || tool === 'gemini' || tool === 'qwen-code' || tool === 'zcode') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext: content,
      },
    });
  }
  return content;
}

export function writeHookOutput(
  content: string,
  tool: string,
  hookEventName: HookEventName = 'SessionStart',
  writer: Pick<NodeJS.WriteStream, 'write' | 'once' | 'removeListener'> = process.stdout,
): Promise<void> {
  const output = formatHookOutput(content, tool, hookEventName);
  return writeSerializedHookOutput(output, writer);
}

/**
 * Flush one already-serialized host payload.  Bespoke host protocols (Cursor,
 * Devin/Windsurf, QwenWork) must use the same delivery boundary as the shared
 * formatter without reformatting their exact bytes.
 */
export function writeSerializedHookOutput(
  output: string,
  writer: Pick<NodeJS.WriteStream, 'write' | 'once' | 'removeListener'> = process.stdout,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let callbackCompleted = false;
    let drainObserved = false;
    let writeReturned = false;
    let requiresDrain = false;
    let settled = false;

    const cleanup = () => {
      writer.removeListener('error', onError);
      writer.removeListener('drain', onDrain);
    };
    const fail = (error: unknown, keepErrorListenerUntilNextTurn = false) => {
      if (settled) return;
      settled = true;
      writer.removeListener('drain', onDrain);
      if (keepErrorListenerUntilNextTurn) {
        // Node commonly invokes the write callback with EPIPE and emits the
        // stream error immediately afterwards. Keep the once-listener through
        // that turn so the second notification cannot crash the hook process.
        setImmediate(() => writer.removeListener('error', onError));
      } else {
        writer.removeListener('error', onError);
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const finishIfFlushed = () => {
      if (settled || !writeReturned || !callbackCompleted || (requiresDrain && !drainObserved)) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      if (settled) {
        cleanup();
        return;
      }
      fail(error);
    };
    const onDrain = () => {
      drainObserved = true;
      finishIfFlushed();
    };

    // Subscribe before write(): a custom Writable may report an asynchronous
    // EPIPE immediately after accepting the chunk. The write callback proves
    // that this exact chunk completed; backpressure additionally requires the
    // corresponding drain boundary before callers may mint host evidence.
    writer.once('error', onError);
    writer.once('drain', onDrain);
    try {
      requiresDrain = !writer.write(output, (error?: Error | null) => {
        if (error) {
          fail(error, true);
          return;
        }
        callbackCompleted = true;
        finishIfFlushed();
      });
      writeReturned = true;
      if (!requiresDrain) writer.removeListener('drain', onDrain);
      finishIfFlushed();
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * Shared lifecycle evidence boundary. Callers provide the real DB writer, but
 * it cannot run until stdout confirms that the exact hook payload was flushed.
 */
export async function writeHookOutputBeforeEvidence(
  content: string,
  tool: string,
  hookEventName: HookEventName,
  recordEvidence: () => void | Promise<void>,
  writer: Pick<NodeJS.WriteStream, 'write' | 'once' | 'removeListener'> = process.stdout,
): Promise<void> {
  await writeHookOutput(content, tool, hookEventName, writer);
  await recordEvidence();
}

export async function writeSerializedHookOutputBeforeEvidence(
  output: string,
  recordEvidence: () => void | Promise<void>,
  writer: Pick<NodeJS.WriteStream, 'write' | 'once' | 'removeListener'> = process.stdout,
): Promise<void> {
  await writeSerializedHookOutput(output, writer);
  await recordEvidence();
}
