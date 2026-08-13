import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type MetabolismWorkerRuntimeMutationKind = 'config' | 'connection' | 'strategy' | 'credential'

let listener: ((kind: MetabolismWorkerRuntimeMutationKind) => void) | null = null

export function setMetabolismWorkerRuntimeMutationListener(
  next: ((kind: MetabolismWorkerRuntimeMutationKind) => void) | null,
): void {
  listener = next
}

export function notifyMetabolismWorkerRuntimeMutation(kind: MetabolismWorkerRuntimeMutationKind): void {
  listener?.(kind)
}

export function bindMetabolismWorkerRuntimeMutationRestart(
  requestRestart: (kind: MetabolismWorkerRuntimeMutationKind) => Promise<void>,
  onDegraded: (error: Error) => void,
): () => void {
  const bound = (kind: MetabolismWorkerRuntimeMutationKind): void => {
    void requestRestart(kind).catch(error => onDegraded(error instanceof Error ? error : new Error(String(error))))
  }
  setMetabolismWorkerRuntimeMutationListener(bound)
  return () => {
    if (listener === bound) setMetabolismWorkerRuntimeMutationListener(null)
  }
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function fingerprintMetabolismWorkerExternalRuntimeSources(dataDir: string): string {
  const canonicalDataDir = fs.realpathSync.native(dataDir)
  const candidates: string[] = []
  const maxFiles = 256
  const maxTotalBytes = 2 * 1024 * 1024
  const strategiesDir = path.join(canonicalDataDir, 'strategies')
  if (fs.existsSync(strategiesDir)) {
    const strategiesStat = fs.lstatSync(strategiesDir)
    if (!strategiesStat.isDirectory() || fs.realpathSync.native(strategiesDir) !== strategiesDir) {
      throw new Error('metabolism Worker strategy source must be the canonical data-dir directory')
    }
    for (const name of fs.readdirSync(strategiesDir).sort(codeUnitCompare)) {
      if (name.endsWith('.md')) candidates.push(path.join(strategiesDir, name))
    }
  }
  for (const name of fs.readdirSync(canonicalDataDir).sort(codeUnitCompare)) {
    if (name === 'vertex-credentials.json' || /^vertex-credentials-mc_[a-f0-9]{8}\.json$/.test(name)) {
      candidates.push(path.join(canonicalDataDir, name))
    }
  }
  const hash = crypto.createHash('sha256')
  hash.update('metabolism-worker-external-runtime-sources-v1\0')
  hash.update(canonicalDataDir).update('\0')
  if (candidates.length > maxFiles) throw new Error('too many metabolism Worker runtime source files')
  let totalBytes = 0
  for (const filePath of candidates) {
    const relative = path.relative(canonicalDataDir, filePath)
    const stat = fs.lstatSync(filePath)
    hash.update(relative).update('\0')
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('metabolism Worker runtime source must be a single-link regular file')
    totalBytes += stat.size
    if (totalBytes > maxTotalBytes) throw new Error('metabolism Worker runtime sources exceed size limit')
    hash.update(fs.readFileSync(filePath)).update('\0')
  }
  return hash.digest('hex')
}

export interface MetabolismWorkerExternalRuntimeSourceWatcher {
  acknowledgeCurrent(): void
  poll(): void
  close(): void
}

export function watchMetabolismWorkerExternalRuntimeSources(
  dataDir: string,
  onChange: () => void,
  intervalMs = 10_000,
): MetabolismWorkerExternalRuntimeSourceWatcher {
  let current = fingerprintMetabolismWorkerExternalRuntimeSources(dataDir)
  let closed = false
  let failed = false
  const acknowledgeCurrent = (): void => {
    if (!closed) current = fingerprintMetabolismWorkerExternalRuntimeSources(dataDir)
  }
  const poll = (): void => {
    if (closed) return
    const next = fingerprintMetabolismWorkerExternalRuntimeSources(dataDir)
    if (next === current) return
    current = next
    onChange()
  }
  const timer = setInterval(() => {
    try {
      poll()
      failed = false
    } catch {
      if (!closed && !failed) {
        failed = true
        onChange()
      }
    }
  }, intervalMs)
  timer.unref?.()
  return Object.freeze({
    acknowledgeCurrent,
    poll,
    close(): void {
      if (closed) return
      closed = true
      clearInterval(timer)
    },
  })
}
