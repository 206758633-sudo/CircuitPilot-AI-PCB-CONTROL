import { describe, expect, it } from 'vitest';
import { LAYOUT_INTENT_TEMPLATE, LAYOUT_INTENT_TEMPLATE_TEXT } from '../layoutIntentTemplate';

describe('layoutIntentTemplate', () => {
  it('是可解析 JSON，且覆盖排版审计需要的声明区', () => {
    const parsed = JSON.parse(LAYOUT_INTENT_TEMPLATE_TEXT) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
    for (const key of ['components', 'power', 'rf', 'thermal', 'pdn', 'highSpeed', 'creepage', 'clearance', 'enclosure', 'emc']) {
      expect(parsed[key]).toBeTruthy();
    }
    expect(parsed).toEqual(LAYOUT_INTENT_TEMPLATE);
  });

  it('占位符不会被当成真实位号/网络：提醒工程师替换而不是直接提交', () => {
    const text = LAYOUT_INTENT_TEMPLATE_TEXT;
    expect(text).toContain('<J1>');
    expect(text).toContain('<VBUS>');
    expect(text).toContain('替换');
  });
});
