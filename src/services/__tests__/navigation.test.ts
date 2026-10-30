import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PAGES,
  DESIGN_TABS,
  GUIDED_FLOW,
  LEGACY_ALIASES,
  NAV_ITEMS,
  NAV_SHORTCUTS,
  PAGE_RESPONSIBILITIES,
  VALIDATION_TABS,
  resolveAlias,
} from '../../navigation';
import { STAGE_ORDER } from '../stageMachine';
import type { PageId } from '../../types';

// D6：信息架构是数据驱动的单一事实源，任何页面/导航/旧别名增删都必须过这些断言。
const ALL_PAGE_IDS: PageId[] = [
  'overview', 'design', 'projects', 'requirements', 'assets', 'ai',
  'eda', 'automation', 'placement', 'validation', 'knowledge', 'versions', 'settings', 'proposal',
];

describe('D6 信息架构：导航/页面职责/旧别名/新手链路一致', () => {
  it('每个 PageId 都有且仅有一份页面职责（回答什么问题、主操作、交接）', () => {
    expect(Object.keys(PAGE_RESPONSIBILITIES).sort()).toEqual([...ALL_PAGE_IDS].sort());
    for (const page of ALL_PAGE_IDS) {
      const responsibility = PAGE_RESPONSIBILITIES[page];
      expect(responsibility.title.length).toBeGreaterThan(0);
      expect(responsibility.description.length).toBeGreaterThan(0);
      expect(responsibility.question.length).toBeGreaterThan(0);
      expect(responsibility.handoff.length).toBeGreaterThan(0);
      expect(ALL_PAGE_IDS).toContain(responsibility.primaryAction.page);
      expect(responsibility.primaryAction.label.length).toBeGreaterThan(0);
    }
  });

  it('主导航项唯一、都在规范页面里，且规范页面 = 导航项 + 系统设置 + 项目页', () => {
    const ids = NAV_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...CANONICAL_PAGES].sort()).toEqual([...ids, 'settings', 'projects'].sort());
    for (const id of ids) expect(ALL_PAGE_IDS).toContain(id);
  });

  it('一级快捷入口（项目/需求约束/布局微调）指向真实可达页面与页签，且不与主导航重名', () => {
    // 回归守护：D6 合并入口后这三项曾在一级导航里消失，用户找不到。
    const ids = NAV_SHORTCUTS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const navIds = NAV_ITEMS.map((item) => String(item.id));
    for (const item of NAV_SHORTCUTS) {
      expect(navIds).not.toContain(item.id);
      expect(ALL_PAGE_IDS).toContain(item.page);
      expect(CANONICAL_PAGES).toContain(item.page);
      expect(item.label.length).toBeGreaterThan(0);
      if (item.tab) {
        const allowed: string[] = item.page === 'design' ? DESIGN_TABS : VALIDATION_TABS;
        expect(allowed).toContain(item.tab);
      }
    }
    // 三项必须齐全：用户可以没有别的偏好，但这三项是"建立项目 → 约束 → 布局微调"的主链路。
    expect(ids).toEqual(expect.arrayContaining(['projects', 'requirements', 'placement']));
  });

  it('旧 hash 别名全部落到规范页面（历史书签不失效，也不会指回自己成环）', () => {
    for (const [alias, target] of Object.entries(LEGACY_ALIASES)) {
      expect(ALL_PAGE_IDS).toContain(alias as PageId);
      expect(CANONICAL_PAGES).toContain(target.page);
      expect(resolveAlias(alias)).toEqual(target);
      if (target.tab) {
        const allowed: string[] = target.page === 'design' ? DESIGN_TABS : VALIDATION_TABS;
        expect(allowed).toContain(target.tab);
      }
    }
    // 规范页面不能同时是旧别名（否则路由判定顺序会打架）
    for (const page of CANONICAL_PAGES) expect(LEGACY_ALIASES[page]).toBeUndefined();
    // 项目页是规范页面（左上角项目卡进入），不是旧别名
    expect(CANONICAL_PAGES).toContain('projects');
    expect(LEGACY_ALIASES.projects).toBeUndefined();
  });

  it('新手完整链路按阶段机顺序覆盖 需求→选型→原理图→PCB→验证→生产', () => {
    expect(GUIDED_FLOW.length).toBeGreaterThanOrEqual(6);
    const stages = GUIDED_FLOW.map((step) => step.stage);
    const expected = ['需求', '选型', '原理图', 'PCB', '验证', '生产'];
    const indexes = expected.map((stage) => stages.indexOf(stage));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect([...indexes].sort((left, right) => left - right)).toEqual(indexes);
    // 链路里的页面必须真实可达（规范页面）
    for (const step of GUIDED_FLOW) expect(CANONICAL_PAGES).toContain(step.page);
    for (const step of GUIDED_FLOW) {
      if (!step.tab) continue;
      const allowed: string[] = step.page === 'design' ? DESIGN_TABS : VALIDATION_TABS;
      expect(allowed).toContain(step.tab);
    }
    // 阶段名必须来自阶段机，避免页面自己发明一套阶段
    for (const stage of stages) expect((STAGE_ORDER as readonly string[]).includes(stage)).toBe(true);
  });

  it('交付步骤必须落在有导出/放行入口的页面，追溯步骤落在版本页（防止导错页）', () => {
    // 全流程的导出、放行闸门、签核、下单参数卡都在「验证与交付」页；
    // 「版本与问题」页只有证据核对/发布归档，不能承载"交付导出"。
    const deliver = GUIDED_FLOW.find((step) => step.id === 'deliver');
    expect(deliver).toBeTruthy();
    expect(deliver?.page).toBe('validation');
    expect(deliver?.tab).toBe('verify');
    const archive = GUIDED_FLOW.find((step) => step.id === 'archive');
    expect(archive).toBeTruthy();
    expect(archive?.page).toBe('versions');
    // 交付必须排在验证之后、追溯之前
    const ids = GUIDED_FLOW.map((step) => step.id);
    expect(ids.indexOf('deliver')).toBeGreaterThan(ids.indexOf('verify'));
    expect(ids.indexOf('archive')).toBeGreaterThan(ids.indexOf('deliver'));
  });
});
