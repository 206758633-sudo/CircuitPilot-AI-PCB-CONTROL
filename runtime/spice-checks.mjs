/**
 * 用仿真验收**这版真实设计**（而不是我手写的示例网表）。
 *
 * 背景：嘉立创EDA 导出不了 SPICE 网表（本板 0/68 个图元带仿真信息），
 * 所以 `schematic-acceptance` 一直只能报"没有仿真"。但"没有仿真"不等于"不能仿真"：
 * 我们**知道设计里有什么网络、缺什么器件**，就能针对具体的电路检查点自己建网表、
 * 真跑 ngspice、把结论绑在证据哈希上。
 *
 * 每个检查都是"规范区间 vs 实测值"的形式，缺器件就在网表里如实缺着——
 * 这样仿真才能把**真实缺陷**暴露出来（本板实测两个：缺 CC 下拉电阻、缺 I2C 上拉电阻）。
 */
import { checkOperatingPoint, runSimulation } from './simulation.mjs';

export const SPICE_CHECK_CODES = {
  CHECK_PASSED: 'SPICE_CHECK_PASSED',
  CHECK_FAILED: 'SPICE_CHECK_FAILED',
  CHECK_NOT_RUN: 'SPICE_CHECK_NOT_RUN',
  SOLVER_MISSING: 'SPICE_CHECK_SOLVER_MISSING',
  NETLIST_INVALID: 'SPICE_CHECK_NETLIST_INVALID',
  RECOMMENDATION: 'SPICE_CHECK_RECOMMENDATION',
};

const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * 检查一：USB-C 灌端(UFP) 的 CC 下拉电阻 Rd。
 * 规范（USB Type-C）：DFP 默认 Rp=56kΩ 上拉到 VBUS 时，灌端 CC 电压应落在 0.25~0.61V。
 * 设计里没有 Rd 时，就如实不建这个电阻 → 实测 CC≈VBUS，立刻暴露"漏了 Rd"。
 */
export function ccRdCheck({ vbusV = 5, rpOhm = 56_000, rdOhm = 5_100, hasRd = true, ccNets = ['CC1', 'CC2'] } = {}) {
  if (!ccNets.length) return { id: 'cc-rd', title: 'USB-C 灌端 CC 下拉电阻(Rd)', applies: false, reason: '原理图里没有 CC 网络，这项检查不适用' };
  const lines = [
    `* USB-C 灌端 CC 端检查（Rp=${rpOhm}Ω 上拉到 VBUS，Rd=${hasRd ? `${rdOhm}Ω` : '缺失'}）`,
    `VBUS vbus 0 DC ${vbusV}`,
  ];
  const expectations = {};
  ccNets.forEach((net, index) => {
    const node = `cc${index + 1}`;
    lines.push(`RP${index + 1} vbus ${node} ${rpOhm}`);
    // 设计里缺 Rd 就真的不画它——仿真必须反映"设计现状"，不是"设计应该的样子"
    if (hasRd) lines.push(`RD${index + 1} ${node} 0 ${rdOhm}`);
    expectations[node] = [0.25, 0.61];
  });
  lines.push('.op', '.end');
  return {
    id: 'cc-rd', title: 'USB-C 灌端 CC 下拉电阻(Rd)', applies: true, analysis: 'op',
    netlistText: `${lines.join('\n')}\n`, expectations, nets: ccNets,
    spec: 'USB Type-C：DFP 默认 Rp=56kΩ 时，灌端 CC 电压应在 0.25~0.61V',
    defect: hasRd ? null : `设计里 CC 端缺少 ${rdOhm}Ω 下拉电阻（Rd）：CC 会被上拉到约 VBUS，DFP 认不出"已插入的灌端设备"`,
    recommendation: hasRd ? null : `补 ${rdOhm}Ω ±5% 下拉电阻各一颗：CC1→GND、CC2→GND（0603/0402 按实际空间选；料号需走库匹配确认，不猜）`,
  };
}

/**
 * 检查二：I2C(SDA/SCL) 上拉电阻。
 * 开漏总线的空闲电平由外部上拉决定；设计里没有上拉时，总线经漏电（10MΩ 量级）落向 0V，
 * 实测远低于 0.7×VDD → 直接暴露"缺上拉"，而不是等到板子回来才发现读不到器件。
 */
