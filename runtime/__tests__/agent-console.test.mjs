import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AGENT_AUDIT_HASH_HEX_LENGTH,
  AGENT_AUDIT_ZERO_HASH,
  AGENT_CONSOLE_CODES,
  MAX_AUDIT_PATH_BYTES,
  agentAuditFile,
  agentAuditHeadFile,
  agentAuditKeyFile,
  agentConsoleStatus,
  appendAgentAudit,
  readAgentAudit,
  rotateAgentToken,
} from '../agent-console.mjs';
import { AGENT_TOKEN_NAME, AGENT_TOKEN_SCOPES, ensureAgentTokenFile, readAgentToken, verifyAgentToken } from '../agent-token.mjs';

/** task-23：Runtime Agent 控制台模块（状态/轮换/审计）。 */

const POSIX = process.platform !== 'win32';
/** 形如真令牌的测试假值（用于断言"绝不出现在返回值/审计里"）。 */
const FAKE_TOKEN = `cpa_${'a1'.repeat(24)}`;

const makeDir = () => mkdtempSync(join(tmpdir(), 'cp-agent-console-'));
const tokenFile = (dir) => join(dir, 'agent-token.json');

const seedToken = async (file, now = () => new Date('2026-10-29T00:00:00.000Z')) => {
  const seeded = await ensureAgentTokenFile({ file, now });
  return seeded.token;
};

