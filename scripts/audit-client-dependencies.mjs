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

const EXPECTED_BRACE_VERSIONS = new Set(['1.1.21', '2.1.7', '5.0.12']);
const EXPECTED_ROUTER_VERSION = '7.18.2';
const EXPECTED_ELECTRON_VERSION = '43.8.7';
const MINIMATCH_ADVISORY = 'https://github.com/advisories/GHSA-g3hv-75wg-m249';
const MINIMATCH_VERSIONS = {
  root: new Set(['10.2.5']),
  client: new Set(['3.1.5', '5.1.9', '9.0.9', '10.2.6']),
};

function allCausesAllowed(name, vulnerabilities, visiting = new Set(), allowed = ALLOWED_ADVISORIES) {
  const vulnerability = vulnerabilities[name];
  if (visiting.has(name)) return true;
  if (!vulnerability || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) {
    return false;
  }
  const nextVisiting = new Set(visiting);
  nextVisiting.add(name);
  return vulnerability.via.every((cause) => {
    if (typeof cause === 'string') return allCausesAllowed(cause, vulnerabilities, nextVisiting, allowed);
    return typeof cause?.url === 'string' && allowed.has(cause.url);
  });
}

function reachesAllowedAdvisory(name, vulnerabilities, visiting = new Set(), allowed = ALLOWED_ADVISORIES) {
  if (visiting.has(name)) return false;
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || !Array.isArray(vulnerability.via)) return false;
  const nextVisiting = new Set(visiting);
  nextVisiting.add(name);
  return vulnerability.via.some((cause) => {
    if (typeof cause === 'string') return reachesAllowedAdvisory(cause, vulnerabilities, nextVisiting, allowed);
    return typeof cause?.url === 'string' && allowed.has(cause.url);
  });
}

export function allowedVulnerability(name, vulnerabilities, allowed = ALLOWED_ADVISORIES) {
  return allCausesAllowed(name, vulnerabilities, new Set(), allowed) && reachesAllowedAdvisory(name, vulnerabilities, new Set(), allowed);
}

// Reviewed 2026-11-07: Electron 43.8.7 includes the 43.8.5/43.8.6 Chromium
// security backports (#55495, #55517), the eMudhra mitigation
// (GHSA-jr5w-w6x2-84p9), and Node 24.22.1. npm audit does not cover the
// bundled Chromium/Node runtime.
// https://github.com/electron/electron/releases/tag/v43.8.7
export function assertReviewedElectronVersion(lock) {
  const version = lock.packages?.['node_modules/electron']?.version;
  if (version !== EXPECTED_ELECTRON_VERSION) {
    throw new Error(`Electron runtime requires renewed upstream security review; expected ${EXPECTED_ELECTRON_VERSION}, found ${version ?? 'missing'}`);
  }
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

// User-approved 0.2.94-only build-time exception; never inherited by a later release.
function assertMinimatchException(vulnerabilities, lock, scope, packageVersion) {
  const affected = Object.keys(vulnerabilities).filter((name) =>
    reachesAllowedAdvisory(name, vulnerabilities, new Set(), new Set([MINIMATCH_ADVISORY])));
  if (affected.length === 0) return;
  if (packageVersion !== '0.2.94' || lock.version !== '0.2.94' || lock.packages?.['']?.version !== '0.2.94') {
    throw new Error('minimatch build exception is limited to release 0.2.94');
  }
  const packages = lock.packages ?? {};
  const minimatches = Object.entries(packages).filter(([key]) =>
    key === 'node_modules/minimatch' || key.endsWith('/node_modules/minimatch'));
  if (minimatches.length === 0 || minimatches.some(([, value]) =>
    value.dev !== true || !MINIMATCH_VERSIONS[scope]?.has(value.version))) {
    throw new Error(`minimatch exception requires reviewed ${scope} versions and dev-only dependencies`);
  }
  for (const name of affected) {
    const finding = vulnerabilities[name];
    if (finding.severity !== 'moderate' || !Array.isArray(finding.nodes) || finding.nodes.length === 0
      || finding.nodes.some((node) => packages[node]?.dev !== true)
      || finding.via.some((cause) => typeof cause !== 'string'
        && cause?.url === MINIMATCH_ADVISORY
        && (cause.severity !== 'moderate' || cause.name !== 'minimatch' || cause.dependency !== 'minimatch'))) {
      throw new Error(`minimatch exception requires moderate dev-only findings: ${name}`);
    }
  }
}

export function validateAuditReport(report, lock, sourceRoot, scope = 'client', packageVersion = lock.packages?.['']?.version) {
  if (!['client', 'root'].includes(scope)) throw new Error('unknown audit scope');
  if (!report || report.error || !report.vulnerabilities || typeof report.vulnerabilities !== 'object'
    || Array.isArray(report.vulnerabilities)) throw new Error('invalid npm audit report');
  const vulnerabilities = report.vulnerabilities;
  const allowed = new Set(scope === 'client' ? ALLOWED_ADVISORIES : []);
  allowed.add(MINIMATCH_ADVISORY);
  const unexpected = Object.keys(vulnerabilities)
    .filter((name) => !allowedVulnerability(name, vulnerabilities, allowed));
  if (unexpected.length > 0) {
    throw new Error(`unapproved ${scope} audit findings: ${unexpected.join(', ')}`);
  }
  assertMinimatchException(vulnerabilities, lock, scope, packageVersion);
  if (Object.hasOwn(vulnerabilities, 'brace-expansion')) assertPatchedBraceVersions(lock);
  if (Object.hasOwn(vulnerabilities, 'react-router')) {
    assertExpectedRouterVersions(lock);
    assertNoClientRscUsage(sourceRoot);
  }
  return Object.keys(vulnerabilities);
}

function main() {
  const scope = process.argv.includes('--root') ? 'root' : 'client';
  const auditRoot = scope === 'root' ? repoRoot : clientRoot;
  const audit = spawnSync('npm', ['audit', '--json'], {
    cwd: auditRoot,
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
  if (audit.error || audit.signal || ![0, 1].includes(audit.status) || report.auditReportVersion !== 2
    || (audit.status === 1 && Object.keys(report.vulnerabilities ?? {}).length === 0)) {
    throw new Error('npm audit failed to produce a complete vulnerability report');
  }
  const lock = JSON.parse(readFileSync(path.join(auditRoot, 'package-lock.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(auditRoot, 'package.json'), 'utf8'));
  if (scope === 'client') assertReviewedElectronVersion(lock);
  const accepted = validateAuditReport(report, lock, path.join(clientRoot, 'src'), scope, manifest.version);
  if (accepted.length === 0) {
    console.log(`✓ ${scope} dependency audit clean`);
    return;
  }
  console.log(`✓ ${scope} dependency audit passed with reviewed exceptions (${accepted.length} transitive findings)`);
  if (accepted.some((name) => reachesAllowedAdvisory(name, report.vulnerabilities, new Set(), new Set([MINIMATCH_ADVISORY])))) {
    console.log('  - 0.2.94 only: GHSA-g3hv-75wg-m249 moderate minimatch build-time risk accepted; reviewed dev versions, trusted build inputs required');
  }
  if (accepted.includes('brace-expansion')) console.log('  - brace-expansion pinned to patched versions 1.1.21 / 2.1.7 / 5.0.12');
  if (accepted.includes('react-router')) console.log('  - React Router 7.18.2 RSC-only advisory accepted; no RSC/direct react-router usage');
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
