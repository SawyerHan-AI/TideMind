import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parse as parseToml } from 'smol-toml';
import { inspectAgentHostActivityEvidenceV34Schema } from './db/agent-integration-schema.js';

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const eventId = arg('--event-id');
const captureNonce = arg('--capture-nonce');
const targetKey = arg('--target-key');
const candidateBundleSha256 = arg('--candidate-bundle-sha256');
const sourceCommit = arg('--source-commit');
const releaseContractSha256 = arg('--release-contract-sha256');
const fixtureDatabaseIndex = process.argv.indexOf('--fixture-database');
const fixtureDatabasePath = fixtureDatabaseIndex >= 0 ? process.argv[fixtureDatabaseIndex + 1] : null;

if (!/^aha_[a-f0-9]{24}$/u.test(eventId)) throw new Error('invalid activity event ID');
if (!/^[a-f0-9]{64}$/u.test(captureNonce)) throw new Error('invalid capture nonce');
if (!targetKey.trim()) throw new Error('invalid target key');

function resolveRealProfileDatabase(): string {
  const defaultDataDir = path.join(os.homedir(), '.tidemind');
  const configPath = path.join(defaultDataDir, 'config.toml');
  let dataDir = defaultDataDir;
  if (fs.existsSync(configPath)) {
    const parsed = parseToml(fs.readFileSync(configPath, 'utf8')) as { general?: { data_dir?: string } };
    const configured = parsed.general?.data_dir;
    if (configured) dataDir = configured.replace(/^~(?=$|\/)/u, os.homedir());
  }
  return path.join(dataDir, 'graph', 'brain.sqlite');
}

const ledgerSource = fixtureDatabasePath ? 'fixture' : 'real_profile';
const databasePath = fixtureDatabasePath ?? resolveRealProfileDatabase();
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  const integrity = db.pragma('quick_check', { simple: true });
  if (integrity !== 'ok') throw new Error('activity ledger database quick_check failed');
  const schema = inspectAgentHostActivityEvidenceV34Schema(db);
  const row = db.prepare(`
    SELECT id,
           installation_id AS installationId,
           activation_run_id AS activationRunId,
           agent_id AS agentId,
           host_variant AS hostVariant,
           component_key AS componentKey,
           signal_name AS signalName,
           tide_mind_version AS tideMindVersion,
           adapter_version AS adapterVersion,
           projection_version AS projectionVersion,
           host_version AS hostVersion,
           evidence_hash AS evidenceHash,
           observed_at AS observedAt
    FROM agent_host_activity_evidence WHERE id = ?
  `).get(eventId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`activity ledger event not found: ${eventId}`);
  const exportBinding = {
    exporterVersion: 1,
    ledgerSource,
    captureNonce,
    targetKey,
    candidateBundleSha256,
    sourceCommit,
    releaseContractSha256,
    databaseSchemaVersion: schema.schemaVersion,
    databaseSchemaSha256: crypto.createHash('sha256').update(JSON.stringify(schema.fingerprintInput)).digest('hex'),
    ...row,
  };
  const exportHash = sha256(exportBinding);
  process.stdout.write(`${JSON.stringify({ ...exportBinding, exportHash })}\n`);
} finally {
  db.close();
}
