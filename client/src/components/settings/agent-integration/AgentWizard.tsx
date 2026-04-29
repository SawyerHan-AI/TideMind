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
  const [pluginGenerating, setPluginGenerating] = useState(false)
  const [pluginGenerated, setPluginGenerated] = useState(false)
  const [pluginError, setPluginError] = useState('')
  const [cliAvailable, setCliAvailable] = useState(false)
  const [codexVersion, setCodexVersion] = useState<string | null>(null)
  const [geminiVersion, setGeminiVersion] = useState<string | null>(null)
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
  const isManual = !usePlugin  // "其他"工具走手动配置流程

  // 根据流程类型决定步骤
  const stepLabels = usePlugin
    ? isCowork
      ? [t('agent.wizard.nameAgent'), t('agent.wizard.configCowork'), t('agent.wizard.verify')]
      : isCursor
        ? [t('agent.wizard.nameAgent'), t('agent.wizard.configCursor'), t('agent.wizard.verify')]
        : isCodex
          ? [t('agent.wizard.nameAgent'), t('agent.wizard.configCodex'), t('agent.wizard.verify')]
          : isWindsurf
            ? [t('agent.wizard.nameAgent'), t('agent.wizard.configWindsurf'), t('agent.wizard.verify')]
            : isOpenClaw
              ? [t('agent.wizard.nameAgent'), t('agent.wizard.configOpenClaw'), t('agent.wizard.verify')]
              : isGemini
                ? [t('agent.wizard.nameAgent'), t('agent.wizard.configGemini'), t('agent.wizard.verify')]
                : [t('agent.wizard.nameAgent'), t('agent.wizard.installPlugin'), t('agent.wizard.verify')]
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
  const handleCreateAndNext = async () => {
    const finalToolType = effectiveToolType
    if (!agentName.trim() || !finalToolType.trim() || creating) return
    setCreating(true)

    const agent = await window.api.agents.create({ name: agentName.trim(), tool_type: finalToolType.trim() })
    setCreatedAgent(agent)

    if (usePlugin) {
      // 插件流程：
      // Claude Code: 生成 Plugin + marketplace + CLI 安装
      // Claude Cowork: 写入 Desktop config + 生成 Skill 到 Downloads
      setPluginGenerating(true)
      try {
        const [result, cliCheck, codexCheck, geminiCheck] = await Promise.all([
          window.api.agents.generatePlugin({ agentId: agent.id, agentName: agent.name, clientType: finalToolType }),
          window.api.agents.checkCli('claude'),
          isCodex
            ? window.api.agents.checkCli('codex')
            : Promise.resolve({ available: false } as { available: boolean; path?: string; version?: string }),
          isGemini
            ? window.api.agents.checkCli('gemini')
            : Promise.resolve({ available: false } as { available: boolean; path?: string; version?: string }),
        ])
        if (result.success) {
          setPluginDir(result.pluginDir)
          setPluginName(result.pluginName)
          setPluginGenerated(true)
          if (isCowork || isCursor || isCodex || isWindsurf || isOpenClaw || isGemini) {
            setDesktopConfigWritten(true)
          }
        } else {
          setPluginError(result.error ?? t('agent.wizard.generateFailed'))
          await window.api.agents.delete(agent.id)
          setCreatedAgent(null)
        }
        setCliAvailable(cliCheck.available)
        setCodexVersion(codexCheck.version ?? null)
        setGeminiVersion(geminiCheck.version ?? null)
      } catch (err: any) {
        setPluginError(err.message)
        await window.api.agents.delete(agent.id)
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

  const installCommand = pluginName
    ? `claude plugin install ${pluginName}@tidemind-local --scope user`
    : ''

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
          onCreateAndNext={handleCreateAndNext}
        />
      )}

      {/* ========================================== */}
      {/* 插件流程 Step 1: 安装插件 */}
      {/* ========================================== */}
      {step === 1 && usePlugin && createdAgent && (
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
          isCowork={isCowork}
          isCursor={isCursor}
          isCodex={isCodex}
          isWindsurf={isWindsurf}
          isOpenClaw={isOpenClaw}
          isGemini={isGemini}
          isManual={isManual}
          onPrevious={() => setStep(usePlugin ? 1 : 2)}
          onClose={onClose}
        />
      )}
    </Section>
  )
}

// ============================================================
