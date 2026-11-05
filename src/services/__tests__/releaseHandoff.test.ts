import { beforeEach, describe, expect, it } from 'vitest';
import { RELEASE_HANDOFF_KEY, readReleaseHandoff } from '../releaseBindingStore';

/**
 * UI P2-5（2026-11-05 审计）：readiness 交接（AssetsPage → ValidationPage）的读取校验。
 * 修复前 ValidationPage 直接 JSON.parse sessionStorage 后无条件信任：
 * 切项目后旧交接仍被预填，隔天再来也照样把过期哈希当成"本次"签核证据。
 */
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const writeHandoff = (payload: unknown) => sessionStorage.setItem(RELEASE_HANDOFF_KEY, JSON.stringify(payload));

const baseHandoff = {
  manifestHash: 'm'.repeat(64),
  binding: { projectId: 'eda-proj-a', semanticPlanHash: 'p'.repeat(64), executionId: 'exec-1' },
  savedAt: new Date(NOW - 60_000).toISOString(),
};

describe('readReleaseHandoff：项目归属与时效（UI P2-5）', () => {
  beforeEach(() => { sessionStorage.clear(); });

  it('没有交接时返回 null（不猜哈希）', () => {
    expect(readReleaseHandoff({ now: NOW })).toBeNull();
  });

  it('同项目且 24h 内：可用，staleReason 为 null', () => {
    writeHandoff(baseHandoff);
    const handoff = readReleaseHandoff({ activeProjectId: 'app-1', edaProjectUuid: 'eda-proj-a', now: NOW });
    expect(handoff?.staleReason).toBeNull();
    expect(handoff?.manifestHash).toBe('m'.repeat(64));
    expect(handoff?.binding?.semanticPlanHash).toBe('p'.repeat(64));
  });

  it('交接绑定的 EDA 工程与当前项目不一致 → 判定跨项目', () => {
    writeHandoff(baseHandoff);
    const handoff = readReleaseHandoff({ edaProjectUuid: 'eda-proj-b', now: NOW });
    expect(handoff?.staleReason).toContain('EDA 工程');
  });

  it('交接记录带 App 项目 id 且与当前项目不同 → 判定别名项目', () => {
    writeHandoff({ ...baseHandoff, projectId: 'app-other' });
    const handoff = readReleaseHandoff({ activeProjectId: 'app-1', now: NOW });
    expect(handoff?.staleReason).toContain('别的项目');
  });

  it('超过 24h → 判定过期并要求重跑 readiness', () => {
    writeHandoff({ ...baseHandoff, savedAt: new Date(NOW - DAY - 1000).toISOString() });
    const handoff = readReleaseHandoff({ now: NOW });
    expect(handoff?.staleReason).toContain('超过');
  });

  it('缺少可解析时间戳 → 判定不可校验（不当成可用交接）', () => {
    writeHandoff({ manifestHash: baseHandoff.manifestHash, binding: baseHandoff.binding });
    const handoff = readReleaseHandoff({ now: NOW });
    expect(handoff?.staleReason).toContain('时间戳');
  });

  it('时间戳在未来超过容许偏差 → 判定不可信', () => {
    writeHandoff({ ...baseHandoff, savedAt: new Date(NOW + 30 * 60_000).toISOString() });
    const handoff = readReleaseHandoff({ now: NOW });
    expect(handoff?.staleReason).toContain('未来');
  });

  it('损坏的 JSON 返回 null 而不是抛错（页面不应因交接损坏崩掉）', () => {
    sessionStorage.setItem(RELEASE_HANDOFF_KEY, '{broken');
    expect(readReleaseHandoff({ now: NOW })).toBeNull();
  });
});
