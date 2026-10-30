/**
 * 封装完整性预检（Footprint Integrity Preflight）
 *
 * 为什么需要它（真机教训，2026-10-22 衣橱助手V2.0 案例）：
 * 原理图里放了一个 MEMS 麦克风（LMA2718B381，立创 C7587891），器件来自云端库，但本地标准库里
 * **没有它的封装资产**（`df3cd846…` / `a3127f62…` 两个 uuid 在 `lceda-std.elib` 中均不存在）。
 * 症状不是"放置失败"，而是：器件放得下、线也连得上，直到 ERC 才冒出一条
 * `[错误]：元件 … 的引脚与焊盘未对应（引脚没有对应焊盘：1、2、3）`。
 * 结果整条发布链卡在 `RELEASE_SCHEMATIC_NOT_READY`，而人只能从 ERC 面板的一句话反推根因。
 *
 * 这类问题的本质是**数据前置条件不成立**：
 *   引脚集合（原理图）  ✗  焊盘集合（封装实例）
 * 只要两者不一致，板子一定做不出来（焊盘缺 = 无法焊；焊盘多 = 可能连到不该连的铜）。
 *
 * 本模块把"能不能焊"的判断从 ERC 的聚合计数里提炼成**逐位号、逐引脚的结论**，
 * 让下游（发布门禁/PM 记录/自动化）在画完图的第一时间就能定位到"哪个元件、缺哪几个焊盘"。
 *
 * 设计约束：
 *   - 纯函数、零依赖、不做任何 EDA 调用 → 可以用假数据精确覆盖每个分支；
 *   - 证据语义 fail-closed：缺数据（没读到封装/没读到焊盘）算 blocking，不算"没有发现问题"；
 *   - 消息里必须带位号 + 引脚号 + 封装名，让结论可执行，而不是笼统的"封装有问题"。
 */

export const FOOTPRINT_INTEGRITY_CODES = {
  MISSING_FOOTPRINT: 'FOOTPRINT_INTEGRITY_MISSING_FOOTPRINT',
  PADS_MISSING: 'FOOTPRINT_INTEGRITY_PADS_MISSING',
  PIN_UNMAPPED: 'FOOTPRINT_INTEGRITY_PIN_UNMAPPED',
  PAD_UNUSED: 'FOOTPRINT_INTEGRITY_PAD_UNUSED',
  COMPONENT_MISSING_IN_PCB: 'FOOTPRINT_INTEGRITY_COMPONENT_MISSING_IN_PCB',
  NO_PART_READBACK: 'FOOTPRINT_INTEGRITY_NO_PART_READBACK',
};

const finding = (code, severity, message, field = null) => ({ code, severity, message, field });

/** 焊盘/引脚号统一成去空白字符串（EDA 不同版本可能返回 number 或 string）。 */
export function normalizeNumber(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text === 'NaN' || text === 'null' || text === 'undefined' ? '' : text;
}

/** 去重 + 保序 + 去掉空号；返回 { list, invalid }。 */
export function normalizeNumbers(values) {
  const list = [];
  let invalid = 0;
  for (const value of Array.isArray(values) ? values : []) {
    const number = normalizeNumber(value);
    if (!number) {
      invalid += 1;
      continue;
    }
    if (!list.includes(number)) list.push(number);
  }
  return { list, invalid };
}

const refdes = (part) => normalizeNumber(part?.designator ?? part?.refdes ?? part?.name);
const footprintOf = (part) => {
  const footprint = part?.footprint ?? null;
  const uuid = normalizeNumber(footprint?.uuid ?? footprint?.footprintUuid ?? part?.footprintUuid);
  const name = normalizeNumber(footprint?.name ?? footprint?.footprintName ?? part?.footprintName);
  return { uuid: uuid || null, name: name || null, raw: footprint };
};

/**
 * 评估"原理图引脚 ↔ PCB 焊盘"的一致性。
 *
 * @param {object} input
 * @param {Array<{designator?: string, primitiveId?: string, footprint?: object, footprintUuid?: string, pinNumbers?: Array<string|number>}>} input.schematicParts
 *        原理图器件（componentType=part）。`pinNumbers` 是该器件在原理图上的引脚号集合。
 * @param {Array<{designator?: string}>} [input.pcbComponents]
 *        PCB 上的器件位号集合（用来发现"原理图有、PCB 没有"的丢件）。
 * @param {Record<string, Array<string|number>>} [input.padsByDesignator]
 *        位号 → PCB 焊盘号集合。
 * @returns {{ready: boolean, findings: Array<object>, summary: object}}
 */
