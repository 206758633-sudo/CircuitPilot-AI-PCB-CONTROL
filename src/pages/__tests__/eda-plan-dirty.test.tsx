import { describe, expect, it } from 'vitest';
import { isPlanTextDirty } from '../EdaPage';

/**
 * UI P2-2（2026-11-05 审计）：计划编辑器被手动修改后，批准/执行不能再复用"上一次校验通过的计划"。
 * 这里是页面用到的纯判定函数：与校验结果（normalizeDesignPlan 的 plan）逐字符比较，
 * 只要文本变了就判定 dirty，批准/执行按钮据此禁用，直到重新校验成功。
 */
const validatedPlan = { title: 'MCU + 电源 + LED + 按键简单控制板', operations: [], nets: [] };

describe('计划脏状态判定（UI P2-2）', () => {
  it('文本与最近一次校验通过的计划完全一致 → 不脏', () => {
    expect(isPlanTextDirty(JSON.stringify(validatedPlan, null, 2), validatedPlan)).toBe(false);
  });

  it('文本被修改 → 脏（批准/执行必须拦住旧哈希）', () => {
    const edited = { ...validatedPlan, title: '改了标题的计划' };
    expect(isPlanTextDirty(JSON.stringify(edited, null, 2), validatedPlan)).toBe(true);
  });

  it('只是键顺序不同也算脏（字符串比较，不做语义"宽容"）', () => {
    const reordered = { operations: [], nets: [], title: validatedPlan.title };
    expect(isPlanTextDirty(JSON.stringify(reordered, null, 2), validatedPlan)).toBe(true);
  });

  it('还没有校验结果时不做脏判定（按钮另有 ready 门禁）', () => {
    expect(isPlanTextDirty('任意文本', null)).toBe(false);
    expect(isPlanTextDirty('任意文本', undefined)).toBe(false);
  });
});
