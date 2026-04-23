/**
 * 迁移脚本：修复已同步的 Logseq 节点中被去掉的 Markdown 格式
 *
 * 背景：旧的预处理器会去掉 `- `（大纲前缀）、`[[]]`（双链）、`#tag`（标签），
 *       新版预处理器已改为保留这些格式。本脚本对已入库的节点重新预处理并更新 content。
 *
 * 用法：npx tsx scripts/migrate-logseq-markdown.ts [--dry-run]
 */

import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { preprocessFile } from '../src/integrations/logseq/preprocessor.js';
import { segmentContent } from '../src/integrations/logseq/segmenter.js';

// 简单控制台 logger（脚本不引 runtime logger，避免顺带拉进一堆依赖）
const log = {
  warn(meta: Record<string, unknown>, msg: string) {
    console.warn(`⚠️  ${msg}`, meta);
  },
};

// ---- 配置 ----

const dryRun = process.argv.includes('--dry-run');

// 数据目录
function getDataDir(): string {
  const configPath = path.join(os.homedir(), '.tidemind', 'config.toml');
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    const match = content.match(/data_dir\s*=\s*["']([^"']+)["']/);
    if (match) return match[1].replace('~', os.homedir());
  }
  return path.join(os.homedir(), '.tidemind');
}

const dataDir = getDataDir();
const dbPath = path.join(dataDir, 'graph', 'brain.sqlite');

if (!fs.existsSync(dbPath)) {
  console.error(`❌ 数据库不存在: ${dbPath}`);
  process.exit(1);
}

// ---- 打开数据库 ----

const db = new Database(dbPath);
db.pragma('busy_timeout = 10000');
db.pragma('journal_mode = WAL');

// ---- 找到所有 Logseq 笔记源 ----

interface NoteSource {
  id: string;
  name: string;
  tool_type: string;
  path: string;
}

const logseqSources = db.prepare(
  "SELECT id, name, tool_type, path FROM note_sources WHERE tool_type = 'logseq' AND archived = 0",
).all() as NoteSource[];

if (logseqSources.length === 0) {
  console.log('ℹ️  没有找到活跃的 Logseq 笔记源，无需迁移。');
  db.close();
  process.exit(0);
}

console.log(`📋 找到 ${logseqSources.length} 个 Logseq 笔记源`);
if (dryRun) console.log('🔍 DRY RUN 模式 — 不会修改数据库\n');

// ---- 准备 SQL ----

const getFileStatesStmt = db.prepare(
  'SELECT file_path, node_ids FROM logseq_sync WHERE source_id = ? AND node_ids IS NOT NULL',
);

const getNodeContentStmt = db.prepare(
  'SELECT id, content FROM nodes WHERE id = ?',
);

// 直接更新 content，不创建版本历史（这是格式修复，不是内容变更）
const updateContentStmt = db.prepare(
  'UPDATE nodes SET content = ? WHERE id = ?',
);

// ---- 工具函数 ----

/**
 * 将新格式的内容"降级"回旧格式，用于和旧节点内容匹配
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/^(\s*)- /gm, '$1')       // 去掉 `- ` 前缀
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // [[Page]] → Page
    .replace(/#\[\[([^\]]+)\]\]/g, '$1') // #[[tag]] → tag
    .replace(/(?<!\w)#([\w\u4e00-\u9fff][\w\u4e00-\u9fff/-]*)/g, (_m, tag) => {
      return /^\d+$/.test(tag) ? _m : tag; // #tag → tag（排除纯数字）
    });
}

/**
 * 规范化空白用于比较（去掉多余空行、行尾空白）
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 对段数不匹配的情况，用内容匹配找到旧节点对应的新 segment
 * 返回 Map<nodeId, newContent>
 */
function fuzzyMatchSegments(
  nodeIds: string[],
  newSegments: Array<{ content: string }>,
): Map<string, string> {
  const result = new Map<string, string>();
  const usedSegmentIndices = new Set<number>();

  // 预计算：新 segments 降级后的内容
  const newStripped = newSegments.map(s => normalizeWhitespace(stripMarkdown(s.content)));

  for (const nodeId of nodeIds) {
    const existing = getNodeContentStmt.get(nodeId) as
      | { id: string; content: string }
      | undefined;
    if (!existing) continue;

    const oldNorm = normalizeWhitespace(existing.content);

    // 先找完全匹配（降级后一致）
    let bestIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < newStripped.length; i++) {
      if (usedSegmentIndices.has(i)) continue;

      if (newStripped[i] === oldNorm) {
        bestIdx = i;
        bestScore = 1;
        break;
      }

      // 计算简单相似度：公共前缀长度占比
      const score = commonPrefixRatio(oldNorm, newStripped[i]);
      if (score > bestScore && score > 0.5) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      usedSegmentIndices.add(bestIdx);
      result.set(nodeId, newSegments[bestIdx].content);
    }
  }

  return result;
}

