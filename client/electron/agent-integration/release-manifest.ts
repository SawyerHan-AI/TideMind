import {
  CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
  type DiscoveredInstallation,
  type LocalDiscoveryReport,
} from './discovery'
import {
  COMPONENT_KEYS,
  type AgentHostAdapter,
  type ArtifactComponentType,
  type CapabilityLevel,
  type CatalogId,
  type ComponentKey,
  type DeliveryMode,
  type HostActivitySignal,
  type MutationDomainKind,
  type ReloadRequirement,
} from './types'
import { AGENT_CATALOG } from './catalog'
import { createHash } from 'node:crypto'
import { npmComposedDistributionSpec } from './npm-distribution-topology'
import { kimiNativeReceiptLookupFingerprint } from './distribution-artifact'

export const AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION = '0.2.92'
export const AGENT_INTEGRATION_RELEASE_SCHEMA_VERSION = 4

/** Variants with a proven Adapter contract for relocating every managed surface under a user-selected root. */
export const CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS = Object.freeze([
  'cursor-desktop'
] as const satisfies readonly CatalogId[])

export const AGENT_INTEGRATION_RELEASE_ENV = Object.freeze({
  writes: 'TIDEMIND_AGENT_INTEGRATION_WRITES',
  adapters: 'TIDEMIND_AGENT_INTEGRATION_ENABLED_ADAPTERS',
  autoRestore: 'TIDEMIND_AGENT_INTEGRATION_AUTO_RESTORE',
})

export type AgentReleaseDisposition = 'managed' | 'guided' | 'migration' | 'observe_only'
export type AgentReleaseMode = 'production' | 'detect_only'
export type AgentReleaseActivationMode = 'managed' | 'user_guided' | 'migration' | 'none'
export type AgentReleaseDistributionChannel = 'npm' | 'signed_cli' | 'signed_app'
export type AgentReleaseMacArchitecture = 'arm64' | 'x64'
export type AgentReleaseGateReason =
  | 'release_entry_missing'
  | 'release_mode_detect_only'
  | 'release_distribution_not_accepted'
  | 'release_version_unverified'
  | 'release_version_not_accepted'
  | 'release_artifact_not_accepted'

export interface AgentReleaseDistributionIdentity {
  channel: AgentReleaseDistributionChannel
  distributionId: string
  packageProvenance: string
  supportedMacArchitectures: readonly AgentReleaseMacArchitecture[]
}

export interface AgentReleaseArtifactProofNode {
  role: string
  relativePath: string
  sha256: string
  sizeBytes: number
  executable: boolean
  normalization: 'raw' | 'openclaw_prefix_template_v1' | 'qwen_relative_root_v1'
}

export interface AgentReleaseDistributionArtifactReceipt {
  distributionId: string
  packageProvenance: string
  version: string
  architecture: AgentReleaseMacArchitecture
  artifactSha256: string
  artifactSizeBytes: number
  executableSha256: string
  executableSizeBytes: number
  distributionSha256: string
  distributionSizeBytes: number
  portableFingerprintSchema: string
  /** Portable digest emitted by discovery from the exact physical proof below. */
  portableArtifactFingerprint: string
  signedCode: Readonly<{
    identifier: string
    teamIdentifier: string
    cdhash: string
    designatedRequirement: string
  }> | null
  npmPackage: Readonly<{
    integrity: string | null
    ownedPackageSha256: string
    ownedEntryCount: number
    ownedTotalBytes: number
    proofNodes: readonly AgentReleaseArtifactProofNode[]
    composition?: Readonly<{
      entryRule: 'copy_platform_binary_v1' | 'js_wrapper_selects_platform_binary_v1' | 'js_entry_loads_platform_native_v1'
      components: readonly Readonly<{
        role: 'platform_selector' | 'platform_leaf'
        installName: string
        manifestName: string
        version: string
        integrity: string
        artifactSha256: string
        artifactSizeBytes: number
        ownedPackageSha256: string
        ownedEntryCount: number
        ownedTotalBytes: number
        nativeExecutableRelativePath: string | null
        nativeExecutableSha256: string | null
        nativeExecutableSizeBytes: number | null
      }>[]
    }>
  }> | null
}

export interface AgentReleaseComponent {
  componentKey: ComponentKey
  applicability: 'supported'
  deliveryMode: DeliveryMode
  disposition: Exclude<AgentReleaseDisposition, 'observe_only'>
  artifactTypes: readonly ArtifactComponentType[]
  mutationDomain: MutationDomainKind
  reload: ReloadRequirement
}

export interface AgentReleaseActivation {
  mode: AgentReleaseActivationMode
  requiresUserConfirmation: boolean
}

export interface AgentReleaseLifecycleRequirement {
  signals: readonly HostActivitySignal[]
  require: 'all'
}

export interface AgentReleaseEntry {
  catalogId: CatalogId
  disposition: AgentReleaseDisposition
  targetCapability: CapabilityLevel
  requiredComponents: readonly ComponentKey[]
  components: readonly AgentReleaseComponent[]
  officialDistributions: readonly AgentReleaseDistributionIdentity[]
  acceptedDistributionArtifacts: readonly AgentReleaseDistributionArtifactReceipt[]
  observedExactVersions: readonly string[]
  releaseAcceptedExactVersions: readonly string[]
  activation: AgentReleaseActivation
  requiredLifecycle: AgentReleaseLifecycleRequirement | null
  customConfigRoot: Readonly<{ supported: boolean }>
  releaseMode: AgentReleaseMode
  enabledByDefault: boolean
  notes?: string
}

export interface AgentIntegrationReleaseManifest {
  schemaVersion: number
  appVersion: string
  features: {
    customLocalAgent: {
      enabledByDefault: boolean
      modes: readonly ['nonstandard_config_root', 'manual_mcp_client']
    }
  }
  entries: readonly AgentReleaseEntry[]
}

export type AgentIntegrationReleasePolicyMode = 'active' | 'emergency_read_only' | 'invalid_manifest'

export interface AgentIntegrationReleasePolicy {
  manifestVersion: string
  mode: AgentIntegrationReleasePolicyMode
  entries: ReadonlyMap<CatalogId, AgentReleaseEntry>
  enabledAdapterIds: readonly CatalogId[]
  autoRestore: boolean
  customLocalAgentEnabled: boolean
  diagnostics: readonly string[]
}

export interface ResolveAgentIntegrationReleasePolicyInput {
  adapters: ReadonlyMap<CatalogId, AgentHostAdapter>
  environment?: Readonly<Record<string, string | undefined>>
  restrictToAdapterIds?: readonly CatalogId[]
  forceObserveOnly?: boolean
  autoRestore?: boolean
  /** Hermetic component tests can inject a deliberately partial Adapter map. */
  strictAdapterCoverage?: boolean
}

type AgentReleaseComponentSeed = Omit<AgentReleaseComponent, 'applicability' | 'deliveryMode' | 'mutationDomain'>

interface ReleaseEntryDetails {
  components: readonly AgentReleaseComponentSeed[]
  officialDistributions: readonly AgentReleaseDistributionIdentity[]
  acceptedDistributionArtifacts: readonly AgentReleaseDistributionArtifactReceipt[]
  observedExactVersions: readonly string[]
  releaseAcceptedExactVersions: readonly string[]
  activation: AgentReleaseActivation
  requiredLifecycle: AgentReleaseLifecycleRequirement | null
  releaseMode: AgentReleaseMode
}

const ALL_COMPONENTS = COMPONENT_KEYS as readonly ComponentKey[]
const CORE_COMPONENTS = ['instruction', 'memory_tools'] as const satisfies readonly ComponentKey[]

/**
 * Signed-build authority for 0.2.92. Observed versions are inventory only.
 * `releaseAcceptedExactVersions` freezes the candidate contract before an
 * unpublished exact-SHA RC is built; that same SHA still needs complete
 * real-host evidence before release.mjs may publish it. An empty candidate list
 * is deliberately detect-only and cannot be packaged as a formal release.
 */
