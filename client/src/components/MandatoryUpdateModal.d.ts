/**
 * Mandatory(强制)更新模态:全屏阻塞,只能"立即重启"。
 *
 * 显示条件:updater.state.status === 'downloaded' && mandatory === true。
 * 用于安全修复 / 云端 API 协议变更等老版本无法继续工作的场景,普通版本升级不该触发。
 */
export declare function MandatoryUpdateModal(): import("react/jsx-runtime").JSX.Element | null;
