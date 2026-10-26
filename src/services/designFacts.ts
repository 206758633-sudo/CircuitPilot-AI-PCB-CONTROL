/**
 * A1：把界面里录入的"设计事实"收敛成 Runtime 可比对的形状。
 *
 * 关键语义：**空值不写字段 = 拿不到事实**，对应约束会按 `unknown` 阻断；
 * 这里绝不把空值补成 0 或目标值，否则等于把"没测"伪装成"满足"。
 */
export interface DesignFactsDraft {
  widthMm: string;
  heightMm: string;
  powerTotalMa: string;
  gpioAvailable: string;
  interfaces: string;
  maxTemperatureC: string;
}

export const EMPTY_DESIGN_FACTS: DesignFactsDraft = Object.freeze({ widthMm: '', heightMm: '', powerTotalMa: '', gpioAvailable: '', interfaces: '', maxTemperatureC: '' });

const numberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 返回 null 表示"一条事实都没有"（不要传 {}，让服务端按未提供处理）。 */
export function buildDesignFacts(draft: DesignFactsDraft): Record<string, unknown> | null {
  const facts: Record<string, unknown> = {};
  const width = numberOrNull(draft.widthMm);
  const height = numberOrNull(draft.heightMm);
  if (width !== null || height !== null) facts.board = { ...(width !== null ? { widthMm: width } : {}), ...(height !== null ? { heightMm: height } : {}) };
  const totalMa = numberOrNull(draft.powerTotalMa);
  if (totalMa !== null) facts.power = { totalMa };
  const gpio = numberOrNull(draft.gpioAvailable);
  if (gpio !== null) facts.mcu = { gpioAvailable: gpio };
  const interfaces = draft.interfaces.split(/[、,，/\s+]+/).map((item) => item.trim()).filter(Boolean);
  if (interfaces.length) facts.interfaces = interfaces;
  const maxTemp = numberOrNull(draft.maxTemperatureC);
  if (maxTemp !== null) facts.environment = { maxTemperatureC: maxTemp };
  return Object.keys(facts).length ? facts : null;
}
