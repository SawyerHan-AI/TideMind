import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  codexLifecycleUserFacingText,
  inspectLegacyCodexHookProof,
  isExactCodexFourToFiveRecipeUpgrade,
  createCodexLifecycleHostAdapter,
  createOfficialCodexHooksPort,
  verifyCodexHookTrustAction,
  type CodexOfficialHookMetadata,
  type CodexOfficialHooksPort,
} from '../../client/electron/agent-integration/hosts/codex-lifecycle-adapter'
import {createP0HostAdapters} from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import {sha256Json} from '../../client/electron/agent-integration/fingerprint'
import type {
  AdapterOperationContext,
  AdapterPlanRequest,
  CodexHookTrustBinding,
  HostActivityEvidenceQuery,
  JsonValue,
  OwnedArtifactBaseline,
} from '../../client/electron/agent-integration/types'

describe('Codex lifecycle Host Adapter', () => {
  let tempDir: string
  let configRoot: string
  let hooksFile: string
  let context: AdapterOperationContext
  let currentTrust: CodexOfficialHookMetadata['trustStatus']
  let liveMetadata: CodexOfficialHookMetadata[]
  let hooksPort: CodexOfficialHooksPort

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-codex-adapter-test-'))
    tempDir = fs.realpathSync(tempDir)
    configRoot = path.join(tempDir, '.codex')
    fs.mkdirSync(configRoot)
    hooksFile = path.join(configRoot, 'hooks.json')
    currentTrust = 'untrusted'
    liveMetadata = []
    context = createContext('codex-cli')
    hooksPort = {
      list: vi.fn(async () => snapshot(liveMetadata.map(item => ({ ...item, trustStatus: currentTrust })))),
      preview: vi.fn(async (_context, sourcePath, document) => snapshot(
        metadataFromDocument(sourcePath, document, currentTrust),
      )),
    }
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('plans one CAS-managed five-hook fragment and a version/hash-bound explicit trust action', async () => {
    const adapter = createAdapter('codex-cli')
    const plan = await adapter.plan(context, await request(adapter))

    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      componentKey: 'lifecycle',
      operation: 'create',
      domainKind: 'file_fragment',
      physicalTarget: hooksFile,
      ownershipKey: 'hooks.tidemind-agent-codex',
      reload: 'new_session',
      containerPreconditionHash: undefined,
    })
    expect(plan.requiredUserActions).toEqual(['codex_hook_trust_required'])
    expect(plan.requiredUserActionDetails).toHaveLength(1)
    expect(plan.requiredUserActionDetails?.[0]).toMatchObject({
      kind: 'codex_hook_trust',
      componentKey: 'lifecycle',
      installationId: 'installation-codex',
      agentId: 'agent-codex',
      hostVariant: 'codex-cli',
      sourcePath: hooksFile,
      hookKey: officialHookKeys(hooksFile).sort().join('|'),
      ownedFragmentHash: plan.mutations[0]?.desiredFragmentHash,
      hostCurrentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      tideMindVersion: '0.2.92',
      adapterVersion: '7',
      projectionVersion: 'projection-7',
      hostVersion: '0.145.0',
      instruction: codexLifecycleUserFacingText().trustInstruction,
    })
    expect(plan.requiredUserActionDetails?.[0]?.sourcePathHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(plan.requiredUserActionDetails?.[0]?.hookKeyHash).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('observes the official 0.157.1 SessionEnd reason other without filtering reasons', async () => {
    // rust-v0.157.1 codex-rs/hooks/src/events/session_end.rs:
    // SESSION_END_REASON="other"; select_handlers(..., Some(SESSION_END_REASON)).
    const adapter=createAdapter('codex-cli')
    const plan=await adapter.plan(context,await request(adapter))
    await adapter.apply(context,plan.mutations[0]!)
    const entry=((readHooks().hooks as Record<string,JsonValue>).SessionEnd as JsonValue[])[0] as Record<string,JsonValue>
    expect(entry).not.toHaveProperty('matcher')
    const ups=((readHooks().hooks as Record<string,JsonValue>).UserPromptSubmit as JsonValue[])[0] as Record<string,JsonValue>
    expect(ups).not.toHaveProperty('matcher')
    expect((ups.hooks as Array<Record<string,JsonValue>>)[0]).toMatchObject({type:'command',timeout:3})
    expect((ups.hooks as Array<Record<string,JsonValue>>)[0].command).toContain('hook-codex-user-prompt-submit.cjs')
    const official=await createOfficialCodexHooksPort({managedPolicyPaths:[]}).list(context)
    expect(official.hooks.find(hook=>hook.eventName==='sessionEnd')?.matcher).toBeNull()
    const nativeReason='other'
    expect(entry.matcher===undefined || new RegExp(String(entry.matcher)).test(nativeReason)).toBe(true)
    expect(new RegExp('exit|archive').test(nativeReason)).toBe(false)
  })

  it('versions only the Codex lifecycle component and requires native trust for the fifth event', async () => {
    const registry=createP0HostAdapters({codexHooksPort:createOfficialCodexHooksPort({managedPolicyPaths:[]})})
    expect(registry.get('codex-cli')?.adapterVersion).toBe('1+1+2')
    expect(registry.get('codex-desktop')?.adapterVersion).toBe('1+1+2')
    expect(context.runtime.projectionVersion).toBe('projection-7')
    const port=createOfficialCodexHooksPort({managedPolicyPaths:[]})
    const adapter=createCodexLifecycleHostAdapter({catalogId:'codex-cli',adapterVersion:'2',hooksPort:port})
    const plan=await adapter.plan(context,await request(adapter))
    await adapter.apply(context,plan.mutations[0])
    const snapshot=await port.list(context)
    expect(snapshot.hooks).toHaveLength(5)
    const writeTrust=(hooks:readonly CodexOfficialHookMetadata[])=>fs.writeFileSync(path.join(configRoot,'config.toml'),
      hooks.map(hook=>'[hooks.state.'+JSON.stringify(hook.key)+']\ntrusted_hash = '+JSON.stringify(hook.currentHash)+'\n').join('\n'))
    writeTrust(snapshot.hooks.filter(hook=>hook.eventName!=='userPromptSubmit'))
    await expect(verifyCodexHookTrustAction(context,plan.requiredUserActionDetails![0] as never,port)).resolves.toBeNull()
    writeTrust(snapshot.hooks)
    await expect(verifyCodexHookTrustAction(context,plan.requiredUserActionDetails![0] as never,port)).resolves.toMatchObject({trusted:true})
  })

  it('binds an exact four-to-five recipe proof to owned old bytes across a new generation', async () => {
    const adapter=createAdapter('codex-cli')
    const created=await adapter.plan(context,await request(adapter))
    const five=created.mutations[0].metadata!.desiredFragment as Record<string,JsonValue>
    const {UserPromptSubmit: _ups,...four}=five
    const oldHash=sha256Json(four)
    fs.writeFileSync(hooksFile,JSON.stringify({hooks:Object.fromEntries(Object.entries(four).map(([event,entry])=>[event,[entry]]))}))
    const next={...context,activityGenerationToken:'generation-next'}
    const inspection=await adapter.inspect(next)
    expect(inspection.components[0]).toMatchObject({visibility:'dedicated',observedFragmentHash:oldHash})
    const upgraded=await adapter.plan(next,await request(adapter,[ownedBaseline(oldHash)],next))
    expect(upgraded.diagnostics).toEqual([])
    const mutation=upgraded.mutations[0]
    expect(mutation.preconditionHash).toBe(oldHash)
    expect(mutation.metadata?.codexRecipeUpgrade).toEqual({kind:'codex_lifecycle_4_to_5',
      oldFragment:four,oldGenerationToken:'generation-codex',oldFragmentHash:oldHash})
    expect(isExactCodexFourToFiveRecipeUpgrade(four,mutation.metadata?.desiredFragment,'generation-codex','generation-next')).toBe(true)
    await adapter.apply(next,mutation)
    expect(await adapter.readBack(next,mutation)).toMatchObject({matchesDesired:true})
    expect(Object.keys(readHooks().hooks as object)).toHaveLength(5)
  })

  it('rejects partial, changed and wrong fifth-event recipe deltas', async () => {
    const adapter=createAdapter('codex-cli')
    const plan=await adapter.plan(context,await request(adapter))
    const five=plan.mutations[0].metadata!.desiredFragment as Record<string,JsonValue>
    const {UserPromptSubmit: _ups,...four}=five
    expect(isExactCodexFourToFiveRecipeUpgrade(four,five,'generation-codex','generation-codex')).toBe(true)
    const partial={...four};delete partial.PreCompact
    expect(isExactCodexFourToFiveRecipeUpgrade(partial,five,'generation-codex','generation-codex')).toBe(false)
    expect(isExactCodexFourToFiveRecipeUpgrade(four,{...five,UserPromptSubmit:{matcher:'anything',hooks:[]}},'generation-codex','generation-codex')).toBe(false)
    expect(isExactCodexFourToFiveRecipeUpgrade(four,five,'wrong-generation','generation-codex')).toBe(false)
    const changed=JSON.parse(JSON.stringify(four));changed.PreCompact.hooks[0].timeout=16
    expect(isExactCodexFourToFiveRecipeUpgrade(changed,five,'generation-codex','generation-codex')).toBe(false)
  })

  it('retains exact legacy recognition of the former SessionEnd matcher but rejects modified shapes', async () => {
    const adapter=createAdapter('codex-cli')
    const plan=await adapter.plan(context,await request(adapter))
    await adapter.apply(context,plan.mutations[0]!)
    const document=readHooks()
    const entry=((document.hooks as Record<string,JsonValue>).SessionEnd as JsonValue[])[0] as Record<string,JsonValue>
    entry.matcher='exit|archive'
    fs.writeFileSync(hooksFile,JSON.stringify(document))
    expect(inspectLegacyCodexHookProof({...context,activityGenerationToken:'new-generation'},[context.agentId])?.entries
      .some(item=>item.eventName==='SessionEnd')).toBe(true)
    entry.matcher='unproven-custom-reason'
    fs.writeFileSync(hooksFile,JSON.stringify(document))
    expect(()=>inspectLegacyCodexHookProof({...context,activityGenerationToken:'new-generation'},[context.agentId]))
      .toThrow('Legacy Codex hook was modified')
  })

  it('preserves user hooks, applies idempotently, and removes only the exact owned entry', async () => {
    fs.writeFileSync(hooksFile, JSON.stringify({
      userSetting: true,
      hooks: {
        SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'user-command' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }],
      },
    }))
    const adapter = createAdapter('codex-cli')
    const create = await adapter.plan(context, await request(adapter))
    const mutation = create.mutations[0]!
    await adapter.apply(context, mutation)
    expect(await adapter.readBack(context, mutation)).toMatchObject({ matchesDesired: true })

    const afterApply = readHooks()
    expect(afterApply.userSetting).toBe(true)
    expect((afterApply.hooks as Record<string, JsonValue>).Stop).toEqual([
      { hooks: [{ type: 'command', command: 'user-stop' }] },
    ])
    expect(((afterApply.hooks as Record<string, JsonValue>).SessionStart as readonly JsonValue[])).toHaveLength(2)
    expect((afterApply.hooks as Record<string, JsonValue>).PreCompact).toBeDefined()
    expect((afterApply.hooks as Record<string, JsonValue>).PostCompact).toBeDefined()
    expect((afterApply.hooks as Record<string, JsonValue>).SessionEnd).toBeDefined()

    const baseline = ownedBaseline(mutation.desiredFragmentHash!)
    const noop = await adapter.plan(context, await request(adapter, [baseline]))
    expect(noop.mutations).toEqual([])

    const disconnect = await adapter.disconnect(context, {
      componentKeys: ['lifecycle'],
      observed: await adapter.inspect(context),
      ownedArtifacts: [baseline],
    })
    expect(disconnect.mutations).toHaveLength(1)
    await adapter.apply(context, disconnect.mutations[0]!)
    const afterDisconnect = readHooks()
    expect(afterDisconnect.userSetting).toBe(true)
    expect(((afterDisconnect.hooks as Record<string, JsonValue>).SessionStart as readonly JsonValue[])).toEqual([
      { matcher: 'resume', hooks: [{ type: 'command', command: 'user-command' }] },
    ])
    expect((afterDisconnect.hooks as Record<string, JsonValue>).Stop).toBeDefined()
    expect((afterDisconnect.hooks as Record<string, JsonValue>).PreCompact).toBeUndefined()
    expect((afterDisconnect.hooks as Record<string, JsonValue>).PostCompact).toBeUndefined()
    expect((afterDisconnect.hooks as Record<string, JsonValue>).SessionEnd).toBeUndefined()
  })

  it('fails closed when a matching live selector has no ownership baseline', async () => {
    const adapter = createAdapter('codex-cli')
    const first = await adapter.plan(context, await request(adapter))
    await adapter.apply(context, first.mutations[0]!)

    const unowned = await adapter.plan(context, await request(adapter))
    expect(unowned.mutations).toEqual([])
    expect(unowned.diagnostics).toEqual(['matching_selector_has_no_ownership_evidence'])
  })

  it('caps static configuration and even bypass-produced activity at C3 while official trust is absent', async () => {
    const adapter = createAdapter('codex-cli')
    const plan = await adapter.plan(context, await request(adapter))
    await adapter.apply(context, plan.mutations[0]!)
    liveMetadata = metadataFromDocument(hooksFile, readHooks(), 'untrusted')
    context.hostActivityEvidence = activityReader()

    const result = await adapter.verify(context, verificationRequest())
    expect(result[0]).toMatchObject({ status: 'verified', verifiedCapability: 3 })
    expect(result[0]?.invalidationKeys).not.toContain('activity_freshness')
    expect(result[0]?.diagnostics).toContain('codex_hook_not_trusted:sessionStart:untrusted')
  })

  it('requires the exact durable trust receipt in addition to official trusted state', async () => {
    const adapter = createAdapter('codex-cli')
    const plan = await adapter.plan(context, await request(adapter))
    await adapter.apply(context, plan.mutations[0]!)
    liveMetadata = metadataFromDocument(hooksFile, readHooks(), 'trusted')
    currentTrust = 'trusted'
    context.hostActivityEvidence = activityReader()
    context.codexHookTrustEvidence = { findCodexHookTrustEvidence: async () => null }

    const result = await adapter.verify(context, verificationRequest())
    expect(result[0]).toMatchObject({ status: 'verified', verifiedCapability: 3 })
    expect(result[0]?.diagnostics).toContain('codex_hook_trust_receipt_missing')
  })

  it('reaches C4 only with exact hooks/list trust, durable receipt, and all fresh lifecycle activity', async () => {
    const adapter = createAdapter('codex-desktop')
    context = createContext('codex-desktop')
    const plan = await adapter.plan(context, await request(adapter))
    await adapter.apply(context, plan.mutations[0]!)
    liveMetadata = metadataFromDocument(hooksFile, readHooks(), 'trusted')
    currentTrust = 'trusted'
    let receiptQuery: CodexHookTrustBinding | undefined
    context.codexHookTrustEvidence = {
      findCodexHookTrustEvidence: async query => {
        receiptQuery = query
        return { ...query, id: 'trust-event-1', artifactId: 'artifact-lifecycle', verifiedAt: '2026-09-03T00:02:00.000Z' }
      },
    }
    context.hostActivityEvidence = activityReader()

    const result = await adapter.verify(context, verificationRequest())
    expect(receiptQuery).toMatchObject({
      installationId: 'installation-codex',
      hostVariant: 'codex-desktop',
      ownedFragmentHash: plan.mutations[0]?.desiredFragmentHash,
      hostCurrentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      hostVersion: '0.145.0',
    })
    expect(result[0]).toMatchObject({
      status: 'verified',
      verifiedCapability: 4,
      evidenceRef: expect.stringContaining('codex-hook-trust:trust-event-1'),
    })
    expect(result[0]?.evidenceRef).toMatch(/^host-activity:/u)
    expect(result[0]?.invalidationKeys).toContain('activity_freshness')
    expect(result[0]?.diagnostics).toContain('codex_user_layer_trust_receipt_present')
    expect(result[0]?.diagnostics).toContain('codex_effective_lifecycle_activity_verified')
    expect(result[0]?.diagnostics).toContain('host_activity_recognized:post_compact,pre_compact,session_end,session_start')
  })

  it('rechecks a frozen trust action read-only and rejects any stale host hash', async () => {
    const adapter = createAdapter('codex-cli')
    const plan = await adapter.plan(context, await request(adapter))
    const action = plan.requiredUserActionDetails?.[0]
    expect(action?.kind).toBe('codex_hook_trust')
    await adapter.apply(context, plan.mutations[0]!)
    liveMetadata = metadataFromDocument(hooksFile, readHooks(), 'trusted')
    currentTrust = 'trusted'
    await expect(verifyCodexHookTrustAction(context, action!, hooksPort)).resolves.toEqual({
      trusted: true,
      sourcePath: hooksFile,
      hookKey: action!.hookKey,
      hostCurrentHash: action!.hostCurrentHash,
      hooksFileFingerprint: 'e'.repeat(64),
      trustConfigFingerprint: 'f'.repeat(64),
    })
    await expect(verifyCodexHookTrustAction(context, {
      ...action!,
      hostCurrentHash: sha256Prefixed('f'),
    }, hooksPort)).resolves.toBeNull()
  })

  it.each(['codex-cli', 'codex-desktop'] as const)(
    'previews first-time %s hooks through the official port without creating the missing config root',
    async catalogId => {
      fs.rmdirSync(configRoot)
      context = createContext(catalogId)
      const adapter = createCodexLifecycleHostAdapter({
        catalogId,
        adapterVersion: '7',
        hooksPort: createOfficialCodexHooksPort({ managedPolicyPaths: [] }),
      })
      const plan = await adapter.plan(context, await request(adapter))
      expect(plan.diagnostics).toEqual([])
      expect(plan.mutations).toHaveLength(1)
      expect(plan.mutations[0]).toMatchObject({ operation: 'create', physicalTarget: hooksFile })
      expect(plan.requiredUserActions).toContain('codex_hook_trust_required')
      expect(plan.requiredUserActionDetails?.[0]).toMatchObject({
        kind: 'codex_hook_trust', hostVariant: catalogId, sourcePath: hooksFile,
      })
      expect(fs.existsSync(configRoot)).toBe(false)
      expect(fs.readdirSync(tempDir)).toEqual([])
    },
  )

  it('rejects alternate and out-of-root proposed hook paths even when the config root is missing', async () => {
    fs.rmdirSync(configRoot)
    const port = createOfficialCodexHooksPort({ managedPolicyPaths: [] })
    await expect(port.preview(context, path.join(configRoot, 'other.json'), { hooks: {} }))
      .rejects.toThrow('codex_hooks_target_must_be_canonical_root_hooks_json')
    await expect(port.preview(context, path.join(tempDir, 'hooks.json'), { hooks: {} }))
      .rejects.toThrow('outside approved root')
    expect(fs.existsSync(configRoot)).toBe(false)
  })

  it.each(['root', 'file'] as const)('rejects a symbolic-link %s in official hook preview', async target => {
    const outside = path.join(tempDir, 'outside')
    fs.mkdirSync(outside)
    if (target === 'root') {
      fs.rmdirSync(configRoot)
      fs.symlinkSync(outside, configRoot)
    } else {
      fs.writeFileSync(path.join(outside, 'hooks.json'), '{}')
      fs.symlinkSync(path.join(outside, 'hooks.json'), hooksFile)
    }
    const port = createOfficialCodexHooksPort({ managedPolicyPaths: [] })
    await expect(port.preview(context, hooksFile, { hooks: {} })).rejects.toThrow('symbolic-link')
  })

  it('verifies trust from stable official state files without executing the discovered Codex path', async () => {
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: {} }))
    const officialPort = createOfficialCodexHooksPort({ managedPolicyPaths: [] })
    const adapter = createCodexLifecycleHostAdapter({
      catalogId: 'codex-cli',
      adapterVersion: '7',
      hooksPort: officialPort,
    })
    context.installation.distribution = { executableRealpath: path.join(tempDir, 'does-not-exist-codex') }
    const plan = await adapter.plan(context, await request(adapter))
    const action = plan.requiredUserActionDetails?.[0]
    await adapter.apply(context, plan.mutations[0]!)
    const beforeTrust = await officialPort.list(context)
    const sessionStart = beforeTrust.hooks.find(hook => hook.eventName === 'sessionStart')!
    const canonicalIdentity = JSON.stringify({
      event_name: 'session_start',
      hooks: [{
        async: false,
        command: sessionStart.command,
        statusMessage: codexLifecycleUserFacingText().statusMessage,
        timeout: 15,
        type: 'command',
      }],
      matcher: 'startup|resume',
    })
    expect(sessionStart.currentHash).toBe(`sha256:${createHash('sha256').update(canonicalIdentity).digest('hex')}`)
    fs.writeFileSync(path.join(configRoot, 'config.toml'), beforeTrust.hooks.map(hook => (
      `[hooks.state.${JSON.stringify(hook.key)}]\nenabled = true\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`
    )).join('\n'))

    await expect(verifyCodexHookTrustAction(context, action!, officialPort)).resolves.toMatchObject({
      trusted: true,
      hooksFileFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      trustConfigFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
  })

  it('fails closed when requirements.toml forbids user hooks', async () => {
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: {} }))
    const policyPath = path.join(tempDir, 'requirements.toml')
    fs.writeFileSync(policyPath, 'allow_managed_hooks_only = true\n')
    const managedPort = createOfficialCodexHooksPort({ managedPolicyPaths: [policyPath] })
    const adapter = createCodexLifecycleHostAdapter({
      catalogId: 'codex-cli',
      adapterVersion: '7',
      hooksPort: managedPort,
    })
    const plan = await adapter.plan(context, await request(adapter))
    expect(plan.requiredUserActions).toContain('codex_hook_trust_verification_unavailable')
    expect(plan.diagnostics.join('\n')).toContain('codex_managed_policy_blocks_user_hooks')
    expect(plan.requiredUserActionDetails).toBeUndefined()
  })

  it('fails closed when legacy managed_config.toml carries managed-hooks-only requirements', async () => {
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: {} }))
    const policyPath = path.join(tempDir, 'managed_config.toml')
    fs.writeFileSync(policyPath, 'allow_managed_hooks_only = true\n')
    const adapter = createCodexLifecycleHostAdapter({
      catalogId: 'codex-cli',
      adapterVersion: '7',
      hooksPort: createOfficialCodexHooksPort({ managedPolicyPaths: [policyPath] }),
    })
    const plan = await adapter.plan(context, await request(adapter))
    expect(plan.requiredUserActions).toContain('codex_hook_trust_verification_unavailable')
    expect(plan.diagnostics.join('\n')).toContain('codex_managed_policy_blocks_user_hooks')
    expect(plan.requiredUserActionDetails).toBeUndefined()
  })

  it('does not mistake lower-precedence system hooks=false for a hard policy when user enables hooks', async () => {
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: {} }))
    fs.writeFileSync(path.join(configRoot, 'config.toml'), '[features]\nhooks = true\n')
    const systemRoot = path.join(tempDir, 'system')
    fs.mkdirSync(systemRoot)
    const systemConfig = path.join(systemRoot, 'config.toml')
    fs.writeFileSync(systemConfig, '[features]\nhooks = false\n')
    const adapter = createCodexLifecycleHostAdapter({
      catalogId: 'codex-cli',
      adapterVersion: '7',
      hooksPort: createOfficialCodexHooksPort({ managedPolicyPaths: [systemConfig] }),
    })
    const plan = await adapter.plan(context, await request(adapter))
    expect(plan.requiredUserActions).toContain('codex_hook_trust_required')
    expect(plan.requiredUserActionDetails).toHaveLength(1)
  })

  it('allows an active profile to override base hooks=false for the user-layer trust receipt', async () => {
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: {} }))
    fs.writeFileSync(path.join(configRoot, 'config.toml'), [
      'profile = "hooks-enabled"',
      '[features]',
      'hooks = false',
      '[profiles.hooks-enabled.features]',
      'hooks = true',
      '',
    ].join('\n'))
    const adapter = createCodexLifecycleHostAdapter({
      catalogId: 'codex-cli',
      adapterVersion: '7',
      hooksPort: createOfficialCodexHooksPort({ managedPolicyPaths: [] }),
    })
    const plan = await adapter.plan(context, await request(adapter))
    expect(plan.requiredUserActions).toContain('codex_hook_trust_required')
    expect(plan.requiredUserActionDetails).toHaveLength(1)
  })

  it.each(['session_start', 'pre_compact', 'post_compact', 'session_end'] as const)(
    'does not verify Codex C4 when %s evidence is missing',
    async (missingSignal) => {
      const adapter = createAdapter('codex-cli')
      const plan = await adapter.plan(context, await request(adapter))
      await adapter.apply(context, plan.mutations[0]!)
      liveMetadata = metadataFromDocument(hooksFile, readHooks(), 'trusted')
      currentTrust = 'trusted'
      context.codexHookTrustEvidence = {
        findCodexHookTrustEvidence: async query => ({
          ...query,
          id: 'trust-event-1',
          artifactId: 'artifact-lifecycle',
          verifiedAt: '2026-09-03T00:02:00.000Z',
        }),
      }
      context.hostActivityEvidence = activityReader(missingSignal)

      const result = await adapter.verify(context, verificationRequest())
      expect(result[0]).toMatchObject({ status: 'verified', verifiedCapability: 3 })
      expect(result[0]?.diagnostics).toContain('codex_user_layer_trust_receipt_present')
      expect(result[0]?.diagnostics).not.toContain('codex_effective_lifecycle_activity_verified')
      expect(result[0]?.diagnostics).toContain('fresh_host_activity_evidence_missing')
    },
  )

  it('uses one shared physical domain and ownership selector for CLI and Desktop', async () => {
    const cli = createAdapter('codex-cli')
    const desktop = createAdapter('codex-desktop')
    const cliContext = createContext('codex-cli')
    const desktopContext = createContext('codex-desktop')
    const [cliPlan, desktopPlan] = await Promise.all([
      cli.plan(cliContext, await request(cli, [], cliContext)),
      desktop.plan(desktopContext, await request(desktop, [], desktopContext)),
    ])
    expect(cliPlan.mutations[0]?.physicalTarget).toBe(desktopPlan.mutations[0]?.physicalTarget)
    expect(cliPlan.mutations[0]?.ownershipKey).toBe(desktopPlan.mutations[0]?.ownershipKey)
    expect(cliPlan.mutations[0]?.containerPreconditionHash).toBe(desktopPlan.mutations[0]?.containerPreconditionHash)
  })

  function createAdapter(catalogId: 'codex-cli' | 'codex-desktop') {
    return createCodexLifecycleHostAdapter({ catalogId, adapterVersion: '7', hooksPort })
  }

  function createContext(hostVariant: 'codex-cli' | 'codex-desktop'): AdapterOperationContext {
    return {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: tempDir,
        applicationDataDir: path.join(tempDir, 'app-data'),
        shimPath: path.join(tempDir, 'runtime', 'node'),
        mcpServerPath: path.join(tempDir, 'runtime', 'mcp.cjs'),
        hookScriptPath: path.join(tempDir, 'runtime', 'hook-session-start.cjs'),
        preCompactScriptPath: path.join(tempDir, 'runtime', 'hook-pre-compact.cjs'),
        postCompactScriptPath: path.join(tempDir, 'runtime', 'hook-post-compact.cjs'),
        tideMindVersion: '0.2.92',
        catalogVersion: 'catalog-7',
        projectionVersion: 'projection-7',
      },
      installation: {
        runtimeRealm: 'local_macos',
        osUserIdentity: 'uid:501',
        productFamilyId: 'codex',
        hostVariant,
        canonicalConfigRoot: configRoot,
        componentConfigFiles: {
          lifecycle: hooksFile,
          instruction: path.join(tempDir, '.agents', 'skills', 'tidemind', 'SKILL.md'),
        },
        explicitProfile: 'default',
        distribution: { executableRealpath: '/bin/echo' },
        installKey: `codex:${hostVariant}:default`,
      },
      installationId: 'installation-codex',
      hostVersion: '0.145.0',
      agentId: 'agent-codex',
      operationId: 'operation-codex',
      activityGenerationToken: 'generation-codex',
    }
  }

  async function request(
    adapter: ReturnType<typeof createAdapter>,
    ownedArtifacts: readonly OwnedArtifactBaseline[] = [],
    operationContext = context,
  ): Promise<AdapterPlanRequest> {
    return {
      desiredCapability: 4,
      desiredComponents: ['lifecycle'],
      observed: await adapter.inspect(operationContext),
      ownedArtifacts,
    }
  }

  function ownedBaseline(hash: string): OwnedArtifactBaseline {
    return {
      componentKey: 'lifecycle',
      physicalTarget: hooksFile,
      ownershipKey: 'hooks.tidemind-agent-codex',
      ownedFragmentHash: hash,
      selectorSchemaVersion: 1,
    }
  }

  function readHooks(): Record<string, JsonValue> {
    return JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as Record<string, JsonValue>
  }

  function verificationRequest() {
    return {
      componentKeys: ['lifecycle'] as const,
      expectedCapability: 4 as const,
      inspection: {} as never,
      activityBinding: {
        installationId: 'installation-codex',
        tideMindVersion: '0.2.92',
        adapterVersion: '7',
        projectionVersion: 'projection-7',
        hostVersion: '0.145.0',
        activationRunId: 'run-codex',
        activityGenerationToken: 'generation-codex',
        observedAfter: '2026-09-03T00:00:00.000Z',
        verifiedAt: '2026-09-03T00:05:00.000Z',
      },
    }
  }

  function activityReader(
    missingSignal?: 'session_start' | 'pre_compact' | 'post_compact' | 'session_end',
  ) {
    return {
      find: async (query: HostActivityEvidenceQuery) => query.signalNames
        .filter(signalName => signalName !== missingSignal)
        .map(signalName => ({
          id: `activity-${signalName}`,
          installationId: query.installationId,
          agentId: query.agentId,
          hostVariant: query.hostVariant,
          componentKey: query.componentKey,
          signalName,
          tideMindVersion: query.tideMindVersion,
          adapterVersion: query.adapterVersion,
          projectionVersion: query.projectionVersion,
          hostVersion: query.hostVersion,
          evidenceHash: `activity-hash-${signalName}`,
          observedAt: '2026-09-03T00:03:00.000Z',
        })),
    }
  }
})

