/**
 * 2026-11-05 全链闭环审计（PCB-P2-2 / UI-P1-2 / RP0-5）：
 * Runtime 的写门禁有两个权威作用域——全局暂停（paused）与本会话暂停（sessionPaused），
 * 任一开启都必须让 UI 侧写按钮禁用并在函数首行拦截。修复前多处页面只认 `writePaused`，
 * 会话级暂停在界面上形同虚设（点下才被服务端 409）。这里收口成纯函数，便于逐页复用与单测。
 */

export interface WriteGateSettingsLike {
  writePaused?: boolean;
  sessionPaused?: boolean;
}

/** 任一作用域暂停都算"写入已关闭"（与 Runtime 的 assertEdaWritesOpen 同口径）。 */
export function isWriteGateClosed(settings: WriteGateSettingsLike | null | undefined): boolean {
  return settings?.writePaused === true || settings?.sessionPaused === true;
}

/** 给用户看的暂停原因（区分全局/本会话，避免"到底该去哪恢复"要靠猜）。 */
export function writeGateClosedReason(settings: WriteGateSettingsLike | null | undefined): string {
  return settings?.writePaused === true
    ? 'Runtime 全局写入已暂停：请先在设置页恢复写入'
    : '本会话写入已暂停：请关闭 EDA 页「暂停本会话写入」';
}
