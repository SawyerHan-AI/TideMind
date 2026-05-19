import type { PluginClientType } from '../../../lib/api-contract';
type PluginDetailTone = 'indigo' | 'blue' | 'emerald';
export interface PluginDetailMeta {
    tone: PluginDetailTone;
    hintKeys: string[];
    showSkillOutput?: boolean;
}
export interface PluginVerifyMcpMeta {
    labelKey: string;
    hintOkKey: string;
    hintFailKey: string;
}
export interface ToolTypeDef {
    id: PluginClientType;
    label: string;
    configPathKey: string;
    skillPathKey: string;
    /** 支持插件化安装 */
    pluginSupport: boolean;
    wizardConfigStepKey: string;
    pluginDetail?: PluginDetailMeta;
    pluginVerifyMcp?: PluginVerifyMcpMeta;
    /** 即将支持（置灰不可选） */
    comingSoon?: boolean;
}
export declare const TOOL_TYPES: ToolTypeDef[];
export declare function getToolTypeDef(toolType: string): ToolTypeDef | undefined;
export declare function isPluginSupported(toolType: string): boolean;
/** Codex ≥0.121 支持 `codex mcp add` 和原生 Skills 机制（v2 主路径） */
export declare function isCodexV2Version(version: string | null | undefined): boolean;
/** Gemini CLI ≥0.26 默认开启 hooks，是「会话启动自动注入用户画像」的最低要求 */
export declare function isGeminiHooksReady(version: string | null | undefined): boolean;
export {};
