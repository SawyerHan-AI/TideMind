import { Check, CheckCircle, ChevronLeft, ChevronRight, Copy, FolderOpen, Loader2, Package, Terminal, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isCodexV2Version, isGeminiHooksReady } from './toolTypes'

interface AgentWizardPluginStepProps {
  pluginGenerating: boolean
  pluginError: string
  pluginGenerated: boolean
  pluginDir: string
  cliAvailable: boolean
  installing: boolean
  installResult: { success: boolean; message: string } | null
  installCommand: string
  codexVersion: string | null
  geminiVersion: string | null
  desktopConfigWritten: boolean
  copied: string | null
  isCowork: boolean
  isCursor: boolean
  isCodex: boolean
  isWindsurf: boolean
  isOpenClaw: boolean
  isGemini: boolean
  onInstallPlugin: () => void
  onCopy: (text: string, key: string) => void
  onPrevious: () => void
  onNext: () => void
}

export function AgentWizardPluginStep({
  pluginGenerating,
  pluginError,
  pluginGenerated,
  pluginDir,
  cliAvailable,
  installing,
  installResult,
  installCommand,
  codexVersion,
  geminiVersion,
  desktopConfigWritten,
  copied,
  isCowork,
  isCursor,
  isCodex,
  isWindsurf,
  isOpenClaw,
  isGemini,
  onInstallPlugin,
  onCopy,
  onPrevious,
  onNext,
}: AgentWizardPluginStepProps) {
  const { t } = useTranslation('settings')

  return (
    <div className="space-y-3">
      {pluginGenerating ? (
        <div className="flex items-center gap-2 py-8 justify-center text-xs text-gray-500">
          <Loader2 size={14} className="animate-spin" />
          {t('agent.wizard.generatingPlugin')}
        </div>
      ) : pluginError ? (
        <div className="px-3 py-2 bg-red-500/5 border border-red-500/10 rounded-lg">
          <p className="text-[10px] text-red-400">{t('agent.wizard.pluginGenerateFailed')}:{pluginError}</p>
        </div>
      ) : pluginGenerated ? (
        <>
          {/* 生成成功 */}
          <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/10 rounded-lg">
            <CheckCircle size={12} className="text-emerald-400 flex-shrink-0" />
            <span className="text-xs text-emerald-400">{t('agent.pluginGenerated')}</span>
          </div>

          {/* 插件包含的内容 */}
          <div className="px-3 py-2 bg-white/[0.02] border border-white/5 rounded-lg space-y-1.5">
            <p className="text-[10px] text-gray-400 font-medium">{t('agent.wizard.completed')}:</p>
            {isCowork ? (
              <>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.cowork.skillFile')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  {desktopConfigWritten
                    ? <CheckCircle size={10} className="text-emerald-400/60" />
                    : <XCircle size={10} className="text-red-400/60" />}
                  {t('agent.wizard.cowork.desktopMcpConfig')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.cowork.skillDownloaded')}
                </div>
              </>
            ) : isCursor ? (
              <>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  {desktopConfigWritten
                    ? <CheckCircle size={10} className="text-emerald-400/60" />
                    : <XCircle size={10} className="text-red-400/60" />}
                  {t('agent.wizard.cursor.mcpConfig')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.cursor.skillDownloaded')}
                </div>
              </>
            ) : isCodex ? (
              <>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  {desktopConfigWritten
                    ? <CheckCircle size={10} className="text-emerald-400/60" />
                    : <XCircle size={10} className="text-red-400/60" />}
                  {t('agent.wizard.codex.mcpConfig')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.codex.hookConfig')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {isCodexV2Version(codexVersion)
                    ? t('agent.wizard.codex.skillInjected')
                    : t('agent.wizard.codex.agentsDownloaded')}
                </div>
              </>
            ) : isWindsurf ? (
              <>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  {desktopConfigWritten
                    ? <CheckCircle size={10} className="text-emerald-400/60" />
                    : <XCircle size={10} className="text-red-400/60" />}
                  {t('agent.wizard.windsurf.mcpConfig')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.windsurf.rulesDownloaded')}
                </div>
              </>
            ) : isOpenClaw ? (
              <>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  {desktopConfigWritten
                    ? <CheckCircle size={10} className="text-emerald-400/60" />
                    : <XCircle size={10} className="text-red-400/60" />}
                  {t('agent.wizard.openclaw.mcpConfig')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.openclaw.hookConfig')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.openclaw.skillDownloaded')}
                </div>
              </>
            ) : isGemini ? (
              <>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  {desktopConfigWritten
                    ? <CheckCircle size={10} className="text-emerald-400/60" />
                    : <XCircle size={10} className="text-red-400/60" />}
                  {t('agent.wizard.gemini.mcpConfig')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.gemini.hookConfig')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.gemini.contextFile')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.gemini.commands')}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.claudeCode.mcpConfig')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.claudeCode.skillFile')}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <CheckCircle size={10} className="text-emerald-400/60" />
                  {t('agent.wizard.claudeCode.hooks')}
                </div>
              </>
            )}
          </div>

          {/* 插件路径 */}
          <div className="flex items-center gap-2">
            <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
            <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
          </div>

          {/* 安装方式 */}
          {isCowork ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
              </div>
              <div className="px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg space-y-1">
                <p className="text-[10px] text-indigo-400 font-medium">{t('agent.wizard.manualStepsTitle')}</p>
                <p className="text-[10px] text-indigo-400">{t('agent.wizard.cowork.step1')}</p>
                <p className="text-[10px] text-indigo-400">{t('agent.wizard.cowork.step2')}</p>
                <p className="text-[10px] text-indigo-400">{t('agent.wizard.cowork.step3')}</p>
              </div>
            </div>
          ) : isCursor ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
              </div>
              <div className="px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg space-y-1">
                <p className="text-[10px] text-indigo-400 font-medium">{t('agent.wizard.manualStepsTitle')}</p>
                <p className="text-[10px] text-indigo-400">{t('agent.wizard.cursor.step1')}</p>
                <p className="text-[10px] text-indigo-400">{t('agent.wizard.cursor.step2')}</p>
                <p className="text-[10px] text-gray-500">{t('agent.wizard.cursor.mcpNote')}</p>
              </div>
            </div>
          ) : isCodex ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
              </div>
              {isCodexV2Version(codexVersion) ? (
                <div className="px-3 py-2 bg-emerald-400/5 border border-emerald-400/10 rounded-lg space-y-1">
                  <p className="text-[10px] text-emerald-400 font-medium">{t('agent.wizard.codex.autoReadyTitle')}</p>
                  <p className="text-[10px] text-emerald-400">{t('agent.wizard.codex.autoReadyNote')}</p>
                </div>
              ) : (
                <div className="px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg space-y-1">
                  <p className="text-[10px] text-indigo-400 font-medium">{t('agent.wizard.manualStepsTitle')}</p>
                  <p className="text-[10px] text-indigo-400">{t('agent.wizard.codex.step1')}</p>
                  <p className="text-[10px] text-indigo-400">{t('agent.wizard.codex.step2')}</p>
                  <p className="text-[10px] text-gray-500">{t('agent.wizard.codex.mcpNote')}</p>
                  {codexVersion && (
                    <p className="text-[10px] text-amber-400 mt-1">
                      {t('agent.wizard.codex.upgradeHint', { version: codexVersion })}
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : isWindsurf ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
              </div>
              <div className="px-3 py-2 bg-blue-500/5 border border-blue-500/10 rounded-lg space-y-1">
                <p className="text-[10px] text-blue-400 font-medium">{t('agent.wizard.manualStepsTitle')}</p>
                <p className="text-[10px] text-blue-400">{t('agent.wizard.windsurf.step1')}</p>
                <p className="text-[10px] text-blue-400">{t('agent.wizard.windsurf.step2')}</p>
                <p className="text-[10px] text-gray-500">{t('agent.wizard.windsurf.mcpNote')}</p>
              </div>
            </div>
          ) : isOpenClaw ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
              </div>
              <div className="px-3 py-2 bg-blue-500/5 border border-blue-500/10 rounded-lg space-y-1">
                <p className="text-[10px] text-blue-400 font-medium">{t('agent.wizard.manualStepsTitle')}</p>
                <p className="text-[10px] text-blue-400">{t('agent.wizard.openclaw.step1')}</p>
                <p className="text-[10px] text-blue-400">{t('agent.wizard.openclaw.step2')}</p>
                <p className="text-[10px] text-gray-500">{t('agent.wizard.openclaw.mcpNote')}</p>
              </div>
            </div>
          ) : isGemini ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
              </div>
              {isGeminiHooksReady(geminiVersion) ? (
                <div className="px-3 py-2 bg-emerald-400/5 border border-emerald-400/10 rounded-lg space-y-1">
                  <p className="text-[10px] text-emerald-400 font-medium">{t('agent.wizard.gemini.autoReadyTitle')}</p>
                  <p className="text-[10px] text-emerald-400">{t('agent.wizard.gemini.autoReadyNote')}</p>
                </div>
              ) : (
                <div className="px-3 py-2 bg-amber-500/5 border border-amber-500/10 rounded-lg space-y-1">
                  <p className="text-[10px] text-amber-400 font-medium">{t('agent.wizard.gemini.upgradeTitle')}</p>
                  <p className="text-[10px] text-amber-400">
                    {t('agent.wizard.gemini.upgradeHint', { version: geminiVersion ?? 'unknown' })}
                  </p>
                  <p className="text-[10px] text-gray-500">{t('agent.wizard.gemini.upgradeNote')}</p>
                </div>
              )}
            </div>
          ) : cliAvailable ? (
            <div className="space-y-2">
              <button
                    onClick={onInstallPlugin}
                disabled={installing || installResult?.success}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {installing ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {t('agent.wizard.installing')}
                  </>
                ) : installResult?.success ? (
                  <>
                    <CheckCircle size={14} />
                    {t('agent.wizard.installed')}
                  </>
                ) : (
                  <>
                    <Package size={14} />
                    {t('agent.wizard.oneClickInstall')}
                  </>
                )}
              </button>
              {installResult && !installResult.success && (
                <div className="px-3 py-2 bg-red-500/5 border border-red-500/10 rounded-lg">
                  <p className="text-[10px] text-red-400">{installResult.message}</p>
                  <p className="text-[10px] text-gray-500 mt-1">{t('agent.wizard.manualInstallHint')}</p>
                </div>
              )}
              {/* 始终显示手动命令作为 fallback */}
              <div className="relative">
                <div className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg">
                  <Terminal size={11} className="text-gray-500 flex-shrink-0" />
                  <code className="text-[10px] text-gray-400 font-mono">
                    {installCommand}
                  </code>
                </div>
                <button
                    onClick={() => onCopy(installCommand, 'install')}
                  className="absolute top-1.5 right-1.5 p-1 bg-white/5 hover:bg-white/10 rounded text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {copied === 'install' ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="px-3 py-2 bg-amber-500/5 border border-amber-500/10 rounded-lg">
                <p className="text-[10px] text-amber-400">
                  {t('agent.wizard.cliNotDetected')}
                </p>
              </div>
              <div className="relative">
                <div className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg">
                  <Terminal size={11} className="text-gray-400 flex-shrink-0" />
                  <code className="text-[10px] text-gray-300 font-mono">
                    {installCommand}
                  </code>
                </div>
                <button
                    onClick={() => onCopy(installCommand, 'install')}
                  className="absolute top-1.5 right-1.5 p-1 bg-white/5 hover:bg-white/10 rounded text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {copied === 'install' ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onPrevious}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
        >
          <ChevronLeft size={14} />
          {t('agent.wizard.prevStep')}
        </button>
        <button
          onClick={onNext}
          disabled={!pluginGenerated}
          className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('agent.wizard.nextStep')}
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  )
}
