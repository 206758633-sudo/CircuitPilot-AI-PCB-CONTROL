import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../state/AppContext';
import { SettingsPage } from '../SettingsPage';

/**
 * UI P2-10（2026-11-05 审计）：设置页「前往EDA控制检查」修复前只是纯文本 `<small>`，
 * 用户被文案指引却没有任何可点的入口。这里断言它渲染成真实按钮，点击后走既有 hash 路由到 EDA 页。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const flush = async (rounds = 8) => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
};

beforeEach(() => {
  // 只验证导航接线：Runtime 探测失败即可（本页离线也能渲染"前往EDA控制检查"）。
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  window.history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('设置页 · EDA 入口（UI P2-10）', () => {
  it('「前往EDA控制检查」是可点击按钮，点击后跳转到 EDA 页', async () => {
    await act(async () => { root.render(<AppProvider><SettingsPage /></AppProvider>); });
    await flush();
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('前往EDA控制检查'));
    expect(button).toBeTruthy();
    expect(button?.tagName).toBe('BUTTON');
    await act(async () => { button?.click(); });
    await flush(2);
    expect(window.location.hash).toBe('#eda');
  });
});
