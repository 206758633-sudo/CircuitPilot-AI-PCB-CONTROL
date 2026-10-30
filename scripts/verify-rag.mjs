#!/usr/bin/env node
/**
 * RAG 检索评估：用固定 golden query 集跑真实语料，算 Hit@1 / Hit@3 / MRR，并把结果落证据。
 * 目的：不是"看起来能搜到"，而是可复现的检索质量门禁。命中标准 = 前 k 条结果标题/正文包含期望关键词。
 */
import { join, resolve } from 'node:path';
import { createKnowledgeStore } from '../runtime/knowledge.mjs';
import { createRagStore } from '../runtime/rag/store.mjs';
import { createEvidenceStore } from '../runtime/evidence-store.mjs';
import { createEvidenceEnvelope } from '../runtime/evidence-contract.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const knowledgeStore = createKnowledgeStore({ root: join(ROOT, 'artifacts/knowledge') });
const rag = createRagStore({
  knowledgeStore,
  indexFile: join(ROOT, 'artifacts/rag/index.json'),
  dirs: ['docs/implementation', 'docs/wardrobe-case', 'docs/knowledge'],
  baseDir: ROOT,
});

const startedAt = Date.now();
const rebuilt = rag.reindex();
const buildMs = Date.now() - startedAt;

const GOLDEN = [
  { query: '阻抗控制 走线宽度 叠层', expect: /阻抗|走线|叠层/ },
  { query: 'DRC 间距 线宽 设计规则', expect: /DRC|间距|线宽/ },
  { query: 'ERC 悬空引脚 怎么处理', expect: /ERC|悬空|引脚/ },
  { query: '立创 封装 不匹配 核验', expect: /立创|封装|LCSC|核验/i },
  { query: 'USB-C 供电 选型 方案', expect: /USB|供电|选型/ },
  { query: 'Gerber 导出 制造文件', expect: /Gerber|制造|BOM/i },
  { query: '焊接 立碑 缺陷 原因', expect: /焊接|立碑|缺陷/ },
  // K1 通用工程知识（docs/knowledge + 结构化条目）
  { query: '去耦电容 摆放 距离 回路', expect: /去耦|回路|摆放/ },
  { query: 'LDO 热耗 压差 结温', expect: /LDO|热耗|压差|结温|线性稳压/i },
  { query: 'USB-C CC 5.1k 受电 不供电', expect: /USB-C|CC|5\.1k|受电/i },
  { query: '晶振 负载电容 起振 频偏', expect: /晶振|负载电容|起振|频偏/ },
  { query: '四层板 叠层 参考平面 回流', expect: /叠层|参考平面|回流|四层/ },
  { query: '元件 封装 引脚 符号 核验', expect: /封装|引脚|符号|核验/ },
  { query: 'Buck 电感 选型 纹波 同步整流', expect: /Buck|电感|纹波|同步/i },
  { query: 'ESD TVS 钳位 结电容 接口', expect: /ESD|TVS|钳位|结电容/i },
  // K2 参考设计案例（docs/knowledge/cases + cases.json）
  { query: 'Raspberry Pi Pico RP2040 参考设计 去耦 晶振', expect: /Pico|RP2040|参考设计|去耦/i },
  { query: 'Arduino Uno 电源自动切换 防倒灌', expect: /Arduino|Uno|电源|倒灌/i },
  { query: 'ESP32 天线净空 覆铜 射频 开发板', expect: /ESP32|天线|净空|射频/i },
  { query: 'USB-C PD 受电 CC VBUS 泄放 死电池', expect: /USB-C|PD|CC|VBUS|泄放/i },
  { query: '同步 Buck 输入电容 SW 节点 反馈 布局', expect: /Buck|SW|反馈|输入电容|布局/i },
  { query: '隔离 CAN RS485 爬电 终端电阻 共模', expect: /CAN|RS485|隔离|爬电|终端/i },
  { query: '衣橱助手 4 层 天线净空 板间连接 防反', expect: /衣橱|4 层|天线|板间|防反/i },
  { query: '6 层 90Ω 差分 等长 屏蔽过孔 反解', expect: /6 层|90Ω|差分|等长|过孔/i },
  // K3 多层/高速设计（docs/knowledge/pcb/07 + 新增 module/rule/failure）
  { query: '八层板 叠层 信号层 参考平面 对称', expect: /8 层|八层|叠层|参考|对称/i },
  { query: 'HDI 激光微孔 盲埋孔 背钻 stub', expect: /HDI|微孔|盲埋孔|背钻|stub/i },
  { query: 'DDR 字节通道 等长 ODT 飞线拓扑', expect: /DDR|等长|ODT|字节|拓扑/i },
  { query: 'PCIe 插入损耗 材料 Df 眼图 验收', expect: /PCIe|损耗|Df|眼图|验收/i },
  { query: '电源平面 目标阻抗 腔体谐振 缝合电容', expect: /目标阻抗|腔体|谐振|缝合/i },
  { query: '玻璃纤维效应 差分 偏斜 低Dk', expect: /玻璃纤维|weave|偏斜|低Dk/i },
  // K4 元器件布局依据与市场规则（docs/knowledge/pcb/08 + 新增 module/rule/failure）
  { query: '元器件布局 依据 标准 IPC-2221 courtyard', expect: /布局|依据|IPC|2221|courtyard/i },
  { query: '市场 消费电子 工业 布局 差异', expect: /消费|工业|市场|布局/i },
  { query: '去耦电容 到引脚 距离 过孔 回路面积', expect: /去耦|距离|过孔|回路/i },
  { query: '晶振 布局 负载电容 包地 时钟', expect: /晶振|负载电容|包地|时钟/i },
  { query: '连接器 板边 机械应力 布局', expect: /连接器|板边|应力|布局/i },
  { query: '测试点 探针 网格 可测试性', expect: /测试点|探针|网格|可测试/i },
  // K5 联网核对补充（TI 寄生电感 / Espressif 晶振与天线 / JLCPCB 拼板）
  { query: '去耦 寄生电感 100pH 同层 过孔', expect: /寄生电感|pH|同层|过孔/i },
  { query: '晶振 2.0mm 时钟引脚 地孔围栏', expect: /晶振|2\.0|时钟|地孔|围栏/i },
  { query: '天线 净空 15mm 整机 外壳', expect: /天线|15|净空|外壳/i },
  { query: '拼板 V-CUT 铜避让 Mark 3.85mm 邮票孔', expect: /V-CUT|Mark|3\.85|邮票孔|拼板/i },
  // K6 公开资料/真实参考设计研究（docs/knowledge/pcb/20 + 新增 rule/case/failure）
  { query: 'IPC-2221 电气间隙 海拔 涂覆 爬电 CTI', expect: /IPC|间隙|爬电|CTI|海拔/i },
  { query: 'QFN 热焊盘 散热过孔 钢网 50% 空洞', expect: /QFN|热焊盘|散热过孔|钢网|空洞/i },
  { query: 'USB3 差分 30 mil 参考平面 90 mil stub 15 mil', expect: /USB|差分|参考平面|stub|30|90/i },
  { query: 'JLCPCB PCBWay 线宽 间距 V-CUT 能力', expect: /JLC|PCBWay|线宽|间距|V-CUT/i },
  { query: 'ESP32 模组 天线 15 mm SDIO 50 mil', expect: /ESP32|天线|15|SDIO|50/i },
  // K7 治理：原理图规范/ERC/冲突口径/评审门禁
  { query: '原理图 网络命名 版本映射 三件套', expect: /原理图|网络命名|版本|三件套|BOM/i },
  { query: 'ERC 告警 豁免 台账 未归属', expect: /ERC|豁免|台账|告警/i },
  { query: '板边 V-CUT 0.5mm 3–5mm 冲突 口径', expect: /板边|V-CUT|0\.5|3.?5|口径|冲突/i },
  { query: '评审 放行 证据 签字 门禁', expect: /评审|放行|证据|签字|门禁/i },
  // K8 B站课程/嘉立创EDA专业版工程闭环（docs/knowledge/pcb/23 + 新增 rule/module/failure）
  { query: '嘉立创EDA专业版 工程闭环 投板 生产文件', expect: /嘉立创EDA|工程闭环|投板|生产文件/i },
  { query: 'B站 嘉立创EDA 入门教程 学习路径', expect: /B站|Bilibili|教程|学习路径|嘉立创EDA/i },
  { query: 'BOM 坐标 装配图 不一致 SMT 贴反', expect: /BOM|坐标|装配图|SMT|贴反/i },
  { query: 'PCB布局 先结构 接口 功率 防护 主控', expect: /布局|结构|接口|功率|防护|主控/i },
  { query: '主控放中间 布局 返工 接口方向', expect: /主控|布局|返工|接口/i },
  { query: '功率链路 短 直 粗 闭环 布局', expect: /功率|短|直|粗|闭环|布局/i },
];

