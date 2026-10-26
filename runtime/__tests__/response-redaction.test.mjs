import test from 'node:test';
import assert from 'node:assert/strict';
import { publicResponseBody } from '../server.mjs';

test('响应脱敏：sessionProof 以 sk/pk/rk 开头时不能被当成 API key 擦掉', () => {
  for (const prefix of ['sk', 'pk', 'rk']) {
    const sessionProof = `${prefix}-test-session-token-0123456789`;
    const safe = publicResponseBody({ ok: true, sessionProof });
    assert.equal(safe.sessionProof, sessionProof, `${prefix} 开头的会话令牌被响应脱敏吞掉`);
  }
});

test('响应脱敏：公开字段恢复不等于放开密钥，apiKey/token 仍然整值擦除', () => {
  const safe = publicResponseBody({
    ok: true,
    sessionProof: 'sk-test-session-token-0123456789',
    apiKey: 'sk-live-should-be-redacted-0123456789',
    nested: { token: 'sk-nested-should-be-redacted-0123456789' },
  });
  assert.equal(safe.apiKey, '[REDACTED]');
  assert.equal(safe.nested.token, '[REDACTED]');
  assert.equal(safe.sessionProof, 'sk-test-session-token-0123456789');
});
