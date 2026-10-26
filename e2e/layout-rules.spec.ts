import { test, expect } from '@playwright/test';

/**
 * 规则中心（#validation/rules）端到端：直连真实本机 Runtime（4178），不 mock。
 *
 * 断言的是"人能看到且能据此决策"的东西：
 *   1. 128 条规则包真的加载出来（不是空壳页面）；
 *   2. 缺陷样板审计 → 显示存在阻断项、GATE-01 不通过、明细表里能看到具体规则；
 *   3. 整改骨架审计 → 7 道门禁通过、可放行；
 *   4. 状态筛选与搜索能收敛列表（FAIL/REVIEW 分开看是评审的日常动作）。
 */
const RUNTIME_HEALTH_URL = 'http://127.0.0.1:4178/api/health';
const DEFAULT_APP_ORIGIN = 'http://127.0.0.1:4177';

test.describe('规则中心', () => {
  // 规则包与审计结果都由本机 Runtime 提供（本用例明确不 mock）。但「Runtime 在跑」不等于「网页能用」：
  // 桌面版/Tauri 壳层会给 Runtime 注入令牌且不再向 HTTP 来源发放会话凭据，此时 HTTP 页面连不上它。
  // 所以这里探测的是「开发模式 Runtime（对受信 Origin 发放 sessionProof）」，不满足就跳过，
  // 而不是把环境差异误报成产品缺陷。需要真实回归时：`npm run dev:full` 后跑本文件。
  let runtimeUsableFromPage = false;
  test.beforeAll(async ({ request, baseURL }) => {
    try {
      const response = await request.get(RUNTIME_HEALTH_URL, {
        headers: { Origin: baseURL || DEFAULT_APP_ORIGIN },
        timeout: 2_000,
      });
      const body = response.ok() ? await response.json() as { sessionProof?: unknown } : null;
      runtimeUsableFromPage = Boolean(body?.sessionProof);
    } catch {
      runtimeUsableFromPage = false;
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!runtimeUsableFromPage, '需要开发模式的本机 Runtime（npm run dev:full）：桌面版注入令牌的实例不向 HTTP 页面发会话凭据');
    await page.goto('/#validation/rules');
    await expect(page.locator('.page-head h1')).toHaveText('验证与交付');
    await expect(page.getByRole('heading', { name: '规则中心' })).toBeVisible();
  });

  test('加载规则包并展示 128 条规则元信息', async ({ page }) => {
    await expect(page.getByText('规则总数')).toBeVisible();
    await expect(page.locator('.stat', { hasText: '规则总数' })).toContainText('128');
    await expect(page.locator('.stat', { hasText: '硬门禁' })).toContainText('110');
    await expect(page.locator('.stat', { hasText: '推荐项' })).toContainText('18');
    // 规则出处与哈希必须出现在界面上，否则审计结论不可追溯
    await expect(page.getByText(/规则包 SHA-256/)).toBeVisible();
    await expect(page.getByText(/REVIEW 不是 PASS/)).toBeVisible();
  });

  test('审计缺陷样板：给出阻断项、门禁不通过与可执行明细', async ({ page }) => {
    await page.getByRole('button', { name: '审计缺陷样板' }).click();
    await expect(page.locator('.badge', { hasText: '存在阻断项' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.badge', { hasText: '门禁可放行' })).toHaveCount(0);

    // 结论区：阻断数 > 0，GATE-01 判不通过
    await expect(page.locator('.stat', { hasText: '不通过' })).toBeVisible();
    await expect(page.locator('.finding-detail', { hasText: 'GATE-01' })).toContainText('不通过');
    await expect(page.locator('.finding-detail', { hasText: 'GATE-07' })).toContainText('不通过');

    // 明细表：默认按 FAIL 过滤，应能看到 courtyard 相交这类硬门禁
    const rulesTable = page.getByRole('region', { name: '规则判定明细' });
    await expect(rulesTable).toContainText('courtyard 相交');
    await expect(rulesTable).toContainText('SPACE-02');

    // 切到待复核：必须说明"缺证据"，且不能显示为通过
    await page.getByRole('tab', { name: /待复核/ }).click();
    await expect(rulesTable).toContainText(/未提供|需|缺少|需要/);
    // 待复核列表里绝不能出现"通过"徽章（规则正文里出现"通过"字样不算）
    await expect(rulesTable.locator('.badge').filter({ hasText: /^通过$/ })).toHaveCount(0);
  });

  test('审计整改骨架：7 道门禁通过且可放行', async ({ page }) => {
    await page.getByRole('button', { name: '审计整改骨架' }).click();
    await expect(page.locator('.badge', { hasText: '门禁可放行' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.stat', { hasText: '不通过' })).toContainText('0');
    for (const gate of ['GATE-01', 'GATE-02', 'GATE-03', 'GATE-04', 'GATE-05', 'GATE-06', 'GATE-07']) {
      await expect(page.locator('.finding-detail', { hasText: gate })).toContainText('通过');
    }
    await expect(page.getByText(/7 道门禁全部通过/)).toBeVisible();
  });
});
