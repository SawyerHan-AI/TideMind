import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSourceBuildArtifactsAbsent,
  findSourceBuildArtifacts,
} from '../../client/scripts/clean-source-build-artifacts.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('renderer source artifact hygiene', () => {
  it('reports possible emit without deleting untracked same-stem authored files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-source-artifacts-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'types'))
    fs.writeFileSync(path.join(root, 'AgentIntegration.tsx'), 'export const AgentIntegration = 1\n')
    fs.writeFileSync(path.join(root, 'AgentIntegration.js'), 'export const AgentIntegration = 0\n')
    fs.writeFileSync(path.join(root, 'AgentIntegration.d.ts'), 'export declare const AgentIntegration = 0\n')
    fs.writeFileSync(path.join(root, 'types', 'window.d.ts'), 'declare global {}\n')
    fs.writeFileSync(path.join(root, 'authored.ts'), 'export const source = true\n')
    fs.writeFileSync(path.join(root, 'authored.js'), 'export const authored = true\n')

    const tracked = new Set(['types/window.d.ts', 'authored.js'])
    expect(findSourceBuildArtifacts(root, tracked).map(file => path.basename(file)).sort())
      .toEqual(['AgentIntegration.d.ts', 'AgentIntegration.js'])
    expect(() => assertSourceBuildArtifactsAbsent(root, tracked)).toThrowError(
      /No files were changed[\s\S]*AgentIntegration\.d\.ts[\s\S]*AgentIntegration\.js/u,
    )
    expect(fs.readFileSync(path.join(root, 'AgentIntegration.js'), 'utf8'))
      .toBe('export const AgentIntegration = 0\n')
    expect(fs.readFileSync(path.join(root, 'AgentIntegration.d.ts'), 'utf8'))
      .toBe('export declare const AgentIntegration = 0\n')
    expect(fs.existsSync(path.join(root, 'types', 'window.d.ts'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'authored.js'))).toBe(true)
  })

  it('fails closed when renderer source contains a possible build artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-source-artifacts-'))
    roots.push(root)
    fs.writeFileSync(path.join(root, 'handwritten.ts'), 'export const source = true\n')
    fs.writeFileSync(path.join(root, 'handwritten.js'), 'export const authored = true\n')

    expect(() => assertSourceBuildArtifactsAbsent(root)).toThrowError(/handwritten\.js/u)
    expect(fs.readFileSync(path.join(root, 'handwritten.js'), 'utf8'))
      .toBe('export const authored = true\n')
  })

  it('keeps renderer resolution TypeScript-first and forbids future source emit', () => {
    const vite = fs.readFileSync(path.resolve('client/electron.vite.config.ts'), 'utf8')
    const tsconfig = JSON.parse(fs.readFileSync(path.resolve('client/tsconfig.web.json'), 'utf8'))
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('client/package.json'), 'utf8'))
    expect(vite).toContain("extensions: ['.tsx', '.ts'")
    expect(tsconfig.compilerOptions.noEmit).toBe(true)
    expect(packageJson.scripts.predev).toContain('check:source-artifacts')
    expect(packageJson.scripts.prebuild).toContain('check:source-artifacts')
    expect(packageJson.scripts['check:source-artifacts']).toContain('clean-source-build-artifacts.mjs')
  })
})
