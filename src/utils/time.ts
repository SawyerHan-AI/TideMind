export function now(): string {
  return new Date().toISOString();
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 把可能是 SQLite datetime('now') 的裸时间戳（"YYYY-MM-DD HH:MM:SS"，无 T、无 Z）
 * 规范化成 ISO UTC 字符串。已是 ISO 格式则原样返回。
 *
 * 背景：历史 DB 行可能是 `datetime('now')` 字面量写入（空格分隔、无时区）。
 * new Date() 对这种格式按**本地时区**解析（UTC+8 下会多算 8h），而新写入
 * 走 `now()` 返回 ISO UTC。不归一会让 daysAgo/freshness 跨时区误差最多 ±12h，
 * 深度再巩固门槛因此永远不满足。
 */
function normalizeTimestamp(raw: string): string {
  if (!raw) return raw;
  // 已是 ISO（含 T 或 Z）：原样
  if (raw.includes('T') || raw.endsWith('Z')) return raw;
  // 修复 M23(2026-05-09):支持可选毫秒部分。原第一分支只匹配 "YYYY-MM-DD
  // HH:MM:SS+08:00" 无毫秒,带毫秒(SQLite 某些工具或迁移脚本写出的格式)
  // `2026-05-09 12:34:56.789+08:00` 会绕过第一分支,落到第二分支被强行替换
  // 空格为 T 并追加 Z,原 +08:00 偏移被吞掉,整个时间错读为 UTC,daysAgo /
  // 新鲜度算出来差 8 小时,reconsolidate / freshness 阈值系统性偏差。
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:?\d{2}$/.test(raw)) {
    return raw.replace(' ', 'T');
  }
  // 看起来像 "YYYY-MM-DD HH:MM:SS[.毫秒]" 且无时区:补 T 和 Z,按 UTC 解析
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)) {
    return raw.replace(' ', 'T') + 'Z';
  }
  return raw;
}

export function hoursAgo(isoString: string): number {
  const date = new Date(normalizeTimestamp(isoString));
  if (isNaN(date.getTime())) return Infinity;
  return (Date.now() - date.getTime()) / (1000 * 60 * 60);
}

export function daysAgo(isoString: string): number {
  return hoursAgo(isoString) / 24;
}
