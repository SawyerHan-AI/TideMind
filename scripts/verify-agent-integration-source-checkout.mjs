#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { verifyAgentIntegrationExactSource } from './agent-integration-gate-provenance.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expectedCommit = process.env.TIDEMIND_CI_SOURCE_HEAD
const result = verifyAgentIntegrationExactSource({ repoRoot, expectedCommit })
process.stdout.write(`${JSON.stringify({ status: 'passed', ...result })}\n`)
