/**
 * Pro 功能注册表
 *
 * 动态加载闭源客户端功能（路由、侧边栏、i18n 等）。
 * pro/client-features 不存在时返回 null——开源版正常运行。
 */
let proFeatures = null;
export async function loadProFeatures() {
    try {
        // 用变量拼接路径，避免 Vite 静态分析时报错（文件不存在是正常的——开源版）
        const base = '../../pro/client-features';
        const mod = await import(/* @vite-ignore */ `${base}/routes.js`);
        proFeatures = mod.default;
        return proFeatures;
    }
    catch {
        // pro/client-features 不存在 → 开源版
        return null;
    }
}
export function getProFeatures() {
    return proFeatures;
}
