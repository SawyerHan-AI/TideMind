import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The release script is intentionally plain Node ESM so it can run without a build step.
// @ts-expect-error no declaration file for the local .mjs script
import { commandToString, findReleaseRunId, parseArgs, previousPatch } from '../../scripts/release.mjs';

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
});
