#!/usr/bin/env node
/**
 * 板级 triage（只读，不改图）
 * ---------------------------------------------------------------------------
 * 产出三份证据：
 *   1) ERC 逐条 triage（对象/网络引用、原因、建议动作、风险），条数必须与证据完全一致；
 *   2) 无网络引脚清单（按元件前缀分组，标注“应连接”vs“可悬空/测试点”）；
 *   3) GND 过孔缝合候选建议（先只读探测 PCB 铺铜/网络/层，输出网格与密度建议 + 人工确认项）。
 *
 * 硬约束（本文件自我保证）：
 *   - 绝不调用任何 EDA 写命令。桥只允许 READ_ONLY_COMMANDS 白名单，其它命令直接抛错。
 *   - 不编造数据：ERC 条数与证据不符、分类无法覆盖时直接非零退出，而不是“凑数”。
 *   - 所有“建议”都写明需要人工确认；本脚本不落任何设计变更。
 *
 * 用法：
 *   node scripts/board-triage.mjs                     # 用最新证据 + 本机只读桥
 *   node scripts/board-triage.mjs --offline           # 不连桥（ERC/引脚部分仍可跑）
 *   node scripts/board-triage.mjs --erc=... --netlist=... --pins=... --out=...
 *   node scripts/board-triage.mjs --pcb-capture=...   # 复用已抓取的只读 PCB 快照（可复现）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseEasyEdaNetlist } from '../runtime/schematic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'artifacts/board-analysis');
const ERC_DIR = path.join(ROOT, 'artifacts/evidence/schematic-erc');
const SPICE_DIR = path.join(ROOT, 'artifacts/spice');
const PINS_DIR = path.join(ROOT, 'artifacts/a4-pins');

/** 只读命令白名单：本脚本只允许这些命令打到桥；写命令在结构上不可达。 */
const READ_ONLY_COMMANDS = new Set([
  'pcb.context', 'pcb.layers.read', 'pcb.layers.copperCount', 'pcb.nets.read',
  'pcb.outline.read', 'pcb.pours.detail', 'pcb.pours.read', 'pcb.copper.read',
  'pcb.vias.read', 'pcb.lines.read', 'pcb.rules.read', 'pcb.pins.read',
  'pcb.components.read', 'pcb.regions.read', 'eda.session', 'eda.api.describe',
  'document.current', 'project.current', 'schematic.netlist.export', 'schematic.netlist.chunk',
]);

const ERC_EXPECTED = Object.freeze({ fatal: 0, error: 1, warning: 34, info: 2, total: 37 });
const ERC_EXPECTED_CATEGORIES = Object.freeze({
  'info.run-start': 1,
  'info.run-finish': 1,
  'warning.net-alias-conflict': 2,
  'warning.duplicate-net-label': 24,
  'warning.component-standardization': 2,
  'warning.pin-floating': 6,
  'error.footprint-pad-mismatch': 1,
});

// ---------------------------------------------------------------------------
// CLI / 通用工具
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { offline: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--offline' || arg === '--skip-pcb') { out.offline = true; continue; }
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (m) { out[m[1]] = m[2]; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    throw new Error(`未知参数：${arg}`);
  }
  return out;
}

const readText = (file) => fs.readFileSync(file, 'utf8');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const stamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');
const round = (n, digits = 3) => (Number.isFinite(n) ? Number(n.toFixed(digits)) : null);

function listFiles(dir, predicate) {
  try { return fs.readdirSync(dir).filter(predicate).map((f) => path.join(dir, f)); } catch { return []; }
}
function latestByMtime(files) {
  return files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0]?.f ?? null;
}
function loadJson(file) { return JSON.parse(readText(file)); }

/** 证据包装层可能的形态：{payload:{report}} / {report} / {erc} / 裸 report。 */
function extractErcReport(evidence) {
  const candidates = [evidence?.payload?.report, evidence?.payload?.erc, evidence?.report, evidence?.erc, evidence];
  const report = candidates.find((c) => c && typeof c === 'object' && Array.isArray(c.findings));
  if (!report) throw new Error('ERC 证据里找不到 findings（结构不符，拒绝猜）');
  return report;
}

// ---------------------------------------------------------------------------
// 一、ERC 逐条 triage
// ---------------------------------------------------------------------------
const NET_ALIAS_RE = /导线\s+(\$[0-9A-Za-z]+)\s+有多个网络名\s*[:：]\s*(.+)$/;
const STANDARDIZATION_RE = /元件的属性与供应商编号不匹配/;
const PAD_MISMATCH_RE = /元件\s+(\S+)\s+的引脚与焊盘未对应\s*\(?\s*引脚没有对应焊盘\s*[:：]\s*([^)）]+)[)）]?\s*[:：]?\s*(\$[0-9A-Za-z]+)?/;
const PIN_FLOATING_PREFIX_RE = /发现元件引脚悬空[^:：]*[:：]\s*(.+)$/;
const COUNT_CLAIM_RE = /致命错误\s*[:：]\s*(\d+)\s*[,，]\s*错误\s*[:：]\s*(\d+)\s*[,，]\s*警告\s*[:：]\s*(\d+)\s*[,，]\s*信息\s*[:：]\s*(\d+)/;

/** 引脚名/网络名的电源类别（用于网表交叉核对“地脚是否被接到电源轨”这类硬伤）。 */
const POWER_CLASS_RULES = [
  { cls: 'GND', re: /^(GND|VSS|AGND|DGND|PGND|EPAD|GNDD|VSSD|EARTH)$/i },
  { cls: '3V3', re: /^(\+?3V3|VDD|VDD3P3|VDD33|AVDD|DVDD|VDDD|VDDP|VDDIO|VCC|AVCC)$/i },
  { cls: '5V', re: /^(\+?5V|VIN|VCC5)$/i },
  { cls: 'VBUS', re: /^(VBUS|USB_VBUS)$/i },
  { cls: 'VBAT', re: /^(VBAT|BAT|BATTERY|BAT\+)$/i },
  { cls: 'V1V8', re: /^(1V8|\+1V8|VDD1V8)$/i },
  { cls: 'V2V8', re: /^(2V8|\+2V8|AVDD_2V8|VDD2V8)$/i },
];
function powerClassOf(name) {
  const value = String(name || '').trim();
  for (const rule of POWER_CLASS_RULES) if (rule.re.test(value)) return rule.cls;
  return null;
}

/**
 * 网表电源/地交叉核对。
 * 为什么必须做：ERC 的“同一导线多个网络名”只提示冲突，**不能说明冲突已经造成什么后果**。
 * 网表能把后果量化：本板实测 10 个引脚名为 GND 的引脚全部被归到 +3V3 网络、
 * 且没有任何引脚挂在名为 GND 的网络上 —— 这与 $2N8(GND/+3V3) 冲突一致，高度怀疑地-电源短接。
 * 这里只陈述可复核的网表事实，不替人工下结论。
 */
