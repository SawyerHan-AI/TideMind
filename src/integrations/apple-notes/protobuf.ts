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
  return buildCleanTextWithMap(decoded, attachmentTexts).cleanText;
}

/**
 * buildCleanText 的扩展版本：除了返回纯文本，还返回一个偏移映射表。
 *
 * 背景（坐标系一致性 bug）：
 *   - extractHeadingPositions 的 offset 是相对 **原始 noteText** 的字符位置。
 *   - buildCleanText 会对文本做变换（清单行 +6 前缀、U+FFFC -1、附件文本追加、
 *     连续空行折叠、首尾 trim）。
 *   两者坐标系不同，直接拿原始 offset 去 slice cleanText 会切错位置。
 *
 * offsetMap[i] = 原始 noteText 第 i 个字符在最终 cleanText 中的字符偏移。
 * 长度为 noteText.length + 1（额外一位表示 noteText 末尾，便于映射"行尾/段末"位置）。
 * 已被移除的字符（如 U+FFFC、被 trim 掉的首尾空白）映射到其逻辑上最接近的保留位置。
 *
 * 调用方应通过 mapHeadingOffsets() 把 extractHeadingPositions 的结果转换到
 * cleanText 坐标系后再传给 segmentNote。
 */
export function buildCleanTextWithMap(
  decoded: DecodedNote,
  attachmentTexts: AttachmentText[] = [],
): { cleanText: string; offsetMap: Int32Array } {
  const { noteText, attributeRuns } = decoded;
  if (!noteText) return { cleanText: '', offsetMap: new Int32Array(1) };

  // 为每个字符位置建立 "所属 attribute_run index" 映射
  // runIndexForPosition[i] = i 位置所在 run 的索引
  // 默认 -1：当 attribute_runs 长度和 < noteText.length 时，尾部未覆盖的字符
  // 不能默认落到 run 0（若 run 0 有 attachment 会把尾部所有 U+FFFC 剥掉，
  // 或把 CHECKLIST 的 `[未完成]` 前缀错误地加到尾部）。
  const runIndexForPosition = new Int32Array(noteText.length).fill(-1);
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
    const idx = runIndexForPosition[pos];
    if (idx < 0) return null;
    return attributeRuns[idx] ?? null;
  };

  const parts: string[] = [];
  let atLineStart = true;

  // 偏移映射：原始 noteText 位置 i → 当前已构建 cleanText（parts join 后）长度。
  // 多记一位（noteText.length）表示文本末尾。
  const rawToClean = new Int32Array(noteText.length + 1);
  let cleanLen = 0; // 当前 parts 拼接后的字符长度

  for (let i = 0; i < noteText.length; i++) {
    // 在写入本字符前先记录其在 cleanText 中的起始位置。
    // 注意：清单前缀属于"行"而非某个字符，应记在前缀之后、字符本身之前——
    // 这样标题/行的 offset 映射到的是行内容首字符，而非前缀。
    const ch = noteText[i];

    // 行首：检查该行的段落样式，插入清单标注
    if (atLineStart) {
      atLineStart = false;
      const run = getRunAt(i);
      if (run?.paragraphStyle?.styleType === PARAGRAPH_STYLES.CHECKLIST && run.paragraphStyle.checklist) {
        const prefix = run.paragraphStyle.checklist.done ? '[已完成] ' : '[未完成] ';
        parts.push(prefix);
        cleanLen += prefix.length;
      }
    }

    rawToClean[i] = cleanLen;

    if (ch === '\n') {
      parts.push(ch);
      cleanLen += 1;
      atLineStart = true;
      continue;
    }

    // U+FFFC 处理：如果所在 run 有 attachment_info 则移除
    // （hashtag/mention 的文字内容本身不是 U+FFFC，所以移除 U+FFFC 不影响可读性）
    if (ch === OBJECT_REPLACEMENT_CHAR) {
      const run = getRunAt(i);
      if (run?.attachmentInfo) {
        // 被移除的字符映射到其位置（= 下一个保留字符的起点），cleanLen 不变
        continue;
      }
    }

    parts.push(ch);
    cleanLen += 1;
  }
  // 末尾哨兵：noteText 末尾映射到 cleanText 末尾（pre-trim）
  rawToClean[noteText.length] = cleanLen;

  const body = parts.join('');

  // 对 body 应用与原实现完全一致的后处理（\n{3,} 折叠 + 首尾 trim），
  // 同时构建 body 坐标 → 最终 cleanText 坐标的映射 bodyToFinal。
  // 注意：附件文本是追加在 body 末尾的，标题 offset 永远落在 body 范围内，
  // 因此只需追踪 body 部分的坐标平移；附件文本不影响 body 内偏移。
  const { transformed: bodyFinal, map: bodyToFinal } = collapseAndTrim(body);

  // 把 rawToClean（原始 → body 坐标）再经 bodyToFinal（body → 最终）复合，
  // 得到 offsetMap（原始 noteText → 最终 cleanText body 部分坐标）。
  const offsetMap = new Int32Array(noteText.length + 1);
  for (let i = 0; i <= noteText.length; i++) {
    const bodyPos = rawToClean[i];
    offsetMap[i] = bodyToFinal[Math.min(bodyPos, body.length)];
  }

  // 追加附件文本（在 body 后处理之后拼接，不影响 offsetMap）
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

  let cleanText = bodyFinal;
  if (textParts.length > 0) {
    // 与原实现一致：附件文本前再 trimEnd 一次（bodyFinal 已 trim，幂等）+ 双换行分隔
    cleanText = cleanText.trimEnd() + '\n\n' + textParts.join('\n');
  }

  return { cleanText, offsetMap };
}

