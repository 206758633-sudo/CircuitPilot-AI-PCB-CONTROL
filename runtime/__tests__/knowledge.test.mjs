import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  KNOWLEDGE_CODES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_REVIEW_STATES,
  KNOWLEDGE_TRUST_LEVELS,
  createKnowledgeStore,
} from '../knowledge.mjs';

const PART_PAYLOAD = Object.freeze({ lcscId: 'C1525', mpn: 'CC0603KRX7R9BB104', value: '100nF', footprint: '0603', pins: ['1', '2'] });
const partPayload = (overrides = {}) => ({ ...PART_PAYLOAD, ...overrides });
const partProvenance = (overrides = {}) => ({
  source: '立创商城',
  url: 'https://item.szlcsc.com/1525.html',
  version: '2026-10-01',
  fetchedAt: '2026-10-01T00:00:00.000Z',
  collector: 'supply',
  ...overrides,
});

const makeStore = (options = {}) => createKnowledgeStore({ root: mkdtempSync(join(tmpdir(), 'cp-knowledge-')), ...options });

const savePart = (store, { payload = {}, title = '0603 100nF 贴片电容', trust = 'authoritative', provenance = {}, ...rest } = {}) => store.save({
  kind: 'part',
  title,
  payload: partPayload(payload),
  provenance: partProvenance(provenance),
  trust,
  ...rest,
});

const jsonFiles = (dir) => readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => join(dir, name));

test('save/get roundtrip：条目落盘带 digest，可原样读回且无临时文件残留', () => {
  const store = makeStore();
  const { entry, created } = savePart(store);
  assert.equal(created, true);
  assert.match(entry.id, /^kn-part-[a-f0-9]{16}$/);
  assert.match(entry.digest, /^[a-f0-9]{64}$/);
  assert.equal(entry.kind, 'part');
  assert.equal(entry.review.state, 'candidate');
  assert.equal(entry.createdAt, entry.updatedAt);

  const file = join(store.root, 'part', `${entry.id}-${entry.digest.slice(0, 8)}.json`);
  assert.ok(existsSync(file), '文件必须落在 root/<kind>/<id>-<digest前8>.json');
  assert.deepEqual(readdirSync(join(store.root, 'part')).filter((name) => name.startsWith('.tmp-')), []);

  const loaded = store.get(entry.id);
  assert.equal(loaded.digest, entry.digest);
  assert.deepEqual(loaded.payload, partPayload());
  assert.equal(loaded.provenance.source, '立创商城');
  assert.equal(loaded.provenance.collector, 'supply');
  assert.equal(loaded.trust, 'authoritative');
  assert.equal(loaded.expired, false);

  assert.equal(store.get('kn-part-0123456789abcdef'), null, '不存在的条目返回 null 而不是抛错');
  assert.throws(() => store.get('  '), (error) => error.code === KNOWLEDGE_CODES.ID_REQUIRED);
});

test('重复 fingerprint 只更新元数据：不新增条目、保留 createdAt 与已 approved 的审核状态', () => {
  const store = makeStore();
  const first = savePart(store).entry;
  store.review(first.id, { state: 'approved', reviewedBy: 'alice' });

  const second = savePart(store, { title: '0603 100nF（补充标题）', trust: 'reference' });
  assert.equal(second.created, false);
  assert.equal(second.entry.id, first.id);
  assert.equal(second.entry.createdAt, first.createdAt);
  assert.ok(Date.parse(second.entry.updatedAt) >= Date.parse(first.updatedAt));
  assert.equal(second.entry.title, '0603 100nF（补充标题）');
  assert.equal(second.entry.trust, 'reference');
  assert.equal(second.entry.review.state, 'approved', 'payload 未变时审核状态不得被打回 candidate');

  assert.equal(store.list({ kind: 'part' }).length, 1, '重复保存不得新增条目');
  assert.equal(jsonFiles(join(store.root, 'part')).length, 1, '更新后旧文件必须被清理');
  assert.equal(store.get(first.id).digest, second.entry.digest);
});