test('status：token 文件缺失 → available:false + AGENT_TOKEN_MISSING，不抛、不泄漏', async () => {
  const dir = makeDir();
  try {
    const file = tokenFile(dir);
    const status = await agentConsoleStatus({ tokenFile: file, auditFile: join(dir, 'agent-audit.jsonl') });
    assert.equal(status.available, false);
    assert.equal(status.file, file);
    assert.equal(status.reason, AGENT_CONSOLE_CODES.TOKEN_MISSING);
    assert.equal(status.name, null);
    assert.deepEqual(status.scopes, []);
    assert.equal(status.createdAt, null);
    assert.deepEqual(status.audit, []);
    assert.equal(status.auditTotal, 0);
    assert.equal(status.auditTruncated, false);
    assert.equal(Object.hasOwn(status, 'token'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status：token 文件损坏 → available:false + AGENT_TOKEN_INVALID，不抛 500', async () => {
  const dir = makeDir();
  try {
    const file = tokenFile(dir);
    writeFileSync(file, '{"version":1,"token":"not-a-token"', { mode: 0o600 });
    const status = await agentConsoleStatus({ tokenFile: file, auditFile: join(dir, 'agent-audit.jsonl') });
    assert.equal(status.available, false);
    assert.equal(status.reason, AGENT_CONSOLE_CODES.TOKEN_INVALID);
    assert.equal(typeof status.reasonDetail, 'string');
    assert.ok(!status.reasonDetail.includes(FAKE_TOKEN));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status：token 文件权限过宽 → available:false（fail-closed，仅 POSIX）', { skip: !POSIX }, async () => {
  const dir = makeDir();
  try {
    const file = tokenFile(dir);
    await seedToken(file);
    chmodSync(file, 0o644);
    const status = await agentConsoleStatus({ tokenFile: file, auditFile: join(dir, 'agent-audit.jsonl') });
    assert.equal(status.available, false);
    assert.equal(status.reason, AGENT_CONSOLE_CODES.TOKEN_INVALID);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status：正常令牌 → 回显 name/scopes/createdAt，但绝不返回 token', async () => {
  const dir = makeDir();
  try {
    const file = tokenFile(dir);
    const token = await seedToken(file);
    const status = await agentConsoleStatus({ tokenFile: file, auditFile: join(dir, 'agent-audit.jsonl') });
    assert.equal(status.available, true);
    assert.equal(status.file, file);
    assert.equal(status.name, AGENT_TOKEN_NAME);
    assert.deepEqual(status.scopes, [...AGENT_TOKEN_SCOPES]);
    assert.equal(status.createdAt, '2026-10-29T00:00:00.000Z');
    assert.equal(Object.hasOwn(status, 'reason'), false);
    assert.equal(JSON.stringify(status).includes(token), false);
    assert.equal(/cpa_[0-9a-f]{48}/.test(JSON.stringify(status)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status：附带最近审计（尾部 limit、最新在前）与 total/truncated', async () => {
  const dir = makeDir();
  try {
    const file = tokenFile(dir);
    await seedToken(file);
    const auditFile = join(dir, 'state', 'agent-audit.jsonl');
    for (let index = 1; index <= 3; index += 1) {
      await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent', path: `/api/x/${index}` } });
    }
    const status = await agentConsoleStatus({ tokenFile: file, auditFile, limit: 2 });
    assert.equal(status.available, true);
    assert.equal(status.audit.length, 2);
    assert.equal(status.audit[0].path, '/api/x/3');
    assert.equal(status.audit[1].path, '/api/x/2');
    assert.equal(status.auditTotal, 3);
    assert.equal(status.auditTruncated, true);
    assert.equal(status.auditFile, auditFile);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status：审计文件不可读 → 不抛，audit 为空并给 auditError', async () => {
  const dir = makeDir();
  try {
    const file = tokenFile(dir);
    await seedToken(file);
    const auditFile = join(dir, 'audit-as-directory');
    mkdirSync(auditFile, { recursive: true });
    const status = await agentConsoleStatus({ tokenFile: file, auditFile });
    assert.equal(status.available, true);
    assert.deepEqual(status.audit, []);
    assert.equal(status.auditError.code, AGENT_CONSOLE_CODES.AUDIT_READ_FAILED);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rotate：生成新令牌并原子替换，旧令牌立即失效、文件 0600', { skip: !POSIX }, async () => {
  const dir = makeDir();
  try {
    const file = tokenFile(dir);
    const oldToken = await seedToken(file);
    const before = JSON.parse(readFileSync(file, 'utf8'));

    const rotated = await rotateAgentToken({ tokenFile: file, now: () => new Date('2026-10-30T12:00:00.000Z') });
    assert.equal(rotated.rotated, true);
    assert.equal(rotated.file, file);
    assert.equal(rotated.name, AGENT_TOKEN_NAME);
    assert.deepEqual(rotated.scopes, [...AGENT_TOKEN_SCOPES]);
    assert.equal(rotated.createdAt, '2026-10-30T12:00:00.000Z');
    assert.equal(Object.hasOwn(rotated, 'token'), false);
    assert.equal(JSON.stringify(rotated).includes('cpa_'), false);

    const record = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(record.name, AGENT_TOKEN_NAME);
    assert.deepEqual(record.scopes, [...AGENT_TOKEN_SCOPES]);
    assert.equal(record.createdAt, '2026-10-30T12:00:00.000Z');
    assert.notEqual(record.token, oldToken);
    assert.notEqual(record.token, before.token);
    assert.equal(statSync(file).mode & 0o777, 0o600);

    const current = await readAgentToken(file);
    assert.ok(current);
    assert.equal(verifyAgentToken(oldToken, current), null, '旧令牌必须立即失效');
    const matched = verifyAgentToken(record.token, current);
    assert.equal(matched.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rotate：目录不存在时自动创建（目录 0700 / 文件 0600）', { skip: !POSIX }, async () => {
  const dir = makeDir();
  try {
    const file = join(dir, 'nested', 'deeper', 'agent-token.json');
    const rotated = await rotateAgentToken({ tokenFile: file, now: () => new Date('2026-10-30T00:00:00.000Z') });
    assert.equal(rotated.rotated, true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'nested', 'deeper')).mode & 0o777, 0o700);
    assert.ok(await readAgentToken(file));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rotate：文件损坏也可恢复（轮换是修复动作）', async () => {
  const dir = makeDir();
  try {
    const file = tokenFile(dir);
    writeFileSync(file, 'not-json', { mode: 0o600 });
    const rotated = await rotateAgentToken({ tokenFile: file });
    assert.equal(rotated.rotated, true);
    assert.ok(await readAgentToken(file));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rotate：now 非法 → 抛 AGENT_CONSOLE_INVALID，且不动原文件', async () => {
  const dir = makeDir();
  try {
    const file = tokenFile(dir);
    await seedToken(file);
    const before = readFileSync(file, 'utf8');
    await assert.rejects(
      () => rotateAgentToken({ tokenFile: file, now: 'not-a-real-time' }),
      (error) => error.code === AGENT_CONSOLE_CODES.INVALID_ARGUMENT,
    );
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rotate：空 tokenFile → 抛 AGENT_CONSOLE_INVALID', async () => {
  await assert.rejects(
    () => rotateAgentToken({ tokenFile: '   ' }),
    (error) => error.code === AGENT_CONSOLE_CODES.INVALID_ARGUMENT,
  );
});

test('append：自动建目录并追加一行 JSONL，字段原样保留', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'state', 'agent-audit.jsonl');
    const result = await appendAgentAudit({
      auditFile,
      event: {
        at: '2026-10-29T01:02:03.000Z',
        kind: 'approve',
        actor: 'agent',
        agent: AGENT_TOKEN_NAME,
        method: 'POST',
        path: '/api/design/approve',
        outcome: 'ok',
        status: 200,
        planHash: 'design-plan-hash-000001',
      },
    });
    assert.deepEqual(result, { ok: true, file: auditFile });
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.at, '2026-10-29T01:02:03.000Z');
    assert.equal(parsed.kind, 'approve');
    assert.equal(parsed.actor, 'agent');
    assert.equal(parsed.agent, AGENT_TOKEN_NAME);
    assert.equal(parsed.method, 'POST');
    assert.equal(parsed.path, '/api/design/approve');
    assert.equal(parsed.outcome, 'ok');
    assert.equal(parsed.status, 200);
    assert.equal(parsed.planHash, 'design-plan-hash-000001');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('append：缺省 at/kind/actor 自动补全（at 为 ISO）', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await appendAgentAudit({ auditFile, event: { path: '/api/health' } });
    const parsed = JSON.parse(readFileSync(auditFile, 'utf8').trim());
    assert.equal(parsed.kind, 'request');
    assert.equal(parsed.actor, 'unknown');
    assert.equal(Number.isNaN(Date.parse(parsed.at)), false);
    assert.equal(parsed.path, '/api/health');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('append：丢弃未知字段/嵌套对象，脱敏令牌样式字符串，截断超长字段', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    const result = await appendAgentAudit({
      auditFile,
      event: {
        kind: 'request',
        actor: 'agent',
        path: `/api/evidence/find?token=${FAKE_TOKEN}`,
        note: `caller=${FAKE_TOKEN}`,
        token: FAKE_TOKEN,
        approvalToken: FAKE_TOKEN,
        authorization: `Bearer ${FAKE_TOKEN}`,
        headers: { cookie: FAKE_TOKEN },
        tool: 'cp_status',
      },
    });
    assert.equal(result.ok, true);
    const raw = readFileSync(auditFile, 'utf8');
    assert.equal(raw.includes(FAKE_TOKEN), false, '原始审计文件不得出现令牌');
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.token, undefined);
    assert.equal(parsed.approvalToken, undefined);
    assert.equal(parsed.authorization, undefined);
    assert.equal(parsed.headers, undefined);
    assert.equal(parsed.tool, 'cp_status');
    assert.equal(parsed.path, '/api/evidence/find?token=cpa_[redacted]');
    assert.equal(parsed.note, 'caller=cpa_[redacted]');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('append：超长 path/note 按 UTF-8 字节截断（不截半个汉字）', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await appendAgentAudit({
      auditFile,
      event: { kind: 'request', actor: 'agent', path: '电'.repeat(400), note: 'x'.repeat(1000) },
    });
    const parsed = JSON.parse(readFileSync(auditFile, 'utf8').trim());
    assert.ok(Buffer.byteLength(parsed.path, 'utf8') <= MAX_AUDIT_PATH_BYTES);
    assert.equal(parsed.path.includes('\uFFFD'), false);
    assert.equal(Buffer.byteLength(parsed.note, 'utf8'), 240);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('append：写盘失败不抛，返回 {ok:false, code}', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'audit-as-directory');
    mkdirSync(auditFile, { recursive: true });
    const result = await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent' } });
    assert.equal(result.ok, false);
    assert.equal(result.code, AGENT_CONSOLE_CODES.AUDIT_APPEND_FAILED);
    assert.equal(typeof result.message, 'string');

    const badEvent = await appendAgentAudit({ auditFile: join(dir, 'a.jsonl'), event: 'nope' });
    assert.equal(badEvent.ok, false);
    assert.equal(badEvent.code, AGENT_CONSOLE_CODES.INVALID_ARGUMENT);

    const noPath = await appendAgentAudit({ auditFile: '  ', event: { kind: 'request' } });
    assert.equal(noPath.ok, false);
    assert.equal(noPath.code, AGENT_CONSOLE_CODES.INVALID_ARGUMENT);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('默认审计路径：CIRCUITPILOT_AGENT_AUDIT_FILE 优先，其次 CIRCUITPILOT_STATE_DIR', () => {
  assert.equal(
    agentAuditFile({ CIRCUITPILOT_AGENT_AUDIT_FILE: '/tmp/explicit.jsonl', CIRCUITPILOT_STATE_DIR: '/tmp/state' }),
    '/tmp/explicit.jsonl',
  );
  assert.equal(
    agentAuditFile({ CIRCUITPILOT_STATE_DIR: '/tmp/state' }),
    join('/tmp/state', 'agent-audit.jsonl'),
  );
  const fallback = agentAuditFile({});
  assert.equal(fallback, join(process.cwd(), 'artifacts/state', 'agent-audit.jsonl'));
});

test('默认审计路径：读/写函数不传 auditFile 时使用环境变量', async () => {
  const dir = makeDir();
  const previousAudit = process.env.CIRCUITPILOT_AGENT_AUDIT_FILE;
  const previousState = process.env.CIRCUITPILOT_STATE_DIR;
  try {
    process.env.CIRCUITPILOT_AGENT_AUDIT_FILE = join(dir, 'env-audit.jsonl');
    delete process.env.CIRCUITPILOT_STATE_DIR;
    const result = await appendAgentAudit({ event: { kind: 'rotate', actor: 'ui' } });
    assert.equal(result.ok, true);
    assert.equal(result.file, join(dir, 'env-audit.jsonl'));
    const readBack = await readAgentAudit({});
    assert.equal(readBack.total, 1);
    assert.equal(readBack.events[0].kind, 'rotate');
    assert.equal(readBack.events[0].actor, 'ui');
  } finally {
    if (previousAudit === undefined) delete process.env.CIRCUITPILOT_AGENT_AUDIT_FILE;
    else process.env.CIRCUITPILOT_AGENT_AUDIT_FILE = previousAudit;
    if (previousState === undefined) delete process.env.CIRCUITPILOT_STATE_DIR;
    else process.env.CIRCUITPILOT_STATE_DIR = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read：文件缺失 → 空结果（不抛）', async () => {
  const dir = makeDir();
  try {
    const result = await readAgentAudit({ auditFile: join(dir, 'missing.jsonl') });
    assert.deepEqual(result.events, []);
    assert.equal(result.total, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.badLines, 0);
    assert.equal(result.error, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('read：坏行跳过并计数，合法行按原顺序保留', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    writeFileSync(auditFile, [
      JSON.stringify({ at: '2026-10-29T00:00:00.000Z', kind: 'request', actor: 'agent', path: '/api/heatlh' }),
      'not-json-at-all',
      JSON.stringify([{ nested: 'array' }]),
      '',
      JSON.stringify({ at: '2026-10-29T00:00:01.000Z', kind: 'denied', actor: 'agent', path: '/api/production/signoff' }),
    ].join('\n'), 'utf8');

    const result = await readAgentAudit({ auditFile, limit: 10 });
    assert.equal(result.total, 2);
    assert.equal(result.badLines, 2);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.events.map((event) => event.path), ['/api/production/signoff', '/api/heatlh']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('read：从尾部取 limit 条（最新在前），超量时 truncated=true', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    for (let index = 1; index <= 30; index += 1) {
      await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent', note: `e${index}` } });
    }
    const tail = await readAgentAudit({ auditFile, limit: 5 });
    assert.equal(tail.events.length, 5);
    assert.equal(tail.events[0].note, 'e30');
    assert.equal(tail.events[4].note, 'e26');
    assert.equal(tail.total, 30);
    assert.equal(tail.truncated, true);

    const all = await readAgentAudit({ auditFile, limit: 1000 });
    assert.equal(all.events.length, 30);
    assert.equal(all.total, 30);
    assert.equal(all.truncated, false);
    assert.equal(all.events[0].note, 'e30');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('read：limit 非法值回落默认值（不抛）', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent' } });
    for (const limit of [0, -5, 'abc', Number.NaN]) {
      const result = await readAgentAudit({ auditFile, limit });
      assert.equal(result.events.length, 1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('read：手写脏数据也会脱敏+截断（防御性，不泄漏 token）', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    writeFileSync(auditFile, `${JSON.stringify({
      at: '2026-10-29T00:00:00.000Z',
      kind: 'request',
      actor: 'agent',
      path: `/api/x?t=${FAKE_TOKEN}&p=${'a'.repeat(2000)}`,
      token: FAKE_TOKEN,
      approvalToken: FAKE_TOKEN,
      deep: { authorization: FAKE_TOKEN },
    })}\n`, 'utf8');

    const result = await readAgentAudit({ auditFile, limit: 10 });
    assert.equal(result.total, 1);
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
    const event = result.events[0];
    assert.equal(event.token, undefined);
    assert.equal(event.approvalToken, undefined);
    assert.equal(event.deep, undefined);
    assert.ok(Buffer.byteLength(event.path, 'utf8') <= MAX_AUDIT_PATH_BYTES);
    assert.ok(event.path.includes('cpa_[redacted]'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('read：审计文件是目录 → 返回空结果 + AUDIT_READ_FAILED（不抛）', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'audit-dir');
    mkdirSync(auditFile, { recursive: true });
    const result = await readAgentAudit({ auditFile });
    assert.deepEqual(result.events, []);
    assert.equal(result.error.code, AGENT_CONSOLE_CODES.AUDIT_READ_FAILED);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('端到端：轮换后 UI 状态反映新 createdAt，审计记录 rotate 事件且无令牌', async () => {
  const dir = makeDir();
  try {
    const file = tokenFile(dir);
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedToken(file);
    const rotated = await rotateAgentToken({ tokenFile: file, now: () => new Date('2026-10-31T08:00:00.000Z') });
    const appended = await appendAgentAudit({
      auditFile,
      event: { kind: 'rotate', actor: 'ui', outcome: 'ok', status: 200, path: '/api/agent/token/rotate' },
    });
    assert.equal(appended.ok, true);

    const status = await agentConsoleStatus({ tokenFile: file, auditFile });
    assert.equal(status.available, true);
    assert.equal(status.createdAt, rotated.createdAt);
    assert.equal(status.audit[0].kind, 'rotate');
    assert.equal(status.audit[0].actor, 'ui');
    assert.equal(JSON.stringify(status).includes('cpa_'), false);
    assert.equal(existsSync(file), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// task-26：审计防篡改（HMAC 哈希链）
// ---------------------------------------------------------------------------

const readJsonLines = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const writeJsonLines = (file, records) => writeFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');

async function seedChain(auditFile, count = 3) {
  for (let index = 1; index <= count; index += 1) {
    await appendAgentAudit({
      auditFile,
      event: { kind: 'request', actor: 'agent', method: 'GET', path: `/api/x/${index}` },
    });
  }
}

test('hash 链：append 自动生成 32B 密钥（0600），写入 seq/prevHash/hash 且不泄漏密钥', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    const first = await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent', path: '/api/x/1' } });
    assert.deepEqual(first, { ok: true, file: auditFile }, 'append 成功返回形状保持 {ok:true,file}');

    const keyFile = join(dir, 'agent-audit.key.json');
    assert.equal(existsSync(keyFile), true);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    const keyRecord = JSON.parse(readFileSync(keyFile, 'utf8'));
    assert.equal(keyRecord.version, 1);
    assert.match(keyRecord.key, /^[0-9a-f]{64}$/);
    assert.equal(Buffer.from(keyRecord.key, 'hex').length, 32);

    await seedChain(auditFile, 2); // 加上面第一条，共 3 条
    const lines = readJsonLines(auditFile);
    assert.equal(lines.length, 3);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      assert.equal(line.seq, index + 1);
      assert.equal(line.prevHash, index === 0 ? AGENT_AUDIT_ZERO_HASH : lines[index - 1].hash);
      assert.match(line.hash, new RegExp(`^[0-9a-f]{${AGENT_AUDIT_HASH_HEX_LENGTH}}$`));
    }
    assert.equal(new Set(lines.map((line) => line.hash)).size, lines.length, '每条 hash 必须不同');
    assert.equal(readFileSync(auditFile, 'utf8').includes(keyRecord.key), false, '审计文件不得出现密钥');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hash 链：read integrity=ok，events 最新在前且不返回 hash/prevHash、不泄漏密钥', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 3);
    const keyRecord = JSON.parse(readFileSync(join(dir, 'agent-audit.key.json'), 'utf8'));
    const headRecord = JSON.parse(readFileSync(join(dir, 'agent-audit.head.json'), 'utf8'));

    const result = await readAgentAudit({ auditFile, limit: 10 });
    assert.deepEqual(result.integrity, {
      ok: true, chain: 'ok', verified: 3, legacy: 0, badLines: 0,
      anchored: true, headSeq: 3, headHash: headRecord.hash,
    });
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].path, '/api/x/3');
    assert.equal(result.events[0].seq, 3);
    assert.equal('hash' in result.events[0], false);
    assert.equal('prevHash' in result.events[0], false);
    assert.equal(JSON.stringify(result).includes(keyRecord.key), false, 'read 不得泄漏密钥');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hash 链：空/缺失审计文件 → integrity chain=empty', async () => {
  const dir = makeDir();
  try {
    const missing = await readAgentAudit({ auditFile: join(dir, 'missing.jsonl') });
    assert.equal(missing.integrity.chain, 'empty');
    assert.equal(missing.integrity.ok, true);
    assert.equal(missing.integrity.verified, 0);
    assert.equal(missing.integrity.badLines, 0);

    const auditFile = join(dir, 'empty.jsonl');
    writeFileSync(auditFile, '', 'utf8');
    const empty = await readAgentAudit({ auditFile });
    assert.deepEqual(empty.integrity, {
      ok: true, chain: 'empty', verified: 0, legacy: 0, badLines: 0,
      anchored: false, headSeq: null, headHash: null,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hash 链：续链 seq 递增、prevHash 指向上一条 hash', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 3);
    await appendAgentAudit({ auditFile, event: { kind: 'approve', actor: 'agent', path: '/api/design/approve' } });
    const lines = readJsonLines(auditFile);
    assert.equal(lines.length, 4);
    assert.equal(lines[3].seq, 4);
    assert.equal(lines[3].prevHash, lines[2].hash);
    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.ok, true);
    assert.equal(result.integrity.verified, 4);
    assert.equal(result.events[0].kind, 'approve');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy 兼容：纯 legacy 行 → chain=legacy；legacy 前缀 + 新链 → legacy 计数且新链 ok', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    writeFileSync(auditFile, `${JSON.stringify({
      at: '2026-10-29T00:00:00.000Z', kind: 'request', actor: 'agent', path: '/api/legacy',
    })}\n`, 'utf8');

    const legacyOnly = await readAgentAudit({ auditFile });
    assert.equal(legacyOnly.integrity.chain, 'legacy');
    assert.equal(legacyOnly.integrity.ok, true);
    assert.equal(legacyOnly.integrity.legacy, 1);
    assert.equal(legacyOnly.integrity.verified, 0);
    assert.equal(legacyOnly.events[0].seq, undefined, 'legacy 事件没有 seq');

    await seedChain(auditFile, 2);
    const lines = readJsonLines(auditFile);
    assert.equal(lines.length, 3);
    assert.equal(lines[1].seq, 1);
    assert.equal(lines[1].prevHash, AGENT_AUDIT_ZERO_HASH);
    assert.equal(lines[2].seq, 2);
    assert.equal(lines[2].prevHash, lines[1].hash);

    const mixed = await readAgentAudit({ auditFile });
    assert.equal(mixed.integrity.chain, 'ok');
    assert.equal(mixed.integrity.ok, true);
    assert.equal(mixed.integrity.legacy, 1);
    assert.equal(mixed.integrity.verified, 2);
    assert.equal(mixed.events[0].seq, 2);
    assert.equal(mixed.events[2].path, '/api/legacy');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('篡改：改中间事件字段（不改 hash）→ integrity broken/hash-mismatch，事件仍返回', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 3);
    const lines = readJsonLines(auditFile);
    lines[1].path = '/api/x/2-tampered';
    writeJsonLines(auditFile, lines);

    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.ok, false);
    assert.equal(result.integrity.chain, 'broken');
    assert.equal(result.integrity.reason, 'hash-mismatch');
    assert.equal(result.integrity.firstBadSeq, 2);
    // 第 3 条自身的 hash 仍然有效（只改了第 2 条的事件字段），所以 verified 计到 2。
    assert.equal(result.integrity.verified, 2);
    assert.equal(result.events.length, 3, '事件仍尽量返回供 UI 展示');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('删行：删除中间一条 → integrity broken/seq-mismatch（不抛）', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 3);
    const lines = readJsonLines(auditFile);
    lines.splice(1, 1);
    writeJsonLines(auditFile, lines);

    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.ok, false);
    assert.equal(result.integrity.chain, 'broken');
    assert.equal(result.integrity.reason, 'seq-mismatch');
    assert.equal(result.integrity.firstBadSeq, 2);
    assert.equal(result.integrity.verified, 1);
    assert.equal(result.total, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('换序：交换两行 → integrity broken（不抛）', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 3);
    const lines = readJsonLines(auditFile);
    const swapped = [lines[0], lines[2], lines[1]];
    writeJsonLines(auditFile, swapped);

    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.ok, false);
    assert.equal(result.integrity.chain, 'broken');
    assert.equal(result.integrity.reason, 'seq-mismatch');
    assert.equal(result.integrity.firstBadSeq, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('最后一行损坏：read 标 broken/bad-line；append 返回 AGENT_AUDIT_CHAIN_BROKEN 且不写任何字节', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 3);
    writeFileSync(auditFile, `${readFileSync(auditFile, 'utf8')}{"broken":\n`, 'utf8');
    const before = readFileSync(auditFile, 'utf8');

    const read = await readAgentAudit({ auditFile });
    assert.equal(read.integrity.ok, false);
    assert.equal(read.integrity.chain, 'broken');
    assert.equal(read.integrity.reason, 'bad-line');
    assert.equal(read.badLines, 1);

    const appended = await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent', path: '/api/after' } });
    assert.equal(appended.ok, false);
    assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
    assert.equal(readFileSync(auditFile, 'utf8'), before, '链断时不得写半条记录');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('最后一行 hash 被篡改：append 拒绝续链（AGENT_AUDIT_CHAIN_BROKEN）', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 3);
    const lines = readJsonLines(auditFile);
    lines[2].hash = 'f'.repeat(AGENT_AUDIT_HASH_HEX_LENGTH);
    writeJsonLines(auditFile, lines);
    const before = readFileSync(auditFile, 'utf8');

    const appended = await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent' } });
    assert.equal(appended.ok, false);
    assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
    assert.equal(readFileSync(auditFile, 'utf8'), before);

    const read = await readAgentAudit({ auditFile });
    // head 锚点优先：最后一条被改 → head-hash-mismatch（同样 broken）。
    assert.equal(read.integrity.reason, 'head-hash-mismatch');
    assert.equal(read.integrity.firstBadSeq, 3);
    assert.equal(read.integrity.anchored, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('并发 append：同进程串行续链，seq 1..5 且 integrity ok', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => appendAgentAudit({
      auditFile,
      event: { kind: 'request', actor: 'agent', note: `c${index}` },
    })));
    assert.equal(results.every((result) => result.ok === true), true);
    const lines = readJsonLines(auditFile);
    assert.deepEqual(lines.map((line) => line.seq), [1, 2, 3, 4, 5]);
    for (let index = 1; index < lines.length; index += 1) {
      assert.equal(lines[index].prevHash, lines[index - 1].hash);
    }
    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.ok, true);
    assert.equal(result.integrity.verified, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('密钥缺失：链存在时 read broken/key-missing，append 拒绝而非用新密钥续链', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 2);
    rmSync(join(dir, 'agent-audit.key.json'));

    const read = await readAgentAudit({ auditFile });
    assert.equal(read.integrity.ok, false);
    assert.equal(read.integrity.chain, 'broken');
    assert.equal(read.integrity.reason, 'key-missing');
    assert.equal(read.integrity.verified, 0);

    const before = readFileSync(auditFile, 'utf8');
    const appended = await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent' } });
    assert.equal(appended.ok, false);
    assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
    assert.equal(readFileSync(auditFile, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('密钥文件权限过宽 → read broken/key-invalid（fail-closed，仅 POSIX）', { skip: !POSIX }, async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 2);
    const keyFile = join(dir, 'agent-audit.key.json');
    chmodSync(keyFile, 0o644);
    const read = await readAgentAudit({ auditFile });
    assert.equal(read.integrity.ok, false);
    assert.equal(read.integrity.reason, 'key-invalid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('keyFile env 覆盖：默认密钥写到 CIRCUITPILOT_AGENT_AUDIT_KEY_FILE，且状态不泄漏密钥', async () => {
  const dir = makeDir();
  const previous = process.env.CIRCUITPILOT_AGENT_AUDIT_KEY_FILE;
  try {
    const keyFile = join(dir, 'keys', 'audit.key.json');
    process.env.CIRCUITPILOT_AGENT_AUDIT_KEY_FILE = keyFile;
    const auditFile = join(dir, 'agent-audit.jsonl');
    const file = tokenFile(dir);
    await seedToken(file);
    await seedChain(auditFile, 2);

    assert.equal(existsSync(keyFile), true);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    const keyRecord = JSON.parse(readFileSync(keyFile, 'utf8'));
    assert.match(keyRecord.key, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(auditFile, 'utf8').includes(keyRecord.key), false);

    const read = await readAgentAudit({ auditFile });
    assert.equal(read.integrity.ok, true);
    assert.equal(read.integrity.verified, 2);
    assert.equal(JSON.stringify(read).includes(keyRecord.key), false);

    const status = await agentConsoleStatus({ tokenFile: file, auditFile });
    assert.equal(status.auditIntegrity.ok, true);
    assert.equal(JSON.stringify(status).includes(keyRecord.key), false, 'status 不得泄漏密钥');
  } finally {
    if (previous === undefined) delete process.env.CIRCUITPILOT_AGENT_AUDIT_KEY_FILE;
    else process.env.CIRCUITPILOT_AGENT_AUDIT_KEY_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('显式 keyFile：同目录默认键可读；换错密钥 → integrity broken/hash-mismatch', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    const keyFileA = join(dir, 'keys-a.json');
    await appendAgentAudit({ auditFile, keyFile: keyFileA, event: { kind: 'request', actor: 'agent', path: '/api/a' } });

    const good = await readAgentAudit({ auditFile, keyFile: keyFileA });
    assert.equal(good.integrity.ok, true);

    // 用另一把合法密钥校验 → 无法通过 HMAC（不是缺 key）。
    const otherAudit = join(dir, 'other.jsonl');
    const keyFileB = join(dir, 'keys-b.json');
    // head 默认名按目录固定，同一目录放第二个审计文件时必须显式指定 headFile。
    await appendAgentAudit({ auditFile: otherAudit, keyFile: keyFileB, headFile: join(dir, 'other-head.json'), event: { kind: 'request', actor: 'agent' } });
    const wrongKey = await readAgentAudit({ auditFile, keyFile: keyFileB });
    assert.equal(wrongKey.integrity.ok, false);
    assert.equal(wrongKey.integrity.reason, 'hash-mismatch');
    assert.equal(wrongKey.integrity.firstBadSeq, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status.auditIntegrity：篡改后 UI 仍拿到审计状态与事件（不抛）', async () => {
  const dir = makeDir();
  try {
    const file = tokenFile(dir);
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedToken(file);
    await seedChain(auditFile, 2);

    const okStatus = await agentConsoleStatus({ tokenFile: file, auditFile });
    assert.equal(okStatus.auditIntegrity.ok, true);
    assert.equal(okStatus.auditIntegrity.chain, 'ok');

    const lines = readJsonLines(auditFile);
    lines[0].actor = 'ui';
    writeJsonLines(auditFile, lines);
    const brokenStatus = await agentConsoleStatus({ tokenFile: file, auditFile });
    assert.equal(brokenStatus.available, true);
    assert.equal(brokenStatus.auditIntegrity.ok, false);
    assert.equal(brokenStatus.auditIntegrity.chain, 'broken');
    assert.equal(brokenStatus.auditIntegrity.reason, 'hash-mismatch');
    assert.equal(brokenStatus.audit.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('坏行 + 链混合：integrity broken/bad-line，已验链记录仍计入 verified', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 2);
    writeFileSync(auditFile, `${readFileSync(auditFile, 'utf8')}not-json-line\n`, 'utf8');
    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.ok, false);
    assert.equal(result.integrity.reason, 'bad-line');
    assert.equal(result.integrity.badLines, 1);
    assert.equal(result.integrity.verified, 2);
    assert.equal(result.total, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agentAuditKeyFile：env 覆盖优先，否则同目录 agent-audit.key.json', () => {
  assert.equal(
    agentAuditKeyFile('/tmp/a/agent-audit.jsonl', { CIRCUITPILOT_AGENT_AUDIT_KEY_FILE: '/tmp/k.json' }),
    '/tmp/k.json',
  );
  assert.equal(agentAuditKeyFile('/tmp/a/agent-audit.jsonl', {}), join('/tmp/a', 'agent-audit.key.json'));
});


// ---------------------------------------------------------------------------
// task-31：链头锚点（head anchor）——检测尾部删除
// ---------------------------------------------------------------------------

const readHeadFile = (dir) => JSON.parse(readFileSync(join(dir, 'agent-audit.head.json'), 'utf8'));

test('head 锚点：append 后写入 0600 头文件，read 标记 anchored 且 headSeq/headHash 正确', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 3);
    const lines = readJsonLines(auditFile);

    const headFile = join(dir, 'agent-audit.head.json');
    assert.equal(existsSync(headFile), true);
    assert.equal(statSync(headFile).mode & 0o777, 0o600);
    const head = readHeadFile(dir);
    assert.equal(head.version, 1);
    assert.equal(head.seq, 3);
    assert.equal(head.hash, lines[2].hash);
    assert.equal(Number.isNaN(Date.parse(head.updatedAt)), false);

    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.ok, true);
    assert.equal(result.integrity.chain, 'ok');
    assert.equal(result.integrity.anchored, true);
    assert.equal(result.integrity.headSeq, 3);
    assert.equal(result.integrity.headHash, lines[2].hash);

    const status = await agentConsoleStatus({ tokenFile: tokenFile(dir), auditFile });
    assert.equal(status.auditIntegrity.anchored, true);
    assert.equal(status.auditIntegrity.headSeq, 3);
    assert.equal(JSON.stringify(status).includes('agent-audit.head'), false, 'status 不暴露 head 文件路径');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('head 锚点：CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE 覆盖默认路径；agentAuditHeadFile 优先级', async () => {
  const dir = makeDir();
  const previous = process.env.CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE;
  try {
    const headFile = join(dir, 'heads', 'custom-head.json');
    process.env.CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE = headFile;
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 2);

    assert.equal(existsSync(headFile), true);
    assert.equal(existsSync(join(dir, 'agent-audit.head.json')), false);
    assert.equal(statSync(headFile).mode & 0o777, 0o600);
    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.anchored, true);
    assert.equal(result.integrity.headSeq, 2);
  } finally {
    if (previous === undefined) delete process.env.CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE;
    else process.env.CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(agentAuditHeadFile('/tmp/a/agent-audit.jsonl', { CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE: '/tmp/h.json' }), '/tmp/h.json');
  assert.equal(agentAuditHeadFile('/tmp/a/agent-audit.jsonl', {}), join('/tmp/a', 'agent-audit.head.json'));
  assert.equal(agentAuditHeadFile('/tmp/a/agent-audit.jsonl'), '/tmp/a/agent-audit.head.json');
});

test('尾部删除：删最后一条完整记录 → broken/head-ahead，append 拒绝且不写字节', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 3);
    const lines = readJsonLines(auditFile);
    writeJsonLines(auditFile, lines.slice(0, 2));
    const before = readFileSync(auditFile, 'utf8');

    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.ok, false);
    assert.equal(result.integrity.chain, 'broken');
    assert.equal(result.integrity.reason, 'head-ahead');
    assert.equal(result.integrity.anchored, false);
    assert.equal(result.integrity.headSeq, 3);
    assert.equal(result.integrity.headHash, lines[2].hash);
    assert.equal(result.integrity.verified, 2);
    assert.equal(result.events.length, 2, '被删记录之前的事件仍返回');

    const appended = await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent' } });
    assert.equal(appended.ok, false);
    assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
    assert.equal(readFileSync(auditFile, 'utf8'), before, '尾部删除后不得继续追加');

    const status = await agentConsoleStatus({ tokenFile: tokenFile(dir), auditFile });
    assert.equal(status.auditIntegrity.chain, 'broken');
    assert.equal(status.auditIntegrity.reason, 'head-ahead');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('整文件删除：head 仍在 → read broken/head-ahead，不 500', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 2);
    const head = readHeadFile(dir);
    rmSync(auditFile);
    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.ok, false);
    assert.equal(result.integrity.chain, 'broken');
    assert.equal(result.integrity.reason, 'head-ahead');
    assert.equal(result.integrity.anchored, false);
    assert.equal(result.integrity.headSeq, head.seq);
    assert.equal(result.events.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('head 缺失：旧审计兼容 → anchored:false 不 broken；append 后补写并锚定', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 2);
    rmSync(join(dir, 'agent-audit.head.json'));

    const before = await readAgentAudit({ auditFile });
    assert.equal(before.integrity.ok, true);
    assert.equal(before.integrity.chain, 'ok');
    assert.equal(before.integrity.anchored, false);
    assert.equal(before.integrity.headSeq, null);
    assert.equal(before.integrity.headHash, null);

    await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent', path: '/api/recovered' } });
    const after = await readAgentAudit({ auditFile });
    assert.equal(after.integrity.ok, true);
    assert.equal(after.integrity.anchored, true);
    assert.equal(after.integrity.headSeq, 3);
    assert.equal(after.integrity.headHash, readJsonLines(auditFile)[2].hash);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('head 落后（崩溃窗口）：append 拒绝续链，read 标 broken/head-behind', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 3);
    const lines = readJsonLines(auditFile);
    const head = readHeadFile(dir);
    head.seq = 2;
    head.hash = lines[1].hash;
    writeFileSync(join(dir, 'agent-audit.head.json'), `${JSON.stringify(head)}\n`, 'utf8');
    const before = readFileSync(auditFile, 'utf8');

    const appended = await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent' } });
    assert.equal(appended.ok, false);
    assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
    assert.equal(readFileSync(auditFile, 'utf8'), before);

    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.ok, false);
    assert.equal(result.integrity.chain, 'broken');
    assert.equal(result.integrity.reason, 'head-behind');
    assert.equal(result.integrity.anchored, false);
    assert.equal(result.integrity.firstBadSeq, 3);
    assert.equal(result.integrity.headSeq, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('坏 head JSON：read broken/head-invalid，append 拒绝', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await seedChain(auditFile, 2);
    writeFileSync(join(dir, 'agent-audit.head.json'), 'not-json', 'utf8');
    const before = readFileSync(auditFile, 'utf8');

    const read = await readAgentAudit({ auditFile });
    assert.equal(read.integrity.ok, false);
    assert.equal(read.integrity.chain, 'broken');
    assert.equal(read.integrity.reason, 'head-invalid');
    assert.equal(read.integrity.anchored, false);
    assert.equal(read.integrity.headSeq, null);

    const appended = await appendAgentAudit({ auditFile, event: { kind: 'request', actor: 'agent' } });
    assert.equal(appended.ok, false);
    assert.equal(appended.code, 'AGENT_AUDIT_CHAIN_BROKEN');
    assert.equal(readFileSync(auditFile, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('并发 append：head 最终指向最后一条记录（seq 5/hash 一致）', async () => {
  const dir = makeDir();
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    await Promise.all(Array.from({ length: 5 }, (_, index) => appendAgentAudit({
      auditFile,
      event: { kind: 'request', actor: 'agent', note: `h${index}` },
    })));
    const lines = readJsonLines(auditFile);
    const head = readHeadFile(dir);
    assert.equal(head.seq, 5);
    assert.equal(head.hash, lines[4].hash);
    const result = await readAgentAudit({ auditFile });
    assert.equal(result.integrity.ok, true);
    assert.equal(result.integrity.anchored, true);
    assert.equal(result.integrity.headSeq, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('head 写失败：审计行已落盘 → ok:true/headUpdated:false/warning，不抛不删行', { skip: !POSIX }, async () => {
  const dir = makeDir();
  const headDir = join(dir, 'head-dir');
  try {
    const auditFile = join(dir, 'agent-audit.jsonl');
    mkdirSync(headDir, { recursive: true, mode: 0o700 });
    const headFile = join(headDir, 'agent-audit.head.json');
    await appendAgentAudit({ auditFile, headFile, event: { kind: 'request', actor: 'agent', path: '/api/1' } });
    const before = readFileSync(auditFile, 'utf8');

    chmodSync(headDir, 0o500);
    const appended = await appendAgentAudit({ auditFile, headFile, event: { kind: 'request', actor: 'agent', path: '/api/2' } });
    assert.equal(appended.ok, true);
    assert.equal(appended.headUpdated, false);
    assert.equal(typeof appended.warning, 'string');
    assert.notEqual(readFileSync(auditFile, 'utf8'), before, '审计行必须已落盘');
    assert.equal(readJsonLines(auditFile).length, 2);

    // head 仍是旧锚点 → 读侧 fail-closed 标 head-behind，提示人工核对。
    const read = await readAgentAudit({ auditFile, headFile });
    assert.equal(read.integrity.ok, false);
    assert.equal(read.integrity.reason, 'head-behind');
  } finally {
    chmodSync(headDir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
