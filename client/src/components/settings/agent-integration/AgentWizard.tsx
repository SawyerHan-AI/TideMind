import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, X } from 'lucide-react'
import { Section } from '../shared'
import type { Agent } from './types'
import { getToolTypeDef, isPluginSupported } from './toolTypes'
import { AgentWizardPluginStep } from './AgentWizardPluginStep'
import { AgentWizardVerifyStep } from './AgentWizardVerifyStep'
import { ManualMcpConfigStep } from './ManualMcpConfigStep'
import { ManualSkillFileStep } from './ManualSkillFileStep'
import { ToolSelectionStep } from './ToolSelectionStep'

// 配置向导
// ============================================================

export function AgentWizard({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('settings')
  const [step, setStep] = useState(0)
  const [agentName, setAgentName] = useState('')
  const [toolType, setToolType] = useState('')
  const [customToolType, setCustomToolType] = useState('')
  const [usingBaseFallback, setUsingBaseFallback] = useState(false)
  const [createdAgent, setCreatedAgent] = useState<Agent | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const wizardCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 手动流程用的状态
  const [mcpSnippet, setMcpSnippet] = useState('')
  const [skillContent, setSkillContent] = useState('')
  const [skillLoaded, setSkillLoaded] = useState(false)

  // 插件流程用的状态
  const [pluginDir, setPluginDir] = useState('')
  const [pluginName, setPluginName] = useState('')
  // marketplace 根目录（仅 claude-code 流程会返回），用于拼接组合 install 命令
  const [pluginsDir, setPluginsDir] = useState('')
  const [pluginGenerating, setPluginGenerating] = useState(false)
  const [pluginGenerated, setPluginGenerated] = useState(false)
  const [pluginError, setPluginError] = useState('')
  const [cliAvailable, setCliAvailable] = useState(false)
  const [codexVersion, setCodexVersion] = useState<string | null>(null)
  const [geminiVersion, setGeminiVersion] = useState<string | null>(null)
  const [kimiAvailable, setKimiAvailable] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installResult, setInstallResult] = useState<{ success: boolean; message: string } | null>(null)
  // Claude Cowork 专用状态
  // packagePath 已移除：Claude Cowork 不再打包 .plugin，改为生成 Skill .md 文件
  const [desktopConfigWritten, setDesktopConfigWritten] = useState(false)

  const effectiveToolType = toolType === 'other' ? customToolType : toolType
  const toolDef = getToolTypeDef(effectiveToolType)
  const usePlugin = isPluginSupported(effectiveToolType)
  const isCowork = effectiveToolType === 'cowork'
  const isCursor = effectiveToolType === 'cursor'
  const isCodex = effectiveToolType === 'codex'
  const isWindsurf = effectiveToolType === 'windsurf'
  const isOpenClaw = effectiveToolType === 'openclaw'
  const isGemini = effectiveToolType === 'gemini'
  const isKimi = effectiveToolType === 'kimi-code'
  const isManual = !usePlugin  // "其他"工具走手动配置流程

  // 根据流程类型决定步骤
  const stepLabels = usePlugin
    ? [t('agent.wizard.nameAgent'), t(toolDef?.wizardConfigStepKey ?? 'agent.wizard.installPlugin'), t('agent.wizard.verify')]
    : [t('agent.wizard.nameAgent'), t('agent.wizard.mcpConfig'), t('agent.wizard.skillFile'), t('agent.wizard.verify')]

  // 选择工具类型后自动填充名称
  useEffect(() => {
    if (toolType && toolType !== 'other' && !agentName) {
      const def = getToolTypeDef(toolType)
      if (def) setAgentName(def.label)
    }
  }, [toolType, agentName])

  // Step 0 → Step 1: 创建 Agent
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const handleCreateAndNext = async () => {
    const finalToolType = effectiveToolType
    if (!agentName.trim() || !finalToolType.trim() || creating) return
    setCreating(true)
    setCreateError('')

    // try/finally 保证 creating 一定复位:此前 setCreating(true) 后没有任何复位路径,
    // 用户从 step 1 点"上一步"回到本步后按钮永久 disabled(显示"正在创建");
    // agents.create / mcpSnippet reject 时还会 unhandled rejection 且无任何用户反馈。
    try {
      const agent = await window.api.agents.create({ name: agentName.trim(), tool_type: finalToolType.trim() })
      setCreatedAgent(agent)

      if (usePlugin) {
        // 插件流程：
        // Claude Code: 生成 Plugin + marketplace + CLI 安装
        // Claude Cowork: 写入 Desktop config + 生成 Skill 到 Downloads
        setPluginGenerating(true)
        try {
          const [result, cliCheck, codexCheck, geminiCheck, kimiCheck] = await Promise.all([
            window.api.agents.generatePlugin({ agentId: agent.id, agentName: agent.name, clientType: finalToolType }),
            window.api.agents.checkCli('claude'),
            isCodex
              ? window.api.agents.checkCli('codex')
              : Promise.resolve({ available: false } as { available: boolean; path?: string; version?: string }),
            isGemini
              ? window.api.agents.checkCli('gemini')
              : Promise.resolve({ available: false } as { available: boolean; path?: string; version?: string }),
            isKimi
              ? window.api.agents.checkCli('kimi')
              : Promise.resolve({ available: false } as { available: boolean; path?: string; version?: string }),
          ])
          if (result.success) {
            setPluginDir(result.pluginDir)
            setPluginName(result.pluginName)
            if (result.pluginsDir) setPluginsDir(result.pluginsDir)
            setPluginGenerated(true)
            if (isCowork || isCursor || isCodex || isWindsurf || isOpenClaw || isGemini || isKimi) {
              setDesktopConfigWritten(true)
            }
          } else {
            setPluginError(result.error ?? t('agent.wizard.generateFailed'))
            // 清理失败本身不应吞掉 step 1 的错误展示
            await window.api.agents.delete(agent.id).catch(() => {})
            setCreatedAgent(null)
          }
          setCliAvailable(cliCheck.available)
          setCodexVersion(codexCheck.version ?? null)
          setGeminiVersion(geminiCheck.version ?? null)
          setKimiAvailable(kimiCheck.available)
        } catch (err: any) {
          setPluginError(err.message)
          await window.api.agents.delete(agent.id).catch(() => {})
          setCreatedAgent(null)
        } finally {
          setPluginGenerating(false)
        }
      } else {
        // 手动流程：获取 MCP snippet
        const snippet = await window.api.agents.mcpSnippet(agent.id)
        setMcpSnippet(JSON.stringify(snippet, null, 2))
      }

      setStep(1)
    } catch (err) {
      // 有 message 时带上"创建失败"阶段语境(本地化前缀 + 原始 message),无 message 时
      // 只用本地化的 createFailed。ToolSelectionStep 直接渲染 createError,不再二次加前缀
      //(避免双重本地化),两态都带语境。
      const msg = (err as Error).message
      setCreateError(msg ? `${t('agent.wizard.createFailed')}: ${msg}` : t('agent.wizard.createFailed'))
    } finally {
      setCreating(false)
    }
  }

  // 插件安装（通过 marketplace）
  const handleInstallPlugin = async () => {
    if (!pluginName) return
    setInstalling(true)
    try {
      const result = await window.api.agents.installPlugin(pluginName)
      setInstallResult({
        success: result.success,
        message: result.success ? t('agent.wizard.installSuccess') : (result.error ?? t('agent.wizard.installFailed')),
      })
    } catch (err: any) {
      setInstallResult({ success: false, message: err.message })
    } finally {
      setInstalling(false)
    }
  }

  // 关键：必须把 `marketplace add` 和 `plugin install` 用 `&&` 串起来。
  // 单独跑 install 命令在 CLI 还没注册过 marketplace 的环境下会报
  // "Plugin not found in marketplace 'tidemind-local'"。后端 generate() 已经
  // 顺便调过一次 marketplace add 做预热（见 claude-code.ts syncCliMarketplace），
  // 但用户可能跨设备/重装 CLI 后再跑这条命令，必须自带前缀才稳。
  const installCommand = pluginName && pluginsDir
    ? `claude plugin marketplace add "${pluginsDir}" && claude plugin install ${pluginName}@tidemind-local --scope user`
    : pluginName
      ? `claude plugin install ${pluginName}@tidemind-local --scope user`
      : ''

  // 修复 M31(2026-05-09):effectiveToolType 变化时必须重置 skillLoaded,
  // 否则用户从 step 2 退回 step 0 切换工具类型再前进时,会显示和复制错误的
  // skill 内容(沿用上一个 toolType 的缓存)。
  useEffect(() => {
    setSkillLoaded(false)
    setSkillContent('')
  }, [effectiveToolType])

  // Load skill content (手动流程)
  useEffect(() => {
    if (!usePlugin && step === 2 && !skillLoaded) {
      const skillName = effectiveToolType || 'base-skill'
      window.api.config.skillContent(skillName).then(c => {
        if (!c) {
          setUsingBaseFallback(true)
          window.api.config.skillContent('base-skill').then(bc => {
            setSkillContent(bc)
            setSkillLoaded(true)
          })
        } else {
          setUsingBaseFallback(skillName === 'base-skill')
          setSkillContent(c)
          setSkillLoaded(true)
        }
      })
    }
  }, [step, skillLoaded, effectiveToolType, usePlugin])

  useEffect(() => {
    return () => {
      if (wizardCopiedTimerRef.current) clearTimeout(wizardCopiedTimerRef.current)
    }
  }, [])

  const handleCopy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    if (wizardCopiedTimerRef.current) clearTimeout(wizardCopiedTimerRef.current)
    wizardCopiedTimerRef.current = setTimeout(() => setCopied(null), 2000)
  }

  // 验证步骤的 index
  const verifyStep = usePlugin ? 2 : 3

  return (
    <Section
      title={t('agent.newAgent')}
      action={<button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors"><X size={16} /></button>}
    >
      {/* 步骤条 */}
      <div className="flex items-center gap-1 mb-4">
        {(effectiveToolType || step > 0) ? stepLabels.map((label, i) => (
          <div key={i} className="flex items-center">
            <div className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium ${
              i === step ? 'bg-indigo-400/20 text-indigo-400' :
              i < step ? 'text-emerald-400' : 'text-gray-500'
            }`}>
              {i < step ? <Check size={10} /> : <span>{i + 1}</span>}
              {label}
            </div>
            {i < stepLabels.length - 1 && (
              <ChevronRight size={12} className="text-gray-600 mx-0.5" />
            )}
          </div>
        )) : (
          <span className="text-[10px] text-gray-500">{t('agent.wizard.selectToolHint')}</span>
        )}
      </div>

      {/* Step 0: 命名 + 选择工具类型 */}
      {step === 0 && (
        <ToolSelectionStep
          agentName={agentName}
          setAgentName={setAgentName}
          toolType={toolType}
          setToolType={setToolType}
          customToolType={customToolType}
          setCustomToolType={setCustomToolType}
          effectiveToolType={effectiveToolType}
          usePlugin={usePlugin}
          creating={creating}
          createError={createError}
          onCreateAndNext={handleCreateAndNext}
        />
      )}

      {/* ========================================== */}
      {/* 插件流程 Step 1: 安装插件 */}
      {/* ========================================== */}
      {/* createdAgent 在生成失败时会被置 null,但 setStep(1) 仍会执行;此时放行
          pluginError 分支,让 AgentWizardPluginStep 显示错误 + 提供返回,
          避免落到既无内容又无报错的空白 step。*/}
      {step === 1 && usePlugin && (createdAgent || pluginError) && (
        <AgentWizardPluginStep
          pluginGenerating={pluginGenerating}
          pluginError={pluginError}
          pluginGenerated={pluginGenerated}
          pluginDir={pluginDir}
          cliAvailable={cliAvailable}
          installing={installing}
          installResult={installResult}
          installCommand={installCommand}
          codexVersion={codexVersion}
          geminiVersion={geminiVersion}
          desktopConfigWritten={desktopConfigWritten}
          copied={copied}
          isCowork={isCowork}
          isCursor={isCursor}
          isCodex={isCodex}
          isWindsurf={isWindsurf}
          isOpenClaw={isOpenClaw}
          isGemini={isGemini}
          isKimi={isKimi}
          kimiAvailable={kimiAvailable}
          onInstallPlugin={handleInstallPlugin}
          onCopy={handleCopy}
          onPrevious={() => setStep(0)}
          onNext={() => setStep(2)}
        />
      )}
      {/* 手动流程 Step 1: MCP 配置 */}
      {/* ========================================== */}
      {/* 手动流程 Step 1: MCP 配置 */}
      {/* ========================================== */}
      {step === 1 && !usePlugin && createdAgent && (
        <ManualMcpConfigStep
          toolDef={toolDef}
          mcpSnippet={mcpSnippet}
          copied={copied}
          onCopy={handleCopy}
          onPrevious={() => setStep(0)}
          onNext={() => setStep(2)}
        />
      )}

      {/* ========================================== */}
      {/* 手动流程 Step 2: Skill 文件 */}
      {/* ========================================== */}
      {step === 2 && !usePlugin && createdAgent && (
        <ManualSkillFileStep
          toolDef={toolDef}
          skillContent={skillContent}
          skillLoaded={skillLoaded}
          usingBaseFallback={usingBaseFallback}
          copied={copied}
          onCopy={handleCopy}
          onPrevious={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {/* ========================================== */}
      {/* 验证步骤（两种流程共用） */}
      {/* ========================================== */}
      {step === verifyStep && createdAgent && (
        <AgentWizardVerifyStep
          createdAgent={createdAgent}
          usePlugin={usePlugin}
          pluginGenerated={pluginGenerated}
          desktopConfigWritten={desktopConfigWritten}
          pluginToolLabel={toolDef?.label ?? 'Claude Code'}
          pluginVerifyMcp={toolDef?.pluginVerifyMcp}
          isManual={isManual}
          onPrevious={() => setStep(usePlugin ? 1 : 2)}
          onClose={onClose}
        />
      )}
    </Section>
  )
}

// ============================================================