test('同一 entityKey 的 payload 变化产生新版本：review 重置 candidate，旧版本仍可取回', () => {
  const store = makeStore();
  const v1 = savePart(store).entry;
  store.review(v1.id, { state: 'approved', reviewedBy: 'alice' });

  const v2 = savePart(store, { payload: { footprint: '0805' }, title: '0805 版本' });
  assert.equal(v2.created, true);
  assert.notEqual(v2.entry.id, v1.id);
  assert.equal(v2.entry.review.state, 'candidate', 'payload 变化的版本必须重新审核');
  assert.equal(store.get(v1.id).review.state, 'approved', '旧版本审核状态不受影响');

  const versions = store.query({ entityKey: 'C1525' });
  assert.equal(versions.length, 2, '同 entityKey 的不同版本都要能取回');
  assert.deepEqual(versions.map((item) => item.id).sort(), [v1.id, v2.entry.id].sort());

  const files = jsonFiles(join(store.root, 'part'));
  assert.equal(files.length, 2);
  // 文件名里的 digest 是"最后写入"的 digest（v1 审核后 digest 会变），所以用当前读回值比对
  for (const entry of [store.get(v1.id), store.get(v2.entry.id)]) {
    assert.ok(files.some((file) => file.endsWith(`${entry.id}-${entry.digest.slice(0, 8)}.json`)));
  }
});

test('query：text 在 title/payload 中不区分大小写匹配，entityKey 与 kind 精确过滤', () => {
  const store = makeStore();
  savePart(store, {
    payload: { lcscId: 'C1001', mpn: 'USB-C-16P', value: '16P', footprint: 'SMD', pins: [] },
    title: 'USB-C Connector 16P',
  });
  savePart(store, {
    payload: { lcscId: 'C2002', mpn: 'AMS1117-3.3', value: '3.3V', footprint: 'SOT-223', pins: [] },
    title: 'LDO 稳压器',
  });
  store.save({
    kind: 'rule',
    title: '最小走线宽度',
    payload: { ruleId: 'R-CLEARANCE-1', statement: '信号线 >= 6mil' },
    provenance: { source: '内部规范' },
    trust: 'authoritative',
  });

  assert.equal(store.query({ text: 'usb-c' }).length, 1, 'title 匹配不区分大小写');
  assert.equal(store.query({ text: 'usb-c' })[0].payload.lcscId, 'C1001');
  assert.equal(store.query({ text: 'ams1117' })[0].payload.lcscId, 'C2002', 'payload JSON 也要参与文本匹配');
  assert.equal(store.query({ text: '稳压' }).length, 1);
  assert.equal(store.query({ text: '完全不存在的关键词' }).length, 0);

  assert.equal(store.query({ kind: 'rule' }).length, 1);
  assert.equal(store.query({ entityKey: 'C2002' }).length, 1);
  assert.equal(store.query({ entityKey: 'C2002' })[0].title, 'LDO 稳压器');
  assert.equal(store.query({ entityKey: 'R-CLEARANCE-1' })[0].kind, 'rule');
  assert.equal(store.query({ kind: 'part', text: 'lcscid' }).length, 2);

  assert.throws(() => store.query({ text: '   ' }), (error) => error.code === KNOWLEDGE_CODES.QUERY_INVALID);
  assert.throws(() => store.query({ entityKey: '' }), (error) => error.code === KNOWLEDGE_CODES.QUERY_INVALID);
});

test('list：按 kind/trust/reviewState 过滤，过期条目默认排除', () => {
  let clock = new Date('2026-02-01T00:00:00.000Z');
  const store = makeStore({ now: () => clock });
  const authoritative = savePart(store).entry;
  const reference = savePart(store, { payload: { lcscId: 'C-REF' }, trust: 'reference', reviewState: 'approved' }).entry;
  savePart(store, { payload: { lcscId: 'C-OLD' }, ttlDays: 1 });
  store.save({ kind: 'rule', title: '规则', payload: { ruleId: 'R-1' }, provenance: { source: '内部规范' }, trust: 'authoritative' });

  assert.equal(store.list().length, 4);
  assert.equal(store.list({ kind: 'rule' }).length, 1);
  assert.equal(store.list({ trust: 'reference' }).length, 1);
  assert.equal(store.list({ reviewState: 'approved' }).length, 1);
  assert.equal(store.list({ trust: 'reference' })[0].id, reference.id);
  assert.ok(store.list().some((entry) => entry.id === authoritative.id));

  clock = new Date('2026-02-03T00:00:00.000Z');
  assert.equal(store.list().length, 3, '过期条目默认排除');
  assert.equal(store.list({ includeExpired: true }).length, 4);
  assert.throws(() => store.list({ trust: 'official' }), (error) => error.code === KNOWLEDGE_CODES.TRUST_INVALID);
  assert.throws(() => store.list({ kind: 'nope' }), (error) => error.code === KNOWLEDGE_CODES.KIND_INVALID);
});

