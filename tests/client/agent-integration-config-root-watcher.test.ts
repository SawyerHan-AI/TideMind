import { EventEmitter } from 'node:events'
import fs, { type FSWatcher } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentConfigRootWatcher,
  type ConfigRootWatcherDependencies,
} from '../../client/electron/agent-integration/config-root-watcher'

const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-agent-watch-'))
  roots.push(root)
  return root
}

class FakeWatcher extends EventEmitter {
  closed = false
  close() { this.closed = true }
  ref() { return this as unknown as FSWatcher }
  unref() { return this as unknown as FSWatcher }
}

function dependencies(records: Array<{ target: string; watcher: FakeWatcher }>): ConfigRootWatcherDependencies {
  return {
    lstat: target => fs.lstatSync(target),
    realpath: target => fs.realpathSync.native(target),
    watch(target, _options, listener) {
      const watcher = new FakeWatcher()
      watcher.on('change', listener)
      records.push({ target, watcher })
      return watcher as unknown as FSWatcher
    },
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: timer => clearTimeout(timer),
  }
}

describe('AgentConfigRootWatcher', () => {
  it('只监听 allowed root 下的精确非 symlink 配置目录', () => {
    const home = fixtureRoot()
    const config = path.join(home, '.cursor')
    const outside = fixtureRoot()
    fs.mkdirSync(config)
    const link = path.join(home, '.linked')
    fs.symlinkSync(config, link)
    const records: Array<{ target: string; watcher: FakeWatcher }> = []
    const diagnostics: string[] = []
    const watcher = new AgentConfigRootWatcher({
      allowedRoots: [home],
      onChange: vi.fn(),
      dependencies: dependencies(records),
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    })

    watcher.update([config, link, outside])

    expect(records.map(record => record.target)).toEqual([fs.realpathSync.native(config)])
    expect(diagnostics).toContain('config_root_watch_skipped:symbolic_link_root')
    expect(diagnostics).toContain('config_root_watch_skipped:outside_allowed_root')
    watcher.close()
    expect(records[0].watcher.closed).toBe(true)
  })

  it('debounce 合并事件，并在 callback 运行期间最多排队一次', async () => {
    vi.useFakeTimers()
    const home = fixtureRoot()
    const config = path.join(home, '.cursor')
    fs.mkdirSync(config)
    const records: Array<{ target: string; watcher: FakeWatcher }> = []
    let release: (() => void) | undefined
    const onChange = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const watcher = new AgentConfigRootWatcher({
      allowedRoots: [home],
      onChange,
      debounceMs: 100,
      maxWaitMs: 500,
      dependencies: dependencies(records),
    })
    watcher.update([config])

    records[0].watcher.emit('change', 'change', 'settings.json')
    records[0].watcher.emit('change', 'rename', 'settings.json')
    await vi.advanceTimersByTimeAsync(99)
    expect(onChange).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onChange).toHaveBeenCalledTimes(1)

    records[0].watcher.emit('change', 'change', 'settings.json')
    await vi.advanceTimersByTimeAsync(100)
    expect(onChange).toHaveBeenCalledTimes(1)
    release?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(onChange).toHaveBeenCalledTimes(2)
    watcher.close()
  })

  it('更新 root 集合会关闭已移除 watcher 且不重复订阅', () => {
    const home = fixtureRoot()
    const first = path.join(home, '.cursor')
    const second = path.join(home, '.qwen')
    fs.mkdirSync(first)
    fs.mkdirSync(second)
    const records: Array<{ target: string; watcher: FakeWatcher }> = []
    const watcher = new AgentConfigRootWatcher({
      allowedRoots: [home],
      onChange: vi.fn(),
      dependencies: dependencies(records),
    })

    watcher.update([first])
    watcher.update([first, second])
    watcher.update([second])

    expect(records.map(record => record.target)).toEqual([
      fs.realpathSync.native(first),
      fs.realpathSync.native(second),
    ])
    expect(records[0].watcher.closed).toBe(true)
    expect(records[1].watcher.closed).toBe(false)
    watcher.close()
  })

  it('配置目录尚未由宿主创建时静默等待下一次扫描', () => {
    const home = fixtureRoot()
    const records: Array<{ target: string; watcher: FakeWatcher }> = []
    const diagnostics: string[] = []
    const watcher = new AgentConfigRootWatcher({
      allowedRoots: [home],
      onChange: vi.fn(),
      dependencies: dependencies(records),
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    })

    watcher.update([path.join(home, '.not-created-yet')])

    expect(records).toEqual([])
    expect(diagnostics).toEqual([])
    watcher.close()
  })
})
