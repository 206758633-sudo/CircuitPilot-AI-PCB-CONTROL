import { test, expect, type Page } from '@playwright/test';

/**
 * 真机 UI 验证：真实浏览器 → 真实工作区 Runtime → 真实嘉立创EDA。
 *
 * 默认 **skip**：这条用例需要本机同时具备嘉立创EDA(专业版)、EasyEDA 桥和跑在 4179 的工作区 Runtime。
 * CI 里没有这些，硬跑只会得到"假失败"；而把断言放宽到离线也能过，就变成"假绿色"。
 * 所以显式开关 + 真机断言：
 *
 *   1) 起工作区 Runtime：`CIRCUITPILOT_RUNTIME_PORT=4179 node runtime/server.mjs`
 *   2) 跑：
 *      CP_LIVE_EDA_E2E=1 VITE_RUNTIME_URL=http://127.0.0.1:4179 npx playwright test e2e/placement-live.spec.ts
 */
const LIVE = Boolean(process.env.CP_LIVE_EDA_E2E);

test.describe('真机：布局微调与下单前闸门（需要 EDA + 桥 + Runtime:4179）', () => {
  test.skip(!LIVE, '需要真机环境；设 CP_LIVE_EDA_E2E=1 开启（见本文件顶部说明）');
  // 这些用例的断言预算本来就写到了 90~150 秒（真机 DRC/门禁/在线库检索都慢），
  // 但 Playwright 默认每个用例只给 45 秒——断言等 150 秒、用例 45 秒就死，属于"配置和断言打架"。
  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async ({ page }) => {
    // 页面可能被打包成指向 4178（已安装 App 里的旧 Runtime）。把请求改写到 4179 的工作区 Runtime，
    // 否则这条"真机验证"会悄悄测到旧代码——那是最危险的假绿。
    await page.route('http://127.0.0.1:4178/api/**', (route) => route.continue({ url: route.request().url().replace(':4178', ':4179') }));
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
  });

  test('布局微调：真读板框 → 真算方案 → 预演不写盘 → 取消不写盘', async ({ page }: { page: Page }) => {
    // 布局微调不再是独立主导航，而是「验证与交付」页里的子 tab。
    await page.getByTestId('nav-validation').click();
    await expect(page.locator('.page-head h1')).toHaveText('验证与交付');
    await page.getByRole('tab', { name: '布局微调' }).click();
    await expect(page).toHaveURL(/#validation\/placement$/);
    await expect(page.getByRole('tab', { name: '布局微调' })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('button', { name: '读取板框并自动布局' }).click();

    // 真机板子上是 8 个器件（U1/U2/U3/U4/U5/U6/D1/J1），读不到就不该显示数字
    await expect(page.locator('table tbody tr')).toHaveCount(8, { timeout: 90_000 });
    await expect(page.locator('table tbody')).toContainText('U1');
    await expect(page.locator('table tbody')).toContainText('J1');
    const firstStat = page.locator('.stats-grid .stat').first();
    await expect(firstStat).toContainText('器件');
    await expect(firstStat).toContainText('8');

    // 复核必须有结论（现状 or 方案），不能整块空着
    await expect(page.locator('.finding-list, .empty-inline').first()).toBeVisible();

    // 预演：必须明确"没有写入 EDA"，且写回结果面板标注"预演"
    await page.getByRole('button', { name: '预演写回' }).click();
    await expect(page.locator('.evidence-strip')).toContainText('预演（未写 EDA）', { timeout: 90_000 });
    const writebackPanel = page.locator('.panel').filter({ hasText: '写回结果' }).first();
    await expect(writebackPanel).toContainText('未保存');

    // 执行写回的确认弹窗必须说清"不会自动保存"；取消之后仍然停留在预演状态（真没写盘）
    await page.getByRole('button', { name: '执行写回' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('不会自动保存');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(page.locator('.evidence-strip')).toContainText('预演（未写 EDA）');
  });

  test('验证与交付：下单前闸门真跑；缺 DRC 报告必须阻断而不是放行', async ({ page }: { page: Page }) => {
    await page.getByTestId('nav-validation').click();
    await expect(page.locator('.page-head h1')).toHaveText('验证与交付');
    // 闸门在「检查与问题」子 tab（默认 tab）内。
    await expect(page.getByRole('tab', { name: /检查与问题/ })).toHaveAttribute('aria-selected', 'true');

    const gatePanel = page.locator('.panel').filter({ hasText: '下单前闸门（真实证据）' }).first();
    await expect(gatePanel).toBeVisible();
    await expect(gatePanel).toContainText('尚未运行');

    await gatePanel.getByRole('button', { name: '运行下单前闸门' }).click();

    // 默认 DRC 报告路径填的是工程交付目录里的真实报告；无论如何裁决必须给出来
    await expect(gatePanel.locator('.stats-grid')).toContainText(/不能下单|可下单/, { timeout: 150_000 });
    // 六道闸门：原理图 / 仿真 / DRC / 布局 / 产物 / 供应链
    await expect(gatePanel.locator('tbody tr')).toHaveCount(6, { timeout: 30_000 });
    // 必须给出可定位的阻断码，而不是一句"失败"
    await expect(gatePanel.locator('.finding-detail code').first()).toContainText('RELEASE_');
    // 产出裁决必须一起显示：本板没过门禁，所以正式生产文件必须被明确拒绝（只能出草稿）
    await expect(gatePanel).toContainText('正式生产文件已被拒绝');
    await expect(gatePanel).toContainText('DRAFT-NOT-FOR-ORDER');
    // 门禁焊在按钮上：正式导出禁用且写明原因（原因必须来自运行时的裁决，含真实阻断码）；草稿导出可用
    const formalExport = gatePanel.getByRole('button', { name: '导出正式生产文件' });
    const draftExport = gatePanel.getByRole('button', { name: '导出草稿文件（不得下单）' });
    await expect(formalExport).toBeDisabled();
    await expect(draftExport).toBeEnabled();
    const reason = await formalExport.getAttribute('title');
    expect(reason).toBeTruthy();
    expect(reason).toContain('门禁未通过');
    expect(reason).toMatch(/RELEASE_[A-Z_]+/);

    // 板厂下单参数卡：真机实测值必须自己出现在卡上（尺寸由板框实算、层数由 EDA 读回），
    // 而且必须承认"还不能下单"（草稿文件 + 63 条必须修 DRC），价格没有来源就要写未知。
    await gatePanel.getByLabel('PCB UUID').fill('10886966233af924');
    const orderPanel = page.locator('.panel').filter({ hasText: '板厂下单参数卡' }).first();
    await expect(orderPanel).toBeVisible();
    await expect(orderPanel).toContainText('尚未生成');
    await orderPanel.getByRole('button', { name: '生成下单参数卡' }).click();
    await expect(orderPanel.locator('.stats-grid')).toContainText('60×40 mm', { timeout: 90_000 });
    await expect(orderPanel.locator('.stats-grid')).toContainText('6');
    await expect(orderPanel).toContainText('还不能下单');
    await expect(orderPanel).toContainText('ORDER_FILE_IS_DRAFT');
    await expect(orderPanel).toContainText('ORDER_MUST_FIX_OPEN');
    await expect(orderPanel).toContainText('草稿·不得下单');
    await expect(orderPanel).toContainText('本系统不猜价格');
    // 假设必须显式摆出来，不能藏在默认值里
    await expect(orderPanel).toContainText('板厂官网');
  });

  test('验证与交付：自动修复原理图能识别"已经修好"，幂等执行不写盘并重跑验收', async ({ page }: { page: Page }) => {
    await page.getByTestId('nav-validation').click();
    await expect(page.locator('.page-head h1')).toHaveText('验证与交付');
    await expect(page.getByRole('tab', { name: /检查与问题/ })).toHaveAttribute('aria-selected', 'true');

    const repairPanel = page.locator('.panel').filter({ hasText: '自动修复原理图' }).first();
    await expect(repairPanel).toBeVisible();
    await expect(repairPanel).toContainText('预演不写盘');
    await expect(repairPanel).toContainText('先点“预演修复计划”看清要动什么');

    // 执行按钮必须写明"会真的改原理图"，不能是个无说明的红色按钮
    const applyButton = repairPanel.getByRole('button', { name: '执行修复并验收' });
    const applyTitle = await applyButton.getAttribute('title');
    expect(applyTitle).toContain('受控写入');

    // 预演：只读，且必须认出这块板**已经**有合格器件（R1/R2 5.1kΩ、R3/R4 4.7kΩ）
    await repairPanel.getByLabel('原理图页面 UUID（与下单前闸门共用）').fill('d0787ce602b31e26');
    await repairPanel.getByRole('button', { name: '预演修复计划' }).click();
    await expect(repairPanel).toContainText('不需要新增任何元件', { timeout: 120_000 });
    await expect(repairPanel.locator('.stats-grid')).toContainText('已满足（不重复加）');
    // 面板里有多张表（幂等判定 / 网表复核 / 验收数值），按表头文字定位，不用"第几张"去赌
    const satisfiedTable = repairPanel.locator('table').filter({ hasText: '已有器件' });
    await expect(satisfiedTable.locator('tbody')).toContainText('R1');
    await expect(satisfiedTable.locator('tbody')).toContainText('5.1kΩ');
    await expect(satisfiedTable.locator('tbody')).toContainText('R3');
    await expect(satisfiedTable.locator('tbody')).toContainText('4.7kΩ');

    // 幂等执行：必须明确"一个字节都没有写入"，并且重跑验收给出实测电压
    await applyButton.click();
    await expect(repairPanel).toContainText('一个字节都没有写入', { timeout: 150_000 });
    const checksTable = repairPanel.locator('table').filter({ hasText: '设计检查点' });
    await expect(checksTable.locator('tbody')).toContainText('0.4173');
    await expect(checksTable.locator('tbody')).toContainText('3.2984');
    await expect(repairPanel.locator('.stats-grid')).toContainText('通过');
  });
});
