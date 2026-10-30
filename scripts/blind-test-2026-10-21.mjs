#!/usr/bin/env node
/**
 * W7-01/W7-02 盲测：只给两块**全新需求**的 PRD（不参考衣橱助手工程），走
 * 需求→验收映射 → design-spec → 门禁评估 的通用链路，输出可核对的指标。
 * 不写 EDA、不写工程；证据存 artifacts/evidence/design-spec 与 blind-test 汇总。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildAcceptanceMatrix, toDesignSpecInput } from '../runtime/acceptance-mapper.mjs';
import { buildDesignSpec } from '../runtime/design-spec.mjs';
import { createEvidenceEnvelope } from '../runtime/evidence-contract.mjs';
import { evaluatePcbGates, explainPcbGates } from '../runtime/gate-engine.mjs';
import { createEvidenceStore } from '../runtime/evidence-store.mjs';

const PRDS = [
  {
    id: 'blind-usb-c-hub',
    name: '盲测板A：USB-C 供电 + ESP32-S3 + I2S 功放 + WS2812B 灯环',
    boards: [{ id: 'B-A', name: 'hub-main', layers: 4, outline: { widthMm: 70, heightMm: 50 } }],
    requirements: [
      { id: 'A1', requirement: 'USB-C 接口输入 5V，带 ESD 保护' },
      { id: 'A2', requirement: '5V 转 3.3V 电源，至少 1.5A 输出' },
      { id: 'A3', requirement: 'ESP32-S3 主控，保留 UART 调试口' },
      { id: 'A4', requirement: 'I2S 数字功放驱动 4Ω 3W 喇叭' },
      { id: 'A5', requirement: '板载 WS2812B 灯环，至少 12 颗' },
      { id: 'A6', requirement: '板子尺寸不超过 70×50mm，四角 M2.5 安装孔' },
      { id: 'A7', requirement: '物料可在立创商城采购，BOM 成本可控' },
    ],
    netIntent: [
      { net: 'VBUS', endpoints: ['J1.A4', 'U2.IN'] },
      { net: '3V3', endpoints: ['U2.OUT', 'U1.3V3'] },
      { net: 'GND', endpoints: ['J1.A1', 'U1.GND'] },
    ],
  },
  {
    id: 'blind-12v-rs485',
    name: '盲测板B：12V 输入 + STM32 + RS485 + 两路继电器',
    boards: [{ id: 'B-B', name: 'ctrl-main', layers: 2, outline: { widthMm: 90, heightMm: 60 } }],
    requirements: [
      { id: 'B1', requirement: '12V 输入，防反接与过流保护' },
      { id: 'B2', requirement: '12V 转 5V/3.3V 双路电源' },
      { id: 'B3', requirement: 'STM32F103 主控，SWD 调试口' },
      { id: 'B4', requirement: 'RS485 接口带隔离与终端电阻' },
      { id: 'B5', requirement: '两路 10A 继电器输出，端子可插拔' },
      { id: 'B6', requirement: '工作温度 -20~70℃，符合 CE EMC 要求' },
      { id: 'B7', requirement: '板框 90×60mm，安装孔与外壳匹配' },
    ],
    netIntent: [
      { net: '12V', endpoints: ['J1.1', 'Q1.D'] },
      { net: '5V', endpoints: ['U2.OUT', 'K1.VCC'] },
      { net: 'GND', endpoints: ['J1.2', 'U1.GND'] },
    ],
  },
];

const store = createEvidenceStore({ root: 'artifacts/evidence' });
const outDir = join('artifacts', 'evidence', 'blind-test');
mkdirSync(outDir, { recursive: true });
const results = [];
for (const prd of PRDS) {
  const matrix = buildAcceptanceMatrix(prd.requirements);
  const specInput = toDesignSpecInput(matrix);
  let spec = null;
  let specError = null;
  try {
    spec = buildDesignSpec({ project: { id: prd.id, name: prd.name }, boards: prd.boards, netIntent: prd.netIntent, requirements: specInput.requirements, acceptance: specInput.acceptance });
  } catch (error) {
    specError = { code: error.code ?? 'SPEC_FAILED', message: error.message };
  }
  const specHash = spec ? createHash('sha256').update(JSON.stringify(spec)).digest('hex') : null;
  const envelope = createEvidenceEnvelope({
    kind: 'design-spec',
    subject: { type: 'board', id: prd.boards[0].id },
    fingerprint: { prdId: prd.id, pcbUuid: prd.boards[0].id, specHash, coverage: matrix.coverage },
    source: { agent: 'blind-test', version: '1.0.0', readOnly: true },
    verdict: spec && matrix.coverage === 1 ? 'pass' : 'blocked',
    findings: spec ? [{ code: 'SPEC_BUILT', severity: 'info', message: `${spec.acceptance.length} 条验收项全部落到证据类型` }] : [{ code: specError.code, severity: 'error', message: specError.message }],
    counts: { requirements: matrix.total, mapped: matrix.mapped, acceptance: spec?.acceptance.length ?? 0 },
    details: { prdId: prd.id, matrix, spec },
    blockedReason: spec && matrix.coverage === 1 ? null : 'design-spec 未能从需求生成',
  });
  const savedSpec = store.save({ kind: 'design-spec', payload: envelope, fingerprint: { prdId: prd.id, verdict: envelope.verdict, source: 'blind-test' }, note: `W7-01 盲测 ${prd.id}` });
  const gate = evaluatePcbGates({ envelopes: [envelope], targetPcbUuid: prd.boards[0].id });
  results.push({
    prdId: prd.id,
    name: prd.name,
    requirements: matrix.total,
    mapped: matrix.mapped,
    coverage: matrix.coverage,
    specValid: Boolean(spec),
    specError,
    acceptanceCount: spec?.acceptance.length ?? 0,
    gateVerdict: gate.verdict,
    gateUnknown: gate.unknownGates,
    gateBlocked: gate.blockedGates,
    gateExplanation: explainPcbGates(gate),
    evidencePath: savedSpec.path,
    evidenceDigest: savedSpec.digest,
    specHash,
  });
}
const report = {
  generatedAt: new Date().toISOString(),
  note: '两块全新需求板（仅 PRD 输入，不参考衣橱助手工程）；缺证据的门禁必须 unknown，不允许 unknown 冒充 pass。',
  boards: results,
  metrics: {
    boards: results.length,
    specValidRate: results.filter((item) => item.specValid).length / results.length,
    requirementCoverage: results.reduce((sum, item) => sum + item.coverage, 0) / results.length,
    gatePassRate: results.filter((item) => item.gateVerdict === 'pass').length / results.length,
    gateUnknownRate: results.filter((item) => item.gateVerdict === 'unknown').length / results.length,
    gateBlockedRate: results.filter((item) => item.gateVerdict === 'blocked').length / results.length,
  },
};
const reportPath = join(outDir, `blind-test-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ reportPath, ...report }, null, 2));
