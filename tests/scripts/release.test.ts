import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readReleaseWorkflow } from '../helpers/release-workflow';

// The release script is intentionally plain Node ESM so it can run without a build step.
// @ts-expect-error no declaration file for the local .mjs script
import {
  assertCompleteReleaseAssetList,
  classifyReleaseTagPreflight,
  assertExactSnapshot,
  assertReleaseBypassesAllowed,
  assertRequestedVersion,
  assertSigningKeyMatchesEmbeddedPublicKey,
  commandToString,
  ensureNotesFile,
  expectedReleaseAssetNames,
  extractEmbeddedUpdatePublicKeys,
  findPackagePreflightRunId,
  findPrivateCiRunId,
  findReleaseRunId,
  parseArgs,
  previousPatch,
  resolveUpdatePreviousVersions,
  releaseMacArchitectures,
  validateReleaseNotesContent,
  verifyUpdateApi,
} from '../../scripts/release.mjs';

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
      '--agent-host-evidence', '/tmp/agent-host-acceptance/index.json',
      '--agent-host-candidate-app-arm64', '/tmp/Tide Mind arm64 RC.app',
      '--agent-host-candidate-app-x64', '/tmp/Tide Mind x64 RC.app',
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
      agentHostEvidence: '/tmp/agent-host-acceptance/index.json',
      agentHostCandidateAppArm64: '/tmp/Tide Mind arm64 RC.app',
      agentHostCandidateAppX64: '/tmp/Tide Mind x64 RC.app',
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

  it.each([
    ['forceTag', '--force-tag'],
    ['skipHealth', '--skip-health'],
    ['skipWebsite', '--skip-website'],
    ['skipCloudVerify', '--skip-cloud-verify'],
    ['skipUpdateVerify', '--skip-update-verify'],
  ] as const)('rejects the 0.2.92 release bypass %s', (option, flag) => {
    expect(() => assertReleaseBypassesAllowed('0.2.92', { [option]: true }))
      .toThrow(`0.2.92 cannot be released with ${flag}`);
    expect(() => assertReleaseBypassesAllowed('0.2.91', { [option]: true }))
      .not.toThrow();
  });

  it('allows --allow-non-main only for a non-mutating dry-run', () => {
    expect(() => assertReleaseBypassesAllowed('0.2.92', {
      allowNonMain: true,
      dryRun: false,
    })).toThrow('--allow-non-main requires --dry-run');
    expect(() => assertReleaseBypassesAllowed('0.2.92', {
      allowNonMain: true,
      dryRun: true,
    })).not.toThrow();
    expect(() => assertReleaseBypassesAllowed('0.2.91', {
      allowNonMain: true,
      dryRun: false,
    })).toThrow('--allow-non-main requires --dry-run');
  });

  it('requires both supported upgrade origins for 0.2.92', () => {
    expect(resolveUpdatePreviousVersions('0.2.92')).toEqual(['0.2.89', '0.2.91']);
    expect(resolveUpdatePreviousVersions('0.2.92', '0.2.91'))
      .toEqual(['0.2.89', '0.2.91']);
    expect(() => resolveUpdatePreviousVersions('0.2.92', '0.2.90'))
      .toThrow(/both are always verified/);
    expect(resolveUpdatePreviousVersions('0.2.84', null)).toEqual(['0.2.83']);
    expect(resolveUpdatePreviousVersions('0.2.84', '0.2.80')).toEqual(['0.2.80']);
  });

  it('rejects a stale local or remote release tag before external release writes', () => {
    const base = {
      localTagHead: '',
      remoteTagHead: '',
      ossHead: 'oss-head',
      sourceCommitTrailer: 'source-head',
      expectedSourceCommit: 'source-head',
      forceTag: false,
    };
    expect(classifyReleaseTagPreflight(base)).toBe('create');
    expect(classifyReleaseTagPreflight({ ...base, localTagHead: 'oss-head' }))
      .toBe('already-at-head');
    expect(classifyReleaseTagPreflight({ ...base, remoteTagHead: 'oss-head' }))
      .toBe('already-at-head');
    expect(() => classifyReleaseTagPreflight({ ...base, localTagHead: 'stale' }))
      .toThrow('release tag already exists at a different OSS commit');
    expect(() => classifyReleaseTagPreflight({ ...base, remoteTagHead: 'stale' }))
      .toThrow('release tag already exists at a different OSS commit');
    expect(() => classifyReleaseTagPreflight({
      ...base,
      remoteTagHead: 'oss-head',
      sourceCommitTrailer: 'other-source',
    })).toThrow('existing release tag is not bound to the exact TideMind source commit');
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
    const websiteStart = source.indexOf("if (!opts.skipWebsite && !opts.prepareCandidate)");
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
    const ossSourceBinding = source.indexOf(
      'assertOssSourceBinding(expectedRootHead, opts.ossRepo)',
      ossDirty,
    );
    const ossPush = source.indexOf(
      "run('git', ['push', 'origin', 'main'], { cwd: opts.ossRepo",
      ossDirty,
    );
    expect(syncStart).toBeGreaterThan(websiteDeploy);
    expect(syncFence).toBeGreaterThan(syncStart);
    expect(ossDirty).toBeGreaterThan(syncFence);
    expect(ossSourceBinding).toBeGreaterThan(ossDirty);
    expect(ossPush).toBeGreaterThan(ossSourceBinding);
    expect(source).toContain("'exec', '--offline', '--', 'wrangler'");
  });

  it('runs the Agent Integration release gate before every push even when health is skipped', () => {
    const source = fs.readFileSync(path.resolve('scripts/release.mjs'), 'utf8');
    const hostGate = source.indexOf("label: 'verify real-host Agent Integration acceptance'");
    const manifestGate = source.indexOf("label: 'verify Agent Integration release manifest'");
    const optionalHealth = source.indexOf("if (!opts.skipHealth)", manifestGate);
    const firstPush = source.indexOf("run('git', ['push'", manifestGate);
    const tagPreflight = source.indexOf('assertReleaseTagPreflight(', manifestGate);
    const signingPreflight = source.indexOf('signingKeys = loadSigningKeys(opts.allowUnsigned)', optionalHealth);
    expect(hostGate).toBeGreaterThan(0);
    expect(manifestGate).toBeGreaterThan(hostGate);
    expect(optionalHealth).toBeGreaterThan(manifestGate);
    expect(signingPreflight).toBeGreaterThan(optionalHealth);
    expect(tagPreflight).toBeGreaterThan(signingPreflight);
    expect(firstPush).toBeGreaterThan(tagPreflight);
    expect(source.indexOf("label: 'stage verified real-host Agent acceptance for release CI'"))
      .toBeGreaterThan(source.indexOf("label: 'sync OSS repo'"));
    expect(source).toContain('TideMind-Source-Commit: ${expectedRootHead}');

    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    };
    expect(packageJson.scripts?.['verify:agent-integration-release'])
      .toContain('agent-integration-release-manifest.test.ts');
    expect(packageJson.scripts?.['verify:agent-host-acceptance'])
      .toContain('verify-agent-integration-host-acceptance.mjs');

    const workflow = readReleaseWorkflow(path.resolve('.'));
    const admission = workflow.indexOf('Admit release source before secrets');
    const secretPreflight = workflow.indexOf('Require Apple signing and notarization secrets');
    const workflowHostGate = workflow.indexOf('Verify real-host Agent Integration acceptance');
    const workflowGate = workflow.indexOf('npm run verify:agent-integration-release');
    const clientBuild = workflow.indexOf('- name: Build client');
    const packageMac = workflow.indexOf('- name: Package macOS');
    expect(admission).toBeGreaterThan(0);
    expect(secretPreflight).toBeGreaterThan(admission);
    expect(workflow).toContain('if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; then');
    expect(workflow).toContain('[ "$GITHUB_REF" = refs/heads/main ]');
    expect(workflow).toContain('elif [ "$GITHUB_EVENT_NAME" = push ]; then');
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/tags/v* ]]');
    expect(workflow).toContain('build-mac:\n    needs: admit-source');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain("publish-draft:\n    if: github.event_name == 'push' && needs.admit-source.outputs.deferred_host_acceptance != 'true'\n    needs: [admit-source, build-mac]\n    permissions:\n      contents: write");
    expect(workflow).toContain("build-mac:\n    needs: admit-source\n    if: needs.admit-source.outputs.deferred_host_acceptance != 'true'");
    expect(workflow).toContain("deferred-host-release:\n    # 0.2.92 only");
    expect(workflow).toContain('node scripts/verify-deferred-host-release-candidate.mjs');
    expect(workflowHostGate).toBeGreaterThan(0);
    expect(workflowGate).toBeGreaterThan(workflowHostGate);
    expect(clientBuild).toBeGreaterThan(workflowGate);
    expect(packageMac).toBeGreaterThan(clientBuild);
    expect(workflow).toContain('release-evidence/agent-integration-host-acceptance/$version/index.json');
    expect(workflow).toContain('TideMind-Source-Commit');
    expect(workflow).toContain('agent-host-candidate-transfer.mjs extract');
    expect(workflow).toContain('gh release download "$transfer_tag"');
    expect(workflow).toContain('release-evidence/agent-integration-host-candidate-transfer/$version-$architecture.json');
    expect(workflow).not.toContain('agent-integration-host-acceptance/$version/candidate-transfer.json');
    expect(workflow).toContain('verifier_args+=("--candidate-app-$architecture" "$candidate_app")');
    expect(workflow).not.toContain('TIDEMIND_AGENT_HOST_CANDIDATE_APP_ARM64: ${{ vars.');
    expect(workflow).not.toContain('preverified-candidate');
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
      { databaseId: 101, headBranch: 'main', headSha: 'expected', event: 'push', status: 'in_progress' },
      { databaseId: 202, headBranch: 'v0.2.52', headSha: 'expected', event: 'push', status: 'queued' },
    ];

    expect(findReleaseRunId(runs, '0.2.52', 'expected')).toBe('202');
    expect(findReleaseRunId(runs, 'v0.2.52', 'expected')).toBe('202');
    expect(findReleaseRunId(runs, '0.2.51', 'expected')).toBeNull();
    expect(findReleaseRunId(runs, '0.2.52', 'wrong')).toBeNull();
    expect(findReleaseRunId([
      { databaseId: 203, headBranch: 'v0.2.52', headSha: 'expected', event: 'workflow_dispatch' },
    ], '0.2.52', 'expected')).toBeNull();
  });

  it('only accepts a fresh main workflow_dispatch run as package preflight', () => {
    const startedAt = Date.parse('2026-08-12T12:00:00Z');
    const expectedTitle = 'Preflight 11111111-1111-4111-8111-111111111111';
    const runs = [
      { databaseId: 1, headBranch: 'main', headSha: 'expected', event: 'push', createdAt: '2026-08-12T12:02:00Z' },
      { databaseId: 2, headBranch: 'main', headSha: 'expected', event: 'workflow_dispatch', createdAt: '2026-08-12T11:00:00Z' },
      { databaseId: 3, headBranch: 'main', headSha: 'other', event: 'workflow_dispatch', createdAt: '2026-08-12T12:02:00Z' },
      { databaseId: 4, headBranch: 'main', headSha: 'expected', event: 'workflow_dispatch', createdAt: '2026-08-12T12:01:00Z' },
    ];
    expect(findPackagePreflightRunId(runs.map(run => ({ ...run, displayTitle: expectedTitle })), 'expected', startedAt, expectedTitle)).toBe('4');
    const fresh = runs[3];
    expect(findPackagePreflightRunId([
      { ...fresh, databaseId: 5, displayTitle: 'Preflight 22222222-2222-4222-8222-222222222222' },
      { ...fresh, databaseId: 6, displayTitle: expectedTitle.replace('Preflight', 'Candidate') },
      { ...fresh, databaseId: 7 },
    ], 'expected', startedAt, expectedTitle)).toBeNull();
    expect(() => findPackagePreflightRunId(runs, 'expected', startedAt)).toThrow(/unique request ID/);
  });

  it('only accepts private push CI for the exact main commit', () => {
    const runs = [
      { databaseId: 1, headBranch: 'main', headSha: 'expected', event: 'pull_request' },
      { databaseId: 2, headBranch: 'main', headSha: 'other', event: 'push' },
      { databaseId: 3, headBranch: 'release', headSha: 'expected', event: 'push' },
      { databaseId: 4, headBranch: 'main', headSha: 'expected', event: 'push' },
    ];
    expect(findPrivateCiRunId(runs, 'expected')).toBe('4');
    expect(findPrivateCiRunId(runs, 'missing')).toBeNull();
  });

  it('ignores stale same-tag runs created before this push (--force-tag re-release)', () => {
    const pushAt = Date.parse('2026-06-10T12:00:00Z');
    const runs = [
      // Old completed run from the previous release of the same tag — must be skipped.
      { databaseId: 900, headBranch: 'v0.2.84', headSha: 'expected', event: 'push', status: 'completed', createdAt: '2026-06-09T08:00:00Z' },
      // The freshly-triggered run for this push — must be selected.
      { databaseId: 901, headBranch: 'v0.2.84', headSha: 'expected', event: 'push', status: 'queued', createdAt: '2026-06-10T12:01:30Z' },
    ];

    // Without the filter (default minCreatedAtMs=0) the stale old run would win — old behaviour.
    expect(findReleaseRunId(runs, '0.2.84', 'expected')).toBe('900');
    // With the push timestamp, only the run created after the push is matched.
    expect(findReleaseRunId(runs, '0.2.84', 'expected', pushAt)).toBe('901');
  });

  it('returns null when only a stale same-tag run exists and a push timestamp is given', () => {
    const pushAt = Date.parse('2026-06-10T12:00:00Z');
    const runs = [
      { databaseId: 900, headBranch: 'v0.2.84', headSha: 'expected', event: 'push', status: 'completed', createdAt: '2026-06-09T08:00:00Z' },
    ];
    // The old run is filtered out so getReleaseRunId keeps polling for the real new run
    // instead of immediately watching the stale completed one.
    expect(findReleaseRunId(runs, '0.2.84', 'expected', pushAt)).toBeNull();
  });

  it('matches the existing completed run when minCreatedAtMs=0 (already-at-head crash recovery)', () => {
    // already-at-head 收尾重跑:tag 已指向 HEAD、remote ref 已存在,push 是 no-op 不触发新
    // run,只有当初首次 push 创建的已完成 run。main() 此时传 minCreatedAtMs=0,必须仍能命中
    // 该旧 run 继续 sign/publish,否则 getReleaseRunId 永远超时。
    const runs = [
      { databaseId: 900, headBranch: 'v0.2.84', headSha: 'expected', event: 'push', status: 'completed', createdAt: '2026-06-09T08:00:00Z' },
    ];
    expect(findReleaseRunId(runs, '0.2.84', 'expected', 0)).toBe('900');
    expect(findReleaseRunId(runs, '0.2.84', 'expected')).toBe('900');
  });

  it('requires an Ed25519 private key matching the public key embedded in the client', () => {
    const first = crypto.generateKeyPairSync('ed25519');
    const second = crypto.generateKeyPairSync('ed25519');
    const firstPublic = first.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => assertSigningKeyMatchesEmbeddedPublicKey(first.privateKey, firstPublic)).not.toThrow();
    expect(() => assertSigningKeyMatchesEmbeddedPublicKey(second.privateKey, firstPublic))
      .toThrow(/does not match the public key embedded in the client/);

    const shipped = extractEmbeddedUpdatePublicKeys(fs.readFileSync(
      path.resolve('client/electron/ipc/app.ts'),
      'utf8',
    ));
    expect(shipped.primary).toContain('BEGIN PUBLIC KEY');
  });

  it('requires the complete, exact signed release asset set for both architectures', () => {
    const names = expectedReleaseAssetNames('0.2.92');
    const assets = names.map(name => ({ name, size: 1 }));
    expect(() => assertCompleteReleaseAssetList('0.2.92', assets)).not.toThrow();
    expect(() => assertCompleteReleaseAssetList('0.2.92', assets.slice(1)))
      .toThrow(/release asset list mismatch/);
    expect(() => assertCompleteReleaseAssetList('0.2.92', [
      ...assets,
      { name: 'unexpected.dmg', size: 1 },
    ])).toThrow(/unexpected: unexpected\.dmg/);
  });

  it('requires only Apple Silicon artifacts for 0.2.92 while preserving older dual-architecture contracts', () => {
    expect(releaseMacArchitectures('0.2.92')).toEqual(['arm64']);
    expect(releaseMacArchitectures('0.2.91')).toEqual(['arm64', 'x64']);
    expect(expectedReleaseAssetNames('0.2.92').some((name: string) => name.includes('x64'))).toBe(false);
    expect(expectedReleaseAssetNames('0.2.91').some((name: string) => name.includes('x64'))).toBe(true);
    expect(parseArgs(['--prepare-candidate']).prepareCandidate).toBe(true);
  });

  it('prepares candidates without acceptance evidence, signing keys, tag creation, or deployment', () => {
    const output = execFileSync(process.execPath, [
      'scripts/release.mjs', '--prepare-candidate', '--dry-run', '--allow-non-main', '--oss-repo', process.cwd(),
    ], { encoding: 'utf8' });
    expect(output).toContain('build signed Apple Silicon candidate');
    expect(output).toContain('sync OSS repo');
    for (const forbidden of ['verify real-host Agent Integration acceptance', 'deploy website',
      'seal physical', 'create v0.2.92', 'publish GitHub release', 'Release v0.2.92 completed.']) {
      expect(output).not.toContain(`> ${forbidden}`);
    }
  });

  it('requires 0.2.92 notes to disclose every P0 family, level, limitations, and Custom boundaries', () => {
    const families = [
      'Claude Code', 'Claude Cowork', 'Codex', 'Cursor', 'Devin Desktop', 'Gemini CLI',
      'Kimi Code', 'OpenClaw', 'Qwen Code', 'ZCode', 'OpenCode', 'Pi', 'Oh My Pi / OMP', 'QwenWork',
    ];
    const valid = [
      '## TideMind v0.2.92',
      '### Host limitations',
      ...families.map(name => `- ${name}: Complete integration — limitations disclosed.`),
      '- Custom local Agent: non-standard configuration root and manual MCP are supported capability boundaries.',
    ].join('\n');
    expect(() => validateReleaseNotesContent('0.2.92', valid)).not.toThrow();
    expect(() => validateReleaseNotesContent('0.2.92', valid.replace(
      '- QwenWork: Complete integration — limitations disclosed.\n',
      '',
    ))).toThrow(/connection level for QwenWork/);
    expect(() => validateReleaseNotesContent('0.2.92', valid.replace('manual MCP', 'custom connector')))
      .toThrow(/both Custom local Agent boundaries/);
    expect(() => ensureNotesFile('0.2.92', null)).toThrow(/requires an explicit --notes-file/);
  });

  describe('verifyUpdateApi', () => {
    it('verifies arm64 updates and requires Intel clients to retain their installed version', async () => {
      let offerIntel = false;
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const params = new URL(url).searchParams;
        const installed = params.get('version');
        const intel = params.get('arch') === 'x64';
        const noUpdate = installed === '0.2.92' || (intel && !offerIntel);
        return { ok: true, json: async () => ({
          version: noUpdate ? installed : '0.2.92',
          url: noUpdate ? null : `https://github.com/SawyerHan-AI/TideMind/releases/download/v0.2.92/Tide.Mind-0.2.92-${intel ? 'x64' : 'arm64'}.dmg`,
        }) };
      }));
      await expect(verifyUpdateApi('0.2.92', ['0.2.89', '0.2.91'], true)).resolves.toBeUndefined();
      offerIntel = true;
      await expect(verifyUpdateApi('0.2.92', ['0.2.89', '0.2.91'], true)).rejects.toThrow(/unsupported x64/);
    });

    const keypair = crypto.generateKeyPairSync('ed25519');
    const publicKey = keypair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const embeddedKeys = { primary: publicKey, secondary: '' };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function signatureFor(arch: string): string {
      const url = `https://github.com/SawyerHan-AI/TideMind/releases/download/v0.2.84/Tide.Mind-0.2.84-${arch}.dmg`;
      return crypto.sign(null, Buffer.from(`0.2.84\n${url}`), keypair.privateKey).toString('base64');
    }

    function stubUpdateApi(
      responses: Record<string, unknown>,
      signatures: Record<string, string> = {
        arm64: signatureFor('arm64'),
        x64: signatureFor('x64'),
      },
    ) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const parsed = new URL(url);
        const signatureMatch = parsed.pathname.match(/update-manifest-darwin-(arm64|x64)\.sig$/u);
        if (signatureMatch) {
          const body = signatures[signatureMatch[1]];
          if (body === undefined) throw new Error(`unexpected fetch ${url}`);
          return { ok: true, status: 200, text: async () => body } as Response;
        }
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

    it('waits beyond the five-minute cache window, then verifies both architectures', async () => {
      let elapsed = 0;
      const responses = {
        'arm64:0.2.83': okBody('arm64'), 'arm64:0.2.84': noUpdate,
        'x64:0.2.83': okBody('x64'), 'x64:0.2.84': noUpdate,
      };
      stubUpdateApi(responses);
      const freshFetch = globalThis.fetch;
      vi.stubGlobal('fetch', vi.fn(async (...args: Parameters<typeof fetch>) => {
        if (elapsed <= 300_000) return { ok: true, json: async () => ({ version: '0.2.83', url: null, signatureUrl: null }) } as Response;
        return freshFetch(...args);
      }));
      await expect(verifyUpdateApi('0.2.84', '0.2.83', false, embeddedKeys, {
        now: () => elapsed, wait: async (ms: number) => { elapsed += ms; },
      })).resolves.toBeUndefined();
      expect(elapsed).toBe(310_000);
    });

    it('bounds stale-cache retries and immediately rejects malformed responses', async () => {
      let elapsed = 0;
      stubUpdateApi({ 'arm64:0.2.83': { version: '0.2.83', url: null, signatureUrl: null } });
      await expect(verifyUpdateApi('0.2.84', '0.2.83', false, embeddedKeys, {
        timeoutMs: 360_000, intervalMs: 60_000, now: () => elapsed,
        wait: async (ms: number) => { elapsed += ms; },
      })).rejects.toThrow(/did not converge/);
      expect(elapsed).toBe(360_000);
      const wait = vi.fn();
      stubUpdateApi({ 'arm64:0.2.83': { version: '0.2.83', url: 'https://wrong.example/app.dmg' } });
      await expect(verifyUpdateApi('0.2.84', '0.2.83', false, embeddedKeys, { wait }))
        .rejects.toThrow(/malformed cached release/);
      expect(wait).not.toHaveBeenCalled();
      stubUpdateApi({ 'arm64:0.2.83': { version: '0.2.83' } });
      await expect(verifyUpdateApi('0.2.84', '0.2.83', false, embeddedKeys, { wait }))
        .rejects.toThrow(/malformed release response/);
      expect(wait).not.toHaveBeenCalled();
    });

    it('does not retry an invalid cached signature or a current release signature error', async () => {
      const wait = vi.fn();
      const oldBody = {
        version: '0.2.82',
        url: 'https://github.com/SawyerHan-AI/TideMind/releases/download/v0.2.82/Tide.Mind-0.2.82-arm64.dmg',
        signatureUrl: 'https://github.com/SawyerHan-AI/TideMind/releases/download/v0.2.82/update-manifest-darwin-arm64.sig',
      };
      stubUpdateApi({ 'arm64:0.2.83': oldBody }, { arm64: Buffer.alloc(64, 7).toString('base64') });
      await expect(verifyUpdateApi('0.2.84', '0.2.83', false, embeddedKeys, { wait }))
        .rejects.toThrow(/cached release signature does not verify/);
      expect(wait).not.toHaveBeenCalled();
      stubUpdateApi({ 'arm64:0.2.83': { ...okBody('arm64'), signatureUrl: null } });
      await expect(verifyUpdateApi('0.2.84', '0.2.83', false, embeddedKeys, { wait }))
        .rejects.toThrow(/no signatureUrl/);
      expect(wait).not.toHaveBeenCalled();
    });

    it('passes when both arches offer the update with a valid signatureUrl', async () => {
      stubUpdateApi({
        'arm64:0.2.83': okBody('arm64'),
        'arm64:0.2.84': noUpdate,
        'x64:0.2.83': okBody('x64'),
        'x64:0.2.84': noUpdate,
      });
      await expect(verifyUpdateApi('0.2.84', '0.2.83', false, embeddedKeys)).resolves.toBeUndefined();
      // Two endpoint reads plus one signature download for each architecture.
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);
    });

    it('verifies every required previous version on both architectures', async () => {
      stubUpdateApi({
        'arm64:0.2.81': okBody('arm64'),
        'arm64:0.2.83': okBody('arm64'),
        'arm64:0.2.84': noUpdate,
        'x64:0.2.81': okBody('x64'),
        'x64:0.2.83': okBody('x64'),
        'x64:0.2.84': noUpdate,
      });
      await expect(verifyUpdateApi(
        '0.2.84',
        ['0.2.81', '0.2.83'],
        false,
        embeddedKeys,
      )).resolves.toBeUndefined();
      const endpointUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map(([url]) => String(url))
        .filter(url => url.includes('/api/v1/update/latest'));
      expect(endpointUrls).toEqual(expect.arrayContaining([
        expect.stringContaining('arch=arm64&version=0.2.81'),
        expect.stringContaining('arch=arm64&version=0.2.83'),
        expect.stringContaining('arch=x64&version=0.2.81'),
        expect.stringContaining('arch=x64&version=0.2.83'),
      ]));
      expect(endpointUrls).toHaveLength(6);
    });

    it('fails when any required previous version is not offered the release', async () => {
      stubUpdateApi({
        'arm64:0.2.81': okBody('arm64'),
        'arm64:0.2.83': { ...okBody('arm64'), url: null },
      });
      await expect(verifyUpdateApi(
        '0.2.84',
        ['0.2.81', '0.2.83'],
        false,
        embeddedKeys,
      )).rejects.toThrow(/did not offer 0.2.84\/arm64 to 0.2.83/);
    });

    it('throws when signatureUrl is missing on arm64 (sign-before-publish / cache window)', async () => {
      stubUpdateApi({
        'arm64:0.2.83': { ...okBody('arm64'), signatureUrl: null },
        'arm64:0.2.84': noUpdate,
        'x64:0.2.83': okBody('x64'),
        'x64:0.2.84': noUpdate,
      });
      await expect(verifyUpdateApi('0.2.84', '0.2.83', false, embeddedKeys)).rejects.toThrow(/no signatureUrl/);
    });

    it('throws when x64 signatureUrl is missing (arm64-only verify would miss it)', async () => {
      stubUpdateApi({
        'arm64:0.2.83': okBody('arm64'),
        'arm64:0.2.84': noUpdate,
        'x64:0.2.83': { ...okBody('x64'), signatureUrl: null },
        'x64:0.2.84': noUpdate,
      });
      await expect(verifyUpdateApi('0.2.84', '0.2.83', false, embeddedKeys)).rejects.toThrow(/no signatureUrl/);
    });

    it('throws when signatureUrl points at the wrong asset name', async () => {
      stubUpdateApi({
        'arm64:0.2.83': {
          ...okBody('arm64'),
          signatureUrl: 'https://github.com/SawyerHan-AI/TideMind/releases/download/v0.2.84/wrong-name.sig',
        },
        'arm64:0.2.84': noUpdate,
      });
      await expect(verifyUpdateApi('0.2.84', '0.2.83', false, embeddedKeys)).rejects.toThrow(/does not point at update-manifest-darwin-arm64\.sig/);
    });

    it('downloads and cryptographically rejects a mismatched signature', async () => {
      stubUpdateApi({
        'arm64:0.2.83': okBody('arm64'),
        'arm64:0.2.84': noUpdate,
      }, { arm64: Buffer.alloc(64, 7).toString('base64') });
      await expect(verifyUpdateApi('0.2.84', '0.2.83', false, embeddedKeys))
        .rejects.toThrow(/does not verify with a public key embedded in the client/);
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
