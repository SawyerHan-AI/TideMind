/**
 * apple-notes/protobuf.ts 单元测试
 *
 * 测试策略：
 * - 直接调用 buildCleanText 和 extractHeadingPositions 测试纯函数
 * - 对 decodeNoteData 用 protobufjs 自己构造 ZDATA blob（gzip + proto 编码），
 *   无需真实的 NoteStore.sqlite
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import {
  initProto,
  decodeNoteData,
  buildCleanText,
  buildCleanTextWithMap,
  extractHeadingPositions,
  mapHeadingOffsets,
  type DecodedNote,
  type DecodedAttributeRun,
} from '../../../src/integrations/apple-notes/protobuf.js';
import { segmentNote } from '../../../src/integrations/apple-notes/segmenter.js';
import { PARAGRAPH_STYLES, ATTACHMENT_UTIS } from '../../../src/integrations/apple-notes/types.js';

// 加载 proto 以便构造测试 blob
let testProtoRoot: protobuf.Root;

beforeAll(async () => {
  await initProto();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const protoPath = path.resolve(__dirname, '..', '..', '..', 'data', 'proto', 'notestore.proto');
  testProtoRoot = await protobuf.load(protoPath);
});

/**
 * 辅助函数：构造一个合法的 ZDATA blob（用于测试 decodeNoteData）
 */
function buildZData(noteText: string, attributeRuns: unknown[]): Buffer {
  const NoteStoreProto = testProtoRoot.lookupType('NoteStoreProto');
  const payload = {
    document: {
      version: 0,
      note: {
        noteText,
        attributeRun: attributeRuns,
      },
    },
  };
  const err = NoteStoreProto.verify(payload);
  if (err) throw new Error(`构造测试 payload 失败: ${err}`);
  const encoded = NoteStoreProto.encode(NoteStoreProto.fromObject(payload)).finish();
  return gzipSync(Buffer.from(encoded));
}

describe('decodeNoteData', () => {
  it('解码简单笔记', () => {
    const zdata = buildZData('Hello world', [{ length: 11 }]);
    const result = decodeNoteData(zdata);
    expect(result).not.toBeNull();
    expect(result!.noteText).toBe('Hello world');
    expect(result!.attributeRuns).toHaveLength(1);
    expect(result!.attributeRuns[0].length).toBe(11);
  });

  it('解码含标题的笔记', () => {
    const zdata = buildZData('Title\nBody', [
      { length: 5, paragraphStyle: { styleType: PARAGRAPH_STYLES.TITLE } },
      { length: 5 },
    ]);
    const result = decodeNoteData(zdata);
    expect(result).not.toBeNull();
    expect(result!.noteText).toBe('Title\nBody');
    expect(result!.attributeRuns[0].paragraphStyle?.styleType).toBe(PARAGRAPH_STYLES.TITLE);
  });

  it('解码含清单的笔记', () => {
    const uuid = Buffer.from(new Uint8Array(16));
    const zdata = buildZData('Todo item', [
      {
        length: 9,
        paragraphStyle: {
          styleType: PARAGRAPH_STYLES.CHECKLIST,
          checklist: { uuid, done: 1 },
        },
      },
    ]);
    const result = decodeNoteData(zdata);
    expect(result).not.toBeNull();
    expect(result!.attributeRuns[0].paragraphStyle?.checklist?.done).toBe(true);
  });

  it('解码失败时返回 null', () => {
    const invalid = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const result = decodeNoteData(invalid);
    expect(result).toBeNull();
  });
});

