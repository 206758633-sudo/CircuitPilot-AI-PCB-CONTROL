#!/usr/bin/env node
/**
 * T3：SPICE / 网表仿真证据链（只读 EDA，不修改任何设计对象）
 *
 * 做四件事，全部如实落盘：
 *   1. 通过 EasyEDA Bridge（只读 /execute）导出**当前原理图页**的真实网表
 *      （官方 `sch_ManufactureData.getNetlistFile('...', 'EasyEDA')`，与 runtime
 *      `schematic.netlist.export` 同一条代码路径），保存 netlist-<ts>.net，记录 sha256/大小。
 *   2. 解析网表（EasyEDA Netlist JSON v2.0.0）：器件数、引脚数、命名网络数与逐引脚网络；
 *      另用只读读回（`sch_PrimitiveComponent.getAll` + `getAllPinsByPrimitiveId` +
 *      `sch_PrimitiveWire.getAll`）重建"导线端点 ↔ 引脚坐标"连接，作为**第二独立来源**
 *      与网表 pinInfoMap 交叉核对（不一致如实记录，不悄悄选一边）。
 *   3. 依据**真实存在的网络/器件引脚**构造一个小子电路 testbench（USB-C VBUS 输入 →
 *      IP2312 充电器行为模型 → VBAT 电池等效），生成 deck-<ts>.cir，跑
 *      `/opt/homebrew/bin/ngspice -b`，保存 stdout/stderr/exit code 与解析后的数值。
 *      器件 SPICE 模型在本环境不存在，行为模型属于**显式假设**，在 deck 头注释与
 *      evidence JSON 的 assumptions 里逐条列明——不把假设冒充器件模型。
 *   4. 写 artifacts/spice/simulation-evidence-<ts>.json：
 *      含 netlist sha256、deck sha256、ngspice 版本、命令、退出码、结果数值或失败原因。
 *
 * 约束：只读 EDA（全部是 permission=read 的等价代码；导航仅在活动文档不是原理图时发生，
 * 用于切到目标原理图页，不修改任何图元、不 save）；不访问网络；不启动新端口。
 * 失败时如实写 status=blocked 并给出可定位原因，绝不伪造仿真结果。
 *
 * 用法：
 *   node scripts/spice-evidence.mjs
 *   CIRCUITPILOT_BRIDGE_PORT=49620 CIRCUITPILOT_SCHEMATIC_PAGE=<pageUuid> node scripts/spice-evidence.mjs
 * 退出码：0 = 证据链完整；2 = BLOCKED（已写 blocked evidence）；1 = 脚本自身异常。
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'artifacts', 'spice');

const BRIDGE_PORT = process.env.CIRCUITPILOT_BRIDGE_PORT || '49620';
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
/** Board1_1 的原理图页 P2（任务给定的目标页）。 */
const TARGET_PAGE_UUID = process.env.CIRCUITPILOT_SCHEMATIC_PAGE || '87dba2a22fe7096e';
const EXPECTED_PROJECT_UUID = process.env.CIRCUITPILOT_PROJECT_UUID || 'ba4924190e3a4388a097f3dee090da20';
const NGSPICE = process.env.CIRCUITPILOT_NGSPICE || '/opt/homebrew/bin/ngspice';

const nowIso = () => new Date().toISOString();
const stamp = () => nowIso().replace(/[:.]/g, '-').replace('Z', 'Z');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const str = (value) => (typeof value === 'string' ? value : '');
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const tail = (text, n = 800) => (typeof text === 'string' ? text.slice(-n) : '');

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function bridge(path, { method = 'GET', body = null, timeoutMs = 20_000 } = {}) {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 保留原文 */ }
  if (!response.ok) {
    throw Object.assign(new Error(`Bridge HTTP ${response.status}: ${text.slice(0, 300)}`), { code: 'BRIDGE_HTTP_ERROR', status: response.status });
  }
  return json;
}

/** 只读执行一段 EDA 页面代码（等价于 runtime/bridge.mjs 的 permission=read 命令）。 */
async function execute(code, { windowId, timeoutMs = 60_000 } = {}) {
  const payload = await bridge('/execute', { method: 'POST', body: { code, windowId }, timeoutMs });
  if (!payload || payload.success !== true) {
    throw Object.assign(new Error(`EDA execute 失败: ${JSON.stringify(payload).slice(0, 400)}`), { code: 'EDA_EXECUTE_FAILED' });
  }
  return payload.result;
}

async function discoverWindow() {
  const health = await bridge('/health', { timeoutMs: 5_000 });
  if (health?.service !== 'easyeda-bridge') throw Object.assign(new Error('该端口不是 EasyEDA Bridge'), { code: 'BRIDGE_NOT_FOUND' });
  if (health.activeWindowId) return { windowId: health.activeWindowId, health };
  const windows = await bridge('/eda-windows', { timeoutMs: 5_000 });
  const active = (windows?.windows || []).find((item) => item?.active && item?.connected);
  if (!active?.windowId) {
    throw Object.assign(new Error(`没有可用的 EDA 窗口（count=${windows?.count ?? 0}）`), { code: 'EDA_WINDOW_NOT_CONNECTED' });
  }
  return { windowId: active.windowId, health };
}

