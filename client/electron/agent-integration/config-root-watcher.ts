import fs, { type FSWatcher, type WatchOptions } from 'node:fs'
import path from 'node:path'

const DEFAULT_DEBOUNCE_MS = 1_000
const DEFAULT_MAX_WAIT_MS = 5_000

export interface ConfigRootWatcherDependencies {
  lstat(target: string): { isDirectory(): boolean; isSymbolicLink(): boolean }
  realpath(target: string): string
  watch(
    target: string,
    options: WatchOptions,
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ): FSWatcher
  setTimer(callback: () => void, delayMs: number): NodeJS.Timeout
  clearTimer(timer: NodeJS.Timeout): void
}

export interface ConfigRootWatcherOptions {
  allowedRoots: readonly string[]
  onChange: () => void | Promise<void>
  debounceMs?: number
  maxWaitMs?: number
  dependencies?: ConfigRootWatcherDependencies
  onDiagnostic?: (diagnostic: string) => void
}

interface ActiveWatch {
  canonicalRoot: string
  watcher: FSWatcher
}

/**
 * Watches exact, already discovered configuration roots.  It never creates a
 * directory, follows a symlink, reads a config body, or writes host state.
 * Changes are coalesced into a single scan/reconcile request.
 */
export class AgentConfigRootWatcher {
  private readonly dependencies: ConfigRootWatcherDependencies
  private readonly allowedRoots: readonly string[]
  private readonly canonicalAllowedRoots: readonly string[]
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly active = new Map<string, ActiveWatch>()
  private debounceTimer: NodeJS.Timeout | null = null
  private maxWaitTimer: NodeJS.Timeout | null = null
  private callbackInFlight: Promise<void> | null = null
  private callbackQueued = false
  private stopped = false

  constructor(private readonly options: ConfigRootWatcherOptions) {
    this.dependencies = options.dependencies ?? nodeDependencies()
    this.allowedRoots = options.allowedRoots.map(root => path.resolve(root))
    this.canonicalAllowedRoots = this.allowedRoots.map(root => {
      try { return path.resolve(this.dependencies.realpath(root)) } catch { return root }
    })
    this.debounceMs = clampDelay(options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    this.maxWaitMs = Math.max(this.debounceMs, clampDelay(options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS))
  }

  update(configRoots: readonly string[]): void {
    if (this.stopped) return
    const desired = new Map<string, string>()
    for (const candidate of configRoots) {
      try {
        const canonical = this.resolveWatchableRoot(candidate)
        if (canonical) desired.set(canonical, canonical)
      } catch (error) {
        this.options.onDiagnostic?.(`config_root_watch_skipped:${safeDiagnostic(error)}`)
      }
    }

    for (const [canonical, watch] of this.active) {
      if (desired.has(canonical)) continue
      watch.watcher.close()
      this.active.delete(canonical)
    }
    for (const canonical of desired.keys()) {
      if (this.active.has(canonical)) continue
      this.startWatch(canonical)
    }
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    for (const watch of this.active.values()) watch.watcher.close()
    this.active.clear()
    this.clearScheduledTimers()
  }

  private resolveWatchableRoot(candidate: string): string | null {
    const resolved = path.resolve(candidate)
    if (!this.allowedRoots.some(root => pathWithin(root, resolved))) {
      throw new Error('outside_allowed_root')
    }
    let stat: ReturnType<ConfigRootWatcherDependencies['lstat']>
    try {
      stat = this.dependencies.lstat(resolved)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('symbolic_link_root')
    if (!stat.isDirectory()) throw new Error('not_a_directory')
    const canonical = path.resolve(this.dependencies.realpath(resolved))
    if (!this.canonicalAllowedRoots.some(root => pathWithin(root, canonical))) {
      throw new Error('canonical_root_outside_allowed_root')
    }
    return canonical
  }

  private startWatch(canonicalRoot: string): void {
    let watcher: FSWatcher
    const changed = (_eventType: string, filename: string | Buffer | null) => {
      if (!isStandardHostRuntimeWrite(canonicalRoot, filename, this.canonicalAllowedRoots)) this.schedule()
    }
    try {
      watcher = this.dependencies.watch(canonicalRoot, { recursive: true, persistent: false }, changed)
    } catch (error) {
      // Recursive watch is not supported on every platform.  Watching the
      // exact root still observes the common single-file configuration case.
      try {
        watcher = this.dependencies.watch(canonicalRoot, { persistent: false }, changed)
      } catch (fallbackError) {
        this.options.onDiagnostic?.(`config_root_watch_failed:${safeDiagnostic(fallbackError ?? error)}`)
        return
      }
    }
    watcher.on('error', error => {
      this.options.onDiagnostic?.(`config_root_watch_error:${safeDiagnostic(error)}`)
      watcher.close()
      this.active.delete(canonicalRoot)
    })
    this.active.set(canonicalRoot, { canonicalRoot, watcher })
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.debounceTimer) this.dependencies.clearTimer(this.debounceTimer)
    this.debounceTimer = this.dependencies.setTimer(() => this.flush(), this.debounceMs)
    this.debounceTimer.unref?.()
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = this.dependencies.setTimer(() => this.flush(), this.maxWaitMs)
      this.maxWaitTimer.unref?.()
    }
  }

