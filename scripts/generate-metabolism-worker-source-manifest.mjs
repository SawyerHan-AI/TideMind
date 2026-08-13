import crypto from 'node:crypto'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const excluded = new Set([
  'docs/design/evidence/local-metabolism-worker-production-activation-2026-08-12.json',
])
const paths = execFileSync('git', ['ls-files', '-m', '-o', '--exclude-standard', '-z'])
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter(filePath => !excluded.has(filePath))
  .filter(filePath => !filePath.startsWith('client/out/') && !filePath.startsWith('client/release/'))
  .filter(filePath => fs.statSync(filePath, { throwIfNoEntry: false })?.isFile() && !fs.lstatSync(filePath).isSymbolicLink())
  .sort()

const hash = crypto.createHash('sha256')
for (const filePath of paths) {
  hash.update(filePath).update('\0')
  hash.update(crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest()).update('\0')
}

process.stdout.write(`${JSON.stringify({ protocolVersion: 1, files: paths.length, sha256: hash.digest('hex') })}\n`)