function metadataFromDocument(
  sourcePath: string,
  document: Readonly<Record<string, JsonValue>>,
  trustStatus: CodexOfficialHookMetadata['trustStatus'],
): CodexOfficialHookMetadata[] {
  const definitions = [
    ['SessionStart', 'sessionStart', 'session_start', 'a'],
    ['PreCompact', 'preCompact', 'pre_compact', 'b'],
    ['PostCompact', 'postCompact', 'post_compact', 'c'],
    ['SessionEnd', 'sessionEnd', 'session_end', 'd'],
    ['UserPromptSubmit', 'userPromptSubmit', 'user_prompt_submit', 'e'],
  ] as const
  const root = document.hooks as Record<string, JsonValue>
  return definitions.map(([event, canonicalEvent, keyEvent, hashCharacter]) => {
    const entries = root[event] as readonly JsonValue[]
    const entry = entries.at(-1) as Record<string, JsonValue>
    const command = ((entry.hooks as readonly JsonValue[])[0] as Record<string, JsonValue>).command
    return {
      key: `${sourcePath}:${keyEvent}:0:0`,
      eventName: canonicalEvent,
      handlerType: 'command',
      matcher: typeof entry.matcher === 'string' ? entry.matcher : null,
      command: command as string,
      timeoutSec: 15,
      statusMessage: event === 'SessionStart' ? codexLifecycleUserFacingText().statusMessage : null,
      sourcePath,
      source: 'user',
      enabled: true,
      isManaged: false,
      currentHash: sha256Prefixed(hashCharacter),
      trustStatus,
    }
  })
}

function officialHookKeys(sourcePath: string): string[] {
  return ['session_start', 'pre_compact', 'post_compact', 'session_end', 'user_prompt_submit']
    .map(event => `${sourcePath}:${event}:0:0`)
}

function sha256Prefixed(character: string): string {
  return `sha256:${character.repeat(64)}`
}

function snapshot(hooks: readonly CodexOfficialHookMetadata[]) {
  return {
    hooks,
    hooksFileFingerprint: 'e'.repeat(64),
    trustConfigFingerprint: 'f'.repeat(64),
  }
}
