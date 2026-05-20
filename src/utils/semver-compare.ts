/**
 * SemVer 比较 — core 主版本号 + prerelease 后缀 + 忽略 build metadata。
 *
 * 规则(SemVer 2.0):
 *   - core 先按 major/minor/patch 数字比较
 *   - core 相等:有 prerelease 的小于无 prerelease(`1.0.0-beta < 1.0.0`)
 *   - 两边都有 prerelease:按 `.` 分段依次比较(数字段按数字,非数字段按字典序)
 *
 * 历史:本逻辑最早只在 cloud-server/src/update/routes.ts 里,但客户端验签后做
 * "downgrade guard"(Audit D-2)也需要同样的比较。抽到 src/utils/,客户端通过
 * `@server/utils/semver-compare.js` 别名引用,云端可以直接 import 复用,两边
 * 不会再走样。
 *
 * 不引入 npm `semver` 是为了避免给 cloud-server / client 多加 ~50KB 的运行时
 * 依赖,这里只需要 compare,不需要 satisfies / inc / coerce 等大部头。
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    // 去 v 前缀 + 去 build metadata (+xxx)
    const cleaned = v.replace(/^v/, '').split('+')[0];
    const [core, ...preParts] = cleaned.split('-');
    const prerelease = preParts.length > 0 ? preParts.join('-') : null;
    const parts = core.split('.').map(s => parseInt(s, 10));
    const maj = Number.isFinite(parts[0]) ? parts[0] : 0;
    const min = Number.isFinite(parts[1]) ? parts[1] : 0;
    const pat = Number.isFinite(parts[2]) ? parts[2] : 0;
    return { maj, min, pat, prerelease };
  };

  const pa = parse(a);
  const pb = parse(b);

  if (pa.maj !== pb.maj) return pa.maj - pb.maj;
  if (pa.min !== pb.min) return pa.min - pb.min;
  if (pa.pat !== pb.pat) return pa.pat - pb.pat;

  if (pa.prerelease === null && pb.prerelease === null) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;

  const sa = pa.prerelease.split('.');
  const sb = pb.prerelease.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const xa = sa[i];
    const xb = sb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const na = /^\d+$/.test(xa) ? parseInt(xa, 10) : null;
    const nb = /^\d+$/.test(xb) ? parseInt(xb, 10) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na - nb;
    } else if (na !== null) {
      return -1;
    } else if (nb !== null) {
      return 1;
    } else {
      if (xa !== xb) return xa < xb ? -1 : 1;
    }
  }
  return 0;
}
