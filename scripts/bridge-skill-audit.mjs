#!/usr/bin/env node
/**
 * 真机桥接：把当前 EDA PCB 的读回喂给 SKL 规则，跑一次只读审计并落证据。
 *
 * 用法：
 *   node scripts/bridge-skill-audit.mjs --design artifacts/design-intent.json
 *   node scripts/bridge-skill-audit.mjs --open-uuid 5595e77cead09682 --out artifacts/pcb-constraints/skill-audit-live.json
 *
 * `--design` 是设计意图 JSON（zones/assembly/selfCheck/diffPairs/netClasses…）；
 * 不传时几何仍从桥读，缺少意图数据的规则如实 REVIEW，不会假装 PASS。
 * 退出码：0=审计完成（即使有 REVIEW/FAIL）；1=桥/采集失败；2=审计有硬门禁 FAIL（加 --strict）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BridgeClient } from '../runtime/bridge.mjs';
import { buildSkillInput } from '../runtime/engineering/skill-input.mjs';
import { evaluateSkillRules } from '../runtime/engineering/skill-rules.mjs';

function parseArgs(argv) {
  const args = { design: null, out: 'artifacts/pcb-constraints/skill-audit-live.json', openUuid: null, port: 49620, strict: false, includeCopper: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--design') args.design = next();
    else if (arg === '--out') args.out = next();
    else if (arg === '--open-uuid') args.openUuid = next();
    else if (arg === '--port') args.port = Number(next());
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--include-copper') args.includeCopper = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw Object.assign(new Error(`未知参数：${arg}`), { code: 'ARGS_INVALID' });
  }
  return args;
}

const unwrap = (value) => (value && typeof value === 'object' && 'result' in value ? value.result : value);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/bridge-skill-audit.mjs [--design <json>] [--out <json>] [--open-uuid <pcbUuid>] [--include-copper] [--strict]');
    return 0;
  }
  const design = args.design ? JSON.parse(readFileSync(resolve(args.design), 'utf8')) : {};
  const client = new BridgeClient({ ports: [args.port], logger: { info() {}, warn() {}, error: console.error } });
  const found = await client.discover();
  if (!found) throw Object.assign(new Error(`未发现 EasyEDA Bridge（端口 ${args.port}）`), { code: 'BRIDGE_NOT_FOUND' });

  if (args.openUuid) {
    const opened = unwrap(await client.execute('pcb.open', { documentUuid: args.openUuid }, { allowWrite: true }));
    if (!opened?.opened) throw Object.assign(new Error(`pcb.open 未打开文档 ${args.openUuid}`), { code: 'PCB_OPEN_FAILED' });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
  }

  const document = unwrap(await client.execute('document.current', {}));
  if (Number(document?.documentType) !== 3) {
    throw Object.assign(new Error(`当前文档不是 PCB（documentType=${document?.documentType}, uuid=${document?.uuid}）。请先打开 PCB，或传 --open-uuid <pcbUuid>`), { code: 'NOT_A_PCB_DOCUMENT' });
  }

  const read = async (id) => unwrap(await client.execute(id, {}));
  const collected = {
    placement: await read('pcb.placement.read'),
    regions: await read('pcb.regions.detail'),
    texts: await read('pcb.texts.detail'),
    pours: await read('pcb.pours.detail'),
    outline: await read('pcb.outline.read'),
    copper: null,
  };
  if (args.includeCopper || (design.netClasses && design.netClassMap)) collected.copper = await read('pcb.copper.read');

  const input = buildSkillInput({ ...collected, design });
  const audit = evaluateSkillRules(input);
  const artifact = {
    kind: 'bridge-skill-audit',
    generatedAt: new Date().toISOString(),
    bridge: { port: found.port, document: { uuid: document.uuid, tabId: document.tabId, documentType: document.documentType } },
    reads: {
      commandIds: ['pcb.placement.read', 'pcb.regions.detail', 'pcb.texts.detail', 'pcb.pours.detail', 'pcb.outline.read', ...(collected.copper ? ['pcb.copper.read'] : [])],
      counts: {
        components: input.placements.length,
        regions: input.regions.length,
        silkTexts: input.silkTexts.length,
        pours: input.pours.length,
        tracks: Array.isArray(input.tracks) ? input.tracks.length : 0,
      },
      board: input.board,
    },
    designProvided: Boolean(args.design),
    audit,
  };
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(`doc=${document.uuid} components=${input.placements.length} regions=${input.regions.length} texts=${input.silkTexts.length} pours=${input.pours.length}`);
  console.log(`board=${input.board ? `${input.board.widthMm}x${input.board.heightMm}mm` : 'unknown'} out=${outPath}`);
  console.log(`summary PASS=${audit.summary.PASS} FAIL=${audit.summary.FAIL} REVIEW=${audit.summary.REVIEW} NA=${audit.summary.NA} releaseReady=${audit.releaseReady}`);
  for (const rule of audit.rules) {
    if (rule.status === 'PASS') continue;
    console.log(`  ${rule.id} ${rule.status} ${rule.message}`);
  }
  if (args.strict && !audit.passed) return 2;
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`${error.code || 'ERROR'}: ${error.message}`);
  process.exit(1);
});
