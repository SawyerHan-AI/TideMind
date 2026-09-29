#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} shape invalid`);
}
function verifySignature(signature, message, pem) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) throw new Error('non-canonical Ed25519 signature');
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'))) {
    throw new Error('update signature does not match the embedded public key and release URL');
  }
}

/** Verifies public signature data only. No private key or environment key override is accepted. */
export function verifyUpdateSignatureEnvelope(envelope, { version, architectures, publicKeys }) {
  if (!/^\d+\.\d+\.\d+$/u.test(version) || !Array.isArray(architectures) || !architectures.length
    || new Set(architectures).size !== architectures.length || architectures.some(arch => !['arm64', 'x64'].includes(arch))) {
    throw new Error('invalid expected update signature scope');
  }
  exact(envelope, ['schemaVersion', 'purpose', 'appVersion', 'signatures'], 'update signature envelope');
  if (envelope.schemaVersion !== 1 || envelope.purpose !== 'tidemind_update_url_signatures' || envelope.appVersion !== version
    || !Array.isArray(envelope.signatures)
    || JSON.stringify(envelope.signatures.map(item => item.architecture).sort()) !== JSON.stringify([...architectures].sort())) {
    throw new Error('update signature release/architecture mismatch');
  }
  const files = [];
  const secondaryCount = envelope.signatures.filter(item => item.secondary !== null).length;
  if (secondaryCount !== 0 && secondaryCount !== architectures.length) throw new Error('incomplete secondary signature set');
  for (const item of envelope.signatures) {
    exact(item, ['architecture', 'url', 'primary', 'secondary'], 'update signature item');
    const name = `Tide.Mind-${version}-${item.architecture}.dmg`;
    const url = `https://github.com/SawyerHan-AI/TideMind/releases/download/v${version}/${name}`;
    if (item.url !== url) throw new Error('update signature URL is not the canonical release asset');
    const message = `${version}\n${url}`;
    verifySignature(item.primary, message, publicKeys.primary);
    files.push({ name: `update-manifest-darwin-${item.architecture}.sig`, content: item.primary });
    if (item.secondary !== null) {
      if (!publicKeys.secondary) throw new Error('no embedded secondary verification key');
      verifySignature(item.secondary, message, publicKeys.secondary);
      files.push({ name: `update-manifest-darwin-${item.architecture}.sig.secondary`, content: item.secondary });
    }
  }
  return Object.freeze({ appVersion: version, primaryVerified: true, hasSecondary: secondaryCount > 0, files });
}

export function verifyUpdateSignatureFile(file, expected) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > 65536n) throw new Error('invalid update signature file');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (read === 0) break;
      count += read;
    }
    if (count !== Number(before.size)) throw new Error('update signature file size changed');
    const bytes = buffer.subarray(0, count);
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    for (const stat of [after, current]) {
      if (!stat.isFile() || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'].some(key => stat[key] !== before[key])) {
        throw new Error('update signature file changed during verification');
      }
    }
    return verifyUpdateSignatureEnvelope(JSON.parse(bytes.toString('utf8')), expected);
  } finally { fs.closeSync(fd); }
}

async function runCli() {
  try {
    const args = process.argv.slice(2), values = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      if (!['--file', '--version', '--emit-directory'].includes(key) || values[key] || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new Error('invalid update signature verifier arguments');
      }
      values[key] = args[index + 1];
    }
    if (!values['--file'] || !values['--version']) throw new Error('--file and --version required');
    const root = path.resolve(new URL('..', import.meta.url).pathname);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.version !== values['--version']) throw new Error('update signature version differs from source');
    const { extractEmbeddedUpdatePublicKeys, releaseMacArchitectures } = await import('./release.mjs');
    const result = verifyUpdateSignatureFile(values['--file'], {
      version: pkg.version, architectures: releaseMacArchitectures(pkg.version),
      publicKeys: extractEmbeddedUpdatePublicKeys(fs.readFileSync(path.join(root, 'client/electron/ipc/app.ts'), 'utf8')),
    });
    if (values['--emit-directory']) {
      const destination = path.resolve(values['--emit-directory']);
      const stat = fs.lstatSync(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('signature output directory must be real');
      for (const file of result.files) {
        const output = path.join(destination, file.name);
        if (fs.existsSync(output)) {
          const existing = fs.lstatSync(output);
          if (!existing.isFile() || existing.isSymbolicLink() || fs.readFileSync(output, 'utf8') !== file.content) throw new Error('existing signature differs');
        } else fs.writeFileSync(output, file.content, { flag: 'wx', mode: 0o644 });
      }
    }
    console.log(JSON.stringify({ appVersion: result.appVersion, primaryVerified: true, hasSecondary: result.hasSecondary, files: result.files.map(file => file.name) }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

// Do not await the CLI at module scope: release.mjs statically imports this
// verifier, so its dynamic import must wait until our module has completed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setImmediate(() => { void runCli(); });
}
