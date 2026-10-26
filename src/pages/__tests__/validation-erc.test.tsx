import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErcDetailEvidence } from '../ValidationPage';
import type { ErcReport } from '../../types';

/**
 * 第 61 轮（T2）：ERC 明细来源/目标文档/逐条明细的 UI 契约。
 * 这些断言盯的是"诚实"红线：
 *   1. 报告里必须显示本次检查的原理图 documentUuid（多板工程不能答非所问）；
 *   2. detailSource=aggregate 时必须明说"没有逐条明细"，且**不渲染**逐条表格（不能拿聚合计数冒充）；
 *   3. 旧版证据没有 documentUuid 时如实说"未记录"，不假装知道。
 */

const baseReport = (overrides: Partial<ErcReport> = {}): ErcReport => ({
  schemaVersion: 1,
  ran: true,
  aggregateOnly: false,
  detailAvailable: true,
  counts: { fatal: 0, error: 0, warning: 0, info: 0, total: 0 },
  openCounts: { fatal: 0, error: 0, warning: 0, info: 0, total: 0 },
  findings: [],
  groups: [],
  digest: 'e'.repeat(64),
  ...overrides,
});

describe('第 61 轮 ERC 明细证据块', () => {
  it('显示本次 ERC 检查的原理图 documentUuid，并渲染 ui-dom 逐条明细', () => {
    const report = baseReport({
      documentUuid: '9f2c4a7d1b3e5f60',
      detailSource: 'ui-dom',
      counts: { fatal: 0, error: 1, warning: 0, info: 0, total: 1 },
      openCounts: { fatal: 0, error: 1, warning: 0, info: 0, total: 1 },
      findings: [
        {
          id: 'erc-a1',
          severity: 'error',
          code: 'ERC_POWER_PIN',
          title: '电源脚未连接',
          object: 'U1.VCC',
          detail: '电源引脚没有连接',
          suggestion: '补电源标志或连线后重跑 ERC',
          aggregate: false,
          count: 1,
        },
      ],
    });

    const html = renderToStaticMarkup(<ErcDetailEvidence report={report} ercDetail={{ ok: true, source: 'ui-dom', counts: { error: 1 } }} />);

    expect(html).toContain('本次 ERC 检查的原理图文档');
    expect(html).toContain('9f2c4a7d1b3e5f60');
    // 明细来源徽标必须写清 ui-dom = EDA 面板逐条。
    expect(html).toContain('ui-dom');
    expect(html).toContain('ERC 逐条明细');
    // 逐条字段：级别 / 代码 / 对象 / 说明。
    expect(html).toContain('U1.VCC');
    expect(html).toContain('ERC_POWER_PIN');
    expect(html).toContain('电源脚未连接');
  });

  it('detailSource=aggregate 时如实说明没有逐条明细，且不渲染逐条表格冒充', () => {
    const report = baseReport({
      documentUuid: 'aabbccddeeff0011',
      aggregateOnly: true,
      detailAvailable: false,
      detailSource: 'aggregate',
      counts: { fatal: 0, error: 1, warning: 34, info: 0, total: 35 },
      openCounts: { fatal: 0, error: 1, warning: 34, info: 0, total: 35 },
      findings: [
        {
          id: 'erc-agg-error',
          severity: 'error',
          code: 'ERC_UNKNOWN',
          title: 'ERROR（1 项）',
          object: 'unknown',
          detail: 'EDA 只返回聚合计数（1 项），没有逐条对象/规则明细。',
          suggestion: '先让 EDA 返回明细再决定修复',
          aggregate: true,
          count: 1,
        },
        {
          id: 'erc-agg-warning',
          severity: 'warning',
          code: 'ERC_UNKNOWN',
          title: 'WARNING（34 项）',
          object: 'unknown',
          detail: 'EDA 只返回聚合计数（34 项），没有逐条对象/规则明细。',
          suggestion: '先让 EDA 返回明细再决定修复',
          aggregate: true,
          count: 34,
        },
      ],
    });

    const html = renderToStaticMarkup(<ErcDetailEvidence report={report} ercDetail={{ ok: false, reason: 'ERC_DETAIL_TIMEOUT' }} />);

    // 诚实话术：没有逐条明细 + 原因 + 到 EDA 面板跑一次再重试的指引。
    expect(html).toContain('本次没有逐条明细，只有聚合计数。');
    expect(html).toContain('aggregate');
    expect(html).toContain('不能当逐条修复依据');
    expect(html).toContain('ERC_DETAIL_TIMEOUT');
    expect(html).toContain('手动点一次');
    // 聚合计数单独成表，明确"不是逐条明细"。
    expect(html).toContain('ERC 聚合计数（仅计数，不是逐条明细）');
    // 红线：没有任何逐条表格/逐条行被渲染出来。
    expect(html).not.toContain('ERC 逐条明细');
    expect(html).not.toContain('U1.VCC');
  });

  it('旧版证据缺 documentUuid 时如实说“未记录”，不假装知道检查的是哪一页', () => {
    const report = baseReport({ documentUuid: null, detailSource: 'aggregate', aggregateOnly: true, detailAvailable: false });
    const html = renderToStaticMarkup(<ErcDetailEvidence report={report} />);
    expect(html).toContain('未记录 documentUuid');
    expect(html).toContain('不能拿别的页面');
    expect(html).not.toContain('erc-document-uuid');
  });
});
