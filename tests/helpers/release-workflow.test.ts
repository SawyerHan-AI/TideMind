import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveReleaseWorkflowPath } from './release-workflow.js'

describe('release workflow layout resolver', () => {
  it.each([
    ['private source layout', path.join('oss-release', '.github', 'workflows', 'release.yml')],
    ['expanded OSS layout', path.join('.github', 'workflows', 'release.yml')],
  ])('resolves the %s', (_label, relativeWorkflowPath) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-release-layout-'))
    try {
      const workflowPath = path.join(repoRoot, relativeWorkflowPath)
      fs.mkdirSync(path.dirname(workflowPath), { recursive: true })
      fs.writeFileSync(workflowPath, 'name: release\n')
      expect(resolveReleaseWorkflowPath(repoRoot)).toBe(workflowPath)
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when neither layout contains the workflow', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-release-layout-missing-'))
    try {
      expect(() => resolveReleaseWorkflowPath(repoRoot)).toThrow('release workflow not found')
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when both layouts exist', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-release-layout-ambiguous-'))
    try {
      for (const workflowPath of [
        path.join(repoRoot, 'oss-release', '.github', 'workflows', 'release.yml'),
        path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      ]) {
        fs.mkdirSync(path.dirname(workflowPath), { recursive: true })
        fs.writeFileSync(workflowPath, 'name: release\n')
      }
      expect(() => resolveReleaseWorkflowPath(repoRoot)).toThrow('release workflow layout is ambiguous')
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked workflow', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-release-layout-symlink-'))
    try {
      const target = path.join(repoRoot, 'release-target.yml')
      const workflowPath = path.join(repoRoot, '.github', 'workflows', 'release.yml')
      fs.writeFileSync(target, 'name: release\n')
      fs.mkdirSync(path.dirname(workflowPath), { recursive: true })
      fs.symlinkSync(target, workflowPath)
      expect(() => resolveReleaseWorkflowPath(repoRoot)).toThrow('regular non-symlink file')
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
