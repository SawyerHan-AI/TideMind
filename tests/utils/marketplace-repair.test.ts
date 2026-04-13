/**
 * marketplace-repair 纯转换函数的单元测试。
 *
 * 覆盖所有 rebrand 相关的遗留清理场景：
 *   - marketplace.json 顶层字段被老版本留下
 *   - plugins 列表混杂 external-brain-* 和 tidemind-* 条目
 *   - settings.json 里残留 extraKnownMarketplaces['external-brain-local']
 *   - 幂等性：对已经是新格式的输入，changed=false
 */
import { describe, it, expect } from 'vitest';
import {
  repairMarketplaceJson,
  repairClaudeSettings,
  TIDEMIND_MARKETPLACE_META,
  LEGACY_MARKETPLACE_KEYS,
} from '../../src/utils/marketplace-repair.js';

describe('repairMarketplaceJson', () => {
  describe('顶层字段改名', () => {
    it('把旧的 external-brain-local name 改成 tidemind-local', () => {
      const input = {
        $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
        name: 'external-brain-local',
        description: 'ExternaBrain 本地插件仓库',
        owner: { name: 'ExternaBrain', email: 'local@external-brain' },
        plugins: [],
      };

      const { output, changed, renamedTopLevel } = repairMarketplaceJson(input);

      expect(changed).toBe(true);
      expect(renamedTopLevel).toBe(true);
      expect(output.name).toBe('tidemind-local');
      expect(output.description).toBe('Tide Mind 本地插件仓库');
      expect(output.owner).toEqual({ name: 'TideMind', email: 'local@tidemind' });
      expect(output.$schema).toBe(TIDEMIND_MARKETPLACE_META.$schema);
    });

    it('已经是新格式时保持 changed=false', () => {
      const input = {
        $schema: TIDEMIND_MARKETPLACE_META.$schema,
        name: 'tidemind-local',
        description: 'Tide Mind 本地插件仓库',
        owner: { name: 'TideMind', email: 'local@tidemind' },
        plugins: [],
      };

      const { output, changed } = repairMarketplaceJson(input);
      expect(changed).toBe(false);
      expect(output.name).toBe('tidemind-local');
    });

    it('即使只有 description 不对也会触发 changed', () => {
      const input = {
        $schema: TIDEMIND_MARKETPLACE_META.$schema,
        name: 'tidemind-local',
        description: '旧描述',
        owner: { name: 'TideMind', email: 'local@tidemind' },
        plugins: [],
      };

      const { changed, output } = repairMarketplaceJson(input);
      expect(changed).toBe(true);
      expect(output.description).toBe('Tide Mind 本地插件仓库');
    });

    it('owner 字段缺失时补齐', () => {
      const input = {
        $schema: TIDEMIND_MARKETPLACE_META.$schema,
        name: 'tidemind-local',
        description: 'Tide Mind 本地插件仓库',
        plugins: [],
      };

      const { output, changed } = repairMarketplaceJson(input);
      expect(changed).toBe(true);
      expect(output.owner).toEqual({ name: 'TideMind', email: 'local@tidemind' });
    });
  });

  describe('plugins 列表过滤', () => {
    it('删除 external-brain-* 旧条目，保留 tidemind-* 新条目', () => {
      const input = {
        name: 'tidemind-local',
        description: 'Tide Mind 本地插件仓库',
        owner: { name: 'TideMind', email: 'local@tidemind' },
        $schema: TIDEMIND_MARKETPLACE_META.$schema,
        plugins: [
          { name: 'external-brain-eb_old1', description: '旧 1', source: './claude-code-old1' },
          { name: 'tidemind-eb_new1', description: '新 1', source: './claude-code-new1' },
          { name: 'external-brain-eb_old2', description: '旧 2', source: './claude-code-old2' },
          { name: 'tidemind-eb_new2', description: '新 2', source: './claude-code-new2' },
        ],
      };

      const { output, changed, removedLegacyPlugins } = repairMarketplaceJson(input);

      expect(changed).toBe(true);
      expect(removedLegacyPlugins).toBe(2);
      expect(output.plugins).toHaveLength(2);
      expect(output.plugins!.map(p => p.name)).toEqual(['tidemind-eb_new1', 'tidemind-eb_new2']);
    });

    it('用户实际遇到的 bug 场景：name 是 external-brain-local，plugins 里有新 tidemind-* 条目', () => {
      // 来自 ~/.tidemind/plugins/.claude-plugin/marketplace.json 实际内容
      const input = {
        $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
        name: 'external-brain-local',
        description: 'ExternaBrain 本地插件仓库',
        owner: { name: 'ExternaBrain', email: 'local@external-brain' },
        plugins: [
          { name: 'tidemind-eb_d65fe72c', description: '外部记忆系统 — CCwork', source: './claude-code-eb_d65fe72c' },
        ],
      };

      const { output, changed } = repairMarketplaceJson(input);

      expect(changed).toBe(true);
      expect(output.name).toBe('tidemind-local');
      expect(output.plugins).toHaveLength(1);
      expect(output.plugins![0].name).toBe('tidemind-eb_d65fe72c');
    });

    it('全部都是旧条目时过滤为空列表', () => {
      const input = {
        name: 'external-brain-local',
        plugins: [
          { name: 'external-brain-a' },
          { name: 'external-brain-b' },
        ],
      };

      const { output, changed, removedLegacyPlugins } = repairMarketplaceJson(input);

      expect(changed).toBe(true);
      expect(removedLegacyPlugins).toBe(2);
      expect(output.plugins).toEqual([]);
    });

    it('plugins 为空列表且顶层已对齐时，changed=false', () => {
      const input = {
        $schema: TIDEMIND_MARKETPLACE_META.$schema,
        name: 'tidemind-local',
        description: 'Tide Mind 本地插件仓库',
        owner: { name: 'TideMind', email: 'local@tidemind' },
        plugins: [],
      };

      const { changed, removedLegacyPlugins } = repairMarketplaceJson(input);
      expect(changed).toBe(false);
      expect(removedLegacyPlugins).toBe(0);
    });

    it('保守保留异常 plugin 条目（name 不是字符串）', () => {
      const input = {
        name: 'tidemind-local',
        description: 'Tide Mind 本地插件仓库',
        owner: { name: 'TideMind', email: 'local@tidemind' },
        $schema: TIDEMIND_MARKETPLACE_META.$schema,
        plugins: [
          { name: 'tidemind-good' },
          { /* 没 name */ description: 'weird' } as any,
          { name: 123 as any }, // 不是字符串
        ],
      };

      const { output, changed, removedLegacyPlugins } = repairMarketplaceJson(input);
      expect(changed).toBe(false); // 异常条目被保留，没触发修改
      expect(removedLegacyPlugins).toBe(0);
      expect(output.plugins).toHaveLength(3);
    });
  });

  describe('输入降级', () => {
    it('null 输入时构造空的新格式', () => {
      const { output, changed } = repairMarketplaceJson(null);
      expect(changed).toBe(true);
      expect(output.name).toBe('tidemind-local');
      expect(output.plugins).toEqual([]);
    });

    it('undefined 输入时构造空的新格式', () => {
      const { output, changed } = repairMarketplaceJson(undefined);
      expect(changed).toBe(true);
      expect(output.name).toBe('tidemind-local');
    });

    it('数组输入（异常数据）时也安全降级为空的新格式', () => {
      // typeof [] === 'object'，容易绕过 null 检查但又不能当正常 MarketplaceFile 使用
      const { output, changed } = repairMarketplaceJson([] as any);
      expect(changed).toBe(true);
      expect(output.name).toBe('tidemind-local');
      expect(output.plugins).toEqual([]);
      expect(Array.isArray(output)).toBe(false);
    });

    it('包含内容的数组输入也走降级路径，不试图 clone 并加字段', () => {
      const { output, changed } = repairMarketplaceJson([{ name: 'x' }] as any);
      expect(changed).toBe(true);
      expect(Array.isArray(output)).toBe(false);
      expect(output.name).toBe('tidemind-local');
      expect(output.plugins).toEqual([]);
    });

    it('plugins 不存在时补齐为空数组', () => {
      const input = {
        $schema: TIDEMIND_MARKETPLACE_META.$schema,
        name: 'tidemind-local',
        description: 'Tide Mind 本地插件仓库',
        owner: { name: 'TideMind', email: 'local@tidemind' },
      };

      const { output, changed } = repairMarketplaceJson(input);
      expect(changed).toBe(true); // plugins 从无到有算变化
      expect(output.plugins).toEqual([]);
    });
  });

  describe('不污染输入对象', () => {
    it('修改 output 不会影响原始 input', () => {
      const input = {
        name: 'external-brain-local',
        plugins: [{ name: 'tidemind-x' }],
      };
      const inputSnapshot = JSON.parse(JSON.stringify(input));

      const { output } = repairMarketplaceJson(input);
      output.name = 'mutated';
      (output.plugins as any[]).push({ name: 'added' });

      // 原始 input 应保持不变
      expect(input).toEqual(inputSnapshot);
    });
  });
});