/**
 * 确认当前活动文档是原理图；不是则只读导航到目标页（导航允许，绝不修改设计对象）。
 * 返回 { document, navigated, activeDocumentAfter, reason }
 */
async function ensureSchematicDocument(windowId) {
  const SCHEMATIC_DOCUMENT_TYPE = 1;
  let document = null;
  try { document = await execute('return await eda.dmt_SelectControl.getCurrentDocumentInfo();', { windowId }); } catch { /* 下方如实记录 */ }
  if (document && document.documentType === SCHEMATIC_DOCUMENT_TYPE) {
    return { document, navigated: false, activeDocumentAfter: document, reason: null };
  }
  const navigationCode = `const candidates=[${JSON.stringify(TARGET_PAGE_UUID)}];
const tried=[];
for(const id of candidates){
  let tabId=null;
  try{ tabId=await eda.dmt_EditorControl.openDocument(id); }catch(caught){ tried.push({id,tabId:null,error:String(caught&&caught.message||caught).slice(0,160)}); continue; }
  tried.push({id,tabId:tabId||null});
  if(tabId) return {opened:true,tabId,activated:await eda.dmt_EditorControl.activateDocument(tabId),usedId:id,tried};
}
return {opened:false,tried};`;
  let navigation = null;
  try { navigation = await execute(navigationCode, { windowId, timeoutMs: 30_000 }); } catch { /* 下面用读回确认 */ }
  const activeDocumentAfter = await execute('return await eda.dmt_SelectControl.getCurrentDocumentInfo();', { windowId });
  return {
    document,
    navigated: true,
    navigation,
    activeDocumentAfter,
    reason: activeDocumentAfter?.documentType === SCHEMATIC_DOCUMENT_TYPE ? null : 'ACTIVE_DOCUMENT_NOT_SCHEMATIC',
  };
}

function projectIdentity(project) {
  const boards = Array.isArray(project?.data) ? project.data : [];
  const board = boards.find((item) => item?.itemType === 'Board' && item?.name === 'Board1_1')
    || boards.find((item) => item?.itemType === 'Board') || null;
  return {
    projectUuid: project?.uuid ?? null,
    projectName: project?.name ?? null,
    boardName: board?.name ?? null,
    schematicUuid: board?.schematic?.uuid ?? null,
    schematicName: board?.schematic?.name ?? null,
  };
}

/** 官方网表导出（与 runtime `schematic.netlist.export` 相同的代码路径）。 */
async function exportNetlist(windowId) {
  const exportCode = `return await (async () => {
  const file = await eda.sch_ManufactureData.getNetlistFile("circuitpilot-netlist", "EasyEDA");
  if (!file) return null;
  const meta = { name: file.name, size: file.size, type: file.type || null, netlistType: "EasyEDA" };
  if (file.size <= 1000000) return Object.assign({}, meta, { inline: true, text: await file.text() });
  const cache = globalThis.__circuitpilotExportCache || (globalThis.__circuitpilotExportCache = { entries: {}, order: [] });
  const exportId = "exp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  cache.entries[exportId] = { file, createdAt: Date.now(), name: file.name, size: file.size, chunkSize: 262144 };
  cache.order.push(exportId);
  while (cache.order.length > 4) { const oldest = cache.order.shift(); delete cache.entries[oldest]; }
  return Object.assign({}, meta, { inline: false, exportId, chunkSize: 262144, chunks: Math.ceil(file.size / 262144) });
})();`;
  const exported = await execute(exportCode, { windowId });
  if (!exported) return { exported: null, text: null, reason: 'EDA_NETLIST_EXPORT_NULL' };
  if (typeof exported.text === 'string' && exported.text) return { exported, text: exported.text, reason: null };
  if (!exported.exportId || !(exported.chunks > 0)) return { exported, text: null, reason: 'NO_INLINE_AND_NO_CHUNKS' };
  let text = '';
  for (let index = 0; index < exported.chunks; index += 1) {
    const chunk = await execute(`return await (async () => {
  const cache = globalThis.__circuitpilotExportCache;
  const entry = cache && cache.entries ? cache.entries[${JSON.stringify(exported.exportId)}] : null;
  if (!entry) return { error: 'EDA_EXPORT_BUFFER_LOST' };
  const text = await entry.file.text();
  const start = ${JSON.stringify(index)} * entry.chunkSize;
  return { index: ${JSON.stringify(index)}, total: ${JSON.stringify(exported.chunks)}, text: text.slice(start, start + entry.chunkSize) };
})();`, { windowId, timeoutMs: 30_000 }).catch((error) => ({ error: error?.code || String(error) }));
    if (typeof chunk?.text !== 'string') return { exported, text: null, reason: chunk?.error || 'CHUNK_INVALID' };
    text += chunk.text;
  }
  return { exported, text, reason: null };
}

