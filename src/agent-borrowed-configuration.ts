import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateBridgeAdmission } from './agent-bridge-guard.js';
import { configurationOwnerId, type CallerAttribution } from './agent-caller-observation.js';
import { latestPhysicalBridgeWrite } from './db/codex-bridge-continuity.js';

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/**
 * True when this server was started from another host's configuration by a host
 * that has its own working Tide Mind connection. Such a host would otherwise
 * show two identical sets of memory tools.
 *
 * Every doubt answers false: hiding the tools of the only working connection is
 * worse than a duplicate. The decision is taken once per process.
 */
export function borrowedByConnectedCaller(
  db: Database.Database, configAgentId: string, caller: CallerAttribution,
): boolean {
  if (caller.level !== 'verified' || !caller.installationId) return false;
  try {
    // A CLI beside its desktop app uses the app's connection as its own.
    const callerId = configurationOwnerId(db, caller.installationId);
    if (!callerId) return false;
    const owners = db.prepare(`SELECT id FROM agent_installations WHERE agent_id = ?
      UNION SELECT m.installation_id FROM agent_identity_bindings b
        JOIN agent_identity_binding_members m ON m.binding_id = b.id WHERE b.canonical_agent_id = ?`)
      .all(configAgentId, configAgentId) as Array<{ id: string }>;
    if (!owners.length || owners.some(owner => owner.id === callerId)) return false;
    const own = db.prepare(`SELECT COALESCE(
        (SELECT b.canonical_agent_id FROM agent_identity_bindings b
          JOIN agent_identity_binding_members m ON m.binding_id = b.id WHERE m.installation_id = i.id), i.agent_id) AS agent_id
      FROM agent_installations i WHERE i.id = ? AND i.desired_state = 'managed' AND i.health_state = 'discovered'
        AND i.bridge_state != 'stopped' AND i.tombstoned_at IS NULL`).get(callerId) as { agent_id: string | null } | undefined;
    if (!own?.agent_id || own.agent_id === configAgentId) return false;
    const carriers = db.prepare(`SELECT a.id, a.target_path FROM artifact_consumers c
      JOIN managed_artifacts a ON a.id = c.artifact_id
      WHERE c.installation_id = ? AND c.component_key = 'memory_tools' AND c.state = 'active'
        AND c.desired_state = 'managed' AND c.tombstoned_at IS NULL AND a.state = 'healthy'`)
      .all(callerId) as Array<{ id: string; target_path: string }>;
    return carriers.some(carrier => {
      const token = latestPhysicalBridgeWrite(db, carrier.id)?.token;
      // A plugin-manager target cannot be read back here, so it never hides anything.
      if (!token || !path.isAbsolute(carrier.target_path)) return false;
      if (!evaluateBridgeAdmission(db, { agentId: own.agent_id, activityGenerationToken: token, componentKey: 'memory_tools' }).allowed) return false;
      const stat = fs.statSync(carrier.target_path);
      return stat.isFile() && stat.size <= MAX_CONFIG_BYTES && fs.readFileSync(carrier.target_path, 'utf8').includes(token);
    });
  } catch {
    return false;
  }
}
