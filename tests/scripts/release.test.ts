import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The release script is intentionally plain Node ESM so it can run without a build step.
// @ts-expect-error no declaration file for the local .mjs script
import { assertExactSnapshot, assertRequestedVersion, commandToString, findPackagePreflightRunId, findReleaseRunId, parseArgs, previousPatch, verifyUpdateApi } from '../../scripts/release.mjs';

describe('release script helpers', () => {
  it('derives the previous patch version when possible', () => {
    expect(previousPatch('0.2.51')).toBe('0.2.50');
    expect(previousPatch('1.0.0')).toBeNull();
    expect(previousPatch('bad')).toBeNull();
  });

  it('parses release options without running the release workflow', () => {
    const opts = parseArgs([
      '--version', '0.2.52',
      '--previous-version', '0.2.51',
      '--oss-repo', '../tidemind',
      '--oss-message', 'sync 0.2.52: test',
      '--notes-file', '/tmp/notes.md',
      '--yes',
      '--dry-run',
      '--force-tag',
      '--allow-non-main',
      '--skip-health',
      '--skip-website',
      '--skip-cloud-verify',
      '--skip-update-verify',
      '--timeout-minutes', '7',
    ]);

    expect(opts).toMatchObject({
      version: '0.2.52',
      previousVersion: '0.2.51',
      ossRepo: path.resolve('../tidemind'),
      ossMessage: 'sync 0.2.52: test',
      notesFile: '/tmp/notes.md',
      yes: true,
      dryRun: true,
      forceTag: true,
      allowNonMain: true,
      skipHealth: true,
      skipWebsite: true,
      skipCloudVerify: true,
      skipUpdateVerify: true,
      timeoutMinutes: 7,
      help: false,
    });
  });

  it('handles help as parsed state instead of exiting during import or tests', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('rejects a requested release version that differs from package.json', () => {
    expect(() => assertRequestedVersion('0.2.90', '0.2.89'))
      .toThrow('--version 0.2.90 does not match package.json version 0.2.89');
    expect(() => assertRequestedVersion('0.2.89', '0.2.89')).not.toThrow();
    expect(() => assertRequestedVersion(null, '0.2.89')).not.toThrow();
  });

  it('fails closed when the release repository changes after validation', () => {
    expect(() => assertExactSnapshot('abc', 'def', '', 'ExternaBrain'))
      .toThrow('HEAD changed during release');
    expect(() => assertExactSnapshot('abc', 'abc', ' M package.json', 'ExternaBrain'))
      .toThrow('became dirty during release');
    expect(() => assertExactSnapshot('abc', 'abc', '', 'ExternaBrain')).not.toThrow();
  });

  it('rechecks the source snapshot immediately before website and OSS side effects', () => {
    const source = fs.readFileSync(path.resolve('scripts/release.mjs'), 'utf8');
    const websiteStart = source.indexOf("if (!opts.skipWebsite)");
    const websiteBuild = source.indexOf("label: 'website build'", websiteStart);
    const websiteFence = source.indexOf("assertRepoSnapshot(repoRoot, 'ExternaBrain', expectedRootHead)", websiteBuild);
    const websiteDeploy = source.indexOf("label: 'deploy website'", websiteFence);
    expect(websiteStart).toBeGreaterThan(0);
    expect(websiteBuild).toBeGreaterThan(websiteStart);
    expect(websiteFence).toBeGreaterThan(websiteBuild);
    expect(websiteDeploy).toBeGreaterThan(websiteFence);

    const syncStart = source.indexOf("label: 'sync OSS repo'");
    const syncFence = source.indexOf("assertRepoSnapshot(repoRoot, 'ExternaBrain', expectedRootHead)", syncStart);
    const ossDirty = source.indexOf('const ossDirty =', syncFence);
    expect(syncStart).toBeGreaterThan(websiteDeploy);
    expect(syncFence).toBeGreaterThan(syncStart);
    expect(ossDirty).toBeGreaterThan(syncFence);
    expect(source).toContain("'exec', '--offline', '--', 'wrangler'");
  });

  it('rejects invalid arguments', () => {
    expect(() => parseArgs(['--timeout-minutes', '0'])).toThrow('--timeout-minutes');
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument');
    expect(() => parseArgs(['--version'])).toThrow('Missing value');
  });

  it('quotes command parts for readable dry-run output', () => {
    expect(commandToString('git', ['commit', '-m', 'sync 0.2.52: test']))
      .toBe('git commit -m "sync 0.2.52: test"');
  });

  it('finds tag-triggered release runs from GitHub run list output', () => {
    const runs = [
      { databaseId: 101, headBranch: 'main', status: 'in_progress' },
      { databaseId: 202, headBranch: 'v0.2.52', status: 'queued' },
    ];

    expect(findReleaseRunId(runs, '0.2.52')).toBe('202');
    expect(findReleaseRunId(runs, 'v0.2.52')).toBe('202');
    expect(findReleaseRunId(runs, '0.2.51')).toBeNull();
  });

  it('only accepts a fresh main workflow_dispatch run as package preflight', () => {
    const startedAt = Date.parse('2026-08-12T12:00:00Z');
    const runs = [
      { databaseId: 1, headBranch: 'main', headSha: 'expected', event: 'push', createdAt: '2026-08-12T12:02:00Z' },
      { databaseId: 2, headBranch: 'main', headSha: 'expected', event: 'workflow_dispatch', createdAt: '2026-08-12T11:00:00Z' },
      { databaseId: 3, headBranch: 'main', headSha: 'other', event: 'workflow_dispatch', createdAt: '2026-08-12T12:02:00Z' },
      { databaseId: 4, headBranch: 'main', headSha: 'expected', event: 'workflow_dispatch', createdAt: '2026-08-12T12:01:00Z' },
    ];
    expect(findPackagePreflightRunId(runs, 'expected', startedAt)).toBe('4');
  });

  it('ignores stale same-tag runs created before this push (--force-tag re-release)', () => {
    const pushAt = Date.parse('2026-06-10T12:00:00Z');
    const runs = [
      // Old completed run from the previous release of the same tag — must be skipped.
      { databaseId: 900, headBranch: 'v0.2.84', status: 'completed', createdAt: '2026-06-09T08:00:00Z' },
      // The freshly-triggered run for this push — must be selected.
      { databaseId: 901, headBranch: 'v0.2.84', status: 'queued', createdAt: '2026-06-10T12:01:30Z' },
    ];

    // Without the filter (default minCreatedAtMs=0) the stale old run would win — old behaviour.
    expect(findReleaseRunId(runs, '0.2.84')).toBe('900');
    // With the push timestamp, only the run created after the push is matched.
    expect(findReleaseRunId(runs, '0.2.84', pushAt)).toBe('901');
  });

  it('returns null when only a stale same-tag run exists and a push timestamp is given', () => {
    const pushAt = Date.parse('2026-06-10T12:00:00Z');
    const runs = [
      { databaseId: 900, headBranch: 'v0.2.84', status: 'completed', createdAt: '2026-06-09T08:00:00Z' },
    ];
    // The old run is filtered out so getReleaseRunId keeps polling for the real new run
    // instead of immediately watching the stale completed one.
    expect(findReleaseRunId(runs, '0.2.84', pushAt)).toBeNull();
  });

  it('matches the existing completed run when minCreatedAtMs=0 (already-at-head crash recovery)', () => {
    // already-at-head 收尾重跑:tag 已指向 HEAD、remote ref 已存在,push 是 no-op 不触发新
    // run,只有当初首次 push 创建的已完成 run。main() 此时传 minCreatedAtMs=0,必须仍能命中
    // 该旧 run 继续 sign/publish,否则 getReleaseRunId 永远超时。
    const runs = [
      { databaseId: 900, headBranch: 'v0.2.84', status: 'completed', createdAt: '2026-06-09T08:00:00Z' },
    ];
    expect(findReleaseRunId(runs, '0.2.84', 0)).toBe('900');
    expect(findReleaseRunId(runs, '0.2.84')).toBe('900');
  });

  describe('verifyUpdateApi', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubUpdateApi(responses: Record<string, unknown>) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const parsed = new URL(url);
        const arch = parsed.searchParams.get('arch') ?? '';
        const version = parsed.searchParams.get('version') ?? '';
        // key: arch + ':' + (offered-update | current)
        const key = `${arch}:${version}`;
        const body = responses[key];
        if (body === undefined) throw new Error(`unexpected fetch ${url}`);
        return { ok: true, status: 200, json: async () => body } as Response;
      }));
    }

    const okBody = (arch: string) => ({
      version: '0.2.84',
      url: 'https://github.com/SawyerHan-AI/TideMind/releases/download/v0.2.84/Tide.Mind-0.2.84-' + arch + '.dmg',
      signatureUrl: `https://github.com/SawyerHan-AI/TideMind/releases/download/v0.2.84/update-manifest-darwin-${arch}.sig`,
    });
    const noUpdate = { version: '0.2.84', url: null, signatureUrl: null };

    it('passes when both arches offer the update with a valid signatureUrl', async () => {
      stubUpdateApi({
        'arm64:0.2.83': okBody('arm64'),
        'arm64:0.2.84': noUpdate,
        'x64:0.2.83': okBody('x64'),
        'x64:0.2.84': noUpdate,
      });
      await expect(verifyUpdateApi('0.2.84', '0.2.83')).resolves.toBeUndefined();
      // arm64 prev + arm64 current + x64 prev + x64 current = 4 requests (x64 not skipped)
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
    });

    it('throws when signatureUrl is missing on arm64 (sign-before-publish / cache window)', async () => {
      stubUpdateApi({
        'arm64:0.2.83': { ...okBody('arm64'), signatureUrl: null },
        'arm64:0.2.84': noUpdate,
        'x64:0.2.83': okBody('x64'),
        'x64:0.2.84': noUpdate,
      });
      await expect(verifyUpdateApi('0.2.84', '0.2.83')).rejects.toThrow(/no signatureUrl/);
    });

    it('throws when x64 signatureUrl is missing (arm64-only verify would miss it)', async () => {
      stubUpdateApi({
        'arm64:0.2.83': okBody('arm64'),
        'arm64:0.2.84': noUpdate,
        'x64:0.2.83': { ...okBody('x64'), signatureUrl: null },
        'x64:0.2.84': noUpdate,
      });
      await expect(verifyUpdateApi('0.2.84', '0.2.83')).rejects.toThrow(/no signatureUrl/);
    });

    it('throws when signatureUrl points at the wrong asset name', async () => {
      stubUpdateApi({
        'arm64:0.2.83': {
          ...okBody('arm64'),
          signatureUrl: 'https://github.com/SawyerHan-AI/TideMind/releases/download/v0.2.84/wrong-name.sig',
        },
        'arm64:0.2.84': noUpdate,
      });
      await expect(verifyUpdateApi('0.2.84', '0.2.83')).rejects.toThrow(/does not point at update-manifest-darwin-arm64\.sig/);
    });

    it('skips the signatureUrl assertion when allowUnsigned is set', async () => {
      stubUpdateApi({
        'arm64:0.2.83': { ...okBody('arm64'), signatureUrl: null },
        'arm64:0.2.84': noUpdate,
        'x64:0.2.83': { ...okBody('x64'), signatureUrl: null },
        'x64:0.2.84': noUpdate,
      });
      await expect(verifyUpdateApi('0.2.84', '0.2.83', true)).resolves.toBeUndefined();
    });
  });
});
