// ============================================================
// Logseq version-files 导入
//
// 将 logseq/version-files/ 中的历史版本导入为 superseded 节点，
// 按时间线串成 updates 链。
//
// 策略：
//   1. 扫描 version-files/local/{pages|journals}/原始名/时间戳.设备.md
//   2. 按原始文件分组，每组按时间戳排序
//   3. 同一天内只保留最后一个版本
//   4. 跨版本 hash 去重（内容相同的跳过）
//   5. 导入为节点，标记 is_superseded=1
//   6. 相邻版本建 updates 链接，最后一个版本 updates → 当前正式版节点
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger.js';
import { preprocessFile } from './preprocessor.js';
import { segmentContent } from './segmenter.js';
import { digest } from '../../tools/digest.js';
import { createLink, linkExists } from '../../db/links.js';

const log = createLogger('logseq-versions');

/** 版本文件信息 */
interface VersionFile {
  absPath: string;
  /** 原始页面/日记名称（目录名） */
  originalName: string;
  /** 版本时间戳（ISO 8601） */
  timestamp: string;
  /** 版本日期（YYYY-MM-DD，用于按天去重） */
  date: string;
  /** 来源类型 */
  source: 'pages' | 'journals';
}

/**
 * 扫描 version-files 目录，返回按原始文件分组的版本列表
 */
export function scanVersionFiles(graphRoot: string): Map<string, VersionFile[]> {
  const versionDir = path.join(graphRoot, 'logseq', 'version-files', 'local');
  if (!fs.existsSync(versionDir)) return new Map();

  const groups = new Map<string, VersionFile[]>();

  for (const sourceType of ['pages', 'journals'] as const) {
    const sourceDir = path.join(versionDir, sourceType);
    if (!fs.existsSync(sourceDir)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const originalName = entry.name;
      const pageDir = path.join(sourceDir, originalName);

      let files: string[];
      try {
        files = fs.readdirSync(pageDir).filter(f => f.endsWith('.md'));
      } catch {
        continue;
      }

      for (const fname of files) {
        // 解析时间戳：2022-10-26T06_05_24.726Z.Desktop.md
        const tsMatch = fname.match(/^(\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}\.\d+Z)/);
        if (!tsMatch) continue;

        const rawTs = tsMatch[1];
        // 还原 ISO 格式：T06_05_24 → T06:05:24
        const isoTs = rawTs.replace(/T(\d{2})_(\d{2})_(\d{2})/, 'T$1:$2:$3');
        const date = isoTs.slice(0, 10);

        const key = `${sourceType}/${originalName}`;
        if (!groups.has(key)) groups.set(key, []);

        groups.get(key)!.push({
          absPath: path.join(pageDir, fname),
          originalName,
          timestamp: isoTs,
          date,
          source: sourceType,
        });
      }
    }
  }

  return groups;
}

/**
 * 对每组版本文件进行去重和筛选
 * - 同一天内只保留最后一个版本
 * - 跨版本 hash 去重（内容相同的跳过）
 */
export function deduplicateVersions(versions: VersionFile[]): VersionFile[] {
  if (versions.length === 0) return [];

  // 按时间戳排序（旧→新）
  const sorted = [...versions].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // 按天分组，每天取最后一个
  const byDay = new Map<string, VersionFile>();
  for (const v of sorted) {
    byDay.set(v.date, v); // 同一天后面的覆盖前面的
  }

  const dailyVersions = [...byDay.values()].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );

  // Hash 去重：相邻版本内容相同则跳过后者
  const result: VersionFile[] = [];
  let prevHash = '';

  for (const v of dailyVersions) {
    const hash = fileHash(v.absPath);
    if (hash === prevHash) continue; // 内容相同，跳过
    result.push(v);
    prevHash = hash;
  }

  return result;
}

/**
 * 导入版本文件为 superseded 节点
 *
 * @param currentNodeIds 当前正式版的节点 ID 列表（Phase 2 入库的）
 * @returns 导入的版本节点数量
 */
export async function importVersionHistory(
  db: Database.Database,
  graphRoot: string,
  fileToNodeIds: Map<string, string[]>,
): Promise<number> {
  const groups = scanVersionFiles(graphRoot);
  if (groups.size === 0) return 0;

  let totalImported = 0;

  for (const [key, versions] of groups) {
    const deduped = deduplicateVersions(versions);
    if (deduped.length === 0) continue;

    // 找到当前正式版的节点 ID
    // key 格式：pages/PageName 或 journals/2022-10-26
    const originalName = deduped[0].originalName;
    // 尝试多种 title 格式匹配
    const title = originalName
      .replace(/___/g, '/')
      .replace(/%2F/gi, '/');
    const currentNodeIds = fileToNodeIds.get(title)
      ?? fileToNodeIds.get(originalName)
      ?? [];

    if (currentNodeIds.length === 0) {
      // 当前版本不存在（可能被删除了），跳过历史版本
      continue;
    }

    // 逐个导入历史版本，建立版本链
    const versionNodeIds: string[] = [];

    for (const v of deduped) {
      try {
        const preprocessed = preprocessFile(v.absPath, graphRoot);
        if (!preprocessed || !preprocessed.cleanContent.trim()) continue;

        const segments = segmentContent(
          preprocessed.cleanContent,
          preprocessed.title,
          v.source === 'journals',
        );
        if (segments.length === 0) continue;

        // 只 digest 第一个 segment（历史版本不需要完整分段）
        const result = await digest(db, {
          content: segments[0].content,
          source: { tool: 'logseq', files: [`version-files/${key}`] },
          context: `Logseq 历史版本: ${title} @ ${v.timestamp}`,
          async: false,
          created: `${v.date}T00:00:00.000Z`,
        });

        const nodeId = result.created_nodes?.[0]?.id;
        if (nodeId) {
          // 立即标记为 superseded
          db.prepare('UPDATE nodes SET is_superseded = 1, heat = 0.01 WHERE id = ?').run(nodeId);
          versionNodeIds.push(nodeId);
          totalImported++;
        }
      } catch (err) {
        log.debug(`版本文件导入失败 ${v.absPath}: ${(err as Error).message}`);
      }
    }

    if (versionNodeIds.length === 0) continue;

    // 建立版本链：v1 → v2 → v3 → ... → current
    // 相邻历史版本之间
    for (let i = 1; i < versionNodeIds.length; i++) {
      if (!linkExists(db, versionNodeIds[i - 1], versionNodeIds[i])) {
        createLink(db, {
          from_id: versionNodeIds[i - 1],
          to_id: versionNodeIds[i],
          relation: [{ type: 'updates', confidence: 0.9 }],
          strength: 0.5,
          note: `Logseq 版本历史: ${title}`,
          auto: true,
          status: 'confirmed',
        });
      }
    }

    // 最后一个历史版本 → 当前正式版
    const lastVersionId = versionNodeIds[versionNodeIds.length - 1];
    const currentFirstId = currentNodeIds[0];
    if (lastVersionId !== currentFirstId && !linkExists(db, lastVersionId, currentFirstId)) {
      createLink(db, {
        from_id: lastVersionId,
        to_id: currentFirstId,
        relation: [{ type: 'updates', confidence: 0.9 }],
        strength: 0.5,
        note: `Logseq 版本历史 → 当前版: ${title}`,
        auto: true,
        status: 'confirmed',
      });
    }
  }

  log.info(`版本文件导入完成: ${totalImported} 个历史版本`);
  return totalImported;
}

// --- 工具 ---

function fileHash(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}
