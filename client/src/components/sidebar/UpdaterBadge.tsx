import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useUpdaterState } from '../../hooks/useUpdaterState'

/**
 * 自动更新状态 chip:左下角状态栏,与 LLMHealthBadge / CloudStatus 一致风格。
 *
 * 涵盖 9 个 status 中需要用户感知的 5 类(checking / downloading / downloaded /
 * error / signature-invalid)外加短暂的 up-to-date(1.5s 后淡出)和 available
 * (非 mandatory 时的提示)。
 *
 * **Mandatory 互斥**:state.mandatory === true 时整个组件返回 null,让
 * MandatoryUpdateModal 全屏接管视野——避免状态栏 chip 与全屏 modal 双重提示。
 * Modal 内部的 snooze 计时(`snoozedUntil`)只影响 modal 自身渲染,**不会改
 * state.mandatory**,所以 UpdaterBadge 在 snooze 期内仍然返回 null —— 这是
 * 有意为之:snooze 是 modal 内部的"用户主动延后"行为,不应该在状态栏退化成弱提示。
 * 如未来需要在 snooze 期内提示用户,应在 Modal 内部实现而非这里。
 *
 * 视觉规范严格复用 LLMHealthBadge.tsx / CloudStatus.tsx,不引入新颜色 / 新尺寸。
 */
export function UpdaterBadge() {
  const { t } = useTranslation('common')
  const navigate = useNavigate()
  const state = useUpdaterState()

  // up-to-date 状态显示 1.5s 后淡出,避免长期占用状态栏一行。
  // 进入新一轮 up-to-date 重置 timer。
  const [showUpToDate, setShowUpToDate] = useState(false)
  useEffect(() => {
    if (state.status !== 'up-to-date') {
      setShowUpToDate(false)
      return
    }
    setShowUpToDate(true)
    const timer = setTimeout(() => setShowUpToDate(false), 1500)
    return () => clearTimeout(timer)
  }, [state.status])

  // mandatory 时让 modal 接管,状态栏不重复提示(见顶部 docstring "Mandatory 互斥")
  if (
    (state.status === 'available' || state.status === 'downloaded') &&
    state.mandatory === true
  ) {
    return null
  }

  // 不渲染的稳定状态:idle / staged-out(灰度未命中,用户视角等价 idle)/ up-to-date 过 1.5s
  if (state.status === 'idle' || state.status === 'staged-out') return null
  if (state.status === 'up-to-date' && !showUpToDate) return null

  // —— 各状态的视觉与交互
  let dotClass = ''
  let dotShadow = 'none'
  let label = ''
  let title = ''
  let onClick: (() => void) | null = null

  switch (state.status) {
    case 'checking':
      dotClass = 'bg-gray-400 animate-pulse'
      dotShadow = '0 0 6px rgba(156,163,175,0.4)'
      label = t('updater.checking', 'Checking…')
      title = label
      break
    case 'up-to-date':
      dotClass = 'bg-gray-500'
      label = t('updater.upToDate', 'Up to date')
      title = label
      break
    case 'available':
      // 'available' 状态在两种情况下停留:
      //   1. 用户在设置页点"检测更新"(autoDownload=false),停在这里等用户决定
      //   2. 自动路径(autoDownload=true)的极短瞬态(随后立刻被 download-progress
      //      事件推进到 'downloading')
      // 用户视角看到的几乎只是 case 1,所以把这个 chip 变成可点击的"立即下载"
      // 入口 — 不强迫用户跳到设置页才能下载。
      // mandatory available 在前面已经被拦截(让 MandatoryUpdateModal 接管),
      // 这里只剩非 mandatory 的可选下载。
      dotClass = 'bg-indigo-400 animate-pulse'
      dotShadow = '0 0 6px rgba(129,140,248,0.5)'
      label = t('updater.availableClickToDownload', 'v{{version}} · Download', { version: state.version })
      title = t('updater.availableTitle', 'New version v{{version}} available. Click to download.', { version: state.version })
      onClick = () => { void window.api.updater.downloadNow() }
      break
    case 'downloading':
      dotClass = 'bg-blue-400 animate-pulse'
      dotShadow = '0 0 6px rgba(96,165,250,0.5)'
      label = t('updater.downloading', 'Downloading {{percent}}%', {
        percent: Math.round(state.percent),
      })
      title = t('updater.downloadingTitle', 'Downloading v{{version}}', { version: state.version })
      break
    case 'downloaded':
      // mandatory 已在上面拦截,这里只剩非 mandatory 的可重启 chip。
      // CTA 词("Restart")放左边:truncate 在 sidebar w-56 + 长版本号时优先保留 CTA,
      // 版本号被切是可接受的(用户已能从 Settings 查看完整版本号)。
      dotClass = 'bg-emerald-400'
      dotShadow = '0 0 6px rgba(52,211,153,0.4)'
      label = t('updater.readyShort', 'Restart · v{{version}}', { version: state.version })
      title = label
      onClick = () => { void window.api.updater.install() }
      break
    case 'error':
      // 普通失败(网络 / GitHub 不可达 / 解析失败) — 静态红色,不脉冲。
      // title 不灌 state.message:原始错误可能含 URL / 路径 / 堆栈,不该泄露给系统 tooltip。
      // 想看具体错误请去 Settings → About 的错误卡片。
      dotClass = 'bg-red-400'
      dotShadow = '0 0 6px rgba(248,113,113,0.4)'
      label = t('updater.error', 'Update failed')
      title = label
      break
    case 'signature-invalid':
      // 签名失败 — 红色脉冲,严重程度高于普通 error(可能 supply chain)。
      // 优先打开 releaseUrl 手动下载;无 url 时降级跳设置页(参照 LLMHealthBadge:75)。
      dotClass = 'bg-red-400 animate-pulse'
      dotShadow = '0 0 6px rgba(248,113,113,0.6)'
      label = t('updater.signatureInvalid', 'Signature invalid')
      title = label
      if (state.releaseUrl) {
        const url = state.releaseUrl
        onClick = () => { void window.api.app.openExternal(url) }
      } else {
        onClick = () => { navigate('/settings') }
      }
      break
    default: {
      // 穷尽性检查:未来给 UpdaterState 加新 status 时,这一行会触发 TypeScript 错误,
      // 强制开发者在这里加显式分支(否则会渲染一个空 chip)。
      const _exhaustive: never = state
      void _exhaustive
      return null
    }
  }

  const dot = (
    <div
      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClass}`}
      style={{ boxShadow: dotShadow }}
    />
  )
  const text = <span className="text-[10px] text-gray-500 truncate">{label}</span>

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className="w-full px-4 py-1.5 flex items-center gap-2 min-h-[28px] hover:bg-white/[0.03] transition-colors text-left"
      >
        {dot}
        {text}
      </button>
    )
  }
  return (
    <div className="px-4 py-1.5 flex items-center gap-2 min-h-[28px]" title={title}>
      {dot}
      {text}
    </div>
  )
}
