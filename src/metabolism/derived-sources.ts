/**
 * 整理任务新建的“派生节点”的识别。
 *
 * 多设备同步时，只有主设备新建的派生节点可以进入云端（设计：
 * docs/design/primary-device-selection-2026-11-20.md §10）。本文件无依赖，
 * 本机与云端共用同一份清单。
 *
 * 新增会 createNode 的整理任务时，必须给它的节点写入 source_tool 并登记到这里；
 * tests/metabolism/derived-sources.test.ts 会逐个任务检查。
 */
export const PROFILE_SOURCE_TOOL = 'profile-synthesize';

export const DERIVED_NODE_SOURCE_TOOLS: readonly string[] = [
  'temporal-crystal',
  'divergent-scan',
  'crystal-emergence',
  'crystal-emerge',
  PROFILE_SOURCE_TOOL,
  'tag-promote',
];

const DERIVED = new Set(DERIVED_NODE_SOURCE_TOOLS);

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function isDerivedSourceTool(value: unknown): boolean {
  return typeof value === 'string' && DERIVED.has(value);
}

/**
 * 派生节点 = 来源是整理任务，且带派生标记。两个条件缺一不可：
 * - 只看标记不行：用户纠正记录写 is_meta，笔记导入写 is_tag。
 * - 只看来源不行：写入记忆时 source_tool 由调用方传入。
 */
export function isDerivedNode(row: {
  source_tool?: unknown;
  is_crystal?: unknown;
  is_tag?: unknown;
  is_meta?: unknown;
}): boolean {
  return isDerivedSourceTool(row.source_tool)
    && (truthy(row.is_crystal) || truthy(row.is_tag) || truthy(row.is_meta));
}

/** 调用方传入的来源与整理任务同名时加前缀，避免用户记忆被当成整理结果。 */
export function normalizeExternalSourceTool<T extends string | null | undefined>(tool: T): T | string {
  return isDerivedSourceTool(tool) ? `external:${tool}` : tool;
}