// 负向查询：知识库不应“硬答”领域外问题；前 3 条最高分必须低于阈值。
const NEGATIVE = [
  '如何给火箭发动机做燃料',
  '股票 K 线 均线 金叉 选股',
  '房贷 利率 等额本息 计算',
  '如何训练一只猫 握手',
];
const NEGATIVE_SCORE_MAX = 0.85;

const records = [];
let hit1 = 0;
let hit3 = 0;
let reciprocal = 0;
for (const gold of GOLDEN) {
  const result = rag.query({ query: gold.query, topK: 3 });
  const matches = result.results.map((hit) => gold.expect.test(`${hit.title}\n${hit.heading}\n${hit.text}`));
  const firstIndex = matches.indexOf(true);
  if (firstIndex === 0) hit1 += 1;
  if (firstIndex >= 0) hit3 += 1;
  reciprocal += firstIndex >= 0 ? 1 / (firstIndex + 1) : 0;
  records.push({
    query: gold.query,
    expected: String(gold.expect),
    hit: firstIndex >= 0,
    rank: firstIndex >= 0 ? firstIndex + 1 : null,
    top: result.results.map((hit) => ({ score: hit.score, title: hit.title, kind: hit.kind, path: hit.path, knowledgeId: hit.knowledgeId })),
  });
}