test('TTL：默认排除过期条目，includeExpired 保留并标 expired:true，过期后不再允许进 gate', () => {
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const store = makeStore({ now: () => clock });
  const { entry } = savePart(store, { ttlDays: 2 });
  store.review(entry.id, { state: 'approved', reviewedBy: 'alice' });

  assert.equal(store.list({ kind: 'part' }).length, 1);
  assert.equal(store.list({ kind: 'part' })[0].expired, false);
  assert.equal(store.isUsableForGate(store.get(entry.id)), true);

  clock = new Date('2026-01-02T23:59:59.000Z');
  assert.equal(store.list({ kind: 'part' }).length, 1, '未超过 ttlDays 不算过期');

  clock = new Date('2026-01-03T00:00:01.000Z');
  assert.equal(store.list({ kind: 'part' }).length, 0);
  assert.equal(store.query({ text: '电容' }).length, 0);
  const retained = store.list({ kind: 'part', includeExpired: true });
  assert.equal(retained.length, 1);
  assert.equal(retained[0].expired, true);
  assert.equal(store.query({ text: '电容', includeExpired: true }).length, 1);
  assert.equal(store.get(entry.id).expired, true, 'get 也要如实标出 expired');
  assert.equal(store.isUsableForGate(store.get(entry.id)), false, '过期条目不允许进放行判定');

  // 没有 ttlDays 的条目视为不过期
  const durable = savePart(store, { payload: { lcscId: 'C-DURABLE' } }).entry;
  clock = new Date('2030-01-01T00:00:00.000Z');
  assert.ok(store.get(durable.id));
  assert.equal(store.list({ kind: 'part' }).length, 1);
});

test('review 状态机与 isUsableForGate：approved 不得改回 candidate，trust/审核/过期缺一不可', () => {
  const store = makeStore();
  const { entry } = savePart(store);
  assert.throws(() => store.review(entry.id, { state: 'candidate' }), (error) => error.code === KNOWLEDGE_CODES.REVIEW_INVALID);

  const approved = store.review(entry.id, { state: 'approved', reviewedBy: 'alice' });
  assert.equal(approved.review.state, 'approved');
  assert.equal(approved.review.reviewedBy, 'alice');
  assert.ok(approved.review.reviewedAt);
  assert.equal(store.isUsableForGate(approved), true);

  const rejected = store.review(entry.id, { state: 'rejected', reviewedBy: 'bob' });
  assert.equal(rejected.review.state, 'rejected');
  assert.equal(store.isUsableForGate(rejected), false);
  const reapproved = store.review(entry.id, { state: 'approved', reviewedBy: 'carol' });
  assert.equal(reapproved.review.state, 'approved', 'rejected 允许重新审核');

  assert.throws(() => store.review('kn-part-0000000000000000', { state: 'approved' }), (error) => error.code === KNOWLEDGE_CODES.NOT_FOUND);
  assert.throws(() => store.review(entry.id, { state: 'approved', reviewedBy: '   ' }), (error) => error.code === KNOWLEDGE_CODES.REVIEW_INVALID);

  // 三个准入条件：trust 非 unverified、review approved、未过期
  const unverified = savePart(store, { payload: { lcscId: 'C-UNVERIFIED' }, trust: 'unverified', reviewState: 'approved' }).entry;
  assert.equal(store.isUsableForGate(unverified), false);
  const reference = savePart(store, { payload: { lcscId: 'C-REFERENCE' }, trust: 'reference', reviewState: 'approved' }).entry;
  assert.equal(store.isUsableForGate(reference), true);
  const candidate = savePart(store, { payload: { lcscId: 'C-CANDIDATE' } }).entry;
  assert.equal(store.isUsableForGate(candidate), false);
  assert.equal(store.isUsableForGate(null), false);
});

test('detectConflicts：同 entityKey 下 approved 条目关键字段不一致即冲突，candidate/rejected 不参与', () => {
  const store = makeStore();
  const left = savePart(store, { payload: { footprint: '0603', mpn: 'CAP-A' }, reviewState: 'approved' }).entry;
  const right = savePart(store, { payload: { footprint: '0805', mpn: 'CAP-A' }, reviewState: 'approved' }).entry;
  savePart(store, { payload: { footprint: '1206' } }); // candidate：不参与冲突结论

  const result = store.detectConflicts({ entityKey: 'C1525' });
  assert.equal(result.entityKey, 'C1525');
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].field, 'footprint');
  assert.deepEqual(result.conflicts[0].values.map((item) => item.id).sort(), [left.id, right.id].sort());
  assert.deepEqual(result.conflicts[0].values.map((item) => item.value).sort(), ['0603', '0805']);
  assert.deepEqual(store.detectConflicts({ entityKey: 'C-UNKNOWN' }), { entityKey: 'C-UNKNOWN', conflicts: [] });

  store.review(right.id, { state: 'rejected', reviewedBy: 'alice' });
  assert.deepEqual(store.detectConflicts({ entityKey: 'C1525' }), { entityKey: 'C1525', conflicts: [] }, '撤销一条后冲突消失');
  assert.throws(() => store.detectConflicts({}), (error) => error.code === KNOWLEDGE_CODES.KEY_MISSING);
});