export const AGENT_INTEGRATION_RELEASE_ENTRIES = Object.freeze([
  release('claude-code-cli', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["plugin","skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["plugin","mcp"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["plugin","hook"],"reload":"new_session"}],"officialDistributions":[{"channel":"npm","distributionId":"cli:claude-code-cli","packageProvenance":"npm_metadata:@anthropic-ai/claude-code","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"cli:claude-code-cli","packageProvenance":"npm_metadata:@anthropic-ai/claude-code","version":"2.1.261","architecture":"arm64","artifactSha256":"ce644bd9502bf8b0e42144d268c563b52c3da422bd96c03b443178414d3fd172","artifactSizeBytes":27425,"executableSha256":"5efecaff231b798be3c66def9be54183623b328b80eaef17f93c43987024e82a","executableSizeBytes":199241568,"distributionSha256":"e0e8eaf9b15d75b5db879a9f7c361c675d385842267955fcf0fbb79a85e9503c","distributionSizeBytes":398666057,"portableFingerprintSchema":"npm-composed-platform-surface-v1","portableArtifactFingerprint":"55eaf6bb55bb315c6349543d4da041a505e90860459258abdb0b15bd660c2aef","signedCode":null,"npmPackage":{"integrity":"sha512-j6+AkfCl6/UJBcx66nlZUmWc4XGK3TscvW19Tiat+oDwkz3WqQfKzjvHO5FhR+shXTtktqs6vqSBrJmeSWpU3Q==","ownedPackageSha256":"df8457eece45959a3841068db716756779bb04e82ce24c03bc1b84723e1ba538","ownedEntryCount":7,"ownedTotalBytes":199423912,"proofNodes":[{"role":"npm_package_executable","relativePath":"bin/claude.exe","sha256":"5efecaff231b798be3c66def9be54183623b328b80eaef17f93c43987024e82a","sizeBytes":199241568,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"7477000a7bfe756ba28a803955f737c9f9079c64d07e7e707924b267097d9e4c","sizeBytes":1476,"executable":false,"normalization":"raw"}],"composition":{"entryRule":"copy_platform_binary_v1","components":[{"role":"platform_leaf","installName":"@anthropic-ai/claude-code-darwin-arm64","manifestName":"@anthropic-ai/claude-code-darwin-arm64","version":"2.1.261","integrity":"sha512-HW2cIc5MWj9BOzLxm+3zNTfidepTMAFirwYO8H2ywTamOZvmwb8LzvRlRDLgUzEpUJBIkv9bEvI/RxfMk3zKOg==","ownedPackageSha256":"6457f302d0fc28cb83977a3c1b1ff1af68ed16ec68a1fb55639bcd9c61c7c041","ownedEntryCount":4,"ownedTotalBytes":199242145,"nativeExecutableRelativePath":"claude","nativeExecutableSha256":"5efecaff231b798be3c66def9be54183623b328b80eaef17f93c43987024e82a","nativeExecutableSizeBytes":199241568,"artifactSha256":"809babf7b847545f6591605e05068ae8e24218b7ef39eed0db98cfd833abbf7f","artifactSizeBytes":87262989}]}}},{"distributionId":"cli:claude-code-cli","packageProvenance":"npm_metadata:@anthropic-ai/claude-code","version":"2.1.261","architecture":"x64","artifactSha256":"ce644bd9502bf8b0e42144d268c563b52c3da422bd96c03b443178414d3fd172","artifactSizeBytes":27425,"executableSha256":"2cbc002b32778bd70aa2e668ada920c54d9aacd91b71dbd5619c01ca148ae533","executableSizeBytes":208009440,"distributionSha256":"c9bccda4df10fc3ba5d05b5b303b890b777e2a3b1a0334480af391c33d0ea736","distributionSizeBytes":416201793,"portableFingerprintSchema":"npm-composed-platform-surface-v1","portableArtifactFingerprint":"05dd2bcefeb2a4ef13725bc4709406c2e3fe78443bd7c306df92f210923f21cd","signedCode":null,"npmPackage":{"integrity":"sha512-j6+AkfCl6/UJBcx66nlZUmWc4XGK3TscvW19Tiat+oDwkz3WqQfKzjvHO5FhR+shXTtktqs6vqSBrJmeSWpU3Q==","ownedPackageSha256":"49eab9b3918733b8e81c853489c3736a2d27dc708556b03b5062329552ad1aab","ownedEntryCount":7,"ownedTotalBytes":208191784,"proofNodes":[{"role":"npm_package_executable","relativePath":"bin/claude.exe","sha256":"2cbc002b32778bd70aa2e668ada920c54d9aacd91b71dbd5619c01ca148ae533","sizeBytes":208009440,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"7477000a7bfe756ba28a803955f737c9f9079c64d07e7e707924b267097d9e4c","sizeBytes":1476,"executable":false,"normalization":"raw"}],"composition":{"entryRule":"copy_platform_binary_v1","components":[{"role":"platform_leaf","installName":"@anthropic-ai/claude-code-darwin-x64","manifestName":"@anthropic-ai/claude-code-darwin-x64","version":"2.1.261","integrity":"sha512-gg/I/q0RBE+3mJW4tEJW+h+egnhwWkyD5WQwnsHe2IomssbpGdf3UwqCVkMitQ7d22ws49O8QWon/v5Sx5gYow==","ownedPackageSha256":"fcc94710691e3891f649b3f6dee02fe2129bf928cf762b091fcb6f002dc497cf","ownedEntryCount":4,"ownedTotalBytes":208010009,"nativeExecutableRelativePath":"claude","nativeExecutableSha256":"2cbc002b32778bd70aa2e668ada920c54d9aacd91b71dbd5619c01ca148ae533","nativeExecutableSizeBytes":208009440,"artifactSha256":"1e7e42e2ffbf50d998f07942a4cd8f015c5348f09cc7debfcf8bffcad0a160da","artifactSizeBytes":91257562}]}}}],"observedExactVersions":["2.1.261"],"releaseAcceptedExactVersions":["2.1.261"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","pre_compact","post_compact"],"require":"all"},"releaseMode":"production"}),
  release('claude-code-native', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["plugin","skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["plugin","mcp"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["plugin","hook"],"reload":"new_session"}],"officialDistributions":[{"channel":"signed_cli","distributionId":"cli:claude-code-native","packageProvenance":"signed_cli:com.anthropic.claude-code:Q6L2SF6YDW","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"cli:claude-code-native","packageProvenance":"signed_cli:com.anthropic.claude-code:Q6L2SF6YDW","version":"2.1.261","architecture":"arm64","artifactSha256":"5efecaff231b798be3c66def9be54183623b328b80eaef17f93c43987024e82a","artifactSizeBytes":199241568,"executableSha256":"5efecaff231b798be3c66def9be54183623b328b80eaef17f93c43987024e82a","executableSizeBytes":199241568,"distributionSha256":"5efecaff231b798be3c66def9be54183623b328b80eaef17f93c43987024e82a","distributionSizeBytes":199241568,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"0e20d7658b62542e2af1e83a77e0cdec1485b3eed32a7a7e599f5c0fe503afb4","signedCode":{"identifier":"com.anthropic.claude-code","teamIdentifier":"Q6L2SF6YDW","cdhash":"812861c495e8fee7d847a93c61bcb3a4fe4e7782","designatedRequirement":"identifier \"com.anthropic.claude-code\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = Q6L2SF6YDW"},"npmPackage":null},{"distributionId":"cli:claude-code-native","packageProvenance":"signed_cli:com.anthropic.claude-code:Q6L2SF6YDW","version":"2.1.261","architecture":"x64","artifactSha256":"2cbc002b32778bd70aa2e668ada920c54d9aacd91b71dbd5619c01ca148ae533","artifactSizeBytes":208009440,"executableSha256":"2cbc002b32778bd70aa2e668ada920c54d9aacd91b71dbd5619c01ca148ae533","executableSizeBytes":208009440,"distributionSha256":"2cbc002b32778bd70aa2e668ada920c54d9aacd91b71dbd5619c01ca148ae533","distributionSizeBytes":208009440,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"702dfca75f0520a80d00a7d825743df78c51aff8fc9dba6b70bc2c0d5a6e95d7","signedCode":{"identifier":"com.anthropic.claude-code","teamIdentifier":"Q6L2SF6YDW","cdhash":"7306083b1545bcc2eddf956daf4239e3cfa10975","designatedRequirement":"identifier \"com.anthropic.claude-code\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = Q6L2SF6YDW"},"npmPackage":null}],"observedExactVersions":["2.1.261"],"releaseAcceptedExactVersions":["2.1.261"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","pre_compact","post_compact"],"require":"all"},"releaseMode":"production"}),
  release('claude-desktop-legacy', 'migration', 2, ['memory_tools'], {"components":[{"componentKey":"memory_tools","disposition":"migration","artifactTypes":["mcp"],"reload":"restart_host"}],"officialDistributions":[{"channel":"signed_app","distributionId":"com.anthropic.claudefordesktop","packageProvenance":"signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"com.anthropic.claudefordesktop","packageProvenance":"signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW","version":"1.46388.3","architecture":"arm64","artifactSha256":"51f3295b33dbbfc7d7314523d6de3b0ae2eee79ed4fdbf91a6c3599f2ef77f6f","artifactSizeBytes":355651318,"executableSha256":"0d02ce9eac32dbc8d809c89ad9b5387c7a23ab4b57c1fcd493e1bf30ce333fbb","executableSizeBytes":120064,"distributionSha256":"35d481fa97ebd3277caedd1ccc6c1ab4dd0d367360e2249ce5e8ac54bd12313f","distributionSizeBytes":865243627,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"f871ef616b3aaa1d53870cd091f3bae60db06bd2e05a1ac27bfe3d2a980073b5","signedCode":{"identifier":"com.anthropic.claudefordesktop","teamIdentifier":"Q6L2SF6YDW","cdhash":"6ec4ee0bb532bec524fff752be901dab2ee38ed7","designatedRequirement":"identifier \"com.anthropic.claudefordesktop\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = Q6L2SF6YDW"},"npmPackage":null},{"distributionId":"com.anthropic.claudefordesktop","packageProvenance":"signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW","version":"1.46388.3","architecture":"x64","artifactSha256":"51f3295b33dbbfc7d7314523d6de3b0ae2eee79ed4fdbf91a6c3599f2ef77f6f","artifactSizeBytes":355651318,"executableSha256":"0d02ce9eac32dbc8d809c89ad9b5387c7a23ab4b57c1fcd493e1bf30ce333fbb","executableSizeBytes":120064,"distributionSha256":"35d481fa97ebd3277caedd1ccc6c1ab4dd0d367360e2249ce5e8ac54bd12313f","distributionSizeBytes":865243627,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"f871ef616b3aaa1d53870cd091f3bae60db06bd2e05a1ac27bfe3d2a980073b5","signedCode":{"identifier":"com.anthropic.claudefordesktop","teamIdentifier":"Q6L2SF6YDW","cdhash":"6ec4ee0bb532bec524fff752be901dab2ee38ed7","designatedRequirement":"identifier \"com.anthropic.claudefordesktop\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = Q6L2SF6YDW"},"npmPackage":null}],"observedExactVersions":["1.46388.3"],"releaseAcceptedExactVersions":["1.46388.3"],"activation":{"mode":"migration","requiresUserConfirmation":false},"requiredLifecycle":null,"releaseMode":"production"}),
  release('codex-cli', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["mcp"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["hook"],"reload":"new_session"}],"officialDistributions":[{"channel":"npm","distributionId":"cli:codex-cli","packageProvenance":"npm_metadata:@openai/codex","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"cli:codex-cli","packageProvenance":"npm_metadata:@openai/codex","version":"0.153.4","architecture":"arm64","artifactSha256":"fd04263c1adfa1d285c6c0ad86a97cab508d3012ee9eab80a99f773cc4b2fb3a","artifactSizeBytes":4904,"executableSha256":"61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70","executableSizeBytes":8790,"distributionSha256":"bb1bc4c1a3ee293198f13617a636bc2164a843831a74ee5a423da27d87b5cb50","distributionSizeBytes":288153449,"portableFingerprintSchema":"npm-composed-platform-surface-v1","portableArtifactFingerprint":"9f13f1ac92de50a8c729a5614431eaeca015210f85f3cd0a0947cabed3e71081","signedCode":null,"npmPackage":{"integrity":"sha512-wbHDmit7S/YvBGVX1DQmk13xtWblZ2cApeJ/pB7xDZ10Cna+DZc5ij7f0F4OxdsXN4FW1oLT48OpogUI1+8Y2w==","ownedPackageSha256":"8625cd705d0cfed02570b5729ab13b0a48cde28d9d6430bf00fcb7fce8fd1714","ownedEntryCount":3,"ownedTotalBytes":13206,"proofNodes":[{"role":"npm_package_executable","relativePath":"bin/codex.js","sha256":"61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70","sizeBytes":8790,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"302ed64d0846795501768be9f60f78133688c0c09162c76e80a8a04b045664cb","sizeBytes":1082,"executable":false,"normalization":"raw"}],"composition":{"entryRule":"js_wrapper_selects_platform_binary_v1","components":[{"role":"platform_leaf","installName":"@openai/codex-darwin-arm64","manifestName":"@openai/codex","version":"0.153.4-darwin-arm64","integrity":"sha512-B1qhN3fa1ay0R0wGziXqgwSkB5icpYChNKHhtBHff/0UtSTC7z+l8aTtvMlGjH3E8HEvY3+njIJelM9CAAoVWg==","ownedPackageSha256":"58bb946b8fb34db67eed09551bcc27e7c996592e78e7b46f5dc72360d1c44bbc","ownedEntryCount":7,"ownedTotalBytes":288140243,"nativeExecutableRelativePath":"vendor/aarch64-apple-darwin/bin/codex","nativeExecutableSha256":"b973d440acac501fd2594a43e7ca9ce41e0a65b9dfb28d0d7a7837c99e1261e3","nativeExecutableSizeBytes":220584000,"artifactSha256":"535d301b49131abfda3264f959fb0defa40bbc306976d98ddbc15c424636c55c","artifactSizeBytes":115672312}]}}},{"distributionId":"cli:codex-cli","packageProvenance":"npm_metadata:@openai/codex","version":"0.153.4","architecture":"x64","artifactSha256":"fd04263c1adfa1d285c6c0ad86a97cab508d3012ee9eab80a99f773cc4b2fb3a","artifactSizeBytes":4904,"executableSha256":"61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70","executableSizeBytes":8790,"distributionSha256":"40986ac32558a940556b8c41f77a29623d581058f6f8edd64eeb2ea416af04fc","distributionSizeBytes":308587972,"portableFingerprintSchema":"npm-composed-platform-surface-v1","portableArtifactFingerprint":"f5ccc25904fe96a5213ab575b76886fa37258eafa08d01df601ee7048d5069d1","signedCode":null,"npmPackage":{"integrity":"sha512-wbHDmit7S/YvBGVX1DQmk13xtWblZ2cApeJ/pB7xDZ10Cna+DZc5ij7f0F4OxdsXN4FW1oLT48OpogUI1+8Y2w==","ownedPackageSha256":"8625cd705d0cfed02570b5729ab13b0a48cde28d9d6430bf00fcb7fce8fd1714","ownedEntryCount":3,"ownedTotalBytes":13206,"proofNodes":[{"role":"npm_package_executable","relativePath":"bin/codex.js","sha256":"61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70","sizeBytes":8790,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"302ed64d0846795501768be9f60f78133688c0c09162c76e80a8a04b045664cb","sizeBytes":1082,"executable":false,"normalization":"raw"}],"composition":{"entryRule":"js_wrapper_selects_platform_binary_v1","components":[{"role":"platform_leaf","installName":"@openai/codex-darwin-x64","manifestName":"@openai/codex","version":"0.153.4-darwin-x64","integrity":"sha512-vnSbbPzfoDZmmyzsxswsDDXQ06IVFBzkQU7/hroB3ji93Ok2utcsq8Psfk2tjF5r9mEx8RWFJhzuTGHG26/NDA==","ownedPackageSha256":"e79e4a0e3b4ee2598a6850f48c830a1ba0a901d9fae6d2a9ec0676eebee0036a","ownedEntryCount":7,"ownedTotalBytes":308574766,"nativeExecutableRelativePath":"vendor/x86_64-apple-darwin/bin/codex","nativeExecutableSha256":"88ecd2cbf8044832a49e7710394d9d328f7205fa5e8c8ebbdd015e002b4f6e21","nativeExecutableSizeBytes":237501200,"artifactSha256":"5e468958503c60e940b1b1af3fe2064c16fd141f1607111caf99f2c0a0e80725","artifactSizeBytes":123544033}]}}}],"observedExactVersions":["0.153.4"],"releaseAcceptedExactVersions":["0.153.4"],"activation":{"mode":"managed","requiresUserConfirmation":true},"requiredLifecycle":{"signals":["session_start","pre_compact","post_compact","session_end"],"require":"all"},"releaseMode":"production"}),
  release('codex-desktop', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["mcp"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["hook"],"reload":"new_session"}],"officialDistributions":[{"channel":"signed_app","distributionId":"com.openai.codex","packageProvenance":"signed_app:com.openai.codex:2DC432GLL2","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"com.openai.codex","packageProvenance":"signed_app:com.openai.codex:2DC432GLL2","version":"26.901.41600","architecture":"arm64","artifactSha256":"789062d54b39770d770035758373963a562997b277fc5a957ddf2cd1aaf76913","artifactSizeBytes":594524373,"executableSha256":"2aed62628cef36238aae8a527bf2d0ed5ce59846206aecea52a0ae8649ac224f","executableSizeBytes":69984,"distributionSha256":"fdfc5b9962e473d763cb2b5ab851ea226c73ce433343383b04da6a63a62d63d9","distributionSizeBytes":1427728351,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"1abf9326ea1ad47556a61ab7f6c21a93ccd73dfbdd7c5b2bea5fcbaffa6e21fa","signedCode":{"identifier":"com.openai.codex","teamIdentifier":"2DC432GLL2","cdhash":"f459aefd3b5bfa8844d8216c284a4cb7eaa43821","designatedRequirement":"identifier \"com.openai.codex\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"2DC432GLL2\""},"npmPackage":null},{"distributionId":"com.openai.codex","packageProvenance":"signed_app:com.openai.codex:2DC432GLL2","version":"26.901.41600","architecture":"x64","artifactSha256":"8d84c089938984bec275681f793f8f82ee1945b3fe9a1d6762fdbd6328498cdb","artifactSizeBytes":580686466,"executableSha256":"af892103a91068ff8e4fb33f7a47834efead95785b7ab8fb7654c93cc2962e4f","executableSizeBytes":45408,"distributionSha256":"9f89701366821e3cbec7acb0ff0645cb674b9e1426fc544cbb8a45eac01d251a","distributionSizeBytes":1393335519,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"1a2997bfa0dc879d95fac0ee968a5736f90be20a0ace6823048af5780c64b8fa","signedCode":{"identifier":"com.openai.codex","teamIdentifier":"2DC432GLL2","cdhash":"2b81da5844bb8387b47b0c64973daa4bdc147813","designatedRequirement":"identifier \"com.openai.codex\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"2DC432GLL2\""},"npmPackage":null}],"observedExactVersions":["26.901.41600"],"releaseAcceptedExactVersions":["26.901.41600"],"activation":{"mode":"managed","requiresUserConfirmation":true},"requiredLifecycle":{"signals":["session_start","pre_compact","post_compact","session_end"],"require":"all"},"releaseMode":"production"}),
  release('cursor-desktop', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["mcp"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["hook"],"reload":"new_session"}],"officialDistributions":[{"channel":"signed_app","distributionId":"com.todesktop.230313mzl4w4u92","packageProvenance":"signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"com.todesktop.230313mzl4w4u92","packageProvenance":"signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9","version":"3.19.7","architecture":"arm64","artifactSha256":"7eff6b6e511c24a03152bb7730ca5ed11457dfc1feb3288c57f05426dd04013d","artifactSizeBytes":289324141,"executableSha256":"93f27645bdb12bc684345a1b7c4b54a446c2abedbde842c59c4749ee6e1f154d","executableSizeBytes":53184,"distributionSha256":"3bba4b1ad8d0c4fdd761945a1bbe67cd89e06b7b092a433c7450bc938924259c","distributionSizeBytes":866231760,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"88f5ef4967277188ae1ef04c974cc1369939d2540c65b70c37c8a7ea3299843f","signedCode":{"identifier":"com.todesktop.230313mzl4w4u92","teamIdentifier":"VDXQ22DGB9","cdhash":"1c12b854262faf674e28b9b51975b270da2db3de","designatedRequirement":"anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and (certificate leaf[subject.OU] = VDXQ22DGB9 or certificate leaf[subject.OU] = DCNK4UB866)"},"npmPackage":null},{"distributionId":"com.todesktop.230313mzl4w4u92","packageProvenance":"signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9","version":"3.19.7","architecture":"x64","artifactSha256":"b478ab78587212236f8152396017418f77a7816a5314aec8e690b004564dac5e","artifactSizeBytes":298865311,"executableSha256":"ee7de994b63ecdbea26ab8c30521762fae8c20b304bd148d646042dbb8212e82","executableSizeBytes":32752,"distributionSha256":"ea4b77b6898b731e2aa6c2d3a91d8db5a23e4d6670e2925fc7a4de15618131cd","distributionSizeBytes":878542546,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"9d4d76ef25a1130b8ecf8dcaeb2b868cffcc857a2cee54b53c0f5098e7bb285f","signedCode":{"identifier":"com.todesktop.230313mzl4w4u92","teamIdentifier":"VDXQ22DGB9","cdhash":"6195945178898301865857384d3834bc1a4235d5","designatedRequirement":"anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and (certificate leaf[subject.OU] = VDXQ22DGB9 or certificate leaf[subject.OU] = DCNK4UB866)"},"npmPackage":null}],"observedExactVersions":["3.19.7"],"releaseAcceptedExactVersions":["3.19.7"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","pre_compact","session_end"],"require":"all"},"releaseMode":"production"}),
  release('windsurf-desktop', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["mcp"],"reload":"version_dependent"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["hook"],"reload":"restart_host"}],"officialDistributions":[{"channel":"signed_app","distributionId":"com.exafunction.windsurf","packageProvenance":"signed_app:com.exafunction.windsurf:83Z2LHX6XW","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"com.exafunction.windsurf","packageProvenance":"signed_app:com.exafunction.windsurf:83Z2LHX6XW","version":"3.8.20","architecture":"arm64","artifactSha256":"2d606a3cf77b0d7da96b68e22edd5a353731c6aec772f41e9724c83f74897a0e","artifactSizeBytes":349012506,"executableSha256":"9aa20b3abfcec175de87699ecd5d24be600ffef1039841a4f729b000dca8adef","executableSizeBytes":53072,"distributionSha256":"071b579ee0140fbb0a7533b2b38cab8af99b59f959264feb98abb7f31d8dfdb1","distributionSizeBytes":1130488912,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"85befca2ba25c54cabc701bd12ad5b58570850ab23a6dcc473fb805da747df9e","signedCode":{"identifier":"com.exafunction.windsurf","teamIdentifier":"83Z2LHX6XW","cdhash":"04d2732984fefe03f044009dd8de615be6b3dcd7","designatedRequirement":"identifier \"com.exafunction.windsurf\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"83Z2LHX6XW\""},"npmPackage":null},{"distributionId":"com.exafunction.windsurf","packageProvenance":"signed_app:com.exafunction.windsurf:83Z2LHX6XW","version":"3.8.20","architecture":"x64","artifactSha256":"d8dea3387c72e20c47d908a35c06354e68c55b06756fdb1895f75ca1b603458d","artifactSizeBytes":362320413,"executableSha256":"a88166e708b23d4b87d5283fa2bb4db863ceb07e6f1b80aaf266baeecbee135e","executableSizeBytes":32448,"distributionSha256":"f008349db6f854add91134a9fbb59e30fb16968745830100c273c5cc4f1cb5e2","distributionSizeBytes":1149390979,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"2930933bec8478c160d0dda6370aead250af44c93b8f35318e12f7c4520bad47","signedCode":{"identifier":"com.exafunction.windsurf","teamIdentifier":"83Z2LHX6XW","cdhash":"3700dfd0e1ba7403ac3a96fdba34471907636247","designatedRequirement":"identifier \"com.exafunction.windsurf\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"83Z2LHX6XW\""},"npmPackage":null}],"observedExactVersions":["3.8.20"],"releaseAcceptedExactVersions":["3.8.20"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","session_end"],"require":"all"},"releaseMode":"production"}),
  release('gemini-cli', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["plugin","skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["plugin","mcp"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["plugin","hook"],"reload":"new_session"}],"officialDistributions":[{"channel":"npm","distributionId":"cli:gemini-cli","packageProvenance":"npm_metadata:@google/gemini-cli","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"cli:gemini-cli","packageProvenance":"npm_metadata:@google/gemini-cli","version":"0.58.0","architecture":"arm64","artifactSha256":"8ffeb9e7edddffb054764d00749f39e8cc9804ca9b38b9093f906dd2157322ae","artifactSizeBytes":20720999,"executableSha256":"25f087a42f4484891aa73e6e36cc2790e69a3c023cc44fd244adf44a091eebd7","executableSizeBytes":5381,"distributionSha256":"ed48fcbaff555bdaa8d9d9f0a5dc9d0e5218945e039f163f6620a71f9c2de413","distributionSizeBytes":97987180,"portableFingerprintSchema":"npm-owned-package-surface-v1","portableArtifactFingerprint":"ee5740c330f35bbefbf7d2a75da89550253921969803ec81c49988f865f222f2","signedCode":null,"npmPackage":{"integrity":"sha512-++LtUYMcLE8dVxMcuwv6kIp8+h6z+std/7iVE+vSunkrwNDaWMFkWw/psv2RSySWjr2A1SsEEIGCK0xULWY2sA==","ownedPackageSha256":"ed48fcbaff555bdaa8d9d9f0a5dc9d0e5218945e039f163f6620a71f9c2de413","ownedEntryCount":449,"ownedTotalBytes":97987180,"proofNodes":[{"role":"npm_package_executable","relativePath":"bundle/gemini.js","sha256":"25f087a42f4484891aa73e6e36cc2790e69a3c023cc44fd244adf44a091eebd7","sizeBytes":5381,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"c245359deb39a901dc586996a4393ab05d5c99df6fb515c53bd91716197dcfff","sizeBytes":705,"executable":false,"normalization":"raw"}]}},{"distributionId":"cli:gemini-cli","packageProvenance":"npm_metadata:@google/gemini-cli","version":"0.58.0","architecture":"x64","artifactSha256":"8ffeb9e7edddffb054764d00749f39e8cc9804ca9b38b9093f906dd2157322ae","artifactSizeBytes":20720999,"executableSha256":"25f087a42f4484891aa73e6e36cc2790e69a3c023cc44fd244adf44a091eebd7","executableSizeBytes":5381,"distributionSha256":"ed48fcbaff555bdaa8d9d9f0a5dc9d0e5218945e039f163f6620a71f9c2de413","distributionSizeBytes":97987180,"portableFingerprintSchema":"npm-owned-package-surface-v1","portableArtifactFingerprint":"ee5740c330f35bbefbf7d2a75da89550253921969803ec81c49988f865f222f2","signedCode":null,"npmPackage":{"integrity":"sha512-++LtUYMcLE8dVxMcuwv6kIp8+h6z+std/7iVE+vSunkrwNDaWMFkWw/psv2RSySWjr2A1SsEEIGCK0xULWY2sA==","ownedPackageSha256":"ed48fcbaff555bdaa8d9d9f0a5dc9d0e5218945e039f163f6620a71f9c2de413","ownedEntryCount":449,"ownedTotalBytes":97987180,"proofNodes":[{"role":"npm_package_executable","relativePath":"bundle/gemini.js","sha256":"25f087a42f4484891aa73e6e36cc2790e69a3c023cc44fd244adf44a091eebd7","sizeBytes":5381,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"c245359deb39a901dc586996a4393ab05d5c99df6fb515c53bd91716197dcfff","sizeBytes":705,"executable":false,"normalization":"raw"}]}}],"observedExactVersions":["0.58.0"],"releaseAcceptedExactVersions":["0.58.0"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","pre_compact","session_end"],"require":"all"},"releaseMode":"production"}),
  release('kimi-code-cli', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["mcp"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["hook"],"reload":"new_session"}],"officialDistributions":[{"channel":"npm","distributionId":"cli:kimi-code-cli","packageProvenance":"npm_metadata:@moonshot-ai/kimi-code","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"cli:kimi-code-cli","packageProvenance":"npm_metadata:@moonshot-ai/kimi-code","version":"0.41.0","architecture":"arm64","artifactSha256":"4421e1277bbfa5e46a8e1a863fd9ba4d1a3db8dd890d928f571171ac62a80c1e","artifactSizeBytes":20207490,"executableSha256":"db8e083187241ce6683793ce366f1e100e732caa4f65bd28bbc3fac739762e95","executableSizeBytes":23357855,"distributionSha256":"c7adb91ec74a01448b89c650805776e6125c34cbd2ccb4a187cc3967235dae5e","distributionSizeBytes":58167778,"portableFingerprintSchema":"npm-owned-package-surface-v1","portableArtifactFingerprint":"2e2d4b520781483628f418338f8fa974145a0b57ab6972f54b7bd915dd625fc3","signedCode":null,"npmPackage":{"integrity":"sha512-9F89UvhJpUVnxZm1Jjj9b+Tnb8+5Wr0BpzTE1IGedy8KXZQDZ2GErjqy5fxEfdyfHRXDOjRM6xI4N/kPfDyMAA==","ownedPackageSha256":"c7adb91ec74a01448b89c650805776e6125c34cbd2ccb4a187cc3967235dae5e","ownedEntryCount":547,"ownedTotalBytes":58167778,"proofNodes":[{"role":"npm_package_executable","relativePath":"dist/main.mjs","sha256":"db8e083187241ce6683793ce366f1e100e732caa4f65bd28bbc3fac739762e95","sizeBytes":23357855,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"551274e741d64e942552dab5a08033703b14db314da7153c7545342c2288a876","sizeBytes":4448,"executable":false,"normalization":"raw"}]}},{"distributionId":"cli:kimi-code-cli","packageProvenance":"npm_metadata:@moonshot-ai/kimi-code","version":"0.41.0","architecture":"x64","artifactSha256":"4421e1277bbfa5e46a8e1a863fd9ba4d1a3db8dd890d928f571171ac62a80c1e","artifactSizeBytes":20207490,"executableSha256":"db8e083187241ce6683793ce366f1e100e732caa4f65bd28bbc3fac739762e95","executableSizeBytes":23357855,"distributionSha256":"c7adb91ec74a01448b89c650805776e6125c34cbd2ccb4a187cc3967235dae5e","distributionSizeBytes":58167778,"portableFingerprintSchema":"npm-owned-package-surface-v1","portableArtifactFingerprint":"2e2d4b520781483628f418338f8fa974145a0b57ab6972f54b7bd915dd625fc3","signedCode":null,"npmPackage":{"integrity":"sha512-9F89UvhJpUVnxZm1Jjj9b+Tnb8+5Wr0BpzTE1IGedy8KXZQDZ2GErjqy5fxEfdyfHRXDOjRM6xI4N/kPfDyMAA==","ownedPackageSha256":"c7adb91ec74a01448b89c650805776e6125c34cbd2ccb4a187cc3967235dae5e","ownedEntryCount":547,"ownedTotalBytes":58167778,"proofNodes":[{"role":"npm_package_executable","relativePath":"dist/main.mjs","sha256":"db8e083187241ce6683793ce366f1e100e732caa4f65bd28bbc3fac739762e95","sizeBytes":23357855,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"551274e741d64e942552dab5a08033703b14db314da7153c7545342c2288a876","sizeBytes":4448,"executable":false,"normalization":"raw"}]}}],"observedExactVersions":["0.41.0"],"releaseAcceptedExactVersions":["0.41.0"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","pre_compact","post_compact","session_end"],"require":"all"},"releaseMode":"production"}),
  release('kimi-code-native', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["mcp"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["hook"],"reload":"new_session"}],"officialDistributions":[{"channel":"signed_cli","distributionId":"cli:kimi-code-native","packageProvenance":"signed_cli:kimi:2J9472RW75","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"cli:kimi-code-native","packageProvenance":"signed_cli:kimi:2J9472RW75","version":"0.41.0","architecture":"arm64","artifactSha256":"e7d32a5e261f40e3034c34026116f458e486d8f13d7d72ca6edcf29290c51d1a","artifactSizeBytes":61572356,"executableSha256":"72b3cda45275ff66a8017149806c844ddc9eee724f62e0c079d319e33691ac66","executableSizeBytes":180279232,"distributionSha256":"72b3cda45275ff66a8017149806c844ddc9eee724f62e0c079d319e33691ac66","distributionSizeBytes":180279232,"portableFingerprintSchema":"signed-cli-kimi-release-v2","portableArtifactFingerprint":"6a27ad6ae144c980993473d975ff0e94d8a90ed311740f6dd6e378c8a39f7b72","signedCode":{"identifier":"kimi","teamIdentifier":"2J9472RW75","cdhash":"8420cc441f14eb553c51ff8d606a477e2286ef4e","designatedRequirement":"identifier kimi and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"2J9472RW75\""},"npmPackage":null},{"distributionId":"cli:kimi-code-native","packageProvenance":"signed_cli:kimi:2J9472RW75","version":"0.41.0","architecture":"x64","artifactSha256":"399c60613ed939ccd0d7f8f24f77209a5e6cc1fba5a8d0fe4f5dabeae51710c9","artifactSizeBytes":62615094,"executableSha256":"09419f28548178d879d0835b2bc63a184cdc42816c0ab90f515ab259dc6a9548","executableSizeBytes":182625184,"distributionSha256":"09419f28548178d879d0835b2bc63a184cdc42816c0ab90f515ab259dc6a9548","distributionSizeBytes":182625184,"portableFingerprintSchema":"signed-cli-kimi-release-v2","portableArtifactFingerprint":"190d1c3fcaf13fa331c399cfb6fcf875543d563508ed5951fbd2924120ae2378","signedCode":{"identifier":"kimi","teamIdentifier":"2J9472RW75","cdhash":"0c904b32fa65a6ef43b4a9e9a3fff462895fccc3","designatedRequirement":"identifier kimi and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"2J9472RW75\""},"npmPackage":null}],"observedExactVersions":["0.41.0"],"releaseAcceptedExactVersions":["0.41.0"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","pre_compact","post_compact","session_end"],"require":"all"},"releaseMode":"production"}),
  release('openclaw-local', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["plugin","skill"],"reload":"restart_host"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["plugin"],"reload":"restart_host"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["plugin","hook"],"reload":"restart_host"}],"officialDistributions":[{"channel":"npm","distributionId":"cli:openclaw-local:portable-wrapper","packageProvenance":"npm_metadata:openclaw","supportedMacArchitectures":["arm64","x64"]},{"channel":"npm","distributionId":"cli:openclaw-local:npm-global","packageProvenance":"npm_metadata:openclaw","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"cli:openclaw-local:portable-wrapper","packageProvenance":"npm_metadata:openclaw","version":"2026.9.1","architecture":"arm64","artifactSha256":"1a0f57d05eff9e9aa2eaec8016ae87b5c9a74dcbff651a323baa29feaf1dfdbb","artifactSizeBytes":60526,"executableSha256":"205a25049683e6f3669f8e9da45fb9ba72cac7187aa1a770032453f43ea773e0","executableSizeBytes":168,"distributionSha256":"6a1bd82b2c83339f85a42e67bc706e50ae5d6a5becbb05c74d0cc57f8df91819","distributionSizeBytes":174863186,"portableFingerprintSchema":"openclaw-official-wrapper-v1","portableArtifactFingerprint":"625a4da10c16ea6713560265990ba1304470e2e5404221326b68b71be0a131d1","signedCode":null,"npmPackage":{"integrity":"sha512-0Ve0631CdgkJDwd4NNG1BawIdF5yCL2sO+Tts8amStw+H6vKURTj0K4rOa4+hFpJk1Dnw5LyKl5twzwX1VtA2w==","ownedPackageSha256":"6a1bd82b2c83339f85a42e67bc706e50ae5d6a5becbb05c74d0cc57f8df91819","ownedEntryCount":9421,"ownedTotalBytes":174863186,"proofNodes":[{"role":"openclaw_wrapper","relativePath":"bin/openclaw","sha256":"205a25049683e6f3669f8e9da45fb9ba72cac7187aa1a770032453f43ea773e0","sizeBytes":168,"executable":true,"normalization":"openclaw_prefix_template_v1"},{"role":"openclaw_node_runtime","relativePath":"tools/node-v24.19.0/bin/node","sha256":"27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1","sizeBytes":121306800,"executable":true,"normalization":"raw"},{"role":"openclaw_entry","relativePath":"tools/node-v24.19.0/lib/node_modules/openclaw/dist/entry.js","sha256":"828f36f65a884bc4ab8ea7ff83858538f66fbc989a1cee4a773a361e232058b0","sizeBytes":24733,"executable":false,"normalization":"raw"},{"role":"package_manifest","relativePath":"tools/node-v24.19.0/lib/node_modules/openclaw/package.json","sha256":"1c1ac299bfbe511ec2f31e4086d2c008282c81fe7d78077e00b01f1d45ab158e","sizeBytes":131578,"executable":false,"normalization":"raw"}]}},{"distributionId":"cli:openclaw-local:portable-wrapper","packageProvenance":"npm_metadata:openclaw","version":"2026.9.1","architecture":"x64","artifactSha256":"1a0f57d05eff9e9aa2eaec8016ae87b5c9a74dcbff651a323baa29feaf1dfdbb","artifactSizeBytes":60526,"executableSha256":"205a25049683e6f3669f8e9da45fb9ba72cac7187aa1a770032453f43ea773e0","executableSizeBytes":168,"distributionSha256":"6a1bd82b2c83339f85a42e67bc706e50ae5d6a5becbb05c74d0cc57f8df91819","distributionSizeBytes":174863186,"portableFingerprintSchema":"openclaw-official-wrapper-v1","portableArtifactFingerprint":"39756f6b58ee8a20fcc76863733cc2963602b7bea3885817f016ace8696d2895","signedCode":null,"npmPackage":{"integrity":"sha512-0Ve0631CdgkJDwd4NNG1BawIdF5yCL2sO+Tts8amStw+H6vKURTj0K4rOa4+hFpJk1Dnw5LyKl5twzwX1VtA2w==","ownedPackageSha256":"6a1bd82b2c83339f85a42e67bc706e50ae5d6a5becbb05c74d0cc57f8df91819","ownedEntryCount":9421,"ownedTotalBytes":174863186,"proofNodes":[{"role":"openclaw_wrapper","relativePath":"bin/openclaw","sha256":"205a25049683e6f3669f8e9da45fb9ba72cac7187aa1a770032453f43ea773e0","sizeBytes":168,"executable":true,"normalization":"openclaw_prefix_template_v1"},{"role":"openclaw_node_runtime","relativePath":"tools/node-v24.19.0/bin/node","sha256":"1052eb9c7d6c60a79b968e09f75af55a73462b0f6dff0964336d63b5e13eb63c","sizeBytes":123666640,"executable":true,"normalization":"raw"},{"role":"openclaw_entry","relativePath":"tools/node-v24.19.0/lib/node_modules/openclaw/dist/entry.js","sha256":"828f36f65a884bc4ab8ea7ff83858538f66fbc989a1cee4a773a361e232058b0","sizeBytes":24733,"executable":false,"normalization":"raw"},{"role":"package_manifest","relativePath":"tools/node-v24.19.0/lib/node_modules/openclaw/package.json","sha256":"1c1ac299bfbe511ec2f31e4086d2c008282c81fe7d78077e00b01f1d45ab158e","sizeBytes":131578,"executable":false,"normalization":"raw"}]}},{"distributionId":"cli:openclaw-local:npm-global","packageProvenance":"npm_metadata:openclaw","version":"2026.9.1","architecture":"arm64","artifactSha256":"1bfcac877d53f1e41b69d15c24e081895b2f07d6ff2ffdfe0bf8a7336ab00e59","artifactSizeBytes":55564082,"executableSha256":"4f4d29770da4f86dbd0e07cbd4d46deab785905dd89ac719033fcfd866fb5d17","executableSizeBytes":25135,"distributionSha256":"6a1bd82b2c83339f85a42e67bc706e50ae5d6a5becbb05c74d0cc57f8df91819","distributionSizeBytes":174863186,"portableFingerprintSchema":"npm-owned-package-surface-v1","portableArtifactFingerprint":"bee30facdf7ca6b517174024e71d22f1b4001da870b948741b25cc9010a08c8e","signedCode":null,"npmPackage":{"integrity":"sha512-0Ve0631CdgkJDwd4NNG1BawIdF5yCL2sO+Tts8amStw+H6vKURTj0K4rOa4+hFpJk1Dnw5LyKl5twzwX1VtA2w==","ownedPackageSha256":"6a1bd82b2c83339f85a42e67bc706e50ae5d6a5becbb05c74d0cc57f8df91819","ownedEntryCount":9421,"ownedTotalBytes":174863186,"proofNodes":[{"role":"npm_package_executable","relativePath":"openclaw.mjs","sha256":"4f4d29770da4f86dbd0e07cbd4d46deab785905dd89ac719033fcfd866fb5d17","sizeBytes":25135,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"1c1ac299bfbe511ec2f31e4086d2c008282c81fe7d78077e00b01f1d45ab158e","sizeBytes":131578,"executable":false,"normalization":"raw"}]}},{"distributionId":"cli:openclaw-local:npm-global","packageProvenance":"npm_metadata:openclaw","version":"2026.9.1","architecture":"x64","artifactSha256":"1bfcac877d53f1e41b69d15c24e081895b2f07d6ff2ffdfe0bf8a7336ab00e59","artifactSizeBytes":55564082,"executableSha256":"4f4d29770da4f86dbd0e07cbd4d46deab785905dd89ac719033fcfd866fb5d17","executableSizeBytes":25135,"distributionSha256":"6a1bd82b2c83339f85a42e67bc706e50ae5d6a5becbb05c74d0cc57f8df91819","distributionSizeBytes":174863186,"portableFingerprintSchema":"npm-owned-package-surface-v1","portableArtifactFingerprint":"bee30facdf7ca6b517174024e71d22f1b4001da870b948741b25cc9010a08c8e","signedCode":null,"npmPackage":{"integrity":"sha512-0Ve0631CdgkJDwd4NNG1BawIdF5yCL2sO+Tts8amStw+H6vKURTj0K4rOa4+hFpJk1Dnw5LyKl5twzwX1VtA2w==","ownedPackageSha256":"6a1bd82b2c83339f85a42e67bc706e50ae5d6a5becbb05c74d0cc57f8df91819","ownedEntryCount":9421,"ownedTotalBytes":174863186,"proofNodes":[{"role":"npm_package_executable","relativePath":"openclaw.mjs","sha256":"4f4d29770da4f86dbd0e07cbd4d46deab785905dd89ac719033fcfd866fb5d17","sizeBytes":25135,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"1c1ac299bfbe511ec2f31e4086d2c008282c81fe7d78077e00b01f1d45ab158e","sizeBytes":131578,"executable":false,"normalization":"raw"}]}}],"observedExactVersions":["2026.9.1"],"releaseAcceptedExactVersions":["2026.9.1"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","pre_compact","post_compact","session_end"],"require":"all"},"releaseMode":"production"}),
  release('qwen-code-cli', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["mcp"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["hook"],"reload":"new_session"}],"officialDistributions":[{"channel":"npm","distributionId":"cli:qwen-code-cli:standalone","packageProvenance":"npm_metadata:@qwen-code/qwen-code","supportedMacArchitectures":["arm64","x64"]},{"channel":"npm","distributionId":"cli:qwen-code-cli:npm-global","packageProvenance":"npm_metadata:@qwen-code/qwen-code","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"cli:qwen-code-cli:standalone","packageProvenance":"npm_metadata:@qwen-code/qwen-code","version":"0.23.0","architecture":"arm64","artifactSha256":"0e88da71c981deb88bcfc4ac5a67e5b76fa505c830cfcbe942506d1175b4fcfa","artifactSizeBytes":78321474,"executableSha256":"1461b5ef9149b86e58ea22ddb9cc0616679437f9ff0011cf7c3c102f94568abf","executableSizeBytes":178,"distributionSha256":"b4db5826ea504d5e4cd17f9176944de78fadd7749db203f178638844f5ba34fc","distributionSizeBytes":289157643,"portableFingerprintSchema":"qwen-standalone-surface-v1","portableArtifactFingerprint":"fc0a8a8c71fb020d63027dce5e17269bccf65382069dffe77c38e9c8fa1ab78b","signedCode":null,"npmPackage":{"integrity":null,"ownedPackageSha256":"b4db5826ea504d5e4cd17f9176944de78fadd7749db203f178638844f5ba34fc","ownedEntryCount":5808,"ownedTotalBytes":289157643,"proofNodes":[{"role":"qwen_launcher","relativePath":"bin/qwen","sha256":"1461b5ef9149b86e58ea22ddb9cc0616679437f9ff0011cf7c3c102f94568abf","sizeBytes":178,"executable":true,"normalization":"qwen_relative_root_v1"},{"role":"package_manifest","relativePath":"package.json","sha256":"414e77bb1e872144bf5c38a92e10532fdcabe8c2b055123228c7539491c3c461","sizeBytes":10565,"executable":false,"normalization":"raw"},{"role":"qwen_standalone_manifest","relativePath":"manifest.json","sha256":"c52bf4b0e645ac94c8c7326a42c74581f749806ed2e1d172ddd5b283338893b4","sizeBytes":206,"executable":false,"normalization":"raw"},{"role":"qwen_cli_entry","relativePath":"lib/cli-entry.js","sha256":"68cb29eb7ccc936d78ece5564ef55cae41a55b630e6657dc417c1f2e561cf4c9","sizeBytes":13895,"executable":true,"normalization":"raw"},{"role":"qwen_node_runtime","relativePath":"node/bin/node","sha256":"18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572","sizeBytes":112937728,"executable":true,"normalization":"raw"}]}},{"distributionId":"cli:qwen-code-cli:standalone","packageProvenance":"npm_metadata:@qwen-code/qwen-code","version":"0.23.0","architecture":"x64","artifactSha256":"aea7287d1de67b17b13b12f3bc2b80f85f0d46bf95ce02cb04470a11e0296e4d","artifactSizeBytes":79606374,"executableSha256":"1461b5ef9149b86e58ea22ddb9cc0616679437f9ff0011cf7c3c102f94568abf","executableSizeBytes":178,"distributionSha256":"10197c89c2f59667ae2fcf70d6d180a3f4dedc6a16e86a5d77fbab94a218f663","distributionSizeBytes":291802961,"portableFingerprintSchema":"qwen-standalone-surface-v1","portableArtifactFingerprint":"dff32edbbeca8db923b5e9385f0ff13e373944528fa41f2f439ce17bc528d4f7","signedCode":null,"npmPackage":{"integrity":null,"ownedPackageSha256":"10197c89c2f59667ae2fcf70d6d180a3f4dedc6a16e86a5d77fbab94a218f663","ownedEntryCount":5808,"ownedTotalBytes":291802961,"proofNodes":[{"role":"qwen_launcher","relativePath":"bin/qwen","sha256":"1461b5ef9149b86e58ea22ddb9cc0616679437f9ff0011cf7c3c102f94568abf","sizeBytes":178,"executable":true,"normalization":"qwen_relative_root_v1"},{"role":"package_manifest","relativePath":"package.json","sha256":"414e77bb1e872144bf5c38a92e10532fdcabe8c2b055123228c7539491c3c461","sizeBytes":10565,"executable":false,"normalization":"raw"},{"role":"qwen_standalone_manifest","relativePath":"manifest.json","sha256":"45065573d1156e553031721f7eb6d607e4abfe7efda8dbd637984c274586eddf","sizeBytes":202,"executable":false,"normalization":"raw"},{"role":"qwen_cli_entry","relativePath":"lib/cli-entry.js","sha256":"68cb29eb7ccc936d78ece5564ef55cae41a55b630e6657dc417c1f2e561cf4c9","sizeBytes":13895,"executable":true,"normalization":"raw"},{"role":"qwen_node_runtime","relativePath":"node/bin/node","sha256":"0b4f059915f3bf3c6cbb02422f4a529bfb21cbbec2d29851c9a5d833f78a04f6","sizeBytes":115440320,"executable":true,"normalization":"raw"}]}},{"distributionId":"cli:qwen-code-cli:npm-global","packageProvenance":"npm_metadata:@qwen-code/qwen-code","version":"0.23.0","architecture":"arm64","artifactSha256":"1ca5d9816557f2fea58570aab5c9638fb6252b77abad6a36245dd7eced413e27","artifactSizeBytes":26987337,"executableSha256":"68cb29eb7ccc936d78ece5564ef55cae41a55b630e6657dc417c1f2e561cf4c9","executableSizeBytes":13895,"distributionSha256":"b6799979531fa6b047e59681c095fe57990fb7b492a687d0fcc8ea13007f1780","distributionSizeBytes":102034799,"portableFingerprintSchema":"npm-owned-package-surface-v1","portableArtifactFingerprint":"eb8fd16bf83058f2792f95b056d851497b9712637365a2e6a378571195552513","signedCode":null,"npmPackage":{"integrity":"sha512-foznQtmptzM7DtYGPALZVtwUBVTsANYc6ytWOfGisXB7FgpzNmYT6xIHzh+26RJD9Kl+qzRW0gFp/AkqRouhnQ==","ownedPackageSha256":"b6799979531fa6b047e59681c095fe57990fb7b492a687d0fcc8ea13007f1780","ownedEntryCount":1023,"ownedTotalBytes":102034799,"proofNodes":[{"role":"npm_package_executable","relativePath":"cli-entry.js","sha256":"68cb29eb7ccc936d78ece5564ef55cae41a55b630e6657dc417c1f2e561cf4c9","sizeBytes":13895,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"3dfbff61d62b6238e6e94358cd29c814f117055297da6bd0b58af2b86dfc6c88","sizeBytes":1386,"executable":false,"normalization":"raw"}]}},{"distributionId":"cli:qwen-code-cli:npm-global","packageProvenance":"npm_metadata:@qwen-code/qwen-code","version":"0.23.0","architecture":"x64","artifactSha256":"1ca5d9816557f2fea58570aab5c9638fb6252b77abad6a36245dd7eced413e27","artifactSizeBytes":26987337,"executableSha256":"68cb29eb7ccc936d78ece5564ef55cae41a55b630e6657dc417c1f2e561cf4c9","executableSizeBytes":13895,"distributionSha256":"b6799979531fa6b047e59681c095fe57990fb7b492a687d0fcc8ea13007f1780","distributionSizeBytes":102034799,"portableFingerprintSchema":"npm-owned-package-surface-v1","portableArtifactFingerprint":"eb8fd16bf83058f2792f95b056d851497b9712637365a2e6a378571195552513","signedCode":null,"npmPackage":{"integrity":"sha512-foznQtmptzM7DtYGPALZVtwUBVTsANYc6ytWOfGisXB7FgpzNmYT6xIHzh+26RJD9Kl+qzRW0gFp/AkqRouhnQ==","ownedPackageSha256":"b6799979531fa6b047e59681c095fe57990fb7b492a687d0fcc8ea13007f1780","ownedEntryCount":1023,"ownedTotalBytes":102034799,"proofNodes":[{"role":"npm_package_executable","relativePath":"cli-entry.js","sha256":"68cb29eb7ccc936d78ece5564ef55cae41a55b630e6657dc417c1f2e561cf4c9","sizeBytes":13895,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"3dfbff61d62b6238e6e94358cd29c814f117055297da6bd0b58af2b86dfc6c88","sizeBytes":1386,"executable":false,"normalization":"raw"}]}}],"observedExactVersions":["0.23.0"],"releaseAcceptedExactVersions":["0.23.0"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","pre_compact","session_end"],"require":"all"},"releaseMode":"production"}),
  release('zcode-desktop', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["mcp"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["hook"],"reload":"new_session"}],"officialDistributions":[{"channel":"signed_app","distributionId":"dev.zcode.app","packageProvenance":"signed_app:dev.zcode.app:8A5X4JJ39T","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"dev.zcode.app","packageProvenance":"signed_app:dev.zcode.app:8A5X4JJ39T","version":"3.11.2","architecture":"arm64","artifactSha256":"cfa43b90ec74732ee3ee1262803d775658a3c954cc4cc0a9a1bec0f9c6dcbf98","artifactSizeBytes":235528887,"executableSha256":"a6fbb0f6229efd80d9e6216e21ef33e52b3e75e10cb6372ac26fc9166a60b253","executableSizeBytes":52944,"distributionSha256":"c7066487fd3c0f3889d599b563fc71433aac18609e39a894d320d87ef9e32143","distributionSizeBytes":718037199,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"6ca9da8812bf7d77dd071444047ab2ca04287cc0c4a65b1f052a51938e3fcd68","signedCode":{"identifier":"dev.zcode.app","teamIdentifier":"8A5X4JJ39T","cdhash":"1f2e6ca517c559242414ac984c279d483bfeb7c9","designatedRequirement":"identifier \"dev.zcode.app\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"8A5X4JJ39T\""},"npmPackage":null},{"distributionId":"dev.zcode.app","packageProvenance":"signed_app:dev.zcode.app:8A5X4JJ39T","version":"3.11.2","architecture":"x64","artifactSha256":"12cf306271a6bfb5f4100b9c735e07a22912051d27af845f98064495e41fd736","artifactSizeBytes":247752845,"executableSha256":"9a30037887399bd9590a642d4b20b010617096867994d8f62368cf973353be1c","executableSizeBytes":32512,"distributionSha256":"7f060a9cc93f6c9b581e6cb5576ffce0fc99777a081d3afd8bb38cef813dc9f7","distributionSizeBytes":735106283,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"6bd1d384dead263aa830539d6318d1ff598aae7674f11814047cd1cc7ab29c5e","signedCode":{"identifier":"dev.zcode.app","teamIdentifier":"8A5X4JJ39T","cdhash":"4f599b6af91ba14322ddcd4855fc06ac3c32d6f2","designatedRequirement":"identifier \"dev.zcode.app\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"8A5X4JJ39T\""},"npmPackage":null}],"observedExactVersions":["3.11.2"],"releaseAcceptedExactVersions":["3.11.2"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start"],"require":"all"},"releaseMode":"production"}),
  observeOnly('zcode-cli', 'Non-official same-named CLI; discovery diagnostics only.', {"components":[],"officialDistributions":[],"acceptedDistributionArtifacts":[],"observedExactVersions":[],"releaseAcceptedExactVersions":[],"activation":{"mode":"none","requiresUserConfirmation":false},"requiredLifecycle":null,"releaseMode":"detect_only"}),
  release('opencode-v1-cli', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["mcp"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["plugin"],"reload":"restart_host"}],"officialDistributions":[{"channel":"npm","distributionId":"cli:opencode-v1-cli:darwin-arm64","packageProvenance":"npm_metadata:opencode-ai","supportedMacArchitectures":["arm64"]},{"channel":"npm","distributionId":"cli:opencode-v1-cli:darwin-x64","packageProvenance":"npm_metadata:opencode-ai","supportedMacArchitectures":["x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"cli:opencode-v1-cli:darwin-arm64","packageProvenance":"npm_metadata:opencode-ai","version":"1.18.29","architecture":"arm64","artifactSha256":"bec74d1c33582ac16489e524d947f4f1f02ee0eadc6053577d66b32f7034a5be","artifactSizeBytes":3047,"executableSha256":"2f24593f1b8e578d0b7ed7ca399440d4b6c125330eece20a69ad8d380190d669","executableSizeBytes":144107234,"distributionSha256":"04db48c440f3f3275f1527e56255204d5f9194ac71df12953a85b1fe1fee6c08","distributionSizeBytes":288221998,"portableFingerprintSchema":"npm-composed-platform-surface-v1","portableArtifactFingerprint":"0d5385be21d96375cdd014d3289d7f626e497885933cdd63849370fc94b26f83","signedCode":null,"npmPackage":{"integrity":"sha512-syIDVwlrYTgTOXzZe9SkInJWethbq6l3SNC762UeXyO0a9V0wGfd+U4yACvppwNBnhIsl0j2QPYYCyLpNaSomg==","ownedPackageSha256":"d7f617e650d550c53bb24a91839431cf081690ddc17414b5afbef7adf001ee72","ownedEntryCount":4,"ownedTotalBytes":144114620,"proofNodes":[{"role":"npm_package_executable","relativePath":"bin/opencode.exe","sha256":"2f24593f1b8e578d0b7ed7ca399440d4b6c125330eece20a69ad8d380190d669","sizeBytes":144107234,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"946672283f1e84ef0477d3d5a1771c6fad2456c4b86ca03aa144fefdf2ebf89a","sizeBytes":825,"executable":true,"normalization":"raw"}],"composition":{"entryRule":"copy_platform_binary_v1","components":[{"role":"platform_leaf","installName":"opencode-darwin-arm64","manifestName":"opencode-darwin-arm64","version":"1.18.29","integrity":"sha512-EU0qma5GPJXcDp5rENvedSfqJjqxatQW/Qzjs71pR2YdbrSh7YmBwtvnIb2/KIvfQr0DErX4ST14sbBQI2mQdg==","ownedPackageSha256":"9e718e4eb049abd7dfb3b85d5363b16f3fefa916ad09b5ad33c9d3cfe847aaa5","ownedEntryCount":2,"ownedTotalBytes":144107378,"nativeExecutableRelativePath":"bin/opencode","nativeExecutableSha256":"2f24593f1b8e578d0b7ed7ca399440d4b6c125330eece20a69ad8d380190d669","nativeExecutableSizeBytes":144107234,"artifactSha256":"1fc08fee8b4984c1306c826b8c0e2c367fd9eeb4d4c3707469194e3fea047e72","artifactSizeBytes":45944097}]}}},{"distributionId":"cli:opencode-v1-cli:darwin-x64","packageProvenance":"npm_metadata:opencode-ai","version":"1.18.29","architecture":"x64","artifactSha256":"bec74d1c33582ac16489e524d947f4f1f02ee0eadc6053577d66b32f7034a5be","artifactSizeBytes":3047,"executableSha256":"7948c14eb43f5bb82fc8a2dc617092d5702e100443e81cbb57989ba4b69cb314","executableSizeBytes":149586000,"distributionSha256":"eee3b02f36902a744ed94237ba8bf816ae51df83ceef3ecbf6763efc037b31fe","distributionSizeBytes":448765675,"portableFingerprintSchema":"npm-composed-platform-surface-v1","portableArtifactFingerprint":"8958750e2256a7040763ad3100997257fe14979333b04355dad0ff2dd9ba9979","signedCode":null,"npmPackage":{"integrity":"sha512-syIDVwlrYTgTOXzZe9SkInJWethbq6l3SNC762UeXyO0a9V0wGfd+U4yACvppwNBnhIsl0j2QPYYCyLpNaSomg==","ownedPackageSha256":"ef93f3691d024125254f80a8ef5c5add49ec82cb24ef1f957ede850d5f1605e8","ownedEntryCount":4,"ownedTotalBytes":149593386,"proofNodes":[{"role":"npm_package_executable","relativePath":"bin/opencode.exe","sha256":"7948c14eb43f5bb82fc8a2dc617092d5702e100443e81cbb57989ba4b69cb314","sizeBytes":149586000,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"946672283f1e84ef0477d3d5a1771c6fad2456c4b86ca03aa144fefdf2ebf89a","sizeBytes":825,"executable":true,"normalization":"raw"}],"composition":{"entryRule":"copy_platform_binary_v1","components":[{"role":"platform_leaf","installName":"opencode-darwin-x64","manifestName":"opencode-darwin-x64","version":"1.18.29","integrity":"sha512-Soyw5WI5kRI3Wbk5eeuSkMw4x+ScXi3SqzITMsi6rnVX0hsAbFCOmKOieYcd8BKJ1aUTrrG0Vv556CFzekk5Bw==","ownedPackageSha256":"3f0e407e46853ea6c7f3ee32df8cb58384aa8ad0245f326a7e785dfbe5aef4c1","ownedEntryCount":2,"ownedTotalBytes":149586140,"nativeExecutableRelativePath":"bin/opencode","nativeExecutableSha256":"7948c14eb43f5bb82fc8a2dc617092d5702e100443e81cbb57989ba4b69cb314","nativeExecutableSizeBytes":149586000,"artifactSha256":"d9e2270b9040d7ce140df629773c68f15222c7a6c882f16921d36aa4c9200ae2","artifactSizeBytes":48120807},{"role":"platform_leaf","installName":"opencode-darwin-x64-baseline","manifestName":"opencode-darwin-x64-baseline","version":"1.18.29","integrity":"sha512-LJAQWZd4Tixo/IYCM3qYDk+h+OydkcZY6ywL99K67acJzfiAmfzqDKUi7WuQkMrlTCSPoOxkyz3yTPd0GzVeXw==","ownedPackageSha256":"c22701682f962fa96ec67fcfd7c03d95596936f4c636faf5472a0316997c048c","ownedEntryCount":2,"ownedTotalBytes":149586149,"nativeExecutableRelativePath":"bin/opencode","nativeExecutableSha256":"7948c14eb43f5bb82fc8a2dc617092d5702e100443e81cbb57989ba4b69cb314","nativeExecutableSizeBytes":149586000,"artifactSha256":"e3beb82c27a193caf6c000f3376e68c70e2876056cb5c23887bd0e4ba7ef86bc","artifactSizeBytes":48120858}]}}}],"observedExactVersions":["1.18.29"],"releaseAcceptedExactVersions":["1.18.29"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","pre_compact","post_compact"],"require":"all"},"releaseMode":"production"}),
  release('opencode-v2-beta-cli', 'guided', 3, CORE_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["mcp"],"reload":"new_session"}],"officialDistributions":[{"channel":"npm","distributionId":"cli:opencode-v2-beta-cli:darwin-arm64","packageProvenance":"npm_metadata:@opencode-ai/cli","supportedMacArchitectures":["arm64"]},{"channel":"npm","distributionId":"cli:opencode-v2-beta-cli:darwin-x64","packageProvenance":"npm_metadata:@opencode-ai/cli","supportedMacArchitectures":["x64"]},{"channel":"npm","distributionId":"cli:opencode-v2-beta-cli:darwin-x64-baseline","packageProvenance":"npm_metadata:@opencode-ai/cli","supportedMacArchitectures":["x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"cli:opencode-v2-beta-cli:darwin-arm64","packageProvenance":"npm_metadata:@opencode-ai/cli","version":"0.0.0-beta-19157","architecture":"arm64","artifactSha256":"2f1b960665898052b2596fd1a04ed65c0189d9aaf10f38a1cad68420c25b5311","artifactSizeBytes":2399,"executableSha256":"bb55c6d6be96f46464bf5871b763447b0d5652b6e94b951daf51c03bb412871b","executableSizeBytes":183510624,"distributionSha256":"2087bc27841894e5d4704890f120106d342992a9fb58661b54786bf74d8e5ceb","distributionSizeBytes":367028186,"portableFingerprintSchema":"npm-composed-platform-surface-v1","portableArtifactFingerprint":"2f800a5d5999fd8d62ef0495d5d9f8e8061eb3f2e885c944fe7940b4e86e2e66","signedCode":null,"npmPackage":{"integrity":"sha512-VqMfY/gEP/iWCfg9HZKr7pBYviHvFBLNIQveVKN47eN/WUpZ4tXap7cSIxzP+FmR9Q3lEzsMs034PBqf2E9I7Q==","ownedPackageSha256":"eb4e36291dd1fcf787ab4e70bb8f52fd3e9ccd875dd6a944dd6ccf8875d5fd00","ownedEntryCount":3,"ownedTotalBytes":183517307,"proofNodes":[{"role":"npm_package_executable","relativePath":"bin/opencode2.exe","sha256":"bb55c6d6be96f46464bf5871b763447b0d5652b6e94b951daf51c03bb412871b","sizeBytes":183510624,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"446f90aacafa0cee1f7d964c17dfafef6f3606c4f7d3618d3d7c19297020e743","sizeBytes":1146,"executable":true,"normalization":"raw"}],"composition":{"entryRule":"copy_platform_binary_v1","components":[{"role":"platform_leaf","installName":"@opencode-ai/cli-darwin-arm64","manifestName":"@opencode-ai/cli-darwin-arm64","version":"0.0.0-beta-19157","integrity":"sha512-xvBOdbTlMycd5BIwrNJARVqSkKxX+agnA2Kg3nNeodmRJaQZufYhmQezNBPQx+lf5dF5iCDQLOTWJSq95N7Qwg==","ownedPackageSha256":"f49b5fcdac680d7535ebe447f1a070252a63af88e3ab6c89a883ca9c0cf02aba","ownedEntryCount":2,"ownedTotalBytes":183510879,"nativeExecutableRelativePath":"bin/opencode2","nativeExecutableSha256":"bb55c6d6be96f46464bf5871b763447b0d5652b6e94b951daf51c03bb412871b","nativeExecutableSizeBytes":183510624,"artifactSha256":"dbc2e790ba1b8487db9ee1cc9c3175198f72f424a736e9341c5e1f77384e7d19","artifactSizeBytes":77611295}]}}},{"distributionId":"cli:opencode-v2-beta-cli:darwin-x64","packageProvenance":"npm_metadata:@opencode-ai/cli","version":"0.0.0-beta-19157","architecture":"x64","artifactSha256":"2f1b960665898052b2596fd1a04ed65c0189d9aaf10f38a1cad68420c25b5311","artifactSizeBytes":2399,"executableSha256":"fd792d52b6219876e3d9aeb8a5f217476d5f7f9005bfac7aab8b3a2ebb832bbe","executableSizeBytes":195253792,"distributionSha256":"402d3c8976aff5b941e5c2df06cb4791126ecd59ec93cf0d17ec917f94fba78f","distributionSizeBytes":585768570,"portableFingerprintSchema":"npm-composed-platform-surface-v1","portableArtifactFingerprint":"bb786d9fce5f5da7427e7e08dcf9ac87f8897c9b6a4dbfd7a4522e4552300a70","signedCode":null,"npmPackage":{"integrity":"sha512-VqMfY/gEP/iWCfg9HZKr7pBYviHvFBLNIQveVKN47eN/WUpZ4tXap7cSIxzP+FmR9Q3lEzsMs034PBqf2E9I7Q==","ownedPackageSha256":"845e6a3c19b59bd476aefea9d61b0a1010b4ccb4d3de073c47608477e77f188d","ownedEntryCount":3,"ownedTotalBytes":195260475,"proofNodes":[{"role":"npm_package_executable","relativePath":"bin/opencode2.exe","sha256":"fd792d52b6219876e3d9aeb8a5f217476d5f7f9005bfac7aab8b3a2ebb832bbe","sizeBytes":195253792,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"446f90aacafa0cee1f7d964c17dfafef6f3606c4f7d3618d3d7c19297020e743","sizeBytes":1146,"executable":true,"normalization":"raw"}],"composition":{"entryRule":"copy_platform_binary_v1","components":[{"role":"platform_leaf","installName":"@opencode-ai/cli-darwin-x64","manifestName":"@opencode-ai/cli-darwin-x64","version":"0.0.0-beta-19157","integrity":"sha512-xygwOBjrRmMAG3EBmY5dko6uTHxeaRYU4r5Lnw9s3OsfYYPcDRwKYRSW/90Faf0XvZWuvq1PEOSZqOlGrM31fQ==","ownedPackageSha256":"f3bd03fd121b9976aea95febece2968df9c4696452db902917be058b6eb7c6f7","ownedEntryCount":2,"ownedTotalBytes":195254043,"nativeExecutableRelativePath":"bin/opencode2","nativeExecutableSha256":"fd792d52b6219876e3d9aeb8a5f217476d5f7f9005bfac7aab8b3a2ebb832bbe","nativeExecutableSizeBytes":195253792,"artifactSha256":"63d680c6cb0fbdf04daadd1e23955f7ae2ccbd225c8ba82efc6a390d85ee1dc0","artifactSizeBytes":82615392},{"role":"platform_leaf","installName":"@opencode-ai/cli-darwin-x64-baseline","manifestName":"@opencode-ai/cli-darwin-x64-baseline","version":"0.0.0-beta-19157","integrity":"sha512-XO3eAUlF6PDOHcdn5DqojeEBoubwG24VDPRNFt9sZiJmfVDAwddcMzfvNVgAPxCH0TM/NGTaaIRSKs5hKiOf5g==","ownedPackageSha256":"56333f7492d22135d582931a7cbdf77de2a80a1941e7fc0115a87ddcdf8474b9","ownedEntryCount":2,"ownedTotalBytes":195254052,"nativeExecutableRelativePath":"bin/opencode2","nativeExecutableSha256":"5ae72237cc21fd075a2628fd5392cea2f2b4f7332d76ab96cceb03360b62c2a0","nativeExecutableSizeBytes":195253792,"artifactSha256":"29fc9bf7e0ecae83b44bf4fd3153b2367022b8bf3265b5ac2d56f43f5dbca1f1","artifactSizeBytes":82615378}]}}},{"distributionId":"cli:opencode-v2-beta-cli:darwin-x64-baseline","packageProvenance":"npm_metadata:@opencode-ai/cli","version":"0.0.0-beta-19157","architecture":"x64","artifactSha256":"2f1b960665898052b2596fd1a04ed65c0189d9aaf10f38a1cad68420c25b5311","artifactSizeBytes":2399,"executableSha256":"5ae72237cc21fd075a2628fd5392cea2f2b4f7332d76ab96cceb03360b62c2a0","executableSizeBytes":195253792,"distributionSha256":"32fd92fe0ac6b7ab4f04efd54cd0da3090f5bea306659a29364c436091a3c674","distributionSizeBytes":585768570,"portableFingerprintSchema":"npm-composed-platform-surface-v1","portableArtifactFingerprint":"498342fc488f992dcfc92d6deaac4d00a5a2e9f40472b5b7e6cf8efd8161ef7a","signedCode":null,"npmPackage":{"integrity":"sha512-VqMfY/gEP/iWCfg9HZKr7pBYviHvFBLNIQveVKN47eN/WUpZ4tXap7cSIxzP+FmR9Q3lEzsMs034PBqf2E9I7Q==","ownedPackageSha256":"fcf7657079396c2fbf2f41460710813f9b1d76f6c70773dae27ec7e49c991016","ownedEntryCount":3,"ownedTotalBytes":195260475,"proofNodes":[{"role":"npm_package_executable","relativePath":"bin/opencode2.exe","sha256":"5ae72237cc21fd075a2628fd5392cea2f2b4f7332d76ab96cceb03360b62c2a0","sizeBytes":195253792,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"446f90aacafa0cee1f7d964c17dfafef6f3606c4f7d3618d3d7c19297020e743","sizeBytes":1146,"executable":true,"normalization":"raw"}],"composition":{"entryRule":"copy_platform_binary_v1","components":[{"role":"platform_leaf","installName":"@opencode-ai/cli-darwin-x64","manifestName":"@opencode-ai/cli-darwin-x64","version":"0.0.0-beta-19157","integrity":"sha512-xygwOBjrRmMAG3EBmY5dko6uTHxeaRYU4r5Lnw9s3OsfYYPcDRwKYRSW/90Faf0XvZWuvq1PEOSZqOlGrM31fQ==","ownedPackageSha256":"f3bd03fd121b9976aea95febece2968df9c4696452db902917be058b6eb7c6f7","ownedEntryCount":2,"ownedTotalBytes":195254043,"nativeExecutableRelativePath":"bin/opencode2","nativeExecutableSha256":"fd792d52b6219876e3d9aeb8a5f217476d5f7f9005bfac7aab8b3a2ebb832bbe","nativeExecutableSizeBytes":195253792,"artifactSha256":"63d680c6cb0fbdf04daadd1e23955f7ae2ccbd225c8ba82efc6a390d85ee1dc0","artifactSizeBytes":82615392},{"role":"platform_leaf","installName":"@opencode-ai/cli-darwin-x64-baseline","manifestName":"@opencode-ai/cli-darwin-x64-baseline","version":"0.0.0-beta-19157","integrity":"sha512-XO3eAUlF6PDOHcdn5DqojeEBoubwG24VDPRNFt9sZiJmfVDAwddcMzfvNVgAPxCH0TM/NGTaaIRSKs5hKiOf5g==","ownedPackageSha256":"56333f7492d22135d582931a7cbdf77de2a80a1941e7fc0115a87ddcdf8474b9","ownedEntryCount":2,"ownedTotalBytes":195254052,"nativeExecutableRelativePath":"bin/opencode2","nativeExecutableSha256":"5ae72237cc21fd075a2628fd5392cea2f2b4f7332d76ab96cceb03360b62c2a0","nativeExecutableSizeBytes":195253792,"artifactSha256":"29fc9bf7e0ecae83b44bf4fd3153b2367022b8bf3265b5ac2d56f43f5dbca1f1","artifactSizeBytes":82615378}]}}}],"observedExactVersions":["0.0.0-beta-19157"],"releaseAcceptedExactVersions":["0.0.0-beta-19157"],"activation":{"mode":"user_guided","requiresUserConfirmation":false},"requiredLifecycle":null,"releaseMode":"production"}),
  release('pi-official-cli', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["plugin","skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["plugin"],"reload":"new_session"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["plugin"],"reload":"new_session"}],"officialDistributions":[{"channel":"npm","distributionId":"pi-official:@earendil-works/pi-coding-agent","packageProvenance":"npm_metadata:@earendil-works/pi-coding-agent","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"pi-official:@earendil-works/pi-coding-agent","packageProvenance":"npm_metadata:@earendil-works/pi-coding-agent","version":"0.85.1","architecture":"arm64","artifactSha256":"1f498729649bdce647d1160993b4d92bf3c614cc819213bee2f91dd34f2a7af4","artifactSizeBytes":6986356,"executableSha256":"e6d7fcf36a239cf3746e67ddf4222081ac01a601b85a3ee688bdfe9c161d754c","executableSizeBytes":660,"distributionSha256":"a1af8ad81755be8a3b7bcbf87bb17c2585b8ba88624d179454f921628d490342","distributionSizeBytes":21935887,"portableFingerprintSchema":"npm-owned-package-surface-v1","portableArtifactFingerprint":"17d473e46896c16a391695dafc9d09e0ae91a482ab324d391002107a59c96ec5","signedCode":null,"npmPackage":{"integrity":"sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==","ownedPackageSha256":"a1af8ad81755be8a3b7bcbf87bb17c2585b8ba88624d179454f921628d490342","ownedEntryCount":1056,"ownedTotalBytes":21935887,"proofNodes":[{"role":"npm_package_executable","relativePath":"dist/bundle/cli.js","sha256":"e6d7fcf36a239cf3746e67ddf4222081ac01a601b85a3ee688bdfe9c161d754c","sizeBytes":660,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"f1738e4b42203e5f22bcb513f13fb2fb224f1e98d1f129ff042f87048665a94c","sizeBytes":4145,"executable":false,"normalization":"raw"}]}},{"distributionId":"pi-official:@earendil-works/pi-coding-agent","packageProvenance":"npm_metadata:@earendil-works/pi-coding-agent","version":"0.85.1","architecture":"x64","artifactSha256":"1f498729649bdce647d1160993b4d92bf3c614cc819213bee2f91dd34f2a7af4","artifactSizeBytes":6986356,"executableSha256":"e6d7fcf36a239cf3746e67ddf4222081ac01a601b85a3ee688bdfe9c161d754c","executableSizeBytes":660,"distributionSha256":"a1af8ad81755be8a3b7bcbf87bb17c2585b8ba88624d179454f921628d490342","distributionSizeBytes":21935887,"portableFingerprintSchema":"npm-owned-package-surface-v1","portableArtifactFingerprint":"17d473e46896c16a391695dafc9d09e0ae91a482ab324d391002107a59c96ec5","signedCode":null,"npmPackage":{"integrity":"sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==","ownedPackageSha256":"a1af8ad81755be8a3b7bcbf87bb17c2585b8ba88624d179454f921628d490342","ownedEntryCount":1056,"ownedTotalBytes":21935887,"proofNodes":[{"role":"npm_package_executable","relativePath":"dist/bundle/cli.js","sha256":"e6d7fcf36a239cf3746e67ddf4222081ac01a601b85a3ee688bdfe9c161d754c","sizeBytes":660,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"f1738e4b42203e5f22bcb513f13fb2fb224f1e98d1f129ff042f87048665a94c","sizeBytes":4145,"executable":false,"normalization":"raw"}]}}],"observedExactVersions":["0.85.1"],"releaseAcceptedExactVersions":["0.85.1"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","pre_compact","post_compact","session_end"],"require":"all"},"releaseMode":"production"}),
  release('omp-cli', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"managed","artifactTypes":["mcp"],"reload":"reload"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["plugin"],"reload":"restart_host"}],"officialDistributions":[{"channel":"npm","distributionId":"omp:oh-my-pi","packageProvenance":"npm_metadata:@oh-my-pi/pi-coding-agent","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"omp:oh-my-pi","packageProvenance":"npm_metadata:@oh-my-pi/pi-coding-agent","version":"18.1.11","architecture":"arm64","artifactSha256":"3300efbee331a0e40d3837f4a945353a7f83b393d3cb2ba5fe13a7fdb2f3d891","artifactSizeBytes":11628074,"executableSha256":"bdcd8dd8aba883f6a3043155a3d5799db60ba1ebe5531bdb05e0706a15f8f15e","executableSizeBytes":21345008,"distributionSha256":"1c2af0df1225cf4223744d10750d09160b2799bb3773f48dbef1374d66368280","distributionSizeBytes":214745193,"portableFingerprintSchema":"npm-composed-platform-surface-v1","portableArtifactFingerprint":"365133903f1e3759fa1e6ecf3af88896939876bd650012744e40e4536946a6cb","signedCode":null,"npmPackage":{"integrity":"sha512-eB/AV4QG2Vm2McCGSy81XtIS4qLVEZ2P2b8v2zApUoXzOgtMmBR4MRS8+PrJ3Ah2C461iKJ2SXBlVBot0JG7wQ==","ownedPackageSha256":"abf38e29af804a5908c43cf9b6c4750078b3579f37dfbfb6de1562439ded0fcd","ownedEntryCount":3106,"ownedTotalBytes":47991128,"proofNodes":[{"role":"npm_package_executable","relativePath":"dist/cli.js","sha256":"bdcd8dd8aba883f6a3043155a3d5799db60ba1ebe5531bdb05e0706a15f8f15e","sizeBytes":21345008,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"012044209888e96c77ad3d01409e77f5028567b2b34599ae7e226e461cba1d0f","sizeBytes":17744,"executable":false,"normalization":"raw"}],"composition":{"entryRule":"js_entry_loads_platform_native_v1","components":[{"role":"platform_selector","installName":"@oh-my-pi/pi-natives","manifestName":"@oh-my-pi/pi-natives","version":"18.1.11","integrity":"sha512-MViONJTjl90c22FVT+H+vxU+N2yDohYH2BxLqBY4BC6aU/iu6yeqN2dg3FvyfJEvYLM5DmNahyZldHOpp+A73A==","ownedPackageSha256":"819919cc985a21e599cc37bc57b0f2d7caf63ed880c51e38652459255048a35c","ownedEntryCount":17,"ownedTotalBytes":1256741,"nativeExecutableRelativePath":null,"nativeExecutableSha256":null,"nativeExecutableSizeBytes":null,"artifactSha256":"dbb505801e0640d1fee86b88bd5bd8de440a6ef8c9045573c39206fec0a9601b","artifactSizeBytes":144784},{"role":"platform_leaf","installName":"@oh-my-pi/pi-natives-darwin-arm64","manifestName":"@oh-my-pi/pi-natives-darwin-arm64","version":"18.1.11","integrity":"sha512-yPkszRGDp77ILtG/QyCu40t7OoqFNMZolDb7f4PIHwOJOa468JnscHpHEbmuH0D6jk0/HiRBc9HWLh9hd6gEPg==","ownedPackageSha256":"748db785e6ccc14fbaf3d7cf32add656a128c33f0d0c557de0571fe80bc1ed31","ownedEntryCount":5,"ownedTotalBytes":165497324,"nativeExecutableRelativePath":"pi_natives.darwin-arm64.node","nativeExecutableSha256":"78056e134fb3c6b820f086866c9f3504c7ac5bad107a9bb7117308b77d3e3f0f","nativeExecutableSizeBytes":164418448,"artifactSha256":"40e3a0071adaefbde3b4b906882ae5138be98c3179ea7410808d18ea4d5a0214","artifactSizeBytes":37157307}]}}},{"distributionId":"omp:oh-my-pi","packageProvenance":"npm_metadata:@oh-my-pi/pi-coding-agent","version":"18.1.11","architecture":"x64","artifactSha256":"3300efbee331a0e40d3837f4a945353a7f83b393d3cb2ba5fe13a7fdb2f3d891","artifactSizeBytes":11628074,"executableSha256":"bdcd8dd8aba883f6a3043155a3d5799db60ba1ebe5531bdb05e0706a15f8f15e","executableSizeBytes":21345008,"distributionSha256":"0f601e92331a15b8f754ed3beef88387c4964161dcd8ee1975e38c1fc1286793","distributionSizeBytes":218200336,"portableFingerprintSchema":"npm-composed-platform-surface-v1","portableArtifactFingerprint":"68e37bdfd5bf54fea3e322438d77a6c3c69c12e23d804f85b9dfbb94f499d11b","signedCode":null,"npmPackage":{"integrity":"sha512-eB/AV4QG2Vm2McCGSy81XtIS4qLVEZ2P2b8v2zApUoXzOgtMmBR4MRS8+PrJ3Ah2C461iKJ2SXBlVBot0JG7wQ==","ownedPackageSha256":"abf38e29af804a5908c43cf9b6c4750078b3579f37dfbfb6de1562439ded0fcd","ownedEntryCount":3106,"ownedTotalBytes":47991128,"proofNodes":[{"role":"npm_package_executable","relativePath":"dist/cli.js","sha256":"bdcd8dd8aba883f6a3043155a3d5799db60ba1ebe5531bdb05e0706a15f8f15e","sizeBytes":21345008,"executable":true,"normalization":"raw"},{"role":"package_manifest","relativePath":"package.json","sha256":"012044209888e96c77ad3d01409e77f5028567b2b34599ae7e226e461cba1d0f","sizeBytes":17744,"executable":false,"normalization":"raw"}],"composition":{"entryRule":"js_entry_loads_platform_native_v1","components":[{"role":"platform_selector","installName":"@oh-my-pi/pi-natives","manifestName":"@oh-my-pi/pi-natives","version":"18.1.11","integrity":"sha512-MViONJTjl90c22FVT+H+vxU+N2yDohYH2BxLqBY4BC6aU/iu6yeqN2dg3FvyfJEvYLM5DmNahyZldHOpp+A73A==","ownedPackageSha256":"819919cc985a21e599cc37bc57b0f2d7caf63ed880c51e38652459255048a35c","ownedEntryCount":17,"ownedTotalBytes":1256741,"nativeExecutableRelativePath":null,"nativeExecutableSha256":null,"nativeExecutableSizeBytes":null,"artifactSha256":"dbb505801e0640d1fee86b88bd5bd8de440a6ef8c9045573c39206fec0a9601b","artifactSizeBytes":144784},{"role":"platform_leaf","installName":"@oh-my-pi/pi-natives-darwin-x64","manifestName":"@oh-my-pi/pi-natives-darwin-x64","version":"18.1.11","integrity":"sha512-LVvb4EfJGSiQvEk9R7d2DSUPqK9btl6svazuutrQC9BfdNVQdWJquY7nzXYhXq06pMQMm3sdsGvEeoiKUC55Fg==","ownedPackageSha256":"4ff27ff2ebdbefa8356aaeba540e2aaecd5cdcc99454c6b8aaac05dbaad19189","ownedEntryCount":5,"ownedTotalBytes":168952467,"nativeExecutableRelativePath":"pi_natives.darwin-x64-baseline.node","nativeExecutableSha256":"4b939900babecf9a9d325fd8cc546c71f6f490149df68723ad89cafe76e2b2ac","nativeExecutableSizeBytes":167873592,"artifactSha256":"f327259956c62df3912720c27b2ecb7f96561b5f7c0cb7a9faf59f7a66abd5f3","artifactSizeBytes":38459577}]}}}],"observedExactVersions":["18.1.11"],"releaseAcceptedExactVersions":["18.1.11"],"activation":{"mode":"managed","requiresUserConfirmation":false},"requiredLifecycle":{"signals":["session_start","pre_compact","post_compact","session_end"],"require":"all"},"releaseMode":"production"}),
  release('qwenwork-desktop', 'managed', 4, ALL_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"managed","artifactTypes":["skill"],"reload":"new_session"},{"componentKey":"memory_tools","disposition":"guided","artifactTypes":["mcp"],"reload":"user_confirmation"},{"componentKey":"lifecycle","disposition":"managed","artifactTypes":["hook"],"reload":"restart_host"}],"officialDistributions":[{"channel":"signed_app","distributionId":"cn.qwenwork.desktop.mac","packageProvenance":"signed_app:cn.qwenwork.desktop.mac:XN6U3EV979","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"cn.qwenwork.desktop.mac","packageProvenance":"signed_app:cn.qwenwork.desktop.mac:XN6U3EV979","version":"1.2.0","architecture":"arm64","artifactSha256":"f26cb4c58422558c8ed8d12645999161f80d960c56d1db0123bb478430466c78","artifactSizeBytes":350193195,"executableSha256":"e787455e3106ace770eabcf778b9287fe40201e9029206fa2904959c3c9c1a8e","executableSizeBytes":70032,"distributionSha256":"6e025e7e1632e352c996a8a90a34332a3f86b8c254d9d9ae6ea0223082a67247","distributionSizeBytes":932303869,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"5cd41f3a7008ed00d32920509bf43a1c5d09f23f36c7cbe35ad2a85f0333cb2f","signedCode":{"identifier":"cn.qwenwork.desktop.mac","teamIdentifier":"XN6U3EV979","cdhash":"6ce1ba81906ae6aa6e21fdf3293284de19963a4d","designatedRequirement":"identifier \"cn.qwenwork.desktop.mac\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = XN6U3EV979"},"npmPackage":null},{"distributionId":"cn.qwenwork.desktop.mac","packageProvenance":"signed_app:cn.qwenwork.desktop.mac:XN6U3EV979","version":"1.2.0","architecture":"x64","artifactSha256":"16e9276a4f677a3eb378584bdc2e3fa9c69800295c809ab9190407272fccf5e7","artifactSizeBytes":367437231,"executableSha256":"c57c26429e13c1eaf27432d7043d1f3d8a1f3978f7fda4e5a74d30d103342f90","executableSizeBytes":37312,"distributionSha256":"9e4d6948d73d3aeda167f9b242707f8e8ea8094f2283cc60bd1290d9982995ed","distributionSizeBytes":961657729,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"5ca28711ca9814142ca82a29f5704c493694af5cf5b556d68df27abc076036cc","signedCode":{"identifier":"cn.qwenwork.desktop.mac","teamIdentifier":"XN6U3EV979","cdhash":"0a3505de1901b99ecc2b810698125aa0838c4e21","designatedRequirement":"identifier \"cn.qwenwork.desktop.mac\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = XN6U3EV979"},"npmPackage":null}],"observedExactVersions":["1.2.0"],"releaseAcceptedExactVersions":["1.2.0"],"activation":{"mode":"managed","requiresUserConfirmation":true},"requiredLifecycle":{"signals":["session_start","pre_compact","session_end"],"require":"all"},"releaseMode":"production"}),
  release('claude-cowork-local', 'guided', 3, CORE_COMPONENTS, {"components":[{"componentKey":"instruction","disposition":"guided","artifactTypes":["plugin","skill"],"reload":"user_confirmation"},{"componentKey":"memory_tools","disposition":"guided","artifactTypes":["plugin","mcp"],"reload":"user_confirmation"}],"officialDistributions":[{"channel":"signed_app","distributionId":"com.anthropic.claudefordesktop","packageProvenance":"signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW","supportedMacArchitectures":["arm64","x64"]}],"acceptedDistributionArtifacts":[{"distributionId":"com.anthropic.claudefordesktop","packageProvenance":"signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW","version":"1.46388.3","architecture":"arm64","artifactSha256":"51f3295b33dbbfc7d7314523d6de3b0ae2eee79ed4fdbf91a6c3599f2ef77f6f","artifactSizeBytes":355651318,"executableSha256":"0d02ce9eac32dbc8d809c89ad9b5387c7a23ab4b57c1fcd493e1bf30ce333fbb","executableSizeBytes":120064,"distributionSha256":"35d481fa97ebd3277caedd1ccc6c1ab4dd0d367360e2249ce5e8ac54bd12313f","distributionSizeBytes":865243627,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"f871ef616b3aaa1d53870cd091f3bae60db06bd2e05a1ac27bfe3d2a980073b5","signedCode":{"identifier":"com.anthropic.claudefordesktop","teamIdentifier":"Q6L2SF6YDW","cdhash":"6ec4ee0bb532bec524fff752be901dab2ee38ed7","designatedRequirement":"identifier \"com.anthropic.claudefordesktop\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = Q6L2SF6YDW"},"npmPackage":null},{"distributionId":"com.anthropic.claudefordesktop","packageProvenance":"signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW","version":"1.46388.3","architecture":"x64","artifactSha256":"51f3295b33dbbfc7d7314523d6de3b0ae2eee79ed4fdbf91a6c3599f2ef77f6f","artifactSizeBytes":355651318,"executableSha256":"0d02ce9eac32dbc8d809c89ad9b5387c7a23ab4b57c1fcd493e1bf30ce333fbb","executableSizeBytes":120064,"distributionSha256":"35d481fa97ebd3277caedd1ccc6c1ab4dd0d367360e2249ce5e8ac54bd12313f","distributionSizeBytes":865243627,"portableFingerprintSchema":"signed-code-v1","portableArtifactFingerprint":"f871ef616b3aaa1d53870cd091f3bae60db06bd2e05a1ac27bfe3d2a980073b5","signedCode":{"identifier":"com.anthropic.claudefordesktop","teamIdentifier":"Q6L2SF6YDW","cdhash":"6ec4ee0bb532bec524fff752be901dab2ee38ed7","designatedRequirement":"identifier \"com.anthropic.claudefordesktop\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = Q6L2SF6YDW"},"npmPackage":null}],"observedExactVersions":["1.46388.3"],"releaseAcceptedExactVersions":["1.46388.3"],"activation":{"mode":"user_guided","requiresUserConfirmation":true},"requiredLifecycle":null,"releaseMode":"production"}),
] satisfies readonly AgentReleaseEntry[])

