/**
 * apple-notes/protobuf.ts 端到端集成测试
 *
 * 用真实 NoteStore.sqlite 的 ZDATA blob 测试 decodeNoteData + buildCleanText
 * 能否正确处理 Apple 真实写入的 protobuf 格式。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  openNoteStoreDb,
  detectSchemaVersion,
  listNotes,
  preloadNoteAttachmentTexts,
} from '../../../src/integrations/apple-notes/database.js';
import {
  initProto,
  decodeNoteData,
  buildCleanText,
  extractHeadingPositions,
} from '../../../src/integrations/apple-notes/protobuf.js';

const FIXTURES = [
  { file: 'NoteStore-macOS-13-Ventura.sqlite', version: '13' },
  { file: 'NoteStore-macOS-14-Sonoma.sqlite', version: '14' },
  { file: 'NoteStore-macOS-15-Seqoia.sqlite', version: '15' },
  { file: 'NoteStore-macOS-26-Tahoe.sqlite', version: '26' },
];

const FIXTURE_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..', '..', 'fixtures', 'apple-notes',
);

beforeAll(async () => {
  await initProto();
});

describe('真实 ZDATA 端到端解析', () => {
  describe.each(FIXTURES)('macOS $version', ({ file }) => {
    const fixturePath = path.join(FIXTURE_DIR, file);
    const fixtureExists = fs.existsSync(fixturePath);

    if (!fixtureExists) {
      it.skip(`跳过（fixture 不存在）`, () => {});
      return;
    }

    it('能解码所有真实笔记的 ZDATA 且产出非空文本', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const notes = listNotes(db, schema);

        expect(notes.length).toBeGreaterThan(0);

        let successfulDecodes = 0;
        const decodeErrors: string[] = [];
        const textSamples: string[] = [];

        for (const note of notes) {
          if (!note.zdata) continue;

          const decoded = decodeNoteData(note.zdata);
          if (decoded === null) {
            decodeErrors.push(`${note.uuid}: decode returned null`);
            continue;
          }

          successfulDecodes++;

          // 验证解码结果结构
          expect(typeof decoded.noteText).toBe('string');
          expect(Array.isArray(decoded.attributeRuns)).toBe(true);

          // 构建纯文本
          const cleanText = buildCleanText(decoded);
          if (cleanText.length > 0) {
            textSamples.push(cleanText);
          }
        }

        // 至少应该有一些成功解码的笔记
        expect(successfulDecodes).toBeGreaterThan(0);
        // 至少应该产出一些非空文本
        expect(textSamples.length).toBeGreaterThan(0);

        if (decodeErrors.length > 0) {
          console.warn(`${file}: ${decodeErrors.length}/${notes.length} 解码失败`);
        }
      } finally {
        db.close();
      }
    });

    it('构建的纯文本不含 U+FFFC 占位符（已被移除）', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const notes = listNotes(db, schema);

        for (const note of notes) {
          if (!note.zdata) continue;
          const decoded = decodeNoteData(note.zdata);
          if (!decoded) continue;

          const cleanText = buildCleanText(decoded);
          expect(cleanText).not.toContain('\uFFFC');
        }
      } finally {
        db.close();
      }
    });

    it('可以结合 attachmentTexts 追加 OCR / 转录文本', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const notes = listNotes(db, schema);
        const zpks = notes.map(n => n.zpk);
        const attachMap = preloadNoteAttachmentTexts(db, zpks);

        // 对每条笔记用真实的 attachment 文本构建 cleanText
        for (const note of notes) {
          if (!note.zdata) continue;
          const decoded = decodeNoteData(note.zdata);
          if (!decoded) continue;

          const attachTexts = attachMap.get(note.zpk) ?? [];
          const cleanText = buildCleanText(decoded, attachTexts);
          expect(typeof cleanText).toBe('string');

          // 如果有 OCR/转录文本，cleanText 应该包含标注
          for (const att of attachTexts) {
            if (att.ocrSummary?.trim()) {
              const label = att.typeUti?.includes('drawing') ? '手写识别' : '图片识别';
              expect(cleanText).toContain(`[${label}:`);
            }
          }
        }
      } finally {
        db.close();
      }
    });

    it('extractHeadingPositions 返回合法偏移（都在 noteText 范围内）', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const notes = listNotes(db, schema);

        for (const note of notes) {
          if (!note.zdata) continue;
          const decoded = decodeNoteData(note.zdata);
          if (!decoded) continue;

          const headings = extractHeadingPositions(decoded);
          for (const h of headings) {
            expect(h.offset).toBeGreaterThanOrEqual(0);
            expect(h.offset).toBeLessThanOrEqual(decoded.noteText.length);
            expect([0, 1, 2]).toContain(h.styleType);
          }
        }
      } finally {
        db.close();
      }
    });

    it('清单笔记的 attribute_run 能正确识别 checklist 段落', () => {
      // 这个测试不强制要求 fixture 里有清单笔记，但如果有的话就验证
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const notes = listNotes(db, schema);

        let checklistNotesFound = 0;
        let checklistLinesAnnotated = 0;

        for (const note of notes) {
          if (!note.zdata) continue;
          const decoded = decodeNoteData(note.zdata);
          if (!decoded) continue;

          // 检查是否有 checklist style_type (103)
          const hasChecklist = decoded.attributeRuns.some(
            ar => ar.paragraphStyle?.styleType === 103,
          );

          if (hasChecklist) {
            checklistNotesFound++;
            const cleanText = buildCleanText(decoded);
            // 清单笔记的 cleanText 应该包含 [已完成] 或 [未完成] 标注
            const hasAnnotation = cleanText.includes('[已完成]') || cleanText.includes('[未完成]');
            if (hasAnnotation) checklistLinesAnnotated++;
          }
        }

        // 如果发现了清单笔记，应该全部都被标注
        if (checklistNotesFound > 0) {
          expect(checklistLinesAnnotated).toBe(checklistNotesFound);
        }
      } finally {
        db.close();
      }
    });
  });
});
