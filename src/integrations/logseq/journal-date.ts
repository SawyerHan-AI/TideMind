/**
 * Logseq journal 日期解析（init/增量两条路径共用，杜绝正则漂移）。
 *
 * 从文件名（basename，无扩展名）解析标准 journal 日期，支持三种默认格式：
 * `YYYY-MM-DD` / `YYYY_MM_DD` / `YYYYMMDD`。
 *
 * **带 month 1-12 / day 1-31 范围校验**（2026-06-24 第二轮审计 MEDIUM）：
 * 否则 `20229999.md` / `2022_13_45.md` 这类纯数字 ID / 无效日期会被误判成 journal，
 * 推出 `created='2022-99-99'` → `new Date('2022-99-99')` = Invalid Date → `computeTimeFactor`
 * 返回 NaN → better-sqlite3 静默把 NaN heat 存成 SQL NULL（heat clamp 触发器对 NULL 不触发）
 * → 僵尸节点（被所有 recall/metabolism 过滤、无法衰减、bumpHeat 还会把 maturity_score 也写成 NULL），
 * 且云端往返会在信任边界把它洗成 heat=1.0 + created=now() 的活跃热节点（把垃圾笔记复活成"又热又新"）。
 *
 * 必须与 `classifier.ts`（init 路径）、`preprocessor.ts`（增量 isJournal 判定）、
 * `queue.ts` 的 `inferJournalDate`（增量 created/heat 推断）三处保持同一判据——否则同一文件
 * 在 init 与增量被判成不同的 journal/page，导致 segmentContent 段数 M≠N、supersede 配对错位。
 *
 * @returns 规范化 `YYYY-MM-DD`；非标准 / 范围非法日期返回 `null`。
 */
export function parseJournalDate(basename: string): string | null {
  const m =
    basename.match(/^(\d{4})[-_](\d{2})[-_](\d{2})$/) ||
    basename.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * 从含额外 token 的文件名**宽松**提取内嵌 journal 日期(非锚定),仅用于 `journals/` 目录下的自定义命名
 * (如 `2022_02_17_Thursday` / Logseq `:journal/file-name-format` 产物)。同样带 month/day 范围校验。
 *
 * **init(classifier)与增量(queue.inferJournalDate)对 journals/ 目录必须都走此函数**——否则 init 宽松提取
 * 出日期、增量严格 parseJournalDate 返回 null → created 分叉 → 编辑后 recall 排序回归(第三轮审计 HIGH);
 * 且若不加范围校验,`journals/2022_99_99.md` 会推出 `2022-99-99` → NaN heat 僵尸节点(第三轮审计 HIGH,
 * 第二轮范围校验只堵了锚定路径、漏了 journals/ 宽松分支)。
 *
 * @returns 规范化 `YYYY-MM-DD`；无内嵌日期 / 范围非法返回 `null`。
 */
export function extractJournalDateLoose(name: string): string | null {
  const m = name.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