export const AGENT_INTEGRATION_RELEASE_MANIFEST = Object.freeze({
  schemaVersion: AGENT_INTEGRATION_RELEASE_SCHEMA_VERSION,
  appVersion: AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION,
  features: Object.freeze({
    customLocalAgent: Object.freeze({
      enabledByDefault: true,
      modes: Object.freeze(['nonstandard_config_root', 'manual_mcp_client'] as const),
    }),
  }),
  entries: AGENT_INTEGRATION_RELEASE_ENTRIES,
} satisfies AgentIntegrationReleaseManifest)

export const AGENT_INTEGRATION_RELEASE_ENTRY_MAP: ReadonlyMap<CatalogId, AgentReleaseEntry> = new Map(
  AGENT_INTEGRATION_RELEASE_ENTRIES.map(entry => [entry.catalogId, entry]),
)

export function defaultReleasedAdapterIds(): readonly CatalogId[] {
  return AGENT_INTEGRATION_RELEASE_ENTRIES
    .filter(entry => entry.enabledByDefault && entry.releaseMode === 'production')
    .map(entry => entry.catalogId)
}

export function agentReleaseEligibilityReason(
  installation: Pick<DiscoveredInstallation, 'catalogId' | 'detectedVersion' | 'identity'>,
  entry = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get(installation.catalogId),
): AgentReleaseGateReason | null {
  return agentReleaseSurfaceEligibilityReason({
    catalogId: installation.catalogId,
    detectedVersion: installation.detectedVersion,
    distributionId: installation.identity.distribution.distributionId,
    packageProvenance: installation.identity.distribution.packageProvenance,
    architecture: process.arch === 'x64' ? 'x64' : 'arm64',
    portableArtifactFingerprint: installation.identity.distribution.portableArtifactFingerprint,
  }, entry)
}

