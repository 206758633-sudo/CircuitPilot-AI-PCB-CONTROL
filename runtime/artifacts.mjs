/**
 * 产物落盘（运行时侧）——把 EDA 渲染进程里导出的文件**分片取回并写盘**。
 *
 * 为什么需要它：EDA Pro 的 `sys_FileSystem` 在本机环境不可用
 * （`getDocumentsPath()` 返回空串、`saveFileToFileSystem()` 返回 false、
 *  `getProjectsPaths()` 报"非半、全离线客户端环境无法调用本接口"），
 * 所以"3D/制造文件落盘"这件事必须由运行时进程完成，而不是 EDA 侧。
 *
 * 三条不可让步的规则：
 *  1. 分片序号必须连续、字节数必须与声明一致，否则**删掉半截文件**并明确失败；
 *  2. 总字节数与导出声明不一致 → `EXPORT_SIZE_MISMATCH`，绝不留下"看起来有文件"的残骸；
 *  3. 渲染进程换了会话（导出缓冲丢失）→ `EXPORT_BUFFER_LOST`，让上层重新导出，
 *     **绝不**把不完整的文件当成功交出去。
 */
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_CHUNK_RETRIES = 3;

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const unwrap = (payload) => payload?.result?.result ?? payload?.result ?? payload?.data ?? payload;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 取一片；分片级瞬时故障（网络抖动/桥接繁忙）可重试，缓冲丢失则立刻失败。 */
async function fetchChunk({ execute, exportId, index, retries, sleep, attempts = [] }) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let result;
    try {
      // 通用分片读取器：与文件种类无关（3D / Gerber / BOM / CPL 共用同一条通道）。
      // 历史上叫 `pcb.3d.chunk`，桥里两个 id 指向同一实现，这里统一用语义正确的那个。
      result = unwrap(await execute('pcb.export.chunk', { exportId, index }));
    } catch (error) {
      lastError = fail('EXPORT_CHUNK_TRANSPORT', `第${index}片取回失败：${error?.message || error}`, { cause: error?.code ?? null });
      if (attempt < retries) { await sleep(200 * attempt); continue; }
      throw lastError;
    }
    if (result?.error === 'EDA_EXPORT_BUFFER_LOST') {
      throw fail('EXPORT_BUFFER_LOST', 'EDA 渲染进程的导出缓冲已失效（多半是渲染进程重载过），需要重新导出', { exportId });
    }
    if (result?.error) {
      lastError = fail('EXPORT_CHUNK_REJECTED', `EDA 拒绝了第${index}片：${result.error}`, { detail: result.error, total: result.total ?? null });
    } else if (typeof result?.base64 === 'string' && Number.isInteger(result.bytes) && Number.isInteger(result.index)) {
      attempts.push(attempt);
      return result;
    } else {
      lastError = fail('EXPORT_CHUNK_UNKNOWN_RESULT', `第${index}片返回结构不可识别`, { detail: result ?? null });
    }
    if (attempt < retries) await sleep(200 * attempt);
  }
  throw lastError;
}

/**
 * 拉取一个导出缓冲并落盘。
 * @returns {Promise<{path:string,bytes:number,sha256:string,chunks:number,retriesUsed:number}>}
 */
