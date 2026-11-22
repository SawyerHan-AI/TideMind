import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/**
 * Who actually started this process. The configured Agent identity says whose
 * configuration was loaded; another host may have imported that file. The
 * ancestry is an accounting fact only: a parent can be forged, so it never
 * widens admission.
 */
export interface CallerAncestor {
  pid: number;
  /** Real executable path when it could be read, otherwise the reported command. */
  executable: string;
  args: string;
}

export type CallerLevel = 'verified' | 'inferred' | 'unidentified';

export interface CallerAttribution {
  installationId: string | null;
  hostVariant: string | null;
  level: CallerLevel;
}

export type AncestryReader = (pid: number) => { ppid: number; executable: string; args: string } | null;

const MAX_LEVELS = 8;
const BUDGET_MS = 300;

function readProcess(pid: number, deadline: number): ReturnType<AncestryReader> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const options = { encoding: 'utf8' as const, timeout: remaining, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
  const line = execFileSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], options).trim();
  const match = line.match(/^(\d+)\s+(.*)$/u);
  if (!match) return null;
  let executable = match[2];
  // A process may rewrite its title; only an absolute path is taken as-is.
  if (!executable.startsWith('/') && deadline - Date.now() > 0) {
    try {
      const mapped = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'],
        { ...options, timeout: Math.max(1, deadline - Date.now()) }).split('\n').find(entry => entry.startsWith('n/'));
      if (mapped) executable = mapped.slice(1);
    } catch { /* keep the reported command */ }
  }
  const args = execFileSync('/bin/ps', ['-o', 'args=', '-p', String(pid)], { ...options, timeout: Math.max(1, deadline - Date.now()) }).trim();
  return { ppid: Number(match[1]), executable, args };
}

/** A launcher on PATH is often a symlink; installations are recorded by their real path. */
function resolveExecutable(executable: string): string {
  if (!executable.startsWith('/')) return executable;
  try { return realpathSync(executable); } catch { return executable; }
}

/** Never throws: an unreadable ancestry is simply an unidentified caller. */
export function observeCallerAncestry(
  startPid = process.ppid,
  reader?: AncestryReader,
): CallerAncestor[] {
  if (!reader && process.platform !== 'darwin') return [];
  const deadline = Date.now() + BUDGET_MS;
  const read = reader ?? ((pid: number) => readProcess(pid, deadline));
  const ancestors: CallerAncestor[] = [];
  let pid = startPid;
  try {
    for (let level = 0; level < MAX_LEVELS && pid > 1; level += 1) {
      const current = read(pid);
      if (!current) break;
      ancestors.push({ pid, executable: resolveExecutable(current.executable), args: current.args });
      pid = current.ppid;
    }
  } catch { /* partial chains are still useful */ }
  return ancestors;
}

interface InstallationPaths {
  id: string;
  host_variant: string;
  app_path: string | null;
  executable_path: string | null;
}

