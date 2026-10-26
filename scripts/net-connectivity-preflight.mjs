#!/usr/bin/env node
/**
 * 网络连通性预检（只读 EDA，不修改任何设计对象）
 *
 * 背景（2026-10-22 某真实项目案例 真机教训）：原理图验收链在"网表能导出 + ERC 无 error + 器件数对"时
 * 会给出 ready=true，但真机读回来是：226 个引脚有 171 个网络为空、网表里没有 GND 网络、
 * USB1/MK1 的地引脚全挂在 +3V3 上、PCB 278 个焊盘有 171 个没有网络。也就是说：
 * **"验收通过"与"板子能造"之间没有一道闸门。** 本脚本把这道闸门提前到出制造文件之前。
 *
 * 纯只读：只在活动文档不是目标文档时切换（openDocument/activateDocument），不 save、不修改任何图元。
 *
 * 用法：
 *   node scripts/net-connectivity-preflight.mjs
 *   CIRCUITPILOT_BRIDGE_PORT=49620 \
 *   CIRCUITPILOT_SCHEMATIC_PAGE=87dba2a22fe7096e \
 *   CIRCUITPILOT_PCB_UUID=0123456789abcdef0123456789abcdef \
 *   node scripts/net-connectivity-preflight.mjs
 *
 * 退出码：0 = 无阻断项；1 = 有阻断项（不能出制造文件）；2 = 证据链不完整（bridge/EDA/网表读回失败）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditNetConnectivity } from '../runtime/net-connectivity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_PORT = process.env.CIRCUITPILOT_BRIDGE_PORT || '49620';
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const TARGET_PAGE_UUID = process.env.CIRCUITPILOT_SCHEMATIC_PAGE || '87dba2a22fe7096e';
const TARGET_PCB_UUID = process.env.CIRCUITPILOT_PCB_UUID || '0123456789abcdef0123456789abcdef';
const OUT_DIR = process.env.CIRCUITPILOT_NET_CONNECTIVITY_OUT
  || join(ROOT, 'artifacts', 'evidence');
const NETLIST_FILE_NAME = process.env.CIRCUITPILOT_NETLIST_FILE || 'circuitpilot-netlist';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

async function bridgeJson(path, { method = 'GET', body = null, timeoutMs = 30_000 } = {}) {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 2000) }; }
  if (!response.ok) {
    throw Object.assign(new Error(`bridge ${path} HTTP ${response.status}: ${String(parsed?.error || text).slice(0, 300)}`), { code: 'BRIDGE_HTTP_ERROR', status: response.status });
  }
  return parsed;
}

async function health() {
  const value = await bridgeJson('/health', { timeoutMs: 10_000 });
  const windowId = value?.activeWindowId || value?.windows?.[0]?.id || value?.selectedWindowId || null;
  return { value, windowId };
}

async function execute(code, { timeoutMs = 120_000 } = {}) {
  const { windowId } = await health();
  if (!windowId) throw Object.assign(new Error('EasyEDA Bridge 没有活动窗口（EDA 未打开工程？）'), { code: 'EDA_NO_WINDOW' });
  const result = await bridgeJson('/execute', { method: 'POST', body: { code, windowId, timeoutMs }, timeoutMs: timeoutMs + 30_000 });
  if (result?.success === false) {
    throw Object.assign(new Error(String(result.error || 'EDA 执行失败').slice(0, 400)), { code: 'EDA_EXECUTE_FAILED' });
  }
  return result?.result;
}

const ensureSchematicCode = `return (async () => {
  const cur = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (cur && cur.documentType === 1 && cur.uuid === ${JSON.stringify(TARGET_PAGE_UUID)}) return { ok: true, already: true, document: { type: cur.documentType, uuid: cur.uuid } };
  const tabId = await eda.dmt_EditorControl.openDocument(${JSON.stringify(TARGET_PAGE_UUID)});
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const activated = await eda.dmt_EditorControl.activateDocument(tabId);
  await new Promise((resolve) => setTimeout(resolve, 2048));
  const now = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!now || now.documentType !== 1) return { ok: false, error: 'NOT_SCHEMATIC_AFTER_SWITCH', document: now ? { type: now.documentType, uuid: now.uuid } : null };
  return { ok: true, activated: Boolean(activated), document: { type: now.documentType, uuid: now.uuid } };
})();`;

const ensurePcbCode = `return (async () => {
  const cur = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (cur && cur.documentType === 3 && cur.uuid === ${JSON.stringify(TARGET_PCB_UUID)}) return { ok: true, already: true, document: { type: cur.documentType, uuid: cur.uuid } };
  const tabId = await eda.dmt_EditorControl.openDocument(${JSON.stringify(TARGET_PCB_UUID)});
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const activated = await eda.dmt_EditorControl.activateDocument(tabId);
  await new Promise((resolve) => setTimeout(resolve, 2048));
  const now = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!now || now.documentType !== 3) return { ok: false, error: 'NOT_PCB_AFTER_SWITCH', document: now ? { type: now.documentType, uuid: now.uuid } : null };
  return { ok: true, activated: Boolean(activated), document: { type: now.documentType, uuid: now.uuid } };
})();`;

const netlistCode = `return (async () => {
  const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!doc || doc.documentType !== 1) return { ok: false, error: 'NOT_SCHEMATIC', document: doc ? { type: doc.documentType, uuid: doc.uuid } : null };
  let file = null;
  try { file = await eda.sch_ManufactureData.getNetlistFile(${JSON.stringify(NETLIST_FILE_NAME)}, 'EasyEDA'); } catch (error) { return { ok: false, error: 'EXPORT_THREW', message: String(error && error.message || error).slice(0, 300) }; }
  if (!file) return { ok: false, error: 'EXPORT_NULL' };
  let text = null;
  try { text = await file.text(); } catch (error) { return { ok: false, error: 'READ_THREW', message: String(error && error.message || error).slice(0, 300) }; }
  return { ok: typeof text === 'string' && text.length > 0, size: file.size ?? (text ? text.length : 0), text };
})();`;

const pcbCode = `return (async () => {
  const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!doc || doc.documentType !== 3) return { ok: false, error: 'NOT_PCB' };
  const components = (await eda.pcb_PrimitiveComponent.getAll()) || [];
  const out = [];
  for (const comp of components) {
    const pads = (comp.pads || []).map((pad) => ({ padNumber: String(pad.padNumber ?? ''), net: pad.net ?? '' }));
    out.push({ designator: String(comp.designator ?? ''), footprint: comp.footprint ? { uuid: comp.footprint.uuid, name: comp.footprint.name } : null, pads });
  }
  return { ok: true, count: out.length, components: out };
})();`;

const main = async () => {
  const startedAt = new Date().toISOString();
  let schematic = null;
  let netlist = null;
  let pcb = null;
  const problems = [];
  try {
    schematic = await execute(ensureSchematicCode, { timeoutMs: 120_000 });
    if (!schematic?.ok) problems.push(`切换到原理图失败：${schematic?.error || 'unknown'}`);
    else netlist = await execute(netlistCode, { timeoutMs: 180_000 });
  } catch (error) {
    problems.push(`原理图/网表读取失败：${String(error?.message || error).slice(0, 300)}`);
  }
  try {
    pcb = await execute(ensurePcbCode, { timeoutMs: 120_000 });
    if (!pcb?.ok) problems.push(`切换到 PCB 失败：${pcb?.error || 'unknown'}`);
    else pcb = await execute(pcbCode, { timeoutMs: 180_000 });
  } catch (error) {
    problems.push(`PCB 读取失败：${String(error?.message || error).slice(0, 300)}`);
  }

  const netlistText = netlist?.ok ? netlist.text : null;
  const audit = auditNetConnectivity({ netlistText, components: pcb?.components || [] });
  const evidence = {
    kind: 'net-connectivity',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    target: { schematicPageUuid: TARGET_PAGE_UUID, pcbUuid: TARGET_PCB_UUID },
    sources: {
      schematic: schematic ? { ok: Boolean(schematic.ok), document: schematic.document || null } : null,
      netlist: netlist ? { ok: Boolean(netlist.ok), error: netlist.error || null, size: netlist.size ?? null, sha256: netlistText ? sha256(netlistText) : null } : null,
      pcb: pcb ? { ok: Boolean(pcb.ok), components: pcb.count ?? null } : null,
    },
    problems,
    verdict: {
      ready: problems.length === 0 && audit.ready,
      blocking: audit.findings.filter((item) => item.severity === 'blocking').length
        + (problems.length ? 1 : 0),
      warning: audit.findings.filter((item) => item.severity === 'warning').length,
    },
    counts: audit.counts,
    nets: audit.nets,
    findings: audit.findings,
    details: audit.details,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `net-connectivity-${stamp()}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(`[net-connectivity] evidence: ${file}`);
  if (problems.length) for (const problem of problems) console.log(`[net-connectivity] PROBLEM: ${problem}`);
  for (const item of audit.findings) console.log(`[net-connectivity] ${item.severity === 'blocking' ? 'BLOCKING' : 'warning'} ${item.code}: ${item.message}`);
  console.log(`[net-connectivity] ready=${evidence.verdict.ready} blocking=${evidence.verdict.blocking} warning=${evidence.verdict.warning} pins=${audit.counts.netlistPins} pinsWithoutNet=${audit.counts.netlistPinsWithoutNet} pads=${audit.counts.pads} padsWithoutNet=${audit.counts.padsWithoutNet}`);
  if (problems.length) process.exit(2);
  process.exit(audit.ready ? 0 : 1);
};

main().catch((error) => { console.error('[net-connectivity] FATAL', String(error?.message || error).slice(0, 500)); process.exit(2); });
