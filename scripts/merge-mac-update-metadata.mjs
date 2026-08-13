#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import yaml from 'js-yaml'

const releaseDir = path.resolve(process.argv[2] ?? 'client/release')
const documents = ['x64', 'arm64'].map((arch) => {
  const file = path.join(releaseDir, `latest-mac-${arch}.yml`)
  const document = yaml.load(fs.readFileSync(file, 'utf8'))
  if (!document || typeof document !== 'object' || !Array.isArray(document.files)) {
    throw new Error(`invalid update metadata ${file}`)
  }
  for (const entry of document.files) {
    if (!entry || typeof entry.url !== 'string' || entry.url !== path.basename(entry.url)) {
      throw new Error(`update metadata URL must be a basename: ${entry?.url}`)
    }
  }
  if (!document.files.some((entry) => entry?.url?.endsWith(`-${arch}.zip`))) {
    throw new Error(`${file} does not contain the ${arch} ZIP`)
  }
  if (!document.files.some((entry) => entry?.url?.endsWith(`-${arch}.dmg`))) {
    throw new Error(`${file} does not contain the ${arch} DMG`)
  }
  return { arch, document }
})

const versions = new Set(documents.map(({ document }) => document.version))
if (versions.size !== 1) throw new Error('arm64/x64 update metadata version mismatch')
const files = documents.flatMap(({ document }) => document.files)
const urls = files.map((entry) => entry.url)
if (new Set(urls).size !== urls.length) throw new Error('duplicate update metadata URL')
for (const entry of files) {
  if (!entry || typeof entry.url !== 'string' || typeof entry.sha512 !== 'string' || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
    throw new Error('invalid update metadata file entry')
  }
  if (entry.url !== path.basename(entry.url)) {
    throw new Error(`update metadata URL must be a basename: ${entry.url}`)
  }
  const artifact = path.join(releaseDir, entry.url)
  if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
    throw new Error(`update metadata artifact is missing: ${entry.url}`)
  }
  const actualSize = fs.statSync(artifact).size
  if (actualSize !== entry.size) {
    throw new Error(`update metadata size mismatch for ${entry.url}: ${entry.size} != ${actualSize}`)
  }
  const actualSha512 = crypto.createHash('sha512').update(fs.readFileSync(artifact)).digest('base64')
  if (actualSha512 !== entry.sha512) {
    throw new Error(`update metadata sha512 mismatch for ${entry.url}`)
  }
}

const x64Zip = files.find((entry) => entry.url.endsWith('-x64.zip'))
const releaseDates = documents.map(({ document }) => document.releaseDate).filter(Boolean).sort()
const merged = {
  version: documents[0].document.version,
  files,
  path: x64Zip.url,
  sha512: x64Zip.sha512,
  releaseDate: releaseDates.at(-1),
}
fs.writeFileSync(path.join(releaseDir, 'latest-mac.yml'), yaml.dump(merged, { lineWidth: -1, noRefs: true }))
process.stdout.write(`merged macOS update metadata for ${merged.version}: ${files.length} files\n`)
