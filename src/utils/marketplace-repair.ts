/**
 * Tide Mind 本地 marketplace / Claude Code settings 的纯数据转换。
 *
 * 这里只做 in→out 的 JSON 变换，不碰文件系统。调用方负责读写文件。
 * 抽出来是为了让 client/electron 下的 plugin-generator.ts 和 plugin-self-heal.ts
 * 共享同一份规则，同时也能在 Node 测试环境里单独覆盖。
 *
 * 所有函数都返回 `{ output, changed, ...metadata }`。`changed=false` 时调用方
 * 可以跳过写磁盘，避免不必要的文件修改。
 */

/** Tide Mind 本地 marketplace 的顶层元数据常量。改名时只需要改这一处。 */
export const TIDEMIND_MARKETPLACE_META = {
  name: 'tidemind-local',
  description: 'Tide Mind 本地插件仓库',
  owner: { name: 'TideMind', email: 'local@tidemind' },
  $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
} as const;

/** 从 Claude Code settings.json 的 extraKnownMarketplaces 里要清理的旧 key。 */
export const LEGACY_MARKETPLACE_KEYS = ['external-brain-local'];

export interface MarketplacePlugin {
  name: string;
  description?: string;
  source?: string;
  [key: string]: unknown;
}

export interface MarketplaceFile {
  $schema?: string;
  name?: string;
  description?: string;
  owner?: { name?: string; email?: string };
  plugins?: MarketplacePlugin[];
  [key: string]: unknown;
}

export interface MarketplaceRepairResult {
  output: MarketplaceFile;
  changed: boolean;
  removedLegacyPlugins: number;
  renamedTopLevel: boolean;
}

/**
 * 修复 Tide Mind 本地 marketplace.json 的内容：
 *   - 顶层 name/description/owner/$schema 强制对齐 TIDEMIND_MARKETPLACE_META
 *   - plugins 列表里 name 以 "external-brain-" 开头的旧条目删掉
 *
 * 幂等：对已经是新格式的输入，返回 changed=false。
 */
export function repairMarketplaceJson(
  input: MarketplaceFile | null | undefined,
): MarketplaceRepairResult {
  // 输入完全不可用时（null、undefined、非对象、数组），构造一份空的新格式
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      output: {
        ...TIDEMIND_MARKETPLACE_META,
        plugins: [],
      },
      changed: true,
      removedLegacyPlugins: 0,
      renamedTopLevel: true,
    };
  }

  // structuredClone 保证 output 和 input 完全解耦
  const output: MarketplaceFile = structuredClone(input);

  let renamedTopLevel = false;
  if (output.name !== TIDEMIND_MARKETPLACE_META.name) {
    output.name = TIDEMIND_MARKETPLACE_META.name;
    renamedTopLevel = true;
  }
  if (output.description !== TIDEMIND_MARKETPLACE_META.description) {
    output.description = TIDEMIND_MARKETPLACE_META.description;
    renamedTopLevel = true;
  }
  if (
    !output.owner ||
    output.owner.name !== TIDEMIND_MARKETPLACE_META.owner.name ||
    output.owner.email !== TIDEMIND_MARKETPLACE_META.owner.email
  ) {
    output.owner = { ...TIDEMIND_MARKETPLACE_META.owner };
    renamedTopLevel = true;
  }
  if (output.$schema !== TIDEMIND_MARKETPLACE_META.$schema) {
    output.$schema = TIDEMIND_MARKETPLACE_META.$schema;
    renamedTopLevel = true;
  }

  let removedLegacyPlugins = 0;
  if (Array.isArray(output.plugins)) {
    const before = output.plugins.length;
    output.plugins = output.plugins.filter((p) => {
      if (typeof p?.name !== 'string') return true; // 异常条目，保守保留
      return !p.name.startsWith('external-brain-');
    });
    removedLegacyPlugins = before - output.plugins.length;
  } else {
    output.plugins = [];
    renamedTopLevel = true; // plugins 字段原本不存在也算修了
  }

  const changed = renamedTopLevel || removedLegacyPlugins > 0;
  return { output, changed, removedLegacyPlugins, renamedTopLevel };
}

export interface ClaudeSettingsLike {
  extraKnownMarketplaces?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SettingsRepairResult {
  output: ClaudeSettingsLike;
  changed: boolean;
  removedKeys: string[];
}

/**
 * 清理 Claude Code settings.json 里 extraKnownMarketplaces 下遗留的
 * external-brain-local 条目。只删旧 key，不碰其他字段。
 *
 * 注意：这只是清理 settings.json 的"已知 marketplace 列表"。Claude Code
 * 内部的 marketplace 状态是独立的，需要在 install-plugin 流程里通过
 * `claude plugin marketplace remove <name>` CLI 命令清理。
 */
export function repairClaudeSettings(
  input: ClaudeSettingsLike | null | undefined,
): SettingsRepairResult {
  if (!input || typeof input !== 'object') {
    return { output: input ?? {}, changed: false, removedKeys: [] };
  }

  // structuredClone 在 Node 17+ 可用。深拷贝保证 output 和 input 完全解耦，
  // 调用方可以随意修改 output 而不影响 input。
  const output: ClaudeSettingsLike = structuredClone(input);
  const removedKeys: string[] = [];

  if (output.extraKnownMarketplaces && typeof output.extraKnownMarketplaces === 'object') {
    for (const key of LEGACY_MARKETPLACE_KEYS) {
      if (key in output.extraKnownMarketplaces) {
        delete output.extraKnownMarketplaces[key];
        removedKeys.push(key);
      }
    }
  }

  return { output, changed: removedKeys.length > 0, removedKeys };
}
