import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LongTaskPanel } from '../LongTaskPanel';
import type { LongTaskSnapshot } from '../../services/longTask';

/**
 * F5/D8：长任务面板的真实点击交互（jsdom），补足此前只有 SSR 文案断言的问题：
 * - running 时"停止等待"按钮触发 onCancel，且措辞明确"只停止本页等待"；
 * - failed/timeout/cancelled 终态出现"重试"，点击触发 onRetry；
 * - 取消/超时不会被文案说成"任务已取消完成"。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const snapshot = (overrides: Partial<LongTaskSnapshot<unknown>>): LongTaskSnapshot<unknown> => ({
  status: 'running', polls: 0, startedAt: 1, finishedAt: null, elapsedMs: 0, result: null, error: null, note: null, ...overrides,
});

const render = (element: React.ReactElement) => { act(() => root.render(element)); };
const buttonByText = (text: string) => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(text));

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('D8 长任务面板交互', () => {
  it('运行中点击"停止等待"触发 onCancel，并显示取消语义说明', () => {
    const onCancel = vi.fn();
    render(<LongTaskPanel title="导出" snapshot={snapshot({ status: 'running', note: '长任务进行中；取消只停止本页等待，不代表服务端已终止' })} onCancel={onCancel} />);
    expect(container.textContent).toContain('取消只停止本页等待');
    act(() => { buttonByText('取消')?.click(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'timeout', 'cancelled'] as const)('终态 %s 显示重试并触发 onRetry', (status) => {
    const onRetry = vi.fn();
    render(<LongTaskPanel title="批量落件" snapshot={snapshot({ status, error: status === 'failed' ? '服务端拒绝' : null, note: status === 'cancelled' ? '已停止本页等待：服务端任务可能仍在执行或已落盘，以审计与产物目录为准' : null })} onRetry={onRetry} />);
    const retry = buttonByText('重试');
    expect(retry).toBeTruthy();
    act(() => { retry?.click(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('超时/取消不会显示成"已完成"，错误与边界说明可区分', () => {
    render(<LongTaskPanel snapshot={snapshot({ status: 'timeout', error: '超过 240s 未返回', note: '超时只是停止本页等待：服务端任务可能仍在执行或已落盘，稍后看审计/产物目录' })} />);
    expect(container.textContent).toContain('超过 240s 未返回');
    expect(container.textContent).toContain('稍后看审计/产物目录');
    expect(container.textContent).not.toContain('已完成');
  });
});
