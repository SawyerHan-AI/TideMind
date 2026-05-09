import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteSourceInitSnapshot } from '../../../lib/api-contract'

/**
 * 与主进程 InitSessionManager 对齐的客户端 hook。
 *
 * UI 状态完全由 snapshot.status 派生——不再像旧 hook 那样硬编码 'interrupted'
 * 初值与后端真实状态脱节。
 *
 * 使用方式：
 *   const { snapshot, uiState, start, abort, discard } = useInitSession(source.id)
 *   if (uiState === 'running') { /* 显示进度条 *\/ }
 */
export type InitUiState =
  | 'loading'    // mount 后第一次 fetch 中
  | 'idle'       // 没有 session，可以启动
  | 'running'
  | 'aborting'
  | 'aborted'
  | 'error'
  | 'done'

interface UseInitSessionOptions {
  /** 状态进入终态时回调（用于关掉 modal、refetch 列表等） */
  onTerminal?: (snapshot: NoteSourceInitSnapshot) => void
  /**
   * 轮询间隔，毫秒。设 0 禁用轮询。
   * 默认 5000——主要靠 onSessionEvent 推送实时更新；轮询只作为兜底，
   * 防止丢失事件（窗口刚 mount 时、推送通道意外断开等场景）。
   */
  pollIntervalMs?: number
}

export function useInitSession(
  sourceId: string | null,
  options: UseInitSessionOptions = {},
) {
  const { onTerminal, pollIntervalMs = 5000 } = options
  const [snapshot, setSnapshot] = useState<NoteSourceInitSnapshot | null>(null)
  const [loaded, setLoaded] = useState(false)
  // aborting / discarding 各自的瞬时 busy（UI 禁用按钮用），互不阻塞 start。
  const [aborting, setAborting] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const onTerminalRef = useRef(onTerminal)
  onTerminalRef.current = onTerminal
  const lastTerminalKeyRef = useRef<string | null>(null)
  const sourceIdRef = useRef(sourceId)
  sourceIdRef.current = sourceId

  // 拉取一次 snapshot
  const refresh = useCallback(async () => {
    if (!sourceId) return null
    try {
      const snap = await window.api.noteSources.initSnapshot(sourceId)
      if (sourceIdRef.current !== sourceId) return null
      setSnapshot(snap)
      setLoaded(true)
      return snap
    } catch {
      if (sourceIdRef.current !== sourceId) return null
      setSnapshot(null)
      setLoaded(true)
      return null
    }
  }, [sourceId])

  // 首次加载 + 推送 + 兜底轮询
  useEffect(() => {
    if (!sourceId) {
      setSnapshot(null)
      setLoaded(true)
      return
    }
    setSnapshot(null)
    lastTerminalKeyRef.current = null
    setLoaded(false)
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const handleSnapshot = (snap: NoteSourceInitSnapshot | null) => {
      if (cancelled || !snap) return
      // 仅处理与本 hook 相关的 sourceId（推送是全局广播）
      if (snap.sourceId !== sourceId) return
      setSnapshot(snap)
      setLoaded(true)
      if (
        snap.status === 'done' || snap.status === 'aborted' || snap.status === 'error'
      ) {
        const key = `${snap.sourceId}:${snap.status}:${snap.progress.startedAt ?? ''}`
        if (lastTerminalKeyRef.current !== key) {
          lastTerminalKeyRef.current = key
          onTerminalRef.current?.(snap)
        }
      } else if (snap.status === 'running' || snap.status === 'aborting') {
        lastTerminalKeyRef.current = null
      }
    }

    const tick = async () => {
      if (cancelled) return
      const snap = await refresh()
      handleSnapshot(snap)
    }

    // 推送订阅（主路径）
    const unsubscribe = window.api.noteSources.onSessionEvent((snap) => {
      handleSnapshot(snap as NoteSourceInitSnapshot)
    })

    // mount 拉一次完整 snapshot（推送可能错过当前状态）
    tick()
    // 兜底轮询
    if (pollIntervalMs > 0) {
      timer = setInterval(tick, pollIntervalMs)
    }
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      unsubscribe()
    }
  }, [pollIntervalMs, refresh, sourceId])

  // 操作
  // start: 不 await—— logseq 分支的 IPC 会一直阻塞到终态，由 polling 接管状态更新。
  // 同时立即 refresh 让 UI 尽快从 idle 切到 running。
  const start = useCallback((): void => {
    if (!sourceId) return
    void window.api.noteSources.initStart(sourceId)
      .catch(() => null)
      .finally(() => {
        void refresh()
      })
    void refresh()
  }, [refresh, sourceId])

  const abort = useCallback(async (): Promise<void> => {
    if (!sourceId || aborting) return
    setAborting(true)
    try {
      await window.api.noteSources.initAbort(sourceId)
      await refresh()
    } finally {
      setAborting(false)
    }
  }, [aborting, refresh, sourceId])

  const discard = useCallback(async (): Promise<void> => {
    if (!sourceId || discarding) return
    setDiscarding(true)
    try {
      await window.api.noteSources.rollback(sourceId)
      await refresh()
    } finally {
      setDiscarding(false)
    }
  }, [discarding, refresh, sourceId])

  const uiState: InitUiState = useMemo(() => {
    if (!loaded) return 'loading'
    if (!snapshot) return 'idle'
    return snapshot.status as InitUiState
  }, [loaded, snapshot])

  return {
    snapshot,
    uiState,
    aborting,
    discarding,
    start,
    abort,
    discard,
    refresh,
  }
}
