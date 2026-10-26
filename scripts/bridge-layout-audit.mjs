#!/usr/bin/env node
/**
 * 真机桥接：当前 EDA PCB → 128 条布局规则审计（只读）。
 *
 * 用法：
 *   node scripts/bridge-layout-audit.mjs --out artifacts/pcb-layout/layout-audit-live.json
 *   node scripts/bridge-layout-audit.mjs --drc --drc-report artifacts/pcb-layout/drc.json
 *   node scripts/bridge-layout-audit.mjs --open-uuid 0123456789abcdef0123456789abcdef --strict
 *
 * 读回：placement / outline / texts / pads / copper；可选 `--drc` 跑官方 DRC（阻塞，可能几分钟）。
 * 退出码：0=审计完成；1=桥/读回失败；2=--strict 且存在阻断 FAIL。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BridgeClient } from '../runtime/bridge.mjs';
import { auditPlacementPlan } from '../runtime/placement-rules.mjs';
import { normalizeLayoutIntent } from '../runtime/engineering/layout-intent.mjs';
import { parsePolygonSource } from '../runtime/placement.mjs';

function parseArgs(argv) {
  const args = { out: 'artifacts/pcb-layout/layout-audit-live.json', openUuid: null, port: 49620, strict: false, drc: false, drcReport: null, drcScope: null, design: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--out') args.out = next();
    else if (arg === '--open-uuid') args.openUuid = next();
    else if (arg === '--port') args.port = Number(next());
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--drc') args.drc = true;
    else if (arg === '--drc-report') args.drcReport = next();
    else if (arg === '--drc-scope') args.drcScope = next();
    else if (arg === '--design') args.design = next();
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw Object.assign(new Error(`未知参数：${arg}`), { code: 'ARGS_INVALID' });
  }
  return args;
}
const unwrap = (value) => (value && typeof value === 'object' && 'result' in value ? value.result : value);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/bridge-layout-audit.mjs [--open-uuid <pcbUuid>] [--out <json>] [--design <json>] [--drc] [--drc-report <json>] [--drc-scope <text>] [--strict]');
    return 0;
  }
  const intent = args.design ? normalizeLayoutIntent(JSON.parse(readFileSync(resolve(args.design), 'utf8'))) : null;
  const client = new BridgeClient({ ports: [args.port], logger: { info() {}, warn() {}, error: console.error } });
  const found = await client.discover();
  if (!found) throw Object.assign(new Error(`未发现 EasyEDA Bridge（端口 ${args.port}）`), { code: 'BRIDGE_NOT_FOUND' });
  if (args.openUuid) {
    const opened = unwrap(await client.execute('pcb.open', { documentUuid: args.openUuid }, { allowWrite: true }));
    if (!opened?.opened) throw Object.assign(new Error(`pcb.open 未打开文档 ${args.openUuid}`), { code: 'PCB_OPEN_FAILED' });
    await new Promise((delay) => setTimeout(delay, 800));
  }
  const document = unwrap(await client.execute('document.current', {}));
  if (Number(document?.documentType) !== 3) throw Object.assign(new Error(`当前文档不是 PCB（documentType=${document?.documentType}）`), { code: 'NOT_A_PCB_DOCUMENT' });
  const read = async (id, commandArgs = {}) => unwrap(await client.execute(id, commandArgs));
  const readback = await read('pcb.placement.read');
  const outlineRead = await read('pcb.outline.read');
  const outline = parsePolygonSource(outlineRead?.items?.[0]?.polygon?.polygon ?? outlineRead?.items?.[0]?.source ?? null);
  const texts = await read('pcb.texts.detail');
  const pads = await read('pcb.pads.read', { pcbUuid: document.uuid });
  const copper = await read('pcb.copper.read');
  const placements = (readback?.components || []).map((component) => ({
    primitiveId: component.primitiveId,
    ref: component.designator,
    xMm: component.bboxMm?.centerXMm ?? component.xMm,
    yMm: component.bboxMm?.centerYMm ?? component.yMm,
    rotationDeg: component.rotationDeg,
    widthMm: component.bboxMm?.xMm,
    heightMm: component.bboxMm?.yMm,
    side: component.layerSide,
  })).filter((item) => Number.isFinite(item.xMm) && Number.isFinite(item.yMm));
  let drcReport = null;
  if (args.drcReport) drcReport = JSON.parse(readFileSync(resolve(args.drcReport), 'utf8'));
  else if (args.drc) drcReport = await read('pcb.drc');
  const drcScope = args.drcScope || `${document.uuid}/live`;
  const audit = auditPlacementPlan({ plan: { placements }, readback, outline, texts, pads, copper, drcReport, drcScope, intent });
  const artifact = {
    kind: 'bridge-layout-audit',
    generatedAt: new Date().toISOString(),
    bridge: { port: found.port, document: { uuid: document.uuid, tabId: document.tabId, documentType: document.documentType } },
    reads: {
      commandIds: ['pcb.placement.read', 'pcb.outline.read', 'pcb.texts.detail', 'pcb.pads.read', 'pcb.copper.read', ...(args.drc ? ['pcb.drc'] : [])],
      counts: { components: readback?.componentCount ?? placements.length, texts: texts?.count ?? null, pads: pads?.components?.length ?? null },
      board: audit.inputSummary.board,
    },
    designProvided: Boolean(args.design),
    drc: drcReport ? { scope: drcScope, providedByFile: Boolean(args.drcReport), itemCount: Array.isArray(drcReport) ? drcReport.length : (drcReport?.items?.length ?? null) } : null,
    audit,
  };
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`doc=${document.uuid} components=${placements.length} texts=${texts?.count ?? '?'} pads=${pads?.components?.length ?? '?'} out=${outPath}`);
  console.log(`PASS=${audit.passed} blocking=${audit.blockingFailures} review=${audit.review} releaseReady=${audit.releaseReady}`);
  for (const item of audit.blocking) console.log(`  BLOCK ${item.ruleId} ${item.message}`);
  if (args.strict && !audit.ok) return 2;
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => { console.error(`${error.code || 'ERROR'}: ${error.message}`); process.exit(1); });
