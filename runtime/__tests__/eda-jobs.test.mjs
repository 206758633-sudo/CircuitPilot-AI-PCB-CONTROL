import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createFileJournal } from '../engineering/eda-job-journal.mjs';
import { EdaJobStore, JOB_ITEM_CAP, capJournalResult, cancelJobCode, createMemoryJournal, isJobId, listJobsCode, normalizeJobSnapshot, pollJobCode, sessionCode, startJobCode, waitForEdaJob } from '../engineering/eda-jobs.mjs';

const JOB_ID = '11111111-2222-3333-4444-555555555555';

/**
 * 在进程内真实执行注入代码。
 *
 * 必须与桥接服务端**完全同构**：生成的源码是一段**函数体**（里面自带 return），
 * 不是表达式。这里以前写成 `return ${code}`（表达式语义），于是"最外层漏写 return"的
 * 命令照样能通过测试，却在真机上把返回值丢掉（result:null / 任务误判丢失）。
 */
function runInEda(code, eda = {}) {
  return new Function('eda', code)(eda);
}

test('jobId 必须是 UUID，非法 id 在客户端就被拒', () => {
  assert.equal(isJobId(JOB_ID), true);
  assert.equal(isJobId('not-a-uuid'), false);
  assert.equal(isJobId(undefined), false);
  assert.throws(() => startJobCode({ jobId: 'x', label: 'l', expression: 'Promise.resolve(1)' }), { code: 'EDA_JOB_ID_INVALID' });
  assert.throws(() => pollJobCode({ jobId: 'x' }), { code: 'EDA_JOB_ID_INVALID' });
  assert.throws(() => startJobCode({ jobId: JOB_ID, label: 'l', expression: '' }), { code: 'EDA_JOB_EXPRESSION_INVALID' });
});

