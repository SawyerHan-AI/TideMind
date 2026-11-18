import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAntigravityHostAdapter } from '../../client/electron/agent-integration/hosts/antigravity-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { getCatalogVariant } from '../../client/electron/agent-integration/catalog'
import { ANTIGRAVITY_RULE_TEMPLATE, ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE, renderAntigravityRule } from '../../src/antigravity-instruction'
import type { AdapterOperationContext } from '../../client/electron/agent-integration/types'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function context(hostVariant: 'antigravity-app' | 'antigravity-cli' = 'antigravity-app'): AdapterOperationContext {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-adapter-')); roots.push(home)
  const configRoot = path.join(home, '.gemini', 'config'); fs.mkdirSync(configRoot, { recursive: true })
  return { agentId: 'synthetic-agent', operationId: 'op', activityGenerationToken: 'synthetic-token',
    installation: canonicalizeInstallationIdentity({ runtimeRealm: 'local_macos', osUserIdentity: 'synthetic-user', productFamilyId: 'antigravity', hostVariant, configRoot }),
    runtime: { runtimeRealm: 'local_macos', homeDir: home, applicationDataDir: path.join(home, 'data'),
      shimPath: '/Applications/Tide Mind.app/tm-node', mcpServerPath: '/Applications/Tide Mind.app/mcp.cjs',
      hookScriptPath: '/Applications/Tide Mind.app/hook.cjs', preCompactScriptPath: 'unused', postCompactScriptPath: 'unused',
      tideMindVersion: 'test', catalogVersion: 'test', projectionVersion: '1' } }
}