export function agentReleaseSurfaceEligibilityReason(
  surface: {
    catalogId: CatalogId
    detectedVersion?: string | null
    distributionId?: string | null
    packageProvenance?: string | null
    architecture?: AgentReleaseMacArchitecture | null
    portableArtifactFingerprint?: string | null
  },
  entry = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get(surface.catalogId),
): AgentReleaseGateReason | null {
  if (!entry) return 'release_entry_missing'
  if (entry.releaseMode !== 'production' || entry.disposition === 'observe_only') return 'release_mode_detect_only'
  if (!entry.officialDistributions.some(candidate => (
    candidate.distributionId === surface.distributionId
    && candidate.packageProvenance === surface.packageProvenance
  ))) return 'release_distribution_not_accepted'
  if (!surface.detectedVersion) return 'release_version_unverified'
  if (!entry.releaseAcceptedExactVersions.includes(surface.detectedVersion)) {
    return 'release_version_not_accepted'
  }
  if (!surface.architecture || !surface.portableArtifactFingerprint
    || !entry.acceptedDistributionArtifacts.some(receipt => (
      receipt.distributionId === surface.distributionId
      && receipt.packageProvenance === surface.packageProvenance
      && receipt.version === surface.detectedVersion
      && receipt.architecture === surface.architecture
      && receipt.portableArtifactFingerprint === surface.portableArtifactFingerprint
    ))) return 'release_artifact_not_accepted'
  return null
}