test('后台任务端到端：start 立刻返回，任务在渲染进程里继续跑，poll 拿到结果信封', async () => {
  let resolveDrc;
  const eda = { pcb_Drc: { check: () => new Promise((resolve) => { resolveDrc = resolve; }) } };
  const started = runInEda(startJobCode({ jobId: JOB_ID, label: '官方PCB DRC', expression: 'eda.pcb_Drc.check(true,false,true)' }), eda);
  // 表达式在微任务里才求值，等一拍再取 resolve 句柄。
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 关键点：start 不等待结果，立即返回。慢任务不再占用 HTTP 请求。
  assert.deepEqual({ jobId: started.jobId, accepted: started.accepted, state: started.state }, { jobId: JOB_ID, accepted: true, state: 'running' });
  assert.equal(runInEda(pollJobCode({ jobId: JOB_ID }), eda).state, 'running');
  resolveDrc([{ code: 'DRC-1' }, { code: 'DRC-2' }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const done = runInEda(pollJobCode({ jobId: JOB_ID }), eda);
  assert.equal(done.state, 'done');
  assert.equal(done.result.kind, 'array');
  assert.equal(done.result.count, 2);
  assert.deepEqual(done.result.items, [{ code: 'DRC-1' }, { code: 'DRC-2' }]);
  assert.equal(done.result.truncated, false);
});

test('大结果集会截断但要如实保留总数（不能因为截断把“有错”说成“没结果”）', async () => {
  const findings = Array.from({ length: JOB_ITEM_CAP + 37 }, (_, index) => ({ code: `D${index}` }));
  const eda = { pcb_Drc: { check: async () => findings } };
  runInEda(startJobCode({ jobId: JOB_ID, label: 'drc', expression: 'eda.pcb_Drc.check(true,false,true)' }), eda);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const done = runInEda(pollJobCode({ jobId: JOB_ID }), eda);
  assert.equal(done.result.count, JOB_ITEM_CAP + 37);
  assert.equal(done.result.items.length, JOB_ITEM_CAP);
  assert.equal(done.result.truncated, true);
});

test('任务抛错会记成 error 状态，并保留错误信息（不会伪装成“无问题”）', async () => {
  const eda = { pcb_Drc: { check: async () => { throw new Error('EDA renderer crashed'); } } };
  runInEda(startJobCode({ jobId: JOB_ID, label: 'drc', expression: 'eda.pcb_Drc.check(true,false,true)' }), eda);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const snapshot = runInEda(pollJobCode({ jobId: JOB_ID }), eda);
  assert.equal(snapshot.state, 'error');
  assert.match(snapshot.error, /EDA renderer crashed/);
  assert.equal(snapshot.result, null);
});


test('任务状态权威在运行时：渲染进程换会话时，在途任务被如实收口为 interrupted（不是 done、不是 0 项）', () => {
  const store = new EdaJobStore({ now: () => 1000 });
  store.create({ jobId: JOB_ID, label: '官方PCB DRC', kind: 'pcb.drc' });
  store.dispatched({ jobId: JOB_ID, epoch: 'epoch-A' });
  const sameEpoch = store.observeEpoch('epoch-A');
  assert.equal(sameEpoch.changed, false);
  assert.deepEqual(sameEpoch.interrupted, []);
  const switchOver = store.observeEpoch('epoch-B');
  assert.equal(switchOver.changed, true);
  assert.deepEqual(switchOver.interrupted, [JOB_ID]);
  assert.equal(store.get(JOB_ID).state, 'interrupted');
  assert.match(store.get(JOB_ID).error.message, /epoch-A → epoch-B/);
  // 关键：快照即使说 done，也不能把 interrupted 洗白
  store.applySnapshot({ jobId: JOB_ID, state: 'done', result: { kind: 'array', count: 0, items: [] } });
  assert.equal(store.get(JOB_ID).state, 'interrupted');
});


test('journal 落盘后重启进程：在途任务变成 interrupted，已完成任务连结果一起保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-jobs-'));
  const file = join(dir, 'jobs.jsonl');
  const journal = createFileJournal(file);
  const store = new EdaJobStore({ journal, now: () => 1000 });
  const doneId = '11111111-2222-3333-4444-555555555555';
  const inflightId = '22222222-3333-4444-5555-666666666666';
  store.create({ jobId: doneId, label: 'done', kind: 'pcb.drc' });
  store.dispatched({ jobId: doneId, epoch: 'epoch-A' });
  store.complete({ jobId: doneId, result: { kind: 'array', count: 156, items: [], truncated: false } });
  store.create({ jobId: inflightId, label: 'inflight', kind: 'pcb.drc' });
  store.dispatched({ jobId: inflightId, epoch: 'epoch-A' });
  // 模拟“进程被杀”：直接新建一个 store 从同一个 journal 恢复
  const { store: recovered, interrupted } = EdaJobStore.recover({ journal: createFileJournal(file) });
  assert.deepEqual(interrupted, [inflightId]);
  assert.equal(recovered.get(doneId).state, 'done');
  assert.equal(recovered.get(doneId).result.count, 156);
  assert.equal(recovered.get(inflightId).state, 'interrupted');
});


test('journal 结果封顶：计数永远精确，明细只留一截并显式标注（避免 journal 被大清单撑爆）', () => {
  const journal = createMemoryJournal();
  const store = new EdaJobStore({ journal });
  const items = Array.from({ length: 500 }, (_, index) => ({ name: `item-${index}` }));
  store.create({ jobId: '33333333-4444-5555-6666-777777777777', label: 'big', kind: 'pcb.drc' });
  store.complete({ jobId: '33333333-4444-5555-6666-777777777777', result: { kind: 'array', count: 500, items, truncated: false } });
  const last = journal.read().at(-1);
  assert.equal(last.result.count, 500, '计数必须精确');
  assert.equal(last.result.items.length, 50);
  assert.equal(last.result.journalTruncated, true);
});