export async function pullExport({
  execute, exportId, targetPath, totalBytes = null, chunks = null,
  retries = DEFAULT_CHUNK_RETRIES, sleep = defaultSleep, onProgress = null,
}) {
  if (typeof execute !== 'function') throw fail('EXPORT_EXECUTE_REQUIRED', 'pullExport 需要 execute 函数');
  if (typeof exportId !== 'string' || !exportId) throw fail('EXPORT_ID_REQUIRED', '导出缓冲ID不能为空');
  if (typeof targetPath !== 'string' || !targetPath.trim()) throw fail('EXPORT_TARGET_REQUIRED', '落盘路径不能为空');
  if (totalBytes !== null && (!Number.isInteger(totalBytes) || totalBytes <= 0)) throw fail('EXPORT_SIZE_INVALID', '声明的字节数必须是正整数');

  mkdirSync(dirname(targetPath), { recursive: true });
  const hash = createHash('sha256');
  const retryCounts = [];
  let total = chunks;
  let written = 0;
  let index = 0;
  let fd = null;
  try {
    fd = openSync(targetPath, 'w');
    for (;;) {
      const chunk = await fetchChunk({ execute, exportId, index, retries, sleep, attempts: retryCounts });
      const buffer = Buffer.from(chunk.base64, 'base64');
      if (buffer.byteLength !== chunk.bytes) {
        throw fail('EXPORT_CHUNK_CORRUPT', `第${index}片解码后字节数不符（声明${chunk.bytes}，实得${buffer.byteLength}）`, { exportId, index });
      }
      writeSync(fd, buffer);
      hash.update(buffer);
      written += buffer.byteLength;
      if (total === null) total = chunk.total;
      else if (chunk.total !== total) throw fail('EXPORT_CHUNK_TOTAL_CHANGED', `分片总数在取回过程中变化（${total} → ${chunk.total}）`, { exportId, index });
      onProgress?.({ index, total, written, size: chunk.size });
      index += 1;
      if (index >= total) break;
    }
    closeSync(fd);
    fd = null;
    if (totalBytes !== null && written !== totalBytes) {
      throw fail('EXPORT_SIZE_MISMATCH', `落盘字节数不符（声明${totalBytes}，实得${written}）`, { exportId, targetPath });
    }
    return { path: targetPath, bytes: written, sha256: hash.digest('hex'), chunks: index, retriesUsed: retryCounts.reduce((sum, n) => sum + (n - 1), 0) };
  } catch (error) {
    if (fd !== null) { try { closeSync(fd); } catch { /* 已关闭 */ } }
    // 关键：任何失败都不留半截文件——否则"文件存在"会被下游当成"导出成功"。
    try { unlinkSync(targetPath); } catch { /* 本来就没建起来 */ }
    throw error;
  }
}

/**
 * 一步到位：让 EDA 导出贴装整机 3D，再分片取回落盘。
 * 这是"输出贴片好的 PCBA 3D 模型"这条链在运行时侧的唯一入口。
 */
export async function exportAssembled3d({ execute, targetPath, fileName = 'CircuitPilot-Assembled-3D', ...rest }) {
  const meta = unwrap(await execute('pcb.3d.export', { fileName }));
  if (!meta || typeof meta.exportId !== 'string') {
    throw fail('EXPORT_UNAVAILABLE', 'EDA 未返回可用的3D导出（可能未打开PCB文档）', { meta: meta ?? null });
  }
  if (!(meta.size > 0)) throw fail('EXPORT_EMPTY', 'EDA 导出的3D文件为空', { meta });
  const saved = await pullExport({ execute, exportId: meta.exportId, targetPath, totalBytes: meta.size, chunks: meta.chunks, ...rest });
  return {
    ...saved,
    name: meta.name ?? null,
    elements: meta.elements ?? null,
    modelMode: meta.modelMode ?? null,
    declaredSize: meta.size,
  };
}

/**
 * 一步到位：让 EDA 导出制造文件（Gerber/BOM/CPL），再分片取回落盘。
 * 与 3D 同一条通道，因此同样享受"字节数不符即删文件、缓冲丢失即失败"的保证。
 */
export async function exportManufactureFile({ execute, kind, targetPath, fileName = 'CircuitPilot-Export', ...rest }) {
  if (!['gerber', 'bom', 'cpl'].includes(kind)) throw fail('EXPORT_KIND_UNSUPPORTED', `制造文件种类不支持：${kind}`);
  const meta = unwrap(await execute('pcb.manufacture.export', { kind, fileName }));
  if (meta?.error) throw fail('EXPORT_REJECTED', `EDA 拒绝导出（${meta.error}）`, { detail: meta.error });
  if (!meta || typeof meta.exportId !== 'string') {
    throw fail('EXPORT_UNAVAILABLE', 'EDA 未返回可用的制造文件导出（多半没打开 PCB 文档）', { meta: meta ?? null });
  }
  if (!(meta.size > 0)) throw fail('EXPORT_EMPTY', `EDA 导出的 ${kind} 文件为空`, { meta });
  const saved = await pullExport({ execute, exportId: meta.exportId, targetPath, totalBytes: meta.size, chunks: meta.chunks, ...rest });
  return { ...saved, kind, name: meta.name ?? null, declaredSize: meta.size };
}