/** Resolve Kimi's version only from one exact frozen signed-binary receipt. */
export function resolveAcceptedKimiNativeReceipt(surface: {
  architecture: AgentReleaseMacArchitecture
  lookupFingerprint: string
}, entry = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get('kimi-code-native')):
AgentReleaseDistributionArtifactReceipt | null {
  if (!entry || entry.catalogId !== 'kimi-code-native'
    || entry.releaseMode !== 'production' || !entry.enabledByDefault) return null
  const candidates = entry.acceptedDistributionArtifacts.filter(receipt => (
    receipt.distributionId === 'cli:kimi-code-native'
    && receipt.packageProvenance === 'signed_cli:kimi:2J9472RW75'
    && receipt.architecture === surface.architecture
    && entry.releaseAcceptedExactVersions.includes(receipt.version)
    && validArtifactReceipt(receipt, entry)
    && receipt.signedCode !== null
    && kimiNativeReceiptLookupFingerprint({
      architecture: receipt.architecture,
      executableSha256: receipt.executableSha256,
      executableSizeBytes: receipt.executableSizeBytes,
      identifier: receipt.signedCode.identifier,
      teamIdentifier: receipt.signedCode.teamIdentifier,
      cdHash: receipt.signedCode.cdhash,
      designatedRequirement: receipt.signedCode.designatedRequirement,
    }) === surface.lookupFingerprint
  ))
  return candidates.length === 1 ? candidates[0]! : null
}

