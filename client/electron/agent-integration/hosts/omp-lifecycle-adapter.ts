import path from 'node:path'
import { sha256Bytes } from '../fingerprint'
import { verifyHostActivity } from '../host-activity-evidence'
import { createManagedTextHostAdapter, type ManagedTextHostSpec } from './managed-text-adapter'
import type {
  AdapterOperationContext,
  AdapterVerificationRequest,
  AgentHostAdapter,
  ComponentVerificationResult,
} from '../types'
import { PORTABLE_TIDEMIND_SKILL_SHA256 } from './portable-skill'

export const OMP_LIFECYCLE_ADAPTER_VERSION = '2'
export const OMP_REQUIRED_LIFECYCLE_SIGNALS = Object.freeze([
  'session_start', 'pre_compact', 'post_compact', 'session_end',
] as const)

/**
 * OMP loads one native user Extension directory per active profile. The
 * Installation identity has already frozen that profile's canonical agent
 * root; this Adapter never enumerates sibling profiles or follows process env.
 */
export function createOmpLifecycleHostAdapter(): AgentHostAdapter {
  const base = createManagedTextHostAdapter(ompLifecycleSpec())
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
            : ['managed_omp_extension_not_visible'],
        }]
      }

      const expectedHash = sha256Bytes(normalizeContent(ompExtensionContent(context)))
      if (lifecycle.observedFragmentHash !== expectedHash) {
        return [{
          componentKey: 'lifecycle',
          status: 'failed',
          verifiedCapability: null,
          evidenceHash: lifecycle.observedFragmentHash,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['managed_omp_extension_drifted_from_current_desired'],
        }]
      }

      const activity = await verifyHostActivity(context, request, {
        componentKey: 'lifecycle',
        signalNames: OMP_REQUIRED_LIFECYCLE_SIGNALS,
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

export function ompExtensionTarget(context: AdapterOperationContext): string {
  return context.installation.componentConfigFiles?.lifecycle
    ?? path.join(context.installation.canonicalConfigRoot, 'extensions', 'tidemind.ts')
}

export function ompExtensionContent(context: AdapterOperationContext): string {
  const skillPath = context.installation.componentConfigFiles?.instruction
    ?? path.join(context.installation.canonicalConfigRoot, 'skills', 'tidemind', 'SKILL.md')
  const shim = JSON.stringify(context.runtime.shimPath)
  const sessionScript = JSON.stringify(context.runtime.hookScriptPath)
  const preCompactScript = JSON.stringify(context.runtime.preCompactScriptPath)
  const postCompactScript = JSON.stringify(context.runtime.postCompactScriptPath)
  const sessionEndScript = JSON.stringify(
    path.join(path.dirname(context.runtime.hookScriptPath), 'hook-session-end.cjs'),
  )
  const agentId = JSON.stringify(context.agentId)
  const activityGenerationToken = JSON.stringify(context.activityGenerationToken ?? '')
  const profile = JSON.stringify(context.installation.explicitProfile || 'default')
  const skill = JSON.stringify(skillPath)
  const expectedSkillSha256 = JSON.stringify(PORTABLE_TIDEMIND_SKILL_SHA256)

  return `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const SHIM = ${shim};
const AGENT_ID = ${agentId};
const ACTIVITY_GENERATION_TOKEN = ${activityGenerationToken};
const PROFILE = ${profile};

async function runLifecycle(
  pi: ExtensionAPI,
  script: string,
  args: string[],
  signal: string,
  timeoutMs = 30_000,
): Promise<string | null> {
  const result = await pi.exec(SHIM, [script, ...args], { timeout: timeoutMs });
  if (result.code !== 0) {
    pi.logger.warn("Tide Mind lifecycle command failed", {
      signal,
      profile: PROFILE,
      exitCode: result.code,
    });
    return null;
  }
  const output = result.stdout.trim();
  return output.length > 0 ? output : null;
}

export default function tidemind(pi: ExtensionAPI): void {
  pi.setLabel("Tide Mind");
  let pendingPreCompactContext: string | null = null;

  const startSession = async () => {
    pendingPreCompactContext = null;
    const context = await runLifecycle(
      pi,
      ${sessionScript},
      ["--agent-id", AGENT_ID, "--skill-path", ${skill}, "--tool", "omp", "--activity-generation-token", ACTIVITY_GENERATION_TOKEN, "--expected-skill-sha256", ${expectedSkillSha256}],
      "session_start",
    );
    if (context) {
      pi.sendMessage({
        customType: "com.tidemind.session-context",
        content: context,
        display: false,
        attribution: "agent",
      }, { deliverAs: "nextTurn" });
    }
  };

  const endSession = async (timeoutMs = 30_000) => {
    await runLifecycle(
      pi,
      ${sessionEndScript},
      ["--agent-id", AGENT_ID, "--tool", "omp", "--activity-generation-token", ACTIVITY_GENERATION_TOKEN],
      "session_end",
      timeoutMs,
    );
  };

  pi.on("session_start", startSession);

  pi.on("session_switch", async () => {
    // OMP emits session_start only for the initial load. A successful
    // /new, /resume, or fork emits session_switch inside the same process.
    await endSession();
    await startSession();
  });

  pi.on("session_before_compact", async () => {
    pendingPreCompactContext = await runLifecycle(
      pi,
      ${preCompactScript},
      ["--agent-id", AGENT_ID, "--tool", "omp", "--activity-generation-token", ACTIVITY_GENERATION_TOKEN],
      "pre_compact",
    );
  });

  pi.on("session.compacting", async () => {
    const context = pendingPreCompactContext;
    pendingPreCompactContext = null;
    return context ? { context: [context] } : undefined;
  });

  pi.on("session_compact", async () => {
    pendingPreCompactContext = null;
    const context = await runLifecycle(
      pi,
      ${postCompactScript},
      ["--agent-id", AGENT_ID, "--tool", "omp", "--activity-generation-token", ACTIVITY_GENERATION_TOKEN],
      "post_compact",
    );
    if (context) {
      pi.sendMessage({
        customType: "com.tidemind.post-compact-context",
        content: context,
        display: false,
        attribution: "agent",
      }, { deliverAs: "nextTurn" });
    }
  });

  pi.on("session_shutdown", async () => {
    // OMP caps all session_shutdown Extension handlers at 2 seconds.
    // Terminate our child first instead of leaving it behind at host exit.
    await endSession(1_500);
  });
}
`
}

function ompLifecycleSpec(): ManagedTextHostSpec {
  return {
    catalogId: 'omp-cli',
    adapterVersion: OMP_LIFECYCLE_ADAPTER_VERSION,
    componentKey: 'lifecycle',
    // The domain model has no separate Extension carrier yet. `plugin` is the
    // executable package/module carrier; this must never be reported as a
    // legacy Hook.
    artifactType: 'plugin',
    targetFile: ompExtensionTarget,
    allowedRoot: context => context.installation.canonicalConfigRoot,
    content: ompExtensionContent,
    // OMP's Extension reload does not reliably replace live handler sets.
    reload: 'restart_host',
  }
}

function normalizeContent(content: string): string {
  return `${content.replace(/\s+$/u, '')}\n`
}
