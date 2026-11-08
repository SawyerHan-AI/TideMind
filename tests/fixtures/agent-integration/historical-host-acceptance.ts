import fs from 'node:fs'
import path from 'node:path'

export const historical094RequirementsPath = path.resolve('tests/fixtures/agent-integration/host-acceptance-requirements-0.2.94.json')

export function writeHistorical094HostManifest(root: string): string {
  const source = fs.readFileSync('client/electron/agent-integration/release-manifest.ts', 'utf8')
  const file = path.join(root, 'release-manifest-0.2.94.ts')
  fs.writeFileSync(file, source.replace(/AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION = '[^']+'/u,
    "AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION = '0.2.94'"))
  return file
}

// Frozen from the pre-0.2.96 source; never substitute the current release contract.
export const historical095RequirementsPath = path.resolve('tests/fixtures/agent-integration/host-acceptance-requirements-0.2.95.json')
export const historical095ManifestPath = path.resolve('tests/fixtures/agent-integration/release-manifest-0.2.95.ts.txt')