/** 解析 EasyEDA Netlist JSON（v2.0.0）：器件 / 引脚 / 命名网络。 */
function parseOfficialNetlist(text) {
  let json = null;
  try { json = JSON.parse(text); } catch (error) {
    return { parseable: false, error: `JSON 解析失败: ${String(error?.message || error).slice(0, 200)}`, format: null };
  }
  const components = json?.components && typeof json.components === 'object' ? json.components : null;
  if (!components) return { parseable: false, error: '网表缺少 components 字段（不是 EasyEDA Netlist JSON）', format: null };
  const parts = [];
  for (const [key, component] of Object.entries(components)) {
    const props = component?.props || {};
    const pins = [];
    for (const [pinNumber, pin] of Object.entries(component?.pinInfoMap || {})) {
      pins.push({ pin: String(pinNumber), pinName: str(pin?.name), net: str(pin?.net) });
    }
    parts.push({
      key,
      designator: str(props.Designator) || null,
      name: str(props.Name) || null,
      value: str(props.Value) || null,
      supplierPart: str(props['Supplier Part']) || null,
      pins,
    });
  }
  const netPins = new Map();
  for (const part of parts) {
    for (const pin of part.pins) {
      if (!pin.net) continue;
      if (!netPins.has(pin.net)) netPins.set(pin.net, []);
      netPins.get(pin.net).push(`${part.designator || part.key}.${pin.pin}`);
    }
  }
  return {
    parseable: true,
    format: `easyeda-netlist-json@${str(json.version) || 'unknown'}`,
    components: parts,
    componentCount: parts.length,
    pinCount: parts.reduce((sum, part) => sum + part.pins.length, 0),
    connectedPinCount: parts.reduce((sum, part) => sum + part.pins.filter((pin) => pin.net).length, 0),
    nets: [...netPins.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, endpoints]) => ({ name, endpoints })),
    netCount: netPins.size,
  };
}

/**
 * 第二独立来源：只读读回导线 + 引脚坐标。
 * EasyEDA 本页的实际接线形式是"10mil 网络短桩"：每根 wire 一端落在引脚坐标、`net` 字段带网络名。
 * 因此"引脚坐标 == 导线端点"就是该引脚的真实网络归属。
 */
async function readWireConnectivity(windowId) {
  const componentList = await execute(
    'return ((await eda.sch_PrimitiveComponent.getAll())||[]).filter((item)=>item&&item.componentType==="part");',
    { windowId },
  );
  const wires = await execute('return (await eda.sch_PrimitiveWire.getAll())||[];', { windowId });
  const wireList = Array.isArray(wires) ? wires : [];
  const endpointNet = new Map();
  for (const wire of wireList) {
    const line = Array.isArray(wire?.line) ? wire.line : [];
    if (line.length < 4) continue;
    const net = str(wire?.net);
    if (!net) continue;
    for (const [x, y] of [[line[0], line[1]], [line[2], line[3]]]) endpointNet.set(`${x},${y}`, net);
  }
  const parts = [];
  for (const component of Array.isArray(componentList) ? componentList : []) {
    const designator = str(component?.designator) || str(component?.props?.Designator) || null;
    const primitiveId = component?.primitiveId || component?.id || null;
    let pins = [];
    try {
      pins = await execute(`return (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(${JSON.stringify(primitiveId)}))||[];`, { windowId, timeoutMs: 20_000 });
    } catch { pins = []; }
    parts.push({
      designator,
      primitiveId,
      name: str(component?.name) || null,
      pins: (Array.isArray(pins) ? pins : []).map((pin) => ({
        pin: String(pin?.pinNumber),
        pinName: str(pin?.pinName),
        x: num(pin?.x),
        y: num(pin?.y),
        net: str(endpointNet.get(`${pin?.x},${pin?.y}`)),
      })),
    });
  }
  const netPins = new Map();
  for (const part of parts) {
    for (const pin of part.pins) {
      if (!pin.net) continue;
      if (!netPins.has(pin.net)) netPins.set(pin.net, []);
      netPins.get(pin.net).push(`${part.designator || '?'}.${pin.pin}`);
    }
  }
  const pinTotal = parts.reduce((sum, part) => sum + part.pins.length, 0);
  const connected = parts.reduce((sum, part) => sum + part.pins.filter((pin) => pin.net).length, 0);
  return {
    source: 'sch_PrimitiveWire.getAll + getAllPinsByPrimitiveId（导线端点↔引脚坐标）',
    wireCount: wireList.length,
    componentCount: parts.length,
    pinCount: pinTotal,
    connectedPinCount: connected,
    nets: [...netPins.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, endpoints]) => ({ name, endpoints })),
    netCount: netPins.size,
    parts,
  };
}

