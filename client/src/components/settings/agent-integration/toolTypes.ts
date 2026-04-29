export interface ToolTypeDef {
  id: string
  label: string
  configPathKey: string
  skillPathKey: string
  /** 支持插件化安装 */
  pluginSupport: boolean
  /** 即将支持（置灰不可选） */
  comingSoon?: boolean
}

export const TOOL_TYPES: ToolTypeDef[] = [
  { id: 'claude-code', label: 'Claude Code', configPathKey: 'agent.toolConfigPath.claudeCode', skillPathKey: 'agent.toolSkillPath.claudeCode', pluginSupport: true },
  { id: 'cowork', label: 'Claude Cowork', configPathKey: 'agent.toolConfigPath.cowork', skillPathKey: 'agent.toolSkillPath.cowork', pluginSupport: true },
  { id: 'cursor', label: 'Cursor', configPathKey: 'agent.toolConfigPath.cursor', skillPathKey: 'agent.toolSkillPath.cursor', pluginSupport: true },
  { id: 'codex', label: 'Codex', configPathKey: 'agent.toolConfigPath.codex', skillPathKey: 'agent.toolSkillPath.codex', pluginSupport: true },
  { id: 'windsurf', label: 'Windsurf', configPathKey: 'agent.toolConfigPath.windsurf', skillPathKey: 'agent.toolSkillPath.windsurf', pluginSupport: true },
  { id: 'openclaw', label: 'OpenClaw', configPathKey: 'agent.toolConfigPath.openclaw', skillPathKey: 'agent.toolSkillPath.openclaw', pluginSupport: true },
  { id: 'gemini', label: 'Gemini CLI', configPathKey: 'agent.toolConfigPath.gemini', skillPathKey: 'agent.toolSkillPath.gemini', pluginSupport: true },
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
