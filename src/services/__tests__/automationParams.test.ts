import { describe, expect, it } from 'vitest';
import { parseRecipeParamValue, parseRecipeParams } from '../automationParams';

describe('parseRecipeParamValue', () => {
  it('普通文本原样返回（uuid/网络名不能被 JSON 解析误伤）', () => {
    expect(parseRecipeParamValue('GND')).toBe('GND');
    expect(parseRecipeParamValue('04a04eb56ffd6173')).toBe('04a04eb56ffd6173');
    expect(parseRecipeParamValue('  ')).toBe('  ');
  });

  it('数组/对象按 JSON 解析（outline 顶点、expectedPourCount 等结构化参数）', () => {
    expect(parseRecipeParamValue('[[300,300],[500,300],[500,500]]')).toEqual([[300, 300], [500, 300], [500, 500]]);
    expect(parseRecipeParamValue('{"x":1}')).toEqual({ x: 1 });
  });

  it('以 { 或 [ 开头但不是合法 JSON 时明确报错，不静默当字符串发送', () => {
    expect(() => parseRecipeParamValue('[[300,300')).toThrowError(/不是合法 JSON/);
  });
});

describe('parseRecipeParams', () => {
  it('空值不进入参数（保持缺参语义），结构化值被解析', () => {
    const params = parseRecipeParams({ net: 'GND', layer: '', outline: '[[1,2],[3,4],[5,6]]', expectedPourCount: '3' });
    expect(params).toEqual({ net: 'GND', outline: [[1, 2], [3, 4], [5, 6]], expectedPourCount: '3' });
  });
});