describe('repairClaudeSettings', () => {
  it('删除遗留的 external-brain-local 条目', () => {
    const input = {
      extraKnownMarketplaces: {
        'claude-plugins-official': { source: { source: 'github', repo: 'foo' } },
        'external-brain-local': { source: { source: 'directory', path: '/home/u/.tidemind/plugins' } },
        'tidemind-local': { source: { source: 'directory', path: '/home/u/.tidemind/plugins' } },
      },
    };

    const { output, changed, removedKeys } = repairClaudeSettings(input);

    expect(changed).toBe(true);
    expect(removedKeys).toEqual(['external-brain-local']);
    expect(output.extraKnownMarketplaces).toEqual({
      'claude-plugins-official': { source: { source: 'github', repo: 'foo' } },
      'tidemind-local': { source: { source: 'directory', path: '/home/u/.tidemind/plugins' } },
    });
  });

  it('LEGACY_MARKETPLACE_KEYS 里所有 key 都会被清理', () => {
    // 如果以后往 LEGACY_MARKETPLACE_KEYS 加新条目，这个测试会防止漏清理
    const fakeSettings: Record<string, unknown> = { 'claude-plugins-official': {} };
    for (const k of LEGACY_MARKETPLACE_KEYS) {
      fakeSettings[k] = { source: { source: 'directory', path: '/tmp' } };
    }
    const { output, removedKeys } = repairClaudeSettings({
      extraKnownMarketplaces: fakeSettings,
    });

    expect(removedKeys.sort()).toEqual([...LEGACY_MARKETPLACE_KEYS].sort());
    for (const k of LEGACY_MARKETPLACE_KEYS) {
      expect(output.extraKnownMarketplaces).not.toHaveProperty(k);
    }
    expect(output.extraKnownMarketplaces).toHaveProperty('claude-plugins-official');
  });

  it('settings 里没有遗留 key 时 changed=false', () => {
    const input = {
      extraKnownMarketplaces: {
        'claude-plugins-official': {},
        'tidemind-local': {},
      },
    };

    const { changed, removedKeys } = repairClaudeSettings(input);
    expect(changed).toBe(false);
    expect(removedKeys).toEqual([]);
  });

  it('没有 extraKnownMarketplaces 字段时 changed=false', () => {
    const input = { hooks: {}, someOtherField: true };
    const { changed, removedKeys, output } = repairClaudeSettings(input);
    expect(changed).toBe(false);
    expect(removedKeys).toEqual([]);
    expect(output).toEqual(input);
  });

  it('null/undefined 输入时安全返回', () => {
    expect(repairClaudeSettings(null).changed).toBe(false);
    expect(repairClaudeSettings(undefined).changed).toBe(false);
  });

  it('不污染输入对象', () => {
    const input = {
      extraKnownMarketplaces: {
        'external-brain-local': { x: 1 },
        'tidemind-local': { y: 2 },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const { output } = repairClaudeSettings(input);
    // 修改 output 不应影响 input
    (output.extraKnownMarketplaces as any)['tidemind-local'].y = 999;
    expect(input).toEqual(snapshot);
  });

  it('保留非 extraKnownMarketplaces 的其他字段', () => {
    const input = {
      hooks: { SessionStart: [{ matcher: '*' }] },
      theme: 'dark',
      extraKnownMarketplaces: {
        'external-brain-local': {},
      },
    };
    const { output } = repairClaudeSettings(input);
    expect(output.hooks).toEqual({ SessionStart: [{ matcher: '*' }] });
    expect(output.theme).toBe('dark');
    expect(output.extraKnownMarketplaces).toEqual({});
  });
});