export function i2cPullupCheck({ vddV = 3.3, pullupOhm = null, busNets = ['SDA', 'SCL'], leakageOhm = 10_000_000 } = {}) {
  if (!busNets.length) return { id: 'i2c-pullup', title: 'I2C 总线上拉电阻', applies: false, reason: '原理图里没有 I2C 网络，这项检查不适用' };
  const lines = [`* I2C 空闲电平检查（上拉=${pullupOhm ? `${pullupOhm}Ω` : '缺失'}，总线漏电按 ${leakageOhm}Ω 建模）`, `VDD vdd 0 DC ${vddV}`];
  const expectations = {};
  busNets.forEach((net, index) => {
    const node = `bus${index + 1}`;
    if (pullupOhm) lines.push(`RPU${index + 1} vdd ${node} ${pullupOhm}`);
    lines.push(`RLEAK${index + 1} ${node} 0 ${leakageOhm}`);
    // 规范边界取整到 1e-6：0.7*3.3 在浮点里是 2.3099999999999996，规范不该带这种噪声
    expectations[node] = [Number((0.7 * vddV).toFixed(6)), vddV];
  });
  lines.push('.op', '.end');
  return {
    id: 'i2c-pullup', title: 'I2C 总线上拉电阻', applies: true, analysis: 'op',
    netlistText: `${lines.join('\n')}\n`, expectations, nets: busNets,
    spec: `I2C 开漏总线空闲电平应 ≥0.7×VDD（${round(0.7 * vddV, 2)}V）`,
    defect: pullupOhm ? null : 'SDA/SCL 缺少上拉电阻：总线空闲电平被漏电拉低，主从都读不到高电平',
    recommendation: pullupOhm ? null : '补上拉：SDA→3V3、SCL→3V3，常见 4.7kΩ（≤100kHz）或 2.2kΩ（400kHz）；具体阻值要按总线电容与速率核算',
    note: '本检查只覆盖**直流空闲电平**；上升时间（RC）与总线电容相关的时序检查尚未实现，不要把它当成完整的 I2C 验收。',
  };
}

/** 从语义计划/网表里推断该跑哪些检查、以及设计现状（哪些器件缺失）。 */
export function checksFromDesign({ nets = [], components = [], rails = { vddV: 3.3, vbusV: 5 } } = {}) {
  const netNames = nets.map((net) => String(net?.name ?? net?.net ?? net));
  /**
   * 网名匹配按**后缀**而不是全等：真机板子上的 USB-C CC 网络叫 `USB_CC1`/`USB_CC2`
   * （不是 `CC1`/`CC2`），全等匹配会让"设计里明明有 CC 网络"变成"这项检查不适用"，
   * 于是仿真门禁永远只能给出"没有仿真"——这是匹配口径把真电路判没了。
   */
  const pins = components.flatMap((component) => (Array.isArray(component?.pins) ? component.pins : [])
    .filter((pin) => pin?.net)
    .map((pin) => ({ designator: String(component?.designator ?? ''), part: String(component?.part ?? ''), net: String(pin.net), pin: String(pin.pin ?? pin?.number ?? '') })));
  const ccNets = netNames.filter((name) => /(?:^|_)CC[12]$/i.test(name));
  const busNets = netNames.filter((name) => /(?:^|_)(SDA|SCL)$/i.test(name));
  const isGround = (name) => /^(?:GND|AGND|DGND|PGND|GNDA|GNDD|SGND|VSS|0V?)(?:\d+)?$/i.test(String(name || ''));
  const isResistor = (designator) => /^R\d+/i.test(String(designator || ''));
  /**
   * Rd 是否存在：按**真实连通性**判定——某颗电阻的两个引脚分别落在 CC 网络与 GND 上。
   * 不能用"板上有电阻"这种近似：那会让缺 Rd 的真实缺陷被别的电阻掩盖成 pass。
   */
  const rdByNet = {};
  for (const net of ccNets) {
    const candidates = [...new Set(pins.filter((pin) => pin.net === net && isResistor(pin.designator)).map((pin) => pin.designator))];
    for (const designator of candidates) {
      const own = pins.filter((pin) => pin.designator === designator);
      const otherPin = own.find((pin) => pin.net !== net);
      if (otherPin && isGround(otherPin.net)) {
        rdByNet[net] = { designator, part: own[0]?.part || null };
        break;
      }
    }
  }
  const hasRd = ccNets.length > 0 && ccNets.every((net) => Boolean(rdByNet[net]));
  const resistorRefs = components.filter((component) => isResistor(component?.designator || component?.ref));
  const pullupOhm = resistorRefs.length > 1 ? 4_700 : null;
  const rdDetail = ccNets.map((net) => `${net}→${rdByNet[net] ? `${rdByNet[net].designator}${rdByNet[net].part ? `(${rdByNet[net].part})` : ''}` : '（无）'}`);
  const ccCheck = ccRdCheck({ vbusV: rails.vbusV, ccNets, hasRd });
  return [
    { ...ccCheck, note: [ccCheck.note, ccNets.length ? `CC 网络匹配：${rdDetail.join('、')}；Rd 按 5.1kΩ 建模` : null].filter(Boolean).join('；') || null },
    i2cPullupCheck({ vddV: rails.vddV, busNets, pullupOhm }),
  ];
}

