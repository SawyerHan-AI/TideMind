import fs from 'node:fs'
import path from 'node:path'
import { sha256Bytes } from '../fingerprint'
import type { AdapterOperationContext, AgentHostAdapter, JsonValue } from '../types'
import {
  createJsonLifecycleHookHostAdapter,
  type ManagedHookEvent,
} from './json-lifecycle-hook-adapter'
import { PORTABLE_TIDEMIND_SKILL_SHA256 } from './portable-skill'

const ADAPTER_VERSION = '1'

/**
 * Current Devin Desktop (the renamed Windsurf Desktop) documents user Hooks in
 * ~/.config/devin/config.json. SessionStart injects prepared local context and
 * SessionEnd records completion activity. Both events carry only lifecycle
 * metadata; Tide Mind never reads prompt, response, or transcript content.
 */
export function createWindsurfLifecycleHostAdapter(): AgentHostAdapter {
  return createJsonLifecycleHookHostAdapter({
    catalogId: 'windsurf-desktop',
    adapterVersion: ADAPTER_VERSION,
    configFile: context => context.installation.componentConfigFiles?.lifecycle
      ?? path.join(context.installation.canonicalConfigRoot, 'config.json'),
    eventRoot: ['hooks'],
    activationMode: 'always_enabled',
    distributionId: 'com.exafunction.windsurf',
    detect: context => context.installation.distribution.distributionId === 'com.exafunction.windsurf',
    // Official documentation exposes /hooks for verification but does not
    // promise hot reload for the user config file.
    reload: 'restart_host',
    runtimeAssetsPresent: context => isRegularFile(context.runtime.shimPath)
      && isRegularFile(windsurfLifecycleRuntimeScript(context)),
    runtimeProvenance: context => [windsurfLifecycleRuntimeScript(context)],
    activityRequirement: 'all',
    preserveJsonc: true,
    events: context => windsurfEvents(context),
    identifiesEntry: (event, candidate, context) => {
      if (event.eventName !== 'SessionStart' && event.eventName !== 'SessionEnd') return false
      const record = asObject(candidate)
      const hooks = record?.hooks
      return Array.isArray(hooks) && hooks.some(hook => {
        const commandValue = asObject(hook)?.command
        return typeof commandValue === 'string'
          && commandValue.trimEnd().endsWith(marker(context, event.eventName))
      })
    },
  })
}

export function windsurfLifecycleRuntimeScript(context: AdapterOperationContext): string {
  return path.join(path.dirname(context.runtime.hookScriptPath), 'hook-windsurf-lifecycle.cjs')
}

function windsurfEvents(context: AdapterOperationContext): readonly ManagedHookEvent[] {
  const skillPath = context.installation.componentConfigFiles?.instruction
    ?? path.join(
      context.installation.componentConfigRoots?.instruction
        ?? context.installation.canonicalConfigRoot,
      'skills', 'tidemind', 'SKILL.md',
    )
  return [
    {
      eventName: 'SessionStart',
      signalName: 'session_start',
      entry: {
        matcher: '',
        hooks: [{
          type: 'command',
          command: command(context, 'SessionStart', [
            '--skill-path', skillPath,
            '--expected-skill-sha256', PORTABLE_TIDEMIND_SKILL_SHA256,
          ]),
          timeout: 60,
        }],
      },
    },
    {
      eventName: 'SessionEnd',
      signalName: 'session_end',
      entry: {
        matcher: '',
        hooks: [{
          type: 'command',
          command: command(context, 'SessionEnd'),
          timeout: 10,
        }],
      },
    },
  ]
}

function command(
  context: AdapterOperationContext,
  event: 'SessionStart' | 'SessionEnd',
  extraArgs: readonly string[] = [],
): string {
  const args = [
    context.runtime.shimPath,
    windsurfLifecycleRuntimeScript(context),
    '--event', event,
    '--agent-id', context.agentId,
    ...(context.activityGenerationToken ? ['--activity-generation-token', context.activityGenerationToken] : []),
    ...extraArgs,
  ]
  return `${args.map(shellQuote).join(' ')} ${marker(context, event)}`
}

function marker(
  context: AdapterOperationContext,
  event: ManagedHookEvent['eventName'],
): string {
  return `# tidemind-windsurf-${sha256Bytes(`${context.agentId}\0${event}`).slice(0, 24)}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`
}

function isRegularFile(target: string): boolean {
  try {
    return path.isAbsolute(target) && fs.lstatSync(target).isFile()
  } catch {
    return false
  }
}

function asObject(value: JsonValue): Readonly<Record<string, JsonValue>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : null
}
