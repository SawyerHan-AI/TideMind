/** Fixed, read-only Codex upgrade input observations; never creates configuration or identity. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { parse } from 'smol-toml'
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const check = (ok, why) => { if (!ok) throw new Error(`Codex upgrade baseline: ${why}`) }
const primary = '.codex/config.toml', hooks = '.codex/hooks.json', skill = '.agents/skills/tidemind/SKILL.md'
export function observeCodexUpgradeConfiguration(home) {
  home = path.resolve(home)
  check(fs.realpathSync(home) === home, 'noncanonical HOME')
  const read = relativePath => {
    const file = path.join(home, relativePath)
    let cursor = home
    for (const part of relativePath.split('/')) {
      cursor = path.join(cursor, part)
      try { check(!fs.lstatSync(cursor).isSymbolicLink(), 'symlink configuration') } catch (error) { if (error.code === 'ENOENT') return { path: relativePath, state: 'absent' }; throw error }
    }
    const stat = fs.statSync(file)
    check(stat.isFile() && stat.size <= 2 * 1024 * 1024, 'invalid configuration file')
    const bytes = fs.readFileSync(file)
    return { path: relativePath, state: 'regular', sha256: hash(bytes), text: bytes.toString('utf8') }
  }
  const files = [read(primary), read(hooks), read(skill)]
  const downloadDir = path.join(home, 'Downloads')
  let downloads = []
  try { check(!fs.lstatSync(downloadDir).isSymbolicLink(), 'symlink Downloads'); downloads = fs.readdirSync(downloadDir).filter(name => /^tidemind-codex-.*\.md$/u.test(name)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  check(downloads.length <= 100, 'too many historical instructions')
  files.push(...downloads.sort().map(name => read('Downloads/' + name)))
  // .89–.93 native Codex instructions used this exact one-level location.
  // Legacy agents may have no ownership ledger or surviving Downloads copy.
  const legacyRoot = path.join(home, '.codex/skills')
  let legacyNames = []
  try { check(!fs.lstatSync(legacyRoot).isSymbolicLink(), 'symlink legacy skills'); legacyNames = fs.readdirSync(legacyRoot).filter(name => name.startsWith('tidemind-')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  check(legacyNames.length <= 100, 'too many legacy instructions')
  files.push(...legacyNames.sort().map(name => read('.codex/skills/' + name + '/SKILL.md')))

  const bindings = [], secondaryAgentIds = []
  let invalid = false, secondaryPresent = files.slice(2).some(file => file.state === 'regular')
  if (files[0].state === 'regular') {
    try {
      const doc = parse(files[0].text)
      check(doc.mcp_servers === undefined || (doc.mcp_servers && typeof doc.mcp_servers === 'object' && !Array.isArray(doc.mcp_servers)), 'invalid MCP container')
      const other = { ...doc }; delete other.mcp_servers
      if (/"(?:tidemind|externabrain)(?:[-_][^"]*)?"\s*:/iu.test(JSON.stringify(other))) invalid = true
      for (const [selector, server] of Object.entries(doc.mcp_servers ?? {})) {
        if (!/^(tidemind|externabrain)([-_]|$)/iu.test(selector)) { if (server?.env?.EB_AGENT_ID !== undefined) invalid = true; continue }
        const agentId = server?.env?.EB_AGENT_ID
        if (typeof agentId !== 'string' || !agentId) invalid = true
        else bindings.push({ selector, agentId })
      }
    } catch { invalid = true }
  }
  if (files[1].state === 'regular') {
    try {
      const doc = JSON.parse(files[1].text), text = JSON.stringify(doc)
      check(doc && typeof doc === 'object' && !Array.isArray(doc), 'invalid Hook document')
      secondaryPresent ||= /tidemind|externabrain|hook-(session|pre-compact|post-compact)/iu.test(text)
      for (const match of text.matchAll(/--agent-id[ '\\"]+([a-zA-Z0-9_-]+)/gu)) secondaryAgentIds.push(match[1])
    } catch { invalid = true }
  }
  return { schemaVersion: 1, catalogId: 'codex-desktop', files: files.map(({text, ...file}) => file), bindings, secondaryAgentIds: [...new Set(secondaryAgentIds)], secondaryPresent, invalid, legacySkillsObserved: true }
}
export function codexUpgradeConfigurationScope(observation, agentId) {
  const value = observation.codexConfiguration
  check(value?.schemaVersion === 1 && value.catalogId === 'codex-desktop' && value.invalid === false, 'missing or invalid fixed configuration observation')
  check(Array.isArray(value.files) && [primary,hooks,skill].every(name => value.files.filter(file => file.path === name).length === 1), 'fixed paths missing or duplicated')
  check(value.files.every(file => ['absent','regular'].includes(file.state) && (file.state === 'absent' || /^[a-f0-9]{64}$/u.test(file.sha256))), 'invalid file facts')
  check(Array.isArray(value.bindings) && Array.isArray(value.secondaryAgentIds), 'binding facts missing')
  check(value.bindings.every(binding => binding.agentId === agentId) && value.secondaryAgentIds.every(id => id === agentId), 'foreign configuration identity')
  if (value.bindings.length) {
    check(value.files.find(file => file.path === primary).state === 'regular', 'binding without configuration')
    return 'configured_host'
  }
  check(value.secondaryPresent === false, 'partial configuration cannot become database-only')
  check(value.legacySkillsObserved === true, 'legacy skill absence was not observed')
  const installations = (observation.tables?.agent_installations?.identities ?? []).filter(row => row.agentId === agentId && row.hostVariant === 'codex-desktop')
  check(!installations.some(row => row.desiredState === 'managed'), 'managed intent without owned configuration')
  if (installations.length) {
    const consumers = observation.tables?.artifact_consumers, artifacts = observation.tables?.managed_artifacts
    check(!consumers?.present || Array.isArray(consumers.ownership), 'missing ownership observation')
    check(!artifacts?.present || Array.isArray(artifacts.ownership), 'missing artifact observation')
    const linked = (consumers?.ownership ?? []).filter(row => installations.some(item => item.id === row.installationId))
    check(!linked.some(row => ['active','removal_pending'].includes(row.state) || (artifacts?.ownership ?? []).some(item => item.id === row.artifactId && item.state === 'removal_pending')), 'owned artifact residue without configuration')
  }
  return 'database_only'
}
export function assertCodexUpgradeIdentity(before, after, agentId, installationId) {
  check(typeof agentId === 'string' && agentId, 'original identity missing')
  const oldAgent = before.tables?.agents?.identities?.find(row => row.id === agentId)
  const oldRows = (before.tables?.agent_installations?.identities ?? []).filter(row => row.agentId === agentId)
  const newRows = (after.tables?.agent_installations?.identities ?? []).filter(row => row.agentId === agentId)
  check(oldAgent || oldRows.length, 'original identity absent')
  if (oldAgent) {
    check(oldAgent.toolType === 'codex', 'legacy Agent belongs to another host')
    check(after.tables?.agents?.identities?.some(row => row.id === agentId && row.toolType === oldAgent.toolType), 'legacy Agent identity lost')
  }
  check(oldRows.every(row => row.hostVariant === 'codex-desktop') && newRows.every(row => row.hostVariant === 'codex-desktop'), 'wrong host variant')
  for (const row of oldRows) check(newRows.some(current => current.id === row.id && current.hostVariant === row.hostVariant), 'original Installation identity lost')
  check(newRows.length <= 1, 'ambiguous Installation identity')
  check(installationId === (newRows[0]?.id ?? null), 'Installation association does not match actual database')
  const scope = codexUpgradeConfigurationScope(before, agentId)
  const afterScope = codexUpgradeConfigurationScope(after, agentId)
  if (scope === 'configured_host') check(afterScope === scope, 'configured host migration lost its binding')
  else check(afterScope === scope && newRows.every(row => row.desiredState !== 'managed'), 'database-only migration silently connected host')
  return scope
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('one isolated HOME required')
  console.log(JSON.stringify(observeCodexUpgradeConfiguration(process.argv[2])))
}
