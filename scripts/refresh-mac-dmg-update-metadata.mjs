#!/usr/bin/env node
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientRequire = createRequire(path.join(repoRoot, 'client/package.json'))
const yaml = clientRequire('js-yaml')
const { buildBlockMap } = clientRequire('app-builder-lib/out/targets/blockmap/blockmap')

export async function refreshMacDmgUpdateMetadata({ releaseDir, arch, version }) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('arch must be arm64 or x64')
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('version must be exact semver')
  const canonicalReleaseDir = path.resolve(releaseDir)
  const dmgName = `Tide.Mind-${version}-${arch}.dmg`
  const dmg = path.join(canonicalReleaseDir, dmgName)
  const metadata = path.join(canonicalReleaseDir, 'latest-mac.yml')
  if (!fs.lstatSync(dmg).isFile() || !fs.lstatSync(metadata).isFile()) throw new Error('release DMG or metadata must be regular files')

  const blockmap = `${dmg}.blockmap`
  const updateInfo = await buildBlockMap(dmg, 'gzip', blockmap)
  const document = yaml.load(fs.readFileSync(metadata, 'utf8'))
  if (!document || document.version !== version || !Array.isArray(document.files)) throw new Error('invalid mac update metadata')
  const entries = document.files.filter(entry => String(entry?.url ?? '') === dmgName)
  if (entries.length !== 1) throw new Error(`expected exactly one ${dmgName} metadata entry`)
  entries[0].size = updateInfo.size
  entries[0].sha512 = updateInfo.sha512
  if (path.basename(String(document.path ?? '')) === dmgName) {
    document.size = updateInfo.size
    document.sha512 = updateInfo.sha512
  }
  const temporary = `${metadata}.refresh-${process.pid}`
  fs.writeFileSync(temporary, yaml.dump(document, { lineWidth: -1 }), { flag: 'wx' })
  fs.renameSync(temporary, metadata)
  return { dmg, blockmap, metadata, size: updateInfo.size, sha512: updateInfo.sha512 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = name => {
    const index = process.argv.indexOf(name)
    if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing ${name}`)
    return process.argv[index + 1]
  }
  await refreshMacDmgUpdateMetadata({
    releaseDir: argument('--release-dir'),
    arch: argument('--arch'),
    version: argument('--version'),
  })
}