/**
 * 公共前缀长度占较短字符串长度的比例
 */
function commonPrefixRatio(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length);
  if (minLen === 0) return 0;
  let i = 0;
  while (i < minLen && a[i] === b[i]) i++;
  return i / minLen;
}

// ---- 统计 ----

let totalFiles = 0;
let totalNodes = 0;
let updatedNodes = 0;
let skippedFiles = 0;
let fuzzyMatchedFiles = 0;
let fuzzyMatchedNodes = 0;

// ---- 迁移逻辑 ----

for (const source of logseqSources) {
  const graphRoot = source.path.replace('~', os.homedir());
  console.log(`\n🔄 处理笔记源: ${source.name} (${graphRoot})`);

  if (!fs.existsSync(graphRoot)) {
    console.log(`   ⚠️  目录不存在，跳过`);
    continue;
  }

  const fileStates = getFileStatesStmt.all(source.id) as Array<{
    file_path: string;
    node_ids: string;
  }>;

  console.log(`   📁 同步文件数: ${fileStates.length}`);

  for (const state of fileStates) {
    const nodeIds: string[] = JSON.parse(state.node_ids);
    if (nodeIds.length === 0) continue;

    totalFiles++;

    const absPath = path.join(graphRoot, state.file_path);

    // 路径穿越防护：DB 里的 file_path 理论上是相对 graphRoot 的相对路径，
    // 但如果历史数据包含 `..` 或绝对路径，join 之后会走到 graphRoot 外面。
    // 这里用 resolve 归一化后强制要求路径落在 graphRoot 内。
    const resolvedGraphRoot = path.resolve(graphRoot);
    const resolvedAbsPath = path.resolve(absPath);
    if (
      !resolvedAbsPath.startsWith(resolvedGraphRoot + path.sep) &&
      resolvedAbsPath !== resolvedGraphRoot
    ) {
      log.warn({ absPath: resolvedAbsPath, graphRoot: resolvedGraphRoot }, 'path-escapes-graphRoot-skipping');
      skippedFiles++;
      continue;
    }

    if (!fs.existsSync(absPath)) {
      skippedFiles++;
      continue;
    }

    // 用新的预处理器重新处理
    const preprocessed = preprocessFile(absPath, graphRoot);
    if (!preprocessed) {
      skippedFiles++;
      continue;
    }

    // 重新分段
    const isJournal = state.file_path.startsWith('journals/');
    const newSegments = segmentContent(
      preprocessed.cleanContent,
      preprocessed.title,
      isJournal,
    );

    if (newSegments.length === nodeIds.length) {
      // 段数匹配：按顺序一一对应
      for (let i = 0; i < nodeIds.length; i++) {
        const nodeId = nodeIds[i];
        const newContent = newSegments[i].content;

        const existing = getNodeContentStmt.get(nodeId) as
          | { id: string; content: string }
          | undefined;
        if (!existing) continue;

        totalNodes++;
        if (existing.content === newContent) continue;

        if (!dryRun) {
          updateContentStmt.run(newContent, nodeId);
        }
        updatedNodes++;
      }
    } else {
      // 段数不匹配：用 fuzzy match 按内容相似度匹配
      fuzzyMatchedFiles++;
      const matched = fuzzyMatchSegments(nodeIds, newSegments);

      for (const [nodeId, newContent] of matched) {
        const existing = getNodeContentStmt.get(nodeId) as
          | { id: string; content: string }
          | undefined;
        if (!existing) continue;

        totalNodes++;
        if (existing.content === newContent) continue;

        if (!dryRun) {
          updateContentStmt.run(newContent, nodeId);
        }
        updatedNodes++;
        fuzzyMatchedNodes++;
      }
    }
  }
}

// ---- 报告 ----

console.log('\n' + '='.repeat(50));
console.log(`📊 迁移${dryRun ? '预览' : '完成'}:`);
console.log(`   处理文件: ${totalFiles}`);
console.log(`   检查节点: ${totalNodes}`);
console.log(`   ${dryRun ? '将更新' : '已更新'}节点: ${updatedNodes}`);
console.log(`   其中 fuzzy 匹配: ${fuzzyMatchedNodes} (${fuzzyMatchedFiles} 个文件)`);
console.log(`   跳过文件（不存在/无法解析）: ${skippedFiles}`);
console.log('='.repeat(50));

db.close();
