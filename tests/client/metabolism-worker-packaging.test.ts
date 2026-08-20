import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readReleaseWorkflow } from '../helpers/release-workflow.js'

describe('metabolism Worker packaged candidate', () => {
  it('is a built bin entry covered by asarUnpack with native dependencies', () => {
    const buildScript = fs.readFileSync(path.join(process.cwd(), 'client/scripts/build-bin.mjs'), 'utf8')
    const entry = fs.readFileSync(path.join(process.cwd(), 'client/electron/workers/metabolism-worker-entry.ts'), 'utf8')
    const builder = fs.readFileSync(path.join(process.cwd(), 'client/electron-builder.yml'), 'utf8')
    expect(buildScript).toContain("'metabolism-worker.cjs'")
    expect(buildScript).toContain("'metabolism-worker-entry.ts'")
    expect(buildScript).toContain("const NATIVE_EXTERNALS = ['better-sqlite3', 'sqlite-vec']")
    expect(builder).toContain('- "out/bin/**"')
    expect(builder).toContain('- "**/better-sqlite3/**"')
    expect(builder).toContain('- "**/sqlite-vec*/**"')
    expect(builder).toContain('to: "app.asar.unpacked/node_modules"')
    expect(builder).toContain('- "bindings/**/*"')
    expect(builder).toContain('- "file-uri-to-path/**/*"')
    expect(entry).toContain('taskExecutionContext:')
    expect(entry).toContain("isForeground: () => scheduleContext?.mode === 'foreground'")
  })

  it('pins release actions and verifies each architecture before publishing', () => {
    const workflow = readReleaseWorkflow(process.cwd())
    const builder = fs.readFileSync(path.join(process.cwd(), 'client/electron-builder.yml'), 'utf8')
    expect(workflow).toContain('runner: macos-15')
    expect(workflow).toContain('runner: macos-15-intel')
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+/)
    expect(workflow).toContain('Require Apple signing and notarization secrets')
    expect(workflow).toContain('verify-mac-release-assets.mjs')
    expect(workflow).toContain('Notarize and staple architecture DMG')
    expect(workflow).toContain('xcrun notarytool submit "$dmg"')
    expect(workflow).toContain('xcrun stapler staple "$dmg"')
    expect(workflow).toContain('refresh-mac-dmg-update-metadata.mjs')
    expect(builder).toMatch(/dmg:\s*\n(?:\s*#.*\n)*\s*sign:\s*true/)
    expect(workflow.indexOf('Notarize and staple architecture DMG'))
      .toBeLessThan(workflow.indexOf('Verify signed/notarized package and native architecture'))
    expect(builder).not.toContain('arch: [x64, arm64]')
    expect(workflow).toContain('smoke-packaged-metabolism-worker.mjs --arch ${{ matrix.arch }}')
    expect(workflow).toContain('merge-mac-update-metadata.mjs')
    expect(workflow).toContain('needs: build-mac')
  })

  it('produces the actual non-empty Worker bundle', () => {
    const bundle = path.join(process.cwd(), 'client/out/bin/metabolism-worker.cjs')
    expect(fs.statSync(bundle).isFile()).toBe(true)
    expect(fs.statSync(bundle).size).toBeGreaterThan(100_000)
    const source = fs.readFileSync(bundle, 'utf8')
    expect(source).toContain('metabolism worker requires parentPort')
    expect(source).toContain('runSchedulerTick')
  })
})
