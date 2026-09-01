import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { AGENT_INTEGRATION_TABLES as AGENT_TABLES } from '../../src/db/agent-integration-schema.js';

const RUNTIME_TABLES = [
  'model_connections',
  'llm_usage_log',
  'llm_connection_health',
  'llm_connection_probe_leases',
  'cli_capacity_leases',
  'cli_invocations',
  'pending_digests',
] as const;

const LATEST_MARKERS: Record<(typeof RUNTIME_TABLES)[number], string> = {
  model_connections: 'last_test_summary',
  llm_usage_log: 'invocation_outcome',
  llm_connection_health: 'needs_user_action',
  llm_connection_probe_leases: 'expires_at',
  cli_capacity_leases: 'fencing_token',
  cli_invocations: 'prompt_committed',
  pending_digests: 'ambiguous_invocation_id',
};

const coreSource = readFileSync(
  fileURLToPath(new URL('../../src/db/schema.ts', import.meta.url)),
  'utf8',
);
const clientSource = readFileSync(
  fileURLToPath(new URL('../../client/electron/db.ts', import.meta.url)),
  'utf8',
);
const migrationHelperSource = readFileSync(
  fileURLToPath(new URL('../../src/db/migration-helpers.ts', import.meta.url)),
  'utf8',
);
const agentIntegrationSchemaSource = readFileSync(
  fileURLToPath(new URL('../../src/db/agent-integration-schema.ts', import.meta.url)),
  'utf8',
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function definitions(source: string, table: string): string[] {
  const name = escapeRegExp(table);
  const tablePattern = new RegExp(
    `CREATE TABLE(?: IF NOT EXISTS)?\\s+${name}\\s*\\([\\s\\S]*?\\n\\s*\\);`,
    'g',
  );
  const indexPattern = new RegExp(
    `CREATE\\s+(?:UNIQUE\\s+)?INDEX IF NOT EXISTS\\s+[^\\s;]+\\s+ON\\s+${name}\\s*\\([^;]+\\);`,
    'g',
  );
  const indexes = source.match(indexPattern) ?? [];
  return (source.match(tablePattern) ?? [])
    .filter(tableSql => tableSql.includes(LATEST_MARKERS[table as keyof typeof LATEST_MARKERS]))
    .map(tableSql => [
      tableSql,
      ...indexes,
    ].join('\n'));
}

function signature(sql: string) {
  const db = new Database(':memory:');
  try {
    db.exec(sql);
    const table = RUNTIME_TABLES.find(candidate =>
      new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+${escapeRegExp(candidate)}\\b`).test(sql),
    );
    if (!table) throw new Error('runtime table definition not found');
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list("${table}")`).all();
    const checks = [...sql.matchAll(/CHECK\s*\(([^)]*)\)/gi)]
      .map(match => match[1].replace(/\s+/g, ' ').trim())
      .sort();
    const indexes = (db.prepare(`PRAGMA index_list("${table}")`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>).map(index => ({
      unique: index.unique,
      origin: index.origin,
      columns: (db.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{
        seqno: number;
        name: string;
      }>).sort((a, b) => a.seqno - b.seqno).map(column => column.name),
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { columns, foreignKeys, checks, indexes };
  } finally {
    db.close();
  }
}

describe('core/client CLI runtime schema parity', () => {
  for (const table of RUNTIME_TABLES) {
    it(`keeps ${table} identical in every fresh schema entrypoint`, () => {
      const coreDefinitions = definitions(
        `${coreSource}\n${table === 'pending_digests' ? migrationHelperSource : ''}`,
        table,
      );
      const clientDefinitions = definitions(clientSource, table);
      expect(coreDefinitions.length, `core ${table} definition`).toBeGreaterThan(0);
      expect(clientDefinitions.length, `client ${table} definitions`).toBeGreaterThanOrEqual(2);
      const expected = signature(coreDefinitions[0]);
      for (const definition of [...coreDefinitions, ...clientDefinitions]) {
        expect(signature(definition), table).toEqual(expected);
      }
    });
  }
});

describe('core/client local Agent schema parity', () => {
  it('keeps one authoritative definition for every managed Agent table', () => {
    for (const table of AGENT_TABLES) {
      expect(
        new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(`).test(agentIntegrationSchemaSource),
        table,
      ).toBe(true);
    }
  });

  it('wires the shared definition into daemon fresh/migration and both Electron entrypoints', () => {
    expect(coreSource).toContain('${AGENT_INTEGRATION_SCHEMA_SQL}');
    expect(coreSource).toContain('version: 34');
    expect(coreSource.match(/ensureAgentIntegrationSchema\(db\)/g)).toHaveLength(2);
    expect(clientSource.match(/ensureAgentIntegrationSchema\(newDb\)/g)).toHaveLength(1);
    expect(clientSource.match(/ensureAgentIntegrationSchema\(tmpDb\)/g)).toHaveLength(1);
  });
});
