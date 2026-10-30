/**
 * task-28 独立复验（一）：HMAC 审计链攻击面（模块级，不依赖作者测试结论）。
 *
 * 攻击手法：手工改写/删除/换序/注入 legacy/截断 agent-audit.jsonl，以及删除或改坏
 * 审计密钥文件；断言 readAgentAudit 200 语义（不抛 500）、integrity.broken 分类正确、
 * appendAgentAudit 在链断时拒绝写新字节、密钥缺失/权限过宽时不重建密钥。
 *
 * 另用独立实现的 canonical JSON + node:crypto HMAC 复算整条链，确认哈希契约不是空转。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAgentAudit, appendAgentAudit } from '../../../runtime/agent-console.mjs';
import {
  auditEvent,
  seedChain,
  fileSize,
  readKeyHex,
  rawLines,
  writeRawLines,
  parseRawLines,
  writeRawText,
  readRawText,
  chmod,
  fileMode,
  fileExists,
  inspectChain,
  ownAuditHash,
  canonicalJson,
  headFileFor,
  readHeadFile,
  writeHeadFile,
} from './helpers.mjs';

function makeStore(t) {
  const root = mkdtempSync(join(tmpdir(), 'cp-chain-attack-'));
  const dir = join(root, 'state');
  mkdirSync(dir, { recursive: true });
  const auditPath = join(dir, 'agent-audit.jsonl');
  const keyFile = join(dir, 'agent-audit.key.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, auditPath, keyFile };
}

async function resetChain(auditPath, keyFile, count = 3) {
  rmSync(auditPath, { force: true });
  rmSync(headFileFor(auditPath), { force: true });
  return seedChain(auditPath, keyFile, count);
}

test('基线链：3 条事件、链完整，且用独立 canonical+HMAC 复算逐条一致（hash 确实绑定了密钥与 prevHash）', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const keyHex = readKeyHex(keyFile);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile, limit: 20 });
  assert.equal(audit.integrity.ok, true);
  assert.equal(audit.integrity.chain, 'ok');
  assert.equal(audit.integrity.verified, 3);
  assert.equal(audit.integrity.legacy, 0);
  assert.equal(audit.total, 3);
  assert.deepEqual(audit.events.map((event) => event.seq), [3, 2, 1], '事件应最新在前且保留 seq');
  assert.ok(!('hash' in audit.events[0]));
  assert.ok(!('prevHash' in audit.events[0]));
  assert.ok(!JSON.stringify(audit).includes(keyHex), 'read 结果泄漏审计密钥');
  assert.doesNotMatch(JSON.stringify(audit.events), /cpa_[0-9a-fA-F]{48}/);

  assert.equal(fileMode(keyFile), 0o600, '自动创建的审计密钥文件必须为 0600');
  const headFile = headFileFor(auditPath);
  assert.equal(fileMode(headFile), 0o600, '自动创建的 head 锚点文件必须为 0600');
  const head = readHeadFile(headFile);
  assert.deepEqual(Object.keys(head).sort(), ['hash', 'seq', 'updatedAt', 'version']);
  assert.equal(head.version, 1);
  assert.equal(head.seq, 3);
  assert.equal(head.hash, parseRawLines(auditPath)[2].hash);
  assert.equal(audit.integrity.anchored, true);
  assert.equal(audit.integrity.headSeq, 3);
  assert.equal(audit.integrity.headHash, head.hash);
  const inspected = inspectChain(auditPath, keyHex);
  assert.deepEqual(inspected.issues, [], `独立复算发现链问题：${inspected.issues.join('; ')}`);
  assert.equal(inspected.chained.length, 3);
  // 反证：没有密钥的普通 SHA-256 不应等于链上 hash（否则 HMAC 名不副实）。
  const records = parseRawLines(auditPath);
  const plainSha = (await import('node:crypto')).createHash('sha256')
    .update(`${records[0].seq}\n${records[0].prevHash}\n${canonicalJson({ ...records[0], seq: undefined, prevHash: undefined, hash: undefined })}`)
    .digest('hex');
  assert.notEqual(plainSha, records[0].hash);
});

test('篡改中间事件字段：read 返回 broken/hash-mismatch 并给 firstBadSeq，仍返回事件且不抛', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const records = parseRawLines(auditPath);
  records[1].path = '/api/evil-tampered';
  writeRawLines(auditPath, records.map((record) => JSON.stringify(record)));

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile });
  assert.equal(audit.integrity.ok, false);
  assert.equal(audit.integrity.chain, 'broken');
  assert.equal(audit.integrity.reason, 'hash-mismatch');
  assert.equal(audit.integrity.firstBadSeq, 2);
  assert.equal(audit.events.length >= 2, true, '审计链异常时仍应尽量返回事件供 UI 展示');
});

test('删除中间整行：read 返回 broken/seq-mismatch（链序号缺口）', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const lines = rawLines(auditPath);
  writeRawLines(auditPath, [lines[0], lines[2]]);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile });
  assert.equal(audit.integrity.ok, false);
  assert.equal(audit.integrity.reason, 'seq-mismatch');
  assert.equal(audit.integrity.firstBadSeq, 2);
  assert.equal(audit.integrity.anchored, true, '删中间行时 head 仍与最后一条一致（仅链内缺口）');
  assert.equal(audit.events.length, 2);
});

test('交换两行顺序：read 返回 broken/seq-mismatch', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const lines = rawLines(auditPath);
  writeRawLines(auditPath, [lines[0], lines[2], lines[1]]);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile });
  assert.equal(audit.integrity.ok, false);
  assert.equal(audit.integrity.reason, 'seq-mismatch');
  assert.equal(audit.integrity.firstBadSeq, 2);
});

test('篡改 hash / prevHash / seq / 链字段类型：分别判 broken 且原因准确', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  const scenarios = [
    {
      name: 'hash 改为其他合法 64hex',
      mutate(records) { records[1].hash = 'f'.repeat(64); },
      reason: 'hash-mismatch',
      firstBadSeq: 2,
    },
    {
      name: 'prevHash 改为其他合法 64hex',
      mutate(records) { records[1].prevHash = 'a'.repeat(64); },
      reason: 'prev-hash-mismatch',
      firstBadSeq: 2,
    },
    {
      name: 'seq 跳号（中间）',
      mutate(records) { records[1].seq = 9; },
      reason: 'seq-mismatch',
      firstBadSeq: 2,
    },
    {
      name: '最后一行 seq 字段类型非法',
      mutate(records) { records[2].seq = 'not-a-number'; },
      reason: 'invalid-chain-fields',
      firstBadSeq: undefined,
    },
  ];
  for (const scenario of scenarios) {
    await resetChain(auditPath, keyFile, 3);
    const records = parseRawLines(auditPath);
    scenario.mutate(records);
    writeRawLines(auditPath, records.map((record) => JSON.stringify(record)));

    const audit = await readAgentAudit({ auditFile: auditPath, keyFile });
    assert.equal(audit.integrity.ok, false, scenario.name);
    assert.equal(audit.integrity.chain, 'broken', scenario.name);
    assert.equal(audit.integrity.reason, scenario.reason, scenario.name);
    if (scenario.firstBadSeq !== undefined) {
      assert.equal(audit.integrity.firstBadSeq, scenario.firstBadSeq, scenario.name);
    }
  }
});

test('legacy 注入到链之后：read 返回 broken/legacy-after-chain；append 拒绝且不写字节', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const lines = rawLines(auditPath);
  const legacyLine = JSON.stringify({ at: new Date().toISOString(), kind: 'request', actor: 'agent', path: '/api/legacy-injected' });
  writeRawLines(auditPath, [...lines, legacyLine]);
  const beforeSize = fileSize(auditPath);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile });
  assert.equal(audit.integrity.ok, false);
  assert.equal(audit.integrity.reason, 'legacy-after-chain');
  assert.equal(audit.integrity.legacy, 1);

  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, event: auditEvent({ path: '/api/should-not-be-written' }) });
  assert.equal(appended.ok, false);
  assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
  assert.equal(fileSize(auditPath), beforeSize, '链断后 append 不得写任何字节');
});

test('截断最后一行（半行 JSON）：read 返回 broken/bad-line；append 拒绝且文件字节数不变', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const raw = readRawText(auditPath);
  const lastNewline = raw.lastIndexOf('\n', raw.length - 2);
  writeRawText(auditPath, raw.slice(0, lastNewline + 1) + raw.slice(lastNewline + 1, lastNewline + 40));
  const beforeSize = fileSize(auditPath);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile });
  assert.equal(audit.integrity.ok, false);
  assert.equal(audit.integrity.reason, 'bad-line');
  assert.equal(audit.integrity.badLines, 1);
  assert.equal(audit.events.length, 2, '坏行不应掩盖之前有效事件');

  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, event: auditEvent({ path: '/api/after-truncate' }) });
  assert.equal(appended.ok, false);
  assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
  assert.equal(fileSize(auditPath), beforeSize);
});

test('篡改最后一条事件：append 校验尾部自哈希失败 → CHAIN_BROKEN 且不写', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const records = parseRawLines(auditPath);
  records[2].path = '/api/last-tampered';
  writeRawLines(auditPath, records.map((record) => JSON.stringify(record)));
  const beforeSize = fileSize(auditPath);

  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, event: auditEvent() });
  assert.equal(appended.ok, false);
  assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
  assert.equal(fileSize(auditPath), beforeSize);
});

test('密钥文件缺失：read 返回 key-missing（不重建）；append 拒绝且不创建新密钥文件', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  rmSync(keyFile);
  const beforeSize = fileSize(auditPath);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile });
  assert.equal(audit.integrity.ok, false);
  assert.equal(audit.integrity.chain, 'broken');
  assert.equal(audit.integrity.reason, 'key-missing');
  assert.equal(fileExists(keyFile), false, 'read 不得偷偷重建密钥文件');

  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, event: auditEvent() });
  assert.equal(appended.ok, false);
  assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
  assert.equal(fileExists(keyFile), false, 'append 不得重建密钥文件');
  assert.equal(fileSize(auditPath), beforeSize);
});

test('密钥文件权限过宽（0644）：read 返回 key-invalid；append 拒绝且不自动 chmod/重建', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const keyBytes = readRawText(keyFile);
  chmod(keyFile, 0o644);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile });
  assert.equal(audit.integrity.ok, false);
  assert.equal(audit.integrity.reason, 'key-invalid');

  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, event: auditEvent() });
  assert.equal(appended.ok, false);
  assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
  assert.equal(fileMode(keyFile), 0o644, '不得静默修复权限');
  assert.equal(readRawText(keyFile), keyBytes, '不得重写密钥内容');
});

test('密钥文件内容损坏：read 返回 key-invalid；append 拒绝且内容不变', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  writeRawText(keyFile, '{"version":1,"key":"not-hex"}\n');
  chmod(keyFile, 0o600);
  const before = readRawText(keyFile);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile });
  assert.equal(audit.integrity.ok, false);
  assert.equal(audit.integrity.reason, 'key-invalid');
  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, event: auditEvent() });
  assert.equal(appended.ok, false);
  assert.equal(readRawText(keyFile), before);
});

test('legacy 前缀兼容：全 legacy 文件可读（chain=legacy）；append 从 seq=1 起新链；之后 read=ok', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  writeRawLines(auditPath, [
    JSON.stringify({ at: '2026-10-28T00:00:00.000Z', kind: 'request', actor: 'agent', path: '/api/legacy-1' }),
    JSON.stringify({ at: '2026-10-28T00:00:01.000Z', kind: 'denied', actor: 'agent', path: '/api/legacy-2' }),
  ]);

  const before = await readAgentAudit({ auditFile: auditPath, keyFile });
  assert.equal(before.integrity.ok, true);
  assert.equal(before.integrity.chain, 'legacy');
  assert.equal(before.integrity.legacy, 2);
  assert.equal(before.integrity.verified, 0);

  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, event: auditEvent({ path: '/api/new-chain' }) });
  assert.equal(appended.ok, true);

  const after = await readAgentAudit({ auditFile: auditPath, keyFile });
  assert.equal(after.integrity.ok, true);
  assert.equal(after.integrity.chain, 'ok');
  assert.equal(after.integrity.legacy, 2);
  assert.equal(after.integrity.verified, 1);
  const added = parseRawLines(auditPath).at(-1);
  assert.equal(added.seq, 1);
  assert.equal(added.prevHash, '0'.repeat(64));
  assert.equal(ownAuditHash(readKeyHex(keyFile), added.seq, added.prevHash, {
    at: added.at, kind: added.kind, actor: added.actor, agent: added.agent, method: added.method,
    path: added.path, outcome: added.outcome, status: added.status,
  }), added.hash);
});

test('P2 修复（head 锚点）：3 条链 head 与最后一条一致；删最后一行→head-ahead/broken/anchored=false；删整文件→head-ahead', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const headFile = headFileFor(auditPath);
  const head = readHeadFile(headFile);
  const records = parseRawLines(auditPath);
  assert.equal(head.version, 1);
  assert.equal(head.seq, 3);
  assert.equal(head.hash, records[2].hash);
  assert.equal(fileMode(headFile), 0o600);

  const healthy = await readAgentAudit({ auditFile: auditPath, keyFile, headFile });
  assert.equal(healthy.integrity.ok, true);
  assert.equal(healthy.integrity.anchored, true);
  assert.equal(healthy.integrity.headSeq, 3);
  assert.equal(healthy.integrity.headHash, head.hash);

  // 删除最后一条完整记录：前缀链自洽，但 head 领先 → head-ahead。
  writeRawLines(auditPath, rawLines(auditPath).slice(0, 2));
  const beforeSize = fileSize(auditPath);
  const deletedTail = await readAgentAudit({ auditFile: auditPath, keyFile, headFile });
  assert.equal(deletedTail.integrity.ok, false);
  assert.equal(deletedTail.integrity.chain, 'broken');
  assert.equal(deletedTail.integrity.reason, 'head-ahead');
  assert.equal(deletedTail.integrity.anchored, false);
  assert.equal(deletedTail.integrity.headSeq, 3);
  assert.equal(deletedTail.integrity.headHash, head.hash);
  assert.equal(deletedTail.events.length, 2);
  assert.equal(deletedTail.total, 2);

  // 尾部记录被删后 append 也必须拒绝，且零字节。
  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, headFile, event: auditEvent() });
  assert.equal(appended.ok, false);
  assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
  assert.equal(fileSize(auditPath), beforeSize);

  // 审计文件整体被删：head 仍在 → head-ahead，而不是静默 empty/ok。
  rmSync(auditPath);
  const deletedAll = await readAgentAudit({ auditFile: auditPath, keyFile, headFile });
  assert.equal(deletedAll.integrity.ok, false);
  assert.equal(deletedAll.integrity.chain, 'broken');
  assert.equal(deletedAll.integrity.reason, 'head-ahead');
  assert.equal(deletedAll.integrity.anchored, false);
  assert.equal(deletedAll.integrity.headSeq, 3);
  assert.equal(deletedAll.events.length, 0);
});

test('head 锚点：改最后一条的 hash→head-hash-mismatch；改内容但保留旧 hash→hash-mismatch；append 均拒绝且零字节', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const headFile = headFileFor(auditPath);
  const original = parseRawLines(auditPath);
  const records = parseRawLines(auditPath);
  records[2].hash = 'f'.repeat(64);
  writeRawLines(auditPath, records.map((record) => JSON.stringify(record)));
  const beforeSize = fileSize(auditPath);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile, headFile });
  assert.equal(audit.integrity.ok, false);
  assert.equal(audit.integrity.chain, 'broken');
  assert.equal(audit.integrity.reason, 'head-hash-mismatch', '最后一条 hash 被换 → 锚点 hash 不一致');
  assert.equal(audit.integrity.anchored, false);
  assert.equal(audit.integrity.firstBadSeq, 3);

  // 仅改最后一条内容、保留原 hash：链自校验先报 hash-mismatch（head 仍是原 hash，与记录的 hash 字段一致）。
  original[2].path = '/api/evil-tail';
  writeRawLines(auditPath, original.map((record) => JSON.stringify(record)));
  const contentTamper = await readAgentAudit({ auditFile: auditPath, keyFile, headFile });
  assert.equal(contentTamper.integrity.reason, 'hash-mismatch');
  // 只改内容、hash 字段未动时 head 与“最后一条 hash 字段”仍一致，故 anchored=true；破损由链自校验发现。
  assert.equal(contentTamper.integrity.anchored, true);

  const beforeAppendSize = fileSize(auditPath);
  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, headFile, event: auditEvent() });
  assert.equal(appended.ok, false);
  assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
  assert.equal(fileSize(auditPath), beforeAppendSize);
});

test('head 缺失：integrity.anchored=false 但不判 broken；append 可重建 head 并恢复锚定', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const headFile = headFileFor(auditPath);
  rmSync(headFile);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile, headFile });
  assert.equal(audit.integrity.ok, true);
  assert.equal(audit.integrity.chain, 'ok');
  assert.equal(audit.integrity.anchored, false, 'head 缺失（旧审计）不得伪装成已锚定');
  assert.equal(audit.integrity.headSeq, null);
  assert.equal(audit.integrity.headHash, null);
  assert.equal(fileExists(headFile), false);

  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, headFile, event: auditEvent() });
  assert.equal(appended.ok, true);
  assert.equal(fileExists(headFile), true);
  const rebuilt = readHeadFile(headFile);
  assert.equal(rebuilt.seq, 4);
  assert.equal(rebuilt.hash, parseRawLines(auditPath)[3].hash);

  const anchored = await readAgentAudit({ auditFile: auditPath, keyFile, headFile });
  assert.equal(anchored.integrity.ok, true);
  assert.equal(anchored.integrity.anchored, true);
  assert.equal(anchored.integrity.headSeq, 4);
});

test('head 落后：read→head-behind；append 拒绝 CHAIN_BROKEN 且零字节', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const headFile = headFileFor(auditPath);
  const oldHead = readHeadFile(headFile);

  // 正常追加第 4 条（head 更新到 seq=4），再把 head 回退成 seq=3（模拟 head 被回滚/落后）。
  const fourth = await appendAgentAudit({ auditFile: auditPath, keyFile, headFile, event: auditEvent() });
  assert.equal(fourth.ok, true);
  writeHeadFile(headFile, oldHead);
  const beforeSize = fileSize(auditPath);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile, headFile });
  assert.equal(audit.integrity.ok, false);
  assert.equal(audit.integrity.chain, 'broken');
  assert.equal(audit.integrity.reason, 'head-behind');
  assert.equal(audit.integrity.anchored, false);
  assert.equal(audit.integrity.headSeq, 3);
  assert.equal(audit.integrity.firstBadSeq, 4);

  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, headFile, event: auditEvent() });
  assert.equal(appended.ok, false);
  assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
  assert.match(appended.message, /head-behind/);
  assert.equal(fileSize(auditPath), beforeSize, 'head 落后时 append 必须零字节');
  assert.deepEqual(readHeadFile(headFile), oldHead, 'append 拒绝时不得改写 head');
});

test('head 损坏：read→head-invalid；append 拒绝且零字节', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const headFile = headFileFor(auditPath);
  writeRawText(headFile, 'not-json\n');
  const beforeSize = fileSize(auditPath);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile, headFile });
  assert.equal(audit.integrity.ok, false);
  assert.equal(audit.integrity.chain, 'broken');
  assert.equal(audit.integrity.reason, 'head-invalid');
  assert.equal(audit.integrity.anchored, false);
  assert.equal(audit.integrity.headSeq, null);

  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, headFile, event: auditEvent() });
  assert.equal(appended.ok, false);
  assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
  assert.equal(fileSize(auditPath), beforeSize);
});

test('脱敏与 UTF-8 截断：path 内 token 被替换、超长 CJK 按整字符截断、未知/敏感字段被丢弃，链保持完整', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  // 先写一条基线事件，让 append 自动创建 0600 密钥文件，再读取密钥 hex 用于“敏感字段攻击”。
  await appendAgentAudit({ auditFile: auditPath, keyFile, event: auditEvent({ path: '/api/seed' }) });
  const tokenLike = `cpa_${'a'.repeat(48)}`;
  const longCjk = `前缀-${'中'.repeat(300)}-后缀`;
  const result = await appendAgentAudit({
    auditFile: auditPath,
    keyFile,
    event: {
      kind: 'request',
      actor: 'agent',
      agent: 'dsh-plugin',
      method: 'GET',
      path: `/api/evidence?token=${tokenLike}&q=${encodeURIComponent(longCjk)}`,
      outcome: 'accepted',
      status: 200,
      // 未列入白名单/疑似敏感字段：必须被丢弃，不得落盘
      token: tokenLike,
      authorization: `Bearer ${tokenLike}`,
      key: readKeyHex(keyFile),
      nested: { secret: tokenLike },
      note: 'x'.repeat(400),
    },
  });
  assert.equal(result.ok, true);

  const onDisk = readRawText(auditPath);
  assert.ok(!onDisk.includes(tokenLike), '落盘内容泄漏 token 原文');
  assert.ok(!onDisk.includes('"token"'), '未知字段 token 不应落盘');
  assert.ok(!onDisk.includes('authorization'), '未知字段 authorization 不应落盘');
  assert.ok(!onDisk.includes('"key"'), '未知字段 key 不应落盘');
  assert.ok(onDisk.includes('cpa_[redacted]'), 'path 中的 token 应被脱敏替换');

  const stored = parseRawLines(auditPath)[1];
  assert.ok(Buffer.byteLength(stored.path, 'utf8') <= 512, `path 字节数 ${Buffer.byteLength(stored.path, 'utf8')} 超过 512`);
  assert.ok(!stored.path.includes('\uFFFD'), '截断不得产生 U+FFFD 半个字符');
  assert.equal(stored.note.length, 240);
  assert.deepEqual(Object.keys(stored).sort(), ['actor', 'agent', 'at', 'hash', 'kind', 'method', 'note', 'outcome', 'path', 'prevHash', 'seq', 'status']);

  // 追加后链仍完整（脱敏发生在 HMAC 计算之前，读写 canonical 一致）。
  const appended = await appendAgentAudit({ auditFile: auditPath, keyFile, event: auditEvent() });
  assert.equal(appended.ok, true);
  const audit = await readAgentAudit({ auditFile: auditPath, keyFile });
  assert.equal(audit.integrity.ok, true);
  assert.equal(audit.integrity.verified, 3);
  assert.ok(!JSON.stringify(audit).includes(tokenLike));
});

test('limit/total/truncated：limit=2 返回最新 2 条，total 仍为全量', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 4);
  const audit = await readAgentAudit({ auditFile: auditPath, keyFile, limit: 2 });
  assert.equal(audit.total, 4);
  assert.equal(audit.events.length, 2);
  assert.equal(audit.truncated, true);
  assert.deepEqual(audit.events.map((event) => event.seq), [4, 3]);
  assert.equal(audit.integrity.verified, 4);
});


test('并发 append 串行化：10 个并发写入不重号/不分叉，链完整且 seq 连续', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) => appendAgentAudit({
      auditFile: auditPath,
      keyFile,
      event: auditEvent({ path: `/api/concurrent-${index}` }),
    })),
  );
  for (const result of results) assert.equal(result.ok, true);

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile, limit: 100 });
  assert.equal(audit.integrity.ok, true);
  assert.equal(audit.integrity.chain, 'ok');
  assert.equal(audit.integrity.verified, 10);
  assert.equal(audit.total, 10);
  const records = parseRawLines(auditPath);
  assert.deepEqual(records.map((record) => record.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(inspectChain(auditPath, readKeyHex(keyFile)).issues, []);
});


test('已知语义边界：链记录里注入“白名单外”字段不会破坏 integrity（读取时被丢弃，不参与 HMAC）', async (t) => {
  const { auditPath, keyFile } = makeStore(t);
  await seedChain(auditPath, keyFile, 3);
  const records = parseRawLines(auditPath);
  records[1].evilInjected = 'should-not-appear';
  records[1].token = `cpa_${'b'.repeat(48)}`;
  writeRawLines(auditPath, records.map((record) => JSON.stringify(record)));

  const audit = await readAgentAudit({ auditFile: auditPath, keyFile });
  // HMAC 覆盖的是 sanitize 后的白名单事件；多出来的字段在解析时被丢弃，因此不算“链被改写”。
  assert.equal(audit.integrity.ok, true);
  assert.equal(audit.integrity.chain, 'ok');
  assert.equal(audit.integrity.verified, 3);
  const serialized = JSON.stringify(audit);
  assert.ok(!serialized.includes('should-not-appear'));
  assert.ok(!serialized.includes('cpa_'));
  assert.ok(!serialized.includes('evilInjected'));
});
