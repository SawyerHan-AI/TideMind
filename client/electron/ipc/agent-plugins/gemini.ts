import fs from 'node:fs'
import path from 'node:path'
import { assertPathWithinRoot } from '../_validate'
import {
  geminiExtensionInstall,
  geminiExtensionList,
  geminiExtensionUninstall,
  stripFrontmatter,
} from '../gemini-cli'
import { resolveCliPath } from './cli-utils'
import { writeFileAtomic } from './fs-utils'
import type {
  AgentPluginAdapter,
  GeneratePluginContext,
  PluginLookupContext,
  PluginStatusResult,
} from './types'

function extName(ctx: PluginLookupContext): string {
  return `tidemind-${ctx.agentId}`
}

function stagingDir(ctx: PluginLookupContext): string {
  const dir = path.join(ctx.runtime.pluginsDir, `gemini-${ctx.agentId}`)
  assertPathWithinRoot(dir, ctx.runtime.pluginsDir)
  return dir
}

function installedDir(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.homeDir, '.gemini', 'extensions', extName(ctx))
}

export const geminiAdapter: AgentPluginAdapter = {
  clientType: 'gemini',
  async generate(ctx: GeneratePluginContext) {
    const name = extName(ctx)
    const stage = stagingDir(ctx)
    fs.mkdirSync(path.join(stage, 'hooks'), { recursive: true })
    fs.mkdirSync(path.join(stage, 'commands'), { recursive: true })

    const installedSkillPath = path.join(installedDir(ctx), 'GEMINI.md')

    writeFileAtomic(
      path.join(stage, 'gemini-extension.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        description: `Tide Mind 外部记忆系统 — ${ctx.agentName}`,
        mcpServers: {
          tidemind: {
            command: ctx.runtime.shimPath,
            args: [ctx.runtime.mcpServerPath],
            env: { EB_AGENT_ID: ctx.agentId },
          },
        },
        contextFileName: 'GEMINI.md',
        excludeTools: [],
      }, null, 2),
    )

    writeFileAtomic(path.join(stage, 'GEMINI.md'), stripFrontmatter(ctx.skillContent))

    const hookCommand = [
      JSON.stringify(ctx.runtime.shimPath),
      JSON.stringify(ctx.runtime.hookScriptPath),
      '--agent-id', JSON.stringify(ctx.agentId),
      '--skill-path', JSON.stringify(installedSkillPath),
      '--tool', JSON.stringify(ctx.config.hookToolParam),
    ].join(' ')
    writeFileAtomic(
      path.join(stage, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume',
              hooks: [
                {
                  type: 'command',
                  command: hookCommand,
                  timeout: 15000,
                },
              ],
            },
          ],
        },
      }, null, 2),
    )

    const commandsSrcDir = path.join(ctx.runtime.skillDir, 'gemini-commands')
    for (const cmd of ['brain-recall.toml', 'brain-digest.toml', 'brain-forget.toml']) {
      const src = path.join(commandsSrcDir, cmd)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stage, 'commands', cmd))
    }

    try {
      // 用绝对路径执行,不依赖 cliEnv 的受限 PATH 做命令查找(volta/fnm/asdf/pnpm
      // 装的 gemini 也能跑)。解析失败退回裸名(由 geminiExtensionInstall 默认值兜底)。
      const geminiPath = (await resolveCliPath('gemini')) ?? undefined
      await geminiExtensionInstall({ geminiPath, extName: name, stagingPath: stage })
    } catch (err: any) {
      return {
        pluginDir: stage,
        pluginName: name,
        marketplaceRegistered: false,
        success: false,
        error: `gemini extensions install 失败: ${err?.stderr ?? err?.message ?? String(err)}`,
      }
    }

    return { pluginDir: stage, pluginName: name, marketplaceRegistered: false, success: true }
  },

  getPath(ctx) {
    const stage = stagingDir(ctx)
    return fs.existsSync(path.join(stage, 'gemini-extension.json')) ? stage : null
  },

  async getStatus(ctx): Promise<PluginStatusResult> {
    const name = extName(ctx)
    const stage = stagingDir(ctx)
    const installed = installedDir(ctx)
    const stagingManifest = path.join(stage, 'gemini-extension.json')
    const installedManifest = path.join(installed, 'gemini-extension.json')
    const stagingExists = fs.existsSync(stagingManifest)
    const installedExists = fs.existsSync(installedManifest)

    let registered: boolean | null = null
    const geminiPath = (await resolveCliPath('gemini')) ?? undefined
    const list = await geminiExtensionList(geminiPath)
    if (list !== null) registered = list.some(line => line.includes(name))

    let skillOutdated = false
    if (stagingExists && installedExists) {
      try {
        const stagingMtime = fs.statSync(path.join(stage, 'GEMINI.md')).mtimeMs
        const installedMtime = fs.statSync(path.join(installed, 'GEMINI.md')).mtimeMs
        skillOutdated = stagingMtime > installedMtime
      } catch { /* missing files mean not outdated */ }
    }

    const generatedAt = installedExists
      ? fs.statSync(installedManifest).mtime.toISOString()
      : (stagingExists ? fs.statSync(stagingManifest).mtime.toISOString() : '')

    return {
      exists: stagingExists || installedExists,
      pluginDir: installedExists ? installed : stage,
      clientType: ctx.clientType,
      tools: ['brain_prepare', 'brain_recall', 'brain_digest'],
      stagingExists,
      installedExists,
      registered,
      skillOutdated,
      generatedAt,
    }
  },

  async uninstall(ctx) {
    const errors: string[] = []
    const name = extName(ctx)
    try {
      const geminiPath = (await resolveCliPath('gemini')) ?? undefined
      await geminiExtensionUninstall({ geminiPath, extName: name })
    } catch (err: any) {
      errors.push(`gemini extensions uninstall 失败: ${err?.stderr ?? err?.message ?? String(err)}`)
    }

    try {
      const installedRoot = path.join(ctx.runtime.homeDir, '.gemini', 'extensions')
      const installed = path.join(installedRoot, name)
      assertPathWithinRoot(installed, installedRoot)
      if (fs.existsSync(installed)) fs.rmSync(installed, { recursive: true, force: true })
    } catch { /* ignore */ }

    try {
      const stage = stagingDir(ctx)
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true })
    } catch (err: any) {
      errors.push(`删除 Gemini staging 失败: ${err.message}`)
    }

    try {
      if (fs.existsSync(ctx.pluginDir)) fs.rmSync(ctx.pluginDir, { recursive: true, force: true })
    } catch (err: any) {
      errors.push(`删除插件目录失败: ${err.message}`)
    }

    return errors.length > 0
      ? { success: false, error: errors.join('; ') }
      : { success: true }
  },
}