test('journal 字符预算封顶：DRC 那种"分组少但每组巨大"的结果也必须压住（真机曾写进 551KB）', () => {
  const huge = { name: 'Clearance Error', count: 73, detail: 'x'.repeat(120_000) };
  const capped = capJournalResult({ kind: 'array', count: 3, items: [huge, huge, huge], truncated: false });
  assert.equal(capped.count, 3, '计数必须保住');
  assert.equal(capped.journalTruncated, true);
  assert.ok(JSON.stringify(capped).length <= 32_768 + 512, `封顶后仍过大：${JSON.stringify(capped).length}`);
  assert.ok(capped.journalFullChars > 100_000, '要如实记录原始大小');
});

test('轮询期间渲染进程换会话 -> EDA_JOB_INTERRUPTED（绝不等到 deadline，也绝不当成完成）', async () => {
  const store = new EdaJobStore();
  store.create({ jobId: JOB_ID, label: 'l', kind: 'pcb.drc' });
  store.dispatched({ jobId: JOB_ID, epoch: 'epoch-A' });
  const replies = [
    { result: { jobId: JOB_ID, state: 'running', epoch: 'epoch-A' } },
    { result: { jobId: JOB_ID, state: 'unknown', epoch: 'epoch-B' } },
  ];
  let index = 0;
  const execute = async (commandId) => { assert.equal(commandId, 'pcb.job.poll'); return replies[Math.min(index++, replies.length - 1)]; };
  await assert.rejects(
    () => waitForEdaJob({ execute, jobId: JOB_ID, store, deadlineMs: 60_000, pollIntervalMs: 1, sleep: async () => {} }),
    (error) => error.code === 'EDA_JOB_INTERRUPTED' && error.previousEpoch === 'epoch-A' && error.epoch === 'epoch-B',
  );
  assert.equal(store.get(JOB_ID).state, 'interrupted');
});

test('运行时重启后从 journal 恢复：已完成的保留结果，在途的收口为 interrupted', () => {
  const journal = createMemoryJournal();
  const first = new EdaJobStore({ journal, now: () => 500 });
  first.create({ jobId: JOB_ID, label: 'done job', kind: 'pcb.drc' });
  first.dispatched({ jobId: JOB_ID, epoch: 'epoch-A' });
  first.complete({ jobId: JOB_ID, result: { kind: 'array', count: 156, items: [], truncated: false } });
  const secondId = '22222222-3333-4444-5555-666666666666';
  first.create({ jobId: secondId, label: 'inflight job', kind: 'pcb.drc' });
  first.dispatched({ jobId: secondId, epoch: 'epoch-A' });
  const { store, interrupted } = EdaJobStore.recover({ journal });
  assert.deepEqual(interrupted, [secondId]);
  assert.equal(store.get(JOB_ID).state, 'done');
  assert.equal(store.get(JOB_ID).result.count, 156, '重启不能让已完成的真相消失');
  assert.equal(store.get(secondId).state, 'interrupted');
  assert.equal(store.get(secondId).error.code, 'EDA_JOB_INTERRUPTED_BY_RESTART');
});

test('同类任务在途互斥：runningOfKind 是“不要靠重试堆积渲染进程里的活”的结构性保证', () => {
  const store = new EdaJobStore();
  assert.equal(store.runningOfKind('pcb.drc'), null);
  store.create({ jobId: JOB_ID, label: 'l', kind: 'pcb.drc' });
  assert.equal(store.runningOfKind('pcb.drc').jobId, JOB_ID);
  assert.equal(store.runningOfKind('other-kind'), null);
  store.interruptInFlight({ code: 'EDA_RENDERER_RELOADED', message: 'x' });
  assert.equal(store.runningOfKind('pcb.drc'), null, '收口之后必须能重新派发，否则会永久卡死');
});

