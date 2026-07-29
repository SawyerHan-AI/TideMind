import type { PluginClientType } from '../../../lib/api-contract'

type PluginDetailTone = 'indigo' | 'blue' | 'emerald'

export interface PluginDetailMeta {
  tone: PluginDetailTone
  hintKeys: string[]
  showSkillOutput?: boolean
}

export interface PluginVerifyMcpMeta {
  labelKey: string
  hintOkKey: string
  hintFailKey: string
}

export interface ToolTypeDef {
  id: PluginClientType
  label: string
  configPathKey: string
  skillPathKey: string
  /** 支持插件化安装 */
  pluginSupport: boolean
  wizardConfigStepKey: string
  pluginDetail?: PluginDetailMeta
  pluginVerifyMcp?: PluginVerifyMcpMeta
  /** 即将支持（置灰不可选） */
  comingSoon?: boolean
}

export const TOOL_TYPES: ToolTypeDef[] = [
  { id: 'claude-code', label: 'Claude Code', configPathKey: 'agent.toolConfigPath.claudeCode', skillPathKey: 'agent.toolSkillPath.claudeCode', pluginSupport: true, wizardConfigStepKey: 'agent.wizard.installPlugin' },
  { id: 'cowork', label: 'Claude Cowork', configPathKey: 'agent.toolConfigPath.cowork', skillPathKey: 'agent.toolSkillPath.cowork', pluginSupport: true, wizardConfigStepKey: 'agent.wizard.configCowork', pluginDetail: { tone: 'indigo', hintKeys: ['agent.detail.coworkMcpHint', 'agent.detail.coworkSkillHint'], showSkillOutput: true }, pluginVerifyMcp: { labelKey: 'agent.wizard.verifyDesktopMcp', hintOkKey: 'agent.wizard.verifyDesktopMcpHintDone', hintFailKey: 'agent.wizard.verifyDesktopMcpHintNeeded' } },
  { id: 'cursor', label: 'Cursor', configPathKey: 'agent.toolConfigPath.cursor', skillPathKey: 'agent.toolSkillPath.cursor', pluginSupport: true, wizardConfigStepKey: 'agent.wizard.configCursor', pluginDetail: { tone: 'indigo', hintKeys: ['agent.detail.cursorMcpHint', 'agent.detail.cursorSkillHint'], showSkillOutput: true }, pluginVerifyMcp: { labelKey: 'agent.wizard.verifyCursorMcp', hintOkKey: 'agent.wizard.verifyCursorMcpHintOk', hintFailKey: 'agent.wizard.verifyCursorMcpHintFail' } },
  { id: 'codex', label: 'Codex', configPathKey: 'agent.toolConfigPath.codex', skillPathKey: 'agent.toolSkillPath.codex', pluginSupport: true, wizardConfigStepKey: 'agent.wizard.configCodex', pluginDetail: { tone: 'indigo', hintKeys: ['agent.detail.codexMcpHint', 'agent.detail.codexSkillHint'], showSkillOutput: true }, pluginVerifyMcp: { labelKey: 'agent.wizard.verifyCodexMcp', hintOkKey: 'agent.wizard.verifyCodexMcpHintOk', hintFailKey: 'agent.wizard.verifyCodexMcpHintFail' } },
  { id: 'windsurf', label: 'Windsurf', configPathKey: 'agent.toolConfigPath.windsurf', skillPathKey: 'agent.toolSkillPath.windsurf', pluginSupport: true, wizardConfigStepKey: 'agent.wizard.configWindsurf', pluginDetail: { tone: 'blue', hintKeys: ['agent.detail.windsurfMcpHint', 'agent.detail.windsurfSkillHint'], showSkillOutput: true }, pluginVerifyMcp: { labelKey: 'agent.wizard.verifyWindsurfMcp', hintOkKey: 'agent.wizard.verifyWindsurfMcpHintOk', hintFailKey: 'agent.wizard.verifyWindsurfMcpHintFail' } },
  { id: 'openclaw', label: 'OpenClaw', configPathKey: 'agent.toolConfigPath.openclaw', skillPathKey: 'agent.toolSkillPath.openclaw', pluginSupport: true, wizardConfigStepKey: 'agent.wizard.configOpenClaw', pluginDetail: { tone: 'blue', hintKeys: ['agent.detail.openclawMcpHint', 'agent.detail.openclawSkillHint'], showSkillOutput: true }, pluginVerifyMcp: { labelKey: 'agent.wizard.verifyOpenClawMcp', hintOkKey: 'agent.wizard.verifyOpenClawMcpHintOk', hintFailKey: 'agent.wizard.verifyOpenClawMcpHintFail' } },
  { id: 'gemini', label: 'Gemini CLI', configPathKey: 'agent.toolConfigPath.gemini', skillPathKey: 'agent.toolSkillPath.gemini', pluginSupport: true, wizardConfigStepKey: 'agent.wizard.configGemini', pluginDetail: { tone: 'emerald', hintKeys: ['agent.detail.geminiMcpHint', 'agent.detail.geminiSkillHint'] }, pluginVerifyMcp: { labelKey: 'agent.wizard.verifyGeminiMcp', hintOkKey: 'agent.wizard.verifyGeminiMcpHintOk', hintFailKey: 'agent.wizard.verifyGeminiMcpHintFail' } },
  { id: 'kimi-code', label: 'Kimi Code', configPathKey: 'agent.toolConfigPath.kimiCode', skillPathKey: 'agent.toolSkillPath.kimiCode', pluginSupport: true, wizardConfigStepKey: 'agent.wizard.configKimi', pluginDetail: { tone: 'indigo', hintKeys: ['agent.detail.kimiMcpHint', 'agent.detail.kimiSkillHint'] }, pluginVerifyMcp: { labelKey: 'agent.wizard.verifyKimiMcp', hintOkKey: 'agent.wizard.verifyKimiMcpHintOk', hintFailKey: 'agent.wizard.verifyKimiMcpHintFail' } },
]

export function getToolTypeDef(toolType: string): ToolTypeDef | undefined {
  return TOOL_TYPES.find(item => item.id === toolType)
}

export function isPluginSupported(toolType: string): boolean {
  return getToolTypeDef(toolType)?.pluginSupport ?? false
}

/** Codex ≥0.121 支持 `codex mcp add` 和原生 Skills 机制（v2 主路径） */
export function isCodexV2Version(version: string | null | undefined): boolean {
  if (!version) return false
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  if (major > 0) return true
  return minor >= 121
}

/** Gemini CLI ≥0.26 默认开启 hooks，是「会话启动自动注入用户画像」的最低要求 */
export function isGeminiHooksReady(version: string | null | undefined): boolean {
  if (!version) return false
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  if (major > 0) return true
  return minor >= 26
}

// ============================================================
