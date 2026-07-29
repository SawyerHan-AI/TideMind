#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const clientRoot = path.join(repoRoot, 'client');

export const ALLOWED_ADVISORIES = new Set([
  // npm currently models every brace-expansion major as <=5.0.7. The lockfile
  // guard below requires the patched release in each installed major line.
  'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
  // Only affects unstable React Server Components APIs. TideMind is an
  // Electron HashRouter SPA and the source guard below rejects RSC usage.
  'https://github.com/advisories/GHSA-qwww-vcr4-c8h2',
]);

const EXPECTED_BRACE_VERSIONS = new Set(['1.1.17', '2.1.3', '5.0.8']);
const EXPECTED_ROUTER_VERSION = '7.18.2';

function allCausesAllowed(name, vulnerabilities, visiting = new Set()) {
  const vulnerability = vulnerabilities[name];
  if (visiting.has(name)) return true;
  if (!vulnerability || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) {
    return false;
  }
  const nextVisiting = new Set(visiting);
  nextVisiting.add(name);
  return vulnerability.via.every((cause) => {
    if (typeof cause === 'string') return allCausesAllowed(cause, vulnerabilities, nextVisiting);
    return typeof cause?.url === 'string' && ALLOWED_ADVISORIES.has(cause.url);
  });
}

function reachesAllowedAdvisory(name, vulnerabilities, visiting = new Set()) {
  if (visiting.has(name)) return false;
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || !Array.isArray(vulnerability.via)) return false;
  const nextVisiting = new Set(visiting);
  nextVisiting.add(name);
  return vulnerability.via.some((cause) => {
    if (typeof cause === 'string') return reachesAllowedAdvisory(cause, vulnerabilities, nextVisiting);
    return typeof cause?.url === 'string' && ALLOWED_ADVISORIES.has(cause.url);
  });
}

export function allowedVulnerability(name, vulnerabilities) {
  return allCausesAllowed(name, vulnerabilities) && reachesAllowedAdvisory(name, vulnerabilities);
}

export function assertPatchedBraceVersions(lock) {
  const versions = Object.entries(lock.packages ?? {})
    .filter(([key]) => key === 'node_modules/brace-expansion' || key.endsWith('/node_modules/brace-expansion'))
    .map(([, value]) => value?.version)
    .filter(Boolean);
  if (versions.length === 0) throw new Error('brace-expansion not found in client package-lock');
  const unexpected = [...new Set(versions)].filter((version) => !EXPECTED_BRACE_VERSIONS.has(version));
  if (unexpected.length > 0) {
    throw new Error(`unexpected brace-expansion version(s): ${unexpected.join(', ')}`);
  }
}

export function assertExpectedRouterVersions(lock) {
  const packages = lock.packages ?? {};
  const router = packages['node_modules/react-router']?.version;
  const dom = packages['node_modules/react-router-dom']?.version;
  if (router !== EXPECTED_ROUTER_VERSION || dom !== EXPECTED_ROUTER_VERSION) {
    throw new Error(
      `React Router exception is pinned to ${EXPECTED_ROUTER_VERSION}; found router=${router ?? 'missing'}, dom=${dom ?? 'missing'}`,
    );
  }
}

export function containsRscUsage(source) {
  return (
    /\b(?:RSC|RSCRouter|createCallServer|matchRSCServerRequest|routeRSCServerRequest)\b/.test(source)
    || /\bfrom\s*['"]react-router['"]/.test(source)
    || /\bimport\s*\(\s*['"]react-router['"]\s*\)/.test(source)
    || /\brequire\s*\(\s*['"]react-router['"]\s*\)/.test(source)
  );
}

function walkSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry);
    const stat = statSync(target);
    if (stat.isDirectory()) files.push(...walkSourceFiles(target));
    else if (/\.[cm]?[jt]sx?$/.test(entry)) files.push(target);
  }
  return files;
}

export function assertNoClientRscUsage(sourceRoot = path.join(clientRoot, 'src')) {
  const matches = walkSourceFiles(sourceRoot)
    .filter((file) => containsRscUsage(readFileSync(file, 'utf8')))
    .map((file) => path.relative(clientRoot, file));
  if (matches.length > 0) {
    throw new Error(`React Router RSC exception is invalid because RSC/direct react-router usage was found: ${matches.join(', ')}`);
  }
}

export function validateAuditReport(report, lock, sourceRoot) {
  const vulnerabilities = report.vulnerabilities ?? {};
  const unexpected = Object.keys(vulnerabilities)
    .filter((name) => !allowedVulnerability(name, vulnerabilities));
  if (unexpected.length > 0) {
    throw new Error(`unapproved client audit findings: ${unexpected.join(', ')}`);
  }
  if (Object.hasOwn(vulnerabilities, 'brace-expansion')) assertPatchedBraceVersions(lock);
  if (Object.hasOwn(vulnerabilities, 'react-router')) {
    assertExpectedRouterVersions(lock);
    assertNoClientRscUsage(sourceRoot);
  }
  return Object.keys(vulnerabilities);
}

function main() {
  const audit = spawnSync('npm', ['audit', '--json'], {
    cwd: clientRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const raw = audit.stdout || audit.stderr;
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error(`npm audit did not return JSON:\n${raw}`);
  }
  const lock = JSON.parse(readFileSync(path.join(clientRoot, 'package-lock.json'), 'utf8'));
  const accepted = validateAuditReport(report, lock, path.join(clientRoot, 'src'));
  if (accepted.length === 0) {
    console.log('✓ client dependency audit clean');
    return;
  }
  console.log('✓ client dependency audit has only reviewed, fail-closed exceptions');
  console.log(`  - ${accepted.length} transitive findings resolve exclusively to two accepted advisories`);
  console.log('  - brace-expansion instances are pinned to patched versions 1.1.17 / 2.1.3 / 5.0.8');
  console.log('  - React Router 7.18.2 RSC-only advisory accepted; client source contains no RSC/direct react-router usage');
}

const isCli = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isCli) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