const negativeRecords = [];
let negativePass = 0;
for (const query of NEGATIVE) {
  const result = rag.query({ query, topK: 3 });
  const topScore = result.results[0]?.score ?? 0;
  const passed = result.results.every((hit) => hit.score < NEGATIVE_SCORE_MAX);
  if (passed) negativePass += 1;
  negativeRecords.push({ query, passed, topScore, top: result.results.map((hit) => ({ score: hit.score, title: hit.title, kind: hit.kind, path: hit.path })) });
}

const knowledgeSource = (hit) => Boolean(hit) && (hit.kind === 'knowledge' || String(hit.path ?? '').startsWith('docs/knowledge/'));
const sourceOk = records.filter((record) => knowledgeSource(record.top[0])).length;

const metrics = {
  queries: GOLDEN.length,
  hit1,
  hit3,
  hit1Rate: Number((hit1 / GOLDEN.length).toFixed(4)),
  hit3Rate: Number((hit3 / GOLDEN.length).toFixed(4)),
  mrr: Number((reciprocal / GOLDEN.length).toFixed(4)),
  sourceOk,
  sourceOkRate: Number((sourceOk / GOLDEN.length).toFixed(4)),
  negativeQueries: NEGATIVE.length,
  negativePass,
  negativeRate: Number((negativePass / NEGATIVE.length).toFixed(4)),
};
const envelope = createEvidenceEnvelope({
  kind: 'knowledge',
  subject: { type: 'project', id: 'rag-index' },
  fingerprint: { indexDigest: rebuilt.corpusDigest },
  source: { agent: 'rag-evaluator', readOnly: true, version: '1.0.0' },
  verdict: metrics.hit3Rate >= 0.8 && metrics.sourceOkRate >= 0.9 && metrics.negativeRate === 1 ? 'pass' : 'blocked',
  findings: [],
  counts: { docs: rebuilt.docs, chunks: rebuilt.chunks, terms: rebuilt.terms, ...metrics },
  details: { buildMs, corpus: rebuilt.corpus, metrics, records, negativeRecords },
  blockedReason: metrics.hit3Rate >= 0.8 && metrics.sourceOkRate >= 0.9 && metrics.negativeRate === 1 ? null : `RAG 门禁未过：Hit@3=${metrics.hit3Rate}, sourceOk=${metrics.sourceOkRate}, negative=${metrics.negativeRate}`,
});
const store = createEvidenceStore({ root: join(ROOT, 'artifacts/evidence') });
const saved = store.save({
  kind: 'knowledge',
  payload: { report: 'rag-eval', verdict: envelope.verdict, buildMs, index: { docs: rebuilt.docs, chunks: rebuilt.chunks, terms: rebuilt.terms, corpusDigest: rebuilt.corpusDigest }, corpus: rebuilt.corpus, metrics, records, negativeRecords },
  fingerprint: { indexDigest: rebuilt.corpusDigest },
  note: 'RAG golden-query 检索评估',
});
console.log(JSON.stringify({ ok: true, verdict: envelope.verdict, buildMs, index: { docs: rebuilt.docs, chunks: rebuilt.chunks, terms: rebuilt.terms, file: rebuilt.file }, metrics, evidencePath: saved.path, records: records.map((record) => ({ query: record.query, hit: record.hit, rank: record.rank, top1: record.top[0] ?? null })), negativeRecords }, null, 2));
