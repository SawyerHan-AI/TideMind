import { sha256Bytes } from '../fingerprint'
import { verifyHostActivity } from '../host-activity-evidence'
import { createManagedTextHostAdapter, type ManagedTextHostSpec } from './managed-text-adapter'
import { PORTABLE_TIDEMIND_SKILL } from './portable-skill'
import type {
  AdapterOperationContext,
  AdapterVerificationRequest,
  AgentHostAdapter,
  ComponentVerificationResult,
} from '../types'

export const OPENCODE_V1_LIFECYCLE_ADAPTER_VERSION = '1'

/**
 * OpenCode V1 and V2 can read the same resource directory. This Adapter owns
 * a V1-specific file, and the generated plugin refuses to register hooks
 * unless the official runtime health endpoint reports the exact V1 version
 * frozen by discovery.
 */
export function createOpenCodeV1LifecycleHostAdapter(): AgentHostAdapter {
  const base = createManagedTextHostAdapter(openCodeV1LifecycleSpec())
  return {
    ...base,
    async inspectAdoptableArtifacts(context) {
      const observations = await base.inspectAdoptableArtifacts?.(context) ?? []
      return observations.map(observation => ({
        ...observation,
        identityAssertion: context.agentId,
      }))
    },
    async verify(
      context: AdapterOperationContext,
      request: AdapterVerificationRequest,
    ): Promise<readonly ComponentVerificationResult[]> {
      if (!request.componentKeys.includes('lifecycle')) return []
      const inspection = await base.inspect(context)
      const lifecycle = inspection.components.find(component => component.componentKey === 'lifecycle')
      if (request.expectedCapability === 0 && lifecycle?.visibility === 'absent') {
        return base.verify(context, request)
      }
      if (lifecycle?.visibility !== 'dedicated') {
        return [{
          componentKey: 'lifecycle',
          status: 'failed',
          verifiedCapability: null,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: inspection.diagnostics.length > 0
            ? inspection.diagnostics
            : ['managed_opencode_v1_plugin_not_visible'],
        }]
      }

      const expectedHash = sha256Bytes(normalizeContent(openCodeV1PluginContent(context)))
      if (lifecycle.observedFragmentHash !== expectedHash) {
        return [{
          componentKey: 'lifecycle',
          status: 'failed',
          verifiedCapability: null,
          evidenceHash: lifecycle.observedFragmentHash,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['managed_opencode_v1_plugin_drifted_from_current_desired'],
        }]
      }

      const activity = await verifyHostActivity(context, request, {
        componentKey: 'lifecycle',
        signalNames: ['session_start', 'pre_compact', 'post_compact'],
        require: 'all',
      })
      if (activity.status === 'unverified') {
        return [{
          ...activity,
          evidenceHash: lifecycle.observedFragmentHash,
          identityAssertion: context.agentId,
          diagnostics: ['static_readback_passed', ...activity.diagnostics],
        }]
      }
      return [activity]
    },
  }
}

export function openCodeV1PluginTarget(context: AdapterOperationContext): string {
  assertOpenCodeV1(context)
  const target = context.installation.componentConfigFiles?.lifecycle
  if (!target) throw new Error('opencode_v1_lifecycle_target_not_frozen')
  return target
}

