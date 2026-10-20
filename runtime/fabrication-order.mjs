/**
 * 板厂下单参数卡：把"这块板现在是什么样"和"我打算怎么下单"两件事摆在一起核对。
 *
 * 为什么值得单独做：本仓库此前"走向生产"只有一条嘉立创 DFM 官网超链接——
 * 参数没人核对、文件是不是草稿没人拦、报价没人说清。结果是用户很容易拿着 4 层的参数
 * 去下 6 层的板，或者拿一个带 `DRAFT-NOT-FOR-ORDER` 的文件下单，而这些都不该靠"用户细心"。
 *
 * 三条底线：
 *  1. **只写实测**：尺寸/层数来自当前板子（板框多边形、铜层数），不是从参数表里抄的；
 *  2. **假设必须显式**：板厂能力值一律标 `provenance: assumed-default`，随卡附上"请按板厂官网核对"；
 *  3. **价格不猜**：没有报价来源就写 `unknown` 并说明原因，绝不给一个"看起来合理"的数。
 */

export const ORDER_CODES = {
  LAYER_MISMATCH: 'ORDER_LAYER_COUNT_MISMATCH',
  SIZE_EXCEEDS_CAPABILITY: 'ORDER_SIZE_EXCEEDS_CAPABILITY',
  PARAM_UNSUPPORTED: 'ORDER_PARAM_UNSUPPORTED',
  IMPEDANCE_WITHOUT_EVIDENCE: 'ORDER_IMPEDANCE_WITHOUT_EVIDENCE',
  FILE_MISSING: 'ORDER_FILE_MISSING',
  FILE_IS_DRAFT: 'ORDER_FILE_IS_DRAFT',
  MUST_FIX_OPEN: 'ORDER_MUST_FIX_OPEN',
  PRICE_UNKNOWN: 'ORDER_PRICE_UNKNOWN',
  QUANTITY_ASSUMED: 'ORDER_QUANTITY_ASSUMED',
};

/**
 * 默认能力档：**示例值，不是嘉立创的承诺**。下单前必须按板厂官网核对，
 * 所以它带着 provenance 一起走，并且可以在请求里整体覆盖。
 */
export const DEFAULT_CAPABILITY = Object.freeze({
  provenance: 'assumed-default',
  layers: [1, 2, 4, 6, 8, 10],
  maxSizeMm: { x: 400, y: 500 },
  minTrackMm: 0.09,
  minClearanceMm: 0.09,
  thicknessMm: [0.6, 0.8, 1.0, 1.2, 1.6, 2.0],
  copperWeightOz: [1, 2],
  surfaceFinish: ['HASL', 'HASL-LF', 'ENIG', 'OSP'],
  impedanceControlSupported: true,
  note: '示例默认能力值：下单前请按板厂官网/客服确认（尤其是厚铜、阻抗、特殊工艺）。',
});

const REQUIRED_FILE_KINDS = ['gerber', 'bom', 'cpl'];
const draftLike = (value) => typeof value === 'string' && /draft|not[-_ ]?for[-_ ]?order|草稿|请勿下单/i.test(value);

const finding = (code, severity, message, field = null) => ({ code, severity, message, field });

const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

/**
 * `Number(null)` 是 0、`Number('')` 也是 0——"没读到"会被静默变成 0，然后 0 又会伪装成"读到 0 层"。
 * 这条边界专门拦它：没读到就是 null，任何下游判断都必须能区分"0"和"不知道"。
 */
const finiteOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * 从实测数据里提炼"这块板是什么样"。
 * @param {object} input
 * @param {Array<{x:number,y:number}>} [input.outlinePoints] 板框多边形（mm）
 * @param {number|null} [input.copperLayerCount] 铜层数（实机读回）
 * @param {string[]} [input.designators] 位号（实机网表/放置读回）
 * @param {number|null} [input.netCount] 网络数
 * @param {object|null} [input.drcReport] 官方 DRC 报告（用于统计 must-fix）
 * @param {Array<{name:string,impedanceOhm?:number}>} [input.impedanceNets] 阻抗受控网络
 */
export function deriveBoardFacts({ outlinePoints = [], copperLayerCount = null, designators = [], netCount = null, drcReport = null, impedanceNets = [] } = {}) {
  const xs = outlinePoints.map((point) => Number(point?.x)).filter(Number.isFinite);
  const ys = outlinePoints.map((point) => Number(point?.y)).filter(Number.isFinite);
  const sizeMm = xs.length && ys.length
    ? { x: round(Math.max(...xs) - Math.min(...xs), 2), y: round(Math.max(...ys) - Math.min(...ys), 2) }
    : null;
  const mustFix = (drcReport?.items || []).filter((item) => item?.disposition === 'must-fix');
  return {
    sizeMm,
    outlinePointCount: outlinePoints.length,
    copperLayerCount: finiteOrNull(copperLayerCount),
    componentCount: Array.isArray(designators) ? designators.length : null,
    netCount: finiteOrNull(netCount),
    drcMustFixCount: (drcReport?.items || []).length ? mustFix.length : null,
    drcItemCount: (drcReport?.items || []).length ? drcReport.items.length : null,
    impedanceNets: (impedanceNets || []).map((net) => ({ name: net.name ?? net.net ?? null, impedanceOhm: Number.isFinite(Number(net.impedanceOhm)) ? Number(net.impedanceOhm) : null })),
  };
}

