import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = path.resolve(CLIENT_ROOT, '..')

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(target) : [target]
  })
}

function sourceCandidatesForArtifact(artifact) {
  if (artifact.endsWith('.d.ts.map')) {
    const stem = artifact.slice(0, -'.d.ts.map'.length)
    return [`${stem}.ts`, `${stem}.tsx`]
  }
  if (artifact.endsWith('.js.map')) {
    const stem = artifact.slice(0, -'.js.map'.length)
    return [`${stem}.ts`, `${stem}.tsx`]
  }
  if (artifact.endsWith('.d.ts')) {
    const stem = artifact.slice(0, -'.d.ts'.length)
    return [`${stem}.ts`, `${stem}.tsx`]
  }
  if (artifact.endsWith('.js')) {
    const stem = artifact.slice(0, -'.js'.length)
    return [`${stem}.ts`, `${stem}.tsx`]
  }
  return []
}

export function findSourceBuildArtifacts(sourceRoot, trackedFiles = new Set()) {
  return walk(sourceRoot).filter(candidate => {
    const relative = path.relative(sourceRoot, candidate).split(path.sep).join('/')
    if (trackedFiles.has(relative)) return false
    return sourceCandidatesForArtifact(candidate).some(source => fs.existsSync(source))
  })
}

export function assertSourceBuildArtifactsAbsent(sourceRoot, trackedFiles = new Set()) {
  const artifacts = findSourceBuildArtifacts(sourceRoot, trackedFiles)
  if (artifacts.length > 0) {
    const relativeArtifacts = artifacts
      .map(artifact => path.relative(sourceRoot, artifact).split(path.sep).join('/'))
      .sort()
    throw new Error(
      [
        'Potential build artifacts were found beside renderer source files.',
        'No files were changed. Review and remove only files you know are generated:',
        ...relativeArtifacts.map(artifact => `  - ${artifact}`),
      ].join('\n'),
    )
  }
  return artifacts
}

function trackedSourceFiles() {
  const output = execFileSync('git', ['-C', REPOSITORY_ROOT, 'ls-files', '-z', '--', 'client/src'], {
    encoding: 'utf8',
  })
  return new Set(output.split('\0').filter(Boolean).map(file => file.replace(/^client\/src\//u, '')))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceRoot = path.join(CLIENT_ROOT, 'src')
  try {
    assertSourceBuildArtifactsAbsent(sourceRoot, trackedSourceFiles())
    console.log('[source-artifact-hygiene] renderer source is clean')
  } catch (error) {
    console.error(`[source-artifact-hygiene] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
