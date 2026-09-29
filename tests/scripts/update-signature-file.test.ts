import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain release ESM helper
import { verifyUpdateSignatureEnvelope, verifyUpdateSignatureFile } from '../../scripts/verify-update-signature-file.mjs';
// @ts-expect-error plain release ESM helper
import { expectedReleaseAssetNames, assertCompleteReleaseAssetList } from '../../scripts/release.mjs';
const pair = crypto.generateKeyPairSync('ed25519');
const publicKeys = { primary: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), secondary: '' };
const version = '0.2.93';
function fixture(architecture = 'arm64') {
  const url = `https://github.com/SawyerHan-AI/TideMind/releases/download/v${version}/Tide.Mind-${version}-${architecture}.dmg`;
  return { schemaVersion: 1, purpose: 'tidemind_update_url_signatures', appVersion: version,
    signatures: [{ architecture, url, primary: crypto.sign(null, Buffer.from(`${version}\n${url}`), pair.privateKey).toString('base64'), secondary: null }] };
}
const expected = { version, architectures: ['arm64'], publicKeys };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('public update-signature handoff', () => {
  it('verifies the exact version/URL with the supplied embedded public key and emits only public signature data', () => {
    const data = fixture();
    expect(verifyUpdateSignatureEnvelope(data, expected)).toEqual({ appVersion: version, primaryVerified: true, hasSecondary: false,
      files: [{ name: 'update-manifest-darwin-arm64.sig', content: data.signatures[0].primary }] });
  });
  it.each([false, true])('keeps emitted assets compatible with the existing update protocol (secondary=%s)', secondary => {
    const data = fixture();
    const other = crypto.generateKeyPairSync('ed25519');
    const envelope = { ...data, signatures: data.signatures.map(item => ({ ...item,
      secondary: secondary ? crypto.sign(null, Buffer.from(`${version}\n${item.url}`), other.privateKey).toString('base64') : null })) };
    const keys = { ...publicKeys, secondary: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    const result = verifyUpdateSignatureEnvelope(envelope, { ...expected, publicKeys: keys });
    const protocolNames = expectedReleaseAssetNames(version, secondary) as string[];
    expect(result.files.map((file: { name: string }) => file.name).sort()).toEqual(protocolNames.filter(name => name.startsWith('update-manifest-')));
    const assets = [...protocolNames.filter(name => !name.startsWith('update-manifest-')).map(name => ({ name, size: 1 })),
      ...result.files.map((file: { name: string; content: string }) => ({ name: file.name, size: Buffer.byteLength(file.content) }))];
    expect(() => assertCompleteReleaseAssetList(version, assets, true, secondary)).not.toThrow();
  });
  it.each(['version', 'url', 'bytes', 'missing', 'duplicate', 'architecture', 'extra'])('rejects %s drift', kind => {
    const data = fixture();
    if (kind === 'version') data.appVersion = '0.2.92';
    if (kind === 'url') data.signatures[0].url += '?replacement=1';
    if (kind === 'bytes') data.signatures[0].primary = Buffer.alloc(64).toString('base64');
    if (kind === 'missing') data.signatures = [];
    if (kind === 'duplicate') data.signatures.push({ ...data.signatures[0] });
    if (kind === 'architecture') data.signatures[0].architecture = 'x64';
    if (kind === 'extra') Object.assign(data, { allowUnsigned: true });
    expect(() => verifyUpdateSignatureEnvelope(data, expected)).toThrow();
  });
  it('rejects a different signing key rather than trusting a key declared in the evidence', () => {
    const wrong = crypto.generateKeyPairSync('ed25519');
    expect(() => verifyUpdateSignatureEnvelope(fixture(), { ...expected, publicKeys: { primary: wrong.publicKey.export({ type: 'spki', format: 'pem' }).toString(), secondary: '' } })).toThrow();
  });
  it('verifies optional rotation signatures against the separate embedded key', () => {
    const secondary = crypto.generateKeyPairSync('ed25519');
    const data = fixture();
    Object.assign(data.signatures[0], { secondary: crypto.sign(null, Buffer.from(`${version}\n${data.signatures[0].url}`), secondary.privateKey).toString('base64') });
    expect(() => verifyUpdateSignatureEnvelope(data, expected)).toThrow();
    expect(verifyUpdateSignatureEnvelope(data, { ...expected, publicKeys: { ...publicKeys, secondary: secondary.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }).hasSecondary).toBe(true);
  });
  it('rejects a signature-file symlink and preserves the input file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-public-sig-')); dirs.push(dir);
    const file = path.join(dir, 'signatures.json'), alias = path.join(dir, 'alias.json');
    const bytes = JSON.stringify(fixture()); fs.writeFileSync(file, bytes); fs.symlinkSync(file, alias);
    expect(verifyUpdateSignatureFile(file, expected).primaryVerified).toBe(true);
    expect(() => verifyUpdateSignatureFile(alias, expected)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });
});

// Exercise the actual ESM cycle in a separate Node process. Unit imports alone
// never take the verifier's direct-CLI branch and cannot detect exit code 13.
it('runs the real CLI with release.mjs imports, verifies and emits public signatures, and fails tampering', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-signature-cli-'))); dirs.push(dir);
  const scripts = path.join(dir, 'scripts'), ipc = path.join(dir, 'client/electron/ipc'), output = path.join(dir, 'public-signatures');
  fs.mkdirSync(scripts); fs.mkdirSync(ipc, { recursive: true }); fs.mkdirSync(output);
  for (const name of ['verify-update-signature-file.mjs', 'release.mjs', 'agent-integration-host-acceptance-requirements.json']) {
    fs.copyFileSync(fileURLToPath(new URL('../../scripts/' + name, import.meta.url)), path.join(scripts, name));
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(ipc, 'app.ts'), [
    'const UPDATE_PUBLIC_KEY_PEM = process.env.TIDEMIND_UPDATE_PUBLIC_KEY || ' + JSON.stringify(publicKeys.primary) + ';',
    'const UPDATE_PUBLIC_KEY_PEM_SECONDARY = process.env.TIDEMIND_UPDATE_PUBLIC_KEY_SECONDARY ?? "";',
  ].join('\n'));
  const file = path.join(dir, 'signatures.json'), data = fixture();
  fs.writeFileSync(file, JSON.stringify(data));
  const args = [path.join(scripts, 'verify-update-signature-file.mjs'), '--file', file, '--version', version, '--emit-directory', output];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).not.toContain('unsettled top-level await');
  expect(JSON.parse(result.stdout)).toEqual({ appVersion: version, primaryVerified: true, hasSecondary: false, files: ['update-manifest-darwin-arm64.sig'] });
  expect(fs.readFileSync(path.join(output, 'update-manifest-darwin-arm64.sig'), 'utf8')).toBe(data.signatures[0].primary);
  data.signatures[0].primary = Buffer.alloc(64).toString('base64');
  fs.writeFileSync(file, JSON.stringify(data));
  const rejected = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
  expect(rejected.error).toBeUndefined();
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain('update signature does not match');
});