describe('Antigravity shared configuration projection', () => {
  it.each(['antigravity-app', 'antigravity-cli'] as const)('writes %s with independent Rule, MCP and start blocks while preserving neighbors', async variant => {
    const ctx = context(variant); const root = ctx.installation.canonicalConfigRoot
    fs.writeFileSync(path.join(root, 'mcp_config.json'), '')
    fs.writeFileSync(path.join(root, 'hooks.json'), JSON.stringify({ user: { Stop: [{ command: 'true' }] } }))
    const adapter = createAntigravityHostAdapter(variant)
    const plan = await adapter.plan(ctx, { desiredCapability: 3, desiredComponents: ['instruction','memory_tools','lifecycle'], observed: await adapter.inspect(ctx), ownedArtifacts: [] })
    expect(plan.diagnostics).toEqual([]); expect(plan.mutations).toHaveLength(3)
    const memoryReload = variant === 'antigravity-app' ? 'restart_host' : 'new_session'
    expect(plan.mutations.find(mutation => mutation.componentKey === 'memory_tools')?.reload).toBe(memoryReload)
    expect(adapter.componentContracts?.memory_tools?.reload).toBe(memoryReload)
    expect(getCatalogVariant(variant).components.find(component => component.componentKey === 'memory_tools')?.reload).toBe(memoryReload)
    for (const component of ['instruction', 'lifecycle'] as const) {
      expect(plan.mutations.find(mutation => mutation.componentKey === component)?.reload).toBe('new_session')
      expect(getCatalogVariant(variant).components.find(candidate => candidate.componentKey === component)?.reload).toBe('new_session')
    }
    for (const mutation of plan.mutations) { await adapter.apply(ctx, mutation); expect((await adapter.readBack(ctx, mutation)).matchesDesired).toBe(true) }
    const rule = fs.readFileSync(path.join(root, 'rules', 'tidemind.md'), 'utf8')
    expect(rule).toBe(renderAntigravityRule(ctx.agentId))
    const mcp = JSON.parse(fs.readFileSync(path.join(root, 'mcp_config.json'), 'utf8')).mcpServers['tidemind-synthetic-agent']
    const routedPrepare = JSON.parse(rule.split('\n').find(line => line.startsWith('{"ServerName"'))!)
    expect(routedPrepare).toEqual({ ServerName: 'tidemind-' + ctx.agentId, ToolName: 'brain_prepare', Arguments: {
      tool: 'Antigravity', detail_level: 'brief', integration_probe: ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE,
    } })
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'mcp_config.json'), 'utf8')).mcpServers)).toContain(routedPrepare.ServerName)
    expect(rule).not.toContain('__TIDEMIND_SERVER_NAME__')
    expect(mcp).not.toHaveProperty('tools')
    expect(mcp).not.toHaveProperty('permissions')
    expect(mcp.env).toEqual({ EB_AGENT_ID: ctx.agentId, EB_ACTIVITY_GENERATION_TOKEN: ctx.activityGenerationToken })
    const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks.json'), 'utf8'))
    expect(hooks.user.Stop).toHaveLength(1)
    const managed = hooks['tidemind-synthetic-agent']
    expect(Object.keys(managed)).toEqual(['SessionStart'])
    expect(managed.SessionStart[0].command).toContain("'antigravity'")
    expect(managed.SessionStart[0].command).not.toContain(ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE)
    expect(managed.SessionStart[0].command).not.toContain('--skill-path')
    expect(getCatalogVariant(variant).maxCapability).toBe(3)
  })
  it('preserves an explicit user disable and does not grant tools', async () => {
    const ctx=context();const root=ctx.installation.canonicalConfigRoot;const target=path.join(root,'mcp_config.json')
    const source=JSON.stringify({mcpServers:{'tidemind-synthetic-agent':{command:'user',disabled:true}}})
    fs.writeFileSync(target,source);const adapter=createAntigravityHostAdapter('antigravity-app')
    const plan=await adapter.plan(ctx,{desiredCapability:2,desiredComponents:['memory_tools'],observed:await adapter.inspect(ctx),ownedArtifacts:[]})
    expect(plan.mutations).toHaveLength(0);expect(plan.requiredUserActions).toEqual(['review_antigravity_mcp_disabled']);expect(plan.diagnostics).toContain('antigravity_component_disabled');expect(fs.readFileSync(target,'utf8')).toBe(source)
  })
  it.each([
    ['memory_tools', 'mcp_config.json', { mcpServers: { 'tidemind-synthetic-agent': { enabledTools: ['brain_prepare'] } } }, 'review_antigravity_tool_filter'],
    ['memory_tools', 'mcp_config.json', { mcpServers: { 'tidemind-synthetic-agent': { disabledTools: ['brain_digest'] } } }, 'review_antigravity_tool_filter'],
    ['lifecycle', 'hooks.json', { 'tidemind-synthetic-agent': { enabled: false, SessionStart: [] } }, 'review_antigravity_hook_disabled'],
  ] as const)('reports exact activation action for %s %s', async (component, filename, document, action) => {
    const ctx = context(); const target = path.join(ctx.installation.canonicalConfigRoot, filename)
    const source = JSON.stringify(document); fs.writeFileSync(target, source)
    const adapter = createAntigravityHostAdapter('antigravity-app')
    const plan = await adapter.plan(ctx, { desiredCapability: 3, desiredComponents: [component], observed: await adapter.inspect(ctx), ownedArtifacts: [] })
    expect(plan.mutations).toHaveLength(0)
    expect(plan.requiredUserActions).toEqual([action])
    expect(fs.readFileSync(target, 'utf8')).toBe(source)
  })
  it('does not accept malformed or JSONC files as blank configuration', async () => {
    const ctx=context();const target=path.join(ctx.installation.canonicalConfigRoot,'mcp_config.json');const source='{// comment\n}'
    fs.writeFileSync(target,source);const adapter=createAntigravityHostAdapter('antigravity-app')
    const observed=await adapter.inspect(ctx);expect(observed.components.find(c=>c.componentKey==='memory_tools')?.visibility).toBe('unknown')
    const plan=await adapter.plan(ctx,{desiredCapability:2,desiredComponents:['memory_tools'],observed,ownedArtifacts:[]})
    expect(plan.mutations).toHaveLength(0);expect(fs.readFileSync(target,'utf8')).toBe(source)
  })
  it('removes only the owned hook selector and keeps user hooks', async () => {
    const ctx=context();const root=ctx.installation.canonicalConfigRoot;const adapter=createAntigravityHostAdapter('antigravity-app')
    fs.writeFileSync(path.join(root,'hooks.json'),JSON.stringify({user:{Stop:[]}}))
    const plan=await adapter.plan(ctx,{desiredCapability:3,desiredComponents:['lifecycle'],observed:await adapter.inspect(ctx),ownedArtifacts:[]})
    const mutation=plan.mutations[0];await adapter.apply(ctx,mutation)
    const remove=await adapter.disconnect(ctx,{componentKeys:['lifecycle'],observed:await adapter.inspect(ctx),ownedArtifacts:[{componentKey:'lifecycle',physicalTarget:mutation.physicalTarget,ownershipKey:mutation.ownershipKey,ownedFragmentHash:mutation.desiredFragmentHash!}]})
    expect(remove.mutations).toHaveLength(1);await adapter.apply(ctx,remove.mutations[0])
    expect(JSON.parse(fs.readFileSync(path.join(root,'hooks.json'),'utf8'))).toEqual({user:{Stop:[]}})
  })
  it('uses one canonical server name across shared members and renders distinct domains independently', () => {
    const first = context('antigravity-app')
    const second = context('antigravity-cli')
    expect(renderAntigravityRule(first.agentId)).toBe(renderAntigravityRule(second.agentId))
    const other = renderAntigravityRule('other-canonical-agent')
    expect(other).toContain('"ServerName":"tidemind-other-canonical-agent"')
    expect(other).not.toContain('tidemind-synthetic-agent')
    expect(() => renderAntigravityRule('invalid"agent')).toThrow('invalid_antigravity_agent_id')
  })
  it('keeps the editable rule and bundled fallback byte-identical', () => {
    expect(fs.readFileSync(path.resolve('data/skill/antigravity-rule.md'),'utf8')).toBe(ANTIGRAVITY_RULE_TEMPLATE)
  })
})
