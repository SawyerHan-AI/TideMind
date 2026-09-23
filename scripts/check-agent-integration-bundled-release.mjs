#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSourceAgentIntegrationReleaseContract } from './agent-integration-release-contract.mjs'
import { inspectPackagedAgentIntegrationReleaseManifest } from './verify-mac-release-assets.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = parseSourceAgentIntegrationReleaseContract(fs.readFileSync(
  path.join(root, 'client/electron/agent-integration/release-manifest.ts'), 'utf8',
))
const built = fs.readFileSync(path.join(root, 'client/out/main/index.js'), 'utf8')
const verified = inspectPackagedAgentIntegrationReleaseManifest(built, source)
console.log(`built Agent release manifest matches source: ${verified.entryCount} entries`)