test('损坏文件 fail-closed：非法 JSON / digest 被篡改 / schema 不符都抛 KNOWLEDGE_CORRUPT', () => {
  const store = makeStore();
  const { entry } = savePart(store);
  const file = join(store.root, 'part', `${entry.id}-${entry.digest.slice(0, 8)}.json`);

  // 1) 非法 JSON
  const brokenJson = join(store.root, 'part', 'broken.json');
  writeFileSync(brokenJson, '{not json', 'utf8');
  assert.throws(() => store.list({ kind: 'part' }), (error) => error.code === KNOWLEDGE_CODES.CORRUPT);
  assert.throws(() => store.query({ text: '电容' }), (error) => error.code === KNOWLEDGE_CODES.CORRUPT);
  rmSync(brokenJson);

  // 2) 合法 JSON 但内容被改、digest 对不上
  const tampered = JSON.parse(readFileSync(file, 'utf8'));
  tampered.payload.footprint = '0805';
  writeFileSync(file, JSON.stringify(tampered), 'utf8');
  assert.throws(() => store.list({ kind: 'part' }), (error) => error.code === KNOWLEDGE_CODES.CORRUPT);
  assert.throws(() => store.get(entry.id), (error) => error.code === KNOWLEDGE_CODES.CORRUPT);

  // 3) schema 不符（缺 digest）
  writeFileSync(join(store.root, 'part', 'no-digest.json'), JSON.stringify({ id: entry.id, kind: 'part', title: 'x' }), 'utf8');
  assert.throws(() => store.list({ kind: 'part' }), (error) => error.code === KNOWLEDGE_CODES.CORRUPT);
});

test('usage 记录：append 到 usage.jsonl，可按条目读回，非法记录与损坏行都拒绝', () => {
  const store = makeStore();
  const { entry } = savePart(store);
  const first = store.recordUsage({ id: entry.id, agent: 'librarian', outcome: 'used', note: 'BOM 补全引用' });
  assert.equal(first.id, entry.id);
  assert.equal(first.outcome, 'used');
  assert.ok(first.at);
  store.recordUsage({ id: entry.id, agent: 'auditor', outcome: 'overturned' });
  store.recordUsage({ id: 'kn-part-abcdefabcdefabcd', agent: 'librarian', outcome: 'used' });

  assert.ok(existsSync(join(store.root, 'usage.jsonl')));
  const usages = store.listUsages({ id: entry.id });
  assert.equal(usages.length, 2);
  assert.deepEqual(usages.map((item) => item.outcome), ['used', 'overturned']);
  assert.equal(usages[0].note, 'BOM 补全引用');
  assert.equal(store.listUsages({ id: 'kn-part-0000000000000000' }).length, 0);

  assert.throws(() => store.recordUsage({ id: entry.id, agent: 'x', outcome: 'ignored' }), (error) => error.code === KNOWLEDGE_CODES.USAGE_INVALID);
  assert.throws(() => store.recordUsage({ id: entry.id, outcome: 'used' }), (error) => error.code === KNOWLEDGE_CODES.USAGE_INVALID);
  assert.throws(() => store.recordUsage({ agent: 'x', outcome: 'used' }), (error) => error.code === KNOWLEDGE_CODES.ID_REQUIRED);

  // 使用记录损坏 fail-closed
  writeFileSync(join(store.root, 'usage.jsonl'), '{"id":"x"}\n', 'utf8');
  assert.throws(() => store.listUsages({ id: entry.id }), (error) => error.code === KNOWLEDGE_CODES.CORRUPT);
});

