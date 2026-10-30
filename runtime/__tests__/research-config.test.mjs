import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createResearchConfig } from '../research-config.mjs';

/** WP4 P1-15：研究（联网）开关必须是 Runtime 权威、持久化、默认关闭且损坏 fail-closed。 */

const makeFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-research-'));
  return { dir, file: join(dir, 'research-config.json') };
};

test('WP4 P1-15：缺省关闭；set 后持久化，重启后仍为开启', async () => {
  const { dir, file } = makeFile();
  try {
    const config = createResearchConfig({ file });
    await config.load();
    assert.equal(config.snapshot().enabled, false);
    assert.equal(config.snapshot().version, 0);
    assert.equal(await config.get(), false);

    const saved = await config.set({ enabled: true, actor: 'lead' });
    assert.equal(saved.enabled, true);
    assert.equal(saved.actor, 'lead');
    assert.equal(saved.version, 1);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.enabled, true);
    assert.equal(typeof raw.updatedAt, 'string');

    const reopened = createResearchConfig({ file });
    assert.equal(await reopened.get(), true);
    assert.equal(reopened.snapshot().enabled, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P1-15：损坏文件 fail-closed（enabled=false）并保留 loadError', async () => {
  const { dir, file } = makeFile();
  try {
    writeFileSync(file, '{not json', 'utf8');
    const config = createResearchConfig({ file });
    assert.equal(await config.get(), false);
    assert.equal(config.snapshot().enabled, false);
    assert.ok(config.snapshot().loadError);
    // 显式重新写入后 loadError 清空。
    const saved = await config.set({ enabled: true });
    assert.equal(saved.enabled, true);
    assert.equal(saved.loadError, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P1-15：字段类型非法视为损坏（fail-closed），set 入参校验拒绝非布尔', async () => {
  const { dir, file } = makeFile();
  try {
    writeFileSync(file, JSON.stringify({ enabled: 'yes' }), 'utf8');
    const config = createResearchConfig({ file });
    assert.equal(await config.get(), false);
    assert.match(String(config.snapshot().loadError), /enabled/);

    const fresh = createResearchConfig({ file: join(dir, 'b.json') });
    await assert.rejects(() => fresh.set({ enabled: 'true' }), (error) => error.code === 'RESEARCH_CONFIG_INVALID' && error.status === 400);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P1-15：默认路径落在 CIRCUITPILOT_STATE_DIR 下（可被 server 用同一份配置）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-research-default-'));
  const previous = process.env.CIRCUITPILOT_STATE_DIR;
  try {
    process.env.CIRCUITPILOT_STATE_DIR = dir;
    const config = createResearchConfig();
    assert.equal(config.file, join(dir, 'research-config.json'));
    await config.set({ enabled: true });
    assert.equal(await createResearchConfig().get(), true);
  } finally {
    if (previous === undefined) delete process.env.CIRCUITPILOT_STATE_DIR; else process.env.CIRCUITPILOT_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
