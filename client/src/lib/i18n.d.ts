import i18n from 'i18next';
export declare function getSavedLanguage(): string;
/**
 * 加载某 locale 的所有命名空间到 i18next resources。
 * 已加载过则直接返回。所有 namespace 并发加载。
 */
export declare function loadLocaleNamespaces(lng: string): Promise<void>;
export declare const SUPPORTED_LANGUAGES: readonly [{
    readonly code: "en";
    readonly label: "English";
}, {
    readonly code: "zh-CN";
    readonly label: "简体中文";
}, {
    readonly code: "zh-TW";
    readonly label: "繁體中文";
}, {
    readonly code: "ja";
    readonly label: "日本語";
}, {
    readonly code: "ko";
    readonly label: "한국어";
}, {
    readonly code: "fr";
    readonly label: "Français";
}, {
    readonly code: "es";
    readonly label: "Español";
}, {
    readonly code: "de";
    readonly label: "Deutsch";
}, {
    readonly code: "pt-BR";
    readonly label: "Português (Brasil)";
}, {
    readonly code: "ru";
    readonly label: "Русский";
}, {
    readonly code: "it";
    readonly label: "Italiano";
}, {
    readonly code: "tr";
    readonly label: "Türkçe";
}];
/**
 * 切换应用语言。先 await 加载对应 locale 的所有 namespace,再切换 i18n,
 * 避免短暂"翻译 key 直接显示"闪烁。
 */
export declare function changeAppLanguage(code: string): Promise<void>;
export default i18n;
