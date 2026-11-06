import { nativePermissionsForPlan, type SupplementalConsentClaim } from './consent'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { CoordinatorInstallation } from './coordinator'
import type { PreparedCoordinatorPlan } from './planner'
import type { ComponentKey } from './types'
import { variantDeclarationFor } from './variant-declarations'
import { allowsAutomaticConnection, type ConnectionIntent } from './connection-intent'

export interface DefaultConnectionPolicyContext {
  installation: CoordinatorInstallation
  intent: ConnectionIntent
  homeDir: string
  applicationDataDir: string
  mode: 'initial' | 'maintenance' | 'explicit_reconnect'
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const kebab = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
const segment = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 96)
const extension = (value: string) => `tidemind-${value.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0,32) || 'agent'}-${hash(value).slice(0,8)}`
const sameArgs = (left: readonly string[], right: readonly string[]) => JSON.stringify(left) === JSON.stringify(right)

/** Independent of the proposed plan: only code-declared user targets and fixed host component commands. */
export function checkDefaultConnectionPolicy(context: DefaultConnectionPolicyContext, plan: PreparedCoordinatorPlan, maintenanceScopes: readonly SupplementalConsentClaim[] = []): string[] {
  const { installation, intent, homeDir, applicationDataDir } = context
  const { hostVariant: variant, canonicalConfigRoot: root } = installation.identity
  const agent = installation.agentId
  const declaration = variantDeclarationFor(variant, installation.identity.distribution.distributionId)
  const reasons = new Set<string>()
  if (nativePermissionsForPlan(plan.executionPlan).length) reasons.add('native_permission_required')
  if (installation.identity.runtimeRealm !== 'local_macos' || installation.identity.productFamilyId === 'custom-local-agent'
    || !declaration || !['managed','guided'].includes(declaration.disposition)
    || ['claude-cowork-local','custom-local-mcp','claude-desktop-legacy'].includes(variant)) return ['automatic_connection_not_standard']
  if (intent.state !== 'active' || intent.excludedMemberIds.includes(installation.id)
    || (context.mode === 'initial' && !allowsAutomaticConnection(intent))) return ['user_disabled']
  if (context.mode === 'maintenance' && installation.desiredState !== 'managed') return ['user_disabled']
  if (!['connect','repair','upgrade'].includes(plan.operation)) return ['automatic_operation_not_allowed']
  if (!/^[A-Za-z0-9._-]+$/u.test(agent)) return ['automatic_agent_identity_invalid']
  if (plan.componentKeys.some(key => !declaration.logicalComponents.includes(key))) reasons.add('automatic_component_not_allowed')

  const pluginName = `tidemind-${agent}`
  const marketplace = `${kebab(pluginName)}-local`
  const marketplaceRoot = path.join(applicationDataDir, 'agent-integration', 'claude-code-marketplaces', marketplace)
  const qualifiedPlugin = `${pluginName}@${marketplace}`
  const geminiName = extension(agent)
  const geminiStaging = path.join(applicationDataDir, 'agent-integration-staging', 'gemini', geminiName)
  const geminiInstalled = path.join(root, 'extensions', geminiName)
  const piRoot = path.join(applicationDataDir, 'agent-integration', 'pi-packages', segment(agent))
  const openclawId = `tidemind-${kebab(agent)}`
  const openclawRoot = path.join(applicationDataDir, 'agent-integration', 'openclaw-plugins', kebab(agent))
  const claude = variant === 'claude-code-cli' || variant === 'claude-code-native'
  const hostCommandVariant = claude || ['gemini-cli','pi-official-cli','openclaw-local'].includes(variant)
  const resolve = (template: string) => path.resolve(template.replaceAll('$HOME', homeDir)
    .replaceAll('$CONFIG_ROOT', root).replaceAll('$APP_DATA', applicationDataDir).replaceAll('$AGENT_ID', agent))
  const targets = declaration.physicalDomains.map(domain => ({
    path: variant === 'gemini-cli' && domain.id === 'gemini_extension' ? geminiInstalled
      : variant === 'pi-official-cli' && domain.id === 'pi_package_source' ? piRoot
      : resolve(domain.target), components: domain.components,
  }))
  if (variant.startsWith('opencode-')) targets.push({ path: path.join(root, 'opencode.jsonc'), components: ['memory_tools'] })
  const targetAllowed = (target: string, key: ComponentKey) => targets.some(rule => rule.path === path.resolve(target) && rule.components.includes(key))
  const fences = new Set(targets.map(rule => rule.path))
  if (claude) {
    const plugins = path.join(root, 'plugins')
    for (const target of [marketplaceRoot, path.join(root, 'settings.json'),
      path.join(plugins, 'known_marketplaces.json'), path.join(plugins, 'installed_plugins.json'),
      path.join(plugins, 'cache', marketplace, pluginName), path.join(plugins, 'data', `${pluginName}-${marketplace}`)]) fences.add(target)
  }
  if (variant.startsWith('kimi-code-')) fences.add(path.join(root, 'skills', `tidemind-${agent}`, 'SKILL.md'))
  if (variant === 'gemini-cli') fences.add(geminiStaging)
  if (variant === 'openclaw-local') { fences.add(openclawRoot); fences.add(root) }
  const fenceAllowed = (target: string) => fences.has(path.resolve(target)) || (claude
    && path.dirname(target) === path.dirname(marketplaceRoot)
    && target.startsWith(`${marketplaceRoot}.removed-`) && /^[a-z0-9-]+$/u.test(target.slice(marketplaceRoot.length + 9)))

  const selectors = (key: ComponentKey): string[] => {
    if (claude) return [qualifiedPlugin]
    if (variant === 'gemini-cli') return [`gemini-extension:${geminiName}`]
    if (variant === 'pi-official-cli') return [piRoot]
    if (variant === 'openclaw-local') return [openclawId]
    if (key === 'instruction') return ['document']
    if (['qwen-code-cli','zcode-desktop'].includes(variant)) {
      const aggregate = `tidemind.aggregate.${variant}.${agent}`
      return variant === 'zcode-desktop' ? [`${aggregate}.activation-owned`, `${aggregate}.activation-borrowed`, `mcp.servers.tidemind-${agent}`]
        : [aggregate, `mcpServers.tidemind-${agent}`]
    }
    if (key === 'lifecycle') {
      if (variant === 'cursor-desktop') return [`hooks.lifecycle.tidemind-${hash(agent).slice(0,24)}`]
      if (['omp-cli','opencode-v1-cli'].includes(variant)) return ['document']
      return [`hooks.tidemind-${agent}`]
    }
    return [`${variant.startsWith('codex-') ? 'mcp_servers' : variant.startsWith('opencode-') ? 'mcp' : 'mcpServers'}.tidemind-${agent}`]
  }
  const commandAllowed = (args: readonly string[]): boolean => {
    if (claude) return [
      ['plugin','marketplace','add',marketplaceRoot,'--scope','user'],
      ['plugin','uninstall',qualifiedPlugin,'--scope','user'],
      ['plugin','install',qualifiedPlugin,'--scope','user','--yes'],
    ].some(expected => sameArgs(args, expected))
    if (variant === 'gemini-cli') return [
      ['extensions','install',geminiStaging,'--consent','--skip-settings'],
      ['extensions','uninstall',geminiName], ['extensions','enable',geminiName,'--scope','user'],
    ].some(expected => sameArgs(args, expected))
    if (variant === 'pi-official-cli') return sameArgs(args, ['install',piRoot,'--no-approve'])
    if (variant === 'openclaw-local') return [
      ['plugins','install',openclawRoot,'--link','--force','--accept-capabilities'],
      ['config','set',`plugins.entries.${openclawId}.hooks.allowPromptInjection`,'true','--strict-json'],
      ['config','set',`plugins.entries.${openclawId}.hooks.allowConversationAccess`,'true','--strict-json'],
      ['plugins','enable',openclawId,'--accept-capabilities'], ['gateway','restart','--safe','--json'],
    ].some(expected => sameArgs(args, expected))
    return false
  }
  const sequenceAllowed = (commands: readonly { args: readonly string[] }[]) => {
    const args = commands.map(command => command.args)
    if (claude) return (args.length === 2 || args.length === 3)
      && sameArgs(args[0], ['plugin','marketplace','add',marketplaceRoot,'--scope','user'])
      && sameArgs(args.at(-1)!, ['plugin','install',qualifiedPlugin,'--scope','user','--yes'])
      && (args.length === 2 || sameArgs(args[1], ['plugin','uninstall',qualifiedPlugin,'--scope','user']))
    if (variant === 'gemini-cli') return (args.length === 1
      && (sameArgs(args[0], ['extensions','install',geminiStaging,'--consent','--skip-settings'])
        || sameArgs(args[0], ['extensions','enable',geminiName,'--scope','user'])))
      || (args.length === 2 && sameArgs(args[0], ['extensions','uninstall',geminiName])
        && sameArgs(args[1], ['extensions','install',geminiStaging,'--consent','--skip-settings']))
    if (variant === 'pi-official-cli') return args.length === 1 && commandAllowed(args[0])
    if (variant === 'openclaw-local') return args.length === 5
      && args[0][0] === 'plugins' && args[0][1] === 'install'
      && args[1][2] === `plugins.entries.${openclawId}.hooks.allowPromptInjection`
      && args[2][2] === `plugins.entries.${openclawId}.hooks.allowConversationAccess`
      && args[3][0] === 'plugins' && args[3][1] === 'enable' && args[4][0] === 'gateway'
      && args.every(commandAllowed)
    return false
  }
  for (const mutation of plan.executionPlan.mutations) {
    if (!plan.componentKeys.includes(mutation.componentKey) || mutation.risk === 'high'
      || (mutation.risk === 'elevated' && !hostCommandVariant)) reasons.add('automatic_risk_not_allowed')
    if (!selectors(mutation.componentKey).includes(mutation.ownershipSelector)) reasons.add('automatic_selector_not_allowed')
    if (mutation.targetPath !== null && !targetAllowed(mutation.targetPath, mutation.componentKey)) reasons.add('automatic_target_not_allowed')
    if (mutation.targetPath === null && !(claude || variant === 'openclaw-local')) reasons.add('automatic_target_not_allowed')
    if (mutation.action === 'remove') reasons.add('automatic_removal_not_allowed')
    if (hostCommandVariant && mutation.action !== 'invoke') reasons.add('automatic_command_not_allowed')
    const commands = mutation.commands ?? (mutation.command ? [mutation.command] : [])
    if (mutation.action === 'invoke' && !sequenceAllowed(commands)) reasons.add('automatic_command_not_allowed')
    for (const command of commands) {
      if (!['plugin_install','host_cli'].includes(command.category)
        || command.executablePath !== installation.identity.distribution.executableRealpath
        || !commandAllowed(command.args)) reasons.add('automatic_command_not_allowed')
    }
    if (commands.length === 0 && !['none','file_write'].includes(mutation.commandCategory)) reasons.add('automatic_command_not_allowed')
    for (const fence of mutation.additionalFenceTargets ?? []) if (!fenceAllowed(fence.targetPath)) reasons.add('automatic_target_not_allowed')
    const transfer = mutation.ownershipTransferFrom
    if (transfer) {
      const legacySkill = path.join(root,'skills',`tidemind-${agent}`,'SKILL.md')
      const knownSkill = variant.startsWith('kimi-code-') && transfer.targetPath === legacySkill && transfer.ownershipSelector === 'document'
      const knownSelector = transfer.targetPath === mutation.targetPath && ['mcpServers.tidemind','mcp_servers.tidemind','mcp.tidemind'].includes(transfer.ownershipSelector)
      if (!knownSkill && !knownSelector) reasons.add('automatic_ownership_transfer_not_allowed')
    }
  }
  for (const scope of maintenanceScopes) {
    const logicalTarget = (claude && scope.targetPath === `claude:user:${qualifiedPlugin}`)
      || (variant === 'openclaw-local' && scope.targetPath === `openclaw:user:${openclawId}`)
    if (!plan.componentKeys.includes(scope.componentKey) || !selectors(scope.componentKey).includes(scope.ownershipSelector)
      || scope.targetPath === null || (!logicalTarget && !targetAllowed(scope.targetPath, scope.componentKey))
      || !['read_only','low'].includes(scope.risk) || !['none','file_write'].includes(scope.commandCategory)) {
      reasons.add('automatic_maintenance_scope_not_allowed')
    }
  }
  return [...reasons]
}