test('save 校验：kind/trust/provenance.source/payload/title/ttlDays/entityKey 全部 fail-closed', () => {
  const store = makeStore();
  const base = { title: '测试条目', payload: partPayload(), provenance: partProvenance(), trust: 'authoritative' };
  assert.throws(() => store.save({ ...base, kind: 'nope' }), (error) => error.code === KNOWLEDGE_CODES.KIND_INVALID);
  assert.throws(() => store.save({ ...base, kind: 'part', trust: 'official' }), (error) => error.code === KNOWLEDGE_CODES.TRUST_INVALID);
  assert.throws(() => store.save({ ...base, kind: 'part', provenance: {} }), (error) => error.code === KNOWLEDGE_CODES.PROVENANCE_INVALID);
  assert.throws(() => store.save({ ...base, kind: 'part', provenance: { source: '   ' } }), (error) => error.code === KNOWLEDGE_CODES.PROVENANCE_INVALID);
  assert.throws(() => store.save({ ...base, kind: 'part', payload: null }), (error) => error.code === KNOWLEDGE_CODES.PAYLOAD_INVALID);
  assert.throws(() => store.save({ ...base, kind: 'part', payload: [] }), (error) => error.code === KNOWLEDGE_CODES.PAYLOAD_INVALID);
  assert.throws(() => store.save({ ...base, kind: 'part', title: '   ' }), (error) => error.code === KNOWLEDGE_CODES.TITLE_INVALID);
  assert.throws(() => store.save({ ...base, kind: 'part', ttlDays: -1 }), (error) => error.code === KNOWLEDGE_CODES.TTL_INVALID);
  assert.throws(() => store.save({ ...base, kind: 'part', ttlDays: '7' }), (error) => error.code === KNOWLEDGE_CODES.TTL_INVALID);
  assert.throws(() => store.save({ ...base, kind: 'part', reviewState: 'pending' }), (error) => error.code === KNOWLEDGE_CODES.REVIEW_INVALID);

  // entityKey 缺失（四类各自规则）
  assert.throws(() => store.save({ ...base, kind: 'part', payload: { title: '无标识' } }), (error) => error.code === KNOWLEDGE_CODES.KEY_MISSING);
  assert.throws(() => store.save({ ...base, kind: 'module', payload: {} }), (error) => error.code === KNOWLEDGE_CODES.KEY_MISSING);
  assert.throws(() => store.save({ ...base, kind: 'rule', payload: { expression: 'x' } }), (error) => error.code === KNOWLEDGE_CODES.KEY_MISSING);
  assert.throws(() => store.save({ ...base, kind: 'failure', payload: { note: 'x' } }), (error) => error.code === KNOWLEDGE_CODES.KEY_MISSING);
  assert.throws(() => createKnowledgeStore({}), (error) => error.code === KNOWLEDGE_CODES.ROOT_REQUIRED);

  // part 的 value+footprint 兜底规则
  const { entry } = store.save({ ...base, kind: 'part', payload: { value: '10k', footprint: '0402' }, title: '10k 0402' });
  assert.deepEqual(store.query({ entityKey: '10k|0402' }).map((item) => item.id), [entry.id]);

  // module/rule/failure 正常落盘（确认三类 entityKey 生效）
  const module = store.save({ ...base, kind: 'module', payload: { moduleId: 'M-USB-PD', name: 'USB PD 供电模块' }, title: 'USB PD 模块' }).entry;
  const rule = store.save({ ...base, kind: 'rule', payload: { ruleId: 'R-DFM-1', text: '阻焊开窗 >= 0.1mm' }, title: '阻焊开窗规则' }).entry;
  const failure = store.save({ ...base, kind: 'failure', payload: { failureId: 'F-OPEN-1', symptom: '回流后开路' }, title: '回流开路' }).entry;
  assert.deepEqual(store.query({ entityKey: 'M-USB-PD' }).map((item) => item.id), [module.id]);
  assert.deepEqual(store.query({ entityKey: 'R-DFM-1' }).map((item) => item.id), [rule.id]);
  assert.deepEqual(store.query({ entityKey: 'F-OPEN-1' }).map((item) => item.id), [failure.id]);
});

test('导出常量：kind/trust/review 集合与错误码齐全且冻结', () => {
  assert.deepEqual(KNOWLEDGE_KINDS, ['part', 'module', 'rule', 'failure']);
  assert.deepEqual(KNOWLEDGE_TRUST_LEVELS, ['authoritative', 'reference', 'unverified']);
  assert.deepEqual(KNOWLEDGE_REVIEW_STATES, ['candidate', 'approved', 'rejected']);
  assert.equal(KNOWLEDGE_CODES.KEY_MISSING, 'KNOWLEDGE_KEY_MISSING');
  assert.equal(KNOWLEDGE_CODES.REVIEW_INVALID, 'KNOWLEDGE_REVIEW_INVALID');
  assert.equal(KNOWLEDGE_CODES.CORRUPT, 'KNOWLEDGE_CORRUPT');
  assert.equal(typeof createKnowledgeStore, 'function');
  assert.ok(Object.isFrozen(KNOWLEDGE_CODES));
  assert.ok(Object.isFrozen(KNOWLEDGE_KINDS));
});
