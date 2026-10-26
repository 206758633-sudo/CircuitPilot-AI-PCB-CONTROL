#!/usr/bin/env node
/**
 * W3-05 + W4-03 真机验证：EDA 库采集 → 供应链 → Librarian 三源核验 → lib-evidence 落盘。
 * 只读：不写 EDA、不写工程；证据落在 artifacts/evidence/lib-evidence。
 */
import { createEdaLibraryCollector } from '../runtime/collectors/eda-library.mjs';
import { runCollector } from '../runtime/collectors/collect.mjs';
import { auditPartIdentity } from '../runtime/agents/librarian.mjs';
import { createEvidenceStore } from '../runtime/evidence-store.mjs';
import { lookupLcscParts } from '../runtime/engineering/supply.mjs';

const BRIDGE = process.env.EASYEDA_BRIDGE_URL || 'http://127.0.0.1:49620';
const LCSC_IDS = (process.env.LIBRARIAN_LCSC_IDS || 'C3029377,C2688779,C990001093').split(',').map((item) => item.trim()).filter(Boolean);

const bridgeHealth = await (await fetch(`${BRIDGE}/health`)).json();
if (!bridgeHealth.activeWindowId) throw new Error('EDA 未连接：桥没有 activeWindowId');
const windowId = bridgeHealth.activeWindowId;
const execute = async (code) => {
  const response = await fetch(`${BRIDGE}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, windowId }) });
  const data = await response.json();
  if (!data.success) throw Object.assign(new Error(data.error || 'EDA 执行失败'), { code: 'EDA_EXECUTE_FAILED' });
  return data.result;
};
const search = async ({ query, mode, limit }) => {
  if (mode === 'lcsc') return (await execute(`return (await eda.lib_Device.getByLcscIds(${JSON.stringify(query)}))||[];`)) || [];
  return (await execute(`return (await eda.lib_Device.search(${JSON.stringify(query)},undefined,undefined,undefined,${JSON.stringify(limit)},1))||[];`)) || [];
};
const detail = async ({ uuid }) => execute(`return await eda.lib_Device.get(${JSON.stringify(uuid)});`);

console.log(`[librarian] 桥 ${BRIDGE} 已连接 EDA；待核验 ${LCSC_IDS.length} 个料号`);
const collector = createEdaLibraryCollector({ queries: LCSC_IDS, searchImpl: search, getImpl: detail });
const collected = await runCollector(collector, {});
console.log("[librarian] collected:", JSON.stringify(collected).slice(0, 600));
console.log(`[librarian] EDA 库采集：matched=${collected.evidence?.matched} missing=${collected.evidence?.missing?.length}`);
if (collected.evidence.missing.length) console.log('  missing:', JSON.stringify(collected.evidence.missing).slice(0, 400));

const supplyRaw = await lookupLcscParts({ lcscIds: LCSC_IDS, timeoutMs: 20_000 });
const store = createEvidenceStore({ root: 'artifacts/evidence' });
const results = [];
for (const lcscId of LCSC_IDS) {
  const item = collected.items.find((entry) => String(entry.payload.lcscId).toUpperCase() === lcscId.toUpperCase());
  const supply = supplyRaw?.parts?.[lcscId] ?? supplyRaw?.parts?.[lcscId.toUpperCase()] ?? null;
  const supplyShape = supply ? { lcscId, model: supply.model, package: supply.package, brand: supply.brand, price: supply.price, stock: supply.stock, checkedAt: supplyRaw.checkedAt } : null;
  let envelope;
  try {
    envelope = auditPartIdentity({ part: { lcscId }, eda: item?.payload ?? null, supply: supplyShape, datasheet: null });
  } catch (error) {
    envelope = { kind: 'lib-evidence', verdict: 'blocked', findings: [{ code: error.code ?? 'LIBRARIAN_FAILED', severity: 'error', message: error.message }], subject: { type: 'part', id: lcscId }, source: { agent: 'librarian', version: '1.0.0', readOnly: true }, fingerprint: { lcscId } };
  }
  const saved = store.save({ kind: 'lib-evidence', payload: envelope, fingerprint: { lcscId, verdict: envelope.verdict, source: 'real-machine' }, note: 'W3-05/W4-03 真机：EDA 库 + LCSC 供应链 + Librarian' });
  results.push({ lcscId, verdict: envelope.verdict, findings: envelope.findings.map((f) => f.code), eda: item ? { name: item.payload.mpn, footprint: item.payload.footprint, model3D: !!item.payload.model3D } : null, supply: supplyShape ? { model: supplyShape.model, package: supplyShape.package } : null, path: saved.path, digest: saved.digest });
}
const summary = { ok: results.every((item) => item.verdict === 'pass'), generatedAt: new Date().toISOString(), bridge: BRIDGE, results };
const { writeFileSync } = await import('node:fs');
const summaryPath = store.save({ kind: 'lib-evidence', payload: { schemaVersion: 1, kind: 'lib-evidence-summary', summary }, fingerprint: { source: 'verify-librarian' }, note: 'W3-05/W4-03 真机批量汇总' }).path.replace(/\.json$/, '-summary.json');
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ok: summary.ok, summaryPath, results }, null, 2));
