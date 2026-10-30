import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOM_ENRICH_CODES,
  DEFAULT_BOM_EVIDENCE_MAX_AGE_MS,
  enrichBomRows,
  loadBomEvidenceFile,
  normalizeBomEvidence,
} from '../bom-enrich.mjs';

// 固定「当前时间」与时间构造器：所有测试都是确定性的，不依赖真实时钟。
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();

const lcscExport = (overrides = {}) => ({
  source: 'lcsc-export',
  partNumber: 'C25804',
  mpn: 'RC0603FR-0710KL',
  price: 0.0125,
  stock: 152000,
  currency: 'CNY',
  fetchedAt: at(2),
  ...overrides,
});

test('正常命中：新鲜证据按 lcsc 关联，价格/库存/币种进主字段并带 provenance', () => {
  const report = enrichBomRows({
    rows: [{ designator: 'R1', value: '10kΩ', mpn: 'RC0603FR-0710KL', lcsc: 'C25804', quantity: 100 }],
    evidence: [lcscExport()],
    now: NOW,
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'bom-enrichment');
  assert.equal(report.generatedAt, new Date(NOW).toISOString());
  assert.equal(report.maxAgeMs, DEFAULT_BOM_EVIDENCE_MAX_AGE_MS);

  const [row] = report.rows;
  assert.equal(row.status, 'matched');
  assert.equal(row.reasonCode, BOM_ENRICH_CODES.MATCH);
  assert.equal(row.price, 0.0125);
  assert.equal(row.stock, 152000);
  assert.equal(row.currency, 'CNY');
  assert.equal(row.provenance.source, 'lcsc-export');
  assert.equal(row.provenance.fetchedAt, at(2));
  assert.equal(row.provenance.stale, false);
  assert.equal(row.provenance.matchBy, 'lcsc');
  assert.equal(row.provenance.partNumber, 'C25804');
  assert.match(row.provenance.note, /命中证据/);

  assert.deepEqual(report.counts, {
    total: 1,
    matched: 1,
    missing: 0,
    stale: 0,
    ambiguous: 0,
    withTrustedPrice: 1,
    unknownPrice: 0,
  });
  assert.equal(report.totals.costComplete, true);
  assert.equal(report.totals.knownCost, 1.25);
  assert.equal(report.totals.currency, 'CNY');
  assert.equal(report.totals.unknownCostRows, 0);
});

test('只有 mpn 的 BOM 行：按 mpn 命中，但不把证据的 lcsc 伪造进 BOM 行', () => {
  const report = enrichBomRows({
    rows: [{ designator: 'U1', value: 'MCU', mpn: 'STM32F103C8T6', quantity: '2' }],
    evidence: [lcscExport({ partNumber: 'C8734', mpn: 'STM32F103C8T6', price: 6.5, stock: 800, fetchedAt: at(3) })],
    now: NOW,
  });

  const [row] = report.rows;
  assert.equal(row.status, 'matched');
  assert.equal(row.provenance.matchBy, 'mpn');
  assert.equal(row.lcsc, null, 'BOM 行没有 lcsc 时不得补造');
  assert.equal(row.quantity, 2, '数量字符串应被解析');
  assert.equal(row.price, 6.5);
  assert.equal(report.totals.knownCost, 13);
  assert.equal(report.totals.costComplete, true);
});

test('缺证据：unknown 不是 0 元，不补造任何供应商字段，成本汇总拒绝给 0', () => {
  const report = enrichBomRows({
    rows: [{ designator: 'R9', value: '1kΩ', mpn: 'NOPE-123', lcsc: 'C999999', quantity: 1 }],
    evidence: [lcscExport()],
    now: NOW,
  });

  const [row] = report.rows;
  assert.equal(row.status, 'missing');
  assert.equal(row.reasonCode, BOM_ENRICH_CODES.MISSING);
  assert.equal(row.price, null);
  assert.equal(row.stock, null);
  assert.equal(row.currency, null);
  assert.equal(row.provenance.source, null);
  assert.equal(row.provenance.fetchedAt, null);
  assert.equal(row.provenance.stale, false);
  assert.equal(row.provenance.observed, null);
  assert.match(row.provenance.note, /不补造/);
  assert.equal(row.lcsc, 'C999999', '原有 BOM 字段保留，不被证据改写');

  assert.equal(report.counts.missing, 1);
  assert.equal(report.counts.withTrustedPrice, 0);
  assert.equal(report.totals.knownCost, null, '没有任何可信价格时必须是 null，不能是 0');
  assert.equal(report.totals.costComplete, false);
  assert.equal(report.totals.unknownCostRows, 1);
  assert.match(report.totals.notes.join('；'), /unknown（不是 0 元）/);
});

test('歧义：同一 mpn 对应多个立创编号时拒绝自动选择，列出候选证据', () => {
  const report = enrichBomRows({
    rows: [{ designator: 'U2', value: '运放', mpn: 'LM358DR', quantity: 5 }],
    evidence: [
      lcscExport({ partNumber: 'C22222', mpn: 'LM358DR', price: 0.9 }),
      lcscExport({ partNumber: 'C11111', mpn: 'LM358DR', price: 0.8 }),
    ],
    now: NOW,
  });

  const [row] = report.rows;
  assert.equal(row.status, 'ambiguous');
  assert.equal(row.reasonCode, BOM_ENRICH_CODES.AMBIGUOUS);
  assert.equal(row.price, null);
  assert.equal(row.stock, null);
  assert.match(row.provenance.note, /多个立创编号/);
  assert.deepEqual(
    row.provenance.candidates.map((candidate) => candidate.partNumber),
    ['C11111', 'C22222'],
    '候选证据顺序必须确定（按编号码位序）',
  );
  assert.equal(report.totals.knownCost, null);
  assert.equal(report.totals.costComplete, false);
});

test('歧义：BOM 明确指定 lcsc 但证据只按 mpn 指向另一个编号 → 编号冲突，不自动替换', () => {
  const report = enrichBomRows({
    rows: [{ designator: 'U3', mpn: 'LM358DR', lcsc: 'C99999', quantity: 1 }],
    evidence: [lcscExport({ partNumber: 'C11111', mpn: 'LM358DR', price: 0.8 })],
    now: NOW,
  });

  const [row] = report.rows;
  assert.equal(row.status, 'ambiguous');
  assert.equal(row.reasonCode, BOM_ENRICH_CODES.AMBIGUOUS);
  assert.equal(row.price, null);
  assert.match(row.provenance.note, /编号冲突/);
  assert.deepEqual(row.provenance.candidates.map((candidate) => candidate.partNumber), ['C11111']);
});

test('歧义：同一 partNumber 同一抓取时间却价格矛盾 → 不挑一个，按歧义处理', () => {
  const report = enrichBomRows({
    rows: [{ designator: 'C1', lcsc: 'C42', quantity: 1 }],
    evidence: [
      lcscExport({ partNumber: 'C42', mpn: 'X', price: 1.0, stock: 10, fetchedAt: at(1) }),
      lcscExport({ partNumber: 'C42', mpn: 'X', price: 1.2, stock: 10, fetchedAt: at(1) }),
    ],
    now: NOW,
  });

  const [row] = report.rows;
  assert.equal(row.status, 'ambiguous');
  assert.equal(row.reasonCode, BOM_ENRICH_CODES.AMBIGUOUS);
  assert.match(row.provenance.note, /互相矛盾/);
  assert.equal(row.provenance.candidates.length, 2);
});

test('过期：超过有效期的证据按 unknown 输出，原始价格只留在 provenance.observed 供人工核对', () => {
  const report = enrichBomRows({
    rows: [{ designator: 'R2', lcsc: 'C25804', quantity: 10 }],
    evidence: [lcscExport({ price: 0.5, fetchedAt: at(25) })],
    now: NOW,
  });

  const [row] = report.rows;
  assert.equal(row.status, 'stale');
  assert.equal(row.reasonCode, BOM_ENRICH_CODES.STALE);
  assert.equal(row.price, null, '过期价格不得进入主字段');
  assert.equal(row.stock, null);
  assert.equal(row.currency, null);
  assert.equal(row.provenance.stale, true);
  assert.equal(row.provenance.fetchedAt, at(25));
  assert.equal(row.provenance.ageMs, 25 * HOUR);
  assert.deepEqual(row.provenance.observed, { price: 0.5, stock: 152000, currency: 'CNY' });
  assert.match(row.provenance.note, /已过期/);
  assert.equal(report.totals.knownCost, null);
  assert.equal(report.totals.costComplete, false);
});

test('过期：缺 fetchedAt 或时间在未来（无法确认新鲜度）都 fail-closed 成 BOM_STALE', () => {
  const withoutTimestamp = enrichBomRows({
    rows: [{ designator: 'R3', lcsc: 'C25804', quantity: 1 }],
    evidence: [lcscExport({ fetchedAt: undefined })],
    now: NOW,
  });
  assert.equal(withoutTimestamp.rows[0].status, 'stale');
  assert.equal(withoutTimestamp.rows[0].reasonCode, BOM_ENRICH_CODES.STALE);
  assert.equal(withoutTimestamp.rows[0].provenance.stale, true);
  assert.equal(withoutTimestamp.rows[0].provenance.ageMs, null);
  assert.match(withoutTimestamp.rows[0].provenance.note, /fetchedAt/);

  const futureTimestamp = enrichBomRows({
    rows: [{ designator: 'R4', lcsc: 'C25804', quantity: 1 }],
    evidence: [lcscExport({ fetchedAt: new Date(NOW + HOUR).toISOString() })],
    now: NOW,
  });
  assert.equal(futureTimestamp.rows[0].status, 'stale');
  assert.match(futureTimestamp.rows[0].provenance.note, /晚于当前时间/);
});

test('确定性：同输入同输出，且与证据数组顺序无关', () => {
  const rows = [
    { designator: 'U2', mpn: 'LM358DR', quantity: 5 },
    { designator: 'R1', lcsc: 'C25804', quantity: 100 },
    { designator: 'R9', mpn: 'NOPE-123', quantity: 1 },
  ];
  const evidence = [
    lcscExport({ partNumber: 'C22222', mpn: 'LM358DR', price: 0.9 }),
    lcscExport({ partNumber: 'C11111', mpn: 'LM358DR', price: 0.8 }),
    lcscExport(),
  ];
  const first = enrichBomRows({ rows, evidence, now: NOW });
  const second = enrichBomRows({ rows, evidence, now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));

  const reversed = enrichBomRows({ rows, evidence: [...evidence].reverse(), now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(reversed)), '证据顺序不得影响输出');
  assert.deepEqual(reversed.rows[0].provenance.candidates.map((candidate) => candidate.partNumber), ['C11111', 'C22222']);
});

test('无效证据条目被如实拒绝，不会污染其余有效证据', () => {
  const report = enrichBomRows({
    rows: [{ designator: 'R5', lcsc: 'C1', quantity: 1 }],
    evidence: [
      null,
      { source: '', partNumber: 'C1', price: 1 },
      { source: 'manual-evidence', partNumber: 'C1', mpn: 'X', price: 1, stock: 5, currency: 'CNY', fetchedAt: at(1) },
    ],
    now: NOW,
  });
  assert.equal(report.evidence.provided, 3);
  assert.equal(report.evidence.accepted, 1);
  assert.equal(report.evidence.rejected, 2);
  assert.equal(report.evidence.rejectedDetails.length, 2);
  assert.match(report.evidence.rejectedDetails.map((item) => item.reason).join('；'), /不是对象/);
  assert.match(report.evidence.rejectedDetails.map((item) => item.reason).join('；'), /缺少 source/);
  assert.equal(report.rows[0].status, 'matched');
  assert.equal(report.rows[0].provenance.source, 'manual-evidence');
});

test('边界输入：空 BOM 不给 0 元、缺编号按缺失、非法参数 fail-closed、负有效期回退默认值', () => {
  const empty = enrichBomRows({ rows: [], evidence: [], now: NOW });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.counts.total, 0);
  assert.equal(empty.totals.knownCost, null);
  assert.equal(empty.totals.currency, null);
  assert.equal(empty.totals.costComplete, false);
  assert.match(empty.totals.notes.join('；'), /BOM 为空/);

  const invalidEvidence = enrichBomRows({ rows: [{ mpn: 'X', quantity: 1 }], evidence: { foo: 1 }, now: NOW });
  assert.equal(invalidEvidence.evidence.accepted, 0);
  assert.equal(invalidEvidence.evidence.rejected, 1);
  assert.equal(invalidEvidence.rows[0].status, 'missing');

  const noIdentity = enrichBomRows({
    rows: [{ designator: 'J1', value: '连接器', quantity: 1 }, null],
    evidence: [],
    now: NOW,
  });
  assert.equal(noIdentity.rows[0].status, 'missing');
  assert.match(noIdentity.rows[0].provenance.note, /缺少 mpn\/lcsc/);
  assert.equal(noIdentity.rows[1].status, 'missing');
  assert.match(noIdentity.rows[1].provenance.note, /不是对象/);

  assert.throws(() => enrichBomRows(), (error) => error.code === BOM_ENRICH_CODES.INPUT_INVALID);
  assert.throws(() => enrichBomRows({ rows: 'not-an-array' }), (error) => error.code === BOM_ENRICH_CODES.INPUT_INVALID);
  assert.throws(() => enrichBomRows({ rows: [], now: Number.NaN }), (error) => error.code === BOM_ENRICH_CODES.INPUT_INVALID);

  const fallback = enrichBomRows({ rows: [], evidence: [], now: NOW, maxAgeMs: -1 });
  assert.equal(fallback.maxAgeMs, DEFAULT_BOM_EVIDENCE_MAX_AGE_MS);
});

