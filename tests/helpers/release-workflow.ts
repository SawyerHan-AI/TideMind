import fs from 'node:fs'
import path from 'node:path'

export function resolveReleaseWorkflowPath(repoRoot: string, workflowName: 'release.yml' | 'host-no-auth-acceptance.yml' = 'release.yml'): string {
  const candidates = [
    path.join(repoRoot, 'oss-release', '.github', 'workflows', workflowName),
    path.join(repoRoot, '.github', 'workflows', workflowName),
  ]
  const existing = candidates.filter((candidate) => fs.existsSync(candidate))
  if (existing.length === 0) {
    throw new Error(`release workflow not found in private or OSS layout: ${candidates.join(', ')}`)
  }
  if (existing.length !== 1) {
    throw new Error(`release workflow layout is ambiguous: ${existing.join(', ')}`)
  }
  const [workflowPath] = existing
  const stat = fs.lstatSync(workflowPath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`release workflow must be a regular non-symlink file: ${workflowPath}`)
  }
  return workflowPath
}

export function readReleaseWorkflow(repoRoot: string, workflowName: 'release.yml' | 'host-no-auth-acceptance.yml' = 'release.yml'): string {
  return fs.readFileSync(resolveReleaseWorkflowPath(repoRoot, workflowName), 'utf8')
}