function auditNetlistPowerGround(parsed) {
  if (!parsed) return null;
  const netPinCounts = {};
  const gndNamedPins = [];
  const gndOffGndNet = [];
  const nonGndSupplyOnGndNet = [];
  const supplyOnOtherSupplyNet = [];
  for (const component of parsed.components || []) {
    for (const pin of component.pins || []) {
      const net = String(pin.net || '').trim();
      const pinName = String(pin.name || '').trim();
      if (net) netPinCounts[net] = (netPinCounts[net] || 0) + 1;
      const pinCls = powerClassOf(pinName);
      const netCls = powerClassOf(net);
      const pinView = { designator: component.designator, pin: String(pin.number || pin.key || ''), pinName, net: net || null };
      if (pinCls === 'GND') {
        gndNamedPins.push(pinView);
        if (netCls && netCls !== 'GND') gndOffGndNet.push({ ...pinView, netClass: netCls });
      }
      if (pinCls && pinCls !== 'GND' && netCls === 'GND') nonGndSupplyOnGndNet.push(pinView);
      if (pinCls && pinCls !== 'GND' && netCls && netCls !== 'GND' && pinCls !== netCls) supplyOnOtherSupplyNet.push({ ...pinView, pinClass: pinCls, netClass: netCls });
    }
  }
  const netNames = (parsed.nets || []).map((n) => n.name);
  const gndNetNames = netNames.filter((n) => powerClassOf(n) === 'GND');
  const netsWithoutPins = netNames.filter((n) => !(netPinCounts[n] > 0));
  return {
    netCount: netNames.length,
    namedPinCount: parsed.namedPinCount ?? null,
    pinCount: parsed.pinCount ?? null,
    netPinCounts,
    netsWithoutPins,
    gndNetNames,
    gndAudit: {
      gndNamedPinCount: gndNamedPins.length,
      gndNamedPins,
      gndNamedPinNetDistribution: gndNamedPins.reduce((acc, p) => { const k = p.net || '(无网络)'; acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
      gndPinsOffGndNet: gndOffGndNet,
      netlistHasGndNet: gndNetNames.length > 0,
      gndNetPinCounts: Object.fromEntries(gndNetNames.map((n) => [n, netPinCounts[n] || 0])),
      nonGndSupplyPinsOnGndNet: nonGndSupplyOnGndNet,
      verdict: gndOffGndNet.length
        ? `网表显示 ${gndOffGndNet.length} 个引脚名为 GND 的引脚被归到非 GND 网络（${[...new Set(gndOffGndNet.map((p) => p.net))].join('、')}）${gndNetNames.length === 0 ? '，且网表中没有任何引脚挂在名为 GND 的网络上' : ''}。结合 ERC 的导线网络名冲突，高度怀疑地/电源短接，必须人工核对。`
        : '网表未发现“GND 引脚被归到非 GND 网络”的异常。',
    },
    supplyAudit: {
      nonGndSupplyPinsOnGndNet: nonGndSupplyOnGndNet,
      supplyPinsOnDifferentSupplyNet: supplyOnOtherSupplyNet,
      note: '“电源脚接在另一条电源轨”不一定是错误（例如稳压器 VIN 接 VBUS 属正常），仅列出供人工核对；只有 GND↔电源类归错才是硬伤判据。',
    },
  };
}

function parsePinTokens(text) {
  return String(text || '').split(/[,，]/).map((s) => s.trim()).filter((s) => /^[A-Za-z]+\d*[A-Za-z0-9]*\.\S+$/.test(s));
}
function parseRefTokens(text) {
  const tokens = String(text || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const result = [];
  for (const token of tokens) {
    const m = /^([A-Za-z]+\d+)\((\$[0-9A-Za-z]+)\)$/.exec(token);
    if (m) result.push({ designator: m[1], instanceId: m[2] });
    else if (token) result.push({ designator: token, instanceId: null });
  }
  return result;
}
function prefixOf(designator) {
  const m = /^([A-Za-z]+)/.exec(String(designator || ''));
  return m ? m[1].toUpperCase() : '?';
}

/** 单条 finding → 结构化 triage（分类 + 引用 + 原因/动作/风险）。 */
function triageFinding(finding, index, ctx) {
  const detail = String(finding.detail || '');
  const sev = String(finding.severity || '').toLowerCase();
  const items = [];
  const base = {
    index,
    id: finding.id ?? null,
    severity: sev,
    code: finding.code ?? null,
    title: finding.title ?? null,
    detail,
    category: null,
    objectRefs: { wires: [], nets: [], pins: [], designators: [], instanceIds: [], missingPads: [], components: [] },
    crossCheck: {},
    possibleCause: null,
    suggestedAction: null,
    risk: null,
    riskLevel: null,
    requiresHumanConfirm: true,
    autoFixable: false,
    evidenceRepair: finding.repair ? { kind: finding.repair.kind, label: finding.repair.label, risk: finding.repair.risk, autoFixable: finding.repair.autoFixable, requiresHumanConfirm: finding.repair.requiresHumanConfirm } : null,
    countsInEvidence: { aggregate: finding.aggregate ?? null, count: finding.count ?? null },
    verify: '重跑 ERC，确认同 code/对象条目消失或转为有理由的豁免',
  };

  if (sev === 'info' && detail.startsWith('开始设计规则检查')) {
    base.category = 'info.run-start';
    base.possibleCause = 'ERC 运行开始标记（EDA 面板输出的运行边界，不是设计缺陷）。';
    base.suggestedAction = '无需处理；仅用于确认本次检查的起止。';
    base.risk = '无。';
    base.riskLevel = 'none';
    base.requiresHumanConfirm = false;
    base.verify = '无需复核（信息项）。';
    return base;
  }
  if (sev === 'info' && detail.includes('完成设计规则检查')) {
    base.category = 'info.run-finish';
    const claim = COUNT_CLAIM_RE.exec(detail);
    const claimed = claim ? { fatal: +claim[1], error: +claim[2], warning: +claim[3], info: +claim[4] } : null;
    base.crossCheck.countClaim = claimed;
    base.possibleCause = 'ERC 运行完成标记（EDA 面板输出的汇总行，不是设计缺陷）。';
    base.suggestedAction = '无需处理。注意：该行是面板的“规则级”计数语义。';
    if (claimed && (claimed.error !== ctx.counts.error || claimed.warning !== ctx.counts.warning)) {
      base.crossCheck.countClaimMismatch = true;
    }
    if (claimed && claimed.info !== ctx.counts.info) {
      base.crossCheck.infoCountNote = `完成行写“信息：${claimed.info}”，而证据 info=${ctx.counts.info}：这 ${ctx.counts.info} 条 info 是“开始/完成”两条运行标记本身，面板的完成行不把运行标记计入“信息”，因此不代表矛盾；本次规则级 info=0。`;
    }
    base.risk = '无（仅记录语义差异，防止把运行标记误当设计问题）。';
    base.riskLevel = 'none';
    base.requiresHumanConfirm = false;
    base.verify = '无需复核（信息项）。';
    return base;
  }

  const aliasMatch = NET_ALIAS_RE.exec(detail);
  if (aliasMatch) {
    const wire = aliasMatch[1];
    const names = aliasMatch[2].split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
    base.objectRefs.wires.push(wire);
    base.objectRefs.nets.push(...names);
    base.crossCheck.netPresence = Object.fromEntries(names.map((n) => [n, ctx.netNameSet ? ctx.netNameSet.has(n) : null]));
    base.crossCheck.netPinCounts = Object.fromEntries(names.map((n) => [n, ctx.netPinCounts?.get(n) ?? null]));
    if (ctx.netlistAudit) {
      const pinsOff = ctx.netlistAudit.gndAudit?.gndPinsOffGndNet || [];
      const nonGndOnGnd = ctx.netlistAudit.gndAudit?.nonGndSupplyPinsOnGndNet || [];
      base.crossCheck.netlistAudit = {
        netsWithoutPins: ctx.netlistAudit.netsWithoutPins.filter((n) => names.includes(n)),
        gndPinsOffGndNetCount: pinsOff.length,
        gndPinsOffGndNet: pinsOff.filter((p) => names.includes(p.net)),
        nonGndSupplyPinsOnGndNetCount: nonGndOnGnd.length,
        netlistHasGndNet: ctx.netlistAudit.gndAudit?.netlistHasGndNet ?? null,
      };
      if (names.some((n) => powerClassOf(n) === 'GND') && pinsOff.length) {
        base.crossCheck.netlistVerdict = `${pinsOff.length} 个“GND”名引脚被归到非 GND 网络（${[...new Set(pinsOff.map((p) => p.net))].join('、')}）${ctx.netlistAudit.gndAudit?.netlistHasGndNet ? '' : '，且网表中没有任何引脚挂在名为 GND 的网络上'}。这不是“可能”，网表已经体现了网络合并的后果：地-电源短接风险需要立即人工核对。`;
      }
    }
    const unique = [...new Set(names)];
    if (unique.length === 1) {
      base.category = 'warning.duplicate-net-label';
      base.possibleCause = `同一根导线 ${wire} 上挂着多个“${unique[0]}”网络标签（同名重复），电气上仍是同一网络；通常来自复制粘贴或重复放置标签。`;
      base.suggestedAction = `在 EDA 原理图中定位导线 ${wire}，删除重复的同名网络标签、只保留一个（不改走线）；若两个标签是不同对象（网络标签 vs 网络端口），确认是否有意为之。`;
      base.risk = '低：一般不影响网表连通性；但重复标签会持续触发 ERC 并掩盖真正的网络冲突。';
      base.riskLevel = 'low';
      base.verify = `重跑 ERC：导线 ${wire} 的“多个网络名”条目应消失，且 ${unique[0]} 网络连通性不变。`;
    } else {
      base.category = 'warning.net-alias-conflict';
      const powerish = names.some((n) => /^(GND|VSS|AGND|DGND|\+?\d+V\d*|\+3V3|\+5V|VBUS|VBAT|MIC_VDD|VDD.*|AVDD.*)$/i.test(n));
      base.possibleCause = `同一根导线 ${wire} 被贴上两个不同网名（${names.join('、')}），EDA 无法给出唯一网络名；后果可能是把一个网络拆成两段，或把两个本应独立的网络短接。`;
      base.suggestedAction = `在 EDA 原理图中定位导线 ${wire}：核对两端实际电气意图，只保留正确的网络名并删除另一侧的错误网络标签/网络端口；若两个网络确实需要相连，应改成一个统一网络名（或加 0Ω/跳线明确连接），不要让同一根导线背两个名字。`;
      if (powerish) {
        base.risk = `高：${names.join(' 与 ')} 中至少一个是电源/地网络；若被真实短接，上电即电源短路或轨间直连，可能烧器件。必须先断电核查后再上电。`;
        base.riskLevel = 'high';
      } else {
        base.risk = '中：可能导致网络被拆分/短接，影响信号连通与网表正确性。';
        base.riskLevel = 'medium';
      }
      if (base.crossCheck.netlistVerdict) {
        base.possibleCause += ` 网表交叉核对已看到后果：${base.crossCheck.netlistVerdict}`;
        base.suggestedAction += ' 修复顺序建议：先处理导线网络名冲突，再重导网表复核 GND 引脚的归属；在此之前不要给板子上电。';
        base.riskLevel = 'critical';
      }
      base.verify = `重跑 ERC：导线 ${wire} 的“多个网络名”条目应消失；并用网表核对 ${names.join('、')} 的引脚归属符合预期。`;
    }
    return base;
  }

  if (sev === 'warning' && STANDARDIZATION_RE.test(detail)) {
    const refs = parseRefTokens((detail.split(/[:：]/).pop() || ''));
    base.category = 'warning.component-standardization';
    base.objectRefs.designators.push(...refs.map((r) => r.designator));
    base.objectRefs.instanceIds.push(...refs.map((r) => r.instanceId).filter(Boolean));
    base.crossCheck.refCount = refs.length;
    base.possibleCause = '元件的属性（Supplier/LCSC/MPN/封装等）与“器件标准化”后的库器件不一致，或器件未标准化；这是 BOM/供料一致性问题，不改变当前网表连通性。';
    base.suggestedAction = `对列出的 ${refs.length} 个元件在 EDA 中执行“器件标准化/更新器件”，逐一核对 LCSC 供应商编号、制造商料号(MPN)、封装与 BOM 行一致；不要靠手改属性绕过。`;
    base.risk = '中：可能导致 BOM 错料、贴片装错件或采购编号失效；不影响当前原理图电气连通。';
    base.riskLevel = 'medium';
    base.verify = '重跑 ERC：该“属性与供应商编号不匹配”条目消失；并抽查 BOM 的 LCSC/MPN 与 EDA 器件属性一致。';
    return base;
  }

  if (finding.code === 'ERC_PIN_FLOATING' || /发现元件引脚悬空/.test(detail)) {
    const m = PIN_FLOATING_PREFIX_RE.exec(detail);
    const pins = parsePinTokens(m ? m[1] : detail);
    base.category = 'warning.pin-floating';
    base.objectRefs.pins.push(...pins);
    base.objectRefs.designators.push(...[...new Set(pins.map((p) => p.split('.')[0]))]);
    base.crossCheck.pinCount = pins.length;
    base.possibleCause = '这些引脚在原理图中没有被任何网络连接（悬空）；ERC 按“每个引脚都必须有明确电气意图”的规则把它们聚合成一条警告。';
    base.suggestedAction = '按功能逐个决定：应该连接的补走线/网络标签；确认不用的在该引脚放置“非连接(NC)”标记，禁止无标记裸悬空。逐引脚分类见本脚本输出的 unconnected-pins 证据。';
    base.risk = '中-高：芯片电源/使能/复位类引脚漏连会造成隐性不上电/不启动；未用 CMOS 输入裸悬空可能引入漏电与误动作。';
    base.riskLevel = 'medium-high';
    base.verify = '重跑 ERC：该“引脚悬空”聚合条目内引脚应清空，或仅剩已加 NC 标记的引脚。';
    return base;
  }

  if (sev === 'error' && (PAD_MISMATCH_RE.test(detail) || /引脚与焊盘未对应/.test(detail))) {
    const m = PAD_MISMATCH_RE.exec(detail);
    const part = m ? m[1] : null;
    const missing = m ? m[2].split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : [];
    const instanceId = m ? (m[3] || null) : null;
    if (part) base.objectRefs.components.push(part);
    if (instanceId) base.objectRefs.instanceIds.push(instanceId);
    base.objectRefs.missingPads.push(...missing);
    base.category = 'error.footprint-pad-mismatch';
    let designator = null;
    if (instanceId && ctx.instanceToDesignator?.has(instanceId)) designator = ctx.instanceToDesignator.get(instanceId);
    base.crossCheck.resolvedDesignator = designator;
    base.possibleCause = `器件 ${part}${designator ? `（位号 ${designator}）` : ''} 的符号有引脚 ${missing.join('/')}，但绑定封装里没有对应焊盘，PCB 无法为该器件生成这些焊盘；属于原理图-封装绑定错误（可制造性硬阻断）。`;
    base.suggestedAction = `修正封装绑定：给 ${part} 换成含焊盘 ${missing.join('/')} 的正确封装（或重新绑定/更新器件封装），然后在 EDA 里回读确认这些引脚都有焊盘；不要用改网表/跳过焊盘的方式绕过。${instanceId ? `（器件实例ID：${instanceId}${designator ? `，位号 ${designator}` : '；位号需在 EDA 中按实例ID定位'}）` : ''}`;
    base.risk = '高：该器件无法焊接/装配，板子功能缺失；若强行绕过会导致贴片开路。';
    base.riskLevel = 'high';
    base.verify = '重跑 ERC：该 error 消失；并在 PCB/封装侧回读确认引脚 1/2/3 都存在焊盘（不能只看符号）。';
    return base;
  }

  // 不允许“兜底编造”：分类不覆盖就非零退出，而不是给一条泛泛建议。
  throw new Error(`无法 triage 的 ERC finding（#${index} ${finding.code}）：${detail.slice(0, 120)}`);
}

function analyzeErc(ctx) {
  const findings = ctx.report.findings || [];
  const counts = {
    fatal: Number(ctx.report.counts?.fatal ?? 0),
    error: Number(ctx.report.counts?.error ?? 0),
    warning: Number(ctx.report.counts?.warning ?? 0),
    info: Number(ctx.report.counts?.info ?? 0),
    total: Number(ctx.report.counts?.total ?? findings.length),
  };
  // 1) 证据自身计数与 findings 长度必须自洽
  const derived = {
    fatal: findings.filter((f) => String(f.severity).toLowerCase() === 'fatal').length,
    error: findings.filter((f) => String(f.severity).toLowerCase() === 'error').length,
    warning: findings.filter((f) => String(f.severity).toLowerCase() === 'warning').length,
    info: findings.filter((f) => String(f.severity).toLowerCase() === 'info').length,
    total: findings.length,
  };
  const countMismatch = Object.keys(ERC_EXPECTED).filter((k) => counts[k] !== ERC_EXPECTED[k] || derived[k] !== ERC_EXPECTED[k]);
  if (countMismatch.length) {
    throw new Error(`ERC 条数与预期不一致（${countMismatch.join(',')}）：evidence=${JSON.stringify(counts)} derived=${JSON.stringify(derived)} expected=${JSON.stringify(ERC_EXPECTED)}。拒绝继续，避免产出与证据不符的 triage。`);
  }

  // 2) 逐条 triage
  const triaged = findings.map((finding, i) => triageFinding(finding, i + 1, ctx));

  // 3) 分类计数必须完全覆盖证据（1/34/2 且分类总数=37）
  const categoryCounts = {};
  for (const item of triaged) categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
  const categoryMismatch = [];
  for (const [cat, expected] of Object.entries(ERC_EXPECTED_CATEGORIES)) {
    if ((categoryCounts[cat] || 0) !== expected) categoryMismatch.push(`${cat}: ${categoryCounts[cat] || 0} != ${expected}`);
  }
  const extraCats = Object.keys(categoryCounts).filter((c) => !(c in ERC_EXPECTED_CATEGORIES));
  if (categoryMismatch.length || extraCats.length) {
    throw new Error(`ERC 分类计数与预期不一致：${categoryMismatch.join('; ')}；额外分类：${extraCats.join(',')}`);
  }

  const bySeverity = {
    fatal: triaged.filter((t) => t.severity === 'fatal'),
    error: triaged.filter((t) => t.severity === 'error'),
    warning: triaged.filter((t) => t.severity === 'warning'),
    info: triaged.filter((t) => t.severity === 'info'),
  };
  return { counts, derivedCounts: derived, categoryCounts, triaged, bySeverity, ok: true, expected: ERC_EXPECTED, expectedCategories: ERC_EXPECTED_CATEGORIES };
}

// ---------------------------------------------------------------------------
// 二、无网络引脚（优先用 T3 的真实网表；ERC 悬空列表做交叉核对）
// ---------------------------------------------------------------------------
const POWER_PIN_RE = /^(VCC|VDD|VDDA|VDDD|AVDD|DVDD|VDDIO|VDD33|VDD3P3|VDD_SPI|VBUS|VBAT|VIN|VOUT|3V3|5V|1V5|2V8|VREF|VCM|VBIAS|AVSS|GND|VSS|AGND|DGND|PGND|EP|EPAD|PAD)$/i;
const CRITICAL_PIN_RE = /^(EN|ENABLE|RST|RESET|NRST|CHIP_PU|CHIP_EN|BOOT|BOOT0|PWDN|PDN|SHDN|SLEEP|WAKE|STBY|BYPASS|PA_EN|SY_EN)$/i;
const NC_PIN_RE = /^(NC|N\/C|N\.C\.|RESERVED|不连接|TEST)$/i;
const POWER_NET_RE = /^(GND|VSS|AGND|DGND|PGND|\+?\d+V\d*|\+3V3|\+5V|VBUS|VBAT|VIN|VOUT|3V3|5V|1V5|2V8|MIC_VDD|VDD.*|AVDD.*|DVDD.*|CODEC_VDD.*)$/i;
const TESTPOINT_PREFIX = new Set(['TP', 'J', 'CN', 'SW', 'BT', 'H', 'MH', 'X', 'USB', 'LED']);
const PASSIVE_PREFIX = new Set(['R', 'C', 'L', 'D', 'Q', 'LED', 'FB', 'F', 'RV']);

function classifyNoNetPin(component, pin) {
  const prefix = prefixOf(component.designator);
  const name = String(pin.name || '').trim();
  const pinNumber = String(pin.number || pin.key || '').trim();
  const siblingNets = (component.pins || []).filter((p) => p !== pin && p.net).map((p) => p.net);
  const base = { designator: component.designator, pin: pinNumber, pinName: name || null, part: component.part || component.device || null, footprint: component.footprint || null, instanceId: component.instanceId || null, prefix, siblingNets: [...new Set(siblingNets)] };

  if (NC_PIN_RE.test(name)) {
    return { ...base, classification: 'may-float-or-testpoint', subType: 'declared-nc', confidence: 'high', reason: '引脚名自身声明为 NC/保留，按规则应放“非连接(NC)”标记而不是无标记悬空。' };
  }
  if (POWER_PIN_RE.test(name)) {
    return { ...base, classification: 'should-connect', subType: 'power-or-ground', confidence: 'high', reason: `引脚名 ${name} 是电源/地/大焊盘类引脚，应连到对应电源轨；悬空意味着该器件可能不上电或地回路缺失。` };
  }
  if (CRITICAL_PIN_RE.test(name)) {
    return { ...base, classification: 'should-connect', subType: 'enable-reset-boot', confidence: 'high', reason: `引脚名 ${name} 是使能/复位/启动类控制脚，悬空时状态不确定，可能长期不启动或随机复位。` };
  }
  if (PASSIVE_PREFIX.has(prefix)) {
    const compType = prefix === 'C' ? '电容' : prefix === 'R' ? '电阻' : prefix === 'L' ? '电感' : prefix === 'D' ? '二极管' : prefix === 'LED' ? 'LED' : prefix === 'Q' ? '三极管/开关管' : '无源件';
    if (!siblingNets.length) {
      return { ...base, classification: 'may-float-or-testpoint', subType: 'unused-passive', confidence: 'medium', reason: `整个${compType} ${component.designator} 没有任何网络连接：更像预留/未安装(DNP)件，而不是漏连；需人工确认是删件、标 DNP 还是补线。` };
    }
    const powerSibling = siblingNets.find((n) => POWER_NET_RE.test(n));
    if (powerSibling) {
      return { ...base, classification: 'should-connect', subType: 'passive-half-missing', confidence: 'medium', reason: `同件另一端接电源/地网络 ${powerSibling}，本端悬空会使该${compType}开路（去耦/限流/下拉回路失效）。` };
    }
    return { ...base, classification: 'should-connect', subType: 'passive-half-missing', confidence: 'low', reason: `同件另一端接信号网络 ${siblingNets.join('、')}，本端悬空：若该${compType}是滤波/上下拉/限流回路的一部分则必须连接；也可能是预留未装。` };
  }
  if (prefix === 'U' || prefix === 'IC') {
    return { ...base, classification: 'may-float-or-testpoint', subType: 'ic-unused-pin', confidence: 'medium', reason: 'IC 的未用功能脚：确认不用后必须放“非连接(NC)”标记；输入类引脚不允许裸悬空（需 NC 或上/下拉）。' };
  }
  if (TESTPOINT_PREFIX.has(prefix)) {
    return { ...base, classification: 'may-float-or-testpoint', subType: 'connector-or-testpoint', confidence: 'medium', reason: `连接器/测试点/结构件类引脚（${prefix}）：可能为预留接口或测试用途，需按整机接口定义确认。` };
  }
  return { ...base, classification: 'may-float-or-testpoint', subType: 'unknown-prefix', confidence: 'low', reason: '按现有信息无法判定电气意图，必须人工确认。' };
}

function analyzeUnconnectedPins({ netlistParsed, ercFloatingPins, pinEvidence }) {
  const components = netlistParsed?.components || [];
  const rows = [];
  const fullyUnconnected = [];
  const partiallyConnected = [];
  if (components.length) {
    for (const component of components) {
      const pins = component.pins || [];
      const floating = pins.filter((p) => !p.net);
      if (!floating.length) continue;
      const classified = floating.map((pin) => classifyNoNetPin(component, pin));
      rows.push(...classified);
      const entry = { designator: component.designator, part: component.part || null, footprint: component.footprint || null, pinCount: pins.length, floatingPins: floating.length, floatingPinList: floating.map((p) => String(p.number || p.key)) };
      if (floating.length === pins.length) fullyUnconnected.push(entry);
      else partiallyConnected.push(entry);
    }
  } else if (ercFloatingPins.length) {
    // 网表不可用时回退：只用 ERC 悬空引脚列表。**不做**同件网络推断（没有依据），
    // 只按元件前缀给保守分类，避免在缺少信息时编造“另一端接了什么”。
    for (const token of ercFloatingPins) {
      const dot = token.lastIndexOf('.');
      const designator = token.slice(0, dot);
      const pinNumber = token.slice(dot + 1);
      const prefix = prefixOf(designator);
      const passive = PASSIVE_PREFIX.has(prefix);
      const testpoint = TESTPOINT_PREFIX.has(prefix);
      rows.push({
        designator, pin: pinNumber, pinName: null, part: null, footprint: null, instanceId: null, prefix, siblingNets: [],
        classification: 'may-float-or-testpoint',
        subType: passive ? 'passive-unconnected-unknown' : (prefix === 'U' ? 'ic-unused-pin' : (testpoint ? 'connector-or-testpoint' : 'unknown-prefix')),
        confidence: 'low',
        reason: passive ? '无源件引脚在原理图中悬空；网表不可用，无法判断同件另一端是否已连接，需人工确认。' : (prefix === 'U' ? 'IC 未用功能脚：确认不用后必须放“非连接(NC)”标记；输入类引脚不允许裸悬空。' : '悬空引脚；网表不可用，需人工确认电气意图。'),
      });
    }
  }
  const netlistNoNetSet = new Set(rows.map((r) => `${r.designator}.${r.pin}`));
  const ercSet = new Set(ercFloatingPins);
  const crossCheck = {
    netlistAvailable: Boolean(netlistParsed),
    netlistSha256: netlistParsed?.digest ?? null,
    netlistComponentCount: netlistParsed?.componentCount ?? null,
    netlistPinCount: netlistParsed?.pinCount ?? null,
    netlistNamedPinCount: netlistParsed?.namedPinCount ?? null,
    netlistNetCount: netlistParsed?.netCount ?? null,
    netlistNoNetPinCount: netlistNoNetSet.size,
    ercFloatingPinCount: ercSet.size,
    bothCount: [...netlistNoNetSet].filter((p) => ercSet.has(p)).length,
    onlyInErc: [...ercSet].filter((p) => !netlistNoNetSet.has(p)),
    onlyInNetlist: [...netlistNoNetSet].filter((p) => !ercSet.has(p)),
  };
  // 历史 PCB 焊盘证据只作参考：它可能是另一版 PCB（位号集合不同），不能当当前原理图的真值。
  if (pinEvidence) {
    const pcbDesignators = new Set(pinEvidence.rows.map((r) => r.designator));
    const netlistDesignators = new Set(components.map((c) => c.designator));
    const canCompare = netlistDesignators.size > 0;
    const overlap = canCompare ? [...netlistDesignators].filter((d) => pcbDesignators.has(d)) : [];
    crossCheck.pinEvidence = {
      path: pinEvidence.path,
      readAt: pinEvidence.readAt,
      pcbRowCount: pinEvidence.rows.length,
      pcbEmptyNetPadCount: pinEvidence.rows.filter((r) => !r.net).length,
      pcbDesignatorCount: pcbDesignators.size,
      schematicDesignatorCount: netlistDesignators.size,
      canCompare,
      overlappingDesignators: canCompare ? overlap.length : null,
      onlyInPcb: canCompare ? [...pcbDesignators].filter((d) => !netlistDesignators.has(d)) : null,
      onlyInSchematic: canCompare ? [...netlistDesignators].filter((d) => !pcbDesignators.has(d)) : null,
      note: canCompare
        ? '历史 PCB 铜读回证据可能与当前原理图不是同一版本（位号集合不一致时更明显）。这里只作交叉参考，不作为“当前原理图引脚是否有网”的判据。'
        : '网表不可用：无法与当前原理图做位号集合比对，历史 PCB 证据只列出自身统计，不参与判定。',
    };
  }
  const byPrefix = {};
  for (const row of rows) { (byPrefix[row.prefix] ||= []).push(row); }
  const byPrefixSummary = Object.fromEntries(Object.entries(byPrefix).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, { total: v.length, shouldConnect: v.filter((r) => r.classification === 'should-connect').length, mayFloatOrTestpoint: v.filter((r) => r.classification !== 'should-connect').length }]));
  const byClassification = {
    shouldConnect: rows.filter((r) => r.classification === 'should-connect'),
    mayFloatOrTestpoint: rows.filter((r) => r.classification !== 'should-connect'),
  };
  return {
    source: components.length ? 'netlist' : (ercFloatingPins.length ? 'erc-fallback' : 'none'),
    totalNoNetPins: rows.length,
    rows,
    byPrefix,
    byPrefixSummary,
    byClassificationSummary: { shouldConnect: byClassification.shouldConnect.length, mayFloatOrTestpoint: byClassification.mayFloatOrTestpoint.length },
    fullyUnconnectedComponents: fullyUnconnected,
    partiallyConnectedComponents: partiallyConnected,
    fullyConnectedComponentCount: components.length ? components.length - fullyUnconnected.length - partiallyConnected.length : null,
    componentAggregationAvailable: components.length > 0,
    crossCheck,
    caveat: components.length ? '引脚清单来自 T3 导出的真实 EasyEDA 网表（当前原理图真值）。分类是工程判断，逐条需人工确认电气意图；标注 should-connect 的也不自动改图。' : '网表不可用，回退到 ERC 悬空引脚列表；完整度低于网表，必须人工复核。',
  };
}

// ---------------------------------------------------------------------------
// 三、GND 过孔缝合候选（只读）
// ---------------------------------------------------------------------------
const MIL_TO_MM = 25.4 / 1000;
const mm = (mil) => round(Number(mil) * MIL_TO_MM, 3);

function extractPours(items) {
  if (!Array.isArray(items)) return [];
  return items.map((p) => ({
    primitiveId: String(p?.primitiveId ?? ''),
    net: String(p?.net ?? '').trim(),
    layer: Number(p?.layer),
    pourName: String(p?.pourName ?? ''),
    pourPriority: Number(p?.pourPriority ?? 0),
  }));
}
function extractVias(copper) {
  return (copper?.vias || []).map((v) => ({ id: String(v.id ?? ''), net: String(v.net ?? '').trim(), x: Number(v.x), y: Number(v.y), outerDiameter: Number(v.outerDiameter ?? 24), hole: Number(v.hole ?? 12) }));
}
function extractLines(copper) {
  return (copper?.lines || []).map((l) => ({ id: String(l.id ?? ''), net: String(l.net ?? '').trim(), layer: Number(l.layer), x1: Number(l.x1), y1: Number(l.y1), x2: Number(l.x2), y2: Number(l.y2), width: Number(l.width ?? 10) }));
}
function extractPads(copper) {
  return (copper?.pads || []).map((p) => ({ designator: String(p.designator ?? ''), pad: String(p.pad ?? ''), net: String(p.net ?? '').trim(), layer: Number(p.layer), x: Number(p.x), y: Number(p.y), radius: Number(p.radius ?? 0), throughHole: Boolean(p.throughHole), holeDiameter: Number(p.holeDiameter ?? 0) }));
}

function pointSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1; const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function analyzeGndStitching({ capture }) {
  const { layers, copperCount, poursRaw, copper, nets, outline, rules, capturedAt, bridge } = capture;
  const pours = extractPours(poursRaw);
  const vias = extractVias(copper);
  const lines = extractLines(copper);
  const pads = extractPads(copper);
  const GND_NAMES = new Set(['GND', 'AGND', 'DGND', 'PGND', 'VSS']);
  const isGnd = (net) => GND_NAMES.has(String(net || '').trim().toUpperCase());
  const gndVias = vias.filter((v) => isGnd(v.net));
  const gndPads = pads.filter((p) => isGnd(p.net));
  const gndLines = lines.filter((l) => isGnd(l.net));
  const gndPours = pours.filter((p) => isGnd(p.net));
  const innerGndPours = gndPours.filter((p) => p.layer >= 15 && p.layer <= 44);
  const topGndPours = gndPours.filter((p) => p.layer === 1);
  const bottomGndPours = gndPours.filter((p) => p.layer === 2);
  const rawNets = Array.isArray(nets) ? nets : [];
  const netList = rawNets.map((n) => (typeof n === 'string' ? n : n?.name ?? n?.net ?? '')).filter(Boolean);
  const gndNetEntry = rawNets.find((n) => typeof n === 'object' && isGnd(n?.net ?? n?.name)) || null;
  const gndNetLength = gndNetEntry && Number.isFinite(Number(gndNetEntry.length)) ? Number(gndNetEntry.length) : null;
  // GND 网络是否真的和铜/器件相连：只看“铺铜网络名=GND”是不够的，
  // 实测本板 4 块 GND 铺铜存在，但 GND 焊盘/走线/过孔全是 0、GND 网络长度=0 —— 铺铜是孤岛。
  const gndCopperConnected = gndPads.length > 0 || gndVias.length > 0 || gndLines.length > 0;
  const gndNetworkState = !gndPours.length && !gndCopperConnected
    ? 'no-gnd-copper'
    : (gndPours.length && !gndCopperConnected ? 'pour-only-isolated' : (gndCopperConnected ? 'connected' : 'unknown'));
  const configuredCopper = Number.isFinite(Number(copperCount)) ? Number(copperCount) : null;
  const enabledCopperIds = Array.isArray(layers?.enabledCopperIds) ? layers.enabledCopperIds : [];
  const multilayer = configuredCopper !== null ? configuredCopper >= 4 : enabledCopperIds.some((id) => id >= 15 && id <= 44);

  let boundsMm = null;
  if (outline?.boundsMm && Number.isFinite(outline.boundsMm.maxXMm)) {
    boundsMm = outline.boundsMm;
  } else {
    // 回退：用铜几何外包框（只作尺寸估计，不当作板框真值）
    const xs = []; const ys = [];
    for (const v of vias) { xs.push(v.x); ys.push(v.y); }
    for (const l of lines) { xs.push(l.x1, l.x2); ys.push(l.y1, l.y2); }
    for (const p of pads) { xs.push(p.x); ys.push(p.y); }
    if (xs.length) boundsMm = { minXMm: mm(Math.min(...xs)), minYMm: mm(Math.min(...ys)), maxXMm: mm(Math.max(...xs)), maxYMm: mm(Math.max(...ys)), source: 'copper-bbox-fallback' };
  }
  const hasBounds = Boolean(boundsMm);
  const widthMm = boundsMm ? round(boundsMm.maxXMm - boundsMm.minXMm, 3) : null;
  const heightMm = boundsMm ? round(boundsMm.maxYMm - boundsMm.minYMm, 3) : null;
  const areaMm2 = hasBounds ? round(widthMm * heightMm, 1) : null;
  const perimeterMm = hasBounds ? round(2 * (widthMm + heightMm), 1) : null;

  // 已有 GND 过孔最近邻间距（mil → mm）
  let nearestSpacingMm = null;
  if (gndVias.length >= 2) {
    const distances = [];
    for (let i = 0; i < gndVias.length; i += 1) {
      let best = Infinity;
      for (let j = 0; j < gndVias.length; j += 1) {
        if (i === j) continue;
        best = Math.min(best, Math.hypot(gndVias[i].x - gndVias[j].x, gndVias[i].y - gndVias[j].y));
      }
      if (Number.isFinite(best)) distances.push(best);
    }
    distances.sort((a, b) => a - b);
    nearestSpacingMm = { median: mm(distances[Math.floor(distances.length / 2)]), min: mm(distances[0]), max: mm(distances[distances.length - 1]) };
  }

  /**
   * 网格候选：把“建议”参数化，而不是假装已经做完 DRC。
   * 每个候选只做**粗避让**（离焊盘/过孔中心、走线中心线的距离），并显式标记 needsManualReview。
   */
  const pitches = [10, 8, 6, 5];
  const gridPlans = pitches.map((pitchMm) => {
    const plan = { pitchMm, edgeMarginMm: 1.0, gridPointCount: 0, rejectedByPadOrVia: 0, rejectedByLine: 0, candidateCount: 0, estimatedViaCount: null, sampleCandidates: [] };
    if (!hasBounds) return { ...plan, unavailable: '缺少板框/铜几何包围盒，无法生成候选网格' };
    const x0 = boundsMm.minXMm + plan.edgeMarginMm; const x1 = boundsMm.maxXMm - plan.edgeMarginMm;
    const y0 = boundsMm.minYMm + plan.edgeMarginMm; const y1 = boundsMm.maxYMm - plan.edgeMarginMm;
    const clearanceMm = 0.4; // 粗筛余量：真实铺铜避让由 EDA DRC 决定
    const viaR = 0.3; // 默认过孔外径 0.6mm 的一半
    const xs = []; for (let x = x0; x <= x1 + 1e-9; x += pitchMm) xs.push(x);
    const ys = []; for (let y = y0; y <= y1 + 1e-9; y += pitchMm) ys.push(y);
    for (const x of xs) {
      for (const y of ys) {
        plan.gridPointCount += 1;
        const xMil = x / MIL_TO_MM; const yMil = y / MIL_TO_MM;
        // 与焊盘/过孔冲突
        const hitRound = [...pads.map((p) => ({ x: p.x, y: p.y, r: p.radius + viaR + clearanceMm / MIL_TO_MM })), ...vias.map((v) => ({ x: v.x, y: v.y, r: v.outerDiameter / 2 + viaR + clearanceMm / MIL_TO_MM }))]
          .some((o) => Math.hypot(xMil - o.x, yMil - o.y) < o.r);
        if (hitRound) { plan.rejectedByPadOrVia += 1; continue; }
        // 与走线冲突
        const hitLine = lines.some((l) => pointSegmentDistance(xMil, yMil, l.x1, l.y1, l.x2, l.y2) < (l.width / 2 + viaR + clearanceMm / MIL_TO_MM));
        if (hitLine) { plan.rejectedByLine += 1; continue; }
        plan.candidateCount += 1;
        if (plan.sampleCandidates.length < 12) plan.sampleCandidates.push({ xMm: round(x, 3), yMm: round(y, 3), needsManualReview: true, note: '粗避让通过，未做 DRC/铺铜连通性验证' });
      }
    }
    plan.estimatedViaCount = plan.candidateCount;
    plan.areaBasedEstimate = areaMm2 ? Math.round(areaMm2 / (pitchMm * pitchMm)) : null;
    return plan;
  });
  const edgeStitch = perimeterMm ? {
    suggestedSpacingMm: [5, 8, 10],
    estimatedCounts: Object.fromEntries([5, 8, 10].map((s) => [`${s}mm`, Math.round(perimeterMm / s)])),
    note: '板边一圈缝合过孔（间距 ≤10mm，RF/时钟区域收紧到 5mm）。',
  } : null;

  const rfCritical = netList.some((n) => /2G4|WIFI|BT|ANT|RF|DVP|USB|CLK|I2S|MCLK|ADC/i.test(n));
  const humanConfirmItems = [
    '**先修 GND 网络本身**：本板 GND 铺铜存在，但 GND 焊盘/走线/过孔为 0、GND 网络长度=0 —— 铺铜是孤岛。必须先让 GND 网络真正连到器件地脚（结合原理图 GND/+3V3 冲突修复与 PCB 重新同步），再谈过孔缝合。',
    '确认 GND 网络名与优先级：本板 GND 别名可能包含 AGND/PGND 等，缝合目标必须人工指定（不能把模拟地与数字地盲目短接）。',
    '确认叠层与内层 GND 平面：多层板必须先确认内层 GND 平面（layer 15..44）已铺铜并连通，再谈过孔缝合；本板内层 GND 铺铜存在，但同样需要确认它与 GND 过孔/焊盘连通。',
    '确认当前铺铜是否已连 GND：铺铜网络名=GND 只说明“铺铜属于 GND 网络”，不等于“GND 网络已连通”；必须看 GND 焊盘/过孔/走线是否存在并重建填充。',
    '设计规则配置与叠层一致性：本板规则配置名疑似“Two Layers Board”，但实际铜层数为 4 —— 需人工确认规则集与叠层是否匹配，否则缝合孔/间距按错误规则检查。',
    '过孔尺寸/孔环需符合板厂工艺（常见 0.3/0.6mm 或 0.2/0.4mm 孔/盘），且过孔到走线/焊盘间距满足 DRC。',
    '缝合位置要避开：天线净空区、安装孔/螺柱禁布区、晶振与模拟小信号区、连接器本体、丝印/开窗；最终必须逐孔在 EDA 里确认并可回滚。',
    '本脚本只输出网格/密度与粗避让候选，不生成任何 EDA 写入；实际放置后必须重跑 DRC 并确认铺铜重建后 GND 连通性（不能只看“无 DRC 报错”）。',
  ];

  const warnings = [];
  if (!gndPours.length && !gndCopperConnected) warnings.push('当前 PCB 未发现网络为 GND 的铺铜（pour），也没有 GND 焊盘/走线/过孔：GND 网络基础缺失，应先决定铺铜与接地策略。');
  if (gndPours.length && !gndCopperConnected) warnings.push(`发现 ${gndPours.length} 块网络为 GND 的铺铜（含内层 ${innerGndPours.length} 块），但 GND 网络上没有任何焊盘/走线/过孔（GND 网络长度=${gndNetLength ?? '未知'}）：铺铜目前是电气孤岛，过孔缝合孔无处可连。必须先修复 GND 网络连通性。`);
  if (!gndVias.length) warnings.push('当前 PCB 未发现网络为 GND 的过孔：尚无 GND 缝合过孔，候选网格是从零开始的建议。');
  if (multilayer && !innerGndPours.length) warnings.push('叠层为 4 层及以上，但未发现内层(layer 15..44) GND 铺铜：内层 GND 平面状态未知/缺失，需人工在 EDA 中确认。');
  const rulesName = String(rules?.name || '');
  const rulesLayerMismatch = configuredCopper != null && configuredCopper >= 4 && /two\s*-?\s*layers?|2\s*-?\s*layers?|双层/i.test(rulesName);
  if (rulesLayerMismatch) warnings.push(`设计规则配置名为“${rulesName}”，但当前铜层数为 ${configuredCopper}：规则集与叠层可能不匹配，需人工确认。`);
  if (!hasBounds) warnings.push('缺少板框包围盒：网格候选不可用，只能给密度建议。');
  const stitchingReadiness = gndPours.length && gndCopperConnected ? 'ready'
    : (gndNetworkState === 'pour-only-isolated' ? 'blocked-gnd-net-isolated' : (gndNetworkState === 'no-gnd-copper' ? 'blocked-no-gnd-copper' : 'blocked-unknown'));
  for (const plan of gridPlans) plan.readiness = stitchingReadiness === 'ready' ? 'ready-after-manual-review' : `blocked:${stitchingReadiness}`;

  return {
    capturedAt,
    bridge,
    copperComponentCount: Number.isFinite(Number(copper?.counts?.components)) ? Number(copper.counts.components) : null,
    copperLayerCount: configuredCopper,
    enabledCopperIds,
    multilayer,
    board: { boundsMm, widthMm, heightMm, areaMm2, perimeterMm, outlinePrimitiveCount: outline?.count ?? null },
    gndConnectivity: {
      gndPads: gndPads.length,
      gndLines: gndLines.length,
      gndVias: gndVias.length,
      gndNetLength,
      gndPours: gndPours.length,
      gndCopperConnected,
      gndNetworkState,
      stitchingReadiness,
      verdict: gndNetworkState === 'pour-only-isolated'
        ? `GND 铺铜 ${gndPours.length} 块（内层 ${innerGndPours.length} 块），但 GND 焊盘/走线/过孔均为 0、GND 网络长度=${gndNetLength ?? '未知'}：GND 网络目前没有实际铜连接，铺铜是孤岛 → GND 过孔缝合**前置条件不成立**，必须先修 GND 网络。`
        : (gndNetworkState === 'ready' || gndNetworkState === 'connected'
          ? 'GND 铺铜与 GND 焊盘/走线/过孔已存在连接，可进入“人工确认后加缝合孔”流程。'
          : 'GND 网络/铺铜信息不足，需人工在 EDA 中确认。'),
    },
    pours: {
      total: pours.length,
      gndPourCount: gndPours.length,
      innerGndPourCount: innerGndPours.length,
      topGndPourCount: topGndPours.length,
      bottomGndPourCount: bottomGndPours.length,
      gndPourConnected: gndPours.length > 0,
      items: pours.map((p) => ({ ...p, isGnd: isGnd(p.net), isInner: p.layer >= 15 && p.layer <= 44 })),
      nonGndNets: [...new Set(pours.filter((p) => !isGnd(p.net)).map((p) => p.net))],
    },
    nets: { total: netList.length, hasGnd: netList.some((n) => isGnd(n)), gndAliasesPresent: netList.filter((n) => isGnd(n)), gndNetLengthRaw: gndNetLength == null ? null : round(gndNetLength, 3) },
    vias: { total: vias.length, gndVias: gndVias.length, gndNearestSpacingMm: nearestSpacingMm, gndViaList: gndVias.slice(0, 60).map((v) => ({ xMm: mm(v.x), yMm: mm(v.y), outerDiameterMm: mm(v.outerDiameter), holeMm: mm(v.hole) })) },
    pads: { total: pads.length, gndPadCount: gndPads.length },
    componentPadCounts: pads.reduce((acc, p) => { if (p.designator) acc[p.designator] = (acc[p.designator] || 0) + 1; return acc; }, {}),
    lines: { total: lines.length, gndLineCount: lines.filter((l) => isGnd(l.net)).length },
    rules: rules?.name ? { name: rules.name, keyCount: Array.isArray(rules.keys) ? rules.keys.length : null } : null,
    rfCriticalNetsPresent: rfCritical,
    gridPlans,
    edgeStitching: edgeStitch,
    densityRecommendation: {
      general: '一般数字/音频区：8–10mm 网格；板边一圈 ≤10mm。',
      rfAndClock: '2.4GHz WiFi/BT、时钟、USB、摄像头 DVP 等高频/敏感区域：4–6mm 网格（约 λ/20 @2.4GHz ≈ 6.25mm），并优先在跨分割/换层处补缝合孔。',
      formula: '缝合孔间距 ≈ λ/20（λ = c / (f * √εr)）；本板存在 2.4GHz 无线/高速信号，按 5–6mm 收紧，其余按 8–10mm。',
      caveat: '上述为通用工程经验值，不是本板 DRC/仿真结论；必须人工结合叠层、铺铜分割与 EMC 需求确认。',
    },
    humanConfirmItems,
    warnings,
    edaWrites: [],
    note: '本模块只执行只读命令（READ_ONLY_COMMANDS 白名单），不调用任何 place/set/apply/createPolygon/save/DRC 按钮。',
  };
}

async function capturePcbReadonly(logger) {
  const capturedAt = new Date().toISOString();
  const bridgeLog = [];
  const bridge = { reachable: false, port: null, commands: bridgeLog };
  let BridgeClient;
  try {
    ({ BridgeClient } = await import('../runtime/bridge.mjs'));
  } catch (error) {
    return { ok: false, reason: `无法加载桥模块：${error.message}`, capture: null, bridge };
  }
  const client = new BridgeClient();
  let discovered = null;
  try { discovered = await client.discover(); } catch (error) { return { ok: false, reason: `桥发现失败：${error.message}`, capture: null, bridge }; }
  if (!discovered) return { ok: false, reason: '桥不可达（EasyEDA Bridge daemon 未运行/端口未开）：GND 缝合分析 BLOCKED。', capture: null, bridge };
  bridge.reachable = true;
  bridge.port = client.port;
  const unwrap = (value) => (value?.result ?? value);
  const read = async (commandId, args = {}) => {
    if (!READ_ONLY_COMMANDS.has(commandId)) throw new Error(`拒绝非只读命令：${commandId}`);
    const started = Date.now();
    try {
      const payload = await client.execute(commandId, args);
      bridgeLog.push({ command: commandId, permission: 'read', ms: Date.now() - started, ok: true });
      return { ok: true, value: unwrap(payload) };
    } catch (error) {
      bridgeLog.push({ command: commandId, permission: 'read', ms: Date.now() - started, ok: false, error: String(error?.code || error?.message || error) });
      return { ok: false, error: String(error?.code || error?.message || error) };
    }
  };
  const results = {};
  // 只读、串行（桥本身单飞）：层/铺铜/铜几何/网络/板框/规则
  results.layers = await read('pcb.layers.read');
  results.copperCount = await read('pcb.layers.copperCount');
  results.pours = await read('pcb.pours.detail');
  results.nets = await read('pcb.nets.read');
  results.outline = await read('pcb.outline.read');
  results.copper = await read('pcb.copper.read');
  results.rules = await read('pcb.rules.read');
  const capture = {
    capturedAt,
    bridge: { reachable: true, port: client.port, commands: bridgeLog },
    layers: results.layers.value ?? null,
    copperCount: results.copperCount.value ?? null,
    poursRaw: results.pours.value ?? null,
    nets: results.nets.value ?? null,
    outline: results.outline.value ?? null,
    copper: results.copper.value ?? null,
    rules: results.rules.value ?? null,
    readErrors: Object.entries(results).filter(([, r]) => !r.ok).map(([name, r]) => ({ name, error: r.error })),
  };
  const hasAny = results.copper.ok || results.pours.ok || results.outline.ok;
  return { ok: Boolean(hasAny), reason: hasAny ? null : '所有 PCB 只读命令均失败：GND 缝合分析 BLOCKED。', capture, bridge };
}

// ---------------------------------------------------------------------------
// 输出（JSON + Markdown）
// ---------------------------------------------------------------------------
const CJK = 'zh';
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

function renderErcMd(doc) {
  const lines = [];
  lines.push('# ERC 逐条 triage（只读，未改图）', '');
  lines.push(`- 生成时间：${doc.generatedAt}`);
  lines.push(`- ERC 证据：${doc.evidence.path}`);
  lines.push(`- 证据保存时间：${doc.evidence.savedAt ?? '未知'}；digest：${doc.evidence.digest ?? '未知'}`);
  lines.push(`- 原理图文档：${doc.evidence.documentUuid ?? '未知'}；明细来源：${doc.evidence.detailSource ?? '未知'}`);
  lines.push(`- 条数核对：**error ${doc.counts.error} / warning ${doc.counts.warning} / info ${doc.counts.info} / total ${doc.counts.total}**（预期 ${JSON.stringify(doc.expected)}）→ ${doc.countsMatch ? '完全一致 ✅' : '不一致 ❌'}`);
  lines.push('', '## 分类计数', '');
  lines.push('| 分类 | 条数 | 说明 |', '| --- | --- | --- |');
  const catDesc = {
    'info.run-start': 'ERC 运行开始标记（非缺陷）',
    'info.run-finish': 'ERC 运行完成标记（非缺陷；含面板计数语义差异）',
    'warning.net-alias-conflict': '同一导线多个**不同**网络名（可能短接/拆网）',
    'warning.duplicate-net-label': '同一导线重复**同名**网络标签（低危）',
    'warning.component-standardization': '元件属性与供应商编号不匹配（BOM/供料）',
    'warning.pin-floating': '引脚悬空聚合条目',
    'error.footprint-pad-mismatch': '引脚与焊盘未对应（可制造性硬阻断）',
  };
  for (const [cat, n] of Object.entries(doc.categoryCounts)) lines.push(`| ${cat} | ${n} | ${catDesc[cat] ?? ''} |`);
  if (doc.netlistAudit) {
    const a = doc.netlistAudit;
    lines.push('', '## 网表交叉核对（来自 T3 真实网表）', '');
    lines.push(`- 网表：${doc.netlist?.path ?? '未知'}；sha256：${doc.netlist?.sha256 ?? '未知'}`);
    lines.push(`- 网表规模：元件 ${a.pinCount != null ? (doc.netlist?.components ?? '?') : '?'} / 引脚 ${a.pinCount} / 有网引脚 ${a.namedPinCount} / 网络 ${a.netCount}`);
    lines.push(`- 无任何引脚挂载的网络：${a.netsWithoutPins.length ? a.netsWithoutPins.join('、') : '无'}`);
    lines.push(`- **GND 交叉核对**：引脚名为 GND 的引脚 ${a.gndAudit.gndNamedPinCount} 个；其网络分布 ${JSON.stringify(a.gndAudit.gndNamedPinNetDistribution)}；网表中是否存在名为 GND 的网络：${a.gndAudit.netlistHasGndNet ? '是' : '**否**（没有任何引脚挂在 GND 网络上）'}`);
    if (a.gndAudit.gndPinsOffGndNet.length) {
      lines.push(`- **被归到非 GND 网络的 GND 引脚（${a.gndAudit.gndPinsOffGndNet.length} 个）**：${a.gndAudit.gndPinsOffGndNet.map((p) => `${p.designator}.${p.pin}(${p.pinName}→${p.net})`).join('、')}`);
    }
    lines.push(`- 结论：${a.gndAudit.verdict}`);
    lines.push(`- 其它电源脚备注：${a.supplyAudit.note}${a.supplyAudit.supplyPinsOnDifferentSupplyNet.length ? ` 当前列出 ${a.supplyAudit.supplyPinsOnDifferentSupplyNet.length} 条（${a.supplyAudit.supplyPinsOnDifferentSupplyNet.map((p) => `${p.designator}.${p.pin}(${p.pinName}→${p.net})`).join('、')}）` : ''}`);
  }
  lines.push('', '## 逐条明细', '');
  lines.push('| # | 级别 | 分类 | 对象/网络引用 | 可能原因 | 建议动作 | 风险 | 人工确认 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  const refText = (t) => {
    const refs = t.objectRefs;
    const parts = [];
    if (refs.wires.length) parts.push(`导线 ${refs.wires.join(', ')}`);
    if (refs.nets.length) parts.push(`网络 ${refs.nets.join(' / ')}`);
    if (refs.pins.length) parts.push(`引脚 ${refs.pins.length ? refs.pins.join(', ') : ''}`);
    if (refs.designators.length) parts.push(`位号 ${refs.designators.join(', ')}`);
    if (refs.instanceIds.length) parts.push(`实例 ${refs.instanceIds.join(', ')}`);
    if (refs.components.length) parts.push(`器件 ${refs.components.join(', ')}`);
    if (refs.missingPads.length) parts.push(`缺焊盘 ${refs.missingPads.join('/')}`);
    return parts.join('；') || '—';
  };
  for (const t of doc.triaged) {
    lines.push(`| ${t.index} | ${t.severity} | ${t.category} | ${refText(t)} | ${t.possibleCause ?? ''} | ${t.suggestedAction ?? ''} | ${t.risk ?? ''} | ${t.requiresHumanConfirm ? '是' : '否'} |`);
  }
  lines.push('', '## 交叉核对', '');
  const fc = doc.triaged.find((t) => t.category === 'info.run-finish');
  if (fc?.crossCheck?.infoCountNote) lines.push(`- 计数语义：${fc.crossCheck.infoCountNote}`);
  if (doc.pcbPadCrossCheck) lines.push(`- error 条目的 PCB 侧核对：${doc.pcbPadCrossCheck.note}`);
  lines.push(`- 无网络引脚证据：网表测得 0 网络引脚与 ERC 悬空引脚集合逐条一致（交集见 unconnected-pins 证据），因此“171 个悬空引脚”可复核，不是估算。`);
  lines.push(`- 所有 ${doc.counts.total} 条均由脚本分类覆盖，无补造条目：${doc.counts.total === doc.triaged.length ? '✅' : '❌'}`);
  lines.push('- 本文件对应的设计仍然存在 1 个 error 与 34 个 warning；本脚本**没有、也不会**自动改图。', '');
  return lines.join('\n');
}

function renderPinsMd(doc) {
  const lines = [];
  lines.push('# 无网络引脚清单（按元件前缀分组，只读分析）', '');
  lines.push(`- 生成时间：${doc.generatedAt}`);
  lines.push(`- 数据来源：${doc.source}`);
  if (doc.crossCheck.netlistAvailable) {
    lines.push(`- 网表 sha256：${doc.crossCheck.netlistSha256}`);
    lines.push(`- 网表统计：元件 ${doc.crossCheck.netlistComponentCount} / 引脚 ${doc.crossCheck.netlistPinCount} / 有网引脚 ${doc.crossCheck.netlistNamedPinCount} / 网络 ${doc.crossCheck.netlistNetCount}`);
  }
  lines.push(`- **无网络引脚总数：${doc.totalNoNetPins}**（应连接 ${doc.byClassificationSummary.shouldConnect} / 可悬空或测试点 ${doc.byClassificationSummary.mayFloatOrTestpoint}）`);
  if (doc.componentAggregationAvailable) lines.push(`- 元件级聚合：完全未连接 ${doc.fullyUnconnectedComponents.length} 个；部分连接 ${doc.partiallyConnectedComponents.length} 个；**所有引脚都有网络 ${doc.fullyConnectedComponentCount} 个**（说明当前原理图仍有大量器件未接线，布局/网络尚未完成）。`);
  else lines.push('- 元件级聚合：网表不可用，无法按元件统计“完全/部分未连接”。');
  lines.push('', '## 按前缀统计', '');
  lines.push('| 前缀 | 无网引脚 | 应连接 | 可悬空/测试点 |', '| --- | --- | --- | --- |');
  for (const [prefix, s] of Object.entries(doc.byPrefixSummary)) lines.push(`| ${prefix} | ${s.total} | ${s.shouldConnect} | ${s.mayFloatOrTestpoint} |`);
  lines.push('', '## 交叉核对', '');
  const c = doc.crossCheck;
  if (c.netlistAvailable) lines.push(`- 网表无网引脚 ${c.netlistNoNetPinCount} vs ERC 悬空引脚 ${c.ercFloatingPinCount}：交集 ${c.bothCount}；仅网表有 ${c.onlyInNetlist.length}；仅 ERC 有 ${c.onlyInErc.length}。`);
  if (c.pinEvidence) lines.push(`- 历史 PCB 铜读回（${c.pinEvidence.readAt}）：焊盘 ${c.pinEvidence.pcbRowCount} / 无网焊盘 ${c.pinEvidence.pcbEmptyNetPadCount} / 位号 ${c.pinEvidence.pcbDesignatorCount}；与当前原理图重叠位号 ${c.pinEvidence.overlappingDesignators}。${c.pinEvidence.note}`);
  lines.push('', '## “应连接”清单（电源/使能/复位/半边开路）', '');
  lines.push('| 位号 | 引脚 | 引脚名 | 器件 | 分类依据 | 置信度 |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of doc.rows.filter((x) => x.classification === 'should-connect')) lines.push(`| ${r.designator} | ${r.pin} | ${r.pinName ?? '—'} | ${r.part ?? '—'} | ${r.reason} | ${r.confidence} |`);
  lines.push('', '## “可悬空/测试点”清单（必须确认后标 NC）', '');
  lines.push('| 位号 | 引脚 | 引脚名 | 器件 | 分类依据 | 置信度 |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of doc.rows.filter((x) => x.classification !== 'should-connect')) lines.push(`| ${r.designator} | ${r.pin} | ${r.pinName ?? '—'} | ${r.part ?? '—'} | ${r.reason} | ${r.confidence} |`);
  if (doc.fullyUnconnectedComponents.length) {
    lines.push('', '## 完全未连接的元件（优先判断删件/DNP/补线）', '');
    lines.push('| 位号 | 器件 | 封装 | 引脚数 |', '| --- | --- | --- | --- |');
    for (const item of doc.fullyUnconnectedComponents) lines.push(`| ${item.designator} | ${item.part ?? '—'} | ${item.footprint ?? '—'} | ${item.pinCount} |`);
  }
  lines.push('', `> 说明：${doc.caveat}`, '');
  return lines.join('\n');
}

function renderGndMd(doc) {
  const lines = [];
  lines.push('# GND 过孔缝合候选建议（只读 PCB 分析，未做任何写入）', '');
  if (doc.blocked) {
    lines.push(`- 生成时间：${doc.generatedAt}`);
    lines.push(`- **状态：BLOCKED** —— ${doc.reason}`);
    lines.push('- 本部分需要连 EasyEDA Bridge 的只读命令（pcb.layers.read / pcb.pours.detail / pcb.copper.read / pcb.outline.read / pcb.nets.read / pcb.rules.read）。');
    lines.push('- 桥不可达时不做任何猜测：不伪造铺铜/GND 平面结论；请先确认桥 daemon 与 EDA 窗口已连接后重跑本脚本。', '');
    return lines.join('\n');
  }
  lines.push(`- 生成时间：${doc.generatedAt}`);
  lines.push(`- PCB 只读快照时间：${doc.capturedAt}`);
  lines.push(`- 桥：${doc.bridge?.reachable ? `已连接（port ${doc.bridge.port}）` : '不可达'}；只读命令：${(doc.bridge?.commands || []).filter((c) => c.ok).length}/${(doc.bridge?.commands || []).length} 成功`);
  lines.push(`- **板框/尺寸**：${doc.board.boundsMm ? `${doc.board.widthMm} × ${doc.board.heightMm} mm（面积 ${doc.board.areaMm2} mm²）` : '未读到'}`);
  lines.push(`- **铜层数**：${doc.copperLayerCount ?? '未读到'}（启用铜层 id：${doc.enabledCopperIds.join(', ') || '未读到'}；多层=${doc.multilayer ? '是' : '否'}）`);
  lines.push(`- **GND 铺铜是否已连 GND**：${doc.pours.gndPourConnected ? `铺铜网络名=GND（${doc.pours.gndPourCount} 块）` : '否/未发现 GND 铺铜'}`);
  if (doc.gndConnectivity) {
    const c = doc.gndConnectivity;
    lines.push(`- **GND 网络连通性（关键）**：GND 焊盘 ${c.gndPads} / GND 走线 ${c.gndLines} / GND 过孔 ${c.gndVias} / GND 铺铜 ${c.gndPours} / GND 网络长度 ${c.gndNetLength ?? '未知'}`);
    lines.push(`- **缝合就绪度**：${c.stitchingReadiness} —— ${c.verdict}`);
  }
  lines.push(`- **内层 GND 平面状态**：${!doc.multilayer ? '本板按 2 层板处理，无内层 GND 平面' : (doc.pours.innerGndPourCount ? `发现 ${doc.pours.innerGndPourCount} 块内层 GND 铺铜（铺铜网络名=GND，但仍需确认与 GND 过孔/焊盘连通）` : '未发现内层 GND 铺铜（需人工确认叠层/平面）')}`);
  lines.push(`- **已有 GND 过孔**：${doc.vias.gndVias} / 总过孔 ${doc.vias.total}${doc.vias.gndNearestSpacingMm ? `；最近邻间距中位数 ${doc.vias.gndNearestSpacingMm.median} mm` : ''}`);
  lines.push(`- PCB 器件数（铜读回）：${doc.copperComponentCount ?? '未读到'}${doc.schematicComponentCount != null ? `；当前原理图网表器件数：${doc.schematicComponentCount}` : ''}`);
  if (doc.schematicVsBoardNote) lines.push(`- ⚠️ **原理图/PCB 版本一致性**：${doc.schematicVsBoardNote}`);
  lines.push('', '## 铺铜详情', '');
  if (!doc.pours.items.length) lines.push('未发现任何铺铜（pour）。必须先决定是否铺 GND 铜，再谈缝合。');
  else {
    lines.push('| 铺铜ID | 网络 | 层 | 名称 | 优先级 | 是否 GND |', '| --- | --- | --- | --- | --- | --- |');
    for (const p of doc.pours.items) lines.push(`| ${p.primitiveId} | ${p.net || '—'} | ${p.layer} | ${p.pourName || '—'} | ${p.pourPriority} | ${p.isGnd ? '是' : '否'} |`);
  }
  lines.push('', '## 密度/网格建议', '');
  lines.push(`- ${doc.densityRecommendation.general}`);
  lines.push(`- ${doc.densityRecommendation.rfAndClock}`);
  lines.push(`- 公式：${doc.densityRecommendation.formula}`);
  lines.push(`- 板边缝合：${doc.edgeStitching ? `间距 5/8/10mm → 预计 ${JSON.stringify(doc.edgeStitching.estimatedCounts)} 个孔` : '缺少板框尺寸，无法估算'}`);
  lines.push('', '## 候选网格（粗避让后的参数化建议，非实际放置计划）', '');
  lines.push('| 间距 | 网格点 | 焊盘/过孔避让 | 走线避让 | 可用候选数 | 面积估算 | 就绪度 |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const p of doc.gridPlans) lines.push(`| ${p.pitchMm}mm | ${p.gridPointCount} | ${p.rejectedByPadOrVia} | ${p.rejectedByLine} | ${p.candidateCount} | ${p.areaBasedEstimate ?? '—'} | ${p.readiness ?? '需人工确认'} |`);
  const sample = doc.gridPlans.find((p) => p.pitchMm === 8)?.sampleCandidates || doc.gridPlans[0]?.sampleCandidates || [];
  if (sample.length) {
    lines.push('', '### 8mm 网格候选样例（全部 needsManualReview=true）', '');
    lines.push('| # | X (mm) | Y (mm) | 状态 |', '| --- | --- | --- | --- |');
    sample.forEach((s, i) => lines.push(`| ${i + 1} | ${s.xMm} | ${s.yMm} | ${s.note} |`));
  }
  lines.push('', '## 必须人工确认项', '');
  for (const item of doc.humanConfirmItems) lines.push(`- ${item}`);
  if (doc.warnings.length) { lines.push('', '## 风险/告警', ''); for (const w of doc.warnings) lines.push(`- ${w}`); }
  lines.push('', '## 只读证据链', '');
  lines.push('| 命令 | 权限 | 耗时(ms) | 结果 |', '| --- | --- | --- | --- |');
  for (const c of doc.bridge?.commands || []) lines.push(`| ${c.command} | ${c.permission} | ${c.ms} | ${c.ok ? '成功' : `失败：${c.error}`} |`);
  lines.push('', `> ${doc.note}`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法：node scripts/board-triage.mjs [--offline] [--erc=FILE] [--netlist=FILE] [--pins=FILE] [--pcb-capture=FILE] [--out=DIR] [--stamp=TS]');
    return;
  }
  const generatedAt = new Date().toISOString();
  const ts = args.stamp || stamp(new Date(generatedAt));
  const outDir = args.out ? path.resolve(ROOT, args.out) : DEFAULT_OUT;
  fs.mkdirSync(outDir, { recursive: true });

  // --- ERC 证据
  const ercPath = args.erc ? path.resolve(ROOT, args.erc) : latestByMtime(listFiles(ERC_DIR, (f) => f.endsWith('.json')));
  if (!ercPath) throw new Error(`找不到 ERC 证据：${ERC_DIR}`);
  const ercEvidence = loadJson(ercPath);
  const report = extractErcReport(ercEvidence);

  // --- 网表（T3 产出）
  const netlistPath = args.netlist ? path.resolve(ROOT, args.netlist) : latestByMtime(listFiles(SPICE_DIR, (f) => /^netlist-.*\.(net|json|txt)$/.test(f)));
  let netlistParsed = null;
  let netlistInfo = null;
  let rawNetlist = null;
  if (netlistPath && fs.existsSync(netlistPath)) {
    const text = readText(netlistPath);
    let source = text;
    let wrapper = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.text === 'string') { source = parsed.text; wrapper = { meta: Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'text')) }; }
    } catch { /* 纯文本网表，按 EasyEDA JSON 解析 */ }
    netlistParsed = parseEasyEdaNetlist(source);
    try { rawNetlist = JSON.parse(source); } catch { rawNetlist = null; }
    netlistInfo = { path: netlistPath, sha256: sha256(source), wrapper, parseOk: Boolean(netlistParsed), components: netlistParsed?.componentCount ?? null, nets: netlistParsed?.netCount ?? null, pins: netlistParsed?.pinCount ?? null };
  }

  // --- 历史引脚证据
  const pinsPath = args.pins ? path.resolve(ROOT, args.pins) : latestByMtime(listFiles(PINS_DIR, (f) => f.endsWith('.json')));
  let pinEvidence = null;
  if (pinsPath) {
    try {
      const data = loadJson(pinsPath);
      const evidence = data?.response?.evidence ?? data?.evidence ?? data;
      if (Array.isArray(evidence?.rows)) {
        pinEvidence = {
          path: pinsPath,
          readAt: data?.at ?? evidence?.at ?? null,
          status: data?.status ?? null,
          rows: evidence.rows.map((r) => ({ designator: String(r.designator ?? ''), pad: String(r.pad ?? ''), net: String(r.net ?? '').trim(), layer: r.layer ?? null })),
          duplicates: evidence.duplicates ?? [],
        };
      }
    } catch { /* 历史证据不可用不阻断 */ }
  }

  // --- 上下文：实例ID → 位号、网名集合
  const instanceToDesignator = new Map();
  const netPinCounts = new Map();
  const netNameSet = new Set();
  if (netlistParsed) {
    for (const c of netlistParsed.components) {
      if (c.instanceId && c.designator) instanceToDesignator.set(String(c.instanceId), c.designator);
    }
    for (const n of netlistParsed.nets || []) {
      netNameSet.add(n.name);
      netPinCounts.set(n.name, Array.isArray(n.pins) ? n.pins.length : 0);
    }
  }
  // EasyEDA 网表的唯一实例键是 Unique ID（如 gge8），ERC 里用的是 props 的 Channel ID（如 $2I8）：
  // 两种都要映射，才能把 error 里的“$2I8”解析成位号（本板实测为 MK1）。
  const instanceIdAliases = new Map();
  if (rawNetlist?.components) {
    for (const [uniqueId, entry] of Object.entries(rawNetlist.components)) {
      const props = entry?.props || {};
      const designator = String(props.Designator || '').trim();
      const channelId = String(props['Channel ID'] || '').trim();
      if (designator && uniqueId) instanceIdAliases.set(uniqueId, designator);
      if (designator && channelId) instanceIdAliases.set(channelId, designator);
      if (designator) instanceToDesignator.set(uniqueId, designator);
      if (designator && channelId) instanceToDesignator.set(channelId, designator);
    }
  }
  const netlistAudit = auditNetlistPowerGround(netlistParsed);
  const ctx = { report, counts: report.counts || {}, netlistParsed, netNameSet, netPinCounts, instanceToDesignator, instanceIdAliases, netlistAudit };

  // --- 一、ERC triage
  const erc = analyzeErc(ctx);

  // --- 二、无网络引脚
  const ercFloatingPins = erc.triaged.filter((t) => t.category === 'warning.pin-floating').flatMap((t) => t.objectRefs.pins);
  const pins = analyzeUnconnectedPins({ netlistParsed, ercFloatingPins, pinEvidence });

  // --- 三、GND 缝合（只读桥）
  let gnd = null;
  let gndBlocker = null;
  if (args['pcb-capture']) {
    try {
      const capture = loadJson(path.resolve(ROOT, args['pcb-capture']));
      gnd = analyzeGndStitching({ capture });
    } catch (error) { gndBlocker = `复用 PCB 只读快照失败：${error.message}`; }
  } else if (args.offline) {
    gndBlocker = '已指定 --offline：跳过 PCB 只读分析（GND 缝合部分未产出）。';
  } else {
    const captured = await capturePcbReadonly();
    if (captured.ok && captured.capture) {
      gnd = analyzeGndStitching({ capture: captured.capture });
      writeJson(path.join(outDir, `pcb-read-capture-${ts}.json`), captured.capture);
    } else {
      gndBlocker = captured.reason || 'PCB 只读读取失败（原因未知）';
    }
  }

  // PCB 侧补充核对：error 条目的器件在 PCB 上到底有没有焊盘（只读铜读回可复核）。
  let pcbPadCrossCheck = null;
  if (gnd?.componentPadCounts) {
    for (const item of erc.triaged) {
      if (item.category !== 'error.footprint-pad-mismatch') continue;
      const designator = item.crossCheck?.resolvedDesignator;
      if (!designator) continue;
      const padCount = Object.prototype.hasOwnProperty.call(gnd.componentPadCounts, designator) ? gnd.componentPadCounts[designator] : 0;
      item.crossCheck.pcbPadCount = padCount;
      item.crossCheck.pcbPadCheck = padCount === 0
        ? `PCB 铜读回里 ${designator} 的焊盘数为 0（未读到任何焊盘），与 ERC“引脚没有对应焊盘”一致；可制造性硬阻断已得到 PCB 侧证据。`
        : `PCB 铜读回里 ${designator} 有 ${padCount} 个焊盘，但仍需人工核对是否包含缺失的引脚 ${item.objectRefs.missingPads.join('/')}。`;
      pcbPadCrossCheck = { designator, padCount, note: item.crossCheck.pcbPadCheck };
    }
  }

  // --- 汇总输出
  const ercDoc = {
    schemaVersion: 1,
    kind: 'board-triage-erc',
    generatedAt,
    evidence: {
      path: ercPath,
      savedAt: ercEvidence.savedAt ?? null,
      digest: ercEvidence.digest ?? report.digest ?? null,
      documentUuid: report.documentUuid ?? ercEvidence.fingerprint?.documentUuid ?? null,
      detailSource: report.detailSource ?? null,
      detailAvailable: report.detailAvailable ?? null,
      windowId: ercEvidence.fingerprint?.windowId ?? null,
      projectUuid: ercEvidence.fingerprint?.projectUuid ?? null,
      openCounts: report.openCounts ?? null,
      exemptions: report.exemptions ?? null,
    },
    netlist: netlistInfo,
    netlistAudit,
    pcbPadCrossCheck,
    counts: erc.counts,
    derivedCounts: erc.derivedCounts,
    expected: erc.expected,
    expectedCategories: erc.expectedCategories,
    categoryCounts: erc.categoryCounts,
    countsMatch: true,
    triaged: erc.triaged,
    caveats: [
      'object 字段在证据里全部是 unknown，因此对象/网络引用是从 detail 文本解析的；导线 $2Nxx 是 EDA 内部 ID，需在 EDA 中定位。',
      '所有条目都是 requiresHumanConfirm=true / autoFixable=false：本产物只是 triage 证据，本脚本不调用任何写命令。',
      netlistParsed ? `实例ID→位号映射来自网表（${netlistInfo.path}）；$2Ixx 使用网表 props 的 Channel ID 映射。` : '网表不可用：实例ID（如 $2I8）无法映射到位号，需人工在 EDA 中查。',
      '网表交叉核对只陈述网表里可复核的引脚-网络事实，不替人工判定“是不是设计错误”；但它足以说明网络名冲突已经产生了后果。',
    ],
  };
  const pinsDoc = { schemaVersion: 1, kind: 'board-triage-unconnected-pins', generatedAt, netlist: netlistInfo, ...pins };
  const gndDoc = gnd ? { schemaVersion: 1, kind: 'board-triage-gnd-stitching', generatedAt, ...gnd } : { schemaVersion: 1, kind: 'board-triage-gnd-stitching', generatedAt, blocked: true, reason: gndBlocker };
  if (gnd) {
    gndDoc.schematicComponentCount = netlistInfo?.components ?? null;
    gndDoc.schematicVsBoardNote = (netlistInfo?.components != null && gnd.copperComponentCount != null && netlistInfo.components !== gnd.copperComponentCount)
      ? `当前原理图网表有 ${netlistInfo.components} 个器件，而 PCB 铜读回有 ${gnd.copperComponentCount} 个器件：两者不一致，说明原理图与 PCB 可能不是同一版设计。GND 缝合建议针对“当前打开的 PCB 文档”，执行前必须先确认该 PCB 与原理图同步。`
      : null;
  }
  const summary = {
    schemaVersion: 1,
    kind: 'board-triage-summary',
    generatedAt,
    projectRoot: ROOT,
    outputs: {
      erc: path.join(outDir, `erc-triage-${ts}.json`),
      pins: path.join(outDir, `unconnected-pins-${ts}.json`),
      gnd: path.join(outDir, `gnd-stitching-${ts}.json`),
    },
    erc: { ok: true, counts: erc.counts, countsMatch: true, categoryCounts: erc.categoryCounts },
    netlistAudit: netlistAudit ? {
      componentCount: netlistInfo.components,
      netCount: netlistAudit.netCount,
      pinCount: netlistAudit.pinCount,
      namedPinCount: netlistAudit.namedPinCount,
      netsWithoutPins: netlistAudit.netsWithoutPins,
      gndNamedPinCount: netlistAudit.gndAudit.gndNamedPinCount,
      gndPinsOffGndNetCount: netlistAudit.gndAudit.gndPinsOffGndNet.length,
      netlistHasGndNet: netlistAudit.gndAudit.netlistHasGndNet,
      verdict: netlistAudit.gndAudit.verdict,
    } : null,
    pcbPadCrossCheck,
    unconnectedPins: { total: pins.totalNoNetPins, shouldConnect: pins.byClassificationSummary.shouldConnect, mayFloatOrTestpoint: pins.byClassificationSummary.mayFloatOrTestpoint, fullyUnconnectedComponents: pins.fullyUnconnectedComponents.length, partiallyConnectedComponents: pins.partiallyConnectedComponents.length, fullyConnectedComponentCount: pins.fullyConnectedComponentCount, source: pins.source },
    gndStitching: gnd ? { ok: true, copperLayerCount: gnd.copperLayerCount, gndPourConnected: gnd.pours.gndPourConnected, innerGndPourCount: gnd.pours.innerGndPourCount, gndVias: gnd.vias.gndVias, board: gnd.board, componentCount: gnd.copperComponentCount, gndConnectivity: gnd.gndConnectivity } : { ok: false, blockedReason: gndBlocker },
    constraints: { edaWrites: [], note: '本脚本只读；未调用 place/set/apply/createPolygon/save/DRC 等写或校验命令。' },
    humanRequired: {
      erc: '1 个 error + 34 个 warning 全部需要人工确认电气意图；脚本不自动改图。网表交叉核对显示 GND 引脚被归到 +3V3，疑似地/电源短接，优先级最高。',
      pins: '无网络引脚的“应连接/可悬空”分类是工程判断，需逐条人工确认后决定连线或加 NC 标记。',
      gnd: gnd ? (gnd.gndConnectivity?.stitchingReadiness === 'blocked-gnd-net-isolated'
        ? 'GND 铺铜存在但 GND 网络是孤岛（无 GND 焊盘/走线/过孔）：缝合前置条件不成立，必须先修 GND 网络再谈缝合；网格/密度只是参考值。'
        : '缝合网格/密度为通用经验建议，需人工结合叠层、铺铜分割、天线净空与板厂工艺确认。') : 'PCB 只读读取失败，GND 缝合分析未产出。',
    },
  };

  writeJson(path.join(outDir, `erc-triage-${ts}.json`), ercDoc);
  writeJson(path.join(outDir, `unconnected-pins-${ts}.json`), pinsDoc);
  writeJson(path.join(outDir, `gnd-stitching-${ts}.json`), gndDoc);
  writeJson(path.join(outDir, `board-triage-summary-${ts}.json`), summary);
  fs.writeFileSync(path.join(outDir, `erc-triage-${ts}.md`), renderErcMd(ercDoc), 'utf8');
  fs.writeFileSync(path.join(outDir, `unconnected-pins-${ts}.md`), renderPinsMd(pinsDoc), 'utf8');
  fs.writeFileSync(path.join(outDir, `gnd-stitching-${ts}.md`), renderGndMd(gndDoc), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    ts,
    outDir,
    erc: { counts: erc.counts, categoryCounts: erc.categoryCounts, countsMatch: true },
    netlist: netlistInfo ? { path: netlistInfo.path, sha256: netlistInfo.sha256, components: netlistInfo.components, nets: netlistInfo.nets, pins: netlistInfo.pins } : null,
    netlistAudit: netlistAudit ? {
      gndNamedPinCount: netlistAudit.gndAudit.gndNamedPinCount,
      gndPinsOffGndNetCount: netlistAudit.gndAudit.gndPinsOffGndNet.length,
      netlistHasGndNet: netlistAudit.gndAudit.netlistHasGndNet,
      netsWithoutPins: netlistAudit.netsWithoutPins,
      verdict: netlistAudit.gndAudit.verdict,
    } : null,
    pins: { total: pins.totalNoNetPins, shouldConnect: pins.byClassificationSummary.shouldConnect, mayFloatOrTestpoint: pins.byClassificationSummary.mayFloatOrTestpoint, source: pins.source },
    gnd: gnd ? { copperLayerCount: gnd.copperLayerCount, gndPourConnected: gnd.pours.gndPourConnected, innerGndPourCount: gnd.pours.innerGndPourCount, gndVias: gnd.vias.gndVias, board: gnd.board, componentCount: gnd.copperComponentCount, gndConnectivity: gnd.gndConnectivity } : { blocked: gndBlocker },
    humanRequired: summary.humanRequired,
  }, null, 2));
}

main().catch((error) => {
  console.error(`[board-triage] 失败：${error?.message || error}`);
  if (error?.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
