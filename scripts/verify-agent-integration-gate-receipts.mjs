#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  captureAgentIntegrationGateProvenance,
  validateAgentIntegrationGateProvenance,
} from './agent-integration-gate-provenance.mjs'
import { evaluateAgentIntegrationPerformanceResult } from './evaluate-agent-integration-performance-result.mjs'
import {
  validateAgentIntegrationUiE2eReceipt,
  verifyAgentIntegrationUiE2eEvidence,
} from './agent-integration-ui-e2e-evidence.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 6 || args[0] !== '--performance' || args[2] !== '--ui-e2e' || args[4] !== '--ui-evidence') {
  throw new Error('Usage: verify-agent-integration-gate-receipts.mjs --performance receipt.json --ui-e2e receipt.json --ui-evidence evidence-dir')
}
const [performancePath, uiE2ePath, uiEvidencePath] = [args[1], args[3], args[5]].map(value => path.resolve(value))
const performance = JSON.parse(fs.readFileSync(performancePath, 'utf8'))
const uiE2e = JSON.parse(fs.readFileSync(uiE2ePath, 'utf8'))
const thresholdsPath = path.join(repoRoot, 'scripts', 'agent-integration-performance-thresholds.json')
const harnessPath = path.join(repoRoot, 'scripts', 'agent-integration-performance-harness.ts')
const thresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'))
const expectedCommit = process.env.TIDEMIND_CI_SOURCE_HEAD ?? null
const current = captureAgentIntegrationGateProvenance({ repoRoot, expectedCommit })
const failures = [
  ...validateAgentIntegrationGateProvenance(performance.provenance, current)
    .map(failure => `performance ${failure}`),
  ...validateAgentIntegrationGateProvenance(uiE2e.provenance, current)
    .map(failure => `UI E2E ${failure}`),
]
failures.push(...evaluateAgentIntegrationPerformanceResult({ result: performance, thresholds })
  .map(failure => `performance ${failure}`))
if (performance?.thresholdEvaluation?.status !== 'passed'
  || !Array.isArray(performance?.thresholdEvaluation?.failures)
  || performance.thresholdEvaluation.failures.length !== 0) {
  failures.push('performance threshold status')
}
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
if (performance?.provenance?.thresholdSha256 !== sha256(thresholdsPath)) {
  failures.push('performance threshold digest')
}
if (performance?.provenance?.harnessSha256 !== sha256(harnessPath)) {
  failures.push('performance harness digest')
}
failures.push(...validateAgentIntegrationUiE2eReceipt(uiE2e).map(failure => `UI E2E ${failure}`))
try {
  verifyAgentIntegrationUiE2eEvidence({
    evidenceDir: uiEvidencePath,
    expectedManifestSha256: uiE2e?.evidenceManifestSha256,
  })
} catch (error) {
  failures.push(`UI E2E evidence ${error instanceof Error ? error.message : String(error)}`)
}
if (failures.length > 0) throw new Error(`Agent Integration gate receipt verification failed: ${failures.join(', ')}`)
process.stdout.write(`${JSON.stringify({
  status: 'passed',
  sourceCommit: current.sourceCommit,
  sourceManifestSha256: current.sourceManifestSha256,
  buildManifestSha256: current.buildManifestSha256,
  evidenceManifestSha256: uiE2e.evidenceManifestSha256,
})}\n`)
