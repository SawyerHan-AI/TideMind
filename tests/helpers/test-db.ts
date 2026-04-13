/**
 * 测试用内存数据库工具
 */
import { createTestDb } from '../../src/db/connection.js';
import { createNode } from '../../src/db/nodes.js';
import { createLink } from '../../src/db/links.js';
import type Database from 'better-sqlite3';
import type { BrainNode, BrainLink, NodeType, RelationType, LinkRelation, LinkStatus } from '../../src/types.js';

/**
 * 创建内存测试数据库（含完整 schema + FTS5，不含 sqlite-vec）
 */
export function setupTestDb(): Database.Database {
  return createTestDb();
}

/**
 * 创建测试节点
 */
export function seedNode(
  db: Database.Database,
  overrides: Partial<{
    type: NodeType;
    content: string;
    title: string;
    heat: number;
    refinement: number;
    independence: number;
    specificity: number;
    subjectivity: number;
    actuality: number;
    tags: string[];
    source_tool: string;
    source_session: string;
  }> = {},
): BrainNode {
  const type = overrides.type ?? 'fact';
  return createNode(db, {
    type,
    content: overrides.content ?? `test node ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: overrides.title,
    heat: overrides.heat,
    refinement: overrides.refinement,
    independence: overrides.independence,
    specificity: overrides.specificity,
    subjectivity: overrides.subjectivity,
    actuality: overrides.actuality,
    tags: overrides.tags,
    source_tool: overrides.source_tool,
    source_session: overrides.source_session,
    // 根据 type 自动设置结构角色 flag
    is_meta: type === 'meta' ? 1 : 0,
    is_crystal: type === 'crystal' ? 1 : 0,
    is_tag: type === 'tag' ? 1 : 0,
  });
}

/**
 * 创建测试链接
 */
export function seedLink(
  db: Database.Database,
  fromId: string,
  toId: string,
  overrides: Partial<{
    relation: LinkRelation[];
    strength: number;
    status: LinkStatus;
    note: string;
    auto: boolean;
  }> = {},
): BrainLink | null {
  return createLink(db, {
    from_id: fromId,
    to_id: toId,
    relation: overrides.relation ?? [{ type: 'supports', confidence: 0.7 }],
    strength: overrides.strength,
    note: overrides.note,
    auto: overrides.auto,
    status: overrides.status,
  });
}

/**
 * 批量创建测试节点
 */
export function seedNodes(
  db: Database.Database,
  count: number,
  overrides: Partial<Parameters<typeof seedNode>[1]> = {},
): BrainNode[] {
  const nodes: BrainNode[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push(seedNode(db, {
      ...overrides,
      content: overrides.content ?? `test node ${i}`,
    }));
  }
  return nodes;
}

/**
 * 创建小型连通图（用于扩展/发散测试）
 */
export function seedLinkedGraph(
  db: Database.Database,
  nodeCount: number,
  linkDensity: number = 0.3,
): { nodes: BrainNode[]; links: BrainLink[] } {
  const nodes = seedNodes(db, nodeCount);
  const links: BrainLink[] = [];

  for (let i = 0; i < nodeCount - 1; i++) {
    for (let j = i + 1; j < nodeCount; j++) {
      if (Math.random() < linkDensity) {
        const link = seedLink(db, nodes[i].id, nodes[j].id);
        if (link) links.push(link);
      }
    }
  }

  return { nodes, links };
}
