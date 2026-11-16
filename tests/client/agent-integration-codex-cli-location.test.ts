import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { codexLauncherParentIdentity, confirmedMissingCodexLauncher } from '../../client/electron/agent-integration/codex-cli-location'

it('only confirms a missing launcher under the same reachable canonical parent', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cli-location-')))
  try {
    const parent = path.join(root, 'bin')
    const launcher = path.join(parent, 'codex.js')
    await fs.mkdir(parent)
    await fs.writeFile(launcher, 'fixture')
    const source = await codexLauncherParentIdentity(launcher)
    expect(source).toBeTruthy()
    expect(await confirmedMissingCodexLauncher(launcher, source)).toBe(false)
    await fs.unlink(launcher)
    expect(await confirmedMissingCodexLauncher(launcher, source)).toBe(true)
    expect(await confirmedMissingCodexLauncher(launcher, null)).toBe(false)
    await fs.rename(parent, path.join(root, 'original'))
    expect(await confirmedMissingCodexLauncher(launcher, source)).toBe(false)
    await fs.mkdir(parent)
    expect(await confirmedMissingCodexLauncher(launcher, source)).toBe(false)
    await fs.rmdir(parent)
    await fs.symlink(path.join(root, 'original'), parent)
    expect(await confirmedMissingCodexLauncher(launcher, source)).toBe(false)
  } finally {
    await fs.rm(root, {recursive:true,force:true})
  }
})
