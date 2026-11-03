
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {contextRestoreKey,type ContextRestoreScope} from './hook-codex-context-restore.js';

export const CODEX_RESTORE_CAPTURE_NONCE = /^[A-Za-z0-9_-]{16,128}$/;
export function codexRestoreCaptureFileName(nonce: string): string {
  if (!CODEX_RESTORE_CAPTURE_NONCE.test(nonce)) throw new Error('codex_restore_capture_nonce_invalid');
  return nonce + '.post-compact.json';
}

/** Opt-in, one bounded evidence file. It is an observation, never a native ACK. */
export function recordCodexPostCompactCapture(
  scope: ContextRestoreScope,
  input: {sessionId:string;turnId:string;trigger?:'manual'|'auto'},
  revision: number,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const nonce=environment.TIDEMIND_CODEX_RESTORE_CAPTURE_NONCE;
  const directory=environment.TIDEMIND_CODEX_RESTORE_CAPTURE_DIR;
  if (!nonce && !directory) return false;
  try {
    if (!nonce || !directory || !path.isAbsolute(directory)
      || !input.sessionId || !input.turnId || input.sessionId!==scope.sessionId
      || (input.trigger!=='manual' && input.trigger!=='auto')
      || !Number.isSafeInteger(revision) || revision<1) return false;
    const file=codexRestoreCaptureFileName(nonce);
    const stat=fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const data=JSON.stringify({
      schemaVersion:1,captureNonce:nonce,observedAt:new Date().toISOString(),
      eventName:'PostCompact',sessionId:input.sessionId,turnId:input.turnId,trigger:input.trigger,
      generationSha256:createHash('sha256').update(JSON.stringify(scope.generation)).digest('hex'),
      scopeKey:contextRestoreKey(scope),revision,
    });
    if (Buffer.byteLength(data)>16*1024) return false;
    const fd=fs.openSync(path.join(directory,file),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try { fs.writeFileSync(fd,data+'\n'); } finally { fs.closeSync(fd); }
    return true;
  } catch {
    // Missing evidence must not suppress normal marker creation or hook output.
    process.stderr.write('[eb:codex-restore] capture_unavailable\n');
    return false;
  }
}