export function openCodeV1PluginContent(context: AdapterOperationContext): string {
  assertOpenCodeV1(context)
  const hostVersion = context.hostVersion?.trim()
  if (!hostVersion) throw new Error('opencode_v1_host_version_not_frozen')
  const activityGenerationToken = context.activityGenerationToken?.trim()
  if (!activityGenerationToken) throw new Error('opencode_v1_activity_generation_not_frozen')
  const skillPath = context.installation.componentConfigFiles?.instruction
  if (!skillPath) throw new Error('opencode_v1_instruction_target_not_frozen')

  const shim = JSON.stringify(context.runtime.shimPath)
  const sessionScript = JSON.stringify(context.runtime.hookScriptPath)
  const preCompactScript = JSON.stringify(context.runtime.preCompactScriptPath)
  const postCompactScript = JSON.stringify(context.runtime.postCompactScriptPath)
  const agentId = JSON.stringify(context.agentId)
  const skill = JSON.stringify(skillPath)
  const expectedHostVersion = JSON.stringify(hostVersion)
  const generationToken = JSON.stringify(activityGenerationToken)
  const expectedSkillSha256 = JSON.stringify(sha256Bytes(normalizeContent(PORTABLE_TIDEMIND_SKILL)))

  return `import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Plugin } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const SHIM = ${shim};
const AGENT_ID = ${agentId};
const EXPECTED_HOST_VERSION = ${expectedHostVersion};
const ACTIVITY_GENERATION_TOKEN = ${generationToken};
const EXPECTED_SKILL_SHA256 = ${expectedSkillSha256};
const sessionContexts = new Map<string, Promise<string | null>>();

async function runLifecycle(script: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync(SHIM, [script, ...args], {
      timeout: 30_000,
      maxBuffer: 1_048_576,
    });
    const output = result.stdout.trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

async function sessionContext(sessionID: string): Promise<string | null> {
  let pending = sessionContexts.get(sessionID);
  if (!pending) {
    pending = runLifecycle(${sessionScript}, [
      "--agent-id", AGENT_ID,
      "--skill-path", ${skill},
      "--tool", "opencode",
      "--activity-generation-token", ACTIVITY_GENERATION_TOKEN,
      "--expected-skill-sha256", EXPECTED_SKILL_SHA256,
    ]);
    sessionContexts.set(sessionID, pending);
  }
  const context = await pending;
  if (!context) sessionContexts.delete(sessionID);
  return context;
}

const TideMindPlugin: Plugin = async ({ client }) => {
  try {
    const health = await client.global.health();
    if (!health.data?.healthy || health.data.version !== EXPECTED_HOST_VERSION) return {};
  } catch {
    return {};
  }

  return {
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (!sessionID) return;
      const context = await sessionContext(sessionID);
      if (context) output.system[0] = [output.system[0], context].filter(Boolean).join("\\n\\n");
    },
    "experimental.session.compacting": async ({ sessionID }, output) => {
      const context = await runLifecycle(${preCompactScript}, [
      "--agent-id", AGENT_ID,
      "--tool", "opencode",
      "--activity-generation-token", ACTIVITY_GENERATION_TOKEN,
      ]);
      if (context) output.context.push(context);
    },
    "experimental.compaction.autocontinue": async ({ sessionID }) => {
      const context = await runLifecycle(${postCompactScript}, [
      "--agent-id", AGENT_ID,
      "--tool", "opencode",
      "--activity-generation-token", ACTIVITY_GENERATION_TOKEN,
      ]);
      if (context) sessionContexts.set(sessionID, Promise.resolve(context));
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") sessionContexts.delete(event.properties.info.id);
    },
  };
};

export default TideMindPlugin;
`
}

function openCodeV1LifecycleSpec(): ManagedTextHostSpec {
  return {
    catalogId: 'opencode-v1-cli',
    adapterVersion: OPENCODE_V1_LIFECYCLE_ADAPTER_VERSION,
    componentKey: 'lifecycle',
    artifactType: 'plugin',
    targetFile: openCodeV1PluginTarget,
    allowedRoot: openCodeV1LifecycleRoot,
    content: openCodeV1PluginContent,
    // OpenCode loads configuration-time files once during process startup.
    reload: 'restart_host',
  }
}

function openCodeV1LifecycleRoot(context: AdapterOperationContext): string {
  assertOpenCodeV1(context)
  const root = context.installation.componentConfigRoots?.lifecycle
  if (!root) throw new Error('opencode_v1_lifecycle_root_not_frozen')
  return root
}

function assertOpenCodeV1(context: AdapterOperationContext): void {
  if (context.installation.hostVariant !== 'opencode-v1-cli') {
    throw new Error('opencode_v1_adapter_variant_mismatch')
  }
}

function normalizeContent(content: string): string {
  return `${content.replace(/\s+$/u, '')}\n`
}