/**
 * 对字符串做 `replace(/\n{3,}/g, '\n\n')` + 首尾 `trim()`，
 * 同时返回每个原始位置 i（0..len）映射到变换后字符串中的位置。
 *
 * map[i] = 原字符串第 i 个字符在变换后的位置；被删除的字符映射到删除区段
 * 之后第一个保留字符的位置（clamp 到变换后长度）。
 */
function collapseAndTrim(s: string): { transformed: string; map: Int32Array } {
  const n = s.length;
  // keep[i] = 原位置 i 的字符是否保留
  const keep = new Uint8Array(n);

  // 1) \n{3,} → \n\n：在每段 3+ 连续换行中，仅保留前两个
  let i = 0;
  while (i < n) {
    if (s[i] === '\n') {
      let j = i;
      while (j < n && s[j] === '\n') j++;
      const runLen = j - i;
      const keepCount = runLen >= 3 ? 2 : runLen;
      for (let k = 0; k < runLen; k++) keep[i + k] = k < keepCount ? 1 : 0;
      i = j;
    } else {
      keep[i] = 1;
      i++;
    }
  }

  // 2) trim：去掉变换后字符串的首尾空白。
  //    先算出折叠后保留字符的序列与其原始下标，再裁掉首尾空白对应的保留标记。
  const keptIndices: number[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) keptIndices.push(k);

  // 折叠后字符串
  let collapsed = '';
  for (const k of keptIndices) collapsed += s[k];

  // 计算 trim 的左右边界（基于 collapsed）
  let left = 0;
  while (left < collapsed.length && /\s/.test(collapsed[left])) left++;
  let right = collapsed.length;
  while (right > left && /\s/.test(collapsed[right - 1])) right--;

  // 标记被 trim 掉的首尾字符为不保留
  for (let p = 0; p < left; p++) keep[keptIndices[p]] = 0;
  for (let p = right; p < collapsed.length; p++) keep[keptIndices[p]] = 0;

  const transformed = collapsed.slice(left, right);

  // 3) 构建 map：原位置 i → 变换后位置
  const map = new Int32Array(n + 1);
  let out = 0;
  for (let p = 0; p <= n; p++) {
    map[p] = out;
    if (p < n && keep[p]) out++;
  }
  return { transformed, map };
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

/**
 * 把 extractHeadingPositions 返回的标题位置（相对原始 noteText 的 offset）
 * 转换到 cleanText 坐标系。
 *
 * 必须在调用 segmentNote 之前做这层转换，否则会用原始坐标去 slice 变换后的
 * cleanText，导致清单/附件较多的长笔记切错位置（headings 落在内容中间）。
 *
 * @param headings  extractHeadingPositions 的输出
 * @param offsetMap buildCleanTextWithMap 返回的映射表
 */
export function mapHeadingOffsets(
  headings: HeadingPosition[],
  offsetMap: Int32Array,
): HeadingPosition[] {
  const maxRaw = offsetMap.length - 1; // = noteText.length
  return headings.map(h => {
    const raw = h.offset < 0 ? 0 : h.offset > maxRaw ? maxRaw : h.offset;
    return { offset: offsetMap[raw], styleType: h.styleType };
  });
}
