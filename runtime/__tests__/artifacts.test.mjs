import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportAssembled3d, pullExport } from '../artifacts.mjs';

const CHUNK = 262144;

/** 假 execute：把一段内容按分片协议回给运行时，形状与桥接回包一致。 */
function fakeExport(content, { onChunk = null } = {}) {
  const total = Math.ceil(content.length / CHUNK);
  return async (commandId, args) => {
    if (commandId === 'pcb.3d.export') {
      return { result: { exportId: 'exp-test1234-abcd', name: 'CP-Assembled-3D', size: content.length, chunkSize: CHUNK, chunks: total, elements: ['Component Model'], modelMode: 'Outfit' } };
    }
    assert.equal(commandId, 'pcb.export.chunk');
    if (onChunk) { const override = onChunk(args.index); if (override !== undefined) return override; }
    const start = args.index * CHUNK;
    const slice = content.subarray(start, Math.min(start + CHUNK, content.length));
    return { result: { index: args.index, total, bytes: slice.length, size: content.length, base64: slice.toString('base64') } };
  };
}

const workDir = () => mkdtempSync(join(tmpdir(), 'cp-artifacts-'));

test('分片取回并落盘：内容、字节数与 sha256 全部可核（这是"文件存在"能否算"导出成功"的分界）', async () => {
  const content = Buffer.alloc(CHUNK * 2 + 1234, 7);
  const target = join(workDir(), 'out.step');
  const progress = [];
  const saved = await pullExport({
    execute: fakeExport(content), exportId: 'exp-test1234-abcd', targetPath: target,
    totalBytes: content.length, onProgress: (p) => progress.push(p.index),
  });
  assert.equal(saved.bytes, content.length);
  assert.equal(saved.chunks, 3);
  assert.equal(saved.retriesUsed, 0);
  assert.equal(saved.sha256, createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(readFileSync(target), content);
  assert.deepEqual(progress, [0, 1, 2]);
});

test('渲染进程缓冲丢失：明确抛 EXPORT_BUFFER_LOST，且不留半截文件', async () => {
  const content = Buffer.alloc(CHUNK * 2, 1);
  const dir = workDir();
  const target = join(dir, 'out.step');
  const execute = fakeExport(content, { onChunk: (index) => (index === 1 ? { result: { error: 'EDA_EXPORT_BUFFER_LOST' } } : undefined) });
  await assert.rejects(
    () => pullExport({ execute, exportId: 'exp-test1234-abcd', targetPath: target, totalBytes: content.length, sleep: async () => {} }),
    (error) => error.code === 'EXPORT_BUFFER_LOST',
  );
  assert.deepEqual(readdirSync(dir), [], '失败后不能留下任何半截产物');
});

test('字节数与声明不符：抛 EXPORT_SIZE_MISMATCH 并清理（绝不能"看起来有文件"就算成功）', async () => {
  const content = Buffer.alloc(CHUNK + 10, 3);
  const dir = workDir();
  const target = join(dir, 'out.step');
  await assert.rejects(
    () => pullExport({ execute: fakeExport(content), exportId: 'exp-test1234-abcd', targetPath: target, totalBytes: content.length + 5, sleep: async () => {} }),
    (error) => error.code === 'EXPORT_SIZE_MISMATCH',
  );
  assert.deepEqual(readdirSync(dir), []);
});

test('分片瞬时故障可重试：第0片先失败两次再成功，最终文件正确且重试次数可追溯', async () => {
  const content = Buffer.from('circuitpilot-assembled-3d');
  const target = join(workDir(), 'out.step');
  let failures = 0;
  const execute = fakeExport(content, {
    onChunk: (index) => {
      if (index === 0 && failures < 2) { failures += 1; return { result: { index: 0, total: 1, bytes: 0, size: 0 } }; }
      return undefined;
    },
  });
  const saved = await pullExport({ execute, exportId: 'exp-test1234-abcd', targetPath: target, totalBytes: content.length, sleep: async () => {} });
  assert.equal(saved.retriesUsed, 2);
  assert.deepEqual(readFileSync(target), content);
});

test('分片解码字节数不符 → EXPORT_CHUNK_CORRUPT（拒绝把损坏的分片写进产物）', async () => {
  const dir = workDir();
  const target = join(dir, 'out.step');
  const execute = async (commandId) => (commandId === 'pcb.3d.export'
    ? { result: { exportId: 'exp-test1234-abcd', size: 100, chunks: 1 } }
    : { result: { index: 0, total: 1, bytes: 99, size: 100, base64: Buffer.from('short').toString('base64') } });
  await assert.rejects(
    () => pullExport({ execute, exportId: 'exp-test1234-abcd', targetPath: target, totalBytes: 100, sleep: async () => {} }),
    (error) => error.code === 'EXPORT_CHUNK_CORRUPT',
  );
  assert.deepEqual(readdirSync(dir), []);
});

test('exportAssembled3d 一步到位：导出参数与落盘结果一起返回，供生产链记录不可变证据', async () => {
  const content = Buffer.from('STEP;assembled;board+components');
  const target = join(workDir(), 'CP-Assembled-3D.step');
  const result = await exportAssembled3d({ execute: fakeExport(content), targetPath: target });
  assert.equal(result.declaredSize, content.length);
  assert.equal(result.bytes, content.length);
  assert.equal(result.modelMode, 'Outfit');
  assert.deepEqual(result.elements, ['Component Model']);
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(readFileSync(target), content);
});

test('EDA 没有可用的3D导出（未打开PCB/文档类型不对）→ EXPORT_UNAVAILABLE，不静默产出空文件', async () => {
  const dir = workDir();
  await assert.rejects(
    () => exportAssembled3d({ execute: async () => ({ result: null }), targetPath: join(dir, 'x.step') }),
    (error) => error.code === 'EXPORT_UNAVAILABLE',
  );
  assert.deepEqual(readdirSync(dir), []);
});
