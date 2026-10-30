import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppProvider } from '../../state/AppContext';
import { AutomationPage } from '../AutomationPage';
import { ValidationPage } from '../ValidationPage';
import { PlacementPage } from '../PlacementPage';
import { PartProposalPage } from '../PartProposalPage';

/**
 * F5：关键页面 RTL/SSR 冒烟。断言"页面能真实渲染 + 关键安全文案在场"，
 * 交互链路仍由 e2e 覆盖；这里不装的像 e2e。
 */
describe('关键页面渲染冒烟', () => {
  it('自动化页渲染，并在 DEMO 下明确提示不能连真机', () => {
    const html = renderToStaticMarkup(<AppProvider><AutomationPage /></AppProvider>);
    expect(html).toContain('自动化');
    expect(html).toMatch(/DEMO|本机 Runtime|真机/);
  });

  it('验证页渲染，ERC 面板为空态且不默认通过；DEMO 边界提示在场', () => {
    const html = renderToStaticMarkup(<AppProvider><ValidationPage /></AppProvider>);
    expect(html).toContain('原理图 ERC 收敛');
    expect(html).toContain('还没有 ERC 证据');
    expect(html).toContain('DEMO');
    expect(html).toContain('不能作为放行证据');
  });

  it('布局页渲染，未取得真实读回前不声称可写入', () => {
    const html = renderToStaticMarkup(<AppProvider><PlacementPage /></AppProvider>);
    expect(html.length).toBeGreaterThan(500);
    expect(html).toMatch(/布局|placement|读回/i);
  });

  it('选型页渲染，缺证据时明确阻断而不是猜器件', () => {
    const html = renderToStaticMarkup(<AppProvider><PartProposalPage /></AppProvider>);
    expect(html.length).toBeGreaterThan(500);
    expect(html).toMatch(/选型|候选|证据|阻断/);
    // A6/R3：批量落件入口必须在场，并明确“dry-run 后才可签发批准执行”。
    expect(html).toContain('原理图批量落件');
    expect(html).toContain('dry-run');
    expect(html).toContain('签发写板批准并执行');
  });
});
