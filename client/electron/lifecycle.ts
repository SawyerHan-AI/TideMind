/**
 * App lifecycle flags shared across modules.
 *
 * 为什么单独抽出来:`isQuitting` 起初是 main.ts 的局部变量,但 close() handler
 * 和 updater install 路径都需要它。原先 install 路径不知道这个 flag,触发
 * autoUpdater.quitAndInstall 内部调 app.quit() 时,close() handler 仍以为
 * "用户点关闭按钮"而 preventDefault + hide,导致 Squirrel.Mac swap 完成后
 * 进程没真退,forceRunAfter 的 relaunch 不触发(2026-05-20 Audit B-5)。
 * 把 flag 提到共享模块,updater 在调 quitAndInstall 前置 true,close() handler
 * 就会放行真正的 quit 路径,不再需要 setTimeout + app.exit(0) 这种硬重启 hack
 * (会绕过 before-quit hooks 导致 SQLite WAL 状态不一致)。
 */

let isQuitting = false;

export function setQuitting(): void {
  isQuitting = true;
}

export function getIsQuitting(): boolean {
  return isQuitting;
}
