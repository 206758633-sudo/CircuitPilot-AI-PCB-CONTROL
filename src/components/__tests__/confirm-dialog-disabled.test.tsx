import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../overlays';

/**
 * UI P2-2（2026-11-05 审计）：确认框打开期间写门禁可能被暂停（用户可能刚在 EDA 页暂停本会话写入），
 * 所以 ConfirmDialog 需要能禁用"确认"并说明原因；否则暂停状态仍能被"确认"过去。
 * 这里只验证组件契约，具体面板接线由 LayerStackPanel 使用（typecheck 保证必填项匹配）。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const flush = async (rounds = 3) => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // Modal 走 createPortal，清掉 body 上残留的对话框节点。
  document.querySelectorAll('.overlay').forEach((node) => node.remove());
});

const renderDialog = async (confirmDisabled: boolean, onConfirm: () => void) => {
  await act(async () => {
    root.render(
      <ConfirmDialog
        open
        onClose={() => undefined}
        onConfirm={onConfirm}
        title="确认写叠层？"
        description="写板动作"
        confirmLabel="确认设置层数"
        confirmDisabled={confirmDisabled}
        confirmDisabledReason="本会话写入已暂停：请关闭 EDA 页「暂停本会话写入」"
      />,
    );
  });
  await flush();
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent?.includes('确认设置层数'))!;
};

describe('ConfirmDialog 写门禁禁用（UI P2-2）', () => {
  it('confirmDisabled=true：确认按钮 disabled、title 说明原因，点击不会触发 onConfirm', async () => {
    const onConfirm = vi.fn();
    const button = await renderDialog(true, onConfirm);
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('暂停');
    await act(async () => { button.click(); });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('默认可用：点击会触发 onConfirm', async () => {
    const onConfirm = vi.fn();
    const button = await renderDialog(false, onConfirm);
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
