import { defineCollector } from './collect.mjs';

/**
 * EDA 库采集（W3-05）：从嘉立创 EDA 元件库读 symbol/footprint/3D 身份元数据。
 * 真机调用由调用方注入 `searchImpl`/`getImpl`（runtime 经 bridge 执行 library.device.search / lib_Device.get），
 * 采集器本身不直接访问 EDA，便于单测与失败隔离。
 */
export function createEdaLibraryCollector({ queries = [], searchImpl = null, getImpl = null, limit = 5, now = () => new Date() } = {}) {
  const list = (Array.isArray(queries) ? queries : []).map((value) => String(value ?? '').trim()).filter(Boolean);
  if (!list.length) throw Object.assign(new Error('EDA 库采集需要至少 1 个关键词/C 号'), { code: 'COLLECTOR_INVALID' });
  if (typeof searchImpl !== 'function') throw Object.assign(new Error('EDA 库采集需要注入 searchImpl'), { code: 'COLLECTOR_INVALID' });
  return defineCollector({
    id: 'eda-library',
    kind: 'part',
    source: 'eda-library',
    run: async () => {
      const items = [];
      const evidence = { queries: list, searched: 0, matched: 0, missing: [] };
      for (const query of list) {
        const mode = /^C\d+$/i.test(query) ? 'lcsc' : 'keyword';
        let results = [];
        try { results = (await searchImpl({ query, mode, limit })) ?? []; } catch (error) { evidence.missing.push({ query, code: error?.code ?? 'EDA_SEARCH_FAILED', message: String(error?.message ?? error).slice(0, 160) }); continue; }
        evidence.searched += 1;
        if (!Array.isArray(results) || !results.length) { evidence.missing.push({ query, code: 'EDA_LIBRARY_EMPTY', message: '库检索无结果（可能未登录/关键词不匹配）' }); continue; }
        const device = results[0];
        let detail = null;
        if (typeof getImpl === 'function' && device?.uuid) {
          try { detail = await getImpl({ uuid: device.uuid, libraryUuid: device.libraryUuid }); } catch { detail = null; }
        }
        const association = detail?.association ?? device.association ?? {};
        const item = {
          kind: 'part',
          title: device.name || query,
          payload: {
            lcscId: device.supplierId ?? device.lcscId ?? (/^C\d+$/i.test(query) ? query.toUpperCase() : null),
            mpn: device.manufacturerId ?? device.name ?? query,
            manufacturer: device.manufacturer ?? null,
            footprint: device.footprintName ?? association.footprint?.name ?? null,
            symbol: device.symbolName ?? association.symbol?.name ?? null,
            model3D: device.model3DName ?? association.symbol?.model3D?.name ?? null,
            libraryUuid: device.libraryUuid ?? null,
            deviceUuid: device.uuid ?? null,
            footprintUuid: device.footprintUuid ?? null,
            symbolUuid: device.symbolUuid ?? null,
            model3DUuid: device.model3DUuid ?? null,
            supplier: device.supplier ?? null,
          },
          provenance: { source: 'eda-library', url: null, version: null, fetchedAt: now().toISOString(), collector: 'eda-library' },
          trust: 'reference',
          ttlDays: 180,
        };
        if (!item.payload.lcscId) evidence.missing.push({ query, code: 'EDA_LIBRARY_LCSC_MISSING', message: '库结果没有 LCSC 料号（无法与供应链核对）' });
        items.push(item);
        evidence.matched += 1;
      }
      return { items, evidence };
    },
  });
}