describe('buildCleanText', () => {
  it('简单文本保持原样', () => {
    const decoded: DecodedNote = {
      noteText: 'Hello world',
      attributeRuns: [{ length: 11 }],
    };
    expect(buildCleanText(decoded)).toBe('Hello world');
  });

  it('多行文本保留换行', () => {
    const decoded: DecodedNote = {
      noteText: 'Line 1\nLine 2\nLine 3',
      attributeRuns: [{ length: 20 }],
    };
    expect(buildCleanText(decoded)).toBe('Line 1\nLine 2\nLine 3');
  });

  it('未完成清单项标注 [未完成]', () => {
    const decoded: DecodedNote = {
      noteText: 'Buy milk',
      attributeRuns: [
        {
          length: 8,
          paragraphStyle: {
            styleType: PARAGRAPH_STYLES.CHECKLIST,
            checklist: { uuid: Buffer.from([]), done: false },
          },
        },
      ],
    };
    expect(buildCleanText(decoded)).toBe('[未完成] Buy milk');
  });

  it('已完成清单项标注 [已完成]', () => {
    const decoded: DecodedNote = {
      noteText: 'Buy milk',
      attributeRuns: [
        {
          length: 8,
          paragraphStyle: {
            styleType: PARAGRAPH_STYLES.CHECKLIST,
            checklist: { uuid: Buffer.from([]), done: true },
          },
        },
      ],
    };
    expect(buildCleanText(decoded)).toBe('[已完成] Buy milk');
  });

  it('多行清单逐行标注', () => {
    // "Buy milk\nBuy eggs\nBuy bread" 每一行都是清单项
    const decoded: DecodedNote = {
      noteText: 'Buy milk\nBuy eggs\nBuy bread',
      attributeRuns: [
        {
          length: 9,
          paragraphStyle: {
            styleType: PARAGRAPH_STYLES.CHECKLIST,
            checklist: { uuid: Buffer.from([]), done: true },
          },
        },
        {
          length: 9,
          paragraphStyle: {
            styleType: PARAGRAPH_STYLES.CHECKLIST,
            checklist: { uuid: Buffer.from([]), done: false },
          },
        },
        {
          length: 9,
          paragraphStyle: {
            styleType: PARAGRAPH_STYLES.CHECKLIST,
            checklist: { uuid: Buffer.from([]), done: false },
          },
        },
      ],
    };
    const result = buildCleanText(decoded);
    expect(result).toContain('[已完成] Buy milk');
    expect(result).toContain('[未完成] Buy eggs');
    expect(result).toContain('[未完成] Buy bread');
  });

  it('U+FFFC 占位符在有 attachment 的 run 中被移除', () => {
    const decoded: DecodedNote = {
      noteText: 'Before\uFFFCAfter',
      attributeRuns: [
        { length: 6 },
        {
          length: 1,
          attachmentInfo: { attachmentIdentifier: 'xxx', typeUti: 'public.jpeg' },
        },
        { length: 5 },
      ],
    };
    expect(buildCleanText(decoded)).toBe('BeforeAfter');
  });

  it('U+FFFC 占位符在没有 attachment 的 run 中被保留', () => {
    // 边缘 case：U+FFFC 不被 attachment 标记时应保持原样（不改变字符）
    const decoded: DecodedNote = {
      noteText: 'X\uFFFCY',
      attributeRuns: [{ length: 3 }],
    };
    expect(buildCleanText(decoded)).toBe('X\uFFFCY');
  });

  it('hashtag 的 U+FFFC 被移除但标签文字保留', () => {
    // Apple Notes 的 hashtag 编码：U+FFFC 后跟标签名在同一个 attachment run 中
    // 我们移除 U+FFFC，保留标签文字
    const decoded: DecodedNote = {
      noteText: 'See \uFFFC#project next week',
      attributeRuns: [
        { length: 4 },
        {
          length: 9, // "\uFFFC#project"
          attachmentInfo: {
            attachmentIdentifier: 'tag-1',
            typeUti: ATTACHMENT_UTIS.HASHTAG,
          },
        },
        { length: 10 },
      ],
    };
    const result = buildCleanText(decoded);
    expect(result).toBe('See #project next week');
    expect(result).not.toContain('\uFFFC');
  });

  it('附件 OCR 文本追加到正文末尾', () => {
    const decoded: DecodedNote = {
      noteText: 'Note body',
      attributeRuns: [{ length: 9 }],
    };
    const result = buildCleanText(decoded, [
      {
        uuid: 'a1',
        typeUti: 'public.jpeg',
        ocrSummary: '这是图片识别的文字',
        additionalIndexableText: null,
      },
    ]);
    expect(result).toContain('Note body');
    expect(result).toContain('[图片识别: 这是图片识别的文字]');
  });

  it('附件 drawing 使用手写识别标签', () => {
    const decoded: DecodedNote = {
      noteText: 'Sketch',
      attributeRuns: [{ length: 6 }],
    };
    const result = buildCleanText(decoded, [
      {
        uuid: 'd1',
        typeUti: 'com.apple.drawing.2',
        ocrSummary: '手写内容',
        additionalIndexableText: null,
      },
    ]);
    expect(result).toContain('[手写识别: 手写内容]');
  });

  it('音频附件使用音频转录标签', () => {
    const decoded: DecodedNote = {
      noteText: 'Recording',
      attributeRuns: [{ length: 9 }],
    };
    const result = buildCleanText(decoded, [
      {
        uuid: 'a1',
        typeUti: ATTACHMENT_UTIS.AUDIO,
        ocrSummary: null,
        additionalIndexableText: '这是音频的转录文字',
      },
    ]);
    expect(result).toContain('[音频转录: 这是音频的转录文字]');
  });

  it('多余空行会被合并', () => {
    const decoded: DecodedNote = {
      noteText: 'Para 1\n\n\n\n\nPara 2',
      attributeRuns: [{ length: 17 }],
    };
    const result = buildCleanText(decoded);
    expect(result).toBe('Para 1\n\nPara 2');
  });

  it('空 noteText 返回空字符串', () => {
    const decoded: DecodedNote = { noteText: '', attributeRuns: [] };
    expect(buildCleanText(decoded)).toBe('');
  });

  it('没有 attribute_run 时按纯文本处理', () => {
    const decoded: DecodedNote = {
      noteText: 'Plain text without runs',
      attributeRuns: [],
    };
    expect(buildCleanText(decoded)).toBe('Plain text without runs');
  });
});

