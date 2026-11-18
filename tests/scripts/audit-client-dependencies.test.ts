import { describe, expect, it } from 'vitest';
import {
  allowedVulnerability,
  assertReviewedElectronVersion,
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
    'node_modules/brace-expansion': { version: '5.0.12' },
    'node_modules/a/node_modules/brace-expansion': { version: '1.1.21' },
    'node_modules/b/node_modules/brace-expansion': { version: '2.1.7' },
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

  it('accepts the patched brace-expansion release in each installed major line', () => {
    expect(() => assertPatchedBraceVersions(safeLock)).not.toThrow();
  });

  it.each(['1.1.17', '2.1.3', '5.0.8'])('rejects the previously reviewed brace-expansion version %s', (version) => {
    const unsafe = structuredClone(safeLock);
    unsafe.packages['node_modules/a/node_modules/brace-expansion'].version = version;
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

it('rejects the vulnerable Electron runtime even when the registry audit feed is empty', () => {
  expect(() => assertReviewedElectronVersion({ packages: { 'node_modules/electron': { version: '41.10.5' } } })).toThrow(/security review/);
  expect(() => assertReviewedElectronVersion({ packages: { 'node_modules/electron': { version: '41.10.7' } } })).toThrow(/security review/);
  expect(() => assertReviewedElectronVersion({ packages: { 'node_modules/electron': { version: '43.8.3' } } })).toThrow(/security review/);
  expect(() => assertReviewedElectronVersion({ packages: { 'node_modules/electron': { version: '43.8.4' } } })).toThrow(/security review/);
  expect(() => assertReviewedElectronVersion({ packages: { 'node_modules/electron': { version: '43.8.7' } } })).not.toThrow();
  expect(() => assertReviewedElectronVersion({ packages: {} })).toThrow(/missing/);
});

const minimatchUrl = 'https://github.com/advisories/GHSA-g3hv-75wg-m249';
function minimatchFixture(scope = 'root') {
  return {
    report: {
      vulnerabilities: {
        minimatch: {
          severity: 'moderate', nodes: ['node_modules/minimatch'],
          via: [{ url: minimatchUrl, severity: 'moderate', name: 'minimatch', dependency: 'minimatch' }],
        },
        tool: { severity: 'moderate', nodes: ['node_modules/tool'], via: ['minimatch', 'peer'] },
        peer: { severity: 'moderate', nodes: ['node_modules/peer'], via: ['tool'] },
      },
    },
    lock: {
      version: '0.2.94',
      packages: {
        '': { version: '0.2.94' },
        'node_modules/minimatch': { version: scope === 'root' ? '10.2.5' : '10.2.6', dev: true },
        'node_modules/tool': { version: '1.0.0', dev: true },
        'node_modules/peer': { version: '1.0.0', dev: true },
      },
    },
  };
}

describe('0.2.94 minimatch build dependency exception', () => {
  it.each(['root', 'client'])('accepts reviewed %s versions including transitive cycles', (scope) => {
    const { report, lock } = minimatchFixture(scope);
    expect(validateAuditReport(report, lock, undefined, scope)).toHaveLength(3);
  });

  it('accepts all reviewed client major lines', () => {
    const { report, lock } = minimatchFixture('client');
    for (const version of ['3.1.5', '5.1.9', '9.0.9', '10.2.6']) {
      lock.packages['node_modules/minimatch'].version = version;
      expect(() => validateAuditReport(report, lock)).not.toThrow();
    }
  });

  it.each(['0.2.93', '0.2.95'])('does not carry the exception into %s', (version) => {
    const { report, lock } = minimatchFixture();
    expect(() => validateAuditReport(report, lock, undefined, 'root', version)).toThrow(/0.2.94/);
    lock.version = version;
    expect(() => validateAuditReport(report, lock, undefined, 'root')).toThrow(/0.2.94/);
  });

  it.each(['10.2.6', '11.0.1'])('rejects unreviewed root version %s', (version) => {
    const { report, lock } = minimatchFixture();
    lock.packages['node_modules/minimatch'].version = version;
    expect(() => validateAuditReport(report, lock, undefined, 'root')).toThrow(/reviewed/);
  });

  it.each(['minimatch', 'tool'])('rejects a production dependency in the affected chain: %s', (name) => {
    const { report, lock } = minimatchFixture();
    lock.packages[`node_modules/${name}`].dev = false;
    expect(() => validateAuditReport(report, lock, undefined, 'root')).toThrow(/dev-only/);
  });

  it('rejects unknown or production minimatch copies even if the report omits them', () => {
    const { report, lock } = minimatchFixture();
    lock.packages['node_modules/other/node_modules/minimatch'] = { version: '10.2.5', dev: false };
    expect(() => validateAuditReport(report, lock, undefined, 'root')).toThrow(/dev-only/);
  });

  it('rejects both direct and transitive severity escalation', () => {
    const { report, lock } = minimatchFixture();
    report.vulnerabilities.minimatch.via[0].severity = 'high';
    expect(() => validateAuditReport(report, lock, undefined, 'root')).toThrow(/moderate/);
    report.vulnerabilities.minimatch.via[0].severity = 'moderate';
    report.vulnerabilities.tool.severity = 'high';
    expect(() => validateAuditReport(report, lock, undefined, 'root')).toThrow(/moderate/);
  });

  it('rejects another advisory mixed into an otherwise approved chain', () => {
    const { report, lock } = minimatchFixture();
    report.vulnerabilities.minimatch.via.push({ url: 'https://github.com/advisories/GHSA-other', severity: 'moderate', name: 'minimatch', dependency: 'minimatch' });
    expect(() => validateAuditReport(report, lock, undefined, 'root')).toThrow(/unapproved/);
  });

  it('rejects absent lock nodes, unknown causes and root use of client-only exceptions', () => {
    const { report, lock } = minimatchFixture();
    report.vulnerabilities.tool.nodes = ['node_modules/missing'];
    expect(() => validateAuditReport(report, lock, undefined, 'root')).toThrow(/dev-only/);
    report.vulnerabilities.tool.via.push('unknown');
    expect(() => validateAuditReport(report, lock, undefined, 'root')).toThrow(/unapproved/);
    expect(() => validateAuditReport(allowedReport, safeLock, undefined, 'root')).toThrow(/unapproved/);
  });

  it.each([{}, { error: { code: 'ENOAUDIT' } }, { vulnerabilities: [] }, { error: {}, vulnerabilities: {} }])('rejects incomplete/error audit reports', (report) => {
    expect(() => validateAuditReport(report, {})).toThrow(/invalid/);
  });

  it('rejects cycles that never reach an advisory', () => {
    expect(() => validateAuditReport({ vulnerabilities: { a: { via: ['b'] }, b: { via: ['a'] } } }, {})).toThrow(/unapproved/);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function picomatchFixture(scope: 'root' | 'client' | 'cloud' | 'website' = 'root') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-audit-boundary-'));
  const source = path.join(directory, 'src');
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(directory, 'electron'));
  fs.writeFileSync(path.join(source, 'app.ts'), 'export const app = true;');
  if (scope === 'website') {
    fs.copyFileSync(path.resolve('pro/website/astro.config.mjs'), path.join(directory, 'astro.config.mjs'));
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({scripts:{build:'astro build'}}));
  }
  const version = scope === 'website' ? '0.0.1' : '0.2.101';
  const lock = {version,packages:{
    '':{version},
    'node_modules/picomatch':{version:scope === 'cloud' || scope === 'client' ? '2.3.2' : '4.0.7',dev:scope !== 'website'},
    'node_modules/tool':{version:'1.0.0',dev:scope !== 'website'},
  }};
  const report = {vulnerabilities:{
    picomatch:{severity:'high',nodes:['node_modules/picomatch'],via:[{
      name:'picomatch',dependency:'picomatch',severity:'high',url:'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
    }]},
    tool:{severity:'high',nodes:['node_modules/tool'],via:['picomatch']},
  }};
  const validate = () => validateAuditReport(report,lock,source,scope,version,'0.2.101');
  return {directory,source,lock,report,validate};
}

describe('0.2.101 picomatch controlled-build exception', () => {
  it.each(['root','client','cloud','website'] as const)('accepts the reviewed %s boundary only', scope => {
    const f = picomatchFixture(scope);
    try { expect(f.validate()).toEqual(['picomatch','tool']); }
    finally { fs.rmSync(f.directory,{recursive:true}); }
  });
  it('does not allow a different advisory or newly reviewed version implicitly', () => {
    const f = picomatchFixture();
    try {
      f.report.vulnerabilities.picomatch.via[0].url = 'https://github.com/advisories/GHSA-other';
      expect(f.validate).toThrow(/unapproved/);
      f.report.vulnerabilities.picomatch.via[0].url = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
      f.lock.packages['node_modules/picomatch'].version = '4.0.8';
      expect(f.validate).toThrow(/reviewed/);
    } finally { fs.rmSync(f.directory,{recursive:true}); }
  });
  it.each(['picomatch','tool'])('rejects a runtime dependency in the affected chain: %s', name => {
    const f = picomatchFixture();
    try {
      f.lock.packages[`node_modules/${name}`].dev = false;
      expect(f.validate).toThrow(/dev-only|build-only/);
    } finally { fs.rmSync(f.directory,{recursive:true}); }
  });
  it('rejects additional installed copies and unavailable audit nodes', () => {
    const f = picomatchFixture();
    try {
      f.lock.packages['node_modules/nested/node_modules/picomatch'] = {version:'3.0.1',dev:true};
      expect(f.validate).toThrow(/reviewed/);
      delete f.lock.packages['node_modules/nested/node_modules/picomatch'];
      f.report.vulnerabilities.tool.nodes = ['node_modules/missing'];
      expect(f.validate).toThrow(/build-only/);
    } finally { fs.rmSync(f.directory,{recursive:true}); }
  });
  it.each(['0.2.100','0.2.102'])('does not inherit the exception for release %s', version => {
    const f = picomatchFixture();
    try { expect(()=>validateAuditReport(f.report,f.lock,f.source,'root','0.2.101',version)).toThrow(/0.2.101/); }
    finally { fs.rmSync(f.directory,{recursive:true}); }
  });
  it('requires source verification and rejects direct runtime matcher usage', () => {
    const f = picomatchFixture('client');
    try {
      expect(()=>validateAuditReport(f.report,f.lock,undefined,'client','0.2.101','0.2.101')).toThrow(/source boundary/);
      fs.writeFileSync(path.join(f.directory,'electron','main.ts'),"import match from 'picomatch';");
      expect(f.validate).toThrow(/runtime matcher/);
    } finally { fs.rmSync(f.directory,{recursive:true}); }
  });
  it('rejects SSR or different website build configuration', () => {
    const f = picomatchFixture('website');
    try {
      fs.appendFileSync(path.join(f.directory,'astro.config.mjs'),"\n// changed deployment boundary\n");
      expect(f.validate).toThrow(/static Astro/);
    } finally { fs.rmSync(f.directory,{recursive:true}); }
  });
  it('rejects severity or advisory identity changes', () => {
    const f = picomatchFixture();
    try {
      f.report.vulnerabilities.picomatch.via[0].name = 'another-package';
      expect(f.validate).toThrow(/build-only/);
      f.report.vulnerabilities.picomatch.via[0].name = 'picomatch';
      f.report.vulnerabilities.tool.severity = 'critical';
      expect(f.validate).toThrow(/build-only/);
    } finally { fs.rmSync(f.directory,{recursive:true}); }
  });
});
