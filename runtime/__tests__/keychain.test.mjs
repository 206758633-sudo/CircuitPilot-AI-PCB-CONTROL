import assert from 'node:assert/strict';
import test from 'node:test';
import { MacKeychain, serviceFor } from '../keychain.mjs';
import { KEYCHAIN_ACCOUNT, customKeychainService } from '../config.mjs';

/**
 * Keychain 写入必须"回读自证"。
 *
 * 真实故障（macOS 26 / 打包版）：`security add-generic-password -w` 在非 tty 下会问两次密码，
 * 只喂一行时会把**空密码**写进条目却返回成功；随后所有读取都变成 KEY_NOT_CONFIGURED，
 * 用户看到的是"我明明配了 Key，还说没配"。这里用注入的 runProcess 复刻该故障面，
 * 不碰真实钥匙串。
 */
const isMac = process.platform === 'darwin';
const KEY = 'sk-test-abcdefghijklmnop';

/** 假 security CLI：可编排每次调用的成败与回读内容。 */
function fakeSecurity({ addResults = ['ok'], readResults = [KEY], onAdd } = {}) {
  const calls = [];
  const state = { stored: null };
  const run = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], stdin: options.stdin });
    if (args.includes('add-generic-password')) {
      const stdinSecret = typeof options.stdin === 'string' ? options.stdin.split('\n')[0] : null;
      const argvSecret = args[args.indexOf('-w') + 1] && args[args.indexOf('-w') + 1] !== '-U' ? args[args.indexOf('-w') + 1] : null;
      const plan = addResults.shift() ?? 'ok';
      if (plan === 'mismatch') return { ok: false, code: 44, stdout: '', stderr: "passwords don't match" };
      state.stored = onAdd ? onAdd({ stdinSecret, argvSecret, state }) : (stdinSecret ?? argvSecret);
      return { ok: true, code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('find-generic-password') && args.includes('-w')) {
      const plan = readResults.length ? readResults.shift() : state.stored;
      if (plan === 'denied') return { ok: false, code: 1, stdout: '', stderr: 'denied' };
      if (plan === null) return { ok: true, code: 0, stdout: '', stderr: '' };
      return { ok: true, code: 0, stdout: plan, stderr: '' };
    }
    if (args.includes('find-generic-password')) return { ok: true, code: 0, stdout: 'item', stderr: '' };
    if (args.includes('delete-generic-password')) { state.stored = null; return { ok: true, code: 0, stdout: '', stderr: '' }; }
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };
  return { run, calls, state };
}

test('serviceFor：内置 Provider 查声明表，自定义 Provider 按 id 派生，非法 id 拒绝', () => {
  assert.equal(serviceFor('openai_api'), 'com.circuitpilot.provider.openai');
  assert.equal(serviceFor('acme-gateway'), customKeychainService('acme-gateway'));
  assert.throws(() => serviceFor('Acme Gateway'), /Unsupported keychain provider/);
});

test('store：把密码喂给两次交互提示（而非留给 argv），回读一致才返回成功', { skip: !isMac }, async () => {
  const fake = fakeSecurity({ readResults: [KEY] });
  const keychain = new MacKeychain({ run: fake.run });
  const result = await keychain.store('acme-gateway', KEY);
  assert.equal(result.configured, true);
  assert.equal(result.hint, `••••${KEY.slice(-4)}`);
  const add = fake.calls.find((call) => call.args.includes('add-generic-password'));
  assert.ok(add, '必须调用 add-generic-password');
  assert.equal(add.args.includes(KEY), false, '密码不能出现在进程参数里（首选 stdin 通道）');
  assert.equal(add.stdin, `${KEY}\n${KEY}`, '必须同时回答 password 与 retype 两次提示');
  assert.ok(add.args.includes('-U'), '更新已存在条目需要 -U');
  assert.equal(add.args[add.args.indexOf('-a') + 1], KEYCHAIN_ACCOUNT);
});

test('store：stdin 通道被 "passwords don\'t match" 拒绝时退回 argv，仍然成功', { skip: !isMac }, async () => {
  const fake = fakeSecurity({ addResults: ['mismatch', 'ok'], readResults: [KEY] });
  const keychain = new MacKeychain({ run: fake.run });
  await keychain.store('acme-gateway', KEY);
  const adds = fake.calls.filter((call) => call.args.includes('add-generic-password'));
  assert.equal(adds.length, 2);
  assert.equal(adds[1].args[adds[1].args.indexOf('-w') + 1], KEY, '兜底方式用 argv 直传');
});

test('store：历史"空密码条目"必须被删掉重建，而不是假装保存成功', { skip: !isMac }, async () => {
  // 第一次两轮写入都只存进空密码（复刻 bug），删除重建后才真正落盘。
  let writes = 0;
  const fake = fakeSecurity({
    addResults: ['ok', 'ok', 'ok', 'ok'],
    readResults: [null, null, KEY],
    onAdd: ({ stdinSecret, argvSecret }) => {
      writes += 1;
      return writes <= 2 ? '' : (stdinSecret ?? argvSecret);
    },
  });
  const keychain = new MacKeychain({ run: fake.run });
  const result = await keychain.store('acme-gateway', KEY);
  assert.equal(result.configured, true);
  const deletes = fake.calls.filter((call) => call.args.includes('delete-generic-password'));
  assert.equal(deletes.length, 1, '空密码条目必须先删除再重建');
});

test('store：回读始终不一致时抛 KEYCHAIN_WRITE_FAILED（不能静默成功）', { skip: !isMac }, async () => {
  // 4 次回读：两轮写入各两次；全部返回空内容 = 永远校验不过。
  const fake = fakeSecurity({ addResults: ['ok', 'ok', 'ok', 'ok'], readResults: [null, null, null, null] });
  const keychain = new MacKeychain({ run: fake.run });
  await assert.rejects(() => keychain.store('acme-gateway', KEY), (error) => {
    assert.equal(error.code, 'KEYCHAIN_WRITE_FAILED');
    assert.match(error.message, /回读校验失败/);
    return true;
  });
});

test('store：格式非法的 Key 直接拒绝，不写钥匙串', { skip: !isMac }, async () => {
  const fake = fakeSecurity({});
  const keychain = new MacKeychain({ run: fake.run });
  await assert.rejects(() => keychain.store('acme-gateway', 'short'), (error) => {
    assert.equal(error.code, 'KEY_FORMAT_INVALID');
    return true;
  });
  assert.equal(fake.calls.length, 0);
});

test('read：条目存在但内容为空时，报"密钥为空，请重新保存"而不是含糊的未配置', { skip: !isMac }, async () => {
  const fake = fakeSecurity({ readResults: [null] });
  const keychain = new MacKeychain({ run: fake.run });
  await assert.rejects(() => keychain.read('acme-gateway'), (error) => {
    assert.equal(error.code, 'KEY_NOT_CONFIGURED');
    assert.match(error.message, /密钥为空/);
    assert.match(error.message, /重新保存/);
    return true;
  });
});

test('read：条目不存在时抛 KEY_NOT_CONFIGURED', { skip: !isMac }, async () => {
  const fake = fakeSecurity({ readResults: ['denied'] });
  const keychain = new MacKeychain({ run: fake.run });
  await assert.rejects(() => keychain.read('acme-gateway'), (error) => {
    assert.equal(error.code, 'KEY_NOT_CONFIGURED');
    assert.match(error.message, /未配置/);
    return true;
  });
});
