// ============================================================
// Apple Notes protobuf 解码层
//
// ZICNOTEDATA.ZDATA → gunzip → protobuf decode → 纯文本
// ============================================================

import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { createLogger } from '../../utils/logger.js';
import { PARAGRAPH_STYLES, ATTACHMENT_UTIS, type AttachmentText } from './types.js';

const log = createLogger('apple-notes-proto');

// U+FFFC - Unicode Object Replacement Character（嵌入对象占位符）
const OBJECT_REPLACEMENT_CHAR = '\uFFFC';

// ======== Proto 加载（单例） ========

let protoRoot: protobuf.Root | null = null;

/**
 * 查找 notestore.proto 文件路径。
 *
 * 候选路径顺序（与 src/config.ts 的 findSourceDataDir 一致）：
 * 1. 从 dist/integrations/apple-notes/ 上三级到仓库根
 * 2. 从 src/integrations/apple-notes/ 上三级到仓库根（vitest / tsx 运行）
 * 3. Electron 打包后的 process.resourcesPath
 */
function findProtoPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'data', 'proto', 'notestore.proto'),
    path.resolve(__dirname, '..', '..', '..', '..', 'data', 'proto', 'notestore.proto'),
    ...('resourcesPath' in process
      ? [path.join((process as unknown as { resourcesPath: string }).resourcesPath, 'data', 'proto', 'notestore.proto')]
      : []),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(
    `notestore.proto not found. Searched:\n${candidates.map(c => `  - ${c}`).join('\n')}`,
  );
}

async function getProtoRoot(): Promise<protobuf.Root> {
  if (protoRoot) return protoRoot;

  const protoPath = findProtoPath();
  log.info(`加载 proto 定义: ${protoPath}`);
  protoRoot = await protobuf.load(protoPath);
  return protoRoot;
}

// 同步版本（在 proto 已加载后使用）
function getProtoRootSync(): protobuf.Root {
  if (!protoRoot) {
    throw new Error('Proto root not initialized. Call initProto() first.');
  }
  return protoRoot;
}

/** 预加载 proto 定义（在 startAppleNotesSource 时调用一次） */
export async function initProto(): Promise<void> {
  await getProtoRoot();
}

// ======== 解码 ========

/** 解码后的笔记数据 */
export interface DecodedNote {
  noteText: string;
  attributeRuns: DecodedAttributeRun[];
}

export interface DecodedAttributeRun {
  length: number;
  paragraphStyle?: {
    styleType: number;
    alignment?: number;
    indentAmount?: number;
    checklist?: { uuid: Buffer; done: boolean };
    blockQuote?: number;
  };
  fontWeight?: number;
  underlined?: number;
  strikethrough?: number;
  link?: string;
  attachmentInfo?: {
    attachmentIdentifier: string;
    typeUti: string;
  };
}

/**
 * 解码 ZICNOTEDATA.ZDATA blob。
 * @param zdata 原始 BLOB（gzip 压缩的 protobuf）
 * @returns 解码后的笔记文本和属性运行列表
 */
export function decodeNoteData(zdata: Buffer): DecodedNote | null {
  try {
    // 1. gzip 解压
    // 对空 blob / 1 字节残包做长度检测，避免 zdata[0] 访问 undefined
    let decompressed: Buffer;
    if (zdata.length >= 2 && zdata[0] === 0x1f && zdata[1] === 0x8b) {
      decompressed = gunzipSync(zdata);
    } else {
      // 可能是未压缩的 protobuf
      decompressed = zdata;
    }

    // 2. protobuf 解码
    const root = getProtoRootSync();
    const NoteStoreProto = root.lookupType('NoteStoreProto');
    const message = NoteStoreProto.decode(decompressed) as unknown as {
      document: {
        version: number;
        note: {
          noteText: string;
          attributeRun: Array<{
            length: number;
            paragraphStyle?: {
              styleType?: number;
              alignment?: number;
              indentAmount?: number;
              checklist?: { uuid: Buffer; done: number };
              blockQuote?: number;
            };
            fontWeight?: number;
            underlined?: number;
            strikethrough?: number;
            link?: string;
            attachmentInfo?: {
              attachmentIdentifier?: string;
              typeUti?: string;
            };
          }>;
        };
      };
    };

    const note = message.document.note;

    return {
      noteText: note.noteText,
      attributeRuns: (note.attributeRun || []).map(ar => ({
        length: ar.length,
        paragraphStyle: ar.paragraphStyle
          ? {
              styleType: ar.paragraphStyle.styleType ?? -1,
              alignment: ar.paragraphStyle.alignment,
              indentAmount: ar.paragraphStyle.indentAmount,
              checklist: ar.paragraphStyle.checklist
                ? { uuid: ar.paragraphStyle.checklist.uuid, done: ar.paragraphStyle.checklist.done === 1 }
                : undefined,
              blockQuote: ar.paragraphStyle.blockQuote,
            }
          : undefined,
        fontWeight: ar.fontWeight,
        underlined: ar.underlined,
        strikethrough: ar.strikethrough,
        link: ar.link,
        attachmentInfo: ar.attachmentInfo?.attachmentIdentifier
          ? {
              attachmentIdentifier: ar.attachmentInfo.attachmentIdentifier,
              typeUti: ar.attachmentInfo.typeUti ?? '',
            }
          : undefined,
      })),
    };
  } catch (err) {
    log.error('protobuf 解码失败:', (err as Error).message);
    return null;
  }
}

