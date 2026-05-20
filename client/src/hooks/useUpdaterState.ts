import { useEffect, useState } from 'react'
import type { UpdaterState } from '../lib/api-contract'

/**
 * 订阅主进程 updater 状态机。
 *
 * 同步首屏拿一次 getState() 作为初值,之后通过 onStateChanged 推送更新。
 * 抽出来是因为 UpdaterBadge / MandatoryUpdateModal / AboutSection 三处都需要同一份
 * state,模板完全一样(cancelled flag + off() 双保险)。
 *
 * **Race 保护**:`getState()` 是 async invoke。如果 main 进程在它 resolve 之前先
 * 广播了一个 push(例如 5s 后首检触发 'checking'),`onStateChanged` 已经把组件
 * state 更新为 'checking',但稍后 `getState()` resolve 时如果不防护,会用更老的
 * snapshot('idle')覆盖回去,UI 会看到 chip 抖动。
 *
 * 解法:先注册 onStateChanged 再调 getState(订阅顺序保证 push 不丢),用 gotPush
 * 标记位判断:getState resolve 时如果中间已经有过 push,放弃覆盖。
 *
 * 注意:dev 模式下主进程 updater 整套被 !app.isPackaged gate 跳过
 * (client/electron/updater/index.ts:60-63),getState 会返回 { status: 'idle' },
 * onStateChanged 永远不会触发——这是预期行为,不算 bug。
 */
export function useUpdaterState(): UpdaterState {
  const [state, setState] = useState<UpdaterState>({ status: 'idle' })

  useEffect(() => {
    let cancelled = false
    let gotPush = false
    // 先订阅 — push 在 getState resolve 前到达时不丢
    const off = window.api.updater.onStateChanged((s) => {
      gotPush = true
      if (!cancelled) setState(s)
    })
    // 再拉初值,resolve 时如果已经被 push 抢先就放弃覆盖
    window.api.updater.getState().then((s) => {
      if (!cancelled && !gotPush) setState(s)
    }).catch(() => { /* 主进程没准备好就保持 idle */ })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  return state
}
