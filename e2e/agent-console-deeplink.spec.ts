import { test, expect } from '@playwright/test';

/**
 * 真机 Agent 接入面板验收（需要本机 Runtime 提供 /api/agent/* 路由）。
 * 使用 Vite 开发服务器 + 真实 Runtime 时运行：
 *   npx playwright test e2e/agent-console-deeplink.spec.ts
 * 该用例只读取：状态、审计、批准账本、已签发待执行批准，不轮换令牌、不执行写操作。
 */
test('Agent 接入面板：真实 Runtime 状态/审计/待执行批准 + deep link 定位', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?agent=approvals#settings');
  await expect(page.getByRole('heading', { name: /Agent 接入/ })).toBeVisible();
  await expect(page.locator('#agent-access')).toBeAttached();
  await expect(page.locator('#agent-approvals')).toBeAttached();
  await expect(page.locator('#agent-ledger')).toBeAttached();

  // 真实 Runtime：令牌可用、审计链完整且锚点可见。
  const access = page.locator('#agent-access');
  await expect(access).toContainText('Agent 令牌');
  await expect(access).toContainText('审计链完整');
  await expect(access).toContainText('已锚定');
  await expect(access).toContainText('最近 Agent 调用');

  // 待执行批准区：即使为空也要有明确空态；账本区可见。
  await expect(page.locator('#agent-approvals')).toContainText('待执行批准');
  await expect(page.locator('#agent-approvals')).toContainText('暂无待执行批准');
  await expect(page.locator('#agent-ledger')).toBeVisible();

  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/cpa_[0-9a-f]{48}/);
  expect(body).not.toMatch(/agent-audit\.key/);
  expect(errors).toEqual([]);

  await page.screenshot({ path: 'artifacts/agent-console-real.png', fullPage: true });
});
