/**
 * 批量提升达到阈值的标签为核心标签节点
 *
 * 只创建 tag 节点和 tagged 链接，不调 LLM 生成定义（由日常任务后续补充）。
 *
 * 用法：npx tsx scripts/batch-promote-tags.ts [--dry-run] [--no-backup]
 *
 * 默认在执行写入前会拷贝一份 brain.sqlite 到同目录 .bak.<unix_ts>。
 * 传 --no-backup 可跳过（不建议）。--dry-run 不写入也不备份。
 */

import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import crypto from 'node:crypto';

const dryRun = process.argv.includes('--dry-run');
const noBackup = process.argv.includes('--no-backup');

function getDataDir(): string {
  const configPath = path.join(os.homedir(), '.tidemind', 'config.toml');
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    const match = content.match(/data_dir\s*=\s*["']([^"']+)["']/);
    if (match) return match[1].replace('~', os.homedir());
  }
  return path.join(os.homedir(), '.tidemind');
}

function generateId(): string {
  return crypto.randomBytes(16).toString('base64url').slice(0, 21);
}

function now(): string {
  return new Date().toISOString();
}

function computeTagLinkStrength(nodeContent: string, tagText: string, nodeTags: string[]): number {
  const contentMention = nodeContent.toLowerCase().includes(tagText.toLowerCase()) ? 0.7 : 0.4;
  const concentrationBonus = nodeTags.length === 1 ? 0.1 : 0;
  return Math.min(0.8, contentMention + concentrationBonus);
}

const THRESHOLD = 25;
const MIN_STRENGTH = 0.3;

const dataDir = getDataDir();
const dbPath = path.join(dataDir, 'graph', 'brain.sqlite');

if (!fs.existsSync(dbPath)) {
  console.error(`❌ 数据库不存在: ${dbPath}`);
  process.exit(1);
}

// 备份：在实际写入前保留一份原始 DB，以便回滚。
// --dry-run 不写入，不备份；--no-backup 明确要求跳过。
if (!dryRun && !noBackup) {
  const backupPath = `${dbPath}.bak.${Math.floor(Date.now() / 1000)}`;
  fs.copyFileSync(dbPath, backupPath);
  console.log(`🗄  已备份数据库到: ${backupPath}`);
} else if (noBackup && !dryRun) {
  console.log('⚠️  --no-backup 指定，跳过备份（出错将无法回滚）');
}

const db = new Database(dbPath);
db.pragma('busy_timeout = 10000');
db.pragma('journal_mode = WAL');

// 1. 统计所有标签及其引用的节点
const rows = db.prepare(`
  SELECT id, tags, content FROM nodes
  WHERE tags IS NOT NULL AND heat > 0.01 AND is_tag = 0 AND is_superseded = 0
`).all() as Array<{ id: string; tags: string; content: string }>;

const nodeCache = new Map<string, { content: string; tags: string[] }>();
const tagToNodes = new Map<string, string[]>();

for (const row of rows) {
  let tags: string[];
  try {
    const parsed = JSON.parse(row.tags);
    tags = Array.isArray(parsed) ? parsed : [];
  } catch { continue; }

  nodeCache.set(row.id, { content: row.content, tags });
  for (const tag of tags) {
    if (!tagToNodes.has(tag)) tagToNodes.set(tag, []);
    tagToNodes.get(tag)!.push(row.id);
  }
}

// 2. 找到已存在的 tag 节点
const existingTagNodes = new Map<string, string>();
const tagNodeRows = db.prepare(
  "SELECT id, title, content FROM nodes WHERE is_tag = 1 AND heat > 0.01 AND is_superseded = 0",
).all() as Array<{ id: string; title: string | null; content: string }>;
for (const tn of tagNodeRows) {
  existingTagNodes.set((tn.title ?? tn.content).trim(), tn.id);
}

// 3. 加载降级黑名单
const demotedRaw = db.prepare("SELECT value FROM metadata WHERE key = 'demoted_tags'").get() as { value: string } | undefined;
const demotedTags = new Set<string>(demotedRaw ? JSON.parse(demotedRaw.value) : []);

// 4. 准备 SQL
const insertNodeStmt = db.prepare(`
  INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence,
    specificity, subjectivity, actuality, is_tag, created, version, archived, is_superseded, maturity_score)
  VALUES (?, 'fact', '', ?, 1.0, 0.5, 0.5, 0.5, 0.1, 0.1, 0.9, 1, ?, 1, 0, 0, 0.5)
`);

const insertLinkStmt = db.prepare(`
  INSERT INTO links (id, from_id, to_id, relation, strength, note, auto, status, created)
  VALUES (?, ?, ?, ?, ?, NULL, 1, 'confirmed', ?)
`);

const linkExistsStmt = db.prepare(`
  SELECT 1 FROM links WHERE
    ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
    LIMIT 1
`);

if (dryRun) console.log('🔍 DRY RUN 模式\n');

let promoted = 0;
let linksCreated = 0;

const timestamp = now();

const run = db.transaction(() => {
  for (const [tag, nodeIds] of tagToNodes) {
    if (nodeIds.length < THRESHOLD) continue;
    if (demotedTags.has(tag)) continue;
    if (existingTagNodes.has(tag)) continue;

    // 创建 tag 节点
    const tagNodeId = generateId();
    if (!dryRun) {
      insertNodeStmt.run(tagNodeId, tag, timestamp);
    }
    promoted++;

    // 创建 tagged 链接
    for (const nodeId of nodeIds) {
      const cached = nodeCache.get(nodeId);
      if (!cached) continue;

      const strength = computeTagLinkStrength(cached.content, tag, cached.tags);
      if (strength < MIN_STRENGTH) continue;

      // 检查链接是否已存在
      const exists = linkExistsStmt.get(nodeId, tagNodeId, tagNodeId, nodeId);
      if (exists) continue;

      if (!dryRun) {
        const linkId = generateId();
        insertLinkStmt.run(
          linkId, nodeId, tagNodeId,
          JSON.stringify([{ type: 'tagged', confidence: 0.9 }]),
          strength, timestamp,
        );
      }
      linksCreated++;
    }
  }
});

run();

console.log('='.repeat(50));
console.log(`📊 标签提升${dryRun ? '预览' : '完成'}:`);
console.log(`   ${dryRun ? '将提升' : '已提升'}标签: ${promoted}`);
console.log(`   ${dryRun ? '将创建' : '已创建'}链接: ${linksCreated}`);
console.log('='.repeat(50));

db.close();
