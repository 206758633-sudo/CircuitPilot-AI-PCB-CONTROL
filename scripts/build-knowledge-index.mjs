#!/usr/bin/env node
/**
 * 生成 docs/knowledge/KNOWLEDGE-INDEX.md：知识点总索引 + 文档/条目统计。
 *
 * 目标：
 *  - 每个知识点（KP-*）都有可点击的文档入口，避免“知识点散落在 70 篇文档里”；
 *  - 每篇文档都能看到自己的 KP 数、结构化条目数和领域归属；
 *  - 把没有 KP 编号的清单/需求/研究笔记单独标出，而不是假装它们不存在；
 *  - 生成结果与源文档一一对应，`--check` 可在提交前发现索引过期。
 *
 * 用法：
 *   node scripts/build-knowledge-index.mjs          # 写入
 *   node scripts/build-knowledge-index.mjs --check  # 只校验是否最新
 *
 * 约束：本脚本只读 docs/knowledge 与 knowledge/pcb/dataset；不写知识条目、不改审核状态。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KB_DIR = join(ROOT, 'docs/knowledge');
const DATASET_DIR = join(ROOT, 'knowledge/pcb/dataset');
const OUT = join(KB_DIR, 'KNOWLEDGE-INDEX.md');
const IGNORE = new Set(['README.md', 'conflict-register.md', 'KNOWLEDGE-INDEX.md']);
const DIR_ORDER = ['pcb', 'schematic', 'components', 'cases', 'checklists', 'requirements'];

const THEMES = [
  {
    label: '需求 → 电源架构 → 电源树',
    note: '先定义电源域/上电顺序/保护，再画具体电路',
    docs: [['schematic/02-power-architecture.md', '电源架构'], ['schematic/12-power-topologies.md', '电源拓扑'], ['pcb/04-power-integrity-decoupling.md', '电源完整性'], ['components/04-power-ics.md', '电源 IC']],
  },
  {
    label: 'MCU 最小系统：电源/时钟/复位/调试',
    note: '去耦、晶振、复位、BOOT、下载口',
    docs: [['schematic/03-mcu-minimal-system.md', 'MCU 最小系统'], ['components/06-crystals-oscillators.md', '晶振'], ['cases/01-rpi-pico-rp2040.md', 'Pico 案例'], ['cases/04-stm32-nucleo.md', 'Nucleo 案例']],
  },
  {
    label: '接口、保护与隔离',
    note: '连接器/ESD/TVS/隔离带/爬电，先保护后通信',
    docs: [['schematic/04-interfaces.md', '接口'], ['schematic/05-protection.md', '保护'], ['components/10-interface-protection.md', '接口保护'], ['pcb/14-high-speed-protocols.md', '高速接口'], ['cases/07-isolated-can-rs485.md', '隔离 CAN/RS485']],
  },
  {
    label: '布局、布线、叠层',
    note: '从结构/接口/功率/防护/主控到预布线和十条原则',
    docs: [['pcb/02-stackup-impedance.md', '叠层与阻抗'], ['pcb/03-placement-routing.md', '布局布线'], ['pcb/08-component-placement.md', '布局依据'], ['pcb/23-lceda-project-workflow-and-bilibili-course.md', 'EDA 工程闭环'], ['pcb/24-prerouting-and-power-first.md', '预布线/电源优先'], ['pcb/25-ten-routing-principles.md', '布线十条原则']],
  },
  {
    label: '电源完整性、去耦与地',
    note: '目标阻抗、回流、去耦距离、地平面/分割',
    docs: [['pcb/04-power-integrity-decoupling.md', '去耦'], ['pcb/18-four-layer-planes-mech-holes-and-research-limits.md', '四层板平面'], ['components/01-passives.md', '无源件'], ['components/08-inductors-ferrites-fuses.md', '电感/磁珠']],
  },
  {
    label: '高速/信号完整性',
    note: '阻抗、差分、等长、参考平面、过孔/背钻',
    docs: [['pcb/07-multilayer-highspeed.md', '多层高速'], ['pcb/14-high-speed-protocols.md', '高速协议'], ['cases/10-circuitpilot-6l.md', '6 层案例'], ['schematic/08-analog-signal-chain.md', '模拟信号链']],
  },
  {
    label: 'EMC / ESD / 热 / 安规',
    note: '发射/抗扰、接口防护、热路径、认证证据',
    docs: [['pcb/05-emc-esd-thermal.md', 'EMC/ESD/热'], ['pcb/09-reliability-derating.md', '可靠性与降额'], ['pcb/11-safety-certification.md', '安规认证'], ['components/02-diodes-tvs.md', 'TVS'], ['cases/13-industrial-controller.md', '工业控制器'], ['cases/14-ac-dc-power.md', 'AC-DC']],
  },
  {
    label: 'DFM、制造、测试与装配',
    note: 'Gerber/BOM/坐标、拼板、测试点、ICT/FCT、返修',
    docs: [['pcb/06-dfm-manufacturing.md', 'DFM 制造'], ['pcb/10-testability-production-test.md', '可测试性'], ['pcb/13-package-assembly-rework.md', '封装装配'], ['components/07-lcsc-quickref-footprint.md', '封装核验'], ['components/11-supply-chain.md', '供应链'], ['cases/11-ch32v003-p0.md', '低成本案例']],
  },
  {
    label: '可靠性、柔性与封装',
    note: '寿命/环境/降额、弯折半径、补强、BGA/QFN 返修',
    docs: [['pcb/09-reliability-derating.md', '可靠性'], ['pcb/12-flex-rigid-flex.md', '柔性/刚挠'], ['pcb/13-package-assembly-rework.md', '封装/返修'], ['cases/16-flex-rigid-board.md', '柔性板案例']],
  },
  {
    label: '案例、研究与能力边界',
    note: '参考设计不能照抄；先看可信度、证据和工具边界',
    docs: [['cases/README.md', '案例库'], ['pcb/20-researched-layout-constraints.md', '公开资料研究'], ['pcb/21-eda-api-eco-playbook.md', 'EDA API/ECO'], ['pcb/22-ai-assisted-layout-and-readable-schematic.md', 'AI 布局'], ['pcb/17-circuitpilot-mechanical-capability-gaps.md', '能力边界']],
  },
];

const DIR_META = {
  pcb: { label: 'PCB / 制造 / 可靠性', purpose: '叠层、布局布线、电源完整性、EMC/ESD/热、DFM、测试、安规、封装装配' },
  schematic: { label: '原理图 / 电路设计', purpose: '电源架构、最小系统、接口、保护、ERC、模拟、电池、RF、ECO' },
  components: { label: '元器件 / 选型 / 库', purpose: '无源、分立、电源 IC、MCU/无线/连接器、晶振、料号、供应链、库管理' },
  cases: { label: '参考设计案例', purpose: '真实板与公开参考设计的复盘、规则依据、可迁移经验' },
  checklists: { label: '评审清单', purpose: '原理图/Layout/选型可勾选门禁' },
  requirements: { label: '需求档案', purpose: '产品需求/验收；不属于设计知识点，不进入设计门禁' },
};

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
};

const readJson = (name) => JSON.parse(readFileSync(join(DATASET_DIR, name), 'utf8'));
const rel = (full) => relative(ROOT, full).split('\\').join('/');
const docLink = (doc) => doc.path.replace(/^docs\/knowledge\//, '');
const esc = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

const parseDoc = (full) => {
  const text = readFileSync(full, 'utf8');
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? basename(full, '.md')).trim();
  const kps = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^#{1,4}\s+(KP-[A-Z0-9-]*?-\d{2,4})\s+(.+?)\s*$/);
    if (match) kps.push({ id: match[1], title: match[2].replace(/\s+#+\s*$/, '').trim() });
  }
  // 允许同一 ID 只在文档中出现一次；下面在总入口再统一检查。
  return { full, path: rel(full), dir: relative(KB_DIR, dirname(full)).split('\\')[0], title, kps };
};

const loadEntries = () => {
  const sources = [
    ['rule', 'rules.json'],
    ['module', 'modules.json'],
    ['case', 'cases.json'],
    ['part', 'parts.json'],
    ['failure', 'failures.json'],
  ];
  const all = [];
  for (const [kind, file] of sources) {
    const data = readJson(file);
    for (const entry of data.entries ?? []) {
      const id = entry.payload?.ruleId ?? entry.payload?.moduleId ?? entry.payload?.failureId
        ?? entry.payload?.lcscId ?? entry.payload?.mpn ?? '(no-id)';
      all.push({ kind, file, id, title: entry.title, doc: entry.doc, payload: entry.payload });
    }
  }
  return all;
};

const docSortKey = (doc) => {
  const dirIndex = DIR_ORDER.indexOf(doc.dir);
  return [dirIndex < 0 ? 99 : dirIndex, doc.path];
};

const idRange = (kps) => {
  if (!kps.length) return '—';
  const nums = kps.map((kp) => Number(kp.id.match(/(\d+)$/)?.[1] ?? NaN)).filter(Number.isFinite);
  if (!nums.length) return '—';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const digits = Math.max(2, String(max).length);
  return `${String(min).padStart(digits, '0')}–${String(max).padStart(digits, '0')}`;
};

const build = () => {
  const files = walk(KB_DIR).filter((full) => !IGNORE.has(basename(full)));
  const docs = files.map(parseDoc).sort((a, b) => {
    const [ad, ap] = docSortKey(a);
    const [bd, bp] = docSortKey(b);
    return ad - bd || ap.localeCompare(bp, 'en', { numeric: true });
  });
  const entries = loadEntries();
  const sources = readJson('sources.json').sources.length;
  const entriesByDoc = new Map();
  for (const entry of entries) {
    if (!entry.doc) continue;
    const list = entriesByDoc.get(entry.doc) ?? [];
    list.push(entry);
    entriesByDoc.set(entry.doc, list);
  }

  const kpCount = docs.reduce((sum, doc) => sum + doc.kps.length, 0);
  const contentDocs = docs.filter((doc) => doc.dir !== 'requirements');
  const noKp = docs.filter((doc) => doc.kps.length === 0);
  const allKpIds = docs.flatMap((doc) => doc.kps.map((kp) => kp.id));
  const dupKpIds = [...new Set(allKpIds.filter((id, index) => allKpIds.indexOf(id) !== index))];
  const missingEntries = contentDocs.filter((doc) => !(entriesByDoc.get(doc.path)?.length));
  const docPaths = new Set(docs.map((doc) => doc.path));
  const orphanEntries = entries.filter((entry) => entry.doc && !docPaths.has(entry.doc));
  const issues = [
    ...dupKpIds.map((id) => `DUPLICATE_KP_ID:${id}`),
    ...missingEntries.map((doc) => `DOC_WITHOUT_ENTRY:${doc.path}`),
    ...orphanEntries.map((entry) => `ENTRY_WITHOUT_DOC:${entry.doc}:${entry.id}`),
  ];
  const domains = DIR_ORDER.map((dir) => {
    const list = docs.filter((doc) => doc.dir === dir);
    const dirEntries = entries.filter((entry) => entry.doc && docDirOf(entry.doc) === dir);
    return {
      dir,
      label: DIR_META[dir]?.label ?? dir,
      purpose: DIR_META[dir]?.purpose ?? '',
      docs: list.length,
      kps: list.reduce((sum, doc) => sum + doc.kps.length, 0),
      entries: dirEntries.length,
      noKp: list.filter((doc) => doc.kps.length === 0).length,
    };
  });
  const byKind = Object.fromEntries(['rule', 'module', 'case', 'part', 'failure'].map((kind) => [kind, entries.filter((entry) => entry.kind === kind).length]));

  const lines = [];
  lines.push('# CircuitPilot 知识库总索引（知识点地图）');
  lines.push('');
  lines.push('> **自动生成，请不要手改本文件。** 修改 `docs/knowledge/**/*.md` 或 `knowledge/pcb/dataset/*.json` 后运行：');
  lines.push('> ```bash');
  lines.push('> npm run knowledge:index        # 重新生成');
  lines.push('> npm run knowledge:index:check  # 检查是否过期');
  lines.push('> ```');
  lines.push('');
  lines.push('本索引解决三个问题：');
  lines.push('');
  lines.push('1. **文档在哪里**：按 `pcb / schematic / components / cases / checklists / requirements` 分域列出，直接点进原文。');
  lines.push('2. **知识点在哪里**：每个 `KP-*` 编号都列出标题和所属文档，不再靠全文搜索。');
  lines.push('3. **哪些内容没有编号**：清单、需求档案、能力边界/研究笔记单独标出，避免“看起来漏了”。');
  lines.push('');
  lines.push('> 知识分层：本索引只表示“文档里的知识点位置”；结构化条目的审核状态以 knowledge store / 知识库页面为准，未审核条目（candidate）不得作为门禁依据。');
  lines.push('');
  lines.push('## 1. 总览');
  lines.push('');
  lines.push('| 指标 | 数量 |');
  lines.push('|---|---:|');
  lines.push(`| Markdown 文档（不含 README/索引/冲突登记） | **${docs.length}** |`);
  lines.push(`| 其中：设计内容文档（不含 requirements） | **${contentDocs.length}** |`);
  lines.push(`| 带 KP 编号的知识点 | **${kpCount}** |`);
  lines.push(`| 无 KP 编号的文档（清单/需求/专题） | **${noKp.length}** |`);
  lines.push(`| 结构化知识条目 | **${entries.length}** |`);
  lines.push(`| 来源登记 | **${sources}** |`);
  lines.push('');
  lines.push('结构化条目构成：');
  lines.push('');
  lines.push('| kind | 数量 | 说明 |');
  lines.push('|---|---:|---|');
  lines.push(`| rule | ${byKind.rule} | 可判定规则 |`);
  lines.push(`| module | ${byKind.module + byKind.case} | 模块 ${byKind.module} + 案例 ${byKind.case} |`);
  lines.push(`| part | ${byKind.part} | 料号/器件身份 |`);
  lines.push(`| failure | ${byKind.failure} | 失败模式 |`);
  lines.push('');
  lines.push('## 2. 领域导航');
  lines.push('');
  lines.push('| 领域 | 文档 | KP | 结构化条目 | 无 KP 文档 | 说明 |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (const domain of domains) {
    lines.push(`| [${domain.label}](./${domain.dir}/) | ${domain.docs} | ${domain.kps} | ${domain.entries} | ${domain.noKp} | ${esc(domain.purpose)} |`);
  }
  lines.push('');
  lines.push('## 3. 主题导航（跨域）');
  lines.push('');
  lines.push('同一个工程问题经常横跨原理图、PCB、器件与案例；下表按“设计问题”而不是按文件夹给入口。');
  lines.push('');
  lines.push('| 主题 | 入口文档 | 说明 |');
  lines.push('|---|---|---|');
  for (const theme of THEMES) {
    const links = theme.docs.map(([path, label]) => `[${label}](./${path})`).join(' · ');
    lines.push(`| ${esc(theme.label)} | ${links} | ${esc(theme.note)} |`);
  }
  lines.push('');
  lines.push('## 4. 文档目录');
  lines.push('');
  lines.push('| # | 文档 | 标题 | KP 数 | KP 范围 | 结构化条目 | 备注 |');
  lines.push('|---:|---|---|---:|---|---:|---|');
  docs.forEach((doc, index) => {
    const docEntries = entriesByDoc.get(doc.path) ?? [];
    const kinds = Object.entries(docEntries.reduce((acc, entry) => { acc[entry.kind] = (acc[entry.kind] ?? 0) + 1; return acc; }, {}))
      .map(([kind, count]) => `${kind} ${count}`).join(' · ');
    const note = doc.kps.length ? (kinds ? '' : '仅文档') : (doc.dir === 'requirements' ? '需求档案，不进设计门禁' : '清单/专题，无 KP 编号');
    lines.push(`| ${index + 1} | [${esc(basename(doc.path))}](<./${docLink(doc)}>) | ${esc(doc.title)} | ${doc.kps.length} | ${idRange(doc.kps)} | ${docEntries.length}${kinds ? `（${kinds}）` : ''} | ${note} |`);
  });
  lines.push('');
  lines.push('## 5. 完整知识点索引');
  lines.push('');
  lines.push('按领域 → 文档 → 文档内顺序展开；`KP-CASE-*` 保持案例短名，不强行改成数字。');
  lines.push('');
  for (const domain of domains) {
    const domainDocs = docs.filter((doc) => doc.dir === domain.dir);
    lines.push(`### ${domain.label}`);
    lines.push('');
    if (!domainDocs.length) {
      lines.push('（无文档）');
      lines.push('');
      continue;
    }
    for (const doc of domainDocs) {
      const docEntries = entriesByDoc.get(doc.path) ?? [];
      lines.push(`#### [${esc(basename(doc.path))}](<./${docLink(doc)}>) — ${esc(doc.title)}`);
      lines.push('');
      lines.push(`- 文档：\`${doc.path}\``);
      lines.push(`- KP：**${doc.kps.length}**${doc.kps.length ? `（${idRange(doc.kps)}）` : ''} · 结构化条目：**${docEntries.length}**`);
      if (!doc.kps.length) {
        lines.push('- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。');
      } else {
        for (const kp of doc.kps) lines.push(`- **${kp.id}** ${esc(kp.title)}`);
      }
      lines.push('');
    }
  }
  lines.push('## 6. 无 KP 编号的文档（有意保留）');
  lines.push('');
  lines.push('这些文档不是“漏整理”，而是清单/需求/专题笔记；它们的价值在可勾选条目或边界说明，不强行造 KP 编号。');
  lines.push('');
  lines.push('| 文档 | 领域 | 原因 |');
  lines.push('|---|---|---|');
  for (const doc of noKp) {
    const reason = doc.dir === 'checklists' ? '可勾选评审清单，条目本身就是检查项'
      : doc.dir === 'requirements' ? '产品需求/验收档案，不进入设计门禁'
        : '能力边界/研究笔记/API 专题，按章节组织比强行编号更清晰';
    lines.push(`| [${esc(basename(doc.path))}](<./${docLink(doc)}>) | ${doc.dir} | ${reason} |`);
  }
  lines.push('');
  lines.push('## 7. 索引健康检查');
  lines.push('');
  lines.push('生成时会检查并暴露以下问题：');
  lines.push('');
  lines.push('- 重复 `KP-*` ID；');
  lines.push('- 有结构化条目但没有对偶文档的路径；');
  lines.push('- 文档没有结构化条目（`requirements` 除外）；');
  lines.push('- 索引是否落后于源文档。');
  lines.push('');
  lines.push('当前检查结果：');
  lines.push('');
  lines.push(`- 重复 KP ID：${dupKpIds.length ? dupKpIds.join('、') : '无'}`);
  lines.push(`- 文档无结构化条目：${missingEntries.length ? missingEntries.map((doc) => doc.path).join('、') : '无'}`);
  lines.push(`- 条目对应文档不存在：${orphanEntries.length ? orphanEntries.map((entry) => entry.doc).join('、') : '无'}`);
  lines.push('- 文档/条目逐项校验见 `npm run knowledge:index:check` 与 `node scripts/seed-knowledge-pcb.mjs --check`。');
  lines.push('');
  return { text: `${lines.join('\n')}\n`, stats: { docs: docs.length, contentDocs: contentDocs.length, kps: kpCount, entries: entries.length, sources, noKp: noKp.length, dupKpIds, missingEntries, orphanEntries: orphanEntries.length, issues } };
};

const docDirOf = (docPath) => {
  const clean = String(docPath).replace(/^\.\//, '');
  const parts = clean.split('/');
  if (parts[0] === 'docs' && parts[1] === 'knowledge') return parts[2] ?? '';
  return parts[1] ?? '';
};

const main = () => {
  const check = process.argv.includes('--check');
  const { text, stats } = build();
  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== text || stats.issues.length > 0) {
      const code = stats.issues.length > 0 ? 'KNOWLEDGE_INDEX_ISSUES' : 'KNOWLEDGE_INDEX_STALE';
      console.error(JSON.stringify({ ok: false, code, out: rel(OUT), stats }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, code: 'KNOWLEDGE_INDEX_CURRENT', out: rel(OUT), stats }, null, 2));
    return;
  }
  writeFileSync(OUT, text);
  console.log(JSON.stringify({ ok: true, code: 'KNOWLEDGE_INDEX_WRITTEN', out: rel(OUT), stats }, null, 2));
};

main();