  private flush(): void {
    if (this.stopped) return
    this.clearScheduledTimers()
    if (this.callbackInFlight) {
      this.callbackQueued = true
      return
    }
    const run = Promise.resolve(this.options.onChange())
      .catch(error => this.options.onDiagnostic?.(`config_root_watch_callback_failed:${safeDiagnostic(error)}`))
      .finally(() => {
        if (this.callbackInFlight !== run) return
        this.callbackInFlight = null
        if (this.callbackQueued && !this.stopped) {
          this.callbackQueued = false
          this.flush()
        }
      })
    this.callbackInFlight = run
  }

  private clearScheduledTimers(): void {
    if (this.debounceTimer) this.dependencies.clearTimer(this.debounceTimer)
    if (this.maxWaitTimer) this.dependencies.clearTimer(this.maxWaitTimer)
    this.debounceTimer = null
    this.maxWaitTimer = null
  }
}

// Standard hosts keep transcripts/databases beside configuration. Those writes
// are not configuration changes and can otherwise schedule scans indefinitely.
function isStandardHostRuntimeWrite(root: string, filename: string | Buffer | null, allowedRoots: readonly string[]): boolean {
  if (filename == null) return false
  const name = typeof filename === 'string' ? filename : filename.toString('utf8')
  const relative = (path.isAbsolute(name) ? path.relative(root, name) : path.normalize(name)).replace(/\\/g, '/')
  const standard = allowedRoots.map(home => path.relative(home, root).replace(/\\/g, '/'))
  const head = relative.split('/')[0]
  if (standard.includes('.codex')) {
    return ['tmp', 'sessions', 'archived_sessions', 'worktrees', 'log', 'logs'].includes(head)
      || ['history.jsonl', 'session_index.jsonl'].includes(relative)
      // Desktop window/sidebar/chat state is not a managed MCP/Hook surface.
      || /^\.{1,2}codex-global-state\.json(?:\.bak)?(?:\.tmp-[A-Za-z0-9-]+)?$/.test(relative)
      || /^(?:state|logs)_\d+\.sqlite(?:-(?:wal|shm))?$/.test(relative)
  }
  if (standard.includes('.cursor')) return head === 'projects'
  if (standard.includes('.zcode/cli')) return ['db', 'log', 'exec', 'rollout', 'image-cache'].includes(head)
  return false
}

function nodeDependencies(): ConfigRootWatcherDependencies {
  return {
    lstat: target => fs.lstatSync(target),
    realpath: target => fs.realpathSync.native(target),
    watch: (target, options, listener) => fs.watch(target, options, listener),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: timer => clearTimeout(timer),
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function clampDelay(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DEBOUNCE_MS
  return Math.max(1, Math.round(value))
}

function safeDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown'
  return error.message.replace(/[\\/][^\s:]*/gu, '<path>').slice(0, 160)
}
