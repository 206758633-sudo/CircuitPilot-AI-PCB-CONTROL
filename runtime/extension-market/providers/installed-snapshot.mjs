import { readFileSync } from 'node:fs';

/**
 * 已装扩展快照 provider（local-fs）。
 *
 * 为什么是“快照”而不是直接读 IndexedDB：
 *   - 已装清单不在明文目录里，而在 Electron userData 的 IndexedDB（LevelDB + snappy + V8 structured-clone）；
 *   - 直接解析需要自己处理 .ldb/.log 合并、sequence number 与 tombstone，属于逆向内部存储，
 *     跨 EDA 版本会漂移。v0 先消费离线提取器产出的 JSON 快照，把“解析”和“能力归一化”解耦；
 *   - 真实提取器见 artifacts/ext-market/probe/extract-registry-v1.mjs（只读，不写 EDA 数据目录）。
 *
 * 失败必须显式：文件不存在/损坏 → 抛 EXT_SOURCE_UNAVAILABLE，由上层做失败隔离，
 * 不能返回空数组冒充“没有安装扩展”。
 */
export const INSTALLED_SNAPSHOT_CODES = Object.freeze({
  UNAVAILABLE: 'EXT_SOURCE_UNAVAILABLE',
  PARSE_FAILED: 'EXT_SOURCE_PARSE_FAILED',
});

const coded = (code, message) => Object.assign(new Error(message), { code });

export function createInstalledSnapshotProvider({ file, readFile = readFileSync, help = null } = {}) {
  if (!file || typeof file !== 'string') throw coded(INSTALLED_SNAPSHOT_CODES.UNAVAILABLE, 'installed-snapshot provider 需要快照文件路径');
  return Object.freeze({
    id: 'local-installed',
    kind: 'local-fs',
    source: `file:${file}`,
    readOnly: true,
    timeoutMs: 3_000,
    async run() {
      let raw;
      try {
        raw = JSON.parse(String(readFile(file, 'utf8')));
      } catch (error) {
        if (error?.code === 'ENOENT') throw coded(INSTALLED_SNAPSHOT_CODES.UNAVAILABLE, `扩展快照不存在：${file}`);
        throw coded(INSTALLED_SNAPSHOT_CODES.PARSE_FAILED, `扩展快照解析失败：${String(error?.message || error).slice(0, 160)}`);
      }
      const items = Array.isArray(raw?.extensions) ? raw.extensions : Array.isArray(raw) ? raw : null;
      if (!items) throw coded(INSTALLED_SNAPSHOT_CODES.PARSE_FAILED, '扩展快照缺少 extensions 数组');
      return {
        items,
        // 诚实标注：v1 提取器未按 LevelDB sequence 合并、未处理 tombstone，快照可能含历史记录。
        degraded: raw?.recordCount && raw.recordCount > items.length ? 'SNAPSHOT_MAY_CONTAIN_HISTORY' : null,
        meta: { probedAt: raw?.probedAt ?? null, sourceDir: raw?.sourceDir ?? null, recordCount: raw?.recordCount ?? items.length, help },
      };
    },
  });
}
