#!/usr/bin/env node
/**
 * 原理图连通性预检（只读 EDA，不修改任何设计对象）
 *
 * 背景（2026-10-22 某真实项目案例 真机教训）：
 *   验收链读网络只能靠"导出网表"。网表是结果，会把两类设计缺陷一起吞掉：
 *     · 171/266 个引脚根本没连（网表里只是空网络）；
 *     · 同一根导线上挂了 GND 和 +3V3 两个标签（网表把两个网络合并，看起来只是"+3V3 有 24 脚"）。
 *   本脚本直接从**文档源码 + 引脚世界坐标**算连通性：引脚连到哪根导线、导线合并成哪个网络、
 *   哪些导线挂了多个标签（短路）。这是"验收通过"之外的一道独立闸门。
 *
 * 判定口径见 runtime/schematic-connectivity.mjs。
 *
 * 用法：
 *   node scripts/schematic-connectivity-preflight.mjs
 *   CIRCUITPILOT_BRIDGE_PORT=49620 CIRCUITPILOT_SCHEMATIC_PAGE=87dba2a22fe7096e \
 *   node scripts/schematic-connectivity-preflight.mjs
 *
 * 退出码：0 = 无阻断项；1 = 有阻断项；2 = 证据链不完整（bridge/EDA/源码/引脚读回失败）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditSchematicConnectivity } from '../runtime/schematic-connectivity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_PORT = process.env.CIRCUITPILOT_BRIDGE_PORT || '49620';
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const TARGET_PAGE_UUID = process.env.CIRCUITPILOT_SCHEMATIC_PAGE || '87dba2a22fe7096e';
const OUT_DIR = process.env.CIRCUITPILOT_SCHEMATIC_CONNECTIVITY_OUT
  || join(ROOT, 'artifacts', 'evidence');
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

const sourceCode = `return (async () => {
  const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!doc || doc.documentType !== 1) return { ok: false, error: 'NOT_SCHEMATIC', document: doc ? { type: doc.documentType, uuid: doc.uuid } : null };
  let text = null;
  try { text = await eda.sys_FileManager.getDocumentSource(); } catch (error) { return { ok: false, error: 'SOURCE_THREW', message: String(error && error.message || error).slice(0, 300) }; }
  return { ok: typeof text === 'string' && text.length > 0, bytes: typeof text === 'string' ? text.length : 0, text };
})();`;

const pinsCode = `return (async () => {
  const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!doc || doc.documentType !== 1) return { ok: false, error: 'NOT_SCHEMATIC' };
  const components = (await eda.sch_PrimitiveComponent.getAll()) || [];
  const pins = [];
  const skipped = [];
  for (const comp of components) {
    let compPins = [];
    try { compPins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(comp.primitiveId); } catch (error) { skipped.push({ designator: String(comp.designator ?? ''), error: String(error && error.message || error).slice(0, 120) }); continue; }
    for (const pin of compPins || []) {
      pins.push({ designator: String(comp.designator ?? ''), number: String(pin.pinNumber ?? ''), name: String(pin.pinName ?? ''), x: Number(pin.x), y: Number(pin.y), noConnected: pin.noConnected === true });
    }
  }
  return { ok: true, components: components.length, pins, skipped };
})();`;

const main = async () => {
  const startedAt = new Date().toISOString();
  let schematic = null;
  let source = null;
  let pins = null;
  const problems = [];
  try {
    schematic = await execute(ensureSchematicCode, { timeoutMs: 120_000 });
    if (!schematic?.ok) problems.push(`切换到原理图失败：${schematic?.error || 'unknown'}`);
    else {
      source = await execute(sourceCode, { timeoutMs: 180_000 });
      if (!source?.ok) problems.push(`原理图源码读取失败：${source?.error || 'unknown'}${source?.message ? ` (${source.message})` : ''}`);
      pins = await execute(pinsCode, { timeoutMs: 180_000 });
      if (!pins?.ok) problems.push(`引脚坐标读取失败：${pins?.error || 'unknown'}`);
    }
  } catch (error) {
    problems.push(`原理图读取失败：${String(error?.message || error).slice(0, 300)}`);
  }

  const sourceText = source?.ok ? source.text : null;
  const audit = auditSchematicConnectivity({ sourceText, pins: pins?.pins || [] });
  const evidence = {
    kind: 'schematic-connectivity',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    target: { schematicPageUuid: TARGET_PAGE_UUID },
    sources: {
      schematic: schematic ? { ok: Boolean(schematic.ok), document: schematic.document || null } : null,
      source: source ? { ok: Boolean(source.ok), error: source.error || null, bytes: source.bytes ?? null, sha256: sourceText ? sha256(sourceText) : null } : null,
      pins: pins ? { ok: Boolean(pins.ok), components: pins.components ?? null, pins: Array.isArray(pins.pins) ? pins.pins.length : null, skipped: pins.skipped ?? [] } : null,
    },
    problems,
    verdict: {
      ready: problems.length === 0 && audit.ready,
      blocking: audit.findings.filter((item) => item.severity === 'blocking').length + (problems.length ? 1 : 0),
      warning: audit.findings.filter((item) => item.severity === 'warning').length,
    },
    counts: audit.counts,
    nets: audit.nets.map((net) => ({ names: net.names, pins: net.pins })),
    floating: audit.floating,
    multiLabelWires: audit.multiLabelWires,
    findings: audit.findings,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `schematic-connectivity-${stamp()}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(`[schematic-connectivity] evidence: ${file}`);
  if (problems.length) for (const problem of problems) console.log(`[schematic-connectivity] PROBLEM: ${problem}`);
  for (const item of audit.findings) console.log(`[schematic-connectivity] ${item.severity === 'blocking' ? 'BLOCKING' : 'warning'} ${item.code}: ${item.message}`);
  console.log(`[schematic-connectivity] ready=${evidence.verdict.ready} blocking=${evidence.verdict.blocking} warning=${evidence.verdict.warning} pins=${audit.counts.pins} connected=${audit.counts.connectedPins} floating=${audit.counts.floatingPins} noConnect=${audit.counts.noConnectPins} nets=${audit.counts.nets} multiLabelWires=${audit.multiLabelWires.length}`);
  if (problems.length) process.exit(2);
  process.exit(audit.ready ? 0 : 1);
};

main().catch((error) => { console.error('[schematic-connectivity] FATAL', String(error?.message || error).slice(0, 500)); process.exit(2); });