export function isAgentReleaseGateReason(reason: string | undefined): reason is AgentReleaseGateReason {
  return reason === 'release_entry_missing'
    || reason === 'release_mode_detect_only'
    || reason === 'release_distribution_not_accepted'
    || reason === 'release_version_unverified'
    || reason === 'release_version_not_accepted'
    || reason === 'release_artifact_not_accepted'
}

/** Preserve discovery visibility while revoking every write capability not accepted by this exact release. */
export function applyAgentReleaseGateToReport(report: LocalDiscoveryReport): LocalDiscoveryReport {
  return {
    ...report,
    installations: report.installations.map(installation => {
      const reason = agentReleaseEligibilityReason(installation)
      if (!reason) return installation
      return {
        ...installation,
        managementEligibility: {
          schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
          eligible: false,
          reason,
          executableSizeBytes: installation.managementEligibility?.executableSizeBytes,
          proofLimitBytes: installation.managementEligibility?.proofLimitBytes
            ?? MAX_CLI_EXECUTABLE_PROOF_BYTES,
        },
      }
    }),
  }
}

/** Runtime/environment switches may narrow the signed contract but never expand it. */
export function resolveAgentIntegrationReleasePolicy(
  input: ResolveAgentIntegrationReleasePolicyInput,
): AgentIntegrationReleasePolicy {
  const environment = input.environment ?? process.env
  const diagnostics = manifestDiagnostics()
  const entries = AGENT_INTEGRATION_RELEASE_ENTRY_MAP
  const strictAdapterCoverage = input.strictAdapterCoverage ?? true
  const releasedEntries = AGENT_INTEGRATION_RELEASE_ENTRIES.filter(entry => (
    entry.enabledByDefault && entry.releaseMode === 'production'
  ))

  if (strictAdapterCoverage) {
    for (const entry of releasedEntries) {
      const adapter = input.adapters.get(entry.catalogId)
      if (!adapter) {
        diagnostics.push(`release_adapter_missing:${entry.catalogId}`)
        continue
      }
      const promised = [...entry.requiredComponents].sort()
      const implemented = [...adapter.componentKeys].sort()
      if (JSON.stringify(promised) !== JSON.stringify(implemented)) {
        diagnostics.push(`release_component_mismatch:${entry.catalogId}`)
      }
      for (const component of entry.components) {
        const concrete = adapter.componentContracts?.[component.componentKey]
        const promisedArtifacts = [...component.artifactTypes].sort()
        const implementedArtifacts = [...(adapter.implementationTypes?.[component.componentKey] ?? [])].sort()
        const contractedArtifacts = [...(concrete?.artifactTypes ?? [])].sort()
        if (!concrete
          || JSON.stringify(promisedArtifacts) !== JSON.stringify(implementedArtifacts)
          || JSON.stringify(promisedArtifacts) !== JSON.stringify(contractedArtifacts)) {
          diagnostics.push(`release_artifact_mismatch:${entry.catalogId}:${component.componentKey}`)
        }
        if (concrete && (concrete.deliveryMode !== component.deliveryMode
          || concrete.mutationDomain !== component.mutationDomain
          || concrete.reload !== component.reload)) {
          diagnostics.push(`release_contract_mismatch:${entry.catalogId}:${component.componentKey}`)
        }
      }
    }
  }

  let allowed = releasedEntries.map(entry => entry.catalogId).filter(catalogId => input.adapters.has(catalogId))
  const environmentRestriction = parseAdapterRestriction(environment[AGENT_INTEGRATION_RELEASE_ENV.adapters])
  if (environmentRestriction) {
    const restriction = new Set(environmentRestriction)
    allowed = allowed.filter(catalogId => restriction.has(catalogId))
    for (const catalogId of environmentRestriction) {
      if (!entries.has(catalogId)) diagnostics.push(`release_adapter_restriction_unknown:${catalogId}`)
    }
  }
  if (input.restrictToAdapterIds) {
    const restriction = new Set(input.restrictToAdapterIds)
    allowed = allowed.filter(catalogId => restriction.has(catalogId))
  }

  const emergencyReadOnly = input.forceObserveOnly === true
    || environment[AGENT_INTEGRATION_RELEASE_ENV.writes] === '0'
  const invalidManifest = diagnostics.some(diagnostic => (
    diagnostic.startsWith('release_manifest_')
    || diagnostic.startsWith('release_adapter_missing:')
    || diagnostic.startsWith('release_component_mismatch:')
    || diagnostic.startsWith('release_artifact_mismatch:')
    || diagnostic.startsWith('release_contract_mismatch:')
  ))
  const mode: AgentIntegrationReleasePolicyMode = invalidManifest
    ? 'invalid_manifest'
    : emergencyReadOnly
      ? 'emergency_read_only'
      : 'active'
  const enabledAdapterIds = mode === 'active' ? Object.freeze([...new Set(allowed)]) : Object.freeze([])
  const autoRestore = mode === 'active'
    && environment[AGENT_INTEGRATION_RELEASE_ENV.autoRestore] !== '0'
    && input.autoRestore !== false

  return Object.freeze({
    manifestVersion: AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION,
    mode,
    entries,
    enabledAdapterIds,
    autoRestore,
    customLocalAgentEnabled: mode === 'active'
      && AGENT_INTEGRATION_RELEASE_MANIFEST.features.customLocalAgent.enabledByDefault,
    diagnostics: Object.freeze(diagnostics),
  })
}

