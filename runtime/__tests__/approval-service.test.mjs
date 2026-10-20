import assert from 'node:assert/strict';
import test from 'node:test';
import { APPROVAL_SERVICE_SCOPES, createApprovalService } from '../approval-service.mjs';

const bindings = { planHash: 'plan-1', targetFingerprint: 'fp-1', windowId: 'window-1' };

test('统一批准服务：签发不含令牌原文、列表只给公开字段、消费一次性且重放被拒', () => {
  let now = 1_000_000;
  const events = [];
  const service = createApprovalService({ now: () => now, onEvent: (event) => events.push(event) });
  const issued = service.issue({ scope: 'plan', bindings, ttlMs: 60_000 });
  assert.equal(issued.scope, 'plan');
  assert.ok(issued.token && issued.token.length > 20);
  assert.equal(issued.expiresAt, now + 60_000);
  // 公开列表/快照不允许出现令牌原文，也不允许把 tokenDigest 当公开字段发给 UI。
  const listed = service.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['approvalId', 'bindings', 'expiresAt', 'issuedAt', 'note', 'scope'].sort());
  assert.ok(!JSON.stringify(listed).includes(issued.token));

  const consumed = service.consumeToken({ token: issued.token, requiredScope: 'plan', expectedBindings: bindings });
  assert.equal(consumed.usedAt, now);
  assert.throws(() => service.consumeToken({ token: issued.token, requiredScope: 'plan', expectedBindings: bindings }), { code: 'APPROVAL_REPLAYED' });
  assert.deepEqual(events.map((event) => event.action), ['issued', 'consumed', 'replayed']);
});

test('统一批准服务：绑定/作用域不匹配不消费，令牌仍可用（便于人工核对后重试）', () => {
  const service = createApprovalService();
  const issued = service.issue({ scope: 'write', bindings: { fingerprint: 'fp-a' } });
  assert.throws(() => service.consumeToken({ token: issued.token, requiredScope: 'write', expectedBindings: { fingerprint: 'fp-b' } }), { code: 'APPROVAL_MISMATCH' });
  assert.equal(service.list().length, 1, '绑定不匹配不能把批准用掉');
  assert.throws(() => service.consumeToken({ token: issued.token, requiredScope: 'plan' }), { code: 'APPROVAL_SCOPE_MISMATCH' });
  assert.equal(service.consumeToken({ token: issued.token, requiredScope: 'write', expectedBindings: { fingerprint: 'fp-a' } }).scope, 'write');
  assert.equal(service.list().length, 0);
});

test('统一批准服务：过期/撤销/未知令牌分别给出明确错误码', () => {
  let now = 1_000;
  const service = createApprovalService({ now: () => now });
  const expiring = service.issue({ scope: 'plan', bindings: {}, ttlMs: 100 });
  now = 1_101;
  assert.throws(() => service.consumeToken({ token: expiring.token }), { code: 'APPROVAL_EXPIRED' });
  assert.equal(service.list().length, 0, '过期批准不应再出现在可用列表里');

  const revokable = service.issue({ scope: 'release', bindings: {} });
  service.revokeToken({ token: revokable.token });
  assert.throws(() => service.consumeToken({ token: revokable.token }), { code: 'APPROVAL_INVALID' });
  assert.throws(() => service.revokeToken({ token: revokable.token }), { code: 'APPROVAL_INVALID' });
  assert.throws(() => service.consumeToken({ token: 'never-issued' }), { code: 'APPROVAL_INVALID' });
});

test('统一批准服务：批量 resolve 原子消费（缺一个则一个都不消费），match 可校验配方/指纹', () => {
  const service = createApprovalService();
  const plan = service.issue({ scope: 'plan', bindings: { planHash: 'p1' } });
  const write = service.issue({ scope: 'write', bindings: { recipeId: 'pcb-rebuild-pours', fingerprint: 'fp-1' } });
  const wrongRecipe = service.issue({ scope: 'write', bindings: { recipeId: 'other-recipe' } });

  const failed = service.resolve({ approvalIds: [plan.approvalId, wrongRecipe.approvalId], requiredScopes: ['plan', 'write'], match: (record) => record.scope !== 'write' || record.bindings.recipeId === 'pcb-rebuild-pours' });
  assert.equal(failed.ok, false);
  assert.equal(failed.missing.length, 1);
  assert.equal(failed.missing[0].scope, 'write');
  assert.equal(service.list().length, 3, '批量失败时不得部分消费');

  const ok = service.resolve({ approvalIds: [plan.approvalId, write.approvalId], requiredScopes: ['plan', 'write'], match: (record) => record.scope !== 'write' || record.bindings.recipeId === 'pcb-rebuild-pours' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.approvals, { plan: true, write: true });
  assert.equal(service.list().length, 1);
});

test('统一批准服务：默认作用域与参数校验、容量上限淘汰最旧批准', () => {
  assert.deepEqual([...APPROVAL_SERVICE_SCOPES], ['plan', 'write', 'release']);
  const service = createApprovalService({ maxEntries: 2 });
  assert.throws(() => service.issue({ scope: 'payment' }), { code: 'APPROVAL_SCOPE_INVALID' });
  assert.throws(() => service.issue({ scope: 'plan', ttlMs: -1 }), { code: 'APPROVAL_TTL_INVALID' });
  assert.throws(() => createApprovalService({ maxEntries: 0 }), { code: 'APPROVAL_CAPACITY_INVALID' });
  const first = service.issue({ scope: 'plan' });
  service.issue({ scope: 'plan' });
  service.issue({ scope: 'plan' });
  // 容量 2：最早的被淘汰，后两个仍在。
  assert.equal(service.list().length, 2);
  assert.ok(!service.list().some((item) => item.approvalId === first.approvalId));
});
