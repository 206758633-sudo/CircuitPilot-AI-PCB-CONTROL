import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../overlays';

/**
 * D9：对话框键盘可达性。项目没有 @testing-library/react，这里用 createRoot + React.act
 * 挂真实 DOM，断言焦点行为本身（初始焦点、Tab 循环、Escape 关闭、关闭后焦点归还），
 * 而不是断言组件内部状态。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let onClose: () => void;

function Harness({ close }: { close: () => void }) {
  const [open, setOpen] = useState(false);
  return <div>
    <button id="trigger" onClick={() => setOpen(true)}>打开对话框</button>
    <Modal open={open} onClose={() => { setOpen(false); close(); }} title="测试对话框">
      <input aria-label="字段 A" defaultValue="" />
      <button type="button">确认操作</button>
    </Modal>
  </div>;
}

const flushFrame = async () => {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onClose = vi.fn() as () => void;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function openDialog() {
  act(() => root.render(<Harness close={onClose} />));
  const trigger = container.querySelector<HTMLButtonElement>('#trigger')!;
  trigger.focus();
  await act(async () => { trigger.click(); });
  await flushFrame();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  return { trigger, dialog };
}

describe('D9 对话框键盘可达性', () => {
  it('打开后焦点进入对话框（不是留在背后页面），Esc 关闭并归还焦点', async () => {
    const { trigger, dialog } = await openDialog();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('测试对话框');
    expect(dialog.contains(document.activeElement)).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Tab 在对话框内循环：最后一个 → 第一个，Shift+Tab 反向', async () => {
    const { dialog } = await openDialog();
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button,input'));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(first);

    first.focus();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it('关闭后重新打开会再次把焦点放进对话框', async () => {
    const { trigger, dialog } = await openDialog();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(trigger);
    await act(async () => { trigger.click(); });
    await flushFrame();
    const reopened = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(reopened).not.toBe(dialog);
    expect(reopened.contains(document.activeElement)).toBe(true);
  });
});
