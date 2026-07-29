import { claudeCodeAdapter } from './claude-code'
import { codexAdapter } from './codex'
import { coworkAdapter } from './cowork'
import { cursorAdapter } from './cursor'
import { geminiAdapter } from './gemini'
import { kimiCodeAdapter } from './kimi-code'
import { openclawAdapter } from './openclaw'
import type { AgentPluginAdapter, PluginClientType } from './types'
import { windsurfAdapter } from './windsurf'

export const AGENT_PLUGIN_ADAPTERS: Record<PluginClientType, AgentPluginAdapter> = {
  'claude-code': claudeCodeAdapter,
  cowork: coworkAdapter,
  cursor: cursorAdapter,
  codex: codexAdapter,
  windsurf: windsurfAdapter,
  openclaw: openclawAdapter,
  gemini: geminiAdapter,
  'kimi-code': kimiCodeAdapter,
}

export function getAgentPluginAdapter(clientType: PluginClientType): AgentPluginAdapter {
  return AGENT_PLUGIN_ADAPTERS[clientType]
}

export function allAgentPluginAdapters(): AgentPluginAdapter[] {
  return Object.values(AGENT_PLUGIN_ADAPTERS)
}
