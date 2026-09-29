import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { loadHistoricalUpgradeApps, validateHistoricalUpgradeArchive } from '../../scripts/historical-upgrade-apps.mjs'
import { extractPartialCandidateAppArchive } from '../../scripts/verify-partial-auth-release.mjs'
const roots: string[] = []
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')
function temp() { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'old-app-input-'))); roots.push(p); return p }
afterEach(() => roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })))
describe('historical signed upgrade inputs', () => {
  it('freezes exactly the three old ARM signed releases, independently of new candidate provenance', () => {
    const data = loadHistoricalUpgradeApps()
    expect(data.map((item: any) => item.version)).toEqual(['0.2.89', '0.2.91', '0.2.92'])
    expect(data.every((item: any) => item.appIdentity.teamId === 'Z4U232GXH5' && item.appIdentity.architecture === 'arm64')).toBe(true)
    expect(data.every((item: any) => !('sourceCommit' in item.appIdentity))).toBe(true)
  })
  it('rejects archive drift and path aliases before extraction', () => {
    const root = temp(), file = path.join(root, 'archive.zip'), bytes = Buffer.from('old-release-fixture')
    fs.writeFileSync(file, bytes)
    const entry = { artifactSha256: hash(bytes), artifactSizeBytes: bytes.length }
    expect(() => validateHistoricalUpgradeArchive(file, entry)).not.toThrow()
    fs.symlinkSync(file, path.join(root, 'alias.zip'))
    expect(() => validateHistoricalUpgradeArchive(path.join(root, 'alias.zip'), entry)).toThrow()
    fs.writeFileSync(file, Buffer.alloc(bytes.length))
    expect(() => validateHistoricalUpgradeArchive(file, entry)).toThrow(/SHA-256/)
  })
  it.runIf(process.platform === 'darwin')('admits only the exact NTFS timestamp shape in BOTH central and local headers', () => {
    const root = temp()
    const python = String.raw`import sys,zipfile,stat,struct
archive,scenario=sys.argv[1:]
ntfs=b'\0'*4+struct.pack('<HH',1,24)+b'\0'*24
if scenario=='short':ntfs=ntfs[:-1]
if scenario=='subfield':ntfs=b'\0'*4+struct.pack('<HH',2,24)+b'\0'*24
if scenario=='extra-child':ntfs+=struct.pack('<HH',2,0)
with zipfile.ZipFile(archive,'w') as z:
 for name,kind,body in [('Tide Mind.app/',stat.S_IFDIR,b''),('Tide Mind.app/Contents/',stat.S_IFDIR,b''),('Tide Mind.app/Contents/data',stat.S_IFREG,b'fixture')]:
  i=zipfile.ZipInfo(name);i.create_system=3;i.external_attr=(kind|0o755)<<16
  i.extra=struct.pack('<HH',0x000A,len(ntfs))+ntfs;z.writestr(i,body)
if scenario in ('central-reserved','local-reserved','central-length','local-length'):
 data=bytearray(open(archive,'rb').read());central=scenario.startswith('central')
 start=data.index(b'PK\x01\x02' if central else b'PK\x03\x04')
 namesize=struct.unpack_from('<H',data,start+(28 if central else 26))[0]
 extra=start+(46 if central else 30)+namesize
 data[extra+(10 if scenario.endswith('length') else 4)]=23 if scenario.endswith('length') else 1
 open(archive,'wb').write(data)
`
    for (const scenario of ['valid', 'short', 'subfield', 'extra-child', 'central-reserved', 'local-reserved', 'central-length', 'local-length']) {
      const archive = path.join(root, scenario + '.zip'), destination = path.join(root, scenario + '-out')
      execFileSync('/usr/bin/python3', ['-I', '-S', '-c', python, archive, scenario])
      const extract = () => extractPartialCandidateAppArchive(archive, hash(fs.readFileSync(archive)), destination, path.join(root, scenario + '-snapshot.zip'))
      if (scenario === 'valid') { expect(extract().entries).toBe(3); expect(fs.readFileSync(path.join(destination, 'Tide Mind.app/Contents/data'), 'utf8')).toBe('fixture') }
      else { expect(extract, scenario).toThrow(); expect(fs.existsSync(destination), scenario).toBe(false) }
    }
  })
})
