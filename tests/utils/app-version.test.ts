import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { getTideMindVersion } from '../../src/utils/app-version.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('Tide Mind runtime version', () => {
  it('reads the validated root package version in source mode', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      name: string
      version: string
    }
    expect(pkg.name).toBe('tidemind')
    expect(getTideMindVersion()).toBe(pkg.version)
  })

  it('uses the build-time version when the bundle has no package.json ancestor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-bundled-version-'))
    const entry = path.join(root, 'entry.ts')
    const output = path.join(root, 'runtime.mjs')
    fs.writeFileSync(entry, `
      import { getTideMindVersion } from ${JSON.stringify(path.join(repoRoot, 'src/utils/app-version.ts'))};
      process.stdout.write(getTideMindVersion());
    `)
    try {
      await build({
        entryPoints: [entry],
        outfile: output,
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        define: {
          '__TIDEMIND_BUNDLED_VERSION__': JSON.stringify('9.8.7-packaged-fixture'),
        },
        logLevel: 'silent',
      })
      expect(execFileSync(process.execPath, [output], {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      })).toBe('9.8.7-packaged-fixture')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
