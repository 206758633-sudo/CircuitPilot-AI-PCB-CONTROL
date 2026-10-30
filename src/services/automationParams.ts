/**
 * 自动化配方参数输入解析（E2）。
 *
 * 配方参数里既有普通文本（uuid/网络名），也有结构化值（如 `pcb-create-pour` 的
 * `outline: [[x,y],...]`）。UI 的输入框只有字符串，如果原样传字符串，
 * 桥侧会按"参数不合法"拒绝——所以这里只把**以 { 或 [ 开头**的值按 JSON 解析，
 * 解析失败就明确报错（fail-closed），绝不把坏 JSON 当普通字符串静默发出去。
 */
export function parseRecipeParamValue(raw: string): unknown {
  const value = String(raw ?? '');
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw Object.assign(new Error(`参数不是合法 JSON：${String(error instanceof Error ? error.message : error)}`), { code: 'AUTOMATION_PARAM_JSON_INVALID' });
  }
}

/** 把 UI 的字符串参数表转成配方参数；空值不进参数（保持"未填"语义，由配方校验报缺参）。 */
export function parseRecipeParams(input: Record<string, string>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (String(raw).trim() === '') continue;
    output[name] = parseRecipeParamValue(raw);
  }
  return output;
}
