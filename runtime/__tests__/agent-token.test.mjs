import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  AGENT_TOKEN_CODES,
  AGENT_TOKEN_NAME,
  AGENT_TOKEN_SCOPES,
  agentTokenFile,
  ensureAgentTokenFile,
  generateAgentToken,
  readAgentToken,
  verifyAgentToken,
} from '../agent-token.mjs';

/**
 * 契约 docs/agent/agent-contract.md §1「Agent 身份与令牌」：
 * - 文件 0600、目录 0700，内容 {version:1,name:'dsh-plugin',token:'cpa_<48 hex>',scopes:[...],createdAt}
 * - 不存在时原子签发（临时文件 + rename）；已存在则读回校验
 * - 损坏/权限不符 fail-closed（AGENT_TOKEN_INVALID）；认证常量时间比较
 *
 * 所有用例只用 mkdtemp 临时目录，不读写真实 ~/Library。
 */

const makeTempDir = () => mkdtempSync(join(tmpdir(), 'cp-agent-token-'));
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const modeOf = (path) => statSync(path).mode & 0o777;

/** 直接落一份权限正确的合法令牌文件（用于"只测读取校验"的场景）。 */
const writeValidTokenFile = (file, overrides = {}) => {
  const record = {
    version: 1,
    name: AGENT_TOKEN_NAME,
    token: generateAgentToken(),
    scopes: [...AGENT_TOKEN_SCOPES],
    createdAt: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  chmodSync(file, 0o600);
  return record;
};

test('ensureAgentTokenFile：不存在则原子写入 cpa_+48hex，文件 0600、目录 0700', async () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, 'CircuitPilot', 'agent-token.json');
    const fixed = new Date('2026-10-29T00:00:00.000Z');
    const result = await ensureAgentTokenFile({ file, now: () => fixed });

    assert.equal(result.created, true);
    assert.equal(result.file, file);
    assert.match(result.token, /^cpa_[0-9a-f]{48}$/);

    // 落盘内容与契约完全一致。
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(saved, {
      version: 1,
      name: 'dsh-plugin',
      token: result.token,
      scopes: ['read', 'plan', 'execute'],
      createdAt: fixed.toISOString(),
    });
    assert.deepEqual(result.scopes, [...AGENT_TOKEN_SCOPES]);

    // 原子写：先写临时文件再 rename，成功后目录里不能残留 .tmp-*。
    assert.deepEqual(readdirSync(dirname(file)).filter((name) => name.includes('.tmp-')), []);

    if (process.platform !== 'win32') {
      assert.equal(modeOf(file), 0o600);
      assert.equal(modeOf(dirname(file)), 0o700);
    }

    // 读回只暴露契约字段。
    assert.deepEqual(await readAgentToken(file), { token: saved.token, name: 'dsh-plugin', scopes: ['read', 'plan', 'execute'] });
  } finally {
    cleanup(dir);
  }
});

test('ensureAgentTokenFile：已存在则读回校验、不轮换令牌（created=false）', async () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, 'agent-token.json');
    const first = await ensureAgentTokenFile({ file, now: () => new Date('2026-10-29T00:00:00.000Z') });
    const second = await ensureAgentTokenFile({ file, now: () => new Date('2027-01-01T00:00:00.000Z') });

    assert.equal(second.created, false);
    assert.equal(second.token, first.token);
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, first.token);
  } finally {
    cleanup(dir);
  }
});

test('readAgentToken：文件不存在返回 null；默认路径尊重 CIRCUITPILOT_AGENT_TOKEN_FILE', async () => {
  const dir = makeTempDir();
  const previous = process.env.CIRCUITPILOT_AGENT_TOKEN_FILE;
  try {
    assert.equal(await readAgentToken(join(dir, 'missing.json')), null);

    const envFile = join(dir, 'env-agent-token.json');
    process.env.CIRCUITPILOT_AGENT_TOKEN_FILE = envFile;
    assert.equal(agentTokenFile(), envFile);

    const created = await ensureAgentTokenFile(); // 不传 file：走环境变量
    assert.equal(created.file, envFile);
    assert.equal((await readAgentToken()).token, created.token);
  } finally {
    if (previous === undefined) delete process.env.CIRCUITPILOT_AGENT_TOKEN_FILE;
    else process.env.CIRCUITPILOT_AGENT_TOKEN_FILE = previous;
    cleanup(dir);
  }
});

