import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getHookScriptPath,
  getMcpServerScriptPath,
  getPostCompactHookScriptPath,
  getPreCompactHookScriptPath,
  getShimPath,
} from '../../runtime/runtime-paths'
import { assertPathWithinRoot } from '../_validate'
import {
  CLIENT_CONFIG,
  type GeneratePluginContext,
  type PluginClientType,
  type PluginLookupContext,
  type PluginRuntimeContext,
} from './types'

export function createPluginRuntimeContext(dataDir: string, homeDir = os.homedir()): PluginRuntimeContext {
  return {
    dataDir,
    pluginsDir: path.join(dataDir, 'plugins'),
    skillDir: path.join(dataDir, 'skill'),
    shimPath: getShimPath(),
    mcpServerPath: getMcpServerScriptPath(),
    hookScriptPath: getHookScriptPath(),
    preCompactScriptPath: getPreCompactHookScriptPath(),
    postCompactScriptPath: getPostCompactHookScriptPath(),
    homeDir,
  }
}

export function buildPluginLookupContext(
  runtime: PluginRuntimeContext,
  agentId: string,
  clientType: PluginClientType,
): PluginLookupContext {
  const config = CLIENT_CONFIG[clientType]
  const pluginName = `tidemind-${agentId}`
  const pluginDirName = `${config.dirPrefix}-${agentId}`
  const pluginDir = path.join(runtime.pluginsDir, pluginDirName)
  assertPathWithinRoot(pluginDir, runtime.pluginsDir)
  return {
    runtime,
    agentId,
    clientType,
    config,
    pluginName,
    pluginDirName,
    pluginDir,
  }
}

export function buildGeneratePluginContext(
  runtime: PluginRuntimeContext,
  agentId: string,
  agentName: string,
  clientType: PluginClientType,
): GeneratePluginContext {
  return {
    ...buildPluginLookupContext(runtime, agentId, clientType),
    agentName,
    skillContent: loadSkillContent(runtime, CLIENT_CONFIG[clientType].skillSource),
  }
}

export function loadSkillContent(runtime: PluginRuntimeContext, skillSource: string): string {
  const primarySkillPath = path.join(runtime.skillDir, skillSource)
  const fallbackSkillPath = path.join(runtime.skillDir, 'base-skill.md')
  if (fs.existsSync(primarySkillPath)) return fs.readFileSync(primarySkillPath, 'utf-8')
  if (fs.existsSync(fallbackSkillPath)) return fs.readFileSync(fallbackSkillPath, 'utf-8')
  return ''
}

export function downloadPath(runtime: PluginRuntimeContext, name: string): string {
  return path.join(runtime.homeDir, 'Downloads', name)
}

export function mcpServerEntry(runtime: PluginRuntimeContext, agentId: string): {
  command: string
  args: string[]
  env: { EB_AGENT_ID: string }
} {
  return {
    command: runtime.shimPath,
    args: [runtime.mcpServerPath],
    env: { EB_AGENT_ID: agentId },
  }
}

export function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` }
}
