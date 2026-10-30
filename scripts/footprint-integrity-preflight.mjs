#!/usr/bin/env node
/**
 * 封装完整性预检（只读 EDA，不修改任何设计对象）
 *
 * 背景：2026-10-22 衣橱助手V2.0 案例里，MEMS 麦克风（LMA2718B381 / C7587891）的封装
 * `df3cd846…`、`a3127f62…` 在本机标准库里都不存在。现象是"放置成功、连线成功"，
 * 直到 ERC 才冒出一句"引脚没有对应焊盘"，整条发布链卡在 RELEASE_SCHEMATIC_NOT_READY，
 * 而人只能从一句聚合错误里反推根因（试了 4 条修复路径才确认是库资产缺失）。
 *
 * 本脚本把这件事提前：在画完图、跑门禁之前，直接读
 *   原理图器件引脚（sch_PrimitiveComponent.getAll + getAllPinsByPrimitiveId）
 *   PCB 器件焊盘（pcb_PrimitiveComponent.getAll + getAllPinsByPrimitiveId）
 * 逐位号比对"引脚集合 ↔ 焊盘集合"，给出**可执行**的结论：哪个位号、缺哪几个焊盘。
 *
 * 纯只读：只在活动文档不是目标原理图页时切换文档（openDocument/activateDocument），
 * 不 save、不修改、不新建任何图元。
 *
 * 用法：
 *   node scripts/footprint-integrity-preflight.mjs
 *   CIRCUITPILOT_BRIDGE_PORT=49620 \
 *   CIRCUITPILOT_SCHEMATIC_PAGE=87dba2a22fe7096e \
 *   CIRCUITPILOT_PCB_UUID=5595e77cead09682 \
 *   node scripts/footprint-integrity-preflight.mjs
 *
 * 退出码：0 = 无阻断项；1 = 有阻断项（不能出制造文件）；2 = 证据链不完整（bridge/EDA/读回失败）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateFootprintIntegrity } from '../runtime/footprint-integrity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_PORT = process.env.CIRCUITPILOT_BRIDGE_PORT || '49620';
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const TARGET_PAGE_UUID = process.env.CIRCUITPILOT_SCHEMATIC_PAGE || '87dba2a22fe7096e';
const TARGET_PCB_UUID = process.env.CIRCUITPILOT_PCB_UUID || '5595e77cead09682';
const OUT_DIR = process.env.CIRCUITPILOT_INTEGRITY_OUT
  || join(ROOT, 'artifacts', 'wardrobe-case', 'pm-run-20261022', 'evidence');
const nowIso = () => new Date().toISOString();
const stamp = () => nowIso().replace(/[:.]/g, '-');
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
  if (cur && cur.documentType === 1) return { ok: true, already: true, document: { type: cur.documentType, uuid: cur.uuid } };
  const tabId = await eda.dmt_EditorControl.openDocument(${JSON.stringify(TARGET_PAGE_UUID)});
  if (!tabId) return { ok: false, reason: 'OPEN_DOCUMENT_FAILED' };
  await new Promise((r) => setTimeout(r, 1500));
  await eda.dmt_EditorControl.activateDocument(tabId);
  const after = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  return { ok: Boolean(after && after.documentType === 1), already: false, document: after ? { type: after.documentType, uuid: after.uuid } : null };
})()`;

const readSchematicCode = `return (async () => {
  const components = (await eda.sch_PrimitiveComponent.getAll()) || [];
  const parts = components.filter((item) => String(item.componentType) === 'part');
  const out = [];
  for (const part of parts) {
    const pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(part.primitiveId)) || [];
    out.push({
      designator: String(part.designator || ''),
      primitiveId: part.primitiveId ?? null,
      name: String(part.name || ''),
      footprint: part.footprint ? { uuid: String(part.footprint.uuid || ''), name: String(part.footprint.name || ''), libraryUuid: String(part.footprint.libraryUuid || '') } : null,
      pinNumbers: pins.map((pin) => String(pin.pinNumber ?? '')),
    });
  }
  return { components: components.length, parts: out.length, list: out };
})()`;

const openAndReadPcbCode = `return (async () => {
  const tabId = await eda.dmt_EditorControl.openDocument(${JSON.stringify(TARGET_PCB_UUID)});
  if (!tabId) return { ok: false, reason: 'OPEN_PCB_FAILED' };
  await new Promise((r) => setTimeout(r, 1500));
  await eda.dmt_EditorControl.activateDocument(tabId);
  const components = (await eda.pcb_PrimitiveComponent.getAll()) || [];
  const designators = [];
  const padsByDesignator = {};
  for (const component of components) {
    const designator = String(component.designator || '');
    if (!designator) continue;
    const pads = (await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(component.primitiveId)) || [];
    designators.push(designator);
    padsByDesignator[designator] = pads.map((pad) => String(pad.padNumber ?? ''));
  }
  return { ok: true, components: designators.length, designators, padsByDesignator };
})()`;

const restoreSchematicCode = `return (async () => {
  const tabId = await eda.dmt_EditorControl.openDocument(${JSON.stringify(TARGET_PAGE_UUID)});
  if (!tabId) return { ok: false, reason: 'RESTORE_FAILED' };
  await new Promise((r) => setTimeout(r, 1200));
  await eda.dmt_EditorControl.activateDocument(tabId);
  const after = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  return { ok: Boolean(after && after.documentType === 1), document: after ? { type: after.documentType, uuid: after.uuid } : null };
})()`;

const evidence = {
  kind: 'footprint-integrity-preflight',
  schemaVersion: 1,
  generatedAt: nowIso(),
  bridge: { url: BRIDGE_URL, port: Number(BRIDGE_PORT) || null },
  targets: { schematicPage: TARGET_PAGE_UUID, pcb: TARGET_PCB_UUID },
  readOnly: true,
  steps: [],
  ready: null,
  summary: null,
  findings: [],
  failure: null,
};

const finish = (exitCode, payload = {}) => {
  Object.assign(evidence, payload);
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `footprint-integrity-${stamp()}.json`);
  evidence.evidencePath = path;
  evidence.evidenceSha256 = sha256(JSON.stringify({ ...evidence, evidencePath: undefined, evidenceSha256: undefined }));
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`[footprint-integrity] evidence: ${path}`);
  if (Array.isArray(evidence.findings) && evidence.findings.length) {
    for (const item of evidence.findings.slice(0, 40)) console.log(`  ${item.severity === 'blocking' ? '✖' : '!'} ${item.code} ${item.message}`);
    if (evidence.findings.length > 40) console.log(`  … 其余 ${evidence.findings.length - 40} 条见证据文件`);
  }
  if (evidence.summary) {
    console.log(`[footprint-integrity] ready=${evidence.ready} parts=${evidence.summary.parts} blocking=${evidence.summary.blocking} warnings=${evidence.summary.warnings}`);
  }
  if (evidence.failure) console.error(`[footprint-integrity] FAILED: ${evidence.failure.code}: ${evidence.failure.message}`);
  process.exit(exitCode);
};

try {
  let healthValue = null;
  try {
    const info = await health();
    healthValue = info.value;
    evidence.bridge.health = { status: healthValue?.status ?? null, edaConnected: healthValue?.edaConnected ?? null, windowCount: healthValue?.edaWindowCount ?? null, activeWindowId: info.windowId };
    evidence.steps.push({ step: 'bridge.health', ok: true, edaConnected: healthValue?.edaConnected ?? null });
  } catch (error) {
    evidence.steps.push({ step: 'bridge.health', ok: false, error: String(error?.message || error).slice(0, 200) });
    finish(2, { failure: { code: 'BRIDGE_UNAVAILABLE', message: `EasyEDA Bridge 不可用：${String(error?.message || error).slice(0, 300)}（先启动 EDA 并打开工程）` } });
  }

  const schematicDoc = await execute(ensureSchematicCode).catch((error) => ({ ok: false, error: String(error?.message || error).slice(0, 300) }));
  evidence.steps.push({ step: 'schematic.ensure', ok: schematicDoc?.ok === true, document: schematicDoc?.document ?? null, reason: schematicDoc?.reason ?? schematicDoc?.error ?? null });
  if (!schematicDoc?.ok) finish(2, { failure: { code: 'SCHEMATIC_NOT_ACTIVE', message: `无法切到目标原理图页 ${TARGET_PAGE_UUID}：${schematicDoc?.reason || schematicDoc?.error || '未知原因'}` } });

  const schematic = await execute(readSchematicCode, { timeoutMs: 240_000 }).catch((error) => ({ error: String(error?.message || error).slice(0, 300) }));
  if (schematic?.error || !Array.isArray(schematic?.list)) {
    evidence.steps.push({ step: 'schematic.read', ok: false, error: schematic?.error ?? 'NO_PART_LIST' });
    finish(2, { failure: { code: 'SCHEMATIC_READ_FAILED', message: `读原理图器件失败：${schematic?.error || '未返回器件列表'}` } });
  }
  evidence.steps.push({ step: 'schematic.read', ok: true, components: schematic.components ?? null, parts: schematic.parts ?? schematic.list.length });

  const pcb = await execute(openAndReadPcbCode, { timeoutMs: 240_000 }).catch((error) => ({ ok: false, error: String(error?.message || error).slice(0, 300) }));
  evidence.steps.push({ step: 'pcb.read', ok: pcb?.ok === true, components: pcb?.components ?? null, reason: pcb?.reason ?? pcb?.error ?? null });

  const restored = await execute(restoreSchematicCode).catch((error) => ({ ok: false, error: String(error?.message || error).slice(0, 200) }));
  evidence.steps.push({ step: 'schematic.restore', ok: restored?.ok === true, document: restored?.document ?? null });

  if (!pcb?.ok) {
    finish(2, { failure: { code: 'PCB_READ_FAILED', message: `读 PCB 器件/焊盘失败：${pcb?.reason || pcb?.error || '未知原因'}` } });
  }

  const result = evaluateFootprintIntegrity({
    schematicParts: schematic.list,
    pcbComponents: (pcb.designators || []).map((designator) => ({ designator })),
    padsByDesignator: pcb.padsByDesignator || {},
  });
  evidence.steps.push({ step: 'evaluate', ok: true });
  finish(result.ready ? 0 : 1, {
    ready: result.ready,
    summary: result.summary,
    findings: result.findings,
    samples: {
      parts: schematic.list.slice(0, 3),
      pads: Object.fromEntries(Object.entries(pcb.padsByDesignator || {}).slice(0, 3)),
    },
    assumptions: [
      '焊盘号/引脚号按 EDA 返回原值字符串化；同号去重',
      '只做"数量与编号一致性"判断，不判断焊盘几何尺寸是否符合 datasheet（几何仍需人工 DFM 审核）',
      '原理图与 PCB 任一侧读不到时 fail-closed（退出码 2），不把"没读到"当成"没问题"',
    ],
  });
} catch (error) {
  finish(2, { failure: { code: 'UNEXPECTED_ERROR', message: String(error?.message || error).slice(0, 400) } });
}