export function evaluateFootprintIntegrity({ schematicParts = [], pcbComponents = [], padsByDesignator = {} } = {}) {
  const findings = [];
  const parts = Array.isArray(schematicParts) ? schematicParts : [];
  const pcbRefdes = new Set((Array.isArray(pcbComponents) ? pcbComponents : []).map(refdes).filter(Boolean));
  const padsMap = padsByDesignator && typeof padsByDesignator === 'object' ? padsByDesignator : {};

  let missingFootprint = 0;
  let padsMissing = 0;
  let pinUnmapped = 0;
  let padUnused = 0;
  let missingInPcb = 0;
  let checked = 0;
  const seen = new Set();

  if (!parts.length) {
    findings.push(finding(FOOTPRINT_INTEGRITY_CODES.NO_PART_READBACK, 'blocking', '没有读到任何原理图器件（componentType=part）：无法判断封装/焊盘是否一致，不能当成"没问题"'));
  }

  for (const part of parts) {
    const desig = refdes(part);
    if (!desig) continue;
    if (seen.has(desig)) continue;
    seen.add(desig);
    checked += 1;

    const { uuid, name } = footprintOf(part);
    const label = name ? `${desig}（封装 ${name}）` : `${desig}（封装 ${uuid ?? '未绑定'}）`;

    if (!uuid) {
      missingFootprint += 1;
      findings.push(finding(FOOTPRINT_INTEGRITY_CODES.MISSING_FOOTPRINT, 'blocking',
        `${desig} 没有绑定封装：ERC 会报"引脚没有对应焊盘"，PCB 上也生成不出焊盘，这块板做不出来`, desig));
      continue;
    }

    const inPcb = pcbRefdes.has(desig);
    if (!inPcb) {
      missingInPcb += 1;
      findings.push(finding(FOOTPRINT_INTEGRITY_CODES.COMPONENT_MISSING_IN_PCB, 'warning',
        `${label} 在 PCB 里找不到：原理图与 PCB 未同步（若该器件本就不打算上板，请在 BOM/封装上明确排除，而不是靠沉默）`, desig));
      // PCB 上没有这个位号时，没有焊盘可读——此时再判"引脚没有对应焊盘"会重复归因，
      // 真正的问题是"没同步"，交给上面那条 warning + 发布门禁的 artifacts/placement 闸门处理。
      continue;
    }

    const pads = normalizeNumbers(padsMap[desig]).list;
    const pins = normalizeNumbers(part?.pinNumbers).list;

    if (inPcb && pads.length === 0) {
      padsMissing += 1;
      findings.push(finding(FOOTPRINT_INTEGRITY_CODES.PADS_MISSING, 'blocking',
        `${label} 在 PCB 上是 0 个焊盘：封装资产缺失或未实例化，器件焊不上去（真机案例：本地标准库无该封装，ERC 报"引脚没有对应焊盘"）`, desig));
      continue;
    }

    if (!pins.length) {
      // 引脚集合读不到时不能宣布"一致"；交给 ERC 兜底，这里只留可定位的 warning。
      findings.push(finding(FOOTPRINT_INTEGRITY_CODES.NO_PART_READBACK, 'warning',
        `${label} 没有读到引脚号：无法做引脚↔焊盘对照（请确认原理图引脚读取接口可用），封装结论只能交给 ERC`, desig));
      continue;
    }

    const pinSet = new Set(pins);
    const padSet = new Set(pads);
    const unmapped = pins.filter((pin) => !padSet.has(pin));
    const unused = pads.filter((pad) => !pinSet.has(pad));

    if (unmapped.length) {
      pinUnmapped += 1;
      findings.push(finding(FOOTPRINT_INTEGRITY_CODES.PIN_UNMAPPED, 'blocking',
        `${label} 有 ${unmapped.length} 个引脚没有对应焊盘（引脚 ${unmapped.join('、')}；封装焊盘 ${pads.join('、') || '无'}）：这些引脚无处可焊，制造必失败`, desig));
    }
    if (unused.length) {
      padUnused += 1;
      findings.push(finding(FOOTPRINT_INTEGRITY_CODES.PAD_UNUSED, 'warning',
        `${label} 有 ${unused.length} 个焊盘没有对应引脚（焊盘 ${unused.join('、')}）：多出的铜可能连到不该连的网络，需人工确认是否散热/接地焊盘`, desig));
    }
  }

  const blocking = findings.filter((item) => item.severity === 'blocking').length;
  const warnings = findings.filter((item) => item.severity === 'warning').length;
  return {
    ready: blocking === 0,
    findings,
    summary: {
      parts: parts.length,
      checked,
      pcbComponents: pcbRefdes.size,
      missingFootprint,
      missingInPcb,
      padsMissing,
      pinUnmapped,
      padUnused,
      blocking,
      warnings,
    },
  };
}
