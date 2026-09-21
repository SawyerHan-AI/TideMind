import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('packaged target metadata exporter Node runtime', () => {
  it.skipIf(process.platform !== 'darwin')('builds without Electron GUI imports and loads under real Electron-as-Node', () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const build = spawnSync(process.execPath, ['client/scripts/build-bin.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    })
    expect(build.status, build.stderr).toBe(0)
    const exporter = path.join(root, 'client/out/bin/agent-host-target-metadata-export.cjs')
    expect(fs.readFileSync(exporter, 'utf8')).not.toMatch(/require\(["']electron["']\)/u)
    const electron = path.join(root, 'client/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    // Import only: never invoke main, open the real profile, or scan host apps.
    const smoke = spawnSync(electron, ['-e', `
      const target = require(${JSON.stringify(exporter)});
      if (typeof target.exportAgentHostTargetMetadata !== 'function') throw new Error('exporter missing');
    `], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(smoke.status, smoke.stderr).toBe(0)
  }, 45_000)
})
