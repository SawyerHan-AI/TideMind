/* global process */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function protectedRealAgentPaths(homeDir) {
  return [
    path.join(homeDir, '.agents', 'skills', 'tidemind'),
    path.join(homeDir, '.zcode', 'skills', 'tidemind'),
    path.join(homeDir, '.zcode', 'config.json'),
    path.join(homeDir, '.zcode', 'cli', 'config.json'),
    // The isolated fixture uses a distinct profile root; protect its exact
    // real-HOME analogue as well as the production default above.
    path.join(homeDir, '.zcode-default', 'config.json'),
  ]
}

export function runWithRealHomeGuard({
  command,
  args,
  protectedPaths,
  timeoutMs,
  env = process.env,
  stdio = 'inherit',
}) {
  const before = new Map(protectedPaths.map(target => [target, fingerprintTree(target)]))
  let result
  let spawnError
  try {
    result = spawnSync(command, args, { env, stdio, timeout: timeoutMs })
  } catch (error) {
    spawnError = error
  }

  const changed = protectedPaths.filter(target => fingerprintTree(target) !== before.get(target))
  if (changed.length > 0) {
    const childOutcome = result
      ? `status=${String(result.status)} signal=${String(result.signal)} error=${result.error?.message ?? 'none'}`
      : `spawn_error=${spawnError instanceof Error ? spawnError.message : String(spawnError)}`
    throw new Error(`isolated UI E2E changed real Agent configuration (${childOutcome}): ${changed.join(', ')}`)
  }
  if (spawnError) throw spawnError
  return result
}

export function fingerprintTree(target) {
  if (!fs.existsSync(target)) return 'absent'
  const entries = []
  const visit = current => {
    const stat = fs.lstatSync(current)
    const relative = path.relative(target, current) || '.'
    const mode = stat.mode & 0o777
    if (stat.isSymbolicLink()) {
      entries.push(['link', relative, mode, fs.readlinkSync(current)])
      return
    }
    if (stat.isDirectory()) {
      entries.push(['dir', relative, mode])
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name))
      return
    }
    entries.push(['file', relative, mode, createHash('sha256').update(fs.readFileSync(current)).digest('hex')])
  }
  visit(target)
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}
