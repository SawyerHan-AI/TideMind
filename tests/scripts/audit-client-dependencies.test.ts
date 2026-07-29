import { describe, expect, it } from 'vitest';
import {
  allowedVulnerability,
  assertExpectedRouterVersions,
  assertPatchedBraceVersions,
  containsRscUsage,
  validateAuditReport,
} from '../../scripts/audit-client-dependencies.mjs';

const allowedReport = {
  vulnerabilities: {
    'brace-expansion': {
      via: [{ url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg' }],
    },
    minimatch: { via: ['brace-expansion'] },
    'react-router': {
      via: [{ url: 'https://github.com/advisories/GHSA-qwww-vcr4-c8h2' }],
    },
    'react-router-dom': { via: ['react-router'] },
  },
};

const safeLock = {
  packages: {
    'node_modules/brace-expansion': { version: '5.0.8' },
    'node_modules/a/node_modules/brace-expansion': { version: '1.1.17' },
    'node_modules/b/node_modules/brace-expansion': { version: '2.1.3' },
    'node_modules/react-router': { version: '7.18.2' },
    'node_modules/react-router-dom': { version: '7.18.2' },
  },
};

describe('client dependency audit exceptions', () => {
  it('accepts only dependency chains rooted in reviewed advisories', () => {
    expect(allowedVulnerability('minimatch', allowedReport.vulnerabilities)).toBe(true);
    expect(allowedVulnerability('react-router-dom', allowedReport.vulnerabilities)).toBe(true);
  });

  it('rejects an additional advisory even on an otherwise accepted package', () => {
    const vulnerabilities = structuredClone(allowedReport.vulnerabilities);
    vulnerabilities['react-router'].via.push({ url: 'https://github.com/advisories/GHSA-unknown' });
    expect(allowedVulnerability('react-router', vulnerabilities)).toBe(false);
  });

  it('requires the patched brace-expansion release in every major line', () => {
    expect(() => assertPatchedBraceVersions(safeLock)).not.toThrow();
    const unsafe = structuredClone(safeLock);
    unsafe.packages['node_modules/a/node_modules/brace-expansion'].version = '1.1.16';
    expect(() => assertPatchedBraceVersions(unsafe)).toThrow(/unexpected brace-expansion/);
  });

  it('pins the React Router exception to the reviewed version pair', () => {
    expect(() => assertExpectedRouterVersions(safeLock)).not.toThrow();
    const changed = structuredClone(safeLock);
    changed.packages['node_modules/react-router'].version = '7.19.0';
    expect(() => assertExpectedRouterVersions(changed)).toThrow(/pinned/);
  });

  it('detects direct React Router and RSC usage', () => {
    expect(containsRscUsage("import { HashRouter } from 'react-router-dom'")).toBe(false);
    expect(containsRscUsage("import { unstable_RSCStaticRouter } from 'react-router'")).toBe(true);
    expect(containsRscUsage('const result = matchRSCServerRequest(request)')).toBe(true);
  });

  it('rejects any audit finding outside the reviewed closure', () => {
    const report = structuredClone(allowedReport);
    report.vulnerabilities['new-package'] = {
      via: [{ url: 'https://github.com/advisories/GHSA-new-finding' }],
    };
    expect(() => validateAuditReport(report, safeLock, 'client/src')).toThrow(/new-package/);
  });
});
