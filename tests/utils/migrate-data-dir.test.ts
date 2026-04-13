/**
 * migrateDataDirIfNeeded 单元测试
 *
 * 覆盖所有关键分支：
 *   - 新目录已存在 → 跳过
 *   - 旧目录不存在 → 跳过
 *   - 需要迁移 → 备份 + 重命名成功
 *   - 幂等性：连续调用只做一次
 *   - 备份失败 → 不动旧目录
 *   - 自定义时间戳（测试备份目录命名）
 *   - 携带文件内容的真实迁移 → 数据完整性
 *   - 嵌套子目录 → 递归复制
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateDataDirIfNeeded, type MigrationLogger } from '../../src/utils/migrate-data-dir.js';

// 每个 case 一个独立的临时 home 目录，避免互相干扰
let tmpHome: string;

function createLogger(): MigrationLogger & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    info: (m: string) => logs.push(`[info] ${m}`),
    warn: (m: string) => logs.push(`[warn] ${m}`),
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('migrateDataDirIfNeeded', () => {
  describe('跳过场景', () => {
    it('新目录 ~/.tidemind/ 已存在时直接返回 new-dir-exists', () => {
      // 新老目录同时存在
      fs.mkdirSync(path.join(tmpHome, '.tidemind'));
      fs.mkdirSync(path.join(tmpHome, '.external-brain'));

      const result = migrateDataDirIfNeeded(undefined, { homeDir: tmpHome });

      expect(result.migrated).toBe(false);
      expect(result.reason).toBe('new-dir-exists');
      // 旧目录仍应保留，未被触碰
      expect(fs.existsSync(path.join(tmpHome, '.external-brain'))).toBe(true);
      // 不应创建任何 backup 目录
      const entries = fs.readdirSync(tmpHome);
      expect(entries.some(e => e.startsWith('.external-brain.backup-'))).toBe(false);
    });

    it('旧目录 ~/.external-brain/ 不存在时返回 no-old-dir（全新安装）', () => {
      // 两个目录都不存在
      const result = migrateDataDirIfNeeded(undefined, { homeDir: tmpHome });

      expect(result.migrated).toBe(false);
      expect(result.reason).toBe('no-old-dir');
      // 新目录不应被自动创建（创建目录是 ensureDataDirs 的职责）
      expect(fs.existsSync(path.join(tmpHome, '.tidemind'))).toBe(false);
    });
  });

  describe('正常迁移', () => {
    it('需要迁移时创建备份并重命名为新目录', () => {
      const oldDir = path.join(tmpHome, '.external-brain');
      fs.mkdirSync(oldDir);
      fs.writeFileSync(path.join(oldDir, 'config.toml'), 'foo = 1\n');

      const logger = createLogger();
      const result = migrateDataDirIfNeeded(logger, {
        homeDir: tmpHome,
        timestamp: '2026-04-10T12-00-00-000',
      });

      expect(result.migrated).toBe(true);
      expect(result.backupDir).toBe(
        path.join(tmpHome, '.external-brain.backup-2026-04-10T12-00-00-000'),
      );

      // 旧目录应已消失
      expect(fs.existsSync(oldDir)).toBe(false);
      // 新目录应存在，且包含原文件
      expect(fs.existsSync(path.join(tmpHome, '.tidemind', 'config.toml'))).toBe(true);
      expect(
        fs.readFileSync(path.join(tmpHome, '.tidemind', 'config.toml'), 'utf-8'),
      ).toBe('foo = 1\n');

      // 备份目录应存在，且包含原文件的完整副本
      expect(fs.existsSync(path.join(result.backupDir!, 'config.toml'))).toBe(true);
      expect(
        fs.readFileSync(path.join(result.backupDir!, 'config.toml'), 'utf-8'),
      ).toBe('foo = 1\n');

      // 日志里应提到备份和迁移
      expect(logger.logs.some(l => l.includes('创建备份'))).toBe(true);
      expect(logger.logs.some(l => l.includes('迁移完成'))).toBe(true);
    });

    it('保留嵌套子目录和多个文件的完整结构', () => {
      const oldDir = path.join(tmpHome, '.external-brain');
      fs.mkdirSync(path.join(oldDir, 'graph'), { recursive: true });
      fs.mkdirSync(path.join(oldDir, 'strategies'), { recursive: true });
      fs.mkdirSync(path.join(oldDir, 'crystal', 'nested'), { recursive: true });

      fs.writeFileSync(path.join(oldDir, 'config.toml'), 'root\n');
      fs.writeFileSync(path.join(oldDir, 'graph', 'brain.sqlite'), 'fake-db-bytes');
      fs.writeFileSync(path.join(oldDir, 'strategies', 'annotate.system.md'), '# annotate\n');
      fs.writeFileSync(path.join(oldDir, 'crystal', 'nested', 'deep.md'), 'deep');

      const result = migrateDataDirIfNeeded(undefined, {
        homeDir: tmpHome,
        timestamp: 'ts',
      });

      expect(result.migrated).toBe(true);

      const newDir = path.join(tmpHome, '.tidemind');
      expect(fs.readFileSync(path.join(newDir, 'config.toml'), 'utf-8')).toBe('root\n');
      expect(fs.readFileSync(path.join(newDir, 'graph', 'brain.sqlite'), 'utf-8')).toBe('fake-db-bytes');
      expect(
        fs.readFileSync(path.join(newDir, 'strategies', 'annotate.system.md'), 'utf-8'),
      ).toBe('# annotate\n');
      expect(fs.readFileSync(path.join(newDir, 'crystal', 'nested', 'deep.md'), 'utf-8')).toBe('deep');

      // 备份里也要有完整结构
      const backup = path.join(tmpHome, '.external-brain.backup-ts');
      expect(fs.readFileSync(path.join(backup, 'graph', 'brain.sqlite'), 'utf-8')).toBe('fake-db-bytes');
      expect(fs.readFileSync(path.join(backup, 'crystal', 'nested', 'deep.md'), 'utf-8')).toBe('deep');
    });

    it('返回值包含正确的路径字段', () => {
      fs.mkdirSync(path.join(tmpHome, '.external-brain'));

      const result = migrateDataDirIfNeeded(undefined, {
        homeDir: tmpHome,
        timestamp: 'T1',
      });

      expect(result.oldDir).toBe(path.join(tmpHome, '.external-brain'));
      expect(result.newDir).toBe(path.join(tmpHome, '.tidemind'));
      expect(result.backupDir).toBe(path.join(tmpHome, '.external-brain.backup-T1'));
    });
  });

  describe('幂等性', () => {
    it('连续调用两次只会在第一次迁移，第二次返回 new-dir-exists', () => {
      const oldDir = path.join(tmpHome, '.external-brain');
      fs.mkdirSync(oldDir);
      fs.writeFileSync(path.join(oldDir, 'marker.txt'), 'v1');

      const first = migrateDataDirIfNeeded(undefined, { homeDir: tmpHome, timestamp: 'T1' });
      expect(first.migrated).toBe(true);

      // 第二次调用：~/.tidemind 已存在，旧目录也不存在了
      const second = migrateDataDirIfNeeded(undefined, { homeDir: tmpHome, timestamp: 'T2' });
      expect(second.migrated).toBe(false);
      expect(second.reason).toBe('new-dir-exists');

      // 不应产生第二个 backup
      const entries = fs.readdirSync(tmpHome).filter(e => e.startsWith('.external-brain.backup-'));
      expect(entries).toEqual(['.external-brain.backup-T1']);
    });

    it('迁移完成后即使手动再次创建旧目录，也不会二次迁移', () => {
      fs.mkdirSync(path.join(tmpHome, '.external-brain'));
      const first = migrateDataDirIfNeeded(undefined, { homeDir: tmpHome, timestamp: 'T1' });
      expect(first.migrated).toBe(true);

      // 用户不小心又建了个旧目录（不应发生，但防御性测试）
      fs.mkdirSync(path.join(tmpHome, '.external-brain'));
      const second = migrateDataDirIfNeeded(undefined, { homeDir: tmpHome, timestamp: 'T2' });

      // ~/.tidemind 已存在，应直接跳过，不碰新建的旧目录
      expect(second.migrated).toBe(false);
      expect(second.reason).toBe('new-dir-exists');
      expect(fs.existsSync(path.join(tmpHome, '.external-brain'))).toBe(true);
    });
  });

  describe('失败场景', () => {
    it('备份失败时不动旧目录，返回 backup-failed', () => {
      const oldDir = path.join(tmpHome, '.external-brain');
      fs.mkdirSync(oldDir);
      fs.writeFileSync(path.join(oldDir, 'data.txt'), 'important');

      // 构造一个备份会失败的场景：
      // 预先在目标 backup 路径上创建一个非目录文件，cpSync 会失败
      const ts = 'fail-ts';
      const backupPath = path.join(tmpHome, `.external-brain.backup-${ts}`);
      fs.writeFileSync(backupPath, 'blocker-file');

      const logger = createLogger();
      const result = migrateDataDirIfNeeded(logger, { homeDir: tmpHome, timestamp: ts });

      expect(result.migrated).toBe(false);
      expect(result.reason).toMatch(/^backup-failed/);

      // 关键：旧目录必须原封不动保留
      expect(fs.existsSync(oldDir)).toBe(true);
      expect(fs.readFileSync(path.join(oldDir, 'data.txt'), 'utf-8')).toBe('important');

      // 新目录不应被创建
      expect(fs.existsSync(path.join(tmpHome, '.tidemind'))).toBe(false);

      // 日志应该包含警告
      expect(logger.logs.some(l => l.startsWith('[warn]'))).toBe(true);
    });

    it('没有 logger 参数也能正常工作（不抛异常）', () => {
      fs.mkdirSync(path.join(tmpHome, '.external-brain'));

      expect(() =>
        migrateDataDirIfNeeded(undefined, { homeDir: tmpHome, timestamp: 'T' }),
      ).not.toThrow();
    });
  });

  describe('路径字段在跳过场景也正确', () => {
    it('new-dir-exists 情况仍返回正确的 oldDir/newDir', () => {
      fs.mkdirSync(path.join(tmpHome, '.tidemind'));
      const result = migrateDataDirIfNeeded(undefined, { homeDir: tmpHome });
      expect(result.oldDir).toBe(path.join(tmpHome, '.external-brain'));
      expect(result.newDir).toBe(path.join(tmpHome, '.tidemind'));
      expect(result.backupDir).toBeUndefined();
    });

    it('no-old-dir 情况仍返回正确的 oldDir/newDir', () => {
      const result = migrateDataDirIfNeeded(undefined, { homeDir: tmpHome });
      expect(result.oldDir).toBe(path.join(tmpHome, '.external-brain'));
      expect(result.newDir).toBe(path.join(tmpHome, '.tidemind'));
      expect(result.backupDir).toBeUndefined();
    });
  });
});
