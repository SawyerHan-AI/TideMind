import { useState, useEffect } from 'react'
import { ExternalLink, RefreshCw, CheckCircle, AlertCircle, Download, RotateCw, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Section } from './shared'
import { useUpdaterState } from '../../hooks/useUpdaterState'

/**
 * About 设置页。
 *
 * **统一状态流**(2026-05-21):整个 UI 完全订阅 updaterState(主进程 updater 模块
 * 的状态机),跟左下角 UpdaterBadge / MandatoryUpdateModal 共用同一个数据源。
 *
 * 删除的历史包袱:
 *   - window.api.app.checkUpdate() 独立 GitHub API 查询(updateStatus / updateInfo)
 *     这条独立路径是 v0.2.69/0.2.70 那个"点击下载变打开网页"bug 的根源 —
 *     React 自管状态 updateStatus='available' 时显示"下载"按钮,但 handler
 *     是 openExternal(releaseUrl) 打开浏览器,跟 in-app updater 完全脱钩。
 *   - "打开 Release 网页"按钮(handleOpenRelease) — 用户明确不再需要,自动更新
 *     已经能完整覆盖下载/安装路径。
 *
 * 两种触发路径(对应 updater.runUpdateCheck 的 autoDownload 参数):
 *   1. 启动 5s / 每 4h 定时 (scheduler.ts):autoDownload=true,直接进 downloading
 *   2. 用户在本页点"检测更新":autoDownload=false,找到新版停在 'available' 等
 *      用户点"下载"按钮 → 调 updater.downloadNow() → 进 downloading
 *
 * 强制更新(mandatory=true)无论触发源都自动下载,这里不需要特殊处理 —
 * MandatoryUpdateModal 会全屏接管。
 */
