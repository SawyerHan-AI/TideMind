import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createManagedTextHostAdapter } from '../../client/electron/agent-integration/hosts/managed-text-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type { AdapterOperationContext, OwnedArtifactBaseline } from '../../client/electron/agent-integration/types'

describe('managed whole-document projection', () => {
  let root: string
  let context: AdapterOperationContext

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-text-'))
    const configRoot = path.join(root, '.qwen')
    fs.mkdirSync(configRoot)
    context = {
      runtime: {
        runtimeRealm: 'local_macos', homeDir: root, applicationDataDir: path.join(root, 'data'),
        shimPath: '/shim', mcpServerPath: '/mcp', hookScriptPath: '/hook',
        preCompactScriptPath: '/pre', postCompactScriptPath: '/post',
        tideMindVersion: '1', catalogVersion: '1', projectionVersion: '1',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos', osUserIdentity: 'usr_01JABCDEF0123456789',
        productFamilyId: 'qwen-code', hostVariant: 'qwen-code-cli', configRoot,
      }),
      agentId: 'eb_fixture',
      operationId: 'op',
    }
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const adapter = (recognitionViaLifecycle = false) => createManagedTextHostAdapter({
    catalogId: 'qwen-code-cli', adapterVersion: '1', componentKey: 'instruction',
    targetFile: ctx => path.join(ctx.installation.canonicalConfigRoot, 'skills', 'tidemind', 'SKILL.md'),
    allowedRoot: ctx => path.join(ctx.installation.canonicalConfigRoot, 'skills'),
    content: () => '---\nname: tidemind\ndescription: test\n---\n',
    reload: 'new_session',
    ...(recognitionViaLifecycle ? {
      recognitionViaHostActivity: {
        componentKey: 'lifecycle' as const,
        signalNames: ['session_start'] as const,
        require: 'any' as const,
        diagnostic: 'document_loaded_by_lifecycle_command',
      },
    } : {}),
  })

  async function plan(ownedArtifacts: readonly OwnedArtifactBaseline[] = []) {
    const host = adapter()
    const observed = await host.inspect(context)
    return host.plan(context, {
      desiredCapability: 1,
      desiredComponents: ['instruction'],
      observed,
      ownedArtifacts,
    })
  }

  it('creates a missing managed document and verifies exact read-back', async () => {
    const host = adapter()
    const prepared = await plan()
    expect(prepared.mutations[0]).toMatchObject({ operation: 'create', ownershipKey: 'document' })
    await host.apply(context, prepared.mutations[0])
    expect(await host.readBack(context, prepared.mutations[0])).toMatchObject({ matchesDesired: true })
  })

  it('does not adopt or overwrite an existing unowned document', async () => {
    const target = path.join(context.installation.canonicalConfigRoot, 'skills', 'tidemind', 'SKILL.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'user content')
    const prepared = await plan()
    expect(prepared.mutations).toEqual([])
    expect(prepared.diagnostics).toContain('target_document_already_exists')
    expect(fs.readFileSync(target, 'utf8')).toBe('user content')
  })

  it('rejects a symlinked target', async () => {
    const target = path.join(context.installation.canonicalConfigRoot, 'skills', 'tidemind', 'SKILL.md')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(outside, 'outside')
    fs.symlinkSync(outside, target)
    const observed = await adapter().inspect(context)
    expect(observed.components[0].visibility).toBe('unknown')
    expect(observed.diagnostics[0]).toContain('symbolic-link')

    const verified = await adapter().verify(context, {
      componentKeys: ['instruction'],
      expectedCapability: 1,
      inspection: observed,
    })
    expect(verified[0]).toMatchObject({
      componentKey: 'instruction',
      status: 'failed',
      diagnostics: ['managed_document_visibility_unknown'],
    })
  })

  it('rejects a symlink anywhere in the managed parent chain', async () => {
    const configRoot = context.installation.canonicalConfigRoot
    const skillsRoot = path.join(configRoot, 'skills')
    const outside = path.join(root, 'outside-skills')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, skillsRoot)

    const observed = await adapter().inspect(context)
    expect(observed.components[0].visibility).toBe('unknown')
    expect(observed.diagnostics).toContain('managed_text_parent_symlink_rejected')
    expect(fs.readdirSync(outside)).toEqual([])

    const verified = await adapter().verify(context, {
      componentKeys: ['instruction'],
      expectedCapability: 1,
      inspection: observed,
    })
    expect(verified[0]).toMatchObject({
      componentKey: 'instruction',
      status: 'failed',
      diagnostics: ['managed_document_visibility_unknown'],
    })
  })

  it('binds read-back to the planned canonical path inside the allowed root', async () => {
    const host = adapter()
    const prepared = await plan()
    const mutation = prepared.mutations[0]
    await host.apply(context, mutation)
    const forged = {
      ...mutation,
      metadata: {
        ...mutation.metadata,
        canonicalPath: path.join(root, 'outside-same-content'),
      },
    }

    expect(await host.readBack(context, forged)).toMatchObject({
      observed: false,
      matchesDesired: false,
      visibility: 'unknown',
      diagnostics: ['managed_text_canonical_path_changed'],
    })
  })

  it('requires manual cleanup for an exact owned whole document', async () => {
    const host = adapter()
    const created = await plan()
    await host.apply(context, created.mutations[0])
    const target = created.mutations[0].physicalTarget
    const ownedHash = created.mutations[0].desiredFragmentHash!
    const observed = await host.inspect(context)
    const disconnected = await host.disconnect(context, {
      componentKeys: ['instruction'],
      observed,
      ownedArtifacts: [{
        componentKey: 'instruction',
        physicalTarget: target,
        ownershipKey: 'document',
        ownedFragmentHash: ownedHash,
      }],
    })

    expect(disconnected.mutations).toEqual([])
    expect(disconnected.diagnostics).toContain('managed_text_manual_cleanup_required')
    expect(disconnected.requiredUserActions).toContain('manually_remove_owned_document')
    expect(disconnected.requiredUserActionDetails).toEqual([{
      kind: 'manual_file_removal',
      componentKey: 'instruction',
      operation: 'disconnect',
      physicalTarget: fs.realpathSync(target),
      ownedFragmentHash: ownedHash,
      instruction: `Remove the Tide Mind-owned file at ${fs.realpathSync(target)}, then recheck the connection.`,
    }])
    expect(fs.existsSync(target)).toBe(true)
  })

  it('refuses a persisted legacy whole-document remove mutation', async () => {
    const host = adapter()
    const created = await plan()
    await host.apply(context, created.mutations[0])
    const legacyRemove = {
      ...created.mutations[0],
      operation: 'remove' as const,
      preconditionHash: created.mutations[0].desiredFragmentHash,
      metadata: {
        ...created.mutations[0].metadata,
        desiredContent: null,
      },
    }

    await expect(host.apply(context, legacyRemove)).rejects.toThrow('managed_text_automatic_remove_unsupported')
    expect(fs.existsSync(legacyRemove.physicalTarget)).toBe(true)
  })

  it('verifies instruction recognition only when the identity-bound lifecycle command really ran', async () => {
    const host = adapter(true)
    const observed = await host.inspect(context)
    const prepared = await host.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['instruction'],
      observed,
      ownedArtifacts: [],
    })
    await host.apply(context, prepared.mutations[0])
    const inspection = await host.inspect(context)
    const request = {
      componentKeys: ['instruction'] as const,
      expectedCapability: 4 as const,
      inspection,
      activityBinding: {
        installationId: 'installation',
        tideMindVersion: '1',
        adapterVersion: '1',
        projectionVersion: '1',
        hostVersion: '1.0.0',
        activationRunId: 'run-current',
        activityGenerationToken: 'generation-current',
        activationEpoch: '2026-09-03T00:04:00.000Z',
        observedAfter: '2026-09-03T00:00:00.000Z',
        verifiedAt: '2026-09-03T00:10:00.000Z',
      },
    }

    expect((await host.verify(context, request))[0]).toMatchObject({
      componentKey: 'instruction', status: 'unverified', verifiedCapability: null,
    })

    context.hostActivityEvidence = {
      find: query => [{
        id: 'activity', installationId: query.installationId, agentId: query.agentId,
        hostVariant: query.hostVariant, componentKey: 'lifecycle', signalName: 'session_start',
        tideMindVersion: query.tideMindVersion, adapterVersion: query.adapterVersion,
        projectionVersion: query.projectionVersion, hostVersion: query.hostVersion,
        evidenceHash: 'real-host-receipt', observedAt: '2026-09-03T00:05:00.000Z',
      }],
    }
    expect((await host.verify(context, request))[0]).toMatchObject({
      componentKey: 'instruction', status: 'verified', verifiedCapability: 1,
      diagnostics: expect.arrayContaining(['document_loaded_by_lifecycle_command']),
    })
  })
})
