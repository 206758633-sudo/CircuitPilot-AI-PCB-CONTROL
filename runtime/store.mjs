import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 最小可用的 JSON 状态存储（带 schemaVersion）。
 *
 * 为什么不用数据库：当前只存"可重建的少量服务端状态"（语义计划、编译计划、终审记录），
 * JSON 文件足够，而且人可以直接打开核对。关键是三点：
 *   1. **原子写**：临时文件 + rename，崩溃/断点不会留下半截 JSON；
 *   2. **schemaVersion + 显式迁移**：旧版本必须提供 `migrations[旧版本]` 逐级升级；
 *      未来版本（文件比代码新）拒绝读取，不静默降级；
 *   3. **损坏 fail-closed**：读不出来就抛错，不让"读失败"退化成"空状态"再往上放行。
 *
 * 迁移契约：`migrations[n]` 是纯函数 `(data) => data`，把 schemaVersion n 的数据升级为 n+1；
 * load 内不自动写盘（避免读操作产生副作用），迁移结果带 `migratedFrom`，由调用方决定何时 save。
 * 因此迁移函数必须幂等/可重复执行（进程在 save 前崩溃会再迁一次）。
 */

export function createJsonStore({ file, schemaVersion = 1, initial = () => ({}), now = () => new Date(), migrations = {} } = {}) {
  if (!file || typeof file !== 'string') throw Object.assign(new Error('状态文件路径不能为空'), { code: 'STORE_FILE_REQUIRED' });

  const load = () => {
    if (!existsSync(file)) return { schemaVersion, savedAt: null, data: initial() };
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw Object.assign(new Error(`状态文件损坏（不是合法 JSON）：${file}`), { code: 'STORE_CORRUPT', details: { file } });
    }
    const foundVersion = parsed?.schemaVersion ?? null;
    if (typeof foundVersion !== 'number' || !Number.isInteger(foundVersion) || foundVersion < 1) {
      throw Object.assign(new Error(`状态文件 schemaVersion 无效：${file}（实际 ${String(foundVersion)}）`), {
        code: 'STORE_SCHEMA_MISMATCH',
        details: { file, expected: schemaVersion, actual: foundVersion, direction: 'invalid' },
      });
    }
    if (foundVersion > schemaVersion) {
      // 文件由更新版本的代码写入：降级读取可能静默丢字段，直接拒绝（fail-closed）。
      throw Object.assign(new Error(`状态文件版本高于当前代码：${file}（文件 ${foundVersion} > 期望 ${schemaVersion}）`), {
        code: 'STORE_SCHEMA_MISMATCH',
        details: { file, expected: schemaVersion, actual: foundVersion, direction: 'future' },
      });
    }
    if (parsed.data === undefined) throw Object.assign(new Error(`状态文件缺 data 字段：${file}`), { code: 'STORE_CORRUPT', details: { file } });
    if (foundVersion < schemaVersion) {
      let version = foundVersion;
      let data = parsed.data;
      while (version < schemaVersion) {
        const migrate = migrations?.[version];
        if (typeof migrate !== 'function') {
          throw Object.assign(new Error(`缺少 schemaVersion ${version} → ${version + 1} 的迁移：${file}`), {
            code: 'STORE_MIGRATION_MISSING',
            details: { file, from: version, to: version + 1, expected: schemaVersion },
          });
        }
        try {
          data = migrate(data, { from: version, to: version + 1 });
        } catch (error) {
          throw Object.assign(new Error(`schemaVersion ${version} → ${version + 1} 迁移失败：${file}`), {
            code: 'STORE_MIGRATION_FAILED',
            details: { file, from: version, to: version + 1, cause: String(error?.message || error).slice(0, 160) },
          });
        }
        if (data === undefined) {
          throw Object.assign(new Error(`schemaVersion ${version} → ${version + 1} 迁移返回空数据：${file}`), {
            code: 'STORE_MIGRATION_FAILED', details: { file, from: version, to: version + 1 },
          });
        }
        version += 1;
      }
      return { schemaVersion, savedAt: parsed.savedAt ?? null, data, migratedFrom: foundVersion };
    }
    return { schemaVersion: parsed.schemaVersion, savedAt: parsed.savedAt ?? null, data: parsed.data };
  };

  const save = (data) => {
    if (data === undefined) throw Object.assign(new Error('状态内容不能为空'), { code: 'STORE_DATA_REQUIRED' });
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = { schemaVersion, savedAt: now().toISOString(), data };
    const tempPath = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(tempPath, file);
    } catch (error) {
      try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* 清理失败不掩盖原始错误 */ }
      throw Object.assign(new Error(`状态写入失败：${String(error?.message || error).slice(0, 160)}`), { code: 'STORE_WRITE_FAILED', details: { file } });
    }
    return payload;
  };

  return { file, schemaVersion, load, save };
}