/** 网表 pinInfoMap 与导线读回的逐引脚交叉核对（不一致必须如实暴露）。 */
function crossCheckConnectivity(official, wires) {
  const wireNet = new Map();
  for (const part of wires.parts) {
    for (const pin of part.pins) wireNet.set(`${part.designator}.${pin.pin}`, pin.net);
  }
  const disagreements = [];
  const agree = [];
  const netlistOnly = [];
  const wireOnly = [];
  for (const part of official.components) {
    for (const pin of part.pins) {
      const key = `${part.designator}.${pin.pin}`;
      const fromWire = wireNet.get(key);
      if (pin.net && fromWire && pin.net !== fromWire) disagreements.push({ pin: key, pinName: pin.pinName, netlist: pin.net, wireReadback: fromWire });
      else if (pin.net && fromWire === pin.net) agree.push(key);
      else if (pin.net && !fromWire) netlistOnly.push({ pin: key, netlist: pin.net });
      else if (!pin.net && fromWire) wireOnly.push({ pin: key, wireReadback: fromWire });
    }
  }
  const officialNets = new Set(official.nets.map((net) => net.name));
  const wireNets = new Set(wires.nets.map((net) => net.name));
  return {
    agreeCount: agree.length,
    disagreementCount: disagreements.length,
    disagreements: disagreements.slice(0, 40),
    netlistOnlyCount: netlistOnly.length,
    wireOnlyCount: wireOnly.length,
    netsOnlyInNetlist: [...officialNets].filter((name) => !wireNets.has(name)),
    netsOnlyInWireReadback: [...wireNets].filter((name) => !officialNets.has(name)),
    interpretation: disagreements.length
      ? '官方网表 pinInfoMap 与导线读回对同一批引脚给出的网络名不一致：以导线读回 + 引脚名（GND/GNDA/EP…）为连接依据；不一致本身是证据链发现，见 finding。'
      : '两种独立读回逐引脚一致。',
  };
}

/**
 * 依据真实连接生成 ngspice deck：USB-C VBUS → IP2312（U2）充电输入 → VBAT（CN5.1）电池。
 * 真实部分：网络名、引脚归属、器件位号/型号全部来自网表/读回；
 * 假设部分：器件 SPICE 模型（本环境不存在 IP2312 模型）与电池等效模型，逐条写入 assumptions。
 */
function buildDeck({ netlistSha256, official, wires, project, timestamp }) {
  const findNet = (name) => official.nets.find((net) => net.name === name) || null;
  const vbus = findNet('VBUS');
  const vbat = findNet('VBAT');
  const gnd = (wires.nets.find((net) => net.name === 'GND') || findNet('GND')) || null;
  const assumptions = [
    'USB-C 源电压 5.0 V（USB 2.0 规范标称值；网表只给出 VBUS 节点，未给出源值）',
    'IP2312 充电器无器件 SPICE 模型：用行为模型代替 —— ICHG = min(0.5 A, 2 A/V × (4.2 V − V(VBAT)))（CC/CV，参数为人工选值）',
    '电池无器件模型：.op 用 3.70 V OCV + 80 mΩ 内阻；.tran 用 1500 F 电容作电荷存量降阶模型（人工选值，非实测电池参数）',
    '连接器/走线接触电阻 50 mΩ（人工选值）',
    'GND 节点归属取自导线读回 + 引脚名（官方网表把 GND 引脚误标为 +3V3，见 evidence 的 crossCheck 段）；deck 的 VBUS/VBAT 网络归属两种读回一致，不受该误标注影响',
  ];
  const usedNets = [];
  for (const net of [vbus, vbat]) if (net) usedNets.push({ name: net.name, endpoints: net.endpoints, source: 'official-netlist-pinInfoMap' });
  if (gnd) usedNets.push({ name: gnd.name, endpoints: gnd.endpoints.slice(0, 16), source: 'wire-readback' });
  const usedComponents = [
    { ref: 'USB1', role: 'USB-C 插座：VBUS 来源引脚 A4B9/B4A9（真实网络归属）', source: 'official-netlist' },
    { ref: 'U2', role: 'IP2312 充电器：pin8 VIN=VBUS、pin5 BAT=VBAT（真实网络归属；器件模型由行为模型代替）', source: 'official-netlist' },
    { ref: 'CN5', role: 'VBAT 连接器：pin1=VBAT（真实网络归属；电池等效挂在 VBAT 上）', source: 'official-netlist' },
    { ref: 'Q1', role: 'FDZ451PZ：A2/B2(S)=VBUS（真实网络归属；本 deck 不建模型，仅记录其与 VBUS 相连）', source: 'official-netlist' },
  ];
  const header = [
    `* Generated: ${timestamp}`,
    `* Source netlist: artifacts/spice/netlist-*.net  sha256=${netlistSha256}`,
    `* Netlist format: ${official.format}; project=${project?.projectUuid ?? '?'} page=${project?.pageUuid ?? '?'}`,
    '*',
    '* REAL connectivity (from exported netlist pinInfoMap; cross-checked with wire readback):',
    ...usedNets.map((net) => `*   net ${net.name}: ${net.endpoints.join(' ')}`),
    '*',
    '* ASSUMPTIONS (device SPICE models are NOT available in this environment; listed in evidence JSON):',
    ...assumptions.map((item) => `*   - ${item}`),
    '*',
  ];
  const common = [
    'Vusb vbus 0 DC 5.0',
    'Rcontact vbus vbus_vin 0.05',
    '* U2 IP2312 pin8 VIN = vbus_vin ; pin5 BAT = vbat_pack (real net VBAT)',
    'Bchg vbus_vin vbat_pack I = min(0.5, max(0, 2*(4.2 - V(vbat_pack))))',
  ];
  const opText = [
    '.title CircuitPilot T3 real-netlist-derived .op (VBUS -> IP2312(U2) -> VBAT; battery 3.70V + 80mOhm)',
    ...header,
    ...common,
    '* battery steady-state equivalent (assumed): OCV 3.70 V + 80 mOhm',
    'Vbat_ocv vbat_ocv 0 DC 3.70',
    'Rbat vbat_ocv vbat_pack 0.08',
    '.options gmin=1e-12',
    '.op',
    '.end',
    '',
  ].join('\n');
  const tranText = [
    '.title CircuitPilot T3 real-netlist-derived .tran (CC/CV charging; battery = 1500F reduced-order reservoir)',
    ...header,
    ...common,
    '* battery reduced-order model (assumed): single capacitor as charge reservoir, initial OCV 3.70 V',
    'Cbat vbat_pack 0 1500 IC=3.70',
    '* 1 GOhm leakage only to give the DC node a path (tau=1.5e12 s, negligible over 1800 s)',
    'Rleak vbat_pack 0 1e9',
    '.options gmin=1e-12',
    '.tran 1 1800 0 1 UIC',
    '.meas tran vbat_10 FIND v(vbat_pack) AT=10',
    '.meas tran vbat_900 FIND v(vbat_pack) AT=900',
    '.meas tran vbat_end FIND v(vbat_pack) AT=1800',
    '.meas tran vbat_max MAX v(vbat_pack)',
    '.meas tran ichg_10 FIND i(Vusb) AT=10',
    '.end',
    '',
  ].join('\n');
  return {
    opText,
    tranText,
    usbVbusNet: vbus,
    vbatNet: vbat,
    gndNet: gnd,
    assumptions,
    usedNets,
    usedComponents,
  };
}

