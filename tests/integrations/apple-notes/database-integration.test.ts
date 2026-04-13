/**
 * apple-notes/database.ts 集成测试
 *
 * 使用 RhetTbull/apple-notes-parser 项目提供的真实 NoteStore.sqlite 数据库
 * （MIT 许可）覆盖跨 macOS 版本的 schema 检测、账户/文件夹/笔记查询。
 *
 * 数据库位置：tests/fixtures/apple-notes/NoteStore-macOS-*.sqlite
 * 每个数据库包含：1 个账户 + 6 个文件夹（含嵌套）+ 8-9 条笔记
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  openNoteStoreDb,
  detectSchemaVersion,
  listAccounts,
  listFolders,
  buildFolderPathMap,
  listNotes,
  listAllNoteUuids,
  listNotesModifiedSince,
  preloadNoteTags,
  preloadNoteAttachmentTexts,
  countNotes,
  checkPermission,
  coreDataToISO,
} from '../../../src/integrations/apple-notes/database.js';

// 跨版本测试数据库清单
const FIXTURES: Array<{ file: string; macosVersion: string; expectedSchemaVersion: string }> = [
  { file: 'NoteStore-macOS-13-Ventura.sqlite', macosVersion: '13 (Ventura)', expectedSchemaVersion: '13' },
  { file: 'NoteStore-macOS-14-Sonoma.sqlite', macosVersion: '14 (Sonoma)', expectedSchemaVersion: '14' },
  { file: 'NoteStore-macOS-15-Seqoia.sqlite', macosVersion: '15 (Sequoia)', expectedSchemaVersion: '15' },
  { file: 'NoteStore-macOS-26-Tahoe.sqlite', macosVersion: '26 (Tahoe)', expectedSchemaVersion: '26' },
];

const FIXTURE_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..', '..', 'fixtures', 'apple-notes',
);

function getFixturePath(file: string): string {
  return path.join(FIXTURE_DIR, file);
}

function hasFixture(file: string): boolean {
  return fs.existsSync(getFixturePath(file));
}

describe('真实 NoteStore.sqlite 集成测试', () => {
  describe.each(FIXTURES)('macOS $macosVersion', ({ file, expectedSchemaVersion }) => {
    const fixturePath = getFixturePath(file);
    const fixtureExists = fs.existsSync(fixturePath);

    if (!fixtureExists) {
      it.skip(`跳过（fixture 不存在: ${file}）`, () => {});
      return;
    }

    it('checkPermission 返回 accessible=true', () => {
      const result = checkPermission(fixturePath);
      expect(result.accessible).toBe(true);
      expect(result.path).toBe(fixturePath);
    });

    it('openNoteStoreDb 能打开数据库', () => {
      const db = openNoteStoreDb(fixturePath);
      expect(db).toBeDefined();
      db.close();
    });

    it(`detectSchemaVersion 返回 version='${expectedSchemaVersion}'`, () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        expect(schema.version).toBe(expectedSchemaVersion);
        expect(schema.accountFK).toBeDefined();
        expect(schema.creationDateCol).toBeDefined();
        expect(schema.modificationDateCol).toBe('ZMODIFICATIONDATE1');
      } finally {
        db.close();
      }
    });

    it('listAccounts 返回至少 1 个账户', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const accounts = listAccounts(db);
        expect(accounts.length).toBeGreaterThanOrEqual(1);
        for (const acc of accounts) {
          expect(typeof acc.zpk).toBe('number');
          expect(typeof acc.name).toBe('string');
          expect(acc.name.length).toBeGreaterThan(0);
          expect(typeof acc.uuid).toBe('string');
        }
      } finally {
        db.close();
      }
    });

    it('listFolders 返回多个文件夹（含嵌套结构）', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const folders = listFolders(db, schema);
        // apple-notes-parser 的测试数据库包含 6 个文件夹（Notes, Folder, Folder2, Subfolder, Subsubfolder, Recently Deleted）
        expect(folders.length).toBeGreaterThanOrEqual(5);

        // 验证有嵌套（至少一个文件夹的 parentZpk 非 null）
        const hasNested = folders.some(f => f.parentZpk != null);
        expect(hasNested).toBe(true);

        // 每个文件夹的必需字段
        for (const f of folders) {
          expect(typeof f.zpk).toBe('number');
          expect(typeof f.title).toBe('string');
          expect(typeof f.uuid).toBe('string');
          expect(typeof f.ownerZpk).toBe('number');
        }
      } finally {
        db.close();
      }
    });

    it('buildFolderPathMap 正确构建嵌套路径', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const folders = listFolders(db, schema);
        const pathMap = buildFolderPathMap(folders);

        // 应该为每个非智能文件夹生成路径
        const nonSmartFolders = folders.filter(f => !f.isSmart);
        expect(pathMap.size).toBeGreaterThanOrEqual(nonSmartFolders.length);

        // 至少有一个多层级路径（含 /）
        const paths = Array.from(pathMap.values());
        const hasMultiLevel = paths.some(p => p.includes('/'));
        expect(hasMultiLevel).toBe(true);
      } finally {
        db.close();
      }
    });

    it('listNotes 返回所有非加密非删除笔记（含 ZDATA）', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const notes = listNotes(db, schema);

        expect(notes.length).toBeGreaterThanOrEqual(1);

        for (const note of notes) {
          expect(typeof note.zpk).toBe('number');
          expect(typeof note.uuid).toBe('string');
          expect(note.zdata).not.toBeNull();
          expect(note.zdata).toBeInstanceOf(Buffer);
          expect(note.zdata!.length).toBeGreaterThan(0);
          expect(note.isPasswordProtected).toBe(false);
          expect(note.markedForDeletion).toBe(false);
          // 时间戳应为合理的 Core Data epoch（正数）
          expect(note.creationDate).toBeGreaterThan(0);
          expect(note.modificationDate).toBeGreaterThan(0);
        }
      } finally {
        db.close();
      }
    });

    it('listNotes 按账户过滤', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const accounts = listAccounts(db);
        expect(accounts.length).toBeGreaterThan(0);

        // 只取第一个账户的笔记
        const firstAccountZpk = accounts[0].zpk;
        const filtered = listNotes(db, schema, [firstAccountZpk]);

        // 传空列表（不应该报错）
        const noneFiltered = listNotes(db, schema);
        expect(noneFiltered.length).toBeGreaterThanOrEqual(filtered.length);
      } finally {
        db.close();
      }
    });

    it('countNotes 与 listNotes 数量一致', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const listed = listNotes(db, schema);
        const count = countNotes(db, schema);
        expect(count).toBe(listed.length);
      } finally {
        db.close();
      }
    });

    it('listAllNoteUuids 返回所有当前笔记 UUID', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const notes = listNotes(db, schema);
        const uuids = listAllNoteUuids(db, schema);
        expect(uuids.size).toBe(notes.length);
        for (const note of notes) {
          expect(uuids.has(note.uuid)).toBe(true);
        }
      } finally {
        db.close();
      }
    });

    it('listNotesModifiedSince with since=0 返回全部', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const all = listNotes(db, schema);
        const modified = listNotesModifiedSince(db, schema, 0);
        expect(modified.length).toBe(all.length);
      } finally {
        db.close();
      }
    });

    it('listNotesModifiedSince with 远未来时间戳 返回空', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        // 2100 年对应的 Core Data epoch
        const farFuture = (new Date('2100-01-01').getTime() / 1000) - 978307200;
        const modified = listNotesModifiedSince(db, schema, farFuture);
        expect(modified.length).toBe(0);
      } finally {
        db.close();
      }
    });

    it('preloadNoteTags 批量加载不崩溃（即使没有 hashtag）', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const notes = listNotes(db, schema);
        const zpks = notes.map(n => n.zpk);
        const tagsMap = preloadNoteTags(db, zpks);
        expect(tagsMap).toBeInstanceOf(Map);
        // 每个值应该是数组
        for (const [zpk, tags] of tagsMap) {
          expect(zpks).toContain(zpk);
          expect(Array.isArray(tags)).toBe(true);
        }
      } finally {
        db.close();
      }
    });

    it('preloadNoteAttachmentTexts 批量加载不崩溃', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const notes = listNotes(db, schema);
        const zpks = notes.map(n => n.zpk);
        const attachMap = preloadNoteAttachmentTexts(db, zpks);
        expect(attachMap).toBeInstanceOf(Map);
        for (const [zpk, texts] of attachMap) {
          expect(zpks).toContain(zpk);
          expect(Array.isArray(texts)).toBe(true);
        }
      } finally {
        db.close();
      }
    });

    it('笔记时间戳能转换为合理的 ISO 日期', () => {
      const db = openNoteStoreDb(fixturePath);
      try {
        const schema = detectSchemaVersion(db);
        const notes = listNotes(db, schema);
        for (const note of notes) {
          const iso = coreDataToISO(note.creationDate);
          const date = new Date(iso);
          // 应该是 2010-2030 年之间的合理日期（测试数据库创建时间）
          expect(date.getFullYear()).toBeGreaterThan(2010);
          expect(date.getFullYear()).toBeLessThan(2040);
        }
      } finally {
        db.close();
      }
    });
  });
});

describe('checkPermission 边界情况', () => {
  it('不存在的路径返回 accessible=false', () => {
    const result = checkPermission('/nonexistent/path/NoteStore.sqlite');
    expect(result.accessible).toBe(false);
  });

  it('非 SQLite 文件返回 accessible=false', () => {
    // 用当前测试文件本身作为 "非 SQLite 文件"
    const thisFile = new URL(import.meta.url).pathname;
    const result = checkPermission(thisFile);
    expect(result.accessible).toBe(false);
  });
});
