import assert from 'node:assert/strict';
import test from 'node:test';
import { executableSearchPaths, findExecutable } from '../process.mjs';

test('GUI 最小 PATH 下 cargo 仍能命中 rustup 落点（Rust/Cargo 误报的回归）', () => {
  const paths = executableSearchPaths('cargo', { homeDir: '/Users/tester', pathValue: '/usr/bin:/bin:/usr/sbin:/sbin' });
  assert.ok(paths.includes('/Users/tester/.cargo/bin/cargo'), `候选里必须有 rustup 默认落点，实际：${paths.join(', ')}`);
  assert.ok(paths.includes('/opt/homebrew/bin/cargo'));
  // 显式落点优先于 PATH 扫描：PATH 里可能放的是不可用/旧版本，但至少不会漏掉 rustup 安装。
  assert.ok(paths.indexOf('/opt/homebrew/bin/cargo') < paths.indexOf('/usr/bin/cargo'));
});

test('findExecutable 找不到时返回 null，不猜路径', async () => {
  assert.equal(await findExecutable('circuitpilot-definitely-missing-cli', { homeDir: '/nonexistent-home', pathValue: '/usr/bin:/bin' }), null);
});