function manifestDiagnostics(): string[] {
  const diagnostics: string[] = []
  if (AGENT_INTEGRATION_RELEASE_MANIFEST.schemaVersion !== AGENT_INTEGRATION_RELEASE_SCHEMA_VERSION) {
    diagnostics.push('release_manifest_schema_mismatch')
  }
  if (new Set(AGENT_INTEGRATION_RELEASE_ENTRIES.map(entry => entry.catalogId)).size
    !== AGENT_INTEGRATION_RELEASE_ENTRIES.length) diagnostics.push('release_manifest_duplicate_catalog_id')
  for (const entry of AGENT_INTEGRATION_RELEASE_ENTRIES) {
    const prefix = `release_manifest_entry_invalid:${entry.catalogId}`
    const componentKeys = entry.components.map(component => component.componentKey)
    if (JSON.stringify(componentKeys) !== JSON.stringify(entry.requiredComponents)
      || new Set(componentKeys).size !== componentKeys.length) diagnostics.push(`${prefix}:components`)
    const variant = AGENT_CATALOG.variants.find(candidate => candidate.catalogId === entry.catalogId)
    const catalogSupportedKeys = variant?.components
      .filter(component => component.applicability === 'supported')
      .map(component => component.componentKey)
      .sort() ?? []
    if (entry.releaseMode === 'production'
      && JSON.stringify(catalogSupportedKeys) !== JSON.stringify([...entry.requiredComponents].sort())) {
      diagnostics.push(`${prefix}:catalog_component_scope`)
    }
    for (const component of entry.components) {
      const declaration = variant?.components.find(candidate => candidate.componentKey === component.componentKey)
      if (!declaration || declaration.applicability !== component.applicability
        || declaration.deliveryMode !== component.deliveryMode
        || JSON.stringify(declaration.artifactTypes) !== JSON.stringify(component.artifactTypes)
        || declaration.mutationDomain !== component.mutationDomain
        || declaration.reload !== component.reload) {
        diagnostics.push(`${prefix}:component_contract:${component.componentKey}`)
      }
    }
    if (new Set(entry.observedExactVersions).size !== entry.observedExactVersions.length
      || new Set(entry.releaseAcceptedExactVersions).size !== entry.releaseAcceptedExactVersions.length
      || entry.releaseAcceptedExactVersions.some(version => !entry.observedExactVersions.includes(version))) {
      diagnostics.push(`${prefix}:versions`)
    }
    if (entry.releaseMode === 'production' && entry.officialDistributions.length === 0) {
      diagnostics.push(`${prefix}:distribution`)
    }
    const expectedArtifactKeys = entry.releaseAcceptedExactVersions.flatMap(version => (
      entry.officialDistributions.flatMap(distribution => (
        distribution.supportedMacArchitectures.map(architecture => (
          `${distribution.distributionId}\u0000${distribution.packageProvenance}\u0000${version}\u0000${architecture}`
        ))
      ))
    )).sort()
    const actualArtifactKeys = entry.acceptedDistributionArtifacts.map(receipt => (
      `${receipt.distributionId}\u0000${receipt.packageProvenance}\u0000${receipt.version}\u0000${receipt.architecture}`
    )).sort()
    if (JSON.stringify(expectedArtifactKeys) !== JSON.stringify(actualArtifactKeys)
      || entry.acceptedDistributionArtifacts.some(receipt => !validArtifactReceipt(receipt, entry))) {
      diagnostics.push(`${prefix}:distribution_artifacts`)
    }
    if (entry.requiredComponents.includes('lifecycle') !== (entry.requiredLifecycle !== null)
      || (entry.requiredLifecycle !== null
        && (entry.requiredLifecycle.require !== 'all' || entry.requiredLifecycle.signals.length === 0))) {
      diagnostics.push(`${prefix}:lifecycle`)
    }
    if ((entry.releaseMode === 'detect_only') !== !entry.enabledByDefault) diagnostics.push(`${prefix}:release_mode`)
  }
  return diagnostics
}

function parseAdapterRestriction(value: string | undefined): CatalogId[] | null {
  if (value === undefined) return null
  return [...new Set(value.split(',').map(candidate => candidate.trim()).filter(Boolean))] as CatalogId[]
}

const RELEASE_SHA256 = /^[a-f0-9]{64}$/u
const RELEASE_PORTABLE_ARTIFACT = RELEASE_SHA256

