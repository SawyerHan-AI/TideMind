import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { CliProcessRegistry } from '@server/llm/cli/child-process-runner.js'
import { CliLLMError } from '@server/llm/cli/errors.js'
import { hasCodexRouteOverride } from '@server/llm/cli/codex-declared-routing.js'

/** config/read includes per-setting provenance even with includeLayers=false.
 * This is bounded protocol metadata, separate from model text and stderr. */
export const CODEX_AUTHENTICATION_METADATA_LIMITS = Object.freeze({
  stdoutBytes: 1024 * 1024,
  stderrBytes: 64 * 1024,
})

/** A-side metadata only. Never requests a thread/turn or a credential refresh.
 * The native server may independently perform account discovery or recovery. */
export async function readAgentCodexAuthentication(input: {
  executable: string; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal
}): Promise<{ account: unknown; configuration: unknown | null; routingBlocked?: true }> {
  const registry = new CliProcessRegistry()
  if (input.signal.aborted) throw new CliLLMError('aborted', 'Authentication check cancelled')
  const child = spawn(input.executable, ['app-server', '--listen', 'stdio://',
    '-c', 'mcp_servers={}', '-c', 'hooks={}', '-c', 'notify=[]', '-c', 'plugins={}',
    '-c', 'apps={}', '-c', 'marketplaces={}', '-c', 'web_search="disabled"'], {
    cwd: input.cwd, env: input.env, detached: process.platform !== 'win32', shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  registry.registerAdmitted(child)
  let nextId = 0, stdoutBytes = 0, stderrBytes = 0, buffer = ''
  let fatal: CliLLMError | null = null
  const decoder = new StringDecoder('utf8')
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const fail = (error: CliLLMError) => {
    fatal ??= error
    for (const waiter of pending.values()) waiter.reject(fatal)
    pending.clear()
  }
  const accountBytes = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    if (stream === 'stdout') stdoutBytes += chunk.byteLength
    else stderrBytes += chunk.byteLength
    if (stdoutBytes > CODEX_AUTHENTICATION_METADATA_LIMITS.stdoutBytes
      || stderrBytes > CODEX_AUTHENTICATION_METADATA_LIMITS.stderrBytes) {
      fail(new CliLLMError('output_limit', 'Authentication metadata output limit'))
    }
  }
  child.stdout.on('data', (chunk: Buffer) => {
    accountBytes(chunk, 'stdout')
    if (fatal) return
    buffer += decoder.write(chunk)
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      let message: Record<string, unknown>
      try {
        const value: unknown = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape')
        message = value as Record<string, unknown>
      } catch { fail(new CliLLMError('protocol', 'Invalid authentication response')); return }
      if ('method' in message) {
        // Metadata checks never approve native permissions or answer elicitation.
        if ('id' in message) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          error: { code: -32601, message: 'Not supported by authentication check' } }) + '\n')
        continue
      }
      if (typeof message.id !== 'number') continue
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if (message.error) {
        const code = (message.error as { code?: unknown }).code
        waiter.reject(new CliLLMError(code === -32601 ? 'unsupported_version' : 'protocol', 'Authentication method unavailable'))
      } else waiter.resolve(message.result)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => accountBytes(chunk, 'stderr'))
  child.on('error', () => fail(new CliLLMError('process_crash', 'Authentication process failed')))
  child.stdin.on('error', () => fail(new CliLLMError('process_crash', 'Authentication transport failed')))
  child.on('close', () => fail(new CliLLMError('process_crash', 'Authentication process exited')))
  const abort = () => fail(new CliLLMError('aborted', 'Authentication check cancelled'))
  input.signal.addEventListener('abort', abort, { once: true })
  const request = (method: 'initialize' | 'config/read' | 'account/read', params: unknown): Promise<unknown> => {
    if (fatal) return Promise.reject(fatal)
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  try {
    if (input.signal.aborted) abort()
    await request('initialize', { clientInfo: { name: 'tidemind-authentication', version: '1' } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
    let configuration: unknown | null = null
    try { configuration = await request('config/read', { includeLayers: false }) }
    catch (error) { if (!(error instanceof CliLLMError) || error.kind !== 'unsupported_version') throw error }
    if (hasCodexRouteOverride((configuration as { config?: unknown } | null)?.config)) {
      return { account: null, configuration, routingBlocked: true }
    }
    const account = await request('account/read', { refreshToken: false })
    return { account, configuration }
  } finally {
    input.signal.removeEventListener('abort', abort)
    child.stdin.end()
    await registry.unregister(child)
  }
}
