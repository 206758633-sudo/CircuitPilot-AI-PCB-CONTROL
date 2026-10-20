import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeServer } from '../server.mjs';

const fakeKeychain = { async configured() { return false; }, async read() { throw new Error('unused'); } };
const fakeGui = { async execute() { return {}; } };
const fakeBridge = { port: 49620, selectedWindowId: 'window-1', async discover() {}, async windows() { return { selectionRequired: false, windows: [{ id: 'window-1' }] }; }, async execute() { return { ok: true, result: {} }; } };

async function startServer(context, root) {
  const previousRoots = process.env.CIRCUITPILOT_DOWNLOAD_ROOTS;
  const previousStateDir = process.env.CIRCUITPILOT_STATE_DIR;
  process.env.CIRCUITPILOT_DOWNLOAD_ROOTS = root;
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge: fakeBridge, gui: fakeGui });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => {
    if (previousRoots === undefined) delete process.env.CIRCUITPILOT_DOWNLOAD_ROOTS; else process.env.CIRCUITPILOT_DOWNLOAD_ROOTS = previousRoots;
    if (previousStateDir === undefined) delete process.env.CIRCUITPILOT_STATE_DIR; else process.env.CIRCUITPILOT_STATE_DIR = previousStateDir;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  return { base, headers: { 'x-circuitpilot-token': health.sessionProof } };
}

test('产物下载：放行目录内已知类型可下载；目录外/逃逸/未知类型/缺文件一律拒绝；无令牌 401', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-download-'));
  const outside = mkdtempSync(join(tmpdir(), 'cp-download-outside-'));
  try {
    const good = join(root, 'GERBER_board.zip');
    writeFileSync(good, 'zip-bytes', 'utf8');
    const scriptFile = join(root, 'run.sh');
    writeFileSync(scriptFile, 'echo pwn', 'utf8');
    const secret = join(outside, 'secret.zip');
    writeFileSync(secret, 'secret', 'utf8');
    const { base, headers } = await startServer(context, root);

    const ok = await fetch(`${base}/api/production/download?path=${encodeURIComponent(good)}`, { headers });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'zip-bytes');
    assert.match(ok.headers.get('content-disposition') || '', /attachment/);
    assert.match(ok.headers.get('content-type') || '', /zip/);

    const missing = await fetch(`${base}/api/production/download?path=${encodeURIComponent(join(root, 'nope.zip'))}`, { headers });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'DOWNLOAD_NOT_FOUND');

    // 根目录之外的真实文件：即使路径存在也必须拒绝（防任意文件读取）。
    const escaped = await fetch(`${base}/api/production/download?path=${encodeURIComponent(secret)}`, { headers });
    assert.equal(escaped.status, 403);
    assert.equal((await escaped.json()).error.code, 'DOWNLOAD_PATH_FORBIDDEN');

    const traversal = await fetch(`${base}/api/production/download?path=${encodeURIComponent(join(root, '..', '..', 'etc', 'passwd'))}`, { headers });
    assert.notEqual(traversal.status, 200);

    const badType = await fetch(`${base}/api/production/download?path=${encodeURIComponent(scriptFile)}`, { headers });
    assert.equal(badType.status, 400);
    assert.equal((await badType.json()).error.code, 'DOWNLOAD_TYPE_FORBIDDEN');

    const noToken = await fetch(`${base}/api/production/download?path=${encodeURIComponent(good)}`);
    assert.equal(noToken.status, 401);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
