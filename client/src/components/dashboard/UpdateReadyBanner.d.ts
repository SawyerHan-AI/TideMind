/**
 * 自动更新横幅:右下角浮窗,downloaded 状态才显示。
 *
 * 用户可"稍后"本地 dismiss(仅本进程内,下次启动重新弹);"立即重启"调
 * window.api.updater.install() 触发 quitAndInstall。
 */
export declare function UpdateReadyBanner(): import("react/jsx-runtime").JSX.Element | null;
