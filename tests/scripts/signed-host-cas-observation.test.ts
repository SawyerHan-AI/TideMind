import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { parse } from 'smol-toml'
import { changeOwnedCodexTable, changeGeneratedZipComment, replaceFileIfHash } from '../../scripts/signed-host-cas-observation.mjs'
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const fixture = fn => { const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-cas-test-'))); try { fn(home) } finally { fs.rmSync(home, { recursive: true, force: true }) } }
test('owned TOML CAS modifies only selected entry semantics and preserves unrelated table', () => {
  const original = Buffer.from('[general]\nname="unrelated"\n[mcp_servers.tidemind-eb_real]\ncommand="shim"\n[mcp_servers.tidemind-eb_real.env]\nEB_AGENT_ID="eb_real"\n')
  const changed = changeOwnedCodexTable(original, 'mcp_servers.tidemind-eb_real', 'eb_real', 'nonce')
  const before = parse(original.toString()), after = parse(changed.toString())
  assert.deepEqual(after.general, before.general)
  assert.equal(after.mcp_servers['tidemind-eb_real'].command, 'shim')
  assert.equal(after.mcp_servers['tidemind-eb_real'].env.TIDEMIND_CAS_OBSERVATION, 'nonce')
  assert.throws(() => changeOwnedCodexTable(original, 'mcp_servers.tidemind-eb_other', 'eb_real', 'nonce'))
  assert.throws(() => changeOwnedCodexTable(changed, 'mcp_servers.tidemind-eb_real', 'eb_real', 'nonce'))
})
test('generated ZIP comment changes archive hash while retaining every entry/CRC/directory byte', () => {
  const original = Buffer.from('UEsDBBQAAAAAAKAGPl3lLe0PEwAAABMAAAANAAAAbWFuaWZlc3QuanNvbnsibmFtZSI6InRpZGVtaW5kIn1QSwECFAMUAAAAAACgBj5d5S3tDxMAAAATAAAADQAAAAAAAAAAAAAAgAEAAAAAbWFuaWZlc3QuanNvblBLBQYAAAAAAQABADsAAAA+AAAAAAA=', 'base64')
  const changed = changeGeneratedZipComment(original, 'nonce')
  assert.deepEqual(changed.subarray(0, original.length - 2), original.subarray(0, original.length - 2))
  assert.equal(changed.readUInt16LE(original.length - 2), changed.length - original.length)
  assert.notEqual(hash(changed), hash(original))
  assert.throws(() => changeGeneratedZipComment(Buffer.from('not zip'), 'nonce'))
})
test('restore refuses a later writer instead of overwriting it', () => fixture(home => {
  const file = path.join(home, 'config.toml'), original = Buffer.from('original'), modified = Buffer.from('modified')
  fs.writeFileSync(file, original)
  replaceFileIfHash(file, hash(original), modified, home)
  fs.writeFileSync(file, 'third party edit')
  assert.throws(() => replaceFileIfHash(file, hash(modified), original, home))
  assert.equal(fs.readFileSync(file, 'utf8'), 'third party edit')
}))
test('CAS mutation and restoration preserve original bytes and mode', () => fixture(home => {
  const file = path.join(home, 'config.toml'), original = Buffer.from('original'), modified = Buffer.from('long modified bytes')
  fs.writeFileSync(file, original, { mode: 0o600 })
  replaceFileIfHash(file, hash(original), modified, home)
  replaceFileIfHash(file, hash(modified), original, home)
  assert.deepEqual(fs.readFileSync(file), original)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
}))
