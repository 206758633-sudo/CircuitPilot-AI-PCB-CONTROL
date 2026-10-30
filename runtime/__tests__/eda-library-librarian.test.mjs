import test from 'node:test';
import assert from 'node:assert/strict';
import { createEdaLibraryCollector } from '../collectors/eda-library.mjs';
import { runCollector } from '../collectors/collect.mjs';
import { auditPartIdentity, LIBRARIAN_CODES } from '../agents/librarian.mjs';

const device = {
  uuid: 'dev-1', libraryUuid: 'lib-1', name: 'WS2812B-B/W', manufacturer: 'worldsemi', manufacturerId: 'WS2812B-B/W',
  supplier: 'LCSC', supplierId: 'C114586', footprintName: 'LED-SMD_4P-L5.0-W5.0-BL_TC5050RGB',
  symbolName: 'WS2812B-B', model3DName: 'LED-SMD_4P-L5.0-W5.0-BL_TC5050RGB',
  symbolUuid: 'sym-1', footprintUuid: 'fp-1', model3DUuid: 'm3d-1',
};

test('EDA 库采集：symbol/footprint/3D/LCSC 身份落成候选 part 条目（reference 级，180 天）', async () => {
  const collector = createEdaLibraryCollector({ queries: ['C114586'], searchImpl: async () => [device] });
  const result = await runCollector(collector, {});
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.kind, 'part');
  assert.equal(item.payload.lcscId, 'C114586');
  assert.equal(item.payload.footprint, device.footprintName);
  assert.equal(item.payload.symbol, device.symbolName);
  assert.equal(item.payload.model3D, device.model3DName);
  assert.equal(item.payload.symbolUuid, 'sym-1');
  assert.equal(item.trust, 'reference');
  assert.equal(item.ttlDays, 180);
  assert.equal(result.evidence.matched, 1);
});

test('EDA 库采集：无结果/未登录 → 不伪造条目，记录 missing', async () => {
  const collector = createEdaLibraryCollector({ queries: ['C999999999'], searchImpl: async () => [] });
  const result = await runCollector(collector, {});
  assert.equal(result.items.length, 0);
  assert.equal(result.evidence.missing[0].code, 'EDA_LIBRARY_EMPTY');
});

test('EDA 库采集：searchImpl 抛错 → 采集器仍返回证据（失败隔离）', async () => {
  const collector = createEdaLibraryCollector({ queries: ['X1'], searchImpl: async () => { throw Object.assign(new Error('boom'), { code: 'EDA_SEARCH_TIMEOUT' }); } });
  const result = await runCollector(collector, {});
  assert.equal(result.items.length, 0);
  assert.equal(result.evidence.missing[0].code, 'EDA_SEARCH_TIMEOUT');
});

test('Librarian：三源一致 → pass，绑定 LCSC 料号', () => {
  const envelope = auditPartIdentity({
    part: { lcscId: 'C114586' },
    eda: { lcscId: 'C114586', footprint: 'SMD5050-4P', model3D: 'LED-SMD_4P', deviceUuid: 'dev-1', symbol: 'WS2812B-B' },
    supply: { lcscId: 'C114586', package: 'SMD5050-4P', model: 'WS2812B-B/W', checkedAt: '2026-10-21T00:00:00.000Z' },
    datasheet: { ok: true },
  });
  assert.equal(envelope.kind, 'lib-evidence');
  assert.equal(envelope.verdict, 'pass');
  assert.equal(envelope.subject.id, 'C114586');
  assert.equal(envelope.source.readOnly, true);
  assert.equal(envelope.findings.some((item) => item.code === LIBRARIAN_CODES.OK), true);
});

test('Librarian：缺少 EDA/供应商数据 → blocked（缺证据≠通过）', () => {
  const envelope = auditPartIdentity({ part: { lcscId: 'C114586' } });
  assert.equal(envelope.verdict, 'blocked');
  const codes = envelope.findings.map((item) => item.code);
  assert.ok(codes.includes('LIB_EDA_SOURCE_MISSING'));
  assert.ok(codes.includes('LIB_SUPPLY_SOURCE_MISSING'));
});

test('Librarian：料号不一致/封装矛盾 → blocked，且记录具体原因', () => {
  const envelope = auditPartIdentity({
    part: { lcscId: 'C114586' },
    eda: { lcscId: 'C114586', footprint: 'SMD5050-4P', model3D: 'LED-SMD_4P' },
    supply: { lcscId: 'C999999', package: 'SOT-23-6', checkedAt: 'x' },
  });
  assert.equal(envelope.verdict, 'blocked');
  const codes = envelope.findings.map((item) => item.code);
  assert.ok(codes.includes(LIBRARIAN_CODES.IDENTITY_MISMATCH));
  assert.ok(codes.includes(LIBRARIAN_CODES.PACKAGE_MISMATCH));
});

test('Librarian：仅 3D/datasheet 缺失 → 仍是 pass（warning 不阻断）', () => {
  const envelope = auditPartIdentity({
    part: { lcscId: 'C114586' },
    eda: { lcscId: 'C114586', footprint: 'SMD5050-4P', model3D: null },
    supply: { lcscId: 'C114586', package: 'SMD5050-4P', checkedAt: 'x' },
    datasheet: null,
  });
  assert.equal(envelope.verdict, 'pass');
  assert.ok(envelope.findings.some((item) => item.severity === 'warning'));
});

test('Librarian：缺少 LCSC 料号 → 直接拒绝（不能拿名字猜）', () => {
  assert.throws(() => auditPartIdentity({ part: { mpn: 'WS2812B' } }), /LCSC/);
});