test('库存 0 保留为 0（不是 unknown）；有价格但缺币种不能计入费用合计', () => {
  const report = enrichBomRows({
    rows: [
      { designator: 'R6', lcsc: 'C7001', quantity: 4 },
      { designator: 'R7', lcsc: 'C7002', quantity: 4 },
    ],
    evidence: [
      lcscExport({ partNumber: 'C7001', mpn: null, price: 2.5, stock: 0, currency: null, fetchedAt: at(1) }),
      lcscExport({ partNumber: 'C7002', mpn: null, price: 0.25, stock: 0, currency: 'CNY', fetchedAt: at(1) }),
    ],
    now: NOW,
  });

  assert.equal(report.rows[0].status, 'matched');
  assert.equal(report.rows[0].stock, 0, '库存 0 是有效证据，不是 null');
  assert.equal(report.rows[0].currency, null);
  assert.match(report.rows[0].provenance.note, /缺少币种/);
  assert.equal(report.rows[1].status, 'matched');
  assert.equal(report.rows[1].stock, 0);

  // 缺币种的行无法计入费用：withTrustedPrice 只算 1 行，汇总仍不完整。
  assert.equal(report.counts.withTrustedPrice, 1);
  assert.equal(report.totals.unknownCostRows, 1);
  assert.equal(report.totals.costComplete, false);
  assert.equal(report.totals.knownCost, 1);
  assert.equal(report.totals.currency, 'CNY');
});