/**
 * 生成下单参数卡。
 *
 * @param {object} options
 * @param {object} options.facts `deriveBoardFacts` 的结果
 * @param {{layers?:number, thicknessMm?:number, copperWeightOz?:number, surfaceFinish?:string, impedanceControl?:boolean, quantity?:number, panelize?:boolean, soldermaskColor?:string, leadTimeDays?:number}} options.requested 想怎么下单
 * @param {object} [options.capability] 板厂能力档（默认示例值，可覆盖）
 * @param {Array<{kind:string,name?:string,path?:string,missing?:boolean}>} [options.files] 准备交付的生产文件
 * @param {{amount?:number,currency?:string,source?:string}|null} [options.price] 报价（没有就传 null）
 */
export function buildFabricationOrder({ facts = {}, requested = {}, capability = DEFAULT_CAPABILITY, files = [], price = null } = {}) {
  const cap = { ...DEFAULT_CAPABILITY, ...capability };
  const findings = [];
  const assumptions = [];

  if (cap.provenance === 'assumed-default') assumptions.push({ field: 'capability', value: '示例默认能力档', why: cap.note });

  // 1) 层数必须与实测一致：这是"拿错参数下错板"最常见也最贵的一种错
  const layers = requested.layers ?? facts.copperLayerCount;
  if (requested.layers !== undefined && Number.isFinite(Number(requested.layers)) && facts.copperLayerCount !== null && Number(requested.layers) !== facts.copperLayerCount) {
    findings.push(finding(ORDER_CODES.LAYER_MISMATCH, 'blocking', `下单声明 ${requested.layers} 层，而当前板实测铜层 ${facts.copperLayerCount} 层——按此下单会得到一块与设计不同的板`, 'layers'));
  } else if (facts.copperLayerCount === null) {
    findings.push(finding(ORDER_CODES.LAYER_MISMATCH, 'unknown', '没有读到当前板的铜层数：层数属于下单必填且不可猜的项，请先连上 EDA 读回', 'layers'));
  }
  if (layers !== undefined && Array.isArray(cap.layers) && !cap.layers.includes(Number(layers))) {
    findings.push(finding(ORDER_CODES.PARAM_UNSUPPORTED, 'blocking', `能力档不支持 ${layers} 层`, 'layers'));
  }

  // 2) 尺寸：实测板框 vs 能力上限
  if (facts.sizeMm && cap.maxSizeMm) {
    const overX = facts.sizeMm.x > cap.maxSizeMm.x;
    const overY = facts.sizeMm.y > cap.maxSizeMm.y;
    if (overX || overY) findings.push(finding(ORDER_CODES.SIZE_EXCEEDS_CAPABILITY, 'blocking', `实测尺寸 ${facts.sizeMm.x}×${facts.sizeMm.y}mm 超出能力上限 ${cap.maxSizeMm.x}×${cap.maxSizeMm.y}mm`, 'sizeMm'));
  } else if (!facts.sizeMm) {
    findings.push(finding(ORDER_CODES.SIZE_EXCEEDS_CAPABILITY, 'unknown', '没有读到板框，尺寸无法核对', 'sizeMm'));
  }

  // 3) 工艺参数必须在能力档里；不在就明确说不支持，而不是"应该行"
  const unsupported = [
    ['thicknessMm', requested.thicknessMm, cap.thicknessMm],
    ['copperWeightOz', requested.copperWeightOz, cap.copperWeightOz],
    ['surfaceFinish', requested.surfaceFinish, cap.surfaceFinish],
  ];
  for (const [field, value, allowed] of unsupported) {
    if (value === undefined || value === null) continue;
    if (!Array.isArray(allowed) || !allowed.map(String).includes(String(value))) {
      findings.push(finding(ORDER_CODES.PARAM_UNSUPPORTED, 'blocking', `${field}=${value} 不在能力档（${(allowed || []).join('/')}）里`, field));
    }
  }
  for (const [field, value] of [['thicknessMm', requested.thicknessMm], ['copperWeightOz', requested.copperWeightOz], ['surfaceFinish', requested.surfaceFinish]]) {
    if (value === undefined || value === null) assumptions.push({ field, value: field === 'thicknessMm' ? 1.6 : field === 'copperWeightOz' ? 1 : 'HASL-LF', why: '未指定，按板厂常规默认；下单前请确认' });
  }

  // 4) 阻抗控制要有证据：没有叠层/阻抗网络就是"无法验证"，不能默认板厂会替我们搞定
  if (requested.impedanceControl === true) {
    const hasNets = (facts.impedanceNets || []).length > 0;
    if (!hasNets) findings.push(finding(ORDER_CODES.IMPEDANCE_WITHOUT_EVIDENCE, 'blocking', '要求阻抗控制，但当前板上没有识别到阻抗受控网络（没有叠层/阻抗证据）', 'impedanceControl'));
    else if (!cap.impedanceControlSupported) findings.push(finding(ORDER_CODES.PARAM_UNSUPPORTED, 'blocking', '能力档声明不支持阻抗控制', 'impedanceControl'));
  }

  // 5) 文件：缺一个都不能下单；草稿文件更不能
  const byKind = new Map((files || []).map((file) => [file?.kind, file]));
  for (const kind of REQUIRED_FILE_KINDS) {
    const file = byKind.get(kind);
    if (!file || file.missing) findings.push(finding(ORDER_CODES.FILE_MISSING, 'blocking', `缺少 ${kind} 生产文件`, kind));
    else if (draftLike(file.name || file.path)) findings.push(finding(ORDER_CODES.FILE_IS_DRAFT, 'blocking', `${kind} 文件是草稿（${file.name || file.path}）：草稿不得用于下单`, kind));
  }

  // 6) 还有 must-fix 的 DRC 项：明确提醒，不因为"文件齐了"就放行
  if (Number.isFinite(facts.drcMustFixCount) && facts.drcMustFixCount > 0) {
    findings.push(finding(ORDER_CODES.MUST_FIX_OPEN, 'blocking', `官方 DRC 还有 ${facts.drcMustFixCount} 条必须修的问题（共 ${facts.drcItemCount} 条）未处理`, 'drc'));
  } else if (facts.drcMustFixCount === null) {
    findings.push(finding(ORDER_CODES.MUST_FIX_OPEN, 'unknown', '没有 DRC 报告：不能假定没问题', 'drc'));
  }

  // 7) 报价：没有来源就说不知道
  if (!price || !Number.isFinite(Number(price.amount))) {
    findings.push(finding(ORDER_CODES.PRICE_UNKNOWN, 'warning', '没有报价来源：本系统不猜价格（需要板厂/商城的真实报价接口，例如 LCSC 凭据）', 'price'));
  }

  const quantity = Number.isFinite(Number(requested.quantity)) ? Number(requested.quantity) : null;
  if (quantity === null) assumptions.push({ field: 'quantity', value: 5, why: '未指定数量，示例按 5 片；下单前请确认' });

  const blocking = findings.filter((item) => item.severity === 'blocking');
  const unknown = findings.filter((item) => item.severity === 'unknown');
  return {
    kind: 'fabrication-order-card',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    readyToOrder: blocking.length === 0 && unknown.length === 0,
    parameters: {
      layers: layers ?? null,
      sizeMm: facts.sizeMm,
      thicknessMm: requested.thicknessMm ?? 1.6,
      copperWeightOz: requested.copperWeightOz ?? 1,
      surfaceFinish: requested.surfaceFinish ?? 'HASL-LF',
      impedanceControl: requested.impedanceControl === true,
      quantity: quantity ?? 5,
      panelize: requested.panelize === true,
      soldermaskColor: requested.soldermaskColor ?? 'green',
      leadTimeDays: Number.isFinite(Number(requested.leadTimeDays)) ? Number(requested.leadTimeDays) : null,
    },
    derived: facts,
    capability: cap,
    files: (files || []).map((file) => ({ kind: file?.kind ?? null, name: file?.name ?? null, path: file?.path ?? null, bytes: file?.bytes ?? null, draft: draftLike(file?.name || file?.path) })),
    price: price && Number.isFinite(Number(price.amount)) ? { status: 'known', ...price } : { status: 'unknown', reason: '没有报价来源：本系统不猜价格；接入板厂/商城真实报价接口（或提供 LCSC 凭据）后才有数' },
    findings,
    assumptions,
    counts: { blocking: blocking.length, unknown: unknown.length, warning: findings.filter((item) => item.severity === 'warning').length },
    humanSignoffRequired: true,
    nextStep: blocking.length || unknown.length
      ? '按 findings 逐条处理：修设计 → 重跑门禁 → 重新导出正式命名的生产文件 → 再来生成下单卡'
      : '参数与文件已自洽：可交给板厂/商城下单（金额与交期以板厂报价为准，仍需人工签字）',
  };
}