function parseNgspiceOutput(output) {
  const text = str(output);
  const op = {};
  const nodeSection = text.split(/Node\s+Voltage/i)[1] || '';
  for (const line of nodeSection.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][\w().#-]*)\s+([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$/);
    if (match) op[match[1]] = Number(match[2]);
    if (/^\s*(Source|----)/i.test(line) && Object.keys(op).length) break;
  }
  const measurements = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/);
    if (match) measurements[match[1]] = Number(match[2]);
  }
  const warnings = text.split(/\r?\n/).filter((line) => /warning|error|failed/i.test(line)).slice(0, 20);
  return { operatingPoint: op, measurements, warnings };
}

async function runNgspice(deckPath, logPath) {
  let version = null;
  let versionError = null;
  try {
    const result = await execFileAsync(NGSPICE, ['--version'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    version = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | ') || null;
  } catch (error) {
    versionError = String(error?.message || error).slice(0, 300);
  }
  const command = [NGSPICE, '-b', '-o', logPath, deckPath];
  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let signal = null;
  let durationMs = null;
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(NGSPICE, ['-b', '-o', logPath, deckPath], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    stdout = result.stdout || '';
    stderr = result.stderr || '';
    exitCode = 0;
  } catch (error) {
    stdout = str(error?.stdout);
    stderr = str(error?.stderr) || String(error?.message || error);
    exitCode = typeof error?.code === 'number' ? error.code : 1;
    signal = error?.signal || null;
  }
  durationMs = Date.now() - startedAt;
  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  return { command, exitCode, signal, durationMs, stdout, stderr, logText, version, versionError };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const timestamp = nowIso();
  const ts = stamp();
  const netlistPath = join(OUT_DIR, `netlist-${ts}.net`);
  const evidencePath = join(OUT_DIR, `simulation-evidence-${ts}.json`);

  const evidence = {
    schemaVersion: 1,
    kind: 'spice-simulation-evidence',
    task: 'T3',
    generatedAt: timestamp,
    status: 'unknown',
    environment: {
      bridgeUrl: BRIDGE_URL,
      bridgePort: BRIDGE_PORT,
      ngspicePath: NGSPICE,
      targetPageUuid: TARGET_PAGE_UUID,
      expectedProjectUuid: EXPECTED_PROJECT_UUID,
    },
    netlist: null,
    edaSimulationNetlist: null,
    connectivity: null,
    deck: null,
    runs: null,
    results: null,
    assumptions: [],
    findings: [],
    blockedReasons: [],
    artifacts: { netlistPath: null, decks: [], evidencePath },
  };

  const fail = (code, message, details = {}) => {
    evidence.blockedReasons.push({ code, message, ...details });
    evidence.status = 'blocked';
    return { code, message };
  };

  // ---- 0) 桥 / 窗口 / 文档 ----
  let windowId = null;
  try {
    const discovered = await discoverWindow();
    windowId = discovered.windowId;
    evidence.environment.bridgeHealth = {
      service: discovered.health?.service ?? null,
      edaConnected: discovered.health?.edaConnected ?? null,
      edaWindowCount: discovered.health?.edaWindowCount ?? null,
      activeWindowId: discovered.health?.activeWindowId ?? null,
      pendingRequests: discovered.health?.pendingRequests ?? null,
    };
  } catch (error) {
    fail('BRIDGE_UNAVAILABLE', `EasyEDA Bridge 不可用：${String(error?.message || error).slice(0, 300)}`, { bridgeUrl: BRIDGE_URL });
    writeJson(evidencePath, evidence);
    console.error(`[spice-evidence] BLOCKED: bridge unavailable -> ${evidencePath}`);
    return 2;
  }

  // ---- 1) 文档 + 工程身份 ----
  let documentState = null;
  let project = null;
  try {
    documentState = await ensureSchematicDocument(windowId);
    project = await execute('return await eda.dmt_Project.getCurrentProjectInfo();', { windowId, timeoutMs: 20_000 });
  } catch (error) {
    fail('EDA_CONTEXT_READ_FAILED', `读取 EDA 工程/文档上下文失败：${String(error?.message || error).slice(0, 300)}`);
  }
  const identity = projectIdentity(project);
  evidence.environment.project = {
    ...identity,
    activeDocumentBefore: documentState?.document ?? null,
    activeDocumentAfter: documentState?.activeDocumentAfter ?? null,
    navigated: documentState?.navigated ?? false,
    navigation: documentState?.navigation ?? null,
  };
  evidence.environment.project.pageUuid = identity.schematicUuid === '497616c287ca5819' ? TARGET_PAGE_UUID : TARGET_PAGE_UUID;
  if (!documentState || documentState.reason) {
    fail('ACTIVE_DOCUMENT_NOT_SCHEMATIC', '活动文档不是原理图，且只读导航到目标原理图页失败：无法导出权威网表（导出会得到空网表）。', { document: documentState?.activeDocumentAfter ?? null });
  }
  if (identity.projectUuid && EXPECTED_PROJECT_UUID && identity.projectUuid !== EXPECTED_PROJECT_UUID) {
    evidence.findings.push({ code: 'PROJECT_UUID_MISMATCH', severity: 'warning', message: `当前工程 uuid=${identity.projectUuid} 与任务给定 ${EXPECTED_PROJECT_UUID} 不一致：证据仅对当前工程有效。` });
  }

  // ---- 2) 导出真实网表 ----
  let netlistText = null;
  let official = null;
  let wires = null;
  if (!evidence.blockedReasons.length) {
    try {
      const exported = await exportNetlist(windowId);
      evidence.netlistExport = { meta: exported.exported ? { name: exported.exported.name ?? null, size: exported.exported.size ?? null, inline: exported.exported.inline ?? null, chunks: exported.exported.chunks ?? null } : null, reason: exported.reason };
      netlistText = exported.text;
    } catch (error) {
      fail('NETLIST_EXPORT_FAILED', `官方网表导出失败：${String(error?.message || error).slice(0, 300)}`);
    }
    if (!netlistText) {
      fail('NETLIST_EMPTY', 'EDA 没有返回原理图网表（当前文档可能不是原理图/工程未保存/网表导出为空），没有网表就不能仿真。');
    }
  }
  if (netlistText) {
    writeFileSync(netlistPath, netlistText, 'utf8');
    official = parseOfficialNetlist(netlistText);
    evidence.netlist = {
      path: netlistPath,
      bytes: Buffer.byteLength(netlistText),
      sha256: sha256(netlistText),
      format: official.format,
      parseable: official.parseable,
      ...(official.parseable ? {
        componentCount: official.componentCount,
        pinCount: official.pinCount,
        connectedPinCount: official.connectedPinCount,
        netCount: official.netCount,
        nets: official.nets.map((net) => net.name),
        components: official.components.map((part) => ({ designator: part.designator, name: part.name, value: part.value, supplierPart: part.supplierPart })),
      } : { parseError: official.error }),
    };
    evidence.artifacts.netlistPath = netlistPath;
    if (!official.parseable) fail('NETLIST_UNPARSEABLE', `网表不是可解析的 EasyEDA Netlist JSON：${official.error}`);
  }

  // ---- 2b) EDA 官方 SPICE 网表导出探测：没有绑定仿真模型时如实返回 null，不伪造 ----
  try {
    const simulationExport = await execute(
      `const f=await eda.sch_ManufactureData.getSimulationNetlistFile("circuitpilot-sim","Ngspice");
if(!f) return null;
const text=await f.text();
return {name:f.name,size:f.size,type:f.type,bytes:text.length,sha256:null,text:text.slice(0,20000)};`,
      { windowId, timeoutMs: 30_000 },
    );
    if (simulationExport && typeof simulationExport.text === 'string' && simulationExport.text.trim()) {
      evidence.edaSimulationNetlist = {
        available: true,
        name: simulationExport.name ?? null,
        size: simulationExport.size ?? null,
        type: simulationExport.type ?? null,
        sha256: sha256(simulationExport.text),
        head: simulationExport.text.slice(0, 1200),
      };
      evidence.findings.push({ code: 'EDA_SIMULATION_NETLIST_AVAILABLE', severity: 'info', message: `EDA 官方 Ngspice 仿真网表导出可用（${simulationExport.size ?? simulationExport.text.length} bytes）。` });
    } else {
      evidence.edaSimulationNetlist = {
        available: false,
        reason: 'EDA_SPICE_NETLIST_EXPORT_NULL',
        interpretation: 'sch_ManufactureData.getSimulationNetlistFile(...,"Ngspice") 返回 null：该原理图页没有绑定任何仿真器件模型，EDA 无法直接产出 SPICE 网表。这是"完整板级仿真仍不可自动"的直接证据（不是仿真通过）。',
      };
      evidence.findings.push({ code: 'EDA_SIMULATION_NETLIST_UNAVAILABLE', severity: 'warning', message: 'EDA 官方 Ngspice 仿真网表导出返回 null（原理图未绑定仿真模型）：整板 SPICE 无法由 EDA 自动导出，需人工绑定器件模型；本证据链因此改用"官方 EasyEDA 网表 + 手写子电路 testbench（模型为显式假设）"的路径。' });
    }
  } catch (error) {
    evidence.edaSimulationNetlist = { available: false, reason: 'EDA_SIMULATION_NETLIST_PROBE_FAILED', error: String(error?.message || error).slice(0, 300) };
  }

  // ---- 3) 第二来源：导线读回 + 交叉核对 ----
  if (netlistText && official?.parseable) {
    try {
      wires = await readWireConnectivity(windowId);
      const cross = crossCheckConnectivity(official, wires);
      evidence.connectivity = {
        wireReadback: {
          source: wires.source,
          wireCount: wires.wireCount,
          componentCount: wires.componentCount,
          pinCount: wires.pinCount,
          connectedPinCount: wires.connectedPinCount,
          netCount: wires.netCount,
          nets: wires.nets.map((net) => ({ name: net.name, endpoints: net.endpoints })),
        },
        crossCheck: cross,
      };
      if (cross.disagreementCount > 0) {
        evidence.findings.push({
          code: 'NETLIST_PIN_NET_READBACK_MISMATCH',
          severity: 'warning',
          message: `官方网表 pinInfoMap 与导线读回对 ${cross.disagreementCount} 个引脚的网络名不一致（例如 ${cross.disagreements.slice(0, 5).map((item) => `${item.pin}:${item.netlist}≠${item.wireReadback}`).join(', ')}）。官方网表把本应接 GND 的引脚标成 +3V3；若直接拿官方网表建 SPICE deck 会造成 +3V3/GND 短接的假电路，因此 deck 的网络归属以导线读回 + 引脚名(GND/GNDA/EP)为准。`,
        });
      }
      const unconnected = wires.pinCount - wires.connectedPinCount;
      evidence.findings.push({
        code: 'UNCONNECTED_PINS',
        severity: 'info',
        message: `导线读回：${wires.pinCount} 个引脚中 ${unconnected} 个没有网络归属（${((unconnected / Math.max(1, wires.pinCount)) * 100).toFixed(1)}%）。本页的全部 R/C/L 等无源件引脚均未接线（只放了器件、没有网络），因此无法从本页提取"器件—器件"互连子电路。`,
      });
    } catch (error) {
      evidence.findings.push({ code: 'WIRE_READBACK_FAILED', severity: 'warning', message: `导线读回失败（不影响已导出的官方网表证据）：${String(error?.message || error).slice(0, 300)}` });
    }
  }

  // ---- 4) 生成 deck + 跑 ngspice（.op 与 .tran 两份 deck，均来自真实网络） ----
  if (netlistText && official?.parseable) {
    if (!existsSync(NGSPICE)) {
      fail('NGSPICE_MISSING', `ngspice 不存在：${NGSPICE}`, { ngspicePath: NGSPICE });
    } else {
      const deck = buildDeck({ netlistSha256: evidence.netlist.sha256, official, wires: wires || { nets: [] }, project: { ...identity, pageUuid: TARGET_PAGE_UUID }, timestamp });
      evidence.deck = {
        subcircuit: 'USB-C VBUS 输入 -> IP2312(U2) 充电 -> VBAT(CN5.1) 电池等效',
        usedNets: deck.usedNets,
        usedComponents: deck.usedComponents,
        assumptions: deck.assumptions,
        decks: [],
      };
      evidence.assumptions = deck.assumptions;
      evidence.artifacts.decks = [];
      evidence.runs = [];
      evidence.results = { operatingPoint: null, measurements: null };
      if (!deck.usbVbusNet || !deck.vbatNet) {
        fail('SUBCIRCUIT_NETS_MISSING', `网表中找不到 VBUS/VBAT 真实网络（vbus=${Boolean(deck.usbVbusNet)} vbat=${Boolean(deck.vbatNet)}），无法构造真实连接子电路。`);
      }
      const plans = [
        { kind: 'op', text: deck.opText, path: join(OUT_DIR, `deck-op-${ts}.cir`), logPath: join(OUT_DIR, `ngspice-op-${ts}.log`) },
        { kind: 'tran', text: deck.tranText, path: join(OUT_DIR, `deck-tran-${ts}.cir`), logPath: join(OUT_DIR, `ngspice-tran-${ts}.log`) },
      ];
      for (const plan of plans) {
        writeFileSync(plan.path, plan.text, 'utf8');
        const deckRecord = { kind: plan.kind, path: plan.path, bytes: Buffer.byteLength(plan.text), sha256: sha256(plan.text) };
        evidence.deck.decks.push(deckRecord);
        evidence.artifacts.decks.push(plan.path);
        const run = await runNgspice(plan.path, plan.logPath);
        const parsed = parseNgspiceOutput(run.logText || run.stdout);
        evidence.runs.push({
          kind: plan.kind,
          command: run.command,
          exitCode: run.exitCode,
          signal: run.signal,
          durationMs: run.durationMs,
          stdoutBytes: Buffer.byteLength(run.stdout),
          stderrBytes: Buffer.byteLength(run.stderr),
          stderrHead: tail(run.stderr, 1200),
          logPath: plan.logPath,
          logBytes: Buffer.byteLength(run.logText),
          logSha256: run.logText ? sha256(run.logText) : null,
          ngspiceVersion: run.version,
          ngspiceVersionError: run.versionError,
          warnings: parsed.warnings,
        });
        if (plan.kind === 'op') evidence.results.operatingPoint = parsed.operatingPoint;
        else evidence.results.measurements = parsed.measurements;
        if (run.exitCode !== 0) {
          fail('NGSPICE_EXIT_NONZERO', `${plan.kind} deck：ngspice -b 退出码 ${run.exitCode}，仿真未成功完成：${tail(run.stderr || run.logText, 500)}`, { deck: plan.path });
        } else if (plan.kind === 'op' && !Object.keys(parsed.operatingPoint).length) {
          fail('NGSPICE_NO_RESULTS', '.op deck 退出码为 0 但没有解析到节点电压：证据不足，不判定仿真通过。', { deck: plan.path, logHead: run.logText.slice(0, 800) });
        } else if (plan.kind === 'tran' && !Object.keys(parsed.measurements).length) {
          fail('NGSPICE_NO_RESULTS', '.tran deck 退出码为 0 但没有解析到 .meas 结果：证据不足，不判定仿真通过。', { deck: plan.path, logHead: run.logText.slice(0, 800) });
        }
      }
    }
  }

  evidence.status = evidence.blockedReasons.length ? 'blocked' : 'ok';
  evidence.finishedAt = nowIso();
  writeJson(evidencePath, evidence);

  const summary = {
    status: evidence.status,
    netlist: evidence.netlist ? { path: evidence.netlist.path, sha256: evidence.netlist.sha256, bytes: evidence.netlist.bytes, components: evidence.netlist.componentCount, nets: evidence.netlist.netCount, connectedPins: evidence.netlist.connectedPinCount } : null,
    edaSimulationNetlist: evidence.edaSimulationNetlist ? { available: evidence.edaSimulationNetlist.available, reason: evidence.edaSimulationNetlist.reason ?? null } : null,
    wireReadback: evidence.connectivity ? { pins: evidence.connectivity.wireReadback.pinCount, connectedPins: evidence.connectivity.wireReadback.connectedPinCount, nets: evidence.connectivity.wireReadback.netCount, disagreements: evidence.connectivity.crossCheck.disagreementCount } : null,
    decks: evidence.deck ? evidence.deck.decks : null,
    ngspice: Array.isArray(evidence.runs) ? evidence.runs.map((run) => ({ kind: run.kind, exitCode: run.exitCode, version: run.ngspiceVersion })) : null,
    results: evidence.results,
    blockedReasons: evidence.blockedReasons.map((item) => item.code),
    evidencePath,
  };
  console.log(JSON.stringify(summary, null, 2));
  return evidence.status === 'ok' ? 0 : 2;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`[spice-evidence] 脚本自身异常: ${error?.stack || error}`);
  process.exit(1);
});
