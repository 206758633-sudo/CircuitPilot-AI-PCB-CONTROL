import { describe, expect, it } from 'vitest';
import { buildDesignFacts, EMPTY_DESIGN_FACTS } from '../designFacts';

describe('A1 设计事实收敛', () => {
  it('空表单 → null（拿不到事实，不伪造 0）', () => {
    expect(buildDesignFacts(EMPTY_DESIGN_FACTS)).toBeNull();
  });

  it('只填部分字段 → 只包含有值的事实，其余保持缺失', () => {
    const facts = buildDesignFacts({ ...EMPTY_DESIGN_FACTS, widthMm: ' 60 ', heightMm: '40', powerTotalMa: '800' });
    expect(facts).toEqual({ board: { widthMm: 60, heightMm: 40 }, power: { totalMa: 800 } });
  });

  it('接口按逗号/顿号/空格拆分并去重空项；非法数字不写入', () => {
    const facts = buildDesignFacts({ ...EMPTY_DESIGN_FACTS, interfaces: 'USB、I2C, UART  ', gpioAvailable: 'abc', maxTemperatureC: '60' });
    expect(facts).toEqual({ interfaces: ['USB', 'I2C', 'UART'], environment: { maxTemperatureC: 60 } });
  });
});