export function validArtifactReceipt(
  receipt: AgentReleaseDistributionArtifactReceipt,
  entry: AgentReleaseEntry,
): boolean {
  const distribution = entry.officialDistributions.find(candidate => (
    candidate.distributionId === receipt.distributionId
    && candidate.packageProvenance === receipt.packageProvenance
    && candidate.supportedMacArchitectures.includes(receipt.architecture)
  ))
  if (!distribution || !entry.releaseAcceptedExactVersions.includes(receipt.version)
    || !RELEASE_SHA256.test(receipt.artifactSha256)
    || !RELEASE_SHA256.test(receipt.executableSha256)
    || !RELEASE_SHA256.test(receipt.distributionSha256)
    || !RELEASE_PORTABLE_ARTIFACT.test(receipt.portableArtifactFingerprint)
    || !Number.isSafeInteger(receipt.artifactSizeBytes) || receipt.artifactSizeBytes <= 0
    || !Number.isSafeInteger(receipt.executableSizeBytes) || receipt.executableSizeBytes <= 0
    || !Number.isSafeInteger(receipt.distributionSizeBytes) || receipt.distributionSizeBytes <= 0) return false
  if (distribution.channel === 'npm') {
    const baseValid = receipt.signedCode === null
      && receipt.npmPackage !== null
      && (receipt.portableFingerprintSchema === 'qwen-standalone-surface-v1'
        ? receipt.npmPackage.integrity === null
        : /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(receipt.npmPackage.integrity ?? ''))
      && RELEASE_SHA256.test(receipt.npmPackage.ownedPackageSha256)
      && Number.isSafeInteger(receipt.npmPackage.ownedEntryCount)
      && receipt.npmPackage.ownedEntryCount > 0
      && Number.isSafeInteger(receipt.npmPackage.ownedTotalBytes)
      && receipt.npmPackage.ownedTotalBytes >= 0
      && receipt.npmPackage.proofNodes.length > 0
      && receipt.npmPackage.proofNodes.length <= 16
      && receipt.npmPackage.proofNodes.every(node => (
        node.role.length > 0 && node.relativePath.length > 0 && !node.relativePath.startsWith('/')
        && !node.relativePath.split('/').includes('..') && RELEASE_SHA256.test(node.sha256)
        && Number.isSafeInteger(node.sizeBytes) && node.sizeBytes >= 0
        && typeof node.executable === 'boolean'
        && (node.normalization === 'raw'
          || node.normalization === 'openclaw_prefix_template_v1'
          || node.normalization === 'qwen_relative_root_v1')
      ))
    if (!baseValid || !receipt.npmPackage) return false
    const packageName = receipt.packageProvenance.startsWith('npm_metadata:')
      ? receipt.packageProvenance.slice('npm_metadata:'.length)
      : ''
    const platformVariant = receipt.distributionId.endsWith(':darwin-x64-baseline') ? 'baseline' : 'modern'
    const expectedComposition = expectedNpmCompositionForEntry(
      entry, packageName, receipt.version, receipt.architecture, platformVariant,
    )
    if (expectedComposition) {
      if (receipt.portableFingerprintSchema !== 'npm-composed-platform-surface-v1'
        || receipt.npmPackage.composition === undefined) return false
      return validComposedNpmReceipt(receipt, expectedComposition)
    }
    if (receipt.npmPackage.composition !== undefined) return false
    if (receipt.portableFingerprintSchema === 'npm-owned-package-surface-v1') {
      return validGenericNpmReceipt(receipt, packageName)
    }
    return true
  }
  const expectedSignedIdentity = distribution.packageProvenance.match(/^signed_(?:app|cli):([^:]+):([^:]+)$/u)
  const baseSignedValid = receipt.npmPackage === null
    && receipt.signedCode !== null
    && receipt.signedCode.identifier.length > 0
    && receipt.signedCode.identifier === receipt.signedCode.identifier.trim()
    && receipt.signedCode.teamIdentifier.length > 0
    && receipt.signedCode.teamIdentifier === receipt.signedCode.teamIdentifier.trim()
    && /^[A-Fa-f0-9]{20,128}$/u.test(receipt.signedCode.cdhash)
    && receipt.signedCode.designatedRequirement.length > 0
    && receipt.signedCode.designatedRequirement.length <= 8 * 1024
    && receipt.signedCode.designatedRequirement === receipt.signedCode.designatedRequirement.trim()
    && receipt.signedCode.identifier === expectedSignedIdentity?.[1]
    && receipt.signedCode.teamIdentifier === expectedSignedIdentity?.[2]
  if (!baseSignedValid || !receipt.signedCode) return false
  if (entry.catalogId === 'kimi-code-native') {
    return distribution.channel === 'signed_cli'
      && receipt.portableFingerprintSchema === 'signed-cli-kimi-release-v2'
      && receipt.distributionSha256 === receipt.executableSha256
      && receipt.distributionSizeBytes === receipt.executableSizeBytes
      && receipt.portableArtifactFingerprint === sha256Json({
        schema: 'signed-cli-kimi-release-v2',
        version: receipt.version,
        executableArtifactFingerprint: sha256Json({
          schema: 'kimi-native-executable-v1',
          executable: {
            relativePath: 'bin/kimi',
            sha256: receipt.executableSha256,
            sizeBytes: receipt.executableSizeBytes,
            executable: true,
          },
        }),
        identifier: receipt.signedCode.identifier,
        teamIdentifier: receipt.signedCode.teamIdentifier,
        cdHash: receipt.signedCode.cdhash.toLowerCase(),
        designatedRequirement: receipt.signedCode.designatedRequirement,
      })
  }
  return receipt.portableFingerprintSchema === 'signed-code-v1'
}

function expectedNpmCompositionForEntry(
  entry: AgentReleaseEntry,
  packageName: string,
  version: string,
  architecture: 'arm64' | 'x64',
  platformVariant: 'modern' | 'baseline',
) {
  const expectedCatalog = packageName === '@anthropic-ai/claude-code' ? 'claude-code-cli'
    : packageName === '@openai/codex' ? 'codex-cli'
      : packageName === 'opencode-ai' ? 'opencode-v1-cli'
        : packageName === '@opencode-ai/cli' ? 'opencode-v2-beta-cli'
          : packageName === '@oh-my-pi/pi-coding-agent' ? 'omp-cli'
            : null
  if (entry.catalogId !== expectedCatalog) return null
  return npmComposedDistributionSpec(packageName, version, architecture, platformVariant)
}

function validComposedNpmReceipt(
  receipt: AgentReleaseDistributionArtifactReceipt,
  expected: NonNullable<ReturnType<typeof npmComposedDistributionSpec>>,
): boolean {
  const npm = receipt.npmPackage
  const composition = npm?.composition
  if (!npm || !composition
    || !exactObjectKeys(npm, ['composition', 'integrity', 'ownedPackageSha256', 'ownedEntryCount', 'ownedTotalBytes', 'proofNodes'])
    || !exactObjectKeys(composition, ['components', 'entryRule'])
    || !['copy_platform_binary_v1', 'js_wrapper_selects_platform_binary_v1', 'js_entry_loads_platform_native_v1']
      .includes(composition.entryRule)
    || composition.components.length < 1 || composition.components.length > 2) return false
  const packageName = receipt.packageProvenance.startsWith('npm_metadata:')
    ? receipt.packageProvenance.slice('npm_metadata:'.length)
    : ''
  if (expected.entryRule !== composition.entryRule) return false
  const componentFields = [
    'artifactSha256', 'artifactSizeBytes', 'installName', 'integrity', 'manifestName',
    'nativeExecutableRelativePath', 'nativeExecutableSha256', 'nativeExecutableSizeBytes',
    'ownedEntryCount', 'ownedPackageSha256', 'ownedTotalBytes', 'role', 'version',
  ]
  if (composition.components.length !== expected.components.length
    || composition.components.some((component, index) => {
      const expectedComponent = expected.components[index]
      const nativeNull = component.nativeExecutableRelativePath === null
        && component.nativeExecutableSha256 === null && component.nativeExecutableSizeBytes === null
      const nativePresent = typeof component.nativeExecutableRelativePath === 'string'
        && safeReceiptRelativePath(component.nativeExecutableRelativePath)
        && RELEASE_SHA256.test(component.nativeExecutableSha256 ?? '')
        && Number.isSafeInteger(component.nativeExecutableSizeBytes) && (component.nativeExecutableSizeBytes ?? 0) > 0
      return !exactObjectKeys(component, componentFields)
        || component.role !== expectedComponent?.role
        || component.installName !== expectedComponent.installName
        || component.manifestName !== expectedComponent.manifestName
        || component.version !== expectedComponent.version
        || component.nativeExecutableRelativePath !== expectedComponent.nativeExecutableRelativePath
        || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(component.integrity)
        || !RELEASE_SHA256.test(component.artifactSha256)
        || !Number.isSafeInteger(component.artifactSizeBytes) || component.artifactSizeBytes <= 0
        || !RELEASE_SHA256.test(component.ownedPackageSha256)
        || !Number.isSafeInteger(component.ownedEntryCount) || component.ownedEntryCount <= 0
        || !Number.isSafeInteger(component.ownedTotalBytes) || component.ownedTotalBytes < 0
        || (!nativeNull && !nativePresent)
    })) return false
  const executableNodes = npm.proofNodes.filter(node => node.role === 'npm_package_executable')
  const manifestNodes = npm.proofNodes.filter(node => node.role === 'package_manifest')
  const relativePaths = npm.proofNodes.map(node => node.relativePath)
  if (executableNodes.length !== 1 || manifestNodes.length !== 1
    || executableNodes[0]?.relativePath !== expected.rootExecutableRelativePath
    || !executableNodes[0].executable
    || executableNodes[0].sha256 !== receipt.executableSha256
    || executableNodes[0].sizeBytes !== receipt.executableSizeBytes
    || npm.proofNodes.some(node => node.normalization !== 'raw' || node.role === 'npm_install_lock')
    || new Set(relativePaths).size !== relativePaths.length
    || JSON.stringify(relativePaths) !== JSON.stringify([...relativePaths].sort())
    || npm.ownedEntryCount < npm.proofNodes.length
    || npm.ownedTotalBytes < npm.proofNodes.reduce((sum, node) => sum + node.sizeBytes, 0)) return false
  const leaves = composition.components.filter(component => component.role === 'platform_leaf')
  if (leaves.length === 0) return false
  if (composition.entryRule === 'copy_platform_binary_v1') {
    const matches = leaves.filter(leaf => (
      leaf.nativeExecutableSha256 === receipt.executableSha256
        && leaf.nativeExecutableSizeBytes === receipt.executableSizeBytes
    ))
    const isOpenCodeV1X64 = receipt.architecture === 'x64' && packageName === 'opencode-ai'
    const isOpenCodeV2X64 = receipt.architecture === 'x64' && packageName === '@opencode-ai/cli'
    if ((isOpenCodeV1X64 && (leaves.length !== 2 || matches.length !== 2))
      || (isOpenCodeV2X64 && (leaves.length !== 2 || matches.length !== 1
        || matches[0]?.installName !== expected.copySourceInstallName))
      || (!isOpenCodeV1X64 && !isOpenCodeV2X64
        && (matches.length !== 1 || matches[0]?.installName !== expected.copySourceInstallName))) return false
  }
  const runtimeComponents = composition.components.map(component => ({
    role: component.role,
    installName: component.installName,
    manifestName: component.manifestName,
    version: component.version,
    integrity: component.integrity,
    ownedPackageSha256: component.ownedPackageSha256,
    ownedEntryCount: component.ownedEntryCount,
    ownedTotalBytes: component.ownedTotalBytes,
    nativeExecutableRelativePath: component.nativeExecutableRelativePath,
    nativeExecutableSha256: component.nativeExecutableSha256,
    nativeExecutableSizeBytes: component.nativeExecutableSizeBytes,
  }))
  const root = {
    packageName,
    integrity: npm.integrity,
    ownedPackageSha256: npm.ownedPackageSha256,
    ownedEntryCount: npm.ownedEntryCount,
    ownedTotalBytes: npm.ownedTotalBytes,
  }
  if (receipt.distributionSha256 !== sha256Json({
    schema: 'npm-composed-owned-packages-v1', root,
    entryRule: composition.entryRule, components: runtimeComponents,
  })) return false
  return receipt.portableArtifactFingerprint === sha256Json({
    schema: 'npm-composed-platform-surface-v1',
    version: receipt.version,
    packageName,
    integrity: npm.integrity,
    executable: {
      relativePath: executableNodes[0].relativePath,
      sha256: executableNodes[0].sha256,
      sizeBytes: executableNodes[0].sizeBytes,
      executable: true,
    },
    ownedPackageSha256: npm.ownedPackageSha256,
    ownedEntryCount: npm.ownedEntryCount,
    ownedTotalBytes: npm.ownedTotalBytes,
    entryRule: composition.entryRule,
    components: runtimeComponents,
  })
}

function validGenericNpmReceipt(
  receipt: AgentReleaseDistributionArtifactReceipt,
  packageName: string,
): boolean {
  const npm = receipt.npmPackage
  if (!npm || !packageName
    || !exactObjectKeys(npm, ['integrity', 'ownedPackageSha256', 'ownedEntryCount', 'ownedTotalBytes', 'proofNodes'])) {
    return false
  }
  const executableNodes = npm.proofNodes.filter(node => node.role === 'npm_package_executable')
  const manifestNodes = npm.proofNodes.filter(node => node.role === 'package_manifest')
  const relativePaths = npm.proofNodes.map(node => node.relativePath)
  if (executableNodes.length !== 1 || manifestNodes.length !== 1
    || npm.proofNodes.some(node => node.normalization !== 'raw' || node.role === 'npm_install_lock')
    || new Set(relativePaths).size !== relativePaths.length
    || JSON.stringify(relativePaths) !== JSON.stringify([...relativePaths].sort())
    || npm.ownedEntryCount < npm.proofNodes.length
    || npm.ownedTotalBytes < npm.proofNodes.reduce((sum, node) => sum + node.sizeBytes, 0)) return false
  const executable = executableNodes[0]
  if (!executable?.executable
    || executable.sha256 !== receipt.executableSha256
    || executable.sizeBytes !== receipt.executableSizeBytes) return false
  return receipt.portableArtifactFingerprint === sha256Json({
    schema: 'npm-owned-package-surface-v1',
    version: receipt.version,
    packageName,
    integrity: npm.integrity,
    executable: {
      relativePath: executable.relativePath,
      sha256: executable.sha256,
      sizeBytes: executable.sizeBytes,
      executable: true,
    },
    ownedPackageSha256: npm.ownedPackageSha256,
    ownedEntryCount: npm.ownedEntryCount,
    ownedTotalBytes: npm.ownedTotalBytes,
  })
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

function safeReceiptRelativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith('/') && !value.split('/').includes('..')
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function release(
  catalogId: CatalogId,
  disposition: Exclude<AgentReleaseDisposition, 'observe_only'>,
  targetCapability: CapabilityLevel,
  requiredComponents: readonly ComponentKey[],
  details: ReleaseEntryDetails,
): AgentReleaseEntry {
  return freezeEntry({
    catalogId, disposition, targetCapability, requiredComponents, ...details,
    customConfigRoot: { supported: CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS.includes(catalogId as never) },
    enabledByDefault: details.releaseMode === 'production',
  })
}

function observeOnly(
  catalogId: CatalogId,
  notes: string,
  details: Omit<ReleaseEntryDetails, 'components'> & { components: readonly [] },
): AgentReleaseEntry {
  return freezeEntry({
    catalogId, disposition: 'observe_only', targetCapability: 0, requiredComponents: [], ...details,
    customConfigRoot: { supported: false },
    enabledByDefault: false, notes,
  })
}

function freezeEntry(
  entry: Omit<AgentReleaseEntry, 'components'> & { components: readonly AgentReleaseComponentSeed[] },
): AgentReleaseEntry {
  const variant = AGENT_CATALOG.variants.find(candidate => candidate.catalogId === entry.catalogId)
  if (!variant) throw new Error(`Release Catalog variant missing: ${entry.catalogId}`)
  const components = entry.components.map((component): AgentReleaseComponent => {
    const declaration = variant.components.find(candidate => candidate.componentKey === component.componentKey)
    if (!declaration || declaration.applicability !== 'supported') {
      throw new Error(`Release component is not supported by Catalog: ${entry.catalogId}:${component.componentKey}`)
    }
    return {
      ...component,
      applicability: 'supported',
      deliveryMode: declaration.deliveryMode,
      mutationDomain: declaration.mutationDomain,
    }
  })
  return Object.freeze({
    ...entry,
    customConfigRoot: Object.freeze({ ...entry.customConfigRoot }),
    requiredComponents: Object.freeze([...entry.requiredComponents]),
    components: Object.freeze(components.map(component => Object.freeze({
      ...component,
      artifactTypes: Object.freeze([...component.artifactTypes]),
    }))),
    officialDistributions: Object.freeze(entry.officialDistributions.map(identity => Object.freeze({ ...identity }))),
    acceptedDistributionArtifacts: Object.freeze(entry.acceptedDistributionArtifacts.map(receipt => Object.freeze({
      ...receipt,
      signedCode: receipt.signedCode ? Object.freeze({ ...receipt.signedCode }) : null,
      npmPackage: receipt.npmPackage ? Object.freeze({
        ...receipt.npmPackage,
        proofNodes: Object.freeze(receipt.npmPackage.proofNodes.map(node => Object.freeze({ ...node }))),
        ...(receipt.npmPackage.composition ? {
          composition: Object.freeze({
            ...receipt.npmPackage.composition,
            components: Object.freeze(receipt.npmPackage.composition.components.map(component => Object.freeze({ ...component }))),
          }),
        } : {}),
      }) : null,
    }))),
    observedExactVersions: Object.freeze([...entry.observedExactVersions]),
    releaseAcceptedExactVersions: Object.freeze([...entry.releaseAcceptedExactVersions]),
    activation: Object.freeze({ ...entry.activation }),
    requiredLifecycle: entry.requiredLifecycle
      ? Object.freeze({ signals: Object.freeze([...entry.requiredLifecycle.signals]), require: 'all' as const })
      : null,
  })
}