test('JSON 证据文件：数组 / {entries} 都能加载；不可读或非 JSON 抛 BOM_EVIDENCE_FILE_INVALID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bom-enrich-'));
  try {
    const arrayFile = join(dir, 'lcsc-export.json');
    await writeFile(arrayFile, JSON.stringify([lcscExport()]), 'utf8');
    const loaded = await loadBomEvidenceFile(arrayFile);
    assert.equal(loaded.path, arrayFile);
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.rejected.length, 0);

    const enrichedFromFile = enrichBomRows({
      rows: [{ designator: 'R1', lcsc: 'C25804', quantity: 10 }],
      evidence: loaded,
      now: NOW,
    });
    assert.equal(enrichedFromFile.rows[0].status, 'matched');
    assert.equal(enrichedFromFile.rows[0].price, 0.0125);

    const wrappedFile = join(dir, 'wrapped.json');
    await writeFile(wrappedFile, JSON.stringify({ entries: [lcscExport({ partNumber: 'C8734', mpn: 'STM32F103C8T6' })] }), 'utf8');
    const wrapped = await loadBomEvidenceFile(wrappedFile);
    assert.equal(wrapped.entries.length, 1);

    const brokenFile = join(dir, 'broken.json');
    await writeFile(brokenFile, '{oops', 'utf8');
    await assert.rejects(loadBomEvidenceFile(brokenFile), (error) => error.code === BOM_ENRICH_CODES.EVIDENCE_FILE_INVALID);

    const missingFile = join(dir, 'missing.json');
    await assert.rejects(loadBomEvidenceFile(missingFile), (error) => error.code === BOM_ENRICH_CODES.EVIDENCE_FILE_INVALID);
    await assert.rejects(loadBomEvidenceFile(''), (error) => error.code === BOM_ENRICH_CODES.EVIDENCE_FILE_INVALID);

    assert.deepEqual(normalizeBomEvidence(null).entries, []);
    assert.equal(normalizeBomEvidence(undefined).rejected.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('模块边界：不联网、不接 server.mjs（纯本地适配器）', async () => {
  const source = await readFile(new URL('../bom-enrich.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['node:fs/promises'], '只允许本地文件读取，不得引入网络模块');
  assert.doesNotMatch(source, /(?<![\w.])fetch\s*\(/);
  assert.doesNotMatch(source, /node:(?:http|https|net|tls|dns)/);
  assert.doesNotMatch(source, /from\s+['"][^'"]*server\.mjs['"]/, '不得接入 server.mjs（本任务只交付适配器）');
});
