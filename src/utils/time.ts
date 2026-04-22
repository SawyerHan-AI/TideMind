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
  // 看起来像 "YYYY-MM-DD HH:MM:SS"：补 T 和 Z，按 UTC 解析
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
