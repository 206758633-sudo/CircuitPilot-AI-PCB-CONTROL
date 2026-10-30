import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PortableKeychain } from '../portable-keychain.mjs';

const KEY = 'sk-test-abcdefghijklmnop';

function withKeychain(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cp-portable-keychain-'));
  const keychain = new PortableKeychain({ file: path.join(dir, 'credentials.enc.json'), keyFile: path.join(dir, 'credentials.key'), platform: 'linux' });
  return Promise.resolve(fn({ dir, keychain })).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('PortableKeychain：store/read/configured/remove 往返正确，磁盘不落明文', async () => {
  await withKeychain(async ({ dir, keychain }) => {
    assert.equal(await keychain.configured('acme'), false);
    const stored = await keychain.store('acme', KEY);
    assert.equal(stored.configured, true);
    assert.match(stored.hint, /•{4}/);
    assert.equal(await keychain.configured('acme'), true);
    assert.equal(await keychain.read('acme'), KEY);
    assert.equal(readFileSync(path.join(dir, 'credentials.enc.json'), 'utf8').includes(KEY), false, '凭据文件不得包含明文');
    assert.deepEqual(await keychain.remove('acme'), { configured: false });
    await assert.rejects(() => keychain.read('acme'), (error) => error.code === 'KEY_NOT_CONFIGURED');
  });
});

test('PortableKeychain：格式非法的 Key 拒绝写入，不创建凭据文件', async () => {
  await withKeychain(async ({ dir, keychain }) => {
    await assert.rejects(() => keychain.store('acme', 'short'), (error) => error.code === 'KEY_FORMAT_INVALID');
    await assert.rejects(() => keychain.read('acme'), (error) => error.code === 'KEY_NOT_CONFIGURED');
    assert.equal(existsSync(path.join(dir, 'credentials.enc.json')), false);
  });
});
