import { describe, expect, it } from 'vitest';
import { isWriteGateClosed, writeGateClosedReason } from '../writeGate';

/**
 * 2026-11-05 全链审计（PCB-P2-2 / UI-P1-2）：
 * 写门禁必须同时认"全局暂停"与"本会话暂停"；只认全局会让会话级暂停在 UI 侧失效，
 * 用户以为止血了但按钮仍亮（点下才被服务端 409）。
 */
describe('写门禁 UI 口径（全局 + 本会话）', () => {
  it('任一作用域暂停即为关闭', () => {
    expect(isWriteGateClosed({ writePaused: true, sessionPaused: false })).toBe(true);
    expect(isWriteGateClosed({ writePaused: false, sessionPaused: true })).toBe(true);
    expect(isWriteGateClosed({ writePaused: true, sessionPaused: true })).toBe(true);
  });

  it('都没暂停才放行；空值/缺字段按未暂停处理（不作假阻断）', () => {
    expect(isWriteGateClosed({ writePaused: false, sessionPaused: false })).toBe(false);
    expect(isWriteGateClosed({})).toBe(false);
    expect(isWriteGateClosed(null)).toBe(false);
    expect(isWriteGateClosed(undefined)).toBe(false);
  });

  it('原因文案能区分"去哪恢复"', () => {
    expect(writeGateClosedReason({ writePaused: true })).toMatch(/设置页/);
    expect(writeGateClosedReason({ sessionPaused: true })).toMatch(/本会话/);
  });
});