describe('extractHeadingPositions', () => {
  it('无标题返回空数组', () => {
    const decoded: DecodedNote = {
      noteText: 'Just text',
      attributeRuns: [{ length: 9 }],
    };
    expect(extractHeadingPositions(decoded)).toEqual([]);
  });

  it('识别 title / heading / subheading', () => {
    const decoded: DecodedNote = {
      noteText: 'Title\nHeading\nSub',
      attributeRuns: [
        { length: 6, paragraphStyle: { styleType: PARAGRAPH_STYLES.TITLE } },
        { length: 8, paragraphStyle: { styleType: PARAGRAPH_STYLES.HEADING } },
        { length: 3, paragraphStyle: { styleType: PARAGRAPH_STYLES.SUBHEADING } },
      ],
    };
    const positions = extractHeadingPositions(decoded);
    expect(positions).toHaveLength(3);
    expect(positions[0].offset).toBe(0);
    expect(positions[0].styleType).toBe(PARAGRAPH_STYLES.TITLE);
    expect(positions[1].offset).toBe(6);
    expect(positions[1].styleType).toBe(PARAGRAPH_STYLES.HEADING);
    expect(positions[2].offset).toBe(14);
  });

  it('普通段落不被识别为标题', () => {
    const decoded: DecodedNote = {
      noteText: 'Para 1\nPara 2',
      attributeRuns: [{ length: 7 }, { length: 6 }],
    };
    expect(extractHeadingPositions(decoded)).toEqual([]);
  });
});

describe('端到端：encode → decode → buildCleanText', () => {
  it('完整流程：gzip blob → 解码 → 纯文本', () => {
    const zdata = buildZData('Hello\nWorld', [
      { length: 6, paragraphStyle: { styleType: PARAGRAPH_STYLES.TITLE } },
      { length: 5 },
    ]);

    const decoded = decodeNoteData(zdata);
    expect(decoded).not.toBeNull();

    const text = buildCleanText(decoded!);
    expect(text).toBe('Hello\nWorld');

    const headings = extractHeadingPositions(decoded!);
    expect(headings).toHaveLength(1);
    expect(headings[0].styleType).toBe(PARAGRAPH_STYLES.TITLE);
  });
});