test('epoch 探针与会话标识：渲染进程会话随重载改变（代码层已带上 epoch）', () => {
  const session = runInEda(sessionCode(), {});
  assert.equal(typeof session.epoch, 'string');
  assert.ok(session.epoch.length > 8);
  assert.equal(typeof session.startedAt, 'number');
  const again = runInEda(sessionCode(), {});
  assert.equal(again.epoch, session.epoch, '同一会话内 epoch 必须稳定');
});

test('派发未落地的占位必须回收：否则同类长任务永久 EDA_JOB_BUSY（真机 DRC 被堵死的成因）', () => {
  const store = new EdaJobStore();
  const phantom = '33333333-4444-5555-6666-777777777777';
  store.create({ jobId: phantom, label: '幽灵 DRC', kind: 'pcb.drc' });
  assert.equal(store.runningOfKind('pcb.drc').jobId, phantom, '登记后即占用（派发前就互斥）');
  // EDA 侧回 unknown：它从没收到过这个任务（例如桥未发现 / 无 EDA 窗口导致派发失败）
  store.applySnapshot({ jobId: phantom, state: 'unknown', epoch: 'epoch-A' });
  const record = store.get(phantom);
  assert.equal(record.state, 'error', '未派发的占位必须收口为 error');
  assert.equal(record.error.code, 'EDA_JOB_ABANDONED');
  assert.equal(store.runningOfKind('pcb.drc'), null, '回收后必须能重新派发，否则 DRC 通道永久卡死');
});

test('已派发任务的 unknown 快照不由 applySnapshot 收口（交给 epoch 判定 interrupted）', () => {
  const store = new EdaJobStore();
  store.create({ jobId: JOB_ID, label: 'l', kind: 'pcb.drc' });
  store.dispatched({ jobId: JOB_ID, epoch: 'epoch-A' });
  store.applySnapshot({ jobId: JOB_ID, state: 'unknown', epoch: 'epoch-B' });
  assert.equal(store.get(JOB_ID).state, 'running', '已派发的任务结果不可知，只能由 epoch/收口逻辑裁决');
});

test('未启动过的 jobId 返回 unknown，供上层判“任务已丢失”而不是“任务已完成”', () => {
  // 注册表挂在 globalThis.__circuitpilotEdaJobs 上，跨用例共享，所以这里用独立 id。
  const unknownId = '99999999-8888-7777-6666-555555555555';
  assert.equal(runInEda(pollJobCode({ jobId: unknownId })).state, 'unknown');
  const listed = runInEda(listJobsCode());
  assert.ok(Array.isArray(listed.jobs), '任务清单形如 {epoch, jobs}');
  assert.equal(typeof listed.epoch, 'string');
  const cancelled = runInEda(cancelJobCode({ jobId: unknownId }));
  assert.equal(cancelled.cancelled, false);
});


test('快照说 interrupted 时必须立刻抛 EDA_JOB_INTERRUPTED，不能拖到超时（否则错误码会误导）', async () => {
  const store = new EdaJobStore();
  store.create({ jobId: JOB_ID, label: 'l', kind: 'pcb.drc' });
  store.dispatched({ jobId: JOB_ID, epoch: 'epoch-A' });
  store.interruptInFlight({ code: 'EDA_RENDERER_RELOADED', message: '会话更换' });
  const execute = async () => ({ result: { jobId: JOB_ID, state: 'interrupted', epoch: 'epoch-B', error: { code: 'EDA_RENDERER_RELOADED' } } });
  const startedAt = Date.now();
  await assert.rejects(
    () => waitForEdaJob({ execute, jobId: JOB_ID, store, deadlineMs: 60_000, pollIntervalMs: 5, sleep: async () => {} }),
    (error) => error.code === 'EDA_JOB_INTERRUPTED' && error.polls === 1,
  );
  assert.ok(Date.now() - startedAt < 1_000, '必须立刻返回，而不是等到 deadline');
});

