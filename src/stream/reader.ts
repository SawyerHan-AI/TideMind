import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('stream-reader');

export interface StreamEntry {
  anchorId: string;
  time: string;
  tool?: string;
  session?: string;
  project?: string;
  content: string;
  files?: string[];
}

/**
 * 解析 source_stream 引用为文件路径和锚点
 * 输入格式: "stream/YYYY-MM-DD.md#anchor-id"
 */
export function parseStreamRef(ref: string): { filePath: string; anchorId: string } | null {
  const match = ref.match(/^stream\/(.+\.md)#(.+)$/);
  if (!match) return null;
  return {
    filePath: path.join(getDataDir(), 'stream', match[1]),
    anchorId: match[2],
  };
}

/**
 * 按 source_stream 引用读取特定 stream 条目
 */
export function readStreamEntry(ref: string): StreamEntry | null {
  const parsed = parseStreamRef(ref);
  if (!parsed) return null;

  const { filePath, anchorId } = parsed;
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  const anchorTag = `<a id="${anchorId}"></a>`;
  const anchorPos = content.indexOf(anchorTag);
  if (anchorPos === -1) {
    log.warn(`Stream anchor not found: ${anchorId} in ${filePath}`);
    return null;
  }

  // 从锚点到下一个锚点或文件末尾
  // 用完整的 anchor 形状作为分隔符,不依赖 "s-" 前缀。
  // 早期 migrated 条目的 anchor id 没有 s- 前缀 → 旧 regex 无法匹配,
  // 导致从第一条 anchor 到文件末尾被当作同一 entry,内容错乱。
  // 与 writer.ts 对齐:writer 产出 `<a id="${anchorId}"></a>`,anchorId 由
  // `s-<time>-<nanoid>` 构成,不会含双引号 → `[^"]+` 足以覆盖当前写入格式,
  // 同时兼容历史格式。
  const afterAnchor = content.slice(anchorPos + anchorTag.length);
  const endMatch = afterAnchor.search(/\n<a id="[^"]+"><\/a>/);
  const entryText = endMatch === -1
    ? afterAnchor.trimEnd()
    : afterAnchor.slice(0, endMatch);

  // 去掉尾部分隔符
  const cleaned = entryText.replace(/\n---\s*$/, '').trim();

  // 解析标题行: ## HH:MM:SS · tool · session
  const headingMatch = cleaned.match(/^##\s+(\d{2}:\d{2}:\d{2})(.*)/);
  if (!headingMatch) return null;

  const time = headingMatch[1];
  const metaParts = headingMatch[2].split('·').map(s => s.trim()).filter(Boolean);

  const lines = cleaned.split('\n').slice(1);
  let project: string | undefined;
  let files: string[] | undefined;
  const contentLines: string[] = [];

  for (const line of lines) {
    const projMatch = line.match(/^\[project:\s*(.+)\]$/);
    const filesMatch = line.match(/^files:\s*(.+)$/);
    if (projMatch) {
      project = projMatch[1];
    } else if (filesMatch) {
      files = filesMatch[1].split(',').map(f => f.trim());
    } else {
      contentLines.push(line);
    }
  }

  return {
    anchorId,
    time,
    tool: metaParts[0] || undefined,
    session: metaParts[1] || undefined,
    project,
    content: contentLines.join('\n').trim(),
    files,
  };
}