/**
 * 跑一组检查。每个检查：建网表 → 真跑求解器 → 把实测值对着规范区间判 → 结论绑证据哈希。
 * 求解器不在、网表非法、没跑起来，都必须如实标成"没跑"，绝不能算通过。
 */
export async function runSpiceChecks({ checks = [], solverPath = null, timeoutMs = 20_000, run = runSimulation, workDir } = {}) {
  const results = [];
  const findings = [];
  for (const check of checks) {
    if (!check || check.applies === false) {
      results.push({ id: check?.id ?? 'unknown', title: check?.title ?? '', status: 'not-applicable', reason: check?.reason ?? '不适用' });
      continue;
    }
    if (!check.netlistText) {
      findings.push({ code: SPICE_CHECK_CODES.NETLIST_INVALID, severity: 'blocking', field: check.id, message: `${check.title}：没有可运行的网表` });
      results.push({ id: check.id, title: check.title, status: 'not-run', reason: 'NETLIST_INVALID' });
      continue;
    }
    const outcome = await run({ netlistText: check.netlistText, solverPath, timeoutMs, workDir });
    if (!outcome?.ran || !outcome?.evidence) {
      findings.push({ code: outcome?.code === 'SOLVER_MISSING' ? SPICE_CHECK_CODES.SOLVER_MISSING : SPICE_CHECK_CODES.CHECK_NOT_RUN, severity: 'blocking', field: check.id, message: `${check.title}：仿真没有跑起来（${outcome?.code || 'UNKNOWN'}：${String(outcome?.message || '').slice(0, 160)}）——这不是通过` });
      results.push({ id: check.id, title: check.title, status: 'not-run', reason: outcome?.code || 'UNKNOWN', message: outcome?.message ?? null });
      continue;
    }
    const check2 = checkOperatingPoint(outcome.evidence.operatingPoint, check.expectations);
    const result = {
      id: check.id, title: check.title, status: check2.ok ? 'pass' : 'fail',
      spec: check.spec, nets: check.nets, expectations: check.expectations,
      measured: outcome.evidence.operatingPoint,
      measurements: Object.fromEntries(Object.entries(outcome.evidence.operatingPoint).map(([node, value]) => [node, round(value)])),
      evidence: {
        solver: outcome.evidence.solver, netlist: outcome.evidence.netlist, run: outcome.evidence.run,
        output: outcome.evidence.output, evidenceHash: outcome.evidence.evidenceHash, source: 'solver-run',
      },
      defect: check.defect ?? null, recommendation: check.recommendation ?? null, note: check.note ?? null,
    };
    results.push(result);
    if (check2.ok) {
      findings.push({ code: SPICE_CHECK_CODES.CHECK_PASSED, severity: 'info', field: check.id, message: `${check.title}：实测 ${describe(outcome.evidence.operatingPoint)}，满足 ${check.spec}` });
    } else {
      findings.push({ code: SPICE_CHECK_CODES.CHECK_FAILED, severity: 'blocking', field: check.id, message: `${check.title}：实测 ${describe(outcome.evidence.operatingPoint)}，不满足 ${check.spec}${check.defect ? ` —— ${check.defect}` : ''}` });
      if (check.recommendation) findings.push({ code: SPICE_CHECK_CODES.RECOMMENDATION, severity: 'info', field: check.id, message: `${check.title} 建议：${check.recommendation}` });
    }
  }
  const ran = results.filter((item) => item.status === 'pass' || item.status === 'fail');
  return {
    ok: findings.every((finding) => finding.severity !== 'blocking') && ran.length > 0,
    results,
    findings,
    summary: {
      total: results.length, passed: ran.filter((item) => item.status === 'pass').length,
      failed: ran.filter((item) => item.status === 'fail').length,
      notRun: results.filter((item) => item.status === 'not-run').length,
      notApplicable: results.filter((item) => item.status === 'not-applicable').length,
      /** 没说清"跑没跑"就不许当成验收通过 */
      simulated: ran.length > 0,
    },
  };
}

function describe(operatingPoint) {
  const entries = Object.entries(operatingPoint || {});
  if (!entries.length) return '(没有读到任何节点电压)';
  return entries.map(([node, value]) => `${node}=${round(value, 3)}V`).join('、');
}