export function AboutSection() {
  const { t } = useTranslation('settings')
  // fallback 字面量是 6 处版本号同步之一(check-version-sync.mjs 会校验)。
  // 实际值会在 useEffect 里被 IPC 返回的 app.getVersion() 覆盖,这里只是
  // mount 第一帧避免 UI 闪空,以及让 sync 脚本能 grep 到版本号。
  const [currentVersion, setCurrentVersion] = useState('0.2.85')
  const [actionError, setActionError] = useState<string | null>(null)
  // up-to-date 卡片 2.5s 后淡出(audit C-MEDIUM-1)。跟 UpdaterBadge 1.5s 类似但
  // 略长——设置页用户更可能错过短暂提示。新一轮 up-to-date 重置 timer。
  const [showUpToDate, setShowUpToDate] = useState(false)
  const state = useUpdaterState()

  useEffect(() => {
    window.api.app.getVersion().then((v: string) => setCurrentVersion(v)).catch(() => {})
  }, [])

  useEffect(() => {
    if (state.status !== 'up-to-date') {
      setShowUpToDate(false)
      return
    }
    setShowUpToDate(true)
    const timer = window.setTimeout(() => setShowUpToDate(false), 2500)
    return () => window.clearTimeout(timer)
  }, [state.status])

  // 手动 check / downloadNow 失败时的临时反馈:3 秒后自动清除。
  // 不写入 updaterState(那是主进程拥有的状态机,不该被 renderer 错误干扰),
  // 只用 local state 显示一次性 toast。比如 triggerDownload 撞 inflight 锁
  // throw 时,用户能看到提示而不是按钮像坏了一样无反应(audit B-HIGH-3 修复)。
  const showActionError = (err: Error) => {
    setActionError(err.message || t('about.actionFailed', 'Action failed, please retry'))
    window.setTimeout(() => setActionError(null), 3000)
  }

  const handleCheckUpdate = () => {
    setActionError(null)
    // 手动 check 走 autoDownload=false,体感是"查到 → 显示新版 → 点下载"两步
    void window.api.updater.checkNow({ autoDownload: false }).catch(showActionError)
  }

  const handleDownload = () => {
    setActionError(null)
    void window.api.updater.downloadNow().catch(showActionError)
  }

  const handleInstall = () => {
    void window.api.updater.install().catch(() => {})
  }

  const handleOpenLink = (url: string) => {
    void window.api.app.openExternal(url)
  }

  // 顶部按钮:跟状态绑定。只有 idle / up-to-date / error / downloaded 时给可见的
  // 操作按钮,其它状态(checking / available / downloading / signature-invalid /
  // staged-out)用下面的卡片区表达,顶部留白。
  const renderTopAction = () => {
    switch (state.status) {
      case 'idle':
      case 'up-to-date':
      case 'error':
        return (
          <button
            onClick={handleCheckUpdate}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-300 border border-white/10 hover:border-white/20 hover:text-white transition-all"
            style={{ background: 'var(--theme-glass-bg)' }}
          >
            <RefreshCw size={11} />
            {t('about.checkUpdate', 'Check for Updates')}
          </button>
        )
      case 'checking':
        return (
          <span className="flex items-center gap-1.5 text-xs text-gray-400">
            <RefreshCw size={11} className="animate-spin" />
            {t('about.checking', 'Checking...')}
          </span>
        )
      case 'downloaded':
        return (
          <button
            onClick={handleInstall}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-emerald-200 border border-emerald-500/40 hover:border-emerald-500/60 hover:bg-emerald-500/20 transition-all"
            style={{ background: 'rgba(16,185,129,0.12)' }}
          >
            <RotateCw size={11} />
            {t('about.installNow', 'Restart to update')}
          </button>
        )
      default:
        return null
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <Section title="Tide Mind">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400">{t('about.version', 'Version')}</p>
              <p className="text-sm text-gray-200 font-mono mt-0.5">{currentVersion}</p>
            </div>
            {renderTopAction()}
          </div>

          {/* up-to-date:点击"检测更新"后短暂显示 2.5s 然后淡出(audit C-MEDIUM-1) */}
          {state.status === 'up-to-date' && showUpToDate && (
            <div className="flex items-center gap-2 text-emerald-400">
              <CheckCircle size={13} />
              <span className="text-xs">{t('about.upToDate', 'You are on the latest version.')}</span>
            </div>
          )}

          {/* available:手动 check 找到新版,显示"下载"按钮等用户确认。
              注意:自动路径(scheduler)走 autoDownload=true,不会在这里停留 —
              那条路径会被 download-progress 事件直接推到 'downloading'。 */}
          {state.status === 'available' && (
            <div className="p-3 rounded-lg border border-indigo-400/20" style={{ background: 'rgba(129,140,248,0.06)' }}>
              {/* min-w-0 + flex 让长版本号(v1.2.3-beta.foo+bar)在标签那段 truncate,
                  右侧 Download 按钮永远完整可见(audit C-MEDIUM-3) */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs font-medium text-indigo-300 truncate min-w-0">
                  {t('about.newVersion', 'New version available')}: v{state.version}
                </span>
                <button
                  onClick={handleDownload}
                  className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium text-indigo-200 border border-indigo-400/30 hover:border-indigo-400/50 hover:bg-indigo-500/20 transition-all"
                >
                  <Download size={10} />
                  {t('about.downloadNow', 'Download')}
                </button>
              </div>
              {state.releaseNotes && (
                <p className="text-[10px] text-gray-500 leading-relaxed line-clamp-3 whitespace-pre-wrap">
                  {state.releaseNotes}
                </p>
              )}
            </div>
          )}

          {state.status === 'downloading' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-gray-300">
                <span className="flex items-center gap-1.5">
                  <Download size={11} className="text-indigo-400" />
                  {t('about.downloading', 'Downloading {{percent}}%', { percent: state.percent })}
                </span>
                <span className="text-gray-500 font-mono text-[10px]">v{state.version}</span>
              </div>
              <div className="w-full bg-white/[0.06] rounded-full h-1.5">
                <div
                  className="bg-indigo-400 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.max(2, state.percent)}%` }}
                />
              </div>
            </div>
          )}

          {/* downloaded:补卡片显示版本号 + release notes(audit C-HIGH-1 修复)
              顶部按钮已经显示"重启更新",这里给信息密度跟 available 卡片对称。 */}
          {state.status === 'downloaded' && (
            <div className="p-3 rounded-lg border border-emerald-400/20" style={{ background: 'rgba(16,185,129,0.06)' }}>
              <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-emerald-300">
                <CheckCircle size={13} />
                <span>
                  {t('about.downloaded', 'Downloaded, ready to install')}: v{state.version}
                </span>
              </div>
              {state.releaseNotes && (
                <p className="text-[10px] text-gray-500 leading-relaxed line-clamp-3 whitespace-pre-wrap">
                  {state.releaseNotes}
                </p>
              )}
            </div>
          )}

          {state.status === 'signature-invalid' && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10">
              <ShieldAlert size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-red-300">
                {t('about.signatureInvalid', 'Update rejected (signature invalid)')}
              </div>
            </div>
          )}

          {state.status === 'staged-out' && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <CheckCircle size={13} className="text-gray-400" />
              <span>{t('about.stagedOut', "New version rolling out gradually, you'll get it soon")}</span>
            </div>
          )}

          {/* release-pending: cloud-server 已经发了新 manifest 但 GitHub 还没就绪。
              跟 staged-out 同样信息密度(灰色 + 小图标),文案带版本号让用户知道
              要等的版本是什么。audit B-MEDIUM-3 修复:之前这种状态会被错判成
              signature-invalid(红色危险)。 */}
          {state.status === 'release-pending' && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <CheckCircle size={13} className="text-gray-400" />
              <span>
                {t('about.releasePending', "New version v{{version}} is rolling out, you'll get it soon", { version: state.version })}
              </span>
            </div>
          )}

          {state.status === 'error' && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/20 bg-red-500/5">
              <AlertCircle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-red-300/90">
                {t('about.checkFailed', 'Check failed. Please try again later.')}
              </div>
            </div>
          )}

          {/* 临时操作反馈(downloadNow / checkNow IPC reject 时显示 3s)。
              跟 updaterState 解耦,避免主进程状态机被 renderer 错误污染。 */}
          {actionError && (
            <div className="flex items-start gap-2 text-[10px] text-amber-300/80">
              <AlertCircle size={11} className="flex-shrink-0 mt-0.5" />
              <span>{actionError}</span>
            </div>
          )}
        </div>
      </Section>

      <Section title={t('about.links', 'Links')}>
        <div className="space-y-2.5">
          {[
            { label: 'GitHub', url: 'https://github.com/SawyerHan-AI/TideMind' },
            { label: t('about.website', 'Website'), url: 'https://tidemind.ai' },
            { label: t('about.feedback', 'Feedback'), url: 'https://github.com/SawyerHan-AI/TideMind/issues' },
            { label: t('about.docs', 'Documentation'), url: 'https://tidemind.ai/docs' },
          ].map(link => (
            <button
              key={link.url}
              onClick={() => handleOpenLink(link.url)}
              className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 transition-colors group w-full text-left"
            >
              <span className="flex-1">{link.label}</span>
              <ExternalLink size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('about.license', 'License')}>
        <div className="text-xs text-gray-500 space-y-1">
          <p>MIT License</p>
          <p>&copy; 2024-{new Date().getFullYear()} TideMind Contributors</p>
        </div>
      </Section>
    </div>
  )
}