test('waitForEdaJob：done 返回结果，running 一直轮询', async () => {
  let polls = 0;
  const execute = async (id) => {
    assert.equal(id, 'pcb.job.poll');
    polls += 1;
    if (polls < 3) return { result: { jobId: JOB_ID, state: 'running', known: true } };
    return { result: { jobId: JOB_ID, state: 'done', known: true, result: { kind: 'array', count: 0, items: [], truncated: false } } };
  };
  const finished = await waitForEdaJob({ execute, jobId: JOB_ID, pollIntervalMs: 1, deadlineMs: 1_000 });
  assert.equal(finished.polls, 3);
  assert.equal(finished.result.count, 0);
});

test('waitForEdaJob：超时必须抛 EDA_JOB_TIMEOUT，绝不返回空数组（历史假阳性防线）', async () => {
  const execute = async () => ({ result: { jobId: JOB_ID, state: 'running', known: true } });
  await assert.rejects(
    () => waitForEdaJob({ execute, jobId: JOB_ID, pollIntervalMs: 1, deadlineMs: 6 }),
    (error) => error.code === 'EDA_JOB_TIMEOUT' && error.jobId === JOB_ID && error.polls >= 1,
  );
});

test('waitForEdaJob：任务丢失/失败/取消各自抛出可区分的错误码', async () => {
  const cases = [
    ['unknown', 'EDA_JOB_LOST'],
    ['error', 'EDA_JOB_FAILED'],
    ['cancelled', 'EDA_JOB_CANCELLED'],
  ];
  for (const [state, code] of cases) {
    const execute = async () => ({ result: { jobId: JOB_ID, state, known: true, error: state === 'error' ? 'boom' : null } });
    await assert.rejects(() => waitForEdaJob({ execute, jobId: JOB_ID, pollIntervalMs: 1, deadlineMs: 1_000 }), { code }, `state=${state} 应抛 ${code}`);
  }
});

test('normalizeJobSnapshot 兼容桥接层可能的包装形状', () => {
  assert.equal(normalizeJobSnapshot({ result: { state: 'done', result: { kind: 'array', count: 1, items: [1] } } }).result.count, 1);
  assert.equal(normalizeJobSnapshot({ data: { state: 'running', known: true } }).state, 'running');
  assert.equal(normalizeJobSnapshot(null).state, 'unknown');
});

// ---------------------------------------------------------------------------
// P2-6（2026-11-05 运行时/运维审计）：journal 轮转。
// 真机 journal 只追加不轮转已涨到 5.1MB；这里验证"写前切 .1、两代可读、坏行仍跳过、轮转失败不阻断"。
// ---------------------------------------------------------------------------

