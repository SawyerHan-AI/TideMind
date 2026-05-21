/**
 * JSON 安全解析工具
 *
 * F10 (audit-8) 派生:许多旧代码写 `JSON.parse(...).filter(...)`,假设结果一定是数组。
 * 现实里 metadata.value 可能因为 schema 演进或外部写入变成对象 / null / 字符串。
 * 直接 .filter 会抛 TypeError,被外层空 catch 静默吞掉,问题难排查。
 * 这里提供一个统一 helper:解析失败或非数组都返回 [] 并通过 logger 告警。
 */

interface Logger {
  warn: (...args: unknown[]) => void;
}

/**
 * 安全解析 JSON 数组,捕获 parse 失败 + 非数组结果。
 *
 * 用法:
 *   const items = safeParseJsonArray<string>(row.value, log, 'demoted_tags');
 *   items.filter(...) // 一定能调,即便底层是损坏的 JSON
 *
 * @param value 原始 string
 * @param log   日志接收器,parse 失败或非数组时打 warn
 * @param label 用于日志的标识(metadata key / 字段名)
 * @returns 解析出来的数组,失败/非数组返回 []
 */
export function safeParseJsonArray<T = unknown>(
  value: string | null | undefined,
  log: Logger,
  label: string,
): T[] {
  if (value == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    log.warn(`safeParseJsonArray(${label}): JSON.parse 失败,使用空数组: ${(err as Error).message}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    log.warn(`safeParseJsonArray(${label}): 解析结果不是数组(type=${typeof parsed}),使用空数组`);
    return [];
  }
  return parsed as T[];
}