test('readAgentToken：格式/字段非法一律 AGENT_TOKEN_INVALID（不回显 token，不降级放行）', async () => {
  const dir = makeTempDir();
  try {
    const token = generateAgentToken();
    const base = { version: 1, name: AGENT_TOKEN_NAME, token, scopes: [...AGENT_TOKEN_SCOPES], createdAt: '2026-10-29T00:00:00.000Z' };
    const cases = [
      ['非 JSON', '{not json'],
      ['JSON 数组', '[]'],
      ['JSON null', 'null'],
      ['version 不匹配', JSON.stringify({ ...base, version: 2 })],
      ['name 缺失', JSON.stringify({ ...base, name: '' })],
      ['token 前缀错', JSON.stringify({ ...base, token: `sk_${'a'.repeat(48)}` })],
      ['token 长度错', JSON.stringify({ ...base, token: `cpa_${'a'.repeat(47)}` })],
      ['token 非字符串', JSON.stringify({ ...base, token: 42 })],
      ['scopes 非数组', JSON.stringify({ ...base, scopes: 'read' })],
      ['scopes 空数组', JSON.stringify({ ...base, scopes: [] })],
      ['scopes 未知 scope', JSON.stringify({ ...base, scopes: ['read', 'signoff'] })],
      ['createdAt 非法', JSON.stringify({ ...base, createdAt: 'not-a-date' })],
      ['createdAt 缺失', JSON.stringify({ ...base, createdAt: undefined })],
    ];
    for (const [label, content] of cases) {
      const file = join(dir, `${label.replace(/[^a-z0-9]+/gi, '-')}.json`);
      writeFileSync(file, content, 'utf8');
      chmodSync(file, 0o600);
      await assert.rejects(
        () => readAgentToken(file),
        (error) => error.code === AGENT_TOKEN_CODES.INVALID && !String(error.message).includes(token),
        `应拒绝：${label}`,
      );
    }
  } finally {
    cleanup(dir);
  }
});

test('权限检查：group/world 有任何权限 → AGENT_TOKEN_INVALID（ensure 同样 fail-closed）', { skip: process.platform === 'win32' }, async () => {
  const dir = makeTempDir();
  try {
    for (const permissions of [0o644, 0o640, 0o604, 0o660]) {
      const file = join(dir, `mode-${permissions.toString(8)}.json`);
      await ensureAgentTokenFile({ file });
      chmodSync(file, permissions);
      await assert.rejects(
        () => readAgentToken(file),
        (error) => error.code === AGENT_TOKEN_CODES.INVALID,
        `${permissions.toString(8)} 不应被接受`,
      );
      await assert.rejects(
        () => ensureAgentTokenFile({ file }),
        (error) => error.code === AGENT_TOKEN_CODES.INVALID,
        `${permissions.toString(8)} 时 ensure 不应降级`,
      );
      // 收窄权限后恢复可读（说明拒绝原因确实是权限，而不是内容）。
      chmodSync(file, 0o600);
      assert.equal(typeof (await readAgentToken(file)).token, 'string');
    }
  } finally {
    cleanup(dir);
  }
});

test('readAgentToken：手工写入的合法文件（自定义 name/scope 子集）可读，返回契约字段', async () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, 'agent-token.json');
    const record = writeValidTokenFile(file, { name: 'custom-agent', scopes: ['read'] });
    assert.deepEqual(await readAgentToken(file), { token: record.token, name: 'custom-agent', scopes: ['read'] });
  } finally {
    cleanup(dir);
  }
});

test('generateAgentToken：cpa_ 前缀 + 48 hex，随机且互不相同', () => {
  const first = generateAgentToken();
  const second = generateAgentToken();
  assert.match(first, /^cpa_[0-9a-f]{48}$/);
  assert.match(second, /^cpa_[0-9a-f]{48}$/);
  assert.notEqual(first, second);
});

test('verifyAgentToken：命中返回 {ok,name,scopes}，其余全部返回 null 且不抛错', () => {
  const stored = {
    token: `cpa_${'ab'.repeat(24)}`,
    name: 'dsh-plugin',
    scopes: ['read', 'plan', 'execute'],
  };
  assert.deepEqual(verifyAgentToken(stored.token, stored), { ok: true, name: 'dsh-plugin', scopes: ['read', 'plan', 'execute'] });
  // 允许直接传 token 字符串（没有身份元数据时如实返回 null/[]）。
  assert.deepEqual(verifyAgentToken(stored.token, stored.token), { ok: true, name: null, scopes: [] });

  // 同长度但内容不同 → null（走 timingSafeEqual 但仍需失败）。
  assert.equal(verifyAgentToken(`cpa_${'ab'.repeat(23)}ac`, stored), null);
  // 长度不同 → null（不抛错）。
  assert.equal(verifyAgentToken('cpa_short', stored), null);
  // 类型/前缀不合法 → null。
  for (const header of [null, undefined, 42, {}, '', 'Bearer cpa_x', 'cpa_', 0]) {
    assert.equal(verifyAgentToken(header, stored), null);
  }
  // stored 缺失/非法 → null。
  for (const bad of [null, undefined, {}, { token: 42 }, { token: 'not-a-token' }, 'not-a-token']) {
    assert.equal(verifyAgentToken(stored.token, bad), null);
  }
});
