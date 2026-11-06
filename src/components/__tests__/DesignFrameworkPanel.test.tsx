import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 离线设计闭环面板：真实渲染 + mock runtimeClient（只验证 UI 语义与只读边界）。
 * 关键断言：needs-review 绝不渲染成"通过"；外部工具缺失如实显示不可用。
 */
vi.mock('../../services/runtimeClient', () => {
  class RuntimeApiError extends Error {
    code = 'RUNTIME_ERROR';
    status = 500;
  }
  return {
    RuntimeApiError,
    runtimeClient: {
      designFrameworkStatus: vi.fn(),
      designFrameworkGolden: vi.fn(),
      designFrameworkRun: vi.fn(),
    },
  };
});

import { runtimeClient } from '../../services/runtimeClient';
import { DesignFrameworkPanel } from '../DesignFrameworkPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const statusView = {
  schemaVersion: 1,
  kicad: { available: false, command: null, reason: '已尝试 1 个候选，均不可用' },
  externalSolvers: { ortools: { available: false }, z3: { available: false }, shapely: { available: false } },
  layers: ['design-as-code', 'rule-as-code', 'external-drc', 'solvers', 'plan-verify-repair', 'golden-eval'],
};

const goldenView = {
  ok: true,
  metrics: {
    schemaVersion: 1, total: 5, passed: 5, failed: 0, passRate: 1,
    statusCounts: { 'needs-review': 3, blocked: 2 }, avgIterations: 1.4, totalRepairs: 2,
    ruleCoverageAvg: 0.2119, failures: [] as Array<Record<string, unknown>>,
  },
  results: [],
};

const loopView = {
  ok: true,
  status: 'needs-review',
  iterations: [],
  repairCount: 1,
  repairs: [{ iteration: 1, strategy: 'solve_placement', riskLevel: 'medium' }],
  summary: { initialDigest: 'a'.repeat(64), finalDigest: 'b'.repeat(64), iterations: 2, repairs: 1, blocking: 0, review: 144, ruleCoverage: 0.2119, releaseReady: false, model: null },
  rules: null,
  netlist: null,
  plan: { operations: 1, skipped: [] },
  evidence: null,
  digest: 'c'.repeat(64),
};

let container: HTMLDivElement;
let root: Root;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const clickButton = async (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label));
  expect(button, `找不到按钮：${label}`).toBeTruthy();
  await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
};

beforeEach(() => {
  (runtimeClient.designFrameworkStatus as ReturnType<typeof vi.fn>).mockResolvedValue(statusView);
  (runtimeClient.designFrameworkGolden as ReturnType<typeof vi.fn>).mockResolvedValue(goldenView);
  (runtimeClient.designFrameworkRun as ReturnType<typeof vi.fn>).mockResolvedValue(loopView);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.clearAllMocks();
});

describe('离线设计闭环面板', () => {
  it('渲染状态：KiCad CLI / 外部求解器缺失时如实显示不可用', async () => {
    await act(async () => { root.render(<DesignFrameworkPanel />); });
    await flush();
    expect(runtimeClient.designFrameworkStatus).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('不可用');
    expect(container.textContent).toContain('OR-Tools / Z3 / Shapely');
  });

  it('运行金板评估：展示通过数、needs-review/blocked 分布与覆盖率', async () => {
    await act(async () => { root.render(<DesignFrameworkPanel />); });
    await flush();
    await clickButton('运行金板评估');
    expect(runtimeClient.designFrameworkGolden).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('5/5');
    expect(container.textContent).toContain('needs-review=3');
    expect(container.textContent).toContain('21.2%');
  });

  it('运行闭环：needs-review 必须显示"需人工审阅（不是 passed）"，绝不显示通过', async () => {
    await act(async () => { root.render(<DesignFrameworkPanel />); });
    await flush();
    await clickButton('运行设计闭环');
    expect(runtimeClient.designFrameworkRun).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('需人工审阅（不是 passed）');
    expect(container.textContent).not.toContain('通过（仍需官方 DRC/审批）');
    // 只读边界提示必须在
    expect(container.textContent).toContain('写 EDA 仍需官方 ERC/DRC、人工审批');
  });

  it('非法 JSON 模型：给出明确错误，不调用 Runtime', async () => {
    await act(async () => { root.render(<DesignFrameworkPanel />); });
    await flush();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '{not-json');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickButton('运行设计闭环');
    expect(runtimeClient.designFrameworkRun).not.toHaveBeenCalled();
    expect(container.textContent).toContain('运行闭环失败');
  });
});