const journalRecord = (seq) => ({ jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', seq, pad: 'y'.repeat(20) });
const readJournalLines = (file) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('journal 轮转：超过注入行数阈值时写前把旧文件切成 .1，新文件从空开始，read() 两代按时间顺序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-jobs-rotate-lines-'));
  try {
    const file = join(dir, 'jobs.jsonl');
    const journal = createFileJournal(file, { maxLines: 3 });
    for (let seq = 0; seq < 3; seq += 1) journal.append(journalRecord(seq));
    assert.equal(existsSync(`${file}.1`), false, '未到阈值不应轮转');
    journal.append(journalRecord(3));
    assert.equal(existsSync(`${file}.1`), true, '第 4 条写入前应轮转出 .1');
    assert.deepEqual(readJournalLines(`${file}.1`).map((record) => record.seq), [0, 1, 2], '旧文件整体进 .1');
    assert.deepEqual(readJournalLines(file).map((record) => record.seq), [3], '新文件只留轮转之后的记录');
    assert.deepEqual(journal.read().map((record) => record.seq), [0, 1, 2, 3], 'read() 必须把两代按时间顺序拼起来');
    assert.deepEqual(journal.stats().archived, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal 轮转：字节阈值同样触发（记录大小算出来注入，不依赖魔法数字）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-jobs-rotate-bytes-'));
  try {
    const file = join(dir, 'jobs.jsonl');
    const oneRecordBytes = Buffer.byteLength(`${JSON.stringify(journalRecord(0))}\n`, 'utf8');
    const journal = createFileJournal(file, { maxBytes: oneRecordBytes * 2, maxLines: 100_000 });
    journal.append(journalRecord(0));
    journal.append(journalRecord(1));
    assert.equal(existsSync(`${file}.1`), false, '两条记录恰好未超过字节阈值');
    journal.append(journalRecord(2));
    assert.equal(existsSync(`${file}.1`), true, '第三条写入前因字节超限轮转');
    assert.deepEqual(readJournalLines(`${file}.1`).map((record) => record.seq), [0, 1]);
    const stats = journal.stats();
    assert.equal(stats.maxBytes, oneRecordBytes * 2);
    assert.equal(stats.lines, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal 轮转后重启恢复：recover 读到两代，已完成保留结果、在途如实 interrupted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-jobs-rotate-recover-'));
  try {
    const file = join(dir, 'jobs.jsonl');
    const journal = createFileJournal(file, { maxLines: 4 });
    const store = new EdaJobStore({ journal, now: () => 1000 });
    const doneId = '11111111-2222-3333-4444-555555555555';
    const inflightId = '22222222-3333-4444-5555-666666666666';
    store.create({ jobId: doneId, label: 'done', kind: 'pcb.drc' });
    store.dispatched({ jobId: doneId, epoch: 'epoch-A' });
    store.complete({ jobId: doneId, result: { kind: 'array', count: 2, items: [], truncated: false } });
    store.create({ jobId: inflightId, label: 'inflight', kind: 'pcb.drc' });
    store.dispatched({ jobId: inflightId, epoch: 'epoch-A' }); // 第 5 条写入前触发轮转（旧 4 行进 .1）
    assert.equal(existsSync(`${file}.1`), true, '跨代写入应已发生轮转');
    const { store: recovered, interrupted } = EdaJobStore.recover({ journal: createFileJournal(file, { maxLines: 4 }) });
    assert.deepEqual(interrupted, [inflightId], '轮转不能把在途任务洗成不存在');
    assert.equal(recovered.get(doneId).state, 'done');
    assert.equal(recovered.get(doneId).result.count, 2, '已完成任务的结果必须跨轮转保留');
    assert.equal(recovered.get(inflightId).state, 'interrupted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal 轮转后坏行仍只跳过：两代正常记录照常可读，不让整份 journal 变不可读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-jobs-rotate-badline-'));
  try {
    const file = join(dir, 'jobs.jsonl');
    const journal = createFileJournal(file, { maxLines: 1 });
    journal.append(journalRecord(0));
    journal.append(journalRecord(1)); // 触发轮转：.1 有 1 条，当前文件 1 条
    appendFileSync(file, '{not-json\n', 'utf8'); // 模拟进程被杀的半行
    const records = createFileJournal(file, { maxLines: 1 }).read();
    assert.deepEqual(records.map((record) => record.seq), [0, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal 轮转失败不阻断写：返回 rotated=false 标记，本次记录照常追加（恢复真相优先）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-jobs-rotate-fail-'));
  try {
    const file = join(dir, 'jobs.jsonl');
    // 用目录占住归档路径 → rename 必然失败（模拟权限/文件被占用等真实故障）。
    mkdirSync(`${file}.1`);
    const journal = createFileJournal(file, { maxLines: 1 });
    journal.append(journalRecord(0));
    const result = journal.append(journalRecord(1));
    assert.equal(result.ok, true, '追加本身必须成功');
    assert.equal(result.rotation.rotated, false, '轮转失败要如实标记，不能假装成功');
    assert.equal(result.rotation.reason, 'lines');
    assert.deepEqual(journal.read().map((record) => record.seq), [0, 1], '轮转失败也不能丢记录');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