// ======== 正文构建 ========

/**
 * 从解码后的笔记数据构建纯文本。
 *
 * 实现策略（按字符驱动，per-position 查找所在 run）：
 * 1. 为每个 noteText 字符位置建立 "所在 attribute_run" 的索引
 * 2. 按字符遍历，遇到换行符后，查找新行起始位置的 run，判断是否清单段落
 * 3. U+FFFC 占位符移除（仅当所在 run 有 attachment_info 且不是 hashtag/mention）
 * 4. 附件文本追加到正文末尾
 *
 * 比原来的实现更健壮：
 * - 不依赖 "清单 run 的起始 offset 恰好等于行首"
 * - 一行中间即使被拆成多个 run（因为内嵌 attachment 等），第一个 run 能正确检测到清单样式
 */
export function buildCleanText(
  decoded: DecodedNote,
  attachmentTexts: AttachmentText[] = [],
): string {
  const { noteText, attributeRuns } = decoded;
  if (!noteText) return '';

  // 为每个字符位置建立 "所属 attribute_run index" 映射
  // runIndexForPosition[i] = i 位置所在 run 的索引
  const runIndexForPosition = new Int32Array(noteText.length);
  {
    let pos = 0;
    for (let rIdx = 0; rIdx < attributeRuns.length; rIdx++) {
      const run = attributeRuns[rIdx];
      const end = Math.min(pos + run.length, noteText.length);
      for (let i = pos; i < end; i++) {
        runIndexForPosition[i] = rIdx;
      }
      pos = end;
      if (pos >= noteText.length) break;
    }
  }

  const getRunAt = (pos: number): DecodedAttributeRun | null => {
    if (pos < 0 || pos >= noteText.length) return null;
    return attributeRuns[runIndexForPosition[pos]] ?? null;
  };

  const parts: string[] = [];
  let atLineStart = true;

  for (let i = 0; i < noteText.length; i++) {
    const ch = noteText[i];

    // 行首：检查该行的段落样式，插入清单标注
    if (atLineStart) {
      atLineStart = false;
      const run = getRunAt(i);
      if (run?.paragraphStyle?.styleType === PARAGRAPH_STYLES.CHECKLIST && run.paragraphStyle.checklist) {
        parts.push(run.paragraphStyle.checklist.done ? '[已完成] ' : '[未完成] ');
      }
    }

    if (ch === '\n') {
      parts.push(ch);
      atLineStart = true;
      continue;
    }

    // U+FFFC 处理：如果所在 run 有 attachment_info 则移除
    // （hashtag/mention 的文字内容本身不是 U+FFFC，所以移除 U+FFFC 不影响可读性）
    if (ch === OBJECT_REPLACEMENT_CHAR) {
      const run = getRunAt(i);
      if (run?.attachmentInfo) {
        continue;
      }
    }

    parts.push(ch);
  }

  let result = parts.join('');

  // 追加附件文本
  const textParts: string[] = [];
  for (const att of attachmentTexts) {
    if (att.ocrSummary?.trim()) {
      const label = att.typeUti?.includes('drawing') ? '手写识别' : '图片识别';
      textParts.push(`[${label}: ${att.ocrSummary.trim()}]`);
    }
    if (att.additionalIndexableText?.trim()) {
      const label = att.typeUti === ATTACHMENT_UTIS.AUDIO ? '音频转录' : '手写识别';
      textParts.push(`[${label}: ${att.additionalIndexableText.trim()}]`);
    }
  }

  if (textParts.length > 0) {
    result = result.trimEnd() + '\n\n' + textParts.join('\n');
  }

  // 清理：多余空行合并，首尾空白
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  return result;
}

// ======== 标题位置提取 ========

/** 标题位置信息（供分段器使用） */
export interface HeadingPosition {
  offset: number;
  styleType: number; // 0=title, 1=heading, 2=subheading
}

/**
 * 提取笔记中标题的字符偏移位置。
 * 用于分段时在标题边界处切分。
 */
export function extractHeadingPositions(decoded: DecodedNote): HeadingPosition[] {
  const positions: HeadingPosition[] = [];
  let offset = 0;

  for (const ar of decoded.attributeRuns) {
    const styleType = ar.paragraphStyle?.styleType;
    if (
      styleType === PARAGRAPH_STYLES.TITLE ||
      styleType === PARAGRAPH_STYLES.HEADING ||
      styleType === PARAGRAPH_STYLES.SUBHEADING
    ) {
      positions.push({ offset, styleType });
    }
    offset += ar.length;
  }

  return positions;
}