/** The path must stand as a whole argument, not as a prefix of a longer one. */
function argumentsNamePath(args: string, target: string): boolean {
  for (let at = args.indexOf(target); at !== -1; at = args.indexOf(target, at + 1)) {
    const before = at === 0 ? ' ' : args[at - 1];
    const after = at + target.length >= args.length ? ' ' : args[at + target.length];
    if (/[\s"'=]/u.test(before) && /[\s"']/u.test(after)) return true;
  }
  return false;
}

/** The nearest ancestor that belongs to a discovered host wins. */
export function attributeCaller(db: Database.Database, ancestors: readonly CallerAncestor[]): CallerAttribution {
  const unidentified: CallerAttribution = { installationId: null, hostVariant: null, level: 'unidentified' };
  if (!ancestors.length) return unidentified;
  let rows: InstallationPaths[];
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_installations'").get()) return unidentified;
    // A current Installation outranks a removed record of the same path.
    rows = db.prepare(`SELECT id, host_variant, app_path, executable_path FROM agent_installations
      WHERE health_state='discovered' AND (app_path IS NOT NULL OR executable_path IS NOT NULL)
      ORDER BY (desired_state='removed' OR tombstoned_at IS NOT NULL), (desired_state='managed') DESC, rowid DESC`).all() as InstallationPaths[];
  } catch {
    return unidentified;
  }
  for (const ancestor of ancestors) {
    // An exact executable is more specific than the bundle that contains it.
    const exact = rows.find(row => !row.app_path && row.executable_path === ancestor.executable);
    if (exact) return { installationId: exact.id, hostVariant: exact.host_variant, level: 'verified' };
    const inBundle = rows.find(row => row.app_path && ancestor.executable.startsWith(`${row.app_path}/`));
    if (inBundle) return { installationId: inBundle.id, hostVariant: inBundle.host_variant, level: 'verified' };
    // A CLI run through an interpreter exposes its entry script only in the
    // arguments; a path may contain spaces, so match it as a whole.
    const script = rows.find(row => !row.app_path && row.executable_path
      && argumentsNamePath(ancestor.args, row.executable_path));
    if (script) return { installationId: script.id, hostVariant: script.host_variant, level: 'inferred' };
  }
  return unidentified;
}

/** Latest observed use per configured identity, actual caller and signal. Accounting only. */
export const AGENT_CALLER_OBSERVATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_caller_observations (
  config_agent_id TEXT NOT NULL,
  caller_installation_id TEXT NOT NULL DEFAULT '',
  caller_host_variant TEXT,
  caller_level TEXT NOT NULL CHECK(caller_level IN ('verified','inferred','unidentified')),
  signal_name TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  PRIMARY KEY(config_agent_id,caller_installation_id,signal_name)
);
`;

/** Best effort: accounting must never fail or delay a memory call. */
export function recordCallerObservation(
  db: Database.Database, configAgentId: string, signalName: string,
  attribution: CallerAttribution = currentCallerAttribution(db), observedAt = new Date().toISOString(),
): void {
  try {
    db.prepare(`INSERT INTO agent_caller_observations
      (config_agent_id,caller_installation_id,caller_host_variant,caller_level,signal_name,first_observed_at,last_observed_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(config_agent_id,caller_installation_id,signal_name) DO UPDATE SET
        use_count=use_count+1,caller_host_variant=excluded.caller_host_variant,
        caller_level=excluded.caller_level,last_observed_at=excluded.last_observed_at`)
      .run(configAgentId, attribution.installationId ?? '', attribution.hostVariant, attribution.level, signalName, observedAt, observedAt);
  } catch { /* an older ledger without the table records nothing */ }
}

/**
 * The Installation whose managed configuration this one reads. A second entry
 * point of the same product (for example a CLI next to its desktop app) has no
 * connection of its own: it loads the files written for its sibling.
 */
export function configurationOwnerId(db: Database.Database, installationId: string): string | null {
  try {
    const row = db.prepare(`SELECT desired_state, family, config_root, runtime_realm, os_user_identity
      FROM agent_installations WHERE id=?`).get(installationId) as
      { desired_state: string; family: string; config_root: string | null; runtime_realm: string; os_user_identity: string } | undefined;
    if (!row) return null;
    if (row.desired_state !== 'unmanaged' || !row.config_root) return installationId;
    const owner = db.prepare(`SELECT id FROM agent_installations WHERE id!=? AND family=? AND config_root=?
      AND runtime_realm=? AND os_user_identity=? AND desired_state IN ('managed','disabled') AND tombstoned_at IS NULL
      ORDER BY (desired_state='managed') DESC, rowid DESC LIMIT 1`).get(installationId, row.family, row.config_root, row.runtime_realm, row.os_user_identity) as { id: string } | undefined;
    return owner?.id ?? installationId;
  } catch {
    return null;
  }
}

/**
 * A host the user explicitly disconnected must not keep reading memory through
 * another host's imported configuration. Only a verified caller triggers this:
 * an inferred one rests on forgeable arguments and must not lock anyone out.
 */
export function callerWasDisconnected(db: Database.Database, attribution: CallerAttribution): boolean {
  if (attribution.level !== 'verified' || !attribution.installationId) return false;
  try {
    const row = db.prepare(`SELECT desired_state, tombstoned_at, family, config_root, runtime_realm, os_user_identity
      FROM agent_installations WHERE id=?`).get(attribution.installationId) as
      { desired_state: string; tombstoned_at: string | null; family: string; config_root: string | null; runtime_realm: string; os_user_identity: string } | undefined;
    if (!row) return false;
    if (row.desired_state === 'removed' || row.tombstoned_at !== null) return true;
    if (row.desired_state !== 'unmanaged' || !row.config_root) return false;
    // An entry point without its own connection follows the sibling whose configuration it reads.
    const siblings = db.prepare(`SELECT desired_state, tombstoned_at FROM agent_installations WHERE id!=? AND family=? AND config_root=?
      AND runtime_realm=? AND os_user_identity=?`).all(attribution.installationId, row.family, row.config_root, row.runtime_realm, row.os_user_identity) as
      Array<{ desired_state: string; tombstoned_at: string | null }>;
    return siblings.some(item => item.desired_state === 'removed' || item.tombstoned_at !== null)
      && !siblings.some(item => ['managed','disabled'].includes(item.desired_state) && item.tombstoned_at === null);
  } catch {
    return false;
  }
}

let cachedAncestry: CallerAncestor[] | null = null;

/** The ancestry of a process does not change, so it is read once. */
export function currentCallerAttribution(db: Database.Database): CallerAttribution {
  cachedAncestry ??= observeCallerAncestry();
  return attributeCaller(db, cachedAncestry);
}