describe('buildCleanTextWithMap / mapHeadingOffsets 坐标系一致性（回归）', () => {
  // 校验：原始 noteText 第 i 个字符，经 offsetMap 映射后落在 cleanText 中
  // 对应保留字符的正确位置（被删除的 U+FFFC 映射到其后第一个保留字符）。
  it('offsetMap 把清单前缀 +6 / U+FFFC -1 都正确折算', () => {
    const OBJ = '￼';
    // noteText: "Note\n" + U+FFFC + "Todo\n" + "Body\n"
    // run1 是清单 + 附件，行首会插入 "[未完成] "（+6），U+FFFC 被删（-1）
    const noteText = `Note\n${OBJ}Todo\nBody`;
    const uuid = Buffer.from(new Uint8Array(16));
    const runs: DecodedAttributeRun[] = [
      { length: 5, paragraphStyle: { styleType: PARAGRAPH_STYLES.HEADING } }, // "Note\n"
      {
        length: 6, // U+FFFC + "Todo\n"
        paragraphStyle: { styleType: PARAGRAPH_STYLES.CHECKLIST, checklist: { uuid, done: false } },
        attachmentInfo: { attachmentIdentifier: 'att-1', typeUti: 'public.image' },
      },
      { length: 4 }, // "Body"
    ];
    const decoded: DecodedNote = { noteText, attributeRuns: runs };

    const { cleanText, offsetMap } = buildCleanTextWithMap(decoded);
    // 清单行的 U+FFFC 被删、加 "[未完成] " 前缀
    expect(cleanText).toBe('Note\n[未完成] Todo\nBody');

    // 每个原始保留字符都应映射到 cleanText 中的同一字符
    for (let i = 0; i < noteText.length; i++) {
      const ch = noteText[i];
      if (ch === OBJ) continue; // 被删除，不强求等值
      expect(cleanText[offsetMap[i]]).toBe(ch);
    }

    // "Body" 在 raw 里从 index 11 开始；映射后应是 cleanText 里 "Body" 的起点
    const rawBodyStart = noteText.indexOf('Body');
    expect(cleanText.slice(offsetMap[rawBodyStart], offsetMap[rawBodyStart] + 4)).toBe('Body');
  });

  it('长笔记：清单/附件错位会让旧代码切错，映射后标题边界对齐', () => {
    const OBJ = '￼';
    // 构造一篇 > 3000 字的笔记，标题二之前夹着清单行(+6)和附件字符(-1)，
    // 使 raw offset 与 clean offset 明显分叉。
    const filler = '这是一段足够长的正文内容。'.repeat(120); // ~1560 字
    const heading1 = '第一章';
    const checklistLine = `${OBJ}待办事项一`; // 清单 + 附件
    const heading2 = '第二章';

    // noteText 布局：H1\n + filler\n + checklistLine\n + H2\n + filler
    const noteText =
      `${heading1}\n` + `${filler}\n` + `${checklistLine}\n` + `${heading2}\n` + `${filler}`;

    const uuid = Buffer.from(new Uint8Array(16));
    const runs: DecodedAttributeRun[] = [
      { length: heading1.length + 1, paragraphStyle: { styleType: PARAGRAPH_STYLES.HEADING } },
      { length: filler.length + 1 },
      {
        length: checklistLine.length + 1,
        paragraphStyle: { styleType: PARAGRAPH_STYLES.CHECKLIST, checklist: { uuid, done: false } },
        attachmentInfo: { attachmentIdentifier: 'att-x', typeUti: 'public.image' },
      },
      { length: heading2.length + 1, paragraphStyle: { styleType: PARAGRAPH_STYLES.HEADING } },
      { length: filler.length },
    ];
    const decoded: DecodedNote = { noteText, attributeRuns: runs };

    const { cleanText, offsetMap } = buildCleanTextWithMap(decoded);
    expect(cleanText.length).toBeGreaterThan(3000);

    const rawHeadings = extractHeadingPositions(decoded);
    expect(rawHeadings).toHaveLength(2);

    // 旧的（错误）行为：直接用 raw offset 去 slice cleanText —— heading2 的 raw
    // offset 会因为前面的 "[未完成] "(+6) 和 U+FFFC(-1) 而比真实 clean 位置偏 +5，
    // 落在 "第二章" 之前的内容中间。
    const rawH2 = rawHeadings[1].offset;
    const mappedH2 = mapHeadingOffsets(rawHeadings, offsetMap)[1].offset;
    expect(mappedH2).not.toBe(rawH2); // 坐标系确实分叉
    // 映射后的位置精确指向 "第二章"
    expect(cleanText.slice(mappedH2, mappedH2 + heading2.length)).toBe(heading2);
    // 用 raw offset（旧行为）则切不到标题
    expect(cleanText.slice(rawH2, rawH2 + heading2.length)).not.toBe(heading2);

    // 端到端：用映射后的 heading 分段，每段都应在标题行行首切分
    const segments = segmentNote(cleanText, '测试', mapHeadingOffsets(rawHeadings, offsetMap));
    expect(segments.length).toBeGreaterThanOrEqual(2);
    // 第二段应以 "第二章" 开头（标题边界对齐，没有把标题切到内容中间）
    const hasHeading2Segment = segments.some(s => s.content.startsWith(heading2));
    expect(hasHeading2Segment).toBe(true);
  });
});
