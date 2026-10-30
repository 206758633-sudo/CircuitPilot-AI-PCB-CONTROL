import { expect, test, type Page } from '@playwright/test';

/**
 * 真机 UI 验收：原理图 → PCB 同步验收卡片。
 * 真机现况（第 20–27 轮）：原理图有 12 个要上板的器件、PCB 只有 8 个；
 * 嘉立创EDA 公开 API 不能新增 PCB 器件，所以这一步只做"如实判定 + 给指引"，
 * 并且**必须**把自动布局锁住，绝不能显示成通过。
 */
test.describe.configure({ timeout: 240_000 });

test.describe('真机：原理图 → PCB 同步验收（只读判定）', () => {
  test.skip(process.env.CP_LIVE_EDA_E2E !== '1', '需要真机：CP_LIVE_EDA_E2E=1（EDA + 桥 + Runtime:4179）');

  // 真机教训：页面可能指向 4178（已安装 App 里的旧 Runtime）。必须把请求改写到 4179 的工作区 Runtime，
  // 否则会读到旧代码/旧会话令牌——上一条失败就是"Runtime会话令牌无效"，属于最危险的假绿。
  test.beforeEach(async ({ page }) => {
    await page.route('http://127.0.0.1:4178/api/**', (route) => route.continue({ url: route.request().url().replace(':4178', ':4179') }));
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
  });

  test('验证与交付：回读验收如实报缺件，并锁定自动布局', async ({ page }: { page: Page }) => {
    await page.getByTestId('nav-validation').click();
    await expect(page.locator('.page-head h1')).toHaveText('验证与交付');
    // 同步验收卡片在「检查与问题」子 tab（默认 tab）内。
    await expect(page.getByRole('tab', { name: /检查与问题/ })).toHaveAttribute('aria-selected', 'true');

    const panel = page.locator('.panel').filter({ hasText: 'PCB SYNC VERIFY' }).first();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('还没做验收');

    await panel.getByRole('button', { name: '回读验收' }).click();

    // 真机判定：未通过，并且点名缺哪些器件（R1..R4）
    await expect(panel).toContainText(/未通过：原理图要上板 \d+ 个，PCB 只有 \d+ 个/, { timeout: 90_000 });
    await expect(panel).toContainText('缺：');
    await expect(panel).toContainText('R1');
    // 差异没清零 → 自动布局必须明确锁定（不是静默置灰）
    await expect(panel).toContainText('已锁定');
  });
});
